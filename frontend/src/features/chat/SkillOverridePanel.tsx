/**
 * 本会话的 Skill 覆写列表（P1-24c-4b；`子方案/Skill能力.md` §5.16.6 入口 3）
 *
 * 这里**只是已存在覆写的管理入口**（查看 / 按上游重建 / 提交更新建议 / 另存为我的 Skill / 放弃），不是新建入口：
 * 新建入口是 Agent 工具 + `SkillDraftNotice` 提示卡的「只改本会话」；
 * 「另存为我的 Skill」自 P1-24c-5 起可用（服务端先 fork、再删覆写）；
 * 「提交更新建议」直接把这份覆写建成 `PROPOSAL` 草稿（不 fork），`canPropose` = 目标 Skill 不是我的。
 */

import { DeleteOutlined, ReloadOutlined, ShareAltOutlined, FileAddOutlined } from '@ant-design/icons'
import { Button, Modal, Tag } from 'antd'
import type { ReactNode } from 'react'

import { useT } from '../../app/i18n.js'
import { useFeedback } from '../../app/feedback.js'
import {
  useConversationSkillOverrides,
  useDeleteConversationSkillOverride,
  useProposalDraftFromOverride,
  usePromoteConversationSkillOverride,
  useRebaseConversationSkillOverride,
} from '../../api/skillOverrides.js'

export function SkillOverridePanel({
  conversationId,
  open,
  onClose,
  onReviewDraft,
}: {
  conversationId: string | undefined
  open: boolean
  onClose: () => void
  /** 按当前上游重建出的草稿 ⇒ 打开审核弹层 */
  onReviewDraft: (draftId: string) => void
}): ReactNode {
  const { t } = useT()
  const feedback = useFeedback()
  const query = useConversationSkillOverrides(open ? conversationId : undefined)
  const remove = useDeleteConversationSkillOverride(conversationId ?? '')
  const rebase = useRebaseConversationSkillOverride(conversationId ?? '')
  const promote = usePromoteConversationSkillOverride(conversationId ?? '')
  const proposal = useProposalDraftFromOverride(conversationId ?? '')

  const items = query.data?.items ?? []

  return (
    <Modal
      open={open}
      title={t('skillOverride.listTitle')}
      footer={null}
      width={720}
      onCancel={onClose}
    >
      <p className="ratio" style={{ marginTop: 0 }}>
        {t('skillOverride.listLead')}
      </p>
      {items.length === 0 ? (
        <p className="ratio">{t('skillOverride.listEmpty')}</p>
      ) : (
        <div className="stack stack--tight">
          {items.map((item) => (
            <div key={item.id} className="card card--pad" style={{ display: 'flex', gap: 'var(--sp-3)' }}>
              <div className="column" style={{ flex: 1, minWidth: 0, gap: 'var(--sp-1)' }}>
                <span style={{ fontWeight: 600 }}>{item.skillName}</span>
                <span className="ratio num">
                  {t('skillOverride.listLine', {
                    basedOn: item.basedOnVersion,
                    revision: item.revision,
                  })}
                </span>
                {item.changeSummary.trim() === '' ? null : <span>{item.changeSummary}</span>}
                {item.upstreamUpdated ? (
                  <Tag color="orange">{t('skillOverride.upstreamUpdated', { version: item.currentSkillVersion })}</Tag>
                ) : null}
              </div>
              <div className="row row--wrap" style={{ gap: 'var(--sp-1)', justifyContent: 'flex-end' }}>
                {item.upstreamUpdated ? (
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={rebase.isPending}
                    onClick={() =>
                      rebase.mutate(item.id, {
                        onSuccess: (draft) => {
                          onClose()
                          onReviewDraft(draft.id)
                        },
                        onError: (error) => feedback.fail(error, t('skillOverride.rebaseFailed')),
                      })
                    }
                  >
                    {t('skillOverride.rebase')}
                  </Button>
                ) : null}
                {item.canPropose ? (
                  <Button
                    size="small"
                    icon={<FileAddOutlined />}
                    loading={proposal.isPending && proposal.variables === item.id}
                    onClick={() =>
                      proposal.mutate(item.id, {
                        onSuccess: (draft) => {
                          onClose()
                          onReviewDraft(draft.id)
                        },
                        onError: (error) => feedback.fail(error, t('skillProposal.createFailed')),
                      })
                    }
                  >
                    {t('skillProposal.submit')}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  icon={<ShareAltOutlined />}
                  loading={promote.isPending && promote.variables === item.id}
                  onClick={() => {
                    Modal.confirm({
                      title: t('skillFork.promoteConfirmTitle'),
                      content: t('skillFork.promoteConfirmDesc'),
                      okText: t('skillOverride.promote'),
                      cancelText: t('common.cancel'),
                      onOk: () =>
                        new Promise<void>((resolve) => {
                          promote.mutate(item.id, {
                            onSuccess: (result) => {
                              feedback.ok(
                                result.overrideDeleted
                                  ? t('skillFork.promoteOk', { name: result.skill.name })
                                  : t('skillFork.promotePartial'),
                              )
                              resolve()
                            },
                            onError: (error) => {
                              feedback.fail(error, t('skillFork.promoteFailed'))
                              resolve()
                            },
                          })
                        }),
                    })
                  }}
                >
                  {t('skillOverride.promote')}
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    Modal.confirm({
                      title: t('skillOverride.discardTitle', { name: item.skillName }),
                      content: t('skillOverride.discardDesc'),
                      okText: t('skillOverride.discardOk'),
                      okButtonProps: { danger: true },
                      cancelText: t('common.cancel'),
                      onOk: () =>
                        new Promise<void>((resolve) => {
                          remove.mutate(item.id, {
                            onSuccess: () => {
                              feedback.ok(t('skillOverride.discarded'))
                              resolve()
                            },
                            onError: (error) => {
                              feedback.fail(error, t('skillOverride.discardFailed'))
                              resolve()
                            },
                          })
                        }),
                    })
                  }}
                >
                  {t('skillOverride.discard')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}