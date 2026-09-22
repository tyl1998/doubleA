#!/usr/bin/env node
/**
 * verify-conversations.mjs —— P0-1-25（会话管理）与 P0-1-28（消息历史）的验收（需要真实 PG + Redis）
 *
 * 验的是 `02` §4.5 的**八条**已落地端点中的六条 + `02` §5.2 的 `/active`（断线重连的读侧）：
 *   · `POST /api/conversations`（`{agentId}` → 新会话，`topic`/`lastMessageAt` 都是 `null`）；
 *   · `GET /api/agents/:id/conversations`（**我**的会话，按最近活跃排序）；
 *   · `PATCH /api/conversations/:id`（重命名）/ `DELETE /api/conversations/:id`（级联删消息）；
 *   · `GET /api/conversations/:id/active`（无流时恒 `{streaming:false, …null}`）；
 *   · `GET /api/conversations/:id/messages`（**H 组**，P0-1-28：游标分页 + `content` 原样还原）。
 * （另两条 `/chat` 与 `/stop` 的验收在 `verify-chat-stream.mjs` / `verify-chatbot.mjs`。）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本脚本最想钉死的五件事
 * ─────────────────────────────────────────────────────────────────────
 * ① **权限是"仅创建者本人"，不是"登录即可"、更不是"ADMIN 都能看"**。四族资源的口径刻意各不相同
 *    （模型池 = ADMIN、知识库 = 登录即可、智能体 = 创建者 + ADMIN 行级），会话是唯一一个
 *    **连 ADMIN 都不开后门**的（`conversations.user_id`；没有任何文档要求管理员能看别人的聊天记录）。
 *    故这里用 MEMBER 跑"建/改/删/读"，并且**专门用一个 ADMIN 账号去撞同一个会话**，
 *    断言它也拿 404 —— 这条断言是"某天有人顺手给 ADMIN 开个后门"的唯一防线。
 *    反向的那一半同样要钉：**本人改自己的必须 200**（只验"他人 404"的话，
 *    一个"接口恒 404"的实现也全绿）。
 * ② **别人的会话与不存在的会话返回同一个 404**（不是 403）：403 等于确认"这个 id 有效"。
 *    同理 `GET /active` 对别人的会话也必须 404 —— 回 `{streaming:false}` 会把"会话被删了"
 *    伪装成"当前没在生成"，用户会盯着一个永远不会有回复的页面。
 * ③ **`last_message_at` 的维护点是"消息落库时"**（`06` P0-1-25 坑预判），而本批**没有**写消息的
 *    端点（属 P0-1-27）⇒ 该口径的唯一可验入口是模块级的 `touchConversation`（G 组直接调它）。
 *    `POST /:id/chat` 之前，"发起请求就算活跃"的实现**没有任何 HTTP 路径能验到**，故这一组必须在。
 *    顺带钉住"**只前进不后退**"（乱序/重投时时间戳不能倒流）与"**能在事务里用**"（P0-1-27 的用法）。
 * ④ **"新会话排最前"必须显式 `nulls:'first'`**：`last_message_at` 可空，PG 的 `DESC` 默认确实是
 *    NULLS FIRST，但那是"寄存在数据库实现细节上"的顺序语义 —— 错了的症状是
 *    "新建了会话却在侧栏看不见它"。B 组同时钉"null 在非 null 之前"与"非 null 之间按活跃倒序"。
 * ⑤ **删会话是级联**：`deletedMessages` 必须是**删前在同一个事务里数出来的**真数（`03` §七 的
 *    确认框要用它），且 `messages` 真的连带消失（两方向都断：行没了 **且** 消息没了）。
 *    还顺带钉一条容易漏的连带清理：会话删了，它的活跃流锁（`chat.active:{id}`）也要清掉。
 * ⑥ **（H 组，P0-1-28）消息历史的三件事**：
 *    · **不重不漏**：把一页一页真的用 `nextCursor` 翻到底，与**脚本自己复算**的序列逐条对照
 *      （集合双向相同 + 顺序逐条相同 + "正序 ⇒ 时间戳不减、同毫秒内 id 递增"这条自证不变式）。
 *      这条用的是"独立复算"而不是"看起来对"——排序类/分页类输出最容易糊过去的正是这一块。
 *    · **⚠️ 同一毫秒的多条不许漏**：一轮问答的两条消息在**同一个事务**里写入 ⇒ `created_at`
 *      **逐字相同**（`now()` 是事务开始时刻）。用时间戳当游标的实现会在翻页接缝处丢一条，
 *      而"翻页漏一条"只在长会话里偶发、最难查。用例专门把翻页边界落在同毫秒那一组内部。
 *    · **`content` 原样透出**：造一条带 `tool_calls` / `attachments` 的行（P0-2 / P1 才会写入的段），
 *      断言读回来**键序无关逐字相同**且未知段还在 —— 用写入端的 `messageContentSchema` 过滤一遍的
 *      实现会静默剥掉它们（流里看得见、历史里没有，且不报错）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 依赖与前置
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 跑之前必须先起依赖并迁移：`pnpm infra:up && pnpm db:deploy`。
 * **不需要 S3**：本会话删除路径在"没有会话级对象"时连桶都不探（P0-1 阶段恒为空数组，
 * 见 `conversation.service.ts` 文件头 ⑥），故本机 MinIO 没起也能跑。
 * **不需要 `EMBEDDING_*`**：本脚本不建知识库（会话只依赖 Agent + 模型）。
 *
 * 脚本自造带随机后缀的 3 个用户 + 1 个 Provider + 1 个模型 + 若干智能体/会话/消息，
 * 结束时删净并**复核残留**（含 Redis 里的活跃流锁）。
 */

// ⚠️ 必须在 import `config.js`（经 dist 的 app.js 间接引入）**之前**设置：
//    收敛脚本自身日志（本脚本会打一堆"应当失败"的请求，不收敛会把断言输出冲掉）。
//    要看细节时：`LOG_LEVEL=debug node scripts/verify-conversations.mjs`
//    —— 收到 `fatal` 而不是 `error`：被**故意**制造失败的那几组用例，服务端正是按
//    `error` 级打日志的，收到 `error` 等于没收敛（P0-1-17 实测）
process.env.LOG_LEVEL ??= 'fatal'
process.env.LOG_PRETTY ??= 'false'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const {
  ConversationStatus,
  MessageRole,
  UserRole,
  UserStatus,
  closePrisma,
  getPrisma,
} = await import('../dist/backend/src/infra/prisma.js')
const {
  chatActiveKey,
  closeRedis,
  ensureRedisConnected,
  getRedis,
  invalidateUserSnapshot,
  sessionKey,
} = await import('../dist/backend/src/infra/redis.js')
const { touchConversation } = await import('../dist/backend/src/services/conversation.service.js')
  const {
    CONVERSATION_STATUSES,
    CONVERSATION_UNTITLED_HINT,
    conversationActiveSchema,
    conversationItemSchema,
    conversationListResultSchema,
    isConversationReadOnly,
    messagePageResultSchema,
    parseActiveSnapshot,
    removeConversationResultSchema,
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

/** 集合类比较**两侧先排序再比**（`06` P0-1-17 的教训：别把"书写顺序"也当成契约） */
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort()
  const b = [...expected].sort()
  assert(JSON.stringify(a) === JSON.stringify(b), `${label}：期望集合 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

/**
 * 对象比较：**按排序后的键**逐字段比。
 *
 * ⚠️ 不要直接 `JSON.stringify` 两个对象：那等于把"**键的书写顺序**"也当成契约
 * （`06` P0-1-17 的教训的同族 —— 集合要先排序，对象要先按键归一）。
 * 本仓恰好在 `/active` 上踩到一次：响应体的键序来自服务层，而 zod 的 `.extend()` 会把
 * 基础 shape 的键排在前面 ⇒ `parse` 之后的键序与手写期望值不同，**断言看着对却红**。
 * 键序不是契约，能不能读出字段才是。
 */
function assertSameObject(actual, expected, label) {
  const norm = (value) =>
    JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    )
  assert(norm(actual) === norm(expected), `${label}：期望 ${norm(expected)}，实际 ${norm(actual)}`)
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
    if (currentGroup !== null) currentGroup.passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    if (currentGroup !== null) currentGroup.failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

/** 组（= `docs/06` 验收原文里的一件事）；每组开头回显口径，结尾给一行结论 */
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
const PASSWORD = 'Verify-Conversation-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-conv-admin-${suffix}`
/** 会话的**主人**（非 ADMIN）：建/改/删/读的主体 */
const ownerUsername = `verify-conv-owner-${suffix}`
/** 第三方普通用户：守"别人的会话一律 404" */
const otherUsername = `verify-conv-other-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const softDeletedAgentIds = []
const createdConversationIds = []
/** 本脚本往 Redis 里写过的活跃流锁（`chat.active:{id}`）；清理时要逐个删掉并复核 */
const activeKeysWritten = new Set()

/** 一个语法合法但**不存在**的 uuid（用来验 404，而不撞 400 的参数校验） */
const MISSING_UUID = '01930000-0000-7000-8000-000000000000'

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

/** 建智能体并要求成功（会话必须挂在真实 Agent 上） */
async function createAgent(cookie, payload) {
  const response = await api('POST', '/api/agents', { cookie, payload })
  assertEqual(response.statusCode, 200, `建智能体状态码（${JSON.stringify(payload)}）`)
  createdAgentIds.push(response.json().data.id)
  return response.json().data
}

/** 建会话并要求成功，返回契约化后的条目 */
async function createConversation(cookie, agentId) {
  const response = await api('POST', '/api/conversations', { cookie, payload: { agentId } })
  assertEqual(response.statusCode, 200, '建会话状态码')
  const parsed = conversationItemSchema.safeParse(response.json().data)
  assert(parsed.success, `建会话响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  createdConversationIds.push(parsed.data.id)
  return parsed.data
}

/** 某 Agent 下我的会话列表（契约化） */
async function listConversations(cookie, agentId, query = '') {
  const response = await api('GET', `/api/agents/${agentId}/conversations${query}`, { cookie })
  assertEqual(response.statusCode, 200, `会话列表状态码（${query}）`)
  const parsed = conversationListResultSchema.safeParse(response.json().data)
  assert(parsed.success, `会话列表不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  return parsed.data
}

/** 往活跃流锁里写一份快照（**写侧归 P0-1-26**：`orchestrator/sse.ts#updateActiveSnapshot`；
 *  本档验的是**读侧**，故直接写键 —— "键在 ⇒ streaming:true"这条口径与真实的写侧无关） */
async function putActiveKey(conversationId, value, ttlSec = 60) {
  activeKeysWritten.add(conversationId)
  await redis.set(chatActiveKey(conversationId), value, 'EX', ttlSec)
}

/** 活跃流状态（契约化） */
async function readActive(cookie, conversationId) {
  const response = await api('GET', `/api/conversations/${conversationId}/active`, { cookie })
  assertEqual(response.statusCode, 200, '活跃态状态码')
  const parsed = conversationActiveSchema.safeParse(response.json().data)
  assert(parsed.success, `活跃态不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  return parsed.data
}

// ───────────────────────────── 消息历史（P0-1-28）的助手 ─────────────────────────────

/**
 * 递归按键名排序后序列化。
 *
 * ⚠️ 凡"经 jsonb 往返过的值"都**必须**用它比：PG 会把对象键重排，直接 `JSON.stringify`
 * 两个语义相同的对象会得到**逐字不同**的字符串（P0-1-27 实测踩到），而报告里期望值与实际值
 * **长得一模一样**，是典型假红。本组整组都在比读回来的 `content`，故这是前提而不是优化。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 消息历史（契约化；`query` 形如 `?limit=7&beforeId=…`） */
async function listMessages(cookie, conversationId, query = '') {
  const response = await api('GET', `/api/conversations/${conversationId}/messages${query}`, { cookie })
  assertEqual(response.statusCode, 200, `消息历史状态码（${query || '无参数'}）`)
  const parsed = messagePageResultSchema.safeParse(response.json().data)
  assert(parsed.success, `消息历史不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  return parsed.data
}

/**
 * 直接造一条消息 —— **绕过端点**。
 *
 * `messages` 没有写入出口（唯一的写者是编排循环，`chatBot.ts#persistRoundQuietly`），
 * 而本组要**精确控制 `created_at`**（含"同一毫秒的四条"这种真实但难碰巧造出来的形态），
 * 故只能直接落库。这与 P0-1-24 的 R4"会话行由脚本直接造"是同一种做法。
 */
async function seedMessage(conversationId, { role, content, createdAt }) {
  return prisma.message.create({
    data: { conversationId, role, content, ...(createdAt === undefined ? {} : { createdAt }) },
  })
}

/** 库里这个会话的全部消息（**时间正序**，脚本自己的口径）—— 与端点独立对照用 */
async function allMessagesAsc(conversationId) {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    select: { id: true, role: true, content: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  return rows
    .slice()
    .reverse()
    .map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.createdAt.toISOString() }))
}

/**
 * 从最新一页开始逐页翻到底（真实地"用 nextCursor 接着翻"）。
 *
 * 返回的 `items` 是**按页序倒过来**拼接的（第 N 页 → … → 第 1 页）：各页本身是"更早的一页"、
 * 页内正序，界面上"往上加载"＝把新拿到的页**前插** —— 这正是前端要做的动作
 * （写成"按页序拼接"会得到 [4,5,2,3,1]，即"加载更多把消息插错位置"的那个 bug）。
 */
async function walkAllPages(cookie, conversationId, limit) {
  const pages = []
  let cursor = null
  let guard = 0
  const startedAt = Date.now()
  for (;;) {
    guard += 1
    assert(guard <= 50, '翻页次数异常（疑似 `hasMore` 恒真或游标没有前进 ⇒ 会死循环）')
    const query = `?limit=${limit}${cursor === null ? '' : `&beforeId=${cursor}`}`
    const page = await listMessages(cookie, conversationId, query)
    pages.push(page)
    if (!page.hasMore) break
    assertEqual(page.nextCursor, page.items[0].id, '⚠️ hasMore 为真时 nextCursor 必须是本页**最旧**那条')
    assert(page.items.length > 0, '⚠️ 说"还有更多"却给了空页 ⇒ 前端会永远转圈')
    cursor = page.nextCursor
  }
  return {
    pages,
    items: pages.slice().reverse().flatMap((page) => page.items),
    elapsedMs: Date.now() - startedAt,
  }
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-25 会话验收（+ P0-1-28 消息历史）：新建/列表排序/重命名/级联删除 + /active 读侧 + /messages 游标分页 ══${c.x}`)

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
    nickname: '会话验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const owner = await createUser(ownerUsername, {
    nickname: '会话验证主人',
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

  const provider = await prisma.modelProvider.create({
    data: { name: `会话验证 Provider ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
  })
  createdProviderIds.push(provider.id)
  const chatModel = await prisma.model.create({
    data: {
      providerId: provider.id,
      modelName: `verify-conv-chat-${suffix}`,
      label: '会话验证对话模型',
      type: 'CHAT',
    },
  })
  createdModelIds.push(chatModel.id)

  console.log(
    `  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${ownerUsername}（MEMBER·会话主人）+ ${otherUsername}（MEMBER·第三方）${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'A',
    '契约与建会话（`02` §4.5：`{agentId}` → 新会话）',
    '枚举同源 / 初值（topic 与 lastMessageAt 都是 null）/ 前置 404 / 两条鉴权口',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('枚举与判据同源：`CONVERSATION_STATUSES` 对得上数据库枚举，`isConversationReadOnly` 只认 ACTIVE', () => {
    assertEqual(
      JSON.stringify([...CONVERSATION_STATUSES].sort()),
      JSON.stringify(Object.values(ConversationStatus).sort()),
      'CONVERSATION_STATUSES 与 schema.prisma 的 ConversationStatus',
    )
    // 「只读」的判据是纯函数：改坏了不会有任何接口报错（最坏是"只读会话还能发消息"）⇒ 在这一档钉死
    assertEqual(isConversationReadOnly('ACTIVE'), false, 'ACTIVE 可写')
    assertEqual(isConversationReadOnly('FINISHED'), true, 'FINISHED 只读')
    assertEqual(CONVERSATION_UNTITLED_HINT, '新会话', '未命名会话的界面回落文案')
  })

  await it('建会话：只收 `agentId`，`topic`/`lastMessageAt` 都是 `null`，Agent 快照（名 + 类型）已回填', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-建-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
      openingRemarks: '开场白不该影响会话契约',
    })
    const conversation = await createConversation(ownerCookie, agent.id)

    assertEqual(conversation.agentId, agent.id, 'agentId')
    assertEqual(conversation.agentName, agent.name, '⚠️ agentName 是 join 出来的**快照**（Agent 软删后还要靠它显示）')
    assertEqual(conversation.agentType, 'CHATBOT', 'agentType 快照')
    assertEqual(conversation.topic, null, '新建的会话没有标题（**没有自动命名**）')
    assertEqual(conversation.lastMessageAt, null, '新建的会话没有消息 ⇒ lastMessageAt 必须是 null（文件头 ③）')
    assertEqual(conversation.status, 'ACTIVE', '初值 ACTIVE')
    // 键集合固定：多一个字段等于悄悄扩大契约（P0-1-22 的同款断言）
    assertSameSet(
      Object.keys(conversation),
      [
        'id',
        'agentId',
        'agentName',
        'agentType',
        'topic',
        'status',
        'lastMessageAt',
        'createdAt',
        'updatedAt',
      ],
      '投影键集合',
    )
    assertEqual(conversation.createdAt, conversation.updatedAt, '刚建的会话两个时间戳应当一致')
  })

  await it('建会话的四条前置：不存在的 Agent 404 / 已软删的 Agent 404 / 非法 UUID 400 / 未登录 401', async () => {
    assertEqual(
      (await api('POST', '/api/conversations', { cookie: ownerCookie, payload: { agentId: MISSING_UUID } })).statusCode,
      404,
      '不存在的 Agent',
    )

    // 软删的 Agent 不能再开新会话（它的详情页本身就是 404）；但**它已有的会话**仍要看得见（B 组验）
    const doomed = await createAgent(ownerCookie, {
      name: `会话验证智能体-软删-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    assertEqual(
      (await api('DELETE', `/api/agents/${doomed.id}`, { cookie: ownerCookie })).statusCode,
      200,
      '软删 Agent',
    )
    softDeletedAgentIds.push(doomed.id)
    assertEqual(
      (await api('POST', '/api/conversations', { cookie: ownerCookie, payload: { agentId: doomed.id } })).statusCode,
      404,
      '已软删的 Agent',
    )

    const badUuid = await api('POST', '/api/conversations', {
      cookie: ownerCookie,
      payload: { agentId: 'not-a-uuid' },
    })
    assertEqual(badUuid.statusCode, 400, '非法 UUID')
    assertIncludes(fieldMessages(badUuid.json()).join(' '), '不是合法 UUID', '字段级文案')

    // ⚠️ 未登录这一条要给**语法合法**的 body（Fastify 的 schema 校验跑在 preHandler **之前**）
    assertEqual(
      (await api('POST', '/api/conversations', { payload: { agentId: MISSING_UUID } })).statusCode,
      401,
      '未登录',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'B',
    '列表按最近活跃排序（含"新会话排最前"与分页）',
    '`last_message_at desc, nulls first, createdAt desc, id desc` —— 显式 nulls，不靠 PG 默认值',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('排序：**没有消息的排最前**，其后按 `lastMessageAt` 倒序（并带 total / offset / limit）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-排序-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    // 先建一个"从没有过消息"的（`lastMessageAt` 恒为 null）
    const untouched = await createConversation(ownerCookie, agent.id)

    const now = Date.now()
    // 三个时间戳**由脚本掌控**（不是"跑得快慢决定"），断言因此完全确定
    const touched = []
    for (const offsetMin of [30, 20, 10]) {
      const conversation = await createConversation(ownerCookie, agent.id)
      await touchConversation(prisma, conversation.id, new Date(now - offsetMin * 60_000))
      touched.push({ id: conversation.id, at: offsetMin })
    }
    const latestFirst = [...touched].sort((a, b) => a.at - b.at).map((item) => item.id)

    const page = await listConversations(ownerCookie, agent.id)
    assertEqual(page.total, 4, 'total')
    assertEqual(page.offset, 0, 'offset 默认 0')
    assertEqual(page.limit, 20, 'limit 默认 20')
    assertEqual(
      JSON.stringify(page.items.map((item) => item.id)),
      JSON.stringify([untouched.id, ...latestFirst]),
      '⚠️ 顺序：null（新会话）最前，其后按活跃时间倒序',
    )
    assertEqual(page.items[0].lastMessageAt, null, '第一条确实是"没有消息"的那个')

    // 分页：limit=2 只影响本页，不影响 total
    const firstTwo = await listConversations(ownerCookie, agent.id, '?limit=2')
    assertEqual(
      JSON.stringify(firstTwo.items.map((item) => item.id)),
      JSON.stringify([untouched.id, latestFirst[0]]),
      '第 1 页 2 条',
    )
    assertEqual(firstTwo.total, 4, 'total 不受 limit 影响')
    const secondTwo = await listConversations(ownerCookie, agent.id, '?offset=2&limit=2')
    assertEqual(
      JSON.stringify(secondTwo.items.map((item) => item.id)),
      JSON.stringify(latestFirst.slice(1)),
      '第 2 页 2 条',
    )
  })

  await it('**软删的 Agent 仍能列出会话**（`02` §4.4 的"只读保留"，列表刻意不按 `deletedAt` 过滤）', async () => {
    // 这条与 P0-1-24 门槛④ 是同一件事的两个视角：包级脚本验"删 Agent 后历史还在"这个**门槛**，
    // 这里验的是本端点的**过滤条件**（少写 join 过滤就会让历史一起消失）
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    await prisma.message.create({
      data: { conversationId: conversation.id, role: MessageRole.USER, content: { text: '删 Agent 前的消息' } },
    })
    assertEqual(
      (await api('DELETE', `/api/agents/${agent.id}`, { cookie: ownerCookie })).statusCode,
      200,
      '软删 Agent',
    )
    softDeletedAgentIds.push(agent.id)

    const page = await listConversations(ownerCookie, agent.id)
    assertEqual(page.total, 1, '⚠️ 会话必须还在（这是"只读保留"的端点级取证）')
    assertEqual(page.items[0].id, conversation.id, '就是那一条')
    assertEqual(page.items[0].status, 'FINISHED', '已转成 FINISHED（只读）')
    assertEqual(isConversationReadOnly(page.items[0].status), true, '判据同源')

    // 而"Agent 不存在"仍然是 404（不是空列表）：否则前端分不清"这个智能体没了"与"我还没聊过"
    assertEqual(
      (await api('GET', `/api/agents/${MISSING_UUID}/conversations`, { cookie: ownerCookie })).statusCode,
      404,
      '不存在的 Agent → 404（不是空列表）',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'C',
    '权限：**仅创建者本人**（他人 404 · ADMIN 也 404 · 本人 200）',
    '四族资源口径刻意不同；本资源是唯一"连 ADMIN 都不开后门"的（`conversations.user_id`）',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('我的会话：他人与 ADMIN 一律 404（**不是 403**），本人能改；列表里也看不到别人的会话', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-权限-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const mine = await createConversation(ownerCookie, agent.id)
    const renameBody = { topic: '别人不许改' }

    // ① 他人：四条出口全 404（比 403 更少的泄露：403 会确认这个 id 有效）
    assertEqual(
      (await api('PATCH', `/api/conversations/${mine.id}`, { cookie: otherCookie, payload: renameBody })).statusCode,
      404,
      '他人重命名',
    )
    assertEqual(
      (await api('DELETE', `/api/conversations/${mine.id}`, { cookie: otherCookie })).statusCode,
      404,
      '他人删除',
    )
    assertEqual(
      (await api('GET', `/api/conversations/${mine.id}/active`, { cookie: otherCookie })).statusCode,
      404,
      '他人查活跃态',
    )

    // ② ADMIN 同样 404 —— 这条是本组最容易被"顺手"破坏的地方（没有任何文档要求管理员能看别人的会话）
    assertEqual(
      (await api('PATCH', `/api/conversations/${mine.id}`, { cookie: adminCookie, payload: renameBody })).statusCode,
      404,
      '⚠️ ADMIN 也不行（刻意不给后门）',
    )
    assertEqual(
      (await api('DELETE', `/api/conversations/${mine.id}`, { cookie: adminCookie })).statusCode,
      404,
      '⚠️ ADMIN 删也不行',
    )
    assertEqual(
      (await api('GET', `/api/conversations/${mine.id}/active`, { cookie: adminCookie })).statusCode,
      404,
      '⚠️ ADMIN 查活跃态也不行',
    )

    // ③ 列表是"**我**的"：同一个 Agent 下，他人看到的是空列表（不是"全员共享"）
    const otherView = await listConversations(otherCookie, agent.id)
    assertEqual(otherView.total, 0, '⚠️ 他人看不到我的会话（列表必须按 userId 过滤）')
    assertEqual(otherView.items.length, 0, 'items 也必须是空')
    assertEqual((await listConversations(adminCookie, agent.id)).total, 0, 'ADMIN 的列表同样是"他自己的"')
    // 两方向：本人看得到（只验"他人空"的话，一个"列表恒为空"的实现也全绿）
    assertEqual((await listConversations(ownerCookie, agent.id)).total, 1, '本人看得到')

    // ④ 反向：本人改自己的必须成功（否则"接口恒 404"的实现会全绿）
    const ownRename = await api('PATCH', `/api/conversations/${mine.id}`, {
      cookie: ownerCookie,
      payload: { topic: '主人自己改的' },
    })
    assertEqual(ownRename.statusCode, 200, '本人重命名')
    assertEqual(conversationItemSchema.parse(ownRename.json().data).topic, '主人自己改的', '改动生效')

    // ⑤ 列表端点同样要鉴权（未登录 401）
    assertEqual(
      (await api('GET', `/api/agents/${agent.id}/conversations`)).statusCode,
      401,
      '列表未登录',
    )

    // ⑥ 再钉一次"不存在的 id"与"别人的 id"返回**同一个** 404（文案也一致 ⇒ 不可区分）
    const notMine = await api('PATCH', `/api/conversations/${MISSING_UUID}`, {
      cookie: ownerCookie,
      payload: renameBody,
    })
    const othersConv = await api('PATCH', `/api/conversations/${mine.id}`, {
      cookie: otherCookie,
      payload: renameBody,
    })
    assertEqual(notMine.statusCode, othersConv.statusCode, '两种 404 的状态码一致')
    assertEqual(notMine.json().msg, othersConv.json().msg, '⚠️ 文案也必须一致（否则能据此判断 id 是否存在）')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'D',
    '重命名（`PATCH /:id`）：只收非空字符串、**不按 status 拦**',
    '`null`/空串/超长各有独立文案；已结束（FINISHED）的会话照样能改名',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('重命名：`trim` 生效、`null`/空串/超长分别 400 且有各自的字段级文案', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-改名-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)

    const ok = await api('PATCH', `/api/conversations/${conversation.id}`, {
      cookie: ownerCookie,
      payload: { topic: '  带空格的标题  ' },
    })
    assertEqual(ok.statusCode, 200, '状态码')
    assertEqual(conversationItemSchema.parse(ok.json().data).topic, '带空格的标题', 'trim 之后的标题')

    // `null`：契约刻意拒绝（"清空标题"没有交互，见 `shared` 的 schema 注释）
    const nullTopic = await api('PATCH', `/api/conversations/${conversation.id}`, {
      cookie: ownerCookie,
      payload: { topic: null },
    })
    assertEqual(nullTopic.statusCode, 400, '`null` 应被拒')
    assertIncludes(fieldMessages(nullTopic.json()).join(' '), '必须是字符串', '`null` 的文案')

    const empty = await api('PATCH', `/api/conversations/${conversation.id}`, {
      cookie: ownerCookie,
      payload: { topic: '   ' },
    })
    assertEqual(empty.statusCode, 400, '全空白应被拒（trim 后为空）')
    assertIncludes(fieldMessages(empty.json()).join(' '), '不能为空', '空白标题的文案')

    const tooLong = await api('PATCH', `/api/conversations/${conversation.id}`, {
      cookie: ownerCookie,
      payload: { topic: 'x'.repeat(256) },
    })
    assertEqual(tooLong.statusCode, 400, '超长应被拒')
    assertIncludes(fieldMessages(tooLong.json()).join(' '), '255', '超长的文案（列是 VARCHAR(255)）')

    const missing = await api('PATCH', `/api/conversations/${conversation.id}`, { cookie: ownerCookie, payload: {} })
    assertEqual(missing.statusCode, 400, '缺 topic 应被拒')
    assertIncludes(fieldMessages(missing.json()).join(' '), '请输入会话标题', '必填的文案')

    // ⚠️ 未登录要给**语法合法**的 body（schema 校验先于 preHandler）
    assertEqual(
      (await api('PATCH', `/api/conversations/${conversation.id}`, { payload: { topic: 'x' } })).statusCode,
      401,
      '未登录',
    )
    assertEqual(
      (await api('PATCH', '/api/conversations/not-a-uuid', { cookie: ownerCookie, payload: { topic: 'x' } }))
        .statusCode,
      400,
      '非法 UUID',
    )
  })

  await it('已结束（`FINISHED`）的会话**照样能改名**：只读 = 不能再产生消息，不是"什么都不能改"', async () => {
    // 这是"不自己发明约束"（P0-1-11 的教训）的反向守卫：顺手加一句 `status === 'ACTIVE'` 才放行，
    // 就把"清理历史"变成做不到的事。真正该拦的是**发消息** —— 那是 P0-1-26 的 chat 闸门
    // （`POST /:id/chat`，只读会话回 409；落点在 `assertConversationSendable` 而不是这里）。
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-只读改名-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    assertEqual(
      (await api('DELETE', `/api/agents/${agent.id}`, { cookie: ownerCookie })).statusCode,
      200,
      '软删 Agent ⇒ 会话转 FINISHED',
    )
    softDeletedAgentIds.push(agent.id)

    const row = await prisma.conversation.findUnique({ where: { id: conversation.id }, select: { status: true } })
    assertEqual(row?.status, ConversationStatus.FINISHED, '前提：会话确实已 FINISHED')

    const renamed = await api('PATCH', `/api/conversations/${conversation.id}`, {
      cookie: ownerCookie,
      payload: { topic: '已结束的会话也能改名' },
    })
    assertEqual(renamed.statusCode, 200, '改名不被 status 拦')
    assertEqual(conversationItemSchema.parse(renamed.json().data).topic, '已结束的会话也能改名', '改动生效')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'E',
    '删除：级联删消息（`deletedMessages` 是真数）+ 连带的活跃流锁清理',
    '`03` §七：会话删除是级联删除 ⇒ 确认框要"将删除 N 条消息"，故必须删前数出来',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('删会话：消息**连带消失**、`deletedMessages` 是删前数出来的真数、再删一次 404', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-删除-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    await api('PATCH', `/api/conversations/${conversation.id}`, {
      cookie: ownerCookie,
      payload: { topic: `待删除会话-${suffix}` },
    })

    // 消息：本批还没有写消息的端点（P0-1-27）⇒ 按 `02` §三 的同形数据直接造
    for (const text of ['第一条', '第二条', '第三条']) {
      await prisma.message.create({
        data: { conversationId: conversation.id, role: MessageRole.USER, content: { text } },
      })
    }
    assertEqual(await prisma.message.count({ where: { conversationId: conversation.id } }), 3, '前提：3 条消息')

    // 顺手写一个活跃流锁：删会话应当把它一起清掉（否则会留到 TTL 过期，而 `/active` 已经是 404，
    // 没人能发现这堆键是垃圾）
    await putActiveKey(conversation.id, JSON.stringify({ queuedPosition: null, currentTool: 'read', startedAt: null }))
    assertEqual(await redis.exists(chatActiveKey(conversation.id)), 1, '前提：锁在')

    const response = await api('DELETE', `/api/conversations/${conversation.id}`, { cookie: ownerCookie })
    assertEqual(response.statusCode, 200, '状态码')
    const result = removeConversationResultSchema.safeParse(response.json().data)
    assert(result.success, `删除响应不符合契约：${JSON.stringify(result.error?.issues)}`)
    assertEqual(result.data.id, conversation.id, 'id')
    assertEqual(result.data.agentId, agent.id, 'agentId')
    assertEqual(result.data.deletedMessages, 3, '⚠️ deletedMessages 必须是"删前数出来的"真数')
    assertEqual(result.data.topic, `待删除会话-${suffix}`, 'topic 回显（确认框要显示删的是哪条）')

    // 两方向都断：会话行没了 **且** 消息没了（只断"会话没了"的话，一个"消息被漏删"的实现会全绿）
    assertEqual(
      await prisma.conversation.count({ where: { id: conversation.id } }),
      0,
      '会话行必须没了',
    )
    assertEqual(
      await prisma.message.count({ where: { conversationId: conversation.id } }),
      0,
      '⚠️ 消息必须连带消失（外键 CASCADE）',
    )
    assertEqual(await redis.exists(chatActiveKey(conversation.id)), 0, '活跃流锁也要清掉')

    // 再删一次：不是 200、也不是 500（并发双击的语义要干净 —— 与删 Agent 同款）
    assertEqual(
      (await api('DELETE', `/api/conversations/${conversation.id}`, { cookie: ownerCookie })).statusCode,
      404,
      '再删一次',
    )
    // 列表里也不该再有它（"删了的不在"与"没删的还在"要同时成立）
    const agent2 = await createAgent(ownerCookie, {
      name: `会话验证智能体-删除后列表-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const keep = await createConversation(ownerCookie, agent2.id)
    const gone = await createConversation(ownerCookie, agent2.id)
    assertEqual(
      (await api('DELETE', `/api/conversations/${gone.id}`, { cookie: ownerCookie })).statusCode,
      200,
      '删掉一条',
    )
    const page = await listConversations(ownerCookie, agent2.id)
    assertEqual(
      JSON.stringify(page.items.map((item) => item.id)),
      JSON.stringify([keep.id]),
      '⚠️ 删了的不在 **且** 没删的还在（单侧断言挡不住"列表恒为空"）',
    )

    assertEqual(
      (await api('DELETE', `/api/conversations/${MISSING_UUID}`, { cookie: ownerCookie })).statusCode,
      404,
      '不存在的会话',
    )
    assertEqual(
      (await api('DELETE', `/api/conversations/${keep.id}`, { cookie: otherCookie })).statusCode,
      404,
      '他人删不掉',
    )
    assertEqual((await api('DELETE', `/api/conversations/${keep.id}`)).statusCode, 401, '未登录')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'F',
    '`/active` 读侧（`02` §5.2 断线重连）',
    '无流恒为 `{streaming:false, …null}`；键在 ⇒ streaming=true（**派生**）；值坏降级不 500',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('无流：恒为 `{streaming:false, queuedPosition:null, currentTool:null, startedAt:null}`', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-活跃态-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)

    // ⚠️ 写侧（P0-1-26 的 `orchestrator/sse.ts`）**已落地**，但本档刻意不驱动它 ⇒ 这里
    //    仍然是"**恒为无流**"（这正是 `docs/06` P0-1-25 的验收原文）。真流之下的形态
    //    （锁在、心跳续期、/stop 消费）由 `verify-chat-stream.mjs` 负责，两档不重叠。
    const active = await readActive(ownerCookie, conversation.id)
    assertSameObject(
      active,
      { streaming: false, queuedPosition: null, currentTool: null, startedAt: null },
      '无流时的完整响应（字段一个不多一个不少）',
    )
    assertEqual(
      JSON.stringify(Object.keys(active).sort()),
      JSON.stringify(['currentTool', 'queuedPosition', 'startedAt', 'streaming']),
      '键集合固定（多一个字段等于悄悄扩大契约）',
    )
  })

  await it('有流：键在 ⇒ `streaming:true` 且"排队位次 / 当前工具"回显（**值坏也只降级、不 500**）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-活跃态2-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const startedAt = new Date().toISOString()
    const noStream = { streaming: false, queuedPosition: null, currentTool: null, startedAt: null }

    // ① 正常快照（写侧形态见 `shared` 的 `conversationActiveSnapshotSchema`）
    await putActiveKey(conversation.id, JSON.stringify({ queuedPosition: 3, currentTool: 'read_file', startedAt }))
    assertSameObject(
      await readActive(ownerCookie, conversation.id),
      { streaming: true, queuedPosition: 3, currentTool: 'read_file', startedAt },
      '三件套必须逐字回显',
    )

    // ② 值坏（不是 JSON）：键在就是"在流"，细节降级为 null，且**不能 500**
    await putActiveKey(conversation.id, '{ this is not json')
    const broken = await api('GET', `/api/conversations/${conversation.id}/active`, { cookie: ownerCookie })
    assertEqual(broken.statusCode, 200, '⚠️ 值坏也不能 500（断线重连路径最不能失败）')
    assertSameObject(
      conversationActiveSchema.parse(broken.json().data),
      { streaming: true, queuedPosition: null, currentTool: null, startedAt: null },
      '降级形态（键在 ⇒ 还是在流，只是细节丢了）',
    )

    // ③ 值是 JSON 但形状不对（数组 / 字段类型错）：同样只降级
    await putActiveKey(conversation.id, '[]')
    assertSameObject(
      await readActive(ownerCookie, conversation.id),
      { streaming: true, queuedPosition: null, currentTool: null, startedAt: null },
      '顶层是数组',
    )
    await putActiveKey(conversation.id, JSON.stringify({ queuedPosition: 0, currentTool: '   ', startedAt: '不是日期' }))
    assertSameObject(
      await readActive(ownerCookie, conversation.id),
      { streaming: true, queuedPosition: null, currentTool: null, startedAt: null },
      '⚠️ 字段级收敛：`queuedPosition` 必须 ≥1（0 = 没排队，不是"第 0 位"）、工具名不许空白、日期要可解析',
    )
    // 而"好字段留下"这条要在纯函数那一组验（服务端这一层只有整条降级与不降级两种形态）

    // ④ 键删掉 ⇒ 回到无流
    await redis.del(chatActiveKey(conversation.id))
    assertSameObject(await readActive(ownerCookie, conversation.id), noStream, '键没了就回到无流')

    // ⑤ 会话不存在 / 他人的会话 ⇒ **404，不是** `{streaming:false}`（后者会把"会话没了"伪装成"没在生成"）
    assertEqual(
      (await api('GET', `/api/conversations/${MISSING_UUID}/active`, { cookie: ownerCookie })).statusCode,
      404,
      '不存在的会话',
    )
    assertEqual(
      (await api('GET', `/api/conversations/${conversation.id}/active`, { cookie: otherCookie })).statusCode,
      404,
      '他人的会话',
    )
    assertEqual(
      (await api('GET', `/api/conversations/${conversation.id}/active`)).statusCode,
      401,
      '未登录',
    )
    assertEqual(
      (await api('GET', '/api/conversations/not-a-uuid/active', { cookie: ownerCookie })).statusCode,
      400,
      '非法 UUID',
    )
  })

  await it('纯函数 `parseActiveSnapshot`：合法值逐字保留，各种脏值**逐字段**降级且永不抛错', () => {
    // 这一档是"无依赖"能验的东西，放在这里一起跑是为了省一次脚本调用；语义上它属于 `verify:app`
    // 那一族（纯函数、不连库）。⚠️ 两个方向都要验：**合法的别被误降级** + **脏的别漏网**。
    const valid = JSON.stringify({ queuedPosition: 2, currentTool: 'bash', startedAt: '2026-09-22T06:30:00.000Z' })
    assertSameObject(
      parseActiveSnapshot(valid),
      { queuedPosition: 2, currentTool: 'bash', startedAt: '2026-09-22T06:30:00.000Z' },
      '合法值逐字保留',
    )
    for (const [raw, label] of [
      [null, 'null'],
      [undefined, 'undefined'],
      ['', '空串'],
      ['   ', '全空白'],
      ['{oops', '非法 JSON'],
      ['"字符串"', '顶层是字符串'],
      ['123', '顶层是数字'],
      ['[]', '顶层是数组'],
    ]) {
      assertSameObject(
        parseActiveSnapshot(raw),
        { queuedPosition: null, currentTool: null, startedAt: null },
        `降级：${label}`,
      )
    }
    // 字段级：坏字段自己降级，**好字段要留下**（整条丢弃会让"只有时间戳坏了"变成"什么都看不到"）
    assertSameObject(
      parseActiveSnapshot(JSON.stringify({ queuedPosition: -1, currentTool: 'bash', startedAt: 'x' })),
      { queuedPosition: null, currentTool: 'bash', startedAt: null },
      '坏字段各自降级、好字段留下',
    )
    assertSameObject(
      parseActiveSnapshot(JSON.stringify({ queuedPosition: 1.5, currentTool: '  bash  ', startedAt: null })),
      { queuedPosition: null, currentTool: 'bash', startedAt: null },
      '小数位次不算（1.5 = 没人这么写）｜工具名 trim',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'G',
    '`touchConversation`：`last_message_at` 的"只前进不后退"（给 P0-1-27 用）',
    '本批没有写消息的端点 ⇒ 这个时点（`06` 的坑预判）只能在这一档钉；含"能在事务里用"',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('`null` → 设值；更早的 → 不动（返回 false，库里逐字不变）；更晚的 → 前进', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-触碰-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const readLastMessageAt = async () =>
      (await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { lastMessageAt: true },
      }))?.lastMessageAt ?? null

    const t1 = new Date('2026-09-22T06:00:00.000Z')
    assertEqual(await touchConversation(prisma, conversation.id, t1), true, '从 null 设值应当算"改了"')
    assertEqual((await readLastMessageAt())?.toISOString(), t1.toISOString(), '值要写进去')

    // ⚠️ 乱序/重投：更早的时间戳**不许**把新值盖回去（否则会话会在侧栏里"掉下去"）
    const older = new Date('2026-09-22T05:00:00.000Z')
    assertEqual(await touchConversation(prisma, conversation.id, older), false, '倒退应当返回 false')
    assertEqual(
      (await readLastMessageAt())?.toISOString(),
      t1.toISOString(),
      '⚠️ 值必须**逐字不变**（"写了但值相同"会被内容断言漏掉 —— 这里比的是时刻本身）',
    )

    const t2 = new Date('2026-09-22T07:00:00.000Z')
    assertEqual(await touchConversation(prisma, conversation.id, t2), true, '前进应当返回 true')
    assertEqual((await readLastMessageAt())?.toISOString(), t2.toISOString(), '新值生效')
    // 同值重投：不算改动（幂等 —— job 重投不会把时间戳改坏）
    assertEqual(await touchConversation(prisma, conversation.id, t2), false, '同值不算改动')

    assertEqual(await touchConversation(prisma, MISSING_UUID, new Date()), false, '不存在的会话返回 false（不抛）')
  })

  await it('⚠️ 能在**事务里**调用（P0-1-27 是"整条消息落库 + 更新活跃时间"同一事务）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-事务-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const at = new Date('2026-09-22T08:00:00.000Z')

    // 这是接回点：下一批拿到 `tx` 直接调用即可（类型上是 `Pick<PrismaClient, 'conversation'>`）
    const changed = await prisma.$transaction(async (tx) => {
      const touched = await touchConversation(tx, conversation.id, at)
      await tx.message.create({
        data: { conversationId: conversation.id, role: MessageRole.USER, content: { text: '落库与打点同一事务' } },
      })
      return touched
    })
    assertEqual(changed, true, '事务内也要能改到')
    const row = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      select: { lastMessageAt: true },
    })
    assertEqual(row?.lastMessageAt?.toISOString(), at.toISOString(), '事务提交后值可见')
    assertEqual(
      await prisma.message.count({ where: { conversationId: conversation.id } }),
      1,
      '同一事务里的消息也在',
    )
    // 而列表也确实按它排（数据库里写对了 ≠ 列表里看得出来）
    const page = await listConversations(ownerCookie, agent.id)
    assertEqual(page.items[0].lastMessageAt, at.toISOString(), '列表里的 lastMessageAt 与库里一致')
  })

  // ═══════════════════════════════════════════════════════════════════
  groupStart(
    'H',
    '消息历史 `GET /:id/messages`（P0-1-28）：游标分页不重不漏 + `content` 原样还原',
    '翻页用**独立复算**取证；`content` 用 jsonb 逐字比（键序无关）；含"同一毫秒的多条"',
  )
  // ═══════════════════════════════════════════════════════════════════

  await it('空会话：`{items:[], hasMore:false, nextCursor:null}`，且**没有 `total`**', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史空-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const page = await listMessages(ownerCookie, conversation.id)
    assertSameObject(page, { items: [], hasMore: false, nextCursor: null }, '空会话的第一页')
    // ⚠️ 游标分页刻意不给 `total`：在按月分区的表上多跑一次 count 只为显示一个随时会变的数字，
    //    而这个端点真正要回答的只是"还有没有更早的"（`envelope.ts#cursorPageOf`）
    assertEqual('total' in page, false, '不带 total')
    assertSameSet(Object.keys(page), ['items', 'nextCursor', 'hasMore'], '恰好三件套')
  })

  await it('默认一页 20 条：不传 `limit` 时恰好给 20 条 + `hasMore:true`，再翻一页拿到剩下的 2 条', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史默认-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const base = Date.now() - 60_000
    for (let i = 0; i < 22; i += 1) {
      await seedMessage(conversation.id, {
        role: i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
        content: { text: `第 ${i + 1} 条` },
        createdAt: new Date(base + i * 1000),
      })
    }
    const first = await listMessages(ownerCookie, conversation.id)
    assertEqual(first.items.length, 20, '默认 20 条（`02` §四：其余列表也是默认 20）')
    assertEqual(first.hasMore, true, '22 条 ⇒ 第一页之后还有')
    assertEqual(first.items[0].content.text, '第 3 条', '⚠️ 正序：第一页的第一条是最早的**第 3 条**（最旧那两条要等下一页）')
    assertEqual(first.items[19].content.text, '第 22 条', '第一页的最后一条是最新的')

    const second = await listMessages(ownerCookie, conversation.id, `?beforeId=${first.nextCursor}`)
    assertSameObject(
      second.items.map((item) => item.content.text),
      ['第 1 条', '第 2 条'],
      '第二页恰好是剩下的两条（游标那条本身**不在**结果里）',
    )
    assertEqual(second.hasMore, false, '到底了')
    assertEqual(second.nextCursor, null, '到底了游标就是 null')
  })

  await it('逐页翻到底**不重不漏**：与库里独立复算的序列逐条对照（含 `content` 的键序归一）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史翻页-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    // 25 条、时间各不相同（同毫秒那一路由下一条用例专门验）
    const base = Date.now() - 120_000
    for (let i = 0; i < 25; i += 1) {
      await seedMessage(conversation.id, {
        role: i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
        content: { text: `历史第 ${i + 1} 条`, seq: i },
        createdAt: new Date(base + i * 1000),
      })
    }

    const walk = await walkAllPages(ownerCookie, conversation.id, 7)
    const expected = await allMessagesAsc(conversation.id)

    // ① 条数、页数、每页上界
    assertEqual(walk.pages.length, Math.ceil(25 / 7), '25 条按 7 条一页 ⇒ 恰好 4 页')
    for (const [index, page] of walk.pages.entries()) {
      assert(page.items.length <= 7, `第 ${index + 1} 页不得超过 limit（实际 ${page.items.length}）`)
      assert(page.items.length > 0, `第 ${index + 1} 页不该是空的`)
    }
    assertEqual(walk.items.length, 25, '拼起来恰好 25 条')

    // ② **不重**：id 集合大小 == 条数；**不漏**：集合两边相同（这一对是验收原文的核心）
    const walkedIds = walk.items.map((item) => item.id)
    assertEqual(new Set(walkedIds).size, walkedIds.length, '⚠️ 没有重复的 id（各页之间的接缝处最容易重）')
    assertSameSet(walkedIds, expected.map((item) => item.id), '⚠️ 与库里的 id 集合**双向相同**（一条不多、一条不少）')

    // ③ 顺序：与库里按 `(created_at desc, id desc)` 独立复算的结果逐条相同
    assertEqual(
      JSON.stringify(
        walk.items.map((item) => [item.id, item.role, item.createdAt, canonicalJson(item.content)]),
      ),
      JSON.stringify(
        expected.map((item) => [item.id, item.role, item.createdAt, canonicalJson(item.content)]),
      ),
      '逐条四列（含 content）与库里复算的结果一致',
    )

    // ④ 顺序的**自证**不变式：正序 ⇒ `created_at` 不减；同一毫秒内必须按 id 递增（tie-break 生效）。
    //    这一条不依赖上面的"期望值"，故它单独就能挡住"整体倒序/乱序"的实现。
    for (let i = 0; i + 1 < walk.items.length; i += 1) {
      const a = walk.items[i]
      const b = walk.items[i + 1]
      assert(a.createdAt <= b.createdAt, `第 ${i} 与 ${i + 1} 条的时间戳逆序（应当是正序）`)
      assert(
        a.createdAt < b.createdAt || a.id < b.id,
        `第 ${i} 与 ${i + 1} 条同一毫秒却按 id 递减（tie-break 没生效）`,
      )
    }

    // ⑤ 墙钟基线（P0-1-20 的同款做法：阈值给得很松，作用是"下次有人改 SQL 时能看到数字跳变"）
    console.log(
      `   ${c.d}[信息] 4 页 / 25 条共 ${walk.elapsedMs}ms（含 5 次 HTTP 往返）；库中复算 ${expected.length} 条${c.x}`,
    )
    assert(walk.elapsedMs < 5000, `翻完 25 条不该超过 5s（实际 ${walk.elapsedMs}ms）`)
  })

  await it('⚠️ **同一毫秒**的四条被翻页切开时仍然不重不漏（真实形态：一轮问答是一个事务）', async () => {
    // `chatBot.ts#persistRoundQuietly` 把用户消息与助手消息写在**同一个事务**里，而 PG 的 `now()`
    // 是事务开始时刻 ⇒ 同一条消息对的两条 `created_at` **逐字相同**；同一毫秒内还可能有第三、第四条
    // （并发落库）。这不是构造出来的极端值，而是**每一条多轮对话都会产生**的形态。
    // 用时间戳当游标的实现会在这里丢掉同毫秒的其他条 —— 而"翻页漏一条"只在长会话里偶发，最难查。
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史同毫秒-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const base = Date.now() - 120_000
    const sameMs = new Date(base + 6_000) // 4 条完全相同的时刻
    let seq = 0
    const order = []
    for (let i = 1; i <= 5; i += 1) order.push({ createdAt: new Date(base + i * 1000), text: `早 ${i}` })
    for (let i = 0; i < 4; i += 1) order.push({ createdAt: sameMs, text: `同毫秒 ${i + 1}` })
    for (let i = 7; i <= 16; i += 1) order.push({ createdAt: new Date(base + i * 1000), text: `晚 ${i - 6}` })
    for (const entry of order) {
      seq += 1
      await seedMessage(conversation.id, {
        role: seq % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
        content: { text: entry.text },
        createdAt: entry.createdAt,
      })
    }

    // limit = 3 保证翻页边界**落在同毫秒那一组内部**
    const walk = await walkAllPages(ownerCookie, conversation.id, 3)
    const expected = await allMessagesAsc(conversation.id)
    assertEqual(walk.items.length, order.length, `19 条一条都不能少（实际 ${walk.items.length}）`)
    assertEqual(new Set(walk.items.map((item) => item.id)).size, order.length, '没有重复')
    assertSameSet(walk.items.map((item) => item.id), expected.map((item) => item.id), '与库里的集合双向相同')
    assertEqual(
      JSON.stringify(walk.items.map((item) => item.content.text)),
      JSON.stringify(expected.map((item) => item.content.text)),
      '四条同毫秒的消息**全部在**且顺序与库一致（用时间戳当游标会在这里少一条）',
    )
    // 同毫秒那 4 条必须**相邻**出现（否则说明排序口径里混进了别的东西）
    const positions = walk.items
      .map((item, index) => ({ index, text: item.content.text }))
      .filter((entry) => entry.text.startsWith('同毫秒'))
      .map((entry) => entry.index)
    assertEqual(positions.length, 4, '四条同毫秒的消息都在结果里')
    assertEqual(positions[3] - positions[0], 3, '它们必须连续（中间不插别的消息）')
  })

  await it('`content` **原样透出**：`tool_calls` / `attachments` 不被剥掉，`citations` 三列逐字还原', async () => {
    // 这是 `01` §3.4「含工具卡 / 引用的完整还原」在 P0-1 阶段**唯一能验到的那一半**：
    // 工具卡（`tool_calls`）的**写入方**是 P0-2 的 MCP 工具循环 —— 本版本没有路径能产生它，
    // 故这里直接造一条"P0-2 会写出来的形状"的行，验读取端**原样交出去**。
    // 用 `messageContentSchema` 过滤一遍的实现会在这里红（它会把未知段静默剥掉）。
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史结构-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const richContent = {
      text: '带引用与工具卡的回答',
      thinking: '先检索知识库，再调用工具',
      citations: [
        { docName: '报销制度.txt', snippet: '出差住宿标准为每晚上限 500 元。', score: 0.0328 },
        { docName: '员工手册.md', snippet: '年假按工龄计算。', score: 0.0164 },
      ],
      // ⚠️ 下面两段**本版本刻意不定型**（`shared/src/conversation.ts` 的注释），但读取端必须原样带出来
      tool_calls: [
        {
          callId: 'call-1',
          toolName: 'search_kb',
          serverName: 'demo-server',
          kind: 'MCP',
          status: 'SUCCESS',
          inputSummary: 'q=住宿标准',
          output: '2 hits',
        },
      ],
      attachments: [{ fileId: 'f-1', fileName: 'a.png', mime: 'image/png', size: 1234 }],
    }
    await seedMessage(conversation.id, { role: MessageRole.USER, content: { text: '出差住宿标准？' } })
    await seedMessage(conversation.id, { role: MessageRole.ASSISTANT, content: richContent })

    const page = await listMessages(ownerCookie, conversation.id)
    assertEqual(page.items.length, 2, '两条都在')
    const assistant = page.items[1]
    assertEqual(assistant.role, 'ASSISTANT', '角色是 DB 枚举原值（大写）')
    assertEqual(
      canonicalJson(assistant.content),
      canonicalJson(richContent),
      '⚠️ `content` 与库里的 jsonb **键序无关逐字相同**（PG 会重排对象键 ⇒ 必须用 canonicalJson 比）',
    )
    assertSameSet(
      Object.keys(assistant.content),
      ['text', 'thinking', 'citations', 'tool_calls', 'attachments'],
      '⚠️ 未知段（tool_calls / attachments）必须还在 —— 被剥掉的实现只会"刷新后卡片少一块"，不报错',
    )
    assertEqual(assistant.content.tool_calls[0].callId, 'call-1', '工具卡的关键字段可读（前端按 callId upsert）')
    assertEqual(assistant.content.attachments[0].fileName, 'a.png', '附件段可读（P1 才写入）')
    // 引用卡三列与 SSE 的 `citations` 事件同形（`03` §五 单一渲染路径）
    assertSameSet(Object.keys(assistant.content.citations[0]), ['docName', 'snippet', 'score'], '引用卡三列')
    assertEqual(assistant.content.citations[0].score, 0.0328, '融合分**数值逐字**（不被劣化成字符串或整数）')
    assertEqual(assistant.content.citations.length, 2, '两条引用都在（顺序也保持）')
  })

  await it('游标语义：只返回**严格更早**的，游标那条本身不在结果里', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史游标-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const base = Date.now() - 120_000
    for (let i = 0; i < 12; i += 1) {
      await seedMessage(conversation.id, {
        role: MessageRole.USER,
        content: { text: `游标第 ${i + 1} 条` },
        createdAt: new Date(base + i * 1000),
      })
    }
    const expected = await allMessagesAsc(conversation.id)
    const cursor = expected[7] // 正序里的第 8 条（下标 7）⇒ 更早的是下标 0..6
    assertEqual(cursor.content.text, '游标第 8 条', '前提：游标行的正文（这一条错了后面全无意义）')

    const older = await listMessages(ownerCookie, conversation.id, `?beforeId=${cursor.id}&limit=100`)
    assertEqual(older.items.length, 7, '游标之前的 7 条')
    assertEqual(
      JSON.stringify(older.items.map((item) => item.content.text)),
      JSON.stringify(expected.slice(0, 7).map((item) => item.content.text)),
      '恰好是游标之前那 7 条（正序）',
    )
    assertEqual(
      older.items.some((item) => item.id === cursor.id),
      false,
      '⚠️ 游标那条本身**不在**结果里（否则前端会显示重复的一条）',
    )
    assertEqual(older.hasMore, false, '已经没有更早的了')
    assertEqual(older.nextCursor, null, '到底了')

    // 再看 limit 边界：limit=3 时给"游标之前的最近 3 条"，且游标指向这 3 条里最旧的那条
    const tail = await listMessages(ownerCookie, conversation.id, `?beforeId=${cursor.id}&limit=3`)
    assertEqual(
      JSON.stringify(tail.items.map((item) => item.content.text)),
      JSON.stringify(['游标第 5 条', '游标第 6 条', '游标第 7 条']),
      '⚠️ 是"紧挨着游标的那 3 条"，不是"最早那 3 条"',
    )
    assertEqual(tail.nextCursor, expected[4].id, 'nextCursor = 本页最旧那条（第 5 条）')
    assertEqual(tail.hasMore, true, '前面还有 4 条')
  })

  await it('游标失效一律 **400**（而不是"当成没有游标"——那会让前端把最新一页又拿一遍 ⇒ 消息重复）', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史坏游标-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    const otherOwned = await createConversation(ownerCookie, agent.id) // 同一个人的**另一个**会话
    const foreign = await createConversation(otherCookie, agent.id) // 别人的会话
    const mine = await seedMessage(conversation.id, { role: MessageRole.USER, content: { text: '我的' } })
    const sibling = await seedMessage(otherOwned.id, { role: MessageRole.USER, content: { text: '我的另一个会话' } })
    const theirs = await seedMessage(foreign.id, { role: MessageRole.USER, content: { text: '别人的' } })
    assertEqual(mine.id === sibling.id, false, '前提：两条消息的 id 不同')

    const expectValidation = async (query, label) => {
      const response = await api('GET', `/api/conversations/${conversation.id}/messages${query}`, {
        cookie: ownerCookie,
      })
      assertEqual(response.statusCode, 400, `${label}：应当 400`)
      assertEqual(response.json().code, 'VALIDATION', `${label}：错误码`)
      return response.json()
    }

    // ① 语法合法但库里不存在 ⇒ 400（不是 404：主语是"这个**请求参数**"，会话本身是存在的）
    const missing = await expectValidation(`?beforeId=${MISSING_UUID}`, '不存在的游标')
    assertIncludes(missing.msg, '游标无效', '文案要指向"游标"，否则调用方会以为是会话的问题')

    // ② ⚠️ **同一个人的另一个会话**的消息也不行 —— 这是"游标必须属于本会话"那条 where 的取证
    await expectValidation(`?beforeId=${sibling.id}`, '同会话之外（我的另一个会话）的游标')

    // ③ ⚠️ **别人的会话**的消息更不行（没有会话维度过滤的实现会在这里命中并泄露时序）
    await expectValidation(`?beforeId=${theirs.id}`, '别人的会话里的游标')

    // ④ 格式非法：由路由级 schema 拦（字段级明细是**字符串**形态，带请求部位前缀）
    const badFormat = await expectValidation('?beforeId=not-a-uuid', '非 UUID 的游标')
    assertEqual(badFormat.data.fields[0].path, 'querystring.beforeId', '字段级明细指到 querystring.beforeId')
    // ⑤ limit 的边界也走同一条 400（0 条没有意义 / 上限 100）
    await expectValidation('?limit=0', 'limit=0')
    await expectValidation('?limit=101', 'limit=101')

    // 反向的一半：**合法游标必须 200**（只验 400 的话，"接口恒 400"的实现也全绿）
    const okPage = await listMessages(ownerCookie, conversation.id, `?beforeId=${mine.id}`)
    assertSameObject(okPage, { items: [], hasMore: false, nextCursor: null }, '游标就是最早那条 ⇒ 空页而不是报错')
  })

  await it('权限三方向 + 会话不存在：他人 404 / ADMIN 404 / 未登录 401 / 不存在的会话 404', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史权限-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    const conversation = await createConversation(ownerCookie, agent.id)
    await seedMessage(conversation.id, { role: MessageRole.USER, content: { text: '只该我看到' } })

    // ① 第三方 MEMBER：404（不是 403 —— 403 等于确认这个 id 有效）
    assertEqual((await api('GET', `/api/conversations/${conversation.id}/messages`, { cookie: otherCookie })).statusCode, 404, '他人')
    // ② ⚠️ **连 ADMIN 也不给后门**：会话这一族的判据是 `user_id`，不是角色
    //    （四族权限刻意各不相同；只验"他人 404"的话，"ADMIN 能看所有人聊天记录"的实现会全绿）
    assertEqual((await api('GET', `/api/conversations/${conversation.id}/messages`, { cookie: adminCookie })).statusCode, 404, 'ADMIN')
    // ③ 未登录 401（⚠️ 必须给**语法合法**的 params：Fastify 的路由级 schema 跑在 preHandler 之前，
    //    给一个非 UUID 的 id 会先拿到 400 —— P0-1-22 记过的坑）
    assertEqual((await api('GET', `/api/conversations/${conversation.id}/messages`)).statusCode, 401, '未登录')
    // ④ 不存在的会话：404（与"不是我的"同一个响应）
    assertEqual(
      (await api('GET', `/api/conversations/${MISSING_UUID}/messages`, { cookie: ownerCookie })).statusCode,
      404,
      '不存在的会话',
    )
    // ⑤ 反向：本人的必须是 200 且看得到内容（否则"接口恒 404"的实现也全绿）
    const mine = await listMessages(ownerCookie, conversation.id)
    assertSameObject(mine.items.map((item) => item.content.text), ['只该我看到'], '本人可读')
  })

  await it('只读（`FINISHED`）的会话**历史照样看得见**；在流中的会话历史只有已落库的那些', async () => {
    const agent = await createAgent(ownerCookie, {
      name: `会话验证智能体-历史只读-${suffix}`,
      type: 'CHATBOT',
      modelId: chatModel.id,
    })
    // ① `FINISHED` = "Agent 被软删"留下的标记（`02` §4.4 的"只读**保留**"）——
    //    "只读"只表示**不能再产生消息**，历史必须看得见（改名/删除也刻意不按它拦，D 组已验）
    const frozen = await createConversation(ownerCookie, agent.id)
    await seedMessage(frozen.id, { role: MessageRole.USER, content: { text: '冻结前的问题' } })
    await seedMessage(frozen.id, { role: MessageRole.ASSISTANT, content: { text: '冻结前的回答' } })
    await prisma.conversation.update({ where: { id: frozen.id }, data: { status: ConversationStatus.FINISHED } })
    const frozenPage = await listMessages(ownerCookie, frozen.id)
    assertSameObject(
      frozenPage.items.map((item) => item.content.text),
      ['冻结前的问题', '冻结前的回答'],
      '⚠️ 只读会话的历史照样能读（按 `status` 拦的实现会在这里红）',
    )

    // ② "历史不含进行中消息，进行中状态由 `/active` 提供"（`02` §5.2）：
    //    半条回答只存在于那条 SSE 连接上，落库发生在 `done` 时 ⇒ 在流中的会话，
    //    历史 = **已落库的那些**，而"正在生成"这件事由 `/active` 回答。两者合起来才是断线重连。
    const streaming = await createConversation(ownerCookie, agent.id)
    await seedMessage(streaming.id, { role: MessageRole.USER, content: { text: '落库了的' } })
    await putActiveKey(streaming.id, JSON.stringify({ queuedPosition: null, currentTool: 'search_kb', startedAt: new Date().toISOString() }))
    const streamingPage = await listMessages(ownerCookie, streaming.id)
    assertSameObject(streamingPage.items.map((item) => item.content.text), ['落库了的'], '历史里没有"半条回答"')
    const active = await readActive(ownerCookie, streaming.id)
    assertEqual(active.streaming, true, '而"在流"由 /active 回答（`startedAt`/`currentTool` 也在那儿）')
    assertEqual(active.currentTool, 'search_kb', '当前工具')
  })
} finally {
  // ───────────────────────────── 清理 + 复核残留 ─────────────────────────────
  console.log(`\n${c.b}── 清理（自清理 + 复核残留）──${c.x}`)
  let allConversationIds = []
  try {
    // 顺序有讲究：外键全是 RESTRICT（`conversations → agents/users`），必须自下而上删
    // ⚠️ 一律 `deleteMany`（不要 `delete` + `.catch()`：Prisma 会把 P2025 的整条堆栈打到 stdout，
    //    而脚本的 stdout 就是断言结果本身 —— `.catch()` 吞得掉异常、吞不掉已经打出的日志）
    // 会话按"我的临时用户"兜底枚举（不依赖用例有没有把 id 记全）
    allConversationIds = [
      ...new Set([
        ...createdConversationIds,
        ...(
          await prisma.conversation.findMany({
            where: { userId: { in: createdUserIds } },
            select: { id: true },
          })
        ).map((row) => row.id),
      ]),
    ]

    await prisma.message.deleteMany({ where: { conversationId: { in: allConversationIds } } })
    await prisma.conversation.deleteMany({ where: { id: { in: allConversationIds } } })

    const agentIds = [...new Set([...createdAgentIds, ...softDeletedAgentIds])]
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: agentIds } } })
    await prisma.conversation.deleteMany({ where: { agentId: { in: agentIds } } })
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } })

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
    // 活跃流锁：本脚本自己造的那几个（用户没跑过 chat，故只有脚本造的）+ 删会话时若漏清也会在这里被兜掉
    for (const id of allConversationIds) await redis.del(chatActiveKey(id)).catch(() => undefined)
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  // 复核残留（"删干净了"本身要是一条可复核的结论，而不是"我没报错"）
  const residue = {
    users: await prisma.user.count({ where: { username: { contains: suffix } } }).catch(() => -1),
    providers: await prisma.modelProvider.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    models: await prisma.model.count({ where: { modelName: { contains: suffix } } }).catch(() => -1),
    agents: await prisma.agent.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    conversations: await prisma.conversation.count({ where: { userId: { in: createdUserIds } } }).catch(() => -1),
    messages: await prisma.message.count({ where: { conversationId: { in: allConversationIds } } }).catch(() => -1),
  }
  const dirty = Object.entries(residue).filter(([, count]) => count !== 0)
  const sessionsLeft = []
  for (const sid of sessionIds) {
    if ((await redis.exists(sessionKey(sid)).catch(() => 0)) !== 0) sessionsLeft.push(sid)
  }
  const activeLeft = []
  for (const id of allConversationIds) {
    if ((await redis.exists(chatActiveKey(id)).catch(() => 0)) !== 0) activeLeft.push(id)
  }
  if (dirty.length === 0 && sessionsLeft.length === 0 && activeLeft.length === 0) {
    console.log(
      `  ${c.g}[PASS]${c.x} 残留复核：6 张表全部为 0，${sessionIds.length} 个会话键 + ${allConversationIds.length} 个活跃流锁全部清空`,
    )
    passed += 1
  } else {
    console.log(
      `  ${c.r}[FAIL]${c.x} 残留复核：表 ${JSON.stringify(residue)}｜会话键 ${sessionsLeft.length} 个｜活跃流锁 ${activeLeft.length} 个`,
    )
    failed += 1
  }

  await app.close()
  await closePrisma()
  await closeRedis()
}

// ───────────────────────────── 结论表 ─────────────────────────────
console.log(`\n${c.b}── 分组结论 ──${c.x}`)
for (const group of groups) {
  const ok = group.failed === 0
  console.log(
    `  ${ok ? c.g : c.r}${ok ? '✅' : '❌'} ${group.id} ${group.title}${c.x} — ${group.passed} 项${
      ok ? '全通过' : `通过 / ${group.failed} 项失败`
    }`,
  )
}
console.log(`  ${c.d}覆盖：` + groups.map((group) => `${group.id}(${group.passed})`).join(' / ') + `${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-25 会话验收通过（含 P0-1-28 消息历史）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-25 会话验收未通过（含 P0-1-28 消息历史）：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
