#!/usr/bin/env node
/**
 * verify-session.mjs —— P0-1-6 的**会话验收**（需要真实 Redis + PG）
 *
 * 与 `verify-app.mjs` 的分工：那一个验「不需要依赖就能成立的契约」（含密文/密码的纯函数），
 * 这一个验**唯有连着真实依赖才测得出来**的那部分 —— 会话在 Redis 里的形态、
 * Cookie 属性、每请求 `user.status` 校验、停用/删除后的失效路径、滑动续期。
 *
 * ⚠️ 跑之前必须先起依赖（不是"可选"）：
 *     pnpm infra:up        # postgres + redis
 *     pnpm db:deploy       # 表结构（首次或换机器时）
 *     pnpm verify:session
 *
 * 脚本自己会造两个临时用户（ADMIN / MEMBER，用户名带随机后缀）并在结束时删掉；
 * 全程只用 `/__t/*` 探针路由（**不进源码树** —— 产品代码里此刻还没有任何业务路由）。
 *
 * 用法：
 *   pnpm verify:session
 *   LOG_LEVEL=debug pnpm verify:session     # 想看细节日志时
 */

// ── 环境前置：必须在 import `config.js`（经 dist 的 app.js）**之前**设置 ──
// `backend/src/config.ts` 的约定是「进程环境变量 > infra/.env」，所以这里设的值会生效。
//
// 把「状态缓存窗口」压到 1 秒：`02` §十 定的 60s 是为了生产（缓存只为兜底非本机写入），
// 但按 60s 验一次「缓存过期后才会发现停用」要等一分钟，脚本没法这么跑。窗口是配置项，
// 压到 1s 后**机制**完全一致，验的仍是「缓存到期才回库 → 此时才看到 DISABLED」。
process.env.USER_STATUS_CACHE_TTL_SEC ??= '1'
// 输出收敛到 error：本脚本会打十几个请求，而每个"应当失败"的请求都会留一条 warn
// （errorHandler 对非校验类 4xx 的记录），断言结果会被淹掉。
// 想看细节（含每条 4xx 的堆栈）时：LOG_LEVEL=debug pnpm verify:session
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

import { setTimeout as sleep } from 'node:timers/promises'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma, UserRole, UserStatus } = await import('../dist/backend/src/infra/prisma.js')
const {
  closeRedis,
  createSession,
  destroySession,
  ensureRedisConnected,
  getRedis,
  invalidateUserSnapshot,
  readSessionUserId,
  sessionKey,
  userSnapshotKey,
} = await import('../dist/backend/src/infra/redis.js')
const { endSession, issueSession, SESSION_COOKIE_NAME } = await import('../dist/backend/src/plugins/session.js')
const { ok } = await import('@doubulea/shared')

// ───────────────────────────── 断言脚手架（与 verify-app.mjs 同一套）─────────────────────────────

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

/** 从响应里取出会话 Cookie（`doubulea_sid=<value>` + 整个 Set-Cookie 头，供属性断言） */
function sessionCookieOf(response) {
  const raw = response.headers['set-cookie']
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const pair = header.split(';')[0] ?? ''
  const eq = pair.indexOf('=')
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), header }
}

const cookieHeader = (value) => ({ cookie: `${SESSION_COOKIE_NAME}=${value}` })

/** 发一次「登录」探针请求，返回会话 Cookie 与响应 */
async function loginAs(app, userId) {
  const response = await app.inject({ method: 'GET', url: `/__t/login?userId=${userId}` })
  assertEqual(response.statusCode, 200, '登录探针应成功')
  const cookie = sessionCookieOf(response)
  assertNotEmpty(cookie.value, '登录必须下发会话 Cookie')
  return cookie
}

function assertNotEmpty(value, label) {
  assert(typeof value === 'string' && value !== '', `${label}（实际 ${JSON.stringify(value)}）`)
}

// ───────────────────────────── 预检 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-6 会话验收：Cookie / Redis 会话 / 每请求 status 校验 ══${c.x}`)

const prisma = getPrisma()
const redis = getRedis()
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-session-admin-${suffix}`
const memberUsername = `verify-session-member-${suffix}`
/** 收集本次创建的所有 sid，退出前清干净（不污染开发环境的 Redis） */
const sessionIds = []
/** 记录创建的 userId，便于 finally 里删库 */
const createdUserIds = []

const app = buildApp()

// 探针路由：只在本脚本里注册。逐条对应"登录 / 取当前用户 / 仅 ADMIN / 登出"四种位置。
// 登录探针刻意**不带 schema**：query 由 Fastify 默认解析器处理即可（不必为此写 zod）。
app.get('/__t/login', async (request, reply) => {
  const sid = await issueSession(reply, String(request.query.userId))
  sessionIds.push(sid)
  return ok({ issued: true })
})
app.get('/__t/protected', { preHandler: app.requireAuth }, async (request) =>
  ok({
    id: request.auth?.user.id,
    username: request.auth?.user.username,
    role: request.auth?.user.role,
    mustChangePassword: request.auth?.user.mustChangePassword,
  }),
)
app.get('/__t/admin', { preHandler: app.requireAdmin }, async () => ok({ scope: 'admin' }))
app.post('/__t/logout', async (request, reply) => {
  await endSession(request, reply)
  return ok({})
})

try {
  await app.ready()
  // 预检依赖：连不上就直接说清楚该做什么，而不是抛一串 ioredis/pg 的底层错误
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

  // ── 造两个临时用户（ADMIN / MEMBER）──
  // `mustChangePassword` 显式置 false：schema 默认是 true（建号即必须改密），
  // 但本脚本验的是会话，不验首登闸门 —— 保持与断言一致即可。
  const passwordHash = await hashPassword('Irrelevant-Passw0rd-1')
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  const member = await prisma.user.create({
    data: {
      username: memberUsername,
      passwordHash,
      role: UserRole.MEMBER,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
    },
  })
  createdUserIds.push(admin.id, member.id)
  console.log(`  ${c.d}临时用户：${adminUsername}（ADMIN）/ ${memberUsername}（MEMBER）${c.x}`)

  // ── 1. 未登录 / 伪造令牌 ──
  await it('未登录访问受保护路由 → 401 / UNAUTHORIZED', async () => {
    const response = await app.inject({ method: 'GET', url: '/__t/protected' })
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
  })

  await it('伪造 sid（Redis 里不存在）→ 401 / UNAUTHORIZED，且清掉客户端那枚废 Cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader('this-session-does-not-exist'),
    })
    assertEqual(response.statusCode, 401, '状态码')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
    const cleared = sessionCookieOf(response)
    assertEqual(cleared.value, '', '失效会话的 Cookie 应被清空（避免每个请求重复走失败路径）')
  })

  // ── 2. 登录下发的 Cookie 属性（`02` §十 安全设计逐条对照）──
  let adminCookie
  await it('登录：Set-Cookie = HttpOnly + SameSite=Lax + Path=/ + Max-Age=会话有效期 + 开发期无 Secure', async () => {
    adminCookie = await loginAs(app, admin.id)
    assertEqual(adminCookie.name, SESSION_COOKIE_NAME, 'Cookie 名')
    assertEqual(adminCookie.value.length, 43, 'sid 长度（32 字节 base64url）')
    assert(adminCookie.header.includes('HttpOnly'), 'Set-Cookie 缺少 HttpOnly')
    assert(adminCookie.header.includes('SameSite=Lax'), 'Set-Cookie 缺少 SameSite=Lax')
    assert(adminCookie.header.includes('Path=/'), 'Set-Cookie 缺少 Path=/')
    assert(adminCookie.header.includes('Max-Age=43200'), 'Set-Cookie 缺少 Max-Age=43200（12 小时）')
    assert(
      adminCookie.header.includes('Secure') === false,
      'development 下不应带 Secure（否则 http://localhost 收不到 Cookie）',
    )
    console.log(`         ${c.d}${adminCookie.header.replace(adminCookie.value, '<sid>')}${c.x}`)
  })

  // ── 3. 会话真的落在 Redis 里（键名与 TTL 与文档一致）──
  await it(`Redis 存在 ${'session:{sid}'} 且 TTL 为正、值里含 userId`, async () => {
    const key = sessionKey(adminCookie.value)
    const ttl = await redis.ttl(key)
    assert(ttl > 0 && ttl <= 43200, `TTL 应在 (0, 43200]，实际 ${ttl}`)
    const raw = await redis.get(key)
    assertNotEmpty(raw ?? '', '会话值不应为空')
    assert(raw.includes(admin.id), '会话值里应含 userId')
    console.log(`         ${c.d}${key.replace(adminCookie.value, '<sid>')} → TTL ${ttl}s，值 ${raw}${c.x}`)
  })

  // ── 4. 带上 Cookie 就能拿到身份（每请求校验 status 的"通过"路径）──
  await it('带会话访问受保护路由 → 200，且身份/角色/首登标记正确', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(response.statusCode, 200, '状态码')
    const body = response.json().data
    assertEqual(body.id, admin.id, 'userId')
    assertEqual(body.username, adminUsername, 'username')
    assertEqual(body.role, 'ADMIN', 'role')
    assertEqual(body.mustChangePassword, false, 'mustChangePassword（建号时显式置 false）')
  })

  // ── 5. `(A)` 端点：ADMIN 放行、MEMBER 403 ──
  await it('requireAdmin：ADMIN → 200，MEMBER → 403 / FORBIDDEN', async () => {
    const asAdmin = await app.inject({
      method: 'GET',
      url: '/__t/admin',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(asAdmin.statusCode, 200, 'ADMIN 访问状态码')

    const memberCookie = await loginAs(app, member.id)
    const asMember = await app.inject({
      method: 'GET',
      url: '/__t/admin',
      headers: cookieHeader(memberCookie.value),
    })
    assertEqual(asMember.statusCode, 403, 'MEMBER 访问状态码')
    assertEqual(asMember.json().code, 'FORBIDDEN', '信封 code')
  })

  // ── 6. 滑动续期与过期（用短 TTL 的独立会话，直接验 store 语义）──
  await it('会话滑动续期：半衰期前**不写**、过半后**续期**、到期后**读不到**（TTL=2s 实测）', async () => {
    const sid = await createSession(member.id, 2)
    sessionIds.push(sid)
    const key = sessionKey(sid)

    const before = await redis.get(key)
    assertEqual(await readSessionUserId(sid, 2), member.id, '刚建好应能读到')
    assertEqual(await redis.get(key), before, '未过半衰期时不应重写会话值（避免每请求一次写）')

    await sleep(1100)
    const ttlBefore = await redis.ttl(key)
    assertEqual(await readSessionUserId(sid, 2), member.id, '续期前应能读到')
    const after = await redis.get(key)
    assert(after !== before, '已过半衰期应续期（值里的 renewedAt 应更新）')
    const ttlAfter = await redis.ttl(key)
    assert(
      ttlAfter > ttlBefore,
      `续期后 TTL 应变长：续期前 ${ttlBefore}s → 续期后 ${ttlAfter}s`,
    )

    await sleep(2200)
    assertEqual(await readSessionUserId(sid, 2), undefined, '超过 TTL 后应读不到')
  })

  await it('会话值被手工改坏 → 读不到且该键被自愈删除（脏数据不留在 Redis 里）', async () => {
    const key = sessionKey('dirty-session-for-verify')
    await redis.set(key, 'this-is-not-json', 'EX', 60)
    assertEqual(await readSessionUserId('dirty-session-for-verify', 60), undefined, '应视为无会话')
    assertEqual(await redis.exists(key), 0, '脏键应被删除')
    await destroySession('dirty-session-for-verify')
  })

  // ── 7. 停用 → **主动失效** → 立即失效（`06` P0-1-6 坑预判的正面）──
  await it('停用 + 写侧主动失效 → 同一 Cookie **立即** 401，且会话键自毁、Cookie 被清', async () => {
    // 先跑一次受保护请求，确保快照缓存此刻是 ACTIVE（否则下面的"立即"没有意义 ——
    // 缓存压根不存在的话，第二步会直接回库读到 DISABLED）
    const warm = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(warm.statusCode, 200, '预热请求应通过')
    assertEqual(await redis.exists(userSnapshotKey(admin.id)), 1, '快照缓存应已写入')

    // P0-1-8 的停用写侧就该做这两件事
    await prisma.user.update({ where: { id: admin.id }, data: { status: UserStatus.DISABLED } })
    await invalidateUserSnapshot(admin.id)

    const response = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(response.statusCode, 401, '状态码（不调 invalidate 时这里最坏能到 60s 才 401）')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
    assert(response.json().msg.includes('停用'), `msg 应点明"停用"，实际：${response.json().msg}`)
    assertEqual(await redis.exists(sessionKey(adminCookie.value)), 0, '会话键应被自毁')
    assertEqual(sessionCookieOf(response).value, '', 'Cookie 应被清空')
  })

  // ── 8. 停用 → **不主动失效** → 由缓存窗口兜底（机制证明）──
  await it('停用但**不**调主动失效 → 缓存窗口内仍放行，窗口一过即 401（机制兜底路径）', async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { status: UserStatus.ACTIVE } })
    await invalidateUserSnapshot(admin.id)

    adminCookie = await loginAs(app, admin.id)
    const first = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(first.statusCode, 200, '重新启用后应能通过')

    // 只改库、不失效缓存 —— 模拟「有人在库里直接改了状态」
    await prisma.user.update({ where: { id: admin.id }, data: { status: UserStatus.DISABLED } })
    const withinWindow = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(withinWindow.statusCode, 200, '缓存窗口内仍应放行（这正是"必须写侧主动失效"的理由）')

    await sleep(1300) // 缓存 TTL 被本脚本压到 1s
    const afterWindow = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(afterWindow.statusCode, 401, '缓存过期后回库应看到 DISABLED 并拒绝')
    console.log(`         ${c.d}缓存窗口 = ${process.env.USER_STATUS_CACHE_TTL_SEC}s（生产为 60s，机制相同）${c.x}`)
  })

  // ── 9. 登出 ──
  await it('登出 → 清 Cookie + 删会话键；同一 Cookie 再用即 401', async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { status: UserStatus.ACTIVE } })
    await invalidateUserSnapshot(admin.id)
    adminCookie = await loginAs(app, admin.id)

    const logout = await app.inject({
      method: 'POST',
      url: '/__t/logout',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(logout.statusCode, 200, '登出状态码')
    assertEqual(sessionCookieOf(logout).value, '', '登出应清 Cookie')
    assertEqual(await redis.exists(sessionKey(adminCookie.value)), 0, '登出应删除会话键（`02` §十「登出即毁」）')

    const after = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(after.statusCode, 401, '登出后再用旧 Cookie 状态码')
  })

  await it('登出是幂等的：无 Cookie / 重复登出都不报错', async () => {
    const first = await app.inject({ method: 'POST', url: '/__t/logout' })
    assertEqual(first.statusCode, 200, '无 Cookie 登出状态码')
    const again = await app.inject({
      method: 'POST',
      url: '/__t/logout',
      headers: cookieHeader(adminCookie.value),
    })
    assertEqual(again.statusCode, 200, '重复登出状态码')
  })

  // ── 10. 用户被删除 → 会话自毁（回库查不到人）──
  await it('用户被删除后 → 旧会话 401 且自毁（缓存窗口一过即回库发现，不等 TTL 到期）', async () => {
    const memberCookie = await loginAs(app, member.id)
    const okResponse = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(memberCookie.value),
    })
    assertEqual(okResponse.statusCode, 200, '删除前应能通过')

    await prisma.user.delete({ where: { id: member.id } })
    createdUserIds.splice(createdUserIds.indexOf(member.id), 1)

    // ⚠️ 必须等缓存窗口过去：快照缓存里还留着这位用户"存在且 ACTIVE"的记录，
    //    窗口内直接断言会拿到 200。生产环境同理 —— 删/停用户一定要走写侧主动失效
    //    （`invalidateUserSnapshot`），否则最坏要等 `USER_STATUS_CACHE_TTL_SEC` 才生效。
    await sleep(1300)

    const response = await app.inject({
      method: 'GET',
      url: '/__t/protected',
      headers: cookieHeader(memberCookie.value),
    })
    assertEqual(response.statusCode, 401, '删除后状态码')
    assertEqual(await redis.exists(sessionKey(memberCookie.value)), 0, '会话键应被自毁')
  })
} finally {
  // ── 清理：删临时用户 + 清本次创建的会话键与快照缓存 ──
  for (const userId of createdUserIds) {
    try {
      await prisma.user.delete({ where: { id: userId } })
    } catch (error) {
      console.log(`  ${c.r}清理用户 ${userId} 失败：${error instanceof Error ? error.message : String(error)}${c.x}`)
    }
    await invalidateUserSnapshot(userId).catch(() => undefined)
  }
  for (const sid of sessionIds) {
    await destroySession(sid).catch(() => undefined)
  }
  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-6 会话验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-6 会话验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
