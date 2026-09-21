#!/usr/bin/env node
/**
 * verify-llm.mjs —— P0-1-12 的 **LLM client 验收**（需要真实 Redis + PG）
 *
 * 验的是 `06` P0-1-12 的两条验收门槛 + `02` §4.3 的「拉取该配置下的上游模型」：
 *
 *   ① 「对一个真实 provider 发一次极小请求（`max_tokens: 1`）能拿到响应」；
 *   ② 「流式模式下能逐块收到 delta」。
 *
 * ⚠️ **"真实 provider" 用本地假上游代替**。不这样做的原因不是图省事：
 *    验收不能依赖外部厂商（凭据、网络、限额、以及"厂商哪天改了报文"都会让脚本变成噪声）。
 *    这里起一个**真的 HTTP 服务**（`http.createServer` + 端口 0），按 OpenAI 兼容协议应答，
 *    并把收到的每个请求原样记下来 —— 于是"Key 到底有没有被解密注入""有没有乱发 `stream_options`"
 *    这类问题都能**在服务端取证**，而不是靠读代码猜。
 *
 * 两类用例，刻意分开（对应 `llm/client.ts` 的分层）：
 *   · **A 组 · 传输层**（模块级，手工构造 target，不需要库）：报文正确性、超时、中断、流式边界。
 *   · **B 组 · 集成**（走 `app.inject` + 真库）：`resolveChatTarget()` 的四道前置校验、
 *     路由 `GET /api/model-providers/:id/remote-models`、以及**"密文里的 Key 被解密后
 *     真的注进了 Authorization"**（一次端到端取证）。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`
 * 脚本自造带随机后缀的临时数据（ADMIN + MEMBER + 4 个 Provider + 若干模型），结束时删净。
 */

// 必须在 import `config.js`（经 dist 的 app.js / client.js）之前设置：
// 脚本会打一堆"应当失败"的请求（401/超时/中断），每个都留一条 warn 会把断言输出冲掉。
// 看细节时：`LOG_LEVEL=debug pnpm verify:llm`。
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

import http from 'node:http'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } =
  await import('../dist/backend/src/infra/redis.js')
const { chat, chatStream, fetchRemoteModels, normalizeRemoteModels, redactSecret } = await import(
  '../dist/backend/src/llm/client.js'
)
const { resolveChatTarget, listProviderRemoteModels } = await import(
  '../dist/backend/src/services/model.service.js'
)
const { remoteModelListResultSchema } = await import('@doubulea/shared')

// ───────────────────────────── 断言脚手架（与另几个脚本同一套）─────────────────────────────

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
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

// ───────────────────────────── 假上游（真 HTTP 服务，端口 0）─────────────────────────────

/** 收到的请求流水（断言用：Authorization / body / 次数 都在这里取证） */
const upstreamRequests = []

/** SSE 帧：`data: {...}\n\n` */
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

/** 假上游的应答：每条路径对应一类**真实存在**的兼容性差异（注释里写清是哪一种） */
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const piece of req) chunks.push(piece)
  const raw = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const auth = req.headers.authorization ?? null
  upstreamRequests.push({ method: req.method, path: url.pathname, auth, raw })

  // ── GET /models 的三种形态 ──
  if (url.pathname === '/v1/models') {
    // 标准 OpenAI 形态
    return json(res, 200, {
      object: 'list',
      data: [
        { id: `gpt-4o-mini`, object: 'model', created: 1_700_000_000, owned_by: 'system' },
        { id: `bge-m3`, object: 'model', created: 1_700_000_100, owned_by: 'verify-${suffix}' },
      ],
    })
  }
  if (url.pathname === '/plain/models') {
    // 裸数组 + 重复项 + 缺字段（验归一化/去重/排序）
    return json(res, 200, [
      { id: 'z-model' },
      { id: 'a-model', owned_by: 'x' },
      { id: 'z-model' },
      'bare-string-model',
    ])
  }
  if (url.pathname === '/alt/models') {
    // llama.cpp / ollama 兼容层形态：`{ models: [{ name }] }`，且**不校验凭据**
    return json(res, 200, { models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b' }, { name: 'bge-m3:latest' }] })
  }
  if (url.pathname === '/authfail/models') {
    // 401 且把 Authorization 回显进 body —— 我们的错误消息必须脱敏（见 A 组用例）
    return json(res, 401, { error: { message: `invalid token: ${auth ?? '(none)'}` } })
  }

  // ── POST /chat/completions 的多种形态 ──
  if (url.pathname === '/v1/chat/completions') {
    // 标准非流式；把收到的 Authorization 与 max_tokens 回显出来，供断言取证
    const body = JSON.parse(raw)
    return json(res, 200, {
      id: 'chatcmpl-verify',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `收到了 ${body.max_tokens} 的额度` },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      echo_auth: auth,
    })
  }
  if (url.pathname === '/stream/chat/completions') {
    const body = JSON.parse(raw)
    if (body.stream !== true) return json(res, 400, { error: { message: 'expected stream:true' } })
    sseHead(res)
    res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] })) // 只有 role 的首帧
    res.write(': ping\n\n') // 注释行（保活）
    res.write(frame({ choices: [] })) // 保活空帧（有的实现会这么发）
    res.write(frame({ choices: [{ delta: { reasoning_content: '思考中' } }] })) // 思考增量
    // ⚠️ 关键：把一帧**拆成两次 write**，模拟 TCP 分片（`data: {"cho` + `ices":…`）
    const first = frame({ choices: [{ delta: { content: '你好，' } }] })
    res.write(first.slice(0, 18))
    await sleep(20)
    res.write(first.slice(18))
    res.write(frame({ choices: [{ delta: { content: '这是' } }] }))
    await sleep(10)
    res.write(frame({ choices: [{ delta: { content: '流式' } }] }))
    // 最后一帧：**不带结尾空行**、且**不发 `[DONE]`** —— 两种真实差异一起验
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '回答。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}`)
    return res.end()
  }
  if (url.pathname === '/json/chat/completions') {
    // 声称支持流、却直接回 JSON（代理把 stream 吞掉的实现）
    return json(res, 200, {
      choices: [{ message: { content: '我是被吞掉流的回答' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
  }
  if (url.pathname === '/slow/chat/completions') {
    return // 永不响应 —— 验"到响应头"超时
  }
  if (url.pathname === '/stall/chat/completions') {
    sseHead(res)
    res.write(frame({ choices: [{ delta: { content: '开了个头' } }] }))
    return // 之后静默 —— 验"流内空闲"超时（响应头已到手，到响应头的超时已被撤掉）
  }
  if (url.pathname === '/fail/chat/completions') {
    return json(res, 401, { error: { message: `invalid api key: ${auth ?? '(none)'}` } })
  }
  if (url.pathname === '/error200/chat/completions') {
    // 200 里藏错误（很多网关这么干）
    return json(res, 200, { error: { message: 'quota exceeded' } })
  }
  if (url.pathname === '/notjson/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<html>502 Bad Gateway</html>')
  }
  if (url.pathname === '/v1/chat/completions-with-key-echo') {
    return json(res, 200, { error: { message: `leaked? ${auth ?? ''}` } })
  }
  return json(res, 404, { error: { message: `no such path: ${url.pathname}` } })
})

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port
const upstreamBase = `http://127.0.0.1:${upstreamPort}`

/** 手工构造的 target（A 组用；B 组由 `resolveChatTarget` 产出） */
function targetAt(path, apiKey = SECRET_KEY) {
  return {
    modelId: 'unit-model',
    modelName: 'unit-model',
    label: '单测假模型',
    maxContext: null,
    supportsVision: false,
    providerId: 'unit-provider',
    providerName: '假上游',
    baseUrl: `${upstreamBase}${path}`,
    apiKey,
  }
}

/** 收流式增量的工具 */
function collector() {
  const deltas = []
  const thinking = []
  const usages = []
  return {
    deltas,
    thinking,
    usages,
    callbacks: {
      onDelta: (text) => deltas.push(text),
      onThinking: (text) => thinking.push(text),
      onUsage: (usage) => usages.push(usage),
    },
  }
}

// ───────────────────────────── 集成侧的准备（真库 + 真接口）─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Llm-Passw0rd'
/** 假的明文 Key（会被 API 加密落库，再由 resolveChatTarget 解密注入） */
const SECRET_KEY = 'sk-verify-llm-0123456789abcdefghij'

const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-llm-admin-${suffix}`
const memberUsername = `verify-llm-member-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()

function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const pair = header.split(';')[0] ?? ''
  const value = pair.slice(pair.indexOf('=') + 1)
  if (value !== '') sessionIds.push(value)
  return value
}

function api(method, url, { cookie, payload } = {}) {
  const options = { method, url }
  if (cookie !== undefined && cookie !== '') options.headers = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
  if (payload !== undefined) options.payload = payload
  return app.inject(options)
}

// ───────────────────────────── A 组：传输层（模块级，不需要库）─────────────────────────────

console.log(`\n${c.b}══ P0-1-12 LLM client 验收：报文 / 流式边界 / 超时与中断 / 上游模型列表 ══${c.x}`)
console.log(`  ${c.d}假上游：${upstreamBase}（真 HTTP 服务，端口 0）${c.x}`)

try {
  await app.ready()
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
    await upstream.close()
    process.exit(1)
  }

  // ══════════ 1. chat()：报文与解读 ══════════
  await it('chat()：`max_tokens: 1` 真的发出去了，且 Authorization 是 `Bearer <明文 Key>`（上游侧取证）', async () => {
    upstreamRequests.length = 0
    const result = await chat(targetAt('/v1'), [{ role: 'user', content: '在吗' }], { maxTokens: 1 })

    const sent = upstreamRequests.find((item) => item.path === '/v1/chat/completions')
    assert(sent !== undefined, '假上游没有收到 /v1/chat/completions 请求')
    const body = JSON.parse(sent.raw)
    assertEqual(body.max_tokens, 1, '请求体里的 max_tokens')
    assertEqual(body.stream, false, '非流式应显式 stream:false')
    assertEqual(body.model, 'unit-model', '请求体里的 model')
    assertEqual(body.messages.length, 1, 'messages 条数')
    assertEqual(sent.auth, `Bearer ${SECRET_KEY}`, 'Authorization 头（明文 Key 注入）')
    assertEqual(sent.method, 'POST', '方法')

    assertEqual(result.text, '收到了 1 的额度', '解读出的文本')
    assertEqual(result.rawFinishReason, 'stop', 'rawFinishReason 保留上游原值')
    assertEqual(result.usage?.tokensIn, 7, 'usage.tokensIn')
    assertEqual(result.usage?.tokensOut, 3, 'usage.tokensOut')
    assertEqual(result.usage?.tokensTotal, 10, 'usage.tokensTotal')
  })

  await it('`temperature` 不带就不发；`extraBody` 原样并入（给 F 包的逃生口）', async () => {
    upstreamRequests.length = 0
    await chat(targetAt('/v1'), [{ role: 'user', content: 'hi' }], {
      extraBody: { top_p: 0.9, stop: ['</end>'] },
    })
    const body = JSON.parse(upstreamRequests[0].raw)
    assert(!('temperature' in body), '没给 temperature 就不该出现这个键')
    assertEqual(body.top_p, 0.9, 'extraBody 应原样并入')
    assertEqual(Array.isArray(body.stop), true, 'extraBody 的数组字段也应原样并入')
  })

  await it('上游 401 → `UPSTREAM_ERROR`(502)，且错误消息里**不含明文 Key**（脱敏取证）', async () => {
    let caught
    try {
      await chat(targetAt('/fail'), [{ role: 'user', content: 'hi' }])
    } catch (error) {
      caught = error
    }
    assert(caught !== undefined, '应当抛错')
    assertEqual(caught.code, 'UPSTREAM_ERROR', '错误码')
    assertEqual(caught.status, 502, 'HTTP 状态码')
    assert(caught.message.includes('上游返回 401'), `消息应点明上游状态码，实际：${caught.message}`)
    assert(caught.message.includes('检查该 Provider 的 API Key'), '401 应给出可执行的提示')
    assert(
      !caught.message.includes(SECRET_KEY),
      '⚠️ 上游把 Authorization 回显进了 body，错误消息**必须**把它抹掉（否则等于借错误消息漏 Key）',
    )
    assert(caught.message.includes('****'), `不含明文即应留掩码痕迹，实际：${caught.message}`)
    assertEqual(caught.data?.upstreamStatus, 401, '错误 data 里带上游状态码')
  })

  await it('上游 200 里藏 `{error}` / 回非 JSON → 都归成 `UPSTREAM_ERROR` 而不是"答了个空"', async () => {
    for (const [path, expectFragment] of [
      ['/error200', 'quota exceeded'],
      ['/notjson', '不是合法 JSON'],
    ]) {
      let caught
      try {
        await chat(targetAt(path), [{ role: 'user', content: 'hi' }])
      } catch (error) {
        caught = error
      }
      assert(caught !== undefined, `${path} 应当抛错`)
      assertEqual(caught.code, 'UPSTREAM_ERROR', `${path} 错误码`)
      assert(
        caught.message.includes(expectFragment),
        `${path} 的消息应含「${expectFragment}」，实际：${caught.message}`,
      )
    }
  })

  await it('`redactSecret` 纯函数：抹掉全部出现处、短串不动（防"脱敏把正文打花"）', () => {
    assertEqual(redactSecret(`a ${SECRET_KEY} b ${SECRET_KEY}`, SECRET_KEY), 'a **** b ****', '长 Key 全部替换')
    assertEqual(redactSecret('abc', 'ab'), 'abc', '过短的密钥不做替换（否则会把正常文本打花）')
    assertEqual(redactSecret('nothing', null), 'nothing', '没有 Key 时原样返回')
  })

  // ══════════ 2. 超时：两级 ══════════
  await it('「到响应头」超时 → `UPSTREAM_TIMEOUT`(504)，且**不等**满配置值就返回', async () => {
    const startedAt = Date.now()
    let caught
    try {
      await chat(targetAt('/slow'), [{ role: 'user', content: 'hi' }], { timeoutMs: 300 })
    } catch (error) {
      caught = error
    }
    const elapsed = Date.now() - startedAt
    assert(caught !== undefined, '应当抛错')
    assertEqual(caught.code, 'UPSTREAM_TIMEOUT', '错误码')
    assertEqual(caught.status, 504, 'HTTP 状态码')
    assert(elapsed < 3000, `应在注入的 300ms 超时附近返回，实际 ${elapsed}ms`)
    assert(caught.message.includes('超时'), `消息应说清是超时，实际：${caught.message}`)
  })

  await it('「流内空闲」超时 → `UPSTREAM_TIMEOUT`：响应头已到手、之后一个字节都没有也得断开', async () => {
    const startedAt = Date.now()
    const sink = collector()
    let caught
    try {
      await chatStream(targetAt('/stall'), [{ role: 'user', content: 'hi' }], sink.callbacks, {
        idleTimeoutMs: 300,
      })
    } catch (error) {
      caught = error
    }
    const elapsed = Date.now() - startedAt
    assert(caught !== undefined, '应当抛错')
    assertEqual(caught.code, 'UPSTREAM_TIMEOUT', '错误码')
    assertEqual(caught.status, 504, 'HTTP 状态码')
    assert(elapsed < 3000, `应在注入的 300ms 空闲超时附近返回，实际 ${elapsed}ms`)
    // 已经收到的增量不因断开而丢失（调用方据此决定是否落库）
    assertEqual(sink.deltas.join(''), '开了个头', '超时前收到的增量应已交给回调')
  })

  await it('调用方中断 → `LlmAbortError`（**不是** AppError）：用户点停止不是故障', async () => {
    const controller = new AbortController()
    const sink = collector()
    const original = sink.callbacks.onDelta
    sink.callbacks.onDelta = (text) => {
      original(text)
      controller.abort() // 收到第一个增量就"点停止"
    }
    let caught
    try {
      await chatStream(targetAt('/stream'), [{ role: 'user', content: 'hi' }], sink.callbacks, {
        abortSignal: controller.signal,
      })
    } catch (error) {
      caught = error
    }
    assert(caught !== undefined, '应当抛错')
    assertEqual(caught.name, 'LlmAbortError', '中断应抛 LlmAbortError')
    assert(caught.code === undefined, 'LlmAbortError 不该带领域错误码（F 包据此推 done{STOPPED}）')
    // ⚠️ 这条断言是踩出来的：此刻整个响应很可能**已在一个 TCP 包里缓冲好了**，
    //    光靠"abort 让网络读失败"是收不到效果的 —— 表现为"点了停止，回答还在往外冒"。
    //    实现侧的对策是每帧之前显式查一次信号（`throwIfAborted`）。
    assertEqual(sink.deltas.length, 1, '中断前应只回调了 1 块增量，之后立刻停手')
    assertEqual(sink.deltas.join(''), '你好，', '中断前收到的增量应是第一块')
  })

  // ══════════ 3. 流式：逐块 delta 与边界差异 ══════════
  let streamSummary
  const streamSink = collector()
  await it('chatStream()：逐块收到 delta（≥3 块）、顺序拼接**逐字**等于全文', async () => {
    upstreamRequests.length = 0
    streamSummary = await chatStream(
      targetAt('/stream'),
      [{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }],
      streamSink.callbacks,
    )

    assert(streamSink.deltas.length >= 3, `应至少收到 3 块增量，实际 ${streamSink.deltas.length} 块`)
    assertEqual(streamSink.deltas.join(''), '你好，这是流式回答。', '拼接后的全文（顺序 + 逐字）')
    assertEqual(streamSummary.text, '你好，这是流式回答。', '汇总里的 text')
    assertEqual(streamSummary.deltaCount, 4, '非空增量计数（role-only / choices:[] / 注释行都不该计入）')
    assertEqual(streamSummary.malformedFrames, 0, '不该有畸形帧')
    assertEqual(streamSummary.rawFinishReason, 'stop', 'rawFinishReason')
    assertEqual(streamSummary.usage?.tokensTotal, 15, '最后一帧的 usage 应被采纳')

    const sent = upstreamRequests.find((item) => item.path === '/stream/chat/completions')
    const body = JSON.parse(sent.raw)
    assertEqual(body.stream, true, '请求体 stream')
    assertEqual(body.model, 'unit-model', '请求体 model')
    // ⚠️ 这条是踩过的坑：`stream_options` 是 400 的常见来源，默认**不许**发
    assert(
      !('stream_options' in body),
      `不该默认发送 stream_options（部分网关不认这个字段会直接 400），实际请求体：${sent.raw}`,
    )
  })

  await it('流式的四类真实差异都被收敛：思考增量 / 无 `[DONE]` / 无结尾空行 / 保活帧', () => {
    assertEqual(streamSink.thinking.join(''), '思考中', 'reasoning_content 应归到 thinking')
    assertEqual(streamSummary.deltaCount, 4, '没有 [DONE]、最后帧无空行，也不能少收内容')
    assertEqual(streamSink.usages.length, 1, 'usage 只出现一次就只回调一次')
  })

  await it('上游忽略 `stream: true`（回 JSON）→ 降级成一次性 delta，而不是报错', async () => {
    const sink = collector()
    const summary = await chatStream(targetAt('/json'), [{ role: 'user', content: 'hi' }], sink.callbacks)
    assertEqual(sink.deltas.join(''), '我是被吞掉流的回答', '文本应完整交给回调')
    assertEqual(summary.deltaCount, 1, '降级路径只回调一次')
    assertEqual(summary.rawFinishReason, 'stop', 'rawFinishReason')
  })

  await it('流内出现畸形帧 → 跳过并计数，**不丢**整条回答', async () => {
    // 用一个内联的一次性服务：主线假上游是按固定剧本走的，造不出"半截 JSON"
    const broken = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"cont\n\n') // 被网关截断的 JSON
      res.write(frame({ choices: [{ delta: { content: '照常收到' } }] }))
      res.end()
    })
    await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve))
    const brokenTarget = { ...targetAt(''), baseUrl: `http://127.0.0.1:${broken.address().port}` }
    try {
      const sink = collector()
      const summary = await chatStream(brokenTarget, [{ role: 'user', content: 'hi' }], sink.callbacks)
      assertEqual(summary.malformedFrames, 1, '应统计到 1 个畸形帧')
      assertEqual(sink.deltas.join(''), '照常收到', '坏帧之后的内容仍要完整收到')
    } finally {
      broken.closeAllConnections?.()
      await new Promise((resolve) => broken.close(resolve))
    }
  })

  // ══════════ 4. normalizeRemoteModels 纯函数 ══════════
  await it('`normalizeRemoteModels`：三种形态归一 + 去重 + 按 id 排序（两次调用逐字相同）', () => {
    const standard = normalizeRemoteModels({
      object: 'list',
      data: [{ id: 'b', owned_by: 'x', created: 2 }, { id: 'a' }],
    })
    assertEqual(standard.map((item) => item.id).join(','), 'a,b', '排序后应按 id 升序')
    assertEqual(standard[1].ownedBy, 'x', 'owned_by 应带出来')
    assertEqual(standard[1].created, 2, 'created 应带出来')
    assertEqual(standard[0].ownedBy, null, '缺失字段应为 null 而不是 undefined')

    const alt = normalizeRemoteModels({ models: [{ name: 'qwen2.5:7b' }, { model: 'bge-m3' }] })
    assertEqual(alt.map((item) => item.id).join(','), 'bge-m3,qwen2.5:7b', '`{models:[{name|model}]}` 形态')

    const bare = normalizeRemoteModels(['z', 'a', 'z', { id: 'z' }])
    assertEqual(bare.map((item) => item.id).join(','), 'a,z', '裸数组 + 去重')

    assertEqual(normalizeRemoteModels({}).length, 0, '空对象应得到空列表')
    assertEqual(normalizeRemoteModels(null).length, 0, 'null 应得到空列表')
  })

  // ══════════ 5. B 组：集成（真库 + 真接口）══════════
  const passwordHash = await hashPassword(PASSWORD)
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      nickname: 'LLM 验证管理员',
      passwordHash,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  const member = await prisma.user.create({
    data: {
      username: memberUsername,
      nickname: 'LLM 验证成员',
      passwordHash,
      role: UserRole.MEMBER,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  createdUserIds.push(admin.id, member.id)

  const login = async (username) => {
    const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
    return cookieOf(response)
  }
  const adminCookie = await login(adminUsername)
  const memberCookie = await login(memberUsername)

  /** 通过真接口建 Provider（顺带覆盖 P0-1-10 的 baseUrl 归一化：这里**故意带尾斜杠**） */
  const createProvider = async (name, { path, apiKey }) => {
    const response = await api('POST', '/api/model-providers', {
      cookie: adminCookie,
      payload: {
        name,
        baseUrl: `${upstreamBase}${path}/`, // 尾斜杠会被契约去掉
        type: 'CHAT',
        apiKey,
      },
    })
    assertEqual(response.statusCode, 200, `建 Provider(${name}) 状态码`)
    const data = response.json().data
    createdProviderIds.push(data.id)
    return data
  }
  const createModel = async (providerId, modelName, extra = {}) => {
    const response = await api('POST', '/api/models', {
      cookie: adminCookie,
      payload: { providerId, modelName, label: 'LLM 验证模型', type: 'CHAT', ...extra },
    })
    assertEqual(response.statusCode, 200, `建模型(${modelName}) 状态码`)
    const data = response.json().data
    createdModelIds.push(data.id)
    return data
  }

  const providerWithKey = await createProvider(`LLM 验证上游 ${suffix}`, { path: '/v1', apiKey: SECRET_KEY })
  const providerNoKey = await createProvider(`LLM 验证无 Key 上游 ${suffix}`, { path: '/alt' })
  const providerPlain = await createProvider(`LLM 验证裸数组上游 ${suffix}`, { path: '/plain', apiKey: SECRET_KEY })
  const providerAuthFail = await createProvider(`LLM 验证鉴权失败上游 ${suffix}`, { path: '/authfail', apiKey: SECRET_KEY })
  assertEqual(providerWithKey.baseUrl, `${upstreamBase}/v1`, 'baseUrl 的尾斜杠应被归一化掉')

  const chatModel = await createModel(providerWithKey.id, `verify-llm-chat-${suffix}`)
  const disabledModel = await createModel(providerWithKey.id, `verify-llm-disabled-${suffix}`, { enabled: false })
  const embeddingModel = await createModel(providerWithKey.id, `verify-llm-embed-${suffix}`, { type: 'EMBEDDING' })
  const noKeyModel = await createModel(providerNoKey.id, `verify-llm-nokey-${suffix}`)

  await it('`resolveChatTarget()`：解密 Key 注入上游 —— 假上游收到的正是**明文**（密文只在库里）', async () => {
    upstreamRequests.length = 0
    const target = await resolveChatTarget(chatModel.id)
    assertEqual(target.modelName, chatModel.modelName, 'modelName')
    assertEqual(target.providerName, providerWithKey.name, 'providerName')
    assertEqual(target.baseUrl, `${upstreamBase}/v1`, 'baseUrl')
    assertEqual(target.apiKey, SECRET_KEY, '解密出的明文 Key')
    assertEqual(target.maxContext, null, 'maxContext 透传')

    // 库里存的绝不是明文（与 P0-1-10 同一条不变式，这里顺带守一下）
    const row = await prisma.modelProvider.findUnique({
      where: { id: providerWithKey.id },
      select: { apiKeyEnc: true },
    })
    assert(row?.apiKeyEnc !== null, '库里应有密文')
    assert(!row.apiKeyEnc.includes(SECRET_KEY), '库里不得出现明文 Key')
    assert(/^v1\.[^.]+(\.[^.]+)*\.[^.]+$/.test(row.apiKeyEnc), `密文应是版本化信封，实际：${row.apiKeyEnc}`)

    // 端到端：解析出的 target 真的能调到上游，且带的是解密后的明文
    const result = await chat(target, [{ role: 'user', content: '接通了吗' }], { maxTokens: 1 })
    const sent = upstreamRequests.find((item) => item.path === '/v1/chat/completions')
    assertEqual(sent.auth, `Bearer ${SECRET_KEY}`, '上游侧应看到 Bearer <明文 Key>')
    assertEqual(result.text, '收到了 1 的额度', '回答文本')
  })

  await it('`resolveChatTarget()` 的四道前置校验：404 / 向量模型 409 / 停用模型 409 / 停用 Provider 409 / 无 Key 424', async () => {
    const cases = [
      {
        label: '模型不存在',
        run: () => resolveChatTarget('01a0c289-6738-715c-a10c-ef95c1280000'),
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        label: '向量模型不能用于对话',
        run: () => resolveChatTarget(embeddingModel.id),
        status: 409,
        code: 'CONFLICT',
        fragment: '向量模型',
      },
      {
        label: '模型已停用',
        run: () => resolveChatTarget(disabledModel.id),
        status: 409,
        code: 'CONFLICT',
        fragment: '停用',
      },
      {
        label: 'Provider 未配 Key',
        run: () => resolveChatTarget(noKeyModel.id),
        status: 424,
        code: 'NEED_CREDENTIAL',
        fragment: 'API Key',
      },
    ]
    for (const item of cases) {
      let caught
      try {
        await item.run()
      } catch (error) {
        caught = error
      }
      assert(caught !== undefined, `${item.label}：应当抛错`)
      assertEqual(caught.status, item.status, `${item.label}：状态码`)
      assertEqual(caught.code, item.code, `${item.label}：错误码`)
      if (item.fragment !== undefined) {
        assert(
          caught.message.includes(item.fragment),
          `${item.label}：消息应含「${item.fragment}」，实际：${caught.message}`,
        )
      }
    }

    // Provider 停用：临时停一下再恢复
    const disabled = await api('PATCH', `/api/model-providers/${providerWithKey.id}`, {
      cookie: adminCookie,
      payload: { enabled: false },
    })
    assertEqual(disabled.statusCode, 200, '停用 Provider 状态码')
    let caught
    try {
      await resolveChatTarget(chatModel.id)
    } catch (error) {
      caught = error
    }
    assertEqual(caught?.status, 409, 'Provider 停用时应 409')
    assert(caught.message.includes('Provider'), `消息应点明是 Provider 的问题，实际：${caught.message}`)
    await api('PATCH', `/api/model-providers/${providerWithKey.id}`, {
      cookie: adminCookie,
      payload: { enabled: true },
    })
    assert((await resolveChatTarget(chatModel.id)).apiKey === SECRET_KEY, '恢复后应能正常解析')
  })

  await it('路由 `GET /api/model-providers/:id/remote-models`：200 + 契约 + 上游侧收到 Bearer Key', async () => {
    upstreamRequests.length = 0
    const response = await api('GET', `/api/model-providers/${providerWithKey.id}/remote-models`, {
      cookie: adminCookie,
    })
    assertEqual(response.statusCode, 200, '状态码')
    const parsed = remoteModelListResultSchema.safeParse(response.json().data)
    assert(parsed.success, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    const data = parsed.data
    assertEqual(data.providerName, providerWithKey.name, 'providerName')
    assertEqual(data.baseUrl, `${upstreamBase}/v1`, 'baseUrl 回显（便于核对探的是哪个地址）')
    assertEqual(data.total, 2, '上游条数')
    assertEqual(data.truncated, false, '未截断')
    assertEqual(data.items.map((item) => item.id).join(','), 'bge-m3,gpt-4o-mini', '按 id 排序')
    assertEqual(data.items[1].ownedBy, 'system', 'ownedBy')

    const sent = upstreamRequests.find((item) => item.path === '/v1/models')
    assert(sent !== undefined, '假上游应收到 /v1/models')
    assertEqual(sent.method, 'GET', '方法必须是 GET')
    assertEqual(sent.auth, `Bearer ${SECRET_KEY}`, '探模型列表也要带上解密后的 Key')

    // 密钥零下发：这条响应体里不该出现明文 Key、也不该出现 Bearer
    assert(!response.body.includes(SECRET_KEY), '响应体不得含明文 Key')
    assert(!response.body.includes('Bearer'), '响应体不得含 Authorization 形态的串')
  })

  await it('无 Key 的 Provider：探模型列表照样能成（免鉴权的自建实现），且**不带** Authorization 头', async () => {
    upstreamRequests.length = 0
    const data = await listProviderRemoteModels(providerNoKey.id)
    assertEqual(data.total, 2, 'llama.cpp 形态的 `{models:[...]}` 也应能归一')
    assertEqual(data.items.map((item) => item.id).join(','), 'bge-m3:latest,qwen2.5:7b', '按 id 排序')
    const sent = upstreamRequests.find((item) => item.path === '/alt/models')
    assert(sent !== undefined, '假上游应收到 /alt/models')
    assertEqual(sent.auth, null, '没配 Key 就不该带 Authorization 头（而不是带一个空 Bearer）')
  })

  await it('裸数组形态 + 去重 + 排序（真 HTTP，不是纯函数）', async () => {
    const data = await listProviderRemoteModels(providerPlain.id)
    assertEqual(data.total, 3, '去重后应是 3 条（z-model 出现了两次）')
    assertEqual(data.items.map((item) => item.id).join(','), 'a-model,bare-string-model,z-model', '排序后')
  })

  await it('上游 401（回显 Authorization）→ 502 且消息里**没有明文 Key**；上游 404 → 文案点明"可能不提供列表"', async () => {
    let caught
    try {
      await listProviderRemoteModels(providerAuthFail.id)
    } catch (error) {
      caught = error
    }
    assertEqual(caught?.code, 'UPSTREAM_ERROR', '鉴权失败的错误码')
    assertEqual(caught.status, 502, '鉴权失败的状态码')
    assert(!caught.message.includes(SECRET_KEY), '⚠️ 错误消息必须脱敏（上游把 Authorization 回显进了 body）')

    // 404：给一个不存在的路径（假上游对未知路径回 404）
    const ghost = await createProvider(`LLM 验证缺端点上游 ${suffix}`, { path: '/no-such-endpoint' })
    let notFound
    try {
      await listProviderRemoteModels(ghost.id)
    } catch (error) {
      notFound = error
    }
    assertEqual(notFound?.code, 'UPSTREAM_ERROR', '404 的错误码')
    assert(
      notFound.message.includes('不提供') || notFound.message.includes('手工录入'),
      `404 应给出"该实现可能不提供列表"的可执行提示，实际：${notFound.message}`,
    )
  })

  await it('Provider 不存在 → 404；非 ADMIN / 匿名 → 403 / 401', async () => {
    const ghost = await api('GET', '/api/model-providers/01a0c289-6738-715c-a10c-ef95c1280000/remote-models', {
      cookie: adminCookie,
    })
    assertEqual(ghost.statusCode, 404, '不存在的 Provider')
    assertEqual(ghost.json().code, 'NOT_FOUND', '信封 code')

    const asMember = await api('GET', `/api/model-providers/${providerWithKey.id}/remote-models`, {
      cookie: memberCookie,
    })
    assertEqual(asMember.statusCode, 403, 'MEMBER 应 403')

    const anonymous = await api('GET', `/api/model-providers/${providerWithKey.id}/remote-models`)
    assertEqual(anonymous.statusCode, 401, '匿名应 401')

    const badUuid = await api('GET', '/api/model-providers/not-a-uuid/remote-models', { cookie: adminCookie })
    assertEqual(badUuid.statusCode, 400, '非法 UUID 应 400')
  })

  await it('拉取列表**不落库**（只读探测）：调完之后模型条数一条没变', async () => {
    const before = await prisma.model.count({ where: { providerId: providerWithKey.id } })
    await listProviderRemoteModels(providerWithKey.id)
    const after = await prisma.model.count({ where: { providerId: providerWithKey.id } })
    assertEqual(after, before, '探测动作不得写任何模型（要不要加由管理员决定）')
  })

  await it('`fetchRemoteModels` 也能被 F 包直接调用（不带库、只要 baseUrl + Key）', async () => {
    const result = await fetchRemoteModels({ providerName: '手搓', baseUrl: `${upstreamBase}/v1`, apiKey: null })
    assertEqual(result.total, 2, '条数')
    assertEqual(result.truncated, false, 'truncated')
  })
} finally {
  // ── 清理（顺序是硬要求：Model 先于 Provider；用户之前先删快照）──
  // 一律 `deleteMany`：清理阶段"目标已经不在了"是正常情况，`delete` 会为每条不存在的记录
  // 往日志里丢一坨 P2025 堆栈，把断言结果冲掉（`06` P0-1-6 起"收敛脚本自身日志"的纪律）。
  try {
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    await prisma.model.deleteMany({ where: { modelName: { contains: suffix } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    await prisma.modelProvider.deleteMany({ where: { name: { contains: suffix } } })
    for (const userId of createdUserIds) {
      // `requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s），不显式删就要等窗口过去才算干净
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) {
      await redis.del(sessionKey(sid)).catch(() => undefined)
    }
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
  // 假上游要强制断开（`/slow` 上还挂着一条永不回应的连接）
  upstream.closeAllConnections?.()
  await new Promise((resolve) => upstream.close(resolve))
  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-12 LLM client 验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-12 LLM client 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
