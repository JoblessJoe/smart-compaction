/**
 * Fixes the "compacts at ~33%" bug on small-window models (see headroom.js
 * for the formula). compaction-basic reserves `headroomTokens` (65,536) on
 * top of the output cap, and its summary cap `maxTokens` defaults to that
 * same 65,536. Shrinking both to `summaryMaxTokens` puts the trigger back
 * near `thresholdRatio` and keeps the summary call inside the window,
 * because the headroom still covers the summary's own output.
 *
 * The engine's config is a frozen snapshot, so the reference is replaced,
 * not mutated (same technique as `dsh-compaction-threshold`). Values the user
 * set lower on purpose are kept. Pure; index.js applies it to the live
 * preset engine on `agent/pre-step`.
 */

export const DEFAULT_SUMMARY_MAX_TOKENS = 16_384

/**
 * @param {any} config - the engine's current resolved config.
 * @param {number} summaryMaxTokens
 * @returns {object | undefined} the replacement config, or undefined when nothing changes.
 */
export function tunedConfig(config, summaryMaxTokens) {
  if (config === null || typeof config !== 'object') return undefined
  const { headroomTokens, maxTokens } = config
  if (typeof headroomTokens !== 'number' || typeof maxTokens !== 'number') return undefined
  const nextHeadroom = Math.min(headroomTokens, summaryMaxTokens)
  const nextMax = Math.min(maxTokens, summaryMaxTokens)
  if (nextHeadroom === headroomTokens && nextMax === maxTokens) return undefined
  return { ...config, headroomTokens: nextHeadroom, maxTokens: nextMax }
}
