/**
 * Fork / 上游同步的**纯函数**（P1-24c-5；无 DB / 无 S3，回归可直接断言）
 *
 * 依据：`docs/子方案/会话生成Skill.md` §10.11 / §10.14 / §10.24、`docs/06-实施计划.md` P1-24c-5。
 *
 * 两条容易写错的判据都落在这里：
 *  ① 副本名 = 源名字 + 「（副本）」；重名时顺延「（副本 2）」…，并保证总长不超过 `SKILL_NAME_MAX_CHARS`；
 *  ② 「无本地改动」= **内容判据**（`SKILL.md` 只比正文，其余文件比 path + sha256），不是版本号判据 ——
 *     fast-forward 之后副本版本号也会 +1，但它与上游一致，仍应允许下一次同步。
 */

import { SKILL_ENTRY_PATH, SKILL_NAME_MAX_CHARS } from '@doubulea/shared'

/** 副本名的固定后缀（与 agent 复制的「（副本）」同一话术） */
export const SKILL_FORK_NAME_SUFFIX = '（副本）'

/** 第 `attempt` 个候选名（1 = 原后缀；2.. = 「（副本 2）」…） */
export function forkedSkillName(sourceName: string, attempt = 1): string {
  const suffix = attempt <= 1 ? SKILL_FORK_NAME_SUFFIX : `（副本 ${String(attempt)}）`
  const base = sourceName.trim()
  // 与 zod `.max()` 同一把尺（UTF-16 length，不是码点数）：超长时先截源名，
  // 且不把代理对切成半个字符（否则生成的名字会变成 U+FFFD 且长度仍可能超）。
  const room = Math.max(1, SKILL_NAME_MAX_CHARS - suffix.length)
  let head = base.slice(0, room)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  head = head.trim() || base.slice(0, room).trim()
  return `${head}${suffix}`.slice(0, SKILL_NAME_MAX_CHARS)
}

/** 一个版本里参与内容比较的文件（`SKILL.md` 单独比正文，其余比 sha256） */
export interface SkillContentFile {
  path: string
  sha256: string
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/gu, '\n')
}

function fileDigestMap(files: readonly SkillContentFile[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of files) {
    if (file.path === SKILL_ENTRY_PATH) continue
    map.set(file.path, file.sha256)
  }
  return map
}

/**
 * 副本当前内容是否**逐字等于**基准（= 无本地改动）。
 *
 * `baseBody` / `forkBody` 都应是 `SKILL.md` 的**正文**（已去掉 frontmatter）：
 * fork 的 frontmatter 名字带「（副本）」，那是身份不是内容改动。
 */
export function skillContentMatches(input: {
  baseBody: string
  forkBody: string
  baseFiles: readonly SkillContentFile[]
  forkFiles: readonly SkillContentFile[]
}): boolean {
  if (normalizeNewlines(input.baseBody) !== normalizeNewlines(input.forkBody)) return false
  const base = fileDigestMap(input.baseFiles)
  const fork = fileDigestMap(input.forkFiles)
  if (base.size !== fork.size) return false
  for (const [path, sha256] of base) {
    if (fork.get(path) !== sha256) return false
  }
  return true
}