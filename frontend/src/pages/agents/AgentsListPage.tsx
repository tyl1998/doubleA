/**
 * 智能体列表（首页 `/`，P0-1-31）
 *
 * 依据：`docs/03-前端设计.md` §二（`/` = 智能体列表，**登录即可**，它是首页）、
 *      §4.2 / §七（列表三态、删除分级确认、表格规范：操作列固定右侧、危险操作红色、删除放最后）、
 *      `design/agents.html`（四态可切 + 级联删除弹窗）；`shared/src/agent.ts`（唯一一套投影）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 这个列表**不是"我的智能体"**，是"所有人的智能体"
 * ─────────────────────────────────────────────────────────────────────
 * `GET /api/agents` 对全员开放，每项带一个 `canEdit`（**唯一判据 = `shared` 的 `canEditAgent`**：
 * 创建者或 ADMIN）。所以行级权限不是在页面上判角色，而是**读服务端给的 `canEdit`**
 * —— 前端再判一次角色，就会出现"管理员在有的页面能编辑、在有的页面不能"这类两处口径不一致。
 * 没有 `canEdit` 的行只保留「对话」入口（`design/agents.html` 里写的"无编辑权限"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 取数与分页：一次取 100 条 + 客户端分页/搜索/筛选
 * ─────────────────────────────────────────────────────────────────────
 * `listAgentsQuerySchema` 的 `limit` 上限是 100，本页就取满一页，然后由 AntD Table 做 20/页 的
 * 客户端分页与筛选。为什么不做服务端分页：`GET /api/agents` **刻意没有 `type` 过滤、
 * 也没有关键字搜索**（`shared/src/agent.ts` 的注释："加一个没人要的参数，等于让'列表为什么
 * 少了几条'变成一件要靠猜的事"）—— 服务端分页 + 客户端筛选的组合会让"筛选只作用于当前页"，
 * 那是**看着像坏了**的行为。
 * 代价写清楚：超过 100 个智能体时第 100 条之后看不到，页脚会如实提示（不是静默截断）。
 */

import { Button, Input, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import { AGENT_TYPES, type AgentItem, type AgentType } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { AGENTS_PAGE_LIMIT_MAX, useAgents, useCopyAgent } from '../../api/agents.js'
import { useCurrentUser } from '../../api/auth.js'
import { AGENT_TYPE_LABEL, formatUpdatedAt, mcpRefsOf } from './agentModel.js'
import { DeleteAgentModal } from './DeleteAgentModal.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { VisibilityBadge } from '../../components/VisibilityBadge.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { AGENTS_NEW_PATH, chatPath, agentEditPath } from '../../app/paths.js'

/** 类型筛选：`ALL` 是"全部"，其余取 `AGENT_TYPES` 的字面量 */
type TypeFilter = 'ALL' | AgentType

/** 所属筛选（P1-13）：`MINE` = 只看我建的（`createdBy === 我`），`ALL` = 全部对我可见的 */
type OwnerFilter = 'ALL' | 'MINE'

export function AgentsListPage() {
  const navigate = useNavigate()
  const feedback = useFeedback()
  const { t } = useT()
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL')
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('ALL')
  const [pendingDelete, setPendingDelete] = useState<AgentItem | null>(null)
  const [transferFor, setTransferFor] = useState<AgentItem | null>(null)
  const copy = useCopyAgent()
  const { data: me } = useCurrentUser()

  const { data, isPending, isError, error, isFetching, refetch } = useAgents({
    offset: 0,
    limit: AGENTS_PAGE_LIMIT_MAX,
  })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const editableCount = items.filter((item) => item.canEdit).length

  const normalizedKeyword = keyword.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (ownerFilter === 'MINE' && item.createdBy !== me?.id) return false
    if (typeFilter !== 'ALL' && item.type !== typeFilter) return false
    if (normalizedKeyword === '') return true
    const haystack = `${item.name}\n${item.description ?? ''}`.toLowerCase()
    return haystack.includes(normalizedKeyword)
  })

  const columns: TableColumnsType<AgentItem> = [
    {
      title: t('agents.colName'),
      dataIndex: 'name',
      render: (_, agent) => (
        <div className="agent-cell">
          <span className="agent-cell__name">{agent.name}</span>
          <span className="agent-cell__sub">{agent.description ?? t('agents.noDescription')}</span>
        </div>
      ),
    },
    {
      title: t('agents.colType'),
      dataIndex: 'type',
      width: 120,
      render: (_, agent) => (
        <Tag className={agent.type === 'CHATBOT' ? 'tag--accent' : undefined}>{AGENT_TYPE_LABEL[agent.type]}</Tag>
      ),
    },
    {
      title: t('agents.colModel'),
      dataIndex: 'modelName',
      width: 200,
      render: (_, agent) =>
        agent.modelId === null ? (
          // 未绑定模型（多因所属模型商/模型被删除而自动解绑）：如实标注、指向"去编辑页重新绑定"
          <div className="agent-cell">
            <span className="num">
              <Tag className="tag--danger">{t('agents.modelUnbound')}</Tag>
            </span>
            <span className="agent-cell__sub">{t('agents.modelUnboundHint')}</span>
          </div>
        ) : (
          <div className="agent-cell">
            <span className="num">
              {agent.modelName}
              {!agent.modelAvailable && (
                <>
                  {' '}
                  <Tag className="tag--danger">{t('agents.modelDisabled')}</Tag>
                </>
              )}
            </span>
            <span className="agent-cell__sub">
              {agent.modelAvailable ? agent.modelLabel : t('agents.modelDisabledHint')}
            </span>
          </div>
        ),
    },
    {
      title: t('agents.colComponents'),
      dataIndex: 'components',
      width: 180,
      render: (_, agent) => {
        const knowledge = agent.components.filter((c) => c.componentType === 'KNOWLEDGE').length
        const mcp = mcpRefsOf(agent.components).length
        if (knowledge === 0 && mcp === 0) return <Tag>{t('agents.noBinding')}</Tag>
        return (
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            {knowledge > 0 && <Tag>{t('agents.knowledgeCount', { count: knowledge })}</Tag>}
            {mcp > 0 && <Tag className="tag--warn">{t('agents.mcpCount', { count: mcp })}</Tag>}
          </span>
        )
      },
    },
    {
      // P1-13：所属人（= `createdBy`/`creatorName`）。列表对全员可见，这是"这条是谁的"的读数
      //（判据都是服务端下发的字段，前端不自己算）。
      title: t('agents.colOwner'),
      dataIndex: 'creatorName',
      width: 140,
      render: (_, agent) =>
        // P1-18（2026-10-16 修订）：把这一列做成转移入口 —— 只有创建者/管理员（`canEdit`）能点，
        // 点了弹转移弹窗；其余人只显示名字。
        // ⚠️ 可见性徽标与受众人数**移到独立的「可见性」列**（2026-10-16 复议）：原先三者挤在
        // 一个 160px 列里，指定用户分享后 `名字 + 徽标 + 「N 人 / M 组」` 溢出换行、看着错乱。
        agent.canEdit ? (
          <Tooltip title={t('agents.ownerTransferTitle')}>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTransferFor(agent)}>
              {agent.creatorName}
            </Button>
          </Tooltip>
        ) : (
          <span>{agent.creatorName}</span>
        ),
    },
    {
      // P1-18：可见性徽标 + （指定用户时）受众规模；判据都来自服务端下发字段，前端不自己算。
      title: t('agents.colVisibility'),
      dataIndex: 'visibility',
      width: 170,
      render: (_, agent) => (
        <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <VisibilityBadge visibility={agent.visibility} />
          {agent.visibility === 'SHARED' && (
            <span className="ratio" title={t('agents.audienceTitle')}>
              {t('agents.audienceCount', { users: agent.audience.users.length, groups: agent.audience.groups.length })}
            </span>
          )}
        </span>
      ),
    },
    {
      title: t('agents.colUpdated'),
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, agent) => <span className="num">{formatUpdatedAt(agent.updatedAt)}</span>,
    },
    {
      title: t('agents.colActions'),
      key: 'actions',
      // 复制对所有行都提供（不需要编辑权限，见服务层 `copyAgent` 口径 ①）⇒ 比原来宽一点
      width: 320,
      align: 'right',
      render: (_, agent) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Link to={chatPath(agent.id)}>{t('agents.chat')}</Link>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={copy.isPending}
            loading={copy.isPending && copy.variables === agent.id}
            onClick={() => {
              copy.mutate(agent.id, {
                onSuccess: (created) => feedback.ok(t('agents.copied', { name: created.name })),
                onError: (error) => feedback.fail(error, t('agents.copyFailed')),
              })
            }}
          >
            {t('agents.copy')}
          </Button>
          {agent.canEdit ? (
            <>
              <Link to={agentEditPath(agent.id)}>{t('common.edit')}</Link>
              <Button type="link" danger size="small" onClick={() => setPendingDelete(agent)} style={{ padding: 0 }}>
                {t('common.delete')}
              </Button>
            </>
          ) : (
            <span className="ratio">{t('agents.noEditPerm')}</span>
          )}
        </div>
      ),
    },
  ]

  const head = (
    <>
      <div className="page__head">
        <div>
          <h1>{t('agents.title')}</h1>
          <p className="page__lead">
            {isPending ? (
              t('agents.loading')
            ) : (
              t('agents.leadPrefix', { total, editable: editableCount })
            )}
          </p>
        </div>
        <div className="page__head-actions">
          <Button type="primary" onClick={() => navigate(AGENTS_NEW_PATH)}>
            {t('agents.create')}
          </Button>
        </div>
      </div>
    </>
  )

  if (isError) {
    return (
      <>
        {head}
        <ErrorState
          title={t('agents.loadFailed')}
          error={error}
          retrying={isFetching}
          onRetry={() => {
            void refetch()
          }}
        />
      </>
    )
  }

  return (
    <>
      {head}

      <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
        <Input.Search
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('agents.searchPlaceholder')}
          style={{ width: 260 }}
          aria-label={t('agents.searchAria')}
        />
        <div className="seg" role="group" aria-label={t('agents.filterTypeAria')}>
          <button type="button" aria-pressed={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')}>
            {t('agents.filterAll')}
          </button>
          {AGENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={typeFilter === type}
              onClick={() => setTypeFilter(type)}
            >
              {AGENT_TYPE_LABEL[type]}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t('agents.filterOwnerAria')}>
          <button type="button" aria-pressed={ownerFilter === 'ALL'} onClick={() => setOwnerFilter('ALL')}>
            {t('agents.filterAllVisible')}
          </button>
          <button type="button" aria-pressed={ownerFilter === 'MINE'} onClick={() => setOwnerFilter('MINE')}>
            {t('agents.filterMine')}
          </button>
        </div>
        <span className="ratio u-right">
          {t('agents.source')}
          {total > items.length && (
            <>
              {' '}
              {t('agents.sourceMorePrefix', { total, shown: items.length })}
              <code>limit</code>
              {t('agents.sourceMoreSuffix')}
            </>
          )}
        </span>
      </div>

      {isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('agents.emptyTitle')}
            lead={t('agents.emptyLead')}
            action={
              <Button type="primary" onClick={() => navigate(AGENTS_NEW_PATH)}>
                {t('agents.create')}
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('agents.noMatchTitle')}
            lead={t('agents.noMatchLead', {
              keyword: keyword.trim(),
              type: typeFilter === 'ALL' ? '' : t('agents.noMatchType', { type: AGENT_TYPE_LABEL[typeFilter] }),
            })}
            action={
              <Button
                onClick={() => {
                  setKeyword('')
                  setTypeFilter('ALL')
                  setOwnerFilter('ALL')
                }}
              >
                {t('agents.clearFilter')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card">
          <Table<AgentItem>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={filtered}
            // 加载态已由 TableSkeleton 承担 ⇒ 这里不再叠一层 AntD 的遮罩转圈
            loading={false}
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => t('agents.pageTotal', { count }) }}
          />
        </div>
      )}

      <DeleteAgentModal agent={pendingDelete} onClose={() => setPendingDelete(null)} />
      <TransferOwnershipModal
        open={transferFor !== null}
        assetKind="AGENT"
        assetId={transferFor?.id ?? ''}
        assetName={transferFor?.name ?? ''}
        currentOwnerName={transferFor?.creatorName ?? ''}
        onClose={() => setTransferFor(null)}
      />
    </>
  )
}
