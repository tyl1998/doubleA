/**
 * 对话流 Hook（P0-1-32）
 *
 * 依据：`docs/03-前端设计.md` §六（"SSE 状态集中在 `useChatStream`（fetch 流解析 → store 分发），
 *      页面组件只读 store"）、§4.1（"**首条消息发送时才创建会话**"）、§五（事件 → UI 映射）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一次发送的完整时序（每一步都在这里，页面不该再拼一遍）
 * ─────────────────────────────────────────────────────────────────────
 * ```
 * ① 正文 trim（空串直接返回，不发请求 —— 与后端 `chatRequestBodySchema` 的 `.min(1)` 同口径）
 * ② 没有会话 ⇒ `POST /api/conversations` 建一个（`03` §4.1），把新 id 交给页面写进 URL
 *    ⚠️ 这一步失败 ⇒ **整次发送作废**，且**不在界面上留下任何痕迹**（前置失败一个字不落库）
 * ③ store.begin(...)  ← 注意顺序：**流建立之后**才开始画气泡。反过来会让"点发送就出现
 *    两条气泡、然后弹一个错误提示"，而那句话根本没被服务端接受过
 * ④ POST /chat + 读完事件流（每帧 `store.apply`）
 * ⑤ 收尾：`done` / `error` 事件由归约层收口；**没有终帧就结束** ⇒ 这里补一条"连接中断"
 *    （`terminated === false`，见 `chatStream.ts` 的文件头）
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三类失败，三种处置（别混成一种）
 * ─────────────────────────────────────────────────────────────────────
 * | 失败 | 例子 | 界面 |
 * |------|------|------|
 * | **前置失败**（信封） | 401 / 400 / 404 / 409 只读 / 424 缺凭据 | `send` 返回 `{ok:false}`，**气泡不出现**，正文还给输入框 |
 * | **流内 error 事件** | `CONFLICT`、上游 500 | 归约层把这一轮标红 ⇒ 消息流内错误卡（`03` §五 的 `error` 行） |
 * | **连接中断** | 服务端被 kill、代理断开 | 同上（补一条 `NETWORK` 错误卡）—— 它**不能静默**：半条回答不是完整回答 |
 * 前两种的分界线由后端定（`shared/src/sse.ts` 文件头 ③），前端只需按"**响应是不是事件流**"分流
 * （`api/client.ts#openEventStream` 已经做完了这件事）。
 *
 * ⚠️ **本批不做停止与断线恢复**（属 P0-1-33）：这里只保证"卸载/切会话时中断 + 收口"。
 * 停止的正确时序是"点停止 → `POST /stop` → 等 `done{STOPPED}` → 5s 未收口才 abort"，
 * 直接 abort 会丢掉最后一段 delta（`03` §4.1）。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import type { ConversationItem } from '@doubulea/shared'

import { conversationMessagesQueryKey, createConversation, streamChat } from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { useChatStreamStore } from '../../stores/chatStream.js'
import { reportSseIssue } from './chatStream.js'
import type { StreamRound } from './roundReducer.js'

/** `send` 的结果：`ok: false` 时调用方应当**把正文还给输入框**（前置失败不留痕迹） */
export type SendOutcome = { ok: true } | { ok: false; error: unknown }

export interface UseChatStreamOptions {
  /** 新建会话成功后回调（页面据此把 id 写进 URL，刷新后仍定位到同一个会话） */
  onConversationCreated?: (conversation: ConversationItem) => void
}

export interface UseChatStreamResult {
  /** 当前会话进行中的那一轮（不属于当前会话时为 `null`，见 `stores/chatStream.ts` 的 `streamFor`） */
  round: StreamRound | null
  /** 是否正在生成（输入区的禁用判据） */
  streaming: boolean
  /** 发一条消息；返回 `ok:false` 时正文应当还给输入框 */
  send: (text: string) => Promise<SendOutcome>
}

export function useChatStream(
  agentId: string,
  conversationId: string | undefined,
  options: UseChatStreamOptions = {},
): UseChatStreamResult {
  // 只订阅"这一轮"与"这一轮属于谁"两个字段：**不要**在 hook 里 `useChatStreamStore()`
  // 整取（zustand v5 用 `useSyncExternalStore` 严格比较，返回新对象会无限重渲染）
  const round = useChatStreamStore((state) => state.round)
  const streamFor = useChatStreamStore((state) => state.streamFor)

  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()
  // 回调走 ref：`send` 的依赖里不该出现调用方每次渲染都新建的函数（否则 `send` 的引用每次都变，
  // 输入区的 `useCallback`/effect 跟着重跑）
  const onConversationCreatedRef = useRef(options.onConversationCreated)
  onConversationCreatedRef.current = options.onConversationCreated

  const send = useCallback(
    async (text: string): Promise<SendOutcome> => {
      const content = text.trim()
      // 空正文：与后端 `.min(1)` 同口径，不发请求（把"必填"的失败留给界面自己判，见 `ChatPage`）
      if (content === '') return { ok: true }

      const store = useChatStreamStore.getState()

      // ② 没有会话就先建（`03` §4.1：首条消息发送时才创建会话）
      let targetId = conversationId
      if (targetId === undefined) {
        let created: ConversationItem
        try {
          created = await createConversation(agentId)
        } catch (error) {
          return { ok: false, error }
        }
        targetId = created.id
        onConversationCreatedRef.current?.(created)
      }

      // ③ 开一轮（此后界面上就有两条气泡了 —— 服务端已经接受这次请求）
      const controller = new AbortController()
      abortRef.current?.abort()
      abortRef.current = controller
      store.begin(targetId, content, new Date().toISOString())

      try {
        const result = await streamChat(
          targetId,
          content,
          {
            onEvent: (event) => useChatStreamStore.getState().apply(event),
            // 形状不对 = 两侧契约漂了（后端每帧都过同一份 schema）。**只记不改这一轮**：
            // 丢一帧的代价远小于"把已经渲染好的回答改花"，而线索必须留下（见 `reportSseIssue`）
            onIssue: reportSseIssue,
          },
          controller.signal,
        )

        if (!result.terminated && !controller.signal.aborted) {
          // 流没给终帧就结束了（服务端被 kill / 代理断开）。**必须让用户看到**：
          // 半条回答与完整回答在界面上长得一样，静默接受就是"把故障显示成成功"
          useChatStreamStore.getState().fail({
            code: 'NETWORK',
            message: '与服务器的连接中断，已生成的内容保留（可刷新页面对齐历史）',
          })
        }
        return { ok: true }
      } catch (error) {
        // 读流中途的失败（fetch 之后的异常）与"没收到终帧"同族：这一轮**已经开始过**，
        // 故在消息流内收口，而不是假装它没发生（前置失败在 ②/上面那一句里就已经返回了）
        if (!controller.signal.aborted) {
          const code: ClientErrorCode = error instanceof ApiError ? error.code : 'NETWORK'
          const message = error instanceof ApiError ? error.message : '读取回答时连接中断'
          useChatStreamStore.getState().fail({ code, message })
        }
        return { ok: true }
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        // 这一轮真的发生过 ⇒ 库里可能多了消息（`02` §5.2："中断/故障照样落库"）
        // ⇒ 让历史失效，下次读到的就是落库后的版本。
        // ⚠️ **不做这件事的后果很隐蔽**：`staleTime` 是 30s（`api/queryClient.ts`），
        // 用户在 30s 内切走再切回对话页，会看到**流式那一轮凭空消失**的旧历史。
        void queryClient.invalidateQueries({ queryKey: conversationMessagesQueryKey(targetId) })
      }
    },
    [agentId, conversationId, queryClient],
  )

  // 卸载：中断在飞的流 + 清空这一轮。
  //
  // ⚠️ **刻意不依赖 `conversationId`**（早先写成依赖它，会导致一个很难查的 bug）：
  // "没有会话的新会话态"发第一条消息时，`send` 会先建会话、再把 id 写进 URL
  // （`onConversationCreated`）⇒ `conversationId` 从 `undefined` 变成 id ⇒ 依赖变化 ⇒
  // cleanup 立刻把**刚发起的那条流** abort 掉，症状是"第一条消息永远收不到回答、
  // 但第二条起一切正常"。改成空依赖后，切换会话**不会**中断旧流：
  //   · 不串台由 `streamFor` 守卫保证（见 `stores/chatStream.ts`）；
  //   · 用户在流式中切走再切回，反而能看到完整内容（比"切走即中断"更好）。
  // 真正的"停止"属 P0-1-33（先 `POST /stop`、等 5s 收口、再 abort 的时序）。
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
      useChatStreamStore.getState().reset()
    }
  }, [])

  // 只有"这一轮属于当前会话"时才交给页面渲染（防串台）。
  // ⚠️ `streaming` 也必须用**过滤后**的那一个：否则页面在别的会话里也会被禁用输入区
  const visibleRound = streamFor !== null && streamFor === conversationId ? round : null

  return {
    round: visibleRound,
    streaming: visibleRound !== null && visibleRound.status === 'streaming',
    send,
  }
}
