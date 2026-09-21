#!/usr/bin/env node
/**
 * verify-pipeline.mjs —— P0-1-17 的**异步队列 + 状态机 + worker 骨架**验收
 *
 * 对 `docs/06` 该批的三条验收逐条落成可执行断言：
 *   ① 上传后立即返回 docId 且 `status=PARSING`（→ C 组）
 *   ② worker 消费后转 `READY`/`FAILED`（→ C 组成功路、F 组失败路）
 *   ③ 重复投递同一 job 不产生重复处理（→ D 组；本批还没有 chunk，所以把"不产生重复 chunk"
 *      落成更严的等价物：**一个字节都不写库** + 阶段**只跑一次**）
 * `docs/06` 的坑预判（"List 无 ack ⇒ 必须有重试入口"）也在这里取证：F 组证明
 * **重投同一个 job 能把 FAILED 救回 READY**，这就是那条"重试入口"在协议层的最小形态。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 分八组，各自守一件容易做错的事
 * ─────────────────────────────────────────────────────────────────────
 * A 组 **纯函数**（不需要服务）：job 编解码往返 + 非法 payload + 状态机转换矩阵。
 *    "READY 不得被打回 FAILED"这条不变式只有这一组能守（HTTP 层永远看不到它）。
 * B 组 **队列语义**（需 Redis）：入队/取件/超时/垃圾值；以及**阻塞读不占用共享连接**
 *    （这条是本批唯一一个"不做就会把整个后端拖慢"的实现选择，见 `infra/redis.ts`）。
 * C 组 **端到端（真阶段）**：四格式上传 → 入队 → worker 消费 → `READY`。
 * D 组 **幂等**：并发重复投递 / 已 READY 再投 / 过期 job / 文档已删 —— 四种跳过各自不写库。
 * E 组 **并发闸**：8 个慢任务，峰值并发恰为 2，且总耗时说明真的分批而不是全放行。
 * F 组 **失败与重试**：S3 对象缺失 → `FAILED` + 可读 `error_msg`；补回对象并重投 → 回到 `READY`。
 * G 组 **上传与入队的原子性**（子进程 A/B 对照）：真 Redis 成功 / 死 Redis 失败且**整次上传回滚**。
 * H 组 **自清理 + 残留复核**：删库后 DB 与 S3 双清、队列键不残留、会话与快照归零。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处注入，都是为了让断言有真假之分
 * ─────────────────────────────────────────────────────────────────────
 * · `PIPELINE_QUEUE_KEY=verify:pipeline:jobs:<随机>` —— **必须**换一条队列：本机 Redis 是共享的，
 *   若沿用默认键，跑着的 dev server（它也有 worker）会把本脚本投的 job 抢走，症状是"时好时坏"。
 * · `EMBEDDING_MODE=api` 三项 —— 建库要取 `EmbeddingProvider.name()` 快照（P0-1-14/15 定案）。
 *   URL 指向 `127.0.0.1:1`（永不会被访问：本批不触发 embedding，那是 P0-1-19）。
 * · `LOG_LEVEL=fatal` —— 本脚本会**故意**制造三处故障（F 组的对象丢失与对象被换、G 组的死 Redis），
 *   而 worker 对每次处理失败都会打一条带堆栈的 error。不收的话，十几行堆栈会把断言清单冲散
 *   （`06` P0-1-6 定案的"收敛脚本自身日志"）。要看细节：`LOG_LEVEL=debug pnpm verify:pipeline`。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`（PG + Redis + MinIO 都要）
 * ⚠️ 本脚本**自己启停 worker**（`startPipelineWorker`/`stopPipelineWorker`），不要同时开着
 *    `pnpm dev:backend` 跑同一批数据（两条 worker 会抢任务；队列键虽然隔离了，但文档是共库的）。
 */

process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = 'http://127.0.0.1:1/v1'
process.env.EMBEDDING_API_KEY = 'verify-pipeline-key'
process.env.EMBEDDING_API_MODEL = 'verify-embed-model'
process.env.PIPELINE_QUEUE_KEY = `verify:pipeline:jobs:${Math.random().toString(36).slice(2, 8)}`

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const { buildApp } = await import('../dist/backend/src/app.js')
const { config } = await import('../dist/backend/src/config.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { ensureBucket, getS3Client } = await import('../dist/backend/src/infra/s3.js')
const {
  DEQUEUE_TIMEOUT_SEC,
  closePipelineQueue,
  dequeuePipelineJob,
  encodePipelineJob,
  enqueuePipelineJob,
  parsePipelineJob,
  pipelineQueueDepth,
  pipelineQueueKey,
} = await import('../dist/backend/src/pipeline/queue.js')
const {
  getPipelineWorkerStats,
  isPipelineWorkerRunning,
  startPipelineWorker,
  stopPipelineWorker,
} = await import('../dist/backend/src/pipeline/worker.js')
const {
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_TRANSITIONS,
  canTransitionDocumentStatus,
  uploadDocumentResultSchema,
} = await import('@doubulea/shared')
const fixtures = await import('./fixtures/documents.mjs')

// ───────────────────────────── 断言脚手架（与另几个脚本同一套）─────────────────────────────

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n)

/** 轮询直到 `probe()` 返回真值（超时抛错并带上最后的观察值，避免"卡住但不知道为什么"） */
async function waitFor(description, probe, { timeoutMs = 20_000, intervalMs = 20 } = {}) {
  const deadline = nowMs() + timeoutMs
  let last
  for (;;) {
    last = await probe()
    if (last) return last
    if (nowMs() > deadline) throw new Error(`${description}：等待超时（${timeoutMs}ms），最后观察值 ${JSON.stringify(last)}`)
    await sleep(intervalMs)
  }
}

// ───────────────────────────── 常量与临时数据标识 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Pipe-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-pipe-admin-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdKbIds = []
const createdDocIds = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()
// ⚠️ `s3` / `bucket` 在 try 之外声明：finally 的清理段也要用（写在 try 里会让失败路径变成
//    `s3 is not defined`，把"清理没做"伪装成另一个错误）
const s3 = getS3Client()
const bucket = config.s3.bucket
const queueKey = pipelineQueueKey()
const PROBE_ENTRY = fileURLToPath(new URL('./probe-upload-once.mjs', import.meta.url))

// ───────────────────────────── HTTP 与存储工具 ─────────────────────────────

function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const pair = header.split(';')[0] ?? ''
  const value = pair.slice(pair.indexOf('=') + 1)
  if (value !== '') sessionIds.push(value)
  return value
}

function api(method, url, { cookie, payload, headers } = {}) {
  const options = { method, url }
  const merged = { ...(headers ?? {}) }
  if (cookie !== undefined && cookie !== '') merged.cookie = `${SESSION_COOKIE_NAME}=${cookie}`
  if (Object.keys(merged).length > 0) options.headers = merged
  if (payload !== undefined) options.payload = payload
  return app.inject(options)
}

/** 手搓 multipart（与 `verify-documents.mjs` 同一手法：inject 只认 payload 字节） */
function multipart(name, { filename, contentType, value }) {
  const boundary = `----doubuleaPipelineBoundary${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType ?? 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  )
  return {
    payload: Buffer.concat([head, value, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/** 上传一个夹具（走 HTTP），返回 `{response, data, docId}` */
async function upload(kbId, { cookie, bytes, fileName, contentType }) {
  const body = multipart('file', { filename: fileName, contentType, value: bytes })
  const response = await api('POST', `/api/knowledge-bases/${kbId}/documents`, {
    cookie,
    payload: body.payload,
    headers: { 'content-type': body.contentType },
  })
  assertEqual(response.statusCode, 200, `上传 ${fileName} 的状态码`)
  const data = uploadDocumentResultSchema.parse(response.json().data)
  // ⚠️ 上传端点**不做同步解析** ⇒ 响应里的状态恒为 PARSING（`子方案①` §三 的 ①② 两步）
  assertEqual(data.document.status, 'PARSING', `${fileName} 的上传响应状态（解析是异步的）`)
  createdDocIds.push(data.document.id)
  return { response, data, docId: data.document.id }
}

/** 只上传、不关心响应细节的简写（D/E 组用；每个用例给**不同内容**，否则同库内会判重命中） */
async function uploadFresh(kbId, cookie, tag) {
  const bytes = Buffer.from(`# ${tag}\n\n${tag} 的正文内容，用于流水线幂等与并发用例（${suffix}）。\n`, 'utf8')
  return upload(kbId, { cookie, bytes, fileName: `${tag}.md`, contentType: 'text/markdown' })
}

async function docRow(docId) {
  const row = await prisma.document.findUnique({ where: { id: docId } })
  assert(row !== null, `文档 ${docId} 应当存在于库中`)
  return row
}

/** 由库里的行构造一条 job（`mode: NEW` —— 重投用的就是"当时那条"） */
function jobOf(row) {
  return { docId: row.id, kbId: row.kbId, contentHash: row.contentHash, mode: 'NEW' }
}

async function listKeys(prefix) {
  const keys = []
  for await (const object of s3.listObjectsV2(bucket, prefix, true)) {
    if (object.name !== undefined) keys.push(object.name)
  }
  return keys
}

async function createKb(cookie, name) {
  const response = await api('POST', '/api/knowledge-bases', { cookie, payload: { name } })
  assertEqual(response.statusCode, 200, `建库（${name}）状态码`)
  const kb = response.json().data
  createdKbIds.push(kb.id)
  return kb
}

/** 等队列清空**且**在途任务归零（两个条件缺一不可：只看队列会把"还在处理"当成"已完成"） */
function waitDrained(options) {
  return waitFor(
    '队列清空且在途任务归零',
    async () => (await pipelineQueueDepth()) === 0 && getPipelineWorkerStats().inFlight === 0,
    options,
  )
}

/** 用慢速假阶段启动 worker（D/E 组靠它确定性观测并发与幂等；见 `stages.ts` 文件头） */
function slowStages(runs, sleepMs) {
  return [
    {
      name: 'slow-fake',
      run: async (ctx) => {
        runs.set(ctx.document.id, (runs.get(ctx.document.id) ?? 0) + 1)
        await sleep(sleepMs)
      },
    },
  ]
}

/** 在纯净子进程里跑一次 `uploadDocument`（G 组；见 `probe-upload-once.mjs`） */
function runProbe({ kbId, content, extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    // 刻意用异步 spawn（不用 spawnSync）：本脚本同时持有 PG/Redis/S3 连接与 HTTP 应用，
    // 同步阻塞父进程事件循环会让子进程的导入与收尾都被拖住（P0-1-13 的教训）
    const child = spawn(process.execPath, [PROBE_ENTRY], {
      env: { ...process.env, PROBE_KB_ID: kbId, PROBE_CONTENT: content, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const lastLine = out.trim().split('\n').pop() ?? ''
      try {
        resolve({ ...JSON.parse(lastLine), stderr: err, exitCode: code })
      } catch {
        reject(new Error(`探针子进程输出无法解析（退出码 ${code}）：stdout=${out} stderr=${err}`))
      }
    })
  })
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-17 异步队列 + 状态机 + worker 骨架 ══${c.x}`)

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
    process.exit(1)
  }
  try {
    await ensureBucket(bucket)
  } catch (error) {
    console.error(
      `\n${c.r}✖ 本验收需要可达的 S3（MinIO）${c.x}\n  先执行：pnpm infra:up\n  原始错误：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    process.exit(1)
  }

  const passwordHash = await hashPassword(PASSWORD)
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash,
      nickname: '流水线验证管理员',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  createdUserIds.push(admin.id)
  const login = await api('POST', '/api/auth/login', { payload: { username: adminUsername, password: PASSWORD } })
  assertEqual(login.statusCode, 200, '登录')
  const adminCookie = cookieOf(login)

  const kb = await createKb(adminCookie, `验证库-流水线-${suffix}`)
  const gKb = await createKb(adminCookie, `验证库-流水线-探针-${suffix}`)

  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）+ 2 个知识库${c.x}`)
  console.log(
    `  ${c.d}注入配置：PIPELINE_QUEUE_KEY=${queueKey}（默认 ${DEQUEUE_TIMEOUT_SEC}s 取件超时）｜` +
      `PIPELINE_CONCURRENCY=${config.concurrency.pipeline}${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  // A 组 · 纯函数：job 编解码 + 状态机
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── A 组 · job 编解码与状态机（纯函数）──${c.x}`)

  await it('注入的队列键真的生效（`verify:` 前缀 ⇒ 与 dev server 的默认队列互不干扰）', async () => {
    assert(queueKey.startsWith('verify:pipeline:jobs:'), `队列键应被注入，实际 ${queueKey}`)
    assertEqual(config.pipeline.queueKey, queueKey, 'config.pipeline.queueKey')
    assert(queueKey !== 'pipeline:jobs', '不应落到默认队列键上')
  })

  await it('job 编解码往返：字段逐字相等，且队列里存的是 JSON 字符串', async () => {
    const job = {
      docId: '0198f0aa-1111-7000-8000-000000000001',
      kbId: '0198f0aa-2222-7000-8000-000000000002',
      contentHash: 'a'.repeat(64),
      mode: 'NEW',
    }
    const encoded = encodePipelineJob(job)
    assert(typeof encoded === 'string' && encoded.startsWith('{'), `应是 JSON 字符串，实际 ${encoded}`)
    const decoded = parsePipelineJob(encoded)
    assert(decoded !== undefined, '往返后应解析成功')
    assertEqual(JSON.stringify(decoded), JSON.stringify(job), '往返后的字段')
  })

  await it('非法 payload 一律被丢弃（返回 undefined，不抛）—— 队列是"外部输入"', async () => {
    const cases = [
      ['不是 JSON', 'not-json'],
      ['空对象', '{}'],
      ['docId 不是 uuid', JSON.stringify({ docId: 'x', kbId: 'y', contentHash: 'a'.repeat(64), mode: 'NEW' })],
      ['contentHash 长度不对', JSON.stringify({ docId: '0198f0aa-1111-7000-8000-000000000001', kbId: '0198f0aa-2222-7000-8000-000000000002', contentHash: 'abc', mode: 'NEW' })],
      ['contentHash 用了大写（sha256 十六进制约定是小写）', JSON.stringify({ docId: '0198f0aa-1111-7000-8000-000000000001', kbId: '0198f0aa-2222-7000-8000-000000000002', contentHash: 'A'.repeat(64), mode: 'NEW' })],
      ['mode 不认识', JSON.stringify({ docId: '0198f0aa-1111-7000-8000-000000000001', kbId: '0198f0aa-2222-7000-8000-000000000002', contentHash: 'a'.repeat(64), mode: 'WHATEVER' })],
      ['null', 'null'],
    ]
    for (const [label, raw] of cases) {
      assertEqual(parsePipelineJob(raw), undefined, `${label} 应被丢弃`)
    }
  })

  await it('状态机矩阵：合法转换恰好 5 条（3 个状态 × 3 个状态里的合法者），且 READY 不可能被打回 FAILED', async () => {
    assertEqual(DOCUMENT_STATUSES.length, 3, '状态个数')
    const legal = []
    for (const from of DOCUMENT_STATUSES) {
      for (const to of DOCUMENT_STATUSES) {
        if (canTransitionDocumentStatus(from, to)) legal.push(`${from}->${to}`)
      }
    }
    // 两边都排序再比：转移集合是"集合语义"，与 `DOCUMENT_STATUSES` 的书写顺序无关
    // （第一版就是按书写顺序写死了期望值，换一下枚举顺序就会假失败）
    assertEqual(
      JSON.stringify([...legal].sort()),
      JSON.stringify(['PARSING->PARSING', 'PARSING->READY', 'PARSING->FAILED', 'FAILED->PARSING', 'READY->PARSING'].sort()),
      '合法转换集合',
    )
    // 本批最值得守的一条：过期 job 把已经成功的文档打回 FAILED，是**唯一**会让 READY 文档
    // 变成"内容明明能用却报失败、且重投也救不回来"的写入
    assertEqual(canTransitionDocumentStatus('READY', 'FAILED'), false, 'READY 不得直接转 FAILED')
    assertEqual(canTransitionDocumentStatus('FAILED', 'READY'), false, 'FAILED 必须先回 PARSING（重试是可见的中间态）')
    assertEqual(DOCUMENT_STATUS_TRANSITIONS.READY.length, 1, 'READY 的合法后继')
  })

  // ═══════════════════════════════════════════════════════════════════
  // B 组 · 队列语义（需 Redis）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── B 组 · 队列语义 ──${c.x}`)

  const bJob = {
    docId: '0198f0aa-3333-7000-8000-000000000003',
    kbId: kb.id,
    contentHash: 'b'.repeat(64),
    mode: 'NEW',
  }

  await it('入队返回新的队列长度；取件拿到的就是投进去的那条，取完队列归零', async () => {
    assertEqual(await pipelineQueueDepth(), 0, '前置：队列为空')
    const depth = await enqueuePipelineJob(bJob)
    assertEqual(depth, 1, 'LPUSH 的返回值应是入队后的长度')
    assertEqual(await pipelineQueueDepth(), 1, 'LLEN')

    const popped = await dequeuePipelineJob(2)
    assert(popped !== undefined, '应当取到任务')
    assertEqual(JSON.stringify(popped), JSON.stringify(bJob), '取到的任务字段')
    assertEqual(await pipelineQueueDepth(), 0, '取走后队列为空')
  })

  await it(`空队列：等满 ${DEQUEUE_TIMEOUT_SEC}s 后返回 undefined（不是永久阻塞）`, async () => {
    const started = nowMs()
    const popped = await dequeuePipelineJob(1)
    const elapsed = nowMs() - started
    assertEqual(popped, undefined, '空队列应返回 undefined')
    assert(elapsed >= 900 && elapsed < 3_000, `超时应≈1s（实际 ${elapsed}ms）—— 0 会永久阻塞，退不出停止流程`)
  })

  await it('垃圾 payload 被丢弃（取件不抛、且它确实被移出队列）', async () => {
    await redis.rpush(queueKey, '{"docId":"不是-uuid"}')
    assertEqual(await pipelineQueueDepth(), 1, '前置：队列里有 1 条垃圾')
    const popped = await dequeuePipelineJob(2)
    assertEqual(popped, undefined, '垃圾应被丢弃')
    assertEqual(await pipelineQueueDepth(), 0, '垃圾不应留在队列里反复干扰')
  })

  await it('阻塞读**不占用共享连接**：BRPOP 挂起期间 /api 侧的 Redis 命令仍立刻返回', async () => {
    // 这条是 `infra/redis.ts#createRedisConnection` 的存在理由：若阻塞读走共享连接，
    // 队列一空闲就会把会话读写、/health 全部钉住 —— 而这**只在队列空闲时**才明显，最难联想
    const started = nowMs()
    const pending = dequeuePipelineJob(3) // 挂 3 秒（等一条还不存在的任务）
    const pingStarted = nowMs()
    const pong = await redis.ping()
    const pingMs = nowMs() - pingStarted
    assertEqual(pong, 'PONG', '共享连接的 PING')
    assert(pingMs < 500, `共享连接在 BRPOP 挂起期间仍应立刻响应，实际耗时 ${pingMs}ms`)

    await enqueuePipelineJob(bJob) // 投一条把挂起的 BRPOP 唤醒（不让脚本白等 3 秒）
    const popped = await pending
    assert(popped !== undefined, '挂起的 BRPOP 应在有数据时立刻返回')
    assertEqual(popped.docId, bJob.docId, '被唤醒后取到的任务')
    assert(nowMs() - started < 3_000, '唤醒路径不应等满超时')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C 组 · 端到端（真阶段：解析）：上传 → 入队 → worker → READY
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── C 组 · 端到端（真阶段）：四格式上传 → worker 消费 → READY ──${c.x}`)

  const realCases = [
    {
      bytes: fixtures.makePdf([
        ['Reimbursement Policy', 'Page one body text for the pipeline'],
        ['Travel Standard', 'Page two body text for the pipeline'],
      ]),
      fileName: '制度.pdf',
      contentType: 'application/pdf',
    },
    {
      bytes: fixtures.makeDocx([
        { level: 1, text: '报销制度' },
        { text: '出差住宿标准为每晚上限 500 元。' },
      ]),
      fileName: '制度.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { bytes: fixtures.makeMarkdown(), fileName: '员工手册.md', contentType: 'text/markdown' },
    { bytes: fixtures.makeTxtUtf8(), fileName: '巡检.txt', contentType: 'text/plain' },
  ]
  const realDocIds = []

  await it('上传四格式 → 响应 status 恒为 PARSING，且每篇都入队一条（队列长度 = 4）', async () => {
    assertEqual(await pipelineQueueDepth(), 0, '前置：队列为空')
    for (const item of realCases) {
      const { docId } = await upload(kb.id, { cookie: adminCookie, ...item })
      realDocIds.push(docId)
    }
    assertEqual(await pipelineQueueDepth(), 4, '四篇各入队一条（① 登记 与 ② 入队 是同一件事的两半）')
    assertEqual(isPipelineWorkerRunning(), false, '前置：本组之前 worker 未启动（否则任务会被立刻吃掉）')
  })

  await it('启动 worker → 四篇全部 READY，error_msg 为空，chunk_count=0（本批的预期中间态）', async () => {
    const started = startPipelineWorker()
    assertEqual(started.running, true, 'worker 已启动')
    assertEqual(started.concurrency, config.concurrency.pipeline, '并发上限取 PIPELINE_CONCURRENCY')
    assertEqual(
      JSON.stringify(started.stages),
      JSON.stringify(['load-source', 'parse']),
      '默认阶段序列（④⑤ 属 P0-1-18、⑥⑦ 属 P0-1-19）',
    )

    await waitFor(
      '四篇全部处理完',
      async () =>
        (await prisma.document.count({ where: { id: { in: realDocIds }, status: 'READY' } })) === 4,
      { timeoutMs: 30_000, intervalMs: 25 },
    )

    const rows = await prisma.document.findMany({ where: { id: { in: realDocIds } } })
    assertEqual(rows.length, 4, '查到 4 篇')
    for (const row of rows) {
      assertEqual(row.status, 'READY', `${row.fileName} 的状态`)
      assertEqual(row.errorMsg, null, `${row.fileName} 的 error_msg（成功路径必须是 null，不是空串）`)
      // ⚠️ 刻意断言 0：本批只到"解析成功"，chunk 入库是 P0-1-18/19。此刻 READY 的含义是
      //    "解析这一关过了"，**还不是**"可检索"（见 `stages.ts` 文件头）
      assertEqual(row.chunkCount, 0, `${row.fileName} 的 chunk_count（P0-1-18/19 才填，这里是预期值）`)
    }

    const stats = getPipelineWorkerStats()
    assertEqual(stats.processed, 4, 'processed')
    assertEqual(stats.failed, 0, 'failed')
    assertEqual(await pipelineQueueDepth(), 0, '队列被消费空')
    assert(stats.peakInFlight <= stats.concurrency, `并发峰值 ${stats.peakInFlight} 不应超过上限 ${stats.concurrency}`)

    await stopPipelineWorker(2_000)
    assertEqual(isPipelineWorkerRunning(), false, 'worker 已停止')
    assertEqual(getPipelineWorkerStats().inFlight, 0, '停止后在途任务归零')
  })

  // ═══════════════════════════════════════════════════════════════════
  // D 组 · 幂等（四种跳过，各自"一个字节都不写库"）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── D 组 · 幂等：四种跳过都不写库、阶段只跑一次 ──${c.x}`)

  const dRuns = new Map()
  const dup = await uploadFresh(kb.id, adminCookie, '幂等-重复投递')
  const dupRow = await docRow(dup.docId)

  await it('同一文档被**并发**投递 3 次：只处理一次（幂等第 ① 道：在飞去重）', async () => {
    // 上传时已自动入队 1 条，再手工补 2 条完全相同的（模拟"用户双击上传"或"重投"）
    await enqueuePipelineJob(jobOf(dupRow))
    await enqueuePipelineJob(jobOf(dupRow))
    assertEqual(await pipelineQueueDepth(), 3, '前置：队列里有 3 条同样的任务')

    startPipelineWorker({ stages: slowStages(dRuns, 120) })
    await waitDrained({ timeoutMs: 20_000 })
    await stopPipelineWorker(2_000)

    const row = await docRow(dup.docId)
    assertEqual(row.status, 'READY', '状态')
    assertEqual(dRuns.get(dup.docId), 1, '阶段执行次数（3 条任务只能产生 1 次处理）')
    const stats = getPipelineWorkerStats()
    assertEqual(stats.processed, 1, 'processed')
    assertEqual(
      (stats.skipped['duplicate-inflight'] ?? 0) + (stats.skipped['already-ready'] ?? 0),
      2,
      `另外两条应被跳过（实际 ${JSON.stringify(stats.skipped)}）`,
    )
  })

  await it('已 READY 再投同一 job：**一个字节都不写**（updated_at 逐字不变）', async () => {
    const before = await docRow(dup.docId)
    startPipelineWorker({ stages: slowStages(dRuns, 60) })
    await enqueuePipelineJob(jobOf(before))
    await waitFor(
      '幂等跳过计数出现',
      async () => (getPipelineWorkerStats().skipped['already-ready'] ?? 0) === 1,
      { timeoutMs: 10_000, intervalMs: 15 },
    )
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)

    const after = await docRow(dup.docId)
    assertEqual(after.status, 'READY', '状态不变')
    assertEqual(after.updatedAt.toISOString(), before.updatedAt.toISOString(), 'updated_at（无写入才会逐字相同）')
    assertEqual(dRuns.get(dup.docId), 1, '阶段不应被再跑一次')
  })

  await it('过期 job（contentHash 不符）：跳过，不动状态也不动时间戳', async () => {
    const before = await docRow(dup.docId)
    startPipelineWorker({ stages: slowStages(dRuns, 60) })
    await enqueuePipelineJob({ ...jobOf(before), contentHash: 'c'.repeat(64) })
    await waitFor('过期跳过计数出现', async () => (getPipelineWorkerStats().skipped['stale'] ?? 0) === 1, {
      timeoutMs: 10_000,
      intervalMs: 15,
    })
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)

    const after = await docRow(dup.docId)
    assertEqual(after.updatedAt.toISOString(), before.updatedAt.toISOString(), 'updated_at 不变（旧内容的 job 不得改文档）')
    assertEqual(dRuns.get(dup.docId), 1, '阶段不应被再跑一次')
  })

  await it('文档已删的 job：跳过并告警，不抛错、不影响后续消费', async () => {
    startPipelineWorker({ stages: slowStages(dRuns, 60) })
    const ghost = { docId: '0198f0aa-4444-7000-8000-000000000004', kbId: kb.id, contentHash: 'd'.repeat(64), mode: 'NEW' }
    await enqueuePipelineJob(ghost)
    await waitFor('已删文档跳过计数出现', async () => (getPipelineWorkerStats().skipped['doc-missing'] ?? 0) === 1, {
      timeoutMs: 10_000,
      intervalMs: 15,
    })
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)
    assertEqual(getPipelineWorkerStats().failed, 0, '这类跳过不该被算成失败')
  })

  // ═══════════════════════════════════════════════════════════════════
  // E 组 · 并发闸（PIPELINE_CONCURRENCY）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── E 组 · 并发闸：峰值并发 = ${config.concurrency.pipeline}，且真的分批 ──${c.x}`)

  const eRuns = new Map()
  const eDocs = []
  const SLOW_MS = 200
  const E_COUNT = 8

  await it(`${E_COUNT} 个慢任务（各 ${SLOW_MS}ms）：峰值并发恰为 ${config.concurrency.pipeline}，全部只处理一次`, async () => {
    for (let index = 0; index < E_COUNT; index += 1) {
      eDocs.push((await uploadFresh(kb.id, adminCookie, `并发-${index}`)).docId)
    }
    assertEqual(await pipelineQueueDepth(), E_COUNT, '前置：8 条任务在队列里')

    startPipelineWorker({ stages: slowStages(eRuns, SLOW_MS) })
    const startedAt = nowMs()
    let observedMax = 0
    await waitFor(
      '8 篇全部处理完',
      async () => {
        observedMax = Math.max(observedMax, getPipelineWorkerStats().inFlight)
        const ready = await prisma.document.count({ where: { id: { in: eDocs }, status: 'READY' } })
        return ready === E_COUNT
      },
      { timeoutMs: 30_000, intervalMs: 10 },
    )
    const elapsed = nowMs() - startedAt
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)

    const stats = getPipelineWorkerStats()
    assertEqual(observedMax, config.concurrency.pipeline, '轮询观察到的并发峰值')
    assertEqual(stats.peakInFlight, config.concurrency.pipeline, 'worker 自报的并发峰值')
    assertEqual(stats.processed, E_COUNT, 'processed')
    assertEqual(eRuns.size, E_COUNT, '被处理过的文档数（每个恰好一次）')
    for (const docId of eDocs) assertEqual(eRuns.get(docId), 1, `${docId} 的阶段执行次数`)

    // 串行化的证据：8 个任务按 2 并发跑 ⇒ 至少 4 轮 × 200ms。若实现是"全放行"，
    // 耗时会在 200ms 出头（这条下界就能把它挡下来），而峰值并发会到 8
    const minWaves = E_COUNT / config.concurrency.pipeline
    assert(
      elapsed >= minWaves * SLOW_MS * 0.9,
      `总耗时 ${elapsed}ms 应 ≥ ${Math.round(minWaves * SLOW_MS * 0.9)}ms（${minWaves} 轮；否则说明没有真的限流）`,
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  // F 组 · 失败路径与"重投救回"（`docs/06` 坑预判的取证）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── F 组 · FAILED 与重投救回（"List 无 ack ⇒ 必须有重试入口"）──${c.x}`)

  const fBytes = fixtures.makePdf([['Retry Policy', 'Body text for the retry case']])
  const missing = await upload(kb.id, {
    cookie: adminCookie,
    bytes: fBytes,
    fileName: '重试用例.pdf',
    contentType: 'application/pdf',
  })
  const missingRow = await docRow(missing.docId)

  await it('原文件在 S3 里丢了 → FAILED，error_msg 是可展示的中文原因、chunk_count 归 0', async () => {
    // 先把对象删掉（模拟运维误删/被清理），再让 worker 去处理那条已经入队的任务
    await s3.removeObject(bucket, missingRow.fileKey)
    assertEqual((await listKeys(`kb/${kb.id}/`)).includes(missingRow.fileKey), false, '前置：对象已删除')

    startPipelineWorker()
    await waitFor(
      '文档转为 FAILED',
      async () => (await docRow(missing.docId)).status === 'FAILED',
      { timeoutMs: 20_000, intervalMs: 25 },
    )
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)

    const row = await docRow(missing.docId)
    assertIncludes(row.errorMsg ?? '', '原文件读取失败', '失败原因')
    assertIncludes(row.errorMsg ?? '', '重试用例.pdf', '失败原因里应指明是哪篇文档（用户要能照着做）')
    assertEqual(row.chunkCount, 0, 'chunk_count')
    assertEqual(getPipelineWorkerStats().failed, 1, 'failed 计数')
  })

  await it('补回原文件 + **重投同一个 job** → 回到 READY，error_msg 被清空（这就是"重试入口"）', async () => {
    // 这条是 `docs/06` P0-1-17 坑预判的正面取证：List 取走即出队、worker 崩了任务就没了，
    // 所以"把同一个 job 再投一次就能救回来"必须是**协议层**成立的（P0-1-19 的 /retry 只是给它加个端点）
    await s3.putObject(bucket, missingRow.fileKey, fBytes, fBytes.length, {
      'Content-Type': 'application/octet-stream',
    })
    startPipelineWorker()
    await enqueuePipelineJob(jobOf(missingRow))
    await waitFor(
      '文档重试后转回 READY',
      async () => (await docRow(missing.docId)).status === 'READY',
      { timeoutMs: 20_000, intervalMs: 25 },
    )
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)

    const row = await docRow(missing.docId)
    assertEqual(row.errorMsg, null, 'error_msg 应在重试起点被清掉（否则界面上"正在重试"与"上次失败"会同时挂着）')
    assertEqual(row.status, 'READY', '状态')
    // FAILED → PARSING → READY 这条链能走通，说明状态机允许的"重试路径"是通的
    assertEqual(canTransitionDocumentStatus('FAILED', 'PARSING'), true, '状态机允许 FAILED → PARSING')
  })

  await it('S3 对象被换成别的内容 → FAILED 且原因是「文件内容与扩展名不符」（证明 parse 阶段跑的是真逻辑）', async () => {
    const swapped = await upload(kb.id, {
      cookie: adminCookie,
      bytes: fixtures.makePdf([['Swap Case', 'Body text for the swapped object case']]),
      fileName: '被替换.pdf',
      contentType: 'application/pdf',
    })
    const swappedRow = await docRow(swapped.docId)
    await s3.putObject(bucket, swappedRow.fileKey, Buffer.from('这不是 PDF 的内容\n', 'utf8'), 20, {
      'Content-Type': 'application/octet-stream',
    })

    startPipelineWorker()
    await waitFor(
      '被替换的文档转为 FAILED',
      async () => (await docRow(swapped.docId)).status === 'FAILED',
      { timeoutMs: 20_000, intervalMs: 25 },
    )
    await waitDrained({ timeoutMs: 10_000 })
    await stopPipelineWorker(2_000)

    const row = await docRow(swapped.docId)
    assertIncludes(row.errorMsg ?? '', '文件内容与扩展名不符', '失败原因')
  })

  // ═══════════════════════════════════════════════════════════════════
  // G 组 · 上传与入队的原子性（子进程 A/B 对照）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── G 组 · 上传与入队是同一件事的两半（子进程 A/B 对照）──${c.x}`)

  await it('对照组（子进程 + 真 Redis）：上传成功、登记 1 行、落 1 个对象、投 1 条任务', async () => {
    // 没有这条对照，下一条的"失败"可能是探针本身坏了造成的假通过
    const before = await prisma.document.count({ where: { kbId: gKb.id } })
    const result = await runProbe({ kbId: gKb.id, content: `probe-ok-${suffix}` })
    assertEqual(result.ok, true, `探针应成功（stderr=${result.stderr}）`)
    assertEqual(result.status, 'PARSING', '探针返回的状态')
    assertEqual(await prisma.document.count({ where: { kbId: gKb.id } }), before + 1, '库里应多 1 行')
    assertEqual((await listKeys(`kb/${gKb.id}/`)).length, 1, 'S3 里应有 1 个对象')

    // 顺手把这条任务取出来：既证明"入队的内容就是刚登记的那条"，又避免它污染后面的队列断言
    const leftover = await dequeuePipelineJob(2)
    assert(leftover !== undefined, '刚上传的文档应当有一条任务在队列里')
    assertEqual(leftover.docId, result.docId, '队列里那条任务的 docId')
    assertEqual(await pipelineQueueDepth(), 0, '取走后队列为空')
  })

  await it('死 Redis（子进程注入）：入队失败 ⇒ **整次上传回滚**（文档行与 S3 对象都不留）', async () => {
    const rowsBefore = await prisma.document.count({ where: { kbId: gKb.id } })
    const keysBefore = (await listKeys(`kb/${gKb.id}/`)).length

    const result = await runProbe({
      kbId: gKb.id,
      content: `probe-dead-${suffix}`,
      extraEnv: { REDIS_URL: 'redis://127.0.0.1:1' },
    })
    assertEqual(result.ok, false, '入队失败时上传必须失败（不能"看起来成功"）')
    assertIncludes(result.message, '入队失败', '错误信息应指明是入队失败')

    assertEqual(await prisma.document.count({ where: { kbId: gKb.id } }), rowsBefore, '文档行被回滚（否则留下永远转圈的 PARSING）')
    assertEqual((await listKeys(`kb/${gKb.id}/`)).length, keysBefore, 'S3 对象被补偿删除')
  })

  await it('死 Redis 那条路没在任何地方留下痕迹（库里只有对照组那一条，队列为空）', async () => {
    // 对照组那条**故意**留在 PARSING（我们手工把它的任务取走了），所以这里不看状态只看条数：
    // 若回滚漏了任何一半（行或对象），条数就会是 2；判重也不可能造成假通过 ——
    // 两次探针的内容不同（`probe-ok-*` vs `probe-dead-*`），同库判重不会命中
    assertEqual(await prisma.document.count({ where: { kbId: gKb.id } }), 1, '探针库只应有对照组那一条')
    assertEqual(await pipelineQueueDepth(), 0, '队列里不该有孤儿任务')
  })

  // ═══════════════════════════════════════════════════════════════════
  // H 组 · 自清理 + 残留复核
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── H 组 · 清场：删库双清、队列键不残留 ──${c.x}`)

  await it('删库（API）→ 该库 documents 行与 S3 对象全部清空（包括 worker 处理过的那些）', async () => {
    assert((await listKeys(`kb/${kb.id}/`)).length >= 8, '前置：库内对象应 ≥8 个')
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删库状态码')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 0, 'documents 应被级联删除')
    assertEqual((await listKeys(`kb/${kb.id}/`)).length, 0, 'S3 侧应无残留')
  })

  await it('队列键在收尾后不存在（不把任务留给共用这份 Redis 的别的进程）', async () => {
    assertEqual(await pipelineQueueDepth(), 0, '前置：队列已清空')
    await redis.del(queueKey)
    assertEqual(await redis.exists(queueKey), 0, '队列键应已删除')
    // 再验一次"删的是我们自己那条键"：默认键不该被本脚本碰过
    assert(queueKey !== 'pipeline:jobs', '本脚本只动自己注入的那条队列')
  })

  await it('第二处独立取证：删探针库 → 同样是双清（避免"第一条过了只是碰巧"）', async () => {
    const response = await api('DELETE', `/api/knowledge-bases/${gKb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删探针库状态码')
    assertEqual(await prisma.document.count({ where: { kbId: gKb.id } }), 0, '探针库文档清空')
    assertEqual((await listKeys(`kb/${gKb.id}/`)).length, 0, '探针库 S3 清空')
  })
} finally {
  // ── 最终清理（一律 `deleteMany`：清理阶段"目标已经不在了"是正常情况，
  //    `delete` 会为不存在的记录往 stdout 丢一坨 P2025 堆栈，把断言输出冲掉）──
  try {
    await stopPipelineWorker(1_000)
    await closePipelineQueue()
    await prisma.chunk.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { name: { contains: suffix } } })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s），
      //    不删就要等窗口过去才算干净（`06` P0-1-7 坑 5 的教训）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
    await redis.del(queueKey).catch(() => undefined)

    for (const kbId of createdKbIds) {
      const keys = await listKeys(`kb/${kbId}/`).catch(() => [])
      if (keys.length > 0) await s3.removeObjects(bucket, keys).catch(() => undefined)
    }
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-17 异步队列 + 状态机 + worker 骨架验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-17 异步队列 + 状态机 + worker 骨架验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
