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
import { useT } from '../../app/i18n.js'
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
  const { t, locale } = useT()
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
      title: t('kbList.colName'),
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
          <span className="kb-cell__sub">{kb.description ?? t('kbList.noDescription')}</span>
        </div>
      ),
    },
    {
      title: t('kbList.colDocs'),
      dataIndex: 'documentCount',
      width: 90,
      align: 'right',
      render: (_, kb) => <span className="num">{kb.documentCount}</span>,
    },
    {
      title: t('kbList.colAgents'),
      dataIndex: 'agentCount',
      width: 150,
      render: (_, kb) =>
        kb.agentCount === 0 ? (
          <span className="ratio">{t('kbList.notReferenced')}</span>
        ) : (
          <span className="num">
            {t('kbList.agentCount', { count: kb.agentCount })} <Tag className="tag--warn">{t('kbList.unbindTag')}</Tag>
          </span>
        ),
    },
    {
      title: t('kbList.colRetrieval'),
      key: 'retrieval',
      width: 300,
      // 窄屏（< xl = 1200px）**整列隐藏**：它是本表最宽的一列，窄屏上留着会把「名称」挤到看不清。
      // 隐藏后口径不丢 —— 「名称」列的名称旁有一个 hover 图标（见上）承载同一份内容。
      responsive: ['xl'],
      render: (_, kb) => {
        const notice = embeddingChangedNotice(kb.embeddingModelChanged, locale)
        return (
          <div className="kb-cell">
            <span className="kb-cell__sub num">{describeRetrieval(kb.retrievalConfig, locale)}</span>
            {/* 三态提示（`true` = 该库需重建 / `null` = 判断不了）——两种原因分开报，
                合成一句会让用户去重做一个治不好的动作（见 `embeddingChangedNotice`）。
                一句话的完整文案放 `title`（原生 tooltip）：这一列放不下，删掉它又会让
                "为什么有个红标"变成必须点进去才知道的事。 */}
            {notice !== null && (
              <span className="kb-cell__sub" title={notice.text}>
                <Tag className={notice.tone === 'warn' ? 'tag--danger' : undefined}>
                  {notice.tone === 'warn' ? t('kbList.embeddingRebuild') : t('kbList.embeddingUnknown')}
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
      title: t('kbList.colOwner'),
      dataIndex: 'creatorName',
      width: 140,
      render: (_, kb) =>
        kb.canEdit ? (
          <Tooltip title={t('kbList.ownerTransferTitle')}>
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
      title: t('kbList.colVisibility'),
      dataIndex: 'visibility',
      width: 170,
      render: (_, kb) => (
        <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <VisibilityBadge visibility={kb.visibility} />
          {kb.visibility === 'SHARED' && (
            <span className="ratio" title={t('kbList.audienceTitle')}>
              {t('kbList.audienceCount', { users: kb.audience.users.length, groups: kb.audience.groups.length })}
            </span>
          )}
        </span>
      ),
    },
    {
      title: t('kbList.colUpdated'),
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, kb) => <span className="num">{formatUpdatedAt(kb.updatedAt)}</span>,
    },
    {
      title: t('kbList.colActions'),
      key: 'actions',
      width: 260,
      align: 'right',
      render: (_, kb) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Link to={knowledgeDetailPath(kb.id)}>{t('kbList.open')}</Link>
          {/* P1-13：知识库现在有 owner —— 编 / 删按服务端给的 `canEdit` 渲染（所属人或 ADMIN） */}
          {kb.canEdit ? (
            <>
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditing(kb)}>
                {t('common.edit')}
              </Button>
              <Button type="link" danger size="small" style={{ padding: 0 }} onClick={() => setPendingDelete(kb)}>
                {t('common.delete')}
              </Button>
            </>
          ) : (
            <span className="ratio" title={t('kbList.noEditPermTitle')}>
              {t('kbList.noEditPerm')}
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
          <h1>{t('kbList.title')}</h1>
          <p className="page__lead">
            {isPending ? (
              t('kbList.loading')
            ) : (
              <>
                {t('kbList.leadPrefix', { total })}
                <strong>{t('kbList.leadStrong')}</strong>
                {t('kbList.leadSuffix')}
              </>
            )}
          </p>
        </div>
        <div className="page__head-actions">
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('kbList.create')}
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
          title={t('kbList.loadFailed')}
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
          placeholder={t('kbList.searchPlaceholder')}
          style={{ width: 260 }}
          aria-label={t('kbList.searchAria')}
        />
        <div className="seg" role="group" aria-label={t('kbList.filterAria')}>
          <button type="button" aria-pressed={ownerFilter === 'ALL'} onClick={() => setOwnerFilter('ALL')}>
            {t('kbList.filterAll')}
          </button>
          <button type="button" aria-pressed={ownerFilter === 'MINE'} onClick={() => setOwnerFilter('MINE')}>
            {t('kbList.filterMine')}
          </button>
        </div>
        <span className="ratio u-right">
          {t('kbList.source')}
          {total > items.length && (
            <>
              {' '}
              {t('kbList.sourceMorePrefix', { total, shown: items.length })}
              <code>limit</code>
              {t('kbList.sourceMoreSuffix')}
            </>
          )}
        </span>
      </div>

      {isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('kbList.emptyTitle')}
            lead={t('kbList.emptyLead')}
            action={
              <Button type="primary" onClick={() => setCreating(true)}>
                {t('kbList.create')}
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('kbList.noMatchTitle')}
            lead={t('kbList.noMatchLead', { keyword: keyword.trim() })}
            action={
              <Button
                onClick={() => {
                  setKeyword('')
                  setOwnerFilter('ALL')
                }}
              >
                {t('kbList.clearFilter')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card">
          <Table<KnowledgeBaseItem>
            rowKey="id"
            size="middle"
            // `kb-table` 只做一件事：给 `.ant-table-content` 一个可选的挂点，供 `app.css` 在**大屏**
            // （≥ 1200px）把它从「横向滚动」改回「整表自适应容器宽度」（见下方 `scroll` 与 `app.css`）。
            className="kb-table"
            columns={columns}
            dataSource={filtered}
            loading={false}
            // ⚠️ `scroll.x` 只在**小屏**（< xl = 1200px）真正生效 —— 各列宽度之和（1220，隐藏了
            // 「检索口径」列）大于容器时**横向滚动**，而不是把「名称」压缩变形。
            //
            // 为什么大屏必须关掉它（2026-10-22 用户反馈「大屏展示很奇怪」）：`max-content` 会把
            // 表格钉在「各列宽度之和」= 1520px（含「检索口径」列），而页面正文**可读宽度上限是
            // 1440px**（`.page__body`，见 `app.css`）⇒ 即使在 2400px 的显示器上，表格右缘也**一直缺
            // 80px**、冒出横向滚动条、「操作」列被裁掉一截 —— 观感正是"明明屏幕很宽，表格却挤着滚"。
            // 大屏下改由 `app.css` 的 `@media (min-width: 1200px) .kb-table` 把表格改成 `width:100%`、
            // 去掉滚动条，列**等比收缩**、放不下的长文本换行/截断（`.kb-cell__name` 本就两行截断）。
            //
            // ⚠️ `max-content` 不能换成固定数字（如 `1520`）：它要随 `responsive: ['xl']` 隐藏的
            // 「检索口径」列**自动收放**，写死数字会让窄屏多出一列宽的空白。
            scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => t('kbList.pageTotal', { count }) }}
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
