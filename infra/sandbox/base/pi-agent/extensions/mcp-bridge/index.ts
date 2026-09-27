/**
 * mcp-bridge —— 沙箱内的 **MCP 桥扩展**（P0-3-9b 的实现）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §七（MCP 走后端代理：定案 / 调用链 / 三条通道要素 /
 *      工具清单与唯一反查点 / 危险判定第二落点 / 三条安全约束）、§六 1（后端对端 =
 *      `backend/src/sandbox/bridge.ts` 的桥 + `backend/src/sandbox/proxy.ts` 的两个端点）、
 *      §二（`SANDBOX_PROXY_TIMEOUT_SEC`）、pi 包内 `docs/extensions.md`（工厂约束 / ToolDefinition /
 *      "Throw from `execute()`"）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一句话：**容器里的引擎永不直连 MCP** —— 本文件只做两件事：把"我们下发的 MCP 工具"
 * 注册进 pi，并把每一次调用转成对后端的**一次内网 HTTP 请求**
 * ═══════════════════════════════════════════════════════════════════════
 * ```
 * session_start
 *   → GET  {SANDBOX_BACKEND_URL}/api/sandbox/mcp/tools     （头：x-sandbox-token）
 *   → 拿到**已重命名**的清单 `mcp_<alias>_<toolName>`（名字由后端定，见 `proxy.ts`）
 *   → pi.registerTool(...) 逐个注册（参数 schema 原样转交）
 * 模型调用某个 `mcp_*` 工具
 *   → POST {SANDBOX_BACKEND_URL}/api/sandbox/mcp/call      （头：同上；体：{serverAlias, toolName, arguments}）
 *   → 后端：越权检查 → 危险判定 →（必要时）**跨请求问用户** → 调 MCP → 回 `{isError, text}`
 *   → 这里把 text 原样交给 pi（本层**不认识 MCP**：不知道 server 是谁，也不知道危不危险）
 * ```
 *
 * ★ 四件**刻意不在这一层做**的事（§七 5 / §七 6）：
 *   · **不做危险判定** —— `isDangerousTool` 全仓只有一个实现（`backend/src/mcp/risk.ts`），
 *     而容器侧**连 `annotations` 都拿不到**（`mcpMap.ts` 刻意不下发它）⇒ 想做也做不了；
 *   · **不算别名映射** —— `alias`（`s1`/`s2`…）是**本次会话**的编号，由后端分配并持有，
 *     这里只把 `serverAlias` 原样带回去（反查的唯一实现在 `mcpMap.ts#resolveSandboxMcpTool`）；
 *   · **不碰任何凭据** —— MCP 的用户凭据留在后端（`executeMcpToolCall` 拿会话发起者的）；
 *     容器里只有一只**只对本会话有效**的代理令牌；
 *   · **不做重试/降级** —— 失败就是失败（§六 27：服务间调用不做兜底）。
 *   ⇒ 一句话：**本层没有任何策略**，它是一个瘦转发器。所有判断都在 `sandbox/proxy.ts`。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 四条 pi 上游约束（`docs/extensions.md`）与本文件的落点
 * ═══════════════════════════════════════════════════════════════════════
 *  ① **工厂函数里不许起进程 / socket / watcher / 定时器**（有些调用 —— `pi --version`、
 *     `pi list` —— 会加载扩展但**不启动会话**；`undici` 的连接池就是 socket 的一种）。
 *     ⇒ 工厂里只读 env、只挂 handler；**所有网络请求都发生在 `session_start` 之后**。
 *  ② **`registerTool` 可以在 `session_start` 里动态调用** —— 工具清单要联网才知道，
 *     没法在工厂里注册（而工厂里又不能联网）。这是"清单必须在会话开始前拿到"的唯一落点。
 *  ③ ★ **`throw` 才是"这一趟失败了"** —— 上游原话：*"Throw from `execute()` to produce a
 *     failed tool result. **Returning an object does not mark it as an error.**"*
 *     ⇒ 后端回的 `{isError:true, text}` **必须抛出去**：悄悄返回一个对象会让卡片显示成功，
 *     而模型也看不出失败（`map.ts` 正是按 `tool_execution_end.isError` 定 `status` 的）。
 *     抛出的 `message` 会成为模型读到的那份失败结果。
 *  ④ **不调用 `ctx.ui.notify`** —— RPC 模式下 UI 通知走的是**另一条 RPC 子协议**
 *     （pi `docs/rpc.md` 的 "RPC-only events"），而我们的后端桥**没有接它**
 *     （`map.ts` 把不认识的事件只留痕）⇒ 报错只走 **stderr**（后端把容器 stderr 收进日志，
 *     见 `bridge.ts` 的 stderr 尾巴），发一条 notify 只会多一条"不认识的事件"。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 显式失败，不静默降级（§四 3 / `06` §六 27 的同一条纪律）
 * ═══════════════════════════════════════════════════════════════════════
 * `SANDBOX_BACKEND_URL` / `SANDBOX_TOKEN` 缺失，或工具清单拉不到时：**一个工具都不注册**，
 * 并往 stderr 写一行 `[mcp-bridge] ERROR …`。
 *   · 为什么**不注册**而不是"注册一个永远报错的工具"：后者会把一次基础设施故障讲成
 *     "某个 MCP 工具坏了"，而模型会照着自己的理解向用户复述（`02` §十：内部细节不进用户可见面）。
 *   · 为什么**必须喊出来**：本层的失败**只有 stderr 一个出口**（见 ④），漏了它就等于什么都没发生
 *     —— 症状会是"任务里明明配了 MCP，模型却从来不调工具"，且后端侧一条日志都没有。
 *
 * ⚠️ 下面几个 env 名字是**跨边界契约**，与 `backend/src/sandbox/spec.ts` 的
 *    `SANDBOX_TOKEN_ENV` / `SANDBOX_PROXY_TIMEOUT_ENV` 及 `sandboxEgressEnv` 的
 *    `SANDBOX_BACKEND_URL` **逐字对应**；改一处就必须同步改另一处（容器是**预烘焙**的镜像，
 *    模板里对不上的症状同上：静默地一个工具都不注册）。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'

// ───────────────────────────── 跨边界常量 ─────────────────────────────

/** 后端沙箱代理的基地址（出口②；由 `spec.ts#sandboxEgressEnv` 写进容器 env） */
const BACKEND_URL_ENV = 'SANDBOX_BACKEND_URL'
/** per-container 代理令牌（由 `spec.ts#sandboxProxyEnv` 写进容器 env；值 = 会话身份） */
const TOKEN_ENV = 'SANDBOX_TOKEN'
/** 单次代理调用的超时（毫秒，由 `SANDBOX_PROXY_TIMEOUT_SEC` 换算后写进容器 env） */
const PROXY_TIMEOUT_ENV = 'SANDBOX_PROXY_TIMEOUT_MS'

/** 工具清单端点（`proxy.ts#registerSandboxProxyRoutes` 的 GET） */
const TOOLS_PATH = '/api/sandbox/mcp/tools'
/** 调用端点（同上，POST） */
const CALL_PATH = '/api/sandbox/mcp/call'
/** 令牌头名（**小写**；`spec.ts#SANDBOX_TOKEN_HEADER` 的另一半） */
const TOKEN_HEADER = 'x-sandbox-token'

/**
 * 代理超时的兜底值（毫秒）—— 与 `SANDBOX_PROXY_TIMEOUT_SEC` 的默认值 `180` 同值。
 *
 * ⚠️ 只在这个 env **读不出来**时用（正常路径上后端一定会给，见 `sandboxProxyEnv`）；真走到这里
 * 说明 env 装配漏了一项，所以**同时往 stderr 喊一声**。为什么这里可以给兜底而地址不给
 * （§四 3 的"服务间地址不做兜底"）：地址错了是**语义错误**（打到别人身上），而超时给一个
 * 同值默认只是"少一项配置"，不会让请求去错地方。
 */
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * 拉工具清单的超时（毫秒）—— **比代理超时短得多**，因为它是**启动期**的握手。
 *
 * 清单端点读的是 Redis + 一次 DB 查询（`proxy.ts#buildSandboxMcpCatalog`），**不含**任何
 * 用户确认等待；而 `session_start` 是**被 await 的**（pi 会等 handler 返回再继续）
 * ⇒ 拿 180s 的预算去等一次本该毫秒级完成的握手，会让"后端挂了"表现成"引擎起不来"。
 */
const TOOLS_FETCH_TIMEOUT_MS = 15_000

const LOG_PREFIX = '[mcp-bridge]'

// ───────────────────────────── 两端的线上形状 ─────────────────────────────

/** `GET /api/sandbox/mcp/tools` 的响应（后端侧 = `proxy.ts#SandboxMcpToolsResponse`） */
interface ToolListResponse {
  servers: { alias: string; id: string; name: string }[]
  tools: {
    /** 注册给引擎的名字（`mcp_<alias>_<tool>`）—— 也是 `pi.registerTool` 的 `name` */
    name: string
    /** 调 `/call` 时要原样带回去的别名 */
    serverAlias: string
    /** MCP 侧的**原始**工具名 —— 同样原样带回 */
    toolName: string
    description: string
    /** 原样的 JSON Schema（下面 {@link parametersFor} 直接转交） */
    inputSchema: unknown
  }[]
}

/** `POST /api/sandbox/mcp/call` 的 200 响应（后端侧 = `proxy.ts#SandboxMcpCallResponse`） */
interface CallResponse {
  isError: boolean
  text: string
}

/** `pi.registerTool` 的返回形状（`AgentToolResult`：模型看的 `content` + 渲染用的 `details`） */
interface ToolResult {
  content: { type: 'text'; text: string }[]
  details: undefined
}

// ───────────────────────────── 扩展本体 ─────────────────────────────

export default function mcpBridge(pi: ExtensionAPI): void {
  // ⚠️ 约束 ①：工厂里只读 env（不起 socket —— `fetch` 的调用点全在 session_start 里）
  const backendUrl = readEnv(BACKEND_URL_ENV)
  const token = readEnv(TOKEN_ENV)
  const timeoutMs = readProxyTimeoutMs()

  /**
   * 同一个 extension runtime 里只注册一次。
   *
   * `session_start` 的 `reason` 有五个值（`startup` / `reload` / `new` / `resume` / `fork`），
   * 后四个都可能在同一个 runtime 里再触发一次；而工具注册是 **runtime 级**的
   * （`/reload` 会换掉整个 runtime ⇒ 那时本来就会重新执行本工厂）。
   * ⚠️ 若上游把注册表改成"会话级"，这一条要跟着改 —— 现在的形态（容器 = 一次性会话）下不构成问题。
   */
  let registered = false

  pi.on('session_start', async () => {
    if (registered) return

    if (backendUrl === undefined || token === undefined) {
      const missing = backendUrl === undefined ? BACKEND_URL_ENV : TOKEN_ENV
      log('ERROR', `容器 env 里缺少 ${missing} ⇒ 本会话一个 MCP 工具都不注册`)
      log(
        'ERROR',
        '（这一定是后端 env 装配漏了一项：检查 sandbox/spec.ts 的 sandboxEgressEnv / sandboxProxyEnv）',
      )
      return
    }

    let list: ToolListResponse
    try {
      list = await fetchToolList(backendUrl, token)
    } catch (error) {
      log('ERROR', `拉取 MCP 工具清单失败 ⇒ 本会话一个 MCP 工具都不注册：${describeError(error)}`)
      return
    }

    for (const tool of list.tools) {
      pi.registerTool({
        name: tool.name,
        /**
         * `label` 只是**给人看**的名字（`ctx.mode === 'tui'` 才用得上）。RPC / JSON / print
         * 三个模式下都没有 UI ⇒ 这里给注册名就够了，不为了好看去拼 `server / tool` 之类的串。
         */
        label: tool.name,
        /** 说明由后端造（`proxy.ts` 复用 `mcp/toolSchema.ts#toDescription`，与 ChatBot 路径同一份） */
        description: tool.description,
        parameters: parametersFor(tool.inputSchema),
        /**
         * `execute(toolCallId, params, signal, onUpdate, ctx)` —— 本层只用得到 `params`。
         *
         * ⚠️ 四条刻意的"不用"：
         *   · **不用 `signal`**：这一趟请求与那条 SSE 流的 `AbortSignal` 没有结构上的联系
         *     （后端侧同样不传它，见 `proxy.ts#executeAndShape`），而"用户停止"在危险路径上
         *     由后端的确认流翻成一句"未执行"回给模型 ⇒ 在这里挂 `signal` 只会把**后端已经
         *     算出来的结论**换成一句网络错误。超时另算（`AbortSignal.timeout`）。
         *   · **不用 `onUpdate`**：卡片的三态是"一进一出"（`shared#toolCallRecordSchema`），
         *     没有"中间进度"这一态（`map.ts` 同样刻意不发 `tool_execution_update`）。
         *   · **不用 `ctx`**：这一层不需要 UI / 会话 / 模型运行时。
         *   · **不用 `executionMode: 'sequential'`**：本层不共享可变内存态；同一条助手消息里的
         *     多个 MCP 调用**允许并行**，而"危险调用不能并行问用户"这件事由**后端**按会话
         *     串行化（`proxy.ts#withConversationSerial`）—— 那是唯一知道谁危不危险的地方。
         */
        async execute(_toolCallId, params): Promise<ToolResult> {
          return callTool({
            backendUrl,
            token,
            timeoutMs,
            serverAlias: tool.serverAlias,
            toolName: tool.toolName,
            args: params as Record<string, unknown>,
          })
        },
      })
    }

    registered = true
    log('INFO', `已注册 ${list.tools.length} 个 MCP 工具（来自 ${list.servers.length} 台 server）`)
  })
}

// ───────────────────────────── 真调一次 ─────────────────────────────

/**
 * 一次 MCP 调用（走内网到后端）。
 *
 * ★ 两条出口泾渭分明（这一条直接决定"卡片显示成功还是失败"）：
 *   · **200 + `isError:false`** ⇒ 返回 `content`（模型读到工具结果）；
 *   · **200 + `isError:true`** ⇒ **抛**（约束 ③）；文本原样抛出，不加工 —— 后端那句本来就是
 *     写给模型/用户看的中文（"用户取消了这次工具调用，未执行。"）；
 *   · **非 200 / 连不上 / 超时 / 响应形状不对** ⇒ **抛**，并包一句"调用 MCP 工具失败：…"。
 */
async function callTool(input: {
  backendUrl: string
  token: string
  timeoutMs: number
  serverAlias: string
  toolName: string
  args: Record<string, unknown>
}): Promise<ToolResult> {
  let response: CallResponse
  try {
    response = await postCall(input)
  } catch (error) {
    // ⚠️ 传输层与协议层的失败（`proxy.ts` 文件头的分界线：令牌不认 / 体不合法 / 别名不存在 /
    //    不属于这个 agent / 清单没下发 ⇒ 4xx）在这里统一成"这次调用没干成"。
    //    文案里带上原因：模型要靠它向用户解释，比一句"请求失败"有用得多。
    throw new Error(`调用 MCP 工具失败：${describeError(error)}。本次调用未完成。`)
  }
  if (response.isError) throw new Error(response.text)
  return { content: [{ type: 'text', text: response.text }], details: undefined }
}

/** 拉工具清单（`session_start` 里唯一的一次 GET） */
async function fetchToolList(backendUrl: string, token: string): Promise<ToolListResponse> {
  const response = await fetch(endpoint(backendUrl, TOOLS_PATH), {
    method: 'GET',
    headers: { [TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(TOOLS_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(await describeFailure(response))
  const body = (await response.json()) as Partial<ToolListResponse>
  if (!Array.isArray(body.servers) || !Array.isArray(body.tools)) {
    throw new Error('工具清单的形状不对（缺 servers / tools 数组）')
  }
  return { servers: body.servers, tools: body.tools }
}

/** 真发那一次 POST（`{serverAlias, toolName, arguments}` —— **不带** conversationId/userId/agentId） */
async function postCall(input: {
  backendUrl: string
  token: string
  timeoutMs: number
  serverAlias: string
  toolName: string
  args: Record<string, unknown>
}): Promise<CallResponse> {
  const response = await fetch(endpoint(input.backendUrl, CALL_PATH), {
    method: 'POST',
    headers: { [TOKEN_HEADER]: input.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      serverAlias: input.serverAlias,
      toolName: input.toolName,
      arguments: input.args,
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  if (!response.ok) throw new Error(await describeFailure(response))
  const body = (await response.json()) as Partial<CallResponse>
  if (typeof body.isError !== 'boolean' || typeof body.text !== 'string') {
    throw new Error('代理响应的形状不对（缺 isError / text）')
  }
  return { isError: body.isError, text: body.text }
}

// ───────────────────────────── 内部小工具 ─────────────────────────────

/**
 * 拼 URL。
 *
 * ⚠️ **不用 `new URL(path, base)`**：那段代码对 `base` 里已有的路径前缀是有损的
 * （以 `/` 开头的 `path` 会把前缀整个丢掉）。这里是两个常量字符串的拼接，用字符串拼接
 * 反而把"前缀保不保留"变成一件看得见的事。
 */
function endpoint(base: string, path: string): string {
  return base.endsWith('/') ? `${base.slice(0, -1)}${path}` : `${base}${path}`
}

/**
 * 把 MCP 给的 `inputSchema` 转成 `registerTool` 要的 `parameters`。
 *
 * ★ 直接转交，**不做翻译**：MCP 的 `inputSchema` 就是一份 JSON Schema，而 TypeBox 1.x 的
 * 编译器**接受纯 JSON Schema 对象**（typebox README 的 Schema 一节原话："The compiler accepts
 * TypeBox types as well as plain JSON Schema objects"）—— pi 0.87.1 依赖的正是 typebox 1.3.27。
 * 手写一个"JSON Schema → TypeBox"的递归翻译器只会引入一处**与上游不同步**的语义损失
 * （`anyOf` / `enum` / 嵌套 `required` …），而症状是"某些工具的入参永远校验不过"。
 *
 * ⚠️ 两条降级口径：`inputSchema` 不是对象（后端缓存里没有、或人工改过 Redis）⇒ 退回
 * `Type.Object({})`（"这个工具没有参数"），**不抛** —— 抛了会让整份清单都注册不上，
 * 而代价只是那一个工具的参数对模型不具约束力（MCP 服务端照样会校验）。
 */
function parametersFor(inputSchema: unknown): TSchema {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as TSchema
  }
  return Type.Object({})
}

/**
 * 把一次失败的 HTTP 响应变成一句能读的话。
 *
 * 沙箱代理的两个端点**不套统一信封**，失败形态是 `{error:{code,message}}`（`proxy.ts#sendError`）；
 * 但真到不了那两个端点的路径（网关、框架默认 404、连接被掐）会给出**不是 JSON** 的响应
 * ⇒ 那时退回一句带状态码的通用文案，**不把 HTML 正文塞进日志**。
 */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } }
    const code = typeof body.error?.code === 'string' ? body.error.code : undefined
    const message = typeof body.error?.message === 'string' ? body.error.message : undefined
    if (message !== undefined) {
      const suffix = code === undefined ? '' : ` ${code}`
      return `MCP 代理拒绝了这次请求（HTTP ${response.status}${suffix}）：${message}`
    }
  } catch {
    // 不是 JSON ⇒ 落到下面那句
  }
  return `MCP 代理返回了 HTTP ${response.status}`
}

/** 异常 → 一句人话（超时单独说，因为 `DOMException` 的原文是英文且没有信息量） */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '等待代理响应超时'
    return error.message
  }
  return String(error)
}

/**
 * 读一个环境变量（**去掉空白后为空也算没给**）。
 *
 * ⚠️ 空串与缺失**同一个待遇**：`docker` 的 `-e FOO=` 与"没写这一项"在容器里都表现为
 * 一个空串/`undefined`，而把空串当成"配好了"会让请求打到 `http:///api/...` 这种地方去。
 */
function readEnv(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 代理超时（毫秒）；读不出来就 warn + 用 `DEFAULT_TIMEOUT_MS` */
function readProxyTimeoutMs(): number {
  const raw = readEnv(PROXY_TIMEOUT_ENV)
  if (raw === undefined) {
    log('WARN', `容器 env 里没有 ${PROXY_TIMEOUT_ENV} ⇒ 退回 ${DEFAULT_TIMEOUT_MS}ms（后端 env 装配漏了一项）`)
    return DEFAULT_TIMEOUT_MS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log('WARN', `${PROXY_TIMEOUT_ENV}=${raw} 不是正整数 ⇒ 退回 ${DEFAULT_TIMEOUT_MS}ms`)
    return DEFAULT_TIMEOUT_MS
  }
  return parsed
}

/**
 * 往 stderr 写一行（约束 ④：这是本层**唯一**的对外出口）。
 *
 * 后端把容器 stderr 收进日志（`bridge.ts` 的 stderr 尾巴，脱敏后只留尾巴若干行）
 * ⇒ 前缀里带上 `[mcp-bridge]` 与级别，好让"这些行是谁写的"一眼可辨。
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${level} ${message}\n`)
}
