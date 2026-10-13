/**
 * 工作区文件级软锁（claim，P1-9 · P2）—— §七 1 第 ② 层
 *
 * 依据：`docs/子方案/Code模式工作区.md` §七 1（四层防护：轮级串行 / 文件级 claim / 乐观 CAS / 三方合并）、
 *      §十一（`WORKSPACE_CLAIM_TTL_SEC` 默认 120s）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * claim 干什么、不干什么
 * ─────────────────────────────────────────────────────────────────────
 *   · **干**：让双方"知道"谁在碰哪个文件（UI 可锁 / 警示），并给"这一轮 agent 正在改 X"一个落点；
 *   · **不干**：**它不保证正确性** —— 正确性由第 ③ 层 **CAS** 兜底（杜绝静默覆盖）。claim 只是一层
 *     **协作提示**，读不到 / 过期了都不该让写入失败（TTL + 心跳防死锁）。
 * ⇒ 所以本文件只在写/读路径**尽力**登记与刷新，**取不到锁也照常写**（CAS 会拦真正的冲突）。
 *
 * ⚠️ 唯一键 `(conversationId, path, holder)`：`USER` 与 `AGENT` 可各持一份（人开着编辑器时，
 * agent 同一文件仍可登记"我在改"）。holder 只有 `USER` / `AGENT` 两种（不做跨用户协作，§七 4）。
 */

import { config } from '../config.js'
import { getPrisma } from '../infra/prisma.js'
import type { WorkspaceActor } from '@doubulea/shared'

/** 一次 claim 的形状（给 UI / 日志看的） */
export interface WorkspaceClaimInfo {
  path: string
  holder: WorkspaceActor
  holderId: string
  expiresAt: string
}

export interface ClaimWorkspaceFileInput {
  conversationId: string
  path: string
  holder: WorkspaceActor
  /** userId（USER）/ agentId（AGENT）—— claim 的持有者身份 */
  holderId: string
  /** agent 侧：哪个 turn 声明的（可空；当前沙箱代理拿不到 turnId） */
  turnId?: string | null
}

/**
 * 登记 / 续期一个文件的 claim（**upsert**：同一 `(会话, 路径, holder)` 只留一条，刷新过期时间）。
 *
 * ⚠️ 失败**不抛**（调用方在写路径上）：claim 只是协作提示，拿不到不该让写入失败（见文件头）。
 */
export async function claimWorkspaceFile(input: ClaimWorkspaceFileInput): Promise<WorkspaceClaimInfo | null> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + config.workspace.claimTtlSec * 1000)
  try {
    const row = await getPrisma().workspaceClaim.upsert({
      where: {
        conversationId_path_holder: {
          conversationId: input.conversationId,
          path: input.path,
          holder: input.holder,
        },
      },
      create: {
        conversationId: input.conversationId,
        path: input.path,
        holder: input.holder,
        holderId: input.holderId,
        turnId: input.turnId ?? null,
        expiresAt,
        heartbeatAt: now,
      },
      update: { holderId: input.holderId, turnId: input.turnId ?? null, expiresAt, heartbeatAt: now },
      select: { path: true, holder: true, holderId: true, expiresAt: true },
    })
    return { path: row.path, holder: row.holder, holderId: row.holderId, expiresAt: row.expiresAt.toISOString() }
  } catch {
    return null
  }
}

/** 释放一个 claim（写成功后调用；不存在视为成功） */
export async function releaseWorkspaceFile(
  conversationId: string,
  path: string,
  holder: WorkspaceActor,
): Promise<boolean> {
  try {
    const deleted = await getPrisma().workspaceClaim.deleteMany({ where: { conversationId, path, holder } })
    return deleted.count > 0
  } catch {
    return false
  }
}

/** 列出一个会话当前**未过期**的 claim（UI 锁标记用） */
export async function listWorkspaceClaims(conversationId: string): Promise<WorkspaceClaimInfo[]> {
  const rows = await getPrisma().workspaceClaim.findMany({
    where: { conversationId, expiresAt: { gt: new Date() } },
    orderBy: { path: 'asc' },
    select: { path: true, holder: true, holderId: true, expiresAt: true },
  })
  return rows.map((row) => ({
    path: row.path,
    holder: row.holder,
    holderId: row.holderId,
    expiresAt: row.expiresAt.toISOString(),
  }))
}

/**
 * 清理过期 claim（周期任务 / 惰性调用）。**无 `conversationId` 时清全表**（reaper 用）。
 * @returns 删掉的行数
 */
export async function pruneExpiredWorkspaceClaims(conversationId?: string): Promise<number> {
  const deleted = await getPrisma().workspaceClaim.deleteMany({
    where: { expiresAt: { lt: new Date() }, ...(conversationId === undefined ? {} : { conversationId }) },
  })
  return deleted.count
}