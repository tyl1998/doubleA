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
  closeAllSandboxRpcs,
  getSandboxListenerStats,
  getSandboxRpcStats,
  getSandboxStats,
  reconcileOnBoot,
  startSandboxListener,
  startSandboxReaper,
  stopSandboxListener,
  stopSandboxReaper,
} from './sandbox/index.js'
import { ok, type Envelope } from '@doubulea/shared'

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
    step: 'P0-3-14 TaskAgent 知识库支持：**绑定知识库的 TaskAgent 现在能识别并使用知识库**。① 抽出内置知识库工具（`knowledge_search` / `list_knowledge`）的**唯一执行体** `orchestrator/knowledgeTools.ts`（ChatBot 工具循环与沙箱代理路径共用）。② 沙箱工具清单（`sandbox/mcpMap.ts#SandboxMcpCatalog`）新增 `builtins` 段，`sandbox/proxy.ts#buildSandboxMcpCatalog` 在 Agent 绑库时把这两个工具下发；新增内置工具调用端点 `POST /api/sandbox/builtin/call`（经令牌认证，库/文档全在后端查）。③ 容器侧 `mcp-bridge` 扩展注册内置工具（走 `builtinTools` 段 + `BUILTIN_CALL_PATH`）。④ `sandbox/map.ts` 新增 `resolveBuiltinTool` 注入 ⇒ 内置工具卡 `kind:BUILTIN`（与 ChatBot 同 kind）+ 展示名"知识库"。⑤ `taskAgent.ts` 派活前把「知识库能力说明 + 引用规则 + 可用知识库清单」作为 prompt 前缀注入（走 pi 的 `prompt` 通道，TaskAgent 没有 system 通道），并订正 `citations` 写死空数组的过时注释。上一层是 **P0-3-13**（P0-3 包验收）',
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

  // 沙箱（P0-3-2）：**先对账、再开周期任务**，两条理由都是正确性：
  //   ① 顺序 —— 启动对账会清掉上一个进程留下的全部容器（引擎是本进程的子进程，
  //      进程一死容器就没有对话者了）⇒ 必须发生在任何人能用沙箱之前；
  //   ② 同 `startPipelineWorker` 的纪律：它是**进程级后台组件**，不放进 `buildApp()`
  //      （否则所有走 `app.inject` 的契约验收都会顺带连 Docker）。
  // ⚠️ 两者都**不会**让启动失败：未配置 `SANDBOX_IMAGE` 就直接跳过，Docker 不可达只 warn。
  logger.info(getSandboxStats(), '沙箱状态（启动时：名额册必然为空）')
  await reconcileOnBoot()
  startSandboxReaper()

  // 出口②（P0-3-3）：**独立 listener**，只挂 `/api/sandbox/*`（自 P0-3-9b 起是
  // `GET /api/sandbox/mcp/tools` 与 `POST /api/sandbox/mcp/call` 两条，见 `sandbox/proxy.ts`）。
  // 放在对账之后起：对账会清掉上一个进程留下的容器，而"能连回来的容器"此刻一个都不该存在。
  // ⚠️ 与前面几项同款纪律：**失败只 warn**（没配镜像 / 端口被占 / Docker 不可达都不该让后端起不来）。
  const listenerUp = await startSandboxListener()
  logger.info(getSandboxListenerStats(), listenerUp ? '沙箱代理 listener 就绪' : '沙箱代理 listener 未就绪')
} catch (error) {
  logger.fatal({ err: error, port: config.port }, '监听端口失败，进程退出')
  await shutdown('listen-failed', 1)
}
