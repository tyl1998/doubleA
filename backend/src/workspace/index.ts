/**
 * 工作区模块出口（P1-9 · P0 建）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §二（三层职责）、§十四（接回点）。
 *
 * 谁从这里拿什么（**刻意只导出这几组**，不写 `export *`）：
 *
 * | 调用方 | 拿什么 |
 * |--------|--------|
 * | P1 的路由层（`routes/workspace.ts`） | `ensureWorkspace` / `listWorkspaceFiles` / `readWorkspaceFile` / `writeWorkspaceFile` / `createWorkspaceFile` / `deleteWorkspaceFile` / `deleteWorkspaceDirectory` / `moveWorkspaceFile` |
 * | P3 的 SSE | `subscribeWorkspaceEvents`（实时通道） |
 * | 进程入口（`index.ts`） | `stopAllWorkspaceWatchers`（退出） |
 * | 编排层（P0 起，派活前后） | `ensureWorkspace` / `reconcileWorkspaceOnce`（bash 兜底对账） |
 * | 沙箱存储（`sandbox/spec.ts`·`manager.ts`） | `workspaceDirOf`（bind mount 的源目录） |
 * | 诊断 / 纯函数核对 | `resolveWorkspacePath` / `assertRealPathInside` / `scanWorkspaceFiles` / `sha256` / 各常量 |
 */

// 服务：懒创建 + 文件树 + 读 / 写（CAS）/ 建 / 删 / 移
export {
  assertWorkspaceOwner,
  createWorkspaceFile,
  deleteWorkspaceDirectory,
  deleteWorkspaceFile,
  ensureWorkspace,
  getWorkspaceFileDiff,
  listWorkspaceChanges,
  listWorkspaceEventsAfter,
  listWorkspaceFiles,
  moveWorkspaceFile,
  openWorkspaceFileSource,
  readWorkspaceDirectoryZip,
  readWorkspaceFile,
  revertWorkspaceRound,
  sha256,
  softDeleteIndexedFile,
  syncFileFromDisk,
  uploadWorkspaceFile,
  writeWorkspaceFile,
  WORKSPACE_EVENT_REPLAY_MAX,
  type WorkspaceFileSource,
  type WorkspaceHandle,
  type WorkspaceWriteActor,
} from './service.js'

// 路径判据（纯函数 + 只读 FS 探测）
export {
  assertRealPathInside,
  resolveWorkspacePath,
  workspaceDirOf,
  WORKSPACE_BACKUP_DEBOUNCE_MS,
  WORKSPACE_EVENT_DEBOUNCE_MS,
  type ResolvedWorkspacePath,
} from './paths.js'

// git 概况（`GET .../workspace/git` 用）：只读 `<gitdir>/HEAD`，不调 git 二进制。
// 纯解析两枚 + 收根目录参数的扫描一枚一并导出 —— 回归里逐条喂字面量 / 造临时目录核对，不必依赖配置。
export {
  parseGitDirFile,
  parseGitHead,
  readWorkspaceGitRepos,
  readWorkspaceRetention,
  scanGitReposUnder,
} from './git.js'

// 字节层（宿主 FS）
export {
  alignAgentOwnership,
  ensureWorkspaceDir,
  removeWorkspaceDir,
  scanWorkspaceFiles,
  scanWorkspaceTree,
  workspaceContentIsBinary,
  workspaceDirIsEmpty,
  workspaceIsDirectory,
  WORKSPACE_TMP_PREFIX,
  type WorkspaceScanEntry,
  type WorkspaceScanResult,
} from './store.js'

// 文件夹递归删除判据（目录删除；零 config / DB / FS，可在自证脚本里逐条核对）
export { isWorkspacePathInDir, selectWorkspaceDirPaths, workspaceDirPrefix } from './dirModel.js'

// 依赖目录判据（P1-17b；零 config / DB / FS，可在自证脚本里逐条核对）
export {
  isWorkspaceDependencyDirName,
  isWorkspaceDependencyPath,
  WORKSPACE_DEPENDENCY_DIRS,
} from './dependencyModel.js'

// 事件总线（实时订阅 + 落库）
export {
  emitWorkspaceEvent,
  publishWorkspaceEventItem,
  resetWorkspaceEventBus,
  subscribeWorkspaceEvents,
  toWorkspaceEventItem,
  workspaceEventCreateData,
  workspaceEventSubscriberCount,
  type WorkspaceEventInput,
} from './events.js'

// 主动感知（P1-9 · P4 · R1）：USER 写事件 → 给运行中 agent 的插话文案（纯函数）
export { workspaceEditSteerMessage } from './steerMessage.js'

// watcher（bash 兜底 / 宿主改动的对账）
export {
  isWatchingWorkspace,
  reconcileWorkspaceOnce,
  startWorkspaceWatcher,
  stopAllWorkspaceWatchers,
  stopWorkspaceWatcher,
  WORKSPACE_WATCH_POLL_MS,
  workspaceWatcherCount,
  type WorkspaceReconcileReport,
} from './watcher.js'

// reaper（P1-9 · P0 孤儿清理；P5 · R5 补保留期清理 + 周期任务）
// ｜ 进程入口 | `reapOrphanWorkspaceDirs` / `reapExpiredWorkspaceDirs` / `startWorkspaceReaper` / `stopWorkspaceReaper`
export {
  reapExpiredWorkspaceDirs,
  reapOrphanWorkspaceDirs,
  startWorkspaceReaper,
  stopWorkspaceReaper,
  WORKSPACE_REAP_INTERVAL_MS,
  WORKSPACE_REAP_MAX_PER_TICK,
  type WorkspaceReapReport,
  type WorkspaceRetentionReport,
} from './reaper.js'

// 保留期判据（P5 · R5 纯函数）：截止时刻 + 是否过期（零 config / DB / FS，可在自证脚本里逐条核对）
export { isWorkspaceExpired, workspaceRetentionCutoff } from './reapModel.js'

// 硬化纯判据（P6 · R6；零 config / DB / FS，可在自证脚本里逐条核对）：
// 二进制嗅探 + 配额/类型闸门判定 + 写入限流窗口/超限判定
export {
  decideWorkspaceQuota,
  isWorkspaceWriteRateExceeded,
  looksBinaryWorkspaceContent,
  workspaceWriteRateWindowStart,
  WORKSPACE_BINARY_SAMPLE_BYTES,
  WORKSPACE_QUOTA_VIOLATIONS,
  WORKSPACE_WRITE_RATE_WINDOW_MS,
  type WorkspaceQuotaDecision,
  type WorkspaceQuotaLimits,
  type WorkspaceQuotaSnapshot,
  type WorkspaceQuotaViolation,
} from './quotaModel.js'

// 写入限流（P6 · R6；唯一 I/O 在 Redis）：内容写入口调用，超限抛 `BUSY`
export { assertWorkspaceWriteRate } from './rateLimit.js'

// 文件级软锁（claim，P2）：登记 / 释放 / 列举 / 清理
export {
  claimWorkspaceFile,
  listWorkspaceClaims,
  pruneExpiredWorkspaceClaims,
  releaseWorkspaceFile,
  type ClaimWorkspaceFileInput,
  type WorkspaceClaimInfo,
} from './claims.js'

// 编辑的纯替换逻辑（P2；`edit` 工具与三方合并共用）
export { applyWorkspaceEdit, type ApplyWorkspaceEditResult } from './edit.js'

// SSE 帧序列化（P3；前端订阅 `/workspace/events`）
export { serializeWorkspaceSseEvent, WORKSPACE_SSE_EVENT_NAME } from './sse.js'

// 轮次标记（P4 · R2）：TaskAgent 一轮起止时记录窗口，「撤销本轮」据此
export {
  readWorkspaceRoundWindow,
  recordWorkspaceRoundEnd,
  recordWorkspaceRoundStart,
  type WorkspaceRoundWindow,
} from './round.js'

// zip 编码（2026-10-29，「按目录下载」）：stored 条目、零依赖；纯函数可逐字节核对
// ｜ 工作区服务（`readWorkspaceDirectoryZip`）与路由层消费
export { buildZip, crc32, zipEntryName, ZIP_MAX_BYTES, type ZipEntry } from './zip.js'

// 历史字节（P4 · R2）：内容寻址的本地 blob 存储（撤销本轮据此还原）
export {
  putWorkspaceBlob,
  readWorkspaceBlob,
  workspaceBlobDirOf,
  workspaceBlobExists,
  WORKSPACE_BLOB_DIR,
} from './blob.js'

// S3 冷备与恢复（P5 · R3）：内容寻址上行 + 换机/重建还原 + 孤儿对象清理
// ｜ 工作区服务（写后异步冷备 / 空目录恢复） | `service.ts` 内部消费（本组主要供进程入口与诊断）
export {
  backupWorkspaceBlob,
  deleteWorkspaceColdBlobs,
  dropPendingWorkspaceBackups,
  flushWorkspaceColdBackups,
  restoreWorkspaceFromCold,
  scheduleWorkspaceBlobBackup,
  type WorkspaceColdDeleteReport,
  type WorkspaceRestoreReport,
} from './cold.js'

// 冷备纯判据（P5 · R3）：S3 键命名 + 恢复计划（零 config/S3 依赖，可在自证脚本里逐条核对）
export {
  planWorkspaceRestore,
  workspaceColdKey,
  workspaceColdPrefix,
  WORKSPACE_COLD_ROOT,
  type WorkspaceRestorePlan,
  type WorkspaceRestorePlanItem,
  type WorkspaceRestoreRow,
} from './coldModel.js'

// 沙箱代理端点（P2）：容器内 pi 扩展 → 后端。⚠️ 只由 `sandbox/listener.ts` 挂载
export { registerWorkspaceProxyRoutes, type WorkspaceProxyResult } from './proxy.js'