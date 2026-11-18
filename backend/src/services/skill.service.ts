/**
 * Skill 资产服务（P1-24a-1 骨架）
 *
 * 依据：`docs/子方案/Skill能力.md` §2.2 / §3.1 / §3.2 / §5.3 / §6.1
 *      + `docs/02-后端设计.md` §三（`skills` / `skill_files`）+ §4.4「契约增量 · 组件绑定新增 SKILL」
 *      + `shared/src/skill.ts`（契约）与 `services/skillZip.ts`（导入解包与校验）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批（a-1）**只有"资产侧的纯逻辑与判据"**，没有任何 HTTP 端点
 * ─────────────────────────────────────────────────────────────────────
 * 落地的是：`slug` 派生、未删除范围内判重、可见性归一（拒绝 `SHARED`）、ACL 判据转调、
 * S3 键拼法、`skill_files` 行投影。**没有**列表/详情/导入/删除端点，也没有 `PUT` 写库 ——
 * 那些属 a-2，它只调用本文件与 `skillZip.ts`，不需要再改这里的判据。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 六条口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **`slug` 只允许 ASCII**：纯中文名不能折成空串再靠序号凑 —— 折不出来时回落
 *    `skill-<shortid>`（`子方案` §2.2 点名了 MCP `uniqueSlug` 的中文碰撞问题）。
 *    用户手填的 slug 也过同一个正则（{@link SKILL_SLUG_PATTERN}），一处定义。
 * ② **判重只在"未删除范围"内**：`skills` 上刻意**没有** Prisma `@unique`，靠迁移里手写的
 *    两条部分唯一索引（`WHERE deleted_at IS NULL`）。⇒ 按 slug 查必须
 *    `findFirst({ where: { slug, deletedAt: null } })`，**不能**用 `findUnique`
 *    （软删一条后它的 slug/name 要能立刻复用）。
 * ③ **可见性只支持 `PRIVATE` / `PUBLIC`**：列复用 `AssetVisibility` 三值，但 `SHARED` 对 Skill
 *    是"能选、没效果"的档位（没有受众表）⇒ 写入口一律 `VALIDATION` 400（`app.m290`）。
 * ④ **ACL 转调 `shared/src/assetAcl.ts`**：`canViewAsset` / `canEditAsset` / `canTransferAsset`
 *    / `assetVisibilityWhere`，**不新增第二套判据**（`06` §六 的"唯一来源"纪律）。
 * ⑤ **S3 键只有两种拼法**：`skills/{id}/v{n}/...` 与 `skill-overrides/{conversationId}/{skillId}/r{n}/...`
 *    —— 都由 `shared/src/skill.ts` 的前缀函数生成，本文件不自己拼字符串。
 * ⑥ **旧版本只回收对象、保留 `skill_files` 行**（`storageKey` 置空 = 正文已归档）：
 *    `tool_calls` 里的 `skillSlug + skillVersion + path` 永久留在历史消息里，
 *    连行都删掉之后"那一版有哪些文件"就再也定位不到。表现层判据是 {@link isPurgedSkillFile}。
 */

import { appMsg,
  AppError,
  ASSET_VISIBILITIES,
  assetVisibilityWhere,
  canEditAsset,
  canTransferAsset,
  canViewAsset,
  MCP_SLUG_FALLBACK,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_ERROR_CODES,
  SKILL_NAME_MAX_CHARS,
  SKILL_SLUG_MAX_CHARS,
  SKILL_VISIBILITIES,
  isLikelyScriptPath,
  skillDescriptionWithinLimit,
  skillStoragePrefix,
  slugifyServerName,
  type AssetVisibility,
  type SkillRuntime,
  type SkillSourceType,
  type SkillVisibility,
} from '@doubulea/shared'

import { getPrisma } from '../infra/prisma.js'

/** 调用者（`AuthContext['user']` 的结构子集；与 `agent.service.ts#AgentViewer` 同形） */
export interface SkillViewer {
  id: string
  role: 'ADMIN' | 'MEMBER'
}

/** Skill 的行投影（列表 / 详情 / 写后回读共用一份；同 `02` §4.4 的 `canEdit` / `creatorName` 口径） */
const SKILL_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  runtime: true,
  version: true,
  visibility: true,
  // P1-24a-2：列表 / 详情 / 导入结果的投影需要这几列（版本、来源、依赖、fork 关系）
  sourceType: true,
  sourceConversationId: true,
  sourceMessageIds: true,
  requiresBins: true,
  manifest: true,
  parentSkillId: true,
  parentVersion: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  creator: { select: { username: true, nickname: true } },
} as const

/** {@link SKILL_SELECT} 的产物形态（手写出来给投影函数用） */
export interface SkillRow {
  id: string
  name: string
  slug: string
  description: string
  runtime: SkillRuntime
  version: number
  visibility: AssetVisibility
  sourceType: SkillSourceType
  /** 来源会话（`sourceType=CONVERSATION` 时有值；**不建 FK**） */
  sourceConversationId: string | null
  /** `source_message_ids`（jsonb；脏值按空数组投影） */
  sourceMessageIds: unknown
  requiresBins: unknown
  /** `SKILL.md` 原始 frontmatter（非受控键在预览 / 下载时原样带回） */
  manifest: unknown
  parentSkillId: string | null
  parentVersion: number | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  creator: { username: string; nickname: string | null }
}

// ═════════════════════════════════════════════════════════════════════
// slug（派生 / 校验）
// ═════════════════════════════════════════════════════════════════════

/**
 * 合法 slug 的**唯一正则**（小写 ASCII 字母/数字/连字符，字母或数字开头与结尾）。
 *
 * 它同时被三处消费：服务端生成后的自检、用户手填 slug 的校验、前端提示文案
 * （`validation.skill.slugInvalid`）。写法与 `mcp.ts#slugifyServerName` 的产出**必然兼容**
 * （那边折出来的就是这套字符集）。
 */
export const SKILL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u

/** slug 是否合法（见 {@link SKILL_SLUG_PATTERN}） */
export function isValidSkillSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SKILL_SLUG_MAX_CHARS && SKILL_SLUG_PATTERN.test(slug)
}

/**
 * `name`（或来源字符串）→ 候选 slug。
 *
 * 复用 MCP 那套 ASCII 化（`slugifyServerName`）保证两处口径一致，但**改掉它的兜底**：
 * MCP 折成空串时回落 `server`（那是一台 server，平台里没几个）；
 * Skill 是**用户资产**，"我的 Skills"里出现一排 `server` / `server-2` 完全无法辨认
 * ⇒ 这里回落 `skill-<shortid>`（`子方案` §2.2 的要求）。
 *
 * @param shortid 建议传 `id.slice(-8)`（uuid7 的尾段是随机的，够短又几乎不撞）
 */
export function skillSlugOf(name: string, shortid: string): string {
  const base = slugifyServerName(name)
  if (base !== MCP_SLUG_FALLBACK && isValidSkillSlug(base)) return base
  const fallback = `skill-${shortid.replace(/[^a-z0-9]/gu, '').toLowerCase()}`.slice(0, SKILL_SLUG_MAX_CHARS)
  return isValidSkillSlug(fallback) ? fallback : `skill-${Date.now().toString(36)}`
}

/**
 * 在"未删除范围内"挑一个不冲突的 slug（best-effort；**唯一性最终由部分唯一索引兜**）。
 *
 * ⚠️ 与 MCP `uniqueSlug` 一样是 best-effort：并发创建同名 Skill 时两次都能查到"没占用"，
 * 结果一条撞索引 ⇒ 服务层把它翻成 `409 SKILL_SLUG_TAKEN`（而不是 500）。
 * 不做"先占位再改"的两阶段 —— 那会让 SKILL.md 里的 `slug` 与库里不一致。
 */
export async function uniqueSkillSlug(candidate: string): Promise<string> {
  const base = candidate.slice(0, SKILL_SLUG_MAX_CHARS)
  const rows = await getPrisma().skill.findMany({
    where: { deletedAt: null, slug: { startsWith: base.slice(0, Math.max(1, base.length - 4)) } },
    select: { slug: true },
  })
  const taken = new Set(rows.map((row) => row.slug))
  if (!taken.has(base) && isValidSkillSlug(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`
    const head = base.slice(0, Math.max(1, SKILL_SLUG_MAX_CHARS - suffix.length)).replace(/-+$/u, '')
    const next = `${head}${suffix}`
    if (!taken.has(next) && isValidSkillSlug(next)) return next
  }
}

// ═════════════════════════════════════════════════════════════════════
// 判重与可见性
// ═════════════════════════════════════════════════════════════════════

/**
 * 判重：`(createdBy, name)` 在**未删除范围**内唯一（迁移里的 partial unique index 同口径）。
 *
 * @param excludeId 更新时排除自己
 * @returns `'name'` = 重名、`'slug'` = slug 重复、`null` = 都可以用
 *
 * ⚠️ 存在性判据**不在 Prisma schema 里**（`@unique` 加不了 `WHERE`），所以这里是"可读的错误"，
 * 索引是"并发的兜底"：两条都要。只靠索引 ⇒ 用户看到的是 `P2002`；只靠这里 ⇒ 并发下会漏。
 */
export async function findSkillConflict(input: {
  createdBy: string
  name: string
  slug: string
  excludeId?: string
}): Promise<'name' | 'slug' | null> {
  const db = getPrisma()
  const [nameRow, slugRow] = await Promise.all([
    db.skill.findFirst({
      where: {
        deletedAt: null,
        createdBy: input.createdBy,
        name: input.name,
        ...(input.excludeId === undefined ? {} : { id: { not: input.excludeId } }),
      },
      select: { id: true },
    }),
    db.skill.findFirst({
      where: {
        deletedAt: null,
        slug: input.slug,
        ...(input.excludeId === undefined ? {} : { id: { not: input.excludeId } }),
      },
      select: { id: true },
    }),
  ])
  if (nameRow !== null) return 'name'
  if (slugRow !== null) return 'slug'
  return null
}

/**
 * 判重失败 → 409（`data.code = SKILL_SLUG_TAKEN` / `SKILL_NAME_TAKEN`）。**唯一的抛错出口**。
 */
export function assertNoSkillConflict(conflict: 'name' | 'slug' | null, name: string): void {
  if (conflict === 'name') {
    throw AppError.conflict(appMsg('app.m291', { p0: name }), { code: SKILL_ERROR_CODES.NAME_TAKEN })
  }
  if (conflict === 'slug') {
    throw AppError.conflict(appMsg('app.m292', { p0: name }), { code: SKILL_ERROR_CODES.SLUG_TAKEN })
  }
}

/**
 * 可见性归一：**只允许 `PRIVATE` / `PUBLIC`**（`SHARED` ⇒ 400 `app.m290`）。缺省 = `PRIVATE`。
 *
 * 为什么不做"`SHARED` 悄悄降级成 `PRIVATE`"：那会让用户以为分享给了那几个人，
 * 实际一个人都看不到（Skill 没有受众表）。静默降级比报错坏得多。
 */
export function normalizeSkillVisibility(input: string | undefined): SkillVisibility {
  if (input === undefined) return 'PRIVATE'
  if ((SKILL_VISIBILITIES as readonly string[]).includes(input)) return input as SkillVisibility
  // `SHARED` 与任何非法值都走同一句文案：对 Skill 来说它们都是"这个档位不存在"
  throw AppError.validation(appMsg('app.m290'), {
    allowed: SKILL_VISIBILITIES,
    received: input,
    allVisibilities: ASSET_VISIBILITIES,
  })
}

/** 由 Skill 行构造 ACL 判据的输入（`createdBy` 即所属人；软删由 `deletedAt` 表达） */
function aclSubjectOf(row: Pick<SkillRow, 'createdBy' | 'visibility' | 'deletedAt'>): {
  ownerId: string
  visibility: AssetVisibility
  deletedAt: Date | null
} {
  return { ownerId: row.createdBy, visibility: row.visibility, deletedAt: row.deletedAt }
}

/** 可见（能发现 / 能绑到自己的 Agent）—— 转调 `canViewAsset`，不另写判据 */
export function canViewSkill(row: Pick<SkillRow, 'createdBy' | 'visibility' | 'deletedAt'>, viewer: SkillViewer): boolean {
  return canViewAsset(aclSubjectOf(row), viewer)
}

/** 可编删（改名 / 改描述 / 改可见范围 / 软删）—— 所属人 + ADMIN */
export function canEditSkill(row: Pick<SkillRow, 'createdBy' | 'visibility' | 'deletedAt'>, viewer: SkillViewer): boolean {
  return canEditAsset(aclSubjectOf(row), viewer)
}

/** 可转移所属人 —— 与可编辑同判据（`canTransferAsset` 委托 `canEditAsset`，见 `assetAcl.ts`） */
export function canTransferSkill(
  row: Pick<SkillRow, 'createdBy' | 'visibility' | 'deletedAt'>,
  viewer: SkillViewer,
): boolean {
  return canTransferAsset(aclSubjectOf(row), viewer)
}

/**
 * 列表过滤（按"对我可见"）：`assetVisibilityWhere` + `deletedAt: null`。
 *
 * ⚠️ Skill **没有受众**（两档）⇒ 这里不传 `withAudience`（缺省 false），否则 `where` 会引用
 * 一个不存在的 `audiences` 关联，Prisma 直接报错（`assetAcl.ts` 已把这个坑写在参数注释里）。
 */
export function skillVisibilityWhere(viewer: SkillViewer): Record<string, unknown> {
  return { deletedAt: null, ...assetVisibilityWhere(viewer) }
}

// ═════════════════════════════════════════════════════════════════════
// 版本 / 存储键
// ═════════════════════════════════════════════════════════════════════

/** 当前版本的 S3 前缀（`skills/{id}/v{n}/`；由 `shared` 的唯一拼法生成） */
export function skillCurrentPrefix(skill: { id: string; version: number }): string {
  return skillStoragePrefix(skill.id, skill.version)
}

/**
 * `skill_files` 的一行是否**正文已归档**（过了保留期：S3 对象删了、行还在）。
 *
 * 判据只有 `storageKey === ''` 这一条（迁移里 `storage_key` 非空约束，回收时置空）。
 * 表现层据此回 409 `SKILL_VERSION_PURGED`，而不是"返回空文件"或"悄悄换成最新版"。
 */
export function isPurgedSkillFile(row: { storageKey: string }): boolean {
  return row.storageKey === ''
}

/**
 * 按 `(skillId, version)` 取该版本的**文件索引**（一次查完，按 path 升序保证稳定）。
 *
 * 消费方 = a-2 的文件预览 / 下载，与 a-3 的 `load_skill`（ChatBot 从 S3 读正文前先查索引）。
 */
export async function listSkillFiles(skillId: string, version: number): Promise<
  { path: string; size: number; mime: string; sha256: string; storageKey: string; purged: boolean }[]
> {
  const rows = await getPrisma().skillFile.findMany({
    where: { skillId, version },
    select: { path: true, size: true, mime: true, sha256: true, storageKey: true },
    orderBy: { path: 'asc' },
  })
  return rows.map((row) => ({ ...row, purged: isPurgedSkillFile(row) }))
}

/** 名称 / 描述的基本形态校验（a-2 建 / 改时用；这里集中一次，免得两处各写一遍） */
export function assertSkillMetadata(input: { name: string; description: string }): void {
  const name = input.name.trim()
  const reasons: string[] = []
  if (name === '') reasons.push('名称为空')
  if ([...name].length > SKILL_NAME_MAX_CHARS) {
    reasons.push(`名称超过 ${String(SKILL_NAME_MAX_CHARS)} 个字符`)
  }
  if (input.description.trim() === '') {
    reasons.push('description 为空（它是模型选择 Skill 的唯一依据）')
  } else if (!skillDescriptionWithinLimit(input.description)) {
    reasons.push(`description 超过 ${String(SKILL_DESCRIPTION_MAX_CHARS)} 个字符`)
  }
  if (reasons.length > 0) {
    throw AppError.validation(appMsg('app.m289', { p0: reasons.join('；') }), {
      code: SKILL_ERROR_CODES.IMPORT_INVALID,
      reasons,
    })
  }
}

export { SKILL_SELECT }

/**
 * 批量判定"当前版本是否含脚本"（列表 / 绑定校验共用；一次查询，不在 JS 里读 S3）。
 *
 * 传进来的每项必须是**当前版本**；老版本的脚本不影响"现在这个 Skill 有没有脚本"。
 * 判据是 {@link isLikelyScriptPath}（跨目录识别），不是只看 `scripts/**`。
 */
export async function skillHasScriptsMap(
  skills: readonly { id: string; version: number }[],
): Promise<Map<string, boolean>> {
  const unique = [...new Map(skills.map((skill) => [skill.id, skill])).values()]
  const result = new Map(unique.map((skill) => [skill.id, false]))
  if (unique.length === 0) return result
  const versionById = new Map(unique.map((skill) => [skill.id, skill.version]))
  const rows = await getPrisma().skillFile.findMany({
    where: { OR: unique.map((skill) => ({ skillId: skill.id, version: skill.version })) },
    select: { skillId: true, version: true, path: true },
  })
  for (const row of rows) {
    if (row.version !== versionById.get(row.skillId)) continue
    if (isLikelyScriptPath(row.path)) result.set(row.skillId, true)
  }
  return result
}
