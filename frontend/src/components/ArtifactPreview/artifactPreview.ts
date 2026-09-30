/**
 * 产物预览的**零依赖纯逻辑**（P0-3-10；`子方案④` §五 / §七）
 *
 * 依据：`docs/子方案/文件预览.md` §二（参数总表）/ §四 2（响应头分派）/ §五（五种格式）
 *      + `docs/03-前端设计.md` §4.6 + `docs/06-实施计划.md` §五 P0-3-10 行
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**不 import React、不发请求、不读 DOM**
 * ─────────────────────────────────────────────────────────────────────
 * 目的是让它能被 `frontend/scripts/verify-artifact-preview.mjs` 用
 * `node --import tsx` **直跑源码**断言（不占端口、不连后端、不经 vite）—— 前端批次里
 * 最容易写错又最难在界面上看出来的两类（**截断读数报的是截断后的数**、
 * **边界写成 `>` 还是 `>=`**）只有这一档抓得住（P0-1-35 同款手法）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 两个 URL 只在这一处拼（`子方案④` §七 1）
 * ─────────────────────────────────────────────────────────────────────
 * 别处（卡片、弹层、api 层）一律调 {@link artifactContentUrl} / {@link artifactDownloadUrl}，
 * 不许自己拼字符串 —— 端点路径改一次时"某处拼错了"的症状是**预览空白或下载 404**，
 * 而界面上看不出是路径错了还是文件没了。
 * ⚠️ 两个 URL **刻意不带任何 query**（下载与预览是两个出口，不是一个端点加参数 ——
 * `子方案④` §三 1：把安全策略变成调用方可选的参数是不可审计的）。
 */

import {
  ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
  ARTIFACT_PREVIEW_MAX_TEXT_BYTES,
  previewKindOf,
  type PreviewKind,
} from '@doubulea/shared'

// ───────────────────────────── 前端常量（`子方案④` §二）─────────────────────────────

/** CSV 解析的**行数**上限（超出截断 + 明示读数，不静默） */
export const ARTIFACT_PREVIEW_CSV_MAX_ROWS = 5000
/** CSV 解析的**列数**上限 */
export const ARTIFACT_PREVIEW_CSV_MAX_COLS = 100
/** 单元格展示的字符上限（长文本列不撑破布局；**原值仍在下载的文件里**） */
export const ARTIFACT_PREVIEW_CSV_CELL_CHARS = 200

// ───────────────────────────── 两个 URL ─────────────────────────────

/** 预览（`Content-Disposition: inline` + 隔离头） */
export function artifactContentUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content`
}

/** 下载（`attachment`，拿到原文件） */
export function artifactDownloadUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/download`
}

/**
 * 历史产物列表（`GET /api/artifacts/history`，**TaskAgent 记忆与产物 块 4/5**）。
 *
 * ⚠️ **与上面两个出口不同，它带 query**（offset/limit 分页）—— 但那不是"同一个端点加参数"：
 * 上面两条是**同一个资源**的两种**出口**（下载 / 预览），而这一条是**另一个资源**
 * （跨会话的历史产物清单）。分页参数属于列表本身，不存在"用 query 选安全策略"的问题。
 * 放在本文件（与那两个 URL Builder 同处）只是因为 F 组那条源码级断言把"拼 `/api/artifacts/`
 * 前缀"这件事钉在**这一个文件**里 —— 不在这里加，别的模块就会各拼一次。
 */
export function artifactHistoryUrl(offset: number, limit: number): string {
  const search = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return `/api/artifacts/history?${search.toString()}`
}

// ───────────────────────────── 体积闸门 ─────────────────────────────

/** 人类可读的字节数（1 位小数；< 1024 给整数 B） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * "这个产物能不能预览"的**唯一判据**（`子方案④` §二 的两个闸门 + §五 7）。
 *
 * 返回三件事而不是一个布尔：界面上要**说出原因**，而不是只把按钮藏起来 ——
 * `03` §4.6 明写"体积闸门有两种，界面上要能说出原因"。
 *
 * 边界：**恰好等于上限 ⇒ 放行**（`>` 而不是 `>=` —— `子方案④` §七 2 的 D 组就是验这一条）。
 */
export interface PreviewAvailability {
  /** 预览形态（`shared#previewKindOf` 的返回值，前后端同源） */
  kind: PreviewKind
  available: boolean
  /** 不可预览时给用户看的一句话（可预览时为 `null`）；两种原因的文案**刻意不同** */
  reason: string | null
}

export function previewAvailability(artifact: { mime: string; size: number }): PreviewAvailability {
  const kind = previewKindOf(artifact.mime)
  if (kind === 'none') {
    return { kind, available: false, reason: '该格式不支持在线预览，请下载后用本地工具打开' }
  }
  // `text` 那一路要**取回文本进 JS 字符串**，闸门比"交给浏览器直连渲染"更紧
  const limit = kind === 'text' ? ARTIFACT_PREVIEW_MAX_TEXT_BYTES : ARTIFACT_PREVIEW_MAX_INLINE_BYTES
  if (artifact.size > limit) {
    return {
      kind,
      available: false,
      reason: `文件较大（${formatBytes(artifact.size)}，超过在线预览上限 ${formatBytes(limit)}），请下载查看`,
    }
  }
  return { kind, available: true, reason: null }
}

// ───────────────────────────── 文本解码（严格 UTF-8）─────────────────────────────

/**
 * **严格** UTF-8 解码（`子方案④` §五 5）。
 *
 * ⚠️ 为什么不能直接用 `response.text()`：它按 UTF-8 **宽松**解码，非法字节变成 `U+FFFD`
 * ⇒ 用户看到满屏 `�` 而**以为表里就是这个内容**（比报错糟得多）。要能给出"编码不是 UTF-8"
 * 这句可照做的话，就必须用 `fatal: true` 让解码**失败** —— 也因此必须先取 `arrayBuffer()`
 * 再解码（拿到的已经是字符串就无从判断了）。
 *
 * @returns 解码后的文本；**不是 UTF-8 时返回 `null`**（不抛错 —— 调用方要的是"换一种展示"，
 *          而不是一次异常传播）
 */
export function decodeUtf8Text(bytes: Uint8Array | ArrayBuffer): string | null {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(view)
    // Excel 导出的 CSV 常带 BOM：它会被当成第一个表头的一部分（`\uFEFFid`），剥掉
    return text.startsWith('\uFEFF') ? text.slice(1) : text
  } catch {
    return null
  }
}

// ───────────────────────────── CSV（`子方案④` §五 5）─────────────────────────────

/**
 * 分隔符**按 mime 定，不做嗅探**（`子方案④` §五 5）。
 *
 * 嗅探猜错是静默的，而且同一份文件在不同浏览器上可能猜出不同结果 ⇒ 宁可"按 mime 定死"。
 *
 * @returns `,` / `\t`；不是表格类时 `null`（调用方据此决定走哪个渲染器）
 */
export function csvDelimiterOf(mime: string): string | null {
  const base = mime.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  if (base === 'text/tab-separated-values') return '\t'
  if (base === 'text/csv') return ','
  return null
}

/**
 * RFC 4180 解析（**自写，不引第三方库** —— `子方案④` §五 5：这样它才能进无依赖验收档逐条断言）。
 *
 * 逐条覆盖的分支（B 组断言逐条对应）：
 *   · 引号包裹：`a,"b,c",d`
 *   · `""` 转义：`"say ""hi"""`
 *   · **引号内换行**：`"line1\nline2"` 是**一个**单元格，不换行
 *   · 引号内逗号：不切分
 *   · 行尾三种：`\r\n` / `\r` / `\n`
 *   · 空行：产出一行空单元格（**不丢弃** —— 丢掉会让行号与文件对不上）
 *   · 列数不齐：由 {@link buildCsvTable} 补空，不在这一层补（解析器只负责"切分"）
 *
 * @returns 行的数组（每行是单元格数组）；空文本 ⇒ `[]`
 */
export function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  /** 当前这一行有没有"已经开始"（用于文件末尾那一行要不要收） */
  let started = false
  let index = 0

  while (index < text.length) {
    const char = text[index] ?? ''

    if (inQuotes) {
      if (char === '"') {
        // `""` = 字面量一个引号（RFC 4180 的转义）；否则是字段结束
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }

    if (char === '"' && field === '') {
      // 引号只在**字段起始处**进入引号态（`a"b` 里的引号当普通字符，与常见实现一致）
      inQuotes = true
      started = true
      index += 1
      continue
    }

    if (char === delimiter) {
      row.push(field)
      field = ''
      started = true
      index += 1
      continue
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      started = false
      index += 1
      continue
    }

    field += char
    started = true
    index += 1
  }

  // 文件不以换行结尾时，最后一行也要收（`'a,b'` / `'"x"'` 都靠这一句）
  if (row.length > 0 || started || field !== '') {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** 解析后的表格（含三处截断的**原始读数** —— 读数必须报截断前的数） */
export interface CsvTable {
  /** 表头（**首行当表头**，不给开关 —— P0 简化，验收场景"汇总表"必然有表头） */
  header: string[]
  /** 已按三处上限截断后的数据行（渲染用） */
  rows: string[][]
  /** 数据行**总数**（截断前，不含表头）—— 读数报的是它 */
  totalRows: number
  /** **列数**（截断前）—— 表头与其它行里最长的那个 */
  totalCols: number
  shownRows: number
  shownCols: number
  rowTruncated: boolean
  colTruncated: boolean
  /** 是否有单元格因超长被截断（**原值仍在下载的文件里**） */
  cellTruncated: boolean
}

/** 单元格截断：`子方案④` §二 的 `ARTIFACT_PREVIEW_CSV_CELL_CHARS` */
function clipCell(value: string): { text: string; truncated: boolean } {
  // ⚠️ 按**码点**截（与分块、改名同款）：`slice` 会劈开代理对，产出非法字符串
  const chars = [...value]
  if (chars.length <= ARTIFACT_PREVIEW_CSV_CELL_CHARS) return { text: value, truncated: false }
  return { text: `${chars.slice(0, ARTIFACT_PREVIEW_CSV_CELL_CHARS).join('')}…`, truncated: true }
}

/**
 * 文本 → 表格（解析 + 三处截断 + 读数）。
 *
 * ⚠️ **截断必须在界面上明示**（`子方案④` §五 5）：读数取的是 `totalRows` / `totalCols`
 * （截断**前**的数）—— 报截断后的数等于对用户说"这份文件就 5000 行"。
 */
export function buildCsvTable(text: string, delimiter: string): CsvTable {
  const all = parseCsvText(text, delimiter)
  const headerRow = all[0] ?? []
  const dataRows = all.slice(1)

  const totalRows = dataRows.length
  const totalCols = dataRows.reduce((max, row) => Math.max(max, row.length), headerRow.length)
  const shownRows = Math.min(totalRows, ARTIFACT_PREVIEW_CSV_MAX_ROWS)
  const shownCols = Math.min(totalCols, ARTIFACT_PREVIEW_CSV_MAX_COLS)

  let cellTruncated = false
  const clip = (value: string | undefined): string => {
    const result = clipCell(value ?? '')
    if (result.truncated) cellTruncated = true
    return result.text
  }

  const header: string[] = []
  for (let column = 0; column < shownCols; column += 1) header.push(clip(headerRow[column]))

  const rows: string[][] = []
  for (let index = 0; index < shownRows; index += 1) {
    const source = dataRows[index] ?? []
    const cells: string[] = []
    for (let column = 0; column < shownCols; column += 1) cells.push(clip(source[column]))
    rows.push(cells)
  }

  return {
    header,
    rows,
    totalRows,
    totalCols,
    shownRows,
    shownCols,
    rowTruncated: shownRows < totalRows,
    colTruncated: shownCols < totalCols,
    cellTruncated,
  }
}

/**
 * 表格上方的那一行读数（**只在真的截断了时才出现**）。
 *
 * 三处截断各说各的，最后统一补一句"下载可看完整文件" —— 否则用户会以为
 * "这份文件只有 5000 行"，而那是一句假话。
 */
export function csvTableNote(table: CsvTable): string | null {
  const parts: string[] = []
  if (table.rowTruncated) parts.push(`仅显示前 ${table.shownRows} 行（共 ${table.totalRows} 行）`)
  if (table.colTruncated) parts.push(`仅显示前 ${table.shownCols} 列（共 ${table.totalCols} 列）`)
  if (table.cellTruncated) parts.push(`单元格超过 ${ARTIFACT_PREVIEW_CSV_CELL_CHARS} 字符的部分已截断`)
  if (parts.length === 0) return null
  return `${parts.join('；')} —— 完整内容请下载原文件`
}
