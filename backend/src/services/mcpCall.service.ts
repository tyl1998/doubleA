/**
 * MCP 调用上下文（P0-2-7）
 *
 * 依据：`docs/06-实施计划.md` §四 P0-2-7（内容 / 验收门槛 1~4 / 坑预判 1~4）
 *      + `docs/02-后端设计.md` §9.3（调用时注入：有 ⇒ 解密注入；无 ⇒ `tool_call{ERROR:"需先配置凭据"}`）
 *      + `docs/02-后端设计.md` §9.5（凭据值的口径：AAD / 解不开就降级 / `configured` 按模板逐 key 判）
 *      + `01` §3.6 的验收要点（**A 用户会话绝不使用 B 用户凭据**）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件只做一件事：把"**谁（userId）× 哪台 server**"翻译成"**一次调用需要的一切**"
 * ─────────────────────────────────────────────────────────────────────
 * 产物是一份 {@link McpCallContext}：现成的 {@link McpClientOptions}（URL / 注入中间件 /
 * 脱敏 secrets / 日志字段都装好了）+ "注入了哪些 key"的**键名**回执。
 * 消费方是 **P0-2-8** 的编排循环（`chatBot.ts`）—— 它拿到 `routes` 里的 `serverId` 之后
 * 就调这里，然后 `new McpClient(ctx.clientOptions)`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 凭据的**主语是 `userId`**，而且这个 userId 只来自会话（验收门槛 1 的全部内容）
 * ─────────────────────────────────────────────────────────────────────
 * "A 用户绝不串 B 用户 token"这件事在本文件里是**结构性成立**的，不靠任何一次判断：
 *   · 唯一的入口是 `viewer.userId`，而它由编排层从**当前会话**取（不是从请求体、不是从路径）；
 *   · 底层查询 `where: { serverId_userId: { serverId, userId } }`（P0-2-4 的收窄，本文件不越过它）；
 *   · 解密用的 AAD 里含 `userId` ⇒ 即便有人把 B 的密文粘到 A 的行上，**也解不开**
 *     （`mcpCredentialAad`，`shared`/`02` §9.5 ①）—— 解密失败按"没值"处理 ⇒ 走到 ② 的那条路上。
 * 也就是说：这条不变式有**两道**独立防线（查询范围 + 密文绑定），
 * 而"两道都失效"需要同时改两处公式 —— 那件事在代码里看得见（`mcpCredentialAad` 是唯一实现）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 未配齐 ⇒ **一个上游请求都不发**（验收门槛 3 / 坑预判 4）
 * ─────────────────────────────────────────────────────────────────────
 * 判据是 `shared#missingRequiredCredentialKeys`（**按当前模板**逐个 `required` 检查），
 * **不是**"表里有没有行"（P0-2-4 坑预判 2 的同一条口径：注册者后加了必填项时，老用户的行还在）。
 * 缺任何一个 ⇒ 抛 `NEED_CREDENTIAL`(424)，**在 `new McpClient()` 之前**。
 * 为什么"本地就拒"而不是"等上游 401"（坑预判 4）：
 *   · 省一次上游往返；
 *   · 更关键的是**文案能指向具体 key**（"还缺 X-User-Token"），而上游的 401 只会说"未授权"——
 *     用户在那句话里读不出"我该去哪儿填什么"。
 * 解密失败（主密钥换过 / 密文粘错行）**刻意走同一条路**（坑预判 3）：它在 `values` 里没有值
 * ⇒ 若那个 key 是必填的，结论就是"需配置"，用户重新填一次即自愈。**绝不 500**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ `secrets` 给的是**全部解密出来的明文**，不是"真的注入出去的那几个"
 * ─────────────────────────────────────────────────────────────────────
 * 它唯一的用途是 `mcp/errors.ts` 把**上游回显**里的凭据抹掉（上游 401 常常把收到的
 * `Authorization` 原样回显）。既然目的是"绝不让凭据进日志/错误消息"，那么**多抹一点是安全的、
 * 少抹一点是不可逆的** ⇒ 一律把手上所有明文都交给它（`redactSecret` 自己会跳过过短的串，
 * 不会把正常文本误伤成大段 `***`）。
 * ⚠️ 被跳过的参数（`mcp/inject.ts` 文件头 ④：保留头名等历史数据）**也在**这个数组里 ——
 * 它们同样不该出现在任何出口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 与 `06` 的一处签名偏离（落地时定案，**不是优化**）
 * ─────────────────────────────────────────────────────────────────────
 * `06` 写的是 `resolveMcpCallContext(server, userId)`（传一个 server 行）。
 * 落地改成 `(serverId, viewer)`：唯一的消费方（P0-2-8 的编排循环）手上**只有 `serverId`**
 * —— 它来自 `mcp/toolSchema.ts` 的 `routes`（"名字 → `{toolName, serverId}`"，那里刻意不存 slug）。
 * 传行进去的话，每个调用点都得自己再写一次 `findUnique` + 五个 `select` 字段（漏一个就
 * 变成"注入时模板是空的"这种静默 bug）。⇒ 收在这里查一次，顺带把"server 已被删除"翻成 404。
 * 第二参用 `viewer` 而不是裸 `userId`，与 `mcpCredential.service.ts` / `mcpServer.service.ts` 同形。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑤ 本文件在 P0-2-8 长出两个新出口，分工是"**列表** vs **执行**"
 * ─────────────────────────────────────────────────────────────────────
 * 工具循环（`chatBot.ts`）需要两样东西，而它们**必须分开**（合成一个函数是最容易犯的错）：
 *   · {@link resolveMcpToolCatalog} —— **组装工具表**：读 `tool_cache` 列（**不联网**、**不碰凭据**）
 *     + `toolSchema.ts#toOpenAiTools` 做名字去重与截断。每一次对话开头都要调。
 *   · {@link executeMcpToolCall} —— **真的点一次工具**：这时才需要凭据（{@link resolveMcpCallContext}）
 *     + 连接 + `tools/call` + 关闭。只有模型真的要求调用时才调。
 * 分开的收益正是 `02` §9.3 那条："没配凭据"**不在列表阶段暴露** —— 否则用户一进对话页就会看到
 * 一堆"缺凭据"的报错，而他可能根本没打算用那台 server。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑥ 工具表的**顺序**是正确性的一部分（`06` P0-2-6 坑预判 3 的接回点）
 * ─────────────────────────────────────────────────────────────────────
 * `slug` 刻意不唯一、纯中文名会整串折成 `server` ⇒ **不同 server 的工具名天然会撞**，
 * 跨 server 的唯一性只能靠"依次把前面已占用的名字喂给 `toOpenAiTools`"。
 * 于是"处理顺序"必须**确定**且**只有一处** ⇒ {@link resolveMcpToolCatalog} 自己按
 * `(name, id)` 升序排（调用方只给一个集合，顺序不参与接口）。把这条约束留给调用方
 * 等于把它变成一个提醒，而"提醒"在第三次改代码时就不见了。
 */

import {
  AppError,
  missingRequiredCredentialKeys,
  normalizeCredentialSchema,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { McpClient, type McpClientOptions } from '../mcp/client.js'
import {
  buildCredentialInjection,
  createCredentialFetch,
  injectedKeyCount,
  type InjectedCredentialKeys,
  type SkippedCredentialKey,
} from '../mcp/inject.js'
import { parseToolCache } from '../mcp/toolCache.js'
import { toOpenAiTools, type McpToolRoute, type OpenAiFunctionTool } from '../mcp/toolSchema.js'
import { decryptMyCredentialValues } from './mcpCredential.service.js'

/**
 * 调用者。⚠️ 收窄**只有**这一条（见文件头 ①）：`userId` 就是全部权限信息，
 * 且它必须来自**当前会话**（编排层负责），不是请求体里的任何东西。
 */
export interface McpCallViewer {
  userId: string
}

/**
 * 一次 MCP 工具调用需要的一切。
 *
 * ⚠️ 它**不含明文凭据**（明文只活在 `clientOptions.secrets` 里，而那个字段的注释写着
 * "只用于错误消息脱敏，绝不进日志"）；`injected` / `skipped` 里**只有键名**。
 * 于是这份上下文可以安全地被上层用于日志 / 工具卡片（例如"已注入 2 个凭据"）。
 */
export interface McpCallContext {
  serverId: string
  /** 展示名（工具卡片显示它，不是 slug —— 同 P0-2-6 的可读性口径） */
  serverName: string
  /** 工具名前缀用的派生名（P0-2-6 产出的 `mcp_{slug}_{tool}` 里的那一段） */
  serverSlug: string
  /**
   * 直接交给 `new McpClient(ctx.clientOptions)`（或 `connectMcpClient`）。
   *
   * ⚠️ 里面已经装好了：端点 URL、**注入中间件**（`fetch`）、**脱敏明文**（`secrets`）、
   * 日志字段（serverId / userId）。调用点**不要再自己传 `secrets` 或 `fetch`** ——
   * 覆盖掉 `secrets` 的后果是"错误消息里带着别人的令牌"。
   */
  clientOptions: McpClientOptions
  /** 本次真的注入了哪些参数（按位置；直接就是注入模块的 `applied`，不做二次投影） */
  injected: InjectedCredentialKeys
  /** 被主动跳过的参数（模板层本该拦掉的历史数据）—— 正常应为空 */
  skipped: SkippedCredentialKey[]
}

/** 调一次要用到的 server 列（用不到的列一律不读） */
const CALL_SERVER_SELECT = {
  id: true,
  name: true,
  slug: true,
  endpointUrl: true,
  credentialSchema: true,
} as const

/**
 * 组装一次 MCP 调用的上下文（见文件头 ①~④）。
 *
 * 顺序**就是**正确性（三步都不能换位）：
 *   ① 查 server（不存在 ⇒ 404 —— 它可能已被删除，而 Agent 的绑定会留在那儿）；
 *   ② 查凭据 + 解密（**解不开的按"没值"**）；
 *   ③ **必填项缺任意一个 ⇒ 424，且此时一个字节都没往上发**；
 *   ④ 才算注入计划、装中间件。
 *
 * @throws {AppError} `NOT_FOUND`(404) server 不存在 / `NEED_CREDENTIAL`(424) 必填凭据未配齐
 */
export async function resolveMcpCallContext(
  serverId: string,
  viewer: McpCallViewer,
): Promise<McpCallContext> {
  const db = getPrisma()

  // ① server 本身
  const server = await db.mcpServer.findUnique({ where: { id: serverId }, select: CALL_SERVER_SELECT })
  if (server === null) {
    // ⚠️ 404 而不 500：这是"Agent 还绑着一台已经删掉的 server"的正常中间态
    //    （P0-2-2 定案：删 server 不去清 Agent 的绑定），不是平台故障
    throw AppError.notFound('MCP server 不存在（可能已被删除）')
  }

  // ② 我的凭据（主语 = `viewer.userId`，文件头 ①）
  const schema = normalizeCredentialSchema(server.credentialSchema)
  const { values, brokenKeys } = await decryptMyCredentialValues(server.id, viewer.userId)
  const presentKeys = Object.keys(values)

  // ③ 必填齐不齐 —— **在上游请求之前**（文件头 ②）
  const missingKeys = missingRequiredCredentialKeys(schema, presentKeys)
  if (missingKeys.length > 0) {
    // ⚠️ 只记**键名**与条数：这条日志会与"谁在调哪台 server"一起进日志，值一个字都不许进来
    getLogger().warn(
      {
        mcpServerId: server.id,
        userId: viewer.userId,
        missingKeys,
        brokenKeys,
        presentKeyCount: presentKeys.length,
      },
      'MCP 凭据未配齐 ⇒ 已在上游请求之前拦下（缺必填项；解不开的 key 已按「没值」计入）',
    )
    throw AppError.needCredential(
      `调用「${server.name}」的工具需要先配置凭据（还缺：${missingKeys.join('、')}）。` +
        '请到「我的凭据」页填写后重试。',
      { serverId: server.id, serverName: server.name, missingKeys },
    )
  }

  // ④ 注入计划 + 中间件
  const injection = buildCredentialInjection(schema, values)
  if (injection.skipped.length > 0) {
    // 正常情况下**永远是空的**（模板层已拦）⇒ 一旦有，说明库里存着不合法的 key
    // （P0-2-3 落地之前存的、或手工改库），值得一条 warn 让人去修模板
    getLogger().warn(
      {
        mcpServerId: server.id,
        userId: viewer.userId,
        skippedKeys: injection.skipped.map((item) => item.key),
        reasons: [...new Set(injection.skipped.map((item) => item.reason))],
      },
      'MCP 凭据参数被跳过（模板层本该拦下的历史数据）⇒ 该参数本次不会生效',
    )
  }

  const context: McpCallContext = {
    serverId: server.id,
    serverName: server.name,
    serverSlug: server.slug,
    clientOptions: {
      name: server.name,
      url: server.endpointUrl,
      // ⚠️ 空注入时 `createCredentialFetch` 原样返回全局 fetch（不多套一层、不改 URL）
      fetch: createCredentialFetch(injection),
      // 全部解密出来的明文（见文件头 ③：多抹是安全侧）
      secrets: Object.values(values),
      logFields: { mcpServerId: server.id, userId: viewer.userId },
    },
    injected: injection.applied,
    skipped: injection.skipped,
  }

  getLogger().debug(
    {
      mcpServerId: server.id,
      userId: viewer.userId,
      injectedKeyCount: injectedKeyCount(injection),
      // ⚠️ 只有键名（`applied` 的形状就是 `{HEADER:[],QUERY:[],BODY:[]}`），没有值
      injectedKeys: injection.applied,
      templateKeyCount: schema.length,
    },
    '已组装 MCP 调用上下文（凭据已注入：HEADER / QUERY / BODY 三处共 N 个参数）',
  )

  return context
}

// ═════════════════════════════════════════════════════════════════════
// 组装工具表（文件头 ⑤ 的前一半；**不联网、不碰凭据**）
// ═════════════════════════════════════════════════════════════════════

/** 目录里的一台 server —— 只为**展示与日志**（工具卡片显示 `name`，日志用 `id`） */
export interface McpCatalogServer {
  id: string
  name: string
  /** 这次**真的下发给模型**的工具数（`truncated` 非 null 时会小于 `total`） */
  toolCount: number
  /** 被 `MCP_TOOL_LIMIT` 截断时的实况；没截断是 `null` */
  truncated: { total: number; kept: number } | null
}

/** 本轮能下发给模型的全部 MCP 工具（`chatBot.ts` 的消费形态） */
export interface McpToolCatalog {
  /** 直接进 `ChatOptions.tools`（OpenAI 形态）；**空数组 = 一个工具都没有** */
  tools: OpenAiFunctionTool[]
  /**
   * 模型回的工具名 → "要调哪台 server 的哪个工具"。
   * ⚠️ 它是唯一的映射来源（`toolSchema.ts` 的口径 4）：**绝不从名字里 split 出 server**。
   */
  routes: Record<string, McpToolRoute>
  /** 参与的 server，顺序 = 名字分配的顺序（见文件头 ⑥） */
  servers: McpCatalogServer[]
}

/** 组装目录要用到的列（`slug` 只用于拼名字，不进 `routes` —— 见 `toolSchema.ts`） */
const CATALOG_SERVER_SELECT = { id: true, name: true, slug: true, toolCache: true } as const

/**
 * "Agent 绑了哪几台 MCP server" → "这一轮能下发给模型的工具表"。
 *
 * 工具**只从 `tool_cache` 列读**（不联网）：
 *   · 聊天路径上多一次上游往返是不可接受的（`tools/list` 可能几秒）；
 *   · 而 `tools/list` 本来就不带用户凭据（P0-2-5 定案 ⇒ 缓存是**全员共享**的那一份）⇒
 *     它不依赖"谁在问"，读缓存不会串用户。
 * 缓存空（从没成功拉过 / 被失效清掉）的 server **只记账 + 打一条 warn**，不影响别的 server ——
 * 一台没拉过工具的 server 不该让其他 server 的工具也下发不了。
 *
 * @param serverIds Agent 绑定的 server id（**集合语义**：顺序不参与结果，见文件头 ⑥；重复值会去重）
 */
export async function resolveMcpToolCatalog(serverIds: readonly string[]): Promise<McpToolCatalog> {
  const unique = [...new Set(serverIds)]
  if (unique.length === 0) return { tools: [], routes: {}, servers: [] }

  const logger = getLogger()
  const db = getPrisma()
  const rows = await db.mcpServer.findMany({ where: { id: { in: unique } }, select: CATALOG_SERVER_SELECT })

  // 绑定里有查不到的 server：`DELETE` 那一侧有 409 拦着（P0-2-2）⇒ 走到这里说明数据异常
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((row) => row.id))
    logger.warn(
      { conversationMissingServerIds: unique.filter((id) => !found.has(id)) },
      'Agent 绑定里有查不到的 MCP server（绑定未被清理）⇒ 这些 server 的工具本轮不会下发',
    )
  }

  // ⚠️ 名字分配的顺序源（文件头 ⑥）：`(name, id)` 升序 —— `name` 不是唯一列，故用 `id` 兜底
  const ordered = [...rows].sort((a, b) =>
    a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name),
  )

  const tools: OpenAiFunctionTool[] = []
  const routes: Record<string, McpToolRoute> = {}
  const servers: McpCatalogServer[] = []
  /** 已被占用的下发给模型的名字（跨 server，**逐台累积** —— 见文件头 ⑥） */
  const taken = new Set<string>()

  for (const row of ordered) {
    const cache = parseToolCache(row.toolCache)
    if (cache === null) {
      // "从没成功拉过"与"缓存已被失效清掉"在这里是同一件事：手上一份工具都没有
      logger.warn(
        { mcpServerId: row.id, name: row.name },
        'MCP server 没有可用的工具缓存 ⇒ 本轮它一个工具都不会下发（去 /api/mcp/servers/:id/tools?refresh=1 或点「测试」拉一次）',
      )
      servers.push({ id: row.id, name: row.name, toolCount: 0, truncated: null })
      continue
    }

    const conversion = toOpenAiTools({ id: row.id, slug: row.slug }, cache.tools, config.mcp.toolLimit, taken)
    for (const name of Object.keys(conversion.routes)) taken.add(name)
    tools.push(...conversion.tools)
    // 名字恒以 `mcp_` 开头 ⇒ 不会撞上 `Object.prototype` 的键，普通对象当映射表是安全的
    Object.assign(routes, conversion.routes)

    if (conversion.truncated !== null) {
      // `06` P0-2-6 的验收原文是"超过 MCP_TOOL_LIMIT **截断并告警**"，告警落点就在这里
      logger.warn(
        { mcpServerId: row.id, name: row.name, ...conversion.truncated, limit: config.mcp.toolLimit },
        'MCP 工具数超过 MCP_TOOL_LIMIT，已截断（被截掉的工具模型永远看不到，界面也只能靠这条日志发现）',
      )
    }
    servers.push({
      id: row.id,
      name: row.name,
      toolCount: conversion.tools.length,
      truncated: conversion.truncated,
    })
  }

  logger.debug(
    {
      serverCount: servers.length,
      toolCount: tools.length,
      servers: servers.map((server) => ({ id: server.id, name: server.name, toolCount: server.toolCount })),
    },
    '已组装本轮 MCP 工具目录（读 tool_cache，未联网）',
  )

  return { tools, routes, servers }
}

// ═════════════════════════════════════════════════════════════════════
// 执行一次工具调用（文件头 ⑤ 的后一半；**这时才需要凭据**）
// ═════════════════════════════════════════════════════════════════════

/** {@link executeMcpToolCall} 的入参 */
export interface McpToolCallInput {
  serverId: string
  viewer: McpCallViewer
  /** MCP 侧的**原始**工具名（`routes` 给的那个；不是下发给模型的 `mcp_{slug}_{tool}`） */
  toolName: string
  /** 已解析的参数。⚠️ 解析属**编排层**：它要为"参数不是合法 JSON"给出一个结论（见 P0-2-8 门槛 2） */
  args: Record<string, unknown>
  /** 用户的「停止」 */
  signal?: AbortSignal
}

/**
 * {@link executeMcpToolCall} 的产出。
 *
 * ⚠️ **不含任何凭据**（凭据只在 `clientOptions.secrets` 里，且那个字段的用途只有脱敏）；
 * `text` 是**原样全量** —— 截断由调用方做（`06` P0-2-8 坑预判 3：给模型的与给卡片看的必须
 * 是**同一份**，所以只能在一个地方截）。
 */
export interface McpToolExecution {
  /** 展示名（工具卡片显示"工具来自哪个系统"） */
  serverName: string
  /** 服务端明确表示这次调用**失败**（`isError:true`）—— 传输是成功的，见 `McpToolResult` 的三分法 */
  isError: boolean
  /** 文本块拼接（给模型与日志的唯一可读形态）；可能很大 */
  text: string
}

/**
 * 真的点一次工具：**组装上下文（凭据）→ 连接 → `tools/call` → 关掉**。
 *
 * ⚠️ **一次调用一个新 client、用完就关**（P0-2-8 的取舍）：
 *   · 复用会话要维护"哪个 serverId 的会话还活着"这张会过期的表，而**QUERY 注入把参数拼在
 *     *每个请求*的 URL 上**（P0-2-7 的探针结论）⇒ 复用并不省下什么；
 *   · 一轮对话里的工具调用是**个位数**次，握手成本可接受。
 *   接回点：真要连接池，键必须是 **`(serverId, userId)`** —— 凭据按用户注入，
 *   按 serverId 复用会让 A 的调用带着 B 的凭据（`02` §9.3 的不变式）。
 *
 * ⚠️ 用 `new McpClient(...)` + `try/finally` 而**不**用 `connectMcpClient(...)`：
 * 后者在 `connect()` 抛错时不会返回客户端，于是那次失败**没有机会 `close()`**
 * （`mcpServer.service.ts#probeServer` 是同款写法）。
 *
 * @throws {AppError} `NOT_FOUND`(404) server 不存在 / `NEED_CREDENTIAL`(424) 凭据没配齐 /
 *   `UPSTREAM_ERROR`(502)、`UPSTREAM_TIMEOUT`(504) —— 这三类是"**我们没调到它**"，
 *   与 `isError:true`（"工具说它没干成"）是两回事，调用方的处置也不同（`McpToolResult` 的表格）
 * @throws {McpAbortError} 用户点了停止（**不是**错误，那条流要以 `STOPPED` 收尾）
 */
export async function executeMcpToolCall(input: McpToolCallInput): Promise<McpToolExecution> {
  // 凭据的**全部**判据都在这里面：含"未配齐 ⇒ 在 new McpClient() 之前就抛 424"
  const context = await resolveMcpCallContext(input.serverId, input.viewer)
  const client = new McpClient(context.clientOptions)
  try {
    await client.connect()
    const result = await client.callTool(
      input.toolName,
      input.args,
      input.signal === undefined ? {} : { signal: input.signal },
    )
    return { serverName: context.serverName, isError: result.isError, text: result.text }
  } finally {
    // `close()` 自己吞错并 warn（先 DELETE 终止会话、再关传输）⇒ 放 `finally` 不会
    // 把一次**成功**的调用变成 500，也不会盖掉上面抛出来的真错误
    await client.close()
  }
}
