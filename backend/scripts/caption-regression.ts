#!/usr/bin/env node
/**
 * caption-regression.ts —— P1-11 图片"含义"理解（VLM 描述）的**自证基线**
 *
 * 跑法：`pnpm --filter @doubulea/backend caption:regression`
 *
 * 依据：`docs/子方案/图片OCR与图片理解.md` §五 / §五·补 / §十 6。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么只验**纯函数**（不碰上游、不碰 DB）
 * ─────────────────────────────────────────────────────────────────────
 * 描述本身要问 vision 模型，真跑取证留给用户（`06` §六 第 30 条：智能体只做自证）。
 * 本脚本守的是三件**确定性**的事，它们恰是描述链路里最容易写错、也最该回归的部分：
 *   ① **低清防护的判据**：尺寸嗅探（PNG/JPEG/GIF/BMP/WEBP 文件头）读得准 ——
 *      否掉了实测里让 VLM 幻觉的低清缩略图（§五·补 实证）；
 *   ② **回复解析的健壮性**：模型回 JSON / ```json 围栏 / 一段散文 / 坏 JSON 时都能给出可用形态；
 *   ③ **描述文本口径**：摘要 → Mermaid → 标签的顺序与空值处理（OCR 块与图片块共用同一函数）。
 *
 * ⚠️ 与 P1-10 的 `ocr:regression` 同款：默认档自包含、永远可跑；不内置"假图"当基线（那是假证据）。
 */

const { config } = await import('../src/config.js')
const { probeImageSize, parseCaptionReply, descriptionTextOf } = await import(
  '../src/pipeline/caption.js'
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

// ───────────────────────────── 构造各格式的最小文件头 ─────────────────────────────

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89
  buf.write('PNG', 1, 'latin1')
  buf[4] = 0x0d
  buf[5] = 0x0a
  buf[6] = 0x1a
  buf[7] = 0x0a
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13)
  buf.write('GIF89a', 0, 'latin1')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function bmpHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26)
  buf.write('BM', 0, 'latin1')
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  return buf
}

function jpegHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xe0
  buf.writeUInt16BE(0x0010, 4) // APP0 段长 16 ⇒ 下一段起点 2+2+16=20
  buf[20] = 0xff
  buf[21] = 0xc0 // SOF0
  buf.writeUInt16BE(0x0011, 22)
  buf[24] = 0x08 // 精度
  buf.writeUInt16BE(height, 25)
  buf.writeUInt16BE(width, 27)
  return buf
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBP', 8, 'latin1')
  buf.write('VP8X', 12, 'latin1')
  buf.writeUInt32LE(10, 16)
  const w = width - 1
  const h = height - 1
  buf[24] = w & 0xff
  buf[25] = (w >> 8) & 0xff
  buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff
  buf[28] = (h >> 8) & 0xff
  buf[29] = (h >> 16) & 0xff
  return buf
}

async function main(): Promise<void> {
  console.log('P1-11 图片"含义"理解（VLM 描述）· 自证基线\n')

  // ── [1] 图片尺寸嗅探（低清防护的判据）──
  console.log('[1] 图片尺寸嗅探（低清防护）')
  check('PNG 读宽高', same(probeImageSize(pngHeader(293, 250), 'image/png'), { width: 293, height: 250 }))
  check('GIF 读宽高', same(probeImageSize(gifHeader(640, 480), 'image/gif'), { width: 640, height: 480 }))
  check('BMP 读宽高', same(probeImageSize(bmpHeader(120, 200), 'image/bmp'), { width: 120, height: 200 }))
  check('JPEG 读宽高', same(probeImageSize(jpegHeader(800, 600), 'image/jpeg'), { width: 800, height: 600 }))
  check('WEBP(VP8X) 读宽高', same(probeImageSize(webpVp8xHeader(1024, 768), 'image/webp'), { width: 1024, height: 768 }))
  check('异常字节 → null（照常交给 VLM，不漏含义）', probeImageSize(Buffer.from([1, 2, 3]), 'image/png') === null)
  check(
    `实测低清样例（293×250）短边 < IMAGE_CAPTION_MIN_PX(${config.imageCaption.minShortSidePx})`,
    250 < config.imageCaption.minShortSidePx,
    '阈值应从实测样例（§五·补：293×250 缩略图致 VLM 幻觉）定标',
  )

  // ── [2] VLM 回复解析的健壮性 ──
  console.log('\n[2] 回复解析（JSON / 围栏 / 散文 / 坏 JSON）')
  const plain = parseCaptionReply(
    '{"kind":"flowchart","mermaid":"flowchart TD; A-->B","summary":"一个审批流程","labels":["提交","审批"]}',
  )
  check('纯 JSON：字段逐项解析', plain.kind === 'flowchart' && plain.mermaid !== '' && plain.labels.length === 2)
  const fenced = parseCaptionReply('这是结果：\n```json\n{"kind":"chart","summary":"柱状图，三月最高","labels":["3月"]}\n```')
  check('```json 围栏：能截出对象', fenced.kind === 'chart' && fenced.summary.includes('三月'))
  const missing = parseCaptionReply('{"summary":"无 kind 时默认 unknown","labels":["a",1,null,"b"]}')
  check('缺 kind → unknown；labels 过滤非字符串', missing.kind === 'unknown' && missing.labels.join(',') === 'a,b')
  const prose = parseCaptionReply('这看起来是一张报销单的照片，包含金额与日期。')
  check('纯散文：降级为 summary + unknown', prose.kind === 'unknown' && prose.summary.includes('报销单'))
  const broken = parseCaptionReply('{"kind": "flowchart", "summary": ')
  check('坏 JSON：仍降级保留原文（不崩）', broken.kind === 'unknown' && broken.summary.includes('flowchart'))

  // ── [3] 描述文本口径（OCR 块 / 图片块共用）──
  console.log('\n[3] 描述文本口径')
  check('全空 → 空串（调用方据此判"没产出"）', descriptionTextOf({ kind: 'unknown', mermaid: '', summary: '', labels: [] }) === '')
  const text = descriptionTextOf({ kind: 'flowchart', mermaid: 'flowchart TD', summary: '审批流程', labels: ['提交', '审批'] })
  check('顺序 = 摘要 → Mermaid → 标签', text.indexOf('审批流程') < text.indexOf('```mermaid') && text.indexOf('```mermaid') < text.indexOf('图中标签'))
  check('Mermaid 用代码块包裹（前端可渲染）', text.includes('```mermaid\nflowchart TD\n```'))

  // ── [4] 配置登记 ──
  console.log('\n[4] 配置登记')
  check('IMAGE_CAPTION_MIN_PX 已登记（≥32）', config.imageCaption.minShortSidePx >= 32)

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

function same(actual: { width: number; height: number } | null, expected: { width: number; height: number }): boolean {
  return actual !== null && actual.width === expected.width && actual.height === expected.height
}

await main()
