#!/usr/bin/env node
/**
 * verify-models.mjs —— P0-1-11 的**模型管理验收**（需要真实 Redis + PG）
 *
 * 验的是 `02` §4.3 的模型部分：管理四端点（`(A)` 仅 ADMIN）+ 全员可选列表，
 * 以及 `01` §3.2 的两条验收要点：
 *
 *   ① **`type=CHAT` 只返回 chat 模型**；
 *   ② **`enabled=false` 的模型不出现在全员可选列表**（原话：「无效模型创建 Agent 时不可选」）。
 *      ② 还有一个同族的孪生情形：**Provider 被停用**时它下面的模型同样不可选 ——
 *      只筛 `models.enabled` 会给出"选了它能建 Agent、一发消息就失败"的模型，比不显示更坑。
 *
 * ⚠️ 本脚本最想钉死的一件事：**两套投影是按路径分的，不是按角色分的**。
 *    如果实现成"同一条 `GET /api/models` 按调用者身份决定返回什么"，那么
 *    **ADMIN 在智能体编辑页的模型下拉里会看到停用的模型**，直接违反 ②。
 *    所以这里有一条用例专门用 **ADMIN 身份**打 `available`，断言它同样看不到停用项。
 *
 * 另有六条守卫（都是"先查再说人话"，不许把 500 抛给用户）：
 *   建到不存在的 Provider → 404；重复型号 → 409；删被 Agent 引用的模型 → 409；
 *   改 type 被 Agent 引用 → 409；改 providerId → 409（同值放行）；非法 UUID → 400。
 *   其中"删被引用的模型"特意用了**软删的 Agent**（`deleted_at` 非空）——
 *   它照样占着 `ON DELETE RESTRICT` 的外键，按 `deletedAt` 过滤的计数会出现
 *   "界面说能删、删下去 500"。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`
 * 脚本自造带随机后缀的临时数据（ADMIN + MEMBER + 两个 Provider + 若干模型 + Agent），结束时删净。
 * 清理顺序是硬要求：Agent 先于 Model（RESTRICT），Model 先于 Provider（或由 Provider 级联）。
 */

// 必须在 import `config.js`（经 dist 的 app.js）之前设置：脚本会打一堆"应当失败"的请求
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { AgentType, UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { modelItemSchema, modelListResultSchema, modelOptionListResultSchema, modelOptionSchema } =
  await import('@doubulea/shared')

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

// ───────────────────────────── 工具 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Models-Passw0rd'

const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-models-admin-${suffix}`
const memberUsername = `verify-models-member-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []

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

const cookieHeader = (value) => ({ cookie: `${SESSION_COOKIE_NAME}=${value}` })

function api(method, url, { cookie, payload } = {}) {
  const options = { method, url }
  if (cookie !== undefined && cookie !== '') options.headers = cookieHeader(cookie)
  if (payload !== undefined) options.payload = payload
  return app.inject(options)
}

/** 建 Provider（直连库，本脚本只关心模型那一半；Provider 的守卫由 P0-1-10 的脚本负责） */
function createProvider(name, { type = 'CHAT', enabled = true } = {}) {
  return prisma.modelProvider
    .create({ data: { name, baseUrl: 'https://api.example.com/v1', type, enabled } })
    .then((row) => {
      createdProviderIds.push(row.id)
      return row
    })
}

/** 取"当前可选列表里的模型 id 集合"（用给定身份请求） */
async function availableIds(cookie, type = 'CHAT') {
  const response = await api('GET', `/api/models/available?type=${type}`, { cookie })
  assertEqual(response.statusCode, 200, `available(${type}) 状态码`)
  const parsed = modelOptionListResultSchema.safeParse(response.json().data)
  assert(parsed.success, `available 响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  return parsed.data.items.map((item) => item.id)
}

/** 取管理列表里的全部条目（分页拉全） */
async function manageItems(cookie) {
  const response = await api('GET', '/api/models?limit=100', { cookie })
  assertEqual(response.statusCode, 200, '管理列表状态码')
  const parsed = modelListResultSchema.safeParse(response.json().data)
  assert(parsed.success, `管理列表不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  return parsed.data.items
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-11 模型管理验收：CRUD / 两套投影 / 可选列表过滤 / 六条守卫 ══${c.x}`)

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
    nickname: '模型管理验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const member = await createUser(memberUsername, {
    nickname: '模型管理验证成员',
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

  /** 正常 Provider（CHAT）与其下的模型都由后续用例创建 */
  const provider = await createProvider(`模型验证 Provider ${suffix}`)
  const emptyProvider = await createProvider(`模型验证空 Provider ${suffix}`)
  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${memberUsername}（MEMBER）+ 2 个 Provider${c.x}`)

  // ══════════ 1. 权限与路由分流 ══════════
  await it('管理列表仅 ADMIN（匿名 401 / MEMBER 403 / ADMIN 200）；可选列表全员可读（MEMBER 200）', async () => {
    const anonymous = await api('GET', '/api/models')
    assertEqual(anonymous.statusCode, 401, '匿名调管理列表状态码')
    assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名信封 code')

    const asMember = await api('GET', '/api/models', { cookie: memberCookie })
    assertEqual(asMember.statusCode, 403, 'MEMBER 调管理列表状态码')
    assertEqual(asMember.json().code, 'FORBIDDEN', 'MEMBER 信封 code')

    const asAdmin = await api('GET', '/api/models', { cookie: adminCookie })
    assertEqual(asAdmin.statusCode, 200, 'ADMIN 调管理列表状态码')

    // 可选列表是"建 Agent 用"的，MEMBER 必须能读（否则普通用户建不了智能体）
    const availableAsMember = await api('GET', '/api/models/available?type=CHAT', { cookie: memberCookie })
    assertEqual(availableAsMember.statusCode, 200, 'MEMBER 调可选列表状态码')
    const available = await api('GET', '/api/models/available?type=CHAT', { cookie: adminCookie })
    assertEqual(available.statusCode, 200, 'ADMIN 调可选列表状态码')

    // 写操作只有 ADMIN 能做（避免"普通人改模型池"）
    const forbiddenWrites = [
      ['POST', '/api/models', { providerId: provider.id, modelName: 'x', label: 'x', type: 'CHAT' }],
      ['PATCH', `/api/models/${provider.id}`, { label: 'x' }],
      ['DELETE', `/api/models/${provider.id}`, undefined],
    ]
    for (const [method, url, payload] of forbiddenWrites) {
      const response = await api(method, url, { cookie: memberCookie, payload })
      assertEqual(response.statusCode, 403, `MEMBER ${method} ${url} 状态码`)
    }
  })

  // ══════════ 2. 建模型（落库 + 投影） ══════════
  let chatModel
  let embeddingModel
  await it('建模型 → 200 且返回**管理投影**（providerName/providerEnabled/agentCount 齐备）', async () => {
    const response = await api('POST', '/api/models', {
      cookie: adminCookie,
      payload: {
        providerId: provider.id,
        modelName: `gpt-verify-${suffix}`,
        label: '验证用小钢炮',
        type: 'CHAT',
        maxContext: 128_000,
        supportsVision: true,
      },
    })
    assertEqual(response.statusCode, 200, '状态码')
    const data = response.json().data
    chatModel = data
    createdModelIds.push(data.id)

    const parsed = modelItemSchema.safeParse(data)
    assert(parsed.success, `建模型响应不符合 modelItemSchema：${JSON.stringify(parsed.error?.issues)}`)
    assertEqual(data.providerId, provider.id, 'providerId')
    assertEqual(data.providerName, provider.name, 'providerName 应带出来（管理页要直接显示）')
    assertEqual(data.providerEnabled, true, 'providerEnabled')
    assertEqual(data.modelName, `gpt-verify-${suffix}`, 'modelName')
    assertEqual(data.label, '验证用小钢炮', 'label')
    assertEqual(data.type, 'CHAT', 'type')
    assertEqual(data.maxContext, 128_000, 'maxContext')
    assertEqual(data.supportsVision, true, 'supportsVision')
    assertEqual(data.enabled, true, 'enabled 缺省应为 true')
    assertEqual(data.agentCount, 0, '新模型应无 Agent 引用')

    // 落库核对：别只信响应（响应是投影，库里才是真相）
    const row = await prisma.model.findUnique({ where: { id: data.id } })
    assertEqual(row?.modelName, `gpt-verify-${suffix}`, '库里的 modelName')
    assertEqual(row?.maxContext, 128_000, '库里的 maxContext')
    assertEqual(row?.supportsVision, true, '库里的 supportsVision')
    assertEqual(row?.enabled, true, '库里的 enabled')
  })

  await it('建 embedding 模型：`maxContext` 缺省落 `NULL`、`supportsVision` 缺省落 false', async () => {
    const response = await api('POST', '/api/models', {
      cookie: adminCookie,
      payload: {
        providerId: provider.id,
        modelName: `text-embedding-verify-${suffix}`,
        label: '验证用向量模型',
        type: 'EMBEDDING',
      },
    })
    assertEqual(response.statusCode, 200, '状态码')
    embeddingModel = response.json().data
    createdModelIds.push(embeddingModel.id)
    assertEqual(embeddingModel.maxContext, null, 'maxContext 缺省应为 null')
    assertEqual(embeddingModel.supportsVision, false, 'supportsVision 缺省应为 false')
    assertEqual(embeddingModel.type, 'EMBEDDING', 'type')
  })

  // ══════════ 3. 验收门槛①：type 过滤 ══════════
  await it('门槛①：`?type=CHAT` 只返回 chat 模型，`?type=EMBEDDING` 只返回向量模型（两套投影都验）', async () => {
    // 管理面
    for (const [type, expectId, rejectId] of [
      ['CHAT', chatModel.id, embeddingModel.id],
      ['EMBEDDING', embeddingModel.id, chatModel.id],
    ]) {
      const response = await api('GET', `/api/models?type=${type}&limit=100`, { cookie: adminCookie })
      assertEqual(response.statusCode, 200, `管理列表 ?type=${type} 状态码`)
      const items = response.json().data.items
      const ids = items.map((item) => item.id)
      assert(ids.includes(expectId), `?type=${type} 应含该类型的模型，实际 ${ids.join(',')}`)
      assert(!ids.includes(rejectId), `?type=${type} 不应含另一类型的模型`)
      assert(
        items.every((item) => item.type === type),
        `?type=${type} 的每一项都应是该类型`,
      )
    }
    // 可选面（`03` §4.2 的下拉就是这个）
    const chatIds = await availableIds(memberCookie, 'CHAT')
    assert(chatIds.includes(chatModel.id), '可选列表 CHAT 应含刚建的 chat 模型')
    assert(!chatIds.includes(embeddingModel.id), '可选列表 CHAT 不应含向量模型')
    const embedIds = await availableIds(memberCookie, 'EMBEDDING')
    assert(embedIds.includes(embeddingModel.id), '可选列表 EMBEDDING 应含刚建的向量模型')
    assert(!embedIds.includes(chatModel.id), '可选列表 EMBEDDING 不应含对话模型')
  })

  // ══════════ 4. 验收门槛②：停用即不可选 ══════════
  await it('门槛②：停用模型 → 从**全员可选列表**消失，但仍在**管理列表**（两套投影的差别所在）', async () => {
    const disabled = await api('PATCH', `/api/models/${chatModel.id}`, {
      cookie: adminCookie,
      payload: { enabled: false },
    })
    assertEqual(disabled.statusCode, 200, '停用状态码')
    assertEqual(disabled.json().data.enabled, false, '停用后的 enabled')

    // ① 可选列表（MEMBER 身份 —— "全员"就是这个意思）
    const asMember = await availableIds(memberCookie, 'CHAT')
    assert(!asMember.includes(chatModel.id), '停用的模型不得出现在全员可选列表')

    // ② ⚠️ 关键：**ADMIN 身份**看到的可选列表也必须一样。
    //    若实现成"按角色决定投影"，ADMIN 这里会看到停用项 —— 而 ADMIN 也要建智能体，
    //    那等于让管理员选到一个无效模型（违反同一条验收要点）。
    const asAdmin = await availableIds(adminCookie, 'CHAT')
    assert(!asAdmin.includes(chatModel.id), 'ADMIN 的可选列表同样不得含停用模型')

    // ③ 管理列表必须**仍然看得见**（否则管理员没法把它改回来）
    const managed = await manageItems(adminCookie)
    const found = managed.find((item) => item.id === chatModel.id)
    assert(found !== undefined, '管理列表应仍含停用模型（否则改不回来）')
    assertEqual(found.enabled, false, '管理列表里应显示为已停用')
  })

  await it('门槛②的孪生情形：**Provider 停用**后其模型也不可选，但模型自身的 enabled 不被动过', async () => {
    // 先恢复模型自身的启用
    await api('PATCH', `/api/models/${chatModel.id}`, { cookie: adminCookie, payload: { enabled: true } })
    assert((await availableIds(memberCookie, 'CHAT')).includes(chatModel.id), '恢复后应回到可选列表')

    const disabledProvider = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: adminCookie,
      payload: { enabled: false },
    })
    assertEqual(disabledProvider.statusCode, 200, '停用 Provider 状态码')

    const ids = await availableIds(memberCookie, 'CHAT')
    assert(!ids.includes(chatModel.id), 'Provider 停用后其模型不得出现在可选列表')

    // 模型自己的 enabled 不该被连带改掉（停用是 Provider 的事，不是模型的）
    const managed = await manageItems(adminCookie)
    const found = managed.find((item) => item.id === chatModel.id)
    assertEqual(found?.enabled, true, '模型自身的 enabled 不应被 Provider 停用连带改动')
    assertEqual(found?.providerEnabled, false, '管理投影应如实反映 Provider 已停用')

    // 恢复，别影响后面的用例
    await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: adminCookie,
      payload: { enabled: true },
    })
    assert((await availableIds(memberCookie, 'CHAT')).includes(chatModel.id), 'Provider 恢复后模型应回来')
  })

  // ══════════ 5. 两套投影的键集合（响应层自检） ══════════
  await it('两套投影的键集合互不串味：可选项里不含 enabled/agentCount/时间戳（响应层自检）', async () => {
    const response = await api('GET', '/api/models/available?type=CHAT', { cookie: memberCookie })
    const items = response.json().data.items
    const mine = items.find((item) => item.id === chatModel.id)
    assert(mine !== undefined, '可选列表里应能找到该模型')
    for (const forbidden of ['enabled', 'agentCount', 'createdAt', 'updatedAt']) {
      assert(!(forbidden in mine), `可选投影不得含 ${forbidden}，实际键：${Object.keys(mine).join(',')}`)
    }
    // 键级自检：整个可选列表响应里都不该冒出管理字段
    assert(
      response.body.includes('agentCount') === false,
      '可选列表响应体里不应出现 agentCount',
    )
    // 管理投影反过来要有这些
    const managed = (await manageItems(adminCookie)).find((item) => item.id === chatModel.id)
    for (const required of ['agentCount', 'providerEnabled', 'createdAt', 'updatedAt']) {
      assert(required in managed, `管理投影应含 ${required}`)
    }
    assertEqual(modelOptionSchema.safeParse(mine).success, true, '单项也符合 modelOptionSchema')
  })

  // ══════════ 6. 六条守卫 ══════════
  await it('守卫①：建到不存在的 Provider → 404（而不是撞外键抛 500）', async () => {
    const response = await api('POST', '/api/models', {
      cookie: adminCookie,
      payload: {
        // 合法 UUID 但库里没有（uuid7 形态，保证过 schema 校验后落到服务层）
        providerId: '01a0c289-6738-715c-a10c-ef95c1280000',
        modelName: `ghost-${suffix}`,
        label: '孤儿模型',
        type: 'CHAT',
      },
    })
    assertEqual(response.statusCode, 404, '状态码')
    assertEqual(response.json().code, 'NOT_FOUND', '信封 code')
    assert(response.json().msg.includes('Provider'), `文案应提到 Provider，实际：${response.json().msg}`)
  })

  await it('守卫②：同 Provider 下重复的「型号名 + 类型」→ 409（先查给文案，不撞 P2002）', async () => {
    const response = await api('POST', '/api/models', {
      cookie: adminCookie,
      payload: {
        providerId: provider.id,
        modelName: chatModel.modelName, // 与已存在的 chat 模型同名同类型
        label: '冒名顶替',
        type: 'CHAT',
      },
    })
    assertEqual(response.statusCode, 409, '状态码')
    assertEqual(response.json().code, 'CONFLICT', '信封 code')
    assert(
      response.json().msg.includes(chatModel.modelName),
      `文案应点出是哪个型号，实际：${response.json().msg}`,
    )

    // 同一个型号名换成 EMBEDDING 类型**应当放行**（`schema.prisma` 的注释：
    // bge 系列兼容端点会既提供 chat 又提供 embedding，这是合法配置而不是重复）
    const sameNameOtherType = await api('POST', '/api/models', {
      cookie: adminCookie,
      payload: {
        providerId: provider.id,
        modelName: chatModel.modelName,
        label: '同名但向量',
        type: 'EMBEDDING',
      },
    })
    assertEqual(sameNameOtherType.statusCode, 200, '同名不同 type 应放行（唯一键含 type）')
    createdModelIds.push(sameNameOtherType.json().data.id)
  })

  await it('守卫③：改 `providerId` → 409（同值放行）；非法 UUID → 400', async () => {
    const moved = await api('PATCH', `/api/models/${chatModel.id}`, {
      cookie: adminCookie,
      payload: { providerId: emptyProvider.id },
    })
    assertEqual(moved.statusCode, 409, '迁移到别的 Provider 状态码')
    assertEqual(moved.json().code, 'CONFLICT', '信封 code')
    assert(moved.json().msg.includes('不能迁移'), `文案应说清不能迁移，实际：${moved.json().msg}`)

    // 同值放行（幂等）：前端整表单提交时"没改"不该失败
    const sameValue = await api('PATCH', `/api/models/${chatModel.id}`, {
      cookie: adminCookie,
      payload: { providerId: provider.id },
    })
    assertEqual(sameValue.statusCode, 200, '同值 providerId 应放行')

    const badUuid = await api('PATCH', '/api/models/not-a-uuid', {
      cookie: adminCookie,
      payload: { label: 'x' },
    })
    assertEqual(badUuid.statusCode, 400, '非法 UUID 状态码')
    assertEqual(badUuid.json().code, 'VALIDATION', '非法 UUID 信封 code')

    // 库里的 providerId 一个都没变过
    const row = await prisma.model.findUnique({ where: { id: chatModel.id }, select: { providerId: true } })
    assertEqual(row?.providerId, provider.id, 'providerId 必须原封不动')
  })

  await it('守卫④：唯一冲突（改名撞已有型号）→ 409，且**原值未被改动**', async () => {
    const before = await prisma.model.findUnique({ where: { id: embeddingModel.id } })
    // 把向量模型改成「chat 模型的名字 + CHAT 类型」→ 与已存在的那条撞唯一键
    const response = await api('PATCH', `/api/models/${embeddingModel.id}`, {
      cookie: adminCookie,
      payload: { modelName: chatModel.modelName, type: 'CHAT' },
    })
    assertEqual(response.statusCode, 409, '状态码')
    assertEqual(response.json().code, 'CONFLICT', '信封 code')
    // 失败不能有副作用：库里原值逐字不变
    const after = await prisma.model.findUnique({ where: { id: embeddingModel.id } })
    assertEqual(after?.modelName, before?.modelName, '冲突失败后 modelName 不得被动过')
    assertEqual(after?.type, before?.type, '冲突失败后 type 不得被动过')
  })

  let agent
  await it('建一个 Agent 引用该模型（为后两条守卫造前置），并核对 agentCount 与软删口径', async () => {
    agent = await prisma.agent.create({
      data: {
        name: `模型验证 Agent ${suffix}`,
        type: AgentType.CHATBOT,
        modelId: chatModel.id,
        createdBy: admin.id,
      },
    })
    createdAgentIds.push(agent.id)

    const managed = (await manageItems(adminCookie)).find((item) => item.id === chatModel.id)
    assertEqual(managed?.agentCount, 1, 'agentCount 应计到 1')

    // ⚠️ 软删的 Agent 也占着 `ON DELETE RESTRICT` 的外键 —— 计数刻意**不**按 deletedAt 过滤，
    //    否则会出现"界面说能删、删下去 500"（P0-1-10 同款结论）
    await prisma.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } })
    const afterSoftDelete = (await manageItems(adminCookie)).find((item) => item.id === chatModel.id)
    assertEqual(afterSoftDelete?.agentCount, 1, '软删的 Agent 仍应计入 agentCount（与删除守卫同口径）')
  })

  await it('守卫⑤：改 `type` 时该模型被 Agent 引用 → 409（同值放行）', async () => {
    const response = await api('PATCH', `/api/models/${chatModel.id}`, {
      cookie: adminCookie,
      payload: { type: 'EMBEDDING' },
    })
    assertEqual(response.statusCode, 409, '状态码')
    assertEqual(response.json().code, 'CONFLICT', '信封 code')
    assert(
      /被 \d+ 个 Agent 使用/.test(response.json().msg),
      `文案应给出引用数，实际：${response.json().msg}`,
    )

    // 同值放行：`type` 没变不算"改类型"
    const sameValue = await api('PATCH', `/api/models/${chatModel.id}`, {
      cookie: adminCookie,
      payload: { type: 'CHAT' },
    })
    assertEqual(sameValue.statusCode, 200, '同值 type 应放行')

    // 库里确实是 CHAT（没被写坏）
    const row = await prisma.model.findUnique({ where: { id: chatModel.id }, select: { type: true } })
    assertEqual(row?.type, 'CHAT', 'type 必须原封不动')
  })

  await it('守卫⑥：删被 Agent 引用的模型 → 409（**软删的 Agent 也算**）；无引用的 → 200 且行消失', async () => {
    const referenced = await api('DELETE', `/api/models/${chatModel.id}`, { cookie: adminCookie })
    assertEqual(referenced.statusCode, 409, '有引用的状态码')
    assertEqual(referenced.json().code, 'CONFLICT', '信封 code')
    assert(
      referenced.json().msg.includes('无法删除'),
      `文案应说清无法删除，实际：${referenced.json().msg}`,
    )
    // 依然在库里（409 不能有副作用）
    assert(
      (await prisma.model.findUnique({ where: { id: chatModel.id } })) !== null,
      '409 后模型不应被删掉',
    )

    // 真删掉 Agent 后就能删了
    await prisma.agent.delete({ where: { id: agent.id } })
    createdAgentIds.splice(createdAgentIds.indexOf(agent.id), 1)
    const removed = await api('DELETE', `/api/models/${chatModel.id}`, { cookie: adminCookie })
    assertEqual(removed.statusCode, 200, '无引用后状态码')
    assertEqual(removed.json().data.id, chatModel.id, '删除响应应回 id')
    assertEqual(await prisma.model.findUnique({ where: { id: chatModel.id } }), null, '库里应已消失')

    const again = await api('DELETE', `/api/models/${chatModel.id}`, { cookie: adminCookie })
    assertEqual(again.statusCode, 404, '重复删除应 404')
  })

  // ══════════ 7. maxContext 三态 + 管理列表的过滤与分页 ══════════
  await it('`maxContext` 三态：缺席=不动（值**逐字不变**）/ `null`=清空 / 数字=设置', async () => {
    const before = await prisma.model.findUnique({ where: { id: embeddingModel.id } })
    assertEqual(before?.maxContext, null, '前置：该模型 maxContext 是 null')

    // 设置
    const set = await api('PATCH', `/api/models/${embeddingModel.id}`, {
      cookie: adminCookie,
      payload: { maxContext: 8192 },
    })
    assertEqual(set.statusCode, 200, '设置 maxContext 状态码')
    assertEqual(set.json().data.maxContext, 8192, '设置后的值')

    // 只改别名：maxContext **必须原封不动**（这是三态最容易写错的地方）
    const renamed = await api('PATCH', `/api/models/${embeddingModel.id}`, {
      cookie: adminCookie,
      payload: { label: '改个名而已' },
    })
    assertEqual(renamed.statusCode, 200, '改别名状态码')
    assertEqual(renamed.json().data.label, '改个名而已', 'label 应改掉')
    assertEqual(renamed.json().data.maxContext, 8192, '只改别名时 maxContext 不得被抹掉')
    const afterRename = await prisma.model.findUnique({ where: { id: embeddingModel.id } })
    assertEqual(afterRename?.maxContext, 8192, '库里 maxContext 也不得被动过')
    assertEqual(afterRename?.modelName, before?.modelName, 'modelName 不得被动过')
    assertEqual(afterRename?.supportsVision, before?.supportsVision, 'supportsVision 不得被动过')

    // 清空
    const cleared = await api('PATCH', `/api/models/${embeddingModel.id}`, {
      cookie: adminCookie,
      payload: { maxContext: null },
    })
    assertEqual(cleared.statusCode, 200, '清空状态码')
    assertEqual(cleared.json().data.maxContext, null, '清空后的值')
    const afterClear = await prisma.model.findUnique({ where: { id: embeddingModel.id } })
    assertEqual(afterClear?.maxContext, null, '库里应被清空')
  })

  await it('管理列表的过滤（type / providerId / enabled）与分页形态', async () => {
    const byProvider = await api('GET', `/api/models?providerId=${emptyProvider.id}&limit=100`, {
      cookie: adminCookie,
    })
    assertEqual(byProvider.statusCode, 200, '状态码')
    assertEqual(byProvider.json().data.total, 0, '空 Provider 下应无模型')
    assertEqual(byProvider.json().data.items.length, 0, 'items 也应为空')

    const enabledOnly = await api('GET', '/api/models?enabled=true&limit=100', { cookie: adminCookie })
    assertEqual(enabledOnly.statusCode, 200, '状态码')
    assert(
      enabledOnly.json().data.items.every((item) => item.enabled === true),
      '?enabled=true 的每一项都应启用',
    )
    const disabledOnly = await api('GET', '/api/models?enabled=false&limit=100', { cookie: adminCookie })
    assert(
      disabledOnly.json().data.items.every((item) => item.enabled === false),
      '?enabled=false 的每一项都应停用',
    )

    // 分页形态：total 与当页来自同一快照，且 offset 真的生效
    const firstPage = await api('GET', '/api/models?limit=1&offset=0', { cookie: adminCookie })
    const secondPage = await api('GET', '/api/models?limit=1&offset=1', { cookie: adminCookie })
    assertEqual(firstPage.json().data.limit, 1, 'limit 回显')
    assertEqual(firstPage.json().data.offset, 0, 'offset 回显')
    assertEqual(secondPage.json().data.offset, 1, 'offset 回显')
    assertEqual(
      firstPage.json().data.total,
      secondPage.json().data.total,
      '两次分页的 total 应一致',
    )
    if (firstPage.json().data.total > 1) {
      assert(
        firstPage.json().data.items[0]?.id !== secondPage.json().data.items[0]?.id,
        '两页不应给出同一条（排序必须稳定）',
      )
    }
  })

  await it('`available` 的排序稳定：同一请求重复两次结果**逐字相同**（前端下拉不该自己抖）', async () => {
    const first = await api('GET', '/api/models/available?type=CHAT', { cookie: memberCookie })
    const second = await api('GET', '/api/models/available?type=CHAT', { cookie: memberCookie })
    assertEqual(first.body, second.body, '两次请求的可选列表应逐字相同')
  })
} finally {
  // ── 清理（顺序是硬要求：Agent 先于 Model，Model 先于 Provider）──
  // 一律用 `deleteMany` 而不是 `delete`：清理阶段"目标已经不在了"是正常情况
  // （用例自己删过的记录也在清单里），`delete` 会为每一条不存在的记录往日志里丢一坨
  // `P2025` 堆栈 —— 那会把断言结果冲掉（`06` P0-1-6 起的"收敛脚本自身日志"纪律）。
  try {
    const removeAgents = async () => {
      await prisma.agent.deleteMany({
        where: { OR: [{ name: { contains: suffix } }, { id: { in: createdAgentIds } }] },
      })
    }
    await removeAgents()
    await prisma.model.deleteMany({ where: { id: { in: createdModelIds } } })
    // 兜底：按前缀扫一遍（含脚本中途失败留下的）
    const leftoverModels = await prisma.model.findMany({
      where: { modelName: { contains: suffix } },
      select: { id: true },
    })
    for (const row of leftoverModels) {
      await prisma.agent.deleteMany({ where: { modelId: row.id } }).catch(() => undefined)
    }
    await prisma.model.deleteMany({ where: { modelName: { contains: suffix } } })
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdProviderIds } } })
    await prisma.modelProvider.deleteMany({ where: { name: { contains: suffix } } })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s），
      //    运行中"顺手"建了几个，不删就要等窗口过去才算干净（`06` P0-1-7 坑 5 的教训）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) {
      await redis.del(sessionKey(sid)).catch(() => undefined)
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
  console.log(`${c.g}${c.b}✅ P0-1-11 模型管理验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-11 模型管理验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
