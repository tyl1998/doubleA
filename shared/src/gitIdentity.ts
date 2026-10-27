/**
 * 用户级 **git 提交身份**契约（P1-20）
 *
 * 依据（用户反馈 2026-10-15）：容器里原本没有 git 身份 ⇒ agent 只能自己猜（沿用 SSH key 的身份）
 * 并写进仓库本地 config，错了还得 `git commit --amend` + 强推。改为**平台按会话发起者注入**：
 * 派活时把这两个值经 `GIT_CONFIG_*` 交给容器 git 的 `user.name`/`user.email`。
 *
 * 与 `gitCredential.ts` 同族（都是**用户级**、`/settings/credentials` 里配），但属性相反：
 *   · 凭据是**秘密**（有进无出、只在 git 用时按需回调取回）；
 *   · 身份是**公开信息**（提交署名），可读可回填、随 env 注入容器，**不落盘**。
 *
 * ⚠️ 两个字段都可空：都为空 = 平台不注入（行为与引入前一致，agent 自行处理）。
 */

import { z } from 'zod'

import { validationMessage } from './i18n/validation.js'

/** git `user.name` 上限（与 `users.git_name` 列宽一致） */
export const GIT_IDENTITY_NAME_MAX = 128
/** git `user.email` 上限（与 `users.git_email` 列宽一致） */
export const GIT_IDENTITY_EMAIL_MAX = 255

/** 当前用户的 git 身份（`GET /api/git-identity` 的 `data`） */
export const gitIdentitySchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
})
export type GitIdentity = z.infer<typeof gitIdentitySchema>

/**
 * 邮箱的**轻校验**：非空时必须含 `@` 且两侧无空白。
 *
 * 刻意不追求 RFC 5322 完整校验 —— git 只把它当字符串写进 commit，"像不像邮箱"由使用者负责；
 * 这里只挡明显的手误（漏 `@`、带空格）。空串按"没填"处理（服务层归一成 `null`）。
 */
const gitEmailField = z
  .string()
  .trim()
  .max(
    GIT_IDENTITY_EMAIL_MAX,
    validationMessage('validation.gitIdentity.emailTooLong', { max: GIT_IDENTITY_EMAIL_MAX }),
  )
  .refine(
    (value) => value === '' || /^[^\s@]+@[^\s@]+$/u.test(value),
    validationMessage('validation.gitIdentity.emailInvalid'),
  )
  .nullable()

const gitNameField = z
  .string()
  .trim()
  .max(
    GIT_IDENTITY_NAME_MAX,
    validationMessage('validation.gitIdentity.nameTooLong', { max: GIT_IDENTITY_NAME_MAX }),
  )
  .nullable()

/**
 * `PUT /api/git-identity` 请求体：**缺省即不动**（两态），`null` / 空串 = 清空该字段。
 * 至少给一个字段（全不给是无意义的一次写）。
 */
export const updateGitIdentityBodySchema = z
  .object({
    name: gitNameField.optional(),
    email: gitEmailField.optional(),
  })
  .refine((body) => body.name !== undefined || body.email !== undefined, {
    message: validationMessage('validation.gitIdentity.atLeastOne'),
  })
export type UpdateGitIdentityBody = z.infer<typeof updateGitIdentityBodySchema>

/**
 * 归一化：trim 后空串一律变 `null`（"没填"只有一种表示）—— **纯函数**，服务层与回归共用。
 */
export function normalizeGitIdentity(input: { name?: string | null; email?: string | null }): GitIdentity {
  const name = (input.name ?? '').trim()
  const email = (input.email ?? '').trim()
  return { name: name === '' ? null : name, email: email === '' ? null : email }
}

/** 容器 side：把身份折成 `GIT_CONFIG_*` 的键值对（**纯函数**；空值不产生条目） */
export function gitIdentityConfigEntries(identity: GitIdentity): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = []
  if (identity.name !== null && identity.name !== '') entries.push({ key: 'user.name', value: identity.name })
  if (identity.email !== null && identity.email !== '') entries.push({ key: 'user.email', value: identity.email })
  return entries
}
