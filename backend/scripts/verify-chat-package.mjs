/**
 * verify-chat-package.mjs —— **P0-1-29 对话包验收**（包 F 收口 / 阶段一出口）
 *
 * 逐行跑 `docs/06` P0-1-29 的**七条验收门槛**（= `docs/05` 包 F 的出口判据
 * "SSE 全事件跑通，带引用回答，停止与刷新恢复均正确"），每行一个组：
 *   R1 门槛① 建号→登录→建库传 3 篇 PDF→建 ChatBot 绑库→提问 → **带引用回答**
 *   R2 门槛② 停止生成 → 已生成部分保留 → 可直接追问
 *   R3 门槛③ 刷新页面 → 历史完整恢复（含引用卡）        ⚠️ HTTP 层（见下）
 *   R4 门槛④ 同会话并发发送 → `CONFLICT`
 *   R5 门槛⑤ 超长会话（25 轮）不报错
 *   R6 门槛⑥ 首字延迟 < 3s（以服务端 TTFT 日志为准）
 *   R7 门槛⑦ 全程无手工干预数据（可执行的等价形态，见下）
 *   R8 清场   自清理 + 残留复核
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么还要一个"包级"脚本（前面四批各有自己的验收）
 * ─────────────────────────────────────────────────────────────────────
 * `verify-chat-stream`（P0-1-26 通道）/ `verify-chatbot`（P0-1-27 编排）/ `verify-conversations`
 * （P0-1-25/28 会话与历史）验的是**每个端点各自对不对**；而"这个包能不能交付"问的是
 * **从头到尾串一遍还成不成立**：
 *   · R1 跨了 **B 包（建号 → 首登强制改密 → 会话）→ C 包（Provider/模型）→ D 包（建库 + 上传 +
 *     流水线）→ E 包（建 Agent + 绑库）→ F 包（提问 → 检索 → 流式 → 引用 → 落库）** ——
 *     五个包各自的验收都绿，也不等于"一个新建的账号能自己把这条链走完"
 *     （本仓已踩过两次"顺手加 `requireAdmin`"，那类实现每档单独跑都可能绿）；
 *   · R3 的"刷新后历史完整恢复"要求**写入端的落库形态与读取端的投影逐字对得上**
 *     （`content` 是 jsonb、键序会被 PG 重排 ⇒ 必须键序无关地比）—— 只验一端时，
 *     一个"存 A 形状、回 B 形状"的实现可以两处都绿；
 *   · R6 的 TTFT 是**跨包性质**：打点在编排层（F）、测量依据在日志口径（`02` §十三），
 *     而"首字 < 3s"这句话只有在**真跑一遍完整链路**时才有意义。
 * 所以本脚本**不重复**那三档的细粒度断言（帧格式、锁归属、`BUSY`、游标边界…只引用不重验），
 * 只跑这七行要的**端到端证据**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 三处"部分完成"与一处"等价形态"（结论表里单列，别混进 ✅）
 * ─────────────────────────────────────────────────────────────────────
 * ① **R3 的"刷新页面"只到 HTTP 层**：`GET /:id/messages` 是"重新画出整个对话页"的**那一个**
 *    请求（P0-1-28），本档验的是"它能一次把消息与引用卡原样取回来"；**浏览器里的渲染**
 *    属 P0-1-32~34（`03` §六 的单一渲染路径），现在**前端仍是 P0-1-1 的占位页**。
 * ② **R1 的"传 3 篇 PDF"用的是 ASCII 夹具**：本仓的 `makePdf` 走 Helvetica 内置字体 +
 *    latin1 字节（P0-1-16 定案），**装不下中文** —— 不是"PDF 只支持英文"，而是夹具的限制。
 *    真中文 PDF 的解析能力由 `verify:documents` 的 A 组单独验（那里是同一套夹具 + 中文用例）。
 * ③ **R6 的 TTFT 是"链路值"不是"模型值"**：上游是本地假夹具（首字几十毫秒），所以本档证明的是
 *    **打点存在 + 打点口径正确 + 全链路没有隐藏的等待**（阶段一门槛的测量方式成立），
 *    **不能**用它推算真实厂商的首字延迟（那要靠 `§七` 待决事项 2 的真模型）。
 * ④ **R7 是"等价形态"**：见下面专门一段。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ R7「全程无手工干预数据」怎么验（这一条最容易写成恒真的废断言）
 * ─────────────────────────────────────────────────────────────────────
 * 门槛原文是一句**意图**，不是一句可断言的话。直接写"我们没用 SQL 插数据"是**恒真**的
 * （脚本里当然没有那句 SQL）—— 同族陷阱见本仓批量工作流技能的断言形态 ⑫。故本档把它拆成
 * **四条"只有服务端能产生"的证据** + 一份**端点台账**：
 *   1. **初始密码不是我们选的**：拿本脚本自选的密码去登这个新号必须 **401**，
 *      拿 `POST /api/users` 回来的 `initialPassword` 必须 **200**，且长度 = `INITIAL_PASSWORD_LENGTH`
 *      （服务端生成、18 字符、无易混字符）。手改过库或"密码写死"的实现过不了这一对。
 *   2. **文档正文真的来自我们上传的那份 PDF**：每篇的 chunk 正文里含各自的特征短语
 *      （只可能来自上传字节），且**列表端点报出的 `chunkCount` == `chunks` 表的实际行数**
 *      （"接口说 12 块、表里 0 行"是 P0-1-19 明令禁止的谎报）。
 *   3. **助手消息正文 == 事件流收到的增量拼接**：正文是服务端产出的，手写不出来。
 *   4. **`agent.createdBy` == 会话里的用户 id**：由服务端从会话取，客户端提交不了这个字段。
 * 另打印一份**去重后的 HTTP 端点台账**（本档每一个请求都记录 method/path/status）——
 * 它是"这条链只用了产品端点"的可读证据；台账里断言必须出现建号 / 上传 / 提问这三条。
 * ⚠️ 唯一的**直接写库**是"自举管理员"（下面 `bootstrapAdmin`）：没有"第一个管理员"的任何 HTTP
 * 入口（等价于 `pnpm db:seed` 干的那件事），属**自举**而非业务数据干预 —— 也正因如此，
 * 门槛① 的"用户"是**走 `POST /api/users` 建出来的**，不是脚本写库造的。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 依赖与前置
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 跑之前先起依赖并迁移：`pnpm infra:up && pnpm db:deploy`（PG + Redis + MinIO 都要 ——
 * R1 的三篇 PDF 要真的落 S3 才能走完流水线）。
 * ⚠️ 本脚本自己起停后端子进程（内含流水线 worker），**不要**同时开着 `pnpm dev:backend` 跑同一批数据。
 * 默认端口 **13096**（与用户 dev 的 13000、另外两档的 13097/13098 都错开）；被占时换
 * `CHAT_PACKAGE_PORT=…`。看服务端细节：日志默认 `LOG_LEVEL=info`（R6 要读 TTFT 那条），
 * 失败时会随断言一起打出来；要全量日志加 `CHAT_PACKAGE_DEBUG=1`。
 * 脚本自造带随机后缀的 2 个用户 + 1 个 Provider + 1 个模型 + 1 个知识库 + 3 篇 PDF +
 * 3 个智能体 + 若干会话/消息/绑定，结束时删净并**复核残留**。
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = resolve(BACKEND_DIR, 'dist/backend/src/index.js')

const fixtures = await import('./fixtures/documents.mjs')
const { startFakeChatUpstream } = await import('./fixtures/chat-upstream.mjs')
const { startFakeEmbeddingUpstream } = await import('./fixtures/embedding-upstream.mjs')

// ⚠️ 顺序要求（与 `embedding-upstream.mjs` 文件头一致）：**先起假上游**、再 import 任何
//    backend 模块 —— 配置在模块加载期只读一次。
const chatUpstream = await startFakeChatUpstream()
const embeddingUpstream = await startFakeEmbeddingUpstream({ semantic: true })

const { INITIAL_PASSWORD_LENGTH, hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma } = await import('../dist/backend/src/infra/prisma.js')
const { closeRedis, getRedis, invalidateUserSnapshot, loginFailKey, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { getS3Client } = await import('../dist/backend/src/infra/s3.js')
const { config } = await import('../dist/backend/src/config.js')
const {
  conversationItemSchema,
  documentListResultSchema,
  initialPasswordResultSchema,
  messagePageResultSchema,
  SNIPPET_WINDOW_CHARS,
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
  assert(actual === expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
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
 * `messages.content` 是 jsonb，Postgres 会按"先键长、再字节序"**重排**对象键 ⇒
 * "写进去时的形状"与"读出来时的形状"用 `JSON.stringify` 直接比**必然不等**，
 * 而报告里两者**看着一模一样**（P0-1-27 实测抓到的假红，P0-1-28 整档都在比这个）。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${key}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const groups = []

function groupStart(id, title, note) {
  // 分组计数用"快照差值"算（`it` 只管累加总数，收尾时与下一组的起点相减即得本组成绩）
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
 * ⚠️ **必须 `await predicate(...)`**：本档的谓词全是 async（都要打接口或查库）。
 * 漏 `await` 会让"每一次等待都瞬间通过" ⇒ 造出**假绿**，比假红贵得多
 * （P0-1-26 因此把一个真 bug 盖了整整一轮，见本仓批量工作流技能的断言形态 ⑬）。
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

const framesOf = (frames, name) => frames.filter((frame) => frame.event === name)
const hasEvent = (frames, name) => frames.some((frame) => frame.event === name)
const firstFrameOf = (frames, name) => frames.find((frame) => frame.event === name)
const frameNames = (frames) => frames.map((frame) => frame.event)
const deltaTextOf = (stream) => framesOf(stream.frames, 'delta').map((frame) => frame.data?.text ?? '').join('')

// ───────────────────────────── 常量与临时数据 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
/** 自选密码：**只给脚本自己的账号用**；门槛① 那个新号必须**登不进**这个密码（R7 的证据 1） */
const CHOSEN_PASSWORD = 'Verify-ChatPackage-Chosen1'
const PROVIDER_KEY = 'sk-verify-chat-package-key'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-chatpkg-admin-${suffix}`
const staffUsername = `verify-chatpkg-staff-${suffix}`

/** 注入的特征值（都写进子进程环境，见文件头） */
const CHATBOT_CONCURRENCY = 2
const PING_SEC = 1
/** 超长会话的轮数：门槛原文是「> 20 轮」，25 轮同时越过**上下文窗口**的默认值（20） */
const LONG_ROUNDS = 25

const port = Number.parseInt((process.env.CHAT_PACKAGE_PORT ?? '').trim() || '13096', 10)
const baseUrl = `http://127.0.0.1:${port}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdConversationIds = []
const createdKbIds = []
const createdDocIds = []

/** **门槛① 的问题**：它的后半段必须**逐字出现在 PDF #2 的正文里**（两路检索同时命中） */
const QUERY = 'accommodation limit'

/**
 * 三篇夹具 PDF —— 三个互不重叠的主题，每篇都带一个**只可能来自它自己**的特征短语（R7 用它取证）。
 *
 * ⚠️ 三处刻意：
 *   · **英文/ASCII**：本仓 `makePdf` 是 Helvetica + latin1（见文件头 ⚠️②），装不下中文；
 *   · **全文 < 512 字符**（`chunk_size` 默认值）⇒ 每篇恰好 1 块，`chunkCount === 1` 可断言，
 *     也让"引用片段逐字等于库里那一块"这条断言简单可读；
 *   · **关键词与查询同在一行**：全文路是**字面子串匹配**（`LIKE '%accommodation limit%'`），
 *     pdf.js 会按行提取 ⇒ 短语必须不被换行切开。
 */
const PDFS = [
  {
    fileName: `travel-policy-${suffix}.pdf`,
    marker: 'standard-class rail tickets',
    lines: [
      'Travel Policy 2026',
      'Employees may book standard-class rail tickets for business trips.',
      'Hotel booking must be made through the internal travel portal.',
      'Every trip needs receipts, filed within five days of the return.',
      'The travel desk reviews all bookings once a week.',
    ],
  },
  {
    fileName: `expense-rules-${suffix}.pdf`,
    marker: 'accommodation limit is 500 CNY per night',
    lines: [
      'Expense Rules 2026',
      'The accommodation limit is 500 CNY per night for domestic travel.',
      'Anything above that needs written approval from a department head.',
      'Taxi fares are reimbursed at actual cost when public transport is unavailable.',
      'Submit all invoices before the fifth day of the following month.',
    ],
  },
  {
    fileName: `meeting-room-${suffix}.pdf`,
    marker: 'video conference kit',
    lines: [
      'Meeting Room Guide 2026',
      'Rooms can be reserved up to two weeks in advance.',
      'Each room holds eight people and has a video conference kit.',
      'Please cancel unused bookings early so that others can take the slot.',
    ],
  },
]
const pdfBytesOf = (entry) => fixtures.makePdf([entry.lines])

const prisma = getPrisma()
const redis = getRedis()
const s3 = getS3Client()
const bucket = config.s3.bucket

/** **门槛⑦ 的端点台账**：本档每一个 HTTP 请求都记一行（去重后打印，见文件头 ⚠️ R7） */
const httpLedger = []

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
  httpLedger.push({ method, path: path.split('?')[0], status: response.status })
  return { status: response.status, headers: response.headers, raw, body: json }
}

const newJar = () => ({ value: '' })

async function login(jar, username, password) {
  const response = await request(jar, 'POST', '/api/auth/login', { username, password })
  return { response, jar }
}

/** 上传一个夹具文件（真 multipart —— 走的是产品路径，不是"脚本塞字节"） */
async function uploadPdf(jar, kbId, entry) {
  const form = new FormData()
  form.append('file', new Blob([pdfBytesOf(entry)], { type: 'application/pdf' }), entry.fileName)
  const headers = {}
  if (jar.value !== '') headers.cookie = `${SESSION_COOKIE_NAME}=${jar.value}`
  const response = await fetch(`${baseUrl}/api/knowledge-bases/${kbId}/documents`, {
    method: 'POST',
    headers,
    body: form,
  })
  const json = await response.json()
  httpLedger.push({ method: 'POST', path: `/api/knowledge-bases/:id/documents`, status: response.status })
  assertEqual(response.status, 200, `上传 ${entry.fileName}`)
  const parsed = uploadDocumentResultSchema.parse(json.data)
  assertEqual(parsed.deduplicated, false, `${entry.fileName} 不该被判重（三篇内容互不相同）`)
  createdDocIds.push(parsed.document.id)
  return parsed.document
}

// ───────────────────────────── SSE 流的读侧 ─────────────────────────────

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
  httpLedger.push({ method: 'POST', path: '/api/conversations/:id/chat', status: response.status })
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

/** 等某会话空闲（上一条流收尾是异步的 ⇒ 每条要新开流的用例都该先等它，否则会撞 CONFLICT） */
async function waitIdle(jar, conversationId, label = '会话空闲') {
  const idle = await waitUntil(
    async () => (await readActive(jar, conversationId)).streaming === false,
    8000,
    label,
  )
  assert(idle, `前置不成立：${label}`)
}

/** 等流收尾（`done` 或 `error` 二选一）。生产上流总是二选一收尾（`shared/src/sse.ts` 文件头 ③） */
async function waitStreamEnd(stream, label, timeoutMs = 15_000) {
  await waitUntil(
    async () => stream.ended || stream.frames.some((f) => f.event === 'done' || f.event === 'error'),
    timeoutMs,
    label,
  )
  // `done`/`error` 之后服务端还会 `end()`，给读循环一点时间把残余帧抽完
  await sleep(120)
  return stream
}

/**
 * 落库的消息（**按时间正序**）—— 走**真端点** `GET /api/conversations/:id/messages`（P0-1-28）。
 * 翻页取全：本档 R5 的会话有 50 条消息，顺带把"翻页拼接方向"在真实编排数据上再走一遍。
 */
async function messagesOf(jar, conversationId, limit = 100) {
  const items = []
  let cursor = null
  for (;;) {
    const query = `?limit=${limit}${cursor === null ? '' : `&beforeId=${cursor}`}`
    const response = await request(jar, 'GET', `/api/conversations/${conversationId}/messages${query}`)
    assertEqual(response.status, 200, '消息历史状态码')
    const parsed = messagePageResultSchema.safeParse(response.body?.data)
    assert(parsed.success, `消息历史不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    // ⚠️ 各页是"更早的一页"、页内正序 ⇒ 拼接方向是**新页在前**（`unshift`）
    items.unshift(...parsed.data.items)
    if (!parsed.data.hasMore) break
    cursor = parsed.data.nextCursor
  }
  return items
}

// ───────────────────────────── 业务助手（全部走真 HTTP）─────────────────────────────

async function listDocuments(jar, kbId) {
  const response = await request(jar, 'GET', `/api/knowledge-bases/${kbId}/documents?limit=100`)
  assertEqual(response.status, 200, '文档列表状态码')
  return documentListResultSchema.parse(response.body.data)
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

/** 发一轮并把流跑到收尾（R2/R5 反复用） */
async function sendRound(jar, conversationId, content, label) {
  await waitIdle(jar, conversationId, `${label}：开流前会话空闲`)
  const opened = await openChatStream(jar, conversationId, content)
  assert(opened.stream !== undefined, `${label}：应当拿到 SSE 流（拿到 ${opened.response.status} 说明被前置闸门拦了）`)
  await waitStreamEnd(opened.stream, `${label}：流收尾`)
  return opened.stream
}

/** 文档的唯一一块正文（引用片段的"原文"必须从库里取，不能拿夹具自己算） */
async function chunksOf(docId) {
  return prisma.$queryRaw`SELECT seq, content FROM chunks WHERE doc_id = ${docId}::uuid ORDER BY seq`
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
        `端口 ${port} 上已有服务在回答，请换端口：CHAT_PACKAGE_PORT=13095 node scripts/verify-chat-package.mjs`,
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
      // ⚠️ 并发闸给 **2** 而不是 1：R4 要验的是**会话互斥**（CONFLICT），给 1 会让
      //    "编排名额满"（BUSY）成为另一个可能的拒绝理由，两个错误码混在一起就说不清了。
      //    BUSY 那一路由 `verify:chatbot` 的 D 组用 `CHATBOT_CONCURRENCY=1` 专门验。
      CHATBOT_CONCURRENCY: String(CHATBOT_CONCURRENCY),
      // 上游超时要收紧：R4 的 stall 会一直挂着，配默认值（30s+）会把收尾拖住
      LLM_REQUEST_TIMEOUT_MS: '15000',
      LLM_STREAM_IDLE_TIMEOUT_MS: '15000',
      // 假 embedding 上游（子进程里的 worker 要靠它才能把三篇 PDF 送到 READY）
      EMBEDDING_MODE: 'api',
      EMBEDDING_API_URL: embeddingUpstream.url,
      EMBEDDING_API_KEY: 'verify-chat-package-embed-key',
      EMBEDDING_API_MODEL: 'verify-embed-model',
      // 队列是"被消费"的资源 ⇒ 给这个一次性进程一条独立队列（否则同机的 dev server 会抢走任务）
      PIPELINE_QUEUE_KEY: `verify:chat-package:jobs:${suffix}`,
      // ⚠️ R6 要读 TTFT 那条日志 ⇒ 不能收到 fatal
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

/**
 * 数一数这些键里还有几个存在（清场用）。
 *
 * ⚠️ 刻意**逐个 `get`**：本仓 `getRedis()` 返回的 node-redis 客户端上**没有 `mGet`**
 * （P0-1-27 实测：整块复核被 `try/catch` 静默吞掉）。也刻意**不**用 `keys('chat.active:*')`
 * —— 那会把本机 dev server 正在跑的会话算进来 ⇒ 假红（枚举"脚本会创建的全部键"）。
 */
async function countPresentKeys(keys) {
  let present = 0
  for (const key of keys) {
    const value = await redis.get(key).catch(() => null)
    if (value !== null && value !== undefined) present += 1
  }
  return present
}

// ═════════════════════════════ 主流程 ═════════════════════════════

console.log(`\n${c.b}══ P0-1-29 对话包验收（包 F 收口 / 阶段一出口）：七条门槛逐行跑 ══${c.x}`)
console.log(`  ${c.d}目标：${baseUrl}（脚本自己起进程 + 两个假上游，跑完删净）${c.x}`)
console.log(
  `  ${c.d}注入：CHATBOT_CONCURRENCY=${CHATBOT_CONCURRENCY}｜SSE_PING_INTERVAL_SEC=${PING_SEC}｜` +
    `假对话上游 ${chatUpstream.url}｜假 embedding 上游 ${embeddingUpstream.url}${c.x}`,
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

/** R7 的证据 3 收集处：每一轮真发收到的增量拼接（正文必须与服务端落库的逐字相同） */
const streamedTexts = []
/**
 * R7 证据 1 的两个**记录点**（在 R1 里真跑、在 R7 里汇总断言）。
 *
 * 为什么不在 R7 里现跑：这两件事**只在特定时刻成立** ——
 * "我们自选的密码登不进"必须在**改密之前**试，改密之后就变成"能进"了。
 * 拆成"真跑 + 汇总"而不是在 R7 里重放，是为了让 R7 不依赖"时序还能重现"这个假设。
 */
const evidence = { chosenPasswordLoginStatus: undefined, serverPasswordLoginStatus: undefined }

try {
  // ───────────────────────────── 准备 ─────────────────────────────
  server = await startServer()

  // ⚠️ **唯一的直接写库**：自举管理员。没有任何 HTTP 入口能造出"第一个管理员"
  //    （产品路径是 `pnpm db:seed`，它做的是同一件事）⇒ 属自举，不是业务数据干预。
  //    门槛① 的"用户"必须走 `POST /api/users`，下面 R1 会证明这一点。
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash: await hashPassword(CHOSEN_PASSWORD),
      nickname: '对话包验证管理员',
      role: 'ADMIN',
      status: 'ACTIVE',
      mustChangePassword: false,
    },
  })
  createdUserIds.push(admin.id)
  const adminJar = (await login(newJar(), adminUsername, CHOSEN_PASSWORD)).jar

  // Provider / 模型（C 包产物）：`base_url` 指向**假对话上游**，Key 要真加密落库
  const providerResponse = await request(adminJar, 'POST', '/api/model-providers', {
    name: `验证 Provider ${suffix}`,
    baseUrl: chatUpstream.url,
    type: 'CHAT',
    apiKey: PROVIDER_KEY,
  })
  assertEqual(providerResponse.status, 200, '建 Provider')
  const provider = providerResponse.body.data
  createdProviderIds.push(provider.id)

  const modelResponse = await request(adminJar, 'POST', '/api/models', {
    providerId: provider.id,
    modelName: `verify-chatpkg-model-${suffix}`,
    label: '验证对话模型',
    type: 'CHAT',
    maxContext: 4096,
  })
  assertEqual(modelResponse.status, 200, '建模型')
  const chatModel = modelResponse.body.data
  createdModelIds.push(modelResponse.body.data.id)

  console.log(`  ${c.d}临时数据：自举管理员 ${adminUsername}（ADMIN）｜待建用户 ${staffUsername}${c.x}`)

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R1',
    '门槛① admin 建号 → 用户登录 → 建库传 3 篇 PDF → 建 ChatBot 绑库 → 提问 → **带引用回答**',
    '一条链跨 B/C/D/E/F 五个包；每一条都走产品端点（也是门槛⑦ 的第一手证据）',
  )
  // ═══════════════════════════════════════════════════════════════════

  let staffJar
  let staffId
  let initialPassword
  let kb
  let agentId

  await it('admin 建号：初始密码由**服务端生成**并仅此一次明文返回（18 字符、无易混字符）', async () => {
    const response = await request(adminJar, 'POST', '/api/users', {
      username: staffUsername,
      nickname: '对话包验证用户',
      role: 'MEMBER',
    })
    assertEqual(response.status, 200, '建号状态码')
    const parsed = initialPasswordResultSchema.safeParse(response.body?.data)
    assert(parsed.success, `建号响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    staffId = parsed.data.user.id
    initialPassword = parsed.data.initialPassword
    createdUserIds.push(staffId)

    // ⚠️ **R7 证据 1**：拿本脚本**自选**的密码去登这个新号 —— 现在（改密之前）必须登不进。
    //    这一条比"密码看起来是随机的"强得多：它直接证明账号的凭据是服务端下发的那一串，
    //    而不是脚本/人手塞进去的常量。改密之后这个结论就不再成立了 ⇒ 只能此刻试。
    //    ⚠️ **先收证据再断言**：把收集放在断言之前，失败时 R7 才能报出"缺哪一条证据"，
    //    而不是级联成一句 `期望 401，实际 undefined`（本档第一次真跑就踩了这个级联）。
    evidence.chosenPasswordLoginStatus = (await login(newJar(), staffUsername, CHOSEN_PASSWORD)).response.status

    assertEqual(parsed.data.user.role, 'MEMBER', '角色')
    assertEqual(typeof initialPassword, 'string', 'initialPassword 类型')
    assertEqual(initialPassword.length, INITIAL_PASSWORD_LENGTH, '初始密码长度（服务端生成）')
    // `02` §4.2 的契约是"18 字符、**无易混字符**"。实际字母表剔掉的是 `0`/`1`/`I`/`l`/`O`
    // （`crypto.ts#PASSWORD_ALPHABET`）—— **小写 `o` 是保留的**，因为 `0` 与 `O` 都不在表里，
    // 它不会与任何字符混。断言按**实际口径**写，否则会以 57/… 的概率随机变红
    // （本档第一次真跑就是这样：`hV3G83CdDNEdqEiNoQ` 里那个 `o` 让一条"看起来更严"的断言假红）。
    assert(
      /^[A-Za-z0-9]+$/.test(initialPassword) && !/[01IlO]/.test(initialPassword),
      `初始密码必须在服务端字母表内（无易混字符 0/1/I/l/O），实际 ${JSON.stringify(initialPassword)}`,
    )
    console.log(`         ${c.d}初始密码 ${initialPassword.length} 字符（明文只在这一条响应里）${c.x}`)
  })

  await it('用**初始密码**登录成功；此时打业务接口被首登闸门拦下（403 + 改密文案）', async () => {
    const attempt = await login(newJar(), staffUsername, initialPassword)
    evidence.serverPasswordLoginStatus = attempt.response.status
    assertEqual(attempt.response.status, 200, '初始密码登录')
    assertEqual(attempt.response.body.data.mustChangePassword, true, '新建账号必须处于"首登改密"态')
    staffJar = attempt.jar

    // 业务 API（登录即可的那一族）——闸门必须在**业务**接口上生效，不是在 auth 上
    const gated = await request(staffJar, 'GET', '/api/knowledge-bases')
    assertEqual(gated.status, 403, '首登未改密时业务接口应 403')
    assertIncludes(gated.body?.msg ?? '', '修改密码', '403 的文案要指向"去改密"（与权限 403 区分开）')
  })

  await it('改密后闸门放行同一个业务接口（403 → 200 是一对，缺一半验不出"闸门真的开了"）', async () => {
    const changed = await request(staffJar, 'POST', '/api/auth/password', {
      oldPassword: initialPassword,
      newPassword: CHOSEN_PASSWORD,
    })
    assertEqual(changed.status, 200, '改密状态码')
    const me = await request(staffJar, 'GET', '/api/auth/me')
    assertEqual(me.status, 200, '/auth/me')
    assertEqual(me.body.data.mustChangePassword, false, '改密标记应当被清掉')
    assertEqual((await request(staffJar, 'GET', '/api/knowledge-bases')).status, 200, '同一句业务请求现在应当 200')
  })

  await it('建知识库 + 传 3 篇 PDF：三篇都从 PARSING 走到 READY，且各恰好 1 块', async () => {
    const kbResponse = await request(staffJar, 'POST', '/api/knowledge-bases', {
      name: `验证库-对话包-${suffix}`,
      // `score: 0` 是刻意的：假 embedding 给的是"词面重叠型"向量，默认阈值 0.3 会把候选全过滤
      // （与 `verify-retrieval` / `verify-chatbot` 同款口径）
      retrievalConfig: { score: 0 },
    })
    assertEqual(kbResponse.status, 200, '建库状态码')
    kb = kbResponse.body.data
    createdKbIds.push(kb.id)

    for (const entry of PDFS) {
      const document = await uploadPdf(staffJar, kb.id, entry)
      assertEqual(document.status, 'PARSING', `${entry.fileName} 上传后应当是 PARSING（解析是异步的）`)
      assertEqual(document.chunkCount, 0, `${entry.fileName} 此刻还没有块（P0-1-18 的既定中间态）`)
    }

    // 等三篇都 READY（真流水线：子进程里的 worker + 假 embedding 上游在干活）
    let observed = ''
    await waitUntil(
      async () => {
        const page = await listDocuments(staffJar, kb.id)
        observed = page.items.map((item) => `${item.fileName}=${item.status}`).join(' ')
        return page.items.length === PDFS.length && page.items.every((item) => item.status === 'READY')
      },
      90_000,
      `三篇 PDF 走到 READY（最后观察：${observed}）`,
      200,
    )
    const page = await listDocuments(staffJar, kb.id)
    assertEqual(page.items.length, 3, '列表里恰好三篇')
    for (const item of page.items) {
      assertEqual(item.chunkCount, 1, `${item.fileName} 的 chunkCount（三篇都短于 chunk_size）`)
    }
  })

  await it('建 ChatBot 并绑这个库：详情回显的绑定就是提交的那一个', async () => {
    const agent = await createAgent(staffJar, `验证对话包智能体-${suffix}`, {
      modelId: chatModel.id,
      systemPrompt: `你是公司制度的专属助手（${suffix}）`,
      guideQuestions: ['出差住宿标准是多少'],
    })
    agentId = agent.id
    const bind = await request(staffJar, 'PUT', `/api/agents/${agent.id}/components`, {
      components: [{ componentType: 'KNOWLEDGE', refId: kb.id }],
    })
    assertEqual(bind.status, 200, '绑库状态码')
    const detail = await request(staffJar, 'GET', `/api/agents/${agent.id}`)
    assertEqual(detail.status, 200, '详情状态码')
    assertEqual(detail.body.data.components.length, 1, '详情里的绑定数')
    assertEqual(detail.body.data.components[0].refId, kb.id, '绑的就是刚建的那个库')
  })

  let r1Conversation
  let r1Stream

  await it('提问：`citations` 事件先到，引用的三篇里的**命中那篇**排第一，片段与库里那块逐字相同', async () => {
    r1Conversation = await createConversation(staffJar, agentId)
    const opened = await openChatStream(staffJar, r1Conversation.id, QUERY)
    r1Stream = opened.stream
    assert(r1Stream !== undefined, '应当拿到 SSE 流')
    assertEqual(opened.response.status, 200, '状态码')
    assertIncludes(
      opened.response.headers.get('content-type') ?? '',
      'text/event-stream',
      '响应类型（成功路径不是 JSON 信封）',
    )
    await waitStreamEnd(r1Stream, 'R1 提问流收尾')
    assertEqual(r1Stream.malformed, 0, '不应有畸形帧')
    assertEqual(firstFrameOf(r1Stream.frames, 'done').data.finishReason, 'COMPLETE', 'finishReason')

    const citations = firstFrameOf(r1Stream.frames, 'citations')
    assert(citations !== undefined, '绑了库、命中了内容 ⇒ 必须有 citations 事件（`01` 决策 12 的前一半）')
    const names = citations.data.items.map((item) => item.docName)
    const allNames = PDFS.map((entry) => entry.fileName)
    assert(
      names.every((name) => allNames.includes(name)),
      `引用卡上的文档名必须都在上传的那三篇之内，实际 ${JSON.stringify(names)}`,
    )
    assertEqual(
      citations.data.items[0].docName,
      PDFS[1].fileName,
      '⚠️ 查询词逐字出现在第 2 篇里（两路检索都命中它）⇒ 它必须排第一',
    )

    const chunk = (await chunksOf(createdDocIds[1]))[0]
    // ⚠️ 引用片段是**原文窗口**（`buildSnippet`：围绕字面命中位置开 ±80 码点，不加工、不加省略号），
    //    **不是**整块正文 —— "片段 == 整块"只在块短于窗口（≤160 码点）时成立。
    //    本档的夹具刻意长过窗口（要放得下特征短语 + 关键词 + 干扰句），于是这条断言写成
    //    片段契约的**真实形态**（P0-1-20 那条"片段与原文一致可核对"的原意）：
    //    是原文的**子串**（可核对）且含查询词（窗口是围绕命中位置开的）。
    const snippet = citations.data.items[0].snippet
    assertIncludes(chunk.content, snippet, '⚠️ 引用片段必须是那一块正文的子串（原文窗口，不加工、不加省略号）')
    assertIncludes(snippet, QUERY, '窗口是围绕字面命中位置开的 ⇒ 必须含查询词')
    assert(
      [...snippet].length <= 2 * SNIPPET_WINDOW_CHARS + [...QUERY].length,
      `片段长度上界：窗口 ±${SNIPPET_WINDOW_CHARS} 码点 + 命中词长度，实际 ${[...snippet].length}`,
    )

    const deltaAt = firstFrameOf(r1Stream.frames, 'delta')?.at ?? Infinity
    assert(citations.at <= deltaAt, '引用卡事件应当先于第一个增量（引用区在回答之前就挂上）')
  })

  await it('回答**带引用**：正文里出现《命中文档名》，且增量是流式的多段', async () => {
    const deltas = framesOf(r1Stream.frames, 'delta')
    assert(deltas.length >= 2, `应当是流式的多段增量，实际 ${deltas.length} 段`)
    const text = deltaTextOf(r1Stream)
    streamedTexts.push(text)
    assertIncludes(text, `《${PDFS[1].fileName}》`, '回答里必须带上命中那篇的文档名')
    assertIncludes(text, '根据《', '夹具的标准回答形状（证明检索块真的进了 prompt）')
    const last = chatUpstream.requests[chatUpstream.requests.length - 1]
    assertIncludes(
      last.body.messages[0].content,
      `来源：${PDFS[1].fileName}`,
      '⚠️ 服务端真的把检索块拼进了 system prompt',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R2',
    '门槛② 停止生成 → 已生成部分保留 → 可直接追问',
    '夹具换 40 段慢增量 ⇒ 中途 /stop ⇒ `done{STOPPED}` 且落库正文恰好是已生成的那部分',
  )
  // ═══════════════════════════════════════════════════════════════════

  let r2Conversation
  let r2Stream
  const longPieces = Array.from({ length: 40 }, (_, index) => `第${index + 1}段。`)

  await it('流中停止：5s 内 `done{finishReason:STOPPED}` 且 `messageId` 非空', async () => {
    r2Conversation = await createConversation(staffJar, agentId)
    chatUpstream.setScript(() => longPieces)
    const opened = await openChatStream(staffJar, r2Conversation.id, QUERY)
    r2Stream = opened.stream
    await waitUntil(async () => framesOf(r2Stream.frames, 'delta').length >= 3, 8000, '至少收到 3 段增量')
    const stop = await request(staffJar, 'POST', `/api/conversations/${r2Conversation.id}/stop`)
    assertEqual(stop.status, 200, '停止端点状态码')
    assertEqual(stop.body.data.signaled, true, 'signaled=true（确实有一个在跑的流收到了信号）')
    await waitStreamEnd(r2Stream, '停止后流收尾', 6000)
    const done = firstFrameOf(r2Stream.frames, 'done')
    assert(done !== undefined, `必须收到 done，实际帧：${JSON.stringify(frameNames(r2Stream.frames))}`)
    assertEqual(done.data.finishReason, 'STOPPED', 'finishReason')
    assert(
      typeof done.data.messageId === 'string' && done.data.messageId !== '',
      'producer 接住中断 ⇒ messageId 必须非空（`01` 决策 15 的"保留"落在落库上）',
    )
  })

  await it('已生成的部分**原样保留**：增量数 < 40，落库正文 == 收到的那部分拼接（且非空）', async () => {
    const deltas = framesOf(r2Stream.frames, 'delta')
    assert(deltas.length < longPieces.length, `应当被中断，实际收到 ${deltas.length}/${longPieces.length} 段`)
    const rows = await messagesOf(staffJar, r2Conversation.id)
    assertEqual(rows.length, 2, '两条消息（用户 + 已生成的部分回答）')
    assertEqual(rows[0].content.text, QUERY, '用户消息正文 = 提问原文')
    assertEqual(rows[1].role, 'ASSISTANT', '第二条是助手消息')
    assertEqual(rows[1].content.text, deltaTextOf(r2Stream), '落库正文 = 已生成的增量拼接（正好那么多）')
    assert(rows[1].content.text !== '', '已生成的部分不能是空的')
    streamedTexts.push(rows[1].content.text)
  })

  await it('可直接追问：上一轮（被停止的）回答真的进了 prompt，且本轮正常收尾', async () => {
    chatUpstream.setScript(null) // 恢复默认脚本
    const stream = await sendRound(staffJar, r2Conversation.id, '再总结一下要点', 'R2 追问')
    assertEqual(firstFrameOf(stream.frames, 'done').data.finishReason, 'COMPLETE', '追问也要正常收尾')
    const last = chatUpstream.requests[chatUpstream.requests.length - 1]
    const messages = last.body.messages
    assertEqual(messages[messages.length - 1].content, '再总结一下要点', '末条是本轮提问')
    assertEqual(messages[messages.length - 2].role, 'assistant', '倒数第二条是上一轮的回答（历史还原）')
    assertIncludes(messages[messages.length - 2].content, '第1段。', '上一轮被停止时的已生成内容进了历史')
    assertEqual(messages[messages.length - 3].content, QUERY, '再往前是本轮的第一句提问')
    assertEqual((await messagesOf(staffJar, r2Conversation.id)).length, 4, '落库累计 4 条')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R3',
    '门槛③ 刷新页面 → 历史完整恢复（含引用卡）',
    '⚠️ HTTP 层（`GET /:id/messages` 就是"重画整个对话页"的那一个请求）；浏览器渲染属 P0-1-32~34',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('R1 那条会话：一次请求取回全部消息，正序、成对，引用卡结构完整', async () => {
    const response = await request(staffJar, 'GET', `/api/conversations/${r1Conversation.id}/messages`)
    assertEqual(response.status, 200, '历史状态码')
    const page = messagePageResultSchema.parse(response.body.data)
    assertEqual(page.hasMore, false, '两条消息应当一页取全')
    assertEqual(page.items.length, 2, '恰好两条')

    // 正序（旧 → 新）：界面按"追加"渲染，顺序错了会看到"回答在提问之前"
    assertEqual(page.items[0].role, 'USER', '第一条是用户消息')
    assertEqual(page.items[1].role, 'ASSISTANT', '第二条是助手消息')
    assertEqual(page.items[0].content.text, QUERY, '用户消息正文 = 提问原文（trim 之后）')

    // ⚠️ 键序无关地比：`content` 是 jsonb，PG 会重排对象键（P0-1-27 实测的假红）
    assertEqual(
      canonicalJson(page.items[1].content.citations),
      canonicalJson(firstFrameOf(r1Stream.frames, 'citations').data.items),
      '刷新后重绘的引用卡必须与事件流里那张逐字相同（同一份数据的两个出口）',
    )
    assertEqual(page.items[1].content.text, deltaTextOf(r1Stream), '助手消息正文 = 事件流里的增量拼接')
  })

  await it('R2 那条会话：停止 → 追问的四条消息都在，且被中断那一轮的内容没被改写', async () => {
    const rows = await messagesOf(staffJar, r2Conversation.id)
    assertEqual(rows.length, 4, '两条用户 + 两条助手')
    assertEqual(rows.map((row) => row.role).join(','), 'USER,ASSISTANT,USER,ASSISTANT', '成对且正序')
    assertEqual(rows[0].content.text, QUERY, '第一轮提问')
    // ⚠️ 第 2 条才是**被停止时已生成的那部分**（第 4 条是追问的回答，别数错位置）：
    //    它必须含第 1 段、且**短于**夹具的完整脚本 —— 这两条合起来才排掉
    //    "把中断当失败、整条丢掉"与"把没生成的内容补齐"两种坏法
    assertIncludes(rows[1].content.text, '第1段。', '被中断那一轮的已生成内容还在')
    assert(
      rows[1].content.text.length < longPieces.join('').length,
      '⚠️ 它必须是**部分**（落库的不能是完整脚本 —— 那意味着中断后还在继续生成）',
    )
    assert(rows[3].content.text !== '', '追问的回答也在（历史是按"轮"累加的）')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R4',
    `门槛④ 同会话并发发送 → \`CONFLICT\`（注入 CHATBOT_CONCURRENCY=${CHATBOT_CONCURRENCY}）`,
    '互斥锁在**开流处**；V 满 ⇒ 流内 `error{code:CONFLICT}` 单帧（不是 409 信封）',
  )
  // ═══════════════════════════════════════════════════════════════════

  const r4Conversation = await createConversation(staffJar, agentId)
  let r4First

  await it('第一条流（stall）占住这个会话：确认它真的在飞（上游已收到请求）', async () => {
    chatUpstream.setMode('stall')
    const before = chatUpstream.requests.length
    const opened = await openChatStream(staffJar, r4Conversation.id, '占住这个会话')
    assert(opened.stream !== undefined, '第一条流应当能开出来')
    r4First = opened
    await waitUntil(
      async () => chatUpstream.requests.length > before,
      8000,
      '上游收到第一条流的请求（说明锁已经拿到）',
    )
  })

  await it('第二条流：HTTP 200 + `error{code:CONFLICT}` 单帧（**不是** 409 信封）', async () => {
    const opened = await openChatStream(staffJar, r4Conversation.id, '这条应当被互斥拒绝')
    assert(opened.stream !== undefined, '被拒也是以流的形式（主语是"这一轮生成"，不是"这个请求"）')
    await waitStreamEnd(opened.stream, 'CONFLICT 流收尾', 8000)
    const errorFrame = firstFrameOf(opened.stream.frames, 'error')
    assert(
      errorFrame !== undefined,
      `应当收到 error 事件，实际：${JSON.stringify(frameNames(opened.stream.frames))}`,
    )
    assertEqual(errorFrame.data.code, 'CONFLICT', '错误码')
    assertIncludes(
      opened.response.headers.get('content-type') ?? '',
      'text/event-stream',
      '⚠️ CONFLICT 走流内事件而不是 JSON 信封（分界线是主语，见 `shared/src/sse.ts` 文件头 ③）',
    )
    assert(!hasEvent(opened.stream.frames, 'done'), 'error 之后不该再有 done（二选一收尾）')
  })

  await it('收尾：客户端断开 ⇒ 锁释放；被拒的那一轮**没有留下任何消息**', async () => {
    chatUpstream.setMode('normal')
    r4First.abort()
    await waitUntil(
      async () => (await readActive(staffJar, r4Conversation.id)).streaming === false,
      8000,
      '断开后锁释放',
    )
    // ── 这一条真跑出来的口径（P0-1-29 定案，原来写错了）──
    // 第一条流是**绑了库**的智能体：检索跑在 LLM **之前** ⇒ 引用卡在 stall 开始前就已经发出去了。
    // 于是哪怕上游一个字都没吐，这一轮也**真的发生过** ⇒ 按 `persistRoundQuietly` 的
    // `hasAssistantContent`（正文 / 思考 / 引用**任一非空**）必须落一条**只带引用卡、正文为空**的
    // 助手消息。⚠️ P0-1-27 那档断言的是"只落库用户消息"，因为它的 D 组用的是**不绑库**的 Agent
    // （无引用卡）—— 两档都没错，缺的是"绑库时多一条引用卡"这一半。
    assert(
      hasEvent(r4First.stream.frames, 'citations'),
      '检索在 LLM 之前 ⇒ 引用卡应当已经发出（下面那条"只有引用卡的助手消息"因此才是预期行为）',
    )
    const rows = await messagesOf(staffJar, r4Conversation.id)
    const trace = JSON.stringify(rows.map((row) => ({ role: row.role, text: row.content.text })))
    assertEqual(rows.length, 2, `用户消息 + 只带引用卡的助手消息，实际 ${trace}`)
    assertEqual(rows[0].role, 'USER', `落库的第一条是用户消息，实际 ${trace}`)
    assertEqual(rows[0].content.text, '占住这个会话', `⚠️ 被拒的那一句不得出现在历史里，实际 ${trace}`)
    assertEqual(rows[1].role, 'ASSISTANT', `第二条是助手消息，实际 ${trace}`)
    assertEqual(rows[1].content.text, '', '正文为空（上游一个字都没吐）')
    assert(
      Array.isArray(rows[1].content.citations) && rows[1].content.citations.length >= 1,
      `但引用卡在 ⇒ 这条助手消息必须有，实际 ${trace}`,
    )
    assert(
      !JSON.stringify(rows).includes('这条应当被互斥拒绝'),
      '⚠️ 被拒那一轮的正文一个字都不该落库（并发失败 ⇒ 这一轮没发生）',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R5',
    `门槛⑤ 超长会话（${LONG_ROUNDS} 轮）不报错`,
    `真发 ${LONG_ROUNDS} 轮（>= 20 轮门槛，同时越过上下文窗口的默认 20 轮）—— 不用"直接造历史"冒充`,
  )
  // ═══════════════════════════════════════════════════════════════════

  const r5Conversation = await createConversation(staffJar, agentId)

  await it(`连续 ${LONG_ROUNDS} 轮真发：每轮都拿到 \`done{COMPLETE}\`，无 error 事件、无 4xx`, async () => {
    let lastNames = []
    for (let index = 1; index <= LONG_ROUNDS; index += 1) {
      const stream = await sendRound(staffJar, r5Conversation.id, `第 ${index} 轮的问题：住宿标准是多少`, `R5 第 ${index} 轮`)
      lastNames = frameNames(stream.frames)
      const done = firstFrameOf(stream.frames, 'done')
      assert(done !== undefined, `第 ${index} 轮必须正常收尾，实际帧：${JSON.stringify(lastNames)}`)
      assertEqual(done.data.finishReason, 'COMPLETE', `第 ${index} 轮的 finishReason`)
      assert(!hasEvent(stream.frames, 'error'), `第 ${index} 轮不该出现 error 事件`)
      streamedTexts.push(deltaTextOf(stream))
    }
    console.log(`         ${c.d}跑到第 ${LONG_ROUNDS} 轮的帧序列：${JSON.stringify(lastNames)}${c.x}`)
  })

  await it(`历史完整：${LONG_ROUNDS * 2} 条消息一条不漏，首尾都能翻到`, async () => {
    const rows = await messagesOf(staffJar, r5Conversation.id)
    assertEqual(rows.length, LONG_ROUNDS * 2, '消息条数')
    assertEqual(rows[0].content.text, '第 1 轮的问题：住宿标准是多少', '最早那一轮还在（翻页取全没漏）')
    assertEqual(rows[rows.length - 1].role, 'ASSISTANT', '最后一条是助手消息')
    assertEqual(rows[LONG_ROUNDS * 2 - 2].content.text, `第 ${LONG_ROUNDS} 轮的问题：住宿标准是多少`, '最后一轮提问')
    assertEqual(rows[LONG_ROUNDS * 2 - 1].content.text, streamedTexts[streamedTexts.length - 1], '最后一轮回答')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R6',
    '门槛⑥ 首字延迟 < 3s（以服务端 TTFT 日志为准）',
    '⚠️ 上游是本地假夹具 ⇒ 这是"链路值"不是"模型值"（见文件头 ⚠️③）',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it(`服务端日志里有 TTFT 打点，且**每一次**都 < 3000ms（本档共 ${streamedTexts.length} 轮有过增量）`, async () => {
    const samples = serverLog
      .split('\n')
      .filter((line) => line.includes('本轮首字延迟（TTFT）'))
      .map((line) => {
        const parsed = JSON.parse(line)
        return { ttftMs: parsed.ttftMs, historyMessages: parsed.historyMessages, citations: parsed.citations }
      })
    assert(samples.length > 0, '日志里必须有 TTFT 那条（不在的话"首字 < 3s"就无从测量）')
    const bad = samples.filter((sample) => typeof sample.ttftMs !== 'number' || !(sample.ttftMs >= 0))
    assertEqual(bad.length, 0, `ttftMs 必须是数字且非负，异常样本 ${JSON.stringify(bad)}`)
    const values = samples.map((sample) => sample.ttftMs)
    const max = Math.max(...values)
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    assert(max < 3000, `阶段一门槛是"首字 < 3s"，最慢的一次 ${max}ms 超了`)
    // 打点覆盖到"真跑过的那几轮"（少一个都说明有轮次根本没打点）
    assert(
      samples.length >= streamedTexts.length,
      `TTFT 打点数 ${samples.length} 少于"有过增量的轮数" ${streamedTexts.length}（有轮次没打点？）`,
    )
    // 打点行同时带着当轮的引用数 —— 至少要有一次 > 0（R1 那轮绑了库且命中）：
    // 这顺带证明"打点行不是被别处硬写的一行"，它确实来自编排循环里那一处
    assert(
      samples.some((sample) => typeof sample.citations === 'number' && sample.citations >= 1),
      `打点行里应当至少有一次 citations >= 1（R1 命中知识库那一轮），实际 ${JSON.stringify(
        samples.map((sample) => sample.citations),
      )}`,
    )
    console.log(
      `         ${c.d}TTFT 统计：样本 ${samples.length} 次｜最快 ${Math.min(...values)}ms｜` +
        `中位 ${median}ms｜最慢 ${max}ms（门槛 3000ms）${c.x}`,
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R7',
    '门槛⑦ 全程无手工干预数据（四条"只有服务端能产生"的证据 + 端点台账）',
    '见文件头 → 直接写"我们没插数据"是恒真的废断言，故拆成可判定的形态',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('证据① 凭据是**服务端下发的**：自选密码登不进（401）、服务端那串能进（200）', async () => {
    // 两件事都在 R1 里真跑过（见 `evidence` 的注释：这两条只在特定时刻成立），这里做汇总断言 ——
    // 手改过库、或"密码写死成常量"的实现过不了这一对
    assertEqual(evidence.chosenPasswordLoginStatus, 401, '建号后，我们自选的那个密码必须登不进')
    assertEqual(evidence.serverPasswordLoginStatus, 200, '服务端返回的初始密码必须能登进去')
    assertEqual(initialPassword.length, INITIAL_PASSWORD_LENGTH, '初始密码长度 = 服务端常量')
    // ⚠️ "字母表 / 无易混字符"那条**只在 R1 里写一份**：本档第一次真跑时这里抄了第二份，
    //    而 R1 修好之后这份留下了一个过期的正则 ⇒ 同一件事有两处写法就必然有一处先腐烂。
  })

  await it('证据② 三篇 PDF 的正文来自**我们上传的字节**，且 API 报的块数与表里一致', async () => {
    const page = await listDocuments(staffJar, kb.id)
    for (let index = 0; index < PDFS.length; index += 1) {
      const docId = createdDocIds[index]
      const rows = await chunksOf(docId)
      const item = page.items.find((candidate) => candidate.id === docId)
      assert(item !== undefined, `列表里应当有 ${PDFS[index].fileName}`)
      assertEqual(item.fileName, PDFS[index].fileName, '文件名是上传时那个（不是别人改的）')
      assertEqual(item.chunkCount, rows.length, `⚠️ ${PDFS[index].fileName}：接口报的块数 == 表里实际行数`)
      assert(rows.length > 0, `${PDFS[index].fileName} 必须有正文（否则"传了但搜不到"）`)
      const text = rows.map((row) => row.content).join('\n')
      assertIncludes(
        text,
        PDFS[index].marker,
        `⚠️ ${PDFS[index].fileName} 的正文里该有它自己的特征短语（只可能来自上传的 PDF 字节）`,
      )
    }
  })

  await it('证据③ 助手消息正文 == 事件流收到的增量拼接（服务端产物，手写不出来）', async () => {
    const rows = await messagesOf(staffJar, r1Conversation.id)
    assertEqual(rows[1].content.text, deltaTextOf(r1Stream), 'R1 的回答逐字来自事件流')
    assert(streamedTexts.every((text) => typeof text === 'string'), '每一轮都真的收到过内容')
  })

  await it('证据④ `createdBy` 由服务端从会话取（客户端提交不了这个字段）', async () => {
    const agent = await request(staffJar, 'GET', `/api/agents/${agentId}`)
    assertEqual(agent.status, 200, '详情状态码')
    assertEqual(agent.body.data.createdBy, staffId, '⚠️ 建号那个用户的 id（= 会话里的用户）')
  })

  await it('端点台账：这条链只用了产品端点，且建号 / 上传 / 提问都在里面', async () => {
    const keys = [...new Set(httpLedger.map((entry) => `${entry.method} ${entry.path}`))].sort()
    console.log(`         ${c.d}本档共 ${httpLedger.length} 个请求，去重后 ${keys.length} 个端点${c.x}`)
    for (const key of keys) console.log(`           ${c.d}· ${key}${c.x}`)
    assertIncludes(keys.join('\n'), 'POST /api/users', '建号端点必须出现过（门槛⑦ 的第一手证据）')
    assertIncludes(keys.join('\n'), 'POST /api/knowledge-bases/:id/documents', '上传端点必须出现过')
    assertIncludes(keys.join('\n'), 'POST /api/conversations/:id/chat', '提问端点必须出现过')
    const nonZero = httpLedger.filter((entry) => entry.status >= 400 && entry.status !== 404 && entry.status !== 403 && entry.status !== 401)
    assertEqual(
      nonZero.length,
      0,
      `台账里不该有 5xx（4xx 里 401/403/404 是本档刻意制造的拒绝），实际 ${JSON.stringify(nonZero)}`,
    )
  })
} catch (error) {
  failed += 1
  console.error(`\n${c.r}✖ 脚本异常（不是断言失败，是脚本本身出错）${c.x}`)
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  // ───────────────────────────── R8 清场 + 复核残留 ─────────────────────────────
  // ⚠️ 这一组**必须放在 `finally` 里**：前面的用例一旦抛错（哪怕断言全在 `it()` 里被吞掉），
  //    残留复核仍要给出结论 —— "跑完干净"本身是交付条件之一（P0-1-7 起定的规矩）。
  console.log(`\n${c.b}── 清理（自清理 + 复核残留）──${c.x}`)
  try {
    for (const conversationId of createdConversationIds) {
      await redis.del(`chat.active:${conversationId}`).catch(() => undefined)
      await redis.del(`chat.stop:${conversationId}`).catch(() => undefined)
    }
    // 顺序有讲究（外键多为 RESTRICT）：消息随会话级联 → 绑定 → 智能体 → 文档 → 库 → 用户 → 模型/Provider
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } })
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } })
    await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
    await redis.del(`verify:chat-package:jobs:${suffix}`).catch(() => undefined)
    // ⚠️ 登录失败计数键也要清：R7 证据① 刻意做了一次**失败的登录**（自选密码 → 401），
    //    那一次会建 `login-fail:{username}`。P0-1-7 的教训：复核要枚举"脚本会创建的全部键"，
    //    **包括顺手创建的**（那一批正是漏了这个键才让"跑完干净"的结论不成立）。
    for (const username of [staffUsername, adminUsername]) {
      await redis.del(loginFailKey(username)).catch(() => undefined)
    }
    // S3：上传的三篇 PDF 会真的落对象（前缀 `kb/{kbId}/`）
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

  // 复核残留：**枚举脚本会创建的全部东西**（含"顺手创建的"账号快照与两个 Redis 键族）
  let residueOk = false
  try {
    const leftovers = {
      users: await prisma.user.count({ where: { username: { contains: suffix } } }),
      providers: await prisma.modelProvider.count({ where: { name: { contains: suffix } } }),
      models: await prisma.model.count({ where: { modelName: { contains: suffix } } }),
      agents: await prisma.agent.count({ where: { name: { contains: suffix } } }),
      kbs: await prisma.knowledgeBase.count({ where: { name: { contains: suffix } } }),
      docs: await prisma.document.count({ where: { fileName: { contains: suffix } } }),
      conversations: await prisma.conversation.count({ where: { id: { in: createdConversationIds } } }),
      activeKeys: await countPresentKeys(createdConversationIds.map((id) => `chat.active:${id}`)),
      stopKeys: await countPresentKeys(createdConversationIds.map((id) => `chat.stop:${id}`)),
      queueKey: await countPresentKeys([`verify:chat-package:jobs:${suffix}`]),
      sessions: await countPresentKeys(sessionIds.map((sid) => sessionKey(sid))),
      loginFails: await countPresentKeys([staffUsername, adminUsername].map((name) => loginFailKey(name))),
    }
    const dirty = Object.entries(leftovers).filter(([, value]) => value !== 0)
    residueOk = dirty.length === 0
    if (residueOk) {
      console.log(`  ${c.g}✔ 复核残留：7 张表 + 4 个键族全部为 0（${JSON.stringify(leftovers)}）${c.x}`)
    } else {
      console.log(`  ${c.r}✖ 复核残留：仍有 ${JSON.stringify(leftovers)}${c.x}`)
    }
  } catch (error) {
    console.log(`  ${c.r}复核残留失败：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  if (serverExitedEarly) {
    console.log(`  ${c.r}⚠️ 后端子进程提前退出，服务端日志：${c.x}\n${serverLog}`)
  } else if (process.env.CHAT_PACKAGE_DEBUG === '1') {
    console.log(`  ${c.d}服务端日志（末尾 40 行）：${c.x}\n${serverLog.split('\n').slice(-40).join('\n')}`)
  }
  await chatUpstream.close().catch(() => undefined)
  await embeddingUpstream.close().catch(() => undefined)
  await stopServer().catch(() => undefined)
  await closePrisma()
  await closeRedis()

  // ⚠️ R8 的断言写在 `finally` 里（不走 `it()` 的包裹）⇒ **分组计数手工补一次**，
  //    漏了不报错、只会让结论表那一行永远显示 "(0 项全通过)"（本仓批量工作流技能第十一档 ⑦）。
  groupStart('R8', '清场：自清理 + 残留复核', '7 张表 + 4 个键族，全部要能复核为 0（不靠"我没报错"）')
  if (residueOk) {
    console.log(
      `  ${c.g}[PASS]${c.x} 临时数据已删净（含 S3 对象、会话键、停止键、队列键、会话键、登录失败计数）`,
    )
    passed += 1
  } else {
    console.log(`  ${c.r}[FAIL]${c.x} 仍有残留（见上）`)
    failed += 1
  }
}

// ───────────────────────────── 结论表（人读的交付物）─────────────────────────────

console.log(`\n${c.b}── F 包结论表（docs/06 P0-1-29 的七条验收门槛 = 阶段一出口）──${c.x}`)
groups.forEach((group, index) => {
  const { donePassed, doneFailed } = groupResult(group, index)
  const ok = doneFailed === 0
  const mark = ok ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  const detail = ok ? `${donePassed} 项全通过` : `${doneFailed} 项失败 / ${donePassed} 项通过`
  console.log(`  ${mark} ${group.id}｜${group.title}  ${c.d}(${detail})${c.x}`)
})
console.log(
  `  ${c.y}⚠️${c.x} 门槛③ 的"刷新页面"验到 **HTTP 层**（` +
    '`GET /:id/messages` 一次取回消息与引用卡）；**浏览器渲染属 P0-1-32~34**，前端现仍是占位页',
)
console.log(
  `  ${c.y}⚠️${c.x} 门槛⑥ 的 TTFT 是**链路值**（本地假上游）⇒ 证明"打点成立 + 全链路无隐藏等待"，` +
    '不能据此推算真实厂商的首字延迟（真模型见 docs/06 §七 待决事项 2）',
)
console.log(
  `  ${c.d}边界：命令行/HTTP 已能跑完整条链（建号 → 首登改密 → 建库传 PDF → 建 Agent 绑库 →` +
    `提问带引用 → 停止 → 刷新恢复 → 并发拒绝 → 超长会话）；浏览器首站仍是 P0-1-30${c.x}`,
)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-29 对话包验收通过（七条门槛）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-29 对话包验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
