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

import { Alert, AutoComplete, Button, Input, InputNumber, Modal, Select, Switch } from 'antd'
import { MODEL_TYPES, MODEL_TYPE_LABELS, type ModelItem, type ModelProviderItem, type ModelType } from '@doubulea/shared'
import { useEffect, useMemo, useState } from 'react'

import { describeError } from '../../api/client.js'
import {
  useCreateModel,
  useProbeChatModel,
  useProbeEmbeddingModel,
  useProbeRemoteModels,
  useUpdateModel,
} from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import {
  EMPTY_MODEL_FORM_VALUES,
  MAX_CONTEXT_MAX,
  MAX_CONTEXT_MIN,
  MODEL_TYPE_FOLLOWS_PROVIDER_REASON,
  buildCreateModelBody,
  buildModelUpdateBody,
  modelEditValuesOf,
  modelTypeForProvider,
  remoteModelRows,
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
  const probeEmbedding = useProbeEmbeddingModel()
  const probeChat = useProbeChatModel()

  const [providerId, setProviderId] = useState('')
  const [modelName, setModelName] = useState('')
  const [label, setLabel] = useState('')
  const [type, setType] = useState<ModelType>(EMPTY_MODEL_FORM_VALUES.type)
  const [maxContext, setMaxContext] = useState<number | null>(null)
  const [embeddingDim, setEmbeddingDim] = useState<number | null>(null)
  const [embeddingMultimodal, setEmbeddingMultimodal] = useState(false)
  const [supportsVision, setSupportsVision] = useState(false)
  const [supportsReasoning, setSupportsReasoning] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = model !== null
  /**
   * 方案A：模型的 `type` **跟随所属 Provider**，因此选择器**始终只读** ——
   * 创建时由所选 Provider 决定（见下方 Provider 的 `onChange`），编辑时 Provider 不可迁移、
   * 类型也就不变。这样用户没有机会造出"Provider 是向量、模型却是对话"的不一致配置。
   */
  const typeLocked = true
  const typeLockedReason = editing ? '类型跟随所属 Provider，不可修改。' : MODEL_TYPE_FOLLOWS_PROVIDER_REASON
  /** 向量模型：界面只显示"维度"，隐藏上下文/图片/思考等对话侧字段（类型跟随 Provider，故此刻已知） */
  const isEmbedding = type === 'EMBEDDING'

  // 拉取上游模型：型号名下拉的来源（获取失败/为空时 AutoComplete 仍可手动输入，见下方渲染）。
  // ⚠️ 只在**新建**态、且已选 Provider 时探一次；编辑态不自动打上游（避免打开编辑弹窗就发探测请求）。
  const probe = useProbeRemoteModels()
  useEffect(() => {
    if (!open || editing) return
    if (providerId === '') {
      probe.reset()
      return
    }
    probe.mutate(providerId)
    // 依赖只放 open/providerId：把 probe 放进依赖会让每次 mutate 状态变化都再探一次
  }, [open, editing, providerId])

  /** 上游型号名 → 上下文长度 的查表（选中某个型号时用它默认填充上下文长度） */
  const remoteRows = useMemo(() => (probe.data === undefined ? [] : remoteModelRows(probe.data)), [probe.data])
  const remoteOptions = useMemo(
    () =>
      remoteRows.map((row) => ({
        value: row.id,
        label: row.contextLength === null ? row.id : `${row.id} · 上下文 ${row.contextLength.toLocaleString('en-US')}`,
      })),
    [remoteRows],
  )
  const filteredOptions = useMemo(() => {
    const keyword = modelName.trim().toLowerCase()
    if (keyword === '') return remoteOptions
    return remoteOptions.filter((option) => option.value.toLowerCase().includes(keyword))
  }, [remoteOptions, modelName])

  useEffect(() => {
    if (!open) return
    if (model === null) {
      const initialProviderId = defaultProviderId ?? providers[0]?.id ?? ''
      setProviderId(initialProviderId)
      setModelName('')
      setLabel('')
      // 方案A：类型跟随 Provider（还没选到 Provider 时占位为 CHAT，选了会跟着变）
      setType(modelTypeForProvider(providers, initialProviderId))
      setMaxContext(null)
      setEmbeddingDim(null)
      setEmbeddingMultimodal(false)
      setSupportsVision(false)
      setSupportsReasoning(false)
      setEnabled(true)
    } else {
      const values = modelEditValuesOf(model)
      setProviderId(values.providerId)
      setModelName(values.modelName)
      setLabel(values.label)
      setType(values.type)
      setMaxContext(values.maxContext)
      setEmbeddingDim(values.embeddingDim)
      setEmbeddingMultimodal(values.embeddingMultimodal)
      setSupportsVision(values.supportsVision)
      setSupportsReasoning(values.supportsReasoning)
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

  const probing = probeEmbedding.isPending || probeChat.isPending
  const canProbe = providerId !== '' && modelName.trim() !== '' && !probing && !submitting

  /** 探测向量模型维度（不落库）：成功即回填维度并提示；失败把上游原文显示在表单里 */
  const runProbe = (): void => {
    setErrorText(null)
    probeEmbedding.mutate(
      { providerId, modelName: modelName.trim(), embeddingMultimodal },
      {
        onSuccess: (result) => {
          setEmbeddingDim(result.dim)
          feedback.ok(`探测成功：维度 ${result.dim}。请求 ${result.url}`)
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  /** 对话模型连通测试（不落库；P1-1）：成功提示上游回的短文本与耗时；失败把上游原文显示在表单里 */
  const runChatProbe = (): void => {
    setErrorText(null)
    probeChat.mutate(
      { providerId, modelName: modelName.trim() },
      {
        onSuccess: (result) => {
          const reply = result.reply.trim() === '' ? '（空回复）' : result.reply.trim()
          feedback.ok(`连通成功（${result.durationMs} ms）：${reply}`)
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  const submit = (): void => {
    setErrorText(null)
    if (contextError !== null) {
      setErrorText(contextError)
      return
    }

    const values = { providerId, modelName, label, type, maxContext, embeddingDim, embeddingMultimodal, supportsVision, supportsReasoning, enabled }

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
              onChange={(next) => {
                setProviderId(next)
                // 方案A：换了 Provider，模型类型跟着它走（后端也会校验一致）
                setType(modelTypeForProvider(providers, next))
              }}
            />
          )}
        </div>

        <div>
          <p className="block-label">型号名</p>
          <AutoComplete
            value={modelName}
            options={filteredOptions}
            filterOption={false}
            style={{ width: '100%' }}
            aria-label="型号名"
            placeholder="上游的 model id，例如 gpt-4o-mini（可下拉选择或手动输入）"
            onChange={(value) => setModelName(value)}
            onSelect={(value: string) => {
              setModelName(value)
              // 选中某个上游型号 ⇒ 若上游给了上下文长度、且用户还没填，就默认填上（Req 4）
              // 向量模型不需要上下文长度，跳过自动填充
              const row = remoteRows.find((item) => item.id === value)
              if (!isEmbedding && row !== undefined && row.contextLength !== null && maxContext === null) {
                setMaxContext(row.contextLength)
              }
            }}
          >
            <Input
              maxLength={128}
              onPressEnter={() => {
                if (canSubmit) submit()
              }}
            />
          </AutoComplete>
          {!editing && providerId !== '' && (
            <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
              {probe.isPending
                ? '正在向上游拉取可选型号…（内网地址可能较慢）'
                : probe.isError
                  ? '拉取上游型号失败，可直接手动输入型号名（不影响创建）。'
                  : remoteOptions.length > 0
                    ? `下拉列出上游 ${remoteOptions.length} 个型号，选中会自动带入上下文长度（若上游提供）；也可手动输入。`
                    : '上游没有返回可选型号，请手动输入型号名。'}
            </p>
          )}
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            会<strong>原样</strong>放进调用上游的请求里，所以不能含空格（含空格只会在第一次发消息时
            变成 404，很难排查）。
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
            {typeLockedReason}
          </p>
        </div>

        {isEmbedding ? (
          <>
            <div>
              <p className="block-label">向量维度</p>
              <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
                <InputNumber
                  value={embeddingDim}
                  min={1}
                  max={1_000_000}
                  style={{ flex: 1 }}
                  aria-label="向量维度"
                  placeholder="留空则在保存时尽力向上游探测"
                  onChange={(value) => setEmbeddingDim(value === null ? null : Number(value))}
                />
                <Button onClick={runProbe} loading={probeEmbedding.isPending} disabled={!canProbe}>
                  探测
                </Button>
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                点「探测」会<strong>当场</strong>向该模型发一次极小 embedding（不保存）：成功即回填维度；失败会把上游原文
                显示在下方。留空直接保存时后端也会尽力探测一次，探测不到<strong>不影响保存</strong>，
                但请在此<strong>手动填写维度</strong> —— 否则建知识库时会提示补填。
              </p>
            </div>

            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span>多模态 embedding 端点</span>
                <Switch
                  checked={embeddingMultimodal}
                  aria-label="多模态 embedding 端点"
                  onChange={setEmbeddingMultimodal}
                />
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                某些向量模型（如火山 <code>doubao-embedding-vision</code>）只提供
                <code>POST /embeddings/multimodal</code>，且 <code>input</code> 是 content 数组。开启后本平台按
                <code>{'[{type:"text",text}]'}</code> 形状请求该端点（本平台的知识库是纯文本，只发文本分片）。
                标准 OpenAI 兼容端点<strong>不要</strong>开。
              </p>
            </div>
          </>
        ) : (
          <>
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
                <span>支持深度思考</span>
                <Switch checked={supportsReasoning} aria-label="支持深度思考" onChange={setSupportsReasoning} />
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                开启后对话会向上游请求"深度思考"（reasoning / thinking）：OpenAI 兼容走
                <code>reasoning_effort</code>、Responses 走 <code>reasoning</code>、Anthropic 走
                <code>thinking</code>。只对<strong>真正支持思考的模型</strong>勾选 —— 上游若不认这个参数会报错，
                那时关掉它即可。
              </p>
            </div>

            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span>连通测试</span>
                <Button onClick={runChatProbe} loading={probeChat.isPending} disabled={!canProbe}>
                  测试
                </Button>
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                点「测试」会<strong>当场</strong>向该模型发一次极小对话请求（<code>max_tokens:1</code>，不保存），
                验证 <code>baseUrl</code> / Key / 协议 / 型号名这一整条链路 —— 成功提示上游回的短文本与耗时；
                失败会把上游原文显示在下方。与真实对话走<strong>同一条</strong>调用路径，因此"探测通、一发消息就错"不会发生。
              </p>
            </div>
          </>
        )}

        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="block-label" style={{ marginBottom: 0 }}>
              启用
            </p>
            <Switch checked={enabled} aria-label="启用该模型" onChange={setEnabled} />
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            停用后它不会出现在「可用模型」下拉里；已绑定它的智能体发消息会失败。
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
