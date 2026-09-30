/**
 * 对话页（P0-1-32：骨架 + SSE 客户端 + 消息流渲染；P0-1-33：输入区状态机 + 停止 + 断线对齐；
 * P0-1-34：**会话侧栏**）
 *
 * 依据：`docs/03-前端设计.md` §二（`/chat/:agentId`，`:conversationId?` 可选定位）、
 *      §4.1（对话页详设：**会话侧栏** / 头部 / 消息流 / **输入区状态机** / 首条消息才建会话 /
 *      **停止时序** / **断线黄条**）、§五（事件 → UI 映射）、§六（单一渲染路径）、
 *      §七（键盘约定、文案词表、删除分级确认）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批做到哪、哪些刻意留给后面一批（`docs/06` P0-1-35/36、P0-3）
 * ─────────────────────────────────────────────────────────────────────
 * ✅ P0-1-32：SSE 客户端（`useChatStream`）+ 事件归约（`roundReducer`）+ 消息流七种卡片 +
 *    历史与流式**共用**一套渲染 + 首条消息时创建会话 + `done`/`error` 收口 + 刷新后历史一致。
 * ✅ P0-1-33：**输入区状态机**（`idle/sending/streaming/stopping/confirm`，`composerState.ts`）、
 *    **停止按钮**的完整时序（`POST /stop` → 等 `done{STOPPED}` → 5s 未收口才 abort → 拉历史对齐，
 *    `stopController.ts`）、**顶部黄条**与"点击对齐历史"（`DisconnectBanner` + `alignHistory.ts`）、
 *    `CONFLICT` 的**专用 toast**（`streamErrors.ts`）、同标签页重复发送的同步闸门。
 * ✅ P0-1-34：**会话侧栏**（新建 / 切换 / 行内重命名 / 分级删除，`ConversationSidebar.tsx`）
 *    —— 侧栏的判据全在 `conversationList.ts`（零依赖纯逻辑，有断言）；
 *    **全屏布局**在 `AppLayout`（`docs/03` §三：保留 Logo 与头像菜单，其余导航收进「工作台」下拉）。
 * ✅ P0-3-11：**第三列 = 产物面板**（`ArtifactPanel.tsx`，只对 TaskAgent 加 `chat--with-panel`）
 *    + **预览弹层**（`ArtifactPreviewDrawer`，谁在预览住在 `stores/artifactPreview.ts`）。
 *    清单由 `mergeArtifactPanelItems` 一处合流：服务端列表（刷新后还在）+ 本轮 `artifact` 事件
 *    （此刻就在手上）—— 见 `artifactPanelModel.ts` 的文件头（顺序与去重口径都写在那里）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 侧栏带来的那一件事：**切会话时不动 store**
 * ─────────────────────────────────────────────────────────────────────
 * 用户完全可以在流式期间切到另一个会话（这正是侧栏让它变得容易的动作）。此时：
 *   · 旧流的帧还在往 store 里灌（fetch 没被中断）；
 *   · 页面正在渲染**新会话**的历史。
 * 不串台靠 `stores/chatStream.ts` 的 `streamFor` 守卫 —— `useChatStream` 只在
 * `streamFor === 当前会话` 时才把 `round` 交给页面（见 `visibleRound`）。
 * **刻意不在切换时 abort**（`useChatStream` 卸载 effect 的注释）：切走再切回反而能看到完整内容。
 *
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

import { Button, Drawer, Select, Tag } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ReactNode, RefObject } from 'react'
import { HTTP_STATUS_BY_ERROR_CODE } from '@doubulea/shared'
import type { RecallConversationResult, RemoveConversationResult } from '@doubulea/shared'

import { useAgent } from '../../api/agents.js'
import { conversationArtifactsQueryKey, useConversationArtifacts } from '../../api/artifacts.js'
import {
  conversationMessagesQueryKey,
  flattenMessagePages,
  useConversationMessages,
} from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { confirmConversation } from '../../api/mcp.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH, agentEditPath, chatPath } from '../../app/paths.js'
import { ArtifactPreviewDrawer } from '../../components/ArtifactPreview/ArtifactPreviewDrawer.js'
import { TableSkeleton } from '../../components/ListStates.js'
import { ArtifactPanel } from '../../features/chat/ArtifactPanel.js'
import { mergeArtifactPanelItems, showArtifactPanel } from '../../features/chat/artifactPanelModel.js'
import { ChatInput } from '../../features/chat/ChatInput.js'
import { confirmAnsweredText, confirmIgnoredNote } from '../../features/chat/confirmModel.js'
import { ConversationSidebar } from '../../features/chat/ConversationSidebar.js'
import { DisconnectBanner } from '../../features/chat/DisconnectBanner.js'
import { MessageList } from '../../features/chat/MessageList.js'
import { RecallConversationModal, type RecallTarget } from '../../features/chat/RecallConversationModal.js'
import { messagesToViews, openingView, type ChatMessageView } from '../../features/chat/messageModel.js'
import { roundToViews } from '../../features/chat/roundReducer.js'
import { chatErrorTitle, shouldToastChatError } from '../../features/chat/streamErrors.js'
import { useChatStream } from '../../features/chat/useChatStream.js'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.js'
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
  const queryClient = useQueryClient()

  // `agentId` 为空串时不查（`useAgent` 的 `enabled` 判据是"不是 undefined"，空串会打出一个 400）
  const agentQuery = useAgent(agentId === '' ? undefined : agentId)
  const messagesQuery = useConversationMessages(conversationId)

  /**
   * `agent?.type` 传给 hook 的**唯一**用途：TaskAgent 的断线对齐要先查 `GET /active`
   * （`03` §4.1）。首帧 `agent` 还没到时是 `undefined`（按 ChatBot 处理）—— 这没关系：
   * hook 里存的是 ref，真正读它的时刻是"用户点了对齐/停止了"，那时 agent 早就到了。
   */
  /**
   * 首次发送新建会话时，`conversationId` 会从 `undefined` 变成新会话 id —— 这次变化**不是**
   * "切换会话"，用户的模型选择必须保留（否则"选了 flash 发送后，选择器立刻回到默认"）。
   * 其余变化（侧栏切换 / 「+ 新会话」）照旧重置。由 `onConversationCreated` 置位、reset effect 消费。
   */
  const preserveSelectionRef = useRef(false)

  const { round, sending, stopping, disconnect, streamingId, send, stop, align } = useChatStream(
    agentId,
    conversationId,
    {
      // 首条消息建出会话之后把 id 写进 URL（`replace`：不往历史里塞一步"空跳转"）
      onConversationCreated: (created) => {
        // 这是"新建会话"而不是"切换会话"：别让 reset effect 把用户此刻选的模型清掉
        preserveSelectionRef.current = true
        navigate(chatPath(agentId, created.id), { replace: true })
      },
      ...(agentQuery.data === undefined ? {} : { agentType: agentQuery.data.type }),
    },
  )

  const [draft, setDraft] = useState('')
  const [aligning, setAligning] = useState(false)
  /**
   * 本会话**这一轮选用的模型**（模型池特性）。`undefined` = 走智能体默认模型（`agent.modelId`）。
   * 切换会话时重置（下面的 effect）：一个会话选的模型不该带到另一个会话。
   * ⚠️ 但"新建会话的第一条消息"**不算切换**（`onConversationCreated` 会先置
   * `preserveSelectionRef`）—— 那时重置会把用户刚选的模型丢掉，而历史还没加载、回显也补不上。
   */
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (preserveSelectionRef.current) {
      preserveSelectionRef.current = false
      return
    }
    setSelectedModelId(undefined)
  }, [conversationId])

  /** 确认应答在飞（防连点：两个按钮同时禁用，见 `ConfirmCard` 文件头 ③） */
  const [confirmPending, setConfirmPending] = useState(false)
  /** 窄屏下的产物抽屉开关（第三列被 CSS 藏在 ≥1280 才显示，窄屏用抽屉给入口，见 `ArtifactPanel` 那段） */
  const [artifactDrawerOpen, setArtifactDrawerOpen] = useState(false)
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
  // 面包屑（顶栏）里这一页的细节段 = 智能体名 ⇒ `工作台 / 智能体 / <名称>`（加载中只到「智能体」）
  usePageCrumb(agent?.name ?? null)
  /**
   * 头部副标题里显示的模型名：**跟随本会话当前选中/正在用的模型**，而不是永远显示默认模型
   * （产品反馈 2026-09-29：选了 flash 后副标题还停在 pro）。`selectedModelId` 为
   * `undefined`（未选 / 回落到默认）时显示默认模型；选中的模型已不在池里（被删/停用）
   * 时 `find` 落空 ⇒ 照样回落默认标签。
   */
  const activeModelLabel =
    agent?.models.find((m) => m.modelId === (selectedModelId ?? agent.modelId))?.modelLabel ??
    agent?.modelLabel ??
    null

  // 历史（正序）→ 视图；流式轮次 → 视图；两者**同一形状**（单一渲染路径）
  const history = useMemo(() => messagesToViews(flattenMessagePages(messagesQuery.data)), [messagesQuery.data])
  const streamViews = useMemo(() => (round === null ? [] : roundToViews(round)), [round])

  /**
   * 本会话**最后使用的模型**（产品优化 2026-09-29）—— 从已落库历史的最后一条带 `model`
   * 段的助手消息取（越靠后越新）。重进会话时头部选择器要回显它，而不是每次都回落到默认。
   */
  const lastUsedModel = useMemo(() => {
    for (let index = history.length - 1; index >= 0; index--) {
      const view = history[index]
      if (view === undefined) continue
      const model = view.model
      if (model !== undefined) return model
    }
    return undefined
  }, [history])

  /**
   * 重进会话回显"上次用的模型"（产品优化 2026-09-29）。
   *
   * 三个前置缺一不可：**用户还没手动选过**（`undefined` = 这一会话还没碰过选择器）、
   * 历史里有记录、那个模型**现在仍可用**（池成员且未停用）。
   * 模型被删 / 停用 ⇒ 这里不动 ⇒ 头部选择器回落到默认模型（`selectedModelId ?? agent.modelId`）
   * —— 这正是产品口径"当模型被删除后使用默认模型"。手动画过选择器后也**不再覆盖**
   * （否则会出现"我选了 B、却被回显成 A"的打架）。
   */
  useEffect(() => {
    if (selectedModelId !== undefined) return
    if (lastUsedModel === undefined) return
    const member = agent?.models.find((m) => m.modelId === lastUsedModel.modelId)
    if (member === undefined || !member.available) return
    setSelectedModelId(lastUsedModel.modelId)
  }, [selectedModelId, lastUsedModel, agent])

  const messages = useMemo(() => {
    const all = [...history, ...streamViews]
    if (all.length > 0) return all
    // 一条消息都没有 ⇒ 新会话态：展示开场白（`03` §4.1 第一行）。开场白恒在**最前**，
    // 而"消息一条都没有"时它也是唯一的一条。
    const opening = openingView(agent?.openingRemarks)
    return opening === null ? [] : [opening]
  }, [history, streamViews, agent?.openingRemarks])

  /**
   * 可撤回的"最新一轮"（产品优化 2026-09-29；产品口径：只能对最新的一轮撤回/修改重发）。
   *
   * 判据四条：有会话 + 没在生成 + 历史里最后一条 `USER` 消息 + 它在整条历史里是最后一条。
   * `hadTools` 看紧随其后的助手消息有没有工具卡 —— "调用过工具、效果无法复原"的警告
   * 是**事前**说的，判据来自已落库的历史（不是服务端另算）。
   *
   * ⚠️ 只在**已落库的历史**（`history`）上算，不含流式轮次：流式中不提供撤回
   * （那会撤掉正在生成的一轮，而"最新一轮"此刻还在变）。
   */
  const recallable = useMemo(() => {
    if (conversationId === undefined) return null
    if (round !== null) return null
    let lastUser: ChatMessageView | undefined
    let lastUserIndex = -1
    for (let index = history.length - 1; index >= 0; index--) {
      const view = history[index]
      if (view !== undefined && view.role === 'USER') {
        lastUser = view
        lastUserIndex = index
        break
      }
    }
    if (lastUser === undefined) return null
    const assistant = history[lastUserIndex + 1]
    return {
      key: lastUser.key,
      hadTools: assistant !== undefined && assistant.role === 'ASSISTANT' && assistant.tools.length > 0,
    }
  }, [conversationId, history, round])

  // ── 产物面板（P0-3-11）──────────────────────────────────────────────────────
  //
  // ⚠️ **只有 TaskAgent 有这一列**（`03` §4.1 的"TaskAgent 差异"）。判据是 `agent.type`
  //    而不是"有没有产物"—— 理由在 `artifactPanelModel.ts` 的文件头（类型在创建时定死、
  //    "有没有产物"不是 ⇒ 后者会让面板在第一次派活之前不存在、之后凭空出现）。
  //    `agent` 还没到时按"不显示"处理：三栏的 `grid-template-columns` 变一次会让中栏跳一下。
  const showPanel = showArtifactPanel(agent?.type)

  /**
   * 产物列表：**"刷新后产物还在"的唯一出口**（`artifact` 事件只发一次、
   * 历史消息里的 `content.artifacts` 只覆盖那一轮）。
   *
   * `enabled: showPanel` ⇒ ChatBot 与"新会话态"都不发这个请求。那一轮的产出**仍然是可见的**
   * （消息流里的产物卡由 `roundReducer` 的 `artifact` 分支承载），面板只是不让它多一次请求。
   */
  const artifactsQuery = useConversationArtifacts(conversationId, showPanel)

  /**
   * 面板清单 = **服务端列表**（最新在前，刷新后还在）+ **本轮事件**（产出顺序，此刻就在手上）
   * 在一处的合流（`mergeArtifactPanelItems`：倒序对齐 + 按 `artifactId` 去重、保留服务端那一份）。
   * ⚠️ 顺序不许在这里再排一次：**顺序只能来自服务端**（与 `conversationList.ts` 同款纪律）。
   *
   * ⚠️ 用 `round`（= 属于**当前会话**的那一轮）而不是 store 里任意一轮：切到别的会话时
   * 面板显示的是那个会话的产物，不允许把上一个会话的产出混进来。
   */
  const artifactItems = useMemo(
    () => mergeArtifactPanelItems(artifactsQuery.data?.items ?? [], round?.assistant.artifacts ?? []),
    [artifactsQuery.data, round],
  )

  // 预览弹层（P0-3-11）：谁在预览住在 store 里（点「预览」的地方在四个层级之下，见那个文件）
  const previewedArtifact = useArtifactPreviewStore((state) => state.preview)
  const closePreview = useArtifactPreviewStore((state) => state.closePreview)

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
    const outcome = await send(text, selectedModelId)
    if (!outcome.ok) {
      // 前置失败（401/400/404/409 只读/424 缺凭据）与**同标签页重复发送**（`BUSY`）：
      // 这一轮一个字都没落库 ⇒ 界面上不该留下它，正文还给输入框，用户不必重打
      setDraft(text)
      feedback.fail(outcome.error, '发送失败')
    }
  }, [draft, feedback, send, selectedModelId])

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

  /**
   * 答复确认卡（P0-2-11）。
   *
   * ─────────────────────────────────────────────────────────────────────
   * 三条顺序推理（写在这里，因为它们是"为什么这么写"而不是"写了什么"）
   * ─────────────────────────────────────────────────────────────────────
   * ① **无论成败都收卡**（`finally`）：这一次答复要么被服务端消费了、要么那个提问已经不存在
   *    （`applied:false`）—— 两种情况都不该让卡片继续挂在输入区上问同一个问题。
   *    留在那里的后果很具体：用户会以为没点上而反复点，而每次都只拿到一句"没生效"。
   * ② **成功路径分两个通道**：`applied:true` ⇒ 成功提示（"已确认，工具继续执行" /
   *    "已取消，这个工具不会执行"）；`applied:false` ⇒ **中性提示**（`note`），
   *    因为它是"这个提问已经结束了"，**不是错误**（`shared#confirmConversationResultSchema`）。
   *    用红色报它会让用户去处理一个必然存在的竞态。
   * ③ **`conversationId` 缺失时直接返回**：确认卡只可能出现在"有会话、有流在跑"的时候，
   *    但类型上它是可选的（新会话态）—— 少了这个守卫，TS 会拦（这也是它该拦的：
   *    应答端点 `/api/conversations/:id/confirm` 的路径里必须有 id）。
   *
   * ⚠️ 卡片上显示的 `expiresAt` 与这里的应答是**两件事**：前端到点只把按钮禁用
   * （读数变"已超时"），**不自己撤卡、也不代替服务端做"超时即取消"**。真正的收口在服务端。
   */
  const handleConfirmAnswer = useCallback(
    (accepted: boolean): void => {
      const confirm = useChatStreamStore.getState().round?.confirm
      if (confirm === undefined || confirm === null) return
      if (conversationId === undefined) return

      setConfirmPending(true)
      void confirmConversation(conversationId, { confirmId: confirm.confirmId, accepted })
        .then((result) => {
          const ignored = confirmIgnoredNote(result.applied)
          if (ignored === null) feedback.ok(confirmAnsweredText(result.accepted))
          else feedback.note(ignored)
        })
        .catch((error: unknown) => {
          // 请求自己失败了（网络层 / 401 / 404）。**卡片照样在 `finally` 里收掉**：
          // 悬着一张卡会挡住输入区（确认态是**锁输入**的），而用户此时真正需要的是
          // "能继续用这个页面"；他要是还想确认，服务端那边的等待窗口也还在（`expiresAt`）。
          feedback.fail(error, '确认没有发出去')
        })
        .finally(() => {
          setConfirmPending(false)
          useChatStreamStore.getState().clearConfirm()
        })
    },
    [conversationId, feedback],
  )

  // ── 侧栏（P0-1-34）的三个动作 ──────────────────────────────────────────────

  /** 切到某个会话。用 `push`（不是 `replace`）：这**是**一次导航，后退该能回到上一个会话 */
  const handleSelectConversation = useCallback(
    (id: string): void => {
      navigate(chatPath(agentId, id))
    },
    [agentId, navigate],
  )

  /**
   * 「+ 新会话」⇒ 回到**不带 conversationId** 的地址（`03` §4.1：进入对话页只展示开场白，
   * 首条消息发送时才真的建会话）。
   *
   * `push` 同样是对的：翻回上一个会话是用户会做的动作。
   */
  const handleNewConversation = useCallback((): void => {
    navigate(chatPath(agentId))
  }, [agentId, navigate])

  /**
   * 删除成功之后的收尾（两件，判断依据都是"删掉的是不是**我正在看/正在跑**的那一条"）。
   *
   * ① **删的正是 URL 里那个会话** ⇒ 立刻导航去新会话态。不导航的后果很具体：
   *    页面停在一个已经不存在的会话上，历史查询下一次重取就是 404，屏幕上是一段
   *    "历史没有读出来"，而用户明明刚刚亲手删掉了它。
   * ② **那一轮还在本地流着** ⇒ 就地收掉渲染状态。**刻意不 abort fetch**：`AbortController`
   *    在 `useChatStream` 内部（abort 是停止时序的一环，页面越权调它会把"停止"的两条路
   *    搅成三条）。此后到达的帧会因为 `round === null` 被 `apply` 静默丢掉（store 既有行为）。
   */
  const handleConversationDeleted = useCallback(
    (removed: RemoveConversationResult): void => {
      if (removed.id === conversationId) navigate(chatPath(agentId), { replace: true })
      if (removed.id === streamingId) useChatStreamStore.getState().reset()
    },
    [agentId, conversationId, navigate, streamingId],
  )

  // ── 撤回 / 修改重发最新一轮（产品优化 2026-09-29）──────────────────────────────

  /** 撤回确认弹窗的目标；`null` = 关闭 */
  const [recallTarget, setRecallTarget] = useState<RecallTarget | null>(null)

  /** 点「撤回」/「修改重发」：两个动作共用同一个确认弹窗，`resend` 只决定成功后的收尾 */
  const openRecall = useCallback(
    (text: string, hadTools: boolean, resend: boolean): void => {
      setRecallTarget({ text, hadTools, resend })
    },
    [],
  )

  /**
   * 撤回成功的收尾（弹窗已弹过成功提示，这里做数据与 UI 的收尾）：
   *   · 失效消息历史与产物面板（侧栏列表已由 mutation 失效）—— 不失效的话，撤回的这一轮
   *     还躺在界面上，而用户看到的正是"我刚撤了它"；
   *   · 修改重发 ⇒ 把原文放回输入框（`resend` 为真）。
   */
  const handleRecalled = useCallback(
    (_result: RecallConversationResult, target: RecallTarget): void => {
      setRecallTarget(null)
      if (conversationId === undefined) return
      void queryClient.invalidateQueries({ queryKey: conversationMessagesQueryKey(conversationId) })
      void queryClient.invalidateQueries({ queryKey: conversationArtifactsQueryKey(conversationId) })
      if (target.resend) setDraft(target.text)
    },
    [conversationId, queryClient],
  )

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
    // `.chat` 的完整形态（`03` §4.1 / `design/chat.html` 的 `.chat--with-panel`）是**三栏**：
    // 会话侧栏 + 消息流 +（TaskAgent 的）产物面板。前两栏在 P0-1-34 就位，
    // 第三栏是 **P0-3-11**（产物收集/列表/预览齐了才可能出现真内容）。
    // ⚠️ 第三列**不是常驻的空占位**：只对 TaskAgent 加 `chat--with-panel`，
    // 否则"消息流到底占多宽"会变成一个看不出来的问题（ChatBot 会永远少 312px）。
    <>
      <div className={showPanel ? 'chat chat--with-panel' : 'chat'}>
        <ConversationSidebar
          agentId={agentId}
          conversationId={conversationId}
          streamingId={streamingId}
          onSelect={handleSelectConversation}
          onNew={handleNewConversation}
          onDeleted={handleConversationDeleted}
        />
        <main className="chat__main" aria-label="当前会话">
          <div className="chat__head">
            <div>
              <h1 className="chat__title">{agentName}</h1>
              <p className="ratio">
                {agent === undefined
                  ? '正在读取智能体…'
                  : `${agent.type} · ${activeModelLabel ?? '未绑定模型'}`}
              </p>
            </div>
            <div className="chat__head-right">
              {/* 模型选择器（模型池特性）：池里有 2 个及以上模型时才给选择器；否则只有默认模型、
                  没有可选项，用上面的文字标签展示即可。选了非默认模型时随发送透传给后端
                  （`POST /:id/chat` 的 modelId），后端校验它是该智能体模型池成员。 */}
              {agent !== undefined && agent.modelId !== null && agent.models.length >= 2 ? (
                <Select
                  size="small"
                  value={selectedModelId ?? agent.modelId}
                  style={{ minWidth: 160 }}
                  onChange={(next: string) => setSelectedModelId(next)}
                  options={agent.models.map((m) => ({
                    value: m.modelId,
                    label: m.available ? m.modelLabel : `${m.modelLabel}（已停用）`,
                    disabled: !m.available,
                  }))}
                  title="选择本会话使用的模型（来自该智能体的模型池）"
                />
              ) : null}
              {agent?.modelId === null ? (
                // 未绑定模型（多因所属模型商被删除而自动解绑）⇒ 发消息会被后端 409 拦下。
                // 提前说清并指向出路（编辑页重新绑定）。
                <Tag className="tag--danger" title="该智能体未绑定模型，请到编辑页重新绑定后再对话">
                  未绑定模型
                </Tag>
              ) : agent?.modelAvailable === false ? (
                // 绑定模型被停用 ⇒ 发消息会被后端 409 拦下（`shared/src/agent.ts` 的 `modelAvailable`
                // 是服务端投影，前端**照抄**，不自己判角色/不自己看模型池）。提前说，省一次失败。
                <Tag className="tag--danger" title="绑定的模型或其 Provider 已停用，发送会被拒绝">
                  绑定模型不可用
                </Tag>
              ) : null}
              {/* 窄屏产物入口：第三列在 <1280px 被 CSS 藏起来（`app.css` 的 1280 断点），
                  这枚按钮只在窄屏显示（同款断点），点开一个抽屉承载同一个 `ArtifactPanel`。
                  宽屏下按钮被 CSS 隐藏、第三列常驻 ⇒ 不重复。 */}
              {showPanel ? (
                <Button
                  size="small"
                  className="chat__panel-toggle"
                  onClick={() => setArtifactDrawerOpen(true)}
                  title="查看产物列表"
                >
                  产物
                  {artifactItems.length > 0 ? ` · ${artifactItems.length}` : ''}
                </Button>
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
              <MessageList
                messages={messages}
                agentName={agentName}
                recallable={recallable}
                onRecall={(text, hadTools) => openRecall(text, hadTools, false)}
                onResend={(text, hadTools) => openRecall(text, hadTools, true)}
              />
            </StreamFrame>
          )}

          {/* ── 引导问题（产品优化 2026-09-29）：新会话态、开场白下方 ──
              点击**只填入输入框**（可编辑后再发送），不直接发送 —— 与编辑页的提示逐字一致。
              ⚠️ 只在"还没有会话"（`conversationId === undefined`）时出现：首条消息一发出去
              会话就建出来了，那时引导问题作为"开场"的使命已经完成。 */}
          {conversationId === undefined && (agent?.guideQuestions ?? []).length > 0 ? (
            <div className="guide-questions" data-testid="guide-questions">
              <span className="guide-questions__label">试试这样问：</span>
              {(agent?.guideQuestions ?? []).map((question) => (
                <button
                  key={question}
                  type="button"
                  className="guide-chip"
                  onClick={() => setDraft(question)}
                >
                  {question}
                </button>
              ))}
            </div>
          ) : null}

          {/* ── 输入区：状态机 / 停止 / 确认卡全在 `ChatInput` 里（本页只提供数据与回调） ── */}
          <ChatInput
            round={round}
            sending={sending}
            stopping={stopping}
            // "另一个会话在生成"（P0-1-34）：本批前端只有一个轮次槽，切到别的会话再发
            // 会把那一轮覆盖掉并造成串台 ⇒ 输入区显示第六个状态、由 `send` 里的闸门拦住。
            // 判据：有流在跑、且**不是**这个会话（`conversationId` 为 `undefined` 时必然成立）
            elsewhere={streamingId !== null && streamingId !== conversationId}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={() => {
              void submit()
            }}
            onStop={handleStop}
            onConfirmAnswer={handleConfirmAnswer}
            confirmPending={confirmPending}
          />
        </main>

        {/* ── 第三列：产物面板（P0-3-11，**只有 TaskAgent 有**）─────────────────────
            `items` 已经是合流后的清单（服务端列表 + 本轮事件，见上面的 `artifactItems`）；
            本组件不认识那两个来源、也不判"我该不该存在"（由上面的 `showPanel` 决定）。

            ⚠️ `total` 取服务端给的数、**不拿 `items.length` 冒充**：列表一页最多 100 条，
            超过时面板底部那句"仅显示最近 100 个（共 N 个）"只有真 `total` 才说得出来
            （`artifactPanelModel.ts#artifactPanelOverflowNote`）。

            ⚠️ `streaming` 用 `round?.status === 'streaming'`（**当前会话**的那一轮）：
            别的会话在跑时本列不该亮灯 —— 它列出的是**这个**会话的产物。 */}
        {showPanel ? (
          <ArtifactPanel
            items={artifactItems}
            total={artifactsQuery.data?.total}
            listFailed={artifactsQuery.isError}
            onRetry={() => {
              void artifactsQuery.refetch()
            }}
            streaming={round?.status === 'streaming'}
          />
        ) : null}
      </div>

      {/* 预览弹层（P0-3-11）。⚠️ 放在 `.chat` **之外**：`.chat` 是 grid，
          多一个直接子节点会被自动放进隐式的那一列/行（AntD Drawer 默认 portal 到 body，
          但把布局容器当作"顺便的挂载点"是在赌它的默认值不变 —— 摆在外面就不必赌）。

          ⚠️ 它不认识"哪个会话"：产物由 `artifactId` 唯一确定，切会话不关它是**刻意的**
          （用户点开的东西不该被后台悄悄关掉；若那个产物随会话被删了，取内容会 404
          并如实显示"没能取到文件内容"，而不是渲染一片空白）。 */}
      <ArtifactPreviewDrawer
        artifact={previewedArtifact}
        open={previewedArtifact !== null}
        onClose={closePreview}
      />

      {/* 产物列表抽屉（窄屏入口，见头部那枚 `chat__panel-toggle`）。⚠️ 与第三列共用同一个
          `ArtifactPanel`：数据（`items` / `total` / 失败与重试 / 流式）全在这一页算好，
          面板只是换一种摆法。AntD `Drawer` 默认**首次打开才挂载**子节点 ⇒ 宽屏下不产生第二个
          `useMinuteTick` 节拍器。 */}
      {showPanel ? (
        <Drawer
          title="产物"
          placement="right"
          width={340}
          open={artifactDrawerOpen}
          onClose={() => setArtifactDrawerOpen(false)}
        >
          <ArtifactPanel
            items={artifactItems}
            total={artifactsQuery.data?.total}
            listFailed={artifactsQuery.isError}
            onRetry={() => {
              void artifactsQuery.refetch()
            }}
            streaming={round?.status === 'streaming'}
          />
        </Drawer>
      ) : null}

      {/* 撤回 / 修改重发最新一轮（产品优化 2026-09-29）。`conversationId ?? ''` 是类型兜底：
          弹窗只在 `recallTarget` 非空时发请求，而那时 `conversationId` 必然存在（见 `recallable` 的判据） */}
      <RecallConversationModal
        agentId={agentId}
        conversationId={conversationId ?? ''}
        target={recallTarget}
        onClose={() => setRecallTarget(null)}
        onRecalled={handleRecalled}
      />
    </>
  )
}
