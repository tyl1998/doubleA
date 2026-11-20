/**
 * Skill 更新建议（Proposal）与三方合并（P1-24c-6）
 *
 * 依据：`docs/子方案/会话生成Skill.md` §10.12 ~ §10.18、`docs/06-实施计划.md` P1-24c-6。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与邻居的分工（别把判据写两遍）
 * ─────────────────────────────────────────────────────────────────────
 * · 行级 ACL / 版本快照：`skill.service.ts` + `skillAsset.service.ts`；
 * · 草稿读取 / 内容校验 / 脱敏：`skillDraft.service.ts#materializeSkillProposalDraft`；
 * · 三方合并纯函数：`shared/src/skill.ts#mergeSkillThreeWay`（本文件只负责取字节与落库）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 八条口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **非所属人不能直接改上游**：提交提案只要求目标可见；若目标就是自己的 ⇒ 400（直接编辑）。
 * ② **diff 由服务端算**：基准 = `baseVersion` 的 `SKILL.md` 正文 + 文件 sha256；不收客户端 patch。
 * ③ **提交时物化文件**到 `skill-proposals/{proposalId}/`：草稿过期不影响审核。
 * ④ **接受落完整内容**：直接接受 = 提案整版内容；`THREE_WAY` = 合并结果；都不执行客户端 patch。
 * ⑤ **默认 REQUIRE_BASE**：`baseVersion !== 上游当前版本` ⇒ 409，不自动合并。
 * ⑥ **冲突逐项确认**：`mergeSkillThreeWay` 返回的每个 `section:*` / `file:*` 都必须有 resolution；
 *    缺项 ⇒ 400（带 `data.conflicts[]`），并把提案置 `NEEDS_REBASE`。
 * ⑦ **提交者不能自审自批**：接受 / 拒绝 / 要求重做都要求目标 `canEditSkill`（所属人或 ADMIN）。
 * ⑧ **不暴露会话原文**：只记 `sourceConversationId / sourceMessageIds`，且会话必须是提交者的。
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  AppError,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  appMsg,
  computeSkillDiff,
  effectiveSkillRuntime,
  isSafeSkillPath,
  isSkillScriptPath,
  mergeSkillThreeWay,
  skillDiffSchema,
  skillProposalPrefix,
  skillStoragePrefix,
  type AcceptSkillProposalBody,
  type AcceptSkillProposalResult,
  type CloseSkillProposalBody,
  type CreateSkillProposalDraftBody,
  type ListSkillProposalsQuery,
  type ReviewSkillProposalBody,
  type SkillDraft,
  type SkillMergeChoice,
  type SkillMergeFile,
  type SkillMergeResolution,
  type SkillProposalDetail,
  type SkillProposalItem,
  type SkillProposalListResult,
  type SkillProposalStatus,
  type SkillRuntime,
  type SubmitSkillProposalBody,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma, Prisma } from '../infra/prisma.js'
import {
  SKILL_SELECT,
  canEditSkill,
  canViewSkill,
  type SkillRow,
  type SkillViewer,
} from './skill.service.js'
import {
  parentInfoOf,
  readSkillObjectBytes,
  requireSkill,
  skillObjectKey,
  toItem,
} from './skillAsset.service.js'
import {
  assertSkillProposalDraftSubmittable,
  createSkillProposalDraftFromFork,
  markSkillProposalSubmitted,
  materializeSkillProposalDraft,
  readSkillObjectQuietly,
  removeKeysQuietly,
  writeObjectsAtPrefix,
} from './skillDraft.service.js'
import { parseConversationSkillOverrideFiles } from './skillOverride.service.js'
import { skillContentMatches } from './skillForkModel.js'
import { composeSkillMarkdown, stripFrontmatter } from './skillZip.js'
import { skillHasScriptsMap } from './skill.service.js'

// ═════════════════════════════════════════════════════════════════════
// 行 / 文件 / 快照
// ═════════════════════════════════════════════════════════════════════

const PROPOSAL_INCLUDE = {
  target: { select: SKILL_SELECT },
  proposer: { select: { username: true, nickname: true } },
  reviewer: { select: { username: true, nickname: true } },
} as const

type ProposalRow = Prisma.SkillProposalGetPayload<{ include: typeof PROPOSAL_INCLUDE }>

interface ProposalFileRow {
  path: string
  mime: string
  size: number
  sha256: string
  storageKey: string
}

interface ProposalMeta {
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: string[]
}

interface ProposalFilesPayload {
  items: ProposalFileRow[]
  meta: ProposalMeta
}

interface SnapshotFile extends SkillMergeFile {
  storageKey: string
}

interface Snapshot {
  body: string
  bodyBytes: Buffer
  files: SnapshotFile[]
}

function proposalNotFound(): AppError {
  return AppError.notFound(appMsg('app.m332'), { code: SKILL_ERROR_CODES.PROPOSAL_NOT_FOUND })
}

function statusConflict(status: SkillProposalStatus): AppError {
  return AppError.conflict(appMsg('app.m333', { p0: status }), {
    code: SKILL_ERROR_CODES.PROPOSAL_STATUS_CONFLICT,
  })
}

function changeCountOf(diff: unknown): { count: number; parsed: ReturnType<typeof skillDiffSchema.parse> | null } {
  const result = skillDiffSchema.safeParse(diff)
  if (!result.success) return { count: 0, parsed: null }
  const changedSections = result.data.sections.filter((line) => line.op !== 'equal').length
  return {
    count: changedSections + result.data.addedFiles.length + result.data.removedFiles.length + result.data.changedFiles.length,
    parsed: result.data,
  }
}

function payloadOf(value: unknown): ProposalFilesPayload | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { items?: unknown; meta?: unknown }
  if (!Array.isArray(raw.items)) return null
  const items: ProposalFileRow[] = []
  for (const item of raw.items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    if (
      typeof row.path !== 'string' ||
      typeof row.mime !== 'string' ||
      typeof row.size !== 'number' ||
      typeof row.sha256 !== 'string' ||
      typeof row.storageKey !== 'string'
    ) {
      return null
    }
    items.push({
      path: row.path,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      storageKey: row.storageKey,
    })
  }
  const metaRaw = raw.meta
  const meta: ProposalMeta =
    metaRaw !== null && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
      ? {
          name: typeof (metaRaw as { name?: unknown }).name === 'string' ? String((metaRaw as { name: string }).name) : '',
          description:
            typeof (metaRaw as { description?: unknown }).description === 'string'
              ? String((metaRaw as { description: string }).description)
              : '',
          runtime: (metaRaw as { runtime?: unknown }).runtime === 'SANDBOX' ? 'SANDBOX' : 'INLINE',
          requiresBins: Array.isArray((metaRaw as { requiresBins?: unknown }).requiresBins)
            ? ((metaRaw as { requiresBins: unknown[] }).requiresBins.filter((bin): bin is string => typeof bin === 'string'))
            : [],
        }
      : { name: '', description: '', runtime: 'INLINE', requiresBins: [] }
  return { items, meta }
}

function proposalItemOf(row: ProposalRow, changeCount: number): SkillProposalItem {
  return {
    id: row.id,
    targetSkillId: row.targetSkillId,
    targetName: row.target.name,
    targetSlug: row.target.slug,
    baseVersion: row.baseVersion,
    status: row.status,
    changeSummary: row.changeSummary,
    proposedBy: row.proposedBy,
    proposerName: row.proposer.nickname ?? row.proposer.username,
    changeCount,
    fileCount: payloadOf(row.files)?.items.length ?? 0,
    sourceConversationId: row.sourceConversationId,
    sourceMessageCount: Array.isArray(row.sourceMessageIds)
      ? row.sourceMessageIds.filter((id): id is string => typeof id === 'string').length
      : 0,
    reviewedBy: row.reviewedBy,
    reviewerName: row.reviewer === null ? null : (row.reviewer.nickname ?? row.reviewer.username),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    acceptedVersion: row.acceptedVersion,
    createdAt: row.createdAt.toISOString(),
  }
}

function itemOf(row: ProposalRow): SkillProposalItem {
  return proposalItemOf(row, changeCountOf(row.diff).count)
}

async function findProposalRow(id: string): Promise<ProposalRow> {
  const row = await getPrisma().skillProposal.findUnique({ where: { id }, include: PROPOSAL_INCLUDE })
  if (row === null) throw proposalNotFound()
  return row
}

/** 版本快照（`SKILL.md` 正文 + 文件摘要 + 对象键）；任一行归档 / 正文缺失 ⇒ `null` */
async function readVersionSnapshot(skillId: string, version: number): Promise<Snapshot | null> {
  try {
    const rows = await getPrisma().skillFile.findMany({
      where: { skillId, version },
      select: { path: true, size: true, mime: true, sha256: true, storageKey: true },
      orderBy: { path: 'asc' },
    })
    if (rows.length === 0 || rows.some((row) => row.storageKey === '')) return null
    const entry = rows.find((row) => row.path === SKILL_ENTRY_PATH)
    if (entry === undefined) return null
    const bodyBytes = await readSkillObjectBytes(
      entry.storageKey,
      skillObjectKey(skillId, version, entry.path),
      entry.path,
    )
    return {
      body: stripFrontmatter(bodyBytes.toString('utf8')),
      bodyBytes,
      files: rows.map((row) => ({
        path: row.path,
        size: row.size,
        mime: row.mime,
        sha256: row.sha256,
        storageKey: row.storageKey,
      })),
    }
  } catch (error) {
    getLogger().warn({ err: error, skillId, version }, '读取 Skill 版本快照失败（按不可比较处理）')
    return null
  }
}

async function readProposalSnapshot(payload: ProposalFilesPayload): Promise<Snapshot | null> {
  const entry = payload.items.find((item) => item.path === SKILL_ENTRY_PATH)
  if (entry === undefined) return null
  try {
    const bodyBytes = await readSkillObjectBytes(entry.storageKey, entry.storageKey, entry.path)
    return {
      body: stripFrontmatter(bodyBytes.toString('utf8')),
      bodyBytes,
      files: payload.items.map((item) => ({ ...item })),
    }
  } catch (error) {
    getLogger().warn({ err: error, proposalPath: entry.storageKey }, '读取提案正文失败')
    return null
  }
}

function mergeFilesOf(snapshot: Snapshot): SkillMergeFile[] {
  return snapshot.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    mime: file.mime,
  }))
}

async function bytesOf(snapshot: Snapshot, path: string): Promise<Buffer | null> {
  const file = snapshot.files.find((item) => item.path === path)
  if (file === undefined) return null
  return readSkillObjectBytes(file.storageKey, file.storageKey, file.path)
}



/** 拒绝 / 撤回后回收提案的整版对象（spec 口径：只有 ACCEPTED 长期保留） */
async function cleanupProposalObjects(row: ProposalRow): Promise<void> {
  const payload = payloadOf(row.files)
  if (payload === null || payload.items.length === 0) return
  await removeKeysQuietly(payload.items.map((item) => item.storageKey))
}

function uniqueResolutions(resolutions: readonly SkillMergeResolution[] | undefined): SkillMergeResolution[] {
  return [...new Map((resolutions ?? []).map((item) => [item.anchor, item])).values()]
}

// ═════════════════════════════════════════════════════════════════════
// 提交提案
// ═════════════════════════════════════════════════════════════════════

/**
 * 从副本当前内容建提案草稿（`POST /api/skills/:id/proposal-draft`；`id` = 副本）。
 *
 * 上游必须可见；`baseVersion` 缺省 = 副本 `parentVersion`，再缺省 = 上游当前版本。
 * 依赖方向：本函数读副本版本快照，**不读上游正文**（提案内容来自我的副本）。
 */
export async function createProposalDraftFromFork(
  forkId: string,
  body: CreateSkillProposalDraftBody,
  viewer: SkillViewer,
): Promise<SkillDraft> {
  const fork = await requireSkill(forkId, viewer, 'edit')
  if (fork.parentSkillId === null) {
    throw AppError.validation(appMsg('app.m326'), { code: SKILL_ERROR_CODES.FORK_REQUIRED })
  }
  const target = await getPrisma().skill.findFirst({
    where: { id: fork.parentSkillId, deletedAt: null },
    select: SKILL_SELECT,
  })
  if (target === null || !canViewSkill(target, viewer)) {
    throw AppError.conflict(appMsg('app.m327', { p0: target?.name ?? fork.parentSkillId }), {
      code: SKILL_ERROR_CODES.UPSTREAM_NOT_AVAILABLE,
    })
  }
  if (target.createdBy === viewer.id) {
    throw AppError.validation(appMsg('app.m335'), { code: SKILL_ERROR_CODES.PROPOSAL_SELF_TARGET })
  }
  const baseVersion = body.baseVersion ?? fork.parentVersion ?? target.version
  if (baseVersion < 1 || baseVersion > target.version) {
    throw AppError.notFound(appMsg('app.m298', { p0: baseVersion, p1: target.version }))
  }
  const snapshot = await readVersionSnapshot(fork.id, fork.version)
  if (snapshot === null) {
    throw AppError.conflict(appMsg('app.m297', { p0: fork.name, p1: fork.version }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  return createSkillProposalDraftFromFork({
    viewer,
    target: { id: target.id, name: target.name, description: target.description },
    baseVersion,
    fork: {
      name: fork.name,
      description: fork.description,
      runtime: effectiveSkillRuntime(fork.runtime),
      requiresBins: Array.isArray(fork.requiresBins)
        ? fork.requiresBins.filter((bin): bin is string => typeof bin === 'string')
        : [],
      markdown: snapshot.body,
      changeSummary: body.changeSummary ?? '',
      storageKey: skillStoragePrefix(fork.id, fork.version),
      files: snapshot.files.map((file) => ({
        path: file.path,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
      })),
    },
  })
}

/**
 * 从**本会话覆写**直接建更新建议草稿（`POST /api/conversations/:id/skill-overrides/:overrideId/proposal-draft`）。
 *
 * 为什么需要它：非所属人要把"本会话已经改好并确认过脱敏"的内容提给上游时，原有入口只有
 * 「fork 一份副本 → 在副本上提交」——副本会越攒越多，而内容其实已经在覆写里了。
 * 这里直接把覆写的整版内容建成 `PROPOSAL` 草稿（`baseVersion = basedOnVersion`）：
 * **不建副本、不改上游**；`redactionCarried=true` 让审核页沿用覆写保存时那次脱敏确认。
 */
export async function createProposalDraftFromOverride(
  conversationId: string,
  overrideId: string,
  viewer: SkillViewer,
): Promise<SkillDraft> {
  const db = getPrisma()
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, userId: viewer.id },
    select: { id: true },
  })
  if (conversation === null) throw AppError.notFound(appMsg('app.m001'))

  const row = await db.conversationSkillOverride.findFirst({
    where: { id: overrideId, conversationId },
    select: { id: true, skillId: true, basedOnVersion: true, storageKey: true, files: true, changeSummary: true },
  })
  if (row === null) {
    throw AppError.notFound(appMsg('app.m320'), { code: SKILL_ERROR_CODES.OVERRIDE_NOT_FOUND })
  }

  const target = await db.skill.findFirst({
    where: { id: row.skillId, deletedAt: null },
    select: SKILL_SELECT,
  })
  if (target === null || !canViewSkill(target, viewer)) {
    throw AppError.notFound(appMsg('app.m316', { p0: row.skillId }))
  }
  if (target.createdBy === viewer.id) {
    throw AppError.validation(appMsg('app.m335'), { code: SKILL_ERROR_CODES.PROPOSAL_SELF_TARGET })
  }

  const raw = (await readSkillObjectQuietly(`${row.storageKey}${SKILL_ENTRY_PATH}`)).toString('utf8')
  const files = parseConversationSkillOverrideFiles(row.files).filter((file) => file.path !== SKILL_ENTRY_PATH)
  return await createSkillProposalDraftFromFork({
    viewer,
    target: { id: target.id, name: target.name, description: target.description },
    baseVersion: row.basedOnVersion,
    redactionCarried: true,
    fork: {
      name: target.name,
      description: target.description,
      runtime: effectiveSkillRuntime(target.runtime),
      requiresBins: Array.isArray(target.requiresBins)
        ? target.requiresBins.filter((bin): bin is string => typeof bin === 'string')
        : [],
      markdown: stripFrontmatter(raw),
      changeSummary: row.changeSummary ?? '',
      storageKey: row.storageKey,
      files,
    },
  })
}

/**
 * 提交提案（`POST /api/skills/:id/proposals`）。
 *
 * 顺序：读目标 → 读草稿并物化成整版文件 → 读基准快照 → 算 diff → **写 S3** → 写 DB → 消耗草稿。
 */
export async function submitSkillProposal(
  targetSkillId: string,
  body: SubmitSkillProposalBody,
  viewer: SkillViewer,
): Promise<SkillProposalItem> {
  const db = getPrisma()
  const target = await requireSkill(targetSkillId, viewer, 'view')
  if (target.createdBy === viewer.id) {
    throw AppError.validation(appMsg('app.m335'), { code: SKILL_ERROR_CODES.PROPOSAL_SELF_TARGET })
  }
  if (body.baseVersion > target.version) {
    throw AppError.notFound(appMsg('app.m298', { p0: body.baseVersion, p1: target.version }))
  }

  // 同一份草稿在「待审核 / 已通过」期间不能重复提交；打回后允许再次提交（会生成一条新提案）
  await assertSkillProposalDraftSubmittable(body.draftId, viewer)
  const draft = await materializeSkillProposalDraft(body.draftId, viewer, body.markdown)
  if (draft.targetSkillId !== targetSkillId) {
    throw AppError.validation(appMsg('app.m307', { p0: '提案目标与草稿不一致' }), {
      code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH,
    })
  }
  if (draft.baseVersion !== body.baseVersion) {
    throw AppError.validation(appMsg('app.m307', { p0: '提案基准与草稿不一致' }), {
      code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH,
    })
  }
  if (draft.markdown.trim() === '') {
    throw AppError.validation(appMsg('app.m305', { p0: '提案正文为空（不能把上游 Skill 清空）' }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: ['提案正文为空'],
    })
  }

  // 审计来源：带了会话就必须是**提交者自己的**；带消息 id 却没给会话直接拒
  if (body.sourceMessageIds !== undefined && body.sourceMessageIds.length > 0 && body.sourceConversationId === undefined) {
    throw AppError.validation(appMsg('app.m338'), { code: SKILL_ERROR_CODES.PROPOSAL_SOURCE_INVALID })
  }
  if (body.sourceConversationId !== undefined) {
    const conversation = await db.conversation.findFirst({
      where: { id: body.sourceConversationId, userId: viewer.id },
      select: { id: true },
    })
    if (conversation === null) {
      throw AppError.validation(appMsg('app.m338'), { code: SKILL_ERROR_CODES.PROPOSAL_SOURCE_INVALID })
    }
  }

  const base = await readVersionSnapshot(target.id, body.baseVersion)
  if (base === null) {
    throw AppError.conflict(appMsg('app.m329', { p0: body.baseVersion }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  const afterFiles = draft.files.filter((file) => file.path !== SKILL_ENTRY_PATH)
  const diff = computeSkillDiff({
    beforeMarkdown: base.body,
    afterMarkdown: draft.markdown,
    beforeFiles: base.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    afterFiles: afterFiles.map((file) => ({ path: file.path, size: file.bytes.length, sha256: file.sha256 })),
  })

  const proposalId = randomUUID()
  const prefix = skillProposalPrefix(proposalId)
  const written = await writeObjectsAtPrefix(prefix, draft.files)
  const payload: ProposalFilesPayload = {
    items: draft.files.map((file) => ({
      path: file.path,
      mime: file.mime,
      size: file.bytes.length,
      sha256: file.sha256,
      storageKey: `${prefix}${file.path}`,
    })),
    meta: {
      name: draft.name,
      description: draft.description,
      runtime: draft.runtime,
      requiresBins: draft.requiresBins,
    },
  }
  let saved: ProposalRow
  try {
    saved = await db.skillProposal.create({
      data: {
        id: proposalId,
        targetSkillId: target.id,
        baseVersion: body.baseVersion,
        proposedBy: viewer.id,
        changeSummary: body.changeSummary.trim(),
        diff: diff as unknown as Prisma.InputJsonValue,
        files: payload as unknown as Prisma.InputJsonValue,
        sourceConversationId: body.sourceConversationId ?? null,
        sourceMessageIds:
          body.sourceMessageIds === undefined
            ? Prisma.DbNull
            : (body.sourceMessageIds as Prisma.InputJsonValue),
      },
      include: PROPOSAL_INCLUDE,
    })
  } catch (error) {
    getLogger().error({ err: error, proposalId, targetSkillId }, '提案落库失败，回收刚写入的对象')
    await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
  await markSkillProposalSubmitted(body.draftId, proposalId, viewer, body.markdown)
  getLogger().info(
    { proposalId, targetSkillId, baseVersion: body.baseVersion, fileCount: payload.items.length },
    '已提交 Skill 更新建议',
  )
  return itemOf(saved)
}

// ═════════════════════════════════════════════════════════════════════
// 读取 / 列表
// ═════════════════════════════════════════════════════════════════════

/** 所属人 / ADMIN 的「更新建议」列表（目标不可编辑 ⇒ 404，不泄漏） */
export async function listSkillProposalsForTarget(
  targetSkillId: string,
  query: ListSkillProposalsQuery,
  viewer: SkillViewer,
): Promise<SkillProposalListResult> {
  await requireSkill(targetSkillId, viewer, 'edit')
  const db = getPrisma()
  const where = {
    targetSkillId,
    ...(query.status === undefined ? {} : { status: query.status }),
  }
  const [rows, total, pendingCount] = await db.$transaction([
    db.skillProposal.findMany({
      where,
      include: PROPOSAL_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: query.offset,
      take: query.limit,
    }),
    db.skillProposal.count({ where }),
    db.skillProposal.count({ where: { targetSkillId, status: 'PENDING' } }),
  ])
  return { items: rows.map(itemOf), total, pendingCount }
}

/** 提交者的「我的建议」列表（本批只支持 `mine=1`） */
export async function listMySkillProposals(
  query: ListSkillProposalsQuery,
  viewer: SkillViewer,
): Promise<SkillProposalListResult> {
  if (!query.mine) {
    throw AppError.validation(appMsg('app.m339'), { code: SKILL_ERROR_CODES.PROPOSAL_NOT_FOUND })
  }
  const db = getPrisma()
  const where = {
    proposedBy: viewer.id,
    ...(query.status === undefined ? {} : { status: query.status }),
  }
  const [rows, total, pendingCount] = await db.$transaction([
    db.skillProposal.findMany({
      where,
      include: PROPOSAL_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: query.offset,
      take: query.limit,
    }),
    db.skillProposal.count({ where }),
    db.skillProposal.count({ where: { proposedBy: viewer.id, status: 'PENDING' } }),
  ])
  return { items: rows.map(itemOf), total, pendingCount }
}

/**
 * 待我审核的提案总数（导航 / Skills 列表的外部提醒）。
 *
 * 判据与「更新建议」列表一致：目标必须未删除，且当前用户能编辑（所属人或 ADMIN）。
 * 只返回数字，不泄漏提案内容。
 */
export async function countPendingSkillProposalsForReview(viewer: SkillViewer): Promise<number> {
  return getPrisma().skillProposal.count({
    where: {
      status: 'PENDING',
      target: {
        deletedAt: null,
        ...(viewer.role === 'ADMIN' ? {} : { createdBy: viewer.id }),
      },
    },
  })
}

/**
 * 提案详情（提交者 / 目标所属人 / ADMIN 可读）。
 *
 * `merge` 只在基准与上游当前版本不一致时计算：无冲突 = `conflicts: []`（可直接三方合并），
 * 有冲突 = 逐项列出 `section:*` / `file:*` 供前端选择保留哪边。
 */
export async function getSkillProposal(id: string, viewer: SkillViewer): Promise<SkillProposalDetail> {
  const row = await findProposalRow(id)
  const isProposer = row.proposedBy === viewer.id
  const isOwner = canEditSkill(row.target, viewer)
  if (!isProposer && !isOwner) throw proposalNotFound()

  const payload = payloadOf(row.files)
  const proposalSnapshot = payload === null ? null : await readProposalSnapshot(payload)
  const targetAvailable = row.target.deletedAt === null && canViewSkill(row.target, viewer)
  const upstreamVersion = targetAvailable ? row.target.version : null
  const baseMatches = upstreamVersion !== null && row.baseVersion === upstreamVersion
  const upstreamSnapshot =
    targetAvailable && upstreamVersion !== null
      ? await readVersionSnapshot(row.target.id, upstreamVersion)
      : null
  let merge: SkillProposalDetail['merge'] = null
  if (targetAvailable && proposalSnapshot !== null && !baseMatches) {
    const base = await readVersionSnapshot(row.targetSkillId, row.baseVersion)
    const upstream = upstreamSnapshot
    if (base === null || upstream === null) {
      merge = { comparable: false, conflicts: [] }
    } else {
      const preview = mergeSkillThreeWay({
        baseMarkdown: base.body,
        upstreamMarkdown: upstream.body,
        proposalMarkdown: proposalSnapshot.body,
        baseFiles: mergeFilesOf(base),
        upstreamFiles: mergeFilesOf(upstream),
        proposalFiles: mergeFilesOf(proposalSnapshot),
      })
      merge = {
        comparable: true,
        conflicts: preview.ok ? [] : preview.conflicts,
      }
    }
  }
  return {
    ...proposalItemOf(row, changeCountOf(row.diff).count),
    diff: changeCountOf(row.diff).parsed,
    proposalMarkdown: proposalSnapshot?.body ?? '',
    upstreamMarkdown: upstreamSnapshot?.body ?? null,
    upstreamVersion,
    baseMatches,
    merge,
  }
}

// ═════════════════════════════════════════════════════════════════════
// 审核动作
// ═════════════════════════════════════════════════════════════════════

async function requireReviewable(
  id: string,
  viewer: SkillViewer,
): Promise<{ row: ProposalRow; target: SkillRow }> {
  const row = await findProposalRow(id)
  const target = await requireSkill(row.targetSkillId, viewer, 'edit')
  return { row, target }
}

/**
 * 接受提案（`POST /api/skill-proposals/:id/accept`）。
 *
 * 幂等：已 `ACCEPTED` 的提案重复 accept 返回当时的 `acceptedVersion`，不再写新版本。
 */
export async function acceptSkillProposal(
  id: string,
  body: AcceptSkillProposalBody,
  viewer: SkillViewer,
): Promise<AcceptSkillProposalResult> {
  const db = getPrisma()
  const { row, target } = await requireReviewable(id, viewer)
  if (row.status === 'ACCEPTED') {
    const version = row.acceptedVersion ?? target.version
    return {
      proposal: itemOf(row),
      skill: toItem(
        target,
        viewer,
        undefined,
        await parentInfoOf(target, viewer),
        (await skillHasScriptsMap([target])).get(target.id) ?? false,
      ),
      version,
    }
  }
  if (row.status !== 'PENDING' && row.status !== 'NEEDS_REBASE') throw statusConflict(row.status)

  const payload = payloadOf(row.files)
  if (payload === null) {
    throw AppError.internal(appMsg('app.m012'))
  }
  const proposalSnapshot = await readProposalSnapshot(payload)
  if (proposalSnapshot === null || proposalSnapshot.body.trim() === '') {
    throw AppError.validation(appMsg('app.m305', { p0: '提案正文不可读或为空' }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: ['提案正文不可读或为空'],
    })
  }

  let bodyMarkdown = proposalSnapshot.body
  let chosenFiles: { path: string; bytes: Buffer; mime: string; sha256: string }[] | null = null

  if (row.baseVersion !== target.version) {
    if (body.strategy !== 'THREE_WAY') {
      throw AppError.conflict(appMsg('app.m334', { p0: row.baseVersion, p1: target.version }), {
        code: SKILL_ERROR_CODES.PROPOSAL_BASE_CONFLICT,
      })
    }
    const [base, upstream] = await Promise.all([
      readVersionSnapshot(target.id, row.baseVersion),
      readVersionSnapshot(target.id, target.version),
    ])
    if (base === null || upstream === null) {
      throw AppError.conflict(appMsg('app.m329', { p0: row.baseVersion }), {
        code: SKILL_ERROR_CODES.VERSION_PURGED,
      })
    }
    const merged = mergeSkillThreeWay({
      baseMarkdown: base.body,
      upstreamMarkdown: upstream.body,
      proposalMarkdown: proposalSnapshot.body,
      baseFiles: mergeFilesOf(base),
      upstreamFiles: mergeFilesOf(upstream),
      proposalFiles: mergeFilesOf(proposalSnapshot),
      resolutions: uniqueResolutions(body.resolutions),
    })
    if (!merged.ok) {
      if ((body.resolutions ?? []).length === 0) {
        throw AppError.validation(appMsg('app.m336'), {
          code: SKILL_ERROR_CODES.PROPOSAL_RESOLUTIONS_REQUIRED,
          conflicts: merged.conflicts,
        })
      }
      await db.skillProposal.update({
        where: { id: row.id },
        data: { status: 'NEEDS_REBASE' },
      })
      throw AppError.conflict(appMsg('app.m337'), {
        code: SKILL_ERROR_CODES.PROPOSAL_NEEDS_REBASE,
        conflicts: merged.conflicts,
      })
    }
    bodyMarkdown = merged.markdown
    const sourceSnapshots: Record<SkillMergeChoice, Snapshot> = {
      BASE: base,
      UPSTREAM: upstream,
      PROPOSAL: proposalSnapshot,
    }
    chosenFiles = []
    for (const choice of merged.fileChoices) {
      if (choice.source === null) continue
      const bytes = await bytesOf(sourceSnapshots[choice.source], choice.path)
      if (bytes === null) {
        throw AppError.conflict(appMsg('app.m329', { p0: choice.path }), {
          code: SKILL_ERROR_CODES.VERSION_PURGED,
        })
      }
      chosenFiles.push({ path: choice.path, bytes, mime: choice.mime, sha256: choice.sha256 ?? shaOf(bytes) })
    }
  }

  if (chosenFiles === null) {
    chosenFiles = []
    for (const file of proposalSnapshot.files) {
      if (file.path === SKILL_ENTRY_PATH) continue
      if (!isSafeSkillPath(file.path)) {
        throw AppError.validation(appMsg('app.m305', { p0: `不允许的路径：${file.path}` }), {
          code: SKILL_ERROR_CODES.DRAFT_INVALID,
          reasons: [`不允许的路径：${file.path}`],
        })
      }
      const bytes = await bytesOf(proposalSnapshot, file.path)
      if (bytes === null) throw AppError.internal(appMsg('app.m012'))
      chosenFiles.push({ path: file.path, bytes, mime: file.mime, sha256: file.sha256 })
    }
  }

  const meta = payload.meta
  const hasScripts = chosenFiles.some((file) => isSkillScriptPath(file.path))
  // 带脚本 ⇒ 只能是 sandbox（与导入 / 草稿同一条一致性判据；不静默产出绑定必炸的组合）
  const runtime: SkillRuntime = hasScripts ? 'SANDBOX' : meta.runtime
  const requiresBins = meta.requiresBins
  const entryBytes = Buffer.from(
    composeSkillMarkdown({
      name: target.name,
      description: meta.description.trim() === '' ? target.description : meta.description,
      runtime,
      requiresScripts: hasScripts,
      requiresBins,
      body: bodyMarkdown,
      extra:
        target.manifest !== null && typeof target.manifest === 'object' && !Array.isArray(target.manifest)
          ? (target.manifest as Record<string, unknown>)
          : undefined,
    }),
    'utf8',
  )
  const files = [
    { path: SKILL_ENTRY_PATH, bytes: entryBytes, mime: 'text/markdown', sha256: shaOf(entryBytes) },
    ...chosenFiles,
  ]
  const previous = await readVersionSnapshot(target.id, target.version)
  const changeDiff =
    previous === null
      ? row.diff
      : computeSkillDiff({
          beforeMarkdown: previous.body,
          afterMarkdown: bodyMarkdown,
          beforeFiles: previous.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
          afterFiles: files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: file.sha256 })),
        })
  const nextVersion = target.version + 1
  const written = await writeObjectsAtPrefix(skillStoragePrefix(target.id, nextVersion), files)
  let saved: SkillRow
  let updatedProposal: ProposalRow
  try {
    const result = await db.$transaction(async (tx) => {
      const updated = await tx.skill.updateMany({
        where: { id: target.id, version: target.version, deletedAt: null },
        data: {
          description: meta.description.trim() === '' ? target.description : meta.description,
          runtime,
          requiresBins: [...requiresBins],
          version: nextVersion,
          storageKey: skillStoragePrefix(target.id, nextVersion),
        },
      })
      if (updated.count === 0) {
        throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
      }
      await tx.skillFile.createMany({
        data: files.map((file) => ({
          skillId: target.id,
          version: nextVersion,
          path: file.path,
          size: file.bytes.length,
          mime: file.mime,
          sha256: file.sha256,
          storageKey: `${skillStoragePrefix(target.id, nextVersion)}${file.path}`,
        })),
      })
      await tx.skillChange.create({
        data: {
          skillId: target.id,
          fromVersion: target.version,
          toVersion: nextVersion,
          changeSummary: row.changeSummary,
          diff: changeDiff === null ? Prisma.DbNull : (changeDiff as unknown as Prisma.InputJsonValue),
          source: 'PROPOSAL',
          sourceConversationId: row.sourceConversationId,
          sourceMessageIds:
            row.sourceMessageIds === null || row.sourceMessageIds === undefined
              ? Prisma.DbNull
              : (row.sourceMessageIds as Prisma.InputJsonValue),
          proposedBy: row.proposedBy,
          createdBy: viewer.id,
        },
      })
      const proposalUpdate = await tx.skillProposal.updateMany({
        where: { id: row.id, status: { in: ['PENDING', 'NEEDS_REBASE'] } },
        data: {
          status: 'ACCEPTED',
          acceptedVersion: nextVersion,
          reviewedBy: viewer.id,
          reviewedAt: new Date(),
          reviewNote: null,
        },
      })
      if (proposalUpdate.count === 0) {
        throw AppError.conflict(appMsg('app.m333', { p0: 'ACCEPTED' }), {
          code: SKILL_ERROR_CODES.PROPOSAL_STATUS_CONFLICT,
        })
      }
      const skill = await tx.skill.findUniqueOrThrow({ where: { id: target.id }, select: SKILL_SELECT })
      const proposal = await tx.skillProposal.findUniqueOrThrow({ where: { id: row.id }, include: PROPOSAL_INCLUDE })
      return { skill, proposal }
    })
    saved = result.skill
    updatedProposal = result.proposal
  } catch (error) {
    getLogger().error({ err: error, skillId: target.id, proposalId: row.id, nextVersion }, '提案落版失败，回收刚写入的对象')
    const lostCas =
      error instanceof AppError &&
      (error.data as { code?: unknown } | undefined)?.code === SKILL_ERROR_CODES.VERSION_CONFLICT
    if (!lostCas) await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }

  // 提案被接受后，若提交者自己的副本内容与新版上游一致 ⇒ 顺手把副本的 parentVersion 指到新版本。
  // 不改正文；失败只告警（展示层的「已合并到上游」以 `acceptedVersion` 为准）。
  await tryAdvanceProposerForks(row, target.id, nextVersion).catch((error: unknown) => {
    getLogger().warn({ err: error, proposalId: row.id, targetId: target.id }, '提案已接受，但推进提交者副本的 parentVersion 失败')
  })

  getLogger().info(
    { proposalId: row.id, targetSkillId: target.id, fromVersion: target.version, toVersion: nextVersion },
    '已接受 Skill 更新建议并生成上游新版本',
  )
  return {
    proposal: itemOf(updatedProposal),
    skill: toItem(
      saved,
      viewer,
      undefined,
      await parentInfoOf(saved, viewer),
      (await skillHasScriptsMap([saved])).get(saved.id) ?? false,
    ),
    version: nextVersion,
  }
}

async function tryAdvanceProposerForks(
  proposal: ProposalRow,
  targetSkillId: string,
  newUpstreamVersion: number,
): Promise<void> {
  const db = getPrisma()
  const forks = await db.skill.findMany({
    where: { parentSkillId: targetSkillId, createdBy: proposal.proposedBy, deletedAt: null },
    select: { id: true, version: true, parentVersion: true },
  })
  if (forks.length === 0) return
  const upstream = await readVersionSnapshot(targetSkillId, newUpstreamVersion)
  if (upstream === null) return
  for (const fork of forks) {
    const snapshot = await readVersionSnapshot(fork.id, fork.version)
    if (snapshot === null) continue
    if (
      !skillContentMatches({
        baseBody: upstream.body,
        forkBody: snapshot.body,
        baseFiles: mergeFilesOf(upstream).map((file) => ({ path: file.path, sha256: file.sha256 })),
        forkFiles: mergeFilesOf(snapshot).map((file) => ({ path: file.path, sha256: file.sha256 })),
      })
    ) {
      continue
    }
    await db.skill.updateMany({
      where: { id: fork.id, version: fork.version, parentVersion: fork.parentVersion },
      data: { parentVersion: newUpstreamVersion },
    })
  }
}

function shaOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 打回（`note` 必填；PENDING 可打回）。
 *
 * 2026-11-18 审核动作收敛：审核方只有「通过 / 打回」。打回写 `NEEDS_REBASE`，提交者可以在
 * 「我的草稿」里继续编辑同一份草稿并重新提交；不再有不可恢复的 `REJECTED`（历史数据保留）。
 * 提案文件**不回收**：打回页仍要能查看原建议内容。
 */
export async function rejectSkillProposal(
  id: string,
  body: ReviewSkillProposalBody,
  viewer: SkillViewer,
): Promise<SkillProposalItem> {
  const { row } = await requireReviewable(id, viewer)
  if (row.status !== 'PENDING') throw statusConflict(row.status)
  const updated = await getPrisma().skillProposal.update({
    where: { id: row.id },
    data: {
      status: 'NEEDS_REBASE',
      reviewedBy: viewer.id,
      reviewedAt: new Date(),
      reviewNote: body.note.trim(),
    },
    include: PROPOSAL_INCLUDE,
  })
  return itemOf(updated)
}

/** 撤回（提交者；PENDING / NEEDS_REBASE 可撤） */
export async function closeSkillProposal(
  id: string,
  body: CloseSkillProposalBody,
  viewer: SkillViewer,
): Promise<SkillProposalItem> {
  const row = await findProposalRow(id)
  if (row.proposedBy !== viewer.id && viewer.role !== 'ADMIN') throw proposalNotFound()
  if (row.status !== 'PENDING' && row.status !== 'NEEDS_REBASE') throw statusConflict(row.status)
  const updated = await getPrisma().skillProposal.update({
    where: { id: row.id },
    data: {
      status: 'CLOSED',
      reviewNote: body.note === undefined || body.note.trim() === '' ? row.reviewNote : body.note.trim(),
    },
    include: PROPOSAL_INCLUDE,
  })
  await cleanupProposalObjects(row)
  return itemOf(updated)
}

