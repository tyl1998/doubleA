/**
 * MCP 工具网关的**执行体 + 工具定义**（P1-19）
 *
 * 依据：`shared/src/mcp.ts` 的「工具网关」段 + `backend/src/mcp/gatewayModel.ts`（纯策略）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有它：MCP 工具数量爆炸时的**渐进披露**
 * ─────────────────────────────────────────────────────────────────────
 * Agent 可以绑多台 MCP server、每台几十个工具。若把全部工具一次性放进 `tools` 下发给模型，
 * 上下文会被几十上百个工具定义挤爆，模型挑工具的准确率也会掉。网关把"全量工具"变成
 * "**按需发现**"：工具多时只下发两个固定工具 ——
 *   · {@link listMcpToolsTool}（`mcp_list_tools`）：列出/搜索可用工具（人名 + 一行说明）；
 *   · {@link callMcpToolTool}（`mcp_call_tool`）：按名调用（参数对象原样传给它）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条调用路径、同一套口径（与知识库/记忆一族同款）
 * ─────────────────────────────────────────────────────────────────────
 *   · ChatBot（`orchestrator/chatBot.ts`）在工具循环里直接调 {@link executeListMcpTools}，
 *     `mcp_call_tool` 则由它**改写成真实工具调用**（复用既有的危险确认 / 卡片 / 执行链）；
 *   · TaskAgent（沙箱里的 pi 引擎）经 `/api/sandbox/builtin/call` 代理 —— 容器侧把网关工具
 *     当**内置工具**注册（见 `sandbox/proxy.ts`），执行仍在后端。
 * 工具定义（{@link listMcpToolsTool} / {@link callMcpToolTool}）是**唯一实现**，两条路径共用。
 */

import {
  MCP_CALL_TOOL_TOOL_NAME,
  MCP_LIST_TOOLS_TOOL_NAME,
  mcpCallToolArgsSchema,
  mcpListToolsArgsSchema,
} from '@doubulea/shared'

import { parseToolArguments } from '../llm/client.js'
import {
  filterMcpToolEntries,
  findMcpArgumentIssues,
  formatArgumentIssues,
  formatMcpToolCatalog,
  type McpCatalogToolEntry,
} from '../mcp/gatewayModel.js'
import type { McpToolRoute, OpenAiFunctionTool } from '../mcp/toolSchema.js'
import { truncateToolResult } from './chatContext.js'

/**
 * 「工具名 → 参数 schema」的查表（`chatBot.ts` / 沙箱代理用来做本地参数体检）。
 *
 * ⚠️ 单独一张表、而不是把 schema 塞进 `McpToolRoute`：`routes` 是**名字 → 调哪里**的映射，
 * 它的消费方（执行链）不需要也不该看到 schema；而目录条目（`entries`）本来就是"给模型看
 * 的信息"的载体。这里只是把同一份 `entries` 索引成按名字的查表，避免调用点再线性扫一遍。
 */
export function indexCatalogSchemas(
  entries: readonly McpCatalogToolEntry[],
): Readonly<Record<string, unknown>> {
  const schemas: Record<string, unknown> = {}
  for (const entry of entries) {
    if (!Object.prototype.hasOwnProperty.call(schemas, entry.name)) schemas[entry.name] = entry.inputSchema
  }
  return schemas
}

/** 网关工具卡片上的"来自哪个系统"（`toolCallRecordSchema.serverName`；与 `KNOWLEDGE_TOOL_SERVER_NAME` 同族） */
export const MCP_GATEWAY_TOOL_SERVER_NAME = 'MCP 工具'

/**
 * 「列出 / 搜索 MCP 工具」的工具定义（OpenAI 形态）。**工具多时才下发**（策略见
 * `mcp/gatewayModel.ts#selectMcpInlineTools`）。
 */
export function listMcpToolsTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: MCP_LIST_TOOLS_TOOL_NAME,
      description:
        '列出或搜索当前可用的 MCP 工具（绑定的外部系统提供的工具）。' +
        '当你不确定有哪些工具、或需要某个能力但当前没看到对应工具时，先用它按关键词找；' +
        '拿到工具名后再用 mcp_call_tool 调用。不带 query 会列出（封顶后的）全部工具。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，按工具名与说明做匹配；省略则列全部。' },
          server: { type: 'string', description: '只看某一台外部系统（填系统名）；省略则跨全部。' },
        },
      },
    },
  }
}

/**
 * 「调用 MCP 工具」的工具定义（OpenAI 形态）。
 *
 * ⚠️ 它只是一个**转发壳**：`name` 必须是 `mcp_list_tools` 给出过的工具名；`arguments` 是那台
 * 工具自己的参数对象。真正的危险确认 / 凭据注入 / 调用都发生在后端拿到真实工具名之后
 * （见 `chatBot.ts` 的分流）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么 `arguments` 是**宽松**的，而类型信息由 `mcp_list_tools` 给
 * ─────────────────────────────────────────────────────────────────────
 * 网关的初衷就是"**按需发现**"：模型先搜、我们再把那个工具的**完整信息**返给它。
 * 所以参数 schema 的落点是 `mcp_list_tools` 的**返回内容**（见 `gatewayModel.ts#formatMcpToolCatalog`
 * 里内嵌的 inputSchema），不是这里的工具定义。
 * ⚠️ 曾经试过把"已列出工具"的 schema 收进本工具的 `oneOf`（2026-10-22）：那样每轮都要重建
 * `tools`（提示缓存失效），而且模型拿到的信息被拆成"搜索结果"和"工具定义"两个来源，反而更难对上。
 * ⇒ 这里保持宽松；真正的兜底是执行前的本地体检（`findMcpArgumentIssues`）。
 */
export function callMcpToolTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: MCP_CALL_TOOL_TOOL_NAME,
      description:
        '调用一个 MCP 工具。name 用 mcp_list_tools 给出的工具名（形如 mcp_xxx_yyy）；' +
        'arguments 是该工具的参数对象（没有参数就省略）。' +
        '⚠️ 参数必须符合 mcp_list_tools 结果里该工具的 inputSchema：object / array 参数直接给 ' +
        'JSON 字面量，不要序列化成字符串（否则会被拒绝，且不会真的发出调用）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要调用的工具名（来自 mcp_list_tools）。' },
          arguments: {
            type: 'object',
            description: '该工具的参数对象（键值对）；没有参数可省略。字段与类型见 mcp_list_tools 的 inputSchema。',
            additionalProperties: true,
          },
        },
        required: ['name'],
      },
    },
  }
}

/** {@link executeListMcpTools} 的结论（**恒不抛**：失败也翻成模型读得懂的 `isError`） */
export interface McpGatewayListOutcome {
  isError: boolean
  output: string
}

/**
 * 执行一次 `mcp_list_tools`（**恒不抛**，与 `executeKnowledgeTool` 同款）。
 *
 * 目录本体来自调用方给的 `entries`（= 这一轮装配好的**全部**工具，含未直接下发的）——
 * 本函数不查库、不联网。
 */
export function executeListMcpTools(input: {
  entries: readonly McpCatalogToolEntry[]
  /** 模型给的 `arguments` **原文**（JSON 串；与 `call.arguments` 同形） */
  arguments: string
}): McpGatewayListOutcome {
  const parsed = parseToolArguments(input.arguments)
  if (!parsed.ok) {
    return {
      isError: true,
      output: `工具调用失败：${parsed.reason}。模型给出的原文：${truncateToolResult(input.arguments)}`,
    }
  }
  const args = mcpListToolsArgsSchema.safeParse(parsed.value)
  if (!args.success) {
    return { isError: true, output: '工具调用失败：参数不合法（query/server 只能是字符串）。' }
  }
  const page = filterMcpToolEntries(input.entries, {
    ...(args.data.server === undefined ? {} : { server: args.data.server }),
    ...(args.data.query === undefined ? {} : { query: args.data.query }),
  })
  return { isError: false, output: truncateToolResult(formatMcpToolCatalog(page)) }
}

/** {@link resolveMcpGatewayCall} 的结论：要么改写成一次真实调用，要么是一句回填给模型的错误 */
export type McpGatewayCallResolution =
  | { ok: true; name: string; arguments: string }
  | { ok: false; output: string }

/**
 * 把一次 `mcp_call_tool` 的入参**改写成一次真实工具调用**（`name` + `arguments` 原文）。
 *
 * ⚠️ 它是"网关调用 → 既有 MCP 执行链"的**唯一桥**（`chatBot.ts` 的分流点）：改写后走的路
 * 与原生的直接调用**逐字同一条**（危险确认、凭据注入、卡片、错误回填都复用），
 * 于是网关不会引入第二条执行语义。
 *
 * 失败（参数非法 / 名字不在目录里 / **参数类型明显不符**）**不抛**：翻成一句可读的原因回填给模型，
 * 让它自己改（同 `01` §3.6 的"失败可自愈"）。
 *
 * ⚠️ **先做本地类型体检，再放行到上游**（2026-10-22 教训）：网关模式下模型看不到工具 schema，
 * 很容易把 object 参数序列化成字符串；若直接发给上游，会拿到一句 `data/variables must be object`
 * —— 既耗一次上游往返，又要在执行链上多弹一张危险确认卡，而模型往往只是"把字符串加个缩进"再试。
 * 本地体检把这类明显必错的调用**在弹卡之前**拦下（`confirmed` 里的工具名不再要求确认）。
 */
export function resolveMcpGatewayCall(
  routes: Readonly<Record<string, McpToolRoute>>,
  rawArguments: string,
  schemas?: Readonly<Record<string, unknown>>,
): McpGatewayCallResolution {
  const parsed = parseToolArguments(rawArguments)
  if (!parsed.ok) {
    return { ok: false, output: `工具调用失败：${parsed.reason}。模型给出的原文：${truncateToolResult(rawArguments)}` }
  }
  const args = mcpCallToolArgsSchema.safeParse(parsed.value)
  if (!args.success) {
    return { ok: false, output: '工具调用失败：缺少 name 参数（请填 mcp_list_tools 给出的工具名）。' }
  }
  const name = args.data.name
  if (!Object.prototype.hasOwnProperty.call(routes, name)) {
    return {
      ok: false,
      output: `工具调用失败：本轮没有名为「${name}」的工具（可能是模型编的名字，或该工具所属的 MCP server 已被解绑）。请先用 ${MCP_LIST_TOOLS_TOOL_NAME} 确认真实的工具名。`,
    }
  }
  const toolArguments: Record<string, unknown> = args.data.arguments ?? {}
  if (schemas !== undefined && Object.prototype.hasOwnProperty.call(schemas, name)) {
    const issues = findMcpArgumentIssues(schemas[name], toolArguments)
    if (issues.length > 0) return { ok: false, output: formatArgumentIssues(issues) }
  }
  return { ok: true, name, arguments: JSON.stringify(toolArguments) }
}
