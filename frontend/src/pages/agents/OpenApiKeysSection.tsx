/**
 * 「开放调用 Key」分区（P1-22；`docs/08-开放平台-智能体OpenAPI(APIKey).md` §8）
 *
 * 挂在**我的凭据**页（`/settings/credentials?section=openapi`），**不**挂在智能体编辑页。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么放在"我的凭据"而不是智能体编辑页（2026-10-22 用户定案）
 * ─────────────────────────────────────────────────────────────────────
 * Key 的主语是「**我** × 智能体」。放在编辑页读起来像"这个智能体的 Key" ⇒ 其他受众会以为
 * "给这个智能体开了 Key 就大家都能用"（语义错误）。放在这里，它是**我的**凭据之一：
 *   · 列表 = 我名下的全部 Key（跨智能体），可按智能体过滤；
 *   · **关联哪个智能体**是签发时选的一项（下拉只列"我能看见的"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 它是一份**个人凭据**，所以与 MCP/Provider/Git 同一页、同一套"只显示已配置"的口径
 * ─────────────────────────────────────────────────────────────────────
 * 唯一例外：Key 的明文只出现一次（服务端只存哈希），所以"创建后一次性展示"这条比别的分区更硬
 * —— 见 {@link ApiKeyPlaintextModal} 的"不可 Esc / 不可遮罩关闭"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 状态是**派生**的（`ACTIVE` / `EXPIRED` / `REVOKED`），由服务端算
 * ─────────────────────────────────────────────────────────────────────
 * 前端**不**自己比较 `expiresAt`：判据在 `shared#openApiKeyStatusOf`，服务端回什么就显示什么
 * —— 浏览器时钟与服务器时钟不同时，前端自己算会出现"界面显示有效、请求却 401"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 明文只在创建响应里：关闭弹窗即丢弃，**不落 local state 之外的任何地方**
 * ─────────────────────────────────────────────────────────────────────
 * 复用 `InitialPasswordModal` 的那套"一次性明文"口径（`closable=false` / `maskClosable=false` /
 * `keyboard=false` + 复制按钮）：误点遮罩就把唯一一份明文弄丢，代价与"少点一次"完全不成比例。
 */

import { Alert, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Select, Switch, Table, Tag } from 'antd'
import {
  OPEN_API_KEY_NAME_MAX,
  OPEN_API_MAX_CONCURRENCY_LIMIT,
  OPEN_API_RATE_LIMIT_PER_MIN_LIMIT,
  OPEN_API_SCOPES,
  OPEN_API_SCOPE_KEY,
  OPEN_API_SCOPE_PRESETS,
  createOpenApiKeyBodySchema,
  translate,
  updateOpenApiKeyBodySchema,
  type CreateOpenApiKeyBody,
  type CreateOpenApiKeyResult,
  type MessageKey,
  type OpenApiKeyItem,
  type OpenApiKeyStatus,
  type OpenApiScope,
  type UpdateOpenApiKeyBody,
} from '@doubulea/shared'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { useEffect, useState } from 'react'

import { Link } from 'react-router-dom'

import { AGENTS_PAGE_LIMIT_MAX, useAgents } from '../../api/agents.js'
import { describeError } from '../../api/client.js'
import { useCreateOpenApiKey, useOpenApiKeys, useRevokeOpenApiKey, useUpdateOpenApiKey } from '../../api/openKeys.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { agentEditPath } from '../../app/paths.js'
import { formatUpdatedAt } from './agentModel.js'

/** 状态 → 徽标 key（与 `shared#OPEN_API_KEY_STATUSES` 一一对应）；P1-23：存 key 不存文案 */
const STATUS_LABEL_KEY: Readonly<Record<OpenApiKeyStatus, MessageKey>> = {
  ACTIVE: 'label.openApiStatus.ACTIVE',
  EXPIRED: 'label.openApiStatus.EXPIRED',
  REVOKED: 'label.openApiStatus.REVOKED',
}

const STATUS_CLASS: Readonly<Record<OpenApiKeyStatus, string>> = {
  ACTIVE: 'tag--accent',
  EXPIRED: 'tag--warn',
  REVOKED: 'tag--danger',
}

/** 新建弹窗的表单值（`expiresAt` 是 DatePicker 的 `Dayjs`） */
interface CreateKeyFormValues {
  /** 关联的智能体（Key 的主语是「我 × 这个智能体」—— 所以它**必须**是签发时显式选的） */
  agentId: string | undefined
  name: string
  scopePreset: 'full' | 'readonly' | 'custom'
  scopes: OpenApiScope[]
  expiresAt: Dayjs | null
  maxConcurrency: number | null
  rateLimitPerMin: number | null
  dailyTokenLimit: number | null
  allowAutoApprove: boolean
}

const CREATE_KEY_DEFAULTS: CreateKeyFormValues = {
  agentId: undefined,
  name: '',
  scopePreset: 'full',
  scopes: [...OPEN_API_SCOPE_PRESETS.full],
  expiresAt: null,
  maxConcurrency: null,
  rateLimitPerMin: null,
  dailyTokenLimit: null,
  // X7：新 Key 默认**允许**自动审批（用户拍板），但界面用危险色提示（见弹窗里的 help）
  allowAutoApprove: true,
}

/**
 * 「开放调用 Key」分区的对外契约。
 *
 * `initialAgentId`：从智能体编辑页**跳转过来**时预选那个智能体（"给这个智能体配一把 Key"是一条
 * 常见路径，但**入口仍是凭据页**—— 这样文案与归属都落在"我的"上）。省略 = 全部智能体。
 */
export interface OpenApiKeysSectionProps {
  /** 预选/过滤的智能体（可空：全部） */
  initialAgentId?: string
}

export function OpenApiKeysSection({ initialAgentId }: OpenApiKeysSectionProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  /**
   * 过滤用的智能体（`undefined` = 我名下的全部 Key）。
   * 初值来自 `initialAgentId`，用户可以在页内改 —— 它是一个**视图状态**，不是凭据本身。
   */
  const [filterAgentId, setFilterAgentId] = useState<string | undefined>(initialAgentId)
  const listQuery = useOpenApiKeys(filterAgentId)
  const agentsQuery = useAgents({ limit: AGENTS_PAGE_LIMIT_MAX })
  const [createOpen, setCreateOpen] = useState(false)
  const [created, setCreated] = useState<CreateOpenApiKeyResult | null>(null)
  const [editing, setEditing] = useState<OpenApiKeyItem | null>(null)
  const [revoking, setRevoking] = useState<OpenApiKeyItem | null>(null)

  const items = listQuery.data?.items ?? []
  /** 下拉的数据源：**我能看见的**智能体（服务端列表已按可见性过滤） */
  const agentOptions = (agentsQuery.data?.items ?? []).map((agent) => ({
    value: agent.id,
    label: `${agent.name}${agent.type === 'CHATBOT' ? '' : t('openApi.agentNonChat')}`,
  }))
  /** 过滤下拉：多一个"全部"，并且**必须**把当前过滤值（若已不在列表里）保留为一项，否则会显示裸 uuid */
  const filterOptions = [
    { value: '', label: t('openApi.filterAll') },
    ...agentOptions,
    ...(filterAgentId !== undefined && !agentOptions.some((option) => option.value === filterAgentId)
      ? [{ value: filterAgentId, label: t('openApi.filterInvisible') }]
      : []),
  ]

  const activeCount = items.filter((key) => key.status === 'ACTIVE').length

  return (
    <div className="stack">
      <Alert
        type="info"
        showIcon
        message={t('openApi.infoTitle')}
        description={t('openApi.infoDesc')}
      />

      <div className="row row--wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'center' }}>
          <span className="block-label" style={{ margin: 0 }}>
            {t('openApi.agentFilter')}
          </span>
          <Select
            style={{ minWidth: 240 }}
            value={filterAgentId ?? ''}
            options={filterOptions}
            loading={agentsQuery.isPending}
            onChange={(value: string) => setFilterAgentId(value === '' ? undefined : value)}
          />
          <span className="ratio">
            {listQuery.isPending ? t('openApi.loading') : t('openApi.count', { total: items.length, active: activeCount })}
          </span>
        </div>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          {t('openApi.create')}
        </Button>
      </div>

      {listQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message={t('openApi.loadFailed')}
          description={describeError(listQuery.error).message}
          action={
            <Button
              size="small"
              onClick={() => {
                void listQuery.refetch()
              }}
            >
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <Table<OpenApiKeyItem>
          rowKey="id"
          size="small"
          loading={listQuery.isPending}
          dataSource={items}
          pagination={false}
          locale={{ emptyText: t('openApi.emptyTable') }}
          columns={[
            {
              title: t('openApi.colName'),
              dataIndex: 'name',
              render: (name: string, row) => (
                <span className="stack stack--tight" style={{ gap: 'var(--sp-1)' }}>
                  <span>{name}</span>
                  <span className="ratio num">
                    {row.keyPrefix}…{row.keySuffix}
                  </span>
                </span>
              ),
            },
            {
              title: t('openApi.colAgent'),
              dataIndex: 'agentName',
              render: (agentName: string, row) => (
                <span className="stack stack--tight" style={{ gap: 'var(--sp-1)' }}>
                  {row.agentType === 'CHATBOT' ? (
                    <Link to={agentEditPath(row.agentId)}>{agentName}</Link>
                  ) : (
                    <span>{agentName}</span>
                  )}
                  {row.agentType !== 'CHATBOT' && (
                    <Tag className="tag--warn" title={t('openApi.nonChatTitle')}>
                      {t('openApi.nonChatTag')}
                    </Tag>
                  )}
                </span>
              ),
            },
            {
              title: t('openApi.colScope'),
              dataIndex: 'scopes',
              render: (scopes: OpenApiScope[]) =>
                scopes.length === 0 ? (
                  <Tag className="tag--danger">{t('openApi.noScope')}</Tag>
                ) : (
                  <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                    {scopes.map((scope) => (
                      <Tag key={scope}>{translate(locale, OPEN_API_SCOPE_KEY[scope])}</Tag>
                    ))}
                  </span>
                ),
            },
            {
              title: t('openApi.colStatus'),
              dataIndex: 'status',
              width: 100,
              render: (status: OpenApiKeyStatus) => (
                <Tag className={STATUS_CLASS[status]}>{t(STATUS_LABEL_KEY[status])}</Tag>
              ),
            },
            {
              title: t('openApi.colExpires'),
              dataIndex: 'expiresAt',
              width: 130,
              render: (expiresAt: string | null) =>
                expiresAt === null ? <span className="ratio">{t('openApi.noExpire')}</span> : formatUpdatedAt(expiresAt),
            },
            {
              title: t('openApi.colLastUsed'),
              dataIndex: 'lastUsedAt',
              width: 130,
              render: (lastUsedAt: string | null) =>
                lastUsedAt === null ? <span className="ratio">{t('openApi.never')}</span> : formatUpdatedAt(lastUsedAt),
            },
            {
              title: t('openApi.colLimit'),
              dataIndex: 'id',
              width: 190,
              render: (_id: string, row) => (
                <span className="ratio">
                  {t('openApi.limitConcurrency', { value: row.maxConcurrency ?? t('openApi.limitDefault') })}
                  {' · '}
                  {row.rateLimitPerMin ?? t('openApi.limitDefault')}
                  {t('openApi.limitRpm')}
                  {' · '}
                  {row.dailyTokenLimit === null || row.dailyTokenLimit === 0
                    ? t('openApi.limitDailyUnlimited')
                    : t('openApi.limitDaily', { value: row.dailyTokenLimit })}
                  {row.allowAutoApprove ? t('openApi.allowAutoApprove') : t('openApi.forbidAutoApprove')}
                </span>
              ),
            },
            {
              title: t('openApi.colActions'),
              dataIndex: 'id',
              width: 150,
              render: (_id: string, row) => (
                <span className="row" style={{ gap: 'var(--sp-2)' }}>
                  <Button size="small" disabled={row.status === 'REVOKED'} onClick={() => setEditing(row)}>
                    {t('common.edit')}
                  </Button>
                  <Button size="small" danger disabled={row.status === 'REVOKED'} onClick={() => setRevoking(row)}>
                    {t('openApi.revoke')}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}

      <span className="ratio">
        {t('openApi.footerPrefix')}
        <strong>{t('openApi.footerStrong1')}</strong>
        {t('openApi.footerMid')}
        <strong>{t('openApi.footerStrong2')}</strong>
        {t('openApi.footerTail')}
        <strong>{t('openApi.footerStrong3')}</strong>
        {t('openApi.footerEnd')}
      </span>

      <CreateKeyModal
        open={createOpen}
        initialAgentId={filterAgentId}
        agentOptions={agentOptions}
        agentsLoading={agentsQuery.isPending}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false)
          setCreated(result)
        }}
      />

      <ApiKeyPlaintextModal result={created} onClose={() => setCreated(null)} />

      <EditKeyModal
        keyItem={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          feedback.ok(t('openApi.editSaved'))
        }}
      />

      <RevokeKeyModal
        keyItem={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null)
          feedback.ok(t('openApi.revokedOk'))
        }}
      />
    </div>
  )
}

// ═════════════════════════════ 新建弹窗 ═════════════════════════════

function CreateKeyModal({
  open,
  initialAgentId,
  agentOptions,
  agentsLoading,
  onClose,
  onCreated,
}: {
  open: boolean
  /** 从分区过滤/跳转带来的预选智能体（可空：让用户在弹窗里选） */
  initialAgentId: string | undefined
  agentOptions: { value: string; label: string }[]
  agentsLoading: boolean
  onClose: () => void
  onCreated: (result: CreateOpenApiKeyResult) => void
}) {
  const { t, locale } = useT()
  const createKey = useCreateOpenApiKey()
  const [form] = Form.useForm<CreateKeyFormValues>()
  const [errorText, setErrorText] = useState<string | null>(null)
  const [scopePreset, setScopePreset] = useState<CreateKeyFormValues['scopePreset']>('full')

  const close = () => {
    form.resetFields()
    setScopePreset('full')
    setErrorText(null)
    onClose()
  }

  // 每次打开都按"当前分区过滤的智能体"预选：从某个智能体的上下文过来时少点一次下拉
  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ ...CREATE_KEY_DEFAULTS, agentId: initialAgentId })
  }, [open, initialAgentId, form])

  const submit = (raw: CreateKeyFormValues) => {
    setErrorText(null)
    // 与后端**同一份** schema（`shared`）：上限/必填/ISO 时间都在一处，前端先过一遍只是为了
    // 少一次必然失败的往返；真正的判据仍在服务端。
    const body = toCreateBody(raw)
    const parsed = createOpenApiKeyBodySchema.safeParse(body)
    if (!parsed.success) {
      form.setFields(
        parsed.error.issues.map((issue) => ({
          name: (issue.path[0] ?? 'name') as keyof CreateKeyFormValues,
          errors: [issue.message],
        })),
      )
      return
    }
    createKey.mutate(parsed.data, {
      onSuccess: (result) => {
        form.resetFields()
        setScopePreset('full')
        onCreated(result)
      },
      onError: (error) => setErrorText(describeError(error).message),
    })
  }

  return (
    <Modal
      open={open}
      title={t('openApi.createTitle')}
      okText={t('openApi.issue')}
      cancelText={t('common.cancel')}
      confirmLoading={createKey.isPending}
      onOk={() => {
        void form.submit()
      }}
      onCancel={close}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={CREATE_KEY_DEFAULTS}
        onFinish={submit}
        onValuesChange={(changed: Partial<CreateKeyFormValues>) => {
          if (changed.scopes !== undefined) {
            // 手改作用域 ⇒ 预设切到"自定义"（否则会出现"预设=只读、实际选了 chat"的矛盾展示）
            const same = sameScopeSet(changed.scopes, [...OPEN_API_SCOPE_PRESETS.readonly])
            setScopePreset(same ? 'readonly' : 'custom')
          }
        }}
      >
        <div className="stack stack--tight">
          {errorText !== null && <Alert type="error" showIcon message={t('openApi.issueFailed')} description={errorText} />}

          <Form.Item
            name="agentId"
            label={t('openApi.agentFilter')}
            rules={[{ required: true, message: t('openApi.agentRequired') }]}
            extra={t('openApi.agentExtra')}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={t('openApi.agentPlaceholder')}
              loading={agentsLoading}
              options={agentOptions}
              notFoundContent={agentsLoading ? t('openApi.loading') : t('openApi.agentEmpty')}
            />
          </Form.Item>

          <Form.Item
            name="name"
            label={t('openApi.colName')}
            rules={[{ required: true, message: t('openApi.nameRequired') }]}
            extra={t('openApi.nameExtra', { max: OPEN_API_KEY_NAME_MAX })}
          >
            <Input placeholder={t('openApi.namePlaceholder')} />
          </Form.Item>

          <Form.Item label={t('openApi.scope')} extra={t('openApi.scopeExtra')}>
            <Select
              value={scopePreset}
              options={[
                { value: 'full', label: t('openApi.scopeFull') },
                { value: 'readonly', label: t('openApi.scopeReadonly') },
                { value: 'custom', label: t('openApi.scopeCustom') },
              ]}
              onChange={(value: CreateKeyFormValues['scopePreset']) => {
                setScopePreset(value)
                if (value === 'full') form.setFieldValue('scopes', [...OPEN_API_SCOPE_PRESETS.full])
                if (value === 'readonly') form.setFieldValue('scopes', [...OPEN_API_SCOPE_PRESETS.readonly])
              }}
            />
          </Form.Item>

          <Form.Item
            name="scopes"
            label={t('openApi.scopeSpecific')}
            rules={[{ required: true, message: t('openApi.scopeRequired') }]}
          >
            <Checkbox.Group
              options={OPEN_API_SCOPES.map((scope) => ({ value: scope, label: translate(locale, OPEN_API_SCOPE_KEY[scope]) }))}
            />
          </Form.Item>

          <Form.Item
            name="expiresAt"
            label={t('openApi.expires')}
            extra={t('openApi.expiresExtra')}
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder={t('openApi.noExpirePlaceholder')} />
          </Form.Item>

          <div className="row row--wrap" style={{ gap: 'var(--sp-4)' }}>
            <Form.Item
              name="maxConcurrency"
              label={t('openApi.maxConcurrency')}
              extra={t('openApi.maxConcurrencyExtra')}
              rules={[{ type: 'number', min: 1, max: OPEN_API_MAX_CONCURRENCY_LIMIT, message: `1–${OPEN_API_MAX_CONCURRENCY_LIMIT}` }]}
            >
              <InputNumber min={1} max={OPEN_API_MAX_CONCURRENCY_LIMIT} placeholder={t('openApi.defaultPlaceholder')} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item
              name="rateLimitPerMin"
              label={t('openApi.rateLimit')}
              extra={t('openApi.rateLimitExtra')}
              rules={[
                {
                  type: 'number',
                  min: 1,
                  max: OPEN_API_RATE_LIMIT_PER_MIN_LIMIT,
                  message: `1–${OPEN_API_RATE_LIMIT_PER_MIN_LIMIT}`,
                },
              ]}
            >
              <InputNumber
                min={1}
                max={OPEN_API_RATE_LIMIT_PER_MIN_LIMIT}
                placeholder={t('openApi.defaultPlaceholder')}
                style={{ width: 160 }}
              />
            </Form.Item>
            <Form.Item name="dailyTokenLimit" label={t('openApi.dailyToken')} extra={t('openApi.dailyTokenExtra')}>
              <InputNumber min={0} placeholder={t('openApi.unlimitedPlaceholder')} style={{ width: 140 }} />
            </Form.Item>
          </div>

          <Form.Item
            name="allowAutoApprove"
            label={t('openApi.allowAutoApproveLabel')}
            valuePropName="checked"
            extra={t('openApi.allowAutoApproveExtra')}
          >
            <Switch checkedChildren={t('openApi.switchAllow')} unCheckedChildren={t('openApi.switchForbid')} />
          </Form.Item>

          <Alert
            type="warning"
            showIcon
            message={t('openApi.autoApproveWarnTitle')}
            description={t('openApi.autoApproveWarnDesc')}
          />
        </div>
      </Form>
    </Modal>
  )
}

/** 表单值 → 请求体（`Dayjs` → ISO；空字符串/null 的数值项交给 `shared` 的 schema 判） */
function toCreateBody(values: CreateKeyFormValues): CreateOpenApiKeyBody {
  return {
    // `undefined` 由 `shared` 的 schema 报"请选择要关联的智能体"（不在前端另写一句文案）
    agentId: values.agentId as string,
    name: values.name.trim(),
    scopes: values.scopes,
    expiresAt: values.expiresAt === null || values.expiresAt === undefined ? null : values.expiresAt.toISOString(),
    maxConcurrency: values.maxConcurrency ?? null,
    rateLimitPerMin: values.rateLimitPerMin ?? null,
    dailyTokenLimit: values.dailyTokenLimit ?? null,
    allowAutoApprove: values.allowAutoApprove,
  }
}

/** 两个作用域集合是否相同（顺序无关） */
function sameScopeSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((scope) => set.has(scope))
}

/** 现有作用域 → 预设名（编辑弹窗回填用；两边不齐就是"自定义"） */
function scopePresetOf(scopes: readonly OpenApiScope[]): EditKeyFormValues['scopePreset'] {
  if (sameScopeSet(scopes, [...OPEN_API_SCOPE_PRESETS.full])) return 'full'
  if (sameScopeSet(scopes, [...OPEN_API_SCOPE_PRESETS.readonly])) return 'readonly'
  return 'custom'
}

// ═════════════════════════════ 编辑弹窗 ═════════════════════════════

/**
 * 编辑元数据（2026-10-22 追加）。与新建弹窗共用同一批字段，差异只有三处：
 *   · **关联智能体只读**（`agentId` 是 Key 身份的一半 —— 换智能体 = 换会话池，只能吊销重签）；
 *   · **放宽作用域要二次确认**（收紧随便，放宽是"立即扩大这把 Key 的能力"，必须显式勾一次）；
 *   · 没有"签发"语义：保存 = 全量表单提交（服务端合并语义下等价 —— 表单里看到的即生效的）。
 * 已过期的 Key 也能编辑：把过期时间改到未来即重新启用（这是编辑的主要用途之一）。
 */
interface EditKeyFormValues {
  name: string
  scopePreset: 'full' | 'readonly' | 'custom'
  scopes: OpenApiScope[]
  /** 仅在放宽作用域时出现的确认勾选（不进请求体） */
  confirmWiden: boolean
  expiresAt: Dayjs | null
  maxConcurrency: number | null
  rateLimitPerMin: number | null
  dailyTokenLimit: number | null
  allowAutoApprove: boolean
}

function toUpdateBody(values: EditKeyFormValues): UpdateOpenApiKeyBody {
  return {
    name: values.name.trim(),
    scopes: values.scopes,
    expiresAt: values.expiresAt === null || values.expiresAt === undefined ? null : values.expiresAt.toISOString(),
    maxConcurrency: values.maxConcurrency ?? null,
    rateLimitPerMin: values.rateLimitPerMin ?? null,
    dailyTokenLimit: values.dailyTokenLimit ?? null,
    allowAutoApprove: values.allowAutoApprove,
  }
}

function EditKeyModal({
  keyItem,
  onClose,
  onSaved,
}: {
  keyItem: OpenApiKeyItem | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t, locale } = useT()
  const updateKey = useUpdateOpenApiKey()
  const [form] = Form.useForm<EditKeyFormValues>()
  const [errorText, setErrorText] = useState<string | null>(null)
  const [scopePreset, setScopePreset] = useState<EditKeyFormValues['scopePreset']>('full')
  // 放宽 = 新选的作用域里有原来没有的。收紧（或不变）不需要确认 —— 收窄风险只会变小
  const watchedScopes: OpenApiScope[] | undefined = Form.useWatch('scopes', form)
  const widened =
    keyItem !== null && watchedScopes?.some((scope) => !keyItem.scopes.includes(scope)) === true

  const close = () => {
    form.resetFields()
    setErrorText(null)
    onClose()
  }

  useEffect(() => {
    if (keyItem === null) return
    setScopePreset(scopePresetOf(keyItem.scopes))
    form.setFieldsValue({
      name: keyItem.name,
      scopes: [...keyItem.scopes],
      confirmWiden: false,
      expiresAt: keyItem.expiresAt === null ? null : dayjs(keyItem.expiresAt),
      maxConcurrency: keyItem.maxConcurrency,
      rateLimitPerMin: keyItem.rateLimitPerMin,
      dailyTokenLimit: keyItem.dailyTokenLimit,
      allowAutoApprove: keyItem.allowAutoApprove,
    })
  }, [keyItem, form])

  if (keyItem === null) return null

  const submit = (raw: EditKeyFormValues) => {
    setErrorText(null)
    const body = toUpdateBody(raw)
    const parsed = updateOpenApiKeyBodySchema.safeParse(body)
    if (!parsed.success) {
      form.setFields(
        parsed.error.issues.map((issue) => ({
          name: (issue.path[0] ?? 'name') as keyof EditKeyFormValues,
          errors: [issue.message],
        })),
      )
      return
    }
    updateKey.mutate(
      { keyId: keyItem.id, body: parsed.data },
      {
        onSuccess: () => {
          form.resetFields()
          onSaved()
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  return (
    <Modal
      open
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          {t('openApi.editTitle', { name: keyItem.name })}
          <span className="ratio num">
            {keyItem.keyPrefix}…{keyItem.keySuffix}
          </span>
        </span>
      }
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={updateKey.isPending}
      onOk={() => {
        void form.submit()
      }}
      onCancel={close}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        onValuesChange={(changed: Partial<EditKeyFormValues>) => {
          if (changed.scopes !== undefined) {
            const same = sameScopeSet(changed.scopes, [...OPEN_API_SCOPE_PRESETS.readonly])
            setScopePreset(same ? 'readonly' : sameScopeSet(changed.scopes, [...OPEN_API_SCOPE_PRESETS.full]) ? 'full' : 'custom')
            form.setFieldValue('confirmWiden', false)
          }
        }}
      >
        <div className="stack stack--tight">
          {errorText !== null && <Alert type="error" showIcon message={t('openApi.saveFailed')} description={errorText} />}

          {keyItem.status === 'EXPIRED' && (
            <Alert
              type="info"
              showIcon
              message={t('openApi.expiredTitle')}
              description={t('openApi.expiredDesc')}
            />
          )}

          <Form.Item label={t('openApi.agentFilter')} extra={t('openApi.agentLockedExtra')}>
            <Input value={keyItem.agentName} disabled />
          </Form.Item>

          <Form.Item
            name="name"
            label={t('openApi.colName')}
            rules={[{ required: true, message: t('openApi.nameRequired') }]}
            extra={t('openApi.nameExtra', { max: OPEN_API_KEY_NAME_MAX })}
          >
            <Input placeholder={t('openApi.namePlaceholder')} />
          </Form.Item>

          <Form.Item label={t('openApi.scope')} extra={t('openApi.editScopeExtra')}>
            <Select
              value={scopePreset}
              options={[
                { value: 'full', label: t('openApi.scopeFull') },
                { value: 'readonly', label: t('openApi.scopeReadonly') },
                { value: 'custom', label: t('openApi.scopeCustom') },
              ]}
              onChange={(value: EditKeyFormValues['scopePreset']) => {
                setScopePreset(value)
                if (value === 'full') form.setFieldValue('scopes', [...OPEN_API_SCOPE_PRESETS.full])
                if (value === 'readonly') form.setFieldValue('scopes', [...OPEN_API_SCOPE_PRESETS.readonly])
              }}
            />
          </Form.Item>

          <Form.Item
            name="scopes"
            label={t('openApi.scopeSpecific')}
            rules={[{ required: true, message: t('openApi.scopeRequired') }]}
          >
            <Checkbox.Group
              options={OPEN_API_SCOPES.map((scope) => ({ value: scope, label: translate(locale, OPEN_API_SCOPE_KEY[scope]) }))}
            />
          </Form.Item>

          {widened && (
            <>
              <Alert
                type="warning"
                showIcon
                message={t('openApi.widenTitle')}
                description={t('openApi.widenDesc')}
              />
              <Form.Item
                name="confirmWiden"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, value: boolean | undefined) =>
                      value === true ? Promise.resolve() : Promise.reject(new Error(t('openApi.widenConfirmRequired'))),
                  },
                ]}
              >
                <Checkbox>{t('openApi.widenConfirm')}</Checkbox>
              </Form.Item>
            </>
          )}

          <Form.Item
            name="expiresAt"
            label={t('openApi.expires')}
            extra={t('openApi.editExpiresExtra')}
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder={t('openApi.noExpirePlaceholder')} />
          </Form.Item>

          <div className="row row--wrap" style={{ gap: 'var(--sp-4)' }}>
            <Form.Item
              name="maxConcurrency"
              label={t('openApi.maxConcurrency')}
              extra={t('openApi.maxConcurrencyExtra')}
              rules={[{ type: 'number', min: 1, max: OPEN_API_MAX_CONCURRENCY_LIMIT, message: `1–${OPEN_API_MAX_CONCURRENCY_LIMIT}` }]}
            >
              <InputNumber min={1} max={OPEN_API_MAX_CONCURRENCY_LIMIT} placeholder={t('openApi.defaultPlaceholder')} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item
              name="rateLimitPerMin"
              label={t('openApi.rateLimit')}
              extra={t('openApi.rateLimitExtra')}
              rules={[
                {
                  type: 'number',
                  min: 1,
                  max: OPEN_API_RATE_LIMIT_PER_MIN_LIMIT,
                  message: `1–${OPEN_API_RATE_LIMIT_PER_MIN_LIMIT}`,
                },
              ]}
            >
              <InputNumber
                min={1}
                max={OPEN_API_RATE_LIMIT_PER_MIN_LIMIT}
                placeholder={t('openApi.defaultPlaceholder')}
                style={{ width: 160 }}
              />
            </Form.Item>
            <Form.Item name="dailyTokenLimit" label={t('openApi.dailyToken')} extra={t('openApi.dailyTokenExtra')}>
              <InputNumber min={0} placeholder={t('openApi.unlimitedPlaceholder')} style={{ width: 140 }} />
            </Form.Item>
          </div>

          <Form.Item
            name="allowAutoApprove"
            label={t('openApi.allowAutoApproveLabel')}
            valuePropName="checked"
            extra={t('openApi.allowAutoApproveExtra')}
          >
            <Switch checkedChildren={t('openApi.switchAllow')} unCheckedChildren={t('openApi.switchForbid')} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  )
}

// ═════════════════════════════ 明文弹窗 ═════════════════════════════

/**
 * 一次性明文（详见文件头 ②）。
 *
 * 与 `InitialPasswordModal` 的差别只有一处：这里**没有**"用户名"第二行 —— Key 的身份信息
 * （前缀/尾号）已经在列表里，弹窗里唯一要紧的就是那把明文。
 */
function ApiKeyPlaintextModal({
  result,
  onClose,
}: {
  result: CreateOpenApiKeyResult | null
  onClose: () => void
}) {
  const feedback = useFeedback()
  const { t } = useT()
  const [copied, setCopied] = useState(false)

  if (result === null) return null

  const copy = (): void => {
    void navigator.clipboard
      .writeText(result.plaintext)
      .then(() => {
        setCopied(true)
        feedback.ok(t('openApi.copyOk'))
      })
      .catch(() => {
        feedback.fail(new Error(t('openApi.copyBlocked')), t('openApi.copyFailed'))
      })
  }

  return (
    <Modal
      open
      title={t('openApi.plaintextTitle')}
      // ⚠️ 不给 ×、不响应遮罩与 Esc：这里装着**唯一一份**明文
      closable={false}
      maskClosable={false}
      keyboard={false}
      onCancel={() => {
        setCopied(false)
        onClose()
      }}
      footer={
        <>
          <Button onClick={copy}>{copied ? t('openApi.copyAgain') : t('openApi.copy')}</Button>
          <Button
            type="primary"
            onClick={() => {
              setCopied(false)
              onClose()
            }}
          >
            {t('openApi.savedClose')}
          </Button>
        </>
      }
    >
      <div className="stack stack--tight">
        <Alert
          type="warning"
          showIcon
          message={t('openApi.plaintextWarnTitle')}
          description={t('openApi.plaintextWarnDesc')}
        />
        <p className="block-label">{t('openApi.credentialLabel')}</p>
        <Input.TextArea
          readOnly
          value={result.plaintext}
          autoSize={{ minRows: 2, maxRows: 3 }}
          className="num"
          aria-label="API Key"
        />
        <p className="ratio">
          {t('openApi.usagePrefix')}
          <code>curl -H &quot;Authorization: Bearer &lt;Key&gt;&quot; https://&lt;host&gt;/open/v1/agent</code>
        </p>
      </div>
    </Modal>
  )
}

// ═════════════════════════════ 吊销确认 ═════════════════════════════

function RevokeKeyModal({
  keyItem,
  onClose,
  onRevoked,
}: {
  keyItem: OpenApiKeyItem | null
  onClose: () => void
  onRevoked: () => void
}) {
  const { t } = useT()
  const revoke = useRevokeOpenApiKey()
  const [errorText, setErrorText] = useState<string | null>(null)

  // 换一把 Key 打开时清掉上一次的错误（否则会看到"删除 A 失败的文案"挂在 B 的确认框里）
  const keyId = keyItem?.id
  useEffect(() => {
    setErrorText(null)
  }, [keyId])

  if (keyItem === null) return null

  const confirm = (): void => {
    setErrorText(null)
    revoke.mutate(keyItem.id, {
      onSuccess: onRevoked,
      // 失败不关弹窗：可能网络抖动，或这把 Key 已被别人吊销（那时重新打开列表即可）
      onError: (error) => setErrorText(describeError(error).message),
    })
  }

  return (
    <Modal
      open
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          {t('openApi.revokeTitle', { name: keyItem.name })}
          <Tag className="tag--danger">{t('openApi.revokeTag')}</Tag>
        </span>
      }
      okText={t('openApi.revokeOkText')}
      okButtonProps={{ danger: true, loading: revoke.isPending }}
      cancelText={t('common.cancel')}
      onOk={confirm}
      onCancel={() => {
        setErrorText(null)
        onClose()
      }}
      maskClosable={!revoke.isPending}
    >
      <div className="stack stack--tight">
        {errorText !== null && <Alert type="error" showIcon message={t('openApi.revokeFailed')} description={errorText} />}
        <p>
          {t('openApi.revokeBodyPrefix')}
          <code className="num">{keyItem.keyPrefix}…{keyItem.keySuffix}</code>
          {t('openApi.revokeBodyMid')}
          <strong>{t('openApi.revokeBodyStrong1')}</strong>
          {t('openApi.revokeBodyTail')}
          <strong>{t('openApi.revokeBodyStrong2')}</strong>
          {t('openApi.revokeBodyEnd')}
        </p>
        <p className="ratio">
          {t('openApi.revokeKeepPrefix')}
          <strong>{t('openApi.revokeKeepStrong')}</strong>
          {t('openApi.revokeKeepTail')}
        </p>
        <Alert
          type="info"
          showIcon
          message={t('openApi.revokeOtherTitle')}
          description={t('openApi.revokeOtherDesc')}
        />
      </div>
    </Modal>
  )
}
