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
import { AGENTS_NEW_PATH, chatPath, agentEditPath } from '../../app/paths.js'

/** 类型筛选：`ALL` 是"全部"，其余取 `AGENT_TYPES` 的字面量 */
type TypeFilter = 'ALL' | AgentType

/** 所属筛选（P1-13）：`MINE` = 只看我建的（`createdBy === 我`），`ALL` = 全部对我可见的 */
type OwnerFilter = 'ALL' | 'MINE'

export function AgentsListPage() {
  const navigate = useNavigate()
  const feedback = useFeedback()
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
      title: '名称',
      dataIndex: 'name',
      render: (_, agent) => (
        <div className="agent-cell">
          <span className="agent-cell__name">{agent.name}</span>
          <span className="agent-cell__sub">{agent.description ?? '（没有描述）'}</span>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 120,
      render: (_, agent) => (
        <Tag className={agent.type === 'CHATBOT' ? 'tag--accent' : undefined}>{AGENT_TYPE_LABEL[agent.type]}</Tag>
      ),
    },
    {
      title: '模型',
      dataIndex: 'modelName',
      width: 200,
      render: (_, agent) =>
        agent.modelId === null ? (
          // 未绑定模型（多因所属模型商/模型被删除而自动解绑）：如实标注、指向"去编辑页重新绑定"
          <div className="agent-cell">
            <span className="num">
              <Tag className="tag--danger">未绑定模型</Tag>
            </span>
            <span className="agent-cell__sub">所属模型商/模型已删除，编辑智能体重新绑定后才能对话</span>
          </div>
        ) : (
          <div className="agent-cell">
            <span className="num">
              {agent.modelName}
              {!agent.modelAvailable && (
                <>
                  {' '}
                  <Tag className="tag--danger">已停用</Tag>
                </>
              )}
            </span>
            <span className="agent-cell__sub">{agent.modelAvailable ? agent.modelLabel : '该模型或所属 Provider 已停用，发消息会被拒'}</span>
          </div>
        ),
    },
    {
      title: '组件绑定',
      dataIndex: 'components',
      width: 180,
      render: (_, agent) => {
        const knowledge = agent.components.filter((c) => c.componentType === 'KNOWLEDGE').length
        const mcp = mcpRefsOf(agent.components).length
        if (knowledge === 0 && mcp === 0) return <Tag>无绑定</Tag>
        return (
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            {knowledge > 0 && <Tag>知识库 ×{knowledge}</Tag>}
            {mcp > 0 && <Tag className="tag--warn">MCP ×{mcp}</Tag>}
          </span>
        )
      },
    },
    {
      // P1-13：所属人（= `createdBy`/`creatorName`）。列表对全员可见，这是"这条是谁的"的读数
      //（判据都是服务端下发的字段，前端不自己算）。
      title: '所属人',
      dataIndex: 'creatorName',
      width: 140,
      render: (_, agent) =>
        // P1-18（2026-10-16 修订）：把这一列做成转移入口 —— 只有创建者/管理员（`canEdit`）能点，
        // 点了弹转移弹窗；其余人只显示名字。
        // ⚠️ 可见性徽标与受众人数**移到独立的「可见性」列**（2026-10-16 复议）：原先三者挤在
        // 一个 160px 列里，指定用户分享后 `名字 + 徽标 + 「N 人 / M 组」` 溢出换行、看着错乱。
        agent.canEdit ? (
          <Tooltip title="点击转移所属人">
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
      title: '可见性',
      dataIndex: 'visibility',
      width: 170,
      render: (_, agent) => (
        <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <VisibilityBadge visibility={agent.visibility} />
          {agent.visibility === 'SHARED' && (
            <span className="ratio" title="受众 = 直接指定的用户 ∪ 指定组里的成员">
              {agent.audience.users.length} 人 / {agent.audience.groups.length} 组
            </span>
          )}
        </span>
      ),
    },
    {
      title: '最近更新',
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, agent) => <span className="num">{formatUpdatedAt(agent.updatedAt)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      // 复制对所有行都提供（不需要编辑权限，见服务层 `copyAgent` 口径 ①）⇒ 比原来宽一点
      width: 320,
      align: 'right',
      render: (_, agent) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Link to={chatPath(agent.id)}>对话</Link>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={copy.isPending}
            loading={copy.isPending && copy.variables === agent.id}
            onClick={() => {
              copy.mutate(agent.id, {
                onSuccess: (created) => feedback.ok(`已复制为「${created.name}」`),
                onError: (error) => feedback.fail(error, '复制失败'),
              })
            }}
          >
            复制
          </Button>
          {agent.canEdit ? (
            <>
              <Link to={agentEditPath(agent.id)}>编辑</Link>
              <Button type="link" danger size="small" onClick={() => setPendingDelete(agent)} style={{ padding: 0 }}>
                删除
              </Button>
            </>
          ) : (
            <span className="ratio">无编辑权限</span>
          )}
        </div>
      ),
    },
  ]

  const head = (
    <>
      <div className="page__head">
        <div>
          <h1>智能体</h1>
          <p className="page__lead">
            {isPending ? (
              '正在读取智能体列表…'
            ) : (
              <>
                你可见的智能体共 <span className="num">{total}</span> 个，其中你能编辑的{' '}
                <span className="num">{editableCount}</span> 个（创建者或管理员），其余只读。列表按最近更新排序。
              </>
            )}
          </p>
        </div>
        <div className="page__head-actions">
          <Button type="primary" onClick={() => navigate(AGENTS_NEW_PATH)}>
            创建智能体
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
          title="智能体列表加载失败"
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
          placeholder="搜索名称或描述…"
          style={{ width: 260 }}
          aria-label="搜索智能体"
        />
        <div className="seg" role="group" aria-label="按类型筛选">
          <button type="button" aria-pressed={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')}>
            全部
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
        <div className="seg" role="group" aria-label="按所属人筛选">
          <button type="button" aria-pressed={ownerFilter === 'ALL'} onClick={() => setOwnerFilter('ALL')}>
            全部可见
          </button>
          <button type="button" aria-pressed={ownerFilter === 'MINE'} onClick={() => setOwnerFilter('MINE')}>
            只看我的
          </button>
        </div>
        <span className="ratio u-right">
          数据来自 GET /api/agents · 缓存 30s
          {total > items.length && (
            <>
              {' '}
              · 共 <span className="num">{total}</span> 个，本次取回前 <span className="num">{items.length}</span> 个
              （<code>limit</code> 上限 100，更早的不在此页）
            </>
          )}
        </span>
      </div>

      {isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="还没有智能体"
            lead="创建一个智能体：选一个对话模型、写清它的角色与边界。需要私有知识就挂知识库，需要动手就挂 MCP 工具。"
            action={
              <Button type="primary" onClick={() => navigate(AGENTS_NEW_PATH)}>
                创建智能体
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title="没有匹配的智能体"
            lead={`当前筛选条件下没有结果（关键字「${keyword.trim()}」${typeFilter === 'ALL' ? '' : ` · 类型 ${AGENT_TYPE_LABEL[typeFilter]}`}）。`}
            action={
              <Button
                onClick={() => {
                  setKeyword('')
                  setTypeFilter('ALL')
                  setOwnerFilter('ALL')
                }}
              >
                清空筛选
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
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => `共 ${count} 条 · 每页 20` }}
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
