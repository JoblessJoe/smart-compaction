// Runnable check for select-range.js's range-selection logic. Pure unit
// tests — no live dsh/Ollama session needed, since the function only takes a
// session-shaped object and a tool-pairing predicate, both faked here.
//
//   node test.js

import assert from 'node:assert/strict'
import { summarizeContextUsage } from './context-status.js'
import { selectCompactableRange } from './select-range.js'
import { completedCount, finishedStep, overSafePointRatio } from './safe-point.js'
import { corePolicy, headroomCappedTrigger } from './headroom.js'
import { tunedConfig } from './engine-tune.js'
import { MASK_TAG, maskResults, staleToolResults } from './mask.js'
import { originalToolResult, recallToolOutput } from './recall.js'

/**
 * A tiny append-only session double: events by seq, a surface of seqs, and
 * `append` honouring `surfaceOp: replace` the way dsh does.
 */
function makeLiveSession(specs) {
  const events = []
  const surface = { nodes: [] }
  const push = (type, data, opts = {}) => {
    const event = { seq: events.length, type, data, ...(opts.sourceEventSeqs ? { sourceEventSeqs: opts.sourceEventSeqs } : {}) }
    events.push(event)
    const op = opts.surfaceOp
    if (op && op.op === 'replace') {
      const i = surface.nodes.indexOf(op.startSeq)
      surface.nodes.splice(i, 1, event.seq)
    } else if (type !== 'compaction/prune') {
      surface.nodes.push(event.seq)
    }
    return event
  }
  for (const spec of specs) push(spec.type, spec.data ?? {})
  return {
    surface,
    events,
    eventAt: seq => events[seq],
    deriveEventMessage: event => event.data.message,
    append: push,
  }
}
const toolResult = text => ({ type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text }] } } })
const step = { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } }

/**
 * @param {{ type: string }[]} events - event at index i has seq i.
 * @returns {{ surface: { nodes: number[] }, eventAt: (seq: number) => { type: string } | undefined }}
 */
function makeSession(events) {
  return {
    surface: { nodes: events.map((_, seq) => seq) },
    eventAt: seq => events[seq],
  }
}

const alwaysBalanced = () => true
const neverBalanced = () => false

async function main() {
  console.log('1) empty surface -> null...')
  assert.equal(selectCompactableRange(makeSession([]), alwaysBalanced), null)

  console.log('2) system head only, nothing else -> null...')
  assert.equal(
    selectCompactableRange(makeSession([{ type: 'system/message' }]), alwaysBalanced),
    null,
  )

  console.log('3) system head + 4 messages, always balanced -> excludes head and last node...')
  {
    const session = makeSession([
      { type: 'system/message' },
      { type: 'user/message' },
      { type: 'assistant/message' },
      { type: 'user/message' },
      { type: 'assistant/message' },
    ])
    const range = selectCompactableRange(session, alwaysBalanced)
    assert.deepEqual(range, { start: 1, end: 3 }, 'keeps seq 0 (system head) and seq 4 (last node) out')
  }

  console.log('4) no system head -> range can start at seq 0...')
  {
    const session = makeSession([
      { type: 'user/message' },
      { type: 'assistant/message' },
      { type: 'user/message' },
    ])
    const range = selectCompactableRange(session, alwaysBalanced)
    assert.deepEqual(range, { start: 0, end: 1 })
  }

  console.log('5) walks back past unbalanced boundaries to the nearest balanced one...')
  {
    const session = makeSession([
      { type: 'system/message' },
      { type: 'user/message' },
      { type: 'assistant/message' }, // seq 2 - only balanced boundary
      { type: 'tool/call' },
      { type: 'tool/result' },
      { type: 'assistant/message' },
    ])
    const balancedOnlyAtTwo = (_session, seq) => seq === 2
    const range = selectCompactableRange(session, balancedOnlyAtTwo)
    assert.deepEqual(range, { start: 1, end: 1 })
  }

  console.log('6) never balanced before the head -> null...')
  {
    const session = makeSession([
      { type: 'system/message' },
      { type: 'user/message' },
      { type: 'assistant/message' },
    ])
    assert.equal(selectCompactableRange(session, neverBalanced), null)
  }

  console.log('7) only one non-head node -> null (the single node is always retained)...')
  {
    const session = makeSession([
      { type: 'system/message' },
      { type: 'user/message' },
    ])
    assert.equal(selectCompactableRange(session, alwaysBalanced), null)
  }

  console.log('8) context_status: no projection state (service not mounted) -> unavailable...')
  assert.deepEqual(summarizeContextUsage(undefined), { available: false })

  console.log('9) context_status: no request logged yet -> surfaceTokens only, no window...')
  {
    const result = summarizeContextUsage({ surfaceTokens: 120 })
    assert.deepEqual(result, { available: true, usedTokens: 120, estimated: true })
  }

  console.log('10) context_status: window known, no usage sample yet -> surfaceTokens, estimated...')
  {
    const result = summarizeContextUsage({ contextWindow: 10_000, surfaceTokens: 500 })
    assert.deepEqual(result, {
      available: true, contextWindow: 10_000, usedTokens: 500, percentUsed: 5, estimated: true,
    })
  }

  console.log('11) context_status: real usage sample -> pressure + surface delta, not estimated...')
  {
    // 1000 prompt tokens sampled when surface was 800; surface has since grown to 950
    // (e.g. new tool output) -> projected usage = 1000 + (950 - 800) = 1150.
    const result = summarizeContextUsage({
      contextWindow: 10_000,
      pressureTokens: 1_000,
      sampledSurfaceTokens: 800,
      surfaceTokens: 950,
    })
    assert.deepEqual(result, {
      available: true, contextWindow: 10_000, usedTokens: 1_150, percentUsed: 11.5, estimated: false,
    })
  }

  console.log('12) context_status: surface shrank below the sample (e.g. compaction) -> clamped to 0...')
  {
    const result = summarizeContextUsage({
      contextWindow: 10_000,
      pressureTokens: 200,
      sampledSurfaceTokens: 5_000,
      surfaceTokens: 100,
    })
    assert.equal(result.usedTokens, 0)
  }

  console.log('safe-point: completed count, step detection, ratio gate...')
  {
    const todos = s => ({ todos: s.map(status => ({ content: 'x', status })) })
    assert.equal(completedCount(todos(['completed', 'in_progress', 'completed'])), 2)
    assert.equal(completedCount(undefined), 0)
    assert.equal(completedCount({ todos: 'nope' }), 0)
    assert.equal(finishedStep(undefined, 1), true, 'first completion counts')
    assert.equal(finishedStep(1, 1), false, 'status-only rewrite is not a finished step')
    assert.equal(finishedStep(3, 0), false, 'new list resets, not a step')
    assert.equal(overSafePointRatio({ available: true, percentUsed: 55 }, 0.5), true)
    assert.equal(overSafePointRatio({ available: true, percentUsed: 40 }, 0.5), false)
    assert.equal(overSafePointRatio({ available: true, usedTokens: 9 }, 0.5), false, 'unknown window -> no')
    assert.equal(overSafePointRatio({ available: false }, 0.5), false)
  }

  console.log('headroom: default 65k headroom caps the trigger on small windows...')
  {
    const defaults = { headroomTokens: 65_536, thresholdRatio: 0.8, modelPolicies: [] }
    const capped = headroomCappedTrigger(131_072, corePolicy(defaults, undefined))
    assert.equal(capped.triggerTokens, 65_536)
    assert.equal(capped.triggerPercent, 50)
    assert.equal(capped.suggestedHeadroom, 6144)
    assert.equal(headroomCappedTrigger(1_000_000, defaults), undefined, 'big window: ratio wins')
    assert.equal(
      headroomCappedTrigger(131_072, { headroomTokens: 6144, thresholdRatio: 0.8 }),
      undefined,
      'fixed headroom: no warning',
    )
    const withOverride = {
      ...defaults,
      modelPolicies: [{ provider: 'ollama', model: 'qwen', headroomTokens: 4096 }],
    }
    assert.equal(corePolicy(withOverride, { provider: 'ollama', model: 'qwen' }).headroomTokens, 4096)
    assert.equal(corePolicy(withOverride, { provider: 'x', model: 'y' }).headroomTokens, 65_536)
    assert.equal(corePolicy(undefined, undefined), undefined)
  }

  console.log('select-range: retained tail...')
  {
    const session = makeSession([
      { type: 'system/message' }, { type: 'user/message' }, { type: 'user/message' },
      { type: 'user/message' }, { type: 'user/message' },
    ])
    const nodes = [0, 1, 2, 3, 4].map(seq => ({ seq, tokens: 100 }))
    assert.deepEqual(
      selectCompactableRange(session, alwaysBalanced, { nodes, retainTokens: 200 }),
      { start: 1, end: 2 },
      'keeps the newest 200 tokens (two nodes)',
    )
    assert.equal(
      selectCompactableRange(session, alwaysBalanced, { nodes, retainTokens: 10_000 }),
      null,
      'everything fits the tail: nothing to compact',
    )
    assert.deepEqual(
      selectCompactableRange(session, alwaysBalanced, { nodes: nodes.slice(1), retainTokens: 200 }),
      { start: 1, end: 3 },
      'mismatched pricing falls back to keep-last-node',
    )
  }

  console.log('engine-tune: shrink headroom + summary cap, keep lower user values...')
  {
    const stock = { headroomTokens: 65_536, maxTokens: 65_536, thresholdRatio: 0.8 }
    assert.deepEqual(tunedConfig(stock, 16_384), { headroomTokens: 16_384, maxTokens: 16_384, thresholdRatio: 0.8 })
    assert.equal(tunedConfig({ headroomTokens: 4096, maxTokens: 8192 }, 16_384), undefined, 'already lower: untouched')
    assert.equal(tunedConfig(tunedConfig(stock, 16_384), 16_384), undefined, 'idempotent')
    assert.equal(tunedConfig(undefined, 16_384), undefined)
  }

  console.log('mask: only old, big, unmasked results; batched; recall restores...')
  {
    const big = 'x'.repeat(5000)
    const session = makeLiveSession([
      { type: 'system/message' },
      toolResult(big), // seq 1: 5 steps old
      toolResult('small'), // seq 2: too small
      step, step, step, step,
      toolResult(big), // seq 7: 1 step old
      step,
    ])
    const options = { afterSteps: 4, minChars: 2000 }
    const stale = staleToolResults(session, options)
    assert.deepEqual(stale.map(c => c.seq), [1])

    const result = maskResults(session, stale, {
      previewChars: 100,
      estimate: m => Math.ceil(m.content.map(b => b.text ?? '').join('').length / 4),
      freeze: m => m,
    })
    assert.equal(result.masked, 1)
    assert.ok(result.tokensSaved > 1000)
    const replacedSeq = session.surface.nodes[1]
    assert.notEqual(replacedSeq, 1, 'surface now points at the replacement')
    const masked = session.eventAt(replacedSeq).data.message.content[0].text
    assert.ok(masked.includes(MASK_TAG) && masked.includes('id "1"'))
    assert.ok(masked.length < 600)
    assert.equal(session.events[replacedSeq - 1].type, 'compaction/prune', 'shadow price lands right before')
    assert.deepEqual(staleToolResults(session, options), [], 'already masked: not again')

    assert.equal(originalToolResult(session, replacedSeq).seq, 1, 'walks back to the original')
    const recalled = recallToolOutput(session, `seq ${replacedSeq}`)
    assert.equal(recalled.found, true)
    assert.equal(recalled.text, big)
    assert.equal(recallToolOutput(session, '1').text, big)
    assert.equal(recallToolOutput(session, 'nope').found, false)
    assert.equal(recallToolOutput(session, '0').found, false, 'system message is not a tool result')
  }

  console.log('\nall passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
