/**
 * 工作区 watcher（P1-9 · P0）—— 捕获**未中介写**（`bash` / 宿主手工改），补事件与版本
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 3（watcher + 事件总线）、§五 3（bash 兜底）、
 *      §十一（事件去抖 300ms 是代码常量）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"轮询 + 内容哈希"而不是 inotify
 * ─────────────────────────────────────────────────────────────────────
 * 本仓**零新增依赖**（chokidar 不在依赖里），而 Node 内置 `fs.watch` 的 `recursive` 在 Linux 上
 * 不支持、且在容器/bind mount 形态下语义不稳。P0 先用**定间隔扫描 + `size`/`mtime` 门 + 内容
 * `sha256` 判据**：门只用来"少读几份文件"，**是否变化一律由哈希决定**（mtime 不可靠 —— 同秒内
 * 多次写、`touch` 假变更都会骗过它）。P5 若引入 inotify/chokidar，替换的只是"何时触发扫描"，
 * {@link reconcileWorkspaceOnce} 的判据不变。
 *
 * ⚠️ 多机下 watcher 是**进程内**的（只装在持有该工作区的那台）⇒ 工作区 SSE 路由必须粘性
 * （§十六 A）。本文件只负责"发现变化并落事件"，不负责推送。
 */

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import type { WorkspaceActor } from '@doubulea/shared'

import { ensureWorkspace, softDeleteIndexedFile, syncFileFromDisk } from './service.js'
import { scanWorkspaceTree } from './store.js'

/** 轮询间隔（毫秒，**代码常量**）：定间隔扫描，见文件头 */
export const WORKSPACE_WATCH_POLL_MS = 1000

/** {@link reconcileWorkspaceOnce} 的结果计数（观测/验收用） */
export interface WorkspaceReconcileReport {
  conversationId: string
  /** 盘上新出现 / 变了、已写进索引的文件数（含内容没变的读-比-弃） */
  scanned: number
  /** 实际产生了事件的文件数（新/改/删） */
  changed: number
  /**
   * 依赖目录里的字节总数（P1-17b；**不进源码配额**，单独计量）。`0` = 这个工作区还没有依赖。
   * 它只做观测（"配额口径区分源码 vs 依赖"的那个"依赖"数），不参与任何闸门判定。
   */
  dependencyBytes: number
}

/**
 * 把**盘上的真实状态**对账进索引：新增 / 修改 → 补版本与事件；盘上没了 → 软删墓碑 + 事件。
 *
 * 作者身份是 `SYSTEM`（未中介写：agent 的 `bash`、宿主手工改）—— §五 3 的 bash 兜底口径。
 * 幂等：内容没变的文件不产生事件、不 bump 版本。
 */
export async function reconcileWorkspaceOnce(
  conversationId: string,
  author: { actor: WorkspaceActor; actorId?: string | null } = { actor: 'SYSTEM' },
): Promise<WorkspaceReconcileReport> {
  const handle = await ensureWorkspace(conversationId)
  const { entries: disk, dependencyBytes } = await scanWorkspaceTree(handle.rootPath)
  const diskMap = new Map(disk.map((entry) => [entry.relative, entry]))

  const rows = await getPrisma().workspaceFile.findMany({
    where: { conversationId, deletedAt: null },
    select: { path: true, size: true, updatedAt: true },
  })
  const indexMap = new Map(rows.map((row) => [row.path, row]))

  let changed = 0
  for (const entry of disk) {
    const row = indexMap.get(entry.relative)
    const sizeChanged = row === undefined || Number(row.size) !== entry.size
    const maybeStale = row === undefined || entry.mtimeMs > row.updatedAt.getTime() + 1
    // 门：大小变了 / mtime 比索引新 ⇒ 读一遍用哈希定夺；否则跳过（省 IO）
    if (!sizeChanged && !maybeStale) continue
    const result = await syncFileFromDisk(conversationId, handle.rootPath, entry.relative, author)
    if (result !== null) changed += 1
  }

  for (const row of rows) {
    if (diskMap.has(row.path)) continue
    const event = await softDeleteIndexedFile(conversationId, row.path, author)
    if (event !== null) changed += 1
  }

  return { conversationId, scanned: disk.length, changed, dependencyBytes }
}

// ───────────────────────────── watcher 生命周期（进程内） ─────────────────────────────

/** 正在被监听的会话 → 定时器（模块级单例：一个会话只能有一份，别在函数里现造） */
const timers = new Map<string, NodeJS.Timeout>()

/** 该会话是否已在监听 */
export function isWatchingWorkspace(conversationId: string): boolean {
  return timers.has(conversationId)
}

/** 当前监听的会话数（观测/退出用） */
export function workspaceWatcherCount(): number {
  return timers.size
}

/**
 * 开始监听一个会话的工作区（幂等）。第一次触达工作区（查看/编辑/派活）时调用。
 * 定时器 `unref()`：它不该拖着进程不退出（同 reaper 的纪律）。
 */
export function startWorkspaceWatcher(conversationId: string): void {
  if (timers.has(conversationId)) return
  const timer = setInterval(() => {
    void reconcileWorkspaceOnce(conversationId).catch((error: unknown) => {
      getLogger().warn({ err: error, conversationId }, '工作区对账扫描失败（下一轮重试）')
    })
  }, WORKSPACE_WATCH_POLL_MS)
  timer.unref?.()
  timers.set(conversationId, timer)
}

/** 停止监听一个会话（会话结束 / 进程收尾） */
export function stopWorkspaceWatcher(conversationId: string): void {
  const timer = timers.get(conversationId)
  if (timer === undefined) return
  clearInterval(timer)
  timers.delete(conversationId)
}

/** 停止全部监听（进程退出用） */
export function stopAllWorkspaceWatchers(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
}