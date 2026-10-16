/**
 * 「模型 Provider 凭据」区块（P1-18 · 子批 C；挂在「我的凭据」页）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要这一块（这是"怎么引导用户配置"的答案）
 * ─────────────────────────────────────────────────────────────────────
 * `credentialMode=PER_USER` 的 Provider 每个使用者各配一把 Key；缺了，对话返回 424
 * 「尚未配置所需凭据」。「我的凭据」这一块的价值是列出**我自己的**凭据并就地配置：
 *   · `PER_USER`（各自 Key）⇒ **全部启用的「各自 Key」Provider**（**含未配置**），可读可写
 *     —— 平台模型池人人可见，任何使用者都可能要给它配自己的 Key。
 *   · `SHARED`（共享 Key）  ⇒ **只列我作为所属人**的（只读掩码）—— 别人的共享 Key 不在我这里出现。
 *
 * 数据来自 `GET /api/model-providers/my-credentials`（只列"我自己的"），按凭据模式分区展示。
 *
 * ⚠️ 凭据是**个人隐私**：接口只回布尔 + 掩码，管理员也读不到别人的**个人** Key；共享 Key 也只回掩码。
 */

import { Button, Input, Popconfirm, Tag } from 'antd'
import { useState } from 'react'
import { PROVIDER_CREDENTIAL_MODE_LABELS, type MyProviderCredentialEntry } from '@doubulea/shared'

import {
  useDeleteMyProviderCredential,
  useMyProviderCredentials,
  useSetMyProviderCredential,
} from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'

/** `PER_USER`（各自 Key）：就地配置**我的** Key —— 可读可写 */
function PerUserProviderKeyRow({ entry }: { entry: MyProviderCredentialEntry }) {
  const feedback = useFeedback()
  const setKey = useSetMyProviderCredential()
  const clearKey = useDeleteMyProviderCredential()
  const [apiKey, setApiKey] = useState('')

  const save = async () => {
    if (apiKey.trim() === '') {
      feedback.fail(new Error('请输入 API Key'), '无法保存')
      return
    }
    try {
      await setKey.mutateAsync({ id: entry.providerId, apiKey: apiKey.trim() })
      setApiKey('')
      feedback.ok(`已保存你在「${entry.providerName}」上的 Key`)
    } catch (error) {
      feedback.fail(error, '保存失败')
    }
  }

  const clear = async () => {
    try {
      await clearKey.mutateAsync(entry.providerId)
      feedback.ok(`已清除你在「${entry.providerName}」上的 Key`)
    } catch (error) {
      feedback.fail(error, '清除失败')
    }
  }

  return (
    <div className="cred-group card">
      <div className="card__head">
        <p className="card__title">{entry.providerName}</p>
        <Tag>{PROVIDER_CREDENTIAL_MODE_LABELS.PER_USER}</Tag>
        {entry.hasKey ? <Tag className="tag--ok">已配置</Tag> : <Tag className="tag--warn">未配置</Tag>}
        <div className="card__head-right">
          <span className="ratio">
            {entry.hasKey
              ? `当前：${entry.apiKeyPreview ?? '****'}（仅用于核对）`
              : '还没配 —— 用它下面模型的对话会返回「尚未配置凭据」'}
          </span>
        </div>
      </div>

      <div className="card__body stack stack--tight">
        <label className="block-label" htmlFor={`provider-key-${entry.providerId}`}>
          API Key
        </label>
        <Input.Password
          id={`provider-key-${entry.providerId}`}
          value={apiKey}
          autoComplete="off"
          placeholder={entry.hasKey ? '输入新的 Key 以替换' : '粘贴你的 API Key'}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <div className="row" style={{ gap: 'var(--sp-3)' }}>
          <Button type="primary" loading={setKey.isPending} onClick={save}>
            保存我的 Key
          </Button>
          {entry.hasKey ? (
            <Popconfirm
              title={`清除你在「${entry.providerName}」上的 Key？`}
              description="清除后，经该 Provider 的对话会报「尚未配置所需凭据」，直到你重新填写。"
              okText="清除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={clear}
            >
              <Button danger loading={clearKey.isPending}>
                清除
              </Button>
            </Popconfirm>
          ) : null}
          <span className="ratio u-right">只有你能读、能改这一把</span>
        </div>
      </div>
    </div>
  )
}

/** `SHARED`（共享 Key）：只读展示正在生效的共享 Key（掩码） —— 改它去模型池 */
function SharedProviderKeyRow({ entry }: { entry: MyProviderCredentialEntry }) {
  return (
    <div className="cred-group card">
      <div className="card__head">
        <p className="card__title">{entry.providerName}</p>
        <Tag>{PROVIDER_CREDENTIAL_MODE_LABELS.SHARED}</Tag>
        {entry.hasKey ? <Tag className="tag--ok">已配置</Tag> : <Tag className="tag--warn">未配置</Tag>}
        <div className="card__head-right">
          <span className="ratio">
            {entry.hasKey
              ? `当前：${entry.apiKeyPreview ?? '****'}（仅用于核对）`
              : '该 Provider 还没配共享 Key —— 用它下面模型的对话会失败'}
          </span>
        </div>
      </div>

      <div className="card__body stack stack--tight">
        <p className="ratio">
          这把 Key 由该 Provider 的<strong>所属人 / 管理员</strong>统一配置、全员共用（额度与计费算在配置方）。
          你<strong>无需、也无权</strong>在这里修改；要换请到<strong>模型池</strong>编辑该 Provider。
        </p>
      </div>
    </div>
  )
}

export function ProviderKeySection() {
  const query = useMyProviderCredentials()
  const items = query.data ?? []

  // 加载中 / 出错 / 无条目 ⇒ 整块不渲染（这是"发现"辅助区，不阻塞"我的凭据"主内容）
  if (query.isPending || query.isError || items.length === 0) return null

  const perUser = items.filter((item) => item.credentialMode === 'PER_USER')
  const shared = items.filter((item) => item.credentialMode === 'SHARED')
  // ⚠️ 只统计**我需要动手的**（`PER_USER`）未配置；共享 Key 的"未配置"是所属人的事，不该吓唬使用者
  const unconfigured = perUser.filter((item) => !item.hasKey)

  return (
    <section>
      <div className="admin-section__head">
        <div>
          <h2 className="card__title">模型 Provider 凭据</h2>
          <p className="page__lead">
            这里是<strong>你自己的</strong> Provider 凭据：你是<strong>所属人</strong>的 Provider（含共享 Key，仅你可见），
            以及全部启用的「各自 Key」Provider（可就地配你自己的 Key）。
            别人的共享 Key 不会出现在这里。
          </p>
        </div>
        {unconfigured.length === 0 ? (
          <Tag className="tag--ok">{perUser.length === 0 ? '无需配置' : '需要你配的都已完成'}</Tag>
        ) : (
          <Tag className="tag--warn">{unconfigured.length} 个待配置</Tag>
        )}
      </div>

      <div className="stack">
        {perUser.map((entry) => (
          <PerUserProviderKeyRow key={entry.providerId} entry={entry} />
        ))}
        {shared.map((entry) => (
          <SharedProviderKeyRow key={entry.providerId} entry={entry} />
        ))}
      </div>
    </section>
  )
}
