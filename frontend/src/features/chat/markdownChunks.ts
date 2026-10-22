/**
 * 流式正文的**分块**（内存优化 P3，`docs/子方案/前端长会话内存优化.md`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────────────
 * `react-markdown` 是**同步全量解析**：每次调用都把整段文本解析成 mdast、再变成元素树。
 * 流式期间每个 `delta` 帧都会触发一次渲染，而 `AssistantMarkdown` 的入参 `text` 每帧都在变
 * ⇒ 一轮长回答（几万字、几千帧）会被**从头解析几千次**，每次还产生一整棵临时元素树。
 * 这是流式期间 CPU 与 GC 压力的主要来源，也让堆在回答生成期间长时间停在高位。
 *
 * 本文件把正文切成 **稳定的前缀** 与 **仍在长的尾巴**：
 *   · 前缀里只有**完整的块**（段落 / 列表 / 表格 / 围栏代码块 / 引用 / 标题…），它一旦被切出来
 *     就不再变化 ⇒ 交给 `react-markdown` 的文本引用不变 ⇒ 解析结果可以稳定复用；
 *   · 尾巴是"最后一个完整块之后到末尾"的那一段（可能是一个还没写完的代码围栏），**按纯文本**渲染。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 切分判据（刻意保守：宁可尾巴长一点，也不切出半截语法）
 * ─────────────────────────────────────────────────────────────────────
 * 前缀的边界 = 一个**空行**（`\n\s*\n`）之后的第一个位置，并且该空行**不在**未闭合的围栏代码块里。
 * 于是：
 *   · 围栏代码块（``` / ~~~）内部的空行**不算**边界 —— 切开会把代码块拆成"半截 + 一段普通文本"，
 *     渲染出来是错乱的；
 *   · 表格、列表、段落的连续行之间没有空行 ⇒ 天然不会被切开；
 *   · 行内语法（`**`、`` ` ``、链接）跨空行不存在 ⇒ 不需要额外判断。
 *
 * ⚠️ 这是**渲染层的近似**，不是 Markdown 解析：它只决定"把哪一段交给解析器"，不改变语义 ——
 * 合并前缀与尾巴之后，渲染结果与"一次性解析全文"一致（前缀经解析器、尾巴按纯文本）。
 * 唯一的可见差异是：**尾巴那一段在流式期间不是 Markdown**（粗体/列表符号以原文显示），
 * 收尾（`streaming` 变 `false`）时整篇解析一次，立即恢复正常渲染。这与"流式期间语法本来就
 * 可能被截断"是同一事实，只是明确化了。
 *
 * 纯函数、零依赖 ⇒ 可被无依赖档直接断言（`frontend/scripts/verify-markdown-chunks.mjs`）。
 */

/** 流式正文切出来的两段。`stable === ''` = 还没有任何完整块 */
export interface StreamingMarkdownChunks {
  /** 完整的块（交给 `react-markdown`）。引用在文本不变时保持同一字符串 */
  stable: string
  /** 仍在生成的尾巴（按纯文本渲染；可能为空） */
  tail: string
}

/** 尚未收口时 `tail` 最多保留多少字符交给解析器（见 {@link streamingMarkdownChunks} 的 `safeTail`） */
export const STREAMING_TAIL_RENDER_LIMIT = 2000

/**
 * 找出"最后一个**不在代码围栏里**的空行"的结束位置；没有就是 0。
 *
 * 围栏判定按 CommonMark 的简化版：行首最多 3 个空格 + 至少 3 个反引号或波浪号；
 *   · **开围栏** = 标记后可以有 info string（但反引号围栏的 info string 里不能再有反引号）；
 *   · **闭围栏** = 同种标记 + 后面没有任何内容（只允许尾随空白）。
 */
function lastSafeBlockBoundary(text: string): number {
  let boundary = 0
  /** 当前围栏的标记（` ``` ` / `~~~`）；`null` = 不在围栏里 */
  let fence: string | null = null
  /** 逐行扫描：每行的起始偏移 */
  let lineStart = 0
  const length = text.length
  while (lineStart <= length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? length : newline
    const line = text.slice(lineStart, lineEnd)
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (opening !== null) {
      const marker = opening[1] ?? '```'
      const kind = marker[0] ?? '`'
      const info = (opening[2] ?? '').trim()
      if (fence === null) {
        // 开围栏：反引号围栏的 info string 里**不能**有反引号（CommonMark）⇒ 有就不是围栏
        if (!(kind === '`' && info.includes('`'))) fence = kind
      } else if (kind === fence && info === '') {
        // 闭围栏：同种标记 + 后面没有任何内容
        fence = null
      }
    } else if (fence === null && line.trim() === '') {
      // 空行（且不在围栏里）⇒ 一个安全边界：它自己之后就是新块的起点
      boundary = lineEnd === length ? length : lineEnd + 1
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return boundary
}

/**
 * 把流式正文切成"稳定前缀 + 尾巴"。
 *
 * @param text 当前累积的正文（流式期间每帧增长）
 * @returns `stable` = 最后一个安全边界之前的全部内容（可能与上一次调用是**同一个字符串**，
 *   调用方据此跳过解析）；`tail` = 其余部分
 */
export function streamingMarkdownChunks(text: string): StreamingMarkdownChunks {
  const boundary = lastSafeBlockBoundary(text)
  if (boundary === 0) return { stable: '', tail: text }
  return { stable: text.slice(0, boundary), tail: text.slice(boundary) }
}

/**
 * 收尾前尾巴的长度上限（超出部分**仍然按全文解析**）：见 `AssistantMarkdown` 的说明 ——
 * 极端长的一行（例如模型吐了一整篇没有空行的分析）如果整段按纯文本渲染，观感会比
 * "解析一次"更糟；那种情况退化成"尾巴也交给解析器"（每帧全量，但只在这种极端输入下发生）。
 *
 * @returns 是否允许把尾巴交给解析器
 */
export function shouldParseTail(tail: string): boolean {
  return tail.length > STREAMING_TAIL_RENDER_LIMIT
}
