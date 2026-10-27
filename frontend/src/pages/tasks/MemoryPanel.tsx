/**
 * 记忆面板（P1-8 / v2 P1-8a）—— 并入「任务中心」的一个 tab（HCI §5.2 / §5.7）
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §五（HCI）/§八（v2：两层作用域 + 提升/降级）。
 *
 * 三块：
 *   · **开关**（顶部）：记忆总开关 / 自动提取 / 「全自动」/ 画像常驻上限；
 *   · **列表**：全部条目 + 关键词/类型/**作用域**筛选；每行显示正文、类型、**作用域**、来源、时间；
 *     操作 = 置顶 / 编辑 / **提升为全局**（AGENT→USER） / 删除；
 *   · **新增/编辑**：文本 + 类型 + **作用域**（全局 / 某个 Agent） + 置顶。
 */

import { PlusOutlined } from '@ant-design/icons'
import {
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import type { CreateMemoryBody, MemoryItem, MemoryKind, MemoryScope } from '@doubulea/shared'

import { useAgents } from '../../api/agents.js'
import {
  useCreateMemory,
  useDeleteMemory,
  useMemories,
  useMemorySettings,
  useUpdateMemory,
  useUpdateMemorySettings,
  MEMORY_PAGE_LIMIT,
} from '../../api/memory.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatUpdatedAt } from '../../app/format.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import {
  memoryKindColor,
  memoryKindLabel,
  memoryKindOptions,
  memoryScopeLabel,
  memoryScopeOptions,
  memorySourceText,
} from './memoryModel.js'

const { TextArea } = Input

/** 作用域选项里的"全局"哨兵值（Select 不接受 `null`，用 `''` 表达"全局"） */
const GLOBAL_SCOPE_VALUE = ''

interface MemoryFormValues {
  text: string
  kind: MemoryKind
  /** `''` = 全局（USER）；agent id = AGENT */
  agentId: string
  pinned: boolean
}

export function MemoryPanel() {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const [offset, setOffset] = useState(0)
  const [kindFilter, setKindFilter] = useState<MemoryKind | undefined>(undefined)
  const [scopeFilter, setScopeFilter] = useState<MemoryScope | undefined>(undefined)
  const [keyword, setKeyword] = useState('')
  const [committedKeyword, setCommittedKeyword] = useState('')

  const agentsQuery = useAgents({ limit: 100 })
  const agents = agentsQuery.data?.items ?? []

  const settings = useMemorySettings()
  const query = useMemories({
    offset,
    limit: MEMORY_PAGE_LIMIT,
    ...(kindFilter === undefined ? {} : { kind: kindFilter }),
    ...(scopeFilter === undefined ? {} : { scope: scopeFilter }),
    q: committedKeyword,
  })
  const create = useCreateMemory()
  const update = useUpdateMemory()
  const remove = useDeleteMemory()
  const updateSettings = useUpdateMemorySettings()

  const [editing, setEditing] = useState<MemoryItem | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form] = Form.useForm<MemoryFormValues>()

  const items = query.data?.items ?? []

  const scopeOptions = [
    { value: GLOBAL_SCOPE_VALUE, label: t('memory.globalScopeOption') },
    ...agents.map((agent) => ({ value: agent.id, label: t('memory.agentScopeOption', { name: agent.name }) })),
  ]

  function openCreate() {
    setEditing(null)
    form.setFieldsValue({ text: '', kind: 'OTHER', agentId: GLOBAL_SCOPE_VALUE, pinned: false })
    setFormOpen(true)
  }

  function openEdit(memory: MemoryItem) {
    setEditing(memory)
    form.setFieldsValue({
      text: memory.text,
      kind: memory.kind,
      agentId: memory.agentId ?? GLOBAL_SCOPE_VALUE,
      pinned: memory.pinned,
    })
    setFormOpen(true)
  }

  function submit() {
    void form.validateFields().then((values) => {
      const agentId = values.agentId === GLOBAL_SCOPE_VALUE ? null : values.agentId
      if (editing === null) {
        const body: CreateMemoryBody = {
          text: values.text,
          kind: values.kind,
          pinned: values.pinned,
          ...(agentId === null ? {} : { agentId }),
        }
        create.mutate(body, {
          onSuccess: () => {
            feedback.ok(t('memory.addedOk'))
            setFormOpen(false)
          },
          onError: (error) => feedback.fail(error, t('memory.addFailed')),
        })
        return
      }
      update.mutate(
        { id: editing.id, body: { text: values.text, kind: values.kind, pinned: values.pinned, agentId } },
        {
          onSuccess: () => {
            feedback.ok(t('memory.savedOk'))
            setFormOpen(false)
          },
          onError: (error) => feedback.fail(error, t('memory.saveFailed')),
        },
      )
    })
  }

  function togglePin(memory: MemoryItem) {
    update.mutate(
      { id: memory.id, body: { pinned: !memory.pinned } },
      { onError: (error) => feedback.fail(error, t('memory.opFailed')) },
    )
  }

  /** 提升为全局记忆（AGENT → USER，§8.7） */
  function promoteToGlobal(memory: MemoryItem) {
    update.mutate(
      { id: memory.id, body: { agentId: null } },
      {
        onSuccess: () => feedback.ok(t('memory.promotedOk')),
        onError: (error) => feedback.fail(error, t('memory.opFailed')),
      },
    )
  }

  const columns: ColumnsType<MemoryItem> = [
    {
      title: t('memory.colText'),
      dataIndex: 'text',
      // ⚠️ **必须给宽度**：不给宽度时这一列会按正文的 max-content 撑开（记忆正文上限 2000 字），
      // 整张表被顶宽 ⇒ 右侧的「作用域 / 类型 / 来源 / 时间 / 操作」几列被挤出可视区、根本看不到。
      // 配合 `.agent-cell__name` 的一行截断，悬浮约 1s 用 tooltip 展示完整正文。
      width: 320,
      render: (_value, memory) => (
        <div className="agent-cell">
          <Tooltip title={memory.text} mouseEnterDelay={1} placement="topLeft">
            <span className="agent-cell__name">{memory.text}</span>
          </Tooltip>
          {memory.agentName !== null ? (
            <span className="agent-cell__sub">{t('memory.agentPrefix', { name: memory.agentName })}</span>
          ) : null}
        </div>
      ),
    },
    {
      title: t('memory.colScope'),
      dataIndex: 'scope',
      width: 110,
      render: (_value, memory) => (
        <Tag color={memory.scope === 'USER' ? 'gold' : 'geekblue'}>{memoryScopeLabel(memory.scope, locale)}</Tag>
      ),
    },
    {
      title: t('memory.colKind'),
      dataIndex: 'kind',
      width: 90,
      render: (_value, memory) => (
        <Tag color={memoryKindColor(memory.kind)}>{memoryKindLabel(memory.kind, locale)}</Tag>
      ),
    },
    {
      title: t('memory.colSource'),
      key: 'source',
      width: 180,
      render: (_value, memory) => (
        <span className="ratio">
          {memorySourceText(
            {
              sourceConversationId: memory.sourceConversationId,
              sourceAvailable: memory.sourceAvailable,
              sourceTopic: memory.sourceTopic,
            },
            locale,
          )}
        </span>
      ),
    },
    {
      title: t('memory.colCreatedAt'),
      dataIndex: 'createdAt',
      width: 150,
      render: (value: string) => <span className="num">{formatUpdatedAt(value)}</span>,
    },
    {
      title: t('memory.colActions'),
      key: 'actions',
      width: 240,
      align: 'right',
      fixed: 'right',
      render: (_value, memory) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => togglePin(memory)}>
            {memory.pinned ? t('memory.unpin') : t('memory.pin')}
          </Button>
          {memory.scope === 'AGENT' ? (
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => promoteToGlobal(memory)}>
              {t('memory.promote')}
            </Button>
          ) : null}
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openEdit(memory)}>
            {t('memory.edit')}
          </Button>
          <Popconfirm
            title={t('memory.deleteTitle')}
            description={t('memory.deleteDescription')}
            okText={t('memory.delete')}
            okButtonProps={{ danger: true }}
            cancelText={t('common.cancel')}
            onConfirm={() => {
              remove.mutate(memory.id, {
                onSuccess: () => {
                  feedback.ok(t('memory.deletedOk'))
                  if (items.length === 1 && offset > 0) setOffset(Math.max(0, offset - MEMORY_PAGE_LIMIT))
                },
                onError: (error) => feedback.fail(error, t('memory.deleteFailed')),
              })
            }}
          >
            <Button type="link" danger size="small" style={{ padding: 0 }}>
              {t('memory.delete')}
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  const settingsValue = settings.data

  return (
    <>
      <div className="card card--pad" style={{ marginBottom: 'var(--sp-4)' }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-5)', alignItems: 'center' }}>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Switch
              size="small"
              checked={settingsValue?.enabled ?? true}
              loading={updateSettings.isPending}
              onChange={(checked) => {
                updateSettings.mutate(
                  { enabled: checked },
                  { onError: (error) => feedback.fail(error, t('memory.switchFailed')) },
                )
              }}
            />
            {t('memory.masterSwitch')}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Switch
              size="small"
              checked={settingsValue?.autoExtract ?? true}
              disabled={settingsValue?.enabled === false}
              loading={updateSettings.isPending}
              onChange={(checked) => {
                updateSettings.mutate(
                  { autoExtract: checked },
                  { onError: (error) => feedback.fail(error, t('memory.switchFailed')) },
                )
              }}
            />
            {t('memory.autoExtract')}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Switch
              size="small"
              checked={settingsValue?.fullAuto ?? false}
              disabled={settingsValue?.enabled === false}
              loading={updateSettings.isPending}
              onChange={(checked) => {
                updateSettings.mutate(
                  { fullAuto: checked },
                  {
                    onSuccess: () => {
                      if (checked) feedback.note(t('memory.fullAutoOn'))
                    },
                    onError: (error) => feedback.fail(error, t('memory.switchFailed')),
                  },
                )
              }}
            />
            {t('memory.fullAuto')}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            {t('memory.profileMax')}
            <InputNumber
              size="small"
              min={1}
              max={50}
              value={settingsValue?.memoryProfileMax ?? 10}
              disabled={settingsValue?.enabled === false}
              onChange={(value) => {
                if (typeof value !== 'number') return
                updateSettings.mutate(
                  { memoryProfileMax: value },
                  { onError: (error) => feedback.fail(error, t('memory.saveFailed')) },
                )
              }}
            />
          </span>
          <span className="ratio">{t('memory.entryLimit', { count: settingsValue?.maxPerUser ?? '—' })}</span>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-3)', gap: 'var(--sp-3)' }}>
        <div className="row" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <Select
            allowClear
            placeholder={t('memory.filterScope')}
            style={{ minWidth: 150 }}
            value={scopeFilter}
            options={memoryScopeOptions(locale)}
            onChange={(value: MemoryScope | undefined) => {
              setScopeFilter(value)
              setOffset(0)
            }}
          />
          <Select
            allowClear
            placeholder={t('memory.filterKind')}
            style={{ minWidth: 130 }}
            value={kindFilter}
            options={memoryKindOptions(locale)}
            onChange={(value: MemoryKind | undefined) => {
              setKindFilter(value)
              setOffset(0)
            }}
          />
          <Input.Search
            placeholder={t('memory.searchPlaceholder')}
            style={{ width: 220 }}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={(value) => {
              setCommittedKeyword(value.trim())
              setOffset(0)
            }}
            allowClear
          />
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('memory.add')}
        </Button>
      </div>

      {query.isError ? (
        <ErrorState
          title={t('memory.loadFailed')}
          error={query.error}
          onRetry={() => {
            void query.refetch()
          }}
          retrying={query.isFetching}
        />
      ) : query.isLoading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('memory.emptyTitle')}
            lead={t('memory.emptyLead')}
          />
        </div>
      ) : (
        <div className="card" data-testid="memory-table">
          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            pagination={false}
            size="middle"
            scroll={{ x: 'max-content' }}
          />
        </div>
      )}

      {(query.data?.total ?? 0) > MEMORY_PAGE_LIMIT ? (
        <div className="row" style={{ marginTop: 'var(--sp-4)', justifyContent: 'flex-end' }}>
          <Pagination
            current={Math.floor(offset / MEMORY_PAGE_LIMIT) + 1}
            pageSize={MEMORY_PAGE_LIMIT}
            total={query.data?.total ?? 0}
            showSizeChanger={false}
            onChange={(page) => {
              setOffset((page - 1) * MEMORY_PAGE_LIMIT)
            }}
          />
        </div>
      ) : null}

      <Modal
        open={formOpen}
        title={editing === null ? t('memory.modalAddTitle') : t('memory.modalEditTitle')}
        okText={editing === null ? t('memory.okAdd') : t('memory.okSave')}
        cancelText={t('common.cancel')}
        confirmLoading={create.isPending || update.isPending}
        onOk={submit}
        onCancel={() => setFormOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ kind: 'OTHER', agentId: GLOBAL_SCOPE_VALUE, pinned: false }}>
          <Form.Item
            name="text"
            label={t('memory.textLabel')}
            rules={[
              { required: true, message: t('memory.textRequired') },
              { max: 2000, message: t('memory.textMax') },
            ]}
          >
            <TextArea rows={3} placeholder={t('memory.textPlaceholder')} />
          </Form.Item>
          <Form.Item name="agentId" label={t('memory.scopeLabel')} extra={t('memory.scopeExtra')}>
            <Select options={scopeOptions} />
          </Form.Item>
          <Form.Item name="kind" label={t('memory.kindLabel')}>
            <Select options={memoryKindOptions(locale)} />
          </Form.Item>
          <Form.Item name="pinned" valuePropName="checked">
            <Checkbox>{t('memory.pinnedLabel')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
