/**
 * git 凭据服务（P1-9 · R11）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7（git 凭据：平台配置 + 容器内注入）+ §十三 已决 8
 *      + `shared/src/gitCredential.ts`（契约）+ `sandbox/gitCredential.ts`（注入物纯函数）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条口径（与 `mcpCredential.service.ts` 同族，值得连着读）
 * ─────────────────────────────────────────────────────────────────────
 * ① **收窄全在 `user_id` 上，没有后门**：每个导出函数第一件事就是按 `viewer.userId` 收窄；
 *    本文件**一个角色判断都没有**（ADMIN 读别人的凭据也拿不到）。越权一律 404。
 * ② **值有进无出**：`secretEnc` 只在本文件读写，出参只有 `hasValue`（连掩码都没有）。
 *    唯一一次"解密成明文"的出口是 {@link decryptUserGitCredentials} —— 它只流向
 *    `sandbox/manager.ts` 的容器注入（`putArchive` / env），别处一处都不许出现。
 * ③ **解密失败 = 没有值**（降级，绝不 500）：AAD 是"绑定"而不是"格式"，主密钥换过后整页崩掉
 *    是最坏的形态 —— 它会把"某人需要重填一把私钥"呈现成"这个系统坏了"。
 * ④ **清空 = 删行**：不存空密文（理由同 MCP 凭据：结构合法的空密文会让"已配置"永远为真）。
 *
 * ⚠️ 日志只写结构性信息（`userId` / `kind` / `label` / 字段名），**绝不整体序列化含值的对象**；
 *    `infra/logger.ts#LOG_REDACT_PATHS` 已含 `*_enc` 兜底。
 */

import { appMsg,
  AppError,
  GIT_CREDENTIAL_MAX_PER_USER_DEFAULT,
  missingGitCredentialSecretFields,
  type CreateGitCredentialBody,
  type GitCredentialItem,
  type GitCredentialKind,
  type GitCredentialListResult,
  type GitCredentialSecretInput,
  type RemoveGitCredentialResult,
  type UpdateGitCredentialBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { decryptSecret, encryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma, Prisma } from '../infra/prisma.js'
import { gitCredentialAad, type GitCredentialPlain } from '../sandbox/gitCredential.js'

/** 调用者。本资源的收窄**只有**这一条：`userId` 就是全部权限信息 */
export interface GitCredentialViewer {
  userId: string
}

/** 行投影（本文件用到的列；`secretEnc` 外一律不取） */
const GIT_CREDENTIAL_SELECT = {
  id: true,
  label: true,
  kind: true,
  host: true,
  secretEnc: true,
  updatedAt: true,
} as const

/**
 * `secretEnc` 里的密文段（`{ payload: "v1.…" }`）。
 * ⚠️ 库里可能是 `null` / 不是对象 / `payload` 不是字符串（手工改库、半截数据）⇒ 一律当"没有值"。
 */
function cipherOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const payload = (raw as { payload?: unknown }).payload
  return typeof payload === 'string' && payload !== '' ? payload : undefined
}

/** 解密一行 → 明文秘密字段；解不开返回 `undefined`（降级，见文件头 ③） */
function decryptSecretOf(
  userId: string,
  kind: GitCredentialKind,
  label: string,
  raw: unknown,
): GitCredentialSecretInput | undefined {
  const cipher = cipherOf(raw)
  if (cipher === undefined) return undefined
  try {
    const parsed = JSON.parse(decryptSecret(cipher, gitCredentialAad(userId, kind, label))) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as GitCredentialSecretInput
  } catch {
    // ⚠️ 只记结构信息（不含密文 / 明文 / 原始错误）
    getLogger().warn(
      { userId, kind, label },
      'git 凭据解密失败（密文与 (userId,kind,label) 不匹配，或主密钥已更换）⇒ 该条按「没有值」处理',
    )
    return undefined
  }
}

/** 行 → 契约条目（**唯一出口**，见文件头 ②：没有"值"这个字段） */
function toItem(
  userId: string,
  row: { id: string; label: string; kind: GitCredentialKind; host: string | null; secretEnc: unknown; updatedAt: Date },
): GitCredentialItem {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    host: row.host,
    hasValue: decryptSecretOf(userId, row.kind, row.label, row.secretEnc) !== undefined,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 归一化 host：去空白 + 小写（`GitHub.com` 与 `github.com` 是同一台） */
function normalizeHost(host: string | null | undefined): string | null {
  if (host === undefined || host === null) return null
  const trimmed = host.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/** 把秘密字段加密成 `secretEnc` 载荷 */
function encryptSecretValue(
  userId: string,
  kind: GitCredentialKind,
  label: string,
  secret: GitCredentialSecretInput,
): Prisma.InputJsonValue {
  return { payload: encryptSecret(JSON.stringify(secret), gitCredentialAad(userId, kind, label)) }
}

// ═════════════════════════════════════════════════════════════════════
// 读
// ═════════════════════════════════════════════════════════════════════

/**
 * 我的 git 凭据清单（`GET /api/git-credentials`，登录即可、**只看自己的**）。
 * 排序 `createdAt asc, id asc`：与 MCP 凭据页同一口径（顺序稳定，用户来回跳不会看到"顺序变了"）。
 */
export async function listMyGitCredentials(viewer: GitCredentialViewer): Promise<GitCredentialListResult> {
  const rows = await getPrisma().gitCredential.findMany({
    where: { userId: viewer.userId },
    select: GIT_CREDENTIAL_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const items = rows.map((row) => toItem(viewer.userId, row))
  getLogger().debug(
    { userId: viewer.userId, count: items.length, withValue: items.filter((item) => item.hasValue).length },
    '已读取我的 git 凭据清单',
  )
  return { items }
}

/**
 * 某个用户的**全部** git 凭据（明文秘密字段）—— **唯一的"解密成明文"出口**（见文件头 ②）。
 *
 * ⚠️ 只允许被 `sandbox/manager.ts` 的容器注入消费。解不开的条目**跳过**（降级，见文件头 ③），
 *    不抛错 —— 注入端只需要"能用的那些"，不能因为一条坏密文就让整个容器建不出来。
 */
export async function decryptUserGitCredentials(userId: string): Promise<GitCredentialPlain[]> {
  const rows = await getPrisma().gitCredential.findMany({
    where: { userId },
    select: { kind: true, host: true, label: true, secretEnc: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const out: GitCredentialPlain[] = []
  for (const row of rows) {
    const secret = decryptSecretOf(userId, row.kind, row.label, row.secretEnc)
    if (secret === undefined) continue
    out.push({ kind: row.kind, host: row.host, secret })
  }
  return out
}

// ═════════════════════════════════════════════════════════════════════
// 写
// ═════════════════════════════════════════════════════════════════════

/** `P2002` = 唯一键冲突（`(userId, label)` 撞了） */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/** 服务端的条数上限（配置未接线时回落到契约默认值，保证行为可预期） */
function maxPerUser(): number {
  return config.gitCredential?.maxPerUser ?? GIT_CREDENTIAL_MAX_PER_USER_DEFAULT
}

/**
 * 新建一条凭据（`POST /api/git-credentials`，登录即可、**只写自己的**）。
 *
 * 顺序：① 条数闸门 → ② `kind` 必填秘密字段 → ③ 加密落库（`label` 唯一冲突 ⇒ 409）。
 */
export async function createGitCredential(
  input: CreateGitCredentialBody,
  viewer: GitCredentialViewer,
): Promise<GitCredentialItem> {
  const db = getPrisma()
  const count = await db.gitCredential.count({ where: { userId: viewer.userId } })
  if (count >= maxPerUser()) {
    throw AppError.validation(appMsg('app.m264', { p0: maxPerUser(), p1: count }),
    )
  }

  const secret: GitCredentialSecretInput = {
    ...(input.privateKey === undefined ? {} : { privateKey: input.privateKey }),
    ...(input.knownHosts === undefined ? {} : { knownHosts: input.knownHosts }),
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.username === undefined ? {} : { username: input.username }),
  }
  const missing = missingGitCredentialSecretFields(input.kind, secret)
  if (missing.length > 0) {
    throw AppError.validation(appMsg('app.m159', { p0: input.kind === 'SSH_KEY' ? 'SSH 私钥' : 'HTTPS 令牌', p1: missing.join('、') }),
    )
  }

  const data = {
    userId: viewer.userId,
    kind: input.kind,
    label: input.label,
    host: normalizeHost(input.host),
    secretEnc: encryptSecretValue(viewer.userId, input.kind, input.label, secret),
  }
  let row: { id: string; label: string; kind: GitCredentialKind; host: string | null; secretEnc: unknown; updatedAt: Date }
  try {
    row = await db.gitCredential.create({ data, select: GIT_CREDENTIAL_SELECT })
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(appMsg('app.m026', { p0: input.label }))
    throw error
  }
  getLogger().info({ userId: viewer.userId, kind: input.kind, label: input.label }, '已新建 git 凭据')
  return toItem(viewer.userId, row)
}

/**
 * 更新一条凭据（`PUT /api/git-credentials/:id`，登录即可、**只改自己的**）。
 *
 * ⚠️ **`kind` 不可改**（不在契约里）：换类型 = 换一批必填字段 = 另一条凭据，让用户删了重建更干净。
 * ⚠️ **`label` 变了要重加密**：`label` 进 AAD ⇒ 用旧 AAD 解出现有秘密、再用新 AAD 重新加密，
 *    否则新 label 配旧密文 = 永远解不开（症状：改个名字之后 `hasValue` 变 false）。
 * ⚠️ **秘密字段是合并语义**（只动提交里出现的字段）：值不下发 ⇒ 前端无从回填。
 */
export async function updateGitCredential(
  id: string,
  input: UpdateGitCredentialBody,
  viewer: GitCredentialViewer,
): Promise<GitCredentialItem> {
  const db = getPrisma()
  const existing = await db.gitCredential.findFirst({ where: { id, userId: viewer.userId }, select: GIT_CREDENTIAL_SELECT })
  if (existing === null) throw AppError.notFound(appMsg('app.m027'))

  const nextLabel = input.label ?? existing.label
  const currentSecret = decryptSecretOf(viewer.userId, existing.kind, existing.label, existing.secretEnc) ?? {}
  const nextSecret: GitCredentialSecretInput = { ...currentSecret }
  if (input.privateKey !== undefined) nextSecret.privateKey = input.privateKey
  if (input.knownHosts !== undefined) nextSecret.knownHosts = input.knownHosts
  if (input.token !== undefined) nextSecret.token = input.token
  if (input.username !== undefined) nextSecret.username = input.username

  // 合并后仍缺必填 ⇒ 拒绝（不能让一条已存在的凭据被改成"没有值"）
  const missing = missingGitCredentialSecretFields(existing.kind, nextSecret)
  if (missing.length > 0) {
    throw AppError.validation(appMsg('app.m160', { p0: missing.join('、') }))
  }

  const data = {
    label: nextLabel,
    host: input.host === undefined ? existing.host : normalizeHost(input.host),
    // label 可能变了 ⇒ 一律重加密（用新 AAD），避免"改了名就解不开"
    secretEnc: encryptSecretValue(viewer.userId, existing.kind, nextLabel, nextSecret),
  }
  let row: typeof existing
  try {
    row = await db.gitCredential.update({ where: { id: existing.id }, data, select: GIT_CREDENTIAL_SELECT })
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(appMsg('app.m026', { p0: nextLabel }))
    throw error
  }
  getLogger().info({ userId: viewer.userId, kind: existing.kind, label: nextLabel }, '已更新 git 凭据')
  return toItem(viewer.userId, row)
}

/**
 * 删除一条凭据（`DELETE /api/git-credentials/:id`，登录即可、**只删自己的**）。
 * ⚠️ **本来就没有 ⇒ 404**（不是幂等 200）：删的是"我的那一条"，"你没有可删的东西"更准确。
 */
export async function removeGitCredential(
  id: string,
  viewer: GitCredentialViewer,
): Promise<RemoveGitCredentialResult> {
  const db = getPrisma()
  const existing = await db.gitCredential.findFirst({
    where: { id, userId: viewer.userId },
    select: { id: true, label: true },
  })
  if (existing === null) throw AppError.notFound(appMsg('app.m027'))
  await db.gitCredential.delete({ where: { id: existing.id } })
  getLogger().info({ userId: viewer.userId, gitCredentialId: existing.id }, '已删除 git 凭据')
  return { id: existing.id, label: existing.label }
}
