/**
 * 对话页（P0-1-32：骨架 + SSE 客户端 + 消息流渲染；P0-1-33：输入区状态机 + 停止 + 断线对齐）
 *
 * 依据：`docs/03-前端设计.md` §二（`/chat/:agentId`，`:conversationId?` 可选定位）、
 *      §4.1（对话页详设：头部 / 消息流 / **输入区状态机** / 首条消息才建会话 / **停止时序** /
 *      **断线黄条**）、§五（事件 → UI 映射）、§六（单一渲染路径）、§七（键盘约定、文案词表）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批做到哪、哪些刻意留给后面一批（`docs/06` P0-1-34）
 * ─────────────────────────────────────────────────────────────────────
 * ✅ P0-1-32：SSE 客户端（`useChatStream`）+ 事件归约（`roundReducer`）+ 消息流七种卡片 +
 *    历史与流式**共用**一套渲染 + 首条消息时创建会话 + `done`/`error` 收口 + 刷新后历史一致。
 * ✅ P0-1-33：**输入区状态机**（`idle/sending/streaming/stopping/confirm`，`composerState.ts`）、
 *    **停止按钮**的完整时序（`POST /stop` → 等 `done{STOPPED}` → 5s 未收口才 abort → 拉历史对齐，
 *    `stopController.ts`）、**顶部黄条**与"点击对齐历史"（`DisconnectBanner` + `alignHistory.ts`）、
 *    `CONFLICT` 的**专用 toast**（`streamErrors.ts`）、同标签页重复发送的同步闸门。
 * ⏳ P0-1-34：会话侧栏（新建 / 重命名 / 删除）+ **全屏布局**（`03` §三：保留 Logo 与头像菜单、
 *    其余导航收进「工作台」下拉）。本批沿用现有外壳与页头。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 一件必须靠"对齐 effect"解决的事：流式版本与落库版本的重叠
 * ─────────────────────────────────────────────────────────────────────
 * 一轮结束时会同时存在两份"同一轮"的数据：
 *   · store 里的**流式轮次**（用户看着它一帧帧长出来的那个）；
 *   · 库里刚落的那条（`done` 之后我们让历史查询失效并重拉）。
 * 处理不好会出两种症状：**闪一下少一条**（太早丢掉流式版本）或**同一条渲染两遍**（太晚丢）。
 * 故这里的规则是：**历史里出现了 `done.messageId` 对应的那条之后**，才丢掉流式版本。
 * `persisted === false`（没落库）的轮次**永远不丢**（它本来就不在历史里），
 * 并由 `AssistantMessage` 在收尾行里如实标注"刷新后不会出现在历史里"。
 *
 * ⚠️ **上面这条规则管不到"断线"**（P0-1-33 的缺口，本批补上）：断线那一轮**没有 `messageId`**
 * （没有 `done` 帧），于是它会被永远保留 ⇒ 若服务端其实已经落库，同一轮就渲染两遍。
 * 补法不在这个 effect 里，而在**对齐**那条路上：`alignHistory.ts` 用"助手消息**条数**是否增加"
 * 判断服务端到底存没存，存了就 `reset()` 掉流式版本。两条规则的分工是：
 *   · 有 `done` 帧 ⇒ 按 `messageId` 精确让位（这一条，最准）；
 *   · 没有终帧（断线 / 停止超时）⇒ 按条数让位（那一条，是对齐动作的一部分）。
 */

import { Button, Tag } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ReactNode, RefObject } from 'react'
import { HTTP_STATUS_BY_ERROR_CODE } from '@doubulea/shared'

import { useAgent } from '../../api/agents.js'
import {
  flattenMessagePages,
  useConversationMessages,
} from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH, agentEditPath, chatPath } from '../../app/paths.js'
import { TableSkeleton } from '../../components/ListStates.js'
import { ChatInput } from '../../features/chat/ChatInput.js'
import { DisconnectBanner } from '../../features/chat/DisconnectBanner.js'
import { MessageList } from '../../features/chat/MessageList.js'
import { messagesToViews, openingView } from '../../features/chat/messageModel.js'
import { roundToViews } from '../../features/chat/roundReducer.js'
import { chatErrorTitle, shouldToastChatError } from '../../features/chat/streamErrors.js'
import { useChatStream } from '../../features/chat/useChatStream.js'
import { useChatStreamStore } from '../../stores/chatStream.js'

/** 消息流的外框（三态共用，避免切换时布局跳动） */
function StreamFrame({
  children,
  scrollRef,
  onNearBottomChange,
}: {
  children: ReactNode
  /** 只有"消息流"这一态需要滚动跟随（骨架 / 错误 / 空态没有可滚的内容） */
  scrollRef?: RefObject<HTMLDivElement>
  /**
   * 每次滚动上报"用户是否贴着底部"。
   * ⚠️ 必须由**滚动事件**上报，不能在 effect 里现算 —— 原因见 `ChatPage` 里 `pinnedRef` 的注释。
   */
  onNearBottomChange?: (nearBottom: boolean) => void
}) {
  return (
    <div
      className="stream"
      data-testid="message-stream-frame"
      ref={scrollRef}
      onScroll={(event) => {
        const frame = event.currentTarget
        onNearBottomChange?.(frame.scrollHeight - frame.scrollTop - frame.clientHeight < 120)
      }}
    >
      <div className="stream__inner">{children}</div>
    </div>
  )
}

export function ChatPage() {
  const params = useParams<{ agentId: string; conversationId?: string }>()
  const agentId = params.agentId ?? ''
  const conversationId = params.conversationId
  const navigate = useNavigate()
  const feedback = useFeedback()

  // `agentId` 为空串时不查（`useAgent` 的 `enabled` 判据是"不是 undefined"，空串会打出一个 400）
  const agentQuery = useAgent(agentId === '' ? undefined : agentId)
  const messagesQuery = useConversationMessages(conversationId)

  /**
   * `agent?.type` 传给 hook 的**唯一**用途：TaskAgent 的断线对齐要先查 `GET /active`
   * （`03` §4.1）。首帧 `agent` 还没到时是 `undefined`（按 ChatBot 处理）—— 这没关系：
   * hook 里存的是 ref，真正读它的时刻是"用户点了对齐/停止了"，那时 agent 早就到了。
   */
  const { round, sending, stopping, disconnect, send, stop, align } = useChatStream(
    agentId,
    conversationId,
    {
      // 首条消息建出会话之后把 id 写进 URL（`replace`：不往历史里塞一步"空跳转"）
      onConversationCreated: (created) => {
        navigate(chatPath(agentId, created.id), { replace: true })
      },
      ...(agentQuery.data === undefined ? {} : { agentType: agentQuery.data.type }),
    },
  )

  const [draft, setDraft] = useState('')
  const [aligning, setAligning] = useState(false)
  // 滚动容器（`.stream`）—— 新内容到达时把视口推到底部，见下面的 effect
  const frameRef = useRef<HTMLDivElement>(null)
  /**
   * 用户**是否贴着底部**（在 `scroll` 事件里记录，而不是在 effect 里现算）。
   *
   * ⚠️ 顺序是关键：effect 跑在**内容已经长高之后**，此刻量到的"距底部距离"已经被新内容撑大了
   * —— "用户本来在底部"这件事在 DOM 更新后已经不可考。只能在**用户滚动时**把它记下来；
   * 内容增长不改变 `scrollTop`、不会触发 `scroll` 事件，所以这个记录保持的是**长高之前**的值。
   * 第一版就写错在这里：贴底判断永远拿"长高之后"的距离 ⇒ 永远判成"用户不在底部" ⇒ 跟随失效
   * （症状：回答在视口外一帧帧长出来，而滚动条纹丝不动）。
   */
  const pinnedRef = useRef(true)
  /** `scroll` 事件 → 记录"用户是否贴底"（只在用户真的滚动时变化；内容长高不触发它） */
  const handleNearBottom = useCallback((nearBottom: boolean): void => {
    pinnedRef.current = nearBottom
  }, [])

  const agent = agentQuery.data
  const agentName = agent?.name ?? '智能体'

  // 历史（正序）→ 视图；流式轮次 → 视图；两者**同一形状**（单一渲染路径）
  const history = useMemo(() => messagesToViews(flattenMessagePages(messagesQuery.data)), [messagesQuery.data])
  const streamViews = useMemo(() => (round === null ? [] : roundToViews(round)), [round])

  const messages = useMemo(() => {
    const all = [...history, ...streamViews]
    if (all.length > 0) return all
    // 一条消息都没有 ⇒ 新会话态：展示开场白（`03` §4.1 第一行）。开场白恒在**最前**，
    // 而"消息一条都没有"时它也是唯一的一条。
    const opening = openingView(agent?.openingRemarks)
    return opening === null ? [] : [opening]
  }, [history, streamViews, agent?.openingRemarks])

  /**
   * 流式版本让位（见文件头）。判据只有一条：**历史里已经有那条消息了**。
   * 三个前置条件缺一不可：还在流式 ⇒ 不能让位；没落库（`messageId === null`）⇒ 历史里不会有；
   * 历史还没到位 ⇒ 太早让位会闪一下少一条。
   */
  useEffect(() => {
    if (round === null || round.status === 'streaming') return
    const messageId = round.assistantMessageId
    if (messageId === null) return
    if (history.some((view) => view.key === messageId)) {
      useChatStreamStore.getState().reset()
    }
  }, [round, history])

  /**
   * **贴底跟随**：流式期间每一帧都会长高，不跟随的话新内容长在视口外 —— 而"看着回答长出来"
   * 正是流式的意义（SSE 客户端整批的验收都建立在"用户看得见"上）。
   *
   * 跟随与否看 `pinnedRef`（见它的注释：为什么必须在 `scroll` 事件里记录）。
   * 阈值 120px 是"贴底"的容差：程序化 `scrollTop = scrollHeight` 之后距离是 0，
   * 而用户手动滚到底也总能落进这个容差里。
   */
  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    if (pinnedRef.current) frame.scrollTop = frame.scrollHeight
  }, [messages])

  /**
   * 「服务端说的故障」要弹 toast（`03` §五 的 `error` 行："错误 toast + 消息流内错误卡"）。
   *
   * 判据在 `streamErrors.ts#shouldToastChatError` —— **只对 `errorSource === 'server'` 弹**
   * （客户端侧的断线/中断走黄条那条通道，见那个文件的说明）。
   *
   * ⚠️ 用一个"这一轮 + 错误码"的键去重，而不是每次 round 变化都弹：归约层在收口后不再改状态
   * （`isSettled` 那一句），但这个 effect 还会因**别的**依赖（`history`）重跑 —— 少了去重，
   * 一次失败会弹出一串一模一样的 toast。键里带 `startedAt`（每一轮一个）⇒ 同一轮的同一个错误
   * 只弹一次，而"下一轮又冲突"照样会弹。
   */
  const notifiedErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (round === null || round.error === null) return
    if (!shouldToastChatError(round)) return
    const key = `${round.startedAt}|${round.error.code}`
    if (notifiedErrorRef.current === key) return
    notifiedErrorRef.current = key

    const code = round.error.code as ClientErrorCode
    // 造一个 `ApiError` 而不是直接调 `notification`：**反馈通道只有一处**（`app/feedback.ts`），
    // 于是"失败长什么样"在全站是一个口径（`03` §六 的坑预判），页面不必自己拼通知。
    // 状态码从 `shared` 的表里取（`CONFLICT → 409`），不编造 —— `ApiError` 保留 `status`
    // 是为了将来按状态码分流（如 401 收口），此刻它只被透传。
    // ⚠️ 客户端伪码 `NETWORK` **不在**那张表里（它是前端造的，后端不认识）⇒ 取不到就是 0
    //（`api/client.ts` 的 `NETWORK_ERROR_CODE` 就是这么定义 `status` 的）
    const status = code === 'NETWORK' ? 0 : (HTTP_STATUS_BY_ERROR_CODE[code] ?? 0)
    feedback.fail(new ApiError(code, round.error.message, status), chatErrorTitle(code))
  }, [round, feedback])

  const submit = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '') return
    // 先清空输入框（体感"发出去了"），失败时再还回来 —— 见下面的 `setDraft(text)`。
    // ⚠️ "能不能发"由输入区状态机（`composerState.ts#canSend`）判，这里**不再判一次**：
    // 两处判据必然漂移（最典型：这里放行了、按钮却是灰的，用户看到"没反应"）
    setDraft('')
    const outcome = await send(text)
    if (!outcome.ok) {
      // 前置失败（401/400/404/409 只读/424 缺凭据）与**同标签页重复发送**（`BUSY`）：
      // 这一轮一个字都没落库 ⇒ 界面上不该留下它，正文还给输入框，用户不必重打
      setDraft(text)
      feedback.fail(outcome.error, '发送失败')
    }
  }, [draft, feedback, send])

  /**
   * 点「停止」（`03` §4.1 的时序在 `useChatStream` → `stopController`，这里只报告结果）。
   *
   * 只对 `stop-request-failed` 说话：那时**停止信号根本没发出去**（网络/401），用户需要知道
   * "你点的那一下没生效"；而 `settled` / `settled-locally` 的结果已经各自有可见的落点
   * （收尾行的"已停止" / 顶部黄条），再弹一个 toast 就是同一件事说两遍。
   */
  const handleStop = useCallback((): void => {
    void stop().then((outcome) => {
      if (outcome.kind === 'stop-request-failed') {
        feedback.fail(outcome.error, '停止失败')
      }
    })
  }, [feedback, stop])

  /**
   * 点黄条 = 对齐历史（`03` §4.1）。结果分三档，**提示的口径也跟着分**（`alignHistory.ts`）：
   *   · `recovered` —— 服务端存下来了 ⇒ 轻提示（用户做成了一件事）；
   *   · `not-persisted` / `server-still-streaming` —— 都没坏，但都不是"成功" ⇒ 中性提示
   *     （用红色报一件正常的事，会让用户去找并不存在的问题）。
   */
  const handleAlign = useCallback((): void => {
    setAligning(true)
    void align()
      .then((outcome) => {
        if (outcome === null) return
        if (outcome.kind === 'recovered') feedback.ok(outcome.note)
        else feedback.note(outcome.note)
      })
      .finally(() => {
        setAligning(false)
      })
  }, [align, feedback])

  // ── 智能体本身取不到（不存在 / 已软删 / 链接里的 id 不对）：给一条能回去的路
  if (agentQuery.isError) {
    return (
      <div className="page__head">
        <div>
          <p className="kicker">S-04 · 对话</p>
          <h1>打不开这个对话</h1>
          <p className="page__lead">智能体取不到（可能已被删除，或链接里的 id 不对）。</p>
        </div>
        <div className="page__head-actions">
          <Link to={HOME_PATH}>
            <Button type="primary">回智能体列表</Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    // `.chat` 的完整形态在 `03` §4.1 是"侧栏 + 消息流 +（TaskAgent 的产物面板）"，
    // 本批只落中栏（侧栏属 P0-1-34）⇒ 用 `chat--solo` 覆盖成单栏（见 `styles/app.css`）
    <div className="chat chat--solo">
      <main className="chat__main" aria-label="当前会话">
        <div className="chat__head">
          <div>
            <h1 className="chat__title">{agentName}</h1>
            <p className="ratio">
              {agent === undefined ? '正在读取智能体…' : `${agent.type} · ${agent.modelLabel}`}
            </p>
          </div>
          <div className="chat__head-right">
            {agent?.modelAvailable === false ? (
              // 绑定模型被停用 ⇒ 发消息会被后端 409 拦下（`shared/src/agent.ts` 的 `modelAvailable`
              // 是服务端投影，前端**照抄**，不自己判角色/不自己看模型池）。提前说，省一次失败。
              <Tag className="tag--danger" title="绑定的模型或其 Provider 已停用，发送会被拒绝">
                绑定模型不可用
              </Tag>
            ) : null}
            {agent === undefined ? null : (
              <Link to={agentEditPath(agent.id)}>
                <Button size="small">编辑智能体</Button>
              </Link>
            )}
          </div>
        </div>

        {/* 顶部黄条：断线 / 停止没收到服务端确认（`03` §4.1："点击黄条 = 立即拉取历史对齐"）。
            它由 store 持有（不是轮次的一部分）—— 因为"对齐"本身会把轮次丢掉，
            见 `stores/chatStream.ts` 的 `DisconnectState` */}
        {disconnect === null ? null : (
          <DisconnectBanner extra={disconnect.extra} aligning={aligning} onAlign={handleAlign} />
        )}

        {/* 排队提示（`queued` 事件）：沙箱并发满时的位次。**P0 阶段恒不出现**
            （产生方是沙箱并发闸，属 P0-3）。 */}
        {round?.queuedPosition === null || round?.queuedPosition === undefined ? null : (
          <div className="queued" style={{ margin: 'var(--sp-2) var(--sp-5)' }}>
            <span className="led led--warn" aria-hidden="true" />
            排队第 {round.queuedPosition} 位
          </div>
        )}

        {/* ── 消息流：三态 + 流式 ── */}
        {conversationId !== undefined && messagesQuery.isPending ? (
          <StreamFrame>
            <TableSkeleton rows={3} />
          </StreamFrame>
        ) : conversationId !== undefined && messagesQuery.isError ? (
          <StreamFrame>
            <div className="card card--pad">
              <p className="empty__title">历史没有读出来</p>
              <p className="empty__lead">
                这次没拿到消息历史，界面上的内容可能不完整。点下面重试，或刷新页面。
              </p>
              <Button
                onClick={() => {
                  void messagesQuery.refetch()
                }}
                loading={messagesQuery.isFetching}
              >
                重试
              </Button>
            </div>
          </StreamFrame>
        ) : messages.length === 0 ? (
          <StreamFrame>
            <div className="empty">
              <div className="empty__frame" aria-hidden="true" />
              <p className="empty__title">这个智能体还没有开场白</p>
              <p className="empty__lead">直接在下面输入第一条消息，会话会在这时创建。</p>
            </div>
          </StreamFrame>
        ) : (
          <StreamFrame scrollRef={frameRef} onNearBottomChange={handleNearBottom}>
            {/* 向历史深处翻页。契约：`items` 正序、`nextCursor` 指向**更早**一页
                （`shared/src/conversation.ts#messagePageResultSchema`）—— 展平顺序由
                `flattenMessagePages` 负责，别在这里自己拼页。 */}
            {messagesQuery.hasNextPage ? (
              <div style={{ textAlign: 'center' }}>
                <Button
                  size="small"
                  loading={messagesQuery.isFetchingNextPage}
                  onClick={() => {
                    void messagesQuery.fetchNextPage()
                  }}
                >
                  加载更早的消息
                </Button>
              </div>
            ) : null}
            <MessageList messages={messages} agentName={agentName} />
          </StreamFrame>
        )}

        {/* ── 输入区：状态机 / 停止 / 确认卡全在 `ChatInput` 里（本页只提供数据与回调） ── */}
        <ChatInput
          round={round}
          sending={sending}
          stopping={stopping}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={() => {
            void submit()
          }}
          onStop={handleStop}
        />
      </main>
    </div>
  )
}
