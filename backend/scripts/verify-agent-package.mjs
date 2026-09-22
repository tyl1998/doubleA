#!/usr/bin/env node
/**
 * verify-agent-package.mjs —— **P0-1-24 Agent 包验收**（包 E 收口）
 *
 * 逐行跑 `docs/06` P0-1-24 的四条**验收门槛**（= `docs/05` 包 E 的出口判据
 * "两种类型 Agent 可 CRUD，可绑知识库，权限校验生效"），每行一个组：
 *   R1 门槛① 两种类型 CRUD     CHATBOT + TASK_AGENT 各一条：建 → 列表可见 → 详情 → 改 → 列表消失、详情 404
 *   R2 门槛② 绑 2 库 → 解绑 1  绑 2 个知识库 → 详情完整回显 → 解绑 1 个 → 详情立即反映
 *                              + **MCP 对偶**：明确拒绝且文案指向 P0-2（`docs/06` 的口径变更）
 *   R3 门槛③ 权限             他人（MEMBER）改被拒 403；本人改成功；ADMIN 改同一个也成功
 *   R4 门槛④ 删除的连带      删 Agent 后**会话仍在且转只读**、组件绑定已解、**被绑的库此刻删得掉**
 *   R5 清场                   自清理 + 残留复核（8 张表 + 会话键）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么还要一个"包级"脚本（前面两批各有自己的验收）
 * ─────────────────────────────────────────────────────────────────────
 * `verify-agents` 验的是**每个端点各自对不对**（参数校验、软删三件套、整体替换的顺序与幂等…），
 * 而"这个包能不能交付"问的是**串起来之后**还成不成立：
 *   · R2 的"解绑 1 个立即生效"要**详情端点、列表端点、写端点三者同一套投影**才是有意义的结论
 *     （各验各的时，一个"PUT 回 A 形状、GET 回 B 形状"的实现可以两处都绿）；
 *   · R4 的"删了 Agent 之后被绑的库删得掉"跨越 **D 包（`kb.service` 的删库守卫数
 *     `agent_components`）与 E 包（软删时解绑）**—— 这是本包里唯一一条"两个包各做一半、
 *     合起来才成立"的链，也是只做一半时症状最隐蔽的那条（库里那个 Agent 已经"没了"，
 *     界面上却提示"正被 1 个 Agent 绑定"，用户无路可走）；
 *   · R1 的"两种类型都能 CRUD"听起来最平淡，但它同时要求**建/改/删三条路径共用同一套
 *     投影与同一套权限判据** —— 只验一种类型时，一个"只放行 CHATBOT"的实现照样全绿。
 * 所以本脚本**不重复** `verify-agents` 的细粒度断言，只跑这四行要的**端到端**证据。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 两处"部分完成"（结论表里单列，别混进 ✅）
 * ─────────────────────────────────────────────────────────────────────
 * ① **门槛② 的 MCP 那一半**：`docs/06` 原文写的是"绑 2 个知识库 + **1 个 MCP server**"，
 *    但 `mcp_servers` 表要到 **P0-2** 才建（P0-1-23 已定案并回写三处文档）。本包验的是
 *    **对偶形态**："含 MCP 的提交被明确拒绝，且文案指向 P0-2" —— 这才是现在能成立的事实。
 * ② **门槛④ 的"只读"**：P0-1-24 收口时**没有**任何 HTTP 出口能观察"这个会话读得到"，
 *    故当时只在 **DB 层**取证（`conversations` 行还在、`status=FINISHED`、消息还在、
 *    `finishedConversations` 数得对）并标了 ⚠️。**P0-1-25 落地后本组已换成打端点**：
 *    会话经 `POST /api/conversations` 建，删掉 Agent 之后再用 `GET /api/agents/:id/conversations`
 *    读回来（这正是"只读保留"的端点级证据）。
 *    ⚠️ 但"**写不进去**"这一半仍要等 **P0-1-26** —— 唯一会让会话产生消息的端点是
 *    `POST /:id/chat`（SSE 闸门），本批刻意不注册（`verify-app.mjs` 有断言守着它 404）。
 *    故结论表里这一条仍**单列一行**说明，不混进 ✅。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 依赖与前置
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 跑之前先起依赖并迁移：`pnpm infra:up && pnpm db:deploy`（PG + Redis 都要）。
 * **不需要 S3**：本脚本不上传文档（删库时空文件列表直接返回；S3 侧失败也**只告警**，
 * 见 `kb.service.ts` 文件头 ⑤）。为什么要注入 `EMBEDDING_*`：R2/R4 要建**真知识库**，
 * 而建库要取 `EmbeddingProvider.name()` 快照（**纯配置计算**，不发网络请求，P0-1-15）。
 * 注入一个永不会被访问的 URL 即可（`127.0.0.1:1`）。
 *
 * 脚本自造带随机后缀的 3 个用户 + 1 个 Provider + 1 个模型 + 若干智能体/会话/消息/知识库，
 * 结束时删净并**复核残留**。
 */

// ⚠️ 必须在 import `config.js`（经 dist 的 app.js 间接引入）**之前**设置：
//    ① 收敛脚本自身日志（本脚本会打一堆"应当失败"的请求，不收敛会把断言输出冲掉；
//       要看细节时：`LOG_LEVEL=debug node scripts/verify-agent-package.mjs`）
//       —— 收到 `fatal` 而不是 `error`：被**故意**制造失败的那几组用例，服务端正是按
//       `error` 级打日志的，收到 `error` 等于没收敛（P0-1-17 实测）
//    ② 注入可用的 embedding 配置：建库要取快照（本机 `.env` 三项是空的）
process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = 'http://127.0.0.1:1/v1'
process.env.EMBEDDING_API_KEY = 'verify-agent-package-key'
process.env.EMBEDDING_API_MODEL = 'verify-embed-model'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const {
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
  agentItemSchema,
  agentListResultSchema,
  conversationActiveSchema,
  conversationItemSchema,
  conversationListResultSchema,
  removeAgentResultSchema,
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

/**
 * 集合类比较**两侧先排序再比**（`06` P0-1-17 的教训）：
 * 把集合语义的东西直接 `JSON.stringify` 和手写数组比，等于把"书写顺序"也当成契约 ——
 * 输出里期望与实际"逐字看着一样、只是顺序不同"，属于纯假失败。
 */
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort()
  const b = [...expected].sort()
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${label}：期望集合 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`,
  )
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
    if (currentGroup !== null) currentGroup.passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    if (currentGroup !== null) currentGroup.failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

/**
 * 组（= 门槛清单里的一行）。
 *
 * 人读的交付物是**这份清单**而不是一堆散断言（P0-1-21 定案），所以每组开头回显门槛原文，
 * 结尾给一行结论 —— 全绿时一行搞定，有红时不必往上翻。
 */
let currentGroup = null
const groups = []

function groupStart(id, title, note) {
  currentGroup = { id, title, note, passed: 0, failed: 0 }
  groups.push(currentGroup)
  console.log(`\n${c.b}── ${id} ${title} ──${c.x}`)
  if (note !== undefined) console.log(`   ${c.d}${note}${c.x}`)
}

// ───────────────────────────── 常量与临时数据标识 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-AgentPackage-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-agentpkg-admin-${suffix}`
/** 创建者（**非 ADMIN**）：建/改/删的主体，守"没被误加 requireAdmin" */
const ownerUsername = `verify-agentpkg-owner-${suffix}`
/** 第三方普通用户（非创建者、非 ADMIN）：守"他人 Agent 改不动" */
const otherUsername = `verify-agentpkg-other-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdKbIds = []
const createdConversationIds = []
/** 被软删的那些（软删是**保留行**的，故与 `createdAgentIds` 分开记，清理时要一起删） */
const softDeletedAgentIds = []

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

/** 建智能体并要求成功（响应过 `agentItemSchema`，不顺带断言别的） */
async function createAgent(cookie, payload) {
  const response = await api('POST', '/api/agents', { cookie, payload })
  assertEqual(response.statusCode, 200, `建智能体状态码（${JSON.stringify(payload)}）`)
  const body = response.json().data
  const parsed = agentItemSchema.safeParse(body)
  assert(parsed.success, `建智能体响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  createdAgentIds.push(parsed.data.id)
  return { body, item: parsed.data }
}

/** 建知识库并要求成功 */
async function createKb(cookie, payload) {
  const response = await api('POST', '/api/knowledge-bases', { cookie, payload })
  assertEqual(response.statusCode, 200, `建知识库状态码（${JSON.stringify(payload)}）`)
  createdKbIds.push(response.json().data.id)
  return response.json().data
}

/** 详情端点（**投影一致性的观察口**：门槛②要的"详情完整回显"必须从这里看） */
async function getAgent(cookie, agentId) {
  const response = await api('GET', `/api/agents/${agentId}`, { cookie })
  assertEqual(response.statusCode, 200, '详情状态码')
  const parsed = agentItemSchema.safeParse(response.json().data)
  assert(parsed.success, `详情响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  return { body: response.json().data, item: parsed.data }
}

/** 列表里本脚本造的那些 id（按返回顺序） */
async function myAgentIdsInList(cookie) {
  const response = await api('GET', '/api/agents?limit=100', { cookie })
  assertEqual(response.statusCode, 200, '列表状态码')
  const parsed = agentListResultSchema.safeParse(response.json().data)
  assert(parsed.success, `列表不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  const mine = new Set(createdAgentIds)
  return parsed.data.items.filter((item) => mine.has(item.id)).map((item) => item.id)
}

/** `PUT /api/agents/:id/components`（整体替换） */
function putComponents(cookie, agentId, components) {
  return api('PUT', `/api/agents/${agentId}/components`, { cookie, payload: { components } })
}

/** 组件绑定集合的**集合形态**（排序后），用于"提交了什么 ↔ 库里/回显有什么"的比较 */
function componentSet(components) {
  return components.map((item) => `${item.componentType}:${item.refId}`).sort()
}

/** 对象的键集合（排序后）——"三条路径共用一套投影"的最小可核对形态 */
function keySetOf(value) {
  return JSON.stringify(Object.keys(value).sort())
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(
  `\n${c.b}══ P0-1-24 Agent 包验收（包 E 收口）：` +
    `两类型 CRUD / 绑库与解绑 / 权限 / 删除的连带 ══${c.x}`,
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
    nickname: 'Agent包验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const owner = await createUser(ownerUsername, {
    nickname: 'Agent包验证创建者',
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

  // 一个启用中的 CHAT 模型（`agents.model_id` 是 NOT NULL + RESTRICT，建 Agent 必须有它）
  const provider = await prisma.modelProvider.create({
    data: { name: `Agent包验证 Provider ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
  })
  createdProviderIds.push(provider.id)
  const chatModel = await prisma.model.create({
    data: {
      providerId: provider.id,
      modelName: `verify-agentpkg-chat-${suffix}`,
      label: 'Agent包验证对话模型',
      type: 'CHAT',
    },
  })
  createdModelIds.push(chatModel.id)

  const mkName = (label) => `Agent包${label}-${suffix}`

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R1',
    '门槛① 两种类型均可创建/编辑/删除',
    'CHATBOT 与 TASK_AGENT 各走一条完整链；顺带钉"建/改/删三条路径共用同一套投影"',
  )
  // ═══════════════════════════════════════════════════════════════════

  /** 一条链路跑完的两种类型（R3/R4 还要复用它们，故放到外层作用域） */
  const created = {}

  await it('两种类型都能建出来，且 `type` 按提交值落库、`canEdit=true`（创建者本人）', async () => {
    const cb = await createAgent(ownerCookie, {
      name: mkName('对话型'),
      type: 'CHATBOT',
      modelId: chatModel.id,
      description: 'Agent 包验收用的对话型智能体',
    })
    const ta = await createAgent(ownerCookie, {
      name: mkName('任务型'),
      type: 'TASK_AGENT',
      modelId: chatModel.id,
    })
    created.chatbot = cb.item
    created.taskAgent = ta.item

    assertEqual(cb.item.type, 'CHATBOT', 'CHATBOT 的 type')
    assertEqual(ta.item.type, 'TASK_AGENT', 'TASK_AGENT 的 type')
    assertEqual(cb.item.createdBy, owner.id, 'createdBy 取会话里的用户')
    assertEqual(cb.item.canEdit, true, '创建者本人可编辑')
    assertEqual(cb.item.components.length, 0, '新建的没有任何绑定')
  })

  await it('建、详情、列表三条路径**投影键集合逐字一致**（同一份数据不许有第二种形状）', async () => {
    const detail = await getAgent(ownerCookie, created.taskAgent.id)
    const listResponse = await api('GET', '/api/agents?limit=100', { cookie: ownerCookie })
    const listItem = listResponse.json().data.items.find((item) => item.id === created.taskAgent.id)
    assert(listItem !== undefined, '列表里应当能找到刚建的那个')

    assertEqual(
      keySetOf(detail.body),
      keySetOf(created.taskAgent),
      '详情 vs 建 的键集合（P0-1-21 的教训：同一份数据多个出口形状不一致，是前端最容易踩的坑）',
    )
    assertEqual(keySetOf(listItem), keySetOf(created.taskAgent), '列表 vs 建 的键集合')
    assertEqual(detail.item.name, created.taskAgent.name, '详情回显的名称')
  })

  await it('两种类型都能改：文本字段三态 + 引导问题（`[]` 清空）', async () => {
    const response = await api('PATCH', `/api/agents/${created.chatbot.id}`, {
      cookie: ownerCookie,
      payload: {
        name: mkName('对话型-改名'),
        description: null, // `null` = 清空（`03` §4.2 的整表单提交）
        guideQuestions: ['这份制度怎么规定的？', '报销标准是多少？'],
      },
    })
    assertEqual(response.statusCode, 200, '改状态码')
    const item = agentItemSchema.parse(response.json().data)
    assertEqual(item.name, mkName('对话型-改名'), '改名生效')
    assertEqual(item.description, null, '`null` 应是清空而不是"不动"')
    assertEqual(item.guideQuestions.length, 2, '引导问题写入')
    created.chatbot = item
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R2',
    '门槛② 绑定 2 个知识库 → 详情完整回显 → 解绑 1 个 → 详情立即反映',
    'MCP 那一半按 docs/06 的口径变更为对偶形态（明确拒绝 + 文案指向 P0-2），见文件头 ⚠️①',
  )
  // ═══════════════════════════════════════════════════════════════════

  const kbA = await createKb(ownerCookie, { name: mkName('知识库A') })
  const kbB = await createKb(ownerCookie, { name: mkName('知识库B') })

  await it('绑 2 个知识库：写端点响应 = 详情端点 = 列表端点，且都恰好是提交的那两条', async () => {
    const expected = [
      { componentType: 'KNOWLEDGE', refId: kbA.id },
      { componentType: 'KNOWLEDGE', refId: kbB.id },
    ]
    const write = await putComponents(ownerCookie, created.chatbot.id, expected)
    assertEqual(write.statusCode, 200, '绑定的状态码')

    const writeItem = agentItemSchema.parse(write.json().data)
    const detail = await getAgent(ownerCookie, created.chatbot.id)
    const listItem = (
      await api('GET', '/api/agents?limit=100', { cookie: ownerCookie })
    ).json().data.items.find((item) => item.id === created.chatbot.id)

    assertSameSet(componentSet(writeItem.components), componentSet(expected), '写端点响应里的绑定')
    assertSameSet(componentSet(detail.item.components), componentSet(expected), '详情端点回显的绑定')
    assertSameSet(componentSet(listItem.components), componentSet(expected), '列表端点回显的绑定')
    // 三个出口的绑定**列表本身**也应当逐字相同（同序：`componentType asc, refId asc`）
    assertEqual(
      JSON.stringify(writeItem.components),
      JSON.stringify(detail.item.components),
      '写端点与详情端点的绑定数组（逐字，含顺序）',
    )
    assertEqual(
      JSON.stringify(detail.item.components),
      JSON.stringify(listItem.components),
      '详情与列表的绑定数组（逐字，含顺序）',
    )
  })

  await it('解绑 1 个：详情**立即**只反映剩下的那 1 个（不是缓存、不是延迟生效）', async () => {
    const response = await putComponents(ownerCookie, created.chatbot.id, [
      { componentType: 'KNOWLEDGE', refId: kbB.id },
    ])
    assertEqual(response.statusCode, 200, '解绑的状态码')
    const writeItem = agentItemSchema.parse(response.json().data)
    assertEqual(writeItem.components.length, 1, '写端点响应里只剩 1 条')

    const detail = await getAgent(ownerCookie, created.chatbot.id)
    assertEqual(detail.item.components.length, 1, '详情里只剩 1 条')
    assertEqual(detail.item.components[0].refId, kbB.id, '剩下的应当是**没被解绑**的那个（B）')
    assert(
      detail.item.components.every((component) => component.refId !== kbA.id),
      '⚠️ 解绑 A 之后详情里不能再出现 A（"点了解绑没生效"是这个端点最可能的坏法）',
    )
  })

  await it('MCP 对偶：含 MCP 的提交被**明确拒绝**，且文案指向 P0-2（口径变更的守门断言）', async () => {
    const response = await putComponents(ownerCookie, created.chatbot.id, [
      { componentType: 'KNOWLEDGE', refId: kbB.id },
      { componentType: 'MCP', refId: other.id }, // 语法合法（uuid），但 mcp_servers 表 P0-2 才建
    ])
    assertEqual(response.statusCode, 400, '含 MCP 应被拒')
    const body = response.json()
    assertIncludes(body.msg, 'MCP', '顶层 msg 点出是 MCP 的问题')
    assertIncludes(body.msg, 'P0-2', '⚠️ 文案必须**指向版本号**（否则"拒绝"被改成 500 或文案变模糊都没人发现）')

    // 被拒之后原有的那条绑定必须**原样还在**（校验在写之前 —— P0-1-23 的顺序不变式）
    const rows = await prisma.agentComponent.findMany({
      where: { agentId: created.chatbot.id },
      select: { refId: true },
    })
    assertEqual(rows.length, 1, '被拒的提交不得影响库里已有的绑定')
    assertEqual(rows[0].refId, kbB.id, '剩下的仍应是 B')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R3',
    '门槛③ 普通用户改他人 Agent 被拒（403）；本人 Agent 可改',
    '⚠️ 三个方向都写全：仅验"他人 403"的话，一个"仅创建者"的实现（ADMIN 也改不了）会全绿',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('他人（MEMBER）改 → 403，且**一个字节都没写**（改名字的前后逐字比对）', async () => {
    const before = (
      await prisma.agent.findUnique({ where: { id: created.taskAgent.id }, select: { name: true, updatedAt: true } })
    )

    const response = await api('PATCH', `/api/agents/${created.taskAgent.id}`, {
      cookie: otherCookie,
      payload: { name: mkName('他人改的') },
    })
    assertEqual(response.statusCode, 403, '他人改应被拒')

    const after = (
      await prisma.agent.findUnique({ where: { id: created.taskAgent.id }, select: { name: true, updatedAt: true } })
    )
    assertEqual(after.name, before.name, '名字不得被改（403 之后不能有部分写入）')
    assertEqual(
      after.updatedAt.toISOString(),
      before.updatedAt.toISOString(),
      '⚠️ `updated_at` 逐字不变（"写了但值相同"会被内容断言漏掉 —— P0-1-10 的同款手法）',
    )

    // 绑组件这一路也要收窄（同一个 `canEditAgent` 判据的另一处落点）
    const putResponse = await putComponents(otherCookie, created.taskAgent.id, [
      { componentType: 'KNOWLEDGE', refId: kbA.id },
    ])
    assertEqual(putResponse.statusCode, 403, '他人改组件绑定应被拒')
    assertEqual(
      await prisma.agentComponent.count({ where: { agentId: created.taskAgent.id } }),
      0,
      '被拒之后不得留下绑定',
    )
  })

  await it('本人改自己的 → 200（创建者是 MEMBER，这条同时守着"没被顺手加 requireAdmin"）', async () => {
    const response = await api('PATCH', `/api/agents/${created.taskAgent.id}`, {
      cookie: ownerCookie,
      payload: { description: '任务型智能体（本人改）' },
    })
    assertEqual(response.statusCode, 200, '本人改应成功')
    assertEqual(agentItemSchema.parse(response.json().data).description, '任务型智能体（本人改）', '改动生效')
  })

  await it('ADMIN 改**别人**的 → 200（"创建者 + ADMIN 可编删"里的后半句）', async () => {
    const response = await api('PATCH', `/api/agents/${created.taskAgent.id}`, {
      cookie: adminCookie,
      payload: { openingRemarks: '你好，我是任务型智能体' },
    })
    assertEqual(response.statusCode, 200, 'ADMIN 改应成功')
    assertEqual(
      agentItemSchema.parse(response.json().data).openingRemarks,
      '你好，我是任务型智能体',
      'ADMIN 的改动生效',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'R4',
    '门槛④ 删除 Agent 后其会话仍在（只读），组件绑定已解除',
    '会话走 `POST /api/conversations` 建、删 Agent 后用会话列表端点读回来（P0-1-25 回补）；' +
      '"写不进去"仍归 P0-1-26 的 chat 闸门（见文件头 ⚠️②）',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('删除时**三件事一起发生**：deleted_at 打标 / 绑定解干净 / 会话转只读且消息还在', async () => {
    const target = await createAgent(ownerCookie, {
      name: mkName('待删除'),
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    // 绑一个**专用的**知识库：下一步要拿它验"解绑之后这个库才删得掉"
    const kbBound = await createKb(ownerCookie, { name: mkName('被绑定库') })
    const bind = await putComponents(ownerCookie, target.item.id, [
      { componentType: 'KNOWLEDGE', refId: kbBound.id },
    ])
    assertEqual(bind.statusCode, 200, '先绑上')

    // 会话：**走真端点建**（P0-1-25 起会话管理已落地）—— 这样"只读保留"的取证就落在接口上，
    // 而不是"脚本直接造行"。消息仍然只能直接造：写消息的端点属 P0-1-27（SSE 落地时才有）。
    // 造的是与 `02` §三 完全一样的形状（role/content）
    const createConversation = await api('POST', '/api/conversations', {
      cookie: ownerCookie,
      payload: { agentId: target.item.id },
    })
    assertEqual(createConversation.statusCode, 200, '建会话状态码')
    const conversation = conversationItemSchema.parse(createConversation.json().data)
    createdConversationIds.push(conversation.id)
    assertEqual(conversation.lastMessageAt, null, '新建会话还没有消息')
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: { text: '这条消息应当活过智能体被删除' },
      },
    })

    const response = await api('DELETE', `/api/agents/${target.item.id}`, { cookie: ownerCookie })
    assertEqual(response.statusCode, 200, '删除状态码')
    softDeletedAgentIds.push(target.item.id)
    const result = removeAgentResultSchema.parse(response.json().data)
    assertEqual(result.removedComponents, 1, '连带解除的绑定数')
    assertEqual(result.finishedConversations, 1, '连带转只读的会话数（只数**真的被改的**行）')

    // ① 软删：行还在（带 deleted_at），但详情 404
    const row = await prisma.agent.findUnique({
      where: { id: target.item.id },
      select: { deletedAt: true },
    })
    assert(row !== null, '软删不是物理删，行必须还在')
    assert(row.deletedAt !== null, '`deleted_at` 必须被打上')
    assertEqual(
      (await api('GET', `/api/agents/${target.item.id}`, { cookie: ownerCookie })).statusCode,
      404,
      '软删后详情 404（留一个"看起来还能改"的页面等于诱导用户改一条作废记录）',
    )

    // ② 绑定解干净
    assertEqual(
      await prisma.agentComponent.count({ where: { agentId: target.item.id } }),
      0,
      'agent_components 必须清空',
    )

    // ③ 会话仍在、已转只读、消息还在（`02` §4.4 的"只读保留"）—— **端点级取证**（P0-1-25 回补）：
    //    "它读得到"现在有 HTTP 出口了（会话列表端点），不必再只看库
    const listed = await api('GET', `/api/agents/${target.item.id}/conversations`, { cookie: ownerCookie })
    assertEqual(listed.statusCode, 200, '⚠️ 软删的 Agent 也要能列出历史会话（列表刻意不按 deletedAt 过滤）')
    const page = conversationListResultSchema.parse(listed.json().data)
    assertEqual(page.total, 1, '会话必须**保留**（业务留痕，不允许随 Agent 消失）')
    assertEqual(page.items[0].id, conversation.id, '就是那一条')
    assertEqual(page.items[0].status, 'FINISHED', '会话必须转成 FINISHED（只读）')
    assertEqual(page.items[0].agentName, target.item.name, 'Agent 名走 join 出来的**快照**（详情端点这时候已是 404）')
    //    活跃流状态端点也要能读（会话还在 ⇒ 不是 404；没在流 ⇒ streaming:false）
    const active = await api('GET', `/api/conversations/${conversation.id}/active`, { cookie: ownerCookie })
    assertEqual(active.statusCode, 200, '活跃流状态端点')
    assertEqual(conversationActiveSchema.parse(active.json().data).streaming, false, '没有流')
    assertEqual(
      await prisma.message.count({ where: { conversationId: conversation.id } }),
      1,
      '消息也还在（删会话才会级联删消息，删 Agent 不该）',
    )
    assertEqual(
      await prisma.message.count({ where: { id: message.id } }),
      1,
      '刚造的那条消息必须还在',
    )
    //    （DB 层再复核一次"行的状态"：端点的投影可能是"写死的 FINISHED"，库里才是真相）
    const conversationRow = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      select: { status: true, agentId: true },
    })
    assertEqual(conversationRow?.status, ConversationStatus.FINISHED, '库里也是 FINISHED')

    // ④ 重复删除 → 404（不是 200，也不是 500）：并发双击的语义要干净
    assertEqual(
      (await api('DELETE', `/api/agents/${target.item.id}`, { cookie: ownerCookie })).statusCode,
      404,
      '再删一次',
    )

    created.deletedKbId = kbBound.id
  })

  await it('跨包链路：解绑之后**那个知识库才删得掉**（D 包的删库守卫数的是绑定行）', async () => {
    // 这条链横跨 D 与 E：`kb.service` 的删库守卫看 `agent_components`，
    // 而"软删要顺手解绑"是 E 包的职责。只做一半时症状极隐蔽 ——
    // 界面上那个 Agent 已经"没了"，删库却提示"正被 1 个 Agent 绑定"，用户无路可走。
    const kbId = created.deletedKbId
    // 反例先来：再建一个 Agent 绑上它 ⇒ 此刻必须 409
    const holder = await createAgent(ownerCookie, {
      name: mkName('占位用的'),
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    await putComponents(ownerCookie, holder.item.id, [{ componentType: 'KNOWLEDGE', refId: kbId }])
    const blocked = await api('DELETE', `/api/knowledge-bases/${kbId}`, { cookie: ownerCookie })
    assertEqual(blocked.statusCode, 409, '被绑定时删库应 409（这是守卫仍生效的**反例**，不是失败）')

    // 正例：软删那个占位 Agent ⇒ 同一句删库请求变成 200
    assertEqual(
      (await api('DELETE', `/api/agents/${holder.item.id}`, { cookie: ownerCookie })).statusCode,
      200,
      '软删占位 Agent',
    )
    softDeletedAgentIds.push(holder.item.id)
    const allowed = await api('DELETE', `/api/knowledge-bases/${kbId}`, { cookie: ownerCookie })
    assertEqual(allowed.statusCode, 200, '⚠️ 解绑之后删库必须成功（只做"打标记"的实现会一直 409）')
    assertEqual(await prisma.knowledgeBase.count({ where: { id: kbId } }), 0, '库里确实没了')
  })

  await it('列表里不再出现被软删的两个 Agent（`deletedAt: null` 是所有查询的默认过滤）', async () => {
    // ⚠️ 这条必须**同时**用"软删的不在"与"没删的还在"两个方向说，否则一个"列表恒为空"
    //    的实现（或"过滤条件写反成 deletedAt 非空"）都能被单侧断言糊过去
    const ids = await myAgentIdsInList(ownerCookie)
    for (const deletedId of softDeletedAgentIds) {
      assert(!ids.includes(deletedId), `被软删的 ${deletedId} 不该还在列表里（点进去会是死链：详情 404）`)
    }
    assert(ids.includes(created.chatbot.id), '没被删的那个必须还在列表里')
    assert(ids.includes(created.taskAgent.id), '没被删的任务型也必须还在列表里')
  })

} finally {
  // ───────────────────────────── R5 清场 + 复核残留 ─────────────────────────────
  // ⚠️ 这一组**必须放在 `finally` 里**：前面的用例一旦抛错（哪怕断言全在 `it()` 里被吞掉），
  //    残留复核仍然要给出结论 —— "跑完干净"本身是这个包的交付条件之一，
  //    不能因为"某条用例失败了"就跳过（P0-1-7 起定的规矩：自清理 + 复核残留）。
  console.log(`\n${c.b}── 清理（自清理 + 复核残留）──${c.x}`)
  try {
    // 顺序有讲究：外键全是 RESTRICT，必须自下而上删
    // ⚠️ 一律 `deleteMany`（不要 `delete` + `.catch()`：Prisma 会把 P2025 的整条堆栈打到 stdout，
    //    而脚本的 stdout 就是断言结果本身 —— `.catch()` 吞得掉异常、吞不掉已经打出的日志）
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    await prisma.message.deleteMany({ where: { conversationId: { in: createdConversationIds } } })
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } })

    // 兜底：万一有用例改了名字而没进 createdAgentIds/softDeletedAgentIds
    // （"占位用的"那个就只在 softDeletedAgentIds 里；软删是**保留行**的，也要真删掉）
    const leftoverAgents = await prisma.agent.findMany({
      where: { name: { contains: suffix } },
      select: { id: true },
    })
    const agentIds = [
      ...new Set([...createdAgentIds, ...softDeletedAgentIds, ...leftoverAgents.map((row) => row.id)]),
    ]
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: agentIds } } })
    // ⚠️ 先把会话 id 查出来再删：不依赖"`deleteMany` 的 where 支持关系过滤"这个较新的能力
    const orphanConversations = await prisma.conversation.findMany({
      where: { OR: [{ agentId: { in: agentIds } }, { topic: { contains: suffix } }] },
      select: { id: true },
    })
    const orphanIds = orphanConversations.map((row) => row.id)
    if (orphanIds.length > 0) {
      await prisma.message.deleteMany({ where: { conversationId: { in: orphanIds } } })
      await prisma.conversation.deleteMany({ where: { id: { in: orphanIds } } })
    }
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } })

    await prisma.knowledgeBase.deleteMany({
      where: { OR: [{ id: { in: createdKbIds } }, { name: { contains: suffix } }] },
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
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  // 复核残留（"删干净了"本身要是一条可复核的结论，而不是"我没报错"）
  const conversationIds = (
    await prisma.conversation.findMany({
      where: { topic: { contains: suffix } },
      select: { id: true },
    })
  ).map((row) => row.id)
  const residue = {
    agents: await prisma.agent.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    agentComponents: await prisma.agentComponent
      .count({ where: { agentId: { in: [...createdAgentIds, ...softDeletedAgentIds] } } })
      .catch(() => -1),
    conversations: await prisma.conversation.count({ where: { topic: { contains: suffix } } }).catch(() => -1),
    messages: await prisma.message
      .count({ where: { conversationId: { in: conversationIds } } })
      .catch(() => -1),
    knowledgeBases: await prisma.knowledgeBase.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    models: await prisma.model.count({ where: { modelName: { contains: suffix } } }).catch(() => -1),
    providers: await prisma.modelProvider.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    users: await prisma.user.count({ where: { username: { contains: suffix } } }).catch(() => -1),
  }
  const dirty = Object.entries(residue).filter(([, count]) => count !== 0)
  const sessionsLeft = []
  for (const sid of sessionIds) {
    if ((await redis.exists(sessionKey(sid)).catch(() => 0)) !== 0) sessionsLeft.push(sid)
  }

  // ⚠️ 分组计数**手工补**：这一组的断言写在 `finally` 里（不走 `it()` 的包裹），
  //    而结论表是按组统计的 —— 忘了这一步的话，"清场"那一行会永远显示 "(0 项全通过)"
  groupStart('R5', '清场：自清理 + 残留复核', '八张表 + 会话键，全部要能复核为 0（不靠"我没报错"）')
  if (dirty.length === 0 && sessionsLeft.length === 0) {
    const detail = Object.entries(residue)
      .map(([table, count]) => `${table}=${count}`)
      .join(' ')
    console.log(`  ${c.g}[PASS]${c.x} 残留复核：8 张表全部为 0（${detail}），${sessionIds.length} 个会话键全部清空`)
    passed += 1
    currentGroup.passed += 1
  } else {
    console.log(`  ${c.r}[FAIL]${c.x} 残留复核：表 ${JSON.stringify(residue)}｜会话键 ${sessionsLeft.length} 个`)
    failed += 1
    currentGroup.failed += 1
  }

  await app.close()
  await closePrisma()
  await closeRedis()
}

// ───────────────────────────── 结论表（人读的交付物）─────────────────────────────

console.log(`\n${c.b}── E 包结论表（docs/06 P0-1-24 的四条验收门槛）──${c.x}`)
for (const g of groups) {
  const mark = g.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(`  ${mark} ${g.id} ${g.title}  ${c.d}(${g.passed} 项${g.failed > 0 ? ` / ${g.failed} 项失败` : '全通过'})${c.x}`)
}
console.log(
  `  ${c.y}⚠️${c.x} 门槛② 的 **MCP** 那一半：P0-1 阶段明确拒绝（400 + 指向 P0-2），` +
    `由 P0-2 接回 —— 本包验的是**对偶形态**`,
)
console.log(
  `  ${c.y}⚠️${c.x} 门槛④ 的"只读"：**读得到**已换成端点取证（会话列表仍返回、status=FINISHED，` +
    `**P0-1-25 回补**）；"**写不进去**"要等 P0-1-26 的 chat 闸门（该端点刻意未注册）`,
)
console.log(
  `  ${c.d}边界：本包收口时**浏览器仍是占位页**（前端里程碑 P0-1-30、Agent 界面 P0-1-31）；` +
    `命令行可跑的完整链路见 README 的手工端测段${c.x}`,
)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-24 Agent 包验收通过（四条门槛）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-24 Agent 包验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
