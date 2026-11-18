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
import type {
  CreateSkillDraftBody,
  SaveSkillFromDraftBody,
  SaveSkillFromDraftResult,
  SaveSkillRevisionFromDraftBody,
  SkillChange,
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

/** 移除一个草稿文件 */
export function useRemoveSkillDraftFile(draftId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (path: string) =>
      request<SkillDraft>(
        `/api/skill-drafts/${encodeURIComponent(draftId)}/files?path=${encodeURIComponent(path)}`,
        { method: 'DELETE' },
      ),
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
