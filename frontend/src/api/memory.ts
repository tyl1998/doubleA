/**
 * 长期记忆接口封装（P1-8 · L2）
 *
 * 依据：`docs/02`（端点约定）、`shared/src/memory.ts`（契约）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET    /api/memories` | `MemoryListResult` |
 * | `POST   /api/memories` | **裸 `MemoryItem`** |
 * | `PATCH  /api/memories/:id` | **裸 `MemoryItem`** |
 * | `DELETE /api/memories/:id` | **裸 `{ id }`** |
 * | `GET    /api/memories/settings` | `MemorySettings` |
 * | `PATCH  /api/memories/settings` | `MemorySettings` |
 * | `GET    /api/memories/notices?conversationId=` | `MemoryNoticesResult`（**取出即消费**） |
 * | `POST   /api/memories/notices/:noticeId?conversationId=` | `MemoryNoticeActionResult` |
 * | `PUT    /api/conversations/:id/memory-excluded` | `SetConversationMemoryExcludedResult` |
 *
 * 权限与会话/产物/任务同族（**仅本人**）。写操作成功后失效 `['memories']` 整棵子树。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateMemoryBody,
  ListMemoriesQuery,
  MemoryItem,
  MemoryListResult,
  MemoryNoticeActionResult,
  MemoryNoticesResult,
  MemorySettings,
  SetConversationMemoryExcludedResult,
  UpdateMemoryBody,
  UpdateMemorySettingsBody,
} from '@doubulea/shared'

import { request } from './client.js'

export const MEMORY_QUERY_KEY = ['memories'] as const
export const MEMORY_SETTINGS_KEY = ['memories', 'settings'] as const

/** 列表一次取多少条（与其余列表同口径） */
export const MEMORY_PAGE_LIMIT = 20

export interface MemoryListParams {
  offset: number
  limit: number
  kind?: ListMemoriesQuery['kind']
  /** 作用域筛选（P1-8a：USER/AGENT；省略 = 全部） */
  scope?: ListMemoriesQuery['scope']
  q?: string
}

export function memoryListQueryKey(params: MemoryListParams) {
  return [
    'memories',
    'list',
    params.offset,
    params.limit,
    params.kind ?? '',
    params.scope ?? '',
    params.q ?? '',
  ] as const
}

export function fetchMemories(params: MemoryListParams): Promise<MemoryListResult> {
  const search = new URLSearchParams({ offset: String(params.offset), limit: String(params.limit) })
  if (params.kind !== undefined) search.set('kind', params.kind)
  if (params.scope !== undefined) search.set('scope', params.scope)
  if (params.q !== undefined && params.q !== '') search.set('q', params.q)
  return request<MemoryListResult>(`/api/memories?${search.toString()}`)
}

export function useMemories(params: MemoryListParams) {
  return useQuery({
    queryKey: memoryListQueryKey(params),
    queryFn: () => fetchMemories(params),
    placeholderData: keepPreviousData,
  })
}

export function useCreateMemory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateMemoryBody) => request<MemoryItem>('/api/memories', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
    },
  })
}

export function useUpdateMemory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateMemoryBody }) =>
      request<MemoryItem>(`/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
    },
  })
}

export function useDeleteMemory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<{ id: string }>(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
    },
  })
}

export function useMemorySettings() {
  return useQuery({
    queryKey: MEMORY_SETTINGS_KEY,
    queryFn: () => request<MemorySettings>('/api/memories/settings'),
  })
}

export function useUpdateMemorySettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateMemorySettingsBody) =>
      request<MemorySettings>('/api/memories/settings', { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMORY_SETTINGS_KEY })
    },
  })
}

/** 取走待展示提示（**取出即消费**；返回后服务端已清空，故不进 query 缓存，由调用方一次性消费） */
export function fetchMemoryNotices(conversationId: string): Promise<MemoryNoticesResult> {
  return request<MemoryNoticesResult>(
    `/api/memories/notices?conversationId=${encodeURIComponent(conversationId)}`,
  )
}

/** 对一条偏好建议作答（记住 / 忽略） */
export function useMemoryNoticeAction(conversationId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ noticeId, action, text }: { noticeId: string; action: 'ACCEPT' | 'REJECT'; text?: string }) => {
      const search = new URLSearchParams({ conversationId: conversationId ?? '' })
      return request<MemoryNoticeActionResult>(
        `/api/memories/notices/${encodeURIComponent(noticeId)}?${search.toString()}`,
        { method: 'POST', body: { action, ...(text === undefined ? {} : { text }) } },
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
    },
  })
}

/** 会话级「不记入记忆」开关（命令式，供对话页头部开关用；与 `setConversationAutoApprove` 同款） */
export function setConversationMemoryExcluded(
  conversationId: string,
  excluded: boolean,
): Promise<SetConversationMemoryExcludedResult> {
  return request<SetConversationMemoryExcludedResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/memory-excluded`,
    { method: 'PUT', body: { excluded } },
  )
}

