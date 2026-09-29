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
          feedback.ok('已撤回，正文已放回输入框（可修改后重新发送）')
        } else {
          feedback.ok(
            result.deletedMessages === 0
              ? '已撤回最新一轮'
              : `已撤回最新一轮（删除 ${result.deletedMessages} 条消息${result.deletedArtifacts > 0 ? `、${result.deletedArtifacts} 个产物` : ''}）`,
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
          {target.resend ? '修改重发' : '撤回最新一轮'}
          <Tag className="tag--danger">仅最新一轮</Tag>
        </span>
      }
      okText={target.resend ? '撤回并修改' : '确认撤回'}
      okButtonProps={{ danger: true, loading: recalling }}
      cancelText="取消"
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!recalling}
    >
      <div className="stack stack--tight">
        <p>
          将删除本会话<strong>最新一轮</strong>（你的问题与这一轮的回答）。
          {target.resend && <>正文会放回输入框，改完再发会生成一轮新的回答。</>}
        </p>

        {target.hadTools && (
          <Alert
            type="warning"
            showIcon
            message="这一轮调用过工具"
            description="工具的执行效果（如写入数据、调用外部系统）已经发生，撤回无法复原这些操作。"
          />
        )}

        <p className="ratio">
          撤回不会影响更早的对话；已删除的这一轮<strong>无法恢复</strong>（P0 没有回收站）。
        </p>

        {errorText !== null && <Alert type="error" showIcon message="撤回失败" description={errorText} />}
      </div>
    </Modal>
  )
}