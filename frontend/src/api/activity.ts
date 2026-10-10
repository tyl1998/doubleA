/**
 * 活动时间线接口封装（P1-8 · L0）
 *
 * 依据：`shared/src/memory.ts`（契约）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/activity` | `ActivityListResult`（本人的会话 + 读数） |
 * | `GET /api/activity/search` | `ActivitySearchResult`（在本人会话里搜消息） |
 *
 * 权限与会话同族（**仅本人**）；只读，无失效逻辑。
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ActivityListResult, ActivitySearchResult } from '@doubulea/shared'

import { request } from './client.js'

export const ACTIVITY_PAGE_LIMIT = 20

export interface ActivityListParams {
  offset: number
  limit: number
  q?: string
}

export function fetchActivity(params: ActivityListParams): Promise<ActivityListResult> {
  const search = new URLSearchParams({ offset: String(params.offset), limit: String(params.limit) })
  if (params.q !== undefined && params.q !== '') search.set('q', params.q)
  return request<ActivityListResult>(`/api/activity?${search.toString()}`)
}

export function useActivity(params: ActivityListParams) {
  return useQuery({
    queryKey: ['activity', params.offset, params.limit, params.q ?? ''],
    queryFn: () => fetchActivity(params),
    placeholderData: keepPreviousData,
  })
}

export interface ActivitySearchParams {
  q: string
  offset: number
  limit: number
}

export function fetchActivitySearch(params: ActivitySearchParams): Promise<ActivitySearchResult> {
  const search = new URLSearchParams({
    q: params.q,
    offset: String(params.offset),
    limit: String(params.limit),
  })
  return request<ActivitySearchResult>(`/api/activity/search?${search.toString()}`)
}

/** 消息搜索（`q` 为空时**不请求**，由调用方用 `enabled` 收口） */
export function useActivitySearch(params: ActivitySearchParams, enabled: boolean) {
  return useQuery({
    queryKey: ['activity', 'search', params.q, params.offset, params.limit],
    queryFn: () => fetchActivitySearch(params),
    enabled: enabled && params.q.trim() !== '',
    placeholderData: keepPreviousData,
  })
}
