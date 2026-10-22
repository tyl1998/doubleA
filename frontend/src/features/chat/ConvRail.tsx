/**
 * 会话栏（P1-15 · `子方案/聊天主页与信息架构改造.md` §四）
 *
 * 一列分两层（2026-10-13 修订）：
 *   · 上层「平台功能」（约 35% 高）：智能体 / 知识库 / MCP / 任务 / 我的凭据 / 会话产物 六个直达入口；
 *     末尾「管理 ▸」点击**就地展开**其余入口（用量统计 / 用户管理 / 模型池）；
 *   · 下层「会话」（约 65% 高）：**跨智能体**会话历史（分组：今天 / 更早；组标题可点击**收缩**；
 *     每条 = 状态灯 + 标题 + 智能体徽标 + 相对时间；行内 hover 浮出 [重命名][删除]）；
 *   · 顶部与底部固定：品牌字标 + 「＋ 新对话」（经 `AgentPicker` 选智能体 ⇒ `/new/:agentId`）；
 *     用户菜单 / 配色 / 服务灯。
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

import { DownOutlined, MenuOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Input, Tag, Tooltip } from 'antd'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CONVERSATION_TOPIC_MAX_CHARS, type ConversationItem, type RemoveConversationResult } from '@doubulea/shared'

import { useCurrentUser } from '../../api/auth.js'
import { MY_CONVERSATIONS_PAGE_LIMIT_MAX, useMyConversations, useRenameConversation } from '../../api/conversations.js'
import { useFeedback } from '../../app/feedback.js'
import { matchNavItem, visibleNavItems, type NavItem } from '../../app/nav.js'
import { ICON_BY_CODE, NAV_FALLBACK_ICON } from '../../app/navIcons.js'
import { HOME_PATH, conversationPath, newConversationPath } from '../../app/paths.js'
import { ServiceLed } from '../../app/ServiceLed.js'
import { UserMenu } from '../../app/UserMenu.js'
import { AGENT_TYPE_LABEL } from '../../pages/agents/agentModel.js'
import { streamingIdsOf, useChatStreamStore } from '../../stores/chatStream.js'
import { useUiStore } from '../../stores/ui.js'
import { useWorkspaceStore } from '../../stores/workspace.js'
import { AgentPicker } from './AgentPicker.js'
import { DeleteConversationModal } from './DeleteConversationModal.js'
import {
  groupConversationViews,
  normalizeTopicDraft,
  type ConversationGroup,
  type ConversationListItemView,
} from './conversationList.js'
import { useConversationActiveWatch } from './useConversationActiveWatch.js'
import { useMinuteTick } from './useMinuteTick.js'

/**
 * 上层「平台功能」的直达入口（按 `NavItem.code`）；顺序即产品口径的展示顺序
 * （智能体 / 知识库 / MCP / 任务 / 我的凭据 / 会话产物），**不跟 `NAV_ITEMS` 的排列**。
 * 其余导航项归「管理 ▸」展开后的「剩余部分」（用量统计 / 用户管理 / 模型池）。
 */
const PLATFORM_NAV_CODES: readonly string[] = ['AG', 'KB', 'MC', 'TK', 'CR', 'AH']

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
   * 正在生成的会话 id 集合（判据与 `useChatStream` 的 `streaming` 同源，但**不过滤会话**）：
   * `conversations` 表里没有"正在生成"这一列，真值只在 Redis 的活跃锁上（`stores/chatStream.ts`）。
   * ⚠️ 选 `rounds`（引用稳定）再 `useMemo` 出集合 —— 直接在 selector 里返回新 `Set` 会无限重渲染。
   * P1-19 多流后可能**同时**有多条在生成（每行各自点亮）。
   */
  const rounds = useChatStreamStore((state) => state.rounds)
  const serverRun = useChatStreamStore((state) => state.serverRun)
  const streamingIds = useMemo(() => streamingIdsOf({ rounds, serverRun }), [rounds, serverRun])

  const listQuery = useMyConversations({ offset: 0, limit: MY_CONVERSATIONS_PAGE_LIMIT_MAX })
  const items = listQuery.data?.items

  /**
   * 服务端侧活跃判据（2026-10-21）：本页画不出的那些轮次（切走后 / 刷新后进入 / 别的窗口发起）
   * 只有 `/active` 知道，所以这里按列表成员轮询一次。见 `useConversationActiveWatch` 的文件头。
   */
  const listedIds = useMemo(() => (items ?? []).map((item) => item.id), [items])
  useConversationActiveWatch(listedIds)

  /**
   * 分组（内存优化 P6）：把上一轮结果交给纯函数做**逐字段复用** —— 没变化的会话行 / 分组
   * 会拿到**同一个视图对象**，于是下面的 `ConvGroup` / `ConvRow` 的 `memo` 才真的命中。
   * 60s tick 与流式帧（`streamingIds` 重算）在本会话之外就**不再引起任何重渲染**。
   */
  const groupsRef = useRef<readonly ConversationGroup[]>([])
  const groups = useMemo(() => {
    const next = groupConversationViews(items ?? [], now, streamingIds, groupsRef.current)
    groupsRef.current = next
    return next
  }, [items, now, streamingIds])

  /** 行内重命名：同时只能有一条在编辑（判据在 `normalizeTopicDraft`） */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 待确认删除的那一条 */
  const [pendingDelete, setPendingDelete] = useState<ConversationItem | null>(null)
  /** 「管理 ▸」是否就地展开（展开后露出「其余入口」：用量统计 / 用户管理 / 模型池） */
  const [manageExpanded, setManageExpanded] = useState(false)
  /** 已收缩的会话分组标题（"更早"这类长列表可点标题收起；默认全部展开） */
  const [collapsedGroups, setCollapsedGroups] = useState<readonly string[]>([])

  const themeMode = useUiStore((state) => state.themeMode)
  const toggleThemeMode = useUiStore((state) => state.toggleThemeMode)

  /** 当前命中的导航项 —— 平台功能列表据此高亮（与顶栏面包屑同一判据，见 `nav.ts`） */
  const currentNav = matchNavItem(useLocation().pathname)

  const toggleGroup = (label: string): void => {
    setCollapsedGroups((current) =>
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label],
    )
  }

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
    if (streamingIds.has(removed.id)) useChatStreamStore.getState().reset(removed.id)
  }

  if (user === undefined || user === null) return null
  const navItems = visibleNavItems(user.role)
  // 上层「平台功能」= 用户点名的六个直达入口（顺序按产品口径，不随 `NAV_ITEMS` 排）；
  // 其余（用量统计 / 用户管理 / 模型池）= 「管理 ▸」展开后的「剩余部分」。
  const platformItems = PLATFORM_NAV_CODES.map((code) => navItems.find((item) => item.code === code)).filter(
    (item): item is NavItem => item !== undefined,
  )
  const manageItems = navItems.filter((item) => !PLATFORM_NAV_CODES.includes(item.code))

  /**
   * 行级回调的**稳定引用包**（内存优化 P6）：会话行组件是 `memo` 的，而下面这些 lambda
   * 每次渲染都是新函数 —— 不包一层的话 memo 会被逐个击穿，等于没做。所有回调内部只读
   * `ref` 里的最新值（会话项本身由行组件传回），所以包一次就够、不必进依赖。
   */
  const renameRef = useRef(submitRename)
  renameRef.current = submitRename
  const rowHandlers = useMemo<RowHandlers>(
    () => ({
      navigate,
      onStartRename: (item: ConversationItem) => {
        setEditingId(item.id)
        setDraft(item.topic ?? '')
      },
      onCancelRename: () => setEditingId(null),
      onDraftChange: setDraft,
      onSubmitRename: (item: ConversationItem) => renameRef.current(item),
      onRequestDelete: (item: ConversationItem) => setPendingDelete(item),
    }),
    [navigate],
  )
  /** `id → 会话项`（早先在每一行的渲染里 `items.find(...)`：100 条会话 = 100×100 次扫描/帧） */
  const itemById = useMemo(() => {
    const map = new Map<string, ConversationItem>()
    for (const item of items ?? []) map.set(item.id, item)
    return map
  }, [items])

  return (
    <aside className="convrail" aria-label="平台功能与会话历史">
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

      {/* 上层：平台功能（约 35% 高）。直达入口 + 就地展开的「管理」。 */}
      <nav className="convrail__nav" aria-label="平台功能">
        <ul className="convrail__nav-list">
          {platformItems.map((item) => (
            <li key={item.path}>
              <Link
                to={item.path}
                className="convrail__nav-item"
                data-current={currentNav?.path === item.path}
              >
                <span className="convrail__nav-icon" aria-hidden="true">
                  {ICON_BY_CODE[item.code] ?? NAV_FALLBACK_ICON}
                </span>
                <span className="convrail__nav-label">{item.label}</span>
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="convrail__nav-item convrail__nav-toggle"
              aria-expanded={manageExpanded}
              title={manageExpanded ? '收起管理入口' : '展开管理入口'}
              onClick={() => {
                setManageExpanded((value) => !value)
              }}
            >
              <span className="convrail__nav-icon" aria-hidden="true">
                <MenuOutlined />
              </span>
              <span className="convrail__nav-label">管理</span>
              <DownOutlined className="convrail__nav-caret" data-open={manageExpanded} />
            </button>
          </li>
          {manageExpanded
            ? manageItems.map((item) => (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className="convrail__nav-item convrail__nav-item--sub"
                    data-current={currentNav?.path === item.path}
                  >
                    <span className="convrail__nav-icon" aria-hidden="true">
                      {ICON_BY_CODE[item.code] ?? NAV_FALLBACK_ICON}
                    </span>
                    <span className="convrail__nav-label">{item.label}</span>
                  </Link>
                </li>
              ))
            : null}
        </ul>
      </nav>

      {/* 下层：会话（约 65% 高）。 */}
      <section className="convrail__convos" aria-label="会话历史">
        {listQuery.isPending ? (
          <p className="convrail__hint">正在读取会话…</p>
        ) : listQuery.isError ? (
          <div className="convrail__empty">
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
          <p className="convrail__hint">还没有会话。点上方「新对话」选一个智能体开始。</p>
        ) : (
          <ul className="convrail__list">
            {groups.map((group) => (
              <ConvGroup
                key={group.label}
                group={group}
                collapsed={collapsedGroups.includes(group.label)}
                onToggle={toggleGroup}
                itemById={itemById}
                conversationId={conversationId}
                editingId={editingId}
                draft={draft}
                handlers={rowHandlers}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="convrail__foot">
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
        streaming={pendingDelete !== null && streamingIds.has(pendingDelete.id)}
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
/**
 * 会话行的回调包（内存优化 P6）。
 *
 * ⚠️ 做成**一个稳定对象**而不是逐个传 lambda：`ConvRow` 是 `memo` 的，任何一次新函数引用都会
 * 让 100 行全部重渲染 —— 而那正是"60s tick / 每个流式帧"在做的事。
 * 所有回调都只接收"被点的那一行"（`item`），不闭包任何会变的状态。
 */
interface RowHandlers {
  navigate: ReturnType<typeof useNavigate>
  onStartRename: (item: ConversationItem) => void
  onCancelRename: () => void
  onDraftChange: (value: string) => void
  onSubmitRename: (item: ConversationItem) => void
  onRequestDelete: (item: ConversationItem) => void
}

/** 一个分组（标题 + 行）。`memo`：分组视图引用不变时整组跳过（见 `groupConversationViews` 的复用口径） */
const ConvGroup = memo(function ConvGroup({
  group,
  collapsed,
  onToggle,
  itemById,
  conversationId,
  editingId,
  draft,
  handlers,
}: {
  group: ConversationGroup
  collapsed: boolean
  onToggle: (label: string) => void
  itemById: ReadonlyMap<string, ConversationItem>
  conversationId: string | undefined
  editingId: string | null
  draft: string
  handlers: RowHandlers
}) {
  return (
    <li>
      <button
        type="button"
        className="convrail__group"
        aria-expanded={!collapsed}
        title={collapsed ? `展开「${group.label}」` : `收缩「${group.label}」`}
        onClick={() => onToggle(group.label)}
      >
        <RightOutlined className="convrail__group-caret" data-open={!collapsed} />
        <span className="convrail__group-label">{group.label}</span>
        <span className="convrail__group-count num">{group.items.length}</span>
      </button>
      {collapsed ? null : (
        <ul className="convrail__group-list">
          {group.items.map((view) => {
            const item = itemById.get(view.id)
            if (item === undefined) return null
            return (
              <ConvRow
                key={item.id}
                view={view}
                item={item}
                current={item.id === conversationId}
                editing={editingId === item.id}
                draft={draft}
                handlers={handlers}
              />
            )
          })}
        </ul>
      )}
    </li>
  )
})

/** 一行会话（`memo`：视图对象 / 当前态 / 编辑态都没变时整行跳过） */
const ConvRow = memo(function ConvRow({
  view,
  item,
  current,
  editing,
  draft,
  handlers,
}: {
  view: ConversationListItemView
  item: ConversationItem
  current: boolean
  editing: boolean
  draft: string
  handlers: RowHandlers
}) {
  return (
    <li className="conv" data-current={current}>
      {editing ? (
        <div className="conv__edit">
          <Input
            size="small"
            aria-label="会话名称"
            value={draft}
            maxLength={CONVERSATION_TOPIC_MAX_CHARS}
            autoFocus
            onChange={(event) => handlers.onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                handlers.onCancelRename()
                return
              }
              if (event.key !== 'Enter') return
              if (event.nativeEvent.isComposing) return
              handlers.onSubmitRename(item)
            }}
          />
          <div className="conv__edit-ops">
            <Button
              size="small"
              type="primary"
              disabled={normalizeTopicDraft(draft, item.topic) === null}
              onClick={() => handlers.onSubmitRename(item)}
            >
              保存
            </Button>
            <Button size="small" onClick={handlers.onCancelRename}>
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
            if (!current) handlers.navigate(conversationPath(item.id))
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
              onClick={() => handlers.onStartRename(item)}
            >
              ✎
            </button>
          </Tooltip>
          <Tooltip title="删除">
            <button
              type="button"
              aria-label={`删除会话「${view.title}」`}
              onClick={() => handlers.onRequestDelete(item)}
            >
              ✕
            </button>
          </Tooltip>
        </span>
      )}
    </li>
  )
})
