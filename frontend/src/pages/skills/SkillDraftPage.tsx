/**
 * Skill 草稿审核页（`/skills/drafts/:draftId`，P1-24c-1）
 *
 * 深链 / 刷新 / 从草稿列表进入时的兜底页；布局与聊天侧审核弹层一致，共用
 * {@link SkillDraftReview}（文件树 + 对比 / 内容 / 编辑 + 「设置」页签）。
 */

import { useParams } from 'react-router-dom'

import { useT } from '../../app/i18n.js'
import { SkillDraftReview } from '../../features/skills/SkillDraftReview.js'

export function SkillDraftPage() {
  const { draftId = '' } = useParams<{ draftId: string }>()
  const { t } = useT()
  return (
    <div aria-label={t('skillDraft.crumbFallback')}>
      <SkillDraftReview draftId={draftId} />
    </div>
  )
}