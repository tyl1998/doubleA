/**
 * 更新建议审核弹层（P1-24c-6）
 *
 * 所属人视角：左看当前上游（diff 由服务端算好）、右看建议结果（`proposalMarkdown`）；
 * 基准冲突时展示逐项冲突（`section:*` / `file:*`），必须每个锚点选一边才能三方合并。
 *
 * ⚠️ 提交者视角（`mode='mine'`）只读：可看状态 / 审核意见 / 撤回，不出现接受 / 拒绝按钮
 *    （后端也不允许提交者自审自批）。
 */

import { Alert, Button, Input, Modal, Select, Space, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { MessageKey, SkillProposalDetail, SkillMergeChoice } from '@doubulea/shared'
import { translate } from '@doubulea/shared'

import {
  useAcceptSkillProposal,
  useRejectSkillProposal,
  useSkillProposal,
} from '../../api/skillProposals.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { SKILL_DRAFTS_PATH } from '../../app/paths.js'
import { TableSkeleton } from '../../components/ListStates.js'

const CHANGE_CHOICES: readonly SkillMergeChoice[] = ['BASE', 'UPSTREAM', 'PROPOSAL']

const STATUS_KEY: Readonly<Record<SkillProposalDetail['status'], MessageKey>> = {
  PENDING: 'skillProposal.statusPENDING',
  ACCEPTED: 'skillProposal.statusACCEPTED',
  REJECTED: 'skillProposal.statusREJECTED',
  NEEDS_REBASE: 'skillProposal.statusNEEDS_REBASE',
  CLOSED: 'skillProposal.statusCLOSED',
}

export interface SkillProposalReviewModalProps {
  open: boolean
  proposalId: string
  /** `mine` = 提交者只读（可撤回）；缺省 = 所属人审核 */
  mode?: 'review' | 'mine'
  onClose: () => void
  onAccepted?: (version: number) => void
}

export function SkillProposalReviewModal({
  open,
  proposalId,
  mode = 'review',
  onClose,
  onAccepted,
}: SkillProposalReviewModalProps) {
  const { t, locale } = useT()
  const feedback = useFeedback()
  const detailQuery = useSkillProposal(proposalId, open && proposalId !== '')
  const accept = useAcceptSkillProposal()
  const reject = useRejectSkillProposal()

  const [resolutions, setResolutions] = useState<Record<string, SkillMergeChoice>>({})
  const [note, setNote] = useState('')
  const [action, setAction] = useState<'none' | 'reject'>('none')

  useEffect(() => {
    if (!open) return
    setResolutions({})
    setNote('')
    setAction('none')
  }, [open, proposalId])

  const detail = detailQuery.data
  const conflicts = detail?.merge?.conflicts ?? []
  const allResolved = conflicts.every((conflict) => resolutions[conflict.anchor] !== undefined)
  const actionable = mode === 'review' && detail?.status === 'PENDING'
  const returned = mode === 'mine' && (detail?.status === 'NEEDS_REBASE' || detail?.status === 'REJECTED')
  const busy = accept.isPending || reject.isPending

  const diffLines = useMemo(
    () => (detail?.diff?.sections ?? []).filter((line) => line.op !== 'equal').slice(0, 80),
    [detail?.diff?.sections],
  )

  function doAccept(): void {
    if (detail === undefined) return
    const strategy = detail.baseMatches ? 'REQUIRE_BASE' : 'THREE_WAY'
    accept.mutate(
      {
        id: detail.id,
        body: {
          strategy,
          ...(strategy === 'THREE_WAY'
            ? {
                resolutions: conflicts.map((conflict) => ({
                  anchor: conflict.anchor,
                  choice: resolutions[conflict.anchor]!,
                })),
              }
            : {}),
        },
      },
      {
        onSuccess: (result) => {
          feedback.ok(t('skillProposal.accepted', { version: result.version }))
          onAccepted?.(result.version)
          onClose()
        },
        onError: (error) => feedback.fail(error, t('skillProposal.acceptFailed')),
      },
    )
  }

  function doReject(): void {
    if (detail === undefined || note.trim() === '') return
    reject.mutate(
      { id: detail.id, body: { note: note.trim() } },
      {
        onSuccess: () => {
          feedback.ok(t('skillProposal.rejected'))
          onClose()
        },
        onError: (error) => feedback.fail(error, t('skillProposal.reviewFailed')),
      },
    )
  }

  return (
    <Modal
      open={open}
      title={t('skillProposal.reviewTitle')}
      width={960}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {detailQuery.isPending ? (
        <TableSkeleton rows={6} />
      ) : detailQuery.isError || detail === undefined ? (
        <Alert type="error" showIcon message={t('skillProposal.loadFailed')} />
      ) : (
        <div className="stack stack--tight">
          <Space wrap>
            <Tag>{translate(locale, STATUS_KEY[detail.status])}</Tag>
            <span>{t('skillProposal.fromProposer', { name: detail.proposerName })}</span>
            <span className="ratio">{t('skillProposal.basedOn', { version: detail.baseVersion })}</span>
            {detail.acceptedVersion !== null && (
              <Tag color="green">{t('skillProposal.mergedInto', { version: detail.acceptedVersion })}</Tag>
            )}
          </Space>
          <p style={{ margin: 0 }}>{detail.changeSummary}</p>
          <p className="ratio">
            {detail.sourceConversationId === null
              ? t('skillProposal.noSource')
              : t('skillProposal.sourceConversation', { count: detail.sourceMessageCount })}
          </p>
          {detail.reviewNote !== null && <Alert type="info" showIcon message={detail.reviewNote} />}

          {!detail.baseMatches && (
            <Alert
              type={detail.merge?.comparable === false ? 'warning' : 'error'}
              showIcon
              message={t('skillProposal.baseConflict', {
                base: detail.baseVersion,
                upstream: detail.upstreamVersion ?? '—',
              })}
              description={
                detail.merge?.comparable === false
                  ? t('skillProposal.compareUnavailable')
                  : conflicts.length === 0
                    ? t('skillProposal.mergeNoConflict')
                    : t('skillProposal.mergeConflicts', { count: conflicts.length })
              }
            />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
            <div>
              <p className="block-label">{t('skillProposal.currentUpstream')}</p>
              <pre className="skill-proposal-diff">{detail.upstreamMarkdown ?? (diffLines.map((line) => line.before).filter((text) => text !== '').join('\n\n') || t('skillProposal.noDiff'))}</pre>
            </div>
            <div>
              <p className="block-label">{t('skillProposal.proposedResult')}</p>
              <pre className="skill-proposal-diff">{detail.proposalMarkdown}</pre>
            </div>
          </div>

          {(detail.diff?.addedFiles.length ?? 0) + (detail.diff?.removedFiles.length ?? 0) + (detail.diff?.changedFiles.length ?? 0) > 0 && (
            <div>
              <p className="block-label">{t('skillProposal.fileChanges')}</p>
              <Space wrap>
                {(detail.diff?.addedFiles ?? []).map((path) => (
                  <Tag color="green" key={`a-${path}`}>+ {path}</Tag>
                ))}
                {(detail.diff?.changedFiles ?? []).map((path) => (
                  <Tag color="blue" key={`c-${path}`}>~ {path}</Tag>
                ))}
                {(detail.diff?.removedFiles ?? []).map((path) => (
                  <Tag color="red" key={`r-${path}`}>- {path}</Tag>
                ))}
              </Space>
            </div>
          )}

          {conflicts.length > 0 && (
            <div>
              <p className="block-label">{t('skillProposal.conflictsTitle')}</p>
              <div className="stack stack--tight">
                {conflicts.map((conflict) => (
                  <div key={conflict.anchor} className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                    <code>{conflict.kind === 'section' ? conflict.label || t('skillProposal.untitledSection') : conflict.label}</code>
                    <Select
                      size="small"
                      style={{ minWidth: 180 }}
                      value={resolutions[conflict.anchor]}
                      placeholder={t('skillProposal.chooseSide')}
                      onChange={(choice) =>
                        setResolutions((current) => ({ ...current, [conflict.anchor]: choice as SkillMergeChoice }))
                      }
                      options={CHANGE_CHOICES.map((choice) => ({
                        value: choice,
                        label: translate(locale, `skillProposal.side.${choice}`),
                      }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {returned && (
            <Alert
              type="warning"
              showIcon
              message={t('skillProposal.resubmitHint')}
              action={
                <Link to={SKILL_DRAFTS_PATH} onClick={onClose}>
                  <Button size="small">{t('skillDraftList.resubmit')}</Button>
                </Link>
              }
            />
          )}

          {action === 'reject' && (
            <div>
              <p className="block-label">{t('skillProposal.rejectNote')}</p>
              <Input.TextArea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          )}

          <Space wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
            {actionable && (
              <>
                <Button
                  type="primary"
                  loading={accept.isPending}
                  disabled={
                    busy ||
                    detail.upstreamVersion === null ||
                    detail.proposalMarkdown.trim() === '' ||
                    (!detail.baseMatches && !allResolved) ||
                    (!detail.baseMatches && detail.merge?.comparable === false)
                  }
                  onClick={doAccept}
                >
                  {detail.baseMatches ? t('skillProposal.accept') : t('skillProposal.acceptMerge')}
                </Button>
                <Button onClick={() => setAction(action === 'reject' ? 'none' : 'reject')}>
                  {t('skillProposal.reject')}
                </Button>
                {action === 'reject' && (
                  <Button
                    danger
                    type="primary"
                    loading={reject.isPending}
                    disabled={note.trim() === ''}
                    onClick={doReject}
                  >
                    {t('skillProposal.confirmAction')}
                  </Button>
                )}
              </>
            )}
          </Space>
        </div>
      )}
    </Modal>
  )
}