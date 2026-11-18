/**
 * 会话级 Skill 覆写服务（P1-24c-4b；`docs/子方案/Skill能力.md` §5.16）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与邻居的分工（别把判据写两遍）
 * ─────────────────────────────────────────────────────────────────────
 * · 草稿 / 内容校验 / S3 草稿对象：`skillDraft.service.ts`（`materializeSkillOverrideDraft`）；
 * · 行级 ACL：`skill.service.ts`（`canViewSkill`；**覆写不要求 `canEditSkill`**）；
 * · 运行时读取：ChatBot `skillTools.ts` / TaskAgent `skillSync.ts`（都读本表 + S3 前缀）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 六条口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **只有会话发起者**：所有端点都 `conversation.userId === viewer.id`；ADMIN 也没有后门（统一 404）。
 * ② **目标必须在本会话 Agent 的绑定集合内**：给没绑的 Skill 建覆写 ⇒ 400 `SKILL_OVERRIDE_NOT_BOUND`。
 * ③ **不改上游**：只写本表 + `skill-overrides/...` 前缀；不写 `skills` / `skill_files` / `SkillChange`，
 *    不递增 `skills.version`。
 * ④ **写 S3 先、DB 后**：DB 失败按前缀回收刚写的对象（与导入 / 草稿同一条顺序）。
 * ⑤ **`revision` 是覆写自己的递增号**：替换时 `revision + 1` 并换前缀；旧前缀在 DB 成功后才回收。
 * ⑥ **`promote` 在 P1-24c-5 落地**：实现落在 `skillFork.service.ts`（先 fork、再删覆写），
 *    本文件只导出覆写文件解析与前缀回收给那一批复用；覆写本身仍不改上游。
 */

import {
  AppError,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  appMsg,
  skillOverridePrefix,
  type ConversationSkillOverrideDetail,
  type ConversationSkillOverrideFile,
  type ConversationSkillOverrideItem,
  type ConversationSkillOverridesResult,
  type SkillDraft,
  type SkillRuntime,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { getS3Client } from '../infra/s3.js'
import {
  consumeSkillOverrideDraft,
  createSessionOverrideDraftFromExisting,
  materializeSkillOverrideDraft,
  readSkillObjectQuietly,
  type MaterializedOverrideDraft,
} from './skillDraft.service.js'
import { SKILL_SELECT, canViewSkill, type SkillRow, type SkillViewer } from './skill.service.js'
import { stripFrontmatter } from './skillZip.js'

/** 会话归属（**唯一判据**：`userId` 在 where 里；不是你的 = 不存在 = 404） */
async function requireMyConversation(
  conversationId: string,
  viewer: SkillViewer,
): Promise<{ agentId: string }> {
  const row = await getPrisma().conversation.findFirst({
    where: { id: conversationId, userId: viewer.id },
    select: { id: true, agentId: true },
  })
  if (row === null) throw AppError.notFound(appMsg('app.m001'))
  return { agentId: row.agentId }
}

/** 本会话 Agent 绑定的 Skill id 集合（"没绑不能建覆写"的唯一判据） */
async function boundSkillIdsOf(agentId: string): Promise<Set<string>> {
  const rows = await getPrisma().agentComponent.findMany({
    where: { agentId, componentType: 'SKILL' },
    select: { refId: true },
  })
  return new Set(rows.map((row) => row.refId))
}

/** 读目标 Skill 行并对当前用户可见（不存在 / 不可见 ⇒ 同一个 404） */
async function requireVisibleSkill(skillId: string, viewer: SkillViewer): Promise<SkillRow> {
  const row = await getPrisma().skill.findFirst({ where: { id: skillId, deletedAt: null }, select: SKILL_SELECT })
  if (row === null || !canViewSkill(row, viewer)) throw AppError.notFound(appMsg('app.m316', { p0: skillId }))
  return row
}

function overrideNotFound(): AppError {
  return AppError.notFound(appMsg('app.m320'), { code: SKILL_ERROR_CODES.OVERRIDE_NOT_FOUND })
}

function overrideConflict(current: number, expected: number): AppError {
  return AppError.conflict(appMsg('app.m322', { p0: current, p1: expected }), {
    code: SKILL_ERROR_CODES.OVERRIDE_CONFLICT,
  })
}

export function parseConversationSkillOverrideFiles(value: unknown): ConversationSkillOverrideFile[] {
  if (!Array.isArray(value)) return []
  const out: ConversationSkillOverrideFile[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    out.push({
      path: record.path,
      mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
      size: typeof record.size === 'number' ? record.size : 0,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
    })
  }
  return out
}

interface OverrideRow {
  id: string
  conversationId: string
  skillId: string
  basedOnVersion: number
  revision: number
  storageKey: string
  files: unknown
  changeSummary: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

function toItem(
  row: OverrideRow,
  skill: Pick<SkillRow, 'name' | 'slug' | 'version' | 'createdBy' | 'visibility' | 'deletedAt'>,
  viewer: SkillViewer,
): ConversationSkillOverrideItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    skillId: row.skillId,
    skillName: skill.name,
    skillSlug: skill.slug,
    basedOnVersion: row.basedOnVersion,
    revision: row.revision,
    currentSkillVersion: skill.version,
    upstreamUpdated: skill.version > row.basedOnVersion,
    changeSummary: row.changeSummary ?? '',
    fileCount: parseConversationSkillOverrideFiles(row.files).length,
    canPropose: skill.createdBy !== viewer.id && canViewSkill(skill, viewer),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 把整版文件写到覆写前缀（**先 S3、后 DB**；失败回收已写的） */
async function writeOverrideObjects(
  storageKey: string,
  files: readonly { path: string; bytes: Buffer; mime: string }[],
): Promise<string[]> {
  const bucket = config.s3.bucket
  const written: string[] = []
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
    for (const file of files) {
      const key = `${storageKey}${file.path}`
      await s3.putObject(bucket, key, file.bytes, file.bytes.length, { 'Content-Type': file.mime })
      written.push(key)
    }
    return written
  } catch (error) {
    getLogger().error({ err: error, storageKey, written: written.length }, '会话覆写对象写入失败，已中止')
    await removeKeysQuietly(written)
    throw AppError.internal(appMsg('app.m012'))
  }
}

async function removeKeysQuietly(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(config.s3.bucket))) return
    await s3.removeObjects(config.s3.bucket, [...keys])
  } catch (error) {
    getLogger().warn({ err: error, count: keys.length }, '会话覆写对象回收失败（残留对象需人工清理）')
  }
}

/** 删一个覆写前缀下的全部对象（尽力而为；失败只 warn —— 会话删除时由清理器兜底） */
export async function removeOverridePrefixQuietly(storageKey: string): Promise<void> {
  try {
    const s3 = getS3Client()
    const bucket = config.s3.bucket
    if (!(await s3.bucketExists(bucket))) return
    const keys: string[] = []
    const stream = s3.listObjectsV2(bucket, storageKey, true)
    for await (const item of stream) {
      if (typeof item.name === 'string' && item.name !== '') keys.push(item.name)
    }
    await removeKeysQuietly(keys)
  } catch (error) {
    getLogger().warn({ err: error, storageKey }, '会话覆写对象前缀回收失败（残留对象需人工清理）')
  }
}

function fileMetaOf(materialized: MaterializedOverrideDraft['files']): ConversationSkillOverrideFile[] {
  return materialized.map((file) => ({
    path: file.path,
    mime: file.mime,
    size: file.bytes.length,
    sha256: file.sha256,
  }))
}

function assertDraftMatches(
  materialized: MaterializedOverrideDraft,
  conversationId: string,
  row?: { skillId: string; revision: number },
): void {
  if (materialized.overrideConversationId !== conversationId) {
    throw AppError.validation(appMsg('app.m307', { p0: 'SESSION_OVERRIDE（所属会话与路径不一致）' }), {
      code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH,
    })
  }
  if (row !== undefined && materialized.targetSkillId !== row.skillId) {
    throw AppError.validation(appMsg('app.m307', { p0: '会话覆写目标与草稿不一致' }), {
      code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH,
    })
  }
  if (row !== undefined && materialized.expectedRevision !== null && materialized.expectedRevision !== row.revision) {
    throw overrideConflict(row.revision, materialized.expectedRevision)
  }
}

/**
 * 新建覆写（`POST /api/conversations/:id/skill-overrides`，body `{ draftId }`）。
 *
 * 草稿必须是 `SESSION_OVERRIDE`、属于本会话、目标在绑定集合内；已存在 ⇒ 409（改为替换）。
 */
export async function createConversationSkillOverride(
  conversationId: string,
  draftId: string,
  viewer: SkillViewer,
): Promise<ConversationSkillOverrideDetail> {
  const materialized = await materializeSkillOverrideDraft(draftId, viewer)
  const { agentId } = await requireMyConversation(conversationId, viewer)
  assertDraftMatches(materialized, conversationId)

  const bound = await boundSkillIdsOf(agentId)
  if (!bound.has(materialized.targetSkillId)) {
    const skill = await requireVisibleSkill(materialized.targetSkillId, viewer)
    throw AppError.validation(appMsg('app.m321', { p0: skill.name }), {
      code: SKILL_ERROR_CODES.OVERRIDE_NOT_BOUND,
    })
  }
  const skill = await requireVisibleSkill(materialized.targetSkillId, viewer)

  if (skill.runtime === 'INLINE' && materialized.files.some((file) => file.path.startsWith('scripts/'))) {
    throw AppError.validation(appMsg('app.m323', { p0: skill.name }), {
      code: SKILL_ERROR_CODES.IMPORT_INVALID,
      reasons: ['inline Skill 的会话覆写不能包含 scripts/ 文件'],
    })
  }

  const existing = await getPrisma().conversationSkillOverride.findUnique({
    where: { conversationId_skillId: { conversationId, skillId: materialized.targetSkillId } },
    select: { id: true, revision: true },
  })
  if (existing !== null) {
    throw AppError.conflict(appMsg('app.m324', { p0: skill.name, p1: existing.revision }), {
      code: SKILL_ERROR_CODES.OVERRIDE_CONFLICT,
    })
  }

  const storageKey = skillOverridePrefix(conversationId, materialized.targetSkillId, 1)
  const written = await writeOverrideObjects(storageKey, materialized.files)
  let row: OverrideRow
  try {
    row = (await getPrisma().conversationSkillOverride.create({
      data: {
        conversationId,
        skillId: materialized.targetSkillId,
        basedOnVersion: materialized.baseVersion,
        revision: 1,
        storageKey,
        files: fileMetaOf(materialized.files),
        changeSummary: materialized.changeSummary,
        createdBy: viewer.id,
      },
      select: {
        id: true,
        conversationId: true,
        skillId: true,
        basedOnVersion: true,
        revision: true,
        storageKey: true,
        files: true,
        changeSummary: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    })) as OverrideRow
  } catch (error) {
    getLogger().error({ err: error, conversationId, skillId: materialized.targetSkillId }, '会话覆写落库失败，回收刚写入的对象')
    await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
  await consumeSkillOverrideDraft(draftId, viewer)
  getLogger().info(
    { conversationId, skillId: materialized.targetSkillId, revision: 1, fileCount: materialized.files.length },
    '已建立会话级 Skill 覆写',
  )
  return { ...toItem(row, skill, viewer), files: parseConversationSkillOverrideFiles(row.files) }
}

/** 列表（`GET /api/conversations/:id/skill-overrides`） */
export async function listConversationSkillOverrides(
  conversationId: string,
  viewer: SkillViewer,
): Promise<ConversationSkillOverridesResult> {
  await requireMyConversation(conversationId, viewer)
  const rows = (await getPrisma().conversationSkillOverride.findMany({
    where: { conversationId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      conversationId: true,
      skillId: true,
      basedOnVersion: true,
      revision: true,
      storageKey: true,
      files: true,
      changeSummary: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as OverrideRow[]
  if (rows.length === 0) return { items: [] }
  const skills = await getPrisma().skill.findMany({
    where: { id: { in: rows.map((row) => row.skillId) } },
    select: { id: true, name: true, slug: true, version: true, createdBy: true, visibility: true, deletedAt: true },
  })
  const skillById = new Map(skills.map((skill) => [skill.id, skill]))
  const items: ConversationSkillOverrideItem[] = []
  for (const row of rows) {
    const skill = skillById.get(row.skillId)
    if (skill === undefined) continue
    items.push(toItem(row, skill, viewer))
  }
  return { items }
}

/** 详情（`GET .../:overrideId`）：列表项 + 文件清单 */
export async function getConversationSkillOverride(
  conversationId: string,
  overrideId: string,
  viewer: SkillViewer,
): Promise<ConversationSkillOverrideDetail> {
  await requireMyConversation(conversationId, viewer)
  const row = (await getPrisma().conversationSkillOverride.findFirst({
    where: { id: overrideId, conversationId },
    select: {
      id: true,
      conversationId: true,
      skillId: true,
      basedOnVersion: true,
      revision: true,
      storageKey: true,
      files: true,
      changeSummary: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as OverrideRow | null
  if (row === null) throw overrideNotFound()
  const skill = await requireVisibleSkill(row.skillId, viewer)
  return { ...toItem(row, skill, viewer), files: parseConversationSkillOverrideFiles(row.files) }
}

/** 替换覆写内容（`PUT .../:overrideId`）：`revision + 1`，CAS `expectedRevision` */
export async function replaceConversationSkillOverride(
  conversationId: string,
  overrideId: string,
  input: { draftId: string; expectedRevision: number },
  viewer: SkillViewer,
): Promise<ConversationSkillOverrideDetail> {
  await requireMyConversation(conversationId, viewer)
  const current = (await getPrisma().conversationSkillOverride.findFirst({
    where: { id: overrideId, conversationId },
    select: {
      id: true,
      conversationId: true,
      skillId: true,
      basedOnVersion: true,
      revision: true,
      storageKey: true,
      files: true,
      changeSummary: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as OverrideRow | null
  if (current === null) throw overrideNotFound()
  if (current.revision !== input.expectedRevision) throw overrideConflict(current.revision, input.expectedRevision)

  const materialized = await materializeSkillOverrideDraft(input.draftId, viewer)
  assertDraftMatches(materialized, conversationId, { skillId: current.skillId, revision: current.revision })
  const skill = await requireVisibleSkill(current.skillId, viewer)
  if (skill.runtime === 'INLINE' && materialized.files.some((file) => file.path.startsWith('scripts/'))) {
    throw AppError.validation(appMsg('app.m323', { p0: skill.name }), {
      code: SKILL_ERROR_CODES.IMPORT_INVALID,
      reasons: ['inline Skill 的会话覆写不能包含 scripts/ 文件'],
    })
  }

  const nextRevision = current.revision + 1
  const storageKey = skillOverridePrefix(conversationId, current.skillId, nextRevision)
  const written = await writeOverrideObjects(storageKey, materialized.files)
  let row: OverrideRow
  try {
    const updated = await getPrisma().conversationSkillOverride.updateMany({
      where: { id: overrideId, conversationId, revision: current.revision },
      data: {
        revision: nextRevision,
        storageKey,
        files: fileMetaOf(materialized.files),
        basedOnVersion: materialized.baseVersion,
        changeSummary: materialized.changeSummary,
      },
    })
    if (updated.count === 0) throw overrideConflict(current.revision, input.expectedRevision)
    row = (await getPrisma().conversationSkillOverride.findUniqueOrThrow({
      where: { id: overrideId },
      select: {
        id: true,
        conversationId: true,
        skillId: true,
        basedOnVersion: true,
        revision: true,
        storageKey: true,
        files: true,
        changeSummary: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    })) as OverrideRow
  } catch (error) {
    getLogger().error({ err: error, conversationId, overrideId }, '会话覆写替换落库失败，回收新对象')
    await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
  await consumeSkillOverrideDraft(input.draftId, viewer)
  await removeOverridePrefixQuietly(current.storageKey)
  getLogger().info({ conversationId, skillId: current.skillId, revision: nextRevision }, '已替换会话级 Skill 覆写')
  return { ...toItem(row, skill, viewer), files: parseConversationSkillOverrideFiles(row.files) }
}

/** 放弃覆写（`DELETE .../:overrideId`）：删行 + 回收前缀，回到上游解析 */
export async function deleteConversationSkillOverride(
  conversationId: string,
  overrideId: string,
  viewer: SkillViewer,
): Promise<{ id: string }> {
  await requireMyConversation(conversationId, viewer)
  const row = await getPrisma().conversationSkillOverride.findFirst({
    where: { id: overrideId, conversationId },
    select: { id: true, storageKey: true },
  })
  if (row === null) throw overrideNotFound()
  await getPrisma().conversationSkillOverride.delete({ where: { id: row.id } })
  await removeOverridePrefixQuietly(row.storageKey)
  getLogger().info({ conversationId, overrideId }, '已放弃会话级 Skill 覆写')
  return { id: row.id }
}

/**
 * 按当前上游重建草稿（`POST .../:overrideId/rebased`，§5.16.4 第二项）。
 *
 * 返回一份 `SESSION_OVERRIDE` 草稿（`expectedRevision` = 当前 revision）；保存仍走 `PUT`（CAS）。
 * ⚠️ 本批不做三方合并：正文/文件取自**当前覆写**，用户在新基准上人工调整冲突段。
 */
export async function rebaseConversationSkillOverride(
  conversationId: string,
  overrideId: string,
  input: { expectedRevision?: number | undefined },
  viewer: SkillViewer,
): Promise<SkillDraft> {
  await requireMyConversation(conversationId, viewer)
  const row = (await getPrisma().conversationSkillOverride.findFirst({
    where: { id: overrideId, conversationId },
    select: {
      id: true,
      conversationId: true,
      skillId: true,
      basedOnVersion: true,
      revision: true,
      storageKey: true,
      files: true,
      changeSummary: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as OverrideRow | null
  if (row === null) throw overrideNotFound()
  if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) {
    throw overrideConflict(row.revision, input.expectedRevision)
  }
  const skill = await requireVisibleSkill(row.skillId, viewer)
  if (skill.version <= row.basedOnVersion) {
    throw AppError.validation(appMsg('app.m325', { p0: skill.name, p1: skill.version }), {
      code: SKILL_ERROR_CODES.OVERRIDE_NOT_FOUND,
    })
  }

  const entryKey = `${row.storageKey}${SKILL_ENTRY_PATH}`
  const raw = (await readSkillObjectQuietly(entryKey)).toString('utf8')
  const files = parseConversationSkillOverrideFiles(row.files).filter((file) => file.path !== SKILL_ENTRY_PATH)
  const requiresBins = Array.isArray(skill.requiresBins)
    ? (skill.requiresBins as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  return await createSessionOverrideDraftFromExisting({
    viewer,
    conversationId,
    targetSkillId: row.skillId,
    baseVersion: skill.version,
    expectedRevision: row.revision,
    overrideId: row.id,
    name: skill.name,
    description: skill.description,
    runtime: skill.runtime as SkillRuntime,
    requiresBins,
    markdown: stripFrontmatter(raw),
    changeSummary: `按上游 v${String(skill.version)} 重建（原覆写 r${String(row.revision)}）`,
    source: { storageKey: row.storageKey, files },
  })
}