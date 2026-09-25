// Runnable check for select-range.js's range-selection logic. Pure unit
// tests — no live dsh/Ollama session needed, since the function only takes a
// session-shaped object and a tool-pairing predicate, both faked here.
//
//   node test.js

import assert from 'node:assert/strict'
import { selectCompactableRange } from './select-range.js'

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

  console.log('\nall passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
