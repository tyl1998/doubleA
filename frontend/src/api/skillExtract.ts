/**
 * 从会话抽取 Skill 的接口封装（P1-24c-2）
 *
 * 依据：契约 `shared/src/skill.ts` 的「从会话抽取」段、后端 `routes/conversations.ts` 的同名端点。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `POST /api/conversations/:id/skills/extract` | `SkillExtractResult`（`draftId` + 草稿 + 脱敏项 + 来源） |
 * | `GET/PUT /api/admin/skill-extract-model` | `SkillExtractModelConfig`（平台单例，仅 ADMIN） |
 *
 * ⚠️ 抽取**只产草稿**：保存仍走 `useSaveSkillFromDraft`（脱敏确认、可选绑定都在审核页）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  SkillExtractBody,
  SkillExtractModelConfig,
  SkillExtractResult,
  SkillRevisionExtractBody,
  SkillRevisionTargets,
  UpdateSkillExtractModelBody,
} from '@doubulea/shared'

import { request } from './client.js'
import { SKILL_DRAFTS_QUERY_KEY, skillDraftQueryKey } from './skillDrafts.js'

/** 抽取一次会话（→ `CREATE` 草稿） */
export function extractSkill(conversationId: string, body: SkillExtractBody): Promise<SkillExtractResult> {
  return request<SkillExtractResult>(`/api/conversations/${encodeURIComponent(conversationId)}/skills/extract`, {
    method: 'POST',
    body,
  })
}

/**
 * 从会话纠正更新既有 Skill（P1-24c-4；`targetSkillId` 在不在决定 CREATE / REVISION）。
 *
 * ⚠️ 与 `extractSkill` 是**同一个端点**：服务端按 `targetSkillId` 分流，前端不该分两条路
 * （否则"另存为 Skill"与"更新到 Skill"会各有一份消息选择 / 脱敏逻辑）。
 */
export function extractSkillRevision(
  conversationId: string,
  body: SkillRevisionExtractBody,
): Promise<SkillExtractResult> {
  return request<SkillExtractResult>(`/api/conversations/${encodeURIComponent(conversationId)}/skills/extract`, {
    method: 'POST',
    body,
  })
}

export function useExtractSkill(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SkillExtractBody) => extractSkill(conversationId, body),
    onSuccess: (result) => {
      // 审核页一打开就要读到这份草稿（`useSkillDraft` 用它做首帧）
      queryClient.setQueryData(skillDraftQueryKey(result.draftId), result.draft)
      void queryClient.invalidateQueries({ queryKey: SKILL_DRAFTS_QUERY_KEY })
    },
  })
}

/** 「更新到 Skill」向导用：同一套成功处理（把草稿塞进缓存 → 审核页首帧可读） */
export function useExtractSkillRevision(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SkillRevisionExtractBody) => extractSkillRevision(conversationId, body),
    onSuccess: (result) => {
      queryClient.setQueryData(skillDraftQueryKey(result.draftId), result.draft)
      void queryClient.invalidateQueries({ queryKey: SKILL_DRAFTS_QUERY_KEY })
    },
  })
}

// ───────────────────────────── 「更新到 Skill」的目标候选（P1-24c-4）─────────────────────────────

export function skillRevisionTargetsQueryKey(conversationId: string): readonly [string, string] {
  return ['skill-targets', conversationId]
}

export function fetchSkillRevisionTargets(conversationId: string): Promise<SkillRevisionTargets> {
  return request<SkillRevisionTargets>(
    `/api/conversations/${encodeURIComponent(conversationId)}/skill-targets`,
  )
}

/** 本会话可更新的 Skill（最近加载优先；`enabled=false` ⇒ 不请求 —— 会话还没建 / 没绑智能体时不必打） */
export function useSkillRevisionTargets(conversationId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: skillRevisionTargetsQueryKey(conversationId ?? ''),
    queryFn: () => fetchSkillRevisionTargets(conversationId ?? ''),
    enabled: (conversationId ?? '') !== '' && options.enabled !== false,
    retry: false,
    staleTime: 10_000,
  })
}

// ───────────────────────────── 管理员：抽取模型配置 ─────────────────────────────

export const SKILL_EXTRACT_MODEL_QUERY_KEY = ['skill-extract-model'] as const

export function fetchSkillExtractModel(): Promise<SkillExtractModelConfig> {
  return request<SkillExtractModelConfig>('/api/admin/skill-extract-model')
}

export function useSkillExtractModel() {
  return useQuery({ queryKey: SKILL_EXTRACT_MODEL_QUERY_KEY, queryFn: fetchSkillExtractModel })
}

export function useUpdateSkillExtractModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateSkillExtractModelBody) =>
      request<SkillExtractModelConfig>('/api/admin/skill-extract-model', { method: 'PUT', body }),
    onSuccess: (data) => queryClient.setQueryData(SKILL_EXTRACT_MODEL_QUERY_KEY, data),
  })
}
