/**
 * 工作区「编辑」的**纯替换逻辑**（P1-9 · P2）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 2（pi workspace 扩展的 `edit`）；`06` §五·补 P1-9 · R8
 *      （**入参形状对齐 pin `0.87.1` 的内置 `edit`：`{ path, edits: [{ oldText, newText }] }`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是纯函数、且**与版本无关**
 * ─────────────────────────────────────────────────────────────────────
 * `edit` = "读当前内容 → 按 `edits[]` 定位、换成 `newText` → 写回（带 `baseVersion` 做 CAS）"。**换成什么**
 * 这一段不碰 IO、不碰版本；把它单独拎出来（本文件），就能在临时字符串上逐条核对
 * "找不到 / 多处匹配 / 重叠 / 旧单处形态"这些边界 —— 而真正的并发正确性由 CAS 那一步负责（不在本文件）。
 *
 * ⚠️ **多处匹配默认拒绝**（与 pi 原生 `edit` 同款纪律）：只换第一处会让"同一段文字出现两次"
 * 变成一次静默的错改；要求调用方给出更具体的 `oldText`（含上下文）比替它猜更安全。
 */

export type ApplyWorkspaceEditResult = { ok: true; text: string } | { ok: false; reason: string }

/** 一处替换（与 pin `0.87.1` 内置 `edit#edits[]` 同形；容器侧 = `extensions/workspace#WorkspaceEdit`） */
export interface WorkspaceEdit {
  oldText: string
  newText: string
}

/**
 * 把 `content` 里的 `edits[]` **一次性**替换（P1-9 · R8）。
 *
 * 语义**照抄 pin `0.87.1` 内置 `edit`**：每一处 `oldText` 都对着**原文件**匹配（不是增量），
 * 必须唯一出现、且两两不重叠。任一处不满足 ⇒ 整次拒绝（不做"改了一半"）。
 */
export function applyWorkspaceEdits(content: string, edits: readonly WorkspaceEdit[]): ApplyWorkspaceEditResult {
  if (edits.length === 0) {
    return { ok: false, reason: 'edits 不能为空（至少给出一处替换）' }
  }

  const spans: { start: number; end: number; newText: string }[] = []
  for (const [index, edit] of edits.entries()) {
    const at = `第 ${index + 1} 处`
    if (edit.oldText === '') {
      return { ok: false, reason: `${at} oldText 不能为空（空串会匹配到任意位置）` }
    }
    if (edit.oldText === edit.newText) {
      return { ok: false, reason: `${at} oldText 与 newText 相同，无需修改` }
    }
    const first = content.indexOf(edit.oldText)
    if (first === -1) {
      return { ok: false, reason: `${at} 在当前文件里找不到 oldText（可能已被修改，请重新读取后再编辑）` }
    }
    if (content.indexOf(edit.oldText, first + 1) !== -1) {
      return { ok: false, reason: `${at} oldText 匹配到多处，请提供更具体的上下文` }
    }
    spans.push({ start: first, end: first + edit.oldText.length, newText: edit.newText })
  }

  // 重叠检测：按起点排序后，相邻两段的起点不得落在前一段之内（含"一段包住另一段"）
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]
    const current = ordered[i]
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      return { ok: false, reason: '多处替换的目标区域重叠，请合并成一处编辑' }
    }
  }

  // 从后往前替换：前面的下标不受影响
  let text = content
  for (const span of [...ordered].reverse()) {
    text = text.slice(0, span.start) + span.newText + text.slice(span.end)
  }
  return { ok: true, text }
}

/**
 * 把 `content` 里的 `oldString` 替换成 `newString`（**旧单处形态**，保留给兼容路径与既有自证）。
 *
 * @param replaceAll `true` = 全量替换；`false`（默认）= 必须**恰好一处**，否则拒绝。
 */
export function applyWorkspaceEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ApplyWorkspaceEditResult {
  if (oldString === '') {
    return { ok: false, reason: 'oldString 不能为空（空串会匹配到任意位置）' }
  }
  if (oldString === newString) {
    return { ok: false, reason: 'oldString 与 newString 相同，无需修改' }
  }

  const occurrences = countOccurrences(content, oldString)
  if (occurrences === 0) {
    return { ok: false, reason: '在当前文件里找不到 oldString（可能已被修改，请重新读取后再编辑）' }
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      reason: `oldString 匹配到 ${occurrences} 处，请提供更具体的上下文（或显式要求全部替换）`,
    }
  }
  return { ok: true, text: replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString) }
}

/** 统计 `needle` 在 `haystack` 里不重叠出现的次数（`split` 的长度差是零依赖计数） */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}