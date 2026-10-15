/**
 * git 提交身份接口封装（P1-20）
 *
 * 依据：`shared/src/gitIdentity.ts`（唯一一套投影）+ `services/gitIdentity.service.ts`。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/git-identity` | `{ name, email }`（都可为 `null`） |
 * | `PUT /api/git-identity` | 同构（缺省即不动，`null`/空串 = 清空该字段） |
 *
 * ⚠️ 与 git **凭据**相反：身份是**公开信息**（提交署名），可读可回填，不是"有进无出"。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitIdentity, UpdateGitIdentityBody } from '@doubulea/shared'

import { request } from './client.js'

/** 我的 git 身份键 */
export const GIT_IDENTITY_QUERY_KEY = ['git', 'identity'] as const

export function useGitIdentity() {
  return useQuery({
    queryKey: GIT_IDENTITY_QUERY_KEY,
    queryFn: () => request<GitIdentity>('/api/git-identity'),
  })
}

export function useUpdateGitIdentity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateGitIdentityBody) =>
      request<GitIdentity>('/api/git-identity', { method: 'PUT', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GIT_IDENTITY_QUERY_KEY })
    },
  })
}
