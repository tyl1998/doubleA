#!/usr/bin/env node
/**
 * verify-ingest.mjs —— **P0-1-19 入库 + 覆盖重建 + 失败重试**验收
 *
 * 对 `docs/06` 该批的三条验收逐条落成可执行断言：
 *   ① 同文档传 v2 → **文档 id 不变**、`count(*) WHERE doc_id=?` **无重复无孤儿**、检索返回 v2 内容
 *      （→ B 组；"检索"这一条 P0-1-20 才有端点，本脚本用**向量近邻 SQL** 直接取证，
 *        见 B 组最后两条断言）
 *   ② 传完全相同内容 → 200「内容未变化，已跳过」（→ C 组；"跳过"落成**三个"没做"**的取证）
 *   ③ 造一个 FAILED 文档 → retry 后转 READY（→ D 组；用**上游 toggle 挂掉**造 FAILED，
 *      顺带验了 ⑥ 的失败文案与退避重试）
 * 外加：删除文档清 chunk（→ E 组，`02` §4.6 的 DELETE 端点）、覆盖重建/重试的边界与权限（→ F 组）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 分七组，各自守一件容易做错的事
 * ─────────────────────────────────────────────────────────────────────
 * A 组 **入库真跑**：上传 → worker → READY；`chunk_count` 与 `chunks` 表**逐行一致**、
 *    `seq` 连续、**每一行都有向量**、维度 1024、`meta` 三键齐备、
 *    ⚠️ **id 的版本位必须是 7**（P0-1-16 定案的守门断言：`uuid(7)` 只有一个实现 —— Prisma 的
 *    `@default`；手搓会静默降级成 v4，而这是唯一能抓住它的东西）。
 * B 组 **覆盖重建**：文档 id 不变、旧 chunk **一个不剩**、内容真的是 v2、
 *    旧 S3 对象被删（不泄漏）、向量近邻查询返回 v2 那一行。
 * C 组 **内容未变化**：`unchanged=true`，且**三个"没做"**逐个取证 ——
 *    chunk 行 id 逐字不变 / 文档 `updated_at` 逐字不变 / 对象数不变 / 队列深度 0。
 * D 组 **失败重试（端点）**：上游挂 → `FAILED` + 可读原因；修好后 `POST /retry` →
 *    响应立刻是 `PARSING`、`error_msg` 清空 → worker → `READY`；`READY` 再 retry → **409**。
 * E 组 **删除文档**：`deletedChunks` 数对、行/chunk/对象三清；重复删 → 404；跨库 docId → 404。
 * F 组 **边界与权限**：重建也要走前置校验（`.doc` / 改名 / 空文件 → 400）、
 *    未登录 → 401、**MEMBER 能跑完重建与重试**（守门断言用最低权限账号，见 `06` 的施工纪律）。
 * G 组 **自清理 + 残留复核**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处注入
 * ─────────────────────────────────────────────────────────────────────
 * · **假 embedding 上游**（`fixtures/embedding-upstream.mjs`）：本机 `.env` 是
 *   `EMBEDDING_MODE=api` 且三项为空 ⇒ 不接上，任何"走到 READY"的用例都会在 ⑥ 处硬报错。
 *   按 `06` 第四档口径自己起一个真 HTTP 服务（不是桩函数），并在上游侧取证报文形状。
 *   ⚠️ 必须在 import 后端模块**之前**设好地址（配置在模块加载期只读一次）。
 * · `PIPELINE_QUEUE_KEY=verify:ingest:jobs:<随机>` —— 队列必须换键（Redis 是共享的）。
 * · `LOG_LEVEL=fatal` —— 本脚本会**故意**制造失败（D 组的上游 500 会走 2 次退避重试并打堆栈）。
 *   要看细节：`LOG_LEVEL=debug pnpm verify:ingest`。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`（PG + Redis + MinIO 都要）
 * ⚠️ 本脚本**自己启停 worker**，不要同时开着 `pnpm dev:backend` 跑同一批数据。
 */

process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'
process.env.PIPELINE_QUEUE_KEY = `verify:ingest:jobs:${Math.random().toString(36).slice(2, 8)}`


const { startFakeEmbeddingUpstream, vectorFor } = await import('./fixtures/embedding-upstream.mjs')
const embeddingUpstream = await startFakeEmbeddingUpstream()
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = embeddingUpstream.url
process.env.EMBEDDING_API_KEY = 'verify-ingest-key'
process.env.EMBEDDING_API_MODEL = 'verify-embed-model'

const { buildApp } = await import('../dist/backend/src/app.js')
const { config } = await import('../dist/backend/src/config.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { getS3Client } = await import('../dist/backend/src/infra/s3.js')
const { closePipelineQueue, pipelineQueueDepth, pipelineQueueKey } = await import(
  '../dist/backend/src/pipeline/queue.js'
)
const { startPipelineWorker, stopPipelineWorker, getPipelineWorkerStats } = await import(
  '../dist/backend/src/pipeline/worker.js'
)
const {
  REUPLOAD_UNCHANGED_HINT,
  removeDocumentResultSchema,
  reuploadDocumentResultSchema,
  retryDocumentResultSchema,
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
async function waitFor(description, probe, { timeoutMs = 30_000, intervalMs = 25 } = {}) {
  const deadline = nowMs() + timeoutMs
  let last
  for (;;) {
    last = await probe()
    if (last) return last
    if (nowMs() > deadline) {
      throw new Error(`${description}：等待超时（${timeoutMs}ms），最后观察值 ${JSON.stringify(last)}`)
    }
    await sleep(intervalMs)
  }
}

// ───────────────────────────── 常量与临时数据标识 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Ingest-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-ingest-admin-${suffix}`
const memberUsername = `verify-ingest-member-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdKbIds = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()
const s3 = getS3Client()
const bucket = config.s3.bucket
const queueKey = pipelineQueueKey()

// ───────────────────────────── HTTP / 存储 / 数据库工具 ─────────────────────────────

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
  const boundary = `----doubuleaIngestBoundary${Math.random().toString(16).slice(2)}`
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
async function upload(kbId, { cookie, bytes, fileName, contentType, expectStatus = 200 }) {
  const body = multipart('file', { filename: fileName, contentType, value: bytes })
  const response = await api('POST', `/api/knowledge-bases/${kbId}/documents`, {
    cookie,
    payload: body.payload,
    headers: { 'content-type': body.contentType },
  })
  assertEqual(response.statusCode, expectStatus, `上传 ${fileName} 的状态码`)
  if (expectStatus !== 200) return { response }
  const data = uploadDocumentResultSchema.parse(response.json().data)
  assertEqual(data.document.status, 'PARSING', `${fileName} 的上传响应状态（解析是异步的）`)
  return { response, data, docId: data.document.id }
}

/** 覆盖重建（走 HTTP），返回 `{response, data}` */
async function reupload(kbId, docId, { cookie, bytes, fileName, contentType, expectStatus = 200 }) {
  const body = multipart('file', { filename: fileName, contentType, value: bytes })
  const response = await api('POST', `/api/knowledge-bases/${kbId}/documents/${docId}/reupload`, {
    cookie,
    payload: body.payload,
    headers: { 'content-type': body.contentType },
  })
  assertEqual(response.statusCode, expectStatus, `覆盖重建 ${fileName} 的状态码`)
  if (expectStatus !== 200) return { response }
  return { response, data: reuploadDocumentResultSchema.parse(response.json().data) }
}

async function docRow(docId) {
  const row = await prisma.document.findUnique({ where: { id: docId } })
  assert(row !== null, `文档 ${docId} 应当存在于库中`)
  return row
}

/** 读一个文档的全部 chunk（含"有没有向量"，`Unsupported` 列只能用裸 SQL 问） */
function chunkRowsOf(docId) {
  return prisma.$queryRaw`
    SELECT id::text AS id, seq, content, meta::text AS meta,
           embedding IS NOT NULL AS has_vec,
           vector_dims(embedding) AS dim
    FROM chunks WHERE doc_id = ${docId}::uuid ORDER BY seq
  `
}

/** 按 `kb/{kbId}/` 前缀列对象（判"有没有多落/漏删对象"】 */
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

async function login(username) {
  const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
  assertEqual(response.statusCode, 200, `${username} 登录`)
  return cookieOf(response)
}

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

/** 跑一轮 worker 直到"没有文档还在 PARSING"，然后停掉（脚本自己启停，不依赖外部进程） */
async function runWorkerUntilSettled(docIds) {
  startPipelineWorker()
  await waitFor(
    '目标文档全部离开 PARSING',
    async () => (await prisma.document.count({ where: { id: { in: docIds }, status: 'PARSING' } })) === 0,
    { timeoutMs: 60_000, intervalMs: 25 },
  )
  await waitFor('队列清空且在途归零', async () => (await pipelineQueueDepth()) === 0 && getPipelineWorkerStats().inFlight === 0, {
    timeoutMs: 20_000,
    intervalMs: 25,
  })
  await stopPipelineWorker(2_000)
}

/**
 * 造一段"一眼能认出是哪一版"的短文本。
 *
 * ⚠️ 长度**必须超过 `EMPTY_TEXT_THRESHOLD`（默认 50 个有效字符）**，否则会被 ④ 判成
 * "疑似扫描件"⇒ 后面所有断言都会因为"文档根本没入库"而红（P0-1-18 记过同一个坑：
 * 给流水线加内容门槛之后，夹具的"资格"会变）。同时控制在 512 字以内 ⇒ 恰好 1 块，
 * 于是"块正文 === 原文"、"最近邻查询命中的就是它自己"这类断言都能写得逐字确定。
 */
function notice(version) {
  const amount = version === 1 ? 500 : 800
  return Buffer.from(
    `第 ${version} 版报销制度（版本标记 v${version}）。` +
      `出差住宿标准为每晚上限 ${amount} 元，超出部分需部门负责人审批后方可报销；` +
      '交通费按实际发生额计入，当月票据须在次月五日前提交财务备案。',
    'utf8',
  )
}

/** 待删除文档的正文（同样必须超过空文本阈值，见 `notice()` 的注释） */
function doomedText() {
  return Buffer.from(
    `待删除的文档（${suffix}）：这是一段足够长的正文内容，` +
      '用于验证删除文档时 chunks 表与 S3 对象都被一并清理干净，且不留孤儿行。',
    'utf8',
  )
}

// ═════════════════════════════ 主流程 ═════════════════════════════

try {
  const admin = await createUser(adminUsername, UserRole.ADMIN)
  const member = await createUser(memberUsername, UserRole.MEMBER)
  assert(admin.id !== member.id, '两个账号应不同')
  const adminCookie = await login(adminUsername)

  const kb = await createKb(adminCookie, `验证库-入库-${suffix}`)
  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${memberUsername}（MEMBER）+ 1 个知识库${c.x}`)
  console.log(
    `  ${c.d}注入配置：PIPELINE_QUEUE_KEY=${queueKey}｜假 embedding 上游 ${embeddingUpstream.url}` +
      `（dim=${config.embedding.dim}，批 ${config.embedding.batchSize}）${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  // A 组 · 入库真跑（上传 → worker → chunks 落库）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── A 组 · 入库真跑：上传 → ⑥ embedding → ⑦ 写入 chunks ──${c.x}`)

  const v1 = notice(1)
  const uploadA = await upload(kb.id, {
    cookie: adminCookie,
    bytes: v1,
    fileName: '报销制度.txt',
    contentType: 'text/plain',
  })
  const docId = uploadA.docId

  await it('上传后 worker 跑完 → READY，且 chunk_count 与 chunks 表**逐行一致**', async () => {
    assertEqual((await docRow(docId)).status, 'PARSING', '上传后应停在 PARSING（异步流水线）')
    await runWorkerUntilSettled([docId])

    const row = await docRow(docId)
    assertEqual(row.status, 'READY', '状态')
    assertEqual(row.errorMsg, null, 'error_msg')
    const rows = await chunkRowsOf(docId)
    assertEqual(rows.length, 1, '200 字以内的短文应恰好 1 块')
    assertEqual(row.chunkCount, rows.length, 'chunk_count 必须等于 chunks 表行数（这就是"可检索"的定义）')
    assertEqual(Number(row.chunkCount) > 0, true, 'chunk_count 必须大于 0（P0-1-18 时它刻意是 0）')
  })

  await it('每一行都有向量、维度 1024，且能被 `<=>` 真的算出来（不是 NULL 也不算错）', async () => {
    const rows = await chunkRowsOf(docId)
    assertEqual(rows[0].has_vec, true, '第 0 块应有向量')
    assertEqual(Number(rows[0].dim), config.embedding.dim, '向量维度应等于 EMBEDDING_DIM')
    const distance = await prisma.$queryRaw`
      SELECT (embedding <=> ${`[${vectorFor(rows[0].content, config.embedding.dim).join(',')}]`}::vector)::float8 AS d
      FROM chunks WHERE doc_id = ${docId}::uuid LIMIT 1
    `
    assert(
      Number.isFinite(Number(distance[0].d)),
      `同一文本的向量算距离应当是有限数，实际 ${distance[0].d}（NULL 说明向量没写进去）`,
    )
  })

  await it('id 的版本位必须是 **7**（`uuid(7)` 只有 Prisma 一个实现，手搓会静默降级成 v4）', async () => {
    const rows = await chunkRowsOf(docId)
    for (const row of rows) {
      // uuid 的第三段首字符即版本位；`@default(uuid(7))` 是 Prisma 客户端侧生成，
      // 而本批的写入路径是"Prisma 建行 + 手写 UPDATE 回填向量" —— 这条断言守住"没有退化成自搓 id"
      assertEqual(row.id.split('-')[2][0], '7', `第 ${row.seq} 块的 id 版本位（${row.id}）`)
    }
    const docVersion = (await docRow(docId)).id.split('-')[2][0]
    assertEqual(docVersion, '7', '文档 id 的版本位')
  })

  await it('meta 三键齐备：headingPath / page / embeddingName（换模型检测靠第三个）', async () => {
    const rows = await chunkRowsOf(docId)
    const meta = JSON.parse(rows[0].meta)
    assertEqual(Array.isArray(meta.headingPath), true, 'meta.headingPath 应是数组')
    assertEqual(meta.page, null, 'txt 非分页 ⇒ meta.page 应为 null')
    assertEqual(meta.embeddingName, 'api:verify-embed-model', 'meta.embeddingName 应是 provider.name()')
  })

  await it('上游侧取证：真的按 `EMBEDDING_BATCH_SIZE` 切批发请求，且只发 model / input', async () => {
    const calls = embeddingUpstream.requests.filter((request) => request.path.endsWith('/embeddings'))
    assert(calls.length >= 1, '应当至少调用过一次 /embeddings')
    for (const call of calls) {
      assertEqual(call.method, 'POST', '方法')
      assertEqual(call.auth, `Bearer ${config.embedding.apiKey}`, '凭据应是解密/配置后的明文')
      assertEqual(
        Object.keys(call.body).sort().join(','),
        'input,model',
        '报文只应有 model 与 input（多发字段是上游兼容性的常见雷）',
      )
      assertEqual(call.body.model, config.embedding.apiModel, 'model 取值')
      assert(Array.isArray(call.body.input), 'input 应是数组')
      assert(call.body.input.length <= config.embedding.batchSize, '单次请求的条数不应超过批大小')
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // B 组 · 覆盖重建（同文档传 v2）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── B 组 · 覆盖重建：同文档传 v2（文档 id 不变、chunk 整次替换）──${c.x}`)

  const beforeRebuild = await docRow(docId)
  const beforeChunks = await chunkRowsOf(docId)
  const beforeKeys = await listKeys(`kb/${kb.id}/`)

  const v2 = notice(2)
  const rebuild = await reupload(kb.id, docId, {
    cookie: adminCookie,
    bytes: v2,
    fileName: '报销制度-v2.txt',
    contentType: 'text/plain',
  })

  await it('重建响应：**文档 id 不变**、unchanged=false、立刻回到 PARSING（旧 chunk 已清）', async () => {
    assertEqual(rebuild.response.statusCode, 200, '状态码')
    assertEqual(rebuild.data.document.id, docId, '文档 id 必须不变（决策 13：不新建行）')
    assertEqual(rebuild.data.unchanged, false, '内容变了 ⇒ unchanged=false')
    assertEqual(rebuild.data.document.status, 'PARSING', '重建后立刻回到 PARSING')
    assertEqual(rebuild.data.document.errorMsg, null, 'error_msg 应被清空')
    assertEqual(rebuild.data.document.chunkCount, 0, 'chunk_count 归 0（旧块已经删了）')
    // `§七` 的"先删后建"：重建响应返回时旧 chunk 必须**立刻**不在库里（检索空窗是刻意的，
    // 但"新内容还没入库却还能搜到旧内容"不是）
    assertEqual((await chunkRowsOf(docId)).length, 0, '旧 chunk 应当被立即清掉')
  })

  await it('worker 跑完后：只剩 v2 的块（**旧 chunk id 一个不剩**、无重复无孤儿）', async () => {
    await runWorkerUntilSettled([docId])

    const row = await docRow(docId)
    assertEqual(row.status, 'READY', '状态')
    assertEqual(row.id, beforeRebuild.id, '文档 id 仍然不变')
    const rows = await chunkRowsOf(docId)
    assertEqual(rows.length, 1, '仍是 1 块')
    assertEqual(row.chunkCount, rows.length, 'chunk_count 与表一致')

    const oldIds = new Set(beforeChunks.map((chunk) => chunk.id))
    const survivors = rows.filter((chunk) => oldIds.has(chunk.id))
    assertEqual(survivors.length, 0, `旧 chunk 的 id 不应残留，实际残留 ${survivors.length} 条`)

    // 全库核对"无孤儿"：没有任何 chunk 指向不存在的文档（先删后建漏删时会出现）
    const orphans = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM chunks c
      LEFT JOIN documents d ON d.id = c.doc_id WHERE d.id IS NULL
    `
    assertEqual(orphans[0].n, 0, '不应存在孤儿 chunk')
  })

  await it('内容真的是 v2：块正文含 v2 标记、**不含 v1 的旧数字**', async () => {
    const rows = await chunkRowsOf(docId)
    assertIncludes(rows[0].content, 'v2', '块正文应含 v2 的版本标记')
    assertIncludes(rows[0].content, '800', '块正文应是 v2 的数字')
    assert(!rows[0].content.includes('500'), '不应还能读到 v1 的内容')
  })

  await it('"检索会返回 v2"在数据层的等价取证：向量近邻查询命中的就是 v2 那一块', async () => {
    // P0-1-20 才有检索端点，这里用同一套 SQL 的核心（`<=>` 升序取首条）直接问库 ——
    // 它证明"存的向量与内容是对应的"，而不只是"有一列非空"
    const rows = await chunkRowsOf(docId)
    const hits = await prisma.$queryRaw`
      SELECT id::text AS id, (embedding <=> ${`[${vectorFor(rows[0].content, config.embedding.dim).join(',')}]`}::vector)::float8 AS d
      FROM chunks WHERE kb_id = ${kb.id}::uuid
      ORDER BY embedding <=> ${`[${vectorFor(rows[0].content, config.embedding.dim).join(',')}]`}::vector
      LIMIT 1
    `
    assertEqual(hits[0].id, rows[0].id, '用 v2 块自己的向量查，最近邻应当是它自己')
    assert(Number(hits[0].d) < 1e-6, `同一向量之间的距离应当接近 0，实际 ${hits[0].d}`)
  })

  await it('旧 S3 对象被删掉（换键之后没人认领它了，不删就是永久泄漏）', async () => {
    const afterKeys = await listKeys(`kb/${kb.id}/`)
    assertEqual(afterKeys.length, beforeKeys.length, '对象总数不应增加（换了键但删了旧的）')
    const oldKeyOfDoc = beforeKeys.filter((key) => !afterKeys.includes(key))
    assertEqual(oldKeyOfDoc.length, 1, '应当正好少了 1 个旧对象（被显式删除）')
    const row = await docRow(docId)
    assert(afterKeys.includes(row.fileKey), '当前 file_key 指向的新对象应当在存储里')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C 组 · 内容未变化（三个"没做"）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── C 组 · 内容未变化：200 + unchanged=true，且**什么都没做** ──${c.x}`)

  await it('传完全相同的内容 → 200 + unchanged=true（且提示文案与界面共用同一句）', async () => {
    const again = await reupload(kb.id, docId, {
      cookie: adminCookie,
      bytes: v2,
      fileName: '报销制度-v2-again.txt',
      contentType: 'text/plain',
    })
    assertEqual(again.data.unchanged, true, 'unchanged')
    assertEqual(again.data.document.status, 'READY', '状态保持 READY')
    assertEqual(REUPLOAD_UNCHANGED_HINT, '内容未变化，已跳过', '提示文案（前后端共用，别各自写）')
  })

  await it('"跳过"的三个"没做"：chunk id 逐字不变 / 文档 updated_at 不变 / 对象数不变 / 未入队', async () => {
    const rowBefore = await docRow(docId)
    const chunksBefore = await chunkRowsOf(docId)
    const keysBefore = await listKeys(`kb/${kb.id}/`)

    const skipped = await reupload(kb.id, docId, {
      cookie: adminCookie,
      bytes: v2,
      fileName: '报销制度-v2-第三次.txt',
      contentType: 'text/plain',
    })
    assertEqual(skipped.data.unchanged, true, 'unchanged')

    const chunksAfter = await chunkRowsOf(docId)
    assertEqual(
      chunksAfter.map((chunk) => chunk.id).join(','),
      chunksBefore.map((chunk) => chunk.id).join(','),
      'chunk 行 id 应逐字不变（"没删"的取证方式：重写过就会换新 id）',
    )
    assertEqual(
      (await docRow(docId)).updatedAt.toISOString(),
      rowBefore.updatedAt.toISOString(),
      '文档 updated_at 应逐字不变（没写库）',
    )
    assertEqual((await listKeys(`kb/${kb.id}/`)).length, keysBefore.length, '不落新对象')
    assertEqual(await pipelineQueueDepth(), 0, '不入队')
  })

  // ═══════════════════════════════════════════════════════════════════
  // D 组 · 失败重试（端点）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── D 组 · 失败重试：上游挂 → FAILED → 修好 → POST /retry → READY ──${c.x}`)

  const failedBytes = notice(3)
  const failedUpload = await upload(kb.id, {
    cookie: adminCookie,
    bytes: failedBytes,
    fileName: '重试用例.txt',
    contentType: 'text/plain',
  })
  const failedDocId = failedUpload.docId

  await it('上游 500 → FAILED，error_msg 是「文本向量化失败（已重试 2 次）」这类可展示原因', async () => {
    embeddingUpstream.setFailing(true)
    try {
      await runWorkerUntilSettled([failedDocId])
    } finally {
      embeddingUpstream.setFailing(false)
    }
    const row = await docRow(failedDocId)
    assertEqual(row.status, 'FAILED', '状态')
    assertIncludes(row.errorMsg ?? '', '文本向量化失败', '失败原因')
    assertIncludes(row.errorMsg ?? '', '已重试 2 次', '失败原因里应写清重试过（§4-3 的重试口径）')
    assertEqual(row.chunkCount, 0, '失败时不该有 chunk_count')
    assertEqual((await chunkRowsOf(failedDocId)).length, 0, '失败时不该留下半套 chunk')
    // 上游确实被打了 3 次（1 次原始 + 2 次重试）—— 这是"退避重试真的发生了"的取证
    const calls = embeddingUpstream.requests.filter((request) => request.path.endsWith('/embeddings'))
    assert(calls.length >= 3, `上游应当被调用 ≥3 次（原始 + 2 次重试），实际 ${calls.length}`)
  })

  await it('`POST /retry` → 响应立刻是 PARSING 且 error_msg 清空，worker 跑完转 READY', async () => {
    const response = await api('POST', `/api/knowledge-bases/${kb.id}/documents/${failedDocId}/retry`, {
      cookie: adminCookie,
    })
    assertEqual(response.statusCode, 200, '重试状态码')
    const data = retryDocumentResultSchema.parse(response.json().data)
    // 用户点完"重试"要**立刻**看到"处理中"：交给 worker 翻状态的话中间有一段"点了没反应"的空窗
    assertEqual(data.document.status, 'PARSING', '重试响应应立刻是 PARSING')
    assertEqual(data.document.errorMsg, null, 'error_msg 应被清空（否则界面会同时挂着"正在重试"和"上次失败"）')

    await runWorkerUntilSettled([failedDocId])
    const row = await docRow(failedDocId)
    assertEqual(row.status, 'READY', '重试后应转 READY')
    assertEqual(row.errorMsg, null, 'error_msg 保持清空')
    assertEqual(row.chunkCount, 1, 'chunk 应正确入库')
    assertEqual((await chunkRowsOf(failedDocId)).length, 1, 'chunks 表 1 行')
  })

  await it('已 READY 的文档再 retry → **409**（没有东西可重试，回 200 会让用户以为在重新处理）', async () => {
    const response = await api('POST', `/api/knowledge-bases/${kb.id}/documents/${failedDocId}/retry`, {
      cookie: adminCookie,
    })
    assertEqual(response.statusCode, 409, '状态码')
    assertIncludes(response.json().msg, '无需重试', '错误文案')
  })

  await it('retry 不存在的文档 → 404；**跨库** 的 docId → 404（不泄露"别人库里有什么"）', async () => {
    const ghost = await api(
      'POST',
      `/api/knowledge-bases/${kb.id}/documents/0198f0aa-9999-7000-8000-000000000009/retry`,
      { cookie: adminCookie },
    )
    assertEqual(ghost.statusCode, 404, '不存在的文档')

    const otherKb = await createKb(adminCookie, `验证库-另一库-${suffix}`)
    const cross = await api(
      'POST',
      `/api/knowledge-bases/${otherKb.id}/documents/${failedDocId}/retry`,
      { cookie: adminCookie },
    )
    assertEqual(cross.statusCode, 404, '用别的知识库的 id 访问这个文档')
  })

  // ═══════════════════════════════════════════════════════════════════
  // E 组 · 删除文档（清 chunk + 原文件）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── E 组 · 删除文档：DB 行 + chunk（级联）+ S3 原文件 ──${c.x}`)

  const doomedBytes = doomedText()
  const doomed = await upload(kb.id, {
    cookie: adminCookie,
    bytes: doomedBytes,
    fileName: '待删除.txt',
    contentType: 'text/plain',
  })
  await runWorkerUntilSettled([doomed.docId])
  const doomedRow = await docRow(doomed.docId)

  await it('DELETE → deletedChunks 数对、文档行与 chunk 与对象三清', async () => {
    assertEqual((await chunkRowsOf(doomed.docId)).length, 1, '前置：应有 1 个 chunk')
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}/documents/${doomed.docId}`, {
      cookie: adminCookie,
    })
    assertEqual(response.statusCode, 200, '删除状态码')
    const data = removeDocumentResultSchema.parse(response.json().data)
    assertEqual(data.id, doomed.docId, '返回的文档 id')
    assertEqual(data.fileName, '待删除.txt', '返回的文件名（界面要显示删了哪一篇）')
    assertEqual(data.deletedChunks, 1, 'deletedChunks 应是删前数出来的量')

    assertEqual(await prisma.document.count({ where: { id: doomed.docId } }), 0, '文档行应消失')
    assertEqual(await prisma.chunk.count({ where: { docId: doomed.docId } }), 0, 'chunk 应被级联清除')
    assertEqual((await listKeys(`kb/${kb.id}/`)).includes(doomedRow.fileKey), false, 'S3 原文件应被删除')
  })

  await it('重复删除同一个文档 → 404（第二次点删除不该报 500，也不该静默成功）', async () => {
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}/documents/${doomed.docId}`, {
      cookie: adminCookie,
    })
    assertEqual(response.statusCode, 404, '状态码')
  })

  // ═══════════════════════════════════════════════════════════════════
  // F 组 · 边界与权限
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── F 组 · 边界与权限：重建也走前置校验；未登录 401；MEMBER 全通 ──${c.x}`)

  await it('覆盖重建**不能**绕过前置校验：`.doc` / 改名 / 空文件都被挡下', async () => {
    const docCase = await reupload(kb.id, docId, {
      cookie: adminCookie,
      bytes: fixtures.makeLegacyDoc(),
      fileName: '旧版制度.doc',
      contentType: 'application/msword',
      expectStatus: 400,
    })
    assertIncludes(docCase.response.json().msg, 'docx', '`.doc` 的提示应指向"另存为 .docx"')

    const fake = await reupload(kb.id, docId, {
      cookie: adminCookie,
      bytes: fixtures.makeFakePdf(),
      fileName: '其实是文本.pdf',
      contentType: 'application/pdf',
      expectStatus: 400,
    })
    assertIncludes(fake.response.json().msg, '不符', '改名文件的提示应指向"内容与扩展名不符"')

    // 空文件：路由层（`readUploadedFile`）就拦下 —— 与上传共用同一段逻辑，见 `routes/documents.ts`
    const empty = await reupload(kb.id, docId, {
      cookie: adminCookie,
      bytes: Buffer.alloc(0),
      fileName: '空的.txt',
      contentType: 'text/plain',
      expectStatus: 400,
    })
    assertIncludes(empty.response.json().msg, '空', '空文件的提示')

    // ⚠️ 三次失败都**不能**动到那篇文档（校验在写之前）
    const row = await docRow(docId)
    assertEqual(row.status, 'READY', '校验失败不应改动状态')
    assertEqual(row.fileName, '报销制度-v2.txt', '校验失败不应改动文件名')
  })

  await it('未登录访问三条新端点一律 401（先鉴权再谈业务）', async () => {
    const cases = [
      ['POST', `/api/knowledge-bases/${kb.id}/documents/${docId}/retry`],
      ['DELETE', `/api/knowledge-bases/${kb.id}/documents/${docId}`],
    ]
    for (const [method, url] of cases) {
      const response = await api(method, url)
      assertEqual(response.statusCode, 401, `${method} ${url} 的未登录状态码`)
    }
  })

  await it('**MEMBER 能跑完整条链路**（权限=登录即可，不是 ADMIN；用最低权限账号守门）', async () => {
    // 守门断言的写法见 `06` 的施工纪律：用"恰好够用的角色"跑通，而不是用 ADMIN ——
    // ADMIN 在"误加了 requireAdmin"的实现上**依然通过**，验不出问题
    const memberUser = await createUser(`${memberUsername}-b`, UserRole.MEMBER)
    assert(memberUser.role === UserRole.MEMBER, '前置：确实是 MEMBER')
    const memberCookie = await login(`${memberUsername}-b`)

    const memberKb = await createKb(memberCookie, `验证库-成员-${suffix}`)
    const first = await upload(memberKb.id, {
      cookie: memberCookie,
      bytes: notice(1),
      fileName: '成员版.txt',
      contentType: 'text/plain',
    })
    await runWorkerUntilSettled([first.docId])

    const rebuilt = await reupload(memberKb.id, first.docId, {
      cookie: memberCookie,
      bytes: notice(2),
      fileName: '成员版-v2.txt',
      contentType: 'text/plain',
    })
    assertEqual(rebuilt.response.statusCode, 200, 'MEMBER 覆盖重建')
    await runWorkerUntilSettled([first.docId])

    const retried = await api(
      'POST',
      `/api/knowledge-bases/${memberKb.id}/documents/${first.docId}/retry`,
      { cookie: memberCookie },
    )
    assertEqual(retried.statusCode, 409, 'MEMBER 重试（此刻已 READY ⇒ 409 说明鉴权过了、是业务判断）')

    const removed = await api('DELETE', `/api/knowledge-bases/${memberKb.id}/documents/${first.docId}`, {
      cookie: memberCookie,
    })
    assertEqual(removed.statusCode, 200, 'MEMBER 删除文档')
  })

  // ═══════════════════════════════════════════════════════════════════
  // G 组 · 自清理 + 残留复核
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── G 组 · 清场：删库双清、队列键不残留 ──${c.x}`)

  await it('删库 → 该库 documents 与 chunks 与环境三清（含 worker 写过 chunk 的那些）', async () => {
    assert((await listKeys(`kb/${kb.id}/`)).length >= 1, '前置：库内应有对象')
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删库状态码')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 0, 'documents 应被级联删除')
    assertEqual(await prisma.chunk.count({ where: { kbId: kb.id } }), 0, 'chunks 应被级联删除')
    assertEqual((await listKeys(`kb/${kb.id}/`)).length, 0, 'S3 侧应无残留')
  })

  await it('队列键在收尾后不存在，且本脚本只动自己注入的那条键', async () => {
    assertEqual(await pipelineQueueDepth(), 0, '前置：队列已清空')
    await redis.del(queueKey)
    assertEqual(await redis.exists(queueKey), 0, '队列键应已删除')
    assert(queueKey !== 'pipeline:jobs', '本脚本只动自己注入的队列键')
  })
} finally {
  // ── 最终清理（一律 `deleteMany`：清理阶段"目标已经不在了"是正常情况，
  //    `delete` 会为不存在的记录往 stdout 丢一坨 P2025 堆栈，把断言输出冲掉）──
  try {
    await stopPipelineWorker(1_000)
    await closePipelineQueue()
    await prisma.chunk.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { name: { contains: suffix } } })
    for (const userId of createdUserIds) {
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
  await embeddingUpstream.close().catch(() => undefined)
  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-19 入库 / 覆盖重建 / 失败重试验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-19 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
