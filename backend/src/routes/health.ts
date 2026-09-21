/**
 * 健康检查路由（P0-1-4）
 *
 * 依据：`docs/02-后端设计.md` §4.9（`GET /health` 探 PG/Redis/S3）+ §十三（可观测）
 *
 * 三条设计决定（都不是随手选的）：
 *
 * 1. **HTTP 恒 200，依赖状态放在 body 里**（`data.status = ok | degraded`）。
 *    理由：探活端点自身是「请求成功」——它确实给出了结论；把某个依赖抖动直接映射成 5xx 会让
 *    网关/负载均衡把**整个后端**摘掉（本机只停 redis 时后端其实还能服务大部分接口）。
 *    验收口径（`06` P0-1-4）也只要求「明确报 redis 不可用，不是整体 500」。
 *    若将来上 k8s 需要 status code 形式的 readiness，另加 `/health/ready`（返回 503）更清楚，
 *    不把两种语义塞进同一个端点。
 * 2. **每项探活都不外抛**：单项失败只降级为 `ok:false` + 原因，整体仍是一个正常响应。
 * 3. **每项都有超时**（`HEALTH_TIMEOUT_MS`，默认 2s）：坑预判点名「不能因 PG 挂起而永远不返回」。
 *    超时是 Promise 级的兜底；各客户端自己也有建连/查询超时（`infra/pg.ts`、`infra/redis.ts`）。
 */

import { ok, type SuccessEnvelope } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { config } from '../config.js'
import { getLogger, SERVICE_NAME, SERVICE_VERSION } from '../infra/logger.js'
import { pingPg } from '../infra/pg.js'
import { pingRedis } from '../infra/redis.js'
import { pingS3 } from '../infra/s3.js'

/** 被探活的依赖（顺序即响应里的顺序） */
export const HEALTH_TARGETS = ['postgres', 'redis', 's3'] as const
export type HealthTarget = (typeof HEALTH_TARGETS)[number]

/** 单项探活结论 */
export interface HealthCheck {
  target: HealthTarget
  ok: boolean
  latencyMs: number
  /** 成功时是「探到了什么」，失败时是失败原因（已收敛为单行、不含堆栈） */
  detail: string
}

/** `/health` 响应体（信封的 `data`） */
export interface HealthReport {
  status: 'ok' | 'degraded'
  service: string
  version: string
  env: string
  port: number
  /** 进程已运行秒数（重启排查时一眼看得出） */
  uptimeSec: number
  /** 本次检查时刻（ISO 8601） */
  checkedAt: string
  /** 单项探活超时预算（毫秒）——出现「超时」类 detail 时可直接对照 */
  timeoutMs: number
  checks: HealthCheck[]
}

/** 进程启动时刻（模块求值即记录，`uptimeSec` 的来源） */
const PROCESS_STARTED_AT = Date.now()

/** 给任意 Promise 套一层超时（兜底用；客户端自身的超时是主防线） */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, target: HealthTarget): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${target} 探活超时（超过 ${timeoutMs}ms 未返回）`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** 错误 → 单行原因（带上 errno 之类的 code，`ECONNREFUSED` 比 message 更有辨识度） */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code
  return code === undefined || code === '' ? error.message : `${error.message}（${code}）`
}

/** 跑一项探活：**永不抛**，失败也是结论 */
async function runCheck(
  target: HealthTarget,
  probe: () => Promise<string>,
  timeoutMs: number,
): Promise<HealthCheck> {
  const startedAt = Date.now()
  try {
    const detail = await withTimeout(probe(), timeoutMs, target)
    return { target, ok: true, latencyMs: Date.now() - startedAt, detail }
  } catch (error) {
    return { target, ok: false, latencyMs: Date.now() - startedAt, detail: describeError(error) }
  }
}

/** 注册 `/health`（在 app.ts 中于错误处理之后、业务路由之前） */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    '/health',
    // 探活会被网关/监控频繁打点，没必要按 info 记满 access log；
    // 降级时由下面显式的 warn 报出来（`logLevel: 'warn'` 只放行 warn 及以上）
    { logLevel: 'warn' },
    async (): Promise<SuccessEnvelope<HealthReport>> => {
      const timeoutMs = config.limits.healthProbeTimeoutMs

      // 三项并行探活（串行会让总耗时变成三个超时之和）
      const checks = await Promise.all([
        runCheck('postgres', async () => {
          const { database, version } = await pingPg()
          return `${database} @ ${version}`
        }, timeoutMs),
        runCheck('redis', async () => {
          await pingRedis()
          return 'PING → PONG'
        }, timeoutMs),
        runCheck('s3', async () => {
          const { bucket, bucketExists } = await pingS3()
          return bucketExists ? `桶 ${bucket} 存在` : `桶 ${bucket} 尚不存在（首次上传时创建）`
        }, timeoutMs),
      ])

      const degraded = checks.filter((check) => !check.ok)
      const report: HealthReport = {
        status: degraded.length === 0 ? 'ok' : 'degraded',
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        env: config.nodeEnv,
        port: config.port,
        uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
        checkedAt: new Date().toISOString(),
        timeoutMs,
        checks,
      }

      if (degraded.length > 0) {
        // 依赖不可用是「需要人看」的事：走 warn，且带上每项的原因（含 requestId，见 ALS 上下文）
        getLogger().warn(
          { degraded: degraded.map((check) => `${check.target}: ${check.detail}`) },
          `依赖探活未通过（${degraded.length}/${checks.length}）：${degraded.map((c) => c.target).join('、')}`,
        )
      }

      return ok(report)
    },
  )
}
