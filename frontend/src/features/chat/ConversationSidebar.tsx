/**
 * 会话侧栏（P0-1-34）
 *
 * 依据：`docs/03-前端设计.md` §4.1 的版式图（左侧「+ 新会话 / 会话列表（最近活跃）」）与
 *      正文三句（"会话项 hover 浮出 [重命名][删除]；重命名**行内编辑**；删除走**分级确认**"）、
 *      §七（"**级联删除（Agent / 会话）= Modal + 红色危险按钮 + 明示影响范围**"、
 *      "列表三态"、"空态带引导按钮"）、`docs/02` §4.5 ③（排序 `lastMessageAt desc` + 新会话排最前）、
 *      `design/chat.html` 的 `.sidebar` / `.conv` 构成。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三件只在这里做一次的事
 * ─────────────────────────────────────────────────────────────────────
 * ① **列表三态**（加载 / 错误 / 空）—— 都收在这个组件里，别让页面再判一次；
 * ② **"当前会话"的判据** —— 只有 `conversationId`（路由参数）一个来源。用 store 或本地 state
 *    记"我选了哪条"会出现两份真值：浏览器后退、粘贴链接、刷新三种进入方式都会让它们分叉；
 * ③ **行内重命名的开关** —— 哪一条在编辑（`editingId`）是本组件的局部状态，
 *    "能不能提交"的判据在 `conversationList.ts#normalizeTopicDraft`（纯函数、有断言守着）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 侧栏**不做**排序，也不自己判"生成中"
 * ─────────────────────────────────────────────────────────────────────
 * 顺序由服务端给（`docs/02` §4.5 ③），分组/读数/状态灯由 `conversationList.ts` 的纯函数给。
 * 本文件里没有一处 `sort()` —— 加上它就有了第二份排序口径，而它与服务端的 offset/limit 分页
 * 会打架（症状："翻页时同一条出现两次"）。
 *
 * "生成中"的判据来自**流 store**（`streamFor`），不是 `status`：`conversations` 表里没有
 * "正在生成"这个列，真值只在 Redis 的活跃锁上（`shared/src/conversation.ts` 文件头 ⑤）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 写操作（改名 / 删除）住在侧栏里，不往页面抛
 * ─────────────────────────────────────────────────────────────────────
 * 两者都只需要 `agentId`（失效缓存用）与外部的两件收尾：改名成功提示、删除成功后的去向。
 * 请求本身走 `api/conversations.ts` 的 hooks（`03` §六："组件内不写请求，全部走 api 层 hooks"），
 * 页面不必为此多背两个 mutation 与一个弹窗状态。
 */

import { Button, Input, Tooltip } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { CONVERSATION_TOPIC_MAX_CHARS } from '@doubulea/shared'
import type { ConversationItem, RemoveConversationResult } from '@doubulea/shared'

import { useAgentConversations, useRenameConversation } from '../../api/conversations.js'
import { useFeedback } from '../../app/feedback.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { DeleteConversationModal } from './DeleteConversationModal.js'
import { groupConversationViews, newConversationAction, normalizeTopicDraft } from './conversationList.js'

export interface ConversationSidebarProps {
  agentId: string
  /** 路由里的会话 id；`undefined` = **新会话态**（`03` §4.1：展示开场白，首条消息才建会话） */
  conversationId: string | undefined
  /** 正在生成的会话 id（流 store 的 `streamFor`）；`null` = 没有流在跑 */
  streamingId: string | null
  /** 切到某个会话（页面负责导航 —— 侧栏不认识 URL 长什么样） */
  onSelect: (conversationId: string) => void
  /** 点「+ 新会话」（页面负责导航到不带 id 的地址） */
  onNew: () => void
  /**
   * 删除成功之后。页面据此决定一件事：**删掉的正是 URL 里那个会话**时要导航去新会话态
   * （否则页面会停在一个已经不存在的会话上，历史查询立刻 404）。
   */
  onDeleted: (removed: RemoveConversationResult) => void
}

/**
 * "现在"的节拍器（60s 一跳）。
 *
 * 相对时间读数（"3 分钟前"）**不会自己更新** —— 没有这个 tick，用户把页面开着一小时后
 * 看到的还是"3 分钟前"。60s 与读数的最小粒度一致（分档里最小的变化就是"刚刚 → N 分钟前"）；
 * 比它更细只会白白重渲染，比它更粗就会出现"明明过了两分钟还写着刚刚"。
 */
function useMinuteTick(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  return now
}

export function ConversationSidebar({
  agentId,
  conversationId,
  streamingId,
  onSelect,
  onNew,
  onDeleted,
}: ConversationSidebarProps) {
  const listQuery = useAgentConversations(agentId)
  const rename = useRenameConversation(agentId)
  const feedback = useFeedback()
  const now = useMinuteTick()

  /** 正在行内编辑的那一条（`null` = 没有）；同时只能有一条，别让它变成一张"待提交清单" */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 待确认删除的那一条（`null` = 弹窗关着） */
  const [pendingDelete, setPendingDelete] = useState<ConversationItem | null>(null)

  const items = listQuery.data?.items
  const groups = useMemo(
    () => groupConversationViews(items ?? [], now, streamingId),
    [items, now, streamingId],
  )

  // 切会话 / 换智能体 ⇒ 收起编辑态。留着的症状是"点开另一条，输入框还开着、内容是上一条的"
  useEffect(() => {
    setEditingId(null)
    setDraft('')
  }, [conversationId, agentId])

  /**
   * 提交行内重命名。
   *
   * 三条判据都在 `normalizeTopicDraft`（纯函数、无依赖档断言）：空串 / 超长 ⇒ 按钮本来就是灰的；
   * **没改动**（点开又原样保存）⇒ 直接收起、**不发 PATCH** —— 发一次只会把 `updatedAt`
   * 无谓推进（"看不见的改写"，与 P0-1-23 的 `PUT components` 判等是同一条纪律）。
   */
  const submitRename = (item: ConversationItem): void => {
    const parsed = normalizeTopicDraft(draft, item.topic)
    if (parsed === null) return
    setEditingId(null)
    if (parsed.unchanged) return

    rename.mutate(
      { id: item.id, topic: parsed.topic },
      {
        onSuccess: (updated) => {
          feedback.ok(`已重命名为「${updated.topic ?? parsed.topic}」`)
        },
        // 失败时**保持列表原样**、把原因说出来（可能是 404：这条刚被另一个标签页删了）
        onError: (error) => {
          feedback.fail(error, '重命名失败')
        },
      },
    )
  }

  const beginRename = (item: ConversationItem): void => {
    setEditingId(item.id)
    // 没命名过的会话（`topic === null`）预填**空串**而不是"新会话"：那个词是**回落文案**、
    // 不是它的名字 —— 预填它会让用户以为会话本来就叫这个，保存后标题就真的变成"新会话"了
    setDraft(item.topic ?? '')
  }

  return (
    <aside className="sidebar" aria-label="会话列表">
      <div className="sidebar__head">
        <Button
          type="primary"
          block
          onClick={() => {
            // 已经在新会话态 ⇒ 什么都不做（`newConversationAction` 的注释：别往浏览器历史里
            // 塞一个什么都没变的条目，那会让"后退"看起来像坏了）
            if (newConversationAction(conversationId) === 'already-new') return
            onNew()
          }}
        >
          + 新会话
        </Button>
      </div>

      {listQuery.isPending ? (
        <div className="sidebar__body">
          <TableSkeleton rows={3} />
        </div>
      ) : listQuery.isError ? (
        <div className="sidebar__body">
          <ErrorState
            title="会话列表没有读出来"
            error={listQuery.error}
            retrying={listQuery.isFetching}
            onRetry={() => {
              void listQuery.refetch()
            }}
          />
        </div>
      ) : groups.length === 0 ? (
        <div className="sidebar__body">
          {/* 引导动作就是上方那条「+ 新会话」（它已经在视口里），这里给的是**下一步该做什么**
              —— 再摆一个同义按钮只会多一个要维护的入口（`03` §七 要的是"空态别只说没有数据"） */}
          <EmptyState
            title="还没有会话"
            lead="在右侧输入框发出第一条消息，会话会在那时创建并出现在这里。"
          />
        </div>
      ) : (
        <ul className="sidebar__list">
          {groups.map((group) => (
            <li key={group.label}>
              <p className="sidebar__group">{group.label}</p>
              <ul className="sidebar__group-list">
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
                              // `isComposing`：中文输入法用 Enter 选候选词 ⇒ 必须让开。
                              // 与输入区 `isSubmitKey` 是同一个坑（`composerState.ts`）
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
                            if (!current) onSelect(item.id)
                          }}
                        >
                          <span className="conv__title">{view.title}</span>
                          <span className="conv__meta">
                            {/* "色 + 文案"两重表达（`composerState` 同款）：只有一个色点的话，
                                色觉障碍用户与暗色主题下都读不出状态 */}
                            <span className={`led led--${view.led}`} aria-hidden="true" />
                            <span>{view.state}</span>
                            <span aria-hidden="true">·</span>
                            <span className="num">{view.time}</span>
                          </span>
                        </button>
                      )}

                      {editing ? null : (
                        /* hover / 键盘聚焦时浮出（`design/chat.html` 的 `.conv__ops`）。
                           ⚠️ 它们**不在** `.conv__open` 里面：按钮里嵌按钮是非法 HTML，
                           而且点击会被外层吞掉（症状："点了删除却切到了那个会话"）。
                           ⚠️ 删除**刻意不用 Popconfirm**：会话删除是**级联删除**，`03` §七 给它定的是
                           "Modal + 红色危险按钮 + 明示影响范围"，而一个 Popconfirm 装不下
                           "该会话的全部消息会被一并删除"这句话。*/
                        <span className="conv__ops">
                          <Tooltip title="重命名">
                            <button
                              type="button"
                              aria-label={`重命名会话「${view.title}」`}
                              onClick={() => beginRename(item)}
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

      <DeleteConversationModal
        agentId={agentId}
        conversation={pendingDelete}
        streaming={pendingDelete !== null && pendingDelete.id === streamingId}
        onClose={() => setPendingDelete(null)}
        onDeleted={(removed) => {
          setPendingDelete(null)
          onDeleted(removed)
        }}
      />
    </aside>
  )
}
