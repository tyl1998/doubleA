/**
 * Skill 草稿提示卡接口封装（P1-24c-4c）
 *
 * | 端点 | 成功响应 |
 * |------|----------|
 * | `GET /api/conversations/:id/skill-notices` | `{ items: SkillDraftNotice[] }`（**不消费**） |
 * | `POST /api/conversations/:id/skill-notices/:noticeId` | `{ id, applied }`（`OPEN` / `DISMISS`） |
 *
 * ⚠️ 与记忆提示同一族（`memoryNoticeStack` 的取舍）：`GET` **不消费**，前端按 `id` 去重；
 * 只有 `POST` 才移除（`applied=false` = 已过期 / 已被消费，按幂等处理）。
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  SkillDraftNotice,
  SkillDraftNoticeActionBody,
  SkillDraftNoticeActionResult,
  SkillDraftNoticesResult,
} from '@doubulea/shared'

import { request } from './client.js'

export function skillDraftNoticesQueryKey(conversationId: string): readonly [string, string] {
  return ['skill-notices', conversationId]
}

export function fetchSkillDraftNotices(conversationId: string): Promise<SkillDraftNoticesResult> {
  return request<SkillDraftNoticesResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/skill-notices`,
  )
}

/** 消费一条提示（`OPEN` = 打开审核弹层；`DISMISS` = 忽略 / 关闭） */
export function useSkillDraftNoticeAction(conversationId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { noticeId: string; body: SkillDraftNoticeActionBody }) =>
      request<SkillDraftNoticeActionResult>(
        `/api/conversations/${encodeURIComponent(conversationId ?? '')}/skill-notices/${encodeURIComponent(input.noticeId)}`,
        { method: 'POST', body: input.body },
      ),
    onSuccess: () => {
      if (conversationId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: skillDraftNoticesQueryKey(conversationId) })
      }
    },
  })
}

/** 去重：同一 `draftId` 只留一条（服务端也去重；前端对重复拉取再兜一道） */
export function mergeSkillDraftNotices(
  current: readonly SkillDraftNotice[],
  incoming: readonly SkillDraftNotice[],
): SkillDraftNotice[] {
  const seen = new Set(current.map((item) => item.draftId ?? item.id))
  const fresh = incoming.filter((item) => !seen.has(item.draftId ?? item.id))
  return fresh.length === 0 ? [...current] : [...current, ...fresh]
}
