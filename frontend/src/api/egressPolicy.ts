/**
 * 沙箱出网策略接口封装（egress 黑白名单）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.5；契约 `shared/src/egressPolicy.ts`。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/admin/egress-policy` | `EgressPolicy`（两张表 + 推导 `mode` + `updatedAt`） |
 * | `PUT /api/admin/egress-policy` | 同上（整体替换） |
 *
 * 权限：**仅 ADMIN**（平台级配置）。`mode` 由服务端推导，请求体只交两张表。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EgressPolicy, UpdateEgressPolicyBody } from '@doubulea/shared'

import { request } from './client.js'

export const EGRESS_POLICY_QUERY_KEY = ['egress-policy'] as const

export function fetchEgressPolicy(): Promise<EgressPolicy> {
  return request<EgressPolicy>('/api/admin/egress-policy')
}

export function updateEgressPolicy(body: UpdateEgressPolicyBody): Promise<EgressPolicy> {
  return request<EgressPolicy>('/api/admin/egress-policy', { method: 'PUT', body })
}

export function useEgressPolicy() {
  return useQuery({ queryKey: EGRESS_POLICY_QUERY_KEY, queryFn: fetchEgressPolicy })
}

/** 保存后直接把响应写回缓存（服务端已完成归一化，不必再多取一次） */
export function useUpdateEgressPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateEgressPolicy,
    onSuccess: (data) => queryClient.setQueryData(EGRESS_POLICY_QUERY_KEY, data),
  })
}
