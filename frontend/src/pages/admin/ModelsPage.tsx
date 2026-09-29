/**
 * 模型池管理（`/admin/models`，P0-1-36，ADMIN）
 *
 * 依据：`docs/03-前端设计.md` §二（`/admin/models` = 模型池管理，**ADMIN**）、§4.2（模型下拉要
 *      显示上下文长度与是否支持图片）、§七（十条全局交互规范）、`docs/02-后端设计.md` §4.3
 *      （Provider / 模型 / 拉取上游模型 + 五条守卫）、`shared/src/model.ts`（**两套投影**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 一张表还是两张表：本页是**两张**，因为它们是两个资源
 * ─────────────────────────────────────────────────────────────────────
 * Provider（配置：baseUrl + Key + 类型）与模型（它下面的具体型号）是两级资源，各有各的 CRUD。
 * 合成一张表会让"编辑"这一个动作有两种含义。所以上面一张 Provider 表、下面一张模型表，
 * 模型表用「Provider」列 + `rowSpan` 合并相邻同 Provider 的行来表达归属（见 `providerGroupSpans`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 排序只有一个来源：服务端；前端只做**筛选与分组呈现**
 * ─────────────────────────────────────────────────────────────────────
 * 两个列表的排序都是后端定的（`createdAt asc, id asc`，`02` §4.3）。本页：
 *   · **不排一次**（`providerGroupSpans` 需要"同 Provider 的行在屏幕上相邻"，前端再排一次会
 *     让 rowSpan 错位成"合并到别人头上"）；
 *   · **不给这个列开客户端排序**（AntD Table 不写 `sorter` 就不会排）—— 同上；
 *   · 筛选（Provider / 关键字 / 只看停用）只做 `Array.filter`，**不改变相对顺序**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 三处"必须让人看见"的状态（都是本页最容易做成静默的地方）
 * ─────────────────────────────────────────────────────────────────────
 *  · **停用项**：管理页是**唯一**能看见并改回停用项的地方（`GET /api/models/available` 里没有它们）
 *    ⇒ 停用项用状态灯 + 「已停用」两重表达，且提供"只看停用"筛选，避免"它怎么不见了"。
 *  · **Key 的掩码**：`describeProviderKey` 给的是后端解密后生成的掩码；未配置给「未配置」而不是空。
 *  · **引用数**：`agentCount` **含软删的智能体**（`02` §4.3：软删仍占着 `agents.model_id` 外键）
 *    ⇒ 列头写明这一点，否则会出现"显示 0 个却删不掉"的困惑。
 */

import { Alert, Button, Checkbox, Input, Popconfirm, Select, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import {
  MODEL_TYPES,
  MODEL_TYPE_LABELS,
  UPSTREAM_PROTOCOL_LABELS,
  type ModelItem,
  type ModelProviderItem,
  type ModelType,
} from '@doubulea/shared'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  MODEL_POOL_PAGE_LIMIT_MAX,
  useAdminModels,
  useModelProviders,
  useRemoveModel,
} from '../../api/modelPool.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { formatUpdatedAt } from '../../app/format.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH } from '../../app/paths.js'
import { DeleteProviderModal } from './DeleteProviderModal.js'
import { ModelFormModal } from './ModelFormModal.js'
import { ProviderFormModal } from './ProviderFormModal.js'
import { RemoteModelsDrawer } from './RemoteModelsDrawer.js'
import {
  describeProviderKey,
  maxContextText,
  modelDeleteBlockedNotice,
  providerGroupSpans,
  summarizeModels,
} from './adminModel.js'

const TYPE_FILTER_OPTIONS = [
  { value: 'ALL', label: '全部类型' },
  ...MODEL_TYPES.map((type) => ({ value: type, label: MODEL_TYPE_LABELS[type] })),
]

export function ModelsPage() {
  const feedback = useFeedback()
  // ⚠️ 只传 `limit`、**不传 `offset`**（默认 0，一次取满、筛选全在客户端）。
  //    这里曾经写成 `useModelProviders(MODEL_POOL_PAGE_LIMIT_MAX)` —— 在位置参数签名下
  //    那个 100 落进了 `offset`，页面因此把 3 个 Provider / 2 个模型全当成"没有"。
  //    签名已改成对象参数，这类错位现在编译期就会报错（见 `api/modelPool.ts#ListModelPoolParams`）。
  const providersQuery = useModelProviders({ limit: MODEL_POOL_PAGE_LIMIT_MAX })
  const modelsQuery = useAdminModels({ limit: MODEL_POOL_PAGE_LIMIT_MAX })
  const removeModel = useRemoveModel()

  const [creatingProvider, setCreatingProvider] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ModelProviderItem | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<ModelProviderItem | null>(null)
  const [probingProvider, setProbingProvider] = useState<ModelProviderItem | null>(null)

  const [creatingModel, setCreatingModel] = useState(false)
  const [editingModel, setEditingModel] = useState<ModelItem | null>(null)

  const [providerFilter, setProviderFilter] = useState<string>('ALL')
  const [typeFilter, setTypeFilter] = useState<ModelType | 'ALL'>('ALL')
  const [keyword, setKeyword] = useState('')
  const [onlyDisabled, setOnlyDisabled] = useState(false)

  const providers = providersQuery.data?.items ?? []
  const providerTotal = providersQuery.data?.total ?? 0
  const models = modelsQuery.data?.items ?? []
  const modelTotal = modelsQuery.data?.total ?? 0

  const normalizedKeyword = keyword.trim().toLowerCase()
  // ⚠️ 只 filter，不 sort（见文件头 ②）—— 顺序就是服务端给的顺序
  const filteredModels = models.filter((model) => {
    if (providerFilter !== 'ALL' && model.providerId !== providerFilter) return false
    if (typeFilter !== 'ALL' && model.type !== typeFilter) return false
    if (onlyDisabled && model.enabled) return false
    if (normalizedKeyword !== '') {
      const haystack = `${model.label}\n${model.modelName}\n${model.providerName}`.toLowerCase()
      if (!haystack.includes(normalizedKeyword)) return false
    }
    return true
  })

  const spans = providerGroupSpans(filteredModels)
  const summary = summarizeModels(filteredModels)

  const doRemoveModel = (model: ModelItem): void => {
    removeModel.mutate(model.id, {
      onSuccess: (result) => {
        feedback.ok(`已删除模型「${result.modelName}」`)
      },
      onError: (error) => feedback.fail(error, '删除失败'),
    })
  }

  const providerColumns: TableColumnsType<ModelProviderItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_, provider) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{provider.name}</span>
          <span className="kb-cell__sub num">{provider.baseUrl}</span>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 90,
      render: (_, provider) => <Tag>{MODEL_TYPE_LABELS[provider.type]}</Tag>,
    },
    {
      // P0-1-37：协议与类型是**两个维度**（同为对话，可以是兼容/Responses/Anthropic），
      // 所以单独一列，而不是塞进「类型」那个 Tag 里 —— 合在一处就没法按协议扫一眼排查
      title: '上游协议',
      dataIndex: 'protocol',
      width: 160,
      render: (_, provider) => (
        <div className="kb-cell">
          <span>{UPSTREAM_PROTOCOL_LABELS[provider.protocol]}</span>
          {provider.protocol !== 'OPENAI_COMPAT' && (
            <span className="kb-cell__sub">
              {provider.protocol === 'ANTHROPIC_MESSAGES' ? 'x-api-key' : '/responses'}
            </span>
          )}
        </div>
      ),
    },
    {
      title: 'API Key',
      dataIndex: 'apiKeyPreview',
      width: 170,
      render: (_, provider) => (
        <div className="kb-cell">
          <span className="num">{describeProviderKey(provider)}</span>
          {provider.hasKey ? (
            <span className="kb-cell__sub">掩码，仅用于核对</span>
          ) : (
            <span className="kb-cell__sub">该 Provider 下的模型调用会失败</span>
          )}
        </div>
      ),
    },
    {
      title: '模型数',
      dataIndex: 'modelCount',
      width: 90,
      align: 'right',
      render: (_, provider) => <span className="num">{provider.modelCount}</span>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 150,
      render: (_, provider) => (
        <div className="kb-cell">
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <span className={`led led--${provider.enabled ? 'ok' : 'fail'}`} aria-hidden="true" />
            <span>{provider.enabled ? '启用' : '已停用'}</span>
          </span>
          {!provider.enabled && <span className="kb-cell__sub">其下模型不在可选列表里</span>}
        </div>
      ),
    },
    {
      title: '最近更新',
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, provider) => <span className="num">{formatUpdatedAt(provider.updatedAt)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 250,
      align: 'right',
      // 固定右侧（`03` §七 表格规范）。本表列宽之和超过 1000px ⇒ 窄屏必然横向滚动
      fixed: 'right',
      render: (_, provider) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditingProvider(provider)}>
            编辑
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setProbingProvider(provider)}>
            拉取上游模型
          </Button>
          {/* 删除放最后（§七）；Provider 删除是**级联**那一档 ⇒ 走 Modal + 逐字确认 */}
          <Button
            type="link"
            size="small"
            danger
            style={{ padding: 0 }}
            onClick={() => setDeletingProvider(provider)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ]

  const modelColumns: TableColumnsType<ModelItem> = [
    {
      title: 'Provider',
      dataIndex: 'providerName',
      width: 170,
      // ⚠️ 相邻同 Provider 的行合并；**不许**给这一列开客户端排序（见 `providerGroupSpans`）
      onCell: (_, index) => ({ rowSpan: spans[index ?? 0] ?? 1 }),
      render: (_, model) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{model.providerName}</span>
          {!model.providerEnabled && <span className="kb-cell__sub">Provider 已停用</span>}
        </div>
      ),
    },
    {
      title: '模型',
      dataIndex: 'label',
      render: (_, model) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{model.label}</span>
          <span className="kb-cell__sub num">{model.modelName}</span>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 90,
      render: (_, model) => <Tag>{MODEL_TYPE_LABELS[model.type]}</Tag>,
    },
    {
      title: '上下文',
      dataIndex: 'maxContext',
      width: 110,
      align: 'right',
      render: (_, model) => <span className="num">{maxContextText(model.maxContext)}</span>,
    },
    {
      title: '图片',
      dataIndex: 'supportsVision',
      width: 70,
      align: 'center',
      render: (_, model) => <span className="num">{model.supportsVision ? '✓' : '—'}</span>,
    },
    {
      title: '思考',
      dataIndex: 'supportsReasoning',
      width: 70,
      align: 'center',
      render: (_, model) => <span className="num">{model.supportsReasoning ? '✓' : '—'}</span>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 150,
      render: (_, model) => (
        <div className="kb-cell">
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <span className={`led led--${model.enabled ? 'ok' : 'fail'}`} aria-hidden="true" />
            <span>{model.enabled ? '启用' : '已停用'}</span>
          </span>
          {!model.enabled && <span className="kb-cell__sub">不在可选列表里</span>}
        </div>
      ),
    },
    {
      title: (
        // 列头写明"含已删除的智能体"：软删的 Agent 照样占着外键（`02` §4.3），
        // 不写会出现"显示 0 个却删不掉"的困惑
        <Tooltip title="含已被删除（软删）的智能体：它们仍占着这条引用，所以删不掉">
          <span>引用</span>
        </Tooltip>
      ),
      dataIndex: 'agentCount',
      width: 80,
      align: 'right',
      render: (_, model) =>
        model.agentCount === 0 ? <span className="ratio">0</span> : <span className="num">{model.agentCount}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      align: 'right',
      fixed: 'right',
      render: (_, model) => {
        const blocked = modelDeleteBlockedNotice(model)
        return (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditingModel(model)}>
              编辑
            </Button>
            {blocked !== null ? (
              // 被引用时**不禁用整个按钮**而是把 Popconfirm 的确认键标灰 + 说明 + 指路
              //（`agentCount` 与后端守卫同口径 ⇒ 这里说的"删不掉"就是真会拿到的 409）
              <Popconfirm
                title={`删除模型「${model.label}」？`}
                description={
                  <>
                    {blocked}
                    <br />
                    <Link to={HOME_PATH}>去智能体列表改绑 →</Link>
                  </>
                }
                okText="删除"
                okButtonProps={{ danger: true, disabled: true }}
                cancelText="知道了"
              >
                <Button type="link" size="small" danger style={{ padding: 0 }}>
                  删除
                </Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title={`删除模型「${model.label}」？`}
                description="只删除这条模型配置，不影响别的模型；它下面没有级联数据，所以不会连带删任何东西。"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => doRemoveModel(model)}
              >
                <Button
                  type="link"
                  size="small"
                  danger
                  style={{ padding: 0 }}
                  loading={removeModel.isPending && removeModel.variables === model.id}
                >
                  删除
                </Button>
              </Popconfirm>
            )}
          </div>
        )
      },
    },
  ]

  const providerSelectOptions = [
    { value: 'ALL', label: '全部 Provider' },
    ...providers.map((provider) => ({
      value: provider.id,
      label: `${provider.name}${provider.enabled ? '' : '（已停用）'}`,
    })),
  ]

  return (
    <>
      <nav className="crumb" aria-label="面包屑">
        <Link to={HOME_PATH}>工作台</Link>
        <span className="crumb__sep" aria-hidden="true">
          /
        </span>
        <span className="crumb__here">模型池</span>
      </nav>

      <div className="page__head">
        <div>
          <h1>模型池</h1>
          <p className="page__lead">
            先建 <strong>Provider</strong>（baseUrl + API Key + 类型），再在它下面录入模型。只有在
            这里被<strong>启用</strong>的模型才会出现在「新建智能体」的模型下拉里 —— 停用是"先别再选它"，
            不是删除。
          </p>
        </div>
        <div className="page__head-actions">
          <Button onClick={() => setCreatingProvider(true)}>新建 Provider</Button>
          <Button
            type="primary"
            onClick={() => setCreatingModel(true)}
            disabled={providers.length === 0}
            title={providers.length === 0 ? '先建一个 Provider（模型必须挂在它下面）' : '新建模型'}
          >
            新建模型
          </Button>
        </div>
      </div>

      {/* ───────────────────── Provider ───────────────────── */}
      <section className="admin-section">
        <div className="admin-section__head">
          <h2 className="card__title">Provider</h2>
          <span className="ratio">
            共 <span className="num">{providerTotal}</span> 个
            {providerTotal > providers.length && <>（本次取回前 {providers.length} 个，limit 上限 100）</>}
          </span>
        </div>

        {providersQuery.isError ? (
          <ErrorState
            title="Provider 列表加载失败"
            error={providersQuery.error}
            retrying={providersQuery.isFetching}
            onRetry={() => {
              void providersQuery.refetch()
            }}
          />
        ) : providersQuery.isPending ? (
          <TableSkeleton rows={3} />
        ) : providers.length === 0 ? (
          <div className="card">
            <EmptyState
              title="还没有 Provider"
              lead="Provider 是模型的来源：一个 baseUrl、一把 API Key、一个类型（对话或向量）。建完它才能在下面录入模型。"
              action={
                <Button type="primary" onClick={() => setCreatingProvider(true)}>
                  新建 Provider
                </Button>
              }
            />
          </div>
        ) : (
          <div className="card">
            <Table<ModelProviderItem>
              rowKey="id"
              size="middle"
              columns={providerColumns}
              dataSource={providers}
              loading={false}
              pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => `共 ${count} 个 · 每页 20` }}
              scroll={{ x: 1050 }}
            />
          </div>
        )}
      </section>

      {/* ───────────────────── 模型 ───────────────────── */}
      <section>
        <div className="admin-section__head">
          <h2 className="card__title">模型</h2>
          <span className="ratio">
            屏幕上有 <span className="num">{summary.total}</span> 个 · 覆盖{' '}
            <span className="num">{summary.providers}</span> 个 Provider · 停用{' '}
            <span className="num">{summary.disabled}</span> · 支持图片{' '}
            <span className="num">{summary.vision}</span>
            {modelTotal > models.length && <> · 接口共 {modelTotal} 个（limit 上限 100）</>}
          </span>
        </div>

        <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
          <Select
            value={providerFilter}
            options={providerSelectOptions}
            style={{ width: 220 }}
            aria-label="按 Provider 筛选"
            onChange={setProviderFilter}
          />
          <Select
            value={typeFilter}
            options={TYPE_FILTER_OPTIONS}
            style={{ width: 140 }}
            aria-label="按类型筛选"
            onChange={(value: ModelType | 'ALL') => setTypeFilter(value)}
          />
          <Input.Search
            allowClear
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索别名 / 型号名…"
            style={{ width: 240 }}
            aria-label="搜索模型"
          />
          <Checkbox checked={onlyDisabled} onChange={(event) => setOnlyDisabled(event.target.checked)}>
            只看已停用
          </Checkbox>
        </div>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message="停用的模型去哪了"
          description={
            <>
              「可用模型」下拉（建/改智能体时用）只含<strong>已启用</strong>的模型，且要求它的 Provider
              也处于启用状态。所以这里停用一个模型之后，那个下拉里立刻就没有它了。
            </>
          }
        />

        {modelsQuery.isError ? (
          <ErrorState
            title="模型列表加载失败"
            error={modelsQuery.error}
            retrying={modelsQuery.isFetching}
            onRetry={() => {
              void modelsQuery.refetch()
            }}
          />
        ) : modelsQuery.isPending ? (
          <TableSkeleton />
        ) : models.length === 0 ? (
          <div className="card">
            <EmptyState
              title="还没有模型"
              lead={
                providers.length === 0
                  ? '模型必须挂在某个 Provider 下。先在上面的 Provider 区建一个，再回来录模型。'
                  : '可以点某个 Provider 行上的「拉取上游模型」把上游真实的型号名列出来，复制过来手工录入。'
              }
              action={
                <Button type="primary" onClick={() => setCreatingModel(true)} disabled={providers.length === 0}>
                  新建模型
                </Button>
              }
            />
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="card">
            <EmptyState
              title="没有匹配的模型"
              lead="当前筛选条件下没有结果。"
              action={
                <Button
                  onClick={() => {
                    setProviderFilter('ALL')
                    setTypeFilter('ALL')
                    setKeyword('')
                    setOnlyDisabled(false)
                  }}
                >
                  清空筛选
                </Button>
              }
            />
          </div>
        ) : (
          <div className="card">
            <Table<ModelItem>
              rowKey="id"
              size="middle"
              columns={modelColumns}
              dataSource={filteredModels}
              loading={false}
              pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => `共 ${count} 个 · 每页 20` }}
              scroll={{ x: 1220 }}
            />
          </div>
        )}
      </section>

      <ProviderFormModal provider={null} open={creatingProvider} onClose={() => setCreatingProvider(false)} />
      <ProviderFormModal
        provider={editingProvider}
        open={editingProvider !== null}
        onClose={() => setEditingProvider(null)}
      />
      <DeleteProviderModal
        provider={deletingProvider}
        open={deletingProvider !== null}
        onClose={() => setDeletingProvider(null)}
      />
      <RemoteModelsDrawer provider={probingProvider} onClose={() => setProbingProvider(null)} />
      <ModelFormModal
        model={null}
        open={creatingModel}
        providers={providers}
        defaultProviderId={providerFilter === 'ALL' ? undefined : providerFilter}
        onClose={() => setCreatingModel(false)}
      />
      <ModelFormModal
        model={editingModel}
        open={editingModel !== null}
        providers={providers}
        onClose={() => setEditingModel(null)}
      />
    </>
  )
}
