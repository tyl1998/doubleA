#!/usr/bin/env node
/**
 * verify-users.mjs —— P0-1-8 的**用户管理接口验收**（需要真实 Redis + PG）
 *
 * 验的是 `02` §4.2 四个端点（`(A)` 仅 ADMIN）的四件事：
 *   ① **权限**：无会话 401、MEMBER 403、ADMIN 通；
 *   ② **建号**：初始密码**仅此一次明文**返回、建号即"首登必须改密"、重复用户名 409（含大小写变体）；
 *   ③ **启停/改角色**：**立即**生效（端到端取证：停用后该用户手里的会话下一个请求就 401，
 *      改角色后同一个会话立刻拿到新权限）——这条依赖写侧的 `invalidateUserSnapshot`；
 *   ④ **自我保护**：不能停用/降级/重置自己（`06` P0-1-8 坑预判「防 admin 自锁」）。
 *
 * 另有一个容易被漏掉的验收：**列表响应里绝不能出现任何密码痕迹**
 * （`passwordHash` / `initialPassword` / `$2b$`），本脚本对响应体做字符串级检查。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`
 * 脚本自造带随机后缀的临时用户（操作者/被操作者/被锁者 + 一个用 API 建的号），结束时删净。
 */

// 必须在 import `config.js`（经 dist 的 app.js）之前设置：一句话会打一堆"应当失败"的请求
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword, INITIAL_PASSWORD_LENGTH } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma, UserRole, UserStatus } = await import('../dist/backend/src/infra/prisma.js')
const {
  clearLoginFailures,
  closeRedis,
  ensureRedisConnected,
  getRedis,
  invalidateUserSnapshot,
  loginFailKey,
  sessionKey,
} = await import('../dist/backend/src/infra/redis.js')
const { normalizeUsername, userListResultSchema } = await import('@doubulea/shared')

// ───────────────────────────── 断言脚手架（与另三个脚本同一套）─────────────────────────────

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
const PASSWORD = 'Verify-Users-Passw0rd'
/**
 * **任何**响应体里都不该出现的密码痕迹（做字符串级检查，避免"字段改名就绕过"）。
 *
 * 刻意**不含** `initialPassword` 这个**键名**：它在建号/重置密码的响应里本就是该出现的字段，
 * 要拦的是"值"与"哈希"，而不是那个键。列表类响应的断言里会单独要求该键也不出现。
 */
const PASSWORD_TRACES = ['passwordHash', 'password_hash', '$2b$', PASSWORD]

const suffix = Math.random().toString(36).slice(2, 8)
const usernames = {
  operator: `verify-users-op-${suffix}`,
  member: `verify-users-member-${suffix}`,
  lockTarget: `verify-users-lock-${suffix}`,
  apiCreated: `verify-users-created-${suffix}`,
}

const sessionIds = []
const createdUserIds = []

const app = buildApp()

function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const pair = header.split(';')[0] ?? ''
  const eq = pair.indexOf('=')
  const value = pair.slice(eq + 1)
  if (value !== '') sessionIds.push(value)
  return value
}

const cookieHeader = (value) => ({ cookie: `${SESSION_COOKIE_NAME}=${value}` })

/** 发一次请求（`cookie` 为空即匿名） */
function api(method, url, { cookie, payload } = {}) {
  const options = { method, url }
  if (cookie !== undefined && cookie !== '') options.headers = cookieHeader(cookie)
  if (payload !== undefined) options.payload = payload
  return app.inject(options)
}

async function login(username, password) {
  const response = await api('POST', '/api/auth/login', { payload: { username, password } })
  return { response, body: response.json(), cookie: cookieOf(response) }
}

/** 断言响应体里不含任何密码痕迹（做在字符串层，避免"字段改名就绕过"） */
function assertNoPasswordTraces(raw, label) {
  for (const trace of PASSWORD_TRACES) {
    assert(raw.includes(trace) === false, `${label} 的响应体里出现了密码痕迹 ${JSON.stringify(trace)}`)
  }
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-8 用户管理接口验收：权限 / 建号 / 启停改角色 / 重置密码 ══${c.x}`)

const prisma = getPrisma()
const redis = getRedis()

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
  const create = (username, data) => prisma.user.create({ data: { username, passwordHash, ...data } })

  /** 操作者：ADMIN 且非首登态（否则会被闸门拦，测不到用户管理本身） */
  const operator = await create(usernames.operator, {
    nickname: '验证操作者',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const member = await create(usernames.member, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const lockTarget = await create(usernames.lockTarget, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(operator.id, member.id, lockTarget.id)
  console.log(`  ${c.d}临时用户：${usernames.operator}（ADMIN）/ ${usernames.member} / ${usernames.lockTarget}${c.x}`)

  const operatorCookie = (await login(usernames.operator, PASSWORD)).cookie
  const memberCookie = (await login(usernames.member, PASSWORD)).cookie

  // ── 1. 权限：`(A)` 端点 ──
  await it('无会话访问 /api/users → 401；MEMBER 访问 → 403 / FORBIDDEN（验收条款①）', async () => {
    const anonymous = await api('GET', '/api/users')
    assertEqual(anonymous.statusCode, 401, '匿名状态码')
    assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名信封 code')

    const asMember = await api('GET', '/api/users', { cookie: memberCookie })
    assertEqual(asMember.statusCode, 403, 'MEMBER 状态码')
    assertEqual(asMember.json().code, 'FORBIDDEN', 'MEMBER 信封 code')
  })

  await it('ADMIN 列表 → 200 + offset/limit 分页形态，且**响应体不含任何密码痕迹**', async () => {
    const response = await api('GET', '/api/users?limit=100', { cookie: operatorCookie })
    assertEqual(response.statusCode, 200, '状态码')
    const body = response.json()
    const parsed = userListResultSchema.safeParse(body.data)
    assert(parsed.success, `响应体不符合 userListResultSchema：${JSON.stringify(parsed.error?.issues)}`)
    assertEqual(body.data.limit, 100, 'limit 回显')
    assertEqual(body.data.offset, 0, 'offset 回显')
    assert(body.data.total >= 3, `total 应至少含 3 个临时用户，实际 ${body.data.total}`)
    assert(
      body.data.items.some((item) => item.username === usernames.member),
      '列表应包含刚建的 MEMBER 用户',
    )
    assertNoPasswordTraces(response.body, '列表')
    console.log(`         ${c.d}共 ${body.data.total} 个用户，本页 ${body.data.items.length} 条${c.x}`)
  })

  // ── 2. 建号 ──
  let createdUser
  let createdInitialPassword
  await it(
    `建号 → 200 + 回一次性初始密码（${INITIAL_PASSWORD_LENGTH} 字符、无易混字符）+ mustChangePassword=true（验收条款②）`,
    async () => {
      const response = await api('POST', '/api/users', {
        cookie: operatorCookie,
        payload: { username: usernames.apiCreated, nickname: 'API 建的号' },
      })
      assertEqual(response.statusCode, 200, '状态码')
      const data = response.json().data
      createdUser = data.user
      createdInitialPassword = data.initialPassword
      assertEqual(typeof createdInitialPassword, 'string', 'initialPassword 类型')
      assertEqual(createdInitialPassword.length, INITIAL_PASSWORD_LENGTH, '初始密码长度')
      assert(/[0O1lI]/.test(createdInitialPassword) === false, '初始密码不应含易混字符')
      assertEqual(createdUser.username, usernames.apiCreated, 'username')
      assertEqual(createdUser.nickname, 'API 建的号', 'nickname')
      assertEqual(createdUser.role, 'MEMBER', 'role 缺省应为 MEMBER')
      assertEqual(createdUser.status, 'ACTIVE', 'status')
      assertEqual(createdUser.mustChangePassword, true, '建号即必须改密')
      assert(typeof createdUser.createdAt === 'string' && createdUser.createdAt.includes('T'), 'createdAt 应为 ISO 串')
      createdUserIds.push(createdUser.id)
      console.log(`         ${c.d}新建 ${createdUser.username}（${createdUser.id}），初始密码已下发（不落日志）${c.x}`)
    },
  )

  await it('建号后再查列表：**不再出现**初始密码，且密码痕迹整体为零（验收条款②）', async () => {
    const response = await api('GET', '/api/users?limit=100', { cookie: operatorCookie })
    assertEqual(response.statusCode, 200, '状态码')
    assertNoPasswordTraces(response.body, '建号后的列表')
    // 列表这种"日常读接口"连 `initialPassword` 这个键都不该出现（`02` §十：明文密码只在建号那一次）
    assert(response.body.includes('initialPassword') === false, '列表响应里出现了 initialPassword 字段')
    const item = response.json().data.items.find((row) => row.id === createdUser.id)
    assert(item !== undefined, '列表里应能找到刚建的用户')
    assertEqual(item.mustChangePassword, true, '列表里的 mustChangePassword 应为 true（等对方首登改密）')
    assert(response.body.includes(createdInitialPassword) === false, '初始密码竟然出现在列表响应里')
  })

  await it('用初始密码登录 → 200 且 mustChangePassword=true（建号 → 首登链路打通）', async () => {
    const { response, body, cookie } = await login(usernames.apiCreated, createdInitialPassword)
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(body.data.username, usernames.apiCreated, 'username')
    assertEqual(body.data.mustChangePassword, true, 'mustChangePassword')
    assert(cookie !== '', '应下发会话 Cookie')
  })

  await it('首登态（未改密）的号访问 /api/users → 403（闸门先于权限判定拦住）', async () => {
    const { cookie } = await login(usernames.apiCreated, createdInitialPassword)
    const response = await api('GET', '/api/users', { cookie })
    assertEqual(response.statusCode, 403, '状态码')
    assert(response.json().msg.includes('修改密码'), `msg 应提示必须改密，实际：${response.json().msg}`)
  })

  await it('重复建号 → 409 / CONFLICT；**大小写不同的同名**同样 409（归一化生效）', async () => {
    const again = await api('POST', '/api/users', {
      cookie: operatorCookie,
      payload: { username: usernames.apiCreated },
    })
    assertEqual(again.statusCode, 409, '同名状态码')
    assertEqual(again.json().code, 'CONFLICT', '同名信封 code')

    const upper = await api('POST', '/api/users', {
      cookie: operatorCookie,
      payload: { username: usernames.apiCreated.toUpperCase() },
    })
    assertEqual(upper.statusCode, 409, '大写同名状态码')
  })

  await it('建号参数校验：空用户名 / 含空格 / 非法 role → 400 + 字段明细', async () => {
    const cases = [
      ['空用户名', { username: '' }],
      ['纯空白', { username: '   ' }],
      ['含空格', { username: 'has space' }],
      ['非法 role', { username: `verify-users-bad-${suffix}`, role: 'SUPER' }],
    ]
    for (const [label, payload] of cases) {
      const response = await api('POST', '/api/users', { cookie: operatorCookie, payload })
      assertEqual(response.statusCode, 400, `${label} 状态码`)
      const fields = response.json().data.fields
      assert(Array.isArray(fields) && fields.length > 0, `${label} 应给出字段明细`)
    }
  })

  // ── 3. 启停：立即生效（含"已登录会话"这条端到端）──
  await it('停用后：该用户**已有的会话下一个请求就 401**（写侧主动失效的端到端取证）', async () => {
    const { cookie } = await login(usernames.apiCreated, createdInitialPassword)
    // 先确认这个会话是活的
    const before = await api('GET', '/api/auth/me', { cookie })
    assertEqual(before.statusCode, 200, '停用前 /auth/me 状态码')

    const disable = await api('PATCH', `/api/users/${createdUser.id}`, {
      cookie: operatorCookie,
      payload: { status: 'DISABLED' },
    })
    assertEqual(disable.statusCode, 200, '停用状态码')
    assertEqual(disable.json().data.status, 'DISABLED', 'status')

    // ⚠️ 不等待缓存窗口：写侧已 invalidate，下一个请求就该被拒
    const after = await api('GET', '/api/auth/me', { cookie })
    assertEqual(after.statusCode, 401, '停用后同一 Cookie 的状态码')
    assertEqual(after.json().code, 'UNAUTHORIZED', '信封 code')
    assertEqual(await redis.exists(sessionKey(cookie)), 0, '该会话应已被自毁')
  })

  await it('停用后该账号登录被拒（验收条款③）；重新启用后即可登录', async () => {
    const blocked = await login(usernames.apiCreated, createdInitialPassword)
    assertEqual(blocked.response.statusCode, 401, '停用后登录状态码')
    assert(blocked.body.msg.includes('停用'), `msg 应点明已停用，实际：${blocked.body.msg}`)

    const enable = await api('PATCH', `/api/users/${createdUser.id}`, {
      cookie: operatorCookie,
      payload: { status: 'ACTIVE' },
    })
    assertEqual(enable.statusCode, 200, '启用状态码')
    assertEqual(enable.json().data.status, 'ACTIVE', 'status')

    const restored = await login(usernames.apiCreated, createdInitialPassword)
    assertEqual(restored.response.statusCode, 200, '启用后登录状态码')
  })

  // ── 4. 改角色：立即生效（同一个会话立刻拿到新权限）──
  await it('改角色 MEMBER → ADMIN：该用户**同一个会话**立刻能进 /api/users（也是主动失效的取证）', async () => {
    const { cookie } = await login(usernames.member, PASSWORD)
    const denied = await api('GET', '/api/users', { cookie })
    assertEqual(denied.statusCode, 403, '升权前状态码')

    const promote = await api('PATCH', `/api/users/${member.id}`, {
      cookie: operatorCookie,
      payload: { role: 'ADMIN' },
    })
    assertEqual(promote.statusCode, 200, '升权状态码')
    assertEqual(promote.json().data.role, 'ADMIN', 'role')

    const allowed = await api('GET', '/api/users', { cookie })
    assertEqual(allowed.statusCode, 200, '升权后同一 Cookie 应立刻放行')
  })

  // ── 5. 自我保护（坑预判）──
  await it('不能停用 / 降级 / 重置**自己** → 409 / CONFLICT（防 admin 自锁）', async () => {
    const cases = [
      ['停用自己', () => api('PATCH', `/api/users/${operator.id}`, { cookie: operatorCookie, payload: { status: 'DISABLED' } })],
      ['降级自己', () => api('PATCH', `/api/users/${operator.id}`, { cookie: operatorCookie, payload: { role: 'MEMBER' } })],
      ['重置自己的密码', () => api('POST', `/api/users/${operator.id}/reset-password`, { cookie: operatorCookie })],
    ]
    for (const [label, run] of cases) {
      const response = await run()
      assertEqual(response.statusCode, 409, `${label} 状态码`)
      assertEqual(response.json().code, 'CONFLICT', `${label} 信封 code`)
      assert(response.json().msg.length > 0, `${label} 应有可读文案`)
    }
    // 自锁失败后操作者仍可用（最能说明这条约束的意义）
    const stillOk = await api('GET', '/api/auth/me', { cookie: operatorCookie })
    assertEqual(stillOk.statusCode, 200, '被拒后操作者仍应可用')
  })

  // ── 6. 重置密码 ──
  await it('重置密码 → 新初始密码 + mustChangePassword 回到 true；该用户已在线的会话立刻被闸门拦住', async () => {
    const { cookie: memberCookieAfterPromote } = await login(usernames.member, PASSWORD)
    const before = await api('GET', '/api/users', { cookie: memberCookieAfterPromote })
    assertEqual(before.statusCode, 200, '重置前（已是 ADMIN）状态码')

    const reset = await api('POST', `/api/users/${member.id}/reset-password`, { cookie: operatorCookie })
    assertEqual(reset.statusCode, 200, '重置状态码')
    const data = reset.json().data
    const newInitial = data.initialPassword
    assertEqual(typeof newInitial, 'string', 'initialPassword 类型')
    assertEqual(newInitial.length, INITIAL_PASSWORD_LENGTH, '新初始密码长度')
    assertEqual(data.user.mustChangePassword, true, '重置后必须改密')
    assertNoPasswordTraces(reset.body, '重置响应')

    // 已在线的会话：立刻被首登闸门拦住（mustChangePassword 刚被置 true 且缓存已失效）
    const gated = await api('GET', '/api/users', { cookie: memberCookieAfterPromote })
    assertEqual(gated.statusCode, 403, '重置后旧会话访问业务接口状态码')
    assert(gated.json().msg.includes('修改密码'), 'msg 应提示必须改密')
  })

  await it('重置后：旧密码登录失败、新初始密码可登录', async () => {
    const oldPassword = await login(usernames.member, PASSWORD)
    assertEqual(oldPassword.response.statusCode, 401, '旧密码状态码')

    const resetAgain = await api('POST', `/api/users/${member.id}/reset-password`, { cookie: operatorCookie })
    const freshInitial = resetAgain.json().data.initialPassword
    const withInitial = await login(usernames.member, freshInitial)
    assertEqual(withInitial.response.statusCode, 200, '新初始密码状态码')
    assertEqual(withInitial.body.data.mustChangePassword, true, '仍应是首登态')
  })

  await it('重置密码会**清掉登录失败计数**：连错 5 次被锁的号，重置后能立刻用新密码登录', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await login(usernames.lockTarget, `wrong-password-${i}`)
    }
    assertEqual(await redis.get(loginFailKey(usernames.lockTarget)), '5', '失败计数')
    const locked = await login(usernames.lockTarget, PASSWORD)
    assertEqual(locked.response.statusCode, 429, '第 6 次应被锁')

    const reset = await api('POST', `/api/users/${lockTarget.id}/reset-password`, { cookie: operatorCookie })
    const freshInitial = reset.json().data.initialPassword
    assertEqual(await redis.exists(loginFailKey(usernames.lockTarget)), 0, '重置后计数键应被清掉')

    const afterReset = await login(usernames.lockTarget, freshInitial)
    assertEqual(afterReset.response.statusCode, 200, '重置后应立即能登录（否则"重置密码"名不副实）')
  })

  // ── 7. 路径参数与请求体校验 ──
  await it('不存在的 id → 404；非法 uuid → 400；PATCH 空 body → 400', async () => {
    const missingId = '00000000-0000-7000-8000-000000000000'
    const notFound = await api('PATCH', `/api/users/${missingId}`, {
      cookie: operatorCookie,
      payload: { status: 'DISABLED' },
    })
    assertEqual(notFound.statusCode, 404, 'PATCH 不存在的 id 状态码')
    assertEqual(notFound.json().code, 'NOT_FOUND', '信封 code')

    const resetMissing = await api('POST', `/api/users/${missingId}/reset-password`, { cookie: operatorCookie })
    assertEqual(resetMissing.statusCode, 404, '重置不存在的 id 状态码')

    const badUuid = await api('PATCH', '/api/users/not-a-uuid', {
      cookie: operatorCookie,
      payload: { status: 'DISABLED' },
    })
    assertEqual(badUuid.statusCode, 400, '非法 uuid 状态码')
    assert(
      badUuid.json().data.fields.some((field) => field.path === 'params.id'),
      '应报出 params.id',
    )

    const emptyBody = await api('PATCH', `/api/users/${member.id}`, { cookie: operatorCookie, payload: {} })
    assertEqual(emptyBody.statusCode, 400, '空 body 状态码')
  })

  await it('分页：limit=1 的两页互不重复，且 total 稳定', async () => {
    const first = await api('GET', '/api/users?offset=0&limit=1', { cookie: operatorCookie })
    const second = await api('GET', '/api/users?offset=1&limit=1', { cookie: operatorCookie })
    const p1 = first.json().data
    const p2 = second.json().data
    assertEqual(p1.items.length, 1, '第一页条数')
    assertEqual(p2.items.length, 1, '第二页条数')
    assert(p1.items[0].id !== p2.items[0].id, '两页出现了同一条（排序不稳定）')
    assertEqual(p1.total, p2.total, 'total 应稳定')
    assert(p1.items[0].username < p2.items[0].username, '应按 username 升序')
  })
} finally {
  // ── 清理：删临时用户 + 会话键 + 快照缓存 + 登录失败计数 ──
  for (const userId of createdUserIds) {
    try {
      await prisma.user.delete({ where: { id: userId } })
    } catch (error) {
      console.log(`  ${c.r}清理用户 ${userId} 失败：${error instanceof Error ? error.message : String(error)}${c.x}`)
    }
    await invalidateUserSnapshot(userId).catch(() => undefined)
  }
  for (const username of Object.values(usernames)) {
    await clearLoginFailures(normalizeUsername(username))
  }
  for (const sid of sessionIds) {
    await redis.del(sessionKey(sid)).catch(() => undefined)
  }
  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-8 用户管理接口验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-8 用户管理接口验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
