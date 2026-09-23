/**
 * 知识库级联删除确认（P0-1-35）
 *
 * 依据：`docs/03` §七「删除分级确认」——**级联删除 = Modal + 红色危险按钮 + 明示影响范围**；
 *      `design/agents.html` 的 `#cascade-modal`（输入名称逐字确认）是本仓"级联"那一档的落地形态
 *      （`pages/agents/DeleteAgentModal.tsx` 已按它做过一次）；`docs/02` §4.6（删库连带
 *      `documents` / `chunks` / S3 原文件，且**被智能体绑定时 409**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条与"数字"有关的如实说明
 * ─────────────────────────────────────────────────────────────────────
 * ① **文档数拿得到**（`KnowledgeBaseItem.documentCount`），所以这里能写"将同时删除 N 篇文档"
 *    —— 这与删会话时"给不出消息条数"（游标分页没有 `total`）是**两种不同的处境**，
 *    别把那条结论套过来（`docs/06` §六：界面上有数字 ≠ 能拿到这个数字，反之亦然）。
 * ② **片段数拿不到**：没有任何端点回答"这个库里一共有多少 chunk"（文档列表只有每篇的
 *    `chunkCount`）。所以文案只说文档数，不写"213 个片段"（原型上那个数字在这里**取不到**）。
 *
 * 409（`agentCount > 0`）是这条链路上最需要界面上有出路的一种失败：后端不会因为"你说了确认"
 * 就放行。处置是**不关弹窗、把服务端那句话显示出来，并给出"去智能体列表解绑"的链接**
 * —— 提示指向一个可操作的地方，而不是让用户对着一个红条猜。
 */

import { Alert, Input, Modal, Tag } from 'antd'
import type { KnowledgeBaseItem, RemoveKnowledgeBaseResult } from '@doubulea/shared'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { describeError } from '../../api/client.js'
import { useRemoveKnowledgeBase } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH } from '../../app/paths.js'
import { isKnowledgeDeleteConfirmed } from './knowledgeModel.js'

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
  const [typed, setTyped] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次打开都清空 —— 否则"确认删除"按钮会带着上一个库的名字亮着
  useEffect(() => {
    setTyped('')
    setErrorText(null)
  }, [open, kb])

  if (kb === null) return null

  const confirmed = isKnowledgeDeleteConfirmed(typed, kb.name)
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
      okButtonProps={{ danger: true, disabled: !confirmed || bound, loading: removing }}
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

        <div>
          <p>请输入知识库名称以确认：</p>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={kb.name}
            aria-label="输入知识库名称以确认删除"
            onPressEnter={() => {
              if (confirmed && !removing && !bound) confirm()
            }}
          />
          {/* 与删智能体同款：`isKnowledgeDeleteConfirmed` **不做 trim**（多一个空格就不算），
              逐字确认的全部意义就是逼用户慢下来 */}
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            名称需逐字一致（含大小写与空格）
          </p>
        </div>
      </div>
    </Modal>
  )
}
