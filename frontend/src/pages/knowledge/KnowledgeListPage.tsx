/**
 * 知识库列表（`/knowledge`，P0-1-35）
 *
 * 依据：`docs/03` §二（`/knowledge` = 知识库列表，**登录即可**）、§4.3（详情页）、
 *      §七（**创建形态**：字段 ≤6 用弹窗；列表三态；表格规范）、`design/knowledge.html`
 *      （视觉与字段）、`shared/src/knowledgeBase.ts`（`KnowledgeBaseItem` 唯一一套投影）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：这一页对**全员**开放（不是 ADMIN）
 * ─────────────────────────────────────────────────────────────────────
 * `03` §25 的权限列里 `/knowledge` 是「登录」，`docs/02` §三 的 `knowledge_bases` 也没有 owner 列
 * —— 与模型池**刻意相反**。所以页面里既没有 `RequireAdmin`，也不按角色隐藏任何入口
 * （`06` §六 第 ③ 条：权限一律先查文档再写代码）。
 * ⚠️ 代价要说清：没有 owner ⇒ **任何人都能改/删别人建的知识库**。这是文档口径的直接推论，
 * 不是实现疏漏（`shared/src/knowledgeBase.ts` 文件头 ① 已写明）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 取数与筛选：一次取满 100 条 + 客户端筛选（与 `/` 的智能体列表同口径）
 * ─────────────────────────────────────────────────────────────────────
 * `listKnowledgeBasesQuerySchema` 的 `limit` 上限是 100，本页取满一页后由 AntD Table 做
 * 20/页。为什么不做服务端分页：`GET /api/knowledge-bases` **没有关键字参数**
 * （`shared` 的注释：加一个没人要的参数，等于让"列表为什么少了几条"变成一件要靠猜的事），
 * 而"服务端分页 + 客户端筛选"会让筛选只作用于当前页 —— 那是**看着像坏了**的行为。
 * 超过 100 个库时页脚如实提示，不是静默截断。
 */

import { Button, Input, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import type { KnowledgeBaseItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { KNOWLEDGE_BASES_PICKER_LIMIT, useKnowledgeBases } from '../../api/knowledgeBases.js'
import { useCurrentUser } from '../../api/auth.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { VisibilityBadge } from '../../components/VisibilityBadge.js'
import { knowledgeDetailPath } from '../../app/paths.js'
import { formatUpdatedAt } from '../../app/format.js'
import { DeleteKnowledgeBaseModal } from './DeleteKnowledgeBaseModal.js'
import { KnowledgeBaseFormModal } from './KnowledgeBaseFormModal.js'
import { describeRetrieval, embeddingChangedNotice } from './knowledgeModel.js'

/** 所属筛选（P1-13）：`MINE` = 只看我建的，`ALL` = 全部对我可见的 */
type OwnerFilter = 'ALL' | 'MINE'

export function KnowledgeListPage() {
  const navigate = useNavigate()
  const { data: me } = useCurrentUser()
  const [keyword, setKeyword] = useState('')
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('ALL')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<KnowledgeBaseItem | null>(null)
  const [transferFor, setTransferFor] = useState<KnowledgeBaseItem | null>(null)
  const [pendingDelete, setPendingDelete] = useState<KnowledgeBaseItem | null>(null)

  const { data, isPending, isError, error, isFetching, refetch } = useKnowledgeBases(
    KNOWLEDGE_BASES_PICKER_LIMIT,
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0

  const normalizedKeyword = keyword.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (ownerFilter === 'MINE' && item.createdBy !== me?.id) return false
    if (normalizedKeyword === '') return true
    return `${item.name}\n${item.description ?? ''}`.toLowerCase().includes(normalizedKeyword)
  })

  const columns: TableColumnsType<KnowledgeBaseItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      // 显式宽度：窄屏下让这一列**不被挤扁**（其余列宽固定，本列有 width 才不会被压成一行碎片）。
      // 宽度之和交给 Table 的 `scroll.x` 兜底（见表格处）。
      width: 280,
      render: (_, kb) => (
        // ⚠️ 名称旁**不再挂 hover 检索口径图标**（2026-10-16 修订）：口径是「检索口径」列的读数，
        // 名称列只承载名称本身 —— 一个悬停图标既挤名字、又与右侧整列重复说同一件事。
        <div className="kb-cell">
          <Link to={knowledgeDetailPath(kb.id)} className="kb-cell__name">
            {kb.name}
          </Link>
          <span className="kb-cell__sub">{kb.description ?? '（没有描述）'}</span>
        </div>
      ),
    },
    {
      title: '文档',
      dataIndex: 'documentCount',
      width: 90,
      align: 'right',
      render: (_, kb) => <span className="num">{kb.documentCount}</span>,
    },
    {
      title: '引用它的智能体',
      dataIndex: 'agentCount',
      width: 150,
      render: (_, kb) =>
        kb.agentCount === 0 ? (
          <span className="ratio">未被引用</span>
        ) : (
          <span className="num">
            {kb.agentCount} 个 <Tag className="tag--warn">删除前需解绑</Tag>
          </span>
        ),
    },
    {
      title: '检索口径',
      key: 'retrieval',
      width: 300,
      // 窄屏（< xl = 1200px）**整列隐藏**：它是本表最宽的一列，窄屏上留着会把「名称」挤到看不清。
      // 隐藏后口径不丢 —— 「名称」列的名称旁有一个 hover 图标（见上）承载同一份内容。
      responsive: ['xl'],
      render: (_, kb) => {
        const notice = embeddingChangedNotice(kb.embeddingModelChanged)
        return (
          <div className="kb-cell">
            <span className="kb-cell__sub num">{describeRetrieval(kb.retrievalConfig)}</span>
            {/* 三态提示（`true` = 该库需重建 / `null` = 判断不了）——两种原因分开报，
                合成一句会让用户去重做一个治不好的动作（见 `embeddingChangedNotice`）。
                一句话的完整文案放 `title`（原生 tooltip）：这一列放不下，删掉它又会让
                "为什么有个红标"变成必须点进去才知道的事。 */}
            {notice !== null && (
              <span className="kb-cell__sub" title={notice.text}>
                <Tag className={notice.tone === 'warn' ? 'tag--danger' : undefined}>
                  {notice.tone === 'warn' ? 'embedding 需重建' : 'embedding 无法判定'}
                </Tag>
                <span className="num">{kb.embeddingModel}</span>
              </span>
            )}
          </div>
        )
      },
    },
    {
      // P1-13：所属人（= `createdBy`/`creatorName`）。只有所属人/管理员（`canEdit`）能点，点了弹转移弹窗；
      // 其余人只显示名字。可见性徽标与受众规模移到独立的「可见性」列。
      title: '所属人',
      dataIndex: 'creatorName',
      width: 140,
      render: (_, kb) =>
        kb.canEdit ? (
          <Tooltip title="点击转移所属人">
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTransferFor(kb)}>
              {kb.creatorName}
            </Button>
          </Tooltip>
        ) : (
          <span>{kb.creatorName}</span>
        ),
    },
    {
      // P1-18.x：可见性徽标 +（指定用户时）受众规模（判据来自服务端下发字段，前端不自己算）
      title: '可见性',
      dataIndex: 'visibility',
      width: 170,
      render: (_, kb) => (
        <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <VisibilityBadge visibility={kb.visibility} />
          {kb.visibility === 'SHARED' && (
            <span className="ratio" title="受众 = 直接指定的用户 ∪ 指定组里的成员">
              {kb.audience.users.length} 人 / {kb.audience.groups.length} 组
            </span>
          )}
        </span>
      ),
    },
    {
      title: '最近更新',
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, kb) => <span className="num">{formatUpdatedAt(kb.updatedAt)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      align: 'right',
      render: (_, kb) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Link to={knowledgeDetailPath(kb.id)}>打开</Link>
          {/* P1-13：知识库现在有 owner —— 编 / 删按服务端给的 `canEdit` 渲染（所属人或 ADMIN） */}
          {kb.canEdit ? (
            <>
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditing(kb)}>
                编辑
              </Button>
              <Button type="link" danger size="small" style={{ padding: 0 }} onClick={() => setPendingDelete(kb)}>
                删除
              </Button>
            </>
          ) : (
            <span className="ratio" title="只有该知识库的所属人或管理员可以编辑 / 删除">
              无编辑权限
            </span>
          )}
        </div>
      ),
    },
  ]

  const head = (
    <>
      <div className="page__head">
        <div>
          <h1>知识库</h1>
          <p className="page__lead">
            {isPending ? (
              '正在读取知识库列表…'
            ) : (
              <>
                共 <span className="num">{total}</span> 个知识库（仅列出对你可见的：公开的、共享给你的、以及你自己的）。
                编辑 / 删除只对<strong>所属人</strong>或管理员开放；被智能体引用时删除会被后端拒绝（409）。
              </>
            )}
          </p>
        </div>
        <div className="page__head-actions">
          <Button type="primary" onClick={() => setCreating(true)}>
            创建知识库
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
          title="知识库列表加载失败"
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
          aria-label="搜索知识库"
        />
        <div className="seg" role="group" aria-label="按所属人筛选">
          <button type="button" aria-pressed={ownerFilter === 'ALL'} onClick={() => setOwnerFilter('ALL')}>
            全部可见
          </button>
          <button type="button" aria-pressed={ownerFilter === 'MINE'} onClick={() => setOwnerFilter('MINE')}>
            只看我的
          </button>
        </div>
        <span className="ratio u-right">
          数据来自 GET /api/knowledge-bases · 缓存 30s
          {total > items.length && (
            <>
              {' '}
              · 共 <span className="num">{total}</span> 个，本次取回前 <span className="num">{items.length}</span> 个
              （<code>limit</code> 上限 100）
            </>
          )}
        </span>
      </div>

      {isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="还没有知识库"
            lead="知识库是「可检索的语料」：先建一个库，再把 md / pdf / docx / txt 传进去，之后在智能体的组件绑定里勾上它，对话时就会带上这里的引用。"
            action={
              <Button type="primary" onClick={() => setCreating(true)}>
                创建知识库
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title="没有匹配的知识库"
            lead={`当前筛选条件下没有结果（关键字「${keyword.trim()}」）。`}
            action={
              <Button
                onClick={() => {
                  setKeyword('')
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
          <Table<KnowledgeBaseItem>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={filtered}
            loading={false}
            // 各列宽度之和即自适应最小宽度：窄屏改为**横向滚动**，而不是把「名称」压缩变形
            //（`max-content` 会随 `responsive` 隐藏的「检索口径」列自动收放）。
            scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => `共 ${count} 个 · 每页 20` }}
          />
        </div>
      )}

      <KnowledgeBaseFormModal
        kb={null}
        open={creating}
        onClose={() => setCreating(false)}
        // 刚建完最想做的事是"传一篇文档" ⇒ 直接带到详情页
        onCreated={(created) => navigate(knowledgeDetailPath(created.id))}
      />
      {/* 编辑（P1-13：知识库有 owner 后，行内「编辑」入口按 canEdit 渲染） */}
      <KnowledgeBaseFormModal kb={editing} open={editing !== null} onClose={() => setEditing(null)} />
      <TransferOwnershipModal
        open={transferFor !== null}
        assetKind="KNOWLEDGE"
        assetId={transferFor?.id ?? ''}
        assetName={transferFor?.name ?? ''}
        currentOwnerName={transferFor?.creatorName ?? ''}
        onClose={() => setTransferFor(null)}
      />
      <DeleteKnowledgeBaseModal kb={pendingDelete} open={pendingDelete !== null} onClose={() => setPendingDelete(null)} />
    </>
  )
}
