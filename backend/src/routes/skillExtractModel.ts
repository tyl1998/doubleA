/**
 * 从会话抽取 Skill 的模型路由（平台级单例；P1-24c-2）
 *
 * 两条端点（**仅 ADMIN**，与 `/api/admin/title-model` 同族）：
 *   `GET /api/admin/skill-extract-model`  读当前配置
 *   `PUT /api/admin/skill-extract-model`  整体替换（总开关 + 选定模型一起交）
 *
 * ⚠️ 抽取本身的端点在 `routes/conversations.ts`（`POST /api/conversations/:id/skills/extract`，
 *    **只需登录**、只允许会话所有者）—— 这里只配"用哪个模型"。
 */

import { ok, skillExtractModelConfigSchema, updateSkillExtractModelBodySchema, type UpdateSkillExtractModelBody } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { getSkillExtractModelConfig, setSkillExtractModelConfig } from '../services/skillExtractModel.service.js'

export function registerSkillExtractModelRoutes(app: FastifyInstance): void {
  app.get('/api/admin/skill-extract-model', { preHandler: app.requireAdmin }, async () =>
    ok(skillExtractModelConfigSchema.parse(await getSkillExtractModelConfig())),
  )

  app.put<{ Body: UpdateSkillExtractModelBody }>(
    '/api/admin/skill-extract-model',
    { preHandler: app.requireAdmin, schema: { body: updateSkillExtractModelBodySchema } },
    async (request) => ok(skillExtractModelConfigSchema.parse(await setSkillExtractModelConfig(request.body))),
  )
}
