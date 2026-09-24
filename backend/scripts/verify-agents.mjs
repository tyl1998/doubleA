#!/usr/bin/env node
/**
 * verify-agents.mjs —— P0-1-22（智能体 CRUD）+ P0-1-23（组件绑定）的验收（需要真实 PG + Redis）
 *
 * 验的是 `02` §4.4 的六条端点 + `01` §3.3 决策 18 的权限 + 几条容易做错的语义：
 *   · **软删**的三件套：打 `deleted_at` 标记 / 解除组件绑定 / 会话转只读保留（`02` §4.4）；
 *   · **绑定模型**必须"存在 + `type=CHAT` + 模型与 Provider 都启用"（`01` §3.2 验收要点）；
 *   · **`canEdit`**：创建者 + ADMIN 为真，其余为假（列表是全员可见的）；
 *   · **组件绑定整体替换**（P0-1-23）：全量语义、引用校验、失败不动旧数据、集合相同不写库。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本脚本最想钉死的三件事
 * ─────────────────────────────────────────────────────────────────────
 * ① **权限是「全员可建可看可用；创建者 + ADMIN 可编删」，不是 ADMIN、也不是"仅创建者"**。
 *    所以这里**特意用 MEMBER 身份**把"建 / 改 / 删 / 改组件绑定"各跑一遍：模型池那一族是
 *    `(A)` 仅 ADMIN，若有人"顺手"给智能体也加上 `requireAdmin`（本仓已踩过两次这种直觉），
 *    本脚本会立刻红。反向的那一半同样要钉：**ADMIN 改别人的智能体必须成功**
 *    —— 只验"普通用户 403"的话，一个"仅创建者"的实现会全绿。
 * ② **软删不是"打个标记就完了"**：只打标记的实现会让**被绑的知识库永远删不掉**
 *    （`kb.service.ts` 的删库守卫数的是 `agent_components`），而界面上那个智能体已经"没了"
 *    —— 这是最隐蔽的一种坏法。故本脚本用"**删库 409 → 软删智能体 → 删库 200**"这条链取证。
 * ③ **组件整体替换里"校验"必须发生在"删除"之前**：反过来的实现在"引用了不存在的知识库"
 *    这条路上会**先删光旧绑定再报错** —— 请求是失败的，用户没有任何理由认为它改动了什么，
 *    但绑定已经没了。故 H 组不看"状态码对不对"，而是看**旧行的 `id` 是否逐字不变**
 *    （"某件事没发生"只能用"删得掉证据"的方式证明，见 `06` P0-1-19 的教训）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 依赖与前置
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 跑之前必须先起依赖并迁移：`pnpm infra:up && pnpm db:deploy`。
 * **不需要 S3**：本脚本不上传文档（建库/删库都不碰对象存储 —— 空文件列表时代码直接返回）。
 * 为什么要注入 `EMBEDDING_*`：E/H 组要建**真知识库**来验"解绑之后才删得掉"，
 * 而建库要取 `EmbeddingProvider.name()` 快照（**纯配置计算**，不发网络请求，见 P0-1-15）。
 * 注入一个永不会被访问的 URL 即可（`127.0.0.1:1`）。
 *
 * 脚本自造带随机后缀的 3 个用户 + 4 个模型 + 若干智能体/会话/知识库，结束时删净并**复核残留**。
 */

// ⚠️ 必须在 import `config.js`（经 dist 的 app.js 间接引入）**之前**设置：
//    ① 收敛脚本自身日志（本脚本会打一堆"应当失败"的请求，不收敛会把断言输出冲掉；
//       要看细节时：`LOG_LEVEL=debug node scripts/verify-agents.mjs`）
//       —— 收到 `fatal` 而不是 `error`：被**故意**制造失败的那几组用例，服务端正是按
//       `error` 级打日志的，收到 `error` 等于没收敛（P0-1-17 实测）
//    ② 注入可用的 embedding 配置：E 组建库要取快照（本机 `.env` 三项是空的）
process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = 'http://127.0.0.1:1/v1'
process.env.EMBEDDING_API_KEY = 'verify-agent-key'
process.env.EMBEDDING_API_MODEL = 'verify-embed-model'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const {
  AgentType,
  ComponentType,
  ConversationStatus,
  UserRole,
  UserStatus,
  closePrisma,
  getPrisma,
} = await import('../dist/backend/src/infra/prisma.js')
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const {
  AGENT_TYPES,
  COMPONENT_TYPES,
  GUIDE_QUESTIONS_MAX,
  canEditAgent,
  createAgentBodySchema,
  agentItemSchema,
  agentListResultSchema,
  normalizeGuideQuestions,
  removeAgentResultSchema,
  updateAgentBodySchema,
} = await import('@doubulea/shared')

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

/** 校验失败的信封里，字段级详情的 `message` 集合（`.refine()` 的 `path` 是空串，只能靠 message 找） */
function fieldMessages(body) {
  const fields = body?.data?.fields
  return Array.isArray(fields) ? fields.map((field) => field.message) : []
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
const PASSWORD = 'Verify-Agent-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-agent-admin-${suffix}`
/** 创建者（**非 ADMIN**）：建/改/删的主体，守"没被误加 requireAdmin" */
const ownerUsername = `verify-agent-owner-${suffix}`
/** 第三方普通用户（非创建者、非 ADMIN）：守"他人 Agent 改不动" */
const otherUsername = `verify-agent-other-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdKbIds = []
const createdConversationIds = []
// P0-2-2 起 `PUT …/components` 会对 MCP 引用做**存在性校验** ⇒ 正面用例要有一个真 server
const createdMcpIds = []

/** 一个语法合法但**不存在**的 uuid（用来验 404，而不撞 400 的参数校验） */
const MISSING_UUID = '01930000-0000-7000-8000-000000000000'

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()

/** 软删用例留下的 id（后续用例要拿它验"已删的一律 404"） */
let softDeletedAgentId = null

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

/** 建智能体并要求成功，返回契约化后的条目 */
async function createAgent(cookie, payload) {
  const response = await api('POST', '/api/agents', { cookie, payload })
  assertEqual(response.statusCode, 200, `建智能体状态码（${JSON.stringify(payload)}）`)
  const parsed = agentItemSchema.safeParse(response.json().data)
  assert(parsed.success, `建智能体响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  createdAgentIds.push(parsed.data.id)
  return parsed.data
}

/** 建知识库并要求成功（E 组用；与 verify-knowledge-bases 同一套形态） */
async function createKb(cookie, payload) {
  const response = await api('POST', '/api/knowledge-bases', { cookie, payload })
  assertEqual(response.statusCode, 200, `建知识库状态码（${JSON.stringify(payload)}）`)
  createdKbIds.push(response.json().data.id)
  return response.json().data
}

/** 列表里属于本脚本的那些 id（按返回顺序） */
async function myAgentIdsInList(cookie) {
  const response = await api('GET', '/api/agents?limit=100', { cookie })
  assertEqual(response.statusCode, 200, '列表状态码')
  const parsed = agentListResultSchema.safeParse(response.json().data)
  assert(parsed.success, `列表不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  const mine = new Set(createdAgentIds)
  return parsed.data.items.filter((item) => mine.has(item.id)).map((item) => item.id)
}

/**
 * 某个智能体的组件绑定**行**（带 id）。
 *
 * ⚠️ 带 `id` 是关键：`agent_components.id` 是 uuid7、由 Prisma 在插入时生成，
 * 于是"整份替换"与"原封不动"可以靠 **id 逐字是否变化**区分开 ——
 * 这正是 `06` P0-1-19 的"删得掉证据"手法（只看内容的话，"重写了一遍但内容相同"会被漏掉）。
 */
function componentRowsOf(agentId) {
  return prisma.agentComponent.findMany({
    where: { agentId },
    select: { id: true, componentType: true, refId: true },
    // 与实现里的读取顺序同序，便于把两次快照直接比对
    orderBy: [{ componentType: 'asc' }, { refId: 'asc' }],
  })
}

/** `PUT /api/agents/:id/components`（整体替换） */
function putComponents(cookie, agentId, components) {
  return api('PUT', `/api/agents/${agentId}/components`, { cookie, payload: { components } })
}

/** 把组件行快照压成一行字符串（用于"逐字不变"的断言） */
function rowsFingerprint(rows) {
  return JSON.stringify(rows)
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(
  `\n${c.b}══ P0-1-22/23 智能体验收：CRUD 与软删 / 绑定模型校验 / 权限 / 组件绑定整体替换 ══${c.x}`,
)

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

  const passwordHash = await hashPassword(PASSWORD)
  const createUser = (username, data) => prisma.user.create({ data: { username, passwordHash, ...data } })

  const admin = await createUser(adminUsername, {
    nickname: '智能体验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const owner = await createUser(ownerUsername, {
    nickname: '智能体验证创建者',
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const other = await createUser(otherUsername, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(admin.id, owner.id, other.id)

  const login = async (username) => {
    const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
    assertEqual(response.statusCode, 200, `登录 ${username}`)
    return cookieOf(response)
  }
  const adminCookie = await login(adminUsername)
  const ownerCookie = await login(ownerUsername)
  const otherCookie = await login(otherUsername)

  // 四个模型覆盖"可绑定"的各种反面（`01` §3.2 验收要点）
  const provider = await prisma.modelProvider.create({
    data: { name: `智能体验证 Provider ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
  })
  const disabledProvider = await prisma.modelProvider.create({
    data: {
      name: `智能体验证 Provider-停用 ${suffix}`,
      baseUrl: 'https://api.example.com/v1',
      type: 'CHAT',
      enabled: false,
    },
  })
  createdProviderIds.push(provider.id, disabledProvider.id)

  const mkModel = (data) => prisma.model.create({ data }).then((row) => (createdModelIds.push(row.id), row))
  const chatModel = await mkModel({
    providerId: provider.id,
    modelName: `verify-agent-chat-${suffix}`,
    label: '智能体验证对话模型',
    type: 'CHAT',
  })
  const disabledChatModel = await mkModel({
    providerId: provider.id,
    modelName: `verify-agent-chat-off-${suffix}`,
    label: '智能体验证对话模型-停用',
    type: 'CHAT',
    enabled: false,
  })
  const embeddingModel = await mkModel({
    providerId: provider.id,
    modelName: `verify-agent-embed-${suffix}`,
    label: '智能体验证向量模型',
    type: 'EMBEDDING',
  })
  const modelInDisabledProvider = await mkModel({
    providerId: disabledProvider.id,
    modelName: `verify-agent-chat-poff-${suffix}`,
    label: '智能体验证对话模型-Provider 停用',
    type: 'CHAT',
  })

  console.log(
    `  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${ownerUsername}（MEMBER·创建者）+ ${otherUsername}（MEMBER·第三方）${c.x}`,
  )
  console.log(
    `  ${c.d}模型：可用 1 / 停用 1 / 向量 1 / Provider 停用 1；注入 embedding 快照 api:${process.env.EMBEDDING_API_MODEL}${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  // A 组 · 契约、投影与两种类型
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── A 组 · 投影 / 两种类型 / 列表排序（HTTP）──${c.x}`)

  await it('枚举同源：契约的 AGENT_TYPES / COMPONENT_TYPES 与数据库枚举**逐字一致**', () => {
    assertEqual(
      JSON.stringify([...AGENT_TYPES].sort()),
      JSON.stringify(Object.values(AgentType).sort()),
      'AGENT_TYPES 与 schema.prisma 的 AgentType',
    )
    assertEqual(
      JSON.stringify([...COMPONENT_TYPES].sort()),
      JSON.stringify(Object.values(ComponentType).sort()),
      'COMPONENT_TYPES 与 schema.prisma 的 ComponentType',
    )
  })

  await it('两种类型都能建（`03` §4.2 第 1 条）：ChatBot 与 TaskAgent 各建一个，字段全覆盖', async () => {
    const chatbot = await createAgent(ownerCookie, {
      name: `验证智能体-ChatBot-${suffix}`,
      description: ' 带缩进的描述会 trim ',
      icon: ' 🤖 ',
      type: 'CHATBOT',
      // ⚠️ 提示词与开场白**刻意不 trim**（多行排版是提示词的一部分），这里连前导换行一起断言
      systemPrompt: '\n\n你是内部助手。\n请只依据资料回答。\n',
      openingRemarks: '你好，请问想了解什么？',
      guideQuestions: [' 报销流程是什么 ', '考勤怎么算'],
      modelId: chatModel.id,
    })
    assertEqual(chatbot.type, 'CHATBOT', 'type 回显')
    assertEqual(chatbot.createdBy, owner.id, '⚠️ createdBy 必须是会话用户，不能来自请求体')
    assertEqual(chatbot.creatorName, '智能体验证创建者', 'creatorName 用昵称')
    assertEqual(chatbot.canEdit, true, '创建者本人 canEdit=true')
    assertEqual(chatbot.description, '带缩进的描述会 trim', 'description 要 trim')
    assertEqual(chatbot.icon, '🤖', 'icon 要 trim')
    assertEqual(chatbot.systemPrompt, '\n\n你是内部助手。\n请只依据资料回答。\n', '⚠️ 提示词不能被 trim')
    assertEqual(chatbot.openingRemarks, '你好，请问想了解什么？', '开场白')
    assertEqual(
      JSON.stringify(chatbot.guideQuestions),
      JSON.stringify(['报销流程是什么', '考勤怎么算']),
      '引导问题要逐条 trim 后按序回显',
    )
    assertEqual(chatbot.modelId, chatModel.id, 'modelId')
    assertEqual(chatbot.modelName, chatModel.modelName, 'modelName 是上游型号名')
    assertEqual(chatbot.modelLabel, '智能体验证对话模型', 'modelLabel 是别名')
    assertEqual(chatbot.modelAvailable, true, '模型与 Provider 都启用 ⇒ modelAvailable=true')
    assertEqual(chatbot.components.length, 0, '刚建的没有组件绑定')

    const taskAgent = await createAgent(ownerCookie, {
      name: `验证智能体-TaskAgent-${suffix}`,
      type: 'TASK_AGENT',
      modelId: chatModel.id,
    })
    assertEqual(taskAgent.type, 'TASK_AGENT', 'type 回显（两种都要支持）')
    assertEqual(taskAgent.description, null, '没给描述应为 null')
    assertEqual(taskAgent.icon, null, '没给图标应为 null')
    assertEqual(JSON.stringify(taskAgent.guideQuestions), '[]', '省略引导问题应为空数组（不是 null）')
  })

  await it('`type` 必填、`modelId` 必填且必须是 UUID（缺参数给的是**字段级**明细）', async () => {
    const noType = await api('POST', '/api/agents', { cookie: ownerCookie, payload: { name: '缺类型', modelId: chatModel.id } })
    assertEqual(noType.statusCode, 400, '缺 type 的状态码')
    assertEqual(noType.json().code, 'VALIDATION', '信封 code')
    assert(
      noType.json().data.fields.some((field) => field.path === 'body.type'),
      `应报出 body.type，实际 ${JSON.stringify(noType.json().data.fields.map((f) => f.path))}`,
    )

    const badModel = await api('POST', '/api/agents', {
      cookie: ownerCookie,
      payload: { name: '坏模型 id', type: 'CHATBOT', modelId: 'not-a-uuid' },
    })
    assertEqual(badModel.statusCode, 400, '坏 modelId 的状态码')
    assertEqual(badModel.json().data.fields[0].path, 'body.modelId', '应报出 body.modelId')
  })

  await it('列表是**全员**的，且 `canEdit` 三个方向都对（自己真 / 他人假 / ADMIN 真）', async () => {
    const fromOwner = await api('GET', '/api/agents?limit=100', { cookie: ownerCookie })
    assertEqual(fromOwner.statusCode, 200, '创建者视角列表状态码')
    const ownerView = agentListResultSchema.parse(fromOwner.json().data)
    const own = ownerView.items.find((item) => item.id === createdAgentIds[0])
    assert(own !== undefined, '创建者应看得到自己建的智能体')
    assertEqual(own.canEdit, true, '创建者看自己的 ⇒ canEdit=true')

    const fromOther = await api('GET', '/api/agents?limit=100', { cookie: otherCookie })
    const otherView = agentListResultSchema.parse(fromOther.json().data)
    const seen = otherView.items.find((item) => item.id === createdAgentIds[0])
    assert(seen !== undefined, '⚠️ 列表对**全员**开放：第三方普通用户也要看得见别人的智能体')
    assertEqual(seen.canEdit, false, '⚠️ 列表对他人 Agent 必须返回 canEdit=false（本批验收门槛）')

    const fromAdmin = await api('GET', '/api/agents?limit=100', { cookie: adminCookie })
    const adminView = agentListResultSchema.parse(fromAdmin.json().data)
    assertEqual(
      adminView.items.find((item) => item.id === createdAgentIds[0])?.canEdit,
      true,
      '⚠️ ADMIN 看别人的也要 canEdit=true（只验 403 的话，"仅创建者"的实现会全绿）',
    )

    // 列表项的字段集合与详情**同一套投影**（P0-1-21 的教训：同一份数据不许有第二种形状）
    const detail = await api('GET', `/api/agents/${createdAgentIds[0]}`, { cookie: ownerCookie })
    assertEqual(detail.statusCode, 200, '详情状态码')
    assertEqual(
      JSON.stringify(agentItemSchema.parse(detail.json().data)),
      JSON.stringify(own),
      '详情与列表项（同一视角）应逐字一致',
    )
  })

  await it('列表排序是 `updatedAt desc`：刚改过的排最前（不是"最近创建"）', async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const first = await createAgent(ownerCookie, { name: `验证智能体-序-1-${suffix}`, type: 'CHATBOT', modelId: chatModel.id })
    await sleep(5)
    const second = await createAgent(ownerCookie, { name: `验证智能体-序-2-${suffix}`, type: 'CHATBOT', modelId: chatModel.id })
    await sleep(5)
    const third = await createAgent(ownerCookie, { name: `验证智能体-序-3-${suffix}`, type: 'CHATBOT', modelId: chatModel.id })

    const before = await myAgentIdsInList(ownerCookie)
    const beforeOrder = [first.id, second.id, third.id].map((id) => before.indexOf(id))
    assert(
      beforeOrder[2] < beforeOrder[1] && beforeOrder[1] < beforeOrder[0],
      `建完的顺序应是"最新在前"，实际下标 ${JSON.stringify(beforeOrder)}`,
    )

    // 改**最早**那个：它必须跳到这三个的最前面
    // （sleep 5ms 是必要的：`Timestamptz(3)` 只到毫秒，同一毫秒内会退化成 `id desc` 的次序）
    await sleep(5)
    const patched = await api('PATCH', `/api/agents/${first.id}`, {
      cookie: ownerCookie,
      payload: { name: `验证智能体-序-1改-${suffix}` },
    })
    assertEqual(patched.statusCode, 200, '改名状态码')
    const after = await myAgentIdsInList(ownerCookie)
    assert(
      after.indexOf(first.id) < after.indexOf(second.id) && after.indexOf(first.id) < after.indexOf(third.id),
      `改过的（最早的）应排到最前，实际顺序 ${JSON.stringify([first.id, second.id, third.id].map((id) => after.indexOf(id)))}`,
    )
  })

  await it('详情：非法 uuid → 400（`params.id` 明细）；不存在的 uuid → 404', async () => {
    const bad = await api('GET', '/api/agents/not-a-uuid', { cookie: ownerCookie })
    assertEqual(bad.statusCode, 400, '非法 uuid')
    assertEqual(bad.json().data.fields[0].path, 'params.id', '应报出 params.id')

    const missing = await api('GET', `/api/agents/${MISSING_UUID}`, { cookie: ownerCookie })
    assertEqual(missing.statusCode, 404, '不存在的智能体')
    assertEqual(missing.json().code, 'NOT_FOUND', '信封 code')
  })

  // ═══════════════════════════════════════════════════════════════════
  // B 组 · 绑定模型的可用性校验（本批验收门槛之一）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── B 组 · 绑定模型：与"可选列表"同口径（停用 / 类型 / Provider 停用 / 不存在）──${c.x}`)

  await it('绑定 **disabled** 模型被拒（验收门槛）：409 + 文案指出"停用"与去哪儿修', async () => {
    const response = await api('POST', '/api/agents', {
      cookie: ownerCookie,
      payload: { name: `验证智能体-绑停用-${suffix}`, type: 'CHATBOT', modelId: disabledChatModel.id },
    })
    assertEqual(response.statusCode, 409, '绑停用模型的状态码')
    assertEqual(response.json().code, 'CONFLICT', '信封 code')
    assertIncludes(response.json().msg, '停用', '文案要点破"停用"')
    assertIncludes(response.json().msg, '模型池管理页', '文案要给出可执行的出路')
  })

  await it('绑定向量模型 / Provider 停用的模型 / 不存在的模型：分别 409 / 409 / 404', async () => {
    const embed = await api('POST', '/api/agents', {
      cookie: ownerCookie,
      payload: { name: `验证智能体-绑向量-${suffix}`, type: 'CHATBOT', modelId: embeddingModel.id },
    })
    assertEqual(embed.statusCode, 409, '向量模型不可绑')
    assertIncludes(embed.json().msg, 'EMBEDDING', '文案要说明是向量模型')

    const providerOff = await api('POST', '/api/agents', {
      cookie: ownerCookie,
      payload: { name: `验证智能体-绑停用Provider-${suffix}`, type: 'CHATBOT', modelId: modelInDisabledProvider.id },
    })
    assertEqual(providerOff.statusCode, 409, 'Provider 停用的模型不可绑')
    assertIncludes(providerOff.json().msg, 'Provider', '文案要指到 Provider 上')

    const missing = await api('POST', '/api/agents', {
      cookie: ownerCookie,
      payload: { name: `验证智能体-绑不存在-${suffix}`, type: 'CHATBOT', modelId: MISSING_UUID },
    })
    assertEqual(missing.statusCode, 404, '不存在的模型')
  })

  await it('**一致性断言**：可选列表里的 CHAT 模型必须建得成，不在列表里的一律被拒（防两处口径漂移）', async () => {
    const response = await api('GET', '/api/models/available?type=CHAT', { cookie: ownerCookie })
    assertEqual(response.statusCode, 200, '可选列表状态码')
    const ids = response.json().data.items.map((item) => item.id)

    // ① 可用的那个必须在列表里（否则前端根本选不到它，而写入侧又放行）
    assert(ids.includes(chatModel.id), '可用的对话模型必须出现在可选列表里')
    // ② 三个反例必须**不在**列表里（否则"界面上能选、一提交就 409"）
    for (const [label, model] of [
      ['停用模型', disabledChatModel],
      ['向量模型', embeddingModel],
      ['Provider 停用的模型', modelInDisabledProvider],
    ]) {
      assert(!ids.includes(model.id), `${label}不该出现在 type=CHAT 的可选列表里`)
    }

    // ③ 列表里有的（本脚本造的那个）能建成功 —— 把"两处口径"钉在一起
    const created = await createAgent(ownerCookie, {
      name: `验证智能体-一致性-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    assertEqual(created.modelAvailable, true, '绑上之后 modelAvailable 应为 true')
  })

  await it('换绑只在 `modelId` **变了**时校验：模型事后被停用 → 仍能改名，且 `modelAvailable=false`', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-换绑-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })

    // 管理员事后把这个模型停用（模拟"绑的时候是好的"）
    await prisma.model.update({ where: { id: chatModel.id }, data: { enabled: false } })
    try {
      // ① 只改名字：**必须成功** —— 否则用户连改个名字都保存不了（前端整表单提交会带上 modelId）
      const renamed = await api('PATCH', `/api/agents/${agent.id}`, {
        cookie: ownerCookie,
        payload: { name: `验证智能体-换绑-改名-${suffix}` },
      })
      assertEqual(renamed.statusCode, 200, '⚠️ 绑定的模型被停用后，改名仍必须成功')
      const afterRename = agentItemSchema.parse(renamed.json().data)
      assertEqual(afterRename.modelAvailable, false, '⚠️ 模型被停用后 modelAvailable 必须变 false（界面据此提示）')
      assertEqual(afterRename.name, `验证智能体-换绑-改名-${suffix}`, 'name 应更新')

      // ② 整表单提交（带**同值** modelId）：幂等放行
      const same = await api('PATCH', `/api/agents/${agent.id}`, {
        cookie: ownerCookie,
        payload: { name: `验证智能体-换绑-同名-${suffix}`, modelId: chatModel.id },
      })
      assertEqual(same.statusCode, 200, '同值 modelId 应幂等放行（整表单提交不能因为"没改"而失败）')

      // ③ 换到**另一个**不可用的模型：必须被拒
      const switched = await api('PATCH', `/api/agents/${agent.id}`, {
        cookie: ownerCookie,
        payload: { modelId: modelInDisabledProvider.id },
      })
      assertEqual(switched.statusCode, 409, '换绑到不可用的模型必须被拒')

      // ④ 换回可用的（复用一个仍启用的模型）：成功
      const otherGood = await prisma.model.create({
        data: {
          providerId: provider.id,
          modelName: `verify-agent-chat2-${suffix}`,
          label: '智能体验证对话模型2',
          type: 'CHAT',
        },
      })
      createdModelIds.push(otherGood.id)
      const okSwitch = await api('PATCH', `/api/agents/${agent.id}`, {
        cookie: ownerCookie,
        payload: { modelId: otherGood.id },
      })
      assertEqual(okSwitch.statusCode, 200, '换绑到可用模型应成功')
      assertEqual(agentItemSchema.parse(okSwitch.json().data).modelAvailable, true, '换绑后 modelAvailable 应回 true')
    } finally {
      // 复原，免得影响后面的用例 / 留下一个被停用的模型
      await prisma.model.update({ where: { id: chatModel.id }, data: { enabled: true } })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // C 组 · 权限：创建者 + ADMIN（`01` §3.3 决策 18）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── C 组 · 权限：创建者 + ADMIN 可编删，其余 403 ──${c.x}`)

  await it('第三方**普通用户** PATCH / DELETE 他人的 Agent → 403（本批验收门槛）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-权限-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })

    const patched = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: otherCookie,
      payload: { name: '我想改别人的' },
    })
    assertEqual(patched.statusCode, 403, '第三方普通用户 PATCH 他人 Agent')
    assertEqual(patched.json().code, 'FORBIDDEN', '信封 code')

    const removed = await api('DELETE', `/api/agents/${agent.id}`, { cookie: otherCookie })
    assertEqual(removed.statusCode, 403, '第三方普通用户 DELETE 他人 Agent')

    // ③ 两次都必须是 403 而**不是 404**：智能体 id 本来就出现在全员可见的列表里，藏不住也不必藏
    const stillThere = await api('GET', `/api/agents/${agent.id}`, { cookie: otherCookie })
    assertEqual(stillThere.statusCode, 200, '他人仍能**看**（可看可用），只是不能改/删')
  })

  await it('创建者本人能改能删（反向守卫：防"只有 ADMIN 能改"的实现）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-本人-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const patched = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { description: '本人改的' },
    })
    assertEqual(patched.statusCode, 200, '创建者本人 PATCH')
    assertEqual(agentItemSchema.parse(patched.json().data).description, '本人改的', '描述应写入')

    const removed = await api('DELETE', `/api/agents/${agent.id}`, { cookie: ownerCookie })
    assertEqual(removed.statusCode, 200, '创建者本人 DELETE')
  })

  await it('ADMIN 能改**别人**的 Agent（反向守卫：防"仅创建者"的实现）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-管理员-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const patched = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: adminCookie,
      payload: { description: '管理员改的' },
    })
    assertEqual(patched.statusCode, 200, '⚠️ ADMIN 必须能改别人的（"创建者 + ADMIN 可编删"里的后半句）')
    const item = agentItemSchema.parse(patched.json().data)
    assertEqual(item.description, '管理员改的', '描述应写入')
    assertEqual(item.canEdit, true, 'ADMIN 视角 canEdit=true')

    const removed = await api('DELETE', `/api/agents/${agent.id}`, { cookie: adminCookie })
    assertEqual(removed.statusCode, 200, 'ADMIN 能删别人的')
  })

  await it('五条路由未登录一律 401（且不碰会话存储）', async () => {
    // ⚠️ 必须给**语法合法**的 body/params：Fastify 的校验在 preHandler **之前**跑，
    //    空 body 会先拿 400（那样就验不到 401 了）
    const cases = [
      ['GET', '/api/agents', undefined],
      ['POST', '/api/agents', { name: '未登录', type: 'CHATBOT', modelId: MISSING_UUID }],
      ['GET', `/api/agents/${MISSING_UUID}`, undefined],
      ['PATCH', `/api/agents/${MISSING_UUID}`, { name: '未登录' }],
      ['DELETE', `/api/agents/${MISSING_UUID}`, undefined],
    ]
    for (const [method, url, payload] of cases) {
      const response = await api(method, url, { payload })
      assertEqual(response.statusCode, 401, `${method} ${url} 未登录`)
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // D 组 · 三态 / 字段覆盖 / 不可改的 type
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── D 组 · 三态与字段覆盖（响应对 + 库里也对）──${c.x}`)

  await it('四个文本字段是**三态**：不带=不动 / `null`=清空 / 值=设置（库里逐字段核对）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-三态-${suffix}`,
      description: '初始描述',
      icon: '🎯',
      type: 'CHATBOT',
      systemPrompt: '初始提示词',
      openingRemarks: '初始开场白',
      modelId: chatModel.id,
    })

    // ① 只改 name：另外四个必须原封不动
    const renamed = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { name: `验证智能体-三态-改-${suffix}` },
    })
    assertEqual(renamed.statusCode, 200, '改名状态码')
    const afterRename = agentItemSchema.parse(renamed.json().data)
    assertEqual(afterRename.description, '初始描述', '⚠️ 不带 description 时必须保持不动')
    assertEqual(afterRename.icon, '🎯', '⚠️ 不带 icon 时必须保持不动')
    assertEqual(afterRename.systemPrompt, '初始提示词', '⚠️ 不带 systemPrompt 时必须保持不动')
    assertEqual(afterRename.openingRemarks, '初始开场白', '⚠️ 不带 openingRemarks 时必须保持不动')

    // ② 四个一起 null = 清空
    const cleared = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { description: null, icon: null, systemPrompt: null, openingRemarks: null },
    })
    assertEqual(cleared.statusCode, 200, '清空状态码')
    const afterClear = agentItemSchema.parse(cleared.json().data)
    for (const key of ['description', 'icon', 'systemPrompt', 'openingRemarks']) {
      assertEqual(afterClear[key], null, `null 应清空 ${key}`)
    }

    // ③ 库里核对（三态实现错了常常表现为"响应对、库里没写"）
    const row = await prisma.agent.findUnique({
      where: { id: agent.id },
      select: { name: true, description: true, icon: true, systemPrompt: true, openingRemarks: true },
    })
    assertEqual(row.name, `验证智能体-三态-改-${suffix}`, '存储层的 name')
    assertEqual(row.description, null, '存储层的 description')
    assertEqual(row.icon, null, '存储层的 icon')
    assertEqual(row.systemPrompt, null, '存储层的 systemPrompt')
    assertEqual(row.openingRemarks, null, '存储层的 openingRemarks')

    // ④ 字符串 = 设置
    const setAgain = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { systemPrompt: '重新写的提示词', description: '重新写的描述' },
    })
    assertEqual(setAgain.statusCode, 200, '重设状态码')
    const afterSet = agentItemSchema.parse(setAgain.json().data)
    assertEqual(afterSet.systemPrompt, '重新写的提示词', '字符串应写回')
    assertEqual(afterSet.description, '重新写的描述', '字符串应写回')
  })

  await it('`guideQuestions`：`[]` 清空 / 不带不动 / 真写进 jsonb / 四条边界各 400', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-引导-${suffix}`,
      type: 'CHATBOT',
      guideQuestions: ['问题一', '问题二'],
      modelId: chatModel.id,
    })

    // ① 不带 = 不动
    const untouched = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { description: '顺手改个别的' },
    })
    assertEqual(
      JSON.stringify(agentItemSchema.parse(untouched.json().data).guideQuestions),
      JSON.stringify(['问题一', '问题二']),
      '⚠️ 不带 guideQuestions 时必须保持不动',
    )

    // ② `[]` = 清空（用空数组表达清空，而不是 null —— 契约里刻意只有一种写法）
    const cleared = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { guideQuestions: [] },
    })
    assertEqual(cleared.statusCode, 200, '清空状态码')
    assertEqual(JSON.stringify(agentItemSchema.parse(cleared.json().data).guideQuestions), '[]', '空数组应清空')

    // ③ 写回并核对**存储层**（jsonb 真的写进去了，而不是只在响应里回显）
    const set = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { guideQuestions: [' 带空格 ', '第二条'] },
    })
    assertEqual(set.statusCode, 200, '设置状态码')
    assertEqual(
      JSON.stringify(agentItemSchema.parse(set.json().data).guideQuestions),
      JSON.stringify(['带空格', '第二条']),
      '元素要 trim',
    )
    const row = await prisma.agent.findUnique({ where: { id: agent.id }, select: { guideQuestions: true } })
    assertEqual(JSON.stringify(row.guideQuestions), JSON.stringify(['带空格', '第二条']), '存储层的 jsonb')

    // ④ 边界：非数组 / 含非字符串 / 空白项 / 超条数 / 单条超长 —— 每条都要求**字段级文案**
    //    （顶层 msg 恒为「请求参数校验失败」，真正说明原因的只有 `data.fields[].message`）
    const tooMany = Array.from({ length: GUIDE_QUESTIONS_MAX + 1 }, (_, index) => `问题${index}`)
    const cases = [
      ['非数组', 'not-an-array', '必须是字符串数组'],
      ['含非字符串', ['好的', 3], '必须是字符串'],
      ['空白项', ['   '], '不能为空'],
      ['超条数', tooMany, `最多 ${GUIDE_QUESTIONS_MAX} 条`],
      ['单条超长', ['x'.repeat(201)], '最多 200 个字符'],
    ]
    for (const [label, value, expected] of cases) {
      const response = await api('PATCH', `/api/agents/${agent.id}`, {
        cookie: ownerCookie,
        payload: { guideQuestions: value },
      })
      assertEqual(response.statusCode, 400, `引导问题·${label} 应 400`)
      const messages = fieldMessages(response.json())
      assert(
        messages.some((message) => message.includes(expected)),
        `引导问题·${label} 的字段级文案应含 ${JSON.stringify(expected)}，实际 ${JSON.stringify(messages)}`,
      )
    }
  })

  await it('`type` **不可改**：传不同值 → 409（显式报错而不是静默忽略）；传同值 → 200（幂等）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-类型锁定-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })

    const changed = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { type: 'TASK_AGENT' },
    })
    assertEqual(changed.statusCode, 409, '⚠️ 改 type 必须显式 409（静默 strip 会让调用方以为改成功了）')
    assertIncludes(changed.json().msg, '不可修改', '文案要说清"创建后不可改"')

    const same = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { type: 'CHATBOT', name: `验证智能体-类型锁定改-${suffix}` },
    })
    assertEqual(same.statusCode, 200, '传同值应幂等放行（整表单提交不该失败）')

    // 库里必须还是原类型
    const row = await prisma.agent.findUnique({ where: { id: agent.id }, select: { type: true } })
    assertEqual(row.type, 'CHATBOT', '存储层的 type')
  })

  await it('空 body → 400，且**文案在字段明细里**（`.refine()` 的 path 是空串，只能遍历 message）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-空body-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const response = await api('PATCH', `/api/agents/${agent.id}`, { cookie: ownerCookie, payload: {} })
    assertEqual(response.statusCode, 400, '空 body 状态码')
    // ⚠️ 顶层 msg 恒为「请求参数校验失败」，真正的文案在 data.fields[].message 里
    assertEqual(response.json().msg, '请求参数校验失败', '顶层 msg 是固定的那句')
    assert(
      fieldMessages(response.json()).includes('至少要提供一个要修改的字段'),
      `应带"至少要提供一个要修改的字段"，实际 ${JSON.stringify(fieldMessages(response.json()))}`,
    )
    // 三态字段给 `null`/`[]` 也算"给了字段"（不该被 refine 拦下）
    const clearOnly = await api('PATCH', `/api/agents/${agent.id}`, {
      cookie: ownerCookie,
      payload: { description: null },
    })
    assertEqual(clearOnly.statusCode, 200, '`description: null` 算"给了字段"，不该被 refine 拦成 400')
  })

  // ═══════════════════════════════════════════════════════════════════
  // E 组 · 软删的三件套（`02` §4.4）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── E 组 · 软删：打标记 + 解绑组件 + 会话转只读（三件事一个事务）──${c.x}`)

  await it('软删三件套：详情 404 但**行还在**；组件解除；会话转只读且**保留**', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-软删-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kb = await createKb(ownerCookie, { name: `智能体验证库-软删-${suffix}` })

    // 组件写侧（P0-1-23）本批已落地：知识库那条走**真端点**
    // （上一批这里还是"直接插库"的等价取证 —— 现在没有理由再插库了）
    const bound = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
    ])
    assertEqual(bound.statusCode, 200, '用真端点 PUT 绑定知识库')

    // ⚠️ 指向"不存在的 server"的 MCP 行**只能手工插**：P0-2-2 起 `PUT …/components` 会对
    //    MCP 引用做**存在性校验**（指向真 server 才写得进去，见本组后面那条对偶用例），
    //    而这里要的恰好是一条**悬空引用**。它造出的取证对象更狠 ——
    //    **手工塞进库的脏行也必须被软删清干净**，否则那条悬空引用会永远留在库里
    //    （`kb.service.ts` 文件头 ④ 说的"孤儿绑定"就是这个形状）。
    await prisma.agentComponent.createMany({
      data: [{ agentId: agent.id, componentType: ComponentType.MCP, refId: other.id }],
    })

    // 读侧：详情应回显两条绑定（本批"详情含组件绑定"的验收点）
    const detail = await api('GET', `/api/agents/${agent.id}`, { cookie: ownerCookie })
    assertEqual(detail.statusCode, 200, '详情状态码')
    const withComponents = agentItemSchema.parse(detail.json().data)
    assertEqual(withComponents.components.length, 2, '详情应回显两条组件绑定')
    assertEqual(
      JSON.stringify(withComponents.components.map((item) => item.componentType).sort()),
      JSON.stringify(['KNOWLEDGE', 'MCP']),
      '两种类型的绑定都要回显',
    )

    // 前置取证①：被绑的知识库此刻**删不掉**（证明引用计数真的在看 agent_components）
    const blocked = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: ownerCookie })
    assertEqual(blocked.statusCode, 409, '被 Agent 绑定的知识库应 409')

    // 两个会话：一个 ACTIVE、一个**已经** FINISHED —— 用来证明返回的数字只数"真的被改的"
    const activeConv = await prisma.conversation.create({
      data: {
        agentId: agent.id,
        userId: owner.id,
        status: ConversationStatus.ACTIVE,
        topic: `验证会话-活跃-${suffix}`,
        lastMessageAt: new Date(),
      },
    })
    const doneConv = await prisma.conversation.create({
      data: {
        agentId: agent.id,
        userId: owner.id,
        status: ConversationStatus.FINISHED,
        topic: `验证会话-已完成-${suffix}`,
      },
    })
    createdConversationIds.push(activeConv.id, doneConv.id)

    const removed = await api('DELETE', `/api/agents/${agent.id}`, { cookie: ownerCookie })
    assertEqual(removed.statusCode, 200, '删除状态码')
    const result = removeAgentResultSchema.safeParse(removed.json().data)
    assert(result.success, `删除响应不符合契约：${JSON.stringify(result.error?.issues)}`)
    assertEqual(result.data.removedComponents, 2, '两条绑定都要解除')
    assertEqual(
      result.data.finishedConversations,
      1,
      '⚠️ 只该数**真的被改的**那一个（已经 FINISHED 的不算，否则级联提示会虚报）',
    )
    softDeletedAgentId = agent.id

    // ① 打标记：详情 404、列表里没有、但**行还在**（软删不是硬删）
    assertEqual(
      (await api('GET', `/api/agents/${agent.id}`, { cookie: ownerCookie })).statusCode,
      404,
      '软删后详情应 404',
    )
    const inList = await myAgentIdsInList(ownerCookie)
    assert(!inList.includes(agent.id), '软删后不该出现在列表里')
    const row = await prisma.agent.findUnique({ where: { id: agent.id }, select: { deletedAt: true, name: true } })
    assert(row !== null, '软删必须**保留行**（会话要挂在它上面）')
    assert(row.deletedAt !== null, 'deleted_at 应被写入')

    // ② 解绑：组件行清空 ⇒ 被绑的知识库这才删得掉
    assertEqual(await prisma.agentComponent.count({ where: { agentId: agent.id } }), 0, '组件绑定应被解除')
    const nowDeletable = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: ownerCookie })
    assertEqual(
      nowDeletable.statusCode,
      200,
      '⚠️ 解绑之后这个知识库必须删得掉（只打标记的实现会在这里红）',
    )

    // ③ 会话转只读**且保留**
    const conversations = await prisma.conversation.findMany({
      where: { agentId: agent.id },
      select: { id: true, status: true },
    })
    assertEqual(conversations.length, 2, '会话必须**保留**（只读），不能被连带删除')
    for (const conversation of conversations) {
      assertEqual(conversation.status, 'FINISHED', '所有会话都要转成只读')
    }
  })

  await it('已软删的一律 404：再删一次 404、PATCH 404（**不是** 403，也不是能改回来）', async () => {
    assert(softDeletedAgentId !== null, '前置：上一条用例必须已经软删了一个智能体')
    const again = await api('DELETE', `/api/agents/${softDeletedAgentId}`, { cookie: ownerCookie })
    assertEqual(again.statusCode, 404, '重复删除应 404')

    const patched = await api('PATCH', `/api/agents/${softDeletedAgentId}`, {
      cookie: ownerCookie,
      payload: { name: '想改回来' },
    })
    assertEqual(patched.statusCode, 404, '软删后 PATCH 应 404（创建者也不行 —— 详情都查不到的东西不该能改）')

    // ADMIN 也一样（404 走的是"不存在"，与权限无关）
    const byAdmin = await api('PATCH', `/api/agents/${softDeletedAgentId}`, {
      cookie: adminCookie,
      payload: { name: '管理员也想改回来' },
    })
    assertEqual(byAdmin.statusCode, 404, 'ADMIN 也改不了软删的')
  })

  await it('口径一致性（跨批次）：软删的 Agent **仍占**模型的引用计数（与删除守卫同口径）', async () => {
    // `02` §三 / P0-1-11 定过：`ModelItem.agentCount` **含软删的 Agent**（`agents.model_id`
    // 是 RESTRICT，软删的行照样占外键）。本批的软删实现不能把这条口径改掉 ——
    // 否则会出现"界面上说能删、删下去 500"。
    const response = await api('GET', '/api/models?limit=100', { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '模型管理列表状态码')
    const item = response.json().data.items.find((model) => model.id === chatModel.id)
    assert(item !== undefined, '应能找到验证用的模型')

    const total = await prisma.agent.count({ where: { modelId: chatModel.id } })
    const alive = await prisma.agent.count({ where: { modelId: chatModel.id, deletedAt: null } })
    assertEqual(item.agentCount, total, 'agentCount 必须等于**含软删**的总数')
    assert(
      total > alive,
      `前置不成立：此刻应至少有一个软删的 Agent 绑在这个模型上（total=${total}, alive=${alive}）`,
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  // F 组 · 路由表（注册了什么、刻意**没**注册什么）
  // ═══════════════════════════════════════════════════════════════════
console.log(`\n${c.b}── F 组 · 路由表：七条已注册（含 P0-1-25 的会话列表），仅"复制"（P1）刻意不存在 ──${c.x}`)

await it('七条路由都在（含 P0-1-25 的会话列表），仅"复制"是 P1；不存在的 agent 一律 404', async () => {
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/agents' }), true, '列表')
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/agents' }), true, '创建')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/agents/:id' }), true, '详情')
  assertEqual(app.hasRoute({ method: 'PATCH', url: '/api/agents/:id' }), true, '编辑')
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/agents/:id' }), true, '删除')
  // ⚠️ 上一批（P0-1-22）这条断言写的是 `false`（"属 P0-1-23，不提前注册"）；本批落地后翻转为 `true`
  assertEqual(
    app.hasRoute({ method: 'PUT', url: '/api/agents/:id/components' }),
    true,
    '组件整体替换（P0-1-23）',
  )
  // ⚠️ 同上：P0-1-24 时这里写的是 `false`（"会话列表属 P0-1-25"）；P0-1-25 落地后翻转为 `true`
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/agents/:id/conversations' }),
    true,
    '会话列表（P0-1-25 已落地）',
  )

  // 复制是 **P1**（`02` §4.4 已标），至今刻意未注册
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/agents/:id/copy' }), false, '复制是 P1')

  for (const [method, url] of [
    ['POST', `/api/agents/${MISSING_UUID}/copy`],
    ['GET', `/api/agents/${MISSING_UUID}/conversations`],
  ]) {
    const response = await api(method, url, { cookie: ownerCookie, payload: method === 'GET' ? undefined : {} })
    assertEqual(response.statusCode, 404, `${method} ${url} 应 404`)
  }
})

  // ═══════════════════════════════════════════════════════════════════
  // G 组 · 纯函数（契约层，与依赖无关，但放在这里顺带真跑一次）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── G 组 · 纯函数：canEditAgent / normalizeGuideQuestions / schema ──${c.x}`)

  await it('`canEditAgent` 矩阵：创建者真 / ADMIN 真 / 其余假 / 软删一律假', () => {
    const row = { createdBy: owner.id, deletedAt: null }
    assertEqual(canEditAgent(row, { id: owner.id, role: 'MEMBER' }), true, '创建者本人')
    assertEqual(canEditAgent(row, { id: admin.id, role: 'ADMIN' }), true, 'ADMIN 改别人的')
    assertEqual(canEditAgent(row, { id: other.id, role: 'MEMBER' }), false, '第三方普通用户')
    assertEqual(canEditAgent({ ...row, deletedAt: new Date() }, { id: admin.id, role: 'ADMIN' }), false, '软删的连 ADMIN 也不可')
    assertEqual(
      canEditAgent({ ...row, deletedAt: '2026-09-22T00:00:00.000Z' }, { id: owner.id, role: 'MEMBER' }),
      false,
      'deletedAt 传字符串（验收脚本/JSON 里的形态）也要能判',
    )
  })

  await it('`normalizeGuideQuestions` 永不抛错：非数组→[]、丢非字符串、trim、丢空串、**不截断**', () => {
    assertEqual(JSON.stringify(normalizeGuideQuestions(undefined)), '[]', 'undefined')
    assertEqual(JSON.stringify(normalizeGuideQuestions(null)), '[]', 'null')
    assertEqual(JSON.stringify(normalizeGuideQuestions({ a: 1 })), '[]', '对象')
    assertEqual(JSON.stringify(normalizeGuideQuestions('字符串')), '[]', '字符串')
    assertEqual(
      JSON.stringify(normalizeGuideQuestions([' a ', 3, null, '', '   ', 'b'])),
      JSON.stringify(['a', 'b']),
      '兼顾 trim 与过滤',
    )
    const long = Array.from({ length: GUIDE_QUESTIONS_MAX + 5 }, (_, index) => `第${index}问`)
    assertEqual(
      normalizeGuideQuestions(long).length,
      GUIDE_QUESTIONS_MAX + 5,
      '⚠️ 读取端刻意**不截断**（截断=静默丢数据），上限只在写入口拦',
    )
  })

  await it('输出的键集合里**没有** `deletedAt` 之类的内部列（防"以后有人顺手 select 出去"）', () => {
    const keys = Object.keys(agentItemSchema.shape)
    const parsed = createAgentBodySchema.safeParse({ name: '键集合探针', type: 'CHATBOT', modelId: MISSING_UUID })
    assert(parsed.success, '一份合法的建 body 应能通过（顺带钉住必填项恰好是这三个）')
    assertEqual(
      JSON.stringify(Object.keys(parsed.data).sort()),
      JSON.stringify(['modelId', 'name', 'type']),
      '省略的可选字段**不该**被 zod 补成 null（补了就等于"创建时没给 = 清空"）',
    )
    for (const forbidden of ['deletedAt', 'fileKey', 'contentHash']) {
      assert(!keys.includes(forbidden), `输出投影不该含 ${forbidden}`)
    }
    assertEqual(updateAgentBodySchema.safeParse({ name: 'x' }).data.description, undefined, '不带 description ⇒ undefined')
    assertEqual(
      updateAgentBodySchema.safeParse({ name: 'x' }).data.description,
      undefined,
      '⚠️ 绝不能有 `.default(null)`：那会把"不动"与"清空"合并',
    )
  })
  // ═══════════════════════════════════════════════════════════════════
  // H 组 · 组件绑定整体替换（P0-1-23）
  // ═══════════════════════════════════════════════════════════════════
  console.log(
    `\n${c.b}── H 组 · 组件绑定：PUT 全量替换 / 引用校验（先校验后删）/ 幂等 / 权限 ──${c.x}`,
  )

  await it('整体替换：空 → 2 个库 → 详情立即反映；改小后旧的消失（+ 跨模块引用计数联动）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-组件-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kbA = await createKb(ownerCookie, { name: `智能体验证库-A-${suffix}` })
    const kbB = await createKb(ownerCookie, { name: `智能体验证库-B-${suffix}` })

    const bound = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kbA.id },
      { componentType: 'KNOWLEDGE', refId: kbB.id },
    ])
    assertEqual(bound.statusCode, 200, '绑定 2 个知识库的状态码')
    const afterBind = agentItemSchema.parse(bound.json().data)
    assertEqual(
      JSON.stringify(Object.keys(afterBind).sort()),
      JSON.stringify(Object.keys(agentItemSchema.shape).sort()),
      '响应仍是**同一套投影**（不是只回 components；集合比较先排序）',
    )
    assertEqual(afterBind.components.length, 2, '响应应回显 2 条绑定')

    // 响应 = 详情那套投影：与 `GET /api/agents/:id` **逐字一致**（P0-1-21 的教训：同一份数据不许有两种形状）
    const detail = await api('GET', `/api/agents/${agent.id}`, { cookie: ownerCookie })
    assertEqual(detail.statusCode, 200, '详情状态码')
    assertEqual(
      JSON.stringify(agentItemSchema.parse(detail.json().data)),
      JSON.stringify(afterBind),
      'PUT 的响应应与详情逐字一致',
    )
    // 顺序稳定（`componentType asc, refId asc`）：前端把这两组分别灌进多选框，顺序跳会让界面闪
    assertEqual(
      JSON.stringify(afterBind.components.map((item) => item.refId)),
      JSON.stringify([kbA.id, kbB.id].sort()),
      '绑定顺序应是 (componentType, refId) 升序（与读取端 orderBy 同序）',
    )

    // 跨模块：`kb.service.ts` 的 agentCount 数的是 `agent_components`（`02` §3.1 的多态引用）
    const kbList = await api('GET', '/api/knowledge-bases?limit=100', { cookie: ownerCookie })
    assertEqual(kbList.statusCode, 200, '知识库列表状态码')
    const counts = new Map(kbList.json().data.items.map((item) => [item.id, item.agentCount]))
    assertEqual(counts.get(kbA.id), 1, 'A 的 agentCount 应为 1（刚绑上）')
    assertEqual(counts.get(kbB.id), 1, 'B 的 agentCount 应为 1（刚绑上）')

    // 改小：只留 B —— A 那条必须**立即**消失（验收门槛原文："解绑后详情立即反映"）
    const replaced = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kbB.id },
    ])
    assertEqual(replaced.statusCode, 200, '替换状态码')
    assertEqual(
      JSON.stringify(agentItemSchema.parse(replaced.json().data).components.map((c) => c.refId)),
      JSON.stringify([kbB.id]),
      '⚠️ 只该剩 B（全量替换＝提交什么库里就有什么）',
    )
    assertEqual(
      await prisma.agentComponent.count({ where: { agentId: agent.id, refId: kbA.id } }),
      0,
      '⚠️ A 的绑定行必须被删除（不是"留在库里但不下发"）',
    )
  })

  await it('解绑之后**被绑的库才删得掉**（真链路版：PUT 绑定 → 删库 409 → PUT [] → 删库 200）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-解绑-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kb = await createKb(ownerCookie, { name: `智能体验证库-解绑-${suffix}` })

    assertEqual(
      (await putComponents(ownerCookie, agent.id, [{ componentType: 'KNOWLEDGE', refId: kb.id }]))
        .statusCode,
      200,
      '先绑上',
    )
    const blocked = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: ownerCookie })
    assertEqual(blocked.statusCode, 409, '被绑定时删库应 409')
    assertIncludes(blocked.json().msg, '正被 1 个 Agent 绑定', '文案要给出数字（用户才知道去哪儿解绑）')

    const cleared = await putComponents(ownerCookie, agent.id, [])
    assertEqual(cleared.statusCode, 200, '`[]` = 解绑全部')
    assertEqual(agentItemSchema.parse(cleared.json().data).components.length, 0, '详情立即反映为空')

    assertEqual(
      (await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: ownerCookie })).statusCode,
      200,
      '⚠️ 解绑之后这个库必须删得掉',
    )
    // 已删的库从清理清单里剔掉（清理段的 deleteMany 不会因此报错，但清单要诚实）
    const index = createdKbIds.indexOf(kb.id)
    if (index >= 0) createdKbIds.splice(index, 1)
  })

  await it('⚠️ 校验失败时**旧绑定逐字不变**（校验必须在删除之前）+ 引用不存在的 MCP server 被拒', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-失败不动-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kb = await createKb(ownerCookie, { name: `智能体验证库-失败不动-${suffix}` })
    assertEqual(
      (await putComponents(ownerCookie, agent.id, [{ componentType: 'KNOWLEDGE', refId: kb.id }]))
        .statusCode,
      200,
      '前置：先绑上一条',
    )
    const before = await componentRowsOf(agent.id)
    assertEqual(before.length, 1, '前置：应恰好一条绑定')

    // ① 引用一个**语法合法但库里不存在**的知识库
    const missing = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
      { componentType: 'KNOWLEDGE', refId: MISSING_UUID },
    ])
    assertEqual(missing.statusCode, 404, '引用不存在的知识库应 404')
    assertIncludes(missing.json().msg, MISSING_UUID, '文案要带上是哪个 id（前端 message.error 直接能说清）')
    assertEqual(
      rowsFingerprint(await componentRowsOf(agent.id)),
      rowsFingerprint(before),
      '⚠️ 失败的 PUT 不该动任何一行（**含 `id`**：先删后校验的实现会在这里红）',
    )

    // ② 引用一个**语法合法但 mcp_servers 里不存在**的 id
    //    ⚠️ 这条断言在 P0-2-2 **被翻转**过：P0-1 阶段 MCP 一律 400 且文案指向"功能还没上线"，
    //       现在接回点是**存在性校验**（`06` P0-2-2 坑预判 4）。判断依据从"版本没到"变成
    //       "这个 id 查不到"，故期望值由 400/VALIDATION 改成 404/NOT_FOUND
    //       —— 这是 §七"刻意未注册型断言的保质期"的又一次性发作。
    const withMcp = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
      { componentType: 'MCP', refId: other.id }, // 语法合法（uuid），但那是**用户 id**，不在 mcp_servers 里
    ])
    assertEqual(withMcp.statusCode, 404, '引用不存在的 MCP server 应 404')
    assertEqual(withMcp.json().code, 'NOT_FOUND', '信封 code')
    assertIncludes(withMcp.json().msg, 'MCP', '⚠️ 文案要点出是 MCP 的问题（两个 404 都写成"知识库不存在"会把人引偏）')
    assertIncludes(withMcp.json().msg, other.id, '文案要带上具体是哪个 id')
    assertEqual(
      rowsFingerprint(await componentRowsOf(agent.id)),
      rowsFingerprint(before),
      '⚠️ 被拒的 PUT 也不该动任何一行',
    )

    // ③ **对偶的另一半**（P0-2-2 新增）：引用一个**真实存在**的 server ⇒ 写进去
    //    只验 ② 的话，"服务层把 MCP 一律 404" 也能全绿 —— 而那是另一种坏法。
    const mcp = await prisma.mcpServer.create({
      data: {
        name: `验证 MCP server-${suffix}`,
        slug: `verify-mcp-agents-${suffix}`,
        endpointUrl: 'http://127.0.0.1:1/mcp',
        authType: 'NONE',
        createdBy: owner.id,
      },
      select: { id: true },
    })
    createdMcpIds.push(mcp.id)
    const bound = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
      { componentType: 'MCP', refId: mcp.id },
    ])
    assertEqual(bound.statusCode, 200, '引用真实存在的 MCP server 必须能绑上')
    assertEqual(
      JSON.stringify(agentItemSchema.parse(bound.json().data).components.map((item) => item.componentType).sort()),
      JSON.stringify(['KNOWLEDGE', 'MCP']),
      '响应里两种类型都要在',
    )
  })

  await it('请求体形态：`components` 必填、重复项 **path 精确到下标**、坏枚举/坏 uuid 各 400', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-形态-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kb = await createKb(ownerCookie, { name: `智能体验证库-形态-${suffix}` })

    // ① 缺 `components`：清空必须显式传 `[]` —— "省略 = 清空"会让前端某次忘带字段变成**静默解绑**
    const missing = await api('PUT', `/api/agents/${agent.id}/components`, {
      cookie: ownerCookie,
      payload: {},
    })
    assertEqual(missing.statusCode, 400, '缺 components 应 400')
    assertEqual(missing.json().data.fields[0].path, 'body.components', '字段路径应指到 body.components')
    assertIncludes(missing.json().data.fields[0].message, '空数组', '文案要说清"要清空请传空数组"')

    // ② 非数组 / 坏 uuid / 坏枚举：路径都要能指到出问题的那一层
    for (const [label, components, path] of [
      ['非数组', 'x', 'body.components'],
      ['坏 uuid', [{ componentType: 'KNOWLEDGE', refId: 'not-a-uuid' }], 'body.components.0.refId'],
      ['坏枚举', [{ componentType: 'SANDBOX', refId: kb.id }], 'body.components.0.componentType'],
    ]) {
      const response = await api('PUT', `/api/agents/${agent.id}/components`, {
        cookie: ownerCookie,
        payload: { components },
      })
      assertEqual(response.statusCode, 400, `${label} 应 400`)
      assertEqual(response.json().data.fields[0].path, path, `${label} 的字段路径`)
    }

    // ③ 重复项：`superRefine` 给出**真 path**（P0-1-22 在 `.refine()` 上踩过"path 是空串、只能遍历 message"）
    const dup = await api('PUT', `/api/agents/${agent.id}/components`, {
      cookie: ownerCookie,
      payload: {
        components: [
          { componentType: 'KNOWLEDGE', refId: kb.id },
          { componentType: 'KNOWLEDGE', refId: kb.id },
        ],
      },
    })
    assertEqual(dup.statusCode, 400, '重复项应 400（不能让它变成 DB 唯一索引的 500）')
    assertEqual(
      dup.json().data.fields[0].path,
      'body.components.1.refId',
      '⚠️ path 要精确到第 2 项，前端才能高亮那一行（`.refine()` 只能给空串）',
    )
    assertIncludes(dup.json().data.fields[0].message, '重复', '文案要点破"重复提交"')
  })

  await it('组件替换**不动 `agents.updated_at`**：列表顺序不跳（解绑一个库不该把智能体弹到顶部）', async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const older = await createAgent(ownerCookie, {
      name: `验证智能体-排序-旧-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    await sleep(5)
    const newer = await createAgent(ownerCookie, {
      name: `验证智能体-排序-新-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kb = await createKb(ownerCookie, { name: `智能体验证库-排序-${suffix}` })

    const beforeOrder = await myAgentIdsInList(ownerCookie)
    assert(
      beforeOrder.indexOf(newer.id) < beforeOrder.indexOf(older.id),
      '前置：新建的应排在前面（列表按 `updatedAt desc`）',
    )
    const before = await prisma.agent.findUnique({
      where: { id: older.id },
      select: { updatedAt: true },
    })

    await sleep(5)
    const bound = await putComponents(ownerCookie, older.id, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
    ])
    assertEqual(bound.statusCode, 200, '绑定状态码')

    const after = await prisma.agent.findUnique({
      where: { id: older.id },
      select: { updatedAt: true },
    })
    assertEqual(
      after.updatedAt.toISOString(),
      before.updatedAt.toISOString(),
      '⚠️ `updated_at` 必须**逐字不变**（它同时是列表排序键；"只写 agent_components"是刻意口径）',
    )
    assertEqual(
      agentItemSchema.parse(bound.json().data).updatedAt,
      before.updatedAt.toISOString(),
      '响应里的 updatedAt 也要是旧值',
    )
    const afterOrder = await myAgentIdsInList(ownerCookie)
    assert(
      afterOrder.indexOf(newer.id) < afterOrder.indexOf(older.id),
      '⚠️ 组件替换后顺序不能变（否则用户看到"列表自己跳了一下"）',
    )
  })

  await it('幂等：重复提交同一份绑定（**换顺序**再提交）→ 行的 `id` 逐字不变', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-幂等-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kbA = await createKb(ownerCookie, { name: `智能体验证库-幂等A-${suffix}` })
    const kbB = await createKb(ownerCookie, { name: `智能体验证库-幂等B-${suffix}` })

    const first = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kbA.id },
      { componentType: 'KNOWLEDGE', refId: kbB.id },
    ])
    assertEqual(first.statusCode, 200, '第一次状态码')
    const snapshot = await componentRowsOf(agent.id)
    assertEqual(snapshot.length, 2, '前置：两条绑定')

    // ⚠️ 换个顺序再提交：集合语义与顺序无关，因此这**不是**一次改动
    const second = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kbB.id },
      { componentType: 'KNOWLEDGE', refId: kbA.id },
    ])
    assertEqual(second.statusCode, 200, '第二次状态码')
    assertEqual(
      rowsFingerprint(await componentRowsOf(agent.id)),
      rowsFingerprint(snapshot),
      '⚠️ 集合没变就不该重写：行的 `id` 必须逐字不变（"删了重建"会换新 id，一验就出来）',
    )
  })

  await it('权限：第三方 MEMBER → 403（且不写入）；创建者 → 200；**ADMIN 改他人 → 200**', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-组件权限-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kb = await createKb(ownerCookie, { name: `智能体验证库-组件权限-${suffix}` })

    const denied = await putComponents(otherCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
    ])
    assertEqual(denied.statusCode, 403, '第三方普通用户改他人组件绑定')
    assertEqual(denied.json().code, 'FORBIDDEN', '信封 code')
    assertEqual(
      await prisma.agentComponent.count({ where: { agentId: agent.id } }),
      0,
      '被拒时不该写入任何绑定',
    )

    assertEqual(
      (await putComponents(ownerCookie, agent.id, [{ componentType: 'KNOWLEDGE', refId: kb.id }]))
        .statusCode,
      200,
      '创建者本人可以改',
    )

    const byAdmin = await putComponents(adminCookie, agent.id, [])
    assertEqual(
      byAdmin.statusCode,
      200,
      '⚠️ ADMIN 必须能改别人的组件绑定（"创建者 + ADMIN"里的后半句）',
    )
    assertEqual(agentItemSchema.parse(byAdmin.json().data).components.length, 0, 'ADMIN 的解绑要生效')
  })

  await it('软删的一律 404；未登录 401（**必须给语法合法的 body**，否则先拿 400 验成假的）', async () => {
    assert(softDeletedAgentId !== null, '前置：E 组必须已经软删了一个智能体')
    const kb = await createKb(ownerCookie, { name: `智能体验证库-软删组件-${suffix}` })

    const gone = await putComponents(ownerCookie, softDeletedAgentId, [
      { componentType: 'KNOWLEDGE', refId: kb.id },
    ])
    assertEqual(gone.statusCode, 404, '软删后 PUT 组件应 404（创建者也不行 —— 详情都查不到的东西不该能改）')
    assertEqual(
      (await putComponents(adminCookie, softDeletedAgentId, [])).statusCode,
      404,
      'ADMIN 也一样',
    )

    // ⚠️ Fastify 的 schema 校验跑在 `preHandler` **之前** ⇒ 空 body 会先拿 400，那样"401 挂没挂上"就验成假的
    const anon = await api('PUT', `/api/agents/${MISSING_UUID}/components`, {
      payload: { components: [] },
    })
    assertEqual(anon.statusCode, 401, '未登录')
  })

  await it('整体替换会清掉**不在提交集合里的手工脏行**（"提交什么，库里就有什么"）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `验证智能体-脏行-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const kbKeep = await createKb(ownerCookie, { name: `智能体验证库-留-${suffix}` })
    const kbStale = await createKb(ownerCookie, { name: `智能体验证库-旧-${suffix}` })

    // 手工造两条"历史遗留"：一条指向另一个库、一条**悬空的** MCP（P0-2-2 起 PUT 只会
    // 写入真实存在的 server ⇒ 这条"引用已失效"的行仍然只能手工造，也仍然必须被清掉）
    await prisma.agentComponent.createMany({
      data: [
        { agentId: agent.id, componentType: ComponentType.KNOWLEDGE, refId: kbStale.id },
        { agentId: agent.id, componentType: ComponentType.MCP, refId: other.id },
      ],
    })

    const bound = await putComponents(ownerCookie, agent.id, [
      { componentType: 'KNOWLEDGE', refId: kbKeep.id },
    ])
    assertEqual(bound.statusCode, 200, '状态码')
    const rows = await componentRowsOf(agent.id)
    assertEqual(rows.length, 1, '只该剩提交的那一条')
    assertEqual(rows[0].refId, kbKeep.id, '剩下的应是提交的那条')
    assertEqual(
      await prisma.agentComponent.count({
        where: { agentId: agent.id, componentType: ComponentType.MCP },
      }),
      0,
      '⚠️ 脏的 MCP 行也要被清掉（那条引用永远修不好，留着就是孤儿绑定）',
    )
  })
} finally {
  // ───────────────────────────── 清理 + 复核残留 ─────────────────────────────
  console.log(`\n${c.b}── 清理（自清理 + 复核残留）──${c.x}`)
  try {
    // 顺序有讲究：外键全是 RESTRICT，必须自下而上删
    // ⚠️ 一律 `deleteMany`（不要 `delete` + `.catch()`：Prisma 会把 P2025 的整条堆栈打到 stdout，
    //    而脚本的 stdout 就是断言结果本身 —— `.catch()` 吞得掉异常、吞不掉已经打出的日志）
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } })
    await prisma.conversation.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    // 兜底：万一有用例改了名字而没进 createdAgentIds
    const leftoverAgents = await prisma.agent.findMany({
      where: { name: { contains: suffix } },
      select: { id: true },
    })
    const agentIds = [...new Set([...createdAgentIds, ...leftoverAgents.map((row) => row.id)])]
    await prisma.conversation.deleteMany({ where: { agentId: { in: agentIds } } })
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } })

    await prisma.knowledgeBase.deleteMany({
      where: { OR: [{ id: { in: createdKbIds } }, { name: { contains: suffix } }] },
    })
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    await prisma.model.deleteMany({ where: { modelName: { contains: suffix } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    await prisma.modelProvider.deleteMany({ where: { name: { contains: suffix } } })
    // MCP server 在 users 之**前**删：`created_by` 是 RESTRICT 外键
    await prisma.mcpServer.deleteMany({
      where: { OR: [{ id: { in: createdMcpIds } }, { slug: { contains: suffix } }] },
    })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s），
      //    不删就要等窗口过去才算干净（`06` P0-1-7 坑 5 的教训）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  // 复核残留（"删干净了"本身要是一条可复核的结论，而不是"我没报错"）
  const residue = {
    agents: await prisma.agent.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    conversations: await prisma.conversation.count({ where: { topic: { contains: suffix } } }).catch(() => -1),
    knowledgeBases: await prisma.knowledgeBase.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    models: await prisma.model.count({ where: { modelName: { contains: suffix } } }).catch(() => -1),
    providers: await prisma.modelProvider.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    users: await prisma.user.count({ where: { username: { contains: suffix } } }).catch(() => -1),
    agentComponents: await prisma.agentComponent.count({ where: { agentId: { in: createdAgentIds } } }).catch(() => -1),
    mcpServers: await prisma.mcpServer.count({ where: { slug: { contains: suffix } } }).catch(() => -1),
  }
  const dirty = Object.entries(residue).filter(([, count]) => count !== 0)
  const sessionsLeft = []
  for (const sid of sessionIds) {
    if ((await redis.exists(sessionKey(sid)).catch(() => 0)) !== 0) sessionsLeft.push(sid)
  }
  if (dirty.length === 0 && sessionsLeft.length === 0) {
    console.log(`  ${c.g}[PASS]${c.x} 残留复核：8 张表全部为 0，${sessionIds.length} 个会话键全部清空`)
    passed += 1
  } else {
    console.log(`  ${c.r}[FAIL]${c.x} 残留复核：表 ${JSON.stringify(residue)}｜会话键 ${sessionsLeft.length} 个`)
    failed += 1
  }

  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-22/23 智能体验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-22/23 智能体验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
