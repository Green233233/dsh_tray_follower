import test from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalReason,
  classifyQuestionArguments,
  classifyQuestionItems,
  clip,
  firstQuestionText,
  isTopLevelSession,
  outcomeOfTurnEnd,
  waitText,
} from '../lib/classify.js'

test('clip flattens whitespace and truncates with an ellipsis', () => {
  assert.equal(clip('  a\n\t b   c  '), 'a b c')
  assert.equal(clip('x'.repeat(12), 10), `${'x'.repeat(10)}…`)
  assert.equal(clip(undefined), '')
})

test('isTopLevelSession filters subagent children only', () => {
  assert.equal(isTopLevelSession(undefined), true)
  assert.equal(isTopLevelSession({}), true)
  assert.equal(isTopLevelSession({ header: {} }), true)
  assert.equal(isTopLevelSession({ header: { delegationDepth: 0 } }), true)
  assert.equal(isTopLevelSession({ header: { delegationDepth: 1 } }), false)
  assert.equal(isTopLevelSession({ header: { origin: 'subagent' } }), false)
})

test('firstQuestionText prefers "header: question"', () => {
  assert.equal(firstQuestionText([{ header: 'Confirm', question: 'Proceed?' }]), 'Confirm: Proceed?')
  assert.equal(firstQuestionText([{ question: 'Proceed?' }]), 'Proceed?')
  assert.equal(firstQuestionText([]), '')
  assert.equal(firstQuestionText(undefined), '')
})

test('classifyQuestionItems: options/plan-review need a choice, free text needs input', () => {
  assert.deepEqual(
    classifyQuestionItems([{ question: 'Pick one', options: [{ label: 'a' }] }]),
    { kind: 'choice', text: 'Pick one' },
  )
  assert.deepEqual(
    classifyQuestionItems([{ question: 'Approve plan', intent: { kind: 'plan-review', approve: 'yes' } }]),
    { kind: 'choice', text: 'Approve plan' },
  )
  assert.deepEqual(
    classifyQuestionItems([{ question: 'Your name?', multiSelect: true }]),
    { kind: 'choice', text: 'Your name?' },
  )
  assert.deepEqual(
    classifyQuestionItems([{ question: 'Your name?' }]),
    { kind: 'input', text: 'Your name?' },
  )
  assert.deepEqual(classifyQuestionItems([]), { kind: 'input', text: '' })
})

test('classifyQuestionArguments parses tool-call arguments JSON defensively', () => {
  assert.deepEqual(
    classifyQuestionArguments(JSON.stringify({ questions: [{ question: 'Choose', options: [{ label: 'x' }] }] })),
    { kind: 'choice', text: 'Choose' },
  )
  assert.deepEqual(
    classifyQuestionArguments(JSON.stringify({ questions: [{ question: 'Type' }] })),
    { kind: 'input', text: 'Type' },
  )
  assert.deepEqual(classifyQuestionArguments('not json'), { kind: 'input', text: '' })
  assert.deepEqual(classifyQuestionArguments({ questions: [{ question: 'Obj' }] }), { kind: 'input', text: 'Obj' })
  assert.deepEqual(classifyQuestionArguments(undefined), { kind: 'input', text: '' })
})

test('approvalReason: localized displayReason → reason → tool name', () => {
  assert.equal(
    approvalReason({ displayReason: { en: 'Run this?', zh: '执行吗？' }, reason: 'raw', toolName: 'bash' }, 'zh'),
    '执行吗？',
  )
  assert.equal(approvalReason({ displayReason: { en: 'Run this?' }, reason: 'raw' }, 'fr'), 'Run this?')
  assert.equal(approvalReason({ reason: 'needs sudo', toolName: 'bash' }), 'needs sudo')
  assert.equal(approvalReason({ toolName: 'bash' }), 'bash')
  assert.equal(approvalReason({}), 'tool')
})

test('outcomeOfTurnEnd maps reasons to tray outcomes', () => {
  assert.deepEqual(outcomeOfTurnEnd({ kind: 'completed' }), { outcome: 'completed' })
  assert.deepEqual(outcomeOfTurnEnd({ kind: 'error', error: { message: 'boom' } }), { outcome: 'failed', error: 'boom' })
  assert.equal(outcomeOfTurnEnd({ kind: 'max-tokens' }).outcome, 'failed')
  assert.equal(outcomeOfTurnEnd({ kind: 'blocked' }).outcome, 'failed')
  assert.deepEqual(outcomeOfTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), { outcome: 'idle' })
  assert.deepEqual(outcomeOfTurnEnd({ kind: 'interrupted' }), { outcome: 'idle' })
  assert.deepEqual(outcomeOfTurnEnd(undefined), { outcome: 'idle' })
})

test('waitText clips to the menu budget', () => {
  assert.equal(waitText('  hello   world '), 'hello world')
  assert.ok(waitText('y'.repeat(80)).length <= 61)
})
