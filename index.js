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
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { summarizeContextUsage } from './context-status.js'
import { selectCompactableRange } from './select-range.js'
import { completedCount, DEFAULT_SAFE_POINT_RATIO, finishedStep, overSafePointRatio } from './safe-point.js'
import { corePolicy, headroomCappedTrigger } from './headroom.js'
import { DEFAULT_SUMMARY_MAX_TOKENS, tunedConfig } from './engine-tune.js'
import { MASK_DEFAULTS, maskResults, staleToolResults } from './mask.js'
import { recallToolOutput } from './recall.js'

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
async function compactAgent(ctx, compaction, agent, signal, notice) {
  const session = agent.session
  const range = selectCompactableRange(session, toolPairingBalancedBefore, retainFor(ctx, compaction, session))
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

/**
 * The compaction service `agent` runs with. Simple profiles mount it on the
 * host plane next to this plugin; dsh-web-app presets mount a private one
 * inside an isolated group, reachable only through the preset registry.
 */
function compactionFor(ctx, agent) {
  return ctx.get('compaction') ?? ctx.get('agentPresets')?.serviceFor(agent, 'compaction')
}

/**
 * Verbatim tail to keep when compacting: the engine's own `retainRatio` (core
 * default 0.16) of the window, priced by the token meter, like core's own
 * selection. Empty (= keep only the last node) when anything is unknown.
 */
function retainFor(ctx, compaction, session) {
  try {
    const meter = ctx.get('tokenMeter')
    const window = ctx.get('sessionProjections')?.stateOf(session, 'contextPressure')?.contextWindow
    if (!meter || !window) return {}
    const ratio = typeof compaction?.config?.retainRatio === 'number' ? compaction.config.retainRatio : 0.16
    const retainTokens = typeof compaction?.config?.retainTokens === 'number'
      ? compaction.config.retainTokens
      : Math.floor(window * ratio)
    return { nodes: meter.measure(session).nodes, retainTokens }
  } catch {
    return {}
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
 * @param {{
 *   safePointRatio?: number | false,
 *   summaryMaxTokens?: number | false,
 *   mask?: false | Partial<typeof MASK_DEFAULTS>,
 * }} [config]
 *   - `safePointRatio`: usage fraction (0-1) at which finishing a todo item
 *     compacts automatically; `false` turns it off. Default 0.6.
 *   - `summaryMaxTokens`: headroom and summary cap forced onto the live
 *     compaction-basic engine; `false` leaves the engine alone. Default 16384.
 *   - `mask`: batched masking of stale tool output; `false` turns it off.
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
      if (!exec.agent) {
        throw new Error('compact_now requires an owning agent session')
      }
      const compaction = compactionFor(ctx, exec.agent)
      if (!compaction) {
        throw new Error('compact_now: no compaction service is configured for this agent')
      }
      try {
        return await compactAgent(ctx, compaction, exec.agent, exec.signal, STARTED_NOTICE_TEXT)
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

  ctx.tools.register(defineTool({
    name: 'recall_output',
    description: RECALL_DESCRIPTION,
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The number from the hidden-output marker, e.g. "1234".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          seq: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('recall_output requires an owning agent session')
      return recallToolOutput(exec.agent.session, args.id)
    },
  }))

  const safeRatio = config.safePointRatio ?? DEFAULT_SAFE_POINT_RATIO
  if (safeRatio !== false && (typeof safeRatio !== 'number' || !(safeRatio > 0 && safeRatio < 1))) {
    throw new Error(`smart-compaction: safePointRatio must be a number between 0 and 1, or false (got ${safeRatio})`)
  }
  const summaryMaxTokens = config.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS
  if (summaryMaxTokens !== false && !(Number.isInteger(summaryMaxTokens) && summaryMaxTokens > 0)) {
    throw new Error(`smart-compaction: summaryMaxTokens must be a positive integer, or false (got ${summaryMaxTokens})`)
  }
  const mask = config.mask === false ? false : { ...MASK_DEFAULTS, ...(config.mask ?? {}) }
  const warn = msg => (ctx.logger?.warn ?? console.warn).call(ctx.logger ?? console, msg)
  const info = msg => (ctx.logger?.info ?? console.log).call(ctx.logger ?? console, msg)

  // --- 1. engine tune (see engine-tune.js) --------------------------------
  // compaction-basic's 65,536-token headroom pulls its trigger down to ~33-45%
  // on 128k-class local models. Shrink it (and the summary cap) on the live
  // preset engine before its own pre-step check runs.
  function tuneEngine(compaction) {
    if (summaryMaxTokens === false || !compaction) return
    const next = tunedConfig(compaction.config, summaryMaxTokens)
    if (next === undefined) return
    compaction.config = next
    info(`smart-compaction: compaction headroom and summary cap set to ${summaryMaxTokens} tokens`)
  }

  // --- 2. diagnosis (see headroom.js): only fires when the tune is off ----
  const warnedHeadroom = new WeakMap()
  function diagnose(compaction, agent, contextWindow) {
    const seen = warnedHeadroom.get(compaction) ?? new Set()
    if (seen.has(contextWindow)) return
    seen.add(contextWindow)
    warnedHeadroom.set(compaction, seen)
    const policy = corePolicy(compaction.config, agent.session.requestHeader?.()?.config)
    const capped = policy && headroomCappedTrigger(contextWindow, policy)
    if (!capped) return
    warn(`smart-compaction: compaction-basic will auto-compact at <=${capped.triggerPercent}% `
      + `(~${capped.triggerTokens} tokens) of this model's ${contextWindow}-token window, not `
      + `${policy.thresholdRatio * 100}%: its headroomTokens (${policy.headroomTokens}) is sized for `
      + `large hosted windows. Set headroomTokens: ${capped.suggestedHeadroom} on the preset's `
      + 'compaction-basic row, or leave smart-compaction\'s summaryMaxTokens on.')
  }

  // --- 3. batched masking of stale tool output (see mask.js) -------------
  /**
   * Mask stale tool output. With `force`, mask whatever is stale; otherwise
   * only once it adds up to `batchRatio` of the window, so the prompt cache
   * is invalidated rarely.
   */
  function maskStale(agent, contextWindow, force) {
    if (mask === false) return { masked: 0, tokensSaved: 0 }
    const meter = ctx.get('tokenMeter')
    if (typeof meter?.estimateMessage !== 'function') return { masked: 0, tokensSaved: 0 }
    const session = agent.session
    const candidates = staleToolResults(session, mask)
    if (candidates.length === 0) return { masked: 0, tokensSaved: 0 }
    if (!force) {
      const staleTokens = candidates.reduce((sum, c) => sum + meter.estimateMessage(c.message), 0)
      const batch = contextWindow ? contextWindow * mask.batchRatio : 8192
      if (staleTokens < batch) return { masked: 0, tokensSaved: 0 }
    }
    const result = maskResults(session, candidates, {
      previewChars: mask.previewChars,
      estimate: m => meter.estimateMessage(m),
      freeze: freezeMessage,
    })
    if (result.masked > 0) {
      info(`smart-compaction: hid ${result.masked} old tool outputs (~${result.tokensSaved} tokens); recall_output brings them back`)
    }
    return result
  }

  // --- 4. safe-point compaction (see safe-point.js) ----------------------
  // A todo item flipping to completed marks a clean boundary. Past
  // `safePointRatio`, mask stale output first; summarize only if that was
  // not enough. Core's own trigger stays the backstop.
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

  // `prepend`: everything here must land before compaction-basic's own
  // pre-step pressure check, so that check sees the tuned config and the
  // masked history (same ordering trick as dsh-compaction-policy).
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!agent || signal?.aborted) return next()
    let compaction
    let contextWindow
    try {
      compaction = compactionFor(ctx, agent)
      tuneEngine(compaction)
      contextWindow = ctx.get('sessionProjections')?.stateOf(agent.session, 'contextPressure')?.contextWindow
      if (compaction && contextWindow) diagnose(compaction, agent, contextWindow)
      maskStale(agent, contextWindow, false)
    } catch (error) {
      warn(`smart-compaction: pre-step housekeeping failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (safeRatio === false || !atSafePoint.has(agent)) return next()
    atSafePoint.delete(agent)
    if (!compaction) return next()
    try {
      if (!overSafePointRatio(usageOf(ctx, agent.session), safeRatio)) return next()
      maskStale(agent, contextWindow, true)
      const usage = usageOf(ctx, agent.session)
      if (!overSafePointRatio(usage, safeRatio)) return next()
      await compactAgent(ctx, compaction, agent, signal,
        `⏳ Step finished with ${usage.percentUsed}% of the context used — compacting now, `
        + 'before the next step. This runs one extra model call and can take a while on a local model.')
    } catch (error) {
      // Never break the turn: core's own pressure trigger is still the backstop.
      warn(`smart-compaction: safe-point compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  }, { prepend: true })
}

const RECALL_DESCRIPTION =
  'Get back the full original text of an older tool output that was hidden to save context. '
  + 'Hidden outputs show a short preview and a marker with an id; pass that id. Only call this '
  + 'when you actually need the hidden detail again — re-running a cheap command or re-reading '
  + 'a small file region is often better than restoring a huge output.'

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
