/**
 * Skill 草稿接口封装（P1-24c-1）
 *
 * 依据：`docs/子方案/会话生成Skill.md` §五 / §六 / §八、`shared/src/skill.ts` 的草稿段。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径（照抄知识库 / Skill 管理面会错的地方）
 * ─────────────────────────────────────────────────────────────────────
 * ① **信封层级**：草稿端点回的都是**裸 `SkillDraft`**（没有 `{ draft }` 包装）；
 *    保存入口回 `{ skill, version, fileCount, bindError }`。
 * ② **上传只有一个文件字段**（`file`）+ 可选 `path`：与 `requestFormData` 的约定一致，
 *    `content-type` 绝不手写（boundary 由浏览器填）。
 * ③ **保存只发 `draftId` + 展示元数据 + 脱敏确认后的正文**：文件清单永远从服务端草稿读
 *    （`files` / `storageKey` 发出去也会被服务端剥掉，见 `shared` 的同名 schema 注释）。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SKILL_ENTRY_PATH } from '@doubulea/shared'
import type {
  CreateSkillDraftBody,
  SaveSkillFromDraftBody,
  SaveSkillFromDraftResult,
  SaveSkillRevisionFromDraftBody,
  SkillChange,
  SkillDetail,
  SkillDraft,
  SkillDraftFile,
  SkillDraftListResult,
  SkillVersion,
  UpdateSkillDraftBody,
} from '@doubulea/shared'

import { request, requestFormData } from './client.js'
import { SKILLS_QUERY_KEY, skillQueryKey } from './skills.js'

export const SKILL_DRAFTS_QUERY_KEY = ['skill-drafts'] as const

export function skillDraftQueryKey(draftId: string): readonly [string, string] {
  return ['skill-drafts', draftId]
}

/** 上传字段名（与 `routes/skillDrafts.ts#readDraftUpload` 同源） */
export const SKILL_DRAFT_UPLOAD_FIELD = 'file'

/** 我的草稿列表（提示卡关闭 / 重新进会话后仍能找回未保存的草稿） */
export function useSkillDrafts() {
  return useQuery({
    queryKey: [...SKILL_DRAFTS_QUERY_KEY, 'list'] as const,
    queryFn: () => request<SkillDraftListResult>('/api/skill-drafts'),
    refetchOnWindowFocus: true,
  })
}

/** 新建草稿（JSON） */
export function useCreateSkillDraft() {
  return useMutation({
    mutationFn: (body: CreateSkillDraftBody) => request<SkillDraft>('/api/skill-drafts', { method: 'POST', body }),
  })
}

/** 读草稿（打开审核页即续期；`placeholderData` 让自动保存期间的闪烁消失） */
export function useSkillDraft(draftId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: skillDraftQueryKey(draftId),
    queryFn: () => request<SkillDraft>(`/api/skill-drafts/${encodeURIComponent(draftId)}`),
    enabled: draftId !== '' && options.enabled !== false,
    placeholderData: keepPreviousData,
    // 草稿是会过期的临时资源：窗口重新获得焦点时刷新一次（过期 ⇒ 404 ⇒ 页面转错误态）
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** 自动保存（返回的草稿覆盖缓存，避免下一次轮询把旧内容写回去） */
export function useUpdateSkillDraft(draftId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateSkillDraftBody) =>
      request<SkillDraft>(`/api/skill-drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body }),
    onSuccess: (draft) => {
      queryClient.setQueryData(skillDraftQueryKey(draftId), draft)
    },
  })
}

/** 丢弃草稿 */
export function useDeleteSkillDraft() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draftId: string) =>
      request<{ id: string }>(`/api/skill-drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }),
    onSuccess: (result) => {
      queryClient.removeQueries({ queryKey: skillDraftQueryKey(result.id) })
      void queryClient.invalidateQueries({ queryKey: [...SKILL_DRAFTS_QUERY_KEY, 'list'] })
    },
  })
}

/** 上传一个草稿文件（multipart：`file` + 可选 `path` + 可选 `replace`） */
export function useUploadSkillDraftFile(draftId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { file: File; path?: string; replace?: boolean }) => {
      const form = new FormData()
      form.append(SKILL_DRAFT_UPLOAD_FIELD, input.file)
      if (input.path !== undefined && input.path.trim() !== '') form.append('path', input.path.trim())
      if (input.replace === true) form.append('replace', '1')
      return requestFormData<{ draft: SkillDraft; file: SkillDraftFile }>(
        `/api/skill-drafts/${encodeURIComponent(draftId)}/files`,
        form,
      )
    },
    onSuccess: (result) => {
      queryClient.setQueryData(skillDraftQueryKey(draftId), result.draft)
    },
  })
}

/** 移除一个草稿文件 / 目录（`recursive=true` = 按目录前缀批量删；基准文件只加墓碑） */
export function useRemoveSkillDraftFile(draftId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: string | { path: string; recursive?: boolean }) => {
      const path = typeof input === 'string' ? input : input.path
      const recursive = typeof input === 'string' ? false : input.recursive === true
      const query = `path=${encodeURIComponent(path)}${recursive ? '&recursive=1' : ''}`
      return request<SkillDraft>(`/api/skill-drafts/${encodeURIComponent(draftId)}/files?${query}`, {
        method: 'DELETE',
      })
    },
    onSuccess: (draft) => {
      queryClient.setQueryData(skillDraftQueryKey(draftId), draft)
    },
  })
}

/** 新建 / 修改一个文本文件（P1-24a-7：`PUT /files/content`，JSON） */
export function useWriteSkillDraftFileContent(draftId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { path: string; text: string }) =>
      request<{ draft: SkillDraft; file: SkillDraftFile }>(
        `/api/skill-drafts/${encodeURIComponent(draftId)}/files/content`,
        { method: 'PUT', body: input },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(skillDraftQueryKey(draftId), result.draft)
    },
  })
}

/** 重命名 / 移动文件或目录（P1-24a-7：`POST /files/rename`） */
export function useRenameSkillDraftPath(draftId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { from: string; to: string; kind: 'FILE' | 'DIR'; overwrite?: boolean }) =>
      request<SkillDraft>(`/api/skill-drafts/${encodeURIComponent(draftId)}/files/rename`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (draft) => {
      queryClient.setQueryData(skillDraftQueryKey(draftId), draft)
    },
  })
}

/** 单文件预览（文本全文 / 二进制元信息；草稿文件不分页 —— 用户要看到全文才好改） */
export function fetchSkillDraftFile(
  draftId: string,
  path: string,
): Promise<{ path: string; mime: string; size: number; sha256: string; kind: 'TEXT' | 'BINARY'; text: string | null }> {
  return request(
    `/api/skill-drafts/${encodeURIComponent(draftId)}/files?path=${encodeURIComponent(path)}`,
  )
}

/**
 * 从草稿保存成 Skill（`POST /api/skills/from-draft`）。
 *
 * `bindError !== null` ⇒ **保存成功、绑定失败**：界面要如实分开说（不要让用户以为要重试整件事）。
 */
export function useSaveSkillFromDraft() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SaveSkillFromDraftBody) =>
      request<SaveSkillFromDraftResult>('/api/skills/from-draft', { method: 'POST', body }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: skillQueryKey(result.skill.id) })
      queryClient.removeQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

/** 草稿落成新版本（`POST /api/skills/:id/revisions/from-draft`；`fromVersion` 是乐观锁） */
export function useSaveSkillRevisionFromDraft(skillId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SaveSkillRevisionFromDraftBody) =>
      request<SaveSkillFromDraftResult>(`/api/skills/${encodeURIComponent(skillId)}/revisions/from-draft`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: skillQueryKey(skillId) })
      queryClient.removeQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

/** 详情页正文编辑的发布入参（P1-24a-5）：内容 + 元数据一次生成 vN+1 */
export interface PublishSkillEditsInput {
  skill: SkillDetail
  metadata: {
    name: string
    description: string
    visibility: 'PRIVATE' | 'PUBLIC'
  }
  /** `SKILL.md` 正文（可以是带 frontmatter 的原文；服务端会剥离后按 DB 字段重生成） */
  markdown: string
  changeSummary: string
  /** `SKILL.md` 之外的文本文件（新增 / 修改）：路径与 UTF-8 正文 */
  textFiles: readonly { path: string; text: string }[]
  /** 二进制文件只允许**整文件替换**（路径不变） */
  binaryFiles: readonly { path: string; file: File }[]
  /** 重命名 / 移动（P1-24a-7：详情页树右键；按顺序在删除之前回放） */
  renames?: readonly { from: string; to: string; kind: 'FILE' | 'DIR' }[]
  /** 删除（P1-24a-7：草稿里只加墓碑，旧版本对象不动） */
  removals?: readonly string[]
}

/** 往已存在的草稿里传一个文件（文件级发布不经过 Upload 组件） */
async function uploadSkillEditFile(draftId: string, path: string, file: File): Promise<void> {
  const form = new FormData()
  form.append(SKILL_DRAFT_UPLOAD_FIELD, file)
  form.append('path', path)
  form.append('replace', '1')
  await requestFormData<{ draft: SkillDraft; file: SkillDraftFile }>(
    `/api/skill-drafts/${encodeURIComponent(draftId)}/files`,
    form,
  )
}

/**
 * 详情页「保存」发布新版本（P1-24a-5）。
 *
 * 口径：**不新增第二套写入器** —— 编排现有草稿链（建 REVISION 草稿 → 上传改动文件 →
 * `revisions/from-draft`），内容校验 / 脱敏闸门 / 整版合并 / CAS 全部沿用 c-1。
 * 元数据（名称 / 描述在草稿里，可见范围随保存请求）与新版本同一次发布。
 */
export function usePublishSkillEdits() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: PublishSkillEditsInput): Promise<SaveSkillFromDraftResult> => {
      const draft = await request<SkillDraft>('/api/skill-drafts', {
        method: 'POST',
        body: {
          kind: 'REVISION',
          targetSkillId: input.skill.id,
          baseVersion: input.skill.version,
          name: input.metadata.name.trim(),
          description: input.metadata.description.trim(),
          runtime: input.skill.runtime ?? 'INLINE',
          requiresBins: input.skill.requiresBins,
          markdown: input.markdown,
        } satisfies CreateSkillDraftBody,
      })
      try {
        // ⚠️ 回放顺序（2026-11-19）：**改名 → 落文件 → 删墓碑**。
        //    改名端点会"把源对象搬到新路径"，源可以是基准文件；先落文件再改名，
        //    "新建 A 再改名 A→B" 会把刚上传的字节搬到 B，留下空 A（多出一个文件）；
        //    反过来的顺序对"改名后原地替换同一路径"再写一次即可覆盖，语义与页面上的累积一致。
        for (const item of input.renames ?? []) {
          await request<SkillDraft>(`/api/skill-drafts/${encodeURIComponent(draft.id)}/files/rename`, {
            method: 'POST',
            body: { from: item.from, to: item.to, kind: item.kind },
          })
        }
        for (const file of input.textFiles) {
          if (file.path === SKILL_ENTRY_PATH) continue
          const name = file.path.split('/').pop() ?? file.path
          await uploadSkillEditFile(draft.id, file.path, new File([file.text], name, { type: 'text/plain' }))
        }
        for (const item of input.binaryFiles) {
          await uploadSkillEditFile(draft.id, item.path, item.file)
        }
        for (const path of input.removals ?? []) {
          await request<SkillDraft>(
            `/api/skill-drafts/${encodeURIComponent(draft.id)}/files?path=${encodeURIComponent(path)}`,
            { method: 'DELETE' },
          )
        }
        return await request<SaveSkillFromDraftResult>(
          `/api/skills/${encodeURIComponent(input.skill.id)}/revisions/from-draft`,
          {
            method: 'POST',
            body: {
              draftId: draft.id,
              fromVersion: input.skill.version,
              changeSummary: input.changeSummary,
              markdown: input.markdown,
              visibility: input.metadata.visibility,
            } satisfies SaveSkillRevisionFromDraftBody,
          },
        )
      } catch (error) {
        // 发布失败就把临时草稿丢掉（失败本身照常抛给界面）
        await request<{ id: string }>(`/api/skill-drafts/${encodeURIComponent(draft.id)}`, {
          method: 'DELETE',
        }).catch(() => undefined)
        throw error
      }
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: skillQueryKey(result.skill.id) })
      void queryClient.invalidateQueries({ queryKey: [...SKILL_DRAFTS_QUERY_KEY, 'list'] })
    },
  })
}

/** 版本历史（只读） */
export function useSkillVersions(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...skillQueryKey(id), 'versions'] as const,
    queryFn: () => request<SkillVersion[]>(`/api/skills/${encodeURIComponent(id)}/versions`),
    enabled: id !== '' && options.enabled !== false,
  })
}

/** 变更记录（只读） */
export function useSkillChanges(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...skillQueryKey(id), 'changes'] as const,
    queryFn: () => request<SkillChange[]>(`/api/skills/${encodeURIComponent(id)}/changes`),
    enabled: id !== '' && options.enabled !== false,
  })
}
