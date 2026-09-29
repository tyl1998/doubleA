#!/usr/bin/env node
/**
 * verify-chat-sse.mjs —— 对话页前端**无依赖**验收
 * （P0-1-32 SSE 客户端 + **P0-1-33 输入区/停止/断线** + **P0-1-34 会话侧栏**）
 *
 * 跑法：`pnpm verify:chat-sse`
 *      （= `node --import tsx frontend/scripts/verify-chat-sse.mjs`，见文件末尾的"依赖与前置"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险**不在"界面好不好看"**，而在几处**错了不会报错、只会少一点内容或点不动**的地方：
 *   · **字节 → 帧**：一帧被 TCP 切成几段、分隔符横跨两个 chunk、一个汉字被切在两段之间……
 *     手点浏览器碰到这些边界的概率约等于零，而它们的症状是"回答偶尔缺一个字 / 断掉"；
 *   · **帧 → 状态**：`03` §五 那张"事件 → UI"映射表有十行，写错一行只表现为"少一张卡"；
 *   · **历史 vs 流式**：两条路径各自渲染时不会报错，只会"刷新前有、刷新后没有"；
 *   · **输入区状态机与停止时序**（P0-1-33）：五个状态、三种收尾路径 —— 写错的症状是
 *     "某个状态下按钮点不动""点了停止反而又发了一条""停止按钮转 5 秒圈"，
 *     每一种都要**在真浏览器里按到那一步**才看得见；
 *   · **会话侧栏的分组与读数**（P0-1-34）：分组判错只表现为"某条会话说在了错误的标题下面"、
 *     读数算错只是显示一个偏了一点的数字 —— 两者都不抛异常、控制台干净，只有断言抓得住。
 * 这些全是**纯函数**或"副作用可注入"的控制器（`sseParser.ts` / `chatStream.ts` /
 * `roundReducer.ts` / `messageModel.ts` / `composerState.ts` / `stopController.ts` /
 * `streamErrors.ts` / `alignHistory.ts` / **`conversationList.ts`**），故本档直接喂手写字节、
 * 手写事件序列与手写依赖，逐条断言最终形状与**调用顺序** —— 这是本仓"纯逻辑拆进无依赖文件
 * ⇒ 断言进无依赖档"的同一手法（对照 backend 的 `chatContext.ts` / `semaphore.ts`）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · React 渲染（七种卡片长什么样、思考块自动折叠、黄条长什么样）⇒ 归浏览器端测（`README` ⑳/㉖~㉛）；
 *   · 真后端的帧（响应头、锁、心跳、`done` 时序、`/stop` 的服务端行为）⇒ 归 `pnpm verify:chat-stream` / `verify:chatbot`；
 *   · 打包后的行为（本档跑的是**源码**，不经 vite）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一处必要的手段：让 `api/client.ts` 能在 node 里被导入
 * ─────────────────────────────────────────────────────────────────────
 * `api/client.ts` 有一行 `const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''` ——
 * `import.meta.env` 是 **Vite 在构建期注入的**，node 里它是 `undefined` ⇒ 直接导入会
 * `TypeError: Cannot read properties of undefined`。
 * 处置：注册一个**只作用于那一个文件**的加载器钩子，在它被求值前把 `import.meta.env`
 * 文本替换成 `({})`（即"模拟 Vite 注入了一个空环境"）。
 *
 * 为什么用加载器而不是去改 `client.ts`：**不该为了测试方便去改生产代码**；而且这个替换
 * 恰好就是打包器在做的事（define），是名副其实的测试替身，不是绕过。它只在本档进程里生效，
 * 也只匹配 `/api/client.ts` 这一个 URL ⇒ 不影响任何其它模块。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { register } from 'node:module'

const VITE_ENV_SHIM = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (url.endsWith('/api/client.ts') && result.source != null) {
    const source =
      typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: source.split('import.meta.env').join('({})'), shortCircuit: true }
  }
  return result
}
`
register(`data:text/javascript,${encodeURIComponent(VITE_ENV_SHIM)}`, import.meta.url)

// ───────────────────────────── 断言脚手架（与 backend/scripts 同一套）─────────────────────────────

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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/**
 * **同一个引用**的断言（`Object.is`）。
 *
 * 本档有两处专门用它：`ping` 归约、store 里的未开轮 `apply`。它们靠"返回同一个对象"
 * 保证 React **一次重渲染都不发生** —— 这比"逐字段相等"强，因为逐字段相等也可能是新对象、
 * 照样触发渲染。
 */
function assertSameRef(actual, expected, label) {
  assert(Object.is(actual, expected), `${label}：期望同一个引用，实际是不同对象`)
}

/**
 * 深比较**先规范化键序**再比。
 *
 * 不是因为本档的对象键序会变，而是本仓有一条踩过的教训：**经 jsonb 往返的值键序会被 PG 重排**，
 * 直比会出**假红**（见 `canonicalJson()` 的口径）。本档的历史消息就是从 jsonb 里读出来的，
 * 写成键序敏感的比较等于给自己埋一颗假红。
 */
function canonical(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

function assertDeepEqual(actual, expected, label) {
  assert(
    canonical(actual) === canonical(expected),
    `${label}：期望 ${canonical(expected)}，实际 ${canonical(actual)}`,
  )
}

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

/** 期望抛错并**拿到那个错**（后续要断言 code / status / 文案） */
async function assertRejects(fn, label) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error(`${label}：期望抛错，但它正常返回了`)
}

// ───────────────────────────── 造帧 / 造响应的工具 ─────────────────────────────

const { SSE_CONTENT_TYPE, ERROR_CODES, fail, ok } = await import('@doubulea/shared')

/** 一条 SSE 帧的**字节形态**（与 `orchestrator/sse.ts#serializeSseFrame` 逐字同形：只有两行 + 空行） */
function sseFrame(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

const encoder = new TextEncoder()

function bytesOf(text) {
  return encoder.encode(text)
}

/** 用**真 `Response`** 包一段手搓的流（`chatStream.ts` 只认 `response.body`） */
function responseOfChunks(chunks, init = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': SSE_CONTENT_TYPE },
    ...init,
  })
}

/** 按给定的字节切点把一段文本切成多个 chunk（切点可以落在**多字节字符中间**） */
function responseOfSplits(text, cuts) {
  const bytes = bytesOf(text)
  const points = [0, ...cuts, bytes.length]
  const chunks = []
  for (let index = 0; index < points.length - 1; index += 1) {
    chunks.push(bytes.slice(points[index], points[index + 1]))
  }
  return responseOfChunks(chunks)
}

/** 收事件的探针（`ping` 也收 —— 忽略与否是归约层的事，读取层不许自作主张） */
function collector() {
  const events = []
  const issues = []
  return {
    events,
    issues,
    handlers: {
      onEvent: (event) => events.push(event),
      onIssue: (issue) => issues.push(issue),
    },
  }
}

/** 把一条流的字节**一次性**读完，返回事件名序列（差分测试用） */
async function eventNamesOf(response) {
  const sink = collector()
  const result = await readChatEventStream(response, sink.handlers)
  return { names: sink.events.map((event) => event.name), result, events: sink.events }
}

// ───────────────────────────── 被测模块（**直接 import 源码**） ─────────────────────────────

const { SseFrameParser, parseSseFrame, parseSseText } = await import('../src/features/chat/sseParser.ts')
const { readChatEventStream } = await import('../src/features/chat/chatStream.ts')
const { beginRound, isSettled, reduceRound, roundToViews } = await import(
  '../src/features/chat/roundReducer.ts'
)
const { isAssistantEmpty, messageToView, messagesToViews, openingView } = await import(
  '../src/features/chat/messageModel.ts'
)
const { useChatStreamStore } = await import('../src/stores/chatStream.ts')
const { SSE_EVENT_NAMES } = await import('@doubulea/shared')
const { ApiError, openEventStream, setUnauthorizedHandler } = await import('../src/api/client.ts')
const { flattenMessagePages, streamChat } = await import('../src/api/conversations.ts')
// P0-1-33：输入区状态机 / 停止时序 / 断线对齐与文案（四个新的**零依赖纯逻辑**文件）
const { composeState: composeStateRaw, isSubmitKey, createSendGate } = await import(
  '../src/features/chat/composerState.ts'
)
/**
 * 用例夹具：把 `elsewhere`（**P0-1-34** 新增的第六个输入）默认成 `false`。
 *
 * ⚠️ 这个默认值**只存在于本档**，刻意**不**放进 `composerState.ts`（生产侧要求每个调用点显式传）
 * —— 否则"忘了传"会静默等于"没有别的会话在生成"，而那正是新闸门失效的方式。
 * 本组只有 H9/H10 关心它，其余用例写满六个字段只会让"这条在验什么"变模糊。
 */
const composeState = (patch) => composeStateRaw({ elsewhere: false, ...patch })
const { createStopController, waitForRoundSettled, STOP_SETTLE_TIMEOUT_MS } = await import(
  '../src/features/chat/stopController.ts'
)
const { chatErrorTitle, chatErrorDescription, shouldToastChatError } = await import(
  '../src/features/chat/streamErrors.ts'
)
const { countAssistantMessages, decideAlign, shouldDropStreamVersion } = await import(
  '../src/features/chat/alignHistory.ts'
)
// P0-1-34：会话侧栏的**零依赖纯逻辑**（分组 / 相对时间 / 状态灯 / 改名与删除判据）
const {
  conversationItemView,
  describeConversationTime,
  groupConversationViews,
  newConversationAction,
  normalizeTopicDraft,
} = await import('../src/features/chat/conversationList.ts')
const { agentConversationsQueryKey, agentConversationsListQueryKey, CONVERSATIONS_PAGE_LIMIT_MAX } =
  await import('../src/api/conversations.ts')
const { CONVERSATION_TOPIC_MAX_CHARS, listConversationsQuerySchema, renameConversationBodySchema } =
  await import('@doubulea/shared')

// ───────────────────────────── 共用样本 ─────────────────────────────

/**
 * 十个事件各一份**合法**样本。
 *
 * 它同时是"事件全集"的自检点：B 组会遍历 `SSE_EVENT_NAMES` 断言样本齐全 ⇒
 * 将来 `shared/src/sse.ts` 加了事件而这里忘了补样本，**本档立刻红**（而不是悄悄漏验一条映射）。
 */
const SAMPLE_PAYLOAD_BY_EVENT = {
  delta: { text: '增量' },
  thinking: { text: '思考' },
  tool_call: {
    callId: 'call-1',
    toolName: 'read_file',
    serverName: 'filesystem',
    kind: 'MCP',
    status: 'RUNNING',
    inputSummary: '/etc/hosts',
  },
  // ⚠️ P0-2-11 起 `confirm` 载荷多了 `source` / `expiresAt`（倒计时只读服务端绝对时刻）——
  //    样本必须与 `shared#sseConfirmPayloadSchema` 同步，否则 B1（事件全集能解析）会红。
  confirm: {
    confirmId: 'confirm-1',
    source: 'PLATFORM',
    toolName: 'run_shell',
    inputSummary: 'rm -rf build',
    expiresAt: '2026-09-23T00:02:00.000Z',
  },
  citations: { items: [{ docName: '手册.pdf', snippet: '片段原文', score: 0.87 }] },
  artifact: { artifactId: 'art-1', fileName: '报告.md', size: 2048, mime: 'text/markdown' },
  queued: { position: 2 },
  ping: { ts: '2026-09-23T00:00:00.000Z' },
  done: { messageId: 'msg-1', finishReason: 'COMPLETE', usage: { tokensIn: 10, tokensOut: 20 } },
  error: { code: 'CONFLICT', message: '该会话正在生成中' },
}

const eventOf = (name, payload = SAMPLE_PAYLOAD_BY_EVENT[name]) => ({ name, data: payload })

const STARTED_AT = '2026-09-23T10:00:00.000Z'

// ═════════════════════════════ A 组：字节 → 帧（SseFrameParser）═════════════════════════

groupStart(
  'A',
  '帧切分边界（SseFrameParser）',
  '六种边界全是"错了不报错、只少一点内容"，手点浏览器基本碰不到',
)

await it('A1 一帧的 `event:` 行与 `data:` 行分属两个 chunk ⇒ 只有一个完整帧', () => {
  const parser = new SseFrameParser()
  assertEqual(parser.push('event: del').length, 0, '首段不该成帧')
  assertEqual(parser.push('ta\ndata: ').length, 0, '次段不该成帧')
  const frames = parser.push('{"text":"a"}\n\n')
  assertEqual(frames.length, 1, '末段应成 1 帧')
  assertEqual(frames[0].event, 'delta', '事件名')
  assertEqual(frames[0].data, '{"text":"a"}', 'payload 原文')
})

await it('A2 帧分隔符（空行）横跨两个 chunk ⇒ 第二次 push 才成帧', () => {
  const parser = new SseFrameParser()
  assertEqual(parser.push('event: delta\ndata: {"text":"a"}\n').length, 0, '只见到一个 \\n 时不成帧')
  const frames = parser.push('\n')
  assertEqual(frames.length, 1, '补齐空行后成 1 帧')
})

await it('A3 一个 chunk 里有多帧 ⇒ 全部产出且顺序不变', () => {
  const parser = new SseFrameParser()
  const frames = parser.push(sseFrame('delta', { text: 'a' }) + sseFrame('ping', { ts: 'x' }))
  assertEqual(frames.length, 2, '帧数')
  assertEqual(frames.map((frame) => frame.event).join(','), 'delta,ping', '顺序')
})

await it('A4 注释行（`: stall`）按规范忽略，不产出事件', () => {
  const parser = new SseFrameParser()
  const frames = parser.push(': stall\n\nevent: delta\ndata: {"text":"a"}\n\n')
  assertEqual(frames.length, 1, '只有 1 帧（注释帧不产出）')
  assertEqual(frames[0].event, 'delta', '产出的是 delta')
})

await it('A5 多行 `data:` 按规范用 \\n 连接（拼出来仍是合法 JSON）', () => {
  const parser = new SseFrameParser()
  const frames = parser.push('event: delta\ndata: {"text":\ndata: "a"}\n\n')
  assertEqual(frames.length, 1, '帧数')
  assertEqual(frames[0].data, '{"text":\n"a"}', '两行 data 已用换行连接')
  const outcome = parseSseFrame(frames[0])
  assertEqual(outcome.kind, 'event', '拼接结果应能被解析')
  assertEqual(outcome.event.data.text, 'a', 'payload 内容')
})

await it('A6 CRLF 行尾（有的网关会改写）⇒ 尾部 \\r 被剥掉', () => {
  const parser = new SseFrameParser()
  const frames = parser.push('event: delta\r\ndata: {"text":"a"}\r\n\r\n')
  assertEqual(frames.length, 1, '帧数')
  assertEqual(frames[0].event, 'delta', '事件名（`delta\\r` 会让事件名认不出来）')
  assertEqual(frames[0].data, '{"text":"a"}', 'payload 原文')
})

await it('A7 流被截断时：完整帧照常给，半帧只进 pending（不当事件）', () => {
  const parser = new SseFrameParser()
  assertEqual(
    parser.push(sseFrame('delta', { text: 'a' }) + 'event: delta\ndata: {"text":"ab').length,
    1,
    '完整帧照常产出',
  )
  assertEqual(parser.flush().length, 0, 'flush 不把半帧当帧')
  assertEqual(parser.pending, 'event: delta\ndata: {"text":"ab', '半帧原文可从 pending 观测到')

  const clean = new SseFrameParser()
  clean.push(sseFrame('done', { messageId: null, finishReason: 'STOPPED', usage: null }))
  assertEqual(clean.flush().length, 0, '没有残留时 flush 返回空')
  assertEqual(clean.pending, '', '没有残留时 pending 为空串')
})

await it('A8 只有 `event:` 没有 `data:` 的帧不产生事件', () => {
  assertEqual(parseSseText('event: ping\n\n').length, 0, '无 data 的帧被丢掉')
  assertEqual(new SseFrameParser().push('event: ping\n\n').length, 0, '在成帧处就被丢掉')
})

// ═════════════════════════════ B 组：帧 → 语义（parseSseFrame）═════════════════════════

groupStart('B', '帧 → 语义（parseSseFrame）', '四种结果都要能被调用方看见：event / unknown / invalid / empty')

await it('B1 事件全集逐个能解析（样本齐全 ⇒ 将来加事件忘了补样本会红）', () => {
  for (const name of SSE_EVENT_NAMES) {
    const payload = SAMPLE_PAYLOAD_BY_EVENT[name]
    assert(payload !== undefined, `样本缺失：${name}（事件全集加了新事件，本档必须补样本）`)
    const outcome = parseSseFrame({ event: name, data: JSON.stringify(payload) })
    assertEqual(outcome.kind, 'event', `${name} 应被识别为合法事件`)
    assertEqual(outcome.event.name, name, `${name} 事件名往返`)
  }
  assertEqual(
    Object.keys(SAMPLE_PAYLOAD_BY_EVENT).length,
    SSE_EVENT_NAMES.length,
    '样本数与事件全集一致',
  )
})

await it('B2 不认识的事件名 ⇒ unknown（向前兼容；不是 invalid）', () => {
  const outcome = parseSseFrame({ event: 'future_event', data: '{"whatever":1}' })
  assertEqual(outcome.kind, 'unknown', '归类')
  assertEqual(outcome.name, 'future_event', '事件名原样带出')
  assertEqual(outcome.data, '{"whatever":1}', '原文带出（便于排查）')
})

await it('B3 合法事件名 + 非法 JSON ⇒ invalid（不静默吞掉）', () => {
  const outcome = parseSseFrame({ event: 'delta', data: '{oops' })
  assertEqual(outcome.kind, 'invalid', '归类')
  assertEqual(outcome.name, 'delta', '事件名')
  assertIncludes(outcome.detail, '不是合法 JSON', 'detail 说明')
})

await it('B4 合法事件名 + 形状不符 ⇒ invalid 且 detail 指出字段路径', () => {
  const outcome = parseSseFrame({ event: 'delta', data: '{"text":123}' })
  assertEqual(outcome.kind, 'invalid', '归类')
  assertIncludes(outcome.detail, 'text', 'detail 指出出错字段')
})

await it('B5 `error.code` 必须是错误码（自由字符串 ⇒ invalid）', () => {
  const legit = parseSseFrame({ event: 'error', data: JSON.stringify({ code: 'BUSY', message: '忙' }) })
  assertEqual(legit.kind, 'event', `合法错误码应通过（${ERROR_CODES.length} 个之一）`)
  const bogus = parseSseFrame({
    event: 'error',
    data: JSON.stringify({ code: 'SOMETHING_ELSE', message: '忙' }),
  })
  assertEqual(bogus.kind, 'invalid', '自由字符串应被拒（前端文案映射层依赖它的取值域）')
})

await it('B6 没有 data 的帧 ⇒ empty（判别联合的每个分支都真的可达）', () => {
  assertEqual(parseSseFrame({ event: 'ping', data: '' }).kind, 'empty', 'empty 分支可达')
})

// ═════════════════════════════ C 组：字节 → 事件（readChatEventStream）═════════════════════════

groupStart(
  'C',
  '字节 → 事件（readChatEventStream + 真 Response）',
  '解码必须 `{ stream: true }`：否则中文会在 chunk 边界变成替换字符',
)

await it('C1 一条完整的流：事件顺序、terminated、events 计数', async () => {
  const text =
    sseFrame('delta', { text: '你' }) +
    sseFrame('ping', { ts: 'x' }) +
    sseFrame('citations', { items: [{ docName: 'd', snippet: 's', score: 0.5 }] }) +
    sseFrame('done', { messageId: 'm-1', finishReason: 'COMPLETE', usage: null })
  const { names, result } = await eventNamesOf(responseOfChunks([bytesOf(text)]))
  assertEqual(names.join(','), 'delta,ping,citations,done', '事件顺序')
  assertEqual(result.terminated, true, '收到过终结帧')
  assertEqual(result.events, 4, '合法事件数（含 ping）')
  assertEqual(result.pending, '', '没有残留半帧')
})

await it('C2 切点扫过每一个字节位置 ⇒ 结果恒定（多字节字符被切开也不出替换字符）', async () => {
  const text = sseFrame('delta', { text: '你好，世界 🌏' }) + sseFrame('done', { messageId: null, finishReason: 'COMPLETE', usage: null })
  const bytes = bytesOf(text)
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const { names, events } = await eventNamesOf(responseOfSplits(text, [cut]))
    assertEqual(names.join(','), 'delta,done', `切点 ${cut}：事件序列`)
    const delta = events[0]
    assertEqual(delta.data.text, '你好，世界 🌏', `切点 ${cut}：正文（UTF-8 边界被切开）`)
    assert(!delta.data.text.includes('\uFFFD'), `切点 ${cut}：出现替换字符（说明漏了 { stream: true }）`)
  }
})

await it('C3 逐字节喂入 ⇒ 与一次性喂入的结果逐字相同（差分）', async () => {
  const text =
    sseFrame('thinking', { text: '先想' }) +
    sseFrame('delta', { text: '再答' }) +
    sseFrame('ping', { ts: 'x' }) +
    sseFrame('done', { messageId: 'm-2', finishReason: 'COMPLETE', usage: { tokensIn: 1, tokensOut: 2 } })
  const bytes = bytesOf(text)
  const oneByOne = await eventNamesOf(responseOfChunks([...bytes].map((byte) => Uint8Array.of(byte))))
  const atOnce = await eventNamesOf(responseOfChunks([bytes]))
  assertDeepEqual(oneByOne.events, atOnce.events, '逐字节 vs 一次性')
  assertEqual(oneByOne.result.events, 4, '逐字节喂入的事件数')
})

await it('C4 流被截断（没收到 done/error）⇒ terminated:false 且 pending 非空', async () => {
  const half = sseFrame('delta', { text: '半句' }) + 'event: delta\ndata: {"text":"没写完'
  const truncated = await eventNamesOf(responseOfChunks([bytesOf(half)]))
  assertEqual(truncated.result.terminated, false, '没有终结帧就不是正常收口')
  assert(truncated.result.pending !== '', '半帧应能从 pending 观测到')
  assertEqual(truncated.result.events, 1, '完整的那一帧照常产出')

  // 只有终结帧才算收口 —— 即使流里有 delta，丢了 done 也是断线（P0-1-33 的断线黄条靠这个判据）
  const noDone = await eventNamesOf(responseOfChunks([bytesOf(sseFrame('delta', { text: '有内容' }))]))
  assertEqual(noDone.result.terminated, false, '有内容但没有 done ⇒ 仍算没收口')
})

await it('C5 响应没有 body / 流里一个字节都没有 ⇒ 空结果，不抛', async () => {
  const noBody = await eventNamesOf(new Response(null, { status: 200 }))
  assertDeepEqual(noBody.result, { terminated: false, pending: '', events: 0 }, 'body 为 null')
  const empty = await eventNamesOf(responseOfChunks([]))
  assertDeepEqual(empty.result, { terminated: false, pending: '', events: 0 }, '空流')
})

await it('C6 畸形帧只报 issue、不打断整条流', async () => {
  const sink = collector()
  const result = await readChatEventStream(
    responseOfChunks([
      bytesOf(
        'event: delta\ndata: {oops\n\n' +
          'event: future_event\ndata: {"x":1}\n\n' +
          sseFrame('delta', { text: '好' }) +
          sseFrame('done', { messageId: 'm-3', finishReason: 'COMPLETE', usage: null }),
      ),
    ]),
    sink.handlers,
  )
  assertEqual(sink.events.length, 2, '两条合法事件仍然到达')
  assertEqual(result.terminated, true, '仍然收口（畸形帧不该把流变成断线）')
  assertEqual(sink.issues.length, 2, '两条 issue 都被报出')
  assertEqual(sink.issues.map((issue) => issue.kind).join(','), 'invalid,unknown', 'issue 分类')
})

// ═════════════════════════════ D 组：事件 → UI 状态（roundReducer）═════════════════════════

groupStart('D', '事件 → UI 状态（roundReducer）', '`03` §五 的映射表逐行；坑预判：ping 误当数据渲染 ⇒ 消息流里插空气泡')

await it('D1 `ping` 返回**同一个引用** ⇒ 一次重渲染都不会发生', () => {
  const round = beginRound('你好', STARTED_AT)
  assertSameRef(reduceRound(round, eventOf('ping')), round, 'ping 归约')
  // 在流中间也要成立（这时 round 已经有多层嵌套对象，"内容相同的新对象"是很容易写出来的错法）
  const mid = reduceRound(reduceRound(round, eventOf('delta', { text: '答' })), eventOf('thinking', { text: '想' }))
  assertSameRef(reduceRound(mid, eventOf('ping', { ts: 'later' })), mid, '流中间的心跳归约')
  assertDeepEqual(reduceRound(mid, eventOf('ping')), mid, '状态不变')
})

await it('D2 `delta` 逐字追加（每一步都是新对象）', () => {
  let round = beginRound('你好', STARTED_AT)
  for (const chunk of ['你', '好', '，世界']) {
    const next = reduceRound(round, eventOf('delta', { text: chunk }))
    assert(!Object.is(next, round), '内容变了就该是新对象（否则界面不会更新）')
    round = next
  }
  assertEqual(round.assistant.text, '你好，世界', '拼接结果')
  assertEqual(round.status, 'streaming', '仍在流中')
})

await it('D3 `thinking` 追加到独立字段（与正文互不污染）', () => {
  let round = beginRound('问题', STARTED_AT)
  round = reduceRound(round, eventOf('thinking', { text: '先' }))
  round = reduceRound(round, eventOf('thinking', { text: '想' }))
  round = reduceRound(round, eventOf('delta', { text: '答案' }))
  assertEqual(round.assistant.thinking, '先想', '思考段')
  assertEqual(round.assistant.text, '答案', '正文段')
})

await it('D4 `tool_call` 按 callId upsert，且 `RUNNING` 那一帧的缺省 output 不覆盖已有值', () => {
  let round = beginRound('跑个工具', STARTED_AT)
  round = reduceRound(
    round,
    eventOf('tool_call', {
      callId: 'call-a',
      toolName: 'read_file',
      serverName: 'fs',
      kind: 'MCP',
      status: 'RUNNING',
      inputSummary: '/tmp/a',
    }),
  )
  assertEqual(round.assistant.tools.length, 1, '首帧新建一条')

  round = reduceRound(
    round,
    eventOf('tool_call', {
      callId: 'call-a',
      toolName: 'read_file',
      serverName: 'fs',
      kind: 'MCP',
      status: 'SUCCESS',
      inputSummary: '/tmp/a',
      output: '内容',
    }),
  )
  assertEqual(round.assistant.tools.length, 1, '同 callId 是状态机流转，不是新增一条')
  assertEqual(round.assistant.tools[0].status, 'SUCCESS', '状态已流转')
  assertEqual(round.assistant.tools[0].output, '内容', '结果已落上')

  // 同 callId 再来一帧**不带 output**（schema 允许）⇒ 不能把已有的 output 抹成 undefined
  round = reduceRound(
    round,
    eventOf('tool_call', {
      callId: 'call-a',
      toolName: 'read_file',
      serverName: 'fs',
      kind: 'MCP',
      status: 'SUCCESS',
      inputSummary: '/tmp/a',
    }),
  )
  assertEqual(round.assistant.tools[0].output, '内容', '缺省 output 时保留旧值')

  round = reduceRound(
    round,
    eventOf('tool_call', {
      callId: 'call-b',
      toolName: 'run_shell',
      serverName: '',
      kind: 'SANDBOX',
      status: 'RUNNING',
      inputSummary: 'ls',
    }),
  )
  assertEqual(round.assistant.tools.length, 2, '新 callId 追加')
  assertEqual(round.assistant.tools.map((tool) => tool.callId).join(','), 'call-a,call-b', '追加顺序')
})

await it('D5 `citations` 空数组收敛成 null（不渲染空引用卡），非空则原样落上', () => {
  let round = beginRound('问', STARTED_AT)
  assertEqual(round.assistant.citations, null, '初始为 null（≠ 空数组）')
  round = reduceRound(round, eventOf('citations', { items: [] }))
  assertEqual(round.assistant.citations, null, '空数组 ⇒ null')
  const items = [{ docName: '手册.pdf', snippet: '片段', score: 0.87 }]
  round = reduceRound(round, eventOf('citations', { items }))
  assertDeepEqual(round.assistant.citations, items, '引用项原样落上')
})

await it('D6 `artifact` 按 artifactId 去重（重复推送不重复追加）', () => {
  const one = { artifactId: 'art-1', fileName: 'a.md', size: 1, mime: 'text/markdown' }
  let round = beginRound('产出文件', STARTED_AT)
  round = reduceRound(round, eventOf('artifact', one))
  round = reduceRound(round, eventOf('artifact', one))
  assertEqual(round.assistant.artifacts.length, 1, '同 id 只留一条（否则"产物 · N"会说谎）')
  round = reduceRound(round, eventOf('artifact', { ...one, artifactId: 'art-2' }))
  assertEqual(round.assistant.artifacts.length, 2, '不同 id 追加')
})

await it('D7 `confirm` / `queued` 落到各自字段（P0 阶段无产生路径，形状先就位）', () => {
  let round = beginRound('问', STARTED_AT)
  round = reduceRound(round, eventOf('confirm'))
  assertDeepEqual(round.confirm, SAMPLE_PAYLOAD_BY_EVENT.confirm, '确认卡载荷')
  round = reduceRound(round, eventOf('queued', { position: 3 }))
  assertEqual(round.queuedPosition, 3, '排队位次')
})

await it('D8 `done{COMPLETE}` ⇒ 收口、持久化判据、usage 落上', () => {
  let round = beginRound('问', STARTED_AT)
  round = reduceRound(round, eventOf('delta', { text: '答' }))
  assertEqual(round.persisted, null, '收口前 persisted 是 null（不是 false）')
  round = reduceRound(round, eventOf('done', { messageId: 'msg-9', finishReason: 'COMPLETE', usage: { tokensIn: 10, tokensOut: 20 } }))
  assertEqual(isSettled(round), true, '已收口')
  assertEqual(round.status, 'complete', '状态')
  assertEqual(round.persisted, true, '落库了')
  assertEqual(round.assistantMessageId, 'msg-9', '库里那条助手消息的 id')
  assertEqual(round.finishReason, 'COMPLETE', '收尾原因')
  assertDeepEqual(round.usage, { tokensIn: 10, tokensOut: 20 }, 'usage')
  assertEqual(round.error, null, '没有错误')
})

await it('D9 `done{STOPPED, messageId:null}` ⇒ stopped + persisted:false（如实标注，不编假 id）', () => {
  let round = beginRound('问', STARTED_AT)
  round = reduceRound(round, eventOf('done', { messageId: null, finishReason: 'STOPPED', usage: null }))
  assertEqual(round.status, 'stopped', '状态')
  assertEqual(round.persisted, false, '没有产生可持久化的消息')
  assertEqual(round.assistantMessageId, null, 'id 为 null')
  assertEqual(round.usage, null, '没有上游调用')
})

await it('D10 `done{finishReason:ERROR}` ⇒ 按异常收口（不留一个假的"完成"）', () => {
  const round = reduceRound(
    beginRound('问', STARTED_AT),
    eventOf('done', { messageId: 'msg-10', finishReason: 'ERROR', usage: null }),
  )
  assertEqual(round.status, 'error', '状态')
  assertEqual(round.error.code, 'INTERNAL', '错误码')
})

await it('D11 `error` 事件是终结事件（之后的内容帧一律忽略，状态不变）', () => {
  let round = beginRound('问', STARTED_AT)
  round = reduceRound(round, eventOf('delta', { text: '半' }))
  round = reduceRound(round, eventOf('error', { code: 'CONFLICT', message: '该会话正在生成中' }))
  assertEqual(round.status, 'error', '状态')
  assertDeepEqual(round.error, { code: 'CONFLICT', message: '该会话正在生成中' }, '错误载荷')
  assertEqual(isSettled(round), true, '已收口')

  const settled = round
  assertSameRef(reduceRound(settled, eventOf('delta', { text: '迟到' })), settled, '收口后的 delta')
  assertSameRef(reduceRound(settled, eventOf('done', { messageId: 'x', finishReason: 'COMPLETE', usage: null })), settled, '第二个终帧')
  assertEqual(settled.assistant.text, '半', '已经渲染出来的内容不被改花')
})

await it('D12 `roundToViews` 产出"用户 + 助手"两条，顺序与角色正确', () => {
  let round = beginRound('  问个问题  ', STARTED_AT)
  round = reduceRound(round, eventOf('delta', { text: '答' }))
  round = reduceRound(round, eventOf('done', { messageId: 'msg-11', finishReason: 'COMPLETE', usage: null }))
  const views = roundToViews(round)
  assertEqual(views.length, 2, '两条')
  assertEqual(views[0].role, 'USER', '先用户')
  assertEqual(views[1].role, 'ASSISTANT', '后助手')
  assertEqual(views[0].text, '  问个问题  ', '用户正文原样（trim 由调用方在做发送前处理）')
  assertEqual(views[1].text, '答', '助手正文')
  assertEqual(views[1].status, 'complete', '助手状态')
  assertEqual(views[1].finishReason, 'COMPLETE', '收尾原因带出')
  assertEqual(views[1].persisted, true, '持久化判据带出')
})

// ═════════════════════════════ E 组：历史 vs 流式（单一渲染路径）═════════════════════════

groupStart(
  'E',
  '历史 vs 流式（messageModel）',
  '验收原文 ④：刷新后历史用**同一套组件**渲染、形态一致 —— 这里验"两侧归一出的形状逐字相同"',
)

await it('E1 开场白：空白 ⇒ null（不显示空气泡）；有值 ⇒ plain:true 走纯文本', () => {
  assertEqual(openingView(null), null, 'null')
  assertEqual(openingView(undefined), null, 'undefined')
  assertEqual(openingView('   '), null, '纯空白')
  const view = openingView('# 我可以帮你查手册\n* 提问即可')
  assertEqual(view.plain, true, '纯文本渲染（不解析 Markdown）')
  assertEqual(view.role, 'ASSISTANT', '角色')
  assertEqual(view.key, 'opening', 'key')
  assertEqual(view.text, '# 我可以帮你查手册\n* 提问即可', '原文一字不改')
})

await it('E2 历史消息：按 text / thinking / citations 三段取值，坏的一段不炸也不猜', () => {
  const good = messageToView({
    id: 'm-100',
    conversationId: 'c-1',
    role: 'ASSISTANT',
    content: {
      text: '答案',
      thinking: '想了想',
      citations: [{ docName: '手册.pdf', snippet: '片段', score: 0.9 }],
      // 未定型的段（P0-2 / P0-3 才写）刻意不读；键序由乱序给出，证明读取不依赖键序
      tool_calls: [{ whatever: true }],
    },
    createdAt: '2026-09-23T09:00:00.000Z',
  })
  assertEqual(good.key, 'm-100', 'key 用真实消息 id')
  assertEqual(good.text, '答案', '正文')
  assertEqual(good.thinking, '想了想', '思考段')
  assertEqual(good.citations.length, 1, '引用段')
  assertEqual(good.status, 'complete', '历史消息恒为 complete')
  assertDeepEqual(good.tools, [], '工具卡历史还原属 P0-2')
  assertDeepEqual(good.artifacts, [], '产物卡历史还原属 P0-3')

  // content 不是对象（老数据 / 手工改动）⇒ 空内容，不抛
  const broken = messageToView({
    id: 'm-101',
    conversationId: 'c-1',
    role: 'USER',
    content: '这不是 jsonb 对象',
    createdAt: '2026-09-23T09:01:00.000Z',
  })
  assertEqual(broken.text, '', '取不到就空着')
  // 字段类型不对 ⇒ 不读它（而不是把数字渲染成正文）
  const typed = messageToView({
    id: 'm-102',
    conversationId: 'c-1',
    role: 'ASSISTANT',
    content: { text: 42, citations: [{ docName: 1 }, { docName: 'ok', snippet: 's', score: 1 }] },
    createdAt: '2026-09-23T09:02:00.000Z',
  })
  assertEqual(typed.text, '', '类型不符的 text 不读')
  assertEqual(typed.citations.length, 1, '引用逐项过 schema：坏项剔除、好项保留')
  // 引用全坏 ⇒ 当作"没有引用"，而不是渲染一张空引用卡
  assertEqual(
    messageToView({
      id: 'm-103',
      conversationId: 'c-1',
      role: 'ASSISTANT',
      content: { text: 't', citations: [{ docName: 1 }] },
      createdAt: '2026-09-23T09:03:00.000Z',
    }).citations,
    null,
    '全坏 ⇒ null',
  )
})

await it('E3 同一轮对话：流式渲染的形状 == 刷新后从库里读回来的形状（字段逐字相等）', () => {
  let round = beginRound('手册里怎么配代理？', STARTED_AT)
  round = reduceRound(round, eventOf('thinking', { text: '先检索' }))
  round = reduceRound(round, eventOf('citations', { items: [{ docName: '手册.pdf', snippet: '片段', score: 0.87 }] }))
  round = reduceRound(round, eventOf('delta', { text: '见第 3 节。' }))
  round = reduceRound(round, eventOf('done', { messageId: 'msg-200', finishReason: 'COMPLETE', usage: { tokensIn: 5, tokensOut: 6 } }))

  const streamed = roundToViews(round)[1]
  // 后端 `done` 时按 `messageContentSchema` 落库：`text` + 有则 `thinking` + 有则 `citations`
  const persisted = messageToView({
    id: 'msg-200',
    conversationId: 'c-9',
    role: 'ASSISTANT',
    content: {
      text: streamed.text,
      thinking: streamed.thinking,
      citations: streamed.citations ?? undefined,
    },
    createdAt: '2026-09-23T10:00:03.000Z',
  })

  // **归一的三个字段必须逐字相等** —— 它们决定"渲染出哪些块、每块写什么"。
  for (const field of ['role', 'text', 'thinking', 'citations', 'tools', 'artifacts']) {
    assertDeepEqual(persisted[field], streamed[field], `同名字段 ${field}`)
  }
  // 刻意不同的字段（列出来是为了让"下次有人想统一它们"先想一想）：
  //   key / createdAt ⇒ 流的版本在落库前**还不存在**（没有 id 与时间）
  //   status / finishReason / usage / persisted ⇒ 只属于"刚发生的那一轮"的元信息，历史不存
  assertEqual(persisted.key, 'msg-200', '历史的 key 是真实 id')
  assertEqual(streamed.key, 'stream:assistant', '流式的 key 带 stream: 前缀')
})

await it('E4 `isAssistantEmpty`：有引用但没正文**不算空**（P0-1-29 坑 2 的守门断言）', () => {
  const citationOnly = { ...roundToViews(beginRound('问', STARTED_AT))[1] }
  citationOnly.citations = [{ docName: '手册.pdf', snippet: '片段', score: 0.5 }]
  assertEqual(isAssistantEmpty(citationOnly), false, '只落了引用卡的那一轮必须把卡片画出来')

  const empty = roundToViews(beginRound('问', STARTED_AT))[1]
  assertEqual(isAssistantEmpty(empty), true, '什么都还没有')
  const withTool = { ...empty, tools: [{ callId: 'c', toolName: 't', serverName: '', kind: 'MCP', status: 'RUNNING', inputSummary: '' }] }
  assertEqual(isAssistantEmpty(withTool), false, '有工具卡也不算空')
})

await it('E5 历史列表 → 视图列表：保持服务端给的时间正序，且不带 extra 字段', () => {
  const items = [
    { id: 'm-1', conversationId: 'c', role: 'USER', content: { text: '问' }, createdAt: '2026-09-23T09:00:00.000Z' },
    { id: 'm-2', conversationId: 'c', role: 'ASSISTANT', content: { text: '答' }, createdAt: '2026-09-23T09:00:01.000Z' },
  ]
  const views = messagesToViews(items)
  assertEqual(views.map((view) => view.key).join(','), 'm-1,m-2', '顺序即入参顺序')
  assertEqual(views[0].role, 'USER', '角色')
  assertEqual(views[1].role, 'ASSISTANT', '角色')
})

// ═════════════════════════════ F 组：api 层（信封 vs 事件流）═════════════════════════

groupStart(
  'F',
  'api 层：两类失败、两个出口',
  '判据是 HTTP 状态 + Content-Type，**不是** `response.ok` —— 200 也可能是失败的收尾',
)

/** 用桩替掉 `fetch`（本档唯一"假"的东西；它是浏览器给的能力，不是本仓代码） */
const realFetch = globalThis.fetch
let lastFetchCall = null

function stubFetch(handler) {
  lastFetchCall = null
  globalThis.fetch = async (url, init) => {
    lastFetchCall = { url, init }
    return handler(url, init)
  }
}

await it('F1 `200 + text/event-stream` ⇒ 返回 Response，且请求是 POST + 凭据 + JSON 头', async () => {
  stubFetch(() =>
    responseOfChunks([
      bytesOf(
        sseFrame('delta', { text: '你好' }) +
          sseFrame('done', { messageId: 'msg-1', finishReason: 'COMPLETE', usage: null }),
      ),
    ]),
  )
  const sink = collector()
  const result = await streamChat('conv-1', '你好', sink.handlers)
  assertEqual(result.terminated, true, '读完了')
  assertEqual(sink.events.length, 2, '两个事件')

  // 「为什么不用原生 EventSource」的三条理由（`03` §一）在请求上取证
  assertEqual(lastFetchCall.init.method, 'POST', '必须是 POST（EventSource 只能 GET）')
  assertEqual(lastFetchCall.init.credentials, 'include', '必须带凭据 Cookie（会话是 HttpOnly Cookie）')
  assertEqual(lastFetchCall.init.headers['content-type'], 'application/json', '必须能带自定义头')
  assertEqual(lastFetchCall.init.body, JSON.stringify({ content: '你好' }), '请求体')
  assertIncludes(lastFetchCall.url, '/api/conversations/conv-1/chat', '请求路径')
})

await it('F2 前置失败是**JSON 信封** ⇒ 抛 ApiError（与普通接口同一形态）并触发 401 收口', async () => {
  let unauthorizedCount = 0
  setUnauthorizedHandler(() => {
    unauthorizedCount += 1
  })
  stubFetch(
    () =>
      new Response(JSON.stringify(fail('UNAUTHORIZED', '登录已失效，请重新登录')), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  )
  const error = await assertRejects(() => streamChat('conv-1', '你好', collector().handlers), '401')
  assert(error instanceof ApiError, '应抛 ApiError')
  assertEqual(error.code, 'UNAUTHORIZED', '错误码')
  assertEqual(error.status, 401, 'HTTP 状态')
  assertEqual(error.message, '登录已失效，请重新登录', '文案取服务端 msg（不二次拼装）')
  assertEqual(unauthorizedCount, 1, '401 收口回调被触发一次')
  setUnauthorizedHandler(undefined)

  // 404（不是我的会话）走同一条路：信封，不是流
  stubFetch(
    () =>
      new Response(JSON.stringify(fail('NOT_FOUND', '会话不存在')), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
  )
  const notFound = await assertRejects(() => streamChat('conv-x', '你好', collector().handlers), '404')
  assertEqual(notFound.code, 'NOT_FOUND', '404 也是信封')
})

await it('F3 并发冲突是 **200 + 流内 error{CONFLICT}** ⇒ 绝不被当成信封', async () => {
  stubFetch(() =>
    responseOfChunks([
      bytesOf(sseFrame('error', { code: 'CONFLICT', message: '该会话正在生成中' })),
    ]),
  )
  const sink = collector()
  const result = await streamChat('conv-1', '你好', sink.handlers)
  assertEqual(result.terminated, true, '以 error 收口也算"收到终结帧"')
  assertEqual(sink.events.length, 1, '一个事件')
  assertEqual(sink.events[0].name, 'error', '是流内 error 而不是抛出')
  assertEqual(sink.events[0].data.code, 'CONFLICT', '错误码')
})

await it('F4 200 + JSON 信封（畸形）⇒ 明确报"期望事件流"，而不是把 JSON 当流去读', async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify(ok({ unexpected: true })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  const error = await assertRejects(() => openEventStream('/api/conversations/c/chat'), '200 + JSON')
  assertIncludes(error.message, '期望事件流', '文案要说清是哪一种畸形')
})

await it('F5 网关/SPA 兜底回 HTML ⇒ 明确报"不是 JSON 也不是事件流"（P0-1-30 踩过的坑）', async () => {
  stubFetch(
    () =>
      new Response('<!doctype html><html><body>vite spa fallback</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  )
  const error = await assertRejects(() => openEventStream('/api/conversations/c/chat'), 'HTML')
  assertIncludes(error.message, '不是 JSON 也不是事件流', '文案')
  assertEqual(error.code, 'INTERNAL', '错误码')
})

await it('F6 网络层失败 / 被 abort ⇒ 伪错误码 NETWORK（不是信封里的错误码）', async () => {
  stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  const offline = await assertRejects(() => streamChat('conv-1', '你好', collector().handlers), '网络不可达')
  assertEqual(offline.code, 'NETWORK', '伪码')
  assertEqual(offline.status, 0, '没有 HTTP 状态')

  const controller = new AbortController()
  controller.abort()
  const aborted = await assertRejects(
    () => streamChat('conv-1', '你好', collector().handlers, controller.signal),
    '被 abort',
  )
  assertEqual(aborted.code, 'NETWORK', '伪码')
  assertEqual(aborted.message, '请求已取消', 'abort 与"连不上"要能区分')
})

await it('F7 `flattenMessagePages`：页序要 reverse（游标指向更早的一页）', () => {
  const page = (ids) => ({ items: ids.map((id) => ({ id })), nextCursor: null, hasMore: false })
  assertDeepEqual(
    flattenMessagePages({ pages: [page(['c-1', 'c-2']), page(['a-1', 'a-2'])] }).map((item) => item.id),
    ['a-1', 'a-2', 'c-1', 'c-2'],
    'pages[0] 是最新一页 ⇒ 展平后必须是"旧 → 新"（写反的症状只在翻第二页时显形）',
  )
  assertDeepEqual(flattenMessagePages(undefined), [], '还没查到 ⇒ 空列表')
})

// ═════════════════════════════ G 组：store（zustand）═════════════════════════════

groupStart('G', 'store：只剩"把归约结果塞回去"', 'store 里一旦出现事件分支，就有了第二处事件语义')

await it('G1 `begin` 开一轮，`reset` 清空', () => {
  const store = useChatStreamStore
  store.getState().reset()
  assertEqual(store.getState().streamFor, null, '初始无流')
  assertEqual(store.getState().round, null, '初始无归约态')

  store.getState().begin('conv-1', '你好', STARTED_AT)
  assertEqual(store.getState().streamFor, 'conv-1', '流归属（防串台）')
  assertEqual(store.getState().round.userText, '你好', '本轮用户正文')
  assertEqual(store.getState().round.status, 'streaming', '状态')
})

await it('G2 `apply` 串行喂帧 == 手工 `reduceRound` 的结果', () => {
  const store = useChatStreamStore
  store.getState().begin('conv-1', '你好', STARTED_AT)
  const frames = [
    eventOf('thinking', { text: '想' }),
    eventOf('delta', { text: '你' }),
    eventOf('ping'),
    eventOf('delta', { text: '好' }),
    eventOf('done', { messageId: 'msg-1', finishReason: 'COMPLETE', usage: null }),
  ]
  for (const frame of frames) store.getState().apply(frame)

  let expected = beginRound('你好', STARTED_AT)
  for (const frame of frames) expected = reduceRound(expected, frame)

  assertDeepEqual(store.getState().round, expected, 'store 的归约态')
  assertEqual(store.getState().round.assistant.text, '你好', '正文')
})

await it('G3 `ping` 经过 store 后 `round` 引用不变 ⇒ 不触发任何重渲染', () => {
  const store = useChatStreamStore
  store.getState().begin('conv-1', '你好', STARTED_AT)
  store.getState().apply(eventOf('delta', { text: '答' }))
  const before = store.getState().round
  store.getState().apply(eventOf('ping'))
  assertSameRef(store.getState().round, before, '心跳不该改变 state 引用')
})

await it('G4 未开轮时 `apply` 静默忽略（`done` 之后仍可能有尾帧，属正常）', () => {
  const store = useChatStreamStore
  store.getState().reset()
  const before = store.getState()
  store.getState().apply(eventOf('delta', { text: '幽灵帧' }))
  assertSameRef(store.getState(), before, 'state 引用不变')
  assertEqual(store.getState().round, null, '没有被凭空开轮')
})

await it('G5 `fail` 把客户端侧的失败落到同一个出口（消息流内错误卡）', () => {
  const store = useChatStreamStore
  store.getState().begin('conv-1', '你好', STARTED_AT)
  store.getState().apply(eventOf('delta', { text: '半' }))
  store.getState().fail({ code: 'NETWORK', message: '与服务器的连接已断开' })
  assertEqual(store.getState().round.status, 'error', '状态')
  assertDeepEqual(
    store.getState().round.error,
    { code: 'NETWORK', message: '与服务器的连接已断开' },
    '错误载荷',
  )
  assertEqual(store.getState().round.assistant.text, '半', '已经收到的内容保留（不假装没发生过）')
})

// ═════════════════════════════ H 组：输入区状态机（P0-1-33） ═════════════════════════

groupStart(
  'H',
  '输入区状态机（composerState）',
  '`03` §4.1 的九行原文：五处互相制约的东西（可输入 / 可发送 / 主按钮 / 文案 / Enter）收在一个纯函数里',
)

/** 五种状态各造一份输入（`round` 用 `beginRound` 造真值，不手搓半个对象） */
function roundOf(patch = {}) {
  return { ...beginRound('你好', STARTED_AT), ...patch }
}

await it('H1 `idle`：可输入、草稿非空才可发送，主按钮是「发送」', () => {
  const empty = composeState({ round: null, sending: false, stopping: false, draft: '' })
  assertEqual(empty.state, 'idle', '状态')
  assertEqual(empty.canType, true, '可输入')
  assertEqual(empty.canSend, false, '空草稿不可发（避免"点一下发现没反应"）')
  assertEqual(empty.primary.kind, 'send', '主按钮')
  assertEqual(empty.primary.disabled, true, '空草稿时按钮禁用')

  const typed = composeState({ round: null, sending: false, stopping: false, draft: '你好' })
  assertEqual(typed.canSend, true, '有草稿可发')
  assertEqual(typed.primary.disabled, false, '按钮可点')
})

await it('H2 `streaming`：按钮变[停止]、**输入仍可编辑**、发送禁用（`03` §4.1 的原话）', () => {
  const view = composeState({
    round: roundOf({ status: 'streaming' }),
    sending: true,
    stopping: false,
    draft: '下一条',
  })
  assertEqual(view.state, 'streaming', '状态')
  // 三件必须同时成立，缺一条就是一个真实缺陷：
  //   · 输入禁了 ⇒ 违反"streaming 中允许继续输入"
  //   · 发送没禁 ⇒ 用户点两下就拿到 CONFLICT（后端按会话互斥）
  assertEqual(view.canType, true, '边生成边打字是允许的')
  assertEqual(view.canSend, false, '但发送禁用（防并发的必要最小集）')
  assertEqual(view.primary.kind, 'stop', '主按钮变成停止')
  assertEqual(view.primary.action, 'stop', '点它是停止，不是发送')
  assertEqual(view.primary.disabled, false, '停止按钮可点')
  assertEqual(view.locked, false, '输入区没有被锁')
})

await it('H3 `confirm`：锁输入（`canType:false`），且**优先级高于 streaming**', () => {
  const view = composeState({
    // 确认卡是"流挂起等你应答"⇒ 这一轮**仍然**是 streaming，但输入必须锁上
    round: roundOf({
      status: 'streaming',
      confirm: { confirmId: 'c1', toolName: 'run_shell', inputSummary: 'rm -rf build' },
    }),
    sending: true,
    stopping: false,
    draft: '随便打点字',
  })
  assertEqual(view.state, 'confirm', '状态')
  assertEqual(view.locked, true, '锁输入')
  assertEqual(view.canType, false, '不可编辑（`03` §4.1："锁输入显示确认卡"）')
  assertEqual(view.canSend, false, '不可发送')
  assertEqual(view.primary.action, null, '等待确认时没有可点的主动作')
})

await it('H4 `sending`：建会话/建流的空窗**不是 idle**（否则再按一次 Enter 会再建一个会话）', () => {
  // 这一段的真实形态：`round` 还是 null（第一步 `POST /api/conversations` 还没回来）
  const view = composeState({ round: null, sending: true, stopping: false, draft: '' })
  assertEqual(view.state, 'sending', '状态')
  assertEqual(view.canSend, false, '空窗里不可再发')
  assertEqual(view.primary.kind, 'busy', '主按钮是"发送中…"')
  assertEqual(view.primary.label, '发送中…', '文案')
  assertEqual(view.canType, true, '仍可先构思下一条')
})

await it('H5 `stopping`：点过停止 ⇒ 主按钮立刻变"停止中…"且不可再点（顺序即正确性）', () => {
  const view = composeState({
    // ⚠️ 此刻 `round.status` **还是** streaming（服务端还没收口）—— 若判据只看 round，
    //    按钮会停在「停止」，用户会以为没点上而反复点
    round: roundOf({ status: 'streaming' }),
    sending: true,
    stopping: true,
    draft: '',
  })
  assertEqual(view.state, 'stopping', '状态')
  assertEqual(view.primary.disabled, true, '不可重复点')
  assertEqual(view.primary.action, null, '没有可点的动作')
  assertEqual(view.canSend, false, '等待收口期间不能发下一条')
})

await it('H6 六个状态的 `label` 与 `state` 一致、文案两两不同（漏改一个状态看得见）', () => {
  const views = [
    // ⚠️ idle 那一份**要带草稿**：不带草稿时 `canSend` 本来就是 false（H1 已验），
    //    拿它去断言"只有 idle 允许发送"会因为夹具与断言不匹配而假红
    composeState({ round: null, sending: false, stopping: false, draft: '你好' }),
    composeState({ round: null, sending: true, stopping: false, draft: '' }),
    composeState({ round: roundOf({ status: 'streaming' }), sending: true, stopping: false, draft: '' }),
    composeState({ round: roundOf({ status: 'streaming' }), sending: true, stopping: true, draft: '' }),
    composeState({
      round: roundOf({
        status: 'streaming',
        confirm: { confirmId: 'c1', toolName: 't', inputSummary: 's' },
      }),
      sending: true,
      stopping: false,
      draft: '',
    }),
    // 第六个：**别的**会话在生成（P0-1-34）。注意它的 `round` 是 `null` ——
    // 那正是这个状态存在的理由（页面里这一轮不属于当前会话）
    composeState({ round: null, sending: false, stopping: false, draft: '', elsewhere: true }),
  ]
  // 集合语义：先排序再比（`06` §六 第 ⑤ 条）
  assertDeepEqual(
    [...views.map((view) => view.state)].sort(),
    ['confirm', 'elsewhere', 'idle', 'sending', 'stopping', 'streaming'],
    '六个状态都真的可达（少一个就说明某个判据被更早的分支吃掉了）',
  )
  for (const view of views) {
    assertEqual(view.label, view.state, `\`label\` 应等于 \`state\`（${view.state}）`)
  }
  assertEqual(new Set(views.map((v) => v.placeholder)).size, 6, '占位符两两不同')
  assertEqual(new Set(views.map((v) => v.hint)).size, 6, '提示行两两不同')
  // 两条不变量（它们是"防并发"与"锁输入"的最终口径）：
  //   · **只有 idle 能发送** —— 其余五个状态里既有"正在跑"也有"正在等"，都不该放行
  //   · **只有 confirm 锁输入** —— 流式中必须还能打字（`03` §4.1）
  assertEqual(views.filter((v) => v.canSend).length, 1, '只有 idle 允许发送')
  assertEqual(views.filter((v) => v.primary.action === 'send').length, 1, '只有一个可点的发送按钮')
  assertDeepEqual(
    views.filter((v) => !v.canType).map((v) => v.state),
    ['confirm'],
    '只有 confirm 锁输入',
  )
})

await it('H7 `isSubmitKey`：Enter 发送 / Shift+Enter 换行 / **输入法组合中不发送**', () => {
  assertEqual(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false }), true, 'Enter 发送')
  assertEqual(isSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false }), false, 'Shift+Enter 换行')
  // ⚠️ 这一条就是"拼音打到一半按 Enter 选词，结果把半截拼音发出去了"的那个 bug
  assertEqual(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true }), false, '组合中不发送')
  assertEqual(isSubmitKey({ key: 'a', shiftKey: false, isComposing: false }), false, '普通字符不发送')
  assertEqual(isSubmitKey({ key: 'Escape', shiftKey: false, isComposing: false }), false, 'Esc 不发送')
})

await it('H8 `createSendGate`：同标签页重复发送的同步闸门（释放后才能再进入）', () => {
  const gate = createSendGate()
  assertEqual(gate.busy, false, '初始空闲')
  assertEqual(gate.enter(), true, '第一次进入成功')
  assertEqual(gate.enter(), false, '**第二次必须失败**（否则会各建一个会话）')
  assertEqual(gate.busy, true, '占住中')
  gate.leave()
  assertEqual(gate.busy, false, '释放后回到空闲')
  assertEqual(gate.enter(), true, '可再次进入（否则用户只能发一条消息）')
  gate.leave()
})

await it('H9 `elsewhere`（P0-1-34）：别的会话在生成 ⇒ 只能输入、不能发', () => {
  const view = composeState({
    round: null,
    sending: false,
    stopping: false,
    draft: '下一条想说的话',
    elsewhere: true,
  })
  assertEqual(view.state, 'elsewhere', '状态名')
  assertEqual(view.canSend, false, '不许发（前端只有一个轮次槽，发了就会覆盖另一会话的那一轮）')
  assertEqual(view.canType, true, '但**输入不禁**（先构思下一条是安全的，与 streaming 同款口径）')
  assertEqual(view.locked, false, '它不是"锁输入"那一类（锁输入只有 confirm）')
  assertEqual(view.primary.action, null, '没有可点的主动作')
  assertEqual(view.primary.disabled, true, '按钮不可点')
  // 文案要**能照着做**，不能只说"不允许"
  assertIncludes(view.primary.label, '别的会话', '按钮文案指明了原因')
  assertIncludes(view.hint, '停止', '提示行给了出路')
})

await it('H10 `elsewhere` 的优先级排在 `sending` **之后**（顺序即正确性）', () => {
  // 用户按下发送的那一瞬间：这一次的 `sending` 已经为真，而另一个会话的流可能还在跑。
  // 若 `elsewhere` 先赢，主按钮会在刚点完发送后立刻从「发送中…」闪回「别的会话生成中」，
  // 看起来像"点了没反应" —— 这是本组唯一一个"顺序必须写对"的地方
  //
  // ⚠️ 夹具里 `stopping` 必须是 `false`：`stopping` 的优先级**高于** `sending`（全序是
  //    `confirm > stopping > streaming > sending > elsewhere`），把它设成 `true` 会验成
  //    "stopping 胜过 sending"（那是 H5 的事），而这条问的是 `elsewhere` 排不排在 `sending` 后面。
  //    另外 `sending` 与 `stopping` 同真也不是真实形态：前者是"这一轮还没进 store"，后者是
  //    "已点停止、等 done{STOPPED} 收口"，两者互斥。
  const view = composeState({
    round: null,
    sending: true,
    stopping: false,
    draft: '',
    elsewhere: true,
  })
  assertEqual(view.state, 'sending', '`sending` 胜（它比 `elsewhere` 靠前）')
  assertEqual(view.primary.label, '发送中…', '按钮文案')

  // 反过来：只有 `elsewhere` 为真时才轮到它（H9 已验）；`streaming`（本会话在跑）一定优先于它
  const streaming = composeState({
    round: roundOf({ status: 'streaming' }),
    sending: false,
    stopping: false,
    draft: '',
    elsewhere: true,
  })
  assertEqual(streaming.state, 'streaming', '本会话在跑 ⇒ 是 streaming（能点[停止]），不是 elsewhere')
  assertEqual(streaming.primary.action, 'stop', '主按钮仍是停止')
})


// ═════════════════════════════ I 组：停止时序（P0-1-33） ═════════════════════════

groupStart(
  'I',
  '停止时序（stopController）',
  '`03` §4.1："点[停止] → POST /stop → 等 done{STOPPED} 收口；5s 未收口才 abort fetch，随后拉历史对齐"',
)

/**
 * 记录**调用顺序**的停止依赖（这一组的断言对象就是顺序本身）。
 *
 * ⚠️ 三个副作用全部注入：本档没有真 fetch、没有真 store、没有真流 —— 于是"先 POST 还是先 abort"
 * 这种**顺序性**的正确性能被逐字断言（跑真浏览器时它只表现为"偶尔少最后一个字"，看不出顺序）。
 */
function stopDeps(overrides = {}) {
  const calls = []
  const deps = {
    isRunning: () => true,
    requestStop: async () => {
      calls.push('requestStop')
      return { signaled: true }
    },
    waitSettled: async (ms) => {
      calls.push(`waitSettled:${ms}`)
      return true
    },
    abort: () => {
      calls.push('abort')
    },
    align: async () => {
      calls.push('align')
    },
    ...overrides,
  }
  return { calls, deps }
}

await it('I1 窗口内收到收口 ⇒ requestStop → 等 → align，**绝不 abort**', async () => {
  const { calls, deps } = stopDeps()
  const outcome = await createStopController(deps).stop()
  assertEqual(calls.join(' → '), 'requestStop → waitSettled:5000 → align', '调用顺序')
  assertEqual(outcome.kind, 'settled', '结果')
  assertEqual(outcome.signaled, true, '服务端答复原样带出')
  assertEqual(STOP_SETTLE_TIMEOUT_MS, 5000, '窗口默认值就是 `03` §4.1 点名的 5s')
})

await it('I2 窗口内没收口 ⇒ 先等满窗口、**再** abort、最后 align（顺序即正确性）', async () => {
  const { calls, deps } = stopDeps({
    waitSettled: async (ms) => {
      calls.push(`waitSettled:${ms}`)
      return false
    },
  })
  const outcome = await createStopController(deps).stop()
  assertEqual(calls.join(' → '), 'requestStop → waitSettled:5000 → abort → align', '调用顺序')
  assertEqual(outcome.kind, 'settled-locally', '结果：客户端侧收口')
  // 直接 abort（不等窗口）会让最后一段 delta 丢失 —— 那正是 `06` P0-1-33 的坑预判；
  // 上面这条顺序断言就是它的守门：`abort` 必须排在 `waitSettled` **之后**
  assertEqual(calls.indexOf('abort') > calls.indexOf('waitSettled:5000'), true, 'abort 必须在等待之后')
})

await it('I3 窗口可注入 ⇒ 真计时 30ms 内 abort（不靠等 5 秒、也不靠读代码相信）', async () => {
  const started = Date.now()
  let abortedAfterMs = null
  const { calls, deps } = stopDeps({
    // 用**真的** `waitForRoundSettled` + 一个永远不收口的观察对象 ⇒ 走真定时器
    waitSettled: (ms) =>
      waitForRoundSettled({ subscribe: () => () => {}, isSettled: () => false }, ms),
    abort: () => {
      abortedAfterMs = Date.now() - started
      calls.push('abort')
    },
  })
  const outcome = await createStopController({ ...deps, timeoutMs: 30 }).stop()
  assertEqual(outcome.kind, 'settled-locally', '结果')
  assertEqual(outcome.timeoutMs, 30, '注入的窗口原样带出（页面据此写提示文案）')
  assert(
    abortedAfterMs !== null && abortedAfterMs >= 25 && abortedAfterMs < 500,
    `abort 应发生在约 30ms（实际 ${String(abortedAfterMs)}ms）`,
  )
})

await it('I4 `POST /stop` 自己失败 ⇒ **不等窗口**，直接 abort + 对齐（按钮不能"点了没反应"）', async () => {
  const boom = new Error('网络不可达')
  const { calls, deps } = stopDeps({
    requestStop: async () => {
      calls.push('requestStop')
      throw boom
    },
  })
  const outcome = await createStopController(deps).stop()
  assertEqual(calls.join(' → '), 'requestStop → abort → align', '不进入等待')
  assertEqual(outcome.kind, 'stop-request-failed', '结果')
  assert(outcome.error === boom, '原错误原样带出（页面据此报错）')
})

await it('I5 窗口内二次点击 ⇒ 不重复 POST（幂等由控制器保证，不靠按钮禁用）', async () => {
  let resolveWait = null
  const { calls, deps } = stopDeps({
    waitSettled: (ms) =>
      new Promise((resolve) => {
        calls.push(`waitSettled:${ms}`)
        resolveWait = resolve
      }),
  })
  const controller = createStopController(deps)
  const first = controller.stop()
  const second = await controller.stop()
  assertEqual(second.kind, 'already-running', '第二次直接返回')
  assertEqual(calls.filter((call) => call === 'requestStop').length, 1, 'requestStop 只发了一次')
  resolveWait(true)
  assertEqual((await first).kind, 'settled', '第一次照常走完')
})

await it('I6 没有流在跑 ⇒ 什么都不做（零请求、零 abort）', async () => {
  const { calls, deps } = stopDeps({ isRunning: () => false })
  const outcome = await createStopController(deps).stop()
  assertEqual(outcome.kind, 'nothing-to-stop', '结果')
  assertEqual(calls.length, 0, '一个副作用都不该发生')
})

await it('I7 `align()` 抛错时 `stopping` 仍复位（否则输入区永远卡在"停止中"）', async () => {
  const { deps } = stopDeps({
    align: async () => {
      throw new Error('历史拉不到')
    },
  })
  const controller = createStopController(deps)
  await assertRejects(() => controller.stop(), 'align 抛错')
  assertEqual(controller.stopping, false, 'finally 里复位过了')
})

await it('I8 `waitForRoundSettled`：已经收口 ⇒ 立刻返回，**不订阅也不计时**', async () => {
  let subscribed = false
  const result = await waitForRoundSettled(
    {
      subscribe: () => {
        subscribed = true
        return () => {}
      },
      isSettled: () => true,
    },
    5000,
  )
  assertEqual(result, true, '结果')
  // 少了"先判一次"的写法会白等满 5 秒：症状是"服务端早就收口了，停止按钮却转 5 秒圈"
  assertEqual(subscribed, false, '不该订阅')
})

await it('I9 `waitForRoundSettled`：收口事件到达 ⇒ true，且**退订**（不泄漏监听器）', async () => {
  let active = 0
  let listener = null
  let settled = false
  const promise = waitForRoundSettled(
    {
      subscribe: (l) => {
        active += 1
        listener = l
        return () => {
          active -= 1
          listener = null
        }
      },
      isSettled: () => settled,
    },
    5000,
  )
  assertEqual(active, 1, '订阅了一次')
  settled = true
  listener()
  assertEqual(await promise, true, '结果')
  assertEqual(active, 0, '收口后必须退订（否则每点一次停止泄漏一个监听器）')
})

await it('I10 `waitForRoundSettled`：没人收口 ⇒ 返回 false（**超时是正常返回值，不是异常**）', async () => {
  let active = 0
  const result = await waitForRoundSettled(
    {
      subscribe: () => {
        active += 1
        return () => {
          active -= 1
        }
      },
      isSettled: () => false,
    },
    20,
  )
  assertEqual(result, false, '结果')
  assertEqual(active, 0, '超时路径同样要退订 + 清定时器')
})

await it('I11 接真 store：`done{STOPPED}` 一落地，等待立刻返回', async () => {
  const store = useChatStreamStore
  store.getState().reset()
  store.getState().begin('conv-stop', '长问题', STARTED_AT)
  const waiting = waitForRoundSettled(
    {
      subscribe: (listener) => store.subscribe(listener),
      isSettled: () => {
        const state = store.getState()
        return state.round === null || state.round.status !== 'streaming'
      },
    },
    1000,
  )
  store.getState().apply(eventOf('done', { messageId: 'msg-stop', finishReason: 'STOPPED', usage: null }))
  assertEqual(await waiting, true, '收口即返回')
  assertEqual(store.getState().round.status, 'stopped', '这一轮落成"已停止"')
})

// ═════════════════════════════ J 组：断线、对齐与文案（P0-1-33） ═════════════════════════

groupStart(
  'J',
  '断线与对齐（streamErrors / alignHistory / store）',
  '`03` §4.1：`CONFLICT` 专用文案、断线黄条、点击对齐历史；以及"停止后可直接追问且不丢已生成内容"',
)

/** 造一条历史消息（`alignHistory` 只看 `role`，这里就不摆整份 `MessageItem` 了） */
const histMsg = (id, role) => ({ id, role })

await it('J1 `CONFLICT` 专用文案与通用文案各走各的（`03` §4.1 / §五）', () => {
  assertEqual(chatErrorTitle('CONFLICT'), '该会话正在生成中', '专用标题')
  assertEqual(chatErrorTitle('INTERNAL'), '这一轮没有生成成功', '通用标题')
  assertEqual(chatErrorTitle('NETWORK'), '这一轮没有生成成功', '客户端伪码也走通用标题')
  assertEqual(
    chatErrorDescription('CONFLICT', '该会话正在生成中，请等当前回答结束或先停止它'),
    '该会话正在生成中，请等当前回答结束或先停止它',
    '专用文案那条只显示服务端原文（不再拼错误码）',
  )
  assertEqual(chatErrorDescription('INTERNAL', '炸了'), 'INTERNAL · 炸了', '其余错误带错误码')
})

await it('J2 **只有服务端说的故障才弹 toast**（客户端中断走黄条，不重复喊三遍）', () => {
  assertEqual(shouldToastChatError({ status: 'error', errorSource: 'server' }), true, '流内 error 事件')
  assertEqual(shouldToastChatError({ status: 'error', errorSource: 'client' }), false, '断线不弹 toast')
  assertEqual(shouldToastChatError({ status: 'streaming', errorSource: null }), false, '进行中')
  assertEqual(shouldToastChatError({ status: 'stopped', errorSource: null }), false, '已停止不是失败')
  assertEqual(shouldToastChatError({ status: 'complete', errorSource: null }), false, '正常完成')
})

await it('J3 跨包守门：前端那张短文案必须是后端原文的**前缀**（两边不许各说一套）', () => {
  const backendSse = readFileSync(
    new URL('../../backend/src/orchestrator/sse.ts', import.meta.url),
    'utf8',
  )
  // 后端那句是 `'该会话正在生成中，请等当前回答结束或先停止它'`（更长，带"该怎么办"）；
  // 前端 `03` §4.1 点名的是短句。这个断言让"后端改了措辞"或"前端自己编了一句"都能被抓住
  // —— 它是 P0-1-21 "跨表一致性断言"的同族手法
  assertIncludes(
    backendSse,
    chatErrorTitle('CONFLICT'),
    '后端 `sse.ts` 里应出现前端的 `CONFLICT` 标题',
  )
})

/**
 * 去掉注释（只用于 J4 那种"这句文案在**代码**里出现几次"的守门断言）。
 *
 * ⚠️ 它不是解析器：只按正则剥掉行注释与块注释，对字符串里含双斜杠的代码会误伤 ——
 * 对本用途（数一句**中文短句**）无害，而它换来的是"注释里引用这句话是合法的、代码里再写一份
 * 就会红"这个真正想要的口径。**不要**拿它去做别的判断。
 */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '')
}

await it('J4 同一句文案在 `frontend/src` 的**代码里**只有一处（P0-1-29 的 ⑰ 号教训）', () => {
  const literal = chatErrorTitle('CONFLICT')
  const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true })
    .filter((name) => typeof name === 'string' && /\.(ts|tsx)$/.test(name))
    // 目录分隔符统一成 `/`，否则这条断言在 Windows 上会因为 `features\chat\...` 而假红
    .map((name) => name.replaceAll('\\', '/'))
  const hits = []
  for (const name of files) {
    const content = stripComments(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
    const count = content.split(literal).length - 1
    if (count > 0) hits.push(`${name}×${count}`)
  }
  // 两个消费方（错误卡 / toast）都从 `streamErrors.ts` 取 ⇒ 代码里应当**恰好一处定义**。
  // **注释里的引用不算**（例如 `ErrorCard.tsx` 会说明"文案已搬走"）—— 这正是 `stripComments` 的用途。
  // 本仓在 P0-1-29 就吃过"同一口径两处各写一遍、其中一处先腐烂"的亏（症状是随机红）
  assertDeepEqual(hits, ['features/chat/streamErrors.ts×1'], `代码里的定义处应只有一处，实际：${hits.join('、') || '一处都没有'}`)
})

await it('J5 `shouldDropStreamVersion`：按**助手消息条数**判"服务端存了吗"（两个方向都验）', () => {
  const before = [histMsg('u1', 'USER'), histMsg('a1', 'ASSISTANT')]
  assertEqual(countAssistantMessages(before), 1, '基线条数')
  assertEqual(
    shouldDropStreamVersion(before, [...before, histMsg('a2', 'ASSISTANT')]),
    true,
    '多了一条助手消息 ⇒ 服务端存下来了 ⇒ 丢流式版本（否则同一轮渲染两遍）',
  )
  assertEqual(shouldDropStreamVersion(before, before), false, '条数没变 ⇒ 保留（本地那份是唯一副本）')
  assertEqual(
    shouldDropStreamVersion(before, [histMsg('u1', 'USER'), histMsg('a1', 'ASSISTANT'), histMsg('u2', 'USER')]),
    false,
    '只多了用户消息（下一轮已经发出去了）不算这一轮落库',
  )
})

await it('J6 `decideAlign` 的三种结论：服务端在跑 / 存下来了 / 没有这一轮', () => {
  const before = [histMsg('a1', 'ASSISTANT')]
  const recovered = decideAlign({
    before,
    after: [...before, histMsg('a2', 'ASSISTANT')],
    active: { streaming: false, queuedPosition: null, currentTool: null, startedAt: null },
  })
  assertEqual(recovered.kind, 'recovered', '存下来了')
  assertEqual(recovered.dropStreamVersion, true, '丢流式版本')

  const missing = decideAlign({ before, after: before, active: null })
  assertEqual(missing.kind, 'not-persisted', '服务端没有这一轮')
  assertEqual(missing.dropStreamVersion, false, '**保留**本地那份（丢了就是内容真的没了）')
  assertIncludes(missing.note, '唯一副本', '文案要说清为什么保留')

  // ⚠️ 这一条最值钱：服务端**还在生成**时，即使条数没变也不能宣布"没有这一轮"
  const running = decideAlign({
    before,
    after: before,
    active: { streaming: true, queuedPosition: 2, currentTool: 'read_file', startedAt: STARTED_AT },
  })
  assertEqual(running.kind, 'server-still-streaming', '服务端还在跑')
  assertEqual(running.dropStreamVersion, false, '什么都不丢')
  assertIncludes(running.note, '排队第 2 位', '进度视图（位次）')
  assertIncludes(running.note, 'read_file', '进度视图（当前工具）')
})

await it('J7 `stoppedLocally`：标成"已停止"但**不动已生成内容**，并清掉本地错误', () => {
  const store = useChatStreamStore
  store.getState().reset()
  store.getState().begin('conv-stop-2', '问', STARTED_AT)
  store.getState().apply(eventOf('delta', { text: '已生成的内容' }))
  store.getState().apply(eventOf('citations', { items: [{ docName: '手册.pdf', snippet: '片段', score: 0.5 }] }))
  store.getState().fail({ code: 'NETWORK', message: '中途断了一次' })
  assertEqual(store.getState().round.status, 'error', '先制造一个错误态')
  store.getState().stoppedLocally()
  const round = store.getState().round
  assertEqual(round.status, 'stopped', '状态')
  assertEqual(round.finishReason, 'STOPPED', '收尾原因')
  assertEqual(round.error, null, '错误被清掉（这一轮最终是"用户停止"，不是"失败"）')
  assertEqual(round.errorSource, null, '失败来源也清掉')
  assertEqual(round.assistant.text, '已生成的内容', '**已生成的内容逐字保留**')
  assertEqual(round.assistant.citations === null, false, '引用卡也保留')
  assertEqual(round.persisted, null, '不知道落没落库 ⇒ 保持 null（界面不许替服务端说话）')
})

await it('J8 `errorSource` 分得清"谁发现的"（决定 toast 还是黄条）', () => {
  const store = useChatStreamStore
  store.getState().reset()
  store.getState().begin('conv-src', '问', STARTED_AT)
  store.getState().apply(eventOf('error', { code: 'CONFLICT', message: '该会话正在生成中' }))
  assertEqual(store.getState().round.errorSource, 'server', '流内 error 事件 = 服务端发现的')
  assertEqual(store.getState().round.status, 'error', '状态')
  store.getState().reset()

  store.getState().begin('conv-src', '问', STARTED_AT)
  store.getState().fail({ code: 'NETWORK', message: '连接断了' })
  assertEqual(store.getState().round.errorSource, 'client', '本地读流失败 = 客户端发现的')
  assertEqual(store.getState().round.status, 'error', '状态')
})

await it('J9 黄条与轮次**解耦**：对齐丢掉轮次之后黄条还在，只有 `clearDisconnect` 才收', () => {
  const store = useChatStreamStore
  store.getState().reset()
  store.getState().begin('conv-banner', '问', STARTED_AT)
  store.getState().showDisconnect({ extra: 'NETWORK · 没收到终帧' })
  assertEqual(store.getState().disconnect?.extra, 'NETWORK · 没收到终帧', '黄条亮起')
  // 对齐的结论是"服务端存下来了 ⇒ 丢掉流式轮次"。若黄条挂在轮次上，它会在这一刻自己消失 ——
  // 用户就看不到"我点了它、它对齐了"这个动作（见 `stores/chatStream.ts` 的注释）
  store.getState().reset()
  assertEqual(store.getState().round, null, '轮次已丢')
  assertEqual(store.getState().disconnect === null, false, '黄条仍在')
  store.getState().clearDisconnect()
  assertEqual(store.getState().disconnect, null, '点过之后才收')
})

await it('J10 开新一轮时清掉上一轮的黄条（否则用户以为这一轮出问题了）', () => {
  const store = useChatStreamStore
  store.getState().reset()
  store.getState().showDisconnect({ extra: null })
  assertEqual(store.getState().disconnect === null, false, '先亮着')
  store.getState().begin('conv-new', '新问题', STARTED_AT)
  assertEqual(store.getState().disconnect, null, '新一轮开始时自动清掉')
})

await it('J11 验收原文：停止后**不丢已生成内容**、且输入区回到可发送（能直接追问）', async () => {
  // 整条重演：发一条 → 看着它长出来 → 点停止（走真控制器 + 真等待）→ 收口 → 能不能接着问？
  const store = useChatStreamStore
  store.getState().reset()
  store.getState().begin('conv-resume', '写个长回答', STARTED_AT)
  store.getState().apply(eventOf('delta', { text: '已经生成的前半段' }))
  store.getState().apply(eventOf('thinking', { text: '想了一下' }))

  // 点停止：依赖注入成"真 store 的收口等待"，`requestStop` 返回 `signaled:true`
  const controller = createStopController({
    isRunning: () => store.getState().round?.status === 'streaming',
    requestStop: async () => ({ signaled: true }),
    waitSettled: (ms) =>
      waitForRoundSettled(
        {
          subscribe: (listener) => store.subscribe(listener),
          isSettled: () => {
            const state = store.getState()
            return state.round === null || state.round.status !== 'streaming'
          },
        },
        ms,
      ),
    abort: () => {},
    align: async () => {},
    timeoutMs: 1000,
  })
  const stopping = controller.stop()
  // 服务端的收口帧紧跟着到达（`done{STOPPED, messageId}` —— 已生成部分照样落库，P0-1-26 定案）
  store.getState().apply(
    eventOf('done', { messageId: 'msg-partial', finishReason: 'STOPPED', usage: null }),
  )
  const outcome = await stopping
  assertEqual(outcome.kind, 'settled', '等到收口（不是兜底 abort）')

  const round = store.getState().round
  assertEqual(round.status, 'stopped', '收尾原因来自服务端')
  assertEqual(round.assistant.text, '已经生成的前半段', '**已生成的内容没有丢**')
  assertEqual(round.finishReason, 'STOPPED', '标注"已停止"')
  assertEqual(round.persisted, true, '`messageId` 非空 ⇒ 落库了（刷新后历史里能看到）')
  // "可直接追问"的判据：输入区回到 idle ⇒ 主按钮是发送、canSend 由草稿决定
  const view = composeState({
    round: round.status === 'streaming' ? round : null,
    sending: false,
    stopping: false,
    draft: '接着问下一条',
  })
  assertEqual(view.state, 'idle', '输入区回到 idle')
  assertEqual(view.canSend, true, '可以立刻追问')
  // 收尾行（`AssistantMessage`）也要说对：`stopped` ⇒ "已停止 · 已生成的内容保留"
  const [userView, assistantView] = roundToViews(round)
  assertEqual(userView.role, 'USER', '第一条是用户')
  assertEqual(assistantView.status, 'stopped', '第二条助手视图的状态')
})

await it('J12 `round === null` 也算"已收口"（少了这条会让停止按钮白转满 5 秒）', async () => {
  const store = useChatStreamStore
  store.getState().reset()
  const isSettled = () => {
    const state = store.getState()
    return state.round === null || state.round.status !== 'streaming'
  }
  assertEqual(isSettled(), true, '没有轮次 ⇒ 没什么可等的')
  store.getState().begin('conv-null', '问', STARTED_AT)
  assertEqual(isSettled(), false, '有流在跑')
  store.getState().reset()
  assertEqual(isSettled(), true, '被对齐丢掉了 ⇒ 也算收口')
  store.getState().reset()
})

// ═════════════════════════════ K 组：会话侧栏（P0-1-34） ═════════════════════════

groupStart(
  'K',
  '会话侧栏（conversationList / 缓存键 / 坑预判守门）',
  '`03` §4.1 的侧栏三句（最近活跃排序 / 行内重命名 / 分级删除）与坑预判「活跃排序需在 done 后刷新」',
)

/** 侧栏的"现在"：**本地时间**字面量（实现的判据也全是本地日历日，两处必须同口径） */
const SIDEBAR_NOW = new Date('2026-09-23T15:00:00')

/**
 * 造一条 `ConversationItem`。
 *
 * 它按 `shared/src/conversation.ts#conversationItemSchema` 把形状补满（侧栏只用得到其中几个
 * 字段，但**形状要真** —— "少两个字段也能过"的夹具会让类型断言失去意义）。
 */
const convItem = (patch) => ({
  id: 'conv-1',
  agentId: 'agent-1',
  agentName: '周报生成器',
  agentType: 'CHATBOT',
  topic: null,
  status: 'ACTIVE',
  lastMessageAt: null,
  createdAt: '2026-09-23T14:00:00',
  updatedAt: '2026-09-23T14:00:00',
  ...patch,
})

await it('K1 时间读数五档（含 `null`）；**按日历日分档，不是按 24 小时差**', () => {
  assertEqual(describeConversationTime(null, SIDEBAR_NOW), '还没有消息', '没消息的会话（不是 createdAt！）')
  assertEqual(describeConversationTime('2026-09-23T14:59:30', SIDEBAR_NOW), '刚刚', '30 秒前')
  assertEqual(describeConversationTime('2026-09-23T14:57:00', SIDEBAR_NOW), '3 分钟前', '3 分钟前')
  assertEqual(describeConversationTime('2026-09-23T12:00:00', SIDEBAR_NOW), '3 小时前', '3 小时前')
  assertEqual(describeConversationTime('2026-09-22T18:20:00', SIDEBAR_NOW), '昨天 18:20', '昨天')
  assertEqual(describeConversationTime('2026-09-20T11:02:00', SIDEBAR_NOW), '09-20 11:02', '更早')
  // ⚠️ 这一条是"日历日 vs 24h"的判别用例：差 15 小时 10 分，但**隔了一个自然日**。
  //    写成 `(now - at) / 86400000` 取整的实现会得到"15 小时前"，而它其实是昨天的消息
  //    —— 读数看着完全正常，只有分组会错（这正是它值得一条断言的原因）
  assertEqual(describeConversationTime('2026-09-22T23:50:00', SIDEBAR_NOW), '昨天 23:50', '跨零点但不足 24 小时')
  // 服务端时钟比本机快（漂移）⇒ 显示"刚刚"，不显示负数
  assertEqual(describeConversationTime('2026-09-23T15:01:00', SIDEBAR_NOW), '刚刚', '未来的时间当刚刚')
})

await it('K2 分组只切「今天 / 更早」，空组不出现，组内保持服务端给的顺序', () => {
  // 入参顺序 = 服务端的顺序（`lastMessageAt desc` + `nulls:'first'`，`02` §4.5 ③）：
  // 没消息的新会话排最前，然后按活跃时间降序
  const list = [
    convItem({ id: 'fresh', createdAt: '2026-09-23T14:30:00' }),
    convItem({ id: 'today', topic: '本周部署变更周报', lastMessageAt: '2026-09-23T12:00:00' }),
    convItem({ id: 'yesterday', lastMessageAt: '2026-09-22T18:20:00' }),
    convItem({ id: 'lastWeek', lastMessageAt: '2026-09-20T11:02:00' }),
  ]
  const groups = groupConversationViews(list, SIDEBAR_NOW, null)

  assertDeepEqual(
    groups.map((group) => group.label),
    ['今天', '更早'],
    '分组标题与顺序',
  )
  assertDeepEqual(
    groups[0].items.map((item) => item.id),
    ['fresh', 'today'],
    '「今天」：**刚建好还没说话的会话**也在今天（用 createdAt 兜底，不是掉进"更早"）',
  )
  assertDeepEqual(
    groups[1].items.map((item) => item.id),
    ['yesterday', 'lastWeek'],
    '「更早」',
  )
  // 契约里最要紧的一条（见 `conversationList.ts` 文件头）：分组只切归属、**一列都不动**
  assertDeepEqual(
    groups.flatMap((group) => group.items.map((item) => item.id)),
    list.map((item) => item.id),
    '把各组拼回去必须等于入参原序（侧栏自己重排会与服务端分页打架）',
  )

  assertDeepEqual(
    groupConversationViews([convItem({ id: 'a' })], SIDEBAR_NOW, null).map((group) => group.label),
    ['今天'],
    '只有今天的内容 ⇒ 不该出现一个空的「更早」标题',
  )
  assertDeepEqual(
    groupConversationViews([convItem({ id: 'b', lastMessageAt: '2026-09-10T10:00:00' })], SIDEBAR_NOW, null).map(
      (group) => group.label,
    ),
    ['更早'],
    '反过来同理',
  )
  assertDeepEqual(groupConversationViews([], SIDEBAR_NOW, null), [], '一个会话都没有 ⇒ 没有分组')
})

await it('K3 状态灯三态：「生成中」只由**流 store** 点亮，`FINISHED` ⇒ 只读保留', () => {
  const active = convItem({ id: 'a', topic: '本周部署变更周报', lastMessageAt: '2026-09-23T14:57:00' })

  const running = conversationItemView(active, SIDEBAR_NOW, 'a')
  assertEqual(running.led, 'run', '这一条在生成')
  assertEqual(running.state, '生成中', '状态文案（与灯"色 + 字"两重表达）')
  assertEqual(running.title, '本周部署变更周报', '标题取 topic')
  assertEqual(running.time, '3 分钟前', '时间读数')

  // ⚠️ 指向是**单侧**的：别的会话在生成，这一条不该亮 run（写成"只要有流就全都亮"的实现会红）
  const other = conversationItemView(active, SIDEBAR_NOW, 'some-other-conversation')
  assertEqual(other.led, 'idle', '别的会话在生成 ⇒ 这一条仍是 idle')
  assertEqual(other.state, '可继续', '文案')

  const finished = conversationItemView(convItem({ id: 'c', status: 'FINISHED' }), SIDEBAR_NOW, null)
  assertEqual(finished.led, 'warn', 'FINISHED（Agent 被软删 ⇒ 只读保留）')
  assertEqual(finished.state, '只读保留', '文案说结果，不说"已结束"')

  const untitled = conversationItemView(convItem({ id: 'd' }), SIDEBAR_NOW, null)
  assertEqual(untitled.title, '新会话', '没命名过 ⇒ 回落到 shared 的 CONVERSATION_UNTITLED_HINT')
  assertEqual(untitled.time, '还没有消息', '没有消息时的时间读数')
})

await it('K4 行内重命名的三条判据（空 / 超长 / 没改动）；长度按**码点**算', () => {
  assertEqual(normalizeTopicDraft('', null), null, '空串 ⇒ 提交不成立')
  assertEqual(normalizeTopicDraft('   ', '旧名'), null, '只有空白 ⇒ 也不成立（后端 trim 后是空）')

  const trimmed = normalizeTopicDraft('  沙箱并发怎么调  ', null)
  assertEqual(trimmed.topic, '沙箱并发怎么调', '提交前 trim')
  assertEqual(trimmed.unchanged, false, '是个新名字')

  assertEqual(normalizeTopicDraft('旧名', '旧名').unchanged, true, '点开又原样保存 ⇒ 不发 PATCH')
  assertEqual(normalizeTopicDraft(' 旧名 ', '旧名').unchanged, true, '只差空白也算没改动（trim 后比）')
  assertEqual(normalizeTopicDraft('新名', null).unchanged, false, '原来没名字 ⇒ 一定有改动')

  assertEqual(
    normalizeTopicDraft('x'.repeat(CONVERSATION_TOPIC_MAX_CHARS), null).topic.length,
    CONVERSATION_TOPIC_MAX_CHARS,
    '恰好到上限 ⇒ 可以',
  )
  assertEqual(normalizeTopicDraft('x'.repeat(CONVERSATION_TOPIC_MAX_CHARS + 1), null), null, '超一个字符 ⇒ 不行')
  // ⚠️ 按**码点**算：255 个 emoji 是 255 个字符，而 `'😀'.repeat(255).length` 是 510。
  //    写成 `raw.length` 的实现会在这里红 —— 而它的症状是"用户打了半个标题就被拦下"
  assert(
    normalizeTopicDraft('😀'.repeat(CONVERSATION_TOPIC_MAX_CHARS), null) !== null,
    '255 个 emoji 应当通过（后端 zod 的 `.max()` 也是按码点）',
  )
})

await it('K5 会话删除弹窗已去掉逐字输入确认（需求优化）', () => {
  const modal = stripComments(
    readFileSync(new URL('../src/features/chat/DeleteConversationModal.tsx', import.meta.url), 'utf8'),
  )
  assert(!modal.includes('isDeleteConfirmed'), '不再逐字确认')
  assert(!modal.includes('app/confirm.js'), '不再 import 已删除的 confirm 模块')
  assert(modal.includes('danger: true'), '仍是红色危险按钮（级联删除档）')
})

await it('K6 「+ 新会话」的判据：已经在新会话态 ⇒ 什么都不做', () => {
  assertEqual(newConversationAction('conv-1'), 'navigate', '从某个会话切走 ⇒ 导航到不带 id 的地址')
  assertEqual(newConversationAction(undefined), 'already-new', '已经在新会话态 ⇒ 别往历史里塞空条目')
})

await it('K7 缓存键是**父子**关系：一次失效让"侧栏列表 + 会话总数"同时对齐', () => {
  const parent = agentConversationsQueryKey('agent-1')
  const child = agentConversationsListQueryKey('agent-1')
  assertDeepEqual([...child].slice(0, parent.length), [...parent], '列表键必须是总数键的子键')
  assert(child.length > parent.length, '子键要比父键长（否则两者是同一个缓存项）')
  // ⚠️ 反向的一条：**不同的智能体不能共用同一个键**。把 agentId 忘了放进键里（或写成常量）的
  //    实现会让"换一个智能体看到上一个的会话列表"，而它在两个智能体下都长得像正常数据
  assert(
    agentConversationsListQueryKey('agent-1').join('|') !== agentConversationsListQueryKey('agent-2').join('|'),
    '不同 agentId 的缓存键必须不同',
  )
})

await it('K8 上限常量与 `shared` 的契约同源（数字不许在两处各写一遍）', () => {
  assertEqual(CONVERSATIONS_PAGE_LIMIT_MAX, 100, '侧栏一次取满 100 条（= listConversationsQuerySchema 的 limit 上限）')
  assert(
    listConversationsQuerySchema.safeParse({ limit: CONVERSATIONS_PAGE_LIMIT_MAX }).success,
    '这个值本身必须通过后端的 schema',
  )
  assert(
    !listConversationsQuerySchema.safeParse({ limit: CONVERSATIONS_PAGE_LIMIT_MAX + 1 }).success,
    '再大一个就必须被拒（否则"取满 100"是假的）',
  )

  assert(
    renameConversationBodySchema.safeParse({ topic: 'x'.repeat(CONVERSATION_TOPIC_MAX_CHARS) }).success,
    '标题上限本身合法',
  )
  assert(
    !renameConversationBodySchema.safeParse({ topic: 'x'.repeat(CONVERSATION_TOPIC_MAX_CHARS + 1) }).success,
    '超一个字符必须被拒',
  )
  // 字段级**文案里**的数字也要来自同一个常量（P0-1-29 的 ⑰ 号教训：同一事实两处写必有一处腐烂）
  const tooLong = renameConversationBodySchema.safeParse({ topic: 'x'.repeat(CONVERSATION_TOPIC_MAX_CHARS + 1) })
  assert(
    tooLong.success === false &&
      tooLong.error.issues.some((issue) => issue.message.includes(String(CONVERSATION_TOPIC_MAX_CHARS))),
    '字段级文案里的数字应当引用同一个常量',
  )
})

await it('K9 **坑预判守门**：流结束时必须失效会话列表（否则新会话不冒头）', () => {
  // `03` §五 的 `done` 行原文："结束流；… ；**刷新会话列表排序**"。
  // 侧栏的排序键是 `last_message_at`，而它**正是这一轮落库时才被推进的**（`02` §4.5 ④）
  // ⇒ 少了这次失效，刚说完话的会话在侧栏里排不到最前面（"新会话不冒头"）。
  // 断言落在**源码**上（与 J4 同族）：它守的是"这一行被删掉"这件事，而它在纯函数里看不见。
  const source = stripComments(
    readFileSync(new URL('../src/features/chat/useChatStream.ts', import.meta.url), 'utf8'),
  )
  assertIncludes(
    source,
    'invalidateQueries({ queryKey: agentConversationsQueryKey(agentId) })',
    '`useChatStream.ts` 里应当有这一行',
  )
})

await it('K10 侧栏**不许自己排序**（排序口径只有服务端那一份）', () => {
  // 在侧栏里再排一次 = 出现了第二份排序口径，而它与服务端的 offset/limit 分页会打架
  // （症状："翻到第二页时同一条又出现一次 / 某一条永远看不到"）。分组只切归属，不动顺序。
  const source = stripComments(
    readFileSync(new URL('../src/features/chat/ConversationSidebar.tsx', import.meta.url), 'utf8'),
  )
  assert(!source.includes('.sort('), '侧栏源码里不该出现 `.sort(`')
})

// ───────────────────────────── 复原桩 ─────────────────────────────

globalThis.fetch = realFetch

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── 结论表（` + '`docs/06` 的验收原文逐条）──' + `${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.b}── P0-1-32 验收原文四条对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 发消息能看到 delta 逐字追加 ............ D2 / C1`)
console.log(`  ${c.g}②${c.x} 思考块流式展开后自动折叠 ............ D3（数据侧：thinking 逐帧长出来）`)
console.log(`     ${c.y}⚠️${c.x} "展开后自动折叠"是组件里的受控逻辑（` + '`ThinkingBlock`：`open = userChoice ?? streaming`），')
console.log(`        纯函数档验不到它 ⇒ 归浏览器端测（` + '`README` ⑳）')
console.log(`  ${c.g}③${c.x} 引用卡在 citations 事件到达时出现 .... D5 / E4（空数组不画卡、有引用无正文也不算空）`)
console.log(`  ${c.g}④${c.x} 刷新后历史同一套组件、形态一致 ........ E3（两侧归一出的字段逐字相等）`)
console.log(`  ${c.g}坑${c.x} ping 必须静默忽略 .................... D1 / G3（返回同一引用 ⇒ 零重渲染）`)

console.log(`\n${c.b}── P0-1-33 验收原文三条对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 停止后可直接追问且不丢已生成内容 ...... J11（真 store 重演：正文逐字保留 + 回到 idle 可发）`)
console.log(`     ${c.g}+${c.x} 停止的先后顺序（POST → 等 → abort → 对齐）.. I1/I2/I4（顺序逐字断言 + 30ms 真计时 I3）`)
console.log(`  ${c.g}②${c.x} 同标签页重复发送出现专用 toast ........ J1（` + '`CONFLICT` → 「该会话正在生成中」' + `）+ H8（同步闸门）`)
console.log(`     ${c.y}⚠️${c.x} "toast 真的弹出来了"是 React 侧的事 ⇒ 归浏览器端测（` + '`README` ㉗）；')
console.log(`        本档守的是"弹哪个文案、什么情况下弹"（J1/J2）与"重复发送根本进不去"（H8）`)
console.log(`  ${c.g}③${c.x} 断线黄条点击后历史与后端一致 .......... J5/J6（丢流式版本的判据）+ J9（黄条不被丢轮次带走）`)
console.log(`  ${c.g}坑${c.x} 停止的 5s 收口窗口不能省 .............. I2（abort 必须排在等待之后）+ I3（窗口可注入）`)

console.log(`\n${c.b}── P0-1-34 验收原文两条对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 新建 → 切换 → 重命名 → 删除全流程顺 ...... K4（改名三条判据）+ K5（删除弹窗去逐字确认）+ K6（新建）`)
console.log(`     ${c.g}+${c.x} 列表形态（分组 / 顺序 / 读数 / 状态灯）......... K1 + K2 + K3`)
console.log(`     ${c.y}⚠️${c.x} "顺不顺"是交互与网络的事（导航、` + '`PATCH`/`DELETE` 真打出去）⇒ 归浏览器端测（`' + `README` + '` ㉜~㊱）')
console.log(`  ${c.g}②${c.x} 对话中途仍能进知识库/凭据页（导航不孤岛）... K10 的同族守门（源码级）`)
console.log(`     ${c.y}⚠️${c.x} 专注布局本身（仪表轨收起 + 「工作台」下拉）是渲染的事 ⇒ 归浏览器端测（` + '`README` ㊲）')
console.log(`  ${c.g}坑${c.x} 活跃排序需在 done 后刷新 ................... K9（源码级守门：那一行被删掉就红）`)

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · React 渲染与交互（七种卡片、黄条、状态灯长什么样、侧栏布局）⇒ 浏览器端测（` + '`README` ㉖~㊲）')
console.log(`  · 真后端那一侧（响应头禁用缓冲 / 互斥锁 / 心跳 / done 时序 / stop 端点的服务端行为）⇒ ` + '`pnpm verify:chat-stream`、`verify:chatbot`')
console.log(`  · 打包产物：本档跑的是**源码**（` + '`node --import tsx`' + `），不经 vite${c.x}`)

console.log('')
if (failed === 0) {
  console.log(
    `${c.g}${c.b}✅ 对话页前端验收通过（P0-1-32 SSE 客户端 + P0-1-33 输入区/停止/断线 + P0-1-34 会话侧栏）：${passed} 项全通过${c.x}`,
  )
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 对话页前端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
