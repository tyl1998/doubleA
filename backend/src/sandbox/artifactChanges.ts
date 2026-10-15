/**
 * 产物路径判据（P1-9 · R4）—— 「本轮工作区变更集」→「可上传的产物路径」
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 6（**产物 = 工作区变更集视图**，非目录树快照）、
 *      §十三 已决 6（`git clone` 等初始填充不算产物）+ §七 5（轮末变更集 = `shared#foldWorkspaceEvents`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件是**纯函数**：零 config / DB / Docker 依赖
 * ─────────────────────────────────────────────────────────────────────
 * 「收产物」的 I/O 部分（读字节 → 传对象 → 建行）在 `artifacts.ts`；本文件只回答"哪些路径算产物"，
 * 于是可以在 `scripts/workspace-regression.ts` 里被逐条核对（同 `workspace/paths.ts` 的切分纪律）。
 *
 * ⚠️ **判据从"快照 diff"改成"工作区变更集"**（P0-3-7 的骨架不动，只换判据）：
 *   · P0-3-7 是"派活前拍 `/work` 快照（size+mtime），收尾对照取本轮新出现/修改的"；
 *   · R4 换成"取本轮工作区事件（`workspace_events`），按路径折叠成变更集"—— 单一真相是工作区
 *     （§二），产物只是它的**交付视图**。
 */

import { WORKSPACE_CONTENT_EVENT_TYPES, type WorkspaceChangeEntry } from '@doubulea/shared'

import { WORKSPACE_DEPENDENCY_DIRS } from '../workspace/dependencyModel.js'

/**
 * 扫描排除的**顶层相对目录**（`子方案③` §十一 2 的"引擎自身的工作文件"名单）。
 *
 * ⚠️ **名单的唯一定义搬到了 `workspace/dependencyModel.ts`**（P1-17b）：依赖目录不仅要"不进产物"，
 * 还要"不进索引 / 不进冷备 / 不算源码配额 / 不让中介写进去" —— 五个消费方**必须同一份名单**，
 * 否则会出现"产物里没有 node_modules，但配额/冷备里却有"。这里只是给它一个**产物侧的名字**。
 * ⚠️ 隐藏目录（`.` 开头）由那条通用规则单独覆盖、不进本名单（两套规则混写就会出现"删了规则忘了名单"的分叉）。
 */
export const ARTIFACT_EXCLUDED_DIRS: readonly string[] = WORKSPACE_DEPENDENCY_DIRS

/** 过滤的入参（`excludedDirs` / `maxFiles` 由调用方从 config 取，保持本模块零 config 依赖） */
export interface ArtifactPathFilterOptions {
  /** 排除的顶层目录名（显式名单；见 {@link ARTIFACT_EXCLUDED_DIRS}） */
  excludedDirs: readonly string[]
  /** 单轮路径数上限（超出即截断；防引擎写一万个小文件打爆上传） */
  maxFiles: number
  /** 截断留痕（不静默丢）：调用方传日志；回归脚本可省略 */
  onTruncate?: (accepted: number, kept: number, maxFiles: number) => void
}

/**
 * 过滤规则（`子方案③` §十一 2，全部带日志）。
 *
 *   · 隐藏文件 / 目录（路径里**任一段**以 `.` 开头）⇒ 跳过（`.git/`、Pi 的 `.pi`、记忆文档
 *     `.doubulea/` 全在这一条里 —— 正是"`.git` 属工作区内容但**不进产物**"的落实）；
 *   · `excludedDirs`（引擎/依赖工作目录）⇒ 跳过；
 *   · 数量超 `maxFiles` ⇒ 截断 + 留痕（防引擎写一万个小文件打爆上传）；
 *   · 结果按路径排序（顺序稳定 ⇒ 截断与日志在两次运行之间可比较）。
 *
 * ⚠️ 单文件**大小**不在这里判（依赖读到的实际字节，统一挪到 `collectRoundArtifacts` 一处判）。
 */
export function filterArtifactPaths(paths: readonly string[], options: ArtifactPathFilterOptions): string[] {
  const accepted: string[] = []
  for (const path of paths) {
    // ① 隐藏文件 / 隐藏目录：路径里**任一段**以 `.` 开头都算（`out/.hidden` 与 `.cache/x` 同罪）
    if (path.split('/').some((segment) => segment.startsWith('.'))) continue
    // ② 引擎/依赖工作目录（顶层相对名，见 ARTIFACT_EXCLUDED_DIRS 的说明）
    const head = path.split('/')[0] ?? ''
    if (options.excludedDirs.includes(head)) continue
    accepted.push(path)
  }
  const limited = accepted.slice(0, options.maxFiles)
  if (limited.length < accepted.length) {
    options.onTruncate?.(accepted.length, limited.length, options.maxFiles)
  }
  limited.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return limited
}

/**
 * 工作区变更集 → 可上传的产物路径（**R4 的核心判据**）。
 *
 * 折叠口径见 `shared#foldWorkspaceEvents`（同一路径只留窗口内最后一条）。此处只做筛选：
 *   · 只认**内容事件**（`created`/`updated`/`renamed`）—— `claim`/`release` 不改字节，丢弃；
 *   · `deleted` 丢弃（本轮删掉的东西无处交付）；
 *   · `renamed` 保留（`path` 记的是**新路径**，文件此刻就在那儿）；
 *   · 其余交给 {@link filterArtifactPaths}（隐藏 / `excludedDirs` / 截断 / 排序）。
 */
export function artifactChangePaths(
  changes: readonly WorkspaceChangeEntry[],
  options: ArtifactPathFilterOptions,
): string[] {
  const paths: string[] = []
  for (const change of changes) {
    if (change.type === 'deleted') continue
    if (!(WORKSPACE_CONTENT_EVENT_TYPES as readonly string[]).includes(change.type)) continue
    paths.push(change.path)
  }
  return filterArtifactPaths(paths, options)
}
