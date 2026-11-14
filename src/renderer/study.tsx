import { useState, type FormEvent } from 'react'
import { ArrowRight, BookmarkPlus, BookOpen, Check } from 'lucide-react'
import type { Document, Position, ReviewRating, StudyCard } from '../shared/model'

export type StudyDraft = { position: Position; answer: string }

export function studyLocation(doc: Document, position: Position) {
  return '第 ' + (position.index + 1) + (doc.format === 'pdf' ? ' 页' : ' 段')
}

export function StudyCardForm({ draft, doc, save, close }: {
  draft: StudyDraft; doc: Document; save: (question: string, answer: string) => Promise<void>; close: () => void
}) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState(draft.answer)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !question.trim() || !answer.trim()) return
    setBusy(true)
    try { await save(question, answer) } catch { /* The workspace displays errors. */ }
    finally { setBusy(false) }
  }
  return <form className="study-form" onSubmit={submit}>
    <p className="muted">{doc.name} · {studyLocation(doc, draft.position)}</p>
    <label>问题<input value={question} maxLength={500} autoFocus placeholder="你下次想回忆什么？"
      onChange={event => setQuestion(event.target.value)} required /></label>
    <label>参考答案<textarea rows={4} value={answer} maxLength={6000}
      onChange={event => setAnswer(event.target.value)} required /></label>
    <div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={close}>取消</button>
      <button className="button primary" disabled={busy || !question.trim() || !answer.trim()}>
        <BookmarkPlus size={16}/>保存复习卡</button></div>
  </form>
}

export function StudyPage({ cards, documents, now, openSource, saveReview, remove }: {
  cards: StudyCard[]; documents: Document[]; now: number
  openSource: (doc: Document, position: Position) => void
  saveReview: (card: StudyCard, rating: ReviewRating) => Promise<void>
  remove: (card: StudyCard) => void
}) {
  const [filter, setFilter] = useState('all')
  const byId = new Map(documents.map(doc => [doc.id, doc]))
  const shown = cards.filter(card => filter === 'all' || card.docId === filter)
  const due = shown.filter(card => card.dueAt <= now).toSorted((a, b) => a.dueAt - b.dueAt)
  const current = due[0]
  const source = current && byId.get(current.docId)
  const next = shown.filter(card => card.dueAt > now).toSorted((a, b) => a.dueAt - b.dueAt)[0]
  return <>
    <div className="page-heading"><h1>阅读复习</h1><p>先用自己的话回答，再对照参考答案和原文。</p></div>
    <div className="inline study-summary">
      <strong role="status">{due.length} 张待复习 · 共 {shown.length} 张</strong>
      {documents.length > 0 && <label>文档<select value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">全部文档</option>
        {documents.map(doc => <option key={doc.id} value={doc.id}>{doc.name}</option>)}
      </select></label>}
    </div>
    {current && source ? <StudyReview key={current.id + ':' + current.reviews.length} card={current} doc={source}
      openSource={openSource} saveReview={saveReview}/> : <section className="card empty">
      {shown.length ? <Check size={30}/> : <BookOpen size={30}/>}
      <h2>{shown.length ? '当前没有到期的复习卡' : '还没有复习卡'}</h2>
      <p>{next ? '最近一次复习将在 ' + new Date(next.dueAt).toLocaleString('zh-CN') :
        '打开一份文档，选中文本或在当前页创建一张复习卡。'}</p>
    </section>}
    {shown.length > 0 && <section className="card listing study-library">
      <div className="list-head"><h2>复习卡列表</h2></div>
      {shown.toReversed().map(card => {
        const doc = byId.get(card.docId)
        if (!doc) return null
        return <details className="session-history" key={card.id}>
          <summary><strong>{card.question}</strong><span>已复习 {card.reviews.length} 次</span></summary>
          <div className="session-detail">
            <p>{doc.name} · {studyLocation(doc, card.position)}</p>
            <p>{card.dueAt <= now ? '已到期' : '下次复习 ' + new Date(card.dueAt).toLocaleString('zh-CN')}</p>
            <div className="inline"><button className="link" onClick={() => openSource(doc, card.position)}>回到原文</button>
              <button className="link danger" onClick={() => remove(card)}>删除复习卡</button></div>
          </div>
        </details>
      })}
    </section>}
  </>
}

function StudyReview({ card, doc, openSource, saveReview }: {
  card: StudyCard; doc: Document; openSource: (doc: Document, position: Position) => void
  saveReview: (card: StudyCard, rating: ReviewRating) => Promise<void>
}) {
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const choices: { id: ReviewRating; label: string }[] = [
    { id: 'again', label: '没想起来' }, { id: 'partial', label: '想起一部分' }, { id: 'remembered', label: '想起来了' }
  ]
  return <section className="card study-review" aria-label="当前复习卡">
    <div className="muted">{doc.name} · {studyLocation(doc, card.position)}</div>
    <h2>{card.question}</h2>
    {!revealed ? <button className="button primary" onClick={() => setRevealed(true)}>显示参考答案<ArrowRight size={16}/></button> : <>
      <div className="study-answer"><h3>参考答案</h3><p>{card.answer}</p></div>
      <button className="link" onClick={() => openSource(doc, card.position)}><BookOpen size={16}/>回到原文</button>
      <div className="study-rating">
        <h3>刚才想起了多少？</h3>
        <div className="inline">{choices.map(choice => <button key={choice.id}
          className={'button ' + (choice.id === 'remembered' ? 'primary' : '')} disabled={busy} onClick={async () => {
            setBusy(true)
            try { await saveReview(card, choice.id) } catch { /* Keep the card available. */ }
            finally { setBusy(false) }
          }}>{choice.label}</button>)}</div>
      </div>
    </>}
  </section>
}
