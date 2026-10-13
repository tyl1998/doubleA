/**
 * git 凭据路由（P1-9 · R11）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7（git 凭据：平台配置 + 容器内注入）；
 *      `shared/src/gitCredential.ts`（契约）+ `services/gitCredential.service.ts`（服务）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与会话/产物同族：**权限收窄在 `user_id` 上，ADMIN 无后门**
 * ─────────────────────────────────────────────────────────────────────
 * 四条路由全挂 `requireAuth`（**不是** `requireAdmin` —— 凭据是"每个登录用户自己的东西"），
 * "只能动自己的"由服务层的 `viewer.userId` 收窄：`where: { id, userId }`，别人的行进不了读写路径。
 * ⚠️ 路径里**有**行 id（不像 MCP 凭据靠 `(serverId, 我)` 推）：因为 git 凭据没有"哪台 server"这个维度，
 *    一个用户可能同时配 `github-work` 与 `gitlab-personal` 两条。行 id 只用于**定位我自己的行**，
 *    服务层拿 `(id, userId)` 一起收窄 ⇒ 拿别人的 id 只会得到 404。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条路由与它们的信封
 * ─────────────────────────────────────────────────────────────────────
 *   GET    /            → `{ items }`（**刻意不分页**：一个用户最多几条）
 *   POST   /            → **裸 `GitCredentialItem`**
 *   PUT    /:id         → **裸 `GitCredentialItem`**
 *   DELETE /:id         → `{ id, label }`（"删类多回 `{id,<name>}`"这一族）
 *
 * ⚠️ 值不下发（连掩码都没有）⇒ 前端无从回填 ⇒ `PUT` 的秘密字段是**合并语义**（只动提交里出现的）。
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createGitCredentialBodySchema,
  gitCredentialIdParamsSchema,
  ok,
  updateGitCredentialBodySchema,
  type CreateGitCredentialBody,
  type GitCredentialIdParams,
  type UpdateGitCredentialBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createGitCredential,
  listMyGitCredentials,
  removeGitCredential,
  updateGitCredential,
  type GitCredentialViewer,
} from '../services/gitCredential.service.js'

/** 取调用者。`requireAuth` 挂了 ⇒ 走到 handler 就一定有身份（`requireAuthContext` 会抛 401 兜漏挂） */
function viewerOf(request: FastifyRequest): GitCredentialViewer {
  return { userId: requireAuthContext(request).user.id }
}

export function registerGitCredentialRoutes(app: FastifyInstance): void {
  /** 我的 git 凭据清单（登录即可） */
  app.get('/api/git-credentials', { preHandler: app.requireAuth }, async (request) =>
    ok(await listMyGitCredentials(viewerOf(request))),
  )

  /** 新建一条（登录即可）。**裸条目**响应；`label` 撞车 ⇒ 409 */
  app.post<{ Body: CreateGitCredentialBody }>(
    '/api/git-credentials',
    { preHandler: app.requireAuth, schema: { body: createGitCredentialBodySchema } },
    async (request) => ok(await createGitCredential(request.body, viewerOf(request))),
  )

  /** 更新一条（登录即可）。秘密字段**合并语义**（只动提交里出现的） */
  app.put<{ Params: GitCredentialIdParams; Body: UpdateGitCredentialBody }>(
    '/api/git-credentials/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: gitCredentialIdParamsSchema, body: updateGitCredentialBodySchema },
    },
    async (request) => ok(await updateGitCredential(request.params.id, request.body, viewerOf(request))),
  )

  /** 删除一条（登录即可）。⚠️ **本来就没有 ⇒ 404**（不是幂等 200） */
  app.delete<{ Params: GitCredentialIdParams }>(
    '/api/git-credentials/:id',
    { preHandler: app.requireAuth, schema: { params: gitCredentialIdParamsSchema } },
    async (request) => ok(await removeGitCredential(request.params.id, viewerOf(request))),
  )
}
