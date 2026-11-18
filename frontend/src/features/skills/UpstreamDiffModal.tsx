/**
 * 副本的上游差异 + fast-forward（P1-24c-5；`子方案/会话生成Skill.md` §10.23）
 *
 * 只读差异由服务端算（`GET /api/skills/:id/upstream-diff`）；「同步上游」只在
 * `canFastForward=true` 时出现，且确认框明说会覆盖副本内容。有本地改动 /
 * 基准已归档时只给解释，不提供半成品的三方合并（属 c-6）。
 */

import { Alert, Button, Divider, Modal, Select, Tag } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'

import { translate, type MessageKey, type SkillDiffLine, type SkillMergeChoice, type SkillUpstreamDiff } from '@doubulea/shared'

import { useSkillUpstreamDiff, useSyncSkillUpstream } from '../../api/skills.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

export interface UpstreamDiffModalProps {
  open: boolean
  skillId: string
  skillName: string
  onClose: () => void
}

function statusText(data: SkillUpstreamDiff, t: ReturnType<typeof useT>['t']): string {
  if (data.parentDeleted) return t('skillFork.sourceDeleted')
  if (!data.parentAvailable) return t('skillFork.statusUnavailable')
  if (data.upToDate && data.upstreamVersion !== null) {
    return t('skillFork.statusSynced', { version: data.upstreamVersion })
  }
  if (data.hasLocalChanges && data.upstreamVersion !== null) {
    return t('skillFork.statusLocal')
  }
  return data.upstreamVersion === null
    ? t('skillFork.statusUnavailable')
    : t('skillFork.statusUpstream', { version: data.upstreamVersion })
}

function diffTag(line: SkillDiffLine, t: ReturnType<typeof useT>['t']): ReactNode {
  if (line.op === 'add') return <Tag color="green">{t('skillFork.opAdd')}</Tag>
  if (line.op === 'remove') return <Tag color="red">{t('skillFork.opRemove')}</Tag>
  return <Tag color="orange">{t('skillFork.opReplace')}</Tag>
}

function FileList({ label, paths }: { label: string; paths: readonly string[] }): ReactNode {
  if (paths.length === 0) return null
  return (
    <p className="ratio">
      <span className="block-label">{label}</span>{' '}
      {paths.map((path) => (
        <code key={path} style={{ marginRight: 8 }}>
          {path}
        </code>
      ))}
    </p>
  )
}

const MERGE_CHOICES: readonly SkillMergeChoice[] = ['BASE', 'UPSTREAM', 'PROPOSAL']
const MERGE_SIDE_KEY: Readonly<Record<SkillMergeChoice, MessageKey>> = {
  BASE: 'skillFork.side.BASE',
  UPSTREAM: 'skillFork.side.UPSTREAM',
  PROPOSAL: 'skillFork.side.PROPOSAL',
}

export function UpstreamDiffModal({ open, skillId, skillName, onClose }: UpstreamDiffModalProps): ReactNode {
  const { t, locale } = useT()
  const feedback = useFeedback()
  const query = useSkillUpstreamDiff(open ? skillId : '', open)
  const sync = useSyncSkillUpstream()
  const data = query.data
  const [resolutions, setResolutions] = useState<Record<string, SkillMergeChoice>>({})
  useEffect(() => {
    if (open) setResolutions({})
  }, [open, skillId])
  const conflicts = data?.mergeConflicts ?? []
  const allResolved = conflicts.every((conflict) => resolutions[conflict.anchor] !== undefined)

  function syncThreeWay(): void {
    if (data === undefined || data.syncedVersion === null || data.upstreamVersion === null) return
    if (conflicts.length > 0 && !allResolved) return
    Modal.confirm({
      title: t('skillFork.threeWayTitle', { version: data.upstreamVersion }),
      content: t('skillFork.threeWayDesc', { version: data.upstreamVersion }),
      okText: t('skillFork.threeWay'),
      cancelText: t('common.cancel'),
      onOk: () =>
        new Promise<void>((resolve) => {
          sync.mutate(
            {
              id: skillId,
              body: {
                fromVersion: data.syncedVersion ?? 1,
                strategy: 'THREE_WAY',
                resolutions: conflicts.map((conflict) => ({
                  anchor: conflict.anchor,
                  choice: resolutions[conflict.anchor]!,
                })),
              },
            },
            {
              onSuccess: (result) => {
                feedback.ok(t('skillFork.threeWayOk', { version: result.upstreamVersion }))
                onClose()
                resolve()
              },
              onError: (error) => {
                feedback.fail(error, t('skillFork.threeWayFailed'))
                resolve()
              },
            },
          )
        }),
    })
  }

  function syncNow(): void {
    if (data === undefined || data.syncedVersion === null || data.upstreamVersion === null) return
    Modal.confirm({
      title: t('skillFork.syncTitle', { version: data.upstreamVersion }),
      content: t('skillFork.syncDesc', { version: data.upstreamVersion }),
      okText: t('skillFork.sync'),
      cancelText: t('common.cancel'),
      onOk: () =>
        new Promise<void>((resolve) => {
          sync.mutate(
            {
              id: skillId,
              body: { fromVersion: data.syncedVersion ?? 1, strategy: 'FAST_FORWARD' },
            },
            {
              onSuccess: (result) => {
                feedback.ok(t('skillFork.syncOk', { version: result.upstreamVersion }))
                onClose()
                resolve()
              },
              onError: (error) => {
                feedback.fail(error, t('skillFork.syncFailed'))
                resolve()
              },
            },
          )
        }),
    })
  }

  const sections = data?.diff?.sections.filter((line) => line.op !== 'equal') ?? []
  const addedFiles = data?.diff?.addedFiles ?? []
  const removedFiles = data?.diff?.removedFiles ?? []
  const changedFiles = data?.diff?.changedFiles ?? []
  const hasFileChanges = addedFiles.length + removedFiles.length + changedFiles.length > 0

  return (
    <Modal
      open={open}
      title={t('skillFork.diffTitle')}
      width={860}
      onCancel={onClose}
      footer={
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {data?.canFastForward === true ? (
            <Button type="primary" loading={sync.isPending} onClick={syncNow}>
              {t('skillFork.sync')}
            </Button>
          ) : null}
          {data?.canThreeWay === true && data.canFastForward !== true ? (
            <Button type="primary" loading={sync.isPending} disabled={conflicts.length > 0 && !allResolved} onClick={syncThreeWay}>
              {t('skillFork.threeWay')}
            </Button>
          ) : null}
        </div>
      }
    >
      <p style={{ marginTop: 0 }}>
        <strong>{skillName}</strong>
        {data === undefined ? null : <Tag style={{ marginLeft: 8 }}>{statusText(data, t)}</Tag>}
      </p>

      {query.isError ? (
        <Alert type="error" showIcon message={t('skillFork.loadFailed')} description={query.error.message} />
      ) : data === undefined ? (
        <p className="ratio">{t('common.loading')}</p>
      ) : (
        <div className="stack stack--tight">
          {data.parentDeleted ? (
            <Alert type="warning" showIcon message={t('skillFork.sourceDeleted')} />
          ) : !data.parentAvailable ? (
            <Alert type="warning" showIcon message={t('skillFork.statusUnavailable')} />
          ) : data.upToDate ? (
            <Alert type="info" showIcon message={t('skillFork.diffUpToDate', { version: data.upstreamVersion ?? '' })} />
          ) : (
            <p className="ratio">
              {t('skillFork.diffLead', {
                from: data.syncedVersion ?? '—',
                upstream: data.upstreamVersion ?? '—',
              })}
            </p>
          )}

          {data.parentAvailable && !data.upToDate && !data.comparable ? (
            <Alert type="warning" showIcon message={t('skillFork.compareUnavailable')} />
          ) : null}
          {data.parentAvailable && !data.upToDate && data.comparable && data.hasLocalChanges ? (
            <Alert
              type="warning"
              showIcon
              message={t('skillFork.localChanges')}
              description={data.canThreeWay ? t('skillFork.threeWayHint') : undefined}
            />
          ) : null}

          {data.parentAvailable && !data.upToDate && data.canThreeWay && data.hasLocalChanges ? (
            conflicts.length === 0 ? (
              <Alert type="info" showIcon message={t('skillFork.mergeNoConflict')} />
            ) : (
              <div>
                <p className="block-label">{t('skillFork.conflictsTitle', { count: conflicts.length })}</p>
                <div className="stack stack--tight">
                  {conflicts.map((conflict) => (
                    <div key={conflict.anchor} className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                      <code>
                        {conflict.kind === 'section'
                          ? conflict.label || t('skillFork.sectionUntitled')
                          : conflict.label}
                      </code>
                      <Select
                        size="small"
                        style={{ minWidth: 180 }}
                        value={resolutions[conflict.anchor]}
                        placeholder={t('skillFork.chooseSide')}
                        onChange={(choice) =>
                          setResolutions((current) => ({ ...current, [conflict.anchor]: choice as SkillMergeChoice }))
                        }
                        options={MERGE_CHOICES.map((choice) => ({
                          value: choice,
                          label: translate(locale, MERGE_SIDE_KEY[choice]),
                        }))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : null}

          {data.parentAvailable && !data.upToDate ? (
            <>
              <Divider style={{ margin: 'var(--sp-3) 0' }} />
              <p className="block-label">{t('skillFork.diffSections')}</p>
              {sections.length === 0 ? <p className="ratio">{t('skillFork.diffNoChanges')}</p> : null}
              {sections.map((line, index) => (
                <div key={`${line.section}-${String(index)}`} className="card card--pad">
                  <div className="row row--wrap" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
                    {diffTag(line, t)}
                    <code>{line.section === '' ? t('skillFork.sectionUntitled') : line.section}</code>
                  </div>
                  {line.before === '' ? null : (
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, opacity: line.op === 'remove' ? 1 : 0.7 }}>
                      {line.before}
                    </pre>
                  )}
                  {line.after === '' ? null : (
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{line.after}</pre>
                  )}
                </div>
              ))}

              <p className="block-label" style={{ marginTop: 'var(--sp-3)' }}>
                {t('skillFork.diffFiles')}
              </p>
              {hasFileChanges ? (
                <div className="stack stack--tight">
                  <FileList label={t('skillFork.addedFiles')} paths={addedFiles} />
                  <FileList label={t('skillFork.removedFiles')} paths={removedFiles} />
                  <FileList label={t('skillFork.changedFiles')} paths={changedFiles} />
                </div>
              ) : (
                <p className="ratio">{t('skillFork.diffNoChanges')}</p>
              )}
            </>
          ) : null}
        </div>
      )}
    </Modal>
  )
}