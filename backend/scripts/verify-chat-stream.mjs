#!/usr/bin/env node
/**
 * verify-chat-stream.mjs —— P0-1-26（SSE 出口 + 停止 + 互斥 + 心跳）的验收
 * **需要真实 PG + Redis**，而且**必须是真 HTTP**（`app.inject` 验不了这个批次，见下）
 *
 * 验的是 `02` §五 的出口层与 §5.2 的四条语义规则：
 *   · `POST /api/conversations/:id/chat` —— SSE 帧格式 / 响应头禁缓冲 / 心跳；
 *   · **会话互斥**（`chat.active:{id}` 锁，同会话并发 → 流内 `error{code:CONFLICT}`）；
 *   · **停止**（`POST /:id/stop` → `done{finishReason:STOPPED}`，5s 内收口）；
 *   · **断线/锁丢失**的收尾（客户端断开 ⇒ 释放锁；锁被清 ⇒ `error` 收尾而不是假装"已停止"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 为什么这一档必须 spawn 真进程 + 真 TCP（不能走 `app.inject`）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的验收原文是"**手动发一个空流观察 ping 按间隔到达**"—— 这句话里有两个字决定了手段：
 *   · "**按间隔**" ⇒ 必须**增量地**读，而不是等响应结束再一次性拿到全文。
 *     `app.inject` 的语义是"跑完 handler 再给结果"，对一条**永不结束**的流它只会挂住。
 *   · "手动" ⇒ 必须能观察到"什么时候收到了什么"。故本脚本自己解析 SSE 帧并**记下每帧到达时刻**，
 *     断言落在时间轴上（首帧比响应头晚、相邻 ping 的间隔）。
 * 顺带把 `02` §十二 的部署前提也验掉一半：响应头里的 `cache-control: no-transform` /
 * `x-accel-buffering: no` / `connection: keep-alive`（`06` 坑预判「SSE 响应头要禁缓冲」）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本脚本验的是"通道"，不是"回答"（P0-1-26 立的规矩；P0-1-27 起手段换了一个）
 * ─────────────────────────────────────────────────────────────────────
 * `docs/06` P0-1-26 的产出只有 `orchestrator/sse.ts`（通道 / 互斥 / 停止 / 心跳），真正的编排循环
 * （检索、LLM 流式调用、`citations`、落库）属 **P0-1-27**。
 * 📌 **P0-1-26 时** producer 是占位实现（只发 `ping`、不发内容事件、不落库），所以 A 组曾把
 * "本批不该有答案"做成一条守门断言。**P0-1-27 落地后这条断言的前提消失了** —— 本档不再靠
 * "producer 是空壳"来造那条空流，而是把 **Provider 的 `base_url` 指向假对话上游的 `stall` 模式**：
 * 上游收下请求后**只发 SSE 注释行、不回内容** ⇒ 流里仍然**只有 `ping`**，
 * 于是"通道"这一层的每条断言（时间轴 / 句柄 / 互斥 / 停止 / 断线）原样成立，
 * 而**回答本身**由 `verify:chatbot` 负责验（它才是 P0-1-27 的那一档）。
 * ⚠️ 留痕（P0-1-27 起）：A 组那条断言的**文字**从"本批不该有内容事件"改成
 * "上游挂着不回 ⇒ 事件集合只有 ping"—— 它守的东西没变（**通道不许自己造内容事件**），
 * 变的是**怎么把上游按住**。**再用"producer 是占位"当前提的写法，到这一批就该翻。**
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 注入小窗口（P0-1-6 的教训：窗口类配置必须注入小值，否则结果随窗口随机成败）
 * ─────────────────────────────────────────────────────────────────────
 * 子进程注入 `SSE_PING_INTERVAL_SEC=1` ⇒ 心跳 1s、停止轮询 250ms、锁 TTL = max(30, 3×1) = 30s。
 * **一个旋钮把本层的三个时间窗一起缩小**（它们都由 `config.limits.ssePingIntervalSec` 缩放，
 * 见 `orchestrator/sse.ts` 的三个派生常量）—— 验收因此不必等生产默认的 20s，而且
 * "停止后 5s 内收口"这条门槛在 250ms 的轮询下是真的能守住，而不是碰巧。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 依赖与前置
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 跑之前先起依赖并迁移：`pnpm infra:up && pnpm db:deploy`。**不需要 MinIO**（本批不碰对象存储）、
 * **不需要 `EMBEDDING_*`**（不建知识库）、**不需要任何真实上游**（P0-1-27 起用**本仓夹具**
 * `fixtures/chat-upstream.mjs` 的 `stall` 模式当上游，它随脚本起、随脚本关）。
 *
 * 端口：默认 **13097**（刻意避开用户 dev 的 13000 与 verify:e2e 的 13099）；
 * 被占时 `CHAT_STREAM_PORT=13096 node scripts/verify-chat-stream.mjs`。
 * 脚本自造 `verify-chat-*` 前缀的账号与数据，结束时删净并**复核残留**（含两个 Redis 键）。
 */

process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = resolve(BACKEND_DIR, 'dist/backend/src/index.js')

const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { UserRole, UserStatus, closePrisma, getPrisma } = await import('../dist/backend/src/infra/prisma.js')
const {
  chatActiveKey,
  chatStopKey,
  closeRedis,
  ensureRedisConnected,
  getRedis,
  invalidateUserSnapshot,
  sessionKey,
} = await import('../dist/backend/src/infra/redis.js')
const { updateActiveSnapshot } = await import('../dist/backend/src/orchestrator/sse.js')
const {
  SSE_EVENT_NAMES,
  chatRequestBodySchema,
  sseDonePayloadSchema,
  sseErrorPayloadSchema,
  ssePingPayloadSchema,
  stopConversationResultSchema,
} = await import('@doubulea/shared')
// P0-1-27 起编排循环会**真的调上游** ⇒ Provider 的 `base_url` 必须有个能收下请求的东西。
// 用本仓夹具的 `stall` 模式：收下、挂住、只发 SSE 注释行（不回内容）—— 这正是"通道在跑、
// 但一个内容事件都不该有"所需要的形状（P0-1-26 时靠"producer 是占位实现"达成同一件事）。
const { startFakeChatUpstream } = await import('./fixtures/chat-upstream.mjs')
const chatUpstream = await startFakeChatUpstream()
chatUpstream.setMode('stall')

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
  assert(actual === expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 集合比较**两侧先排序再比**（别把"书写顺序"也当成契约） */
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort()
  const b = [...expected].sort()
  assert(JSON.stringify(a) === JSON.stringify(b), `${label}：期望集合 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

/**
 * 比较"这条流**出现过哪些**事件名"（**去重**后比）。
 *
 * ⚠️ 不能直接把逐帧的 `frames.map(f => f.event)` 丢给 {@link assertSameSet}：
 * 心跳 1s 一条，几秒钟就是 `['ping','ping','ping']`，与 `['ping']` 一比就红 ——
 * 那是**用例写错了**，不是行为错了（这条踩过一次：一个假失败把后面的用例全带崩，
 * 因为它们共用的那条流被留在原地没关掉、锁没释放，于是后面每条都 409）。
 */
function assertOnlyEvents(frames, expected, label) {
  assertSameSet([...new Set(frames.map((frame) => frame.event))], expected, label)
}

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

let currentGroup = null
const groups = []

function groupStart(id, title, note) {
  currentGroup = { id, title, note, passed: 0, failed: 0 }
  groups.push(currentGroup)
  console.log(`\n${c.b}── ${id} ${title} ──${c.x}`)
  if (note !== undefined) console.log(`   ${c.d}${note}${c.x}`)
}

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    if (currentGroup !== null) currentGroup.passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    if (currentGroup !== null) currentGroup.failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/**
 * 轮询等一个条件成立（带超时）。
 *
 * 为什么用轮询而不是事件回调：本脚本的每条断言都建在"**若干帧之后**观察到什么"上，
 * 轮询 + 一次超时判断比事件驱动更好读（而且 25ms 的粒度对 1s 级的窗口足够细）。
 *
 * ⚠️ `await predicate()` 里的 `await` **不是可选的**：本脚本一半的谓词是 async
 * （凡是要打 `/active` 的都是）。漏掉 `await` 时 `predicate()` 返回一个 Promise，
 * 而 Promise **恒为真** ⇒ 循环第一次就 `return true`，"等条件成立"变成"什么都不等"、
 * 于是断言静默失效（症状：明明锁还在，`waitIdle` 却当场通过，紧接着的请求拿 409）。
 * `await` 对同步谓词同样成立（`await true` 就是 `true`），故无需分两套。
 */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(25)
  }
  if (await predicate()) return true
  console.log(`         ${c.d}（等待超时：${label}；已收帧 ${describeFrames(currentFramesForLog)}）${c.x}`)
  return false
}

/** 日志用：把帧列表压成一行（失败时能一眼看出"到底收到了什么"） */
let currentFramesForLog = []
function describeFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '（无）'
  const counts = new Map()
  for (const frame of frames) counts.set(frame.event, (counts.get(frame.event) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => `${name}×${count}`).join(' ') +
    (frames.some((frame) => frame.event === 'done' || frame.event === 'error')
      ? `｜末帧=${frames[frames.length - 1].event} ${JSON.stringify(frames[frames.length - 1].data)}`
      : '')
}

// ───────────────────────────── 常量与临时数据 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Chat-Stream-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-chat-admin-${suffix}`
const ownerUsername = `verify-chat-owner-${suffix}`
const otherUsername = `verify-chat-other-${suffix}`

/** 注入的心跳周期（秒）—— 本层所有时间窗都由它缩放（见文件头） */
const PING_SEC = 1
/** 心跳间隔的允许区间（毫秒）：下界抓"发太勤"、上界抓"没发/发太慢" */
const PING_GAP_MIN_MS = 600
const PING_GAP_MAX_MS = 2200

/** 一个语法合法但不存在的 uuid（验 404 时不撞 400） */
const MISSING_UUID = '01930000-0000-7000-8000-000000000000'

const port = Number.parseInt((process.env.CHAT_STREAM_PORT ?? '').trim() || '13097', 10)
const baseUrl = `http://127.0.0.1:${port}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdConversationIds = []

const prisma = getPrisma()
const redis = getRedis()
/** 收集子进程日志：只有失败时才打印（正常路径下它是一堆噪音） */
let serverLog = ''

// ───────────────────────────── 真实 HTTP 客户端 ─────────────────────────────

/** 发一次普通 JSON 请求（带 Cookie 罐；流式请求另走 {@link openChatStream}） */
async function request(jar, method, path, body) {
  const headers = {}
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

/**
 * 开一条 SSE 流并在**后台**持续抽帧（帧到达时刻记进 `frames[].at`）。
 *
 * 后台抽帧而不是"断言时现读"：本档的流**永不自己结束**（上游处于 `stall`：只发注释行、不回内容，
 * 于是编排层一直等着首个增量），而断言是"过一会儿看收到了什么"—— 边读边存是最贴合这件事的形状。
 */
function openStream(response, requestedAt) {
  const state = {
    frames: [],
    malformed: 0,
    ended: false,
    endedAt: undefined,
    readError: undefined,
    /** 发起请求的时刻（用于量"响应头等了多久"） */
    requestedAt,
    /** 收到响应头（fetch resolve）的时刻 */
    headersAt: Date.now(),
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
          parsed.at = Date.now()
          state.frames.push(parsed)
        }
      }
    } catch (error) {
      state.readError = error
    } finally {
      state.ended = true
      state.endedAt = Date.now()
    }
  })()
  return state
}

/**
 * 发起对话（真 HTTP，**流式**）。返回 `{ response, stream, abort }`。
 *
 * `abort()` 用于模拟"客户端断开"（关标签页）—— 这是 D 组的核心手段：
 * 断线必须**立刻释放锁**，否则用户下次发消息会被自己上一次的流挡住。
 */
async function openChatStream(jar, conversationId, payload = { content: '你好' }) {
  const controller = new AbortController()
  const headers = { 'content-type': 'application/json' }
  if (jar.value !== '') headers.cookie = `${SESSION_COOKIE_NAME}=${jar.value}`
  const requestedAt = Date.now()
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
  if (!response.ok) {
    // 失败路径（信封）由调用方处理：这里只把 body 读出来
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

/** 某会话的在跑流（`GET /:id/active`，契约化） */
async function readActive(jar, conversationId) {
  const response = await request(jar, 'GET', `/api/conversations/${conversationId}/active`)
  assertEqual(response.status, 200, '活跃态状态码')
  return response.body.data
}

/**
 * 等某会话空闲下来（`streaming:false`）。
 *
 * **每个"要新开一条流"的用例都该先调它**：上一条流的收尾是**异步**的（客户端 abort 之后，
 * 服务端要等 `close` 事件 → 中断 → 释放锁），所以"上一组刚 abort 完就开下一条"会随机拿到 409。
 * 这不是把断言放宽 —— 而是把"本用例的前提"写成一条**显式的等待**（失败时给出的是
 * "前置不成立"，而不是一个看起来像 bug 的 409）。
 */
async function waitIdle(jar, conversationId, label = '会话空闲（上一条流已收尾）') {
  const idle = await waitUntil(
    async () => (await readActive(jar, conversationId)).streaming === false,
    4000,
    label,
  )
  assert(idle, `前置不成立：${label}`)
}

// ───────────────────────────── 子进程 ─────────────────────────────

async function startServer() {
  try {
    const probe = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
    if (probe.ok) {
      throw new Error(
        `端口 ${port} 上已有服务在回答，请换端口：CHAT_STREAM_PORT=13096 node scripts/verify-chat-stream.mjs`,
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
      // 一个旋钮缩小本层三个时间窗（心跳 / 停止轮询 / 锁 TTL，见文件头）
      SSE_PING_INTERVAL_SEC: String(PING_SEC),
      // 队列是"被消费"的资源：给这个一次性进程一条独立队列，免得跟本机 dev server 抢任务
      PIPELINE_QUEUE_KEY: `verify:chat-stream:jobs:${suffix}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => (serverLog += chunk))
  child.stderr.on('data', (chunk) => (serverLog += chunk))

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

let server
async function stopServer() {
  if (server === undefined || server.exitCode !== null) return
  const exited = new Promise((resolveExit) => server.once('close', resolveExit))
  server.kill('SIGTERM')
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}

// ───────────────────────────── 主流程 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-26 SSE 验收：帧与心跳 / 互斥 / 停止 / 断线与锁丢失 ══${c.x}`)
console.log(`  ${c.d}目标：${baseUrl}（脚本自己起进程、自己造数据、跑完删净）${c.x}`)
console.log(`  ${c.d}注入窗口：SSE_PING_INTERVAL_SEC=${PING_SEC}（心跳 ${PING_SEC}s / 停止轮询 250ms / 锁 TTL 30s）${c.x}`)

try {
  await ensureRedisConnected()
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
  // ── 数据准备：三个账号（会话的权限口径是"仅本人"，故必须有第三方用于守门）──
  const passwordHash = await hashPassword(PASSWORD)
  const createUser = (username, data) => prisma.user.create({ data: { username, passwordHash, ...data } })
  const admin = await createUser(adminUsername, {
    nickname: 'SSE 验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const owner = await createUser(ownerUsername, {
    nickname: 'SSE 验证主人',
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const other = await createUser(otherUsername, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(admin.id, owner.id, other.id)

  server = await startServer()

  const adminJar = await login(newJar(), adminUsername)
  const ownerJar = await login(newJar(), ownerUsername)
  const otherJar = await login(newJar(), otherUsername)

  // ── 数据准备：两个 Provider（有 Key / 无 Key）+ 三个模型（正常 / 待停用）──
  const createProvider = async (payload) => {
    const response = await request(adminJar, 'POST', '/api/model-providers', payload)
    assertEqual(response.status, 200, `建 Provider 状态码（${payload.name}）`)
    createdProviderIds.push(response.body.data.id)
    return response.body.data
  }
  const createModel = async (payload) => {
    const response = await request(adminJar, 'POST', '/api/models', payload)
    assertEqual(response.status, 200, `建模型状态码（${payload.modelName}）`)
    createdModelIds.push(response.body.data.id)
    return response.body.data
  }
  const createAgent = async (payload) => {
    const response = await request(ownerJar, 'POST', '/api/agents', payload)
    assertEqual(response.status, 200, `建智能体状态码（${payload.name}）`)
    createdAgentIds.push(response.body.data.id)
    return response.body.data
  }
  const createConversation = async (agentId) => {
    const response = await request(ownerJar, 'POST', '/api/conversations', { agentId })
    assertEqual(response.status, 200, '建会话状态码')
    createdConversationIds.push(response.body.data.id)
    return response.body.data
  }

  // ⚠️ P0-1-27 起上游是**真在跑的**（编排循环接回后必然要调它）⇒ base_url 必须指向假上游。
  //    夹具停在 `stall`：收下请求、回 SSE 注释行，**不回内容** ⇒ 流里仍然只有 `ping`
  //    （这正是本档要的形状："通道在跑、但一个内容事件都不许有"）。
  const providerWithKey = await createProvider({
    name: `SSE 验证 Provider（有 Key）${suffix}`,
    baseUrl: chatUpstream.url,
    type: 'CHAT',
    apiKey: `sk-verify-chat-${suffix}`,
  })
  const providerNoKey = await createProvider({
    name: `SSE 验证 Provider（无 Key）${suffix}`,
    baseUrl: chatUpstream.url,
    type: 'CHAT',
  })

  const modelOk = await createModel({
    providerId: providerWithKey.id,
    modelName: `verify-chat-ok-${suffix}`,
    label: 'SSE 验证对话模型',
    type: 'CHAT',
  })
  const modelNoKey = await createModel({
    providerId: providerNoKey.id,
    modelName: `verify-chat-nokey-${suffix}`,
    label: 'SSE 验证无 Key 模型',
    type: 'CHAT',
  })
  const modelToDisable = await createModel({
    providerId: providerWithKey.id,
    modelName: `verify-chat-disabled-${suffix}`,
    label: 'SSE 验证待停用模型',
    type: 'CHAT',
  })

  const agentMain = await createAgent({
    name: `SSE 验证智能体 ${suffix}`,
    type: 'CHATBOT',
    modelId: modelOk.id,
  })
  const conversationMain = await createConversation(agentMain.id)

  const agentNoKey = await createAgent({
    name: `SSE 验证智能体（无 Key）${suffix}`,
    type: 'CHATBOT',
    modelId: modelNoKey.id,
  })
  const conversationNoKey = await createConversation(agentNoKey.id)

  const agentDisabled = await createAgent({
    name: `SSE 验证智能体（模型将被停用）${suffix}`,
    type: 'CHATBOT',
    modelId: modelToDisable.id,
  })
  const conversationDisabled = await createConversation(agentDisabled.id)

  const agentToDelete = await createAgent({
    name: `SSE 验证智能体（将被软删）${suffix}`,
    type: 'CHATBOT',
    modelId: modelOk.id,
  })
  const conversationReadOnly = await createConversation(agentToDelete.id)

  console.log(
    `  ${c.d}临时数据：3 个账号 + 2 Provider + 3 模型 + 4 智能体 + 4 会话（${suffix}）${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'A',
    '流形态与心跳（`02` §五：帧格式 + 响应头禁缓冲 + 空闲期 ping）',
    '验收原文："手动发一个空流观察 ping 按间隔到达" —— 本组同时钉住"通道不许自己造内容事件"（上游被摁在 stall）',
  )
  // ═══════════════════════════════════════════════════════════════════

  /** A 组开着的那条流（B/C 组共用；它由 `/stop` 收尾，不需要手动 abort） */
  let streamA

  await it('`POST /:id/chat` → 200 + text/event-stream，且响应头禁缓冲（架构）：三条头都在', async () => {
    const opened = await openChatStream(ownerJar, conversationMain.id)
    streamA = opened.stream
    currentFramesForLog = streamA.frames
    assert(opened.response.ok, `应 200，实际 ${opened.response.status}：${opened.raw ?? ''}`)
    assertEqual(opened.response.status, 200, '状态码')
    const contentType = opened.response.headers.get('content-type') ?? ''
    assertIncludes(contentType, 'text/event-stream', 'Content-Type')
    assertIncludes(contentType, 'charset=utf-8', 'Content-Type 的编码（中文增量必须有明确编码）')
    assertIncludes(opened.response.headers.get('cache-control') ?? '', 'no-transform', 'Cache-Control')
    assertEqual(opened.response.headers.get('x-accel-buffering'), 'no', 'X-Accel-Buffering（nginx 系禁缓冲）')
    assertEqual(opened.response.headers.get('connection'), 'keep-alive', 'Connection')
  })

  await it('响应头**立刻**到达（而不是等到第一帧）—— 这是在钉 `flushHeaders()`', async () => {
    // 首帧是**1s 之后**的心跳（本组注入 PING_SEC=1），所以必须先等它到，再回头比两个时刻。
    // （最初的写法在 A1 之后立刻读 `frames[0]`，那个瞬间当然还没帧 —— 用例的错，不是实现的错）
    const gotFirstFrame = await waitUntil(() => streamA.frames.length >= 1, 4000, '首帧（心跳）')
    assert(gotFirstFrame, '应当等到第一帧（心跳 1s 一次）')

    // ① 响应头必须在**请求刚发出**时就回来。缺 `flushHeaders()` 时 fetch 要等到第一次
    //    `res.write()`（≈1s 后的心跳）才 resolve ⇒ 这一条会明显超时。
    const headerDelayMs = streamA.headersAt - streamA.requestedAt
    assert(
      headerDelayMs < 600,
      `响应头应立刻返回（实测等了 ${headerDelayMs}ms）—— 若接近心跳周期，说明响应头是随第一帧一起冲出去的（缺 flushHeaders）`,
    )

    // ② 首帧应当**显著晚于**响应头 —— 两者几乎同时同样说明"头和第一帧一起出去"。
    const firstFrameAt = streamA.frames[0].at
    assert(
      firstFrameAt - streamA.headersAt > 400,
      `首个字节应显著晚于响应头（实测 headers=${headerDelayMs}ms 后到、首帧比响应头晚 ${firstFrameAt - streamA.headersAt}ms，` +
        `心跳周期 ${PING_SEC}s）`,
    )
  })

  await it('并发发送前先看 `/active`：`streaming:true` + `startedAt` 可解析 + 两个细节字段为 null', async () => {
    const active = await readActive(ownerJar, conversationMain.id)
    assertEqual(active.streaming, true, '在流中 streaming 应为 true（锁与"是否在流"是同一件事）')
    assertEqual(active.queuedPosition, null, '本批没有排队（queued 属 P0-3）')
    assertEqual(active.currentTool, null, '本批没有工具（tool_call 属 P0-2/27）')
    assert(
      typeof active.startedAt === 'string' && !Number.isNaN(Date.parse(active.startedAt)),
      `startedAt 应是可解析的 ISO 串，实际 ${JSON.stringify(active.startedAt)}`,
    )
  })

  await it('上游挂着不回 ⇒ 只发 `ping`，没有任何内容事件（P0-1-26 时靠"producer 是占位"，P0-1-27 起靠 stall 上游）', async () => {
    await waitUntil(() => streamA.frames.length >= 3, 6000, '至少收到 3 帧')
    assertOnlyEvents(streamA.frames, ['ping'], '事件集合（本组只允许出现 ping）')
    assertEqual(streamA.malformed, 0, '畸变帧数（data 应当都是合法 JSON）')
    for (const frame of streamA.frames) {
      const parsed = ssePingPayloadSchema.safeParse(frame.data)
      assert(parsed.success, `ping 的 payload 必须符合契约：${JSON.stringify(frame.data)}`)
      assert(
        !Number.isNaN(Date.parse(parsed.data.ts)),
        `ping.ts 应是可解析的 ISO 串，实际 ${JSON.stringify(parsed.data.ts)}`,
      )
    }
  })

  await it('心跳**按间隔**到达（1s 一次；太勤或太慢都算错）', async () => {
    await waitUntil(() => streamA.frames.length >= 4, 6000, '至少收到 4 帧以量出间隔')
    const gaps = streamA.frames.slice(1).map((frame, index) => frame.at - streamA.frames[index].at)
    assert(gaps.length >= 3, `至少要能量出 3 个间隔，实际 ${gaps.length}`)
    for (const gap of gaps) {
      assert(
        gap >= PING_GAP_MIN_MS && gap <= PING_GAP_MAX_MS,
        `心跳间隔应落在 [${PING_GAP_MIN_MS}, ${PING_GAP_MAX_MS}]ms，实测 ${gaps.join(', ')}ms（注入的心跳周期是 ${PING_SEC}s）`,
      )
    }
  })

  await it('`updateActiveSnapshot`（写侧）→ `/active` 读得到（P0-1-27 的 `currentTool` 走同一条路）', async () => {
    const active = await readActive(ownerJar, conversationMain.id)
    const startedAt = active.startedAt
    // 直接调模块级函数（**编排层不调用它** —— `chatBot.ts` 的 `currentTool` 属 P0-2 的工具循环；
    // 与 P0-1-25 的 `touchConversation` 同一种取证手法：**把口径做成可单独调用的函数**，
    // 否则这条断言要等到有第一条真实调用路径的那一批才验得上）
    await updateActiveSnapshot(conversationMain.id, startedAt, { currentTool: 'search_knowledge' })
    const after = await readActive(ownerJar, conversationMain.id)
    assertEqual(after.currentTool, 'search_knowledge', 'currentTool（写侧→读侧）')
    assertEqual(after.streaming, true, '更新快照不该动"是否在流"')
    assertEqual(after.startedAt, startedAt, '更新快照必须保留 startedAt（它是锁的归属标识）')
    await updateActiveSnapshot(conversationMain.id, startedAt, { currentTool: null })
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'B',
    '会话互斥（`02` §5.2：持锁期间同一会话再次发送 → 流内 `error{code:CONFLICT}`）',
    '防双标签页并发写乱历史；关键是"第二次失败**不能**把第一条流的锁带走"',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('同会话并发发送 → `error{code:CONFLICT}` 事件（`02` §5.2 的会话互斥）', async () => {
    const second = await openChatStream(ownerJar, conversationMain.id)
    // ⚠️ 它是 **SSE 事件**、不是 JSON 信封：`02` §4.5 / §5.2、`03` §五（配了"消息流内错误卡"）、
    //    `06` 的验收原文（"得 `error{code:CONFLICT}`"）**四处**都这么定。与 401 / 400 / 404 /
    //    只读 409 / 424 的分界是**主语**而不是"能不能在写帧前判定"：那些是"这个请求/目标"的问题，
    //    这一条是"**这一轮生成**"被拒绝（客户端已经发起了对话）⇒ 前端按单一渲染路径收口。
    assertEqual(second.response.status, 200, '并发拒绝也是 200 + SSE（被拒的是"这一轮"，不是"这个请求"）')
    assertIncludes(second.response.headers.get('content-type') ?? '', 'text/event-stream', 'Content-Type')
    const stream = second.stream
    assert(stream !== undefined, '应当是一条流')
    await waitUntil(() => stream.frames.length >= 1 || stream.ended, 3000, '拒绝帧')
    assert(stream.frames.length >= 1, `应当收到拒绝帧，实际 ${JSON.stringify(stream.frames)}`)
    // 只有一帧 error：没有任何 ping（流立刻收口），更没有内容事件
    assertOnlyEvents(stream.frames, ['error'], '被拒的流里的事件集合')
    const parsed = sseErrorPayloadSchema.safeParse(stream.frames[0].data)
    assert(parsed.success, `error 的 payload 必须符合契约：${JSON.stringify(stream.frames[0].data)}`)
    assertEqual(parsed.data.code, 'CONFLICT', '错误码')
    assertIncludes(parsed.data.message, '生成中', '文案（`03` §4.1 的 toast 文案「该会话正在生成中」）')
    await waitUntil(() => stream.ended === true, 3000, '拒绝之后流立刻收口')
    assertEqual(stream.ended, true, '拒绝之后流必须 end（否则前端读循环会一直挂着）')
  })

  await it('被拒之后**第一条流仍在跑**（锁没被误释放）+ 仍有心跳', async () => {
    const before = streamA.frames.length
    assertEqual((await readActive(ownerJar, conversationMain.id)).streaming, true, '第一条流的锁应还在')
    await waitUntil(() => streamA.frames.length > before, 3000, '第一条流应继续收到心跳')
    assertEqual(streamA.ended, false, '第一条流不应因为第二次发送而结束')
  })

  await it('会话是"仅本人"：他人打同一个会话的 chat / stop 都 404（不是 403）', async () => {
    const asOther = await openChatStream(otherJar, conversationMain.id)
    assertEqual(asOther.response.status, 404, '他人的会话应 404')
    assertEqual(asOther.body?.code, 'NOT_FOUND', '错误码')
    const stopAsOther = await request(otherJar, 'POST', `/api/conversations/${conversationMain.id}/stop`)
    assertEqual(stopAsOther.status, 404, '他人停止同一会话也应 404')
    // 反向：**不能**因为"他人被拒"就把接口做成恒 404 —— 本人的 stop 必须 200（C 组验）
    assertEqual(asOther.response.headers.get('set-cookie'), null, '被拒的请求不该动会话 Cookie')
  })

  await it('`/stop` 是幂等的：**当前没有流的会话** → 200 + `signaled:false`（不是 4xx）', async () => {
    // 这条用一个干净的会话（conversationDisabled 还没发过消息）
    const stop = await request(ownerJar, 'POST', `/api/conversations/${conversationDisabled.id}/stop`)
    assertEqual(stop.status, 200, '无流时停止应 200（幂等）')
    const parsed = stopConversationResultSchema.safeParse(stop.body.data)
    assert(parsed.success, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    assertEqual(parsed.data.signaled, false, 'signaled')
    assertEqual(parsed.data.id, conversationDisabled.id, 'id')
    // 关键：**没有写停止键**（写了会让这个会话下一条消息被秒停）
    assertEqual(await redis.exists(chatStopKey(conversationDisabled.id)), 0, '无流时不该留下停止键')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'C',
    '停止（`02` §5.2：`chat.stop:{id}` TTL 60s，编排循环在可中断点检查）',
    '验收原文："停止后 5s 内收到 done{finishReason:STOPPED}"（本脚本注入 1s 心跳 ⇒ 轮询 250ms）',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('`POST /:id/stop` → `{signaled:true}`（真的有流收到了信号）', async () => {
    const stop = await request(ownerJar, 'POST', `/api/conversations/${conversationMain.id}/stop`)
    assertEqual(stop.status, 200, '停止状态码')
    const parsed = stopConversationResultSchema.safeParse(stop.body.data)
    assert(parsed.success, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    assertEqual(parsed.data.signaled, true, 'signaled（确实有一个在跑的流）')
  })

  await it('5s 内收到 `done{finishReason:STOPPED}`，且它**是最后一个事件**', async () => {
    const arrived = await waitUntil(
      () => streamA.frames.some((frame) => frame.event === 'done' || frame.event === 'error'),
      5000,
      'done / error 帧',
    )
    assert(arrived, '停止后 5s 内应收口')
    const last = streamA.frames[streamA.frames.length - 1]
    assertEqual(last.event, 'done', '停止是**正常收尾**，必须是 done（不是 error）')
    const parsed = sseDonePayloadSchema.safeParse(last.data)
    assert(parsed.success, `done 的 payload 必须符合契约：${JSON.stringify(last.data)}`)
    assertEqual(parsed.data.finishReason, 'STOPPED', 'finishReason')
    // `messageId: null` 的语义 = "这一轮没有产生可持久化的消息"（本批不落库 ⇒ 只能是 null）
    assertEqual(parsed.data.messageId, null, 'messageId（本批不落库，不许编一个假 id）')
    assertEqual(parsed.data.usage, null, 'usage（本批没有上游调用）')
    // 收口之后连接要真的关掉（否则前端读循环一直挂着）
    await waitUntil(() => streamA.ended === true, 3000, '流结束（服务端 end）')
    assertEqual(streamA.ended, true, '服务端应 end 掉这条响应')
  })

  await it('停止之后：`/active` 回到 `streaming:false`，两个 Redis 键都不残留', async () => {
    await waitUntil(
      async () => (await readActive(ownerJar, conversationMain.id)).streaming === false,
      3000,
      '活跃流锁被释放',
    )
    const active = await readActive(ownerJar, conversationMain.id)
    assertEqual(active.streaming, false, 'streaming')
    assertEqual(active.startedAt, null, 'startedAt（无流时恒为 null）')
    assertEqual(await redis.exists(chatActiveKey(conversationMain.id)), 0, '`chat.active` 应已删除')
    assertEqual(await redis.exists(chatStopKey(conversationMain.id)), 0, '`chat.stop` 应已删除（不留残留）')
  })

  await it('再停一次 → `{signaled:false}`（流已经结束，幂等）', async () => {
    const stop = await request(ownerJar, 'POST', `/api/conversations/${conversationMain.id}/stop`)
    assertEqual(stop.status, 200, '状态码')
    assertEqual(stop.body.data.signaled, false, 'signaled')
  })

  await it('停止信号不残留：紧接着新开一条流，它**不会被上一轮的停止键秒停**', async () => {
    // 这一条是"两道防线"的守门断言（见 `clearStopSignal` 的注释）：
    // 若停止键在收尾时没清掉、且新流启动时也没清，新流会立刻收到 `done{STOPPED}` ——
    // 症状是"刚发出去的回答停在原地，没有任何报错"
    const reopened = await openChatStream(ownerJar, conversationMain.id)
    assert(reopened.stream !== undefined, '应当能重新开一条流（锁已释放）')
    currentFramesForLog = reopened.stream.frames
    try {
      await waitUntil(() => reopened.stream.frames.length >= 2, 4000, '新流收到心跳')
      assertOnlyEvents(reopened.stream.frames, ['ping'], '新流的事件集合（不该有 done/error —— 那说明停止键残留着）')
      assertEqual(reopened.stream.ended, false, '新流应当还活着')
    } finally {
      // ⚠️ 放 finally 里：断言失败也必须把这条流关掉。否则它会一直占着锁，
      //    后面每一组都拿 409（把"一个用例写错"放大成"整档全红"，掩盖真正的问题）。
      reopened.abort()
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'D',
    '断线释放锁（`02` §5.2：断线重连先查 `/active`；这里验"断开即解锁"这一半）',
    '不释放的症状：用户关掉标签页后，这个会话在锁的 TTL 内（30s）一直报 CONFLICT',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('客户端断开（abort fetch）→ 3s 内锁被释放（不必等 TTL）', async () => {
    // 本组自己开一条流（不蹭上一组的残留）：每条用例自带前提，"前一条失败了"就不会把
    // 这一条也带成假红。
    await waitIdle(ownerJar, conversationMain.id, '上一组那条流已收尾（本组的前提）')
    const opened = await openChatStream(ownerJar, conversationMain.id)
    assertEqual(
      opened.response.status,
      200,
      `先开一条流（前提：此刻没有别的流）；实际响应 ${opened.raw ?? ''}`,
    )
    currentFramesForLog = opened.stream.frames
    await waitUntil(() => opened.stream.frames.length >= 1, 3000, '先收到心跳（确认真的在跑）')
    assertEqual(await redis.exists(chatActiveKey(conversationMain.id)), 1, '锁在（前提）')

    opened.abort() // ← 模拟"关掉标签页"
    const released = await waitUntil(
      async () => (await readActive(ownerJar, conversationMain.id)).streaming === false,
      3000,
      '断线后锁被释放',
    )
    assert(
      released,
      '断线必须立刻释放锁（`orchestrator/sse.ts` 里监听 `reply.raw` 的 close）—— ' +
        '否则用户关掉标签页后，30s 内自己都发不出消息',
    )
    assertEqual(await redis.exists(chatActiveKey(conversationMain.id)), 0, '`chat.active` 应已删除')
  })

  await it('断线之后**马上**能重新发消息（拿到锁 → 200 + 心跳）', async () => {
    const again = await openChatStream(ownerJar, conversationMain.id)
    assertEqual(again.response.status, 200, '状态码（锁已释放，应能重新开流）')
    currentFramesForLog = again.stream.frames
    try {
      await waitUntil(() => again.stream.frames.length >= 2, 4000, '收到心跳')
      assertEqual(again.stream.ended, false, '新流应当还活着')
    } finally {
      again.abort()
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'E',
    '锁被清掉时**必须用 error 收口**（而不是假装"已停止"）',
    '手法：流跑着的时候手工 del 掉锁键 → 下一次心跳发现"续期返回 0"⇒ 中断并报错',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('锁被人清掉 → 2~3s 内收到 `error`（INTERNAL），而不是 `done{STOPPED}`', async () => {
    await waitIdle(ownerJar, conversationMain.id, '上一组那条流已收尾（本组的前提）')
    const opened = await openChatStream(ownerJar, conversationMain.id)
    assertEqual(opened.response.status, 200, '状态码')
    currentFramesForLog = opened.stream.frames
    await waitUntil(() => opened.stream.frames.length >= 1, 3000, '先收到一帧心跳')
    // 模拟"锁被别的东西清掉了"（真实来源：`DELETE /conversations/:id` 会清锁；
    // 或进程被冻结超过 3 个心跳周期导致锁自然过期）
    await redis.del(chatActiveKey(conversationMain.id))
    const arrived = await waitUntil(
      () => opened.stream.frames.some((frame) => frame.event === 'error'),
      4000,
      'error 帧',
    )
    assert(
      arrived,
      '锁没了还继续往这个会话写内容，就是在和别的流抢同一份历史 —— ' +
        '症状：收到的事件里既没有 error 也没有 done',
    )
    const last = opened.stream.frames[opened.stream.frames.length - 1]
    assertEqual(last.event, 'error', '收尾事件')
    const parsed = sseErrorPayloadSchema.safeParse(last.data)
    assert(parsed.success, `error 的 payload 必须符合契约：${JSON.stringify(last.data)}`)
    assertEqual(parsed.data.code, 'INTERNAL', '错误码（"锁丢了"不是用户的停止，不能报成 STOPPED）')
    // 文案是**给用户看**的：要说清"能做什么"（重发），而不是把"活跃锁"这种内部词抛出去。
    // 技术原因（过期 / 被清理）在服务端日志里（`#renewLock` 的 warn）。
    assertIncludes(parsed.data.message, '重新发送', '文案应给出可行动的建议（用户看到的是这句）')
    assert(
      !parsed.data.message.includes('锁'),
      `文案不该把内部概念（锁）暴露给用户，实际 ${JSON.stringify(parsed.data.message)}`,
    )
    assertEqual(
      opened.stream.frames.some((frame) => frame.event === 'done'),
      false,
      'error 是终结事件，不该再补一个 done',
    )
    await waitUntil(() => opened.stream.ended === true, 3000, '流结束')
    // 清理侧：会话此时已经没有锁了（被我们自己删的），但也不该有停止键残留
    assertEqual(await redis.exists(chatStopKey(conversationMain.id)), 0, '`chat.stop` 不该残留')
  })

  await it('清理回收：`releaseConversationLock` 对"已经没有的键"是安全的（下一次开流不受影响）', async () => {
    await waitIdle(ownerJar, conversationMain.id, '上一组那条流已收尾（本组的前提）')
    const opened = await openChatStream(ownerJar, conversationMain.id)
    assertEqual(opened.response.status, 200, '状态码（上一轮的收尾不该把锁的状态搞坏）')
    currentFramesForLog = opened.stream.frames
    try {
      await waitUntil(() => opened.stream.frames.length >= 1, 3000, '收到心跳')
    } finally {
      opened.abort()
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'F',
    '发消息的前置（`02` §4.5 的 400/401/404/409/424；会话互斥的 CONFLICT 在 B 组，因为它是流内事件）',
    '全部走 **JSON 信封**（写出第一帧之前判定）；这也是 P0-1-24 门槛④"写不进去"那一半的落点',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('未登录 → 401；非法 body → 400 且字段级明细指向对应输入', async () => {
    const anonymous = await openChatStream(newJar(), conversationMain.id)
    assertEqual(anonymous.response.status, 401, '未登录应 401')
    assertEqual(anonymous.body?.code, 'UNAUTHORIZED', '错误码')

    const empty = await openChatStream(ownerJar, conversationMain.id, { content: '   ' })
    assertEqual(empty.response.status, 400, '空内容应 400（trim 之后不能为空）')
    assertEqual(empty.body?.code, 'VALIDATION', '错误码')
    assertEqual(empty.body?.msg, '请求参数校验失败', '顶层 msg 恒为这句（字段级详情在 data.fields）')
    const fields = empty.body?.data?.fields ?? []
    assert(
      fields.some((field) => field.path === 'body.content' && field.message.includes('不能为空')),
      `字段明细应指向 body.content，实际 ${JSON.stringify(fields)}`,
    )

    const tooLong = await openChatStream(ownerJar, conversationMain.id, { content: 'x'.repeat(20_001) })
    assertEqual(tooLong.response.status, 400, '超长应 400')
    assert(
      (tooLong.body?.data?.fields ?? []).some((field) => field.message.includes('20000')),
      `超长文案应带上限，实际 ${JSON.stringify(tooLong.body?.data?.fields)}`,
    )
  })

  await it('附件字段 → 400 + 文案指向 P1（**刻意不收下不报错**）', async () => {
    const withAttachment = await openChatStream(ownerJar, conversationMain.id, {
      content: '带附件',
      attachmentFileIds: [MISSING_UUID],
    })
    assertEqual(withAttachment.response.status, 400, '带附件应 400（files 表属 P1）')
    const fields = withAttachment.body?.data?.fields ?? []
    const hit = fields.find((field) => field.path === 'body.attachmentFileIds')
    assert(hit !== undefined, `字段明细应指向 body.attachmentFileIds，实际 ${JSON.stringify(fields)}`)
    assertIncludes(hit.message, 'P1', '文案要指向版本（否则用户不知道该等什么）')
    // 反向：空数组（前端"没选附件"的形态）必须放行 —— 否则 P0-1-32 会在每次请求上都 400
    await waitIdle(ownerJar, conversationMain.id, 'E 组那条流已收尾（本组的前提）')
    const emptyList = await openChatStream(ownerJar, conversationMain.id, {
      content: '没选附件',
      attachmentFileIds: [],
    })
    assertEqual(emptyList.response.status, 200, '空附件数组应放行')
    emptyList.abort()
  })

  await it('不存在的会话 / 别人的会话 → 404（同一个 404，不泄露 id 是否存在）', async () => {
    const missing = await openChatStream(ownerJar, MISSING_UUID)
    assertEqual(missing.response.status, 404, '不存在的会话应 404')
    assertEqual(missing.body?.code, 'NOT_FOUND', '错误码')
    const asOther = await openChatStream(otherJar, conversationMain.id)
    assertEqual(asOther.response.status, 404, '他人的会话应 404')
    assertEqual(asOther.body?.msg, missing.body?.msg, '两种情况必须是同一句文案（不泄露 id 是否有效）')
  })

  await it('会话只读（Agent 被软删 → FINISHED）→ 409（P0-1-24 门槛④的"写不进去"）', async () => {
    // 读得到（P0-1-25 已回补）：软删之后会话仍在列表里
    const del = await request(ownerJar, 'DELETE', `/api/agents/${agentToDelete.id}`)
    assertEqual(del.status, 200, '软删 Agent')
    const listed = await request(ownerJar, 'GET', `/api/agents/${agentToDelete.id}/conversations`)
    assertEqual(listed.status, 200, '软删后会话列表仍可读（只读保留）')
    assertEqual(listed.body.data.total, 1, '会话仍在')
    const active = await readActive(ownerJar, conversationReadOnly.id)
    assertEqual(active.streaming, false, '只读会话当然没有流')

    // 写不进去（本批新钉）：`isConversationReadOnly` 的消费方就在这里
    const blocked = await openChatStream(ownerJar, conversationReadOnly.id, { content: '还能说吗' })
    assertEqual(blocked.response.status, 409, '只读会话应 409')
    assertEqual(blocked.body?.code, 'CONFLICT', '错误码')
    assertIncludes(blocked.body?.msg, '已结束', '文案')
  })

  await it('Provider 没配 Key → 424 `NEED_CREDENTIAL`（这是"发消息"才该报的错）', async () => {
    const response = await openChatStream(ownerJar, conversationNoKey.id)
    assertEqual(response.response.status, 424, '缺凭据应 424')
    assertEqual(response.body?.code, 'NEED_CREDENTIAL', '错误码')
    assertIncludes(response.body?.msg, 'API Key', '文案要说清缺什么')
  })

  await it('绑定的模型被停用 → 409（且文案指向"去哪儿修"）', async () => {
    const disabled = await request(adminJar, 'PATCH', `/api/models/${modelToDisable.id}`, { enabled: false })
    assertEqual(disabled.status, 200, '停用模型')
    const response = await openChatStream(ownerJar, conversationDisabled.id)
    assertEqual(response.response.status, 409, '模型停用应 409')
    assertEqual(response.body?.code, 'CONFLICT', '错误码')
    assertIncludes(response.body?.msg, '已停用', '文案')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart('G', '契约自检与残留复核', '事件全集同源 / 不留 Redis 键 / 不留数据行')
  // ═══════════════════════════════════════════════════════════════════

  await it('事件全集与 `02` §5.1 的表逐字一致（顺序也一致），且 chat body 的 schema 能真跑', async () => {
    assertSameSet(
      SSE_EVENT_NAMES,
      ['delta', 'thinking', 'tool_call', 'confirm', 'citations', 'artifact', 'queued', 'ping', 'done', 'error'],
      '事件全集',
    )
    assertEqual(SSE_EVENT_NAMES.join(','), 'delta,thinking,tool_call,confirm,citations,artifact,queued,ping,done,error', '事件顺序（= 文档顺序）')
    const ok = chatRequestBodySchema.safeParse({ content: '  你好  ' })
    assert(ok.success, '合法 body 应通过')
    assertEqual(ok.data.content, '你好', 'content 必须 trim')
  })

  await it('残留复核：本脚本造的所有会话都没有 `chat.active` / `chat.stop` 键', async () => {
    // 先等最后一条开过流的会话收尾 —— "没有残留"只有在"所有流都结束了"之后才是个有意义的断言
    await waitIdle(ownerJar, conversationMain.id, '最后一个开过流的会话已收尾')
    const leftovers = []
    for (const conversationId of createdConversationIds) {
      for (const key of [chatActiveKey(conversationId), chatStopKey(conversationId)]) {
        if ((await redis.exists(key)) !== 0) leftovers.push(key)
      }
    }
    assertEqual(leftovers.length, 0, `残留键：${JSON.stringify(leftovers)}`)
  })

  await it('清理：删净会话/消息/智能体/模型/Provider/账号（幂等）', async () => {
    await prisma.message.deleteMany({ where: { conversationId: { in: createdConversationIds } } })
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } })
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } })
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    for (const userId of createdUserIds) await invalidateUserSnapshot(userId).catch(() => undefined)
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await prisma.user.deleteMany({ where: { username: { startsWith: 'verify-chat-' } } })

    const residue = {
      conversation: await prisma.conversation.count({ where: { id: { in: createdConversationIds } } }),
      agent: await prisma.agent.count({ where: { id: { in: createdAgentIds } } }),
      user: await prisma.user.count({ where: { username: { startsWith: 'verify-chat-' } } }),
    }
    assertEqual(
      residue.conversation + residue.agent + residue.user,
      0,
      `残留：${JSON.stringify(residue)}`,
    )
  })
} catch (error) {
  failed += 1
  console.log(`\n${c.r}[FAIL]${c.x} 主流程中断：${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error && error.stack !== undefined) console.log(`         ${c.d}${error.stack}${c.x}`)
} finally {
  await stopServer()
  await closePrisma()
  await closeRedis()
  await chatUpstream.close().catch(() => undefined)
}

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── P0-1-26 结论表（docs/06 的验收原文逐条）──${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}
console.log(
  `  ${c.y}⚠️${c.x} 本档的上游被摁在 **stall**（scripts/fixtures/chat-upstream.mjs）：流里**只有 ping**、` +
    `这一个字都不是"没有回答"的证据 —— 回答本身归 **verify:chatbot**（P0-1-27）`,
)
console.log(
  `  ${c.d}边界：并发闸满 ⇒ 流内 error{BUSY} 属 P0-1-27（见 verify:chatbot 的 D 组）；` +
    `消息历史 POST /:id/messages 属 P0-1-28；浏览器里仍是占位页（P0-1-30）${c.x}`,
)

if (failed > 0 && serverLog !== '') {
  console.log(`\n${c.d}── 子进程日志尾部（仅失败时打印）──\n${serverLog.slice(-4000)}${c.x}`)
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-26 SSE 验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-26 SSE 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
