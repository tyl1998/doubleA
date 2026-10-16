/**
 * 用户搜索接口封装（P1-18 · 子批 B；`GET /api/users/search`，**登录可用**）
 *
 * 依据：`shared/src/user.ts`（`UserSearchResult` 只回 `{ id, name }`）。
 * 用途：Agent 受众选择器 —— 非管理员也能按名字找人（`GET /api/users` 仍仅 ADMIN）。
 */

import { useQuery } from '@tanstack/react-query'
import type { UserSearchItem, UserSearchResult } from '@doubulea/shared'

import { request } from './client.js'

export function fetchUserSearch(q: string): Promise<UserSearchResult> {
  return request<UserSearchResult>(`/api/users/search?q=${encodeURIComponent(q)}`)
}

/**
 * 搜用户（受众选择器用）。`q` 为空 ⇒ 不发请求（`enabled: false`），避免"打开就拉全表"。
 * 结果按 `q` 缓存，输入变化即重新拉取（`placeholderData` 保留上一批，避免下拉闪烁）。
 */
export function useUserSearch(q: string) {
  const keyword = q.trim()
  return useQuery({
    queryKey: ['users', 'search', keyword] as const,
    queryFn: () => fetchUserSearch(keyword),
    enabled: keyword !== '',
    select: (data): UserSearchItem[] => data.items,
  })
}
