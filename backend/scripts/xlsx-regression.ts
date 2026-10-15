/**
 * xlsx-regression.ts —— XLSX 渲染预览的**零依赖**自证（P1-16）
 *
 * 跑法：`pnpm --filter @doubulea/backend xlsx:regression`
 *      （= `node --import tsx scripts/xlsx-regression.ts`；**无 DB / 无 Docker / 不连后端**）
 *
 * 为什么这一档值得存在：`.xlsx` 是 zip + 一小撮 XML，**最容易错又最难看出来的三类**是 ——
 *   ① ZIP 两种压缩（stored=0 / deflate=8）都要能解；② 共享串 / 内联串 / 布尔 / 错误码的取值口径；
 *   ③ 四处截断（表/行/列/单元格）与 XML 实体解码。这些全是纯逻辑，直接用手工构造的 zip 夹具断言。
 *
 * ⚠️ 夹具 zip 的 **CRC32 置 0**（本解析器不校验 CRC —— 它只按中央目录读尺寸与偏移），
 *    这不是"省略"，是刻意：被验的是**解析**，不是压缩正确性。
 */

import { deflateRawSync } from 'node:zlib'

import {
  parseXlsx,
  renderXlsxToHtml,
  XLSX_PREVIEW_MAX_CELL_CHARS,
  XLSX_PREVIEW_MAX_ROWS,
} from '../src/services/xlsxPreview.js'

let passed = 0
let failed = 0
function it(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`)
}

// ───────────────────────────── 手工 zip 夹具 ─────────────────────────────

interface FixtureEntry {
  name: string
  content: string
  /** 0 = stored、8 = deflate */
  method: number
}

/** 造一个结构合法（CRC 置 0）的 zip —— 够本解析器读中央目录即可 */
function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content, 'utf8')
    const data = entry.method === 8 ? deflateRawSync(raw) : raw

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(0, 14) // crc32（本解析器不校验）
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(0, 16) // crc32
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, eocd])
}

// ───────────────────────────── 夹具内容 ─────────────────────────────

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="汇总" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>`

const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/work" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/work" Target="worksheets/sheet2.xml"/></Relationships>`

// 共享串：普通 / 富文本 run（多 <t>）/ XML 实体（&amp; 与数字实体 &#65;）
const SHARED = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5"><si><t>姓名</t></si><si><t>金额</t></si><si><t>张三</t></si><si><r><t>李</t></r><r><t>四</t></r></si><si><t>a&amp;b &#65;</t></si></sst>`

const SHEET1 = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="inlineStr"><is><t>内联</t></is></c><c r="D3" t="s"><v>4</v></c></row></sheetData></worksheet>`

const SHEET2 = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="str"><v>甲</v></c><c r="B1" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>`

function fullWorkbook(method: number, extra: FixtureEntry[] = []): FixtureEntry[] {
  return [
    { name: 'xl/workbook.xml', content: WORKBOOK, method },
    { name: 'xl/_rels/workbook.xml.rels', content: RELS, method },
    { name: 'xl/sharedStrings.xml', content: SHARED, method },
    { name: 'xl/worksheets/sheet1.xml', content: SHEET1, method },
    { name: 'xl/worksheets/sheet2.xml', content: SHEET2, method },
    ...extra,
  ]
}

// ───────────────────────────── A 解析 ─────────────────────────────

console.log('── A ZIP / XML 解析（stored 与 deflate 两条路）──')

it('A1 stored(0) 与 deflate(8) 解出的模型**完全一致**', () => {
  const stored = parseXlsx(buildZip(fullWorkbook(0)))
  const deflated = parseXlsx(buildZip(fullWorkbook(8)))
  eq(deflated, stored, '两种压缩应得同一模型')
})

it('A2 工作表名与顺序（含中文）', () => {
  const wb = parseXlsx(buildZip(fullWorkbook(8)))
  eq(wb.sheets.map((s) => s.name), ['汇总', '明细'], '名称与顺序')
  eq(wb.truncated, false, '没截断')
})

it('A3 共享串 / 内联串 / 布尔 / 数值 / 错误码的取值口径', () => {
  const wb = parseXlsx(buildZip(fullWorkbook(8)))
  eq(
    wb.sheets[0]?.rows,
    [
      ['姓名', '金额'],
      ['张三', '12.5'],
      ['李四', 'TRUE', '内联', 'a&b A'],
    ],
    '第一个表',
  )
  eq(wb.sheets[1]?.rows, [['甲', '#DIV/0!']], '第二个表（str / e）')
})

it('A4 ★ 富文本 run（多个 `<t>`）拼成一个单元格；XML 实体（&amp; / &#65;）已解码', () => {
  const wb = parseXlsx(buildZip(fullWorkbook(8)))
  eq(wb.sheets[0]?.rows[2]?.[0], '李四', 'run 拼接')
  eq(wb.sheets[0]?.rows[2]?.[3], 'a&b A', '实体解码')
})

it('A5 列按 `r="A1"` 定位（跳列时中间留空）', () => {
  const xml = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>`
  const wb = parseXlsx(
    buildZip([
      { name: 'xl/workbook.xml', content: WORKBOOK, method: 8 },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS, method: 8 },
      { name: 'xl/worksheets/sheet1.xml', content: xml, method: 8 },
      { name: 'xl/worksheets/sheet2.xml', content: SHEET2, method: 8 },
    ]),
  )
  const row = wb.sheets[0]?.rows[0] ?? []
  eq(row[0], '1', 'A 列')
  eq(row[2], '3', 'C 列')
  eq(row[1], undefined, 'B 列留空（稀疏数组）')
})

// ───────────────────────────── B 截断 ─────────────────────────────

console.log('── B 四处截断（表 / 行 / 列 / 单元格）──')

it('B1 超行数：保留 MAX_ROWS 行且标记 truncated', () => {
  const rows = Array.from(
    { length: XLSX_PREVIEW_MAX_ROWS + 50 },
    (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`,
  ).join('')
  const xml = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`
  const wb = parseXlsx(
    buildZip([
      { name: 'xl/workbook.xml', content: WORKBOOK, method: 8 },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS, method: 8 },
      { name: 'xl/worksheets/sheet1.xml', content: xml, method: 8 },
      { name: 'xl/worksheets/sheet2.xml', content: SHEET2, method: 8 },
    ]),
  )
  const sheet = wb.sheets[0]
  eq(sheet?.rows.length, XLSX_PREVIEW_MAX_ROWS, '行数上限')
  eq(sheet?.truncated, true, '标记截断')
})

it('B2 超列数：超出 MAX_COLS 的列被丢弃并标记 truncated', () => {
  const cells = Array.from({ length: 150 }, (_, index) => `<c r="${colName(index)}1"><v>${index}</v></c>`).join('')
  const xml = `<?xml version="1.0"?><worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`
  const wb = parseXlsx(
    buildZip([
      { name: 'xl/workbook.xml', content: WORKBOOK, method: 8 },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS, method: 8 },
      { name: 'xl/worksheets/sheet1.xml', content: xml, method: 8 },
      { name: 'xl/worksheets/sheet2.xml', content: SHEET2, method: 8 },
    ]),
  )
  const sheet = wb.sheets[0]
  eq(sheet?.rows[0]?.length, 100, '列数上限')
  eq(sheet?.truncated, true, '标记截断')
})

it('B3 超长单元格：按码点截断 + `…`（边界值恰好等于上限不截断）', () => {
  const exact = 'x'.repeat(XLSX_PREVIEW_MAX_CELL_CHARS)
  const over = 'y'.repeat(XLSX_PREVIEW_MAX_CELL_CHARS + 30)
  const sharedXml = `<sst><si><t>${exact}</t></si><si><t>${over}</t></si></sst>`
  const sheetXml = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>`
  const wb = parseXlsx(
    buildZip([
      { name: 'xl/workbook.xml', content: WORKBOOK, method: 8 },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS, method: 8 },
      { name: 'xl/sharedStrings.xml', content: sharedXml, method: 8 },
      { name: 'xl/worksheets/sheet1.xml', content: sheetXml, method: 8 },
      { name: 'xl/worksheets/sheet2.xml', content: SHEET2, method: 8 },
    ]),
  )
  const row = wb.sheets[0]?.rows[0] ?? []
  eq(row[0], exact, '恰好等于上限 ⇒ 不截断')
  eq([...(row[1] ?? '')].length, XLSX_PREVIEW_MAX_CELL_CHARS + 1, '截断到上限 + 一个省略号')
  assert((row[1] ?? '').endsWith('…'), '应以省略号结尾')
})

it('B4 超工作表数：标记 truncated', () => {
  const sheets = Array.from({ length: 12 }, (_, index) => `<sheet name="S${index}" sheetId="${index + 1}" r:id="rId1"/>`).join('')
  const wb = parseXlsx(
    buildZip([
      { name: 'xl/workbook.xml', content: `<workbook><sheets>${sheets}</sheets></workbook>`, method: 8 },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS, method: 8 },
      { name: 'xl/worksheets/sheet1.xml', content: SHEET2, method: 8 },
    ]),
  )
  eq(wb.sheets.length, 10, '表数上限')
  eq(wb.truncated, true, '标记截断')
})

// ───────────────────────────── C 渲染与错误 ─────────────────────────────

console.log('── C 渲染 / 错误 ──')

it('C1 渲染出 HTML：含表名、`<table>`，且单元格里的 `<` 被转义', () => {
  const wb = parseXlsx(buildZip(fullWorkbook(8)))
  const html = renderXlsxToHtml(wb, '报表.xlsx')
  assert(html.includes('<table'), '含表格')
  assert(html.includes('汇总') && html.includes('明细'), '含表名')
  assert(html.includes('<title>报表.xlsx</title>'), '含标题（转义）')

  const evil = parseXlsx(
    buildZip([
      { name: 'xl/workbook.xml', content: WORKBOOK, method: 8 },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS, method: 8 },
      { name: 'xl/sharedStrings.xml', content: `<sst><si><t>&lt;script&gt;</t></si></sst>`, method: 8 },
      { name: 'xl/worksheets/sheet1.xml', content: `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`, method: 8 },
      { name: 'xl/worksheets/sheet2.xml', content: SHEET2, method: 8 },
    ]),
  )
  const evilHtml = renderXlsxToHtml(evil, 'x')
  assert(!evilHtml.includes('<script>'), '不得出现未转义的 <script>')
  assert(evilHtml.includes('&lt;script&gt;'), '应转义成文本')
})

it('C2 缺 `xl/workbook.xml` ⇒ 抛错（调用方兜成 4xx）', () => {
  let threw = false
  try {
    parseXlsx(buildZip([{ name: 'hello.txt', content: 'x', method: 8 }]))
  } catch {
    threw = true
  }
  assert(threw, '应抛错')
})

it('C3 不是 zip ⇒ 抛错', () => {
  let threw = false
  try {
    parseXlsx(Buffer.from('not a zip at all', 'utf8'))
  } catch {
    threw = true
  }
  assert(threw, '应抛错')
})

// ───────────────────────────── 结论 ─────────────────────────────

console.log(`\nxlsx-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)

/** 造列名（0→A、25→Z、26→AA）—— 仅测试用，与渲染层的 `columnLetter` 独立实现，顺便交叉验证 */
function colName(index: number): string {
  let value = index + 1
  let out = ''
  while (value > 0) {
    const rem = (value - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    value = Math.floor((value - 1) / 26)
  }
  return out
}
