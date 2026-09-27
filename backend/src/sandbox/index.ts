/**
 * 沙箱模块出口（P0-3-2 建，P0-3-3 补网络与 listener，P0-3-4 补 LLM 注入，P0-3-5 补引擎桥，
 * P0-3-6 补事件映射，P0-3-7 补产物收集，P0-3-9b 补 MCP 代理）
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
 * | P0-3-7 的编排层 | `snapshotWorkFiles`（派活之前拍基线）/ `collectRoundArtifacts`（对照 → 传对象 → 建行，返回值即 `artifact` 事件 payload） |
 * | ✅ P0-3-9b 的编排层（`taskAgent.ts`） | `ensureSandboxMcpCatalog`（预热工具清单，反查 `serverId` 的唯一依据）+ `resolveSandboxMcpTool`（引擎工具名 → 这个工具是谁）+ `type SandboxMcpCatalog` |
 * | ✅ P0-3-9b 的 listener（`listener.ts`，**它直接 `import './proxy.js'`** —— 那条链要碰 SSE/Prisma，不该被人人都在 import 的本桶拖上） | `registerSandboxProxyRoutes` |
 * | ✅ P0-3-8 的停止路径（`taskAgent.ts` 收尾调用） | `closeSandboxRpc`（先拆连接）/ `recycleSandbox`（再杀容器与具名卷） |
 * | P0-3-5 的引擎桥 | `SANDBOX_PI_PROVIDER_ID` + `SANDBOX_LLM_ENV` / `piRpcArgv`（拼容器命令行）、`SANDBOX_WORK_DIR` |
 * | 日志 / 将来的 `GET /api/tasks` | `getSandboxStats` / `getSandboxReaperStats` / `getSandboxListenerStats` / `getSandboxRpcStats` / `sandboxQueueDepth` |
 * | 诊断 / 纯函数核对 | `piApiForProtocol` / `piBaseUrlFor` / `sandboxLlmEnv`（LLM 目标的拼装，P0-3-4）、`piRpcArgv` 与 `createJsonlDecoder`（P0-3-5）、`readEngineUsage` / `isKnownEngineEventType`（事件映射，P0-3-6） |
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
  isKnownEngineEventType,
  readEngineUsage,
  TOOL_RESULT_NO_ERROR_DETAIL,
  TOOL_SUMMARY_MEMO_LIMIT,
  type EngineEventMapper,
  type EngineEventMapping,
  type EngineUsage,
} from './map.js'

// 产物收集（P0-3-7）：工作卷基线与对照扫描 → 对象存储 → `artifacts` 行
// ｜ P0-3-6 的编排层 | `snapshotWorkFiles`（派活之前拍基线）+ `collectRoundArtifacts`（收尾对照）
// ｜ 进程入口（reaper 的那一轮） | `reapExpiredArtifacts`（保留期清理，挂在对账器 tick 里）
// 纯函数（`parseFindOutput` / `diffWorkFiles` / `filterChangedFiles` / `artifactMimeOf`）也导出：
// 它们可以**不连 Docker、不连 S3** 地逐条核对（核查口径与 `map.ts` 同款）。
export {
  artifactMimeOf,
  collectRoundArtifacts,
  diffWorkFiles,
  filterChangedFiles,
  parseFindOutput,
  reapExpiredArtifacts,
  snapshotWorkFiles,
  ARTIFACT_EXCLUDED_DIRS,
  ARTIFACT_EXEC_TIMEOUT_MS,
  type WorkFileStat,
  type WorkSnapshot,
} from './artifacts.js'

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
  ensureSandboxMcpCatalog,
  registerSandboxProxyRoutes,
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
