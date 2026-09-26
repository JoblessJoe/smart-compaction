/**
 * dsh plugin: registers a `compact_now` tool on `ctx.tools` so the model can
 * voluntarily trigger compaction at a point it judges safe, instead of only
 * ever being interrupted by dsh's automatic token-threshold trigger. Also
 * registers `context_status`, so the model can check real, current token
 * usage against its actual context window on demand instead of guessing
 * whether "the conversation feels long" — see context-status.js.
 *
 * Calls `ctx.compaction.compactRegion()` directly — NOT `compactNow()` (what
 * the human `/compact` command uses). `compactRegion` doesn't require an
 * idle agent, which matters because a tool's `execute()` always runs during
 * an open turn; `compactNow()` would throw `busy` on every real call here.
 * See HANDOFF.md for the full research trail.
 *
 * @module dsh-compact-now
 */

import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { summarizeContextUsage } from './context-status.js'
import { selectCompactableRange } from './select-range.js'

export const name = 'tool-compact-now'
// `compaction` deliberately NOT in `inject`: that would make this plugin's
// boot depend on the service existing, and not every profile bundle ships a
// compaction backend (e.g. dsh-web-app doesn't) — a hard inject broke boot
// on any profile that lacks one. Looked up via `ctx.get()` at call time
// instead, same as core's own optional-sibling-service pattern
// (compaction-basic's own `toolResultPruner` lookup).
export const inject = ['tools']

const DESCRIPTION =
  'Voluntarily compact older conversation history now, at a point you know is safe: '
  + 'right after finishing a concrete step (e.g. just marked a todo item completed), '
  + 'never mid-edit or with unfinished work pending. Use this instead of waiting to be '
  + 'interrupted by automatic compaction. Call context_status first if unsure whether now '
  + 'is a good time — usage past roughly 70-90% of the context window is a concrete signal '
  + 'to call this proactively, not just a vague feeling that the conversation has gotten '
  + 'long. As a habit: check context_status after every completed step, and call this '
  + 'whenever that check comes back high. Harmless to call speculatively either way — it '
  + 'no-ops if there is not enough history to compact yet.'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'compact_now',
    description: DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compacted: { type: 'boolean', required: true },
          shadowedCount: { type: 'integer' },
          shadowedTokenCount: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.compacted
          ? `Compacted ${value.shadowedCount} history items (~${value.shadowedTokenCount} tokens).`
          : 'Not enough compactable history yet.',
      }],
    },
    async execute(_args, exec) {
      const compaction = ctx.get('compaction')
      if (!compaction) {
        throw new Error('compact_now: no compaction service is configured on this profile')
      }
      if (!exec.agent) {
        throw new Error('compact_now requires an owning agent session')
      }
      const session = exec.agent.session
      const range = selectCompactableRange(session, toolPairingBalancedBefore)
      if (range === null) {
        return { compacted: false }
      }
      let result
      try {
        result = await compaction.compactRegion(range.start, range.end, exec.agent, exec.signal)
      } catch (error) {
        // The four errors compactRegion's own range validation can throw all
        // indicate this file's range-selection logic disagrees with core's —
        // a bug here, not an expected runtime outcome. Surface it plainly.
        throw new Error(`compact_now: compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        compacted: true,
        shadowedCount: result.shadowedSeqs.length,
        shadowedTokenCount: result.shadowedTokenCount,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'context_status',
    description: CONTEXT_STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          contextWindow: { type: 'integer' },
          usedTokens: { type: 'integer' },
          percentUsed: { type: 'number' },
          estimated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderContextStatus(value) }],
    },
    async execute(_args, exec) {
      if (!exec.agent) {
        throw new Error('context_status requires an owning agent session')
      }
      const projections = ctx.get('sessionProjections')
      if (!projections) return { available: false }
      const state = projections.stateOf(exec.agent.session, 'contextPressure')
      return summarizeContextUsage(state)
    },
  }))
}

const CONTEXT_STATUS_DESCRIPTION =
  'Check real, current context-window usage for this session: tokens used so far and the '
  + 'model\'s actual context-window size, whatever model this session happens to be running. '
  + 'Call this right after finishing any self-contained step — e.g. right after todo_write '
  + 'marks an item completed, never mid-edit or with unfinished work pending — instead of '
  + 'guessing whether the conversation "feels long." Automatic compaction generally triggers '
  + 'well before the window fills, typically somewhere around 70-90% depending on profile '
  + 'config, so if percentUsed comes back past that range, follow up by calling compact_now '
  + 'proactively rather than wait to be interrupted. Harmless to call anytime — read-only, '
  + 'never modifies the session.'

function renderContextStatus(value) {
  if (!value.available) {
    return 'Context usage isn\'t available on this profile (no token-meter service mounted).'
  }
  if (value.contextWindow === undefined) {
    return `~${value.usedTokens} tokens used so far this session; context-window size isn't `
      + 'known yet (no model request has completed yet).'
  }
  const note = value.estimated ? ' (estimated — no confirmed usage sample yet)' : ''
  return `~${value.usedTokens.toLocaleString()} / ${value.contextWindow.toLocaleString()} tokens `
    + `used (${value.percentUsed}%)${note}.`
}
