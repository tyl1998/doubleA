/**
 * 撤回最新一轮的确认（产品优化 2026-09-29）
 *
 * 产品口径："当前会话有 3 轮时，只能对最新的一轮撤回 / 修改重发"。两个动作（撤回 / 修改重发）
 * 共用这一个弹窗：`resend` 决定成功之后要不要把原文放回输入框。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ "调用过工具"的警告是**事前**说清的
 * ─────────────────────────────────────────────────────────────────────
 * 这一轮若调用过 MCP / 沙箱工具，执行效果（写库、改文件、发请求）**已经发生、无法复原**。
 * 界面必须在用户按下「确认撤回」之前把这件事说清楚（`hadTools` 由页面从已加载的历史里判，
 * 判据是紧随其后的助手消息有没有工具卡 —— 不是服务端另算的）。
 *
 * 确认语义与 `DeleteConversationModal` 同款：失败时不关弹窗（404 = 另一个标签页刚撤过）。
 */

import { Alert, Modal, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { RecallConversationResult } from '@doubulea/shared'

import { useRecallLastRound } from '../../api/conversations.js'
import { describeError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

/** 撤回目标：`null` = 弹窗关闭 */
export interface RecallTarget {
  /** 这一轮用户消息的正文（修改重发时要放回输入框） */
  text: string
  /** 这一轮是否调用过工具（决定要不要事前警告"效果无法复原"） */
  hadTools: boolean
  /** `true` = 修改重发（撤回后把原文放回输入框）；`false` = 只撤回 */
  resend: boolean
}

export interface RecallConversationModalProps {
  agentId: string
  /** 当前会话 id（撤回端点的路径参数）；目标存在时必有会话，这里收非空 */
  conversationId: string
  target: RecallTarget | null
  onClose: () => void
  onRecalled: (result: RecallConversationResult, target: RecallTarget) => void
}

export function RecallConversationModal({
  agentId,
  conversationId,
  target,
  onClose,
  onRecalled,
}: RecallConversationModalProps) {
  const feedback = useFeedback()
  const { t } = useT()
  const recall = useRecallLastRound(agentId)
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次重新打开都清空上一次的错误
  useEffect(() => {
    setErrorText(null)
  }, [target])

  if (target === null) return null

  const recalling = recall.isPending

  const confirm = (): void => {
    setErrorText(null)
    recall.mutate(conversationId, {
      onSuccess: (result) => {
        if (target.resend) {
          feedback.ok(t('recall.okResendDone'))
        } else {
          feedback.ok(
            result.deletedMessages === 0
              ? t('recall.okRecallDone')
              : t('recall.okRecallDoneWithCount', {
                  messages: result.deletedMessages,
                  artifacts:
                    result.deletedArtifacts > 0
                      ? t('recall.okRecallDoneArtifacts', { count: result.deletedArtifacts })
                      : '',
                }),
          )
        }
        onRecalled(result, target)
      },
      onError: (error) => {
        setErrorText(describeError(error).message)
      },
    })
  }

  return (
    <Modal
      open
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          {target.resend ? t('recall.titleResend') : t('recall.titleRecall')}
          <Tag className="tag--danger">{t('recall.tag')}</Tag>
        </span>
      }
      okText={target.resend ? t('recall.okResend') : t('recall.okRecall')}
      okButtonProps={{ danger: true, loading: recalling }}
      cancelText={t('confirm.reject')}
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!recalling}
    >
      <div className="stack stack--tight">
        <p>
          {t('recall.bodyPrefix')}
          <strong>{t('recall.bodyStrong')}</strong>
          {t('recall.bodySuffix')}
          {target.resend && <>{t('recall.bodyResendSuffix')}</>}
        </p>

        {target.hadTools && (
          <Alert
            type="warning"
            showIcon
            message={t('recall.toolsTitle')}
            description={t('recall.toolsDescription')}
          />
        )}

        <p className="ratio">
          {t('recall.footPrefix')}
          <strong>{t('recall.footStrong')}</strong>
          {t('recall.footSuffix')}
        </p>

        {errorText !== null && (
          <Alert type="error" showIcon message={t('recall.failed')} description={errorText} />
        )}
      </div>
    </Modal>
  )
}