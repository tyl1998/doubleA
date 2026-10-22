/**
 * 沙箱实例注册表接口封装（P1-14 · R5 后台可观测 + 摘流）
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET  /api/admin/sandbox/instances` | `SandboxInstancesResult`（上游表 + 注册项 + 负载 + 角色） |
 * | `POST /api/admin/sandbox/instances/:id/drain` | `SandboxDrainResult`（写/清摘流标记） |
 *
 * 权限：**仅 ADMIN**。注册表本身仍由各实例心跳写入；唯一的写操作是「摘流」——
 * 它写的是 `sandbox:drain:{id}`（被摘那台的心跳会读到并上报），**不是**直接改注册键。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SandboxDrainResult, SandboxInstancesResult } from '@doubulea/shared'

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

/**
 * 摘流 / 恢复（P1-14 运维手段；2026-10-21 用户反馈"页面上没有按钮"）。
 *
 * ⚠️ 语义**只挡新会话**：摘流后网关不再把它当新 owner 的候选，已钉在它上面的会话照常接。
 *    写完之后 `drained` 要等**那台自己的心跳**把它报进注册值（本机立即刷新，≤ 10s 可见；
 *    别的机器 ≤ 3× 心跳）—— 所以这里在成功后立刻重拉一次列表，把"还没生效"的窗口缩到最小。
 */
export function useSetSandboxDrained() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { instanceId: string; drained: boolean }) =>
      request<SandboxDrainResult>(`/api/admin/sandbox/instances/${encodeURIComponent(input.instanceId)}/drain`, {
        method: 'POST',
        body: { drained: input.drained },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SANDBOX_INSTANCES_QUERY_KEY })
    },
  })
}
