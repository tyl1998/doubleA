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
  PROVIDER_CREDENTIAL_MODE_LABELS,
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
import {
  EMPTY_PROVIDER_FORM_VALUES,
  PROTOCOL_LOCKED_BY_VECTOR_MODEL_REASON,
  buildCreateProviderBody,
  buildProviderUpdateBody,
  describeProviderKey,
  protocolBaseUrlHint,
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
            feedback.fail(error, 'Provider 已创建，但你的 Key 没能存入「我的凭据」')
            onClose()
            return
          }
          feedback.ok(`已创建 Provider「${created.name}」，并把你的 Key 存入了「我的凭据」`)
          onClose()
          return
        }
        feedback.ok(
          `已创建 Provider「${created.name}」` +
            (credentialMode === 'PER_USER'
              ? '（「各自 Key」模式：请到「我的凭据」配置你自己的 Key）'
              : created.hasKey
                ? ''
                : '（还没配 Key，可在编辑里补）'),
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
      feedback.note('没有需要保存的改动')
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
              ? '（已清除你在「我的凭据」里的 Key）'
              : '（已更新你在「我的凭据」里的 Key）'
            : ''
          : body.apiKey === null
            ? '（已清除 API Key）'
            : body.apiKey === undefined
              ? ''
              : '（已更新 API Key）'
      feedback.ok(`已保存「${provider.name}」${keyNote}`)
      onClose()
    } catch (error) {
      setErrorText(describeError(error).message)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? `编辑 Provider「${provider.name}」` : '新建 Provider'}
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText="取消"
      onOk={() => {
        void submit()
      }}
      onCancel={onClose}
      maskClosable={!submitting}
      width={560}
    >
      <div className="stack">
        <div>
          <p className="block-label">名称</p>
          <Input
            value={name}
            maxLength={128}
            aria-label="Provider 名称"
            placeholder="例如：OpenAI 生产"
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            名称不要求唯一（同名靠 id 区分）。它只是给人看的标签。
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
            必须 http:// 或 https:// 开头；服务端会去掉<strong>尾部斜杠</strong>
            （否则拼出来的 <code>/v1//chat/completions</code> 有的网关当 404）。
            <br />
            {customUrl ? '已开启「自定义 URL」：这里填的就是完整端点，后端原样发请求、不再拼后缀。' : protocolBaseUrlHint(protocol)}
          </p>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
            <Switch checked={customUrl} onChange={setCustomUrl} aria-label="自定义 URL" />
            <p className="block-label" style={{ margin: 0 }}>自定义 URL</p>
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            第三方端点不按 <code>{'{host}/v1'}</code> + 固定后缀规范时开启：上面的 Base URL 会被
            <strong>原样</strong>当作完整端点（可含完整路径、甚至 query），后端<strong>不再拼</strong>
            <code>/chat/completions</code> 等后缀。
            <br />
            ⚠️ 开启后「拉取上游模型」（<code>GET /models</code> 探测）无法从后缀派生，型号名请手工录入。
          </p>
        </div>

        <div>
          <p className="block-label">上游协议</p>
          <Select<UpstreamProtocol>
            value={protocol}
            options={protocolOptions}
            disabled={protocolLocked}
            style={{ width: '100%' }}
            aria-label="上游协议"
            onChange={setProtocol}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {protocolLocked
              ? PROTOCOL_LOCKED_BY_VECTOR_MODEL_REASON
              : '这个 Provider 的上游"怎么说话"：决定请求打到哪个路径、用哪种鉴权头。' +
                'OpenAI 兼容 = /chat/completions，Responses = /responses，Anthropic = /messages（x-api-key）。'}
          </p>
        </div>

        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="block-label" style={{ marginBottom: 0 }}>
              启用
            </p>
            <Switch checked={enabled} aria-label="启用该 Provider" onChange={setEnabled} />
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            停用后它下面的模型<strong>不会</strong>出现在「可用模型」下拉里（含管理员建智能体时），
            已有的智能体发消息会失败。停用是"先停下不再选它"，不是删除。
          </p>
        </div>

        <div>
          <p className="block-label">凭据模式</p>
          <Select
            value={credentialMode}
            options={PROVIDER_CREDENTIAL_MODES.map((mode) => ({
              value: mode,
              label: PROVIDER_CREDENTIAL_MODE_LABELS[mode],
            }))}
            style={{ width: '100%' }}
            aria-label="凭据模式"
            onChange={setCredentialMode}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {credentialMode === 'PER_USER'
              ? '「各自 Key」：每个使用者配自己的 API Key，调用模型时用他的那一把；未配置时对话返回 424「尚未配置所需凭据」。'
              : '「共享 Key」：所有使用者共用上面这把 Key（额度和计费都算在它头上）。'}
          </p>
        </div>

        <div>
          <p className="ratio">
            模型 Provider 没有单独的公开/私有：访问由<strong>所属人</strong>与管理员掌握。想给某位同事使用，
            请保存后在该行点<strong>所属人</strong>把 Provider 转移给他。
          </p>
        </div>

        <div>
          <p className="block-label">{credentialMode === 'PER_USER' ? '你的 Key（各自 Key 模式）' : 'API Key'}</p>

          {editing && (
            <p className="num" style={{ marginBottom: 'var(--sp-2)' }}>
              {credentialMode === 'PER_USER'
                ? provider.userHasKey
                  ? '当前：已配置（你的 Key，存在「我的凭据」里）'
                  : '当前：未配置'
                : provider.hasKey
                  ? `当前：${describeProviderKey(provider)}`
                  : '当前：未配置'}
            </p>
          )}

          <Input.Password
            value={apiKey}
            maxLength={512}
            autoComplete="off"
            aria-label="API Key"
            placeholder={
              credentialMode === 'PER_USER'
                ? editing
                  ? '输入新的 Key 以替换「我的凭据」里的那一把'
                  : '粘贴你的 API Key（可留空，稍后到「我的凭据」填）'
                : editing
                  ? '留空表示保持现有 Key 不变'
                  : '可留空：先建 Provider，之后再补 Key'
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
                    ? '清除你在「我的凭据」里的 Key'
                    : '清除已配置的 Key（apiKey: null）'}
                </span>
                <Switch
                  checked={clearRequested}
                  disabled={apiKey.trim() !== ''}
                  aria-label="清除已配置的 Key"
                  onChange={setClearRequested}
                />
              </div>
            )}

          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {credentialMode === 'PER_USER' ? (
              <>
                这把 Key <strong>只属于你自己</strong>：保存后写入「我的凭据」（仅你能读、能改），
                调用模型时用你自己的那一把（额度、计费都算在你头上）。留空 = 不动；要清空请用上面的开关。
              </>
            ) : (
              <>
                Key <strong>只进不出</strong>：保存后任何接口都不会再回显它（列表里那个 sk-****abcd
                是后端解密后取首尾生成的掩码，用来核对配的是哪一把）。留空 = 不动原 Key；
                要清空请用上面的开关 —— 空字符串会被服务端拒绝（400）。
              </>
            )}
          </p>
        </div>

        {clearRequested && (
          <Alert
            type="warning"
            showIcon
            message={credentialMode === 'PER_USER' ? '保存后会清除你在「我的凭据」里的 Key' : '保存后会清除这把 Key'}
            description={
              credentialMode === 'PER_USER'
                ? '清除后，经该 Provider 的对话会报「尚未配置所需凭据」，直到你重新填写。'
                : '该 Provider 下的模型将无法再被调用（对话会以鉴权失败告终）。密文删除后无法恢复，只能重新填写。'
            }
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={editing ? '保存失败' : '创建失败'} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
