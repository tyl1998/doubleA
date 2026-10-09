#!/usr/bin/env node
/**
 * ocr-regression.ts —— P1-10 图片 OCR 质量修复的**回归基线**（`子方案/图片OCR与图片理解.md` §七）
 *
 * 跑法：`pnpm --filter @doubulea/backend ocr:regression`
 *
 * ─────────────────────────────────────────────────────────────────────
 * 分两层：默认档（自包含、永远可跑）+ 真实样例档（需给一张已知文字的图）
 * ─────────────────────────────────────────────────────────────────────
 * · **默认档**只验**确定性**的东西：语言配置（T1）+ 预处理像素性质（T2）。不碰 tesseract，
 *   不依赖语言包/网络，CI 里稳定通过。
 * · **真实样例档**验 OCR 输出（§七 1/2/3），**必须**提供一张"已知文字"的图：
 *     `OCR_REGRESSION_FIXTURE=/abs/path/to/sample.png OCR_REGRESSION_EXPECT=报销制度 pnpm …`
 *   为什么不内置渲染夹具：`子方案` §七 原话是"CoreText/或内置夹具渲染已知文字"。CoreText 只在
 *   本机 macOS 可用；而纯 JS 画的块状字形会被 `chi_sim` 当成 CJK 部首（实测"500"读成"口吕"），
 *   拿它当基线是**假证据**。故这里只认"真图"，没图就**明确跳过**，不伪造通过。
 *
 * 真实样例档的三条断言：
 *   ① 识别文本**不含成段 latin 乱码**（§一 的崩法：`i $H HE …`）——中文样例专用；
 *   ② 命中 `OCR_REGRESSION_EXPECT` 的关键 token（默认"报销制度"）；
 *   ③ 该图的**降质版**（下采样 + 低对比度 + 噪声）在预处理开启时命中数**不低于**清晰基线。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RawImage } from '../src/pipeline/preprocess.js'

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 本地语言包目录（有则用，保证离线可跑；否则回落到 tesseract.js 默认 CDN） */
if (process.env.OCR_LANG_PATH === undefined && existsSync(resolve(backendDir, 'chi_sim.traineddata'))) {
  process.env.OCR_LANG_PATH = backendDir
}
process.env.OCR_LANGS ??= 'chi_sim'
process.env.OCR_PREPROCESS ??= 'true'

const { config } = await import('../src/config.js')
const { encodePngRaw } = await import('../src/pipeline/parse/png.js')
const { preprocessPixels, decodePng } = await import('../src/pipeline/preprocess.js')
const { recognizeImage, disposeOcr } = await import('../src/pipeline/ocr.js')

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

/** 关键 token 命中数（按去重字符：字符在识别文本中出现即算命中） */
function hitCount(expected: string, text: string): number {
  let hits = 0
  for (const char of new Set(expected)) if (text.includes(char)) hits += 1
  return hits
}

/** 是否出现"成段 latin 乱码"（连续 ≥4 个拉丁字母；中文识别崩坏的典型特征） */
function hasLatinRun(text: string): boolean {
  return /[A-Za-z]{4,}/u.test(text)
}

/** 确定性伪随机（同一输入每次同图，基线才可复现） */
function pseudoNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) & 0xff) / 255
}

/** 模拟降质：整数倍下采样（盒式平均）+ 低对比度 + 噪声，贴近"低分辨率扫描件" */
function degrade(image: RawImage, factor: number, contrast: number, noise: number): RawImage {
  const outW = Math.max(1, Math.floor(image.width / factor))
  const outH = Math.max(1, Math.floor(image.height / factor))
  const out = new Uint8Array(outW * outH)
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx
          const sy = y * factor + dy
          if (sx >= image.width || sy >= image.height) continue
          sum += image.data[sy * image.width + sx] ?? 0
          count += 1
        }
      }
      let value = sum / count
      value = contrast + (value / 255) * (255 - contrast * 2)
      if (noise > 0) value += (pseudoNoise(x, y) - 0.5) * noise * 2
      out[y * outW + x] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }
  return { data: out, width: outW, height: outH, channels: 1 }
}

async function main(): Promise<void> {
  console.log('P1-10 OCR 质量修复 · 回归基线\n')

  // ── [1] 语言策略（T1）──
  console.log('[1] 语言策略（T1）')
  check(
    'OCR_LANGS 默认单语言 chi_sim',
    config.ocr.langs.length === 1 && config.ocr.langs[0] === 'chi_sim',
    `实际 ${JSON.stringify(config.ocr.langs)}`,
  )
  check('默认不含 eng（避免多语言互相劣化）', !config.ocr.langs.includes('eng'))

  // ── [2] tesseract 参数与预处理（T2/T3，确定性）──
  console.log('\n[2] 参数与预处理（T2/T3）')
  check('OCR_PSM 默认 6（整页单栏）', config.ocr.psm === 6, `实际 ${config.ocr.psm}`)
  check('OCR_TARGET_DPI 默认 300', config.ocr.targetDpi === 300, `实际 ${config.ocr.targetDpi}`)
  check('OCR_PREPROCESS 默认开', config.ocr.preprocess === true)
  check(
    'IMAGE_OCR_MIN_PX 已登记（≥32，低清不识别）',
    config.ocr.minShortSidePx >= 32,
    `实际 ${config.ocr.minShortSidePx}`,
  )

  // 造一张小型低对比度灰度图，验预处理输出的像素性质（不涉 tesseract）
  const w = 40
  const h = 40
  const sample = new Uint8Array(w * h)
  for (let i = 0; i < sample.length; i += 1) sample[i] = 100 + ((i * 37) % 60) // 100..159 低对比度
  const processed = preprocessPixels({ data: sample, width: w, height: h, channels: 1 })
  check('预处理输出单通道且尺寸自洽', processed.channels === 1 && processed.data.length === processed.width * processed.height)
  check('预处理输出二值（仅 0/255）', processed.data.every((v) => v === 0 || v === 255))
  check('小图被放大到目标最小边', Math.min(processed.width, processed.height) >= Math.min(w, h))
  check('预处理可复现（同输入同输出）', processed.data.every((v, i) => v === preprocessPixels({ data: sample, width: w, height: h, channels: 1 }).data[i]))

  // ── [3] 真实样例档（需提供已知文字的图）──
  const fixture = process.env.OCR_REGRESSION_FIXTURE
  const expected = process.env.OCR_REGRESSION_EXPECT ?? '报销制度'
  console.log('\n[3] 真实样例档（§七 端到端）')
  if (fixture === undefined || !existsSync(fixture)) {
    console.log('  ⏭ 跳过：未提供 OCR_REGRESSION_FIXTURE（已知文字的图片路径）')
    console.log('     提供后本档会断言：无 latin 乱码 + 关键 token 命中 + 降质图预处理不劣化')
  } else {
    const bytes = readFileSync(fixture)
    const decoded = decodePng(bytes)
    try {
      const baselineText = await recognizeImage(bytes, { mime: 'image/png' })
      console.log(`    清晰图识别：${JSON.stringify(baselineText)}`)
      check('清晰图无成段 latin 乱码', !hasLatinRun(baselineText), `识别为 ${JSON.stringify(baselineText)}`)
      check(
        `清晰图命中关键 token（${expected}）`,
        hitCount(expected, baselineText) > 0,
        `识别为 ${JSON.stringify(baselineText)}`,
      )

      if (decoded === null) {
        console.log('  ⏭ 降质对比跳过：样例不是本模块可解码的 8 位非隔行 PNG')
      } else {
        const degraded = degrade(decoded, 2, 70, 18)
        const degradedPng = encodePngRaw(degraded.data, degraded.width, degraded.height, degraded.channels)
        config.ocr.preprocess = false
        const offText = await recognizeImage(degradedPng, { mime: 'image/png' })
        config.ocr.preprocess = true
        const onText = await recognizeImage(degradedPng, { mime: 'image/png' })
        console.log(`    降质·预处理关：${JSON.stringify(offText)}`)
        console.log(`    降质·预处理开：${JSON.stringify(onText)}`)
        check(
          '降质图预处理开启时命中数不低于清晰基线',
          hitCount(expected, onText) >= hitCount(expected, baselineText),
          `开 ${hitCount(expected, onText)} < 基线 ${hitCount(expected, baselineText)}`,
        )
      }
    } catch (error) {
      failed += 1
      console.error(`  ✗ OCR 执行异常：${String(error)}`)
    } finally {
      await disposeOcr()
    }
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
