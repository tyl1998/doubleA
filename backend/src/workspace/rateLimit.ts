/**
 * 工作区**写入限流**（P1-9 · P6 · R6）—— 固定窗口计数，超限抛 `BUSY`（429）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §九（配额「超限拒绝并留痕」）+ §十二 P6（硬化）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三件事，各在一处
 * ─────────────────────────────────────────────────────────────────────
 *   · **判据**（窗口起点 / 是否超限）= `quotaModel.ts`（纯函数，可在自证脚本里逐条核对）；
 *   · **计数**（`INCR`/`EXPIRE`）= 本文件（唯一 I/O；键名与 TTL 在 `infra/redis.ts`）；
 *   · **调用点** = 人侧路由（`routes/workspace.ts` 的保存 / 新建）与沙箱代理（`workspace/proxy.ts`
 *     的 `write` / `edit`）—— **只限"内容写"**，不限删 / 移 / 撤销：撤销是平台代人执行的一次
 *     补偿动作（一次可能要写回几十个文件），对它限流只会造成"半个撤销 + 报错"的更坏状态。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ Redis 挂了要**放行**（fail open），不是拒绝
 * ─────────────────────────────────────────────────────────────────────
 * 限流是**加固**（防失控），不是正确性闸门：Redis 抖动不该让一次正常的工作区保存失败。
 * 计数失败只 warn 一次并放行（同 `writeUserSnapshot` 的"缓存写失败不影响本次请求"纪律）。
 */

import { appMsg, AppError } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import {
  ensureRedisConnected,
  workspaceWriteRateKey,
  WORKSPACE_WRITE_RATE_TTL_SEC,
} from '../infra/redis.js'
import {
  isWorkspaceWriteRateExceeded,
  workspaceWriteRateWindowStart,
  WORKSPACE_WRITE_RATE_WINDOW_MS,
} from './quotaModel.js'

/**
 * 记一次写并判定是否超限；超限抛 {@link AppError.busy}（429 `BUSY`）。
 *
 * `config.workspace.writePerMin = 0` = **关闭限流**（显式口径，直接返回，不碰 Redis）。
 *
 * @throws AppError(BUSY) 本窗口内的写次数已超过 `WORKSPACE_WRITE_PER_MIN`
 */
export async function assertWorkspaceWriteRate(conversationId: string): Promise<void> {
  const limit = config.workspace.writePerMin
  if (limit <= 0) return

  const windowStart = workspaceWriteRateWindowStart(Date.now())
  const key = workspaceWriteRateKey(conversationId, windowStart)
  let count: number
  try {
    const redis = await ensureRedisConnected()
    count = await redis.incr(key)
    // 只在**本窗口第一条**上设 TTL（后续 INCR 不再续期：续期会把键拖到窗口之后，计数就串窗了）
    if (count === 1) await redis.expire(key, WORKSPACE_WRITE_RATE_TTL_SEC)
  } catch (error) {
    getLogger().warn(
      { err: error, conversationId },
      '工作区写入限流计数失败（本批放行，不因限流设施抖动影响正常写）',
    )
    return
  }

  if (isWorkspaceWriteRateExceeded(count, limit)) {
    getLogger().warn({ conversationId, count, limit }, '工作区写入超限流阈值，拒绝本次写')
    throw AppError.busy(appMsg('app.m236', { p0: limit }), {
      limit,
      windowSeconds: WORKSPACE_WRITE_RATE_WINDOW_MS / 1000,
      count,
    })
  }
}
