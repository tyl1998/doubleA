/**
 * MCP 接口封装（P0-2-11 建；servers 六条 + credentials 三条 + 确认应答一条）
 *
 * 依据：`docs/02-后端设计.md` §4.7（`/api/mcp/**` 九条端点表与权限）、`docs/06-实施计划.md`
 *      P0-2-11（前端三处接线）、`docs/03-前端设计.md` §4.4（MCP 管理页）/§4.5（我的凭据页）、
 *      `shared/src/mcp.ts` + `shared/src/sse.ts`（**唯一一套投影**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 信封层级逐个核对过，别照抄邻居（`docs/06` §六 第 ⑭ 条）
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/mcp/servers` | `{ items, total, offset, limit }` |
 * | `POST /api/mcp/servers` | `{ server, test }`（**不是裸 item**！） |
 * | `PATCH /api/mcp/servers/:id` | `{ server, credentialSchemaImpact }`（**也不是裸 item**） |
 * | `DELETE /api/mcp/servers/:id` | `{ id, name }` |
 * | `POST /api/mcp/servers/:id/test` | `{ ok:true, tools }` \| `{ ok:false, error }`（**恒 200**） |
 * | `GET /api/mcp/servers/:id/tools` | **裸 `{ tools, fetchedAt, cached }`**（第五族形态） |
 * | `GET /api/mcp/credentials` | **裸 `{ items, unconfigured }`**（**刻意不分页**） |
 * | `PUT /api/mcp/credentials/:serverId` | **裸 `McpCredentialItem`** |
 * | `DELETE /api/mcp/credentials/:serverId` | `{ serverId, serverName }` |
 * | `POST /api/conversations/:id/confirm` | **裸 `ConfirmConversationResult`** |
 *
 * ⚠️ 本仓**刻意四族权限、四种信封各不相同**：把 `POST` 的 `{server,test}` 当成裸 item
 * （或反过来）会在**编译期**就报错 —— 这是唯一一处"错了会立刻知道"的地方，别把它当噪音。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 权限口径：servers **登录即可、人人可改可删**；credentials **只动自己的**
 * ─────────────────────────────────────────────────────────────────────
 * 两条前缀**同一个 `/api/mcp/` 却刻意两族**（`routes/mcpServers.ts` 与 `mcpCredentials.ts`
 * 的文件头写了为什么值得连着读）：servers 没有 owner 列，`createdBy` 只留痕不判定；
 * credentials 的收窄在 `user_id` 上，**连 ADMIN 都没有后门**。
 * ⇒ 前端**不许**自作主张地把编辑/删除按钮按 `createdBy === 我` 隐藏 ——
 * 那会让"界面能点的都点得了、点不了的其实也能点"变成一句假话（权限在后端，不在界面）。
 * 界面上做的是**如实展示**（谁注册的），不是**代替后端判权限**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 失效范围：一次写操作要动的**两棵**树
 * ─────────────────────────────────────────────────────────────────────
 * `['mcp','servers']`（列表 + 工具数）与 `['mcp','credentials']`（凭据清单 + 未配置计数）
 * 是两棵**独立**的树，因为它们是两份不同的事实（一台 server 的工具列表 / 我缺哪些 key）。
 * ⚠️ 但有两处必须**两棵一起动**：
 *   · **改/删 server** ⇒ 凭据清单也要失效：它带着 `serverName` / 模板投影，
 *     而 `PATCH` 能改 `credentialSchema`（模板变了 ⇒ `fields` 与 `missingKeys` 全变）；
 *   · **删 server** ⇒ 后端已级联清了它的凭据（`unconfigured` 里那条也没了）。
 * 漏掉后者的症状是"server 没了、凭据页还列着它，点进去 404"。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ConfirmConversationResult,
  CreateMcpServerBody,
  McpCredentialItem,
  McpCredentialListResult,
  McpServerCreateResult,
  McpServerListResult,
  McpServerTestResult,
  McpServerToolsResult,
  PutMyCredentialBody,
  RemoveMcpServerResult,
  RemoveMyCredentialResult,
  UpdateMcpServerBody,
  UpdateMcpServerResult,
} from '@doubulea/shared'

import { request } from './client.js'

// ───────────────────────────── 缓存键 ─────────────────────────────

/** server 列表键（列表 + 详情/工具键的父，见文件头 ③） */
export const MCP_SERVERS_QUERY_KEY = ['mcp', 'servers'] as const

/** 单台 server 的工具列表键（**子键**：一次 `invalidateQueries` 覆盖全树） */
export function mcpServerToolsQueryKey(id: string): readonly [string, string, string, string] {
  return ['mcp', 'servers', id, 'tools'] as const
}

/** 我的凭据清单键（与 server 树独立，见文件头 ③） */
export const MCP_CREDENTIALS_QUERY_KEY = ['mcp', 'credentials'] as const

/**
 * 列表一次取满。
 *
 * 与 `KNOWLEDGE_BASES_PICKER_LIMIT` 同口径（一次取满 100 + 客户端不再分页）：
 * `03` §4.4 的表格没有分页需求，而 `limit` 的上限就是 100（`listMcpServersQuerySchema`）。
 * 超过 100 台时第 100 台之后看不到 —— 这是**写明的边界**（与侧栏会话列表同一条取舍）。
 */
export const MCP_SERVERS_PAGE_LIMIT_MAX = 100

// ───────────────────────────── server 六条 ─────────────────────────────

/** 读 server 列表。排序由后端定（`createdAt asc`，`02` §4.7）—— 前端**不再排一次** */
export function fetchMcpServers(limit: number = MCP_SERVERS_PAGE_LIMIT_MAX): Promise<McpServerListResult> {
  return request<McpServerListResult>(`/api/mcp/servers?offset=0&limit=${limit}`)
}

export function useMcpServers(limit: number = MCP_SERVERS_PAGE_LIMIT_MAX) {
  return useQuery({
    queryKey: [...MCP_SERVERS_QUERY_KEY, 'list', 0, limit] as const,
    queryFn: () => fetchMcpServers(limit),
    placeholderData: keepPreviousData,
  })
}

/** 一次写操作后要失效的全部视图（见文件头 ③ —— **两棵树一起**） */
function invalidateMcpViews(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY })
  void queryClient.invalidateQueries({ queryKey: MCP_CREDENTIALS_QUERY_KEY })
}

/**
 * 注册（`POST /api/mcp/servers`）。
 *
 * ⚠️ 响应是 `{server, test}` 而**不是裸 item**，且 `test.ok === false` **不代表注册失败**
 * （`06` P0-2-2 定案：注册照常成功，这次探测只是一条"顺带告诉你"的信息）。
 * 调用方**不许**因为 `test.ok === false` 就报红 —— 那是一句真话，不是一次失败。
 */
export function useCreateMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateMcpServerBody) =>
      request<McpServerCreateResult>('/api/mcp/servers', { method: 'POST', body }),
    onSuccess: () => invalidateMcpViews(queryClient),
  })
}

/**
 * 改（`PATCH /api/mcp/servers/:id`）。
 *
 * ⚠️ 响应里那条 `credentialSchemaImpact`（**可为 `null`**）是**本次请求特有**的一句提示：
 * "模板改完以后，哪些已存凭据里的值再也用不上了"。它**只提示、绝不自动清理** ——
 * 界面上要说成"以下参数已从模板移除，已填的值不会被使用，如不再需要请到「我的凭据」里清理"
 * （`shared#credentialSchemaImpactSchema` 的原话），而不是"已帮你清理 N 条"。
 *
 * `body` 只带**真改过的字段**（三态与"只发改了的字段"由调用方在
 * `pages/mcp/mcpModel.ts#buildServerUpdateBody` 构造）—— 本函数不做任何裁剪，
 * 避免"api 层悄悄补了个默认值"这种难查的改动。
 */
export function useUpdateMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateMcpServerBody }) =>
      request<UpdateMcpServerResult>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    // 模板变更会让凭据页的 `fields` / `missingKeys` 全变 ⇒ 两棵树一起失效（文件头 ③）
    onSuccess: () => invalidateMcpViews(queryClient),
  })
}

/** 删（`DELETE /api/mcp/servers/:id`）。**被 Agent 绑定时 409**（`agentCount > 0`，界面据此给出"先去编辑页解绑"） */
export function useRemoveMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RemoveMcpServerResult>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateMcpViews(queryClient),
  })
}

/**
 * 连通测试（`POST /:id/test`）—— 用 `useMutation` 而不是 `useQuery`。
 *
 * 它是"按一次测一次"的动作：结果没有任何复用价值（30s 前通不代表现在通），
 * 做成 query 只会引入"按钮点下去读到的其实是缓存"这种最难查的错
 * （与 `useSearchKnowledgeBase` 同一条理由）。
 *
 * ⚠️ **HTTP 恒 200**：`ok:false` 是一条**信息**（这个 server 现在通不通），不是异常
 * ⇒ 就算 `ok:false` 也**不走** `onError`（`onError` 只在 404 / 网络层失败时触发）。
 */
export function useTestMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<McpServerTestResult>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
    // 测试成功会把 `status` 置 OK 并可能刷新工具缓存 ⇒ 列表那一行的状态灯与工具数要跟着变
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY })
    },
  })
}

/**
 * 工具列表（`GET /:id/tools`，P0-2-5）。
 *
 * 两种取法，**别合并成一个函数**（它们是两件语义不同的事）：
 *   · {@link useMcpServerTools} —— **纯读缓存**（`refresh=false`），绝不联网、无副作用；
 *   · {@link fetchMcpServerToolsFresh} —— `?refresh=1`，真去拉一次并落库（"刷新"按钮用）。
 *
 * ⚠️ **拉不到且缓存空 ⇒ 502**（不是 200 空数组）：界面必须把 502 渲染成
 * "拉不到工具列表（我们答不了）"，而**不是**"这个 server 没有工具"（后者是一句真话，
 * 用 `{tools:[], fetchedAt, cached:true}` 承载）。见 `shared#mcpServerToolsResultSchema` 的注释。
 */
export function fetchMcpServerTools(id: string, refresh = false): Promise<McpServerToolsResult> {
  const query = refresh ? '?refresh=1' : ''
  return request<McpServerToolsResult>(`/api/mcp/servers/${encodeURIComponent(id)}/tools${query}`)
}

/** 纯读缓存（有 `staleTime` 掩护：工具列表变化很慢，30s 内不重拉是合理的，见 `queryClient.ts`） */
export function useMcpServerTools(id: string | undefined) {
  return useQuery({
    queryKey: mcpServerToolsQueryKey(id ?? ''),
    queryFn: () => fetchMcpServerTools(id ?? '', false),
    enabled: id !== undefined,
  })
}

/**
 * 真拉一次（`?refresh=1`）。
 *
 * 成功/失败都失效那台 server 的**工具列表子键**：成功 ⇒ 拿到新列表（query 自己会写缓存）；
 * 失败若**有旧缓存** ⇒ 后端回 200 + `cached:true`（"你看到的不是刚拉的"），也要重画。
 * 列表页那一行的 `toolCount` 同理（成功时 `status` 会变 OK）。
 */
export function useRefreshMcpServerTools(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => fetchMcpServerTools(id, true),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: mcpServerToolsQueryKey(id) })
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY })
    },
  })
}

// ───────────────────────────── 凭据三条 ─────────────────────────────

/**
 * 我的凭据清单（`GET /api/mcp/credentials`）。**刻意不分页**（`shared` 的注释写了原因：
 * "未配置的置顶提示"必须跨全部 server 成立，一旦分页提示就只对当前页有效）。
 */
export function useMyCredentials() {
  return useQuery({
    queryKey: MCP_CREDENTIALS_QUERY_KEY,
    queryFn: () => request<McpCredentialListResult>('/api/mcp/credentials'),
  })
}

/**
 * 保存某一台 server 的凭据（`PUT /api/mcp/credentials/:serverId`）。
 *
 * ⚠️ **合并语义**（只动提交里出现的 key），与 Agent `components` 的**整体替换刻意相反**。
 * `body.values` **只带真改过的 key**（由 `pages/mcp/mcpModel.ts#buildCredentialSubmitValues` 构造）：
 * 值不下发（连掩码都没有，`shared#mcpCredentialFieldSchema` 的注释）⇒ 前端**无从回填**
 * ⇒ 若把整张表都提交一遍，用户只改一个 key 时提交的空串会把另一个 key **静默清空**。
 *
 * ⚠️ 空对象是 **400**（"要清空整份凭据请用 DELETE"）—— 所以调用方在
 * "一个 key 都没改"时必须**根本不发这个请求**（按钮禁用），而不是发一个空 `values`。
 */
export function usePutMyCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ serverId, values }: { serverId: string; values: PutMyCredentialBody['values'] }) =>
      request<McpCredentialItem>(`/api/mcp/credentials/${encodeURIComponent(serverId)}`, {
        method: 'PUT',
        body: { values } satisfies PutMyCredentialBody,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_CREDENTIALS_QUERY_KEY })
    },
  })
}

/** 删除我的一份凭据（`DELETE`）。⚠️ **本来就没配 ⇒ 404**（不是幂等 200），界面上要如实说"你没有可删的东西" */
export function useRemoveMyCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (serverId: string) =>
      request<RemoveMyCredentialResult>(`/api/mcp/credentials/${encodeURIComponent(serverId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_CREDENTIALS_QUERY_KEY })
    },
  })
}

// ───────────────────────────── 确认应答（P0-2-10 落地，P0-2-11 接界面）─────────────────────────────

/**
 * 答复一次工具确认（`POST /api/conversations/:id/confirm`，P0-2-10）。
 *
 * ⚠️ **这个请求的全部结果都走 JSON 信封**（`applied:false` 也是 **200**）—— 它是独立于流的一次
 * 普通请求，**绝不**往那条 SSE 流里补帧（`shared#confirmRequestBodySchema` 的注释）。
 *
 * ⚠️ `applied:false` **不是错误**（幂等忽略：那个提问已经不存在了 —— 超时按取消处理完 /
 * 已被答复过 / 这一轮已结束）。它与 `/stop` 的 `signaled:false` 同一条理由：
 * "确认卡刚超时、用户此刻正好点了确认"这个竞态**必然存在**，把它做成 4xx 只会为
 * 一个用户无从理解的竞态弹一条红色报错。
 * ⇒ 调用方对 `applied:false` 要说的是"**这次确认没生效，这一轮已按取消处理**"，
 * 而**不是**"确认失败：请求与当前状态冲突"。
 *
 * ⚠️ **不做成 `useMutation`**：它不是"用户点按钮打开一个弹窗"那类有生命周期的东西，
 * 而是确认卡上两个按钮各自的一次性动作，卡片本地状态已经足够（组件里 `useState` 管
 * "正在提交/已提交"），套一层 mutation 只会让"这个 mutation 属于哪张卡"变得含糊
 * —— 同一屏可能先后出现两张卡（`06` P0-2-10 坑预判 2 的"一闪而过"）。
 */
export function confirmConversation(
  conversationId: string,
  body: { confirmId: string; accepted: boolean },
): Promise<ConfirmConversationResult> {
  return request<ConfirmConversationResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/confirm`,
    { method: 'POST', body },
  )
}
