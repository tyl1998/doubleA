/**
 * 知识库级联删除确认（P0-1-35；需求优化：去掉逐字输入确认、被引用时改为"自动解绑 + 提示"）
 *
 * 依据：`docs/03` §七「删除分级确认」——**级联删除 = Modal + 红色危险按钮 + 明示影响范围**；
 *      `docs/02` §4.6（删库连带 `documents` / `chunks` / S3 原文件、并**自动解绑**引用它的智能体）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条与"数字"有关的如实说明
 * ─────────────────────────────────────────────────────────────────────
 * ① **文档数拿得到**（`KnowledgeBaseItem.documentCount`），所以这里能写"将同时删除 N 篇文档"。
 * ② **片段数拿不到**：没有任何端点回答"这个库里一共有多少 chunk"，文案只说文档数。
 *
 * ⚠️ **被智能体引用不再挡删除**（2026-10-08 需求）：`agentCount > 0` 时后端会**自动解绑**
 * （与"删 Agent 自动把 model_id 置空"同族），这里只**提示**"删除后会解除 N 个智能体的绑定"，
 * 不再禁用按钮、也不再让用户先去逐个解绑。
 *
 * ⚠️ 删除**不要求**逐字输入库名（去掉重复输入这层确认）；仍保留级联危险标记、明示影响范围、
 * 红色危险按钮。
 */

import { Alert, Modal, Tag } from 'antd'
import type { KnowledgeBaseItem, RemoveKnowledgeBaseResult } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useRemoveKnowledgeBase } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

export interface DeleteKnowledgeBaseModalProps {
  /** 要删的库；`null` = 弹窗关闭 */
  kb: KnowledgeBaseItem | null
  open: boolean
  onClose: () => void
  onDeleted?: (result: RemoveKnowledgeBaseResult) => void
}

export function DeleteKnowledgeBaseModal({ kb, open, onClose, onDeleted }: DeleteKnowledgeBaseModalProps) {
  const feedback = useFeedback()
  const { t } = useT()
  const remove = useRemoveKnowledgeBase()
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次打开都清空上一次的错误
  useEffect(() => {
    setErrorText(null)
  }, [open, kb])

  if (kb === null) return null

  const removing = remove.isPending
  const bound = kb.agentCount > 0

  const confirm = (): void => {
    setErrorText(null)
    remove.mutate(kb.id, {
      onSuccess: (result) => {
        const unbound =
          result.unboundAgents > 0 ? t('deleteKb.unboundSuffix', { count: result.unboundAgents }) : ''
        feedback.ok(
          t('deleteKb.deleted', {
            name: result.name,
            docs: result.deletedDocuments,
            objects: result.deletedObjects,
            unbound,
          }),
        )
        onClose()
        onDeleted?.(result)
      },
      onError: (error) => {
        // 失败不关弹窗：404（别人已经删了）之类需要他看到
        setErrorText(describeError(error).message)
      },
    })
  }

  return (
    <Modal
      open={open}
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          {t('deleteKb.title', { name: kb.name })}
          <Tag className="tag--danger">{t('deleteKb.cascadeTag')}</Tag>
        </span>
      }
      okText={t('deleteKb.okText')}
      okButtonProps={{ danger: true, loading: removing }}
      cancelText={t('common.cancel')}
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <div>
          <p>
            <strong>{t('deleteKb.bodyTitle')}</strong>
          </p>
          <ul>
            <li>{t('deleteKb.bodyDoc1', { count: kb.documentCount })}</li>
            <li>{t('deleteKb.bodyDoc2')}</li>
            <li>{t('deleteKb.bodyDoc3')}</li>
          </ul>
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            {t('deleteKb.irreversiblePrefix')}
            <strong>{t('deleteKb.irreversibleStrong')}</strong>
            {t('deleteKb.irreversibleSuffix')}
          </p>
        </div>

        {bound && (
          <Alert
            type="warning"
            showIcon
            message={t('deleteKb.boundTitle', { count: kb.agentCount })}
            description={t('deleteKb.boundDesc')}
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={t('deleteKb.failed')} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
