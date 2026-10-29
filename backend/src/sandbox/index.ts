/**
 * 沙箱模块出口（P0-3-2 建，P0-3-3 补网络与 listener，P0-3-4 补 LLM 注入，P0-3-5 补引擎桥，
 * P0-3-6 补事件映射，P0-3-7 补产物收集，P0-3-9b 补 MCP 代理，P0-3-12 补用量归集的 turn 边界）
 *
 * 依据：`docs/02-后端设计.md` §七（TaskAgent 编排）+ §4.8（任务与产物）+ `docs/06-实施计划.md` §五 P0-3-2/P0-3-3
 *
 * 谁从这里拿什么（**刻意只导出这几组**，不写 `export *`：模块内部的零件 ——
 * `createSlotRegistry` / `buildSandboxContainerSpec` / dockerode 薄封装 —— 不该被业务层摸到，
 * 否则"谁能建容器"这件事就会散成好几处，而**只有 `ensureSandbox` 才知道排队与名额的规则**）：
 *
 * | 调用方 | 拿什么 |
 * |--------|--------|
 * | `index.ts`（进程入口） | `reconcileOnBoot` / `startSandboxReaper` / `stopSandboxReaper` / `getSandboxStats` / `startSandboxListener` / `stopSandboxListener` / `closeAllSandboxRpcs`（退出时拆桥） |
 * | P0-3-6 的编排层 | `ensureSandbox`（拿沙箱）/ `getSandboxRpc`（拿引擎桥）/ `runTurn`（派活 + 等 `agent_settled`）/ `touchSandbox`（引擎事件刷活跃）/ **`createEngineEventMapper`**（引擎事件 → 我方 SSE 事件） |
 * | P0-3-7 的编排层（P1-9 · R4 起判据 = 工作区变更集） | `collectRoundArtifacts`（本轮变更集 → 传对象 → 建行，返回值即 `artifact` 事件 payload） |
 * | ✅ P0-3-9b 的编排层（`taskAgent.ts`） | `ensureSandboxMcpCatalog`（预热工具清单，反查 `serverId` 的唯一依据）+ `resolveSandboxMcpTool`（引擎工具名 → 这个工具是谁）+ `type SandboxMcpCatalog` |
 * | ✅ P0-3-9b 的 listener（`listener.ts`，**它直接 `import './proxy.js'`** —— 那条链要碰 SSE/Prisma，不该被人人都在 import 的本桶拖上） | `registerSandboxProxyRoutes` |
 * | ✅ 停止路径（`taskAgent.ts` 收尾调用） | `closeSandboxRpc`（只拆连接；**容器保留**，2026-10-29 口径变更 —— 用户停止不再回收，下一轮复用同一容器） |
 * | P0-3-5 的引擎桥 | `SANDBOX_PI_PROVIDER_ID` + `SANDBOX_LLM_ENV` / `piRpcArgv`（拼容器命令行）、`SANDBOX_WORK_DIR` |
 * | 日志 / 将来的 `GET /api/tasks` | `getSandboxStats` / `getSandboxReaperStats` / `getSandboxListenerStats` / `getSandboxRpcStats` / `sandboxQueueDepth` |
 * | 诊断 / 纯函数核对 | `piApiForProtocol` / `piBaseUrlFor` / `sandboxLlmEnv`（LLM 目标的拼装，P0-3-4）、`piRpcArgv` 与 `createJsonlDecoder`（P0-3-5）、`readEngineUsage` / `isKnownEngineEventType` / **`engineTurnBoundaryOf`**（事件映射与用量归集，P0-3-6 / P0-3-12） |
 */

// 生命周期（拿、收、刷活跃、观测）
export {
  ensureSandbox,
  getSandboxStats,
  recycleSandbox,
  touchSandbox,
  listLiveSandboxConversations,
  listLiveConversationsOfAgent,
  type AcquireSandboxOptions,
  type SandboxAcquireFailure,
  type SandboxAcquireResult,
  type SandboxHandle,
  type SandboxStats,
} from './manager.js'

// 节点自检/自举（P1-14 部署优化）：后端进程内检测本机能否当沙箱实例、并按平台补齐依赖
export {
  bootstrapNode,
  inspectNode,
  type NodeBootstrapResult,
  type NodeBootstrapStep,
  type NodeCheckItem,
  type NodeReport,
  type NodeRoleName,
} from './nodeBootstrap.js'

// LLM 注入（P0-3-4）：把 `agents.model_id` 解析成"要注入容器的那组环境变量"
export { resolveSandboxLlm, type SandboxLlmFailureCode, type SandboxLlmResult } from './llm.js'

// 引擎桥（P0-3-5）：`pi --mode rpc` 的 JSONL 通道（建 / 取 / 关 / 观测 + 协议形状）
export {
  closeAllSandboxRpcs,
  closeSandboxRpc,
  createSandboxRpc,
  getSandboxRpc,
  getSandboxRpcStats,
  openSandboxRpc,
  SandboxRpcError,
  type OpenSandboxRpcOptions,
  type PiRpcCommand,
  type PiRpcResponse,
  type PiSessionEvent,
  type RunTurnOptions,
  type SandboxRpc,
  type SandboxRpcFailureCode,
  type SandboxRpcStats,
  type TurnFailureReason,
  type TurnOutcome,
} from './bridge.js'

// JSONL 分帧（纯逻辑；单独导出是为了能**不连 Docker**地逐条核查"只认 LF"那几条）
export { createJsonlDecoder, JsonlRecordTooLargeError, PI_RPC_STDIO_MAX_BYTES, type JsonlDecoder } from './jsonl.js'

// 引擎事件映射（P0-3-6）：`map.ts` —— 「容器里的 pi 说了什么」→「我们往外发什么」
// ⚠️ 它唯一的运行期依赖是 `orchestrator/chatContext.ts` 的两个**纯函数**（摘要 / 截断），
//    不碰 DB / Redis / SSE 连接 / Docker ⇒ 可以喂一串事件、比结果地逐条核查（§六 3 的映射表）
export {
  createEngineEventMapper,
  engineTurnBoundaryOf,
  isKnownEngineEventType,
  readEngineUsage,
  TOOL_RESULT_NO_ERROR_DETAIL,
  TOOL_SUMMARY_MEMO_LIMIT,
  type EngineEventMapper,
  type EngineEventMapping,
  type EngineUsage,
} from './map.js'

// 产物收集（P0-3-7 建；P1-9 · R4 判据改为「产物 = 工作区变更集视图」）：
// 本轮工作区变更集 → 过滤 → 读宿主工作区字节 → 对象存储 → `artifacts` 行
// ｜ P0-3-6 的编排层 | `collectRoundArtifacts`（收尾：传对象 + 建行，返回值即 `artifact` 事件 payload）
// ｜ 「上传至平台」端点（`routes/workspace.ts`，2026-10-29） | `registerWorkspaceArtifact`（单个工作区文件 → 产物行）
// ｜ 进程入口（reaper 的那一轮） | `reapExpiredArtifacts`（保留期清理，挂在对账器 tick 里）
// 纯函数 `artifactMimeOf`（产物 MIME 名单）也导出，可**不连 S3** 地逐条核对。
export {
  artifactMimeOf,
  collectRoundArtifacts,
  registerWorkspaceArtifact,
  reapExpiredArtifacts,
  ARTIFACT_EXEC_TIMEOUT_MS,
} from './artifacts.js'

// 产物路径判据（P1-9 · R4，**纯函数**零 config/DB/Docker 依赖）：工作区变更集 → 可上传的产物路径
// ｜ 编排层/收产物 | `collectRoundArtifacts` 内部消费
// ｜ 诊断 / 纯函数核对 | `artifactChangePaths` / `filterArtifactPaths` / `ARTIFACT_EXCLUDED_DIRS`
export {
  artifactChangePaths,
  filterArtifactPaths,
  ARTIFACT_EXCLUDED_DIRS,
  type ArtifactPathFilterOptions,
} from './artifactChanges.js'

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

// 出口② 的 listener（独立 Fastify 实例；自 P0-3-9b 起它上面**真的挂着**两个 MCP 代理端点）
export {
  getSandboxListenerStats,
  startSandboxListener,
  stopSandboxListener,
  type SandboxListenerStats,
} from './listener.js'

// MCP 走后端代理（P0-3-9b）—— 端点本体 + 「每个容器一份」的工具清单
// ⚠️ **本组只有编排层用得到**（预热清单 + 反查）；listener 自己直接 `import './proxy.js'`
//    （那条链一路上碰 SSE / Prisma / MCP 客户端，不该被任何 `import` 本桶的人一起拖进来）。
// ⚠️ 端点**不在公网 listener 上**：它们由 `registerSandboxProxyRoutes` 挂到沙箱代理 listener
//    （`02` §4.10），这里导出只为让"这个 listener 上挂了什么"有一个可读的清单。
export {
  buildSandboxMcpCatalog,
  buildSandboxMcpCatalogPreview,
  ensureSandboxMcpCatalog,
  registerSandboxProxyRoutes,
  republishSandboxMcpCatalog,
} from './proxy.js'

// 别名映射的**纯函数与存取**（P0-3-9b）—— `alias ⇄ serverId` 这张表的唯一读法
// ｜ 编排层（`map.ts` 的反查、`taskAgent.ts` 注入 resolver） | `resolveSandboxMcpTool`
// ｜ 诊断 / 纯函数核对 | `registeredSandboxMcpToolName` / `sandboxMcpAliasAt` / `emptySandboxMcpCatalog`（可喂一张表、比结果）
// ⚠️ `writeSandboxMcpCatalog` / `clearSandboxMcpMap` **不在这里导出**：写入口只有 `proxy.ts`
//    （算清单）与回收路径（`manager.ts` 直接 `import './mcpMap.js'`）—— 放开写出口会造出
//    "另一处也能改这张表"的可能，而它的全部价值就是**唯一性**（§七 4）。
export {
  emptySandboxMcpCatalog,
  readSandboxMcpCatalog,
  registeredSandboxMcpToolName,
  resolveSandboxMcpTool,
  sandboxMcpAliasAt,
  SANDBOX_MCP_ALIAS_PREFIX,
  SANDBOX_MCP_DESCRIPTION_MAX,
  type SandboxMcpCatalog,
  type SandboxMcpServerRef,
  type SandboxMcpToolRef,
} from './mcpMap.js'

// 排队（位次可观测；编排层把位次变成 `queued` 事件）
export { sandboxQueueDepth, sandboxQueueKey, sandboxQueuePosition } from './queue.js'

// 多机归属（P1-14；P1-9 · R9 复用）：会话→实例目录 + 实例在线注册表 + 实例心跳
// ｜ 进程入口（`index.ts`） | `claimInstanceIdentity`（启动同名自检）/ `startInstanceHeartbeat` / `markInstanceStartupReady`（对账完成后再报就绪）/ `stopInstanceHeartbeat`
// ｜ 编排层（`manager.ts`） | `registerSandboxOwner` / `clearSandboxOwner`
// ｜ 工作区（`workspace/service.ts` / `routes/conversations.ts`） | `ensureWorkspaceOwner`（寿命跟随工作区）
// ｜ 诊断 / 纯函数核对 | `instanceAdvertiseAddr` / `workspaceOwnerTtlSec` / `instanceRegistrationTtlSec`
export {
  claimInstanceIdentity,
  clearSandboxOwner,
  ensureWorkspaceOwner,
  instanceAdvertiseAddr,
  instanceRegistrationTtlSec,
  isSandboxStartupReady,
  markInstanceStartupReady,
  readSandboxOwner,
  registerSandboxOwner,
  startInstanceHeartbeat,
  stopInstanceHeartbeat,
  workspaceOwnerTtlSec,
} from './owner.js'

// 沙箱角色（P1-14 · R1 部署编排）：网关与后端**同一个镜像** ⇒ 网关进程要能声明"我不是沙箱宿主"
// ｜ 进程入口（`index.ts`） | `applySandboxRoleOverride`（在第一次读 `config.sandbox.enabled` 之前）
// ｜ 诊断 / 纯函数核对 | `detectSandboxRole` / `SANDBOX_ROLES`
export {
  applySandboxRoleOverride,
  detectSandboxRole,
  SANDBOX_ROLES,
  type SandboxRole,
  type SandboxRoleDecision,
  type SandboxRoleOverride,
} from './roleOverride.js'

// 名字与标签契约（纯函数；"哪些容器是我们的"**只**由它们回答）
export {
  SANDBOX_LABEL_CONVERSATION,
  SANDBOX_LABEL_MODEL,
  SANDBOX_LABEL_ROLE,
  SANDBOX_LABEL_STARTED_AT,
  SANDBOX_ROLE,
  SANDBOX_WORK_DIR,
  WORK_VOLUME_PREFIX,
  readSandboxLabels,
  workVolumeName,
} from './spec.js'

// LLM 目标的拼装（纯函数，P0-3-4）—— 容器内 `gen-models.mjs` 读的就是 `SANDBOX_LLM_ENV` 这几个名字
export {
  piApiForProtocol,
  piBaseUrlFor,
  piRpcArgv,
  sandboxLlmEnv,
  SANDBOX_LLM_ENV,
  SANDBOX_PI_PROVIDER_ID,
  type SandboxLlmInput,
} from './spec.js'
