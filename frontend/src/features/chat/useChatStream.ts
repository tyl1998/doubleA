/**
 * 对话流 Hook（P0-1-32 建；P0-1-33 补"停止"与"断线对齐"）
 *
 * 依据：`docs/03-前端设计.md` §六（"SSE 状态集中在 `useChatStream`（fetch 流解析 → store 分发），
 *      页面组件只读 store"）、§4.1（"**首条消息发送时才创建会话**"、输入区状态机与停止时序、
 *      "断线 → 顶部黄条提示，点击黄条 = 立即拉取历史对齐"）、§五（事件 → UI 映射）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一次发送的完整时序（每一步都在这里，页面不该再拼一遍）
 * ─────────────────────────────────────────────────────────────────────
 * ```
 * ① 同步闸门（`sendGate`）：上一次发送还没结束就直接拒绝 —— 见 `composerState.ts` 的 `createSendGate`
 * ② 正文 trim（空串直接返回，不发请求 —— 与后端 `chatRequestBodySchema` 的 `.min(1)` 同口径）
 * ③ 没有会话 ⇒ `POST /api/conversations` 建一个（`03` §4.1），把新 id 交给页面写进 URL
 *    ⚠️ 这一步失败 ⇒ **整次发送作废**，且**不在界面上留下任何痕迹**（前置失败一个字不落库）
 * ④ store.begin(...)  ← 注意顺序：**流建立之后**才开始画气泡。反过来会让"点发送就出现
 *    两条气泡、然后弹一个错误提示"，而那句话根本没被服务端接受过
 * ⑤ POST /chat + 读完事件流（每帧 `store.apply`）
 * ⑥ 收尾：`done` / `error` 事件由归约层收口；**没有终帧就结束** ⇒ 这里补一条"连接中断"
 *    （`terminated === false`，见 `chatStream.ts` 的文件头）**并亮黄条**
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三类失败，三种处置（别混成一种）
 * ─────────────────────────────────────────────────────────────────────
 * | 失败 | 例子 | 界面 |
 * |------|------|------|
 * | **前置失败**（信封） | 401 / 400 / 404 / 409 只读 / 424 缺凭据 | `send` 返回 `{ok:false}`，**气泡不出现**，正文还给输入框 |
 * | **流内 error 事件** | `CONFLICT`、上游 500 | 归约层把这一轮标红 ⇒ 消息流内错误卡 + **toast**（`03` §五 的 `error` 行），**不亮黄条** |
 * | **连接中断** | 服务端被 kill、代理断开 | 错误卡（`errorSource:'client'`）+ **顶部黄条**（`03` §4.1），**不弹 toast** |
 * 前两种的分界线由后端定（`shared/src/sse.ts` 文件头 ③），前端只需按"**响应是不是事件流**"分流
 * （`api/client.ts#openEventStream` 已经做完了这件事）；后两种的差别（toast vs 黄条）由
 * `streamErrors.ts#shouldToastChatError` 一处判定。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 停止：**时序不在这里写**，只在这里接线
 * ─────────────────────────────────────────────────────────────────────
 * `03` §4.1 的停止时序（点[停止] → POST /stop → 等 `done{STOPPED}` → 5s 未收口才 abort →
 * 随后拉历史对齐）全部落在 `stopController.ts`（纯逻辑、可注入窗口 ⇒ 能被无依赖档断言调用顺序）。
 * 本 hook 只提供它的四个副作用：`requestStop` / `waitSettled`（订阅 store）/ `abort`（那个
 * `AbortController`）/ `align`。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentType, ConversationActive, ConversationItem, MessagePageResult } from '@doubulea/shared'

import {
  conversationMessagesQueryKey,
  createConversation,
  fetchConversationActive,
  flattenMessagePages,
  stopConversation,
  streamChat,
} from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { useChatStreamStore, type DisconnectState } from '../../stores/chatStream.js'
import { decideAlign, type AlignOutcome } from './alignHistory.js'
import { createSendGate } from './composerState.js'
import { reportSseIssue } from './chatStream.js'
import { createStopController, waitForRoundSettled, type StopOutcome } from './stopController.js'
import type { StreamRound } from './roundReducer.js'

/** `send` 的结果：`ok: false` 时调用方应当**把正文还给输入框**（前置失败不留痕迹） */
export type SendOutcome = { ok: true } | { ok: false; error: unknown }

export interface UseChatStreamOptions {
  /** 新建会话成功后回调（页面据此把 id 写进 URL，刷新后仍定位到同一个会话） */
  onConversationCreated?: (conversation: ConversationItem) => void
  /**
   * 智能体类型。**只用于一件事**：断线对齐时要不要先问 `GET /active`
   * （`03` §4.1 只对 TaskAgent 要求"先查 /active 恢复进度视图，再拉历史"）。
   * 默认按 ChatBot 处理 —— 不传时多打一次请求没有任何收益。
   *
   * ⚠️ 取值是 `'CHATBOT' | 'TASK_AGENT'`（`shared/src/agent.ts` 的 `AGENT_TYPES`，
   * 大写蛇形），**不是**界面上的 "ChatBot / TaskAgent" 两个词。按界面的写法判等会静默失配
   * （`tsc` 这次倒是报了出来：`'CHATBOT' | 'TASK_AGENT' | undefined` 与 `'TaskAgent'` 无重叠）。
   */
  agentType?: AgentType
}

export interface UseChatStreamResult {
  /** 当前会话进行中的那一轮（不属于当前会话时为 `null`，见 `stores/chatStream.ts` 的 `streamFor`） */
  round: StreamRound | null
  /** 是否正在生成（输入区的禁用判据） */
  streaming: boolean
  /** `send()` 在飞（含"建会话 + 建流"这段 `round` 还不存在的空窗）—— 状态机的 `sending` */
  sending: boolean
  /** 点了停止、正在 5s 窗口里等收口 —— 状态机的 `stopping` */
  stopping: boolean
  /** 顶部黄条（`03` §4.1 断线）；点击它应当调 {@link UseChatStreamResult.align} */
  disconnect: DisconnectState | null
  /** 发一条消息；返回 `ok:false` 时正文应当还给输入框 */
  send: (text: string) => Promise<SendOutcome>
  /** 点「停止」（时序见 `stopController.ts`）；返回值供页面决定说什么 */
  stop: () => Promise<StopOutcome>
  /**
   * 拉取历史对齐（`03` §4.1："点击黄条 = 立即拉取历史对齐"）。
   * 返回值是**对齐的结论**（服务端存下来了 / 没有这一轮 / 服务端还在生成），页面据此提示；
   * `null` = 还没有会话 id，无从对齐。
   */
  align: () => Promise<AlignOutcome | null>
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
  const disconnect = useChatStreamStore((state) => state.disconnect)

  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  // 同标签页重复发送的**同步**闸门（见 `composerState.ts`）：React 状态更新是异步的，
  // 两次极快的 Enter 都读得到旧草稿 ⇒ 只有同步闸门拦得住"各建一个会话"那种事故
  const sendGate = useMemo(() => createSendGate(), [])

  // 回调/参数走 ref：`send` 的依赖里不该出现调用方每次渲染都新建的函数（否则引用每次都变，
  // 输入区的 `useCallback`/effect 跟着重跑）；`conversationId` 同理 —— 见下面的卸载注释
  const onConversationCreatedRef = useRef(options.onConversationCreated)
  onConversationCreatedRef.current = options.onConversationCreated
  const agentTypeRef = useRef(options.agentType)
  agentTypeRef.current = options.agentType
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  /**
   * 拉历史对齐（`03` §4.1）。**这是"以服务端为准"的唯一实现**，三处都走它：
   * 点黄条、停止收口后、停止信号失败后。
   *
   * 为什么必须有一个"前后对比"：见 `alignHistory.ts` 的文件头 ——
   * 断线那一刻界面上有**两份**同一轮的内容（流式 + 落库），必须有人决定丢哪一份，
   * 而"丢错了"的两种表现（内容凭空消失 / 同一轮渲染两遍）都不报错。
   */
  const align = useCallback(async (): Promise<AlignOutcome | null> => {
    const targetId = conversationIdRef.current
    if (targetId === undefined) return null

    const key = conversationMessagesQueryKey(targetId)
    const before = flattenMessagePages(queryClient.getQueryData<{ pages: MessagePageResult[] }>(key))

    // TaskAgent：先问一句"服务端还在生成吗"（`03` §4.1）。
    // ⚠️ 它失败 ⇒ 当 `null`（未查）继续对齐：`/active` 是断线恢复路上的一步，
    //    它自己失败不该让"对齐历史"这个动作整体失败（用户已经断过一次线了）
    let active: ConversationActive | null = null
    if (agentTypeRef.current === 'TASK_AGENT') {
      try {
        active = await fetchConversationActive(targetId)
      } catch {
        active = null
      }
    }

    // 重拉历史。`invalidateQueries` 会等活跃查询真的重新取完（默认 `refetchType:'active'`），
    // 所以下一行的 `getQueryData` 拿到的就是新数据 —— 用 `refetchQueries` 也行，但那样在
    // "没有活跃查询"时不会建查询，反而更绕
    try {
      await queryClient.invalidateQueries({ queryKey: key })
    } catch {
      // 拉失败 ⇒ 下面的 `after` 与 `before` 相同 ⇒ 判成 `not-persisted`（保留本地那份）。
      // 这是刻意的：**拿不到历史时，绝不说"服务端已经有了"**
    }

    const after = flattenMessagePages(queryClient.getQueryData<{ pages: MessagePageResult[] }>(key))
    const outcome = decideAlign({ before, after, active })
    if (outcome.dropStreamVersion) {
      // 服务端存下来了 ⇒ 丢掉流式版本（否则同一轮会渲染两遍）。注意 `reset()` **不动黄条**：
      // 那是"我已经对齐过"的可见凭据，由调用方（点黄条那一下）显式清
      useChatStreamStore.getState().reset()
    }
    return outcome
  }, [queryClient])
  const alignRef = useRef(align)
  alignRef.current = align

  const send = useCallback(
    async (text: string): Promise<SendOutcome> => {
      const content = text.trim()
      // 空正文：与后端 `.min(1)` 同口径，不发请求（把"必填"的失败留给界面自己判，见 `ChatPage`）
      if (content === '') return { ok: true }

      // ① 同步闸门。**返回 `BUSY` 而不是静默丢弃**：用户打的字不能凭空消失，
      //    页面会把正文还给输入框并提示（`ChatPage#submit` 对 `!outcome.ok` 的处置）
      if (!sendGate.enter()) {
        return {
          ok: false,
          error: new ApiError('BUSY', '上一条消息还在发送中，请稍后再发', 429),
        }
      }

      setSending(true)
      try {
        const store = useChatStreamStore.getState()

        // ③ 没有会话就先建（`03` §4.1：首条消息发送时才创建会话）
        let targetId = conversationIdRef.current
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

        // ④ 开一轮（此后界面上就有两条气泡了 —— 服务端已经接受这次请求）
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
            // 半条回答与完整回答在界面上长得一样，静默接受就是"把故障显示成成功"。
            // 两个通道各司其职：消息流内的错误卡（说"这一轮没成"）+ 顶部黄条（说"点我对齐"）
            useChatStreamStore.getState().fail({
              code: 'NETWORK',
              message: '与服务器的连接中断，已生成的内容保留（可点顶部的提示对齐历史）',
            })
            useChatStreamStore.getState().showDisconnect({ extra: 'NETWORK · 没收到服务端的收口事件' })
          }
          return { ok: true }
        } catch (error) {
          // 读流中途的失败（fetch 之后的异常）与"没收到终帧"同族：这一轮**已经开始过**，
          // 故在消息流内收口，而不是假装它没发生（前置失败在 ③ 里就已经返回了）
          if (!controller.signal.aborted) {
            const code: ClientErrorCode = error instanceof ApiError ? error.code : 'NETWORK'
            const message = error instanceof ApiError ? error.message : '读取回答时连接中断'
            useChatStreamStore.getState().fail({ code, message })
            useChatStreamStore.getState().showDisconnect({ extra: `${code} · ${message}` })
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
      } finally {
        sendGate.leave()
        setSending(false)
      }
    },
    [agentId, queryClient, sendGate],
  )

  /**
   * 停止控制器：**只创建一次**（`useRef`），否则每次渲染都会新建一个 ⇒
   * 里面那个"正在停止"的闸门与 `stopping` 状态每次渲染都被重置，"双击不会发两次请求"立刻失效。
   * 它读的东西全部走 ref（`conversationIdRef` / `abortRef` / `alignRef`）⇒ 闭包不会读到旧值。
   */
  const stopControllerRef = useRef<ReturnType<typeof createStopController> | null>(null)
  if (stopControllerRef.current === null) {
    stopControllerRef.current = createStopController({
      isRunning: () => {
        const state = useChatStreamStore.getState()
        return state.round !== null && state.round.status === 'streaming'
      },
      requestStop: async () => {
        const targetId = conversationIdRef.current
        // `isRunning()` 为真时不可能没有 id（`begin` 只在建出/已有会话时调用），
        // 这里的兜底只为类型安全：宁可报一个明确的错，也不要往 `/undefined/stop` 打请求
        if (targetId === undefined) throw new ApiError('INTERNAL', '没有会话 id，无法停止', 0)
        return stopConversation(targetId)
      },
      waitSettled: (timeoutMs) =>
        waitForRoundSettled(
          {
            subscribe: (listener) => useChatStreamStore.subscribe(listener),
            isSettled: () => {
              const state = useChatStreamStore.getState()
              return state.round === null || state.round.status !== 'streaming'
            },
          },
          timeoutMs,
        ),
      abort: () => {
        abortRef.current?.abort()
      },
      align: async () => {
        await alignRef.current()
      },
    })
  }
  const stopController = stopControllerRef.current

  /**
   * 点「停止」。三条路径（`settled` / `settled-locally` / `stop-request-failed`）走完后，
   * 后两条（**本地主动中断、没有服务端收口**）要亮黄条 —— 因为"本地与库里可能不一致"这件事
   * 只有用户点一下对齐才能消掉（文案见 `streamErrors.ts`）。
   */
  const stop = useCallback(async (): Promise<StopOutcome> => {
    setStopping(true)
    try {
      const outcome = await stopController.stop()
      if (outcome.kind === 'settled-locally') {
        // 窗口内没等到 `done{STOPPED}`：客户端侧把这一轮标成"已停止"（如实标注，不假装收到了确认）
        useChatStreamStore.getState().stoppedLocally()
        useChatStreamStore.getState().showDisconnect({
          extra: `已过 ${Math.round(outcome.timeoutMs / 1000)}s 没等到服务端的收口事件`,
        })
      } else if (outcome.kind === 'stop-request-failed') {
        const message =
          outcome.error instanceof ApiError ? `${outcome.error.code} · ${outcome.error.message}` : '停止信号没能发出去'
        useChatStreamStore.getState().showDisconnect({ extra: message })
      }
      return outcome
    } finally {
      setStopping(false)
    }
  }, [stopController])

  /** 点黄条：对齐历史，然后把黄条收掉（无论对齐结论是什么 —— 用户点它就表示"以服务端为准"） */
  const alignAndClear = useCallback(async (): Promise<AlignOutcome | null> => {
    const outcome = await align()
    useChatStreamStore.getState().clearDisconnect()
    return outcome
  }, [align])

  // 卸载：中断在飞的流 + 清空这一轮。
  //
  // ⚠️ **刻意不依赖 `conversationId`**（早先写成依赖它，会导致一个很难查的 bug）：
  // "没有会话的新会话态"发第一条消息时，`send` 会先建会话、再把 id 写进 URL
  // （`onConversationCreated`）⇒ `conversationId` 从 `undefined` 变成 id ⇒ 依赖变化 ⇒
  // cleanup 立刻把**刚发起的那条流** abort 掉，症状是"第一条消息永远收不到回答、
  // 但第二条起一切正常"。改成空依赖后，切换会话**不会**中断旧流：
  //   · 不串台由 `streamFor` 守卫保证（见 `stores/chatStream.ts`）；
  //   · 用户在流式中切走再切回，反而能看到完整内容（比"切走即中断"更好）。
  // 卸载时连黄条一起收掉：它是"这个页面这一轮"的状态，没人看了就该走
  // （与"对齐后保留黄条"不矛盾：那是有页面在看的时候）。
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
      useChatStreamStore.getState().reset()
      useChatStreamStore.getState().clearDisconnect()
    }
  }, [])

  // 只有"这一轮属于当前会话"时才交给页面渲染（防串台）。
  // ⚠️ `streaming` 也必须用**过滤后**的那一个：否则页面在别的会话里也会被禁用输入区
  const visibleRound = streamFor !== null && streamFor === conversationId ? round : null

  return {
    round: visibleRound,
    streaming: visibleRound !== null && visibleRound.status === 'streaming',
    sending,
    stopping,
    disconnect,
    send,
    stop,
    align: alignAndClear,
  }
}
