/**
 * MCP server 服务（P0-2-2；P0-2-3 加"模板变更的影响"）
 *
 * 依据：`docs/02-后端设计.md` §4.7（六条路由）+ §三（`mcp_servers` 表）+ §九（注册者定义模板）
 *      + `docs/归档/06-P0-2-实施步骤.md` P0-2-2（内容 / 验收门槛 1~5 / 坑预判 1~4）
 *        与 P0-2-3（凭据模板的深度校验 / `credentialSchemaImpact` / 坑预判 2）
 *        与 P0-2-5（工具发现：`?refresh=1` / 缓存命中零请求 / 上游不通的两个出口）
 *        与 §4.2、§4.3
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的**七条口径**（每条都对应一条验收门槛或坑预判）
 * ─────────────────────────────────────────────────────────────────────
 * **① 权限：建/看登录即可；改/删 = 注册者 + ADMIN（⚠️ P0-2-12 改过口径）。**
 *    原文是"`created_by` 只作**留痕**、本文件里**一个权限判断都没有**"。**2026-09-24 起**
 *    `created_by` 升为**权限判据**：`updateMcpServer` / `removeMcpServer` **先 404 再 403**
 *    （判据 `shared#canEditMcpServer`），`listMcpServers` 把 `canEdit` 算进投影。
 *    ⚠️ **`POST /:id/test` 与 `GET /:id/tools` 仍不判权限** —— 它们是"**使用**"不是编辑，
 *    收窄它们只会造出"server 建完就没人能测了"（注册者离职 ⇒ 一台能用的 server 永远显示不了工具）。
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
 * **⑤ ⚠️ 探测带"注册者"的凭据（原文"刻意不带用户凭据"已作废 —— P0-2-12 改）。**
 *    原文的理由（"带上某个人的凭据会造出'**工具列表依赖谁先点过测试**'"）**仍然成立** ——
 *    但它针对的是**"发起人凭据"**。换成**注册者凭据**（`mcp_servers.created_by`）之后那个顾虑
 *    自动消失：注册者是**确定的、每台 server 唯一**的 ⇒ `tool_cache` 仍是**每个 server 一份、
 *    全员共享**的，与"谁点的测试"无关（**串用户**这条被结构性地排除掉了）。
 *    改口径的收益很硬：不带的后果是"要求鉴权的 server（真实 MCP 生态里是绝大多数）一律 401
 *    ⇒ `tool_cache` 恒空 ⇒ 下发给模型的工具数恒 0 ⇒ **对话里永远触发不了工具**"。
 *    ⚠️ 注册者没配齐**必填**凭据时**不发起上游请求**（见 `probeServer`），与调用路径的 424 同判据 ——
 *    否则用户拿到一句 401，而那句话会把他引向"我的令牌错了"（实际是**根本没带令牌**）。
 *
 * **⑥ 改模板时**只提示、绝不自动清理**已存的凭据（P0-2-3 坑预判 2 / 门槛 3）。**
 *    `credentialSchema` 变更后，响应里带回 `credentialSchemaImpact`（增/删/换注入位置三类 key 级的
 *    差异 + **受影响的已存凭据条数**）；本服务**一个字的凭据值都不碰**（那条链路在
 *    `mcpCredential.service.ts`，它**只读 `values` 的键名来数条数**，不解密、不写）——
 *    因为"用户临时改错模板"⇒ 值被清掉是**不可逆**的，而他什么都没做。⚠️ 这与"缓存该不该清"是**两个判据**：缓存用 `sameJson`
 *    判"模板整体变没变"（连 `label` 改了也清），impact 用 `diffCredentialSchema` 判
 *    "**已存凭据会受什么影响**"（只有 key 级的三种改动才算）。
 *
 * **⑦ "拉不到"有两个出口，分界线是"我们还能不能答出这个问题"（P0-2-5 门槛 2/4）。**
 *    `GET /:id/tools?refresh=1` 刷新失败时：
 *      · **缓存还在 ⇒ 200**，回上一次成功的那份 + `cached:true`（`fetchedAt` 明显偏旧）
 *        —— 用户要的是"工具列表"，我们**答得出来**（只是不是最新的），答得出来就必须答；
 *      · **缓存也空 ⇒ 502** —— 这时唯一能给的就是 `{tools:[]}`，而它会**冒充**一句
 *        "这个 server 没有工具"。**给不出的东西不要拿空值代替**（老口径）。
 *    ⚠️ 与 `POST /:id/test` **恒 200** 不冲突：那个端点的响应形状里**有** `{ok:false,error}`
 *    这个合法位置来承载"连不上"，而 `{tools,fetchedAt,cached}` **没有**这样的位置。
 *    两条路由都在写库（成功刷缓存 / 失败只写 `status`），见 ③④。
 */

import { appMsg,
  AppError,
  assetVisibilityWhere,
  canEditMcpServer,
  canViewAsset,
  credentialSchemaImpactOf,
  diffCredentialSchema,
  missingRequiredCredentialKeys,
  normalizeCredentialSchema,
  slugifyServerName,
  uniqueSlug,
  type AssetVisibility,
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
  type UserRole,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { broadcastMcpServerToolCacheChange } from '../sandbox/catalogSync.js'
import { getPrisma, Prisma } from '../infra/prisma.js'
import { McpClient } from '../mcp/client.js'
import { buildCredentialInjection, createCredentialFetch } from '../mcp/inject.js'
import { buildToolCache, parseToolCache, toolCountOf, type McpToolCache } from '../mcp/toolCache.js'
import { countAffectedCredentials, decryptMyCredentialValues } from './mcpCredential.service.js'

/**
 * 调用者。
 *
 * ⚠️ P0-2-12 起 `role` 是**必需**的：改/删要走行级判定（`shared#canEditMcpServer`）。
 * 而 `userId` 有**两个用途**、别混：① 建 server 时当 `createdBy`；② 判"我能不能改这台"。
 * （**探测**用的不是它 —— 那边的主语是**注册者**，见 `probeServer`。）
 */
export interface McpViewer {
  userId: string
  role: UserRole
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
  visibility: true,
  /**
   * 注册者显示名（P0-2-12 加的；`creatorName` 昵称优先、回落用户名）。
   * ⚠️ **只取这两列**，别图省事写 `creator: true` —— 那会把密码哈希 / 状态 / 角色整行拉出来，
   * 而"手上有没有"决定了下一个人顺手 `...row` 时会不会漏（同 `agent.service.ts` 的取法）。
   */
  creator: { select: { username: true, nickname: true } },
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
  visibility: AssetVisibility
  creator: { username: string; nickname: string | null }
  createdAt: Date
  updatedAt: Date
}

// ═════════════════════════════════════════════════════════════════════
// 投影与小工具
// ═════════════════════════════════════════════════════════════════════

/**
 * 行 → 契约投影。
 *
 * ⚠️ P0-2-12 起它需要 `viewer`：`canEdit` 是**依赖调用者**的（同一行对不同人给出不同答案）。
 * 别把这个字段挪到前端去算 —— 前端只认"`createdBy === 我`"的话，**ADMIN 也会被算成无权限**，
 * 而服务端 403 判据把他算成有权限 ⇒ 界面上"管理员没有编辑入口"，两边对不上（同 `AgentItem.canEdit`）。
 */
function toItem(row: McpServerRow, viewer: McpViewer): McpServerItem {
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
    creatorName: row.creator.nickname ?? row.creator.username,
    // P1-18：MCP server 只有私有/公开两档（不带 SHARED）；防御式收敛（库里若被手工写进 SHARED，按私有处理）
    visibility: row.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    canEdit: canEditMcpServer(row, { id: viewer.userId, role: viewer.role }),
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
    throw AppError.validation(appMsg('app.m268'),
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
// 连通测试与工具缓存刷新（**全文件唯一的"联网"入口**）
// ═════════════════════════════════════════════════════════════════════

/**
 * 连一次上游、拉一次 `tools/list`，**永不抛错**（除编程错误）。
 *
 * ⚠️ **P0-2-12 起它带"注册者（所属人）"的凭据**（原文"刻意不传 `headers` ⇒ 一个凭据都不带"
 * 已作废，见文件头 ⑤）。主语是 `target.createdBy` —— **不是**"发起这次测试的人"：
 * `tool_cache` 是 **server 级共享**的，主语必须**唯一确定**，否则就是**串用户**
 * （A 点过测试 ⇒ B 看到的是 A 的凭据拉到的列表）。这也正是"为什么不干脆用发起人的凭据"的答案。
 *
 * ⚠️ 注册者**没配齐必填凭据时不发起上游请求**：直接给 `{ok:false}` —— 与调用路径
 * "在发请求之前拦 424"同判据。否则用户会拿到一句 401，而那句话会把他引向"我的令牌错了"
 * （实际是**根本没带令牌**）。
 *
 * `McpClient` 的 `close()` 幂等，故 `finally` 里关两次也无害（`connect()` 内部失败时自己关过一次）。
 *
 * ⚠️ 错误消息来自 `mcp/errors.ts` 的翻译层（已经是**可读中文 + 已脱敏**）；
 *    非 `AppError` 的意外错误原样带出 —— 它们是**给我们看的**。
 *    三个调用点各自决定怎么用它：`testMcpServer` 收成一条 warn（结论照常回给调用方）、
 *    `getMcpServerTools` 在"回退到既有缓存"时进一条 warn，而在"连缓存都没有"时
 *    把它**原样作为 502 的消息**给用户（那时它就是用户唯一能看到的原因）。
 */
async function probeServer(target: {
  id: string
  name: string
  endpointUrl: string
  credentialSchema: unknown
  createdBy: string
}): Promise<McpServerTestResult> {
  const schema = normalizeCredentialSchema(target.credentialSchema)
  const { values } = await decryptMyCredentialValues(target.id, target.createdBy)

  const missingKeys = missingRequiredCredentialKeys(schema, Object.keys(values))
  if (missingKeys.length > 0) {
    // ⚠️ 只记**键名**与条数（值一个字都不许进日志 —— 同 `mcpCall.service.ts` 的口径）
    getLogger().warn(
      {
        mcpServerId: target.id,
        ownerId: target.createdBy,
        missingKeys,
        presentKeyCount: Object.keys(values).length,
      },
      'MCP server 的注册者尚未配齐必填凭据 ⇒ 探测未发起上游请求',
    )
    return {
      ok: false,
      error:
        `该 server 的所属人尚未在「我的凭据」里配齐参数（还缺：${missingKeys.join('、')}）。` +
        '连通测试与工具列表都用**所属人**的凭据 ⇒ 请让所属人补上后重试。',
    }
  }

  const injection = buildCredentialInjection(schema, values)
  const client = new McpClient({
    name: target.name,
    url: target.endpointUrl,
    // ⚠️ 空注入时 `createCredentialFetch` 原样返回全局 fetch（不多套一层、不改 URL）
    fetch: createCredentialFetch(injection),
    // 解密出来的明文**只用于错误消息脱敏**（绝不进日志）
    secrets: Object.values(values),
    logFields: { mcpServerId: target.id, ownerId: target.createdBy },
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
 *
 * ⚠️ `fetchedAt` 由**调用方**给（不在这里 `new Date()`）：同一个时刻要同时进**库**与
 * **响应体**。两处各取一次"现在"的后果是界面显示的时刻与缓存里那个差几毫秒 ——
 * 一个没法复现、也没人会去报的偏差（`buildToolCache` 的注释同款理由）。
 */
async function applyProbeResult(
  id: string,
  test: McpServerTestResult,
  fetchedAt: string,
): Promise<McpServerRow> {
  const db = getPrisma()
  return db.mcpServer.update({
    where: { id },
    data: test.ok
      ? { status: 'OK', toolCache: toJsonInput(buildToolCache(test.tools, fetchedAt)) }
      : { status: 'ERROR' },
    select: MCP_SERVER_SELECT,
  })
}

/**
 * **刷新**一次工具缓存（= 连一次上游 + 落库）—— 本文件里"真的联网"的唯一入口。
 *
 * 三处调用点共用它：注册时的 best-effort 探测、`POST /:id/test`、`GET /:id/tools?refresh=1`。
 * 三处各写一遍"连一次 + 落库"的后果是"失败时 `tool_cache` 一字节不动"这条口径
 * 迟早会在其中一处腐烂（那正是文件头 ④ 说的最坏形态）。
 *
 * ⚠️ 返回的 `row` 是**落库后**的行：成功时 `row.toolCache` 就是刚写进去的值
 * （`getMcpServerTools` 顺手拿它验一次"写得进、读得出"）；失败时它仍是**上一次成功**的那份
 * （本函数刻意不碰它，见 `applyProbeResult`）。
 */
async function refreshServerTools(server: {
  id: string
  name: string
  endpointUrl: string
  credentialSchema: unknown
  createdBy: string
}): Promise<{ test: McpServerTestResult; row: McpServerRow }> {
  const test = await probeServer(server)
  const row = await applyProbeResult(server.id, test, new Date().toISOString())
  // ★ P1-21：缓存变了 ⇒ 绑了这台 server 的 Agent 名下**活着的会话**重发清单（容器下一次派活时
  //   会按新清单热更新工具）。只在**成功**时广播：失败时 `tool_cache` 一字节没动（文件头 ④），
  //   清单自然也没变。异步不等待 —— 广播失败只影响"要不要等下次容器重建"。
  if (test.ok) {
    void broadcastMcpServerToolCacheChange(server.id).catch((error: unknown) => {
      getLogger().warn({ err: error, mcpServerId: server.id }, '工具缓存变化广播失败（派活前仍会兜底比对）')
    })
  }
  return { test, row }
}

// ═════════════════════════════════════════════════════════════════════
// 列表
// ═════════════════════════════════════════════════════════════════════

/**
 * server 列表（`GET /api/mcp/servers`，登录即可 —— **看**不收窄）。
 *
 * ⚠️ 但**每一项的 `canEdit` 依赖 viewer**（P0-2-12）：同一台 server 对注册者/ADMIN 是 `true`、
 * 对别人是 `false`。前端**不自己算**（见 `toItem` 的注释）。
 *
 * 排序 `createdAt asc, id asc`：与 `/api/users`、`/api/models`、`/api/knowledge-bases` 同一口径
 * （按录入顺序展示最直观，`id` 兜底让 offset 分页稳定 —— uuid7 时间有序，但只靠它
 * 会在同毫秒插入时抖动）。
 */
export async function listMcpServers(
  query: ListMcpServersQuery,
  viewer: McpViewer,
): Promise<OffsetPage<McpServerItem>> {
  const db = getPrisma()
  // P1-13：按"对我可见"过滤（`PUBLIC` + 自己的；ADMIN 见全部）
  const where = assetVisibilityWhere({ id: viewer.userId, role: viewer.role })
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.mcpServer.findMany({
      where,
      select: MCP_SERVER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.mcpServer.count({ where }),
  ])
  return { items: rows.map((row) => toItem(row, viewer)), total, offset: query.offset, limit: query.limit }
}

// ═════════════════════════════════════════════════════════════════════
// 建
// ═════════════════════════════════════════════════════════════════════

/**
 * 注册（`POST /api/mcp/servers`，登录即可 —— **建**不收窄）。
 *
 * ⚠️ **建的人就是所属人**（`createdBy = viewer.userId`，P0-2-12）：他从此是唯一（除 ADMIN 外）
 * 能改/删这台 server 的人，**也是"测试 / 工具列表"的探测主语**。所以紧接着那句"注册时的
 * best-effort 探测"用的就是**他**的凭据 —— 刚建完通常还没有凭据，探测会以
 * `{ok:false, error:"…所属人尚未配置…"}` 结束（**不发上游请求**），这是**预期行为**。
 *
 * 顺序（每一环的位置都有理由）：
 *   ① 先拒 `OAUTH`（见 `assertAuthTypeSupported`）—— 在**任何写库之前**，
 *      免得留下一个"注册成功但永远用不了"的 server。
 *   ② 派生 slug（查一次库；见 `nextSlug`）。
 *   ③ 落库。
 *   ④ **best-effort 探测**（文件头 ②）—— 它**不参与成败**：`refreshServerTools` 永不抛，
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
      // P1-13：可见性（可省 ⇒ PRIVATE 安全默认）
      visibility: input.visibility ?? 'PRIVATE',
    },
    select: MCP_SERVER_SELECT,
  })

  const { test, row: refreshed } = await refreshServerTools(created)

  getLogger().info(
    { mcpServerId: created.id, name: created.name, slug, testOk: test.ok },
    '已注册 MCP server',
  )
  return { server: toItem(refreshed, viewer), test }
}

// ═════════════════════════════════════════════════════════════════════
// 改
// ═════════════════════════════════════════════════════════════════════

/**
 * 改注册信息（`PATCH /api/mcp/servers/:id`）。
 *
 * ⚠️ **P0-2-12 起只有注册者（所属人）或 ADMIN 能改**（原文"登录即可"**已作废**）：**先 404 再 403**，
 * 与 `agents` 同口径 —— `server` 是**公开可见**的资源（列表全员能读）⇒ 藏 id 没有意义，
 * "404 而不是 403"那套留给**只有本人能看见**的资源（会话族）。
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
 * @throws {AppError} `NOT_FOUND`(404) 不存在 / `FORBIDDEN`(403) 既不是注册者也不是 ADMIN /
 *   `VALIDATION`(400) 传了 OAUTH
 */
export async function updateMcpServer(
  id: string,
  input: UpdateMcpServerBody,
  viewer: McpViewer,
): Promise<UpdateMcpServerResult> {
  const db = getPrisma()
  assertAuthTypeSupported(input.authType)

  const current = await db.mcpServer.findUnique({ where: { id }, select: MCP_SERVER_SELECT })
  if (current === null) throw AppError.notFound(appMsg('app.m004'))
  if (!canEditMcpServer(current, { id: viewer.userId, role: viewer.role })) {
    throw AppError.forbidden(appMsg('app.m178'))
  }

  /** 库里那份模板的**可用化**版本（jsonb 里可能混着坏条目，见 `normalizeCredentialSchema`） */
  const currentSchema = normalizeCredentialSchema(current.credentialSchema)

  // 只在"真的变了"时才清缓存 —— 前端保存整个表单时会把**没改的字段**也一起提交，
  // 若按"提交里带了就清"判，每次保存都会让工具数归零（见 sameJson 的注释）
  const invalidatesCache =
    (input.endpointUrl !== undefined && input.endpointUrl !== current.endpointUrl) ||
    (input.authType !== undefined && input.authType !== current.authType) ||
    (input.credentialSchema !== undefined && !sameJson(input.credentialSchema, currentSchema))

  /**
   * 本次模板变更对"**已存凭据**"的影响（P0-2-3 门槛 3；条数在 P0-2-4 兑现）。
   *
   * 四件事要一起记住：
   *   · 判据是 `diffCredentialSchema`（key 级：增/删/换注入位置），**不是**上面那个
   *     `sameJson`（整体级）—— 改个 `label` 该清缓存，但**与用户的凭据无关**，不该弹提示；
   *   · 没提交模板 ⇒ `null`（`undefined` 与"提交了但等价"在这里是同一个结论：无需提示）；
   *   · **`affectedCredentials` 现在是一个真数**（P0-2-3 时恒 `null`：那时没有凭据表，
   *     后端**没有能力**回答"几条已存凭据受影响"）。数它要查一次库，而它只对
   *     `removedKeys` 有意义（`removedKeys` 为空时 `countAffectedCredentials` **一条查询都不发**）；
   *   · **只提示**：本函数**一个字的凭据都不碰**（"值没了"是**不可逆**的，而用户可能只是
   *     临时改错了模板）。真要清理由用户在凭据页自己点 `DELETE`（P0-2-4）。
   */
  const schemaDiff =
    input.credentialSchema === undefined
      ? null
      : diffCredentialSchema(currentSchema, input.credentialSchema)
  const impact =
    schemaDiff === null
      ? null
      : credentialSchemaImpactOf(
          schemaDiff,
          await countAffectedCredentials(id, schemaDiff.removedKeys),
        )

  const updated = await db.mcpServer.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.endpointUrl === undefined ? {} : { endpointUrl: input.endpointUrl }),
      ...(input.authType === undefined ? {} : { authType: input.authType }),
      ...(input.credentialSchema === undefined
        ? {}
        : { credentialSchema: toJsonInput(input.credentialSchema) }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
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
      //    （P0-2-4 起凭据链路真的经手值与密文，那条纪律在 `mcpCredential.service.ts` 文件头 ⑥，
      //     同 `02` §十三 的 `[REDACTED]` 口径）
      impactRemoved: impact?.removedKeys.length ?? 0,
      impactAffected: impact?.affectedCredentials ?? 0,
    },
    invalidatesCache ? '已更新 MCP server（注册信息变更，工具缓存已失效）' : '已更新 MCP server',
  )
  return { server: toItem(updated, viewer), credentialSchemaImpact: impact }
}

// ═════════════════════════════════════════════════════════════════════
// 删
// ═════════════════════════════════════════════════════════════════════

/**
 * 删除（`DELETE /api/mcp/servers/:id`）。
 *
 * ⚠️ **P0-2-12 起只有注册者（所属人）或 ADMIN 能删**（原文"登录即可"已作废），且**排在 409 之前**：
 * 无权限的人不该从"被几个智能体绑着"这句话里读出任何信息。删除的后果比"改"更重 ——
 * 它会**连带删掉所有人的凭据**（`mcp_credentials` 是 `ON DELETE CASCADE`）⇒ 必须归注册者。
 *
 * ⚠️ **被 Agent 绑定时 409**（验收门槛 3）：`agent_components.ref_id` 是**多态外键、
 * 刻意不建 FK**（`02` §3.1），数据库不会拦 —— 引用完整性由服务层负责。放任删除会留下
 * "Agent 说绑着某个 server、那 server 已经不存在"的孤儿绑定，症状是**下一轮对话检索/调工具时
 * 才炸且查不出来**。口径与 P0-1-15 的删库守卫**同源**（先查、给数字、409 说人话），
 * 文案同句式、只是主语换成 server。
 *
 * ⚠️ `P2025`（"查到之后、删之前被并发删掉"）按 404 回，与 `kb.service.ts` 的删库**同款兜底**。
 * ⚠️ **P0-2-4 起本表有了 `CASCADE` 子表**（`mcp_credentials`：server 被删 ⇒ 那份模板也没了，
 * 用户填的值必须跟着消失）。⇒ 这条 404 兜底现在**只可能**来自并发，不再是"没有子表所以一定是
 * 并发"的推论；同时"删 server"会**连带删掉所有人的凭据**（`03` §七 的删除分级里它属"普通删除"
 * —— 凭据不是用户可见的资产，且它引用的模板已不存在）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在 / `FORBIDDEN`(403) 既不是注册者也不是 ADMIN /
 *   `CONFLICT`(409) 正被 Agent 绑定
 */
export async function removeMcpServer(id: string, viewer: McpViewer): Promise<RemoveMcpServerResult> {
  const db = getPrisma()
  const target = await db.mcpServer.findUnique({
    where: { id },
    select: { id: true, name: true, createdBy: true },
  })
  if (target === null) throw AppError.notFound(appMsg('app.m004'))
  // ⚠️ 顺序：404 → **403** → 409。403 必须排在 409 前面（见 doc：不能让人靠"绑定数"这句话
  //    探到信息），也必须排在删除动作前面（否则就是"删完才发现没权限"）。
  if (!canEditMcpServer(target, { id: viewer.userId, role: viewer.role })) {
    throw AppError.forbidden(appMsg('app.m179'))
  }

  const boundAgents = await db.agentComponent.count({
    where: { componentType: 'MCP', refId: id },
  })
  if (boundAgents > 0) {
    throw AppError.conflict(appMsg('app.m180', { p0: boundAgents }),
    )
  }

  try {
    await db.mcpServer.delete({ where: { id } })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
      throw AppError.notFound(appMsg('app.m004'))
    }
    throw error
  }

  getLogger().info({ mcpServerId: id, name: target.name }, '已删除 MCP server')
  return { id, name: target.name }
}

// ═════════════════════════════════════════════════════════════════════
// 转移所属人（P1-13，`子方案` §3.5）
// ═════════════════════════════════════════════════════════════════════

/**
 * 转移 MCP server 所属人（`POST /api/mcp/servers/:id/transfer`，**注册者（所属人）或 ADMIN**）。
 *
 * ⚠️ **MCP 特例**（`子方案` §3.5）：`created_by` 同时是**探测主语**（`POST /:id/test` 与
 * `GET /:id/tools` 用**注册者**的凭据连上游）—— 转移后探测主语变为新所属人。若新所属人没配该
 * server 的凭据，测试/工具列表会失败（`tools/call` 仍用**调用者自己**的凭据，不受影响）。
 * **前端转移弹窗必须就此给出提示**。
 */
export async function transferMcpServer(
  id: string,
  toUserId: string,
  viewer: McpViewer,
): Promise<McpServerItem> {
  const db = getPrisma()
  const target = await db.mcpServer.findUnique({ where: { id }, select: MCP_SERVER_SELECT })
  if (target === null) throw AppError.notFound(appMsg('app.m004'))
  if (!canEditMcpServer(target, { id: viewer.userId, role: viewer.role })) {
    throw AppError.forbidden(appMsg('app.m181'))
  }
  if (toUserId === target.createdBy) {
    throw AppError.validation(appMsg('app.m182'))
  }
  const newOwner = await db.user.findUnique({
    where: { id: toUserId },
    select: { id: true, status: true },
  })
  if (newOwner === null || newOwner.status !== 'ACTIVE') {
    throw AppError.validation(appMsg('app.m011'))
  }
  const updated = await db.mcpServer.update({
    where: { id },
    data: { createdBy: toUserId },
    select: MCP_SERVER_SELECT,
  })
  getLogger().info({ mcpServerId: id, from: target.createdBy, to: toUserId }, '已转移 MCP server 所属人（探测主语随之变更）')
  return toItem(updated, viewer)
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
 * ⚠️ **P0-2-12 起它用注册者（所属人）的凭据**（原文"本层不带用户凭据"已作废，见文件头 ⑤）——
 * 于是"**谁点这个按钮**"完全不影响结论，只有"**注册者配没配凭据**"影响（`06` §4.2 那张表）。
 * 缺必填凭据时**不发起上游请求**，`ok:false` 的文案点名"所属人尚未配置"。
 *
 * 只有"server 不存在"才抛 404 —— 那是**请求本身**的问题（主语是"这个请求"），
 * 与"这一轮连不上"（主语是"这次执行"）必须分开（`02` §5.2 的两类失败口径）。
 *
 * ⚠️ P0-2-5 起它与 `GET /:id/tools?refresh=1` **都**会刷新缓存，但**出口不同**：
 * 这里恒 200（连不上是 `{ok:false,error}`），那边缓存空且拉不到时是 **502**（文件头 ⑦）。
 * 差别不在实现而在**响应形状里有没有"失败"的位置** —— 别把两条路由的出口"统一"起来。
 *
 * ⚠️ **2026-10-16 修订（用户定案）**：连通测试**只有所属人或 ADMIN** 能发起 —— 因为它用的是
 * **所属人的凭据**，让任何登录用户都能点等于"任何人都能拿别人的凭据去探活"。用户不可见的私有
 * server 仍先 404；可见但非所属人 ⇒ **403**。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `FORBIDDEN`(403) 既不是所属人也不是 ADMIN
 */
export async function testMcpServer(id: string, viewer: McpViewer): Promise<McpServerTestResult> {
  const db = getPrisma()
  const target = await db.mcpServer.findUnique({
    where: { id },
    // `credentialSchema` / `createdBy` 是 P0-2-12 加的：探测要用**注册者**的凭据（见 `probeServer`）
    // `visibility` / `createdBy` 同时用于 P1-13 的可见性判定（私有 server 对他人 404）
    select: {
      id: true,
      name: true,
      endpointUrl: true,
      credentialSchema: true,
      createdBy: true,
      visibility: true,
    },
  })
  if (target === null) throw AppError.notFound(appMsg('app.m004'))
  // P1-13：私有 server 对他人 **404**（"测试/工具列表"是"用"，受可见性约束）
  if (!canViewAsset({ ownerId: target.createdBy, visibility: target.visibility }, { id: viewer.userId, role: viewer.role })) {
    throw AppError.notFound(appMsg('app.m004'))
  }
  // 2026-10-16 修订：连通测试只有所属人或 ADMIN 能发起（先 404 再 403 —— 见文件头）
  if (!canEditMcpServer({ createdBy: target.createdBy }, { id: viewer.userId, role: viewer.role })) {
    throw AppError.forbidden(appMsg('app.m183'))
  }

  const { test } = await refreshServerTools(target)

  if (!test.ok) {
    // 失败进 warn（成功那条走 info）—— "哪个 server 现在打不通"是运维最想一眼看到的东西
    getLogger().warn({ mcpServerId: id, name: target.name, error: test.error }, 'MCP server 连通测试失败')
  }
  return test
}

/**
 * 读 `tool_cache` 列 → {@link McpToolCache}，**永不抛错**（读不出来一律 `null` = 当作没有缓存）。
 *
 * 抽成一处是为了让"库里有一份我们解析不了的缓存"这条异常**只在一个地方留痕**：
 * 本端点要读两次（刷新**前**的旧值、刷新**后**的新值），两处各写一遍 parse + warn 的话，
 * 那条 warn 的文案会分叉 —— 而它正是排查"缓存为什么没生效"的唯一线索。
 *
 * ⚠️ 列表页用的是 {@link toolCountOf}（只要数量、**不刷 warn**）：列表是翻页的高频接口，
 * 让一行脏数据在每个请求上打一条日志会把日志冲掉，而那里也做不了任何处置。
 */
function readCachedTools(raw: unknown, serverId: string): McpToolCache | null {
  const cache = parseToolCache(raw)
  if (cache === null && raw !== null && raw !== undefined) {
    getLogger().warn({ mcpServerId: serverId }, 'tool_cache 内容不符合契约，按「无缓存」处理')
  }
  return cache
}

/**
 * 工具列表（`GET /api/mcp/servers/:id/tools`，登录即可）。
 *
 * 两种取法（P0-2-5）：
 *   · **纯读缓存**（不传 `refresh`）：绝不联网、无副作用。从未成功拉过 ⇒
 *     `{tools: [], fetchedAt: null, cached: false}` —— ⚠️ 它与"这个 server **确实没有**工具"
 *     （`{tools: [], fetchedAt: '<时刻>', cached: true}`）是**两件事**，界面必须分开显示
 *     （前者提示"点「测试」拉取"，后者显示"0 个工具"）。
 *   · **`refresh: true`**：真拉一次并落库。三个出口见文件头 ⑦ —— 拉到 ⇒ `cached:false`；
 *     拉不到但有缓存 ⇒ 200 + `cached:true`；拉不到且无缓存 ⇒ **502**。
 *
 * ⚠️ 旧缓存必须在**刷新之前**取出来：刷新一旦落库，行里的旧值就没了 ——
 * 而"拉不到时回落到上一次成功的那份"正是靠它（这也是本函数不在刷新后重新查行的原因）。
 *
 * @throws {AppError} `NOT_FOUND`(404) server 不存在；`UPSTREAM_ERROR`(502) 拉不到且无缓存可回落
 */
export async function getMcpServerTools(
  id: string,
  options: { refresh: boolean },
  viewer: McpViewer,
): Promise<McpServerToolsResult> {
  const db = getPrisma()
  const row = await db.mcpServer.findUnique({
    where: { id },
    // `name` / `endpointUrl` / `credentialSchema` / `createdBy` 都是"要联网"那条路要用的
    // （`probeServer` 拿它们拼请求、取**注册者**的凭据、拼错误消息）
    select: {
      id: true,
      name: true,
      endpointUrl: true,
      credentialSchema: true,
      createdBy: true,
      visibility: true,
      toolCache: true,
    },
  })
  if (row === null) throw AppError.notFound(appMsg('app.m004'))
  // P1-13：私有 server 对他人 **404**
  if (!canViewAsset({ ownerId: row.createdBy, visibility: row.visibility }, { id: viewer.userId, role: viewer.role })) {
    throw AppError.notFound(appMsg('app.m004'))
  }

  /** 上一次**成功**拉到的缓存（库里那份解析不了时按"没有"处理，并留一条 warn） */
  const previous = readCachedTools(row.toolCache, id)

  if (!options.refresh) {
    return previous === null
      ? { tools: [], fetchedAt: null, cached: false }
      : { tools: previous.tools, fetchedAt: previous.fetchedAt, cached: true }
  }

  const { test, row: refreshed } = await refreshServerTools(row)

  if (!test.ok) {
    // 出口之一：**答得出来就答** —— 用户要的是"工具列表"，我们手上有上一次成功的那份。
    // `cached:true` + 偏旧的 `fetchedAt` 就是"这不是刚拉的"的**全部**信号（契约里刻意不加
    // `warning` 字段，见 `shared` 里那份注释）
    if (previous !== null) {
      getLogger().warn(
        { mcpServerId: id, name: row.name, error: test.error, cachedFetchedAt: previous.fetchedAt },
        '工具列表刷新失败，已回退到既有缓存',
      )
      return { tools: previous.tools, fetchedAt: previous.fetchedAt, cached: true }
    }
    // 出口之二：**缓存也空** ⇒ 拿 `{tools:[]}` 冒充"这个 server 没有工具"是一句**假话**，
    // 用户会去上游找一个其实不存在的配置问题 ⇒ 如实报"给不出工具列表"
    throw AppError.upstreamError(appMsg('app.m184', { p0: row.name, p1: test.error }))
  }

  // 成功：⚠️ 从**落库后的行**把值读回来（而不是直接用 `test.tools`）—— 顺带验了"写得进、读得出"。
  // jsonb 往返只重排对象键、不动值，所以这一步同时是驱动与契约的自检。
  const fresh = readCachedTools(refreshed.toolCache, id)
  if (fresh === null) {
    // 刚写进去的值读不出来 ⇒ 驱动或契约出了问题（不是用户输入问题 ⇒ 500，且消息要可上报）
    getLogger().error({ mcpServerId: id }, '刷新后写入的 tool_cache 无法解析（驱动或契约异常）')
    throw AppError.internal(appMsg('app.m185'))
  }
  return { tools: fresh.tools, fetchedAt: fresh.fetchedAt, cached: false }
}
