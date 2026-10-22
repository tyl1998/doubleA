/**
 * Provider 级联删除确认（P0-1-36；需求优化：去逐字确认 + 自动解绑 + 列出被绑定模型）
 *
 * 依据：`docs/03` §七「删除分级确认」——**级联删除 = Modal + 红色危险按钮 + 明示影响范围**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与旧版的两处变化（本次需求）
 * ─────────────────────────────────────────────────────────────────────
 * ① **不再逐字输入确认**：删除弹窗去掉"输入 Provider 名称"这层重复确认，危险按钮直接可点
 *    （仍保留级联危险标记 + 明示影响范围 + 红色按钮）。
 * ② **不再 409 拦截 + 如实列出影响**：`agents.model_id` 改为 `ON DELETE SET NULL`，删 Provider
 *    会连带删其下模型、并把引用这些模型的**在线**智能体自动解绑（变为"未绑定模型"）。
 *    弹窗打开时通过 `GET /api/model-providers/:id/bound-models` 拉取"会解绑哪些模型 / 影响多少
 *    智能体"，如实列出，而不是编一个"可能被拒"的提示。
 */

import { Alert, List, Modal, Spin, Tag } from 'antd'
import { UPSTREAM_PROTOCOL_LABELS, type ModelProviderItem } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useProviderBoundModels, useRemoveModelProvider } from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { PROVIDER_DELETE_IMPACT_HINT, describeProviderKey } from './adminModel.js'

export interface DeleteProviderModalProps {
  /** 要删的 Provider；`null` = 弹窗关闭 */
  provider: ModelProviderItem | null
  open: boolean
  onClose: () => void
}

export function DeleteProviderModal({ provider, open, onClose }: DeleteProviderModalProps) {
  const feedback = useFeedback()
  const remove = useRemoveModelProvider()
  const [errorText, setErrorText] = useState<string | null>(null)
  // 弹窗打开时拉取"会被解绑的模型清单"（需求 3）；关闭时不发请求
  const bound = useProviderBoundModels(open && provider !== null ? provider.id : null)

  // 每次打开都清空上一次的错误
  useEffect(() => {
    setErrorText(null)
  }, [open, provider])

  if (provider === null) return null

  const removing = remove.isPending

  const confirm = (): void => {
    setErrorText(null)
    remove.mutate(provider.id, {
      onSuccess: (result) => {
        feedback.ok(
          `已删除 Provider「${result.name}」` +
            (result.deletedModels > 0 ? `，连带删除 ${result.deletedModels} 个模型` : '（它下面是空的）') +
            (result.unboundAgents > 0 ? `，自动解绑 ${result.unboundAgents} 个智能体` : '') +
            (result.clearedKnowledgeBases > 0
              ? `，${result.clearedKnowledgeBases} 个知识库的模型绑定被清空（需重新指定）`
              : '') +
            (result.clearedTitleModel ? '，平台的会话标题模型被清空' : ''),
        )
        onClose()
      },
      onError: (error) => {
        // 失败不关弹窗：404 需要用户看到"别人已经删了"
        setErrorText(describeError(error).message)
      },
    })
  }

  const boundModels = bound.data?.models ?? []
  const agentTotal = bound.data?.agentTotal ?? 0
  const knowledgeBaseTotal = bound.data?.knowledgeBaseTotal ?? 0
  const clearsTitleModel = bound.data?.clearsTitleModel ?? false

  return (
    <Modal
      open={open}
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          删除 Provider「{provider.name}」
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
            <strong>这个 Provider 下现有 {provider.modelCount} 个模型，删除会一起消失：</strong>
          </p>
          <ul>
            <li>
              它的配置：<span className="num">{provider.baseUrl}</span>（{UPSTREAM_PROTOCOL_LABELS[provider.protocol]}）
            </li>
            <li>加密存储的 API Key（当前：{describeProviderKey(provider)}）</li>
            <li>
              它下面的 <span className="num">{provider.modelCount}</span> 个模型记录
            </li>
          </ul>
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            操作<strong>不可恢复</strong>：没有回收站。密文与模型记录都没了，只能重新建 Provider、
            重新填 Key、重新录入型号名（模型 id 可以先用「拉取上游模型」探出来）。
          </p>
        </div>

        <Alert type={provider.modelCount > 0 ? 'warning' : 'info'} showIcon message="删除影响" description={PROVIDER_DELETE_IMPACT_HINT} />

        {/* 需求 3：如实列出"会被自动解绑的模型 / 受影响的智能体"；2026-10-22 补：向量模型被知识库引用的影响 */}
        {bound.isLoading ? (
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <Spin size="small" /> <span className="ratio">正在核对哪些模型被智能体 / 知识库绑定…</span>
          </div>
        ) : boundModels.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={
              [
                agentTotal > 0 ? `将自动解绑 ${agentTotal} 个智能体` : null,
                knowledgeBaseTotal > 0 ? `将清空 ${knowledgeBaseTotal} 个知识库的模型绑定` : null,
                clearsTitleModel ? '将清空平台的会话标题模型' : null,
              ]
                .filter((part): part is string => part !== null)
                .join('；') + '（它们绑定了下面这些模型）'
            }
            description={
              <>
                <List
                  size="small"
                  dataSource={boundModels}
                  renderItem={(m) => (
                    <List.Item>
                      <span>
                        <strong>{m.label}</strong>
                        <span className="num">（{m.modelName}）</span>
                        {m.agentCount > 0 && <> · 被 {m.agentCount} 个智能体绑定</>}
                        {m.knowledgeBaseCount > 0 && <> · 被 {m.knowledgeBaseCount} 个知识库用作向量模型</>}
                        {m.captionKnowledgeBaseCount > 0 && (
                          <> · 被 {m.captionKnowledgeBaseCount} 个知识库用作图片描述模型</>
                        )}
                        {m.usedAsTitleModel && <> · 被平台用作会话标题模型</>}
                      </span>
                    </List.Item>
                  )}
                />
                {knowledgeBaseTotal > 0 && (
                  <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                    ⚠️ 绑定被清空的知识库删除后<strong>无法入库 / 检索</strong>（图片描述也会失效），需到知识库设置里
                    改用别的模型（换向量模型后旧向量需重建）。
                  </p>
                )}
                {clearsTitleModel && (
                  <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                    ⚠️ 平台的<strong>会话标题生成模型</strong>会被清空，之后会话标题退回确定性截断，需到模型池页
                    「系统模型」重新指定。
                  </p>
                )}
              </>
            }
          />
        ) : bound.isError ? (
          <Alert type="info" showIcon message="未能核对被绑定的模型" description="删除仍可进行；被引用的智能体会被自动解绑。" />
        ) : null}

        {errorText !== null && <Alert type="error" showIcon message="删除失败" description={errorText} />}
      </div>
    </Modal>
  )
}
