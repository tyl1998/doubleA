/**
 * Skill 管理面服务（P1-24a-2；`docs/子方案/Skill能力.md` §5.1 / §5.2 / §5.3）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与 `skill.service.ts` 的分工（别把判据写两遍）
 * ─────────────────────────────────────────────────────────────────────
 * · `skill.service.ts`（a-1）= **纯判据与投影**：slug 派生、判重、可见性归一、ACL 转调、
 *   `skill_files` 行投影。**不写库**。
 * · 本文件（a-2）= **编排**：解包（`skillZip.ts`）→ 写 S3 → 事务里切版本 → 投影成 HTTP 契约。
 *   它只**调用**上面那些判据，不另写一份（`06` §六 的"唯一来源"纪律）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 五条落地口径（每一条错了都只在运行期才暴露）
 * ─────────────────────────────────────────────────────────────────────
 * **① 顺序：先 S3、后 DB；DB 失败按前缀回收刚写的对象。**
 *    反过来（先建行）一旦 S3 失败就留下"行在、文件没了"的 Skill —— 绑上去之后读正文时才炸，
 *    且用户看不出是哪一步坏的。S3 先写则最坏情况是"多了一批没人引用的对象"，本函数会顺手删掉。
 *
 * **② 新建与重新导入共用一条路径**（{@link importSkillPackage}），差别只有 `targetId`：
 *    判重（slug / name）只在**新建**时做；重新导入保留原 slug、只升版本。
 *
 * **③ 版本切换在一个事务里**：`skills.version + 1`、把这一版的全部文件写成新的 `skill_files` 行、
 *    写一条 `SkillChange`。**不删旧版本行**（保留期内可回读正文；过了保留期只回收对象、行留着）。
 *
 * **④ 软删（`deleted_at`）而不是硬删**，且**被 Agent 绑定时 409**（`agent_components.ref_id`
 *    是多态外键、刻意不建 FK ⇒ 数据库不会拦，必须服务层拦）。与知识库那套不同：那里是
 *    "删库时自动解绑"，这里不自动解绑 —— Skill 能执行脚本，静默让别人的 Agent 少一个能力比报错更糟。
 *
 * **⑤ `SKILL.md` 的正文以 DB 字段为准**：读 `SKILL.md` 时用 `composeSkillMarkdown()` 按
 *    `name/description/runtime/requiresBins` 重生成 frontmatter（包里的那份可能已过期）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批不做（按批边界，`06` P1-24 每批边界）
 * ─────────────────────────────────────────────────────────────────────
 * 不注册任何模型工具、不改 ChatBot / TaskAgent 运行时、不写会话级覆写、不做内容编辑（草稿链属 c 批）。
 * 下载统一为整包 zip，复用工作区的零依赖写入器 —— 见 {@link openSkillArchiveSource}。
 */

import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import {
  appMsg,
  AppError,
  ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  isLikelyScriptPath,
  isPreviewableSkillMime,
  isSafeSkillPath,
  previewKindOf,
  skillPageOf,
  skillStoragePrefix,
  SKILL_PAGE_DEFAULT_LIMIT,
  type AssetVisibility,
  type ImportSkillResult,
  type ListSkillsQuery,
  type RemoveSkillResult,
  type SkillChange,
  type SkillDetail,
  type SkillFileEntry,
  type SkillFilePreview,
  type SkillItem,
  type SkillListResult,
  type SkillPage,
  type SkillVersion,
  type UpdateSkillBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma, Prisma } from '../infra/prisma.js'
import { getS3Client, isS3NoSuchKey } from '../infra/s3.js'
import { buildZip, type ZipEntry } from '../workspace/zip.js'
import { renderDocxToHtml } from './docxPreview.js'
import { buildContentDisposition } from './document.service.js'
import {
  SKILL_SELECT,
  assertNoSkillConflict,
  canEditSkill,
  canViewSkill,
  findSkillConflict,
  isPurgedSkillFile,
  normalizeSkillVisibility,
  skillHasScriptsMap,
  skillSlugOf,
  skillVisibilityWhere,
  uniqueSkillSlug,
  type SkillRow,
  type SkillViewer,
} from './skill.service.js'
import {
  composeSkillMarkdown,
  importError,
  parseSkillZip,
  stripFrontmatter,
  type ParsedSkillZip,
} from './skillZip.js'
import { parseXlsx, renderXlsxToHtml } from './xlsxPreview.js'

/** 详情里变更记录的条数上限（版本历史页只需回看最近几版；完整列表属将来的分页端点） */
const SKILL_CHANGES_PAGE_LIMIT = 50

// ═════════════════════════════════════════════════════════════════════
// 投影
// ═════════════════════════════════════════════════════════════════════

/**
 * 上游（fork 来源）的展示信息（P1-24c-5）。
 *
 * `deleted` 与 `available` 是两件事：软删的上游行还在（名字还能显示），但**不可用**；
 * 行已不存在时名字取不到（`name=null`），界面只说「来源 Skill 已删除」。
 */
export interface SkillParentInfo {
  name: string | null
  available: boolean
  deleted: boolean
  latestVersion: number | null
}

const NO_SKILL_PARENT: SkillParentInfo = { name: null, available: false, deleted: false, latestVersion: null }

/**
 * 行 → 列表 / 详情共用的元数据（`02` §4.4 的 `canEdit` / `creatorName` 口径，与知识库同款）。
 *
 * @param availableSource 可选的"来源会话仍然存在"集合（P1-24c-2）：列表 / 详情**批量**查一次后传进来，
 *   不给 ⇒ 一律按"不可用"投影（`sourceAvailable=false`）—— 展示层据此显示"来源会话已删除"。
 * @param parent 副本的上游展示信息（P1-24c-5；非副本不用传）
 */
export function toItem(
  row: SkillRow,
  viewer: SkillViewer,
  availableSource?: ReadonlySet<string>,
  parent?: SkillParentInfo,
  hasScripts = false,
  pendingProposalCount = 0,
): SkillItem {
  const parentInfo = parent ?? NO_SKILL_PARENT
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    runtime: row.runtime,
    version: row.version,
    // DB 列是三值枚举；Skill 只会是 PRIVATE / PUBLIC（写入口拒绝 SHARED），历史脏行按 PRIVATE 投影
    visibility: row.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    sourceType: row.sourceType,
    requiresBins: requiresBinsOf(row.requiresBins),
    hasScripts,
    createdBy: row.createdBy,
    creatorName: row.creator.nickname ?? row.creator.username,
    canEdit: canEditSkill(row, viewer),
    pendingProposalCount: canEditSkill(row, viewer) ? pendingProposalCount : 0,
    parentSkillId: row.parentSkillId,
    parentVersion: row.parentVersion,
    parentName: row.parentSkillId === null ? null : parentInfo.name,
    parentAvailable: row.parentSkillId === null ? false : parentInfo.available,
    parentDeleted: row.parentSkillId === null ? false : parentInfo.deleted,
    parentLatestVersion: row.parentSkillId === null ? null : parentInfo.latestVersion,
    sourceConversationId: row.sourceConversationId,
    sourceMessageIds: stringArrayOf(row.sourceMessageIds),
    sourceAvailable:
      row.sourceConversationId !== null && (availableSource?.has(row.sourceConversationId) ?? false),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 取一批副本的上游展示信息（**一次查询**；`parentSkillId` 去重）。
 *
 * 不按 `deletedAt` 过滤：软删的上游还要显示名字（「来源：X · 已删除」）——
 * 这与 `findSkillRow` 的"软删即不存在"是不同的问题（那是读正文 / 判权）。
 */
export async function loadParentInfo(
  rows: readonly Pick<SkillRow, 'parentSkillId'>[],
  viewer: SkillViewer,
): Promise<Map<string, SkillParentInfo>> {
  const ids = [...new Set(rows.map((row) => row.parentSkillId).filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const parents = await getPrisma().skill.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, version: true, createdBy: true, visibility: true, deletedAt: true },
  })
  const map = new Map<string, SkillParentInfo>()
  for (const parent of parents) {
    const visible = parent.deletedAt === null && canViewSkill(parent, viewer)
    map.set(parent.id, {
      name: parent.name,
      available: visible,
      deleted: parent.deletedAt !== null,
      latestVersion: visible ? parent.version : null,
    })
  }
  // 行已不存在（上游硬删）⇒ 名字取不到，但「已删除」这个结论必须成立
  for (const id of ids) {
    if (!map.has(id)) map.set(id, { name: null, available: false, deleted: true, latestVersion: null })
  }
  return map
}

/** 单个副本的上游展示信息（列表以外的单行投影用） */
export async function parentInfoOf(row: SkillRow, viewer: SkillViewer): Promise<SkillParentInfo> {
  if (row.parentSkillId === null) return NO_SKILL_PARENT
  const map = await loadParentInfo([row], viewer)
  return map.get(row.parentSkillId) ?? { name: null, available: false, deleted: true, latestVersion: null }
}

/** jsonb → `string[]`（脏值一律当空数组；同 `requiresBinsOf` 的纪律） */
function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 批量取"来源会话仍然属于这些人"的集合（P1-24c-2）。
 *
 * 只查**有来源**那几行用到的会话 id（一个页面通常"没有来源"占多数）；**不建 FK** 是刻意的，
 * 所以"会话已删"只能靠这一次查询表达成 `sourceAvailable=false`，而不是靠 join。
 */
async function loadAvailableSources(rows: readonly SkillRow[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(rows.map((row) => row.sourceConversationId).filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Set()
  const found = await getPrisma().conversation.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  return new Set(found.map((row) => row.id))
}

/** `requires_bins`（jsonb）→ `string[]`；脏值一律当空数组（列表不该因一行脏数据 500） */
function requiresBinsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** `skill_files` 行 → 文件索引项 */
function toFileEntry(row: {
  path: string
  size: number
  mime: string
  sha256: string
  storageKey: string
}): SkillFileEntry {
  return {
    path: row.path,
    size: row.size,
    mime: row.mime,
    sha256: row.sha256,
    previewable: isPreviewableSkillMime(row.mime),
    purged: isPurgedSkillFile(row),
  }
}

/**
 * 取一行（**未删除**）。`deletedAt: null` 是硬判据：软删后的 Skill 对一切读路径等同不存在。
 *
 * @throws {AppError} `NOT_FOUND`(404)
 */
export async function findSkillRow(id: string): Promise<SkillRow> {
  const row = await getPrisma().skill.findFirst({ where: { id, deletedAt: null }, select: SKILL_SELECT })
  if (row === null) throw AppError.notFound(appMsg('app.m288', { p0: id }))
  return row
}

/**
 * 取一行并判权。**不可见与不存在回同一句 404**（复用 `app.m288`，不泄漏存在性 —— `子方案` §3.1）。
 *
 * @param mode `'view'` = 可见即可；`'edit'` = 所属人 / ADMIN
 */
export async function requireSkill(
  id: string,
  viewer: SkillViewer,
  mode: 'view' | 'edit',
): Promise<SkillRow> {
  const row = await findSkillRow(id)
  if (mode === 'edit') {
    if (!canEditSkill(row, viewer)) throw AppError.forbidden(appMsg('app.m295'))
  } else if (!canViewSkill(row, viewer)) {
    throw AppError.notFound(appMsg('app.m288', { p0: id }))
  }
  return row
}

// ═════════════════════════════════════════════════════════════════════
// 列表 / 详情
// ═════════════════════════════════════════════════════════════════════

/**
 * 列表（`GET /api/skills`）：按"对我可见"过滤（`PUBLIC` + 我的 + ADMIN 全部）。
 *
 * `total` 与当页数据放进同一个事务（同一快照），否则分页器会错位 —— 与知识库列表同款。
 * 关键词过滤在 SQL 里做（`contains`，大小写不敏感），**不在前端再筛一次**：那样 `total`
 * 与页内条数会各说各话。
 */
export async function listSkills(query: ListSkillsQuery, viewer: SkillViewer): Promise<SkillListResult> {
  const db = getPrisma()
  const keyword = query.query?.trim() ?? ''
  const where = {
    ...skillVisibilityWhere(viewer),
    ...(keyword === ''
      ? {}
      : {
          OR: [
            { name: { contains: keyword, mode: 'insensitive' as const } },
            { slug: { contains: keyword, mode: 'insensitive' as const } },
            { description: { contains: keyword, mode: 'insensitive' as const } },
          ],
        }),
  }
  const [rows, total] = await db.$transaction([
    db.skill.findMany({
      where,
      select: SKILL_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.skill.count({ where }),
  ])
  const editableIds = rows.filter((row) => canEditSkill(row, viewer)).map((row) => row.id)
  const [available, parents, scriptFlags, pendingCounts] = await Promise.all([
    loadAvailableSources(rows),
    loadParentInfo(rows, viewer),
    skillHasScriptsMap(rows),
    editableIds.length === 0
      ? Promise.resolve(new Map<string, number>())
      : db.skillProposal
          .groupBy({
            by: ['targetSkillId'],
            where: { targetSkillId: { in: editableIds }, status: 'PENDING' },
            _count: { _all: true },
          })
          .then(
            (groups) =>
              new Map(groups.map((group) => [group.targetSkillId, group._count._all] as const)),
          ),
  ])
  return {
    items: rows.map((row) =>
      toItem(
        row,
        viewer,
        available,
        row.parentSkillId === null ? undefined : parents.get(row.parentSkillId),
        scriptFlags.get(row.id) ?? false,
        pendingCounts.get(row.id) ?? 0,
      ),
    ),
    total,
    offset: query.offset,
    limit: query.limit,
  }
}

/**
 * 详情（`GET /api/skills/:id`）：元数据 + **当前版本**的文件索引 + 版本列表 + 变更记录 + 引用数。
 *
 * 版本列表从 `skill_files` 的 `version` 去重得来（`skill_files` 是整版快照的索引），
 * 排序 `version desc`；每个版本的 `purged` = 该版本**全部**文件都已归档。
 */
export async function getSkill(id: string, viewer: SkillViewer): Promise<SkillDetail> {
  const db = getPrisma()
  const row = await requireSkill(id, viewer, 'view')

  const [fileRows, changes, agentCount] = await Promise.all([
    db.skillFile.findMany({
      where: { skillId: id, version: row.version },
      select: { path: true, size: true, mime: true, sha256: true, storageKey: true },
      orderBy: { path: 'asc' },
    }),
    db.skillChange.findMany({
      where: { skillId: id },
      select: {
        id: true,
        skillId: true,
        fromVersion: true,
        toVersion: true,
        changeSummary: true,
        source: true,
        createdBy: true,
        createdAt: true,
        creator: { select: { username: true, nickname: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { toVersion: 'desc' }],
      take: SKILL_CHANGES_PAGE_LIMIT,
    }),
    db.agentComponent.count({ where: { componentType: 'SKILL', refId: id } }),
  ])

  const hasScripts = fileRows.some((file) => isLikelyScriptPath(file.path))
  return {
    ...toItem(row, viewer, await loadAvailableSources([row]), await parentInfoOf(row, viewer), hasScripts),
    files: fileRows.map(toFileEntry),
    versions: await listSkillVersions(id),
    changes: changes.map(
      (change): SkillChange => ({
        id: change.id,
        skillId: change.skillId,
        fromVersion: change.fromVersion,
        toVersion: change.toVersion,
        changeSummary: change.changeSummary,
        source: change.source,
        createdBy: change.createdBy,
        creatorName: change.creator.nickname ?? change.creator.username,
        createdAt: change.createdAt.toISOString(),
      }),
    ),
    agentCount,
  }
}

/** 版本列表（`GET /api/skills/:id/versions`）：按 `skill_files` 的 version 分组聚合 */
export async function listSkillVersions(skillId: string): Promise<SkillVersion[]> {
  const groups = await getPrisma().skillFile.groupBy({
    by: ['version'],
    where: { skillId },
    _count: { _all: true },
    _min: { createdAt: true },
  })
  // 「是否已归档」要按行判定 ⇒ 一次把**未归档**的条数也数出来（不在 JS 里逐行拉全表）
  const live = await getPrisma().skillFile.groupBy({
    by: ['version'],
    where: { skillId, storageKey: { not: '' } },
    _count: { _all: true },
  })
  const liveByVersion = new Map(live.map((row) => [row.version, row._count._all]))
  return groups
    .map(
      (row): SkillVersion => ({
        version: row.version,
        createdAt: (row._min.createdAt ?? new Date(0)).toISOString(),
        fileCount: row._count._all,
        purged: (liveByVersion.get(row.version) ?? 0) === 0,
      }),
    )
    .sort((a, b) => b.version - a.version)
}

// ═════════════════════════════════════════════════════════════════════
// 导入（建 / 重新导入）
// ═════════════════════════════════════════════════════════════════════

/** 导入的入参（路由层把 multipart 拆成这几项） */
export interface ImportSkillInput {
  zip: Buffer
  /** 请求显式声明的运行时（可选；给了就必须与包里的 `requires.runtime` 一致） */
  runtime?: 'INLINE' | 'SANDBOX' | undefined
  /** 新建时的覆盖项（缺省从包里的 frontmatter 派生） */
  name?: string | undefined
  description?: string | undefined
  visibility?: string | undefined
}

/** S3 对象键（`skillStoragePrefix` 是全仓唯一拼法） */
export function skillObjectKey(skillId: string, version: number, path: string): string {
  return `${skillStoragePrefix(skillId, version)}${path}`
}

/** 兼容本文件内部的旧调用名（`objectKeyOf` 是同一拼法，不新增第二套前缀） */
const objectKeyOf = skillObjectKey

/** 确保桶存在（与文档上传同款：桶是按需创建的） */
export async function ensureBucket(): Promise<string> {
  const bucket = config.s3.bucket
  const s3 = getS3Client()
  if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
  return bucket
}

/** 尽力删除一批键（失败只告警：孤儿对象是"泄漏一点存储"，比 500 好） */
export async function removeObjectsQuietly(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  const bucket = config.s3.bucket
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) return
    await s3.removeObjects(bucket, [...keys])
  } catch (error) {
    getLogger().warn(
      { err: error, bucket, count: keys.length, sample: keys.slice(0, 3) },
      'Skill 对象回收失败（残留对象需人工清理）',
    )
  }
}

/**
 * frontmatter 原始解析结果（存 `skills.manifest`，便于将来扩展）。
 *
 * 断言安全：值来自 YAML 解析结果（本来就是 JSON 可序列化的对象），与 `mcpServer.service.ts#toJsonInput` 同理。
 */
function manifestOf(parsed: ParsedSkillZip): Prisma.InputJsonValue {
  return parsed.frontmatter.raw as Prisma.InputJsonValue
}

/** 一个解包结果 → 本版要写的行（`SKILL.md` 的正文换成服务端生成的版本） */
function filesForVersion(
  parsed: ParsedSkillZip,
  meta: {
    name: string
    description: string
    runtime: 'INLINE' | 'SANDBOX'
    requiresBins: readonly string[]
    /** 包里 frontmatter 的其余键（原样保留，见 `composeSkillMarkdown` 的 `extra`） */
    extra: Readonly<Record<string, unknown>>
  },
): { path: string; bytes: Buffer; mime: string; sha256: string }[] {
  return parsed.files.map((file) => {
    if (file.path !== SKILL_ENTRY_PATH) {
      return { path: file.path, bytes: file.bytes, mime: file.mime, sha256: file.sha256 }
    }
    // frontmatter 由服务端重生成（DB 是真相源）；正文原样保留
    const body = stripFrontmatter(parsed.entryMarkdown)
    const markdown = composeSkillMarkdown({
      name: meta.name,
      description: meta.description,
      runtime: meta.runtime,
      requiresScripts: parsed.frontmatter.requires.scripts === true,
      requiresBins: meta.requiresBins,
      body,
      extra: meta.extra,
    })
    const bytes = Buffer.from(markdown, 'utf8')
    return {
      path: file.path,
      bytes,
      mime: file.mime,
      sha256: createSha256(bytes),
    }
  })
}

/** sha256（与 `skillZip.ts` 同算法） */
function createSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 导入一个 Skill 包。
 *
 * @param targetId 给了 = **重新导入**（必须已存在且可编）；不给 = **新建**
 *
 * 流程（顺序不可调换）：
 *   ① 解包校验（`parseSkillZip`，失败 ⇒ 400 `SKILL_IMPORT_INVALID` + `reasons[]`，不落半成品）；
 *   ② 新建：派生 slug、判重；重新导入：判权 + `expectedRuntime` 与库里的 runtime 一致性；
 *   ③ 写新版本的全部对象（`skills/{id}/v{n}/...`）；任一条失败 ⇒ 删掉已写的 → 500；
 *   ④ 事务：`skills.version` + `skill_files` + `SkillChange`；事务失败 ⇒ 按前缀回收刚写的对象。
 *
 * @throws {AppError} `VALIDATION`(400) 包不合法 / `CONFLICT`(409) 重名或版本冲突 /
 *   `FORBIDDEN`(403) 无编辑权 / `NOT_FOUND`(404) 重新导入的目标不存在或不可见
 */
export async function importSkillPackage(
  input: ImportSkillInput,
  viewer: SkillViewer,
  targetId?: string,
): Promise<ImportSkillResult> {
  const db = getPrisma()
  const logger = getLogger()

  // ── ① 解包（NEW：先不知道目标；IMPORT：先拿到目标 runtime 一起校验）──
  const existing = targetId === undefined ? null : await requireSkill(targetId, viewer, 'edit')
  const parsed = parseSkillZip(input.zip, {
    ...(input.runtime === undefined ? {} : { expectedRuntime: input.runtime }),
  })
  if (existing !== null && existing.runtime !== parsed.runtime) {
    throw AppError.conflict(appMsg('app.m293', { p0: existing.name }), {
      code: SKILL_ERROR_CODES.RUNTIME_NOT_ALLOWED,
    })
  }
  // `runtime` 与 `scripts/**` 的互斥已在 `parseSkillZip` 里判过（一致性校验），这里只管 DB 字段

  const name = (input.name?.trim() ?? parsed.frontmatter.name ?? (existing?.name ?? '')).trim()
  if (name === '') throw AppError.validation(appMsg('app.m299'), { code: SKILL_ERROR_CODES.IMPORT_INVALID })
  const description = (input.description?.trim() ?? parsed.frontmatter.description ?? existing?.description ?? '').trim()
  const runtime = parsed.runtime
  const requiresBins = parsed.requiresBins

  // `name` 与 `description` 会被重生成 ⇒ 不重复渲染；其余键原样保留
  const extra = Object.fromEntries(
    Object.entries(parsed.frontmatter.raw).filter(([key]) => key !== 'name' && key !== 'description'),
  )
  const files = filesForVersion(parsed, { name, description, runtime, requiresBins, extra })

  // ── ② 目标 id / 版本号 ──
  let skillId: string
  let nextVersion: number
  let slug: string
  if (existing === null) {
    const shortid = randomShortId()
    const candidate = skillSlugOf(name, shortid)
    slug = await uniqueSkillSlug(candidate)
    assertNoSkillConflict(await findSkillConflict({ createdBy: viewer.id, name, slug }), name)
    skillId = randomUuid()
    nextVersion = 1
  } else {
    skillId = existing.id
    nextVersion = existing.version + 1
    slug = existing.slug
    // 重新导入可能改名：名称判重仍然按"同一所属人下唯一"（slug 保持不变）
    if (name !== existing.name) {
      assertNoSkillConflict(
        await findSkillConflict({ createdBy: existing.createdBy, name, slug, excludeId: existing.id }),
        name,
      )
    }
  }

  // ── ③ 先写 S3 ──
  const bucket = await ensureBucket()
  const writtenKeys: string[] = []
  try {
    const s3 = getS3Client()
    for (const file of files) {
      const key = objectKeyOf(skillId, nextVersion, file.path)
      await s3.putObject(bucket, key, file.bytes, file.bytes.length, { 'Content-Type': file.mime })
      writtenKeys.push(key)
    }
  } catch (error) {
    logger.error({ err: error, skillId, nextVersion, written: writtenKeys.length }, 'Skill 对象写入失败，已中止导入')
    await removeObjectsQuietly(writtenKeys)
    throw AppError.internal(appMsg('app.m012'))
  }

  // ── ④ 再切 DB（一个事务）──
  const storageKey = skillStoragePrefix(skillId, nextVersion)
  let saved: SkillRow
  try {
    saved = await db.$transaction(async (tx) => {
      if (existing === null) {
        await tx.skill.create({
          data: {
            id: skillId,
            name,
            slug,
            description,
            runtime,
            requiresBins,
            version: nextVersion,
            manifest: manifestOf(parsed),
            sourceType: 'IMPORT',
            storageKey,
            createdBy: viewer.id,
            visibility: normalizeSkillVisibility(input.visibility),
          },
        })
      } else {
        // CAS：`version` 必须是读到的那个（并发重新导入时只有一个能成功）
        const updated = await tx.skill.updateMany({
          where: { id: skillId, version: existing.version, deletedAt: null },
          data: { name, description, runtime, requiresBins, version: nextVersion, manifest: manifestOf(parsed), storageKey },
        })
        if (updated.count === 0) {
          throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
        }
      }
      await tx.skillFile.createMany({
        data: files.map((file) => ({
          skillId,
          version: nextVersion,
          path: file.path,
          size: file.bytes.length,
          mime: file.mime,
          sha256: file.sha256,
          storageKey: objectKeyOf(skillId, nextVersion, file.path),
        })),
      })
      await tx.skillChange.create({
        data: {
          skillId,
          fromVersion: existing === null ? 0 : existing.version,
          toVersion: nextVersion,
          changeSummary:
            existing === null ? `导入 v${String(nextVersion)}（${String(files.length)} 个文件）` : `重新导入 v${String(nextVersion)}（${String(files.length)} 个文件）`,
          source: 'MANUAL',
          createdBy: viewer.id,
        },
      })
      return tx.skill.findUniqueOrThrow({ where: { id: skillId }, select: SKILL_SELECT })
    })
  } catch (error) {
    logger.error({ err: error, skillId, nextVersion }, 'Skill 落库失败，回收刚写入的对象')
    await removeObjectsQuietly(writtenKeys)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }

  logger.info(
    { skillId, version: nextVersion, fileCount: files.length, runtime, created: existing === null },
    existing === null ? '已创建 Skill' : '已重新导入 Skill（新版本）',
  )
  return {
    skill: toItem(
      saved,
      viewer,
      undefined,
      await parentInfoOf(saved, viewer),
      files.some((file) => isLikelyScriptPath(file.path)),
    ),
    version: nextVersion,
    fileCount: files.length,
    created: existing === null,
  }
}

// ═════════════════════════════════════════════════════════════════════
// 改元数据 / 删 / 转移
// ═════════════════════════════════════════════════════════════════════

/**
 * 改元数据（`PATCH /api/skills/:id`）：名称 / 描述 / 可见范围。
 *
 * · **不动文件、不升版本**（内容改动必须走重新导入 / 将来的草稿链）；
 * · 改名时重新判 `(createdBy, name)` 重名 —— 否则会撞部分唯一索引（用户看到的是 P2002）；
 * · `expectedUpdatedAt` 给了就做并发校验（不匹配 ⇒ 409 `SKILL_STALE`），不自动合并。
 *
 * ⚠️ 描述 / 名称变化**不需要重写 `SKILL.md` 对象**：正文以 DB 字段为准，
 *    `composeSkillMarkdown` 在**读**的时候重生成 frontmatter（见文件头 ⑤）——
 *    否则一次改名就要把整版对象重写一遍，还得处理"写到一半失败"。
 */
export async function updateSkill(
  id: string,
  input: UpdateSkillBody,
  viewer: SkillViewer,
): Promise<SkillItem> {
  const db = getPrisma()
  const current = await requireSkill(id, viewer, 'edit')

  if (input.expectedUpdatedAt !== undefined) {
    const expected = new Date(input.expectedUpdatedAt).getTime()
    if (expected !== current.updatedAt.getTime()) {
      throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.STALE })
    }
  }

  const name = input.name?.trim()
  if (name !== undefined && name !== current.name) {
    assertNoSkillConflict(
      await findSkillConflict({ createdBy: current.createdBy, name, slug: current.slug, excludeId: current.id }),
      name,
    )
  }
  const visibility: AssetVisibility | undefined =
    input.visibility === undefined ? undefined : normalizeSkillVisibility(input.visibility)

  const updated = await db.skill.update({
    where: { id },
    data: {
      ...(name === undefined ? {} : { name }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(visibility === undefined ? {} : { visibility }),
    },
    select: SKILL_SELECT,
  })
  getLogger().info({ skillId: id, changed: Object.keys(input) }, '已更新 Skill 元数据')
  return toItem(
    updated,
    viewer,
    undefined,
    await parentInfoOf(updated, viewer),
    (await skillHasScriptsMap([updated])).get(updated.id) ?? false,
  )
}

/**
 * 软删（`DELETE /api/skills/:id`，所属人 / ADMIN）。
 *
 * **被 Agent 绑定时 409**（`app.m294` 带引用数）：不自动解绑 —— Skill 会执行脚本，
 * 静默让别人的 Agent 少一个能力比报错更糟（与知识库"删库时自动解绑"刻意不同）。
 *
 * 只写 `deleted_at`：`skill_files` 行与 S3 对象都留着（历史消息要能回看"当时用了什么"）。
 */
export async function removeSkill(id: string, viewer: SkillViewer): Promise<RemoveSkillResult> {
  const db = getPrisma()
  const row = await requireSkill(id, viewer, 'edit')
  const agentCount = await db.agentComponent.count({ where: { componentType: 'SKILL', refId: id } })
  if (agentCount > 0) {
    throw AppError.conflict(appMsg('app.m294', { p0: agentCount }), { agentCount })
  }
  await db.skill.update({ where: { id }, data: { deletedAt: new Date() } })
  getLogger().info({ skillId: id, name: row.name }, '已软删 Skill')
  return { id: row.id, name: row.name }
}

/**
 * 转移所属人（`POST /api/skills/:id/transfer`，所属人 / ADMIN）。口径同 `kb.service#transferKnowledgeBase`：
 * 接收方须为 ACTIVE 用户、不能转给自己、无需接收方确认。
 *
 * ⚠️ 转移后 slug / name 的唯一性范围跟着变（新所属人下不能撞名）——
 * 这里不重新判重：slug 是全局唯一（部分唯一索引 `(slug) WHERE deleted_at IS NULL`），
 * name 撞了只会让新所属人"多一个同名 Skill"，不会 500；要改名的他自己改。
 */
export async function transferSkill(id: string, toUserId: string, viewer: SkillViewer): Promise<SkillItem> {
  const db = getPrisma()
  const row = await requireSkill(id, viewer, 'edit')
  if (toUserId === row.createdBy) throw AppError.validation(appMsg('app.m170'))
  const newOwner = await db.user.findUnique({ where: { id: toUserId }, select: { id: true, status: true } })
  if (newOwner === null || newOwner.status !== 'ACTIVE') throw AppError.validation(appMsg('app.m011'))
  const updated = await db.skill.update({ where: { id }, data: { createdBy: toUserId }, select: SKILL_SELECT })
  getLogger().info({ skillId: id, from: row.createdBy, to: toUserId }, '已转移 Skill 所属人')
  return toItem(
    updated,
    viewer,
    undefined,
    await parentInfoOf(updated, viewer),
    (await skillHasScriptsMap([updated])).get(updated.id) ?? false,
  )
}

// ═════════════════════════════════════════════════════════════════════
// 文件预览 / 下载
// ═════════════════════════════════════════════════════════════════════

/** 取一个版本的文件行（**校验版本存在**：`skill_files` 里没有该版本的任何行 ⇒ 409 `SKILL_VERSION_PURGED`） */
async function requireSkillFile(
  skill: { id: string; version: number },
  path: string,
  version: number | undefined,
): Promise<{ path: string; mime: string; size: number; sha256: string; storageKey: string }> {
  const db = getPrisma()
  const targetVersion = version ?? skill.version
  if (!isSafeSkillPath(path)) throw AppError.validation(appMsg('validation.skill.pathUnsafe'))
  if (targetVersion > skill.version) {
    throw AppError.notFound(appMsg('app.m298', { p0: targetVersion, p1: skill.version }))
  }
  const row = await db.skillFile.findFirst({
    where: { skillId: skill.id, version: targetVersion, path },
    select: { path: true, mime: true, size: true, sha256: true, storageKey: true },
  })
  if (row === null) throw AppError.notFound(appMsg('app.m296', { p0: path, p1: targetVersion }))
  return row
}

/** 本文件只需要 Skill 的这几个字段来重生成 `SKILL.md` frontmatter */
type SkillMarkdownMeta = Pick<
  SkillRow,
  'id' | 'name' | 'description' | 'runtime' | 'requiresBins' | 'manifest'
>

/**
 * 读一个版本的对象字节；`SKILL.md` 的 frontmatter 按 DB 字段重生成（文件头 ⑤）。
 *
 * 预览、单文件下载、整包下载共用这一条读法 —— 三处各自的"该给哪份字节"必须一致。
 */
async function readSkillFileObject(
  skill: SkillMarkdownMeta,
  row: { path: string; storageKey: string },
  targetVersion: number,
): Promise<Buffer> {
  const bytes = await readSkillObjectBytes(row.storageKey, objectKeyOf(skill.id, targetVersion, row.path), row.path)
  if (!isSkillEntryPath(row.path)) return bytes
  return Buffer.from(skillMarkdownOf(bytes, skill), 'utf8')
}

function isSkillEntryPath(path: string): boolean {
  return path === SKILL_ENTRY_PATH || path.endsWith('/SKILL.md')
}

/**
 * 单文件预览（`GET /api/skills/:id/file?path=&version=&offset=&limit=`）。
 *
 * · 文本（`isPreviewableSkillMime`）⇒ 按**码点**切一页（`skillPageOf`，与工具侧同一套语义）；
 *   其中 `SKILL.md` 返回的是**服务端按 DB 字段重生成了 frontmatter** 的版本；
 * · 二进制 ⇒ 只回元信息（`kind = 'BINARY'`），前端改走整包下载；
 * · 该版本正文已归档（`storageKey === ''`）⇒ 409 `SKILL_VERSION_PURGED`（不返回空文件、不换最新版）。
 */
export async function previewSkillFile(
  id: string,
  query: { path: string; version?: number; offset?: number; limit?: number },
  viewer: SkillViewer,
): Promise<SkillFilePreview> {
  const skill = await requireSkill(id, viewer, 'view')
  const row = await requireSkillFile(skill, query.path, query.version)
  if (isPurgedSkillFile(row)) {
    throw AppError.conflict(appMsg('app.m297', { p0: row.path, p1: query.version ?? skill.version }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  if (!isPreviewableSkillMime(row.mime)) {
    throw AppError.validation(appMsg('app.m300', { p0: row.mime }), { mime: row.mime })
  }

  const keyVersion = query.version ?? skill.version
  const bytes = await readSkillFileObject(skill, row, keyVersion)
  const text = bytes.toString('utf8')
  const page: SkillPage = skillPageOf(text, query.offset ?? 0, query.limit ?? SKILL_PAGE_DEFAULT_LIMIT)
  return {
    path: row.path,
    version: query.version ?? skill.version,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    kind: 'TEXT',
    page,
  }
}

/** `SKILL.md` 的展示正文：frontmatter 按 DB 字段重生成（文件头 ⑤） */
function skillMarkdownOf(bytes: Buffer, skill: SkillMarkdownMeta): string {
  const markdown = bytes.toString('utf8')
  return composeSkillMarkdown({
    name: skill.name,
    description: skill.description,
    runtime: skill.runtime,
    requiresScripts: /^\s{2}scripts:\s*true\s*$/mu.test(markdown),
    requiresBins: requiresBinsOf(skill.requiresBins),
    body: stripFrontmatter(markdown),
    extra: extraFrontmatterOf(skill.manifest),
  })
}

/** `skills.manifest` 是导入时的原始 frontmatter；非受控键（license / allowed-tools…）原样带回 */
function extraFrontmatterOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 读一个对象到内存（单文件上限由导入闸门保证 ≤ `SKILL_MAX_FILE_BYTES`）。
 *
 * `fallbackKey` = 按 `(skillId, version, path)` **重新拼**的键。为什么不只用行里的 `storageKey`：
 * 同一个文件在多个版本里内容相同时，库里那份 `storageKey` 可能指向**另一版**的对象 ——
 * 一旦那一版过了保留期被回收（对象删了、行留着），"这一版明明还在保留期内"却读不到。
 * 先按行里的键读，失败再按本版号拼一次，两次都失败才判归档（见 {@link asPurged}）。
 */
export async function readSkillObjectBytes(key: string, fallbackKey: string, path: string): Promise<Buffer> {
  const bucket = config.s3.bucket
  try {
    return await readObjectOnce(bucket, key)
  } catch (error) {
    if (!isS3NoSuchKey(error) || fallbackKey === key) throw asPurged(error, path)
    try {
      return await readObjectOnce(bucket, fallbackKey)
    } catch (fallbackError) {
      throw asPurged(fallbackError, path)
    }
  }
}

/** 一次 `getObject` + 收流 */
async function readObjectOnce(bucket: string, key: string): Promise<Buffer> {
  const stream = await getS3Client().getObject(bucket, key)
  const chunks: Buffer[] = []
  for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** 读失败 → `409 SKILL_VERSION_PURGED`（对象不在）/ `500`（其它上游故障） */
function asPurged(error: unknown, path: string): AppError {
  if (isS3NoSuchKey(error)) {
    getLogger().warn({ path, err: error }, 'Skill 对象已丢失，预览报归档')
    return AppError.conflict(appMsg('app.m297', { p0: path, p1: '' }), { code: SKILL_ERROR_CODES.VERSION_PURGED })
  }
  getLogger().error({ err: error, path }, '读取 Skill 对象失败')
  return AppError.internal(appMsg('app.m012'))
}

function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/** 单文件下载（`GET /api/skills/:id/file?download=1&path=&version=`，返回字节流） */
export async function openSkillFileSource(
  id: string,
  query: { path: string; version?: number },
  viewer: SkillViewer,
): Promise<{
  body: Readable
  contentType: string
  contentLength: number
  fileName: string
  contentDisposition: string
}> {
  const skill = await requireSkill(id, viewer, 'view')
  const row = await requireSkillFile(skill, query.path, query.version)
  if (isPurgedSkillFile(row)) {
    throw AppError.conflict(appMsg('app.m297', { p0: row.path, p1: query.version ?? skill.version }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  const bytes = await readSkillFileObject(skill, row, query.version ?? skill.version)
  const fileName = fileNameOf(row.path)
  return {
    body: Readable.from(bytes),
    contentType: row.mime === '' ? 'application/octet-stream' : row.mime,
    contentLength: bytes.length,
    fileName,
    contentDisposition: buildContentDisposition(fileName),
  }
}

/**
 * 预览用的原始字节（`GET /api/skills/:id/file/raw?path=&version=`）。
 *
 * 前端对 `image` / `html` / `svg` / `pdf` 直接把这个 URL 交给 `<img>` / `<iframe>`；
 * 文本则由前端 fetch 后按 UTF-8 解码。响应头按 `previewHeadersFor(mime)` 分派（HTML/SVG 带 CSP）。
 */
export async function openSkillFileRawSource(
  id: string,
  query: { path: string; version?: number },
  viewer: SkillViewer,
): Promise<{ body: Buffer; mime: string; contentLength: number; fileName: string }> {
  const skill = await requireSkill(id, viewer, 'view')
  const row = await requireSkillFile(skill, query.path, query.version)
  if (isPurgedSkillFile(row)) {
    throw AppError.conflict(appMsg('app.m297', { p0: row.path, p1: query.version ?? skill.version }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  const bytes = await readSkillFileObject(skill, row, query.version ?? skill.version)
  return {
    body: bytes,
    mime: row.mime === '' ? 'application/octet-stream' : row.mime,
    contentLength: bytes.length,
    fileName: fileNameOf(row.path),
  }
}

/**
 * DOCX / XLSX 的在线渲染（`GET /api/skills/:id/file/render?path=&version=`）。
 *
 * 与产物 / 工作区两条渲染出口同一套转换器；原始 OOXML 字节绝不能当 HTML 直出。
 */
export async function renderSkillFileHtml(
  id: string,
  query: { path: string; version?: number },
  viewer: SkillViewer,
): Promise<{ html: string; fileName: string }> {
  const skill = await requireSkill(id, viewer, 'view')
  const row = await requireSkillFile(skill, query.path, query.version)
  if (isPurgedSkillFile(row)) {
    throw AppError.conflict(appMsg('app.m297', { p0: row.path, p1: query.version ?? skill.version }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  const kind = previewKindOf(row.mime)
  if (kind !== 'docx' && kind !== 'xlsx') throw AppError.validation(appMsg('app.m090'))
  const bytes = await readSkillFileObject(skill, row, query.version ?? skill.version)
  if (bytes.length > ARTIFACT_PREVIEW_MAX_INLINE_BYTES) throw AppError.validation(appMsg('app.m019'))

  const fileName = fileNameOf(row.path)
  try {
    const html =
      kind === 'xlsx'
        ? renderXlsxToHtml(parseXlsx(bytes), fileName)
        : await renderDocxToHtml(bytes, fileName)
    return { html, fileName }
  } catch (error) {
    if (error instanceof AppError) throw error
    getLogger().warn({ err: error, skillId: id, path: row.path, kind }, 'Skill OOXML 渲染失败')
    throw AppError.validation(appMsg('app.m091'))
  }
}

/**
 * 整包下载（`GET /api/skills/:id/download?version=`，返回 zip 字节流）。
 *
 * 复用工作区「按目录下载」的零依赖 stored zip 写入器（`workspace/zip.ts#buildZip`）——
 * 上传是 zip，下载也回到同一个形态；`SKILL.md` 与预览一致（frontmatter 按 DB 重生成）。
 */
export async function openSkillArchiveSource(
  id: string,
  query: { version?: number },
  viewer: SkillViewer,
): Promise<{ fileName: string; body: Buffer; entries: number }> {
  const skill = await requireSkill(id, viewer, 'view')
  const targetVersion = query.version ?? skill.version
  if (targetVersion > skill.version) {
    throw AppError.notFound(appMsg('app.m298', { p0: targetVersion, p1: skill.version }))
  }
  const rows = await getPrisma().skillFile.findMany({
    where: { skillId: id, version: targetVersion },
    select: { path: true, storageKey: true },
    orderBy: { path: 'asc' },
  })
  if (rows.length === 0 || rows.some(isPurgedSkillFile)) {
    throw AppError.conflict(appMsg('app.m297', { p0: skill.name, p1: targetVersion }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }

  const entries: ZipEntry[] = []
  for (const row of rows) {
    entries.push({ name: row.path, data: await readSkillFileObject(skill, row, targetVersion) })
  }
  let body: Buffer
  try {
    body = buildZip(entries)
  } catch (error) {
    getLogger().error({ err: error, skillId: id, version: targetVersion }, 'Skill 整包 zip 生成失败')
    throw AppError.internal(appMsg('app.m012'))
  }
  return { fileName: `${skill.slug}-v${targetVersion}.zip`, body, entries: entries.length }
}

// ═════════════════════════════════════════════════════════════════════
// 杂项
// ═════════════════════════════════════════════════════════════════════

/** 派 slug / id 用的短随机段（uuid v4 的前 8 位十六进制；`skillSlugOf` 的 `shortid`） */
function randomShortId(): string {
  return randomUuid().replace(/-/gu, '').slice(0, 8)
}

/** 本文件只需要 v4 随机段（v7 的主键由 Prisma `@default(uuid(7))` 生成） */
function randomUuid(): string {
  return randomUUID()
}

export { importError }
