/**
 * 文档片段预览抽屉（P0-1-35 增量）
 *
 * 依据：`docs/03` §4.3（文档表格的「操作」列）+ `shared/src/document.ts#chunkItemSchema`
 *      （`GET .../documents/:docId/chunks` 的响应投影）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它补的是哪个洞：上传后"内容被切成了什么样"此前完全不可观测
 * ─────────────────────────────────────────────────────────────────────
 * 列表只给每篇文档一个 `chunkCount`（数字），检索测试抽屉里的 `snippet` 是**命中窗口**、
 * 只回 topK 条 —— 两者都回答不了"这篇文档有哪些块、切得合不合理"。本抽屉按 `seq` 升序
 * 分页展示**整块原文**（不截断、不加省略号），让人能核对分块质量。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条刻意的口径
 * ─────────────────────────────────────────────────────────────────────
 * · **换一篇文档要回到第 1 页**：抽屉在页面里常驻挂载（开关只切 `open`），若不复位，
 *   在第 3 页点开另一篇只有 1 页的文档就会看到空表。做法是给正文加 `key={docId}`
 *   （见下方 `ChunkPreviewBody`）—— React 换 key 即重挂载，分页状态自然归零，
 *   比 `useEffect(setPage(1))` 少一次"先渲染旧页再纠正"的多余请求。
 * · **原文只做展示格式化，不改内容**：`chunk-content` 只负责保留换行与断行（见 `app.css`），
 *   文本本身逐字来自 `chunks.content`（`03` §七：不造假，也不"顺手摘要"）。
 * · **不轮询**：片段是已入库的静态内容；覆盖重建会清空重来，但那会让 `status` 变成
 *   `PARSING`、「查看片段」按钮也随之消失（`documentActions`），不需要在这里再叠一层刷新。
 */

import { Drawer, Table, Tag, type TableColumnsType } from 'antd'
import type { ChunkItem, DocumentItem } from '@doubulea/shared'
import { useState } from 'react'

import {
  CHUNKS_PAGE_LIMIT,
  useDocumentChunks,
} from '../../api/knowledgeBases.js'
import { useT } from '../../app/i18n.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { chunkLengthText, chunkLocationText } from './knowledgeModel.js'

export interface ChunkPreviewDrawerProps {
  kbId: string
  /** 目标文档；`null` = 没有打开任何文档（抽屉仍挂着，只是正文为空） */
  doc: DocumentItem | null
  open: boolean
  onClose: () => void
}

export function ChunkPreviewDrawer({ kbId, doc, open, onClose }: ChunkPreviewDrawerProps) {
  const { t } = useT()
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={820}
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          {t('chunkPreview.title')}
          {doc !== null && (
            <Tag>
              {t('chunkPreview.tag', { name: doc.fileName, count: doc.chunkCount })}
            </Tag>
          )}
        </span>
      }
    >
      {doc === null ? null : (
        // `key` 随文档变化 ⇒ 换文档时整个正文重挂载、分页回到第 1 页（见文件头第一条）
        <ChunkPreviewBody key={doc.id} kbId={kbId} docId={doc.id} enabled={open} />
      )}
    </Drawer>
  )
}

/** 抽屉正文（分页 + 三态）。单独一个组件只为拿到"换文档即重挂载"的 key 语义 */
function ChunkPreviewBody({
  kbId,
  docId,
  enabled,
}: {
  kbId: string
  docId: string
  enabled: boolean
}) {
  const [page, setPage] = useState(1)
  const { t, locale } = useT()
  const offset = (page - 1) * CHUNKS_PAGE_LIMIT

  const query = useDocumentChunks(kbId, docId, { offset, limit: CHUNKS_PAGE_LIMIT }, enabled)
  const data = query.data
  const chunks = data?.items ?? []

  const columns: TableColumnsType<ChunkItem> = [
    {
      title: t('chunkPreview.colLocation'),
      key: 'location',
      width: 240,
      render: (_, chunk) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{chunkLocationText(chunk, locale)}</span>
          <span className="kb-cell__sub num">{chunkLengthText(chunk.content, locale)}</span>
        </div>
      ),
    },
    {
      title: t('chunkPreview.colContent'),
      dataIndex: 'content',
      render: (_, chunk) => <div className="chunk-content">{chunk.content}</div>,
    },
  ]

  if (query.isPending) return <TableSkeleton rows={4} />

  if (query.isError) {
    return (
      <ErrorState
        title={t('chunkPreview.loadFailed')}
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => {
          void query.refetch()
        }}
      />
    )
  }

  if (chunks.length === 0) {
    // `READY` 的文档正常都有块；走到这里多半是"刚被覆盖重建清空"或数据异常 —— 如实说，
    // 不假装成功（`03` §七：空态要带一句能照着做的话）。
    return (
      <EmptyState
        title={t('chunkPreview.emptyTitle')}
        lead={t('chunkPreview.emptyLead')}
      />
    )
  }

  return (
    <>
      <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
        {t('chunkPreview.totalPrefix', { total: data?.total ?? 0 })}
        <code>seq</code>
        {t('chunkPreview.totalSuffix')}
      </p>
      <Table<ChunkItem>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={[...chunks]}
        pagination={{
          current: page,
          pageSize: CHUNKS_PAGE_LIMIT,
          total: data?.total ?? 0,
          showSizeChanger: false,
          onChange: (nextPage) => setPage(nextPage),
        }}
        scroll={{ x: 760 }}
      />
    </>
  )
}
