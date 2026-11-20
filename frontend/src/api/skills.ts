/**
 * Skill 接口封装（P1-24a-2）
 *
 * 依据：`docs/子方案/Skill能力.md` §5.1（API 清单）+ §5.2（前端）、
 *      `shared/src/skill.ts`（`SkillItem` / `SkillDetail` / `SkillChange` 等**唯一一套投影**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 信封层级逐一核对过（别照抄知识库）
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/skills` | `{ items, total, offset, limit }` |
 * | `GET /api/skills/:id` | **裸 `SkillDetail`**（含 `files` / `versions` / `changes` / `agentCount`） |
 * | `POST /api/skills`、`POST /:id/import` | `{ skill, version, fileCount, created }` |
 * | `PATCH /api/skills/:id`、`POST /:id/transfer` | **裸 `SkillItem`** |
 * | `DELETE /api/skills/:id` | `{ id, name }` |
 * | `GET /api/skills/:id/file?download=1` | **字节流**（走 `requestBlob`；其余参数回 `SkillFilePreview`） |
 * | `GET /api/skills/:id/file/raw`、`/file/render` | **字节流 / HTML**（预览出口，不套信封） |
 * | `GET /api/skills/:id/download` | **zip 字节流**（整包下载，不套信封） |
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 上传：**新建与重新导入都是 multipart**（字段名 `file`）
 * ─────────────────────────────────────────────────────────────────────
 * 内容只能来自 zip（`PATCH` 不接 markdown / files），所以"新建"也要带包 ——
 * 前端不给"只填元数据"的建法（建出来会是一个没有 `SKILL.md` 的空壳）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 失效范围：`['skills']` 是列表键，`['skills', id]` 是子键
 * ─────────────────────────────────────────────────────────────────────
 * 导入 / 改元数据 / 删除都会改列表与详情两处 ⇒ 一次 `invalidateQueries({ queryKey: SKILLS_QUERY_KEY })`
 * 同时标脏（React Query 按前缀匹配）。写成两个互不相干的键，每个 mutation 都要记得失效两次，迟早漏一个。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ForkSkillBody,
  ImportSkillResult,
  RemoveSkillResult,
  SkillDetail,
  SkillFilePreview,
  SkillItem,
  SkillListResult,
  SkillUpstreamDiff,
  SyncSkillUpstreamBody,
  SyncSkillUpstreamResult,
  TransferAssetBody,
  UpdateSkillBody,
  XmindOutline,
} from '@doubulea/shared'

import { request, requestBlob, requestFormData, type DownloadedFile } from './client.js'

export const SKILLS_QUERY_KEY = ['skills'] as const

/** 详情键（列表键的子键，见文件头 ③） */
export function skillQueryKey(id: string): readonly [string, string] {
  return ['skills', id]
}

/** 上传字段名（与后端 `routes/skills.ts` 的 `readSkillUpload` 同源：`file`） */
export const SKILL_UPLOAD_FIELD = 'file'

/** 新建 / 重新导入的额外表单字段（都可缺省：缺省时由包内 frontmatter 与既有行决定） */
export interface SkillUploadFields {
  runtime?: 'INLINE' | 'SANDBOX'
  name?: string
  description?: string
  visibility?: 'PRIVATE' | 'PUBLIC'
}

/** 列表（`offset/limit/query` 由服务端过滤与分页 —— 关键词也在 SQL 里筛，`total` 才准） */
export function useSkills(params: { offset?: number; limit?: number; query?: string } = {}) {
  const offset = params.offset ?? 0
  const limit = params.limit ?? 100
  const query = params.query?.trim() ?? ''
  return useQuery({
    queryKey: [...SKILLS_QUERY_KEY, 'list', offset, limit, query] as const,
    queryFn: () =>
      request<SkillListResult>(
        `/api/skills?offset=${offset}&limit=${limit}${query === '' ? '' : `&query=${encodeURIComponent(query)}`}`,
      ),
    // 翻页时保留上一页（避免表格闪成骨架）
    placeholderData: keepPreviousData,
  })
}

export function fetchSkill(id: string): Promise<SkillDetail> {
  return request<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`)
}

/** 详情（404 = 不存在或对我不可见，页面据此渲染错误态 + 回列表入口） */
export function useSkill(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: skillQueryKey(id),
    queryFn: () => fetchSkill(id),
    enabled: id !== '' && options.enabled !== false,
  })
}

/** 组表单：zip 是必填，其余字段只在给了值时才进 `FormData` */
function skillFormData(zip: File, fields: SkillUploadFields): FormData {
  const form = new FormData()
  // ⚠️ 顺序无关（后端用 `request.parts()` 逐项消费），但文件先放：大包先开始传
  form.append(SKILL_UPLOAD_FIELD, zip)
  if (fields.runtime !== undefined) form.append('runtime', fields.runtime)
  if (fields.name !== undefined && fields.name.trim() !== '') form.append('name', fields.name.trim())
  if (fields.description !== undefined && fields.description.trim() !== '') {
    form.append('description', fields.description.trim())
  }
  if (fields.visibility !== undefined) form.append('visibility', fields.visibility)
  return form
}

/** 新建（上传 zip） */
export function useCreateSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ zip, fields }: { zip: File; fields: SkillUploadFields }) =>
      requestFormData<ImportSkillResult>('/api/skills', skillFormData(zip, fields)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 重新导入（生成新版本；不覆盖旧对象） */
export function useImportSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, zip, fields }: { id: string; zip: File; fields: SkillUploadFields }) =>
      requestFormData<ImportSkillResult>(`/api/skills/${encodeURIComponent(id)}/import`, skillFormData(zip, fields)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 改元数据（名称 / 描述 / 可见范围；不动文件） */
export function useUpdateSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateSkillBody }) =>
      request<SkillItem>(`/api/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 软删（被 Agent 绑定时 409：`describeError` 会把服务端文案原样端出来） */
export function useRemoveSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RemoveSkillResult>(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/**
 * 复制为我的 Skill（P1-24c-5；界面不叫 Fork）。
 *
 * 成功后新副本出现在「我的 Skills」；调用方负责跳转到副本详情。
 */
export function useForkSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: ForkSkillBody }) =>
      request<SkillItem>(`/api/skills/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 副本的上游差异（只读；`fromVersion` 缺省 = 副本的 `parentVersion`） */
export function fetchSkillUpstreamDiff(
  id: string,
  params: { fromVersion?: number } = {},
): Promise<SkillUpstreamDiff> {
  const search = new URLSearchParams()
  if (params.fromVersion !== undefined) search.set('fromVersion', String(params.fromVersion))
  const query = search.toString()
  return request<SkillUpstreamDiff>(
    `/api/skills/${encodeURIComponent(id)}/upstream-diff${query === '' ? '' : `?${query}`}`,
  )
}

export function useSkillUpstreamDiff(id: string, enabled = true) {
  return useQuery({
    queryKey: [...skillQueryKey(id), 'upstream-diff'] as const,
    queryFn: () => fetchSkillUpstreamDiff(id),
    enabled: enabled && id !== '',
    retry: false,
  })
}

/** 同步上游（仅 fast-forward；有本地改动时服务端 409，不覆盖） */
export function useSyncSkillUpstream() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SyncSkillUpstreamBody }) =>
      request<SyncSkillUpstreamResult>(`/api/skills/${encodeURIComponent(id)}/sync-upstream`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 转移所属人 */
export function useTransferSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, toUserId }: { id: string } & TransferAssetBody) =>
      request<SkillItem>(`/api/skills/${encodeURIComponent(id)}/transfer`, {
        method: 'POST',
        body: { toUserId },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 单文件预览用原始字节的 URL（图片 / PDF / HTML / SVG 直接交给浏览器渲染） */
export function skillFileRawUrl(id: string, params: { path: string; version?: number }): string {
  const search = new URLSearchParams({ path: params.path })
  if (params.version !== undefined) search.set('version', String(params.version))
  return `/api/skills/${encodeURIComponent(id)}/file/raw?${search.toString()}`
}

/** XMIND 解成大纲 JSON 的 URL（前端 `XmindOutlinePreview` 画树） */
export function skillFileOutlineUrl(id: string, params: { path: string; version?: number }): string {
  const search = new URLSearchParams({ path: params.path })
  if (params.version !== undefined) search.set('version', String(params.version))
  return `/api/skills/${encodeURIComponent(id)}/file/outline?${search.toString()}`
}

/** 取回 xmind 的大纲（`GET /api/skills/:id/file/outline`，2026-11-20） */
export function fetchSkillFileOutline(
  id: string,
  params: { path: string; version?: number; signal?: AbortSignal },
): Promise<XmindOutline> {
  return request<XmindOutline>(
    skillFileOutlineUrl(id, params),
    params.signal === undefined ? {} : { signal: params.signal },
  )
}

/** DOCX / XLSX 渲染成 HTML 的 URL */
export function skillFileRenderUrl(id: string, params: { path: string; version?: number }): string {
  const search = new URLSearchParams({ path: params.path })
  if (params.version !== undefined) search.set('version', String(params.version))
  return `/api/skills/${encodeURIComponent(id)}/file/render?${search.toString()}`
}

/** 取原始字节（文本预览由调用方按 UTF-8 解码；失败走统一信封） */
export function fetchSkillFileRaw(
  id: string,
  params: { path: string; version?: number; signal?: AbortSignal },
): Promise<DownloadedFile> {
  return requestBlob(skillFileRawUrl(id, params), params.signal === undefined ? {} : { signal: params.signal })
}

/** 整包 zip 下载（与上传同形态） */
export function downloadSkillArchive(id: string, version?: number): Promise<DownloadedFile> {
  const search = new URLSearchParams()
  if (version !== undefined) search.set('version', String(version))
  const query = search.toString()
  return requestBlob(`/api/skills/${encodeURIComponent(id)}/download${query === '' ? '' : `?${query}`}`)
}

/** 单文件预览（文本按码点分页；二进制后端回 400 与原因，界面据此给下载入口） */
export function fetchSkillFile(
  id: string,
  params: { path: string; version?: number; offset?: number; limit?: number },
): Promise<SkillFilePreview> {
  const search = new URLSearchParams({ path: params.path })
  if (params.version !== undefined) search.set('version', String(params.version))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  return request<SkillFilePreview>(`/api/skills/${encodeURIComponent(id)}/file?${search.toString()}`)
}

/** 单文件下载（字节流；`download=1` 是本仓第二个不套信封的端点） */
export function downloadSkillFile(
  id: string,
  params: { path: string; version?: number },
): Promise<DownloadedFile> {
  const search = new URLSearchParams({ path: params.path, download: '1' })
  if (params.version !== undefined) search.set('version', String(params.version))
  return requestBlob(`/api/skills/${encodeURIComponent(id)}/file?${search.toString()}`)
}

/** 浏览器侧触发一次 Blob 下载（与产物 / 文档下载同一套做法：临时 `<a>` + `URL.revokeObjectURL`） */
export function saveDownloadedFile(file: DownloadedFile, fallbackName: string): void {
  const url = URL.createObjectURL(file.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.fileName ?? fallbackName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
