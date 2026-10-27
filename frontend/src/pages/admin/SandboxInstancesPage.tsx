/**
 * 沙箱实例（`/admin/sandbox-instances`，**ADMIN**）—— "现在有哪些实例注册"
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 4（实例自动发现）/ §九·补（负载进注册表）；
 *      契约 `shared/src/sandboxInstance.ts`、`services/sandboxInstance.service.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一页在回答什么
 * ─────────────────────────────────────────────────────────────────────
 * 多机部署下"哪些后端在线、各自多忙"原本只有网关的 `/health` 知道。本页经**业务后端**的只读端点
 * 读同一张 Redis 注册表（`sandbox:instance:*`），因此：数据与网关自动发现**同源同判据**；
 * 前端不需要打网关、开发期也能看到。
 *
 * ⚠️ **只读**：注册由各实例心跳写入，本页不提供上下线操作。注册键消失 = 实例下线（TTL = 3× 心跳）。
 * ⚠️ **读失败不是"零台实例"**：Redis 抖动时后端如实回 `error`，本页据此显示错误条，而不是空表。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 「本机」那一行是**固定**的（2026-10-20 用户反馈"本机标签跳来跳去"）
 * ─────────────────────────────────────────────────────────────────────
 * 那条请求（`GET /api/admin/sandbox/instances`）与 `/api/auth/me` 一样是**非粘性**路由：
 * 网关按 P2C / 轮询挑一台作答，所以**每次轮询**都可能换一台后端 ⇒ 后端回的 `selfInstanceId`
 * 也每 10s 换一次。把"这份响应的作者"直接画成「本机」，看起来就是标签在两行之间跳。
 *
 * 结论口径改成两件事，各归各位：
 *   · **「本机」= 打开本页时那台后端**（进页面时读一次 `/health` 的 `instanceId` 并钉住）——
 *     问"这个进程是谁"的答案是稳定的；
 *   · **读的是快照，不是某台进程**：表格里那一行「本机」只表示"数据由这台实例提供"，
 *     换一台后端不影响任何一行的内容（注册表在 Redis 里，读谁都一样）。
 */

import { Alert, Button, Modal, Space, Spin, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ReloadOutlined } from '@ant-design/icons'
import type { Locale, NodeCheckItem, SandboxInstanceItem } from '@doubulea/shared'

import { fetchCurrentUser } from '../../api/auth.js'
import { useNodeBootstrapJob, useNodeSelf, useStartBootstrapJob } from '../../api/node.js'
import { SANDBOX_INSTANCES_QUERY_KEY, useSandboxInstances, useSetSandboxDrained } from '../../api/sandboxInstances.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { useT, type Translate } from '../../app/i18n.js'
import { localeTag } from '../../app/locale.js'
import { NodeBootstrapProgressPanel } from './NodeBootstrapProgress.js'
import {
  drainActionView,
  heartbeatText,
  loadAgeText,
  sandboxInstanceState,
  sandboxInstanceStateLabel,
  slotRatioText,
  type SandboxInstanceState,
} from './sandboxInstanceModel.js'

const STATE_COLOR: Record<SandboxInstanceState, string> = {
  online: 'green',
  'load-stale': 'orange',
  stale: 'red',
}

function columnsFor(args: {
  now: number
  loadStaleMs: number
  selfInstanceId: string | null
  discovered: readonly string[]
  t: Translate
  locale: Locale
}): TableColumnsType<SandboxInstanceItem> {
  const { t, locale } = args
  return [
    {
      title: t('sandboxInst.colInstance'),
      dataIndex: 'instanceId',
      render: (_, item) => (
        <Space size={6}>
          <span className="kb-cell__name">{item.instanceId}</span>
          {item.instanceId === args.selfInstanceId && <Tag color="blue">{t('sandboxInst.selfTag')}</Tag>}
          {args.discovered.includes(item.advertiseAddr) && <Tag>{t('sandboxInst.discoveredTag')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('sandboxInst.colStatus'),
      key: 'state',
      width: 160,
      render: (_, item) => {
        const view = sandboxInstanceState(item, { now: args.now, loadStaleMs: args.loadStaleMs })
        return (
          <Space size={4} wrap>
            <Tag color={STATE_COLOR[view.state]}>{sandboxInstanceStateLabel(view.state, locale)}</Tag>
            {item.drained && (
              <Tooltip title={t('sandboxInst.drainedTooltip')}>
                <Tag color="default">{t('sandboxInst.drainedTag')}</Tag>
              </Tooltip>
            )}
          </Space>
        )
      },
    },
    {
      title: t('sandboxInst.colNodeReady'),
      key: 'readiness',
      width: 150,
      render: (_, item) =>
        item.readiness === null ? (
          <Typography.Text type="secondary">{t('sandboxInst.unknownUnreported')}</Typography.Text>
        ) : item.readiness.ready ? (
          <Tag color="green">{t('sandboxInst.readyTag')}</Tag>
        ) : (
          <Tooltip
            title={t('sandboxInst.notReadyTooltip', {
              items: item.readiness.missing.join(t('mcp.listSeparator')),
            })}
          >
            <Tag color="orange">{t('sandboxInst.notReadyTag', { count: item.readiness.missing.length })}</Tag>
          </Tooltip>
        ),
    },
    { title: t('sandboxInst.colAdvertiseAddr'), dataIndex: 'advertiseAddr', width: 190 },
    {
      title: t('sandboxInst.colManage'),
      key: 'manage',
      width: 190,
      render: (_, item) => (
        <Space size={4} wrap>
          {/* 「展开」只是提示（展开由 antd 的 expandable 负责，行展开后才有初始化/自检） */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.readiness === null
              ? t('sandboxInst.expandView')
              : item.readiness.ready
                ? t('sandboxInst.expandView')
                : t('sandboxInst.expandInit')}
          </Typography.Text>
          <DrainButton item={item} />
        </Space>
      ),
    },
    {
      title: t('sandboxInst.colSlots'),
      key: 'slots',
      width: 140,
      align: 'right',
      render: (_, item) => <span className="ratio">{slotRatioText(item, locale)}</span>,
    },
    {
      title: t('sandboxInst.colQueue'),
      key: 'queueDepth',
      width: 80,
      align: 'right',
      render: (_, item) => <span className="num">{item.load?.queueDepth ?? '—'}</span>,
    },
    {
      title: t('sandboxInst.colInFlight'),
      key: 'chatbotInFlight',
      width: 120,
      align: 'right',
      render: (_, item) => <span className="num">{item.load?.chatbotInFlight ?? '—'}</span>,
    },
    {
      title: t('sandboxInst.colLoadAge'),
      key: 'loadAge',
      width: 100,
      align: 'right',
      render: (_, item) => (
        <span className="ratio" title={t('sandboxInst.loadAgeTooltip')}>
          {loadAgeText(sandboxInstanceState(item, { now: args.now, loadStaleMs: args.loadStaleMs }).loadAgeMs)}
        </span>
      ),
    },
    {
      title: t('sandboxInst.colHeartbeat'),
      key: 'heartbeat',
      width: 120,
      render: (_, item) => <span className="ratio">{heartbeatText(item)}</span>,
    },
    {
      title: t('sandboxInst.colHostPid'),
      key: 'host',
      width: 160,
      render: (_, item) => (
        <span className="ratio">
          {item.host} · {item.pid}
        </span>
      ),
    },
  ]
}

export function SandboxInstancesPage() {
  const { t, locale } = useT()
  const query = useSandboxInstances()
  const [now, setNow] = useState(() => Date.now())
  /**
   * 展开行由页面**受控**（而不是交给 antd 内部状态）：
   * 2026-10-20 用户反馈"点了初始化切页回来什么都看不到" —— 受控展开 + 首次进来**自动展开还在跑的那台**，
   * 让进度回到视线里。
   */
  const [expandedKeys, setExpandedKeys] = useState<readonly string[]>([])
  const data = query.data
  /**
   * **「本机」= 打开本页时承接请求的那台后端**（钉住首屏那一次，见文件头 ★）。
   *
   * 为什么不用 `data.selfInstanceId`：列表接口是非粘性路由，`refetchInterval` 每 10s 打一次，
   * 每次都可能落到**另一台**实例 ⇒ 那个字段每 10s 换一次，画出来就是标签在两行之间跳。
   * 这里读 `/api/auth/me` 的 `instanceId` 并**只读一次**（`staleTime: Infinity`），于是"本机"
   * 从"上一次轮询的作答者"变成"我现在连着的这台后端"—— 这才是用户要问的。
   *
   * ⚠️ **不能读 `/health`**：那条路径被网关自己截获（回的是网关的 `upstreams/cooling`，不是后端
   *    `HealthReport`）⇒ 前端根本拿不到业务后端的 `instanceId`。`/me` 才是会转发到实例后端的。
   */
  const backendQuery = useQuery({
    queryKey: ['admin-backend-identity'],
    queryFn: () => fetchCurrentUser(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const backendInstanceId = backendQuery.data?.instanceId ?? null

  const refresh = (): void => {
    setNow(Date.now())
    void query.refetch()
  }

  /** 首屏（或刷新后）自动展开"节点未就绪"的实例 —— 管理页最常做的事就是来修它 */
  const [autoExpanded, setAutoExpanded] = useState(false)
  useEffect(() => {
    if (autoExpanded || data === undefined) return
    const broken = data.items.filter((item) => item.readiness !== null && !item.readiness.ready).map((item) => item.instanceId)
    if (broken.length > 0) setExpandedKeys(broken)
    setAutoExpanded(true)
  }, [autoExpanded, data])

  const toggleRow = (instanceId: string): void => {
    setExpandedKeys((prev) => (prev.includes(instanceId) ? prev.filter((key) => key !== instanceId) : [...prev, instanceId]))
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('sandboxInst.title')}</h1>
          <p className="page__lead">
            {t('sandboxInst.leadPrefix')}
            <code>sandbox:instance:*</code>
            {t('sandboxInst.leadMid')}
            <strong>{t('sandboxInst.leadStrong')}</strong>
            {t('sandboxInst.leadMid2')}
            <code>sandbox:drain:*</code>
            {t('sandboxInst.leadMid3')}
            <strong>{t('sandboxInst.leadStrong2')}</strong>
            {t('sandboxInst.leadTail')}
          </p>
        </div>
        <Button onClick={refresh} loading={query.isFetching}>
          {t('sandboxInst.refresh')}
        </Button>
      </div>

      {data?.error != null && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message={t('sandboxInst.readFailed')}
          description={
            <Typography.Text code>{data.error}</Typography.Text>
          }
        />
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message={t('sandboxInst.aboutTitle')}
        description={
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li>
              <strong>{t('sandboxInst.aboutUpstreamStrong')}</strong>
              {t('sandboxInst.aboutUpstreamMid')}
              <code>ROUTER_UPSTREAMS</code>
              {t('sandboxInst.aboutUpstreamMid2')}
            </li>
            <li>
              <strong>{t('sandboxInst.aboutLoadStrong')}</strong>
              {t('sandboxInst.aboutLoadMid')}
              {data === undefined
                ? `2× ${t('sandboxInst.colHeartbeat')}`
                : `${String(Math.round(data.loadStaleMs / 1000))}s`}
              {t('sandboxInst.aboutLoadTail')}
            </li>
            <li>
              <strong>{t('sandboxInst.aboutHeartbeatStrong')}</strong>
              {t('sandboxInst.aboutHeartbeatMid')}
            </li>
            <li>
              <strong>{t('sandboxInst.aboutDrainStrong')}</strong>
              {t('sandboxInst.aboutDrainMid')}
              <strong>{t('sandboxInst.aboutDrainStrong2')}</strong>
              {t('sandboxInst.aboutDrainMid2')}
              <strong>{t('sandboxInst.aboutDrainStrong3')}</strong>
              {t('sandboxInst.aboutDrainMid3')}
              <strong>{t('sandboxInst.aboutDrainStrong4')}</strong>
              {t('sandboxInst.aboutDrainTail')}
            </li>
            <li>
              {t('sandboxInst.rolePrefix')}
              <strong>{data?.role === 'router' ? t('sandboxInst.roleRouter') : t('sandboxInst.roleHost')}</strong>
              {backendInstanceId == null ? '' : t('sandboxInst.roleSelfMid') + backendInstanceId}。
            </li>
          </ul>
        }
      />

      <section className="card">
        {query.isPending ? (
          <div style={{ padding: 'var(--sp-4)' }}>
            <TableSkeleton rows={3} />
          </div>
        ) : query.isError ? (
          <div style={{ padding: 'var(--sp-4)' }}>
            <ErrorState title={t('sandboxInst.listLoadFailed')} error={query.error} retrying={query.isFetching} onRetry={refresh} />
          </div>
        ) : data !== undefined && data.items.length === 0 ? (
          <div style={{ padding: 'var(--sp-4)' }}>
            <EmptyState title={t('sandboxInst.emptyTitle')} lead={t('sandboxInst.emptyLead')} />
          </div>
        ) : (
          <Table<SandboxInstanceItem>
            rowKey="instanceId"
            size="middle"
            columns={columnsFor({
              now,
              loadStaleMs: data?.loadStaleMs ?? 60_000,
              // ★ 钉住首屏那台后端（不是每次轮询的作答者）；读不到时退回列表接口的值（至少不是空的）
              selfInstanceId: backendInstanceId ?? data?.selfInstanceId ?? null,
              discovered: data?.discovered ?? [],
              t,
              locale,
            })}
            dataSource={data?.items ?? []}
            loading={false}
            pagination={false}
            expandable={{
              expandedRowKeys: [...expandedKeys],
              onExpandedRowsChange: (keys) => setExpandedKeys(keys.map((key) => String(key))),
              onExpand: (expanded, item) => {
                if (expanded) toggleRow(item.instanceId)
                else setExpandedKeys((prev) => prev.filter((key) => key !== item.instanceId))
              },
              expandedRowRender: (item) => <NodeDetail instanceId={item.instanceId} />,
              rowExpandable: (item) => item.readiness !== null,
            }}
            scroll={{ x: 1100 }}
          />
        )}
      </section>

      {data !== undefined && data.upstreams.length > 0 && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 'var(--sp-4)' }}>
          {t('sandboxInst.upstreamsPrefix')}
          {data.upstreams.join(t('mcp.listSeparator'))}
        </Typography.Paragraph>
      )}
    </>
  )
}


/**
 * 摘流 / 恢复按钮（2026-10-21 用户反馈"页面上没有按钮"）。
 *
 * 为什么需要**确认框**：摘流是"静默生效"的运维动作 —— 点完当前页面不会有任何明显变化
 * （它只影响**下一条**新会话落到哪），误触的代价是"新会话全挤到另外几台"。确认框里把
 * "会 / 不会发生什么"写清楚（文案在 `sandboxInstanceModel.ts#drainActionView`，与按钮同源）。
 */
function DrainButton({ item }: { item: SandboxInstanceItem }) {
  const { t, locale } = useT()
  const mutation = useSetSandboxDrained()
  const view = drainActionView(item, locale)
  const confirmDrain = (): void => {
    Modal.confirm({
      title: view.confirmTitle,
      content: view.confirmBody,
      okText: view.drained ? t('sandboxInst.action.resumeLabel') : t('sandboxInst.action.drainLabel'),
      okButtonProps: view.drained ? {} : { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => mutation.mutateAsync({ instanceId: item.instanceId, drained: !view.drained }),
    })
  }
  return (
    <>
      <Button
        size="small"
        // 已摘流用实心（"需要你处理"），未摘流是普通按钮（运维动作，不该显眼到误触）
        type={view.drained ? 'primary' : 'default'}
        danger={!view.drained}
        loading={mutation.isPending}
        onClick={confirmDrain}
        data-testid={`drain-${item.instanceId}`}
      >
        {view.actionLabel}
      </Button>
      {mutation.isError && (
        <Tooltip title={mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}>
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {t('sandboxInst.failed')}
          </Typography.Text>
        </Tooltip>
      )}
    </>
  )
}

/**
 * 实例管理（P1-14 部署优化；2026-10-19 用户定稿 · 2026-10-20 进度任务化）：
 *   · 表格里**每台实例一行**，「详情」展开该实例的自检（平台 / 就绪项 / 缺什么）；
 *   · 行内「一键初始化」→ 后端带签名把那台的初始化转发过去执行（本机则本地执行）；
 *   · **未就绪 = 可见但不可选**（`readiness.ready=false` 的行标「未就绪」，会话里置灰）。
 *   · ★ 初始化是**任务**：点完立刻返回，进度由实例上的快照承载 ⇒ 切页 / 换实例回来照样看得见
 *     （`useNodeBootstrapJob` 用 `jobId=null` 问"这台当前的任务"，不需要记住任何本地状态）。
 */
function NodeDetail({ instanceId }: { instanceId: string }) {
  const { t, locale } = useT()
  const queryClient = useQueryClient()
  const report = useNodeSelf(instanceId)
  const start = useStartBootstrapJob()
  /** `null` ⇒ 问后端"这台当前 / 最近一次任务"（切页回来时靠它接上进度） */
  const [jobId, setJobId] = useState<string | null>(null)
  /**
   * 只有**展开着的行**才轮询：没展开的实例不必每 1.5s 打一次后端。
   * （组件只在展开时被 antd 挂载，所以这里恒为 true；保留参数是为了将来多实例并排展示。）
   */
  const jobQuery = useNodeBootstrapJob(instanceId, jobId, { enabled: true })
  const job = jobQuery.data ?? undefined
  const running = job?.status === 'running'
  /** 上次自检完成的时刻（本地）：用于给"重新自检"一个可见的反馈 */
  const [checkedAt, setCheckedAt] = useState<number | null>(null)

  useEffect(() => {
    if (report.data !== undefined && !report.isFetching) setCheckedAt(Date.now())
  }, [report.data, report.isFetching])

  /** 任务一结束就刷新自检与实例列表（就绪状态变了，表格里的「未就绪」标签要跟着变） */
  useEffect(() => {
    if (job === undefined || job.status === 'running') return
    void report.refetch()
    void queryClient.invalidateQueries({ queryKey: SANDBOX_INSTANCES_QUERY_KEY })
  }, [job?.jobId, job?.status])

  const refreshing = report.isFetching

  return (
    <div data-testid={`node-detail-${instanceId}`} style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
      <Space size={8} style={{ marginBottom: 8 }} wrap>
        <Tooltip
          title={
            report.data === undefined
              ? t('sandboxInst.initFirstCheck')
              : report.data.ready
                ? t('sandboxInst.initAllReady')
                : t('sandboxInst.initOnlyMissing', {
                    items: report.data.items
                      .filter((item) => item.required && !item.ok)
                      .map((item) => item.label)
                      .join(t('mcp.listSeparator')),
                  })
          }
        >
          <Button
            size="small"
            type="primary"
            loading={start.isPending}
            // ★ 全部健康 ⇒ 禁用（2026-10-19 用户反馈：避免误触；初始化只修坏项）
            // ★ 正在跑 ⇒ 也禁用（重复点不会叠跑，后端会返回同一个任务，这里只是别让用户以为点两次更快）
            disabled={report.data === undefined || report.data.ready || running}
            onClick={() =>
              start.mutate(instanceId, {
                onSuccess: (started) => setJobId(started.job.jobId),
              })
            }
          >
            {running ? t('sandboxInst.initRunning') : t('sandboxInst.initOneClick')}
          </Button>
        </Tooltip>
        <Button
          size="small"
          loading={refreshing}
          icon={refreshing ? undefined : <ReloadOutlined />}
          onClick={() => {
            void report.refetch()
          }}
        >
          {refreshing ? t('sandboxInst.rechecking') : t('sandboxInst.recheck')}
        </Button>
        {checkedAt !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="node-checked-at">
            {t('sandboxInst.lastCheck', { time: new Date(checkedAt).toLocaleTimeString(localeTag(locale)) })}
          </Typography.Text>
        )}
        {report.data !== undefined && (
          <>
            <Tag>
              {t('sandboxInst.roleTag', {
                role: report.data.role === 'taskAgent' ? t('sandboxInst.roleTaskAgent') : t('sandboxInst.roleChatOnly'),
              })}
            </Tag>
            <Tag>
              {t('sandboxInst.hostPlatform', { platform: report.data.hostPlatform || t('sandboxInst.unknown') })}
            </Tag>
            {report.data.needsRelay && <Tag color="orange">{t('sandboxInst.needsRelay')}</Tag>}
            <Tag color={report.data.ready ? 'green' : 'orange'}>
              {report.data.ready ? t('sandboxInst.readyOrNot') : t('sandboxInst.notReady')}
            </Tag>
          </>
        )}
      </Space>

      {/* 初始化进度：执行中 = 步骤动效 + 详情；结束后 = 保留结论（回看用） */}
      {job !== undefined ? (
        <div style={{ marginBottom: 8 }}>
          <NodeBootstrapProgressPanel job={job} />
        </div>
      ) : null}

      {start.isError ? (
        <Alert
          style={{ marginTop: 8 }}
          type="error"
          showIcon
          message={t('sandboxInst.startInitFailed')}
          description={String(start.error)}
        />
      ) : null}

      {report.isPending ? (
        <TableSkeleton rows={2} />
      ) : report.isError ? (
        <ErrorState
          title={t('sandboxInst.recheckFailed')}
          error={report.error}
          retrying={report.isFetching}
          onRetry={() => void report.refetch()}
        />
      ) : refreshing ? (
        // 已有数据时刷新：**不闪白**，在旧结果上盖一层淡化的"正在重新自检"（用户能立刻看到动效）
        <Spin spinning tip={t('sandboxInst.recheckingSpin')}>
          <div style={{ opacity: 0.55 }}>
            <ItemList items={report.data.items} />
          </div>
        </Spin>
      ) : (
        <ItemList items={report.data.items} />
      )}
    </div>
  )
}

function ItemList({ items }: { items: readonly NodeCheckItem[] }) {
  const { t } = useT()
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((item) => (
        <li key={item.key}>
          <Typography.Text type={item.ok ? undefined : item.required ? 'danger' : 'warning'}>
            {item.ok ? '✅' : item.required ? '❌' : '⚠️'} {item.label}
          </Typography.Text>
          <Typography.Text type="secondary">
            {' '}
            — {item.detail}
            {item.required ? '' : t('sandboxInst.optional')}
          </Typography.Text>
        </li>
      ))}
    </ul>
  )
}
