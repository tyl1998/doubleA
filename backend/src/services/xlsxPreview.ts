/**
 * XLSX 渲染预览（P1-16）—— **零依赖**的 `.xlsx` 读取 + 转 HTML
 *
 * 依据：`docs/子方案/文件预览.md` §五（格式落法）+ §六（六条安全判据）+ §五 9（本格式，P1-16）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么手写（而不是引 SheetJS / 走 sandbox 的 openpyxl）
 * ─────────────────────────────────────────────────────────────────────
 *   · `xlsx`（SheetJS）npm 源停在 0.18.5（官方走 cdn tarball），私有镜像未必取得到；full 版 ~335KB gzip；
 *   · `openpyxl` 只在 **sandbox 镜像**里、不在 backend node 进程 ⇒ on-demand 预览要容器在跑，不干净；
 *   · `.xlsx` 本质是 **zip + 一小撮 XML**，`node:zlib` 内置解压 ⇒ 手写一个"够用"的读取器**零新依赖**，
 *     且是纯逻辑（`backend/scripts/xlsx-regression.ts` 可直跑断言，同本仓零依赖档纪律）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 只抽"值"，不做版面 / 公式 / 样式还原（这是"预览"不是"编辑器"）
 * ─────────────────────────────────────────────────────────────────────
 *   · 取 `<v>` 原值：数值保持原样（不四舍五入、不做千分位）；共享串 / 内联串 / 布尔 / 错误码照取；
 *   · **不还原数字格式与日期**：Excel 把日期存成序列号 + 样式位，还原要连 `styles.xml` + 内置格式表
 *     一起做 ⇒ 边界写在明处（日期列会显示成序列号），要做属后续增量；
 *   · **不计算公式**：只取缓存值 `<v>`（Excel 存盘时会写上次计算的结果）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 已知边界（别当 bug）
 * ─────────────────────────────────────────────────────────────────────
 *   · 只吃 `.xlsx`（ECMA-376）。`.xls`（OLE2 二进制）不在产物 mime 映射里 ⇒ 只给下载；
 *   · ZIP 只支持 **stored(0)** 与 **deflate(8)** 两种压缩（xlsx 产出工具只会用这两种）；
 *   · **不支持 ZIP64**（超大工作簿）⇒ 直接报错，用户下载原文件；
 *   · 表 / 行 / 列 / 单元格字符四处截断（见下方常量），截断**明示**不静默。
 */

import { inflateRawSync } from 'node:zlib'

import { wrapPreviewDocument } from './previewShell.js'

// ───────────────────────────── 截断闸门（超出明示，不静默）─────────────────────────────

/** 最多显示几个工作表 */
export const XLSX_PREVIEW_MAX_SHEETS = 10
/** 每个表最多显示几行（数据行；不含列头） */
export const XLSX_PREVIEW_MAX_ROWS = 2000
/** 每行最多显示几列 */
export const XLSX_PREVIEW_MAX_COLS = 100
/** 单元格展示字符上限（长文本不撑破布局；原值仍在下载的文件里） */
export const XLSX_PREVIEW_MAX_CELL_CHARS = 200

// ───────────────────────────── ZIP（零依赖：node:zlib 解压）─────────────────────────────

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * 从 zip 字节里解出 `名称 → 内容`（只解**中央目录里列出的条目**，够 xlsx 用）。
 *
 * ⚠️ 用**中央目录**里的 `compressedSize` / `localOffset`，不用本地头的（本地头在"数据描述符"模式下
 * 尺寸字段为 0）。⚠️ 不支持 ZIP64（条目数 / 偏移为 0xFFFF / 0xFFFFFFFF 时直接报错）。
 */
function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // EOCD 在末尾，长度不固定（带注释）⇒ 从后往前找签名
  let eocd = -1
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('不是有效的 zip（找不到 EOCD）')

  const totalLe = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (totalLe === 0xffff || centralOffset === 0xffffffff) throw new Error('不支持 ZIP64 格式的工作簿')

  const entries = new Map<string, Buffer>()
  let offset = centralOffset
  for (let index = 0; index < totalLe; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('zip 中央目录损坏')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 本地头损坏：${name}`)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (raw.length !== compressedSize) throw new Error(`zip 条目数据越界：${name}`)

    if (method === 0) entries.set(name, Buffer.from(raw))
    else if (method === 8) entries.set(name, inflateRawSync(raw))
    else throw new Error(`zip 压缩方式不支持：${method}（${name}）`)

    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ───────────────────────────── XML 小工具（正则，不引解析器；与 parse/docx 同款取舍）─────────────────────────────

/** XML 实体解码（xlsx 只会用到这几种 + 数字实体） */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, group: string) => {
    switch (group) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        if (group.startsWith('#x') || group.startsWith('#X')) {
          const code = Number.parseInt(group.slice(2), 16)
          return Number.isNaN(code) ? whole : String.fromCodePoint(code)
        }
        if (group.startsWith('#')) {
          const code = Number.parseInt(group.slice(1), 10)
          return Number.isNaN(code) ? whole : String.fromCodePoint(code)
        }
        return whole
      }
    }
  })
}

/** 取某个属性的值（兼容双/单引号；属性名里的 `:` 是字面量，不需转义） */
function attr(tag: string, name: string): string | null {
  const double = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'u').exec(tag)
  if (double !== null) return double[1] ?? ''
  const single = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'u').exec(tag)
  return single === null ? null : (single[1] ?? '')
}

/** 拼接一个片段里所有 `<t>` 的文本（`<si>` / `<is>` 都可能有多个 `<t>`，如富文本 run） */
function textOf(fragment: string): string {
  let out = ''
  for (const match of fragment.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gu)) {
    out += match[1] ?? ''
  }
  return decodeXmlEntities(out)
}

/** 取 `<v>` 的值（数字 / 共享串索引 / 布尔 / 错误码都在这里） */
function valueOf(fragment: string): string {
  const match = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/u.exec(fragment)
  return match === null ? '' : decodeXmlEntities(match[1] ?? '')
}

/** 单元格引用（`A1`、`$AB$12`）→ 0 起的列号；解析不出返回 `null` */
function columnOf(ref: string | null): number | null {
  if (ref === null) return null
  const letters = /^([A-Za-z]+)/u.exec(ref.replace(/\$/gu, ''))?.[1]
  if (letters === undefined || letters === '') return null
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

/** 0 起的列号 → 列字母（0→A、26→AA） */
function columnLetter(index: number): string {
  let value = index + 1
  let out = ''
  while (value > 0) {
    const rem = (value - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    value = Math.floor((value - 1) / 26)
  }
  return out
}

// ───────────────────────────── 模型 ─────────────────────────────

export interface XlsxSheet {
  name: string
  /** 数据行（不含列头，列头由渲染层按宽度生成）；每行已按 `MAX_COLS` 截断 */
  rows: string[][]
  /** 该表触发过任一处截断（行/列/单元格字符） */
  truncated: boolean
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[]
  /** 是否因为超过 `MAX_SHEETS` 而丢掉了工作表 */
  truncated: boolean
}

const ROW_RE = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/gu
const CELL_RE = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gu

/** 单个单元格 → 展示字符串（值语义见文件头） */
function cellValue(type: string, inner: string, shared: readonly string[]): string {
  if (type === 's') {
    const index = Number.parseInt(valueOf(inner), 10)
    return Number.isInteger(index) ? (shared[index] ?? '') : ''
  }
  if (type === 'inlineStr') return textOf(inner)
  if (type === 'b') return valueOf(inner) === '1' ? 'TRUE' : 'FALSE'
  // `str`（公式字符串）/ `e`（错误码）/ 默认（数值或日期序列号）都取 `<v>` 原值
  return valueOf(inner)
}

/** 单元格按码点截断（`slice` 会劈开代理对） */
function clipCell(value: string): { text: string; truncated: boolean } {
  const chars = [...value]
  if (chars.length <= XLSX_PREVIEW_MAX_CELL_CHARS) return { text: value, truncated: false }
  return { text: `${chars.slice(0, XLSX_PREVIEW_MAX_CELL_CHARS).join('')}…`, truncated: true }
}

/** `<sheetData>` 的 XML → 二维表（按单元格 `r` 定位列；列头不在这里生成） */
function parseSheetRows(xml: string, shared: readonly string[]): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let truncated = false

  for (const rowMatch of xml.matchAll(ROW_RE)) {
    if (rows.length >= XLSX_PREVIEW_MAX_ROWS) {
      truncated = true
      break
    }
    const inner = rowMatch[2] ?? ''
    const cells: string[] = []
    let autoColumn = 0
    for (const cellMatch of inner.matchAll(CELL_RE)) {
      const attrs = cellMatch[1] ?? ''
      const type = attr(attrs, 't') ?? 'n'
      const column = columnOf(attr(attrs, 'r')) ?? autoColumn
      autoColumn = column + 1
      if (column < 0 || column >= XLSX_PREVIEW_MAX_COLS) {
        truncated = true
        continue
      }
      const clipped = clipCell(cellValue(type, cellMatch[2] ?? '', shared))
      if (clipped.truncated) truncated = true
      cells[column] = clipped.text
    }
    rows.push(cells)
  }
  return { rows, truncated }
}

/** 共享串表（`xl/sharedStrings.xml`）→ 字符串数组 */
function parseSharedStrings(xml: string | null): string[] {
  if (xml === null) return []
  const out: string[] = []
  for (const match of xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gu)) {
    out.push(textOf(match[1] ?? ''))
  }
  return out
}

/** 把关系表里的 `Target`（相对 `xl/`）归一成 zip 内的完整路径 */
function normalizeTarget(target: string): string {
  const clean = target.replace(/^\/+/u, '')
  return clean.startsWith('xl/') ? clean : `xl/${clean}`
}

/**
 * `.xlsx` 字节 → 工作簿模型（见文件头；失败时抛错，调用方兜成 4xx）。
 */
export function parseXlsx(bytes: Buffer): XlsxWorkbook {
  const entries = readZipEntries(bytes)
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8')
  if (workbookXml === undefined) throw new Error('不是有效的 xlsx（缺 xl/workbook.xml）')

  // rId → 工作表路径
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const relTargets = new Map<string, string>()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/gu)) {
    const id = attr(match[0], 'Id')
    const target = attr(match[0], 'Target')
    if (id !== null && target !== null) relTargets.set(id, normalizeTarget(target))
  }

  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? null)

  const sheets: XlsxSheet[] = []
  let truncated = false
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/gu)) {
    if (sheets.length >= XLSX_PREVIEW_MAX_SHEETS) {
      truncated = true
      break
    }
    const tag = match[0]
    const name = decodeXmlEntities(attr(tag, 'name') ?? `Sheet${sheets.length + 1}`)
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id')
    const target = rid === null ? undefined : relTargets.get(rid)
    const sheetXml = target === undefined ? undefined : entries.get(target)?.toString('utf8')
    if (sheetXml === undefined) {
      // 关系对不上（少见）：不静默丢、也不抛错整份失败 —— 记一个"截断"由渲染层如实说明
      truncated = true
      continue
    }
    const { rows, truncated: sheetTruncated } = parseSheetRows(sheetXml, shared)
    sheets.push({ name, rows, truncated: sheetTruncated })
  }
  return { sheets, truncated }
}

// ───────────────────────────── 渲染 ─────────────────────────────

/** 网格样式（列头/行号灰底，单元格不换行撑破布局） */
const GRID_STYLE = [
  '.sheet{margin:1.4em 0 .4em;font-size:1.1em}',
  '.grid{font-variant-numeric:tabular-nums;font-size:13px}',
  '.grid th,.grid td{white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}',
  '.grid thead th{position:sticky;top:0;background:#f6f8fa;color:#57606a;font-weight:600}',
  '.grid th.idx{background:#f6f8fa;color:#8c959f;text-align:right;font-weight:400}',
  '.note{color:#8c959f;font-size:12px;margin:.4em 0}',
].join('')

function renderSheet(sheet: XlsxSheet): string {
  const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0)
  const heading = `<h3 class="sheet">${escapeHeader(sheet.name)}</h3>`
  if (width === 0) return `${heading}<p class="note">（空表）</p>`

  const header =
    '<th class="idx"></th>' +
    Array.from({ length: width }, (_, column) => `<th>${columnLetter(column)}</th>`).join('')
  const body = sheet.rows
    .map((row, index) => {
      const cells = Array.from({ length: width }, (_, column) => `<td>${escapeCell(row[column] ?? '')}</td>`).join('')
      return `<tr><th class="idx">${index + 1}</th>${cells}</tr>`
    })
    .join('')
  const note = sheet.truncated
    ? `<p class="note">仅显示前 ${sheet.rows.length} 行 / ${width} 列（或单元格已截断）—— 完整内容请下载原文件。</p>`
    : ''
  return `${heading}<table class="grid"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>${note}`
}

/** 单元格已经是纯文本（解析时已按码点截断），这里只做 HTML 转义 */
function escapeCell(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** 工作表名转义（来自文件名/单元格，不可信） */
function escapeHeader(value: string): string {
  return escapeCell(value)
}

/**
 * 工作簿模型 → 完整 HTML 文档（与 docx 共用外壳）。
 *
 * ⚠️ 安全与 docx 同款：**靠 `/render` 出口的响应头 CSP `sandbox`**，不在这里净化
 * （`style-src 'unsafe-inline'` 允许 {@link GRID_STYLE} 的内联样式；`default-src 'none'` 挡住一切外链）。
 */
export function renderXlsxToHtml(workbook: XlsxWorkbook, title: string): string {
  const blocks = workbook.sheets.map(renderSheet)
  if (workbook.truncated) {
    blocks.unshift(`<p class="note">工作表较多，仅显示前 ${workbook.sheets.length} 个 —— 完整内容请下载原文件。</p>`)
  }
  if (blocks.length === 0) blocks.push('<p>这个工作簿里没有可显示的工作表。</p>')
  return wrapPreviewDocument(blocks.join(''), title, GRID_STYLE)
}
