/**
 * 会话标题生成模型路由（平台级单例）
 *
 * 依据：`shared/src/titleModel.ts`、`services/titleModel.service.ts`。
 *
 * 两条端点（**仅 ADMIN** —— 这是平台级配置，与 `/api/admin/egress-policy` 同族）：
 *   `GET /api/admin/title-model`  读当前配置（总开关 + 选定模型 + 展示名）
 *   `PUT /api/admin/title-model`  整体替换（总开关 + 选定模型一起交）
 *
 * ⚠️ 与"各自的凭据/模型池"那族**刻意不同**：那些挂 `requireAuth`（行级、ADMIN 无后门）；
 *    这里是**平台级共享事实**（所有会话共用一个标题模型），只有 ADMIN 能读能改。
 */

import { ok, titleModelConfigSchema, updateTitleModelBodySchema, type UpdateTitleModelBody } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { getTitleModelConfig, setTitleModelConfig } from '../services/titleModel.service.js'

export function registerTitleModelRoutes(app: FastifyInstance): void {
  /** 读当前配置（仅 ADMIN）。响应再过一次 schema，与其余路由"响应也过 schema"的口径一致。 */
  app.get('/api/admin/title-model', { preHandler: app.requireAdmin }, async () =>
    ok(titleModelConfigSchema.parse(await getTitleModelConfig())),
  )

  /** 整体替换配置（仅 ADMIN）。`enabled` 必填，`modelId` 三态（`null`/省略 = 清除）。 */
  app.put<{ Body: UpdateTitleModelBody }>(
    '/api/admin/title-model',
    { preHandler: app.requireAdmin, schema: { body: updateTitleModelBodySchema } },
    async (request) => ok(titleModelConfigSchema.parse(await setTitleModelConfig(request.body))),
  )
}