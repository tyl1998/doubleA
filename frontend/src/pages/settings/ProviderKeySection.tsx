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
import { PROVIDER_CREDENTIAL_MODE_KEY, type MyProviderCredentialEntry } from '@doubulea/shared'

import {
  useDeleteMyProviderCredential,
  useMyProviderCredentials,
  useSetMyProviderCredential,
} from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

/** `PER_USER`（各自 Key）：就地配置**我的** Key —— 可读可写 */
function PerUserProviderKeyRow({ entry }: { entry: MyProviderCredentialEntry }) {
  const feedback = useFeedback()
  const { t } = useT()
  const setKey = useSetMyProviderCredential()
  const clearKey = useDeleteMyProviderCredential()
  const [apiKey, setApiKey] = useState('')

  const save = async () => {
    if (apiKey.trim() === '') {
      feedback.fail(new Error(t('settings.providerKey.needApiKey')), t('settings.providerKey.cannotSave'))
      return
    }
    try {
      await setKey.mutateAsync({ id: entry.providerId, apiKey: apiKey.trim() })
      setApiKey('')
      feedback.ok(t('settings.providerKey.savedOk', { provider: entry.providerName }))
    } catch (error) {
      feedback.fail(error, t('settings.providerKey.saveFailed'))
    }
  }

  const clear = async () => {
    try {
      await clearKey.mutateAsync(entry.providerId)
      feedback.ok(t('settings.providerKey.clearedOk', { provider: entry.providerName }))
    } catch (error) {
      feedback.fail(error, t('settings.providerKey.clearFailed'))
    }
  }

  return (
    <div className="cred-group card">
      <div className="card__head">
        <p className="card__title">{entry.providerName}</p>
        <Tag>{t(PROVIDER_CREDENTIAL_MODE_KEY.PER_USER)}</Tag>
        {entry.hasKey ? (
          <Tag className="tag--ok">{t('settings.providerKey.configured')}</Tag>
        ) : (
          <Tag className="tag--warn">{t('settings.providerKey.unconfigured')}</Tag>
        )}
        <div className="card__head-right">
          <span className="ratio">
            {entry.hasKey
              ? t('settings.providerKey.currentKey', { key: entry.apiKeyPreview ?? '****' })
              : t('settings.providerKey.notConfiguredPerUser')}
          </span>
        </div>
      </div>

      <div className="card__body stack stack--tight">
        <label className="block-label" htmlFor={`provider-key-${entry.providerId}`}>
          {t('settings.providerKey.apiKeyLabel')}
        </label>
        <Input.Password
          id={`provider-key-${entry.providerId}`}
          value={apiKey}
          autoComplete="off"
          placeholder={
            entry.hasKey
              ? t('settings.providerKey.replacePlaceholder')
              : t('settings.providerKey.pastePlaceholder')
          }
          onChange={(event) => setApiKey(event.target.value)}
        />
        <div className="row" style={{ gap: 'var(--sp-3)' }}>
          <Button type="primary" loading={setKey.isPending} onClick={save}>
            {t('settings.providerKey.saveMine')}
          </Button>
          {entry.hasKey ? (
            <Popconfirm
              title={t('settings.providerKey.clearTitle', { provider: entry.providerName })}
              description={t('settings.providerKey.clearDescription')}
              okText={t('settings.providerKey.clearOk')}
              okButtonProps={{ danger: true }}
              cancelText={t('common.cancel')}
              onConfirm={clear}
            >
              <Button danger loading={clearKey.isPending}>
                {t('settings.providerKey.clearOk')}
              </Button>
            </Popconfirm>
          ) : null}
          <span className="ratio u-right">{t('settings.providerKey.onlyYours')}</span>
        </div>
      </div>
    </div>
  )
}

/** `SHARED`（共享 Key）：只读展示正在生效的共享 Key（掩码） —— 改它去模型池 */
function SharedProviderKeyRow({ entry }: { entry: MyProviderCredentialEntry }) {
  const { t } = useT()
  return (
    <div className="cred-group card">
      <div className="card__head">
        <p className="card__title">{entry.providerName}</p>
        <Tag>{t(PROVIDER_CREDENTIAL_MODE_KEY.SHARED)}</Tag>
        {entry.hasKey ? (
          <Tag className="tag--ok">{t('settings.providerKey.configured')}</Tag>
        ) : (
          <Tag className="tag--warn">{t('settings.providerKey.unconfigured')}</Tag>
        )}
        <div className="card__head-right">
          <span className="ratio">
            {entry.hasKey
              ? t('settings.providerKey.currentKey', { key: entry.apiKeyPreview ?? '****' })
              : t('settings.providerKey.notConfiguredShared')}
          </span>
        </div>
      </div>

      <div className="card__body stack stack--tight">
        <p className="ratio">
          {t('settings.providerKey.sharedBodyA')}
          <strong>{t('settings.providerKey.sharedBodyStrongOwner')}</strong>
          {t('settings.providerKey.sharedBodyB')}
          <strong>{t('settings.providerKey.sharedBodyStrongNoRight')}</strong>
          {t('settings.providerKey.sharedBodyC')}
          <strong>{t('settings.providerKey.sharedBodyStrongModelPool')}</strong>
          {t('settings.providerKey.sharedBodyD')}
        </p>
      </div>
    </div>
  )
}

export function ProviderKeySection() {
  const { t } = useT()
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
          <h2 className="card__title">{t('settings.providerKey.title')}</h2>
          <p className="page__lead">
            {t('settings.providerKey.leadA')}
            <strong>{t('settings.providerKey.leadStrongMine')}</strong>
            {t('settings.providerKey.leadB')}
            <strong>{t('settings.providerKey.leadStrongOwner')}</strong>
            {t('settings.providerKey.leadC')}
          </p>
        </div>
        {unconfigured.length === 0 ? (
          <Tag className="tag--ok">
            {perUser.length === 0
              ? t('settings.providerKey.tagNoConfigNeeded')
              : t('settings.providerKey.tagAllConfigured')}
          </Tag>
        ) : (
          <Tag className="tag--warn">{t('settings.providerKey.tagPending', { count: unconfigured.length })}</Tag>
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
