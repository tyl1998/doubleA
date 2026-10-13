/**
 * git 凭据接口封装（P1-9 · R11）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7；`shared/src/gitCredential.ts`（唯一一套投影）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/git-credentials` | `{ items }`（**刻意不分页**） |
 * | `POST /api/git-credentials` | **裸 `GitCredentialItem`** |
 * | `PUT /api/git-credentials/:id` | **裸 `GitCredentialItem`** |
 * | `DELETE /api/git-credentials/:id` | `{ id, label }` |
 *
 * ⚠️ 值不下发（连掩码都没有）⇒ 前端无从回填 ⇒ 编辑时的秘密字段是"留空 = 不变"（合并语义）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateGitCredentialBody,
  GitCredentialItem,
  GitCredentialListResult,
  RemoveGitCredentialResult,
  UpdateGitCredentialBody,
} from '@doubulea/shared'

import { request } from './client.js'

/** 我的 git 凭据清单键 */
export const GIT_CREDENTIALS_QUERY_KEY = ['git', 'credentials'] as const

export function useGitCredentials() {
  return useQuery({
    queryKey: GIT_CREDENTIALS_QUERY_KEY,
    queryFn: () => request<GitCredentialListResult>('/api/git-credentials'),
  })
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: GIT_CREDENTIALS_QUERY_KEY })
}

export function useCreateGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateGitCredentialBody) =>
      request<GitCredentialItem>('/api/git-credentials', { method: 'POST', body }),
    onSuccess: () => invalidate(queryClient),
  })
}

export function useUpdateGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateGitCredentialBody }) =>
      request<GitCredentialItem>(`/api/git-credentials/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    onSuccess: () => invalidate(queryClient),
  })
}

export function useRemoveGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RemoveGitCredentialResult>(`/api/git-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(queryClient),
  })
}
