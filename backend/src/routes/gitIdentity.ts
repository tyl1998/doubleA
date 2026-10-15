/**
 * git 提交身份路由（P1-20）
 *
 * 依据：`shared/src/gitIdentity.ts`（契约）+ `services/gitIdentity.service.ts`（服务）
 *      + `docs/子方案/Code模式工作区.md` §五 7（git 相关：平台配置 + 容器注入）。
 *
 * 两条路由，**仅本人**（挂 `requireAuth` 而不是 `requireAdmin`；"我的"由 `requireAuthContext` 的
 * 用户 id 收窄，与 git 凭据同款，ADMIN 无后门）：
 *   GET /api/git-identity → `{ name, email }`（都可为 `null`）
 *   PUT /api/git-identity → 同构（缺省即不动，`null`/空串 = 清空该字段）
 */

import { ok, updateGitIdentityBodySchema, type UpdateGitIdentityBody } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import { getGitIdentity, updateGitIdentity } from '../services/gitIdentity.service.js'

export function registerGitIdentityRoutes(app: FastifyInstance): void {
  app.get('/api/git-identity', { preHandler: app.requireAuth }, async (request) =>
    ok(await getGitIdentity(requireAuthContext(request).user.id)),
  )

  app.put<{ Body: UpdateGitIdentityBody }>(
    '/api/git-identity',
    { preHandler: app.requireAuth, schema: { body: updateGitIdentityBodySchema } },
    async (request) => ok(await updateGitIdentity(requireAuthContext(request).user.id, request.body)),
  )
}
