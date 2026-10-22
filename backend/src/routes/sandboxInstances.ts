/**
 * 沙箱实例注册表路由（P1-14 · R5 后台可观测 + 摘流）—— `GET /api/admin/sandbox/instances`
 *                                          `POST /api/admin/sandbox/instances/:id/drain`
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 4（实例自动发现）/ §九·补 2.1（负载进注册表）；
 *      契约 `shared/src/sandboxInstance.ts`。
 *
 * 权限：**仅 ADMIN**。这是平台级运维事实（哪些机器在线、各自多忙），与"某个人的会话/凭据"无关；
 * 与会话侧的 `GET /api/sandbox/runtimes`（登录即可，那是"这台机器能跑什么"）刻意不同族。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么"摘流"不能是一条直接改注册表的写接口
 * ─────────────────────────────────────────────────────────────────────
 * 注册键 `sandbox:instance:{id}` 归**那台实例自己**（心跳每拍覆盖写）。别人写进去的值下一拍就没了，
 * 删键更只是把一个会自愈的洞。所以写入落在一个**被摘那台每拍心跳都会读**的标记上
 * （`sandbox:drain:{id}`，见 `services/sandboxInstance.service.ts#setSandboxInstanceDrained`），
 * 再由它自己的心跳把 `drained` 报进注册值 —— 网关与后台页读的是同一个字段。
 *
 * ⚠️ **GET 仍然只读**：写入只发生在下面这条 POST 与 `sandbox/owner.ts` 的心跳里。
 *    Redis 抖动时 GET 如实回 `error`（页面据此提示），而不是把"读不到"渲染成"零台实例"。
 */

import { ok, sandboxDrainBodySchema, sandboxDrainResultSchema, type SandboxDrainBody } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { listSandboxInstances, setSandboxInstanceDrained } from '../services/sandboxInstance.service.js'

export function registerSandboxInstanceRoutes(app: FastifyInstance): void {
  app.get('/api/admin/sandbox/instances', { preHandler: app.requireAdmin }, async () => ok(await listSandboxInstances()))

  /**
   * 摘流 / 恢复。
   *
   * ⚠️ 语义**只挡新会话**：`drained=true` 后网关不再把它当新 owner 的候选，已钉在它上面的会话
   *    （容器与工作区都在它本地盘）仍照常接。它**不等于下线**：注册键继续续期、`/health` 仍轮到它。
   *    ⇒ 想彻底停掉一台，仍然要停进程（`stopInstanceHeartbeat` 摘键 + TTL 摘除）。
   */
  app.post<{ Params: { instanceId: string }; Body: SandboxDrainBody }>(
    '/api/admin/sandbox/instances/:instanceId/drain',
    { preHandler: app.requireAdmin, schema: { body: sandboxDrainBodySchema } },
    async (request) => ok(sandboxDrainResultSchema.parse(await setSandboxInstanceDrained(request.params.instanceId, request.body.drained))),
  )
}
