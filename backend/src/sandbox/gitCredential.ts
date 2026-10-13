/**
 * git 凭据 → 容器注入物（**纯函数**；P1-9 · R11）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.4（两种凭据的接法）+ §7.2（AAD）+ §7.3（注入时机）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的分工：只把"解密后的凭据"翻译成**两种注入物**，一个 IO 都不做
 * ─────────────────────────────────────────────────────────────────────
 *   · {@link gitCredentialEnv} —— 容器**环境变量**（建容器时定死，`docker create` 的 `Env`）；
 *   · {@link gitCredentialFiles} —— 落 tmpfs `$HOME` 的**文件**（容器起来后 `putArchive`）。
 *
 * IO（解密、`putArchive`）在 `services/gitCredential.service.ts` 与 `sandbox/manager.ts`。
 * 这样"两种凭据各注什么"这条判据可以在不连库、不连 Docker 的情况下逐条自证。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径（对错都不报错，只是行为不对，故写在这里）
 * ─────────────────────────────────────────────────────────────────────
 * ① **HTTPS_TOKEN 不落盘**（§7.4：最干净）：token 只在 env（`GIT_CONFIG_*` 的 `http.*.extraheader`），
 *    与 `sandboxLlmEnv` 的明文 Key 同款 —— 容器回收即消失，不进 `/work`（否则进冷备 / 产物）。
 * ② **SSH_KEY 落 tmpfs `$HOME/.ssh`**（`/home/agent` 是 tmpfs，见 `spec.ts`）：`id_*` 0600、
 *    `known_hosts` 0644、属主 `SANDBOX_AGENT_UID`（否则以非 root agent 跑起来的容器读不到自己的私钥）。
 * ③ **多条按 host 匹配**（§7.4）：HTTPS 靠 `http.https://<host>/.extraheader` 由 git 按 URL 自选；
 *    SSH 把所有 `-i` 都给 `GIT_SSH_COMMAND`（ssh 依次尝试）。没有 SSH 凭据时**不加** `GIT_SSH_COMMAND`，
 *    退回系统默认（行为不变）。
 */

import type { GitCredentialKind, GitCredentialSecretInput } from '@doubulea/shared'

import { SANDBOX_AGENT_HOME, SANDBOX_AGENT_UID } from './spec.js'

/** 一条**解密后**的凭据（明文只在本进程内存与注入物里出现，见 `service` 的文件头） */
export interface GitCredentialPlain {
  kind: GitCredentialKind
  /** 限定用途主机；`null` = 不限 */
  host: string | null
  secret: GitCredentialSecretInput
}

/**
 * 密文的 **AAD 上下文**（§7.2）：`${userId}:${kind}:${label}`。
 * ⚠️ 改了这里的公式，库里已有密文就全部解不开 ⇒ 写（加密）与读（解密）**必须**复用本函数。
 */
export function gitCredentialAad(userId: string, kind: GitCredentialKind, label: string): string {
  return `${userId}:${kind}:${label}`
}

/** SSH 私钥在 `$HOME/.ssh` 下的文件名（第一条 = `id_ed25519`，其余加序号后缀） */
function sshKeyFileName(index: number): string {
  return index === 0 ? 'id_ed25519' : `id_ed25519_${index + 1}`
}

/** 容器内 `$HOME/.ssh/...` 的绝对路径（`GIT_SSH_COMMAND` 里用它） */
function sshPath(name: string): string {
  return `${SANDBOX_AGENT_HOME}/.ssh/${name}`
}

/** 缺省登录名（PAT 通常配 `x-access-token`；GitLab 可用 `oauth2`，故允许覆盖） */
const DEFAULT_TOKEN_USERNAME = 'x-access-token'

/**
 * 凭据 → 容器环境变量（**纯函数**）。
 *
 * ⚠️ 返回值里含 **HTTPS token 的 base64**（`Authorization: Basic`）⇒ 与 `sandboxLlmEnv` /
 * `sandboxProxyEnv` 同一条纪律：只许交给 `buildSandboxContainerSpec`，**不许打日志、不许落库**。
 * （SSH 私钥走 {@link gitCredentialFiles}，不在这里。）
 */
export function gitCredentialEnv(creds: readonly GitCredentialPlain[]): Record<string, string> {
  const env: Record<string, string> = {}
  const ssh = creds.filter((cred) => cred.kind === 'SSH_KEY')
  const https = creds.filter((cred) => cred.kind === 'HTTPS_TOKEN' && (cred.secret.token ?? '') !== '')

  if (ssh.length > 0 || https.length > 0) {
    // 交互式提问会让 `git clone` 在一个无人应答的容器里挂死 ⇒ 一律关掉
    env.GIT_TERMINAL_PROMPT = '0'
  }

  if (ssh.length > 0) {
    const identities = ssh.map((_, index) => `-i ${sshPath(sshKeyFileName(index))}`).join(' ')
    // `accept-new` 而非 `no`：首次可连、之后锁定（避免中间人）；严格 pin 时用落盘的 known_hosts
    env.GIT_SSH_COMMAND =
      `ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new ${identities}`
  }

  if (https.length > 0) {
    // git 的 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`：不落盘的临时配置
    env.GIT_CONFIG_COUNT = String(https.length)
    https.forEach((cred, index) => {
      const username = (cred.secret.username ?? '') === '' ? DEFAULT_TOKEN_USERNAME : (cred.secret.username as string)
      const basic = Buffer.from(`${username}:${cred.secret.token ?? ''}`, 'utf8').toString('base64')
      const host = cred.host ?? ''
      env[`GIT_CONFIG_KEY_${index}`] = host === '' ? 'http.extraheader' : `http.https://${host}/.extraheader`
      env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${basic}`
    })
  }

  return env
}

/** 一个待写入 tmpfs `$HOME` 的文件（`name` 相对 `$HOME`） */
export interface GitCredentialFile {
  /** 相对 `$HOME` 的路径（如 `.ssh/id_ed25519`；目录写 `.ssh/`） */
  name: string
  mode: number
  content: Buffer
}

/**
 * 凭据 → 落 `$HOME` 的文件（**纯函数**；只 SSH_KEY 需要，HTTPS 一律空数组）。
 *
 * 顺序即正确性：**先目录后文件**（`putArchive` 不替我们建父目录且 `.ssh` 的 0700 是刻意钉的）。
 * `known_hosts` 把所有凭据里的非空内容**按输入顺序拼接**（幂等：同一条重复不会有害）。
 */
export function gitCredentialFiles(creds: readonly GitCredentialPlain[]): GitCredentialFile[] {
  const ssh = creds.filter((cred) => cred.kind === 'SSH_KEY' && (cred.secret.privateKey ?? '') !== '')
  if (ssh.length === 0) return []

  const files: GitCredentialFile[] = [{ name: '.ssh/', mode: 0o700, content: Buffer.alloc(0) }]
  ssh.forEach((cred, index) => {
    const key = cred.secret.privateKey as string
    files.push({
      name: `.ssh/${sshKeyFileName(index)}`,
      mode: 0o600,
      // 私钥末尾要有换行（有些 ssh 实现对末行无换行的 key 报错）；已有则不重复加
      content: Buffer.from(key.endsWith('\n') ? key : `${key}\n`, 'utf8'),
    })
  })

  const knownHosts = ssh
    .map((cred) => (cred.secret.knownHosts ?? '').trim())
    .filter((text) => text !== '')
    .join('\n')
  if (knownHosts !== '') {
    files.push({
      name: '.ssh/known_hosts',
      mode: 0o644,
      content: Buffer.from(knownHosts.endsWith('\n') ? knownHosts : `${knownHosts}\n`, 'utf8'),
    })
  }
  return files
}

/** 把 {@link GitCredentialFile} 补上属主（`SANDBOX_AGENT_UID`）—— `putArchive` 用的 tar 条目 */
export function gitCredentialTarEntries(
  files: readonly GitCredentialFile[],
): Array<{ name: string; mode: number; content: Buffer; uid: number; gid: number }> {
  return files.map((file) => ({ ...file, uid: SANDBOX_AGENT_UID, gid: SANDBOX_AGENT_UID }))
}
