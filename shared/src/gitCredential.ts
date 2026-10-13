/**
 * git 凭据契约（P1-9 · R11）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7（git 凭据：平台配置 + 容器内注入）+ §十三 已决 8
 *      + §十一（`GIT_CREDENTIAL_MAX_PER_USER` 默认 5）；`docs/06-实施计划.md` §五·补 P1-9 剩余清单 R11。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条与 MCP 凭据同族、但**刻意不同**的口径（读 `mcp.ts` 的凭据段连着看）
 * ─────────────────────────────────────────────────────────────────────
 * ① **用户级、不绑 server**：一条 git 凭据 = 一个用户的一把私钥 / 一个 PAT。
 *    行由 `id` 标识（不像 MCP 凭据靠 `(serverId, 我)` 推出来）—— 因为这里没有"哪台 server"这个维度，
 *    一个用户可能同时配 `github-work` 与 `gitlab-personal` 两条（`label` 是人的可读名，用户内唯一）。
 * ② **值有进无出**：出参只有 `hasValue`，连掩码都没有（同 MCP 凭据：这是"每个人自己的令牌"）。
 * ③ **清空 = 删行**：不存空密文（结构合法的空密文会让"已配置"永远为真）。
 *
 * ⚠️ `host` 是**限定用途主机**（`github.com`）：空 = 不限。多条凭据时按 host 匹配（§7.4）。
 */

import { z } from 'zod'

/**
 * 凭据类型。`SSH_KEY` = 一把私钥（落 tmpfs `$HOME/.ssh`）；`HTTPS_TOKEN` = 一个 PAT（**不落盘**、只进 env）。
 * ⚠️ **优先 HTTPS_TOKEN**（§7.4）：token 不落盘、可细粒度 scope、易轮换；SSH 仅在必要时用。
 */
export const GIT_CREDENTIAL_KINDS = ['SSH_KEY', 'HTTPS_TOKEN'] as const
export type GitCredentialKind = (typeof GIT_CREDENTIAL_KINDS)[number]
export const gitCredentialKindSchema = z.enum(GIT_CREDENTIAL_KINDS)

/** `label` 上限（人可读名，如 `github-work`） */
export const GIT_CREDENTIAL_LABEL_MAX = 128
/** `host` 上限（限定用途主机，如 `github.com`） */
export const GIT_CREDENTIAL_HOST_MAX = 255
/**
 * 单用户凭据条数上限的**默认值**（后端从 `config.gitCredential.maxPerUser`
 * = `GIT_CREDENTIAL_MAX_PER_USER` 读；此常量供契约文档与前端提示复用）。
 */
export const GIT_CREDENTIAL_MAX_PER_USER_DEFAULT = 5

/** 一条凭据的**响投影**（唯一的出口，见文件头 ②：没有"值"这个字段） */
export const gitCredentialItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: gitCredentialKindSchema,
  /** 限定用途主机；`null` = 不限 */
  host: z.string().nullable(),
  /** 解密成功才算有值（与 MCP 凭据同判据：AAD 是绑定而不是格式） */
  hasValue: z.boolean(),
  updatedAt: z.string(),
})
export type GitCredentialItem = z.infer<typeof gitCredentialItemSchema>

export const gitCredentialListResultSchema = z.object({
  items: z.array(gitCredentialItemSchema),
})
export type GitCredentialListResult = z.infer<typeof gitCredentialListResultSchema>

/**
 * 明文形态的秘密字段（**不进任何响应**；只用于"提交给后端加密"与"后端解密后注入容器"两端）。
 *
 * ⚠️ 与 `kind` 的匹配由**服务层**判（schema 层刻意不做判别联合 —— 一套字段两处校验必腐烂）：
 *   · `SSH_KEY` ⇒ 必填 `privateKey`；`knownHosts` 可选；
 *   · `HTTPS_TOKEN` ⇒ 必填 `token`；`username` 可选（缺省 `x-access-token`）。
 */
export interface GitCredentialSecretInput {
  privateKey?: string
  knownHosts?: string
  token?: string
  username?: string
}

/** `host` 形状：去空白、1~255 字符 */
const hostFieldSchema = z.string().trim().min(1).max(GIT_CREDENTIAL_HOST_MAX)

/** 新建一条凭据（`POST /api/git-credentials`） */
export const createGitCredentialBodySchema = z.object({
  label: z.string().trim().min(1).max(GIT_CREDENTIAL_LABEL_MAX),
  kind: gitCredentialKindSchema,
  /** 不传 / `null` = 不限主机 */
  host: hostFieldSchema.nullish(),
  privateKey: z.string().min(1).optional(),
  knownHosts: z.string().optional(),
  token: z.string().min(1).optional(),
  username: z.string().trim().max(GIT_CREDENTIAL_LABEL_MAX).optional(),
})
export type CreateGitCredentialBody = z.infer<typeof createGitCredentialBodySchema>

/**
 * 更新一条凭据（`PUT /api/git-credentials/:id`）。
 *
 * ⚠️ **秘密字段是"合并语义"**（只动提交里出现的字段）：值不下发 ⇒ 前端无从回填 ⇒
 * 只改 `label` 时提交空对象是合法的（不该把没动的私钥/令牌清掉）。
 * 与 MCP 凭据的"空串 = 清空该 key"不同：这里**没有部分清空**（要清就删整条，见文件头 ③）。
 */
export const updateGitCredentialBodySchema = z.object({
  label: z.string().trim().min(1).max(GIT_CREDENTIAL_LABEL_MAX).optional(),
  host: hostFieldSchema.nullish(),
  privateKey: z.string().min(1).optional(),
  knownHosts: z.string().optional(),
  token: z.string().min(1).optional(),
  username: z.string().trim().max(GIT_CREDENTIAL_LABEL_MAX).optional(),
})
export type UpdateGitCredentialBody = z.infer<typeof updateGitCredentialBodySchema>

export const gitCredentialIdParamsSchema = z.object({ id: z.string().uuid() })
export type GitCredentialIdParams = z.infer<typeof gitCredentialIdParamsSchema>

export const removeGitCredentialResultSchema = z.object({
  id: z.string(),
  label: z.string(),
})
export type RemoveGitCredentialResult = z.infer<typeof removeGitCredentialResultSchema>

/**
 * 按 `kind` 校验"必填的秘密字段是否齐全"（**纯函数**，服务层与回归测试共用一处判据）。
 * @returns 缺失的字段名列表（空数组 = 齐全）
 */
export function missingGitCredentialSecretFields(
  kind: GitCredentialKind,
  secret: GitCredentialSecretInput,
): string[] {
  const missing: string[] = []
  if (kind === 'SSH_KEY') {
    if (secret.privateKey === undefined || secret.privateKey === '') missing.push('privateKey')
  } else {
    if (secret.token === undefined || secret.token === '') missing.push('token')
  }
  return missing
}
