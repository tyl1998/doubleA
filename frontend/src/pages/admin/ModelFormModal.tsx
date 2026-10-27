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
 *    ⚠️ 2026-10-22 起**未**被引用时 `type` **可改**（原"恒跟随 Provider"的组织已废除）：
 *    同一个 Provider 下可以同时挂对话与向量模型，类型只是"模型自己的用途"。
 * ③ **`maxContext` 是三态，不是两态**（`02` §4.3：不带 = 不动 / `null` = 清空 / 数字 = 设置）：
 *    用户清空这个输入框 = **明确要清空**（发 `null`），而"原来就是空的、这次也没填" =
 *    不动（不带这个键）。判据是"**与已存值比较**"，在 `buildModelUpdateBody` 里收口 ——
 *    写成 `.optional().default(null)` 会让"改个别名"顺手把上下文长度抹掉。
 */

import { Alert, App as AntdApp, AutoComplete, Button, Input, InputNumber, Modal, Select, Switch } from 'antd'
import {
  DEFAULT_UPSTREAM_PROTOCOL,
  MODEL_TYPES,
  MODEL_TYPE_KEY,
  type ModelItem,
  type ModelProviderItem,
  type ModelType,
} from '@doubulea/shared'
import { useEffect, useMemo, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useKnowledgeBases } from '../../api/knowledgeBases.js'
import {
  useCreateModel,
  useProbeChatModel,
  useProbeEmbeddingModel,
  useProbeRemoteModels,
  useUpdateModel,
} from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import {
  EMPTY_MODEL_FORM_VALUES,
  MAX_CONTEXT_MAX,
  MAX_CONTEXT_MIN,
  MODEL_TYPE_HINT_KEY,
  MODEL_TYPE_LOCKED_REASON_KEY,
  buildCreateModelBody,
  buildModelUpdateBody,
  knowledgeBasesUsingModel,
  modelEditAffectsVectors,
  modelEditValuesOf,
  modelTypeChangeBlocked,
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

export function ModelFormModal({ model, open, providers, defaultProviderId, onClose }: ModelFormModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const { modal } = AntdApp.useApp()
  const create = useCreateModel()
  const update = useUpdateModel()
  const probeEmbedding = useProbeEmbeddingModel()
  const probeChat = useProbeChatModel()
  // 编辑被引用的向量模型时要列出"哪些库需要重建"（列表取前 100 条，足够覆盖内部工具的规模）
  const knowledgeBases = useKnowledgeBases()

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
   * 模型的 `type` 是**模型自己的用途**（对话 / 向量），**可编辑**。
   *
   * ⚠️ 2026-10-22 起解开了原先"恒只读（跟随 Provider）"的处置：Provider 上的类型列已整列删除，
   * 同一个 Provider（同一个 baseUrl + 同一把 Key）下可以同时挂对话与向量模型，所以类型必须能选。
   * 初值取 `EMPTY_MODEL_FORM_VALUES.type`（`CHAT`），用户在下方下拉里按需改。
   *
   * ⚠️ 编辑态仍有一条**真**的锁：被智能体引用时不可改类型（{@link modelTypeChangeBlocked}，
   * 后端 409）—— 那与"跟随 Provider"是两件不同的事。
   */
  const typeLocked = editing && modelTypeChangeBlocked(model)
  const typeLockedReason = editing ? t(MODEL_TYPE_LOCKED_REASON_KEY) : t(MODEL_TYPE_HINT_KEY)
  /** 向量模型：界面只显示"维度"，隐藏上下文/图片/思考等对话侧字段 */
  const isEmbedding = type === 'EMBEDDING'
  const typeOptions = MODEL_TYPES.map((option) => ({ value: option, label: t(MODEL_TYPE_KEY[option]) }))

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
        label:
          row.contextLength === null
            ? row.id
            : t('models.remoteOptionContext', { id: row.id, context: row.contextLength.toLocaleString('en-US') }),
      })),
    [remoteRows, t],
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
      // 2026-10-22：类型初值固定 CHAT（Provider 已无类型列），用户可在下拉里改成向量
      setType(EMPTY_MODEL_FORM_VALUES.type)
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
  const contextError = validateMaxContext(maxContext, locale)
  /**
   * 想建/改成向量模型，但所属 Provider 用的不是 OpenAI 兼容协议 ⇒ 这次必然被后端 400
   * （embedding 只有 `/embeddings` 一条路，判据 = `shared#embeddingModelAllowedOnProtocol`）。
   * 界面上据此拦在提交前并说明原因 —— 与 `RemoteModelsDrawer` 的同名判据是同一条。
   */
  const protocol = providers.find((item) => item.id === providerId)?.protocol ?? DEFAULT_UPSTREAM_PROTOCOL
  const embeddingProtocolBlocked = type === 'EMBEDDING' && protocol !== DEFAULT_UPSTREAM_PROTOCOL
  const canSubmit =
    modelName.trim() !== '' &&
    label.trim() !== '' &&
    (editing || providerId !== '') &&
    contextError === null &&
    !embeddingProtocolBlocked &&
    !submitting

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
          feedback.ok(t('models.probeOk', { dim: result.dim, url: result.url }))
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
          const reply = result.reply.trim() === '' ? t('models.probeEmptyReply') : result.reply.trim()
          feedback.ok(t('models.connectOk', { ms: result.durationMs, reply }))
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
          feedback.ok(t('models.created', { label: created.label, name: created.modelName }))
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      })
      return
    }

    const body = buildModelUpdateBody(model, values)
    if (body === null) {
      feedback.note(t('models.formNoChanges'))
      onClose()
      return
    }

    const doSave = (): void => {
      update.mutate(
        { id: model.id, body },
        {
          onSuccess: (saved) => {
            feedback.ok(t('models.saved', { label: saved.label }))
            onClose()
          },
          onError: (error) => setErrorText(describeError(error).message),
        },
      )
    }

    // 改了会让"引用它的知识库"向量作废的字段（型号/维度/多模态/停用）⇒ 先弹确认、列出受影响的库（P1-5 补）
    if (modelEditAffectsVectors(model, values) && model.knowledgeBaseCount > 0) {
      const affected = knowledgeBasesUsingModel(model.id, knowledgeBases.data?.items ?? [])
      modal.confirm({
        title: t('models.kbRebuildTitle'),
        content: (
          <div>
            <p>
              {t('models.kbRebuildPrefix', { label: model.label })}
              <strong>{model.knowledgeBaseCount}</strong>
              {t('models.kbRebuildMid')}
            </p>
            {affected.length > 0 && (
              <ul style={{ margin: 'var(--sp-2) 0 var(--sp-3)', paddingLeft: 'var(--sp-5)' }}>
                {affected.map((kb) => (
                  <li key={kb.id}>{kb.name}</li>
                ))}
              </ul>
            )}
            <p>
              {t('models.kbRebuildNotePrefix')}
              <strong>{t('models.kbRebuildNoteStrong')}</strong>
              {t('models.kbRebuildNoteTail')}
            </p>
          </div>
        ),
        okText: t('models.continueSave'),
        cancelText: t('common.cancel'),
        onOk: doSave,
      })
      return
    }
    doSave()
  }

  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: `${provider.name}${provider.enabled ? '' : t('models.providerDisabledSuffix')}`,
  }))

  return (
    <Modal
      open={open}
      title={editing ? t('models.formTitleEdit', { label: model.label }) : t('models.formTitleCreate')}
      okText={t('common.save')}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText={t('common.cancel')}
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
            message={t('models.noProviderTitle')}
            description={t('models.noProviderFormDesc')}
          />
        )}

        <div>
          <p className="block-label">Provider</p>
          {editing ? (
            <>
              <p>{model.providerName}</p>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('models.providerImmutableNote')}
              </p>
            </>
          ) : (
            <Select
              value={providerId === '' ? undefined : providerId}
              options={providerOptions}
              placeholder={t('models.providerPlaceholder')}
              style={{ width: '100%' }}
              aria-label={t('models.providerAria')}
              onChange={(next) => {
                setProviderId(next)
                // 2026-10-22：类型初值固定 CHAT（Provider 已无类型列），不随 Provider 变化
              }}
            />
          )}
        </div>

        <div>
          <p className="block-label">{t('models.modelName')}</p>
          <AutoComplete
            value={modelName}
            options={filteredOptions}
            filterOption={false}
            style={{ width: '100%' }}
            aria-label={t('models.modelNameAria')}
            placeholder={t('models.modelNamePlaceholder')}
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
                ? t('models.remoteLoading')
                : probe.isError
                  ? t('models.remoteFailed')
                  : remoteOptions.length > 0
                    ? t('models.remoteListed', { count: remoteOptions.length })
                    : t('models.remoteEmpty')}
            </p>
          )}
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('models.modelNameNotePrefix')}
            <strong>{t('models.modelNameNoteStrong')}</strong>
            {t('models.modelNameNoteTail')}
          </p>
        </div>

        <div>
          <p className="block-label">{t('models.label')}</p>
          <Input
            value={label}
            maxLength={128}
            aria-label={t('models.labelAria')}
            placeholder={t('models.labelPlaceholder')}
            onChange={(event) => setLabel(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
        </div>

        <div>
          <p className="block-label">{t('models.typeLabel')}</p>
          <Select<ModelType>
            value={type}
            options={typeOptions}
            disabled={typeLocked}
            style={{ width: '100%' }}
            aria-label={t('models.typeAria')}
            onChange={setType}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {typeLockedReason}
          </p>
          {embeddingProtocolBlocked && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 'var(--sp-2)' }}
              message={t('models.embeddingConflict', { protocol: DEFAULT_UPSTREAM_PROTOCOL })}
            />
          )}
        </div>

        {isEmbedding ? (
          <>
            <div>
              <p className="block-label">{t('models.embeddingDim')}</p>
              <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
                <InputNumber
                  value={embeddingDim}
                  min={1}
                  max={1_000_000}
                  style={{ flex: 1 }}
                  aria-label={t('models.embeddingDimAria')}
                  placeholder={t('models.embeddingDimPlaceholder')}
                  onChange={(value) => setEmbeddingDim(value === null ? null : Number(value))}
                />
                <Button onClick={runProbe} loading={probeEmbedding.isPending} disabled={!canProbe}>
                  {t('models.probe')}
                </Button>
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('models.probeNotePrefix')}
                <strong>{t('models.probeNoteStrong1')}</strong>
                {t('models.probeNoteMid')}
                <strong>{t('models.probeNoteStrong2')}</strong>
                {t('models.probeNoteMid2')}
                <strong>{t('models.probeNoteStrong3')}</strong>
                {t('models.probeNoteTail')}
              </p>
            </div>

            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('models.multimodal')}</span>
                <Switch
                  checked={embeddingMultimodal}
                  aria-label={t('models.multimodalAria')}
                  onChange={setEmbeddingMultimodal}
                />
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('models.multimodalNotePrefix')}
                <code>doubao-embedding-vision</code>
                {t('models.multimodalNoteMid1')}
                <code>POST /embeddings/multimodal</code>
                {t('models.multimodalNoteMid2')}
                <code>input</code>
                {t('models.multimodalNoteMid3')}
                <code>{'[{type:"text",text}]'}</code>
                {t('models.multimodalNoteMid4')}
                <strong>{t('models.multimodalNoteStrong')}</strong>
                {t('models.multimodalNoteTail')}
              </p>
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="block-label">{t('models.maxContextLabel')}</p>
              <InputNumber
                value={maxContext}
                min={MAX_CONTEXT_MIN}
                max={MAX_CONTEXT_MAX}
                style={{ width: '100%' }}
                aria-label={t('models.maxContextAria')}
                placeholder={t('models.maxContextPlaceholder')}
                onChange={(value) => setMaxContext(value === null ? null : Number(value))}
              />
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('models.maxContextNote')}
              </p>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{t('models.supportsVision')}</span>
              <Switch checked={supportsVision} aria-label={t('models.supportsVisionAria')} onChange={setSupportsVision} />
            </div>

            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('models.supportsReasoning')}</span>
                <Switch
                  checked={supportsReasoning}
                  aria-label={t('models.supportsReasoningAria')}
                  onChange={setSupportsReasoning}
                />
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('models.reasoningNotePrefix')}
                <code>reasoning_effort</code>
                {t('models.reasoningNoteMid1')}
                <code>reasoning</code>
                {t('models.reasoningNoteMid2')}
                <code>thinking</code>
                {t('models.reasoningNoteMid3')}
                <strong>{t('models.reasoningNoteStrong')}</strong>
                {t('models.reasoningNoteTail')}
              </p>
            </div>

            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('models.connectTest')}</span>
                <Button onClick={runChatProbe} loading={probeChat.isPending} disabled={!canProbe}>
                  {t('models.test')}
                </Button>
              </div>
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('models.testNotePrefix')}
                <strong>{t('models.testNoteStrong1')}</strong>
                {t('models.testNoteMid1')}
                <code>max_tokens:1</code>
                {t('models.testNoteMid2')}
                <code>baseUrl</code>
                {t('models.testNoteMid3')}
                <strong>{t('models.testNoteStrong2')}</strong>
                {t('models.testNoteTail')}
              </p>
            </div>
          </>
        )}

        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="block-label" style={{ marginBottom: 0 }}>
              {t('models.enableLabel')}
            </p>
            <Switch checked={enabled} aria-label={t('models.enableAria')} onChange={setEnabled} />
          </div>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('models.enableNote')}
          </p>
        </div>

        {contextError !== null && <Alert type="warning" showIcon message={contextError} />}

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
