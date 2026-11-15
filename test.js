// Runnable check for select-range.js's range-selection logic. Pure unit
// tests — no live dsh/Ollama session needed, since the function only takes a
// session-shaped object and a tool-pairing predicate, both faked here.
//
//   node test.js

import assert from 'node:assert/strict'
import { summarizeContextUsage } from './context-status.js'
import { selectCompactableRange } from './select-range.js'
import { findStale } from './trim.js'
import { completedCount, finishedStep, overSafePointRatio } from './safe-point.js'

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

  console.log('13) budget: keeps a recent tail of >= retainTokens...')
  {
    // head + 6 nodes of 10 tokens each; keep >= 25 -> last 3 retained
    const session = makeSession([{ type: 'system/message' }, ...Array(6).fill({ type: 'user/message' })])
    const priced = session.surface.nodes.map((seq, i) => ({ seq, tokens: 10 }))
    const range = selectCompactableRange(session, alwaysBalanced, { nodes: priced, retainTokens: 25 })
    assert.deepEqual(range, { start: 1, end: 3 })
  }

  console.log('14) budget: whole history fits the tail budget -> null...')
  {
    const session = makeSession([{ type: 'system/message' }, ...Array(3).fill({ type: 'user/message' })])
    const priced = session.surface.nodes.map((seq, i) => ({ seq, tokens: 10 }))
    assert.equal(selectCompactableRange(session, alwaysBalanced, { nodes: priced, retainTokens: 100 }), null)
  }

  console.log('15) budget: stale pricing (seqs do not match the surface) -> final node only...')
  {
    const session = makeSession([{ type: 'system/message' }, ...Array(6).fill({ type: 'user/message' })])
    const stale = [{ seq: 99, tokens: 10 }, { seq: 98, tokens: 10 }]
    const range = selectCompactableRange(session, alwaysBalanced, { nodes: stale, retainTokens: 25 })
    assert.deepEqual(range, { start: 1, end: 5 })
  }

  console.log('16) trim: superseded write/read/bash stubbed; edits, latest and errors kept...')
  {
    const big = 'x\n'.repeat(600)
    const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
    const asst = (seq, ...calls) => ({ seq, type: 'assistant/message', message: { role: 'assistant', content: calls } })
    const res = (seq, id, text, isError = false) => ({ seq, type: 'tool/result', message: { role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }] } })
    const nodes = [
      asst(1, call('w1', 'write', { file_path: 'a.js', content: big })), res(2, 'w1', 'ok'),
      asst(3, call('r1', 'read', { file_path: 'b.js' })), res(4, 'r1', big + '(End of file - total 600 lines)'),
      asst(5, call('b1', 'bash', { command: 'npm test' })), res(6, 'b1', big),
      asst(7, call('e1', 'edit', { file_path: 'a.js', old_string: big, new_string: big })), res(8, 'e1', 'ok'),
      asst(9, call('r2', 'read', { file_path: 'a.js' })), res(10, 'r2', big + '(End of file - total 600 lines)'),
      asst(11, call('w2', 'write', { file_path: 'b.js', content: big })), res(12, 'w2', 'ok'),
      asst(13, call('b2', 'bash', { command: 'npm test' })), res(14, 'b2', big, true),
      asst(15, call('r3', 'read', { file_path: 'c.js' })), res(16, 'r3', big + '(Output capped. Showing lines 1-500.)'),
      asst(17, call('w3', 'write', { file_path: 'c.js', content: big })), res(18, 'w3', 'ok'),
    ]
    const { results, writes } = findStale(nodes)
    assert.deepEqual(results.map(r => r.seq).sort((a, b) => a - b), [4, 6, 16], 'old reads of b.js/c.js (both rewritten later) + first npm test run')
    assert.deepEqual(writes.map(w => w.seqs), [[1, 2]], 'a.js write+result superseded by full read; edit kept')
    assert.match(writes[0].text, /a\.js \(601 lines\)/)
    // a capped read (c.js) never supersedes anything; w3 is latest so it stays.

    // a message mixing a stale write with another call is left alone
    const mixed = [
      asst(1, call('w1', 'write', { file_path: 'a.js', content: big }), call('x', 'bash', { command: 'ls' })),
      res(2, 'w1', 'ok'), res(3, 'x', 'ok'),
      asst(4, call('w2', 'write', { file_path: 'a.js', content: big })), res(5, 'w2', 'ok'),
    ]
    assert.deepEqual(findStale(mixed).writes, [])
  }

  console.log('\nall passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
