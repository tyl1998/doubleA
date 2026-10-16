/**
 * 用户管理路由（P0-1-8，`(A)` 仅 ADMIN）
 *
 * 依据：`docs/02-后端设计.md` §4.2 四个端点 + §四 约定（`(A)` = 仅 ADMIN、列表 offset/limit）
 *
 * 职责边界：校验请求（schema）→ 调 `services/user.service` → 组装信封。
 * 权限用 `preHandler: app.requireAdmin` 声明（`(A)` 端点一律如此）；
 * "不能操作自己"这类业务约束在服务层（见 `user.service.ts` 的注释）。
 *
 * ⚠️ 这四个端点**不在**首登改密闸门的白名单里 —— 也就是说 `must_change_password=true` 的 admin
 * 调它们会先被闸门 403。这是对的：强制改密期间就应该"只能改密、看自己、登出"。
 */

import {
  createUserBodySchema,
  listUsersQuerySchema,
  ok,
  updateUserBodySchema,
  userIdParamsSchema,
  userSearchQuerySchema,
  type CreateUserBody,
  type ListUsersQuery,
  type UpdateUserBody,
  type UserIdParams,
  type UserSearchQuery,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createUser,
  listUsers,
  resetUserPassword,
  searchUsers,
  updateUser,
} from '../services/user.service.js'

export function registerUserRoutes(app: FastifyInstance): void {
  /**
   * 用户搜索（P1-18 · 子批 B，**登录可用**）：受众选择器用。
   * ⚠️ 必须注册在 `/:id` 之前的口径无关紧要（无 `GET /:id`），但**权限是 `requireAuth` 而非 `requireAdmin`**
   * —— 只回 `{id, name}`、只搜 ACTIVE、限量 20。
   */
  app.get<{ Querystring: UserSearchQuery }>(
    '/api/users/search',
    { preHandler: app.requireAuth, schema: { querystring: userSearchQuerySchema } },
    async (request) => ok({ items: await searchUsers(request.query) }),
  )

  /** 列表（`02` §4.2）：offset/limit 分页，默认 20 */
  app.get<{ Querystring: ListUsersQuery }>(
    '/api/users',
    { preHandler: app.requireAdmin, schema: { querystring: listUsersQuerySchema } },
    async (request) => ok(await listUsers(request.query)),
  )

  /**
   * 建号（`02` §4.2）：响应里的 `initialPassword` 是**唯一一次**明文，
   * 前端必须当场展示给管理员（`01` §3.1：admin 建号发初始密码）。
   */
  app.post<{ Body: CreateUserBody }>(
    '/api/users',
    { preHandler: app.requireAdmin, schema: { body: createUserBodySchema } },
    async (request) => ok(await createUser(request.body)),
  )

  /** 启停 / 改角色。操作者身份从会话取（不能操作自己这条约束需要它） */
  app.patch<{ Params: UserIdParams; Body: UpdateUserBody }>(
    '/api/users/:id',
    { preHandler: app.requireAdmin, schema: { params: userIdParamsSchema, body: updateUserBodySchema } },
    async (request) => {
      const { user } = requireAuthContext(request)
      return ok(await updateUser(user.id, request.params.id, request.body))
    },
  )

  /** 重置密码：同样返回一次性的初始密码，并把对方置回"首登必须改密" */
  app.post<{ Params: UserIdParams }>(
    '/api/users/:id/reset-password',
    { preHandler: app.requireAdmin, schema: { params: userIdParamsSchema } },
    async (request) => {
      const { user } = requireAuthContext(request)
      return ok(await resetUserPassword(user.id, request.params.id))
    },
  )
}
