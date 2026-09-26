/**
 * Pure summary of dsh's own `contextPressure` session-projection state.
 *
 * That projection is registered by `@deepseek-ai/dsh-token-meter` (mounted
 * on any profile that runs `compaction-basic`) and read here through the
 * public `ctx.sessionProjections.stateOf(session, 'contextPressure')` API —
 * the exact same numbers the web UI's own context meter reads. Nothing about
 * a model or its context-window size is hardcoded: `contextWindow` is
 * whatever the last `request/context` event actually logged for whichever
 * model this session is really routed to, so this works unchanged across
 * profiles, models, and context-window sizes.
 *
 * The `usedTokens` formula mirrors token-meter's own private
 * `contextPressureProjectionDefinition.wire.view` (not part of that
 * package's public exports — see the doc comment above it in
 * `usage-projection.ts` for the reasoning): prompt-side pressure from the
 * last real provider usage sample, adjusted by how much the tracked surface
 * has grown or shrunk (e.g. via compaction) since that sample was taken.
 * Before any request has completed this session, no usage sample exists yet
 * — `surfaceTokens` alone is the best available estimate, flagged
 * `estimated: true`.
 *
 * @see HANDOFF.md for the full research trail behind this file.
 */

/**
 * @param {import('@deepseek-ai/dsh-token-meter').ContextPressureState | undefined} state
 * @returns {{
 *   available: boolean,
 *   contextWindow?: number,
 *   usedTokens?: number,
 *   percentUsed?: number,
 *   estimated?: boolean,
 * }}
 */
export function summarizeContextUsage(state) {
  if (state === undefined) return { available: false }
  if (state.contextWindow === undefined) {
    return { available: true, usedTokens: state.surfaceTokens, estimated: true }
  }

  const hasSample = state.pressureTokens !== undefined && state.sampledSurfaceTokens !== undefined
  const usedTokens = hasSample
    ? Math.max(0, state.pressureTokens + state.surfaceTokens - state.sampledSurfaceTokens)
    : state.surfaceTokens

  return {
    available: true,
    contextWindow: state.contextWindow,
    usedTokens,
    percentUsed: Math.round((usedTokens / state.contextWindow) * 1000) / 10,
    estimated: !hasSample,
  }
}
