#!/usr/bin/env node
/**
 * verify-auth.mjs —— P0-1-7 的**认证接口验收**（需要真实 Redis + PG）
 *
 * 与另两个脚本的分工：
 *   · `verify-app.mjs`    —— 不需要依赖的契约与纯函数（含"登录请求体校验"这类不碰库的断言）
 *   · `verify-session.mjs` —— 会话基础设施本身（Cookie 属性、Redis 键、停用即失效）
 *   · 本脚本               —— **四个认证端点的行为**：登录、登出、当前用户、改密，
 *                            外加两条 `01` 里点名要验的东西：
 *                            「错误提示不泄露账号是否存在」（含**耗时**取证）与「连续失败锁定」。
 *
 * ⚠️ 跑之前必须先起依赖（不是"可选"）：
 *     pnpm infra:up        # postgres + redis
 *     pnpm db:deploy       # 表结构
 *     pnpm verify:auth
 *
 * 脚本自造 5 个带随机后缀的临时用户（首登/停用/锁定各司其职，避免互相污染计数与状态），
 * 结束时删净用户与 Redis 键。业务路由用自注册探针 `/api/__t/*` 代替（E 包才有真业务路由）。
 */

// ── 环境前置：必须在 import `config.js`（经 dist 的 app.js）之前设置 ──
// 一个脚本会打几十个请求，其中大半是"应当失败"的，warn 会把断言输出淹掉。
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma, UserRole, UserStatus } = await import('../dist/backend/src/infra/prisma.js')
const {
  LOGIN_LOCK_TTL_SEC,
  LOGIN_MAX_FAILURES,
  clearLoginFailures,
  closeRedis,
  ensureRedisConnected,
  getRedis,
  invalidateUserSnapshot,
  loginFailKey,
  sessionKey,
} = await import('../dist/backend/src/infra/redis.js')
const { ok, normalizeUsername } = await import('@doubulea/shared')

// ───────────────────────────── 断言脚手架（与另两个脚本同一套）─────────────────────────────

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
/** 通用失败文案：**存在与不存在两种账号必须逐字相同**（下面有逐字比对断言） */
const GENERIC_LOGIN_FAILURE = '用户名或密码错误'

const PASSWORD = 'Verify-Auth-Passw0rd'
const NEW_PASSWORD = 'Verify-Auth-New-Passw0rd'

function sessionCookieOf(response) {
  const raw = response.headers['set-cookie']
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const pair = header.split(';')[0] ?? ''
  const eq = pair.indexOf('=')
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), header }
}

const cookieHeader = (value) => ({ cookie: `${SESSION_COOKIE_NAME}=${value}` })

/** 登录并返回 `{ response, body, cookie }`（不抛错，便于断言失败态） */
async function attemptLogin(app, username, password) {
  const started = performance.now()
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  const elapsedMs = performance.now() - started
  return { response, body: response.json(), cookie: sessionCookieOf(response), elapsedMs }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
async function timeLogin(app, username, password, samples = 3) {
  const times = []
  for (let i = 0; i < samples; i += 1) times.push((await attemptLogin(app, username, password)).elapsedMs)
  return median(times)
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-7 认证接口验收：登录 / 登出 / 当前用户 / 改密 / 限速 / 首登闸门 ══${c.x}`)

const prisma = getPrisma()
const redis = getRedis()
const suffix = Math.random().toString(36).slice(2, 8)
const usernames = {
  admin: `verify-auth-admin-${suffix}`,
  first: `verify-auth-first-${suffix}`,
  disabled: `verify-auth-disabled-${suffix}`,
  lock: `verify-auth-lock-${suffix}`,
  reset: `verify-auth-reset-${suffix}`,
}
/**
 * 「故意不存在」的用户名：用来验"不泄露账号是否存在"。
 * ⚠️ 必须一起清理 —— 失败计数键是按**被尝试的用户名**建的，这个键会因此被创建
 * （第一次跑就留了残留，靠复核才看出来）。
 */
const missingUsername = `verify-auth-nobody-${suffix}`
/** 记录创建的 userId，finally 里删净 */
const createdUserIds = []
/** 记录用过的 sid，finally 里删净 */
const sessionIds = []

const app = buildApp()

// 探针路由（只在本脚本注册；存进源码树的就是业务路由了，而业务路由属 E 包）：
//   /api/__t/business —— 带 requireAuth 的"业务接口"
//   /api/__t/public   —— **不带**任何鉴权钩子的接口：用来证明首登闸门独立于 requireAuth
app.get('/api/__t/business', { preHandler: app.requireAuth }, async (request) =>
  ok({ userId: request.auth?.user.id }),
)
app.get('/api/__t/public', async () => ok({ public: true }))

/** 从响应里登记 sid，便于清理 */
function rememberCookie(cookie) {
  if (cookie.value !== '') sessionIds.push(cookie.value)
}

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

  const admin = await createUser(usernames.admin, {
    nickname: '验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  /** 首登态：用来验强制改密闸门 */
  const first = await createUser(usernames.first, {
    nickname: null,
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: true,
  })
  const disabled = await createUser(usernames.disabled, {
    role: UserRole.MEMBER,
    status: UserStatus.DISABLED,
    mustChangePassword: false,
  })
  /** 专门用来把计数刷满（避免污染其它用户的计数） */
  const lock = await createUser(usernames.lock, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  /** 专门用来验"成功即清计数" */
  const reset = await createUser(usernames.reset, {
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(admin.id, first.id, disabled.id, lock.id, reset.id)
  console.log(`  ${c.d}临时用户：${Object.values(usernames).join(' / ')}${c.x}`)

  // ── 1. 未登录 ──
  await it('未登录访问 /api/auth/me → 401 / UNAUTHORIZED', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' })
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
  })

  // ── 2. 登录成功 ──
  await it('登录成功 → 200 + 下发会话 Cookie + 返回当前用户（不含任何密码字段）', async () => {
    const { response, body, cookie } = await attemptLogin(app, usernames.admin, PASSWORD)
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(body.code, 0, '信封 code')
    assertEqual(body.data.username, usernames.admin, 'username')
    assertEqual(body.data.nickname, '验证管理员', 'nickname')
    assertEqual(body.data.role, 'ADMIN', 'role')
    assertEqual(body.data.mustChangePassword, false, 'mustChangePassword')
    assert(cookie.header.includes('HttpOnly'), 'Cookie 应带 HttpOnly')
    assert(response.body.includes('password') === false, '响应体不应出现任何 password 字段')
    rememberCookie(cookie)
    console.log(`         ${c.d}${cookie.header.replace(cookie.value, '<sid>')}${c.x}`)
  })

  await it('用户名大小写不敏感（归一化后查库）：全大写用户名也能登录', async () => {
    const { response, body, cookie } = await attemptLogin(app, usernames.admin.toUpperCase(), PASSWORD)
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(body.data.username, usernames.admin, '返回的 username 应是库里的原值')
    rememberCookie(cookie)
  })

  // ── 3. 「不泄露账号是否存在」：文案 + 耗时两路取证 ──
  await it(`错误密码 → 401 + 「${GENERIC_LOGIN_FAILURE}」（文案明确但不点破账号是否存在）`, async () => {
    const { response, body } = await attemptLogin(app, usernames.admin, 'definitely-wrong-password')
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(body.code, 'UNAUTHORIZED', '信封 code')
    assertEqual(body.msg, GENERIC_LOGIN_FAILURE, 'msg')
  })

  await it('不存在的用户名 → **逐字相同**的 401 文案（从响应上无法区分账号是否存在）', async () => {
    const { response, body } = await attemptLogin(app, missingUsername, 'definitely-wrong-password')
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(body.code, 'UNAUTHORIZED', '信封 code')
    assertEqual(body.msg, GENERIC_LOGIN_FAILURE, 'msg 必须与"密码错误"逐字相同')
    // 顺带：不能因为账号不存在就要求先注册/泄露任何额外信息
    assertEqual(body.data, null, 'data')
  })

  await it('**耗时**取证：账号不存在时也真的跑了一次 bcrypt（等时比较），两者中位数接近', async () => {
    const existingMs = await timeLogin(app, usernames.admin, 'definitely-wrong-password')
    const missingMs = await timeLogin(app, missingUsername, 'definitely-wrong-password')
    // ① 不存在的那条也必须慢 —— 慢就说明真的跑了 cost 12 的 bcrypt（本机约 225ms）。
    //    若这里只有几毫秒，说明走了"立刻返回"的短路分支，耗时侧就把账号是否存在暴露了。
    assert(missingMs > 100, `不存在的账号也应跑满一次 bcrypt（实测仅 ${missingMs.toFixed(0)}ms）——等时比较没生效`)
    assert(existingMs > 100, `存在的账号应跑满一次 bcrypt（实测 ${existingMs.toFixed(0)}ms）`)
    // ② 两者的差要小（阈值放宽到 150ms：机器抖动、GC、连接首次建立都可能带来几十毫秒）
    assert(
      Math.abs(existingMs - missingMs) < 150,
      `两条路径耗时应接近：存在 ${existingMs.toFixed(0)}ms vs 不存在 ${missingMs.toFixed(0)}ms`,
    )
    console.log(
      `         ${c.d}中位数耗时：账号存在 ${existingMs.toFixed(0)}ms / 不存在 ${missingMs.toFixed(0)}ms${c.x}`,
    )
  })

  // ── 4. 首登强制改密闸门 ──
  let firstCookie
  await it('首登用户登录成功 → mustChangePassword=true（会话照发，不在这里拦）', async () => {
    const { response, body, cookie } = await attemptLogin(app, usernames.first, PASSWORD)
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(body.data.mustChangePassword, true, 'mustChangePassword')
    firstCookie = cookie
    rememberCookie(cookie)
  })

  await it('闸门：首登未改密时访问业务接口 → **403**（带 requireAuth 的）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/__t/business',
      headers: cookieHeader(firstCookie.value),
    })
    assertEqual(response.statusCode, 403, '状态码')
    assertEqual(response.json().code, 'FORBIDDEN', '信封 code')
    assert(response.json().msg.includes('修改密码'), `msg 应点明必须改密，实际：${response.json().msg}`)
  })

  await it('闸门覆盖**所有** /api/**（无鉴权钩子的公共接口同样 403 —— 闸门不依附于 requireAuth）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/__t/public',
      headers: cookieHeader(firstCookie.value),
    })
    assertEqual(response.statusCode, 403, '状态码')
  })

  await it('闸门白名单：/api/auth/me 与 /api/auth/password 在首登态仍可用（否则改密就成了死循环）', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: cookieHeader(firstCookie.value),
    })
    assertEqual(me.statusCode, 200, '/api/auth/me 状态码')
    assertEqual(me.json().data.mustChangePassword, true, 'me 应返回 mustChangePassword=true')

    // 用错误的旧密码调改密：能进到业务逻辑（400）而不是被闸门拦（403）
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: cookieHeader(firstCookie.value),
      payload: { oldPassword: 'not-the-old-password-1', newPassword: NEW_PASSWORD },
    })
    assertEqual(wrong.statusCode, 400, '/api/auth/password 状态码（说明已穿过闸门）')
    assertEqual(wrong.json().code, 'VALIDATION', '信封 code')
  })

  await it('改密时旧密码错误 → 400 + data.fields 指向 body.oldPassword，且**密码未被修改**', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: cookieHeader(firstCookie.value),
      payload: { oldPassword: 'not-the-old-password-2', newPassword: NEW_PASSWORD },
    })
    assertEqual(response.statusCode, 400, '状态码')
    const fields = response.json().data.fields
    assert(Array.isArray(fields) && fields.length > 0, 'data.fields 应给出字段级明细')
    assertEqual(fields[0].path, 'body.oldPassword', '字段路径')
    // 旧密码仍然有效（说明上面那次失败没有改任何东西）
    const stillOld = await attemptLogin(app, usernames.first, PASSWORD)
    assertEqual(stillOld.response.statusCode, 200, '旧密码应仍然可登录')
    rememberCookie(stillOld.cookie)
  })

  await it('新密码不符合策略（过短 / 超 72 字节）→ 400 且带字段明细', async () => {
    for (const [label, newPassword] of [
      ['过短', 'short1'],
      ['超 72 字节', '中'.repeat(25)], // 75 字节
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: cookieHeader(firstCookie.value),
        payload: { oldPassword: PASSWORD, newPassword },
      })
      assertEqual(response.statusCode, 400, `${label} 状态码`)
      const fields = response.json().data.fields
      assert(fields.some((field) => field.path === 'body.newPassword'), `${label} 应报 body.newPassword`)
    }
  })

  await it('改密成功 → 200 + mustChangePassword 转 false；**紧接着**业务接口就能访问（不缓存生效延迟）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: cookieHeader(firstCookie.value),
      payload: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(response.json().data.mustChangePassword, false, 'mustChangePassword')

    // ⚠️ 这条是"写侧主动失效快照缓存"的验收：不失效的话闸门会继续 403 到缓存窗口过期
    const business = await app.inject({
      method: 'GET',
      url: '/api/__t/business',
      headers: cookieHeader(firstCookie.value),
    })
    assertEqual(business.statusCode, 200, '改密后业务接口应立即放行')
    assertEqual(business.json().data.userId, first.id, '身份应正确')

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: cookieHeader(firstCookie.value),
    })
    assertEqual(me.json().data.mustChangePassword, false, '/auth/me 也应立即反映')
  })

  await it('改密后：新密码可登录、旧密码失效', async () => {
    const withNew = await attemptLogin(app, usernames.first, NEW_PASSWORD)
    assertEqual(withNew.response.statusCode, 200, '新密码状态码')
    rememberCookie(withNew.cookie)

    const withOld = await attemptLogin(app, usernames.first, PASSWORD)
    assertEqual(withOld.response.statusCode, 401, '旧密码状态码')
    assertEqual(withOld.body.msg, GENERIC_LOGIN_FAILURE, '旧密码失败也用通用文案')
  })

  // ── 5. 停用账号 ──
  await it('停用账号：密码**错**时仍只得到通用文案（不泄露"这个账号存在且被停用"）', async () => {
    const { response, body } = await attemptLogin(app, usernames.disabled, 'definitely-wrong-password')
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(body.msg, GENERIC_LOGIN_FAILURE, 'msg')
  })

  await it('停用账号：密码**对**时明确告知「账号已停用」（不必反复重试到被锁）', async () => {
    const { response, body } = await attemptLogin(app, usernames.disabled, PASSWORD)
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(body.code, 'UNAUTHORIZED', '信封 code')
    assert(body.msg.includes('停用'), `msg 应点明已停用，实际：${body.msg}`)
  })

  // ── 6. 登录限速（`02` §十：5 次失败锁 10 分钟）──
  await it(`连续 ${LOGIN_MAX_FAILURES} 次失败仍是 401（还没锁），第 ${LOGIN_MAX_FAILURES + 1} 次 → **429 + 已锁定提示**`, async () => {
    for (let i = 1; i <= LOGIN_MAX_FAILURES; i += 1) {
      const { response, body } = await attemptLogin(app, usernames.lock, `wrong-password-${i}`)
      assertEqual(response.statusCode, 401, `第 ${i} 次失败的状态码`)
      assertEqual(body.msg, GENERIC_LOGIN_FAILURE, `第 ${i} 次失败的 msg`)
    }
    // 恰好第 5 次时 Redis 里的计数应为上限（下面用键直接核对，避免只信响应）
    assertEqual(await redis.get(loginFailKey(usernames.lock)), String(LOGIN_MAX_FAILURES), '计数键的值')

    const sixth = await attemptLogin(app, usernames.lock, 'wrong-password-6')
    assertEqual(sixth.response.statusCode, 429, '第 6 次状态码')
    assertEqual(sixth.body.code, 'BUSY', '信封 code')
    assert(sixth.body.msg.includes('已锁定'), `msg 应点明已锁定，实际：${sixth.body.msg}`)
    assert(/分钟后重试/.test(sixth.body.msg), `msg 应给出重试时间，实际：${sixth.body.msg}`)
    const retryAfterSec = sixth.body.data?.retryAfterSec
    assert(
      typeof retryAfterSec === 'number' && retryAfterSec > 0 && retryAfterSec <= LOGIN_LOCK_TTL_SEC,
      `data.retryAfterSec 应在 (0, ${LOGIN_LOCK_TTL_SEC}]，实际 ${JSON.stringify(sixth.body.data)}`,
    )
    console.log(`         ${c.d}计数键 ${loginFailKey(usernames.lock)} = ${LOGIN_MAX_FAILURES}，第 6 次 msg："${sixth.body.msg}"（剩余 ${retryAfterSec}s）${c.x}`)
  })

  await it('锁定期间**正确密码**也被拒（429）—— 锁定判定在校验之前，且锁定不会被新尝试续期', async () => {
    const before = await redis.ttl(loginFailKey(usernames.lock))
    const { response, body } = await attemptLogin(app, usernames.lock, PASSWORD)
    assertEqual(response.statusCode, 429, '状态码')
    assertEqual(body.code, 'BUSY', '信封 code')
    const after = await redis.ttl(loginFailKey(usernames.lock))
    assert(after <= before, `锁的剩余时间不应被新尝试延长：${before}s → ${after}s`)
  })

  await it('登录成功即清计数：错 4 次 → 成功 → 再错 5 次仍是 401（第 6 次才锁）', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const { response } = await attemptLogin(app, usernames.reset, `wrong-${i}`)
      assertEqual(response.statusCode, 401, `清计数前第 ${i} 次失败`)
    }
    assertEqual(await redis.get(loginFailKey(usernames.reset)), '4', '清计数前的计数')

    const success = await attemptLogin(app, usernames.reset, PASSWORD)
    assertEqual(success.response.statusCode, 200, '成功登录状态码')
    rememberCookie(success.cookie)
    assertEqual(await redis.exists(loginFailKey(usernames.reset)), 0, '成功应删除计数键')

    for (let i = 1; i <= LOGIN_MAX_FAILURES; i += 1) {
      const { response } = await attemptLogin(app, usernames.reset, `wrong-again-${i}`)
      assertEqual(
        response.statusCode,
        401,
        `清计数后第 ${i} 次失败：若计数没被清，第 1 次就会累到上限、第 2 次即 429`,
      )
    }
  })

  // ── 7. 登出 ──
  await it('登出 → 200 + 清 Cookie；旧 Cookie 再用即 401', async () => {
    const { cookie } = await attemptLogin(app, usernames.admin, PASSWORD)
    rememberCookie(cookie)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(cookie.value),
    })
    assertEqual(logout.statusCode, 200, '登出状态码')
    assertEqual(sessionCookieOf(logout).value, '', '应清 Cookie')
    assertEqual(await redis.exists(sessionKey(cookie.value)), 0, '应删除会话键')

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: cookieHeader(cookie.value),
    })
    assertEqual(me.statusCode, 401, '登出后 /auth/me 状态码')
  })

  await it('登出幂等：无 Cookie 调登出也 200', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' })
    assertEqual(response.statusCode, 200, '状态码')
    assertEqual(response.json().code, 0, '信封 code')
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
  for (const username of [...Object.values(usernames), missingUsername]) {
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
  console.log(`${c.g}${c.b}✅ P0-1-7 认证接口验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-7 认证接口验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
