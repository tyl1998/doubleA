/**
 * 开放平台 Key 接口封装（P1-22；2026-10-22 改**按人**）
 *
 * 依据：`docs/08-开放平台-智能体OpenAPI(APIKey).md` §8（管理面）、`shared/src/openApi.ts`（契约）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/open-keys?agentId=` | `{ items: OpenApiKeyItem[] }`（**我名下的**；**永不含明文**） |
 * | `POST /api/open-keys` | `OpenApiKeyItem & { plaintext }`（**明文只此一次**） |
 * | `PUT /api/open-keys/:keyId` | `OpenApiKeyItem`（编辑元数据；2026-10-22 追加） |
 * | `DELETE /api/open-keys/:keyId` | `{ id, revoked }` |
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么按人（`/api/open-keys`）而不是按智能体
 * ─────────────────────────────────────────────────────────────────────
 * Key 的主语是「**我** × 智能体」。挂在智能体下会让编辑页的读者以为"这个智能体开了 Key ⇒ 大家都能用"。
 * 按人组织后：列表 = "我给了谁什么"；**关联哪个智能体**是签发时选的（`body.agentId`）。
 * 页面入口在「我的凭据」的新分区（`?section=openapi`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 明文只在创建响应里：**不要**把它塞进任何缓存
 * ─────────────────────────────────────────────────────────────────────
 * 创建成功后只**失效**列表（让它去服务端取元数据），明文交给页面的本地 state，弹窗关掉即丢弃。
 * 用 `setQueryData` 拼一条假列表项会把明文留在 query cache 里（且它永远不会被吊销刷新）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateOpenApiKeyBody,
  CreateOpenApiKeyResult,
  ListOpenApiKeysResult,
  OpenApiKeyItem,
  RevokeOpenApiKeyResult,
  UpdateOpenApiKeyBody,
} from '@doubulea/shared'

import { request } from './client.js'

/**
 * 我的 Key 列表键。`agentId` 进键（不同过滤 = 不同结果）；**签发/吊销后失效的是前缀**
 * `['openKeys']`（所有过滤视图一起刷新 —— 签一把 Key 会同时影响"全部"与"某个智能体"两个视图）。
 */
export const OPEN_KEYS_QUERY_KEY = ['openKeys'] as const

export function openKeysQueryKey(agentId?: string): readonly unknown[] {
  return agentId === undefined ? [...OPEN_KEYS_QUERY_KEY, 'all'] : [...OPEN_KEYS_QUERY_KEY, agentId]
}

export function fetchOpenApiKeys(agentId?: string): Promise<ListOpenApiKeysResult> {
  const search = agentId === undefined ? '' : `?agentId=${encodeURIComponent(agentId)}`
  return request<ListOpenApiKeysResult>(`/api/open-keys${search}`)
}

/** 列表查询（`agentId` 省略 = 我名下的全部） */
export function useOpenApiKeys(agentId?: string) {
  return useQuery({
    queryKey: openKeysQueryKey(agentId),
    queryFn: () => fetchOpenApiKeys(agentId),
  })
}

function invalidateOpenKeys(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: OPEN_KEYS_QUERY_KEY })
}

/** 签发。返回体里的 `plaintext` 只在这里出现一次（见文件头 ②） */
export function useCreateOpenApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateOpenApiKeyBody) =>
      request<CreateOpenApiKeyResult>('/api/open-keys', { method: 'POST', body }),
    onSuccess: () => invalidateOpenKeys(queryClient),
  })
}

/** 吊销（幂等；服务端重复吊销也回 `revoked: true`） */
export function useRevokeOpenApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (keyId: string) =>
      request<RevokeOpenApiKeyResult>(`/api/open-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateOpenKeys(queryClient),
  })
}

/**
 * 编辑元数据（**合并语义**：体里只放要改的字段；明文与关联智能体不可编辑 —— 契约里就没有它们）。
 * 成功后失效列表（服务端还会删缓存键 ⇒ 新策略立即生效，不等 TTL）。
 */
export function useUpdateOpenApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ keyId, body }: { keyId: string; body: UpdateOpenApiKeyBody }) =>
      request<OpenApiKeyItem>(`/api/open-keys/${encodeURIComponent(keyId)}`, { method: 'PUT', body }),
    onSuccess: () => invalidateOpenKeys(queryClient),
  })
}
