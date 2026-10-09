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

export interface DeleteKnowledgeBaseModalProps {
  /** 要删的库；`null` = 弹窗关闭 */
  kb: KnowledgeBaseItem | null
  open: boolean
  onClose: () => void
  onDeleted?: (result: RemoveKnowledgeBaseResult) => void
}

export function DeleteKnowledgeBaseModal({ kb, open, onClose, onDeleted }: DeleteKnowledgeBaseModalProps) {
  const feedback = useFeedback()
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
          result.unboundAgents > 0 ? `，并解绑了 ${result.unboundAgents} 个智能体` : ''
        feedback.ok(
          `已删除知识库「${result.name}」：连带删除 ${result.deletedDocuments} 篇文档` +
            `（清理 ${result.deletedObjects} 个原始文件对象）${unbound}`,
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
          删除知识库「{kb.name}」
          <Tag className="tag--danger">级联删除</Tag>
        </span>
      }
      okText="确认删除"
      okButtonProps={{ danger: true, loading: removing }}
      cancelText="取消"
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <div>
          <p>
            <strong>此操作会连带做三件事：</strong>
          </p>
          <ul>
            <li>
              删除库内的 <span className="num">{kb.documentCount}</span> 篇文档记录
            </li>
            <li>连同它们的全部片段（chunk）与向量一起清除</li>
            <li>删除对象存储里的原始文件</li>
          </ul>
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            操作<strong>不可恢复</strong>：没有回收站，删错了只能重新建库并重传文档。
          </p>
        </div>

        {bound && (
          <Alert
            type="warning"
            showIcon
            message={`该库正被 ${kb.agentCount} 个智能体引用`}
            description="删除后会自动解除这些智能体的绑定（无需先去手动解绑）；它们本身不受影响，只是对话时检索不到这个库的内容。"
          />
        )}

        {errorText !== null && <Alert type="error" showIcon message="删除失败" description={errorText} />}
      </div>
    </Modal>
  )
}
