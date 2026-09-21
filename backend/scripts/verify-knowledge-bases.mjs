#!/usr/bin/env node
/**
 * verify-knowledge-bases.mjs —— P0-1-15 的**知识库 CRUD 验收**（需要真实 PG + Redis + S3）
 *
 * 验的是 `02` §4.6 的知识库四端点 + 详情，以及 `子方案①` 的三条口径：
 *   · §十一：**KB 级参数建库时快照自环境默认值**，此后独立可改；
 *   · §二：`retrieval_config` 读取端一律补默认值（`{}` / 缺键 / 越界值都不能让读接口炸）；
 *   · §十二 的 15 号验收行：**删库时级联清 chunks 与 S3 原文件**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本脚本最想钉死的一件事：**权限是「登录即可」，不是 ADMIN**
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-11 的模型池是 `(A)` 仅 ADMIN（靠 `verify-models.mjs` 断言"MEMBER 403"）；知识库**正好相反**
 * —— `03` §25 的权限列写着 `/knowledge` 是「登录」，`02` §三 的表也没有 owner 列。
 * 所以这里**特意用 MEMBER 身份**把建/改/删全跑一遍：如果哪天有人顺手给这些路由加上
 * `requireAdmin`（"配置类接口都该是管理员吧"），本脚本会立刻红。
 * 代价（任何登录用户都能改/删任意库）是文档口径的推论，不是实现疏漏 —— 见 shared 契约文件头。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么可以不用假上游
 * ─────────────────────────────────────────────────────────────────────
 * 建库要取 `EmbeddingProvider.name()`，而 `name()` 是**纯配置计算**（`api:<模型名>`），
 * **不发任何网络请求** —— `embed()` 要到 P0-1-19 入库时才被调用。
 * 故本脚本只注入一个**永不会被访问**的 `EMBEDDING_API_URL`（`127.0.0.1:1`），
 * 并在 D 组用**子进程**验"未就绪时建库必须失败"。
 * 真正的 embedding 报文/批/维度校验由 `verify-embedding.mjs`（P0-1-13）负责。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`（S3 也要，B 组要验原文件清理）
 * 脚本自造带随机后缀的数据（ADMIN + MEMBER + Provider + Model + Agent + 若干知识库 + 文档/chunk
 * + 一个 S3 对象），结束时删净并复核。
 */

// ⚠️ 必须在 import `config.js`（经 dist 的 app.js 间接引入）**之前**设置：
//    ① 收敛脚本自身日志（本脚本会打一堆"应当失败"的请求，不收敛会把断言输出冲掉；
//       要看细节时：`LOG_LEVEL=debug pnpm verify:knowledge-bases`）
//    ② 注入就绪的 embedding 配置（本机 `.env` 是"api 模式三项空"，不注入就建不了库）
//    ③ **把 KB 级默认值改成有辨识度的数字** —— 这样"建库快照了环境值"就成了一条真断言
//       （沿用 5/0.3/60 的话，"快照成功"与"用了 shared 的硬编码默认值"分辨不出来）
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = 'http://127.0.0.1:1/v1'
process.env.EMBEDDING_API_KEY = 'verify-kb-key'
process.env.EMBEDDING_API_MODEL = 'verify-embed-model'
process.env.CHUNK_SIZE_DEFAULT = '256'
process.env.CHUNK_OVERLAP_DEFAULT = '32'
process.env.RETRIEVAL_TOPK_DEFAULT = '8'
process.env.RETRIEVAL_SCORE_DEFAULT = '0.42'
process.env.RRF_K = '77'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { AgentType, UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { getS3Client } = await import('../dist/backend/src/infra/s3.js')
const { config } = await import('../dist/backend/src/config.js')
const {
  DEFAULT_RETRIEVAL_CONFIG,
  knowledgeBaseItemSchema,
  knowledgeBaseListResultSchema,
  normalizeRetrievalConfig,
  removeKnowledgeBaseResultSchema,
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

// ───────────────────────────── 常量与临时数据标识 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Kb-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-kb-admin-${suffix}`
const memberUsername = `verify-kb-member-${suffix}`

/** 建库时快照的 embedding 标识（= `api:<EMBEDDING_API_MODEL>`，见文件头） */
const EXPECTED_EMBEDDING_MODEL = `api:${process.env.EMBEDDING_API_MODEL}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdKbIds = []
const s3Keys = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()
// ⚠️ `s3` / `bucket` 在 `try` **之外**声明：`finally` 的清理段也要用它们
//    （踩过一次 —— 写在 try 里，失败路径就变成 `s3 is not defined`，
//     把"清理没做"伪装成另一个错误，比原错误还难查）
const s3 = getS3Client()
const bucket = config.s3.bucket

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

/** 建知识库并要求成功，返回契约化后的条目 */
async function createKb(cookie, payload) {
  const response = await api('POST', '/api/knowledge-bases', { cookie, payload })
  assertEqual(response.statusCode, 200, `建库状态码（${JSON.stringify(payload)}）`)
  const parsed = knowledgeBaseItemSchema.safeParse(response.json().data)
  assert(parsed.success, `建库响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  createdKbIds.push(parsed.data.id)
  return parsed.data
}

/** 一个稳定的 64 字符十六进制（`content_hash` 列是 VARCHAR(64)，且要求非空） */
function fakeContentHash(seed) {
  return Buffer.from(`doubulea-verify-${seed}`.padEnd(32, '0')).toString('hex').slice(0, 64).padEnd(64, 'a')
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-15 知识库 CRUD 验收：快照 / 补默认值 / 级联 + S3 / 全员权限 ══${c.x}`)

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

  // S3 也必须有：B 组要验"删库后原文件真的消失"。桶不存在则按 P0-1-16 的口径按需建（不删桶）
  try {
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
  } catch (error) {
    console.error(
      `\n${c.r}✖ 本验收需要可达的 S3（MinIO）${c.x}\n  先执行：pnpm infra:up\n  原始错误：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    process.exit(1)
  }

  const passwordHash = await hashPassword(PASSWORD)
  const createUser = (username, data) => prisma.user.create({ data: { username, passwordHash, ...data } })

  const admin = await createUser(adminUsername, {
    nickname: '知识库验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const member = await createUser(memberUsername, {
    nickname: '知识库验证成员',
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(admin.id, member.id)

  const login = async (username) => {
    const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
    return cookieOf(response)
  }
  const adminCookie = await login(adminUsername)
  const memberCookie = await login(memberUsername)

  // Provider + Model + Agent：B 组的"被 Agent 绑定 → 409"需要一条真实的 agent_components 行，
  // 而 agents 对 models/users 都是 RESTRICT 外键，必须一级级建出来
  const provider = await prisma.modelProvider.create({
    data: { name: `知识库验证 Provider ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
  })
  createdProviderIds.push(provider.id)
  const model = await prisma.model.create({
    data: {
      providerId: provider.id,
      modelName: `verify-kb-model-${suffix}`,
      label: '知识库验证模型',
      type: 'CHAT',
    },
  })
  createdModelIds.push(model.id)

  console.log(
    `  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${memberUsername}（MEMBER）+ 1 Provider/Model/Agent${c.x}`,
  )
  console.log(
    `  ${c.d}建库快照预期：embeddingModel=${EXPECTED_EMBEDDING_MODEL}｜chunk 256/32｜topK 8 / score 0.42 / rrfK 77${c.x}`,
  )
  // 本机 `.env` 与本次注入的关系当信息打印出来（D 组会在子进程里换成"未就绪"再验一次）
  console.log(
    `  ${c.d}进程内 embedding 就绪结论：ready=${String(process.env.EMBEDDING_MODE === 'api')}（注入 api 三项）${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  // A 组 · CRUD 与快照（HTTP）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── A 组 · CRUD 与"建库快照环境默认值"（HTTP）──${c.x}`)

  await it('建库：只给 name → chunk 与 retrieval_config **全部快照自环境默认值**（不是硬编码 5/0.3/60）', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-默认-${suffix}` })
    assertEqual(kb.chunkSize, 256, 'chunkSize 应快照 CHUNK_SIZE_DEFAULT=256')
    assertEqual(kb.chunkOverlap, 32, 'chunkOverlap 应快照 CHUNK_OVERLAP_DEFAULT=32')
    assertEqual(kb.retrievalConfig.topK, 8, 'topK 应快照 RETRIEVAL_TOPK_DEFAULT=8')
    assertEqual(kb.retrievalConfig.score, 0.42, 'score 应快照 RETRIEVAL_SCORE_DEFAULT=0.42')
    assertEqual(kb.retrievalConfig.rrfK, 77, 'rrfK 应快照 RRF_K=77')
    // 这三项 `子方案①` §十一 没有为它们定义环境变量 ⇒ 恒为规范默认值
    assertEqual(kb.retrievalConfig.mode, 'HYBRID', 'mode 无环境变量，应为规范默认值')
    assertEqual(kb.retrievalConfig.splitStrategy, 'hybrid', 'splitStrategy 无环境变量，应为规范默认值')
    assertEqual(kb.retrievalConfig.weights.vector, 1, '向量权重')
    assertEqual(kb.retrievalConfig.weights.fulltext, 1, '全文权重')
    // 形状必须**六键齐备**（`子方案①` §二 的"完整形状"）
    assertEqual(Object.keys(kb.retrievalConfig).length, 6, 'retrievalConfig 键数')
    assertEqual(kb.description, null, '没给描述应为 null')
    assertEqual(kb.documentCount, 0, '新库文档数')
    assertEqual(kb.agentCount, 0, '新库引用数')
  })

  await it('建库：`embedding_model` 是**当前 provider 的快照**，且 `embeddingModelChanged=false`（与当前一致）', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-快照-${suffix}` })
    assertEqual(kb.embeddingModel, EXPECTED_EMBEDDING_MODEL, 'embeddingModel 快照值')
    assertEqual(kb.embeddingModelChanged, false, '与当前 provider 一致时应为 false（不是 null）')
  })

  await it('建库：显式 chunk + **局部** retrievalConfig 覆盖生效，未给的键仍取默认值', async () => {
    const kb = await createKb(adminCookie, {
      name: `验证库-覆盖-${suffix}`,
      description: '显式覆盖用的库',
      chunkSize: 900,
      chunkOverlap: 100,
      retrievalConfig: { topK: 12, mode: 'VECTOR' },
    })
    assertEqual(kb.chunkSize, 900, '显式 chunkSize 应生效')
    assertEqual(kb.chunkOverlap, 100, '显式 chunkOverlap 应生效')
    assertEqual(kb.description, '显式覆盖用的库', '描述应写入')
    assertEqual(kb.retrievalConfig.topK, 12, '显式 topK 应生效')
    assertEqual(kb.retrievalConfig.mode, 'VECTOR', '显式 mode 应生效')
    // 没给的键：score/rrfK 来自**环境**默认值、splitStrategy/weights 来自规范默认值
    assertEqual(kb.retrievalConfig.score, 0.42, '未给的 score 应取环境默认值')
    assertEqual(kb.retrievalConfig.rrfK, 77, '未给的 rrfK 应取环境默认值')
    assertEqual(kb.retrievalConfig.splitStrategy, 'hybrid', '未给的 splitStrategy 应取规范默认值')
    assertEqual(kb.retrievalConfig.weights.fulltext, 1, '未给的 weights 应取规范默认值')
  })

  await it('列表与详情：投影符合契约、`total` 与分页字段自洽、详情与列表项**逐字一致**', async () => {
    const created = await createKb(adminCookie, { name: `验证库-列表-${suffix}` })

    const listResponse = await api('GET', '/api/knowledge-bases?limit=100', { cookie: memberCookie })
    assertEqual(listResponse.statusCode, 200, '列表状态码')
    const parsed = knowledgeBaseListResultSchema.safeParse(listResponse.json().data)
    assert(parsed.success, `列表不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    const inList = parsed.data.items.find((item) => item.id === created.id)
    assert(inList !== undefined, '新建的库应出现在列表里（列表是全局的，MEMBER 也看得见）')
    assertEqual(parsed.data.items.length, parsed.data.total, 'limit=100 时 items 数应等于 total')
    assertEqual(parsed.data.offset, 0, 'offset 回显')

    const detailResponse = await api('GET', `/api/knowledge-bases/${created.id}`, { cookie: memberCookie })
    assertEqual(detailResponse.statusCode, 200, '详情状态码')
    const detail = knowledgeBaseItemSchema.safeParse(detailResponse.json().data)
    assert(detail.success, '详情不符合契约')
    assertEqual(
      JSON.stringify(detail.data),
      JSON.stringify(inList),
      '详情与列表项应逐字一致（同一个投影，不能一个多一个少）',
    )
  })

  await it('改库：`retrievalConfig` 是**局部合并** —— 只调 topK 不会把 mode 打回默认值', async () => {
    const kb = await createKb(adminCookie, {
      name: `验证库-合并-${suffix}`,
      retrievalConfig: { mode: 'FULLTEXT', topK: 3, score: 0.7 },
    })
    assertEqual(kb.retrievalConfig.mode, 'FULLTEXT', '前置：mode 应为 FULLTEXT')

    const response = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { retrievalConfig: { topK: 20 } },
    })
    assertEqual(response.statusCode, 200, '局部改状态码')
    const updated = knowledgeBaseItemSchema.parse(response.json().data)
    assertEqual(updated.retrievalConfig.topK, 20, 'topK 应被改')
    assertEqual(updated.retrievalConfig.mode, 'FULLTEXT', '⚠️ mode 必须保持 FULLTEXT（若被打回 HYBRID 说明实现是整体覆盖）')
    assertEqual(updated.retrievalConfig.score, 0.7, '⚠️ score 必须保持 0.7')
    assertEqual(updated.retrievalConfig.splitStrategy, 'hybrid', 'splitStrategy 未被动过')
  })

  await it('改库：`description` 三态 —— 改名不动描述 / `null` 清空 / 字符串设置', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-三态-${suffix}`, description: '初始描述' })

    // ① 只改 name：描述必须原封不动
    const renamed = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { name: `验证库-三态-改名-${suffix}` },
    })
    assertEqual(renamed.statusCode, 200, '改名状态码')
    const afterRename = knowledgeBaseItemSchema.parse(renamed.json().data)
    assertEqual(afterRename.name, `验证库-三态-改名-${suffix}`, 'name 应更新')
    assertEqual(afterRename.description, '初始描述', '⚠️ 不带 description 时描述必须保持不动')

    // ② null = 清空
    const cleared = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { description: null },
    })
    assertEqual(cleared.statusCode, 200, '清空状态码')
    assertEqual(knowledgeBaseItemSchema.parse(cleared.json().data).description, null, 'null 应清空描述')

    // ③ 字符串 = 设置
    const setAgain = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { description: '重新写的描述' },
    })
    assertEqual(setAgain.statusCode, 200, '重设状态码')
    assertEqual(
      knowledgeBaseItemSchema.parse(setAgain.json().data).description,
      '重新写的描述',
      '字符串应写回描述',
    )

    // ④ 库里核对（别只看响应体：三态实现错了常常表现为"响应对、库里没写"）
    const row = await prisma.knowledgeBase.findUnique({
      where: { id: kb.id },
      select: { description: true, name: true },
    })
    assertEqual(row?.description, '重新写的描述', '存储层的 description')
    assertEqual(row?.name, `验证库-三态-改名-${suffix}`, '存储层的 name')
  })

  await it('跨字段守卫：chunkOverlap >= chunkSize 一律 400（只改一个也要按**生效值**算）', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-跨字段-${suffix}` })
    assertEqual(kb.chunkSize, 256, '前置：默认 chunkSize')

    // 只给 overlap（比当前 chunkSize 大）—— 只有服务层算得出"省略的那个会是多少"
    const tooBig = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { chunkOverlap: 256 },
    })
    assertEqual(tooBig.statusCode, 400, 'overlap == size 的状态码')
    assertEqual(tooBig.json().code, 'VALIDATION', 'overlap == size 的错误码')
    assertIncludes(tooBig.json().msg, '必须小于', '跨字段报错文案')

    // 相等也拦（相等时分块原地打转：每块前进 size - overlap = 0）
    const equal = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { chunkSize: 64, chunkOverlap: 64 },
    })
    assertEqual(equal.statusCode, 400, '相等也应被拒')

    // 库没被改动（守卫必须在写库之前）
    const row = await prisma.knowledgeBase.findUnique({
      where: { id: kb.id },
      select: { chunkSize: true, chunkOverlap: true },
    })
    assertEqual(row?.chunkSize, 256, '守卫失败时 chunkSize 不应被写')
    assertEqual(row?.chunkOverlap, 32, '守卫失败时 chunkOverlap 不应被写')
  })

  await it('参数校验与 404：空改动 / 超长名 / chunkSize 越界 / 非法 UUID / 不存在的 id 都给出可读错误', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-校验-${suffix}` })

    const empty = await api('PATCH', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie, payload: {} })
    assertEqual(empty.statusCode, 400, '空改动状态码')
    assertEqual(empty.json().code, 'VALIDATION', '空改动错误码')
    // ⚠️ 根级 `.refine()` 的文案落在 `data.fields[].message` 上（path 是空的），
    //    顶层 `msg` 仍是通用的"请求参数校验失败" —— 两条都断言，避免"文案被降级成通用错误"这类退化
    assertIncludes(empty.json().msg, '请求参数校验失败', '空改动的顶层文案')
    assert(
      (empty.json().data?.fields ?? []).some((field) =>
        String(field.message).includes('至少要提供一个要修改的字段'),
      ),
      `空改动应给出"至少一个字段"的字段级文案，实际 ${JSON.stringify(empty.json().data?.fields)}`,
    )

    const longName = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { name: 'x'.repeat(129) },
    })
    assertEqual(longName.statusCode, 400, '超长名状态码')
    // 字段级文案在 `data.fields[].message`，顶层 `msg` 恒为"请求参数校验失败"（见 errorHandler）
    assert(
      (longName.json().data?.fields ?? []).some(
        (field) => field.path === 'body.name' && String(field.message).includes('128'),
      ),
      `超长名应给出带上限的字段级文案，实际 ${JSON.stringify(longName.json().data?.fields)}`,
    )

    const badChunk = await api('PATCH', `/api/knowledge-bases/${kb.id}`, {
      cookie: adminCookie,
      payload: { chunkSize: 8193 },
    })
    assertEqual(badChunk.statusCode, 400, 'chunkSize 越界状态码')

    const badUuid = await api('GET', '/api/knowledge-bases/not-a-uuid', { cookie: adminCookie })
    assertEqual(badUuid.statusCode, 400, '非法 UUID 状态码')
    assertEqual(
      (badUuid.json().data?.fields ?? []).some((field) => field.path === 'params.id'),
      true,
      '应报 params.id',
    )

    const missing = await api('GET', '/api/knowledge-bases/01a0c289-6738-715c-a10c-ef95c1286bf9', {
      cookie: adminCookie,
    })
    assertEqual(missing.statusCode, 404, '不存在的库状态码')
    assertEqual(missing.json().code, 'NOT_FOUND', '不存在的库错误码')

    const missingPatch = await api('PATCH', '/api/knowledge-bases/01a0c289-6738-715c-a10c-ef95c1286bf9', {
      cookie: adminCookie,
      payload: { name: 'x' },
    })
    assertEqual(missingPatch.statusCode, 404, '改不存在的库状态码')

    const missingDelete = await api('DELETE', '/api/knowledge-bases/01a0c289-6738-715c-a10c-ef95c1286bf9', {
      cookie: adminCookie,
    })
    assertEqual(missingDelete.statusCode, 404, '删不存在的库状态码')
  })

  await it('⚠️ 权限是「登录即可」：**MEMBER** 能建 / 能改 / 能删（与模型池的 ADMIN 相反）', async () => {
    // 这条是本批最该钉死的断言：若有人给这些路由加上 `requireAdmin`（"配置类接口都该是管理员吧"），
    // 它会立刻红。依据是 `03` §25 的权限列（`/knowledge` = 登录；`/admin/models` = ADMIN）
    // 与 `02` §三 的 knowledge_bases 无 owner 列。
    const created = await createKb(memberCookie, { name: `验证库-成员建-${suffix}` })
    assertEqual(created.name, `验证库-成员建-${suffix}`, 'MEMBER 应能建库')

    const patched = await api('PATCH', `/api/knowledge-bases/${created.id}`, {
      cookie: memberCookie,
      payload: { name: `验证库-成员改-${suffix}` },
    })
    assertEqual(patched.statusCode, 200, 'MEMBER 应能改库')

    const removed = await api('DELETE', `/api/knowledge-bases/${created.id}`, { cookie: memberCookie })
    assertEqual(removed.statusCode, 200, 'MEMBER 应能删库')

    // 反向对照：**匿名**一律 401（闸门/鉴权不能因为"全员可用"就放开）
    for (const [method, url, payload] of [
      ['GET', '/api/knowledge-bases', undefined],
      ['POST', '/api/knowledge-bases', { name: '匿名建库' }],
      ['GET', `/api/knowledge-bases/${created.id}`, undefined],
      ['PATCH', `/api/knowledge-bases/${created.id}`, { name: '匿名改库' }],
      ['DELETE', `/api/knowledge-bases/${created.id}`, undefined],
    ]) {
      const anonymous = await api(method, url, { payload })
      assertEqual(anonymous.statusCode, 401, `${method} ${url} 匿名状态码`)
      assertEqual(anonymous.json().code, 'UNAUTHORIZED', `${method} ${url} 匿名错误码`)
    }
  })

  await it('删库：回 { id, name, deletedDocuments, deletedObjects }，删完详情 404、列表里消失', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-删-${suffix}` })
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删库状态码')
    const parsed = removeKnowledgeBaseResultSchema.safeParse(response.json().data)
    assert(parsed.success, `删库响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    assertEqual(parsed.data.id, kb.id, '回显 id')
    assertEqual(parsed.data.name, kb.name, '回显 name')
    assertEqual(parsed.data.deletedDocuments, 0, '空库删除的文档数')
    assertEqual(parsed.data.deletedObjects, 0, '空库删除的对象数')

    const detail = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(detail.statusCode, 404, '删完详情应 404')

    const listResponse = await api('GET', '/api/knowledge-bases?limit=100', { cookie: adminCookie })
    const inList = knowledgeBaseListResultSchema
      .parse(listResponse.json().data)
      .items.some((item) => item.id === kb.id)
    assertEqual(inList, false, '删完不应出现在列表里')
  })

  // ═══════════════════════════════════════════════════════════════════
  // B 组 · 级联删除 + S3 原文件（`子方案①` §十二 第 15 行 / `02` §4.6）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── B 组 · 删库级联清 chunks 与 S3 原文件 ──${c.x}`)

  /** 造一条"文档 + chunk + S3 对象"完整的入库结果（P0-1-16/17 才会上传，这里直连库造） */
  async function seedDocumentWithChunk(kbId, tag) {
    const fileKey = `verify-kb/${suffix}/${tag}.txt`
    const body = Buffer.from(`doubulea 验收用的正文 ${tag}`, 'utf8')
    await s3.putObject(bucket, fileKey, body, body.length, { 'content-type': 'text/plain' })
    s3Keys.push(fileKey)

    const doc = await prisma.document.create({
      data: {
        kbId,
        fileKey,
        fileName: `${tag}.txt`,
        status: 'READY',
        chunkCount: 1,
        contentHash: fakeContentHash(tag),
      },
    })
    await prisma.chunk.create({
      data: { docId: doc.id, kbId, seq: 0, content: `验收用的分块内容 ${tag}` },
    })
    return { doc, fileKey }
  }

  await it('删库：`documents` / `chunks` 由外键级联清空，**S3 原文件真的消失**，且回报真实个数', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-级联-${suffix}` })
    const { doc, fileKey } = await seedDocumentWithChunk(kb.id, 'cascade')

    // 前置：三样都在
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 1, '前置：文档在')
    assertEqual(await prisma.chunk.count({ where: { kbId: kb.id } }), 1, '前置：chunk 在')
    const statBefore = await s3.statObject(bucket, fileKey)
    assertEqual(statBefore.size > 0, true, '前置：S3 对象在')

    // 详情里的 documentCount 也要能看见（列表页那一列）
    const detail = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(knowledgeBaseItemSchema.parse(detail.json().data).documentCount, 1, '详情里的 documentCount')

    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删库状态码')
    const result = removeKnowledgeBaseResultSchema.parse(response.json().data)
    assertEqual(result.deletedDocuments, 1, '应回报删了 1 个文档')
    assertEqual(result.deletedObjects, 1, '应回报删了 1 个 S3 对象')

    // ① 数据库侧：两级级联（kb → documents → chunks）
    assertEqual(await prisma.knowledgeBase.count({ where: { id: kb.id } }), 0, '知识库行应消失')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 0, '文档应被级联删除')
    assertEqual(await prisma.document.count({ where: { id: doc.id } }), 0, '文档行（按 id）应消失')
    assertEqual(await prisma.chunk.count({ where: { kbId: kb.id } }), 0, 'chunk 应被级联删除')

    // ② S3 侧：真的没了（不是"我们以为删了"）
    let gone = false
    try {
      await s3.statObject(bucket, fileKey)
    } catch {
      gone = true
    }
    assertEqual(gone, true, `S3 对象 ${fileKey} 应已被删除`)
    // 刻意**不从 `s3Keys` 里摘掉**：S3 的 DeleteObject 对不存在的键是幂等成功，
    // 重复删一次没有副作用；真正权威的残留复核是收尾时按前缀 list 一遍（能抓到"记账对了但对象还在"）。
  })

  await it('删库：**被 Agent 绑定 → 409**，且库与内容一个都没被删（多态引用没有外键兜底，必须自己拦）', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-绑定-${suffix}` })
    await seedDocumentWithChunk(kb.id, 'bound')

    const agent = await prisma.agent.create({
      data: {
        name: `知识库验证 Agent ${suffix}`,
        type: AgentType.CHATBOT,
        modelId: model.id,
        createdBy: admin.id,
        components: { create: { componentType: 'KNOWLEDGE', refId: kb.id } },
      },
    })
    createdAgentIds.push(agent.id)

    // 引用数要能在详情里看到（"为什么删不掉"的依据）
    const detail = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(knowledgeBaseItemSchema.parse(detail.json().data).agentCount, 1, '详情里的 agentCount')

    const blocked = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(blocked.statusCode, 409, '被绑定时删库状态码')
    assertEqual(blocked.json().code, 'CONFLICT', '被绑定时删库错误码')
    assertIncludes(blocked.json().msg, '1 个 Agent', '文案应给出引用数')
    assertIncludes(blocked.json().msg, '解绑', '文案应给出出路')

    // 关键：什么都没被删（不是"先删了再报错"）
    assertEqual(await prisma.knowledgeBase.count({ where: { id: kb.id } }), 1, '库应完好')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 1, '文档应完好')
    assertEqual(await prisma.chunk.count({ where: { kbId: kb.id } }), 1, 'chunk 应完好')

    // 解绑后就能删（证明 409 是可解的，不是死结）
    await prisma.agentComponent.deleteMany({ where: { refId: kb.id } })
    const afterUnbind = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(afterUnbind.statusCode, 200, '解绑后应能删')
  })

  await it('删库：从没上传过文档的库（S3 无对象）也能干净删掉 —— 清理逻辑不能因为"没对象"而报错', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-空-${suffix}` })
    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '空库删除状态码')
    const result = removeKnowledgeBaseResultSchema.parse(response.json().data)
    assertEqual(result.deletedDocuments, 0, '空库 deletedDocuments')
    assertEqual(result.deletedObjects, 0, '空库 deletedObjects')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C 组 · 补默认值（老数据 / 局部写入 / 越界值）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── C 组 · retrieval_config 的补默认值（老数据不能让读接口炸）──${c.x}`)

  await it('老数据：库里存 `{}` / 只剩一半键 / 越界值 → 读接口仍返回**完整且合法**的形状', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-老数据-${suffix}` })

    // 直连库改 jsonb：模拟"本批之前建的行 / 手工改库 / 从别处导入的数据"
    const cases = [
      { raw: {}, label: '空对象' },
      { raw: { topK: 3 }, label: '只剩一个键' },
      { raw: { mode: 'VECTOR' }, label: '只有 mode' },
      // 合法键保留、非法键各自退回默认 —— 两个方向都要有
      { raw: { topK: 3, score: 5, mode: 'NOPE', rrfK: -1, weights: { vector: 'x' } }, label: '一半合法一半非法' },
      { raw: { topK: 999, score: -1, rrfK: 0 }, label: '全部越界' },
    ]
    for (const item of cases) {
      await prisma.$executeRaw`UPDATE knowledge_bases SET retrieval_config = ${JSON.stringify(item.raw)}::jsonb WHERE id = ${kb.id}::uuid`
      const response = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
      assertEqual(response.statusCode, 200, `${item.label}：读接口状态码`)
      const parsed = knowledgeBaseItemSchema.safeParse(response.json().data)
      assert(
        parsed.success,
        `${item.label}：投影必须仍符合契约，实际 ${JSON.stringify(response.json().data?.retrievalConfig)}`,
      )
      const config6 = parsed.data.retrievalConfig
      assertEqual(Object.keys(config6).length, 6, `${item.label}：应补成 6 键`)
      if (item.label === '只剩一个键') {
        assertEqual(config6.topK, 3, '合法的键应被保留')
      }
      if (item.label === '一半合法一半非法') {
        // 越界/非法各自退回**规范默认值**（不是 clamp：5 → 1 会被误读成"用户就要 1"）
        assertEqual(config6.topK, 3, '合法的 topK 应被保留')
        assertEqual(config6.score, DEFAULT_RETRIEVAL_CONFIG.score, '越界 score 应退回默认值')
        assertEqual(config6.mode, DEFAULT_RETRIEVAL_CONFIG.mode, '非法 mode 应退回默认值')
        assertEqual(config6.rrfK, DEFAULT_RETRIEVAL_CONFIG.rrfK, '负 rrfK 应退回默认值')
        assertEqual(config6.weights.vector, DEFAULT_RETRIEVAL_CONFIG.weights.vector, '非数字权重应退回默认值')
      }
      if (item.label === '全部越界') {
        // ⚠️ 读取端**不**叠环境默认值（那是建库时快照的事），退回的是 shared 的规范默认值。
        //    若有人把环境变量混进读路径，这几个库的语义会随部署环境变化 —— 这条断言就是盯它。
        assertEqual(config6.topK, DEFAULT_RETRIEVAL_CONFIG.topK, '越界 topK 应退回规范默认值 5（不是环境值 8）')
        assertEqual(config6.score, DEFAULT_RETRIEVAL_CONFIG.score, '负 score 应退回规范默认值')
        assertEqual(config6.rrfK, DEFAULT_RETRIEVAL_CONFIG.rrfK, '0 应退回规范默认值')
      }
    }
  })

  await it('补默认值的逻辑在**一处**（`shared` 的 `normalizeRetrievalConfig`）：模块级纯函数逐键兜底', async () => {
    // 这一条与 verify:app 的契约用例**故意重叠**：那边验"契约本身"，这边验"服务层真的用了它"。
    // 断言服务层的读路径与纯函数对同一份坏数据给出**逐字相同**的结果 —— 若有人在服务层另写一份
    // `??`，两者迟早分叉，这条会先红。
    const kb = await createKb(adminCookie, { name: `验证库-单点-${suffix}` })
    const weird = { topK: 6, mode: 'VECTOR' }
    await prisma.$executeRaw`UPDATE knowledge_bases SET retrieval_config = ${JSON.stringify(weird)}::jsonb WHERE id = ${kb.id}::uuid`

    const response = await api('GET', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    const fromApi = knowledgeBaseItemSchema.parse(response.json().data).retrievalConfig
    assertEqual(
      JSON.stringify(fromApi),
      JSON.stringify(normalizeRetrievalConfig(weird)),
      '服务层读路径必须与 shared 的纯函数给出逐字相同的结果',
    )
  })

  await it('DB 默认值与 shared 的规范默认值是**同一组值**（`schema.prisma` 的手写字符串容易和契约漂移）', async () => {
    // 用一条"不给 retrieval_config"的裸 SQL 插入，看 DB 自己的默认值是什么
    const id = '01a0c289-6738-715c-a10c-ef95c1286bf9'
    // 先清（上一次失败的运行可能留下同一个 id）
    await prisma.knowledgeBase.deleteMany({ where: { id } })
    await prisma.$executeRaw`
      INSERT INTO knowledge_bases (id, name, embedding_model, created_at, updated_at)
      VALUES (${id}::uuid, ${`验证库-DB默认-${suffix}`}, 'db-default-probe', now(), now())
    `
    const rows = await prisma.$queryRaw`SELECT retrieval_config AS cfg FROM knowledge_bases WHERE id = ${id}::uuid`
    const rawDefault = rows[0]?.cfg
    assert(rawDefault !== undefined, '裸插入应拿到 DB 默认值')
    // jsonb 经驱动回来可能是对象，也可能是字符串（取决于适配器）—— 两种都收
    const dbDefault = typeof rawDefault === 'string' ? JSON.parse(rawDefault) : rawDefault
    assertEqual(
      JSON.stringify(normalizeRetrievalConfig(dbDefault)),
      JSON.stringify(DEFAULT_RETRIEVAL_CONFIG),
      'DB 默认值经归一等价于 shared 的规范默认值（两处必须同步，改一处就要改另一处）',
    )
    await prisma.knowledgeBase.deleteMany({ where: { id } })
  })

  // ═══════════════════════════════════════════════════════════════════
  // D 组 · embedding 未就绪（子进程注入环境变量，与主进程的注入解耦）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── D 组 · embedding 未就绪时的行为（子进程注入环境变量）──${c.x}`)

  await it('未就绪时建库 → 500 且文案点明"embedding 未就绪"，**不留半成品**（行数不变）', async () => {
    const kb = await createKb(adminCookie, { name: `验证库-未就绪-${suffix}` })
    const before = await prisma.knowledgeBase.count()

    const child = await runChild(
      [
        `const { createKnowledgeBase } = await import('${distUrl('services/kb.service.js')}')`,
        `try {`,
        `  const created = await createKnowledgeBase({ name: 'should-not-exist' })`,
        `  console.log('RESULT ' + JSON.stringify({ ok: true, id: created.id }))`,
        `} catch (error) {`,
        `  console.log('RESULT ' + JSON.stringify({ ok: false, code: error.code, status: error.status, message: error.message }))`,
        `}`,
        `const { closePrisma } = await import('${distUrl('infra/prisma.js')}')`,
        `await closePrisma()`,
      ].join('\n'),
      // 三项置空串 = 未设置（config.ts 的 `emptyToUndefined`）；进程环境优先，`.env` 覆盖不了它
      { EMBEDDING_MODE: 'api', EMBEDDING_API_URL: '', EMBEDDING_API_KEY: '', EMBEDDING_API_MODEL: '' },
    )

    assertEqual(child.result.ok, false, '未就绪时建库必须失败')
    assertEqual(child.result.code, 'INTERNAL', '错误码')
    assertEqual(child.result.status, 500, 'HTTP 状态码')
    assertIncludes(child.result.message, 'embedding 未就绪', '文案应点明根因')
    assertIncludes(child.result.message, '无法创建知识库', '文案应带上"建库"的上下文')

    const after = await prisma.knowledgeBase.count()
    assertEqual(after, before, '失败必须不留半成品（行数不变）')

    // 子进程的 KB 表里应当没有那个名字（双重确认）
    assertEqual(
      await prisma.knowledgeBase.count({ where: { name: 'should-not-exist' } }),
      0,
      '不应留下 should-not-exist',
    )
    // 顺带确认主进程建的库还在（子进程没误删别人的数据）
    assertEqual(await prisma.knowledgeBase.count({ where: { id: kb.id } }), 1, '主进程的库应完好')
  })

  await it('未就绪时**读**接口仍可用：`embeddingModelChanged` 变成 `null`（无法判定），不是 500', async () => {
    // §八 要求"探测与告警要在 P0 就位，否则换模型时会静默出错"；反过来，provider 没配好
    // 也不该让**只读**接口不可用（否则连"哪个库需要重建"都看不到）。三态里的 null 就是为这个留的。
    const kb = await createKb(adminCookie, { name: `验证库-未就绪-读-${suffix}` })

    const child = await runChild(
      [
        `const { getKnowledgeBase } = await import('${distUrl('services/kb.service.js')}')`,
        `const item = await getKnowledgeBase(process.env.PROBE_KB_ID)`,
        `console.log('RESULT ' + JSON.stringify({ ok: true, embeddingModel: item.embeddingModel, changed: item.embeddingModelChanged, topK: item.retrievalConfig.topK }))`,
        `const { closePrisma } = await import('${distUrl('infra/prisma.js')}')`,
        `await closePrisma()`,
      ].join('\n'),
      {
        EMBEDDING_MODE: 'api',
        EMBEDDING_API_URL: '',
        EMBEDDING_API_KEY: '',
        EMBEDDING_API_MODEL: '',
        PROBE_KB_ID: kb.id,
      },
    )

    assertEqual(child.result.ok, true, '未就绪时读接口也应成功')
    assertEqual(child.result.changed, null, '⚠️ 无法判定时必须是 null —— 报 false 是一句谎话')
    assertEqual(child.result.embeddingModel, EXPECTED_EMBEDDING_MODEL, '快照值原样读回（不受当前 provider 影响）')
    assertEqual(child.result.topK, 8, '读路径也要能给出完整 config（topK 来自建库时的快照）')
  })

  // ═══════════════════════════════════════════════════════════════════
  // 收尾：清理 + 复核残留
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── 清理与残留复核 ──${c.x}`)

  await it('自清理复核：脚本建的知识库 / 文档 / chunk / S3 对象 / 账号全部清干净', async () => {
    // 正常路径下用例自己已经删掉大部分；这里兜住"中途失败留下的"
    await prisma.chunk.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    // 兜底：按名字前缀扫（含脚本中途失败留下的）
    const leftovers = await prisma.knowledgeBase.findMany({
      where: { OR: [{ name: { contains: suffix } }, { embeddingModel: 'db-default-probe' }] },
      select: { id: true },
    })
    for (const row of leftovers) {
      await prisma.chunk.deleteMany({ where: { kbId: row.id } })
      await prisma.document.deleteMany({ where: { kbId: row.id } })
    }
    await prisma.knowledgeBase.deleteMany({
      where: { OR: [{ name: { contains: suffix } }, { embeddingModel: 'db-default-probe' }] },
    })

    assertEqual(
      await prisma.knowledgeBase.count({ where: { name: { contains: suffix } } }),
      0,
      '残留知识库应为 0',
    )
    assertEqual(
      await prisma.knowledgeBase.count({ where: { embeddingModel: 'db-default-probe' } }),
      0,
      '残留探针行应为 0',
    )
    assertEqual(await prisma.chunk.count({ where: { kbId: { in: createdKbIds } } }), 0, '残留 chunk 应为 0')
    assertEqual(
      await prisma.agentComponent.count({ where: { refId: { in: createdKbIds } } }),
      0,
      '残留组件绑定应为 0',
    )

    // ⚠️ S3 侧的复核必须**按前缀 list**，不能只看脚本自己的记账数组 ——
    //    "记账说删了、对象其实还在"正是删库逻辑最可能出的错（比如 S3 key 拼错前缀）。
    //    先尽力清一遍再断言，这样失败时环境也是干净的、同时报告是诚实的。
    const prefix = `verify-kb/${suffix}/`
    const residual = []
    for await (const object of s3.listObjectsV2(bucket, prefix, true)) {
      if (object.name !== undefined) residual.push(object.name)
    }
    if (residual.length > 0) {
      await s3.removeObjects(bucket, residual)
      s3Keys.length = 0
    }
    assertEqual(residual.length, 0, `前缀 ${prefix} 下残留 S3 对象应为 0，实际 ${JSON.stringify(residual)}`)
  })
} finally {
  // ── 最终清理（一律 `deleteMany`：清理阶段"目标已经不在了"是正常情况，
  //    `delete` 会为不存在的记录往 stdout 丢一坨 P2025 堆栈，把断言输出冲掉）──
  try {
    await prisma.agentComponent.deleteMany({ where: { refId: { in: createdKbIds } } })
    await prisma.chunk.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({
      where: { OR: [{ name: { contains: suffix } }, { embeddingModel: 'db-default-probe' }] },
    })
    await prisma.agent.deleteMany({
      where: { OR: [{ id: { in: createdAgentIds } }, { name: { contains: suffix } }] },
    })
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    await prisma.model.deleteMany({ where: { modelName: { contains: suffix } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    await prisma.modelProvider.deleteMany({ where: { name: { contains: suffix } } })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s），
      //    不删就要等窗口过去才算干净（`06` P0-1-7 坑 5 的教训）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
    if (s3Keys.length > 0) await s3.removeObjects(bucket, s3Keys).catch(() => undefined)
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
  await app.close()
  await closePrisma()
  await closeRedis()
}

// ───────────────────────────── 子进程工具（第五档：注入环境变量）─────────────────────────────

/** `dist/backend/src/...` 的 file:// URL（`-e` 里只能动态 import URL 或不含反斜杠的路径） */
function distUrl(relative) {
  return new NodeURL(`../dist/backend/src/${relative}`, import.meta.url).href
}

/**
 * 起一个**纯净子进程**跑一段代码，并取回它打印的 `RESULT <json>`。
 *
 * 为什么必须起子进程：`config` 是**模块级单例**（import 即完成校验），工厂也按环境变量选路 ——
 * 在父进程里改 `process.env` 改不动已加载的它，且会污染同脚本后面的用例。
 * 子进程只注入本次要验的那几个变量，父进程与 `.env` 的当前状态解耦。
 *
 * ⚠️ 必须用**异步** `spawn`：`spawnSync` 会钉死父进程事件循环（P0-1-13 踩过）。
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

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-15 知识库 CRUD 验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-15 知识库 CRUD 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
