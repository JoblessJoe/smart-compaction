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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { summarizeContextUsage } from './context-status.js'
import { selectCompactableRange } from './select-range.js'
import { completedCount, DEFAULT_SAFE_POINT_RATIO, finishedStep, overSafePointRatio } from './safe-point.js'

// dsh 0.2 (session format v4) rejects the old generic `kind: 'plugin'` wrapper:
// every producer stamps its own kind, like repeat-tool-reminder does.
const PLUGIN_SOURCE = { kind: 'smart-compaction' }
const STARTED_NOTICE_TEXT =
  '⏳ Compacting now — summarizing older history. This runs one extra model '
  + 'call and can take a while on a local model; the chat will look idle '
  + 'until it lands.'

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
  + 'interrupted by automatic compaction. Do not decide this only by checking whether usage '
  + 'is already past a fixed percentage — that is still reactive, and a step that turns out '
  + 'bigger than expected can blow past a comfortable-looking number mid-step. Before '
  + 'starting the next step, weigh how much room is left against what that step will '
  + 'actually cost (a big file read, a long diff, a subagent dispatch); if it is not clearly '
  + 'going to fit with room to spare, call this now even while usage still looks moderate. '
  + 'Compacting a little early costs nothing; running out mid-step loses exactly the context '
  + 'that step needed. Call context_status first if unsure how much room is actually left. '
  + 'Harmless to call speculatively either way — it no-ops if there is not enough history to '
  + 'compact yet.'

/**
 * Compact the largest safe span of `agent`'s history. Shared by the
 * `compact_now` tool and the automatic safe-point trigger.
 * @returns {Promise<{ compacted: false } | { compacted: true, shadowedCount: number, shadowedTokenCount: number }>}
 */
async function compactAgent(compaction, agent, signal, notice) {
  const session = agent.session
  const range = selectCompactableRange(session, toolPairingBalancedBefore)
  if (range === null) return { compacted: false }
  // Posted before the slow part (the summarization model call inside
  // compactRegion, which can run minutes on a local model), not after:
  // without this, the chat shows nothing until it lands and looks stuck.
  // `session.append` publishes synchronously to live observers.
  // An own `kind` + `form: 'notice'` is the same tagging
  // dsh-compaction-basic and repeat-tool-reminder use for host-generated
  // asides — collapsed by default, never rendered as if the user typed it.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: notice }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'Compacting now' },
  }), { surfaceOp: 'append' })
  const result = await compaction.compactRegion(range.start, range.end, agent, signal)
  return {
    compacted: true,
    shadowedCount: result.shadowedSeqs.length,
    shadowedTokenCount: result.shadowedTokenCount,
  }
}

/** Current usage for `session`, via token-meter's contextPressure projection. */
function usageOf(ctx, session) {
  const projections = ctx.get('sessionProjections')
  if (!projections) return { available: false }
  return summarizeContextUsage(projections.stateOf(session, 'contextPressure'))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ safePointRatio?: number | false }} [config] - `safePointRatio`:
 *   usage fraction (0-1) at which finishing a todo item compacts
 *   automatically; `false` turns the automatic trigger off. Default 0.5.
 */
export function apply(ctx, config = {}) {
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
      try {
        return await compactAgent(compaction, exec.agent, exec.signal, STARTED_NOTICE_TEXT)
      } catch (error) {
        throw new Error(`compact_now: compaction failed: ${error instanceof Error ? error.message : String(error)}`)
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

  // --- automatic safe-point compaction (see safe-point.js) ---------------
  // Local models rarely call compact_now on their own, so the plugin also
  // compacts by itself: a todo item flipping to completed marks a safe
  // boundary, and the next step starts on compacted history if usage is past
  // `safePointRatio`. Core's own 80% trigger stays as the backstop.
  const ratio = config.safePointRatio ?? DEFAULT_SAFE_POINT_RATIO
  if (ratio === false) return
  if (typeof ratio !== 'number' || !(ratio > 0 && ratio < 1)) {
    throw new Error(`smart-compaction: safePointRatio must be a number between 0 and 1, or false (got ${ratio})`)
  }
  const lastCompleted = new WeakMap()
  const atSafePoint = new WeakSet()

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.agent && exec.name === 'todo_write') {
      const done = completedCount(exec.arguments)
      if (finishedStep(lastCompleted.get(exec.agent), done)) atSafePoint.add(exec.agent)
      lastCompleted.set(exec.agent, done)
    }
    return next()
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!atSafePoint.has(agent) || signal.aborted) return next()
    atSafePoint.delete(agent)
    // Not mounted next to a compaction service (e.g. the host-plane copy on a
    // preset-isolated profile): the in-realm copy handles it.
    const compaction = ctx.get('compaction')
    if (!compaction) return next()
    const usage = usageOf(ctx, agent.session)
    if (!overSafePointRatio(usage, ratio)) return next()
    try {
      await compactAgent(compaction, agent, signal,
        `⏳ Step finished with ${usage.percentUsed}% of the context used — compacting now, `
        + 'before the next step. This runs one extra model call and can take a while on a local model.')
    } catch (error) {
      // Never break the turn: core's own pressure trigger is still the backstop.
      console.warn(`smart-compaction: safe-point compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })
}

const CONTEXT_STATUS_DESCRIPTION =
  'Check real, current context-window usage for this session: tokens used so far and the '
  + 'model\'s actual context-window size, whatever model this session happens to be running. '
  + 'Call this right after finishing any self-contained step — e.g. right after todo_write '
  + 'marks an item completed, never mid-edit or with unfinished work pending — instead of '
  + 'guessing whether the conversation "feels long." Use the result to judge whether what is '
  + 'left is enough for the next step specifically (a big file read, a long diff, a subagent '
  + 'dispatch), not just whether percentUsed has crossed some fixed number — a step that '
  + 'turns out larger than expected can still blow past a comfortable-looking percentage. '
  + 'When in doubt, call compact_now before starting that next step rather than after it runs '
  + 'into trouble: as a hard backstop, treat anything past roughly 70-90% (depending on '
  + 'profile config) as reason enough on its own, but do not wait for that number if the next '
  + 'step alone looks likely to use it up. Harmless to call anytime — read-only, never '
  + 'modifies the session.'

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
