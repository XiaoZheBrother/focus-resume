import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowRight, BookOpen, Brain, Check, ChevronRight, Coffee, Download, FileText, History, Inbox,
  Home, ListTodo, Maximize2, PanelTop, Pause, Pin, Play, RotateCcw, Settings as SettingsIcon,
  Sparkles, Square, StickyNote, Timer, Upload, X
} from 'lucide-react'
import { activeSession, recentTasks, workMs, type Card, type Command, type Document, type Outcome, type Position, type Session, type Settings, type State, type StudyCard, type Task } from '../shared/model'
import type { AiDraft, AiResult, Snapshot, WindowKind } from '../shared/bridge'
import { api, dateLabel, formatDuration, unwrap } from './api'
import { Reader, validatePdf } from './reader'
import { StudyCardForm, StudyPage, type StudyDraft } from './study'
import './style.css'

type Page = 'home' | 'task' | 'reading' | 'study' | 'inbox' | 'history' | 'settings'
const phaseName = { working: '进行中', paused: '已暂停', resting: '休息中', ended: '已结束' }
const taskStatus = { open: '未完成', done: '已完成', archived: '已归档' }
const outcomeName = { '': '未记录结果', done: '达成本次目标', partial: '部分达成', unmet: '未达成' }
const pauseReason: Record<string, string> = {
  recovered: '上次应用异常退出，已恢复到最近一次保存。',
  lock: '锁屏时自动暂停，准备好后可以继续。',
  suspend: '休眠时自动暂停，准备好后可以继续。',
  quit: '退出前已保存，准备好后可以继续。',
  'clock-or-sleep': '系统时间发生变化，已暂停计时。'
}

function useSnapshot() {
  const [data, setData] = useState<Snapshot>()
  const [error, setError] = useState('')
  useEffect(() => {
    const apply = (next: Snapshot) => setData(current => !current || current.revision <= next.revision ? next : current)
    const remove = api.onState(apply)
    void unwrap(api.state()).then(apply).catch(err => setError(err.message))
    return remove
  }, [])
  return { data, error }
}
function useClock(session?: Session) {
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 400)
    return () => clearInterval(timer)
  }, [])
  const live = Math.min(3500, Math.max(0, clock - (session?.checkpointAt ?? clock)))
  const work = workMs(session) + (session?.status === 'working' ? live : 0)
  const rest = (session?.segments.at(-1)?.duration ?? 0) + (session?.status === 'resting' ? live : 0)
  return { work, rest }
}
function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => node?.close()
  }, [])
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); closeRef.current() }} className="modal" aria-label={title}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={21}/></button></div>
    {children}
  </dialog>
}
function Mark() { return <div className="brand-mark"><RotateCcw size={20} strokeWidth={2.1}/><span/></div> }

function App() {
  const kind = (location.hash.slice(1) || 'main') as WindowKind
  const { data, error } = useSnapshot()
  if (!data) return <main className="loading" role="status"><Mark/>{error || '正在打开工作台…'}</main>
  return kind === 'main' ? <Workspace key={data.workspaceVersion} data={data}/> : <Compact key={data.workspaceVersion} kind={kind} state={data.state} restoring={data.restoring}/>
}

function Workspace({ data }: { data: Snapshot }) {
  const { state } = data
  const active = activeSession(state)
  const activeTask = state.tasks.find(item => item.id === active?.taskId)
  const [page, setPage] = useState<Page>('home')
  const [taskId, setTaskId] = useState<string>()
  const [docId, setDocId] = useState<string>()
  const [jump, setJump] = useState<{ position: Position; key: number }>()
  const [studyDraft, setStudyDraft] = useState<StudyDraft>()
  const [studyClock, setStudyClock] = useState(Date.now())
  const [flash, setFlash] = useState<{ text: string; error?: boolean }>()
  const [saving, setSaving] = useState(0)
  const [actionBusy, setActionBusy] = useState(false)
  const actionLock = useRef(false)
  const [confirm, setConfirm] = useState<{ title: string; detail: string; label: string; go: () => Promise<void> }>()
  const [ending, setEnding] = useState<Session>()
  const [resting, setResting] = useState<Session>()
  const [capturing, setCapturing] = useState<{ sessionId: string | null; captureId: string }>()
  const [aiDraft, setAiDraft] = useState<AiDraft>()
  const [aiBusy, setAiBusy] = useState(false)
  const [aiAnswer, setAiAnswer] = useState<AiResult>()
  const [importing, setImporting] = useState(false)
  const [version, setVersion] = useState('')
  const importJob = useRef<AbortController | undefined>(undefined)
  const task = state.tasks.find(item => item.id === taskId)
  const doc = state.documents.find(item => item.id === docId)
  const readingTask = state.tasks.find(item => item.docId === docId && item.status === 'open')
  const ordered = recentTasks(state)
  const resume = activeTask ?? ordered.find(item => item.status === 'open')
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function announce(text: string, error = false) {
    setFlash({ text, error })
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(undefined), error ? 9000 : 5500)
  }
  useEffect(() => api.onNotice(message => announce(message)), [])
  useEffect(() => {
    if (page !== 'study') return
    setStudyClock(Date.now())
    const timer = setInterval(() => setStudyClock(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [page])
  useEffect(() => { void unwrap(api.version()).then(setVersion).catch(() => undefined) }, [])
  async function act<T>(operation: Promise<import('../shared/bridge').Reply<T>>): Promise<T> {
    setSaving(count => count + 1)
    try { return await unwrap(operation) }
    catch (error) { announce((error as Error).message, true); throw error }
    finally { setSaving(count => count - 1) }
  }
  const run = (operation: Promise<unknown>) => { void operation.catch(() => undefined) }
  const change = (command: Command) => act(api.command(command))
  const saveSettings = (settings: Partial<Settings>) => run(change({ type: 'settings', settings }))
  const navigate = (next: Page) => { setPage(next); if (next === 'task' && active?.taskId) setTaskId(active.taskId) }
  const openDoc = (item: Document, position?: Position) => {
    setJump(position ? { position, key: performance.now() } : undefined)
    setDocId(item.id); setPage('reading')
  }
  const openResume = useRef<() => void>(() => undefined)
  openResume.current = () => { if (resume) openTask(resume); else setPage('home') }
  useEffect(() => { if (data.resumeRequest) openResume.current() }, [data.resumeRequest])
  function openTask(item: Task) {
    setTaskId(item.id)
    const document = state.documents.find(doc => doc.id === item.docId)
    if (document && item.status === 'open') openDoc(document)
    else setPage('task')
  }
  async function exclusive(action: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setActionBusy(true)
    try { await action() }
    finally { actionLock.current = false; setActionBusy(false) }
  }
  function switchAnd(action: () => Promise<void>, nextTask?: string) {
    if (active && active.taskId !== nextTask) {
      setConfirm({
        title: '切换任务', label: '保存当前并切换',
        detail: '会保存并结束「' + (activeTask?.title ?? '当前任务') + '」的本次工作。原任务仍可继续。',
        go: () => exclusive(action)
      })
    } else run(exclusive(action))
  }
  function startGeneral(title: string, planMinutes: number) {
    switchAnd(async () => {
      const id = await change({ type: 'create', title, start: true, docId: null, expected: active?.id ?? null, planMinutes })
      setTaskId(id)
      setPage('task')
    })
  }
  function startTask(item: Task, planMinutes: number) {
    switchAnd(async () => {
      if (active?.taskId === item.id) {
        if (active.status !== 'working') await change({ type: 'resume', sessionId: active.id })
      } else await change({ type: 'start', taskId: item.id, expected: active?.id ?? null, planMinutes })
      openTask(item)
    }, item.id)
  }
  function startReading(document: Document, planMinutes: number) {
    if (readingTask) return startTask(readingTask, planMinutes)
    switchAnd(async () => {
      const id = await change({
        type: 'create', title: '阅读 ' + document.name.slice(0, 196), start: true, docId: document.id,
        expected: active?.id ?? null, planMinutes
      })
      setTaskId(id)
    })
  }
  async function importDocument() {
    if (importJob.current) return
    const token = new AbortController()
    importJob.current = token
    setImporting(true)
    try {
      const staged = await act(api.stageImport())
      if (!staged || token.signal.aborted) return
      if ('existing' in staged) { openDoc(staged.existing); announce('已打开内容相同的文档副本。'); return }
      if (staged.doc.format === 'pdf') await validatePdf(staged.bytes, token.signal)
      if (token.signal.aborted) return
      const imported = await act(api.finishImport(staged.ticket))
      openDoc(imported)
      announce('文档已导入。')
    } catch (error) {
      if (!token.signal.aborted) announce((error as Error).message, true)
      await api.cancelImport()
    } finally { importJob.current = undefined; setImporting(false) }
  }
  function cancelImport() { importJob.current?.abort(); run(act(api.cancelImport())) }
  function chooseStatus(item: Task, status: Task['status']) {
    const action = () => exclusive(async () => {
      await change({ type: 'status', taskId: item.id, expected: active?.id ?? null, status })
      announce(status === 'open' ? '任务已重新打开。' : status === 'done' ? '任务已完成。' : '任务已归档。')
    })
    if (active?.taskId === item.id && status !== 'open') setConfirm({
      title: status === 'done' ? '完成整个任务' : '归档任务',
      detail: '这会保存并结束本次工作。已完成的会话会保留在记录中。',
      label: status === 'done' ? '保存并完成任务' : '保存并归档', go: action
    })
    else run(action())
  }
  function askAi(draft: AiDraft) {
    if (aiBusy) return announce('已有 AI 请求在进行。')
    if (!state.settings.aiEnabled) return announce('前往设置启用 AI 并填写模型配置后，即可使用。')
    if (draft.input.length > 6000) return announce('本次内容超过 6000 个字符，请缩小选择后再试。', true)
    setAiDraft(draft)
  }
  function suggest(item: Task) {
    askAi({
      kind: 'suggest', taskId: item.id, docId: item.docId, position: null,
      input: ['任务：' + item.title, item.card.goal && '目标：' + item.card.goal, item.card.blocker && '卡点：' + item.card.blocker].filter(Boolean).join('\n')
    })
  }
  function submitAi(draft: AiDraft) {
    setAiDraft(undefined)
    setAiBusy(true)
    void unwrap(api.ai(draft)).then(setAiAnswer).catch(error => announce(error.message, true)).finally(() => setAiBusy(false))
  }
  const taskActions = { startTask, chooseStatus, suggest, pause: (sessionId: string) => run(change({ type: 'pause', sessionId })),
    end: setEnding, rest: setResting, capture: (session?: Session) => setCapturing({ sessionId: session?.id ?? null, captureId: crypto.randomUUID() }), panel: () => run(act(api.desktop('panel'))) }
  const clock = useClock(active)
  const nav = [
    { page: 'home', icon: Home, text: '开始与继续' }, { page: 'task', icon: ListTodo, text: '当前任务' },
    { page: 'reading', icon: BookOpen, text: '阅读工作区' },
    { page: 'study', icon: Brain, text: '阅读复习' }, { page: 'inbox', icon: Inbox, text: '随手记收件箱' },
    { page: 'history', icon: History, text: '任务与记录' },
    { page: 'settings', icon: SettingsIcon, text: '设置' }
  ] as const

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><Mark/><strong>Focus Resume</strong></div>
      <nav aria-label="工作台导航">
        {nav.map(item => <button key={item.page} className={'nav-item ' + (page === item.page ? 'selected' : '')}
          aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}><item.icon size={18}/>{item.text}</button>)}
      </nav>
      {activeTask && <button className="sidebar-task" onClick={() => openTask(activeTask)}>
        <div><span className={'state-dot ' + active?.status}/>{phaseName[active!.status]}</div>
        <strong>{activeTask.title}</strong><time>{formatDuration(clock.work)}</time>
      </button>}
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => taskActions.capture(active)}><StickyNote size={17}/>随手记</button><button className="nav-item" onClick={taskActions.panel}><PanelTop size={17}/>轻量面板</button>
        <span><span className="state-dot"/>数据保存在本机</span></div>
    </aside>

    <main className="main">
      <header className="topbar"><strong>{nav.find(item => item.page === page)?.text}</strong>
        <div className="top-actions">
          <span className="save-state" role="status">{data.restoring ? '正在检查备份…' : saving ? '正在处理…' : <><Check size={14}/>已保存</>}</span>
          {aiBusy && <button className="button small" onClick={() => run(act(api.cancelAi()))}>取消 AI 请求</button>}
                <button className="icon-button" aria-label="打开轻量面板" onClick={taskActions.panel}><Maximize2 size={17}/></button>
        </div>
      </header>
      <div className="page">
        {data.issue && <p className="notice" role="status">{data.issue}</p>}
        {page === 'home' && <>
          <div className="page-heading"><h1>开始，或接着做。</h1><p>记住当前目标和下一步，随时回到手上的工作。</p></div>
          <div className="home-grid">
            <section className="hero card">
              <div className="hero-label"><Play size={17}/>通用任务</div>
              <h2>开始一件事</h2>
              <form onSubmit={event => {
                event.preventDefault()
                const fields = new FormData(event.currentTarget)
                const value = String(fields.get('title')).trim()
                if (value) startGeneral(value, Number(fields.get('plan')))
              }}>
                <label htmlFor="new-task">这次想做什么？</label>
                <input id="new-task" name="title" maxLength={200} placeholder="例如：先列出方案的三个比较维度" required />
                <div className="form-actions"><PlanSelect/><button className="button light" disabled={actionBusy} type="submit">开始工作<ArrowRight size={16}/></button></div>
              </form>
            </section>
            <section className="card resume-card"><div className="eyebrow"><RotateCcw size={17}/>继续上次</div>
              {resume ? <><h2>{resume.title}</h2>
                <p className="resume-next">{resume.card.next || resume.card.progress || resume.card.goal || '上次的任务与进度已经保存。'}</p>
                <button className="button primary" onClick={() => openTask(resume)}>打开继续卡片<ArrowRight size={16}/></button>
              </> : <><h2>继续卡片</h2><p>开始一个任务后，这里会保留目标、进度和下一步。</p></>}
            </section>
          </div>
          <section className="card listing">
            <div className="list-head"><div className="section-title"><BookOpen size={19}/><h2>阅读文档</h2></div>
              <button className="button small" onClick={() => importing ? cancelImport() : void importDocument()}>{importing ? <X size={15}/> : <Upload size={15}/>}
                {importing ? '取消导入' : '导入文档'}</button></div>
            {importing && <p role="status" className="empty-line">正在选择或检查文档…</p>}
            {!state.documents.length && !importing && <p className="empty-line">选择 PDF、Markdown 或 TXT，在应用中打开原文。</p>}
            {state.documents.toReversed().slice(0, 5).map(document => <button className="list-item" key={document.id} onClick={() => openDoc(document)}>
              <div className="list-icon"><FileText size={18}/></div><strong>{document.name}</strong><span>{document.format.toUpperCase()}</span><ChevronRight size={16}/>
            </button>)}
          </section>
          {!!ordered.length && <section className="card listing">
            <div className="list-head"><div className="section-title"><History size={19}/><h2>最近任务</h2></div>
              <button className="link" onClick={() => setPage('history')}>查看全部</button></div>
            {ordered.slice(0, 4).map(item => <button className="list-item" key={item.id} onClick={() => openTask(item)}>
              <div className="list-icon">{item.kind === 'reading' ? <BookOpen size={18}/> : <ListTodo size={18}/>}</div>
              <strong>{item.title}</strong><span>{taskStatus[item.status]}</span><ChevronRight size={16}/>
            </button>)}
          </section>}
        </>}
        {page === 'task' && (task || activeTask
          ? <TaskArea key={(task || activeTask)!.id} task={(task || activeTask)!} active={active} change={change} actions={taskActions}
              disabled={actionBusy}/>
          : <section className="card empty"><Timer size={31}/><h1>还没有当前任务</h1><button className="button primary" onClick={() => setPage('home')}>开始一件事</button></section>)}
        {page === 'reading' && <>
          <div className="list-head reading-header"><h1>阅读工作区</h1>
            <div className="inline">
              {state.documents.length > 0 && <select aria-label="选择文档" value={doc?.id ?? ''} onChange={event => { setDocId(event.target.value); setJump(undefined) }}>
                <option value="" disabled>选择已有文档</option>
                {state.documents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>}
              {(doc || state.documents.length > 0 || importing) && <button className="button" onClick={() => importing ? cancelImport() : void importDocument()}>{importing ? '取消导入' : '导入文档'}</button>}
            </div>
          </div>
          {importing && <p className="notice" role="status">正在选择或检查文档…</p>}
          {doc ? <>
            {readingTask ? <TaskArea key={readingTask.id} task={readingTask} active={active} change={change}
              actions={taskActions} disabled={actionBusy} reading/>
              : <section className="card read-start"><div><strong>打开原文</strong><p>点击开始阅读来创建任务和记录时长。</p></div>
                <form className="inline" onSubmit={event => { event.preventDefault(); startReading(doc, Number(new FormData(event.currentTarget).get('plan'))) }}>
                  <PlanSelect/><button className="button primary" disabled={actionBusy}><Play size={16}/>开始阅读</button>
                </form></section>}
            <Reader key={doc.id + (jump?.key ?? '')} doc={doc} task={readingTask} state={state}
              initialPosition={jump?.position} onStudy={setStudyDraft}
              onPosition={position => { void unwrap(api.command({ type: 'position', docId: doc.id, position }))
                .catch(error => announce(error.message, true)) }}
              onNote={async (position, text) => { await change({ type: 'note', docId: doc.id, position, text }); announce('笔记已保存。') }}
              onExplain={askAi} onSettings={saveSettings}/>
            <button className="link danger" onClick={() => setConfirm({
              title: '移除应用中的文档副本', label: '移除副本',
              detail: '关联笔记和复习卡会删除，旧任务和历史会话保留。正在读这份文档的会话会结束。用户最初的原文件会保留。',
              go: async () => { await change({ type: 'deleteDocument', docId: doc.id }); setDocId(undefined) }
            })}>移除文档副本</button>
          </> : <section className="card empty"><BookOpen size={31}/><h2>打开一份文档</h2><p>支持 PDF、Markdown 和 UTF-8 文本。</p>
            {!state.documents.length && !importing && <button className="button primary" onClick={() => void importDocument()}><Upload size={16}/>导入文档</button>}</section>}
        </>}
        {page === 'study' && <StudyPage cards={state.studyCards} documents={state.documents} now={studyClock} openSource={openDoc}
          saveReview={async (card, rating) => {
            await change({ type: 'studyReview', cardId: card.id, expectedReviews: card.reviews.length, rating })
            setStudyClock(Date.now())
            announce('复习结果已保存。')
          }} remove={(card: StudyCard) => setConfirm({ title: '删除复习卡', detail: card.question, label: '删除复习卡',
            go: async () => { await change({ type: 'studyDelete', cardId: card.id }); announce('复习卡已删除。') }
          })}/>}
        {page === 'inbox' && <ThoughtInbox state={state} change={change} capture={() => taskActions.capture(active)}/>}
        {page === 'history' && <HistoryPage state={state} openTask={openTask} chooseStatus={chooseStatus} change={change}/>}
        {page === 'settings' && <SettingsPage key={data.restoring ? 'restoring' : 'ready'} data={data} version={version}
          change={change} onAction={async (action, message) => {
            const result = await act(action)
            if (result) announce(message)
          }} saveKey={async value => { await act(api.secret(value)); announce(value ? '凭据已保存。' : '凭据已移除。') }}
          desktop={action => run(act(api.desktop(action)))}/>}
      </div>
    </main>
    {flash && <div className={'toast ' + (flash.error ? 'toast-error' : '')} role={flash.error ? 'alert' : 'status'}>{flash.text}
      <button className="icon-button" aria-label="关闭提示" onClick={() => setFlash(undefined)}><X size={16}/></button></div>}
    {data.restoring && <div className="busy-cover" role="status">正在处理本地数据…</div>}
    {confirm && <Modal title={confirm.title} close={() => !actionBusy && setConfirm(undefined)}>
      <p>{confirm.detail}</p><div className="modal-actions"><button className="button" disabled={actionBusy} onClick={() => setConfirm(undefined)}>取消</button>
        <button className="button primary" disabled={actionBusy} onClick={() => run((async () => {
          await confirm.go(); setConfirm(undefined)
        })())}>{confirm.label}</button></div>
    </Modal>}
    {ending && <EndSession key={ending.id} session={ending} close={() => setEnding(undefined)} onEnd={async (outcome, result, next) => {
      await change({ type: 'end', sessionId: ending.id, outcome, result, next })
      setEnding(undefined); setPage('history'); announce('本次工作已保存，任务仍可继续。')
    }}/>}
    {resting && <Modal title="开始休息" close={() => setResting(undefined)}>
      <form onSubmit={event => {
        event.preventDefault()
        const minutes = Number(new FormData(event.currentTarget).get('rest'))
        setResting(undefined)
        run(change({ type: 'rest', sessionId: resting.id, minutes }))
      }}>
        <label>休息时长<select name="rest" defaultValue="5"><option value="0">自由休息</option><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option></select></label>
        <div className="modal-actions"><button className="button primary">开始休息</button></div>
      </form>
    </Modal>}
    {capturing && <CaptureForm close={() => setCapturing(undefined)} onSave={async text => {
      await change({ type: 'capture', sessionId: capturing.sessionId, captureId: capturing.captureId, text })
      setCapturing(undefined); announce('念头已保存。')
    }}/>}
    {studyDraft && doc && <Modal title="制作复习卡" close={() => setStudyDraft(undefined)}>
      <StudyCardForm draft={studyDraft} doc={doc} close={() => setStudyDraft(undefined)} save={async (question, answer) => {
        await change({ type: 'studyCreate', docId: doc.id, position: studyDraft.position, question, answer })
        setStudyDraft(undefined); announce('复习卡已保存，可以到「阅读复习」开始回忆。')
      }}/>
    </Modal>}
    {aiDraft && <AiPreview draft={aiDraft} endpoint={state.settings.endpoint} close={() => setAiDraft(undefined)} send={submitAi}/>}
    {aiAnswer && <AiAnswer answer={aiAnswer} state={state} close={() => setAiAnswer(undefined)} adopt={async (index, edit) => {
      await act(api.adoptAi(aiAnswer.id, index, edit)); setAiAnswer(undefined); announce(aiAnswer.draft.kind === 'explain' ? '已保存到原文笔记。' : '已更新原任务的下一步。')
    }}/>}
  </div>
}

function PlanSelect() {
  return <select name="plan" aria-label="计划时长" defaultValue="0">
    <option value="0">自由计时</option><option value="5">5 分钟</option><option value="15">15 分钟</option>
    <option value="25">25 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option>
  </select>
}
type TaskActions = {
  startTask: (task: Task, minutes: number) => void
  chooseStatus: (task: Task, status: Task['status']) => void
  suggest: (task: Task) => void
  pause: (id: string) => void
  end: (session: Session) => void
  rest: (session: Session) => void
  capture: (session: Session) => void
  panel: () => void
}
type Change = (command: Command) => Promise<string | undefined>

function TaskArea({ task, active, actions, change, disabled, reading }: {
  task: Task; active?: Session; change: Change; actions: TaskActions; disabled: boolean; reading?: boolean
}) {
  const session = active?.taskId === task.id ? active : undefined
  const { work, rest } = useClock(session)
  return <section className={'task-area ' + (reading ? 'reading-task' : '')}>
    <div className="card task-top">
      <div>
        <div className="eyebrow"><span className={'state-dot ' + (session?.status ?? '')}/>
          {session ? phaseName[session.status] : taskStatus[task.status]}</div>
        {reading ? <h2>{task.title}</h2> : <h1>{task.title}</h1>}
        {task.card.goal && <p>{task.card.goal}</p>}
        {session?.reason && pauseReason[session.reason] && <p className="notice">{pauseReason[session.reason]}</p>}
        {task.kind === 'reading' && !task.docId && <p className="muted">原文副本和阅读位置已不可用。</p>}
      </div>
      {session && <div className="timer">
        <span>本次工作</span><time>{formatDuration(work)}</time>
        {session.status === 'resting' && <span>休息 {session.restMinutes ? '剩余 ' + formatDuration(session.restMinutes * 60_000 - rest) : formatDuration(rest)}</span>}
        {session.status === 'working' && session.planMinutes > 0 && <span>{session.planNotified ? '已到计划时长' : '计划 ' + session.planMinutes + ' 分钟'}</span>}
      </div>}
      <div className="task-controls">
        {session ? <>
          {session.status === 'working'
            ? <button className="button primary" onClick={() => actions.pause(session.id)}><Pause size={16}/>暂停</button>
            : <button className="button primary" onClick={() => actions.startTask(task, 0)}><Play size={16}/>继续工作</button>}
          {session.status !== 'resting' && <button className="button" onClick={() => actions.rest(session)}><Coffee size={16}/>休息</button>}
          <button className="button" onClick={() => actions.capture(session)}><StickyNote size={16}/>随手记</button>
          <button className="button" onClick={() => actions.end(session)}><Square size={14}/>结束本次工作</button>
        </> : task.status === 'open' ? <form className="inline" onSubmit={event => {
          event.preventDefault(); actions.startTask(task, Number(new FormData(event.currentTarget).get('plan')))
        }}><PlanSelect/><button className="button primary" disabled={disabled}><Play size={16}/>{reading ? '开始阅读' : '继续工作'}</button></form>
          : <button className="button primary" onClick={() => actions.chooseStatus(task, 'open')}><RotateCcw size={15}/>重新打开任务</button>}
        {task.status === 'open' && <button className="link" onClick={() => actions.chooseStatus(task, 'done')}>完成任务</button>}
        {task.status !== 'archived' && <button className="link" onClick={() => actions.chooseStatus(task, 'archived')}>归档</button>}
      </div>
    </div>
    <CardEditor task={task} change={change} suggest={actions.suggest} reading={reading}/>
    {session && !!session.thoughts.length && <section className="card captured-summary">
      <div className="section-title"><StickyNote size={17}/><h3>本次随手记</h3></div>
      <ul>{session.thoughts.map(item => <li key={item.id}>{item.text}</li>)}</ul>
    </section>}
  </section>
}

function CardEditor({ task, change, suggest, reading }: { task: Task; change: Change; suggest: (task: Task) => void; reading?: boolean }) {
  const [local, setLocal] = useState<Partial<Card>>({})
  const [conclusion, setConclusion] = useState<string>()
  const [busy, setBusy] = useState(false)
  const dirty = Object.keys(local).length > 0 || conclusion !== undefined
  const changeRef = useRef(change)
  changeRef.current = change
  const pending = useRef({ local, conclusion })
  pending.current = { local, conclusion }
  useEffect(() => () => {
    const draft = pending.current
    if (task.status !== 'archived' && (Object.keys(draft.local).length || draft.conclusion !== undefined)) {
      void changeRef.current({ type: 'edit', taskId: task.id, card: draft.local, conclusion: draft.conclusion }).catch(() => undefined)
    }
  }, [task.id, task.status])
  async function save() {
    if (!dirty || busy) return
    setBusy(true)
    try {
      await change({ type: 'edit', taskId: task.id, card: local, conclusion })
      pending.current = { local: {}, conclusion: undefined }
      setLocal({}); setConclusion(undefined)
    } catch { /* preserve draft */ }
    finally { setBusy(false) }
  }
  const fields: { key: keyof Card; label: string; hint: string }[] = [
    { key: 'goal', label: '本次目标', hint: reading ? '例如：读第 6–10 页并记一个结论' : '希望这次做到什么？' },
    { key: 'next', label: '下一步', hint: '回来后先做什么？' },
    { key: 'progress', label: '做到哪里', hint: '留一句能接回思路的说明' },
    { key: 'blocker', label: '卡点或问题', hint: '还有什么待解决？' }
  ]
  return <section className="card card-editor">
    <div className="list-head"><div className="section-title"><RotateCcw size={17}/><h2>继续卡片</h2></div>
      {task.status === 'open' && <button className="button small" disabled={busy} onClick={async () => {
        if (dirty) await save()
        suggest({ ...task, card: { ...task.card, ...local } })
      }}><Sparkles size={14}/>建议下一步</button>}</div>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy || task.status === 'archived'}>
        {fields.map(field => <label key={field.key}>{field.label}<input maxLength={6000} placeholder={field.hint}
          value={local[field.key] ?? task.card[field.key]} onChange={event => setLocal({ ...local, [field.key]: event.target.value })}
          onBlur={() => { if (dirty) void save() }}/></label>)}
        {reading && <label>一句话结论<input maxLength={6000} placeholder="用自己的话记下理解"
          value={conclusion ?? task.conclusion} onChange={event => setConclusion(event.target.value)} onBlur={() => { if (dirty) void save() }}/></label>}
      </fieldset>
      <div className="inline"><button className="button small" disabled={!dirty || busy || task.status === 'archived'}>保存卡片</button>
        <span className="muted">{busy ? '正在保存…' : dirty ? '有待保存的编辑' : '已保存'}</span></div>
    </form>
  </section>
}

function EndSession({ session, close, onEnd }: {
  session: Session; close: () => void; onEnd: (outcome: Outcome, result: string, next?: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return <Modal title="结束本次工作" close={() => !busy && close()}>
    <form onSubmit={async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (busy) return
      const values = new FormData(event.currentTarget)
      setBusy(true)
      const next = String(values.get('next'))
      try { await onEnd(String(values.get('outcome')) as Outcome, String(values.get('result')), next || undefined) }
      catch { /* leave form open */ } finally { setBusy(false) }
    }}>
      <label>本次目标<select name="outcome" defaultValue=""><option value="">暂不记录</option><option value="done">已达成</option>
        <option value="partial">部分达成</option><option value="unmet">未达成</option></select></label>
      <label>本次成果<textarea name="result" maxLength={6000} rows={2} placeholder="可留空" /></label>
      <label>下一步<input name="next" maxLength={6000} placeholder="留空时保留继续卡片中的下一步" /></label>
      {session.thoughts.length > 0 && <details open><summary>本次随手记</summary><ul>{session.thoughts.map(item => <li key={item.id}>{item.text}</li>)}</ul></details>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={close}>返回</button>
        <button className="button primary" disabled={busy}>保存并结束</button></div>
    </form>
  </Modal>
}

function CaptureForm({ close, onSave, embedded = false }: { close: () => void; onSave: (text: string) => Promise<void>; embedded?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [thought, setThought] = useState('')
  const form = <form onSubmit={async event => {
    event.preventDefault()
    if (busy || !thought.trim()) return
    setBusy(true)
    try { await onSave(thought); setThought('') } catch { /* keep content for retry */ } finally { setBusy(false) }
  }}><label>记下临时想到的事<textarea autoFocus maxLength={6000} rows={3} value={thought}
    onChange={event => setThought(event.target.value)} placeholder="例如：工作结束后回复那封邮件"/></label>
    <div className="modal-actions"><button type="button" className="button" onClick={close}>取消</button>
      <button className="button primary" disabled={busy || !thought.trim()}>保存并返回</button></div>
  </form>
  return embedded ? form : <Modal title="分心随手记" close={close}>{form}</Modal>
}

function ThoughtInbox({ state, change, capture }: { state: State; change: Change; capture: () => void }) {
  const [showHandled, setShowHandled] = useState(false)
  const taskNames = new Map(state.tasks.map(task => [task.id, task.title]))
  const thoughts = [
    ...state.inbox.map(thought => ({ ...thought, sessionId: null, origin: '未关联会话' })),
    ...state.sessions.flatMap(session => session.thoughts.map(thought => ({
      ...thought, sessionId: session.id, origin: taskNames.get(session.taskId) ?? '工作会话'
    })))
  ]
  const visible = thoughts.filter(item => showHandled || !item.handled).sort((a, b) => b.at - a.at)
  return <>
    <div className="page-heading"><h1>随手记收件箱</h1><p>把临时念头留在这里，空下来再处理。</p></div>
    <section className="card listing">
      <div className="list-head"><button className="button primary" onClick={capture}><StickyNote size={16}/>记录念头</button>
        <label className="check"><input type="checkbox" checked={showHandled}
          onChange={event => setShowHandled(event.target.checked)}/>显示已处理</label></div>
      {visible.length === 0 && <p className="empty-line">这里暂时没有{showHandled ? '' : '待处理的'}念头。</p>}
      {visible.map(item => <article className="inbox-item" key={item.id}>
        <div><span className="muted">{item.origin} · {dateLabel(item.at)}</span><p>{item.text}</p></div>
        {item.handled ? <span className="muted">已处理</span> : <div className="inline">
          <button className="link" onClick={() => void change({ type: 'handleThought', sessionId: item.sessionId, thoughtId: item.id, createTask: true }).catch(() => undefined)}>转为任务</button>
          <button className="link" onClick={() => void change({ type: 'handleThought', sessionId: item.sessionId, thoughtId: item.id, createTask: false }).catch(() => undefined)}>标为已处理</button>
        </div>}
      </article>)}
    </section>
  </>
}

function HistoryPage({ state, openTask, chooseStatus, change }: {
  state: State; openTask: (task: Task) => void; chooseStatus: TaskActions['chooseStatus']; change: Change
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const tasks = recentTasks(state).filter(task => (filter === 'all' || task.status === filter) &&
    task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const taskMap = new Map(state.tasks.map(task => [task.id, task]))
  const sessions = state.sessions.filter(session => session.status === 'ended' && tasks.some(task => task.id === session.taskId)).toReversed()
  return <>
    <div className="page-heading"><h1>任务与记录</h1><p>查看每次工作留下的结果，或继续尚未完成的任务。</p></div>
    <div className="inline filters"><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)}/>
      <select aria-label="任务状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">所有状态</option>
        <option value="open">未完成</option><option value="done">已完成</option><option value="archived">已归档</option></select></div>
    <section className="card listing"><div className="list-head"><h2>任务</h2></div>
      {!tasks.length && <p className="empty-line">没有符合条件的任务。</p>}
      {tasks.map(task => <div className="history-row" key={task.id}>
        <button className="list-item" onClick={() => openTask(task)}><div className="list-icon">{task.kind === 'reading' ? <BookOpen size={17}/> : <ListTodo size={17}/>}</div>
          <div><strong>{task.title}</strong>{task.card.next && <p>{task.card.next}</p>}</div><span>{taskStatus[task.status]}</span></button>
        {task.status === 'open' ? <button className="link" onClick={() => chooseStatus(task, 'archived')}>归档</button>
          : <button className="link" onClick={() => chooseStatus(task, 'open')}>重新打开</button>}
      </div>)}
    </section>
    <section className="card listing"><div className="list-head"><h2>已结束的会话</h2></div>
      {!sessions.length && <p className="empty-line">结束一次工作后，这里会显示会话记录。</p>}
      {sessions.map(session => <details className="session-history" key={session.id}>
        <summary><strong>{taskMap.get(session.taskId)?.title}</strong><span>{dateLabel(session.startedAt)} · {formatDuration(workMs(session))}</span></summary>
        <div className="session-detail">
          <p>{outcomeName[session.outcome]}{session.reason === 'switch' ? ' · 切换任务' : ''}</p>
          {session.goalAtStart && <p>开始时目标　{session.goalAtStart}</p>}
          {session.goalAtEnd !== session.goalAtStart && <p>结束时目标　{session.goalAtEnd || '已清除'}</p>}
          {session.result && <p>本次成果　{session.result}</p>}
          {session.thoughts.map(item => <div className="thought-row" key={item.id}><span>{item.text}</span>
            {item.handled ? <span className="muted">已处理</span> : <>
              <button className="link" onClick={() => void change({ type: 'handleThought', sessionId: session.id, thoughtId: item.id, createTask: false }).catch(() => undefined)}>标为已处理</button>
              <button className="link" onClick={() => void change({ type: 'handleThought', sessionId: session.id, thoughtId: item.id, createTask: true }).catch(() => undefined)}>创建任务</button>
            </>}</div>)}
        </div>
      </details>)}
    </section>
  </>
}

function SettingsPage({ data, version, change, onAction, saveKey, desktop }: {
  data: Snapshot; version: string; change: Change
  onAction: (result: ReturnType<typeof api.backup>, message: string) => Promise<void>
  saveKey: (value: string) => Promise<void>; desktop: (action: Parameters<typeof api.desktop>[0]) => void
}) {
  const [prefs, setPrefs] = useState(data.state.settings)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [updateStatus, setUpdateStatus] = useState('')
  const [checking, setChecking] = useState(false)
  function edit(field: Partial<Settings>) { setPrefs(value => ({ ...value, ...field })) }
  async function save(fields: Partial<Settings>) {
    setBusy(true)
    try { await change({ type: 'settings', settings: fields }) } catch { /* workspace reports failure */ }
    finally { setBusy(false) }
  }
  const call = (promise: Promise<unknown>) => { void promise.catch(() => undefined) }
  return <div className="settings-page">
    <div className="page-heading"><h1>设置</h1></div>
    <section className="card settings-card"><h2>显示与阅读</h2>
      <form onSubmit={event => {
        event.preventDefault(); void save({ theme: prefs.theme, fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, readingWidth: prefs.readingWidth })
      }}>
        <div className="settings-grid">
          <label>主题<select value={prefs.theme} onChange={event => edit({ theme: event.target.value as Settings['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label>正文字号<input type="number" min={14} max={28} value={prefs.fontSize || ''} onChange={event => edit({ fontSize: +event.target.value })} required/></label>
          <label>正文行高<input type="number" step=".1" min="1.4" max="2.4" value={prefs.lineHeight || ''} onChange={event => edit({ lineHeight: +event.target.value })} required/></label>
          <label>阅读宽度<input type="number" min={440} max={920} value={prefs.readingWidth || ''} onChange={event => edit({ readingWidth: +event.target.value })} required/></label>
        </div>
        <button className="button small" disabled={busy}>保存显示设置</button>
      </form>
    </section>
    <section className="card settings-card"><h2>桌面与提醒</h2>
      <form onSubmit={event => { event.preventDefault(); void save({ shortcut: prefs.shortcut.trim(), notifications: prefs.notifications, sound: prefs.sound, panelTop: prefs.panelTop }) }}>
        <label>随手记全局快捷键<input value={prefs.shortcut} maxLength={60} onChange={event => edit({ shortcut: event.target.value })}/></label>
        <p className="muted">示例为 CommandOrControl+Shift+Space。清空后停用。</p>
        <label className="check"><input type="checkbox" checked={prefs.notifications} onChange={event => edit({ notifications: event.target.checked })}/>系统通知</label>
        <label className="check"><input type="checkbox" checked={prefs.sound} onChange={event => edit({ sound: event.target.checked })}/>通知声音</label>
        <label className="check"><input type="checkbox" checked={prefs.panelTop} onChange={event => edit({ panelTop: event.target.checked })}/>轻量面板置顶</label>
        <button className="button small" disabled={busy}>保存桌面设置</button>
      </form>
    </section>
    <section className="card settings-card"><h2>可选 AI</h2><p>只在你主动提交时，把发送预览里的文字发往所选服务。基础功能离线可用。</p>
      <form onSubmit={event => { event.preventDefault(); void save({ aiEnabled: prefs.aiEnabled, endpoint: prefs.endpoint.trim(), model: prefs.model.trim() }) }}>
        <label className="check"><input type="checkbox" checked={prefs.aiEnabled} onChange={event => edit({ aiEnabled: event.target.checked })}/>启用 AI 辅助</label>
        <label>OpenAI 兼容服务地址<input placeholder="https://api.deepseek.com" maxLength={400} required={prefs.aiEnabled} value={prefs.endpoint} onChange={event => edit({ endpoint: event.target.value })}/></label>
        <label>模型名称<input placeholder="deepseek-chat" maxLength={100} required={prefs.aiEnabled} value={prefs.model} onChange={event => edit({ model: event.target.value })}/></label>
        <button className="button small" disabled={busy}>保存模型设置</button>
      </form>
      <form onSubmit={async event => {
        event.preventDefault()
        const value = key.trim()
        if (!value) return
        try { await saveKey(value); setKey('') } catch { /* keep value for retry */ }
      }}>
        <label>API Key<input type="password" maxLength={600} autoComplete="new-password" value={key}
          placeholder={data.secretReady ? '已安全保存，输入以替换' : '按服务要求填写'} onChange={event => setKey(event.target.value)}/></label>
        <div className="inline"><button className="button small" disabled={!key.trim()}>保存凭据</button>
          <button type="button" className="link" disabled={!data.secretReady} onClick={() => call(saveKey(''))}>移除凭据</button></div>
      </form>
    </section>
    <section className="card settings-card"><h2>本地数据</h2><p>备份包含任务、会话、笔记和文档副本。API Key 单独存储。</p>
      <div className="inline">
        <button className="button" onClick={() => call(onAction(api.backup(), '完整备份已导出。'))}><Download size={16}/>导出完整备份</button>
        <button className="button" onClick={() => call(onAction(api.restore(), '备份已恢复。'))}><Upload size={16}/>恢复备份</button>
        <button className="link danger" onClick={() => call(onAction(api.clear(), '本地数据已清空。'))}>清空本地数据</button>
      </div>
    </section>
    <section className="card settings-card"><h2>关于</h2><p>Focus Resume {version}</p><div className="inline">
      <button className="button" disabled={checking} onClick={async () => {
        setChecking(true)
        try {
          const tag = await unwrap(api.checkUpdate())
          setUpdateStatus(tag ? (tag.replace(/^v/, '') === version ? '当前版本与发布页一致。' : 'GitHub 发布版本：' + tag) : '目前没有公开版本。')
        } catch (error) { setUpdateStatus((error as Error).message) }
        finally { setChecking(false) }
      }}>{checking ? '正在检查…' : '检查更新'}</button>
      <button className="button" onClick={() => desktop('releases')}>打开 GitHub Releases <ArrowRight size={15}/></button>
      <button className="button" onClick={() => desktop('quit')}>退出应用</button>
    </div>{updateStatus && <p className="notice" role="status">{updateStatus}</p>}</section>
  </div>
}

function AiPreview({ draft, endpoint, close, send }: { draft: AiDraft; endpoint: string; close: () => void; send: (draft: AiDraft) => void }) {
  const [input, setInput] = useState(draft.input)
  return <Modal title={draft.kind === 'explain' ? '解释选中文本' : '建议下一步'} close={close}>
    <p>内容将发送至 <strong>{endpoint}</strong>。</p>
    <form onSubmit={event => { event.preventDefault(); if (input.trim()) send({ ...draft, input }) }}>
      <label>本次发送<textarea rows={8} autoFocus value={input} onChange={event => setInput(event.target.value)} maxLength={6000}/></label>
      <div className="modal-actions"><span className="muted">{input.length} / 6000 字符</span>
        <button type="button" className="button" onClick={close}>取消</button>
        <button className="button primary" disabled={!input.trim()}><Sparkles size={15}/>生成</button></div>
    </form>
  </Modal>
}
function AiAnswer({ answer, state, close, adopt }: {
  answer: AiResult; state: State; close: () => void; adopt: (index: number, edit?: string) => Promise<void>
}) {
  const [index, setIndex] = useState(0)
  const [edit, setEdit] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const task = state.tasks.find(item => item.id === answer.draft.taskId)
  const document = state.documents.find(item => item.id === answer.draft.docId)
  const explaining = answer.draft.kind === 'explain'
  const valid = (!answer.draft.taskId || task?.status === 'open') && (!explaining || !!document)
  const text = edit ?? answer.result[index] ?? ''
  return <Modal title={explaining ? 'AI 原文解释' : 'AI 下一步建议'} close={close}>
    <p className="muted">原对象：{explaining ? document?.name ?? '已移除的文档' : task?.title ?? '已移除的任务'}
      {explaining && answer.draft.position && ' · 第 ' + (answer.draft.position.index + 1) + (document?.format === 'pdf' ? ' 页' : ' 段')}</p>
    {!valid && <p className="notice">原对象当前不可写，可以复制内容。</p>}
    {answer.result.length > 1 && <div className="choice-group">{answer.result.map((item, i) => <label key={i} className="check">
      <input type="radio" name="ai-choice" checked={index === i} onChange={() => { setIndex(i); setEdit(undefined) }}/>{item}
    </label>)}</div>}
    <label>{explaining ? '解释' : '准备采用的动作'}<textarea aria-label="AI 结果" rows={6} value={text} maxLength={6000}
      onChange={event => setEdit(event.target.value)}/></label>
    <div className="modal-actions"><button className="button" onClick={() => {
      void unwrap(api.copy(text)).then(() => setCopied(true)).catch(() => { setCopied(false) })
    }}>{copied ? '已复制' : '复制'}</button>
      <button className="button primary" disabled={!valid || busy || !text.trim()} onClick={async () => {
        setBusy(true)
        try { await adopt(index, edit) } catch { /* workspace reports error */ } finally { setBusy(false) }
      }}>{explaining ? '保存为原文笔记' : '写入原任务'}</button></div>
  </Modal>
}

function Compact({ kind, state, restoring }: { kind: 'panel' | 'capture'; state: State; restoring: boolean }) {
  const session = activeSession(state)
  const task = state.tasks.find(item => item.id === session?.taskId)
  const { work } = useClock(session)
  const [message, setMessage] = useState('')
  const [capture, setCapture] = useState<{ sessionId: string | null; captureId: string }>()
  const [standalone] = useState(() => ({ sessionId: session?.id ?? null, captureId: crypto.randomUUID() }))
  useEffect(() => api.onNotice(setMessage), [])
  async function act(operation: Promise<import('../shared/bridge').Reply<unknown>>) {
    try { await unwrap(operation) } catch (error) { setMessage((error as Error).message); throw error }
  }
  const run = (operation: Promise<unknown>) => { void operation.catch(() => undefined) }
  const close = () => run(act(api.desktop('close')))
  return <main className="compact">
    <div className="list-head"><div className="brand"><Mark/><strong>{kind === 'capture' ? '分心随手记' : '当前任务'}</strong></div>
      {kind === 'panel' && <button className={'icon-button ' + (state.settings.panelTop ? 'active' : '')} aria-pressed={state.settings.panelTop}
        aria-label="轻量面板置顶" onClick={() => run(act(api.command({ type: 'settings', settings: { panelTop: !state.settings.panelTop } })))}><Pin size={17}/></button>}
    </div>
    {message && <p className="notice" role="status">{message}</p>}
    {restoring ? <p role="status">正在恢复数据…</p> : kind === 'capture' ? <>
      <p className="muted capture-context">{standalone.sessionId
        ? state.tasks.find(item => item.id === state.sessions.find(value => value.id === standalone.sessionId)?.taskId)?.title ?? '随手记收件箱'
        : '随手记收件箱'}</p>
      <CaptureForm embedded close={close} onSave={async text => {
        await act(api.command({ type: 'capture', ...standalone, text }))
        close()
      }}/>
    </> : !session || !task ? <>
      <p>开始一个任务后，这里会显示当前目标。</p><div className="inline"><button className="button primary" onClick={() => run(act(api.desktop('resume')))}>打开继续卡片</button>
        <button className="button" onClick={() => setCapture({ sessionId: null, captureId: crypto.randomUUID() })}>随手记</button></div>
    </> : <>
      <div className="eyebrow"><span className={'state-dot ' + session.status}/>{phaseName[session.status]}</div>
      <h1>{task.title}</h1>{(task.card.goal || task.card.next) && <p>{task.card.goal || task.card.next}</p>}
      <time className="compact-time">{formatDuration(work)}</time>
      <div className="inline"><button className="button primary" onClick={() => run(act(api.command({ type: session.status === 'working' ? 'pause' : 'resume', sessionId: session.id })))}>
        {session.status === 'working' ? <><Pause size={16}/>暂停</> : <><Play size={16}/>继续工作</>}
      </button><button className="button" onClick={() => setCapture({ sessionId: session.id, captureId: crypto.randomUUID() })}><StickyNote size={16}/>随手记</button>
      <button className="link" onClick={() => run(act(api.desktop('resume')))}>打开继续卡片</button></div>
    </>}
    {capture && <CaptureForm close={() => setCapture(undefined)} onSave={async text => {
      await act(api.command({ type: 'capture', ...capture, text })); setCapture(undefined); setMessage('念头已保存。')
    }}/>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App/>)
