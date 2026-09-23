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
 * ⚠️ 另一处不能发明的功能：`type` 在"该 Provider 下已有模型"时**改不了**（后端 409，
 * 理由：`models.type` 与 `model_providers.type` 冗余，级联改会悄悄改变已绑定智能体用的是
 * 哪类模型）。所以选择器标灰 + 写明原因 + 指向"新建一个 Provider"。
 */

import { Alert, Input, Modal, Select, Switch } from 'antd'
import { MODEL_TYPES, MODEL_TYPE_LABELS, type ModelProviderItem, type ModelType } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useCreateModelProvider, useUpdateModelProvider } from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import {
  EMPTY_PROVIDER_FORM_VALUES,
  PROVIDER_TYPE_LOCKED_REASON,
  buildCreateProviderBody,
  buildProviderUpdateBody,
  describeProviderKey,
  providerEditValuesOf,
  providerTypeChangeBlocked,
} from './adminModel.js'

export interface ProviderFormModalProps {
  /** `null` = 创建；非 `null` = 编辑这个 Provider */
  provider: ModelProviderItem | null
  open: boolean
  onClose: () => void
}

const TYPE_OPTIONS = MODEL_TYPES.map((type) => ({ value: type, label: MODEL_TYPE_LABELS[type] }))

export function ProviderFormModal({ provider, open, onClose }: ProviderFormModalProps) {
  const feedback = useFeedback()
  const create = useCreateModelProvider()
  const update = useUpdateModelProvider()

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [type, setType] = useState<ModelType>(EMPTY_PROVIDER_FORM_VALUES.type)
  const [enabled, setEnabled] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [clearRequested, setClearRequested] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = provider !== null
  const typeLocked = provider !== null && providerTypeChangeBlocked(provider)

  // 每次打开都按目标对象重置 —— 尤其是 `apiKey` 必须回到空串（绝不回填掩码，见文件头）
  useEffect(() => {
    if (!open) return
    const values = provider === null ? EMPTY_PROVIDER_FORM_VALUES : providerEditValuesOf(provider)
    setName(values.name)
    setBaseUrl(values.baseUrl)
    setType(values.type)
    setEnabled(values.enabled)
    setApiKey(values.apiKey)
    setClearRequested(false)
    setErrorText(null)
  }, [open, provider])

  const submitting = create.isPending || update.isPending
  const canSubmit = name.trim() !== '' && baseUrl.trim() !== '' && !submitting

  const submit = (): void => {
    setErrorText(null)

    if (provider === null) {
      create.mutate(buildCreateProviderBody({ name, baseUrl, type, enabled, apiKey }), {
        onSuccess: (created) => {
          feedback.ok(
            `已创建 Provider「${created.name}」` +
              (created.hasKey ? '' : '（还没配 Key，可在编辑里补）'),
          )
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      })
      return
    }

    const body = buildProviderUpdateBody(provider, { name, baseUrl, type, enabled, apiKey }, clearRequested)
    if (body === null) {
      feedback.note('没有需要保存的改动')
      onClose()
      return
    }
    update.mutate(
      { id: provider.id, body },
      {
        onSuccess: (saved) => {
          const keyNote =
            body.apiKey === null ? '（已清除 API Key）' : body.apiKey === undefined ? '' : '（已更新 API Key）'
          feedback.ok(`已保存「${saved.name}」${keyNote}`)
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  return (
    <Modal
      open={open}
      title={editing ? `编辑 Provider「${provider.name}」` : '新建 Provider'}
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText="取消"
      onOk={submit}
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
          </p>
        </div>

        <div>
          <p className="block-label">类型</p>
          <Select<ModelType>
            value={type}
            options={TYPE_OPTIONS}
            disabled={typeLocked}
            style={{ width: '100%' }}
            aria-label="Provider 类型"
            onChange={setType}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {typeLocked ? PROVIDER_TYPE_LOCKED_REASON : '对话与向量模型分别属于两类 Provider；建下拉时按类型过滤。'}
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
          <p className="block-label">API Key</p>

          {editing && (
            <p className="num" style={{ marginBottom: 'var(--sp-2)' }}>
              {provider.hasKey ? `当前：${describeProviderKey(provider)}` : '当前：未配置'}
            </p>
          )}

          <Input.Password
            value={apiKey}
            maxLength={512}
            autoComplete="off"
            aria-label="API Key"
            placeholder={editing ? '留空表示保持现有 Key 不变' : '可留空：先建 Provider，之后再补 Key'}
            onChange={(event) => {
              setApiKey(event.target.value)
              // 输入了新值 ⇒ "清除"的意图自动作废（两件事不能同时成立）
              if (event.target.value !== '') setClearRequested(false)
            }}
          />

          {editing && provider.hasKey && (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--sp-3)' }}>
              <span style={{ flex: 1 }}>
                清除已配置的 Key（<code>apiKey: null</code>）
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
            Key <strong>只进不出</strong>：保存后任何接口都不会再回显它（列表里那个 `sk-****abcd`
            是后端解密后取首尾生成的掩码，用来核对配的是哪一把）。留空 = 不动原 Key；
            要清空请用上面的开关 —— 空字符串会被服务端拒绝（400）。
          </p>
        </div>

        {clearRequested && (
          <Alert
            type="warning"
            showIcon
            message="保存后会清除这把 Key"
            description="该 Provider 下的模型将无法再被调用（对话会以鉴权失败告终）。密文删除后无法恢复，只能重新填写。"
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={editing ? '保存失败' : '创建失败'} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
