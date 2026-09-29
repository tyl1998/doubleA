/**
 * 知识库级联删除确认（P0-1-35；需求优化：去掉逐字输入确认）
 *
 * 依据：`docs/03` §七「删除分级确认」——**级联删除 = Modal + 红色危险按钮 + 明示影响范围**；
 *      `docs/02` §4.6（删库连带 `documents` / `chunks` / S3 原文件，且**被智能体绑定时 409**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条与"数字"有关的如实说明
 * ─────────────────────────────────────────────────────────────────────
 * ① **文档数拿得到**（`KnowledgeBaseItem.documentCount`），所以这里能写"将同时删除 N 篇文档"。
 * ② **片段数拿不到**：没有任何端点回答"这个库里一共有多少 chunk"，文案只说文档数。
 *
 * 409（`agentCount > 0`）是这条链路上最需要界面上有出路的一种失败：后端不会因为"你点了确认"
 * 就放行。处置是**禁用删除按钮、把原因显示出来，并给出"去智能体列表解绑"的链接**。
 *
 * ⚠️ 需求优化：删除**不再**要求逐字输入库名（去掉重复输入这层确认）；仍保留级联危险标记、
 * 明示影响范围、红色危险按钮，以及"被智能体绑定时禁用删除（409）"的守卫。
 */

import { Alert, Modal, Tag } from 'antd'
import type { KnowledgeBaseItem, RemoveKnowledgeBaseResult } from '@doubulea/shared'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { describeError } from '../../api/client.js'
import { useRemoveKnowledgeBase } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH } from '../../app/paths.js'

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
        feedback.ok(
          `已删除知识库「${result.name}」：连带删除 ${result.deletedDocuments} 篇文档` +
            `（清理 ${result.deletedObjects} 个原始文件对象）`,
        )
        onClose()
        onDeleted?.(result)
      },
      onError: (error) => {
        // 失败不关弹窗：409 需要用户看到"被哪些东西占着"，404 需要他看到"别人已经删了"
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
      okButtonProps={{ danger: true, disabled: bound, loading: removing }}
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
            操作<strong>不可恢复</strong>：P0-1 没有回收站，删错了只能重新建库并重传文档。
            绑定了这个库的智能体不受影响，但对话时检索不到这里的任何内容。
          </p>
        </div>

        {bound && (
          <Alert
            type="error"
            showIcon
            message={`该库正被 ${kb.agentCount} 个智能体引用，删不掉`}
            description={
              <>
                后端会拒绝这次删除（<code>409</code>）。请先到
                <Link to={HOME_PATH}> 智能体列表 </Link>
                打开用它的智能体，在「组件绑定」里取消勾选这个库并保存，再回来删除。
              </>
            }
          />
        )}

        {errorText !== null && <Alert type="error" showIcon message="删除失败" description={errorText} />}
      </div>
    </Modal>
  )
}
