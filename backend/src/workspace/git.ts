/**
 * 工作区 git 概况（P1-9 · 补充）—— "我 clone 下来的项目现在在哪个分支"
 *
 * 依据：`docs/子方案/Code模式工作区.md` §六 1（工作区 API 挂在公网会话路由）；本文件是它的
 *       **只读**补充：不写任何东西，也不参与路径安全判据（只探固定位置 `.git`，路径不由用户输入）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ **不调 `git` 二进制**：只读 `.git/HEAD` 与 `.git` 文件里的 `gitdir:`
 * ─────────────────────────────────────────────────────────────────────
 * 宿主上不保证装了 git（纪律 9 的同款取舍：别给"看一眼分支"这件小事加一条环境依赖），而分支名
 * 本来就只有一处事实来源：`<gitdir>/HEAD`。
 *   · `.git` 是**目录**（普通仓库）⇒ 读 `<repo>/.git/HEAD`；
 *   · `.git` 是**文件**（worktree / submodule）⇒ 内容是 `gitdir: <path>`（可能是相对该目录的路径）⇒ 再读那个目录的 HEAD。
 *   · `HEAD` 内容：`ref: refs/heads/<branch>` ⇒ 分支名；40 位 SHA ⇒ detached（给 7 位短 SHA）；
 *     其余（`refs/tags/*`、`refs/remotes/*`、损坏）⇒ `branch: null`（**不猜**，前端显示"未知"）。
 *
 * 于是：本文件拆成"**纯解析**（{@link parseGitHead} / {@link parseGitDirFile}，回归里逐条喂字面量）"
 * + "**只读探测**（{@link readWorkspaceGitRepos}，临时目录里核对）"两段，与 `paths.ts` 同一手法。
 *
 * ⚠️ 只探**两层**（工作区根 + 一层子目录）：`/work` 里的常见形态就两种 —— 根是仓库，或 clone 到
 *    某个子目录（如 `qatt-platform-qa/`）。再深就是嵌套仓库（submodule）的领域，不在展示范围内。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  WorkspaceGitRepo,
  WorkspaceRetentionInfo,
  WorkspaceRetentionProtection,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getPrisma } from '../infra/prisma.js'
import { workspaceDirOf } from './paths.js'

/** 一层子目录里**最多**看多少个目录（防异常宽的工作区把一次探测拖慢；正常远到不了） */
const GIT_SCAN_MAX_DIRS = 200

/** 一层子目录里跳过的名字：依赖目录（隐藏目录另有 `startsWith('.')` 判据） */
const GIT_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules'])

/**
 * clone / pull **进行中**的标记文件（相对 git 目录）。git 自己也是靠这两个锁判"上一次没跑完"。
 * 见 {@link gitOperationInProgress}。
 */
const GIT_IN_PROGRESS_MARKERS = ['index.lock', 'shallow.lock'] as const

/**
 * `.git/HEAD` 的内容 → 分支 / detached（**纯函数**）。
 *
 * ⚠️ 非 `refs/heads/*` 的 `ref:` 一律 `branch: null`：`refs/tags/v1` 这类不是"当前分支"，
 *    把它显示成分支名会让用户以为在一个叫 `v1` 的分支上（事实是 detached 或异常态）。
 */
export function parseGitHead(raw: string): { branch: string | null; detached: boolean } {
  const text = raw.trim()
  const head = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
  if (head !== null) {
    const branch = head[1]?.trim() ?? ''
    if (branch !== '') return { branch, detached: false }
  }
  if (/^[0-9a-f]{7,40}$/i.test(text)) return { branch: text.slice(0, 7).toLowerCase(), detached: true }
  return { branch: null, detached: false }
}

/**
 * `.git` **文件**的内容（`gitdir: <path>`）→ git 目录的绝对路径（**纯函数**；认不出回 `null`）。
 * 相对路径按"该仓库根目录"解析（git 自己的口径）。
 */
export function parseGitDirFile(raw: string, repoDir: string): string | null {
  const matched = /^gitdir:\s*(.+)$/m.exec(raw)
  if (matched === null) return null
  const target = matched[1]?.trim() ?? ''
  if (target === '') return null
  return isAbsolute(target) ? target : resolve(repoDir, target)
}

/**
 * 这个 git 目录是不是**一次 clone / pull 还没落定**（P1-24，2026-10-27）。
 *
 * 判据是 git 自己的两个锁文件（`fsck` 之前 git 就是这么判的）：
 *   · `index.lock` —— 正在写索引（checkout / reset 中途）；
 *   · `shallow.lock` —— 浅克隆（`--depth`，agent 的常用形态）正在写边界文件。
 *
 * ★ 为什么要单独判：clone 期间工作区里**同时**在长大几千个文件，而两端（`index` 与
 *   `shallow`）都会被 git 删掉重写。面板据此把"git 已就绪"推后 —— 否则用户在 clone 中途看到的
 *   树是"半棵树 + 已展开的目录"，等 clone 收尾又跳一次（用户反馈："拉取下来目录又是默认全部展开了"）。
 * ⚠️ 读不到（目录不存在 / 权限）一律当**不是**进行中：这只是个提示，不该让面板卡在"克隆中"。
 */
async function gitOperationInProgress(gitDir: string): Promise<boolean> {
  for (const name of GIT_IN_PROGRESS_MARKERS) {
    try {
      await stat(join(gitDir, name))
      return true
    } catch {
      // 不存在 ⇒ 看下一个
    }
  }
  return false
}

/** 判一个目录是不是仓库根；是 ⇒ 回它的分支信息与"是否正在 clone/pull"（`null` = 不是仓库 / 读不到） */
async function probeGitRepo(
  repoDir: string,
): Promise<{ branch: string | null; detached: boolean; cloning: boolean } | null> {
  const dotGit = join(repoDir, '.git')
  let kind: 'dir' | 'file' | null
  try {
    const info = await stat(dotGit)
    kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
  } catch {
    return null
  }
  if (kind === null) return null

  let gitDir = dotGit
  if (kind === 'file') {
    let content: string
    try {
      content = await readFile(dotGit, 'utf8')
    } catch {
      return null
    }
    const parsed = parseGitDirFile(content, repoDir)
    if (parsed === null) return null
    gitDir = parsed
  }

  // ★ 顺序要紧：先看锁、再读 HEAD —— clone 前半段 `.git/HEAD` 都还不存在，两个判断互不干扰，
  //   但"锁还在"时的 HEAD 可能是中间态，不如让调用方等下一轮。
  const cloning = await gitOperationInProgress(gitDir)
  try {
    return { ...parseGitHead(await readFile(join(gitDir, 'HEAD'), 'utf8')), cloning }
  } catch {
    // HEAD 读不到：clone 刚建完 `.git/` 还没写 HEAD ⇒ 也算"进行中"，否则这一瞬间会被当成"不是仓库"
    return cloning ? { branch: null, detached: false, cloning: true } : null
  }
}

/**
 * 扫一个目录（当工作区根）下的 git 仓库：**根优先**，然后一层子目录按名字序。
 *
 * @returns 空数组 = 这个目录不存在 / 没有 git。⚠️ **不抛错**：分支展示是锦上添花，
 *          读不到就当没有，绝不能让面板因此报错。
 *
 * ⚠️ 刻意**收根目录参数**而不是自己去读 `config`（{@link readWorkspaceGitRepos} 才是读配置的那层）
 *    —— 这样判据能在临时目录里逐条核对，与 `paths.ts#resolveWorkspacePath(rootDir, …)` 同一手法。
 */
export async function scanGitReposUnder(rootDir: string): Promise<WorkspaceGitRepo[]> {
  const candidates: { path: string; dir: string }[] = [{ path: '', dir: rootDir }]

  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    // 工作区目录还不存在（新会话 / 已回收）⇒ 没有仓库可报
    return []
  }
  let scanned = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || GIT_SCAN_SKIP_DIRS.has(entry.name)) continue
    if (scanned >= GIT_SCAN_MAX_DIRS) break
    scanned += 1
    candidates.push({ path: entry.name, dir: join(rootDir, entry.name) })
  }

  const repos: WorkspaceGitRepo[] = []
  for (const candidate of candidates) {
    const head = await probeGitRepo(candidate.dir)
    if (head !== null) repos.push({ path: candidate.path, branch: head.branch, detached: head.detached, cloning: head.cloning })
  }
  return repos
}

/**
 * 列出一个**会话**工作区里的 git 仓库（= {@link scanGitReposUnder} 接上这个会话的宿主目录）。
 *
 * @returns 空数组 = 这个工作区没有 git（或工作区目录还不存在 —— 没派过活）。
 */
export async function readWorkspaceGitRepos(conversationId: string): Promise<WorkspaceGitRepo[]> {
  return scanGitReposUnder(workspaceDirOf(config.workspace.root, conversationId))
}

/**
 * 工作区**保留期提示**（2026-10-28）—— 让面板能提前说清"还有几天清理、会不会被保护"。
 *
 * 判据与 `workspace/reaper#retentionGuard` **同一套**（那边是"到期删不删"，这里是"到期会发生什么"），
 * 两处若各写一份就会出现"面板说 3 天后清理、实际有产物所以不清"这种自相矛盾。
 *
 * @returns `expiresAt` = `workspaces.updated_at` + 保留期；`protected` = 到期也**不会**被清。
 */
export async function readWorkspaceRetention(conversationId: string): Promise<WorkspaceRetentionInfo> {
  const row = await getPrisma().workspace.findUnique({
    where: { conversationId },
    select: { updatedAt: true },
  })
  const retentionDays = config.workspace.retentionDays
  const updatedAt = row?.updatedAt ?? null
  const expiresAt =
    updatedAt === null ? null : new Date(updatedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const artifactCount = await getPrisma().artifact.count({ where: { conversationId } })
  const protectDays = config.workspace.retentionProtectUserEditDays
  const userEditProtected =
    protectDays > 0 &&
    (await getPrisma().workspaceFile.findFirst({
      where: {
        conversationId,
        updatedBy: 'USER',
        deletedAt: null,
        updatedAt: { gte: new Date(Date.now() - protectDays * 24 * 60 * 60 * 1000) },
      },
      select: { path: true },
    })) !== null

  /** 到期也**不会**被清的原因（空 = 到点会真删） */
  const protectedReasons: WorkspaceRetentionProtection[] = []
  if (artifactCount > 0) protectedReasons.push('ARTIFACT_PRESENT')
  if (userEditProtected) protectedReasons.push('USER_EDIT_PROTECTED')

  return {
    retentionDays,
    updatedAt: updatedAt === null ? null : updatedAt.toISOString(),
    expiresAt,
    artifactCount,
    protectUserEditDays: protectDays,
    protectedReasons,
    protected: protectedReasons.length > 0,
  }
}
