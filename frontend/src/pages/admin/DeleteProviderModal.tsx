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
import { UPSTREAM_PROTOCOL_KEY, type ModelProviderItem } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useProviderBoundModels, useRemoveModelProvider } from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { PROVIDER_DELETE_IMPACT_HINT_KEY, describeProviderKey } from './adminModel.js'

export interface DeleteProviderModalProps {
  /** 要删的 Provider；`null` = 弹窗关闭 */
  provider: ModelProviderItem | null
  open: boolean
  onClose: () => void
}

export function DeleteProviderModal({ provider, open, onClose }: DeleteProviderModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
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
          t('deleteProvider.deleted', { name: result.name }) +
            (result.deletedModels > 0
              ? t('deleteProvider.deletedWithModels', { count: result.deletedModels })
              : t('deleteProvider.emptyProvider')) +
            (result.unboundAgents > 0 ? t('deleteProvider.unbound', { count: result.unboundAgents }) : '') +
            (result.clearedKnowledgeBases > 0
              ? t('deleteProvider.clearedKb', { count: result.clearedKnowledgeBases })
              : '') +
            (result.clearedTitleModel ? t('deleteProvider.clearedTitleModel') : ''),
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
          {t('deleteProvider.title', { name: provider.name })}
          <Tag className="tag--danger">{t('deleteProvider.cascadeTag')}</Tag>
        </span>
      }
      okText={t('deleteProvider.okText')}
      okButtonProps={{ danger: true, loading: removing }}
      cancelText={t('common.cancel')}
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!removing}
    >
      <div className="stack stack--tight">
        <div>
          <p>
            <strong>{t('deleteProvider.modelsNoteStrong', { count: provider.modelCount })}</strong>
          </p>
          <ul>
            <li>
              {t('deleteProvider.config', {
                baseUrl: provider.baseUrl,
                protocol: t(UPSTREAM_PROTOCOL_KEY[provider.protocol]),
              })}
            </li>
            <li>{t('deleteProvider.encryptedKey', { state: describeProviderKey(provider, locale) })}</li>
            <li>
              {t('deleteProvider.modelRecordsPrefix')}
              {provider.modelCount}
              {t('deleteProvider.modelRecordsMid')}
            </li>
          </ul>
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            {t('deleteProvider.irreversiblePrefix')}
            <strong>{t('deleteProvider.irreversibleStrong')}</strong>
            {t('deleteProvider.irreversibleTail')}
          </p>
        </div>

        <Alert
          type={provider.modelCount > 0 ? 'warning' : 'info'}
          showIcon
          message={t('deleteProvider.impactTitle')}
          description={t(PROVIDER_DELETE_IMPACT_HINT_KEY)}
        />

        {/* 需求 3：如实列出"会被自动解绑的模型 / 受影响的智能体"；2026-10-22 补：向量模型被知识库引用的影响 */}
        {bound.isLoading ? (
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <Spin size="small" /> <span className="ratio">{t('deleteProvider.checking')}</span>
          </div>
        ) : boundModels.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={
              [
                agentTotal > 0 ? t('deleteProvider.unbindPrefix') + agentTotal + t('deleteProvider.unbindMid') : null,
                knowledgeBaseTotal > 0
                  ? t('deleteProvider.clearKbPrefix') + knowledgeBaseTotal + t('deleteProvider.clearKbMid')
                  : null,
                clearsTitleModel ? t('deleteProvider.clearTitleModel') : null,
              ]
                .filter((part): part is string => part !== null)
                .join(t('mcp.impact.join')) + t('deleteProvider.bindingsNoteSuffix')
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
                        {m.agentCount > 0 && <>{t('deleteProvider.boundAgents', { count: m.agentCount })}</>}
                        {m.knowledgeBaseCount > 0 && (
                          <>{t('deleteProvider.boundVectorKb', { count: m.knowledgeBaseCount })}</>
                        )}
                        {m.captionKnowledgeBaseCount > 0 && (
                          <>{t('deleteProvider.boundCaptionKb', { count: m.captionKnowledgeBaseCount })}</>
                        )}
                        {m.usedAsTitleModel && <>{t('deleteProvider.boundTitleModel')}</>}
                      </span>
                    </List.Item>
                  )}
                />
                {knowledgeBaseTotal > 0 && (
                  <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                    {t('deleteProvider.warnKbPrefix')}
                    <strong>{t('deleteProvider.warnKbStrong')}</strong>
                    {t('deleteProvider.warnKbTail')}
                  </p>
                )}
                {clearsTitleModel && (
                  <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                    {t('deleteProvider.warnTitlePrefix')}
                    <strong>{t('deleteProvider.warnTitleStrong')}</strong>
                    {t('deleteProvider.warnTitleTail')}
                  </p>
                )}
              </>
            }
          />
        ) : bound.isError ? (
          <Alert
            type="info"
            showIcon
            message={t('deleteProvider.checkFailedTitle')}
            description={t('deleteProvider.checkFailedDesc')}
          />
        ) : null}

        {errorText !== null && (
          <Alert type="error" showIcon message={t('deleteProvider.failed')} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
