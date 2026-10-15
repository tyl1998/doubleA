/**
 * git 凭据 → 容器侧的**按需拉取**契约（**纯函数**；P1-9 · R11 修订）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.4 / §7.5（出网与凭据口径）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 为什么改成"按需拉取"（R11 原设计的两条死路）
 * ═══════════════════════════════════════════════════════════════════════
 * 原设计是**建容器时一次性注入**：HTTPS token 进 env、SSH 私钥 `putArchive` 落到 tmpfs `$HOME`。
 * 两条都断了：
 *   ① **SSH 私钥注不进去** —— 容器 `ReadonlyRootfs: true`，Docker 的归档 API（`putArchive` / `docker cp`）
 *      在只读 rootfs 容器上**直接 400 拒绝**（即便是 tmpfs 目标）⇒ `$HOME/.ssh` 从来是空的，
 *      而容器 env 里的 `GIT_SSH_COMMAND -i …/id_ed25519` 指向一个不存在的私钥。
 *   ② **token 只能建容器那一刻定死** —— 改凭据必须重建容器；且明文一直躺在容器 env 里。
 * 现在的口径：**凭据不进容器**（既不落盘也不进 env）。容器里只有两个**无状态的** helper 脚本
 * （`/opt/sandbox-git/*.mjs`，由 toolkit 镜像预烘焙），`git` 需要认证时**回调平台**取短期凭据
 * （经出口②的 `SANDBOX_BACKEND_URL` + `SANDBOX_TOKEN`，与 MCP / 工作区代理同一个通道）。
 * 好处：RO rootfs 不再是问题（helper 把 SSH 私钥写到**可写的 `/tmp`**）；改凭据**不用重建容器**；
 * 平台只在真正用到的时刻解密、且只回给这一只容器。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 本文件的分工：只把"解密后的凭据"翻译成 helper 要回的**两种形状**，一个 IO 都不做
 * ═══════════════════════════════════════════════════════════════════════
 *   · {@link gitCredentialHelperEnv} —— 一份**不含任何秘密**的容器 env（把 git 指向两个 helper）；
 *   · {@link selectGitCredential} —— 按 `(protocol, host)` 从解密后的凭据里挑一条，转成回包。
 *
 * IO（解密、HTTP 端点）分别在 `services/gitCredential.service.ts` 与 `sandbox/gitProxy.ts`。
 * 这样"挑哪条凭据 / 回什么形状"能在不连库、不连 Docker 的情况下逐条自证。
 */

import { gitIdentityConfigEntries, type GitCredentialKind, type GitCredentialSecretInput, type GitIdentity } from '@doubulea/shared'

/** 一条**解密后**的凭据（明文只在本进程内存里出现；唯一出口是 `decryptUserGitCredentials`） */
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

// ───────────────────────── 容器侧 helper（跨边界契约）─────────────────────────

/**
 * 容器内 **git credential helper** 的绝对路径（toolkit 镜像预烘焙，`#!/usr/bin/env node`）。
 *
 * ⚠️ **跨边界契约**：容器脚本 `infra/sandbox/toolkit/git-credential-doubulea.mjs` 是这个路径的实体；
 *    改路径就要同步改镜像（并 +1 `TOOLKIT_LAYER_VERSION`）。与 `SANDBOX_TOKEN_ENV` 同族。
 */
export const GIT_CREDENTIAL_HELPER_PATH = '/opt/sandbox-git/git-credential-doubulea.mjs'

/** 容器内 **SSH 包装器** 的绝对路径（`GIT_SSH_COMMAND` 指向它；按需取私钥到 `/tmp` 再 exec ssh） */
export const GIT_SSH_HELPER_PATH = '/opt/sandbox-git/git-ssh-doubulea.mjs'

/**
 * git 凭据 helper 的**容器环境变量**（**纯函数**；⚠️ 不含任何秘密）。
 *
 *   · `GIT_TERMINAL_PROMPT=0`：容器里没人应答交互式提问，不关掉会让 `git clone` 挂死；
 *   · `credential.helper` 先置空（`GIT_CONFIG_VALUE_0=''` 清掉继承来的 helper 列表）再指向我们的
 *     helper —— 否则镜像/系统里若有别的 helper 会先跑、并且可能弹提示；
 *   · `GIT_SSH_COMMAND` 指向 SSH 包装器（无 SSH 凭据时它原样 exec `ssh`，行为不变）。
 *
 * ★ P1-20：`identity`（用户级 git 提交身份）**也走这张 `GIT_CONFIG_*` 表**（`user.name`/`user.email`），
 *   于是容器里 `git commit` 直接署上正确的人、agent 不必自己猜、也不必写仓库本地 config。
 *   ⚠️ **必须与凭据 helper 在同一处拼装**：`GIT_CONFIG_COUNT`+`KEY_i/VALUE_i` 是一张**扁平**表，
 *   分成两份 env 去 spread 会互相覆盖 `GIT_CONFIG_COUNT`（只生效一份）。
 *
 * ⚠️ 这一份 env **每次建容器都原样注入**（与"该用户有没有配凭据/身份"无关）：凭据是**运行期**由
 *     helper 回调取回的 ⇒ 用户后来新配/改了凭据，**不用重建容器**就能生效（这正是"按需拉取"的收益）。
 *     身份是公开信息、随 env 定死，改了身份要等下次重建容器（可接受：改署名不常见）。
 */
export function gitCredentialHelperEnv(identity: GitIdentity = { name: null, email: null }): Record<string, string> {
  const entries = [
    { key: 'credential.helper', value: '' },
    { key: 'credential.helper', value: GIT_CREDENTIAL_HELPER_PATH },
    ...gitIdentityConfigEntries(identity),
  ]
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(entries.length),
    GIT_SSH_COMMAND: GIT_SSH_HELPER_PATH,
  }
  entries.forEach((entry, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = entry.key
    env[`GIT_CONFIG_VALUE_${index}`] = entry.value
  })
  return env
}

// ───────────────────────── 挑选凭据（纯判据）─────────────────────────

/** 缺省登录名（PAT 通常配 `x-access-token`；GitLab 可用 `oauth2`，故允许覆盖） */
const DEFAULT_TOKEN_USERNAME = 'x-access-token'

/** 一条要回给容器的 SSH 私钥 */
export interface GitCredentialSshKey {
  privateKey: string
  /** 可空；包装器把非空的拼进临时 `known_hosts` */
  knownHosts: string
}

/**
 * helper 回包（**跨边界契约**；容器脚本 `git-credential-doubulea.mjs` / `git-ssh-doubulea.mjs` 按此解析）。
 *   · `https` ⇒ 打印 `username=…\npassword=…` 给 git；
 *   · `ssh` ⇒ 包装器把 `keys` 写进 `/tmp`（0600）并以 `-i` 交给 `ssh`。
 */
export type GitCredentialResolution =
  | { kind: 'https'; username: string; password: string }
  | { kind: 'ssh'; keys: GitCredentialSshKey[] }

/**
 * 按 `(protocol, host)` 挑一条凭据并转成回包（**纯函数**，端点与回归共用一处判据）。没有则 `null`。
 *
 *   · `https`：候选 = 全部 `HTTPS_TOKEN`；**精确 host 优先**，其次"不限主机"的那条（§7.4 的多条按 host 匹配）；
 *   · `ssh`：返回**全部** `SSH_KEY`（SSH 的 host 在包装器里拿不到，统一交给 ssh 依次尝试）。
 */
export function selectGitCredential(
  creds: readonly GitCredentialPlain[],
  protocol: 'https' | 'ssh',
  host: string | null,
): GitCredentialResolution | null {
  if (protocol === 'https') {
    const candidates = creds.filter(
      (cred) => cred.kind === 'HTTPS_TOKEN' && (cred.secret.token ?? '') !== '',
    )
    const wanted = (host ?? '').toLowerCase()
    const exact = candidates.find((cred) => {
      const credHost = (cred.host ?? '').toLowerCase()
      return credHost !== '' && credHost === wanted
    })
    const anyHost = candidates.find((cred) => (cred.host ?? '') === '')
    const chosen = exact ?? anyHost
    if (chosen === undefined) return null
    const rawUser = (chosen.secret.username ?? '').trim()
    return {
      kind: 'https',
      username: rawUser === '' ? DEFAULT_TOKEN_USERNAME : rawUser,
      password: chosen.secret.token ?? '',
    }
  }

  const keys = creds
    .filter((cred) => cred.kind === 'SSH_KEY' && (cred.secret.privateKey ?? '') !== '')
    .map((cred) => ({ privateKey: cred.secret.privateKey as string, knownHosts: (cred.secret.knownHosts ?? '').trim() }))
  return keys.length === 0 ? null : { kind: 'ssh', keys }
}
