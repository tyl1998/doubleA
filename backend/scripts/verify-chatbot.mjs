/**
 * P0-1-27 验收：ChatBot 编排循环（并发闸 / 检索块 / 流式透传 / 引用 / 落库 / 历史）
 *
 * 依据：`docs/06-实施计划.md` P0-1-27 的**验收原文**三条 + `docs/02` §六（编排步骤）
 *      + §5.1（事件全集）+ §十三（TTFT 打点）+ `01` 决策 12（未命中不编造引用）/ 决策 15（停止即中断）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一档为什么要"真进程 + 真 TCP + 两个假上游"
 * ─────────────────────────────────────────────────────────────────────
 * · **真进程**：本批的产物只存在于**时间轴**上（增量到达的先后、停止的时机、并发的重叠）——
 *   `app.inject` 拿到的是"已经拼好的响应"，它观察不到任何时间轴（P0-1-26 的结论：
 *   用 inject 写的 SSE 验收可以在三个实现 bug 全都在的情况下全绿）。
 * · **假对话上游**（`fixtures/chat-upstream.mjs`）：验"增量按原样透传""结束原因""usage 透传"
 *   以及**发给上游的报文对不对**（system 里的检索块、历史轮数、`stream:true`、
 *   `stream_options` 不该出现）。接真厂商在这里是纯噪声。
 * · **假 embedding 上游**（`fixtures/embedding-upstream.mjs`，`semantic: true`）：本机 `.env` 是
 *   `EMBEDDING_MODE=api` 且三项为空 ⇒ 文档走不到 `READY`、检索也拿不到 query 向量。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 注入的特征值（**故意都不是默认值**，`06` P0-1-15 的手法）
 * ─────────────────────────────────────────────────────────────────────
 * | 变量 | 值 | 为什么必须换 |
 * |------|----|--------------|
 * | `CHATBOT_CONCURRENCY` | **1** | 上限 50 时无法在验收里制造"满了"；1 时第二条流必然被拒 |
 * | `CONTEXT_ROUNDS` | **3** | 上限 20 时要造 40+ 条消息才看得出截断；3 让"刚好取最近 3 轮"可断言 |
 * | `SSE_PING_INTERVAL_SEC` | **1** | 心跳/停止轮询/锁 TTL 一起变小（P0-1-26 同款） |
 * | `EMBEDDING_*` | 假上游 | 见上 |
 * ⚠️ 换掉 `CONTEXT_ROUNDS` 的代价：本档**不能**用"20 轮"这个数字写断言，一律读 `config.limits.contextRounds`
 * （否则改配置就会让断言假红 —— P0-1-18 的教训："阈值边界用例按当前配置值生成，别写死"）。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`（PG + Redis + MinIO 都要 ——
 * 文档要真的落 S3 才能走完流水线）。
 * ⚠️ 本脚本自己起停后端子进程（它内含流水线 worker），**不要**同时开着 `pnpm dev:backend` 跑同一批数据。
 * 看服务端细节：`LOG_LEVEL` 默认给 `info`（本档要读 TTFT 那条日志），日志都在脚本内存里，
 * 失败时会连同断言一起打出来；需要更细时加 `CHATBOT_DEBUG=1`。
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = resolve(BACKEND_DIR, 'dist/backend/src/index.js')

const { startFakeChatUpstream } = await import('./fixtures/chat-upstream.mjs')
const { startFakeEmbeddingUpstream } = await import('./fixtures/embedding-upstream.mjs')

const chatUpstream = await startFakeChatUpstream()
const embeddingUpstream = await startFakeEmbeddingUpstream({ semantic: true })

const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { getS3Client } = await import('../dist/backend/src/infra/s3.js')
const { config } = await import('../dist/backend/src/config.js')
const {
  conversationItemSchema,
  conversationListResultSchema,
  uploadDocumentResultSchema,
} = await import('@doubulea/shared')

// ───────────────────────────── 断言脚手架（与其余脚本同一套）─────────────────────────────

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  y: useColor ? '\u001b[33m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

/**
 * **键序无关**的规范化 JSON —— 凡是比较"经过 jsonb 往返的值"都必须用它。
 *
 * ⚠️ 一次真跑抓出来的：`messages.content` 是 **jsonb**，Postgres 会把对象键**重排**
 * （先按键长、再按字节序）⇒ "写进去时的 `{text, thinking, citations}`"与"读出来时的
 * `{score, docName, snippet}`"用 `JSON.stringify` 直接比**必然不等**。
 * 那不是契约问题 —— **对象键序本来就不是契约**（本仓从 P0-1-17 起一律"按集合/排序后比较"）。
 * 症状特别好认：期望值与实际值在报告里**看着一模一样**，只有键的顺序不同。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const groups = []

function groupStart(id, title, note) {
  // 分组计数用"快照差值"算：`it` 只管累加总数，收尾时与下一组的起点相减即得本组成绩
  groups.push({ id, title, note, basePassed: passed, baseFailed: failed })
  console.log(`\n${c.b}── ${id}｜${title}${c.x}`)
  if (note !== undefined) console.log(`   ${c.d}${note}${c.x}`)
}

function groupResult(group, index) {
  const next = groups[index + 1]
  const donePassed = (next?.basePassed ?? passed) - group.basePassed
  const doneFailed = (next?.baseFailed ?? failed) - group.baseFailed
  return { donePassed, doneFailed }
}

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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const nowMs = () => Date.now()

/**
 * 等一个条件成立。
 *
 * ⚠️ **必须 `await predicate(...)`**：本档的谓词**全是 async**（都要打接口或查库）。
 * 漏 `await` 会让"每一次等待都瞬间通过" ⇒ 造出**假绿**，而那比假红贵得多
 * （P0-1-26 就因此把一个真 bug 盖了整整一轮，见本仓批量工作流技能的断言形态 ⑬）。
 */
async function waitUntil(predicate, timeoutMs, label, intervalMs = 25) {
  const deadline = nowMs() + timeoutMs
  let last
  for (;;) {
    last = await predicate()
    if (last) return true
    if (nowMs() > deadline) {
      throw new Error(`${label}：等待超时（${timeoutMs}ms），最后观察值 ${JSON.stringify(last)}`)
    }
    await sleep(intervalMs)
  }
}

function frameNames(frames) {
  return frames.map((frame) => frame.event)
}

function hasEvent(frames, name) {
  return frames.some((frame) => frame.event === name)
}

function firstFrameOf(frames, name) {
  return frames.find((frame) => frame.event === name)
}

function framesOf(frames, name) {
  return frames.filter((frame) => frame.event === name)
}

// ───────────────────────────── 常量与临时数据 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-ChatBot-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-bot-admin-${suffix}`
const ownerUsername = `verify-bot-owner-${suffix}`
const providerKey = `sk-verify-chatbot-${suffix}`

/** 注入的特征值（见文件头；`CONTEXT_ROUNDS` 的期望值也从这里取，别写死 20） */
const CONTEXT_ROUNDS = 3
const CHATBOT_CONCURRENCY = 1
const PING_SEC = 1

const port = Number.parseInt((process.env.CHATBOT_PORT ?? '').trim() || '13098', 10)
const baseUrl = `http://127.0.0.1:${port}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdConversationIds = []
const createdKbIds = []
const createdDocIds = []

const QUERY = '出差住宿标准'
const DOC = {
  fileName: `报销制度-${suffix}.txt`,
  content:
    '第 1 号文档（报销制度）：出差住宿标准为每晚上限 500 元，超出部分需部门负责人审批后方可报销；' +
    '市内交通费按实际发生额计入，当月票据须在次月五日前提交财务备案，逾期不予受理。',
}

const prisma = getPrisma()
const redis = getRedis()
const s3 = getS3Client()
const bucket = config.s3.bucket

// ───────────────────────────── 真实 HTTP 客户端 ─────────────────────────────

async function request(jar, method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders }
  if (jar.value !== '') headers.cookie = `${SESSION_COOKIE_NAME}=${jar.value}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (pair.slice(0, eq) !== SESSION_COOKIE_NAME) continue
    jar.value = pair.slice(eq + 1)
    if (jar.value !== '') sessionIds.push(jar.value)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    json = undefined
  }
  return { status: response.status, headers: response.headers, raw, body: json }
}

const newJar = () => ({ value: '' })

async function login(jar, username) {
  const response = await request(jar, 'POST', '/api/auth/login', { username, password: PASSWORD })
  assertEqual(response.status, 200, `登录 ${username}`)
  return jar
}

/** 建号（直接写库：`POST /api/users` 是 ADMIN 端点且会强制首登改密，验收脚本不需要那一层） */
async function createUser(username, role) {
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: await hashPassword(PASSWORD),
      nickname: `验证-${role}`,
      role,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  createdUserIds.push(user.id)
  return user
}

// ───────────────────────────── SSE 流的读侧 ─────────────────────────────

/** 解析一帧（`event:` / `data:` 两行 + 空行；详见 `orchestrator/sse.ts#serializeSseFrame`） */
function parseFrame(raw) {
  let name
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
  }
  if (name === undefined) return undefined
  try {
    return { event: name, data: JSON.parse(dataLines.join('\n')), raw, malformed: false }
  } catch {
    return { event: name, data: undefined, raw, malformed: true }
  }
}

/** 后台抽帧（帧到达时刻记进 `frames[].at`）—— 本档的断言几乎全是"过一会儿看收到了什么" */
function openStream(response, requestedAt) {
  const state = {
    frames: [],
    malformed: 0,
    ended: false,
    endedAt: undefined,
    readError: undefined,
    requestedAt,
    headersAt: nowMs(),
    text: '',
  }
  void (async () => {
    try {
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        state.text += decoder.decode(chunk, { stream: true })
        let index
        while ((index = state.text.indexOf('\n\n')) >= 0) {
          const raw = state.text.slice(0, index)
          state.text = state.text.slice(index + 2)
          const parsed = parseFrame(raw)
          if (parsed === undefined) continue
          if (parsed.malformed) state.malformed += 1
          parsed.at = nowMs()
          state.frames.push(parsed)
        }
      }
    } catch (error) {
      state.readError = error
    } finally {
      state.ended = true
      state.endedAt = nowMs()
    }
  })()
  return state
}

/** 发起对话（真 HTTP，流式）。`abort()` 用于模拟客户端断开 */
async function openChatStream(jar, conversationId, content) {
  const controller = new AbortController()
  const headers = { 'content-type': 'application/json' }
  if (jar.value !== '') headers.cookie = `${SESSION_COOKIE_NAME}=${jar.value}`
  const requestedAt = nowMs()
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
    signal: controller.signal,
  })
  if (!response.ok) {
    const raw = await response.text()
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
    return { response, stream: undefined, abort: () => controller.abort(), body: json, raw }
  }
  return { response, stream: openStream(response, requestedAt), abort: () => controller.abort() }
}

async function readActive(jar, conversationId) {
  const response = await request(jar, 'GET', `/api/conversations/${conversationId}/active`)
  assertEqual(response.status, 200, '活跃态状态码')
  return response.body.data
}

/** 等某会话空闲（上一条流收尾是异步的 ⇒ 每条要新开流的用例都该先等它） */
async function waitIdle(jar, conversationId, label = '会话空闲') {
  const idle = await waitUntil(
    async () => (await readActive(jar, conversationId)).streaming === false,
    8000,
    label,
  )
  assert(idle, `前置不成立：${label}`)
}

/** 等流收尾（收到 `done` 或 `error`）。生产上流总是二选一收尾（`shared/src/sse.ts` 文件头 ③） */
async function waitStreamEnd(stream, label, timeoutMs = 15_000) {
  await waitUntil(async () => stream.ended || stream.frames.some((f) => f.event === 'done' || f.event === 'error'), timeoutMs, label)
  // `done`/`error` 之后服务端还会 `end()`，给读循环一点时间把残余帧抽完
  await sleep(120)
  return stream
}

/** 落库的消息（按时间正序）—— 本批还没有 `GET /:id/messages`（属 P0-1-28），故直接读库 */
async function messagesOf(conversationId) {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, role: true, content: true, tokensIn: true, tokensOut: true, createdAt: true },
  })
  return rows
}

// ───────────────────────────── 业务助手（全部走真 HTTP）─────────────────────────────

async function createKb(jar, name) {
  const response = await request(jar, 'POST', '/api/knowledge-bases', {
    name,
    // `score: 0` 是刻意的：假 embedding 上游给的是"词面重叠型"向量，默认阈值 0.3 会把候选全过滤
    // （与 `verify-retrieval.mjs` 同款口径）
    retrievalConfig: { score: 0 },
  })
  assertEqual(response.status, 200, `建库（${name}）`)
  const kb = response.body.data
  createdKbIds.push(kb.id)
  return kb
}

async function uploadDocument(jar, kbId) {
  const form = new FormData()
  form.append('file', new Blob([DOC.content], { type: 'text/plain' }), DOC.fileName)
  const headers = {}
  if (jar.value !== '') headers.cookie = `${SESSION_COOKIE_NAME}=${jar.value}`
  const response = await fetch(`${baseUrl}/api/knowledge-bases/${kbId}/documents`, {
    method: 'POST',
    headers,
    body: form,
  })
  const json = await response.json()
  assertEqual(response.status, 200, '上传文档')
  const parsed = uploadDocumentResultSchema.parse(json.data)
  createdDocIds.push(parsed.document.id)
  return parsed.document
}

/** 等文档离开 PARSING（真的走完流水线：这是子进程里的 worker + 假 embedding 上游在干活） */
async function waitDocumentReady(jar, kbId, docId, label) {
  let lastStatus = null
  await waitUntil(
    async () => {
      const response = await request(jar, 'GET', `/api/knowledge-bases/${kbId}/documents?limit=100`)
      const items = response.body?.data?.items ?? []
      const found = items.find((item) => item.id === docId)
      lastStatus = found?.status ?? null
      return lastStatus === 'READY'
    },
    60_000,
    `${label}（最后状态 ${lastStatus}）`,
    200,
  )
}

async function createAgent(jar, name, payload) {
  const response = await request(jar, 'POST', '/api/agents', { name, type: 'CHATBOT', ...payload })
  assertEqual(response.status, 200, `建智能体（${name}）`)
  createdAgentIds.push(response.body.data.id)
  return response.body.data
}

async function createConversation(jar, agentId) {
  const response = await request(jar, 'POST', '/api/conversations', { agentId })
  assertEqual(response.status, 200, '建会话')
  const parsed = conversationItemSchema.parse(response.body.data)
  createdConversationIds.push(parsed.id)
  return parsed
}

async function listConversations(jar, agentId) {
  const response = await request(jar, 'GET', `/api/agents/${agentId}/conversations`)
  assertEqual(response.status, 200, '会话列表状态码')
  return conversationListResultSchema.parse(response.body.data)
}

/** 文档的唯一一块正文（引用片段的"原文"必须从库里取，不能拿夹具自己算） */
async function chunkContentOf(docId) {
  const rows = await prisma.$queryRaw`
    SELECT id::text AS id, seq, content FROM chunks WHERE doc_id = ${docId}::uuid ORDER BY seq
  `
  assertEqual(rows.length, 1, `夹具文档应恰好 1 块（正文长度控制在 chunk_size 内）`)
  return rows[0]
}

const deltaTextOf = (stream) =>
  framesOf(stream.frames, 'delta')
    .map((frame) => frame.data?.text ?? '')
    .join('')

/**
 * 数一数这些键里还有几个存在（清理段的`复核残留`用）。
 *
 * ⚠️ 刻意**逐个 `get`**，而不是 `redis.mGet(list)`：本仓 `getRedis()` 返回的 node-redis
 * 客户端上**没有 `mGet`**（一次真跑抓出来的：`redis.mGet is not a function`），
 * 而这里的列表长度就是"脚本自己造的那几个"，逐个取没有性能可言。
 * ⚠️ 也刻意**不**用 `keys('chat.active:*')` —— 那会把本机 dev server 正在跑的会话算进来 ⇒ 假红
 * （P0-1-7 的教训：复核要枚举"脚本会创建的全部键"，而不是"所有同前缀的键"）。
 */
async function countPresentKeys(keys) {
  let present = 0
  for (const key of keys) {
    const value = await redis.get(key).catch(() => null)
    if (value !== null && value !== undefined) present += 1
  }
  return present
}

// ───────────────────────────── 子进程 ─────────────────────────────

let serverLog = ''
let server
let serverExitedEarly = false

async function startServer() {
  try {
    const probe = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
    if (probe.ok) {
      throw new Error(
        `端口 ${port} 上已有服务在回答，请换端口：CHATBOT_PORT=13097 node scripts/verify-chatbot.mjs`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('已有服务')) throw error
    // 连不上才是预期的
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      BACKEND_PORT: String(port),
      SSE_PING_INTERVAL_SEC: String(PING_SEC),
      CHATBOT_CONCURRENCY: String(CHATBOT_CONCURRENCY),
      CONTEXT_ROUNDS: String(CONTEXT_ROUNDS),
      // 上游超时要收紧：夹具的 stall 模式会一直挂着，配默认值（30s+）会让失败用例把脚本拖住
      LLM_REQUEST_TIMEOUT_MS: '15000',
      LLM_STREAM_IDLE_TIMEOUT_MS: '15000',
      // 假 embedding 上游（子进程里的 worker 要靠它才能把文档送到 READY）
      EMBEDDING_MODE: 'api',
      EMBEDDING_API_URL: embeddingUpstream.url,
      EMBEDDING_API_KEY: 'verify-chatbot-embed-key',
      EMBEDDING_API_MODEL: 'verify-embed-model',
      // 队列是"被消费"的资源 ⇒ 给这个一次性进程一条独立队列
      PIPELINE_QUEUE_KEY: `verify:chatbot:jobs:${suffix}`,
      // ⚠️ 本档要读 TTFT 那条日志 ⇒ 不能像别的脚本那样收到 fatal
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
      LOG_PRETTY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => (serverLog += chunk))
  child.stderr.on('data', (chunk) => (serverLog += chunk))
  child.once('exit', () => {
    serverExitedEarly = true
  })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return child
    } catch {
      // 还没起来
    }
    await sleep(200)
  }
  throw new Error(`后端进程未能在 20s 内就绪（exitCode=${child.exitCode}）\n${serverLog}`)
}

async function stopServer() {
  if (server === undefined || server.exitCode !== null) return
  const exited = new Promise((resolveExit) => server.once('close', resolveExit))
  server.kill('SIGTERM')
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}

// ═════════════════════════════ 主流程 ═════════════════════════════

console.log(`\n${c.b}══ P0-1-27 验收：ChatBot 编排循环（检索块 / 流式透传 / 引用 / 停止 / 并发闸 / 历史）══${c.x}`)
console.log(`  ${c.d}目标：${baseUrl}（脚本自己起进程 + 两个假上游，跑完删净）${c.x}`)
console.log(
  `  ${c.d}注入：CHATBOT_CONCURRENCY=${CHATBOT_CONCURRENCY}｜CONTEXT_ROUNDS=${CONTEXT_ROUNDS}｜` +
    `SSE_PING_INTERVAL_SEC=${PING_SEC}｜假对话上游 ${chatUpstream.url}${c.x}`,
)

try {
  await redis.ping()
  await prisma.$queryRaw`SELECT 1`
} catch (error) {
  console.error(
    `\n${c.r}✖ 本验收需要真实的 PG 与 Redis${c.x}\n  先执行：pnpm infra:up && pnpm db:deploy\n  原始错误：${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exit(1)
}

try {
  // ───────────────────────────── 准备 ─────────────────────────────
  server = await startServer()
  await createUser(adminUsername, UserRole.ADMIN)
  await createUser(ownerUsername, UserRole.MEMBER)
  const adminJar = await login(newJar(), adminUsername)
  const ownerJar = await login(newJar(), ownerUsername)

  // Provider 走 API 建（Key 要真加密落库，才能断言"上游看到的是明文 Bearer"）
  const providerResponse = await request(adminJar, 'POST', '/api/model-providers', {
    name: `验证 Provider ${suffix}`,
    baseUrl: chatUpstream.url,
    type: 'CHAT',
    apiKey: providerKey,
  })
  assertEqual(providerResponse.status, 200, '建 Provider')
  const provider = providerResponse.body.data
  createdProviderIds.push(provider.id)

  const modelResponse = await request(adminJar, 'POST', '/api/models', {
    providerId: provider.id,
    modelName: `verify-chatbot-model-${suffix}`,
    label: '验证对话模型',
    type: 'CHAT',
    maxContext: 4096,
  })
  assertEqual(modelResponse.status, 200, '建模型')
  const chatModel = modelResponse.body.data
  createdModelIds.push(chatModel.id)

  const kb = await createKb(adminJar, `验证库-chatbot-${suffix}`)
  const document = await uploadDocument(adminJar, kb.id)
  await waitDocumentReady(adminJar, kb.id, document.id, '文档走到 READY')
  const chunk = await chunkContentOf(document.id)

  /** 绑了库的智能体（A / C / E 组用它） */
  const boundAgent = await createAgent(ownerJar, `验证智能体-绑库-${suffix}`, {
    modelId: chatModel.id,
    systemPrompt: `你是报销制度的专属助手（${suffix}）`,
    guideQuestions: ['出差住宿标准是多少'],
  })
  /** 不绑库的智能体（B 组用它验"未命中"） */
  const bareAgent = await createAgent(ownerJar, `验证智能体-不绑库-${suffix}`, {
    modelId: chatModel.id,
  })

  // 绑库（P0-1-23 的整体替换端点）
  const bindResponse = await request(ownerJar, 'PUT', `/api/agents/${boundAgent.id}/components`, {
    components: [{ componentType: 'KNOWLEDGE', refId: kb.id }],
  })
  assertEqual(bindResponse.status, 200, '绑定知识库')

  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${ownerUsername}（MEMBER）${c.x}`)
  console.log(`  ${c.d}知识库 ${kb.id} / 文档 ${document.id}（1 块，${chunk.content.length} 字）${c.x}`)

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'A',
    '命中知识库：引用卡 + 流式透传 + 落库（`06` 验收原文第 ① 条）',
    '引用事件先于增量 / 片段与库里的块逐字相同 / system 里真的有那段资料 / 回答只能从检索块里拿到文档名',
  )
  // ═══════════════════════════════════════════════════════════════════

  const convA = await createConversation(ownerJar, boundAgent.id)
  let streamA

  await it('发起对话：HTTP 200 + `text/event-stream`（**不是** JSON 信封）', async () => {
    const before = await listConversations(ownerJar, boundAgent.id)
    assertEqual(before.items[0].lastMessageAt, null, '新会话还没有消息')
    const opened = await openChatStream(ownerJar, convA.id, QUERY)
    streamA = opened.stream
    assert(streamA !== undefined, '应当拿到 SSE 流')
    assertEqual(opened.response.status, 200, '状态码')
    assertIncludes(
      opened.response.headers.get('content-type') ?? '',
      'text/event-stream',
      '响应类型',
    )
  })

  await it('流以 `done{COMPLETE}` 收尾，带 `messageId` 与 usage（usage 来自上游最后一帧）', async () => {
    await waitStreamEnd(streamA, 'A 组流收尾')
    assertEqual(streamA.malformed, 0, '不应有畸形帧')
    const names = frameNames(streamA.frames)
    assertEqual(names[names.length - 1], 'done', '最后一个事件必须是 done（`shared/src/sse.ts` 文件头 ③）')
    const done = firstFrameOf(streamA.frames, 'done')
    assertEqual(done.data.finishReason, 'COMPLETE', 'finishReason')
    assert(typeof done.data.messageId === 'string' && done.data.messageId !== '', 'messageId 必须非空')
    assertEqual(JSON.stringify(done.data.usage), JSON.stringify({ tokensIn: 123, tokensOut: 45 }), 'usage 透传')
    assert(!hasEvent(streamA.frames, 'error'), '正常路径不应出现 error 事件')
  })

  await it('`citations` 事件：片段与库里的那块正文**逐字相同**，且出现在增量之前', async () => {
    const citations = firstFrameOf(streamA.frames, 'citations')
    assert(citations !== undefined, '必须收到 citations 事件')
    assertEqual(citations.data.items.length, 1, '本库只有 1 块命中')
    const item = citations.data.items[0]
    assertEqual(item.docName, DOC.fileName, '引用卡上的文档名')
    assertEqual(item.snippet, chunk.content, '⚠️ 引用片段必须与库里那块正文逐字相同')
    assertEqual(typeof item.score, 'number', 'score 是融合分（数字）')
    const deltaAt = firstFrameOf(streamA.frames, 'delta')?.at ?? Infinity
    assert(citations.at <= deltaAt, '引用卡事件应当先于第一个增量（引用区在回答之前就挂上）')
  })

  await it('增量按上游原样透传：拼接后的正文与夹具脚本一致（证明"检索块真的进了 prompt"）', async () => {
    const deltas = framesOf(streamA.frames, 'delta')
    assert(deltas.length >= 2, `应当是**流式**的多个增量，实际 ${deltas.length} 个`)
    const text = deltaTextOf(streamA)
    assertIncludes(text, DOC.fileName, '回答里的文档名只可能来自注入的检索块')
    assertIncludes(text, '根据《', '夹具的标准回答形状')
  })

  await it('落库：用户消息 + 助手消息各一条，`lastMessageAt` 前进（同一事务）', async () => {
    const rows = await messagesOf(convA.id)
    assertEqual(rows.length, 2, '恰好两条消息')
    assertEqual(rows[0].role, 'USER', '第一条是用户消息')
    assertEqual(rows[0].content.text, QUERY, '用户消息正文 = 提问原文')
    assertEqual(rows[1].role, 'ASSISTANT', '第二条是助手消息')
    assertEqual(rows[1].content.text, deltaTextOf(streamA), '助手消息正文 = 收到的增量拼接（不多不少）')
    assertEqual(rows[1].tokensIn, 123, 'tokens_in 落库')
    assertEqual(rows[1].tokensOut, 45, 'tokens_out 落库')
    assertEqual(
      canonicalJson(rows[1].content.citations),
      canonicalJson(firstFrameOf(streamA.frames, 'citations').data.items),
      '落库的引用与事件里的引用是同一条（刷新后重绘的引用卡不会变样）',
    )
    const page = await listConversations(ownerJar, boundAgent.id)
    assert(page.items[0].lastMessageAt !== null, 'lastMessageAt 必须前进（`02` §4.5 ④ 的维护时点）')
  })

  await it('发给上游的报文：system 含检索块与人格、末条是 user、`stream:true`、不带 `stream_options`', async () => {
    const last = chatUpstream.requests[chatUpstream.requests.length - 1]
    assertEqual(last.method, 'POST', '方法')
    assert(last.path.endsWith('/chat/completions'), `路径应指向 chat/completions，实际 ${last.path}`)
    assertEqual(last.auth, `Bearer ${providerKey}`, '⚠️ 凭据注入：上游看到的是**明文** Key')
    assertEqual(last.body.stream, true, 'stream')
    assertEqual(last.body.model, chatModel.modelName, 'model 用的是库里那一行')
    assert(!('stream_options' in last.body), '⚠️ 刻意不发 stream_options（`02` §6.1 清单 1）')

    const messages = last.body.messages
    assertEqual(messages[0].role, 'system', '第一条是 system')
    assertIncludes(messages[0].content, `你是报销制度的专属助手（${suffix}）`, 'system 里含智能体的人格设定')
    assertIncludes(messages[0].content, '知识库检索结果', 'system 里含检索块标题')
    assertIncludes(messages[0].content, `来源：${DOC.fileName}`, 'system 里含「来源：文档名」前缀')
    assertIncludes(messages[0].content, chunk.content, '⚠️ 检索块的正文与库里那块逐字相同')
    assertIncludes(messages[0].content, '不要推测、不要编造', 'system 里含"不许编造来源"的规则')
    const lastMessage = messages[messages.length - 1]
    assertEqual(lastMessage.role, 'user', '最后一条是本轮用户消息')
    assertEqual(lastMessage.content, QUERY, '正文 = 提问原文')
  })

  await it('TTFT 打点：服务端日志里有首字延迟（`02` §十三 是阶段一"首字 < 3s"的唯一测量依据）', async () => {
    const line = serverLog
      .split('\n')
      .find((item) => item.includes('本轮首字延迟（TTFT）'))
    assert(line !== undefined, '日志里必须有 TTFT 那条（不在的话"首字 < 3s"就无从测量）')
    const parsed = JSON.parse(line)
    assert(typeof parsed.ttftMs === 'number' && parsed.ttftMs >= 0, `ttftMs 应当是数字，实际 ${line}`)
    console.log(`         ${c.d}实测 TTFT = ${parsed.ttftMs}ms（阶段一门槛 < 3000ms）${c.x}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'B',
    '未命中：不产生引用卡、prompt 明确禁止编造（`01` 决策 12）',
    '不绑库的智能体 ⇒ 检索结果为空 ⇒ 无 citations 事件 + system 里写明"没有检索到"',
  )
  // ═══════════════════════════════════════════════════════════════════

  const convB = await createConversation(ownerJar, bareAgent.id)
  let streamB

  await it('未命中：**没有** `citations` 事件（不是发一个空 items）', async () => {
    const opened = await openChatStream(ownerJar, convB.id, '我们公司的年假有几天')
    streamB = opened.stream
    await waitStreamEnd(streamB, 'B 组流收尾')
    assert(!hasEvent(streamB.frames, 'citations'), '未命中时一个引用卡都不该发（前端按"有没有事件"决定画不画）')
    const done = firstFrameOf(streamB.frames, 'done')
    assertEqual(done.data.finishReason, 'COMPLETE', 'finishReason')
  })

  await it('未命中：system 里写明"没有检索到"，回答里**不出现任何文档名**', async () => {
    const last = chatUpstream.requests[chatUpstream.requests.length - 1]
    const system = last.body.messages[0].content
    assertIncludes(system, '（本次没有检索到与问题相关的知识库内容）', '检索块必须显式写明"没有"')
    assertIncludes(system, '不要推测、不要编造文档名或来源', '规则必须在 prompt 里')
    const text = deltaTextOf(streamB)
    assert(!text.includes(DOC.fileName), `回答里不该出现任何文档名，实际：${text}`)
    assertIncludes(text, '不能凭推测编造来源', '夹具的"未命中"回答（证明它确实没拿到资料）')
  })

  await it('未命中：落库的助手消息里**不含 `citations` 键**（空数组与"没有"是两件事）', async () => {
    const rows = await messagesOf(convB.id)
    assertEqual(rows.length, 2, '两条消息')
    assert(!('citations' in rows[1].content), `落库的 content 不该有 citations 键：${JSON.stringify(rows[1].content)}`)
    assert(!('thinking' in rows[1].content), '上游没给思考增量 ⇒ 也不该有 thinking 键')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'C',
    '停止：已生成部分保留 + 可直接追问（`01` 决策 15；`06` 验收原文第 ② 条）',
    '夹具改成 40 段慢增量 ⇒ 中途 /stop ⇒ done{STOPPED} 且落库的正文恰好是已生成的部分',
  )
  // ═══════════════════════════════════════════════════════════════════

  const convC = await createConversation(ownerJar, boundAgent.id)
  const longPieces = Array.from({ length: 40 }, (_, index) => `第${index + 1}段。`)
  chatUpstream.setScript(() => longPieces)
  let streamC

  await it('流中停止：5s 内收到 `done{finishReason:STOPPED}` 且 **messageId 非空**', async () => {
    const opened = await openChatStream(ownerJar, convC.id, QUERY)
    streamC = opened.stream
    await waitUntil(async () => framesOf(streamC.frames, 'delta').length >= 3, 8000, '至少收到 3 个增量')
    const stopResponse = await request(ownerJar, 'POST', `/api/conversations/${convC.id}/stop`)
    assertEqual(stopResponse.status, 200, '停止端点状态码')
    assertEqual(stopResponse.body.data.signaled, true, 'signaled=true（确实有一个在跑的流收到了信号）')
    await waitStreamEnd(streamC, '停止后流收尾', 6000)
    const done = firstFrameOf(streamC.frames, 'done')
    assert(done !== undefined, `必须收到 done，实际帧：${JSON.stringify(frameNames(streamC.frames))}`)
    assertEqual(done.data.finishReason, 'STOPPED', 'finishReason')
    // ⚠️ 这一条是本批的关键：producer 自己接住中断并落库 ⇒ messageId 才带得回来。
    //    没接住时出口层会兜底成 `done{STOPPED, messageId:null}`（那会把已落库的那条丢掉）
    assert(
      typeof done.data.messageId === 'string' && done.data.messageId !== '',
      'producer 接住中断 ⇒ messageId 必须非空',
    )
  })

  await it('停止真的生效（增量数 < 上游脚本段数）且**已生成的部分**原样落库', async () => {
    const deltas = framesOf(streamC.frames, 'delta')
    assert(deltas.length < longPieces.length, `应当被中断，实际收到 ${deltas.length}/${longPieces.length} 段`)
    const rows = await messagesOf(convC.id)
    assertEqual(rows.length, 2, '两条消息（用户 + 已生成的部分回答）')
    assertEqual(rows[1].role, 'ASSISTANT', '第二条是助手消息')
    assertEqual(rows[1].content.text, deltaTextOf(streamC), '落库正文 = 已生成的增量拼接（正好那么多）')
    assert(rows[1].content.text !== '', '已生成的部分不能是空的')
  })

  await it('停止后可直接追问：历史（含上一轮）真的进了 prompt', async () => {
    await waitIdle(ownerJar, convC.id)
    chatUpstream.setScript(null) // 恢复默认脚本（从 system 的检索块里抄文档名那一份）
    const opened = await openChatStream(ownerJar, convC.id, '再说一遍要点')
    await waitStreamEnd(opened.stream, '追问流收尾')
    const done = firstFrameOf(opened.stream.frames, 'done')
    assertEqual(done.data.finishReason, 'COMPLETE', '追问也要正常收尾')
    const last = chatUpstream.requests[chatUpstream.requests.length - 1]
    const messages = last.body.messages
    assertEqual(messages[messages.length - 1].content, '再说一遍要点', '末条是本轮提问')
    assertEqual(messages[messages.length - 2].role, 'assistant', '倒数第二条是上一轮的回答（历史还原）')
    assertIncludes(messages[messages.length - 2].content, '第1段。', '上一轮的已生成内容进了历史')
    assertEqual(messages[messages.length - 3].content, QUERY, '再往前是本轮的第一句提问')
    const rows = await messagesOf(convC.id)
    assertEqual(rows.length, 4, '落库累计 4 条')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'D',
    `并发闸（CHATBOT_CONCURRENCY=${CHATBOT_CONCURRENCY}）：满则 **流内** \`error{BUSY}\``,
    '`02` §六 第 1 步；夹具切 stall 占住唯一名额 ⇒ 第二条流被拒，且**不落库**',
  )
  // ═══════════════════════════════════════════════════════════════════

  const convD1 = await createConversation(ownerJar, bareAgent.id)
  const convD2 = await createConversation(ownerJar, bareAgent.id)
  /** 占住唯一名额的那条流（要一直持有 `abort`，收尾时用它模拟"客户端断开"） */
  let d1

  await it('占满名额的那条流（stall）：确认真的在飞（上游已收到请求）', async () => {
    chatUpstream.setMode('stall')
    const before = chatUpstream.requests.length
    d1 = await openChatStream(ownerJar, convD1.id, '占住名额')
    assert(d1.stream !== undefined, '第一条流应当能开出来')
    await waitUntil(
      async () => chatUpstream.requests.length > before,
      8000,
      '上游收到第一条流的请求（说明它已经占住名额）',
    )
  })

  await it('第二条流：HTTP 200 + `error{code:BUSY}` 单帧事件（**不是** 429 信封）', async () => {
    const opened = await openChatStream(ownerJar, convD2.id, '这条应当被拒')
    assert(opened.stream !== undefined, '被拒也是以流的形式（主语是"这一轮生成"）')
    await waitStreamEnd(opened.stream, 'BUSY 流收尾', 8000)
    const errorFrame = firstFrameOf(opened.stream.frames, 'error')
    assert(errorFrame !== undefined, `应当收到 error 事件，实际：${JSON.stringify(frameNames(opened.stream.frames))}`)
    assertEqual(errorFrame.data.code, 'BUSY', '错误码')
    assertIncludes(
      opened.response.headers.get('content-type') ?? '',
      'text/event-stream',
      '⚠️ BUSY 走流内事件而不是 JSON 信封（主语是"这一轮生成"）',
    )
    assert(!hasEvent(opened.stream.frames, 'done'), 'error 之后不该再有 done（二选一收尾）')
  })

  await it('被拒的那一轮**一个字都没落库**（前置失败 ⇒ 这一轮没发生）', async () => {
    const rows = await messagesOf(convD2.id)
    assertEqual(rows.length, 0, '被拒的会话里不该有任何消息')
    const active = await readActive(ownerJar, convD2.id)
    assertEqual(active.streaming, false, '锁也应当已经释放')
  })

  await it('收尾：客户端断开 ⇒ 名额与锁一起释放（占位流以 done{STOPPED} 收口）', async () => {
    chatUpstream.setMode('normal')
    d1.abort()
    await waitUntil(
      async () => (await readActive(ownerJar, convD1.id)).streaming === false,
      8000,
      '断开后锁释放',
    )
    // 断线不是"什么都没发生"：已经生成的内容（这里是 0 字）与用户消息照常落库
    const rows = await messagesOf(convD1.id)
    assertEqual(rows.length, 1, '只落库了用户消息（这一轮没有产生任何内容）')
    assertEqual(rows[0].role, 'USER', '落库的是用户消息')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'E',
    `超长会话（注入 CONTEXT_ROUNDS=${CONTEXT_ROUNDS}，历史 25 轮）不报错且按轮数截断`,
    '验收原文第 ③ 条"超长会话（> 20 轮）不报错"；截断的**上限**从 config 读，别写死',
  )
  // ═══════════════════════════════════════════════════════════════════

  const convE = await createConversation(ownerJar, boundAgent.id)
  const TOTAL_ROUNDS = 25
  const baseTime = Date.now() - TOTAL_ROUNDS * 2 * 1000

  await it('造 25 轮历史（50 条消息）', async () => {
    for (let index = 0; index < TOTAL_ROUNDS; index += 1) {
      const at = new Date(baseTime + index * 2 * 1000)
      await prisma.message.create({
        data: {
          conversationId: convE.id,
          role: 'USER',
          content: { text: `历史第 ${index + 1} 轮的问题` },
          createdAt: at,
        },
      })
      await prisma.message.create({
        data: {
          conversationId: convE.id,
          role: 'ASSISTANT',
          content: { text: `历史第 ${index + 1} 轮的回答` },
          createdAt: new Date(at.getTime() + 1000),
        },
      })
    }
    const rows = await messagesOf(convE.id)
    assertEqual(rows.length, TOTAL_ROUNDS * 2, '历史消息条数')
  })

  await it(`提问：流正常收尾（不报错），且只带最近 ${CONTEXT_ROUNDS} 轮进 prompt`, async () => {
    const opened = await openChatStream(ownerJar, convE.id, '总结一下上面所有轮次')
    await waitStreamEnd(opened.stream, 'E 组流收尾')
    const done = firstFrameOf(opened.stream.frames, 'done')
    assert(done !== undefined, `超长会话也必须正常收尾，实际：${JSON.stringify(frameNames(opened.stream.frames))}`)
    assertEqual(done.data.finishReason, 'COMPLETE', 'finishReason')

    const messages = chatUpstream.requests[chatUpstream.requests.length - 1].body.messages
    // ⚠️ 用**注入的那个特征值**（CONTEXT_ROUNDS=3）而不是默认值 20：这样"截断真的按配置走"
    //    与"取的是最近 N 轮"两件事同时可判（P0-1-15 的"注入非标准值"手法）
    const expected = 1 + CONTEXT_ROUNDS * 2 + 1
    assertEqual(messages.length, expected, `消息条数 = 1 system + ${CONTEXT_ROUNDS} 轮 + 1 本轮`)
    assertEqual(messages[0].role, 'system', '第一条是 system')
    assertEqual(messages[1].role, 'user', '⚠️ 截断后必须从 user 开始（否则模型会把半截回答当上文）')
    assertEqual(
      messages[1].content,
      `历史第 ${TOTAL_ROUNDS - CONTEXT_ROUNDS + 1} 轮的问题`,
      '取的是**最近** CONTEXT_ROUNDS 轮的第一条（不是最早的）',
    )
    assertEqual(messages[messages.length - 1].content, '总结一下上面所有轮次', '末条是本轮提问')
    const rows = await messagesOf(convE.id)
    assertEqual(rows.length, TOTAL_ROUNDS * 2 + 2, '本轮也落库了（50 + 用户 + 助手）')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart('F', '上游故障：流内 `error` 收尾（`02` §5.2 的两类失败两个出口）', '夹具切 error ⇒ 502 UPSTREAM_ERROR')
  // ═══════════════════════════════════════════════════════════════════

  const convF = await createConversation(ownerJar, bareAgent.id)

  await it('上游 500 ⇒ `error{UPSTREAM_ERROR}` 事件（不是 HTTP 5xx 信封）', async () => {
    chatUpstream.setMode('error')
    const opened = await openChatStream(ownerJar, convF.id, '上游坏掉时的提问')
    assertEqual(opened.response.status, 200, '⚠️ 流已经开了 ⇒ 故障只能走事件（状态码仍是 200）')
    await waitStreamEnd(opened.stream, 'F 组流收尾', 10_000)
    const errorFrame = firstFrameOf(opened.stream.frames, 'error')
    assert(errorFrame !== undefined, `应当收到 error 事件，实际：${JSON.stringify(frameNames(opened.stream.frames))}`)
    assertEqual(errorFrame.data.code, 'UPSTREAM_ERROR', '错误码')
    assert(!hasEvent(opened.stream.frames, 'done'), 'error 之后不该再有 done')
    chatUpstream.setMode('normal')
  })

  await it('故障轮：用户消息落库、**没有**助手消息（已生成的内容为空）', async () => {
    const rows = await messagesOf(convF.id)
    assertEqual(rows.length, 1, '只有用户消息（这一轮真的发生过）')
    assertEqual(rows[0].role, 'USER', '落库的是用户消息')
    assertEqual(rows[0].content.text, '上游坏掉时的提问', '正文 = 提问原文')
    assertEqual(await prisma.message.count({ where: { conversationId: convF.id, role: 'ASSISTANT' } }), 0, '没有助手消息')
  })
} catch (error) {
  failed += 1
  console.error(`\n${c.r}✖ 脚本异常（不是断言失败，是脚本本身出错）${c.x}`)
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  // ───────────────────────────── 清理 + 复核残留 ─────────────────────────────
  console.log(`\n${c.b}── 清理（自清理 + 复核残留）──${c.x}`)
  try {
    // 顺序有讲究（外键多为 RESTRICT）：消息随会话级联 → 组件 → 智能体 → 文档/块 → 知识库 → 用户/Provider/模型
    for (const conversationId of createdConversationIds) {
      await redis.del(`chat.active:${conversationId}`).catch(() => undefined)
    }
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } })
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } })
    await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    for (const userId of createdUserIds) {
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
    await redis.del(`verify:chatbot:jobs:${suffix}`).catch(() => undefined)
    for (const kbId of createdKbIds) {
      const keys = []
      for await (const object of s3.listObjectsV2(bucket, `kb/${kbId}/`, true)) {
        if (object.name !== undefined) keys.push(object.name)
      }
      if (keys.length > 0) await s3.removeObjects(bucket, keys).catch(() => undefined)
    }
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  // 复核残留：**枚举脚本会创建的全部东西**（含"顺手创建的"）
  try {
    const leftovers = {
      users: await prisma.user.count({ where: { username: { contains: suffix } } }),
      providers: await prisma.modelProvider.count({ where: { name: { contains: suffix } } }),
      models: await prisma.model.count({ where: { modelName: { contains: suffix } } }),
      agents: await prisma.agent.count({ where: { name: { contains: suffix } } }),
      kbs: await prisma.knowledgeBase.count({ where: { name: { contains: suffix } } }),
      docs: await prisma.document.count({ where: { fileName: { contains: suffix } } }),
      conversations: await prisma.conversation.count({ where: { id: { in: createdConversationIds } } }),
      // ⚠️ 只查**本脚本创建的**那些键（`redis.keys('chat.active:*')` 会把本机 dev server
      //    正在跑的会话也算进来 ⇒ 假红。P0-1-7 的教训：枚举"脚本会创建的全部键"）
      activeKeys: await countPresentKeys(createdConversationIds.map((id) => `chat.active:${id}`)),
      stopKeys: await countPresentKeys(createdConversationIds.map((id) => `chat.stop:${id}`)),
    }
    const dirty = Object.entries(leftovers).filter(([, value]) => value !== 0)
    if (dirty.length === 0) {
      console.log(`  ${c.g}✔ 复核残留：临时数据已删净${c.x}`)
    } else {
      console.log(`  ${c.r}✖ 复核残留：仍有 ${JSON.stringify(leftovers)}${c.x}`)
    }
  } catch (error) {
    console.log(`  ${c.r}复核残留失败：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  if (serverExitedEarly) {
    console.log(`  ${c.r}⚠️ 后端子进程提前退出，服务端日志：${c.x}\n${serverLog}`)
  } else if (process.env.CHATBOT_DEBUG === '1') {
    console.log(`  ${c.d}服务端日志（末尾 40 行）：${c.x}\n${serverLog.split('\n').slice(-40).join('\n')}`)
  }
  await chatUpstream.close().catch(() => undefined)
  await embeddingUpstream.close().catch(() => undefined)
  await stopServer().catch(() => undefined)
  await closePrisma()
  await closeRedis()
}

// ───────────────────────────── 结论表 ─────────────────────────────
console.log(`\n${c.b}── 分组结论 ──${c.x}`)
groups.forEach((group, index) => {
  const { donePassed, doneFailed } = groupResult(group, index)
  const ok = doneFailed === 0
  const mark = ok ? `${c.g}✔${c.x}` : `${c.r}✖${c.x}`
  const detail = ok ? `${donePassed} 项全通过` : `${doneFailed} 项失败 / ${donePassed} 项通过`
  console.log(`  ${mark} ${group.id}｜${group.title} —— ${detail}`)
})

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-27 ChatBot 编排循环验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-27 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
