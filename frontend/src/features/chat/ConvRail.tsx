/**
 * 会话栏（P1-15 · `子方案/聊天主页与信息架构改造.md` §四）
 *
 * 一列承载三件事：
 *   · 顶部：品牌字标 + 「＋ 新对话」（经 `AgentPicker` 选智能体 ⇒ `/new/:agentId`）；
 *   · 中段：**跨智能体**会话历史（分组：今天 / 更早；每条 = 状态灯 + 标题 + 智能体徽标 + 相对时间；
 *     行内 hover 浮出 [重命名][删除]）；
 *   · 底部：`管理 ▸` 折叠 popover（**管理跟会话走**，不占常驻列）+ 用户菜单 / 配色 / 服务灯。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条"不新造口径"（与 `ConversationSidebar` 同源，见 `conversationList.ts`）
 * ─────────────────────────────────────────────────────────────────────
 *   · 排序**只来自服务端**（`02` §4.5 ③；本文件里没有一处 `sort()`，K10 源码级守门）；
 *   · 分组 / 读数 / 状态灯复用 `groupConversationViews` 的纯函数（只把输入从"单智能体"换成"跨智能体"）；
 *   · "生成中"仍来自流 store 的 `streamFor`，不新增会话列。
 *
 * ⚠️ **本组件直接 `useNavigate`**（与 `ConversationSidebar` 的"只向页面要回调"不同）：它是**聊天主页
 * 特有的导航轨**（不是可复用的行列表），两处触发点（本栏的「＋ 新对话」、标题栏的智能体 chip）
 * 都要导航到同两条路径 —— 与其把这几次导航层层透传到 `ChatPage`，不如让导航住在"它本就属于谁"。
 */

import { DownOutlined, MenuOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Input, Popover, Tag, Tooltip } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CONVERSATION_TOPIC_MAX_CHARS, type ConversationItem, type RemoveConversationResult } from '@doubulea/shared'

import { useCurrentUser } from '../../api/auth.js'
import { MY_CONVERSATIONS_PAGE_LIMIT_MAX, useMyConversations, useRenameConversation } from '../../api/conversations.js'
import { useFeedback } from '../../app/feedback.js'
import { visibleNavItems } from '../../app/nav.js'
import { ICON_BY_CODE, NAV_FALLBACK_ICON } from '../../app/navIcons.js'
import { HOME_PATH, conversationPath, newConversationPath } from '../../app/paths.js'
import { ServiceLed } from '../../app/ServiceLed.js'
import { UserMenu } from '../../app/UserMenu.js'
import { AGENT_TYPE_LABEL } from '../../pages/agents/agentModel.js'
import { useChatStreamStore } from '../../stores/chatStream.js'
import { useUiStore } from '../../stores/ui.js'
import { useWorkspaceStore } from '../../stores/workspace.js'
import { AgentPicker } from './AgentPicker.js'
import { DeleteConversationModal } from './DeleteConversationModal.js'
import { groupConversationViews, normalizeTopicDraft } from './conversationList.js'
import { useMinuteTick } from './useMinuteTick.js'

export interface ConvRailProps {
  /** 路由里的当前会话 id；`undefined` = 新会话态 / 聊天主页空态 */
  conversationId: string | undefined
}

export function ConvRail({ conversationId }: ConvRailProps) {
  const navigate = useNavigate()
  const feedback = useFeedback()
  const now = useMinuteTick()
  const { data: user } = useCurrentUser()

  /**
   * 正在生成的会话 id（判据与 `useChatStream` 的 `streamingId` 同源，但**不过滤会话**）：
   * `conversations` 表里没有"正在生成"这一列，真值只在 Redis 的活跃锁上（`stores/chatStream.ts`）。
   */
  const streamingId = useChatStreamStore((state) =>
    state.streamFor !== null && state.round !== null && state.round.status === 'streaming' ? state.streamFor : null,
  )

  const listQuery = useMyConversations({ offset: 0, limit: MY_CONVERSATIONS_PAGE_LIMIT_MAX })
  const items = listQuery.data?.items
  const groups = useMemo(() => groupConversationViews(items ?? [], now, streamingId), [items, now, streamingId])

  /** 行内重命名：同时只能有一条在编辑（判据在 `normalizeTopicDraft`） */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 待确认删除的那一条 */
  const [pendingDelete, setPendingDelete] = useState<ConversationItem | null>(null)
  /** 「管理」popover 开合 */
  const [manageOpen, setManageOpen] = useState(false)

  const themeMode = useUiStore((state) => state.themeMode)
  const toggleThemeMode = useUiStore((state) => state.toggleThemeMode)

  // 切会话 ⇒ 收起编辑态（留着的症状是"点开另一条，输入框还开着、内容是上一条的"）
  useEffect(() => {
    setEditingId(null)
    setDraft('')
  }, [conversationId])

  /** 改名：失效缓存走 `agentConversationsQueryKey(item.agentId)`，故这里要拿到这一条属于谁 */
  const renameScope = pendingRenameAgentId(items, editingId)
  const rename = useRenameConversation(renameScope)

  const submitRename = (item: ConversationItem): void => {
    const parsed = normalizeTopicDraft(draft, item.topic)
    if (parsed === null) return
    setEditingId(null)
    if (parsed.unchanged) return
    rename.mutate(
      { id: item.id, topic: parsed.topic },
      {
        onSuccess: (updated) => feedback.ok(`已重命名为「${updated.topic ?? parsed.topic}」`),
        onError: (error) => feedback.fail(error, '重命名失败'),
      },
    )
  }

  /** 删除收尾：删的是当前会话 ⇒ 导航回家；删的是正在生成的那条 ⇒ 收掉流式版本 */
  const handleDeleted = (removed: RemoveConversationResult): void => {
    useWorkspaceStore.getState().dropConversation(removed.id)
    if (removed.id === conversationId) navigate(HOME_PATH, { replace: true })
    if (removed.id === streamingId) useChatStreamStore.getState().reset()
  }

  if (user === undefined || user === null) return null
  const navItems = visibleNavItems(user.role)
  const normalItems = navItems.filter((item) => item.adminOnly !== true)
  const adminItems = navItems.filter((item) => item.adminOnly === true)

  return (
    <aside className="convrail" aria-label="会话历史">
      <div className="convrail__head">
        <span className="convrail__mark" aria-hidden="true">
          A
        </span>
        <span className="convrail__brand">doubuleA</span>
      </div>

      <div className="convrail__new">
        <AgentPicker
          trigger={
            <>
              <PlusOutlined />
              <span className="convrail__new-label">新对话</span>
            </>
          }
          triggerClassName="convrail__new-btn"
          triggerTitle="新建对话（选择智能体）"
          onPick={(agentId) => navigate(newConversationPath(agentId))}
        />
      </div>

      {listQuery.isPending ? (
        <div className="convrail__body">
          <p className="convrail__hint">正在读取会话…</p>
        </div>
      ) : listQuery.isError ? (
        <div className="convrail__body">
          <p className="convrail__hint">会话列表没有读出来。</p>
          <Button
            size="small"
            loading={listQuery.isFetching}
            onClick={() => {
              void listQuery.refetch()
            }}
          >
            重试
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <div className="convrail__body">
          <p className="convrail__hint">还没有会话。点上方「新对话」选一个智能体开始。</p>
        </div>
      ) : (
        <ul className="convrail__list">
          {groups.map((group) => (
            <li key={group.label}>
              <p className="convrail__group">{group.label}</p>
              <ul className="convrail__group-list">
                {group.items.map((view) => {
                  const item = items?.find((candidate) => candidate.id === view.id)
                  if (item === undefined) return null
                  const current = item.id === conversationId
                  const editing = editingId === item.id
                  return (
                    <li className="conv" data-current={current} key={item.id}>
                      {editing ? (
                        <div className="conv__edit">
                          <Input
                            size="small"
                            aria-label="会话名称"
                            value={draft}
                            maxLength={CONVERSATION_TOPIC_MAX_CHARS}
                            autoFocus
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                setEditingId(null)
                                return
                              }
                              if (event.key !== 'Enter') return
                              if (event.nativeEvent.isComposing) return
                              submitRename(item)
                            }}
                          />
                          <div className="conv__edit-ops">
                            <Button
                              size="small"
                              type="primary"
                              disabled={normalizeTopicDraft(draft, item.topic) === null}
                              onClick={() => submitRename(item)}
                            >
                              保存
                            </Button>
                            <Button size="small" onClick={() => setEditingId(null)}>
                              取消
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="conv__open"
                          type="button"
                          aria-current={current ? 'true' : undefined}
                          onClick={() => {
                            if (!current) navigate(conversationPath(item.id))
                          }}
                        >
                          <span className="conv__title">{view.title}</span>
                          <span className="conv__meta">
                            <span className={`led led--${view.led}`} aria-hidden="true" />
                            <span>{view.state}</span>
                            {/* 智能体徽标（跨智能体列表的关键：一屏分清"这条是谁的"） */}
                            <Tag className="conv__agent" title={view.agentName}>
                              {AGENT_TYPE_LABEL[view.agentType]}
                            </Tag>
                            <span aria-hidden="true">·</span>
                            <span className="num">{view.time}</span>
                          </span>
                        </button>
                      )}

                      {editing ? null : (
                        <span className="conv__ops">
                          <Tooltip title="重命名">
                            <button
                              type="button"
                              aria-label={`重命名会话「${view.title}」`}
                              onClick={() => {
                                setEditingId(item.id)
                                setDraft(item.topic ?? '')
                              }}
                            >
                              ✎
                            </button>
                          </Tooltip>
                          <Tooltip title="删除">
                            <button
                              type="button"
                              aria-label={`删除会话「${view.title}」`}
                              onClick={() => setPendingDelete(item)}
                            >
                              ✕
                            </button>
                          </Tooltip>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="convrail__foot">
        <Popover
          open={manageOpen}
          onOpenChange={setManageOpen}
          trigger="click"
          placement="topLeft"
          content={
            <nav className="rail-menu" aria-label="管理">
              <div className="rail-menu__grid">
                {[...normalItems, ...adminItems].map((item) => (
                  <Link key={item.path} to={item.path} className="rail-menu__item" onClick={() => setManageOpen(false)}>
                    <span className="rail-menu__icon" aria-hidden="true">
                      {ICON_BY_CODE[item.code] ?? NAV_FALLBACK_ICON}
                    </span>
                    {item.label}
                  </Link>
                ))}
              </div>
              {adminItems.length > 0 && normalItems.length > 0 ? (
                <p className="rail-menu__note">下方为管理员入口</p>
              ) : null}
            </nav>
          }
        >
          <button
            type="button"
            className="convrail__manage"
            aria-haspopup="menu"
            title="管理（智能体 / 知识库 / MCP / 任务 / 产物 / 凭据 / 用量）"
          >
            <MenuOutlined />
            <span className="convrail__manage-label">管理</span>
            <DownOutlined className="convrail__manage-caret" />
          </button>
        </Popover>

        <div className="convrail__user">
          <Button size="small" type="text" onClick={toggleThemeMode} title="切换配色（浅色为交付主态）">
            {themeMode === 'dark' ? '暗色' : '浅色'}
          </Button>
          <ServiceLed />
          <UserMenu user={user} />
        </div>
      </div>

      <DeleteConversationModal
        agentId={pendingDelete?.agentId ?? renameScope}
        conversation={pendingDelete}
        streaming={pendingDelete !== null && pendingDelete.id === streamingId}
        onClose={() => setPendingDelete(null)}
        onDeleted={(removed) => {
          setPendingDelete(null)
          handleDeleted(removed)
        }}
      />
    </aside>
  )
}

/**
 * `useRenameConversation(agentId)` 的"失效范围"参数：改名要在**这一条所属智能体**的缓存树上失效。
 *
 * 编辑态下取正在编辑那一条的 `agentId`；没有上下文时给 `''`（hook 建了但不会发请求，
 * `mutationFn` 只在 `mutate` 时用 id，与 agentId 无关）—— 与 `useAgentConversations('')` 同款兜底。
 */
function pendingRenameAgentId(items: readonly ConversationItem[] | undefined, editingId: string | null): string {
  if (editingId === null) return ''
  return items?.find((item) => item.id === editingId)?.agentId ?? ''
}