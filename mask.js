/**
 * Model-free masking of stale tool output ("observation masking").
 *
 * Tool output is most of an agent's context (~84% in JetBrains' SWE-agent
 * study, arXiv 2508.21433), and hiding old output cuts cost about as well as
 * an LLM summary while keeping the conversation itself verbatim. Idea from
 * `@maskpoint/dsh`; the in-place replacement follows dsh's own
 * `tool-result-pruner` protocol exactly: per result, a `compaction/prune`
 * shadow price immediately followed by a content-only `tool/result`
 * replacement citing the original, so the token meter stays exact and the
 * full original stays in the append-only log (see recall.js).
 *
 * Masking runs in batches, not every step: each rewrite of old history makes
 * a local model re-read the prompt from that point (llama.cpp only reuses
 * the KV cache up to the first changed token).
 *
 * The scanning and content helpers are pure over a session-shaped object, so
 * test.js can drive them without a running harness.
 */

/** Opening of every mask marker; also how an already-masked result is recognised. */
export const MASK_TAG = '[smart-compaction: older tool output hidden'

export const MASK_DEFAULTS = Object.freeze({
  /** A result is stale once this many later model steps exist. */
  afterSteps: 4,
  /** Results with less text than this are left alone (not worth a cache miss). */
  minChars: 2000,
  /** Leading characters of the original kept visible in the mask. */
  previewChars: 300,
  /** Mask in one batch once stale output adds up to this share of the window. */
  batchRatio: 0.1,
})

/** Text characters across a tool result's content blocks. */
export function textChars(blocks) {
  let chars = 0
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

/** Whether a tool result's content already carries our mask. */
export function isMasked(blocks) {
  return (blocks ?? []).some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(MASK_TAG))
}

/**
 * Tool results on the current surface that are at least `afterSteps` model
 * steps old and big enough to be worth masking, oldest first. Age counts the
 * `assistant/message` nodes after a result: each model step lands one.
 * @param {any} session - `{ surface: { nodes }, eventAt(seq), deriveEventMessage(event) }`.
 * @param {{ afterSteps: number, minChars: number }} options
 * @returns {{ seq: number, event: any, message: any, chars: number }[]}
 */
export function staleToolResults(session, { afterSteps, minChars }) {
  const nodes = [...session.surface.nodes]
  const found = []
  let laterSteps = 0
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = session.eventAt(nodes[i])
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      laterSteps += 1
      continue
    }
    if (event.type !== 'tool/result' || laterSteps < afterSteps) continue
    const message = session.deriveEventMessage(event)
    if (!message || !Array.isArray(message.content) || isMasked(message.content)) continue
    const chars = textChars(message.content)
    if (chars < minChars) continue
    found.push({ seq: nodes[i], event, message, chars })
  }
  return found.reverse()
}

/**
 * Replacement content: a short preview plus a marker telling the model how
 * to get the rest back. Non-text blocks (images) keep their place.
 * @param {any[]} blocks - original tool-result content.
 * @param {number} seq - seq of the node being masked; recall walks back from it.
 * @param {number} previewChars
 */
export function maskedContent(blocks, seq, previewChars) {
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n')
  const head = text.slice(0, previewChars).trimEnd()
  const marker = `${MASK_TAG} to save context (${text.length.toLocaleString('en-US')} chars). `
    + `Call recall_output with id "${seq}" to get the full original back.]`
  const out = []
  let placed = false
  for (const block of blocks) {
    if (block?.type !== 'text') {
      out.push(block)
      continue
    }
    if (placed) continue
    placed = true
    out.push({ ...block, text: head.length > 0 ? `${head}\n…\n${marker}` : marker })
  }
  return out
}

/**
 * Mask `candidates` in place through dsh's prune protocol.
 * @param {any} session - live dsh session (`append`).
 * @param {{ seq: number, event: any, message: any }[]} candidates
 * @param {{ previewChars: number, estimate: (message: any) => number, freeze: (message: any) => any }} deps
 * @returns {{ masked: number, tokensSaved: number }}
 */
export function maskResults(session, candidates, { previewChars, estimate, freeze }) {
  let masked = 0
  let tokensSaved = 0
  for (const { seq, event, message } of candidates) {
    const replacement = freeze({ ...message, content: maskedContent(message.content, seq, previewChars) })
    const before = estimate(message)
    const after = estimate(replacement)
    if (after >= before) continue
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: before,
    })
    session.append('tool/result', { ...event.data, message: replacement }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    masked += 1
    tokensSaved += before - after
  }
  return { masked, tokensSaved }
}
