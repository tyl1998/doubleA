/**
 * 后端进程入口
 *
 * 当前阶段（P0-1-3）：**配置加载 + 结构化日志**已接线。
 *   - `src/config.ts`  —— 启动即校验环境变量（含加载 `infra/.env`），失败即退出
 *   - `src/infra/logger.ts` —— pino + request id 贯穿
 * P0-1-4 接续：Fastify 实例 / `/health` / 统一错误处理 / 优雅退出（本文件改为「启动 app 并监听」）。
 *
 * ⚠️ import 顺序有意义：`./config.js` 必须最先求值 —— 它负责加载环境变量并做启动前校验，
 *    校验失败时在 logger 就绪之前用 stderr 打印缺失清单并 `exit 1`。
 */

import { config, describeConfig, envFile } from './config.js'
import { getLogger, logger, newRequestId, runWithRequestContext } from './infra/logger.js'
import { HTTP_STATUS_BY_ERROR_CODE, ok, type Envelope } from '@doubulea/shared'

/** `--check-config`：只校验配置并打印脱敏摘要（部署前自检 / 本批次验收用），不启动服务 */
const checkConfigOnly = process.argv.includes('--check-config')

const bootEnvelope: Envelope<{ service: string; step: string; requestId: string }> = ok({
  service: 'doubulea-backend',
  step: 'P0-1-3 配置 + 日志',
  requestId: newRequestId(),
})

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

// 模拟一次「请求链路」：证明 requestId 经 AsyncLocalStorage 自动贯穿到业务日志
// （P0-1-4 起改由 Fastify 钩子调用 enterRequestContext 完成同样的事）
runWithRequestContext({ requestId: bootEnvelope.data.requestId }, () => {
  getLogger().info(
    {
      envFile: envFile.path ?? null,
      envFileNote: envFile.note,
      config: describeConfig(config),
      // 骨架期仍保留 shared 的消费点：证明「编译期内联、运行期零耦合」的契约层可解析
      healthStatusHint: HTTP_STATUS_BY_ERROR_CODE.INTERNAL,
      bootEnvelope,
    },
    '后端骨架就绪（P0-1-3：配置加载 + 结构化日志已接线；HTTP 服务由 P0-1-4 落地）',
  )
})

export { bootEnvelope }

// 骨架期还没有 HTTP 服务（P0-1-4 才 listen）：打完启动日志就收尾退出，
// 否则 pino 的 transport worker 会让进程空转。`flush` 保证这行日志真的落盘。
// P0-1-4 落地监听后，这两行随之删除。
logger.flush(() => process.exit(0))
