/**
 * Skill 更新建议（Proposal）接口封装（P1-24c-6）
 *
 * 信封：全部为裸对象（`SkillProposalItem` / `SkillProposalDetail` / `SkillProposalListResult`）；
 * `POST /api/skills/:id/proposals` 回 `SkillProposalItem`，accept 回 `{ proposal, skill, version }`。
 *
 * 失效范围：提交 / 接受 / 拒绝都同时影响「我的建议」「目标的更新建议」与 Skill 详情，
 * 统一以 `['skill-proposals']` 前缀标脏，Skill 侧交给调用方额外 `invalidateQueries(['skills'])`。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AcceptSkillProposalBody,
  AcceptSkillProposalResult,
  CloseSkillProposalBody,
  CreateSkillProposalDraftBody,
  ReviewSkillProposalBody,
  SkillDraft,
  SkillProposalDetail,
  SkillProposalItem,
  SkillProposalListResult,
  SkillProposalStatus,
  SubmitSkillProposalBody,
} from '@doubulea/shared'

import { request } from './client.js'

export const SKILL_PROPOSALS_QUERY_KEY = ['skill-proposals'] as const

export function skillProposalQueryKey(id: string): readonly [string, string] {
  return ['skill-proposals', id]
}

/** 从副本建提案草稿（`id` = 副本；返回 `SkillDraft`，随后跳审核页） */
export function useCreateSkillProposalDraft() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: CreateSkillProposalDraftBody }) =>
      request<SkillDraft>(`/api/skills/${encodeURIComponent(id)}/proposal-draft`, {
        method: 'POST',
        body: body ?? {},
      }),
  })
}

/** 提交提案（只收 `draftId` + 说明 + 审计位 + 脱敏确认后的正文） */
export function useSubmitSkillProposal(targetSkillId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SubmitSkillProposalBody) =>
      request<SkillProposalItem>(`/api/skills/${encodeURIComponent(targetSkillId)}/proposals`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILL_PROPOSALS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['skills'] })
      // 提案草稿提交后保留在「我的草稿」里并显示审核状态
      void queryClient.invalidateQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

/** 待我审核的更新建议总数（左侧导航 / Skills 列表徽标） */
export function usePendingSkillReviewCount() {
  return useQuery({
    queryKey: [...SKILL_PROPOSALS_QUERY_KEY, 'pending-review-count'] as const,
    queryFn: () => request<{ count: number }>('/api/skill-proposals/pending-review-count'),
    refetchOnWindowFocus: true,
  })
}

/** 目标的「更新建议」（所属人 / ADMIN；目标不可编辑 ⇒ 404） */
export function useSkillProposalsForTarget(
  targetSkillId: string,
  status?: SkillProposalStatus,
  enabled = true,
) {
  return useQuery({
    queryKey: [...SKILL_PROPOSALS_QUERY_KEY, 'target', targetSkillId, status ?? 'ALL'] as const,
    queryFn: () => {
      const search = new URLSearchParams()
      if (status !== undefined) search.set('status', status)
      const query = search.toString()
      return request<SkillProposalListResult>(
        `/api/skills/${encodeURIComponent(targetSkillId)}/proposals${query === '' ? '' : `?${query}`}`,
      )
    },
    enabled: enabled && targetSkillId !== '',
    placeholderData: keepPreviousData,
  })
}

/** 我的建议（本批只支持 mine=1） */
export function useMySkillProposals(status?: SkillProposalStatus, enabled = true) {
  return useQuery({
    queryKey: [...SKILL_PROPOSALS_QUERY_KEY, 'mine', status ?? 'ALL'] as const,
    queryFn: () => {
      const search = new URLSearchParams({ mine: '1' })
      if (status !== undefined) search.set('status', status)
      return request<SkillProposalListResult>(`/api/skill-proposals?${search.toString()}`)
    },
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** 提案详情（正文 + diff + 三方冲突预览） */
export function useSkillProposal(id: string, enabled = true) {
  return useQuery({
    queryKey: skillProposalQueryKey(id),
    queryFn: () => request<SkillProposalDetail>(`/api/skill-proposals/${encodeURIComponent(id)}`),
    enabled: enabled && id !== '',
    retry: false,
  })
}

export function useAcceptSkillProposal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AcceptSkillProposalBody }) =>
      request<AcceptSkillProposalResult>(`/api/skill-proposals/${encodeURIComponent(id)}/accept`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILL_PROPOSALS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['skills'] })
      void queryClient.invalidateQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

export function useRejectSkillProposal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReviewSkillProposalBody }) =>
      request<SkillProposalItem>(`/api/skill-proposals/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILL_PROPOSALS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['skills'] })
      void queryClient.invalidateQueries({ queryKey: ['skill-drafts'] })
    },
  })
}

export function useCloseSkillProposal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CloseSkillProposalBody }) =>
      request<SkillProposalItem>(`/api/skill-proposals/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SKILL_PROPOSALS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['skill-drafts'] })
    },
  })
}