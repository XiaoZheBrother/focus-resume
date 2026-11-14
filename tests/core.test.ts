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
