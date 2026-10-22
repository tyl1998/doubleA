/**
 * 会话标题生成模型接口封装（平台级单例）
 *
 * 依据：契约 `shared/src/titleModel.ts`；消费方 = 模型池页内嵌的「系统模型」区块
 *       （`pages/admin/SystemModelSection.tsx`，**仅 ADMIN** 渲染）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/admin/title-model` | `TitleModelConfig`（总开关 + 选定模型 + 展示名） |
 * | `PUT /api/admin/title-model` | 同上（整体替换） |
 *
 * 权限：**仅 ADMIN**（平台级配置）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TitleModelConfig, UpdateTitleModelBody } from '@doubulea/shared'

import { request } from './client.js'

export const TITLE_MODEL_QUERY_KEY = ['title-model'] as const

export function fetchTitleModel(): Promise<TitleModelConfig> {
  return request<TitleModelConfig>('/api/admin/title-model')
}

export function updateTitleModel(body: UpdateTitleModelBody): Promise<TitleModelConfig> {
  return request<TitleModelConfig>('/api/admin/title-model', { method: 'PUT', body })
}

export function useTitleModel() {
  return useQuery({ queryKey: TITLE_MODEL_QUERY_KEY, queryFn: fetchTitleModel })
}

/** 保存后直接把响应写回缓存（服务端已完成校验与落定，不必再多取一次） */
export function useUpdateTitleModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateTitleModel,
    onSuccess: (data) => queryClient.setQueryData(TITLE_MODEL_QUERY_KEY, data),
  })
}