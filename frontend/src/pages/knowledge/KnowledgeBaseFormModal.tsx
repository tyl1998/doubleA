/**
 * 知识库的创建 / 编辑弹窗（P0-1-35）
 *
 * 依据：`docs/03` §七「创建/编辑形态」——**字段 ≤6 的实体用弹窗**（KB、MCP server、用户、
 *      模型；Agent 走独立页），且"**同一实体创建与编辑同形态**"；§4.3（详情页顶部要有
 *      "名称/描述/检索配置编辑"）；`design/knowledge.html` 的字段与提示口径。
 *
 * 两种形态共用一个组件（同一个实体不该有两套字段布局）：`kb === null` 是创建、否则是编辑。
 * 差异只有三处，判据都在 {@link knowledgeModel} 里：
 *   ① **创建时 `chunkSize` / `chunkOverlap` 允许留空** ⇒ 不带这两个键，服务端用环境默认值
 *      快照（`shared` 的 `createKnowledgeBaseBodySchema` 注释）。**刻意不预填数字**：
 *      那两个默认值来自部署环境，前端读不到，预填等于拿猜测覆盖部署配置。
 *      编辑时值已知（就是当前值），所以是必填数字。
 *   ② 创建走 `POST`（字段一次给全），编辑走 `PATCH`（**只发真的变了的字段** + 三态）。
 *   ③ 编辑时若一个字段都没改 ⇒ **不发请求**（`buildKnowledgeUpdateBody` 返回 `null`），
 *      只提示一句 —— 少一次写，也少掉一次"保存成功其实什么都没改"的误导。
 *
 * `retrievalConfig` **不在这里**：它有 7 个字段（mode/topK/score/rrfK/splitStrategy/两个权重），
 * 与本弹窗的 4 个字段是两件事（一个答"这个库是什么"，一个答"它怎么检索"）。它单独一个弹窗
 * （{@link KnowledgeConfigModal}），入口在详情页的「检索配置」卡上。
 *
 * ⚠️ 表单的标签用 `<p className="block-label">` 而不是 `<label htmlFor>`：`styles/app.css`
 * 里**没有** `.field__label` 这类原型类名（`06` P0-1-30 定案："AntD 已有的样式不重写，
 * 自写 CSS 只放 AntD 表达不了的结构"）—— 照原型类名写会得到一个**完全没有样式**的 div。
 * 可访问性靠 `aria-label`（与 P0-1-31 的编辑页同一写法）。
 */

import { Alert, Input, InputNumber, Modal, Radio, Select } from 'antd'
import {
  ASSET_VISIBILITIES,
  ASSET_VISIBILITY_KEY,
  translate,
  type AssetVisibility,
  type KnowledgeBaseItem,
} from '@doubulea/shared'
import { useEffect, useMemo, useState } from 'react'

import { describeError } from '../../api/client.js'
import {
  useCreateKnowledgeBase,
  useRebuildKnowledgeBase,
  useUpdateKnowledgeBase,
} from '../../api/knowledgeBases.js'
import { useAvailableChatModels, useAvailableEmbeddingModels } from '../../api/models.js'
import { AudiencePicker } from '../../components/AudiencePicker.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import {
  buildCreateBody,
  buildKnowledgeUpdateBody,
  editValuesOf,
  isEmbeddingModelChanged,
  validateChunking,
  type KnowledgeCreateFormValues,
  type KnowledgeEditFormValues,
} from './knowledgeModel.js'

export interface KnowledgeBaseFormModalProps {
  /** `null` = 创建；非 `null` = 编辑这个库 */
  kb: KnowledgeBaseItem | null
  open: boolean
  onClose: () => void
  /** 创建成功后的去处（列表页用它把用户带到详情页：刚建完最想看的就是"传个文档"） */
  onCreated?: (created: KnowledgeBaseItem) => void
}

export function KnowledgeBaseFormModal({ kb, open, onClose, onCreated }: KnowledgeBaseFormModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const create = useCreateKnowledgeBase()
  const update = useUpdateKnowledgeBase()
  // 换模型后自动触发整库重建（`kb` 为 null 时是创建形态，永不调用它）
  const rebuild = useRebuildKnowledgeBase(kb?.id ?? '')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [embeddingModelId, setEmbeddingModelId] = useState('')
  const [captionModelId, setCaptionModelId] = useState('')
  const [chunkSize, setChunkSize] = useState<number | null>(null)
  const [chunkOverlap, setChunkOverlap] = useState<number | null>(null)
  const [visibility, setVisibility] = useState<AssetVisibility>('PRIVATE')
  const [audience, setAudience] = useState<{ userIds: string[]; groupIds: string[] }>({
    userIds: [],
    groupIds: [],
  })
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = kb !== null

  // 建库要选一个 embedding 模型（模型池 `type=EMBEDDING`）；数据源与后端校验同一套（启用中）
  const embeddingModels = useAvailableEmbeddingModels()
  const embeddingOptions = useMemo(
    () =>
      (embeddingModels.data?.items ?? []).map((model) => ({
        value: model.id,
        label: `${model.label}（${model.providerName} / ${model.modelName}）`,
      })),
    [embeddingModels.data],
  )

  // 图片描述模型（P1-11，可选）：从对话模型里**只留支持视觉**的（后端也会再校验一次）
  const chatModels = useAvailableChatModels()
  const captionOptions = useMemo(
    () =>
      (chatModels.data?.items ?? [])
        .filter((model) => model.supportsVision)
        .map((model) => ({
          value: model.id,
          label: `${model.label}（${model.providerName} / ${model.modelName}）`,
        })),
    [chatModels.data],
  )

  // 每次打开都按目标对象重置 —— 否则编辑 A 之后打开"创建"，表单里还留着 A 的内容
  useEffect(() => {
    if (!open) return
    if (kb === null) {
      setName('')
      setDescription('')
      setEmbeddingModelId('')
      setCaptionModelId('')
      setChunkSize(null)
      setChunkOverlap(null)
      setVisibility('PRIVATE')
      setAudience({ userIds: [], groupIds: [] })
    } else {
      const values = editValuesOf(kb)
      setName(values.name)
      setDescription(values.description)
      setEmbeddingModelId(values.embeddingModelId)
      setCaptionModelId(values.captionModelId)
      setChunkSize(values.chunkSize)
      setChunkOverlap(values.chunkOverlap)
      setVisibility(values.visibility)
      setAudience(values.audience)
    }
    setErrorText(null)
  }, [open, kb])

  const submitting = create.isPending || update.isPending

  /** 两端共用的"能不能提交"：名字必填；两个分块参数**都填了**才判跨字段（见文件头 ①） */
  const chunkingError =
    chunkSize !== null && chunkOverlap !== null ? validateChunking(chunkSize, chunkOverlap, locale) : null
  /** 「指定用户」至少要有一个受众主体（与后端同一条不变量，前端先拦一次给出即时的按钮禁用） */
  const audienceMissing =
    visibility === 'SHARED' && audience.userIds.length === 0 && audience.groupIds.length === 0
  const canSubmit =
    name.trim() !== '' &&
    (editing || embeddingModelId !== '') &&
    (editing || chunkingError === null) &&
    !audienceMissing &&
    !submitting

  /**
   * 该库此刻是否处于"需重建"状态（P1-5，重建的**唯一触发点**在这里）：
   * · 本次在表单里换了模型（`isEmbeddingModelChanged`）；或
   * · 模型池里那一行被改名/停用（`kb.embeddingModelChanged === true`，快照与当前模型不一致）。
   *
   * 后一种情形没有"换个模型再换回来"之外的入口 —— 所以**保存动作**也承担触发重建：只要该库需重建，
   * 点「保存」就会重建（没有独立按钮，见 `KnowledgeDetailPage`）。
   */
  const needsRebuild =
    kb !== null && (isEmbeddingModelChanged(kb, embeddingModelId) || kb.embeddingModelChanged === true)

  /** 触发整库重建；无文档时无事可做，如实说明（后端也会 409） */
  const triggerRebuild = (documentCount: number): void => {
    if (documentCount === 0) {
      feedback.ok(t('kbForm.rebuildNoDocs'))
      return
    }
    rebuild.mutate(undefined, {
      onSuccess: (result) =>
        result.failed > 0
          ? feedback.note(t('kbForm.rebuildSubmitted', { enqueued: result.enqueued, failed: result.failed }))
          : feedback.ok(t('kbForm.rebuildStarted', { enqueued: result.enqueued })),
      // 重建没提交成功也不能说"保存失败"——模型/配置已经存好了，只是重建没排上队
      onError: (error) => feedback.fail(error, t('kbForm.rebuildFailed')),
    })
  }

  const submit = (): void => {
    setErrorText(null)

    if (kb === null) {
      const values: KnowledgeCreateFormValues = {
        name,
        description,
        embeddingModelId,
        captionModelId,
        chunkSize,
        chunkOverlap,
        visibility,
        audience,
      }
      if (chunkingError !== null) {
        setErrorText(chunkingError)
        return
      }
      create.mutate(buildCreateBody(values), {
        onSuccess: (created) => {
          feedback.ok(t('kbForm.created', { name: created.name }))
          onClose()
          onCreated?.(created)
        },
        // 失败停留弹窗：用户需要看到原因（最典型的是所选 embedding 模型不可用 / 探测维度失败、
        // 或该模型已被停用）。建库要探测维度，失败就不能建 —— 这句话必须让人看见
        onError: (error) => setErrorText(describeError(error).message),
      })
      return
    }

    const values: KnowledgeEditFormValues = {
      name,
      description,
      embeddingModelId,
      captionModelId,
      chunkSize: chunkSize ?? kb.chunkSize,
      chunkOverlap: chunkOverlap ?? kb.chunkOverlap,
      visibility,
      audience,
    }
    const body = buildKnowledgeUpdateBody(kb, values)
    if (body === null) {
      onClose()
      // 没有字段要改、但该库仍需重建（模型池改名等）⇒ 保存动作直接触发重建
      if (needsRebuild) triggerRebuild(kb.documentCount)
      else feedback.note(t('kbForm.noChanges'))
      return
    }
    update.mutate(
      { id: kb.id, body },
      {
        onSuccess: (saved) => {
          onClose()
          // 该库需重建（换了模型 / 模型池改名）⇒ 保存后立刻触发重建，否则向量检索实际停用。
          if (needsRebuild) triggerRebuild(saved.documentCount)
          else feedback.ok(t('kbForm.saved', { name: saved.name }))
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  return (
    <Modal
      open={open}
      title={editing ? t('kbForm.titleEdit', { name: kb.name }) : t('kbForm.titleCreate')}
      okText={editing ? t('common.save') : t('kbForm.okCreate')}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText={t('common.cancel')}
      onOk={submit}
      onCancel={onClose}
      maskClosable={!submitting}
    >
      <div className="stack">
        <div>
          <p className="block-label">{t('kbForm.name')}</p>
          <Input
            value={name}
            maxLength={128}
            aria-label={t('kbForm.nameAria')}
            placeholder={t('kbForm.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('kbForm.nameHelpPrefix')}
            <strong>{t('kbForm.nameHelpStrong')}</strong>
            {t('kbForm.nameHelpSuffix')}
          </p>
        </div>

        <div>
          <p className="block-label">{t('kbForm.description')}</p>
          <Input.TextArea
            value={description}
            rows={3}
            maxLength={2000}
            aria-label={t('kbForm.descriptionAria')}
            placeholder={t('kbForm.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div>
          <p className="block-label">{t('kbForm.visibility')}</p>
          <Radio.Group value={visibility} onChange={(event) => setVisibility(event.target.value as AssetVisibility)}>
            {ASSET_VISIBILITIES.map((value) => (
              <Radio key={value} value={value}>
                {translate(locale, ASSET_VISIBILITY_KEY[value])}
              </Radio>
            ))}
          </Radio.Group>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('kbForm.visibilityHelp')}
          </p>
          {visibility === 'SHARED' && (
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <p className="block-label">{t('kbForm.audience')}</p>
              <AudiencePicker
                userIds={audience.userIds}
                groupIds={audience.groupIds}
                knownUsers={kb?.audience?.users}
                onChange={setAudience}
              />
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {t('kbForm.audienceHelp')}
              </p>
            </div>
          )}
        </div>

        <div>
          <p className="block-label">{t('kbForm.embedding')}</p>
          <Select
            value={embeddingModelId === '' ? undefined : embeddingModelId}
            options={embeddingOptions}
            loading={embeddingModels.isPending}
            placeholder={t('kbForm.embeddingPlaceholder')}
            style={{ width: '100%' }}
            aria-label={t('kbForm.embeddingAria')}
            onChange={setEmbeddingModelId}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {editing ? (
              <>
                {t('kbForm.embeddingHelpEditPrefix')}
                <strong>{t('kbForm.embeddingHelpEditStrong1')}</strong>
                {t('kbForm.embeddingHelpEditMid')}
                <strong>{t('kbForm.embeddingHelpEditStrong2')}</strong>
                {t('kbForm.embeddingHelpEditSuffix')}
              </>
            ) : (
              <>
                {t('kbForm.embeddingHelpCreatePrefix')}
                <strong>{t('kbForm.embeddingHelpCreateStrong1')}</strong>
                {t('kbForm.embeddingHelpCreateMid')}
                <strong>{t('kbForm.embeddingHelpCreateStrong2')}</strong>
                {t('kbForm.embeddingHelpCreateSuffix')}
              </>
            )}
          </p>
          {editing && needsRebuild && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 'var(--sp-2)' }}
              message={t('hint.embeddingModelChangeRebuild')}
            />
          )}
        </div>

        <div>
          <p className="block-label">{t('kbForm.caption')}</p>
          <Select
            value={captionModelId === '' ? undefined : captionModelId}
            options={captionOptions}
            loading={chatModels.isPending}
            allowClear
            placeholder={t('kbForm.captionPlaceholder')}
            style={{ width: '100%' }}
            aria-label={t('kbForm.captionAria')}
            onChange={(value) => setCaptionModelId(value ?? '')}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('kbForm.captionHelp')}
          </p>
        </div>

        <div className="row" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="block-label">{t('kbForm.chunkSize')}</p>
            <InputNumber
              value={chunkSize}
              min={1}
              max={8192}
              style={{ width: '100%' }}
              aria-label={t('kbForm.chunkSizeAria')}
              placeholder={editing ? undefined : t('kbForm.chunkPlaceholderEmpty')}
              onChange={(value) => setChunkSize(value === null ? null : Number(value))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p className="block-label">{t('kbForm.chunkOverlap')}</p>
            <InputNumber
              value={chunkOverlap}
              min={0}
              max={8191}
              style={{ width: '100%' }}
              aria-label={t('kbForm.chunkOverlapAria')}
              placeholder={editing ? undefined : t('kbForm.chunkPlaceholderEmpty')}
              onChange={(value) => setChunkOverlap(value === null ? null : Number(value))}
            />
          </div>
        </div>

        {/* ⚠️ 别把这两个参数的默认值写死在提示里：它们来自 `infra/.env` 的
            `CHUNK_SIZE_DEFAULT` / `CHUNK_OVERLAP_DEFAULT`，前端**读不到**。
            写一个具体数字会变成一份会与部署配置分叉的说明。（JSX 也不认 Markdown，
            要加粗得用 `<strong>`，见 P0-1-31 的落地要点 4。） */}
        <p className="ratio">
          {editing ? (
            <>
              {t('kbForm.chunkHelpEditPrefix')}
              <strong>{t('kbForm.chunkHelpEditStrong')}</strong>
              {t('kbForm.chunkHelpEditSuffix')}
            </>
          ) : (
            <>
              {t('kbForm.chunkHelpCreatePrefix')}
              <strong>{t('kbForm.chunkHelpCreateStrong')}</strong>
              {t('kbForm.chunkHelpCreateSuffix')}
            </>
          )}
        </p>

        {chunkingError !== null && <Alert type="warning" showIcon message={chunkingError} />}
        {errorText !== null && (
          <Alert
            type="error"
            showIcon
            message={editing ? t('kbForm.saveFailed') : t('kbForm.createFailed')}
            description={errorText}
          />
        )}
      </div>
    </Modal>
  )
}
