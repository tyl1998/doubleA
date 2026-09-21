/**
 * 认证与用户契约（P0-1-7）
 *
 * 依据：`02-后端设计.md` §4.1（四个认证端点 + 「首登强制改密期间除 password/me/logout 全 403」的注记）、
 *      §4.2（用户管理：启停 / 改角色 的取值域）、§十（登录限速 5 次 / 10 分钟）、
 *      `01` §3.1 需求 1/2/3（登录登出 / 用户管理 / 修改密码）
 *
 * 施工纪律第 5 条：**zod schema 定义在 `shared/`，前后端共用**（前端登录页与改密页直接用
 * 这里的 schema 做表单校验，避免"后端能过、前端不让填"这类口径漂移）。
 *
 * ⚠️ 本文件必须**浏览器可执行**（前端 import 运行期值，不只是类型）：不引用 `Buffer`、
 *    `node:*` 等 Node 专有 API，UTF-8 字节数自己算（见 {@link utf8ByteLength}）。
 */

import { z } from 'zod'

// ───────────────────────────── 取值域（与 Prisma 枚举、`02` §三 一一对应）─────────────────────────────

/** 用户角色（`02` §4.2：仅 ADMIN / MEMBER，无自注册） */
export const USER_ROLES = ['ADMIN', 'MEMBER'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** 用户状态（`02` §4.2：启停；刻意没有 DELETED —— 本系统不删用户） */
export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

// ───────────────────────────── 用户名 ─────────────────────────────

/** 用户名上限（与 `users.username` 的 `@db.VarChar(64)` 一致） */
export const USERNAME_MAX_LENGTH = 64

/**
 * 用户名归一化：去首尾空白 + 转小写。
 *
 * 为什么需要它：`users.username` 的唯一性是 **PG 默认的大小写敏感**（P0-1-5 定案），
 * 而"登录时大小写不敏感"是产品口径（`01` §3.1：账号是 admin 口头/邮件发给同事的，
 * 大小写抄错就不该登不上）。两层语义的对接方式是：**写入与查询前都先归一**，
 * 而不是给列加 `citext`（那会让 Prisma 的 `@db.` 映射变复杂，收益不抵成本）。
 *
 * P0-1-8 建号时必须用**同一个函数**，否则会出现"建号存了大写、登录查小写"的幽灵账号。
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

// ───────────────────────────── 密码策略 ─────────────────────────────

/** 密码最少字符数（新建/改密时校验；登录时不校验，见下方 loginBodySchema） */
export const PASSWORD_MIN_LENGTH = 8
/** 密码最多字符数 */
export const PASSWORD_MAX_LENGTH = 64
/**
 * 密码最多 **UTF-8 字节数** = bcrypt 的硬上限（只处理前 72 字节，超出部分**静默忽略**）。
 * 与字符数上限并存的原因：中文一个字 3 字节，64 字符最多 192 字节 —— 只看字符数会放进
 * 一个"后半段随便改都还能登录"的密码（详见 `issue_fix/问题记录-P0-1-6-...` 坑 2）。
 */
export const PASSWORD_MAX_BYTES = 72

/**
 * UTF-8 字节数（**不依赖 `Buffer`**，前端也要能跑）。
 * 按码点计数：ASCII 1 字节、拉丁/希腊等 2 字节、中日韩 3 字节、emoji 等 4 字节 ——
 * 与 Node 的 `Buffer.byteLength(s, 'utf8')` 一致，验收里有对照断言。
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint < 0x80) bytes += 1
    else if (codePoint < 0x800) bytes += 2
    else if (codePoint < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 新密码（建号 / 改密共用）：长度 + 字节双上限；两条消息都直接给用户看 */
const newPasswordSchema = z
  .string({ required_error: '请输入新密码' })
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 个字符`)
  .refine((value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES, {
    message: `密码过长（最多 ${PASSWORD_MAX_BYTES} 字节，中文按 3 字节计）`,
  })

// ───────────────────────────── 请求体 schema ─────────────────────────────

/**
 * 登录请求体。
 *
 * ⚠️ 登录**刻意不套密码策略**（只要非空）：策略是"写入侧"的约束，
 * 若登录也按策略卡，历史账号（或将来放宽策略前建的账号）会出现"密码对但登不进来"。
 * 这里只给一个防止请求体滥用的宽松上限。
 */
export const loginBodySchema = z.object({
  username: z
    .string({ required_error: '请输入用户名' })
    .trim()
    .min(1, '请输入用户名')
    .max(USERNAME_MAX_LENGTH, `用户名最多 ${USERNAME_MAX_LENGTH} 个字符`),
  password: z.string({ required_error: '请输入密码' }).min(1, '请输入密码').max(256, '密码过长'),
})
export type LoginBody = z.infer<typeof loginBodySchema>

/** 改密请求体（`02` §4.1：旧密码校验；首登强制也走这个端点） */
export const changePasswordBodySchema = z.object({
  oldPassword: z.string({ required_error: '请输入当前密码' }).min(1, '请输入当前密码').max(256, '密码过长'),
  newPassword: newPasswordSchema,
})
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>

// ───────────────────────────── 响应体 ─────────────────────────────

/**
 * 「当前用户」——`/api/auth/login` 与 `/api/auth/me` 的 `data` 同构。
 *
 * 刻意**不含** `status`：能拿到这份数据就一定是 ACTIVE（`requireAuth` 已校验），
 * 多一个恒为 ACTIVE 的字段只会让前端多写一段没意义的分支。
 * 也**不含** `passwordHash`（`02` §十 不变式：任何读接口都不得带出该列）。
 */
export const authUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  /** 显示名；未设置时为 null（前端回落到 username） */
  nickname: z.string().nullable(),
  role: z.enum(USER_ROLES),
  /** 首登强制改密标记：true 时前端必须把用户导到改密页（后端也会 403 兜住） */
  mustChangePassword: z.boolean(),
})
export type AuthUser = z.infer<typeof authUserSchema>
