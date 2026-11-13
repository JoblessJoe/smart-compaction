/**
 * Why sessions on local models compact at ~30-45%: dsh's own
 * `compaction-basic` triggers at `floor(min(W × thresholdRatio, W − O − B))`
 * (W = context window, O = request output cap, B = `headroomTokens`, default
 * 65,536 — sized for DeepSeek's large hosted windows). On a 128k local model
 * that `W − B` term wins: the trigger lands near a third of the window, and
 * after each compaction the retained tail (16% of W − O) plus the summary
 * puts the session right back under it a step or two later — the
 * "compact, think, compact again" loop.
 *
 * This plugin cannot change that service's frozen config at runtime; it can
 * only spot the case and say how to fix it. Pure helpers; index.js wires
 * them to `agent/pre-step`.
 */

/** compaction-basic's own defaults (see its config.ts). */
export const CORE_DEFAULT_HEADROOM = 65_536
export const CORE_DEFAULT_THRESHOLD_RATIO = 0.8

/**
 * Headroom/threshold compaction-basic will actually use for `target`,
 * honoring an exact provider/model override like the service itself does.
 * @param {any} config - the compaction service's resolved `config`, if exposed.
 * @param {{ provider?: string, model?: string } | undefined} target
 */
export function corePolicy(config, target) {
  if (config === null || typeof config !== 'object') return undefined
  const override = Array.isArray(config.modelPolicies) && target !== undefined
    ? config.modelPolicies.find(p => p?.provider === target.provider && p?.model === target.model)
    : undefined
  const headroomTokens = override?.headroomTokens ?? config.headroomTokens
  const thresholdRatio = override?.thresholdRatio ?? config.thresholdRatio
  if (typeof headroomTokens !== 'number' || typeof thresholdRatio !== 'number') return undefined
  return { headroomTokens, thresholdRatio }
}

/**
 * Upper bound on compaction-basic's trigger, as a share of the window, when
 * headroom (not `thresholdRatio`) is what decides it. `undefined` when the
 * configured ratio already wins, i.e. there is nothing to warn about. The
 * real trigger is lower still by the request's output cap, which this
 * plugin cannot see.
 * @param {number} contextWindow
 * @param {{ headroomTokens: number, thresholdRatio: number }} policy
 * @returns {{ triggerTokens: number, triggerPercent: number, suggestedHeadroom: number } | undefined}
 */
export function headroomCappedTrigger(contextWindow, policy) {
  if (!(contextWindow > 0)) return undefined
  const byRatio = contextWindow * policy.thresholdRatio
  const byHeadroom = contextWindow - policy.headroomTokens
  // Only worth a warning when headroom pulls the trigger well below the ratio.
  if (byHeadroom >= byRatio - contextWindow * 0.05) return undefined
  const triggerTokens = Math.max(0, byHeadroom)
  return {
    triggerTokens,
    triggerPercent: Math.round((triggerTokens / contextWindow) * 1000) / 10,
    // ~5% of the window, in 1k steps, never below compaction-basic's own
    // small-window README example (4096). Also caps the summary's length
    // (maxTokens follows headroom unless set), so not much lower than this.
    suggestedHeadroom: Math.max(4096, Math.floor((contextWindow * 0.05) / 1024) * 1024),
  }
}
