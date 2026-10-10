/**
 * 用量统计路由（P1-7）—— `GET /api/usage/summary`
 *
 * 依据：`02` §四（`GET /api/usage/summary` 用量报表）、`01` §3.8 需求 37、`03` §4.8（`/admin/usage`）。
 *
 * 权限：**仅 ADMIN**（`(A)` 族，与 `/api/users`、`/api/models` 同族）——
 * 它是平台级报表（"这个月谁用最多"），不是"看自己的用量"。普通用户看自己的每轮 token
 * 走消息历史（`messageItemSchema.tokensIn/Out`）。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import { ok, usageSummaryQuerySchema, type UsageSummaryQuery } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { summarizeUsage } from '../services/usage.service.js'

export function registerUsageRoutes(app: FastifyInstance): void {
  /** 用量报表（仅 ADMIN）。三个 `groupBy` 维度共用本端点，前端并排三张表各发一次。 */
  app.get<{ Querystring: UsageSummaryQuery }>(
    '/api/usage/summary',
    { preHandler: app.requireAdmin, schema: { querystring: usageSummaryQuerySchema } },
    async (request) => ok(await summarizeUsage(request.query)),
  )
}
