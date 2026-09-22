#!/usr/bin/env node
/**
 * verify-kb-package.mjs —— **P0-1-21 知识库包验收**（包 D 收口）
 *
 * 逐行跑 `docs/子方案/知识库流水线.md` §十二 的验收清单，每行一个组：
 *   R1 15 KB CRUD      建库（设 topK/阈值）→ 改名 → 删库（级联清 chunks 与 S3 原文件）
 *   R2 16 文档上传      pdf/docx/md/txt 各 1 篇 → PARSING→READY、chunk 数合理；
 *                      扫描件 → FAILED 且提示「疑似扫描件」；`.doc` → 拒绝并提示另存为 .docx
 *   R3 16 失败可重试    造一个失败文档 → 重试 → 转 READY，chunk 正确入库
 *   R4 17 覆盖重建      同文档传 v2 → 文档 id 不变、**无重复、无孤儿**；**用真检索端点**验"返回 v2"
 *   R5 18 检索测试      中文 query：双路得分 + **融合排名**均可见
 *   R6 19 引用格式      引用片段与原文一致可核对（片段 ⊆ 原文、且含命中的词）
 *   R7 性能            单条 embedding < 500ms；检索 < 500ms
 *   R8 §十二 必测的坑   `mode=FULLTEXT` **单独**跑中文 query 非空（证明 pg_bigm 生效）
 *   R9 清场            自清理 + 残留复核
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么还要一个"包级"脚本（前面每批都有各自的验收）
 * ─────────────────────────────────────────────────────────────────────
 * 前面每一档验的是**一个批次**的产出（上传的校验、队列的幂等、入库的形态、检索的分数…），
 * 而"这个包能不能交付"问的是**串起来之后**还成不成立 —— 例如：
 *   · R4 的"检索返回 v2"只有在"重建 → worker → 检索"三段都真跑时才有意义
 *     （P0-1-19 时它只能靠 `<=>` SQL 做等价取证，因为检索端点还没落地）；
 *   · R2 的"PARSING→READY"这条状态流转，只有"上传入队 + 真 worker + 真 embedding + 真入库"
 *     四件事都在，才会真的发生。
 * 所以本脚本**不重复**各档的细粒度断言，只跑这 8 行要的**端到端**证据，并逐行打印结论。
 *
 * ⚠️ 三处注入（与 `verify-ingest` / `verify-retrieval` 同款）
 *   · 假 embedding 上游（`semantic: true`）：本机 `.env` 三项为空 ⇒ 不接上就没有 `READY`；
 *   · 队列键换随机值（Redis 共享，默认键会被跑着的 dev server 抢走任务）；
 *   · `LOG_LEVEL=fatal`：R3 会**故意**打挂上游。要看细节：`LOG_LEVEL=debug pnpm verify:kb-package`。
 *
 * ⚠️ 跑之前先起依赖：`pnpm infra:up && pnpm db:deploy`（PG + Redis + MinIO 都要）
 * ⚠️ 本脚本**自己启停 worker**，不要同时开着 `pnpm dev:backend` 跑同一批数据。
 */

process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'
process.env.PIPELINE_QUEUE_KEY = `verify:kb-package:jobs:${Math.random().toString(36).slice(2, 8)}`

const { startFakeEmbeddingUpstream } = await import('./fixtures/embedding-upstream.mjs')
const embeddingUpstream = await startFakeEmbeddingUpstream({ semantic: true })
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = embeddingUpstream.url
process.env.EMBEDDING_API_KEY = 'verify-kb-package-key'
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
const { getEmbeddingProvider } = await import('../dist/backend/src/llm/embedding/index.js')
const { closePipelineQueue, pipelineQueueDepth, pipelineQueueKey } = await import(
  '../dist/backend/src/pipeline/queue.js'
)
const { startPipelineWorker, stopPipelineWorker, getPipelineWorkerStats } = await import(
  '../dist/backend/src/pipeline/worker.js'
)
const {
  LEGACY_DOC_HINT,
  documentListResultSchema,
  isDocumentSearchable,
  removeKnowledgeBaseResultSchema,
  reuploadDocumentResultSchema,
  searchKnowledgeBaseResultSchema,
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

// ───────────────────────────── 常量与临时数据 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-KbPackage-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-kbpkg-admin-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdKbIds = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()
const s3 = getS3Client()
const bucket = config.s3.bucket
const queueKey = pipelineQueueKey()

// ───────────────────────────── 夹具 ─────────────────────────────

/**
 * 四篇夹具 + 两处长度约束（都是前面批次踩过的坑，别"顺手精简"）：
 *   ① **有效字符必须 > `EMPTY_TEXT_THRESHOLD`（默认 50）**，否则被 ④ 判成"疑似扫描件"，
 *      R2 的"四篇全 READY"会整组假失败（P0-1-18/19 各踩一次）；
 *   ② PDF 的**每一行必须短于页面宽度**（`makePdf` 每个元素是**一行**，单行超 `MediaBox` 时
 *      pdf.js **静默截断** —— 单行 1000 字实测只析出 78 字），故长内容要**折行**。
 * 另：R6 要断言"片段与原文一致"，所以每篇只放**一个**独特关键词，且它只出现在一篇里。
 */
const FIXTURES = {
  txt: {
    fileName: '运维值班制度.txt',
    contentType: 'text/plain',
    /** 独特关键词（**不含空格/标点**：全文路是字面子串匹配，query 会先剔掉标点） */
    keyword: '机房温度超标须立即上报',
    bytes: Buffer.from(
      '运维值班制度：机房温度超标须立即上报，交接班必须核对巡检记录。' +
        '夜间巡检每两小时一次，发现异常先上报后处理，不得擅自重启核心设备。' +
        '值班交接需填写交接班记录表，未填写视为未完成交接。',
      'utf8',
    ),
  },
  md: {
    fileName: '考勤制度.md',
    contentType: 'text/markdown',
    keyword: '迟到超过三十分钟记旷工',
    bytes: Buffer.from(
      [
        '# 员工手册',
        '',
        '本手册适用于全体在职员工，自发布之日起执行。',
        '',
        '## 考勤制度',
        '',
        '迟到超过三十分钟记旷工，需在当日提交情况说明。',
        '忘记打卡应当在次日内提交补卡申请，由直属主管确认。',
        '',
        '### 外出与出差',
        '',
        '外出办公需提前报备，出差须填写出差申请单。',
        '',
        '## 附则',
        '',
        '本制度由人力资源部负责解释。',
      ].join('\n'),
      'utf8',
    ),
  },
  docx: {
    fileName: '报销制度.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    keyword: '出差住宿标准为每晚上限五百元',
    bytes: fixtures.makeDocx([
      { level: 1, text: '报销制度' },
      { text: '本制度适用于全体员工因公产生的费用报销。' },
      { level: 2, text: '差旅费' },
      { text: '出差住宿标准为每晚上限五百元，超出部分需部门负责人审批。' },
      { text: '市内交通费按实际发生额计入，当月票据须在次月五日前提交。' },
      { level: 2, text: '其他费用' },
      { text: '其他费用需提供合规票据，否则不予报销。' },
    ]),
  },
  pdf: {
    fileName: 'vendor-checklist.pdf',
    contentType: 'application/pdf',
    /**
     * ⚠️ PDF 夹具用 **ASCII**：`makePdf` 用的是内建 Helvetica（不含 CJK 字形），
     * 塞中文进去会取不到字（表现为"这篇 READY 但正文是空的"）。
     * 中文检索那几行（R5/R6/R8）用上面的 txt/md/docx。
     */
    bytes: fixtures.makePdf([
      [
        'Vendor Onboarding Checklist',
        'Step one: collect the business license.',
        'Step two: verify the bank account name.',
        'Step three: sign the master service agreement.',
      ],
      [
        'Security Review',
        'Confirm data processing terms are signed.',
        'Record the security contact and escalation path.',
      ],
    ]),
  },
}

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

function multipart(name, { filename, contentType, value }) {
  const boundary = `----doubuleaKbPkgBoundary${Math.random().toString(16).slice(2)}`
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
  return { response, data, docId: data.document.id }
}

/** 列表（P0-1-21 的进度可视出口，R2 的状态流转就靠它） */
async function listDocs(kbId, { cookie, query } = {}) {
  const suffixQuery = query === undefined ? '' : `?${new URLSearchParams(query)}`
  const response = await api('GET', `/api/knowledge-bases/${kbId}/documents${suffixQuery}`, { cookie })
  assertEqual(response.statusCode, 200, '列表状态码')
  return documentListResultSchema.parse(response.json().data)
}

/** 检索（P0-1-20 的端点；R4/R5/R6/R8 都用它） */
async function search(kbId, { cookie, body }) {
  const response = await api('POST', `/api/knowledge-bases/${kbId}/search`, { cookie, payload: body })
  assertEqual(response.statusCode, 200, `检索（${JSON.stringify(body)}）的状态码`)
  return searchKnowledgeBaseResultSchema.parse(response.json().data)
}

async function docRow(docId) {
  const row = await prisma.document.findUnique({ where: { id: docId } })
  assert(row !== null, `文档 ${docId} 应当存在`)
  return row
}

/** 一个文档的全部 chunk（含正文，R6 要拿它跟 snippet 逐字比对） */
function chunkRowsOf(docId) {
  return prisma.$queryRaw`
    SELECT id::text AS id, seq, content, meta::text AS meta, embedding IS NOT NULL AS has_vec
    FROM chunks WHERE doc_id = ${docId}::uuid ORDER BY seq
  `
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

async function login(username) {
  const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
  assertEqual(response.statusCode, 200, `${username} 登录`)
  return cookieOf(response)
}

async function runWorkerUntilSettled(docIds) {
  startPipelineWorker()
  await waitFor(
    '目标文档全部离开 PARSING',
    async () => (await prisma.document.count({ where: { id: { in: docIds }, status: 'PARSING' } })) === 0,
    { timeoutMs: 60_000, intervalMs: 25 },
  )
  await waitFor(
    '队列清空且在途归零',
    async () =>
      (await pipelineQueueDepth()) === 0 && getPipelineWorkerStats().inFlight === 0,
    { timeoutMs: 20_000, intervalMs: 25 },
  )
  await stopPipelineWorker(2_000)
}

/** R1 用：列 S3 键（"删库时原文件真的消失"的取证方式） */
async function assertNoObjects(prefix, label) {
  const residual = await listKeys(prefix)
  assertEqual(residual.length, 0, `${label}：S3 侧残留应为 0，实际 ${JSON.stringify(residual)}`)
}

// ═════════════════════════════ 主流程 ═════════════════════════════

try {
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash: await hashPassword(PASSWORD),
      nickname: '包验收',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  createdUserIds.push(admin.id)
  const adminCookie = await login(adminUsername)

  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）${c.x}`)
  console.log(
    `  ${c.d}注入配置：PIPELINE_QUEUE_KEY=${queueKey}｜假 embedding 上游 ${embeddingUpstream.url}（semantic）${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R1 §十二·15 知识库 CRUD：建（设参数）→ 改名 → 删（级联清 chunk 与 S3）──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  let kb = null
  await it('建库带上 topK / 阈值 → 改名 → 删库后 chunks 与 S3 原文件都被连带清掉', async () => {
    kb = await createKb(adminCookie, `包验收库-${suffix}`, {
      description: '包 D 收口验收',
      // 阈值取 0：本脚本用的是"词面重叠型"假上游（余弦 ≈ 0.2~0.4），沿用默认 0.3 会让向量路
      // 时有时无 ⇒ R5 的"双路得分都可见"变成掷骰子。真实阈值行为由 `verify:retrieval` 的 B 组专验。
      retrievalConfig: { topK: 8, score: 0 },
    })
    assertEqual(kb.retrievalConfig.topK, 8, '建库就把 topK 设好（§十二 的"设 topK/阈值"）')
    assertEqual(kb.retrievalConfig.score, 0, '相似度阈值')

    // 传一篇并跑完流水线：删库要验的"级联清 chunks"必须先有 chunk
    const first = await upload(kb.id, { cookie: adminCookie, ...FIXTURES.txt })
    await runWorkerUntilSettled([first.docId])
    assertEqual((await docRow(first.docId)).status, 'READY', '前置：这篇要真的入库')

    const renamed = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { name: `${kb.name}-已改名` },
    })
    assertEqual(renamed.statusCode, 200, '改名状态码')
    assertEqual(renamed.json().data.name, `${kb.name}-已改名`, '新名字')
    assertEqual(renamed.json().data.retrievalConfig.topK, 8, '改名不该动检索配置（局部合并）')

    const beforeChunks = await chunkRowsOf(first.docId)
    assert(beforeChunks.length >= 1, '前置：库里有 chunk')
    assert((await listKeys(`kb/${kb.id}/`)).length >= 1, '前置：库里有对象')

    const removed = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(removed.statusCode, 200, '删库状态码')
    const result = removeKnowledgeBaseResultSchema.parse(removed.json().data)
    assert(result.deletedDocuments >= 1, `应报告连带删除的文档数，实际 ${result.deletedDocuments}`)
    assertEqual(await prisma.chunk.count({ where: { kbId: kb.id } }), 0, 'chunks 应被级联清除')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 0, 'documents 应被级联清除')
    await assertNoObjects(`kb/${kb.id}/`, '删库后')
    createdKbIds.splice(createdKbIds.indexOf(kb.id), 1)

    // 后续 R2~R8 用的库：参数按验收清单设置（topK 8 / 阈值 0，理由同上）
    kb = await createKb(adminCookie, `包验收库-主-${suffix}`, { retrievalConfig: { topK: 8, score: 0 } })
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R2 §十二·16 文档上传：四格式各 1 篇 → READY；扫描件与 .doc 被拒 ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  const uploaded = {}
  await it('四格式各 1 篇：上传恒 PARSING → **用列表端点看它转 READY**，且 chunk 数合理', async () => {
    for (const [key, fixture] of Object.entries(FIXTURES)) {
      const result = await upload(kb.id, {
        cookie: adminCookie,
        bytes: fixture.bytes,
        fileName: fixture.fileName,
        contentType: fixture.contentType,
      })
      assertEqual(result.data.document.status, 'PARSING', `${key} 上传响应恒为 PARSING（异步流水线）`)
      assertEqual(result.data.document.chunkCount, 0, `${key} 上传时还没有 chunk`)
      uploaded[key] = { ...result, ...fixture }
    }

    // 列表端点就是"进度可视出口"（P0-1-21 之前只能查库）
    const during = await listDocs(kb.id, { cookie: adminCookie })
    assertEqual(during.total, 4, '列表应当立刻看到这 4 篇')
    for (const item of during.items) {
      assertEqual(item.status, 'PARSING', `${item.fileName} 此刻还在处理中`)
      assertEqual(isDocumentSearchable(item.status), false, '还在处理 ⇒ 不可检索（列表页据此提示）')
    }

    await runWorkerUntilSettled(Object.values(uploaded).map((item) => item.docId))

    const after = await listDocs(kb.id, { cookie: adminCookie })
    for (const item of after.items) {
      assertEqual(item.status, 'READY', `${item.fileName} 的状态`)
      assertEqual(item.errorMsg, null, `${item.fileName} 的 error_msg`)
      assert(isDocumentSearchable(item.status), `${item.fileName} 应当可检索`)
      assert(item.chunkCount >= 1, `${item.fileName} 的 chunk 数应当 ≥1，实际 ${item.chunkCount}`)
    }

    // 四篇都真的入库了：`chunk_count` 与 `chunks` 表逐行一致（P0-1-19 的三条等式之一）
    const chunkSummary = []
    for (const [key, fixture] of Object.entries(uploaded)) {
      const row = await docRow(fixture.docId)
      const rows = await chunkRowsOf(fixture.docId)
      assertEqual(row.status, 'READY', `${key} 的状态`)
      assertEqual(row.chunkCount, rows.length, `${key}：chunk_count 必须等于 chunks 表行数`)
      assert(rows.every((chunk) => chunk.has_vec === true), `${key}：每一块都要有向量`)
      chunkSummary.push(`${key}=${row.chunkCount}`)
    }
    console.log(`         ${c.d}chunk 数：${chunkSummary.join('｜')}${c.x}`)
  })

  await it('扫描件（空白 PDF）→ FAILED 且提示「疑似扫描件」；`.doc` → 拒绝并提示另存为 .docx', async () => {
    const blank = await upload(kb.id, {
      cookie: adminCookie,
      bytes: fixtures.makeBlankPdf(2),
      fileName: '扫描件.pdf',
      contentType: 'application/pdf',
    })
    await runWorkerUntilSettled([blank.docId])
    const row = await docRow(blank.docId)
    assertEqual(row.status, 'FAILED', '空白 PDF 应当失败（而不是"假装 READY"）')
    assertIncludes(row.errorMsg ?? '', '疑似扫描件', '失败原因要能让人看懂')
    assertEqual(row.chunkCount, 0, '失败不该留下 chunk 计数')
    assertEqual(await prisma.chunk.count({ where: { docId: blank.docId } }), 0, '失败不该留下 chunk')

    const legacy = await upload(kb.id, {
      cookie: adminCookie,
      bytes: fixtures.makeLegacyDoc(),
      fileName: '旧版制度.doc',
      contentType: 'application/msword',
      expectStatus: 400,
    })
    assertIncludes(legacy.response.json().msg, 'docx', '`.doc` 的提示必须指向"另存为 .docx"')
    assertEqual(LEGACY_DOC_HINT, '请另存为 .docx 后重传', '提示文案（前后端共用同一句）')
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R3 §十二·16 失败可重试：造一个失败文档 → 重试 → READY ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('上游挂 → FAILED（可读原因）→ 修好后 `POST /retry` → READY，chunk 正确入库', async () => {
    const retryFixture = {
      fileName: '重试用例.txt',
      contentType: 'text/plain',
      bytes: Buffer.from(
        '重试用例：这段正文足够长，用于验证失败之后重新入队能把它救回来，并正确切块入库。' +
          '第二句补充一点内容，确保有效字符数越过空文本检测的门槛。',
        'utf8',
      ),
    }
    const target = await upload(kb.id, { cookie: adminCookie, ...retryFixture })

    embeddingUpstream.setFailing(true)
    try {
      await runWorkerUntilSettled([target.docId])
    } finally {
      embeddingUpstream.setFailing(false)
    }
    const failedRow = await docRow(target.docId)
    assertEqual(failedRow.status, 'FAILED', '上游挂了 ⇒ 整篇 FAILED')
    assertIncludes(failedRow.errorMsg ?? '', '文本向量化失败', '失败原因')
    assert((await listDocs(kb.id, { cookie: adminCookie })).items.some(
      (item) => item.id === target.docId && item.status === 'FAILED',
    ), '列表里也要看得到这条失败（否则用户不知道要点重试）')

    const retried = await api('POST', `/api/knowledge-bases/${kb.id}/documents/${target.docId}/retry`, {
      cookie: adminCookie,
    })
    assertEqual(retried.statusCode, 200, '重试状态码')
    assertEqual(retried.json().data.document.status, 'PARSING', '重试响应立刻是 PARSING（别让用户干等）')

    await runWorkerUntilSettled([target.docId])
    const row = await docRow(target.docId)
    assertEqual(row.status, 'READY', '重试后应转 READY')
    assertEqual(row.errorMsg, null, 'error_msg 应被清空')
    const rows = await chunkRowsOf(target.docId)
    assertEqual(row.chunkCount, rows.length, 'chunk 数应与表一致')
    assert(rows.length >= 1, 'chunk 应正确入库')
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R4 §十二·17 覆盖重建：同文档传 v2 → id 不变、无重复无孤儿、**检索返回 v2** ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('传 v2：文档 id 不变、旧 chunk **一个不剩**、全库无孤儿；**真检索端点只返回 v2**', async () => {
    const target = uploaded.txt
    const before = await docRow(target.docId)
    const beforeChunks = await chunkRowsOf(target.docId)
    const beforeKeys = await listKeys(`kb/${kb.id}/`)

    // v2 换一个**独特关键词**：这样"检索返回 v2"可以写成"新词命中、旧词查不到"——
    // 比"正文里含 v2"强得多（后者在"新旧两份都留着"的坏数据上照样通过）
    const v2Keyword = '已改为双人复核签字'
    const v2Text =
      `运维值班制度（v2）：${v2Keyword}，交接班必须核对巡检记录。` +
      '夜间巡检每两小时一次，发现异常先上报后处理，不得擅自重启核心设备。' +
      '本版本删除了原第二句，用于验证旧内容不会残留在检索结果里。'

    const rebuilt = await (async () => {
      const body = multipart('file', {
        filename: '运维值班制度-v2.txt',
        contentType: 'text/plain',
        value: Buffer.from(v2Text, 'utf8'),
      })
      const response = await api(
        'POST',
        `/api/knowledge-bases/${kb.id}/documents/${target.docId}/reupload`,
        { cookie: adminCookie, payload: body.payload, headers: { 'content-type': body.contentType } },
      )
      assertEqual(response.statusCode, 200, '重建状态码')
      return reuploadDocumentResultSchema.parse(response.json().data)
    })()

    assertEqual(rebuilt.document.id, target.docId, '文档 id 必须不变（不新建行）')
    assertEqual(rebuilt.unchanged, false, '内容变了 ⇒ unchanged=false')

    await runWorkerUntilSettled([target.docId])

    const after = await docRow(target.docId)
    assertEqual(after.status, 'READY', '重建后应回到 READY')
    assertEqual(after.id, before.id, 'id 仍然不变')
    assertEqual(after.fileName, '运维值班制度-v2.txt', '`file_name` 一并更新（下载的 Content-Disposition 靠它）')

    const afterChunks = await chunkRowsOf(target.docId)
    const oldIds = new Set(beforeChunks.map((chunk) => chunk.id))
    assertEqual(
      afterChunks.filter((chunk) => oldIds.has(chunk.id)).length,
      0,
      '旧 chunk 的 id 不应残留（双写实现会留下旧 id）',
    )
    assertEqual(after.chunkCount, afterChunks.length, 'chunk_count 与表一致')
    const orphans = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM chunks c
      LEFT JOIN documents d ON d.id = c.doc_id WHERE d.id IS NULL
    `
    assertEqual(orphans[0].n, 0, '不应存在孤儿 chunk')
    assertEqual((await listKeys(`kb/${kb.id}/`)).length, beforeKeys.length, '对象总数不变（换了键但删了旧的）')

    // ★ 这一条就是 P0-1-19 时只能"用 `<=>` SQL 等价取证"的那件事，现在用**真端点**验
    const hitNew = await search(kb.id, { cookie: adminCookie, body: { query: v2Keyword, mode: 'FULLTEXT' } })
    assertEqual(hitNew.items.length, 1, `新内容的关键词应当命中 1 条，实际 ${hitNew.items.length}`)
    assertEqual(hitNew.items[0].docId, target.docId, '命中的应当就是那篇被重建的文档')
    assert(
      afterChunks.some((chunk) => chunk.id === hitNew.items[0].chunkId),
      '命中的块必须是**重建之后**写进去的那一批（旧块已被替换）',
    )
    assertIncludes(hitNew.items[0].snippet, v2Keyword, '命中的片段应当是 v2 的正文')

    const hitOld = await search(kb.id, {
      cookie: adminCookie,
      body: { query: FIXTURES.txt.keyword, mode: 'FULLTEXT' },
    })
    assertEqual(hitOld.items.length, 0, 'v1 的旧内容**必须搜不到**（否则就是"新旧两份都留着"）')
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R5 §十二·18 检索测试：中文 query 的双路得分 + 融合排名均可见 ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('HYBRID：每一条都带双路分与融合排名，命中那一篇两路都是第 1', async () => {
    for (const key of ['md', 'docx']) {
      const fixture = FIXTURES[key]
      const data = await search(kb.id, { cookie: adminCookie, body: { query: fixture.keyword } })
      assertEqual(data.mode, 'HYBRID', '默认模式取自该库快照')
      assert(data.items.length >= 1, `${key}：中文 query 应当有结果`)
      const top = data.items[0]
      assertEqual(top.docName, fixture.fileName, `${key}：命中应当是含关键词的那一篇`)
      // 「双路得分」+「融合排名」四列在同一个响应里（`03` §4.3 的结果表要的正是这个）
      assertEqual(typeof top.vectorScore, 'number', `${key} 的 vectorScore`)
      assertEqual(top.vectorRank, 1, `${key} 的 vectorRank`)
      assertEqual(typeof top.fulltextScore, 'number', `${key} 的 fulltextScore`)
      assertEqual(top.fulltextRank, 1, `${key} 的 fulltextRank`)
      assertEqual(top.finalRank, 1, `${key} 的融合排名`)
      assertClose(top.rrfScore, 2 / (data.rrfK + 1), `${key}：两路都第 1 的 RRF 分`)
      assertEqual(data.items.map((item) => item.finalRank).join(','), data.items.map((_, i) => i + 1).join(','), 'finalRank 连续')
      console.log(
        `         ${c.d}${key}：“${fixture.keyword}” → v=${top.vectorScore.toFixed(4)}/${top.vectorRank}｜` +
          `f=${top.fulltextScore.toFixed(4)}/${top.fulltextRank}｜rrf=${top.rrfScore.toFixed(4)}（k=${data.rrfK}）${c.x}`,
      )
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R6 §十二·19 引用格式：片段与原文一致可核对 ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('每一条 `snippet` 都是**它自己那块正文的逐字子串**，且含命中的词', async () => {
    const fixture = FIXTURES.docx
    const data = await search(kb.id, { cookie: adminCookie, body: { query: fixture.keyword } })
    assert(data.items.length >= 1, '前置：有结果可核对')

    for (const item of data.items) {
      const rows = await prisma.$queryRaw`
        SELECT content FROM chunks WHERE id = ${item.chunkId}::uuid
      `
      const content = rows[0]?.content
      assert(typeof content === 'string', `块 ${item.chunkId} 的正文应当在库里`)
      assertIncludes(content, item.snippet, '片段必须是原文的逐字子串（"可展开核对"的前提）')
      assert(item.snippet.length > 0, '片段不该为空')
      // 文档名也要对得上：引用卡显示"来自哪一篇"
      const doc = await docRow(item.docId)
      assertEqual(item.docName, doc.fileName, '引用里的文档名应当与库里一致')
    }
    assertIncludes(data.items[0].snippet, fixture.keyword, '命中那一条的片段里应当含查询词（便于人工核对）')
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R7 §十二·性能：单条 embedding < 500ms；检索 < 500ms ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('检索 < 500ms（自报 `elapsedMs` 与墙钟都测）', async () => {
    const wallStart = nowMs()
    const data = await search(kb.id, { cookie: adminCookie, body: { query: FIXTURES.md.keyword } })
    const wall = nowMs() - wallStart
    assert(data.elapsedMs < 500, `服务端自报 ${data.elapsedMs}ms 应 < 500ms`)
    assert(wall < 500, `墙钟 ${wall}ms 应 < 500ms（含 inject 开销）`)
    console.log(`         ${c.d}elapsedMs=${data.elapsedMs}ms｜墙钟=${wall}ms${c.x}`)
  })

  await it('单条 embedding < 500ms（⚠️ 本档测的是**链路开销**，不是模型推理时延）', async () => {
    const started = nowMs()
    const vectors = await getEmbeddingProvider().embed(['出差住宿标准为每晚上限 500 元'])
    const cost = nowMs() - started
    assertEqual(vectors.length, 1, '应当返回 1 条向量')
    assertEqual(vectors[0].length, config.embedding.dim, '维度')
    assert(cost < 500, `单条 embedding 耗时 ${cost}ms 应 < 500ms`)
    console.log(
      `         ${c.d}单条 embedding=${cost}ms（假上游在 localhost，这里量的是"请求 + 解析 + 校验"的固定开销）${c.x}`,
    )
    // ⚠️ 边界（写进 issue_fix 与 `06`）：真实模型的单条时延要等 `LOCAL_EMBEDDING_RUNTIME_MODULE`
    //    就位（`06` §七 待决事项 2）或接真 api 才能量 —— 与 P0-1-13 的遗留项是同一条。
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R8 §十二 必测的坑：mode=FULLTEXT 单独跑中文 query 非空 ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('`FULLTEXT` 单独跑中文 query 非空（若为空 ⇒ pg_bigm 索引/算子类没生效）', async () => {
    // ⚠️ 用 v2 的关键词：这篇在 R4 里被重建过（v1 的内容已经不在了）
    const data = await search(kb.id, { cookie: adminCookie, body: { query: '已改为双人复核签字', mode: 'FULLTEXT' } })
    assertEqual(data.vectorPathSkipped, true, 'FULLTEXT 模式不走向量路')
    assert(data.items.length >= 1, '中文 query 在纯全文路下必须能命中')
    assertEqual(data.items[0].vectorScore, null, '没走的路径必须是 null（不是 0）')
    assertEqual(data.items[0].fulltextRank, 1, '全文路名次')
  })

  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── R9 清场：删库双清、队列键不残留 ──${c.x}`)
  // ═══════════════════════════════════════════════════════════════════

  await it('删库 → DB 与 S3 两侧都回到基线；队列键删除后不存在', async () => {
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删库状态码')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 0, 'documents 清空')
    assertEqual(await prisma.chunk.count({ where: { kbId: kb.id } }), 0, 'chunks 清空')
    await assertNoObjects(`kb/${kb.id}/`, '删库后')

    await redis.del(queueKey)
    assertEqual(await redis.exists(queueKey), 0, '队列键应已删除')
    assert(queueKey !== 'pipeline:jobs', '本脚本只动自己注入的队列键')
  })
} finally {
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
  console.log(
    `${c.g}${c.b}✅ P0-1-21 知识库包验收通过（子方案① §十二 的 8 行）：${passed} 项全通过${c.x}`,
  )
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-21 包验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
