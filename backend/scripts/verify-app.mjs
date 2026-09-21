#!/usr/bin/env node
/**
 * verify-app.mjs —— **接口级验收**（不占端口、不需要真实依赖）
 *
 * 覆盖三批：
 *   · P0-1-4：信封形态 / HTTP 状态码 / Zod 校验失败字段明细 / 领域错误 / 未知异常不泄内部信息 /
 *             404 兜底 / 非法 JSON / CORS 预检 / requestId 透传 / `/health` 三项探活恒 200
 *   · P0-1-6：密文往返与**篡改检出**（GCM tag）/ 版本与 AAD 上下文 / bcrypt 形态与拒绝超长 /
 *             初始密码生成 / **未登录一律 401 且不碰会话存储**
 *   · P0-1-7：`/api/auth/*` 已注册 + 请求体 schema 的字段明细 + 首登闸门不给匿名请求增加依赖调用 /
 *             shared 认证契约的纯函数（`utf8ByteLength` 与 `Buffer.byteLength` 对照、用户名归一化）
 *
 * 会话与认证的**行为**（Cookie 属性、限速锁定、首登闸门 403、改密）离不开真实 Redis/PG，
 * 分别由 `verify-session.mjs` / `verify-auth.mjs` 覆盖 —— 那两档要 `pnpm infra:up`。
 *
 * 为什么用 `app.inject` 而不是 curl：
 *   ① 本机端口是稀缺资源（3000/5173 都被别的项目占着，见 `06` §七 待决事项 6），
 *      inject 直接走 Fastify 内部请求生命周期，不监听、不留端口；
 *   ② CI 里不需要 docker-compose 就能验证 HTTP 层契约（依赖探活失败也是一种可断言的状态）。
 *
 * 验的是「协议契约」+「纯函数正确性」，不是「依赖可用性」——会话在真实 Redis/PG 上的
 * 完整往返（Cookie 属性、停用即失效、登出、滑动续期）在 `verify-session.mjs` 里跑，
 * 那一个**需要** `pnpm infra:up` + 已迁移的库。
 *
 * 附加探针路由（`/__verify/*`）由**本脚本自己注册**，不进源码树：
 *   产品代码里只有 `/health` 一个路由，测试用的路由不该混进去。
 *
 * 用法：
 *   pnpm verify:app                     # 本机（依赖起着 → 断言 /health 全绿）
 *   EXPECT_DEGRADED=1 pnpm verify:app   # 无依赖环境（CI）→ 断言三项探活全部降级
 */

import { z } from 'zod'

import {
  AppError,
  PASSWORD_MAX_BYTES,
  authUserSchema,
  changePasswordBodySchema,
  loginBodySchema,
  normalizeUsername,
  ok,
  utf8ByteLength,
} from '@doubulea/shared'
import { buildApp } from '../dist/backend/src/app.js'
import {
  BCRYPT_COST,
  DUMMY_PASSWORD_HASH,
  INITIAL_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  SecretDecryptionError,
  SecretFormatError,
  decryptSecret,
  encryptSecret,
  generateInitialPassword,
  hashPassword,
  passwordByteLength,
  verifyPassword,
} from '../dist/backend/src/infra/crypto.js'
import { closePg } from '../dist/backend/src/infra/pg.js'
import { closeRedis } from '../dist/backend/src/infra/redis.js'

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

/** 单条断言 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

/** 跑一条用例：失败不中断（一次跑完，把问题看全） */
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

const expectDegraded = process.env.EXPECT_DEGRADED === '1'

console.log(`\n${c.b}══ 接口级验收：Fastify 骨架 / 错误信封 / /health / 密码与会话基础设施 ══${c.x}`)
console.log(`  ${c.d}模式：${expectDegraded ? '依赖全部不可达（断言 degraded）' : '本机依赖（断言 /health 全绿）'}${c.x}`)

const app = buildApp()

// ── 探针路由：只在本脚本里注册，用来把错误处理的每条分支都真跑一遍 ──
app.post(
  '/__verify/echo',
  {
    schema: {
      body: z.object({ name: z.string().min(2), age: z.coerce.number().int().min(0) }),
      querystring: z.object({ page: z.coerce.number().int().min(1).default(1) }),
    },
  },
  async (request) => ok({ body: request.body, query: request.query }),
)
// 极小的 bodyLimit：用来验证「请求体过大」（413）也被翻译成信封
app.post(
  '/__verify/tiny',
  { bodyLimit: 32, schema: { body: z.object({ note: z.string() }) } },
  async (request) => ok(request.body),
)
app.get('/__verify/conflict', () => {
  throw AppError.conflict('该会话正在生成回答', { position: 2 })
})
app.get('/__verify/boom', () => {
  // 故意夹带「内部细节」：验证它**不会**出现在响应体里（`02` §十）
  throw new Error('内部细节：secret-token-abc / password=hunter2')
})
// 会话探针（P0-1-6）：`requireAuth` 的实现里，「无 Cookie」这一条**不碰 Redis**，
// 因此它在有/无依赖两种环境下都应当稳定返回 401 —— 这正是下面要断言的。
app.get('/__verify/protected', { preHandler: app.requireAuth }, async (request) =>
  ok({ userId: request.auth?.user.id, role: request.auth?.user.role }),
)
app.get('/__verify/admin-only', { preHandler: app.requireAdmin }, async () => ok({ scope: 'admin' }))
// 首登闸门（P0-1-7）的探针：一个 `/api/**` 下的**公共**路由（不挂任何鉴权钩子）。
// 用来验「闸门不会给匿名请求增加依赖调用」—— 没有 Cookie 时闸门必须直接放行，
// 否则依赖不可达的 CI 里这条会变成 500（而它本该是 200）。
app.get('/api/__verify/open', async () => ok({ open: true }))

await app.ready()

// ── 1. /health ──
await it('/health 返回 200 + 信封 + 三项依赖状态', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  assertEqual(response.statusCode, 200, 'HTTP 状态码（依赖不可用也必须是 200，不是 500）')
  const body = response.json()
  assertEqual(body.code, 0, '信封 code')
  assertEqual(body.data.service, 'doubulea-backend', 'service')
  assertEqual(body.data.checks.map((check) => check.target).join(','), 'postgres,redis,s3', '探活顺序')
  for (const check of body.data.checks) {
    assert(typeof check.latencyMs === 'number' && check.latencyMs >= 0, `${check.target}.latencyMs 应为非负数字`)
    assert(typeof check.detail === 'string' && check.detail !== '', `${check.target}.detail 不应为空`)
  }
  const allOk = body.data.checks.every((check) => check.ok)
  assertEqual(body.data.status, allOk ? 'ok' : 'degraded', 'status 与各项探活结论一致')
  assert(typeof body.data.timeoutMs === 'number', 'timeoutMs 应回显，便于对照「超时」类原因')
  console.log(`         ${c.d}${JSON.stringify(body.data.checks.map((x) => `${x.target}=${x.ok ? 'ok' : x.detail}`))}${c.x}`)
})

if (expectDegraded) {
  await it('/health 在依赖不可达时**逐项**报出原因（而非整体报错）', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health' })).json()
    assertEqual(body.data.status, 'degraded', 'status')
    for (const check of body.data.checks) {
      assertEqual(check.ok, false, `${check.target} 应判为不可用`)
      assertEqual(check.detail.includes('超时'), false, `${check.target} 应立即失败（连接被拒），不应走到超时兜底`)
    }
  })
}

// ── 2. Zod 校验失败 → VALIDATION 信封 + 字段明细 ──
await it('Zod 校验失败 → 400 / VALIDATION / body 字段级 path（多条一次报全）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    payload: { name: 'x', age: 'not-a-number' },
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  const paths = body.data.fields.map((field) => field.path)
  assert(paths.includes('body.name'), `应报出 body.name，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.age'), `应报出 body.age，实际 ${JSON.stringify(paths)}`)
})

await it('querystring 校验失败同样带部位前缀（body 合法时才轮到它）', async () => {
  // ⚠️ Fastify 按 params → body → querystring 顺序校验，**任一处失败即短路**，
  //    所以必须给合法 body 才能验到 querystring 这一路
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo?page=0',
    payload: { name: 'ab', age: 3 },
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  const paths = response.json().data.fields.map((field) => field.path)
  assert(paths.includes('querystring.page'), `应报出 querystring.page，实际 ${JSON.stringify(paths)}`)
})

await it('校验通过时 coerce/transform 的产物对 handler 可见', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    payload: { name: 'ab', age: '30' },
  })
  assertEqual(response.statusCode, 200, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.data.body.age, 30, 'body.age 应已被 z.coerce 转成数字')
  assertEqual(body.data.query.page, 1, 'querystring.page 应取到默认值 1')
})

// ── 3. 领域错误原样带出 ──
await it('领域错误（AppError）→ 409 / CONFLICT / msg + data 原样', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/conflict' })
  assertEqual(response.statusCode, 409, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'CONFLICT', '信封 code')
  assertEqual(body.msg, '该会话正在生成回答', 'msg 应是领域错误自带的中文文案')
  assertEqual(body.data.position, 2, 'data 应带出附加信息')
})

// ── 4. 未知异常：500 + 通用文案，不泄内部信息 ──
await it('未知异常 → 500 / INTERNAL，且**不回显**原始 message', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/boom' })
  assertEqual(response.statusCode, 500, 'HTTP 状态码')
  const raw = response.body
  assert(raw.includes('secret-token-abc') === false, '原始错误信息泄露到响应体（`02` §十 不允许）')
  assert(raw.includes('hunter2') === false, '密码片段泄露到响应体')
  const body = JSON.parse(raw)
  assertEqual(body.code, 'INTERNAL', '信封 code')
  assertEqual(body.msg, '服务内部错误', 'msg 应为通用文案')
})

// ── 5. 404 兜底 ──
await it('未注册路由 → 404 / NOT_FOUND（不是 Fastify 默认结构）', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/nope' })
  assertEqual(response.statusCode, 404, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'NOT_FOUND', '信封 code')
  assert(typeof body.msg === 'string' && body.msg !== '', 'msg 不应为空')
})

// ── 6. 请求体形态错误 ──
await it('非法 JSON → 400 / VALIDATION（框架错误被翻译成信封）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json',
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  assertEqual(response.json().code, 'VALIDATION', '信封 code')
})

await it('不支持的 Content-Type → 415 / VALIDATION（状态码保持 415 不被压成 400）', async () => {
  // ⚠️ Fastify 默认自带 application/json 与 text/plain 两个 parser，
  //    要触发 415 得用一个它没注册的类型
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    headers: { 'content-type': 'application/xml' },
    payload: '<name>ab</name>',
  })
  assertEqual(response.statusCode, 415, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  assert(body.msg.includes('Content-Type'), `msg 应说清是 Content-Type 的问题，实际：${body.msg}`)
})

await it('请求体超限 → 413 / VALIDATION（上限信息保留在状态码上）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/tiny',
    payload: { note: 'x'.repeat(200) },
  })
  assertEqual(response.statusCode, 413, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  assert(body.msg.length > 0, 'msg 不应为空')
})

// ── 7. CORS 预检 ──
await it('CORS 预检 → 回显来源且允许携带凭据', async () => {
  const origin = 'http://localhost:5174'
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: { origin, 'access-control-request-method': 'GET' },
  })
  assertEqual(response.statusCode, 204, '预检状态码')
  assertEqual(response.headers['access-control-allow-origin'], origin, 'allow-origin 应回显配置的来源')
  assertEqual(response.headers['access-control-allow-credentials'], 'true', '必须允许携带 Cookie')
})

// ── 8. requestId 贯穿 ──
await it('requestId：上游 x-request-id 透传 + 响应头回带', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { 'x-request-id': 'verify-rid-123' },
  })
  assertEqual(response.headers['x-request-id'], 'verify-rid-123', '响应头应回带同一个 requestId')

  const generated = await app.inject({ method: 'GET', url: '/health' })
  assert(
    typeof generated.headers['x-request-id'] === 'string' && generated.headers['x-request-id'].length > 0,
    '未提供 x-request-id 时应自动生成',
  )
})

// ── 9. 密文加解密（P0-1-6）：往返 / 篡改检出 / 版本 / AAD ──
const SAMPLE = 'sk-live-这是一个带中文与 emoji 🔐 的密钥-0O1lI'

await it('AES-256-GCM 往返一致（含中文/emoji/空串），且密文形态为 v1.<iv>.<tag>.<ct>', async () => {
  const encrypted = encryptSecret(SAMPLE)
  assertEqual(decryptSecret(encrypted), SAMPLE, '解密结果')
  const parts = encrypted.split('.')
  assertEqual(parts.length, 4, '密文段数')
  assertEqual(parts[0], 'v1', '版本前缀')
  assertEqual(decryptSecret(encryptSecret('')), '', '空串也应能往返')
  console.log(`         ${c.d}${encrypted.slice(0, 46)}…（${encrypted.length} 字符）${c.x}`)
})

await it('同一明文两次加密得到**不同**密文（IV 随机），且明文不出现在密文里', async () => {
  const a = encryptSecret(SAMPLE)
  const b = encryptSecret(SAMPLE)
  assert(a !== b, '两次加密结果相同 —— IV 没有随机化')
  assertEqual(decryptSecret(a), SAMPLE, 'a 解密')
  assertEqual(decryptSecret(b), SAMPLE, 'b 解密')
  assert(a.includes('sk-live') === false && b.includes('sk-live') === false, '密文里出现了明文片段')
})

await it('篡改密文 / 认证标签 → SecretDecryptionError（GCM tag 校验生效）', async () => {
  const parts = encryptSecret(SAMPLE).split('.')
  for (const index of [2, 3]) {
    const tampered = [...parts]
    const segment = tampered[index]
    // 改一个字符（首字符换掉）即可让 tag 校验失败
    tampered[index] = (segment[0] === 'A' ? 'B' : 'A') + segment.slice(1)
    let thrown
    try {
      decryptSecret(tampered.join('.'))
    } catch (error) {
      thrown = error
    }
    assert(thrown !== undefined, `篡改第 ${index} 段后仍然解密成功 —— 篡改未被检出`)
    assert(
      thrown instanceof SecretDecryptionError,
      `篡改第 ${index} 段应抛 SecretDecryptionError，实际 ${thrown?.name}：${thrown?.message}`,
    )
  }
})

await it('IV 被替换成另一个合法 IV → 解密失败（不会解出错误明文）', async () => {
  const a = encryptSecret(SAMPLE).split('.')
  const b = encryptSecret(SAMPLE).split('.')
  a[1] = b[1]
  let thrown
  try {
    decryptSecret(a.join('.'))
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof SecretDecryptionError, `应抛 SecretDecryptionError，实际 ${thrown?.name}`)
})

await it('AAD 上下文：同值可解、错值被拒、缺省不匹配', async () => {
  const bound = encryptSecret(SAMPLE, 'provider:abc')
  assertEqual(decryptSecret(bound, 'provider:abc'), SAMPLE, '同一上下文应能解密')
  for (const [label, context] of [
    ['换了上下文', 'provider:def'],
    ['不传上下文', undefined],
  ]) {
    let thrown
    try {
      decryptSecret(bound, context)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof SecretDecryptionError, `${label} 时应解密失败，实际 ${thrown?.name}`)
  }
  // 反向：不带上下文加密的密文，带上下文也解不开
  let thrown
  try {
    decryptSecret(encryptSecret(SAMPLE), 'provider:abc')
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof SecretDecryptionError, `带上下文解无上下文密文应失败，实际 ${thrown?.name}`)
})

await it('密文串结构非法 → SecretFormatError（版本未知 / 段数不对 / 编码非法）', async () => {
  const bytes32 = Buffer.alloc(32).toString('base64url')
  const bytes16 = Buffer.alloc(16).toString('base64url')
  const cases = [
    ['未知版本', `v9.${bytes32}.${bytes16}.`],
    ['段数不足', `v1.${bytes32}.${bytes16}`],
    ['IV 长度不对', `v1.${Buffer.alloc(8).toString('base64url')}.${bytes16}.`],
    ['标签长度不对', `v1.${bytes32}.${bytes16}.`],
  ]
  for (const [label, payload] of cases) {
    let thrown
    try {
      decryptSecret(payload)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof SecretFormatError, `${label} 应抛 SecretFormatError，实际 ${thrown?.name}`)
  }
})

// ── 10. 密码哈希（P0-1-6）：bcrypt 形态 / 校验 / 拒绝超长 ──
await it(`bcrypt 摘要形态正确（$2b$${BCRYPT_COST}$… / 60 字符）且能校验正确与错误密码`, async () => {
  const hash = await hashPassword('Passw0rd-中文-🔐')
  assert(hash.startsWith(`$2b$${BCRYPT_COST}$`), `摘要前缀应为 $2b$${BCRYPT_COST}$，实际 ${hash.slice(0, 7)}`)
  assertEqual(hash.length, 60, '摘要长度')
  assertEqual(await verifyPassword('Passw0rd-中文-🔐', hash), true, '正确密码')
  assertEqual(await verifyPassword('Passw0rd-中文-🔐x', hash), false, '错误密码')
  const again = await hashPassword('Passw0rd-中文-🔐')
  assert(again !== hash, '同一密码两次哈希结果相同 —— salt 没随机化')
})

await it('超长密码（>72 字节）被**显式拒绝**，不做静默截断', async () => {
  const long = `${'a'.repeat(MAX_PASSWORD_BYTES)}中文` // 72 字节 + 6 字节
  assert(passwordByteLength(long) > MAX_PASSWORD_BYTES, '构造的样本应当超长')
  let thrown
  try {
    await hashPassword(long)
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof RangeError, `应抛 RangeError，实际 ${thrown?.name}`)
  assert(thrown.message.includes('72'), `报错应点明 72 字节上限，实际：${thrown.message}`)
  // 恰好 72 字节（多字节字符按字节算）应当放行 —— 边界不能"少一个也算超"
  const exact = '中'.repeat(24) // 24 × 3 = 72 字节
  assertEqual(passwordByteLength(exact), MAX_PASSWORD_BYTES, '样本字节数')
  assert((await hashPassword(exact)).length === 60, '恰好在上限的密码应可哈希')
})

await it('DUMMY_PASSWORD_HASH 是**结构合法**的摘要（等时比较的前提），且恒不匹配', async () => {
  // ⚠️ 实测：bcrypt 对结构非法的摘要 compare 会立刻返回 false（0ms）—— 那样就起不到等时作用
  assert(DUMMY_PASSWORD_HASH.startsWith(`$2b$${BCRYPT_COST}$`), '必须是 cost 12 的合法摘要')
  assertEqual(DUMMY_PASSWORD_HASH.length, 60, '摘要长度')
  assertEqual(await verifyPassword('', DUMMY_PASSWORD_HASH), false, '空密码不应匹配')
  assertEqual(await verifyPassword(DUMMY_PASSWORD_HASH, DUMMY_PASSWORD_HASH), false, '摘要自身不应匹配')
})

await it('摘要本身损坏时 verifyPassword 返回 false（不抛错，避免把脏数据包装成 500）', async () => {
  assertEqual(await verifyPassword('whatever', 'not-a-bcrypt-hash'), false, '非法摘要')
  assertEqual(await verifyPassword('whatever', ''), false, '空摘要')
})

// ── 11. 初始密码生成（P0-1-6；P0-1-8 建号用） ──
await it('初始密码：长度 / 无易混字符 / 三类字符齐备 / 每次不同', async () => {
  const samples = Array.from({ length: 30 }, () => generateInitialPassword())
  for (const password of samples) {
    assertEqual(password.length, INITIAL_PASSWORD_LENGTH, '长度')
    assert(/^[A-Za-z0-9]+$/.test(password), `应只含字母数字，实际 ${password}`)
    assert(/[0O1lI]/.test(password) === false, `不应含易混字符 0/O/1/l/I，实际 ${password}`)
    assert(/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password), `三类字符应齐备：${password}`)
  }
  assertEqual(new Set(samples).size, samples.length, '30 次生成应当互不相同')
  assertEqual(generateInitialPassword(8).length, 8, '显式长度参数应生效')
})

// ── 12. 会话的「未登录」出口（P0-1-6）：不碰依赖也必须稳定拒绝 ──
await it('未登录访问受保护路由 → 401 / UNAUTHORIZED（且**不依赖 Redis 可达**）', async () => {
  for (const url of ['/__verify/protected', '/__verify/admin-only']) {
    const response = await app.inject({ method: 'GET', url })
    assertEqual(response.statusCode, 401, `${url} 状态码`)
    const body = response.json()
    assertEqual(body.code, 'UNAUTHORIZED', `${url} 信封 code`)
    assert(typeof body.msg === 'string' && body.msg !== '', `${url} msg 不应为空`)
    // 无 Cookie 时**不该**去查会话存储：所以依赖不可达的环境（CI）里这条也必须是 401 而不是 500
  }
})

await it('伪造/过期会话 Cookie → 拒绝且**绝不放行**（有依赖时 401，依赖不可达时 500）', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/__verify/protected',
    headers: { cookie: 'doubulea_sid=not-a-real-session-token' },
  })
  assert(response.statusCode !== 200, '伪造的会话令牌竟然通过了鉴权')
  if (expectDegraded) {
    // 会话存储不可用 → 失败关闭（fail-closed）：语义是"服务端此刻给不出结论"，
    // 不是"你的凭据不对"，故 500 而非 401（`plugins/session.ts` 文件头「②」）。
    assertEqual(response.statusCode, 500, '依赖不可达时状态码')
    assertEqual(response.json().code, 'INTERNAL', '依赖不可达时信封 code')
  } else {
    assertEqual(response.statusCode, 401, 'Redis 可达但会话不存在时状态码')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
  }
})

// ── 13. 认证契约（P0-1-7）：路由已注册 + schema 生效 + 纯函数正确性 ──
await it('/api/auth/* 四个端点已注册（不再是 404 兜底），且请求体校验给出字段明细', async () => {
  const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })
  assertEqual(missing.statusCode, 400, '空 body 的状态码')
  const fields = missing.json().data.fields.map((field) => field.path)
  assert(fields.includes('body.username'), `应报出 body.username，实际 ${JSON.stringify(fields)}`)
  assert(fields.includes('body.password'), `应报出 body.password，实际 ${JSON.stringify(fields)}`)

  // 未登录的四个端点行为（都不需要数据库，因此在 CI 里也可断言）
  const me = await app.inject({ method: 'GET', url: '/api/auth/me' })
  assertEqual(me.statusCode, 401, '/api/auth/me 未登录状态码')
  const change = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    payload: { oldPassword: 'x'.repeat(9), newPassword: 'y'.repeat(9) },
  })
  assertEqual(change.statusCode, 401, '/api/auth/password 未登录状态码')
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' })
  assertEqual(logout.statusCode, 200, '/api/auth/logout 幂等状态码')
})

await it('首登闸门不给**匿名**请求增加依赖调用：/api/** 的公共路由在无 Cookie 时仍是 200', async () => {
  // 闸门若在无 Cookie 时也去查 Redis，依赖不可达的环境（CI）里这里会是 500。
  // 两种模式下都断言 200，等于把「匿名请求不碰会话存储」钉死。
  const response = await app.inject({ method: 'GET', url: '/api/__verify/open' })
  assertEqual(response.statusCode, 200, '状态码')
  assertEqual(response.json().data.open, true, '响应体')
})

await it('shared 的 utf8ByteLength 与 Buffer.byteLength 完全一致（前端要靠它算字节数）', async () => {
  const samples = ['', 'abc', '中文测试', '🔐🔐', 'a中🙂z', '中'.repeat(24), 'ünïcödé', '\u0000\u007f\u0080\u0800\uffff']
  for (const sample of samples) {
    const expected = Buffer.byteLength(sample, 'utf8')
    assertEqual(utf8ByteLength(sample), expected, `utf8ByteLength(${JSON.stringify(sample)})`)
  }
  assertEqual(utf8ByteLength('中'.repeat(24)), PASSWORD_MAX_BYTES, '24 个汉字应恰好等于 bcrypt 的 72 字节上限')
})

await it('normalizeUsername：去首尾空白 + 转小写（建号与登录必须共用同一口径）', async () => {
  assertEqual(normalizeUsername('  Alice  '), 'alice', '带空白与大写')
  assertEqual(normalizeUsername('admin'), 'admin', '已归一化的值不变')
  assertEqual(normalizeUsername('ADMIN@EXAMPLE'), 'admin@example', '含符号')
})

await it('登录/改密 schema：拒绝空值、过短、超字节数；接受合法输入', async () => {
  const badLogins = [
    ['空用户名', { username: '', password: 'x' }],
    ['空白用户名', { username: '   ', password: 'x' }],
    ['空密码', { username: 'a', password: '' }],
    ['缺字段', { username: 'a' }],
  ]
  for (const [label, payload] of badLogins) {
    assertEqual(loginBodySchema.safeParse(payload).success, false, `登录应拒绝：${label}`)
  }
  assertEqual(loginBodySchema.safeParse({ username: ' a ', password: 'p' }).success, true, '合法登录应通过')

  assertEqual(
    changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: 'short1' }).success,
    false,
    '改密应拒绝过短的新密码',
  )
  const tooLongBytes = '中'.repeat(25) // 75 字节
  assertEqual(
    changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: tooLongBytes }).success,
    false,
    '改密应拒绝超过 72 字节的新密码',
  )
  const result = changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: 'new-pass-1' })
  assertEqual(result.success, true, '合法改密应通过')

  // authUserSchema 是前后端共用的响应形态：能被解析才算契约一致
  const user = { id: 'x', username: 'a', nickname: null, role: 'ADMIN', mustChangePassword: false }
  assertEqual(authUserSchema.safeParse(user).success, true, 'authUserSchema 应接受典型响应体')
  assertEqual(authUserSchema.safeParse({ ...user, nickname: 1 }).success, false, 'authUserSchema 应拒绝非法 nickname')
})

await app.close()
await closePg()
await closeRedis()

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 接口级验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 接口级验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
