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
import { trimSession } from './trim.js'
import { completedCount, DEFAULT_HARD_RATIO, DEFAULT_TRIM_RATIO, DEFAULT_SAFE_POINT_RATIO, finishedStep, overSafePointRatio } from './safe-point.js'

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
  const range = selectCompactableRange(session, toolPairingBalancedBefore, budgetFor(ctx, agent))
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

// Share of the window kept verbatim after compacting (core's default is 0.16).
const RETAIN_RATIO = 0.15
// Room the summarization call needs on top of the replayed span: its own
// output cap plus the compaction instruction.
// ponytail: fixed guess, read compaction-basic's resolved maxTokens if it ever needs to be exact.
const SUMMARY_RESERVE_TOKENS = 8192

/**
 * Token budget for range selection, or `{}` (old take-everything behavior)
 * when no token meter / window is known. Without it the summary call replays
 * the whole history: at 90%+ usage that request overflows the window itself
 * (llama-server truncates -> "summarization truncated at the token cap").
 */
function budgetFor(ctx, agent) {
  const meter = meterFor(ctx, agent)
  const usage = usageOf(ctx, agent.session)
  if (!meter || usage.contextWindow === undefined) return {}
  const measurement = meter.measure(agent.session, agent.session.requestHeader())
  const prices = new Map(measurement.nodes.map(node => [node.seq, node.tokens]))
  // Tool schemas etc. are replayed too but are not surface nodes.
  const overhead = Math.max(0, measurement.totalTokens - measurement.surfaceTokens)
  return {
    tokensOf: seq => prices.get(seq) ?? 0,
    retainTokens: Math.floor(usage.contextWindow * RETAIN_RATIO),
    maxSpanTokens: usage.contextWindow - overhead - SUMMARY_RESERVE_TOKENS,
  }
}

// Trimming resets the provider's prompt cache from the first changed message,
// so only do it when it frees a real amount (~2k tokens).
const MIN_TRIM_CHARS = 8000

function meterFor(ctx, agent) {
  return ctx.get('tokenMeter') ?? ctx.get('agentPresets')?.serviceFor(agent, 'tokenMeter')
}

/** Current usage for `session`, via token-meter's contextPressure projection. */
function usageOf(ctx, session) {
  const projections = ctx.get('sessionProjections')
  if (!projections) return { available: false }
  return summarizeContextUsage(projections.stateOf(session, 'contextPressure'))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ safePointRatio?: number | false, hardRatio?: number | false }} [config] -
 *   `safePointRatio`: usage fraction (0-1) at which a safe point — a todo
 *   item just completed, or a new turn starting — compacts. Default 0.7: late,
 *   so small windows stay used.
 *   `hardRatio`: usage fraction at which ANY step boundary compacts (models
 *   often run 20+ steps with no safe point). Still between steps, never
 *   mid-generation. Must sit below core compaction-basic's thresholdRatio so
 *   this retained-tail compaction wins. Default 0.85. `false` turns either off.
 *   `trimRatio`: usage fraction from which safe points first stub stale tool
 *   content (see trim.js); also always tried before compacting. Default 0.5.
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

  // --- automatic safe-point compaction (see safe-point.js) ---------------
  // Local models rarely call compact_now on their own, so the plugin also
  // compacts by itself: a todo item flipping to completed marks a safe
  // boundary, and the next step starts on compacted history if usage is past
  // `safePointRatio`. Core's own 80% trigger stays as the backstop.
  const ratio = config.safePointRatio ?? DEFAULT_SAFE_POINT_RATIO
  const hardRatio = config.hardRatio ?? DEFAULT_HARD_RATIO
  const trimRatio = config.trimRatio ?? DEFAULT_TRIM_RATIO
  for (const [key, value] of [['safePointRatio', ratio], ['hardRatio', hardRatio], ['trimRatio', trimRatio]]) {
    if (value !== false && (typeof value !== 'number' || !(value > 0 && value < 1))) {
      throw new Error(`smart-compaction: ${key} must be a number between 0 and 1, or false (got ${value})`)
    }
  }
  if (ratio === false && hardRatio === false && trimRatio === false) return
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

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    // Safe points: a todo item just completed, or a new turn (the user just
    // spoke, nothing is half-done).
    const todoDone = atSafePoint.has(agent)
    const safe = todoDone || step === 1
    atSafePoint.delete(agent)
    if (signal.aborted) return next()
    let usage = usageOf(ctx, agent.session)
    const due = () => (safe && ratio !== false && overSafePointRatio(usage, ratio))
      || (hardRatio !== false && overSafePointRatio(usage, hardRatio))
    const meter = meterFor(ctx, agent)
    if (meter && (due() || (safe && trimRatio !== false && overSafePointRatio(usage, trimRatio)))) {
      try {
        if (trimSession(agent.session, meter, MIN_TRIM_CHARS) > 0) usage = usageOf(ctx, agent.session)
      } catch (error) {
        console.warn(`smart-compaction: trim failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!due()) return next()
    const compaction = compactionFor(ctx, agent)
    if (!compaction) return next()
    try {
      await compactAgent(ctx, compaction, agent, signal,
        `⏳ ${todoDone ? 'Todo item finished' : step === 1 ? 'New turn' : 'Step finished'} with ${usage.percentUsed}% of the context used — `
        + 'compacting now, before the next step. This runs one extra model call and can take a while on a local model.')
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
