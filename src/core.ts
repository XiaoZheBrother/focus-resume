import { randomUUID } from 'node:crypto'
import { activeSession, emptyCard, workMs, type Command, type Session, type State, type Task } from './shared/model'

export function elapsed(state: State, now: number, monotonicDelta: number) {
  const session = activeSession(state)
  if (!session || session.status === 'paused') return
  if (Math.abs(now - session.checkpointAt - monotonicDelta) > 10_000 || monotonicDelta > 30_000) {
    session.status = 'paused'
    session.reason = 'clock-or-sleep'
    return
  }
  const segment = session.segments.at(-1)
  if (segment) segment.duration += Math.max(0, Math.floor(monotonicDelta))
  session.checkpointAt = now
}

export function pause(state: State, reason: string) {
  const session = activeSession(state)
  if (session && session.status !== 'paused') {
    session.status = 'paused'
    session.reason = reason
  }
}

export function reminders(state: State) {
  const session = activeSession(state)
  const messages: string[] = []
  if (session?.status === 'working' && session.planMinutes && !session.planNotified &&
      workMs(session) >= session.planMinutes * 60_000) {
    session.planNotified = true
    messages.push('已到计划时长，可以继续工作或休息。')
  }
  if (session?.status === 'resting' && session.restMinutes && !session.restNotified &&
      (session.segments.at(-1)?.duration ?? 0) >= session.restMinutes * 60_000) {
    session.restNotified = true
    messages.push('休息时间到了，准备好后可以继续。')
  }
  return messages
}

export function applyCommand(state: State, command: Command, now: number) {
  const active = activeSession(state)
  const requireTask = (taskId: string) => {
    const task = state.tasks.find(item => item.id === taskId)
    if (!task) throw new Error('找不到该任务。')
    return task
  }
  const requireDocument = (docId: string) => {
    const doc = state.documents.find(item => item.id === docId)
    if (!doc) throw new Error('文档已移除。')
    return doc
  }
  const checkExpected = (expected: string | null) => {
    if ((active?.id ?? null) !== expected) throw new Error('当前会话已变化，请重试。')
  }
  const end = (session: Session, reason: string) => {
    const task = requireTask(session.taskId)
    session.status = 'ended'
    session.endedAt = now
    session.goalAtEnd = task.card.goal
    session.reason = reason
    task.updatedAt = now
  }
  const create = (title: string, docId: string | null): Task => {
    if (docId) requireDocument(docId)
    const task: Task = {
      id: randomUUID(), title, kind: docId ? 'reading' : 'general', status: 'open',
      docId, card: { ...emptyCard }, updatedAt: now, conclusion: ''
    }
    state.tasks.push(task)
    return task
  }
  const start = (task: Task, expected: string | null, planMinutes: number) => {
    if (task.status !== 'open') throw new Error('请先重新打开该任务。')
    if (active?.taskId === task.id) return task.id
    checkExpected(expected)
    if (active) end(active, 'switch')
    task.updatedAt = now
    state.sessions.push({
      id: randomUUID(), taskId: task.id, status: 'working', startedAt: now, checkpointAt: now,
      endedAt: null, goalAtStart: task.card.goal, goalAtEnd: '', result: '', outcome: '',
      reason: '', planMinutes, restMinutes: 0, planNotified: false, restNotified: false,
      segments: [{ kind: 'work', start: now, duration: 0 }], thoughts: []
    })
    return task.id
  }
  switch (command.type) {
    case 'create': {
      if (command.start) checkExpected(command.expected)
      const existing = command.docId && state.tasks.find(task => task.docId === command.docId && task.status === 'open')
      const task = existing || create(command.title, command.docId)
      return command.start ? start(task, command.expected, command.planMinutes) : task.id
    }
    case 'start':
      return start(requireTask(command.taskId), command.expected, command.planMinutes)
    case 'pause':
    case 'rest':
    case 'resume':
    case 'end': {
      if (active?.id !== command.sessionId) return
      if (command.type === 'pause') pause(state, 'manual')
      if (command.type === 'resume' && active.status !== 'working') {
        active.status = 'working'
        active.reason = ''
        active.checkpointAt = now
        active.segments.push({ kind: 'work', start: now, duration: 0 })
      }
      if (command.type === 'rest' && active.status !== 'resting') {
        active.status = 'resting'
        active.checkpointAt = now
        active.restMinutes = command.minutes
        active.restNotified = false
        active.segments.push({ kind: 'rest', start: now, duration: 0 })
      }
      if (command.type === 'end') {
        active.outcome = command.outcome
        active.result = command.result
        if (command.next !== undefined) requireTask(active.taskId).card.next = command.next
        end(active, 'manual')
      }
      return
    }
    case 'edit': {
      const task = requireTask(command.taskId)
      if (task.status === 'archived') throw new Error('请先恢复归档任务。')
      Object.assign(task.card, command.card)
      if (command.conclusion !== undefined) task.conclusion = command.conclusion
      task.updatedAt = now
      return
    }
    case 'status': {
      const task = requireTask(command.taskId)
      checkExpected(command.expected)
      if (active?.taskId === task.id && command.status !== 'open') end(active, command.status)
      task.status = command.status
      task.updatedAt = now
      return
    }
    case 'position':
      requireDocument(command.docId).position = command.position
      return
    case 'note':
      requireDocument(command.docId)
      state.notes.push({ id: randomUUID(), docId: command.docId, position: command.position,
        text: command.text, source: 'user', createdAt: now })
      return
    case 'deleteDocument': {
      requireDocument(command.docId)
      state.documents = state.documents.filter(doc => doc.id !== command.docId)
      state.notes = state.notes.filter(note => note.docId !== command.docId)
      for (const task of state.tasks.filter(task => task.docId === command.docId)) {
        if (active?.taskId === task.id) end(active, 'document-deleted')
        task.docId = null
      }
      return
    }
    case 'thought':
      if (active?.id !== command.sessionId) throw new Error('本次会话已结束。')
      active.thoughts.push({ id: randomUUID(), text: command.text, at: now, handled: false })
      return
    case 'handleThought': {
      const thought = state.sessions.find(session => session.id === command.sessionId)
        ?.thoughts.find(item => item.id === command.thoughtId)
      if (!thought || thought.handled) return
      if (command.createTask) create(thought.text.slice(0, 200), null)
      thought.handled = true
      return
    }
    case 'settings':
      Object.assign(state.settings, command.settings)
  }
}
