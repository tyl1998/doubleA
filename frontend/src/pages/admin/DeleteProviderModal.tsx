/**
 * Provider 级联删除确认（P0-1-36）
 *
 * 依据：`docs/03` §七「删除分级确认」——**级联删除 = Modal + 红色危险按钮 + 明示影响范围**；
 *      `docs/02` §4.3「删除语义」：`models.provider_id` 是 `ON DELETE CASCADE`，但
 *      `agents.model_id` 是 `ON DELETE RESTRICT` ⇒ **只要其下有模型被智能体引用，整次删除
 *      会被前置检查拦成 409**（而不是撞外键抛 500）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么它属于"级联"那一档，而删模型不是
 * ─────────────────────────────────────────────────────────────────────
 * 删一个 Provider 会连带删掉它下面的**全部模型**（外键 CASCADE）—— 这是 `03` §七 说的
 * "明示影响范围"要覆盖的情形。删模型只删它自己 ⇒ 走普通删除那一档（Popconfirm）。
 * 本仓对级联那一档的落地口径是**再叠一层逐字确认**（删智能体输入 Agent 名称、删知识库输入库名、
 * 删会话输入固定的「删除」）：确认词 = Provider 自己的名字，判据委托
 * `app/confirm.ts#isTypedConfirmMatch`（**全仓只此一份实现**，刻意不 `trim`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一处"给不出数字"就没有数字（不造假）
 * ─────────────────────────────────────────────────────────────────────
 * `ModelProviderItem` 只有 `modelCount`（有多少个模型），**没有**"其中多少个模型正被智能体
 * 引用"。所以弹窗如实写"将连带删除 N 个模型"，并**明说**：若其中有模型被引用，后端会整体拒绝
 * （409）—— 而不是编一个"其中 2 个被引用"看起来更贴心的数字。
 * 同族先例：删会话时给不出消息条数（游标分页没有 `total`）⇒ 只写「全部消息」。
 */

import { Alert, Input, Modal, Tag } from 'antd'
import type { ModelProviderItem } from '@doubulea/shared'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { describeError } from '../../api/client.js'
import { useRemoveModelProvider } from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH } from '../../app/paths.js'
import { PROVIDER_DELETE_IMPACT_HINT, describeProviderKey, isProviderDeleteConfirmed } from './adminModel.js'

export interface DeleteProviderModalProps {
  /** 要删的 Provider；`null` = 弹窗关闭 */
  provider: ModelProviderItem | null
  open: boolean
  onClose: () => void
}

export function DeleteProviderModal({ provider, open, onClose }: DeleteProviderModalProps) {
  const feedback = useFeedback()
  const remove = useRemoveModelProvider()
  const [typed, setTyped] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)

  // 每次打开都清空 —— 否则"确认删除"按钮会带着上一个 Provider 的名字亮着
  useEffect(() => {
    setTyped('')
    setErrorText(null)
  }, [open, provider])

  if (provider === null) return null

  const confirmed = isProviderDeleteConfirmed(typed, provider.name)
  const removing = remove.isPending

  const confirm = (): void => {
    setErrorText(null)
    remove.mutate(provider.id, {
      onSuccess: (result) => {
        feedback.ok(
          `已删除 Provider「${result.name}」` +
            (provider.modelCount > 0 ? `，连带删除 ${provider.modelCount} 个模型` : '（它下面是空的）'),
        )
        onClose()
      },
      onError: (error) => {
        // 失败**不关弹窗**：409 需要用户看到"是哪些模型被引用着"，404 需要他看到"别人已经删了"
        setErrorText(describeError(error).message)
      },
    })
  }

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
      okButtonProps={{ danger: true, disabled: !confirmed, loading: removing }}
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
              它的配置：<span className="num">{provider.baseUrl}</span>（{provider.type}）
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

        {/* ⚠️ 只报"有多少个模型"，**不报**"其中多少个被引用" —— 那个数字接口没给（不造假）。
            但要说清"如果被引用会整体拒绝"，否则用户会以为点了就一定成功。 */}
        <Alert
          type={provider.modelCount > 0 ? 'warning' : 'info'}
          showIcon
          message={provider.modelCount > 0 ? '可能被拒绝（409）' : '这个 Provider 下没有模型'}
          description={
            <>
              {PROVIDER_DELETE_IMPACT_HINT}
              {provider.modelCount > 0 && (
                <>
                  {' '}
                  引用它的智能体在
                  <Link to={HOME_PATH}> 智能体列表 </Link>
                  里改绑模型后，这个 Provider 才能删掉。
                </>
              )}
            </>
          }
        />

        {errorText !== null && <Alert type="error" showIcon message="删除失败" description={errorText} />}

        <div>
          <p>请输入 Provider 名称以确认：</p>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={provider.name}
            aria-label="输入 Provider 名称以确认删除"
            onPressEnter={() => {
              if (confirmed && !removing) confirm()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            名称需逐字一致（含大小写与空格）
          </p>
        </div>
      </div>
    </Modal>
  )
}
