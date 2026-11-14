import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, BookmarkPlus, Crosshair, FileText, Minus, Plus, Sparkles, StickyNote } from 'lucide-react'
import Markdown from 'react-markdown'
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import { api, unwrap } from './api'
import type { StudyDraft } from './study'
import type { AiDraft } from '../shared/bridge'
import type { Document, Position, Settings, State, Task } from '../shared/model'

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', window.location.href).href

function loadPdf(bytes: Uint8Array) {
  const local = (folder: string) => new URL('./' + folder + '/', window.location.href).href
  return getDocument({
    data: bytes, cMapUrl: local('cmaps'), cMapPacked: true,
    standardFontDataUrl: local('standard_fonts'), wasmUrl: local('wasm'),
    useWorkerFetch: false, enableXfa: false
  })
}
function pdfIssue(error: unknown) {
  return error instanceof Error && error.name === 'PasswordException'
    ? '这份 PDF 设置了密码，一期暂不支持。' : 'PDF 无法打开，文件可能已损坏。'
}
export async function validatePdf(bytes: Uint8Array, signal: AbortSignal) {
  const job = loadPdf(bytes)
  const cancel = () => { void job.destroy().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) throw new Error()
    const pdf = await job.promise
    await pdf.getPage(1)
    if (signal.aborted) throw new Error()
  } catch (error) {
    if (signal.aborted) throw new Error('已取消导入。')
    throw new Error(pdfIssue(error))
  } finally {
    signal.removeEventListener('abort', cancel)
    await job.destroy().catch(() => undefined)
  }
}
export function paragraphs(text: string, markdown: boolean) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const blocks: string[] = []
  let block: string[] = []
  let fence: string | undefined
  function flush() {
    if (block.some(line => line.trim())) blocks.push(block.join('\n'))
    block = []
  }
  for (const line of lines) {
    const mark = markdown ? /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1] : undefined
    if (fence) {
      block.push(line)
      if (mark?.startsWith(fence)) { fence = undefined; flush() }
    } else if (mark) {
      flush()
      block.push(line)
      fence = mark
    } else if (!line.trim()) flush()
    else if (markdown && /^#{1,6}\s/.test(line)) { flush(); blocks.push(line) }
    else if (block.length >= 80) { flush(); block.push(line) }
    else block.push(line)
  }
  flush()
  return blocks
}

type ReaderProps = {
  doc: Document
  task?: Task
  initialPosition?: Position
  onStudy: (draft: StudyDraft) => void
  state: State
  onPosition: (position: Position) => void
  onNote: (position: Position, text: string) => Promise<void>
  onExplain: (draft: AiDraft) => void
  onSettings: (settings: Partial<Settings>) => void
}

export function Reader(props: ReaderProps) {
  const { doc, state, task, onPosition, onNote, onExplain, onSettings } = props
  const [source, setSource] = useState<{ pdf?: PDFDocumentProxy; parts?: string[] }>({})
  const [issue, setIssue] = useState('')
  const [current, setCurrent] = useState(props.initialPosition ?? doc.position)
  const [selection, setSelection] = useState<{ text: string; position: Position }>()
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const reader = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const currentRef = useRef(current)
  const target = useRef<Position | null>(current)
  const scheduled = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const positionCallback = useRef(onPosition)
  positionCallback.current = onPosition
  const port = useRef<Position | null>(null)
  const prefs = state.settings

  useEffect(() => {
    let disposed = false
    let job: PDFDocumentLoadingTask | undefined
    void unwrap(api.document(doc.id)).then(async bytes => {
      if (disposed) return
      if (doc.format !== 'pdf') {
        setSource({ parts: paragraphs(new TextDecoder().decode(bytes), doc.format === 'md') })
        return
      }
      job = loadPdf(bytes)
      const pdf = await job.promise
      if (!disposed) setSource({ pdf })
    }).catch(error => {
      if (!disposed) setIssue(doc.format === 'pdf' ? pdfIssue(error) : String(error.message))
    })
    return () => {
      disposed = true
      void job?.destroy().catch(() => undefined)
      clearTimeout(scheduled.current)
      if (port.current) positionCallback.current(port.current)
    }
  }, [doc.id, doc.format])

  function setPosition(location: Position) {
    currentRef.current = location
    setCurrent(location)
    port.current = location
    clearTimeout(scheduled.current)
    scheduled.current = setTimeout(() => {
      const latest = port.current
      port.current = null
      if (latest) positionCallback.current(latest)
    }, 180)
  }
  function restoreTextPosition() {
    if (!target.current || !reader.current || !content.current) return
    const wanted = target.current
    const paragraph = content.current.querySelector<HTMLElement>('[data-block="' + wanted.index + '"]')
    if (!paragraph) return
    reader.current.scrollTop += paragraph.getBoundingClientRect().top - reader.current.getBoundingClientRect().top
      + paragraph.offsetHeight * wanted.offset - 14
    target.current = null
  }
  useLayoutEffect(restoreTextPosition, [source.parts, prefs.fontSize, prefs.lineHeight, prefs.readingWidth])

  function go(location: Position) {
    setSelection(undefined)
    window.getSelection()?.removeAllRanges()
    target.current = location
    setPosition(location)
    if (source.parts) restoreTextPosition()
    if (source.pdf && reader.current) {
      reader.current.scrollTop = location.offset * Math.max(0, reader.current.scrollHeight - reader.current.clientHeight)
    }
  }
  function onScroll() {
    if (!reader.current || !content.current || target.current) return
    if (source.pdf) {
      const node = reader.current
      const max = Math.max(1, node.scrollHeight - node.clientHeight)
      setPosition({ index: currentRef.current.index, offset: Math.min(1, Math.max(0, node.scrollTop / max)) })
      return
    }
    const top = reader.current.getBoundingClientRect().top + 15
    const blocks = content.current.children
    let low = 0, high = blocks.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (blocks[middle].getBoundingClientRect().bottom <= top) low = middle + 1
      else high = middle
    }
    const rect = blocks[low]?.getBoundingClientRect()
    if (!rect) return
    setPosition({ index: low, offset: Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height))) })
  }
  function readSelection() {
    const selected = window.getSelection()
    const anchor = selected?.anchorNode
    const text = selected?.toString().trim()
    if (!anchor || !text || !content.current?.contains(anchor) || !content.current.contains(selected?.focusNode ?? null)) return
    const block = anchor.parentElement?.closest<HTMLElement>('[data-block]')
    setSelection({ text, position: block ? { index: Number(block.dataset.block), offset: 0 } : currentRef.current })
  }
  const headings = source.parts?.flatMap((part, index) => /^#{1,6}\s/.test(part)
    ? [{ index, title: part.split('\n')[0].replace(/^#+\s*/, '') }] : []) ?? []
  const notes = state.notes.filter(item => item.docId === doc.id)
  const style = {
    '--reading-size': prefs.fontSize + 'px', '--reading-line': prefs.lineHeight, '--reading-width': prefs.readingWidth + 'px'
  } as CSSProperties
  const label = (p: Position) => (doc.format === 'pdf' ? '第 ' + (p.index + 1) + ' 页' : '第 ' + (p.index + 1) + ' 段')
  return <section className="reader-workspace" aria-label="文档原文">
    <div className="reader-toolbar">
      <div className="reader-filename"><FileText size={18}/><strong>{doc.name}</strong></div>
      {headings.length > 0 && <label className="visually-label">章节
        <select value={headings.findLast(heading => heading.index <= current.index)?.index ?? ''} onChange={e => go({ index: +e.target.value, offset: 0 })}>
          <option value="" disabled>跳到章节</option>
          {headings.map(heading => <option key={heading.index} value={heading.index}>{heading.title}</option>)}
        </select>
      </label>}
      {source.parts && <button className={'button small ' + (prefs.focus ? 'active' : '')} aria-pressed={prefs.focus} onClick={() => onSettings({ focus: !prefs.focus })}><Crosshair size={15}/>段落聚焦</button>}
      <button className="button small" disabled={!!issue || (!source.parts && !source.pdf)} onClick={() => props.onStudy({
        position: selection?.position ?? currentRef.current,
        answer: selection && selection.text.length <= 6000 ? selection.text : ''
      })}><BookmarkPlus size={15}/>制作复习卡</button>
      <button className="button small" disabled={!selection} onClick={() => selection && onExplain({
        kind: 'explain', docId: doc.id, taskId: task?.id ?? null, position: selection.position, input: selection.text
      })}><Sparkles size={15}/>解释选中文本</button>
    </div>
    {selection && <div className="selection-info">已选 {selection.text.length} 字符 <button className="link" onClick={() => setSelection(undefined)}>清除选择</button></div>}
    {issue && <p className="error" role="alert">{issue}</p>}
    {!issue && !source.pdf && !source.parts && <p className="empty-line" role="status">正在打开原文…</p>}
    {source.pdf && <PdfControls count={source.pdf.numPages} index={current.index} jump={go} />}
    <div className="reader-scroll" ref={reader} style={style} onScroll={onScroll} onMouseUp={readSelection} onKeyUp={readSelection} tabIndex={0} aria-label="原文浏览区">
      {source.pdf && <PdfPage pdf={source.pdf} current={current.index} content={content} onReady={() => {
        const wanted = target.current
        const node = reader.current
        if (wanted && node) {
          node.scrollTop = wanted.offset * Math.max(0, node.scrollHeight - node.clientHeight)
          target.current = null
        }
      }} />}
      {source.parts && <div className={'text-reader ' + (prefs.focus ? 'focus-mode' : '')} ref={content}>
        {source.parts.map((part, index) => <div key={index} data-block={index} className={current.index === index ? 'current' : ''}>
          {doc.format === 'md'
            ? <Markdown skipHtml components={{
              a: ({ children }) => <span className="article-link">{children}</span>,
              img: ({ alt }) => <span>{alt ? '[图片：' + alt + ']' : '[图片]'}</span>
            }}>{part}</Markdown>
            : <p className="plain-text">{part}</p>}
        </div>)}
      </div>}
    </div>
    <div className="notes">
      <div className="section-title"><StickyNote size={17}/><h3>阅读笔记</h3><span className="muted">{label(current)}</span></div>
      <form onSubmit={async e => {
        e.preventDefault()
        if (saving || !note.trim()) return
        setSaving(true)
        try { await onNote(currentRef.current, note); setNote('') } catch { /* caller reports error */ }
        finally { setSaving(false) }
      }}>
        <input aria-label="本页或本段笔记" placeholder="记下一个结论或问题" maxLength={6000} value={note} onChange={e => setNote(e.target.value)} />
        <button className="button small" disabled={saving || !note.trim()} type="submit">保存笔记</button>
      </form>
      {notes.toReversed().map(item => <div className="note" key={item.id}>
        <button className="link" onClick={() => go(item.position)}>{label(item.position)}</button>
        {item.source === 'ai' && <span className="pill">AI</span>}<p>{item.text}</p>
      </div>)}
    </div>
  </section>
}

function PdfControls({ count, index, jump }: { count: number; index: number; jump: (p: Position) => void }) {
  return <div className="pdf-controls">
    <button className="icon-button" aria-label="上一页" disabled={index <= 0} onClick={() => jump({ index: index - 1, offset: 0 })}><ArrowLeft size={17}/></button>
    <form key={index} onSubmit={e => {
      e.preventDefault()
      const page = Number(new FormData(e.currentTarget).get('page'))
      if (Number.isInteger(page) && page >= 1 && page <= count) jump({ index: page - 1, offset: 0 })
    }}>
      <input name="page" type="number" min={1} max={count} defaultValue={index + 1} aria-label="页码，按回车跳转" />
      <span> / {count} 页</span>
    </form>
    <button className="icon-button" aria-label="下一页" disabled={index >= count - 1} onClick={() => jump({ index: index + 1, offset: 0 })}><ArrowRight size={17}/></button>
  </div>
}

function PdfPage({ pdf, current, content, onReady }: {
  pdf: PDFDocumentProxy; current: number; content: React.RefObject<HTMLDivElement | null>; onReady: () => void
}) {
  const [zoom, setZoom] = useState(1.15)
  const [status, setStatus] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const ready = useRef(onReady)
  ready.current = onReady
  useEffect(() => {
    let cancelled = false
    let render: RenderTask | undefined
    let textLayer: TextLayer | undefined
    setStatus('正在读取本页…')
    void pdf.getPage(Math.min(current + 1, pdf.numPages)).then(async page => {
      const target = canvas.current
      const text = layer.current
      const container = content.current
      if (cancelled || !target || !text || !container) return
      const viewport = page.getViewport({ scale: zoom })
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)))
      if (!Number.isFinite(ratio) || ratio <= 0 || viewport.width > 30_000 || viewport.height > 30_000) {
        throw new Error('PDF 页面尺寸过大。')
      }
      container.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
      container.style.width = viewport.width + 'px'
      container.style.height = viewport.height + 'px'
      target.style.width = viewport.width + 'px'
      target.style.height = viewport.height + 'px'
      target.width = Math.max(1, Math.floor(viewport.width * ratio))
      target.height = Math.max(1, Math.floor(viewport.height * ratio))
      text.replaceChildren()
      render = page.render({ canvas: target, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      await render.promise
      if (cancelled) return
      ready.current()
      const original = await page.getTextContent()
      if (cancelled) return
      textLayer = new TextLayer({ textContentSource: original, container: text, viewport })
      await textLayer.render()
      if (!cancelled) setStatus(textLayer.textContentItemsStr.some(item => item.trim()) ? '' : '该页没有可选原文，仍可阅读和保存位置。')
    }).catch(() => { if (!cancelled) setStatus('本页无法渲染，可以尝试其他页。') })
    return () => { cancelled = true; render?.cancel(); textLayer?.cancel() }
  }, [pdf, current, zoom, content])
  return <>
    <div className="zoom-controls">
      <button className="icon-button" aria-label="缩小 PDF" disabled={zoom <= .55} onClick={() => setZoom(value => Math.max(.55, value - .15))}><Minus size={15}/></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button className="icon-button" aria-label="放大 PDF" disabled={zoom >= 2.5} onClick={() => setZoom(value => Math.min(2.5, value + .15))}><Plus size={15}/></button>
      <span role="status">{status}</span>
    </div>
    <div className="pdf-paper" ref={content}><canvas ref={canvas} aria-label={'PDF 第 ' + (current + 1) + ' 页'}/><div className="textLayer" ref={layer}/></div>
  </>
}
