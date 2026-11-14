import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, net, protocol, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { applyCommand, elapsed, pause, reminders } from './core'
import { Store, fileHash, inspectBackup } from './store'
import { complete, completionUrl } from './ai'
import { activeSession, commandSchema, format, freshState, importLimit, position, type Document, type State } from './shared/model'
import type { AiResult, ImportDraft, Reply, Snapshot, WindowKind } from './shared/bridge'

const releaseUrl = 'https://github.com/XiaoZheBrother/focus-resume/releases'
const rendererUrl = 'focus-app://workspace/index.html'
protocol.registerSchemesAsPrivileged([{ scheme: 'focus-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true
} }])
function registerAssets() {
  protocol.handle('focus-app', request => {
    const url = new URL(request.url)
    const file = url.pathname.slice(1)
    const allowed = /^(?:index\.html|app\.(?:js|css)|pdf\.worker\.min\.mjs|(?:cmaps|standard_fonts|wasm)\/[a-z0-9_.-]+)$/i
    if (url.hostname !== 'workspace' || !allowed.test(file)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(path.join(__dirname, file)).href)
  })
}
const windows = new Map<WindowKind, BrowserWindow>()
let tray: Tray | undefined
let store: Store
let state: State
let secretPath: string
let revision = 0
let generation = 0
let lastTick = performance.now()
let quitting = false
let restoring = false
let issue = ''
let interval: NodeJS.Timeout
let request: AbortController | undefined
let readingImport: AbortController | undefined
let staged: { ticket: string; doc: Document; bytes: Uint8Array } | undefined
const responses = new Map<string, { result: AiResult; next: string | undefined; generation: number }>()
const notices: Notification[] = []

const canStoreSecret = () => safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
const hasSecret = () => {
  try { return canStoreSecret() && !!readFileSync(secretPath).length } catch { return false }
}
const snapshot = (): Snapshot => ({ state, revision, issue, secretReady: hasSecret(), restoring })
const eachWindow = (channel: string, data: unknown) => {
  for (const win of windows.values()) if (!win.isDestroyed()) win.webContents.send(channel, data)
}
const publish = () => eachWindow('focus:changed', snapshot())
function notice(message: string, system = false) {
  eachWindow('focus:notice', message)
  if (system && state.settings.notifications && Notification.isSupported()) {
    const notification = new Notification({ title: 'Focus Resume', body: message, silent: !state.settings.sound })
    notices.push(notification)
    if (notices.length > 5) notices.shift()?.close()
    notification.show()
  }
}
function update<T>(mutate: (draft: State, now: number) => T, add?: { doc: Document; bytes: Uint8Array }, remove?: string) {
  if (restoring) throw new Error('正在恢复数据，请稍候。')
  const draft = structuredClone(state)
  const now = Date.now()
  const tick = performance.now()
  elapsed(draft, now, tick - lastTick)
  const value = mutate(draft, now)
  const messages = reminders(draft)
  store.save(draft, add, remove)
  state = draft
  lastTick = tick
  revision += 1
  publish()
  for (const message of messages) notice(message, true)
  return value
}
function systemPause(reason: string) {
  if (restoring || !activeSession(state) || activeSession(state)?.status === 'paused') return
  try { update(draft => pause(draft, reason)) }
  catch { notice('本地保存失败，请检查存储空间。') }
}

function createWindow(kind: WindowKind) {
  const existing = windows.get(kind)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    title: kind === 'main' ? 'Focus Resume' : kind === 'panel' ? 'Focus Resume · 当前任务' : 'Focus Resume · 随手记',
    width: kind === 'main' ? 1200 : 425,
    height: kind === 'main' ? 860 : kind === 'panel' ? 355 : 280,
    minWidth: kind === 'main' ? 720 : 320, minHeight: kind === 'main' ? 550 : 215,
    autoHideMenuBar: true, show: false,
    alwaysOnTop: kind === 'capture' || (kind === 'panel' && state.settings.panelTop),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181c19' : '#f3f1eb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, devTools: !app.isPackaged
    }
  })
  windows.set(kind, win)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.once('ready-to-show', () => win.show())
  win.on('close', event => {
    if (kind !== 'main' || quitting || !tray) return
    event.preventDefault()
    if (!state.settings.trayExplained) {
      void dialog.showMessageBox(win, {
        type: 'info', message: '关窗后仍在后台运行',
        detail: '当前任务会继续计时。通过托盘重新打开，或选择退出应用。'
      }).then(() => {
        try { update(draft => { draft.settings.trayExplained = true }) } catch { /* show again next time */ }
        if (!win.isDestroyed()) win.hide()
      })
      return
    }
    win.hide()
  })
  win.on('closed', () => windows.delete(kind))
  void win.loadURL(rendererUrl + '#' + kind)
  return win
}

function configureDesktop() {
  nativeTheme.themeSource = state.settings.theme
  windows.get('panel')?.setAlwaysOnTop(state.settings.panelTop)
  globalShortcut.unregisterAll()
  issue = ''
  try {
    if (state.settings.shortcut && !globalShortcut.register(state.settings.shortcut, () => {
      if (!activeSession(state)) createWindow('main')
      else createWindow('capture')
    })) issue = '全局快捷键已被占用，可以在设置里更换。'
  } catch {
    issue = '全局快捷键格式无效，可以在设置里更换。'
  }
  publish()
}

function handle<T>(name: string, handler: (win: BrowserWindow, ...args: unknown[]) => T | Promise<T>) {
  ipcMain.handle('focus:' + name, async (event, ...args): Promise<Reply<T>> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || ![...windows.values()].includes(win) ||
        !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url.split('#')[0] !== rendererUrl) return { ok: false, error: '无效的窗口请求。' }
    try { return { ok: true, value: await handler(win, ...args) } }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      const friendly = /[\u3400-\u9fff]/u.test(message) && !(error instanceof z.ZodError)
      return { ok: false, error: friendly ? message : '操作失败，请检查文件、输入或可用存储空间后重试。' }
    }
  })
}

function clearSecret() { rmSync(secretPath, { force: true }) }
function commitReplacement(replacement: State, source?: ReturnType<typeof inspectBackup>['source']) {
  pause(replacement, 'restored')
  replacement.settings.aiEnabled = false
  store.restore(replacement, source)
  state = replacement
  revision += 1
  lastTick = performance.now()
  generation += 1
  responses.clear()
  try { clearSecret() } catch { notice('旧模型凭据未删除，请在设置中手动移除。') }
}
function startReplacement() {
  if (restoring) throw new Error('另一项恢复操作正在进行。')
  systemPause('restore')
  request?.abort()
  readingImport?.abort()
  staged = undefined
  restoring = true
  publish()
}
const aiDraftSchema = z.object({
  kind: z.enum(['explain', 'suggest']), taskId: z.uuid().nullable(),
  docId: z.uuid().nullable(), position: position.nullable(), input: z.string().trim().min(1).max(6000)
})
function registerIpc() {
  handle('state', snapshot)
  handle('version', () => app.getVersion())
  handle('checkUpdate', async () => {
    try {
      const response = await fetch('https://api.github.com/repos/XiaoZheBrother/focus-resume/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Focus-Resume' },
        signal: AbortSignal.timeout(8000), redirect: 'error'
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error()
      const body = await response.json()
      return z.string().max(60).parse(body.tag_name)
    } catch { throw new Error('无法检查更新。可以打开 Releases 手动查看。') }
  })
  handle('command', (_win, raw) => {
    const command = commandSchema.parse(raw)
    if (command.type === 'settings' && command.settings.endpoint) completionUrl(command.settings.endpoint)
    const result = update((draft, now) => applyCommand(draft, command, now), undefined,
      command.type === 'deleteDocument' ? command.docId : undefined)
    if (command.type === 'settings') configureDesktop()
    return result
  })
  handle('stageImport', async (win): Promise<ImportDraft | null> => {
    if (restoring || readingImport || staged) throw new Error('已有导入或恢复操作进行中。')
    const token = new AbortController()
    readingImport = token
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '导入文档', properties: ['openFile'], filters: [{ name: '阅读文档', extensions: ['pdf', 'md', 'markdown', 'txt'] }]
      })
      if (result.canceled || token.signal.aborted) return null
      const file = result.filePaths[0]
      const extension = path.extname(file).slice(1).toLowerCase()
      const kind = format.safeParse(extension === 'markdown' ? 'md' : extension)
      if (!kind.success) throw new Error('请选择 PDF、Markdown 或 TXT 文件。')
      const input = await open(file, 'r')
      let bytes: Buffer
      try {
        const stat = await input.stat()
        if (!stat.isFile() || stat.size === 0) throw new Error('请选择有内容的本地文件。')
        if (stat.size > importLimit(kind.data)) throw new Error(kind.data === 'pdf' ? 'PDF 不可超过 50 MiB。' : '文本文档不可超过 2 MiB。')
        const buffer = Buffer.alloc(stat.size + 1)
        const { bytesRead } = await input.read(buffer, 0, buffer.length, 0)
        if (bytesRead !== stat.size) throw new Error('文件在读取时发生变化，请重新导入。')
        bytes = buffer.subarray(0, bytesRead)
      } finally { await input.close() }
      if (token.signal.aborted || restoring) return null
      if (kind.data === 'pdf') {
        if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件没有有效的 PDF 文件头。')
      } else {
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (!decoded.trim() || decoded.includes('\0')) throw new Error()
        } catch { throw new Error('文档为空或编码不受支持，请保存为 UTF-8。') }
      }
      const hash = fileHash(bytes)
      const existing = state.documents.find(doc => doc.hash === hash && doc.format === kind.data)
      if (existing) return { existing }
      const doc: Document = {
        id: randomUUID(), name: path.basename(file).slice(0, 255), format: kind.data, hash, size: bytes.length,
        position: { index: 0, offset: 0 }, createdAt: Date.now()
      }
      staged = { ticket: randomUUID(), doc, bytes }
      return staged
    } finally { readingImport = undefined }
  })
  handle('finishImport', (_win, ticket) => {
    if (!staged || staged.ticket !== ticket) throw new Error('导入已取消，请重新选择文件。')
    const { doc, bytes } = staged
    update(draft => { draft.documents.push(doc) }, { doc, bytes })
    staged = undefined
    return doc
  })
  handle('cancelImport', () => { readingImport?.abort(); staged = undefined })
  handle('document', (_win, id) => {
    const docId = z.uuid().parse(id)
    if (!state.documents.some(doc => doc.id === docId)) throw new Error('文档已移除。')
    return store.bytes(docId)
  })
  handle('backup', async win => {
    const result = await dialog.showSaveDialog(win, {
      title: '导出完整备份', defaultPath: 'focus-resume-' + new Date().toISOString().slice(0, 10) + '.focusbackup',
      filters: [{ name: 'Focus Resume 备份', extensions: ['focusbackup'] }]
    })
    if (result.canceled || !result.filePath) return false
    const target = result.filePath
    if (!target.toLowerCase().endsWith('.focusbackup') || path.resolve(target) === path.resolve(store.path)) {
      throw new Error('请选择 .focusbackup 备份文件路径。')
    }
    const temporary = target + '.tmp-' + randomUUID()
    try {
      update(() => undefined)
      store.backup(temporary)
      const { rename } = await import('node:fs/promises')
      await rename(temporary, target)
      return true
    } finally { rmSync(temporary, { force: true }) }
  })
  handle('restore', async win => {
    const selected = await dialog.showOpenDialog(win, {
      title: '选择完整备份', properties: ['openFile'], filters: [{ name: 'Focus Resume 备份', extensions: ['focusbackup'] }]
    })
    if (selected.canceled) return false
    startReplacement()
    let backup: ReturnType<typeof inspectBackup> | undefined
    try {
      const source = selected.filePaths[0]
      if (path.resolve(source) === path.resolve(store.path)) throw new Error('请选择导出的备份文件。')
      backup = inspectBackup(source)
      const incoming = backup.state
      const entered = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['取消', '备份并恢复'], defaultId: 0, cancelId: 0,
        message: '恢复会替换当前数据',
        detail: `将恢复 ${incoming.tasks.length} 个任务、${incoming.sessions.length} 次会话和 ${incoming.documents.length} 份文档。现有数据会先备份到应用数据目录。`
      })
      if (entered.response !== 1) return false
      const recovery = path.join(app.getPath('userData'), 'before-restore-' + randomUUID() + '.focusbackup')
      store.backup(recovery)
      commitReplacement(incoming, backup.source)
      notice('恢复完成。恢复前的备份已保存在应用数据目录。')
      return true
    } finally {
      backup?.source.close()
      restoring = false
      configureDesktop()
    }
  })
  handle('clear', async win => {
    const result = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['取消', '备份并清空'], defaultId: 0, cancelId: 0,
      message: '清空应用中的所有数据', detail: '任务、文档副本、笔记、历史与设置会被清空。原文档保留，清空前会生成本地备份。'
    })
    if (result.response !== 1) return false
    startReplacement()
    try {
      store.backup(path.join(app.getPath('userData'), 'before-clear-' + randomUUID() + '.focusbackup'))
      commitReplacement(freshState())
      return true
    } finally {
      restoring = false
      configureDesktop()
    }
  })
  handle('secret', (_win, raw) => {
    if (restoring || request) throw new Error('请等待当前操作结束。')
    const key = z.string().max(600).trim().parse(raw)
    if (!key) clearSecret()
    else {
      if (!canStoreSecret()) throw new Error('当前系统没有可用的安全凭据存储。')
      const temporary = secretPath + '.new'
      try {
        writeFileSync(temporary, safeStorage.encryptString(key), { mode: 0o600 })
        renameSync(temporary, secretPath)
      } finally { rmSync(temporary, { force: true }) }
    }
    publish()
  })
  handle('ai', async (_win, raw) => {
    if (restoring || request) throw new Error('已有 AI 请求或恢复操作。')
    const draft = aiDraftSchema.parse(raw)
    const { aiEnabled, endpoint, model } = state.settings
    if (!aiEnabled || !endpoint || !model.trim()) throw new Error('请前往设置启用 AI 并配置模型。')
    if (completionUrl(endpoint).hostname === 'api.deepseek.com' && !hasSecret()) throw new Error('请在设置里保存 DeepSeek API Key。')
    const task = state.tasks.find(item => item.id === draft.taskId && item.status === 'open')
    if (draft.kind === 'suggest' && !task) throw new Error('原任务已不可用。')
    if (draft.kind === 'explain' && (!draft.position || !state.documents.some(item => item.id === draft.docId))) {
      throw new Error('原文位置已不可用。')
    }
    const token = new AbortController()
    const startGeneration = generation
    request = token
    try {
      const key = hasSecret() ? safeStorage.decryptString(readFileSync(secretPath)) : undefined
      const result = await complete(endpoint, model, key, draft.kind, draft.input, token.signal)
      if (token.signal.aborted || startGeneration !== generation) throw new Error('已取消 AI 请求。')
      const answer: AiResult = { id: randomUUID(), draft, result }
      responses.set(answer.id, { result: answer, next: task?.card.next, generation })
      if (responses.size > 20) responses.delete(responses.keys().next().value!)
      return answer
    } finally { if (request === token) request = undefined }
  })
  handle('copy', (_win, value) => clipboard.writeText(z.string().max(6000).parse(value)))
  handle('cancelAi', () => { request?.abort() })
  handle('adoptAi', (_win, raw, item, edit) => {
    const saved = responses.get(z.uuid().parse(raw))
    const index = z.number().int().min(0).max(2).parse(item)
    if (!saved || saved.generation !== generation) throw new Error('该 AI 结果已不可采用。')
    const { draft, result } = saved.result
    if (!result[index]) throw new Error('找不到该结果。')
    const text = edit === undefined ? result[index] : z.string().trim().min(1).max(6000).parse(edit)
    update((next, now) => {
      const task = next.tasks.find(task => task.id === draft.taskId)
      if (draft.taskId && task?.status !== 'open') throw new Error('原任务已不可采用 AI 结果。')
      if (draft.kind === 'suggest' && task) {
        if (task.card.next !== saved.next) throw new Error('原任务的下一步已修改，可复制建议后手动编辑。')
        applyCommand(next, { type: 'edit', taskId: task.id, card: { next: text } }, now)
      } else if (draft.docId && draft.position && next.documents.some(doc => doc.id === draft.docId)) {
        next.notes.push({ id: randomUUID(), docId: draft.docId, position: draft.position, text, source: 'ai', createdAt: now })
      } else throw new Error('原文已移除。')
    })
    responses.delete(saved.result.id)
  })
  handle('desktop', (win, action) => {
    switch (action) {
      case 'panel': createWindow('panel'); return
      case 'capture': createWindow('capture'); return
      case 'main': createWindow('main'); return
      case 'close': win.close(); return
      case 'quit': app.quit(); return
      case 'releases': void shell.openExternal(releaseUrl); return
      default: throw new Error('无效的桌面操作。')
    }
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (state) createWindow('main') })
  app.on('activate', () => { if (state) createWindow('main') })
  app.on('window-all-closed', () => { if (!tray && process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => {
    quitting = true
    if (state) systemPause('quit')
    request?.abort()
  })
  app.on('will-quit', () => {
    clearInterval(interval)
    globalShortcut.unregisterAll()
    store?.close()
  })
  void app.whenReady().then(() => {
    try {
      const directory = app.getPath('userData')
      mkdirSync(directory, { recursive: true })
      const dataPath = path.join(directory, 'focus.sqlite')
      secretPath = path.join(directory, 'model.key')
      store = new Store(dataPath)
      state = store.read()
      if (activeSession(state)?.status !== 'paused' && activeSession(state)) {
        pause(state, 'recovered')
        store.save(state)
      }
      registerAssets()
      registerIpc()
      configureDesktop()
      createWindow('main')
      try {
        tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
        tray.setToolTip('Focus Resume')
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '打开 Focus Resume', click: () => createWindow('main') },
          { label: '打开轻量面板', click: () => createWindow('panel') },
          { label: '随手记', click: () => createWindow('capture') },
          { label: '退出', click: () => app.quit() }
        ]))
        tray.on('click', () => createWindow('main'))
      } catch { issue = '系统托盘暂不可用，关闭主窗口将退出应用。'; publish() }
      powerMonitor.on('suspend', () => systemPause('suspend'))
      powerMonitor.on('resume', () => systemPause('suspend'))
      powerMonitor.on('lock-screen', () => systemPause('lock'))
      powerMonitor.on('shutdown', () => systemPause('shutdown'))
      lastTick = performance.now()
      interval = setInterval(() => {
        const status = activeSession(state)?.status
        if (!restoring && (status === 'working' || status === 'resting')) {
          try { update(() => undefined) } catch { notice('本地保存失败，请检查存储空间。') }
        }
      }, 2500)
    } catch {
      dialog.showErrorBox('无法打开 Focus Resume 数据', '原数据保留在应用数据目录。请检查数据版本、文件权限和磁盘空间。')
      app.quit()
    }
  })
}
