/**
 * Git 凭据页的**纯展示/构造函数**（P1-9 · R11）
 *
 * 单独成文件是为了让"表单 → 请求体"这条判据能**无依赖**自证（同款：`workspaceModel.ts` / `mcpModel.ts`）：
 * 哪些字段该带、哪些该省（"留空 = 不变"的合并语义）错了**都不报错**，只是把用户没填的值清掉。
 *
 * ⚠️ 值不下发（连掩码都没有）⇒ 编辑时**不能整体替换**：只提交这次真改过的字段。
 */

import type {
  CreateGitCredentialBody,
  GitCredentialItem,
  GitCredentialKind,
  UpdateGitCredentialBody,
} from '@doubulea/shared'

/** 表单里的一条凭据（编辑时秘密字段留空 = 不变） */
export interface GitCredentialFormValues {
  label: string
  kind: GitCredentialKind
  host?: string
  privateKey?: string
  knownHosts?: string
  token?: string
  username?: string
}

/** 类型 → 中文读数 */
export const GIT_CREDENTIAL_KIND_LABEL: Record<GitCredentialKind, string> = {
  SSH_KEY: 'SSH 私钥',
  HTTPS_TOKEN: 'HTTPS 令牌',
}

/** `host` 输入 → 契约值：空白 = `null`（不限） */
export function gitCredentialHost(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** 表单 → **新建** body（秘密字段只带真填过的；`kind` 决定带哪些） */
export function gitCredentialCreateBody(values: GitCredentialFormValues): CreateGitCredentialBody {
  return {
    label: values.label.trim(),
    kind: values.kind,
    host: gitCredentialHost(values.host),
    ...(values.kind === 'SSH_KEY'
      ? {
          ...(values.privateKey ? { privateKey: values.privateKey } : {}),
          ...(values.knownHosts ? { knownHosts: values.knownHosts } : {}),
        }
      : {
          ...(values.token ? { token: values.token } : {}),
          ...(values.username ? { username: values.username.trim() } : {}),
        }),
  }
}

/**
 * 表单 + 当前条目 → **更新** body（**合并语义**：只带真改过的字段）。
 * `kind` 不可改（换类型 = 另一条凭据），故不在这里出现。
 */
export function gitCredentialUpdateBody(
  item: GitCredentialItem,
  values: GitCredentialFormValues,
): UpdateGitCredentialBody {
  const nextLabel = values.label.trim()
  const nextHost = gitCredentialHost(values.host)
  return {
    // label 变了才带（进 AAD ⇒ 服务端会重加密）
    ...(nextLabel !== item.label ? { label: nextLabel } : {}),
    ...(nextHost !== item.host ? { host: nextHost } : {}),
    ...(values.kind === 'SSH_KEY'
      ? {
          ...(values.privateKey ? { privateKey: values.privateKey } : {}),
          ...(values.knownHosts ? { knownHosts: values.knownHosts } : {}),
        }
      : {
          ...(values.token ? { token: values.token } : {}),
          ...(values.username ? { username: values.username.trim() } : {}),
        }),
  }
}
