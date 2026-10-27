/**
 * MCP 传输层的错误翻译（P0-2-1）
 *
 * 依据：`docs/归档/06-P0-2-实施步骤.md` P0-2-1（验收门槛 3 / 4）+ §4.0 全局口径 1
 *      + `docs/02-后端设计.md` §4.7（MCP 接入）/ §四（统一错误码）
 *
 * 职责与 `llm/upstream.ts` **同一层**：把 SDK 抛出来的各种东西翻译成
 * **本仓的错误码 + 可读中文 + 脱敏后的响应片段**。不认识数据库、不认识用户。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不全盘复用 `llm/upstream.ts#toUpstreamFailure`
 * ─────────────────────────────────────────────────────────────────────
 * 那个函数的消息主语是「Provider / 模型」，阶段名也是 LLM 专属的；而 MCP 这一侧：
 *   · 主语是「MCP server 名 / endpoint」；
 *   · **多两类故障**：协议版本不被支持、**非 MCP 端点（回 HTML）**；
 *   · JSON-RPC 层错误码（-32601 等）也带自己的修复提示。
 * 硬改名复用会把两边的文案搅在一起，而**文案正是排查时唯一看得见的东西**。
 * ⇒ 只复用真正与协议无关的文本工具（`redactSecret` / `UPSTREAM_BODY_SNIPPET`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条**实测**得来的判据（v2 `@modelcontextprotocol/client`；1.x 判据已按 v2 重写）
 * ─────────────────────────────────────────────────────────────────────
 * 1. ⚠️ **`AbortSignal` 中断仍会被包成超时类错误**（v2：`SdkError(code:'REQUEST_TIMEOUT')`）
 *    ⇒ **不能靠错误码区分「用户停止」与「真超时」**。调用点必须把 `signal.aborted`
 *    显式传进来（{@link McpFailureContext.aborted}），本函数**先看 aborted、再看错误码** ——
 *    顺序即正确性。
 * 2. ⚠️ **v2 把错误分成两族**（core 的 `SdkError` / `ProtocolError`）：
 *    · **本地 SDK 错误** `SdkError`：`code` 是**字符串**（`SdkErrorCode`，如 `REQUEST_TIMEOUT`），
 *      HTTP 非 2xx 用子类 `SdkHttpError`（带 `status: number` / `data.status`）；
 *    · **JSON-RPC 协议错误** `ProtocolError`：`code` 是**数字**（-32601 等，跨线的错误帧）。
 *    本模块**按形状认**（不 import SDK 运行时枚举，理由见下方版本集注释）：
 *    数字 `code` ⇒ 协议层；字符串 `code` + `status` 数字 ⇒ HTTP 层；`code:'REQUEST_TIMEOUT'` ⇒ 超时。
 * 3. `fetch` 连不通时抛的仍是 `TypeError: fetch failed`，**真正的原因在 `.cause` 链上**
 *    （`ENOTFOUND` / `ECONNREFUSED` …）⇒ 不走 {@link describeCauseChain} 就只有一个
 *    毫无信息量的 "fetch failed"。三种连不通都要给出可读原因靠它。
 */

import { appMsg, AppError, isAppError } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { UPSTREAM_BODY_SNIPPET, redactSecret } from '../llm/upstream.js'

/**
 * 一个 MCP 上游端点。
 *
 * ⚠️ `secrets` 是**明文**（P0-2-7 解密后的用户凭据值），只允许在进程内存里存在：
 *   · 不要把它塞进任何响应体 / 日志 / 错误消息；
 *   · 要记日志时用 {@link describeMcpEndpoint}（只打「有没有」）。
 * 它出现的**唯一正当理由**是把上游回显里的凭据抹掉（{@link mcpSnippet}）——
 * 上游 401 的响应体经常把收到的 `Authorization` 原样回显，不抹就等于借错误消息泄密。
 */
export interface McpEndpoint {
  /** 展示名（`mcp_servers.name`），进日志与错误消息 */
  serverName: string
  /** 展示用端点（`mcp_servers.endpoint_url`） */
  endpointUrl: string
  /** 该次调用注入的凭据明文；无凭据时省略或空数组 */
  secrets?: readonly string[]
  /** 额外的日志字段（如 serverId）；**不参与**消息文案 */
  logFields?: Record<string, unknown>
}

/**
 * `tools/list` 这一阶段的**标识串**（唯一落点）。
 *
 * ⚠️ 为什么要把它提成常量而不是继续内联：{@link describeHttpFailure} 要**按阶段分支** ——
 * 401/403 出现在「拉工具列表」时的处置与「调用工具」时**完全不同**（见那里的注释）。
 * 两处各写一份字符串的后果是：谁改了其中一份，那条分支就**静默失效**，退回一句
 * 会把人引向死路的文案（"请检查该 server 的凭据" —— 而列表请求从来不带凭据）。
 *
 * 常量落在本模块（而不是 `client.ts`）是为了**避开循环 import**：`client.ts` 已经 import 本模块。
 */
export const MCP_STAGE_LIST_TOOLS = 'tools/list（拉工具列表）'

/** 只打「有没有凭据」的日志形态 —— **唯一**允许用来记录 {@link McpEndpoint} 的方式 */
export function describeMcpEndpoint(endpoint: McpEndpoint): Record<string, unknown> {
  return {
    serverName: endpoint.serverName,
    endpointUrl: endpoint.endpointUrl,
    hasCredential: (endpoint.secrets?.length ?? 0) > 0,
    ...(endpoint.logFields ?? {}),
  }
}

/** 把多条凭据从文本里抹掉（顺序遍历；`redactSecret` 自己会跳过过短的串） */
export function redactAll(text: string, secrets: readonly string[] | undefined): string {
  if (secrets === undefined || secrets.length === 0) return text
  return secrets.reduce((accumulated, secret) => redactSecret(accumulated, secret), text)
}

/**
 * 上游响应片段：**先脱敏、再截断**（进日志 / 进错误消息的片段一律走它）。
 * 与 `llm/upstream.ts#snippet` 同口径，只是支持多条凭据。
 */
export function mcpSnippet(text: string, secrets?: readonly string[]): string {
  const redacted = redactAll(text, secrets)
  return redacted.length > UPSTREAM_BODY_SNIPPET
    ? `${redacted.slice(0, UPSTREAM_BODY_SNIPPET)}…（已截断）`
    : redacted
}

/**
 * 调用方主动中断（用户的「停止」）。
 *
 * 独立一个类而不是复用 `LlmAbortError`：语义同样是「**不是故障**」，但消费方不同
 * （P0-2-8 的编排循环要靠它把 `tool_call` 收成 `CANCELLED` 而不是 `ERROR`），
 * 且跨包名读起来不该带 LLM 的帽子。
 */
export class McpAbortError extends Error {
  constructor(message = 'MCP 调用已被中断') {
    super(message)
    this.name = 'McpAbortError'
  }
}

/** 判定 v2 的 JSON-RPC 协议层错误（`ProtocolError`：`code` 是**数字**，跨线的错误帧） */
function isProtocolError(error: unknown): error is { code: number; message: string; data?: unknown } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'number'
  )
}

/**
 * 判定 v2 的 HTTP 传输层错误（`SdkHttpError`）。
 *
 * ⚠️ v2 的 `SdkError.code` 是**字符串**（`SdkErrorCode`），HTTP 子类额外带
 * `status: number`（并镜像在 `data.status`）。判据写在这里一处，别在别处再猜一次。
 */
function isSdkHttpError(error: unknown): error is { status: number; message: string } {
  if (typeof error !== 'object' || error === null) return false
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') return true
  const dataStatus = (error as { data?: { status?: unknown } }).data?.status
  return typeof dataStatus === 'number'
}

/** 取 HTTP 状态码（优先 `status` getter，回落 `data.status`） */
function httpStatusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') return status
  const dataStatus = (error as { data?: { status?: unknown } }).data?.status
  return typeof dataStatus === 'number' ? dataStatus : -1
}

/** v2 本地超时错误码（`SdkErrorCode.RequestTimeout` 的字面量） */
const MCP_SDK_CODE_REQUEST_TIMEOUT = 'REQUEST_TIMEOUT'
/** v2「服务端回了不认识的内容类型」错误码（多半根本不是 MCP 端点，回了 HTML） */
const MCP_SDK_CODE_UNEXPECTED_CONTENT = 'CLIENT_HTTP_UNEXPECTED_CONTENT'

/** 是不是 v2 的本地 SDK 错误（`SdkError`：`code` 是字符串） */
function sdkErrorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** JSON-RPC 错误码 → 中文修复提示（缺省时不加提示，只报原码与原消息） */
const MCP_ERROR_HINTS: Readonly<Record<string, string>> = {
  '-32700': '请求体不是合法 JSON（本仓发出的报文坏了，属平台侧问题；请上报）',
  '-32600': 'MCP 服务端认为请求非法',
  '-32601': 'MCP 服务端不认识这个方法（大概率不是 MCP 端点，或协议版本差得太远）',
  '-32602': 'MCP 服务端认为参数非法（工具名或参数不符合它声明的 inputSchema）',
  '-32603': 'MCP 服务端内部错误',
  '-32000': '连接已关闭（服务端主动断开，或会话已失效）',
  '-32001': '请求超时',
  '-32022': '协议版本不被服务端支持（现代协议协商阶段；请确认双方协议版本有交集）',
}

/**
 * 判定 SDK 的 zod 校验失败（`client/index.js` 里 `safeParse` 失败会把 `ZodError` 直接 reject）。
 * 按形状认（`issues` 是数组且元素带 `path`/`message`），不 import zod 的类型。
 */
function isSchemaError(error: unknown): error is { issues: unknown[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { issues?: unknown }).issues) &&
    (error as { issues: unknown[] }).issues.length > 0
  )
}

/** 把 zod issues 压成一行可读文本（最多 3 条 —— 再多也没人看，且会把消息撑爆） */
function summarizeSchemaIssues(error: { issues: unknown[] }): string {
  const parts: string[] = []
  for (const issue of error.issues.slice(0, 3)) {
    if (typeof issue !== 'object' || issue === null) continue
    const path = (issue as { path?: unknown }).path
    const message = (issue as { message?: unknown }).message
    const where = Array.isArray(path) && path.length > 0 ? path.join('.') : '(根)'
    parts.push(`${where}：${typeof message === 'string' ? message : '校验失败'}`)
  }
  const more = error.issues.length > 3 ? `（另有 ${error.issues.length - 3} 条）` : ''
  return `${parts.join('；')}${more}`
}

/** 网络层错误码 → 中文原因（Node/undici 的 `code`；键名取自实测） */
const NETWORK_CODES: Readonly<Record<string, string>> = {
  ENOTFOUND: 'DNS 解析失败（域名不存在，或本机 DNS 不可用）',
  EAI_AGAIN: 'DNS 临时失败（解析超时）',
  ECONNREFUSED: '连接被拒绝（目标端口没有服务在监听）',
  ECONNRESET: '连接被对端重置',
  EPIPE: '连接中断（对端提前关闭）',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  UND_ERR_CONNECT_TIMEOUT: '连接超时（undici）',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时（undici）',
  UND_ERR_BODY_TIMEOUT: '读取响应体超时（undici）',
  UND_ERR_SOCKET: '套接字错误（对端关闭或网络中断）',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签 TLS 证书不被信任',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链校验失败',
}

/** `.cause` 链的最大回溯层数（undici 一般 1~2 层，留余量即可，防异常对象成环） */
const MAX_CAUSE_DEPTH = 5

export interface CauseChain {
  /** 链上第一个**认识**的错误码（进 `NETWORK_CODES` 的那种），没有则 null */
  code: string | null
  /** 该码对应的中文原因；不认识则为 null */
  reason: string | null
  /** 链上各层的 `CODE: message`（从外到内），进日志用 */
  chain: string[]
}

/**
 * 沿着 `.cause` 链把真正的失败原因挖出来。
 *
 * ⚠️ 不做这件事的后果在验收门槛 4 里写着：DNS 失败 / 连接被拒 / 非 MCP 端点三种
 * 都要给出**可读原因**，而 `fetch` 在这三种情况下抛的都是同一句 `fetch failed`。
 */
export function describeCauseChain(error: unknown): CauseChain {
  const chain: string[] = []
  let cursor: unknown = error
  let code: string | null = null
  let reason: string | null = null

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor !== null && cursor !== undefined; depth += 1) {
    if (typeof cursor !== 'object') {
      chain.push(String(cursor))
      break
    }
    const node = cursor as { code?: unknown; message?: unknown; cause?: unknown }
    const nodeCode = typeof node.code === 'string' ? node.code : null
    const nodeMessage = typeof node.message === 'string' ? node.message : String(cursor)
    chain.push(nodeCode === null ? nodeMessage : `${nodeCode}: ${nodeMessage}`)
    if (code === null && nodeCode !== null && NETWORK_CODES[nodeCode] !== undefined) {
      code = nodeCode
      reason = NETWORK_CODES[nodeCode]
    }
    cursor = node.cause
  }

  return { code, reason, chain }
}

export interface McpFailureContext {
  endpoint: McpEndpoint
  /** 出错阶段（`initialize（握手）` / `tools/list（拉工具列表）` / `tools/call（调用工具）`） */
  stage: string
  /**
   * 调用方的 `AbortSignal` 是否已 abort。
   * ⚠️ **必须先判它**，否则「用户点了停止」会被 SDK 的包装骗成「超时」（见文件头判据 1）。
   */
  aborted: boolean
}

/**
 * 从上游 JSON-RPC 错误的 `error.data` 里取出给人/模型看的提示（`hint`）。
 *
 * ⚠️ 只认 `hint` 一个键（MCP 协议本身没有约定 `data` 的形状，别的键是各家自己的实现细节；
 * 原样拼进错误消息等于让上游的任意字符串直接进模型上下文）。取不到 ⇒ 空串。
 * 长度设上限：这一段会进工具卡的 `output`，也会回填进模型上下文，不设限等于让上游决定我们的
 * 上下文预算。
 */
const MCP_UPSTREAM_HINT_MAX = 512

function readUpstreamHint(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return ''
  const hint = (data as { hint?: unknown }).hint
  if (typeof hint !== 'string') return ''
  const trimmed = hint.trim()
  if (trimmed === '') return ''
  const points = [...trimmed]
  return points.length <= MCP_UPSTREAM_HINT_MAX ? trimmed : `${points.slice(0, MCP_UPSTREAM_HINT_MAX).join('')}…`
}

/**
 * 统一的 MCP 失败出口。
 *
 * @throws {AppError} `UPSTREAM_TIMEOUT`(504) 超时；`UPSTREAM_ERROR`(502) 其余全部
 * @throws {McpAbortError} 调用方中断（**不是**故障，由上层区分）
 */
export function toMcpFailure(error: unknown, context: McpFailureContext): never {
  const { endpoint, stage } = context
  const secrets = endpoint.secrets

  // ① 已经是我们自己的领域错误：原样放行（那些消息是精心写的，再包一层只会丢信息）
  if (isAppError(error)) throw error

  // ② 调用方中断 —— 必须排在错误码判定**之前**
  if (context.aborted) {
    throw new McpAbortError(`MCP 调用已被调用方中断（${stage}）：${endpoint.serverName}`)
  }

  const rawMessage = error instanceof Error ? error.message : String(error)
  const detail = mcpSnippet(rawMessage, secrets)

  // ③ v2 本地超时（`SdkError(code:'REQUEST_TIMEOUT')`；真超时与被中断都可能走这里，
  //    但②已先把「用户中断」摘走了 ⇒ 到这里的是真超时）
  const sdkCode = sdkErrorCodeOf(error)
  if (sdkCode === MCP_SDK_CODE_REQUEST_TIMEOUT) {
    getLogger().warn({ ...describeMcpEndpoint(endpoint), stage }, 'MCP 调用超时')
    throw AppError.upstreamTimeout(appMsg('app.m248', { p0: stage, p1: endpoint.serverName, p2: endpoint.endpointUrl, p3: detail }),
    )
  }

  // ③' v2「服务端回了本 SDK 不认识的内容类型」（多半根本不是 MCP 端点，回了 HTML）
  //    —— 复用 describeHttpFailure 的 -1 分支文案
  if (sdkCode === MCP_SDK_CODE_UNEXPECTED_CONTENT) {
    getLogger().warn({ ...describeMcpEndpoint(endpoint), stage }, 'MCP 端点返回了不认识的内容类型')
    throw AppError.upstreamError(describeHttpFailure(-1, rawMessage, endpoint, stage))
  }

  // ④ v2 HTTP 传输层错误（`SdkHttpError`，带 HTTP `status`）
  if (isSdkHttpError(error)) {
    const status = httpStatusOf(error)
    getLogger().warn({ ...describeMcpEndpoint(endpoint), stage, upstreamStatus: status }, 'MCP 上游返回非 2xx')
    throw AppError.upstreamError(`${describeHttpFailure(status, rawMessage, endpoint, stage)}`, {
      upstreamStatus: status,
    })
  }

  // ⑤ v2 JSON-RPC 协议层错误（`ProtocolError`：`code` 是数字，服务端**答了**但答的是错误帧）
  if (isProtocolError(error)) {
    const hint = MCP_ERROR_HINTS[String(error.code)] ?? ''
    // 上游自己给的 `error.data.hint` —— **必须带给模型**
    // ⚠️ 有的服务端刻意把多种拒绝理由压成同一个错误码（例如把"缺参数 / scope 不够"都回成
    //    `-32601 Method not found`，只靠 `data.hint` 说明下一步）。丢掉它 ⇒ 模型看到裸的
    //    "Method not found" 读不出该怎么改，只会反复重试同一个坏调用（2026-10-22 实测 4 连败）。
    const upstreamHint = readUpstreamHint(error.data)
    getLogger().warn(
      { ...describeMcpEndpoint(endpoint), stage, rpcCode: error.code, hasUpstreamHint: upstreamHint !== '' },
      'MCP 服务端返回 JSON-RPC 错误',
    )
    // -32022 = 协议版本不被支持（现代协议 negotiation 阶段的错误帧）
    throw AppError.upstreamError(
      appMsg('app.m278', {
        p0: error.code,
        p1: stage,
        p2: endpoint.serverName,
        p3: hint === '' ? '' : `。${hint}`,
        p4: upstreamHint === '' ? '' : `。服务端提示：${upstreamHint}`,
      }),
      { mcpRpcCode: error.code, ...(upstreamHint === '' ? {} : { mcpUpstreamHint: upstreamHint }) },
    )
  }

  // ⑤* 协议版本不被支持 / 协商失败（v2 有时抛裸 Error 或 SdkError，按消息兜底认）
  if (
    rawMessage.includes('protocol version is not supported') ||
    rawMessage.includes('Version negotiation failed') ||
    sdkCode === 'ERA_NEGOTIATION_FAILED' ||
    sdkCode === 'UNSUPPORTED_PROTOCOL_VERSION'
  ) {
    getLogger().warn({ ...describeMcpEndpoint(endpoint), stage }, 'MCP 协议版本协商失败')
    throw AppError.upstreamError(appMsg('app.m249', { p0: stage, p1: endpoint.serverName, p2: SUPPORTED_PROTOCOL_VERSIONS.join(' / '), p3: detail }),
    )
  }

  // ⑤' 帧不是合法 JSON：`200 + 空体`（网关吞了 body）或"头写 application/json、内容其实是 HTML"
  if (error instanceof SyntaxError) {
    getLogger().warn({ ...describeMcpEndpoint(endpoint), stage }, 'MCP 端点返回的帧不是合法 JSON')
    throw AppError.upstreamError(appMsg('app.m250', { p0: stage, p1: endpoint.serverName, p2: endpoint.endpointUrl, p3: detail }),
    )
  }

  // ⑤'' 帧是 JSON，但不符合 MCP 的 schema（SDK 用 zod 校验后直接 reject）
  if (isSchemaError(error)) {
    getLogger().warn(
      { ...describeMcpEndpoint(endpoint), stage, issues: summarizeSchemaIssues(error) },
      'MCP 端点返回的帧不符合协议 schema',
    )
    throw AppError.upstreamError(appMsg('app.m251', { p0: stage, p1: endpoint.serverName, p2: summarizeSchemaIssues(error) }),
    )
  }

  // ⑥ 网络层：走 `.cause` 链才有可读原因
  const cause = describeCauseChain(error)
  getLogger().warn(
    { ...describeMcpEndpoint(endpoint), stage, causeCode: cause.code, causeChain: cause.chain },
    '连接 MCP server 失败',
  )
  if (cause.reason !== null) {
    throw AppError.upstreamError(
      appMsg('app.m252', {
        p0: stage,
        p1: endpoint.serverName,
        p2: endpoint.endpointUrl,
        p3: cause.reason ?? '',
        p4: cause.code ?? '',
      }),
    )
  }

  // ⑦ 兜底：把 `.cause` 链摊开，至少让下一次排查有东西可看
  const chainText = cause.chain.length > 1 ? `；原因链：${cause.chain.join(' ← ')}` : ''
  throw AppError.upstreamError(appMsg('app.m253', { p0: stage, p1: endpoint.serverName, p2: endpoint.endpointUrl, p3: detail, p4: chainText }),
  )
}

/**
 * HTTP 层失败的文案。
 *
 * 五个分支各自对应一种**真实会碰到**的部署错，写清「去哪儿看一眼」：
 * 401/403 在**拉列表**阶段 = 端点要求 `tools/list` 也鉴权，而本阶段不带凭据（`06` P0-2-5 坑 1）
 *   ⇒ 文案要指向**已知边界**，不能叫人去配凭据（配了也不会被带上）；
 * 401/403 在**握手 / 调用工具**阶段 = 凭据没带对或已失效；
 * 404 = `endpoint_url` 少了路径段；405 = 端点不接受我们用的方法；
 * -1 = SDK 明说的「不认识的 content-type」⇒ **多半根本不是 MCP 端点**（最典型是回了一个 HTML 页面）。
 */
function describeHttpFailure(code: number, message: string, endpoint: McpEndpoint, stage: string): string {
  const who = `${endpoint.serverName}（${endpoint.endpointUrl}）`
  const body = mcpSnippet(message, endpoint.secrets)
  if (code === -1) {
    return (
      `MCP 端点返回了本 SDK 不认识的内容类型（${stage}）：${who}。` +
      '大概率这个地址**不是** MCP 端点（常见：网关回了一个 HTML 页面或登录页）。' +
      `原始消息：${body}`
    )
  }
  if ((code === 401 || code === 403) && stage === MCP_STAGE_LIST_TOOLS) {
    // ⚠️ 口径在 P0-2-12 **改过一次**：拉列表改用**注册者（所属人）的凭据**（原为"不带任何凭据"）。
    //    于是这条文案的**主语**变了 —— 不再是"本阶段做不到、去配也没用"，而是
    //    "**要让所属人去配**"。这个区别必须写出来：当前登录的人自己配了也**不影响**这条路径
    //    （他改的是自己那份，而列表用的是所属人那份），否则又是一句把人引向治不好的动作的话。
    return (
      `工具列表需要鉴权（${stage}，HTTP ${code}）：${who}。` +
      '⚠️ 拉取工具列表用的是**该 server 所属人**的凭据（列表缓存全员共享，主语必须唯一确定）⇒ ' +
      '请让**所属人**到「我的凭据」页确认这一台的值已配置且未过期。' +
      '（其他使用者自己配的凭据只用于**调用工具**，不参与拉列表。）' +
      `原始消息：${body}`
    )
  }
  if (code === 401 || code === 403) {
    return (
      `MCP 端点拒绝了这个请求（${stage}，HTTP ${code}）：${who}。` +
      '请检查该 server 的凭据是否已配置且有效。' +
      `原始消息：${body}`
    )
  }
  if (code === 404) {
    // ⚠️ 这条分支是**实测**补的（`06` P0-2-1 坑预判 2）：会话 id 丢失/过期时，
    // Streamable HTTP 规范要求服务端回 **404** —— 与"路径写错了"是同一个状态码，
    // 而 404 的默认提示会把人引向 endpoint_url。靠服务端响应体里有没有 "session" 分开。
    const sessionHint = /session/i.test(message)
      ? ' ⚠️ 服务端的响应里提到了 session —— 多半是 mcp-session-id 丢了或已过期：' +
        'Streamable HTTP 用 404 表示"这个会话不存在"（与"路径不存在"同码，容易看错）。'
      : ''
    return (
      `MCP 端点不存在（${stage}，HTTP 404）：${who}。` +
      '请检查 endpoint_url 是否包含了正确的路径段（例如 /mcp）。' +
      `${sessionHint}原始消息：${body}`
    )
  }
  if (code === 405) {
    return (
      `MCP 端点不接受该 HTTP 方法（${stage}，HTTP 405）：${who}。` +
      'Streamable HTTP 要求端点同时接受 POST 与 DELETE（后者用于优雅关闭会话）。' +
      `原始消息：${body}`
    )
  }
  return `MCP 端点返回 HTTP ${code}（${stage}）：${who}。原始消息：${body}`
}

/**
 * SDK 支持的协议版本集。
 *
 * ⚠️ 这里**刻意写死**而不是 `import { SUPPORTED_PROTOCOL_VERSIONS }`：
 * 本模块是"把 SDK 的错误翻译成人话"的那一层，若它反过来依赖 SDK 的运行时导出，
 * 就变成"SDK 升了个级、错误文案跟着变"——文案属于我们，版本集才是 SDK 的。
 * 版本集与 SDK 的对齐由 `client.ts` 的握手留痕（`negotiatedProtocolVersion`）负责：
 * 真不一致时在**那一条日志**上看得见，不必靠文案。
 *
 * 实测（SDK 1.30.1）：`['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']`
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]
