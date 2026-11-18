/**
 * Skill 宿主副本的 reaper（P1-24b-1）
 *
 * 依据：`docs/子方案/Skill能力.md` §3.2「清理」—— **跟随工作区保留期，但独立 reaper**：
 *      判据 `conversation.updatedAt < now − 保留期` → 停容器 → 删目录。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不塞进 `reapExpiredWorkspaceDirs`
 * ─────────────────────────────────────────────────────────────────────
 * 那个清理是 **`workspaces` 表行驱动**的（"哪一行超期了就清哪一个工作区"）。Skill 宿主副本**没有
 * 对应的表行** —— 它只是 `{SKILL_RUNTIME_ROOT}/{conversationId}` 一个目录。混进那条清理里会让
 * "没有工作区的会话"（从未进过 Code 模式）**永远漏清**；反过来，把 Skill 目录挂到工作区行上又会
 * 让"工作区还在、绑定已空"的会话白留一份副本。
 *
 * 所以这里按**会话本身**判：`conversations.updated_at`（任何消息 / 运行时会 / code 模式切换都会推进它）
 * 早于 `now − retentionDays` ⇒ 视为"这个会话很久没动" ⇒ 停容器 + 删副本。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条纪律（与工作区 reaper 同款）
 * ─────────────────────────────────────────────────────────────────────
 * ① **有活体容器时不删**（`RUNNING` ∪ 宽限期内的 `CREATING`）：容器把副本只读挂进 `$HOME/.skills`，
 *    删目录 = 把运行中 agent 脚下的地抽掉（它下一句 `load_skill` 就读不到）。
 * ② **只清本实例名下的会话**（`readSandboxOwner`）：多机下 A 删了 B 的副本目录毫无意义（目录在 B 的盘上）；
 *    目录为 `undefined`（键过期 / 未登记）时按本实例处理 —— 单机下恒命中自己。
 * ③ **删目录前先停容器**（§3.2 原文的顺序）：容器还活着时删目录会让它读到空目录（模型看到 0 个 Skill）。
 * ④ **失败只 warn、下一轮再试**：副本是可再生的（下一轮派活会按 S3 rehydrate），不该让清理器停摆。
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../../config.js'
import { getLogger } from '../../infra/logger.js'
import { getPrisma } from '../../infra/prisma.js'
import { workspaceRetentionCutoff } from '../../workspace/reapModel.js'
import { readSandboxOwner } from '../owner.js'
import { recycleSandbox } from '../manager.js'

/** 目录名必须长这样才认（= `conversations.id` 的形态） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * 清理间隔（毫秒，**代码常量**）。保留期以"天"计 ⇒ 每小时兜一轮与工作区同款；
 * 启动时另跑一次（`index.ts`），换机 / 长期停机后回来能立刻收一遍孤儿副本。
 */
export const SKILL_REAP_INTERVAL_MS = 60 * 60 * 1000

/** 单轮最多处理的会话数（防一次扫描把时间/内存打满；剩余留给下一轮） */
export const SKILL_REAP_MAX_PER_TICK = 200

/** 一次清理的计数（观测 / 验收用） */
export interface SkillReapReport {
  /** 保留期截止时刻（ISO）：`updated_at < cutoff` 即过期 */
  cutoff: string
  /** 本轮扫到的过期会话数 */
  scanned: number
  /** 真的清掉的副本目录数 */
  removed: number
  /** 因"还有活体容器"而跳过（下一轮再判） */
  skippedActive: number
  /** 因"会话钉在别的实例名下"而跳过（多机：不跨机清理） */
  skippedForeign: number
  /** 清理失败、留待下一轮的 */
  failed: number
}

/**
 * **保留期清理**：会话仍在、但很久没动（`conversations.updated_at < now − retentionDays`）
 * ⇒ 停容器 + 删宿主副本目录。
 *
 * @param options.now 注入"现在"（自证 / 测试用；缺省 = 真实时间）
 */
export async function reapExpiredSkillRuntimeDirs(options: { now?: Date } = {}): Promise<SkillReapReport> {
  const now = options.now ?? new Date()
  const cutoff = workspaceRetentionCutoff(now, config.workspace.retentionDays)
  const report: SkillReapReport = {
    cutoff: cutoff.toISOString(),
    scanned: 0,
    removed: 0,
    skippedActive: 0,
    skippedForeign: 0,
    failed: 0,
  }
  const logger = getLogger()

  const expired = await getPrisma().conversation.findMany({
    where: { updatedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: SKILL_REAP_MAX_PER_TICK,
  })
  report.scanned = expired.length

  for (const row of expired) {
    const conversationId = row.id
    try {
      const owner = await readSandboxOwner(conversationId).catch(() => undefined)
      if (owner !== undefined && owner !== config.sandbox.instanceId) {
        report.skippedForeign += 1
        continue
      }
      if (await hasActiveSandbox(conversationId)) {
        report.skippedActive += 1
        continue
      }
      // ③ 先停容器（幂等；本实例没建过它时 `recycleSandbox` 内部直接返回 false）
      await recycleSandbox(conversationId, 'skill-runtime-expired').catch((error: unknown) => {
        logger.warn({ err: error, conversationId }, 'Skill reaper：停容器失败（仍继续删副本，下一轮重试）')
      })
      await rm(join(config.skill.runtimeRoot, conversationId), { recursive: true, force: true })
      report.removed += 1
      logger.info(
        { conversationId, cutoff: report.cutoff, retentionDays: config.workspace.retentionDays },
        'Skill reaper：删掉超保留期的宿主副本（会话仍在）',
      )
    } catch (error) {
      report.failed += 1
      logger.warn({ err: error, conversationId }, 'Skill reaper：删副本失败（下一轮再试）')
    }
  }

  if (report.scanned > 0) logger.info({ ...report }, 'Skill 宿主副本保留期清理完成')
  return report
}

/**
 * 删掉"会话已不存在"的副本目录（删会话会级联删 `sandboxes`，但宿主目录不会自己消失）。
 *
 * ⚠️ 判据是**目录名是不是一个 UUID** ∩ **会话行还在不在**；非 UUID 名（手工放的、别的系统的）一律跳过
 * —— 与沙箱"只删带 role 标签的"是同一条纪律：判据要能回答"这东西是不是我的"。
 *
 * @returns 删掉的目录数
 */
export async function reapOrphanSkillRuntimeDirs(): Promise<number> {
  const root = config.skill.runtimeRoot
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    // 根目录还没建（从未有会话触达 Skill）⇒ 无事可做
    return 0
  }
  const logger = getLogger()
  let removed = 0
  for (const name of names) {
    if (!UUID_RE.test(name)) continue
    const exists = await getPrisma().conversation.findUnique({ where: { id: name }, select: { id: true } })
    if (exists !== null) continue
    try {
      await rm(join(root, name), { recursive: true, force: true })
      removed += 1
      logger.info({ conversationId: name }, 'Skill reaper：删掉孤儿宿主副本（会话已不存在）')
    } catch (error) {
      logger.warn({ err: error, conversationId: name }, 'Skill reaper：删孤儿副本失败（下一轮再试）')
    }
  }
  return removed
}

// ───────────────────────────── 周期任务的生命周期 ─────────────────────────────

let timer: NodeJS.Timeout | undefined
let ticking: Promise<void> | undefined

/**
 * 启动 Skill 副本保留期清理器（**在 `listen` 成功之后**调，与工作区 / 沙箱对账器同款纪律：
 * 进程级后台组件不放进 `buildApp()`，否则所有 `app.inject` 式验收都会顺带连 PG）。
 *
 * @returns 真的启动了吗（重复调用返回 `false`）
 */
export function startSkillReaper(): boolean {
  if (timer !== undefined) return false
  timer = setInterval(runReapTick, SKILL_REAP_INTERVAL_MS)
  timer.unref?.()
  getLogger().info(
    { intervalMs: SKILL_REAP_INTERVAL_MS, retentionDays: config.workspace.retentionDays, root: config.skill.runtimeRoot },
    'Skill 宿主副本清理器已启动',
  )
  return true
}

/** 停周期清理器，并**等在飞的那一轮收尾** */
export async function stopSkillReaper(): Promise<void> {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  const pending = ticking
  if (pending !== undefined) {
    try {
      await pending
    } catch (error) {
      getLogger().debug({ err: error }, '等待在飞的 Skill 副本清理轮次时出错（进程正在退出，已忽略）')
    }
  }
}

function runReapTick(): void {
  if (ticking !== undefined) {
    getLogger().debug('上一轮 Skill 副本清理还没跑完，跳过本轮')
    return
  }
  ticking = (async () => {
    try {
      await reapExpiredSkillRuntimeDirs()
    } catch (error) {
      getLogger().error({ err: error }, 'Skill 副本保留期清理出错（下一轮继续）')
    } finally {
      ticking = undefined
    }
  })()
}

/**
 * 该会话是否有**活体沙箱**（`RUNNING` ∪ 宽限期内的 `CREATING`）—— 有则副本正被容器只读挂载，不能删。
 * 与 `workspace/reaper.ts#hasActiveSandbox` 同一条判据。
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
