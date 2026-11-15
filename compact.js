/**
 * Run dsh's compactRegion() over an already-selected range. Shared by the
 * `compact_now` tool and the automatic safe-point trigger.
 *
 * Deliberately writes nothing to the session first. `compact_now` runs inside
 * its own tool's execute(), while the assistant `tool_calls` message still
 * waits for its `tool` result. A message appended then lands between the two,
 * and strict providers reject every later request with "Messages with role
 * 'tool' must be a response to a preceding message with 'tool_calls'".
 * The tool result reports the outcome instead. (Fix from PR #1, Kita-Ikuyo.)
 *
 * @returns {Promise<{ compacted: true, shadowedCount: number, shadowedTokenCount: number }>}
 */
export async function compactRange(compaction, agent, range, signal) {
  const result = await compaction.compactRegion(range.start, range.end, agent, signal)
  return {
    compacted: true,
    shadowedCount: result.shadowedSeqs.length,
    shadowedTokenCount: result.shadowedTokenCount,
  }
}
