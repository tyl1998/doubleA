#!/usr/bin/env node
/**
 * doc-sniff-regression.ts —— P1-12「`.doc` 按内容嗅探」的**自证基线**
 *
 * 跑法：`pnpm --filter @doubulea/backend doc:sniff`
 *
 * 依据：`docs/子方案/图片OCR与图片理解.md` §六·补、`05-P系列计划拆分.md` §三 / §三·补 P1-12。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么只验**纯函数**（不连上游、不连 DB、不连 S3）
 * ─────────────────────────────────────────────────────────────────────
 * 真跑取证留给用户（`06` §六 第 30 条：智能体只做自证）。本脚本守的是格式嗅探里
 * 最容易写错、也最该回归的四件事：
 *   ① **`.doc` 内容嗅探的判据**：OLE2 / RTF / MHTML / HTML / 其它 五类分得清 ——
 *      唯它决定"放行解析"还是"另存为 .docx"；
 *   ② **`detectFormat` 的分流**：HTML/MIME `.doc` → `'html'`；真 OLE2 / RTF / 随机字节仍拒；
 *   ③ **HTML 抽块口径**：标题层级、段落、表格（`kind='table'`）与实体解码；
 *   ④ **MHTML 解码**：按 boundary 取 `text/html` part 并解 base64 / quoted-printable。
 *
 * ⚠️ 与 `ocr:regression` / `caption:regression` 同款：默认档自包含、永远可跑。
 */

import { AppError } from '@doubulea/shared'

const { detectFormat, sniffLegacyDoc, parseHtml, htmlToBlocks, extractMhtmlHtml, parseMhtml } = await import(
  '../src/pipeline/parse/index.js'
)

// ───────────────────────────── 断言脚手架 ─────────────────────────────

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

/** 期望 `detectFormat` 抛 `AppError.validation`（即 400 拒绝） */
function rejects(input: { fileName: string; bytes: Buffer; declaredMime?: string }): boolean {
  try {
    detectFormat({ ...input, declaredMime: input.declaredMime ?? '' })
    return false
  } catch (error) {
    return error instanceof AppError
  }
}

const OLE2_HEAD = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
])
const RTF = Buffer.from('{\\rtf1\\ansi 旧版文档}', 'latin1')

const PLAIN_HTML = '<!doctype html><html><head><title>t</title></head><body><h1>标题</h1><p>正文</p></body></html>'

/** 一张最小 PNG 文件头（只验"字节确实被取出"，不验图像合法性） */
const TINY_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

/** 构造一份最小 MHTML（顶层 multipart/related + 一个 text/html part） */
function mhtml(html: string, transferEncoding: 'base64' | 'quoted-printable' | '8bit' = 'base64'): string {
  const body =
    transferEncoding === 'base64'
      ? Buffer.from(html, 'utf8').toString('base64')
      : transferEncoding === 'quoted-printable'
        ? Buffer.from(html, 'utf8')
            .toString('latin1')
            .replace(/[^\x20-\x7e\r\n]/gu, (ch) => `=${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
        : html
  return [
    'Subject: Exported From Confluence',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="----=_Part_1"',
    '',
    '------=_Part_1',
    'Content-Type: text/html; charset=UTF-8',
    `Content-Transfer-Encoding: ${transferEncoding}`,
    '',
    body,
    '------=_Part_1--',
    '',
  ].join('\r\n')
}

/** 构造一份带**内嵌图片 part** 的 MHTML（html part 有 Content-Location 供相对 URL 解析） */
function mhtmlWithImage(html: string): string {
  return [
    'Subject: Exported From Confluence',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="----=_Part_1"',
    '',
    '------=_Part_1',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Location: https://example.com/page.html',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '------=_Part_1',
    'Content-Type: image/png',
    'Content-Id: <img1@example.com>',
    'Content-Location: https://example.com/img1.png',
    'Content-Transfer-Encoding: base64',
    '',
    TINY_PNG.toString('base64'),
    '------=_Part_1--',
    '',
  ].join('\r\n')
}

async function main(): Promise<void> {
  console.log('P1-12 `.doc` 按内容嗅探 · 自证基线\n')

  // ── [1] `.doc` 内容嗅探判据 ──
  console.log('[1] `.doc` 内容嗅探（OLE2 / RTF / MHTML / HTML / 其它）')
  check('OLE2 魔数 → ole2', sniffLegacyDoc(OLE2_HEAD) === 'ole2')
  check('RTF → rtf', sniffLegacyDoc(RTF) === 'rtf')
  check('MHTML（multipart/related）→ mhtml', sniffLegacyDoc(Buffer.from(mhtml(PLAIN_HTML))) === 'mhtml')
  check('裸 HTML → html', sniffLegacyDoc(Buffer.from(PLAIN_HTML, 'utf8')) === 'html')
  check('随机二进制 → other', sniffLegacyDoc(Buffer.from([0x01, 0x02, 0x03, 0x04])) === 'other')

  // ── [2] `detectFormat` 分流 ──
  console.log('\n[2] detectFormat 分流（.doc 不再见到就拒）')
  check(
    "`.doc` 实为 HTML → 'html'",
    detectFormat({ fileName: 'a.doc', declaredMime: 'application/msword', bytes: Buffer.from(PLAIN_HTML, 'utf8') }) === 'html',
  )
  check(
    "`.doc` 实为 MHTML → 'html'",
    detectFormat({ fileName: 'a.doc', declaredMime: '', bytes: Buffer.from(mhtml(PLAIN_HTML)) }) === 'html',
  )
  check('真 OLE2 `.doc` 仍拒（另存为 .docx）', rejects({ fileName: 'a.doc', bytes: OLE2_HEAD }))
  check('RTF `.doc` 仍拒', rejects({ fileName: 'a.doc', bytes: RTF }))
  check('随机字节 `.doc` 仍拒', rejects({ fileName: 'a.doc', bytes: Buffer.from([1, 2, 3, 4, 5]) }))
  check(
    '`docx` 常规路径不受影响（ZIP/OOXML 之外仍拒）',
    rejects({ fileName: 'a.docx', bytes: Buffer.from(PLAIN_HTML, 'utf8') }),
  )

  // ── [3] HTML 抽块口径 ──
  console.log('\n[3] HTML 抽块（标题栈 / 段落 / 表格 / 实体）')
  const { blocks } = htmlToBlocks(
    [
      '<html><body>',
      '<h1>报销制度</h1>',
      '<h2>打车费</h2>',
      '<p>金额必须&nbsp;填写 &amp; 保留票据</p>',
      '<table><tr><th>项目</th><th>金额</th></tr><tr><td>打车</td><td>30</td></tr></table>',
      '<h2>餐费</h2><p>上限 200 元</p>',
      '</body></html>',
    ].join('\n'),
  )
  const heading = blocks.find((b) => b.text === '报销制度')
  const para = blocks.find((b) => b.text.includes('金额必须'))
  const table = blocks.find((b) => b.kind === 'table')
  const second = blocks.find((b) => b.text === '上限 200 元')
  check('标题块存在且 path 含自身', heading !== undefined && heading.headingPath.join('/') === '报销制度')
  check(
    '实体解码（&nbsp;→空格、&amp;→&）',
    para !== undefined && para.text === '金额必须 填写 & 保留票据',
    para?.text,
  )
  check('段落继承标题栈（报销制度/打车费）', para !== undefined && para.headingPath.join('/') === '报销制度/打车费')
  check('表格 → kind=table 且序列化为管道表', table !== undefined && table.text.includes('| 项目 | 金额 |'))
  check('后续标题切换生效（餐费）', second !== undefined && second.headingPath.join('/') === '报销制度/餐费')

  // ── [4] MHTML 解码 ──
  console.log('\n[4] MHTML（boundary 取 text/html part + 传输编码）')
  const zhHtml = '<html><body><h1>广发积分兑换券核销</h1><p>接口定义如下</p></body></html>'
  const b64 = extractMhtmlHtml(mhtml(zhHtml, 'base64'))
  check('base64 part 抽出的 HTML 文本正确', b64 !== undefined && b64.includes('广发积分兑换券核销'))
  const qp = extractMhtmlHtml(mhtml(zhHtml, 'quoted-printable'))
  check('quoted-printable part 抽出的 HTML 文本正确', qp !== undefined && qp.includes('接口定义如下'))
  check('非 multipart 文本 → undefined（按裸 HTML 处理）', extractMhtmlHtml(PLAIN_HTML) === undefined)

  // ── [5] parseHtml 端到端（形状与其它解析器一致）──
  console.log('\n[5] parseHtml 端到端')
  const result = await parseHtml(Buffer.from(mhtml(zhHtml), 'utf8'))
  check('format = html', result.meta.format === 'html')
  check('blocks 非空且含标题 path', result.blocks.length > 0 && result.blocks[0]?.headingPath.join('/') === '广发积分兑换券核销')
  check('charCount > 0（空文本检测据此）', result.meta.charCount > 0)

  // ── [6] 内嵌图抽取（data URI / MHTML part / 开关）──
  console.log('\n[6] 内嵌图抽取')
  const extracts = { extractImages: true, maxImageBytes: 10 * 1024 * 1024 }
  const dataUriHtml = `<html><body><p>文字</p><img src="data:image/png;base64,${TINY_PNG.toString('base64')}"></body></html>`
  const dataResult = await parseHtml(Buffer.from(dataUriHtml, 'utf8'), extracts)
  check(
    'data URI 图被抽出（mime + 字节）',
    dataResult.images.length === 1 &&
      dataResult.images[0]?.mime === 'image/png' &&
      dataResult.images[0]?.data.equals(TINY_PNG),
  )
  const noImages = await parseHtml(Buffer.from(dataUriHtml, 'utf8'), { extractImages: false, maxImageBytes: 10 * 1024 * 1024 })
  check('extractImages=false ⇒ 不抽图', noImages.images.length === 0)

  const cidHtml = '<html><body><p>看这张图</p><img src="cid:img1@example.com"></body></html>'
  const cidResult = await parseHtml(Buffer.from(mhtmlWithImage(cidHtml), 'utf8'), extracts)
  check(
    'MHTML cid: 回查同包 image part',
    cidResult.images.length === 1 && cidResult.images[0]?.data.equals(TINY_PNG),
  )
  const relHtml = '<html><body><img src="img1.png"><p>相对路径</p></body></html>'
  const relResult = await parseHtml(Buffer.from(mhtmlWithImage(relHtml), 'utf8'), extracts)
  check(
    'MHTML 相对 URL 按 Content-Location 回查',
    relResult.images.length === 1 && relResult.images[0]?.data.equals(TINY_PNG),
  )
  check('parseMhtml 登记了 html + 图片 part', parseMhtml(mhtmlWithImage(cidHtml))?.images.size !== 0)

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
