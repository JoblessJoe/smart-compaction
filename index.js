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
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { compactRange } from './compact.js'
import { summarizeContextUsage } from './context-status.js'
import { selectCompactableRange } from './select-range.js'
import { completedCount, DEFAULT_SAFE_POINT_RATIO, finishedStep, overSafePointRatio } from './safe-point.js'
import { corePolicy, headroomCappedTrigger } from './headroom.js'
import { DEFAULT_SUMMARY_MAX_TOKENS, tunedConfig } from './engine-tune.js'
import { isMasked, MASK_DEFAULTS, maskResults, staleToolResults } from './mask.js'
import { capReadText, supersededReads } from './reads.js'
import { describeAssembly, trimAssembly } from './prompt-trim.js'
import { recallToolOutput } from './recall.js'

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
async function compactAgent(ctx, compaction, agent, signal) {
  const session = agent.session
  const range = selectCompactableRange(session, toolPairingBalancedBefore, retainFor(ctx, compaction, session))
  if (range === null) return { compacted: false }
  return compactRange(compaction, agent, range, signal)
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
 *   maxOutputTokens?: number | false,
 *   readMaxChars?: number | false,
 *   prompt?: object,
 * }} [config]
 *   - `safePointRatio`: usage fraction (0-1) at which finishing a todo item
 *     compacts automatically; `false` turns it off. Default 0.8.
 *   - `summaryMaxTokens`: headroom and summary cap forced onto the live
 *     compaction-basic engine; `false` leaves the engine alone. Default 16384.
 *   - `mask`: batched masking of stale tool output and outdated file reads;
 *     `false` turns it off.
 *   - `maxOutputTokens`: cap on each request's reply reserve; `false` = off. Default 16384.
 *   - `readMaxChars`: cap on one `read` result; `false` = off. Default 20000.
 *   - `prompt`: `{ report, dropSections, sections, maxSectionChars, maxContextChars }`.
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
        return await compactAgent(ctx, compaction, exec.agent, exec.signal)
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
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (maxOutputTokens !== false && !(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) {
    throw new Error(`smart-compaction: maxOutputTokens must be a positive integer, or false (got ${maxOutputTokens})`)
  }
  const readMaxChars = config.readMaxChars ?? DEFAULT_READ_MAX_CHARS
  if (readMaxChars !== false && !(Number.isInteger(readMaxChars) && readMaxChars >= 1000)) {
    throw new Error(`smart-compaction: readMaxChars must be an integer >= 1000, or false (got ${readMaxChars})`)
  }
  const prompt = { report: true, ...(config.prompt ?? {}) }
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
    const stale = staleToolResults(session, mask)
    const outdated = mask.dedupeReads === false
      ? []
      : supersededReads(session, { minChars: mask.dedupeMinChars, isMasked })
    // An outdated read gets the clearer "outdated" marker even if it is also old.
    const bySeq = new Map(stale.map(c => [c.seq, c]))
    for (const c of outdated) bySeq.set(c.seq, c)
    const candidates = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
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

  // --- 4. reply reserve ---------------------------------------------------
  // Every request reserves `maxTokens` for the reply, and compaction-basic
  // subtracts that same reserve from its trigger. dsh's DeepSeek adapter
  // defaults it to 256,000 — more than a local window. Cap it, never raising
  // a lower value the request or the adapter's model entry already has.
  if (maxOutputTokens !== false) {
    ctx.on('agent/request', async (payload, next) => {
      const proposed = await next()
      try {
        let cap = maxOutputTokens
        if (proposed.maxTokens === undefined) {
          const info = await ctx.get('llm')?.resolveModelInfo?.(proposed.provider, proposed.model, payload.signal)
          if (typeof info?.defaultMaxTokens === 'number') cap = Math.min(cap, info.defaultMaxTokens)
        } else {
          cap = Math.min(cap, proposed.maxTokens)
        }
        return cap === proposed.maxTokens ? proposed : { ...proposed, maxTokens: cap }
      } catch {
        return proposed
      }
    })
  }

  // --- 5. read cap (see reads.js) -----------------------------------------
  if (readMaxChars !== false) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'read' || result.isError || decision?.kind !== 'accept' || decision.value !== undefined) {
        return decision
      }
      const content = decision.content ?? result.content
      const text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      const capped = capReadText(text, readMaxChars)
      if (capped === undefined) return decision
      return { ...decision, content: [{ type: 'text', text: capped }, ...content.filter(b => b?.type !== 'text')] }
    })
  }

  // --- 6. system prompt (see prompt-trim.js) -----------------------------
  // Nothing is cut unless configured; the size report (once per distinct
  // layout) shows which section names are worth trimming.
  const reported = new Set()
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    try {
      if (prompt.report !== false) {
        const line = describeAssembly(out)
        if (!reported.has(line)) {
          reported.add(line)
          info(`smart-compaction: system prompt ${line}`)
        }
      }
      return trimAssembly(out, prompt)
    } catch {
      return out
    }
  })

  // --- 7. safe-point compaction (see safe-point.js) ----------------------
  // A safe point is any clean boundary where the model is between units of
  // work: a todo item just flipped to completed (mid-turn), or an agent just
  // went idle (end of a turn — the default, so todo-less research sessions
  // still get a boundary). Past `safePointRatio` at a safe point, mask stale
  // output first; summarize only if that was not enough. History is rewritten
  // ONLY at these moments, so the KV prefix cache is invalidated at most once
  // per compaction — never mid-turn by per-step masking. Core's own trigger
  // stays the backstop.
  const lastCompleted = new WeakMap()
  const atSafePoint = new WeakSet()

  // A todo item flipping to completed marks a mid-turn safe boundary.
  if (config.safePointBoundaries?.todo !== false) {
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.agent && exec.name === 'todo_write') {
        const done = completedCount(exec.arguments)
        if (finishedStep(lastCompleted.get(exec.agent), done)) atSafePoint.add(exec.agent)
        lastCompleted.set(exec.agent, done)
      }
      return next()
    })
  }

  // An agent going idle is the universal safe boundary: it fires at the end of
  // every turn (the model just produced a full answer and is waiting), and it
  // carries the agent identity for free (the agent-loop fuses `agent` into
  // every agent-scoped event). This is the default boundary — it is what fires
  // for research/analysis sessions that never use todos (the gap that let a
  // session run to a 99.7% emergency compaction). The flag is consumed at the
  // agent's next pre-step, so compaction lands at the start of the following
  // turn, over history that is now fully stale. `agent/status` fires on every
  // transition; only the ->idle edge is a boundary.
  if (config.safePointBoundaries?.idle !== false) {
    ctx.on('agent/status', async ({ status, agent }, next) => {
      if (agent && status === 'idle') atSafePoint.add(agent)
      return next()
    })
  }

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
    } catch (error) {
      warn(`smart-compaction: pre-step housekeeping failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (safeRatio === false || !atSafePoint.has(agent)) return next()
    atSafePoint.delete(agent)
    if (!compaction) return next()
    try {
      if (!overSafePointRatio(usageOf(ctx, agent.session), safeRatio)) return next()
      // Mask only here, at the compaction moment: the summary rewrites the
      // whole range anyway, so the marginal cache cost of masking is ~0.
      maskStale(agent, contextWindow, true)
      const usage = usageOf(ctx, agent.session)
      if (!overSafePointRatio(usage, safeRatio)) return next()
      await compactAgent(ctx, compaction, agent, signal)
    } catch (error) {
      // Never break the turn: core's own pressure trigger is still the backstop.
      warn(`smart-compaction: safe-point compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  }, { prepend: true })
}

/** Reply reserve per request. Room for reasoning plus a large edit, far below 256k. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
/** Read cap in characters (~5k tokens), vs dsh's own 51,200 bytes. */
const DEFAULT_READ_MAX_CHARS = 20_000

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
