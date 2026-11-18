/**
 * Skill 草稿审核弹层（P1-24c-4c）
 *
 * 复用 `/skills/drafts/:draftId` 的审核组件（`SkillDraftReview`）：左侧文件树按改动打标记，
 * 右侧看对比 / 内容并可直接编辑正文；元数据与脱敏复核收进「设置」页签。
 *
 * ⚠️ 深链 `/skills/drafts/:draftId` **保留**为兜底（刷新 / 分享 / 从列表进入时仍可用）。
 */

import { Drawer } from 'antd'
import type { ReactNode } from 'react'

import { useT } from '../../app/i18n.js'
import { SkillDraftReview } from './SkillDraftReview.js'

export function SkillDraftReviewDrawer({
  draftId,
  onClose,
}: {
  /** `null` = 关闭 */
  draftId: string | null
  onClose: () => void
}): ReactNode {
  const { t } = useT()
  return (
    <Drawer
      open={draftId !== null}
      title={t('skillNotice.reviewTitle')}
      width="min(1280px, 96vw)"
      destroyOnClose
      onClose={onClose}
      styles={{ body: { padding: 'var(--sp-4)' } }}
    >
      {draftId === null ? null : <SkillDraftReview draftId={draftId} embedded onDone={() => onClose()} />}
    </Drawer>
  )
}