/**
 * @doubulea/shared — 共享契约层入口
 *
 * 定位（`06` §3.0 要点 3）：编译期依赖，构建时内联进 backend / frontend 各自产物，
 * **运行期不产生耦合** —— 前端可部署到 CDN，后端可部署到内网，互不影响。
 *
 * 使用方式：
 * - 运行时值（schema / 常量 / 类）：`import { ok, AppError, ERROR_CODES } from '@doubulea/shared'`
 * - 纯类型：`import type { ErrorCode, Envelope } from '@doubulea/shared'`
 */

export * from './errors.js'
export * from './envelope.js'
export * from './auth.js'
export * from './user.js'
export * from './modelProvider.js'
export * from './model.js'
export * from './knowledgeBase.js'
export * from './document.js'
export * from './agent.js'
export * from './conversation.js'
export * from './sse.js'
export * from './mcp.js'
export * from './cron.js'
export * from './task.js'
export * from './usage.js'
export * from './memory.js'
export * from './workspace.js'
export * from './router.js'
export * from './gitCredential.js'
export * from './gitIdentity.js'
export * from './egressPolicy.js'
export * from './runtime.js'
