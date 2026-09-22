/**
 * 夹具：**假对话上游**（OpenAI 兼容 `POST {base}/chat/completions`，SSE 流式）
 *
 * 为什么需要它（P0-1-27）：编排循环的核心动作之一就是"把上游的增量按原样透传成 `delta`/`thinking`
 * 事件"，而**上游的时序**（几个增量、什么时候结束、有没有 `reasoning_content`、结束原因是什么）
 * 恰恰是这条链路最该验的东西。接真厂商在这里是纯噪声：网络抖动、限额、以及"厂商今天发的报文
 * 变没变"都不是我们要测的对象（`06` 的第四档口径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 关键设计：回答文本**只从请求里抄**
 * ─────────────────────────────────────────────────────────────────────
 * 默认脚本（{@link defaultScriptFor}）会去 system 消息里找检索块的「来源：文档名」行，
 * 找到就回"根据《X》……"，找不到就说"知识库里没有找到依据"。
 * 这条设计让**两条验收原文变成可判定的**：
 *   · "回答含 `citations` 事件、**内容与检索片段一致**" ⇒ 回答里出现那个文档名，
 *     而这个名字**只可能来自注入给模型的检索块**（夹具不会凭空知道库里有什么文档）；
 *   · "未命中时不编造来源" ⇒ 未命中那一路的回答里**不可能**出现任何文档名。
 * 换句话说：这个夹具把"prompt 里到底有没有那段资料"变成了**回答文本上的可观测差异**。
 *
 * ⚠️ 用法上的顺序（与 `embedding-upstream.mjs` 同款）：调用方要先起本夹具、再把它写进
 * Provider 的 `base_url`（P0-1-27 的验收脚本是"先起夹具 → 起后端子进程 → 用 API 建 Provider"）。
 *
 * 请求体**全量记录**（`requests[]`）—— 本批有一半断言落在"发给上游的报文上"：
 * system prompt 的拼装（人格 + 规则 + 检索块）、历史轮数与顺序、`stream: true`、
 * 以及"**不**该出现的字段真的没出现"。
 */

import http from 'node:http'

/** 默认增量脚本：从 system 消息的检索块里抄出第一个文档名 */
function defaultScriptFor(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = messages.find((message) => message?.role === 'system')?.content
  const text = typeof system === 'string' ? system : ''
  const names = [...text.matchAll(/^\d+\. 来源：(.+)$/gm)].map((match) => match[1])
  if (names.length === 0) {
    return ['知识库检索结果里没有', '与这个问题相关的内容，', '我不能凭推测编造来源。']
  }
  const first = names[0]
  return [`根据《${first}》的内容，`, '相关依据如下：', `（来源：${first}）`]
}

/**
 * 启动假对话上游。
 *
 * @param {{
 *   model?: string,
 *   thinking?: boolean,
 *   deltaDelayMs?: number,
 *   script?: (body: object) => string[],
 * }} [options]
 * @returns {Promise<{
 *   baseUrl: string, url: string, requests: object[],
 *   setMode: (mode: 'normal'|'stall'|'error') => void,
 *   setScript: (script: (body: object) => string[]) => void,
 *   close: () => Promise<void>,
 * }>}
 *   · `url` = `{baseUrl}/v1`（与真厂商习惯一致，直接塞进 Provider 的 `base_url`）；
 *   · `requests[]` = 每个请求的 `{method,path,auth,contentType,body}`（**全量记录**）；
 *   · `setMode('stall')` = **不回响应头**、只周期发 SSE 注释行（`:` 开头）——
 *     用于"占着一个编排名额"（P0-1-27 的并发闸用例）；注释行同时重置客户端的**流内空闲**计时，
 *     于是这条连接会一直挂到调用方主动断开（这正是"在飞"所需要的语义）。
 *   · `setMode('error')` = 回 500 + OpenAI 形态的 `{error}` —— 验"上游坏了 ⇒ 流内 `error` 事件
 *     且已生成的内容仍然落库"。
 *   · `setScript(...)` 换一份增量脚本（用同一份夹具做第二个用例时不必重启）。
 */
export async function startFakeChatUpstream(options = {}) {
  const model = options.model ?? 'verify-chat-model'
  const deltaDelayMs = options.deltaDelayMs ?? 20
  const withThinking = options.thinking === true
  /** 上游侧看到的每个请求（报文形状、system prompt、历史、凭据都在这里被取证） */
  const requests = []
  let mode = 'normal'
  let script = options.script ?? defaultScriptFor

  const server = http.createServer(async (req, res) => {
    const pieces = []
    for await (const piece of req) pieces.push(piece)
    const raw = Buffer.concat(pieces).toString('utf8')
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const body = raw === '' ? null : JSON.parse(raw)
    requests.push({
      method: req.method,
      path,
      auth: req.headers.authorization ?? null,
      contentType: req.headers['content-type'] ?? null,
      body,
    })

    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no such path: ${path}` } }))
      return
    }
    if (mode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fake chat upstream failure (toggled by setMode)' } }))
      return
    }
    if (mode === 'stall') {
      // 只发注释行（`:` 开头）：SSE 规范里是心跳，客户端解析器会忽略它但**重置流内空闲计时**
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write(': stall\n\n')
      const timer = setInterval(() => {
        if (res.writableEnded) return
        res.write(': stall\n\n')
      }, 300)
      timer.unref?.()
      res.on('close', () => clearInterval(timer))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const chunk = (delta, extra = {}) => ({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })

    // 首帧只带 role（**刻意如此**：客户端必须跳过"只有 role 没有 content"的帧，见 `02` §6.1 清单 4）
    send(chunk({ role: 'assistant' }))
    if (withThinking) {
      send(chunk({ reasoning_content: '我先看看检索结果里有哪几篇文档。' }))
    }
    for (const piece of script(body ?? {})) {
      await new Promise((resolve) => setTimeout(resolve, deltaDelayMs))
      send(chunk({ content: piece }))
    }
    // 最后一帧带 `finish_reason` 与 usage：契约里 `done.usage` 的来源就是它
    // （客户端**刻意不发** `stream_options`，所以上游"顺手给"才拿得到 —— 这正是本仓的兼容口径）
    send({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    baseUrl: base,
    url: `${base}/v1`,
    requests,
    setMode: (value) => {
      mode = value
    },
    setScript: (value) => {
      // `null`/`undefined` = **恢复默认脚本**（"从请求里抄文档名"那一份）。
      // 之所以要有"恢复"这个语义：同一份夹具在一个脚本里要服务多个用例（C 组用完慢增量脚本
      // 就要还给默认的），而"再传一个 defaultScriptFor"要求调用方知道它的形状。
      script = value ?? defaultScriptFor
    },
    close: async () => {
      // "stall" 那条路径上会挂着长连接 ⇒ 先断开再关，否则 close 会一直等
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
