/**
 * 工作区**冷备的纯判据**（P1-9 · P5 · R3）—— S3 键命名 + 恢复计划
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 4（冷备与恢复）、§三（S3 键规则：内容寻址
 *      `workspaces/{conversationId}/blobs/{sha256}`）、§十二 P5。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件、且**零 import**（不引 config / prisma / S3）
 * ─────────────────────────────────────────────────────────────────────
 * 与 `paths.ts` / `edit.ts` / `steerMessage.ts` 同一取舍：把"纯判据"从"会碰 IO 的实现"里
 * 切出来，于是它能在**不连 DB / 不连 S3**的自证脚本（`scripts/workspace-regression.ts`）里
 * 逐条核对。真正的上行 / 恢复实现在 `cold.ts`（那份会 `import config`，故不进纯脚本）。
 *
 * ⚠️ 内容寻址 ⇒ 同一份内容在同一会话里**只有一个键**：相同内容零新增对象（§三）。
 *    键里带 `conversationId`，故**跨会话不共享**（一个会话的冷备不会因为内容相同被另一个会话删）。
 */

/** 冷备键的顶层前缀（与产物键 `artifacts/…` 并列，互不干扰） */
export const WORKSPACE_COLD_ROOT = 'workspaces'

/**
 * 一个会话的冷备对象前缀（`workspaces/{conversationId}/blobs/`）。
 *
 * ⚠️ **尾随 `/`** 是刻意的：`listObjectsV2(prefix)` 是**字符串前缀**匹配 —— 少了它，
 * `ws-1` 会把 `ws-10/...` 也列进来（跨会话误删）。
 */
export function workspaceColdPrefix(conversationId: string): string {
  return `${WORKSPACE_COLD_ROOT}/${conversationId}/blobs/`
}

/** 某个内容 hash 的冷备对象键（内容寻址；`workspaceColdPrefix` + sha256） */
export function workspaceColdKey(conversationId: string, hash: string): string {
  return `${workspaceColdPrefix(conversationId)}${hash}`
}

/** 恢复计划的输入行（= `workspace_files` 的索引投影；`size` 允许 `bigint`（Prisma）） */
export interface WorkspaceRestoreRow {
  path: string
  contentHash: string
  mime?: string
  size?: number | bigint
}

/** 恢复计划里的一条：某路径要从 S3 取回的内容（按 `hash` 取字节） */
export interface WorkspaceRestorePlanItem {
  path: string
  hash: string
  mime: string
  size: number
}

/** 恢复计划：要还原的条目 + 被跳过的行（无 hash 的残缺行） */
export interface WorkspaceRestorePlan {
  items: WorkspaceRestorePlanItem[]
  skipped: { path: string; reason: string }[]
}

/**
 * 把"索引里活着的文件行"折成**恢复计划**（纯函数）。
 *
 * 口径（§四 4"恢复时机：从 S3 按**最新版本**重建目录"）：
 *   · 恢复的是**每路径的最新内容**（= 文件行的 `contentHash`，不是逐版本回放）——
 *     工作区目录只需要"恢复到现在应有的样子"，历史字节另有 blob 承载（撤销本轮用）；
 *   · 顺序**按路径升序**（与 `listWorkspaceFiles` 同序），保证结果确定、便于逐条核对；
 *   · `contentHash` 为空的行无从取字节 ⇒ 记进 `skipped`（如实告知，不猜）。
 */
export function planWorkspaceRestore(rows: readonly WorkspaceRestoreRow[]): WorkspaceRestorePlan {
  const items: WorkspaceRestorePlanItem[] = []
  const skipped: { path: string; reason: string }[] = []
  for (const row of rows) {
    if (row.contentHash.trim() === '') {
      skipped.push({ path: row.path, reason: '索引行没有 contentHash，无从定位冷备对象' })
      continue
    }
    items.push({
      path: row.path,
      hash: row.contentHash,
      mime: row.mime ?? '',
      size: typeof row.size === 'bigint' ? Number(row.size) : (row.size ?? 0),
    })
  }
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { items, skipped }
}
