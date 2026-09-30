/**
 * 知识库接口封装（P0-1-31 只落地读取侧；**P0-1-35 补全读写两侧**）
 *
 * 依据：`docs/02-后端设计.md` §4.6（知识库 + 文档 + 检索三张端点表与权限）、
 *      `docs/03-前端设计.md` §4.3（详情页与文档表格）、§七（删除分级确认、列表三态）、
 *      `shared/src/knowledgeBase.ts` + `shared/src/document.ts`（**唯一一套投影**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 信封层级逐个核对过，别照抄邻居
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/knowledge-bases` | `{ items, total, offset, limit }` |
 * | `GET/POST/PATCH /api/knowledge-bases[/:id]` | **裸 `KnowledgeBaseItem`** |
 * | `DELETE /api/knowledge-bases/:id` | `{ id, name, deletedDocuments, deletedObjects }` |
 * | `GET .../documents` | `{ items, total, offset, limit }`（每项 = `DocumentItem`） |
 * | `POST .../documents` | `{ document, deduplicated }` |
 * | `POST .../reupload` | `{ document, unchanged }` |
 * | `POST .../retry` | `{ document }` |
 * | `DELETE .../documents/:docId` | `{ id, fileName, deletedChunks }` |
 * | `POST .../search` | `{ items, mode, topK, rrfK, candidatePool, elapsedMs, vectorPathSkipped, warnings }` |
 * | `GET .../documents/:docId/chunks` | `{ items, total, offset, limit }`（每项 = `ChunkItem`） |
 * | `GET .../download` | **字节流**（本仓唯一不套信封的端点，见 `api/client.ts#requestBlob`） |
 *
 * 本仓**刻意四族权限、四种信封形态各不相同**（`docs/06` §六 第 ⑭ 条）：把 `{items}` 类推到
 * 别处会**安静地拿到 `null`**，一路带到下一个请求才炸。上面每一行都对着 `shared` 的 schema 抄。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 权限口径：**登录即可**，不是 ADMIN（与模型池相反）
 * ─────────────────────────────────────────────────────────────────────
 * `/api/knowledge-bases/*` 全部只挂 `requireAuth`（`backend/src/routes/knowledgeBases.ts` 文件头）。
 * 照抄模型池的 `requireAdmin` 会把普通用户的知识库页变成空的。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 失效范围：一次写操作要动的**三个**视图
 * ─────────────────────────────────────────────────────────────────────
 * `['knowledge-bases']` 是列表键，**详情键 `['knowledge-bases', id]` 与文档键
 * `['knowledge-bases', id, 'documents', …]` 都是它的子键** ⇒ 一次 `invalidateQueries` 会同时
 * 标脏三处。这不是巧合：上传/删除文档会改 `documentCount`（列表与详情都显示它），
 * 改名会改列表行与详情标题，而文档表格自己也要重拉。写成三个互不相干的键，
 * 就得在每个 mutation 里记得失效三次（迟早漏一个，症状是"列表更新了、详情还是旧的"）。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UPLOAD_FILE_FIELD, UPLOAD_IMAGE_MODE_FIELD } from '@doubulea/shared'
import type {
  CreateKnowledgeBaseBody,
  DocumentChunkListResult,
  DocumentItem,
  DocumentListResult,
  ImageMode,
  KnowledgeBaseItem,
  KnowledgeBaseListResult,
  RemoveDocumentResult,
  RemoveKnowledgeBaseResult,
  ReuploadDocumentResult,
  RetryDocumentResult,
  SearchKnowledgeBaseBody,
  SearchKnowledgeBaseResult,
  UpdateKnowledgeBaseBody,
  UploadDocumentResult,
} from '@doubulea/shared'

import { request, requestBlob, requestFormData } from './client.js'
import { documentRefetchInterval } from '../pages/knowledge/knowledgeModel.js'

export const KNOWLEDGE_BASES_QUERY_KEY = ['knowledge-bases'] as const

/** 详情键（列表键的子键，见文件头 ③） */
export function knowledgeBaseQueryKey(id: string): readonly [string, string] {
  return ['knowledge-bases', id] as const
}

/** 文档列表键（同上） */
export function documentsQueryKey(kbId: string): readonly [string, string, string] {
  return ['knowledge-bases', kbId, 'documents'] as const
}

/** 多选框要"列出全部 KB" ⇒ 直接取 `limit` 的上限（100，与 `listKnowledgeBasesQuerySchema` 同源） */
export const KNOWLEDGE_BASES_PICKER_LIMIT = 100

/** 文档一次取满一页（= `listDocumentsQuerySchema` 的 `limit` 上限 100，同源） */
export const DOCUMENTS_PAGE_LIMIT_MAX = 100

/**
 * 读取知识库列表。排序由后端定（`createdAt asc`，`docs/02` §4.6 的列表口径）——
 * 前端**不再排一次**，否则同一个列表在两处各有一个顺序，迟早对不上。
 */
export function useKnowledgeBases(limit: number = KNOWLEDGE_BASES_PICKER_LIMIT) {
  return useQuery({
    queryKey: [...KNOWLEDGE_BASES_QUERY_KEY, 'list', 0, limit] as const,
    queryFn: () => request<KnowledgeBaseListResult>(`/api/knowledge-bases?offset=0&limit=${limit}`),
  })
}

export function fetchKnowledgeBase(id: string): Promise<KnowledgeBaseItem> {
  return request<KnowledgeBaseItem>(`/api/knowledge-bases/${encodeURIComponent(id)}`)
}

/**
 * 读单个知识库（详情页用）。
 *
 * ⚠️ **不设 `enabled`**：详情的 id 是路由参数，`/knowledge/:id` 下它一定存在。
 * 库被删（或 id 写错）时后端回 **404**，页面对此显式渲染错误态 + 回列表的入口
 * —— 而不是"空页面转圈"。
 */
export function useKnowledgeBase(id: string) {
  return useQuery({
    queryKey: knowledgeBaseQueryKey(id),
    queryFn: () => fetchKnowledgeBase(id),
  })
}

/** 一次写操作后要失效的全部视图（见文件头 ③） */
function invalidateKnowledgeViews(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: KNOWLEDGE_BASES_QUERY_KEY })
}

export function useCreateKnowledgeBase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateKnowledgeBaseBody) =>
      request<KnowledgeBaseItem>('/api/knowledge-bases', { method: 'POST', body }),
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

/**
 * 部分更新（`PATCH`）。**三态与"只发改了的字段"由调用方在 body 里构造**
 * （`pages/knowledge/knowledgeModel.ts#buildKnowledgeUpdateBody`）——
 * 本函数不做任何裁剪，避免"api 层悄悄补了个默认值"这种难查的改动。
 */
export function useUpdateKnowledgeBase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateKnowledgeBaseBody }) =>
      request<KnowledgeBaseItem>(`/api/knowledge-bases/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

/**
 * 删库（连带 `documents` / `chunks` / S3 原文件；**被智能体绑定时 409**）。
 *
 * 409 不是异常路径而是**一条需要界面上有出路的状态**：`agentCount > 0` 时后端拒绝删除，
 * 提示要指向"先去智能体编辑页解绑"（`docs/03` §4.3 的右侧摘要卡就写着这句话）。
 */
export function useRemoveKnowledgeBase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RemoveKnowledgeBaseResult>(`/api/knowledge-bases/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

// ───────────────────────────── 文档 ─────────────────────────────

export interface ListDocumentsParams {
  offset?: number
  limit?: number
}

export function fetchDocuments(kbId: string, params: ListDocumentsParams = {}): Promise<DocumentListResult> {
  const offset = params.offset ?? 0
  const limit = params.limit ?? DOCUMENTS_PAGE_LIMIT_MAX
  return request<DocumentListResult>(
    `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents?offset=${offset}&limit=${limit}`,
  )
}

/**
 * 文档列表 + **状态轮询**（`06` P0-1-35 的坑预判：`PARSING` 中的文档必须自己刷新，
 * 不能只靠手动）。
 *
 * 轮询判据在 `knowledgeModel.ts#documentRefetchInterval`（**纯函数**，被无依赖验收档断言）：
 * 有 `PARSING` ⇒ 每 2s 一次；全部终态 ⇒ `false`（**终止条件**，否则页面会永远每 2s 打一次后端）。
 *
 * ⚠️ 两个如实写明的边界：
 *   · TanStack Query 默认**后台标签页不轮询**（`refetchIntervalInBackground: false`）
 *     —— 切回来时会立刻重取一次，行为正确；
 *   · 轮询只看**当前这一页**的条目（本页一次取满 100 条）。若 `PARSING` 的那篇在下一页，
 *     这一页不会因为"库里还有文档在解析"而空转 —— 那是刻意的：轮询的触发源只能是
 *     "屏幕上有一个正在转的状态灯"。
 */
export function useDocuments(kbId: string, params: ListDocumentsParams = {}) {
  return useQuery({
    queryKey: [...documentsQueryKey(kbId), params.offset ?? 0, params.limit ?? DOCUMENTS_PAGE_LIMIT_MAX] as const,
    queryFn: () => fetchDocuments(kbId, params),
    refetchInterval: (query) => documentRefetchInterval(query.state.data?.items),
    placeholderData: keepPreviousData,
  })
}

// ───────────────────────────── 片段预览 ─────────────────────────────

/**
 * 一次取回的片段数（= `listDocumentChunksQuerySchema` 的默认 `limit`，两处同源）。
 *
 * 比文档列表的一次取满（100）小得多：一个块的内容可上千字符，一屏放不下几条；
 * 抽屉里用分页器翻，`total` 由后端如实给出。
 */
export const CHUNKS_PAGE_LIMIT = 20

/** 片段预览键（带 `docId` 与分页，避免不同文档/页互相串缓存） */
export function documentChunksQueryKey(
  kbId: string,
  docId: string,
  offset: number,
  limit: number,
): readonly [string, string, string, string, string, number, number] {
  return ['knowledge-bases', kbId, 'documents', docId, 'chunks', offset, limit] as const
}

export interface ListDocumentChunksParams {
  offset?: number
  limit?: number
}

export function fetchDocumentChunks(
  kbId: string,
  docId: string,
  params: ListDocumentChunksParams = {},
): Promise<DocumentChunkListResult> {
  const offset = params.offset ?? 0
  const limit = params.limit ?? CHUNKS_PAGE_LIMIT
  return request<DocumentChunkListResult>(
    `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}` +
      `/chunks?offset=${offset}&limit=${limit}`,
  )
}

/**
 * 读某篇文档的片段（按 `seq` 升序分页）。
 *
 * ⚠️ **必须显式 `enabled`**：抽屉是常驻挂载的（打开/关闭只切 `open`），而关闭时没有目标文档
 * —— 不给 `enabled` 会在抽屉从未打开过时也发一次请求（`docId` 还是个空串）。
 * 片段是**已入库的静态内容**（覆盖重建会清空重来），不做轮询：打开时取一次、翻页时再取即可。
 */
export function useDocumentChunks(
  kbId: string,
  docId: string,
  params: ListDocumentChunksParams = {},
  enabled = true,
) {
  const offset = params.offset ?? 0
  const limit = params.limit ?? CHUNKS_PAGE_LIMIT
  return useQuery({
    queryKey: documentChunksQueryKey(kbId, docId, offset, limit),
    queryFn: () => fetchDocumentChunks(kbId, docId, params),
    enabled: enabled && docId !== '',
    placeholderData: keepPreviousData,
  })
}

/** 上传一个文档（单文件，字段名 `file`；成功是 `PARSING`，真正的解析由 worker 异步完成） */
export function useUploadDocument(kbId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, imageMode }: { file: File; imageMode: ImageMode }) => {
      const formData = new FormData()
      formData.append(UPLOAD_FILE_FIELD, file)
      formData.append(UPLOAD_IMAGE_MODE_FIELD, imageMode)
      return requestFormData<UploadDocumentResult>(
        `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`,
        formData,
      )
    },
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

/** 覆盖重建（同一篇文档换内容）；`unchanged: true` 表示内容没变、**什么都没做** */
export function useReuploadDocument(kbId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ docId, file, imageMode }: { docId: string; file: File; imageMode: ImageMode }) => {
      const formData = new FormData()
      formData.append(UPLOAD_FILE_FIELD, file)
      formData.append(UPLOAD_IMAGE_MODE_FIELD, imageMode)
      return requestFormData<ReuploadDocumentResult>(
        `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/reupload`,
        formData,
      )
    },
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

/** 重新入队（`FAILED` 与 `PARSING` 都放行；`READY` 会拿 409 —— 界面据此禁用按钮） */
export function useRetryDocument(kbId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (docId: string) =>
      request<RetryDocumentResult>(
        `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/retry`,
        { method: 'POST' },
      ),
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

/** 删除文档（连带 chunk 与 S3 原文件），响应带 `deletedChunks` 供成功提示使用 */
export function useRemoveDocument(kbId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (docId: string) =>
      request<RemoveDocumentResult>(
        `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateKnowledgeViews(queryClient),
  })
}

/**
 * 上传/覆盖重建共用的文件字段名。
 *
 * ⚠️ **直接复用 `shared` 的常量**（`UPLOAD_FILE_FIELD = 'file'`）而不是在这里写一个字面量：
 * 后端 `routes/documents.ts` 的 `request.file()` 读的就是同一个常量，写两份的话
 * "字段名改一次"就变成了两处要一起改的事，而改漏的症状是**上传静默 400**
 * （"没有收到文件：请用 multipart/form-data 上传，文件字段名为 file"）。
 */

/**
 * 触发浏览器下载。**不走 `<a href>` 直链**（那样失败会渲染一页 JSON，见 `api/client.ts#requestBlob`）。
 *
 * 文件名优先用响应头的（RFC 5987 的中文名），解析不出时退回文档自己的 `fileName`
 * —— 两个来源是同一份数据，后者还是列表页正在显示的那个名字。
 */
export async function saveDocumentFile(kbId: string, doc: Pick<DocumentItem, 'id' | 'fileName'>): Promise<void> {
  const { blob, fileName } = await requestBlob(
    `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(doc.id)}/download`,
  )
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName ?? doc.fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立刻释放：blob 已经被浏览器接管（下载不依赖这个 URL 活着），不释放会一直占着内存
  URL.revokeObjectURL(url)
}

// ───────────────────────────── 检索测试 ─────────────────────────────

/**
 * 检索测试（`POST /:id/search`）。
 *
 * 用 `useMutation` 而不是 `useQuery`：它是"按一次查一次"的动作，`query` 的键要包含
 * 整个请求体（每个字都变成一个缓存项），而结果没有复用的价值。用 mutation 也让
 * "上一次的结果"天然留在组件里，用户可以对着它改参数再跑。
 *
 * ⚠️ `mode` / `topK` 只是**这一次请求**的覆盖，**不落库**（`docs/02` §4.6 的检索行）——
 * 界面上绝不能把它说成"已保存的配置"。
 */
export function useSearchKnowledgeBase(kbId: string) {
  return useMutation({
    mutationFn: (body: SearchKnowledgeBaseBody) =>
      request<SearchKnowledgeBaseResult>(`/api/knowledge-bases/${encodeURIComponent(kbId)}/search`, {
        method: 'POST',
        body,
      }),
  })
}
