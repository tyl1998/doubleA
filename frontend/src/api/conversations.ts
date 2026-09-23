/**
 * 会话接口封装（P0-1-31 建；P0-1-32 补"发消息"这一整条链）
 *
 * 依据：`docs/02` §4.5（会话九端点）、§五（SSE 协议）、`docs/03` §4.1（"首条消息发送时才创建会话"）、
 *      `shared/src/conversation.ts`（会话 / 消息契约）、`shared/src/sse.ts`（事件全集）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 信封层级逐个核对过，别照抄邻居（`docs/06` §六 第 ⑭ 条）
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/agents/:id/conversations` | `{ items, total, offset, limit }` |
 * | `POST /api/conversations` | **裸 `ConversationItem`** |
 * | `GET /api/conversations/:id/messages` | `{ items, nextCursor, hasMore }`（**游标**分页） |
 * | `POST /api/conversations/:id/chat` | **不是 JSON** —— `200 text/event-stream`（见下） |
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

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type {
  ConversationItem,
  ConversationListResult,
  MessageItem,
  MessagePageResult,
  SseEvent,
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
): Promise<Awaited<ReturnType<typeof readChatEventStream>>> {
  const response = await openEventStream(`/api/conversations/${encodeURIComponent(conversationId)}/chat`, {
    body: { content },
    ...(signal === undefined ? {} : { signal }),
  })
  return readChatEventStream(response, handlers)
}
