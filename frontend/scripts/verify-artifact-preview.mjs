#!/usr/bin/env node
/**
 * verify-artifact-preview.mjs —— 产物预览前端**无依赖**验收（P0-3-10）
 *
 * 跑法：`pnpm verify:artifact-preview`
 *      （= `node --import tsx frontend/scripts/verify-artifact-preview.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险集中在几处**错了不会报错、只会看到一句假话或一个不该出现的风险**的地方：
 *   · **格式分派**：`image/svg+xml` 若被当成普通图片（`<img>` 直出），"在新标签页打开"就会以
 *     **我们站点的源**执行脚本 —— 界面上却完全看不出它和 PNG 有什么区别；
 *   · **CSV 的三处截断**：读数报成"截断后"的数 ⇒ 用户以为这份文件只有 5000 行（一句假话）；
 *     单元格截断若按 `slice` 截会劈开代理对，产出非法字符串；
 *   · **体积闸门的边界**：写成 `>=` 会让"恰好等于上限"的文件被拒（且没有任何一层报错）；
 *   · **URL 只有一处拼**：拼错时症状是"预览空白 / 下载 404"，而界面上看不出是路径错了还是文件没了。
 * 这些全是纯函数或源码级事实 ⇒ 直接喂字面量、手写夹具，逐条断言（P0-1-35 同款手法）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · **响应头是不是真的那样**（CSP `sandbox` / `nosniff` / `inline`）⇒ 那是后端的事，
 *     命令行取证在 `README`「产物预览」一节（`curl -D-` 看五个头）；
 *   · **浏览器里真渲染出来了吗**（iframe 沙箱、PDF viewer、虚拟表格能不能滚）⇒ 浏览器端测属
 *     **P0-3-11**（产物面板与「预览」按钮的接入点在那批）；
 *   · **MD 的外链图片有没有真的被拦下** ⇒ 归浏览器端测（DevTools Network 无该地址）；
 *   · 打包后的行为（本档跑的是**源码**，不经 vite）。
 *
 * ⚠️ 与其余前端档同款：本档 import `@doubulea/shared`，node 解析到 **`shared/dist`**
 * ⇒ 改过 `shared/src` 之后要先 `pnpm --filter @doubulea/shared build`，否则读到的是旧产物
 * （`previewKindOf` 会是 `undefined`，症状是一组"莫名其妙的失败"而不是"缺一个导出"）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ───────────────────────────── 断言脚手架 ─────────────────────────────

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  y: useColor ? '\u001b[33m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0
let currentGroup = null
const groups = []

function groupStart(id, title, note) {
  currentGroup = { id, title, note, passed: 0, failed: 0 }
  groups.push(currentGroup)
  console.log(`\n${c.b}── ${id} ${title} ──${c.x}`)
  if (note !== undefined) console.log(`   ${c.d}${note}${c.x}`)
}

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    if (currentGroup !== null) currentGroup.passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    if (currentGroup !== null) currentGroup.failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

/** 该串里有没有 CJK 汉字（判断"en 译文里还留着中文"） */
const CJK = /[\u4e00-\u9fff]/

/**
 * 去掉注释再搜源码字面量（`verify-knowledge-ui.mjs` 同款）。
 *
 * 为什么必须去注释：F 组要守的是"**拼串**只有一处"，而源文件里解释端口/路径的注释
 * 会命中同一个字符串 —— 不去注释的话，这条断言量的是"谁提到过它"而不是"谁拼了它"。
 */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '')
}

// ───────────────────────────── 被测对象 ─────────────────────────────

const {
  previewKindOf,
  translate,
  ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
  ARTIFACT_PREVIEW_MAX_TEXT_BYTES,
} = await import('@doubulea/shared')

const {
  ARTIFACT_PREVIEW_CSV_MAX_ROWS,
  ARTIFACT_PREVIEW_CSV_MAX_COLS,
  ARTIFACT_PREVIEW_CSV_CELL_CHARS,
  artifactContentUrl,
  artifactDownloadUrl,
  artifactRenderUrl,
  csvDelimiterOf,
  decodeUtf8Text,
  isMarkdownMime,
  parseCsvText,
  buildCsvTable,
  csvTableNote,
  previewAvailability,
} = await import('../src/components/ArtifactPreview/artifactPreview.ts')

// ───────────────────────────── A 格式分派 ─────────────────────────────

groupStart('A', '`previewKindOf(mime)` 分派矩阵（前后端同一个函数 ⇒ 不可能分叉）')

await it('A1 五种形态各归各位', () => {
  assertEqual(previewKindOf('text/html'), 'html', 'text/html')
  assertEqual(previewKindOf('application/xhtml+xml'), 'html', 'xhtml')
  assertEqual(previewKindOf('image/png'), 'image', 'image/png')
  assertEqual(previewKindOf('application/pdf'), 'pdf', 'application/pdf')
  assertEqual(previewKindOf('text/markdown'), 'text', 'text/markdown')
  assertEqual(previewKindOf('text/csv'), 'text', 'text/csv')
  assertEqual(previewKindOf('text/tab-separated-values'), 'text', 'tsv')
  assertEqual(previewKindOf('text/plain'), 'text', 'text/plain')
  assertEqual(previewKindOf('application/json'), 'text', 'application/json')
})

await it('A2 ★ `image/svg+xml` 归 `html` 那一族（**不是** image）—— SVG 能带 `<script>`', () => {
  // 反面：归到 `<img>` 直出的话，"在新标签页打开"就会以我们站点的源执行脚本
  assertEqual(previewKindOf('image/svg+xml'), 'html', 'svg 走 iframe + 双隔离')
  assertEqual(previewKindOf('image/gif'), 'image', 'gif 仍是普通图片')
  assertEqual(previewKindOf('image/webp'), 'image', 'webp 仍是普通图片')
})

await it('A3 `none`：zip / 未知类型 / 空串 / `undefined` ⇒ 都不给预览入口', () => {
  assertEqual(previewKindOf('application/octet-stream'), 'none', 'octet-stream')
  assertEqual(previewKindOf('application/zip'), 'none', 'zip')
  assertEqual(previewKindOf(''), 'none', '空串')
  assertEqual(previewKindOf(undefined), 'none', 'undefined（不抛错）')
  assertEqual(previewKindOf(null), 'none', 'null（不抛错）')
})

await it('A3b ★ DOCX/XLSX 是独立形态（P1-16）：**不是** html（原始字节是二进制 OOXML），走 `/render` 出口', () => {
  assertEqual(
    previewKindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'docx',
    'docx',
  )
  assertEqual(
    previewKindOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    'xlsx',
    'xlsx',
  )
  // pptx 仍未支持 ⇒ none
  assertEqual(
    previewKindOf('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    'none',
    'pptx 仍 none',
  )
})

await it('A4 大小写与参数都不影响判定（`text/HTML; charset=utf-8`）', () => {
  assertEqual(previewKindOf('TEXT/HTML'), 'html', '大小写')
  assertEqual(previewKindOf('text/html; charset=utf-8'), 'html', '带参数')
  assertEqual(previewKindOf('  text/csv  '), 'text', '前后空白')
})

await it('A5 文本/代码并入 `text` 一族（P1-16 起）：**任何 `text/*`** 都走源码预览，不再"只给下载"', () => {
  assertEqual(previewKindOf('text/x-python'), 'text', 'py')
  assertEqual(previewKindOf('text/javascript'), 'text', 'js')
  assertEqual(previewKindOf('text/typescript'), 'text', 'ts')
  assertEqual(previewKindOf('text/x-shellscript'), 'text', 'sh')
  assertEqual(previewKindOf('text/yaml'), 'text', 'yaml')
  assertEqual(previewKindOf('application/xml'), 'text', 'xml')
  assertEqual(previewKindOf('text/x-markdown'), 'text', 'md 变体')
  // 其它语言（工作区表认得的）现在也自动命中 `text/*` 兜底
  assertEqual(previewKindOf('text/x-java'), 'text', 'java')
  assertEqual(previewKindOf('text/x-go'), 'text', 'go')
  assertEqual(previewKindOf('text/x-rust'), 'text', 'rust')
  assertEqual(previewKindOf('text/css'), 'text', 'css')
  assertEqual(previewKindOf('text/x-sql'), 'text', 'sql')
  assertEqual(previewKindOf('text/x-toml'), 'text', 'toml')
  // ★ `text/html` 仍归 `html`（不能被 `text/*` 兜底吞掉）—— 那是唯一必须"当文档"的 text/*
  assertEqual(previewKindOf('text/html'), 'html', 'html 不被兜底吞掉')
})

await it('A6 Markdown 变体判据：`isMarkdownMime` 只认 MD，代码类仍走 `<pre>`', () => {
  assertEqual(isMarkdownMime('text/markdown'), true, 'md')
  assertEqual(isMarkdownMime('text/x-markdown'), true, 'md 变体')
  assertEqual(isMarkdownMime('text/markdown; charset=utf-8'), true, '带参数')
  assertEqual(isMarkdownMime('text/x-python'), false, 'py 不是 md')
  assertEqual(isMarkdownMime('application/json'), false, 'json 不是 md')
})

// ───────────────────────────── B CSV 解析（RFC 4180，自写）─────────────────────────────

groupStart('B', '`parseCsvText` 逐条分支（引号内换行 / `""` 转义 / 三种行尾 / 空行 / 列数不齐）')

await it('B1 基本切分与表头', () => {
  assertDeepEqual(parseCsvText('a,b\n1,2', ','), [['a', 'b'], ['1', '2']], '两行两列')
  assertDeepEqual(parseCsvText('a,b\n1,2\n', ','), [['a', 'b'], ['1', '2']], '末尾换行不多产一行')
})

await it('B2 引号包裹：引号内的逗号**不切分**', () => {
  assertDeepEqual(parseCsvText('a,"b,c",d', ','), [['a', 'b,c', 'd']], '引号内逗号')
})

await it('B3 `""` 转义成一个字面量引号', () => {
  assertDeepEqual(parseCsvText('"say ""hi"""', ','), [['say "hi"']], 'RFC 4180 的转义')
})

await it('B4 ★ 引号内换行**不换行**（这是最容易被切错的一条）', () => {
  assertDeepEqual(parseCsvText('a,"x\ny"\n2,3', ','), [['a', 'x\ny'], ['2', '3']], '引号内 LF')
  assertDeepEqual(parseCsvText('a,"x\r\ny"\r\n2,3', ','), [['a', 'x\r\ny'], ['2', '3']], '引号内 CRLF 原样保留')
})

await it('B5 三种行尾：`\\r\\n` / `\\r` / `\\n`', () => {
  assertDeepEqual(parseCsvText('a,b\r\n1,2\r\n', ','), [['a', 'b'], ['1', '2']], 'CRLF')
  assertDeepEqual(parseCsvText('a,b\r1,2', ','), [['a', 'b'], ['1', '2']], 'CR')
  assertDeepEqual(parseCsvText('a,b\n1,2', ','), [['a', 'b'], ['1', '2']], 'LF')
})

await it('B6 空行产出一行空单元格（**不丢弃** —— 丢了行号就与文件对不上）', () => {
  assertDeepEqual(parseCsvText('a,b\n\nc,d', ','), [['a', 'b'], [''], ['c', 'd']], '中间空行')
})

await it('B7 列数不齐与空文本', () => {
  assertDeepEqual(parseCsvText('a,b,c\n1,2', ','), [['a', 'b', 'c'], ['1', '2']], '短行不补（补齐在 buildCsvTable）')
  assertDeepEqual(parseCsvText('', ','), [], '空文本')
  assertDeepEqual(parseCsvText('""', ','), [['']], '只有一个空引号字段')
})

await it('B8 TSV 用 `\\t` 分隔（分隔符**按 mime 定**，不做嗅探）', () => {
  assertDeepEqual(parseCsvText('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']], 'TSV')
  assertEqual(csvDelimiterOf('text/tab-separated-values'), '\t', 'tsv → \\t')
  assertEqual(csvDelimiterOf('text/csv'), ',', 'csv → ,')
  assertEqual(csvDelimiterOf('text/plain'), null, 'plain 不是表格')
})

// ───────────────────────────── C 三处截断与读数 ─────────────────────────────

groupStart('C', '行 / 列 / 单元格三处截断 —— **读数必须报截断前的数**')

/** 造一份 CSV：`rows` 数据行（不含表头）、每行列数 `cols` */
function makeCsv(rows, cols, cell = 'x') {
  const header = Array.from({ length: cols }, (_, index) => `h${index}`).join(',')
  const body = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, col) => `${cell}${r}-${col}`).join(','),
  ).join('\n')
  return `${header}\n${body}`
}

await it('C1 超行：保留 MAX_ROWS 行，**读数报原始总数**', () => {
  const rows = ARTIFACT_PREVIEW_CSV_MAX_ROWS + 1000
  const table = buildCsvTable(makeCsv(rows, 3), ',')
  assertEqual(table.rows.length, ARTIFACT_PREVIEW_CSV_MAX_ROWS, '渲染的行数')
  assertEqual(table.shownRows, ARTIFACT_PREVIEW_CSV_MAX_ROWS, 'shownRows')
  assertEqual(table.totalRows, rows, '★ totalRows 必须是截断前的数')
  assertEqual(table.rowTruncated, true, 'rowTruncated')
  assertIncludes(csvTableNote(table, 'zh'), `共 ${rows} 行`, '读数文案含原始总数')
  assertEqual(
    csvTableNote(table, 'zh'),
    `仅显示前 ${ARTIFACT_PREVIEW_CSV_MAX_ROWS} 行（共 ${rows} 行） —— 完整内容请下载原文件`,
    'zh 读数与迁移前逐字一致',
  )
  const noteEn = csvTableNote(table, 'en')
  assertIncludes(noteEn, String(rows), 'en 读数含原始总数')
  assert(!CJK.test(noteEn), `en 读数不该有汉字：${noteEn}`)
})

await it('C2 超列：保留 MAX_COLS 列，读数报原始列数', () => {
  const cols = ARTIFACT_PREVIEW_CSV_MAX_COLS + 20
  const table = buildCsvTable(makeCsv(2, cols), ',')
  assertEqual(table.header.length, ARTIFACT_PREVIEW_CSV_MAX_COLS, '表头列数')
  assertEqual(table.rows[0]?.length, ARTIFACT_PREVIEW_CSV_MAX_COLS, '数据行单元格数')
  assertEqual(table.totalCols, cols, '★ totalCols 必须是截断前的数')
  assertEqual(table.colTruncated, true, 'colTruncated')
  assertIncludes(csvTableNote(table, 'zh'), `共 ${cols} 列`, '读数文案含原始列数')
})

await it('C3 超长单元格：截断 + 标 `…`，**边界值（恰好等于上限）不截断**', () => {
  const exact = 'y'.repeat(ARTIFACT_PREVIEW_CSV_CELL_CHARS)
  const exactTable = buildCsvTable(`h\n${exact}`, ',')
  assertEqual(exactTable.cellTruncated, false, '恰好等于上限 ⇒ 不截断')
  assertEqual(exactTable.rows[0]?.[0], exact, '原样保留')

  const long = 'z'.repeat(ARTIFACT_PREVIEW_CSV_CELL_CHARS + 50)
  const table = buildCsvTable(`h\n${long}`, ',')
  assertEqual(table.cellTruncated, true, 'cellTruncated')
  const cell = table.rows[0]?.[0] ?? ''
  assertEqual([...cell].length, ARTIFACT_PREVIEW_CSV_CELL_CHARS + 1, '截断到上限 + 一个省略号（按**码点**算）')
  assert(cell.endsWith('…'), `应以省略号结尾，实际结尾 ${JSON.stringify(cell.slice(-3))}`)
  assertIncludes(csvTableNote(table, 'zh'), '已截断', '读数文案说明截断')
})

await it('C4 没截断时**不给**那行读数（不制造"好像截了"的错觉）', () => {
  const table = buildCsvTable('a,b\n1,2\n', ',')
  assertEqual(csvTableNote(table, 'zh'), null, '小文件没有读数')
  assertEqual(table.rowTruncated, false, 'rowTruncated')
  assertEqual(table.colTruncated, false, 'colTruncated')
})

await it('C5 短行补空、空表头给占位名所需的原始数据都在（`totalCols` 取最长那一行）', () => {
  const table = buildCsvTable('a,b,c\n1,2\n', ',')
  assertEqual(table.totalCols, 3, '列数按表头算（最长）')
  assertEqual(table.rows[0]?.length, 3, '短行已补到 3 列')
  assertEqual(table.rows[0]?.[2], '', '补的是空串')
})

// ───────────────────────────── D 体积闸门 ─────────────────────────────

groupStart('D', '两个体积闸门的**边界**（恰好等于上限 ⇒ 放行；上限 +1 ⇒ 只给下载）')

await it('D1 内联类（图片 / PDF）：上限放行、+1 拒绝，且文案说的是"较大"', () => {
  const atLimit = previewAvailability({ mime: 'image/png', size: ARTIFACT_PREVIEW_MAX_INLINE_BYTES })
  assertEqual(atLimit.available, true, '恰好等于上限 ⇒ 放行')
  assertEqual(atLimit.reason, null, '放行时没有原因文案')

  const over = previewAvailability({ mime: 'image/png', size: ARTIFACT_PREVIEW_MAX_INLINE_BYTES + 1 })
  assertEqual(over.available, false, '上限 +1 ⇒ 只给下载')
  assertEqual(over.reason?.key, 'artifact.preview.tooLarge', '原因是"文件较大"而不是"不支持"')
  assertIncludes(translate('zh', over.reason.key, over.reason.params), '较大', 'zh 原因文案')
  assert(!CJK.test(translate('en', over.reason.key, over.reason.params)), 'en 原因文案不含汉字')
})

await it('D2 文本类（MD / CSV）：用**更紧**的那个闸门', () => {
  assert(
    ARTIFACT_PREVIEW_MAX_TEXT_BYTES < ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
    '文本闸门必须比内联闸门紧（文本要进 JS 字符串并参与解析）',
  )
  const atLimit = previewAvailability({ mime: 'text/csv', size: ARTIFACT_PREVIEW_MAX_TEXT_BYTES })
  assertEqual(atLimit.available, true, '恰好等于上限 ⇒ 放行')
  const over = previewAvailability({ mime: 'text/csv', size: ARTIFACT_PREVIEW_MAX_TEXT_BYTES + 1 })
  assertEqual(over.available, false, '上限 +1 ⇒ 只给下载')
})

await it('D3 `none` 与体积无关（再小也不给预览），原因是"不支持"而不是"较大"', () => {
  const small = previewAvailability({ mime: 'application/zip', size: 10 })
  assertEqual(small.available, false, 'zip 再小也不预览')
  assertEqual(small.reason?.key, 'artifact.preview.unsupported', '原因 key')
  assertIncludes(translate('zh', small.reason.key), '不支持在线预览', 'zh 原因文案')
  assert(!CJK.test(translate('en', small.reason.key)), 'en 原因文案不含汉字')
})

// ───────────────────────────── E 两个 URL ─────────────────────────────

groupStart('E', '预览 / 下载 URL 的构造（**不带任何 query**：两个出口不是一个端点加参数）')

await it('E1 路径里带上 artifactId，且**没有** query', () => {
  assertEqual(artifactContentUrl('a1'), '/api/artifacts/a1/content', 'content')
  assertEqual(artifactDownloadUrl('a1'), '/api/artifacts/a1/download', 'download')
  assertEqual(artifactRenderUrl('a1'), '/api/artifacts/a1/render', 'render（DOCX 渲染出口）')
  assert(!artifactContentUrl('a1').includes('?'), '预览 URL 不带 query')
  assert(!artifactDownloadUrl('a1').includes('?'), '下载 URL 不带 query')
  assert(!artifactRenderUrl('a1').includes('?'), '渲染 URL 不带 query')
})

await it('E2 id 走 `encodeURIComponent`（产物 id 是 uuid，但拼串那处不该信任输入形态）', () => {
  assertEqual(artifactContentUrl("a b&c"), '/api/artifacts/a%20b%26c/content', '特殊字符已编码')
  assertEqual(artifactRenderUrl("a b&c"), '/api/artifacts/a%20b%26c/render', '渲染 URL 同样编码')
})

// ───────────────────────────── F 源码级守门 ─────────────────────────────

groupStart('F', '`/api/artifacts/` 这个字符串在 `frontend/src` 下**恰好一处**（扫目录，不 grep 单文件）')

/** 递归列出目录下所有文件（相对路径） */
function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(full.slice(base.length + 1))
  }
  return out
}

await it('F1 只有 `artifactPreview.ts` 拼了这个路径（别的模块一律调它的函数）', () => {
  const hits = listFiles(new URL('../src', import.meta.url).pathname).filter((relative) =>
    stripComments(readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8')).includes('/api/artifacts/'),
  )
  assertDeepEqual(hits, ['components/ArtifactPreview/artifactPreview.ts'], '拼串的文件清单')
})

// ───────────────────────────── G 文本解码（严格 UTF-8）────────────────────────────

groupStart('G', '`decodeUtf8Text`：非 UTF-8 必须**失败**，而不是宽松解码出满屏 `�`')

await it('G1 UTF-8（含中文）正常解出；BOM 被剥掉', () => {
  assertEqual(decodeUtf8Text(new TextEncoder().encode('姓名,金额\n张三,12')), '姓名,金额\n张三,12', '中文')
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b')])
  assertEqual(decodeUtf8Text(withBom), 'a,b', 'BOM 剥离（否则第一个表头变成 `\\uFEFFa`）')
})

await it('G2 ★ GBK 字节 ⇒ `null`（调用方据此显示"编码不是 UTF-8"，而不是满屏问号）', () => {
  // "姓名" 的 GBK 编码（0xD0 0xD5 0xC3 0xFB），不是合法 UTF-8
  assertEqual(decodeUtf8Text(new Uint8Array([0xd0, 0xd5, 0xc3, 0xfb])), null, 'GBK ⇒ null')
  assertEqual(decodeUtf8Text(new Uint8Array([0xff, 0xfe])), null, '孤立字节 ⇒ null')
  assertEqual(decodeUtf8Text(new Uint8Array([])), '', '空文件 ⇒ 空串（不是 null）')
})

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── 结论表（` + '`子方案④`' + ` §七 2 的六组）──${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · 后端的五个响应头（CSP sandbox / nosniff / inline / Content-Type / no-store）⇒ ` + '`README`' + ` 的 curl -D-`)
console.log(`  · 浏览器里真渲染出来了吗（iframe 沙箱、PDF viewer、虚拟表格）⇒ 浏览器端测属 **P0-3-11**${c.x}`)
console.log(`  · MD 的外链图片有没有真的被拦下 ⇒ 浏览器端测（DevTools Network 无该地址）${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 产物预览前端纯逻辑验收通过（P0-3-10）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 产物预览前端纯逻辑验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
