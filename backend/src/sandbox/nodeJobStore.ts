/**
 * 一键初始化的**任务快照**（2026-10-20 用户反馈：切页回来就看不到进度了）。
 *
 * 依据：`docs/子方案/沙箱多机部署.md`（节点自举）+ `shared/src/node.ts` 的 `NodeBootstrapJob`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须落到共享存储
 * ─────────────────────────────────────────────────────────────────────
 *   · 前端换个页面再回来，那一次 `POST` 的 `Promise` 已经没人等了 —— **进度只在后端有**；
 *   · 多机下管理页可能落到**任意一台后端**，而任务只存在于"真正执行它的那台" ⇒ 快照写进
 *     **目标实例的 Redis 键**（`node:bootstrap:job:<instanceId>:<jobId>`），任何一台都能读；
 *   · 进程重启 / 容器被杀 ⇒ 心跳（`updatedAt`）不再推进，**读的时候**按租期改判 `failed`，
 *     而不是让页面永远显示"初始化中"。
 *
 * │ 键 | 类型 | TTL |
 * │----|------|-----|
 * │ `node:bootstrap:job:<instanceId>:<jobId>` | JSON 快照 | 2h（结束后也就还能回看 2h） |
 * │ `node:bootstrap:current:<instanceId>`     | jobId  | 12h（页面进来先查"有没有在跑的"） |
 *
 * ⚠️ 写快照是**尽力而为**：Redis 抖动不能让初始化失败（它本来就是在修 Docker），
 *    所以这里只记 warn，不向上抛。
 */

import { randomBytes } from 'node:crypto'

import type {
  NodeBootstrapJob,
  NodeBootstrapResult,
  NodeBootstrapStepState,
  NodeBootstrapTaskStep,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { ensureRedisConnected } from '../infra/redis.js'

/** 快照保留时长（结束后仍能回看这么久） */
export const NODE_JOB_TTL_SEC = 2 * 3600
/** 「当前任务」指针的保留时长（页面据此发现"切页前点的那个还在跑"） */
const CURRENT_TTL_SEC = 12 * 3600
/**
 * 心跳租期：超过这么久没更新的 `running` 任务视为**已死**（执行它的进程没了）。
 * 取值要大于一次正常 `run()` 的间隔（最慢的一段是 `docker pull`，期间也有周期心跳）。
 */
export const NODE_JOB_STALE_MS = 90_000

const KEY_PREFIX = 'node:bootstrap'

function jobKey(instanceId: string, jobId: string): string {
  return `${KEY_PREFIX}:job:${instanceId}:${jobId}`
}

function currentKey(instanceId: string): string {
  return `${KEY_PREFIX}:current:${instanceId}`
}

/** 生成任务 id（`nb-` 前缀便于日志检索；时间戳在前，天然按时间排序） */
export function newNodeJobId(now: number = Date.now()): string {
  return `nb-${String(now)}-${randomBytes(3).toString('hex')}`
}

/** `ok` / `failed` / `skipped` 都算"这一步结束了" */
function isSettled(state: NodeBootstrapStepState): boolean {
  return state === 'ok' || state === 'failed' || state === 'skipped'
}

/** 按步骤状态算百分比：结束的算一整格，执行中的算半格 */
export function jobPercent(steps: readonly NodeBootstrapTaskStep[]): number {
  if (steps.length === 0) return 0
  const units = steps.reduce((sum, step) => {
    if (isSettled(step.state)) return sum + 1
    return step.state === 'running' ? sum + 0.5 : sum
  }, 0)
  return Math.min(100, Math.round((units / steps.length) * 100))
}

/**
 * 把 `running` 且心跳过期的任务改判为 `failed`（只改内存里的副本，不回写）。
 * 页面因此永远能拿到一个**确定的结局**，不必自己写超时。
 */
export function settleStaleJob(job: NodeBootstrapJob, now: number = Date.now()): NodeBootstrapJob {
  if (job.status !== 'running' || now - job.updatedAt <= NODE_JOB_STALE_MS) return job
  const message = `初始化进程已失联（${Math.round((now - job.updatedAt) / 1000)}s 没有进度）—— 通常是执行它的后端重启了，请重新点「一键初始化」`
  return {
    ...job,
    status: 'failed',
    ok: false,
    error: message,
    finishedAt: job.updatedAt,
    updatedAt: now,
    steps: job.steps.map((step) =>
      step.state === 'running' ? { ...step, state: 'failed', detail: message, finishedAt: job.updatedAt } : step,
    ),
  }
}

async function redisSafe(): Promise<Awaited<ReturnType<typeof ensureRedisConnected>> | undefined> {
  try {
    return await ensureRedisConnected()
  } catch (error) {
    getLogger().warn({ err: error }, '初始化进度写不进 Redis（不影响初始化本身）')
    return undefined
  }
}

/** 新建并落盘一个任务快照（**调用前**步骤表就要有完整计划，页面一进来就能看到全部步骤） */
export async function createJob(job: NodeBootstrapJob): Promise<void> {
  const redis = await redisSafe()
  if (redis === undefined) return
  try {
    await redis
      .multi()
      .set(jobKey(job.instanceId, job.jobId), JSON.stringify(job), 'EX', NODE_JOB_TTL_SEC)
      .set(currentKey(job.instanceId), job.jobId, 'EX', CURRENT_TTL_SEC)
      .exec()
  } catch (error) {
    getLogger().warn({ err: error, jobId: job.jobId }, '初始化进度快照写入失败')
  }
}

/** 覆盖写入一份快照（进度都在服务端的 `draft` 里推进，这里只是把它落盘） */
export async function saveJob(job: NodeBootstrapJob): Promise<void> {
  const redis = await redisSafe()
  if (redis === undefined) return
  try {
    await redis.set(jobKey(job.instanceId, job.jobId), JSON.stringify(job), 'EX', NODE_JOB_TTL_SEC)
  } catch (error) {
    getLogger().warn({ err: error, jobId: job.jobId }, '初始化进度快照写入失败')
  }
}

async function readJob(instanceId: string, jobId: string): Promise<NodeBootstrapJob | undefined> {
  const redis = await redisSafe()
  if (redis === undefined) return undefined
  try {
    const raw = await redis.get(jobKey(instanceId, jobId))
    if (raw === null) return undefined
    return settleStaleJob(JSON.parse(raw) as NodeBootstrapJob)
  } catch (error) {
    getLogger().warn({ err: error, instanceId, jobId }, '初始化进度快照读取失败')
    return undefined
  }
}

/** 按 id 取快照（找不到 / 已过期 ⇒ `undefined`） */
export function getJob(instanceId: string, jobId: string): Promise<NodeBootstrapJob | undefined> {
  return readJob(instanceId, jobId)
}

/**
 * 取**当前**任务：优先"还在跑"的那个；没有在跑的，给**最近结束**的一个（页面据此显示上一次结果）。
 * 返回 `null` = 这台实例从没在这份 Redis 里初始化过。
 */
export async function getCurrentJob(instanceId: string, preferJobId?: string): Promise<NodeBootstrapJob | null> {
  const aimed = preferJobId === undefined ? undefined : await readJob(instanceId, preferJobId)
  if (aimed !== undefined) return aimed
  const redis = await redisSafe()
  if (redis === undefined) return null
  const jobId = await redis.get(currentKey(instanceId)).catch(() => null)
  if (jobId === null || jobId === undefined) return null
  return (await readJob(instanceId, jobId)) ?? null
}

/** 把「当前任务」指针清掉（快照本身按 TTL 自然过期） */
export async function clearCurrentJob(instanceId: string): Promise<void> {
  const redis = await redisSafe()
  if (redis === undefined) return
  await redis.del(currentKey(instanceId)).catch(() => 0)
}

/** 把后端的 `NodeBootstrapResult` 收敛成任务快照的收尾字段（步骤表以服务端推进的那份为准） */
export function finishJobWith(job: NodeBootstrapJob, result: NodeBootstrapResult, now: number = Date.now()): NodeBootstrapJob {
  return {
    ...job,
    status: result.ok ? 'succeeded' : 'failed',
    ok: result.ok,
    finishedAt: now,
    updatedAt: now,
    report: result.report,
  }
}
