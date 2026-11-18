/**
 * Skill 草稿服务（P1-24c-1；`docs/子方案/会话生成Skill.md` §五 / §六 / §七.2 / §十）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与邻居的分工（别把判据写两遍）
 * ─────────────────────────────────────────────────────────────────────
 * · `skill.service.ts`（a-1）= 纯判据；`skillAsset.service.ts`（a-2）= 导入 / 管理面编排；
 *   `sandbox/skillScript.ts#normalizeSkillDraftContent`（b-3 的纯函数簇）= 草稿内容的路径 / 一致性判据。
 * · **本文件（c-1）= 草稿编排**：Redis 草稿 JSON + S3 临时前缀 + 落库（v1 / vN+1）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 七条口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **草稿是服务端资源**：前端只提交 `draftId` + 展示元数据。文件上传走独立端点、键由服务端拼，
 *    `storageKey` / `files` / `markdown` 一律**不**从保存入口读（口径见 `shared/src/skill.ts` 草稿段）。
 * ② **草稿 JSON 与文件分开存**：JSON 进 Redis（TTL = `config.skill.draft.ttlSec`，`GET/PUT` 续期），
 *    文件进 S3 `skill-drafts/{userId}/{draftId}/{path}`。**先写 S3、后写 JSON**：反过来会出现
 *    "草稿里列着一个不存在的对象"（落库时才炸，用户看不出哪一步坏的）。
 * ③ **`SKILL.md` 的文件行是派生值**：它不进 `files[]`（正文在 `markdown` 字段里），落库 /
 *    下载时才由 `composeSkillMarkdown` 按 DB 字段重写 frontmatter（与导入同一条纪律）。
 *    **保存入口允许带"脱敏确认后的正文"**（审核页的「恢复」只活在这一次提交里），
 *    但它同样过 server-side scan：恢复回来的凭据形状一律 400 —— 见 `shared` 同名 schema 注释。
 * ④ **落库顺序 = 先 S3、后 DB**（照抄 `importSkillPackage`）：新建写 `skills/{id}/v1/`、
 *    revision 写 `skills/{id}/v{n+1}/`；DB 失败按前缀回收刚写的对象。
 * ⑤ **草稿用一次就消耗**：成功落库后 `DEL` Redis 键并回收 `skill-drafts/...` 下的对象；
 *    重复提交旧页面 ⇒ 404（而不是产出第二份同名 Skill）。
 * ⑥ **脱敏与 secret scan 都在服务端**：草稿正文（及每个文本文件）保存 / 落库前**重跑**一次
 *    `scanSkillSecrets`；命中凭据形状 ⇒ 400 `SKILL_DRAFT_SECRET_FOUND`（带命中清单，不回显原文）。
 * ⑦ **顺带绑定失败不影响保存**：先落 Skill，再尝试写 `agent_components`；失败回 `bindError`
 *    （人话），**不**让整个请求 4xx —— 否则用户会以为没保存而重试，产出重复 Skill。
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  SKILL_DRAFT_FILE_KINDS,
  SKILL_DRAFT_KINDS_SUPPORTED,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  SKILL_REDACTION_KINDS,
  SKILL_RUNTIMES,
  appMsg,
  AppError,
  computeSkillDiff,
  isSafeSkillPath,
  isSkillScriptPath,
  scanSkillSecrets,
  skillStoragePrefix,
  type SaveSkillFromDraftBody,
  type SaveSkillFromDraftResult,
  type SaveSkillRevisionFromDraftBody,
  type SkillChange,
  type SkillDraft,
  type SkillDraftFile,
  type SkillDraftFileKind,
  type SkillDraftKind,
  type SkillDraftListResult,
  type SkillDraftSource,
  type SkillDraftSubmission,
  type SkillRedaction,
  type SkillRuntime,
  type SkillVersion,
  type UpdateSkillDraftBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma, Prisma } from '../infra/prisma.js'
import {
  addSkillDraftToUserIndex,
  deleteSkillDraftRaw,
  readSkillDraftIdsForUser,
  readSkillDraftRaw,
  removeSkillDraftFromUserIndex,
  scanSkillDraftIds,
  writeSkillDraftRaw,
} from '../infra/redis.js'
import { getS3Client, isS3NoSuchKey } from '../infra/s3.js'
import { normalizeSkillDraftContent } from '../sandbox/skillScript.js'
import {
  SKILL_SELECT,
  assertNoSkillConflict,
  canEditSkill,
  canViewSkill,
  findSkillConflict,
  skillSlugOf,
  normalizeSkillVisibility,
  uniqueSkillSlug,
  type SkillRow,
  type SkillViewer,
} from './skill.service.js'
import { parentInfoOf, toItem as projectSkillItem } from './skillAsset.service.js'
import { composeSkillMarkdown, importError, stripFrontmatter } from './skillZip.js'

/** 草稿在 Redis 里的形状（**服务端内部**；对外只经 {@link toDraft} 投影，绝不原样透出 `files[].draftKey`） */
interface SkillDraftRecord {
  id: string
  userId: string
  kind: SkillDraftKind
  targetSkillId: string | null
  baseVersion: number | null
  /** `SESSION_OVERRIDE` 的所属会话（其余 `null`） */
  overrideConversationId: string | null
  /** `SESSION_OVERRIDE` 保存时的期望 revision（`null` = 第一次建） */
  expectedRevision: number | null
  /** `SESSION_OVERRIDE`（按上游重建）要替换的覆写 id；新建为 `null` */
  overrideId: string | null
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: string[]
  markdown: string
  warnings: string[]
  /** 生成时模型给出的变更说明（REVISION；审核页预填） */
  changeSummary: string
  /** 生成时命中的风险提示（REVISION；审核页与现算结果取并集） */
  risks: string[]
  files: { path: string; kind: SkillDraftFileKind; mime: string; size: number; sha256: string }[]
  /** 草稿**建立时**的 secret scan 结果（用户逐项确认的基线；保存时还会重跑一次） */
  redactions: SkillRedaction[]
  /** 脱敏确认已由上一份已保存的草稿完成（内容原样搬运；审核页免一次重复确认） */
  redactionCarried?: boolean
  /**
   * PROPOSAL 草稿最近一次提交的提案（提交后草稿保留，不再消耗）。
   * 状态 / 审核意见来自 `SkillProposal` 行，读取时实时投影。
   */
  submission?: { proposalId: string; submittedAt: string } | null
  /** 从会话抽取时的出处（c-2；手建草稿为 `null`）——落库时写进 `skills.source_*` */
  source: SkillDraftSource | null
  createdAt: string
  updatedAt: string
}

/** 草稿存活时长（秒）—— `GET/PUT` 续期 */
function draftTtlSec(): number {
  return config.skill.draft.ttlSec
}

/**
 * 已提交提案的草稿保留期（30 天）：审核可能持续多天，草稿不能按 1 小时的编辑 TTL 过期。
 * 到期后草稿从「我的草稿」消失，但提案文件已物化，审核方仍能继续处理。
 */
const SUBMITTED_DRAFT_TTL_SEC = 30 * 24 * 3600

/** 草稿实际续期时长：已提交的提案草稿用长 TTL，其余仍是编辑期 TTL */
function ttlSecOf(record: SkillDraftRecord): number {
  return record.submission == null ? draftTtlSec() : Math.max(draftTtlSec(), SUBMITTED_DRAFT_TTL_SEC)
}

/** 草稿文件的 S3 前缀（`skill-drafts/{userId}/{draftId}/`；全仓唯一拼法） */
export function skillDraftPrefix(userId: string, draftId: string): string {
  return `skill-drafts/${userId}/${draftId}/`
}

/** 草稿文件的 S3 键 */
function skillDraftObjectKey(userId: string, draftId: string, path: string): string {
  return `${skillDraftPrefix(userId, draftId)}${path}`
}

// ═════════════════════════════════════════════════════════════════════
// 投影 / 读取
// ═════════════════════════════════════════════════════════════════════

function expiresAtOf(record: SkillDraftRecord): string {
  return new Date(Date.parse(record.updatedAt) + ttlSecOf(record) * 1000).toISOString()
}

/** 提交状态投影：状态 / 审核意见以 `SkillProposal` 行为准 */
function submissionFromRow(
  record: SkillDraftRecord,
  row: { id: string; status: SkillDraftSubmission['status']; reviewNote: string | null; acceptedVersion: number | null } | undefined,
): SkillDraftSubmission | null {
  if (record.submission == null) return null
  return {
    proposalId: record.submission.proposalId,
    // 提案行被清理 ⇒ 视为已关闭（草稿本身仍留在列表里，不凭空消失）
    status: row?.status ?? 'CLOSED',
    reviewNote: row?.reviewNote ?? null,
    acceptedVersion: row?.acceptedVersion ?? null,
    submittedAt: record.submission.submittedAt,
  }
}

async function submissionOf(record: SkillDraftRecord): Promise<SkillDraftSubmission | null> {
  if (record.submission == null) return null
  const row = await getPrisma().skillProposal.findUnique({
    where: { id: record.submission.proposalId },
    select: { id: true, status: true, reviewNote: true, acceptedVersion: true },
  })
  return submissionFromRow(record, row ?? undefined)
}

/**
 * 已提交审核 / 已通过的提案草稿只读：审核结束前不允许编辑或重复提交。
 * 被打回（`NEEDS_REBASE`）/ 历史 `REJECTED` / `CLOSED` 后恢复可编辑。
 */
async function assertDraftEditable(record: SkillDraftRecord): Promise<void> {
  if (record.submission == null) return
  const row = await getPrisma().skillProposal.findUnique({
    where: { id: record.submission.proposalId },
    select: { status: true },
  })
  if (row?.status === 'PENDING' || row?.status === 'ACCEPTED') {
    throw AppError.conflict(appMsg('app.m340'), { code: SKILL_ERROR_CODES.DRAFT_LOCKED })
  }
}

/** 记录 → 对外契约（**唯一出口**；`files` 里没有 `draftKey`，见文件头 ①） */
async function toDraft(record: SkillDraftRecord): Promise<SkillDraft> {
  return {
    id: record.id,
    kind: record.kind,
    targetSkillId: record.targetSkillId,
    baseVersion: record.baseVersion,
    overrideConversationId: record.overrideConversationId ?? null,
    expectedRevision: record.expectedRevision ?? null,
    overrideId: record.overrideId ?? null,
    name: record.name,
    description: record.description,
    runtime: record.runtime,
    requiresBins: [...record.requiresBins],
    markdown: record.markdown,
    files: record.files.map((file) => ({ ...file })),
    warnings: [...record.warnings],
    changeSummary: record.changeSummary ?? '',
    risks: [...(record.risks ?? [])],
    redactions: record.redactions.map((item) => ({ ...item })),
    redactionCarried: record.redactionCarried === true,
    submission: await submissionOf(record),
    source:
      record.source === null
        ? null
        : {
            ...record.source,
            messageIds: [...record.source.messageIds],
            includeArtifacts: record.source.includeArtifacts === true,
            includeToolOutputs: record.source.includeToolOutputs === true,
          },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // `expiresAt` 按"最后一次续期 + TTL"算：Redis 的精确定期时刻不对外承诺，这里给的是**上界**
    expiresAt: expiresAtOf(record),
  }
}

/** 过期判定：`updatedAt + ttl < now` ⇒ 过期（Redis 那边通常已自然过期，这里兜时钟抖动） */
function isExpired(record: SkillDraftRecord): boolean {
  return Date.parse(expiresAtOf(record)) <= Date.now()
}

/** 草稿不存在统一出口（不存在 / 过期 / 不是你的 / 已落库 —— **不区分**，见文件头 ⑤） */
function draftNotFound(): AppError {
  return AppError.notFound(appMsg('app.m304'), { code: SKILL_ERROR_CODES.DRAFT_NOT_FOUND })
}

/**
 * 读一份草稿并判归属 + 续期。
 *
 * @param mode `'view'` = `GET`（续期，不改内容）；`'edit'` = `PUT` / 上传 / 落库（同样续期）
 */
async function requireDraft(draftId: string, viewer: SkillViewer): Promise<SkillDraftRecord> {
  const raw = await readSkillDraftRaw(draftId)
  if (raw === undefined) throw draftNotFound()
  let record: SkillDraftRecord
  try {
    record = JSON.parse(raw) as SkillDraftRecord
  } catch {
    throw draftNotFound()
  }
  if (record.id !== draftId || record.userId !== viewer.id || isExpired(record)) throw draftNotFound()
  return record
}

/** 写回草稿（刷新 `updatedAt` ⇒ 同时续期 TTL） */
async function persist(record: SkillDraftRecord): Promise<SkillDraftRecord> {
  record.updatedAt = new Date().toISOString()
  const ttlSec = ttlSecOf(record)
  try {
    await writeSkillDraftRaw(record.id, JSON.stringify(record), ttlSec)
  } catch (error) {
    getLogger().error({ err: error, draftId: record.id }, '写入 Skill 草稿失败')
    throw AppError.internal(appMsg('app.m012'))
  }
  // 索引与草稿同源续期：列表入口即使在提示卡关闭后也能找到这份草稿
  await addSkillDraftToUserIndex(record.userId, record.id, ttlSec)
  return record
}

// ═════════════════════════════════════════════════════════════════════
// 草稿 CRUD
// ═════════════════════════════════════════════════════════════════════

/**
 * 新建草稿（`POST /api/skill-drafts`）。
 *
 * `REVISION` 必须指向**我可见**的 Skill，且 `baseVersion` 必须是**当前版本**：
 * 与 `revisions/from-draft` 的 CAS 同一条判据前置到建草稿 —— 用户不是等到"点保存"才知道基准过期。
 */
export async function createSkillDraft(
  input: {
    kind: 'CREATE' | 'REVISION' | 'SESSION_OVERRIDE'
    targetSkillId?: string | undefined
    baseVersion?: number | undefined
    /** `SESSION_OVERRIDE`：这份覆写属于哪个会话（服务端生成，不接受客户端自选） */
    overrideConversationId?: string | undefined
    /** `SESSION_OVERRIDE`：保存时的期望 revision（`null` / 缺省 = 第一次建） */
    expectedRevision?: number | null | undefined
    /** `SESSION_OVERRIDE`（按上游重建）：要替换的覆写 id */
    overrideId?: string | null | undefined
    name: string
    description: string
    runtime: SkillRuntime
    requiresBins?: readonly string[] | undefined
    markdown?: string | undefined
    warnings?: readonly string[] | undefined
    /** 生成时模型给出的变更说明（REVISION；审核页预填） */
    changeSummary?: string | undefined
    /** 生成时命中的风险提示（REVISION；审核页与现算结果取并集） */
    risks?: readonly string[] | undefined
    /** 抽取来源（c-2；只有 `POST /api/conversations/:id/skills/extract` 会传） */
    source?: SkillDraftSource | undefined
    /**
     * 抽取带回来的**文本文件**（c-3 TRACE：`scripts/**` / `assets/**` / `references/**`）。
     *
     * 与 `/:draftId/files` 上传走**同一条**写入路径（先 S3、后 JSON；路径 / 大小 / 数量 / runtime
     * 与脚本互斥的判据全在 `writeDraftFiles`）：抽取端点不该有第二套"往草稿里塞文件"的逻辑。
     */
    files?: readonly DraftFileInput[] | undefined
  },
  viewer: SkillViewer,
): Promise<SkillDraft> {
  if (input.kind === 'CREATE') assertDraftFilesShape(input.runtime, input.files ?? [])
  if (input.kind === 'REVISION') {
    const target = await requireTargetSkill(input.targetSkillId ?? '', input.baseVersion ?? 0, viewer, 'edit')
    if (target.version !== input.baseVersion) {
      throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
    }
  }
  if (input.kind === 'SESSION_OVERRIDE') {
    if (input.overrideConversationId === undefined || input.overrideConversationId.trim() === '') {
      throw AppError.validation(appMsg('app.m305', { p0: '会话级覆写缺少所属会话' }), {
        code: SKILL_ERROR_CODES.DRAFT_INVALID,
        reasons: ['会话级覆写缺少所属会话'],
      })
    }
    // 覆写不改上游 ⇒ **不按 canEditSkill 判**，只要目标可见且基准版本没越过当前版本
    const target = await requireTargetSkill(input.targetSkillId ?? '', input.baseVersion ?? 0, viewer, 'view')
    if (target.version !== input.baseVersion) {
      throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
    }
  }
  const markdown = input.markdown ?? ''
  const scan = scanSkillSecrets(markdown)
  const now = new Date().toISOString()
  const record: SkillDraftRecord = {
    id: randomUUID(),
    userId: viewer.id,
    kind: input.kind,
    targetSkillId: input.kind === 'CREATE' ? null : (input.targetSkillId ?? null),
    baseVersion: input.kind === 'CREATE' ? null : (input.baseVersion ?? null),
    overrideConversationId: input.kind === 'SESSION_OVERRIDE' ? (input.overrideConversationId ?? null) : null,
    expectedRevision: input.kind === 'SESSION_OVERRIDE' ? (input.expectedRevision ?? null) : null,
    overrideId: input.kind === 'SESSION_OVERRIDE' ? (input.overrideId ?? null) : null,
    name: input.name.trim(),
    description: input.description.trim(),
    runtime: input.runtime,
    requiresBins: [...new Set((input.requiresBins ?? []).map((bin) => bin.trim()).filter((bin) => bin !== ''))],
    markdown,
    warnings: [...(input.warnings ?? [])],
    changeSummary: input.changeSummary?.trim() ?? '',
    risks: [...new Set((input.risks ?? []).map((risk) => risk.trim()).filter((risk) => risk !== ''))],
    files: [],
    redactions: scan.redactions,
    source:
      input.source === undefined
        ? null
        : {
            conversationId: input.source.conversationId,
            messageIds: [...input.source.messageIds],
            mode: input.source.mode,
            includeArtifacts: input.source.includeArtifacts,
            includeToolOutputs: input.source.includeToolOutputs,
          },
    createdAt: now,
    updatedAt: now,
  }
  await persist(record)
  if ((input.files?.length ?? 0) > 0) {
    await attachDraftFiles(record, input.files ?? [])
  }
  getLogger().info(
    { draftId: record.id, kind: record.kind, targetSkillId: record.targetSkillId, runtime: record.runtime, fileCount: record.files.length },
    '已创建 Skill 草稿',
  )
  return toDraft(record)
}

/**
 * 抽取 / 建草稿时顺带写入的一批文件（c-3）：`content` 是 UTF-8 文本。
 *
 * 为什么单独一个类型而不是复用 {@link UploadDraftFileInput}：那条是 multipart 上传（`fileName`
 * + 可能缺省的 `path`），这里是服务端**已经算好的**路径与正文，二者只在"最终写哪个键"上汇合。
 */
export interface DraftFileInput {
  path: string
  content: string
}

/**
 * 一批文件的**形状**预检（建草稿前：数量 / 单文件字节 / runtime 与脚本互斥）。
 *
 * 与 {@link uploadSkillDraftFile} 的判据同一条 —— 提前在这里报，是为了让"抽取结果不合规"
 * 在建草稿那一刻就失败，而不是草稿建好了、文件只写进去一半。
 */
function assertDraftFilesShape(runtime: SkillRuntime, files: readonly DraftFileInput[]): void {
  if (files.length > config.skill.draft.maxFiles) {
    throw AppError.validation(appMsg('app.m305', { p0: `文件数超过上限（${String(config.skill.draft.maxFiles)}）` }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: [`文件数超过上限（${String(config.skill.draft.maxFiles)}）`],
    })
  }
  const seen = new Set<string>()
  for (const file of files) {
    if (!isSafeSkillPath(file.path) || file.path === SKILL_ENTRY_PATH) {
      throw AppError.validation(appMsg('app.m305', { p0: `不允许的路径：${file.path}` }), {
        code: SKILL_ERROR_CODES.DRAFT_INVALID,
        reasons: [`不允许的路径：${file.path}`],
      })
    }
    if (seen.has(file.path)) {
      throw AppError.validation(appMsg('app.m305', { p0: `有两个同名文件：${file.path}` }), {
        code: SKILL_ERROR_CODES.DRAFT_INVALID,
        reasons: [`有两个同名文件：${file.path}`],
      })
    }
    seen.add(file.path)
    if (Buffer.byteLength(file.content, 'utf8') > config.skill.draft.maxFileBytes) {
      throw AppError.validation(
        appMsg('app.m305', { p0: `单个文件超过上限（${String(config.skill.draft.maxFileBytes)} 字节）：${file.path}` }),
        { code: SKILL_ERROR_CODES.DRAFT_INVALID, reasons: [`单个文件超过上限：${file.path}`] },
      )
    }
    if (runtime === 'INLINE' && isSkillScriptPath(file.path)) {
      throw AppError.validation(appMsg('app.m305', { p0: 'runtime=inline 的草稿不能带 scripts/ 文件（请改成 sandbox）' }), {
        code: SKILL_ERROR_CODES.DRAFT_INVALID,
        reasons: ['runtime=inline 的草稿不能带 scripts/ 文件'],
      })
    }
  }
}

/**
 * 把一批文本文件写进**已存在**的草稿（c-3 抽取用）：**先写 S3、后改 JSON**（口径 ②），
 * 中途失败按已写的键回收，再把草稿里的文件清单回滚成写入前的样子。
 */
async function attachDraftFiles(record: SkillDraftRecord, files: readonly DraftFileInput[]): Promise<void> {
  const previous = [...record.files]
  const bucket = config.s3.bucket
  const written: string[] = []
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
    for (const input of files) {
      const path = input.path
      const bytes = Buffer.from(input.content, 'utf8')
      const kind = kindOfDraftPath(path)
      const file: SkillDraftFile = {
        path,
        kind,
        mime: mimeOfDraftPath(path),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      const key = skillDraftObjectKey(record.userId, record.id, path)
      await s3.putObject(bucket, key, bytes, bytes.length, { 'Content-Type': file.mime })
      written.push(key)
      record.files = [...record.files, file].sort((a, b) => a.path.localeCompare(b.path))
      if (file.mime.startsWith('text/') || file.mime.includes('json') || file.mime.includes('xml')) {
        const scan = scanSkillSecrets(input.content)
        if (scan.redactions.length > 0) record.redactions = mergeRedactions(record.redactions, scan.redactions)
      }
    }
    await persist(record)
  } catch (error) {
    getLogger().error({ err: error, draftId: record.id, count: files.length }, 'Skill 草稿文件写入失败，回收')
    record.files = previous
    await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
}

/** 读草稿（`GET`；**续期** —— 审核页打开即续，与"每 60s 自动 PUT"两道保险） */
export async function getSkillDraft(draftId: string, viewer: SkillViewer): Promise<SkillDraft> {
  const record = await requireDraft(draftId, viewer)
  await persist(record)
  return toDraft(record)
}

function parseDraftRecord(raw: string): SkillDraftRecord | null {
  try {
    return JSON.parse(raw) as SkillDraftRecord
  } catch {
    return null
  }
}

/**
 * 本人未过期的草稿列表（`GET /api/skill-drafts`）。
 *
 * 入口存在的理由：提示卡是一次性的（关闭 / 重新进会话后不再出现），
 * 但草稿还在 TTL 内 —— 没有列表就只能靠记住 draftId 走深链。
 * 排序按 `updatedAt` 倒序；读不到的条目顺手从索引剔除。
 */
export async function listSkillDrafts(viewer: SkillViewer): Promise<SkillDraftListResult> {
  let ids = await readSkillDraftIdsForUser(viewer.id)
  if (ids.length === 0) {
    // 索引上线前建的草稿没有登记：兜一次全量扫描，并把找到的补登记回去
    const scanned = await scanSkillDraftIds()
    const found: string[] = []
    for (const id of scanned) {
      const raw = await readSkillDraftRaw(id)
      if (raw === undefined) continue
      const record = parseDraftRecord(raw)
      if (record === null || record.userId !== viewer.id || isExpired(record)) continue
      found.push(id)
      await addSkillDraftToUserIndex(viewer.id, id, ttlSecOf(record))
    }
    ids = found
  }

  const records: SkillDraftRecord[] = []
  for (const id of ids) {
    const raw = await readSkillDraftRaw(id)
    if (raw === undefined) {
      await removeSkillDraftFromUserIndex(viewer.id, id)
      continue
    }
    const record = parseDraftRecord(raw)
    if (record === null || record.userId !== viewer.id || isExpired(record)) {
      await removeSkillDraftFromUserIndex(viewer.id, id)
      continue
    }
    records.push(record)
  }

  // 提交状态一次批量查回（避免每份草稿一次 DB 查询）
  const proposalIds = [
    ...new Set(records.map((record) => record.submission?.proposalId).filter((id): id is string => id !== undefined)),
  ]
  const submissions =
    proposalIds.length === 0
      ? new Map<string, { id: string; status: SkillDraftSubmission['status']; reviewNote: string | null; acceptedVersion: number | null }>()
      : new Map(
          (
            await getPrisma().skillProposal.findMany({
              where: { id: { in: proposalIds } },
              select: { id: true, status: true, reviewNote: true, acceptedVersion: true },
            })
          ).map((row) => [row.id, row] as const),
        )

  const items: SkillDraftListResult['items'] = records.map((record) => ({
    id: record.id,
    kind: record.kind,
    targetSkillId: record.targetSkillId,
    baseVersion: record.baseVersion,
    name: record.name,
    description: record.description,
    runtime: record.runtime,
    fileCount: record.files.length,
    changeSummary: record.changeSummary ?? '',
    submission: submissionFromRow(
      record,
      record.submission === undefined || record.submission === null
        ? undefined
        : submissions.get(record.submission.proposalId),
    ),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: expiresAtOf(record),
  }))
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return { items, total: items.length }
}

/**
 * 自动保存（`PUT`）：只改 `name / description / runtime / requiresBins / markdown`。
 *
 * ⚠️ **不接受** `kind` / `targetSkillId` / `baseVersion`（建草稿那一刻定死）、
 * **不接受** `files` / `storageKey`（文件走上传端点）、**不接受** `patch`。
 * 改了正文 ⇒ 重跑 scan 并把 `redactions` 换成新结果（用户先前的"逐项恢复"在下一轮确认里重新做）。
 */
export async function updateSkillDraft(
  draftId: string,
  input: UpdateSkillDraftBody,
  viewer: SkillViewer,
): Promise<SkillDraft> {
  const record = await requireDraft(draftId, viewer)
  await assertDraftEditable(record)
  if (input.name !== undefined) record.name = input.name.trim()
  if (input.description !== undefined) record.description = input.description.trim()
  if (input.runtime !== undefined) record.runtime = input.runtime
  if (input.requiresBins !== undefined) {
    record.requiresBins = [...new Set(input.requiresBins.map((bin) => bin.trim()).filter((bin) => bin !== ''))]
  }
  if (input.markdown !== undefined) {
    record.markdown = input.markdown
    record.redactions = scanSkillSecrets(input.markdown).redactions
  }
  if (input.changeSummary !== undefined) record.changeSummary = input.changeSummary.trim()
  await persist(record)
  return toDraft(record)
}

/**
 * 审核阶段的「让 Agent 修改」（P1-24c-4c · `revise_skill_draft`）：用模型产出**覆盖同一份草稿**。
 *
 * 与 `updateSkillDraft` 的差别只有两点：
 *   · 它不接受客户端发来的 `markdown` 之外的元数据（名字 / runtime 不动 —— 修改意见只该改正文）；
 *   · `changeSummary / risks / warnings` 是**模型 + 风险判定的结果**，随正文一起落回草稿。
 *
 * ⚠️ 仍然走同一条"重扫 + 续期"纪律：恢复回来的凭据形状由下一次保存闸门拦（与 PUT 一致）。
 */
export async function applySkillDraftRevision(input: {
  draftId: string
  markdown: string
  /** 模型按意见新增 / 替换的文件（已脱敏；空数组 = 只改正文） */
  files?: readonly DraftFileInput[] | undefined
  changeSummary?: string | undefined
  risks?: readonly string[] | undefined
  warnings?: readonly string[] | undefined
  viewer: SkillViewer
}): Promise<SkillDraft> {
  const record = await requireDraft(input.draftId, input.viewer)
  await assertDraftEditable(record)

  const nextFiles = input.files === undefined ? [] : [...input.files]
  if (nextFiles.length > 0) {
    // 带 `scripts/**` ⇒ 与抽取链路同一口径：运行时抬成 SANDBOX，而不是让保存时才 400
    if (record.runtime === 'INLINE' && nextFiles.some((file) => isSkillScriptPath(file.path))) {
      record.runtime = 'SANDBOX'
    }
    assertDraftFilesShape(record.runtime, nextFiles)
    const mergedCount = new Set([...record.files.map((file) => file.path), ...nextFiles.map((file) => file.path)]).size
    if (mergedCount > config.skill.draft.maxFiles) {
      throw AppError.validation(appMsg('app.m305', { p0: `文件数超过上限（${String(config.skill.draft.maxFiles)}）` }), {
        code: SKILL_ERROR_CODES.DRAFT_INVALID,
        reasons: [`文件数超过上限（${String(config.skill.draft.maxFiles)}）`],
      })
    }
  }

  record.markdown = input.markdown
  record.redactions = scanSkillSecrets(input.markdown).redactions
  if (nextFiles.length > 0) await upsertDraftFiles(record, nextFiles)
  if (input.changeSummary !== undefined && input.changeSummary.trim() !== '') {
    record.changeSummary = input.changeSummary.trim()
  }
  if (input.risks !== undefined) {
    record.risks = [...new Set([...(record.risks ?? []), ...input.risks])]
  }
  if (input.warnings !== undefined) {
    record.warnings = [...new Set([...record.warnings, ...input.warnings])]
  }
  await persist(record)
  getLogger().info(
    { draftId: record.id, riskCount: record.risks.length, fileCount: nextFiles.length },
    'Skill 草稿已按用户意见修订',
  )
  return toDraft(record)
}

/**
 * 把模型给出的文件**新增或替换**进现有草稿（审核阶段「让 Agent 修改」用）。
 *
 * 与 {@link attachDraftFiles} 的差别只有一处：同路径是**覆盖**而不是报错（用户明确让 Agent
 * 改这个文件）；S3 键不变，旧对象就地覆盖 —— 替换失败时旧内容已无法恢复，与审核页手动
 * 「替换文件」同一条风险口径。新增文件的键在失败时回收。
 */
async function upsertDraftFiles(record: SkillDraftRecord, files: readonly DraftFileInput[]): Promise<void> {
  const previous = [...record.files]
  const written: { key: string; created: boolean }[] = []
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(config.s3.bucket))) await s3.makeBucket(config.s3.bucket)
    for (const input of files) {
      const bytes = Buffer.from(input.content, 'utf8')
      const kind = kindOfDraftPath(input.path)
      const file: SkillDraftFile = {
        path: input.path,
        kind,
        mime: mimeOfDraftPath(input.path),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      const key = skillDraftObjectKey(record.userId, record.id, input.path)
      const existed = record.files.some((item) => item.path === input.path)
      await s3.putObject(config.s3.bucket, key, bytes, bytes.length, { 'Content-Type': file.mime })
      written.push({ key, created: !existed })
      record.files = existed
        ? record.files.map((item) => (item.path === input.path ? file : item))
        : [...record.files, file].sort((a, b) => a.path.localeCompare(b.path))
      if (file.mime.startsWith('text/') || file.mime.includes('json') || file.mime.includes('xml')) {
        const scan = scanSkillSecrets(input.content)
        if (scan.redactions.length > 0) record.redactions = mergeRedactions(record.redactions, scan.redactions)
      }
    }
  } catch (error) {
    record.files = previous
    await removeKeysQuietly(written.filter((item) => item.created).map((item) => item.key))
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
}

/** 丢弃草稿（`DELETE`）：删 Redis 键 + 回收 S3 临时对象（尽力而为） */
export async function deleteSkillDraft(draftId: string, viewer: SkillViewer): Promise<{ id: string }> {
  const record = await requireDraft(draftId, viewer)
  await assertDraftEditable(record)
  await deleteSkillDraftRaw(record.id)
  await removeSkillDraftFromUserIndex(record.userId, record.id)
  await removeDraftObjectsQuietly(record)
  getLogger().info({ draftId: record.id }, '已丢弃 Skill 草稿')
  return { id: record.id }
}

// ═════════════════════════════════════════════════════════════════════
// 草稿文件（上传 / 预览 / 移除）
// ═════════════════════════════════════════════════════════════════════

/** 上传入参（路由层把 multipart 拆成这几项；**`path` 缺省 = 客户端文件名**） */
export interface UploadDraftFileInput {
  fileName: string
  bytes: Buffer
  /** 可选显式路径（表单里的 `path` 字段）；缺省用 `fileName` */
  path?: string | undefined
  /**
   * `true` = 覆盖同路径的已上传文件（审核弹层「替换文件」）。
   *
   * 缺省仍是"同名即 400"：新增文件时撞名通常意味着用户选错了文件，
   * 静默覆盖会让另一个文件消失。只有显式替换才允许覆盖。
   */
  replace?: boolean | undefined
}

/** 由路径猜分类：`scripts/**` ⇒ `script`；`assets/**` ⇒ `asset`；其余 ⇒ `reference` */
function kindOfDraftPath(path: string): SkillDraftFileKind {
  if (isSkillScriptPath(path)) return 'script'
  if (path === 'assets' || path.startsWith('assets/')) return 'asset'
  return 'reference'
}

/** 极简 mime 表（与 `skillZip.ts` 同口径的**最小子集**；未知一律 `application/octet-stream`） */
function mimeOfDraftPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
  const table: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    csv: 'text/csv',
    py: 'text/x-python',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    js: 'text/javascript',
    ts: 'text/typescript',
    sql: 'application/sql',
    html: 'text/html',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  return table[ext] ?? 'application/octet-stream'
}

/**
 * 上传一个文件（`POST /api/skill-drafts/:draftId/files`，multipart 字段 `file`）。
 *
 * · `SKILL.md` 只能走 `PUT`（正文在 `markdown` 字段里）；上传同名默认 400，显式 `replace=true` 才覆盖；
 * · 路径归一化（去 `./`、合并斜杠）后再过 `isSafeSkillPath`（拒绝 `..` / 绝对路径 / 盘符 / 反斜杠）；
 * · **先写 S3、后改草稿 JSON**（文件头 ②）；JSON 写失败 ⇒ 回收刚写的对象；
 * · 文本文件顺带跑一次 scan：命中凭据形状 ⇒ 仍允许上传（用户要先看到它才能删），
 *   `redactions` 里记上，落库时会被拦（口径 ⑥）。
 */
export async function uploadSkillDraftFile(
  draftId: string,
  input: UploadDraftFileInput,
  viewer: SkillViewer,
): Promise<{ draft: SkillDraft; file: SkillDraftFile }> {
  const record = await requireDraft(draftId, viewer)
  await assertDraftEditable(record)
  const path = (input.path ?? input.fileName).replace(/^\.\//u, '').replace(/\/{2,}/gu, '/')
  if (path === SKILL_ENTRY_PATH) {
    throw AppError.validation(appMsg('app.m305', { p0: `${SKILL_ENTRY_PATH} 的正文请用自动保存提交（PUT），不要作为文件上传` }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: [`${SKILL_ENTRY_PATH} 不能作为文件上传`],
    })
  }
  if (!isSafeSkillPath(path)) {
    throw AppError.validation(appMsg('app.m305', { p0: `不允许的路径：${path}` }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: [`不允许的路径：${path}`],
    })
  }
  const existing = record.files.find((file) => file.path === path) ?? null
  if (existing !== null && input.replace !== true) {
    throw AppError.validation(appMsg('app.m305', { p0: `已有同名文件：${path}` }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: [`已有同名文件：${path}`],
    })
  }
  if (existing === null && record.files.length + 1 > config.skill.draft.maxFiles) {
    throw AppError.validation(appMsg('app.m305', { p0: `文件数超过上限（${String(config.skill.draft.maxFiles)}）` }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: [`文件数超过上限（${String(config.skill.draft.maxFiles)}）`],
    })
  }
  if (input.bytes.length > config.skill.draft.maxFileBytes) {
    throw AppError.validation(
      appMsg('app.m305', { p0: `单个文件超过上限（${String(config.skill.draft.maxFileBytes)} 字节）：${path}` }),
      { code: SKILL_ERROR_CODES.DRAFT_INVALID, reasons: [`单个文件超过上限：${path}`] },
    )
  }

  const kind = kindOfDraftPath(path)
  if (record.runtime === 'INLINE' && kind === 'script') {
    throw AppError.validation(appMsg('app.m305', { p0: 'runtime=inline 的草稿不能带 scripts/ 文件（请改成 sandbox）' }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: ['runtime=inline 的草稿不能带 scripts/ 文件'],
    })
  }

  const bucket = config.s3.bucket
  const key = skillDraftObjectKey(record.userId, record.id, path)
  const file: SkillDraftFile = {
    path,
    kind,
    mime: mimeOfDraftPath(path),
    size: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
  }
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
    await s3.putObject(bucket, key, input.bytes, input.bytes.length, { 'Content-Type': file.mime })
  } catch (error) {
    getLogger().error({ err: error, draftId, path }, 'Skill 草稿文件写入失败')
    throw AppError.internal(appMsg('app.m012'))
  }

  record.files =
    existing === null
      ? [...record.files, file].sort((a, b) => a.path.localeCompare(b.path))
      : record.files.map((item) => (item.path === path ? file : item))
  // 文本文件顺带扫描（二进制不扫：正则对二进制是噪音）
  if (file.mime.startsWith('text/') || file.mime.includes('json') || file.mime.includes('xml')) {
    const scan = scanSkillSecrets(input.bytes.toString('utf8'))
    if (scan.redactions.length > 0) {
      record.redactions = mergeRedactions(record.redactions, scan.redactions)
    }
  }
  try {
    await persist(record)
  } catch (error) {
    // 替换时 S3 键没变（旧对象已被覆盖），删除只会让草稿彻底没有这个文件 ⇒ 只回收新增文件。
    if (existing === null) await removeDraftObjectsQuietly({ ...record, files: [file] })
    throw error
  }
  getLogger().info({ draftId, path, size: file.size, kind }, '已上传 Skill 草稿文件')
  return { draft: await toDraft(record), file }
}

/** 同类脱敏项合并（保留各自 label，只累加 count） */
function mergeRedactions(current: readonly SkillRedaction[], next: readonly SkillRedaction[]): SkillRedaction[] {
  const out = current.map((item) => ({ ...item }))
  for (const item of next) {
    const existing = out.find((candidate) => candidate.kind === item.kind && candidate.label === item.label)
    if (existing === undefined) out.push({ ...item })
    else existing.count += item.count
  }
  return out
}

/**
 * 单文件预览（`GET /api/skill-drafts/:draftId/files?path=`）：文本一页 / 二进制元信息。
 *
 * 与 a-2 的单文件预览同形（`{ path, mime, size, sha256, kind, text }`），只是**不套 `skillPageSchema`**：
 * 草稿文件是用户刚上传的，前端要的是"看到全文好改"，不是分页给模型读。
 */
export async function previewSkillDraftFile(
  draftId: string,
  path: string,
  viewer: SkillViewer,
): Promise<{
  path: string
  mime: string
  size: number
  sha256: string
  kind: 'TEXT' | 'BINARY'
  text: string | null
}> {
  const record = await requireDraft(draftId, viewer)
  if (!isSafeSkillPath(path)) throw AppError.validation(appMsg('validation.skill.pathUnsafe'))
  const file = record.files.find((candidate) => candidate.path === path)
  if (file === undefined) {
    throw AppError.notFound(appMsg('app.m296', { p0: path, p1: 0 }), { code: SKILL_ERROR_CODES.DRAFT_NOT_FOUND })
  }
  const bytes = await readDraftObject(record, path)
  const textual = file.mime.startsWith('text/') || file.mime.includes('json') || file.mime.includes('xml')
  return {
    path: file.path,
    mime: file.mime,
    size: file.size,
    sha256: file.sha256,
    kind: textual ? 'TEXT' : 'BINARY',
    text: textual ? bytes.toString('utf8') : null,
  }
}

/** 移除草稿文件（`DELETE /api/skill-drafts/:draftId/files?path=`） */
export async function removeSkillDraftFile(
  draftId: string,
  path: string,
  viewer: SkillViewer,
): Promise<SkillDraft> {
  const record = await requireDraft(draftId, viewer)
  await assertDraftEditable(record)
  if (!isSafeSkillPath(path)) throw AppError.validation(appMsg('validation.skill.pathUnsafe'))
  if (!record.files.some((file) => file.path === path)) {
    throw AppError.notFound(appMsg('app.m296', { p0: path, p1: 0 }), { code: SKILL_ERROR_CODES.DRAFT_NOT_FOUND })
  }
  record.files = record.files.filter((file) => file.path !== path)
  await removeDraftObjectsQuietly({ ...record, files: [{ path, kind: 'reference', mime: '', size: 0, sha256: '' }] })
  await persist(record)
  return toDraft(record)
}

/** 读草稿对象（**不做 fallback 键**：草稿前缀里的键就是唯一一份） */
async function readDraftObject(record: SkillDraftRecord, path: string): Promise<Buffer> {
  const key = skillDraftObjectKey(record.userId, record.id, path)
  try {
    const stream = await getS3Client().getObject(config.s3.bucket, key)
    const chunks: Buffer[] = []
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (isS3NoSuchKey(error)) {
      getLogger().warn({ draftId: record.id, path }, 'Skill 草稿文件对象丢失')
      throw AppError.notFound(appMsg('app.m304'), { code: SKILL_ERROR_CODES.DRAFT_NOT_FOUND })
    }
    getLogger().error({ err: error, draftId: record.id, path }, '读取 Skill 草稿文件失败')
    throw AppError.internal(appMsg('app.m012'))
  }
}

/** 尽力删除草稿对象（失败只告警：孤儿对象由清理器回收） */
async function removeDraftObjectsQuietly(record: SkillDraftRecord): Promise<void> {
  if (record.files.length === 0) return
  const bucket = config.s3.bucket
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) return
    await s3.removeObjects(
      bucket,
      record.files.map((file) => skillDraftObjectKey(record.userId, record.id, file.path)),
    )
  } catch (error) {
    getLogger().warn({ err: error, draftId: record.id, count: record.files.length }, 'Skill 草稿对象回收失败（残留需清理）')
  }
}

// ═════════════════════════════════════════════════════════════════════
// 落库（CREATE → v1 / REVISION → vN+1）
// ═════════════════════════════════════════════════════════════════════

/** 取目标 Skill（REVISION）：**编辑权 + 基准版本**两条一起判（见 {@link createSkillDraft} 注释） */
async function requireTargetSkill(
  skillId: string,
  baseVersion: number,
  viewer: SkillViewer,
  mode: 'view' | 'edit',
): Promise<SkillRow> {
  const row = await getPrisma().skill.findFirst({ where: { id: skillId, deletedAt: null }, select: SKILL_SELECT })
  // 不存在 / 不可见 / 不可编 ⇒ 同一个 404（不泄漏存在性）
  if (row === null) throw AppError.notFound(appMsg('app.m288', { p0: skillId }))
  if (mode === 'edit' && !canEditSkill(row, viewer)) throw AppError.notFound(appMsg('app.m288', { p0: skillId }))
  if (baseVersion > row.version) {
    throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
  }
  return row
}

/**
 * 草稿的**会话出处**（c-2 CREATE / c-4 REVISION 共用）：带 `source` 的草稿会走这里。
 *
 * 校验的是"这份草稿声称的来源**确实是你的**" —— 草稿本身已经按 `userId` 判过归属，
 * 但来源会话可能已经被删（那时**不阻断保存**：来源只是展示与审计，Skill 本身仍然有效）。
 *
 * @returns `null` = 不是从会话来的（手建草稿）；否则给出落库用的快照
 */
async function resolveDraftSource(
  record: SkillDraftRecord,
  viewer: SkillViewer,
): Promise<SkillDraftSource | null> {
  const source = record.source
  if (source === null) return null
  const conversation = await getPrisma().conversation.findFirst({
    where: { id: source.conversationId, userId: viewer.id },
    select: { id: true },
  })
  if (conversation === null) {
    getLogger().warn({ draftId: record.id, conversationId: source.conversationId }, '草稿的来源会话已不可见，仍按快照落库来源')
  }
  return source
}

/** 基准版本里的一个文件（REVISION / SESSION_OVERRIDE 落库时用于补齐"这次没改的文件"） */
export interface BaseSkillFileRow {
  path: string
  mime: string
  size: number
  sha256: string
  storageKey: string
}

/**
 * 草稿文件（增量：新增或替换）与基准文件合并成**整版文件集**。
 *
 * 为什么必须有这一步：`record.files` 只装"这次新增 / 覆盖的文件"，
 * 直接把它当整版会把基准版本里的其他文件全部丢掉（2026-11-17：一份只改正文的修订会把
 * `vision.js` 删掉）。草稿里同路径的文件覆盖基准，其余基准文件原样保留。
 */
function mergeFileEntries(
  draftFiles: readonly SkillDraftFile[],
  baseFiles: readonly BaseSkillFileRow[],
): { path: string; kind: SkillDraftFileKind; mime: string; size: number; sha256: string }[] {
  const byPath = new Map<string, { path: string; kind: SkillDraftFileKind; mime: string; size: number; sha256: string }>()
  for (const base of baseFiles) {
    if (base.path === SKILL_ENTRY_PATH) continue
    byPath.set(base.path, {
      path: base.path,
      kind: kindOfDraftPath(base.path),
      mime: base.mime,
      size: base.size,
      sha256: base.sha256,
    })
  }
  for (const file of draftFiles) {
    if (file.path === SKILL_ENTRY_PATH) continue
    byPath.set(file.path, { ...file })
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** 草稿 → 本版要写的文件（`SKILL.md` 由 DB 字段重生成 frontmatter；基准未改文件原样拷贝） */
async function materializeDraftFiles(
  record: SkillDraftRecord,
  meta: { name: string; description: string; runtime: SkillRuntime; requiresBins: readonly string[]; requiresScripts: boolean; extra: Record<string, unknown> },
  baseFiles: readonly BaseSkillFileRow[] = [],
): Promise<{ path: string; bytes: Buffer; mime: string; sha256: string }[]> {
  const files: { path: string; bytes: Buffer; mime: string; sha256: string }[] = []
  const markdown = composeSkillMarkdown({
    name: meta.name,
    description: meta.description,
    runtime: meta.runtime,
    requiresScripts: meta.requiresScripts,
    requiresBins: meta.requiresBins,
    body: stripFrontmatter(record.markdown),
    extra: meta.extra,
  })
  const entryBytes = Buffer.from(markdown, 'utf8')
  files.push({
    path: SKILL_ENTRY_PATH,
    bytes: entryBytes,
    mime: 'text/markdown',
    sha256: createHash('sha256').update(entryBytes).digest('hex'),
  })
  const draftPaths = new Set(record.files.map((file) => file.path))
  for (const base of baseFiles) {
    if (base.path === SKILL_ENTRY_PATH || draftPaths.has(base.path)) continue
    const bytes = await readSkillObjectQuietly(base.storageKey)
    // 基准对象读不到 / 字节数对不上 ⇒ **拒绝保存**，绝不用空文件冒充（那等于静默删掉这个文件）
    if (base.storageKey === '' || bytes.length !== base.size) {
      getLogger().error({ draftId: record.id, path: base.path, expected: base.size, actual: bytes.length }, '基准文件读取失败')
      throw AppError.internal(appMsg('app.m012'))
    }
    files.push({ path: base.path, bytes, mime: base.mime, sha256: base.sha256 })
  }
  for (const file of record.files) {
    const bytes = await readDraftObject(record, file.path)
    files.push({ path: file.path, bytes, mime: file.mime, sha256: file.sha256 })
  }
  return files
}

/**
 * 规范化返回的"名称 / description 缺失"两类原因在落库时**不再算错**：
 * 它们已由 schema（必填、长度）与 `assertSkillMetadata` 在同一请求里判过。
 * 这里只留**内容形状**类的拒绝理由（路径不安全、runtime 与 scripts 互斥、重名文件）。
 */
function publishReasonsOf(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => !reason.startsWith('名称为空') && !reason.startsWith('description'))
}

/** 落库前的统一校验（内容 + 脱敏），失败抛 400（带 `data.reasons` / `data.redactions`） */
function assertDraftPublishable(record: SkillDraftRecord, reasons: string[]): void {
  if (reasons.length > 0) {
    throw AppError.validation(appMsg('app.m305', { p0: reasons.join('；') }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons,
    })
  }
  // 口径 ⑥：**落库前重跑一次** scan（正文 + 每个文本文件），命中凭据形状一律拒
  const hits: SkillRedaction[] = [...scanSkillSecrets(record.markdown).redactions]
  const labels = hits.filter((item) => item.kind === 'credential').map((item) => item.label)
  if (labels.length > 0) {
    throw AppError.validation(appMsg('app.m306', { p0: [...new Set(labels)].join('、') }), {
      code: SKILL_ERROR_CODES.DRAFT_SECRET_FOUND,
      redactions: hits.filter((item) => item.kind === 'credential'),
    })
  }
}

/** 写对象到任意前缀（`skills/{id}/v{n}/` / `skill-proposals/{id}/`）；失败回收已写的 */
export async function writeObjectsAtPrefix(
  prefix: string,
  files: readonly { path: string; bytes: Buffer; mime: string }[],
): Promise<string[]> {
  const bucket = config.s3.bucket
  const written: string[] = []
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
    for (const file of files) {
      const key = `${prefix}${file.path}`
      await s3.putObject(bucket, key, file.bytes, file.bytes.length, { 'Content-Type': file.mime })
      written.push(key)
    }
    return written
  } catch (error) {
    getLogger().error({ err: error, prefix, written: written.length }, 'Skill 对象写入失败，已中止')
    await removeKeysQuietly(written)
    throw AppError.internal(appMsg('app.m012'))
  }
}

/** 写对象到 `skills/{id}/v{n}/`；任一条失败 ⇒ 回收已写的并抛 500 */
export async function writeVersionObjects(
  skillId: string,
  version: number,
  files: readonly { path: string; bytes: Buffer; mime: string }[],
): Promise<string[]> {
  return writeObjectsAtPrefix(skillStoragePrefix(skillId, version), files)
}

/** 删除一批键（失败只告警） */
export async function removeKeysQuietly(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(config.s3.bucket))) return
    await s3.removeObjects(config.s3.bucket, [...keys])
  } catch (error) {
    getLogger().warn({ err: error, count: keys.length }, 'Skill 对象回收失败（残留对象需人工清理）')
  }
}

/** 落库成功后消耗草稿（DEL + 回收临时对象；失败只告警 —— 草稿有 TTL，最坏是残留） */
async function consumeDraft(record: SkillDraftRecord): Promise<void> {
  await deleteSkillDraftRaw(record.id)
  await removeSkillDraftFromUserIndex(record.userId, record.id)
  await removeDraftObjectsQuietly(record)
}

/**
 * 草稿 → 正式 Skill（`POST /api/skills/from-draft`，**只收 `draftId` + 展示元数据**）。
 *
 * 顺序：读草稿（归属 / 类型 / 过期）→ 校验内容与脱敏 → 判重 → **写 S3** → 事务切 DB → 消耗草稿
 * → （可选）顺带绑定当前 Agent。
 *
 * @throws {AppError} 404 草稿不存在 / 400 类型不符 / 400 内容不合规 / 400 有凭据 / 409 重名
 */
export async function saveSkillFromDraft(
  input: SaveSkillFromDraftBody,
  viewer: SkillViewer,
): Promise<SaveSkillFromDraftResult> {
  const record = await requireDraft(input.draftId, viewer)
  if (record.kind !== 'CREATE') {
    throw AppError.validation(appMsg('app.m307', { p0: record.kind }), { code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH })
  }
  const visibility = normalizeSkillVisibility(input.visibility)

  // 展示元数据：请求显式给的值**优先**（审核页可改名 / 改描述 / 改运行时），缺省用草稿里的
  const name = (input.name?.trim() ?? record.name).trim()
  const description = (input.description?.trim() ?? record.description).trim()
  const runtime = input.runtime ?? (record.runtime === 'SANDBOX' ? 'SANDBOX' : 'INLINE')
  // 同 REVISION：请求里带的"脱敏确认后正文"优先于 Redis 里的旧副本（自动保存可能还没写回）
  const effective: SkillDraftRecord =
    input.markdown === undefined ? record : { ...record, markdown: input.markdown }
  const content = normalizeSkillDraftContent({
    markdown: effective.markdown,
    name,
    description,
    runtime,
    requiresBins: record.requiresBins,
    files: record.files,
  })
  // 落库用**这次提交的正文**判定脱敏（「恢复」= 把 `«已脱敏»` 换回原文；换回来的凭据形状必须被拦）
  assertDraftPublishable(effective, publishReasonsOf(content.reasons))

  // slug / 名称判重（与导入同一条判据）
  const shortid = randomUUID().replace(/-/gu, '').slice(0, 8)
  const slug = await uniqueSkillSlug(
    input.slug !== undefined && input.slug.trim() !== '' ? input.slug.trim() : skillSlugOf(content.content.name, shortid),
  )
  assertNoSkillConflict(
    await findSkillConflict({ createdBy: viewer.id, name: content.content.name, slug }),
    content.content.name,
  )

  const skillId = randomUUID()
  const version = 1
  const source = await resolveDraftSource(record, viewer)
  const files = await materializeDraftFiles(effective, {
    name: content.content.name,
    description: content.content.description,
    runtime,
    requiresBins: content.content.requiresBins,
    requiresScripts: content.content.requiresScripts,
    extra: content.content.extra,
  })
  const written = await writeVersionObjects(skillId, version, files)
  const db = getPrisma()
  let saved: SkillRow
  try {
    saved = await db.$transaction(async (tx) => {
      await tx.skill.create({
        data: {
          id: skillId,
          name: content.content.name,
          slug,
          description: content.content.description,
          runtime,
          requiresBins: content.content.requiresBins,
          version,
          manifest: content.content.extra as Prisma.InputJsonValue,
          // 来自会话抽取（c-2）⇒ CONVERSATION + 来源快照；手建 / 上传 ⇒ MANUAL（c-1 行为不变）
          sourceType: source === null ? 'MANUAL' : 'CONVERSATION',
          sourceConversationId: source?.conversationId ?? null,
          sourceMessageIds: source === null ? Prisma.DbNull : (source.messageIds as Prisma.InputJsonValue),
          storageKey: skillStoragePrefix(skillId, version),
          createdBy: viewer.id,
          visibility,
        },
      })
      await tx.skillFile.createMany({
        data: files.map((file) => ({
          skillId,
          version,
          path: file.path,
          size: file.bytes.length,
          mime: file.mime,
          sha256: file.sha256,
          storageKey: `${skillStoragePrefix(skillId, version)}${file.path}`,
        })),
      })
      await tx.skillChange.create({
        data: {
          skillId,
          fromVersion: 0,
          toVersion: version,
          changeSummary:
            source === null
              ? `由草稿创建 v${String(version)}（${String(files.length)} 个文件）`
              : `由会话生成 v${String(version)}（${String(source.messageIds.length)} 条消息，${source.mode}${source.includeArtifacts ? '，含产物' : ''}${source.includeToolOutputs ? '，含工具输出' : ''}）`,
          source: 'MANUAL',
          sourceConversationId: source?.conversationId ?? null,
          sourceMessageIds: source === null ? Prisma.DbNull : (source.messageIds as Prisma.InputJsonValue),
          createdBy: viewer.id,
        },
      })
      return tx.skill.findUniqueOrThrow({ where: { id: skillId }, select: SKILL_SELECT })
    })
  } catch (error) {
    getLogger().error({ err: error, skillId, draftId: record.id }, 'Skill 落库失败，回收刚写入的对象')
    await removeKeysQuietly(written)
    if (error instanceof AppError) throw error
    // 唯一索引兜底（并发建同名）⇒ 409 而不是 500
    if (isUniqueViolation(error)) {
      throw AppError.conflict(appMsg('app.m291', { p0: content.content.name }), { code: SKILL_ERROR_CODES.NAME_TAKEN })
    }
    throw AppError.internal(appMsg('app.m012'))
  }

  await consumeDraft(record)
  getLogger().info(
    { skillId, draftId: record.id, version, fileCount: files.length, runtime },
    '已从草稿创建 Skill',
  )

  // 口径 ⑦：**先落 Skill、再尝试绑定**；绑定失败只回 bindError
  let bindError: string | null = null
  if (input.bindToAgentId !== undefined) {
    bindError = await tryBindSkill(input.bindToAgentId, skillId, runtime, viewer)
  }
  return {
    skill: projectSkillItem(saved, viewer, undefined, await parentInfoOf(saved, viewer)),
    version,
    fileCount: files.length,
    bindError,
    pinError: null,
  }
}

/** Postgres 唯一约束冲突（`P2002`）；跨构建产物用结构判断而非 `instanceof` */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/**
 * 草稿 → **新版本**（`POST /api/skills/:id/revisions/from-draft`）。
 *
 * · `fromVersion` 必须等于当前版本（否则 409 `SKILL_VERSION_CONFLICT`，**不自动合并**）；
 * · 草稿必须属于当前用户、`kind = REVISION`、且 `targetSkillId` 就是这个 Skill；
 * · `changeSummary` 由客户端给（为什么改）；`diff` 由服务端用基准正文与草稿正文计算（**不收客户端 patch**）。
 */
export async function saveSkillRevisionFromDraft(
  skillId: string,
  input: SaveSkillRevisionFromDraftBody,
  viewer: SkillViewer,
): Promise<SaveSkillFromDraftResult> {
  const record = await requireDraft(input.draftId, viewer)
  if (record.kind !== 'REVISION') {
    throw AppError.validation(appMsg('app.m307', { p0: record.kind }), { code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH })
  }
  if (record.targetSkillId !== skillId) {
    throw AppError.validation(appMsg('app.m307', { p0: '目标 Skill 与草稿不一致' }), {
      code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH,
    })
  }
  const target = await requireTargetSkill(skillId, input.fromVersion, viewer, 'edit')
  if (target.version !== input.fromVersion) {
    throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
  }

  /**
   * 落库用的正文 = 请求里带的**脱敏确认后正文**（审核页最后一下编辑还没来得及被 800ms 自动保存
   * 写回 Redis 时，以提交的这份为准）。文件清单仍只从服务端草稿读 —— 保存入口没有"客户端传文件"的口子。
   */
  const effective: SkillDraftRecord =
    input.markdown === undefined ? record : { ...record, markdown: input.markdown }
  // 基准正文：当前版本 `SKILL.md` 的**正文**（frontmatter 不算改动的语义载体）
  const db = getPrisma()
  const baseRow = await db.skillFile.findFirst({
    where: { skillId, version: target.version, path: SKILL_ENTRY_PATH },
    select: { storageKey: true },
  })
  const baseMarkdown =
    baseRow === null
      ? ''
      : stripFrontmatter((await readSkillObjectQuietly(baseRow.storageKey)).toString('utf8'))
  const baseFiles = await db.skillFile.findMany({
    where: { skillId, version: target.version, path: { not: SKILL_ENTRY_PATH } },
    select: { path: true, size: true, sha256: true, mime: true, storageKey: true },
  })
  // 校验与落库都用**整版文件集**（基准未改文件 + 草稿增量）；只拿 `effective.files` 会把既有文件丢掉
  const mergedFiles = mergeFileEntries(effective.files, baseFiles)
  const content = normalizeSkillDraftContent({
    markdown: effective.markdown,
    name: effective.name,
    description: effective.description,
    runtime: effective.runtime === 'SANDBOX' ? 'SANDBOX' : 'INLINE',
    requiresBins: effective.requiresBins,
    files: mergedFiles,
  })
  assertDraftPublishable(effective, publishReasonsOf(content.reasons))
  if (content.content.name !== target.name) {
    assertNoSkillConflict(
      await findSkillConflict({ createdBy: target.createdBy, name: content.content.name, slug: target.slug, excludeId: target.id }),
      content.content.name,
    )
  }

  const afterFiles = [
    { path: SKILL_ENTRY_PATH, size: Buffer.byteLength(content.content.body, 'utf8'), sha256: '' },
    ...mergedFiles,
  ]
  const diff = computeSkillDiff({
    beforeMarkdown: baseMarkdown,
    afterMarkdown: content.content.body,
    beforeFiles: [
      { path: SKILL_ENTRY_PATH, size: Buffer.byteLength(baseMarkdown, 'utf8'), sha256: '' },
      ...baseFiles.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    ],
    afterFiles,
  })

  const nextVersion = target.version + 1
  const source = await resolveDraftSource(record, viewer)
  const files = await materializeDraftFiles(
    effective,
    {
      name: content.content.name,
      description: content.content.description,
      runtime: content.content.runtime,
      requiresBins: content.content.requiresBins,
      requiresScripts: content.content.requiresScripts,
      extra: content.content.extra,
    },
    baseFiles,
  )
  const written = await writeVersionObjects(skillId, nextVersion, files)
  let saved: SkillRow
  try {
    saved = await db.$transaction(async (tx) => {
      const updated = await tx.skill.updateMany({
        where: { id: skillId, version: target.version, deletedAt: null },
        data: {
          name: content.content.name,
          description: content.content.description,
          runtime: content.content.runtime,
          requiresBins: content.content.requiresBins,
          version: nextVersion,
          storageKey: skillStoragePrefix(skillId, nextVersion),
        },
      })
      if (updated.count === 0) {
        throw AppError.conflict(appMsg('app.m295'), { code: SKILL_ERROR_CODES.VERSION_CONFLICT })
      }
      await tx.skillFile.createMany({
        data: files.map((file) => ({
          skillId,
          version: nextVersion,
          path: file.path,
          size: file.bytes.length,
          mime: file.mime,
          sha256: file.sha256,
          storageKey: `${skillStoragePrefix(skillId, nextVersion)}${file.path}`,
        })),
      })
      await tx.skillChange.create({
        data: {
          skillId,
          fromVersion: target.version,
          toVersion: nextVersion,
          changeSummary: input.changeSummary.trim(),
          diff: diff as unknown as object,
          // c-4：从会话纠正保存 ⇒ 记成 CONVERSATION_CORRECTION（并留来源会话 / 消息范围审计）；
          // 手建 REVISION（没有 source）仍是 MANUAL
          source: source === null ? 'MANUAL' : 'CONVERSATION_CORRECTION',
          sourceConversationId: source?.conversationId ?? null,
          sourceMessageIds: source === null ? Prisma.DbNull : (source.messageIds as Prisma.InputJsonValue),
          createdBy: viewer.id,
        },
      })
      return tx.skill.findUniqueOrThrow({ where: { id: skillId }, select: SKILL_SELECT })
    })
  } catch (error) {
    getLogger().error({ err: error, skillId, draftId: record.id, nextVersion }, 'Skill 新版本落库失败，回收刚写入的对象')
    await removeKeysQuietly(written)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }

  await consumeDraft(record)
  getLogger().info({ skillId, draftId: record.id, version: nextVersion, fileCount: files.length }, '已从草稿发布 Skill 新版本')

  // 保存选项 ②（c-4）：**先落版本、再尝试固定**；固定失败只回 pinError（与 bindError 同一条纪律）
  let pinError: string | null = null
  if (input.pinAgentId !== undefined) {
    pinError = await tryPinSkillVersion(input.pinAgentId, skillId, nextVersion, viewer)
  }
  return {
    skill: projectSkillItem(saved, viewer, undefined, await parentInfoOf(saved, viewer)),
    version: nextVersion,
    fileCount: files.length,
    bindError: null,
    pinError,
  }
}

/**
 * 把某个 Agent 对某个 Skill 的绑定**固定到指定版本**（P1-24c-4 保存选项 ②）。**恒不抛**。
 *
 * 与 {@link tryBindSkill} 的区别：这里**不新建绑定**（没绑就什么都不做并说明），只改已有那行的
 * `config.skillVersion`；必须**合并写**（保留 `pinnedMcpTools` 等其它键，§v3 口径 ⑨）。
 * 版本号越界（> `skills.version`）不可能发生：调用方刚把这个版本写进库里。
 */
// ═════════════════════════════════════════════════════════════════════
// 会话级覆写（P1-24c-4b）：草稿 → 覆写文件的唯一物化路径
// ═════════════════════════════════════════════════════════════════════

/**
 * 一份 `SESSION_OVERRIDE` 草稿物化成"要写到覆写前缀的整版文件"。
 *
 * 与 `saveSkillFromDraft` / `saveSkillRevisionFromDraft` 走**同一套**内容校验、脱敏闸门与
 * `SKILL.md` frontmatter 重生成；差别只有存储前缀（`skill-overrides/...`，由覆写服务决定）
 * 与"不写 `skills` / `skill_files` / `SkillChange`"。
 */
export interface MaterializedOverrideDraft {
  draftId: string
  targetSkillId: string
  baseVersion: number
  overrideConversationId: string
  expectedRevision: number | null
  changeSummary: string
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: string[]
  files: { path: string; bytes: Buffer; mime: string; sha256: string }[]
}

/** 读 + 校验一份覆写草稿，并把它物化成整版文件（**不写 S3、不改 DB**） */
export async function materializeSkillOverrideDraft(
  draftId: string,
  viewer: SkillViewer,
): Promise<MaterializedOverrideDraft> {
  const record = await requireDraft(draftId, viewer)
  if (record.kind !== 'SESSION_OVERRIDE') {
    throw AppError.validation(appMsg('app.m307', { p0: record.kind }), { code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH })
  }
  if (record.targetSkillId === null || record.baseVersion === null || record.overrideConversationId === null) {
    throw AppError.validation(appMsg('app.m305', { p0: '会话级覆写草稿缺少目标 / 基准 / 所属会话' }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: ['会话级覆写草稿缺少目标 / 基准 / 所属会话'],
    })
  }
  const target = await requireTargetSkill(record.targetSkillId, record.baseVersion, viewer, 'view')
  if (target.runtime === 'INLINE' && record.files.some((file) => isSkillScriptPath(file.path))) {
    throw AppError.validation(appMsg('app.m305', { p0: 'inline Skill 的覆写不能带 scripts/ 文件（脚本只能在 TaskAgent 沙箱里执行）' }), {
      code: SKILL_ERROR_CODES.IMPORT_INVALID,
      reasons: ['inline Skill 的覆写不能带 scripts/ 文件'],
    })
  }
  const baseFiles = await getPrisma().skillFile.findMany({
    where: { skillId: target.id, version: record.baseVersion, path: { not: SKILL_ENTRY_PATH } },
    select: { path: true, size: true, sha256: true, mime: true, storageKey: true },
  })
  // 覆写也是"基准 + 增量"：不合并上游文件，保存一次覆写就会把没改的文件从会话里删掉
  const mergedFiles = mergeFileEntries(record.files, baseFiles)
  const content = normalizeSkillDraftContent({
    markdown: record.markdown,
    name: record.name,
    description: record.description,
    runtime: record.runtime === 'SANDBOX' ? 'SANDBOX' : 'INLINE',
    requiresBins: record.requiresBins,
    files: mergedFiles,
  })
  assertDraftPublishable(record, publishReasonsOf(content.reasons))
  const files = await materializeDraftFiles(
    record,
    {
      name: content.content.name,
      description: content.content.description,
      runtime: content.content.runtime,
      requiresBins: content.content.requiresBins,
      requiresScripts: content.content.requiresScripts,
      extra: content.content.extra,
    },
    [],
  )
  return {
    draftId: record.id,
    targetSkillId: record.targetSkillId,
    baseVersion: record.baseVersion,
    overrideConversationId: record.overrideConversationId,
    expectedRevision: record.expectedRevision ?? null,
    changeSummary: record.changeSummary.trim(),
    name: content.content.name,
    description: content.content.description,
    runtime: content.content.runtime,
    requiresBins: content.content.requiresBins,
    files,
  }
}

/** 覆写落库成功后消耗草稿（DEL + 回收临时对象；失败只告警） */
export async function consumeSkillOverrideDraft(draftId: string, viewer: SkillViewer): Promise<void> {
  const record = await requireDraft(draftId, viewer)
  await consumeDraft(record)
}

/**
 * 提案提交成功后**保留**草稿，只记下最近一次提交的提案 id（2026-11-18 起）。
 *
 * 为什么不消耗：用户要能在「我的草稿」里看到「审核中 / 已通过 / 已打回」；
 * 打回后还要能用同一份草稿修改并重新提交。提案文件已物化到 `skill-proposals/{id}/`，
 * 因此草稿过期不影响审核方继续处理。
 */
export async function markSkillProposalSubmitted(
  draftId: string,
  proposalId: string,
  viewer: SkillViewer,
  markdownOverride?: string,
): Promise<void> {
  const record = await requireDraft(draftId, viewer)
  // 审核页最后一下编辑可能还没被自动保存写回 Redis：把「真正提交的正文」留在草稿里，
  // 否则提交后再打开草稿会看到旧一版内容
  if (markdownOverride !== undefined) {
    record.markdown = markdownOverride
    record.redactions = scanSkillSecrets(markdownOverride).redactions
  }
  record.submission = { proposalId, submittedAt: new Date().toISOString() }
  try {
    await persist(record)
  } catch (error) {
    // 提案已落库：这里只影响「我的草稿」里的状态徽标，不能把一次成功提交回滚成失败
    getLogger().warn({ err: error, draftId, proposalId }, '记录 Skill 提案草稿提交状态失败')
  }
}

/** 提交 / 重新提交前的幂等闸门：同一条草稿在审核中或已通过时不允许重复提交 */
export async function assertSkillProposalDraftSubmittable(
  draftId: string,
  viewer: SkillViewer,
): Promise<void> {
  const record = await requireDraft(draftId, viewer)
  await assertDraftEditable(record)
}

/**
 * 一份 `PROPOSAL` 草稿物化成"要写到 `skill-proposals/{proposalId}/` 的整版文件"。
 *
 * 与 REVISION / SESSION_OVERRIDE 走**同一套**内容校验、脱敏闸门与 frontmatter 重生成；
 * 差别只有存储前缀与"不写 `skills` / `skill_files` / `SkillChange`"。
 */
export interface MaterializedProposalDraft {
  draftId: string
  targetSkillId: string
  baseVersion: number
  changeSummary: string
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: string[]
  markdown: string
  files: { path: string; bytes: Buffer; mime: string; sha256: string }[]
}

/** 读 + 校验一份提案草稿，并物化成整版文件（**不写 S3、不改 DB**） */
export async function materializeSkillProposalDraft(
  draftId: string,
  viewer: SkillViewer,
  markdownOverride?: string,
): Promise<MaterializedProposalDraft> {
  const record = await requireDraft(draftId, viewer)
  if (record.kind !== 'PROPOSAL') {
    throw AppError.validation(appMsg('app.m307', { p0: record.kind }), { code: SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH })
  }
  // 审核页最后一下编辑可能还没被自动保存写回 Redis：以提交的正文为准（仍要过下面的重扫）
  if (markdownOverride !== undefined) record.markdown = markdownOverride
  if (record.targetSkillId === null || record.baseVersion === null) {
    throw AppError.validation(appMsg('app.m305', { p0: '更新建议草稿缺少目标 / 基准版本' }), {
      code: SKILL_ERROR_CODES.DRAFT_INVALID,
      reasons: ['更新建议草稿缺少目标 / 基准版本'],
    })
  }
  // 提案要提给上游：目标只需**可见**（是不是所属人由提案服务判）
  await requireTargetSkill(record.targetSkillId, record.baseVersion, viewer, 'view')
  /**
   * ⚠️ 提案草稿是**整版快照**（从副本当前版本全量复制），不是 REVISION 那种"基准 + 增量"。
   * 这里**不能**再并入基准文件 —— 否则副本里删掉的文件会被上游基准悄悄补回来，
   * 提案的 `removedFiles` 永远为空。
   */
  const mergedFiles = record.files.filter((file) => file.path !== SKILL_ENTRY_PATH)
  const content = normalizeSkillDraftContent({
    markdown: record.markdown,
    name: record.name,
    description: record.description,
    runtime: record.runtime === 'SANDBOX' ? 'SANDBOX' : 'INLINE',
    requiresBins: record.requiresBins,
    files: mergedFiles,
  })
  assertDraftPublishable(record, publishReasonsOf(content.reasons))
  const files = await materializeDraftFiles(
    record,
    {
      name: content.content.name,
      description: content.content.description,
      runtime: content.content.runtime,
      requiresBins: content.content.requiresBins,
      requiresScripts: content.content.requiresScripts,
      extra: content.content.extra,
    },
    [],
  )
  return {
    draftId: record.id,
    targetSkillId: record.targetSkillId,
    baseVersion: record.baseVersion,
    changeSummary: record.changeSummary.trim(),
    name: content.content.name,
    description: content.content.description,
    runtime: content.content.runtime,
    requiresBins: content.content.requiresBins,
    markdown: content.content.body,
    files,
  }
}

/**
 * 从副本当前版本建一份 `PROPOSAL` 草稿（`POST /api/skills/:id/proposal-draft`）。
 *
 * 正文 / 文件来自**副本的当前 S3 前缀**（不是上游）：用户在审核页看到的是"我的副本 vs 上游基准"；
 * 之后可以在同一套审核组件里改正文 / 文件，再提交成提案。
 */
export async function createSkillProposalDraftFromFork(input: {
  viewer: SkillViewer
  target: { id: string; name: string; description: string }
  baseVersion: number
  /** 内容来自一份**已确认过脱敏**的草稿（本会话覆写）⇒ 审核页不再重复确认 */
  redactionCarried?: boolean
  fork: {
    name: string
    description: string
    runtime: SkillRuntime
    requiresBins: readonly string[]
    markdown: string
    changeSummary: string
    storageKey: string
    files: readonly { path: string; mime: string; size: number; sha256: string }[]
  }
}): Promise<SkillDraft> {
  const scan = scanSkillSecrets(input.fork.markdown)
  const now = new Date().toISOString()
  const record: SkillDraftRecord = {
    id: randomUUID(),
    userId: input.viewer.id,
    kind: 'PROPOSAL',
    targetSkillId: input.target.id,
    baseVersion: input.baseVersion,
    overrideConversationId: null,
    expectedRevision: null,
    overrideId: null,
    // 提案不改上游名称：名称沿用目标 Skill，其它元数据沿用副本（用户可在审核页改）
    name: input.target.name.trim(),
    description: (input.fork.description || input.target.description).trim(),
    runtime: input.fork.runtime,
    requiresBins: [...new Set(input.fork.requiresBins.map((bin) => bin.trim()).filter((bin) => bin !== ''))],
    markdown: input.fork.markdown,
    warnings: [],
    changeSummary: input.fork.changeSummary.trim(),
    risks: [],
    files: [],
    redactions: scan.redactions,
    redactionCarried: input.redactionCarried === true,
    source: null,
    createdAt: now,
    updatedAt: now,
  }
  await persist(record)
  const bucket = config.s3.bucket
  const written: string[] = []
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
    for (const file of input.fork.files) {
      if (file.path === SKILL_ENTRY_PATH) continue
      if (!isSafeSkillPath(file.path)) {
        throw AppError.validation(appMsg('app.m305', { p0: `不允许的路径：${file.path}` }), {
          code: SKILL_ERROR_CODES.DRAFT_INVALID,
          reasons: [`不允许的路径：${file.path}`],
        })
      }
      const bytes = await readSkillObjectQuietly(`${input.fork.storageKey}${file.path}`)
      const key = skillDraftObjectKey(record.userId, record.id, file.path)
      await s3.putObject(bucket, key, bytes, bytes.length, { 'Content-Type': file.mime })
      written.push(key)
      record.files.push({
        path: file.path,
        kind: kindOfDraftPath(file.path),
        mime: file.mime,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
    record.files.sort((a, b) => a.path.localeCompare(b.path))
    await persist(record)
  } catch (error) {
    record.files = []
    await removeKeysQuietly(written)
    await deleteSkillDraftRaw(record.id).catch(() => undefined)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
  getLogger().info(
    { draftId: record.id, targetSkillId: input.target.id, baseVersion: input.baseVersion },
    '已从副本创建更新建议草稿',
  )
  return toDraft(record)
}

/**
 * 按当前上游重建一份 `SESSION_OVERRIDE` 草稿（`.../rebased`，§5.16.4 第二项）。
 *
 * 正文 / 文件来自**当前覆写的 S3 前缀**（不是上游），`baseVersion` 指向新的上游版本 ——
 * 用户在审核页看到的是"我的改动 vs 新上游"的 diff，保存时仍走 `PUT`（CAS `expectedRevision`）。
 */
export async function createSessionOverrideDraftFromExisting(input: {
  viewer: SkillViewer
  conversationId: string
  targetSkillId: string
  baseVersion: number
  expectedRevision: number
  overrideId: string
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: readonly string[]
  markdown: string
  changeSummary: string
  source: { storageKey: string; files: readonly { path: string; mime: string; size: number; sha256: string }[] }
}): Promise<SkillDraft> {
  const scan = scanSkillSecrets(input.markdown)
  const now = new Date().toISOString()
  const record: SkillDraftRecord = {
    id: randomUUID(),
    userId: input.viewer.id,
    kind: 'SESSION_OVERRIDE',
    targetSkillId: input.targetSkillId,
    baseVersion: input.baseVersion,
    overrideConversationId: input.conversationId,
    expectedRevision: input.expectedRevision,
    overrideId: input.overrideId,
    name: input.name.trim(),
    description: input.description.trim(),
    runtime: input.runtime,
    requiresBins: [...new Set(input.requiresBins.map((bin) => bin.trim()).filter((bin) => bin !== ''))],
    markdown: input.markdown,
    warnings: [],
    changeSummary: input.changeSummary.trim(),
    risks: [],
    files: [],
    redactions: scan.redactions,
    // 正文/文件来自**已保存过的覆写**（保存时必须确认过脱敏）⇒ 重建后的草稿不再重复问
    redactionCarried: true,
    source: null,
    createdAt: now,
    updatedAt: now,
  }
  await persist(record)
  const bucket = config.s3.bucket
  const written: string[] = []
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) await s3.makeBucket(bucket)
    for (const file of input.source.files) {
      if (file.path === SKILL_ENTRY_PATH) continue
      if (!isSafeSkillPath(file.path)) {
        throw AppError.validation(appMsg('app.m305', { p0: `不允许的路径：${file.path}` }), {
          code: SKILL_ERROR_CODES.DRAFT_INVALID,
          reasons: [`不允许的路径：${file.path}`],
        })
      }
      const bytes = await readSkillObjectQuietly(`${input.source.storageKey}${file.path}`)
      const key = skillDraftObjectKey(record.userId, record.id, file.path)
      await s3.putObject(bucket, key, bytes, bytes.length, { 'Content-Type': file.mime })
      written.push(key)
      record.files.push({
        path: file.path,
        kind: kindOfDraftPath(file.path),
        mime: file.mime,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
    record.files.sort((a, b) => a.path.localeCompare(b.path))
    await persist(record)
  } catch (error) {
    record.files = []
    await removeKeysQuietly(written)
    await deleteSkillDraftRaw(record.id).catch(() => undefined)
    throw error instanceof AppError ? error : AppError.internal(appMsg('app.m012'))
  }
  getLogger().info({ draftId: record.id, targetSkillId: input.targetSkillId, baseVersion: input.baseVersion }, '已按当前上游重建会话覆写草稿')
  return toDraft(record)
}

async function tryPinSkillVersion(
  agentId: string,
  skillId: string,
  version: number,
  viewer: SkillViewer,
): Promise<string | null> {
  const db = getPrisma()
  try {
    const agent = await db.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: { id: true, createdBy: true },
    })
    if (agent === null) return '要固定的智能体不存在或已删除（版本已保存）'
    if (agent.createdBy !== viewer.id && viewer.role !== 'ADMIN') return '你没有权限编辑这个智能体（版本已保存）'
    const component = await db.agentComponent.findFirst({
      where: { agentId, componentType: 'SKILL', refId: skillId },
      select: { id: true, config: true },
    })
    if (component === null) return '这个 Skill 本来就没有绑定在该智能体上（版本已保存）'
    const previous =
      component.config !== null && typeof component.config === 'object' && !Array.isArray(component.config)
        ? (component.config as Record<string, unknown>)
        : {}
    await db.agentComponent.update({
      where: { id: component.id },
      data: { config: { ...previous, skillVersion: version } as Prisma.InputJsonValue },
    })
    return null
  } catch (error) {
    getLogger().warn({ err: error, agentId, skillId, version }, 'Skill 版本已保存但固定到智能体失败')
    return '固定到该智能体的新版本失败（版本已保存，可在智能体编辑页手动选择）'
  }
}

/** 读当前版本的 `SKILL.md`（读不到 ⇒ 空串：基准正文缺失时 diff 退化成"整篇都是新增"，不阻塞保存） */
export async function readSkillObjectQuietly(storageKey: string): Promise<Buffer> {
  if (storageKey === '') return Buffer.alloc(0)
  const key = storageKey
  try {
    const stream = await getS3Client().getObject(config.s3.bucket, key)
    const chunks: Buffer[] = []
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch (error) {
    getLogger().warn({ err: error, storageKey: key }, '读取 Skill 基准正文失败（diff 按空基准计算）')
    return Buffer.alloc(0)
  }
}

/**
 * 顺带绑定到 Agent（口径 ⑦）。**恒不抛**：失败返回人话原因。
 *
 * 只做最小集合：Agent 可编 + 该 Agent 的组件集合里补一行 `SKILL`（不碰其它组件）。
 * 真正的绑定门禁（ChatBot + sandbox / 他人 sandbox）仍由 `replaceAgentComponents` 那套判据负责；
 * 这里先做同一套判据的**本地前检**，避免"绑定失败但 Skill 已存"时给出一个看不懂的内部错误。
 */
async function tryBindSkill(
  agentId: string,
  skillId: string,
  runtime: SkillRuntime,
  viewer: SkillViewer,
): Promise<string | null> {
  const db = getPrisma()
  try {
    const agent = await db.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: { id: true, type: true, createdBy: true },
    })
    if (agent === null) return '要绑定的智能体不存在或已删除（Skill 已保存，可在智能体编辑页手动绑定）'
    const canEdit = agent.createdBy === viewer.id || viewer.role === 'ADMIN'
    if (!canEdit) return '你没有权限编辑这个智能体（Skill 已保存，可在有权限后手动绑定）'
    if (agent.type === 'CHATBOT' && runtime === 'SANDBOX') return '对话智能体不能绑定需要沙箱的 Skill（Skill 已保存）'
    const skill = await db.skill.findUnique({ where: { id: skillId }, select: { runtime: true, createdBy: true } })
    if (skill !== null && skill.runtime === 'SANDBOX' && skill.createdBy !== viewer.id && viewer.role !== 'ADMIN') {
      return '不能把他人创建的沙箱 Skill 绑定到智能体（Skill 已保存）'
    }
    await db.agentComponent.createMany({
      data: [{ agentId, componentType: 'SKILL', refId: skillId }],
      skipDuplicates: true,
    })
    return null
  } catch (error) {
    getLogger().warn({ err: error, agentId, skillId }, 'Skill 保存成功但顺带绑定失败')
    return '顺带绑定失败（Skill 已保存，可在智能体编辑页手动绑定）'
  }
}

// ═════════════════════════════════════════════════════════════════════
// 只读版本历史 / 变更记录
// ═════════════════════════════════════════════════════════════════════

/** 版本历史（`GET /api/skills/:id/versions`；可见即可，**只读**，MVP 不做回滚） */
export async function listSkillVersionsForSkill(skillId: string, viewer: SkillViewer): Promise<SkillVersion[]> {
  const row = await getPrisma().skill.findFirst({ where: { id: skillId, deletedAt: null }, select: SKILL_SELECT })
  if (row === null) throw AppError.notFound(appMsg('app.m288', { p0: skillId }))
  if (!canViewSkill(row, viewer)) throw AppError.notFound(appMsg('app.m288', { p0: skillId }))
  return listSkillVersionsImpl(skillId)
}

/** 变更记录（`GET /api/skills/:id/changes`；只读） */
export async function listSkillChangesForSkill(skillId: string, viewer: SkillViewer): Promise<SkillChange[]> {
  const row = await getPrisma().skill.findFirst({ where: { id: skillId, deletedAt: null }, select: SKILL_SELECT })
  if (row === null) throw AppError.notFound(appMsg('app.m288', { p0: skillId }))
  if (!canViewSkill(row, viewer)) throw AppError.notFound(appMsg('app.m288', { p0: skillId }))
  const changes = await getPrisma().skillChange.findMany({
    where: { skillId },
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
    take: 100,
  })
  return changes.map((change) => ({
    id: change.id,
    skillId: change.skillId,
    fromVersion: change.fromVersion,
    toVersion: change.toVersion,
    changeSummary: change.changeSummary,
    source: change.source,
    createdBy: change.createdBy,
    creatorName: change.creator.nickname ?? change.creator.username,
    createdAt: change.createdAt.toISOString(),
  }))
}

/** 版本聚合（与 `skillAsset.service.ts#listSkillVersions` 同口径；这里不 import 它以免循环） */
async function listSkillVersionsImpl(skillId: string): Promise<SkillVersion[]> {
  const db = getPrisma()
  const groups = await db.skillFile.groupBy({
    by: ['version'],
    where: { skillId },
    _count: { _all: true },
    _min: { createdAt: true },
  })
  const live = await db.skillFile.groupBy({
    by: ['version'],
    where: { skillId, storageKey: { not: '' } },
    _count: { _all: true },
  })
  const liveByVersion = new Map(live.map((row) => [row.version, row._count._all]))
  return groups
    .map((row) => ({
      version: row.version,
      createdAt: (row._min.createdAt ?? new Date(0)).toISOString(),
      fileCount: row._count._all,
      purged: (liveByVersion.get(row.version) ?? 0) === 0,
    }))
    .sort((a, b) => b.version - a.version)
}

// ═════════════════════════════════════════════════════════════════════
// 杂项（投影 / 常量再导出）
// ═════════════════════════════════════════════════════════════════════

/** 草稿类型 / 文件分类 / 脱敏种类（给路由层做文档与回归用的再导出） */
export { SKILL_DRAFT_FILE_KINDS, SKILL_DRAFT_KINDS_SUPPORTED, SKILL_REDACTION_KINDS, SKILL_RUNTIMES, importError }
