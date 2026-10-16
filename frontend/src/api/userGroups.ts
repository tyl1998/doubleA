/**
 * 用户组接口封装（P1-18 · 子批 B；`/api/admin/groups`，`(A)` 仅 ADMIN）
 *
 * 依据：`shared/src/userGroup.ts`（唯一一套投影）。
 * 信封：`GET /api/admin/groups` → `{ items, total, offset, limit }`；其余 → 裸 item / detail。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateUserGroupBody,
  ReplaceUserGroupMembersBody,
  UpdateUserGroupBody,
  UserGroupDetail,
  UserGroupItem,
  UserGroupListResult,
} from '@doubulea/shared'

import { request } from './client.js'
import { ADMIN_USERS_QUERY_KEY } from './adminUsers.js'

export const USER_GROUPS_QUERY_KEY = ['admin', 'groups'] as const
export const USER_GROUPS_PAGE_LIMIT_MAX = 100

export function groupQueryKey(id: string): readonly [string, string, string] {
  return ['admin', 'groups', id] as const
}

export function fetchUserGroups(offset = 0, limit = USER_GROUPS_PAGE_LIMIT_MAX): Promise<UserGroupListResult> {
  // ⚠️ 走**登录可用**的 `/api/user-groups`（不是 ADMIN 的 `/api/admin/groups`）：受众选择器
  // 由任何登录用户使用（给自己的 Agent 圈组），管理写操作才走 `/api/admin/groups`。
  return request<UserGroupListResult>(`/api/user-groups?offset=${offset}&limit=${limit}`)
}

export function useUserGroups() {
  return useQuery({
    queryKey: [...USER_GROUPS_QUERY_KEY, 'list'] as const,
    queryFn: () => fetchUserGroups(),
    placeholderData: keepPreviousData,
  })
}

export function useUserGroup(id: string | undefined) {
  return useQuery({
    queryKey: groupQueryKey(id ?? ''),
    queryFn: () => request<UserGroupDetail>(`/api/admin/groups/${encodeURIComponent(id ?? '')}`),
    enabled: id !== undefined,
  })
}

function invalidateGroups(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: USER_GROUPS_QUERY_KEY })
  // 组的改名/删组会改变 Agent 受众回显里的组名 ⇒ 连带失效智能体视图
  void queryClient.invalidateQueries({ queryKey: ['agents'] })
  // P1-18：用户列表现在有「所在组」列 ⇒ 组成员的增删 / 组改名 / 删组都要失效用户清单
  void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY })
}

export function useCreateUserGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateUserGroupBody) =>
      request<UserGroupItem>('/api/admin/groups', { method: 'POST', body }),
    onSuccess: () => invalidateGroups(queryClient),
  })
}

export function useUpdateUserGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserGroupBody }) =>
      request<UserGroupItem>(`/api/admin/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateGroups(queryClient),
  })
}

export function useReplaceUserGroupMembers() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReplaceUserGroupMembersBody }) =>
      request<UserGroupDetail>(`/api/admin/groups/${encodeURIComponent(id)}/members`, { method: 'PUT', body }),
    onSuccess: () => invalidateGroups(queryClient),
  })
}

export function useRemoveUserGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<{ id: string; name: string; removedAudiences: number }>(
        `/api/admin/groups/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateGroups(queryClient),
  })
}
