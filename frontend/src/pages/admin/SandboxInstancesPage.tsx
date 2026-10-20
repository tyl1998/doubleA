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

import { Alert, Button, Space, Spin, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ReloadOutlined } from '@ant-design/icons'
import type { NodeCheckItem, SandboxInstanceItem } from '@doubulea/shared'

import { fetchCurrentUser } from '../../api/auth.js'
import { useNodeBootstrapJob, useNodeSelf, useStartBootstrapJob } from '../../api/node.js'
import { SANDBOX_INSTANCES_QUERY_KEY, useSandboxInstances } from '../../api/sandboxInstances.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { NodeBootstrapProgressPanel } from './NodeBootstrapProgress.js'
import {
  heartbeatText,
  loadAgeText,
  SANDBOX_INSTANCE_STATE_LABELS,
  sandboxInstanceState,
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
}): TableColumnsType<SandboxInstanceItem> {
  return [
    {
      title: '实例',
      dataIndex: 'instanceId',
      render: (_, item) => (
        <Space size={6}>
          <span className="kb-cell__name">{item.instanceId}</span>
          {item.instanceId === args.selfInstanceId && <Tag color="blue">本机</Tag>}
          {args.discovered.includes(item.advertiseAddr) && <Tag>自动发现</Tag>}
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 110,
      render: (_, item) => {
        const view = sandboxInstanceState(item, { now: args.now, loadStaleMs: args.loadStaleMs })
        return <Tag color={STATE_COLOR[view.state]}>{SANDBOX_INSTANCE_STATE_LABELS[view.state]}</Tag>
      },
    },
    {
      title: '节点就绪',
      key: 'readiness',
      width: 150,
      render: (_, item) =>
        item.readiness === null ? (
          <Typography.Text type="secondary">未知（未上报）</Typography.Text>
        ) : item.readiness.ready ? (
          <Tag color="green">就绪</Tag>
        ) : (
          <Tooltip title={`未就绪：${item.readiness.missing.join('、')}（该实例不会出现在会话的实例选择里）`}>
            <Tag color="orange">未就绪 · {item.readiness.missing.length} 项</Tag>
          </Tooltip>
        ),
    },
    { title: '回连地址', dataIndex: 'advertiseAddr', width: 190 },
    {
      title: '管理',
      key: 'manage',
      width: 110,
      render: (_, item) =>
        // 展开行里有「一键初始化 / 重新自检」；这里给一个直达入口（展开由 antd 的 expandable 负责）
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {item.readiness === null ? '展开查看' : item.readiness.ready ? '展开查看' : '展开后初始化（仅修坏项）'}
        </Typography.Text>,
    },
    {
      title: '沙箱槽位',
      key: 'slots',
      width: 140,
      align: 'right',
      render: (_, item) => <span className="ratio">{slotRatioText(item)}</span>,
    },
    {
      title: '排队',
      key: 'queueDepth',
      width: 80,
      align: 'right',
      render: (_, item) => <span className="num">{item.load?.queueDepth ?? '—'}</span>,
    },
    {
      title: 'ChatBot 在飞',
      key: 'chatbotInFlight',
      width: 120,
      align: 'right',
      render: (_, item) => <span className="num">{item.load?.chatbotInFlight ?? '—'}</span>,
    },
    {
      title: '负载年龄',
      key: 'loadAge',
      width: 100,
      align: 'right',
      render: (_, item) => (
        <span
          className="ratio"
          title="负载是秒级软状态：心跳采样时刻到现在的秒数；超过新鲜度阈值即判「负载过期」"
        >
          {loadAgeText(sandboxInstanceState(item, { now: args.now, loadStaleMs: args.loadStaleMs }).loadAgeMs)}
        </span>
      ),
    },
    {
      title: '心跳',
      key: 'heartbeat',
      width: 120,
      render: (_, item) => <span className="ratio">{heartbeatText(item)}</span>,
    },
    {
      title: '宿主 / pid',
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
          <h1>沙箱实例</h1>
          <p className="page__lead">
            读实例在线注册表 <code>sandbox:instance:*</code>（各实例心跳写入，TTL = 3× 心跳）——
            与路由网关的自动发现<strong>同源同判据</strong>。这里是只读视图，上下线由实例自身决定。
          </p>
        </div>
        <Button onClick={refresh} loading={query.isFetching}>
          刷新
        </Button>
      </div>

      {data?.error != null && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message="读注册表失败（不是「零台实例」）"
          description={
            <Typography.Text code>{data.error}</Typography.Text>
          }
        />
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message="关于读数"
        description={
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li>
              <strong>上游表</strong> = 静态 <code>ROUTER_UPSTREAMS</code> 种子 ∪ 自动发现的实例；标记「自动发现」的不在静态种子里。
            </li>
            <li>
              <strong>负载</strong>来自心跳采样（槽位占用 / 排队深度 / ChatBot 在飞）。超过新鲜度阈值（
              {data === undefined ? '2× 心跳' : `${Math.round(data.loadStaleMs / 1000)}s`}
              ）记「负载过期」—— 网关此时退回轮询，不会拿旧数据做 P2C。
            </li>
            <li>
              <strong>心跳超时</strong>：注册项已超过 TTL，网关通常已经看不见它；本节点的出现说明该实例正在停止或被 Redis 侧残留。
            </li>
            <li>
              当前进程角色：<strong>{data?.role === 'router' ? '网关（不登记实例）' : '沙箱宿主'}</strong>
              {backendInstanceId == null ? '' : `，本机（打开本页时的后端）= ${backendInstanceId}`}。
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
            <ErrorState title="实例列表加载失败" error={query.error} retrying={query.isFetching} onRetry={refresh} />
          </div>
        ) : data !== undefined && data.items.length === 0 ? (
          <div style={{ padding: 'var(--sp-4)' }}>
            <EmptyState
              title="注册表里没有实例"
              lead="单机形态下后端也会登记自己；这里为空通常意味着心跳被关掉（SANDBOX_INSTANCE_HEARTBEAT_SEC=0）或 Redis 里没有 sandbox:instance:* 键。"
            />
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
          上游表：{data.upstreams.join('、')}
        </Typography.Paragraph>
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
              ? '先完成自检'
              : report.data.ready
                ? '该实例全部必需项都正常，无需初始化（只在自检失败时可点，避免误触）'
                : `只修复未就绪的项：${report.data.items
                    .filter((item) => item.required && !item.ok)
                    .map((item) => item.label)
                    .join('、')}`
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
            {running ? '初始化中…' : '一键初始化'}
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
          {refreshing ? '自检中…' : '重新自检'}
        </Button>
        {checkedAt !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="node-checked-at">
            上次自检：{new Date(checkedAt).toLocaleTimeString()}
          </Typography.Text>
        )}
        {report.data !== undefined && (
          <>
            <Tag>档位：{report.data.role === 'taskAgent' ? '沙箱宿主' : '仅对话'}</Tag>
            <Tag>宿主平台：{report.data.hostPlatform || '未知'}</Tag>
            {report.data.needsRelay && <Tag color="orange">需要 relay</Tag>}
            <Tag color={report.data.ready ? 'green' : 'orange'}>{report.data.ready ? '就绪' : '未就绪'}</Tag>
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
        <Alert style={{ marginTop: 8 }} type="error" showIcon message="启动初始化失败" description={String(start.error)} />
      ) : null}

      {report.isPending ? (
        <TableSkeleton rows={2} />
      ) : report.isError ? (
        <ErrorState title="自检失败" error={report.error} retrying={report.isFetching} onRetry={() => void report.refetch()} />
      ) : refreshing ? (
        // 已有数据时刷新：**不闪白**，在旧结果上盖一层淡化的"正在重新自检"（用户能立刻看到动效）
        <Spin spinning tip="正在重新自检…">
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
            {item.required ? '' : '（可选）'}
          </Typography.Text>
        </li>
      ))}
    </ul>
  )
}
