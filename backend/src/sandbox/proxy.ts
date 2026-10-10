/**
 * 沙箱 MCP 代理端点（**P0-3-9b**）—— §七 的 `proxy.ts`
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §七（MCP 走后端代理：定案/调用链/三条通道要素/
 *      工具清单与唯一反查点/危险判定第二落点/三条安全约束）、§二（`SANDBOX_CALLBACK_PORT`、
 *      `SANDBOX_PROXY_TIMEOUT_SEC`）、§八（跨请求提问原语，P0-3-6b 已落地）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一句话：**容器内的引擎永不直连 MCP，所有 MCP 调用经这条内网通道由后端代调**
 * ═══════════════════════════════════════════════════════════════════════
 * ```
 * 容器里的 mcp_* 工具（桥扩展注册）
 *   → fetch POST {SANDBOX_BACKEND_URL}/api/sandbox/mcp/call   （头：x-sandbox-token）
 *   → 本文件：① 校验令牌 → {conversationId,userId,agentId}
 *             ② 校验"这个 server 真的绑在这个 agent 上"（防越权，§七 6 ②）
 *             ③ 危险判定（§七 5）→ 需要则**跨请求**问用户（§八 的 askConversation）
 *             ④ 调 P0-2 已有的 executeMcpToolCall（**带 userId 的凭据**）
 *   → 结果原样回给扩展 → 扩展交回 pi → 模型继续
 * ```
 * ★ **关键复用点**：④ 那一步是 P0-2 做完的执行器（凭据注入 / 结果整形 / 错误翻译全在里面）
 * —— 本批只"把入口接上"，**没有重写任何 MCP 逻辑**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 两个端点**都不套统一信封**（与公网 API 刻意不同）
 * ═══════════════════════════════════════════════════════════════════════
 * 统一信封（`{code,msg,data}`）是**给前端 + 给用户看的**契约：它承载"字段级校验失败"、
 * "首登闸门"那类要给界面分派的东西。而这一侧唯一的客户端是**我们自己的桥扩展**，
 * 它要的是"这一趟到底干成了没有、没干成为什么"，一句 `{error:{code,message}}` 比
 * 套两层信封更好写也更好读。
 * ⚠️ 但 **404 仍然套信封**（`listener.ts#setNotFoundHandler`）：那是"容器把路径写错了"，
 *    与"端点自己判定的失败"是两件事，而它由 listener 统一给出。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 4xx 与 200 的分界线：**"能不能调" vs "调了之后发生了什么"**
 * ═══════════════════════════════════════════════════════════════════════
 *   · 令牌不认 / 体不合法 / 别名不存在 / 不属于这个 agent / 清单没下发 ⇒ **4xx**：
 *     这是**协议层**的拒绝（连"这次调用该不该发生"都还没谈），扩展会把它翻成一个异常。
 *   · 用户没确认 / 凭据没配 / 上游挂了 / 工具自己报错 ⇒ **200 + `{isError, text}`**：
 *     这些是**这次调用的一份结论**，模型必须能读到它才能向用户解释（§七 7：与 ChatBot
 *     看到的是同一族文案）。把它们做成 4xx 会让模型只看到一句"请求失败"。
 *   ⇒ 判据一句话：**能不能调 = 状态码；调了之后怎样 = 响应体。**
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 危险调用的**串行化**（§七 6 ③）
 * ═══════════════════════════════════════════════════════════════════════
 * 确认槽 `chat.confirm:{id}` 与 `/active.pendingConfirmId` 是**单槽**的
 * （`orchestrator/sse.ts#awaitConfirm` 的"幂等前提"写着这条）。同会话同时来的两个危险调用
 * 若并行提问，后一个会**覆盖前一个的 `pendingConfirmId`**，前一个只能等到超时 ——
 * 症状是"用户点了确认，但那个工具说没人应答"。
 * ⇒ 本文件用 {@link withConversationSerial} 按会话串行化**危险那一段**（非危险调用不占队）。
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { AppError, RECALL_MEMORY_TOOL_NAME, REMEMBER_TOOL_NAME, SEND_NOTIFICATION_TOOL_NAME } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { McpAbortError } from '../mcp/errors.js'
import { isDangerousTool } from '../mcp/risk.js'
import { parseToolCache } from '../mcp/toolCache.js'
import { toDescription } from '../mcp/toolSchema.js'
import { executeSendNotification, getNotifyTarget, notifyBuiltinDescriptor } from '../notify/index.js'
import { knowledgeListTool, knowledgeSearchTool, readDocumentTool, summarizeToolInput } from '../orchestrator/chatContext.js'
import { executeMemoryTool, executeRecallMemoryTool, recallMemoryTool, rememberTool } from '../orchestrator/memoryTools.js'
import {
  boundKnowledgeBaseIds,
  executeKnowledgeTool,
  isKnowledgeToolName,
} from '../orchestrator/knowledgeTools.js'
import { askConversation, ChatStoppedError, type ConfirmQuestion } from '../orchestrator/sse.js'
import { artifactDownloadContentType, openArtifactSourceForConversation } from '../services/artifact.service.js'
import { buildContentDisposition } from '../services/document.service.js'
import { openFileSourceForConversation } from '../services/file.service.js'
import { executeMcpToolCall } from '../services/mcpCall.service.js'
import {
  emptySandboxMcpCatalog,
  readSandboxMcpCatalog,
  registeredSandboxMcpToolName,
  sandboxMcpAliasAt,
  writeSandboxMcpCatalog,
  type SandboxBuiltinToolRef,
  type SandboxMcpCatalog,
  type SandboxMcpToolRef,
} from './mcpMap.js'
import { SANDBOX_TOKEN_HEADER } from './spec.js'
import { resolveSandboxToken, type SandboxTokenRecord } from './token.js'

// ───────────────────────────── 算清单（唯一要查库的那一步）─────────────────────────────

/**
 * 算一份工具清单并**发布**到 Redis（`sandbox.mcp:{conversationId}`）。
 *
 * 名与序都来自**确定性输入**（`(name, id)` 升序 —— 与 `mcpCall.service.ts#resolveMcpToolCatalog`
 * 逐字同一口径），于是"扩展拉的清单"与"编排层预热算的清单"必然一致，不需要互相通气。
 *
 * ⚠️ **只读 `tool_cache`，绝不联网**（与 ChatBot 路径同一条取舍）：一次 `tools/list` 可能几秒，
 * 而派活的第一帧不该等它。缓存为空的 server **只记账 + warn**，不影响别的 server。
 * ⚠️ 截断用 `config.mcp.toolLimit`（`MCP_TOOL_LIMIT`）—— 与 ChatBot 路径**同一个上限**，
 * 免得"同一个工具在对话页有、在任务页没有"。
 */
export async function buildSandboxMcpCatalog(
  conversationId: string,
  agentId: string,
): Promise<SandboxMcpCatalog> {
  const db = getPrisma()
  const logger = getLogger()

  const components = await db.agentComponent.findMany({
    where: { agentId },
    select: { componentType: true, refId: true },
    orderBy: [{ componentType: 'asc' }, { refId: 'asc' }],
  })
  const serverIds = [
    ...new Set(components.filter((row) => row.componentType === 'MCP').map((row) => row.refId)),
  ]
  const knowledgeIds = [
    ...new Set(components.filter((row) => row.componentType === 'KNOWLEDGE').map((row) => row.refId)),
  ]

  const catalog: SandboxMcpCatalog = emptySandboxMcpCatalog()

  // ── MCP server（有绑才查、才算）──
  const rows =
    serverIds.length === 0
      ? []
      : await db.mcpServer.findMany({
          where: { id: { in: serverIds } },
          select: { id: true, name: true, slug: true, toolCache: true },
        })
  // 绑定里有查不到的 server（`DELETE` 那一侧有 409 拦着）⇒ 走到这里说明数据异常
  if (rows.length !== serverIds.length) {
    const found = new Set(rows.map((row) => row.id))
    logger.warn(
      { conversationId, agentId, missingServerIds: serverIds.filter((id) => !found.has(id)) },
      'Agent 绑定里有查不到的 MCP server（绑定未被清理）⇒ 这些 server 的工具不会下发给沙箱',
    )
  }

  const ordered = [...rows].sort((a, b) =>
    a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name),
  )

  /** 已占用的**注册名**（跨 server 累积 —— 见 `mcpMap.ts#registeredSandboxMcpToolName`） */
  const taken = new Set<string>()

  ordered.forEach((row, index) => {
    const alias = sandboxMcpAliasAt(index)
    // 别名与 server 一起登记（**不管它有没有工具缓存**）：别名是"第几台 server"的编号，
    // 让它随"某台 server 恰好没缓存"而漂移，就会造出"同一个 alias 在不同时刻指向不同 server"
    catalog.servers.push({ alias, serverId: row.id, serverName: row.name })

    const cache = parseToolCache(row.toolCache)
    if (cache === null) {
      logger.warn(
        { conversationId, agentId, alias, mcpServerId: row.id, name: row.name },
        'MCP server 没有可用的工具缓存 ⇒ 沙箱里不会出现它的任何工具' +
          '（去 /api/mcp/servers/:id/tools?refresh=1 或点「测试」拉一次）',
      )
      return
    }

    const keep = Math.min(cache.tools.length, config.mcp.toolLimit)
    for (const tool of cache.tools.slice(0, keep)) {
      const name = registeredSandboxMcpToolName(alias, tool.name, taken)
      taken.add(name)
      catalog.tools[name] = {
        alias,
        serverId: row.id,
        serverName: row.name,
        toolName: tool.name,
        // ★ 危险判定的输入留在这里（**不下发容器**，见 `mcpMap.ts#SandboxMcpToolRef.annotations`）
        annotations: tool.annotations,
        description: toDescription(tool),
        inputSchema: tool.inputSchema,
      }
    }
    if (keep < cache.tools.length) {
      logger.warn(
        { conversationId, agentId, alias, mcpServerId: row.id, total: cache.tools.length, kept: keep, limit: config.mcp.toolLimit },
        '沙箱里 MCP 工具数超过 MCP_TOOL_LIMIT，已截断（被截掉的工具容器侧永远看不到）',
      )
    }
  })

  // ── 平台内置工具（知识库检索 / 目录 / 整篇阅读）—— 绑了库才下发 ──
  // 与 ChatBot 同源（`knowledgeTools.ts`）；容器侧注册的商品名下不带 `mcp_` 前缀，
  // 执行时经 `/api/sandbox/builtin/call` 由后端代跑（凭据/库都不进容器）。见 `子方案③` §七。
  const builtins = knowledgeIds.length > 0 ? knowledgeBuiltinTools() : []
  // 「记忆」内置工具（P1-8/P1-8a：remember 写入 + recall_memory 按需检索）：与知识库无关、**始终下发**
  builtins.push(...memoryBuiltinDescriptors())
  // 通知工具（P1-6，场景 1）：只在该会话属于一个**配了通知渠道**的定时任务运行时下发
  if (getNotifyTarget(conversationId) !== undefined) builtins.push(notifyBuiltinDescriptor())
  catalog.builtins = builtins

  await writeSandboxMcpCatalog(conversationId, catalog)
  logger.info(
    {
      conversationId,
      agentId,
      serverCount: catalog.servers.length,
      toolCount: Object.keys(catalog.tools).length,
      builtinToolCount: catalog.builtins.length,
    },
    '已为沙箱下发工具清单（MCP 别名 s1…sN + 知识库内置工具；清单内容与别名映射都已发布）',
  )
  return catalog
}

/**
 * 绑了知识库时下发给容器的**内置工具**（`knowledge_search` / `list_knowledge` / `read_document`）。
 *
 * 形状直接取自 ChatBot 那几个工具的**同一份**定义（`chatContext.ts`），只是转成容器清单要的
 * `{name, description, inputSchema}` —— 两处各写一份就会漂移（`06` §六 第 ⑰ 条）。
 */
export function knowledgeBuiltinTools(): SandboxBuiltinToolRef[] {
  return [knowledgeListTool(), knowledgeSearchTool(), readDocumentTool()].map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    inputSchema: tool.function.parameters ?? { type: 'object', properties: {} },
  }))
}

/**
 * 「记忆」内置工具（`remember` + `recall_memory`）在容器清单里的描述符（P1-8/P1-8a）。
 *
 * 与 {@link knowledgeBuiltinTools} 同源（**同一份定义** `orchestrator/memoryTools.ts`），
 * 只是转成容器清单要的 `{name, description, inputSchema}` —— 执行仍走 `/api/sandbox/builtin/call`。
 */
export function memoryBuiltinDescriptors(): SandboxBuiltinToolRef[] {
  return [rememberTool(), recallMemoryTool()].map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    inputSchema: tool.function.parameters ?? { type: 'object', properties: {} },
  }))
}

/**
 * "**这个容器该用哪份清单**" —— 已发布过就**原样返回**，没发布过才算一份。
 *
 * ★ 这一条是"★ 唯一反查点"能成立的前提（`子方案③` §七 4）：
 * 容器侧注册的工具名是从**某一次**下发里来的，而后端的反查（卡片填 `serverId`、代理端点
 * 解 alias）必须用**同一份**表。两边各算一次就有"两次之间绑定/缓存变了 ⇒ alias 指向漂移"
 * 的窗口，症状是"卡片上的 server 名不对"，**不报错**。
 * ⇒ 规则一句话：**清单是"每个容器一份"的快照，谁先算谁发布，后来者只读。**
 * ⚠️ 已知边界（刻意如此）：容器活着期间改了 Agent 的 MCP 绑定 ⇒ 本会话**不生效**，
 *    新派活（新容器、回收时映射已被清掉）才生效。这与"容器即会话"是同一个取舍。
 */
export async function ensureSandboxMcpCatalog(
  conversationId: string,
  agentId: string,
): Promise<SandboxMcpCatalog> {
  const published = await readSandboxMcpCatalog(conversationId)
  if (published !== null) return published
  return buildSandboxMcpCatalog(conversationId, agentId)
}

// ───────────────────────────── 端点 ─────────────────────────────

/** `GET /api/sandbox/mcp/tools` 的响应（**不是**统一信封，见文件头） */
interface SandboxMcpToolsResponse {
  servers: { alias: string; id: string; name: string }[]
  tools: {
    /** 注册给引擎的名字（`mcp_<alias>_<tool>`）—— 调 `/call` 时用 `serverAlias` + `toolName` */
    name: string
    serverAlias: string
    /** MCP 侧原始工具名（`/call` 的体里要原样带回来） */
    toolName: string
    description: string
    /** 原样的 JSON Schema（容器侧据此给模型声明参数） */
    inputSchema: unknown
  }[]
  /**
   * 平台内置工具（知识库一族）。**没有就是空数组** —— 容器侧据此注册 `knowledge_search` /
   * `list_knowledge` / `read_document`，执行时走 {@link BUILTIN_CALL_PATH}（不是 `/mcp/call`）。
   */
  builtinTools: { name: string; description: string; inputSchema: unknown }[]
}

/** `POST /api/sandbox/mcp/call` 的响应（200 那一类，见文件头"分界线"） */
interface SandboxMcpCallResponse {
  /** 这次调用算不算失败（**工具跑了但自报失败** 也算 `true`） */
  isError: boolean
  /** 给模型与日志的文本（未执行时说的是"为什么没执行"） */
  text: string
}

/**
 * `/call` 的请求体（**不是**公开契约，是容器侧扩展与后端之间的内部协议）。
 *
 * ⚠️ **没有 `conversationId` / `userId` / `agentId`**：那三个从**令牌**解析（§七 6 ①）。
 * 请求体里带了也不看 —— 这正是"令牌 ⇒ 会话是唯一身份"的落地形态。
 * ⚠️ `arguments` 默认 `{}`：MCP 允许无参工具，而前端/模型都可能省略它。
 */
const sandboxMcpCallBodySchema = z.object({
  serverAlias: z.string().trim().min(1).max(32),
  toolName: z.string().min(1).max(256),
  arguments: z.record(z.unknown()).default({}),
})

/**
 * 内置工具调用的容器环境变量或路径（跨边界契约，与扩展侧 `BUILTIN_CALL_PATH` 逐字对应）。
 * 名字里没有 `conversationId` / `agentId`：身份从令牌解析（同 `/mcp/call`）。
 */
export const BUILTIN_CALL_PATH = '/api/sandbox/builtin/call'

/** `/api/sandbox/builtin/call` 的请求体（内部协议） */
const sandboxBuiltinCallBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  arguments: z.record(z.unknown()).default({}),
})

/**
 * 把两个端点挂到沙箱代理 listener 上（调用点是 `listener.ts#startSandboxListener`）。
 *
 * ⚠️ **只在这个 listener 上挂**（`02` §4.10）：公网 listener（`buildApp()`）上**没有**它们，
 * 于是"容器能摸到业务 API"这件事在结构上不成立，而不是靠 iptables。
 */
export function registerSandboxProxyRoutes(app: FastifyInstance): void {
  app.get('/api/sandbox/mcp/tools', async (request, reply) => {
    const auth = await authenticate(tokenFromHeader(request.headers))
    if (!auth.ok) return sendError(reply, 401, 'UNAUTHORIZED', auth.message)

    const catalog = await ensureSandboxMcpCatalog(auth.record.conversationId, auth.record.agentId)
    const payload: SandboxMcpToolsResponse = {
      servers: catalog.servers.map((server) => ({
        alias: server.alias,
        id: server.serverId,
        name: server.serverName,
      })),
      tools: Object.entries(catalog.tools).map(([name, ref]) => ({
        name,
        serverAlias: ref.alias,
        toolName: ref.toolName,
        description: ref.description,
        inputSchema: ref.inputSchema,
      })),
      builtinTools: catalog.builtins.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }
    getLogger().info(
      {
        conversationId: auth.record.conversationId,
        serverCount: payload.servers.length,
        toolCount: payload.tools.length,
        builtinToolCount: payload.builtinTools.length,
      },
      '容器已拉取工具清单（沙箱代理端点）',
    )
    return reply.send(payload)
  })

  app.post('/api/sandbox/mcp/call', async (request, reply) => {
    const auth = await authenticate(tokenFromHeader(request.headers))
    if (!auth.ok) return sendError(reply, 401, 'UNAUTHORIZED', auth.message)

    const parsed = sandboxMcpCallBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        `请求体不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
      )
    }
    const body = parsed.data

    // 清单必须已经下发过 —— 没下发过说明"这次调用不是从我们给的工具来的"
    const catalog = await readSandboxMcpCatalog(auth.record.conversationId)
    if (catalog === null) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        '沙箱工具清单不存在或已过期（容器可能已被回收）。请重新派活。',
      )
    }

    // ── ② 别名 → 工具（顺带回答"这个工具真的下发过吗"）──
    const toolRef = findOfferedTool(catalog, body.serverAlias, body.toolName)
    if (toolRef === undefined) {
      return sendError(
        reply,
        404,
        'NOT_FOUND',
        `工具 ${body.serverAlias}/${body.toolName} 不曾下发给本容器（清单里没有它）。`,
      )
    }

    // ── ③ 越权检查（§七 6 ②）──
    // 为什么清单已经是"按 agentId 算的"还要再查一次：清单是**容器建立时**的快照，
    // 而绑定可以在容器活着期间被改掉。不查的话，一个会话能拿旧清单去调**平台上任何** MCP server。
    const bound = await getPrisma().agentComponent.findFirst({
      where: { agentId: auth.record.agentId, componentType: 'MCP', refId: toolRef.serverId },
      select: { id: true },
    })
    if (bound === null) {
      getLogger().warn(
        {
          conversationId: auth.record.conversationId,
          agentId: auth.record.agentId,
          mcpServerId: toolRef.serverId,
          toolName: toolRef.toolName,
        },
        '沙箱请求调用一个**未绑定在本次 Agent 上**的 MCP server ⇒ 已拒绝（越权）',
      )
      return sendError(reply, 403, 'FORBIDDEN', '这个 MCP server 不属于当前智能体，已拒绝调用。')
    }

    const result = await callToolViaProxy({
      conversationId: auth.record.conversationId,
      userId: auth.record.userId,
      toolRef,
      args: body.arguments,
    })
    return reply.send(result)
  })

  /**
   * 平台**内置工具**调用（当前只有知识库：`knowledge_search` / `list_knowledge` / `read_document`）。
   *
   * 与 `/mcp/call` 分开一条路径的原因：内置工具**没有 MCP server / 凭据 / 危险确认**，
   * 执行体是 `orchestrator/knowledgeTools.ts` 的**同一个函数**（ChatBot 也用它）。
   * 塞进 `/mcp/call` 会让那条"别名 → server → 越权检查"的链路描述不了它。
   *
   * 三条判据与 `/mcp/call` 同族：认证（令牌 ⇒ 会话身份）→ **清单里真的下发过这个工具** →
   * 执行（库/文档全部在后端查，容器侧只有一个工具名与参数）。
   */
  app.post('/api/sandbox/builtin/call', async (request, reply) => {
    const auth = await authenticate(tokenFromHeader(request.headers))
    if (!auth.ok) return sendError(reply, 401, 'UNAUTHORIZED', auth.message)

    const parsed = sandboxBuiltinCallBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        `请求体不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
      )
    }
    const body = parsed.data

    const isNotify = body.name === SEND_NOTIFICATION_TOOL_NAME
    const isMemory = body.name === REMEMBER_TOOL_NAME || body.name === RECALL_MEMORY_TOOL_NAME
    // 只认内置工具（知识库一族 + 通知 + 记忆）；其他名字不是这条端点的职责
    if (!isKnowledgeToolName(body.name) && !isNotify && !isMemory) {
      return sendError(reply, 404, 'NOT_FOUND', `没有名为 ${body.name} 的内置工具。`)
    }

    const catalog = await readSandboxMcpCatalog(auth.record.conversationId)
    if (catalog === null) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        '沙箱工具清单不存在或已过期（容器可能已被回收）。请重新派活。',
      )
    }
    // 清单必须**确实下发过**这个内置工具（与 MCP 的 findOfferedTool 同一条判据）
    if (!catalog.builtins.some((tool) => tool.name === body.name)) {
      return sendError(reply, 404, 'NOT_FOUND', `内置工具 ${body.name} 不曾下发给本容器。`)
    }

    // 通知工具：执行体与 ChatBot 共用（`notify/index.ts`），渠道从本次运行的会话登记表取
    if (isNotify) {
      const outcome = await executeSendNotification({
        conversationId: auth.record.conversationId,
        arguments: JSON.stringify(body.arguments),
      })
      return reply.send({ isError: outcome.isError, text: outcome.output })
    }

    // 记忆工具（P1-8/P1-8a）：执行体与 ChatBot 共用（`orchestrator/memoryTools.ts`），主语 = 令牌里的 userId
    if (isMemory) {
      const outcome =
        body.name === RECALL_MEMORY_TOOL_NAME
          ? await executeRecallMemoryTool({
              userId: auth.record.userId,
              agentId: auth.record.agentId,
              arguments: JSON.stringify(body.arguments),
            })
          : await executeMemoryTool({
              userId: auth.record.userId,
              agentId: auth.record.agentId,
              conversationId: auth.record.conversationId,
              arguments: JSON.stringify(body.arguments),
            })
      return reply.send({ isError: outcome.isError, text: outcome.output })
    }

    // ★ 库**现查**（不从清单快照取）：绑定可以在容器活着期间被改掉；没有绑定就如实回"没有库"。
    const kbIds = await boundKnowledgeBaseIds(auth.record.agentId)
    if (kbIds.length === 0) {
      return reply.send({ isError: true, text: '（当前没有绑定任何知识库）' })
    }

    const outcome = await executeKnowledgeTool({
      kbIds,
      name: body.name,
      // 执行体收的是模型给的**原文**（JSON 串）；容器给的是对象 ⇒ 这里归一
      arguments: JSON.stringify(body.arguments),
      log: { conversationId: auth.record.conversationId, agentId: auth.record.agentId },
    })
    return reply.send({ isError: outcome.isError, text: outcome.output })
  })

  /**
   * 沙箱**按需下载产物**（`GET /api/sandbox/artifacts/:artifactId`，**TaskAgent 记忆与产物 块 2**）。
   *
   * 解决的是问题 1 的"缺容器侧下载通道"：容器重建后 `/work` 是空的，记忆文档里写着
   * "这个会话产出过哪些文件、ID 是什么"，agent 需要时用这条端点把它们**自己拉回 `/work`**
   * （命令见 `orchestrator/memoryDoc.ts#NODE_FETCH_DOWNLOAD_COMMAND`）。
   *
   * ★ 认证与归属：令牌 ⇒ 会话身份（与 `/mcp/call` 同一条），产物行的 `conversation_id` 必须等于
   *   令牌里的 `conversationId`（`openArtifactSourceForConversation` 的 `where` 一次判完）
   *   —— 容器**只能取回自己这个会话**产出的文件，取不到别人的、也取不到别的会话的。
   *
   * ⚠️ 响应头与公网 `/api/artifacts/:id/download` **逐字同款**（同一组头、同一个
   *   `buildContentDisposition`）—— 它走的也是"字节流 + 失败信封"的形态，容器侧 `fetch`
   *   按 `r.ok` 分支即可，不需要另一套解析。
   */
  app.get<{ Params: { artifactId: string } }>(
    '/api/sandbox/artifacts/:artifactId',
    async (request, reply) => {
      const auth = await authenticate(tokenFromHeader(request.headers))
      if (!auth.ok) return sendError(reply, 401, 'UNAUTHORIZED', auth.message)

      const parsedId = z.string().uuid().safeParse(request.params.artifactId)
      if (!parsedId.success) return sendError(reply, 400, 'VALIDATION', '产物 ID 不是合法 UUID')

      try {
        const source = await openArtifactSourceForConversation({
          artifactId: parsedId.data,
          conversationId: auth.record.conversationId,
        })
        getLogger().info(
          { conversationId: auth.record.conversationId, artifactId: parsedId.data },
          '沙箱按需下载产物（容器经代理令牌自证身份）',
        )
        return reply
          .header('content-type', artifactDownloadContentType(source.mime))
          .header('content-length', String(source.contentLength))
          .header('content-disposition', buildContentDisposition(source.fileName))
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'private, no-store')
          .send(source.body)
      } catch (error) {
        // 产物不存在 / 不属于这个会话 ⇒ 404（与 `/mcp/call` 的"4xx = 协议层拒绝"同族）。
        // 其余（S3 不可用等）照常向上抛，由 listener 的默认错误处理收口。
        if (error instanceof AppError) return sendError(reply, error.status, error.code, error.message)
        throw error
      }
    },
  )

  /**
   * 沙箱**按需下载用户上传的附件**（`GET /api/sandbox/attachments/:fileId`，**P1-4 修订**）。
   *
   * 解决的是"容器重建后 `/work/attachments/` 被清空、agent 再也读不到用户此前上传的文件"
   * （工作卷随容器走，附件本体在 S3 里一直在）。记忆文档里写着"这个会话收到过哪些附件、
   * ID 是什么"，agent 需要时用这条端点把它们**自己拉回 `/work`**（命令见
   * `orchestrator/memoryDoc.ts#NODE_FETCH_ATTACHMENT_COMMAND`）。
   *
   * ★ 认证与归属：令牌 ⇒ 会话身份（与 `/mcp/call`、`/api/sandbox/artifacts` 同一条）；
   *   `fileId` 必须真的出现在该会话的消息里、且 `files.uploader_id` = 令牌里的 `userId`
   *   （`openFileSourceForConversation` 把两问一次判完）—— 容器只能取回**自己这个会话**
   *   收到过的附件，取不到别人的、也取不到别的会话的。
   *
   * ⚠️ 响应头与 `/api/sandbox/artifacts` 逐字同款（字节流 + 失败信封），容器侧 `fetch`
   *   按 `r.ok` 分支即可。
   */
  app.get<{ Params: { fileId: string } }>(
    '/api/sandbox/attachments/:fileId',
    async (request, reply) => {
      const auth = await authenticate(tokenFromHeader(request.headers))
      if (!auth.ok) return sendError(reply, 401, 'UNAUTHORIZED', auth.message)

      const parsedId = z.string().uuid().safeParse(request.params.fileId)
      if (!parsedId.success) return sendError(reply, 400, 'VALIDATION', '附件 ID 不是合法 UUID')

      try {
        const source = await openFileSourceForConversation({
          fileId: parsedId.data,
          conversationId: auth.record.conversationId,
          uploaderId: auth.record.userId,
        })
        getLogger().info(
          { conversationId: auth.record.conversationId, fileId: parsedId.data },
          '沙箱按需下载附件（容器经代理令牌自证身份）',
        )
        return reply
          .header('content-type', source.contentType)
          .header('content-length', String(source.contentLength))
          .header('content-disposition', buildContentDisposition(source.fileName))
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'private, no-store')
          .send(source.body)
      } catch (error) {
        // 附件不存在 / 不属于这个会话 ⇒ 404（与产物下载同族：4xx = 协议层拒绝）。
        if (error instanceof AppError) return sendError(reply, error.status, error.code, error.message)
        throw error
      }
    },
  )
}

/** {@link callToolViaProxy} 的入参（把"验过的身份 + 解析出来的工具"合成一个对象） */
interface ProxyCallInput {
  conversationId: string
  /** 会话**发起者** —— `executeMcpToolCall` 拿它取凭据（A 的会话绝不用 B 的凭据） */
  userId: string
  toolRef: SandboxMcpToolRef
  args: Record<string, unknown>
}

/**
 * 真调一次（**危险判定 → 确认 → 执行 → 结果整形**），恒返回 200 那一类。
 *
 * 顺序只有一条硬约束：**判定与确认排在执行之前** —— 晚一步的后果是"工具已经发出去了才问用户"，
 * 而确认的全部意义就是"发出去之前问一句"（`chatBot.ts` 的同一条纪律）。
 */
async function callToolViaProxy(input: ProxyCallInput): Promise<SandboxMcpCallResponse> {
  const logger = getLogger()
  const { conversationId, userId, toolRef, args } = input

  // ★ §七 5：危险判定的**第二落点**。`02` §9.9 的判定原本只算在 `toOpenAiTools`
  //   （ChatBot 把 MCP 工具转成 LLM 工具时），而容器路径**不经过那一步**
  //   （pi 的工具是扩展注册的）⇒ 这里必须**独立判一次**。
  //   ⚠️ 用的是**同一个纯函数**（`mcp/risk.ts#isDangerousTool`）：不搬走、不另写一份，
  //      两处各自在自己的入口调。判决口径与 ChatBot 逐字一致（只有 `readOnlyHint === true`
  //      且未声明 `destructiveHint === true` 才安全）。
  const dangerous = isDangerousTool({ annotations: toolRef.annotations })

  const summary = summarizeToolInput(args)
  logger.info(
    {
      conversationId,
      mcpServerId: toolRef.serverId,
      toolName: toolRef.toolName,
      alias: toolRef.alias,
      dangerous,
      argKeys: Object.keys(args),
    },
    '沙箱代理收到一次 MCP 调用（凭据主语 = 会话发起者）',
  )

  if (dangerous) {
    // ★ 危险那一段按会话**串行**（见文件头："确认槽是单槽的"）
    return withConversationSerial(conversationId, () => runDangerousCall({ ...input, summary }))
  }
  return executeAndShape({ conversationId, userId, toolRef, args })
}

/** 危险调用：先跨请求问用户，再按结论决定执不执行 */
async function runDangerousCall(input: ProxyCallInput & { summary: string }): Promise<SandboxMcpCallResponse> {
  const logger = getLogger()
  const { conversationId, userId, toolRef, args, summary } = input

  const question: ConfirmQuestion = {
    // `source` 仍是 `PLATFORM` / `SERVER` 两值（`子方案③` §八 4：**刻意不加**第三个值）——
    // 沙箱代理发起的确认确实是"平台在强制确认一个危险工具"。
    source: 'PLATFORM',
    // 展示的是**原始工具名**（不是 `mcp_s1_xxx`）：这一行是给用户看的，
    // 而 `alias` 是我们内部的编号，对用户零信息量。
    toolName: toolRef.toolName,
    inputSummary: summary,
  }

  let outcome: Awaited<ReturnType<typeof askConversation>>
  try {
    outcome = await askConversation(conversationId, question)
  } catch (error) {
    // ⚠️ **中断照旧抛出**（`ChatStoppedError`）—— §八 6 ③ 定的口径：用户停止 / 断连 / 锁丢失是
    // "这一轮结束了"，不是"确认的结局"。本层把它翻成"未执行"回给引擎（§八 6 ③ 明写这一步属 9b）。
    // ⚠️ **不能并进 `REJECTED`**：把"这一轮没了"说成"用户点了取消"，模型会向用户复述一件没发生的事。
    if (error instanceof ChatStoppedError) {
      logger.info(
        { conversationId, toolName: toolRef.toolName, stopReason: error.reason },
        '确认期间本轮被中断 ⇒ 危险调用按"未执行"回给引擎',
      )
      return notExecuted('这一轮已被中断，该工具未执行。')
    }
    throw error
  }

  switch (outcome) {
    case 'CONFIRMED':
      return executeAndShape({ conversationId, userId, toolRef, args })
    case 'REJECTED':
      return notExecuted('用户取消了这次工具调用，未执行。')
    case 'TIMEOUT':
      // 超时是**正常结论**（`ConfirmDecision` 的注释），不是错误
      return notExecuted('等待用户确认超时，未执行。')
    case 'NO_CHANNEL':
      // ★ §八 2 的纪律 ②：查不到通道 ⇒ **按"无法确认 ⇒ 未执行"**，
      //   既不许静默放行、也不许当成功。文案说的是"我们没能问成"，不是"用户拒绝了"。
      logger.warn(
        { conversationId, toolName: toolRef.toolName },
        '本进程里没有该会话的活跃通道 ⇒ 危险调用按"未执行"回给引擎（安全默认拒绝）',
      )
      return notExecuted('当前无法向你确认（这条对话的流不在本实例上），该工具未执行。')
  }
}

/**
 * 真执行 + 把 P0-2 的异常翻成"模型读得懂的结论"。
 *
 * ⚠️ 三条刻意的处置：
 *   · **不传 `onElicit`**：服务端反向 elicitation 的应答方在我们这边会是一次**跨请求提问**，
 *     属 P1；而"声明了能力却答不出来"比"不声明"更难查（`mcp/client.ts` 判据 5）⇒ 本批不声明。
 *   · **不传 `signal`**：这一趟请求与那条 SSE 流的 `AbortSignal` 没有结构上的联系
 *     （它是另一条 HTTP 请求）。危险路径的"用户停止"由 `askConversation` 抛出覆盖；
 *     非危险路径**中途不可中断** —— 这是本批的已知边界，写在这里免得下一个人以为漏了。
 *   · **`NEED_CREDENTIAL` / 上游故障翻成 `isError: true` 的 200**（不是 4xx）：
 *     它们要变成模型能读到的一句人话（§七 7："与 ChatBot 同一族文案"），
 *     而 4xx 只会让模型看到"请求失败"。
 */
async function executeAndShape(input: {
  conversationId: string
  userId: string
  toolRef: SandboxMcpToolRef
  args: Record<string, unknown>
}): Promise<SandboxMcpCallResponse> {
  const logger = getLogger()
  const { conversationId, userId, toolRef, args } = input
  try {
    const execution = await executeMcpToolCall({
      serverId: toolRef.serverId,
      viewer: { userId },
      toolName: toolRef.toolName,
      args,
    })
    return { isError: execution.isError, text: execution.text }
  } catch (error) {
    // `McpAbortError` 在当前形态下**不可达**（没传 signal），但接住它比让一条莫名 500 更好：
    // 它表示"调用被中断"，而中断不是错误（`executeMcpToolCall` 的注释）。
    if (error instanceof McpAbortError) {
      return notExecuted('工具调用被中断，未执行。')
    }
    if (error instanceof AppError) {
      logger.warn(
        {
          conversationId,
          mcpServerId: toolRef.serverId,
          toolName: toolRef.toolName,
          code: error.code,
        },
        '沙箱代理调用 MCP 工具失败（按"工具失败"回给引擎，不是 HTTP 错误）',
      )
      // ⚠️ `message` 来自 `mcpCall.service.ts` 的**用户级文案**（"还缺 X-User-Token" /
      //    "上游超时"），本来就是写给用户看的 ⇒ 原样交给模型，不在这里重写（重写 = 两份文案漂移）。
      return { isError: true, text: error.message }
    }
    logger.error(
      { err: error, conversationId, mcpServerId: toolRef.serverId, toolName: toolRef.toolName },
      '沙箱代理调用 MCP 工具抛出非预期错误',
    )
    // `02` §十：非预期错误的细节只进日志，回给模型的是我们自己写的一句
    return { isError: true, text: '调用这个 MCP 工具时发生了内部错误，本次未完成。' }
  }
}

// ───────────────────────────── 危险调用串行化 ─────────────────────────────

/**
 * 每个会话一条"危险调用"的串行链（**进程内**，与活跃通道注册表同一条扩容前提：§九 3）。
 *
 * 值 = "排在我后面的那一次要等的东西"。`Map` 在队尾离去时删除自己（否则会长住每一个会话 id）。
 */
const dangerChains = new Map<string, Promise<void>>()

/** 把一次任务排到该会话的队尾（**只排危险那一段**，非危险调用不占队） */
async function withConversationSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = dangerChains.get(key) ?? Promise.resolve()
  let settle!: () => void
  const next = new Promise<void>((resolve) => {
    settle = resolve
  })
  dangerChains.set(key, next)
  try {
    // 前一个失败不该让后面的一起失败（它已经是"一份结论"了，`callToolViaProxy` 不会抛）
    await previous.catch(() => undefined)
    return await task()
  } finally {
    settle()
    // 队尾还是自己 ⇒ 没人排在我后面，删掉（否则 `Map` 会随会话数无限增长）
    if (dangerChains.get(key) === next) dangerChains.delete(key)
  }
}

// ───────────────────────────── 内部小工具 ─────────────────────────────

/** 一次调用里"从清单找工具"的唯一实现（`/call` 与将来的其它入口共用） */
function findOfferedTool(
  catalog: SandboxMcpCatalog,
  alias: string,
  toolName: string,
): SandboxMcpToolRef | undefined {
  return Object.values(catalog.tools).find((ref) => ref.alias === alias && ref.toolName === toolName)
}

/** 「没执行」的统一形态（**`isError: true`** —— 模型要能看出这次没干成） */
function notExecuted(text: string): SandboxMcpCallResponse {
  return { isError: true, text }
}

/**
 * 令牌校验（两件事合成一个结论）：**头在不在** + **Redis 认不认**。
 *
 * ⚠️ 失败路径**不区分**"没带令牌" / "令牌不认" / "已过期"（统一一句 401 文案）：
 * 对攻击者区分它们只会多给一个信息位；对排障，真正的线索在**后端日志**里
 * （`resolveSandboxToken` 的调用点与警告），而不是回给容器的这句话里。
 * ⚠️ Redis 抛错时**向上抛**（→ 500）：那说明"我们查不了"，与"令牌是错的"必须分得开
 * （见 `token.ts#resolveSandboxToken` 的注释）。
 */
async function authenticate(
  raw: string | undefined,
): Promise<{ ok: true; record: SandboxTokenRecord } | { ok: false; message: string }> {
  const record = await resolveSandboxToken(raw)
  if (record === undefined) {
    getLogger().warn(
      { hasToken: raw !== undefined && raw.trim() !== '' },
      '沙箱代理端点上收到一个无效令牌 ⇒ 401（分辨"没带"与"带了但不认"只为日志）',
    )
    return { ok: false, message: '沙箱代理令牌无效或已过期。' }
  }
  return { ok: true, record }
}

/** 统一的错误响应（**不套信封**，见文件头） */
function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } })
}

/**
 * 从请求头里取令牌。
 *
 * ⚠️ `request.headers[...]` 的类型是 `string | string[] | undefined`（**同名头出现多次时是数组**）
 * ⇒ 归一成"第一个值或 `undefined`"。刻意**不**把数组拼成一个串：那会凭空造出一个永远不认的
 * 令牌，而日志里看不出这件事是怎么发生的。
 */
function tokenFromHeader(headers: NodeJS.Dict<string | string[]>): string | undefined {
  const raw = headers[SANDBOX_TOKEN_HEADER]
  return Array.isArray(raw) ? raw[0] : raw
}
