/**
 * 「还没配置模型 Key」提示弹窗（2026-10-16 用户定案，两处触发点共用）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 什么时候弹
 * ─────────────────────────────────────────────────────────────────────
 * 判据是纯逻辑 `modelKeyGuard.ts`。三处触发点：
 *   · **`AgentPicker`**：**新建会话 → 选择智能体**时，池里**一个能用的模型都没有**（全被「各自 Key」
 *     挡住）⇒ 弹窗、不导航（取消就不开始这段对话）。
 *   · **`ChatPage` 选择器**：用户**手动选到**缺 Key 的模型 ⇒ 弹窗、**不切换**（默认模型缺 Key 时
 *     会自动换成能用的那个，不会走到这里）。
 *   · **`ChatPage` 发送兜底**：其它进入 `/new/:agentId` 的路（列表页「对话」/ 深链）不经过选择器 ⇒
 *     发送前再判一次本次要用的模型，缺 Key 就不建会话。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两个按钮各做什么
 * ─────────────────────────────────────────────────────────────────────
 *   · 「去配置」⇒ 跳「我的凭据」的**模型 Provider 凭据**分区。**同样不建会话**。
 *   · 「取消」⇒ 关弹窗，**不建会话**（`onClose` 由调用方收口，拦截逻辑在调用方那边 return）。
 */

import { Modal } from 'antd'
import { useNavigate } from 'react-router-dom'

import { credentialsSectionPath } from '../../app/paths.js'
import { useT } from '../../app/i18n.js'
import type { MissingModelKeyProvider } from './modelKeyGuard.js'

export interface MissingModelKeyModalProps {
  /** 非空 = 打开；`null` = 关闭（判据来自 `missingModelKeyProviders`） */
  missing: readonly MissingModelKeyProvider[] | null
  /** 关闭（取消 / 点× / 「去配置」导航之后）—— 不建会话这一步由调用方负责 */
  onClose: () => void
}

export function MissingModelKeyModal({ missing, onClose }: MissingModelKeyModalProps) {
  const { t } = useT()
  const navigate = useNavigate()
  return (
    <Modal
      open={missing !== null}
      title={t('missingKey.title')}
      okText={t('missingKey.okText')}
      cancelText={t('confirm.reject')}
      onOk={() => {
        onClose()
        navigate(credentialsSectionPath('provider'))
      }}
      onCancel={onClose}
    >
      <p>{t('missingKey.body')}</p>
      <ul style={{ margin: 'var(--sp-3) 0 0', paddingLeft: '1.2em' }}>
        {(missing ?? []).map((item) => (
          <li key={item.providerId}>
            <strong>{item.providerName}</strong>
            {t('missingKey.providerModels', { models: item.modelLabels.join(t('missingKey.listSeparator')) })}
          </li>
        ))}
      </ul>
      <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
        {t('missingKey.footNote')}
      </p>
    </Modal>
  )
}
