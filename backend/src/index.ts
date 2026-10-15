/**
 * 后端进程入口（P0-1-4 起真的会监听端口）
 *
 * 职责（刻意只有这三件，其余都在 app.ts / routes/）：
 *   1. `--check-config`：只校验配置并打印脱敏摘要（部署前自检，P0-1-3 起沿用）
 *   2. 启动：`buildApp()` → `listen(config.port)` → **启动流水线 worker**（P0-1-17）
 *   3. 优雅退出：SIGINT/SIGTERM/未捕获异常 → 停 worker → 停止接流 → 关依赖连接 → flush 日志 → 退出
 *
 * ⚠️ **流水线 worker 的生命周期归本文件**（P0-1-17）：不放进 `buildApp()`，因为它是
 *    "进程级后台组件"而不是"HTTP 应用的一部分" —— 放进 `buildApp()` 会让所有走
 *    `app.inject` 的契约验收（verify:app）被迫连 Redis，还会莫名开始消费队列里的任务。
 *
 * ⚠️ import 顺序有意义：`./config.js` 必须最先求值 —— 它负责加载环境变量并做启动前校验，
 *    校验失败时在 logger 就绪之前用 stderr 打印缺失清单并 `exit 1`。
 */

import { config, describeConfig, envFile } from './config.js'
import { DEFAULT_HOST, buildApp } from './app.js'
import { logger } from './infra/logger.js'
import { closePg } from './infra/pg.js'
import { closePrisma } from './infra/prisma.js'
import { closeRedis } from './infra/redis.js'
import { getPipelineWorkerStats, startPipelineWorker, stopPipelineWorker } from './pipeline/worker.js'
import {
  getScheduledTaskStats,
  startScheduledTaskScheduler,
  stopScheduledTaskScheduler,
} from './scheduler/scheduledTasks.js'
import {
  claimInstanceIdentity,
  closeAllSandboxRpcs,
  getSandboxListenerStats,
  getSandboxRpcStats,
  getSandboxStats,
  reconcileOnBoot,
  startInstanceHeartbeat,
  startSandboxListener,
  startSandboxReaper,
  stopInstanceHeartbeat,
  stopSandboxListener,
  stopSandboxReaper,
} from './sandbox/index.js'
import { ok, type Envelope } from '@doubulea/shared'
import {
  flushWorkspaceColdBackups,
  reapExpiredWorkspaceDirs,
  reapOrphanWorkspaceDirs,
  startWorkspaceReaper,
  stopAllWorkspaceWatchers,
  stopWorkspaceReaper,
} from './workspace/index.js'

/** 「优雅退出」的兜底时限：超时则强杀，避免卡在某个不肯关闭的连接上（`06` P0-1-4 落地要点） */
const SHUTDOWN_TIMEOUT_MS = 10_000

/** `--check-config`：只校验配置并打印脱敏摘要（部署前自检 / 本批次验收用），不启动服务 */
const checkConfigOnly = process.argv.includes('--check-config')

if (checkConfigOnly) {
  // 这一路刻意用 console 而非 pino：输出要稳定、可被 CI/grep 直接消费，
  // 且不依赖日志级别与 pino-pretty 是否可用。
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        code: 0,
        msg: 'ok',
        data: {
          envFile: { path: envFile.path ?? null, note: envFile.note },
          config: describeConfig(config),
        },
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

for (const warning of config.warnings) {
  logger.warn({ scope: 'config' }, warning)
}

const app = buildApp()

let shuttingDown = false

/**
 * 优雅退出：① 停止接收新连接并在途请求收尾 ② 关 PG/Redis ③ flush 日志 ④ 退出。
 * 幂等 —— 信号可能连来两次（Ctrl-C 连按），第二次直接忽略，交给兜底定时器兜底。
 */
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  // 兜底：万一某个连接不放手，10s 后强退（不挂死在退出流程里）
  const forceExit = setTimeout(() => {
    logger.error({ reason }, `优雅退出超时（>${SHUTDOWN_TIMEOUT_MS}ms），强制退出`)
    process.exit(exitCode === 0 ? 1 : exitCode)
  }, SHUTDOWN_TIMEOUT_MS)
  forceExit.unref()

  logger.info({ reason }, '开始优雅退出：停止接收新请求')
  try {
    // ⚠️ 顺序：先停后台消费者（流水线 worker 还在用 PG/Redis/S3、沙箱对账器还在删容器），
    //    再收 app，最后关依赖。反过来的话它们会拿着已关闭的连接继续干活，
    //    日志里出现一堆"数据库不可用"的假故障。
    await stopPipelineWorker()
    // 定时任务调度器（P1-6）：同一条纪律 —— 它还在用 PG/Redis 驱动 TaskAgent，
    // 必须在关依赖之前停掉（在飞的那几轮不打断，跑完自己收尾）。
    await stopScheduledTaskScheduler()
    // ★ P0-3-5：**先拆引擎桥**（在此之前停对账器，免得它把正在被"告别"的容器也删一遍）。
    //   拆桥 = 关掉 attach 连接 + 把在飞的那一轮判成"桥已关闭"，**不碰容器** ——
    //   容器留在磁盘上由**下一次启动的 `reconcileOnBoot()` 清掉**（`子方案③` §九 2：
    //   引擎是容器主进程，后端一没就没人跟它说话，一律重建不复用）。
    //   ⚠️ 不在这里杀容器：那会把"进程退出"变成一个可能耗时几十秒的容器清理动作，
    //   而退出路径的兜底时限只有 10s。
    const rpcStats = getSandboxRpcStats()
    closeAllSandboxRpcs('shutdown')
    if (rpcStats.open > 0) {
      logger.info(rpcStats, '已拆掉全部引擎桥（容器留给下次启动的对账清理掉）')
    }
    await stopSandboxReaper()
    // ★ P1-14：退出时摘掉实例在线注册键（崩溃则靠 TTL 摘除），并停心跳。
    await stopInstanceHeartbeat()
    // ★ P1-9 · R5：停工作区保留期清理器（进程内定时器），并等在飞的那一轮收尾 —— 它在用 PG/S3/FS。
    await stopWorkspaceReaper()
    // ★ P1-9：停掉工作区 watcher（进程内定时器）。放在关依赖之前 —— 它会读 PG。
    stopAllWorkspaceWatchers()
    // ★ P1-9 · R3：退出前把还在去抖窗口里的**工作区冷备上行**排空（尽力，失败只 warn）——
    //   否则刚写完就重启会丢掉"最后一跳"的 S3 冷备。放在关依赖之前（它要用 S3/PG）。
    await flushWorkspaceColdBackups().catch((error: unknown) => {
      logger.warn({ err: error }, '退出前排空工作区冷备队列失败（已忽略）')
    })
    // ⚠️ 出口② 的 listener 也是"后台组件"（它服务的是容器来的请求），排在这里：
    //    先停它再关 app —— 反过来的话容器还可能打进来，而进程已经在拆依赖了。
    await stopSandboxListener()
    await app.close()
    // ⚠️ 顺序：Prisma 先于探活池（业务查询收尾不会晚于探活）。
    //    closePrisma 对「从未创建过客户端」的进程是空操作，因此不引入退出负担。
    await closePrisma()
    await Promise.all([closePg(), closeRedis()])
    logger.info({ reason }, '依赖连接已关闭，进程退出')
  } catch (error) {
    logger.error({ err: error, reason }, '优雅退出过程中出错（仍会退出）')
  }

  clearTimeout(forceExit)
  // pino 的 transport 可能带 worker 线程：flush 保证最后几行日志真的落盘再退
  logger.flush(() => process.exit(exitCode))
}

process.once('SIGINT', () => void shutdown('SIGINT', 0))
process.once('SIGTERM', () => void shutdown('SIGTERM', 0))
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, '未捕获异常，进程即将退出')
  void shutdown('uncaughtException', 1)
})
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, '未处理的 Promise 拒绝，进程即将退出')
  void shutdown('unhandledRejection', 1)
})

// ★ P1-14 §五 1：**实例唯一性自检**（硬约束）—— 抢注 `sandbox:instance:{id}`。
//   抢不到 = 有**同名活实例**在线 ⇒ 拒绝启动（同 id 两实例会让对账互相误杀，比"起不来"更糟）。
//   ⚠️ Redis 抖动/不可达**不**据此拒启（那是"查不了"、不是"标识冲突"）—— 只 warn 并降级为单实例语义。
//   放在**起服务之前**：撞 id 时"先起来再报错"会让两台短暂并行，而那正是对账互相误杀的时间窗。
const identity = await claimInstanceIdentity().catch((error: unknown) => {
  logger.warn({ err: error }, '实例唯一性自检未能完成（Redis 不可达）⇒ 跳过；本次按单实例语义运行')
  return undefined
})
if (identity !== undefined && !identity.ok) {
  logger.fatal(
    { instanceId: config.sandbox.instanceId, heldBy: identity.heldBy },
    'SANDBOX_INSTANCE_ID 与在线的另一实例冲突 ⇒ 拒绝启动（同 id 两实例会让对账互相误杀，比"起不来"更糟）',
  )
  process.exit(1)
}

try {
  const address = await app.listen({ port: config.port, host: DEFAULT_HOST })
  const bootEnvelope: Envelope<{ service: string; step: string; address: string }> = ok({
    service: 'doubulea-backend',
    // ⚠️ 每批必须顺手改成当前批次（P0-1-6 起连漏三批：P0-1-7/8/9 都忘改，
    //    启动日志一直报「P0-1-6」导致冒烟时无法从日志判断跑的是哪一版；**P0-1-19 又漏了一次**
    //    ⇒ 已配机器自检 `pnpm check:batch`，它比对本行与 `docs/06` 里最后一个 `[✓]` 的批次号）。
    //    批次清单见 `docs/06-实施计划.md` §三；收尾清单见本仓批次工作流技能。
    // ⚠️ **支线批次的写法（P0-3-9b 起）**：`check:batch` 取的是**批次号最大**的那个（不是文件里
    //    最后出现的），而 `P0-3-11` 的键大于 `P0-3-9b` ⇒ 插队补做的支线**不能**把 step 改成
    //    "P0-3-9b …"（那会让自检必红）。支线当时的写法是「P0-3-11 + P0-3-9b」：既说明代码状态是
    //    "里程碑批次之上叠了这条支线"，又仍带着那个最大批次号。⚠️ **P0-3-12 起该写法退役** ——
    //    P0-3-12 > P0-3-11 > P0-3-9b ⇒ 本行直接写"P0-3-12 …"即可（规则只在"补做的批次号更小"时才需绕）。
    // ⚠️ **P1 批次号是两段式（P1-1）**：与 P0 的"计划-批次-步"三段式不同，P1 只有
    //    "计划-项"两层 ⇒ `check:batch` 的正则从 P1-1 起**同时接受两段与三段**（见该脚本）。
    //    ⚠️ 本批是 **P1-8**（批次号 8 < 已完成的 P1-12），故沿用 P0-3-9b 起的"支线写法"：
    //    写成 `P1-12 + P1-8 …`（`check:batch` 取批次号最大者 = P1-12，仍满足自检）。
    step: 'P1-17 沙箱执行环境：运行时与依赖（a+b+c 全量落地，2026-10-14）：运行时预烘焙（方案 B 一栈一份镜像 none/node/python/go/java/rust + `Conversation.runtime` + `ensureSandbox` 按会话选镜像 + `doubulea.runtime` 标签复用前比对 + 回退 `SANDBOX_IMAGE`）+ 依赖运行期拉（`workspace/dependencyModel.ts` 名单一处定义：依赖目录不进索引/产物/冷备、不算源码配额、中介写不进；依赖字节单独计量）+ 凭据隔离（`sandbox/credentialPhase.ts`：`bash` 装依赖/跑项目命令 ⇒ 会话钉 `run` 相 ⇒ `gitProxy` 拒凭据 CREDENTIAL_ISOLATED；helper 只实现 get = 只读；全量审计）。自证 pnpm -r typecheck（三包 Done，Node 22）+ pnpm check:batch（真跑留给用户）。★ 历史累积（最近在最后）→ P1-16 沙箱出网范围与注册表专用代理（P1-16a 平台级出网范围落地，2026-10-14；P1-16b 注册表专用代理经决定不做、关闭）：`egress_policy.scope` 三档（ALL 全放行 / NONE 仅模型 / REGISTRY 模型+取包，默认 ALL）+ `resolveEgressPolicy`（范围 + 两张表 + 模型池 → 解析后两张表，收窄档空放行项兜 deny=[*]）+ 平台出网策略页出网范围下拉 + `egress-up.sh` 读 scope 解析成代理的 {allow,deny}（代理不做 per-conversation）；P1-16b 关闭 ⇒ REGISTRY 以主机级放行为最终形态。★ 施工修订（用户定案 2026-10-14）：初版按会话级出网覆盖（Conversation.egressScope + per-container token + 策略文件 tokens/conversations + POST /:id/egress-scope + 会话下拉）实现，用户要求"不要放在会话里配、放到出网策略里配、默认全放行" ⇒ 改平台级并移除全部会话级机制。自证 egress:regression（16）/ verify:admin-ui（82）/ verify:chat-home（30）/ pnpm -r typecheck + eslint + build:frontend。★ 历史累积（最近在最后）→ P1-15 聊天主页与信息架构改造（以聊天为主页 + Code 模式布局，2026-10-12；前端为主 + 一条后端端点 `GET /api/conversations` 与用量权限放宽）。★ 历史累积（最近在最后）→ P1-12 + P1-8a 长期记忆 v2（两层作用域 + 按需检索，2026-10-10 需求变更）。① 契约 `shared/src/memory.ts` v2：`MEMORY_KINDS`=PROFILE/PREFERENCE/HABIT/HIGHLIGHT/OTHER + `MEMORY_SCOPES`（派生 `scope`）+ `RECALL_MEMORY_TOOL_NAME` + `updateMemoryBodySchema.agentId`(null=提升为全局) + `memorySettingsSchema.memoryProfileMax` + `memoryNoticeSchema.memoryScope` + `listMemoriesQuery.scope`。② 迁移 `20261010140000_memory_kind_values`（枚举加值）+ `20261010141000_memory_kind_backfill`（旧数据 CASE backfill + `users.memory_profile_max` + 检索索引 `(user_id,agent_id,kind,created_at desc)`）。③ 服务 `services/memory.service.ts`：`buildUserProfileBlock`（USER 常驻画像，上限用户可调）+ `buildMemoryToc`（AGENT 极简目录 TOC，解决"模型不知道有记录"）+ `recallMemories`（关键词，未命中显式文案）；`updateMemory` 支持 `agentId`（提升/降级）；settings 读写 `memoryProfileMax`。④ 编排：`memoryTools` 的 `remember` 加 `scope` + 新增 `recall_memory` 执行体；`memoryExtract` **只写 USER 画像/偏好**（AGENT 记忆改为模型驱动，不再每轮规则抽取）；`chatContext#buildSystemPrompt` 按 §8.4a 合成（人设→默认→USER 画像→AGENT TOC+记忆工具说明与反幻觉→能力/规则）；ChatBot / TaskAgent / `memoryDoc` 注入画像+TOC、注册 `recall_memory`、**不再注入 AGENT 正文**；沙箱 `/api/sandbox/builtin/call` 增 `recall_memory` 代跑。⑤ 前端：记忆面板**作用域分组/筛选** + 作用域选择 + **提升为全局** + 提示文案按作用域分流 + `recall_memory` 工具卡。自证 `pnpm verify:memory-ui`（9 项）；`verify:chat-sse`（92）/`verify:usage-ui`（13）未回归。⚠️ AGENT 记忆由模型决定、检索先关键词（向量预留）。**2026-10-10 修订**：`remember` 工具也尊重会话级「不记入记忆」（`memoryExcluded=true` 拒绝写入），与后端偏好检测一致；用户显式"记住：…"仍不受限。上一层是 **P1-8**。★ 叠 **P1-9 P0+P1+P2+P3 工作区（2026-10-12，WIP）**：`shared/src/workspace.ts` 契约 + `workspaces` 五表迁移 + `config.workspace` + `backend/src/workspace/`（归一化/realpath 判据 · CAS 写 · 事件总线 · watcher · 孤儿 reaper · claims · proxy · edit · sse）+ 沙箱 `/work` 具名卷→宿主 bind mount + `routes/workspace.ts`（六条 + 事件 SSE，仅本人）+ `services/previewHeaders.ts` + 沙箱代理端点 `/api/sandbox/workspace/{read,write,edit}` + 容器内 pi workspace 扩展（默认 env 关闭）+ `sandbox/proxyAuth.ts` + 会话 `codeMode` 持久列（迁移 `20261012110000_conversation_code_mode`）+ `POST /:id/code-mode` + 派活注入 `DOUBULEA_WORKSPACE_MEDIATION=1` + 前端 `api/workspace.ts`/`stores/workspace.ts`/`workspaceModel.ts`/`WorkspacePanel.tsx`（编辑器为原生 textarea，非 CodeMirror）+ ChatPage 接线 + P4 变更集（`foldWorkspaceEvents` + `GET /workspace/changes` + 面板「最近变更」）；**P4 R1 steer 中途注入（2026-10-12 复核 pin `0.87.1` 运行时原型：`{type:\'steer\',message}` → `success:true` + `queue_update`）**：`bridge#steer` 运行时命令通道 + `chat.steer:{id}` 列表信号 + `ChatProducerInput#onSteer` + TaskAgent 双源（用户插话 / 工作区 USER 写主动感知，落到助手 turn 边界）+ `POST /:id/steer` + 前端「边跑边插话」入口（仅沙箱会话）；★ P4 R2 撤销本轮（2026-10-12）：`workspace/blob.ts` 本地内容寻址历史字节（覆盖/删除前 stash）+ `workspace/round.ts` 轮次起止标记（Redis）+ `service#revertWorkspaceRound`（按 `beforeVersion` CAS 回写，轮末后被改过记 conflict、缺历史记 unavailable、二进制/改名记 unsupported）+ `POST /:id/workspace/revert`（`dryRun` 可预演）+ 前端「撤销本轮」入口；★ P5 R3 S3 冷备/恢复（2026-10-12）：`workspace/coldModel.ts`（纯：内容寻址键 `workspaces/{id}/blobs/{sha256}` + 恢复计划）+ `workspace/cold.ts`（写后异步去抖上行 + `s3Key` 回填 + 空目录 `restoreWorkspaceFromCold` + 按前缀删孤儿）+ `service#ensureWorkspace` 空目录 rehydrate + `store#workspaceDirIsEmpty` + `reaper` 清孤儿时清冷备 + `sandbox/manager` 派活前 rehydrate + 退出前排空队列；★ P5 R4 artifact 集成（2026-10-12，产物 = 工作区变更集视图）：新增 `sandbox/artifactChanges.ts`（纯函数：变更集 → 产物路径，隐藏/`.git`/node_modules 排除）+ `collectRoundArtifacts` 判据由"容器快照 diff"改为"本轮工作区变更集"（`shared#foldWorkspaceEvents`）并从**宿主工作区 FS** 读字节 + TaskAgent 轮次起点前 `reconcileWorkspaceOnce`（setup 写落定、不被收成产物）；快照基线与 `docker exec` 扫容器退役；★ P5 R5 保留期清理（2026-10-12，会话仍在但工作区超保留期即整份收）：`workspace/reapModel.ts`（新增纯函数：`workspaceRetentionCutoff`/`isWorkspaceExpired`，严格 `<`）+ `reaper.ts` 新增 `reapExpiredWorkspaceDirs`（判据 `workspaces.updated_at < now - 保留期`，与产物共用 `ARTIFACT_RETENTION_DAYS`，已决 4；有活体容器 `RUNNING`/宽限 `CREATING` **跳过**）+ `purgeWorkspace`（先删 S3 冷备、失败保留行下一轮再试 ⇒ "对象删成功才删行"；再停 watcher/丢弃去抖冷备、删本地目录+历史字节、删 DB 行）+ 孤儿路径补"孤儿本地历史字节目录 GC" + 周期清理器 `startWorkspaceReaper`/`stopWorkspaceReaper`（1h；启动另跑一次）+ `ensureWorkspace` 只在行缺失时才写（读路径不再刷新 `updated_at`，否则保留期永不到期）+ `cold#dropPendingWorkspaceBackups` + `deleteWorkspaceColdBlobs` 改为 `{removed,failed}`；CodeMirror 待后续**。`workspace:regression`（34 项）+ `verify:workspace-ui`（12 项）+ `verify:chat-sse`（93 项）全绿。★ 叠 **P1-9 P6 R6 配额/二进制硬化（2026-10-12，WIP）**：`backend/src/workspace/quotaModel.ts`（**新增**纯函数：`looksBinaryWorkspaceContent`（前 8KB 见 NUL ⇒ 二进制，git `buffer_contains_NUL` 同款）+ `decideWorkspaceQuota`（`BINARY_CONTENT`/`FILE_TOO_LARGE`/`TOO_MANY_FILES`/`TOO_MANY_ROWS`/`TOTAL_TOO_LARGE` 逐条判定）+ `isWorkspaceWriteRateExceeded`/`workspaceWriteRateWindowStart`）+ `backend/src/workspace/rateLimit.ts`（**新增**：`assertWorkspaceWriteRate`，Redis 固定窗口 `INCR`，超限抛 `BUSY`/429，Redis 抖动 **fail open**）+ `infra/redis#workspaceWriteRateKey`/`WORKSPACE_WRITE_RATE_TTL_SEC` + `config`（`WORKSPACE_MAX_ROWS`=20000 含墓碑 / `WORKSPACE_WRITE_PER_MIN`=600 且 `maxRows ≥ maxFiles` 校验）+ `workspace/service.ts`（`WorkspaceFileSource.binary` + 读/写两侧二进制闸门 + `assertWithinQuota` 重写为"现状快照 → `decideWorkspaceQuota`"）+ `workspace/store#workspaceContentIsBinary` + `routes/workspace`（保存/新建限流）+ `workspace/proxy`（`write`/`edit` 限流 + 读二进制闸门 + `BUSY` 按 200 结论回）+ `workspace-regression`（**43** 项，新增 N1–N9）；★ 叠 **P1-9 P7 R7 CodeMirror 6 编辑器（2026-10-12，P1-9 首次引前端新依赖）**：`frontend/package.json` 增 11 个 `@codemirror/*`（5 内核 `state`/`view`/`commands`/`language`/`search` + 6 语言包 `lang-{javascript,python,html,css,json,markdown}`）+ `frontend/src/features/chat/CodeMirrorEditor.tsx`（**新增**：`EditorView` 只建一次的受控壳 —— 外部 `value` 整篇替换、语言/只读 `Compartment` 热切换、`Mod-s` 保存、行号/高亮/历史/括号匹配/搜索/多选/折行 + 默认高亮 + 自定义浅色主题）+ `workspaceModel.ts#workspaceEditorLanguage`（**纯函数**：扩展名 → 语言 id，`workspaceModel.ts` 仍零 CodeMirror 依赖）+ `WorkspacePanel` 用编辑器替换 `<textarea>`；自证 `verify:workspace-ui`（**14** 项，新增 W13/W14）+ `verify:chat-sse`（93）+ `frontend build` + `pnpm -r typecheck`（三包 Done，Node 22）全绿。⚠️ 只引 CodeMirror 家族（无 `@lezer/highlight` 直接依赖）；语言包按需（js/ts·json/html/css/py/md 七族，其余纯文本）；单标签、无 lint/补全（后续增强）。★ 叠 P1-9 P2 R8 容器内 pi workspace 扩展最小原型复核 + 对齐 pin 0.87.1（2026-10-12）：真跑 pin 0.87.1 容器（假上游 SSE + DOUBULEA_WORKSPACE_MEDIATION=1）确认①同名覆盖 read/write/edit 生效（发给 LLM 的 tools[] 是本扩展定义）②写经 /api/sandbox/workspace/* 带 baseVersion 走 CAS③CONFLICT 回喂模型；据此把扩展 edit 形状由 old_string/new_string 对齐为 {path, edits:[{oldText,newText}]}（新增 backend workspace/edit.ts#applyWorkspaceEdits 原子多改 + 代理端点改 {path, edits[], baseVersion?} 兼容旧形）+ 三个覆盖工具补 promptSnippet/promptGuidelines/constrainedSampling（覆盖时不给会把内置工具从系统提示 <tools> 里静默抹掉）+ infra/sandbox/versions.mjs 层版本 5→6（P2 加扩展却漏升 ⇒ 宿主 toolkit:5 里根本没有该扩展，需重建镜像并改 .env）；自证 workspace:regression（44 项，新增 F3）+ pnpm -r typecheck（三包 Done，Node 22）+ check:batch。★ 叠 P1-14 沙箱多机部署（路线 A）+ P1-9 R9 多机粘性路由（2026-10-12）：实例身份 SANDBOX_INSTANCE_ID（默认 hostname）+ 启动同名抢注自检（sandbox/owner.ts#claimInstanceIdentity）+ 会话→实例目录 sandbox:owner:*（读/写/清）+ 实例在线注册表 sandbox:instance:*（心跳 3× TTL）+ 三处对账/空闲回收按 instanceId=self 过滤 + recycleSandbox 归属断言 + 队列键自动加 :instanceId 后缀 + Sandbox.instanceId 列（迁移 20261012120000_sandbox_instance_id，回填 default）+ 工作区钉机记录寿命跟随保留期（ensureWorkspaceOwner，早于建容器）+ 路由网关 backend/src/router/*（自研 Fastify，按会话粘性转发 /chat /stream /regenerate /workspace*，SSE 流式透传、不设 idle 超时，其余轮询）+ shared/router.ts 路由分类与上游选择（纯函数）+ 回归 router:regression；自证 pnpm -r typecheck + eslint + router:regression + workspace:regression（44）未回归 + check:batch。★ P1-9 R10 复核结案（2026-10-12，纯文档批/零代码）：剩余清单 R10「CLI/终端产物区（前端）与工作区面板的整合口径」按自带判据复核 `子方案/Code模式工作区.md` §六/§十 ⇒ 设计不要求、从清单移除（产物区与工作区面板关系已由 P3 第三列 Code 模式切换 + R4 产物=工作区变更集视图定案落地）；余项仅 R11（git 凭据）。★ 叠 P1-9 R11 git 凭据注入 + 出网默认放行（2026-10-12）：契约 `shared/src/gitCredential.ts`（`SSH_KEY`/`HTTPS_TOKEN` + item/list/create/update/delete + `missingGitCredentialSecretFields`）+ 迁移 `20261012130000_git_credentials`（`git_credentials` 表 + 枚举，挂 `User`）+ `services/gitCredential.service.ts`（**用户级**凭据：AAD=`userId:kind:label`、AES-256-GCM、`hasValue` 出口、条数闸门 `GIT_CREDENTIAL_MAX_PER_USER`）+ `routes/gitCredentials.ts` 四条（`GET/POST/PUT/DELETE /api/git-credentials`，仅本人、ADMIN 无后门）+ `sandbox/gitCredential.ts`（**纯函数**：`gitCredentialEnv`（SSH 的 `GIT_SSH_COMMAND` + HTTPS 的 `GIT_CONFIG_*`，token 不落盘）+ `gitCredentialFiles`（`.ssh` 0700 / `id_*` 0600 / `known_hosts` 0644））+ `sandbox/tar.ts`（**手写 ustar 编码器**）+ `sandbox/docker.ts#putArchive`（第一个消费方）+ `sandbox/manager.ts`（派活时按用户解密注入：env 进 spec、文件 `putArchive` 到 tmpfs `$HOME`，**绝不写 `/work`**）+ `config`（`SANDBOX_EGRESS_ALLOW_HOSTS`=* / `GIT_CREDENTIAL_MAX_PER_USER`=5）+ `infra/scripts/egress-up.sh`（读 `.env` 白名单）；前端 `/settings/git-credentials`（`pages/settings/GitCredentialsPage.tsx` + `gitCredentialModel.ts` + `api/gitCredentials.ts` + 路由/导航）；自证 `pnpm -r typecheck`（三包 Done，Node 22）+ 改动文件 `eslint` + `git:regression`（**19**）+ `verify:git-credentials-ui`（**10**）+ `workspace:regression`（44）/`router:regression`（17）未回归 + `frontend build` + `check:batch`。⚠️ 真跑（配只读 deploy key → `git clone` 私有仓库；容器回收后 `$HOME` 无残留）留给用户。★ 叠 P1-9 R11 修订 —— git 凭据改**按需拉取**（2026-10-13）+ egress 黑白名单平台化。**为什么改**：原设计的 `putArchive` 把 SSH 私钥注到容器 tmpfs `$HOME`，但容器 `ReadonlyRootfs:true` ⇒ Docker 归档 API 直接 400（`container rootfs is marked read-only`），私钥从来落不了盘（`$HOME/.ssh` 恒空、`GIT_SSH_COMMAND -i …` 指向不存在的私钥）；token 也只能建容器时定死。**改法**：凭据**不进容器**（不落盘、不进 env），容器里只有两个 toolkit 预烘焙的无状态 helper（`/opt/sandbox-git/git-credential-doubulea.mjs`（`credential.helper`）+ `git-ssh-doubulea.mjs`（`GIT_SSH_COMMAND`，把私钥按需写到可写的 `/tmp` 再 exec ssh）），git 用时经出口②回调 `POST /api/sandbox/git/credential`（令牌即会话身份，主语 = 会话发起者）按需取回 ⇒ 绕开 RO rootfs、改凭据不用重建容器。**新增**：`sandbox/gitProxy.ts`（端点）+ `sandbox/gitCredential.ts` 重写（`gitCredentialHelperEnv`（**不含秘密**）/`selectGitCredential`（按 protocol+host 挑）+ helper 路径常量）+ `spec.ts#SANDBOX_GIT_CREDENTIAL_PATH` + `listener.ts` 注册 + `manager.ts`（去掉解密与 `putArchive`，只注入固定 helper env）+ 两个容器脚本 + toolkit `Dockerfile`/`selfcheck.sh`（+2 断言）+ `versions.mjs` 层版本 `7→8` + `.env` 镜像标签。**egress 平台化**：`shared/src/egressPolicy.ts`（纯函数）+ 迁移 `20261013100000_egress_policy`（单例表）+ `services/egressPolicy.service.ts` + `routes/egressPolicy.ts`（`GET/PUT /api/admin/egress-policy`，仅 ADMIN）+ 前端 `/admin/egress` 页 + `egress-up.sh`（读表写策略文件）+ `egress-proxy.mjs`（模式/黑名单/审计，deny 优先、两张表都空=全放行）。自证 `git:regression`（**14**，重写）+ `egress:regression`（**9**，新）+ 两脚本本地冒烟（HTTPS 取凭据 / SSH 注入 `-i` 与回落）+ `pnpm -r typecheck` + `eslint`。⚠️ 端到端（真容器 `git clone`、平台→代理热更新）留给用户真跑；`sandbox/tar.ts` 与 `docker.ts#putArchive` 保留为通用原语但已不再用于 git 凭据。',
    address,
  })
  logger.info(
    {
      address,
      envFile: envFile.path ?? null,
      config: describeConfig(config),
      routes: app.printRoutes({ commonPrefix: false }),
      bootEnvelope,
    },
    `后端已启动：${address}（健康检查 GET /health）`,
  )

  // 流水线 worker：**在 listen 成功之后**才启动（绑定失败就没必要开始消费任务），
  // 且刻意放在 `index.ts` 而不是 `buildApp()` —— `app.inject` 式的契约验收（verify:app）
  // 不该顺带拉起一个消费者（那会要求它连 Redis，还会莫名其妙开始吃队列里的任务）。
  logger.info(getPipelineWorkerStats(), '正在启动文档流水线 worker')
  startPipelineWorker()

  // 多机实例（P1-14 §八 4）：注册键心跳续期 —— 网关据此自动发现本实例（`SANDBOX_INSTANCE_HEARTBEAT_SEC=0` 关闭）。
  startInstanceHeartbeat()

  // 沙箱（P0-3-2）：**先对账、再开周期任务**，两条理由都是正确性：
  //   ① 顺序 —— 启动对账会清掉上一个进程留下的全部容器（引擎是本进程的子进程，
  //      进程一死容器就没有对话者了）⇒ 必须发生在任何人能用沙箱之前；
  //   ② 同 `startPipelineWorker` 的纪律：它是**进程级后台组件**，不放进 `buildApp()`
  //      （否则所有走 `app.inject` 的契约验收都会顺带连 Docker）。
  // ⚠️ 两者都**不会**让启动失败：未配置 `SANDBOX_IMAGE` 就直接跳过，Docker 不可达只 warn。
  logger.info(getSandboxStats(), '沙箱状态（启动时：名额册必然为空）')
  await reconcileOnBoot()
  startSandboxReaper()

  // Code 模式工作区（P1-9）：启动时清一次"会话已没、目录还留着"的孤儿工作区，
  // 再清一次"会话仍在、但工作区超保留期"的（P5 · R5；与产物保留期共用同一个值，已决 4）。
  // ⚠️ 失败只 warn —— 工作区清理不该让后端起不来（与沙箱对账同款纪律）。
  await reapOrphanWorkspaceDirs()
    .then((report) => {
      if (report.removed > 0 || report.removedBlobDirs > 0) logger.info(report, '工作区 reaper：已清理孤儿工作区')
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, '工作区 reaper 启动清理失败（已忽略）')
    })
  await reapExpiredWorkspaceDirs()
    .then((report) => {
      if (report.removed > 0) logger.info(report, '工作区 reaper：已清理超保留期工作区')
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, '工作区 reaper 保留期清理失败（已忽略）')
    })
  // 保留期以"天"计，周期清理器每小时兜一轮（启动那一次上面已经跑过了）。
  startWorkspaceReaper()

  // 出口②（P0-3-3）：**独立 listener**，只挂 `/api/sandbox/*`（自 P0-3-9b 起是
  // `GET /api/sandbox/mcp/tools` 与 `POST /api/sandbox/mcp/call` 两条，见 `sandbox/proxy.ts`）。
  // 放在对账之后起：对账会清掉上一个进程留下的容器，而"能连回来的容器"此刻一个都不该存在。
  // ⚠️ 与前面几项同款纪律：**失败只 warn**（没配镜像 / 端口被占 / Docker 不可达都不该让后端起不来）。
  const listenerUp = await startSandboxListener()
  logger.info(getSandboxListenerStats(), listenerUp ? '沙箱代理 listener 就绪' : '沙箱代理 listener 未就绪')

  // 定时任务调度器（P1-6，2026-10-09 需求变更）：**进程级后台组件**，同 `startPipelineWorker`
  // 的纪律放在 index.ts（不放进 buildApp —— 否则 app.inject 式契约验收会顺带把调度器拉起来）。
  // ⚠️ 必须在 listen 之后：`app.inject` 验收不该触碰到点派活。
  logger.info(getScheduledTaskStats(), '正在启动定时任务调度器')
  startScheduledTaskScheduler()
} catch (error) {
  logger.fatal({ err: error, port: config.port }, '监听端口失败，进程退出')
  await shutdown('listen-failed', 1)
}
