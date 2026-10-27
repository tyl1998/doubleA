/**
 * MCP 用户级凭据服务（P0-2-4）
 *
 * 依据：`docs/02-后端设计.md` §4.7（三条 `/api/mcp/credentials**` 路由）+ §九（核心定制点：
 *      "凭据只在后端解密，永不下发前端；A 用户会话绝不使用 B 用户凭据"）+ §十（AES-256-GCM）
 *      + §十三（日志脱敏）+ `docs/归档/06-P0-2-实施步骤.md` P0-2-4（内容 / 验收门槛 / 坑预判 1~5）
 *      + `docs/03-前端设计.md` §4.5（我的凭据页：按 server 分组 + 未配置置顶）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的六条口径（每条都对应一条验收门槛或坑预判）
 * ─────────────────────────────────────────────────────────────────────
 * **① 收窄在 `user_id` 上，且没有后门。**
 *    每个导出函数的第一件事就是按 `viewer.userId` 收窄（`where: { serverId, userId }`）——
 *    本文件里**一个角色判断都没有**：ADMIN 读别人的凭据也拿不到（第四族同源，`06` §4.2）。
 *    路径里只有 `:serverId`，**凭据行 id 不出现在任何契约里** ⇒ "越权拿到别人的行"这件事
 *    连入口都没有（少一个 id 就少一整类越权可能）。
 *
 * **② 值有进无出：出网只有 `key` + `hasValue`（连掩码都没有）。**
 *    `values` 这一列只在本文件被读写，且**只读给两件事**：① 判某个 key 有没有值（读路径）；
 *    ② （P0-2-7）解密后注入到上游请求 —— 那一条只经 {@link decryptMyCredentialValues} 出去，
 *    由 `mcpCall.service.ts` 交给 `mcp/inject.ts` 与 `McpClientOptions.secrets`（脱敏），
 *    **别处一处都不许出现**。任何出参都不带值 —— {@link toCredentialItem} 是唯一的出口，
 *    它压根没有"值"这个字段。⚠️ 与 Provider Key 的 `apiKeyPreview` **刻意不同**：
 *    那是管理员配的一份、掩码用于"确认没配错"；这是每个人自己的令牌，下发掩码收益为零。
 *
 * **③ 读路径**必须真解一次**，解不开 ⇒ 当"没有值"（降级），**绝不 500**（坑预判 5）。**
 *    AAD 是"绑定"而不是"格式"：`v1.…` 这段串可能结构完全合法却**不属于这一格**
 *    （把 A 的密文粘到 B 的行上、或主密钥换过）。只有**解密成功**才证明它是 (server,user,key)
 *    这一格的值 ⇒ `hasValue` 的判据是"**解出来过**"，不是"键在"。
 *    解不开的处置：① 不进 `presentKeys`（界面显示"未配置"、用户可以重新填写）；
 *    ② 一条 warn（含 serverId / userId / key 名，**不含任何值**）；
 *    ③ **绝不把这一条变成 500** —— 主密钥轮换后整页崩掉是最坏的形态，
 *       它会把"某人需要重填一个令牌"呈现成"这个系统坏了"。
 *
 * **④ `PUT` 是合并语义**（只动提交里出现的 key）。
 *    与 P0-1 的 `components`（整体替换）**刻意相反**，分辨方式只有一个：
 *    **不可回填的字段只能合并** —— 值不下发 ⇒ 前端无从回填 ⇒ 整体替换会把用户没填的 key
 *    静默清空（他什么都没做，值却没了）。两条口径都写在契约注释里（别互相"统一"）。
 *    配套：**空串 = 清空该 key**（把键从 `values` 里删掉**而不是**存一段空密文 ——
 *    `encryptSecret('')` 会得到结构合法的 `v1.iv.tag.`，那会让"已配置"永远为真）；
 *    **全部 key 都被清空 ⇒ 整行删掉**（"有行"本身就是"我配过"的证据）。
 *
 * **⑤ `configured` 按"我是否真的填过值"判、**按人**（2026-10-16 修订）**。
 *    原判据是"当前模板的必填项是否齐全"，后果是：注册者没勾必填时，**每个人**（含从没配过的）
 *    都会被算成"已配置" —— 而凭据是 `(server,user)` 一份的，于是看起来像"别人配的凭据对我也生效"。
 *    改用"我这边至少有一个模板内的值"（判据收在 `shared#isCredentialConfigured`，唯一实现）：
 *    `configured === true` ⟺ 我填过；模板无参数时恒 `true`（没有东西要他填）。
 *    `missingKeys`（必填缺哪些）仍照算，只作界面提示用，不再参与 `configured`。
 *
 * **⑥ 日志只写 key 名与真假，绝不整体序列化含值的对象**（坑预判 4 / `02` §十三）。
 *    本文件的每条 `logger` 调用都只带 `serverId` / `userId` / `keys[]` / `clearedKeys[]` 这类
 *    **结构性信息**。⚠️ 错误消息里也不能出现值（P0-1-12 "借错误消息漏凭据"同款）——
 *    所以"参数不在模板里"报的是**键名**，不是"你提交的 xxx"。
 *    纵深防御：`infra/logger.ts` 的 `LOG_REDACT_PATHS` 已含 `values` / `*.values`。
 */

import { appMsg,
  AppError,
  credentialValueKeys,
  isCredentialConfigured,
  missingRequiredCredentialKeys,
  normalizeCredentialSchema,
  type CredentialSchemaEntry,
  type McpCredentialItem,
  type McpCredentialListResult,
  type McpUnconfiguredServer,
  type PutMyCredentialBody,
  type RemoveMyCredentialResult,
} from '@doubulea/shared'

import { decryptSecret, encryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma, Prisma } from '../infra/prisma.js'

/** 调用者。本资源的收窄**只有**这一条（见文件头 ①）：`userId` 就是全部权限信息 */
export interface McpCredentialViewer {
  userId: string
}

/**
 * 凭据密文的 **AAD 上下文：改了这里的公式，库里已有密文就全部解不开**。
 *
 * 三段都不能少（`06` P0-2-4 坑预判 3）：
 *   · `serverId` + `userId` —— 缺了它们，"把 A 的密文粘到 B 的行上"能解出来，
 *     那样"绑定层"的验收就是摆设；
 *   · `key` —— 让值不能在**同一条记录的不同字段**之间搬运（把 `token` 的密文塞进 `tenant`）。
 *
 * ⚠️ **刻意不含行 id**（与 `model.service.ts#providerKeyAad` 相反）：那边含 id ⇒
 * 加密只能发生在拿到 id 之后（建记录必须走事务）；这里 `PUT` 走 `upsert`，
 * **加密时还没有行**，含 id 就只能"先建空行再回填"。以 (server,user) 为归属已经足够强 ——
 * 行的身份本来就是 `(server_id, user_id)` 这个唯一键，id 只是它的代理。
 * ⚠️ 与 `providerKeyAad` 一样集中成一处：写与读（P0-2-7 的注入端）**必须**复用本函数。
 */
export function mcpCredentialAad(serverId: string, userId: string, key: string): string {
  return `mcp-credentials:${serverId}:${userId}.values_enc.${key}`
}

/**
 * jsonb `values` → **密文映射**（只保留"非空字符串"的项）。
 *
 * 与 `shared#credentialValueKeys` 的分工：这边是**值的过滤器**（要拿密文去解密），
 * 那边是**键的投影**（只判有没有值）—— 判据只写一次（"非空字符串才算有值"），
 * 不在这里复述一遍过滤条件。
 * ⚠️ 与读取端的其它 jsonb 列同一条纪律：库里可能是 `null` / 不是对象 / 值不是字符串
 * （手工改库、半截数据），一律**逐项过滤**而不是整份作废。
 */
function readCipherMap(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/**
 * 密文映射 → **明文映射**（**解密循环的唯一实现**，P0-2-4 的读路径与 P0-2-7 的注入端共用）。
 *
 * ⚠️ **只有解密成功才算"有值"**（见文件头 ③）：AAD 是"绑定"而不是"格式"，一段结构完全合法的
 * `v1.<iv>.<tag>.<ct>` 可能根本不属于这一格（别处粘来的、主密钥换过）。解不开的 key
 * **不进 `values`** ⇒ 调用方（判"已配置"、算"缺哪些必填"、组注入）自然按"没值"处理。
 *
 * 为什么把"解密"与"读行"拆开：调用方有两种 —— ① 手上已经有密文映射的（`toCredentialItem`
 * 在一次查询里算了所有 server）；② 手上只有一个 `(serverId, userId)` 的
 * （{@link decryptMyCredentialValues}）。两者**必须走同一个循环**，否则
 * "解不开怎么办"会在两处各写一份（P0-1-29 的 `PASSWORD_ALPHABET` 就是那么腐烂的）。
 */
function decryptCipherMap(
  serverId: string,
  userId: string,
  cipherMap: Record<string, string>,
): { values: Record<string, string>; broken: string[] } {
  const values: Record<string, string> = {}
  const broken: string[] = []
  for (const [key, ciphertext] of Object.entries(cipherMap)) {
    try {
      values[key] = decryptSecret(ciphertext, mcpCredentialAad(serverId, userId, key))
    } catch {
      // ⚠️ 只记 key 名，不记密文、不记明文、不记原始错误（原始错误里可能带上下文）
      broken.push(key)
    }
  }
  if (broken.length > 0) {
    getLogger().warn(
      { mcpServerId: serverId, keyCount: broken.length, keys: broken },
      'MCP 凭据解密失败（密文与 (server,user,key) 不匹配，或主密钥已更换）⇒ 该参数按「未配置」处理，等待用户重新填写',
    )
  }
  return { values, broken }
}

/**
 * 密文映射 → **可用的 key 集合**（`toCredentialItem` 只用得上"有没有"，用不上值）。
 * 判据来源仍是 {@link decryptCipherMap}（同上：解密循环只有一份）。
 */
function verifiedKeys(serverId: string, userId: string, cipherMap: Record<string, string>): Set<string> {
  return new Set(Object.keys(decryptCipherMap(serverId, userId, cipherMap).values))
}

/** {@link decryptMyCredentialValues} 的结论 */
export interface McpDecryptedCredentials {
  /**
   * 该用户在这一台 server 上的**明文**值（`key → 值`）。
   * ⚠️ 只允许流向两处：**注入**（`mcp/inject.ts`）与**脱敏**（`McpClientOptions.secrets`）。
   * 日志 / 响应体 / 错误消息 / `tool_call.inputSummary` 一处都不许出现（P0-2-4 文件头 ②）。
   */
  values: Record<string, string>
  /** 解不开的 key（已记 warn，调用方按"没值"处理即可，不必再判） */
  brokenKeys: string[]
}

/**
 * 我的凭据 → **明文**（P0-2-7 的注入端唯一入口）。
 *
 * 这是 `values` 这一列的**第二个、也是最后一个**出口（第一个是"只判有没有值"）：
 * 文件头 ② 说的"值有进无出"针对的是**出网**，而"解密后注入到上游请求"正是
 * `02` §9.3 明写的用途。**没有行 / 行里没这个 key ⇒ 就是没有**（不报错，交给调用方判必填）。
 *
 * ⚠️ 解密失败**不抛**（降级成"没值"，同文件头 ③ 的坑预判 5）：主密钥轮换后
 * "某人需要重填一个令牌"绝不该表现成"这个系统坏了"。
 */
export async function decryptMyCredentialValues(
  serverId: string,
  userId: string,
): Promise<McpDecryptedCredentials> {
  const db = getPrisma()
  const row = await db.mcpCredential.findUnique({
    where: { serverId_userId: { serverId, userId } },
    select: { valuesEnc: true },
  })
  const { values, broken } = decryptCipherMap(serverId, userId, readCipherMap(row === null ? null : row.valuesEnc))
  return { values, brokenKeys: broken }
}

/**
 * 行（可能不存在）+ server → 契约里的凭据条目（**唯一的出口**，见文件头 ②）。
 *
 * ⚠️ `fields` 按**模板**投影（模板里已删除的 key 即使库里还有值也不出现）：
 * 那些值已经不会被注入，界面不该拿它们冒充可用参数（P0-2-3 定案：只提示、绝不自动清理）。
 * 但 `presentKeys` 的覆盖面是 `values` 里的全部 key（它们仍参与"绑定层"的校验）。
 */
function toCredentialItem(
  server: { id: string; name: string; slug: string; credentialSchema: unknown },
  row: { valuesEnc: unknown; updatedAt: Date } | null,
  viewerId: string,
): McpCredentialItem {
  const schema = normalizeCredentialSchema(server.credentialSchema)
  const cipherMap = readCipherMap(row === null ? null : row.valuesEnc)
  const presentKeys = verifiedKeys(server.id, viewerId, cipherMap)

  const missingKeys = missingRequiredCredentialKeys(schema, presentKeys)
  return {
    serverId: server.id,
    serverName: server.name,
    serverSlug: server.slug,
    fields: schema.map((entry) => ({
      key: entry.key,
      label: entry.label,
      inject: entry.inject,
      // 归一化：模板里省略 `required` = 非必填（界面上是否标红星只看这个布尔）
      required: entry.required === true,
      hasValue: presentKeys.has(entry.key),
      placeholder: entry.placeholder ?? null,
    })),
    missingKeys,
    configured: isCredentialConfigured(schema, presentKeys),
    // ⚠️ 与 `configured` **大致同向但不完全等价**：空模板（无参数）时"从没写过"也是 `configured:true`
    updatedAt: row === null ? null : row.updatedAt.toISOString(),
  }
}

function toUnconfigured(item: McpCredentialItem): McpUnconfiguredServer {
  return {
    serverId: item.serverId,
    serverName: item.serverName,
    serverSlug: item.serverSlug,
    missingKeys: item.missingKeys,
  }
}

/** server 的查询白名单（本文件用到的列；`endpointUrl` 等一律不取 —— 用不到就不读） */
const CREDENTIAL_SERVER_SELECT = {
  id: true,
  name: true,
  slug: true,
  credentialSchema: true,
} as const

// ═════════════════════════════════════════════════════════════════════
// 读
// ═════════════════════════════════════════════════════════════════════

/**
 * 我的凭据（`GET /api/mcp/credentials`，登录即可、**只看自己的**）。
 *
 * 两面一起给（`06` P0-2-4 验收门槛 5）：`items` 是"每个 server × 我"的完整状态（凭据页按它分组
 * 渲染表单），`unconfigured` 是其中"还差必填项"的**瘦投影**（`03` §4.5 的置顶提示）——
 * 同一次查询算出两半，传的是同一份事实。
 *
 * ⚠️ **刻意不分页**：本页是一张"按 server 分组的长表单"，而"未配置置顶"必须跨全部 server 成立
 * （分页会让提示只对当前页有效）。理由与代价写在 `shared#mcpCredentialListResultSchema`。
 *
 * ⚠️ 排序 `createdAt asc, id asc`：与 `/api/mcp/servers` 一致 —— 两个页面的分组顺序一样，
 * 用户来回跳不会看到"顺序变了"。
 */
export async function listMyCredentials(viewer: McpCredentialViewer): Promise<McpCredentialListResult> {
  const db = getPrisma()
  // 一个事务里取两份（"server 列表"与"我的凭据"必须来自同一快照，否则会出现
  // "某个 server 的数据没读出来 ⇒ 界面显示未配置"这种闪一下的假象）
  const [servers, mine] = await db.$transaction([
    db.mcpServer.findMany({
      select: CREDENTIAL_SERVER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.mcpCredential.findMany({
      where: { userId: viewer.userId },
      select: { serverId: true, valuesEnc: true, updatedAt: true },
    }),
  ])

  const byServerId = new Map(mine.map((row) => [row.serverId, row]))
  const items = servers.map((server) =>
    toCredentialItem(server, byServerId.get(server.id) ?? null, viewer.userId),
  )

  getLogger().debug(
    {
      userId: viewer.userId,
      serverCount: items.length,
      configuredCount: items.filter((item) => item.configured).length,
    },
    '已读取我的 MCP 凭据清单',
  )
  return { items, unconfigured: items.filter((item) => !item.configured).map(toUnconfigured) }
}

// ═════════════════════════════════════════════════════════════════════
// 写（合并语义，见文件头 ④）
// ═════════════════════════════════════════════════════════════════════

/**
 * 写入/更新我的凭据（`PUT /api/mcp/credentials/:serverId`，登录即可、**只写自己的**）。
 *
 * 顺序（每一环的位置都有理由）：
 *   ① server 不存在 ⇒ **404**（请求本身的问题）；
 *   ② 提交的 key **必须都在当前模板里** ⇒ 否则 400（消息只列**键名**，不回声任何值）；
 *   ③ 与库里那份**合并**（空串 = 删掉该 key）；
 *   ④ 合并后一个 key 都不剩 ⇒ **删行**（而不是存 `{}`）；
 *   ⑤ upsert 一次写回，返回**重读后的条目**（`updatedAt` 由 Prisma 维护）。
 *
 * @throws {AppError} `NOT_FOUND`(404) server 不存在 / `VALIDATION`(400) 提交了模板里没有的 key
 */
export async function putMyCredential(
  serverId: string,
  input: PutMyCredentialBody,
  viewer: McpCredentialViewer,
): Promise<McpCredentialItem> {
  const db = getPrisma()
  const server = await db.mcpServer.findUnique({ where: { id: serverId }, select: CREDENTIAL_SERVER_SELECT })
  if (server === null) throw AppError.notFound(appMsg('app.m004'))

  const schema: CredentialSchemaEntry[] = normalizeCredentialSchema(server.credentialSchema)
  const templateKeys = new Set(schema.map((entry) => entry.key))

  // ⚠️ 只报**键名**（绝不含值）：这条错误会进日志与响应体，是"借错误消息漏凭据"的经典入口
  const unknownKeys = Object.keys(input.values).filter((key) => !templateKeys.has(key))
  if (unknownKeys.length > 0) {
    throw AppError.validation(appMsg('app.m267', { p0: unknownKeys.join('、') }),
    )
  }

  const existing = await db.mcpCredential.findUnique({
    where: { serverId_userId: { serverId, userId: viewer.userId } },
    select: { valuesEnc: true },
  })

  // 合并：只动提交里出现的 key。**空串 = 删掉这个键**（不是存空密文，见文件头 ④）
  const next = readCipherMap(existing === null ? null : existing.valuesEnc)
  const cleared: string[] = []
  const written: string[] = []
  for (const [key, value] of Object.entries(input.values)) {
    if (value === '') {
      delete next[key]
      cleared.push(key)
    } else {
      next[key] = encryptSecret(value, mcpCredentialAad(serverId, viewer.userId, key))
      written.push(key)
    }
  }

  const remaining = Object.keys(next)
  if (remaining.length === 0) {
    // 合并后什么都不剩 ⇒ **删行**：留一个 `values:{}` 的空行会让"我有凭据"这句话变成假的
    // （`configured` 现在不依赖它，但下一个人会依赖 —— 空行是纯粹的误导）
    await db.mcpCredential.deleteMany({ where: { serverId, userId: viewer.userId } })
    getLogger().info(
      { mcpServerId: serverId, userId: viewer.userId, clearedKeys: cleared.sort() },
      '我的 MCP 凭据已清空（最后一个参数被清掉 ⇒ 记录删除）',
    )
    return toCredentialItem(server, null, viewer.userId)
  }

  const saved = await db.mcpCredential.upsert({
    where: { serverId_userId: { serverId, userId: viewer.userId } },
    create: {
      serverId,
      userId: viewer.userId,
      valuesEnc: next as Prisma.InputJsonValue,
    },
    update: { valuesEnc: next as Prisma.InputJsonValue },
    select: { valuesEnc: true, updatedAt: true },
  })

  // ⚠️ 日志只有**键名**与条数（文件头 ⑥）：这里真的经手了明文与密文，一个字段都不能带出去
  getLogger().info(
    {
      mcpServerId: serverId,
      userId: viewer.userId,
      writtenKeys: written.sort(),
      clearedKeys: cleared.sort(),
      keyCount: remaining.length,
    },
    '已保存我的 MCP 凭据（合并写入）',
  )
  return toCredentialItem(server, saved, viewer.userId)
}

/**
 * 删除我的凭据（`DELETE /api/mcp/credentials/:serverId`，登录即可、**只删自己的**）。
 *
 * ⚠️ **本来就没配 ⇒ 404**（不是 200 的幂等成功）：本端点删的是"**我的那一份**"，
 * "你没有可删的东西"比"删除成功"更准确 —— 前端弹的是 Popconfirm，这正该是它说的话。
 * 与 `/api/mcp/servers/:id` 的 404（不存在）同码但主语不同：那边是"这个 server 不存在"，
 * 这边是"**我**在这台 server 上没有凭据"。
 *
 * @throws {AppError} `NOT_FOUND`(404)
 */
export async function removeMyCredential(
  serverId: string,
  viewer: McpCredentialViewer,
): Promise<RemoveMyCredentialResult> {
  const db = getPrisma()
  const server = await db.mcpServer.findUnique({
    where: { id: serverId },
    select: { id: true, name: true },
  })
  if (server === null) throw AppError.notFound(appMsg('app.m004'))

  const deleted = await db.mcpCredential.deleteMany({ where: { serverId, userId: viewer.userId } })
  if (deleted.count === 0) throw AppError.notFound(appMsg('app.m177'))

  getLogger().info({ mcpServerId: serverId, userId: viewer.userId }, '已删除我的 MCP 凭据')
  return { serverId: server.id, serverName: server.name }
}

// ═════════════════════════════════════════════════════════════════════
// 给 P0-2-3 的 PATCH 响应用：受影响的已存凭据条数（`credentialSchemaImpact`）
// ═════════════════════════════════════════════════════════════════════

/**
 * `values` 里含任一 `removedKeys` 的**已存凭据条数**（全库口径 —— 这是关于**这台 server**的
 * 一句陈述，不是"我自己的"；`PATCH /api/mcp/servers/:id` 的响应里那句提示也是给所有人的）。
 *
 * 这个数在 P0-2-3 时**刻意留白为 `null`**（表还不存在，后端没能力回答），本批兑现成真数。
 *
 * 三条判据：
 *   · 只数 `removedKeys` —— `addedKeys` 是"缺值"（没有任何已存的值受影响）、
 *     `retargetedKeys` 是"值还在、只是注入了别处"，都不该进这个数；
 *   · **不判解密**：这里问的是"哪些行里有这个键"，键名不加密（密文才是值）——
 *     解不开的密文照样占着这个键，用户仍会看到"这个参数已经没用了"，结论不变；
 *   · `removedKeys` 为空 ⇒ `0`（**一条查询都不发**）。
 *
 * ⚠️ 全库口径意味着任何一个登录用户都能问出"有几条凭据受影响" —— 这是**刻意**的：
 *   它是个计数（不是名单、不是值），而这台 server 的模板本来就人人可见（`06` §4.2 第五族）。
 */
export async function countAffectedCredentials(serverId: string, removedKeys: readonly string[]): Promise<number> {
  if (removedKeys.length === 0) return 0
  const db = getPrisma()
  const removed = new Set(removedKeys)
  const rows = await db.mcpCredential.findMany({ where: { serverId }, select: { valuesEnc: true } })
  return rows.filter((row) => credentialValueKeys(readCipherMap(row.valuesEnc)).some((key) => removed.has(key))).length
}
