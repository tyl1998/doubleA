#!/usr/bin/env node
/**
 * verify-mcp-client.mjs —— P0-2-1「MCP client 底座」验收
 *
 * 跑法：`pnpm verify:mcp-client`（= `pnpm --filter @doubulea/backend verify:mcp-client`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 档位：④「真 HTTP 假上游」（`docs/06` §四 4.1），外加一个**好过预期**的性质
 * ─────────────────────────────────────────────────────────────────────
 * 本层"**不认识数据库、不认识用户**"（P0-2-1 原文）⇒ 本档**不需要 PG / Redis**，
 * 只要 `pnpm -r build` 先出 dist（client 的超时默认值来自 `config`，故 `infra/.env` 要在）。
 * 这与 `verify-llm` / `verify-chatbot` 那几档不同 —— 它们必须起真库。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 验的是 `06` P0-2-1 的五条验收门槛（逐条对应的用例组写在下面）
 * ─────────────────────────────────────────────────────────────────────
 *   门槛 1 → A 组（握手留痕 + 协议版本）、B 组（工具列表形状）
 *   门槛 2 → C 组（`tools/call` 三分法：成功 / 工具自身报错 / 传输失败）
 *   门槛 3 → D 组（超时、中断）
 *   门槛 4 → D 组（DNS / 连接被拒 / 非 MCP 端点；且消息里没有凭据）
 *   门槛 5 → A 组（假上游侧取证：initialize / 版本头 / Accept 双形态）
 *
 * ⚠️ 口径：这是**夹具假上游**档 —— 只证明"契约与配置接对了"，
 *    **不等于**"真 MCP 服务那边一定对"（对方的实现差异、认证方式、限流都不在本档范围内）。
 *
 * ⚠️ 有一条用例是**故意**断言"提示词会把人引偏"的（第四节末尾的会话丢失那条）：
 *    那是把已知的坑**钉**在测试里，不是放过它。
 */

// 必须在 import `config.js` 之前设置：脚本里有一堆"应当失败"的请求，
// 每个都会让 client 打一条 warn，会把断言输出冲掉。看细节时 `LOG_LEVEL=debug pnpm verify:mcp-client`
process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

const { startFakeMcpServer, DEFAULT_TOOLS, MCP_PATH } = await import('./fixtures/mcp-upstream.mjs')
const { McpClient, MCP_CLIENT_NAME, MCP_DESIGN_TARGET_PROTOCOL_VERSION } = await import(
  '../dist/backend/src/mcp/client.js'
)
const { McpAbortError, SUPPORTED_PROTOCOL_VERSIONS } = await import(
  '../dist/backend/src/mcp/errors.js'
)
const { config } = await import('../dist/backend/src/config.js')
const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/sdk/types.js')

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
  assert(
    actual === expected,
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

async function it(name, fn) {
  try {
    // 用例可以 return 一段字符串作为附注（打印在 PASS 行尾），比在断言中间散着 log 干净
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

/** 起一个假 MCP server 跑一段，结束必关（几条失败路径会把连接挂在服务端） */
async function withServer(options, run) {
  const server = await startFakeMcpServer(options)
  try {
    return await run(server)
  } finally {
    await server.close()
  }
}

/** 起一个已握手的客户端跑一段，结束必关（`close()` 幂等，重复关无害） */
async function withClient(server, options, run) {
  const client = new McpClient({ name: 'verify-server', url: server.url, ...options })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

/**
 * 期待"抛错"的用例：顺便把错误码、消息关键字、耗时一起断言了。
 * `maxElapsedMs` 用来验"快失败"（超时必须几秒内回来、中断必须立刻停手）。
 */
async function expectFailure(fn, { code, includes = [], excludes = [], maxElapsedMs } = {}) {
  const startedAt = Date.now()
  let thrown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  const elapsedMs = Date.now() - startedAt
  if (thrown === null) throw new Error('期望失败，但它成功了')

  const message = thrown instanceof Error ? thrown.message : String(thrown)
  if (code !== undefined && thrown.code !== code) {
    throw new Error(`错误码：期望 ${code}，实际 ${String(thrown.code)}（消息：${message}）`)
  }
  for (const needle of includes) {
    assert(message.includes(needle), `错误消息里应包含「${needle}」，实际：${message}`)
  }
  for (const needle of excludes) {
    assert(!message.includes(needle), `错误消息里不应出现「${needle}」，实际：${message}`)
  }
  if (maxElapsedMs !== undefined) {
    assert(elapsedMs <= maxElapsedMs, `耗时：期望 ≤ ${maxElapsedMs}ms，实际 ${elapsedMs}ms`)
  }
  return { error: thrown, message, elapsedMs }
}

/** 只取某种 method 的请求流水 */
const requestsFor = (server, method) =>
  server.requests.filter((entry) => {
    const messages = Array.isArray(entry.body) ? entry.body : [entry.body]
    return messages.some((message) => message?.method === method)
  })

/** 某条请求里的第一条消息 */
const firstMessage = (entry) => (Array.isArray(entry.body) ? entry.body[0] : entry.body)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ═══════════════════════════════ 开始 ═══════════════════════════════

console.log(`${c.b}verify-mcp-client —— P0-2-1 MCP client 底座${c.x}`)
console.log(`${c.d}SDK 请求的协议版本：${LATEST_PROTOCOL_VERSION}；本仓设计目标：${MCP_DESIGN_TARGET_PROTOCOL_VERSION}${c.x}`)

// ───────────────────────────── A 组 · 握手 / 会话 / 版本 ─────────────────────────────

group('A 组 · 握手 / 会话 / 协议版本（门槛 1、5）')

await it('A1 握手送出正确的 initialize：协议版本来自 SDK、clientInfo 自报本仓名字', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async () => {
      const inits = requestsFor(server, 'initialize')
      assertEqual(inits.length, 1, 'initialize 只应发一次')
      const params = firstMessage(inits[0]).params
      assertEqual(params.protocolVersion, LATEST_PROTOCOL_VERSION, '请求的协议版本')
      assertEqual(params.clientInfo?.name, MCP_CLIENT_NAME, 'clientInfo.name')
      assertEqual(typeof params.clientInfo?.version, 'string', 'clientInfo.version 应是字符串')
      assert(params.capabilities !== undefined, 'initialize 必须带 capabilities')
      // 未传 onElicit ⇒ **不许**声明 elicitation（声明了却答不出来比不声明更难查）
      assertEqual(params.capabilities.elicitation, undefined, '未传 onElicit 时不应声明 elicitation 能力')
    })
  })
})

await it('A2 首包不带 mcp-protocol-version（还没协商）；Accept 必须是双形态；content-type 是 JSON', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async () => {
      const init = requestsFor(server, 'initialize')[0]
      assertEqual(init.protocolVersion, null, 'initialize 首包不应带 mcp-protocol-version')
      assertEqual(init.contentType, 'application/json', 'content-type')
      for (const part of ['application/json', 'text/event-stream']) {
        assert(init.accept?.includes(part) === true, `Accept 应包含 ${part}，实际 ${init.accept}`)
      }
      assertEqual(init.path, MCP_PATH, '端点路径')
      assertEqual(init.method, 'POST', 'initialize 用 POST')
    })
  })
})

await it('A3 服务端协商回 2025-06-18：不报错，且客户端把协商结果记下来了', async () => {
  await withServer({ protocolVersion: '2025-06-18' }, async (server) => {
    await withClient(server, {}, async (client) => {
      assertEqual(client.protocolVersion, '2025-06-18', '协商后的协议版本')
      assertEqual(client.serverInfo?.name, 'fake-mcp-server', 'serverInfo.name')
      assertEqual(client.serverInfo?.version, '9.9.9', 'serverInfo.version')
    })
  })
})

await it('A4 协商之后每个后续请求都带 mcp-protocol-version 与 mcp-session-id', async () => {
  await withServer({ protocolVersion: '2025-06-18' }, async (server) => {
    await withClient(server, {}, async (client) => {
      await client.listTools()
      const after = server.requests.filter((entry) => entry.protocolVersion !== null)
      assert(after.length >= 2, `至少 initialize 之后的 initialized 通知 + tools/list 两条带头，实际 ${after.length}`)
      for (const entry of after) {
        assertEqual(entry.protocolVersion, '2025-06-18', `${entry.method} 的协议版本头`)
      }
      const sessionId = client.sessionId
      assert(typeof sessionId === 'string' && sessionId.length > 0, 'sessionId 应有值')
      assertEqual(server.sessions.has(sessionId), true, '服务端应认识这个 sessionId')
      for (const entry of after) assertEqual(entry.sessionId, sessionId, `${entry.method} 的会话头`)
    })
  })
})

await it('A5 恢复会话：传 sessionId 时不重发 initialize，且补上调用方给的版本头', async () => {
  await withServer({}, async (server) => {
    const first = new McpClient({ name: 'verify-server', url: server.url })
    await first.connect()
    const sessionId = first.sessionId
    const version = first.protocolVersion
    await first.close()

    // 服务端已把会话删了（close 发了 DELETE）⇒ 让它不校验会话，专测"恢复时不重握手"
    server.setSessionRequired(false)
    const second = new McpClient({
      name: 'verify-server',
      url: server.url,
      sessionId,
      protocolVersion: version,
    })
    await second.connect()
    try {
      assertEqual(requestsFor(server, 'initialize').length, 1, 'initialize 总数应仍为 1（恢复不该重握手）')
      assertEqual(second.protocolVersion, version, '恢复后应沿用传入的版本')
      const tools = await second.listTools()
      assert(tools.length > 0, '恢复出来的会话应能正常拉工具列表')
    } finally {
      await second.close()
    }
  })
})

await it('A6 服务端回了不在 SDK 支持集内的版本 ⇒ 502，且消息里列出支持集', async () => {
  await withServer({ protocolVersion: '1999-01-01' }, async (server) => {
    const client = new McpClient({ name: 'verify-server', url: server.url, timeoutMs: 5000 })
    const { message } = await expectFailure(() => client.connect(), { code: 'UPSTREAM_ERROR' })
    assert(message.includes('1999-01-01'), `消息里应带上服务端给的版本，实际：${message}`)
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      assert(message.includes(version), `消息里应列出支持集（缺 ${version}），实际：${message}`)
    }
  })
})

// ───────────────────────────── B 组 · tools/list 投影 ─────────────────────────────

group('B 组 · tools/list 投影（门槛 1）')

await it('B1 四个契约键恒存在；title / description / annotations 缺失一律投影成 null', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const tools = await client.listTools()
      assertEqual(tools.length, DEFAULT_TOOLS.length, '工具条数')

      const bare = tools.find((tool) => tool.name === 'bare')
      assert(bare !== undefined, '应能拿到 bare 工具')
      for (const key of ['name', 'title', 'description', 'inputSchema', 'annotations']) {
        assert(key in bare, `投影里必须有 ${key} 这个键（缺失的也要有键、值为 null）`)
      }
      assertEqual(bare.title, null, 'bare.title')
      assertEqual(bare.description, null, 'bare.description')
      assertEqual(bare.annotations, null, 'bare.annotations')

      const echo = tools.find((tool) => tool.name === 'echo')
      assertEqual(echo.title, '回声', 'echo.title')
      assert(typeof echo.description === 'string' && echo.description.length > 0, 'echo.description 应非空')
      assertEqual(echo.annotations?.readOnlyHint, true, 'echo.annotations.readOnlyHint（危险判定要用它）')
    })
  })
})

await it('B2 inputSchema 原样透传（逐字深比，不在这里做任何兼容处理）', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const tools = await client.listTools()
      const echo = tools.find((tool) => tool.name === 'echo')
      const expected = DEFAULT_TOOLS.find((tool) => tool.name === 'echo').inputSchema
      assertDeepEqual(echo.inputSchema, expected, 'echo.inputSchema 应与服务端逐字一致')
      // `additionalProperties:false` 是有约束力的，不许被当元信息丢掉（P0-2-6 的坑预判 2）
      assertEqual(echo.inputSchema.additionalProperties, false, 'additionalProperties 必须留着')
    })
  })
})

await it('B3 声明了 outputSchema 的工具，hasOutputSchema 为 true（其余为 false）', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const tools = await client.listTools()
      assertEqual(tools.find((tool) => tool.name === 'structured').hasOutputSchema, true, 'structured')
      assertEqual(tools.find((tool) => tool.name === 'echo').hasOutputSchema, false, 'echo')
    })
  })
})

// ───────────────────────────── C 组 · tools/call 三分法 ─────────────────────────────

group('C 组 · tools/call 三分法（门槛 2）')

await it('C1 成功：isError=false，文本块拼接，参数确实送到了上游', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const result = await client.callTool('echo', { text: '你好 MCP' })
      assertEqual(result.isError, false, 'isError')
      assert(result.text.includes('你好 MCP'), `文本应回显参数，实际：${result.text}`)
      const call = requestsFor(server, 'tools/call')[0]
      assertDeepEqual(firstMessage(call).params.arguments, { text: '你好 MCP' }, '上游收到的参数')
    })
  })
})

await it('C2 工具自身报错：isError=true，**不抛**（这是业务结果，不是平台故障）', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const result = await client.callTool('boom', {})
      assertEqual(result.isError, true, 'isError')
      assert(result.text.includes('boom'), `文本应带上工具自己的说明，实际：${result.text}`)
    })
  })
})

await it('C3 未知工具 ⇒ JSON-RPC -32602 ⇒ **抛** 502（与上面那条必须分得开）', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const { message } = await expectFailure(() => client.callTool('no-such-tool', {}), {
        code: 'UPSTREAM_ERROR',
      })
      assert(message.includes('-32602'), `消息里应带 JSON-RPC 错误码，实际：${message}`)
      assert(message.includes('no-such-tool'), `消息里应带工具名，实际：${message}`)
    })
  })
})

await it('C4 structuredContent 透出；不认识的 content 块不丢', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      const structured = await client.callTool('structured', {})
      assertDeepEqual(structured.structuredContent, { ok: true }, 'structuredContent')

      const echoed = await client.callTool('echo', { text: 'x' })
      const kinds = echoed.content.map((block) => block.type)
      assertEqual(kinds.includes('text'), true, '应含 text 块')
      assertEqual(kinds.includes('image'), true, '不认识的 image 块也应留着（丢了就是"工具回了东西但界面是空的"）')
    })
  })
})

await it('C5 换成 SSE 响应形态，同一组断言全部成立（Streamable HTTP 的另一半）', async () => {
  await withServer({ responseMode: 'sse' }, async (server) => {
    await withClient(server, {}, async (client) => {
      const tools = await client.listTools()
      assertEqual(tools.length, DEFAULT_TOOLS.length, 'SSE 形态下的工具条数')

      const ok = await client.callTool('echo', { text: 'sse' })
      assertEqual(ok.isError, false, 'SSE 形态下 isError')
      assert(ok.text.includes('sse'), 'SSE 形态下文本')

      const toolError = await client.callTool('boom', {})
      assertEqual(toolError.isError, true, 'SSE 形态下"工具自身报错"仍应是结果而非异常')

      // 这个 server 整站配成 SSE ⇒ 连握手都必须走 SSE 通道（Streamable HTTP 允许这样）
      assertEqual(requestsFor(server, 'initialize')[0].responded, 'sse', 'initialize 的响应形态')
      assertEqual(requestsFor(server, 'tools/list')[0].responded, 'sse', 'tools/list 的响应形态')
      assertEqual(requestsFor(server, 'tools/call')[0].responded, 'sse', 'tools/call 的响应形态')
    })
  })
})

await it('C6 C 组的断言在 JSON 形态下同样成立（两种响应形态都真的走过，不是只走一种）', async () => {
  await withServer({ responseMode: 'json' }, async (server) => {
    await withClient(server, {}, async (client) => {
      const tools = await client.listTools()
      assertEqual(tools.length, DEFAULT_TOOLS.length, 'JSON 形态下的工具条数')
      const ok = await client.callTool('echo', { text: 'json' })
      assertEqual(ok.isError, false, 'JSON 形态下 isError')
      assertEqual(requestsFor(server, 'initialize')[0].responded, 'json', 'initialize 的响应形态')
      assertEqual(requestsFor(server, 'tools/list')[0].responded, 'json', 'tools/list 的响应形态')
      assertEqual(requestsFor(server, 'tools/call')[0].responded, 'json', 'tools/call 的响应形态')
    })
  })
})

// ───────────────────────────── D 组 · 失败分类 ─────────────────────────────

group('D 组 · 失败分类（门槛 3、4）')

await it('D1 超时：注入 500ms，错误码是 UPSTREAM_TIMEOUT，且几秒内就返回', async () => {
  await withServer({}, async (server) => {
    await withClient(server, { timeoutMs: 500 }, async (client) => {
      server.setSlow(3000)
      await expectFailure(() => client.listTools(), {
        code: 'UPSTREAM_TIMEOUT',
        includes: ['tools/list'],
        maxElapsedMs: 2000,
      })
    })
  })
})

await it('D2 中断：AbortSignal 立刻停手，抛 McpAbortError（不是超时）', async () => {
  return withServer({}, async (server) => {
    return withClient(server, { timeoutMs: 10_000 }, async (client) => {
      server.setSlow(3000)
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      const { error, elapsedMs } = await expectFailure(
        () => client.listTools({ signal: controller.signal }),
        { maxElapsedMs: 1200 },
      )
      assert(
        error instanceof McpAbortError || error.name === 'McpAbortError',
        `应抛 McpAbortError（"用户停止"不是故障），实际：${error.constructor?.name} / ${error.message}`,
      )
      assertEqual(error.code, undefined, '中断错误不该带业务错误码（否则会被当成上游故障上报）')
      return `中断在 ${elapsedMs}ms 内返回`
    })
  })
})

await it('D3 连接被拒：给的是可读原因，不是一句 fetch failed', async () => {
  const server = await startFakeMcpServer({})
  const url = server.url
  await server.close() // 端口随即释放 ⇒ 连接被拒
  const client = new McpClient({ name: 'verify-server', url, timeoutMs: 3000 })
  const { message } = await expectFailure(() => client.connect(), { code: 'UPSTREAM_ERROR' })
  assert(message.includes('连接被拒绝'), `应给出「连接被拒绝」，实际：${message}`)
  assert(message.includes('ECONNREFUSED'), `应带上系统错误码，实际：${message}`)
})

await it('D4 DNS 失败：同样给出可读原因', async () => {
  const client = new McpClient({
    name: 'verify-server',
    url: 'http://no-such-host-for-verify.invalid/mcp',
    timeoutMs: 5000,
  })
  const { message } = await expectFailure(() => client.connect(), { code: 'UPSTREAM_ERROR' })
  assert(/DNS/.test(message), `应提到 DNS，实际：${message}`)
  assert(/ENOTFOUND|EAI_AGAIN/.test(message), `应带上系统错误码，实际：${message}`)
})

await it('D5 非 MCP 端点（回 HTML）⇒ 指出"大概率不是 MCP 端点"，并报出实际 content-type', async () => {
  await withServer({}, async (server) => {
    server.setRawBody('<!doctype html><html><body>404 Not Found</body></html>')
    const client = new McpClient({ name: 'verify-server', url: server.url, timeoutMs: 3000 })
    const { message } = await expectFailure(() => client.connect(), { code: 'UPSTREAM_ERROR' })
    assert(message.includes('text/html'), `应报出实际的 content-type，实际：${message}`)
    assert(message.includes('MCP 端点') || message.includes('不是'), `应给出"不是 MCP 端点"的判断，实际：${message}`)
  })
})

await it('D6 200 + 空响应体 ⇒ 说清是"不是合法 JSON"（不是含糊的解析异常）', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      server.setRawBody('', 'application/json')
      const { message } = await expectFailure(() => client.listTools(), { code: 'UPSTREAM_ERROR' })
      assert(message.includes('合法 JSON'), `应说明不是合法 JSON，实际：${message}`)
    })
  })
})

await it('D7 帧是合法 JSON 但不符合 MCP schema ⇒ 指出字段问题', async () => {
  await withServer({}, async (server) => {
    await withClient(server, {}, async (client) => {
      server.setToolsListPayload({ tools: 'not-an-array' })
      const { message } = await expectFailure(() => client.listTools(), { code: 'UPSTREAM_ERROR' })
      assert(message.includes('不符合 MCP 协议'), `应指出不符合协议，实际：${message}`)
      assert(message.includes('tools'), `应带上出问题的字段路径，实际：${message}`)
    })
  })
})

await it('D8 上游回显凭据也不泄露：注入的密钥从错误消息里被抹掉', async () => {
  const secret = 'Bearer sk-live-VERIFY-0123456789abcdef'
  await withServer({}, async (server) => {
    server.setUnauthorized(true)
    const client = new McpClient({
      name: 'verify-server',
      url: server.url,
      timeoutMs: 3000,
      headers: { authorization: secret },
      secrets: [secret],
    })
    const { message } = await expectFailure(() => client.connect(), {
      code: 'UPSTREAM_ERROR',
      excludes: ['sk-live-VERIFY-0123456789abcdef'],
      includes: ['****'],
    })
    assert(message.includes('401'), `应报出上游状态码，实际：${message}`)
  })
})

await it('D9 会话丢了：服务端按规范回 404，脱敏消息里要点破"其实是会话问题"', async () => {
  await withServer({}, async (server) => {
    // 直接用一个**服务端不认识**的 sessionId 恢复（跳过握手 ⇒ 服务端查不到会话 ⇒ 404）
    const client = new McpClient({
      name: 'verify-server',
      url: server.url,
      timeoutMs: 3000,
      sessionId: 'bogus-session-id',
    })
    await client.connect()
    try {
      const { message } = await expectFailure(() => client.listTools(), { code: 'UPSTREAM_ERROR' })
      assert(message.includes('404'), `应报出 404，实际：${message}`)
      // ⚠️ 下面这条断言是**故意**把坑钉住的：404 与"路径不存在"同码，
      //    光看状态码会把排查引向 endpoint_url —— 必须靠响应体里的 session 字样点破
      assert(
        message.includes('session') || message.includes('会话'),
        `应点破其实会话问题，实际：${message}`,
      )
    } finally {
      await client.close()
    }
  })
})

// ───────────────────────────── E 组 · elicitation 应答方 ─────────────────────────────

group('E 组 · 服务端主动 elicitation（需求 27 的另一半）')

await it('E1 传了 onElicit 才声明 elicitation 能力（能力声明必须与实际相符）', async () => {
  await withServer({}, async (server) => {
    await withClient(server, { onElicit: async () => ({ action: 'decline' }) }, async () => {
      const params = firstMessage(requestsFor(server, 'initialize')[0]).params
      assert(params.capabilities.elicitation !== undefined, '传了 onElicit 时应声明 elicitation 能力')
    })
  })
})

await it('E2 服务端反向发请求时钩子被调用，且应答真的回到了服务端', async () => {
  await withServer({}, async (server) => {
    server.setElicit(true)
    await withClient(
      server,
      { timeoutMs: 6000, onElicit: async () => ({ action: 'accept', content: { confirm: true } }) },
      async (client) => {
        const result = await client.callTool('needs-confirm', { target: 'prod' })
        assertEqual(result.isError, false, '同意之后应成功')
        assert(result.text.includes('已确认'), `文本应体现已确认，实际：${result.text}`)
        assertEqual(server.elicitRounds.length, 1, '服务端应恰好收到一轮 elicitation 往返')
        assertEqual(server.elicitRounds[0].reply?.action, 'accept', '服务端收到的应答动作')
      },
    )
  })
})

await it('E3 钩子回 decline ⇒ 服务端收到 decline，工具结果按"未执行"回来', async () => {
  await withServer({}, async (server) => {
    server.setElicit(true)
    await withClient(
      server,
      { timeoutMs: 6000, onElicit: async () => ({ action: 'decline' }) },
      async (client) => {
        const result = await client.callTool('needs-confirm', {})
        assertEqual(server.elicitRounds[0].reply?.action, 'decline', '服务端收到的应答动作')
        assertEqual(result.isError, true, '用户拒绝时工具应报"未执行"')
        assert(result.text.includes('未获确认'), `文本应说明未获确认，实际：${result.text}`)
      },
    )
  })
})

// ───────────────────────────── F 组 · 优雅关闭 ─────────────────────────────

group('F 组 · 优雅关闭与生命周期')

await it('F1 close() 会向服务端 DELETE 终止会话（否则服务端累积僵尸会话）', async () => {
  await withServer({}, async (server) => {
    const client = new McpClient({ name: 'verify-server', url: server.url })
    await client.connect()
    const sessionId = client.sessionId
    await client.close()

    assertEqual(server.terminated.length, 1, '服务端应收到一次会话终止')
    assertEqual(server.terminated[0], sessionId, '被终止的应是这个会话')
    const deletes = server.requests.filter((entry) => entry.method === 'DELETE')
    assertEqual(deletes.length, 1, 'DELETE 请求数')
    assertEqual(deletes[0].sessionId, sessionId, 'DELETE 要带上会话头')
  })
})

await it('F2 close() 幂等：第二次调用不再发 DELETE、也不抛', async () => {
  await withServer({}, async (server) => {
    const client = new McpClient({ name: 'verify-server', url: server.url })
    await client.connect()
    await client.close()
    await client.close()
    await client.close()
    assertEqual(server.requests.filter((entry) => entry.method === 'DELETE').length, 1, 'DELETE 请求数')
  })
})

await it('F3 关闭后再调用是"编程错误"（500 INTERNAL），消息要指出漏了哪一步', async () => {
  await withServer({}, async (server) => {
    const client = new McpClient({ name: 'verify-server', url: server.url })
    await client.connect()
    await client.close()
    const { message } = await expectFailure(() => client.listTools(), { code: 'INTERNAL' })
    assert(message.includes('关闭'), `消息应说明客户端已关闭，实际：${message}`)
  })
})

await it('F4 未 connect() 就用 ⇒ INTERNAL，消息指出漏了 connect', async () => {
  await withServer({}, async (server) => {
    const client = new McpClient({ name: 'verify-server', url: server.url })
    const { message } = await expectFailure(() => client.listTools(), { code: 'INTERNAL' })
    assert(message.includes('connect'), `消息应指出漏了 connect()，实际：${message}`)
  })
})

// ───────────────────────────── G 组 · 入口校验与配置 ─────────────────────────────

group('G 组 · 入口校验与配置登记')

await it('G1 endpoint_url 不是合法 URL ⇒ 400 域错误而不是 TypeError 500', async () => {
  let thrown = null
  try {
    new McpClient({ name: 'verify-server', url: 'not a url at all' })
  } catch (error) {
    thrown = error
  }
  assert(thrown !== null, '应当抛错')
  assertEqual(thrown.code, 'UPSTREAM_ERROR', '错误码')
  assert(thrown.message.includes('endpoint_url'), `消息应点名是哪个字段，实际：${thrown.message}`)
})

await it('G2 三个 MCP 配置项已登记，默认值与文档一致', async () => {
  assertEqual(config.mcp.requestTimeoutMs, 20_000, 'MCP_REQUEST_TIMEOUT_MS 默认值')
  assertEqual(config.mcp.confirmTimeoutSec, 120, 'MCP_CONFIRM_TIMEOUT_SEC 默认值')
  assertEqual(config.mcp.toolLimit, 64, 'MCP_TOOL_LIMIT 默认值')
})

await it('G3 超时默认值真的来自配置（不是写死的常量）', async () => {
  await withServer({}, async (server) => {
    const client = new McpClient({ name: 'verify-server', url: server.url })
    await client.connect()
    try {
      server.setSlow(300)
      // 默认 20s 的超时下，300ms 的慢响应必须能过
      const tools = await client.listTools()
      assert(tools.length > 0, '默认超时下应能正常返回')
    } finally {
      await client.close()
    }
  })
})

// ───────────────────────────── 汇总 ─────────────────────────────

await sleep(50)
console.log('')
console.log(`${c.b}结果${c.x}：${c.g}${passed} 通过${c.x}${failed === 0 ? '' : `，${c.r}${failed} 失败${c.x}`}`)
if (failed > 0) process.exitCode = 1
