import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const temporary = await mkdtemp(path.join(tmpdir(), 'focus-desktop-'))
const data = path.join(temporary, 'profile')
const source = path.join(temporary, 'sample.md')
const textFile = path.join(temporary, 'sample.txt')
const pdfFile = path.join(temporary, 'sample.pdf')
const corrupt = path.join(temporary, 'corrupt.pdf')
const backup = path.join(temporary, 'smoke.focusbackup')
const requests = []
const mock = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  requests.push(request)
  const input = request.messages[1].content
  const content = request.messages[0].content.includes('JSON') ? '["打开比较表","核对成本"]' : '这段原文讲的是中断恢复。'
  function reply() {
    if (res.destroyed) return
    res.writeHead(input === 'return 429' ? 429 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  }
  if (input === 'delay') setTimeout(reply, 1200)
  else reply()
})
let app
let page
const launch = async profile => {
  app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], timeout: 25000 })
  page = await app.firstWindow({ timeout: 25000 })
  page.setDefaultTimeout(15000)
  page.on('console', message => { if (message.type() === 'error') console.error('Renderer:', message.text()) })
  page.on('pageerror', error => console.error('Renderer exception:', error.message))
  await page.getByRole('heading', { name: '开始，或接着做。' }).waitFor({ timeout: 20000 })
}
const navigate = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
const click = name => page.getByRole('button', { name, exact: true }).click()
const snapshot = async () => {
  const result = await page.evaluate(() => window.focusResume.state())
  assert.ok(result.ok, result.error)
  return result.value
}
const invoke = async (name, ...args) => {
  const result = await page.evaluate(([name, args]) => window.focusResume[name](...args), [name, args])
  assert.ok(result.ok, result.error)
  return result.value
}
const loadDialog = selected => app.evaluate(({ dialog }, selected) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
}, selected)
const work = session => session.segments.filter(item => item.kind === 'work').reduce((sum, item) => sum + item.duration, 0)
function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 420] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 49 >>\nstream\nBT /F1 16 Tf 25 350 Td (Focus Resume page 1) Tj ET\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 420] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'
    return offset
  })
  return pdf + 'xref\n0 8\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + pdf.length + '\n%%EOF'
}

try {
  await Promise.all([
    writeFile(source, '# 第一节\n\n这是一期阅读工作区的测试内容。\n\n## 第二节\n\n原文位置会保存。'),
    writeFile(textFile, '测试文本\n\n第二段'), writeFile(pdfFile, samplePdf()), writeFile(corrupt, '%PDF-1.7\nbroken'),
    new Promise((resolve, reject) => mock.once('error', reject).listen(0, '127.0.0.1', resolve))
  ])
  await launch(data)
  const captureWindow = app.waitForEvent('window')
  await invoke('desktop', 'capture')
  const capturePage = await captureWindow
  await capturePage.getByLabel('记下临时想到的事').fill('会话外记下的念头')
  await capturePage.getByRole('button', { name: '保存并返回' }).click()
  await navigate('随手记收件箱')
  await page.getByText('会话外记下的念头', { exact: true }).waitFor()
  assert.equal((await snapshot()).state.sessions.length, 0)
  await navigate('开始与继续')
  await page.getByLabel('这次想做什么？').fill('比较两个方案')
  await click('开始工作')
  await page.getByRole('heading', { name: '比较两个方案', exact: true }).waitFor()
  await page.getByLabel('本次目标').fill('列出比较维度')
  await page.getByLabel('本次目标').press('Tab')
  await page.waitForFunction(async () => (await window.focusResume.state()).value.state.tasks[0].card.goal === '列出比较维度')
  await page.getByLabel('下一步', { exact: true }).fill('先比较成本')
  await page.getByLabel('下一步', { exact: true }).press('Tab')
  await page.waitForFunction(async () => (await window.focusResume.state()).value.state.tasks[0].card.next === '先比较成本')
  const original = (await snapshot()).state.tasks[0]
  await click('暂停')
  await page.getByText('已暂停', { exact: true }).first().waitFor()
  await click('继续工作')
  await page.getByRole('main').getByRole('button', { name: '随手记', exact: true }).click()
  await page.getByLabel('记下临时想到的事').fill('回邮件')
  await click('保存并返回')
  const working = (await snapshot()).state.sessions[0]
  assert.equal(working.thoughts[0].text, '回邮件')
  assert.equal(working.status, 'working')
  await click('结束本次工作')
  await page.getByLabel('本次成果').fill('已比较成本')
  await click('保存并结束')
  await page.getByRole('heading', { name: '任务与记录', exact: true }).waitFor()
  assert.equal((await snapshot()).state.tasks[0].status, 'open')

  await navigate('阅读工作区')
  await loadDialog(source)
  await click('导入文档')
  await page.getByRole('heading', { name: '第一节', exact: true }).waitFor()
  assert.equal((await snapshot()).state.sessions.length, 1)
  await click('开始阅读')
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor()
  const reader = (await snapshot()).state.tasks.find(item => item.docId)
  assert.ok(reader)
  await page.getByLabel('本页或本段笔记').fill('原文笔记')
  await click('保存笔记')
  await page.getByText('原文笔记', { exact: true }).waitFor()
  await click('制作复习卡')
  await page.getByLabel('问题', { exact: true }).fill('阅读位置如何处理？')
  await page.getByLabel('参考答案', { exact: true }).fill('原文位置会保存。')
  await click('保存复习卡')
  await navigate('阅读复习')
  const review = page.getByRole('region', { name: '当前复习卡' })
  await review.getByRole('heading', { name: '阅读位置如何处理？' }).waitFor()
  assert.equal(await review.getByText('原文位置会保存。', { exact: true }).count(), 0)
  await click('显示参考答案')
  await review.getByText('原文位置会保存。', { exact: true }).waitFor()
  await click('想起来了')
  await page.getByRole('heading', { name: '当前没有到期的复习卡' }).waitFor()
  const reviewedAt = (await snapshot()).state.studyCards[0].reviews[0].at
  assert.equal((await snapshot()).state.studyCards[0].dueAt - reviewedAt, 86400000)
  await page.getByText('已复习 1 次', { exact: true }).click()
  await click('回到原文')
  await page.getByRole('heading', { name: '第一节', exact: true }).waitFor()
  assert.equal((await snapshot()).state.sessions.length, 2)
  const panelWindow = app.waitForEvent('window')
  await invoke('desktop', 'panel')
  const panel = await panelWindow
  await navigate('开始与继续')
  await panel.getByRole('button', { name: '打开继续卡片' }).click()
  await page.getByRole('heading', { name: '阅读工作区' }).waitFor()
  await panel.close()
  await rm(source)

  const endpoint = 'http://127.0.0.1:' + mock.address().port + '/v1'
  await invoke('command', { type: 'settings', settings: { aiEnabled: true, endpoint, model: 'mock' } })
  await click('建议下一步')
  await page.getByLabel('本次发送').fill('仅发送确认的内容')
  await click('生成')
  await page.getByRole('heading', { name: 'AI 下一步建议' }).waitFor()
  assert.equal(requests.at(-1).messages[1].content, '仅发送确认的内容')
  await invoke('command', { type: 'start', taskId: original.id, expected: (await snapshot()).state.sessions.at(-1).id, planMinutes: 0 })
  await click('写入原任务')
  let state = (await snapshot()).state
  assert.equal(state.tasks.find(item => item.id === reader.id).card.next, '打开比较表')
  assert.equal(state.tasks.find(item => item.id === original.id).card.next, '先比较成本')
  const documentId = reader.docId
  const explanation = await invoke('ai', { kind: 'explain', taskId: reader.id, docId: documentId, position: { index: 1, offset: 0 }, input: '选中的原文' })
  await invoke('adoptAi', explanation.id, 0)
  assert.equal((await snapshot()).state.notes.at(-1).source, 'ai')
  assert.equal((await snapshot()).state.notes.at(-1).position.index, 1)
  const failure = await page.evaluate(draft => window.focusResume.ai(draft), {
    kind: 'explain', taskId: reader.id, docId: documentId, position: { index: 1, offset: 0 }, input: 'return 429'
  })
  assert.match(failure.error, /请求过多/)
  const slow = page.evaluate(draft => window.focusResume.ai(draft), {
    kind: 'explain', taskId: reader.id, docId: documentId, position: { index: 1, offset: 0 }, input: 'delay'
  })
  for (let attempt = 0; attempt < 100 && requests.at(-1)?.messages[1].content !== 'delay'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(requests.at(-1)?.messages[1].content, 'delay')
  await invoke('cancelAi')
  assert.match((await slow).error, /已取消/)

  await loadDialog(corrupt)
  await click('导入文档')
  await page.getByRole('alert').filter({ hasText: 'PDF 无法打开' }).waitFor()
  assert.equal((await snapshot()).state.documents.length, 1)
  await loadDialog(textFile)
  await click('导入文档')
  await page.getByText('测试文本', { exact: true }).waitFor()
  await loadDialog(pdfFile)
  await click('导入文档')
  await page.locator('.textLayer').getByText('Focus Resume page 1').waitFor({ state: 'attached' })
  await click('下一页')
  await page.getByText('该页没有可选原文', { exact: false }).waitFor()
  await page.waitForFunction(async () => (await window.focusResume.state()).value.state.documents.find(doc => doc.format === 'pdf').position.index === 1)
  await app.evaluate(({ dialog }, backup) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: backup }) }, backup)
  assert.equal(await invoke('backup'), true)
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'))
  assert.equal((await snapshot()).state.sessions.at(-1).status, 'paused')
  const last = (await snapshot()).state.sessions.at(-1)
  await invoke('command', { type: 'resume', sessionId: last.id })
  await page.waitForFunction(async () => (await window.focusResume.state()).value.state.sessions.at(-1).segments.at(-1).duration > 0)
  const checkpoint = (await snapshot()).state.sessions.at(-1)
  const child = app.process()
  const closed = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL')
  await closed
  await launch(data)
  state = (await snapshot()).state
  assert.equal(state.sessions.at(-1).status, 'paused')
  assert.equal(state.sessions.at(-1).reason, 'recovered')
  assert.ok(work(state.sessions.at(-1)) >= work(checkpoint))
  assert.ok(work(state.sessions.at(-1)) - work(checkpoint) < 10_000)
  assert.match(new TextDecoder().decode(Uint8Array.from(Object.values(await invoke('document', documentId)))), /第一节/)
  await app.close()
  await launch(path.join(temporary, 'clean'))
  await loadDialog(backup)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  assert.equal(await invoke('restore'), true)
  state = (await snapshot()).state
  assert.equal(state.documents.length, 3)
  assert.equal(state.notes.length, 2)
  assert.equal(state.inbox[0].text, '会话外记下的念头')
  assert.equal(state.studyCards[0].reviews[0].rating, 'remembered')
  assert.equal(state.settings.aiEnabled, false)
  assert.equal(state.sessions.at(-1).status, 'paused')
  console.log('Electron smoke passed: task, reader, backup, AI, lock and forced restart')
} finally {
  await app?.close().catch(() => undefined)
  await new Promise(resolve => mock.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
