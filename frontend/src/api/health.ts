/**
 * 健康检查接口（P0-1-30 起被登录页消费）
 *
 * 登录页左侧「识别板」要回答"这是什么系统、什么版本、依赖是否就绪"（`design/login.html` 的构成），
 * 而这三个问题**恰好是 `GET /health` 已经回答的东西**（P0-1-4）。
 *
 * ## 为什么在登录页放它，而不是把原型里的假数字搬过来
 *
 * 设计原型的识别板写的是"会话并发 4 / 8""知识库 6 个""MCP server 5 个"—— 那些是**画的样例**，
 * 没有对应的数据源（并发数只在 Redis 的活跃流锁里、知识库数要登录后才有权限读）。
 * 把样例数字原样搬进实现，等于在界面上**写死会过期的谎**。所以改用真实可得的服务信息：
 * 版本 / 环境 / 三个依赖的探活结论 —— 与"识别板"的意图一致，且每一条都能被证明。
 *
 * ⚠️ 契约真相在 `backend/src/routes/health.ts`（`HealthReport`）。这里**只声明本页用到的字段**，
 * 不整份复制 —— 复制一份就有两个会各自腐烂的形状。若要在这里消费更多字段，
 * 正确的做法是先把类型搬进 `shared/`，而不是在这里补齐 `HealthReport`。
 */

import { useQuery } from '@tanstack/react-query'

import { request } from './client.js'

/** `/health` 里被探活的依赖（顺序即后端响应里的顺序，`HEALTH_TARGETS`） */
export type HealthTarget = 'postgres' | 'redis' | 's3'

export interface HealthCheck {
  target: HealthTarget
  ok: boolean
  latencyMs: number
  /** 成功时是"探到了什么"，失败时是失败原因（后端已收敛成单行、不含堆栈） */
  detail: string
}

/** `/health` 的 `data`（本页消费的字段子集） */
export interface HealthSummary {
  status: 'ok' | 'degraded'
  service: string
  version: string
  env: string
  port: number
  uptimeSec: number
  /**
   * 承接该响应的后端实例 id（`null` = 非沙箱宿主角色）。
   * 可选：老版本后端不返回该字段；消费方必须容忍 `undefined`。
   */
  instanceId?: string | null
  checks: HealthCheck[]
}

export const HEALTH_QUERY_KEY = ['health'] as const

/** 依赖名的中文口径（与 `docs/02` §4.9 的运维叫法一致，别在 JSX 里散着写） */
export const HEALTH_TARGET_LABEL: Readonly<Record<HealthTarget, string>> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  s3: '对象存储',
}

/**
 * 读服务信息。
 *
 * `retry: false` 是刻意的：这个面板是**附注**，不是登录的前置条件 ——
 * 服务信息取不到时应当安静地少显示几行，而不是让登录页在那里转圈重试。
 * 后端不可达时用户马上就会从"点了登录没反应"得到更直接的结论。
 */
/**
 * 读一次服务信息（非 hook；给"这条响应由哪台后端发出"这类一次性判断用）。
 *
 * 与 {@link useHealth} 的区别只有缓存口径：这里不节流、不重试，调用方自己决定缓存多久
 * （管理页把它钉成 `staleTime: Infinity`，见 `SandboxInstancesPage` 文件头 ★）。
 */
export function fetchHealth(signal?: AbortSignal): Promise<HealthSummary> {
  return request<HealthSummary>('/health', signal === undefined ? {} : { signal })
}

export function useHealth() {
  return useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => request<HealthSummary>('/health', { signal }),
    retry: false,
    staleTime: 60_000,
  })
}
