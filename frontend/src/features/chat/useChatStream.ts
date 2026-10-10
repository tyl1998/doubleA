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
 * ③ **另一个会话正在生成 ⇒ 拒绝**（P0-1-34；前端只有一个轮次槽，见下面那段长注释）
 *    ⚠️ 它必须排在 ④ 之前：放到后面会在"新建会话态"下先建出一个空会话再报错
 * ④ 没有会话 ⇒ `POST /api/conversations` 建一个（`03` §4.1），把新 id 交给页面写进 URL
 *    ⚠️ 这一步失败 ⇒ **整次发送作废**，且**不在界面上留下任何痕迹**（前置失败一个字不落库）
 * ⑤ store.begin(...)  ← 注意顺序：**流建立之后**才开始画气泡。反过来会让"点发送就出现
 *    两条气泡、然后弹一个错误提示"，而那句话根本没被服务端接受过
 * ⑥ POST /chat + 读完事件流（每帧 `store.apply`）
 * ⑦ 收尾：`done` / `error` 事件由归约层收口；**没有终帧就结束** ⇒ 这里补一条"连接中断"
 *    （`terminated === false`，见 `chatStream.ts` 的文件头）**并亮黄条**
 * ```
 *
 * ⚠️ ③ 是 P0-1-34（会话侧栏）带出来的一条**新闸门**，它拦的不是"服务端不允许"，
 * 而是"**本批前端表达不了**"：见 `send` 里那段注释（一个轮次槽 + 淡出的串台）。
 * 它同时是**界面上的第六个状态**（`composerState.ts` 的 `elsewhere`）—— 于是用户在
 * 按下发送之前就知道发不出去，而不是"点了才被告知"。两面都要有：状态机负责"看得见"，
 * 这里负责"拦得住"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三类失败，三种处置（别混成一种）
 * ─────────────────────────────────────────────────────────────────────
 * | 失败 | 例子 | 界面 |
 * |------|------|------|
 * | **前置失败**（信封） | 401 / 400 / 404 / 409 只读 / 424 缺凭据 | `send` 返回 `{ok:false}`，**气泡不出现**，正文还给输入框 |
 * | **前端闸门**（不发请求） | 同标签页重复发送（`BUSY`）、**另一个会话正在生成**（`BUSY`，P0-1-34） | 同上（同一个出口） |
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
  agentConversationsQueryKey,
  conversationMessagesQueryKey,
  createConversation,
  fetchConversationActive,
  flattenMessagePages,
  stopConversation,
  streamChat,
  streamRegenerate,
} from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { conversationArtifactsQueryKey } from '../../api/artifacts.js'
import { useChatStreamStore, type DisconnectState } from '../../stores/chatStream.js'
import { decideAlign, type AlignOutcome } from './alignHistory.js'
import { createSendGate } from './composerState.js'
import { reportSseIssue } from './chatStream.js'
import { createStopController, waitForRoundSettled, type StopOutcome } from './stopController.js'
import type { AttachmentView } from './messageModel.js'
import type { RoundKind, StreamRound } from './roundReducer.js'

/** `send` 的结果：`ok: false` 时调用方应当**把正文还给输入框**（前置失败不留痕迹） */
export type SendOutcome = { ok: true } | { ok: false; error: unknown }

export interface UseChatStreamOptions {
  /**
   * 新建会话成功后回调（页面据此把 id 写进 URL，刷新后仍定位到同一个会话）。
   *
   * ⚠️ **允许返回 `Promise`，hook 会 `await` 它**，且时机卡在"会话已建、流还没开"之间：
   * 页面可借它把"新会话态下预置的会话级开关"（如自动审批）先写到服务端，从而覆盖**第一轮**。
   * 纯同步的收尾（写 URL）照旧不 await 也没问题。
   */
  onConversationCreated?: (conversation: ConversationItem) => void | Promise<void>
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
  /**
   * **哪个**会话此刻在生成（P0-1-34 的侧栏要用它点亮那一条的"生成中"灯）；`null` = 没有。
   *
   * ⚠️ 不能直接拿 `streamFor`：它一直留到这一轮被让位或被清掉（`stores/chatStream.ts`），
   * 于是"刚收口的那条"会多亮几秒。判据与输入区的 `streaming` **同源** —— 只有
   * `status === 'streaming'` 才算在生成（`stopping` 窗口里也是 `streaming`，
   * 那段时间界面**确实**还在等服务端收口，亮着是对的）。
   */
  streamingId: string | null
  /**
   * 发一条消息；返回 `ok:false` 时正文应当还给输入框。`modelId` 省略走智能体默认模型。
   * `attachments` 是**已经上传好的**附件（P1-4）：正文展开成多模态 part / 文本注入由后端做。
   */
  send: (text: string, modelId?: string, attachments?: readonly AttachmentView[]) => Promise<SendOutcome>
  /**
   * 重新生成最新一轮（P1-3；`POST /:id/regenerate`）。
   *
   * `userText` 是**被重跑的那一轮用户消息正文**（页面从历史里取，用来渲染这一轮的流式气泡
   * —— 后端会自己从库里读同一段正文，不接收请求体）。返回 `ok:false` 时页面应给出提示、
   * 并**保留**界面上原有的一轮（后端那一步大概率也没发生）。
   */
  regenerate: (userText: string, modelId?: string) => Promise<SendOutcome>
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

  /**
   * "别的会话正在生成" ⇒ 拒绝（P0-1-34）。`send` 与 `regenerate` **共用这一条判据**
   * （两处各写一遍必然漂移）。返回 `null` = 可以继续。
   *
   * 为什么必须拦：本批的前端只有**一个轮次槽**（`stores/chatStream.ts` 的 `round`）。
   * 侧栏让"切到别的会话再发一条"变成一个很容易的动作，而那时：
   *   · `store.begin(targetId, …)` 会**覆盖**掉另一个会话正在进行的一轮；
   *   · 旧流的帧还在往同一个槽里灌（`apply` 不认识"这一帧属于谁"）。
   * 两者合起来是一个**静默串台**：B 的回答里混进 A 的增量，而两个会话各自看起来
   * 都"有内容"。后端每个会话各有一把锁（允许并行），"同时只能有一条"是本批前端的约束
   * （多流要把 store 改成 `Map`，属后续批次）。
   *
   * ⚠️ 文案要**能照着做**（"等它结束，或到那个会话点停止"），不能只说"不允许"。
   */
  const streamingElsewhere = useCallback((targetId: string | undefined): ApiError | null => {
    const state = useChatStreamStore.getState()
    const running = state.round !== null && state.round.status === 'streaming' ? state.streamFor : null
    if (running === null || running === targetId) return null
    return new ApiError('BUSY', '另一个会话正在生成中：等它结束，或到那个会话点「停止」', 429)
  }, [])

  /** 一次流的"开流参数"（`streamChat` / `streamRegenerate` 的公共形状：URL/body 不同，读流一致） */
  type StreamOpener = (signal: AbortSignal) => Promise<Awaited<ReturnType<typeof streamChat>>>

  /**
   * 开一轮并把流读完 —— `send` 与 `regenerate` **共用的执行段**（P1-3 从 `send` 里抽出）。
   *
   * 两件事在这里，且都**只该有一处**：
   *   · 开一轮（`begin`）→ 读流（`open`）→ 三类失败的处置（没收到终帧 / 读流抛错）；
   *   · 收尾时失效三棵查询（消息历史 / 会话列表 / 产物面板）。
   * 抽出来的理由与 `06` §六 第 ⑰ 条一致：重新生成跑的是**同一条链路**，
   * 两处各写一遍这套收尾，迟早有一处先腐烂（症状：重新生成后侧栏排序不动、或产物面板停在旧数）。
   *
   * `kind` 只影响渲染层（页面据此收起正在被替换的一轮），事件归约与收尾逐字同款。
   */
  const performStream = useCallback(
    async (
      targetId: string,
      content: string,
      kind: RoundKind,
      open: StreamOpener,
      userAttachments: readonly AttachmentView[] = [],
    ): Promise<SendOutcome> => {
      // 开一轮（此后界面上就有两条气泡了 —— 服务端已经接受这次请求）
      const controller = new AbortController()
      abortRef.current?.abort()
      abortRef.current = controller
      useChatStreamStore.getState().begin(targetId, content, new Date().toISOString(), kind, userAttachments)

      try {
        const result = await open(controller.signal)

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
        // 故在消息流内收口，而不是假装它没发生（前置失败在调用方那儿就已经返回了）
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
        // 侧栏（P0-1-34）的排序键是 `last_message_at`，而它**正是这一轮落库时才被推进的**
        // （`02` §4.5 ④ 的唯一写入口 `touchConversation`）⇒ 不在这里失效，刚说过话的会话
        // 就不会冒到「今天」那一组的最前面 —— 这正是 P0-1-34 的坑预判原文
        //（`03` §五 的 `done` 行："**刷新会话列表排序**"）。
        // 放在 `finally` 而不是 `done` 那一支：中断/断线的一轮**也可能落库**，
        // 而"没落库"时多拉一次列表的代价只是一次几十行的查询（`03` §五 的 `done` 行是下限，不是上限）。
        void queryClient.invalidateQueries({ queryKey: agentConversationsQueryKey(agentId) })
        // 产物面板（P0-3-11）也是"这一轮真的发生过 ⇒ 库里可能多了几行"。它**没有**
        // `last_message_at` 那种排序副作用，但面板上那一条要从"刚生成"变成真正的时刻读数
        // （`artifactPanelModel#artifactTimeText` 的 `live` 那一档），靠的就是这份列表重取回来。
        // ⚠️ 非 TaskAgent 时这个查询**根本没建**（`enabled: false`）⇒ 这一行是空转、
        // 不多打请求；写在这里而不是在 TaskAgent 分支里，是为了让"一轮结束要失效什么"
        // 只出现在一个地方（漏一处就是这个面板停在旧数据上的那种静默错）。
        void queryClient.invalidateQueries({ queryKey: conversationArtifactsQueryKey(targetId) })
      }
    },
    [agentId, queryClient],
  )

  const send = useCallback(
    async (text: string, modelId?: string, attachments: readonly AttachmentView[] = []): Promise<SendOutcome> => {
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
        // ③ 别的会话正在生成 ⇒ 拒绝（见 `streamingElsewhere`）。
        // ⚠️ 它排在 `createConversation` **之前**：放到后面会在"新建会话态"下先建出一个
        //    空会话再报错（用户侧栏里凭空多一条"新会话"）。
        const busy = streamingElsewhere(conversationIdRef.current)
        if (busy !== null) return { ok: false, error: busy }

        // ④ 没有会话就先建（`03` §4.1：首条消息发送时才创建会话）
        let targetId = conversationIdRef.current
        if (targetId === undefined) {
          let created: ConversationItem
          try {
            created = await createConversation(agentId)
          } catch (error) {
            return { ok: false, error }
          }
          targetId = created.id
          // ⚠️ **await**：回调可能在开流前要落一步服务端写（如新会话态预置的自动审批，
          //    见 `UseChatStreamOptions.onConversationCreated`）。放在 `performStream` 之前，
          //    才能保证第一轮生效 —— 否则首轮的危险工具会先弹一次确认卡。
          await onConversationCreatedRef.current?.(created)
        }

        // ⑤ 开一轮并读完流
        return await performStream(
          targetId,
          content,
          'send',
          (signal) =>
            streamChat(
              targetId,
              content,
              {
                onEvent: (event) => useChatStreamStore.getState().apply(event),
                // 形状不对 = 两侧契约漂了（后端每帧都过同一份 schema）。**只记不改这一轮**：
                // 丢一帧的代价远小于"把已经渲染好的回答改花"，而线索必须留下（见 `reportSseIssue`）
                onIssue: reportSseIssue,
              },
              signal,
              modelId,
              attachments.map((item) => item.fileId),
            ),
          attachments,
        )
      } finally {
        sendGate.leave()
        setSending(false)
      }
    },
    [agentId, performStream, sendGate, streamingElsewhere],
  )

  /**
   * 重新生成最新一轮（P1-3）。
   *
   * 与 `send` 的**两处刻意不同**：
   *   · **不建会话**：重新生成只在"已有会话 + 有已落库的一轮"时提供，没有会话就直接拒绝
   *     （不去建一个空会话 —— 那会凭空多出一条侧栏项）；
   *   · **不校验 `content` 长度**：正文来自历史里那条消息（后端也会自己从库里读同一段），
   *     这里只用它渲染这一轮的气泡。空正文只是"这轮没什么可重跑"，拒绝即可。
   *
   * 其余（同步闸门 / 别处正在生成 / 三类失败 / 三处失效）全部复用 {@link performStream}。
   */
  const regenerate = useCallback(
    async (userText: string, modelId?: string): Promise<SendOutcome> => {
      const content = userText.trim()
      const targetId = conversationIdRef.current
      if (targetId === undefined) {
        return { ok: false, error: new ApiError('VALIDATION', '还没有会话，无法重新生成', 0) }
      }
      if (content === '') {
        return { ok: false, error: new ApiError('VALIDATION', '这一轮没有可重新生成的正文', 0) }
      }
      if (!sendGate.enter()) {
        return { ok: false, error: new ApiError('BUSY', '上一条消息还在发送中，请稍后再发', 429) }
      }

      setSending(true)
      try {
        const busy = streamingElsewhere(targetId)
        if (busy !== null) return { ok: false, error: busy }

        return await performStream(targetId, content, 'regenerate', (signal) =>
          streamRegenerate(
            targetId,
            {
              onEvent: (event) => useChatStreamStore.getState().apply(event),
              onIssue: reportSseIssue,
            },
            signal,
            modelId,
          ),
        )
      } finally {
        sendGate.leave()
        setSending(false)
      }
    },
    [performStream, sendGate, streamingElsewhere],
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

  /** 见 {@link UseChatStreamResult.streamingId}：判据与 `streaming` 同源，但**不过滤会话** */
  const streamingId = streamFor !== null && round !== null && round.status === 'streaming' ? streamFor : null

  return {
    round: visibleRound,
    streaming: visibleRound !== null && visibleRound.status === 'streaming',
    sending,
    stopping,
    disconnect,
    streamingId,
    send,
    regenerate,
    stop,
    align: alignAndClear,
  }
}
