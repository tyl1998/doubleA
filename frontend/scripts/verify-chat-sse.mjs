#!/usr/bin/env node
/**
 * verify-chat-sse.mjs —— P0-1-32（对话页骨架 + SSE 客户端）的**无依赖**验收
 *
 * 跑法：`pnpm verify:chat-sse`
 *      （= `node --import tsx frontend/scripts/verify-chat-sse.mjs`，见文件末尾的"依赖与前置"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险**不在"界面好不好看"**，而在三处**错了不会报错、只会少一点内容**的地方：
 *   · **字节 → 帧**：一帧被 TCP 切成几段、分隔符横跨两个 chunk、一个汉字被切在两段之间……
 *     手点浏览器碰到这些边界的概率约等于零，而它们的症状是"回答偶尔缺一个字 / 断掉"；
 *   · **帧 → 状态**：`03` §五 那张"事件 → UI"映射表有十行，写错一行只表现为"少一张卡"；
 *   · **历史 vs 流式**：两条路径各自渲染时不会报错，只会"刷新前有、刷新后没有"。
 * 这三处全是**纯函数**（`sseParser.ts` / `chatStream.ts` / `roundReducer.ts` / `messageModel.ts`），
 * 故本档直接喂手写字节与手写事件序列，逐条断言最终形状 —— 这是本仓"纯逻辑拆进无依赖文件
 * ⇒ 断言进无依赖档"的同一手法（对照 backend 的 `chatContext.ts` / `semaphore.ts`）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · React 渲染（七种卡片长什么样、思考块点开/自动折叠的交互）⇒ 归浏览器端测（`README` ⑳）；
 *   · 真后端的帧（响应头、锁、心跳、`done` 时序）⇒ 归 `pnpm verify:chat-stream` / `verify:chatbot`；
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
  confirm: { confirmId: 'confirm-1', toolName: 'run_shell', inputSummary: 'rm -rf build' },
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

// ───────────────────────────── 复原桩 ─────────────────────────────

globalThis.fetch = realFetch

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── P0-1-32 结论表（` + '`docs/06` 的验收原文逐条）──' + `${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.b}── 验收原文四条对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 发消息能看到 delta 逐字追加 ............ D2 / C1`)
console.log(`  ${c.g}②${c.x} 思考块流式展开后自动折叠 ............ D3（数据侧：thinking 逐帧长出来）`)
console.log(`     ${c.y}⚠️${c.x} "展开后自动折叠"是组件里的受控逻辑（` + '`ThinkingBlock`：`open = userChoice ?? streaming`），')
console.log(`        纯函数档验不到它 ⇒ 归浏览器端测（` + '`README` ⑳）')
console.log(`  ${c.g}③${c.x} 引用卡在 citations 事件到达时出现 .... D5 / E4（空数组不画卡、有引用无正文也不算空）`)
console.log(`  ${c.g}④${c.x} 刷新后历史同一套组件、形态一致 ........ E3（两侧归一出的字段逐字相等）`)
console.log(`  ${c.g}坑${c.x} ping 必须静默忽略 .................... D1 / G3（返回同一引用 ⇒ 零重渲染）`)

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · React 渲染与交互（七种卡片长什么样）⇒ 浏览器端测（` + '`README` ⑳）')
console.log(`  · 真后端那一侧（响应头禁用缓冲 / 互斥锁 / 心跳 / done 时序）⇒ ` + '`pnpm verify:chat-stream`、`verify:chatbot`')
console.log(`  · 打包产物：本档跑的是**源码**（` + '`node --import tsx`' + `），不经 vite${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-32 SSE 客户端验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-32 SSE 客户端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
