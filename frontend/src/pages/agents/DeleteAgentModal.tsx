/**
 * 智能体级联删除确认（P0-1-31）
 *
 * 依据：`docs/03-前端设计.md` §七「删除分级确认」——**级联删除（Agent / 会话）= Modal + 红色危险
 *      按钮 + 明示影响范围**；`design/agents.html` 的 `#cascade-modal`（另加"输入名称逐字确认"）；
 *      `docs/02` §4.4（删除是**软删**：组件解绑 + 会话转只读保留）；`shared/src/agent.ts` 文件头 ③。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件最要紧的一件事：**原型的文案与后端语义不符，落地必须以后端为准**
 * ─────────────────────────────────────────────────────────────────────
 * 原型写的是"将同时**删除** 3 个会话及其全部消息（含工具调用记录与引用）"。实现里
 * `removeAgent` 做的是 **软删**：`deleted_at` 打标记 + 删 `agent_components` +
 * 该 Agent 的 `conversations.status` 转 `FINISHED`（**会话与消息都留着**，只是不能再发消息）。
 * 照抄原型文案就是**对用户撒谎**（用户以为消息没了，实际还在；反过来他若想清理数据，
 * 也会以为已经删干净了）。所以确认框写的是真实影响范围，并在 P0-1-24 的 R4 里已被验证过
 * （会话行还在 / `status=FINISHED` / 消息还在）。
 *
 * 两个数字的来源也不一样，别写混：
 *   · **组件绑定数** —— `AgentItem.components` 就有，不必另请求；
 *   · **会话数** —— 只有 `GET /api/agents/:id/conversations` 的 `total`，且它**只算你自己名下的**
 *     （会话是第四族权限：仅创建者本人）。所以文案是"其中**你名下**的 N 个"，而不是
 *     "将删除 N 个会话"（后者既夸大范围又与事实不符）。这个数**取不到也不挡删除**
 *     —— 它只是旁证，不是判据。
 */

import { Alert, Input, Modal, Tag } from 'antd'
import type { AgentItem, RemoveAgentResult } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { useMyConversationCount } from '../../api/conversations.js'
import { useRemoveAgent } from '../../api/agents.js'
import { describeError } from '../../api/client.js'
import { isTypedConfirmMatch } from '../../app/confirm.js'
import { useFeedback } from '../../app/feedback.js'
import { mcpRefsOf } from './agentModel.js'

export interface DeleteAgentModalProps {
  /** 要删的智能体；`null` = 弹窗关闭 */
  agent: AgentItem | null
  onClose: () => void
  /** 删除成功后的去处（列表页就地收起；编辑页还要导航回列表） */
  onDeleted?: (result: RemoveAgentResult) => void
}

export function DeleteAgentModal({ agent, onClose, onDeleted }: DeleteAgentModalProps) {
  const feedback = useFeedback()
  const removeAgent = useRemoveAgent()
  // 弹窗关闭时不发请求：`agent === null` ⇒ `agentId` 为 undefined
  const conversationCount = useMyConversationCount(agent?.id)

  const [typedName, setTypedName] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次重新打开都要清空上一次的输入与错误 —— 否则"确认删除"按钮会带着上一个智能体的名字亮着
  useEffect(() => {
    setTypedName('')
    setErrorText(null)
  }, [agent?.id])

  if (agent === null) return null

  const knowledgeCount = agent.components.filter((c) => c.componentType === 'KNOWLEDGE').length
  const mcpRefs = mcpRefsOf(agent.components)
  // 逐字确认（P0-1-36 起四处共用 `app/confirm.ts#isTypedConfirmMatch` 这一份实现：
  // 智能体 / 会话 / 知识库 / Provider —— 判据散成四份必然先腐烂一份，且不报任何错）
  const nameMatches = isTypedConfirmMatch(typedName, agent.name)
  const removing = removeAgent.isPending

  const confirm = () => {
    setErrorText(null)
    removeAgent.mutate(agent.id, {
      onSuccess: (result) => {
        feedback.ok(
          `已删除「${result.name}」：解除了 ${result.removedComponents} 处组件绑定，` +
            `${result.finishedConversations} 个会话转为只读`,
        )
        onDeleted?.(result)
        onClose()
      },
      onError: (error) => {
        // 失败时不关弹窗：用户需要看到原因（可能是 403 权限变了、或 404 已被别人删掉）
        setErrorText(describeError(error).message)
      },
    })
  }

  return (
    <Modal
      open
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          删除智能体「{agent.name}」
          {/* 用 `tag--danger` 而不是 AntD 的预设色 `color="red"`：预设色是 AntD 自己那套红
              （`#f5222d`），与令牌里的 `--danger`（`#b3261e`）不是同一个红，且暗色主题下不会跟着换
              —— 全站"危险"只应该有一种红（`docs/03` §一：色值只在 tokens.css 定义）。 */}
          <Tag className="tag--danger">级联删除</Tag>
        </span>
      }
      okText="确认删除"
      okButtonProps={{ danger: true, disabled: !nameMatches, loading: removing }}
      cancelText="取消"
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <div>
          <p>
            <strong>此操作会连带做两件事：</strong>
          </p>
          <ul>
            <li>
              解除该智能体的 <span className="num">{agent.components.length}</span> 处组件绑定
              （其中知识库 <span className="num">{knowledgeCount}</span> 个）——
              知识库与它的文档<strong>不受影响</strong>，MCP server 同样不受影响
            </li>
            <li>
              它的<strong>全部会话</strong>转为「只读保留」（
              {conversationCount.data === undefined ? (
                <>你名下的会话数暂时取不到</>
              ) : (
                <>
                  其中你名下 <span className="num">{conversationCount.data}</span> 个
                </>
              )}
              ）：会话与消息<strong>都不会被删除</strong>，只是不能再发新消息
            </li>
          </ul>
          {/* ⚠️ JSX 的文本子节点**不认 Markdown**：写 `**xx**` 或 `` `xx` `` 会原样显示星号与反引号
              （P0-1-31 端测实测：弹窗里就那样显示出来了）。要加粗用 `<strong>`、要等宽用 `<code>`。 */}
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            删除后该智能体从列表与对话入口一起消失。这是<strong>软删除</strong>（
            <code>deleted_at</code> 打标记），
            P0-1 没有恢复入口 —— 删错了只能重建一个（会话历史仍在库里，属于它的只读保留）。
          </p>
        </div>

        {mcpRefs.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`该智能体还有 ${mcpRefs.length} 条 MCP 绑定`}
            description="MCP 注册（P0-2）尚未开放，这些绑定只可能由手工写库产生；删除会一并解除它们。"
          />
        )}

        {errorText !== null && <Alert type="error" showIcon message="删除失败" description={errorText} />}

        <div>
          <p>请输入智能体名称以确认：</p>
          <Input
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
            placeholder={agent.name}
            aria-label="输入智能体名称以确认删除"
            onPressEnter={() => {
              if (nameMatches && !removing) confirm()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            名称需逐字一致（含大小写与空格），用于避免误删同名前缀的智能体
          </p>
        </div>
      </div>
    </Modal>
  )
}
