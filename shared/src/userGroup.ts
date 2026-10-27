/**
 * 用户组契约（P1-18 · 子批 B；`子方案/资产共享与用户组标签.md` §四）
 *
 * 组 = **显式成员集合**（有名字、有成员表），由 **ADMIN 维护**，是 Agent「指定用户」受众的
 * **主授权单位**（稳定、可审计）。受众 = 直接指定的用户 ∪ 指定组的成员（并集）。
 *
 * 端点（`06` P1-18 子批 B）：
 *   · `GET    /api/user-groups`             —— **登录可用**的组列表（受众选择器用；只读）
 *   · `GET    /api/admin/groups`            —— 管理列表（`(A)`，含 `memberCount`）
 *   · `POST   /api/admin/groups`            —— 建组
 *   · `GET    /api/admin/groups/:id`        —— 详情（含成员清单）
 *   · `PATCH  /api/admin/groups/:id`        —— 改名 / 改描述
 *   · `PUT    /api/admin/groups/:id/members`—— **整体替换**成员（全量提交，避免增量 diff）
 *   · `DELETE /api/admin/groups/:id`        —— 删组（连带清 `agent_audiences` 里指向它的行）
 *
 * ⚠️ **为什么列表有两个路径**：管理（增删改 + 成员）是 ADMIN 的职责，但**任何登录用户**在给自己的
 * Agent 设「指定用户」受众时都要能**看到并选择**组 ⇒ 需要一个登录可用的只读列表
 * （`GET /api/user-groups`，与 `GET /api/users/search` 同族）。两者共用同一份投影与服务层读取。
 *
 * 受众圈选还需要一个**登录可用**的用户搜索端点（`GET /api/users/search`，见 `user.ts`）。
 */

import { z } from 'zod'

import { offsetPageOf } from './envelope.js'
import { validationMessage } from './i18n/validation.js'

export const USER_GROUP_NAME_MAX_CHARS = 64
export const USER_GROUP_DESCRIPTION_MAX_CHARS = 500

const groupNameSchema = z
  .string({ required_error: validationMessage('validation.userGroup.nameRequired') })
  .trim()
  .min(1, validationMessage('validation.userGroup.nameRequired'))
  .max(
    USER_GROUP_NAME_MAX_CHARS,
    validationMessage('validation.userGroup.nameTooLong', { max: USER_GROUP_NAME_MAX_CHARS }),
  )

const groupDescriptionSchema = z
  .string()
  .trim()
  .max(
    USER_GROUP_DESCRIPTION_MAX_CHARS,
    validationMessage('validation.userGroup.descriptionTooLong', { max: USER_GROUP_DESCRIPTION_MAX_CHARS }),
  )

/** 列表项：组 + 成员数（不含成员明细，列表页据此显示"N 人"） */
export const userGroupItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().min(0),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type UserGroupItem = z.infer<typeof userGroupItemSchema>

/** 一个成员（用户 id + 显示名；昵称优先、回落用户名） */
export const userGroupMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type UserGroupMember = z.infer<typeof userGroupMemberSchema>

/** 详情：组 + 成员清单（受众选择器与组管理页据此回显） */
export const userGroupDetailSchema = userGroupItemSchema.extend({
  members: z.array(userGroupMemberSchema),
})
export type UserGroupDetail = z.infer<typeof userGroupDetailSchema>

// ───────────────────────────── 列表 ─────────────────────────────

export const listUserGroupsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
})
export type ListUserGroupsQuery = z.infer<typeof listUserGroupsQuerySchema>

export const userGroupListResultSchema = offsetPageOf(userGroupItemSchema)
export type UserGroupListResult = z.infer<typeof userGroupListResultSchema>

// ───────────────────────────── 建 / 改 ─────────────────────────────

/** 建组请求体：`name` 唯一（DB 约束），`description` 可省 */
export const createUserGroupBodySchema = z.object({
  name: groupNameSchema,
  description: groupDescriptionSchema.nullish(),
})
export type CreateUserGroupBody = z.infer<typeof createUserGroupBodySchema>

/**
 * 改组请求体：**至少给一个字段**。
 * `description` 走三态（不带 = 不动 / `null` = 清空 / 值 = 设置）。
 */
export const updateUserGroupBodySchema = z
  .object({
    name: groupNameSchema.optional(),
    description: groupDescriptionSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    message: validationMessage('validation.common.atLeastOneField'),
  })
export type UpdateUserGroupBody = z.infer<typeof updateUserGroupBodySchema>

/**
 * 成员**整体替换**（`PUT /api/admin/groups/:id/members`）：提交什么，库里就有什么。
 * `userIds` **必填**，清空要显式传 `[]`（省略 ≠ 清空，与 Agent 组件绑定的口径一致）。
 * 服务层用 `Set` 去重并校验每个用户存在。
 */
export const replaceUserGroupMembersBodySchema = z.object({
  userIds: z.array(z.string().uuid(validationMessage('validation.userGroup.memberIdNotUuid')), {
    required_error: validationMessage('validation.userGroup.userIdsRequired'),
    invalid_type_error: validationMessage('validation.userGroup.userIdsNotArray'),
  }),
})
export type ReplaceUserGroupMembersBody = z.infer<typeof replaceUserGroupMembersBodySchema>

/** 路径参数 */
export const userGroupIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.userGroup.idNotUuid')),
})
export type UserGroupIdParams = z.infer<typeof userGroupIdParamsSchema>
