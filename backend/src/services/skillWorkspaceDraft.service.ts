/**
 * 从工作区目录 / zip 生成 Skill 草稿（TaskAgent 工具 `request_skill_from_workspace` 的实现）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么先打包成 zip 再交给 `parseSkillZip`
 * ─────────────────────────────────────────────────────────────────────
 * 导入闸门（路径穿越 / 符号链接 / 大小 / 压缩比 / frontmatter / runtime 一致性）已经存在且
 * 只有一份实现；这里只负责把"工作区里的一个目录"变成"同一形态的字节"，**不复制第二套校验**。
 * 目录在内存里用 `buildZip` 打成 stored zip（不压缩），zip 文件直接读字节。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **只产草稿**：与 `request_skill_draft` 一样走 `createSkillDraft` + 审核页，不直接写 `skills`；
 * ② **一次一个 Skill**：平台的数据模型是一个 Skill 一份文件树；多 Skill 合集请调用方循环；
 * ③ **不读容器**：路径相对 `WORKSPACE_ROOT/{conversationId}`（宿主与 `/work` 同一份 bind mount），
 *    服务端用工作区自己的 realpath 判据拒绝逃逸。
 */

import {
  appMsg,
  AppError,
  isGitInternalPath,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  SKILL_NAME_MAX_CHARS,
  type SkillRuntime,
} from '@doubulea/shared'

import { join } from 'node:path'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { resolveWorkspacePath } from '../workspace/paths.js'
import { assertWorkspaceOwner, ensureWorkspace } from '../workspace/service.js'
import {
  readWorkspaceBytes,
  scanWorkspaceFiles,
  type WorkspaceScanEntry,
  workspaceFileSize,
  workspaceIsDirectory,
} from '../workspace/store.js'
import { buildZip, type ZipEntry } from '../workspace/zip.js'
import { createSkillDraft, deleteSkillDraft, uploadSkillDraftFile } from './skillDraft.service.js'
import { parseSkillZip, stripFrontmatter, type ParsedSkillZip } from './skillZip.js'
import type { SkillViewer } from './skill.service.js'

/** 草稿种子（纯映射；不写库、不碰 S3） */
export interface SkillDraftSeed {
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: string[]
  /** `SKILL.md` 正文（frontmatter 已剥离；保存时由服务端重生成） */
  markdown: string
  /** 除 `SKILL.md` 之外的文件（文本 / 二进制都保留原始字节） */
  files: { path: string; bytes: Buffer }[]
}

function invalidDraft(reason: string): AppError {
  return AppError.validation(appMsg('app.m305', { p0: reason }), {
    code: SKILL_ERROR_CODES.DRAFT_INVALID,
    reasons: [reason],
  })
}

/** `skills/story.zip` → `story`；`skills/story` → `story` */
function fallbackNameOf(sourcePath: string): string {
  const segment = sourcePath.split('/').filter((item) => item !== '').pop() ?? ''
  return segment.replace(/\.zip$/iu, '')
}

function clampName(text: string): string {
  return [...text].slice(0, SKILL_NAME_MAX_CHARS).join('').trim()
}

/** 第一个非空值（空串 = 没写；第三方包里 `name: ""` 与缺省同义） */
function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? ''
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * `parseSkillZip` 的结果 → 草稿种子（**纯函数**，回归可直接构造输入）。
 *
 * `SKILL.md` 只作为正文（frontmatter 不进草稿正文：保存时按 DB 字段重生成）；其余文件原样带字节。
 */
export function skillDraftSeedOfParsed(
  parsed: ParsedSkillZip,
  input: { sourcePath: string; titleHint?: string },
): SkillDraftSeed {
  const markdown = stripFrontmatter(parsed.entryMarkdown)
  if (markdown.trim() === '') throw invalidDraft('SKILL.md 正文为空')

  const description = parsed.frontmatter.description ?? ''
  if (description.trim() === '') throw invalidDraft('SKILL.md 缺少 description')

  const name = clampName(
    firstNonEmpty(
      parsed.frontmatter.name,
      parsed.nameHint,
      input.titleHint,
      fallbackNameOf(input.sourcePath),
    ),
  )
  if (name === '') throw invalidDraft('无法确定 Skill 名称（请在 SKILL.md 写 name / 一级标题，或传入 titleHint）')

  return {
    name,
    description,
    runtime: parsed.runtime ?? 'INLINE',
    requiresBins: [...parsed.requiresBins],
    markdown,
    files: parsed.files
      .filter((file) => file.path !== SKILL_ENTRY_PATH)
      .map((file) => ({ path: file.path, bytes: file.bytes })),
  }
}

/** 目录内的文件（排除 `.git` 内部文件与桌面压缩工具塞进来的元数据；依赖目录已被扫描器排除） */
function skillFilesUnder(entries: readonly WorkspaceScanEntry[], relative: string): WorkspaceScanEntry[] {
  const prefix = `${relative}/`
  return entries.filter(
    (entry) =>
      entry.relative.startsWith(prefix) &&
      entry.relative !== relative &&
      !isGitInternalPath(entry.relative) &&
      !isJunkRelative(entry.relative),
  )
}

/** 与 `skillZip#isJunkPath` 同口径：这些文件不该计入草稿文件数 / 体积 */
function isJunkRelative(relative: string): boolean {
  const segments = relative.split('/')
  if (segments[0] === '__MACOSX') return true
  const name = segments[segments.length - 1] ?? ''
  return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' || name.startsWith('._')
}

function assertDraftBytes(files: ReadonlyArray<{ relative: string; size: number }>): void {
  if (files.length > config.skill.draft.maxFiles) {
    throw invalidDraft(`文件数超过草稿上限（${String(config.skill.draft.maxFiles)}），请精简 Skill 目录`)
  }
  let total = 0
  for (const file of files) {
    if (file.size > config.skill.draft.maxFileBytes) {
      throw invalidDraft(
        `单个文件超过草稿上限（${String(config.skill.draft.maxFileBytes)} 字节）：${file.relative}`,
      )
    }
    total += file.size
  }
  if (total > config.skill.maxTotalBytes) {
    throw invalidDraft(`解包后总体积超过上限（${String(config.skill.maxTotalBytes)} 字节）`)
  }
}

async function zipOfWorkspaceDirectory(rootPath: string, relative: string): Promise<Buffer> {
  const entries = skillFilesUnder(await scanWorkspaceFiles(rootPath), relative)
  if (entries.length === 0) throw invalidDraft(`目录里没有文件：${relative}`)
  assertDraftBytes(entries)

  const prefix = `${relative}/`
  const zipEntries: ZipEntry[] = []
  for (const entry of entries) {
    zipEntries.push({
      name: entry.relative.slice(prefix.length),
      data: await readWorkspaceBytes(join(rootPath, entry.relative)),
    })
  }
  return buildZip(zipEntries)
}

export interface SkillDraftFromWorkspaceResult {
  draftId: string
  name: string
  runtime: SkillRuntime
  fileCount: number
}

/**
 * 读取工作区里的一个目录 / zip，校验并生成 `CREATE` 草稿。
 *
 * 失败时：包不合格 ⇒ 抛 `SKILL_IMPORT_INVALID`；草稿已建但文件没写完 ⇒ 删掉草稿后再抛
 * （不给用户留一份"看起来有文件、其实缺一半"的草稿）。
 */
export async function createSkillDraftFromWorkspace(input: {
  conversationId: string
  path: string
  titleHint?: string | undefined
  viewer: SkillViewer
}): Promise<SkillDraftFromWorkspaceResult> {
  await assertWorkspaceOwner(input.conversationId, input.viewer.id)
  const handle = await ensureWorkspace(input.conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, input.path)

  let zip: Buffer
  if (await workspaceIsDirectory(absolute)) {
    zip = await zipOfWorkspaceDirectory(handle.rootPath, relative)
  } else {
    const size = await workspaceFileSize(absolute)
    if (size === undefined) throw invalidDraft(`工作区里没有这个文件：${relative}`)
    if (size > config.limits.uploadBodyLimitBytes) {
      throw invalidDraft(`文件超过读取上限（${String(config.limits.uploadBodyLimitBytes)} 字节）：${relative}`)
    }
    zip = await readWorkspaceBytes(absolute)
  }

  const parsed = parseSkillZip(zip)
  const seed = skillDraftSeedOfParsed(parsed, {
    sourcePath: relative,
    ...(input.titleHint === undefined ? {} : { titleHint: input.titleHint }),
  })
  if ([...seed.markdown].length > config.skill.draft.maxMarkdownChars) {
    throw invalidDraft(`SKILL.md 正文超过草稿上限（${String(config.skill.draft.maxMarkdownChars)} 字符）`)
  }
  if (seed.files.length + 1 > config.skill.draft.maxFiles) {
    throw invalidDraft(`文件数超过草稿上限（${String(config.skill.draft.maxFiles)}），请精简 Skill 目录`)
  }

  const draft = await createSkillDraft(
    {
      kind: 'CREATE',
      name: seed.name,
      description: seed.description,
      runtime: seed.runtime,
      requiresBins: seed.requiresBins,
      markdown: seed.markdown,
    },
    input.viewer,
  )

  try {
    for (const file of seed.files) {
      await uploadSkillDraftFile(
        draft.id,
        { fileName: file.path, path: file.path, bytes: file.bytes },
        input.viewer,
      )
    }
  } catch (error) {
    await deleteSkillDraft(draft.id, input.viewer).catch((cleanupError: unknown) => {
      getLogger().warn({ err: cleanupError, draftId: draft.id }, '工作区导入失败后回收草稿失败')
    })
    throw error
  }

  getLogger().info(
    {
      conversationId: input.conversationId,
      draftId: draft.id,
      path: relative,
      runtime: seed.runtime,
      fileCount: seed.files.length,
    },
    '已从工作区生成 Skill 草稿',
  )

  return {
    draftId: draft.id,
    name: seed.name,
    runtime: seed.runtime,
    fileCount: seed.files.length,
  }
}