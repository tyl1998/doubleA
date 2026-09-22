#!/usr/bin/env node
/**
 * verify-retrieval.mjs —— **P0-1-20 双路检索 + RRF 融合**验收
 *
 * 对 `docs/06` 该批的四条验收逐条落成可执行断言：
 *   ① 中文 query 在 `HYBRID`/`FULLTEXT` 下均返回非空（证明 pg_bigm 生效）→ A 组
 *   ② 返回体含 `vectorScore`/`vectorRank`/`fulltextScore`/`fulltextRank`/`rrfScore`/`finalRank` 六列 → A 组
 *   ③ 检索 < 500ms → A 组末条
 *   ④ `snippet` 与原文逐字一致 → A 组（三条分支：命中居中／命中贴边／字面未命中）
 * 外加：候选池与 RRF 参数取自**该库的快照**（B 组）、§八 的**降级路径**（C 组）、
 * 权限与边界（D 组）、自清理与残留复核（E 组）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这份脚本最想钉死的三件事
 * ─────────────────────────────────────────────────────────────────────
 * ① **两路真的是两条路**：全文路的名次与分数，必须等于**独立跑一遍
 *    `bigm_similarity` SQL** 的结果（证明用的是 bigm，而不是"顺手按内容长度排了个序"）；
 *    向量路的名次与分数，必须等于**独立跑一遍 `<=>` SQL** 的结果。
 *    这类"实现 vs 独立复算"的对照，是唯一能证明"分数不是编出来的"的手段。
 * ② **RRF 的数值逐条可算**：对每个结果项用返回的 `vectorRank`/`fulltextRank` 反算
 *    `w_v/(k+rank_v) + w_f/(k+rank_f)`（缺失的一路记 0），必须与 `rrfScore` 相等。
 *    RRF 的全部内容就是这个公式，算不出来就说明实现里混进了别的东西（归一化、加权求和…）。
 * ③ **降级不静默**（`子方案①` §八）：库的 embedding 模型快照与当前 provider 不一致时
 *    `HYBRID` 必须跳过向量路**并告警**、`VECTOR` 必须明确报 409 —— 而不是"返回空"
 *    （空结果会被读成"库里没有相关内容"，是一句假话）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处注入
 * ─────────────────────────────────────────────────────────────────────
 * · **假 embedding 上游**（`fixtures/embedding-upstream.mjs`，`semantic: true`）：
 *   本机 `.env` 是 `EMBEDDING_MODE=api` 且三项为空 ⇒ 不接上，任何"走到 READY"的用例都会在
 *   ⑥ 处硬报错，检索也拿不到 query 向量。用 `semantic: true`（**词面重叠型**向量，
 *   P0-1-20 新增）是为了让"含关键词的那一块"在向量路里**真的排第一**，从而断言
 *   "向量路是一路真检索"；哈希噪声向量做不到这件事（见夹具注释里的边界说明）。
 * · `PIPELINE_QUEUE_KEY=verify:retrieval:jobs:<随机>` —— 队列必须换键（Redis 是共享的）。
 * · 一组**非默认的特征值**（`RRF_K=77` / `CANDIDATE_POOL_FACTOR=5`）：沿用默认值的话，
 *   "读的是该库快照 / 环境配置" 与 "写死了 60 / 3" 分辨不出来（P0-1-15 的同款手法）。
 * · `LOG_LEVEL=fatal`：C 组会**故意**制造 409/500。要看细节：`LOG_LEVEL=debug pnpm verify:retrieval`。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`（PG + Redis + MinIO 都要）
 * ⚠️ 本脚本**自己启停 worker**，不要同时开着 `pnpm dev:backend` 跑同一批数据。
 */

process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'
process.env.PIPELINE_QUEUE_KEY = `verify:retrieval:jobs:${Math.random().toString(36).slice(2, 8)}`
// 特征值：两个都要能被"回显"出来，否则无法证明它们来自配置而非写死
process.env.RRF_K = '77'
process.env.CANDIDATE_POOL_FACTOR = '5'

const { startFakeEmbeddingUpstream, semanticVectorFor } = await import(
  './fixtures/embedding-upstream.mjs'
)
const embeddingUpstream = await startFakeEmbeddingUpstream({ semantic: true })
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = embeddingUpstream.url
process.env.EMBEDDING_API_KEY = 'verify-retrieval-key'
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
  FULLTEXT_PATH_SKIPPED_TOO_SHORT,
  FULLTEXT_QUERY_MAX_CHARS,
  SNIPPET_WINDOW_CHARS,
  VECTOR_PATH_SKIPPED_MODEL_CHANGED,
  VECTOR_PATH_SKIPPED_NOT_READY,
  searchKnowledgeBaseResultSchema,
  uploadDocumentResultSchema,
} = await import('@doubulea/shared')
const { spawn } = await import('node:child_process')
const { URL: NodeURL } = await import('node:url')

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

/** 浮点断言：两端都是同一套 SQL 算出来的 **float8**，容差只为吃掉 JS 数字的表示误差 */
function assertClose(actual, expected, label, epsilon = 1e-9) {
  assert(
    typeof actual === 'number' && Math.abs(actual - expected) <= epsilon,
    `${label}：期望 ≈ ${expected}，实际 ${actual}`,
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
const PASSWORD = 'Verify-Retrieval-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-retrieval-admin-${suffix}`
const memberUsername = `verify-retrieval-member-${suffix}`
const EXPECTED_EMBEDDING_MODEL = 'api:verify-embed-model'

const sessionIds = []
const createdUserIds = []
const createdKbIds = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()
const s3 = getS3Client()
const bucket = config.s3.bucket
const queueKey = pipelineQueueKey()

/** 两路都来自配置的生效值（回显断言要用） */
const EXPECTED_RRF_K = 77
const EXPECTED_POOL_FACTOR = 5

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

/** 手搓 multipart（与 `verify-ingest.mjs` 同一手法：inject 只认 payload 字节） */
function multipart(name, { filename, contentType, value }) {
  const boundary = `----doubuleaRetrievalBoundary${Math.random().toString(16).slice(2)}`
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

async function upload(kbId, { cookie, bytes, fileName, contentType = 'text/plain' }) {
  const body = multipart('file', { filename: fileName, contentType, value: bytes })
  const response = await api('POST', `/api/knowledge-bases/${kbId}/documents`, {
    cookie,
    payload: body.payload,
    headers: { 'content-type': body.contentType },
  })
  assertEqual(response.statusCode, 200, `上传 ${fileName} 的状态码`)
  const data = uploadDocumentResultSchema.parse(response.json().data)
  return { docId: data.document.id, fileName }
}

/**
 * 检索（对 `POST /:id/search` 的唯一入口）。
 *
 * ⚠️ 返回 `{ response, data }` 且 `data` 只在 200 时解析 —— 新写断言时**照抄这里的形态**，
 * 不要凭手感去 `response.json().data` 再当成功路径用（P0-1-17 踩过：脚本自己的用法错会
 * 伪装成"被测代码坏了"，而报错信息指不到自己头上）。
 */
async function search(kbId, { cookie, body, expectStatus = 200 } = {}) {
  const response = await api('POST', `/api/knowledge-bases/${kbId}/search`, { cookie, payload: body })
  assertEqual(response.statusCode, expectStatus, `检索（${JSON.stringify(body)}）的状态码`)
  if (expectStatus !== 200) return { response }
  return { response, data: searchKnowledgeBaseResultSchema.parse(response.json().data) }
}

/** 文档行（要 fileKey 与 content 之外的信息时用它） */
async function docRow(docId) {
  const row = await prisma.document.findUnique({ where: { id: docId } })
  assert(row !== null, `文档 ${docId} 应当存在`)
  return row
}

/** 一个文档的 chunk 正文（引用片段的"原文"要从库里取，不能拿夹具自己算） */
async function chunkContentOf(docId) {
  const rows = await prisma.$queryRaw`
    SELECT id::text AS id, seq, content, meta::text AS meta FROM chunks WHERE doc_id = ${docId}::uuid ORDER BY seq
  `
  assertEqual(rows.length, 1, `夹具文档 ${docId} 应恰好 1 块（长度控制在 chunk_size 内）`)
  return rows[0]
}

async function listKeys(prefix) {
  const keys = []
  for await (const object of s3.listObjectsV2(bucket, prefix, true)) {
    if (object.name !== undefined) keys.push(object.name)
  }
  return keys
}

async function createKb(cookie, name, extra = {}) {
  const response = await api('POST', '/api/knowledge-bases', { cookie, payload: { name, ...extra } })
  assertEqual(response.statusCode, 200, `建库（${name}）状态码`)
  const kb = response.json().data
  createdKbIds.push(kb.id)
  return kb
}

async function patchKb(cookie, kbId, payload) {
  const response = await api('PATCH', `/api/knowledge-bases/${kbId}`, { cookie, payload })
  assertEqual(response.statusCode, 200, `改库（${JSON.stringify(payload)}）状态码`)
  return response.json().data
}

/** 跑一轮 worker 直到目标文档都不在 PARSING，然后停掉（脚本自己启停，不依赖外部进程） */
async function runWorkerUntilSettled(docIds) {
  startPipelineWorker()
  await waitFor(
    '目标文档全部离开 PARSING',
    async () => (await prisma.document.count({ where: { id: { in: docIds }, status: 'PARSING' } })) === 0,
    { timeoutMs: 60_000, intervalMs: 25 },
  )
  await waitFor(
    '队列清空且在途归零',
    async () => (await pipelineQueueDepth()) === 0 && getPipelineWorkerStats().inFlight === 0,
    { timeoutMs: 20_000, intervalMs: 25 },
  )
  await stopPipelineWorker(2_000)
}

// ───────────────────────────── 夹具正文 ─────────────────────────────

/**
 * 四篇夹具正文。三条硬约束（P0-1-18/19 各踩过一次，别"顺手精简"）：
 *   ① 每篇的**有效字符必须超过 `EMPTY_TEXT_THRESHOLD`（默认 50）**，否则会被 ④ 判成
 *      "疑似扫描件" ⇒ 整条链路（上传 → READY → 检索）的断言全部失去前提；
 *   ② 每篇必须**短于 `chunk_size`（默认 512）** ⇒ 恰好 1 块，于是"这块的正文是什么"
 *      可以逐字对照（多块的话检索返回哪一块就不确定了）；
 *   ③ 关键词只出现在**一篇**里 ⇒ `FULLTEXT` 模式必然是"恰好 1 条、名次 1"，
 *      这条是"两路真的在各自检索"的最硬证据。
 */
const QUERY = '出差住宿标准'

const DOCS = {
  /** 关键词所在的那一篇（命中位置**贴近文首** ⇒ 引用窗口被左侧裁掉） */
  expense: {
    fileName: '报销制度.txt',
    content:
      '第 1 号文档（报销制度）：出差住宿标准为每晚上限 500 元，超出部分需部门负责人审批后方可报销；' +
      '市内交通费按实际发生额计入，当月票据须在次月五日前提交财务备案，逾期不予受理。',
  },
  /** 不含关键词（用来证明"两路各自排序"，而不是"把库里所有块都返回了"） */
  attendance: {
    fileName: '考勤管理.txt',
    content:
      '第 2 号文档（考勤管理）：上下班时间为上午九点至下午六点，中午休息一小时；' +
      '忘记打卡需在次日内提交补卡申请，由直属主管确认后生效，每人每月补卡不得超过三次。',
  },
  vacation: {
    fileName: '休假规定.txt',
    content:
      '第 3 号文档（休假规定）：年假按工龄计算，入职满一年可享五天带薪年假，满三年可享十天；' +
      '年假需提前三个工作日申请，未休完的年假不跨年结转，也不折算工资。',
  },
  /** 长正文 + 关键词居中 ⇒ 引用窗口**两侧都完整**（验 ±80 字符的真实窗口） */
  long: {
    fileName: '长篇通知.txt',
    content:
      '第 4 号文档（长篇通知）：' +
      // ⚠️ 填充句**刻意不含标点**：B 组的"长 query 截断到 64 字符"用例要从这里取一段
      //    64 字符的**可字面命中**子串，而 query 会先被剔除标点 —— 若填充句里有标点，
      //    取出的窗口会与"剔标点后的 needle"对不上，那条用例就白测了。
      '这是一段用于填充长度的说明文字内容本身没有检索意义'.repeat(4) +
      '关键字锚点' +
      '这是一段用于填充长度的说明文字内容本身没有检索意义'.repeat(8),
  },
}
const LONG_QUERY = '关键字锚点'

/** 码点数组（本批所有长度/切片断言一律走它 —— `slice()` 会劈开代理对且本层不报错） */
const cps = (text) => [...text]

// ⚠️ 两份独立复算都必须带**副键 `id` 升序**：实现口径是"SQL 只按主键取池、
//    tie-break 交给 JS 的 `stableOrder`（score 降 + id 升）"——见
//    `src/services/retrieval.ts` 的 {@link stableOrder} 与 `vectorSearch` 的第 3 条
//    （SQL 里加第二键会让 HNSW 退化成显式排序，所以那一步只能在 JS 做）。
//    ⚠️ 少了这个副键，"逐条对照"就是一次**抛硬币**：假上游是词面重叠型向量 ⇒
//    与 query 无共同 bigram 的对照块**相似度恰好是 0**（不止一条并列）⇒ 两份查询
//    在并列段上的先后由 PG 的不稳定快排决定。P0-1-28 的全量回归就据此假红过一次
//    （本档单跑立刻复绿）。PG 的 uuid 比较是**无符号字节序**，而 `id::text` 是定宽小写
//    十六进制 ⇒ 与 JS 的字符串 `<` 同序，两边可以逐条对齐。

/** 独立复算：向量路（与实现同一条 SQL 形状，但不经任何业务代码） */
async function expectedVectorRows(kbId, query, limit) {
  const literal = `[${semanticVectorFor(query, config.embedding.dim).join(',')}]`
  return prisma.$queryRaw`
    SELECT c.id::text AS id, (1 - (c.embedding <=> ${literal}::vector))::float8 AS score
    FROM chunks c
    WHERE c.kb_id = ${kbId}::uuid AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${literal}::vector, c.id
    LIMIT ${limit}
  `
}

/** 独立复算：全文路（`bigm_similarity` + LIKE，与实现同形状） */
async function expectedFulltextRows(kbId, needle, limit) {
  return prisma.$queryRaw`
    SELECT c.id::text AS id, bigm_similarity(c.content, ${needle})::float8 AS score
    FROM chunks c
    WHERE c.kb_id = ${kbId}::uuid AND c.content LIKE '%' || ${needle} || '%'
    ORDER BY score DESC, c.id
    LIMIT ${limit}
  `
}

// ═════════════════════════════ 主流程 ═════════════════════════════

try {
  await createUser(adminUsername, UserRole.ADMIN)
  const adminCookie = await login(adminUsername)

  // `score: 0` 是**刻意的**：假上游给的是"词面重叠型"向量（cos ≈ 0.1~0.25），
  // 沿用默认阈值 0.3 会把候选全部过滤掉，"向量路能排第一"就无从观测。
  // 阈值的**行为**另有一条专门用例（改 score=1，见 B 组）。
  const kb = await createKb(adminCookie, `验证库-检索-${suffix}`, { retrievalConfig: { score: 0 } })

  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${memberUsername}（MEMBER）+ 若干知识库${c.x}`)
  console.log(
    `  ${c.d}注入配置：PIPELINE_QUEUE_KEY=${queueKey}｜RRF_K=${EXPECTED_RRF_K}｜` +
      `CANDIDATE_POOL_FACTOR=${EXPECTED_POOL_FACTOR}｜假 embedding 上游 ${embeddingUpstream.url}` +
      `（semantic，dim=${config.embedding.dim}）${c.x}`,
  )

  // 上传四篇并等 READY（检索的前提就是"库里有带向量的 chunk"）
  const uploaded = {}
  for (const [key, fixture] of Object.entries(DOCS)) {
    const result = await upload(kb.id, {
      cookie: adminCookie,
      bytes: Buffer.from(fixture.content, 'utf8'),
      fileName: fixture.fileName,
    })
    uploaded[key] = { ...result, content: fixture.content }
  }
  await runWorkerUntilSettled(Object.values(uploaded).map((item) => item.docId))

  // ═══════════════════════════════════════════════════════════════════
  // A 组 · 三模式 + 双路分数 + RRF + 引用片段
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── A 组 · 检索端点：FULLTEXT / VECTOR / HYBRID 三模式与六列 ──${c.x}`)

  await it('前置：四篇都 READY 且各有 1 块（每块都有向量）', async () => {
    for (const [key, fixture] of Object.entries(uploaded)) {
      const row = await docRow(fixture.docId)
      assertEqual(row.status, 'READY', `${key} 的状态`)
      assertEqual(row.chunkCount, 1, `${key} 的 chunk 数（夹具必须短于 chunk_size）`)
      const chunk = await chunkContentOf(fixture.docId)
      assertEqual(chunk.content, fixture.content, `${key} 的块正文应与夹具逐字一致`)
    }
    const withVector = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM chunks WHERE kb_id = ${kb.id}::uuid AND embedding IS NOT NULL
    `
    assertEqual(withVector[0].n, 4, '四块都应带向量')
  })

  await it('未登录 401 / 非法 UUID 400 / 空 query 400（先鉴权再校验，最后才谈业务）', async () => {
    const anonymous = await api('POST', `/api/knowledge-bases/${kb.id}/search`, {
      payload: { query: '报销' },
    })
    assertEqual(anonymous.statusCode, 401, '未登录')

    const badId = await api('POST', '/api/knowledge-bases/not-a-uuid/search', {
      cookie: adminCookie,
      payload: { query: '报销' },
    })
    assertEqual(badId.statusCode, 400, '非法知识库 id')

    const empty = await api('POST', `/api/knowledge-bases/${kb.id}/search`, {
      cookie: adminCookie,
      payload: { query: '   ' },
    })
    assertEqual(empty.statusCode, 400, '空 query')
    assertEqual(empty.json().msg, '请求参数校验失败', '顶层 msg 恒为这句（字段级详情在 data.fields）')
    assertIncludes(JSON.stringify(empty.json().data), '请输入检索内容', '字段级文案应落在 data.fields 里')

    const badMode = await api('POST', `/api/knowledge-bases/${kb.id}/search`, {
      cookie: adminCookie,
      payload: { query: '报销', mode: 'SEMANTIC' },
    })
    assertEqual(badMode.statusCode, 400, '非法 mode')
  })

  await it('**FULLTEXT 单独跑中文 query 非空**（`子方案①` §十二 的必测坑：证明 pg_bigm 生效）', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, mode: 'FULLTEXT' } })
    assertEqual(data.mode, 'FULLTEXT', '回显的生效模式')
    assertEqual(data.vectorPathSkipped, true, 'FULLTEXT 模式本来就不走向量路')
    assert(data.items.length >= 1, `中文 query 必须能命中（否则说明 bigm 索引/算子类没生效），实际 ${data.items.length} 条`)
    assertEqual(data.items[0].docName, DOCS.expense.fileName, '命中应当是含关键词的那一篇')
    assertEqual(data.items[0].fulltextRank, 1, '全文路名次')
    assert(data.items[0].fulltextScore > 0, `全文路分数应为正数，实际 ${data.items[0].fulltextScore}`)
    // 没走的那些路必须是 `null`（而不是 0）—— 前端据此显示 `—`
    assertEqual(data.items[0].vectorScore, null, 'FULLTEXT 模式下不该有向量分')
    assertEqual(data.items[0].vectorRank, null, 'FULLTEXT 模式下不该有向量名次')
  })

  await it('全文路的名次与分数 == **独立复算**的 `bigm_similarity` SQL（证明用的是 bigm）', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, mode: 'FULLTEXT' } })
    const expected = await expectedFulltextRows(kb.id, QUERY, data.candidatePool)
    assertEqual(expected.length, data.items.length, '候选条数应与独立 SQL 一致（库里只有一篇含这个关键词）')
    for (const [index, row] of expected.entries()) {
      assertEqual(data.items[index].chunkId, row.id, `第 ${index + 1} 条的块 id`)
      assertClose(data.items[index].fulltextScore, row.score, `第 ${index + 1} 条的全文分`)
    }
  })

  await it('**VECTOR 模式：含关键词的那一块排第一**（向量路是一路真检索，不是摆设）', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, mode: 'VECTOR', topK: 3 } })
    assertEqual(data.mode, 'VECTOR', '回显的生效模式')
    assertEqual(data.vectorPathSkipped, false, 'VECTOR 模式下向量路必须真的跑了')
    const top = data.items[0]
    assertEqual(top?.docName, DOCS.expense.fileName, '向量路第一应当也是含关键词的那一篇')
    assertEqual(top?.vectorRank, 1, '向量路名次')
    for (const item of data.items.slice(1)) {
      // 这是"向量路真的在按相似度排"的硬证据：含关键词的那一块必须**严格更近**。
      // ⚠️ 不等于"任何一块都 > 0"：正交的两块余弦相似度**恰好是 0**（合法取值），
      //    写成 `> 0` 会在"这一块与 query 毫无共同 bigram"时假失败（本脚本首轮就跑出来过）。
      assert(
        item.vectorScore !== null && item.vectorScore < top.vectorScore,
        `${item.docName} 的向量分（${item.vectorScore}）应当严格低于含关键词那一块（${top.vectorScore}）`,
      )
      assertEqual(item.fulltextScore, null, 'VECTOR 模式下不该有全文分')
      assertEqual(item.fulltextRank, null, 'VECTOR 模式下不该有全文名次')
    }
    // ⚠️ 这条断言的边界（写进 issue_fix）：假上游是**词面重叠型**向量，
    //    它证明的是"query 向量 → 余弦距离 → 名次"这条**链路**是对的，
    //    不证明模型的语义质量（那要真 embedding 模型）。
  })

  await it('向量路的名次与分数 == **独立复算**的 `<=>` SQL（逐条对照）', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, mode: 'VECTOR', topK: 4 } })
    const expected = await expectedVectorRows(kb.id, QUERY, data.candidatePool)
    assertEqual(expected.length, 4, '前置：库内 4 块都该进候选池（score=0 ⇒ 不做下限过滤）')
    assertEqual(data.items.length, 4, 'topK=4 ⇒ 四块都返回')
    for (const [index, row] of expected.entries()) {
      assertEqual(data.items[index].chunkId, row.id, `第 ${index + 1} 条的块 id（名次应与独立 SQL 一致）`)
      assertClose(data.items[index].vectorScore, row.score, `第 ${index + 1} 条的向量分`)
      assertEqual(data.items[index].vectorRank, index + 1, `第 ${index + 1} 条的名次`)
    }
  })

  await it('**HYBRID：两路共同认可的那一块排第一**，且六列齐备、分数逐条可算', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY } }) // 不给 mode ⇒ 用库快照的默认
    assertEqual(data.mode, 'HYBRID', '库快照的默认 mode')
    assertEqual(data.rrfK, EXPECTED_RRF_K, '`rrfK` 应取**该库快照**（建库时来自 RRF_K）而不是进程默认 60')
    assertEqual(data.candidatePool, data.topK * EXPECTED_POOL_FACTOR, '候选池 = topK × CANDIDATE_POOL_FACTOR')

    const top = data.items[0]
    assertEqual(top?.docName, DOCS.expense.fileName, '双路都排第一的那一块应当融合后也第一')
    assertEqual(top?.vectorRank, 1, '它应当在向量路第一')
    assertEqual(top?.fulltextRank, 1, '它应当在全文路第一')
    assertClose(
      top?.rrfScore,
      top.vectorRank === null ? 0 : 1 / (data.rrfK + top.vectorRank) + 1 / (data.rrfK + (top.fulltextRank ?? 0)),
      '两路都命中的 RRF 分（k=77 时 2/78）',
    )

    // RRF 的全部内容就是这个公式：逐条反算，一条都不能差
    for (const item of data.items) {
      const expected =
        (item.vectorRank === null ? 0 : 1 / (data.rrfK + item.vectorRank)) +
        (item.fulltextRank === null ? 0 : 1 / (data.rrfK + item.fulltextRank))
      assertClose(item.rrfScore, expected, `块 ${item.chunkId.slice(0, 8)} 的 rrfScore 反算`)
      assertEqual(item.page, null, 'txt 非分页 ⇒ page 恒为 null')
      assertEqual(item.headingPath.length, 0, 'txt 无标题层级 ⇒ headingPath 为空数组')
    }
  })

  await it('融合排序：`finalRank` 连续、与 `rrfScore` 降序一致、条数 ≤ topK', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, topK: 2 } })
    assertEqual(data.items.length, 2, 'topK=2 的截断')
    assertEqual(data.items.map((item) => item.finalRank).join(','), '1,2', 'finalRank 必须连续（界面按它排序）')
    for (let index = 1; index < data.items.length; index += 1) {
      assert(
        data.items[index - 1].rrfScore >= data.items[index].rrfScore,
        `第 ${index} 与第 ${index + 1} 条的 rrfScore 应降序：${data.items.map((item) => item.rrfScore).join(' , ')}`,
      )
    }
    // 只有 1 篇含关键词 ⇒ 全文路只贡献 1 条，"缺失即无贡献"的另一条结果必须是**纯向量分**
    const vectorOnly = data.items.find((item) => item.fulltextRank === null)
    if (vectorOnly !== undefined) {
      assertEqual(vectorOnly.fulltextScore, null, '未命中全文路的块，全文分必须是 null 而不是 0')
      assertClose(vectorOnly.rrfScore, 1 / (data.rrfK + vectorOnly.vectorRank), '纯向量路的 RRF 分')
      assert(vectorOnly.rrfScore < data.items[0].rrfScore, '单路命中应当输给双路共同认可（RRF 的设计意图）')
    }
  })

  await it('引用片段：命中居中 ⇒ ±80 字符窗口完整；命中贴边 ⇒ 左侧裁剪', async () => {
    // ① 长正文 + 关键词居中：窗口两侧都完整
    const long = await search(kb.id, {
      cookie: adminCookie,
      body: { query: LONG_QUERY, mode: 'FULLTEXT' },
    })
    const longItem = long.data.items[0]
    assertEqual(longItem?.docName, DOCS.long.fileName, '长正文应当被命中')
    const longChunk = await chunkContentOf(uploaded.long.docId)
    const longCps = cps(longChunk.content)
    const at = longCps.join('').indexOf(LONG_QUERY)
    assert(at > SNIPPET_WINDOW_CHARS, `前置：关键词位置（${at}）应当离文首足够远`)
    assertEqual(
      longItem.snippet,
      longCps.slice(at - SNIPPET_WINDOW_CHARS, at + cps(LONG_QUERY).length + SNIPPET_WINDOW_CHARS).join(''),
      '居中命中：片段应当正好是"命中位置前后各 80 字符"',
    )
    assertEqual(
      cps(longItem.snippet).length,
      SNIPPET_WINDOW_CHARS * 2 + cps(LONG_QUERY).length,
      '窗口长度按**码点**算',
    )

    // ② 关键词贴近文首：窗口在 0 处裁剪（不能出现负数下标导致的空片段）
    const expense = await search(kb.id, {
      cookie: adminCookie,
      body: { query: QUERY, mode: 'FULLTEXT' },
    })
    const expenseItem = expense.data.items[0]
    const expenseChunk = await chunkContentOf(uploaded.expense.docId)
    const expenseCps = cps(expenseChunk.content)
    const expenseAt = expenseCps.join('').indexOf(QUERY)
    assert(expenseAt >= 0 && expenseAt < SNIPPET_WINDOW_CHARS, `前置：关键词应当靠近文首（实际下标 ${expenseAt}）`)
    assertEqual(
      expenseItem.snippet,
      expenseCps.slice(0, expenseAt + cps(QUERY).length + SNIPPET_WINDOW_CHARS).join(''),
      '贴边命中：窗口从文首开始',
    )
    assert(expenseItem.snippet.startsWith(expenseCps[0]), '片段必须从原文的第一个字符开始（不加工、不加省略号）')

    // ③ 逐字一致：每一条的片段都必须是它自己那一块正文的子串（引用可核对的前提）
    for (const item of [...long.data.items, ...expense.data.items]) {
      const chunk = await prisma.$queryRaw`
        SELECT content FROM chunks WHERE id = ${item.chunkId}::uuid
      `
      assertIncludes(chunk[0].content, item.snippet, `块 ${item.chunkId.slice(0, 8)} 的片段应当是原文子串`)
    }
  })

  await it('字面未命中时（向量路命中）片段取**块首**窗口，仍然是原文子串', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, mode: 'VECTOR', topK: 4 } })
    const other = data.items.find((item) => item.docName === DOCS.attendance.fileName)
    assert(other !== undefined, '前置：考勤那一篇应当出现在向量路结果里')
    const chunk = await chunkContentOf(uploaded.attendance.docId)
    assertEqual(
      other.snippet,
      cps(chunk.content).slice(0, SNIPPET_WINDOW_CHARS * 2).join(''),
      '没有字面命中时取块首窗口（没有"命中位置"可取，块首是唯一稳定的选择）',
    )
    assert(!other.snippet.includes(QUERY), '前置：这一块的正文里确实没有字面命中')
  })

  await it('检索 < 500ms（`01` §四 的性能门槛；含 query 的 embedding 调用与两条 SQL）', async () => {
    const wallStart = nowMs()
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY } })
    const wall = nowMs() - wallStart
    assert(data.elapsedMs < 500, `服务端自报耗时 ${data.elapsedMs}ms 应 < 500ms`)
    assert(wall < 500, `墙钟耗时 ${wall}ms 应 < 500ms（含 inject 开销）`)
    console.log(`         ${c.d}elapsedMs=${data.elapsedMs}ms｜墙钟=${wall}ms${c.x}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  // B 组 · 生效配置：阈值、候选池、参数来源
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── B 组 · 生效配置：相似度下限 / 候选池 / 参数取自该库快照 ──${c.x}`)

  await it('`score` 是**向量路的相似度下限**：置 1 时向量路被全部过滤，全文路不受影响', async () => {
    await patchKb(adminCookie, kb.id, { retrievalConfig: { score: 1 } })
    try {
      const vectorOnly = await search(kb.id, {
        cookie: adminCookie,
        body: { query: QUERY, mode: 'VECTOR', topK: 4 },
      })
      assertEqual(vectorOnly.data.items.length, 0, 'score=1 ⇒ 只有与 query 完全同向的块能过，本用例应当一条不剩')
      assertEqual(vectorOnly.data.vectorPathSkipped, false, '⚠️ 是"跑了但被下限过滤"，不是"没跑"')

      // 全文路没有"相似度下限"这回事（bigm_similarity 与 cosine 不可比），所以它照常返回
      const fulltext = await search(kb.id, {
        cookie: adminCookie,
        body: { query: QUERY, mode: 'FULLTEXT' },
      })
      assertEqual(fulltext.data.items.length, 1, '全文路不受向量路阈值影响')
    } finally {
      await patchKb(adminCookie, kb.id, { retrievalConfig: { score: 0 } })
    }
  })

  await it('单次请求的 `topK`/`mode` 覆盖**不落库**（试查页不能污染该库的检索口径）', async () => {
    const before = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    const configBefore = JSON.stringify(before.json().data.retrievalConfig)

    const overridden = await search(kb.id, {
      cookie: adminCookie,
      body: { query: QUERY, mode: 'FULLTEXT', topK: 1 },
    })
    assertEqual(overridden.data.mode, 'FULLTEXT', '本次生效模式')
    assertEqual(overridden.data.topK, 1, '本次生效 topK')
    assertEqual(overridden.data.items.length, 1, 'topK=1 的截断')

    const after = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(JSON.stringify(after.json().data.retrievalConfig), configBefore, '库里的检索配置必须逐字不变')
    assertEqual(after.json().data.retrievalConfig.mode, 'HYBRID', '库里的 mode 仍是建库快照的 HYBRID')
  })

  await it('空库检索 → 200 + 空结果（不是 500，也不是"错误"）', async () => {
    const emptyKb = await createKb(adminCookie, `验证库-空-${suffix}`, { retrievalConfig: { score: 0 } })
    const { data } = await search(emptyKb.id, { cookie: adminCookie, body: { query: QUERY } })
    assertEqual(data.items.length, 0, '空库没有任何候选')
    assertEqual(data.vectorPathSkipped, false, '向量路跑了，只是没有行')
    assertEqual(JSON.stringify(data.warnings), '[]', '没有需要告警的事：空库是正常状态')
  })

  await it('有效字符不足 2 个 ⇒ 全文路跳过并**告警**；向量路照常（HYBRID 不会因此报错）', async () => {
    const hybrid = await search(kb.id, { cookie: adminCookie, body: { query: '报' } })
    assertIncludes(JSON.stringify(hybrid.data.warnings), FULLTEXT_PATH_SKIPPED_TOO_SHORT, '应给出跳过全文路的告警')
    assertEqual(hybrid.data.vectorPathSkipped, false, 'HYBRID 下向量路仍在跑')
    assert(hybrid.data.items.length >= 1, '向量路仍能给出候选（这正是"缺失即无贡献"的场景）')
    for (const item of hybrid.data.items) {
      assertEqual(item.fulltextRank, null, '全文路没跑 ⇒ 全文名次全为 null')
      assertClose(item.rrfScore, 1 / (hybrid.data.rrfK + item.vectorRank), 'RRF 分只剩向量路那一项')
    }

    const fulltextOnly = await search(kb.id, { cookie: adminCookie, body: { query: '报', mode: 'FULLTEXT' } })
    assertEqual(fulltextOnly.data.items.length, 0, 'FULLTEXT 模式 + 全文路跳过 ⇒ 空结果（而不是报错）')
    assertIncludes(
      JSON.stringify(fulltextOnly.data.warnings),
      FULLTEXT_PATH_SKIPPED_TOO_SHORT,
      '空结果必须附带原因，否则用户会以为"库里没有"',
    )
  })

  await it('纯标点 query → 规范化后为空 ⇒ 与"过短"同一条路（不 500）', async () => {
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: '？？！……' } })
    assertIncludes(JSON.stringify(data.warnings), FULLTEXT_PATH_SKIPPED_TOO_SHORT, '告警')
    assert(data.items.length >= 1, '向量路仍在跑（query 原样 embed，不做改写）')
  })

  await it('长 query 截断到 64 字符（全文路）：**截断才有命中**，且截断上限真的生效', async () => {
    // 构造：前 64 个字符是长正文里的一段**无标点**子串（必然可字面命中），后面接一段长后缀
    //       ⇒ 不截断则一条都命不中。于是"命中"这件事**只能**由那次截断解释。
    const longChunk = await chunkContentOf(uploaded.long.docId)
    const longCps = cps(longChunk.content)
    const keywordAt = longCps.join('').indexOf(LONG_QUERY)
    assert(keywordAt >= 0, '前置：长正文里应当有锚点关键词')
    const window64 = longCps.slice(keywordAt, keywordAt + FULLTEXT_QUERY_MAX_CHARS).join('')
    assertEqual(cps(window64).length, FULLTEXT_QUERY_MAX_CHARS, '前置：窗口恰好 64 个字符')
    const overLongQuery = `${window64}这是一段超出上限的后缀文字本来不可能被字面命中`
    assert(cps(overLongQuery).length > FULLTEXT_QUERY_MAX_CHARS, '前置：query 应当超过 64 字符')

    // 对照：**不截断**时一条都命不中（独立 SQL 复算，不经业务代码）
    const untruncated = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM chunks
      WHERE kb_id = ${kb.id}::uuid AND content LIKE '%' || ${overLongQuery} || '%'
    `
    assertEqual(untruncated[0].n, 0, '前置：整条 query 太长，字面必然命不中')

    const { data } = await search(kb.id, {
      cookie: adminCookie,
      body: { query: overLongQuery, mode: 'FULLTEXT' },
    })
    assertEqual(data.items.length, 1, '截断到 64 字符后应当命中（命中只能来自这次截断）')
    assertEqual(data.items[0].docName, DOCS.long.fileName, '命中的是长正文那一篇')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C 组 · §八 的降级路径（换模型 / 未就绪）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── C 组 · 降级路径：库快照模型 ≠ 当前模型 / embedding 未就绪 ──${c.x}`)

  await it('模型变更（模拟换过模型）⇒ HYBRID 降级为全文检索 + 告警，**不是 500**', async () => {
    // 用一次 DB 更新模拟"这个库的向量是旧模型产的"：真实场景里 provider 换模型后，
    // 快照与当前 `name()` 就会这样不一致（§八 ① 的探测输入）。
    await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: { embeddingModel: 'api:legacy-embed-model' },
    })
    try {
      const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY } })
      assertEqual(data.mode, 'HYBRID', '请求的模式不变')
      assertEqual(data.vectorPathSkipped, true, '向量路必须被跳过')
      assertIncludes(JSON.stringify(data.warnings), VECTOR_PATH_SKIPPED_MODEL_CHANGED, '必须给出可展示的原因')
      assert(data.items.length >= 1, '全文路应当把结果兜住（降级而不是不可用）')
      assertEqual(data.items[0].docName, DOCS.expense.fileName, '降级后仍然命中正确的那一篇')
      for (const item of data.items) assertEqual(item.vectorRank, null, '跳过的路径不参与融合')
    } finally {
      await prisma.knowledgeBase.update({
        where: { id: kb.id },
        data: { embeddingModel: EXPECTED_EMBEDDING_MODEL },
      })
    }
  })

  await it('模型变更 + `mode=VECTOR` ⇒ **409**（没有可退的路，返回空会被读成"库里没有"）', async () => {
    await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: { embeddingModel: 'api:legacy-embed-model' },
    })
    try {
      const { response } = await search(kb.id, {
        cookie: adminCookie,
        body: { query: QUERY, mode: 'VECTOR' },
        expectStatus: 409,
      })
      assertIncludes(response.json().msg, VECTOR_PATH_SKIPPED_MODEL_CHANGED, '沿用同一条原因文案')
      assertIncludes(response.json().msg, 'VECTOR', '并说明"当前模式无法降级"')

      // 而 FULLTEXT 模式根本不碰 embedding ⇒ 模型变更不影响它
      const fulltext = await search(kb.id, {
        cookie: adminCookie,
        body: { query: QUERY, mode: 'FULLTEXT' },
      })
      assertEqual(fulltext.data.items.length, 1, 'FULLTEXT 模式与 embedding 模型无关')
    } finally {
      await prisma.knowledgeBase.update({
        where: { id: kb.id },
        data: { embeddingModel: EXPECTED_EMBEDDING_MODEL },
      })
    }
  })

  await it('embedding 未就绪（子进程注入空配置）⇒ HYBRID 降级告警 / VECTOR 报 500', async () => {
    // 必须起**子进程**：`config` 是模块级单例（import 即完成校验），父进程里改 env 改不动它，
    // 而且会污染同脚本后面的用例（P0-1-13 的第五档手法）。
    const child = await runChild(
      [
        `const { searchKnowledgeBase } = await import('${distUrl('services/retrieval.js')}')`,
        `const out = {}`,
        `try {`,
        `  const r = await searchKnowledgeBase({ kbId: process.env.PROBE_KB_ID, query: process.env.PROBE_QUERY })`,
        `  out.hybrid = { count: r.items.length, skipped: r.vectorPathSkipped, warnings: r.warnings }`,
        `} catch (error) { out.hybrid = { error: error.code ?? String(error) } }`,
        `try {`,
        `  const r = await searchKnowledgeBase({ kbId: process.env.PROBE_KB_ID, query: process.env.PROBE_QUERY, mode: 'FULLTEXT' })`,
        `  out.fulltext = { count: r.items.length, skipped: r.vectorPathSkipped }`,
        `} catch (error) { out.fulltext = { error: error.code ?? String(error) } }`,
        `try {`,
        `  await searchKnowledgeBase({ kbId: process.env.PROBE_KB_ID, query: process.env.PROBE_QUERY, mode: 'VECTOR' })`,
        `  out.vector = { ok: true }`,
        `} catch (error) { out.vector = { error: error.code ?? String(error), message: error.message } }`,
        `console.log('RESULT ' + JSON.stringify(out))`,
        `const { closePrisma } = await import('${distUrl('infra/prisma.js')}')`,
        `await closePrisma()`,
      ].join('\n'),
      {
        EMBEDDING_MODE: 'api',
        EMBEDDING_API_URL: '',
        EMBEDDING_API_KEY: '',
        EMBEDDING_API_MODEL: '',
        PROBE_KB_ID: kb.id,
        PROBE_QUERY: QUERY,
      },
    )

    assertEqual(child.result.hybrid.skipped, true, 'HYBRID 应跳过向量路')
    assertIncludes(
      JSON.stringify(child.result.hybrid.warnings),
      VECTOR_PATH_SKIPPED_NOT_READY,
      '降级原因必须是"未就绪"这条（与"模型变更"分开：一个要运维修，一个要业务重建）',
    )
    assert(child.result.hybrid.count >= 1, '降级后全文路仍应给出结果')
    assertEqual(child.result.fulltext.error, undefined, 'FULLTEXT 不碰 embedding ⇒ 未就绪也能用')
    assertEqual(child.result.vector.error, 'INTERNAL', 'VECTOR 模式在"服务端没配好"时是 500（不是 409）')
    assertIncludes(child.result.vector.message, VECTOR_PATH_SKIPPED_NOT_READY, '报错文案')
  })

  // ═══════════════════════════════════════════════════════════════════
  // D 组 · 权限与边界
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── D 组 · 权限与边界：MEMBER 可检索、跨库/幽灵库 404 ──${c.x}`)

  await it('**MEMBER 能检索**（权限=登录即可；用最低权限账号守门，ADMIN 验不出 requireAdmin 的误加）', async () => {
    const member = await createUser(`${memberUsername}-a`, UserRole.MEMBER)
    assertEqual(member.role, UserRole.MEMBER, '前置：确实是 MEMBER')
    const memberCookie = await login(`${memberUsername}-a`)
    const { data } = await search(kb.id, { cookie: memberCookie, body: { query: QUERY } })
    assert(data.items.length >= 1, 'MEMBER 应能检索到内容')
  })

  await it('不存在的知识库 → 404（不泄露库是否存在之外的任何信息）', async () => {
    const { response } = await search('0198f0aa-9999-7000-8000-0000000000ff', {
      cookie: adminCookie,
      body: { query: QUERY },
      expectStatus: 404,
    })
    assertIncludes(response.json().msg, '知识库不存在', '文案')
  })

  await it('检索**不会**串到别的库（另一个库里的同名内容搜不到）', async () => {
    const otherKb = await createKb(adminCookie, `验证库-隔离-${suffix}`, { retrievalConfig: { score: 0 } })
    const other = await upload(otherKb.id, {
      cookie: adminCookie,
      bytes: Buffer.from(DOCS.expense.content, 'utf8'),
      fileName: '另一份报销制度.txt',
    })
    await runWorkerUntilSettled([other.docId])
    const { data } = await search(kb.id, { cookie: adminCookie, body: { query: QUERY, mode: 'FULLTEXT' } })
    assertEqual(data.items.length, 1, '本库只应返回自己的那一篇')
    assertEqual(data.items[0].docName, DOCS.expense.fileName, '不该返回另一个库里的同名文件')
  })

  await it('`LIKE` 的子串里不可能出现通配符（`%` 被规范化剔除）——用"5%0"做判别', async () => {
    // 判别式的构造是关键：正文里**同时有 5 和 0、但两者永不相邻**。
    //   · `%` 被剔除（本仓实现）⇒ needle = "50" ⇒ `content LIKE '%50%'` ⇒ **0 条**
    //   · `%` 被当成通配符      ⇒ `content LIKE '%5%0%'` ⇒ **1 条**（"5…0" 它就能匹配）
    // 两条路的期望值不同，这条断言才有判别力（若正文里含 "50"，两种实现都命中，就白测了）。
    const trickKb = await createKb(adminCookie, `验证库-通配符-${suffix}`, { retrievalConfig: { score: 0 } })
    const trick = await upload(trickKb.id, {
      cookie: adminCookie,
      bytes: Buffer.from(
        '第 5 号文档（通配符用例）：本段正文里出现了数字 5 与数字 0，但两者之间隔着' +
          '若干字符并不相邻，另加一段足够长的说明文字让空文本检测放行。',
        'utf8',
      ),
      fileName: '通配符用例.txt',
    })
    await runWorkerUntilSettled([trick.docId])

    const literal = await search(trickKb.id, { cookie: adminCookie, body: { query: '50', mode: 'FULLTEXT' } })
    assertEqual(literal.data.items.length, 0, '前置：正文里没有相邻的 "50" ⇒ 字面查询也该是 0 条')
    assertEqual(JSON.stringify(literal.data.warnings), '[]', '⚠️ 是"跑了没命中"，不是"被跳过"（query 有 2 个字符）')

    const wildcard = await search(trickKb.id, { cookie: adminCookie, body: { query: '5%0', mode: 'FULLTEXT' } })
    assertEqual(
      wildcard.data.items.length,
      0,
      '`5%0` 规范化后是 `50` ⇒ 0 条；若这里出了 1 条，说明 `%` 被当成了 LIKE 通配符（模式匹配）',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  // E 组 · 自清理 + 残留复核
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── E 组 · 清场：删库双清、队列键不残留 ──${c.x}`)

  await it('摘录一条 SQL 计划（信息性）：本档不代替 P0-1-14 的索引取证', async () => {
    // ⚠️ 索引**可用性**（"算子类建对了没有"）由 `verify:knowledge` 的三条 EXPLAIN 断言守着
    //    （P0-1-14），这里只把"带上 kb_id 限定之后的真实计划"打出来供人工核对 ——
    //    小表上 PG 会理性地选 `chunks_kb_id_idx` + 过滤，那不是索引坏了（见 P0-1-14 的取证说明）。
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      const rows = await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF) SELECT id FROM chunks WHERE kb_id = $1::uuid AND content LIKE '%' || $2 || '%'`,
        kb.id,
        QUERY,
      )
      return rows.map((row) => row['QUERY PLAN']).join('\n')
    })
    console.log(`         ${c.d}${plan.split('\n').join('｜')}${c.x}`)
    assert(plan.length > 0, 'EXPLAIN 应当有输出')
  })

  await it('删库 → documents / chunks / S3 对象三清（检索过的库不留任何残留）', async () => {
    assert((await listKeys(`kb/${kb.id}/`)).length > 0, '前置：库内应有对象')
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
  console.log(`${c.g}${c.b}✅ P0-1-20 双路检索 + RRF 融合验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-20 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}

// ───────────────────────────── 子进程工具（第五档：注入环境变量）─────────────────────────────

/** `dist/backend/src/...` 的 file:// URL（`-e` 里只能动态 import URL 或不含反斜杠的路径） */
function distUrl(relative) {
  return new NodeURL(`../dist/backend/src/${relative}`, import.meta.url).href
}

/**
 * 起一个**纯净子进程**跑一段代码，并取回它打印的 `RESULT <json>`。
 *
 * ⚠️ 必须用**异步** `spawn`：`spawnSync` 会钉死父进程事件循环（P0-1-13 踩过）—— 而本脚本的
 * 父进程里还挂着一个假上游的 HTTP 服务，同步阻塞会让子进程的请求永远等不到应答。
 */
function runChild(code, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ...extraEnv },
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
    child.on('close', (status) => {
      const line = stdout.split('\n').find((item) => item.startsWith('RESULT '))
      if (line === undefined) {
        reject(new Error(`子进程未给出结果（exit=${status}）\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      try {
        resolve({ status, result: JSON.parse(line.slice('RESULT '.length)), stdout, stderr })
      } catch (error) {
        reject(new Error(`子进程结果不是 JSON：${line}（${String(error)}）`))
      }
    })
  })
}
