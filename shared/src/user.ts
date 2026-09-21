/**
 * 用户管理契约（P0-1-8，`(A)` 仅 ADMIN）
 *
 * 依据：`02-后端设计.md` §4.2（四个端点：列表 / 建号 / 启停与改角色 / 重置密码）
 *      + §4.2 落地约定「建号即 `must_change_password=true`」「初始密码仅此一次明文」
 *      + `01` §3.1 需求 2（admin 建号 / 启停 / 重置密码 / 列表）
 *
 * 与 `auth.ts` 的分工：那边是**本人**的认证（登录、改密、当前用户）；这边是**管理员**对别人账号的
 * 管理操作。两者的取值域（角色/状态）与用户名/密码口径共用 `auth.ts` 的常量，不重复定义。
 *
 * 前端页面：`/admin/users`（`03` §二，ADMIN）。
 */

import { z } from 'zod'

import { USER_ROLES, USER_STATUSES, USERNAME_MAX_LENGTH } from './auth.js'
import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 列表项 ─────────────────────────────

/**
 * 用户列表/建号/重置密码的**统一输出形态**。
 *
 * ⚠️ 刻意**不含** `passwordHash`：`02` §十 不变式「任何读接口都不得带出该列」。
 * 也不含 `initialPassword` —— 那个只在**建号/重置那一次**的响应里出现（见下）。
 */
export const userListItemSchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string().nullable(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  mustChangePassword: z.boolean(),
  /** ISO 8601（前端排序/展示用；DB 侧是 `timestamptz(3)`） */
  createdAt: z.string(),
})
export type UserListItem = z.infer<typeof userListItemSchema>

// ───────────────────────────── 列表查询 ─────────────────────────────

/** 列表分页参数（`02` §四：除消息外的列表用 offset/limit，默认 20） */
export const listUsersQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const userListResultSchema = offsetPageOf(userListItemSchema)
export type UserListResult = z.infer<typeof userListResultSchema>

// ───────────────────────────── 建号 ─────────────────────────────

/**
 * 用户名的**建号侧**校验：与登录侧同一套口径（trim → 1~64 字符），额外要求**不含空白字符**。
 *
 * 为什么额外加这一条：用户名是 admin 口头/邮件发给同事、对方手敲进登录框的东西 ——
 * 内部含空格（或 Tab/换行）的用户名看起来像两个词、抄写时极易出错，而且换行还会把日志行拆散。
 * 归一化（转小写）由 `normalizeUsername` 在服务层做，这里只拒绝明显不可用的形态。
 */
export const newUsernameSchema = z
  .string({ required_error: '请输入用户名' })
  .trim()
  .min(1, '请输入用户名')
  .max(USERNAME_MAX_LENGTH, `用户名最多 ${USERNAME_MAX_LENGTH} 个字符`)
  .regex(/^\S+$/, '用户名不能包含空格等空白字符')

/** 建号请求体：`role` 缺省为 MEMBER（与 DB 默认一致）；初始密码由服务端生成，**不由调用方指定** */
export const createUserBodySchema = z.object({
  username: newUsernameSchema,
  nickname: z
    .string()
    .trim()
    .max(64, '显示名最多 64 个字符')
    // 空串按"没填"处理（否则会在库里留下一个空字符串的 nickname，前端还得区分 '' 与 null）
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  role: z.enum(USER_ROLES, { errorMap: () => ({ message: `role 只能是 ${USER_ROLES.join('/')}` }) }).optional(),
})
export type CreateUserBody = z.infer<typeof createUserBodySchema>

// ───────────────────────────── 启停 / 改角色 ─────────────────────────────

/**
 * `PATCH /api/users/:id` 请求体：**至少给一个字段**。
 * 采用"缺省即不动"的两态（不是 `P0-1-10` 里凭据的三态）：这里两个字段都是枚举，
 * 「清空」在语义上不存在，所以不需要用 `null` 表达清空。
 */
export const updateUserBodySchema = z
  .object({
    status: z.enum(USER_STATUSES, { errorMap: () => ({ message: `status 只能是 ${USER_STATUSES.join('/')}` }) }).optional(),
    role: z.enum(USER_ROLES, { errorMap: () => ({ message: `role 只能是 ${USER_ROLES.join('/')}` }) }).optional(),
  })
  .refine((body) => body.status !== undefined || body.role !== undefined, {
    message: '至少要提供 status 或 role 之一',
  })
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const userIdParamsSchema = z.object({
  id: z.string().uuid('用户 ID 不是合法 UUID'),
})
export type UserIdParams = z.infer<typeof userIdParamsSchema>

// ───────────────────────────── 建号 / 重置密码 的响应 ─────────────────────────────

/**
 * 「初始密码仅此一次明文返回」的响应形态（建号与重置密码共用）。
 *
 * `initialPassword` 是**唯一**会出现明文密码的字段：只在这一次响应里出现，
 * 之后任何列表/详情接口都不会再带（`01` §3.2 同款口径：密钥零下发）。
 * 后端日志里也要按敏感字段打码（`infra/logger.ts` 的 `LOG_REDACT_PATHS` 已含 `initialPassword`）。
 */
export const initialPasswordResultSchema = z.object({
  user: userListItemSchema,
  /** 服务端生成的初始密码（`generateInitialPassword()`，18 字符、无易混字符）；用户首登必须改密 */
  initialPassword: z.string(),
})
export type InitialPasswordResult = z.infer<typeof initialPasswordResultSchema>
