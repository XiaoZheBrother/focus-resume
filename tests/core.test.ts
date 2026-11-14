import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCommand, elapsed, pause, reminders } from '../src/core'
import { activeSession, freshState, workMs, type State } from '../src/shared/model'

function start(state: State, title: string, at: number, planMinutes = 0) {
  return applyCommand(state, { type: 'create', title, docId: null, start: true,
    planMinutes, expected: activeSession(state)?.id ?? null }, at)!
}

test('a task survives multiple work sessions with immutable historical goals', () => {
  const state = freshState()
  const taskId = start(state, 'Compare two designs', 1000)
  const first = activeSession(state)!
  applyCommand(state, { type: 'edit', taskId, card: { goal: 'Write a comparison', next: 'List constraints' } }, 1000)
  elapsed(state, 4000, 3000)
  applyCommand(state, { type: 'pause', sessionId: first.id }, 4000)
  elapsed(state, 25_000, 21_000)
  applyCommand(state, { type: 'resume', sessionId: first.id }, 25_000)
  applyCommand(state, { type: 'resume', sessionId: first.id }, 25_000)
  elapsed(state, 27_000, 2000)
  applyCommand(state, { type: 'end', sessionId: first.id, outcome: 'partial', result: 'Compared cost' }, 27_000)
  assert.equal(workMs(first), 5000)
  assert.equal(first.segments.length, 2)
  assert.equal(state.tasks[0].status, 'open')
  assert.equal(state.tasks[0].card.next, 'List constraints')
  applyCommand(state, { type: 'start', taskId, expected: null, planMinutes: 0 }, 30_000)
  applyCommand(state, { type: 'edit', taskId, card: { goal: 'Compare maintenance' } }, 31_000)
  assert.equal(first.goalAtEnd, 'Write a comparison')
  assert.equal(activeSession(state)?.goalAtStart, 'Write a comparison')
})

test('checking the expected session makes a duplicate or stale switch safe', () => {
  const state = freshState()
  const first = start(state, 'Original', 1000)
  const original = activeSession(state)!
  const next = { type: 'create' as const, title: 'Next', docId: null, start: true, planMinutes: 0, expected: original.id }
  const second = applyCommand(state, next, 2000)
  assert.throws(() => applyCommand(state, next, 2001), /会话已变化/)
  assert.equal(state.tasks.length, 2)
  assert.equal(state.tasks.find(task => task.id === first)?.status, 'open')
  assert.equal(original.reason, 'switch')
  assert.equal(activeSession(state)?.taskId, second)
  assert.equal(state.sessions.filter(s => s.status !== 'ended').length, 1)
})

test('rest, lock, recovery and clock changes never add inactive time', () => {
  const state = freshState()
  start(state, 'Read', 0, 1)
  const session = activeSession(state)!
  for (let now = 2500; now <= 60_000; now += 2500) elapsed(state, now, 2500)
  assert.equal(reminders(state).length, 1)
  assert.equal(reminders(state).length, 0)
  applyCommand(state, { type: 'rest', sessionId: session.id, minutes: 5 }, 60_000)
  elapsed(state, 63_000, 3000)
  assert.equal(workMs(session), 60_000)
  assert.equal(session.segments.at(-1)!.duration, 3000)
  pause(state, 'lock')
  elapsed(state, 70_000, 7000)
  assert.equal(session.segments.at(-1)!.duration, 3000)
  applyCommand(state, { type: 'resume', sessionId: session.id }, 70_000)
  elapsed(state, 20_000, 900)
  assert.equal(session.reason, 'clock-or-sleep')
  assert.equal(workMs(session), 60_000)
  assert.equal(session.status, 'paused')
})

test('capturing a thought does not switch, and creating a task from it is idempotent', () => {
  const state = freshState()
  const taskId = start(state, 'Read chapter one', 0)
  const session = activeSession(state)!
  applyCommand(state, { type: 'thought', sessionId: session.id, text: 'Reply to email' }, 1)
  assert.equal(activeSession(state)?.taskId, taskId)
  applyCommand(state, { type: 'status', taskId, status: 'archived', expected: session.id }, 2)
  assert.equal(session.reason, 'archived')
  const command = { type: 'handleThought' as const, sessionId: session.id, thoughtId: session.thoughts[0].id, createTask: true }
  applyCommand(state, command, 3)
  applyCommand(state, command, 3)
  assert.equal(state.tasks.length, 2)
  assert.equal(state.tasks[1].title, 'Reply to email')
  assert.equal(activeSession(state), undefined)
})

test('quick capture survives a session switch and can be turned into a task once', () => {
  const state = freshState()
  const captureId = '96a8590f-a408-4083-9ff0-bb1257aa223f'
  const capture = { type: 'capture' as const, sessionId: null, captureId, text: 'Inbox thought' }
  applyCommand(state, capture, 1)
  applyCommand(state, capture, 2)
  assert.equal(state.inbox.length, 1)
  start(state, 'Read chapter', 3)
  const previous = activeSession(state)!
  start(state, 'Current task', 4)
  applyCommand(state, { ...capture, sessionId: previous.id, text: 'Original thought' }, 5)
  assert.equal(previous.thoughts[0].text, 'Original thought')
  const handle = { type: 'handleThought' as const, sessionId: null, thoughtId: captureId, createTask: true }
  applyCommand(state, handle, 6)
  applyCommand(state, handle, 7)
  assert.equal(state.tasks.filter(task => task.title === 'Inbox thought').length, 1)
  assert.equal(activeSession(state)?.status, 'working')
})

test('review intervals handle partial recall and reject duplicate or early reviews', () => {
  const state = freshState()
  const docId = 'b4f1f66d-6561-448f-96ad-35c273a31cb9'
  const position = { index: 3, offset: .25 }
  state.documents.push({ id: docId, name: 'test.md', hash: 'a'.repeat(64), size: 1, format: 'md', createdAt: 0, position })
  applyCommand(state, { type: 'studyCreate', docId, position, question: 'How?', answer: 'Example' }, 12)
  const [card] = state.studyCards
  const rating = { type: 'studyReview' as const, cardId: card.id, expectedReviews: 0, rating: 'again' as const }
  applyCommand(state, rating, 12)
  assert.equal(card.dueAt, 600_012)
  assert.throws(() => applyCommand(state, rating, 12), /复习记录已变化/)
  assert.throws(() => applyCommand(state, { ...rating, expectedReviews: 1 }, 13), /还没到/)
  applyCommand(state, { ...rating, expectedReviews: 1, rating: 'remembered' }, card.dueAt)
  assert.equal(card.intervalDays, 1)
  applyCommand(state, { ...rating, expectedReviews: 2, rating: 'remembered' }, card.dueAt)
  assert.equal(card.intervalDays, 3)
  applyCommand(state, { ...rating, expectedReviews: 3, rating: 'partial' }, card.dueAt)
  assert.equal(card.intervalDays, 1)
  assert.deepEqual(card.position, position)
  applyCommand(state, { type: 'deleteDocument', docId }, card.dueAt)
  assert.deepEqual(state.studyCards, [])
  assert.throws(() => applyCommand(state, rating, 1), /已移除/)
})
