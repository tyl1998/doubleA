/**
 * git 感知的产物过滤（#3）—— 把「git 仓库里**干净**（未改动）的 tracked 文件」从产物候选里剔除
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 6 / §十三 已决 6 —— `git clone` / `git pull` 拉下来的
 * 整棵树属「工作区内容」，**不算 agent 的交付物**；只有它之后被改动 / 新建的文件才算。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它：R4 的判据「本轮工作区变更集」不认识 git
 * ─────────────────────────────────────────────────────────────────────
 * `artifactChangePaths` 只看"本轮动过哪些路径"，于是轮内 `git clone` 会把整棵树判成本轮新增
 * （实测：拉一个仓库 → 命中单轮 200 上限，全进产物面板）。这里补一道 git 判据把"初始填充"剔掉。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 判据（用**宿主 git**，工作区就是宿主 bind mount 的那份 canonical 字节）
 * ─────────────────────────────────────────────────────────────────────
 *   · 只对 **tracked** 文件判（`git ls-files`）—— 未跟踪的新文件一律保留（那是 agent 真产出的）；
 *   · **干净** = `git status --porcelain` 对这条路径**无输出**（工作区与索引都无改动）；
 *   · 不在任何 git 仓库里的路径一律保留（非 git 工作区 = 现状不变）。
 *   · 结果：clone/pull 下来、没再动过的文件被剔除；被 agent 改过 / 新建的照常收。
 *
 * ⚠️ **保守失败**：git 不可用 / 命令报错 / 仓库探测失败 ⇒ **不剔除任何路径**（退回现状）。
 *    绝不因为一个辅助判据把用户真正的产物吞掉 —— 与产物收集"尽力而为"的总口径一致。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 单条 git 命令超时（毫秒）；超时按"保守失败"处理（不剔除） */
const GIT_TIMEOUT_MS = 15_000
/** git 输出缓冲上限（一个大仓库的 `ls-files` 可能很长） */
const GIT_MAX_BUFFER = 32 * 1024 * 1024

/** {@link filterGitCleanPaths} 的结果：保留 / 剔除（剔除的只用于日志，调用方通常只关心 `kept`） */
export interface GitCleanFilterResult {
  kept: string[]
  excluded: string[]
  /**
   * 这些候选里**被 git 跟踪**的路径（工作区相对路径）。
   *
   * ★ 2026-10-28（用户反馈「拉取代码这个会话最近变更对不上」）：只按"路径此刻脏不脏"剔，
   *   会把**clone 检出那一刻**的 `created v1` 留在清单里 —— 比如 `repo/conftest.py`：
   *   它是仓库自带文件（`created v1` 来自 checkout），后来被改脏了，于是路径判据放行，
   *   结果「更早」里凭空多出一条"新建"。调用方拿这份集合就能把"检出产生的创建"也剔掉。
   */
  tracked: string[]
}

/**
 * 解析 `git status --porcelain -z` 的输出（**已按 `\0` 拆开**）里的**脏路径**集合。
 *
 * porcelain v1 每条：`XY<空格>path`（rename 的 -z 形态会多一条裸的原路径 —— 首两字符不是状态码，
 * 用 `entry[2] === ' '` 过滤掉它）。导出为纯函数便于核对（`workspace-regression.ts`）。
 */
export function parsePorcelainPaths(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.length >= 4 && entry[2] === ' ') out.push(entry.slice(3))
  }
  return out
}

/** 从 `absPath` 向上找到第一个含 `.git` 的目录（不越过工作区根 `rootDir`）；找不到返回 `undefined` */
function repoRootOf(absPath: string, rootDir: string): string | undefined {
  let dir = dirname(absPath)
  while (dir.startsWith(rootDir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir === rootDir) return undefined
    dir = dirname(dir)
  }
  return undefined
}

/** 跑一条 git 命令、返回按 `\0` 拆开的 stdout（失败抛错，由调用方按"保守失败"兜） */
async function gitNulSplit(repo: string, args: readonly string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  })
  return stdout.split('\0')
}

/**
 * 过滤产物候选：剔除"git 仓库里干净的 tracked 文件"（= clone/pull 拉下来、没再动过的）。
 *
 * @param rootDir 工作区宿主根（`ensureWorkspace().rootPath`）
 * @param paths   **工作区相对路径**（已过 `artifactChangePaths` 的隐藏 / excludedDirs 筛选）
 */
export async function filterGitCleanPaths(
  rootDir: string,
  paths: readonly string[],
): Promise<GitCleanFilterResult> {
  const kept: string[] = []
  const excluded: string[] = []
  const trackedPaths: string[] = []
  /** 仓库根 → 该仓库下的候选（`rel` = 相对仓库根的路径，供 `git ls-files` 的 pathspec 用） */
  const byRepo = new Map<string, { path: string; rel: string }[]>()

  for (const path of paths) {
    const abs = join(rootDir, path)
    const repo = repoRootOf(abs, rootDir)
    if (repo === undefined) {
      kept.push(path)
      continue
    }
    const rel = relative(repo, abs).split(sep).join('/')
    const list = byRepo.get(repo)
    if (list === undefined) byRepo.set(repo, [{ path, rel }])
    else list.push({ path, rel })
  }

  for (const [repo, entries] of byRepo) {
    let tracked: Set<string>
    let dirty: Set<string>
    try {
      tracked = new Set((await gitNulSplit(repo, ['ls-files', '-z'])).filter((item) => item !== ''))
      dirty = new Set(parsePorcelainPaths(await gitNulSplit(repo, ['status', '--porcelain', '-z', '--untracked-files=all'])))
    } catch {
      // git 不可用 / 超时 / 仓库损坏 ⇒ 保守：这一仓库的候选全部保留（退回 R4 现状）
      for (const entry of entries) kept.push(entry.path)
      continue
    }
    for (const entry of entries) {
      // 被 git 跟踪 ⇒ 这个路径的内容来自仓库（checkout / pull），不是"谁新建的"
      if (tracked.has(entry.rel)) trackedPaths.push(entry.path)
      if (tracked.has(entry.rel) && !dirty.has(entry.rel)) excluded.push(entry.path)
      else kept.push(entry.path)
    }
  }

  return { kept, excluded, tracked: trackedPaths }
}
