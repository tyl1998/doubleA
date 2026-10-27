/**
 * 知识库详情页（`/knowledge/:id`，P0-1-35）
 *
 * 依据：`docs/03` §4.3（"顶部：面包屑返回；名称/描述/检索配置编辑 + [上传文档] [检索测试]；
 *      文档表格：…；检索测试抽屉：…"）、§七（二级页动线：统一面包屑/左上返回；表格规范）、
 *      `design/knowledge.html`（两栏结构：左 stack + 右侧体量卡）、`shared` 的 KB 与文档投影。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 页面上每一个数字都问过"这个数字拿得到吗"
 * ─────────────────────────────────────────────────────────────────────
 * | 想显示 | 来源 | 结论 |
 * |--------|------|------|
 * | 文档数 | `KnowledgeBaseItem.documentCount` | ✅ 权威（服务端 `count`） |
 * | 引用它的智能体数 | `agentCount` | ✅ 权威，且是"能不能删"的判据 |
 * | 片段（chunk）总数 | —— | ❌ **没有任何端点给这个数**（列表只给每篇的 `chunkCount`） |
 * | 文件大小 | —— | ❌ `documentItemSchema` 里没有 size |
 * | 状态分布（可检索/解析中/失败） | 文档列表**本页**条目 | ⚠️ 只是本页的，文案必须写明 |
 * 原型上那句"213 个片段"与表格里的"1.2 MB"都落在 ❌ 那一行 ⇒ **如实不显示**，改为显示状态分布
 * （它对用户真的有用：一眼看出有几篇卡住了）。这是 P0-1-34「界面上有数字 ≠ 能拿到这个数字」
 * 在本页的对应物。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 404 要有一条"出路"，不能只给"重试"
 * ─────────────────────────────────────────────────────────────────────
 * 库被删（或 id 写错）时后端回 404。此时"重试"是没意义的主按钮 —— 用户真正需要的是回到列表。
 * 所以 404 单独一档：说明 + 「回到知识库列表」+ 并列一个「重试」（万一只是网络抖了一下）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 文档表格每 2s 自动刷新，而这件事要写在明处
 * ─────────────────────────────────────────────────────────────────────
 * 触发源是「本页有 `PARSING` 的文档」（`documentRefetchInterval`），全部终态即停。
 * 表尾把这件事说出来（原型的表尾也写着类似的一句），否则用户会以为"状态怎么自己变了"。
 */

import { Alert, Button, Tag, Tooltip } from 'antd'
import type { DocumentItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../../api/client.js'
import {
  DOCUMENTS_PAGE_LIMIT_MAX,
  useDocuments,
  useKnowledgeBase,
  useRebuildKnowledgeBase,
} from '../../api/knowledgeBases.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { KNOWLEDGE_PATH } from '../../app/paths.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { ChunkPreviewDrawer } from './ChunkPreviewDrawer.js'
import { DeleteKnowledgeBaseModal } from './DeleteKnowledgeBaseModal.js'
import { DocumentTable } from './DocumentTable.js'
import { KnowledgeBaseFormModal } from './KnowledgeBaseFormModal.js'
import { KnowledgeConfigModal } from './KnowledgeConfigModal.js'
import { SearchTestDrawer } from './SearchTestDrawer.js'
import { UploadDocumentModal } from './UploadDocumentModal.js'
import {
  DOCUMENT_POLL_INTERVAL_MS,
  describeChunking,
  describeRetrieval,
  embeddingChangedNotice,
  summarizeDocuments,
} from './knowledgeModel.js'

export function KnowledgeDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t, locale } = useT()

  const feedback = useFeedback()
  const kbQuery = useKnowledgeBase(id)
  const documentsQuery = useDocuments(id, { offset: 0, limit: DOCUMENTS_PAGE_LIMIT_MAX })
  const rebuild = useRebuildKnowledgeBase(id)

  const [editing, setEditing] = useState(false)
  const [editingConfig, setEditingConfig] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** 上传弹窗：`null` = 关闭；`'new'` = 上传新文档；否则是**覆盖重传**的目标 */
  const [uploadTarget, setUploadTarget] = useState<'new' | DocumentItem | null>(null)
  /** 片段预览：`null` = 关闭；否则是正在预览的那篇文档 */
  const [chunkTarget, setChunkTarget] = useState<DocumentItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const kb = kbQuery.data
  const documents = documentsQuery.data?.items ?? []
  const documentTotal = documentsQuery.data?.total ?? 0
  const summary = summarizeDocuments(documents)
  const notice = kb === undefined ? null : embeddingChangedNotice(kb.embeddingModelChanged, locale)
  /**
   * 该库必须先**整库重建**（模型被删/停用/改名，或维度变了）。
   *
   * `needsRebuild` 时后端的**上传 / 重试 / 覆盖重传一律 409**（避免单篇入库造成"半迁移"），
   * 所以本页的唯一正确动作是重建 —— 那条常驻告警上的「重建整库索引」按钮就是**强制入口**
   * （它不是常驻工具按钮，只在异常态出现）。正常换模型也能在「编辑」保存时自动重建。
   */
  const needsRebuild = kb?.needsRebuild === true

  function handleRebuild(): void {
    rebuild.mutate(undefined, {
      onSuccess: (result) => {
        if (result.failed > 0) {
          feedback.note(t('kbDetail.rebuildSubmittedToast', { enqueued: result.enqueued, failed: result.failed }))
        } else {
          feedback.ok(t('kbDetail.rebuildStartedToast', { enqueued: result.enqueued }))
        }
      },
      onError: (error) => feedback.fail(error, t('kbDetail.rebuildFailedToast')),
    })
  }

  // 面包屑已挪到顶栏：把知识库名作为「细节段」上报（顶栏渲染 `工作台 / 知识库 / <name>`）
  usePageCrumb(kb?.name ?? t('kbDetail.crumbFallback'))

  // ── 三态：加载 / 失败（404 单独一档） / 正常 ──────────────────────────────

  if (kbQuery.isPending) {
    return (
      <>
        <div className="page__head">
          <div>
            <h1>{t('kbDetail.title')}</h1>
            <p className="page__lead">{t('kbDetail.loadingLead')}</p>
          </div>
        </div>
        <TableSkeleton />
      </>
    )
  }

  if (kbQuery.isError) {
    const notFound = kbQuery.error instanceof ApiError && kbQuery.error.status === 404
    return (
      <>
        <div className="page__head">
          <div>
            <h1>{notFound ? t('kbDetail.notFoundTitle') : t('kbDetail.loadFailedTitle')}</h1>
          </div>
        </div>
        {notFound ? (
          <div className="card">
            <EmptyState
              title={t('kbDetail.notFoundEmptyTitle')}
              lead={t('kbDetail.notFoundLead')}
              action={
                <div className="row" style={{ gap: 'var(--sp-3)' }}>
                  <Link to={KNOWLEDGE_PATH}>
                    <Button type="primary">{t('kbDetail.backToList')}</Button>
                  </Link>
                  <Button
                    onClick={() => {
                      void kbQuery.refetch()
                    }}
                    loading={kbQuery.isFetching}
                  >
                    {t('common.retry')}
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <ErrorState
            title={t('kbDetail.loadFailedTitle')}
            error={kbQuery.error}
            retrying={kbQuery.isFetching}
            onRetry={() => {
              void kbQuery.refetch()
            }}
          />
        )}
      </>
    )
  }

  // 类型收窄（不是运行时兜底）：上面两个分支已经排除了"还没问到"与"问失败"，
  // 但 TanStack Query 的 `data` 类型始终带 `| undefined`（`isPending === false` 在类型上
  // 并不排除 `undefined`）。写成 `return null` 而不是 `kb!`：万一将来有人调整了分支顺序，
  // 这里会渲染成空而不是崩在某一行的 `kb.name` 上。
  if (kb === undefined) return null

  return (
    <>
      <div className="page__head">
        <div>
          <h1>
            {kb.name}{' '}
            {/* `embeddingModel` 是"库里已有向量由谁产出"的快照；模型在模型池被改名后它刻意不变，
                要等重建完成才刷新。两者不同时显示 `旧 → 新`，避免"模型都改了、界面还显示旧名"。 */}
            <span className="kicker" title={t('kbDetail.embeddingSnapshotTitle')}>
              {kb.embeddingModelChanged && kb.embeddingModelCurrent !== null
                ? `${kb.embeddingModel} → ${kb.embeddingModelCurrent}`
                : kb.embeddingModel}
            </span>
          </h1>
          <p className="page__lead">
            {kb.description === null || kb.description === '' ? t('kbDetail.noDescription') : kb.description}
          </p>
          <p className="ratio">
            {t('kbDetail.headStats', {
              docs: kb.documentCount,
              agents: kb.agentCount,
              retrieval: describeRetrieval(kb.retrievalConfig, locale),
            })}
          </p>
        </div>
        <div className="page__head-actions">
          <Button onClick={() => setSearchOpen(true)}>{t('kbDetail.searchTest')}</Button>
          {/* 没有**常驻**的「重建索引」按钮：正常换模型在「编辑」弹窗里做、保存即自动重建；
              只有"需重建"异常态才在下面告警里给一个强制入口 */}
          <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
<Tooltip title={needsRebuild ? t('hint.knowledgeBaseNeedsRebuild') : undefined}>
            <Button type="primary" disabled={needsRebuild} onClick={() => setUploadTarget('new')}>
              {t('kbDetail.upload')}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="split split--form">
        <div className="stack">
          {needsRebuild ? (
            /* 强制闸门：模型/维度已变 ⇒ 后端挡住单篇入库，这里是**唯一**合法动作（整库重建）。
               按钮只在异常态出现，不是常驻工具按钮。 */
            <Alert
              type="warning"
              showIcon
              message={t('kbDetail.needsRebuildTitle')}
              description={t('kbDetail.needsRebuildDesc', {
                needsRebuild: t('hint.knowledgeBaseNeedsRebuild'),
                searchable: t('hint.rebuildSearchable'),
              })}
              action={
                <Button size="small" loading={rebuild.isPending} onClick={handleRebuild}>
                  {t('kbDetail.rebuildNow')}
                </Button>
              }
            />
          ) : (
            /* 无法判定/普通漂移提示（`embeddingModelChanged` 三态）—— 不挂按钮 */
            notice !== null && (
              <Alert type={notice.tone === 'warn' ? 'warning' : 'info'} showIcon message={notice.text} />
            )
          )}

          <div className="card">
            <div className="card__head">
              <p className="card__title">{t('kbDetail.docsCard')}</p>
              <div className="card__head-right">
                <span className="ratio">
                  {t('kbDetail.docsStats', { parsing: summary.parsing, failed: summary.failed })}
                </span>
              </div>
            </div>

            {documentsQuery.isPending ? (
              <TableSkeleton rows={4} />
            ) : documentsQuery.isError ? (
              <div style={{ padding: 'var(--sp-5)' }}>
                <ErrorState
                  title={t('kbDetail.docsLoadFailed')}
                  error={documentsQuery.error}
                  retrying={documentsQuery.isFetching}
                  onRetry={() => {
                    void documentsQuery.refetch()
                  }}
                />
              </div>
            ) : documents.length === 0 ? (
              <EmptyState
                title={t('kbDetail.docsEmptyTitle')}
                lead={t('kbDetail.docsEmptyLead')}
                action={
                  <Button type="primary" onClick={() => setUploadTarget('new')}>
                    {t('kbDetail.upload')}
                  </Button>
                }
              />
            ) : (
              <DocumentTable
                kbId={kb.id}
                documents={documents}
                rebuildRequired={needsRebuild}
                onReupload={(doc) => setUploadTarget(doc)}
                onPreviewChunks={(doc) => setChunkTarget(doc)}
              />
            )}

            {documents.length > 0 && (
              <p className="ratio" style={{ padding: '0 var(--sp-5) var(--sp-5)' }}>
                {t('kbDetail.totalDocs', { total: documentTotal })}
                {documentTotal > documents.length && (
                  <>
                    {t('kbDetail.totalMorePrefix', { shown: documents.length })}
                    <code>limit</code>
                    {t('kbDetail.totalMoreSuffix')}
                  </>
                )}
                {summary.parsing > 0 && t('kbDetail.polling', { parsing: summary.parsing, seconds: DOCUMENT_POLL_INTERVAL_MS / 1000 })}
              </p>
            )}
          </div>

          <div className="card">
            <div className="card__head">
              <p className="card__title">{t('kbDetail.retrievalCard')}</p>
              <div className="card__head-right">
                {/* ⚠️ 原型这里挂的是"不落库 · 每次请求传入"——**反了**（那句描述的是检索测试
                    抽屉的参数）。库级配置改了就是落库、对所有人的检索都生效。 */}
                <Tag>{t('kbDetail.retrievalPersisted')}</Tag>
                <Button size="small" onClick={() => setEditingConfig(true)}>
                  {t('kbDetail.editConfig')}
                </Button>
              </div>
            </div>
            <div className="card__body stack stack--tight">
              <p className="num">{describeRetrieval(kb.retrievalConfig, locale)}</p>
              <p className="num">{describeChunking(kb, locale)}</p>
              <p className="ratio">
                {t('kbDetail.retrievalNote')}
              </p>
            </div>
          </div>
        </div>

        <aside className="stack stack--tight aside-card">
          <div className="card bracket card--pad">
            <p className="kicker">{t('kbDetail.volume')}</p>
            <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
              <div className="summary-row">
                <span className="summary-row__label">{t('kbDetail.rowDocs')}</span>
                <span className="num">{kb.documentCount}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">{t('kbDetail.rowReadable')}</span>
                <span className="num">{summary.readable}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">{t('kbDetail.rowParsing')}</span>
                <span className="num">{summary.parsing}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">{t('kbDetail.rowFailed')}</span>
                <span className="num">{summary.failed}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">{t('kbDetail.rowAgents')}</span>
                <span className="num">{kb.agentCount}</span>
              </div>
            </div>
            {/* "片段总数"与"向量维度"两个数字在原型上有，本仓**取不到**（没有任何端点给它们），
                所以这里不放 —— 编一个出来就是造假数据（`03` §七）。 */}
            <p className="ratio" style={{ marginTop: 'var(--sp-5)' }}>
              {t('kbDetail.volumeNote')}
            </p>
            {kb.agentCount > 0 && (
              <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
                {t('kbDetail.agentBoundNote')}
              </p>
            )}
          </div>

          <div className="card card--flat card--pad">
            <p className="kicker">{t('kbDetail.failureCard')}</p>
            <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
              {t('kbDetail.failureNote')}
            </p>
          </div>

          <Button danger block onClick={() => setDeleting(true)}>
            {t('kbDetail.deleteKb')}
          </Button>
        </aside>
      </div>

      <KnowledgeBaseFormModal kb={kb} open={editing} onClose={() => setEditing(false)} />
      <KnowledgeConfigModal kb={kb} open={editingConfig} onClose={() => setEditingConfig(false)} />
      <SearchTestDrawer kbId={kb.id} kbName={kb.name} open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ChunkPreviewDrawer
        kbId={kb.id}
        doc={chunkTarget}
        open={chunkTarget !== null}
        onClose={() => setChunkTarget(null)}
      />
      <UploadDocumentModal
        kbId={kb.id}
        doc={uploadTarget === 'new' ? null : uploadTarget}
        open={uploadTarget !== null}
        multimodalSupported={kb.embeddingMultimodal}
        describeSupported={kb.captionModelId !== null}
        onClose={() => setUploadTarget(null)}
      />
      <DeleteKnowledgeBaseModal
        kb={kb}
        open={deleting}
        onClose={() => setDeleting(false)}
        // 删掉之后停在详情页只会看到 404 ⇒ 把人送回列表（列表的写操作失效会自动重取）。
        // 用 `navigate` 而不是 `window.location.assign`：后者会整页刷新（丢掉 SPA 状态，
        // 也让"删除后回到列表"看起来像一次重新登录）。
        onDeleted={() => {
          setDeleting(false)
          navigate(KNOWLEDGE_PATH)
        }}
      />
    </>
  )
}
