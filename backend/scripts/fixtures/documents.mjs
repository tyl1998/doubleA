/**
 * 测试夹具：四格式文档的**内存生成器**（P0-1-16 起）
 *
 * 为什么不用仓库外的样例文件：
 *   · 二进制样例没法 review（改了看不出来），且会让"验收脚本依赖某个本地文件"；
 *   · 生成的夹具**逐字节确定** —— 断言可以写"页码/标题路径恰好等于什么"，
 *     而不是"能解析出东西就行"。
 *
 * 三种格式都是手写的，零新增依赖（P0-1-16 定案）：
 *   · PDF —— 最小 PDF 1.4 骨架（内置 Helvetica），可指定页数与每页文本行；
 *   · DOCX —— 最小 OOXML（`[Content_Types].xml` + 两个 rels + `word/document.xml` + `word/styles.xml`），
 *     用**本文件自带的 ZIP 写入器**（store 方式，不压缩）打包。
 *     ⚠️ 刻意不引 `jszip`：它是 mammoth 的**传递依赖**（幽灵依赖），验收脚本里用它会掩盖
 *     "某天 mammoth 换了压缩库"这类变化；自己写 40 行 ZIP 反而更确定。
 *   · MD / TXT —— 纯文本，UTF-8 与 GBK 各一份（GBK 那份用查表字节，见下）。
 */

import { deflateRawSync } from 'node:zlib'

// ═════════════════════════════ ZIP 写入器（store，够 OOXML 用）════════════════════════

/** CRC-32 查表（ZIP 中央目录要它） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 打一个 ZIP 包。`entries` = `[{ name, content }]`（`content` 为 string 或 Buffer）。
 * `compress: true` 时走 deflate（method=8），否则 store（method=0）。
 */
export function makeZip(entries, { compress = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')
    const method = compress ? 8 : 0
    const payload = compress ? deflateRawSync(raw) : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x0021, 12) // mod date（1980-01-01，固定值保证可复现）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    locals.push(local, nameBytes, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + payload.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuffer, eocd])
}

// ═════════════════════════════ PDF ═════════════════════════════

/**
 * 最小 PDF（1 页 = 1 个内容流，Helvetica 内置字体）。
 *
 * @param {string[][]} pages 每页一个字符串数组（每行一条 `Tj`）
 * @returns {Buffer}
 */
export function makePdf(pages) {
  const objects = []
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((lines, index) => {
    const pageId = 4 + index * 2
    const contentId = pageId + 1
    objects[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    // ⚠️ `(` `)` `\` 在 PDF 字面串里要转义：夹具文本是可控的，这里只做最小转义
    const escape = (text) => text.replace(/[\\()]/g, (ch) => `\\${ch}`)
    const stream =
      'BT /F1 14 Tf 72 720 Td 16 TL\n' + lines.map((line) => `(${escape(line)}) Tj T*`).join('\n') + '\nET'
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  let out = '%PDF-1.4\n'
  const offsets = []
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefStart = out.length
  const size = objects.length
  out += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let id = 1; id < size; id += 1) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  // 逐字符 latin1 写入：PDF 的 xref 偏移是按**字节**算的，必须与上面的字符串长度一致
  return Buffer.from(out, 'latin1')
}

/** 扫描件替身：有页面但没有文本内容（P0-1-18 的"空文本检测"用例） */
export function makeBlankPdf(pageCount = 1) {
  return makePdf(Array.from({ length: pageCount }, () => ['']))
}

/** 假 PDF：内容其实是文本（"改名绕过"用例） */
export function makeFakePdf() {
  return Buffer.from('这不是 PDF，只是一段文本被改名成 .pdf\n', 'utf8')
}

// ═════════════════════════════ DOCX ═════════════════════════════

/** OOXML 里要转义的五个字符 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 最小可解析 DOCX。
 *
 * @param {{ level?: number, text: string }[]} blocks
 *        `level` 1..3 = 标题（对应 Word 的 Heading 1..3，mammoth 会映射成 `<h1>`..`<h3>`）；
 *        不传 = 正文段落。
 * @param {{ compress?: boolean }} [options] 默认 store（不压缩）—— 压缩会引入 deflate 差异，
 *        夹具要的是"每次跑都逐字节一样"
 * @returns {Buffer}
 */
export function makeDocx(blocks, options = {}) {
  const paragraphs = blocks
    .map((block) => {
      const style = block.level === undefined ? undefined : `Heading${block.level}`
      const pPr = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
      return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(block.text)}</w:t></w:r></w:p>`
    })
    .join('')

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`

  // 标题样式必须在 styles.xml 里声明 w:name —— mammoth 的默认样式映射按**样式名**
  // （"Heading 1"）判定，不是按 styleId。少了它，标题会退化成普通段落（标题层级丢失）。
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    [1, 2, 3]
      .map(
        (level) =>
          `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
          `<w:name w:val="Heading ${level}"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>`,
      )
      .join('') +
    '</w:styles>'

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>'

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'

  return makeZip(
    [
      { name: '[Content_Types].xml', content: contentTypes },
      { name: '_rels/.rels', content: rootRels },
      { name: 'word/_rels/document.xml.rels', content: documentRels },
      { name: 'word/document.xml', content: documentXml },
      { name: 'word/styles.xml', content: stylesXml },
    ],
    options,
  )
}

/** 假 DOCX：不是 ZIP 的普通文本（"改名绕过"用例） */
export function makeFakeDocx() {
  return Buffer.from('这不是 docx\n', 'utf8')
}

// ═════════════════════════════ MD / TXT ═════════════════════════════

export function makeMarkdown() {
  return Buffer.from(
    [
      '# 员工手册',
      '',
      '本手册适用于全体员工。',
      '',
      '## 报销制度',
      '',
      '出差住宿标准为每晚上限 500 元。',
      '',
      '### 交通费',
      '',
      '市内交通凭票报销。',
      '',
      '```bash',
      'echo "# 这行在代码块里，不是标题"',
      '```',
      '',
      '## 考勤',
      '',
      '迟到超过 30 分钟记旷工。',
    ].join('\n'),
    'utf8',
  )
}

export function makeTxtUtf8() {
  return Buffer.from('第一行：设备巡检记录\n第二行：主机房温度 22 度\n第三行：无异常\n', 'utf8')
}

/**
 * GBK 编码的 TXT（P0-1-16 坑预判的"编码嗅探"用例）。
 *
 * GB2312/GBK 双字节码**硬编码在注释里**，不用 iconv 编码（Node 只有 GBK 解码器，没有编码器）。
 * 字符 → 字节：中 D6D0 / 文 CEC4 / 编 B1E0 / 码 C2EB / 测 B2E2 / 试 CAD4 / 报 B1A8 / 告 B8E6。
 */
export function makeTxtGbk() {
  const bytes = [
    0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xe0, 0xc2, 0xeb, // 中文编码
    0x3a, 0x20, // ": "
    0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xa8, 0xb8, 0xe6, // 测试报告
    0x0a, // \n
    0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xe0, 0xc2, 0xeb, 0x0a, // 中文编码\n
  ]
  return Buffer.from(bytes)
}

/** `.doc`（旧版 Word 二进制）：只要文件头 OLE2 魔数，用来验"必须直接拒绝" */
export function makeLegacyDoc() {
  const ole = Buffer.alloc(64, 0)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole, 0)
  return ole
}
