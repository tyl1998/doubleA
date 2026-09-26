/**
 * MCP 凭据注入（P0-2-7）
 *
 * 依据：`docs/归档/06-P0-2-实施步骤.md` P0-2-7（内容 / 验收门槛 1~4 / 坑预判 1~4）
 *      + `docs/02-后端设计.md` §九（9.3 调用时注入 / 9.4 注入位置的口径 + 协议线实测 H1~H4）
 *      + `01` §3.6 的验收要点（"A 用户会话绝不使用 B 用户凭据"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本模块是**纯函数 + 一个 fetch 中间件**（不认识数据库、不认识用户、不 import 任何运行期模块）
 * ─────────────────────────────────────────────────────────────────────
 * "查凭据 → 解密"在 `services/mcpCall.service.ts`；"一次调用需要的一切"也在那里组装。
 * 这里只回答一个问题：**给定模板与明文值，这一次请求该长什么样**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 三种注入位置**共用同一个口子**：SDK 的 transport `fetch` 选项（H4 实测结论）
 * ─────────────────────────────────────────────────────────────────────
 * `02` §9.4 的 H4 探针已经问过"拿什么去注入"，答案是 `StreamableHTTPClientTransport` 的
 * **`fetch` 选项** —— 它能**同时**改 URL / 请求头 / 报文体 ⇒ 三种位置一个口子全包，
 * 不必改 SDK、也不必为 `BODY` 造旁路。本模块就落在那一个点上。
 *
 * ⚠️ **不要自己造第二条路**（比如给 transport 传 `requestInit.headers` 去管 HEADER 注入）：
 * SDK 的 `_commonHeaders()` 是 `{...auth, ...sessionId, ...protocolVersion, ...extraHeaders}`，
 * 我们的头**合并顺序在最后**（`client.ts` 判据 3）—— 两条路会在这一个地方打架，
 * 而症状是"某个头一会儿生效一会儿被顶掉"。
 * ⚠️ 也**不要**在这里改 `Authorization`：那是 `authProvider` 的地盘（本仓 P0 只有 `NONE`）。
 *
 * ⚠️ **本中间件对每一次请求都生效**，包括 `initialize` 握手、后续的 `GET`（SSE 通道）
 * 与 `DELETE`（终止会话）—— 这正是我们要的（同一个端点上的每一次往返都该带同一份凭据），
 * 但也意味着 `GET`/`DELETE` **没有 body** 这件事必须显式兜住（见 {@link createCredentialFetch}）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 走的是**每请求**而不是"建连接时"：所以 QUERY 注入**不需要**放弃连接复用（坑预判 2 的兑现）
 * ─────────────────────────────────────────────────────────────────────
 * 坑预判 2 写着"**必须先做探针**：SDK 是否允许把 query 加在每次请求上（而不是建连接时）？
 * 若不允许，定案是'QUERY 注入的 server 不走连接复用'"。
 * **探针结论（读 SDK 1.30.1 源码 + 本批的确定性核查）**：`send()` / `terminateSession()` /
 * `_startOrAuthSse()` 三处都是 `await (this._fetch ?? fetch)(this._url, init)` ——
 * **URL 是每次调用时现传给 fetch 的**（不是构造 transport 时冻住的），
 * 而 `_url` 本身在整个会话里不变 ⇒ **把 query 拼在每次请求的 URL 上是安全的**，
 * 会话（`mcp-session-id`）与协议版本头都不受影响。
 * ⇒ **不需要**"QUERY 注入的 server 每次新建 transport"，坑预判 2 里那个代价**没有发生**。
 * （该结论已回写 `02` §9.6。）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ **模板是唯一的路由表**：只遍历 `schema`，从不遍历"用户存了什么"
 * ─────────────────────────────────────────────────────────────────────
 * 于是"模板里删掉的 key 不会被注入"**结构性成立** —— 不需要在改模板时去清理用户的值
 * （P0-2-3 定案：**只提示、绝不自动清理**；两条必须能同时成立）。
 * 反过来说：**用户填了、但模板里没有的 key，也绝不会被注入** —— 那正是 `PUT` 在写端就
 * 400 拒掉"不在模板里的 key"的理由（存下来只会造成"我明明填了"的错觉）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 注入端**必须再判一次**那三条判据，且处置是"跳过 + 记账"，不是报错
 * ─────────────────────────────────────────────────────────────────────
 * 写端（`shared#credentialSchemaDeepIssues`）已经拦掉了"保留头名 / 非法头名 / query 分隔符 /
 * JSON-RPC 保留键"。但库里**可能已经存着**这类 key（P0-2-3 落地之前存进去的、或手工改库的），
 * 而读取端 `normalizeCredentialSchema` **刻意不跑语义层校验**（既不报错也不丢行 ——
 * 丢了界面会凭空少一行，而用户根本改不了那个事实）。
 * ⇒ 注入端**再判一次并跳过它**（判据函数在 `shared/src/mcp.ts`，**唯一实现**，别在这里重写）。
 *
 * 为什么是"跳过"而不是"照注不误"：照注的后果三种位置各不相同，但**都比跳过更坏** ——
 *   · 注 `accept` ⇒ 覆盖掉平台用来谈**响应形态**（回 JSON 还是回 SSE）的那个头，
 *     症状是"这个 server 的凭据一配上、工具就调不动了"，而报错会**指向上游**（坑预判 1）；
 *   · 注非法头名 / 头值带 CR/LF ⇒ `new Headers()` 直接抛（或更糟：静默截断），
 *     报错现场离出错现场隔了一层 fetch；
 *   · 注 `method` ⇒ 这次调用**变成另一次调用**；注 `id` ⇒ 响应 id 被顶成凭据值并
 *     **把凭据原样回显到线上**（H3 实测）。
 * 跳过的代价是"这个参数没生效"（上游大概率回 401/403，文案指向凭据），
 * 而它的**根因可见**：{@link CredentialInjection.skipped} 会带着 key 名与理由进日志。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑤ 明文只在这一层与 `secrets` 里出现（`02` §十三 / P0-1-12 的脱敏口径）
 * ─────────────────────────────────────────────────────────────────────
 * 本模块**不打任何日志**（零依赖），也**不把值放进任何返回值以外的位置**：
 * `applied` 里只有 **key 名**。消费方（`mcpCall.service.ts`）把明文同时交给两处：
 *   · 注入（本模块）—— 它该去的地方；
 *   · `McpClientOptions.secrets` —— **只用于把上游回显里的凭据抹掉**。
 * 除此之外一处都不许出现：日志、错误消息、`tool_call.inputSummary`（验收门槛 4）。
 */

import {
  hasQueryDelimiter,
  isReservedHeaderName,
  isReservedJsonRpcKey,
  isValidHttpHeaderName,
  type CredentialInjectLocation,
  type CredentialSchemaEntry,
} from '@doubulea/shared'

import type { McpFetch } from './client.js'

// ───────────────────────────── 跳过的理由（唯一落点，别在调用点再拼字符串）─────────────────────────────

/**
 * 跳过的理由文案。
 *
 * ⚠️ 提成常量而不是内联：验收与日志会引用它们，两处各写一份字符串的后果是
 * "谁改了一份，另一份的断言就静默失效"（`errors.ts#MCP_STAGE_LIST_TOOLS` 的同款理由）。
 */
export const MCP_SKIP_RESERVED_HEADER = '平台保留的头名（注入会覆盖平台自己的头，例如 Accept）'
export const MCP_SKIP_INVALID_HEADER_NAME = '不是合法的 HTTP 头名（fetch 会拒绝或静默截断）'
export const MCP_SKIP_UNSAFE_HEADER_VALUE = '头值里含 NUL / CR / LF（会破坏头部结构）'
export const MCP_SKIP_QUERY_DELIMITER = '查询参数名含 `&` 或 `=`（会把查询串切开）'
export const MCP_SKIP_JSONRPC_RESERVED = 'JSON-RPC 报文的保留字段（会覆盖报文语义）'

/** 一条被**主动跳过**的凭据参数（模板层本该拦掉，见文件头 ④） */
export interface SkippedCredentialKey {
  key: string
  inject: CredentialInjectLocation
  reason: string
}

/** 每个注入位置上**真的注入了**哪些 key（顺序 = 模板顺序）—— 只有键名，没有值 */
export interface InjectedCredentialKeys {
  HEADER: string[]
  QUERY: string[]
  BODY: string[]
}

/**
 * 一次调用的注入计划。
 *
 * 三个"落点映射"里的键必然**互不重叠**（每个 key 只属于一个 `inject` 位置，`key` 在同一模板内
 * 不允许重复 —— 写端已拦），所以"某个 key 注到哪里去了"不需要再加一张表。
 */
export interface CredentialInjection {
  /** 追加到请求头（`HEADER`） */
  headers: Record<string, string>
  /** 追加到 URL 查询串（`QUERY`）—— 每次请求都拼，见文件头 ② */
  query: Record<string, string>
  /** 并入 JSON-RPC 报文的**顶层**（`BODY`；H1 实测：非保留的顶层额外字段服务端认） */
  bodyPatch: Record<string, string>
  /** 真的注入了哪些 key（给日志 / 工具卡片"已注入 N 个凭据"） */
  applied: InjectedCredentialKeys
  /** 被跳过的 key 与理由（给日志；正常情况下应为空） */
  skipped: SkippedCredentialKey[]
}

/** 三个落点全空 ⇒ 没什么可注入的（**调用方据此决定要不要装中间件**，见 `createCredentialFetch`） */
export function isInjectionEmpty(injection: CredentialInjection): boolean {
  return (
    Object.keys(injection.headers).length === 0 &&
    Object.keys(injection.query).length === 0 &&
    Object.keys(injection.bodyPatch).length === 0
  )
}

/** 判定"是个普通对象"（数组 / null / 标量都不算） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 头值里有没有 NUL / CR / LF。
 *
 * ⚠️ 写成**函数**而不是正则：`/[\0\r\n]/` 会被 ESLint 的 `no-control-regex` 拦下
 * （那条规则拦的是"看起来像笔误的控制字符"，而这里是**故意的**）—— P0-1-21 踩过同一个坑，
 * 当时的结论同样是"写成函数更诚实：读的人一眼看出这是有意过滤"。
 */
function hasUnsafeHeaderChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0 || code === 10 || code === 13) return true
  }
  return false
}

/** 一个参数该不该被跳过；`null` = 可以注入 */
function skipReasonOf(entry: CredentialSchemaEntry, value: string): string | null {
  if (entry.inject === 'HEADER') {
    if (isReservedHeaderName(entry.key)) return MCP_SKIP_RESERVED_HEADER
    if (!isValidHttpHeaderName(entry.key)) return MCP_SKIP_INVALID_HEADER_NAME
    if (hasUnsafeHeaderChar(value)) return MCP_SKIP_UNSAFE_HEADER_VALUE
    return null
  }
  if (entry.inject === 'QUERY') {
    return hasQueryDelimiter(entry.key) ? MCP_SKIP_QUERY_DELIMITER : null
  }
  return isReservedJsonRpcKey(entry.key) ? MCP_SKIP_JSONRPC_RESERVED : null
}

/**
 * 模板 + 明文值 → 注入计划（**纯函数**，文件头 ③④ 的全部判据都在这里）。
 *
 * @param schema 当前模板（**唯一的路由表**：只遍历它）
 * @param values 该用户**已解密**的明文值（`key → 值`）。没值的 key 直接跳过 ——
 *   "没值"与"值不合法"是两件事：前者是**用户的正常状态**（不记账），后者才进 `skipped`。
 *
 * ⚠️ 值**不 trim**：一个令牌的首尾空格是用户自己填进去的，我们没有理由替他改
 * （"改了值"在这条链路上是**不可见**的，而后果是上游 401）。
 */
export function buildCredentialInjection(
  schema: readonly CredentialSchemaEntry[],
  values: Readonly<Record<string, string>>,
): CredentialInjection {
  const injection: CredentialInjection = {
    headers: {},
    query: {},
    bodyPatch: {},
    applied: { HEADER: [], QUERY: [], BODY: [] },
    skipped: [],
  }

  for (const entry of schema) {
    const value = values[entry.key]
    // 没值（没填 / 被清空 / 解密失败已降级）⇒ 什么也不做，也**不记账**（见函数注释）
    if (typeof value !== 'string' || value === '') continue

    const reason = skipReasonOf(entry, value)
    if (reason !== null) {
      injection.skipped.push({ key: entry.key, inject: entry.inject, reason })
      continue
    }

    if (entry.inject === 'HEADER') {
      injection.headers[entry.key] = value
      injection.applied.HEADER.push(entry.key)
    } else if (entry.inject === 'QUERY') {
      injection.query[entry.key] = value
      injection.applied.QUERY.push(entry.key)
    } else {
      // 取值域只有三个（`CREDENTIAL_INJECT_LOCATIONS`）⇒ 剩下的必然是 BODY
      injection.bodyPatch[entry.key] = value
      injection.applied.BODY.push(entry.key)
    }
  }

  return injection
}

/** 本次一共注入了几个参数（`applied` 三个数组的长度和） */
export function injectedKeyCount(injection: CredentialInjection): number {
  return injection.applied.HEADER.length + injection.applied.QUERY.length + injection.applied.BODY.length
}

// ───────────────────────────── 三个落点的应用（纯函数，逐个可断言）─────────────────────────────

/**
 * 把 `QUERY` 注入到 URL。
 *
 * 用 `URL.searchParams.set` 而不是手拼字符串：它负责**百分号编码**
 * （`02` §九 的边界说明：`QUERY` 的 key 只拦 `&`/`=`，值里的空白 / `#` / `%` 由这一层统一编码）。
 *
 * ⚠️ **不动 URL 上已有的查询参数**（同名时以凭据为准 —— `set` 的语义）；
 * `endpoint_url` 自带 query 的 server 因此仍然可用（例如 `?tenant=x`）。
 * ⚠️ 空 `query` ⇒ **原样返回输入**（不做 `new URL()` 往返）：那次往返会把 URL 规范化，
 * 而"没注入任何东西的 server 的请求 URL 被悄悄改写"是最不该发生的一类副作用。
 */
export function applyQueryToUrl(url: string | URL, query: Readonly<Record<string, string>>): string {
  const target = typeof url === 'string' ? url : url.toString()
  if (Object.keys(query).length === 0) return target
  const parsed = new URL(target)
  for (const [key, value] of Object.entries(query)) parsed.searchParams.set(key, value)
  return parsed.toString()
}

/** {@link applyBodyPatch} 的结论 */
export interface BodyPatchResult {
  body: string
  /** 是否真的并进去了（`false` 时 `body` 与入参**逐字相同**） */
  applied: boolean
  /** 没并进去的原因；`applied` 为 true 或"本来就没东西要并"时为 `null` */
  reason: string | null
}

/**
 * 把 `BODY` 并入 JSON-RPC 报文的**顶层**（H1 实测：非保留的顶层额外字段服务端认）。
 *
 * ⚠️ 并的是**顶层**，不是 `params.arguments`（H2 实测：那会**污染工具入参**）、
 * 也不是 `params` 的兄弟键（H2 实测：**凭据等于白注**）。
 * ⚠️ 打不开的报文（不是 JSON / 不是对象）⇒ **原样返回 + 给出理由**：本函数不抛，
 * 因为"报文形状不对"是平台侧的问题，不该在注入这一层变成一个 500
 * （真实后果是这次调用漏注了凭据 ⇒ 上游 401，而 `reason` 会进日志解释为什么）。
 */
export function applyBodyPatch(body: string, patch: Readonly<Record<string, string>>): BodyPatchResult {
  if (Object.keys(patch).length === 0) return { body, applied: false, reason: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { body, applied: false, reason: '报文体不是合法 JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { body, applied: false, reason: '报文体不是 JSON 对象（没有可注入的顶层字段）' }
  }
  return { body: JSON.stringify({ ...parsed, ...patch }), applied: true, reason: null }
}

// ───────────────────────────── fetch 中间件 ─────────────────────────────

/**
 * 注入中间件：`(url, init) => fetch(url', init')`。
 *
 * 与 SDK 的 `FetchLike`（`shared/transport.d.ts`）**同形**，所以可以直接交给
 * `StreamableHTTPClientTransport` 的 `fetch` 选项（`client.ts` 已把它透出来）。
 *
 * 三条实现要点：
 *   ① **空注入 ⇒ 原样返回 `baseFetch`**（不套一层）：见 {@link applyQueryToUrl} 的第二条 —
 *      "没东西要注入的 server 的请求一个字都不该被改"；
 *   ② **headers 是在 `init.headers` 之上 `set`**，不是整体替换 —— SDK 传进来的
 *      `Headers` 里装着 `mcp-session-id` / `mcp-protocol-version` / `accept` / `content-type`，
 *      整体替换会把它们全丢掉（会话与响应形态一起坏掉）；
 *   ③ **`body` 只在"本来就是字符串"时打补丁**：`GET` / `DELETE` 两条路径没有 body
 *      （`undefined`），`FormData` / 流这类也不是我们该解析的东西 ⇒ 一律原样放过。
 *
 * ⚠️ 本函数**不打日志**：它可能握着明文值，而"带值的对象"是 `02` §十三 明确不许进日志的东西。
 * 要解释"为什么某个参数没生效"，调用方拿 {@link CredentialInjection.skipped} 去记（只有键名）。
 */
export function createCredentialFetch(
  injection: CredentialInjection,
  baseFetch: McpFetch = globalThis.fetch,
): McpFetch {
  if (isInjectionEmpty(injection)) return baseFetch

  const headers = injection.headers
  const bodyPatch = injection.bodyPatch

  return async function credentialFetch(url, init) {
    const target = applyQueryToUrl(url, injection.query)

    const merged = new Headers(init?.headers)
    for (const [key, value] of Object.entries(headers)) merged.set(key, value)

    let body = init?.body
    if (typeof body === 'string') {
      const patched = applyBodyPatch(body, bodyPatch)
      if (patched.applied) body = patched.body
    }

    return baseFetch(target, { ...init, headers: merged, body })
  }
}
