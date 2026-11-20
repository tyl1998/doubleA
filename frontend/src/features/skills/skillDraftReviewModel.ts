/**
 * Skill 草稿审核（文件树 + diff）的纯数据层。
 *
 * 审核弹层与深链审核页共用同一份「草稿文件 ∪ 基准版本文件」清单：
 *   · `SKILL.md` 用草稿正文（虚拟成一条文件）；
 *   · 草稿里上传 / 替换过的文件覆盖同名基准文件；
 *   · 其余基准文件按「未改动」展示。
 *
 * 这里只做形状与状态判定，不发请求；正文读取在组件里（同一套分页拼接逻辑）。
 */

import {
  SKILL_ENTRY_PATH,
  SKILL_PAGE_MAX_LIMIT,
  isPreviewableSkillMime,
  type SkillDraftFile,
  type SkillFileEntry,
  type SkillRuntime,
} from '@doubulea/shared'

import { fetchSkillFile } from '../../api/skills.js'

/** 审核页表单基线（服务端草稿里可编辑的那几个字段） */
export interface SkillDraftForm {
  name: string
  description: string
  runtime: SkillRuntime
  markdown: string
  requiresBinsText: string
}

export function draftFormOf(draft: {
  name: string
  description: string
  runtime: SkillRuntime
  markdown: string
  requiresBins: readonly string[]
}): SkillDraftForm {
  return {
    name: draft.name,
    description: draft.description,
    runtime: draft.runtime,
    markdown: draft.markdown,
    requiresBinsText: draft.requiresBins.join(', '),
  }
}

export function draftFormDiffers(a: SkillDraftForm, b: SkillDraftForm): boolean {
  return (
    a.name !== b.name ||
    a.description !== b.description ||
    a.runtime !== b.runtime ||
    a.markdown !== b.markdown ||
    a.requiresBinsText !== b.requiresBinsText
  )
}

/** UTF-8 字节数（浏览器没有 `Buffer`；diff 的统计口径用 `TextEncoder` 与后端同值） */
export function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).length
}

/** `python3, jq` → `['python3', 'jq']`（中英文逗号与空白都认） */
export function binsOf(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/u).map((item) => item.trim()).filter((item) => item !== ''))]
}

/**
 * 审核文件树里的一行：基准 / 草稿的文件身份 + 改动状态。
 *
 * `REMOVED` = 在基准里、但被草稿删除（墓碑 `removedPaths`，P1-24a-7）；`RENAMED` = 重命名后的目标路径
 * （源路径表现为 `REMOVED`，目标路径表现为 `ADDED` 由组件在 `renameOf` 里覆写成 `RENAMED`）。
 */
export type SkillReviewFileStatus = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED' | 'UNCHANGED'

export interface SkillReviewFile extends SkillFileEntry {
  status: SkillReviewFileStatus
  /** 该路径在基准版本里存在 */
  inBase: boolean
  /** 该路径在草稿文件里存在（含替换同名基准文件；被删除的基准文件为 `false`） */
  inDraft: boolean
  /** 该路径在草稿的墓碑里（已删除） */
  removed: boolean
}

/**
 * 合并「草稿正文 + 草稿文件 + 基准文件」成审核文件清单。
 *
 * @param isTargeted `REVISION` / `SESSION_OVERRIDE` 才有基准；`CREATE` 不做改动判定。
 * @param removedPaths 墓碑（草稿里删除的路径；P1-24a-7）—— 命中的基准文件标 `REMOVED`（仍在树里可取消）。
 */
export function buildReviewFiles(input: {
  markdown: string
  baseMarkdown: string
  draftFiles: readonly SkillDraftFile[]
  baseFiles: readonly SkillFileEntry[]
  isTargeted: boolean
  removedPaths?: readonly string[]
}): SkillReviewFile[] {
  const removed = new Set(input.removedPaths ?? [])
  const baseByPath = new Map(
    input.baseFiles.filter((file) => file.path !== SKILL_ENTRY_PATH).map((file) => [file.path, file]),
  )
  const draftByPath = new Map(input.draftFiles.filter((file) => !removed.has(file.path)).map((file) => [file.path, file]))
  const files: SkillReviewFile[] = []

  const entryModified = input.isTargeted && input.markdown !== input.baseMarkdown
  files.push({
    path: SKILL_ENTRY_PATH,
    size: byteLengthOf(input.markdown),
    mime: 'text/markdown',
    sha256: '',
    previewable: true,
    purged: false,
    status: entryModified ? 'MODIFIED' : 'UNCHANGED',
    inBase: input.baseFiles.some((file) => file.path === SKILL_ENTRY_PATH),
    inDraft: true,
    removed: false,
  })

  for (const base of input.baseFiles) {
    if (base.path === SKILL_ENTRY_PATH) continue
    if (removed.has(base.path)) {
      files.push({ ...base, status: 'REMOVED', inBase: true, inDraft: false, removed: true })
      continue
    }
    const draft = draftByPath.get(base.path)
    if (draft === undefined) {
      files.push({ ...base, status: 'UNCHANGED', inBase: true, inDraft: false, removed: false })
      continue
    }
    files.push({
      ...base,
      size: draft.size,
      mime: draft.mime,
      sha256: draft.sha256,
      previewable: isPreviewableSkillMime(draft.mime),
      purged: false,
      status: base.sha256 === draft.sha256 ? 'UNCHANGED' : 'MODIFIED',
      inBase: true,
      inDraft: true,
      removed: false,
    })
  }

  for (const draft of input.draftFiles) {
    if (removed.has(draft.path) || baseByPath.has(draft.path)) continue
    files.push({
      path: draft.path,
      size: draft.size,
      mime: draft.mime,
      sha256: draft.sha256,
      previewable: isPreviewableSkillMime(draft.mime),
      purged: false,
      status: 'ADDED',
      inBase: false,
      inDraft: true,
      removed: false,
    })
  }

  return files.sort((a, b) => {
    if (a.path === SKILL_ENTRY_PATH) return -1
    if (b.path === SKILL_ENTRY_PATH) return 1
    return a.path.localeCompare(b.path)
  })
}

/**
 * 读某一版 Skill 文件的**全文**（按码点分页拼回）。
 *
 * `null` = 二进制 / 不可预览。服务端单页上限是 `SKILL_PAGE_MAX_LIMIT`，这里翻页拼全文；
 * 与旧审核页同一口径（曾经直接发 `limit=200000` 被 400 拒绝，diff 退化成整篇新增）。
 */
export async function readSkillTextFile(
  skillId: string,
  path: string,
  version: number | undefined,
): Promise<string | null> {
  let text = ''
  let offset = 0
  for (let page = 0; page < 100; page += 1) {
    const preview = await fetchSkillFile(skillId, {
      path,
      ...(version === undefined ? {} : { version }),
      offset,
      limit: SKILL_PAGE_MAX_LIMIT,
    })
    if (preview.kind !== 'TEXT' || preview.page === null) return null
    text += preview.page.text
    if (!preview.page.truncated || preview.page.nextOffset === null) return text
    offset = preview.page.nextOffset
  }
  return text
}

/** 读某一版 `SKILL.md` 正文；读不到按空基准处理（与旧审核页一致） */
export async function readSkillMarkdown(skillId: string, version: number | undefined): Promise<string> {
  const text = await readSkillTextFile(skillId, SKILL_ENTRY_PATH, version)
  return text ?? ''
}