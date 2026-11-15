/**
 * File-read housekeeping for dsh's `read` tool (dsh-tool-fs), whose output is
 * `N: text` lines plus a footer such as
 * `(Showing lines 1-200 of 900. Use offset=201 to continue.)`.
 *
 * - `capReadText`: a lower, configurable byte cap than dsh's 51,200, cut at a
 *   line boundary with the same kind of footer, so the model pages on with
 *   `offset` instead of losing anything (the file is still on disk).
 * - `supersededReads`: older reads of a file that a later read covers, or a
 *   later `write` replaced. Their content is outdated, and an outdated copy
 *   is exactly what makes a model "remember" code that is no longer there.
 *
 * Pure over a session-shaped object; index.js wires them up.
 */

/** Line-number range shown by a read result, from its `N: text` lines. */
export function readRange(text) {
  let first
  let last
  for (const line of String(text).split('\n')) {
    const match = /^(\d+): /.exec(line)
    if (match === null) continue
    const n = Number(match[1])
    if (first === undefined) first = n
    last = n
  }
  return first === undefined ? undefined : { first, last }
}

/**
 * Cut a read result to at most `maxChars`, at a line boundary, with a
 * continuation footer. Returns undefined when it already fits.
 * @param {string} text
 * @param {number} maxChars
 */
export function capReadText(text, maxChars) {
  if (text.length <= maxChars) return undefined
  const lines = text.split('\n')
  const kept = []
  let size = 0
  let lastNumber
  for (const line of lines) {
    const match = /^(\d+): /.exec(line)
    if (match === null) continue // drop dsh's own footer; ours replaces it
    if (size + line.length + 1 > maxChars && kept.length > 0) break
    kept.push(line)
    size += line.length + 1
    lastNumber = Number(match[1])
  }
  if (lastNumber === undefined) return undefined
  const firstNumber = Number(/^(\d+): /.exec(kept[0])[1])
  return `${kept.join('\n')}\n\n(Output capped by smart-compaction to save context. Showing lines `
    + `${firstNumber}-${lastNumber}. Use offset=${lastNumber + 1} to continue.)`
}

/** `{ name, args }` for every tool call on the surface, by call id. */
export function toolCallsById(session) {
  const calls = new Map()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    const message = session.deriveEventMessage(event)
    for (const block of message?.content ?? []) {
      if (block?.type !== 'tool-call') continue
      let args
      try {
        args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments
      } catch {
        args = undefined
      }
      calls.set(block.id, { name: block.name, args })
    }
  }
  return calls
}

function callIdOf(message) {
  return message?.toolCallId ?? message?.source?.callId
}

function textOf(message) {
  return (message?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
}

/**
 * Read results whose content a later read (covering the same lines) or a
 * later `write` of the same path has made outdated, oldest first.
 * @param {any} session - `{ surface: { nodes }, eventAt, deriveEventMessage }`.
 * @param {{ minChars: number, readTool?: string, writeTool?: string, isMasked: (blocks: any[]) => boolean }} options
 * @returns {{ seq: number, event: any, message: any, path: string, range: { first: number, last: number } | undefined, reason: 'reread' | 'rewritten' }[]}
 */
export function supersededReads(session, { minChars, readTool = 'read', writeTool = 'write', isMasked }) {
  const calls = toolCallsById(session)
  const nodes = [...session.surface.nodes]
  // Walk newest -> oldest, remembering what later reads/writes covered.
  const laterReads = new Map() // path -> ranges seen later
  const laterWrite = new Set() // paths written later
  const found = []
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = session.eventAt(nodes[i])
    if (event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (!message || message.isError) continue
    const call = calls.get(callIdOf(message))
    const path = call?.args?.file_path
    if (typeof path !== 'string') continue
    if (call.name === writeTool) {
      laterWrite.add(path)
      continue
    }
    if (call.name !== readTool) continue
    const text = textOf(message)
    const range = readRange(text)
    const covered = range !== undefined
      && (laterReads.get(path) ?? []).some(r => r.first <= range.first && r.last >= range.last)
    const rewritten = laterWrite.has(path)
    if (range !== undefined) laterReads.set(path, [...(laterReads.get(path) ?? []), range])
    if (!covered && !rewritten) continue
    if (isMasked(message.content) || text.length < minChars) continue
    found.push({ seq: nodes[i], event, message, path, range, reason: covered ? 'reread' : 'rewritten' })
  }
  return found.reverse()
}
