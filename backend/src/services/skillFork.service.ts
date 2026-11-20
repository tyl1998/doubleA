/**
 * Fork / fast-forward 上游同步（P1-24c-5；`docs/子方案/会话生成Skill.md` §10.11 / §10.14 / §10.17）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条端点（全部只需登录；行级 ACL 由服务层判）
 * ─────────────────────────────────────────────────────────────────────
 *   POST /api/skills/:id/fork                 复制可见 Skill 为私有副本（`parentSkillId/parentVersion`）
 *   GET  /api/skills/:id/upstream-diff        副本详情「上游差异」（只读）
 *   POST /api/skills/:id/sync-upstream        仅 `FAST_FORWARD`（副本无本地改动）
 *
 * 另有 `promoteConversationSkillOverride`（`POST /api/conversations/:id/skill-overrides/:overrideId/promote`）：
 * 把会话级覆写落成自己的独立 Skill（fork），再删覆写 —— c-4b 预留的唯一出口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 五条硬口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **只复制自己看得到的内容**：fork 走 `requireSkill(view)`；PRIVATE 他人的 Skill 一律 404。
 * ② **内容判据而不是版本号判据**：见 `skillForkModel#skillContentMatches` —— fast-forward 后
 *    副本版本号也会 +1，但仍然「无本地改动」；只按 `version === 1` 判断会误拒下一次同步。
 * ③ **先 S3、后 DB**；DB 失败按前缀回收刚写的对象（与导入 / 草稿同一条顺序）。
 * ④ **上游 `SKILL.md` 的 frontmatter 按副本身份重生成**（名字带「（副本）」），正文逐字复制；
 *    fast-forward 时保留副本名，其余内容（description / runtime / bins / manifest）跟上游走。
 * ⑤ **绝不静默覆盖有本地改动的副本**：`comparable=false`（基准或正文已归档）同样按"有改动"拒绝。
 *
 * ⚠️ `THREE_WAY / MANUAL` 只在 c-6 起接受（共享同一 `mergeSkillThreeWay`）；Proposal 的另一条路在 `skillProposal.service.ts`。
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  AppError,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  appMsg,
  computeSkillDiff,
  effectiveSkillRuntime,
  isSkillScriptPath,
  mergeSkillThreeWay,
  skillStoragePrefix,
  type ForkSkillBody,
  type PromoteSkillOverrideResult,
  type SkillItem,
  type SkillMergeChoice,
  type SkillMergeFile,
  type SkillMergeResolution,
  type SkillRuntime,
  type SkillUpstreamDiff,
  type SkillUpstreamDiffQuery,
  type SyncSkillUpstreamBody,
  type SyncSkillUpstreamResult,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma, type Prisma } from '../infra/prisma.js'
import {
  SKILL_SELECT,
  assertNoSkillConflict,
  canViewSkill,
  findSkillConflict,
  skillHasScriptsMap,
  normalizeSkillVisibility,
  skillSlugOf,
  uniqueSkillSlug,
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
import { removeKeysQuietly, writeVersionObjects } from './skillDraft.service.js'
import { forkedSkillName, skillContentMatches, type SkillContentFile } from './skillForkModel.js'
import {
  parseConversationSkillOverrideFiles,
  removeOverridePrefixQuietly,
} from './skillOverride.service.js'
import { composeSkillMarkdown, stripFrontmatter } from './skillZip.js'

// ═════════════════════════════════════════════════════════════════════
// 公共小工具
// ═════════════════════════════════════════════════════════════════════

interface StoredFileRow {
  path: string
  size: number
  mime: string
  sha256: string
  storageKey: string
}

interface ContentFile {
  path: string
  bytes: Buffer
  mime: string
  sha256: string
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function requiresBinsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function manifestJson(value: unknown): Prisma.InputJsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Prisma.InputJsonValue
}

function extraFrontmatterOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function requiresScriptsOf(markdown: string): boolean {
  return /^\s{2}scripts:\s*true\s*$/mu.test(markdown)
}

function isPurged(row: { storageKey: string }): boolean {
  return row.storageKey === ''
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

function uniqueResolutions(resolutions: readonly SkillMergeResolution[] | undefined): SkillMergeResolution[] {
  return [...new Map((resolutions ?? []).map((item) => [item.anchor, item])).values()]
}

function forkRequired(): AppError {
  return AppError.validation(appMsg('app.m326'), { code: SKILL_ERROR_CODES.FORK_REQUIRED })
}

function upstreamUnavailable(name: string): AppError {
  return AppError.conflict(appMsg('app.m327', { p0: name }), {
    code: SKILL_ERROR_CODES.UPSTREAM_NOT_AVAILABLE,
  })
}

async function versionRowsOf(skillId: string, version: number): Promise<StoredFileRow[]> {
  return await getPrisma().skillFile.findMany({
    where: { skillId, version },
    select: { path: true, size: true, mime: true, sha256: true, storageKey: true },
    orderBy: { path: 'asc' },
  })
}

/** 读一个版本的 `SKILL.md` 正文 + 文件摘要；正文或任一行已归档 ⇒ `null`（不猜） */
async function readVersionSnapshot(
  skillId: string,
  version: number,
): Promise<{ body: string; files: (SkillContentFile & { size: number; mime: string; storageKey: string })[] } | null> {
  try {
    const rows = await versionRowsOf(skillId, version)
    if (rows.length === 0 || rows.some(isPurged)) return null
    const entry = rows.find((row) => row.path === SKILL_ENTRY_PATH)
    if (entry === undefined) return null
    const bytes = await readSkillObjectBytes(
      entry.storageKey,
      skillObjectKey(skillId, version, entry.path),
      entry.path,
    )
    return {
      body: stripFrontmatter(bytes.toString('utf8')),
      files: rows.map((row) => ({
        path: row.path,
        sha256: row.sha256,
        size: row.size,
        mime: row.mime,
        storageKey: row.storageKey,
      })),
    }
  } catch (error) {
    getLogger().warn({ err: error, skillId, version }, '读取 Skill 版本快照失败（按不可比较处理）')
    return null
  }
}

type VersionSnapshot = NonNullable<Awaited<ReturnType<typeof readVersionSnapshot>>>

function mergeFilesOf(snapshot: VersionSnapshot): SkillMergeFile[] {
  return snapshot.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    mime: file.mime,
  }))
}

async function bytesFromSnapshot(snapshot: VersionSnapshot, path: string): Promise<Buffer | null> {
  const file = snapshot.files.find((item) => item.path === path)
  if (file === undefined) return null
  return readSkillObjectBytes(file.storageKey, file.storageKey, file.path)
}

/** 副本当前内容 vs 基准版本（`fork.parentVersion`）；两侧都必须可读才敢下结论 */
async function compareForkWithBase(
  fork: SkillRow,
  parentSkillId: string,
): Promise<{ comparable: boolean; matches: boolean }> {
  if (fork.parentVersion === null) return { comparable: false, matches: false }
  const [base, current] = await Promise.all([
    readVersionSnapshot(parentSkillId, fork.parentVersion),
    readVersionSnapshot(fork.id, fork.version),
  ])
  if (base === null || current === null) return { comparable: false, matches: false }
  return {
    comparable: true,
    matches: skillContentMatches({
      baseBody: base.body,
      forkBody: current.body,
      baseFiles: base.files,
      forkFiles: current.files,
    }),
  }
}

/**
 * 读一版文件并产出可写对象；`entryMarkdown` 用于把 `SKILL.md` 的 frontmatter
 * 按新身份重生成（其余文件逐字复制）。
 */
async function materializeVersionFiles(input: {
  skillId: string
  version: number
  rows: readonly StoredFileRow[]
  entryMarkdown?: (raw: string) => string
  /** 行里 `storageKey` 读不到时的回退键；缺省按 `(skillId, version, path)` 重拼 */
  fallbackKey?: (row: StoredFileRow) => string
}): Promise<ContentFile[]> {
  const files: ContentFile[] = []
  for (const row of input.rows) {
    if (isPurged(row)) {
      throw AppError.conflict(appMsg('app.m301', { p0: row.path }), {
        code: SKILL_ERROR_CODES.VERSION_PURGED,
      })
    }
    const fallback = input.fallbackKey?.(row) ?? skillObjectKey(input.skillId, input.version, row.path)
    const bytes = await readSkillObjectBytes(row.storageKey, fallback, row.path)
    if (row.path !== SKILL_ENTRY_PATH || input.entryMarkdown === undefined) {
      files.push({ path: row.path, bytes, mime: row.mime, sha256: row.sha256 })
      continue
    }
    const rewritten = Buffer.from(input.entryMarkdown(bytes.toString('utf8')), 'utf8')
    files.push({ path: row.path, bytes: rewritten, mime: row.mime, sha256: sha256Of(rewritten) })
  }
  return files
}

/** 以副本身份重生成 `SKILL.md`（frontmatter 的 name 是副本名，正文逐字保留） */
function entryRewriter(meta: {
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: readonly string[]
  manifest: unknown
}): (raw: string) => string {
  return (raw: string): string =>
    composeSkillMarkdown({
      name: meta.name,
      description: meta.description,
      runtime: meta.runtime,
      requiresScripts: requiresScriptsOf(raw),
      requiresBins: meta.requiresBins,
      body: stripFrontmatter(raw),
      extra: extraFrontmatterOf(meta.manifest),
    })
}

/** 在"我的 Skills"里为副本挑一个不重名的名字（`X（副本）` → `X（副本 2）` …） */
async function uniqueForkName(sourceName: string, ownerId: string): Promise<string> {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = forkedSkillName(sourceName, attempt)
    const taken = await getPrisma().skill.findFirst({
      where: { deletedAt: null, createdBy: ownerId, name: candidate },
      select: { id: true },
    })
    if (taken === null) return candidate
  }
  throw AppError.conflict(appMsg('app.m291', { p0: sourceName }), { code: SKILL_ERROR_CODES.NAME_TAKEN })
}

/** 新建一个私有副本（先 S3、后 DB；唯一索引冲突翻 409，不 500） */
async function createForkedSkill(input: {
  viewer: SkillViewer
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: readonly string[]
  manifest: unknown
  parentSkillId: string
  parentVersion: number
  files: readonly ContentFile[]
  changeSummary: string
}): Promise<SkillRow> {
  const db = getPrisma()
  const skillId = randomUUID()
  const version = 1
  const slug = await uniqueSkillSlug(skillSlugOf(input.name, skillId.slice(-8)))
  assertNoSkillConflict(
    await findSkillConflict({ createdBy: input.viewer.id, name: input.name, slug }),
    input.name,
  )

  const written = await writeVersionObjects(skillId, version, input.files)
  try {
    const saved = await db.$transaction(async (tx) => {
      await tx.skill.create({
        data: {
          id: skillId,
          name: input.name,
          slug,
          description: input.description,
          runtime: input.runtime,
          requiresBins: [...input.requiresBins],
          version,
          manifest: manifestJson(input.manifest),
          sourceType: 'MANUAL',
          storageKey: skillStoragePrefix(skillId, version),
          parentSkillId: input.parentSkillId,
          parentVersion: input.parentVersion,
          createdBy: input.viewer.id,
          visibility: normalizeSkillVisibility('PRIVATE'),
        },
      })
      await tx.skillFile.createMany({
        data: input.files.map((file) => ({
          skillId,
          version,
          path: file.path,
          size: file.bytes.length,
          mime: file.mime,
          sha256: file.sha256,
          storageKey: skillObjectKey(skillId, version, file.path),
        })),
      })
      await tx.skillChange.create({
        data: {
          skillId,
          fromVersion: 0,
          toVersion: version,
          changeSummary: input.changeSummary,
          source: 'MANUAL',
          createdBy: input.viewer.id,
        },
      })
      return tx.skill.findUniqueOrThrow({ where: { id: skillId }, select: SKILL_SELECT })
    })
    return saved
  } catch (error) {
    getLogger().error({ err: error, skillId, parentSkillId: input.parentSkillId }, '副本落库失败，回收刚写入的对象')
    await removeKeysQuietly(written)
    if (error instanceof AppError) throw error
    if (isUniqueViolation(error)) {
      throw AppError.conflict(appMsg('app.m291', { p0: input.name }), { code: SKILL_ERROR_CODES.NAME_TAKEN })
    }
    throw AppError.internal(appMsg('app.m012'))
  }
}

// ═════════════════════════════════════════════════════════════════════
// Fork
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /api/skills/:id/fork`：复制**可见** Skill 的指定版本为当前用户的私有副本。
 *
 * @throws {AppError} 404 源不可见 / 版本不存在；409 版本正文已归档 / 名称或 slug 冲突
 */
export async function forkSkill(
  sourceId: string,
  body: ForkSkillBody,
  viewer: SkillViewer,
): Promise<SkillItem> {
  const source = await requireSkill(sourceId, viewer, 'view')
  const parentVersion = body.parentVersion ?? source.version
  if (parentVersion < 1 || parentVersion > source.version) {
    throw AppError.notFound(appMsg('app.m298', { p0: parentVersion, p1: source.version }))
  }
  const rows = await versionRowsOf(source.id, parentVersion)
  if (rows.length === 0 || rows.some(isPurged)) {
    throw AppError.conflict(appMsg('app.m297', { p0: source.name, p1: parentVersion }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }

  const name = await uniqueForkName(source.name, viewer.id)
  const files = await materializeVersionFiles({
    skillId: source.id,
    version: parentVersion,
    rows,
    entryMarkdown: entryRewriter({
      name,
      description: source.description,
      runtime: effectiveSkillRuntime(source.runtime),
      requiresBins: requiresBinsOf(source.requiresBins),
      manifest: source.manifest,
    }),
  })
  const saved = await createForkedSkill({
    viewer,
    name,
    description: source.description,
    runtime: effectiveSkillRuntime(source.runtime),
    requiresBins: requiresBinsOf(source.requiresBins),
    manifest: source.manifest,
    parentSkillId: source.id,
    parentVersion,
    files,
    changeSummary: `从《${source.name}》v${String(parentVersion)} 复制为我的 Skill（${String(files.length)} 个文件）`,
  })
  getLogger().info(
    { skillId: saved.id, sourceId: source.id, parentVersion, fileCount: files.length },
    '已复制 Skill 为私有副本',
  )
  return toItem(
    saved,
    viewer,
    undefined,
    await parentInfoOf(saved, viewer),
    (await skillHasScriptsMap([saved])).get(saved.id) ?? false,
  )
}

// ═════════════════════════════════════════════════════════════════════
// 上游差异 / fast-forward
// ═════════════════════════════════════════════════════════════════════

function emptySkillDiff(): ReturnType<typeof computeSkillDiff> {
  return computeSkillDiff({
    beforeMarkdown: '',
    afterMarkdown: '',
    beforeFiles: [],
    afterFiles: [],
  })
}

/** 上游 `fromVersion → toVersion` 的内容差异；任一侧正文归档 ⇒ `null` */
async function upstreamDiffOf(
  parentSkillId: string,
  fromVersion: number,
  toVersion: number,
): Promise<ReturnType<typeof computeSkillDiff> | null> {
  if (fromVersion === toVersion) return emptySkillDiff()
  const [before, after] = await Promise.all([
    readVersionSnapshot(parentSkillId, fromVersion),
    readVersionSnapshot(parentSkillId, toVersion),
  ])
  if (before === null || after === null) return null
  return computeSkillDiff({
    beforeMarkdown: before.body,
    afterMarkdown: after.body,
    beforeFiles: before.files.map((file) => ({ ...file, size: 0 })),
    afterFiles: after.files.map((file) => ({ ...file, size: 0 })),
  })
}

/**
 * `GET /api/skills/:id/upstream-diff`：副本详情 / 列表的「上游差异」。
 *
 * 只读；`parentAvailable=false` 时不再读取上游正文（删了 / 不可见都只回状态，不泄漏内容）。
 */
export async function getSkillUpstreamDiff(
  forkId: string,
  query: SkillUpstreamDiffQuery,
  viewer: SkillViewer,
): Promise<SkillUpstreamDiff> {
  const fork = await requireSkill(forkId, viewer, 'view')
  if (fork.parentSkillId === null) throw forkRequired()

  const parent = await getPrisma().skill.findUnique({
    where: { id: fork.parentSkillId },
    select: SKILL_SELECT,
  })
  const parentDeleted = parent === null || parent.deletedAt !== null
  // 上游可能已经从 PUBLIC 改成 PRIVATE：不可见时与删除同档（不再读它的正文 / 版本号）
  const parentAvailable = parent !== null && !parentDeleted && canViewSkill(parent, viewer)
  const syncedVersion = fork.parentVersion
  const upstreamVersion = parentAvailable ? parent.version : null

  const fromVersion = query.fromVersion ?? syncedVersion
  if (fromVersion !== null && upstreamVersion !== null && fromVersion > upstreamVersion) {
    throw AppError.notFound(appMsg('app.m298', { p0: fromVersion, p1: upstreamVersion }))
  }

  const comparison =
    parentAvailable && parent !== null
      ? await compareForkWithBase(fork, parent.id)
      : { comparable: false, matches: false }
  const hasLocalChanges = comparison.comparable ? !comparison.matches : true

  const diff =
    parentAvailable && parent !== null && fromVersion !== null && upstreamVersion !== null
      ? await upstreamDiffOf(parent.id, fromVersion, upstreamVersion)
      : null

  const latest =
    parentAvailable && parent !== null && upstreamVersion !== null
      ? await readVersionSnapshot(parent.id, upstreamVersion)
      : null
  const upToDate =
    syncedVersion !== null && upstreamVersion !== null && upstreamVersion <= syncedVersion
  const canFastForward =
    parentAvailable &&
    !upToDate &&
    comparison.comparable &&
    comparison.matches &&
    latest !== null

  // c-6：有本地改动但三份正文都可读 ⇒ 允许显式三方合并；先把冲突锚点算出来给前端逐项确认
  let canThreeWay = false
  let mergeConflicts: { anchor: string; kind: 'section' | 'file'; label: string }[] = []
  if (
    parentAvailable &&
    parent !== null &&
    !upToDate &&
    comparison.comparable &&
    latest !== null &&
    fork.parentVersion !== null
  ) {
    const [base, mine] = await Promise.all([
      readVersionSnapshot(parent.id, fork.parentVersion),
      readVersionSnapshot(fork.id, fork.version),
    ])
    if (base !== null && mine !== null) {
      canThreeWay = true
      const preview = mergeSkillThreeWay({
        baseMarkdown: base.body,
        upstreamMarkdown: latest.body,
        proposalMarkdown: mine.body,
        baseFiles: mergeFilesOf(base),
        upstreamFiles: mergeFilesOf(latest),
        proposalFiles: mergeFilesOf(mine),
      })
      if (!preview.ok) mergeConflicts = preview.conflicts
    }
  }

  return {
    skillId: fork.id,
    parentSkillId: fork.parentSkillId,
    parentName: parent?.name ?? null,
    parentSlug: parent?.slug ?? null,
    parentAvailable,
    parentDeleted,
    syncedVersion,
    upstreamVersion,
    upToDate,
    hasLocalChanges,
    comparable: comparison.comparable,
    canFastForward,
    canThreeWay,
    mergeConflicts,
    diff,
  }
}

/**
 * `POST /api/skills/:id/sync-upstream`：fast-forward，或显式 `THREE_WAY / MANUAL` 三方合并。
 *
 * 顺序：CAS `parentVersion` → 无上游更新 ⇒ 幂等返回 →（fast-forward 时）本地改动 / 基准不可读 ⇒ 409
 *      → 读上游最新版（三方合并再读 base / 副本快照，冲突逐项选边）
 *      → 先写 S3 → 事务切版本（`parentVersion` 指到上游最新版）。
 */
export async function syncSkillUpstream(
  forkId: string,
  body: SyncSkillUpstreamBody,
  viewer: SkillViewer,
): Promise<SyncSkillUpstreamResult> {
  const db = getPrisma()
  const fork = await requireSkill(forkId, viewer, 'edit')
  if (fork.parentSkillId === null) throw forkRequired()
  if (fork.parentVersion === null) throw forkRequired()
  if (fork.parentVersion !== body.fromVersion) {
    throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
  }

  const parent = await db.skill.findUnique({
    where: { id: fork.parentSkillId },
    select: SKILL_SELECT,
  })
  if (parent === null || parent.deletedAt !== null || !canViewSkill(parent, viewer)) {
    throw upstreamUnavailable(parent?.name ?? fork.parentSkillId)
  }

  const currentItem = await toItem(fork, viewer, undefined, await parentInfoOf(fork, viewer))
  if (parent.version <= fork.parentVersion) {
    return {
      skill: currentItem,
      fromVersion: fork.parentVersion,
      toVersion: fork.version,
      upstreamVersion: parent.version,
    }
  }

  const requiresBins = requiresBinsOf(parent.requiresBins)
  let files: { path: string; bytes: Buffer; mime: string; sha256: string }[]
  let strategyLabel = 'fast-forward'
  let savedRuntime: SkillRuntime = effectiveSkillRuntime(parent.runtime)
  if (body.strategy === 'FAST_FORWARD') {
    const comparison = await compareForkWithBase(fork, parent.id)
    if (!comparison.comparable || !comparison.matches) {
      throw AppError.conflict(appMsg('app.m328', { p0: fork.name }), {
        code: SKILL_ERROR_CODES.UPSTREAM_LOCAL_CHANGES,
      })
    }
    const rows = await versionRowsOf(parent.id, parent.version)
    if (rows.length === 0 || rows.some(isPurged)) {
      throw AppError.conflict(appMsg('app.m329', { p0: parent.version }), {
        code: SKILL_ERROR_CODES.VERSION_PURGED,
      })
    }
    files = await materializeVersionFiles({
      skillId: parent.id,
      version: parent.version,
      rows,
      entryMarkdown: entryRewriter({
        name: fork.name,
        description: parent.description,
        runtime: effectiveSkillRuntime(parent.runtime),
        requiresBins,
        manifest: parent.manifest,
      }),
    })
  } else {
    // THREE_WAY / MANUAL：base = 副本基于的上游版本；upstream = 上游当前；proposal 位 = 我的副本
    const [base, upstream, mine] = await Promise.all([
      readVersionSnapshot(parent.id, fork.parentVersion),
      readVersionSnapshot(parent.id, parent.version),
      readVersionSnapshot(fork.id, fork.version),
    ])
    if (base === null) {
      throw AppError.conflict(appMsg('app.m329', { p0: fork.parentVersion }), {
        code: SKILL_ERROR_CODES.VERSION_PURGED,
      })
    }
    if (upstream === null || mine === null) {
      throw AppError.internal(appMsg('app.m012'))
    }
    const merged = mergeSkillThreeWay({
      baseMarkdown: base.body,
      upstreamMarkdown: upstream.body,
      proposalMarkdown: mine.body,
      baseFiles: mergeFilesOf(base),
      upstreamFiles: mergeFilesOf(upstream),
      proposalFiles: mergeFilesOf(mine),
      resolutions: uniqueResolutions(body.resolutions),
    })
    if (!merged.ok) {
      if ((body.resolutions ?? []).length === 0) {
        throw AppError.validation(appMsg('app.m336'), {
          code: SKILL_ERROR_CODES.PROPOSAL_RESOLUTIONS_REQUIRED,
          conflicts: merged.conflicts,
        })
      }
      throw AppError.conflict(appMsg('app.m337'), {
        code: SKILL_ERROR_CODES.PROPOSAL_NEEDS_REBASE,
        conflicts: merged.conflicts,
      })
    }
    const snapshots: Record<SkillMergeChoice, VersionSnapshot> = {
      BASE: base,
      UPSTREAM: upstream,
      PROPOSAL: mine,
    }
    const chosen: { path: string; bytes: Buffer; mime: string; sha256: string }[] = []
    for (const choice of merged.fileChoices) {
      if (choice.source === null) continue
      const bytes = await bytesFromSnapshot(snapshots[choice.source], choice.path)
      if (bytes === null) throw AppError.internal(appMsg('app.m012'))
      chosen.push({
        path: choice.path,
        bytes,
        mime: choice.mime,
        sha256: choice.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
      })
    }
    const requiresScripts = chosen.some((file) => isSkillScriptPath(file.path))
    const movedRuntime: SkillRuntime = requiresScripts ? 'SANDBOX' : effectiveSkillRuntime(parent.runtime)
    savedRuntime = movedRuntime
    const entryBytes = Buffer.from(
      composeSkillMarkdown({
        name: fork.name,
        description: parent.description,
        runtime: movedRuntime,
        requiresScripts,
        requiresBins,
        body: merged.markdown,
        extra: extraFrontmatterOf(parent.manifest),
      }),
      'utf8',
    )
    files = [
      {
        path: SKILL_ENTRY_PATH,
        bytes: entryBytes,
        mime: 'text/markdown',
        sha256: createHash('sha256').update(entryBytes).digest('hex'),
      },
      ...chosen,
    ]
    strategyLabel = 'three-way'
  }

  const nextVersion = fork.version + 1
  const written = await writeVersionObjects(fork.id, nextVersion, files)
  let saved: SkillRow
  try {
    saved = await db.$transaction(async (tx) => {
      const updated = await tx.skill.updateMany({
        where: { id: fork.id, version: fork.version, deletedAt: null },
        data: {
          description: parent.description,
          runtime: savedRuntime,
          requiresBins: [...requiresBins],
          version: nextVersion,
          manifest: manifestJson(parent.manifest),
          storageKey: skillStoragePrefix(fork.id, nextVersion),
          parentVersion: parent.version,
        },
      })
      if (updated.count === 0) {
        throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
      }
      await tx.skillFile.createMany({
        data: files.map((file) => ({
          skillId: fork.id,
          version: nextVersion,
          path: file.path,
          size: file.bytes.length,
          mime: file.mime,
          sha256: file.sha256,
          storageKey: skillObjectKey(fork.id, nextVersion, file.path),
        })),
      })
      await tx.skillChange.create({
        data: {
          skillId: fork.id,
          fromVersion: fork.version,
          toVersion: nextVersion,
          changeSummary: `从上游《${parent.name}》v${String(fork.parentVersion)} 同步到 v${String(parent.version)}（${strategyLabel}）`,
          source: 'MANUAL',
          createdBy: viewer.id,
        },
      })
      return tx.skill.findUniqueOrThrow({ where: { id: fork.id }, select: SKILL_SELECT })
    })
  } catch (error) {
    getLogger().error({ err: error, skillId: fork.id, nextVersion }, '副本同步落库失败')
    // CAS 输给另一个并发同步时**不能回收**：同一个 `v{n+1}` 前缀可能已经是赢家的对象，
    // 删掉会把赢家的 DB 行指向空对象（真·丢数据）；多余对象交给保留期清理器。
    const lostCas =
      error instanceof AppError &&
      (error.data as { code?: unknown } | undefined)?.code === SKILL_ERROR_CODES.VERSION_CONFLICT
    if (!lostCas) await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }

  getLogger().info(
    { skillId: fork.id, fromVersion: fork.version, toVersion: nextVersion, upstreamVersion: parent.version },
    '副本已 fast-forward 到上游版本',
  )
  return {
    skill: toItem(
      saved,
      viewer,
      undefined,
      await parentInfoOf(saved, viewer),
      (await skillHasScriptsMap([saved])).get(saved.id) ?? false,
    ),
    fromVersion: fork.version,
    toVersion: nextVersion,
    upstreamVersion: parent.version,
  }
}

// ═════════════════════════════════════════════════════════════════════
// 会话覆写 → 我的 Skill（promote；c-4b 的唯一出口）
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /api/conversations/:id/skill-overrides/:overrideId/promote`：先 fork、再删覆写。
 *
 * 删除失败**不抛整轮错误**（副本已经建好）：返回 `overrideDeleted=false`，
 * 调用方可提示"覆写仍在，可稍后放弃" —— 绝不会出现"两边都没有"。
 */
export async function promoteConversationSkillOverride(
  conversationId: string,
  overrideId: string,
  viewer: SkillViewer,
): Promise<PromoteSkillOverrideResult> {
  const db = getPrisma()
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, userId: viewer.id },
    select: { id: true },
  })
  if (conversation === null) throw AppError.notFound(appMsg('app.m001'))

  const override = await db.conversationSkillOverride.findFirst({
    where: { id: overrideId, conversationId },
    select: {
      id: true,
      skillId: true,
      basedOnVersion: true,
      revision: true,
      storageKey: true,
      files: true,
    },
  })
  if (override === null) {
    throw AppError.notFound(appMsg('app.m320'), { code: SKILL_ERROR_CODES.OVERRIDE_NOT_FOUND })
  }

  const source = await db.skill.findUnique({ where: { id: override.skillId }, select: SKILL_SELECT })
  if (source === null) throw AppError.notFound(appMsg('app.m316', { p0: override.skillId }))

  const rows: StoredFileRow[] = parseConversationSkillOverrideFiles(override.files).map((file) => ({
    path: file.path,
    size: file.size,
    mime: file.mime,
    sha256: file.sha256,
    storageKey: `${override.storageKey}${file.path}`,
  }))
  if (rows.length === 0 || !rows.some((row) => row.path === SKILL_ENTRY_PATH)) {
    throw AppError.validation(appMsg('app.m305', { p0: '会话覆写缺少 SKILL.md' }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
    })
  }
  if (effectiveSkillRuntime(source.runtime) === 'INLINE' && rows.some((row) => row.path.startsWith('scripts/'))) {
    throw AppError.validation(appMsg('app.m323', { p0: source.name }), {
      code: SKILL_ERROR_CODES.IMPORT_INVALID,
    })
  }

  const requiresBins = requiresBinsOf(source.requiresBins)
  const name = await uniqueForkName(source.name, viewer.id)
  const files = await materializeVersionFiles({
    skillId: source.id,
    version: override.basedOnVersion,
    rows,
    // 覆写的对象只在自己的前缀里；**不能**回退到上游同版本对象（否则会静默丢掉覆写内容）
    fallbackKey: (row) => row.storageKey,
    entryMarkdown: entryRewriter({
      name,
      description: source.description,
      runtime: effectiveSkillRuntime(source.runtime),
      requiresBins,
      manifest: source.manifest,
    }),
  })
  const saved = await createForkedSkill({
    viewer,
    name,
    description: source.description,
    runtime: effectiveSkillRuntime(source.runtime),
    requiresBins,
    manifest: source.manifest,
    parentSkillId: source.id,
    parentVersion: override.basedOnVersion,
    files,
    changeSummary: `由会话覆写 r${String(override.revision)} 另存为我的 Skill（基于《${source.name}》v${String(override.basedOnVersion)}，${String(files.length)} 个文件）`,
  })

  let overrideDeleted = true
  try {
    await db.conversationSkillOverride.delete({ where: { id: override.id } })
    await removeOverridePrefixQuietly(override.storageKey)
  } catch (error) {
    overrideDeleted = false
    getLogger().warn(
      { err: error, conversationId, overrideId },
      '副本已建立，但会话覆写删除失败（覆写保留，可稍后手动放弃）',
    )
  }

  getLogger().info(
    { skillId: saved.id, conversationId, overrideId, parentSkillId: source.id, parentVersion: override.basedOnVersion },
    '已把会话覆写另存为我的 Skill',
  )
  return {
    skill: toItem(
      saved,
      viewer,
      undefined,
      await parentInfoOf(saved, viewer),
      (await skillHasScriptsMap([saved])).get(saved.id) ?? false,
    ),
    overrideDeleted,
  }
}