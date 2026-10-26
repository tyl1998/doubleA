/**
 * 对话流 Hook（P0-1-32 建；P0-1-33 补"停止"与"断线对齐"；**P1-19 多流**）
 *
 * 依据：`docs/03-前端设计.md` §六（"SSE 状态集中在 `useChatStream`（fetch 流解析 → store 分发），
 *      页面组件只读 store"）、§4.1（"**首条消息发送时才创建会话**"、输入区状态机与停止时序、
 *      "断线 → 顶部黄条提示，点击黄条 = 立即拉取历史对齐"）、§五（事件 → UI 映射）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一次发送的完整时序（每一步都在这里，页面不该再拼一遍）
 * ─────────────────────────────────────────────────────────────────────
 * ```
 * ① 同步闸门（`sendGate`，**按会话**）：上一次发送还没结束就直接拒绝 —— 见 `composerState.ts#createSendGate`
 * ② 正文 trim（空串直接返回，不发请求 —— 与后端 `chatRequestBodySchema` 的 `.min(1)` 同口径）
 * ③ 没有会话 ⇒ `POST /api/conversations` 建一个（`03` §4.1），把新 id 交给页面写进 URL
 *    ⚠️ 这一步失败 ⇒ **整次发送作废**，且**不在界面上留下任何痕迹**（前置失败一个字不落库）
 * ④ store.begin(conversationId, ...)  ← 注意顺序：**流建立之后**才开始画气泡
 * ⑤ POST /chat + 读完事件流（每帧 `store.apply(conversationId, ...)`）
 * ⑥ 收尾：`done` / `error` 事件由归约层收口；**没有终帧就结束** ⇒ 这里补一条"连接中断"
 *    （`terminated === false`，见 `chatStream.ts` 的文件头）**并亮黄条**
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ P1-19：每个会话各有一条流（不再"一个轮次槽"）
 * ─────────────────────────────────────────────────────────────────────
 * 早先前端**只有一个轮次槽**（`stores/chatStream.ts` 的 `round`），于是"在 A 里发消息、没等
 * 收口就切到 B"会串台，处置是**拦住**（第六态 `elsewhere` + `send` 的 `BUSY` 闸门，P0-1-34）。
 * 代价是"只要 A 还在跑（TaskAgent 动辄数分钟），B 就一直发不出消息"（用户报的"切过去卡住"）。
 *
 * 现在 store 按会话存（`rounds[conversationId]`），本 hook 的每一处副作用也都**按会话**：
 *   · **闸门**（`createSendGate`）与"发送中 / 停止中"标记 ⇒ `Map<conversationId, …>`；
 *   · **abort 控制器** ⇒ `Map<conversationId, AbortController>`（在 B 里发消息**不会**掐掉 A 的那条）；
 *   · 事件的 `begin`/`apply`/`fail`/`showDisconnect` 都带 `conversationId`（每个流的 `onEvent`
 *     闭包各自捕获自己的 `targetId` —— 这是"不串台"的关键）。
 * 于是"另一条流在跑"不再是**拦阻条件**，`elsewhere` 整个概念随之消失。
 *
 * ⚠️ 本 hook 仍然是"**当前会话**的那一条"：`send`/`stop`/`steer`/`align` 都作用于
 * `conversationIdRef.current`（页面一次只看一个会话，只能对它操作）。别的会话的流由它自己的
 * `onEvent` 闭包继续推进 store，切回去就能看到。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三类失败，三种处置（别混成一种）
 * ─────────────────────────────────────────────────────────────────────
 * | 失败 | 例子 | 界面 |
 * |------|------|------|
 * | **前置失败**（信封） | 401 / 400 / 404 / 409 只读 / 424 缺凭据 | `send` 返回 `{ok:false}`，**气泡不出现**，正文还给输入框 |
 * | **前端闸门**（不发请求） | 同会话重复发送（`BUSY`） | 同上（同一个出口） |
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
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentType,
  ConversationActive,
  ConversationItem,
  ConversationRunOrigin,
  MessagePageResult,
} from '@doubulea/shared'

import {
  agentConversationsQueryKey,
  conversationMessagesQueryKey,
  createConversation,
  fetchConversationActive,
  flattenMessagePages,
  invalidateMyConversations,
  cancelSteerConversation,
  steerConversation,
  stopConversation,
  streamChat,
  streamRegenerate,
} from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { conversationArtifactsQueryKey } from '../../api/artifacts.js'
import { conversationInstanceQueryKey } from '../../api/workspace.js'
import {
  disconnectOf,
  roundOf,
  useChatStreamStore,
  type DisconnectState,
} from '../../stores/chatStream.js'
import { decideAlign, type AlignOutcome } from './alignHistory.js'
import { createSendGate } from './composerState.js'
import { reportSseIssue } from './chatStream.js'
import { createStopController, waitForRoundSettled, type StopOutcome } from './stopController.js'
import type { AttachmentView } from './messageModel.js'
import type { RoundKind, StreamRound } from './roundReducer.js'

/** `send` 的结果：`ok: false` 时调用方应当**把正文还给输入框**（前置失败不留痕迹） */
export type SendOutcome = { ok: true } | { ok: false; error: unknown }

/**
 * `steer`（中途插话，P1-9 · P4 · R1）的结果。
 *
 * `accepted: false` **不是错误**（幂等）：当前没有在跑的流 —— 与 `stopConversation` 的
 * `signaled: false` 同款。`ok: false` 才是真失败（网络 / 信封错误），调用方给一句提示并把正文还回输入框。
 */
export type SteerOutcome = { ok: true; accepted: boolean } | { ok: false; error: unknown }

/**
 * `cancelSteer`（撤回插话，2026-10-21）的结果。
 *
 * `cancelled:false` **不是错误**（幂等）：流刚好结束 / 这条已被模型读走。
 * `scope:'all'` = 引擎侧队列被整体清空（同轮其他未投递插话一并作废，见 `shared#steerCancelResultSchema`）。
 */
export type CancelSteerOutcome =
  | { ok: true; cancelled: boolean; scope: 'one' | 'all' }
  | { ok: false; error: unknown }

/**
 * "新会话态"在闸门 / 发送中标记里用的**哨兵键**（`conversationId` 还是 `undefined` 时）。
 * 空串与任何真实会话 id（uuid）都不可能相等 ⇒ 可安全当键。会话一建出来就**转**到真 id 上
 * （见 `send`），否则"发完首条的会话还在跑"会一直占着这个键、把后续新会话挡住。
 */
const NEW_CONVERSATION_KEY = ''

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
  /** 当前会话进行中的那一轮（别的会话的轮次不在这里，见 `stores/chatStream.ts`） */
  round: StreamRound | null
  /** 当前会话是否正在生成（输入区的禁用判据） */
  streaming: boolean
  /** `send()` 在飞（含"建会话 + 建流"这段 `round` 还不存在的空窗）—— 状态机的 `sending` */
  sending: boolean
  /** 点了停止、正在 5s 窗口里等收口 —— 状态机的 `stopping` */
  stopping: boolean
  /** 当前会话的顶部黄条（`03` §4.1 断线）；点击它应当调 {@link UseChatStreamResult.align} */
  disconnect: DisconnectState | null
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
   * 中途插话（P1-9 · P4 · R1）：向**运行中**的 agent 插一句话（`POST /:id/steer`）。
   *
   * **P1-20 起两种会话都支持**：TaskAgent 投给沙箱 pi 引擎（bridge `steer` 命令）；ChatBot 在
   * **下一次上游调用前**注入（producer 已注册 steer 监听器）。投递时机 = **助手 turn 边界**
   * （见 `docs/子方案/Code模式工作区.md` §十五）。出口层还会回发一帧 `steer` ⇒ 界面看得到这条插话。
   * 返回 `{ ok:true, accepted:false }` = 流刚好结束（**幂等，不是错误**）。
   */
  steer: (message: string) => Promise<SteerOutcome>
  /**
   * 撤回一条插话（2026-10-21；插话气泡上的「取回编辑」）。
   * 只在**还没被模型读走**时提供入口（判据在前端：`steerState === 'queued'`）。
   * 成功时同步把本轮插话清单里对应条目移除（`scope:'all'` 时移除所有未投递的）。
   */
  cancelSteer: (steerId: string) => Promise<CancelSteerOutcome>
  /**
   * 拉取历史对齐（`03` §4.1："点击黄条 = 立即拉取历史对齐"）。
   * 返回值是**对齐的结论**（服务端存下来了 / 没有这一轮 / 服务端还在生成），页面据此提示；
   * `null` = 还没有会话 id，无从对齐。
   */
  align: () => Promise<AlignOutcome | null>
}

/**
 * "别处正在跑，本页发不出去"的那句话（2026-10-22）。
 *
 * 与页面头部标签（`ChatPage#serverRunLabel`）**同一套来源**：用户看到的提示与状态必须对得上，
 * 否则"头部说定时任务、toast 说外部调用"又是一处新的自相矛盾。
 */
function runOriginBusyMessage(origin: ConversationRunOrigin | null): string {
  switch (origin) {
    case 'SCHEDULED':
      return '定时任务正在运行这个会话，等它跑完再发（可在任务中心查看）'
    case 'OPEN_API':
      return '外部系统正在通过开放接口运行这个会话，等它跑完再发'
    case 'UI':
      return '另一个窗口正在生成这个会话的回答，等它跑完再发'
    default:
      return '这个会话正在生成中（不是本页发起），等它跑完再发'
  }
}

export function useChatStream(
  agentId: string,
  conversationId: string | undefined,
  options: UseChatStreamOptions = {},
): UseChatStreamResult {
  // 只订阅"这个会话的那一轮"与"这个会话的黄条"：**不要**在 hook 里 `useChatStreamStore()` 整取
  //（zustand v5 用 `useSyncExternalStore` 严格比较，返回新对象会无限重渲染）。两个 selector 都
  // 返回**稳定引用**（没变就是同一个对象 / `null`）。
  const round = useChatStreamStore((state) => roundOf(state, conversationId))
  const disconnect = useChatStreamStore((state) => disconnectOf(state, conversationId))

  // 每个会话各一个 abort 控制器（多流：在 B 里发消息不该掐掉 A 的那条）
  const abortRef = useRef(new Map<string, AbortController>())
  const queryClient = useQueryClient()

  // 同步闸门按会话各一把（见 `send`）：同一会话别发两遍，不同会话互不阻塞
  const sendGatesRef = useRef(new Map<string, ReturnType<typeof createSendGate>>())
  const gateFor = useCallback((key: string): ReturnType<typeof createSendGate> => {
    const existing = sendGatesRef.current.get(key)
    if (existing !== undefined) return existing
    const created = createSendGate()
    sendGatesRef.current.set(key, created)
    return created
  }, [])

  // "发送中 / 停止中"也按会话记（否则在 A 里发送中时切到 B，B 的输入区会被误判成 sending/stopping）
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [stoppingKeys, setStoppingKeys] = useState<ReadonlySet<string>>(() => new Set<string>())
  const markSending = useCallback((key: string): void => {
    setSendingKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])
  const unmarkSending = useCallback((key: string): void => {
    setSendingKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])
  const markStopping = useCallback((key: string): void => {
    setStoppingKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])
  const unmarkStopping = useCallback((key: string): void => {
    setStoppingKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

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
      useChatStreamStore.getState().reset(targetId)
    }
    return outcome
  }, [queryClient])
  const alignRef = useRef(align)
  alignRef.current = align

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
   * ⚠️ 事件走 `apply(targetId, …)` —— 这个闭包捕获的就是**本流**的会话（多流不串台的关键）。
   */
  const performStream = useCallback(
    async (
      targetId: string,
      content: string,
      kind: RoundKind,
      open: StreamOpener,
      userAttachments: readonly AttachmentView[] = [],
    ): Promise<SendOutcome> => {
      // 开一轮（此后界面上就有两条气泡了 —— 服务端已经接受这次请求）。
      // ⚠️ 只 abort **同一个会话**上一条还没收尾的控制器（多流下不能顺手掐别的会话）
      const controller = new AbortController()
      abortRef.current.get(targetId)?.abort()
      abortRef.current.set(targetId, controller)
      // 本轮的身份：`begin` 与收尾共用同一时刻（`serverRun` 那一格的收口判据是**来源**，
      // 见 `releaseOwnRun`，但这个时刻仍是会话栏"已用时"的起点）
      const startedAt = new Date().toISOString()
      useChatStreamStore.getState().begin(targetId, content, startedAt, kind, userAttachments)

      /** 这一轮**有没有收到终帧**（`done`/`error`）—— 决定收尾时能不能把 `serverRun` 一起收掉，见 `finally` */
      let terminated = false

      try {
        const result = await open(controller.signal)
        terminated = result.terminated

        if (!result.terminated && !controller.signal.aborted) {
          // 流没给终帧就结束了（服务端被 kill / 代理断开）。**必须让用户看到**：
          // 半条回答与完整回答在界面上长得一样，静默接受就是"把故障显示成成功"。
          // 两个通道各司其职：消息流内的错误卡（说"这一轮没成"）+ 顶部黄条（说"点我对齐"）
          useChatStreamStore.getState().fail(targetId, {
            code: 'NETWORK',
            message: '与服务器的连接中断，已生成的内容保留（可点顶部的提示对齐历史）',
          })
          useChatStreamStore
            .getState()
            .showDisconnect(targetId, { extra: 'NETWORK · 没收到服务端的收口事件' })
        }
        return { ok: true }
      } catch (error) {
        // 读流中途的失败（fetch 之后的异常）与"没收到终帧"同族：这一轮**已经开始过**，
        // 故在消息流内收口，而不是假装它没发生（前置失败在调用方那儿就已经返回了）
        if (!controller.signal.aborted) {
          const code: ClientErrorCode = error instanceof ApiError ? error.code : 'NETWORK'
          const message = error instanceof ApiError ? error.message : '读取回答时连接中断'
          useChatStreamStore.getState().fail(targetId, { code, message })
          useChatStreamStore.getState().showDisconnect(targetId, { extra: `${code} · ${message}` })
        }
        return { ok: true }
      } finally {
        // ⚠️ 这个 `finally` 可能**晚于**同一会话的下一条流（用户答完立刻追问）：新流在 `begin` 时就
        //    abort 了本控制器并接管了 `abortRef` ⇒ `isCurrent === false` 时这一轮已经不是"这个会话
        //    的妈妈"了，下面的收尾（尤其是 `releaseOwnRun`）**一概不许动**，否则会把新流刚写进去的
        //    `serverRun` 清掉（两轮同为 `'UI'`，光看来源分不出来）。
        const isCurrent = abortRef.current.get(targetId) === controller
        if (isCurrent) abortRef.current.delete(targetId)
        /**
         * ★ 按归属收掉"服务端在跑"那一格（2026-10-25）。
         *
         * `begin` 把本页这一轮也写进了 `serverRun[id]`（切走时侧栏的灯才不灭）。但那条流的
         * **收尾只有 `/active` 轮询会清**（2s/10s 一拍），而 `done` 一到手，`ChatPage` 的让位 effect
         * 就会 `reset` 掉 `round` ⇒ 必然出现 `round === null && serverRun[id] !== undefined` 的空窗，
         * 界面上把自己**刚跑完**的一轮显示成「另一个窗口正在生成」（头部标签 / 消息流尾部状态 /
         * 输入区禁用），直到下一次轮询才消失。
         *
         * 只清**已收到终帧**（`terminated`，含 `done` 与流内 `error`）的那一轮 —— 那时这一轮在
         * 服务端已经收尾（`orchestrator/sse.ts` 的 `finally` 就在 `done` 之后释放锁），本地清不必
         * 再等下一次轮询；而没收到终帧（断线 / 用户 abort）时**不清**：服务端那把锁到底还在不在，
         * 只有 `/active` 知道，本页不许猜（与"没落库就不说落库"同一纪律）。这种时候会话栏那盏灯
         * 继续由 `/active` 轮询校准。
         *
         * ⚠️ 已知边界：终帧写出去与锁释放是同一个 handler 里紧邻的两步，客户端可能在锁真正删掉前
         *    几毫秒就清了本地这一格 —— 这期间的发送由后端的 `CONFLICT` 兜底（与引入前的窗口同量级）。
         *
         * ⚠️ `releaseOwnRun` 内部按 `runOrigins === 'UI'` **按归属**收：期间若有别的来源
         * （外部调用 / 定时任务）顶上了这一格，那盏灯必须留住，不能因为"我刚跑完"就把它灭掉。
         */
        if (terminated) {
          if (isCurrent) useChatStreamStore.getState().releaseOwnRun(targetId)
        }
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
        // 聊天主页（P1-15）的会话栏看的是**跨智能体**那一份，与上面那份是两棵树 ⇒ 两处都失效。
        // 漏了这一行，主页左栏的标题 / 相对时间会停在"还没有消息"，而排序也不会把它推到最前。
        invalidateMyConversations(queryClient)
        // 产物面板（P0-3-11）也是"这一轮真的发生过 ⇒ 库里可能多了几行"。它**没有**
        // `last_message_at` 那种排序副作用，但面板上那一条要从"刚生成"变成真正的时刻读数
        // （`artifactPanelModel#artifactTimeText` 的 `live` 那一档），靠的就是这份列表重取回来。
        // ⚠️ 非 TaskAgent 时这个查询**根本没建**（`enabled: false`）⇒ 这一行是空转、
        // 不多打请求；写在这里而不是在 TaskAgent 分支里，是为了让"一轮结束要失效什么"
        // 只出现在一个地方（漏一处就是这个面板停在旧数据上的那种静默错）。
        void queryClient.invalidateQueries({ queryKey: conversationArtifactsQueryKey(targetId) })
        // 落点（P1-14）：新会话的首轮落点是网关选的（P2C/轮询），选择器此前只知道"我点过谁"。
        // 这一轮跑完 /chat 时 owner 已经写进目录 ⇒ 重取一次，界面才对得上**实际**在哪台。
        void queryClient.invalidateQueries({ queryKey: conversationInstanceQueryKey(targetId) })
      }
    },
    [agentId, queryClient],
  )

  const send = useCallback(
    async (text: string, modelId?: string, attachments: readonly AttachmentView[] = []): Promise<SendOutcome> => {
      const content = text.trim()
      // 空正文：与后端 `.min(1)` 同口径，不发请求（把"必填"的失败留给界面自己判，见 `ChatPage`）
      if (content === '') return { ok: true }

      // ① 同步闸门（**按会话**）。**返回 `BUSY` 而不是静默丢弃**：用户打的字不能凭空消失，
      //    页面会把正文还给输入框并提示（`ChatPage#submit` 对 `!outcome.ok` 的处置）。
      //    新会话态先用哨兵键；会话一建出来、**URL 落定之后**再**转**到真 id（见下面）——
      //    转了之后这条会话自己占一格，别的新会话才发得出去（否则"发完首条的那条会话还在跑"
      //    会一直占着哨兵键，把后面的新会话挡住 —— 正是多流要修掉的那类卡住）。
      let gateKey = conversationIdRef.current ?? NEW_CONVERSATION_KEY
      if (!gateFor(gateKey).enter()) {
        return { ok: false, error: new ApiError('BUSY', '上一条消息还在发送中，请稍后再发', 429) }
      }
      // ★ 服务端侧**还有一轮在跑，但不是本页发起的**（2026-10-22：外部 Open API 调用 /
      //   定时任务后台运行 / 另一个窗口）：本页没有它的控制器，服务端那把锁会直接回 `CONFLICT`，
      //   而那条错误落在**新一轮**的气泡里，看起来像"刚发的这条失败了"。这里先说清事实：
      //   那一轮归别处，等它跑完再发（或去别处停）。
      //   ⚠️ 判据与页面头部那枚标签同源（`round === null && serverRun[id]`）：本页有轮次时那条流
      //   归本页，闸门与 `CONFLICT` 文案都是既有行为，这里不插手。
      const current = conversationIdRef.current
      if (current !== undefined) {
        const streamState = useChatStreamStore.getState()
        if (roundOf(streamState, current) === null && streamState.serverRun[current] !== undefined) {
          gateFor(gateKey).leave()
          return {
            ok: false,
            error: new ApiError('BUSY', runOriginBusyMessage(streamState.runOrigins[current] ?? null), 429),
          }
        }
      }
      markSending(gateKey)
      try {
        // ② 没有会话就先建（`03` §4.1：首条消息发送时才创建会话）
        let targetId = conversationIdRef.current
        if (targetId === undefined) {
          let created: ConversationItem
          try {
            created = await createConversation(agentId)
          } catch (error) {
            return { ok: false, error }
          }
          targetId = created.id
          // ⚠️ **await**：回调会把 id 写进 URL，并可能在开流前落几步服务端写（新会话态预置的
          //    自动审批 / Code / 运行时 / 记忆，见 `UseChatStreamOptions.onConversationCreated`）。
          //    必须放在 `performStream` 之前 —— 否则首轮的危险工具会先弹一次确认卡。
          //    这期间**仍占着"新会话"那道闸门与标记**：窗口里 `round` 还不存在，若提前放开，
          //    输入区会判成 idle、再按一次 Enter 就会**再建一个会话**（闸门要拦的正是它）。
          await onConversationCreatedRef.current?.(created)
          // URL 已落定（`conversationId` 已是新 id）：把闸门与"发送中"标记转到真 id 上
          gateFor(gateKey).leave()
          unmarkSending(gateKey)
          gateKey = targetId
          gateFor(gateKey).enter()
          markSending(gateKey)
        }

        // ③ 开一轮并读完流
        return await performStream(
          targetId,
          content,
          'send',
          (signal) =>
            streamChat(
              targetId,
              content,
              {
                // ⚠️ 捕获的是**本流**的 targetId（多流不串台）
                onEvent: (event) => useChatStreamStore.getState().apply(targetId, event),
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
        gateFor(gateKey).leave()
        unmarkSending(gateKey)
      }
    },
    [agentId, gateFor, markSending, performStream, unmarkSending],
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
   * 其余（同步闸门 / 三类失败 / 三处失效）全部复用 {@link performStream}。
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
      if (!gateFor(targetId).enter()) {
        return { ok: false, error: new ApiError('BUSY', '上一条消息还在发送中，请稍后再发', 429) }
      }
      markSending(targetId)
      try {
        return await performStream(targetId, content, 'regenerate', (signal) =>
          streamRegenerate(
            targetId,
            {
              onEvent: (event) => useChatStreamStore.getState().apply(targetId, event),
              onIssue: reportSseIssue,
            },
            signal,
            modelId,
          ),
        )
      } finally {
        gateFor(targetId).leave()
        unmarkSending(targetId)
      }
    },
    [gateFor, markSending, performStream, unmarkSending],
  )

  /**
   * 停止控制器：**只创建一次**（`useRef`），否则每次渲染都会新建一个 ⇒
   * 里面那个"正在停止"的闸门与 `stopping` 状态每次渲染都被重置，"双击不会发两次请求"立刻失效。
   * 它读的东西全部走 ref（`conversationIdRef` / `abortRef` / `alignRef`）⇒ 闭包不会读到旧值。
   * ⚠️ 它作用于**当前会话**（页面一次只看一个会话）。
   */
  const stopControllerRef = useRef<ReturnType<typeof createStopController> | null>(null)
  if (stopControllerRef.current === null) {
    stopControllerRef.current = createStopController({
      isRunning: () => {
        const state = useChatStreamStore.getState()
        return roundOf(state, conversationIdRef.current)?.status === 'streaming'
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
              const round = roundOf(useChatStreamStore.getState(), conversationIdRef.current)
              return round === null || round.status !== 'streaming'
            },
          },
          timeoutMs,
        ),
      abort: () => {
        const targetId = conversationIdRef.current
        if (targetId !== undefined) abortRef.current.get(targetId)?.abort()
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
    const targetId = conversationIdRef.current
    if (targetId !== undefined) markStopping(targetId)
    try {
      const outcome = await stopController.stop()
      if (targetId !== undefined && outcome.kind === 'settled-locally') {
        // 窗口内没等到 `done{STOPPED}`：客户端侧把这一轮标成"已停止"（如实标注，不假装收到了确认）
        useChatStreamStore.getState().stoppedLocally(targetId)
        useChatStreamStore.getState().showDisconnect(targetId, {
          extra: `已过 ${Math.round(outcome.timeoutMs / 1000)}s 没等到服务端的收口事件`,
        })
      } else if (targetId !== undefined && outcome.kind === 'stop-request-failed') {
        const message =
          outcome.error instanceof ApiError ? `${outcome.error.code} · ${outcome.error.message}` : '停止信号没能发出去'
        useChatStreamStore.getState().showDisconnect(targetId, { extra: message })
      }
      return outcome
    } finally {
      if (targetId !== undefined) unmarkStopping(targetId)
    }
  }, [markStopping, stopController, unmarkStopping])

  /**
   * 中途插话（P1-9 · P4 · R1）。**纯前端闸门 + 一次普通请求**（不走 `stopController` 那套时序）：
   * 与 `send` / `stop` 共用"本会话正在流式"这条判据，但**不参与流收口** —— 插话只是塞一句话进去，
   * 这一轮的 `done` / `error` 照旧由那条 SSE 流收尾（前端不做任何额外状态）。
   *
   * ⚠️ 只在"本会话正 streaming"时发（`rounds[targetId].status === 'streaming'`）：
   * 流刚好结束时的插话会得到 `accepted:false`（幂等），这里提前拦一下省一次必然落空的请求。
   */
  const steer = useCallback(async (message: string): Promise<SteerOutcome> => {
    const text = message.trim()
    if (text === '') return { ok: true, accepted: false }
    const targetId = conversationIdRef.current
    if (targetId === undefined) {
      return { ok: false, error: new ApiError('VALIDATION', '还没有会话，无法插话', 0) }
    }
    const round = roundOf(useChatStreamStore.getState(), targetId)
    if (round === null || round.status !== 'streaming') {
      return { ok: true, accepted: false }
    }
    try {
      const result = await steerConversation(targetId, text)
      // ★ 乐观插入（P1-20）：插话常常发生在轮次的最后几秒，出口层的 `steer` 回帧依赖"通道轮询在
      //   轮次结束前取到"，可能整个落空 ⇒ 界面上"插话直接消失了"。用户说过的话必须看得见 ⇒
      //   **展示以本地为准**（`accepted:true` = 确实写给了一个正在跑的流）。出口层若真回了帧，
      //   归约层按 **id** 去重（`withInterjection`，2026-10-21 起；早先按正文去重会吞掉同句两插），
      //   不会显示两遍。
      // 乐观插入用**服务端给的 id**（2026-10-21）：出口层 `steer` 帧随后按同一个 id 去重；
      // 「取回编辑」也用它定位。`steerId` 为 null（理论上只有 `accepted:false` 才会）⇒ 不插入。
      if (result.accepted && result.steerId !== null) {
        useChatStreamStore.getState().addInterjection(targetId, {
          id: result.steerId,
          text,
          at: new Date().toISOString(),
        })
      }
      return { ok: true, accepted: result.accepted }
    } catch (error) {
      return { ok: false, error }
    }
  }, [])

  /**
   * 撤回一条插话（2026-10-21）。**服务端尽力撤回**（见 `cancelSteerConversation`）：
   *   · `scope:'one'` ⇒ 只移除这一条；
   *   · `scope:'all'` ⇒ 引擎队列整体清空 ⇒ 本轮所有**未投递**的插话一起移除；
   *   · `cancelled:false` ⇒ 撤不回来（已被模型读走 / 流已结束）—— **本地也不删**（诚实优先）。
   *
   * ⚠️ 与 `steer` 不同，它**不乐观**：只有服务端确认撤回成功才动本地清单 —— 否则会出现
   * "界面上没了、模型却已经读过"（用户会以为 agent 不该知道那句话）。
   */
  const cancelSteer = useCallback(async (steerId: string): Promise<CancelSteerOutcome> => {
    const targetId = conversationIdRef.current
    if (targetId === undefined) {
      return { ok: false, error: new ApiError('VALIDATION', '还没有会话，无法撤回插话', 0) }
    }
    try {
      const result = await cancelSteerConversation(targetId, steerId)
      const store = useChatStreamStore.getState()
      if (!result.cancelled) return { ok: true, cancelled: false, scope: result.scope }
      if (result.scope === 'all') store.removeQueuedInterjections(targetId)
      else store.removeInterjection(targetId, steerId)
      return { ok: true, cancelled: true, scope: result.scope }
    } catch (error) {
      return { ok: false, error }
    }
  }, [])

  /** 点黄条：对齐历史，然后把黄条收掉（无论对齐结论是什么 —— 用户点它就表示"以服务端为准"） */
  const alignAndClear = useCallback(async (): Promise<AlignOutcome | null> => {
    const outcome = await align()
    const targetId = conversationIdRef.current
    if (targetId !== undefined) useChatStreamStore.getState().clearDisconnect(targetId)
    return outcome
  }, [align])

  // 卸载：中断所有在飞的流 + 清空所有轮次与黄条。
  //
  // ⚠️ **刻意不依赖 `conversationId`**（早先写成依赖它，会导致一个很难查的 bug）：
  // "没有会话的新会话态"发第一条消息时，`send` 会先建会话、再把 id 写进 URL
  // （`onConversationCreated`）⇒ `conversationId` 从 `undefined` 变成 id ⇒ 依赖变化 ⇒
  // cleanup 立刻把**刚发起的那条流** abort 掉，症状是"第一条消息永远收不到回答、
  // 但第二条起一切正常"。改成空依赖后，切换会话**不会**中断旧流：
  //   · 不串台由 `rounds` 按键隔离保证（见 `stores/chatStream.ts`）；
  //   · 用户在流式中切走再切回，反而能看到完整内容（比"切走即中断"更好）。
  // 卸载时连黄条一起收掉：它是"这个页面这一刻"的状态，没人看了就该走
  // （与"对齐后保留黄条"不矛盾：那是有页面在看的时候）。
  useEffect(() => {
    return () => {
      for (const controller of abortRef.current.values()) controller.abort()
      abortRef.current.clear()
      useChatStreamStore.getState().resetAll()
    }
  }, [])

  const sending = sendingKeys.has(conversationId ?? NEW_CONVERSATION_KEY)
  const stopping = stoppingKeys.has(conversationId ?? NEW_CONVERSATION_KEY)

  return {
    round,
    streaming: round !== null && round.status === 'streaming',
    sending,
    stopping,
    disconnect,
    send,
    regenerate,
    stop,
    steer,
    cancelSteer,
    align: alignAndClear,
  }
}
