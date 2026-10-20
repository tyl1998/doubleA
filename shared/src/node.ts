/**
 * 节点自检 / 自举契约（P1-14 部署优化；2026-10-19 用户定案）。
 *
 * 后端实现：`backend/src/sandbox/nodeBootstrap.ts`（放在后端进程内，驱动本机 Docker）。
 * 前端消费：`/admin/sandbox-instances` 页的「本节点」卡片。
 *
 * ⚠️ 这两个类型刻意**不放进 `routerInstance.ts`**：那是网关与后端共享的注册值契约（只放标量），
 *    而这里是页面用的丰富结构，不需要进心跳。
 */

/** 节点档位：只做对话 / 承担沙箱宿主 */
export const NODE_ROLES = ['chatbot', 'taskAgent'] as const
export type NodeRoleName = (typeof NODE_ROLES)[number]

/** 自检项（`key` 稳定，前端据此做图标与排序） */
export type NodeCheckKey =
  | 'docker'
  | 'sandboxNetwork'
  | 'egress'
  | 'egressReachable'
  | 'relay'
  | 'buildContext'
  | 'toolkitImage'
  | 'runtimeImages'
  | 'workspaceRoot'

export interface NodeCheckItem {
  key: NodeCheckKey
  label: string
  /** 该平台是否需要这一项（`false` ⇒ 显示"不需要"，不计入就绪） */
  required: boolean
  ok: boolean
  detail: string
}

export interface NodeReport {
  instanceId: string
  role: NodeRoleName
  /** 容器内看到的平台 */
  platform: string
  /** 宿主平台（`darwin` / `linux` / `darwin-or-windows-vm`） */
  hostPlatform: string
  /** macOS/Windows 上 Docker 在 VM 里 ⇒ 需要 relay */
  needsRelay: boolean
  /** 所有**必需**项都 ok */
  ready: boolean
  items: NodeCheckItem[]
  checkedAt: number
}

export interface NodeBootstrapStep {
  step: string
  ok: boolean
  detail: string
  /** `true` = 该项本来就健康，本次未执行（一键初始化**只修坏的那几项**） */
  skipped?: boolean
}

export interface NodeBootstrapResult {
  instanceId: string
  ok: boolean
  steps: NodeBootstrapStep[]
  report: NodeReport
}

// ═════════════════════════ 初始化任务（进度可回看） ═════════════════════════

/**
 * 步骤状态：`pending` 已排队未开始 / `running` 执行中 / `ok` 成功 / `failed` 失败 / `skipped` 本来就健康（未执行）。
 *
 * 为什么把"进度"做成**任务快照**而不是前端假进度条（2026-10-20 用户反馈）：
 *   · 一键初始化可能跑几分钟（拉镜像 / 建镜像），切页再回来必须还能看到它跑到哪一步；
 *   · 前端凭 `Promise` 的 pending 状态只能画"假装在动"的条，**看不到真实的步骤**。
 * 任务记在**目标实例的 Redis**（`nodeJobs.ts`），任何页面/任何实例都能轮询同一个快照。
 */
export const NODE_BOOTSTRAP_STEP_STATES = ['pending', 'running', 'ok', 'failed', 'skipped'] as const
export type NodeBootstrapStepState = (typeof NODE_BOOTSTRAP_STEP_STATES)[number]

export const NODE_BOOTSTRAP_STATUSES = ['running', 'succeeded', 'failed'] as const
export type NodeBootstrapStatus = (typeof NODE_BOOTSTRAP_STATUSES)[number]

/** 任务里的一行步骤（与 {@link NodeBootstrapStep} 同名同口径，多了状态与耗时） */
export interface NodeBootstrapTaskStep {
  /** 稳定键（`docker` / `sandboxNetwork` / `egress` …）；前端据此排序与做图标，**不展示** */
  key: string
  /** 面向运维的步骤名（如「出口代理 doubulea-egress」） */
  label: string
  state: NodeBootstrapStepState
  /** 结果 / 失败原因的说明（`pending` 时是"将执行什么"的预告） */
  detail: string
  startedAt?: number
  finishedAt?: number
  /** 本次为修复它而做的动作（逐条追加，如 `docker pull …`）—— 长步骤能看出它卡在哪 */
  events: string[]
}

/**
 * 一键初始化的任务快照（`GET /api/admin/node/bootstrap/jobs/:instanceId/:jobId`）。
 *
 * ⚠️ `status=running` 只表示**后端进程还认为它在跑**；心跳（`updatedAt`）超过租期 ⇒ 服务端会把它
 *    改判为 `failed`（进程重启 / 容器被杀），因此前端永远不必自己超时。
 */
export interface NodeBootstrapJob {
  jobId: string
  instanceId: string
  status: NodeBootstrapStatus
  /** 0–100：**按步骤数**算（`pending`/`running` 各算半格），不是假缓动 */
  percent: number
  /** 已完成的步骤数（`ok` / `failed` / `skipped`） */
  completed: number
  total: number
  steps: NodeBootstrapTaskStep[]
  startedAt: number
  updatedAt: number
  finishedAt?: number
  ok?: boolean
  error?: string
  /** 结束后的自检（与 `POST …/bootstrap` 的 `report` 同口径） */
  report?: NodeReport
}
