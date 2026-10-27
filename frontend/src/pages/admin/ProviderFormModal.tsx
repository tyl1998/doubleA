/**
 * Provider 的创建 / 编辑弹窗（P0-1-36）
 *
 * 依据：`docs/03` §七（字段 ≤6 用弹窗、同一实体创建与编辑同形态）、§二/§三（`/admin/models` 是 ADMIN）、
 *      `docs/02` §4.3「契约增量 · Provider」、`shared/src/modelProvider.ts`（三态 + `baseUrl` 归一化）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批最要紧的一条就在这个弹窗里：**Key 有进无出**
 * ─────────────────────────────────────────────────────────────────────
 * `01` §3.2 的验收要点是「Key 不回显明文」，`02` §4.3 的口径是"渲染成掩码 + 「重新设置」按钮，
 * **不回填输入框**"。所以编辑态是这样三块，而不是一个预填了掩码的输入框：
 *   ① 已配置 ⇒ 只读展示 `apiKeyPreview`（掩码，由后端**解密后**取首尾生成）+ 一句"掩码只是
 *      用来核对配的是哪一把 key"；
 *   ② 一个**空**的输入框，写着"留空 = 保持现有 Key"；
 *   ③ 一个显式的「清除 Key」开关（`apiKey: null`）。
 *
 * ⚠️ 为什么必须有一个**显式**的清除入口，而不能"输入框清空就代表清除"：契约里空串是 **400**
 * （`providerApiKeySchema`），只有"不带 = 不动"与 "`null` = 清空"两条路。把清空输入框当成清除，
 * 会让"改个名字顺手把输入框里的掩码删掉"变成一次**静默的密钥删除**（`02` §4.3 原文：
 * "改个名字会顺手把 Key 抹掉 —— 而且是静默的，要等到真正调用模型时才发现"）。
 *
 * ⚠️ 2026-10-22：**Provider 不再有「类型」字段**（`model_providers.type` 整列删除）——
 * 同一个 Provider（同一个 baseUrl + 同一把 Key）下可以同时挂对话与向量模型，类型属于**模型**。
 * 所以本表单里既没有类型选择器、也没有"改类型"这件事（原先那条"有模型就不许改 type → 409"
 * 随方案A一起废除）。见 `docs/子方案/Provider与模型类型解耦.md`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-37 加的第三个字段：上游协议
 * ─────────────────────────────────────────────────────────────────────
 * `protocol` 决定"报文怎么发"（`/chat/completions` vs `/responses` vs `/messages`，
 * 以及鉴权头是 `Bearer` 还是 `x-api-key`）。界面上两处与它相关：
 *   · 可选值由 `protocolOptionsFor(hasEmbeddingModel)` 过滤 —— **该 Provider 下有向量模型**时
 *     只剩默认协议（`EMBEDDING` 只有 `/embeddings` 一条路），理由写在提示里；
 *     ⚠️ 2026-10-22 起判据的输入是"**有没有向量模型**"（同一 Provider 可同时挂两类模型）。
 * 另外 `baseUrl` 的提示随协议变 —— 三条路后缀不同（`/chat/completions` / `/responses` /
 * `/messages`），把整条 URL 粘进 baseUrl 的表现是 404，且 404 的文案只会说"检查版本段"。
 */

import { Alert, Input, Modal, Select, Switch } from 'antd'
import {
  PROVIDER_CREDENTIAL_MODES,
  PROVIDER_CREDENTIAL_MODE_KEY,
  type ModelProviderItem,
  type ProviderCredentialMode,
  type UpstreamProtocol,
} from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import {
  useCreateModelProvider,
  useDeleteMyProviderCredential,
  useSetMyProviderCredential,
  useUpdateModelProvider,
} from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import {
  EMPTY_PROVIDER_FORM_VALUES,
  buildCreateProviderBody,
  buildProviderUpdateBody,
  describeProviderKey,
  protocolBaseUrlHint,
  protocolLockedReason,
  protocolOptionsFor,
  providerEditValuesOf,
} from './adminModel.js'

export interface ProviderFormModalProps {
  /** `null` = 创建；非 `null` = 编辑这个 Provider */
  provider: ModelProviderItem | null
  open: boolean
  onClose: () => void
}

export function ProviderFormModal({ provider, open, onClose }: ProviderFormModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const create = useCreateModelProvider()
  const update = useUpdateModelProvider()
  // P1-18：`PER_USER` 模式下表单里那把 Key 是**创建人自己的 Key** ⇒ 走「我的凭据」端点
  // （不再有行内「我的 Key」入口 —— 统一在「我的凭据」页维护）。
  const setMyCredential = useSetMyProviderCredential()
  const deleteMyCredential = useDeleteMyProviderCredential()

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customUrl, setCustomUrl] = useState(EMPTY_PROVIDER_FORM_VALUES.customUrl)
  const [protocol, setProtocol] = useState<UpstreamProtocol>(EMPTY_PROVIDER_FORM_VALUES.protocol)
  const [enabled, setEnabled] = useState(true)
  const [credentialMode, setCredentialMode] = useState<ProviderCredentialMode>(
    EMPTY_PROVIDER_FORM_VALUES.credentialMode,
  )
  const [apiKey, setApiKey] = useState('')
  const [clearRequested, setClearRequested] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = provider !== null
  /**
   * 协议下拉的可用值由"该 Provider 下**有没有向量模型**"决定（{@link protocolOptionsFor}）：
   * 有向量模型 ⇒ 只剩默认协议（embedding 只有 `/embeddings` 一条路）。
   * ⚠️ 创建态 `provider === null` ⇒ `hasEmbeddingModel` 恒 false，三种协议都可选。
   */
  const protocolOptions = protocolOptionsFor(provider?.hasEmbeddingModel === true)
  const protocolLocked = protocolOptions.length === 1

  // 每次打开都按目标对象重置 —— 尤其是 `apiKey` 必须回到空串（绝不回填掩码，见文件头）
  useEffect(() => {
    if (!open) return
    const values = provider === null ? EMPTY_PROVIDER_FORM_VALUES : providerEditValuesOf(provider)
    setName(values.name)
    setBaseUrl(values.baseUrl)
    setCustomUrl(values.customUrl)
    setProtocol(values.protocol)
    setEnabled(values.enabled)
    setCredentialMode(values.credentialMode)
    setApiKey(values.apiKey)
    setClearRequested(false)
    setErrorText(null)
  }, [open, provider])

  const submitting =
    create.isPending || update.isPending || setMyCredential.isPending || deleteMyCredential.isPending
  const canSubmit = name.trim() !== '' && baseUrl.trim() !== '' && !submitting

  const submit = async (): Promise<void> => {
    setErrorText(null)

    // P1-18：`PER_USER` 模式下输入框里那把 Key 是**创建人自己的 Key**（写「我的凭据」）；
    // `SHARED` 模式下它才是共享 Key（进 Provider 建/改体）。判据唯一 = `credentialMode`。
    const personalKey = credentialMode === 'PER_USER' ? apiKey.trim() : ''

    if (provider === null) {
      try {
        const created = await create.mutateAsync(
          buildCreateProviderBody({ name, baseUrl, customUrl, protocol, enabled, apiKey, credentialMode }),
        )
        if (personalKey !== '') {
          // Provider 已经建出来了 —— 这一步失败**不能**假装整体失败（那会让用户重建成两条）。
          try {
            await setMyCredential.mutateAsync({ id: created.id, apiKey: personalKey })
          } catch (error) {
            feedback.fail(error, t('providerForm.keyStoreFailed'))
            onClose()
            return
          }
          feedback.ok(t('providerForm.createdWithKey', { name: created.name }))
          onClose()
          return
        }
        feedback.ok(
          t('providerForm.created', { name: created.name }) +
            (credentialMode === 'PER_USER'
              ? t('providerForm.perUserHint')
              : created.hasKey
                ? ''
                : t('providerForm.noKeyHint')),
        )
        onClose()
      } catch (error) {
        setErrorText(describeError(error).message)
      }
      return
    }

    const body = buildProviderUpdateBody(
      provider,
      { name, baseUrl, customUrl, protocol, enabled, apiKey, credentialMode },
      clearRequested,
    )
    const personalTouched = credentialMode === 'PER_USER' && (personalKey !== '' || clearRequested)
    if (body === null && !personalTouched) {
      feedback.note(t('providerForm.noChanges'))
      onClose()
      return
    }
    try {
      if (body !== null) await update.mutateAsync({ id: provider.id, body })
      if (personalKey !== '') await setMyCredential.mutateAsync({ id: provider.id, apiKey: personalKey })
      else if (credentialMode === 'PER_USER' && clearRequested) await deleteMyCredential.mutateAsync(provider.id)

      const keyNote =
        body === null
          ? credentialMode === 'PER_USER'
            ? clearRequested
              ? t('providerForm.clearedMyKey')
              : t('providerForm.updatedMyKey')
            : ''
          : body.apiKey === null
            ? t('providerForm.clearedApiKey')
            : body.apiKey === undefined
              ? ''
              : t('providerForm.updatedApiKey')
      feedback.ok(t('providerForm.saved', { name: provider.name, note: keyNote }))
      onClose()
    } catch (error) {
      setErrorText(describeError(error).message)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? t('providerForm.titleEdit', { name: provider.name }) : t('providerForm.titleCreate')}
      okText={editing ? t('common.save') : t('userForm.okCreate')}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText={t('common.cancel')}
      onOk={() => {
        void submit()
      }}
      onCancel={onClose}
      maskClosable={!submitting}
      width={560}
    >
      <div className="stack">
        <div>
          <p className="block-label">{t('providerForm.name')}</p>
          <Input
            value={name}
            maxLength={128}
            aria-label={t('providerForm.nameAria')}
            placeholder={t('providerForm.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('providerForm.nameNote')}
          </p>
        </div>

        <div>
          <p className="block-label">Base URL</p>
          <Input
            value={baseUrl}
            maxLength={2048}
            aria-label="Base URL"
            placeholder="https://api.openai.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('providerForm.baseUrlRequired')}
            <br />
            {customUrl ? t('providerForm.customUrlNote') : protocolBaseUrlHint(protocol, locale)}
          </p>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
            <Switch checked={customUrl} onChange={setCustomUrl} aria-label={t('providerForm.customUrlAria')} />
            <p className="block-label" style={{ margin: 0 }}>{t('providerForm.customUrl')}</p>
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('providerForm.customUrlNotePrefix')}<code>{'{host}/v1'}</code>{t('providerForm.customUrlNoteMid')}
            <strong>{t('providerForm.customUrlNoteStrong1')}</strong>{t('providerForm.customUrlNoteMid2')}
            <strong>{t('providerForm.customUrlNoteStrong2')}</strong>
            <code>/chat/completions</code>{t('providerForm.customUrlNoteMid3')}
            <br />
            {t('providerForm.customUrlWarn')}<code>GET /models</code>{t('providerForm.customUrlWarnMid')}
          </p>
        </div>

        <div>
          <p className="block-label">{t('providerForm.protocol')}</p>
          <Select<UpstreamProtocol>
            value={protocol}
            options={protocolOptions.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
            disabled={protocolLocked}
            style={{ width: '100%' }}
            aria-label={t('providerForm.protocolAria')}
            onChange={setProtocol}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {protocolLocked ? protocolLockedReason(locale) : t('providerForm.protocolNote')}
          </p>
        </div>

        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="block-label" style={{ marginBottom: 0 }}>
              {t('providerForm.enable')}
            </p>
            <Switch checked={enabled} aria-label={t('providerForm.enableAria')} onChange={setEnabled} />
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('providerForm.enableNotePrefix')}<strong>{t('providerForm.enableNoteStrong')}</strong>
            {t('providerForm.enableNoteTail')}
          </p>
        </div>

        <div>
          <p className="block-label">{t('providerForm.credentialMode')}</p>
          <Select
            value={credentialMode}
            options={PROVIDER_CREDENTIAL_MODES.map((mode) => ({
              value: mode,
              label: t(PROVIDER_CREDENTIAL_MODE_KEY[mode]),
            }))}
            style={{ width: '100%' }}
            aria-label={t('providerForm.credentialModeAria')}
            onChange={setCredentialMode}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {credentialMode === 'PER_USER' ? t('providerForm.perUserDesc') : t('providerForm.sharedDesc')}
          </p>
        </div>

        <div>
          <p className="ratio">
            {t('providerForm.ownerNotePrefix')}<strong>{t('providerForm.ownerNoteStrong1')}</strong>
            {t('providerForm.ownerNoteMid')}<strong>{t('providerForm.ownerNoteStrong2')}</strong>
            {t('providerForm.ownerNoteTail')}
          </p>
        </div>

        <div>
          <p className="block-label">
            {credentialMode === 'PER_USER' ? t('providerForm.perUserKey') : t('providerForm.apiKey')}
          </p>

          {editing && (
            <p className="num" style={{ marginBottom: 'var(--sp-2)' }}>
              {credentialMode === 'PER_USER'
                ? provider.userHasKey
                  ? t('providerForm.currentConfiguredMyKey')
                  : t('providerForm.currentUnconfigured')
                : provider.hasKey
                  ? t('providerForm.currentPrefixed', { value: describeProviderKey(provider, locale) })
                  : t('providerForm.currentUnconfigured')}
            </p>
          )}

          <Input.Password
            value={apiKey}
            maxLength={512}
            autoComplete="off"
            aria-label={t('providerForm.apiKey')}
            placeholder={
              credentialMode === 'PER_USER'
                ? editing
                  ? t('providerForm.inputNewMyKey')
                  : t('providerForm.inputApiKey')
                : editing
                  ? t('providerForm.keepExisting')
                  : t('providerForm.canLeaveBlank')
            }
            onChange={(event) => {
              setApiKey(event.target.value)
              // 输入了新值 ⇒ "清除"的意图自动作废（两件事不能同时成立）
              if (event.target.value !== '') setClearRequested(false)
            }}
          />

          {/* 「清除」只在"确实有东西可清"时出现：`SHARED` 看清共享 Key、`PER_USER` 清我在「我的凭据」里的 Key */}
          {editing &&
            (credentialMode === 'PER_USER' ? provider.userHasKey : provider.hasKey) && (
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--sp-3)' }}>
                <span style={{ flex: 1 }}>
                  {credentialMode === 'PER_USER'
                    ? t('providerForm.clearMyKey')
                    : t('providerForm.clearApiKey')}
                </span>
                <Switch
                  checked={clearRequested}
                  disabled={apiKey.trim() !== ''}
                  aria-label={t('providerForm.clearAria')}
                  onChange={setClearRequested}
                />
              </div>
            )}

          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {credentialMode === 'PER_USER' ? (
              <>
                {t('providerForm.perUserKeyNotePrefix')}<strong>{t('providerForm.perUserKeyNoteStrong1')}</strong>
                {t('providerForm.perUserKeyNoteTail')}
              </>
            ) : (
              <>
                {t('providerForm.sharedKeyNotePrefix')}<strong>{t('providerForm.sharedKeyNoteStrong1')}</strong>
                {t('providerForm.sharedKeyNoteTail')}
              </>
            )}
          </p>
        </div>

        {clearRequested && (
          <Alert
            type="warning"
            showIcon
            message={credentialMode === 'PER_USER' ? t('providerForm.clearWarnMyKey') : t('providerForm.clearWarnApiKey')}
            description={
              credentialMode === 'PER_USER'
                ? t('providerForm.clearDescMyKey')
                : t('providerForm.clearDescApiKey')
            }
          />
        )}

        {errorText !== null && (
          <Alert
            type="error"
            showIcon
            message={editing ? t('models.saveFailed') : t('models.createFailed')}
            description={errorText}
          />
        )}
      </div>
    </Modal>
  )
}
