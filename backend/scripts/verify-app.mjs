#!/usr/bin/env node
/**
 * verify-app.mjs —— P0-1-4 的**接口级验收**（不占端口、不需要真实依赖）
 *
 * 为什么用 `app.inject` 而不是 curl：
 *   ① 本机端口是稀缺资源（3000/5173 都被别的项目占着，见 `06` §七 待决事项 6），
 *      inject 直接走 Fastify 内部请求生命周期，不监听、不留端口；
 *   ② CI 里不需要 docker-compose 就能验证 HTTP 层契约（依赖探活失败也是一种可断言的状态）。
 *
 * 验的是「协议契约」，不是「依赖可用性」——依赖那部分由 `/health` 探活 + 本机验收记录覆盖。
 * 覆盖：信封形态 / HTTP 状态码 / Zod 校验失败字段明细 / 领域错误 / 未知异常不泄内部信息 /
 *      404 兜底 / 非法 JSON / CORS 预检 / requestId 透传 / `/health` 三项探活恒 200。
 *
 * 附加探针路由（`/__verify/*`）由**本脚本自己注册**，不进源码树：
 *   产品代码里只有 `/health` 一个路由，测试用的路由不该混进去。
 *
 * 用法：
 *   pnpm verify:app                     # 本机（依赖起着 → 断言 /health 全绿）
 *   EXPECT_DEGRADED=1 pnpm verify:app   # 无依赖环境（CI）→ 断言三项探活全部降级
 */

import { z } from 'zod'

import { AppError, ok } from '@doubulea/shared'
import { buildApp } from '../dist/backend/src/app.js'
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

console.log(`\n${c.b}══ P0-1-4 接口级验收：Fastify 骨架 / 错误信封 / /health ══${c.x}`)
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

await app.close()
await closePg()
await closeRedis()

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-4 接口级验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-4 接口级验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
