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
 * Provider（配置：baseUrl + Key + 上游协议）与模型（它下面的具体型号）是两级资源，各有各的 CRUD。
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
 *  · **引用数**：`agentCount` = 被多少个**在线**智能体绑定（**默认模型 ∪ 模型池成员**，同一智能体只算一次；
 *    与后端 `removeModel` 守卫同口径）。软删的智能体已自动解绑、不计入 ⇒ 列头写明这一点，否则会出现
 *    "显示 0 个却删不掉"（池成员口径曾漏算）的困惑。
 */

import { Alert, Button, Checkbox, Input, Popconfirm, Select, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import {
  MODEL_TYPES,
  MODEL_TYPE_KEY,
  PROVIDER_CREDENTIAL_MODE_KEY,
  UPSTREAM_PROTOCOL_KEY,
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
import { useCurrentUser } from '../../api/auth.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { formatUpdatedAt } from '../../app/format.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { AGENTS_PATH, KNOWLEDGE_PATH, credentialsSectionPath } from '../../app/paths.js'
import { DeleteProviderModal } from './DeleteProviderModal.js'
import { ModelFormModal } from './ModelFormModal.js'
import { ProviderFormModal } from './ProviderFormModal.js'
import { RemoteModelsDrawer } from './RemoteModelsDrawer.js'
import { SystemModelSection } from './SystemModelSection.js'
import {
  describeProviderKey,
  maxContextText,
  modelDeleteBlockedNotice,
  providerGroupSpans,
  summarizeModels,
} from './adminModel.js'

/**
 * 转移目标（P1-18）：Provider 行与模型行都用它。
 *
 * 模型行的「所属人」其实是**其 Provider 的所属人**（模型随 Provider 归属）⇒ 从模型行点所属人
 * 转移的仍然是那个 Provider。两种行汇成同一个形状，弹窗与文案只有一处。
 */
interface TransferTarget {
  id: string
  name: string
  ownerName: string
}

export function ModelsPage() {
  const feedback = useFeedback()
  const { t, locale } = useT()
  // 「系统模型」区块是**平台级配置**（仅 ADMIN）：判据是 `role === 'ADMIN'`，不是"页面在哪个路由下"
  // —— 模型池页自 P1-13 起对全员开放，同一个页面两种身份都会进来（与 `AssetUserPicker` 同款判据）。
  const { data: me } = useCurrentUser()
  const isAdmin = me?.role === 'ADMIN'
  const typeFilterOptions = [
    { value: 'ALL', label: t('models.allTypes') },
    ...MODEL_TYPES.map((type) => ({ value: type, label: t(MODEL_TYPE_KEY[type]) })),
  ]
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

  const [transferFor, setTransferFor] = useState<TransferTarget | null>(null)

  const [providerFilter, setProviderFilter] = useState<string>('ALL')
  const [typeFilter, setTypeFilter] = useState<ModelType | 'ALL'>('ALL')
  const [keyword, setKeyword] = useState('')
  const [onlyDisabled, setOnlyDisabled] = useState(false)

  const allProviders = providersQuery.data?.items ?? []
  const providerTotal = providersQuery.data?.total ?? 0
  const allModels = modelsQuery.data?.items ?? []
  const modelTotal = modelsQuery.data?.total ?? 0

  // 访问控制由服务端按行下发（2026-10-16 修订：Provider **读 = 全体登录用户**，平台模型池人人可见；
  // 编 / 删 / 转移 = 所属人 + ADMIN，逐行由 `canEdit` 表达）。列表已是全量，前端不再叠筛选。
  const providers = allProviders
  const models = allModels

  // 能新建模型的 Provider（非 ADMIN 不能往别人的 Provider 下加模型 ⇒ 只给自己的可编 Provider）
  const editableProviders = providers.filter((provider) => provider.canEdit)

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
        feedback.ok(t('models.deleted', { name: result.modelName }))
      },
      onError: (error) => feedback.fail(error, t('models.removeFailed')),
    })
  }

  const providerColumns: TableColumnsType<ModelProviderItem> = [
    {
      title: t('models.colName'),
      dataIndex: 'name',
      render: (_, provider) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{provider.name}</span>
          <span className="kb-cell__sub num">{provider.baseUrl}</span>
        </div>
      ),
    },
    {
      // P0-1-37：协议与类型是**两个维度**（同为对话，可以是兼容/Responses/Anthropic），
      // 所以单独一列，而不是塞进「类型」那个 Tag 里 —— 合在一处就没法按协议扫一眼排查。
      // ⚠️ 2026-10-22：Provider 上的 `type` 列已删除 ⇒ 这张表**不再有「类型」列**（见下条）。
      title: t('models.colProtocol'),
      dataIndex: 'protocol',
      width: 160,
      render: (_, provider) => (
        <div className="kb-cell">
          <span>{t(UPSTREAM_PROTOCOL_KEY[provider.protocol])}</span>
          {provider.protocol !== 'OPENAI_COMPAT' && (
            <span className="kb-cell__sub">
              {provider.protocol === 'ANTHROPIC_MESSAGES' ? 'x-api-key' : '/responses'}
            </span>
          )}
          {provider.hasEmbeddingModel && (
            <span className="kb-cell__sub">{t('models.hasVectorModel')}</span>
          )}
        </div>
      ),
    },
    {
      title: t('models.colModelCount'),
      dataIndex: 'modelCount',
      width: 90,
      align: 'right',
      render: (_, provider) => <span className="num">{provider.modelCount}</span>,
    },
    {
      title: t('models.colStatus'),
      dataIndex: 'enabled',
      width: 150,
      render: (_, provider) => (
        <div className="kb-cell">
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <span className={`led led--${provider.enabled ? 'ok' : 'fail'}`} aria-hidden="true" />
            <span>{provider.enabled ? t('models.enabled') : t('models.disabled')}</span>
          </span>
          {!provider.enabled && <span className="kb-cell__sub">{t('models.providerDisabledNote')}</span>}
        </div>
      ),
    },
    {
      // P1-18（2026-10-16 修订）：**合并「共享 Key」与「凭据」两列**。原来两列都在讲 Key
      //（一列讲共享 Key 掩码、一列讲凭据模式），对 `PER_USER` 的 Provider 会出现
      //「不使用（各自 Key）」+「各自 Key · 我未配置」两格互相打架 ⇒ 用户读不懂。
      // 现在**一列讲清"这个 Provider 用谁的 Key、配没配"**：
      //   · 共享 Key：显示掩码 + 已配置/未配置（改它走「编辑」表单）
      //   · 各自 Key：显示我配没配；**没配就把用户引到「我的凭据」**（不再有行内「我的 Key」入口）
      title: t('models.colCredential'),
      dataIndex: 'credentialMode',
      width: 230,
      render: (_, provider) =>
        provider.credentialMode === 'PER_USER' ? (
          <div className="kb-cell">
            <span>{t(PROVIDER_CREDENTIAL_MODE_KEY.PER_USER)}</span>
            {provider.userHasKey ? (
              <span className="kb-cell__sub">{t('models.credConfigured')}</span>
            ) : (
              <span className="kb-cell__sub">
                <Tag color="warning">{t('models.credUnconfigured')}</Tag>
                <Link to={credentialsSectionPath('provider')} style={{ marginLeft: 'var(--sp-2)' }}>
                  {t('models.goCredentials')}
                </Link>
              </span>
            )}
          </div>
        ) : (
          <div className="kb-cell">
            <span className="num">{describeProviderKey(provider, locale)}</span>
            <span className="kb-cell__sub">
              {provider.hasKey ? t('models.sharedKeyMask') : t('models.sharedKeyMissing')}
            </span>
          </div>
        ),
    },
    {
      // P1-13：所属人来自服务端下发的字段（Provider 的访问控制归服务端行级）。
      // P1-18（2026-10-16 修订）：**去掉操作列的「转移所属人」按钮**，把这一列本身做成入口 ——
      // 只有所属人或 ADMIN（服务端下发的 `canEdit`）能点，点了弹转移弹窗；其余人只显示名字。
      title: t('models.colOwner'),
      dataIndex: 'creatorName',
      width: 150,
      render: (_, provider) =>
        provider.canEdit ? (
          <Tooltip title={t('models.ownerTransferTitle')}>
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() =>
                setTransferFor({ id: provider.id, name: provider.name, ownerName: provider.creatorName })
              }
            >
              {provider.creatorName}
            </Button>
          </Tooltip>
        ) : (
          <span>{provider.creatorName}</span>
        ),
    },
    {
      title: t('models.colUpdated'),
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, provider) => <span className="num">{formatUpdatedAt(provider.updatedAt)}</span>,
    },
    {
      title: t('models.colActions'),
      key: 'actions',
      width: 220,
      align: 'right',
      // 固定右侧（`03` §七 表格规范）。本表列宽之和超过 1000px ⇒ 窄屏必然横向滚动
      fixed: 'right',
      render: (_, provider) =>
        // P1-18：编 / 删 按服务端给的 `canEdit`（所属人或 ADMIN）渲染。
        // Provider 访问 = 所属人 + ADMIN（P1-18 起无"分享给你"这一档）。
        // ⚠️ 2026-10-16 修订：行内**去掉「转移所属人」按钮**（改点「所属人」列）
        //    与「我的 Key」按钮（统一去「我的凭据」页配置）。
        provider.canEdit ? (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditingProvider(provider)}>
              {t('models.edit')}
            </Button>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setProbingProvider(provider)}>
              {t('models.fetchRemote')}
            </Button>
            {/* 删除放最后（§七）；Provider 删除是**级联**那一档 ⇒ 走 Modal + 逐字确认 */}
            <Button
              type="link"
              size="small"
              danger
              style={{ padding: 0 }}
              onClick={() => setDeletingProvider(provider)}
            >
              {t('models.remove')}
            </Button>
          </div>
        ) : (
          <span className="ratio" title={t('models.noEditPermTitle')}>
            {t('models.noEditPerm')}
          </span>
        ),
    },
  ]

  const modelColumns: TableColumnsType<ModelItem> = [
    {
      title: 'Provider',
      dataIndex: 'providerName',
      width: 200,
      // ⚠️ 相邻同 Provider 的行合并；**不许**给这一列开客户端排序（见 `providerGroupSpans`）
      onCell: (_, index) => ({ rowSpan: spans[index ?? 0] ?? 1 }),
      render: (_, model) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{model.providerName}</span>
          {/* P1-18（2026-10-16 追加）：把所属 Provider 的 baseUrl 显示出来 —— 同名 Provider
              靠 id 区分，仅凭名字认不出"这个模型到底打到哪个上游"。 */}
          <span className="kb-cell__sub num">{model.providerBaseUrl}</span>
          {!model.providerEnabled && <span className="kb-cell__sub">{t('models.providerDisabledCell')}</span>}
        </div>
      ),
    },
    {
      title: t('models.colModel'),
      dataIndex: 'label',
      render: (_, model) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{model.label}</span>
          <span className="kb-cell__sub num">{model.modelName}</span>
        </div>
      ),
    },
    {
      title: t('models.colType'),
      dataIndex: 'type',
      width: 90,
      render: (_, model) => <Tag>{t(MODEL_TYPE_KEY[model.type])}</Tag>,
    },
    {
      // 对话模型看"上下文长度"，向量模型看"维度"（`01` 起向量模型没有 token 上下文这个概念）
      title: t('models.colContextDim'),
      dataIndex: 'maxContext',
      width: 130,
      align: 'right',
      render: (_, model) =>
        model.type === 'EMBEDDING' ? (
          <span className="num">
            {model.embeddingDim === null ? t('models.dimEmpty') : t('models.dimValue', { value: model.embeddingDim })}
          </span>
        ) : (
          <span className="num">{maxContextText(model.maxContext, locale)}</span>
        ),
    },
    {
      title: t('models.colVision'),
      dataIndex: 'supportsVision',
      width: 70,
      align: 'center',
      render: (_, model) => (
        <span className="num">{model.type === 'EMBEDDING' ? '—' : model.supportsVision ? '✓' : '—'}</span>
      ),
    },
    {
      title: t('models.colReasoning'),
      dataIndex: 'supportsReasoning',
      width: 70,
      align: 'center',
      render: (_, model) => (
        <span className="num">{model.type === 'EMBEDDING' ? '—' : model.supportsReasoning ? '✓' : '—'}</span>
      ),
    },
    {
      title: t('models.colStatus'),
      dataIndex: 'enabled',
      width: 150,
      render: (_, model) => (
        <div className="kb-cell">
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <span className={`led led--${model.enabled ? 'ok' : 'fail'}`} aria-hidden="true" />
            <span>{model.enabled ? t('models.enabled') : t('models.disabled')}</span>
          </span>
          {!model.enabled && <span className="kb-cell__sub">{t('models.disabledNotSelectable')}</span>}
        </div>
      ),
    },
    {
      // P1-13：模型随 Provider —— 所属人取自其 Provider（`providerOwnerName`，Model 本身没有这一列）。
      // P1-18（2026-10-16 修订）：这一列可点 —— 从模型行转移的**是它所属的 Provider**
      //（模型没有独立归属，所有权只在 Provider 上）。只有 `canEdit`（Provider 的所属人或 ADMIN）能点。
      title: t('models.colOwner'),
      dataIndex: 'providerOwnerName',
      width: 150,
      render: (_, model) =>
        model.canEdit ? (
          <Tooltip title={t('models.ownerProviderTransferTitle')}>
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() =>
                setTransferFor({ id: model.providerId, name: model.providerName, ownerName: model.providerOwnerName })
              }
            >
              {model.providerOwnerName}
            </Button>
          </Tooltip>
        ) : (
          <span>{model.providerOwnerName}</span>
        ),
    },
    {
      title: (
        // 列头写明口径：默认模型 ∪ 模型池成员（同一智能体只算一次），**只算在线**智能体；
        // 软删的智能体已自动解绑（model_id 置空 + 池成员行清空），不再计入。不写会出现
        // "显示 0 个却删不掉"（池成员口径曾漏算）或"显示被删的智能体"的困惑。
        <Tooltip title={t('models.agentRefTitle')}>
          <span>{t('models.colRef')}</span>
        </Tooltip>
      ),
      dataIndex: 'agentCount',
      width: 80,
      align: 'right',
      render: (_, model) =>
        model.agentCount === 0 ? <span className="ratio">0</span> : <span className="num">{model.agentCount}</span>,
    },
    {
      title: t('models.colActions'),
      key: 'actions',
      width: 140,
      align: 'right',
      fixed: 'right',
      render: (_, model) => {
        // P1-13：模型的编 / 删判据 = 其 Provider 的 `canEdit`（所属人或 ADMIN）
        // ⇒ 只读行（分享给你但不可编）不给编辑 / 删除入口。
        if (!model.canEdit) {
          return (
            <span className="ratio" title={t('models.modelNoEditPermTitle')}>
              {t('models.noEditPerm')}
            </span>
          )
        }
        const blocked = modelDeleteBlockedNotice(model, locale)
        return (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditingModel(model)}>
              {t('models.edit')}
            </Button>
            {blocked !== null ? (
              // 被引用时**不禁用整个按钮**而是把 Popconfirm 的确认键标灰 + 说明 + 指路
              //（`agentCount` 与后端守卫同口径 ⇒ 这里说的"删不掉"就是真会拿到的 409）
              <Popconfirm
                title={t('models.removeModelTitle', { label: model.label })}
                description={
                  <>
                    {blocked}
                    <br />
                    {model.agentCount > 0 && <Link to={AGENTS_PATH}>{t('models.goAgentsRebind')}</Link>}
                    {(model.agentCount > 0 && (model.knowledgeBaseCount > 0 || model.captionKnowledgeBaseCount > 0)) &&
                      ' · '}
                    {(model.knowledgeBaseCount > 0 || model.captionKnowledgeBaseCount > 0) && (
                      <Link to={KNOWLEDGE_PATH}>{t('models.goKbModel')}</Link>
                    )}
                    {model.usedAsTitleModel && (
                      <span className="ratio">
                        {t('models.titleModelNote')}
                      </span>
                    )}
                  </>
                }
                okText={t('models.remove')}
                okButtonProps={{ danger: true, disabled: true }}
                cancelText={t('models.acknowledge')}
              >
                <Button type="link" size="small" danger style={{ padding: 0 }}>
                  {t('models.remove')}
                </Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title={t('models.removeModelTitle', { label: model.label })}
                description={t('models.removeModelDesc')}
                okText={t('models.remove')}
                okButtonProps={{ danger: true }}
                cancelText={t('common.cancel')}
                onConfirm={() => doRemoveModel(model)}
              >
                <Button
                  type="link"
                  size="small"
                  danger
                  style={{ padding: 0 }}
                  loading={removeModel.isPending && removeModel.variables === model.id}
                >
                  {t('models.remove')}
                </Button>
              </Popconfirm>
            )}
          </div>
        )
      },
    },
  ]

  const providerSelectOptions = [
    { value: 'ALL', label: t('models.allProviders') },
    ...providers.map((provider) => ({
      value: provider.id,
      label: `${provider.name}${provider.enabled ? '' : t('models.providerDisabledSuffix')}`,
    })),
  ]

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('models.title')}</h1>
          <p className="page__lead">
            {t('models.leadPrefix')}
            <strong>{t('models.leadStrong1')}</strong>
            {t('models.leadMid')}
            <strong>{t('models.leadStrong2')}</strong>
            {t('models.leadSuffix')}
          </p>
        </div>
        <div className="page__head-actions">
          <Button onClick={() => setCreatingProvider(true)}>{t('models.createProvider')}</Button>
          <Button
            type="primary"
            onClick={() => setCreatingModel(true)}
            disabled={editableProviders.length === 0}
            title={
              editableProviders.length === 0
                ? t('models.needEditProviderHint')
                : t('models.createModel')
            }
          >
            {t('models.createModel')}
          </Button>
        </div>
      </div>

      {/* ───────────────────── 系统模型（仅 ADMIN）─────────────────────
          平台级"会话标题生成用哪个模型"；与模型池同主题、共用 CHAT 模型下拉，故并入本页而非单开一页。 */}
      {isAdmin && <SystemModelSection />}

      {/* ───────────────────── Provider ───────────────────── */}
      <section className="admin-section">
        <div className="admin-section__head">
          <h2 className="card__title">Provider</h2>
          <span className="ratio">
            {t('models.providerTotal', { count: providerTotal })}
            {providerTotal > providers.length && (
              <> {t('models.providerTotalMore', { shown: providers.length })}</>
            )}
          </span>
        </div>

        {providersQuery.isError ? (
          <ErrorState
            title={t('models.providerLoadFailed')}
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
              title={t('models.noProviderTitle')}
              lead={t('models.noProviderLead')}
              action={
                <Button type="primary" onClick={() => setCreatingProvider(true)}>
                  {t('models.createProvider')}
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
              pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => t('models.total', { count }) }}
              scroll={{ x: 1280 }}
            />
          </div>
        )}
      </section>

      {/* ───────────────────── 模型 ───────────────────── */}
      <section>
        <div className="admin-section__head">
          <h2 className="card__title">{t('models.modelCard')}</h2>
          <span className="ratio">
            {t('models.summaryProviders', {
              total: summary.total,
              providers: summary.providers,
              disabled: summary.disabled,
              vision: summary.vision,
            })}
            {modelTotal > models.length && <>{t('models.summaryBackendTotal', { total: modelTotal })}</>}
          </span>
        </div>

        <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
          <Select
            value={providerFilter}
            options={providerSelectOptions}
            style={{ width: 220 }}
            aria-label={t('models.filterProviderAria')}
            onChange={setProviderFilter}
          />
          <Select
            value={typeFilter}
            options={typeFilterOptions}
            style={{ width: 140 }}
            aria-label={t('models.filterTypeAria')}
            onChange={(value: ModelType | 'ALL') => setTypeFilter(value)}
          />
          <Input.Search
            allowClear
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t('models.searchPlaceholder')}
            style={{ width: 240 }}
            aria-label={t('models.searchAria')}
          />
          <Checkbox checked={onlyDisabled} onChange={(event) => setOnlyDisabled(event.target.checked)}>
            {t('models.onlyDisabled')}
          </Checkbox>
        </div>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message={t('models.disabledNoteTitle')}
          description={
            <>
              {t('models.disabledNoteDesc')}
              <strong>{t('models.disabledNoteStrong')}</strong>
              {t('models.disabledNoteTail')}
            </>
          }
        />

        {modelsQuery.isError ? (
          <ErrorState
            title={t('models.modelLoadFailed')}
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
              title={t('models.noModelTitle')}
              lead={
                editableProviders.length === 0
                  ? t('models.noModelNeedProvider')
                  : t('models.noModelHint')
              }
              action={
                <Button
                  type="primary"
                  onClick={() => setCreatingModel(true)}
                  disabled={editableProviders.length === 0}
                >
                  {t('models.createModel')}
                </Button>
              }
            />
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="card">
            <EmptyState
              title={t('models.noMatchTitle')}
              lead={t('models.noMatchLead')}
              action={
                <Button
                  onClick={() => {
                    setProviderFilter('ALL')
                    setTypeFilter('ALL')
                    setKeyword('')
                    setOnlyDisabled(false)
                  }}
                >
                  {t('models.clearFilter')}
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
              pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => t('models.total', { count }) }}
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
        providers={editableProviders}
        defaultProviderId={providerFilter === 'ALL' ? undefined : providerFilter}
        onClose={() => setCreatingModel(false)}
      />
      <ModelFormModal
        model={editingModel}
        open={editingModel !== null}
        providers={editableProviders}
        onClose={() => setEditingModel(null)}
      />
      <TransferOwnershipModal
        open={transferFor !== null}
        assetKind="PROVIDER"
        assetId={transferFor?.id ?? ''}
        assetName={transferFor?.name ?? ''}
        currentOwnerName={transferFor?.ownerName ?? ''}
        onClose={() => setTransferFor(null)}
      />
    </>
  )
}
