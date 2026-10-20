/**
 * 沙箱实例注册表路由（P1-14 · R5 后台可观测）—— `GET /api/admin/sandbox/instances`
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 4（实例自动发现）/ §九·补 2.1（负载进注册表）；
 *      契约 `shared/src/sandboxInstance.ts`。
 *
 * 权限：**仅 ADMIN**。这是平台级运维事实（哪些机器在线、各自多忙），与"某个人的会话/凭据"无关；
 * 与会话侧的 `GET /api/sandbox/runtimes`（登录即可，那是"这台机器能跑什么"）刻意不同族。
 *
 * ⚠️ **只读**：写入只发生在 `sandbox/owner.ts` 的心跳里。本端点读的是 Redis 里**此刻的事实**，
 *    Redis 抖动时如实回 `error`（页面据此提示），而不是把"读不到"渲染成"零台实例"。
 */

import { ok } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { listSandboxInstances } from '../services/sandboxInstance.service.js'

export function registerSandboxInstanceRoutes(app: FastifyInstance): void {
  app.get('/api/admin/sandbox/instances', { preHandler: app.requireAdmin }, async () => ok(await listSandboxInstances()))
}
