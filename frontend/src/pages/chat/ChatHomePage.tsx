/**
 * 聊天视图（P1-15 · `子方案/聊天主页与信息架构改造.md`）
 *
 * 进站首页 `/` 就是它：会话栏（`ConvRail`）由**统一外壳** `AppShell` 常驻左列，本组件只渲染**主区**。
 * 三条路由都落在这里：
 *   · `/`（index）—— 还没选会话 ⇒ 欢迎态（引导去选智能体）；
 *   · `/new/:agentId` —— 新会话态（展示开场白，首条消息才建会话）；
 *   · `/c/:conversationId` —— 定位某个会话；`agentId` 由**会话数据自带**（`ConversationItem.agentId`
 *     快照）解析，路径里不再重复携带真值。
 *
 * ⚠️ **会话栏已上移到 `AppShell`**（P1-15 修订：单一外壳，管理页也用同一列会话栏）——
 * 本组件不再渲染 `ConvRail`，也不持有会话栏的收起态；它只占主区（`.chat-home__main`）。
 *
 * ⚠️ `/c/:id` 解析 `agentId` 的两条来源，缺一不可：
 *   ① `useMyConversations`（刷新 / 深链 / 书签都靠它）；
 *   ② `location.state.agentId`（**刚建会话**那一刻的兜底）—— 首条消息建出会话后 `ChatPage` 立刻
 *      导航到 `/c/:id`，而跨智能体列表要等这一轮结束才失效重取（`useChatStream` 收尾），
 *      中间那段窗口列表里还查不到这条 ⇒ 只靠 ① 会闪一下"会话不存在"。
 */

import { Button } from 'antd'
import { useMemo } from 'react'
import { isConversationReadOnly } from '@doubulea/shared'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

import { MY_CONVERSATIONS_PAGE_LIMIT_MAX, useMyConversations } from '../../api/conversations.js'
import { HOME_PATH, newConversationPath } from '../../app/paths.js'
import { AgentPicker } from '../../features/chat/AgentPicker.js'
import { ChatPage } from './ChatPage.js'

export function ChatHomePage() {
  const params = useParams<{ agentId?: string; conversationId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const conversationId = params.conversationId
  const routeAgentId = params.agentId

  // 只有 `/c/:id` 才需要靠列表反查 agentId；`/` 与 `/new/:agentId` 直接有（或没有）会话上下文。
  // `enabled` 由路由决定：不打 `/api/conversations` 之外的请求。
  const listQuery = useMyConversations({ offset: 0, limit: MY_CONVERSATIONS_PAGE_LIMIT_MAX })

  /** 刚建会话时 `navigate(..., { state: { agentId } })` 带过来的兜底（见文件头 ⚠️ ②） */
  const stateAgentId = (location.state as { agentId?: unknown } | null)?.agentId

  /** 当前会话的列表项（含 agent 名字/类型/**状态**快照；Agent 软删后仍能从这里拿到） */
  const conversationItem = useMemo(() => {
    if (conversationId === undefined) return undefined
    return listQuery.data?.items.find((item) => item.id === conversationId)
  }, [conversationId, listQuery.data])

  const resolvedAgentId = useMemo(() => {
    if (routeAgentId !== undefined) return routeAgentId
    if (conversationId === undefined) return undefined
    if (conversationItem !== undefined) return conversationItem.agentId
    return typeof stateAgentId === 'string' && stateAgentId !== '' ? stateAgentId : undefined
  }, [routeAgentId, conversationId, conversationItem, stateAgentId])

  /**
   * 只读保留：会话 `status !== 'ACTIVE'`（`02` §4.4：软删 Agent 时会话转只读保留）。
   * 此时 Agent 已查不到（`GET /api/agents/:id` 404），但历史应可查看、只是不能再发消息。
   */
  const readOnly = conversationItem !== undefined && isConversationReadOnly(conversationItem.status)

  const content = (() => {
    // `/`：欢迎态（还没有选中任何会话）
    if (conversationId === undefined && routeAgentId === undefined) {
      return (
        <div className="chat-home__welcome">
          <div className="empty">
            <div className="empty__frame" aria-hidden="true" />
            <p className="empty__title">开始一段对话</p>
            <p className="empty__lead">
              左侧是你的历史会话（含全部智能体）。选一个智能体即可开始新对话 —— 首条消息发出时才会创建会话。
            </p>
            <AgentPicker
              trigger="＋ 新对话"
              triggerClassName="convrail__new-btn"
              triggerTitle="新建对话（选择智能体）"
              onPick={(agentId) => navigate(newConversationPath(agentId))}
            />
          </div>
        </div>
      )
    }

    // `/c/:id`：会话数据还没到位（列表未回且没有 `state.agentId` 兜底）⇒ 先给骨架，不误报"不存在"
    if (resolvedAgentId === undefined) {
      if (listQuery.isPending) {
        return (
          <div className="chat-home__welcome">
            <p className="convrail__hint">正在打开会话…</p>
          </div>
        )
      }
      return (
        <div className="chat-home__welcome">
          <div className="empty">
            <p className="empty__title">找不到这个会话</p>
            <p className="empty__lead">
              {listQuery.isError
                ? '会话列表没有读出来，请刷新页面重试。'
                : '它可能已被删除，或链接里的 id 不对。'}
            </p>
            <Button
              type="primary"
              onClick={() => {
                navigate(HOME_PATH, { replace: true })
              }}
            >
              回到聊天主页
            </Button>
          </div>
        </div>
      )
    }

    return (
      <ChatPage
        agentId={resolvedAgentId}
        conversationId={conversationId}
        agentName={conversationItem?.agentName}
        agentType={conversationItem?.agentType}
        readOnly={readOnly}
      />
    )
  })()

  // 主区（会话栏由 `AppShell` 常驻左列，见文件头）
  return <div className="chat-home__main">{content}</div>
}