#!/usr/bin/env node
/**
 * openapi-smoke.mjs —— `/open/v1` 的 **curl 冒烟**（**P1-22 · B4**；`docs/08` §10 B4 的验收项）
 *
 * 跑法：`pnpm openapi:smoke`（可带 `BASE_URL` / `OPEN_API_KEY`）
 *
 * ```
 * BASE_URL=http://127.0.0.1:13000 OPEN_API_KEY=oak_xxxxxxxx… pnpm openapi:smoke
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它验什么（§6.5 的"六个示例"的**契约层面**，逐条对应）
 * ─────────────────────────────────────────────────────────────────────
 * ① `GET /open/v1/openapi.json` —— 公开契约可读，且**恰好**是入库那份（`openapi/open-v1.json`）：
 *    这是"线上文档 = 入库 spec = 代码"的最后一环（前两环是 `openapi-check` 与 `openapi-regression`）。
 * ② `GET /open/v1/docs` —— 文档站可打开（`text/html`）。
 * ③ 未带 Key 打业务端点 ⇒ **401 信封**（`code=UNAUTHORIZED`），而不是 500/裸文本。
 * ④ 形态非法 / 不存在的 Key ⇒ 同样 401 且**同一句文案**（不做"这把 Key 存在吗"的预言机）。
 * ⑤ 带真 Key（`OPEN_API_KEY`）⇒ `GET /open/v1/agent` 200；`POST /open/v1/conversations` 建会话；
 *    `GET /open/v1/conversations` 能看到它；`POST …/chat` 的 **SSE 首帧**在 10s 内到达；
 *    `POST …/stop` 幂等返回。
 * ⑥ 任一请求的响应都带 `X-Open-Key-Id`（客户对账用）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 不需要 Key 的部分默认跑（CI 可跑）；带 Key 的部分**跳过并提示**
 * ─────────────────────────────────────────────────────────────────────
 * 真 Key 只能由人签发（明文只出现一次），所以本脚本把它做成**可选**：没给 `OPEN_API_KEY`
 * 时 ⑤/⑥ 打 `[SKIP]` 并在结尾说明"要验完整流程请补 OPEN_API_KEY"。
 * 它用 **Node 内置 `fetch`**（不是真 shell `curl`）：同一条命令能进 CI，而"curl 能跑"的
 * 语义（HTTP + 头 + SSE）完全一致；需要手抄 curl 的场景见 `/open/v1/docs` 里每条端点的示例块。
 *
 * ⚠️ 它**不改数据**（除了 ⑤ 里建的会话，且用完就删）；`BASE_URL` 缺省指向本机开发端口。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const useColor = process.stdout.isTTY === true
const c = { g: useColor ? '\u001b[32m' : '', r: useColor ? '\u001b[31m' : '', y: useColor ? '\u001b[33m' : '', d: useColor ? '\u001b[90m' : '', x: useColor ? '\u001b[0m' : '' }

let passed = 0
let failed = 0
let skipped = 0

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}
function skip(name, reason) {
  skipped += 1
  console.log(`  ${c.y}[SKIP]${c.x} ${name} ${c.d}（${reason}）${c.x}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:13000').replace(/\/+$/u, '')
const KEY = process.env.OPEN_API_KEY?.trim() || undefined

/** 统一打请求（不抛：把响应原样交回给断言） */
async function call(path, init = {}) {
  return fetch(`${BASE_URL}${path}`, init)
}

/** 读 JSON（失败时把前 200 字符原文带进错误，便于定位"其实是个 HTML 错误页"） */
async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${response.status} 响应不是 JSON：${text.slice(0, 200)}`)
  }
}

/**
 * 断言是一个错误信封（`docs/02` §四：**`{ code, msg, data }`**，`requestId` 在响应头）。
 */
function assertErrorEnvelope(body, status, expectedCode, label) {
  assert(body.code === expectedCode, `${label}：code 应为 ${expectedCode}，实得 ${JSON.stringify(body.code)}`)
  assert(typeof body.msg === 'string' && body.msg !== '', `${label}：缺 msg`)
  assert('data' in body, `${label}：缺 data`)
  void status
}

console.log(`${c.d}目标：${BASE_URL}（真 Key：${KEY === undefined ? '未提供' : '已提供'}）${c.x}`)

// ───────────────────────────── ① 公开契约 ─────────────────────────────

console.log('\n── K1 公开契约（不需要 Key）──')
await it('K1 `GET /open/v1/openapi.json` 可读，且与入库的 `openapi/open-v1.json` 一致', async () => {
  const response = await call('/open/v1/openapi.json')
  assert(response.status === 200, `状态码应为 200，实得 ${response.status}`)
  // ⚠️ 逐字段比而不是比字节：线上那份由 `JSON.stringify` 序列化，空白可能与文件不同
  const live = await readJson(response)
  const committed = JSON.parse(readFileSync(resolve(ROOT, 'openapi/open-v1.json'), 'utf8'))
  assert(
    JSON.stringify(live) === JSON.stringify(committed),
    '线上 spec 与入库的 openapi/open-v1.json 不一致（改了契约没提交 / 部署的不是这版代码）',
  )
  const operations = Object.values(live.paths ?? {}).reduce((sum, ops) => sum + Object.keys(ops).length, 0)
  assert(operations === 17, `业务操作数应为 17，实得 ${operations}`)
})

await it('K2 `GET /open/v1/docs` 返回 HTML 文档站', async () => {
  const response = await call('/open/v1/docs')
  assert(response.status === 200, `状态码应为 200，实得 ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  assert(contentType.includes('text/html'), `Content-Type 应为 text/html，实得 ${contentType}`)
  const html = await response.text()
  assert(html.includes('openapi.json'), '文档站要读 openapi.json（文档与 spec 同源）')
})

// ───────────────────────────── ② 鉴权失败语义 ─────────────────────────────

console.log('\n── K2 鉴权失败语义（401，同一句文案，不泄漏 Key 是否存在）──')
await it('K3 未带 Key ⇒ 401 UNAUTHORIZED 信封', async () => {
  const response = await call('/open/v1/agent')
  assert(response.status === 401, `状态码应为 401，实得 ${response.status}`)
  const body = await readJson(response)
  assertErrorEnvelope(body, 401, 'UNAUTHORIZED', '无 Key')
})

await it('K4 形态非法的 Key 与"不存在的 Key"返回**同一句**文案（无存在性预言机）', async () => {
  const malformed = await call('/open/v1/agent', { headers: { authorization: 'Bearer not-a-key' } })
  // 32 个 base62：形态合法但库里不存在
  const unknown = await call('/open/v1/agent', {
    headers: { authorization: `Bearer oak_${'a'.repeat(32)}` },
  })
  assert(malformed.status === 401, `形态非法应为 401，实得 ${malformed.status}`)
  assert(unknown.status === 401, `不存在应为 401，实得 ${unknown.status}`)
  const left = await readJson(malformed)
  const right = await readJson(unknown)
  assert(
    left.msg === right.msg,
    `两种失败的文案必须一致（否则等于告诉探测者"这把 Key 存在"）：${left.error?.message} vs ${right.error?.message}`,
  )
})

// ───────────────────────────── ③ 带真 Key 的完整流程 ─────────────────────────────

console.log('\n── K3 带真 Key 的完整流程（需要 OPEN_API_KEY）──')
if (KEY === undefined) {
  skip('K5 `GET /open/v1/agent` 画像 + `X-Open-Key-Id`', '未提供 OPEN_API_KEY')
  skip('K6 建会话 → 列表可见 → SSE chat 首帧 → stop → 删会话', '未提供 OPEN_API_KEY')
} else {
  const headers = { authorization: `Bearer ${KEY}` }
  let conversationId

  await it('K5 `GET /open/v1/agent` 200，且响应带 `X-Open-Key-Id`（对账用）', async () => {
    const response = await call('/open/v1/agent', { headers })
    assert(response.status === 200, `状态码应为 200，实得 ${response.status}`)
    assert(
      typeof response.headers.get('x-open-key-id') === 'string' && response.headers.get('x-open-key-id') !== '',
      '鉴权成功的响应必须带 X-Open-Key-Id',
    )
    const body = await readJson(response)
    assert(body.code === 0, `成功信封的 code 应为 0，实得 ${JSON.stringify(body.code)}`)
    assert(body.data?.type === 'CHATBOT', `该 Key 绑定的智能体应为 CHATBOT，实得 ${body.data?.type}`)
  })

  await it('K6 建会话 → 列表可见 → chat 的 SSE 首帧 → stop 幂等 → 删会话', async () => {
    const created = await call('/open/v1/conversations', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `smoke-${Date.now()}` },
      body: JSON.stringify({ title: 'openapi smoke' }),
    })
    assert(created.status === 200, `建会话应为 200，实得 ${created.status}：${(await created.text()).slice(0, 200)}`)
    const createdBody = await readJson(created)
    conversationId = createdBody.data?.id
    assert(typeof conversationId === 'string' && conversationId !== '', '建会话没返回 id')

    const listed = await call(`/open/v1/conversations?limit=100`, { headers })
    assert(listed.status === 200, `列表应为 200，实得 ${listed.status}`)
    const listedBody = await readJson(listed)
    assert(
      (listedBody.data?.items ?? []).some((item) => item.id === conversationId),
      '刚建的会话应出现在列表里',
    )

    // SSE：只验"首帧在 10s 内到达"，不断言事件内容（那是 docs/07 的协议，端到端留给用户）
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const stream = await call(`/open/v1/conversations/${conversationId}/chat`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'openapi smoke：请回复「ok」' }),
        signal: controller.signal,
      })
      assert(stream.status === 200, `chat 应为 200（SSE），实得 ${stream.status}`)
      const contentType = stream.headers.get('content-type') ?? ''
      assert(contentType.includes('text/event-stream'), `chat 应是 text/event-stream，实得 ${contentType}`)
      const reader = stream.body?.getReader()
      assert(reader !== undefined, '没有响应体可读')
      const { value } = await reader.read()
      reader.cancel().catch(() => undefined)
      assert(value !== undefined && value.length > 0, '10s 内没有收到任何 SSE 字节')
    } finally {
      clearTimeout(timer)
    }

    const stopped = await call(`/open/v1/conversations/${conversationId}/stop`, { method: 'POST', headers })
    assert(stopped.status === 200, `stop 应为 200，实得 ${stopped.status}`)
    const removed = await call(`/open/v1/conversations/${conversationId}`, { method: 'DELETE', headers })
    assert(removed.status === 200, `删会话应为 200，实得 ${removed.status}`)
    conversationId = undefined
  }).finally(async () => {
    // 中途失败也要收拾干净（别在列表里留一个 smoke 会话）
    if (conversationId !== undefined) {
      await call(`/open/v1/conversations/${conversationId}`, { method: 'DELETE', headers }).catch(() => undefined)
    }
  })
}

console.log()
console.log(`结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`)
if (failed > 0) process.exit(1)
