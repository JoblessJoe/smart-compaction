/**
 * Tool-schema slimming ("context engineering", T3).
 *
 * Every request re-sends the JSON schema of every registered tool — a fixed
 * per-request cost that inflates the attention span of every step. The tool
 * set sits in the request header, so changing it invalidates the KV prefix
 * cache. This module therefore only changes the set at a safe boundary (the
 * agent going idle) and keeps it stable within the next turn.
 *
 * A tool is hidden only when it has been *seen* (used at least once) but has
 * fallen out of a sliding window of the most recent `window` tool uses. Tools
 * the model has never used yet are NEVER hidden — the model may need a tool
 * before it has called it, and hiding it would break the task. When a hidden
 * tool is used again, it re-enters the window and reappears on the next
 * turn's assembly.
 *
 * This is a heuristic, not a correctness guarantee. The savings are real only
 * for large, rarely-used schemas, so the default window is generous. Disable
 * with `schemaSlim: false`.
 */

/** Default sliding-window size (number of most-recent tool uses to remember). */
export const DEFAULT_TOOL_RECENT_WINDOW = 64

/**
 * One agent's sliding window of the most-recent tool uses, plus the set of
 * tools ever seen. Lazily created per agent.
 * @returns {{ recent: Set<string>, seen: Set<string> }}
 */
export function freshRecency() {
  return { recent: new Set(), seen: new Set() }
}

/**
 * Record a tool use for an agent (called from `tools/post-execute`). Updates
 * the sliding window and the ever-seen set.
 * @param {WeakMap<any, {recent: Set<string>, seen: Set<string>}>} recency
 * @param {any} agent
 * @param {string} name
 * @param {number} window
 */
export function recordToolUse(recency, agent, name, window) {
  if (!agent || !name) return
  let r = recency.get(agent)
  if (!r) {
    r = freshRecency()
    recency.set(agent, r)
  }
  r.seen.add(name)
  // Keep only the most-recent `window` uses: drop the oldest beyond the cap.
  r.recent.add(name)
  if (r.recent.size > window) {
    // Sets preserve insertion order; drop the oldest (first) entries to fit.
    for (const oldest of r.recent) {
      if (r.recent.size <= window) break
      r.recent.delete(oldest)
    }
  }
}

/**
 * Transform an assembly, hiding tools that were seen but fell out of the
 * sliding window. Never-used tools and tools still in the window are kept.
 * Returns the original assembly unchanged when there is nothing to hide.
 * @param {any} assembly - the `system-prompt/assemble` result.
 * @param {any} agent
 * @param {WeakMap<any, {recent: Set<string>, seen: Set<string>}>} recency
 * @returns {any} the (possibly reduced) assembly.
 */
export function hideStaleTools(assembly, agent, recency) {
  if (!assembly || assembly.tools === undefined) return assembly
  const r = recency.get(agent)
  if (!r || r.seen.size === 0) return assembly
  const keep = new Set(
    assembly.tools
      .filter((t) => !r.seen.has(t.name) || r.recent.has(t.name))
      .map((t) => t.name)
  )
  const tools = assembly.tools.filter((t) => keep.has(t.name))
  if (tools.length === assembly.tools.length) return assembly
  return { ...assembly, tools }
}
