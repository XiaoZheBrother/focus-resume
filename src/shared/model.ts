import { z } from 'zod'

const id = z.uuid()
const timestamp = z.number().int().nonnegative()
const text = z.string().max(6000)
const minutes = z.number().int().min(0).max(240)
export const position = z.object({ index: z.number().int().min(0).max(2_000_000), offset: z.number().min(0).max(1) })
export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  fontSize: z.number().int().min(14).max(28),
  lineHeight: z.number().min(1.4).max(2.4),
  readingWidth: z.number().int().min(440).max(920),
  focus: z.boolean(), notifications: z.boolean(), sound: z.boolean(),
  shortcut: z.string().max(60), panelTop: z.boolean(), trayExplained: z.boolean(),
  aiEnabled: z.boolean(), endpoint: z.string().max(400), model: z.string().max(100)
})
export const defaults = settingsSchema.parse({
  theme: 'system', fontSize: 18, lineHeight: 1.8, readingWidth: 680, focus: false,
  notifications: false, sound: false, shortcut: 'CommandOrControl+Shift+Space',
  panelTop: true, trayExplained: false, aiEnabled: false,
  endpoint: 'https://api.deepseek.com', model: 'deepseek-chat'
})
export const cardSchema = z.object({ goal: text, next: text, progress: text, blocker: text })
export type Card = z.infer<typeof cardSchema>
export const emptyCard: Card = { goal: '', next: '', progress: '', blocker: '' }
export const format = z.enum(['pdf', 'md', 'txt'])
export const documentSchema = z.object({
  id, name: z.string().min(1).max(255), format, hash: z.hash('sha256'), size: z.number().int().positive(),
  createdAt: timestamp, position
})
export const noteSchema = z.object({
  id, docId: id, position, text, source: z.enum(['user', 'ai']), createdAt: timestamp
})
export const taskSchema = z.object({
  id, title: z.string().trim().min(1).max(200), kind: z.enum(['general', 'reading']),
  status: z.enum(['open', 'done', 'archived']), docId: id.nullable(),
  card: cardSchema, updatedAt: timestamp, conclusion: text
})
const segmentSchema = z.object({
  kind: z.enum(['work', 'rest']), start: timestamp, duration: timestamp
})
export const sessionSchema = z.object({
  id, taskId: id, status: z.enum(['working', 'paused', 'resting', 'ended']),
  startedAt: timestamp, checkpointAt: timestamp, endedAt: timestamp.nullable(),
  goalAtStart: text, goalAtEnd: text, result: text,
  outcome: z.enum(['', 'done', 'partial', 'unmet']), reason: z.string().max(40),
  planMinutes: minutes, restMinutes: minutes, planNotified: z.boolean(), restNotified: z.boolean(),
  segments: z.array(segmentSchema),
  thoughts: z.array(z.object({ id, text, at: timestamp, handled: z.boolean() }))
})
export const stateSchema = z.object({
  version: z.literal(1), settings: settingsSchema, tasks: z.array(taskSchema),
  documents: z.array(documentSchema), notes: z.array(noteSchema), sessions: z.array(sessionSchema)
})
export type State = z.infer<typeof stateSchema>
export type Task = z.infer<typeof taskSchema>
export type Session = z.infer<typeof sessionSchema>
export type Document = z.infer<typeof documentSchema>
export type Position = z.infer<typeof position>
export type Settings = z.infer<typeof settingsSchema>
export type Outcome = Session['outcome']
export const freshState = (): State => ({
  version: 1, settings: { ...defaults }, tasks: [], documents: [], notes: [], sessions: []
})
export const activeSession = (state: State) => state.sessions.find(session => session.status !== 'ended')
export const workMs = (session?: Session) => session?.segments.reduce(
  (duration, segment) => duration + (segment.kind === 'work' ? segment.duration : 0), 0
) ?? 0
export const recentTasks = (state: State) => [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt)
export const importLimit = (kind: Document['format']) => (kind === 'pdf' ? 50 : 2) * 1024 * 1024

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), title: taskSchema.shape.title, docId: id.nullable(), start: z.boolean(), expected: id.nullable(), planMinutes: minutes }),
  z.object({ type: z.literal('start'), taskId: id, expected: id.nullable(), planMinutes: minutes }),
  z.object({ type: z.literal('pause'), sessionId: id }),
  z.object({ type: z.literal('resume'), sessionId: id }),
  z.object({ type: z.literal('rest'), sessionId: id, minutes }),
  z.object({ type: z.literal('end'), sessionId: id, outcome: sessionSchema.shape.outcome, result: text, next: text.optional() }),
  z.object({ type: z.literal('edit'), taskId: id, card: cardSchema.partial(), conclusion: text.optional() }),
  z.object({ type: z.literal('status'), taskId: id, status: taskSchema.shape.status, expected: id.nullable() }),
  z.object({ type: z.literal('position'), docId: id, position }),
  z.object({ type: z.literal('note'), docId: id, position, text: text.trim().min(1) }),
  z.object({ type: z.literal('thought'), sessionId: id, text: text.trim().min(1) }),
  z.object({ type: z.literal('handleThought'), sessionId: id, thoughtId: id, createTask: z.boolean() }),
  z.object({ type: z.literal('deleteDocument'), docId: id }),
  z.object({ type: z.literal('settings'), settings: settingsSchema.partial() })
])
export type Command = z.infer<typeof commandSchema>
