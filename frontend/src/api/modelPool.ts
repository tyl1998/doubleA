/**
 * 模型池接口封装（`/admin/models`，P0-1-36；端点本身是 P0-1-10 / P0-1-11 / P0-1-12 就绪的）
 *
 * 依据：`docs/02-后端设计.md` §4.3（Provider / 模型 / 拉取上游模型三组端点 + 五条守卫）、
 *      `shared/src/modelProvider.ts` + `shared/src/model.ts`（**两套投影**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 信封层级逐个核对过
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/model-providers` | `{ items, total, offset, limit }` |
 * | `POST/PATCH /api/model-providers[/:id]` | **裸 `ModelProviderItem`** |
 * | `DELETE /api/model-providers/:id` | `{ id, name }` |
 * | `GET /api/model-providers/:id/remote-models` | `{ providerId, providerName, baseUrl, total, truncated, items }` |
 * | `GET /api/models` | `{ items, total, offset, limit }` |
 * | `POST/PATCH /api/models[/:id]` | **裸 `ModelItem`** |
 * | `DELETE /api/models/:id` | `{ id, modelName }` |
 *
 * ⚠️ 两个 DELETE 回的都是**最小形状**（`{id,name}` / `{id,modelName}`），不是被删的那一整条。
 * 成功提示要用的字段只有名字，所以够用 —— 但写成 `result.modelCount` 这种会**安静地**
 * 拿到 `undefined`（`docs/06` §六 第 ⑭ 条）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 为什么不用 `/api/models/available`
 * ─────────────────────────────────────────────────────────────────────
 * 那个端点是**登录即可**的"可选列表"（`{ items }`，不含停用项，`shared/src/model.ts` 文件头），
 * 管理页要的是**另一套投影**：看得见停用项、要分页、带 `agentCount` / `providerEnabled`。
 * 用它来画管理表，症状是"刚停用的模型从管理页消失了" —— 而停用恰恰是要在管理页做出来的事。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 一次写操作要失效的范围：**两个管理键 + 一个全站下拉键**
 * ─────────────────────────────────────────────────────────────────────
 * · `['admin','model-providers']` 与 `['admin','models']` 互为输入：
 *   Provider 改名/启停会改模型行的 `providerName` / `providerEnabled`；删 Provider 会**级联删**
 *   它下面的模型（`models.provider_id` 是 CASCADE）；反过来建/删模型会改 Provider 行的
 *   `modelCount`（界面上"这个能不能删 / 这个类型能不能改"的依据）。所以两者必须一起失效 ——
 *   只失效一个的症状是"模型列表更新了、Provider 那行的模型数还是旧值"。
 * · ⚠️ **`['models','available','CHAT']` 也必须失效**：它是智能体编辑页的模型下拉
 *   （`api/models.ts`）。`01` §3.2 的验收要点是「无效模型创建 Agent 时不可选」——
 *   停用一个模型后若下拉的缓存还留着它，管理员/用户**马上就能选中一个用了就失败的模型**，
 *   而那个下拉看不出任何异常。这一条没有别的观测面，只能靠"写操作时记得失效它"。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  CreateModelBody,
  CreateModelProviderBody,
  ModelItem,
  ModelListResult,
  ModelProviderItem,
  ModelProviderListResult,
  RemoteModelListResult,
  UpdateModelBody,
  UpdateModelProviderBody,
} from '@doubulea/shared'

import { AVAILABLE_CHAT_MODELS_QUERY_KEY } from './models.js'
import { request } from './client.js'

/** Provider 列表键 */
export const MODEL_PROVIDERS_QUERY_KEY = ['admin', 'model-providers'] as const
/** 管理面模型列表键 */
export const ADMIN_MODELS_QUERY_KEY = ['admin', 'models'] as const

/** 与两个列表 schema 的 `limit` 上限同源（100）；一次取满，翻页交给 AntD Table */
export const MODEL_POOL_PAGE_LIMIT_MAX = 100

/**
 * 模型池写操作后统一失效的三个视图（见文件头 ③）。
 *
 * 抽成一个函数而不是在八个 mutation 里各写一遍：漏掉 `['models','available','CHAT']` 的
 * 症状（下拉里能选到刚停用的模型）**在管理页上完全看不出来**，只有等用户建完智能体、
 * 发第一条消息才炸。一处收口，才有地方写这条注释、也才有东西能被断言。
 */
export function invalidateModelPoolViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: MODEL_PROVIDERS_QUERY_KEY })
  void queryClient.invalidateQueries({ queryKey: ADMIN_MODELS_QUERY_KEY })
  void queryClient.invalidateQueries({ queryKey: AVAILABLE_CHAT_MODELS_QUERY_KEY })
}

// ───────────────────────────── Provider ─────────────────────────────

export function fetchModelProviders(offset = 0, limit = MODEL_POOL_PAGE_LIMIT_MAX): Promise<ModelProviderListResult> {
  return request<ModelProviderListResult>(`/api/model-providers?offset=${offset}&limit=${limit}`)
}

/** Provider 列表（排序由后端定：`createdAt asc, id asc`，前端不再排一次） */
export function useModelProviders(offset = 0, limit = MODEL_POOL_PAGE_LIMIT_MAX) {
  return useQuery({
    queryKey: [...MODEL_PROVIDERS_QUERY_KEY, offset, limit] as const,
    queryFn: () => fetchModelProviders(offset, limit),
    placeholderData: keepPreviousData,
  })
}

export function useCreateModelProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateModelProviderBody) =>
      request<ModelProviderItem>('/api/model-providers', { method: 'POST', body }),
    onSuccess: () => invalidateModelPoolViews(queryClient),
  })
}

/**
 * 改 Provider（三态 `apiKey` / 类型锁由 `pages/admin/adminModel.ts#buildProviderUpdateBody` 收口）。
 *
 * ⚠️ **`apiKey` 的三态必须在调用方构造好**：本函数刻意不做任何裁剪、不补默认值 ——
 * api 层"顺手"补一个 `apiKey: null` 就会把已配置的 Key 悄悄抹掉（`02` §4.3 的三态表）。
 */
export function useUpdateModelProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateModelProviderBody }) =>
      request<ModelProviderItem>(`/api/model-providers/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateModelPoolViews(queryClient),
  })
}

/**
 * 删 Provider（**级联**删它下面的全部模型；其中有模型被智能体引用时整体 409）。
 *
 * 界面走"级联删除"那一档（Modal + 危险按钮 + 明示影响范围 + 逐字确认），见
 * `pages/admin/DeleteProviderModal.tsx`。
 */
export function useRemoveModelProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<{ id: string; name: string }>(`/api/model-providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateModelPoolViews(queryClient),
  })
}

/**
 * 拉取上游模型列表（`GET .../remote-models`）。
 *
 * 用 `useMutation` 而不是 `useQuery`：它是"点一下探一次"的诊断动作，不该在页面加载时自己发出去
 * （上游可能是内网地址、可能要等超时）。用 mutation 也让"上一次探到的结果"留在组件里，
 * 用户可以对着它挑几个型号名去手工录入。
 *
 * **只读探测、不落库** —— 所以它**不失效任何东西**（连"模型数变了"这种事都不会发生，
 * `02` §4.3 的验收里有一条断言守着"探完之后模型条数一条没变"）。
 */
export function useProbeRemoteModels() {
  return useMutation({
    mutationFn: (providerId: string) =>
      request<RemoteModelListResult>(`/api/model-providers/${encodeURIComponent(providerId)}/remote-models`),
  })
}

// ───────────────────────────── 模型 ─────────────────────────────

export function fetchAdminModels(offset = 0, limit = MODEL_POOL_PAGE_LIMIT_MAX): Promise<ModelListResult> {
  return request<ModelListResult>(`/api/models?offset=${offset}&limit=${limit}`)
}

/**
 * 管理面模型列表（**仅 ADMIN**，含停用项与 `agentCount`）。
 *
 * ⚠️ **不带 `type` / `providerId` / `enabled` 过滤**（这三个参数后端都支持）：本页的分组与
 * 筛选全在客户端做（一次取满 100 条），理由与知识库列表同款 —— "服务端筛选 + 客户端筛选"
 * 会让后者只作用于当前页，那是**看着像坏了**的行为。超过 100 个模型时页脚如实提示。
 */
export function useAdminModels(offset = 0, limit = MODEL_POOL_PAGE_LIMIT_MAX) {
  return useQuery({
    queryKey: [...ADMIN_MODELS_QUERY_KEY, offset, limit] as const,
    queryFn: () => fetchAdminModels(offset, limit),
    placeholderData: keepPreviousData,
  })
}

export function useCreateModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateModelBody) => request<ModelItem>('/api/models', { method: 'POST', body }),
    onSuccess: () => invalidateModelPoolViews(queryClient),
  })
}

/** 改模型（`maxContext` 三态 / `type` 锁与 `providerId` 不带，都在调用方的构造里收口） */
export function useUpdateModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateModelBody }) =>
      request<ModelItem>(`/api/models/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateModelPoolViews(queryClient),
  })
}

/** 删模型（被 Agent 引用时 409；`agentCount` 含软删的智能体，与后端守卫同口径） */
export function useRemoveModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<{ id: string; modelName: string }>(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateModelPoolViews(queryClient),
  })
}
