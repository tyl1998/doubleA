/**
 * 对话页（"某一个会话的视图"；P0-1-32 骨架 + SSE + 消息流；P0-1-33 输入区/停止/断线；P0-3-11 第三列）
 *
 * ⚠️ **P1-15 的信息架构变更**：本组件**不再读路由参数、不再渲染会话栏**。
 *   · `agentId` / `conversationId` 由外壳（`ChatHomePage`）注入 —— `/c/:id` 的 `agentId` 要从
 *     会话数据反查，页面自己拿不到；
 *   · 跨智能体会话栏在 `ConvRail`（属外壳），导航（选会话 / 新对话 / 删除后去向）也归外壳；
 *   · 头部 = **智能体 chip + 设置图标**（`AgentPicker` + 进编辑智能体）；会话控件（模型 / 自动审批 /
 *     记忆 / Code / 专注 / 产物入口）在**输入框下方**（`ConversationSettings` 作为 `ChatInput` 的 `controls`，
 *     **R4 起不再用齿轮 popover / 标题栏内联**，见 `子方案` §六 / §十五 / §十六）；
 *   · Code 模式列宽 / 专注 / 尺寸口径统一见 §七（常量在 `workspaceModel.ts`）。
 *   · **R3**：只读保留会话（Agent 软删）也能打开（历史可看、输入区换成只读说明），见 `readOnly` 分支。
 *
 * 依据：`docs/03-前端设计.md` §4.1（对话页详设：头部 / 消息流 / **输入区状态机** / 首条消息才建会话 /
 *      **停止时序** / **断线黄条**）、§五（事件 → UI 映射）、§六（单一渲染路径）、
 *      §七（键盘约定、文案词表、删除分级确认）、`子方案/聊天主页与信息架构改造.md`（P1-15）。
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
 * ✅ P0-3-11：**第三列 = 产物面板**（`ArtifactPanel.tsx`，只对 TaskAgent 加 `chat--with-panel`）
 *    + **预览弹层**（`ArtifactPreviewDrawer`，谁在预览住在 `stores/artifactPreview.ts`）。
 *    清单由 `mergeArtifactPanelItems` 一处合流：服务端列表（刷新后还在）+ 本轮 `artifact` 事件
 *    （此刻就在手上）—— 见 `artifactPanelModel.ts` 的文件头（顺序与去重口径都写在那里）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 切会话带来的那一件事：**不动 store**
 * ─────────────────────────────────────────────────────────────────────
 * 用户完全可以在流式期间切到另一个会话（会话栏让它变得容易）。此时：
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

import { DownOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Tag, Tooltip } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { CHAT_ATTACHMENT_MAX_COUNT, HTTP_STATUS_BY_ERROR_CODE } from '@doubulea/shared'
import type { AgentItem, RecallConversationResult } from '@doubulea/shared'

import { useAgent } from '../../api/agents.js'
import { conversationArtifactsQueryKey, useConversationArtifacts } from '../../api/artifacts.js'
import { useAvailableChatModels } from '../../api/models.js'
import {
  conversationMessagesQueryKey,
  fetchConversationActive,
  flattenMessagePages,
  invalidateMyConversations,
  setConversationAutoApprove,
  useConversationMessages,
} from '../../api/conversations.js'
import { ApiError, type ClientErrorCode } from '../../api/client.js'
import { uploadChatFile } from '../../api/files.js'
import { setConversationMemoryExcluded } from '../../api/memory.js'
import { setConversationCodeMode, setConversationRuntime } from '../../api/workspace.js'
import { confirmConversation } from '../../api/mcp.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useFeedback } from '../../app/feedback.js'
import { AGENTS_PATH, agentEditPath, conversationPath, newConversationPath } from '../../app/paths.js'
import { ArtifactPreviewDrawer } from '../../components/ArtifactPreview/ArtifactPreviewDrawer.js'
import { EmptyState, TableSkeleton } from '../../components/ListStates.js'
import { AGENT_TYPE_LABEL } from '../../pages/agents/agentModel.js'
import { AgentPicker } from '../../features/chat/AgentPicker.js'
import { ArtifactPanel } from '../../features/chat/ArtifactPanel.js'
import { mergeArtifactPanelItems, showArtifactPanel } from '../../features/chat/artifactPanelModel.js'
import { ChatInput } from '../../features/chat/ChatInput.js'
import { confirmAnsweredText, confirmIgnoredNote } from '../../features/chat/confirmModel.js'
import { ConversationSettings, type CodeFocus } from '../../features/chat/ConversationSettings.js'
import { DisconnectBanner } from '../../features/chat/DisconnectBanner.js'
import { MemoryNoticeStack } from '../../features/chat/MemoryControls.js'
import { WorkspacePanel, WorkspacePanelPlaceholder } from '../../features/chat/WorkspacePanel.js'
import { useWorkspacePanelResize } from '../../features/chat/useWorkspacePanelResize.js'
import { MessageList } from '../../features/chat/MessageList.js'
import { RecallConversationModal, type RecallTarget } from '../../features/chat/RecallConversationModal.js'
import {
  dropLastRound,
  messagesToViews,
  openingView,
  type AttachmentView,
  type ChatMessageView,
} from '../../features/chat/messageModel.js'
import {
  isModelBlockedByKey,
  missingModelKeyProviders,
  partitionPoolModels,
  pickUsableModelId,
  type MissingModelKeyProvider,
} from '../../features/chat/modelKeyGuard.js'
import { MissingModelKeyModal } from '../../features/chat/MissingModelKeyModal.js'
import { roundToViews } from '../../features/chat/roundReducer.js'
import { chatErrorTitle, shouldToastChatError } from '../../features/chat/streamErrors.js'
import { useChatStream } from '../../features/chat/useChatStream.js'
import { useConversationWatch } from '../../features/chat/useConversationWatch.js'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.js'
import { roundOf, useChatStreamStore } from '../../stores/chatStream.js'

/**
 * 对话页（P0-1-32 起是"某一个会话的视图"）。
 *
 * ⚠️ **P1-15 起它不再读路由参数**：`agentId` / `conversationId` 由外壳（`ChatHomePage`）注入
 * —— `/c/:id` 的 `agentId` 要从会话数据反查，页面自己拿不到。这样它也彻底**不渲染侧栏**
 * （跨智能体会话栏在 `ConvRail`，属外壳）；导航（选会话 / 新对话 / 删除后去向）也归外壳。
 */
export interface ChatPageProps {
  agentId: string
  /** `undefined` = **新会话态**（展示开场白 + 引导问题，首条消息才建会话） */
  conversationId: string | undefined
  /**
   * 会话所属智能体名 / 类型的**快照**（来自会话列表项，见 `shared#conversationItemSchema`）。
   * ⚠️ Agent 被软删时 `GET /api/agents/:id` 是 404，`agent` 取不到，但会话转**只读保留** ——
   * 头部仍要显示"这是谁的对话"，靠这两个快照兜。无会话（新会话态）时为 `undefined`。
   */
  agentName?: string
  agentType?: AgentItem['type']
  /**
   * 只读保留：`true` 时（会话 `status !== 'ACTIVE'`，即其 Agent 已被软删）**能看历史、不能发消息**。
   * 此时即便 `useAgent` 404 也照常渲染（不再报"打不开这个对话"，见 §3 用户反馈）。
   */
  readOnly?: boolean
}

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

/**
 * 出网范围（P1-16a）**不在会话里配**（2026-10-14 用户定案）：统一在平台「出网策略」页
 * （`/admin/egress`）配置，作用于所有会话。会话控件不再有它。
 */

export function ChatPage({
  agentId,
  conversationId,
  agentName: agentNameSnapshot,
  agentType: agentTypeSnapshot,
  readOnly = false,
}: ChatPageProps) {
  const navigate = useNavigate()
  const feedback = useFeedback()
  const queryClient = useQueryClient()

  // `agentId` 为空串时不查（`useAgent` 的 `enabled` 判据是"不是 undefined"，空串会打出一个 400）
  const agentQuery = useAgent(agentId === '' ? undefined : agentId)
  const messagesQuery = useConversationMessages(conversationId)
  // 新建对话前的模型 Key 预检要用它（`ModelOption` 带 `providerCredentialMode` / `providerUserHasKey`）。
  // 与智能体编辑页共用同一个查询键（见 `api/models.ts`），不额外打请求。
  const availableModelsQuery = useAvailableChatModels()

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

  const { round, sending, stopping, disconnect, send, regenerate, stop, steer, align } = useChatStream(
    agentId,
    conversationId,
    {
      // 首条消息建出会话之后把 id 写进 URL（`replace`：不往历史里塞一步"空跳转"）
      onConversationCreated: async (created) => {
        // 这是"新建会话"而不是"切换会话"：别让 reset effect 把用户此刻选的模型清掉
        preserveSelectionRef.current = true
        // 新会话态下预置过自动审批 ⇒ 会话一建出来就先落地到服务端，再导航开流
        // （顺序是关键：写在 `performStream` 之前，第一轮才吃得到）。
        // 消费掉意图后立刻清，避免它被下一条新会话误用。
        const preset = autoApprovePresetRef.current
        autoApprovePresetRef.current = false
        if (preset) {
          try {
            await setConversationAutoApprove(created.id, true)
          } catch (error: unknown) {
            // 落不下就如实说，但**不拦发送**：这一轮退回逐次确认即可，用户仍能继续聊
            feedback.fail(error, '自动审批开关没有保存')
          }
        }
        // 新会话态下预置过 Code 模式 ⇒ 同样在开流前落地（容器 env 在建沙箱时注入，
        // 晚于开流就赶不上第一轮派活）。消费后立刻清，避免被下一条新会话误用。
        const codePreset = codeModePresetRef.current
        codeModePresetRef.current = false
        if (codePreset) {
          try {
            await setConversationCodeMode(created.id, true)
          } catch (error: unknown) {
            // 落不下就如实说，但**不拦发送**：这一轮退回普通模式即可，用户仍能继续聊
            feedback.fail(error, 'Code 模式开关没有保存')
          }
        }
        // 新会话态下预置过**运行时**（P1-17a）⇒ 同样在开流前落地（建沙箱时要按它选镜像）。
        // 消费后立刻清，避免被下一条新会话误用。
        const runtimePreset = runtimePresetRef.current
        runtimePresetRef.current = null
        if (runtimePreset !== null) {
          try {
            await setConversationRuntime(created.id, runtimePreset)
          } catch (error: unknown) {
            // 落不下就如实说，但**不拦发送**：这一轮退回默认运行时即可
            feedback.fail(error, '运行时没有保存')
          }
        }
        // 新会话态下预置过「不记入记忆」⇒ 同样在开流前落地（否则第一轮就被写进长期记忆）。
        // 消费后立刻清，避免被下一条新会话误用。
        const memoryPreset = memoryExcludedPresetRef.current
        memoryExcludedPresetRef.current = false
        if (memoryPreset) {
          try {
            await setConversationMemoryExcluded(created.id, true)
          } catch (error: unknown) {
            // 落不下就如实说，但**不拦发送**：这一轮可能仍会被记入记忆，用户可在记忆面板删掉
            feedback.fail(error, '记忆开关没有保存')
          }
        }
        // 导航到规范会话路径 `/c/:id`；`state.agentId` 是给外壳的兜底（跨智能体列表要等这一轮
        // 结束才失效重取，中间窗口里查不到这条 —— 见 `ChatHomePage` 文件头 ⚠️ ②）。
        navigate(conversationPath(created.id), { replace: true, state: { agentId } })
        // 让会话栏尽快出现这条新会话（不必等这一轮 `done` 才失效；`done` 那次失效仍保留）
        invalidateMyConversations(queryClient)
      },
      ...(agentQuery.data === undefined ? {} : { agentType: agentQuery.data.type }),
    },
  )

  // P1-6 方案 A：观察这条会话"不是本页发起的那一轮"（定时任务后台运行的实时视图）
  useConversationWatch(conversationId)

  const [draft, setDraft] = useState('')
  const [aligning, setAligning] = useState(false)
  /**
   * 本轮**已上传好**的附件（P1-4）：先上传拿 `fileId`，发送时只带 id（后端按归属解析）。
   * 新会话首条消息发送时，`conversationId` 会从 `undefined` 变成新 id —— 那次变化不算"切换会话"，
   * 附件必须保留到"发送成功"再清（与 `selectedModelId` 的保留逻辑同源）。
   */
  const [attachments, setAttachments] = useState<readonly AttachmentView[]>([])
  /** 有附件正在上传（此时发送按钮禁用，避免"附件没带上就发出去"） */
  const [uploading, setUploading] = useState(false)
  /**
   * 新建对话的**模型 Key 预检**结果（2026-10-16 用户定案）。非空 = 弹窗提示"还没配 Key"，
   * **点取消就不建会话**（`submit` 在真正创建前就 return 了）。配完再发即可。
   */
  const [missingKeys, setMissingKeys] = useState<readonly MissingModelKeyProvider[] | null>(null)
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
    // 切换会话时清掉上一个会话选的附件（附件是"这一条消息"的，不该跨会话留着）
    setAttachments([])
  }, [conversationId])

  /** 确认应答在飞（防连点：两个按钮同时禁用，见 `ConfirmCard` 文件头 ③） */
  const [confirmPending, setConfirmPending] = useState(false)
  /** 中途插话请求在飞（P1-9 · P4 · R1；防连点，同 `confirmPending`） */
  const [steerPending, setSteerPending] = useState(false)

  /**
   * 会话级自动审批开关（本地镜像）。打开后本会话内危险的 MCP 工具不再逐次弹确认卡
   * —— 面向"一个场景里连续调很多次 MCP"的用法（真值在服务端 Redis，见 `api/conversations.ts`）。
   * 切换会话时**先重置为关**（安全默认），再问服务端要当前值（`/active` 一并回带 `autoApprove`）。
   */
  const [autoApprove, setAutoApprove] = useState(false)
  /** 开关在飞（保存中禁用 + 转圈） */
  const [autoApprovePending, setAutoApprovePending] = useState(false)
  /**
   * 新会话态下用户**预置**的自动审批意图（P1 增量）。
   *
   * 开关挂在会话上（真值 Redis `chat.autoapprove:{id}`），而会话要等首条消息才建出来。
   * 于是新会话态点开关时**先记在这里、不发请求**；`onConversationCreated` 拿到新会话 id 后、
   * 开流之前把它写到服务端 —— 这样**第一轮**的危险工具也不会先弹一次确认卡。
   */
  const autoApprovePresetRef = useRef(false)
  /**
   * 会话级「不记入记忆」（本地镜像，P1-8）。与会话级自动审批同款：真值在服务端
   * （`conversations.memory_excluded`），随 `/active` 一并回带；切换会话时先重置为"记入"（默认）。
   */
  const [memoryExcluded, setMemoryExcluded] = useState(false)
  const [memoryExcludedPending, setMemoryExcludedPending] = useState(false)
  /**
   * 新会话态下用户**预置**的「不记入记忆」意图（与自动审批 / Code 模式同款）。
   *
   * 开关挂在会话上（真值 `conversations.memory_excluded`），而会话要等首条消息才建出来
   * ⇒ 新会话态点开关时**先记在这里、不发请求**；`onConversationCreated` 拿到新会话 id 后、
   * 开流之前把它写到服务端 —— 这样**第一轮**就不会被记入长期记忆。
   */
  const memoryExcludedPresetRef = useRef(false)
  /**
   * 会话级 **Code 模式**（P1-9 · P3）：true = 工作区走人机共享可编辑形态（第三列换成工作区面板）。
   * 与 `memoryExcluded` 同款 —— 由 `/active` 一并回带；切会话时先重置为关（安全默认）。
   */
  const [codeMode, setCodeMode] = useState(false)
  const [codeModePending, setCodeModePending] = useState(false)
  /**
   * Code 模式专注态（P1-15 · §七 3）：`none`（常规）/ `workspace`（消息流收窄）/ `chat`（收起工作区）。
   * 纯客户端选择（不进 store、不落库）：它不改变任何共享事实，只是"这一屏怎么摆"。
   */
  const [codeFocus, setCodeFocus] = useState<CodeFocus>('none')
  /**
   * 第三列（TaskAgent 的产物面板）是否展开。纯客户端选择（不进 store、不落库）。
   * ⚠️ 只影响**非 Code** 的产物面板：Code 模式的工作区面板走 `panelVisible` 的 `codeMode` 分支
   *    （恒占位，收起/专注由 `codeFocus` 管）。
   *
   * ★ 展开策略（产品反馈 2026-10-14）：
   *   · **新建会话**（`conversationId === undefined`）⇒ 默认**收起**（不该一进来就弹开文件预览那栏）；
   *   · **进入已有 / 固定的历史会话** ⇒ 默认**展开**（保持一贯行为，逻辑不变）；
   *   · 用户在某一屏手动切过的状态，到下一屏（切会话/新建）按上面两条重置。
   */
  const [panelOpen, setPanelOpen] = useState(true)
  /**
   * 新会话态下用户**预置**的 Code 模式意图（与会话级自动审批同款）。
   *
   * `code_mode` 是会话列，会话要等首条消息才建出来 ⇒ 新会话态点开关时**先记在这里、
   * 不发请求**；`onConversationCreated` 拿到新会话 id 后、开流之前把它写到服务端 ——
   * 这样**第一轮**派活时容器就已按 Code 模式注入中介 env。
   */
  const codeModePresetRef = useRef(false)
  /**
   * 会话**运行时**（P1-17a）：Code 会话派活时用它选运行时镜像（`none/node/python/go/java/rust`）。
   * 与 `codeMode` 同款 —— 由 `/active` 一并回带；切会话时先重置为**空串**（= 不指定）。
   * ⚠️ 空串 = **空环境**（只带基础工具链，不额外装语言运行时）：后端 `resolveSandboxRuntimeImage`
   *    找不到该 runtime 时回退 `SANDBOX_IMAGE`，正是"空环境"的语义。**不默认挑任何语言**——
   *    用户不选就用空环境（产品反馈 2026-10-14：新会话不该默认显示 `node`）。
   * ⚠️ 只在 Code 会话里可选（**工作区面板头部**，见 `RuntimeSelect` / `WorkspacePanel`）：非 Code 会话不建容器，运行时不生效。
   */
  const [runtime, setRuntime] = useState<string>('')
  const [runtimePending, setRuntimePending] = useState(false)
  /**
   * 新会话态下用户**预置**的运行时意图（与 Code 模式预置同款）：`null` = 没预置。
   * 会话要等首条消息才建出来 ⇒ 新会话态选运行时先记在这里、`onConversationCreated` 再落地。
   */
  const runtimePresetRef = useRef<string | null>(null)
  useEffect(() => {
    setAutoApprove(false)
    setMemoryExcluded(false)
    setCodeMode(false)
    setRuntime('')
    // 专注态是"这一屏怎么摆"，切会话回到常规（否则下条会话莫名收着工作区）
    setCodeFocus('none')
    // 产物面板展开态（见 panelOpen 的注释）：**新建会话默认收起、进入历史会话默认展开**。
    // ⚠️ Code 模式不看它（走 panelVisible 的 codeMode 分支），所以这里对 Code 会话无副作用。
    setPanelOpen(conversationId !== undefined)
    if (conversationId === undefined) {
      // 回到新会话态：清掉上一条会话残留的"预置自动审批 / 不记入记忆 / Code 模式"意图
      // （否则下条新会话会被它带偏）
      autoApprovePresetRef.current = false
      memoryExcludedPresetRef.current = false
      codeModePresetRef.current = false
      runtimePresetRef.current = null
      return
    }
    let cancelled = false
    void fetchConversationActive(conversationId)
      .then((active) => {
        if (cancelled) return
        setAutoApprove(active.autoApprove)
        setMemoryExcluded(active.memoryExcluded)
        setCodeMode(active.codeMode)
        setRuntime(active.runtime)
      })
      .catch(() => {
        // `/active` 只是只读探活：读不到就保持"关"（安全默认），也不弹错 ——
        // 它与断线对齐共用，失败不影响本轮对话。
      })
    return () => {
      cancelled = true
    }
  }, [conversationId])
  /**
   * Code 模式第三列（IDE 面板）的宽度拖拽（P1-9 · R12）。
   * ⚠️ 宽度经 CSS 变量 `--panel-w` 注入（见下面的 `style`）——**不能直接写 `grid-template-columns`**：
   * 内联样式会盖掉 <1280px 断点里"第三列改按比例收窄"的那条媒体查询（`app.css`），窄屏就会硬留一列。
   */
  const wsPanel = useWorkspacePanelResize(codeMode && conversationId !== undefined, conversationId)
  /**
   * 记忆提示刷新键（P1-8）：每轮结束/开始时 +1 ⇒ `MemoryNoticeStack` 拉一次"待展示提示"
   * （兑现 HCI §5.3 的"toast 晚一拍"：自动写入发生在 `done` 之后，提示只能在下一拍出现）。
   */
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0)
  useEffect(() => {
    setMemoryRefreshKey((key) => key + 1)
    // 这个会话这一轮的**状态**变了（开始 / 结束）就刷一次。P1-19 多流后按"当前会话"的状态算
    //（早先依赖全局的 `streamingId`；那个单值在多流下已经没有意义）。
  }, [round?.status])
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
  // 只读保留会话里 Agent 已软删（`useAgent` 404）⇒ 用会话列表项的快照兜名字/类型
  const agentName = agent?.name ?? agentNameSnapshot ?? '智能体'
  const agentTypeLabel =
    agent !== undefined
      ? AGENT_TYPE_LABEL[agent.type]
      : agentTypeSnapshot !== undefined
        ? AGENT_TYPE_LABEL[agentTypeSnapshot]
        : ''
  // 面包屑（顶栏）里这一页的细节段 = 智能体名 ⇒ `工作台 / 智能体 / <名称>`（加载中只到「智能体」）
  usePageCrumb(agent?.name ?? agentNameSnapshot ?? null)

  /**
   * 历史（正序）→ 视图；流式轮次 → 视图；两者**同一形状**（单一渲染路径）。
   *
   * ⚠️ **两份历史**：`allHistory` 是服务端原样（"落库的真相"），`history` 是**渲染用**的
   * —— 重新生成期间（`round.kind === 'regenerate'`）把**正在被替换的那一轮**从渲染里收起
   * （`dropLastRound`）。后端此刻正用同一段正文重跑、并把旧轮次替换掉，不收起来就会
   * 与新流式轮次渲染出重复气泡（而用户点的是"替换"）。
   *
   * ⚠️ 不能用 `history`（渲染用的那份）去判"落库版本是否已到位"—— 它把新落的那一轮也一起
   * 收起来了，会让收尾后的"让位"永远等不到（见下面的对齐 effect）。故那里用 `allHistory`。
   */
  const allHistory = useMemo(() => messagesToViews(flattenMessagePages(messagesQuery.data)), [messagesQuery.data])
  const history = useMemo(
    () => (round?.kind === 'regenerate' ? dropLastRound(allHistory) : allHistory),
    [allHistory, round?.kind],
  )
  const streamViews = useMemo(() => (round === null ? [] : roundToViews(round)), [round])

  /**
   * 本会话**最后使用的模型**（产品优化 2026-09-29）—— 从已落库历史的最后一条带 `model`
   * 段的助手消息取（越靠后越新）。重进会话时头部选择器要回显它，而不是每次都回落到默认。
   */
  const lastUsedModel = useMemo(() => {
    // 用**未收起**的历史：模型回显要的是"落库的最后一轮用了什么"，与渲染收起无关
    for (let index = allHistory.length - 1; index >= 0; index--) {
      const view = allHistory[index]
      if (view === undefined) continue
      const model = view.model
      if (model !== undefined) return model
    }
    return undefined
  }, [allHistory])

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

  /**
   * 新会话态：保证"本会话要用的模型"是**现在真的能用**的（2026-10-16 用户定案）。
   *
   * 默认模型是「各自 Key」而我没配时**不把整段对话拦死** —— 换一个能用的开起来（优先共享 Key，
   * 见 `pickUsableModelId`）。用户仍可在选择器里换回那个模型，那时会弹"去配置"。
   * ⚠️ 只在**新会话态**做：已有会话用哪个模型是历史的一部分，不该被悄悄改掉。
   */
  useEffect(() => {
    if (conversationId !== undefined) return
    const agent = agentQuery.data
    const items = availableModelsQuery.data?.items
    if (agent === undefined || items === undefined) return
    const current = selectedModelId ?? agent.modelId ?? ''
    if (current === '' || !isModelBlockedByKey(current, items)) return
    const fallback = pickUsableModelId(
      agent.models.map((model) => model.modelId),
      items,
    )
    if (fallback !== null && fallback !== current) setSelectedModelId(fallback)
  }, [agentQuery.data, availableModelsQuery.data, conversationId, selectedModelId])

  /** 缺 Key 的池内模型 id（选择器里给它们标一句"需配 Key"，让"选了会弹窗"可预期） */
  const keyBlockedModelIds = useMemo(
    () =>
      new Set(
        partitionPoolModels(
          agent?.models.map((model) => model.modelId) ?? [],
          availableModelsQuery.data?.items ?? [],
        ).blockedModelIds,
      ),
    [agent?.models, availableModelsQuery.data],
  )

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

  /**
   * 可「重新生成」的目标（P1-3）：**历史里最后一条助手回答** + 它所回答的那条用户消息正文。
   *
   * 判据四条：有会话 + 没有流在跑 + 最后一条是**助手回答** + 它能找到紧邻往前的用户消息。
   * 「最后一条是助手回答」是刻意的：按钮挂在**被替换的那条回答**上（需求："替换原回答"）；
   * 若最新一轮只有问题、还没有回答，用户该用的是那条用户消息上的「撤回/修改重发」。
   *
   * 用 `allHistory`（未收起）而不是 `history`：重新生成期间后者会把这一轮整体收掉，
   * 但那时 `round !== null`、本 memo 本来就返回 `null`，用哪份都一样；显式用 allHistory
   * 是为了让"判据看的是落库真相"这件事一目了然。
   */
  const regenerable = useMemo(() => {
    if (conversationId === undefined) return null
    if (round !== null) return null
    const last = allHistory[allHistory.length - 1]
    if (last === undefined || last.role !== 'ASSISTANT') return null
    for (let index = allHistory.length - 2; index >= 0; index--) {
      const view = allHistory[index]
      if (view?.role === 'USER') return { key: last.key, userText: view.text }
    }
    return null
  }, [conversationId, allHistory, round])

  // ── 产物面板（P0-3-11）──────────────────────────────────────────────────────
  //
  // ⚠️ **只有 TaskAgent 有这一列**（`03` §4.1 的"TaskAgent 差异"）。判据是 `agent.type`
  //    而不是"有没有产物"—— 理由在 `artifactPanelModel.ts` 的文件头（类型在创建时定死、
  //    "有没有产物"不是 ⇒ 后者会让面板在第一次派活之前不存在、之后凭空出现）。
  //    `agent` 还没到时按"不显示"处理：三栏的 `grid-template-columns` 变一次会让中栏跳一下。
  // 第三列判据：Agent 类型。⚠️ 只读保留会话里 Agent 已软删 ⇒ 用会话项的类型快照兜，
  // 这样 TaskAgent 的只读会话仍能看产物 / 工作区（历史不该因为 Agent 被删就消失）。
  const showPanel = showArtifactPanel(agent?.type ?? agentTypeSnapshot)
  /**
   * 第三列**当前是否占位**。
   *
   * ⚠️ 展开判据**分模式**（产品反馈 2026-10-14 修订）：
   *   · **非 Code**（产物面板）：由 `panelOpen` 决定 —— 默认**收起**（新建 TaskAgent 会话不该
   *     默认弹开文件预览那栏），用户自己展开；
   *   · **Code 模式**（工作区面板）：**恒占位**，不看 `panelOpen` —— 工作区是 Code 模式的核心，
   *     它自己的收起/专注走 `codeFocus`（`chat--focus-chat` 用 CSS 隐藏 `.panel`）。
   *     ⚠️ 不能再拿 `panelOpen` 管它：那个默认已改成收起，会让"Code 会话打开就看不到工作区"。
   */
  const panelVisible = showPanel && (codeMode || panelOpen)

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
    // ⚠️ 用 `allHistory`（**未收起**）：重新生成期间渲染用的 `history` 把整个最新一轮都收掉了
    // （包括刚落库的新回答）⇒ 用它会永远匹配不到，流式版本永远不让位。
    if (allHistory.some((view) => view.key === messageId)) {
      if (conversationId !== undefined) useChatStreamStore.getState().reset(conversationId)
    }
  }, [round, allHistory, conversationId])

  /**
   * 重新生成**失败** ⇒ 收掉这一轮的流式版本，让历史重新呈现服务端真实状态（P1-3）。
   *
   * 为什么必须收：重新生成期间页面把"正在被替换的那一轮"从渲染里收起了（见上面的 `history`），
   * 而**失败并不意味着那一轮被换掉** —— 前置失败（闸门 409/424）与并发冲突（`CONFLICT`）
   * 都发生在撤销动作之前/未改库，旧回答还在。不收掉这一轮，用户就会**看不到自己原有的回答**
   * （被 `dropLastRound` 一直藏着），而屏幕上只挂着一张错误卡。
   *
   * 收掉之后：`round` 回到 `null` ⇒ 收起判据失效 ⇒ 历史（`performStream` 收尾已让它失效重取）
   * 自行呈现服务端真相 —— 旧回答还在就显示旧的，已被替换成部分回答就显示部分回答。
   * 失败的告知不受影响：服务端故障走错误卡 + toast（下面那个 effect），客户端中断走顶部黄条。
   */
  useEffect(() => {
    if (round === null || round.kind !== 'regenerate' || round.status !== 'error') return
    if (conversationId !== undefined) useChatStreamStore.getState().reset(conversationId)
  }, [round, conversationId])

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

  /**
   * 选中附件（P1-4）：**逐个上传**（不并发），成功的立即出现、失败的各自提示。
   *
   * 三条口径：
   *   · **逐个**而不是 `Promise.all`：一个失败不会连累另外几个（它们其实已经传成功了，
   *     `Promise.all` 的 reject 会让那几份变成"传了但界面上没有"的孤儿）；
   *   · **超出上限的截掉并明说**（`CHAT_ATTACHMENT_MAX_COUNT`，与后端 schema 同源）；
   *   · 上传中置 `uploading` ⇒ 发送按钮禁用（否则会发出一条"附件还没带上"的消息）。
   */
  const handlePickFiles = useCallback(
    (files: FileList): void => {
      const picked = Array.from(files)
      const slots = CHAT_ATTACHMENT_MAX_COUNT - attachments.length
      if (slots <= 0) {
        feedback.note(`最多只能带 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件`)
        return
      }
      const accepted = picked.slice(0, slots)
      if (picked.length > slots) feedback.note(`最多只能带 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件，多余的已忽略`)

      setUploading(true)
      void (async () => {
        const added: AttachmentView[] = []
        for (const file of accepted) {
          try {
            added.push(await uploadChatFile(file))
          } catch (error) {
            feedback.fail(error, `附件「${file.name}」上传失败`)
          }
        }
        if (added.length > 0) setAttachments((previous) => [...previous, ...added])
        setUploading(false)
      })()
    },
    [attachments.length, feedback],
  )

  /** 移除一个已上传附件（只从本轮移除；服务端那份不影响历史消息） */
  const handleRemoveAttachment = useCallback((fileId: string): void => {
    setAttachments((previous) => previous.filter((item) => item.fileId !== fileId))
  }, [])

  /**
   * 选择器换模型（2026-10-16 用户定案）：换到"缺 Key 的各自 Key 模型"时**不切换**，改弹"去配置"。
   * 可选列表没到时判不了 ⇒ 直接切（发送时还有一次兜底）。
   */
  const handleSelectModel = useCallback(
    (modelId: string): void => {
      const missing = missingModelKeyProviders([modelId], availableModelsQuery.data?.items ?? [])
      if (missing.length > 0) {
        setMissingKeys(missing)
        return
      }
      setSelectedModelId(modelId)
    },
    [availableModelsQuery.data],
  )

  const submit = useCallback(async (): Promise<void> => {
    // 只读保留会话（Agent 已软删）：不发消息（输入区在界面上已被只读提示替换，这里再兜一道）
    if (readOnly) return
    const text = draft.trim()
    if (text === '') return
    // 新建对话（还没建出会话）再兜一道**模型 Key 预检**：本次要用的模型缺 Key ⇒ 弹窗、**不建会话**。
    // ⚠️ 主准入点在 `AgentPicker`（池里一个能用的都没有才拦）；进会话后会先把默认模型换成能用的
    //（见上面的 fallback effect），所以这里通常不会触发 —— 它挡的是"可选列表晚到 / 深链"等窗口。
    // ⚠️ 放在清空草稿**之前**：拦下来时正文与附件都还在输入区。
    if (conversationId === undefined) {
      const usedModelId = selectedModelId ?? agentQuery.data?.modelId ?? ''
      const missing =
        usedModelId === ''
          ? []
          : missingModelKeyProviders([usedModelId], availableModelsQuery.data?.items ?? [])
      if (missing.length > 0) {
        setMissingKeys(missing)
        return
      }
    }
    // 先清空输入框（体感"发出去了"），失败时再还回来 —— 见下面的 `setDraft(text)`。
    // ⚠️ "能不能发"由输入区状态机（`composerState.ts#canSend`）判，这里**不再判一次**：
    // 两处判据必然漂移（最典型：这里放行了、按钮却是灰的，用户看到"没反应"）
    const sentAttachments = attachments
    setDraft('')
    setAttachments([])
    const outcome = await send(text, selectedModelId, sentAttachments)
    if (!outcome.ok) {
      // 前置失败（401/400/404/409 只读/424 缺凭据）与**同标签页重复发送**（`BUSY`）：
      // 这一轮一个字都没落库 ⇒ 界面上不该留下它，正文与附件还给输入区，用户不必重来
      setDraft(text)
      setAttachments(sentAttachments)
      feedback.fail(outcome.error, '发送失败')
    }
  }, [agentQuery.data, attachments, availableModelsQuery.data, conversationId, draft, feedback, readOnly, send, selectedModelId])

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
   * 点「插话」（P1-9 · P4 · R1）：把**当前草稿**插给运行中的 agent，**不打断**这一轮。
   *
   * 三种结局都如实说：
   *   · `ok:true, accepted:true` —— 已投递（agent 在助手 turn 边界读到）⇒ 清草稿 + 轻提示；
   *   · `ok:true, accepted:false` —— 流刚好结束（幂等）⇒ **保留草稿**，提示"没送到"；
   *   · `ok:false` —— 网络/信封错误 ⇒ 报错，草稿照样保留。
   */
  const handleSteer = useCallback((): void => {
    const text = draft.trim()
    if (text === '') return
    setSteerPending(true)
    void steer(text)
      .then((outcome) => {
        if (!outcome.ok) {
          feedback.fail(outcome.error, '插话失败')
          return
        }
        if (outcome.accepted) {
          setDraft('')
          feedback.ok('已插话：agent 会在当前步骤跑完后读到')
        } else {
          feedback.note('这一轮刚好结束了，插话没送到（内容已保留在输入框）')
        }
      })
      .finally(() => {
        setSteerPending(false)
      })
  }, [draft, feedback, steer])

  /**
   * 点「重新生成」（P1-3）：**重跑最新一轮的问题、替换当前回答**。
   *
   * 走的是当前选中的模型（`selectedModelId`）—— 于是"换个模型重跑一遍"就是先在选择器里选好、
   * 再点重新生成。失败（前置失败：会话只读 / 模型不可用 / 缺凭据 / 并发冲突）与发送同口径：
   * 只给一条提示，界面上原有的一轮**不动**（后端那一步大概率也没发生）。
   */
  const handleRegenerate = useCallback((): void => {
    if (regenerable === null) return
    void regenerate(regenerable.userText, selectedModelId).then((outcome) => {
      if (!outcome.ok) feedback.fail(outcome.error, '重新生成失败')
    })
  }, [regenerable, regenerate, selectedModelId, feedback])

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
      const confirm = roundOf(useChatStreamStore.getState(), conversationId)?.confirm ?? null
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
          if (conversationId !== undefined) useChatStreamStore.getState().clearConfirm(conversationId)
        })
    },
    [conversationId, feedback],
  )

  /**
   * 切换会话级自动审批。请求成功后才用服务端回带的值对齐本地开关（不乐观更新）：
   * 这是一个"会放行破坏性操作"的模式，宁可慢一拍，也不要让界面显示"已开启"而服务端其实没写进去。
   */
  const handleToggleAutoApprove = useCallback(
    (next: boolean): void => {
      // 新会话态（会话还没建）：开关挂在会话上，没法写服务端 ⇒ 先记意图、只改本地，
      // 等首条消息建出会话、开流前再落地（见 `onConversationCreated` / `autoApprovePresetRef`）。
      if (conversationId === undefined) {
        autoApprovePresetRef.current = next
        setAutoApprove(next)
        return
      }
      setAutoApprovePending(true)
      void setConversationAutoApprove(conversationId, next)
        .then((result) => {
          setAutoApprove(result.autoApprove)
          feedback.ok(
            result.autoApprove
              ? '已开启自动审批：本会话内危险工具不再逐次确认'
              : '已关闭自动审批：恢复逐次确认',
          )
        })
        .catch((error: unknown) => {
          feedback.fail(error, '自动审批开关没有保存')
        })
        .finally(() => {
          setAutoApprovePending(false)
        })
    },
    [conversationId, feedback],
  )

  /**
   * 切换会话级「不记入记忆」（P1-8，HCI §5.2.1）。与自动审批同款：请求成功后才对齐本地开关
   * （不乐观更新）—— 让界面显示的状态与服务端真正落库的状态一致。
   */
  const handleToggleMemoryExcluded = useCallback(
    (next: boolean): void => {
      // 新会话态（会话还没建）：开关挂在会话上，没法写服务端 ⇒ 先记意图、只改本地，
      // 等首条消息建出会话、开流前再落地（见 `onConversationCreated` / `memoryExcludedPresetRef`）。
      if (conversationId === undefined) {
        memoryExcludedPresetRef.current = next
        setMemoryExcluded(next)
        return
      }
      setMemoryExcludedPending(true)
      void setConversationMemoryExcluded(conversationId, next)
        .then((result) => {
          setMemoryExcluded(result.memoryExcluded)
          feedback.ok(result.memoryExcluded ? '本次对话不记入记忆' : '本次对话恢复记入记忆')
        })
        .catch((error: unknown) => {
          feedback.fail(error, '记忆开关没有保存')
        })
        .finally(() => {
          setMemoryExcludedPending(false)
        })
    },
    [conversationId, feedback],
  )

  /**
   * 切换会话级 **Code 模式**（P1-9 · P3）。与「不记入记忆」同款：请求成功后才对齐本地开关
   * （不乐观更新）—— 界面显示的状态与服务端落库状态一致。
   * ⚠️ 开关**下次派活生效**（容器 env 在创建沙箱时注入，见 `sandbox/manager.ts`）。
   */
  const handleToggleCodeMode = useCallback(
    (next: boolean): void => {
      // 新会话态（会话还没建）：`code_mode` 是会话列，没法写服务端 ⇒ 先记意图、只改本地，
      // 等首条消息建出会话、开流前再落地（见 `onConversationCreated` / `codeModePresetRef`）。
      if (conversationId === undefined) {
        codeModePresetRef.current = next
        setCodeMode(next)
        return
      }
      setCodeModePending(true)
      void setConversationCodeMode(conversationId, next)
        .then((result) => {
          setCodeMode(result.codeMode)
          feedback.ok(result.codeMode ? '已开启 Code 模式（下次派活生效）' : '已关闭 Code 模式')
        })
        .catch((error: unknown) => {
          feedback.fail(error, 'Code 模式开关没有保存')
        })
        .finally(() => {
          setCodeModePending(false)
        })
    },
    [conversationId, feedback],
  )

  /**
   * 选择**会话运行时**（P1-17a）。与 `handleToggleCodeMode` 同款：新会话态先记意图、只改本地，
   * 等首条消息建出会话、开流前再落地（见 `onConversationCreated` / `runtimePresetRef`）。
   * ⚠️ 运行时**下次派活生效**（`ensureSandbox` 按 `doubulea.runtime` 标签比对，不一致就回收重建）。
   */
  const handleSelectRuntime = useCallback(
    (next: string, ready: boolean): void => {
      if (conversationId === undefined) {
        runtimePresetRef.current = next
        setRuntime(next)
        return
      }
      setRuntimePending(true)
      void setConversationRuntime(conversationId, next)
        .then((result) => {
          setRuntime(result.runtime)
          // 区分三种情形：空环境（不选语言）/ 镜像已就绪 / 本机没有（需先构建）。
          // （选择本身只是持久化意图，真正的建容器/换镜在**下次派活**时发生，见 ensureSandbox 的 runtime 标签比对。）
          if (result.runtime === '') {
            feedback.ok('已切换为空环境（仅基础工具链），下次派活生效')
          } else if (ready) {
            feedback.ok('已切换运行时，下次派活生效')
          } else {
            feedback.note('已切换运行时，但本机暂无该环境镜像，需先构建后才会生效（下次派活时）')
          }
        })
        .catch((error: unknown) => {
          feedback.fail(error, '运行时没有保存')
        })
        .finally(() => {
          setRuntimePending(false)
        })
    },
    [conversationId, feedback],
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

  // ── 智能体取不到（不存在 / 已软删 / 链接里的 id 不对）：给一条能回去的路。
  // ⚠️ **只读保留的会话除外**（`readOnly`）：Agent 被软删后会话转只读保留（`02` §4.4），
  //    此时 `useAgent` 必然 404，但历史看得见、只是不能再发消息 —— 不该报"打不开这个对话"。
  if (agentQuery.isError && !readOnly) {
    return (
      // 居中空态（与聊天主页「找不到这个会话」同一副面孔）：`.chat-home__welcome` 把内容在主区
      // 居中，`EmptyState` 内部再水平居中 —— 不再是靠左的标题栏。
      <div className="chat-home__welcome" data-testid="chat-agent-error">
        <EmptyState
          title="打不开这个对话"
          lead="智能体取不到（可能已被删除，或链接里的 id 不对）。"
          action={
            <Link to={AGENTS_PATH}>
              <Button type="primary">回智能体列表</Button>
            </Link>
          }
        />
      </div>
    )
  }

  return (
    // `.chat` 的形态（`03` §4.1）：**消息流 +（TaskAgent 的）产物 / 工作区面板**。
    // ⚠️ P1-15 起**会话栏不在这一层**了 —— 它是聊天主页外壳（`ChatHomePage` → `ConvRail`）的一列，
    // 因为它是**跨智能体**的历史（与"当前会话属于谁"无关）。这里只剩消息流与第三列。
    <>
      <div
        className={`chat${panelVisible ? ' chat--with-panel' : ''}${codeMode ? ' chat--code' : ''}${codeMode && codeFocus !== 'none' ? ` chat--focus-${codeFocus}` : ''}`}
        style={
          codeMode ? ({ '--panel-w': `${wsPanel.width}px` } as CSSProperties) : undefined
        }
      >
        <main className="chat__main" aria-label="当前会话">
          <div className="chat__head">
            {/* 智能体 chip：点开 = 换智能体 ⇒ 进入它的**新会话态**（不建会话）。
                只读保留会话里 Agent 已删，chip 仍显示名字快照（点开可换到别的智能体开新对话）。 */}
            <AgentPicker
              trigger={
                <>
                  <Tag className="chat__agent-name">{agentName}</Tag>
                  <span className="chat__agent-type">{agentTypeLabel}</span>
                  <DownOutlined />
                </>
              }
              triggerClassName="chat__agent-chip"
              triggerTitle="切换智能体（进入新会话）"
              onPick={(nextAgentId) => navigate(newConversationPath(nextAgentId))}
            />
            {/* 只读保留（Agent 被软删）：明确告知历史可看、但不能再发消息 */}
            {readOnly ? (
              <Tag
                className="tag--warn"
                title="该智能体已被删除，此会话只读保留：历史可查看，但不能再发送消息"
              >
                只读保留
              </Tag>
            ) : null}

            {/* 标题栏右侧只留一枚**设置图标**（R4 / 用户反馈：直接进编辑智能体） */}
            <div className="chat__head-right">
              {agent === undefined ? null : (
                <Tooltip title="编辑智能体">
                  <Link to={agentEditPath(agent.id)} className="chat__settings" aria-label="编辑智能体">
                    <SettingOutlined />
                  </Link>
                </Tooltip>
              )}
            </div>
          </div>

          {/* 顶部黄条：断线 / 停止没收到服务端确认（`03` §4.1："点击黄条 = 立即拉取历史对齐"）。
              它由 store 持有（不是轮次的一部分）—— 因为"对齐"本身会把轮次丢掉，
              见 `stores/chatStream.ts` 的 `DisconnectState` */}
          {disconnect === null ? null : (
            <DisconnectBanner extra={disconnect.extra} aligning={aligning} onAlign={handleAlign} />
          )}

          {/* 长期记忆提示（P1-8，toast 晚一拍）：自动写入可撤销 / 偏好建议可记住。
              只在有提示时渲染；由 `MemoryNoticeStack` 自己按会话/聚焦/每轮拉取。 */}
          <MemoryNoticeStack conversationId={conversationId} refreshKey={memoryRefreshKey} />

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
                regenerable={regenerable}
                onRegenerate={handleRegenerate}
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

          {/* ── 输入区：状态机 / 停止 / 确认卡全在 `ChatInput` 里（本页只提供数据与回调）。
              只读保留会话（Agent 已软删）**不给输入区** —— 换成一句说明（不能再发消息）。 ── */}
          {readOnly ? (
            <div className="chat__readonly" role="note">
              <Tag className="tag--warn">只读保留</Tag>
              <span>该智能体已被删除，此会话只保留历史记录，不能再发送消息。</span>
            </div>
          ) : (
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
              onConfirmAnswer={handleConfirmAnswer}
              confirmPending={confirmPending}
              attachments={attachments}
              uploading={uploading}
              onPickFiles={handlePickFiles}
              onRemoveAttachment={handleRemoveAttachment}
              // 中途插话（P1-9 · P4 · R1；P1-20 起**两种会话都支持**）：TaskAgent 投给 pi 引擎，
              // ChatBot 在**下一次上游调用前**注入（producer 已注册 steer 监听器）。是否出现由状态机的
              // `view.steer` 决定（仅在"正在生成 + 草稿非空"时放出），本组件不另判。
              steerable
              onSteer={handleSteer}
              steerPending={steerPending}
              // R4：会话控件（模型 / 自动审批 / 记忆 / Code 模式 / 专注）摆到输入框下方
              controls={
                <ConversationSettings
                  agent={agent}
                  conversationId={conversationId}
                  selectedModelId={selectedModelId}
                  onSelectModel={handleSelectModel}
                  keyBlockedModelIds={keyBlockedModelIds}
                  autoApprove={autoApprove}
                  autoApprovePending={autoApprovePending}
                  onToggleAutoApprove={handleToggleAutoApprove}
                  memoryExcluded={memoryExcluded}
                  memoryExcludedPending={memoryExcludedPending}
                  onToggleMemoryExcluded={handleToggleMemoryExcluded}
                  codeMode={codeMode}
                  codeModePending={codeModePending}
                  onToggleCodeMode={handleToggleCodeMode}
                  showPanel={showPanel}
                  panelOpen={panelOpen}
                  onTogglePanel={setPanelOpen}
                  codeFocus={codeFocus}
                  onChangeCodeFocus={setCodeFocus}
                />
              }
            />
          )}
        </main>

        {/* ── 第三列：产物面板（P0-3-11，**只有 TaskAgent 有**）─────────────────────
            `items` 已经是合流后的清单（服务端列表 + 本轮事件，见上面的 `artifactItems`）；
            本组件不认识那两个来源、也不判"我该不该存在"（由上面的 `showPanel` 决定）。

            ⚠️ `total` 取服务端给的数、**不拿 `items.length` 冒充**：列表一页最多 100 条，
            超过时面板底部那句"仅显示最近 100 个（共 N 个）"只有真 `total` 才说得出来
            （`artifactPanelModel.ts#artifactPanelOverflowNote`）。

            ⚠️ `streaming` 用 `round?.status === 'streaming'`（**当前会话**的那一轮）：
            别的会话在跑时本列不该亮灯 —— 它列出的是**这个**会话的产物。 */}
        {panelVisible ? (
          codeMode ? (
            conversationId !== undefined ? (
              // Code 模式：第三列换成**工作区面板**（P1-9 · P3）—— 人机共享可编辑（§六 4）
              <aside className="panel" aria-label="工作区面板">
                <div
                  className={`ws-resizer${wsPanel.dragging ? ' is-active' : ''}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整工作区面板宽度"
                  onPointerDown={wsPanel.onPointerDown}
                />
                <WorkspacePanel
                  conversationId={conversationId}
                  codeMode={codeMode}
                  runtime={runtime}
                  runtimePending={runtimePending}
                  onSelectRuntime={handleSelectRuntime}
                />
              </aside>
            ) : (
              // 新会话态（会话还没建出来）：Code 模式已开、工作区还没创建 ⇒ 给**空工作区占位**，
              // 不回落到产物面板（否则"开了 Code 模式"看起来没生效，且首条消息后会突变一列）。
              <aside className="panel" aria-label="工作区面板">
                <WorkspacePanelPlaceholder
                  runtime={runtime}
                  runtimePending={runtimePending}
                  onSelectRuntime={handleSelectRuntime}
                />
              </aside>
            )
          ) : (
            <ArtifactPanel
              items={artifactItems}
              total={artifactsQuery.data?.total}
              listFailed={artifactsQuery.isError}
              onRetry={() => {
                void artifactsQuery.refetch()
              }}
              streaming={round?.status === 'streaming'}
            />
          )
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

      {/* 撤回 / 修改重发最新一轮（产品优化 2026-09-29）。`conversationId ?? ''` 是类型兜底：
          弹窗只在 `recallTarget` 非空时发请求，而那时 `conversationId` 必然存在（见 `recallable` 的判据） */}
      <RecallConversationModal
        agentId={agentId}
        conversationId={conversationId ?? ''}
        target={recallTarget}
        onClose={() => setRecallTarget(null)}
        onRecalled={handleRecalled}
      />

      {/* 新建对话的模型 Key 预检（2026-10-16 用户定案）：缺 Key ⇒ 弹窗；**取消即不创建会话**
          （`submit` 已在创建前 return，未清草稿）。主触发点在 `AgentPicker`（选中智能体时拦），
          这里是**其它进入 `/new/:agentId` 的路**（列表页「对话」/ 深链）的兜底。 */}
      <MissingModelKeyModal missing={missingKeys} onClose={() => setMissingKeys(null)} />
    </>
  )
}
