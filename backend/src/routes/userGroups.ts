/**
 * 用户组路由（P1-18 · 子批 B，`(A)` 仅 ADMIN）
 *
 * 依据：`06` P1-18 子批 B + `shared/src/userGroup.ts` 契约。
 * 职责：校验请求（schema）→ 调 `services/userGroup.service` → 组装信封。
 * 权限用 `preHandler: app.requireAdmin` 声明（组由 ADMIN 维护，不做自组织）。
 */

import {
  createUserGroupBodySchema,
  listUserGroupsQuerySchema,
  ok,
  replaceUserGroupMembersBodySchema,
  updateUserGroupBodySchema,
  userGroupIdParamsSchema,
  type CreateUserGroupBody,
  type ListUserGroupsQuery,
  type ReplaceUserGroupMembersBody,
  type UpdateUserGroupBody,
  type UserGroupIdParams,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import {
  createUserGroup,
  getUserGroup,
  listUserGroups,
  removeUserGroup,
  replaceUserGroupMembers,
  updateUserGroup,
} from '../services/userGroup.service.js'

export function registerUserGroupRoutes(app: FastifyInstance): void {
  /**
   * **登录可用**的组列表（受众选择器用；只读）。
   *
   * ⚠️ 与 `/api/admin/groups` 共用同一份服务层读取与投影 —— 区别只在**权限**：管理组是 ADMIN 的职责，
   * 但任何登录用户在给自己的 Agent 设「指定用户」受众时都要能看到并选择组（`03` §4.4）。
   */
  app.get<{ Querystring: ListUserGroupsQuery }>(
    '/api/user-groups',
    { preHandler: app.requireAuth, schema: { querystring: listUserGroupsQuerySchema } },
    async (request) => ok(await listUserGroups(request.query)),
  )

  /** 管理列表（`(A)`）：与上面同一份数据，供 ADMIN 的管理页使用 */
  app.get<{ Querystring: ListUserGroupsQuery }>(
    '/api/admin/groups',
    { preHandler: app.requireAdmin, schema: { querystring: listUserGroupsQuerySchema } },
    async (request) => ok(await listUserGroups(request.query)),
  )

  /** 建组（`(A)`）：名称唯一；冲突 409 */
  app.post<{ Body: CreateUserGroupBody }>(
    '/api/admin/groups',
    { preHandler: app.requireAdmin, schema: { body: createUserGroupBodySchema } },
    async (request) => ok(await createUserGroup(request.body)),
  )

  /** 详情（`(A)`）：含成员清单 */
  app.get<{ Params: UserGroupIdParams }>(
    '/api/admin/groups/:id',
    { preHandler: app.requireAdmin, schema: { params: userGroupIdParamsSchema } },
    async (request) => ok(await getUserGroup(request.params.id)),
  )

  /** 改组（`(A)`）：改名 / 改描述（三态） */
  app.patch<{ Params: UserGroupIdParams; Body: UpdateUserGroupBody }>(
    '/api/admin/groups/:id',
    {
      preHandler: app.requireAdmin,
      schema: { params: userGroupIdParamsSchema, body: updateUserGroupBodySchema },
    },
    async (request) => ok(await updateUserGroup(request.params.id, request.body)),
  )

  /** 成员整体替换（`(A)`）：全量提交，清空传 `[]` */
  app.put<{ Params: UserGroupIdParams; Body: ReplaceUserGroupMembersBody }>(
    '/api/admin/groups/:id/members',
    {
      preHandler: app.requireAdmin,
      schema: { params: userGroupIdParamsSchema, body: replaceUserGroupMembersBodySchema },
    },
    async (request) => ok(await replaceUserGroupMembers(request.params.id, request.body)),
  )

  /** 删组（`(A)`）：连带清掉指向它的 Agent 受众行（多态外键无 FK，见服务层） */
  app.delete<{ Params: UserGroupIdParams }>(
    '/api/admin/groups/:id',
    { preHandler: app.requireAdmin, schema: { params: userGroupIdParamsSchema } },
    async (request) => ok(await removeUserGroup(request.params.id)),
  )
}
