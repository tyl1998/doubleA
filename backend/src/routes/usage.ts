/**
 * 用量统计路由（P1-7）—— `GET /api/usage/summary`
 *
 * 依据：`02` §四（`GET /api/usage/summary` 用量报表）、`01` §3.8 需求 37、`03` §4.8（`/admin/usage`）。
 *
 * 权限：**登录即可**（产品口径 2026-10：「用量大家都可以看」）。
 * ⚠️ 原口径是**仅 ADMIN**（`(A)` 族）；这是一次**有意的产品放宽**，不是漏写
 * `requireAdmin`。放开的是"平台级用量报表"这一份共享事实 —— 与会话/凭据那类私有资源无关。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import { ok, usageSummaryQuerySchema, type UsageSummaryQuery } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { summarizeUsage } from '../services/usage.service.js'

export function registerUsageRoutes(app: FastifyInstance): void {
  /** 用量报表（**登录即可**，见文件头）。三个 `groupBy` 维度共用本端点，前端并排三张表各发一次。 */
  app.get<{ Querystring: UsageSummaryQuery }>(
    '/api/usage/summary',
    { preHandler: app.requireAuth, schema: { querystring: usageSummaryQuerySchema } },
    async (request) => ok(await summarizeUsage(request.query)),
  )
}
