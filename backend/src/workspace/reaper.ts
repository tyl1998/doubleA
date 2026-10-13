/**
 * 工作区 reaper（P1-9 · P0 建；P5 · R5 补保留期清理）—— 清理工作区的唯一收口
 *
 * 依据：`docs/子方案/Code模式工作区.md` §八（生命周期：workspace reaper 按"会话是否还在/保留期"清理）、
 *      §四 4（GC：孤儿 blob 与超保留期对象由 reaper 清理）、
 *      §十三 已决 4（保留期与产物共用 `ARTIFACT_RETENTION_DAYS`，默认 7 天）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条清理，判据不同、落点一致
 * ─────────────────────────────────────────────────────────────────────
 *   · **孤儿**（{@link reapOrphanWorkspaceDirs}）：`conversations` 行没了（删会话会级联删工作区
 *     索引行），但宿主目录 / `.blobs` 还在 —— 删它**零风险**（没有任何活着的会话指向它）；
 *   · **超保留期**（{@link reapExpiredWorkspaceDirs}）：会话**仍在**，但工作区**很久没动**
 *     （`workspaces.updated_at < now - 保留期`）—— 与产物保留期共用同一个值、同一套"到期即真删"
 *     口径（已决 4：产物到期 `reapExpiredArtifacts` 删对象 + 删行 ⇒ 工作区同口径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 清 = 本地目录 + 本地历史字节 + S3 冷备 + DB 行（四层一起收）
 * ─────────────────────────────────────────────────────────────────────
 * §八 明写"本地目录 + DB 行 + S3 冷备一起收"。⚠️ **S3 对象删成功才删行**（与 `reapExpiredArtifacts`
 * 同款纪律）：冷备删失败则**保留行**、下一轮再试 —— 否则会留下"行没了、对象还在"的暗账。
 *
 * ⚠️ 单机形态下目录名 = conversationId（UUID）。非 UUID 名的目录**不是我们的**，一律跳过
 * （与沙箱"只删带 role 标签的"是同一条纪律：判据要能回答"这东西是不是我的"）。
 *
 * ⚠️ **有活体容器时不删**（{@link hasActiveSandbox}）：容器把工作区 bind mount 成 `/work`，
 * 删目录 = 把运行中的 agent 脚下的地抽掉。RUNNING 与宽限期内的 CREATING 都算"活体"。
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { clearSandboxOwner, readSandboxOwner } from '../sandbox/owner.js'
import { WORKSPACE_BLOB_DIR, workspaceBlobDirOf } from './blob.js'
import { deleteWorkspaceColdBlobs, dropPendingWorkspaceBackups } from './cold.js'
import { workspaceRetentionCutoff } from './reapModel.js'
import { stopWorkspaceWatcher } from './watcher.js'

/** 目录名必须长这样才认（= `conversations.id` 的形态） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** 保留期清理的周期（毫秒，**代码常量**）：以"天"计的保留期无需高频；启动时另跑一次兜底 */
export const WORKSPACE_REAP_INTERVAL_MS = 60 * 60 * 1000

/** 单轮最多处理的过期工作区数（防一次扫描把时间/内存打满；剩余留给下一轮） */
export const WORKSPACE_REAP_MAX_PER_TICK = 200

export interface WorkspaceReapReport {
  /** 扫描到的工作区目录数 */
  scanned: number
  /** 删掉的孤儿工作区目录数 */
  removed: number
  /** 顺带删掉的孤儿本地历史字节目录数（会话已删 / 工作区目录早已不在） */
  removedBlobDirs: number
}

/** 一次保留期清理的计数（观测 / 验收用） */
export interface WorkspaceRetentionReport {
  /** 保留期截止时刻（ISO）：`updated_at < cutoff` 即过期 */
  cutoff: string
  /** 本轮扫到的过期工作区数 */
  scanned: number
  /** 真的清掉的工作区数 */
  removed: number
  /** 因"还有活体容器"而跳过的工作区数（下一轮再判） */
  skippedActive: number
  /** 因"工作区钉在别的实例名下"而跳过的工作区数（P1-14 §十六 D：不跨机清理） */
  skippedForeign: number
  /** 清理失败、留待下一轮的工作区数 */
  failed: number
}

// 保留期判据（截止时刻 / 是否过期）在 `reapModel.ts`（纯函数，零 config 依赖）——
// 这里 import 只为就近使用，不在此重定义（自证脚本 `workspace-regression` 直接测 reapModel）。

/**
 * **彻底清掉**一个会话的工作区：本地目录 + 本地历史字节 + S3 冷备 + DB 行。幂等。
 *
 * 顺序是正确性的一部分：
 *   ① **先删 S3 冷备** —— 失败则**原样返回 `false`（什么都没动）**，下一轮再试（不留暗账）；
 *   ② 停 watcher + 丢弃去抖窗口里的冷备上行（否则目录会被对账重建、对象会被补传回来）；
 *   ③ 删本地目录 + 本地历史字节目录；
 *   ④ 删 DB 行（`workspaces` 级联 `files`/`versions`/`events`/`claims`）。
 *
 * @returns `true` = 已清干净；`false` = S3 删除失败、本轮放弃（下一轮重试）
 */
async function purgeWorkspace(conversationId: string): Promise<boolean> {
  const root = config.workspace.root
  // ① 先收 S3：失败就不动本地、不删行（"对象删成功才删行"，下一轮再试）
  const cold = await deleteWorkspaceColdBlobs(conversationId)
  if (cold.failed) return false

  // ② 停这个会话的 watcher（否则它下一秒对账会把目录重建回来、行也 upsert 回来）+ 丢弃去抖上行
  stopWorkspaceWatcher(conversationId)
  dropPendingWorkspaceBackups(conversationId)

  // ③ 本地两处：工作区目录 + 历史字节目录（都在工作区根下，不在容器 `/work` / 产物 / 树里）
  await rm(join(root, conversationId), { recursive: true, force: true })
  await rm(workspaceBlobDirOf(root, conversationId), { recursive: true, force: true })

  // ④ DB 侧（删会话已级联删这些行；这里兜一手"目录还在、行却因异常残留"）
  await getPrisma().workspace.deleteMany({ where: { conversationId } })

  // ⑤ 会话→实例目录键（P1-14 §十六 D）：工作区没了，钉机记录一起撤（只删自己名下的，见 `owner.ts`）。
  //    失败只 warn：键有 TTL 兜底，且下一轮 `purgeWorkspace` 不会再被触发（行已删）。
  await clearSandboxOwner(conversationId).catch((error: unknown) => {
    getLogger().warn({ err: error, conversationId }, '清理工作区后撤销钉机记录失败（TTL 会兜底）')
  })
  return true
}

/**
 * 删掉"会话已不存在"的工作区目录（顺带收它的本地历史字节与 S3 冷备）。幂等、失败只 warn。
 *
 * ⚠️ **不删活会话的目录** —— 保留期清理见 {@link reapExpiredWorkspaceDirs}。
 * ⚠️ 顺带扫 `{root}/.blobs` 下的**孤儿**历史字节目录（会话已删、或工作区目录早已被清，
 *    只靠上面的目录扫描漏掉的那些），补上 §四 4 说的"孤儿 blob GC"。
 */
export async function reapOrphanWorkspaceDirs(): Promise<WorkspaceReapReport> {
  const root = config.workspace.root
  const logger = getLogger()
  const report: WorkspaceReapReport = { scanned: 0, removed: 0, removedBlobDirs: 0 }

  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    // 根目录还没建（从未有会话触达工作区）⇒ 无事可做
    return report
  }

  for (const name of names) {
    if (!UUID_RE.test(name)) continue
    report.scanned += 1
    if (await conversationExists(name)) continue
    try {
      if (await purgeWorkspace(name)) {
        report.removed += 1
        logger.info({ conversationId: name }, '工作区 reaper：删掉孤儿工作区（会话已不存在）')
      }
    } catch (error) {
      logger.warn({ err: error, conversationId: name }, '工作区 reaper：删孤儿目录失败（下一轮再试）')
    }
  }

  report.removedBlobDirs = await reapOrphanWorkspaceBlobDirs(logger)
  return report
}

/** 扫 `{root}/.blobs/{conversationId}`，会话已不存在的一律收掉（返回删掉的目录数） */
async function reapOrphanWorkspaceBlobDirs(logger: ReturnType<typeof getLogger>): Promise<number> {
  const blobRoot = join(config.workspace.root, WORKSPACE_BLOB_DIR)
  let names: string[]
  try {
    names = await readdir(blobRoot)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!UUID_RE.test(name)) continue
    if (await conversationExists(name)) continue
    try {
      await rm(join(blobRoot, name), { recursive: true, force: true })
      removed += 1
      logger.info({ conversationId: name }, '工作区 reaper：删掉孤儿本地历史字节目录')
    } catch (error) {
      logger.warn({ err: error, conversationId: name }, '工作区 reaper：删孤儿历史字节目录失败（下一轮再试）')
    }
  }
  return removed
}

/**
 * **保留期清理**（P1-9 · P5 · R5）：会话仍在、但工作区**超保留期**（`workspaces.updated_at`
 * 早于 `now - config.workspace.retentionDays`）⇒ 整份收掉（本地 + 历史字节 + S3 冷备 + DB 行）。
 *
 * ⚠️ **判据是 `workspaces.updated_at`**（= 最近一次"内容事件"的时间，任何写/删/移都会
 *    `headVersion + 1` 顺带 bump 它）——**不是**会话活跃时间，也**不是**读时间：只读不写不会让它
 *    变新（读取路径刻意无副作用，见 `service#ensureWorkspace`）。
 *
 * ⚠️ **有活体容器时不删**（{@link hasActiveSandbox}）：容器正把工作区挂成 `/work`，删目录会
 *    抽掉运行中 agent 的脚下地；跳过、下一轮再判（容器空闲 2h 后由沙箱对账器回收）。
 *
 * @param options.now 注入"现在"（自证 / 测试用；缺省 = 真实时间）
 */
export async function reapExpiredWorkspaceDirs(
  options: { now?: Date } = {},
): Promise<WorkspaceRetentionReport> {
  const now = options.now ?? new Date()
  const cutoff = workspaceRetentionCutoff(now, config.workspace.retentionDays)
  const report: WorkspaceRetentionReport = {
    cutoff: cutoff.toISOString(),
    scanned: 0,
    removed: 0,
    skippedActive: 0,
    skippedForeign: 0,
    failed: 0,
  }
  const logger = getLogger()

  const expired = await getPrisma().workspace.findMany({
    where: { updatedAt: { lt: cutoff } },
    select: { conversationId: true },
    orderBy: { updatedAt: 'asc' },
    take: WORKSPACE_REAP_MAX_PER_TICK,
  })
  report.scanned = expired.length

  for (const row of expired) {
    const conversationId = row.conversationId
    try {
      // ★ P1-14 §十六 D：**只清本实例名下的工作区** —— `workspaces.updated_at` 是**全局**列，
      //   若不加这道过滤，A 会把"其实钉在 B 上"的过期工作区清掉（删了共享的 DB 行 + S3 冷备，
      //   而 B 本地目录还在 ⇒ 留下一份谁也认领不了的孤儿目录）。目录为 `undefined`（键已过期/未登记）
      //   时**按本实例处理**：单机下恒命中自己；多机下"无主"的工作区由先到者收口（幂等）。
      const owner = await readSandboxOwner(conversationId).catch(() => undefined)
      if (owner !== undefined && owner !== config.sandbox.instanceId) {
        report.skippedForeign += 1
        continue
      }
      if (await hasActiveSandbox(conversationId)) {
        report.skippedActive += 1
        continue
      }
      if (await purgeWorkspace(conversationId)) {
        report.removed += 1
        logger.info(
          { conversationId, cutoff: report.cutoff, retentionDays: config.workspace.retentionDays },
          '工作区 reaper：删掉超保留期工作区（会话仍在）',
        )
      } else {
        report.failed += 1
      }
    } catch (error) {
      report.failed += 1
      logger.warn({ err: error, conversationId }, '工作区 reaper：删超期工作区失败（下一轮再试）')
    }
  }

  if (report.scanned > 0) {
    logger.info({ ...report }, '工作区保留期清理完成')
  }
  return report
}

// ───────────────────────────── 周期任务的生命周期 ─────────────────────────────

let timer: NodeJS.Timeout | undefined
let ticking: Promise<void> | undefined

/**
 * 启动工作区保留期清理器（**在 `listen` 成功之后**调，与沙箱对账器同款纪律：进程级后台组件
 * 不放进 `buildApp()`，否则所有 `app.inject` 式的契约验收都会顺带连 PG）。
 *
 * ⚠️ 两处工程细节（与沙箱对账器一致）：
 *   · `unref()` —— 定时器不该成为"进程退不掉"的原因；
 *   · **重入保护** —— 一轮清理可能比间隔还慢，不保护就会同时跑两轮、互相把对方正在处理的行
 *     当成还在（同族：沙箱对账器的防重入）。
 *
 * @returns 真的启动了吗（重复调用返回 `false`）
 */
export function startWorkspaceReaper(): boolean {
  if (timer !== undefined) return false
  timer = setInterval(runReapTick, WORKSPACE_REAP_INTERVAL_MS)
  timer.unref?.()
  getLogger().info(
    { intervalMs: WORKSPACE_REAP_INTERVAL_MS, retentionDays: config.workspace.retentionDays },
    '工作区保留期清理器已启动',
  )
  return true
}

/** 停周期清理器，并**等在飞的那一轮收尾**（它可能正在删目录 —— 中途放手会留下半个回收态） */
export async function stopWorkspaceReaper(): Promise<void> {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  const pending = ticking
  if (pending !== undefined) {
    try {
      await pending
    } catch (error) {
      getLogger().debug({ err: error }, '等待在飞的工作区清理轮次时出错（进程正在退出，已忽略）')
    }
  }
}

function runReapTick(): void {
  if (ticking !== undefined) {
    getLogger().debug('上一轮工作区保留期清理还没跑完，跳过本轮')
    return
  }
  ticking = (async () => {
    try {
      await reapExpiredWorkspaceDirs()
    } catch (error) {
      // 一轮炸了不该让清理器停摆（下一轮继续）；但必须留 error 级痕迹
      getLogger().error({ err: error }, '工作区保留期清理出错（下一轮继续）')
    } finally {
      ticking = undefined
    }
  })()
}

// ───────────────────────────── 内部 ─────────────────────────────

/** 会话行是否还在（`true` = 活会话，孤儿判据的反面） */
async function conversationExists(conversationId: string): Promise<boolean> {
  const row = await getPrisma().conversation.findUnique({ where: { id: conversationId }, select: { id: true } })
  return row !== null
}

/**
 * 该会话是否有**活体沙箱**（`RUNNING` ∪ 宽限期内的 `CREATING`）—— 有则工作区正被容器 bind mount，
 * 不能删。这与沙箱对账器的"本轮活着的会话"同款判据（`sandbox/reaper.ts#collectLiveConversations`）。
 */
async function hasActiveSandbox(conversationId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - config.sandbox.createGraceSec * 1000)
  const row = await getPrisma().sandbox.findFirst({
    where: {
      conversationId,
      OR: [{ status: 'RUNNING' }, { status: 'CREATING', createdAt: { gte: cutoff } }],
    },
    select: { id: true },
  })
  return row !== null
}
