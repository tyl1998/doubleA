/**
 * 后端进程入口（占位）
 *
 * P0-1-1 只落地 workspace 骨架，此处仅提供「可编译、可启动」的最小实现，
 * 用于验证三包构建链路与 `@doubulea/shared` 的解析。
 *
 * 真实实现（Fastify 实例、配置加载、健康探针、优雅退出）在后续步骤落地：
 *   P0-1-3 → src/config.ts、src/infra/logger.ts
 *   P0-1-4 → src/app.ts、src/routes/health.ts
 */

import { HTTP_STATUS_BY_ERROR_CODE, ok, type Envelope } from '@doubulea/shared'

const bootEnvelope: Envelope<{ service: string; step: string; envCount: number }> = ok({
  service: 'doubulea-backend',
  step: 'P0-1-1 骨架',
  envCount: Object.keys(process.env).length,
})

// eslint-disable-next-line no-console -- P0-1-3 接入 pino 前的临时输出
console.log('[doubulea-backend] 骨架就绪', {
  ...bootEnvelope,
  healthStatusHint: HTTP_STATUS_BY_ERROR_CODE.INTERNAL,
})

export { bootEnvelope }
