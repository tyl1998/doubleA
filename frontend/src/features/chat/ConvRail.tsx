/**
 * 会话栏（P1-15 · `子方案/聊天主页与信息架构改造.md` §四）
 *
 * 一列分两层（2026-10-26 修订）：
 *   · 上层「平台功能」（**按内容固定高度、不出现滑块**）：智能体 / 知识库 / MCP / 任务 / 会话产物
 *     五个直达入口；末尾「管理 ▸」**向右展开**一枚浮层（用量统计 / 我的凭据 / 用户管理 / 模型池 /
 *     出网策略 / 沙箱实例）；
 *   · 下层「会话」：**跨智能体**会话历史（分组：今天 / 更早；组标题可点击**收缩**）；
 *     顶部一行小标题「会话历史」右侧有一枚**卡片样式切换**按钮（完整 / 省略，见 `stores/ui.ts`）：
 *     完整 = 状态灯 + 标题 + 状态文案 + 智能体徽标 + 相对时间；省略 = 只留标题 + 状态色点、行更矮，
 *     标题比分组标题更轻，避免"脚重头轻"。
 *   · 顶部与底部固定：品牌字标 + 「＋ 新对话」（经 `AgentPicker` 选智能体 ⇒ `/new/:agentId`）、
 *     服务灯 + 当前用户（配色 / 语言切换已收进头像菜单，见 `app/UserMenu.tsx`）。
 *   · ⚠️ 会话历史的滑块**只在鼠标指向该区域时才显形**（`.convrail__convos` hover，见 app.css）。
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

import { CompressOutlined, ExpandAltOutlined, MenuOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Input, Popover, Tag, Tooltip } from 'antd'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CONVERSATION_TOPIC_MAX_CHARS, type ConversationItem, type RemoveConversationResult } from '@doubulea/shared'

import { useCurrentUser } from '../../api/auth.js'
import { MY_CONVERSATIONS_PAGE_LIMIT_MAX, useMyConversations, useRenameConversation } from '../../api/conversations.js'
import { useFeedback } from '../../app/feedback.js'
import { useT, type Translate } from '../../app/i18n.js'
import { matchNavItem, visibleNavItems, type NavItem } from '../../app/nav.js'
import { ICON_BY_CODE, NAV_FALLBACK_ICON } from '../../app/navIcons.js'
import { HOME_PATH, conversationPath, newConversationPath } from '../../app/paths.js'
import { ServiceLed } from '../../app/ServiceLed.js'
import { UserMenu } from '../../app/UserMenu.js'
import { AGENT_TYPE_LABEL } from '../../pages/agents/agentModel.js'
import { streamingIdsOf, useChatStreamStore } from '../../stores/chatStream.js'
import { useLocaleStore } from '../../stores/locale.js'
import { useUiStore, type RailCardMode } from '../../stores/ui.js'
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
 * （智能体 / 知识库 / MCP / 任务 / 会话产物），**不跟 `NAV_ITEMS` 的排列**。
 * 「我的凭据」按用户 2026-10-26 口径**收进「管理 ▸」**（它属个人设置族，不再是平台一级入口）。
 */
const PLATFORM_NAV_CODES: readonly string[] = ['AG', 'KB', 'MC', 'TK', 'AH']

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
  /** P1-23：当前语言 —— 分组/行读数（`groupConversationViews`）与 `useMemo` 依赖都要它 */
  const locale = useLocaleStore((state) => state.locale)

  const groupsRef = useRef<readonly ConversationGroup[]>([])
  const groups = useMemo(() => {
    const next = groupConversationViews(items ?? [], now, streamingIds, locale, groupsRef.current)
    groupsRef.current = next
    return next
    // ⚠️ `locale` 必须在依赖里：语言一变，分组标题与行文案（"生成中"/时间读数）都要重算。
    //    漏了它 → 切语言后会话栏文字不跟着变（不报错，静默失效）。
  }, [items, now, streamingIds, locale])

  /** 行内重命名：同时只能有一条在编辑（判据在 `normalizeTopicDraft`） */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 待确认删除的那一条 */
  const [pendingDelete, setPendingDelete] = useState<ConversationItem | null>(null)
  /**
   * 「管理 ▸」浮层是否展开（2026-10-26 用户口径：**向右**弹出，不再就地手风琴）。
   *
   * ⚠️ 为什么是**受控**的：`Popover` 默认只在"点击浮层之外"时才收起，而点击浮层里的 `Link`
   * 是在浮层**内部** ⇒ 不受控时点完一条导航后浮层**会留在原地**（症状：已经换了页面，右侧还挂着
   * 那枚旧浮层）。故这里自己持有开关，并在每条 `Link` 的 `onClick` 里收起。
   */
  const [manageOpen, setManageOpen] = useState(false)
  /** 已收缩的会话分组标题（"更早"这类长列表可点标题收起；默认全部展开） */
  const [collapsedGroups, setCollapsedGroups] = useState<readonly string[]>([])

  /** 会话栏卡片样式（完整 / 省略）—— 纯客户端偏好，存 localStorage（`stores/ui.ts`） */
  const railCardMode = useUiStore((state) => state.railCardMode)
  const toggleRailCardMode = useUiStore((state) => state.toggleRailCardMode)
  const { t } = useT()

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
        onSuccess: (updated) => feedback.ok(t('rail.renameOk', { topic: updated.topic ?? parsed.topic })),
        onError: (error) => feedback.fail(error, t('rail.renameFailed')),
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
  // 上层「平台功能」= 五个直达入口（顺序按产品口径，不随 `NAV_ITEMS` 排）；
  // 其余（用量统计 / 我的凭据 / 用户管理 / 模型池 / 出网策略 / 沙箱实例）= 「管理 ▸」向右展开的浮层。
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

  /**
   * 「管理 ▸」的浮层：用户 2026-10-26 口径是**点击 / hover 后向右展开**（不再就地手风琴）。
   *
   * ⚠️ 用 `Popover` 而不是 `Dropdown`：AntD 5 的 `Dropdown` 的 `placement` **只支持上/下四向**
   * （`bottomLeft` … `topRight`），给 `rightTop` 会直接报类型错（`tsc` 拦下）；而这里要的正是
   * "从本栏右侧弹出"。`Popover` 的 `placement` 支持 `rightTop`，且内容仍是我们自己的一组 `Link`。
   * 每条 `Link` 点击即导航（`popover` 在点击后由 AntD 自行收起）。
   */
  const manageMenu = (
    <nav className="convrail__manage-menu" aria-label={t('rail.manage')}>
      {manageItems.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className="convrail__nav-item"
          data-current={currentNav?.path === item.path}
          onClick={() => setManageOpen(false)}
        >
          <span className="convrail__nav-icon" aria-hidden="true">
            {ICON_BY_CODE[item.code] ?? NAV_FALLBACK_ICON}
          </span>
          <span className="convrail__nav-label">{t(item.labelKey)}</span>
        </Link>
      ))}
    </nav>
  )

  return (
    <aside className="convrail" aria-label={t('rail.ariaLabel')}>
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
              <span className="convrail__new-label">{t('rail.newConversation')}</span>
            </>
          }
          triggerClassName="convrail__new-btn"
          triggerTitle={t('rail.newConversationTitle')}
          onPick={(agentId) => navigate(newConversationPath(agentId))}
        />
      </div>

      {/* 上层：平台功能。直达入口 + 「管理 ▸」向右展开的浮层（**固定高度、不出滑块**）。 */}
      <nav className="convrail__nav" aria-label={t('rail.platformNavAria')}>
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
                <span className="convrail__nav-label">{t(item.labelKey)}</span>
              </Link>
            </li>
          ))}
          {/* 「管理」：点击 / hover（鼠标移上去即展开）⇒ **向右**弹出浮层，不挤占本栏高度。
              当前命中的管理页（用量 / 用户 / 模型池 / 出网 / 沙箱实例 / 我的凭据）也高亮这一枚按钮，
              否则从平台功能点进管理页后本栏会"看起来哪都没选中"。 */}
          <li>
            <Popover
              content={manageMenu}
              open={manageOpen}
              onOpenChange={setManageOpen}
              trigger={['click', 'hover']}
              placement="rightTop"
              overlayClassName="convrail__manage-overlay"
              arrow={false}
            >
              <button
                type="button"
                className="convrail__nav-item"
                data-current={currentNav !== undefined && !PLATFORM_NAV_CODES.includes(currentNav.code)}
                title={t('rail.manageExpand')}
                aria-haspopup="menu"
              >
                <span className="convrail__nav-icon" aria-hidden="true">
                  <MenuOutlined />
                </span>
                <span className="convrail__nav-label">{t('rail.manage')}</span>
                <RightOutlined className="convrail__nav-caret" />
              </button>
            </Popover>
          </li>
        </ul>
      </nav>

      {/* 下层：会话（自身可滚；滑块只在 hover 时显形，见 app.css）。 */}
      <section className="convrail__convos" aria-label={t('rail.conversationsAria')}>
        <div className="convrail__convos-head">
          <span className="convrail__convos-title">{t('rail.conversationsTitle')}</span>
          {/* 卡片样式切换（2026-10-26）：完整 ⇄ 省略。纯客户端偏好，刷新后保持。 */}
          <Tooltip
            title={railCardMode === 'compact' ? t('rail.cardFull') : t('rail.cardCompact')}
          >
            <button
              type="button"
              className="convrail__card-toggle"
              data-mode={railCardMode}
              aria-label={railCardMode === 'compact' ? t('rail.cardFull') : t('rail.cardCompact')}
              onClick={toggleRailCardMode}
            >
              {railCardMode === 'compact' ? <ExpandAltOutlined /> : <CompressOutlined />}
            </button>
          </Tooltip>
        </div>
        {/* 可滚体（**只有这一层滚动**，滚滑块默认隐藏、hover 才显形；见 app.css） */}
        <div className="convrail__convos-body">
          {listQuery.isPending ? (
            <p className="convrail__hint">{t('rail.conversationsLoading')}</p>
          ) : listQuery.isError ? (
            <div className="convrail__empty">
              <p className="convrail__hint">{t('rail.conversationsError')}</p>
              <Button
                size="small"
                loading={listQuery.isFetching}
                onClick={() => {
                  void listQuery.refetch()
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <p className="convrail__hint">{t('rail.conversationsEmpty')}</p>
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
                  cardMode={railCardMode}
                  handlers={rowHandlers}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <div className="convrail__foot">
        <ServiceLed />
        {/* 账号信息：只展示当前用户；配色 / 语言切换已收进头像菜单（`app/UserMenu.tsx`）。 */}
        <UserMenu user={user} />
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
  cardMode,
  handlers,
  t,
}: {
  group: ConversationGroup
  collapsed: boolean
  onToggle: (label: string) => void
  itemById: ReadonlyMap<string, ConversationItem>
  conversationId: string | undefined
  editingId: string | null
  draft: string
  cardMode: RailCardMode
  handlers: RowHandlers
  // ⚠️ `t` 是本组件**唯一**会因为"语言变化"而变的外部依赖 —— 它变则整组重渲染，正是期望行为。
  // 分组标题（`group.label`）来自服务端/纯函数的分类读数（今天 / 更早），本批不动（属后续批次）。
  t: Translate
}) {
  return (
    <li>
      <button
        type="button"
        className="convrail__group"
        aria-expanded={!collapsed}
        title={collapsed ? t('rail.groupExpand', { label: group.label }) : t('rail.groupCollapse', { label: group.label })}
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
                cardMode={cardMode}
                handlers={handlers}
                t={t}
              />
            )
          })}
        </ul>
      )}
    </li>
  )
})

/** 一行会话（`memo`：视图对象 / 当前态 / 编辑态 / 卡片样式都没变时整行跳过） */
const ConvRow = memo(function ConvRow({
  view,
  item,
  current,
  editing,
  draft,
  cardMode,
  handlers,
  t,
}: {
  view: ConversationListItemView
  item: ConversationItem
  current: boolean
  editing: boolean
  draft: string
  cardMode: RailCardMode
  handlers: RowHandlers
  t: Translate
}) {
  const compact = cardMode === 'compact'
  return (
    <li className="conv" data-current={current} data-mode={cardMode}>
      {editing ? (
        <div className="conv__edit">
          <Input
            size="small"
            aria-label={t('rail.conversationNameAria')}
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
              {t('common.save')}
            </Button>
            <Button size="small" onClick={handlers.onCancelRename}>
              {t('common.cancel')}
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
          {/* 省略模式：**只留状态色点** —— 状态文案 / 智能体徽标 / 时间全部不画（不占位）。
              状态灯本身路上仍是"色"这一格（`led--run|warn|idle`），满足"状态只展示颜色即可"。 */}
          {compact ? (
            <span className={`led led--${view.led}`} role="img" aria-label={view.state} title={view.state} />
          ) : (
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
          )}
        </button>
      )}

      {editing ? null : (
        <span className="conv__ops">
          <Tooltip title={t('rail.rename')}>
            <button
              type="button"
              aria-label={t('rail.renameAria', { title: view.title })}
              onClick={() => handlers.onStartRename(item)}
            >
              ✎
            </button>
          </Tooltip>
          <Tooltip title={t('rail.delete')}>
            <button
              type="button"
              aria-label={t('rail.deleteAria', { title: view.title })}
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
