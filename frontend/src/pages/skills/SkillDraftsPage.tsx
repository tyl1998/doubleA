/**
 * 我的 Skill 草稿（`/skills/drafts`）。
 *
 * 为什么需要这一页：草稿提示卡只出现一次（打开 / 忽略都会消费）。
 * 用户关闭审核弹层或重新进会话后，必须有固定入口回到「还没保存的那份草稿」，
 * 否则只能靠记住 draftId 走深链。列表只列本人、未过期的草稿。
 */

import { Button, Empty, Modal, Tag } from 'antd'
import { Link, useNavigate } from 'react-router-dom'
import type { MessageKey, SkillDraftSummary } from '@doubulea/shared'

import { useDeleteSkillDraft, useSkillDrafts } from '../../api/skillDrafts.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatUpdatedAt } from '../../app/format.js'
import { SKILLS_PATH, skillDraftPath } from '../../app/paths.js'
import { ErrorState, TableSkeleton } from '../../components/ListStates.js'

function kindLabelKey(kind: SkillDraftSummary['kind']): MessageKey {
  return kind === 'REVISION'
    ? 'skillDraft.kindRevision'
    : kind === 'SESSION_OVERRIDE'
      ? 'skillDraft.kindSessionOverride'
      : kind === 'CREATE'
        ? 'skillDraft.kindCreate'
        : 'skillDraftList.kindProposal'
}

const SUBMISSION_STATUS_KEY = {
  PENDING: 'skillProposal.statusPENDING',
  ACCEPTED: 'skillProposal.statusACCEPTED',
  REJECTED: 'skillProposal.statusREJECTED',
  NEEDS_REBASE: 'skillProposal.statusNEEDS_REBASE',
  CLOSED: 'skillProposal.statusCLOSED',
} as const satisfies Record<NonNullable<SkillDraftSummary['submission']>['status'], MessageKey>

const SUBMISSION_STATUS_COLOR = {
  PENDING: 'orange',
  ACCEPTED: 'green',
  REJECTED: 'red',
  NEEDS_REBASE: 'red',
  CLOSED: 'default',
} as const

export function SkillDraftsPage() {
  const { t } = useT()
  const feedback = useFeedback()
  const navigate = useNavigate()
  const draftsQuery = useSkillDrafts()
  const deleteDraft = useDeleteSkillDraft()

  if (draftsQuery.isError) {
    return (
      <ErrorState
        title={t('skillDraftList.loadFailed')}
        error={draftsQuery.error}
        retrying={draftsQuery.isFetching}
        onRetry={() => {
          void draftsQuery.refetch()
        }}
      />
    )
  }
  if (draftsQuery.isPending) return <TableSkeleton />

  const items = draftsQuery.data?.items ?? []

  function discard(draft: SkillDraftSummary): void {
    Modal.confirm({
      title: t('skillDraft.discardTitle'),
      content: t('skillDraft.discardDesc'),
      okText: t('skillDraft.discardOk'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () =>
        new Promise<void>((resolve) => {
          deleteDraft.mutate(draft.id, {
            onSuccess: () => {
              feedback.ok(t('skillDraft.discarded'))
              resolve()
            },
            onError: (error) => {
              feedback.fail(error, t('skillDraft.discardFailed'))
              resolve()
            },
          })
        }),
    })
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('skillDraftList.title')}</h1>
          <p className="page__lead">{t('skillDraftList.lead')}</p>
        </div>
        <div className="page__head-actions">
          <Link to={SKILLS_PATH}>
            <Button>{t('skillDraftList.back')}</Button>
          </Link>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="card card--pad">
          <Empty description={t('skillDraftList.empty')} />
        </div>
      ) : (
        <div className="stack">
          {items.map((draft) => {
            const submission = draft.submission
            const returned =
              submission !== null &&
              (submission.status === 'NEEDS_REBASE' || submission.status === 'REJECTED')
            const locked =
              submission !== null && (submission.status === 'PENDING' || submission.status === 'ACCEPTED')
            return (
            <div key={draft.id} className="card card--pad">
              <div className="row row--wrap" style={{ alignItems: 'flex-start', gap: 'var(--sp-3)' }}>
                <div className="column" style={{ flex: 1, minWidth: 0, gap: 'var(--sp-1)' }}>
                  <div className="row row--wrap" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>{draft.name === '' ? t('skillDraft.untitled') : draft.name}</span>
                    <Tag>{t(kindLabelKey(draft.kind))}</Tag>
                    {submission === null ? null : (
                      <Tag color={SUBMISSION_STATUS_COLOR[submission.status]}>
                        {t(SUBMISSION_STATUS_KEY[submission.status])}
                      </Tag>
                    )}
                    {submission?.status === 'ACCEPTED' && submission.acceptedVersion !== null ? (
                      <span className="ratio">
                        {t('skillDraft.submittedAccepted', { version: submission.acceptedVersion })}
                      </span>
                    ) : null}
                    {draft.baseVersion === null ? null : (
                      <span className="ratio">{t('skillDraft.basedOn', { version: draft.baseVersion })}</span>
                    )}
                    {draft.fileCount === 0 ? null : (
                      <span className="ratio">{t('skillDraftList.fileCount', { count: draft.fileCount })}</span>
                    )}
                  </div>
                  {draft.changeSummary.trim() === '' ? null : (
                    <span className="ratio" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {draft.changeSummary}
                    </span>
                  )}
                  <span className="ratio">
                    {t('skillDraftList.updated', { time: formatUpdatedAt(draft.updatedAt) })}
                    {submission === null
                      ? ` · ${t('skillDraftList.expires', { time: formatUpdatedAt(draft.expiresAt) })}`
                      : ` · ${t('skillDraftList.submittedKept')}`}
                  </span>
                  {submission !== null && submission.reviewNote !== null && submission.reviewNote.trim() !== '' ? (
                    <span className="ratio">
                      {t('skillDraftList.reviewNote', { note: submission.reviewNote })}
                    </span>
                  ) : null}
                </div>
                <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
                  <Button
                    type={returned ? 'primary' : locked ? 'default' : 'primary'}
                    size="small"
                    onClick={() => navigate(skillDraftPath(draft.id))}
                  >
                    {returned
                      ? t('skillDraftList.resubmit')
                      : locked
                        ? t('skillDraftList.viewSubmitted')
                        : t('skillDraftList.open')}
                  </Button>
                  {locked ? null : (
                    <Button danger size="small" onClick={() => discard(draft)}>
                      {t('skillDraft.discard')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
            )
          })}
        </div>
      )}
      <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
        {t('skillDraftList.hint')}
      </p>
    </>
  )
}
