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

import { validationMessage } from './i18n/validation.js'

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

/**
 * 新密码（建号 / 改密共用）：长度 + 字节双上限；两条消息都直接给用户看。
 *
 * P1-23 末批：消息从"中文正文"改为 **key + 参数**（`@validation.*`，见 `i18n/validation.ts`）——
 * 这是 zod 收口的**样本模块**（登录 / 改密是最先被看到的表单）。其余模块**未动**，
 * 台账见 `docs/子方案/界面语言切换.md` §3.5b。
 * ⚠️ 中文形态逐字未变（译文在字典里），故 zh 下用户看到的话与以前一模一样。
 */
const newPasswordSchema = z
  .string({ required_error: validationMessage('validation.newPasswordRequired') })
  .min(PASSWORD_MIN_LENGTH, validationMessage('validation.newPasswordTooShort', { min: PASSWORD_MIN_LENGTH }))
  .max(PASSWORD_MAX_LENGTH, validationMessage('validation.newPasswordTooLong', { max: PASSWORD_MAX_LENGTH }))
  .refine((value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES, {
    message: validationMessage('validation.newPasswordTooManyBytes', { max: PASSWORD_MAX_BYTES }),
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
    .string({ required_error: validationMessage('validation.usernameRequired') })
    .trim()
    .min(1, validationMessage('validation.usernameRequired'))
    .max(USERNAME_MAX_LENGTH, validationMessage('validation.usernameTooLong', { max: USERNAME_MAX_LENGTH })),
  password: z
    .string({ required_error: validationMessage('validation.passwordRequired') })
    .min(1, validationMessage('validation.passwordRequired'))
    .max(256, validationMessage('validation.passwordTooLongPlain')),
})
export type LoginBody = z.infer<typeof loginBodySchema>

/** 改密请求体（`02` §4.1：旧密码校验；首登强制也走这个端点） */
export const changePasswordBodySchema = z.object({
  oldPassword: z
    .string({ required_error: validationMessage('validation.oldPasswordRequired') })
    .min(1, validationMessage('validation.oldPasswordRequired'))
    .max(256, validationMessage('validation.passwordTooLongPlain')),
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
  /**
   * **本次响应由哪台实例的后端进程发出**（`null` = 非沙箱宿主角色，或未上报）。
   *
   * ⚠️ 它是**这份响应**的属性，不是用户的属性：
   *   · `/api/auth/me` 是**非粘性**路由（落到哪台都正确，见 `shared/router.ts` ①），
   *     多实例下连续的两次 `/me` 可能来自不同实例 ⇒ 这个值**会变**，这是事实而不是抖动；
   *   · 界面要显示"当前后端是谁"应**固定首屏那一次**（管理页），不要每次轮询跟着它跳。
   * 可选：老版本后端不返回该字段（`undefined`）。
   */
  instanceId: z.string().nullable().optional(),
})
export type AuthUser = z.infer<typeof authUserSchema>
