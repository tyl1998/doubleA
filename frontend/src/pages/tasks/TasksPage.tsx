/**
 * 任务中心页（`/tasks`，P1-6，2026-10-09 需求变更：**定时任务**）
 *
 * 一条定时任务 = 某个 TaskAgent + 一段指令 + 一个 cron 周期。到点由后端调度器自动新建会话派活；
 * 这里做管理：新建 / 编辑 / 启停 / 立即执行 / 删除，并展示「下一次运行」「最近一次运行状态」。
 *
 * 依据：`docs/03` §4.7、`shared/src/task.ts`、`api/tasks.ts`。
 *
 * ⚠️ 数据源是 `GET /api/tasks`（仅本人）。「立即执行」是**后台跑**、不往页面推流 ⇒ 不跳转；
 * 列表按 `lastRunStatus` 轮询显示"运行中 → 成功/失败"，跑完点「最近会话」看结果。
 */

import { PlusOutlined } from '@ant-design/icons'
import { Button, Pagination, Popconfirm, Table, Tabs, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AgentItem, ScheduledTaskItem, UpdateScheduledTaskBody } from '@doubulea/shared'

import {
  TASKS_PAGE_LIMIT,
  useCreateScheduledTask,
  useDeleteScheduledTask,
  useRunScheduledTask,
  useScheduledTasks,
  useUpdateScheduledTask,
} from '../../api/tasks.js'
import { useAgents } from '../../api/agents.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { AGENTS_PATH, chatPath } from '../../app/paths.js'
import { formatUpdatedAt } from '../../app/format.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TaskFormModal, type TaskFormValues } from './TaskFormModal.js'
import { ActivityPanel } from './ActivityPanel.js'
import { MemoryPanel } from './MemoryPanel.js'
import { scheduleSummary, taskRunStatusLabel, taskRunStatusLed, notifySummary } from './taskModel.js'

/** 「任务中心」的三个视图（P1-8 起：定时任务 + 活动时间线 + 记忆面板） */
type TasksTabKey = 'tasks' | 'activity' | 'memory'

function timeText(iso: string | null): string {
  return iso === null ? '—' : formatUpdatedAt(iso)
}

export function TasksPage() {
  const limit = TASKS_PAGE_LIMIT
  const [offset, setOffset] = useState(0)
  const [tab, setTab] = useState<TasksTabKey>('tasks')
  const query = useScheduledTasks(offset, limit)
  const agentsQuery = useAgents({ limit: 100 })
  const feedback = useFeedback()
  const { t, locale } = useT()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduledTaskItem | null>(null)

  const create = useCreateScheduledTask()
  const update = useUpdateScheduledTask()
  const remove = useDeleteScheduledTask()
  const run = useRunScheduledTask()

  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  // ChatBot 与 TaskAgent 都可被定时派活（ChatBot 也能调 MCP 工具）⇒ 全部智能体都可选
  const agents: AgentItem[] = agentsQuery.data?.items ?? []

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }
  function openEdit(task: ScheduledTaskItem) {
    setEditing(task)
    setFormOpen(true)
  }

  function submit(values: TaskFormValues) {
    if (editing === null) {
      create.mutate(values, {
        onSuccess: () => {
          feedback.ok(t('tasks.createdOk'))
          setFormOpen(false)
        },
        onError: (error) => feedback.fail(error, t('tasks.createFailed')),
      })
      return
    }
    // 编辑：url/secret 留空 = 保持不变（不发送该字段）；要清空就把「通知渠道」改为「不通知」
    const body: UpdateScheduledTaskBody = {
      name: values.name,
      prompt: values.prompt,
      cronExpr: values.cronExpr,
      enabled: values.enabled,
      autoApprove: values.autoApprove,
      notifyType: values.notifyType,
      notifyTemplate: values.notifyTemplate.trim(),
    }
    if (values.notifyUrl.trim() !== '') body.notifyUrl = values.notifyUrl.trim()
    if (values.notifySecret.trim() !== '') body.notifySecret = values.notifySecret.trim()
    update.mutate(
      { id: editing.id, body },
      {
        onSuccess: () => {
          feedback.ok(t('tasks.savedOk'))
          setFormOpen(false)
        },
        onError: (error) => feedback.fail(error, t('tasks.saveFailed')),
      },
    )
  }

  const columns: ColumnsType<ScheduledTaskItem> = [
    {
      title: t('tasks.colName'),
      dataIndex: 'name',
      render: (_value, task) => (
        <div className="agent-cell">
          <span className="agent-cell__name">{task.name}</span>
          <span className="agent-cell__sub">{task.agentName}</span>
        </div>
      ),
    },
    {
      title: t('tasks.colSchedule'),
      dataIndex: 'cronExpr',
      width: 220,
      render: (_value, task) => <span className="num">{scheduleSummary(task.cronExpr, locale)}</span>,
    },
    {
      title: t('tasks.colNotify'),
      key: 'notify',
      width: 120,
      render: (_value, task) => {
        const label = notifySummary(task.notifyType, locale)
        return label === null ? <span className="ratio">—</span> : <Tag>{label}</Tag>
      },
    },
    {
      title: t('tasks.colNextRun'),
      dataIndex: 'nextRunAt',
      width: 150,
      render: (_value, task) =>
        task.enabled ? (
          <span className="num">{timeText(task.nextRunAt)}</span>
        ) : (
          <Tag>{t('tasks.disabledTag')}</Tag>
        ),
    },
    {
      title: t('tasks.colLastRun'),
      key: 'lastRun',
      width: 170,
      render: (_value, task) => (
        <div className="kb-cell">
          {/* 状态灯 + 文案两重表达（`.led--*`；与用户/知识库列表同一套） */}
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <span className={`led led--${taskRunStatusLed(task.lastRunStatus)}`} aria-hidden="true" />
            <span>{taskRunStatusLabel(task.lastRunStatus, locale)}</span>
          </span>
          <span className="kb-cell__sub">{timeText(task.lastRunAt)}</span>
        </div>
      ),
    },
    {
      title: t('tasks.colActions'),
      key: 'actions',
      width: 280,
      align: 'right',
      // 操作列固定右侧（`03` §七 表格规范）
      fixed: 'right',
      render: (_value, task) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            loading={run.isPending && run.variables === task.id}
            onClick={() => {
              run.mutate(task.id, {
                onSuccess: () => {
                  // 不跳转：这一轮是**后台跑**、不会往页面推流，跳过去只会看到一个空会话。
                  // 让列表轮询显示"运行中 → 成功/失败"，跑完再点「最近会话」看结果。
                  feedback.note(t('tasks.startedNotice'))
                },
                onError: (error) => feedback.fail(error, t('tasks.runFailed')),
              })
            }}
          >
            {t('tasks.runNow')}
          </Button>
          {task.lastConversationId !== null && (
            <Link to={chatPath(task.agentId, task.lastConversationId)}>{t('tasks.lastConversation')}</Link>
          )}
          <Popconfirm
            title={task.enabled ? t('tasks.disableTitle', { name: task.name }) : t('tasks.enableTitle', { name: task.name })}
            description={task.enabled ? t('tasks.disableDescription') : t('tasks.enableDescription')}
            okText={task.enabled ? t('tasks.disable') : t('tasks.enable')}
            okButtonProps={{ danger: task.enabled }}
            cancelText={t('common.cancel')}
            onConfirm={() => {
              update.mutate(
                { id: task.id, body: { enabled: !task.enabled } },
                { onError: (error) => feedback.fail(error, t('tasks.toggleFailed')) },
              )
            }}
          >
            <Button
              type="link"
              size="small"
              danger={task.enabled}
              style={{ padding: 0 }}
              loading={update.isPending && update.variables?.id === task.id}
            >
              {task.enabled ? t('tasks.disable') : t('tasks.enable')}
            </Button>
          </Popconfirm>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openEdit(task)}>
            {t('tasks.edit')}
          </Button>
          <Popconfirm
            title={t('tasks.deleteTitle')}
            description={t('tasks.deleteDescription')}
            okText={t('common.delete')}
            okButtonProps={{ danger: true }}
            cancelText={t('common.cancel')}
            onConfirm={() => {
              remove.mutate(task.id, {
                onSuccess: () => {
                  feedback.ok(t('tasks.deletedOk'))
                  if (items.length === 1 && offset > 0) setOffset(Math.max(0, offset - limit))
                },
                onError: (error) => feedback.fail(error, t('tasks.deleteFailed')),
              })
            }}
          >
            <Button type="link" danger size="small" style={{ padding: 0 }}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('tasks.title')}</h1>
          <p className="page__lead">{t('tasks.lead')}</p>
        </div>
        {tab === 'tasks' ? (
          <div className="page__head-actions">
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              {t('tasks.newTask')}
            </Button>
          </div>
        ) : null}
      </div>

      <Tabs
        activeKey={tab}
        onChange={(key) => {
          setTab(key as TasksTabKey)
        }}
        items={[
          {
            key: 'tasks',
            label: t('tasks.tabTasks'),
            children: (
              <>
                {query.isError ? (
                  <ErrorState
                    title={t('tasks.loadFailed')}
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
                      title={t('tasks.emptyTitle')}
                      lead={t('tasks.emptyLead')}
                      action={
                        agents.length === 0 ? (
                          <Link to={AGENTS_PATH}>
                            <Button type="primary">{t('tasks.goCreateAgent')}</Button>
                          </Link>
                        ) : (
                          <Button type="primary" onClick={openCreate}>
                            {t('tasks.newTask')}
                          </Button>
                        )
                      }
                    />
                  </div>
                ) : (
                  <>
                    <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
                      {t('tasks.totalCount', { total })}
                    </p>
                    <div className="card" data-testid="scheduled-task-table">
                      <Table
                        rowKey="id"
                        columns={columns}
                        dataSource={items}
                        pagination={false}
                        size="middle"
                        scroll={{ x: 'max-content' }}
                      />
                    </div>
                    {total > limit ? (
                      <div className="row" style={{ marginTop: 'var(--sp-4)', justifyContent: 'flex-end' }}>
                        <Pagination
                          current={Math.floor(offset / limit) + 1}
                          pageSize={limit}
                          total={total}
                          showSizeChanger={false}
                          onChange={(page) => {
                            setOffset((page - 1) * limit)
                          }}
                        />
                      </div>
                    ) : null}
                  </>
                )}
              </>
            ),
          },
          { key: 'activity', label: t('tasks.tabActivity'), children: <ActivityPanel /> },
          { key: 'memory', label: t('tasks.tabMemory'), children: <MemoryPanel /> },
        ]}
      />

      <TaskFormModal
        open={formOpen}
        task={editing}
        agents={agents}
        submitting={create.isPending || update.isPending}
        onCancel={() => setFormOpen(false)}
        onSubmit={submit}
      />
    </>
  )
}
