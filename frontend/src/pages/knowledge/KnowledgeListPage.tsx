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

import { Button, Input, Table, Tag, type TableColumnsType } from 'antd'
import type { KnowledgeBaseItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { KNOWLEDGE_BASES_PICKER_LIMIT, useKnowledgeBases } from '../../api/knowledgeBases.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { HOME_PATH, knowledgeDetailPath } from '../../app/paths.js'
import { formatUpdatedAt } from '../../app/format.js'
import { DeleteKnowledgeBaseModal } from './DeleteKnowledgeBaseModal.js'
import { KnowledgeBaseFormModal } from './KnowledgeBaseFormModal.js'
import { describeRetrieval, embeddingChangedNotice } from './knowledgeModel.js'

export function KnowledgeListPage() {
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState('')
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<KnowledgeBaseItem | null>(null)

  const { data, isPending, isError, error, isFetching, refetch } = useKnowledgeBases(
    KNOWLEDGE_BASES_PICKER_LIMIT,
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0

  const normalizedKeyword = keyword.trim().toLowerCase()
  const filtered =
    normalizedKeyword === ''
      ? items
      : items.filter((item) =>
          `${item.name}\n${item.description ?? ''}`.toLowerCase().includes(normalizedKeyword),
        )

  const columns: TableColumnsType<KnowledgeBaseItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_, kb) => (
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
      title: '最近更新',
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, kb) => <span className="num">{formatUpdatedAt(kb.updatedAt)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      align: 'right',
      render: (_, kb) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Link to={knowledgeDetailPath(kb.id)}>打开</Link>
          <Button type="link" danger size="small" style={{ padding: 0 }} onClick={() => setPendingDelete(kb)}>
            删除
          </Button>
        </div>
      ),
    },
  ]

  const head = (
    <>
      <nav className="crumb" aria-label="面包屑">
        <Link to={HOME_PATH}>工作台</Link>
        <span className="crumb__sep" aria-hidden="true">
          /
        </span>
        <span className="crumb__here">知识库</span>
      </nav>

      <div className="page__head">
        <div>
          <h1>知识库</h1>
          <p className="page__lead">
            {isPending ? (
              '正在读取知识库列表…'
            ) : (
              <>
                共 <span className="num">{total}</span> 个知识库。知识库是<strong>共享</strong>的：任何
                登录用户都能查看、上传与修改（没有归属人），删除受限之处只有一处 —— 被智能体引用时
                接口会返回 409。
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
      <DeleteKnowledgeBaseModal kb={pendingDelete} open={pendingDelete !== null} onClose={() => setPendingDelete(null)} />
    </>
  )
}
