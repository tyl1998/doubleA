/**
 * 会话级 Skill 覆写接口封装（P1-24c-4b；`子方案/Skill能力.md` §5.16.7）
 *
 * | 端点 | 成功响应 |
 * |------|----------|
 * | `POST /api/conversations/:id/skill-overrides` | `ConversationSkillOverrideDetail` |
 * | `GET  /api/conversations/:id/skill-overrides` | `{ items }` |
 * | `GET  .../:overrideId` | `ConversationSkillOverrideDetail` |
 * | `PUT  .../:overrideId` | `ConversationSkillOverrideDetail`（`expectedRevision` CAS） |
 * | `DELETE .../:overrideId` | `{ id }` |
 * | `POST .../:overrideId/rebased` | `SkillDraft`（按当前上游重建的 `SESSION_OVERRIDE` 草稿） |
 * | `POST .../:overrideId/promote` | `{ skill, overrideDeleted }`（P1-24c-5；先 fork、再删覆写） |
 *
 * ⚠️ 覆写**不改上游**：保存只写 `conversation_skill_overrides` + 覆写 S3 前缀；
 * 只有显式 `promote` 才生成独立 Skill（`parentSkillId` 指向上游）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ConversationSkillOverrideDetail,
  ConversationSkillOverridesResult,
  PromoteSkillOverrideResult,
  SkillDraft,
  SkillExtractResult,
  SkillRevisionExtractBody,
} from '@doubulea/shared'

import { request } from './client.js'
import { SKILLS_QUERY_KEY } from './skills.js'
import { SKILL_DRAFTS_QUERY_KEY, skillDraftQueryKey } from './skillDrafts.js'

export function conversationSkillOverridesQueryKey(conversationId: string): readonly [string, string] {
  return ['skill-overrides', conversationId]
}

export function fetchConversationSkillOverrides(conversationId: string): Promise<ConversationSkillOverridesResult> {
  return request<ConversationSkillOverridesResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides`,
  )
}

export function useConversationSkillOverrides(conversationId: string | undefined) {
  return useQuery({
    queryKey: conversationSkillOverridesQueryKey(conversationId ?? ''),
    queryFn: () => fetchConversationSkillOverrides(conversationId ?? ''),
    enabled: (conversationId ?? '') !== '',
    retry: false,
    staleTime: 5_000,
  })
}

/** 「只改本会话」：走与 REVISION 同一个抽取端点，`intent=OVERRIDE` 产出 `SESSION_OVERRIDE` 草稿 */
export function extractSkillOverride(
  conversationId: string,
  body: Omit<SkillRevisionExtractBody, 'intent'>,
): Promise<SkillExtractResult> {
  return request<SkillExtractResult>(`/api/conversations/${encodeURIComponent(conversationId)}/skills/extract`, {
    method: 'POST',
    body: { ...body, intent: 'OVERRIDE' as const },
  })
}

export function useExtractSkillOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Omit<SkillRevisionExtractBody, 'intent'>) => extractSkillOverride(conversationId, body),
    onSuccess: (result) => {
      queryClient.setQueryData(skillDraftQueryKey(result.draftId), result.draft)
      void queryClient.invalidateQueries({ queryKey: SKILL_DRAFTS_QUERY_KEY })
    },
  })
}

/** 保存草稿为覆写（新建入口；已存在 ⇒ 409 —— 改用替换） */
export function useCreateConversationSkillOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draftId: string) =>
      request<ConversationSkillOverrideDetail>(
        `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides`,
        { method: 'POST', body: { draftId } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationSkillOverridesQueryKey(conversationId) })
      queryClient.removeQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

/** 替换覆写内容（CAS `expectedRevision`；不匹配 ⇒ 409 `SKILL_OVERRIDE_CONFLICT`） */
export function useReplaceConversationSkillOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { overrideId: string; draftId: string; expectedRevision: number }) =>
      request<ConversationSkillOverrideDetail>(
        `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides/${encodeURIComponent(input.overrideId)}`,
        { method: 'PUT', body: { draftId: input.draftId, expectedRevision: input.expectedRevision } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationSkillOverridesQueryKey(conversationId) })
      queryClient.removeQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

/** 放弃覆写（列表里的「放弃」；有确认弹窗，由调用方负责） */
export function useDeleteConversationSkillOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (overrideId: string) =>
      request<{ id: string }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides/${encodeURIComponent(overrideId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationSkillOverridesQueryKey(conversationId) })
    },
  })
}

/**
 * 另存为我的 Skill（P1-24c-5）：服务端先 fork、再删覆写。
 *
 * `overrideDeleted=false` 表示副本已建好、覆写仍在（可稍后放弃）—— 不会出现"两边都没有"。
 */
export function usePromoteConversationSkillOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (overrideId: string) =>
      request<PromoteSkillOverrideResult>(
        `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides/${encodeURIComponent(overrideId)}/promote`,
        { method: 'POST', body: {} },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationSkillOverridesQueryKey(conversationId) })
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    },
  })
}

/** 按当前上游重建草稿（审核页打开的是新 `SESSION_OVERRIDE` 草稿） */
export function useRebaseConversationSkillOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (overrideId: string) =>
      request<SkillDraft>(
        `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides/${encodeURIComponent(overrideId)}/rebased`,
        { method: 'POST', body: {} },
      ),
    onSuccess: (draft) => {
      queryClient.setQueryData(skillDraftQueryKey(draft.id), draft)
    },
  })
}

/**
 * 从覆写直接建更新建议草稿（不 fork）：内容就是这条覆写，`baseVersion = basedOnVersion`。
 *
 * 服务端把 `redactionCarried` 置为 `true` —— 审核页沿用覆写保存时那次脱敏确认。
 */
export function useProposalDraftFromOverride(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (overrideId: string) =>
      request<SkillDraft>(
        `/api/conversations/${encodeURIComponent(conversationId)}/skill-overrides/${encodeURIComponent(overrideId)}/proposal-draft`,
        { method: 'POST', body: {} },
      ),
    onSuccess: (draft) => {
      queryClient.setQueryData(skillDraftQueryKey(draft.id), draft)
      void queryClient.invalidateQueries({ queryKey: SKILL_DRAFTS_QUERY_KEY })
    },
  })
}