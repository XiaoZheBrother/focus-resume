import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyCommand, elapsed, pause } from '../src/core'
import { Store, fileHash, inspectBackup } from '../src/store'
import { activeSession, freshState, workMs, type Document } from '../src/shared/model'

test('managed files and active session checkpoints survive reopening and a backup round trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'focus-test-'))
  const mainPath = join(root, 'main.sqlite')
  const backupPath = join(root, 'backup.focusbackup')
  const bytes = Buffer.from('This is a test document.')
  const doc: Document = { id: randomUUID(), name: 'sample.txt', size: bytes.length, hash: fileHash(bytes), format: 'txt',
    createdAt: 1, position: { index: 0, offset: .25 } }
  const state = freshState()
  state.documents.push(doc)
  applyCommand(state, { type: 'create', title: 'Read', docId: doc.id, start: true, planMinutes: 0, expected: null }, 1)
  applyCommand(state, { type: 'note', docId: doc.id, position: doc.position, text: 'Takeaway' }, 1)
  elapsed(state, 2501, 2500)
  state.settings.aiEnabled = true
  let store = new Store(mainPath)
  const clean = new Store(join(root, 'clean.sqlite'))
  try {
    store.save(state, { doc, bytes })
    store.backup(backupPath)
    store.close()
    store = new Store(mainPath)
    assert.equal(workMs(activeSession(store.read())), 2500)
    const validated = inspectBackup(backupPath)
    try {
      pause(validated.state, 'restored')
      clean.restore(validated.state, validated.source)
    } finally { validated.source.close() }
    assert.equal(activeSession(clean.read())?.status, 'paused')
    assert.equal(clean.read().settings.aiEnabled, false)
    assert.deepEqual(clean.read().documents[0].position, doc.position)
    assert.equal(clean.read().notes[0].text, 'Takeaway')
    assert.equal(fileHash(clean.bytes(doc.id)), doc.hash)
    applyCommand(state, { type: 'deleteDocument', docId: doc.id }, 5000)
    store.save(state, undefined, doc.id)
    assert.equal(store.read().tasks[0].docId, null)
    assert.equal(store.read().sessions[0].status, 'ended')
    assert.throws(() => store.bytes(doc.id))
  } finally { store.close(); clean.close(); rmSync(root, { recursive: true, force: true }) }
})

test('corrupt backup bytes roll back even when a valid snapshot was already loaded', () => {
  const root = mkdtempSync(join(tmpdir(), 'focus-test-'))
  const local = new Store(join(root, 'local.sqlite'))
  const source = new Store(join(root, 'source.sqlite'))
  const path = join(root, 'backup.focusbackup')
  const state = freshState()
  applyCommand(state, { type: 'create', title: 'Keep me', docId: null, expected: null, start: false, planMinutes: 0 }, 1)
  const bytes = Buffer.from('original')
  const doc: Document = { id: randomUUID(), name: 'note.txt', size: bytes.length, hash: fileHash(bytes), format: 'txt',
    position: { index: 0, offset: 0 }, createdAt: 1 }
  const incoming = freshState()
  incoming.documents.push(doc)
  try {
    local.save(state)
    source.save(incoming, { doc, bytes })
    source.backup(path)
    const checked = inspectBackup(path)
    const tamper = new DatabaseSync(path)
    tamper.prepare('UPDATE documents SET bytes = ?').run(Buffer.from('corrupt!'))
    tamper.close()
    try { assert.throws(() => local.restore(checked.state, checked.source), /备份中的文档/) }
    finally { checked.source.close() }
    assert.throws(() => inspectBackup(path), /损坏/)
    assert.equal(local.read().tasks[0].title, 'Keep me')
  } finally { local.close(); source.close(); rmSync(root, { recursive: true, force: true }) }
})
