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
 */

import {
  AppError,
  missingRequiredCredentialKeys,
  normalizeCredentialSchema,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import type { McpClientOptions } from '../mcp/client.js'
import {
  buildCredentialInjection,
  createCredentialFetch,
  injectedKeyCount,
  type InjectedCredentialKeys,
  type SkippedCredentialKey,
} from '../mcp/inject.js'
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
