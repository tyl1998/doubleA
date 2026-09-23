/**
 * 模型的创建 / 编辑弹窗（P0-1-36）
 *
 * 依据：`docs/03` §七（字段 ≤6 用弹窗、创建与编辑同形态）、§4.2（模型下拉要显示上下文长度与
 *      是否支持图片 —— 那是**选模型**那一侧的口径，这里维护的是这些字段本身）、
 *      `docs/02` §4.3「契约增量 · 模型」、`shared/src/model.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处"看着该能改、其实改了必然 409 / 会静默改坏"的字段
 * ─────────────────────────────────────────────────────────────────────
 * ① **Provider 在编辑态只读**：`updateModelBodySchema` 里 `providerId` 是"可传但改不了"
 *    （值不同 → 409）。契约把它放在 schema 里，正是为了**把静默 no-op 变成显式报错**；
 *    界面上则更进一步：**根本不提供这个入口**，并说明"要迁移请新建一条再改绑智能体"。
 *    所以编辑态的请求体里**不带 `providerId`**（见 `buildModelUpdateBody`）。
 * ② **`type` 被智能体引用时只读**：CHAT / EMBEDDING 不可互换，改了等于让已上线的智能体
 *    悄悄换一类模型（下一次发消息才暴露）⇒ 后端 409，界面标灰。
 * ③ **`maxContext` 是三态，不是两态**（`02` §4.3：不带 = 不动 / `null` = 清空 / 数字 = 设置）：
 *    用户清空这个输入框 = **明确要清空**（发 `null`），而"原来就是空的、这次也没填" =
 *    不动（不带这个键）。判据是"**与已存值比较**"，在 `buildModelUpdateBody` 里收口 ——
 *    写成 `.optional().default(null)` 会让"改个别名"顺手把上下文长度抹掉。
 */

import { Alert, Input, InputNumber, Modal, Select, Switch } from 'antd'
import { MODEL_TYPES, MODEL_TYPE_LABELS, type ModelItem, type ModelProviderItem, type ModelType } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useCreateModel, useUpdateModel } from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import {
  EMPTY_MODEL_FORM_VALUES,
  MAX_CONTEXT_MAX,
  MAX_CONTEXT_MIN,
  MODEL_TYPE_LOCKED_REASON,
  buildCreateModelBody,
  buildModelUpdateBody,
  modelEditValuesOf,
  modelTypeChangeBlocked,
  validateMaxContext,
} from './adminModel.js'

export interface ModelFormModalProps {
  /** `null` = 创建；非 `null` = 编辑这个模型 */
  model: ModelItem | null
  open: boolean
  /** 可选的 Provider（创建时用；停用的也要列出来 —— 那正是"先建好再启用"的做法） */
  providers: readonly ModelProviderItem[]
  /** 创建时的默认 Provider（从某个 Provider 行的「加模型」进来时带上下文） */
  defaultProviderId?: string
  onClose: () => void
}

const TYPE_OPTIONS = MODEL_TYPES.map((type) => ({ value: type, label: MODEL_TYPE_LABELS[type] }))

export function ModelFormModal({ model, open, providers, defaultProviderId, onClose }: ModelFormModalProps) {
  const feedback = useFeedback()
  const create = useCreateModel()
  const update = useUpdateModel()

  const [providerId, setProviderId] = useState('')
  const [modelName, setModelName] = useState('')
  const [label, setLabel] = useState('')
  const [type, setType] = useState<ModelType>(EMPTY_MODEL_FORM_VALUES.type)
  const [maxContext, setMaxContext] = useState<number | null>(null)
  const [supportsVision, setSupportsVision] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = model !== null
  const typeLocked = model !== null && modelTypeChangeBlocked(model)

  useEffect(() => {
    if (!open) return
    if (model === null) {
      setProviderId(defaultProviderId ?? providers[0]?.id ?? '')
      setModelName('')
      setLabel('')
      setType(EMPTY_MODEL_FORM_VALUES.type)
      setMaxContext(null)
      setSupportsVision(false)
      setEnabled(true)
    } else {
      const values = modelEditValuesOf(model)
      setProviderId(values.providerId)
      setModelName(values.modelName)
      setLabel(values.label)
      setType(values.type)
      setMaxContext(values.maxContext)
      setSupportsVision(values.supportsVision)
      setEnabled(values.enabled)
    }
    setErrorText(null)
    // ⚠️ `providers` **刻意不在依赖里**：它只在"创建"那一态参与初值（挑第一个可选的），
    // 而保存成功后列表刷新会让这个数组换成新对象 ⇒ 若把它写进依赖，弹窗会在**用户眼前**
    // 把刚填的内容重置一遍（表现为"我明明填了、它自己变回去了"）。
  }, [open, model, defaultProviderId])

  const submitting = create.isPending || update.isPending
  const contextError = validateMaxContext(maxContext)
  const canSubmit =
    modelName.trim() !== '' && label.trim() !== '' && (editing || providerId !== '') && contextError === null && !submitting

  const submit = (): void => {
    setErrorText(null)
    if (contextError !== null) {
      setErrorText(contextError)
      return
    }

    const values = { providerId, modelName, label, type, maxContext, supportsVision, enabled }

    if (model === null) {
      create.mutate(buildCreateModelBody(values), {
        onSuccess: (created) => {
          feedback.ok(`已创建模型「${created.label}」（${created.modelName}）`)
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      })
      return
    }

    const body = buildModelUpdateBody(model, values)
    if (body === null) {
      feedback.note('没有需要保存的改动')
      onClose()
      return
    }
    update.mutate(
      { id: model.id, body },
      {
        onSuccess: (saved) => {
          feedback.ok(`已保存「${saved.label}」`)
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: `${provider.name}${provider.enabled ? '' : '（已停用）'}`,
  }))

  return (
    <Modal
      open={open}
      title={editing ? `编辑模型「${model.label}」` : '新建模型'}
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText="取消"
      onOk={submit}
      onCancel={onClose}
      maskClosable={!submitting}
      width={560}
    >
      <div className="stack">
        {!editing && providers.length === 0 && (
          <Alert
            type="warning"
            showIcon
            message="还没有 Provider"
            description="模型必须挂在某个 Provider 下（它提供 baseUrl 与 API Key）。请先在上面的表里新建一个 Provider。"
          />
        )}

        <div>
          <p className="block-label">Provider</p>
          {editing ? (
            <>
              <p>{model.providerName}</p>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                模型不能迁移到别的 Provider（后端会 409）：迁移会静默改变已绑定智能体走的是哪个上游。
                要换，请新建一条模型再去智能体编辑页改绑。
              </p>
            </>
          ) : (
            <Select
              value={providerId === '' ? undefined : providerId}
              options={providerOptions}
              placeholder="选择 Provider"
              style={{ width: '100%' }}
              aria-label="所属 Provider"
              onChange={setProviderId}
            />
          )}
        </div>

        <div>
          <p className="block-label">型号名</p>
          <Input
            value={modelName}
            maxLength={128}
            aria-label="型号名"
            placeholder="上游的 model id，例如 gpt-4o-mini"
            onChange={(event) => setModelName(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            会<strong>原样</strong>放进调用上游的请求里，所以不能含空格（含空格只会在第一次发消息时
            变成 404，很难排查）。不确定的话用 Provider 行上的「拉取上游模型」探一次再照抄。
          </p>
        </div>

        <div>
          <p className="block-label">别名</p>
          <Input
            value={label}
            maxLength={128}
            aria-label="别名"
            placeholder="给业务同学看的名字，可以是中文"
            onChange={(event) => setLabel(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
        </div>

        <div>
          <p className="block-label">类型</p>
          <Select<ModelType>
            value={type}
            options={TYPE_OPTIONS}
            disabled={typeLocked}
            style={{ width: '100%' }}
            aria-label="模型类型"
            onChange={setType}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {typeLocked
              ? MODEL_TYPE_LOCKED_REASON
              : '刻意不要求"与 Provider 的类型一致"：同一型号名既提供对话又提供向量（如 bge 兼容端点）是合法的配置。'}
          </p>
        </div>

        <div>
          <p className="block-label">上下文长度（token）</p>
          <InputNumber
            value={maxContext}
            min={MAX_CONTEXT_MIN}
            max={MAX_CONTEXT_MAX}
            style={{ width: '100%' }}
            aria-label="上下文长度"
            placeholder="留空表示未知"
            onChange={(value) => setMaxContext(value === null ? null : Number(value))}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            只是给选模型的人看的读数（不参与任何计算）。留空会显示成「未知」——比填一个猜的数字好。
          </p>
        </div>

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span>支持图片输入</span>
          <Switch checked={supportsVision} aria-label="支持图片输入" onChange={setSupportsVision} />
        </div>

        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="block-label" style={{ marginBottom: 0 }}>
              启用
            </p>
            <Switch checked={enabled} aria-label="启用该模型" onChange={setEnabled} />
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            停用后它不会出现在「可用模型」下拉里（含管理员自己建智能体时，
            <code>01</code> §3.2 的验收要点）；已绑定它的智能体发消息会失败。
          </p>
        </div>

        {contextError !== null && <Alert type="warning" showIcon message={contextError} />}

        {errorText !== null && (
          <Alert type="error" showIcon message={editing ? '保存失败' : '创建失败'} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
