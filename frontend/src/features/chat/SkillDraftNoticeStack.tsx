/**
 * Skill 草稿提示卡栈（P1-24c-4c；`docs/子方案/会话生成Skill.md` §8.1.2）
 *
 * 与 `MemoryNoticeStack` 同族：事件驱动、可关闭、不常驻。拉取时机 = 会话变化 / 窗口聚焦 /
 * 每轮结束（`refreshKey` +1）—— 工具在本轮结束后才写完草稿，提示卡**晚一拍**出现。
 *
 * 卡片动作：
 *   · `审核草稿`（REVIEW）—— 打开宽版审核弹层，**不消费本条**（关闭后还能再打开）；
 *   · `让 Agent 修改`（LET_AGENT_REVISE）—— 收一句修改意见，写回对话输入框（由 Agent 调 `revise_skill_draft`）；
 *   · `只改本会话`（c-4b） / `复制为我的 Skill`（c-5）—— 能力位可用后放开；
 *   · `忽略` / 关闭 —— 消费本条（`DISMISS`），不重复弹。
 *
 * ⚠️ 卡片只给摘要 + 风险标签（正文详情在审核弹层里看；不把长 warnings 塞进卡片）。
 */

import { CloseOutlined } from '@ant-design/icons'
import { Button, Input, Modal, Tag, Tooltip } from 'antd'
import { useEffect, useState } from 'react'
import type { SkillDraftNotice } from '@doubulea/shared'

import { fetchSkillDraftNotices, mergeSkillDraftNotices, useSkillDraftNoticeAction } from '../../api/skillNotices.js'
import { useT } from '../../app/i18n.js'

export interface SkillDraftNoticeStackProps {
  conversationId: string | undefined
  /** 每轮结束后 +1（父组件维护）—— 变化即触发一次拉取 */
  refreshKey: number
  /** 点「审核草稿」：父组件打开审核弹层（草稿 id 一定非空） */
  onReview: (draftId: string) => void
  /** 点「让 Agent 修改」：父组件把意见写回对话输入框 */
  onLetAgentRevise: (draftId: string, instruction: string) => void
  /** 点「只改本会话」：父组件生成 `SESSION_OVERRIDE` 草稿并打开审核弹层（c-4b） */
  onEditInSession: (notice: SkillDraftNotice) => void
  /** 点「复制为我的 Skill」：父组件 fork 一份私有副本并跳转（c-5） */
  onFork: (notice: SkillDraftNotice) => void
}

export function SkillDraftNoticeStack({
  conversationId,
  refreshKey,
  onReview,
  onLetAgentRevise,
  onEditInSession,
  onFork,
}: SkillDraftNoticeStackProps) {
  const [notices, setNotices] = useState<SkillDraftNotice[]>([])
  const [reviseTarget, setReviseTarget] = useState<SkillDraftNotice | null>(null)
  const [instruction, setInstruction] = useState('')
  const { t } = useT()
  const action = useSkillDraftNoticeAction(conversationId)

  /**
   * 切会话先清空。提示卡是**会话级**的（Redis `skill-draft-notice:{conversationId}`），
   * 但下面那次拉取用的是 `mergeSkillDraftNotices`（为了跨刷新不丢卡片）。不先清空，
   * 切到一个没有提示的会话时旧卡会跟着留下来 —— 看起来像"审核横幅跟着人走"。
   */
  useEffect(() => {
    setNotices([])
    setReviseTarget(null)
    setInstruction('')
  }, [conversationId])

  useEffect(() => {
    if (conversationId === undefined) {
      setNotices([])
      return
    }
    let cancelled = false
    const pull = (): void => {
      void fetchSkillDraftNotices(conversationId)
        .then((result) => {
          if (cancelled) return
          if (result.items.length === 0) {
            // 服务端已经没有本会话的提示 ⇒ 本地也不该继续留着（消费 / 过期都在服务端生效）
            setNotices([])
            return
          }
          setNotices((previous) => mergeSkillDraftNotices(previous, result.items))
        })
        .catch(() => {
          /* 提示读不到不影响对话 */
        })
    }
    pull()
    window.addEventListener('focus', pull)
    return () => {
      cancelled = true
      window.removeEventListener('focus', pull)
    }
  }, [conversationId, refreshKey])

  function drop(notice: SkillDraftNotice): void {
    setNotices((previous) => previous.filter((item) => item.id !== notice.id))
  }

  function consume(notice: SkillDraftNotice, kind: 'OPEN' | 'DISMISS'): void {
    drop(notice)
    action.mutate({ noticeId: notice.id, body: { action: kind } })
  }

  function review(notice: SkillDraftNotice): void {
    if (notice.draftId === null) return
    // ⚠️ **不消费**：只打开审核弹层。草稿没保存 / 没丢弃之前，这张卡必须留在会话里 ——
    // 关闭弹层或重新进会话后这就是重新打开的入口。保存 / 丢弃后草稿消失，下一次拉取自然过滤掉。
    onReview(notice.draftId)
  }

  function submitRevise(): void {
    const target = reviseTarget
    const text = instruction.trim()
    if (target === null || target.draftId === null || text === '') return
    consume(target, 'DISMISS')
    onLetAgentRevise(target.draftId, text)
    setReviseTarget(null)
    setInstruction('')
  }

  if (notices.length === 0) {
    return (
      <Modal
        open={reviseTarget !== null}
        title={t('skillNotice.revisePromptTitle')}
        okText={t('skillNotice.revisePromptSend')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: instruction.trim() === '' }}
        onOk={submitRevise}
        onCancel={() => {
          setReviseTarget(null)
          setInstruction('')
        }}
      >
        <p className="ratio">{t('skillNotice.revisePromptHint')}</p>
        <Input.TextArea
          rows={4}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t('skillNotice.revisePromptPlaceholder')}
        />
      </Modal>
    )
  }

  return (
    <>
      <div className="column" style={{ gap: 'var(--sp-2)', padding: '0 var(--sp-4)', marginTop: 'var(--sp-2)' }}>
        {notices.map((notice) => {
          const title =
            notice.kind === 'FOREIGN'
              ? t('skillNotice.foreignTitle', { name: notice.targetName ?? '' })
              : notice.kind === 'REVISION'
                ? t('skillNotice.revisionTitle', { name: notice.targetName ?? '' })
                : notice.kind === 'SESSION_OVERRIDE'
                  ? t('skillNotice.overrideTitle', { name: notice.targetName ?? '' })
                  : t('skillNotice.createTitle')
          return (
            <div
              key={notice.id}
              className="card card--pad"
              data-testid="skill-draft-notice"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-3)' }}
            >
              <div className="column" style={{ flex: 1, minWidth: 0, gap: 'var(--sp-1)' }}>
                <span style={{ fontWeight: 600 }}>{title}</span>
                {notice.fromVersion !== null && notice.toVersion !== null ? (
                  <span className="ratio num">
                    {t('skillNotice.versionTransition', { from: notice.fromVersion, to: notice.toVersion })}
                  </span>
                ) : null}
                {notice.changeSummary.trim() === '' ? null : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{notice.changeSummary}</span>
                )}
                {notice.reason === null ? null : <span className="ratio">{notice.reason}</span>}
                {notice.risks.length === 0 ? null : (
                  <div className="row row--wrap" style={{ gap: 'var(--sp-1)' }}>
                    {notice.risks.map((risk) => (
                      <Tag key={risk} color="orange">
                        {risk}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
              <div className="row row--wrap" style={{ gap: 'var(--sp-1)', justifyContent: 'flex-end' }}>
                {notice.actions.includes('REVIEW') ? (
                  <Button type="primary" size="small" onClick={() => review(notice)}>
                    {t('skillNotice.review')}
                  </Button>
                ) : null}
                {notice.actions.includes('LET_AGENT_REVISE') ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setInstruction('')
                      setReviseTarget(notice)
                    }}
                  >
                    {t('skillNotice.letAgentRevise')}
                  </Button>
                ) : null}
                {notice.actions.includes('EDIT_IN_SESSION') ? (
                  notice.canOverride ? (
                    <Button
                      size="small"
                      onClick={() => {
                        consume(notice, 'DISMISS')
                        onEditInSession(notice)
                      }}
                    >
                      {t('skillNotice.editInSession')}
                    </Button>
                  ) : (
                    <Tooltip title={t('skillNotice.offlineAction')}>
                      <Button size="small" disabled>
                        {t('skillNotice.editInSession')}
                      </Button>
                    </Tooltip>
                  )
                ) : null}
                {notice.actions.includes('FORK') ? (
                  notice.canFork ? (
                    <Button
                      size="small"
                      onClick={() => {
                        consume(notice, 'DISMISS')
                        onFork(notice)
                      }}
                    >
                      {t('skillNotice.fork')}
                    </Button>
                  ) : (
                    <Tooltip title={t('skillNotice.offlineAction')}>
                      <Button size="small" disabled>
                        {t('skillNotice.fork')}
                      </Button>
                    </Tooltip>
                  )
                ) : null}
                <Button
                  type="text"
                  size="small"
                  aria-label={t('skillNotice.dismiss')}
                  title={t('skillNotice.dismiss')}
                  style={{ padding: 0 }}
                  onClick={() => consume(notice, 'DISMISS')}
                >
                  <CloseOutlined />
                </Button>
              </div>
            </div>
          )
        })}
      </div>
      <Modal
        open={reviseTarget !== null}
        title={t('skillNotice.revisePromptTitle')}
        okText={t('skillNotice.revisePromptSend')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: instruction.trim() === '' }}
        onOk={submitRevise}
        onCancel={() => {
          setReviseTarget(null)
          setInstruction('')
        }}
      >
        <p className="ratio">{t('skillNotice.revisePromptHint')}</p>
        <Input.TextArea
          rows={4}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t('skillNotice.revisePromptPlaceholder')}
        />
      </Modal>
    </>
  )
}
