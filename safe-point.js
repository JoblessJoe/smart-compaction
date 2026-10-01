/**
 * Automatic safe-point compaction: the plugin's answer to "local models
 * rarely call compact_now on their own". Instead of waiting for the model to
 * decide, the plugin treats "a todo item just flipped to completed" as the
 * safe boundary and compacts before the next step whenever usage is already
 * past `ratio` of the context window — well below core's own 80% trigger,
 * which fires wherever the step happens to land.
 *
 * Pure helpers only; index.js wires them to `tools/post-execute` and
 * `agent/pre-step`.
 */

/** Default usage fraction at which a finished todo item triggers compaction. */
export const DEFAULT_SAFE_POINT_RATIO = 0.5

/**
 * Number of completed items in a `todo_write` argument list (0 on bad input).
 * @param {unknown} args
 */
export function completedCount(args) {
  const todos = args !== null && typeof args === 'object' ? /** @type {any} */ (args).todos : undefined
  return Array.isArray(todos) ? todos.filter(t => t?.status === 'completed').length : 0
}

/**
 * Whether a todo_write moved the completed count up (= a step just finished).
 * A count going down (new turn, rewritten list) only resets the baseline.
 * @param {number | undefined} before - completed count from this agent's previous todo_write.
 * @param {number} after
 */
export function finishedStep(before, after) {
  return after > (before ?? 0)
}

/**
 * Whether usage is high enough to compact at a safe point.
 * @param {{ available: boolean, percentUsed?: number }} usage - summarizeContextUsage() output.
 * @param {number} ratio - 0..1
 */
export function overSafePointRatio(usage, ratio) {
  return usage.available && usage.percentUsed !== undefined && usage.percentUsed >= ratio * 100
}
