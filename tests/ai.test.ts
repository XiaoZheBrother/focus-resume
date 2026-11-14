import { test } from 'node:test'
import assert from 'node:assert/strict'
import { complete, completionUrl } from '../src/ai'

test('compatible completion forwards only the reviewed user input and parses a bounded suggestion list', async () => {
  const reviewed = '用户已删减后的内容'
  const mock: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
    assert.equal(init?.redirect, 'error')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fake-test-key')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[1].content, reviewed)
    return Response.json({ choices: [{ message: { content: '["列出第一条约束","核对源文件"]' } }] })
  }
  assert.deepEqual(await complete('https://api.deepseek.com', 'mock', 'fake-test-key', 'suggest', reviewed, new AbortController().signal, mock),
    ['列出第一条约束', '核对源文件'])
})

test('compatible errors and cancellation are clear without repeating a request', async () => {
  for (const [status, error] of [[401, /鉴权/], [429, /请求过多/]] as const) {
    let calls = 0
    await assert.rejects(complete('http://127.0.0.1:1234/v1', 'mock', undefined, 'explain', '选中文本',
      new AbortController().signal, async () => { calls++; return new Response(null, { status }) }), error)
    assert.equal(calls, 1)
  }
  const token = new AbortController()
  const operation = complete('http://localhost:1234/v1', 'mock', undefined, 'explain', '选中文本', token.signal,
    (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
  token.abort()
  await assert.rejects(operation, /已取消/)
  assert.throws(() => completionUrl('http://example.org'), /HTTPS/)
  assert.throws(() => completionUrl('https://user:password@example.org'), /HTTPS/)
})
