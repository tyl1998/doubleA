/**
 * 流水线队列（P0-1-17）
 *
 * 依据：`docs/子方案/知识库流水线.md` §十（异步队列与并发）、§三（流程总览 ① 入队 / ② 消费）、
 *      `docs/02-后端设计.md` §二（"仅文档流水线 worker 作为进程内异步任务，Redis 队列驱动"）
 *
 * 本模块**只有队列这件事**：投递、取件、看长度、收连接。消费策略（并发、幂等、状态机写入）
 * 在 `worker.ts`；"job 代表什么"在 `stages.ts`。这样 P0-1-19 的整库重建（`mode: REBUILD`）
 * 只需要多一个生产者，不必碰这里的任何一行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ List 队列**不保证送达** —— 这就是"必须有重试入口"的原因
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §十 已定案用 List（无多消费者组需求、不依赖 ack 语义），本批把它的**后果**钉在注释里：
 * `BRPOP` 是"取走即出队"，worker 拿到 job 之后崩溃 ⇒ 这个 job 已经不在队列里，也没有任何地方
 * 记得它 —— 队列**不保证送达**。所以"能重新投递"不是锦上添花：P0-1-19 的 `POST .../retry`
 * 是这条流水线的**必需件**，不是可选项（`docs/06` P0-1-17 的坑预判）。
 * 本批能证的最近一步是"**重投同一个 job 能把 FAILED 救回来**"（worker 的判定表里
 * `FAILED → PARSING` 是合法转换），验收里有一条正是它。
 *
 * ─────────────────────────────────────────────────────────────────────
 * job 的形状：`子方案①` §三 的 `{docId, kbId, mode}` + **contentHash**
 * ─────────────────────────────────────────────────────────────────────
 * §三 的幂等规则写的是"取到 job 先校验 `documents.status`；**若已是 READY 且 content_hash 未变** → 跳过"。
 * 要让这句话可执行，job 里就必须带**投递时刻**的 `contentHash`：不带的话 worker 手里只有一个
 * 当前值，无从判断"变过没有"。故本批在 §三 的三字段之外加了 `contentHash`，并回写文档与 `06`。
 * 它同时是覆盖重建（P0-1-19）判"这个 job 已过期"的依据：同文档重传后 hash 变了，
 * 队列里那个旧 job 必须**被忽略**，而不是把新内容按旧任务再算一遍。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 阻塞读走**独立连接**（本模块唯一"看起来多余"的一处）
 * ─────────────────────────────────────────────────────────────────────
 * `BRPOP` 在返回之前会**占住整条连接**（ioredis 不会在同一条连接上再发别的命令）。
 * 复用 `getRedis()` 那个会话单例的后果是：队列一空闲，`/api/auth`、`/health` 以及所有会话读写
 * 全跟着卡在队列上 —— 而且**只在队列空闲时**才明显（有 job 时 BRPOP 立刻返回，看起来一切正常），
 * 是最难联想的一类症状。故取件走 `createRedisConnection()` 的专线（见 `infra/redis.ts`），
 * 收尾由 {@link closePipelineQueue} 负责（它**不受** `closeRedis()` 管理）。
 */

import type { Redis } from 'ioredis'
import { z } from 'zod'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { createRedisConnection, ensureRedisConnected } from '../infra/redis.js'

/** 任务类型（`子方案①` §三 / §十：`NEW` = 新文档入库；`REBUILD` = 覆盖重建或整库重建） */
export const PIPELINE_JOB_MODES = ['NEW', 'REBUILD'] as const
export type PipelineJobMode = (typeof PIPELINE_JOB_MODES)[number]

/**
 * 流水线任务。
 * · `docId` 是**唯一**要处理的对象（`子方案①` §十：1 个 job = 1 个文档，含全部 chunk）
 * · `kbId` 冗余带上：worker 要读该库的分块/检索参数，且日志里"哪个库的哪个文档"最有用
 * · `contentHash` 见文件头（幂等与"job 是否过期"都靠它）
 * · `mode` 目前只由上传产出 `NEW`（`REBUILD` 是 P0-1-19 的 reupload 与 P1 的整库重建）
 */
export interface PipelineJob {
  docId: string
  kbId: string
  contentHash: string
  mode: PipelineJobMode
}

/**
 * 队列里每一项都要过这个 schema（**生产端与消费端是同一个**）。
 * 为什么生产端也校验：`contentHash` 传错（比如误传了文件名或 base64）在队列层面看不出来，
 * 只会在 worker 里表现为"每个 job 都被判成过期"这种极难查的现象，宁可在这里响亮地失败。
 */
export const pipelineJobSchema = z.object({
  docId: z.string().uuid('docId 必须是 UUID'),
  kbId: z.string().uuid('kbId 必须是 UUID'),
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u, 'contentHash 应是 sha256 的十六进制（64 个小写字符）'),
  mode: z.enum(PIPELINE_JOB_MODES),
})

/** 当前生效的队列键（`PIPELINE_QUEUE_KEY`，默认 `pipeline:jobs`；可换键 = 可隔离消费方） */
export function pipelineQueueKey(): string {
  return config.pipeline.queueKey
}

/** 编码成队列里的一行（**先校验再编码**，见 {@link pipelineJobSchema} 注释） */
export function encodePipelineJob(job: PipelineJob): string {
  return JSON.stringify(pipelineJobSchema.parse(job))
}

/**
 * 解析队列里的一行；结构不符返回 `undefined`（**不抛**）。
 * 队列是"外部输入"（值可能是旧版本代码写的、也可能被人手工 `RPUSH` 过），
 * 一条垃圾**不该让 worker 崩掉** —— 丢掉它、告警、继续消费才是对的。
 */
export function parsePipelineJob(raw: string): PipelineJob | undefined {
  try {
    const parsed = pipelineJobSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * 入队（`LPUSH`）。返回入队后的队列长度（顺带当"投递成功"的证据）。
 *
 * 走**共享连接**：`LPUSH` 不阻塞，没有 {@link dequeuePipelineJob} 那种独占问题。
 * @throws 连接不可用时向上抛 —— 上传路径必须知道"没投进去"（否则留下一行永不被处理的文档）
 */
export async function enqueuePipelineJob(job: PipelineJob): Promise<number> {
  const payload = encodePipelineJob(job)
  const redis = await ensureRedisConnected()
  const depth = await redis.lpush(pipelineQueueKey(), payload)
  getLogger().info({ job, depth }, '流水线任务已入队')
  return depth
}

/**
 * 取件超时（秒）。取一个**有限**值而不是 0（永久阻塞）的理由：
 * worker 的停止流程要能在秒级收口（`BRPOP` 到期即返回，循环发现 `running=false` 就退出）；
 * 0 的话就只能靠"断开连接"来打断，退出路径更难看清。
 * 代价是空闲时每 5 秒一次 BRPOP —— 对 Redis 而言可忽略。
 */
export const DEQUEUE_TIMEOUT_SEC = 5

/** 阻塞读专用的连接（懒建；见文件头"阻塞读走独立连接"） */
let blocking: Redis | undefined

function blockingConnection(): Redis {
  blocking ??= createRedisConnection('pipeline-queue')
  return blocking
}

/**
 * 取件（`BRPOP`，**阻塞**）。
 * @param timeoutSec 空队列时的等待上限（默认 {@link DEQUEUE_TIMEOUT_SEC}）
 * @returns 可用的 job；**超时**或**取到的是一条垃圾**都返回 `undefined`
 *          （两者对调用方是同一件事："这一轮没活干"；垃圾那条会打 warn 便于事后追）
 * @throws 连接被关闭/不可用 —— 停止流程正是靠 `disconnect()` 触发它来**打断**阻塞
 */
export async function dequeuePipelineJob(timeoutSec: number = DEQUEUE_TIMEOUT_SEC): Promise<PipelineJob | undefined> {
  const redis = await ensureRedisConnected(blockingConnection())
  const popped = await redis.brpop(pipelineQueueKey(), timeoutSec)
  if (popped === null) return undefined
  const job = parsePipelineJob(popped[1])
  if (job === undefined) {
    getLogger().warn({ raw: popped[1] }, '队列里的一条任务不是合法 job，已丢弃（不影响后续消费）')
  }
  return job
}

/** 当前队列长度（`LLEN`）。走共享连接；给 `/health` 类观测与验收脚本用 */
export async function pipelineQueueDepth(): Promise<number> {
  const redis = await ensureRedisConnected()
  return redis.llen(pipelineQueueKey())
}

/**
 * 关闭阻塞读连接（worker 停止时调用）。
 *
 * ⚠️ 刻意用 `disconnect()` 而不是 `quit()`：`quit` 要等服务端确认，而我们调用它的时机恰恰是
 * **BRPOP 还挂在那里**的时候 —— 它会一直等下去（症状：优雅退出卡满整个兜底时限）。
 * `disconnect()` 立刻断链，挂起的 `BRPOP` 随即以"连接已关闭"失败，循环这边按 `running=false`
 * 直接收口（见 `worker.ts`）。Redis 侧不会因此留下任何不一致：队列数据与连接无关，
 * 没被取走的 job 还在 List 里。
 */
export async function closePipelineQueue(): Promise<void> {
  const current = blocking
  blocking = undefined
  if (current === undefined) return
  try {
    current.disconnect()
  } catch (error) {
    getLogger().debug({ err: error }, '关闭队列阻塞连接时出错（已忽略：进程正在退出）')
  }
}
