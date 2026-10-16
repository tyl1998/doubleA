/**
 * 智能体选择器（P1-15 · 新对话的入口）
 *
 * 依据：`子方案/聊天主页与信息架构改造.md` §五（"新对话与智能体选择器"）：
 *   触发点两处（会话栏的「＋ 新对话」、对话标题栏的智能体 chip），**同一个弹层**；
 *   数据源复用 `api/agents.ts#useAgents`（与智能体列表页同源）；搜索/分组在客户端。
 *
 * ⚠️ 选中 ⇒ **只导航到 `/new/:agentId`**（新会话态），**不建会话**：会话由首条消息发送时才建
 * （`03` §4.1 与 `useChatStream` 的契约）。选择器因此不认识"会话"这回事，只报一个 `agentId`。
 *
 * ⚠️ **2026-10-16 修订（用户定案）：选中前先做「模型 Key 预检」，但只在"一个能用的都没有"时才拦**。
 * 池里只要还有一个能用（共享 Key，或「各自 Key」且我已配）的模型就放行 —— 默认模型缺 Key 时由
 * `ChatPage` 换一个能用的开起来，用户**手动选到**缺 Key 的模型时再弹窗。判据是纯逻辑
 * `modelKeyGuard`（`isConversationBlocked` / `partitionPoolModels` / `missingModelKeyProviders`）。
 * 这是"新建会话 → 选择智能体"这条路上**唯一**的准入点；其它进入 `/new/:agentId` 的路
 * （列表页「对话」、深链）由 `ChatPage` 兜底再判（同一个判据）。
 *
 * ⚠️ 刻意**不做"最近使用"分组**：`agents` 表没有"我最近用过谁"这个字段，唯一能证明"最近用过"
 *   的是会话历史（`lastMessageAt`）。为了一个视觉分组去翻 `/api/conversations` 再拼回来，
 *   既多打一次请求、又会在没有会话时什么也显示不出（`03` §七：不造假数据）。
 *   这里按**类型**分组（`AGENT_TYPES`，值域的唯一来源），组内保持服务端给的顺序。
 */

import { SearchOutlined } from '@ant-design/icons'
import { Input, Popover, Tag } from 'antd'
import { useMemo, useState, type ReactNode } from 'react'
import { AGENT_TYPES, type AgentItem, type AgentType } from '@doubulea/shared'

import { useAgents, AGENTS_PAGE_LIMIT_MAX } from '../../api/agents.js'
import { useAvailableChatModels } from '../../api/models.js'
import { AGENT_TYPE_LABEL } from '../../pages/agents/agentModel.js'
import { MissingModelKeyModal } from './MissingModelKeyModal.js'
import {
  isConversationBlocked,
  missingModelKeyProviders,
  partitionPoolModels,
  type MissingModelKeyProvider,
} from './modelKeyGuard.js'

export interface AgentPickerProps {
  /** 触发器内容（两处触发点各给各的：会话栏给「＋ 新对话」，标题栏给智能体 chip） */
  trigger: ReactNode
  /** 选中某智能体（调用方负责 `navigate('/new/:agentId')`） */
  onPick: (agentId: string) => void
  /** 触发器按钮的额外类名（两处外观不同，样式分开） */
  triggerClassName?: string
  /** 触发器按钮的 `title` */
  triggerTitle?: string
}

/** 一条候选：名字 + 类型徽标（判断依据全在服务端投影 `AgentItem` 上） */
function AgentOption({ agent, onPick }: { agent: AgentItem; onPick: (agent: AgentItem) => void }) {
  return (
    <button type="button" className="agent-pick__item" onClick={() => onPick(agent)}>
      <span className="agent-pick__name">{agent.name}</span>
      <Tag className={agent.type === 'CHATBOT' ? 'tag--accent' : undefined}>{AGENT_TYPE_LABEL[agent.type]}</Tag>
    </button>
  )
}

export function AgentPicker({ trigger, onPick, triggerClassName, triggerTitle }: AgentPickerProps) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const agentsQuery = useAgents({ offset: 0, limit: AGENTS_PAGE_LIMIT_MAX })
  // 模型 Key 预检要它（`ModelOption` 带 `providerCredentialMode` / `providerUserHasKey`），与编辑页共用缓存键
  const availableModelsQuery = useAvailableChatModels()
  /** 非空 = 该智能体缺 Key ⇒ 弹窗并**放弃导航**（见文件头 ⚠️ 2026-10-16） */
  const [missingKeys, setMissingKeys] = useState<readonly MissingModelKeyProvider[] | null>(null)

  const agents = agentsQuery.data?.items ?? []
  const matched = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase()
    if (trimmed === '') return agents
    return agents.filter((agent) => agent.name.toLowerCase().includes(trimmed))
  }, [agents, keyword])

  const groups = useMemo(
    () =>
      AGENT_TYPES.map((type) => ({
        type,
        items: matched.filter((agent) => agent.type === type),
      })).filter((group) => group.items.length > 0),
    [matched],
  )

  /**
   * 选中一个智能体：**先预检模型 Key**，过了才 `onPick`。
   *
   * ⚠️ 2026-10-16 用户定案：**只要池里还有一个能用的模型就放行**（哪怕默认模型缺 Key）——
   * 缺 Key 的那个由进会话后的"默认模型换一个能用的"（`ChatPage`）与"选到它时弹窗"兜住。
   * 只有**一个能用的都没有**时才拦在这里（弹窗、不导航）。
   * ⚠️ 可选列表还没到时（`data` undefined）= 判不了 ⇒ 放行（fail-open），交给 `ChatPage` 兜底再判。
   */
  const pick = (agent: AgentItem): void => {
    const items = availableModelsQuery.data?.items ?? []
    const poolIds = agent.models.map((model) => model.modelId)
    setOpen(false)
    setKeyword('')
    if (isConversationBlocked(partitionPoolModels(poolIds, items))) {
      setMissingKeys(missingModelKeyProviders(poolIds, items))
      return
    }
    onPick(agent.id)
  }

  const content = (
    <div className="agent-pick" data-testid="agent-picker">
      <Input
        allowClear
        autoFocus
        prefix={<SearchOutlined />}
        placeholder="搜索智能体"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />
      <div className="agent-pick__scroll">
        {agentsQuery.isPending ? (
          <p className="agent-pick__hint">正在读取智能体…</p>
        ) : agentsQuery.isError ? (
          <p className="agent-pick__hint">智能体列表没有读出来，稍后再试。</p>
        ) : groups.length === 0 ? (
          <p className="agent-pick__hint">
            {agents.length === 0 ? '还没有可用的智能体，先去「管理 · 智能体」建一个。' : '没有匹配的智能体。'}
          </p>
        ) : (
          groups.map((group: { type: AgentType; items: AgentItem[] }) => (
            <div key={group.type} className="agent-pick__group">
              <p className="agent-pick__group-label">{AGENT_TYPE_LABEL[group.type]}</p>
              {group.items.map((agent) => (
                <AgentOption key={agent.id} agent={agent} onPick={pick} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        content={content}
        overlayClassName="agent-pick__overlay"
      >
        <button
          type="button"
          className={triggerClassName}
          title={triggerTitle}
          aria-haspopup="dialog"
          onClick={() => {
            if (!open) setKeyword('')
          }}
        >
          {trigger}
        </button>
      </Popover>
      {/* 选中缺 Key 的智能体 ⇒ 在这里弹（**不导航** ⇒ 不开始这段对话）。见文件头 ⚠️ 2026-10-16 */}
      <MissingModelKeyModal missing={missingKeys} onClose={() => setMissingKeys(null)} />
    </>
  )
}