/**
 * 会话删除确认（P0-1-34）
 *
 * 依据：`docs/03-前端设计.md` §4.1（"删除走分级确认"）、§七「删除分级确认」——**级联删除
 *      （Agent / 会话）= Modal + 红色危险按钮 + 明示影响范围**；`design/chat.html` 的
 *      `#conv-delete`（**输入「删除」逐字确认**）；`docs/02` §4.5 ②（`DELETE` 响应带
 *      `deletedMessages`，且它是**删前在同一个事务里数出来的**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 确认框里**给不出**消息条数 —— 这是与 Agent 那个弹窗最大的不同
 * ─────────────────────────────────────────────────────────────────────
 * `design/chat.html` 写的是"将同时删除该会话的 **6** 条消息"。但本仓**没有任何端点能在删之前
 * 数出这个数**：`GET /:id/messages` 是游标分页、只回 `{items,nextCursor,hasMore}`（没有 `total`），
 * 而 `DELETE` 的 `deletedMessages` 是响应里的（**删完之后**才拿得到）。
 * 于是这里如实写"**全部消息**"，不编一个数字 —— 与 `DeleteAgentModal` 处置"会话数取不到"
 * 时同一个口径（`docs/03` §七：不造假）。真数在**删除成功的提示**里报出来
 * （`ChatPage` 的 `onDeleted` 用响应里的 `deletedMessages`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 生成中删除：**允许**，但要说清会发生什么
 * ─────────────────────────────────────────────────────────────────────
 * 后端刻意**不按 `status` 拦删除**（`docs/02` §4.5 ⑦：用户要能清理自己的历史）。这里也**不**
 * 因为"正在生成"就禁用删除 —— 那是自己发明约束（P0-1-11 的教训）。能做的是**如实告知**：
 * 这一轮的回答不会落库（会话行都没了），本地那条流也会被就地收掉。
 */

import { Alert, Input, Modal, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { ConversationItem, RemoveConversationResult } from '@doubulea/shared'

import { useRemoveConversation } from '../../api/conversations.js'
import { describeError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { CONVERSATION_DELETE_CONFIRM_WORD, isDeleteConfirmed } from './conversationList.js'

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
  const remove = useRemoveConversation(agentId)
  const [typed, setTyped] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次重新打开都清空上一次的输入与错误 —— 否则"确认删除"会带着上一次敲的词亮着
  useEffect(() => {
    setTyped('')
    setErrorText(null)
  }, [conversation?.id])

  if (conversation === null) return null

  const title = conversation.topic ?? '未命名会话'
  const confirmed = isDeleteConfirmed(typed)
  const removing = remove.isPending

  const confirm = (): void => {
    setErrorText(null)
    remove.mutate(conversation.id, {
      onSuccess: (result) => {
        feedback.ok(
          result.deletedMessages === 0
            ? `已删除会话「${title}」`
            : `已删除会话「${title}」与其中的 ${result.deletedMessages} 条消息`,
        )
        onDeleted(result)
      },
      // 失败时不关弹窗：用户需要看到原因（404 = 另一个标签页刚删过；403 之类不会出现，
      // 会话是"仅本人"那族权限，别人的 id 直接 404）
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
          删除会话「{title}」
          {/* 用 `tag--danger` 而不是 AntD 的预设色：全站"危险"只应该有一种红
              （色值只在 `styles/tokens.css` 定义，`docs/03` §一） */}
          <Tag className="tag--danger">级联删除</Tag>
        </span>
      }
      okText="确认删除"
      okButtonProps={{ danger: true, disabled: !confirmed, loading: removing }}
      cancelText="取消"
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <p>
          将删除该会话的<strong>全部消息</strong>（含其中的引用卡与工具调用记录）。
        </p>
        <p className="ratio">
          删除会话<strong>不影响</strong>智能体与知识库；这一轮的回答与消息<strong>无法恢复</strong>
          ，P0-1 没有回收站。
        </p>

        {streaming && (
          <Alert
            type="warning"
            showIcon
            // ⚠️ 文案**刻意**不写「该会话正在生成中」：那是 `CONFLICT` 的专用短句，
            // 全仓的代码里只许有一处定义（`streamErrors.ts`），并由验收档 J4 用"代码里恰好
            // 出现一次"守着。这里顺手复用一句看着更顺的话，会让那条守门断言变红 ——
            // 而它变红时看起来像"守门坏了"，不像"我写了一处不该写的文案"（P0-1-29 的 ⑰ 号教训）。
            message="删除的是一个正在生成的会话"
            description="删除会同时收掉界面上这一轮的回答；服务端那条流随后也会结束，它已经生成的正文不会落库。"
          />
        )}

        {errorText !== null && <Alert type="error" showIcon message="删除失败" description={errorText} />}

        <div>
          <p>该操作不可恢复，请输入「{CONVERSATION_DELETE_CONFIRM_WORD}」以确认：</p>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={CONVERSATION_DELETE_CONFIRM_WORD}
            aria-label={`输入${CONVERSATION_DELETE_CONFIRM_WORD}以确认删除`}
            onPressEnter={() => {
              if (confirmed && !removing) confirm()
            }}
          />
          {/* 与 Agent 的"输入名称"同理：`isDeleteConfirmed` **不做 trim**（多一个空格就不算），
              原因写在那个函数上 —— 逐字确认的全部意义就是逼用户慢下来 */}
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            需逐字一致，前后多一个空格都不算
          </p>
        </div>
      </div>
    </Modal>
  )
}
