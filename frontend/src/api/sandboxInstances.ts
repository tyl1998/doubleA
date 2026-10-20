/**
 * 沙箱实例注册表接口封装（P1-14 · R5 后台可观测）
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/admin/sandbox/instances` | `SandboxInstancesResult`（上游表 + 注册项 + 负载 + 角色） |
 *
 * 权限：**仅 ADMIN**。只读 —— 注册表由各实例心跳写入，本页不提供任何写操作。
 */

import { useQuery } from '@tanstack/react-query'
import type { SandboxInstancesResult } from '@doubulea/shared'

import { request } from './client.js'

export const SANDBOX_INSTANCES_QUERY_KEY = ['sandbox-instances'] as const

export function fetchSandboxInstances(): Promise<SandboxInstancesResult> {
  return request<SandboxInstancesResult>('/api/admin/sandbox/instances')
}

/**
 * 读实例注册表。`refetchInterval` 默认 10s —— 与网关自动发现的轮询间隔同量级
 * （实例上下线本来就受 `3× 心跳` 的 TTL 约束，刷得再快也看不到更新的事实）。
 */
export function useSandboxInstances(refetchIntervalMs = 10_000) {
  return useQuery({
    queryKey: SANDBOX_INSTANCES_QUERY_KEY,
    queryFn: fetchSandboxInstances,
    refetchInterval: refetchIntervalMs,
  })
}
