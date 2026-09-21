#!/usr/bin/env node
/**
 * verify-e2e.mjs —— P0-1-9 的**端到端验收**（需要真实 PG + Redis）
 *
 * 与另四个脚本的分工（关键区别是"经过真实网络与真实进程"）：
 *   · `verify-app`     —— 不依赖任何东西：契约与纯函数（`app.inject`）
 *   · `verify-db`      —— 库结构 + Prisma 客户端
 *   · `verify-session` —— 会话基础设施（Cookie 属性 / Redis 键 / 停用即失效）
 *   · `verify-auth`    —— 四个认证端点的行为（`app.inject`，探针路由）
 *   · `verify-users`   —— 用户管理四端点（`app.inject`）
 *   · **本脚本**        —— `docs/06` P0-1-9 的**六条门槛**，而且：
 *       ① **自己 spawn 一个真实后端进程**（独立端口，默认 13099），走 `http://127.0.0.1`
 *          真实 TCP —— `app.inject` 会跳过 HTTP 传输层（`Set-Cookie` 的序列化、
 *          连接复用、bodyLimit… 都在那一层），端到端就该把这一层也覆盖掉；
 *       ② **完全按 curl 的方式驱动**：手写 Cookie 罐（只认 `doubulea_sid`），
 *          不使用任何测试后门。所以本脚本能跑通，就说明"用户用 curl 照着 README 敲"
 *          也能跑通。
 *
 * 六条门槛（`docs/06` P0-1-9）需要「一个 admin + 一个 MEMBER」这两个账号，
 * 而它们正是种子脚本 `prisma/seed.ts` 的产出 —— 因此本脚本**顺带验种子脚本**：
 * 注入自己的用户名/密码跑两遍（第二遍必须一人不多、密码不变），这也是本批的核心产出。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`
 * 脚本自造 `verify-e2e-*` 前缀的临时账号（含"种子账号"）+ 会话键 + 计数键，结束时删净，
 * 并在最后一项里**自动复核**（残留为零才算通过）。真实 `admin`/`member` 不受影响。
 * 端口被占时可换：`E2E_PORT=13098 pnpm verify:e2e`。
 */

// 必须在 import `config.js`（经 dist 的 app.js）之前设置：一句话会打几十个"应当失败"的请求
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = resolve(BACKEND_DIR, 'dist/backend/src/index.js')
const SEED_ENTRY = resolve(BACKEND_DIR, 'dist/backend/prisma/seed.js')

const { verifyPassword, INITIAL_PASSWORD_LENGTH } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma } = await import('../dist/backend/src/infra/prisma.js')
const {
  clearLoginFailures,
  closeRedis,
  ensureRedisConnected,
  getRedis,
  invalidateUserSnapshot,
  loginFailKey,
  sessionKey,
} = await import('../dist/backend/src/infra/redis.js')
const { normalizeUsername } = await import('@doubulea/shared')

// ───────────────────────────── 断言脚手架（与另四个脚本同一套）─────────────────────────────

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

// ───────────────────────────── 测试数据 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
/** 门槛里点名的两条文案（与实现逐字对齐；不一致就说明口径变了） */
const GATE_MESSAGE_FRAGMENT = '修改密码'
const PERMISSION_MESSAGE_FRAGMENT = '仅限管理员'

const suffix = Math.random().toString(36).slice(2, 8)
/** 种子账号（由 `prisma/seed.ts` 创建，密码由本脚本注入 —— 否则无从知晓随机密码） */
const seedAdmin = { username: `verify-e2e-admin-${suffix}`, password: `E2e-Seed-Admin-${suffix}` }
const seedMember = { username: `verify-e2e-member-${suffix}`, password: `E2e-Seed-Member-${suffix}` }
/** 由 admin 通过 API 建出来的号（门槛 1 的"用户"） */
const apiCreated = { username: `verify-e2e-created-${suffix}`, nickname: '端到端验的号' }
const changedPassword = `E2e-Changed-${suffix}`

const port = Number.parseInt((process.env.E2E_PORT ?? '').trim() || '13099', 10)
const baseUrl = `http://127.0.0.1:${port}`

/** 清理清单（账号不列在这里：一律按 `verify-e2e-` 前缀清扫，见 cleanupTemporaryData） */
const sessionIds = []
const touchedUsernames = [seedAdmin.username, seedMember.username, apiCreated.username]

const prisma = getPrisma()
const redis = getRedis()

// ───────────────────────────── 真实 HTTP 客户端（手写 Cookie 罐）─────────────────────────────

/** 发一次真实 HTTP 请求，并把会话 Cookie 的变化反映到 `jar` 上（`''` = 已被清） */
async function request(jar, method, path, body) {
  const headers = {}
  if (jar.value !== '') headers.cookie = `${SESSION_COOKIE_NAME}=${jar.value}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()

  // 只认会话 Cookie；带 `Max-Age=0`（登出）时值是空串 → 罐子清空
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (pair.slice(0, eq) !== SESSION_COOKIE_NAME) continue
    jar.value = pair.slice(eq + 1)
    if (jar.value !== '') sessionIds.push(jar.value)
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch {
    json = undefined
  }
  return { status: response.status, raw, body: json, setCookies: response.headers.getSetCookie() }
}

const newJar = () => ({ value: '' })

/** 登录（不抛错，便于断言失败态）；成功后罐子自动带上会话 */
async function login(jar, username, password) {
  return request(jar, 'POST', '/api/auth/login', { username, password })
}

// ───────────────────────────── 子进程：种子脚本 / 后端服务 ─────────────────────────────

/** 跑一次种子脚本（注入账号名与密码，测试才可能知道密码） */
function runSeed(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEED_ENTRY], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        SEED_ADMIN_USERNAME: seedAdmin.username,
        SEED_ADMIN_PASSWORD: seedAdmin.password,
        SEED_MEMBER_USERNAME: seedMember.username,
        SEED_MEMBER_PASSWORD: seedMember.password,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => resolve({ code, output }))
  })
}

let server
let serverLog = ''

/**
 * 起一个真实后端进程（独立端口）并等它真的能服务 `/health`。
 *
 * 起来之前先探一次端口：若已有进程在回答，说明端口被占 —— 此时不能继续，
 * 否则后续断言会打在别人的服务上（症状是"莫名其妙的 404"，很难查）。
 */
async function startServer() {
  try {
    const probe = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
    if (probe.ok) throw new Error(`端口 ${port} 上已有服务在回答，请换端口：E2E_PORT=… pnpm verify:e2e`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('已有服务')) throw error
    // 连不上才是预期的（端口空闲）
  }

  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      BACKEND_PORT: String(port),
      // P0-1-17 起 index.ts 会启动流水线 worker，而队列是"被消费"的资源：给这个一次性进程
      // 一条独立队列，免得它跟本机跑着的 dev server 抢任务（本档不上传文档，只是卫生习惯）
      PIPELINE_QUEUE_KEY: `verify:e2e:jobs:${Math.random().toString(36).slice(2, 8)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (chunk) => (serverLog += chunk))
  server.stderr.on('data', (chunk) => (serverLog += chunk))

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`后端进程未能在 20s 内就绪（exitCode=${server.exitCode}）\n${serverLog}`)
}

/** 停掉后端进程：先 SIGTERM（走优雅退出），5s 不退再 SIGKILL */
async function stopServer() {
  if (server === undefined || server.exitCode !== null) return
  const exited = new Promise((resolve) => server.once('close', resolve))
  server.kill('SIGTERM')
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}

/**
 * 清掉本脚本造的一切（幂等，正常路径与异常路径都调）。
 *
 * 账号按**前缀**扫而不是只按内存里的清单：万一某次跑到一半崩了，内存清单就丢了，
 * 前缀清扫能把上一轮的残骸一起收掉（P0-1-7 的教训：清理范围要枚举全，
 * 包括"顺手创建的"键 —— 本脚本按用户名尝试登录也会建 `login-fail:*`）。
 */
async function cleanupTemporaryData() {
  for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
  for (const username of touchedUsernames) {
    await clearLoginFailures(normalizeUsername(username)).catch(() => undefined)
  }
  const leftovers = await prisma.user.findMany({
    where: { username: { startsWith: 'verify-e2e-' } },
    select: { id: true },
  })
  for (const user of leftovers) {
    await invalidateUserSnapshot(user.id).catch(() => undefined)
  }
  const removed = await prisma.user.deleteMany({ where: { username: { startsWith: 'verify-e2e-' } } })
  return removed.count
}

// ───────────────────────────── 主流程 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-9 端到端验收：种子脚本 + 六条门槛（真实进程 / 真实 HTTP）══${c.x}`)
console.log(`  ${c.d}目标：${baseUrl}（独立端口，不碰你的 13000）；脚本会自己起服务、自己造号、跑完删净${c.x}`)

try {
  await ensureRedisConnected()
  await redis.ping()
  await prisma.$queryRaw`SELECT 1`

  // ══════════ 第 0 段：种子脚本（门槛 1/6 的账号来源）══════════
  await it('种子脚本首次执行 → 退出码 0 且建出两个账号（admin 首登改密态 / MEMBER）', async () => {
    const { code, output } = await runSeed()
    assertEqual(code, 0, '种子脚本退出码')
    assert(output.includes('已创建'), `输出应报告"已创建"，实际：\n${output}`)

    const users = await prisma.user.findMany({
      where: { username: { in: [seedAdmin.username, seedMember.username] } },
      select: { id: true, username: true, role: true, status: true, mustChangePassword: true, passwordHash: true },
    })
    assertEqual(users.length, 2, '库里应有的种子账号数')

    const admin = users.find((user) => user.username === seedAdmin.username)
    const member = users.find((user) => user.username === seedMember.username)
    assert(admin !== undefined && member !== undefined, '两个账号都应存在')
    assertEqual(admin.role, 'ADMIN', 'admin 角色')
    assertEqual(member.role, 'MEMBER', 'member 角色')
    assertEqual(admin.status, 'ACTIVE', 'admin 状态')
    assertEqual(admin.mustChangePassword, true, 'admin 应是首登改密态')
    assertEqual(member.mustChangePassword, true, 'member 应是首登改密态')
    // 注入的密码真的被用上了（顺带证明种子脚本走的是同一套 bcrypt 封装，而不是明文落库）
    assert(await verifyPassword(seedAdmin.password, admin.passwordHash), '种子 admin 的密码哈希应能校验注入的密码')
    assert(
      (await verifyPassword('not-the-seeded-password', admin.passwordHash)) === false,
      '别的密码不该通过校验',
    )
  })

  await it('种子脚本**幂等**：再跑一次 → 退出码 0、不新建、**密码哈希一字不变**', async () => {
    const before = await prisma.user.findMany({
      where: { username: { in: [seedAdmin.username, seedMember.username] } },
      select: { username: true, passwordHash: true },
      orderBy: { username: 'asc' },
    })

    const { code, output } = await runSeed()
    assertEqual(code, 0, '第二次退出码')
    assert(output.includes('已存在（密码未改动）'), `第二次应报告"已存在"，实际：\n${output}`)

    const after = await prisma.user.findMany({
      where: { username: { in: [seedAdmin.username, seedMember.username] } },
      select: { username: true, passwordHash: true },
      orderBy: { username: 'asc' },
    })
    assertEqual(after.length, 2, '第二次不应多出账号')
    assertEqual(JSON.stringify(after), JSON.stringify(before), '两次的密码哈希必须完全一致（种子不该覆盖密码）')
  })

  await it('`SEED_RESET_PASSWORD=1` 才重置：显式请求 → 密码换新且打回首登改密态', async () => {
    // 先把 admin 改成"已改密"状态，模拟"这个人自己改过密码了"
    await prisma.user.update({
      where: { username: seedAdmin.username },
      data: { mustChangePassword: false },
    })
    const before = await prisma.user.findUnique({
      where: { username: seedAdmin.username },
      select: { passwordHash: true },
    })

    const { code, output } = await runSeed({ SEED_RESET_PASSWORD: '1' })
    assertEqual(code, 0, '退出码')
    assert(output.includes('已重置密码'), `输出应报告"已重置密码"，实际：\n${output}`)

    const admin = await prisma.user.findUnique({ where: { username: seedAdmin.username } })
    assertEqual(admin?.mustChangePassword, true, '重置后应回到首登改密态')
    assert(admin !== null && admin.passwordHash !== before?.passwordHash, '重置应真的换掉密码哈希')
    assert(admin !== null && (await verifyPassword(seedAdmin.password, admin.passwordHash)), '重置后应能用注入的密码通过校验')
    // 本步在 spawn 服务之前，所以只用库层取证；"重置后旧密码登录失败"由改密链路的
    // `verify-auth`（门槛 2 同款语义）覆盖，这里不重复起服务。
  })

  // ══════════ 起真实服务 ══════════
  await startServer()
  console.log(`  ${c.d}后端已在 ${baseUrl} 就绪（子进程 pid=${server.pid}）${c.x}`)

  // ══════════ 门槛 1（前半）：首登 admin 登录 → 被强制改密 ══════════
  const adminJar = newJar()
  await it('门槛 1｜种子 admin 用初始密码登录 → 200 + mustChangePassword=true + HttpOnly Cookie', async () => {
    const response = await login(adminJar, seedAdmin.username, seedAdmin.password)
    assertEqual(response.status, 200, '状态码')
    assertEqual(response.body.data.username, seedAdmin.username, 'username')
    assertEqual(response.body.data.role, 'ADMIN', 'role')
    assertEqual(response.body.data.mustChangePassword, true, 'mustChangePassword')
    assert(adminJar.value !== '', '应下发会话 Cookie')
    const setCookie = response.setCookies.find((header) => header.startsWith(SESSION_COOKIE_NAME))
    assert(setCookie !== undefined && setCookie.includes('HttpOnly'), `Cookie 应带 HttpOnly：${setCookie ?? '（无）'}`)
    assert(response.raw.includes('password') === false, '响应体不应出现任何 password 字段')
  })

  await it('门槛 1｜首登态的 admin 调 /api/users → 403 且提示改密（闸门先于权限/业务）', async () => {
    const response = await request(adminJar, 'GET', '/api/users')
    assertEqual(response.status, 403, '状态码')
    assertEqual(response.body.code, 'FORBIDDEN', '信封 code')
    assert(
      response.body.msg.includes(GATE_MESSAGE_FRAGMENT),
      `msg 应提示必须改密，实际：${response.body.msg}`,
    )
  })

  await it('门槛 1｜admin 改密 → 200 + mustChangePassword 转 false；**同一个 Cookie** 立刻能建号（不缓存延迟）', async () => {
    const changed = await request(adminJar, 'POST', '/api/auth/password', {
      oldPassword: seedAdmin.password,
      newPassword: changedPassword,
    })
    assertEqual(changed.status, 200, '改密状态码')
    assertEqual(changed.body.data.mustChangePassword, false, 'mustChangePassword')

    const listing = await request(adminJar, 'GET', '/api/users?limit=100')
    assertEqual(listing.status, 200, '改密后 /api/users 应立即放行')
    assert(Array.isArray(listing.body.data.items), '列表应返回 items 数组')
  })

  // ══════════ 门槛 1（后半）：admin 建号 → 初始密码 ══════════
  let createdUser
  let createdInitialPassword
  await it(
    `门槛 1｜admin 建号 → 200 + 一次性初始密码（${INITIAL_PASSWORD_LENGTH} 字符、无易混字符）`,
    async () => {
      const response = await request(adminJar, 'POST', '/api/users', {
        username: apiCreated.username,
        nickname: apiCreated.nickname,
      })
      assertEqual(response.status, 200, '状态码')
      const data = response.body.data
      createdUser = data.user
      createdInitialPassword = data.initialPassword
      assertEqual(typeof createdInitialPassword, 'string', 'initialPassword 类型')
      assertEqual(createdInitialPassword.length, INITIAL_PASSWORD_LENGTH, '初始密码长度')
      assert(/[0O1lI]/.test(createdInitialPassword) === false, '初始密码不应含易混字符')
      assertEqual(createdUser.username, apiCreated.username, 'username')
      assertEqual(createdUser.role, 'MEMBER', '缺省 role')
      assertEqual(createdUser.mustChangePassword, true, '建号即必须改密')
      console.log(`         ${c.d}新建 ${createdUser.username}（${createdUser.id}）；初始密码只在响应里出现这一次${c.x}`)
    },
  )

  const userJar = newJar()
  await it('门槛 1｜新用户用初始密码登录成功 → mustChangePassword=true，且业务接口被闸门拦在 403', async () => {
    const response = await login(userJar, apiCreated.username, createdInitialPassword)
    assertEqual(response.status, 200, '登录状态码')
    assertEqual(response.body.data.mustChangePassword, true, 'mustChangePassword')
    assert(userJar.value !== '', '应下发会话 Cookie')

    const gated = await request(userJar, 'GET', '/api/users')
    assertEqual(gated.status, 403, '首登态的 /api/users 状态码')
    assert(gated.body.msg.includes(GATE_MESSAGE_FRAGMENT), `msg 应提示改密，实际：${gated.body.msg}`)
  })

  // ══════════ 门槛 2：旧密码错误 → 明确报错且不修改 ══════════
  await it('门槛 2｜改密时旧密码错误 → 400 + 字段明细指向 body.oldPassword，且**密码未被修改**', async () => {
    const response = await request(userJar, 'POST', '/api/auth/password', {
      oldPassword: 'definitely-not-the-old-one',
      newPassword: changedPassword,
    })
    assertEqual(response.status, 400, '状态码')
    assertEqual(response.body.code, 'VALIDATION', '信封 code')
    const fields = response.body.data.fields
    assert(Array.isArray(fields) && fields.length > 0, '应给出 field 级明细')
    assertEqual(fields[0].path, 'body.oldPassword', '字段路径')

    // "不修改"的取证：初始密码仍然能登录
    const stillWorks = await login(newJar(), apiCreated.username, createdInitialPassword)
    assertEqual(stillWorks.status, 200, '旧密码应仍然有效（说明失败那次什么都没改）')
  })

  await it('门槛 2｜新密码不合策略（过短 / 超 72 字节）→ 400 + 字段明细', async () => {
    for (const [label, newPassword] of [
      ['过短', 'short1'],
      ['超 72 字节', '中'.repeat(25)],
    ]) {
      const response = await request(userJar, 'POST', '/api/auth/password', {
        oldPassword: createdInitialPassword,
        newPassword,
      })
      assertEqual(response.status, 400, `${label} 状态码`)
      assert(
        response.body.data.fields.some((field) => field.path === 'body.newPassword'),
        `${label} 应报 body.newPassword`,
      )
    }
  })

  // ══════════ 门槛 3：改密成功 → 闸门放行，进入权限判定 ══════════
  await it('门槛 3｜改密成功 → mustChangePassword 转 false；同一 Cookie 下**闸门放行**（403 的理由变成权限）', async () => {
    const response = await request(userJar, 'POST', '/api/auth/password', {
      oldPassword: createdInitialPassword,
      newPassword: changedPassword,
    })
    assertEqual(response.status, 200, '状态码')
    assertEqual(response.body.data.mustChangePassword, false, 'mustChangePassword')

    const me = await request(userJar, 'GET', '/api/auth/me')
    assertEqual(me.status, 200, '/api/auth/me 状态码')
    assertEqual(me.body.data.mustChangePassword, false, '/auth/me 应立刻反映')

    // ⚠️ 本仓目前还没有"MEMBER 可用的业务接口"（`/api/agents` 在 E 包），
    //    所以用 403 的**文案**来区分两条不同的 403：改密前是闸门，改密后是权限。
    const afterChange = await request(userJar, 'GET', '/api/users')
    assertEqual(afterChange.status, 403, 'MEMBER 调 /api/users 仍是 403（但理由不同了）')
    assert(
      afterChange.body.msg.includes(PERMISSION_MESSAGE_FRAGMENT),
      `改密后应是权限文案，实际：${afterChange.body.msg}`,
    )
    assert(
      afterChange.body.msg.includes(GATE_MESSAGE_FRAGMENT) === false,
      `不该再出现改密文案（说明闸门已放行），实际：${afterChange.body.msg}`,
    )
  })

  await it('门槛 3｜改密后：新密码可登录、旧密码失效（同样用通用文案，不泄露账号是否存在）', async () => {
    const withNew = await login(newJar(), apiCreated.username, changedPassword)
    assertEqual(withNew.status, 200, '新密码状态码')

    const withOld = await login(newJar(), apiCreated.username, createdInitialPassword)
    assertEqual(withOld.status, 401, '旧密码状态码')
    assertEqual(withOld.body.msg, '用户名或密码错误', '旧密码失败应用通用文案')
  })

  // ══════════ 门槛 4：停用 → 已登录的会话立即失效 ══════════
  await it('门槛 4｜停用账号 → 该账号**已登录的会话下一个请求就 401**（远强于"60s 内"）', async () => {
    const jar = newJar()
    const login1 = await login(jar, apiCreated.username, changedPassword)
    assertEqual(login1.status, 200, '停用前登录')
    const alive = await request(jar, 'GET', '/api/auth/me')
    assertEqual(alive.status, 200, '停用前 /auth/me')

    const disabled = await request(adminJar, 'PATCH', `/api/users/${createdUser.id}`, { status: 'DISABLED' })
    assertEqual(disabled.status, 200, '停用状态码')
    assertEqual(disabled.body.data.status, 'DISABLED', 'status')

    const afterDisable = await request(jar, 'GET', '/api/auth/me')
    assertEqual(afterDisable.status, 401, '停用后同一 Cookie 的状态码')
    assertEqual(afterDisable.body.code, 'UNAUTHORIZED', '信封 code')
    assertEqual(await redis.exists(sessionKey(jar.value)), 0, '该会话键应已被自毁')

    // 停用后该账号连登录都被拒（凭据正确也进不来）
    const blocked = await login(newJar(), apiCreated.username, changedPassword)
    assertEqual(blocked.status, 401, '停用后登录状态码')
    assert(blocked.body.msg.includes('停用'), `msg 应点明已停用，实际：${blocked.body.msg}`)
  })

  // ══════════ 门槛 5：连续 5 次密码错误 → 第 6 次锁定 ══════════
  await it('门槛 5｜同账号连续 5 次错误仍是 401，第 6 次 → 429「已锁定，请 10 分钟后重试」', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const response = await login(newJar(), seedMember.username, `wrong-password-${i}`)
      assertEqual(response.status, 401, `第 ${i} 次状态码`)
      assertEqual(response.body.msg, '用户名或密码错误', `第 ${i} 次文案`)
    }
    assertEqual(await redis.get(loginFailKey(seedMember.username)), '5', '计数键的值')

    const sixth = await login(newJar(), seedMember.username, seedMember.password)
    assertEqual(sixth.status, 429, '第 6 次状态码')
    assertEqual(sixth.body.code, 'BUSY', '信封 code')
    assert(sixth.body.msg.includes('已锁定'), `msg 应点明已锁定，实际：${sixth.body.msg}`)
    assert(/分钟后重试/.test(sixth.body.msg), `msg 应给出重试时间，实际：${sixth.body.msg}`)
    console.log(`         ${c.d}第 6 次：「${sixth.body.msg}」（剩余 ${sixth.body.data?.retryAfterSec}s）${c.x}`)
  })

  // ══════════ 门槛 6：MEMBER 403 / admin 200 ══════════
  await it('门槛 6｜已改密的 MEMBER 调 /api/users → 403 FORBIDDEN；admin → 200（同一路径、两种角色）', async () => {
    // 复用上面那个"已改密"的 MEMBER：它此刻是被停用的，先启用回来（顺带验启用）
    const enabled = await request(adminJar, 'PATCH', `/api/users/${createdUser.id}`, { status: 'ACTIVE' })
    assertEqual(enabled.status, 200, '启用状态码')

    const memberJar = newJar()
    const memberLogin = await login(memberJar, apiCreated.username, changedPassword)
    assertEqual(memberLogin.status, 200, 'MEMBER 登录')
    assertEqual(memberLogin.body.data.mustChangePassword, false, '应是已改密态')

    const denied = await request(memberJar, 'GET', '/api/users')
    assertEqual(denied.status, 403, 'MEMBER 状态码')
    assertEqual(denied.body.code, 'FORBIDDEN', 'MEMBER 信封 code')
    assert(denied.body.msg.includes(PERMISSION_MESSAGE_FRAGMENT), `MEMBER 应是权限文案，实际：${denied.body.msg}`)

    const allowed = await request(adminJar, 'GET', '/api/users?limit=5')
    assertEqual(allowed.status, 200, 'ADMIN 状态码')
    assertEqual(allowed.body.code, 0, 'ADMIN 信封 code')
  })

  // ══════════ 收尾：登出（HTTP 层的会话收口）══════════
  await it('登出 → 200 + 清 Cookie；旧 Cookie 再用即 401（会话收发在真实 HTTP 上闭合）', async () => {
    const jar = newJar()
    await login(jar, seedAdmin.username, changedPassword)
    const sid = jar.value

    const logout = await request(jar, 'POST', '/api/auth/logout')
    assertEqual(logout.status, 200, '登出状态码')
    assertEqual(jar.value, '', '登出后 Cookie 罐应被清')
    assertEqual(await redis.exists(sessionKey(sid)), 0, '会话键应被删除')

    const me = await request({ value: sid }, 'GET', '/api/auth/me')
    assertEqual(me.status, 401, '登出后旧 Cookie 状态码')
  })

  // ══════════ 收尾：停服务 + 自清理 + **复核残留为零** ══════════
  // 「自清理」写成一条断言，而不是只放在 finally 里的"尽力而为"：
  // 一个会污染开发库的验收脚本，比没有脚本更危险（下一个人会以为库里的怪数据是自己造成的）。
  await stopServer()
  const removedCount = await cleanupTemporaryData()
  await it('自清理复核：临时账号 / 会话键 / 登录失败计数残留为零', async () => {
    assertEqual(removedCount > 0, true, `应真的删掉了东西（本次删了 ${removedCount} 个）`)
    assertEqual(
      await prisma.user.count({ where: { username: { startsWith: 'verify-e2e-' } } }),
      0,
      '残留临时账号数',
    )
    for (const username of touchedUsernames) {
      assertEqual(await redis.exists(loginFailKey(username)), 0, `${username} 的登录失败计数键`)
    }
    for (const sid of sessionIds) {
      assertEqual(await redis.exists(sessionKey(sid)), 0, `会话键 ${sid.slice(0, 8)}…`)
    }
  })
  console.log(`  ${c.d}本次共清理 ${removedCount} 个临时账号、${sessionIds.length} 个会话键${c.x}`)
} finally {
  // 异常路径的兜底清理（幂等；上面正常跑完时这里基本都是空操作）
  await stopServer().catch(() => undefined)
  await cleanupTemporaryData().catch(() => undefined)
  await closePrisma()
  await closeRedis()

  console.log('')
  if (failed === 0) {
    console.log(`${c.g}${c.b}✅ P0-1-9 端到端验收通过：${passed} 项全通过${c.x}`)
  } else {
    console.log(`${c.r}${c.b}❌ P0-1-9 端到端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
    if (serverLog !== '') console.log(`${c.r}（后端进程日志）\n${serverLog}${c.x}`)
  }
}

process.exit(failed === 0 ? 0 : 1)
