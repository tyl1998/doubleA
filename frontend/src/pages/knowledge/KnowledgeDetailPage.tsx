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

import { Alert, Button, Tag } from 'antd'
import type { DocumentItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../../api/client.js'
import {
  DOCUMENTS_PAGE_LIMIT_MAX,
  useDocuments,
  useKnowledgeBase,
} from '../../api/knowledgeBases.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { KNOWLEDGE_PATH } from '../../app/paths.js'
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

  const kbQuery = useKnowledgeBase(id)
  const documentsQuery = useDocuments(id, { offset: 0, limit: DOCUMENTS_PAGE_LIMIT_MAX })

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
  const notice = kb === undefined ? null : embeddingChangedNotice(kb.embeddingModelChanged)

  const crumb = (
    <nav className="crumb" aria-label="面包屑">
      <Link to={KNOWLEDGE_PATH}>知识库</Link>
      <span className="crumb__sep" aria-hidden="true">
        /
      </span>
      <span className="crumb__here">{kb?.name ?? '详情'}</span>
    </nav>
  )

  // ── 三态：加载 / 失败（404 单独一档） / 正常 ──────────────────────────────

  if (kbQuery.isPending) {
    return (
      <>
        {crumb}
        <div className="page__head">
          <div>
            <h1>知识库</h1>
            <p className="page__lead">正在读取知识库…</p>
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
        {crumb}
        <div className="page__head">
          <div>
            <h1>{notFound ? '知识库不存在' : '知识库加载失败'}</h1>
          </div>
        </div>
        {notFound ? (
          <div className="card">
            <EmptyState
              title="这个知识库不存在或已被删除"
              lead="地址里的 id 可能写错了，也可能是别的用户刚刚把它删掉了。知识库是共享资源，任何登录用户都能删除它。"
              action={
                <div className="row" style={{ gap: 'var(--sp-3)' }}>
                  <Link to={KNOWLEDGE_PATH}>
                    <Button type="primary">回到知识库列表</Button>
                  </Link>
                  <Button
                    onClick={() => {
                      void kbQuery.refetch()
                    }}
                    loading={kbQuery.isFetching}
                  >
                    重试
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <ErrorState
            title="知识库加载失败"
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
      {crumb}

      <div className="page__head">
        <div>
          <h1>
            {kb.name}{' '}
            <span className="kicker" title="建库时快照的 embedding 模型">
              {kb.embeddingModel}
            </span>
          </h1>
          <p className="page__lead">
            {kb.description === null || kb.description === '' ? '（没有描述）' : kb.description}
          </p>
          <p className="ratio">
            文档 <span className="num">{kb.documentCount}</span> 篇 · 被{' '}
            <span className="num">{kb.agentCount}</span> 个智能体引用 · {describeRetrieval(kb.retrievalConfig)}
          </p>
        </div>
        <div className="page__head-actions">
          <Button onClick={() => setSearchOpen(true)}>检索测试</Button>
          <Button onClick={() => setEditing(true)}>编辑</Button>
          <Button type="primary" onClick={() => setUploadTarget('new')}>
            上传文档
          </Button>
        </div>
      </div>

      <div className="split split--form">
        <div className="stack">
          {notice !== null && <Alert type={notice.tone === 'warn' ? 'warning' : 'info'} showIcon message={notice.text} />}

          <div className="card">
            <div className="card__head">
              <p className="card__title">文档</p>
              <div className="card__head-right">
                <span className="ratio">
                  解析中 <span className="num">{summary.parsing}</span> · 失败{' '}
                  <span className="num">{summary.failed}</span>
                </span>
              </div>
            </div>

            {documentsQuery.isPending ? (
              <TableSkeleton rows={4} />
            ) : documentsQuery.isError ? (
              <div style={{ padding: 'var(--sp-5)' }}>
                <ErrorState
                  title="文档列表加载失败"
                  error={documentsQuery.error}
                  retrying={documentsQuery.isFetching}
                  onRetry={() => {
                    void documentsQuery.refetch()
                  }}
                />
              </div>
            ) : documents.length === 0 ? (
              <EmptyState
                title="这个库里还没有文档"
                lead="上传 md / pdf / docx / txt：上传后由后台流水线解析、分块并生成向量，完成后才能被检索到。"
                action={
                  <Button type="primary" onClick={() => setUploadTarget('new')}>
                    上传文档
                  </Button>
                }
              />
            ) : (
              <DocumentTable
                kbId={kb.id}
                documents={documents}
                onReupload={(doc) => setUploadTarget(doc)}
                onPreviewChunks={(doc) => setChunkTarget(doc)}
              />
            )}

            {documents.length > 0 && (
              <p className="ratio" style={{ padding: '0 var(--sp-5) var(--sp-5)' }}>
                共 <span className="num">{documentTotal}</span> 篇
                {documentTotal > documents.length && (
                  <>
                    ，本次取回前 <span className="num">{documents.length}</span> 篇（<code>limit</code> 上限 100）
                  </>
                )}
                {summary.parsing > 0 && (
                  <>
                    ；本页有 <span className="num">{summary.parsing}</span> 篇正在解析，状态每{' '}
                    <span className="num">{DOCUMENT_POLL_INTERVAL_MS / 1000}</span> 秒自动刷新（全部解析完即停）
                  </>
                )}
              </p>
            )}
          </div>

          <div className="card">
            <div className="card__head">
              <p className="card__title">检索配置</p>
              <div className="card__head-right">
                {/* ⚠️ 原型这里挂的是"不落库 · 每次请求传入"——**反了**（那句描述的是检索测试
                    抽屉的参数）。库级配置改了就是落库、对所有人的检索都生效。 */}
                <Tag>落库 · 对这个库的所有检索生效</Tag>
                <Button size="small" onClick={() => setEditingConfig(true)}>
                  编辑配置
                </Button>
              </div>
            </div>
            <div className="card__body stack stack--tight">
              <p className="num">{describeRetrieval(kb.retrievalConfig)}</p>
              <p className="num">{describeChunking(kb)}</p>
              <p className="ratio">
                分块与检索口径是这个库的属性；「检索测试」里的 mode / topK 只是那一次试查的覆盖，
                不落库，也不影响这里。
              </p>
            </div>
          </div>
        </div>

        <aside className="stack stack--tight aside-card">
          <div className="card bracket card--pad">
            <p className="kicker">体量</p>
            <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
              <div className="summary-row">
                <span className="summary-row__label">文档（权威）</span>
                <span className="num">{kb.documentCount}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">可检索（本页）</span>
                <span className="num">{summary.readable}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">解析中（本页）</span>
                <span className="num">{summary.parsing}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">失败（本页）</span>
                <span className="num">{summary.failed}</span>
              </div>
              <div className="summary-row">
                <span className="summary-row__label">引用它的智能体</span>
                <span className="num">{kb.agentCount}</span>
              </div>
            </div>
            {/* "片段总数"与"向量维度"两个数字在原型上有，本仓**取不到**（没有任何端点给它们），
                所以这里不放 —— 编一个出来就是造假数据（`03` §七）。 */}
            <p className="ratio" style={{ marginTop: 'var(--sp-5)' }}>
              只有"文档"是服务端 count 出来的权威值；三个"（本页）"是当前这一页的分布。
            </p>
            {kb.agentCount > 0 && (
              <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
                被智能体引用时删除会返回 409：先去智能体编辑页解绑。
              </p>
            )}
          </div>

          <div className="card card--flat card--pad">
            <p className="kicker">解析失败怎么看</p>
            <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
              扫描件、加密 PDF、纯图片文档都会落在「失败」，表格里直接给出原因与「重试」。
              上传后有一段检索空窗（旧片段先删后建），期间显示「更新中，暂不参与检索」。
            </p>
          </div>

          <Button danger block onClick={() => setDeleting(true)}>
            删除这个知识库
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
