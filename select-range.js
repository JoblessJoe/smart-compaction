/**
 * Reimplementation of dsh core's `selectCompactableRange`
 * (`@deepseek-ai/dsh-compaction-basic`'s internal `region.ts` — not part of
 * that package's public exports) using only APIs public to any dsh plugin:
 * `toolPairingBalancedBefore` from `@deepseek-ai/dsh-compaction`, and
 * `session.surface`/`session.eventAt` from `@deepseek-ai/dsh-session`.
 *
 * Without a token budget: fixed at the equivalent of `retainTokens = 0` — the largest currently
 * compactable span, same as what dsh core's own `compactNow()` (the manual
 * `/compact` command's backend) passes internally. Note this still always
 * keeps the final surface node out of the compactable range: core's own
 * retain-budget loop runs at least once even at `retainTokens = 0`, so it
 * never offers the single most recent node for compaction either. This
 * mirrors that behavior on purpose, not an oversight.
 *
 * @see HANDOFF.md for the full research trail behind this file.
 */

/**
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {(session: any, seq: any) => boolean} toolPairingBalancedBefore
 * @param {{ tokensOf?: (seq: any) => number, retainTokens?: number, maxSpanTokens?: number }} [budget]
 *   With `tokensOf`: keep at least `retainTokens` of recent history verbatim,
 *   and keep compacting the span small enough (`maxSpanTokens`) that the
 *   summarization call — which replays the whole span — still fits the
 *   context window. Without it: the old retainTokens = 0 behavior.
 * @returns {{ start: import('@deepseek-ai/dsh-session').SessionSeq, end: import('@deepseek-ai/dsh-session').SessionSeq } | null}
 */
export function selectCompactableRange(session, toolPairingBalancedBefore, budget = {}) {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return null

  const head = session.eventAt(nodes[0])
  const firstIdx = head !== undefined && head.type === 'system/message' ? 1 : 0

  // Always retain at least the final surface node verbatim.
  let keepFromIdx = nodes.length - 1
  if (keepFromIdx <= firstIdx) return null

  const { tokensOf, retainTokens = 0, maxSpanTokens = Infinity } = budget
  if (tokensOf !== undefined) {
    let span = 0
    for (let i = firstIdx; i < keepFromIdx; i++) span += tokensOf(nodes[i])
    let retained = tokensOf(nodes[keepFromIdx])
    while (keepFromIdx > firstIdx && (retained < retainTokens || span > maxSpanTokens)) {
      keepFromIdx -= 1
      const moved = tokensOf(nodes[keepFromIdx])
      retained += moved
      span -= moved
    }
  }

  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, nodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  return { start: nodes[firstIdx], end: nodes[keepFromIdx - 1] }
}
