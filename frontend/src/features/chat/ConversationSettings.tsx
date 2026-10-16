/**
 * 会话控件（**输入框下方**的一排控件：模型选择器 + 图标按钮）
 *
 * 依据：`子方案/聊天主页与信息架构改造.md` §六 + **R4/R5 修订（2026-10-13）**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 承载演化：标题栏一行 → 齿轮 Popover → 标题栏内联 → 输入框下方控件条（R4）→ 模型回到**文字选择器**（R5）
 * ─────────────────────────────────────────────────────────────────────
 * 用户反馈（R4）：这些是**高频操作**，且放在标题栏会和智能体 chip / 消息区抢横向空间（窄屏、
 * 尤其 Code 模式「专注工作区」把对话列压到 360~420px 时，标题栏会挤成一团）。故移到输入框下方。
 * 用户反馈（R5）：**模型不能只给一个图标** —— 用户要一眼知道"现在用的是哪个模型"。
 * 故：模型仍是**文字选择器**（`Select`，显示当前模型名）；其余开关才用图标 + `Tooltip`。
 *
 * ⚠️ **只换承载容器，不换开关的落点与顺序**：各开关的真值 / pending / 落库时机仍由 `ChatPage` 持有
 * （`onConversationCreated` 开流前落地）；本组件**无状态**（除动效用的一次性 `is-pop`）。
 *   · `Code 模式` 的判据与第三列**同源**（`showPanel`：只有 TaskAgent 有沙箱、有第三列）。
 */

import {
  BulbOutlined,
  CodeOutlined,
  FolderOpenOutlined,
  LayoutOutlined,
  MessageOutlined,
  MinusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { Select, Tag, Tooltip } from 'antd'
import { useState, type ReactNode } from 'react'
import type { AgentItem } from '@doubulea/shared'

export interface ConversationSettingsProps {
  agent: AgentItem | undefined
  conversationId: string | undefined
  /** 本会话选用的模型（`undefined` = 走智能体默认模型） */
  selectedModelId: string | undefined
  onSelectModel: (modelId: string) => void
  /**
   * 缺 Key（「各自 Key」且我未配）的池内模型 id（2026-10-16）。给这些选项标一句「需配 Key」——
   * 让"选了会弹窗"可预期；判据与准入/预检同一份（`modelKeyGuard`），选项**不置灰**
   * （点了会就地弹"去配置"，比一个点不动的灰项有用）。
   */
  keyBlockedModelIds?: ReadonlySet<string>
  autoApprove: boolean
  autoApprovePending: boolean
  onToggleAutoApprove: (enabled: boolean) => void
  memoryExcluded: boolean
  memoryExcludedPending: boolean
  onToggleMemoryExcluded: (excluded: boolean) => void
  codeMode: boolean
  codeModePending: boolean
  onToggleCodeMode: (enabled: boolean) => void
  /** 第三列 / 工作区是否存在（TaskAgent 判据，与 ChatPage 的 `showPanel` 同源） */
  showPanel: boolean
  /** 第三列（非 Code 的产物面板）当前是否展开 */
  panelOpen: boolean
  /** 收起 / 展开第三列（产物面板） */
  onTogglePanel: (open: boolean) => void
  /** Code 模式的专注态（§七 3）：`none` / 专注工作区 / 专注对话 */
  codeFocus: CodeFocus
  onChangeCodeFocus: (focus: CodeFocus) => void
}

/** Code 模式专注态（纯展示枚举；真值在 `ChatPage`，见那里的 `.chat--focus-*`） */
export type CodeFocus = 'none' | 'workspace' | 'chat'

/**
 * 一枚图标按钮：`active` 高亮 + 点击弹动（`is-pop`，动画结束自动摘掉 ⇒ 每次点击都重放）。
 * 用原生 `<button type="button">`：它住在 `ChatInput` 的 `<form>` 里，**不设 type 会提交表单**。
 */
function ControlButton(props: {
  icon: ReactNode
  label: string
  active?: boolean
  danger?: boolean
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const [pop, setPop] = useState(false)
  return (
    <Tooltip title={props.label}>
      <button
        type="button"
        className={
          'composer-control' +
          (props.active === true ? ' is-active' : '') +
          (props.danger === true ? ' is-danger' : '') +
          (props.busy === true ? ' is-busy' : '') +
          (pop ? ' is-pop' : '')
        }
        aria-pressed={props.active ?? false}
        aria-label={props.label}
        disabled={props.disabled ?? false}
        onClick={() => {
          props.onClick()
          setPop(true)
        }}
        onAnimationEnd={() => setPop(false)}
      >
        {props.icon}
      </button>
    </Tooltip>
  )
}

export function ConversationSettings(props: ConversationSettingsProps) {
  const { agent } = props

  // 池里有 2 个及以上模型才给选择器（否则只有默认模型、没有可选项；与改造前同判据）
  const modelPool = agent !== undefined && agent.modelId !== null && agent.models.length >= 2
  const currentModelId = props.selectedModelId ?? agent?.modelId ?? ''
  const currentModelLabel =
    agent?.models.find((m) => m.modelId === currentModelId)?.modelLabel ?? agent?.modelId ?? '默认模型'

  return (
    <div className="composer-controls" data-testid="conversation-settings">
      {/* 模型：**文字选择器**（R5：用户要一眼看到当前模型，不能只给图标）。
          池 ≥2 用下拉；只有 1 个（或未绑定 / 不可用）时退化成文字读数。 */}
      {agent === undefined ? null : agent.modelId === null ? (
        <Tag className="tag--danger" title="该智能体未绑定模型，请到「设置 → 智能体」重新绑定后再对话">
          未绑定模型
        </Tag>
      ) : agent.modelAvailable === false ? (
        <Tag className="tag--danger" title="绑定的模型或其 Provider 已停用，发送会被拒绝">
          绑定模型不可用
        </Tag>
      ) : modelPool ? (
        <Select
          size="small"
          className="composer-model"
          value={currentModelId}
          onChange={props.onSelectModel}
          options={agent.models.map((m) => ({
            value: m.modelId,
            label: !m.available
              ? `${m.modelLabel}（已停用）`
              : props.keyBlockedModelIds?.has(m.modelId) === true
                ? `${m.modelLabel}（需配 Key）`
                : m.modelLabel,
            disabled: !m.available,
          }))}
          title="选择本会话使用的模型（来自该智能体的模型池）"
        />
      ) : (
        <span className="composer-model-chip" title={`当前模型：${currentModelLabel}`}>
          {currentModelLabel}
        </span>
      )}

      {/* 出网范围（P1-16a）**不在会话里配**（2026-10-14 用户定案）：统一在平台「出网策略」页配置。 */}

      <ControlButton
        icon={<SafetyCertificateOutlined />}
        active={props.autoApprove}
        busy={props.autoApprovePending}
        disabled={props.autoApprovePending}
        label={
          props.conversationId === undefined
            ? '自动审批：开启后本会话内危险工具不再逐次弹确认卡（发送第一条消息时生效）'
            : '自动审批：开启后本会话内危险工具不再逐次弹确认卡（会话级）'
        }
        onClick={() => props.onToggleAutoApprove(!props.autoApprove)}
      />

      <ControlButton
        icon={<BulbOutlined />}
        active={!props.memoryExcluded}
        busy={props.memoryExcludedPending}
        disabled={props.memoryExcludedPending}
        label={
          props.memoryExcluded
            ? '本次对话不记入记忆（点击恢复记入）'
            : props.conversationId === undefined
              ? '记入记忆（点击关闭；发送第一条消息时生效）'
              : '记入记忆（点击关闭，本次对话不再写入长期记忆）'
        }
        onClick={() => props.onToggleMemoryExcluded(!props.memoryExcluded)}
      />

      {props.showPanel ? (
        <ControlButton
          icon={<CodeOutlined />}
          active={props.codeMode}
          busy={props.codeModePending}
          disabled={props.codeModePending}
          label={props.codeMode ? 'Code 模式：已开启（点击关闭）' : 'Code 模式：开启人机共享工作区（下次派活生效）'}
          onClick={() => props.onToggleCodeMode(!props.codeMode)}
        />
      ) : null}

      {/* 第三列收起 / 展开（非 Code 的产物面板）。Code 模式已有「专注对话」收起工作区 ⇒ 这里不重复。 */}
      {props.showPanel && !props.codeMode ? (
        <ControlButton
          icon={<FolderOpenOutlined />}
          active={props.panelOpen}
          label={props.panelOpen ? '产物面板：已展开（点击收起）' : '产物面板：已收起（点击展开）'}
          onClick={() => props.onTogglePanel(!props.panelOpen)}
        />
      ) : null}

      {props.codeMode ? (
        <>
          <ControlButton
            icon={<MinusOutlined />}
            active={props.codeFocus === 'none'}
            label="专注：常规（对话 + 工作区并排）"
            onClick={() => props.onChangeCodeFocus('none')}
          />
          <ControlButton
            icon={<LayoutOutlined />}
            active={props.codeFocus === 'workspace'}
            label="专注工作区（对话收窄）"
            onClick={() => props.onChangeCodeFocus('workspace')}
          />
          <ControlButton
            icon={<MessageOutlined />}
            active={props.codeFocus === 'chat'}
            label="专注对话（收起工作区）"
            onClick={() => props.onChangeCodeFocus('chat')}
          />
        </>
      ) : null}
    </div>
  )
}
