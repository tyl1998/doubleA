#!/usr/bin/env node
/**
 * verify-embedding.mjs —— P0-1-13 的 **embedding 双模式验收**（**不需要 PG/Redis**，可进 CI）
 *
 * 验的是 `06` P0-1-13 的三条验收门槛：
 *   ① 「`EMBEDDING_MODE=api` 时返回 1024 维（或按配置维度）」；
 *   ② 「`local` 时单条 < 500ms（`01` §四）」—— ⚠️ 见下方"本脚本**验不到**什么"；
 *   ③ 「`name()` 能区分两种模式（供换模型检测）」。
 *
 * 三类用例，对应 `02` §八 的分层：
 *   · **A 组 · api 模式**：起一个**真 HTTP** 假上游（`http.createServer` + 端口 0；
 *     与 P0-1-12 的假上游同款做法），在**上游侧取证**报文形状（批 32 / 不发多余字段 /
 *     Authorization 是解密后的明文），并覆盖 index 归位、条数不符、维度不符、401 脱敏、
 *     超时、200 里藏 error、四种响应形态归一。
 *   · **B 组 · local 模式**：就绪自检三态、worker 线程隔离（`threadId` 取证）、批 32、
 *     维度校验、运行时抛错后仍可用、`dispose()` 后能重新懒加载。
 *     ⚠️ **onnx 推理本身不在这里验**（模型文件未就位，见 `06` §七 待决事项 2）：本组注入一个
 *     **临时的 stub 运行时模块**，验的是"缝能不能插上、线程是不是真的独立、契约有没有被遵守"。
 *     真模型的性能与精度要靠"模型就位后补验"（本脚本届时只需把 stub 换成真模块）。
 *   · **C 组 · 工厂与配置**：用**子进程**注入环境变量，验 `EMBEDDING_MODE` 切换真的把配置
 *     接到了对的 provider 上（不依赖本机 `infra/.env` 当前是什么状态），并验"未就绪就硬报错"
 *     （`config.ts` 承诺 P0-1-3 只 WARN、硬要求落在 P0-1-13 的 provider 初始化）。
 *
 * 为什么不需要依赖：本批**没有新增 HTTP 路由**，provider 也不碰数据库（真正落库是 D 包）。
 */

// 必须在 import `config.js`（经 dist 的 provider）之前设置：脚本会打一堆"应当失败"的请求，
// 每个都留一条 warn 会把断言输出冲掉。看细节时：`LOG_LEVEL=debug pnpm verify:embedding`。
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { threadId as mainThreadId } from 'node:worker_threads'

const {
  ApiEmbeddingProvider,
  LocalEmbeddingProvider,
  embeddingReadiness,
  localEmbeddingProblems,
  readEmbeddingPayload,
  resetEmbeddingProvider,
} = await import('../dist/backend/src/llm/embedding/index.js')

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

/** 期望抛错并取回它（断言 code/status/文案用） */
async function catchError(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('应当抛错，但没有')
}

// ───────────────────────────── 常量 ─────────────────────────────

const DIM = 1024
const BATCH = 32
const SECRET_KEY = 'sk-verify-embedding-0123456789abcdef'
const API_MODEL = 'verify-embedding-model'

// ───────────────────────────── 假上游（真 HTTP 服务，端口 0）─────────────────────────────

const upstreamRequests = []

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 从文本 `t<i>` 里取回序号 —— 用来断言**顺序**（跨批拼接 + index 归位两件事一起验） */
function seqOf(text) {
  const match = /^t(\d+)$/.exec(text)
  return match === null ? -1 : Number(match[1])
}

/** 造一条"能认出自己是谁"的向量：第 0 位放序号，其余放 0.5（维度由调用方给） */
function vectorFor(text, dim) {
  const vector = new Array(dim).fill(0.5)
  vector[0] = seqOf(text)
  return vector
}

/** 标准形态：`{data:[{embedding,index}]}`，且**故意倒序**返回（真实现常乱序） */
function standardShape(input, dim) {
  const rows = input.map((text, index) => ({ embedding: vectorFor(text, dim), index }))
  return { object: 'list', model: API_MODEL, data: rows.reverse(), usage: { prompt_tokens: 7, total_tokens: 7 } }
}

const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const piece of req) chunks.push(piece)
  const raw = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const auth = req.headers.authorization ?? null
  upstreamRequests.push({ method: req.method, path: url.pathname, auth, raw })
  const body = raw === '' ? {} : JSON.parse(raw)
  const input = Array.isArray(body.input) ? body.input : []

  if (url.pathname === '/v1/embeddings') return json(res, 200, standardShape(input, DIM))
  if (url.pathname === '/noidx/embeddings') {
    // 不带 index：只能按顺序（顺序也是官方保证的一种形态）
    return json(res, 200, { data: input.map((text) => ({ embedding: vectorFor(text, DIM) })) })
  }
  if (url.pathname === '/plain/embeddings') {
    // `data` 里直接放数组
    return json(res, 200, { data: input.map((text) => vectorFor(text, DIM)) })
  }
  if (url.pathname === '/legacy/embeddings') {
    // ollama 原生形态 `{embeddings: [[...]]}`
    return json(res, 200, { embeddings: input.map((text) => vectorFor(text, DIM)) })
  }
  if (url.pathname === '/short/embeddings') {
    // 少回一条（该实现其实不支持批量）
    return json(res, 200, { data: [{ embedding: vectorFor(input[0] ?? 't0', DIM), index: 0 }] })
  }
  if (url.pathname === '/baddim/embeddings') {
    return json(res, 200, { data: input.map((text, index) => ({ embedding: vectorFor(text, 768), index })) })
  }
  if (url.pathname === '/badindex/embeddings') {
    // index 不是 0..n-1 的排列（比如按 id 返回）—— 无法安全归位，必须报错
    return json(res, 200, { data: input.map((text, index) => ({ embedding: vectorFor(text, DIM), index: index + 10 })) })
  }
  if (url.pathname === '/nan/embeddings') {
    return json(res, 200, { data: [{ embedding: [1, 'x', 3], index: 0 }] })
  }
  if (url.pathname === '/error200/embeddings') return json(res, 200, { error: { message: 'quota exceeded' } })
  if (url.pathname === '/notjson/embeddings') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<html>502 Bad Gateway</html>')
  }
  if (url.pathname === '/unauth/embeddings') {
    // 401 且把 Authorization 回显进 body —— 我们的错误消息必须脱敏
    return json(res, 401, { error: { message: `invalid api key: ${auth ?? '(none)'}` } })
  }
  if (url.pathname === '/slow/embeddings') return // 永不响应，验超时
  return json(res, 404, { error: { message: `no such path: ${url.pathname}` } })
})

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`

/** 造一个指向假上游某条路径的 api provider（`apiUrl` 必须是不带尾斜杠的 baseUrl） */
function apiAt(path, overrides = {}) {
  return new ApiEmbeddingProvider({
    apiUrl: `${upstreamBase}${path}`,
    apiKey: SECRET_KEY,
    apiModel: API_MODEL,
    dim: DIM,
    batchSize: BATCH,
    ...overrides,
  })
}

const textsOf = (count) => Array.from({ length: count }, (_value, index) => `t${index}`)

// ───────────────────────────── B 组用：临时 stub 运行时 + 模型目录 ─────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'doubulea-embedding-'))
const modelDir = join(workDir, 'bge-m3-int8')
const runtimeStubPath = join(workDir, 'runtime-stub.mjs')
const runtimeLogPath = join(workDir, 'runtime-calls.jsonl')

mkdirSync(modelDir, { recursive: true })
writeFileSync(join(modelDir, 'model.onnx'), '') // 就绪自检要求目录里有 .onnx（内容不参与本脚本）

/**
 * stub 运行时：**只在线程里跑**。它把每次调用追加进一个 JSONL 日志（主线程稍后读它取证），
 * 并把 `threadId` 报回去 —— 那是"真的跑在独立线程里"的唯一可信证据。
 * `STUB_MODE` 环境变量由脚本在起 worker 前设置（worker 继承父进程环境）。
 */
writeFileSync(
  runtimeStubPath,
  `import { appendFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

const LOG = ${JSON.stringify(runtimeLogPath)}
const mode = process.env.STUB_MODE ?? 'ok'
const log = (entry) => appendFileSync(LOG, JSON.stringify({ ...entry, threadId }) + '\\n')

export function createEmbedder({ modelPath, dim }) {
  log({ event: 'create', modelPath, dim, mode })
  return {
    // 'dim' 模式：自报一个与 EMBEDDING_DIM 不符的维度（init 时就必须报错）
    dim: mode === 'dim' ? 768 : dim,
    describe: () => ({ stubMode: mode, stubModelPath: modelPath }),
    async embed(texts) {
      log({ event: 'embed', size: texts.length, texts })
      if (mode === 'throw' || texts.includes('__throw__')) throw new Error('推理失败（stub 模拟）')
      if (mode === 'short' || texts.includes('__short__')) return [new Array(dim).fill(0)]
      if (mode === 'wrongdim') return texts.map(() => new Array(768).fill(0))
      return texts.map((text) => {
        const seq = /^t(\\d+)$/.exec(text)
        const vector = new Array(dim).fill(0.5)
        vector[0] = seq === null ? -1 : Number(seq[1])
        return vector
      })
    },
    async dispose() {
      log({ event: 'dispose' })
    },
  }
}
`,
)

function localProviderWith(overrides = {}) {
  return new LocalEmbeddingProvider({
    modelPath: modelDir,
    runtimeModule: runtimeStubPath,
    dim: DIM,
    batchSize: BATCH,
    ...overrides,
  })
}

/** 读 stub 在线程里写下的调用流水（只取"本次"新增的部分） */
function readRuntimeLog() {
  if (!existsSync(runtimeLogPath)) return []
  return readFileSync(runtimeLogPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

function logLength() {
  return readRuntimeLog().length
}

// ───────────────────────────── 开跑 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-13 embedding 双模式验收：api 报文 / local worker / 工厂接线 ══${c.x}`)
console.log(`  ${c.d}假上游：${upstreamBase}（真 HTTP 服务，端口 0）｜ stub 运行时：${runtimeStubPath}${c.x}`)
console.log(`  ${c.d}主线程 threadId=${mainThreadId}（local 组要证明推理**不在**这个线程里跑）${c.x}`)

try {
  // ══════════════════════════ A 组：api 模式 ══════════════════════════
  console.log(`\n${c.b}── A 组 · api 模式（真 HTTP 假上游）──${c.x}`)

  await it('api：40 条文本 → 2 次请求（批 32 + 8），报文只有 `model`/`input`，Authorization 是明文 Key', async () => {
    upstreamRequests.length = 0
    const vectors = await apiAt('/v1').embed(textsOf(40))

    const sent = upstreamRequests.filter((item) => item.path === '/v1/embeddings')
    assertEqual(sent.length, 2, '请求次数（40 条 / 批 32）')
    const sizes = sent.map((item) => JSON.parse(item.raw).input.length)
    assertEqual(sizes.join('+'), '32+8', '每批的条数')
    for (const item of sent) {
      const body = JSON.parse(item.raw)
      assertEqual(
        Object.keys(body).sort().join(','),
        'input,model',
        `请求体只应有 model/input（不发 encoding_format/dimensions/user —— 它们都有"某类网关不认就 400"的记录），实际：${item.raw.slice(0, 200)}`,
      )
      assertEqual(body.model, API_MODEL, '请求体 model 取的是配置里的 EMBEDDING_API_MODEL')
      assertEqual(item.method, 'POST', '方法')
      assertEqual(item.auth, `Bearer ${SECRET_KEY}`, 'Authorization 头')
    }
    assertEqual(vectors.length, 40, '向量条数')
  })

  await it('api：返回**乱序** `data` 也能按 `index` 归位；跨批拼接顺序逐条正确；维度 = 1024', async () => {
    const vectors = await apiAt('/v1').embed(textsOf(40))
    for (const [position, vector] of vectors.entries()) {
      assertEqual(vector.length, DIM, `第 ${position} 条的维度`)
      assertEqual(vector[0], position, `第 ${position} 条的"身份位"（乱序返回 + 跨批拼接都靠它验）`)
    }
  })

  await it('api：四种响应形态都归一（带/不带 index、`data` 放数组、ollama 的 `{embeddings}`）', async () => {
    for (const path of ['/v1', '/noidx', '/plain', '/legacy']) {
      const vectors = await apiAt(path).embed(textsOf(3))
      assertEqual(vectors.length, 3, `${path} 的条数`)
      assertEqual(
        vectors.map((vector) => vector[0]).join(','),
        '0,1,2',
        `${path} 的顺序（这个形态没归位，说明解析漏了一种）`,
      )
    }
  })

  await it('api：`input: []` 不发任何请求（"没有文本"不是错误）', async () => {
    upstreamRequests.length = 0
    const vectors = await apiAt('/v1').embed([])
    assertEqual(vectors.length, 0, '空输入应得空数组')
    assertEqual(upstreamRequests.length, 0, '不该为了空输入打上游（有的实现会对 input:[] 回 400）')
  })

  await it('api：上游少回一条 → 502 且文案指向"该实现可能不支持批量"', async () => {
    const error = await catchError(() => apiAt('/short').embed(textsOf(5)))
    assertEqual(error.code, 'UPSTREAM_ERROR', '错误码')
    assertEqual(error.status, 502, 'HTTP 状态码')
    assert(error.message.includes('条数与输入不符'), `消息应点明条数不符，实际：${error.message}`)
    assert(error.message.includes('EMBEDDING_BATCH_SIZE'), `应给出可执行的下一步，实际：${error.message}`)
  })

  await it('api：上游回 768 维 → 502 且点明与 `vector(1024)` 不符（维度不符绝不写库）', async () => {
    const error = await catchError(() => apiAt('/baddim').embed(textsOf(1)))
    assertEqual(error.code, 'UPSTREAM_ERROR', '错误码')
    assert(error.message.includes('768'), `消息应带上游真实维度，实际：${error.message}`)
    assert(error.message.includes(`${DIM}`), '消息应带配置维度')
    assert(error.message.includes('子方案'), `应指回设计文档，实际：${error.message}`)
  })

  await it('api：`index` 不是 0..n-1 的排列 → 502（宁可报错也不猜顺序）', async () => {
    const error = await catchError(() => apiAt('/badindex').embed(textsOf(2)))
    assertEqual(error.code, 'UPSTREAM_ERROR', '错误码')
    assert(error.message.includes('排列'), `消息应说清归位失败，实际：${error.message}`)
  })

  await it('api：向量里含非数字 → 502（NaN 进了向量列，检索会得到莫名其妙的结果）', async () => {
    const error = await catchError(() => apiAt('/nan').embed(textsOf(1)))
    assertEqual(error.code, 'UPSTREAM_ERROR', '错误码')
    assert(error.message.includes('非数字'), `消息应点明元素非法，实际：${error.message}`)
  })

  await it('api：401（回显 Authorization）→ 502 且消息里**没有明文 Key**', async () => {
    const error = await catchError(() => apiAt('/unauth').embed(textsOf(1)))
    assertEqual(error.code, 'UPSTREAM_ERROR', '错误码')
    assertEqual(error.status, 502, '状态码')
    assertEqual(error.data?.upstreamStatus, 401, 'data 里带上游状态码')
    assert(error.message.includes('检查该 Provider 的 API Key'), `应给出凭据提示，实际：${error.message}`)
    assert(!error.message.includes(SECRET_KEY), '⚠️ 上游把 Key 回显进了 body，错误消息必须脱敏')
    assert(error.message.includes('****'), `脱敏后应留痕迹，实际：${error.message}`)
  })

  await it('api：200 里藏 `{error}` / 回非 JSON / 上游 404 → 都归成 502 而不是"算了个空"', async () => {
    const cases = [
      ['/error200', 'quota exceeded'],
      ['/notjson', '不是合法 JSON'],
    ]
    for (const [path, fragment] of cases) {
      const error = await catchError(() => apiAt(path).embed(textsOf(1)))
      assertEqual(error.code, 'UPSTREAM_ERROR', `${path} 错误码`)
      assert(error.message.includes(fragment), `${path} 的消息应含「${fragment}」，实际：${error.message}`)
    }
    const notFound = await catchError(() => apiAt('/no-such').embed(textsOf(1)))
    assertEqual(notFound.status, 502, '404 也归成 502（上游不可用）')
  })

  await it('api：超时 → `UPSTREAM_TIMEOUT`(504)，且**不等**满配置值就返回', async () => {
    const startedAt = Date.now()
    const error = await catchError(() => apiAt('/slow', { timeoutMs: 300 }).embed(textsOf(1)))
    const elapsed = Date.now() - startedAt
    assertEqual(error.code, 'UPSTREAM_TIMEOUT', '错误码')
    assertEqual(error.status, 504, '状态码')
    assert(elapsed < 3000, `应在注入的 300ms 超时附近返回，实际 ${elapsed}ms`)
    assert(error.message.includes('超时'), `消息应说清是超时，实际：${error.message}`)
  })

  await it('api：`name()` = `api:<EMBEDDING_API_MODEL>`、`dim()` = 配置维度（供换模型检测）', () => {
    const provider = apiAt('/v1')
    assertEqual(provider.name(), `api:${API_MODEL}`, 'name()')
    assertEqual(provider.dim(), DIM, 'dim()')
  })

  await it('`readEmbeddingPayload` 纯函数：空 data / 无向量 → 502（不是静默返回空数组）', () => {
    const endpoint = { providerName: 'P', subject: 'M', baseUrl: upstreamBase, apiKey: null }
    for (const payload of [{}, { data: [] }, { data: [{ index: 0 }] }, null, 'x']) {
      let caught
      try {
        readEmbeddingPayload(payload, endpoint, 1, DIM)
      } catch (error) {
        caught = error
      }
      assert(caught !== undefined, `${JSON.stringify(payload)} 应当抛错（否则调用方会拿到空向量）`)
      assertEqual(caught.code, 'UPSTREAM_ERROR', '错误码')
    }
  })

  // ══════════════════════════ B 组：local 模式 ══════════════════════════
  console.log(`\n${c.b}── B 组 · local 模式（worker_threads + stub 运行时）──${c.x}`)

  await it('local：就绪自检三态各自给出**可执行**的文案（目录不存在 / 没有 onnx / 没配运行时）', () => {
    const base = { modelPath: modelDir, runtimeModule: runtimeStubPath, dim: DIM, batchSize: BATCH }
    assertEqual(localEmbeddingProblems(base).length, 0, '就绪时不该有问题')

    const missingDir = localEmbeddingProblems({ ...base, modelPath: join(workDir, 'not-here') })
    assertEqual(missingDir.length, 1, '目录不存在应给 1 条')
    assert(missingDir[0].includes('LOCAL_EMBEDDING_MODEL_PATH'), `应点出配置项名，实际：${missingDir[0]}`)
    assert(missingDir[0].includes('EMBEDDING_MODE=api'), `应给出退路（先用 api 模式），实际：${missingDir[0]}`)

    const emptyDir = join(workDir, 'empty-model')
    mkdirSync(emptyDir, { recursive: true })
    const noOnnx = localEmbeddingProblems({ ...base, modelPath: emptyDir })
    assert(noOnnx.some((item) => item.includes('.onnx')), `目录里没有 onnx 要说清，实际：${noOnnx.join('；')}`)

    const noRuntime = localEmbeddingProblems({ ...base, runtimeModule: null })
    assert(
      noRuntime.some((item) => item.includes('LOCAL_EMBEDDING_RUNTIME_MODULE')),
      `没配运行时要说清，实际：${noRuntime.join('；')}`,
    )
  })

  await it('local：未就绪时 `embed()` 直接报错（不会先去起线程再炸一个 ENOENT）', async () => {
    const provider = localProviderWith({ runtimeModule: null })
    const error = await catchError(() => provider.embed(textsOf(1)))
    assertEqual(error.code, 'INTERNAL', '错误码')
    assert(error.message.includes('未就绪'), `消息应说清未就绪，实际：${error.message}`)
    assert(error.message.includes('LOCAL_EMBEDDING_RUNTIME_MODULE'), '消息应点名缺失的配置项')

    const noModel = localProviderWith({ modelPath: join(workDir, 'not-here') })
    const second = await catchError(() => noModel.embed(textsOf(1)))
    assert(second.message.includes('模型目录不存在'), `另一种未就绪状态，实际：${second.message}`)
  })

  await it('local：40 条 → worker 侧正好 2 批（32+8），返回值逐条有序、每条 1024 维', async () => {
    const before = logLength()
    const provider = localProviderWith()
    try {
      const vectors = await provider.embed(textsOf(40))
      const calls = readRuntimeLog().slice(before)
      const creates = calls.filter((entry) => entry.event === 'create')
      const embeds = calls.filter((entry) => entry.event === 'embed')
      assertEqual(creates.length, 1, '应只加载一次运行时（懒加载 + 只建一个线程）')
      assertEqual(embeds.length, 2, '推理调用次数')
      assertEqual(embeds.map((entry) => entry.size).join('+'), '32+8', '每批的条数（EMBEDDING_BATCH_SIZE）')

      assertEqual(vectors.length, 40, '向量条数')
      for (const [position, vector] of vectors.entries()) {
        assertEqual(vector.length, DIM, `第 ${position} 条的维度`)
        assertEqual(vector[0], position, `第 ${position} 条的"身份位"（顺序）`)
      }
    } finally {
      await provider.dispose()
    }
  })

  await it('local：推理**真的**跑在独立线程里（stub 报回的 `threadId` ≠ 主线程）', async () => {
    const before = logLength()
    const provider = localProviderWith()
    try {
      await provider.embed(textsOf(1))
      const calls = readRuntimeLog().slice(before)
      const threadIds = new Set(calls.map((entry) => entry.threadId))
      assertEqual(threadIds.size, 1, '所有流水应来自同一个线程')
      const workerThreadId = [...threadIds][0]
      assert(workerThreadId !== mainThreadId, `⚠️ 推理跑在主线程里了（threadId=${workerThreadId}）—— CPU 密集会阻塞在线请求`)
      assertEqual(calls[0].event, 'create', '第一件事应是加载运行时')
      assertEqual(calls[0].modelPath, modelDir, '运行时拿到的 modelPath 应是配置里的目录')
      assertEqual(calls[0].dim, DIM, '运行时拿到的 dim 应是 EMBEDDING_DIM')
    } finally {
      await provider.dispose()
    }
  })

  await it('local：运行时自报维度与 `EMBEDDING_DIM` 不符 → init 就报错（一分钟都别跑）', async () => {
    process.env.STUB_MODE = 'dim'
    const provider = localProviderWith()
    try {
      const error = await catchError(() => provider.embed(textsOf(1)))
      assertEqual(error.code, 'INTERNAL', '错误码')
      assert(error.message.includes('768'), `消息应带自报维度，实际：${error.message}`)
      assert(error.message.includes('不一致'), `消息应说清不一致，实际：${error.message}`)
    } finally {
      delete process.env.STUB_MODE
      await provider.dispose()
    }
  })

  await it('local：返回维度不符 / 条数不符 → 明确报错（不把坏向量交给上层）', async () => {
    process.env.STUB_MODE = 'wrongdim'
    const wrongDim = localProviderWith()
    try {
      const error = await catchError(() => wrongDim.embed(textsOf(1)))
      assertEqual(error.code, 'INTERNAL', '错误码')
      assert(error.message.includes('768'), `应带上真实维度，实际：${error.message}`)
      assert(error.message.includes('vector('), `应指向 DDL 口径，实际：${error.message}`)
    } finally {
      await wrongDim.dispose()
    }

    process.env.STUB_MODE = 'short'
    const short = localProviderWith()
    try {
      const error = await catchError(() => short.embed(textsOf(3)))
      assert(error.message.includes('条数'), `应点明条数不符，实际：${error.message}`)
    } finally {
      delete process.env.STUB_MODE
      await short.dispose()
    }
  })

  await it('local：某一次推理抛错 → 该次报错，但线程与运行时可继续用（后面的调用照常成功）', async () => {
    const provider = localProviderWith()
    try {
      await provider.embed(textsOf(1)) // 先建立线程
      const error = await catchError(() => provider.embed(['__throw__']))
      assertEqual(error.code, 'INTERNAL', '错误码')
      assert(error.message.includes('推理失败（stub 模拟）'), `应带上运行时的原始信息，实际：${error.message}`)

      const vectors = await provider.embed(textsOf(2))
      assertEqual(vectors.length, 2, '一次推理失败不该把线程带走（否则整份文档都白算了）')
    } finally {
      await provider.dispose()
    }
  })

  await it('local：`name()` = `local:<模型目录名>`，与 api 的 `name()` **不同**（换模型检测的基础）', async () => {
    const local = localProviderWith()
    const api = apiAt('/v1')
    try {
      assertEqual(local.name(), 'local:bge-m3-int8', 'local 的 name()')
      assert(local.name() !== api.name(), `两种模式的 name() 必须能区分，实际都是 ${local.name()}`)
      assertEqual(local.dim(), DIM, 'dim()')
    } finally {
      await local.dispose()
    }
  })

  await it('local：`dispose()` 之后再 `embed()` 能重新懒加载（线程与运行时都重建）', async () => {
    const before = logLength()
    const provider = localProviderWith()
    try {
      await provider.embed(textsOf(1))
      await provider.dispose()
      const afterDispose = readRuntimeLog().slice(before)
      assert(afterDispose.some((entry) => entry.event === 'dispose'), 'dispose 应传到运行时（先让它释放 onnx 会话）')

      const vectors = await provider.embed(textsOf(2))
      assertEqual(vectors.length, 2, 'dispose 之后应能重新起来')
      const creates = readRuntimeLog().slice(before).filter((entry) => entry.event === 'create')
      assertEqual(creates.length, 2, '应是"重新加载"（第二次 create），而不是继续用已经释放的会话')
    } finally {
      await provider.dispose()
    }
  })

  await it('local：worker 入口在**构建产物**里存在（dist 与源码两种形态都能被找到）', () => {
    assert(
      existsSync(new URL('../dist/backend/src/llm/embedding/embedding.worker.js', import.meta.url)),
      'dist 里没有 embedding.worker.js —— 构建产物不完整（local 模式会起不来线程）',
    )
  })

  // ══════════════════════════ C 组：工厂与配置 ══════════════════════════
  console.log(`\n${c.b}── C 组 · 工厂与配置（子进程注入环境变量，与 .env 当前状态解耦）──${c.x}`)

  /**
   * 在子进程里跑一段脚本（继承父进程环境）并解析它打印的 JSON。
   *
   * 为什么要子进程：`config` 是**启动期一次读定**的单例，同一个进程里换不了 `EMBEDDING_MODE`；
   * 而"切换真的把配置接到了对的 provider 上"必须真跑一次才算验过。
   *
   * ⚠️ 必须用**异步**的 `spawn` 而不是 `spawnSync`（踩过）：本脚本的假上游就跑在父进程里，
   *    同步等待子进程会把父进程的事件循环钉住 —— 子进程发出的请求永远等不到响应，
   *    症状是"明明配对了地址却报 30 秒超时"。
   */
  function spawnChild(env, body) {
    const code = `
      process.env.LOG_LEVEL = 'error'
      const embedding = await import('./dist/backend/src/llm/embedding/index.js')
      const report = await (async () => { ${body} })()
      console.log(JSON.stringify(report))
    `
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        // 子进程的 cwd = backend/（`dist/...` 的相对路径与 npm script 跑时一致）
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
  }

  async function runChild(env, body) {
    const result = await spawnChild(env, body)
    assertEqual(result.status, 0, `子进程应正常退出（stderr：${result.stderr.slice(0, 800)}）`)
    const line = result.stdout
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item.startsWith('{'))
      .pop()
    assert(line !== undefined, `子进程没有输出 JSON，stdout=${result.stdout.slice(0, 500)}`)
    return JSON.parse(line)
  }

  await it('工厂：`EMBEDDING_MODE=api` 但三项未配 → 就绪自检为 false，取用时**硬报错**并列出缺项', async () => {
    const report = await runChild(
      { EMBEDDING_MODE: 'api', EMBEDDING_API_URL: '', EMBEDDING_API_KEY: '', EMBEDDING_API_MODEL: '' },
      `
        const readiness = embedding.embeddingReadiness()
        let thrown = null
        try { embedding.getEmbeddingProvider() } catch (error) { thrown = { code: error.code, message: error.message } }
        return { ready: readiness.ready, problems: readiness.problems, name: readiness.name, thrown }
      `,
    )
    assertEqual(report.ready, false, '就绪自检')
    assertEqual(report.name, null, '未就绪时给不出可信的 name')
    assert(report.problems[0].includes('EMBEDDING_API_URL'), `问题清单应点出缺什么，实际：${report.problems[0]}`)
    assertEqual(report.thrown?.code, 'INTERNAL', '取用时应当硬报错')
    assert(report.thrown.message.includes('未就绪'), `消息应说清未就绪，实际：${report.thrown.message}`)
  })

  await it('工厂：`EMBEDDING_MODE=api` 配齐 → 接上 `ApiEmbeddingProvider` 并真的能算（配置接线端到端）', async () => {
    const report = await runChild(
      {
        EMBEDDING_MODE: 'api',
        EMBEDDING_API_URL: `${upstreamBase}/v1`,
        EMBEDDING_API_KEY: SECRET_KEY,
        EMBEDDING_API_MODEL: API_MODEL,
      },
      `
        const readiness = embedding.embeddingReadiness()
        const provider = embedding.getEmbeddingProvider()
        const same = provider === embedding.getEmbeddingProvider()
        const vectors = await provider.embed(['t0', 't1'])
        return {
          ready: readiness.ready,
          name: provider.name(),
          dim: provider.dim(),
          readinessName: readiness.name,
          isApi: provider instanceof embedding.ApiEmbeddingProvider,
          memoized: same,
          first: vectors[0][0],
          count: vectors.length,
        }
      `,
    )
    assertEqual(report.ready, true, '就绪自检')
    assertEqual(report.isApi, true, '应当接上 api provider')
    assertEqual(report.name, `api:${API_MODEL}`, 'name() 应来自配置')
    assertEqual(report.readinessName, `api:${API_MODEL}`, '就绪自检的 name 应与实际用的一致（换模型检测靠它）')
    assertEqual(report.dim, DIM, 'dim()')
    assertEqual(report.memoized, true, '同一进程里应记忆化（不重复建）')
    assertEqual(report.count, 2, '真的算出了向量（说明 apiUrl/key/model 三项都接对了）')
    assertEqual(report.first, 0, '第 0 条的身份位')
  })

  await it('工厂：`EMBEDDING_MODE=local` 配齐（模型目录 + stub 运行时）→ 接上 `LocalEmbeddingProvider` 并能算', async () => {
    const report = await runChild(
      {
        EMBEDDING_MODE: 'local',
        LOCAL_EMBEDDING_MODEL_PATH: modelDir,
        LOCAL_EMBEDDING_RUNTIME_MODULE: runtimeStubPath,
        EMBEDDING_BATCH_SIZE: '2',
      },
      `
        const readiness = embedding.embeddingReadiness()
        const provider = embedding.getEmbeddingProvider()
        const vectors = await provider.embed(['t0', 't1', 't2'])
        await embedding.resetEmbeddingProvider()
        return {
          ready: readiness.ready,
          name: provider.name(),
          dim: provider.dim(),
          isLocal: provider instanceof embedding.LocalEmbeddingProvider,
          count: vectors.length,
          seq: vectors.map((vector) => vector[0]).join(','),
        }
      `,
    )
    assertEqual(report.ready, true, '就绪自检')
    assertEqual(report.isLocal, true, '应当接上 local provider')
    assertEqual(report.name, 'local:bge-m3-int8', 'name() 应来自模型目录名')
    assertEqual(report.dim, DIM, 'dim()')
    assertEqual(report.count, 3, '真的算出了向量（说明 modelPath/runtimeModule 都接对了）')
    assertEqual(report.seq, '0,1,2', '顺序')
  })

  await it('工厂：本进程当前配置（来自 `infra/.env`）的就绪结论可打印，且 `resetEmbeddingProvider()` 无副作用', async () => {
    const readiness = embeddingReadiness()
    console.log(
      `         ${c.d}本机 .env：EMBEDDING_MODE=${readiness.mode} ready=${readiness.ready}` +
        `${readiness.problems.length > 0 ? `（${readiness.problems[0].slice(0, 60)}…）` : ''}${c.x}`,
    )
    assertEqual(typeof readiness.mode, 'string', 'mode 应是字符串')
    assertEqual(readiness.dim, 1024, 'EMBEDDING_DIM 默认 1024（与 chunks.embedding 的 vector(1024) 一致）')
    await resetEmbeddingProvider()
    await resetEmbeddingProvider() // 幂等
  })
} finally {
  // ── 清理：假上游要强制断开（`/slow` 上挂着永不回应的连接），临时目录整体删掉 ──
  upstream.closeAllConnections?.()
  await new Promise((resolve) => upstream.close(resolve))
  await resetEmbeddingProvider().catch(() => undefined)
  rmSync(workDir, { recursive: true, force: true })
  // 复核残留（`06` P0-1-6 起的纪律：清理后要实测，不留"看起来干净"）
  const leftover = existsSync(workDir)
  console.log(`  ${leftover ? c.r : c.d}清理复核：临时目录 ${workDir} ${leftover ? '仍存在' : '已删除'}${c.x}`)
}

console.log('')
if (failed === 0 && !existsSync(workDir)) {
  console.log(`${c.g}${c.b}✅ P0-1-13 embedding 双模式验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-13 embedding 双模式验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
