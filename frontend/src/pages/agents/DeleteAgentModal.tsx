/**
 * 智能体级联删除确认（P0-1-31；需求优化：去掉逐字输入确认）
 *
 * 依据：`docs/03-前端设计.md` §七「删除分级确认」——**级联删除（Agent / 会话）= Modal + 红色危险
 *      按钮 + 明示影响范围**；`docs/02` §4.4（删除是**软删**：组件解绑 + 会话转只读保留）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件最要紧的一件事：**原型的文案与后端语义不符，落地必须以后端为准**
 * ─────────────────────────────────────────────────────────────────────
 * 原型写的是"将同时**删除** 3 个会话及其全部消息（含工具调用记录与引用）"。实现里
 * `removeAgent` 做的是 **软删**：`deleted_at` 打标记 + 删 `agent_components` +
 * 该 Agent 的 `conversations.status` 转 `FINISHED`（**会话与消息都留着**，只是不能再发消息）。
 * 照抄原型文案就是**对用户撒谎**（用户以为消息没了，实际还在；反过来他若想清理数据，
 * 也会以为已经删干净了）。所以确认框写的是真实影响范围。
 *
 * 两个数字的来源也不一样，别写混：
 *   · **组件绑定数** —— `AgentItem.components` 就有，不必另请求；
 *   · **会话数** —— 只有 `GET /api/agents/:id/conversations` 的 `total`，且它**只算你自己名下的**。
 *
 * ⚠️ 需求优化：删除**不再**要求逐字输入智能体名称（去掉重复输入这层确认），保留级联危险
 * 标记 + 明示影响范围 + 红色危险按钮。软删同时会把 `agents.model_id` 置空（自动解绑模型）。
 */

import { Alert, Modal, Tag } from 'antd'
import type { AgentItem, RemoveAgentResult } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { useMyConversationCount } from '../../api/conversations.js'
import { useRemoveAgent } from '../../api/agents.js'
import { describeError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
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
  const { t } = useT()
  const removeAgent = useRemoveAgent()
  // 弹窗关闭时不发请求：`agent === null` ⇒ `agentId` 为 undefined
  const conversationCount = useMyConversationCount(agent?.id)

  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次重新打开都要清空上一次的错误
  useEffect(() => {
    setErrorText(null)
  }, [agent?.id])

  if (agent === null) return null

  const knowledgeCount = agent.components.filter((c) => c.componentType === 'KNOWLEDGE').length
  const mcpRefs = mcpRefsOf(agent.components)
  const removing = removeAgent.isPending

  const confirm = () => {
    setErrorText(null)
    removeAgent.mutate(agent.id, {
      onSuccess: (result) => {
        feedback.ok(
          t('agentDelete.deleted', {
            name: result.name,
            components: result.removedComponents,
            conversations: result.finishedConversations,
          }),
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
          {t('agentDelete.title', { name: agent.name })}
          {/* 用 `tag--danger` 而不是 AntD 的预设色 `color="red"`：全站"危险"只应该有一种红。 */}
          <Tag className="tag--danger">{t('agentDelete.cascadeTag')}</Tag>
        </span>
      }
      okText={t('agentDelete.okText')}
      okButtonProps={{ danger: true, loading: removing }}
      cancelText={t('common.cancel')}
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <div>
          <p>
            <strong>{t('agentDelete.bodyTitle')}</strong>
          </p>
          <ul>
            <li>
              {t('agentDelete.bodyComponentsPrefix')}
              <span className="num">{agent.components.length}</span>
              {t('agentDelete.bodyComponentsSuffix', { kb: knowledgeCount })}
              <strong>{t('agentDelete.bodyComponentsStrong')}</strong>
              {t('agentDelete.bodyComponentsTail')}
            </li>
            <li>
              {t('agentDelete.bodyConversationsPrefix')}
              <strong>{t('agentDelete.bodyConversationsStrong')}</strong>
              {t('agentDelete.bodyConversationsMid')}
              {conversationCount.data === undefined ? (
                t('agentDelete.countUnavailable')
              ) : (
                <>
                  {t('agentDelete.countMinePrefix')}
                  <span className="num">{conversationCount.data}</span>
                  {t('agentDelete.countMineSuffix')}
                </>
              )}
              {t('agentDelete.bodyConversationsTail')}
              <strong>{t('agentDelete.bodyConversationsStrong2')}</strong>
              {t('agentDelete.bodyConversationsEnd')}
            </li>
          </ul>
          {/* ⚠️ JSX 的文本子节点**不认 Markdown**：要加粗用 `<strong>`、要等宽用 `<code>`。 */}
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            {t('agentDelete.softDeletePrefix')}
            <strong>{t('agentDelete.softDeleteStrong')}</strong>
            {t('agentDelete.softDeleteMid')}
            <code>deleted_at</code>
            {t('agentDelete.softDeleteTail')}
          </p>
        </div>

        {mcpRefs.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={t('agentDelete.mcpTitle', { count: mcpRefs.length })}
            description={t('agentDelete.mcpDesc')}
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={t('agentDelete.failed')} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
