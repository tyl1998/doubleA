/**
 * 转移资产所属人（P1-13，四类资产共用）
 *
 * 依据：`子方案/资产所属人与权限控制.md` §3.5、`shared/src/assetAcl.ts`
 *      （`transferAssetBodySchema` = `{ toUserId }`，四资产各自 `POST /api/{asset}/:id/transfer`）。
 *
 * 三条口径：
 *   · 权限 = 仅**所属人 / ADMIN**（调用方按 `canEdit` 决定是否给出入口）；
 *   · `toUserId` 必须是 `ACTIVE` 用户、**不能转给自己**（服务层校验，失败 400/422）；
 *   · **不需要接收方确认**（用户 2026-10-16 定案）—— 所以这里只做一次危险确认，不写"等对方接受"。
 *
 * ⚠️ MCP 的 `created_by` 同时是**探测主语**（测试 / 工具列表用所属人的凭据），转移会静默改变
 * 那两条链路用谁的身份 —— 故 MCP 单独给一条强提示（`transfer.mcpWarning`）。
 *
 * ⚠️ P1-23 末批：本文件此前**整屏中文**（用户 2026-10-26 实测反馈「智能体转让弹窗没有中英文」），
 * 现全部走字典；带内联 `<strong>` / `<br>` 的那两段按 `03` 的"分段 key"口径拆开，渲染保留原标记。
 */

import { Alert, Modal } from 'antd'
import { useEffect, useState } from 'react'
import { translate, type MessageKey } from '@doubulea/shared'

import { useTransferAgent } from '../api/agents.js'
import { useTransferKnowledgeBase } from '../api/knowledgeBases.js'
import { useTransferMcpServer } from '../api/mcp.js'
import { useTransferModelProvider } from '../api/modelPool.js'
import { useFeedback } from '../app/feedback.js'
import { useT } from '../app/i18n.js'
import { AssetUserPicker } from './AssetUserPicker.js'

/** 四类可转移资产 */
export type TransferableAssetKind = 'AGENT' | 'KNOWLEDGE' | 'MCP' | 'PROVIDER'

/** 资产种类 → i18n key（弹窗标题与成功提示里都要说"转的是哪种东西"） */
const ASSET_KIND_KEY: Readonly<Record<TransferableAssetKind, MessageKey>> = {
  AGENT: 'label.assetKind.AGENT',
  KNOWLEDGE: 'label.assetKind.KNOWLEDGE',
  MCP: 'label.assetKind.MCP',
  PROVIDER: 'label.assetKind.PROVIDER',
}

export interface TransferOwnershipModalProps {
  open: boolean
  assetKind: TransferableAssetKind
  assetId: string
  /** 资产名（确认框标题用） */
  assetName: string
  /** 当前所属人显示名 */
  currentOwnerName: string
  onClose: () => void
  /** 转移成功后的回调（列表页可用它收起弹窗 / 提示） */
  onTransferred?: () => void
}

export function TransferOwnershipModal({
  open,
  assetKind,
  assetId,
  assetName,
  currentOwnerName,
  onClose,
  onTransferred,
}: TransferOwnershipModalProps) {
  const { t, locale } = useT()
  const feedback = useFeedback()
  // 四个 hook 无条件调用（不能按 assetKind 条件调用 hook —— 违反 hooks 规则）
  const transferAgent = useTransferAgent()
  const transferKnowledgeBase = useTransferKnowledgeBase()
  const transferMcpServer = useTransferMcpServer()
  const transferModelProvider = useTransferModelProvider()

  const [toUserId, setToUserId] = useState('')

  // 每次打开都清空上一次的选择
  useEffect(() => {
    if (open) setToUserId('')
  }, [open, assetId])

  const pending =
    transferAgent.isPending ||
    transferKnowledgeBase.isPending ||
    transferMcpServer.isPending ||
    transferModelProvider.isPending

  const kindLabel = translate(locale, ASSET_KIND_KEY[assetKind])
  const canSubmit = toUserId.trim() !== '' && !pending

  const confirm = () => {
    const payload = { id: assetId, toUserId: toUserId.trim() }
    const onSuccess = (): void => {
      feedback.ok(t('transfer.ok', { kind: kindLabel, name: assetName }))
      onTransferred?.()
      onClose()
    }
    const onError = (error: unknown): void => feedback.fail(error, t('transfer.failed'))

    if (assetKind === 'AGENT') transferAgent.mutate(payload, { onSuccess, onError })
    else if (assetKind === 'KNOWLEDGE') transferKnowledgeBase.mutate(payload, { onSuccess, onError })
    else if (assetKind === 'MCP') transferMcpServer.mutate(payload, { onSuccess, onError })
    else transferModelProvider.mutate(payload, { onSuccess, onError })
  }

  return (
    <Modal
      open={open}
      title={t('transfer.title', { kind: kindLabel })}
      okText={t('transfer.okText')}
      okButtonProps={{ disabled: !canSubmit, loading: pending }}
      cancelText={t('common.cancel')}
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!pending}
    >
      <div className="stack stack--tight">
        <p>
          {t('transfer.assetLabel')}
          <strong>{assetName}</strong>
          <br />
          {t('transfer.currentOwnerLabel')}
          <span>{currentOwnerName}</span>
        </p>

        <div>
          <p className="block-label">{t('transfer.newOwnerLabel')}</p>
          <AssetUserPicker value={toUserId} onChange={setToUserId} disabled={pending} />
        </div>

        <p className="ratio">
          {t('transfer.bodyPrefix')}
          <strong>{t('transfer.bodyStrong')}</strong>
          {t('transfer.bodySuffix')}
        </p>

        {assetKind === 'MCP' && <Alert type="warning" showIcon message={t('transfer.mcpWarning')} />}
      </div>
    </Modal>
  )
}
