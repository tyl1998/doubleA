/**
 * 用量统计接口封装（P1-7）
 *
 * 依据：`docs/02` §四（`GET /api/usage/summary`）、`shared/src/usage.ts`（契约）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/usage/summary?groupBy=&from=&to=` | `UsageSummaryResult`（`{ groupBy, from, to, items }`） |
 *
 * 权限：**仅 ADMIN**（`(A)` 族）。三个 `groupBy` 维度（`user` / `agent` / `model`）**共用本端点** ——
 * 页面并排三张表，各发一次请求（区间相同、`groupBy` 不同），互不阻塞。
 * 报表是只读的，故只有 `useQuery`，没有失效逻辑。
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { UsageGroupBy, UsageSummaryResult } from '@doubulea/shared'

import { request } from './client.js'

export const USAGE_QUERY_KEY = ['usage'] as const

export interface UsageSummaryParams {
  groupBy: UsageGroupBy
  /** 左闭（ISO 8601 绝对时刻） */
  from: string
  /** 右开（ISO 8601 绝对时刻） */
  to: string
}

export function usageSummaryQueryKey(params: UsageSummaryParams) {
  return ['usage', 'summary', params.groupBy, params.from, params.to] as const
}

export function fetchUsageSummary(params: UsageSummaryParams): Promise<UsageSummaryResult> {
  const search = new URLSearchParams({ groupBy: params.groupBy, from: params.from, to: params.to })
  return request<UsageSummaryResult>(`/api/usage/summary?${search.toString()}`)
}

/**
 * 用量报表。`placeholderData: keepPreviousData` 让"切区间 / 换维度"时表格不闪成骨架屏
 * （用户正盯着读数看，闪一下会以为数据变了）—— 与其余列表同款。
 */
export function useUsageSummary(params: UsageSummaryParams) {
  return useQuery({
    queryKey: usageSummaryQueryKey(params),
    queryFn: () => fetchUsageSummary(params),
    placeholderData: keepPreviousData,
  })
}
