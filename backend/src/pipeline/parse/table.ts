/**
 * 表格序列化（docx / md 解析器共用；分块层也用它做"按行重复表头"的超长表切分）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么表格要变成"一个块 + Markdown 管道表"
 * ─────────────────────────────────────────────────────────────────────
 * 行列对应关系是表格的**全部**语义。旧的 docx 解析把每个单元格收成独立段落，表格退化成
 * "按行顺序排列的若干句"，列归属与表头全部丢失 —— 检索命中后读起来前言不搭后语。
 * 处置：把整张表收成**一个** `kind='table'` 的块，`text` 是 Markdown 管道表
 * （`| 列1 | 列2 |` + 分隔行 + 数据行）。选 Markdown 而不是 HTML/JSON 有两个理由：
 *   · 它是"结构 + 文本"的混合体，大模型与人工都能直接读；
 *   · 分块层可以按**行**（`\n`）切，天然对齐表格的行边界。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `splitTableText`：超长表格的切法（与分块契约的关系）
 * ─────────────────────────────────────────────────────────────────────
 * `chunk/strategy.ts` 的不变式②要求"每块都是 `parsed.text` 的逐字子串"。对**普通文本**这条
 * 成立；对**超长表格**它刻意让位：表格一旦超过 `chunk_size` 必须切开，而切开后的每一片若不带
 * 表头就完全不可读。故这里在每片前面**重复表头**（业界通用做法，LangChain / LlamaIndex 同款），
 * 代价是这几片不再是原文的逐字子串 —— 换来的是"每一片都能被检索到、也能被读懂"。
 * 触发条件极少（表格超过 512 字才发生），且只影响表格块自己的 `content`。
 */

/** 单元格里的换行压成空格：管道表是"一行一记录"，单元格内换行会破坏行结构 */
function flattenCell(text: string): string {
  // `|` 是列分隔符，必须转义，否则单元格内容会被截成两列（"结构性"错误，比显示错更难查）
  return text.replace(/\\?\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ').trim()
}

/**
 * 二维网格 → Markdown 管道表。
 *
 * 第一行**无条件**当表头（Markdown 表语法要求有表头行）：docx 里若识别出 `<thead>`/`<th>`，
 * 第一行本就是表头；md 里第一行也必然是表头（GFM 由"表头行 + 分隔行"定义）。
 */
export function renderTableMarkdown(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (width === 0) return ''
  const line = (cells: readonly string[]): string => {
    const padded = Array.from({ length: width }, (_, index) => flattenCell(cells[index] ?? ''))
    return `| ${padded.join(' | ')} |`
  }
  const header = line(rows[0] ?? [])
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  const body = rows.slice(1).map(line)
  return [header, separator, ...body].join('\n')
}

/**
 * 超长表格按**行边界**切分；每片重复表头（前两行：表头行 + 分隔行）。
 *
 * 表头行不足两行（非标准表）时退回"整块不切" —— 宁可贵一点，也不要产出一片没有表头的表格。
 * `maxChars <= 0` 也整块返回（防御；正常调用方传 `chunk_size`）。
 */
export function splitTableText(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || [...text].length <= maxChars) return [text]
  const lines = text.split('\n')
  if (lines.length <= 2) return [text]

  const headerText = `${lines[0] ?? ''}\n${lines[1] ?? ''}`
  const dataLines = lines.slice(2)
  const headerLen = [...headerText].length + 1 // +1 = 表头与数据之间的换行
  const pieces: string[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length > 0) {
      pieces.push(`${headerText}\n${current.join('\n')}`)
      current = []
    }
  }

  for (const dataLine of dataLines) {
    // 单行就超过 maxChars 时（当前为空）也收下：切成两半会破坏该行的列结构
    if (current.length > 0 && headerLen + [...current.join('\n')].length + 1 + [...dataLine].length > maxChars) {
      flush()
    }
    current.push(dataLine)
  }
  flush()

  return pieces.length > 0 ? pieces : [text]
}
