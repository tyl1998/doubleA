/**
 * mcp-bridge —— 沙箱内的 **MCP 桥扩展**（P0-3-9b 的实现；**P1-21 起支持运行期热更新**）
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
 * ═══════════════════════════════════════════════════════════════════════
 * ★ P1-21（2026-10-21）：**清单热更新** —— 同一容器里改绑定/刷新工具缓存后，不再等重建容器
 * ═══════════════════════════════════════════════════════════════════════
 * 原先 `session_start` 只拉一次、用一个 `registered` 布尔挡住后续会话，于是"容器活着期间
 * Agent 新绑了 MCP / 知识库、或上游 `tools/list` 变了"这件事在旧容器里**永远看不到**
 * （管理页点「测试」只刷后端的 `tool_cache`，不通知容器）。用户侧的体验是"必须重建会话"。
 *
 * 现在多了一条通道（选的是**与 `steer` 同族、但不必改容器外任何协议**的做法）：
 * ```
 * 后端 ──(pi RPC: prompt 一条以 "/doubulea:mcp-refresh" 开头的消息)──▶ 引擎
 * 引擎 pi 解析扩展命令 → 本扩展的 registered command handler 被调用
 *   → GET /api/sandbox/mcp/tools（后端已重算并发布新清单，见 proxy.ts#refreshSandboxMcpCatalog）
 *   → 与已注册的名字做 diff：新增的 registerTool、消失的从本扩展的工具表里 delete
 *   → pi.registerTool 内部会调 runtime.refreshTools() ⇒ **下一轮**发给模型的定义表就是新的
 * ```
 * 为什么走"扩展命令"而不是自己加一条 RPC 方法：pi 的 RPC 层只认它自己的命令集
 * （`rpc-mode.js` 的 `case "prompt" / "steer" / ...`），扩展无法新增；而**扩展命令**恰好是
 * 外挂能力（`pi.registerCommand`）。触发方式有两种，本扩展两种都接：
 *   ① **模型自己敲** `/doubulea:mcp-refresh`（用户在聊天里说"刷新一下 MCP 工具"时它会照做）；
 *   ② **后端推**：`POST /:id/chat` 那一轮的第 0 个 prompt 里带这一行（`taskAgent.ts` 在检测到
 *      清单版本变化时注入）—— pi 的 prompt 预处理会把它当斜杠命令执行。
 * ⚠️ **不靠 `events` 通道**：那要求容器外先知道"扩展订阅了什么"，而 RPC 层没有"执行扩展命令"
 *    的方法；prompt 是**已经存在**的那条路，改不动协议。
 * ⚠️ 工具名进的是历史消息（`content.tool_calls[].toolName`）⇒ **别名与名字都沿用后端已发布的
 *    那份清单**（后端只在"绑定/缓存变了"时**重算并重发**，且 `alias` 按 `(name,id)` 升序稳定分配）：
 *    新增的工具拿新名字，已有工具**名字不变**，于是旧历史里引用的名字仍然能解析。
 *
 * ★ 四件**刻意不在这一层**做（§七 5 / §七 6）：
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
 *     （P1-21 起它也**可以在会话运行期**再调一次：`registerTool` 的实现在
 *     `loader.js#registerTool` 里是 `extension.tools.set(name, …)` + `runtime.refreshTools()`，
 *     而后者接到 `agent-session.js#_refreshToolRegistry()` —— 整体重建 `_toolRegistry`，
 *     所以运行期增删是**上游支持的行为**，不是我们绕出来的野路子。）
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
 *   ⚠️ 热更新失败**不影响**已经注册的工具（沿用旧清单继续跑），只在 stderr 记一行 —— 与
 *      "清单从来没拉到过"不同：那时旧清单是**空**，没有可沿用的东西。
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
/**
 * **内置工具**调用端点（知识库检索 / 目录；后端侧 `proxy.ts#BUILTIN_CALL_PATH`）。
 *
 * 为什么与 `CALL_PATH` 分开：内置工具没有 MCP server / 凭据 / 危险确认，后端那条
 * "别名 → server → 越权检查"的链路描述不了它（见 `proxy.ts` 的端点注释）。
 */
const BUILTIN_CALL_PATH = '/api/sandbox/builtin/call'
/** 令牌头名（**小写**；`spec.ts#SANDBOX_TOKEN_HEADER` 的另一半） */
const TOKEN_HEADER = 'x-sandbox-token'

/**
 * 热更新命令名（P1-21）—— **跨边界契约**：后端 `backend/src/sandbox/spec.ts` 的
 * `SANDBOX_MCP_REFRESH_COMMAND` 必须与它逐字相同（那边用它拼注入给引擎的那一行 prompt）。
 */
const REFRESH_COMMAND_NAME = 'doubulea:mcp-refresh'

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
  /**
   * 平台内置工具（知识库一族）。容器侧据此注册 `knowledge_search` / `list_knowledge`，
   * 执行时走 {@link BUILTIN_CALL_PATH}（不是 `/mcp/call`）。没有绑定知识库时是空数组。
   */
  builtinTools: {
    /** 注册给引擎的名字（内置名，不带 `mcp_` 前缀） */
    name: string
    description: string
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
   * ⚠️ P1-21：**热更新不重置本标志** —— 它挡的是"重复的首次注册"，而热更新走 {@link syncTools}。
   */
  let registered = false

  /**
   * 本扩展**当前**已注册的工具名（MCP + 内置）。热更新按它做 diff：
   * 新清单里有、这里没有 ⇒ 注册；这里有、新清单里没有 ⇒ 删掉（工具消失不该继续给模型）。
   */
  const registeredNames = new Set<string>()

  /** 一次工具注册（MCP 与内置同一形状，只有 `execute` 的投递端点不同） */
  function registerEntry(entry: ToolListResponse['tools'][number]): void {
    pi.registerTool({
      name: entry.name,
      /**
       * `label` 只是**给人看**的名字（`ctx.mode === 'tui'` 才用得上）。RPC / JSON / print
       * 三个模式下都没有 UI ⇒ 这里给注册名就够了，不为了好看去拼 `server / tool` 之类的串。
       */
      label: entry.name,
      /** 说明由后端造（`proxy.ts` 复用 `mcp/toolSchema.ts#toDescription`，与 ChatBot 路径同一份） */
      description: entry.description,
      parameters: parametersFor(entry.inputSchema),
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
          serverAlias: entry.serverAlias,
          toolName: entry.toolName,
          args: params as Record<string, unknown>,
        })
      },
    })
  }

  /** 注册一个平台内置工具（知识库检索 / 目录 / 记忆 / 网关） */
  function registerBuiltin(entry: ToolListResponse['builtinTools'][number]): void {
    pi.registerTool({
      name: entry.name,
      label: entry.name,
      description: entry.description,
      parameters: parametersFor(entry.inputSchema),
      async execute(_toolCallId, params): Promise<ToolResult> {
        return callBuiltin({ backendUrl, token, timeoutMs, name: entry.name, args: params as Record<string, unknown> })
      },
    })
  }

  /**
   * 拉一次清单并按 diff 同步到 pi（P1-21）。`session_start` 与热更新命令**同一份实现**
   * （两处各写一遍的后果是"启动时注册的内置工具"与"热更新补的"判据不同，症状极难复现）。
   *
   * @returns `{ added, removed }` —— 供 stderr 留痕与调用方拼回显
   */
  async function syncTools(): Promise<{ added: string[]; removed: string[] }> {
    const list = await fetchToolList(backendUrl!, token!)

    const nextMcp = new Map(list.tools.map((tool) => [tool.name, tool]))
    const nextBuiltin = new Map(list.builtinTools.map((tool) => [tool.name, tool]))
    const nextNames = new Set([...nextMcp.keys(), ...nextBuiltin.keys()])

    const added = [...nextNames].filter((name) => !registeredNames.has(name))
    const removed = [...registeredNames].filter((name) => !nextNames.has(name))

    // ── ① 先删掉新清单里没有的（工具下线 / 解绑 server / 解绑知识库）。
    //    ⚠️ 直接改 `extension.tools` 之后**不会有** refresh（只有 `registerTool` 里调了它）⇒ ② 补上。
    if (removed.length > 0) {
      const table = toolTableOf(pi)
      for (const name of removed) table.delete(name)
    }

    // ── ② 把**留下的 + 新增的**全部注册一遍：`extension.tools` 是 Map ⇒ 同名 = 覆盖定义
    //    （上游 `tools/list` 变了、参数 schema 变了，走这条就同步过来了），
    //    而且每调一次 `registerTool` 都会触发 `runtime.refreshTools()` ⇒ `_toolRegistry` 整体重建
    //    —— **删掉的那些也因此在这一刻真正从模型眼前消失**（顺序因此必须是"先删后注册"）。
    for (const entry of nextMcp.values()) registerEntry(entry)
    for (const entry of nextBuiltin.values()) registerBuiltin(entry)

    registeredNames.clear()
    for (const name of nextNames) registeredNames.add(name)
    return { added, removed }
  }

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

    try {
      await syncTools()
    } catch (error) {
      log('ERROR', `拉取 MCP 工具清单失败 ⇒ 本会话一个 MCP 工具都不注册：${describeError(error)}`)
      return
    }

    registered = true
    log(
      'INFO',
      `已注册 ${registeredNames.size} 个工具（MCP ${registeredNames.size}；清单版本 = 启动时那一份）`,
    )
  })

  /**
   * 热更新命令（P1-21）：`/doubulea:mcp-refresh`。
   *
   * 三条口径：
   *   · 命令名带 `doubulea:` 前缀 —— 与用户自己的 prompt 模板（`/xx`）**不会撞名**；
   *   · 参数可有可无（后端注入时不带参数）；
   *   · 失败**不抛**（命令失败会把整条 prompt 变成错误，代价远大于收益）⇒ 只往 stderr 记一行，
   *     已注册的工具**照旧可用**（它们指向后端的 `/mcp/call`，那条链路与清单无关）。
   *     `ctx.ui` 一律不用（约束 ④）。
   */
  pi.registerCommand(REFRESH_COMMAND_NAME, {
    description: '刷新本容器的 MCP / 知识库工具清单（平台在绑定或工具缓存变化后会调用）',
    handler: async () => {
      if (backendUrl === undefined || token === undefined) {
        log('ERROR', `热更新跳过：容器 env 缺少 ${backendUrl === undefined ? BACKEND_URL_ENV : TOKEN_ENV}`)
        return
      }
      try {
        const { added, removed } = await syncTools()
        registered = true
        log(
          'INFO',
          `工具清单已热更新（新增 ${added.length}、移除 ${removed.length}）` +
            (added.length === 0 && removed.length === 0 ? '：与当前注册的完全一致' : ''),
        )
      } catch (error) {
        log('WARN', `工具清单热更新失败（沿用已注册的旧清单）：${describeError(error)}`)
      }
    },
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
    throw new Error(`调用 MCP 工具失败：${describeError(error)}。本次调用未完成。`, { cause: error })
  }
  if (response.isError) throw new Error(response.text)
  return { content: [{ type: 'text', text: response.text }], details: undefined }
}

/**
 * 一次**内置工具**调用（知识库检索 / 目录）。
 *
 * 出口与 {@link callTool} **逐字同款**（成功返回 content / `isError:true` 抛 / 传输层失败抛）：
 * 卡片三态与模型读到的失败结果都由后端那句文本决定，容器侧不做任何加工。
 */
async function callBuiltin(input: {
  backendUrl: string
  token: string
  timeoutMs: number
  name: string
  args: Record<string, unknown>
}): Promise<ToolResult> {
  let response: CallResponse
  try {
    response = await postBuiltin(input)
  } catch (error) {
    throw new Error(`调用内置工具失败：${describeError(error)}。本次调用未完成。`, { cause: error })
  }
  if (response.isError) throw new Error(response.text)
  return { content: [{ type: 'text', text: response.text }], details: undefined }
}

/** 拉工具清单（`session_start` 与热更新共用） */
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
  // 内置工具字段是后加的：老后端（未升级）不给它 ⇒ 按空数组（"没有内置工具"），不当作形状错误
  const builtinTools = Array.isArray(body.builtinTools) ? body.builtinTools : []
  return { servers: body.servers, tools: body.tools, builtinTools }
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

/** 真发那一次内置工具的 POST（体：`{name, arguments}`；同样**不带**身份字段） */
async function postBuiltin(input: {
  backendUrl: string
  token: string
  timeoutMs: number
  name: string
  args: Record<string, unknown>
}): Promise<CallResponse> {
  const response = await fetch(endpoint(input.backendUrl, BUILTIN_CALL_PATH), {
    method: 'POST',
    headers: { [TOKEN_HEADER]: input.token, 'content-type': 'application/json' },
    body: JSON.stringify({ name: input.name, arguments: input.args }),
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
 * 取**本扩展**的工具表（`extension.tools`）。
 *
 * ⚠️ 上游没有公开 `unregisterTool`，但 `registerTool` 的落点是一张按扩展组织的 `Map`
 * （`loader.js#registerTool` → `extension.tools.set(name, …)`，`getAllRegisteredTools()`
 * 逐扩展遍历它）⇒ 从它上面 `delete` 就是"注销"，只是**不会**自动触发 `runtime.refreshTools()`。
 *
 * 取表的两条路径（按上游实现的可能性从宽到窄，取到即用）：
 *   ① 扩展 API 上没有这个字段 ⇒ 走 `pi` 的**内部持有者**（`createExtensionAPI` 的闭包变量）；
 *   ② 找不到（上游改了内部结构）⇒ 返回一张**一次性空表**，`delete` 变成空操作 ——
 *      症状是"删掉的工具还留在模型眼前"，而不是抛错把整条刷新命令打挂。
 */
function toolTableOf(pi: ExtensionAPI): { delete: (name: string) => boolean } {
  const holder = pi as unknown as {
    tools?: Map<string, unknown>
    extension?: { tools?: Map<string, unknown> }
  }
  const table = holder.tools ?? holder.extension?.tools
  if (table !== undefined) return table
  log('WARN', '取不到本扩展的工具表 ⇒ 已下线的工具不会被摘除（上游内部结构变了）')
  return { delete: () => false }
}

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
