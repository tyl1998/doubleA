/**
 * 工作区**行级差异**（P1-9 · 验收标记）—— **纯函数**，零依赖（不碰 DB / FS / Docker）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §十三 已决 6/7（产物 = 工作区变更集视图）。
 * 用途：把"这一轮 agent 把某个文件从旧字节改成了新字节"折成可渲染、可核对的逐行清单
 * （`+N −M` 徽标 + 差异视图），让「最近变更」不只是"哪个文件变了"，而是"**改了什么**"。
 *
 * ⚠️ 旧字节从哪来：`workspace/blob.ts` 的历史字节存储（覆盖/删除前自动存档，见 §七 5）。
 *    本模块**只做对齐**，取字节的事在 `service.ts#getWorkspaceFileDiff`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径（错了都"不报错、只是显示不对"，故与 `workspace-regression` 逐条核对）
 * ─────────────────────────────────────────────────────────────────────
 *   · **先剥公共前缀 / 后缀**：大文件"末端小改"因此变成很小的 middle ⇒ 不必对大文件跑 LCS；
 *   · **LCS 有上限**：middle 的 `|a|×|b|` 超 {@link MAX_LCS_CELLS} 就退化为"整段删 + 整段增"
 *     （逐行对齐会失真，但 `+N −M` 计数仍准确）—— 宁可口径粗一点也不让一个 5000 行的文件卡住；
 *   · **长段未变行折叠成 `gap`**：改动处两侧各留 {@link WORKSPACE_DIFF_CONTEXT_LINES} 行，
 *     中间折成一条"⋯ N 行未变⋯"，于是"改在末尾"也能一眼看到（渲染端只认四种 `type`）。
 */

import { collapseWorkspaceDiffContext, type WorkspaceDiffLine } from '@doubulea/shared'

/** 逐行差异里**改动处两侧**各保留的上下文行数（更长的未变段折成 `gap`） */
export const WORKSPACE_DIFF_CONTEXT_LINES = 3

/** 单侧参与对齐的最大行数；超出即**截断**（`truncated:true`），避免超大文件把一屏塞满 */
export const WORKSPACE_DIFF_MAX_LINES = 4000

/** LCS DP 的单元格上限（`|a|×|b|`）；超出即退化为"整段删 + 整段增" */
const MAX_LCS_CELLS = 250_000

/** {@link lineDiffWorkspace} 的产物 */
export interface WorkspaceLineDiff {
  /** 带行号的逐行序列（未变长段已折成 `gap`） */
  lines: WorkspaceDiffLine[]
  /** 新增行数 */
  added: number
  /** 删除行数 */
  removed: number
  /** 是否因超行数上限被截断（截断时 `added`/`removed` 只反映**已处理**的部分） */
  truncated: boolean
}

/** 文本 → 行数组（统一 CRLF/CR → LF；空文本 = `[]`；末尾换行符**不**产生额外空行） */
export function splitWorkspaceDiffLines(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 一条编辑动作（`context` 两侧都有；`add`/`del` 只有一侧） */
interface EditOp {
  type: 'context' | 'add' | 'del'
  text: string
}

/**
 * LCS（最长公共子序列）DP → 编辑脚本。
 * ⚠️ **只在 `a.length × b.length ≤ MAX_LCS_CELLS` 时调用**（调用方保证），否则内存/时间不可控。
 */
function lcsEditScript(a: readonly string[], b: readonly string[]): EditOp[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  // dp[i*width+j] = a[i..] 与 b[j..] 的最长公共子序列长度（从右下往左上填）
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!)
    }
  }
  const ops: EditOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i] as string })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      ops.push({ type: 'del', text: a[i] as string })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j] as string })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i] as string })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] as string })
    j += 1
  }
  return ops
}

/**
 * 旧文本 → 新文本的**行级差异**（带行号、长段折 `gap`）。
 *
 * @param options.maxLines 单侧行数上限（缺省 {@link WORKSPACE_DIFF_MAX_LINES}）
 * @param options.contextLines 改动处两侧保留的上下文行数（缺省 {@link WORKSPACE_DIFF_CONTEXT_LINES}）
 */
export function lineDiffWorkspace(
  oldText: string,
  newText: string,
  options: { maxLines?: number; contextLines?: number } = {},
): WorkspaceLineDiff {
  const maxLines = options.maxLines ?? WORKSPACE_DIFF_MAX_LINES
  const contextLines = options.contextLines ?? WORKSPACE_DIFF_CONTEXT_LINES

  const fullOld = splitWorkspaceDiffLines(oldText)
  const fullNew = splitWorkspaceDiffLines(newText)
  const truncated = fullOld.length > maxLines || fullNew.length > maxLines
  const a = truncated ? fullOld.slice(0, maxLines) : fullOld
  const b = truncated ? fullNew.slice(0, maxLines) : fullNew

  // ① 剥公共前缀 / 后缀（大文件"末端小改"因此得到极小的 middle）
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let endA = a.length
  let endB = b.length
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const midA = a.slice(prefix, endA)
  const midB = b.slice(prefix, endB)

  // ② middle：能承受 LCS 就逐行对齐，否则退化为"整段删 + 整段增"
  const midOps =
    midA.length * midB.length <= MAX_LCS_CELLS
      ? lcsEditScript(midA, midB)
      : [
          ...midA.map((text): EditOp => ({ type: 'del', text })),
          ...midB.map((text): EditOp => ({ type: 'add', text })),
        ]

  // ③ 组装带行号的完整序列（行号随动作前进，与任一文本的行序一致）
  const raw: WorkspaceDiffLine[] = []
  let oldNo = 1
  let newNo = 1
  for (let k = 0; k < prefix; k += 1) {
    raw.push({ type: 'context', oldLine: oldNo, newLine: newNo, text: a[k] as string })
    oldNo += 1
    newNo += 1
  }
  for (const op of midOps) {
    if (op.type === 'context') {
      raw.push({ type: 'context', oldLine: oldNo, newLine: newNo, text: op.text })
      oldNo += 1
      newNo += 1
    } else if (op.type === 'del') {
      raw.push({ type: 'del', oldLine: oldNo, newLine: null, text: op.text })
      oldNo += 1
    } else {
      raw.push({ type: 'add', oldLine: null, newLine: newNo, text: op.text })
      newNo += 1
    }
  }
  // 后缀：两侧完全相同 ⇒ 两个行号一起前进
  for (let k = endA; k < a.length; k += 1) {
    raw.push({ type: 'context', oldLine: oldNo, newLine: newNo, text: a[k] as string })
    oldNo += 1
    newNo += 1
  }

  let added = 0
  let removed = 0
  for (const line of raw) {
    if (line.type === 'add') added += 1
    else if (line.type === 'del') removed += 1
  }
  return { lines: collapseWorkspaceDiffContext(raw, contextLines), added, removed, truncated }
}
