/**
 * 沙箱排队队列（P0-3-2）
 *
 * 依据：`docs/02-后端设计.md` §七 第 1 步（"满则 queued 排队（Redis 队列，位次可见）"）
 *      + §5.1（`queued` 事件 `{position}`，"1 = 下一个"）
 *      + `docs/子方案/沙箱与引擎集成.md` §九 2（"排队队列项也要能自愈：要 TTL + 启动时清理"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么是 **ZSET** 而不是 List（与 `pipeline/queue.ts` 刻意不同）
 * ─────────────────────────────────────────────────────────────────────
 * 流水线的 List 是"取走即出队"的生产消费队列，不需要位次、也不需要单项过期。
 * 沙箱排队要的两件事恰好都是 List 给不了的：
 *   ① **位次可见**（`queued` 事件要报 `position`，"1 = 下一个"）⇒ ZSET 的 `ZRANK` 就是它；
 *   ② **单项 TTL** ⇒ List 没有逐元素过期，而 ZSET 的 score 天然可以当时间戳
 *      （`ZREMRANGEBYSCORE -inf (now - ttl)` 一次清掉所有过期的）。
 * ⇒ **score = 入队时刻的 epoch 毫秒**，member = `conversationId`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 排队项为什么会变成孤儿，以及"谁负责清"
 * ─────────────────────────────────────────────────────────────────────
 * 一个排队项代表"某条 SSE 流正在等名额"。**流一断（用户关页面、后端重启），排队项就是孤儿** ——
 * 它对应的等待者已经不在了，但如果不清理，它会一直占着"前面还有人"的假象，
 * 让后来者**永远排在第二位**（症状：明明没人用却在排队 —— `子方案③` §九 2 的同一句话）。
 *
 * 三道防线（缺一个都会漏）：
 *   ① **等待者自己退队**：拿到名额、被取消（`AbortSignal`）时 `ZREM`；
 *   ② **TTL**：score 老过 `SANDBOX_QUEUE_TTL_SEC` 即被 prune 掉。它同时是**等待预算** ——
 *      排在队里超过这个时长的等待者会被判超时（所以两个语义共用一个数，是刻意的：
 *      一个"等了 10 分钟"的请求本来也不该再等下去）；
 *   ③ **启动时整表清空**（`clearSandboxQueue`）：后端重启后所有在等的流都没了 ⇒ 队列必须从零开始。
 *      ⚠️ 这条**只在启动时**做，不能在周期对账里做（会清掉正常运行中的排队者）。
 *
 * ⚠️ 队列键可配（`SANDBOX_QUEUE_KEY`）的理由与 `PIPELINE_QUEUE_KEY` **逐字相同**：
 * `REDIS_URL` 是共享资源，同机跑着的 dev server 会**随机抢走**另一个进程的排队项
 * ⇒ 症状不是报错而是"时好时坏"。可换键 = 可隔离消费方。
 */

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { ensureRedisConnected } from '../infra/redis.js'

/** 当前生效的队列键（`SANDBOX_QUEUE_KEY`，默认 `sandbox:queue`） */
export function sandboxQueueKey(): string {
  return config.sandbox.queueKey
}

/**
 * 入队，返回**当前位次**（1 = 下一个）。
 *
 * `ZADD … NX`：已经在队里的（同一个会话重复入队）**保留原来的 score** ⇒ 位次不变。
 * 理由：重复入队只可能来自"同一轮里重试"，而重试不该让人退到队尾 —— 那样会被无限插队。
 *
 * 走**共享连接**：`ZADD` 不阻塞，没有 `BRPOP` 那种独占问题（对比 `pipeline/queue.ts` 的文件头）。
 */
export async function enqueueSandboxQueue(conversationId: string, now: number = Date.now()): Promise<number> {
  const redis = await ensureRedisConnected()
  await redis.zadd(sandboxQueueKey(), 'NX', now, conversationId)
  const position = await sandboxQueuePosition(conversationId)
  // 刚 `ZADD` 过却查不到 ⇒ 只可能是 TTL 是 0 这种配置错误（`now - ttlMs` 落在未来）
  if (position === null) {
    throw new Error(`入队后查不到位次（队列键 ${sandboxQueueKey()}）：检查 SANDBOX_QUEUE_TTL_SEC`)
  }
  getLogger().info({ conversationId, position }, '沙箱并发已满，任务进入排队')
  return position
}

/** 位次（1 = 下一个）；不在队里返回 `null`（含"已被 TTL 清掉"这一情形） */
export async function sandboxQueuePosition(conversationId: string): Promise<number | null> {
  const redis = await ensureRedisConnected()
  const rank = await redis.zrank(sandboxQueueKey(), conversationId)
  return rank === null ? null : rank + 1
}

/** 队里还有多少人（诊断用；不含"还没被 prune 掉的过期项"的语义 —— 它就是 Redis 里的实际条目数） */
export async function sandboxQueueDepth(): Promise<number> {
  const redis = await ensureRedisConnected()
  return redis.zcard(sandboxQueueKey())
}

/**
 * 清掉所有**过期**的排队项（见文件头防线 ②）。返回清掉几条。
 * 由等待循环**每轮**调用一次 —— 它同时也是"我这个等待者是不是已经超时了"的判据
 * （自己那条被清掉 ⇒ 下一次 `sandboxQueuePosition` 返回 `null` ⇒ 判超时）。
 */
export async function pruneSandboxQueue(now: number = Date.now()): Promise<number> {
  const ttlMs = config.sandbox.queueTtlSec * 1000
  const redis = await ensureRedisConnected()
  const removed = await redis.zremrangebyscore(sandboxQueueKey(), '-inf', `(${now - ttlMs}`)
  if (removed > 0) {
    getLogger().warn(
      { removed, ttlSec: config.sandbox.queueTtlSec },
      '清理了过期的沙箱排队项（等待者多半已经不在了：流断开或进程重启）',
    )
  }
  return removed
}

/**
 * 试着认领队首。
 *
 * 只有**排在第一**的等待者才可能认领成功 ⇒ 严格 FIFO。做法刻意不用 Lua：
 *   · 先 `ZRANK` 判"是不是我"；不是直接返回 `false`；
 *   · 再 `ZREM` —— **用它的返回值当判据**：返回 0 说明我那条已经被别人清掉了
 *     （只可能是 prune 干的，即我已经超时）⇒ 这一步必须返回 `false`，
 *     否则会放行一个已经超时的等待者（它自己会在下一次 `position === null` 时发现，但那多绕一圈）。
 * 只有"自己删自己那条"这一种写者，配合 `ZREM` 的返回值，就足以保证原子性，不需要 Lua。
 */
export async function claimSandboxQueueHead(conversationId: string): Promise<boolean> {
  const redis = await ensureRedisConnected()
  const key = sandboxQueueKey()
  const rank = await redis.zrank(key, conversationId)
  if (rank !== 0) return false
  const removed = await redis.zrem(key, conversationId)
  return removed === 1
}

/**
 * 主动退队（取消 / 拿到名额后的收尾）。
 * 返回是否真的删掉了（`false` = 本来就不在，属正常情形，不当错误）。
 */
export async function leaveSandboxQueue(conversationId: string): Promise<boolean> {
  const redis = await ensureRedisConnected()
  const removed = await redis.zrem(sandboxQueueKey(), conversationId)
  return removed === 1
}

/**
 * 整表清空（**只在启动对账时调用**，见文件头防线 ③）。
 * @returns 清掉的条数（启动日志里要写出来 —— "重启后有 3 个孤儿排队项"是一条有用的现场信息）
 */
export async function clearSandboxQueue(): Promise<number> {
  const redis = await ensureRedisConnected()
  const key = sandboxQueueKey()
  const size = await redis.zcard(key)
  if (size > 0) await redis.del(key)
  return size
}
