/**
 * 用户级 git 提交身份服务（P1-20）
 *
 * 依据（用户反馈 2026-10-15）：容器里原本没有 git 身份 ⇒ agent 自己猜署名并写进仓库本地 config。
 * 改为**平台按会话发起者注入**：本服务只管读写用户行上的 `git_name`/`git_email`；注入在
 * `sandbox/manager.ts`（派活时经 `computeGitIdentity` → `gitCredentialHelperEnv`）。
 *
 * 与 `gitCredential.service.ts` 同族的纪律：**权限收窄在 `user_id` 上、没有后门**（调用方给的一定是
 * 会话本人的 id）；但身份是公开信息（提交署名），可读可回填，不像凭据那样"有进无出"。
 *
 * ⚠️ 空串归一成 `null`（`normalizeGitIdentity`）：库里只有"有值 / 没值"两种表示，不留空字符串。
 */

import { normalizeGitIdentity, type GitIdentity, type UpdateGitIdentityBody } from '@doubulea/shared'

import { getPrisma } from '../infra/prisma.js'

/** 读当前用户的 git 身份（未配置时两个字段都是 `null`） */
export async function getGitIdentity(userId: string): Promise<GitIdentity> {
  const row = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { gitName: true, gitEmail: true },
  })
  return normalizeGitIdentity({ name: row?.gitName, email: row?.gitEmail })
}

/**
 * 更新当前用户的 git 身份（**缺省即不动**）：`null` / 空串 = 清空该字段。
 * 两个字段都保留原值式写入，不会"没给就清空"。
 */
export async function updateGitIdentity(userId: string, body: UpdateGitIdentityBody): Promise<GitIdentity> {
  const normalized = normalizeGitIdentity(body)
  const row = await getPrisma().user.update({
    where: { id: userId },
    data: {
      ...(body.name === undefined ? {} : { gitName: normalized.name }),
      ...(body.email === undefined ? {} : { gitEmail: normalized.email }),
    },
    select: { gitName: true, gitEmail: true },
  })
  return normalizeGitIdentity({ name: row.gitName, email: row.gitEmail })
}
