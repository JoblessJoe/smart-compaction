/**
 * Context trimming: replace provably stale tool content with one-line stubs,
 * model-free and without losing anything the model can't get back.
 *
 * Stale means superseded later in the same history:
 * - a `read` result, once that file is read in full again or rewritten;
 * - a `write` call's file content, once that file is rewritten or read in full;
 * - a `bash` result, once the exact same command ran again.
 * Edits (old/new strings = the diffs) and the latest version of everything
 * stay verbatim.
 *
 * Everything goes through core's replace protocol (a `compaction/prune` price
 * event, then the replacement — same as tool-result-pruner and compaction), so
 * trimmed sessions resume fine even with this plugin uninstalled. An assistant
 * message can't be replaced in place, so a superseded `write` swaps the whole
 * call+result pair for one short user message. Only done when every call in
 * that message is such a write; mixed messages are left alone.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

const MARKER = '[trimmed'
const SOURCE = { kind: 'smart-compaction' }
/** Below this a stub isn't worth the provider prefix-cache reset. */
const MIN_CHARS = 800

const textOf = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('')
const parse = json => { try { return JSON.parse(json) } catch { return {} } }


/**
 * Pick stale content. Pure.
 * @param {{ seq: any, type: string, message: any }[]} nodes - current surface, in order.
 * @returns {{ results: { seq: any, text: string, saved: number }[], writes: { seqs: any[], text: string, saved: number }[] }}
 */
export function findStale(nodes) {
  const calls = new Map()
  for (const node of nodes) {
    if (node.type !== 'assistant/message') continue
    for (const b of node.message.content) {
      if (b.type === 'tool-call') calls.set(b.id, { name: b.name, args: parse(b.arguments) })
    }
  }
  const supersededFile = new Set() // later full read or write
  const rerunCommand = new Set()
  const intactReads = new Set() // read calls whose result is still complete
  const results = [], writes = []
  // Walk backwards so "later" is already known; a result sits after its call.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { seq, type, message } = nodes[i]
    if (type === 'tool/result') {
      const call = calls.get(message.toolCallId)
      const text = textOf(message)
      // Only a read that reached end of file, unpruned, holds the whole file.
      if (call?.name === 'read' && !message.isError && text.includes('(End of file - total') && !text.includes('tool result middle pruned')) {
        intactReads.add(message.toolCallId)
      }
      if (call === undefined || message.isError || text.startsWith(MARKER) || text.length < MIN_CHARS) continue
      if (call.name === 'read' && supersededFile.has(call.args.file_path)) {
        results.push({ seq, saved: text.length, text: `${MARKER}: old read of ${call.args.file_path}; it was re-read or rewritten later — read it again if needed]` })
      } else if (call.name === 'bash' && rerunCommand.has(call.args.command)) {
        results.push({ seq, saved: text.length, text: `${MARKER}: output of an earlier run; the same command ran again later]` })
      }
    } else if (type === 'assistant/message') {
      const stale = []
      const toolCalls = message.content.filter(b => b.type === 'tool-call')
      for (const b of [...toolCalls].reverse()) {
        const args = parse(b.arguments)
        if (b.name === 'write') {
          if (supersededFile.has(args.file_path) && b.arguments.length >= MIN_CHARS) {
            stale.push(`${args.file_path} (${String(args.content ?? '').split('\n').length} lines)`)
          }
          supersededFile.add(args.file_path)
        } else if (b.name === 'read' && intactReads.has(b.id) && (args.offset ?? 1) === 1) {
          supersededFile.add(args.file_path)
        } else if (b.name === 'bash') {
          rerunCommand.add(args.command)
        }
      }
      // The pair = this message + the results right after it, one per call.
      const pair = nodes.slice(i, i + 1 + toolCalls.length)
      const ids = new Set(toolCalls.map(b => b.id))
      if (stale.length > 0 && stale.length === toolCalls.length
        && pair.slice(1).every(n => n.type === 'tool/result' && ids.has(n.message.toolCallId))
        && pair.length === 1 + toolCalls.length) {
        writes.push({
          seqs: pair.map(n => n.seq),
          saved: pair.reduce((sum, n) => sum + JSON.stringify(n.message.content).length, 0),
          text: `${MARKER}: earlier you wrote ${stale.reverse().join(', ')}; superseded by a later write or full read of the same file]`,
        })
      }
    }
  }
  return { results, writes }
}

/**
 * Trim `session` in place. Returns characters saved (0 = nothing done).
 * @param {number} minSavedChars - skip unless at least this much goes.
 */
export function trimSession(session, meter, minSavedChars) {
  const nodes = session.surface.nodes.map(seq => {
    const event = session.eventAt(seq)
    return { seq, type: event.type, message: session.deriveEventMessage(event) }
  }).filter(node => node.message)
  const { results, writes } = findStale(nodes)
  const saved = [...results, ...writes].reduce((sum, item) => sum + item.saved, 0)
  if (saved < minSavedChars) return 0
  for (const { seqs, text } of writes) {
    const originals = seqs.map(seq => session.deriveEventMessage(session.eventAt(seq)))
    session.append('compaction/prune', {
      shadowedRange: { start: seqs[0], end: seqs.at(-1) },
      shadowedSeqs: seqs,
      shadowedTokenCount: originals.reduce((sum, m) => sum + meter.estimateMessage(m), 0),
    })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: SOURCE }), {
      surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) },
      sourceEventSeqs: seqs,
    })
  }
  for (const { seq, text } of results) {
    const event = session.eventAt(seq)
    const original = session.deriveEventMessage(event)
    // Shadow-price protocol: price event, then the replacement, back to back.
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: meter.estimateMessage(original),
    })
    session.append('tool/result', { ...event.data, message: { ...original, content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }
  return saved
}
