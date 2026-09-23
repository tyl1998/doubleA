/**
 * 智能体接口封装（P0-1-31）
 *
 * 依据：`docs/02-后端设计.md` §4.4（六端点与权限）、`docs/03-前端设计.md` §二（路由与权限列）、
 *      §4.2（编辑页保存 = **PATCH + PUT components 串行**）、§七（删除分级确认）、
 *      `shared/src/agent.ts`（**唯一一套投影 `AgentItem`**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 信封层级逐个核对过，别照抄邻居
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/agents` | `{ items, total, offset, limit }` |
 * | `GET/POST/PATCH /api/agents[/:id]`、`PUT /:id/components` | **裸 `AgentItem`** |
 * | `DELETE /api/agents/:id` | `{ id, name, removedComponents, finishedConversations }` |
 *
 * 本仓**刻意四族权限、四种信封形态各不相同**（`docs/06` §六 第 ⑭ 条）：把
 * `GET /api/models/available` 的 `{items}` 类推到别处会**安静地拿到 `null`**
 * （`jq`/取值路径不报错），一路带到下一个请求才炸成 400。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 组件绑定的写侧是"整体替换"，且**只放行 KNOWLEDGE**（P0-1-23 定案）
 * ─────────────────────────────────────────────────────────────────────
 * `PUT /api/agents/:id/components` 收**全量集合**；`components` **必填**，清空要显式传 `[]`
 * （"省略 = 清空"会让前端某次忘带字段变成静默解绑全部，界面却显示"保存成功"）。
 * 提交里含 `MCP` 会被后端 400 拒绝（`mcp_servers` 表属 P0-2）—— 故本页**在 UI 上就不提供
 * MCP 勾选**（见 `pages/agents/AgentFormPage.tsx` 的第 ④ 区），而不是让用户选完再吃一个 400。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentItem,
  AgentListResult,
  CreateAgentBody,
  RemoveAgentResult,
  ReplaceAgentComponentsBody,
  UpdateAgentBody,
} from '@doubulea/shared'

import { request } from './client.js'
import { KNOWLEDGE_BASES_QUERY_KEY } from './knowledgeBases.js'

/**
 * 列表/详情的缓存键。
 *
 * 详情键 `['agents', id]` 是列表键 `['agents']` 的**子键** ⇒ `invalidateQueries({queryKey: AGENTS_QUERY_KEY})`
 * 会**同时**把列表与所有已打开的详情标脏。这不是巧合：一次写操作必然让两处都过期，
 * 写成两个互不相干的键就得在每个 mutation 里记得失效两次（迟早漏一个，症状是"列表更新了、详情还是旧的"）。
 */
export const AGENTS_QUERY_KEY = ['agents'] as const
export function agentQueryKey(id: string): readonly [string, string] {
  return ['agents', id] as const
}

/**
 * 列表一次最多取多少条（= `shared` 的 `listAgentsQuerySchema` 的 `limit` 上限 100，同源）。
 *
 * 本页**一次取满 100 条 + 客户端分页/搜索/筛选**（理由见列表页注释）。超过 100 个智能体时
 * 第 100 条之后看不到 —— 这是写明的边界，不是实现漏了。
 */
export const AGENTS_PAGE_LIMIT_MAX = 100

export interface ListAgentsParams {
  offset?: number
  limit?: number
}

export function fetchAgents(params: ListAgentsParams = {}): Promise<AgentListResult> {
  const search = new URLSearchParams()
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  const suffix = search.size === 0 ? '' : `?${search.toString()}`
  return request<AgentListResult>(`/api/agents${suffix}`)
}

export function useAgents(params: ListAgentsParams = {}) {
  return useQuery({
    queryKey: [...AGENTS_QUERY_KEY, 'list', params.offset ?? 0, params.limit ?? AGENTS_PAGE_LIMIT_MAX] as const,
    queryFn: () => fetchAgents(params),
    // 翻页/改 limit 时保留上一页数据，避免表格闪成空白（AntD Table 的分页体验）
    placeholderData: keepPreviousData,
  })
}

export function fetchAgent(id: string): Promise<AgentItem> {
  return request<AgentItem>(`/api/agents/${encodeURIComponent(id)}`)
}

/**
 * 读单个智能体。`id === undefined` 时**不发请求**（`enabled: false`）——
 * `/agents/new` 与 `/agents/:id/edit` 共用一个组件，新建态没有 id 可读。
 */
export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: agentQueryKey(id ?? ''),
    queryFn: () => fetchAgent(id ?? ''),
    enabled: id !== undefined,
  })
}

/**
 * 写操作成功后要失效的缓存。
 *
 * ⚠️ 组件绑定与软删都会改变**知识库侧的 `agentCount`**（`GET /api/knowledge-bases` 的投影字段，
 * 也是"这个库能不能删"的判据，`docs/02` §4.4）。只失效 `['agents']` 会让知识库列表上的
 * "被 N 个智能体绑定"停在旧值上 —— 用户据此以为那个库删不掉（或反过来，删了却提示被占用）。
 * 这是 P0-1-24「同一份数据的多出口一致性」在本页的对应物。
 */
function invalidateAffectedViews(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY })
  void queryClient.invalidateQueries({ queryKey: KNOWLEDGE_BASES_QUERY_KEY })
}

export function useCreateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateAgentBody) => request<AgentItem>('/api/agents', { method: 'POST', body }),
    onSuccess: () => invalidateAffectedViews(queryClient),
  })
}

/**
 * 改文本字段（`PATCH`）。**三态**由调用方在 body 里表达：
 * 不带 = 不动 / `null` = 清空 / 值 = 设置（`shared/src/agent.ts` 的注释）。
 * 本函数**不做任何字段裁剪** —— 传什么发什么，避免"api 层悄悄补了个默认值"这种难查的改动。
 */
export function useUpdateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAgentBody }) =>
      request<AgentItem>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateAffectedViews(queryClient),
  })
}

/** 组件绑定**整体替换**（`PUT`）：提交的集合就是全部；`components: []` 即解绑全部 */
export function useReplaceAgentComponents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReplaceAgentComponentsBody }) =>
      request<AgentItem>(`/api/agents/${encodeURIComponent(id)}/components`, { method: 'PUT', body }),
    onSuccess: () => invalidateAffectedViews(queryClient),
  })
}

/** 软删（组件解绑 + 会话转只读保留），响应带两个连带数字供确认提示使用 */
export function useRemoveAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RemoveAgentResult>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateAffectedViews(queryClient),
  })
}
