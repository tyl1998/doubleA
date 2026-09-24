/**
 * MCP server 服务（P0-2-2；P0-2-3 加"模板变更的影响"）
 *
 * 依据：`docs/02-后端设计.md` §4.7（六条路由）+ §三（`mcp_servers` 表）+ §九（注册者定义模板）
 *      + `docs/06-实施计划.md` §四 P0-2-2（内容 / 验收门槛 1~5 / 坑预判 1~4）
 *        与 P0-2-3（凭据模板的深度校验 / `credentialSchemaImpact` / 坑预判 2）
 *        与 §4.2、§4.3
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的**六条口径**（每条都对应一条验收门槛或坑预判）
 * ─────────────────────────────────────────────────────────────────────
 * **① 权限是"登录即可"，且**没有 owner 列收窄**（`06` §4.2 第五族 / 验收门槛 1）。**
 *    `created_by` 只作**留痕**：它出现在响应里（前端能显示"谁注册的"），但**不参与任何判定** ——
 *    没有"只有创建者能改"这一说。所以本文件里**一个权限判断都没有**，删/改别人建的 server
 *    是**刻意允许**的（与 Agent 第三族相反）。验收里有一条反向守卫专门盯这件事。
 *
 * **② 注册**不强制连通**（坑预判 2 / 验收门槛 4）。**
 *    `01` §3.6 的验收要点写着"注册时连通测试"，但把它做成**注册前置**是错的：
 *    · 上游临时抖动会变成"建不了 server"，而用户没有别的入口；
 *    · "这次测试用谁的凭据"无解 —— 凭据是**每用户每 server 一份**（P0-2-4），刚注册时谁都没有。
 *    ⇒ 定案：**注册成功 + 响应带一次 best-effort 探测结果**（`mcpServerCreateResultSchema`），
 *    正式入口是 `POST /:id/test`。探测失败**只影响 `status`**，一个字都不影响注册结果。
 *
 * **③ 改注册信息必须让工具缓存失效（坑预判 3），但"改名字"不清缓存。**
 *    `endpoint_url` / `auth_type` / `credential_schema` 任一变了 ⇒ `tool_cache` 清空 +
 *    `status` 回 `UNKNOWN`。漏了的症状是"改了 endpoint，工具列表还是旧 server 的" —— **纯静默**
 *    （界面上那个数字看着完全正常，只有真的去调用才发现调的是老地址）。
 *    反过来，`name` 不参与连通 ⇒ 改名**不清缓存**（清了只会让用户白等一次重拉）。
 *
 * **④ 测试连通恒 200，且失败**不动 `tool_cache`**（`06` §4.3 / 验收门槛 2）。**
 *    见 `shared#mcpServerTestResultSchema` 的注释（探活端点自身是"请求成功"）。
 *    失败时只改 `status=ERROR`：上游抖一下不该毁掉上一次成功拉到的工具列表 ——
 *    那是"用户明明能用（缓存里的工具还在）却被我们清空了"的最坏形态。
 *
 * **⑤ 本层刻意**不带用户凭据**（P0-2-5 坑预判 1 定案）。**
 *    `tools/list` 用"注册者视角"（无凭据）。有些 MCP server 的 `tools/list` 也要求鉴权，
 *    本方案下拉不到 —— 那时 `POST /:id/test` 会**如实报出**（`ok:false` + 可读原因），
 *    而**不许**"顺手带上某个人的凭据"（那会造出"工具列表依赖谁先点过测试"的诡异状态）。
 *    这也意味着 `tool_cache` 是**每个 server 一份、全员共享**的，与用户无关。
 *
 * **⑥ 改模板时**只提示、绝不自动清理**已存的凭据（P0-2-3 坑预判 2 / 门槛 3）。**
 *    `credentialSchema` 变更后，响应里带回 `credentialSchemaImpact`（增/删/换注入位置三类 key 级的
 *    差异）；本服务**一个字的凭据都不碰**（表属 P0-2-4）—— 因为"用户临时改错模板"⇒ 值被清掉是
 *    **不可逆**的，而他什么都没做。⚠️ 这与"缓存该不该清"是**两个判据**：缓存用 `sameJson`
 *    判"模板整体变没变"（连 `label` 改了也清），impact 用 `diffCredentialSchema` 判
 *    "**已存凭据会受什么影响**"（只有 key 级的三种改动才算）。
 */

import {
  AppError,
  credentialSchemaImpactOf,
  diffCredentialSchema,
  normalizeCredentialSchema,
  slugifyServerName,
  uniqueSlug,
  type CreateMcpServerBody,
  type ListMcpServersQuery,
  type McpAuthType,
  type McpServerCreateResult,
  type McpServerItem,
  type McpServerTestResult,
  type McpServerToolsResult,
  type OffsetPage,
  type RemoveMcpServerResult,
  type UpdateMcpServerBody,
  type UpdateMcpServerResult,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma, Prisma } from '../infra/prisma.js'
import { McpClient } from '../mcp/client.js'
import { buildToolCache, parseToolCache, toolCountOf } from '../mcp/toolCache.js'

/** 调用者（只用到 id：本资源没有 owner 收窄，`created_by` 只是留痕，见文件头 ①） */
export interface McpViewer {
  userId: string
}

/**
 * 查询字段白名单（列表 / 建 / 改 / 测试共用一份）。
 * ⚠️ `oauthConfig` **不在**这里：它是 P1 的字段，且**不进任何响应契约**
 * （下发一个恒为 `NULL` 的字段只会诱使前端写永远走不到的分支）。
 */
const MCP_SERVER_SELECT = {
  id: true,
  name: true,
  slug: true,
  endpointUrl: true,
  authType: true,
  credentialSchema: true,
  toolCache: true,
  status: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

type McpServerRow = {
  id: string
  name: string
  slug: string
  endpointUrl: string
  authType: McpAuthType
  credentialSchema: unknown
  toolCache: unknown
  status: 'UNKNOWN' | 'OK' | 'ERROR'
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

// ═════════════════════════════════════════════════════════════════════
// 投影与小工具
// ═════════════════════════════════════════════════════════════════════

function toItem(row: McpServerRow): McpServerItem {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    endpointUrl: row.endpointUrl,
    authType: row.authType,
    // ⚠️ 唯一入口：库里可能是 `null`、不是数组、或数组里混着坏条目（见 shared 的注释）
    credentialSchema: normalizeCredentialSchema(row.credentialSchema),
    toolCount: toolCountOf(row.toolCache),
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * jsonb 列的写入值。
 *
 * ⚠️ 需要一次显式断言：`McpToolDescriptor` 的 `inputSchema` 是 `unknown`、`annotations` 是
 * `Record<string, unknown>`（它们**真的**是任意 JSON —— 工具自己声明的 schema），
 * 而 Prisma 的 `InputJsonValue` 要求"具体可序列化的形状"。
 * 断言安全：值的**唯一来源是上游 HTTP 响应体**（本来就是 JSON），且会被驱动原样序列化 ——
 * 不存在"把函数 / 循环引用写进 jsonb"的可能。
 */
function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

/**
 * 键序无关的深比较。
 *
 * 为什么不能直接 `JSON.stringify(a) !== JSON.stringify(b)`：**`jsonb` 经 PG 往返会重排键**
 * （PG 按"键长度 + 字典序"重排），于是"提交了和库里一模一样的模板"也会被判成"变了" ⇒
 * 每次保存都白清一次缓存（用户看到工具数莫名归零）。这是 P0-1-27 `canonicalJson` 的手法的
 * 服务层版本 —— 那边是"比出假红"，这边是"比出假阳性"。
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameJson(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]),
    )
  }
  return false
}

/**
 * `auth_type` 的**能力边界**（`06` §4.0 口径 1："接口留位、能力不做"）。
 *
 * 列与取值域先建出来（P1 免得改表），但**P0 只接受 `NONE`**：收到 `OAUTH` 就是 400，
 * 且文案**指向 P1**（用户能理解"功能还没上线"，而不是甩一句"参数不合法"）。
 * 理由与 P0-1-23 拒绝 `MCP` 绑定同源：**不要"先收下、等以后有实现再收拾"** ——
 * 存下一个 `OAUTH` 的 server 却发现没有授权端点，用户会以为它能用，
 * 真故障推迟到"调用时 401"才显形，而那时没人会联想到"注册时存错了"。
 */
function assertAuthTypeSupported(authType: McpAuthType | undefined): void {
  if (authType === 'OAUTH') {
    throw AppError.validation(
      'OAuth 2.1 授权登录属 P1（本阶段只支持 authType=NONE + 每用户凭据注入）：' +
        '请改用 NONE 并在「我的凭据」里为每个使用者填各自的令牌',
    )
  }
}

/**
 * 从 `name` 派生一个本库尚未使用的 `slug`（best-effort，见 `uniqueSlug` 的注释）。
 * 查 `startsWith` 会顺带捞到 `base-x` 这类邻居，那没关系 —— 只要"生成的不在集合里"就够了。
 */
async function nextSlug(name: string): Promise<string> {
  const db = getPrisma()
  const base = slugifyServerName(name)
  const rows = await db.mcpServer.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  })
  return uniqueSlug(
    base,
    rows.map((row) => row.slug),
  )
}

// ═════════════════════════════════════════════════════════════════════
// 连通测试（唯一的"联网"入口）
// ═════════════════════════════════════════════════════════════════════

/**
 * 连一次上游、拉一次 `tools/list`，**永不抛错**（除编程错误）。
 *
 * 这里刻意**不传 `headers`**（= 不带任何凭据，见文件头 ⑤）：`tools/list` 是"注册者视角"，
 * 与调用它的人无关。`McpClient` 的 `close()` 幂等，故 `finally` 里关两次也无害
 * （`connect()` 内部失败时自己已经关过一次）。
 *
 * ⚠️ 错误消息来自 `mcp/errors.ts` 的翻译层（已经是**可读中文 + 已脱敏**）；
 *    非 `AppError` 的意外错误原样带出 —— 它们是**给我们看的**，会被 `status=ERROR` 之外
 *    再进日志的 warn（`testMcpServer` 里）。
 */
async function probeServer(target: { id: string; name: string; endpointUrl: string }): Promise<McpServerTestResult> {
  const client = new McpClient({
    name: target.name,
    url: target.endpointUrl,
    logFields: { mcpServerId: target.id },
  })
  try {
    await client.connect()
    const tools = await client.listTools()
    return { ok: true, tools }
  } catch (error) {
    return { ok: false, error: error instanceof AppError ? error.message : String(error) }
  } finally {
    await client.close()
  }
}

/**
 * 把一次探测结论落到库里，返回**刷新后的行**。
 *
 * 成功 ⇒ `status=OK` + 写 `tool_cache`；失败 ⇒ **只改 `status=ERROR`**（文件头 ④）。
 * 一次 `update` 同时覆盖两种结果（不是"先查再写"）—— 顺带把 `updated_at` 交给 Prisma 维护。
 */
async function applyProbeResult(id: string, test: McpServerTestResult): Promise<McpServerRow> {
  const db = getPrisma()
  return db.mcpServer.update({
    where: { id },
    data: test.ok
      ? {
          status: 'OK',
          toolCache: toJsonInput(buildToolCache(test.tools, new Date().toISOString())),
        }
      : { status: 'ERROR' },
    select: MCP_SERVER_SELECT,
  })
}

// ═════════════════════════════════════════════════════════════════════
// 列表
// ═════════════════════════════════════════════════════════════════════

/**
 * server 列表（`GET /api/mcp/servers`，登录即可）。
 *
 * 排序 `createdAt asc, id asc`：与 `/api/users`、`/api/models`、`/api/knowledge-bases` 同一口径
 * （按录入顺序展示最直观，`id` 兜底让 offset 分页稳定 —— uuid7 时间有序，但只靠它
 * 会在同毫秒插入时抖动）。
 */
export async function listMcpServers(query: ListMcpServersQuery): Promise<OffsetPage<McpServerItem>> {
  const db = getPrisma()
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.mcpServer.findMany({
      select: MCP_SERVER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.mcpServer.count(),
  ])
  return { items: rows.map(toItem), total, offset: query.offset, limit: query.limit }
}

// ═════════════════════════════════════════════════════════════════════
// 建
// ═════════════════════════════════════════════════════════════════════

/**
 * 注册（`POST /api/mcp/servers`，登录即可）。
 *
 * 顺序（每一环的位置都有理由）：
 *   ① 先拒 `OAUTH`（见 `assertAuthTypeSupported`）—— 在**任何写库之前**，
 *      免得留下一个"注册成功但永远用不了"的 server。
 *   ② 派生 slug（查一次库；见 `nextSlug`）。
 *   ③ 落库。
 *   ④ **best-effort 探测**（文件头 ②）—— 它**不参与成败**：`probeServer` 永不抛，
 *      失败只是让 `status=ERROR`。
 *
 * ⚠️ 第 ④ 步会让"建一个打不通的地址"也耗时到 `MCP_REQUEST_TIMEOUT_MS`（默认 20s）——
 *    真实的连不通是**快失败**（`ECONNREFUSED` / `ENOTFOUND` 立刻回来），只有"能连上但不说话"
 *    的地址才会等满。这是刻意的取舍：`01` §3.6 要求"注册时连通测试"，
 *    而代价上限是"一次请求的等待"，不是"更慢的注册流程"。
 */
export async function createMcpServer(
  input: CreateMcpServerBody,
  viewer: McpViewer,
): Promise<McpServerCreateResult> {
  const db = getPrisma()
  assertAuthTypeSupported(input.authType)

  const slug = await nextSlug(input.name)

  const created = await db.mcpServer.create({
    data: {
      name: input.name,
      slug,
      endpointUrl: input.endpointUrl,
      authType: input.authType ?? 'NONE',
      credentialSchema: toJsonInput(input.credentialSchema ?? []),
      createdBy: viewer.userId,
    },
    select: MCP_SERVER_SELECT,
  })

  const test = await probeServer(created)
  const refreshed = await applyProbeResult(created.id, test)

  getLogger().info(
    { mcpServerId: created.id, name: created.name, slug, testOk: test.ok },
    '已注册 MCP server',
  )
  return { server: toItem(refreshed), test }
}

// ═════════════════════════════════════════════════════════════════════
// 改
// ═════════════════════════════════════════════════════════════════════

/**
 * 改注册信息（`PATCH /api/mcp/servers/:id`，登录即可）。
 *
 * 三件事：
 *   · `OAUTH` 照拒（同建库）；
 *   · **注册信息变更 ⇒ 清缓存**（文件头 ③）：`endpointUrl` / `authType` / `credentialSchema`
 *     任一**真的变了**（键序无关地比，见 `sameJson`）就 `toolCache: null` + `status: 'UNKNOWN'`；
 *   · **`slug` 不可改**（契约里根本没有这个字段）：它要进工具名前缀，跟着改名会让历史消息的
 *     `content.tool_calls` 对不上真实调用（`06` §4.3 的定案）。
 *
 * ⚠️ `credentialSchema` 是**整体替换**（数组语义："提交什么就是什么"）。这与 P0-2-4 的
 * **凭据值**（PUT 是**合并**语义）刻意相反 —— 那边"整体替换"会把用户没填的 key 静默清空。
 * 分辨方式：**模板**（schema）是注册者定义的、可以整体覆盖；**值**（values）不可回填，
 * 所以只能合并。这条差别写在两处的契约注释里，别互相照抄。
 *
 * ⚠️ **非法模板进不到这里**（P0-2-3：按 `inject` 判 `key`、同模板内判重都在路由级 schema 上，
 * 报错 path 精确到 `body.credentialSchema.<i>.key`）⇒ 本函数拿到的模板一定是合法的。
 *
 * @throws {AppError} `NOT_FOUND`(404) server 不存在 / `VALIDATION`(400) 传了 OAUTH
 */
export async function updateMcpServer(
  id: string,
  input: UpdateMcpServerBody,
): Promise<UpdateMcpServerResult> {
  const db = getPrisma()
  assertAuthTypeSupported(input.authType)

  const current = await db.mcpServer.findUnique({ where: { id }, select: MCP_SERVER_SELECT })
  if (current === null) throw AppError.notFound('MCP server 不存在')

  /** 库里那份模板的**可用化**版本（jsonb 里可能混着坏条目，见 `normalizeCredentialSchema`） */
  const currentSchema = normalizeCredentialSchema(current.credentialSchema)

  // 只在"真的变了"时才清缓存 —— 前端保存整个表单时会把**没改的字段**也一起提交，
  // 若按"提交里带了就清"判，每次保存都会让工具数归零（见 sameJson 的注释）
  const invalidatesCache =
    (input.endpointUrl !== undefined && input.endpointUrl !== current.endpointUrl) ||
    (input.authType !== undefined && input.authType !== current.authType) ||
    (input.credentialSchema !== undefined && !sameJson(input.credentialSchema, currentSchema))

  /**
   * 本次模板变更对"**已存凭据**"的影响（P0-2-3 门槛 3）。
   *
   * 三件事要一起记住：
   *   · 判据是 `diffCredentialSchema`（key 级：增/删/换注入位置），**不是**上面那个
   *     `sameJson`（整体级）—— 改个 `label` 该清缓存，但**与用户的凭据无关**，不该弹提示；
   *   · 没提交模板 ⇒ `null`（`undefined` 与"提交了但等价"在这里是同一个结论：无需提示）；
   *   · **只提示**：本函数**一个字的凭据都不碰**（表属 P0-2-4）。自动清理会把"用户临时改错
   *     模板"变成**不可逆的数据丢失**，而他什么都没做（坑预判 2）。
   */
  const impact =
    input.credentialSchema === undefined
      ? null
      : credentialSchemaImpactOf(diffCredentialSchema(currentSchema, input.credentialSchema))

  const updated = await db.mcpServer.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.endpointUrl === undefined ? {} : { endpointUrl: input.endpointUrl }),
      ...(input.authType === undefined ? {} : { authType: input.authType }),
      ...(input.credentialSchema === undefined
        ? {}
        : { credentialSchema: toJsonInput(input.credentialSchema) }),
      // ⚠️ 清缓存写的是 `Prisma.DbNull`（SQL NULL），**不是**字面量 `null` ——
      //    Prisma 对可空 jsonb 列要求显式区分"这个列没有值"（`DbNull`）与
      //    "这个列的值是一个 jsonb 的 null"（`JsonNull`）。读侧的判据是
      //    `parsed === null ⇒ 没有缓存`，只有 `DbNull` 才对得上。
      ...(invalidatesCache ? { toolCache: Prisma.DbNull, status: 'UNKNOWN' as const } : {}),
    },
    select: MCP_SERVER_SELECT,
  })

  getLogger().info(
    {
      mcpServerId: id,
      invalidatesCache,
      changed: Object.keys(input),
      // ⚠️ 只记 key 名与条数：这里**没有值**可漏，但"impact 只写 key 名"这条纪律要一致
      //    （P0-2-4 的日志会经手真正的值，见 `02` §十三 的 `[REDACTED]` 口径）
      impactRemoved: impact?.removedKeys.length ?? 0,
    },
    invalidatesCache ? '已更新 MCP server（注册信息变更，工具缓存已失效）' : '已更新 MCP server',
  )
  return { server: toItem(updated), credentialSchemaImpact: impact }
}

// ═════════════════════════════════════════════════════════════════════
// 删
// ═════════════════════════════════════════════════════════════════════

/**
 * 删除（`DELETE /api/mcp/servers/:id`，登录即可）。
 *
 * ⚠️ **被 Agent 绑定时 409**（验收门槛 3）：`agent_components.ref_id` 是**多态外键、
 * 刻意不建 FK**（`02` §3.1），数据库不会拦 —— 引用完整性由服务层负责。放任删除会留下
 * "Agent 说绑着某个 server、那 server 已经不存在"的孤儿绑定，症状是**下一轮对话检索/调工具时
 * 才炸且查不出来**。口径与 P0-1-15 的删库守卫**同源**（先查、给数字、409 说人话），
 * 文案同句式、只是主语换成 server。
 *
 * ⚠️ `P2025`（"查到之后、删之前被并发删掉"）按 404 回，与 `kb.service.ts` 的删库**同款兜底**：
 * 本表目前没有任何 `CASCADE` 子表（`mcp_credentials` 属 P0-2-4，届时按"凭据随 server 消失"
 * 加 `CASCADE`），所以这条只可能来自并发，不是数据一致性问题。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在 / `CONFLICT`(409) 正被 Agent 绑定
 */
export async function removeMcpServer(id: string): Promise<RemoveMcpServerResult> {
  const db = getPrisma()
  const target = await db.mcpServer.findUnique({
    where: { id },
    select: { id: true, name: true },
  })
  if (target === null) throw AppError.notFound('MCP server 不存在')

  const boundAgents = await db.agentComponent.count({
    where: { componentType: 'MCP', refId: id },
  })
  if (boundAgents > 0) {
    throw AppError.conflict(
      `该 MCP server 正被 ${boundAgents} 个智能体绑定，无法删除。请先在那些智能体里解绑`,
    )
  }

  try {
    await db.mcpServer.delete({ where: { id } })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
      throw AppError.notFound('MCP server 不存在')
    }
    throw error
  }

  getLogger().info({ mcpServerId: id, name: target.name }, '已删除 MCP server')
  return { id, name: target.name }
}

// ═════════════════════════════════════════════════════════════════════
// 测试连通 / 读工具列表
// ═════════════════════════════════════════════════════════════════════

/**
 * 连通测试（`POST /api/mcp/servers/:id/test`，登录即可）。
 *
 * **HTTP 恒 200**（`06` §4.3）：`ok:false` 是一个**结论**，不是一次失败。
 * 两条副作用（验收门槛 2）：成功顺手刷 `tool_cache`；失败只把 `status` 打成 `ERROR`。
 *
 * 只有"server 不存在"才抛 404 —— 那是**请求本身**的问题（主语是"这个请求"），
 * 与"这一轮连不上"（主语是"这次执行"）必须分开（`02` §5.2 的两类失败口径）。
 *
 * @throws {AppError} `NOT_FOUND`(404)
 */
export async function testMcpServer(id: string): Promise<McpServerTestResult> {
  const db = getPrisma()
  const target = await db.mcpServer.findUnique({
    where: { id },
    select: { id: true, name: true, endpointUrl: true },
  })
  if (target === null) throw AppError.notFound('MCP server 不存在')

  const test = await probeServer(target)
  await applyProbeResult(id, test)

  if (!test.ok) {
    // 失败进 warn（成功那条走 info）—— "哪个 server 现在打不通"是运维最想一眼看到的东西
    getLogger().warn({ mcpServerId: id, name: target.name, error: test.error }, 'MCP server 连通测试失败')
  }
  return test
}

/**
 * 工具列表（`GET /api/mcp/servers/:id/tools`，登录即可）。
 *
 * **本批是纯读缓存**：不联网、无副作用（"真去拉"走 `POST /:id/test`，P0-2-5 会加 `?refresh=1`）。
 * 从未成功拉过 ⇒ `{tools: [], fetchedAt: null, cached: false}` —— ⚠️ 这与"这个 server
 * 没有工具"（`{tools: [], fetchedAt: '<时刻>', cached: true}`）是**两件事**，
 * 界面必须能分开显示（前者提示"点「测试」拉取"，后者显示"0 个工具"）。
 *
 * @throws {AppError} `NOT_FOUND`(404) server 不存在
 */
export async function getMcpServerTools(id: string): Promise<McpServerToolsResult> {
  const db = getPrisma()
  const row = await db.mcpServer.findUnique({ where: { id }, select: { id: true, toolCache: true } })
  if (row === null) throw AppError.notFound('MCP server 不存在')

  const cache = parseToolCache(row.toolCache)
  if (cache === null) {
    if (row.toolCache !== null) {
      // 有值但读不出来 ⇒ 值得一条 warn（那是"库里有一份我们解析不了的缓存"，属异常数据）
      getLogger().warn({ mcpServerId: id }, 'tool_cache 内容不符合契约，按「无缓存」处理')
    }
    return { tools: [], fetchedAt: null, cached: false }
  }
  return { tools: cache.tools, fetchedAt: cache.fetchedAt, cached: true }
}
