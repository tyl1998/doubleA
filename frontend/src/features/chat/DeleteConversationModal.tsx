/**
 * 会话删除确认（P0-1-34；需求优化：去掉逐字输入确认）
 *
 * 依据：`docs/03-前端设计.md` §4.1（"删除走分级确认"）、§七「删除分级确认」；
 *      `docs/02` §4.5 ②（`DELETE` 响应带 `deletedMessages`，删前在同一个事务里数出来的）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 确认框里**给不出**消息条数
 * ─────────────────────────────────────────────────────────────────────
 * 本仓**没有任何端点能在删之前数出这个数**：`GET /:id/messages` 是游标分页、只回
 * `{items,nextCursor,hasMore}`（没有 `total`），而 `DELETE` 的 `deletedMessages` 是响应里的
 * （**删完之后**才拿得到）。于是这里如实写"**全部消息**"，真数在删除成功的提示里报出来。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 生成中删除：**允许**，但要说清会发生什么
 * ─────────────────────────────────────────────────────────────────────
 * 后端刻意**不按 `status` 拦删除**（`docs/02` §4.5 ⑦）。这里也**不**因为"正在生成"就禁用删除。
 *
 * ⚠️ 需求优化：删除**不再**要求逐字输入「删除」（去掉重复输入这层确认），保留级联危险标记与
 * 红色危险按钮，以及"正在生成时如实告知"的提示。
 */

import { Alert, Modal, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { ConversationItem, RemoveConversationResult } from '@doubulea/shared'

import { useRemoveConversation } from '../../api/conversations.js'
import { describeError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

export interface DeleteConversationModalProps {
  agentId: string
  /** 要删的会话；`null` = 弹窗关闭 */
  conversation: ConversationItem | null
  /** 这条会话此刻是不是**正在生成**（流 store 的 `streamFor`）—— 只影响提示语 */
  streaming: boolean
  onClose: () => void
  onDeleted: (removed: RemoveConversationResult) => void
}

export function DeleteConversationModal({
  agentId,
  conversation,
  streaming,
  onClose,
  onDeleted,
}: DeleteConversationModalProps) {
  const feedback = useFeedback()
  const { t } = useT()
  const remove = useRemoveConversation(agentId)
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次重新打开都清空上一次的错误
  useEffect(() => {
    setErrorText(null)
  }, [conversation?.id])

  if (conversation === null) return null

  const title = conversation.topic ?? t('deleteConversation.untitled')
  const removing = remove.isPending

  const confirm = (): void => {
    setErrorText(null)
    remove.mutate(conversation.id, {
      onSuccess: (result) => {
        feedback.ok(
          result.deletedMessages === 0
            ? t('deleteConversation.deletedOk', { title })
            : t('deleteConversation.deletedOkWithCount', { title, count: result.deletedMessages }),
        )
        onDeleted(result)
      },
      // 失败时不关弹窗：用户需要看到原因（404 = 另一个标签页刚删过）
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
          {t('deleteConversation.title', { title })}
          {/* 用 `tag--danger` 而不是 AntD 的预设色：全站"危险"只应该有一种红 */}
          <Tag className="tag--danger">{t('deleteConversation.cascadeTag')}</Tag>
        </span>
      }
      okText={t('deleteConversation.okText')}
      okButtonProps={{ danger: true, loading: removing }}
      cancelText={t('confirm.reject')}
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <p>
          {t('deleteConversation.bodyAllPrefix')}
          <strong>{t('deleteConversation.bodyAllStrong')}</strong>
          {t('deleteConversation.bodyAllSuffix')}
        </p>
        <p className="ratio">
          {t('deleteConversation.bodyScopePrefix')}
          <strong>{t('deleteConversation.bodyScopeStrong')}</strong>
          {t('deleteConversation.bodyScopeMid')}
          <strong>{t('deleteConversation.bodyScopeStrong2')}</strong>
          {t('deleteConversation.bodyScopeSuffix')}
        </p>

        {streaming && (
          <Alert
            type="warning"
            showIcon
            // ⚠️ 文案**刻意**不写「该会话正在生成中」：那是 `CONFLICT` 的专用短句，
            // 全仓的代码里只许有一处定义（`streamErrors.ts`）。
            message={t('deleteConversation.warnTitle')}
            description={t('deleteConversation.warnDescription')}
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={t('deleteConversation.failed')} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
