/**
 * 沙箱模块出口（P0-3-2 建，P0-3-3 补网络与 listener）
 *
 * 依据：`docs/02-后端设计.md` §七（TaskAgent 编排）+ §4.8（任务与产物）+ `docs/06-实施计划.md` §五 P0-3-2/P0-3-3
 *
 * 谁从这里拿什么（**刻意只导出这几组**，不写 `export *`：模块内部的零件 ——
 * `createSlotRegistry` / `buildSandboxContainerSpec` / dockerode 薄封装 —— 不该被业务层摸到，
 * 否则"谁能建容器"这件事就会散成好几处，而**只有 `ensureSandbox` 才知道排队与名额的规则**）：
 *
 * | 调用方 | 拿什么 |
 * |--------|--------|
 * | `index.ts`（进程入口） | `reconcileOnBoot` / `startSandboxReaper` / `stopSandboxReaper` / `getSandboxStats` / `startSandboxListener` / `stopSandboxListener` |
 * | P0-3-5/6 的编排层 | `ensureSandbox`（拿沙箱）/ `touchSandbox`（引擎事件刷活跃）/ `recycleSandbox` |
 * | P0-3-8 的停止路径 | `recycleSandbox` |
 * | 日志 / 将来的 `GET /api/tasks` | `getSandboxStats` / `getSandboxReaperStats` / `getSandboxListenerStats` / `sandboxQueueDepth` |
 */

// 生命周期（拿、收、刷活跃、观测）
export {
  ensureSandbox,
  getSandboxStats,
  recycleSandbox,
  touchSandbox,
  type AcquireSandboxOptions,
  type SandboxAcquireFailure,
  type SandboxAcquireResult,
  type SandboxHandle,
  type SandboxStats,
} from './manager.js'

// 对账（启动对账 + 周期回收 + 空闲回收 + work 卷体量巡检），由进程入口驱动
export {
  auditWorkVolumes,
  getSandboxReaperStats,
  reapIdleSandboxes,
  reapOrphans,
  reconcileOnBoot,
  startSandboxReaper,
  stopSandboxReaper,
  type ReapReport,
  type ReaperStats,
  type ReconcileReport,
  type WorkVolumeAudit,
} from './reaper.js'

// 沙箱网络（专用 internal bridge；`ensureSandbox` 内部也用它，这里导出是为了诊断与验收）
export {
  describeSandboxNetwork,
  ensureSandboxNetwork,
  SANDBOX_NETWORK_NAME,
  SANDBOX_NETWORK_ROLE,
  SANDBOX_NETWORK_SUBNET,
  type SandboxNetwork,
} from './network.js'

// 出口② 的 listener（独立 Fastify 实例；**端点本体属 P0-3-9b**）
export {
  getSandboxListenerStats,
  startSandboxListener,
  stopSandboxListener,
  type SandboxListenerStats,
} from './listener.js'

// 排队（位次可观测；编排层把位次变成 `queued` 事件）
export { sandboxQueueDepth, sandboxQueueKey, sandboxQueuePosition } from './queue.js'

// 名字与标签契约（纯函数；"哪些容器是我们的"**只**由它们回答）
export {
  SANDBOX_LABEL_CONVERSATION,
  SANDBOX_LABEL_ROLE,
  SANDBOX_LABEL_STARTED_AT,
  SANDBOX_ROLE,
  SANDBOX_WORK_DIR,
  WORK_VOLUME_PREFIX,
  readSandboxLabels,
  workVolumeName,
} from './spec.js'
