/**
 * 工作区**轮次标记**（P1-9 · P4 · R2）—— 记录"本轮从何时起、到何时止"
 *
 * 依据：`docs/子方案/Code模式工作区.md` §七 5（"轮级变更集：每轮 agent 开始时记录 {path → beforeVersion}"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须是"起 + 止"两个标记，而不是只记起点
 * ─────────────────────────────────────────────────────────────────────
 * 只记起点，"轮末之后、下一次派活之前"的人为改动也会落进 `[起点, now]` 窗口 —— 撤销会把它们
 * 一起抹掉。记上终点后，窗口 = `[起点, 终点]`，"本轮"的边界就是确定的了。
 *
 * ⚠️ **失败只 warn、不抛**：标记是「撤销本轮」的元数据，写不进去顶多让这次撤销退回"显式传窗口"
 *    或不可用；绝不该让一轮派活因为一个 Redis 写失败而失败（与工作区其它旁路同款纪律）。
 */

import { getLogger } from '../infra/logger.js'
import {
  getRedis,
  WORKSPACE_ROUND_TTL_SEC,
  workspaceRoundEndKey,
  workspaceRoundStartKey,
} from '../infra/redis.js'

/** 一次轮次的窗口（ISO 8601；缺失的一侧由调用方退化处理） */
export interface WorkspaceRoundWindow {
  start?: string
  end?: string
}

/**
 * 记录本轮**起点**（TaskAgent 派活前调一次）。
 * 同时清掉上一轮的**终点** —— 否则新窗口会误带上"上一轮的终点"作右界。
 */
export async function recordWorkspaceRoundStart(conversationId: string, at: Date = new Date()): Promise<void> {
  try {
    const redis = getRedis()
    await redis.set(workspaceRoundStartKey(conversationId), at.toISOString(), 'EX', WORKSPACE_ROUND_TTL_SEC)
    await redis.del(workspaceRoundEndKey(conversationId))
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '记录工作区轮次起点失败（本轮将不能整体撤销）')
  }
}

/** 记录本轮**终点**（TaskAgent 收尾时调一次；含异常/中断的轮） */
export async function recordWorkspaceRoundEnd(conversationId: string, at: Date = new Date()): Promise<void> {
  try {
    await getRedis().set(workspaceRoundEndKey(conversationId), at.toISOString(), 'EX', WORKSPACE_ROUND_TTL_SEC)
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '记录工作区轮次终点失败（撤销窗口将退化到"此刻"）')
  }
}

/** 读本轮窗口（起点缺失 = 从未记录过一轮；任一侧读失败按缺失处理） */
export async function readWorkspaceRoundWindow(conversationId: string): Promise<WorkspaceRoundWindow> {
  try {
    const redis = getRedis()
    const [start, end] = await Promise.all([
      redis.get(workspaceRoundStartKey(conversationId)),
      redis.get(workspaceRoundEndKey(conversationId)),
    ])
    return { ...(start === null ? {} : { start }), ...(end === null ? {} : { end }) }
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '读工作区轮次标记失败（撤销本轮不可用）')
    return {}
  }
}
