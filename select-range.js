/**
 * Reimplementation of dsh core's `selectCompactableRange`
 * (`@deepseek-ai/dsh-compaction-basic`'s internal `region.ts` — not part of
 * that package's public exports) using only APIs public to any dsh plugin:
 * `toolPairingBalancedBefore` from `@deepseek-ai/dsh-compaction`, and
 * `session.surface`/`session.eventAt` from `@deepseek-ai/dsh-session`.
 *
 * Defaults to the equivalent of `retainTokens = 0` — the largest currently
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
 * @param {{ nodes?: readonly { seq: any, tokens: number }[], retainTokens?: number }} [retain] -
 *   token-meter priced surface nodes plus a verbatim tail budget, like core's
 *   own selection. Without them (or if the pricing doesn't match the surface)
 *   only the final node is kept, as before.
 * @returns {{ start: import('@deepseek-ai/dsh-session').SessionSeq, end: import('@deepseek-ai/dsh-session').SessionSeq } | null}
 */
export function selectCompactableRange(session, toolPairingBalancedBefore, retain = {}) {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return null

  const head = session.eventAt(nodes[0])
  const firstIdx = head !== undefined && head.type === 'system/message' ? 1 : 0

  // Always retain at least the final surface node verbatim.
  let keepFromIdx = nodes.length - 1
  if (keepFromIdx <= firstIdx) return null

  const priced = retain.nodes
  const retainTokens = retain.retainTokens ?? 0
  if (retainTokens > 0 && Array.isArray(priced) && priced.length === nodes.length
    && priced.every((node, i) => node?.seq === nodes[i])) {
    let kept = 0
    for (let i = nodes.length - 1; i > firstIdx; i -= 1) {
      kept += priced[i].tokens
      keepFromIdx = Math.min(keepFromIdx, i)
      if (kept >= retainTokens) break
    }
    // The whole history fits in the tail budget: nothing worth compacting.
    if (kept < retainTokens) return null
  }

  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, nodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  return { start: nodes[firstIdx], end: nodes[keepFromIdx - 1] }
}
