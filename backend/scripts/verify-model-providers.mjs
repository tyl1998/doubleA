#!/usr/bin/env node
/**
 * verify-model-providers.mjs —— P0-1-10 的**模型池 Provider 验收**（需要真实 Redis + PG）
 *
 * 验的是 `02` §4.3 四个端点（`(A)` 仅 ADMIN），`01` §3.2 需求 1 的验收要点只有一句
 * 「**Key 不回显明文**」—— 本脚本把这句话拆成可执行的三层取证：
 *
 *   ① **响应层**：建/查/改的响应体里**逐字**搜不到明文 Key，也没有任何 `*enc*` 字段
 *      （字符串级 + 键级双重检查，避免"字段改名就绕过"）；
 *   ② **存储层**：直接查库，`api_key_enc` 是 `v1.<iv>.<tag>.<ct>` 形态的密文，
 *      **不等于明文**，且能用 AAD `model-providers:{id}.api_key_enc` 解回明文
 *      —— 解不回来就说明"存进去的其实不是密文"或"AAD 绑错了"；
 *   ③ **绑定层**：拿**另一个** Provider 的 AAD 去解同一段密文必须失败
 *      （密文被搬走就作废，`06` P0-1-10 落地要点）。
 *
 * 另外三条是本批的**契约行为**，也都真跑：
 *   · **PATCH 的三态**：不传 `apiKey` → 密文**逐字不变**（不是"重新加密了一遍"）；
 *     传 `null` → 清空；传新值 → 换成新密文。
 *   · **改 type 的守卫**：Provider 下已有模型时改 type → 409（否则留下"CHAT 的 Provider
 *     挂着 EMBEDDING 的模型"这种自相矛盾的数据）。
 *   · **删除的守卫**：`agents.model_id` 是 `ON DELETE RESTRICT`，有模型被 Agent 引用时
 *     删 Provider 必须 409 而不是撞外键抛 500（`02` §三 删除语义）。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`
 * 脚本自造带随机后缀的临时数据（操作者 + Provider + Model + Agent），结束时删净。
 * 注意清理顺序：Agent 必须先于 Model 删（RESTRICT），Provider 的删除会级联掉它下面的 Model。
 */

// 必须在 import `config.js`（经 dist 的 app.js）之前设置：脚本会打一堆"应当失败"的请求
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

const { buildApp } = await import('../dist/backend/src/app.js')
const { decryptSecret, hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma, ModelType, UserRole, UserStatus, AgentType } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { providerKeyAad } = await import('../dist/backend/src/services/model.service.js')
const { maskApiKey, modelProviderListResultSchema } = await import('@doubulea/shared')

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
const PASSWORD = 'Verify-Providers-Passw0rd'
/** 明文 Key：形态像真的（这样掩码才走"前3+****+后4"那条分支），但显然是测试值 */
const PLAIN_KEY = 'sk-verify-only-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ROTATED_KEY = 'sk-rotated-only-ZYXWVUTSRQPONMLKJIHGFEDCBA'
/**
 * 响应体里**永远**不该出现的东西（字符串级检查）。
 * 含明文 Key、密文字段名、密文前缀 —— 三者任一出现都算泄露了"存了什么/怎么存的"。
 */
const LEAK_TRACES = [PLAIN_KEY, ROTATED_KEY, 'apiKeyEnc', 'api_key_enc', 'v1.']

const suffix = Math.random().toString(36).slice(2, 8)
const operatorUsername = `verify-providers-op-${suffix}`

const sessionIds = []
const createdProviderIds = []
const createdModelIds = []
const createdAgentIds = []
const createdUserIds = []

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

/** 断言响应体里不含任何"钥匙痕迹"（字符串级，避免字段改名绕过） */
function assertNoKeyTraces(raw, label) {
  for (const trace of LEAK_TRACES) {
    assert(raw.includes(trace) === false, `${label} 响应体里出现了 ${JSON.stringify(trace)}`)
  }
}

/** 直接读库里的密文（**只有本脚本会用**，产品代码里读它的地方是 service 的 toItem 与将来的 LLM client） */
async function readCipher(providerId) {
  const row = await prisma.modelProvider.findUnique({
    where: { id: providerId },
    select: { apiKeyEnc: true },
  })
  return row?.apiKeyEnc ?? null
}

/** 密文形态：`v1.<iv>.<tag>.<ct>`（与 `crypto.ts` 的版本化信封一致） */
function looksLikeCipher(value) {
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === 'v1' && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-10 模型池 Provider 验收：Key 加密 / 读脱敏 / 三态 / 删除与改类型守卫 ══${c.x}`)

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
  const createUser = (username, data) =>
    prisma.user.create({ data: { username, passwordHash, ...data } })

  /** 操作者：ADMIN 且非首登态（首登态会被闸门拦，测不到 Provider 本身） */
  const operator = await createUser(operatorUsername, {
    nickname: '模型池验证操作者',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const member = await createUser(`${operatorUsername}-member`, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(operator.id, member.id)

  const login = async (username) => {
    const response = await api('POST', '/api/auth/login', {
      payload: { username, password: PASSWORD },
    })
    return { response, cookie: cookieOf(response) }
  }

  const operatorCookie = (await login(operatorUsername)).cookie
  const memberCookie = (await login(`${operatorUsername}-member`)).cookie
  console.log(`  ${c.d}临时操作者：${operatorUsername}（ADMIN）+ 同名 MEMBER${c.x}`)

  // ── 1. 权限（`(A)` 仅 ADMIN）──
  await it('无会话 401；MEMBER 403；ADMIN 列表 200 且符合分页形态（验收：仅 ADMIN）', async () => {
    const anonymous = await api('GET', '/api/model-providers')
    assertEqual(anonymous.statusCode, 401, '匿名状态码')
    assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名信封 code')

    const asMember = await api('GET', '/api/model-providers', { cookie: memberCookie })
    assertEqual(asMember.statusCode, 403, 'MEMBER 状态码')
    assertEqual(asMember.json().code, 'FORBIDDEN', 'MEMBER 信封 code')

    const asAdmin = await api('GET', '/api/model-providers?limit=100', { cookie: operatorCookie })
    assertEqual(asAdmin.statusCode, 200, 'ADMIN 状态码')
    const parsed = modelProviderListResultSchema.safeParse(asAdmin.json().data)
    assert(parsed.success, `列表不符合 modelProviderListResultSchema：${JSON.stringify(parsed.error?.issues)}`)
    assertNoKeyTraces(asAdmin.body, '列表')
  })

  // ── 2. 建（带 Key）：响应脱敏 + 落库为密文 ──
  let provider
  await it('建 Provider（带 Key）→ 200，响应里 hasKey/preview 齐备且**逐字搜不到明文 Key**（验收①）', async () => {
    const response = await api('POST', '/api/model-providers', {
      cookie: operatorCookie,
      payload: {
        name: `验证用 Provider ${suffix}`,
        // 故意带尾斜杠：契约要求归一化掉（否则将来拼 /chat/completions 会出现 //）
        baseUrl: 'https://api.example.com/v1///',
        type: 'CHAT',
        apiKey: PLAIN_KEY,
      },
    })
    assertEqual(response.statusCode, 200, '状态码')
    const data = response.json().data
    provider = data
    createdProviderIds.push(data.id)

    assertEqual(data.baseUrl, 'https://api.example.com/v1', 'baseUrl 尾部斜杠应被归一化掉')
    assertEqual(data.type, 'CHAT', 'type')
    assertEqual(data.enabled, true, 'enabled 缺省应为 true')
    assertEqual(data.hasKey, true, 'hasKey')
    assertEqual(data.apiKeyPreview, maskApiKey(PLAIN_KEY), 'apiKeyPreview 应等于 maskApiKey(明文)')
    assertEqual(data.modelCount, 0, '新 Provider 的 modelCount')
    assert(typeof data.createdAt === 'string' && data.createdAt.includes('T'), 'createdAt 应为 ISO 串')

    // 键级：响应体里不能有 apiKey / apiKeyEnc 这类字段
    assert('apiKey' in data === false, '响应里不应有 apiKey 字段')
    // 字符串级：明文与密文前缀都不该出现
    assertNoKeyTraces(response.body, '建 Provider')
    console.log(`         ${c.d}preview=${data.apiKeyPreview}（明文长度 ${PLAIN_KEY.length}）${c.x}`)
  })

  await it('**数据库里是密文**：形态 v1.<iv>.<tag>.<ct>、不等于明文、且能用 AAD 解回原文（验收②）', async () => {
    const cipher = await readCipher(provider.id)
    assert(cipher !== null, 'api_key_enc 不应为 null')
    assert(looksLikeCipher(cipher), `api_key_enc 应是 v1.<iv>.<tag>.<ct> 形态，实际 ${cipher?.slice(0, 24)}…`)
    assert(cipher !== PLAIN_KEY, 'api_key_enc 竟然等于明文')
    assert(cipher.includes(PLAIN_KEY) === false, '密文里不应含明文')
    assertEqual(decryptSecret(cipher, providerKeyAad(provider.id)), PLAIN_KEY, '用正确 AAD 应能解回明文')
    console.log(`         ${c.d}库中密文：${cipher.slice(0, 18)}…（${cipher.length} 字符）${c.x}`)
  })

  await it('密文**绑定到记录**：换个 Provider 的 AAD 解不开（密文不能跨记录搬运）（验收②③）', async () => {
    const cipher = await readCipher(provider.id)
    let threw = false
    try {
      // 换一个真实存在的另一个 id（用操作者的 id 也行，只要是"别的归属"）
      decryptSecret(cipher, providerKeyAad(operator.id))
    } catch {
      threw = true
    }
    assert(threw, '换了 AAD 竟然解开了 —— 说明加密时没有绑定 id')

    // 反向：把密文真的粘到另一条记录上，再按"那条记录"的规则去解 → 必须失败
    const other = await prisma.modelProvider.create({
      data: {
        name: `被粘密文的 Provider ${suffix}`,
        baseUrl: 'https://api.example.com/v1',
        type: ModelType.CHAT,
        apiKeyEnc: cipher,
      },
      select: { id: true },
    })
    createdProviderIds.push(other.id)
    let swapThrew = false
    try {
      decryptSecret(cipher, providerKeyAad(other.id))
    } catch {
      swapThrew = true
    }
    assert(swapThrew, '把 A 的密文粘到 B 上竟然能解开 —— AAD 绑定没生效')
    // 粘过去的密文在 B 的读接口上表现为"解不开但 hasKey 仍为 true"（降级为 **** 而不是 500）
    const list = await api('GET', '/api/model-providers?limit=100', { cookie: operatorCookie })
    const swapped = list.json().data.items.find((item) => item.id === other.id)
    assertEqual(swapped.hasKey, true, '粘过去的密文 hasKey 仍应为 true')
    assertEqual(swapped.apiKeyPreview, '****', '解不开时应降级为 ****（而不是抛错让列表 500）')
  })

  // ── 3. 读接口脱敏 ──
  await it('列表 / 单条读接口都不含明文与密文（读脱敏，`02` §十 不变式）', async () => {
    const cipherBefore = await readCipher(provider.id)
    const list = await api('GET', '/api/model-providers?limit=100', { cookie: operatorCookie })
    assertEqual(list.statusCode, 200, '列表状态码')
    const item = list.json().data.items.find((row) => row.id === provider.id)
    assert(item !== undefined, '列表里应能找到刚建的 Provider')
    assertEqual(item.apiKeyPreview, maskApiKey(PLAIN_KEY), '列表里的 preview')
    assertEqual(item.hasKey, true, '列表里的 hasKey')
    assert('apiKey' in item === false, '列表项不应有 apiKey 字段')
    assert('apiKeyEnc' in item === false, '列表项不应有 apiKeyEnc 字段')
    assertNoKeyTraces(list.body, '列表')

    // 幂等：反复读，preview 恒定、密文未被读路径改写（读接口不该有副作用）
    const again = await api('GET', '/api/model-providers?limit=100', { cookie: operatorCookie })
    assertEqual(
      again.json().data.items.find((row) => row.id === provider.id).apiKeyPreview,
      maskApiKey(PLAIN_KEY),
      '重复读取的 preview 应恒定',
    )
    assertEqual(await readCipher(provider.id), cipherBefore, '读接口不得改写密文')
  })

  // ── 4. PATCH 三态（本批最要紧的行为）──
  await it('PATCH **不传 apiKey** → 原 Key 逐字不变（密文完全相同，不是"重新加密了一遍"）（坑预判）', async () => {
    const before = await readCipher(provider.id)
    const response = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { name: `改名后 ${suffix}`, enabled: false },
    })
    assertEqual(response.statusCode, 200, '状态码')
    const data = response.json().data
    assertEqual(data.name, `改名后 ${suffix}`, 'name 应已改')
    assertEqual(data.enabled, false, 'enabled 应已改')
    assertEqual(data.hasKey, true, 'Key 仍应在（没被顺手清掉）')
    assertEqual(data.apiKeyPreview, maskApiKey(PLAIN_KEY), 'preview 不变')

    const after = await readCipher(provider.id)
    // ⭐ 最强的证据：密文**逐字相同**。若实现里"每次都重新加密"，这里会因为新 IV 而不同
    assertEqual(after, before, '密文必须逐字不变（否则说明 PATCH 悄悄重写了 Key）')
    assertNoKeyTraces(response.body, 'PATCH 改名')
  })

  await it('PATCH `apiKey` 传新值 → 换成新密文，能解出新值且与旧密文不同', async () => {
    const before = await readCipher(provider.id)
    const response = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { apiKey: ROTATED_KEY },
    })
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(response.json().data.apiKeyPreview, maskApiKey(ROTATED_KEY), 'preview 应换成新 Key 的')

    const after = await readCipher(provider.id)
    assert(after !== before, '换了 Key，密文必须变')
    assertEqual(decryptSecret(after, providerKeyAad(provider.id)), ROTATED_KEY, '应能解出新 Key')
    assertNoKeyTraces(response.body, 'PATCH 换 Key')
  })

  await it('PATCH `apiKey: null` → 清空（hasKey=false / preview=null / 库里为 NULL）', async () => {
    const response = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { apiKey: null },
    })
    assertEqual(response.statusCode, 200, '状态码')
    const data = response.json().data
    assertEqual(data.hasKey, false, 'hasKey 应为 false')
    assertEqual(data.apiKeyPreview, null, 'apiKeyPreview 应为 null')
    assertEqual(await readCipher(provider.id), null, '库里 api_key_enc 应为 NULL')
  })

  await it('PATCH 参数校验：空 body 400、`apiKey: ""` 400（要清空请传 null）', async () => {
    const empty = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: {},
    })
    assertEqual(empty.statusCode, 400, '空 body 状态码')

    const blank = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { apiKey: '' },
    })
    assertEqual(blank.statusCode, 400, 'apiKey 空串状态码')
    const fields = blank.json().data.fields ?? []
    assert(fields.some((field) => field.path === 'body.apiKey'), `应报 body.apiKey，实际 ${JSON.stringify(fields)}`)
    assert(
      fields.some((field) => String(field.message).includes('null')),
      '文案应告诉调用方"要清空请传 null"',
    )
  })

  await it('建/改的其它校验：非法 baseUrl / 非 http(s) / 未知 type / 空 name → 400 + 字段明细', async () => {
    const cases = [
      ['非法 URL', { name: 'x', baseUrl: 'not-a-url', type: 'CHAT' }],
      ['非 http(s)', { name: 'x', baseUrl: 'ftp://a.com', type: 'CHAT' }],
      ['只有 scheme', { name: 'x', baseUrl: 'https://', type: 'CHAT' }],
      ['未知 type', { name: 'x', baseUrl: 'https://a.com', type: 'RERANK' }],
      ['空 name', { name: '   ', baseUrl: 'https://a.com', type: 'CHAT' }],
    ]
    for (const [label, payload] of cases) {
      const response = await api('POST', '/api/model-providers', { cookie: operatorCookie, payload })
      assertEqual(response.statusCode, 400, `${label} 状态码`)
      const fields = response.json().data.fields
      assert(Array.isArray(fields) && fields.length > 0, `${label} 应给出字段明细`)
    }
  })

  await it('不存在的 id：PATCH / DELETE → 404 / NOT_FOUND；非法 uuid → 400', async () => {
    const missingId = '00000000-0000-7000-8000-000000000000'
    const patchMissing = await api('PATCH', `/api/model-providers/${missingId}`, {
      cookie: operatorCookie,
      payload: { name: 'x' },
    })
    assertEqual(patchMissing.statusCode, 404, 'PATCH 不存在状态码')
    assertEqual(patchMissing.json().code, 'NOT_FOUND', '信封 code')

    const deleteMissing = await api('DELETE', `/api/model-providers/${missingId}`, { cookie: operatorCookie })
    assertEqual(deleteMissing.statusCode, 404, 'DELETE 不存在状态码')

    const badUuid = await api('DELETE', '/api/model-providers/not-a-uuid', { cookie: operatorCookie })
    assertEqual(badUuid.statusCode, 400, '非法 uuid 状态码')
    assert(
      badUuid.json().data.fields.some((field) => field.path === 'params.id'),
      '应报 params.id',
    )
  })

  // ── 5. 改 type 的守卫（需要模型才能触发）──
  let modelId
  await it('改 type 守卫：Provider 下**有模型**时改 type → 409（防"CHAT 的 Provider 挂 EMBEDDING 模型"）', async () => {
    // 直接造一个模型（模型管理是 P0-1-11 的产出，本批只需要它存在）
    const model = await prisma.model.create({
      data: {
        providerId: provider.id,
        modelName: `gpt-verify-${suffix}`,
        label: '验证模型',
        type: ModelType.CHAT,
      },
      select: { id: true },
    })
    modelId = model.id
    createdModelIds.push(model.id)

    const blocked = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { type: 'EMBEDDING' },
    })
    assertEqual(blocked.statusCode, 409, '有模型时改 type 状态码')
    assertEqual(blocked.json().code, 'CONFLICT', '信封 code')
    assert(blocked.json().msg.includes('模型'), `文案应点明原因，实际：${blocked.json().msg}`)
    // 库里类型必须没变
    const row = await prisma.modelProvider.findUnique({
      where: { id: provider.id },
      select: { type: true },
    })
    assertEqual(row.type, 'CHAT', '被拒后 type 不得变化')

    // 同值 PATCH 不算"改类型"，应当放行（否则前端保存表单时会莫名 409）
    const sameType = await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { type: 'CHAT' },
    })
    assertEqual(sameType.statusCode, 200, '同值 type 应放行')

    // 无模型的 Provider 改 type 正常
    const noModel = await api('POST', '/api/model-providers', {
      cookie: operatorCookie,
      payload: { name: `无模型 ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
    })
    const noModelId = noModel.json().data.id
    createdProviderIds.push(noModelId)
    const changed = await api('PATCH', `/api/model-providers/${noModelId}`, {
      cookie: operatorCookie,
      payload: { type: 'EMBEDDING' },
    })
    assertEqual(changed.statusCode, 200, '无模型时改 type 状态码')
    assertEqual(changed.json().data.type, 'EMBEDDING', 'type 应已改')
  })

  await it('列表的 modelCount 反映实际挂载数（前端删 Provider 前的提示依据）', async () => {
    const list = await api('GET', '/api/model-providers?limit=100', { cookie: operatorCookie })
    const item = list.json().data.items.find((row) => row.id === provider.id)
    assertEqual(item.modelCount, 1, '应统计到 1 个模型')
  })

  // ── 6. 删除 ──
  await it('删 Provider：无模型 → 200 且库里真的没了', async () => {
    const created = await api('POST', '/api/model-providers', {
      cookie: operatorCookie,
      payload: { name: `待删 ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
    })
    const id = created.json().data.id
    const removed = await api('DELETE', `/api/model-providers/${id}`, { cookie: operatorCookie })
    assertEqual(removed.statusCode, 200, '状态码')
    assertEqual(removed.json().data.id, id, '应回传被删的 id')
    assertEqual(await prisma.modelProvider.count({ where: { id } }), 0, '库里应已删除')
  })

  await it('删 Provider：有模型但**无 Agent 引用** → 200 且模型被级联删除（`models.provider_id` CASCADE）', async () => {
    const created = await api('POST', '/api/model-providers', {
      cookie: operatorCookie,
      payload: { name: `带模型待删 ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
    })
    const id = created.json().data.id
    const model = await prisma.model.create({
      data: { providerId: id, modelName: `m-${suffix}`, label: '级联验证模型', type: ModelType.CHAT },
      select: { id: true },
    })

    const removed = await api('DELETE', `/api/model-providers/${id}`, { cookie: operatorCookie })
    assertEqual(removed.statusCode, 200, '状态码')
    assertEqual(await prisma.modelProvider.count({ where: { id } }), 0, 'Provider 应已删除')
    assertEqual(await prisma.model.count({ where: { id: model.id } }), 0, '其下模型应被级联删除')
  })

  await it('删 Provider：有模型**被 Agent 引用** → 409（而不是撞外键抛 500，`02` §三 RESTRICT）', async () => {
    // 造一个 Agent 绑住上面那个模型（Agent 是 P0-1-14 的产出，这里只需要它存在于外键上）
    const agent = await prisma.agent.create({
      data: {
        name: `验证 Agent ${suffix}`,
        type: AgentType.CHATBOT,
        modelId,
        createdBy: operator.id,
      },
      select: { id: true },
    })
    createdAgentIds.push(agent.id)

    const blocked = await api('DELETE', `/api/model-providers/${provider.id}`, { cookie: operatorCookie })
    assertEqual(blocked.statusCode, 409, '状态码')
    assertEqual(blocked.json().code, 'CONFLICT', '信封 code')
    assert(blocked.json().msg.includes('Agent'), `文案应点明被谁引用，实际：${blocked.json().msg}`)
    // Provider 与模型都必须还在
    assertEqual(await prisma.modelProvider.count({ where: { id: provider.id } }), 1, 'Provider 不得被删')
    assertEqual(await prisma.model.count({ where: { id: modelId } }), 1, '模型不得被删')
  })

  await it('解开 Agent 绑定后即可删除；且删 Provider 会**顺带清掉它的密文**（不残留可解凭据）', async () => {
    // 先把 Key 配回去，验证"删 Provider 时密文一起没了"
    await api('PATCH', `/api/model-providers/${provider.id}`, {
      cookie: operatorCookie,
      payload: { apiKey: PLAIN_KEY },
    })
    const cipher = await readCipher(provider.id)
    assert(cipher !== null, '前置：应有密文')

    // 软删 Agent 也仍然占着外键（agents.deleted_at 不解除 FK）→ 必须硬删才能删 Provider
    await prisma.agent.delete({ where: { id: createdAgentIds.pop() } })

    const removed = await api('DELETE', `/api/model-providers/${provider.id}`, { cookie: operatorCookie })
    assertEqual(removed.statusCode, 200, '状态码')
    assertEqual(await prisma.modelProvider.count({ where: { id: provider.id } }), 0, 'Provider 行应已删除')
    assertEqual(await readCipher(provider.id), null, '密文随之不存在')
    assertEqual(await prisma.model.count({ where: { providerId: provider.id } }), 0, '其下模型应级联删除')
  })

  await it('删除后再读列表：被删的 Provider 不再出现，且响应体依旧零钥匙痕迹', async () => {
    const list = await api('GET', '/api/model-providers?limit=100', { cookie: operatorCookie })
    assertEqual(list.statusCode, 200, '状态码')
    assert(
      list.json().data.items.every((item) => item.id !== provider.id),
      '被删的 Provider 不应再出现',
    )
    assertNoKeyTraces(list.body, '删除后的列表')
  })
} finally {
  // ── 清理（顺序是硬要求）──
  // Agent 必须先于 Model 消失（`agents.model_id` 是 RESTRICT），Provider 的删除会级联掉它的 Model。
  // 所以：① 删 Agent → ② 删 Provider（连带 Model）→ ③ 兜底删漏下的 Model → ④ 再删一遍 Provider
  //（② 若因并发/残留 Agent 失败，④ 能补上）→ ⑤ 删 User → ⑥ 清会话键。
  const removeAgents = async () => {
    const rows = await prisma.agent.findMany({
      where: { OR: [{ name: { contains: suffix } }, { id: { in: createdAgentIds } }] },
      select: { id: true },
    })
    for (const row of rows) {
      await prisma.agent.delete({ where: { id: row.id } }).catch(() => undefined)
    }
  }
  const removeProviders = async () => {
    const rows = await prisma.modelProvider.findMany({
      where: { OR: [{ name: { contains: suffix } }, { id: { in: createdProviderIds } }] },
      select: { id: true },
    })
    for (const row of rows) {
      await prisma.modelProvider.delete({ where: { id: row.id } }).catch((error) => {
        console.log(
          `  ${c.r}清理 Provider ${row.id} 失败：${error instanceof Error ? error.message : String(error)}${c.x}`,
        )
      })
    }
  }

  try {
    await removeAgents()
    await removeProviders()
    // 兜底：仍挂着的 Model（其 Provider 已不在，或被删失败）
    const leftoverModels = await prisma.model.findMany({
      where: { OR: [{ modelName: { contains: suffix } }, { id: { in: createdModelIds } }] },
      select: { id: true },
    })
    for (const row of leftoverModels) {
      await prisma.agent.deleteMany({ where: { modelId: row.id } }).catch(() => undefined)
      await prisma.model.delete({ where: { id: row.id } }).catch(() => undefined)
    }
    await removeAgents()
    await removeProviders()
    for (const userId of createdUserIds) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
      // ⚠️ 必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}` 快照（TTL 60s），
      //    脚本一跑就"顺手"建了几个，不删就要等窗口过去才算干净 —— 这正是
      //    `06` P0-1-7 坑 5 记下的教训（枚举脚本创建的全部键，含"顺手创建的"）。
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
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
  console.log(`${c.g}${c.b}✅ P0-1-10 模型池 Provider 验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-10 模型池 Provider 验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
