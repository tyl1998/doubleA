/**
 * 后端进程入口（P0-1-4 起真的会监听端口）
 *
 * 职责（刻意只有这三件，其余都在 app.ts / routes/）：
 *   1. `--check-config`：只校验配置并打印脱敏摘要（部署前自检，P0-1-3 起沿用）
 *   2. 启动：`buildApp()` → `listen(config.port)`
 *   3. 优雅退出：SIGINT/SIGTERM/未捕获异常 → 停止接流 → 关依赖连接 → flush 日志 → 退出
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
    //    启动日志一直报「P0-1-6」导致冒烟时无法从日志判断跑的是哪一版）。
    //    批次清单见 `docs/06-实施计划.md` §三；收尾清单见本仓批次工作流技能。
    step: 'P0-1-12 LLM client 封装',
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
} catch (error) {
  logger.fatal({ err: error, port: config.port }, '监听端口失败，进程退出')
  await shutdown('listen-failed', 1)
}
