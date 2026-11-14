import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync } from 'node:fs'
import { importLimit, freshState, parseState, type Document, type State } from './shared/model'

export const fileHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const initialize = `
  CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  PRAGMA user_version = 2;
`

export class Store {
  private db: DatabaseSync
  constructor(readonly path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;')
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version === 0) this.db.exec(initialize)
    else if (version === 1) {
      try {
        const state = this.read()
        this.backup(path + '.v1-' + randomUUID() + '.focusbackup')
        this.transaction(() => {
          this.db.prepare('INSERT OR REPLACE INTO snapshot (id, json) VALUES (1, ?)').run(JSON.stringify(state))
          this.db.exec('PRAGMA user_version = 2')
        })
      } catch (error) {
        this.db.close()
        throw error
      }
    } else if (version !== 2) {
      this.db.close()
      copyFileSync(path, path + '.recovery')
      throw new Error('数据版本不受支持，已保存恢复副本。')
    }
  }

  read(): State {
    const row = this.db.prepare('SELECT json FROM snapshot WHERE id = 1').get()
    return row ? parseState(JSON.parse(String(row.json))) : freshState()
  }

  bytes(id: string): Uint8Array {
    const row = this.db.prepare('SELECT bytes FROM documents WHERE id = ?').get(id)
    if (!(row?.bytes instanceof Uint8Array)) throw new Error('找不到已导入的文档。')
    return row.bytes
  }

  save(state: State, add?: { doc: Document; bytes: Uint8Array }, remove?: string) {
    const json = JSON.stringify(state)
    this.transaction(() => {
      if (add) this.db.prepare('INSERT INTO documents (id, bytes) VALUES (?, ?)').run(add.doc.id, add.bytes)
      if (remove) this.db.prepare('DELETE FROM documents WHERE id = ?').run(remove)
      this.db.prepare('INSERT OR REPLACE INTO snapshot (id, json) VALUES (1, ?)').run(json)
    })
  }

  backup(path: string) {
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  restore(state: State, source?: DatabaseSync) {
    const json = JSON.stringify(state)
    this.transaction(() => {
      this.db.exec('DELETE FROM documents')
      const read = source?.prepare('SELECT bytes FROM documents WHERE id = ?')
      const insert = this.db.prepare('INSERT INTO documents (id, bytes) VALUES (?, ?)')
      for (const doc of state.documents) {
        const bytes = read?.get(doc.id)?.bytes
        if (!(bytes instanceof Uint8Array) || bytes.length !== doc.size || fileHash(bytes) !== doc.hash) {
          throw new Error('备份中的文档缺失或损坏。')
        }
        insert.run(doc.id, bytes)
      }
      this.db.prepare('INSERT OR REPLACE INTO snapshot (id, json) VALUES (1, ?)').run(json)
    })
  }

  close() { this.db.close() }

  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

export function inspectBackup(path: string) {
  const source = new DatabaseSync(path, { readOnly: true })
  try {
    source.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;')
    const version = source.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 1 && version !== 2) throw new Error('备份版本不受支持。')
    const tables = source.prepare("SELECT name, type FROM sqlite_schema WHERE name IN ('snapshot','documents')").all()
    if (tables.length !== 2 || tables.some(table => table.type !== 'table')) throw new Error('备份结构无效。')
    const raw = source.prepare('SELECT CASE WHEN length(json) <= 20000000 THEN json END AS json FROM snapshot WHERE id = 1').get()
    if (raw && typeof raw.json !== 'string') throw new Error('备份记录超过可恢复大小。')
    const state = raw ? parseState(JSON.parse(String(raw.json))) : freshState()
    const docs = new Set(state.documents.map(doc => doc.id))
    const tasks = new Set(state.tasks.map(task => task.id))
    const metadata = source.prepare('SELECT id, length(bytes) AS size FROM documents').all()
    if (metadata.length !== docs.size || docs.size !== state.documents.length ||
        tasks.size !== state.tasks.length ||
        new Set(state.sessions.map(session => session.id)).size !== state.sessions.length ||
        state.sessions.filter(session => session.status !== 'ended').length > 1 ||
        state.sessions.some(session => !tasks.has(session.taskId) ||
          (session.status !== 'ended' && state.tasks.find(task => task.id === session.taskId)?.status !== 'open')) ||
        state.tasks.some(task => task.docId && !docs.has(task.docId)) ||
        state.notes.some(note => !docs.has(note.docId)) ||
        state.studyCards.some(card => !docs.has(card.docId)) ||
        new Set(state.studyCards.map(card => card.id)).size !== state.studyCards.length ||
        new Set(state.inbox.map(thought => thought.id)).size !== state.inbox.length) throw new Error('备份记录不完整。')
    const lengths = new Map(metadata.map(row => [row.id, row.size]))
    const read = source.prepare('SELECT bytes FROM documents WHERE id = ?')
    for (const doc of state.documents) {
      if (doc.size > importLimit(doc.format) || lengths.get(doc.id) !== doc.size) throw new Error('备份文档大小有误。')
      const bytes = read.get(doc.id)?.bytes
      if (!(bytes instanceof Uint8Array) || fileHash(bytes) !== doc.hash) throw new Error('备份中的文档损坏。')
    }
    state.settings.aiEnabled = false
    return { source, state }
  } catch (error) {
    source.close()
    throw error
  }
}
