/**
 * Read-back for masked tool output: the lossless half of mask.js (idea from
 * `dsh-compaction-vcc`'s `recall` tool). The session log is append-only, so a
 * masked or pruned result's original is still there; replacements cite it
 * through `sourceEventSeqs`, which this walks back to the first original.
 */

/** Hard cap on recalled text, so one recall cannot refill the window. */
export const MAX_RECALL_CHARS = 60_000

/**
 * The first original behind a (possibly repeatedly) replaced tool result.
 * @param {any} session - `{ eventAt(seq) }`.
 * @param {number} seq
 */
export function originalToolResult(session, seq) {
  let event = session.eventAt(seq)
  for (let hops = 0; hops < 32 && event?.type === 'tool/result'; hops += 1) {
    const sources = event.sourceEventSeqs
    if (!Array.isArray(sources) || sources.length !== 1 || !(sources[0] < event.seq)) break
    const source = session.eventAt(sources[0])
    if (source?.type !== 'tool/result') break
    event = source
  }
  return event?.type === 'tool/result' ? event : undefined
}

/** Parse "12", "seq 12", "(12)" into a seq number, or undefined. */
export function parseSeq(id) {
  const match = /^\(?\s*(?:seq\s+)?(\d+)\s*\)?$/iu.exec(String(id ?? '').trim())
  if (match === null) return undefined
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) ? seq : undefined
}

/**
 * Full original text of the tool result behind `id`.
 * @param {any} session - `{ eventAt(seq), deriveEventMessage(event) }`.
 * @param {unknown} id
 * @returns {{ found: false, text: string } | { found: true, seq: number, text: string, truncated: boolean }}
 */
export function recallToolOutput(session, id) {
  const seq = parseSeq(id)
  if (seq === undefined) return { found: false, text: `Invalid id "${String(id)}": pass the number from the mask, e.g. "1234".` }
  const event = originalToolResult(session, seq)
  if (event === undefined) return { found: false, text: `No tool result at seq ${seq} in this session.` }
  const message = session.deriveEventMessage(event)
  const text = (message?.content ?? [])
    .map(b => (b?.type === 'text' ? b.text : `[${String(b?.type)}]`))
    .join('\n')
  const truncated = text.length > MAX_RECALL_CHARS
  return {
    found: true,
    seq: event.seq,
    truncated,
    text: truncated
      ? `${text.slice(0, MAX_RECALL_CHARS)}\n[recall cut at ${MAX_RECALL_CHARS} of ${text.length} chars]`
      : text,
  }
}
