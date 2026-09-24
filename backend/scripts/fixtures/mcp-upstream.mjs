/**
 * 夹具：**假 MCP server**（Streamable HTTP；`docs/06` §四 4.1 的第四档 / 第五档）
 *
 * 依据：`docs/06-实施计划.md` §四 4.1（第四档"真 HTTP 假上游"）+ §4.3（协议与信封）
 *      + P0-2-1 坑预判 1、2（**两种响应形态都要走**；**会话是有状态的**）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不去连一个真 MCP 服务
 * ─────────────────────────────────────────────────────────────────────
 * 与 `chat-upstream.mjs` / `embedding-upstream.mjs` 同一条理由（`06` 第五档）：凭据、
 * 网络、第三方版本变更都是噪声，而"**我们发出去的报文对不对**"反而验不到。
 * 这里起一个**真的 HTTP 服务**（`http.createServer` + 端口 0）按 MCP 协议应答，
 * 并把**每个请求原样记下来**（method / path / 查询串 / 五个关键头 / 全部头名 / body）——
 * 于是"握手发没发 initialize""`mcp-protocol-version` 带没带""Accept 是不是双形态"
 * "凭据到底注到了哪一层（头 / 查询串 / 报文体）"这类问题都能在**上游侧取证**，
 * 而不是靠读代码猜。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它刻意支持的三件事（少一件就有需求验不了）
 * ─────────────────────────────────────────────────────────────────────
 * 1. **两种响应形态**（坑预判 1）：同一条 `POST` 可以回 `application/json`，也可以回
 *    `text/event-stream`。只支持一种的假上游会让**另一条路从来没被走过**
 *    ⇒ {@link FakeMcpServer.setResponseMode} 两种都能切。
 * 2. **会话是有状态的**（坑预判 2）：`initialize` 响应回 `Mcp-Session-Id`，
 *    之后**每个**请求都必须带上；不带/不认识时按规范回 **404**（这一步就是"静默故障"的来源：
 *    404 和"路径写错"同码，不看 body 分不出来）。
 * 3. **服务端主动 elicitation**（需求 27 的另一半）：`setElicit(true)` 之后调用 `needs-confirm`
 *    工具，服务端会在**同一条 SSE 流上反向发一个请求**，等客户端的应答到位再收尾
 *    ⇒ 没有它，"我们能当 elicitation 应答方"这条只能验一半（`06` §4.1 的 ⚠️）。
 *
 * ⚠️ 用法：本夹具起的服务在 `127.0.0.1` 的**随机端口**上，`url` 形如
 * `http://127.0.0.1:PORT/mcp`（Streamable HTTP 的端点是**单一 URL**，不拼路径段）。
 */

import { randomUUID } from 'node:crypto'
import http from 'node:http'

/** MCP 端点路径 —— 刻意不是 `/`：这样"路径写错"的 404 才有东西可验 */
export const MCP_PATH = '/mcp'

/** 默认工具集：**每个工具都对应一种必须验到的形状**（名字即用途，别改语义） */
export const DEFAULT_TOOLS = [
  {
    name: 'echo',
    title: '回声',
    description: '把参数里的 text 原样回显。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的内容' } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    // 没有 title / description / annotations ⇒ 验"缺失一律投影成 null"
    name: 'bare',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    // 永远 isError:true ⇒ 验"工具自身报错 ≠ 传输失败"
    name: 'boom',
    description: '一个总是失败的工具（用于区分「工具自身报错」与「传输失败」）。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
  {
    // 声明了 outputSchema ⇒ 验 hasOutputSchema 留痕 + structuredContent 透出
    name: 'structured',
    description: '返回结构化输出的工具。',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
  {
    // 配合 setElicit(true)：服务端要反向问一句才继续
    name: 'needs-confirm',
    description: '一个会先征求用户确认的危险工具。',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
]

/** 把 JSON 写到响应上（同时记下形态，便于断言"这条是 JSON 回的"） */
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

/** 一条 SSE 帧（`data: {...}\n\n`） */
function sseFrame(res, message) {
  res.write(`data: ${JSON.stringify(message)}\n\n`)
}

/** 一个只能在外部 resolve 的 promise（等客户端的 elicitation 应答） */
function createDeferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 请求体解析（空串 → null；非 JSON 保留原文，便于断言"我们到底发了什么"） */
function parseBody(raw) {
  if (raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

/**
 * 启动假 MCP server。
 *
 * @param {{
 *   protocolVersion?: string,   // initialize 响应里回的版本（默认 2025-06-18 = 本仓的设计目标）
 *   serverName?: string,
 *   responseMode?: 'json' | 'sse',
 *   sessionRequired?: boolean,
 *   tools?: unknown[],
 *   slowToolDelayMs?: number,   // `needs-confirm` 之外，`tools/call` 的固定延迟（默认 0）
 * }} [options]
 */
export async function startFakeMcpServer(options = {}) {
  /** 可变状态（全部通过返回对象的 setter 改，避免调用方拿到裸对象乱改） */
  const state = {
    protocolVersion: options.protocolVersion ?? '2025-06-18',
    serverName: options.serverName ?? 'fake-mcp-server',
    responseMode: options.responseMode ?? 'json',
    sessionRequired: options.sessionRequired !== false,
    tools: options.tools ?? DEFAULT_TOOLS,
    slowMs: 0,
    slowToolDelayMs: options.slowToolDelayMs ?? 0,
    failing: false,
    unauthorized: false,
    rawBody: null,
    rawContentType: 'text/html; charset=utf-8',
    elicit: false,
    rpcErrors: new Map(),
    /** 非 null 时 `tools/list` 直接回这个 payload —— 用于验"帧不符合协议 schema" */
    toolsListPayload: null,
  }

  /** 全部请求流水（断言用：报文形状、五个关键头、次数都在这里取证） */
  const requests = []
  /** 已签发的会话 id（顺序签发） */
  const sessions = new Set()
  /** 被 DELETE 终止的会话 id */
  const terminated = []
  /** elicitation 往返记录：`[{ request, reply }]` */
  const elicitRounds = []
  /** 同一时刻只允许一个挂起的 elicitation（P0 一次调一个工具，够用） */
  let pendingElicit = null
  let elicitSeq = 0

  const server = http.createServer(async (req, res) => {
    // ── 读完整请求体（必须读完再应答，否则客户端会 EPIPE）──
    const chunks = []
    for await (const piece of req) chunks.push(piece)
    const raw = Buffer.concat(chunks).toString('utf8')

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const entry = {
      method: req.method,
      path: url.pathname,
      /**
       * 查询串（解析成对象，无参数时为 `{}`）。
       * 用途：P0-2-3 的 H 组探针要验"QUERY 注入到底有没有真的上到线上"——
       * 只看客户端代码是看不出自定义 `fetch` 有没有改 URL 的。
       */
      query: Object.fromEntries(url.searchParams),
      /** 三个必验的头 + 两个可验的头（`Accept` 的双形态是 Streamable HTTP 的硬要求） */
      accept: req.headers.accept ?? null,
      contentType: req.headers['content-type'] ?? null,
      protocolVersion: req.headers['mcp-protocol-version'] ?? null,
      sessionId: req.headers['mcp-session-id'] ?? null,
      lastEventId: req.headers['last-event-id'] ?? null,
      /**
       * 收到**全部**头名（小写）。用途同 `query`：HEADER 注入的取证点。
       * 与上面五个"点名的头"分开：那五个是断言用的，这个是"有没有多出东西"用的。
       */
      headerNames: Object.keys(req.headers),
      body: parseBody(raw),
      /** 这一条是用什么形态回的（`json` / `sse` / `error:*` / `raw` / `terminate`） */
      responded: null,
    }
    requests.push(entry)

    // ── 0. "非 MCP 端点"的模拟：整站回固定内容（最优先，要覆盖一切）──
    if (state.rawBody !== null) {
      entry.responded = 'raw'
      res.writeHead(200, { 'content-type': state.rawContentType })
      res.end(state.rawBody)
      return
    }

    // ── 1. 路径不对 ──
    if (url.pathname !== MCP_PATH) {
      entry.responded = 'error:404'
      return sendJson(res, 404, { error: { message: `no such path: ${url.pathname}` } })
    }

    // ── 2. DELETE = 终止会话（Streamable HTTP 的优雅关闭）──
    if (req.method === 'DELETE') {
      const sessionId = entry.sessionId
      if (sessionId === null || !sessions.has(sessionId)) {
        entry.responded = 'error:404'
        return sendJson(res, 404, { error: { message: `session not found (mcp-session-id=${sessionId})` } })
      }
      sessions.delete(sessionId)
      terminated.push(sessionId)
      entry.responded = 'terminate'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end()
      return
    }

    // ── 3. GET = 独立 SSE 流（P0 不用；明确回 405，好过静默挂着）──
    if (req.method === 'GET') {
      entry.responded = 'error:405'
      return sendJson(res, 405, { error: { message: 'this fake server does not expose a standalone SSE stream' } })
    }

    if (req.method !== 'POST') {
      entry.responded = 'error:405'
      return sendJson(res, 405, { error: { message: `method not allowed: ${req.method}` } })
    }

    // ── 4. 故障注入（都在"正常处理"之前）──
    if (state.slowMs > 0) await sleep(state.slowMs)
    if (state.failing) {
      entry.responded = 'error:500'
      return sendJson(res, 500, { error: { message: 'fake MCP failure (toggled by setFailing)' } })
    }
    if (state.unauthorized) {
      // ⚠️ 刻意**回显**收到的凭据：真实网关 401 常把收到的 Authorization 原样写进 body，
      //    这正是"错误消息里不能有凭据"（验收门槛 4）必须能验到的场景
      entry.responded = 'error:401'
      return sendJson(res, 401, {
        error: {
          message: 'invalid api key',
          receivedAuthorization: req.headers.authorization ?? null,
          receivedHeaders: Object.keys(req.headers),
        },
      })
    }

    const messages = Array.isArray(entry.body) ? entry.body : [entry.body]
    // ── 5. 客户端在回我们的 elicitation（这批消息**没有 method**）──
    const isClientResponse = messages.every(
      (message) => message !== null && typeof message === 'object' && message.method === undefined,
    )
    if (isClientResponse && pendingElicit !== null) {
      const answer = messages.find((message) => message.id === pendingElicit.id)
      pendingElicit.resolve(answer?.result ?? null)
      pendingElicit = null
      entry.responded = '202'
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end()
      return
    }

    // ── 6. 会话校验（`initialize` 本身除外）──
    const methods = messages.map((message) => message?.method).filter((m) => typeof m === 'string')
    const hasInitialize = methods.includes('initialize')
    if (state.sessionRequired && !hasInitialize) {
      const sessionId = entry.sessionId
      if (sessionId === null || !sessions.has(sessionId)) {
        // 规范要求 404（与"路径不存在"同码 ⇒ 这就是坑预判 2 说的"不报会话丢了"）
        entry.responded = 'error:404'
        return sendJson(res, 404, {
          error: { message: `session not found (mcp-session-id=${sessionId ?? 'missing'})` },
        })
      }
    }

    // ── 7. 逐条处理 ──
    const responses = []
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue
      const method = message.method
      const id = message.id

      // 通知（无 id）：202 即可
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        entry.responded = '202'
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end()
        return
      }
      if (typeof method !== 'string' || id === undefined) continue

      const injected = state.rpcErrors.get(method)
      if (injected !== undefined) {
        responses.push({ jsonrpc: '2.0', id, error: injected })
        continue
      }

      if (method === 'initialize') {
        const sessionId = randomUUID()
        sessions.add(sessionId)
        res.setHeader('mcp-session-id', sessionId)
        responses.push({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: state.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: state.serverName, version: '9.9.9' },
            instructions: '这是假 MCP server 的说明（P0 不使用）。',
          },
        })
        continue
      }

      if (method === 'tools/list') {
        responses.push({
          jsonrpc: '2.0',
          id,
          result: state.toolsListPayload ?? { tools: state.tools },
        })
        continue
      }

      if (method === 'tools/call') {
        const toolName = message.params?.name
        const args = message.params?.arguments ?? {}

        if (!state.tools.some((tool) => tool.name === toolName)) {
          responses.push({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          })
          continue
        }

        // elicitation 分支：**必须走 SSE**（服务端要在同一条连接上反向发请求；
        // JSON 响应体是一次性的，发完就结束，没法"等客户端回话再继续"）
        if (toolName === 'needs-confirm' && state.elicit) {
          if (entry.responded === null) entry.responded = 'sse'
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          const elicitId = `elicit-${(elicitSeq += 1)}`
          const deferred = createDeferred()
          pendingElicit = { id: elicitId, resolve: deferred.resolve }
          sseFrame(res, {
            jsonrpc: '2.0',
            id: elicitId,
            method: 'elicitation/create',
            params: {
              message: `即将执行「${toolName}」，确认吗？`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: '确认' } },
                required: ['confirm'],
              },
            },
          })
          const reply = await deferred.promise
          elicitRounds.push({ request: { toolName, args }, reply })
          const accepted = reply?.action === 'accept'
          sseFrame(res, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: accepted ? `已确认并执行：${toolName}` : `未获确认（${reply?.action ?? '无应答'}），未执行`,
                },
              ],
              ...(accepted ? {} : { isError: true }),
            },
          })
          res.end()
          return
        }

        if (state.slowToolDelayMs > 0) await sleep(state.slowToolDelayMs)

        if (toolName === 'boom') {
          responses.push({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'boom：工具内部失败了' }],
              isError: true,
            },
          })
          continue
        }
        if (toolName === 'structured') {
          responses.push({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: '{"ok":true}' }],
              structuredContent: { ok: true },
            },
          })
          continue
        }
        if (toolName === 'bare') {
          responses.push({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } })
          continue
        }
        // 默认（含 echo）：把参数回显出来，于是"参数到底有没有传到"能当场看见
        responses.push({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: `${toolName}: ${JSON.stringify(args)}` },
              // 夹一个非文本块：验"读侧不丢不认识的块"
              { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            ],
          },
        })
        continue
      }

      // 其余方法一律不认（P0 只用 initialize / tools/list / tools/call）
      responses.push({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    }

    if (responses.length === 0) {
      entry.responded = '202'
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end()
      return
    }

    if (state.responseMode === 'sse') {
      entry.responded = 'sse'
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const message of responses) sseFrame(res, message)
      res.end()
      return
    }

    entry.responded = 'json'
    // 多帧时回**数组**：这也是 Streamable HTTP 允许的一种 JSON 形态，
    // 顺手把"我们读的是不是只认单对象"这件事验掉
    return sendJson(res, 200, responses.length === 1 ? responses[0] : responses)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  return {
    /** 端点地址（Streamable HTTP 单 URL） */
    url: `${base}${MCP_PATH}`,
    baseUrl: base,
    requests,
    sessions,
    terminated,
    elicitRounds,
    /** 每个 POST 的形态（`json` / `sse` / …）—— 断言"两种形态都真的走过" */
    responseModes: () => requests.map((entry) => entry.responded),

    setProtocolVersion: (value) => {
      state.protocolVersion = value
    },
    setResponseMode: (mode) => {
      state.responseMode = mode === 'sse' ? 'sse' : 'json'
    },
    setSessionRequired: (value) => {
      state.sessionRequired = value !== false
    },
    setTools: (tools) => {
      state.tools = tools
    },
    /**
     * 让 `tools/list` 直接回这个 payload（`null` 表示恢复）。
     * 用途：验"帧是合法 JSON、但不符合 MCP 的 schema"（SDK 用 zod 校验后 reject）。
     */
    setToolsListPayload: (payload) => {
      state.toolsListPayload = payload ?? null
    },
    /** 之后所有请求回 500 */
    setFailing: (value) => {
      state.failing = value === true
    },
    /** 之后所有请求回 401，并把收到的凭据**回显**在 body 里（验脱敏用） */
    setUnauthorized: (value) => {
      state.unauthorized = value === true
    },
    /** 响应前先等 `ms` 毫秒（验超时分支用；客户端应在此**之前**就放弃） */
    setSlow: (ms) => {
      state.slowMs = Number.isFinite(ms) && ms > 0 ? ms : 0
    },
    /** 整站回固定内容 —— 模拟"这个地址根本不是 MCP 端点"（默认回一段 HTML） */
    setRawBody: (text, contentType = 'text/html; charset=utf-8') => {
      state.rawBody = typeof text === 'string' ? text : null
      state.rawContentType = contentType
    },
    /** 打开之后调用 `needs-confirm` 会触发服务端主动 elicitation */
    setElicit: (value) => {
      state.elicit = value === true
    },
    /** 让某个方法回 JSON-RPC 错误（`null` 表示撤销） */
    setRpcError: (method, error) => {
      if (error === null || error === undefined) state.rpcErrors.delete(method)
      else state.rpcErrors.set(method, error)
    },

    close: async () => {
      // 超时/中断那条路径上连接是**挂着**的（客户端不等了，服务端还在 sleep）
      // ⇒ 先强断再关，否则 close 会一直等
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
