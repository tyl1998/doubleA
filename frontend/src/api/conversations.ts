/**
 * 会话接口封装（P0-1-31 建；P0-1-32 补"发消息"这一整条链；P0-1-33 补"停止"与"活跃快照"；
 * P0-1-34 补"列表 / 改名 / 删除"三条 —— 侧栏要用）
 *
 * 依据：`docs/02` §4.5（会话九端点）、§五（SSE 协议）、`docs/03` §4.1（"首条消息发送时才创建会话"、
 *      输入区状态机与停止时序）、`shared/src/conversation.ts`（会话 / 消息 / 停止契约）、
 *      `shared/src/sse.ts`（事件全集）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 信封层级逐个核对过，别照抄邻居（`docs/06` §六 第 ⑭ 条）
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/agents/:id/conversations` | `{ items, total, offset, limit }` |
 * | `POST /api/conversations` | **裸 `ConversationItem`** |
 * | `PATCH /api/conversations/:id` | **裸 `ConversationItem`**（改名，P0-1-34） |
 * | `DELETE /api/conversations/:id` | **裸 `RemoveConversationResult`**（`{ id, agentId, topic, deletedMessages }`，P0-1-34） |
 * | `GET /api/conversations/:id/messages` | `{ items, nextCursor, hasMore }`（**游标**分页） |
 * | `GET /api/conversations/:id/active` | **裸 `ConversationActive`**（含派生的 `streaming`） |
 * | `POST /api/conversations/:id/stop` | **裸 `StopConversationResult`**（`{ id, signaled }`） |
 * | `POST /api/conversations/:id/chat` | **不是 JSON** —— `200 text/event-stream`（见下） |
 * | `POST /api/conversations/:id/regenerate` | 同上（**P1-3**）：`200 text/event-stream`，只是开流前会先撤掉上一轮 |
 *
 * ─────────────────────────────────────────────────────────────────────
 * `chat` 是"两类失败、两个出口"的那一个端点
 * ─────────────────────────────────────────────────────────────────────
 *   · **前置失败**（未登录 401 / 参数 400 / 会话不是我的 404 / 只读 409 / 缺凭据 424）⇒ **JSON 信封**
 *     ⇒ 走 `api/client.ts` 的 `openEventStream`，抛出来的 `ApiError` 与普通接口**一模一样**
 *     （页面可以复用同一套错误提示与 401 收口）；
 *   · **并发冲突**（同会话已有流在跑）⇒ `200 + 事件流里的一帧 error{code:CONFLICT}` ⇒ **走事件**。
 * `shared/src/sse.ts` 文件头 ③ 写了为什么这样分（分界线是"请求/目标"还是"这一轮生成"），
 * 一句话：**别用 `response.ok` 判断这一轮成不成功** —— 200 也可能是失败的收尾。
 *
 * ⚠️ 前置失败**一个字都不落库**（`06` P0-1-26 定案）。所以那种情况下**不该**在界面上留下
 * "我的那条消息"：刷新之后它会消失，而用户没有任何理由认为它不存在过。处置见 `ChatPage`：
 * 把正文**还给输入框**，不让用户重打。
 */

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ConversationActive,
  ConversationItem,
  ConversationListResult,
  MessageItem,
  MessagePageResult,
  RecallConversationResult,
  RemoveConversationResult,
  SetConversationAutoApproveResult,
  SseEvent,
  SteerCancelResult,
  SteerConversationResult,
  StopConversationResult,
} from '@doubulea/shared'

import { openEventStream, request } from './client.js'
import { readChatEventStream, type SseStreamIssue } from '../features/chat/chatStream.js'

// ───────────────────────────── "我在这个智能体名下有多少会话"（P0-1-31 起） ─────────────────────────────

export function agentConversationsQueryKey(agentId: string): readonly [string, string, string] {
  return ['agents', agentId, 'conversations'] as const
}

/**
 * 读"我在这个智能体名下有多少会话"。
 *
 * `limit=1` 是刻意的：这里只要 `total`（后端在**同一个事务**里数出来，`docs/02` §4.5 ③），
 * 把整页会话拉回来只为了丢掉它们，是纯浪费。
 * `agentId === undefined`（新建态 / 弹窗未打开）时**不发请求**。
 *
 * ⚠️ 权限是**第四族**（`docs/02` §4.5 ①）：这个端点是"**我名下**的会话"，不是该智能体的
 * 会话总数 —— 文案必须如实说成"你名下的 N 个"（见 `DeleteAgentModal.tsx` 的口径注释）。
 */
export function useMyConversationCount(agentId: string | undefined) {
  return useQuery({
    queryKey: agentConversationsQueryKey(agentId ?? ''),
    queryFn: () =>
      request<ConversationListResult>(`/api/agents/${encodeURIComponent(agentId ?? '')}/conversations?offset=0&limit=1`),
    enabled: agentId !== undefined,
    select: (data) => data.total,
  })
}

// ───────────────────────────── 会话列表（侧栏，P0-1-34） ─────────────────────────────

/**
 * 侧栏一次取多少条会话。
 *
 * 与 `AGENTS_PAGE_LIMIT_MAX` 同口径（一次取满 100 + 客户端不再分页）：侧栏是**滚动一屏**的
 * 导航控件，给它接一套分页反而要处理"翻页时高亮的那条在哪一页"。超过 100 个会话时第 100 条
 * 之后看不到 —— 这是**写明的边界**，不是漏了（`limit` 的上限就是 100，`shared` 的
 * `listConversationsQuerySchema`）。
 */
export const CONVERSATIONS_PAGE_LIMIT_MAX = 100

// ───────────────────────────── 我的全部会话（跨智能体，P1-15） ─────────────────────────────

/**
 * 「我的全部会话」的缓存键（P1-15 · 聊天主页的会话栏）。
 *
 * ⚠️ **独立于** {@link agentConversationsQueryKey}（那是"我在某个智能体名下"的分栏）：
 * 主页一屏要看**跨智能体**的历史，按智能体拼多次请求会把"服务端一次给全"的排序口径
 * 撕成几段（`子方案/聊天主页与信息架构改造.md` §九：客户端**不合并多次请求**）。
 */
export const MY_CONVERSATIONS_QUERY_KEY = ['conversations', 'mine'] as const

/** 主页会话栏一次取多少条（与 {@link CONVERSATIONS_PAGE_LIMIT_MAX} 同口径：一次取满、客户端不再分页） */
export const MY_CONVERSATIONS_PAGE_LIMIT_MAX = CONVERSATIONS_PAGE_LIMIT_MAX

/**
 * 读"我的全部会话"（`GET /api/conversations`，P1-15；后端已落）。
 *
 * 与 {@link useAgentConversations} **同口径**（服务端同一段查询、只是不按 `agentId` 收窄），
 * 差别只在缓存键 —— 一次消息落库要同时让"跨智能体列表"与"某智能体列表"过期，
 * 故两处 `invalidateQueries` 都要带上（见 {@link invalidateMyConversations}）。
 */
export function useMyConversations(params: { offset?: number; limit?: number } = {}) {
  const offset = params.offset ?? 0
  const limit = params.limit ?? MY_CONVERSATIONS_PAGE_LIMIT_MAX
  const search = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return useQuery({
    queryKey: [...MY_CONVERSATIONS_QUERY_KEY, offset, limit] as const,
    queryFn: () => request<ConversationListResult>(`/api/conversations?${search.toString()}`),
    placeholderData: keepPreviousData,
  })
}

/** 失效「我的全部会话」（改名 / 删除 / 撤回 / 每轮 `done` 都要调；见文件头"两份列表"） */
export function invalidateMyConversations(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: MY_CONVERSATIONS_QUERY_KEY })
}

/**
 * 侧栏列表的缓存键。
 *
 * ⚠️ 它是 {@link agentConversationsQueryKey} 的**子键**，这不是巧合：那个键还承担
 * "这个智能体下我名下的会话总数"（`useMyConversationCount`，删除 Agent 的确认框要用）。
 * 一次消息落库会让**两处同时过期**（总数 + 列表），做成两个互不相干的键就得在每个
 * 会改变它的地方记得失效两次 —— 迟早漏一个，症状是"侧栏多了一条、数字还是旧的"。
 */
export function agentConversationsListQueryKey(agentId: string): readonly [string, string, string, string] {
  return [...agentConversationsQueryKey(agentId), 'list'] as const
}

/** 侧栏列表（`GET /api/agents/:id/conversations`，offset/limit 分页；顺序由服务端定，见 `02` §4.5 ③） */
export function fetchAgentConversations(agentId: string, limit: number): Promise<ConversationListResult> {
  const search = new URLSearchParams({ offset: '0', limit: String(limit) })
  return request<ConversationListResult>(`/api/agents/${encodeURIComponent(agentId)}/conversations?${search.toString()}`)
}

/**
 * 侧栏会话列表。`agentId === ''`（路由参数缺失）时**不发请求**。
 *
 * `keepPreviousData`：切走再切回时列表**不会闪成空白**（骨架屏只在"从来没有过数据"时出现）
 * —— 与 `useAgents` 同款理由。
 */
export function useAgentConversations(agentId: string) {
  return useQuery({
    queryKey: agentConversationsListQueryKey(agentId),
    queryFn: () => fetchAgentConversations(agentId, CONVERSATIONS_PAGE_LIMIT_MAX),
    enabled: agentId !== '',
    placeholderData: keepPreviousData,
  })
}

/**
 * 改名（`PATCH /api/conversations/:id`）。返回**裸 `ConversationItem`**（见文件头的信封表）。
 *
 * 成功后失效 `['agents', agentId, 'conversations']` 整棵子树：改名会改 `updatedAt`
 * 与列表里那一行的标题，同时/或让排序发生变化（服务端的兜底键里没有 `updatedAt`，
 * 但"总数"那个查询与它同前缀，一次失效两处都对齐 → 见 {@link agentConversationsListQueryKey}）。
 */
export function useRenameConversation(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, topic }: { id: string; topic: string }) =>
      request<ConversationItem>(`/api/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { topic },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentConversationsQueryKey(agentId) })
      invalidateMyConversations(queryClient)
    },
  })
}

/**
 * 删除会话（`DELETE /api/conversations/:id`）—— **级联**（`messages` 由外键连带清除，
 * `03` §七 把它归入"级联删除"一档：Modal + 红色危险按钮 + 明示影响范围）。
 *
 * 响应里的 `deletedMessages` 是**删前在同一个事务里数出来的**（`docs/02` §4.5 ②），
 * 所以它只能用于**删完之后**的报告 —— 确认框里给不出准确条数（没有任何端点能数），
 * 那里如实写"全部消息"、不编一个数字（见 `DeleteConversationModal.tsx` 的注释）。
 *
 * 失效 `agentConversationsQueryKey`（列表 + 总数）。**消息历史那棵树交给调用方** ——
 * "删掉的正是当前打开的这个会话"时页面要导航走，由 `ChatPage` 决定怎么收尾。
 */
export function useRemoveConversation(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RemoveConversationResult>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentConversationsQueryKey(agentId) })
      invalidateMyConversations(queryClient)
    },
  })
}

/**
 * 撤回最新一轮（`POST /api/conversations/:id/recall`，产品优化 2026-09-29）。
 *
 * 失效 `agentConversationsQueryKey`（列表 + 总数）：撤回会改 `lastMessageAt` / `topic`，
 * 侧栏的标题与排序都要跟着变。**消息历史与产物面板的失效交给页面**（它才知道
 * `conversationId` 的当前值，也还要处理流式版本 —— 与 `useRemoveConversation` 同款分工）。
 */
export function useRecallLastRound(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RecallConversationResult>(`/api/conversations/${encodeURIComponent(id)}/recall`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentConversationsQueryKey(agentId) })
      invalidateMyConversations(queryClient)
    },
  })
}

// ───────────────────────────── 建会话 ─────────────────────────────

/**
 * 新建会话（`03` §4.1：**首条消息发送时才创建**，进入对话页只是展示开场白）。
 *
 * 刻意**不做成 `useMutation`**：它不是一个"用户点按钮"的动作，而是发送流程里的一个前置步骤
 * （发第一条消息时先建会话、拿到 id 再 POST `/chat`）。做成 mutation 只会让 `ChatPage`
 * 多一层状态，而那个状态的生命周期与"发送"完全重合。
 *
 * 返回**裸 `ConversationItem`**（见文件头的信封表）。
 */
export function createConversation(agentId: string): Promise<ConversationItem> {
  return request<ConversationItem>('/api/conversations', { method: 'POST', body: { agentId } })
}

// ───────────────────────────── 消息历史（游标分页） ─────────────────────────────

export function conversationMessagesQueryKey(conversationId: string): readonly [string, string] {
  return ['conversation', conversationId]
}

/**
 * 取一页消息。
 *
 * `beforeId` 不传 = **最新一页**（对话页首次进入的形态）；传了 = 取比它更早的一页。
 * 游标是**行 id 而不是时间戳**：同一轮问答的两条消息在同一个事务里写入，`created_at` 可能逐字相同
 * （`shared/src/conversation.ts#listMessagesQuerySchema` 的注释）。
 */
export function fetchMessages(conversationId: string, beforeId?: string): Promise<MessagePageResult> {
  const search = new URLSearchParams()
  if (beforeId !== undefined) search.set('beforeId', beforeId)
  const suffix = search.size === 0 ? '' : `?${search.toString()}`
  return request<MessagePageResult>(`/api/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`)
}

/**
 * 消息历史（无限翻页）。
 *
 * ⚠️ **`items` 是时间正序（旧 → 新）**，而 `nextCursor` 指向**更早**的一页
 * ⇒ `pages[0]` 是最新的一页、`pages[n]` 越来越早。渲染前必须 **reverse 页序再 flat**
 * （`flattenMessagePages`）。写反了的症状是"点一次加载更早，消息出现在最下面"——
 * 只在翻第二页时才显形（这正是 `shared` 把这两句话写在一起的原因）。
 *
 * `getNextPageParam` 返回 `undefined` ⟺ `hasMore === false`（契约里两者同真同假，取 `nextCursor`
 * 是因为它就是要传给下一次请求的那个值）。
 */
export function useConversationMessages(conversationId: string | undefined) {
  return useInfiniteQuery({
    queryKey: conversationMessagesQueryKey(conversationId ?? ''),
    queryFn: ({ pageParam }) => fetchMessages(conversationId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: conversationId !== undefined,
  })
}

/** 把无限查询的页按"旧 → 新"展平（见 {@link useConversationMessages} 的 ⚠️） */
export function flattenMessagePages(data: { pages: MessagePageResult[] } | undefined): MessageItem[] {
  if (data === undefined) return []
  return [...data.pages].reverse().flatMap((page) => page.items)
}

// ───────────────────────────── 停止生成（P0-1-33） ─────────────────────────────

/**
 * 停止生成（`POST /api/conversations/:id/stop`，`02` §5.2）。
 *
 * ⚠️ **它只是"发信号"，不代表"已经停了"**：真正收口的那条事件是流里的
 * `done{finishReason:'STOPPED'}`（`shared/src/sse.ts` 文件头 ③）。
 * 前端的停止时序（"POST → 等收口 → 5s 未收口才 abort"）落在
 * `features/chat/stopController.ts`，**页面不许自己排这个顺序**。
 *
 * 幂等：无流在跑时返回 `{ signaled: false }`，**同样是 200**（"流刚好结束"的竞态必然存在，
 * 把 4xx 回给用户只会是一条没有信息量的报错 —— `shared/src/sse.ts` 的 schema 注释）。
 *
 * ⚠️ 这条契约的 schema（`stopConversationResultSchema`）**不在本文件的 import 清单之外**，
 * 而是 P0-1-26 就写好的那一条（在 `shared/src/sse.ts`）—— 本批起初又在
 * `shared/src/conversation.ts` 里写了一份同名的，`pnpm -r typecheck` 立刻报
 * `TS2308: Module './conversation.js' has already exported a member named 'StopConversationResult'`。
 * 那正是 `06` §六 第 ⑰ 条要防的事（同一口径两处写，必有一处先腐烂），只不过这次是在**编译期**
 * 就暴露了 —— 契约类型要重名时，先 grep 一遍 `shared/src` 再动手。
 */
export function stopConversation(conversationId: string): Promise<StopConversationResult> {
  return request<StopConversationResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/stop`,
    { method: 'POST' },
  )
}

// ───────────────────────────── 中途插话（steer，P1-9 · P4 · R1） ─────────────────────────────

/**
 * 向**运行中**的 agent 插一句话（`POST /api/conversations/:id/steer`）。
 *
 * 典型内容是"用户改了 X，请重读"，但契约就是一句普通文本（见 `shared#steerConversationBodySchema`）：
 * 服务端把它写进 `chat.steer:{id}`，由那条流投给引擎的 `steer` 命令（**助手 turn 边界**投递）。
 *
 * 与 {@link stopConversation} **同款语义**：**幂等** —— 没有在跑的流时返回
 * `{ accepted: false }`，**同样是 200**（"流刚好结束"的竞态必然存在，做成 4xx 只会是一条
 * 没有信息量的报错）。`accepted: true` = 这条插话确实写给了一个正在跑的流。
 */
export function steerConversation(conversationId: string, message: string): Promise<SteerConversationResult> {
  return request<SteerConversationResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/steer`,
    { method: 'POST', body: { message } },
  )
}

/**
 * 撤回一条中途插话（`POST /api/conversations/:id/steer/cancel`，**2026-10-21**）。
 *
 * 用户侧 = 插话气泡上的「取回编辑」（只在**还没被模型读走**时提供）。
 * 服务端尽力撤回：`scope:'one'` = 只撤了这一条；`scope:'all'` = 清空了引擎插话队列
 * （同轮其他未投递插话一并作废）；`cancelled:false` = 流已结束 / 已被读走（**不是错误**）。
 */
export function cancelSteerConversation(
  conversationId: string,
  steerId: string,
): Promise<SteerCancelResult> {
  return request<SteerCancelResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/steer/cancel`,
    { method: 'POST', body: { id: steerId } },
  )
}

// ───────────────────────────── 活跃流快照（P0-1-33 起用于断线对齐） ─────────────────────────────
/**
 * 读"这个会话现在有没有流在跑"（`GET /api/conversations/:id/active`，P0-1-25 落地）。
 *
 * P0-1-32 只把它当"会话进度"的形状放着；**P0-1-33 起它有了第一个真消费方**：
 * 断线对齐时先问一句"服务端还在生成吗"（`03` §4.1："TaskAgent 断线先查 `GET /active`
 * （排队位次/当前工具）恢复进度视图，再拉历史"），否则会把"这一侧断了"误判成"这一轮完了"。
 *
 * ⚠️ 刻意**不做成 `useQuery`**：它是一次性"对齐动作的第一步"，不是一个要缓存/要订阅的服务端状态。
 * 做成 query 会引入"对齐时读到的其实是 30s 前的缓存"这种最难查的错
 * （`staleTime: 30s`，`api/queryClient.ts`）。
 */
export function fetchConversationActive(conversationId: string): Promise<ConversationActive> {
  return request<ConversationActive>(
    `/api/conversations/${encodeURIComponent(conversationId)}/active`,
  )
}

// ───────────────────────────── 会话级自动审批开关 ─────────────────────────────

/**
 * 打开 / 关闭**会话级自动审批**（`POST /api/conversations/:id/auto-approve`）。
 *
 * 打开后本会话内危险的 MCP 工具不再逐次弹确认卡（由服务端编排层直接放行）——
 * 面向"一个场景里连续调很多次 MCP、不想一次次点确认"的用法。
 *
 * ⚠️ **不做成 `useMutation`**：它不是"打开弹窗"那类有生命周期的动作，而是对话页头部一个
 * 开关（本地 `useState` 管当前值即可）—— 与 {@link fetchConversationActive} 同款。
 * 响应回带落定后的 `autoApprove`，调用方据此对齐本地状态（与 `/stop` 的 `signaled` 同款：
 * "把请求原样确认一遍"，而不是自己猜服务端有没有写进去）。
 */
export function setConversationAutoApprove(
  conversationId: string,
  enabled: boolean,
): Promise<SetConversationAutoApproveResult> {
  return request<SetConversationAutoApproveResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/auto-approve`,
    { method: 'POST', body: { enabled } },
  )
}

// ───────────────────────────── 发消息（SSE） ─────────────────────────────

export interface StreamChatHandlers {
  /** 每个合法事件（`ping` 也在内 —— 忽略与否是归约层的事） */
  onEvent: (event: SseEvent) => void
  /** 解析异常（形状不对 / 未知事件名）—— 默认由调用方记 warn，不影响这一轮 */
  onIssue?: (issue: SseStreamIssue) => void
}

/**
 * 发一条消息并**把流读完**。
 *
 * 返回 `terminated: false` 表示这一轮**没有正常收口**（没收到 `done`/`error` 就断了），
 * 调用方必须让用户看到（P0-1-33 的断线黄条）—— 静默把半条回答当完整回答是最坏的一种"看起来正常"。
 *
 * ⚠️ `signal` 必须传下去：它同时管着 fetch 与读流。本批在**页面卸载**时中断
 * （否则组件没了、流还在跑，store 里的帧越积越多且没人清）；P0-1-33 的"停止"走
 * `POST /stop` 而不是 abort（`03` §4.1：直接 abort 会丢掉最后一段 delta）。
 */
export async function streamChat(
  conversationId: string,
  content: string,
  handlers: StreamChatHandlers,
  signal?: AbortSignal,
  modelId?: string,
  attachmentFileIds?: readonly string[],
): Promise<Awaited<ReturnType<typeof readChatEventStream>>> {
  const response = await openEventStream(`/api/conversations/${encodeURIComponent(conversationId)}/chat`, {
    // `modelId` 省略 ⇒ 走该会话智能体的默认模型；给了则必须是其模型池成员（后端校验）
    body: {
      content,
      ...(modelId === undefined ? {} : { modelId }),
      // 附件（P1-4）：省略 / 空数组都不带这个键（服务层按"没有附件"处理）
      ...(attachmentFileIds === undefined || attachmentFileIds.length === 0
        ? {}
        : { attachmentFileIds: [...attachmentFileIds] }),
    },
    ...(signal === undefined ? {} : { signal }),
  })
  return readChatEventStream(response, handlers)
}

/**
 * 重新生成最新一轮（`POST /api/conversations/:id/regenerate`，**P1-3**）。
 *
 * 与 {@link streamChat} 同族（同样返回一条要读完的事件流、同样的 `StreamChatHandlers`）：
 * 后端跑的是**同一条 `/chat` 链路**（不新增 SSE 事件），只是开流前会先撤掉上一轮。
 *
 * ⚠️ **不传正文**：后端"重跑最后一轮用户消息"，正文取自库里那条消息
 *（`shared/src/sse.ts#regenerateConversationBodySchema`）。客户端唯一能给的是 `modelId`
 *（换个模型重跑）—— 这也是它与"修改重发"的分工：想改字走撤回/修改重发，这里只重跑。
 */
export async function streamRegenerate(
  conversationId: string,
  handlers: StreamChatHandlers,
  signal?: AbortSignal,
  modelId?: string,
): Promise<Awaited<ReturnType<typeof readChatEventStream>>> {
  const response = await openEventStream(
    `/api/conversations/${encodeURIComponent(conversationId)}/regenerate`,
    {
      body: { ...(modelId === undefined ? {} : { modelId }) },
      ...(signal === undefined ? {} : { signal }),
    },
  )
  return readChatEventStream(response, handlers)
}

/**
 * 观察一条会话的**活跃运行**（`GET /api/conversations/:id/stream`，P1-6 方案 A）。
 *
 * 只读：把该会话此刻正在跑的那一轮的帧读进来（**含迟到补帧**，见后端 `frameBus`），
 * 用于渲染"**不是本页发起的那一轮**"（典型：定时任务的后台运行）。没有活跃运行时这条流只发心跳，
 * 页面可以常开；`terminated` 的口径与 `/chat` 一致（没收到 `done`/`error` 就断了）。
 */
export async function streamConversationWatch(
  conversationId: string,
  handlers: StreamChatHandlers,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof readChatEventStream>>> {
  const response = await openEventStream(`/api/conversations/${encodeURIComponent(conversationId)}/stream`, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  return readChatEventStream(response, handlers)
}
