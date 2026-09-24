/**
 * MCP 客户端底座（P0-2-1）
 *
 * 依据：`docs/06-实施计划.md` §四 P0-2-1（内容 / 验收门槛 1~5 / 坑预判 1~6）
 *      + §4.0 全局口径 1、2（只做 Streamable HTTP；客户端侧只走
 *        `initialize` / `tools/list` / `tools/call`，另作 `elicitation/create` 的**应答方**）
 *
 * 这一层是**官方 SDK 的壳**，职责只有四件：
 *   ① 连接与握手（并把**协商后的协议版本**记下来留痕）；
 *   ② `tools/list` → 本仓的 {@link McpToolDescriptor} 投影；
 *   ③ `tools/call` → 本仓的 {@link McpToolResult} 投影；
 *   ④ 优雅关闭（**先 `DELETE` 终止会话，再关传输**）。
 *
 * ⚠️ 它**不认识数据库、不认识用户**（`06` P0-2-1 原文）。凭据通过 `headers` 注入
 * （P0-2-7 负责解密与组装），本层只透传 + 在错误消息里脱敏。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 五条实测判据（SDK 1.30.1；逐条对应 `06` 的坑预判，详见 issue_fix/问题记录-P0-2-1-*.md）
 * ─────────────────────────────────────────────────────────────────────
 * 1. ⚠️ **请求的协议版本由 SDK 写死，不可配**。`client/index.js#connect()` 里是
 *    `params.protocolVersion = LATEST_PROTOCOL_VERSION`，而 1.30.1 的常量是
 *    **`2025-11-25`**（≠ `06` §4.0 写的设计目标 `2025-06-18`）。**没有** setter。
 *    ⇒ 本层的处置：**请求最新、接受降级、把协商结果留痕**。
 *      服务端回 `2025-06-18` 时 SDK 会 `transport.setProtocolVersion(它)`，
 *      此后每个请求都带 `mcp-protocol-version: 2025-06-18` —— 与设计目标一致。
 *      服务端回一个**不在 SDK 支持集内**的版本时 SDK 直接抛（裸 `Error`），
 *      由 `errors.ts` 翻成 502 并给出支持集。
 * 2. ⚠️ **`mcp-protocol-version` 只在 `_protocolVersion` 有值时才发**（`_commonHeaders()`）
 *    ⇒ 首包 `initialize` **不带**该头，这是**正确**行为（那时还没协商）。
 *      头名是**全小写** `mcp-protocol-version`（不是 `MCP-Protocol-Version`）。
 * 3. ⚠️ **我们的头合并顺序在最后**：`_commonHeaders()` 是
 *    `new Headers({...auth, ...sessionId, ...protocolVersion, ...extraHeaders})`
 *    ⇒ `requestInit.headers` **会覆盖** SDK 自己那三个头。
 *    因此**绝不能**把 `mcp-session-id` / `mcp-protocol-version` / `Authorization`
 *    放进调用方传的 `headers`（那会悄悄改掉会话与版本）。
 * 4. ⚠️ **`Client.close()` 不会终止会话**（它只 `transport.close()`）。
 *    不显式 `terminateSession()` 的后果是**服务端累积僵尸会话**，我们自己看不到任何症状
 *    ⇒ 关闭顺序固定为「先 DELETE、后 close」，见 {@link McpClient.close}。
 * 5. ⚠️ **`registerCapabilities()` 在 connect 之后调用会抛**
 *    （`Cannot register capabilities after connecting to transport`）
 *    ⇒ 能力声明只能在构造函数里做。且**只在真的有 elicitation 应答方时才声明**：
 *    声明了却答不出来，服务端会照发请求、我们静默失败（比不声明更难查）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js'

import { AppError } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger, SERVICE_VERSION } from '../infra/logger.js'
import { McpAbortError, describeMcpEndpoint, mcpSnippet, toMcpFailure, type McpEndpoint } from './errors.js'

/**
 * 本仓作为 MCP **客户端**向服务端自报的名字（进服务端日志，便于对方排查）。
 * 与 `SERVICE_NAME` 分开：那个是服务身份，这个是协议身份。
 */
export const MCP_CLIENT_NAME = 'doubulea-backend'

/**
 * 设计目标协议版本（`06` §4.0 全局口径 1）。
 *
 * ⚠️ 它**不用于发请求**（请求版本由 SDK 写死，见文件头判据 1），只用于**留痕**：
 * 服务端协商后的版本是否落回到我们的设计目标上。P0 的硬要求就是这一条 ——
 * 「落到 `2025-06-18` 时行为与设计一致」。
 */
export const MCP_DESIGN_TARGET_PROTOCOL_VERSION = '2025-06-18'

// ───────────────────────────── 对外投影（出口一律显式投影，不透 SDK 对象）─────────────────────────────

/**
 * 工具描述符 —— `tools/list` 的**投影**。
 *
 * ⚠️ 不透传 SDK 的 `Tool` 对象（`06` P0-2-1 坑预判 5：泄漏内部类型、字段不可控）。
 * 四个契约键（`name`/`title`/`description`/`inputSchema`/`annotations`）**恒存在**，
 * 缺失的一律 `null` —— 路由层序列化时键不会消失，前端不必写三处 `?.`。
 */
export interface McpToolDescriptor {
  name: string
  /** 服务端给的人读标题；缺失 → `null` */
  title: string | null
  /** 给模型看的说明；缺失 → `null`（`''` 原样保留，非缺失） */
  description: string | null
  /**
   * MCP 声明的 JSON Schema，**原样**。
   * ⚠️ 刻意不在这里做任何兼容处理（剥 `$schema` / 补 `type:'object'` / 非 object 根包一层）——
   * 那三件事属于 P0-2-6（`toolSchema.ts`），有它自己的验收门槛与理由。
   */
  inputSchema: unknown
  /** 危险判定的依据（P0-2-9 消费）；缺失 → `null` */
  annotations: Record<string, unknown> | null
  /**
   * 服务端是否声明了 `outputSchema`。
   *
   * 为什么单单把它拎出来留痕：SDK 对**声明了 `outputSchema` 却回不出 `structuredContent`**
   * 的工具会直接抛 `McpError(-32600)`（`client/index.js#callTool`），
   * 症状是"调用明明成功，我们这边却当成上游错误"。有这面旗子，排查时一眼能对上。
   */
  hasOutputSchema: boolean
}

/** 内容块：`text` 之外的类型**原样**留痕（P0 只渲染文本，但不要在读取端丢掉信息） */
export type McpContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

/**
 * `tools/call` 的结果 —— 三分法的**后两种在这里**：
 *
 * | 情形 | 表现 |
 * |------|------|
 * | **调用成功** | `await` 返回 {@link McpToolResult}，`isError === false` |
 * | **工具自身报错** | `await` 返回 {@link McpToolResult}，`isError === true`（**不抛**） |
 * | **传输失败** | **抛**（`AppError(UPSTREAM_ERROR / UPSTREAM_TIMEOUT)` / `McpAbortError`） |
 *
 * ⚠️ 后两者**必须分得开**（`06` P0-2-1 验收门槛 2）：前者是"工具说它没干成"
 * （属**业务结果**，要原样给模型看、让模型自己决定下一步），后者是"我们没调到它"
 * （属**平台故障**，要重试或报错）。混成一种的结果是模型对着一个超时反复重试。
 */
export interface McpToolResult {
  /** 服务端明确表示这次调用**失败**（`isError: true`）—— 传输是成功的 */
  isError: boolean
  /** 原始内容块（原样，给 P0-2-8 落库 / 前端展示） */
  content: McpContentBlock[]
  /** 文本块拼接（给模型与日志的**唯一**可读形态） */
  text: string
  /** 结构化输出（有 `outputSchema` 的工具必回）；无 → `null` */
  structuredContent: unknown
}

/** 服务端主动发起的确认请求（`elicitation/create`）—— 归一化后的形态 */
export interface McpElicitRequest {
  /** 归一化模式：`form`（表单）/ `url`（跳转）/ `unknown`（SDK 认得出、我们没接的模式） */
  mode: 'form' | 'url' | 'unknown'
  /** 给用户看的一句话 */
  message: string
  /** `form` 模式的表单 schema；其余模式 `null` */
  requestedSchema: unknown
  /** `url` 模式的跳转地址；其余模式 `null` */
  url: string | null
}

/** 应答。`content` 的取值域**照抄** MCP 的 `ElicitResultSchema`（多塞一个类型就会被 SDK 拒掉） */
export type McpElicitReply =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' }

// ───────────────────────────── 选项 ─────────────────────────────

export interface McpClientOptions {
  /** 展示名（`mcp_servers.name`），进日志与错误消息 */
  name: string
  /** 端点（`mcp_servers.endpoint_url`），Streamable HTTP 的单一 URL */
  url: string
  /**
   * 额外请求头 —— **凭据注入口**（P0-2-7）。
   * ⚠️ 不许放 `mcp-session-id` / `mcp-protocol-version` / `Authorization`（见文件头判据 3）。
   */
  headers?: Record<string, string>
  /**
   * 单次请求的上限（毫秒）。缺省 = `config.mcp.requestTimeoutMs`。
   * 交付验收要"注入小值"来验超时分支（`06` P0-2-1 验收门槛 3）。
   */
  timeoutMs?: number
  /**
   * 恢复一个既有会话（服务端在 `initialize` 响应里给过 `Mcp-Session-Id`）。
   * 传了它时 SDK 会**跳过 initialize**（`client/index.js#connect` 见到 sessionId 就 return）
   * ⇒ 这条路径的语义是"复用"，不是"重连"。
   */
  sessionId?: string
  /**
   * 恢复会话时要补的 `mcp-protocol-version`。
   *
   * 为什么需要它：**跳过握手就没人告诉你协商结果**（那个值只在 `initialize` 响应里），
   * 而 MCP 规范要求后续每个请求都带该头。不补的后果是"恢复出来的会话里，
   * 每个请求都不带头"——服务端只能按它自己的默认版本处理（规范建议假定 `2025-03-26`）。
   * ⇒ 恢复方要把上次协商到的版本一并带上（P0-2-5 缓存会话时就得一起存）。
   * 首次握手**不要**传（协商由 SDK 做，见文件头判据 1）。
   */
  protocolVersion?: string
  /**
   * 服务端主动 elicitation 的应答方。
   * **不传就不声明 `elicitation` 能力**（见文件头判据 5）。
   */
  onElicit?: (request: McpElicitRequest) => Promise<McpElicitReply>
  /** 该次调用注入的凭据明文 —— **只用于错误消息脱敏**，绝不进日志 */
  secrets?: readonly string[]
  /** 额外的日志字段（如 serverId）；不参与消息文案 */
  logFields?: Record<string, unknown>
}

/** 单次调用的覆写（超时 / 中断） */
export interface McpCallOptions {
  /** 用户的「停止」。⚠️ 中断**不会**断开底层 TCP（传输的 AbortController 是整客户端共用的） */
  signal?: AbortSignal
  timeoutMs?: number
}

// ───────────────────────────── 客户端 ─────────────────────────────

/** 从 SDK 拿到的原始工具对象：只按**形状**读，不 import 它的类型（免得被声明骗） */
interface RawTool {
  name: string
  title?: unknown
  description?: unknown
  inputSchema?: unknown
  annotations?: unknown
  outputSchema?: unknown
}

/** 判定"是个普通对象"（数组 / null / 标量都不算） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `RawTool` → {@link McpToolDescriptor}（缺失字段一律落 `null`，不做聪明处理） */
function toToolDescriptor(tool: RawTool): McpToolDescriptor {
  return {
    name: tool.name,
    title: typeof tool.title === 'string' ? tool.title : null,
    description: typeof tool.description === 'string' ? tool.description : null,
    inputSchema: tool.inputSchema,
    annotations: isPlainObject(tool.annotations) ? tool.annotations : null,
    hasOutputSchema: isPlainObject(tool.outputSchema),
  }
}

/** 内容块数组 → 本仓形态 + 文本拼接 */
function toContentBlocks(content: unknown): { blocks: McpContentBlock[]; text: string } {
  if (!Array.isArray(content)) return { blocks: [], text: '' }
  const blocks: McpContentBlock[] = []
  const texts: string[] = []
  for (const item of content) {
    if (isPlainObject(item) && typeof item.type === 'string') {
      const block = item as McpContentBlock
      blocks.push(block)
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      continue
    }
    // 形状不认识的块不丢（丢了的症状是"工具明明回了东西，界面却是空的"）
    blocks.push({ type: 'unknown', raw: item })
  }
  return { blocks, text: texts.join('\n') }
}

/**
 * 一个 MCP 会话（**用完必须 `close()`**，见 {@link close}）。
 *
 * 生命周期：`new McpClient(opts)` → `await connect()` → 若干次 `listTools` / `callTool` → `await close()`。
 * 不提供连接池：`06` P0-2-5 的接法是"每次测试/刷新各连一次"，`P0-2-8` 的工具调用也是短连接。
 * 需要长连接时在**调用点**做缓存，而不是在这里偷偷挂一个全局 Map（那会让会话归属不可见）。
 */
export class McpClient {
  private readonly options: McpClientOptions
  private readonly endpoint: McpEndpoint
  private readonly timeoutMs: number
  private readonly inner: Client
  private readonly transport: StreamableHTTPClientTransport
  /** `connect()` 成功后才为 true（见 {@link assertUsable}） */
  private connected = false
  /** `close()` 幂等（收尾路径可能被调两次：异常分支 + 调用方的 finally） */
  private closed = false

  constructor(options: McpClientOptions) {
    this.options = options
    this.endpoint = {
      serverName: options.name,
      endpointUrl: options.url,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.logFields === undefined ? {} : { logFields: options.logFields }),
    }
    this.timeoutMs = options.timeoutMs ?? config.mcp.requestTimeoutMs

    // 端点的合法性最终由 P0-2-2 的 schema 保证；这里兜一道是为了不让
    // `new URL()` 的 `TypeError: Invalid URL` 变成 500（那对排查毫无帮助）
    let url: URL
    try {
      url = new URL(options.url)
    } catch {
      throw AppError.upstreamError(
        `MCP server 的 endpoint_url 不是合法 URL：${options.name}（${options.url}）`,
      )
    }

    this.inner = new Client({ name: MCP_CLIENT_NAME, version: SERVICE_VERSION }, { capabilities: {} })

    // ⚠️ 必须**在 connect 之前**（判据 5），且**只在真有应答方时**才声明（判据 5 的后半）
    if (options.onElicit !== undefined) {
      this.inner.registerCapabilities({ elicitation: {} })
      this.inner.setRequestHandler(ElicitRequestSchema, async (request) => {
        // 走到这里说明服务端在等我们说话，把这行记下来 —— 它是"这次调用为什么停住了"的唯一线索
        getLogger().info(
          { ...describeMcpEndpoint(this.endpoint), method: 'elicitation/create' },
          'MCP 服务端发起了 elicitation 请求',
        )
        return options.onElicit?.(normalizeElicitRequest(request.params)) ?? { action: 'cancel' }
      })
    }

    this.transport = new StreamableHTTPClientTransport(url, {
      ...(options.headers === undefined ? {} : { requestInit: { headers: options.headers } }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    })
    // 恢复会话时补上版本头（首次握手由 SDK 在 initialize 成功后写入，这里不该抢）
    if (options.sessionId !== undefined && options.protocolVersion !== undefined) {
      this.transport.setProtocolVersion(options.protocolVersion)
    }
  }

  /** 供路由层拼消息 / 记日志的脱敏形态 */
  get endpointInfo(): Record<string, unknown> {
    return describeMcpEndpoint(this.endpoint)
  }

  /**
   * 服务端给的会话 id；没有会话时为 `null`。
   *
   * ⚠️ 这是**能力凭据**：拿到它 + 端点地址就能顶掉这个会话。
   * 所以它**不许**进任何响应体、也不许原样进日志（要记就记 `sessionId !== null`）。
   */
  get sessionId(): string | null {
    return this.transport.sessionId ?? null
  }

  /**
   * 实际会发给服务端的 `mcp-protocol-version` 值；没有则为 `null`（那时请求不带这个头）。
   *
   * 语义分两种情况：**首次握手后 = 协商结果**；**恢复会话时 = 调用方传入的版本**（没传就是 null）。
   * ⚠️ 只用于留痕 / 缓存，**不做分支逻辑**（`06` P0-2-1 坑预判 3：P0 只有一个目标版本）。
   */
  get protocolVersion(): string | null {
    return this.transport.protocolVersion ?? null
  }

  /** 服务端自报的 `serverInfo`；未连接时为 `null` */
  get serverInfo(): { name: string; version: string } | null {
    const info = this.inner.getServerVersion()
    if (info === undefined) return null
    return { name: info.name, version: info.version }
  }

  /**
   * 握手（`initialize` + `notifications/initialized`）。
   *
   * 成功后会留下**一条 info 级留痕**：我们请求的版本（SDK 写死的那个）、
   * 服务端协商出来的版本、以及**它是否落回设计目标**。
   * 这条日志是"协议版本这件事到底怎么样了"的唯一答案（验收门槛 1 的取证点之一）。
   */
  async connect(): Promise<void> {
    const stage = 'initialize（握手）'
    try {
      await this.inner.connect(this.transport, { timeout: this.timeoutMs })
    } catch (error) {
      // SDK 自己在 connect 失败时已经 `void this.close()`（不等），这里再关一次是幂等的
      await this.close().catch(() => undefined)
      toMcpFailure(error, { endpoint: this.endpoint, stage, aborted: false })
    }

    this.connected = true
    // 恢复会话（传了 sessionId）时 SDK 会跳过 initialize ⇒ 没有"协商结果"可言，
    // 这时 `protocolVersion` 就是调用方补进来的那个（没补则 null）。
    const resumed = this.options.sessionId !== undefined
    const version = this.protocolVersion

    getLogger().info(
      {
        ...describeMcpEndpoint(this.endpoint),
        resumed,
        requestedProtocolVersion: resumed ? null : LATEST_PROTOCOL_VERSION,
        negotiatedProtocolVersion: version,
        matchesDesignTarget: version === MCP_DESIGN_TARGET_PROTOCOL_VERSION,
        hasSession: this.transport.sessionId !== undefined,
        serverInfo: this.serverInfo,
      },
      resumed ? 'MCP 会话已恢复（未重新握手）' : 'MCP 握手完成',
    )
  }

  /** `tools/list` → 本仓投影。⚠️ P0 的列表请求**不带用户凭据**（`06` P0-2-5 坑 1） */
  async listTools(options: McpCallOptions = {}): Promise<McpToolDescriptor[]> {
    const stage = 'tools/list（拉工具列表）'
    this.assertUsable(stage)
    try {
      const result = await this.inner.listTools(undefined, this.requestOptions(options))
      return (result.tools as unknown as RawTool[]).map(toToolDescriptor)
    } catch (error) {
      toMcpFailure(error, { endpoint: this.endpoint, stage, aborted: options.signal?.aborted === true })
    }
  }

  /**
   * `tools/call`。
   *
   * ⚠️ 返回 `isError: true` **不是**抛错（见 {@link McpToolResult} 的表格）。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    const stage = `tools/call（调用工具 ${name}）`
    this.assertUsable(stage)
    try {
      const result = await this.inner.callTool({ name, arguments: args }, undefined, this.requestOptions(options))
      const { blocks, text } = toContentBlocks(result.content)
      return {
        isError: result.isError === true,
        content: blocks,
        text,
        structuredContent: result.structuredContent ?? null,
      }
    } catch (error) {
      toMcpFailure(error, { endpoint: this.endpoint, stage, aborted: options.signal?.aborted === true })
    }
  }

  /**
   * 优雅关闭：**先 `DELETE` 终止会话、再关传输**（文件头判据 4）。
   *
   * ⚠️ **不抛**。它出现在 `finally` / 进程收尾路径上，那里抛错只会把一个正常的收尾
   * 变成一个 500 或一条无用堆栈；失败一律 warn + 继续。
   * 幂等：重复调用是空操作。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.connected = false

    const hadSession = this.transport.sessionId !== undefined
    if (hadSession) {
      try {
        await this.transport.terminateSession()
      } catch (error) {
        getLogger().warn(
          {
            ...describeMcpEndpoint(this.endpoint),
            err: mcpSnippet(error instanceof Error ? error.message : String(error), this.options.secrets),
          },
          'MCP 会话终止请求失败（已忽略；服务端可能留下一个直到超时的会话）',
        )
      }
    }

    try {
      await this.inner.close()
    } catch (error) {
      getLogger().warn(
        {
          ...describeMcpEndpoint(this.endpoint),
          err: mcpSnippet(error instanceof Error ? error.message : String(error), this.options.secrets),
        },
        'MCP 传输关闭失败（已忽略）',
      )
    }
  }

  /** 单次调用的 SDK 选项。⚠️ 超时交给 SDK 自己的 `timeout`（别再加第二个 `AbortController`，`06` 坑 4） */
  private requestOptions(options: McpCallOptions): { signal?: AbortSignal; timeout: number } {
    return {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeout: options.timeoutMs ?? this.timeoutMs,
    }
  }

  /** 未连接 / 已关闭时调用是**编程错误**（不是用户输入问题）⇒ 500，且消息要指出漏了哪一步 */
  private assertUsable(stage: string): void {
    if (this.closed) throw AppError.internal(`MCP 客户端已关闭，无法执行 ${stage}`)
    if (!this.connected) throw AppError.internal(`MCP 客户端尚未 connect()，无法执行 ${stage}`)
  }
}

/** SDK 的 elicitation 参数（form / url 两分支的并集）→ 本仓归一化形态 */
function normalizeElicitRequest(params: ElicitRequestParams): McpElicitRequest {
  const raw = params as Record<string, unknown>
  const message = typeof raw.message === 'string' ? raw.message : ''
  const mode = raw.mode === 'url' ? 'url' : raw.mode === undefined || raw.mode === 'form' ? 'form' : 'unknown'
  return {
    mode,
    message,
    requestedSchema: mode === 'form' ? (raw.requestedSchema ?? null) : null,
    url: mode === 'url' && typeof raw.url === 'string' ? raw.url : null,
  }
}

/** 便捷构造（调用点少写一行 `new` + `connect`，也让"必须握手"这件事无法被忘掉） */
export async function connectMcpClient(options: McpClientOptions): Promise<McpClient> {
  const client = new McpClient(options)
  await client.connect()
  return client
}

export { McpAbortError }
