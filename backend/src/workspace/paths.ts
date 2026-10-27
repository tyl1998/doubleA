/**
 * 工作区路径判据（P1-9 · P0）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §九（路径逃逸 / uid 对齐 / 配额）+ §十一（参数总表）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两道判据，缺一不可
 * ─────────────────────────────────────────────────────────────────────
 *   ① **归一化**（`shared#normalizeWorkspacePath`）：拒绝绝对路径与任何 `..` 段 —— 解决
 *      "这条字符串是不是一条合法的相对路径"；
 *   ② **realpath 包含性**（{@link resolveWorkspacePath}）：把最深的存在祖先 `realpath` 后
 *      要求它落在工作区根内 —— 解决"归一化合法、但**路径上某一段是符号链接指向根外**"
 *      （agent 用 `bash` 在 `/work` 里 `ln -s /etc passwd.md`，一次普通读就会读到根外）。
 * 只做 ① 是本批最容易漏的一处：它在**没有符号链接**时永远看不出问题。
 *
 * ⚠️ 本文件是**纯判据 + 少量只读 FS 探测**（`realpath`/`existsSync`），不做任何写动作 ——
 * 于是它可以在临时目录里被逐条核对（见 `scripts/workspace-regression.ts`）。
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { appMsg, AppError, normalizeWorkspacePath } from '@doubulea/shared'

/**
 * watcher 事件去抖窗口（毫秒，**代码常量**，不进 env —— 同 `子方案` §十一 的取舍）。
 * 一次保存会触发多个 FS 事件（write/rename/attrib）⇒ 去抖后才发一条 `WorkspaceEvent`。
 */
export const WORKSPACE_EVENT_DEBOUNCE_MS = 300

/**
 * 人保存后冷备上行去抖窗口（毫秒，**代码常量**）。P5 才消费；P0 先登记，避免下一批再回来改本文件。
 */
export const WORKSPACE_BACKUP_DEBOUNCE_MS = 2000

/** 一个会话的 canonical 工作区目录（宿主绝对路径）。root 由 `config.workspace.root` 提供 */
export function workspaceDirOf(root: string, conversationId: string): string {
  return join(root, conversationId)
}

/** {@link resolveWorkspacePath} 的返回值：归一化相对路径 + 宿主绝对路径 */
export interface ResolvedWorkspacePath {
  relative: string
  absolute: string
}

/**
 * 把请求里的原始路径解析成"**确认落在工作区根内**"的绝对路径。
 *
 * @throws AppError(VALIDATION) 归一化失败（绝对路径 / `..` / 空 / 超长）
 * @throws AppError(FORBIDDEN) 归一化合法、但 `realpath` 后逃出根（符号链接）
 */
export function resolveWorkspacePath(rootDir: string, rawPath: unknown): ResolvedWorkspacePath {
  const relative = normalizeWorkspacePath(rawPath)
  if (relative === null) {
    throw AppError.validation(appMsg('app.m234'))
  }
  const absolute = join(rootDir, relative)
  assertRealPathInside(rootDir, absolute)
  return { relative, absolute }
}

/**
 * 包含性校验：把 `absolute`（或它**最深的存在祖先**）`realpath` 后，要求它等于根或落在根之下。
 *
 * 为什么取"最深存在的祖先"：写一个新文件时目标还不存在，`realpath` 会 `ENOENT` ——
 * 但它的父目录（乃至更高层）已经存在，任何一层是逃逸符号链接都已足以判死。
 * ⚠️ 根目录自身**必须存在**（调用方在写之前已 `ensureWorkspaceDir`）；否则无从比较，直接拒绝。
 */
export function assertRealPathInside(rootDir: string, absolute: string): void {
  const rootReal = realpathOf(rootDir) ?? rootDir
  const probe = deepestExistingAncestor(absolute)
  const probeReal = realpathOf(probe) ?? probe
  if (probeReal === rootReal) return
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (probeReal.startsWith(prefix)) return
  throw AppError.forbidden(appMsg('app.m235'))
}

/** `realpath`（native，返回系统路径形态）；根不存在/无权限时返回 `undefined` */
function realpathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/** 从 `absolute` 向上找到第一个存在的祖先（含自身）；到文件系统根仍不存在时返回该根 */
function deepestExistingAncestor(absolute: string): string {
  let probe = absolute
  for (;;) {
    if (existsSync(probe)) return probe
    const parent = dirname(probe)
    if (parent === probe) return probe
    probe = parent
  }
}