/**
 * 工作区保留期判据（P1-9 · P5 · R5）—— **纯函数**，零 `config` / DB / FS 依赖
 *
 * 依据：`docs/子方案/Code模式工作区.md` §八（"会话删除/超保留期才删"）、
 *      §十三 已决 4（保留期与产物共用 `ARTIFACT_RETENTION_DAYS`，默认 7 天）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（同 `coldModel.ts` 的理由）
 * ─────────────────────────────────────────────────────────────────────
 * `reaper.ts` 要连 PG / S3 / FS，**一 import 就会拖进 `config.ts` 的启动校验**（要求全套 env）。
 * 把"截止时刻 / 是否过期"这两条判据抽到这里，就能在 `scripts/workspace-regression.ts`
 * 里**无 env、无 DB、无 S3** 逐条核对 —— 边界（恰好等于 cutoff）尤其值得钉死。
 */

/**
 * 保留期截止时刻：`updated_at < cutoff` 即"超保留期"。
 *
 * @param now 判定时刻
 * @param retentionDays 保留期（天；生产来自 `config.workspace.retentionDays` = `ARTIFACT_RETENTION_DAYS`）
 */
export function workspaceRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
}

/**
 * 一个工作区是否超过保留期。**严格 `<`**：`updated_at` 恰好等于 cutoff **不算**过期
 * （边界归"未过期"，宁多留一轮、不早删一秒）。
 */
export function isWorkspaceExpired(updatedAt: Date, now: Date, retentionDays: number): boolean {
  return updatedAt.getTime() < workspaceRetentionCutoff(now, retentionDays).getTime()
}
