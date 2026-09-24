#!/usr/bin/env node
/**
 * verify-mcp-servers.mjs —— P0-2-2「Server 注册 CRUD + 连通测试」验收
 *
 * 跑法：`pnpm verify:mcp-servers`（= `pnpm --filter @doubulea/backend verify:mcp-servers`）
 * ⚠️ 前置：`pnpm infra:up && pnpm db:deploy`（真 PG + Redis）+ `pnpm -r build` 出 dist。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 档位：**第二档（真 PG + Redis）+ 第四档（假 MCP server 提供 `tools/list`）**
 * ─────────────────────────────────────────────────────────────────────
 * 与 `verify-knowledge-bases` 一样用 `app.inject`（不占端口），但**多一样东西**：
 * `POST /:id/test` 是一次**真出网**的探测，故本脚本在同进程里起一个**假 MCP server**
 * （`fixtures/mcp-upstream.mjs`，端口 0，会把每个请求记下来）当 `endpoint_url`。
 * 这样"我们发出去的报文对不对"仍能取到证，而不必连任何真 MCP 服务。
 *
 * ⚠️ 口径：**夹具假上游**档 —— 只证明"契约与配置接对了"，**不等于**"真 MCP 服务那边一定对"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本脚本最想钉死的三件事（都不是"接口通不通"层面的）
 * ─────────────────────────────────────────────────────────────────────
 * ① **权限是「登录即可」，且**没有 owner 列收窄**（`06` §4.2 第五族 / 门槛 1）。
 *    `mcp_servers.created_by` 只是**留痕**。所以这里**两个用户都是 MEMBER**，
 *    并且专门有两条**反向守卫**："B 能改 A 建的"、"B 能删 A 建的"（都得成功）。
 *    ⚠️ 若哪天有人顺手加上 `requireAdmin` 或"只有创建者能改"，本脚本立刻红。
 *    代价是刻意的（`01` 决策 22），**不是**实现疏漏。
 * ② **`POST /:id/test` 恒 200**（`06` §4.3）："连不上"是一条**结论**，不是一次失败。
 *    把它映射成 502 会让界面把"一个可用的信息"渲染成一个错误。
 *    另有一条**最容易写错**的：失败时 **`tool_cache` 一个字都不能动** ——
 *    "上游抖一下就把上一次成功拉到的工具列表清空"是最坏的形态（用户明明还能用）。
 * ③ **缓存失效的判据是"真的变了"**（坑预判 3）：`endpoint_url` / `credential_schema` /
 *    `auth_type` 变了才清；**只改 `name` 不清**；**原样提交**（内容相同、键序被 PG 重排过）
 *    也不能清。漏了前者的症状是"改了 endpoint，工具列表还是旧 server 的"（**纯静默**）；
 *    写错了后者则"每次保存工具数都归零"（也一样没人看得出是 bug）。
 */

// ⚠️ 必须在 import `config.js`（经 dist 的 app.js 间接引入）**之前**设置：
//    ① 收敛脚本自身日志（有一堆"应当失败"的探测，每个都会让服务层打 warn）
//    ② 把 MCP 请求超时压到 5s —— 本脚本有几条"连不通"的用例，默认 20s 会拖慢整档
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'
process.env.MCP_REQUEST_TIMEOUT_MS ??= '5000'

const { startFakeMcpServer, DEFAULT_TOOLS } = await import('./fixtures/mcp-upstream.mjs')
const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { closePrisma, getPrisma } = await import('../dist/backend/src/infra/prisma.js')
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { config } = await import('../dist/backend/src/config.js')
const {
  mcpServerItemSchema,
  mcpServerListResultSchema,
  mcpServerTestResultSchema,
  mcpServerToolsResultSchema,
  removeMcpServerResultSchema,
} = await import('@doubulea/shared')

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

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

/** 键序无关的深比较（PG 的 jsonb 会重排键 —— 直接 `JSON.stringify` 比会给出假阳性） */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  }
  return value
}

function assertSameJson(actual, expected, label) {
  const a = JSON.stringify(canonical(actual))
  const b = JSON.stringify(canonical(expected))
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

async function it(name, fn) {
  try {
    const note = await fn()
    passed += 1
    const suffix = typeof note === 'string' && note !== '' ? ` ${c.d}(${note})${c.x}` : ''
    console.log(`  ${c.g}[PASS]${c.x} ${name}${suffix}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

function group(title) {
  console.log(`\n${c.b}${title}${c.x}`)
}

// ───────────────────────────── 常量与临时数据标识 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Mcp-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const creatorUsername = `verify-mcp-a-${suffix}`
const otherUsername = `verify-mcp-b-${suffix}`

/**
 * 一个**打不通**的端点（验收门槛 4 要的"上游不通也允许注册成功"）。
 *
 * ⚠️ **不要用 `http://127.0.0.1:1/mcp`**（第一版就是这么写的，B4 当场翻车）：端口 1 在 fetch
 * 规范里属于 **bad port**，undici 会在**发包之前**就拒掉（原因链是 `fetch failed ← bad port`），
 * 于是根本走不到 TCP ⇒ 验不到我们想钉的那条「连接被拒绝」翻译。
 * 这里起一个假 server 拿到端口**再立刻关掉**：端口刚由本进程释放 ⇒ 连接必然被拒（`ECONNREFUSED`），
 * 且是**快失败**（不像 DNS 那样等解析超时）。手法同 `verify-mcp-client.mjs` 的 D3。
 */
const deadServer = await startFakeMcpServer({})
const UNREACHABLE_URL = `http://127.0.0.1:${new URL(deadServer.baseUrl).port}/mcp`
await deadServer.close()

/** 一个语法合法但**不存在**的 uuid（用来验 404，而不撞 400 的参数校验） */
const MISSING_UUID = '01930000-0000-7000-8000-000000000000'

const sessionIds = []
const createdUserIds = []
const createdMcpIds = []
const createdAgentIds = []
const createdProviderIds = []
const createdModelIds = []

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

/** 建一个 server 并要求成功，返回契约化后的条目（同时记账以便清理） */
async function createServer(cookie, payload) {
  const response = await api('POST', '/api/mcp/servers', { cookie, payload })
  assertEqual(response.statusCode, 200, `注册状态码（${JSON.stringify(payload)}）：${response.body}`)
  const parsed = mcpServerItemSchema.safeParse(response.json().data.server)
  assert(parsed.success, `注册响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
  createdMcpIds.push(parsed.data.id)
  return { item: parsed.data, test: response.json().data.test, response }
}

/** 库里那一行的原始列（`tool_cache` 要逐字比对，不能过投影） */
function rawRow(id) {
  return prisma.mcpServer.findUnique({
    where: { id },
    select: { name: true, slug: true, endpointUrl: true, status: true, toolCache: true, updatedAt: true },
  })
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-2-2 MCP server 注册 CRUD + 连通测试：全员可注册 / 测试恒 200 / 删被绑定 409 ══${c.x}`)

// 整个脚本共用一个假 MCP server（端口稳定 ⇒ 几条用例的 endpoint 可以互相参照）
const upstream = await startFakeMcpServer({})

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
  const createUser = (username, nickname) =>
    prisma.user.create({
      data: { username, passwordHash, nickname, role: 'MEMBER', status: 'ACTIVE', mustChangePassword: false },
    })

  // ⚠️ **两个用户都是 MEMBER**：本资源不该有任何 ADMIN 通道，也不该有 owner 收窄。
  //    用 ADMIN 跑守门断言会把"其实只有管理员能建"这种坏法放过去。
  const creator = await createUser(creatorUsername, 'MCP 验证·注册者')
  const other = await createUser(otherUsername, 'MCP 验证·另一个人')
  createdUserIds.push(creator.id, other.id)

  const login = async (username) => {
    const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
    assertEqual(response.statusCode, 200, `登录 ${username}：${response.body}`)
    return cookieOf(response)
  }
  const creatorCookie = await login(creatorUsername)
  const otherCookie = await login(otherUsername)

  console.log(`  ${c.d}临时数据：${creatorUsername}（MEMBER·注册者）+ ${otherUsername}（MEMBER·另一个人）${c.x}`)
  console.log(`  ${c.d}假 MCP 上游：${upstream.url}（工具 ${DEFAULT_TOOLS.length} 个）${c.x}`)
  console.log(`  ${c.d}打不通的端点：${UNREACHABLE_URL}（注册不强制连通用）${c.x}`)

  // ═══════════════════════════════════════════════════════════════════
  group('A 组 · 权限：登录即可 + **无 owner 收窄**（门槛 1）')
  // ═══════════════════════════════════════════════════════════════════

  await it('未登录：六条路由一律 401（⚠️ 全部要传**语法合法**的 body/params）', async () => {
    // ⚠️ 路由级 schema 校验跑在 `preHandler` **之前** ⇒ 想验"未登录 401"就必须给合法的
    //    body / params，否则拿到的是 400 —— 那条"假 401"测试只是没验到该验的东西。
    const cases = [
      ['GET', '/api/mcp/servers', undefined],
      ['POST', '/api/mcp/servers', { name: 'x', endpointUrl: 'http://127.0.0.1:1/mcp' }],
      ['PATCH', `/api/mcp/servers/${MISSING_UUID}`, { name: 'x' }],
      ['DELETE', `/api/mcp/servers/${MISSING_UUID}`, undefined],
      ['POST', `/api/mcp/servers/${MISSING_UUID}/test`, undefined],
      ['GET', `/api/mcp/servers/${MISSING_UUID}/tools`, undefined],
    ]
    for (const [method, url, payload] of cases) {
      const response = await api(method, url, { payload })
      assertEqual(response.statusCode, 401, `${method} ${url} 应 401`)
      assertEqual(response.json().code, 'UNAUTHORIZED', `${method} ${url} 信封 code`)
    }
    return `${cases.length} 条路由`
  })

  const first = await createServer(creatorCookie, {
    name: `验证 MCP-一号-${suffix}`,
    endpointUrl: upstream.url,
  })

  await it('MEMBER 能注册（门槛 1）：落地一条、`createdBy` 是**留痕**、投影键集合正确', () => {
    assertEqual(first.response.json().code, 0, '成功的 code 是数字 0')
    assertEqual(first.item.createdBy, creator.id, 'created_by 记下注册者')
    assertEqual(first.item.authType, 'NONE', 'authType 省略 ⇒ NONE')
    assertSameJson(first.item.credentialSchema, [], 'credentialSchema 省略 ⇒ []')
    assert(first.item.slug.includes('mcp'), `slug 应从 name 派生，实际 ${first.item.slug}`)
    // ⚠️ 两个键**刻意不在**契约里：`oauthConfig`（P1）与完整 `toolCache`（列表页只要数字）
    const keys = Object.keys(first.item).sort()
    assert(!keys.includes('oauthConfig'), '⚠️ `oauthConfig` 不进契约（恒 null 的字段会诱使前端写死分支）')
    assert(!keys.includes('toolCache'), '⚠️ 列表投影只给 `toolCount`，完整列表走 /:id/tools')
    assert(keys.includes('toolCount'), 'toolCount 必须在')
    return `slug=${first.item.slug}`
  })

  await it('A2 **反向守卫①**：另一个人（MEMBER）**能改**别人建的 server（无 owner 收窄）', async () => {
    const response = await api('PATCH', `/api/mcp/servers/${first.item.id}`, {
      cookie: otherCookie,
      payload: { name: `被别人改过的-${suffix}` },
    })
    assertEqual(response.statusCode, 200, '⚠️ 若这里变成 403/404，说明有人擅自加了 owner 收窄')
    assertEqual(mcpServerItemSchema.parse(response.json().data).name, `被别人改过的-${suffix}`, '改动生效')
    assertEqual(
      (await rawRow(first.item.id)).name,
      `被别人改过的-${suffix}`,
      '库里也跟着变了（不是只改响应）',
    )
    // 改回原名，后面几条用例的文案好认
    await api('PATCH', `/api/mcp/servers/${first.item.id}`, {
      cookie: creatorCookie,
      payload: { name: `验证 MCP-一号-${suffix}` },
    })
  })

  await it('A3 列表：`{items,total,offset,limit}` 契约 + 分页参数生效', async () => {
    const response = await api('GET', '/api/mcp/servers?limit=1', { cookie: otherCookie })
    assertEqual(response.statusCode, 200, '列表状态码')
    const page = mcpServerListResultSchema.parse(response.json().data)
    assertEqual(page.limit, 1, 'limit 透传')
    assertEqual(page.items.length, 1, '只给一页一条')
    assert(page.total >= 1, `total 至少 1，实际 ${page.total}`)
    const all = mcpServerListResultSchema.parse(
      (await api('GET', '/api/mcp/servers?limit=100', { cookie: creatorCookie })).json().data,
    )
    assert(
      all.items.some((item) => item.id === first.item.id),
      '另一个用户建的 server 也要在列表里（共享资源，不是"我的列表"）',
    )
    return `total=${all.total}`
  })

  await it('A4 **反向守卫②**：另一个人（MEMBER）**能删**别人建的 server + `DELETE` 回 `{id,name}`', async () => {
    const victim = await createServer(otherCookie, { name: `验证 MCP-待删-${suffix}`, endpointUrl: upstream.url })
    const response = await api('DELETE', `/api/mcp/servers/${victim.item.id}`, { cookie: creatorCookie })
    assertEqual(response.statusCode, 200, '⚠️ 若这里变成 403/404，说明有人擅自加了 owner 收窄')
    const removed = removeMcpServerResultSchema.parse(response.json().data)
    assertEqual(removed.id, victim.item.id, '回的是被删的那个 id')
    assertEqual(removed.name, victim.item.name, '回的是被删的那个 name')
    assertEqual(await rawRow(victim.item.id), null, '⚠️ 库里真的没了（不是只回了个成功）')
    assertEqual(
      (await api('DELETE', `/api/mcp/servers/${victim.item.id}`, { cookie: creatorCookie })).statusCode,
      404,
      '再删一次 404（不是 200 —— 幂等是"不报错"，不是"假装又删了一次"）',
    )
    const index = createdMcpIds.indexOf(victim.item.id)
    if (index >= 0) createdMcpIds.splice(index, 1)
  })

  await it('A5 非法 UUID 的路径参数 ⇒ 400 且**字段路径精确到 `params.id`**', async () => {
    for (const [method, url, payload] of [
      ['PATCH', '/api/mcp/servers/not-a-uuid', { name: 'x' }],
      ['DELETE', '/api/mcp/servers/not-a-uuid', undefined],
      ['POST', '/api/mcp/servers/not-a-uuid/test', undefined],
      ['GET', '/api/mcp/servers/not-a-uuid/tools', undefined],
    ]) {
      const response = await api(method, url, { cookie: creatorCookie, payload })
      assertEqual(response.statusCode, 400, `${method} ${url} 应 400`)
      assertEqual(response.json().data.fields[0].path, 'params.id', `${method} 的字段路径`)
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  group('B 组 · 连通测试：恒 200 与缓存的两条副作用（门槛 2）')
  // ═══════════════════════════════════════════════════════════════════

  await it('B1 测通：200 + `{ok:true,tools}`，工具与上游逐字一致；顺手刷新 `tool_cache` 与 `status=OK`', async () => {
    const response = await api('POST', `/api/mcp/servers/${first.item.id}/test`, { cookie: otherCookie })
    assertEqual(response.statusCode, 200, 'HTTP 恒 200')
    const result = mcpServerTestResultSchema.parse(response.json().data)
    assertEqual(result.ok, true, 'ok 分支')
    assertEqual(result.tools.length, DEFAULT_TOOLS.length, '工具条数')
    const echo = result.tools.find((tool) => tool.name === 'echo')
    assertSameJson(
      echo.inputSchema,
      DEFAULT_TOOLS.find((tool) => tool.name === 'echo').inputSchema,
      'inputSchema 原样透传（P0-2-6 才做兼容处理）',
    )
    assertEqual(echo.annotations?.readOnlyHint, true, 'annotations 也要带出来（危险判定的依据）')

    const row = await rawRow(first.item.id)
    assertEqual(row.status, 'OK', '成功 ⇒ status=OK')
    assertEqual(row.toolCache.tools.length, DEFAULT_TOOLS.length, '⚠️ 缓存真的落库了')
    assertEqual(typeof row.toolCache.fetchedAt, 'string', 'fetchedAt 是 ISO 字符串')
    // 顺手验一条上游侧的取证：`tools/list` 不该带任何用户凭据（本层刻意不带，P0-2-5 坑预判 1）
    const lists = upstream.requests.filter((entry) => {
      const messages = Array.isArray(entry.body) ? entry.body : [entry.body]
      return messages.some((message) => message?.method === 'tools/list')
    })
    assert(lists.length >= 1, '上游应收到 tools/list')
    assertEqual(lists.at(-1).sessionId !== null, true, '应是一次真实握手后的请求（带会话头）')
  })

  await it('B2 列表里的 `toolCount` 与缓存一致（不是另一个数字）', async () => {
    const page = mcpServerListResultSchema.parse(
      (await api('GET', '/api/mcp/servers?limit=100', { cookie: creatorCookie })).json().data,
    )
    const item = page.items.find((entry) => entry.id === first.item.id)
    assertEqual(item.toolCount, DEFAULT_TOOLS.length, 'toolCount')
    assertEqual(item.status, 'OK', 'status')
  })

  await it('B3 ⚠️ 测不通也**恒 200**（`{ok:false,error}`），且 `tool_cache` **一个字未动**', async () => {
    const before = await rawRow(first.item.id)
    // ⚠️ 用**上游故障注入**造失败，而不是把 endpoint 改坏 —— 改 endpoint 会让缓存失效，
    //    那样这条"失败不动缓存"就变成了在空缓存上做断言（永远为真、什么都没验到）
    upstream.setFailing(true)
    let response
    try {
      response = await api('POST', `/api/mcp/servers/${first.item.id}/test`, { cookie: creatorCookie })
    } finally {
      upstream.setFailing(false) // 无论如何都要恢复（后面还有用例要用这个 server）
    }
    assertEqual(response.statusCode, 200, '⚠️ 失败也必须是 200（"连不上"是一个结论，不是一次请求失败）')
    const result = mcpServerTestResultSchema.parse(response.json().data)
    assertEqual(result.ok, false, 'ok 分支')
    assert(typeof result.error === 'string' && result.error.length > 0, 'error 要给出可读原因')
    assertEqual('tools' in result, false, '⚠️ 两个分支互斥：失败时不许还带 tools')

    const after = await rawRow(first.item.id)
    assertEqual(after.status, 'ERROR', '失败 ⇒ 只把 status 打成 ERROR')
    assertEqual(
      JSON.stringify(after.toolCache),
      JSON.stringify(before.toolCache),
      '⚠️ 缓存必须逐字不变（"上游抖一下就把上次成功拉到的工具列表清空"是最坏的形态）',
    )
    return result.error.slice(0, 40)
  })

  await it('B4 打不通时的文案是可读中文（不是一句 fetch failed）', async () => {
    const broken = await createServer(creatorCookie, {
      name: `验证 MCP-打不通-${suffix}`,
      endpointUrl: UNREACHABLE_URL,
    })
    assertEqual(broken.test.ok, false, '注册时那次 best-effort 探测应当失败')
    const response = await api('POST', `/api/mcp/servers/${broken.item.id}/test`, { cookie: creatorCookie })
    assertEqual(response.statusCode, 200, '依然 200')
    const result = mcpServerTestResultSchema.parse(response.json().data)
    assertEqual(result.ok, false, 'ok 分支')
    assertIncludes(result.error, '连接被拒绝', '⚠️ 要给出人话（`errors.ts` 的翻译层负责，别在这里降级成 `fetch failed`）')
    return result.error.slice(0, 40)
  })

  await it('B5 测试一个**不存在**的 server ⇒ 404（那是请求本身的问题，不是"这一轮连不上"）', async () => {
    const response = await api('POST', `/api/mcp/servers/${MISSING_UUID}/test`, { cookie: creatorCookie })
    assertEqual(response.statusCode, 404, '不存在应 404')
    assertEqual(response.json().code, 'NOT_FOUND', '信封 code')
  })

  await it('B6 `GET /:id/tools` 三态之一：**有缓存** ⇒ `cached:true` + tools 与上游一致', async () => {
    // 先把它测回 OK（B3 把 status 打成了 ERROR，但缓存还在 —— 这正好也是"cached:true 与 status 无关"的取证）
    await api('POST', `/api/mcp/servers/${first.item.id}/test`, { cookie: creatorCookie })
    const response = await api('GET', `/api/mcp/servers/${first.item.id}/tools`, { cookie: otherCookie })
    assertEqual(response.statusCode, 200, '状态码')
    const result = mcpServerToolsResultSchema.parse(response.json().data)
    assertEqual(result.cached, true, 'cached 分支')
    assert(typeof result.fetchedAt === 'string' && result.fetchedAt.length > 0, 'fetchedAt 有值')
    assertSameJson(
      result.tools.map((tool) => tool.name).sort(),
      DEFAULT_TOOLS.map((tool) => tool.name).sort(),
      '工具名集合与上游一致',
    )
    // 上游侧取证：这条接口**不许联网**（本批纯读缓存）
    const countBefore = upstream.requests.length
    await api('GET', `/api/mcp/servers/${first.item.id}/tools`, { cookie: creatorCookie })
    assertEqual(upstream.requests.length, countBefore, '⚠️ 纯读缓存：再读一次不该产生任何上游请求')
  })

  await it('B7 `GET /:id/tools` 三态之二：**从未拉过** ⇒ `{tools:[],fetchedAt:null,cached:false}`', async () => {
    const broken = await createServer(creatorCookie, {
      name: `验证 MCP-无缓存-${suffix}`,
      endpointUrl: UNREACHABLE_URL,
    })
    const response = await api('GET', `/api/mcp/servers/${broken.item.id}/tools`, { cookie: creatorCookie })
    assertEqual(response.statusCode, 200, '状态码')
    const result = mcpServerToolsResultSchema.parse(response.json().data)
    assertEqual(result.cached, false, '从未成功拉过 ⇒ false')
    assertEqual(result.fetchedAt, null, '⚠️ `null`（没拉过）与 `0` 个工具是**两件事**，界面据此显示 `—` 还是 `0`')
    assertEqual(result.tools.length, 0, '工具为空数组')
    assertEqual(broken.item.status, 'ERROR', '注册时探测失败 ⇒ status=ERROR')
    assertEqual(broken.item.toolCount, 0, 'toolCount 为 0')
  })

  await it('B8 `GET /:id/tools` 三态之三：**库里有值但读不出来** ⇒ 按"无缓存"处理，绝不 500', async () => {
    // 模拟"手工改库 / 从别的环境导入 / 将来加字段"留下的半截 jsonb
    const broken = await createServer(creatorCookie, {
      name: `验证 MCP-坏缓存-${suffix}`,
      endpointUrl: UNREACHABLE_URL,
    })
    await prisma.mcpServer.update({
      where: { id: broken.item.id },
      data: { toolCache: { fetchedAt: '2026-01-01T00:00:00.000Z' }, status: 'OK' }, // 缺 tools
    })
    const response = await api('GET', `/api/mcp/servers/${broken.item.id}/tools`, { cookie: creatorCookie })
    assertEqual(response.statusCode, 200, '⚠️ 坏数据不该让读取端炸（它是会被下发给前端渲染表单的）')
    const result = mcpServerToolsResultSchema.parse(response.json().data)
    assertEqual(result.cached, false, '读不出来 ⇒ 当成没有缓存')
    assertEqual(result.tools.length, 0, '不给半份工具列表（"模型能调到的工具少了几个"是看不出来的坏法）')
    // 列表页那个数字同样要退化成 0，而不是抛错或给出 undefined
    const page = mcpServerListResultSchema.parse(
      (await api('GET', '/api/mcp/servers?limit=100', { cookie: creatorCookie })).json().data,
    )
    assertEqual(page.items.find((entry) => entry.id === broken.item.id).toolCount, 0, 'toolCount 退化成 0')
  })

  // ═══════════════════════════════════════════════════════════════════
  group('C 组 · 删除守卫：被 Agent 绑定时 409（门槛 3）')
  // ═══════════════════════════════════════════════════════════════════

  await it('C1 被 Agent 绑定时 409（判据 = 数 `agent_components`），解绑后立刻删得掉', async () => {
    const bound = await createServer(creatorCookie, {
      name: `验证 MCP-被绑定-${suffix}`,
      endpointUrl: upstream.url,
    })
    // 造一条真实的 `agent_components` 行：`ref_id` 是**多态外键、没有 FK 兜底**，
    // 数据库不会拦 —— 引用完整性只能由服务层负责（这正是本守卫存在的理由）
    const provider = await prisma.modelProvider.create({
      data: { name: `验证 MCP Provider ${suffix}`, baseUrl: 'https://api.example.com/v1', type: 'CHAT' },
    })
    createdProviderIds.push(provider.id)
    const model = await prisma.model.create({
      data: { providerId: provider.id, modelName: `verify-mcp-model-${suffix}`, label: 'MCP 验证模型', type: 'CHAT' },
    })
    createdModelIds.push(model.id)
    const agent = await prisma.agent.create({
      data: { name: `验证 MCP 智能体-${suffix}`, type: 'CHATBOT', modelId: model.id, createdBy: creator.id },
    })
    createdAgentIds.push(agent.id)
    await prisma.agentComponent.create({
      data: { agentId: agent.id, componentType: 'MCP', refId: bound.item.id },
    })

    const blocked = await api('DELETE', `/api/mcp/servers/${bound.item.id}`, { cookie: otherCookie })
    assertEqual(blocked.statusCode, 409, '被绑定时应 409')
    assertEqual(blocked.json().code, 'CONFLICT', '信封 code')
    assertIncludes(blocked.json().msg, '1 个', '⚠️ 文案要给出数字（用户才知道去哪儿解绑；与删库守卫同句式）')
    assertIncludes(blocked.json().msg, '解绑', '要指出下一步该做什么')
    assert((await rawRow(bound.item.id)) !== null, '被拒之后 server 必须还在')

    // 解绑（就是删掉那一行）⇒ **立刻**删得掉 —— 反向守卫：不能是"一律 409"
    await prisma.agentComponent.deleteMany({ where: { agentId: agent.id } })
    assertEqual(
      (await api('DELETE', `/api/mcp/servers/${bound.item.id}`, { cookie: creatorCookie })).statusCode,
      200,
      '⚠️ 解绑之后必须删得掉',
    )
    const index = createdMcpIds.indexOf(bound.item.id)
    if (index >= 0) createdMcpIds.splice(index, 1)
  })

  // ═══════════════════════════════════════════════════════════════════
  group('D 组 · 注册**不强制连通**（门槛 4 / 坑预判 2）')
  // ═══════════════════════════════════════════════════════════════════

  await it('D1 上游打不通也**允许注册成功**（否则上游一抖就"建不了 server"，而用户没有别的入口）', async () => {
    const response = await api('POST', '/api/mcp/servers', {
      cookie: creatorCookie,
      payload: { name: `验证 MCP-离线注册-${suffix}`, endpointUrl: UNREACHABLE_URL },
    })
    assertEqual(response.statusCode, 200, '⚠️ 注册必须成功（探测结果不参与成败）')
    const data = response.json().data
    const server = mcpServerItemSchema.parse(data.server)
    createdMcpIds.push(server.id)
    assertEqual(data.test.ok, false, '响应里如实带回这次 best-effort 探测的结论')
    assertEqual(server.status, 'ERROR', '探测失败只影响 status')
    assertEqual(server.toolCount, 0, '没有缓存 ⇒ toolCount 为 0')
    assert((await rawRow(server.id)) !== null, '库里真的建出来了')
  })

  await it('D2 "之后可以点测试"：改到能通的端点 ⇒ 测成功并落缓存', async () => {
    const response = await api('POST', '/api/mcp/servers', {
      cookie: creatorCookie,
      payload: { name: `验证 MCP-先离线后在线-${suffix}`, endpointUrl: UNREACHABLE_URL },
    })
    const server = mcpServerItemSchema.parse(response.json().data.server)
    createdMcpIds.push(server.id)
    assertEqual(server.status, 'ERROR', '前置：注册时打不通')

    const patched = await api('PATCH', `/api/mcp/servers/${server.id}`, {
      cookie: creatorCookie,
      payload: { endpointUrl: upstream.url },
    })
    assertEqual(patched.statusCode, 200, '改 endpoint')
    const test = await api('POST', `/api/mcp/servers/${server.id}/test`, { cookie: creatorCookie })
    assertEqual(test.statusCode, 200, '测试状态码')
    const result = mcpServerTestResultSchema.parse(test.json().data)
    assertEqual(result.ok, true, '⚠️ 修好之后必须真的能测通（"能点测试"不是"能点"）')
    const row = await rawRow(server.id)
    assertEqual(row.status, 'OK', 'status 转 OK')
    assertEqual(row.toolCache.tools.length, DEFAULT_TOOLS.length, '缓存落库')
  })

  // ═══════════════════════════════════════════════════════════════════
  group('E 组 · `endpoint_url` 校验与 `auth_type` 的能力边界（门槛 5 / 口径②）')
  // ═══════════════════════════════════════════════════════════════════

  await it('E1 ⚠️ 只接受 http/https：其它 scheme 一律 400，且字段路径精确到 `body.endpointUrl`', async () => {
    // ⚠️ `z.string().url()` 用的是 `new URL()` —— 它**接受任何协议**（ftp/file/gopher 全过）。
    //    所以"其它协议 400"这条**必须自己判 scheme**，否则这条断言是假的。
    for (const endpointUrl of ['ftp://example.com/mcp', 'file:///etc/passwd', 'ws://example.com/mcp']) {
      const response = await api('POST', '/api/mcp/servers', {
        cookie: creatorCookie,
        payload: { name: `验证 MCP-坏协议-${suffix}`, endpointUrl },
      })
      assertEqual(response.statusCode, 400, `${endpointUrl} 应 400`)
      assertEqual(response.json().data.fields[0].path, 'body.endpointUrl', `${endpointUrl} 的字段路径`)
      assertIncludes(response.json().data.fields[0].message, 'http', `${endpointUrl} 的文案要指出支持的协议`)
    }
  })

  await it('E2 空串 / 非 URL / 超长 ⇒ 400（三态里没有"清空"，URL 是必填）', async () => {
    for (const [label, endpointUrl] of [
      ['空串', ''],
      ['全空格', '   '],
      ['非 URL', 'not a url at all'],
      ['超长', `http://example.com/${'a'.repeat(2048)}`],
    ]) {
      const response = await api('POST', '/api/mcp/servers', {
        cookie: creatorCookie,
        payload: { name: `验证 MCP-坏 URL-${suffix}`, endpointUrl },
      })
      assertEqual(response.statusCode, 400, `${label} 应 400`)
      assertEqual(response.json().data.fields[0].path, 'body.endpointUrl', `${label} 的字段路径`)
    }
  })

  await it('E3 `authType` 是**接口留位、能力不做**：`OAUTH` ⇒ 400 且文案指向 P1', async () => {
    const created = await api('POST', '/api/mcp/servers', {
      cookie: creatorCookie,
      payload: { name: `验证 MCP-OAuth-${suffix}`, endpointUrl: UNREACHABLE_URL, authType: 'OAUTH' },
    })
    assertEqual(created.statusCode, 400, '建时 OAUTH 应 400')
    assertEqual(created.json().code, 'VALIDATION', '信封 code')
    assertIncludes(created.json().msg, 'P1', '⚠️ 文案要指向"功能还没上线"，而不是甩一句"参数不合法"')

    // 改的那条路也要拦，且**在写库之前**拦（否则会留下一个"改完就永远用不了"的 server）
    const target = await createServer(creatorCookie, {
      name: `验证 MCP-OAuth-改-${suffix}`,
      endpointUrl: UNREACHABLE_URL,
    })
    const before = await rawRow(target.item.id)
    const patched = await api('PATCH', `/api/mcp/servers/${target.item.id}`, {
      cookie: creatorCookie,
      payload: { authType: 'OAUTH' },
    })
    assertEqual(patched.statusCode, 400, '改时 OAUTH 应 400')
    const after = await rawRow(target.item.id)
    assertEqual(after.endpointUrl, before.endpointUrl, '被拒的 PATCH 不得改任何字段')
    assertEqual(
      after.updatedAt.toISOString(),
      before.updatedAt.toISOString(),
      '⚠️ `updated_at` 逐字不变（"写了但值相同"会被内容断言漏掉）',
    )
  })

  await it('E4 `credentialSchema` 形状校验 + 合法模板往返（键序无关）', async () => {
    // ① 形状错：非法 inject / 空 key / 空 label / 非 string 的 type
    for (const [label, credentialSchema] of [
      ['非法 inject', [{ key: 'k', label: 'L', type: 'string', inject: 'COOKIE' }]],
      ['空 key', [{ key: '   ', label: 'L', type: 'string', inject: 'HEADER' }]],
      ['空 label', [{ key: 'k', label: '', type: 'string', inject: 'HEADER' }]],
      ['type 非 string', [{ key: 'k', label: 'L', type: 'number', inject: 'HEADER' }]],
    ]) {
      const response = await api('POST', '/api/mcp/servers', {
        cookie: creatorCookie,
        payload: { name: `验证 MCP-坏模板-${suffix}`, endpointUrl: UNREACHABLE_URL, credentialSchema },
      })
      assertEqual(response.statusCode, 400, `${label} 应 400`)
      assertIncludes(response.json().data.fields[0].path, 'credentialSchema', `${label} 的字段路径要指到模板里`)
    }

    // ② 超 64 条 ⇒ 400（上限同时是**渲染上限**：一行一条的表单超过这个量级说明设计走偏了）
    const tooMany = Array.from({ length: 65 }, (_value, index) => ({
      key: `k${index}`,
      label: `第 ${index} 个`,
      type: 'string',
      inject: 'HEADER',
    }))
    const over = await api('POST', '/api/mcp/servers', {
      cookie: creatorCookie,
      payload: { name: `验证 MCP-超长模板-${suffix}`, endpointUrl: UNREACHABLE_URL, credentialSchema: tooMany },
    })
    assertEqual(over.statusCode, 400, '65 条应 400')

    // ③ 合法模板：**键序故意打乱**（`inject` 在 `key` 前面）—— PG 的 jsonb 往返会重排键，
    //    所以"读回来逐字相同"是**不该**成立的；成立的是"语义相同"（键序无关比较）
    const entries = [
      { placeholder: 'sk-…', required: true, inject: 'HEADER', type: 'string', label: '访问令牌', key: 'token' },
      { label: '租户', inject: 'QUERY', key: 'tenant_id', type: 'string' },
    ]
    const ok = await createServer(creatorCookie, {
      name: `验证 MCP-合法模板-${suffix}`,
      endpointUrl: upstream.url,
      credentialSchema: entries,
    })
    assertSameJson(ok.item.credentialSchema, entries, '往返之后语义必须一致（顺序即界面顺序，也要保住）')
    assertEqual(ok.item.credentialSchema.length, 2, '两条都在（逐条校验不许丢）')
    assertEqual(ok.item.credentialSchema[0].key, 'token', '⚙️ 数组顺序 = 界面顺序（刻意保留）')
  })

  await it('E5 `PATCH` 至少给一个字段；`slug` **不是**契约字段（剥掉后等于什么都没给）', async () => {
    const empty = await api('PATCH', `/api/mcp/servers/${first.item.id}`, { cookie: creatorCookie, payload: {} })
    assertEqual(empty.statusCode, 400, '空 body 应 400')
    assertIncludes(empty.json().data.fields[0].message, '至少要提供', '文案要说清"至少改一个字段"')

    const withSlug = await api('PATCH', `/api/mcp/servers/${first.item.id}`, {
      cookie: creatorCookie,
      payload: { slug: 'hacked' },
    })
    assertEqual(withSlug.statusCode, 400, '⚠️ `slug` 不可改（它要进工具名前缀，跟着改名会让历史消息对不上）')
    assertEqual((await rawRow(first.item.id)).slug, first.item.slug, 'slug 逐字未变')
  })

  // ═══════════════════════════════════════════════════════════════════
  group('F 组 · slug 派生与**缓存失效判据**（坑预判 3）')
  // ═══════════════════════════════════════════════════════════════════

  await it('F1 同名重复注册 ⇒ `base` 与 `base-2`；**改 name 不改 slug**', async () => {
    // ⚠️ 名字必须用**纯 ASCII**：本脚本前面那些"验证 MCP-xx-<suffix>"的中文名会被 slugify
    //    整段折掉（`验证 ` → `-`），于是它们**共用** `mcp-<suffix>` 这一族 slug、序号一路涨到 -9。
    //    那本身是设计内行为（中文名靠序号区分，见 F2），但会让"第二个就是 -2"这条断言
    //    依赖前面跑过几条用例 —— 那是最难查的一类假失败。故这里换一个**专属**的名字族。
    const name = `verify-dup-${suffix}`
    const a = await createServer(creatorCookie, { name, endpointUrl: UNREACHABLE_URL })
    assertEqual(a.item.slug, name, '首次注册就用 base 本身（没有撞名）')
    const b = await createServer(creatorCookie, { name, endpointUrl: UNREACHABLE_URL })
    assertEqual(b.item.slug, `${a.item.slug}-2`, `第二个同名应加序号，实际 ${b.item.slug}`)
    const renamed = await api('PATCH', `/api/mcp/servers/${a.item.id}`, {
      cookie: creatorCookie,
      payload: { name: `${name}-改过` },
    })
    assertEqual(mcpServerItemSchema.parse(renamed.json().data).slug, a.item.slug, '⚠️ 改名不改 slug（它是工具名前缀）')
  })

  await it('F2 纯中文名 ⇒ 回落到 `server`（slug 要进工具名，而工具名只认 ASCII）', async () => {
    // ⚠️ 用**不含任何 ASCII** 的名字才验得到这条：带 `-${suffix}` 的话 slug 会变成那个后缀
    //    （"中文全折掉、ASCII 留下"本来就是这个函数的正确行为）。
    //    前置：库里不能已经有 `server*` 的 slug，否则断言失败的原因会变得难以分辨。
    assertEqual(
      await prisma.mcpServer.count({ where: { slug: { startsWith: 'server' } } }),
      0,
      '前提：本脚本跑到现在还没有 `server*` 的 slug（有残留的话先查库）',
    )
    const a = await createServer(creatorCookie, { name: '内部工单平台', endpointUrl: UNREACHABLE_URL })
    assertEqual(a.item.slug, 'server', '⚠️ 整串折成空串 ⇒ 回落兜底（可读性由 name 承担）')
    const b = await createServer(creatorCookie, { name: '内部审批系统', endpointUrl: UNREACHABLE_URL })
    assertEqual(b.item.slug, 'server-2', '第二个走序号（同名撞在一起就没法当工具名前缀了）')
  })

  await it('F3 slug 截断到 32 且不留尾 `-`（后缀也要能被容下）', async () => {
    const long = `Abc-${'d'.repeat(60)}`
    const a = await createServer(creatorCookie, { name: long, endpointUrl: UNREACHABLE_URL })
    assertEqual(a.item.slug.length, 32, `slug 长度应为 32，实际 ${a.item.slug.length}`)
    assert(!a.item.slug.endsWith('-'), '⚠️ 截断可能正好落在分隔符上 ⇒ 必须再去尾 `-`')
    const b = await createServer(creatorCookie, { name: long, endpointUrl: UNREACHABLE_URL })
    assertEqual(b.item.slug, `${a.item.slug.slice(0, 30)}-2`, '⚠️ 加后缀时要截短 base，否则 `-2` 被截掉又撞名')
  })

  await it('F4 改 `endpointUrl` ⇒ **清缓存**（`toolCount` 归 0 + `status` 回 `UNKNOWN`）', async () => {
    const target = await createServer(creatorCookie, {
      name: `验证 MCP-清缓存-${suffix}`,
      endpointUrl: upstream.url,
    })
    assertEqual(target.item.toolCount, DEFAULT_TOOLS.length, '前置：注册探测成功 ⇒ 有缓存')
    assertEqual(target.item.status, 'OK', '前置 status')
    const patched = await api('PATCH', `/api/mcp/servers/${target.item.id}`, {
      cookie: creatorCookie,
      payload: { endpointUrl: UNREACHABLE_URL },
    })
    const item = mcpServerItemSchema.parse(patched.json().data)
    assertEqual(item.toolCount, 0, '⚠️ 漏了这一步的症状是"改了 endpoint，工具列表还是旧 server 的"—— 纯静默')
    assertEqual(item.status, 'UNKNOWN', 'status 回 UNKNOWN（旧结论对新地址没有意义）')
    const row = await rawRow(target.item.id)
    assertEqual(row.toolCache, null, '⚠️ 库里写的是 SQL NULL（`Prisma.DbNull`），读侧才认得出"没有缓存"')
  })

  await it('F5 ⚠️ **只改 `name`** ⇒ 缓存**不动**（清了只会让用户白等一次重拉）', async () => {
    const target = await createServer(creatorCookie, {
      name: `验证 MCP-只改名-${suffix}`,
      endpointUrl: upstream.url,
    })
    const before = await rawRow(target.item.id)
    const patched = await api('PATCH', `/api/mcp/servers/${target.item.id}`, {
      cookie: creatorCookie,
      payload: { name: `验证 MCP-只改名-改过-${suffix}` },
    })
    const item = mcpServerItemSchema.parse(patched.json().data)
    assertEqual(item.toolCount, DEFAULT_TOOLS.length, '工具数不动')
    assertEqual(item.status, 'OK', 'status 不动')
    const after = await rawRow(target.item.id)
    assertEqual(
      JSON.stringify(after.toolCache),
      JSON.stringify(before.toolCache),
      '⚠️ 缓存逐字不变（含 fetchedAt —— 不能"顺手也刷一下"）',
    )
  })

  await it('F6 ⚠️ **原样提交**也不清缓存（jsonb 经 PG 往返会重排键 ⇒ 比较必须键序无关）', async () => {
    const entries = [
      { inject: 'HEADER', key: 'token', label: '令牌', placeholder: 'sk-…', required: true, type: 'string' },
    ]
    const target = await createServer(creatorCookie, {
      name: `验证 MCP-原样提交-${suffix}`,
      endpointUrl: upstream.url,
      credentialSchema: entries,
    })
    const before = await rawRow(target.item.id)

    // ① 先证明"PG 真的重排了键" —— 否则下面那条断言是**空洞的**（两边本来就一样，恒真）。
    //    提交进来的是 zod 的字段声明序（`key,label,type,inject,required,placeholder`），
    //    而 jsonb 的键序是 PG 自己排的（**按长度、再按字节** ⇒ `type` 跑到 `label` 前面）。
    const cs = await prisma.mcpServer.findUnique({
      where: { id: target.item.id },
      select: { credentialSchema: true },
    })
    const storedKeys = Object.keys(cs.credentialSchema[0])
    assertEqual(
      JSON.stringify(storedKeys),
      JSON.stringify(['key', 'type', 'label', 'inject', 'required', 'placeholder']),
      `⚠️ 前提：库里那一份的键序已被 PG 重排（长度 3/4/5/6/8/11）—— 实际 ${JSON.stringify(storedKeys)}。` +
        ' 若它等于提交序，下面那条"原样提交不清缓存"就在空转，得先解释为什么没重排',
    )

    // ② 原样提交（内容完全相同、但键序已被 PG 换过）⇒ **不清缓存**
    const patched = await api('PATCH', `/api/mcp/servers/${target.item.id}`, {
      cookie: creatorCookie,
      payload: { endpointUrl: upstream.url, credentialSchema: entries },
    })
    const item = mcpServerItemSchema.parse(patched.json().data)
    assertEqual(item.toolCount, DEFAULT_TOOLS.length, '⚠️ 提交里带了键、但值没变 ⇒ 不许清（否则每次保存工具数都归零）')
    assertEqual(item.status, 'OK', 'status 不动')
    assertEqual(
      JSON.stringify((await rawRow(target.item.id)).toolCache),
      JSON.stringify(before.toolCache),
      '缓存逐字不变',
    )

    // ③ 反过来：真的变了就必须清（否则②那种"不清"就变成了"永远不清"）
    const changed = await api('PATCH', `/api/mcp/servers/${target.item.id}`, {
      cookie: creatorCookie,
      payload: { credentialSchema: [...entries, { key: 'extra', label: '多加一个', type: 'string', inject: 'BODY' }] },
    })
    assertEqual(mcpServerItemSchema.parse(changed.json().data).toolCount, 0, '模板真的变了 ⇒ 必须清缓存')
    assertEqual(
      mcpServerItemSchema.parse(changed.json().data).credentialSchema.length,
      2,
      '置换语义：提交什么就是什么（与 P0-2-4 的凭据**值**是合并语义刻意相反）',
    )
  })

  await it('F7 `authType` 变更同样清缓存（枚举没有"清空"可言，但"变了"要认）', async () => {
    // P0 只支持 NONE ⇒ 唯一能造出的"变更"是 NONE → OAUTH，而它会被 400 拦住。
    // 所以这条**只能验到"拦截发生在清缓存之前"**：被拒的请求不得有任何副作用。
    const target = await createServer(creatorCookie, {
      name: `验证 MCP-authType-${suffix}`,
      endpointUrl: upstream.url,
    })
    const before = await rawRow(target.item.id)
    await api('PATCH', `/api/mcp/servers/${target.item.id}`, {
      cookie: creatorCookie,
      payload: { authType: 'OAUTH' },
    })
    const after = await rawRow(target.item.id)
    assertEqual(after.status, 'OK', '被拒的 authType 变更不该把 status 打回 UNKNOWN')
    assertEqual(
      JSON.stringify(after.toolCache),
      JSON.stringify(before.toolCache),
      '缓存也不该动（判据是"先校验、后清理"—— 顺序即正确性）',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  group('G 组 · 配置登记（P0-2-1 留的三个值必须仍是唯一来源）')
  // ═══════════════════════════════════════════════════════════════════

  await it('G1 MCP 三项配置已登记，超时是配置项（本脚本就是靠注入小值才跑得快）', () => {
    assertEqual(config.mcp.requestTimeoutMs, 5000, 'MCP_REQUEST_TIMEOUT_MS（本脚本注入值）')
    assertEqual(config.mcp.confirmTimeoutSec, 120, 'MCP_CONFIRM_TIMEOUT_SEC 默认值')
    assertEqual(config.mcp.toolLimit, 64, 'MCP_TOOL_LIMIT 默认值')
  })
} finally {
  // ── 最终清理（一律 `deleteMany`：清理阶段"目标已经不在了"是正常情况）──
  await upstream.close().catch(() => undefined)
  try {
    await prisma.agentComponent.deleteMany({ where: { agentId: { in: createdAgentIds } } })
    await prisma.agent.deleteMany({
      where: { OR: [{ id: { in: createdAgentIds } }, { name: { contains: suffix } }] },
    })
    await prisma.mcpServer.deleteMany({
      where: { OR: [{ id: { in: createdMcpIds } }, { slug: { contains: suffix } }] },
    })
    await prisma.model.deleteMany({ where: { OR: [{ id: { in: createdModelIds } }, { modelName: { contains: suffix } }] } })
    await prisma.modelProvider.deleteMany({
      where: { OR: [{ id: { in: createdProviderIds } }, { name: { contains: suffix } }] },
    })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    // MCP server 已在上方删掉（`created_by` 是 RESTRICT 外键，必须排在 users 之前）
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }

  // 残留复核（"删干净了"本身要是一条可复核的结论，而不是"我没报错"）
  const residue = {
    mcpServers: await prisma.mcpServer.count({ where: { slug: { contains: suffix } } }).catch(() => -1),
    agents: await prisma.agent.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    models: await prisma.model.count({ where: { modelName: { contains: suffix } } }).catch(() => -1),
    providers: await prisma.modelProvider.count({ where: { name: { contains: suffix } } }).catch(() => -1),
    users: await prisma.user.count({ where: { username: { contains: suffix } } }).catch(() => -1),
  }
  const dirty = Object.entries(residue).filter(([, count]) => count !== 0)
  const sessionsLeft = []
  for (const sid of sessionIds) {
    if ((await redis.exists(sessionKey(sid)).catch(() => 0)) !== 0) sessionsLeft.push(sid)
  }
  if (dirty.length === 0 && sessionsLeft.length === 0) {
    console.log(`  ${c.g}[PASS]${c.x} 残留复核：5 张表全部为 0，${sessionIds.length} 个会话键全部清空`)
    passed += 1
  } else {
    console.log(`  ${c.r}[FAIL]${c.x} 残留复核：表 ${JSON.stringify(residue)}｜会话键 ${sessionsLeft.length} 个`)
    failed += 1
  }

  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-2-2 MCP server 注册验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-2-2 MCP server 注册验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
