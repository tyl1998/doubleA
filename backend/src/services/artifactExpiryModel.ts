/**
 * 产物保留期判据（2026-10-29）—— **纯函数**，零 `config` / DB / S3 依赖
 *
 * 依据：用户定案「产物能否可以加一个延期设置，延期几天、延期到某日、永久保存（默认还是 7 天）」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两种到期时刻，一个判据
 * ─────────────────────────────────────────────────────────────────────
 *   · **建行时**：`createdAt + 保留期`（`defaultArtifactExpiresAt`）—— 默认 7 天；
 *   · **延期后**：把 `artifacts.expires_at` 往后推（或置 `NULL` = 永久）。
 * 清理器只看这一列（`expires_at IS NOT NULL AND expires_at <= now`），于是"默认 7 天"与
 * "延期"共用同一个落点 —— 不需要在清理时再算一次 `createdAt + N 天` 的分支。
 *
 * ⚠️ **延期只会往后推**：`resolveArtifactExpiry` **拒绝**把到期时刻提前（那等于"缩短保留期"，
 *    想立刻清掉该用删除），也拒绝"从永久退回有限期"——两种都不是"延期"，做出来只会让
 *    用户误操作丢文件。
 * ⚠️ **延期到某日**按**当天结束**（23:59:59.999，用户本地时区的日期串由前端给绝对的
 *    ISO 时刻，见 `shared#artifactExtendBodySchema`）—— 用户说"延到 12 月 1 日"的意思
 *    是"12 月 1 日这一整天都还在"。
 */

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 建行时的默认到期时刻 = `createdAt + retentionDays`（`retentionDays <= 0` ⇒ `null` = 永久） */
export function defaultArtifactExpiresAt(createdAt: Date, retentionDays: number): Date | null {
  if (!(retentionDays > 0)) return null
  return new Date(createdAt.getTime() + retentionDays * DAY_MS)
}

/** 延期的三种口径（与 `shared#artifactExtendBodySchema` 的取值域一致） */
export type ArtifactExtendInput =
  | { mode: 'DAYS'; days: number }
  | { mode: 'UNTIL'; until: string }
  | { mode: 'FOREVER' }

export type ArtifactExtendResult =
  | { ok: true; expiresAt: Date | null }
  /** `message` 是**给用户看**的原因（路由层直接作为 422 的理由） */
  | { ok: false; message: string }

/** 一次性延期允许的天数上限（1 年）：足够"多留一段时间"，又不至于一年后才发现忘了一堆产物 */
export const ARTIFACT_EXTEND_MAX_DAYS = 365

/**
 * 算延期后的到期时刻。
 *
 * @param current 当前的 `expires_at`（`null` = 已是永久）
 * @param input   延期口径
 * @param now     判定时刻（注入便于核对）
 */
export function resolveArtifactExpiry(
  current: Date | null,
  input: ArtifactExtendInput,
  now: Date,
): ArtifactExtendResult {
  if (current === null) {
    return { ok: false, message: '这条产物已经是永久保存，不需要再延期' }
  }

  if (input.mode === 'FOREVER') {
    return { ok: true, expiresAt: null }
  }

  if (input.mode === 'DAYS') {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > ARTIFACT_EXTEND_MAX_DAYS) {
      return { ok: false, message: `延期天数需为 1 ~ ${ARTIFACT_EXTEND_MAX_DAYS} 的整数` }
    }
    // 从"较晚的那个"开始推：已过期的产物延期，应从今天起算（否则"延期 3 天"可能仍在过去）
    const base = current.getTime() > now.getTime() ? current.getTime() : now.getTime()
    return { ok: true, expiresAt: new Date(base + input.days * DAY_MS) }
  }

  const target = Date.parse(input.until)
  if (Number.isNaN(target)) return { ok: false, message: '延期目标时刻无法识别' }
  if (target <= now.getTime()) return { ok: false, message: '延期目标时刻必须晚于现在' }
  if (target <= current.getTime()) {
    return { ok: false, message: '延期只能往后推：目标时刻早于当前到期时刻' }
  }
  return { ok: true, expiresAt: new Date(target) }
}

/**
 * 清理器的判据：这一条**此刻**该不该删。
 *
 * 与 `reapExpiredArtifacts` 的 SQL（`expires_at IS NOT NULL AND expires_at <= now`）逐字同源；
 * 导出为纯函数是为了能在回归脚本里逐条核对（含"永久保存的行在 100 年后也不删"）。
 */
export function isArtifactExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime()
}
