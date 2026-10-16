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
 * 那两条链路用谁的身份 —— 故 MCP 单独给一条强提示（{@link MCP_TRANSFER_WARNING}）。
 */

import { Alert, Modal } from 'antd'
import { useEffect, useState } from 'react'

import { useTransferAgent } from '../api/agents.js'
import { useTransferKnowledgeBase } from '../api/knowledgeBases.js'
import { useTransferMcpServer } from '../api/mcp.js'
import { useTransferModelProvider } from '../api/modelPool.js'
import { useFeedback } from '../app/feedback.js'
import { AssetUserPicker } from './AssetUserPicker.js'

/** 四类可转移资产 */
export type TransferableAssetKind = 'AGENT' | 'KNOWLEDGE' | 'MCP' | 'PROVIDER'

const ASSET_KIND_LABEL: Readonly<Record<TransferableAssetKind, string>> = {
  AGENT: '智能体',
  KNOWLEDGE: '知识库',
  MCP: 'MCP server',
  PROVIDER: 'Provider',
}

/**
 * MCP 转移的专属警告（`子方案` §3.5 定案原文）。
 *
 * 为什么只对 MCP 说：`created_by` 在 MCP 上是**探测主语** —— 测试 / 工具列表用**所属人**的凭据
 * 连上游（`mcpServer.service.ts#probeServer`）。转移后若新所属人没配凭据，那两条链路会失败，
 * 而用户会以为是"server 坏了"。
 */
export const MCP_TRANSFER_WARNING =
  '转移后测试/工具列表将使用新所属人的凭据；若其未配置凭据，测试与工具列表会失败'

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

  const kindLabel = ASSET_KIND_LABEL[assetKind]
  const canSubmit = toUserId.trim() !== '' && !pending

  const confirm = () => {
    const payload = { id: assetId, toUserId: toUserId.trim() }
    const onSuccess = (): void => {
      feedback.ok(`已把${kindLabel}「${assetName}」转移给新所属人`)
      onTransferred?.()
      onClose()
    }
    const onError = (error: unknown): void => feedback.fail(error, '转移失败')

    if (assetKind === 'AGENT') transferAgent.mutate(payload, { onSuccess, onError })
    else if (assetKind === 'KNOWLEDGE') transferKnowledgeBase.mutate(payload, { onSuccess, onError })
    else if (assetKind === 'MCP') transferMcpServer.mutate(payload, { onSuccess, onError })
    else transferModelProvider.mutate(payload, { onSuccess, onError })
  }

  return (
    <Modal
      open={open}
      title={`转移${kindLabel}所属人`}
      okText="确认转移"
      okButtonProps={{ disabled: !canSubmit, loading: pending }}
      cancelText="取消"
      onOk={confirm}
      onCancel={onClose}
      maskClosable={!pending}
    >
      <div className="stack stack--tight">
        <p>
          资产：<strong>{assetName}</strong>
          <br />
          当前所属人：<span>{currentOwnerName}</span>
        </p>

        <div>
          <p className="block-label">新所属人</p>
          <AssetUserPicker value={toUserId} onChange={setToUserId} disabled={pending} />
        </div>

        <p className="ratio">
          转移后，编辑 / 删除 / 改可见性 / 再转移的权限都会交给新所属人（管理员仍可操作全部）。
          这个动作<strong>不需要对方确认</strong>，请确认对方确实是该资产的负责人。
        </p>

        {assetKind === 'MCP' && (
          <Alert type="warning" showIcon message={MCP_TRANSFER_WARNING} />
        )}
      </div>
    </Modal>
  )
}
