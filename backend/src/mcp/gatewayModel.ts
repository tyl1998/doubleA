/**
 * MCP 工具网关的**纯函数**层（P1-19）
 *
 * 依据：本批（"MCP 工具数量爆炸 ⇒ 渐进披露")的定案 —— 见 `shared/src/mcp.ts` 的
 * 「工具网关」段与 `backend/src/orchestrator/mcpGatewayTools.ts`（执行体）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一层回答三个问题，且**不碰任何运行期依赖**（同 `mcp/toolSchema.ts` 的取舍）
 * ─────────────────────────────────────────────────────────────────────
 *   ① {@link selectMcpInlineTools} —— 这一轮**哪些工具直接下发**、要不要开网关；
 *   ② {@link filterMcpToolEntries} —— 目录工具（`mcp_list_tools`）该回哪几条；
 *   ③ {@link formatMcpToolCatalog} —— 那些条目怎么排版成模型读得懂的文本。
 * 三者都是纯函数 ⇒ 断言不需要起 DB / Redis / 上游。调用方（`mcpCall.service.ts` 与
 * `orchestrator/mcpGatewayTools.ts`）只做 I/O 与拼装。
 */

import {
  MCP_LIST_TOOLS_ENTRY_DESCRIPTION_MAX,
  MCP_LIST_TOOLS_MAX_RESULTS,
} from '@doubulea/shared'

/**
 * 一件**已被命名**的 MCP 工具（下发给模型的名字 + 它是谁 + 一行说明）。
 *
 * ⚠️ 它是目录/检索的**唯一事实来源**：`mcp_list_tools` 回给模型的就是它，`mcp_call_tool`
 * 用 `name` 反查路由。`name` 恒是下发给模型的（OpenAI）名字，`toolName` 是 MCP 侧**原始**名。
 */
export interface McpCatalogToolEntry {
  /** 下发给模型的名字（`mcp_{slug}_{tool}`，已去重/截断） */
  name: string
  serverId: string
  /** 展示名（目录里用来分组） */
  serverName: string
  /** MCP 侧**原始**工具名（`tools/call` 要原样回给它） */
  toolName: string
  /** 给模型看的说明（已按 {@link MCP_TOOL_DESCRIPTION_MAX} 截断过，与下发的工具同一份） */
  description: string
  /** 危险工具（仅留档；目录里不暴露这个策略） */
  dangerous: boolean
}

/** {@link selectMcpInlineTools} 的结论 */
export interface McpInlineSelection {
  /** **直接下发**的工具名集合（其余走网关） */
  inline: Set<string>
  /** 是否有工具改走网关（= 模型需要用 `mcp_list_tools` 才能看到它们） */
  gatewayActive: boolean
}

/**
 * 「这一轮直接下发哪些 MCP 工具」（**唯一**策略点）。
 *
 * 规则（与 `config.mcp.inlineToolLimit` 的注释逐字对应）：
 *   · 全部工具数 ≤ `inlineLimit` ⇒ **全部直接下发**（`gatewayActive:false`，与旧行为一致）；
 *   · 超过 `inlineLimit` ⇒ 只直接下发 `pinnedNames` 里的（Agent 标的"常驻工具"），
 *     其余走网关（`gatewayActive:true`）；没有常驻 ⇒ 一个都不直接下发。
 *
 * ⚠️ `pinnedNames` 是**下发给模型的名字**（`entry.name`），不是 MCP 原始名 —— 由调用方
 * （`mcpCall.service.ts`，它手上有 server→原始名的映射与命名结果）负责翻译。
 * ⚠️ 常驻工具即使 `total ≤ inlineLimit` 也不再单独处理：那种情况下本来就全下发了。
 */
export function selectMcpInlineTools(
  entries: readonly McpCatalogToolEntry[],
  pinnedNames: ReadonlySet<string>,
  inlineLimit: number,
): McpInlineSelection {
  if (entries.length <= inlineLimit) {
    return { inline: new Set(entries.map((entry) => entry.name)), gatewayActive: false }
  }
  const inline = new Set<string>()
  for (const entry of entries) if (pinnedNames.has(entry.name)) inline.add(entry.name)
  return { inline, gatewayActive: true }
}

/** `mcp_list_tools` 的检索条件（两都可选；与 `shared#mcpListToolsArgsSchema` 同形） */
export interface McpToolSearchQuery {
  /** server 名或 id（大小写不敏感） */
  server?: string
  /** 关键词（工具名 / 原始名 / 描述 的包含匹配） */
  query?: string
}

/** {@link filterMcpToolEntries} 的结论 */
export interface McpToolCatalogPage {
  /** 实际列出的条目（≤ {@link MCP_LIST_TOOLS_MAX_RESULTS}） */
  entries: McpCatalogToolEntry[]
  /** **命中总数**（可能 > `entries.length` —— 超出部分未列出，要给模型明说） */
  total: number
}

/**
 * 目录工具（`mcp_list_tools`）的检索：先按 `server` 收窄，再按 `query` 做包含匹配，最后封顶。
 *
 * ⚠️ **不静默截断**：`total` 一定回命中总数，调用方据此写「其余 N 个未列出」（同
 * `knowledgeTools.ts` 的目录口径）。`query` 为空 = 不筛（列全部，但仍受上限约束）。
 */
export function filterMcpToolEntries(
  entries: readonly McpCatalogToolEntry[],
  query: McpToolSearchQuery,
): McpToolCatalogPage {
  const server = query.server?.trim().toLowerCase() ?? ''
  const keyword = query.query?.trim().toLowerCase() ?? ''
  const matched = entries.filter((entry) => {
    if (server !== '') {
      const byId = entry.serverId.toLowerCase() === server
      const byName = entry.serverName.toLowerCase() === server
      if (!byId && !byName) return false
    }
    if (keyword === '') return true
    return (
      entry.name.toLowerCase().includes(keyword) ||
      entry.toolName.toLowerCase().includes(keyword) ||
      entry.description.toLowerCase().includes(keyword)
    )
  })
  return { entries: matched.slice(0, MCP_LIST_TOOLS_MAX_RESULTS), total: matched.length }
}

/** 码点安全截断（与 `toolSchema.ts#toDescription` 同口径：不劈开代理对） */
function truncateByCodePoints(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`
}

/**
 * 把检索结果排版成模型读得懂的**目录文本**（按 server 分组）。
 *
 * 三条口径：
 *   · **工具名原样给出**（`entry.name`）—— 模型要拿它去调 `mcp_call_tool`，改一个字符就调不到；
 *   · 每条只给**截断到一行**的描述（{@link MCP_LIST_TOOLS_ENTRY_DESCRIPTION_MAX}）：目录是"索引"
 *     不是"说明书"，完整描述在真的调用时才需要；
 *   · 命中数超上限 / 为空时**明说**（不静默省略、不假装"没有工具"）。
 */
export function formatMcpToolCatalog(page: McpToolCatalogPage): string {
  if (page.total === 0) {
    return '没有匹配的 MCP 工具。可以换一个关键词，或不带 query 再列一次看看有哪些工具。'
  }

  const byServer = new Map<string, McpCatalogToolEntry[]>()
  for (const entry of page.entries) {
    const list = byServer.get(entry.serverName) ?? []
    list.push(entry)
    byServer.set(entry.serverName, list)
  }

  const lines: string[] = []
  if (page.total > page.entries.length) {
    lines.push(`共匹配 ${page.total} 个工具，以下列出前 ${page.entries.length} 个：`)
  } else {
    lines.push(`共 ${page.total} 个工具：`)
  }
  for (const [serverName, list] of byServer) {
    lines.push(`【${serverName}】`)
    for (const entry of list) {
      const desc =
        entry.description === ''
          ? ''
          : `：${truncateByCodePoints(entry.description, MCP_LIST_TOOLS_ENTRY_DESCRIPTION_MAX)}`
      lines.push(`- ${entry.name}${desc}`)
    }
  }
  if (page.total > page.entries.length) {
    lines.push(`（其余 ${page.total - page.entries.length} 个未列出，请用 query 缩小范围。）`)
  }
  lines.push('要调用某个工具，用 mcp_call_tool：name 填上面的工具名，arguments 填它的参数对象。')
  return lines.join('\n')
}
