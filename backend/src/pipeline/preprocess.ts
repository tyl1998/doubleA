/**
 * 图像预处理（P1-10 · 轨道一 T2；`子方案/图片OCR与图片理解.md` §四 T2）
 *
 * 目的：`recognizeImage` 之前先把图片"洗干净"，让**扫描件/照片**（低分辨率、光照不均、
 * 倾斜、噪声）不再直接崩成乱码。链路（纯 JS、零新依赖）：
 *
 *   灰度化 → 对比度拉伸 → 小图放大 → Otsu 二值化 → 轻量去噪
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要自己写一个 PNG 解码器
 * ─────────────────────────────────────────────────────────────────────
 * 预处理要的是**像素**，而流水线里的 {@link ParsedImage.data} 是**编码后的字节**（PNG）。
 * 引 `sharp` / `@napi-rs/canvas` 会带来平台原生二进制；本仓对图片链路的要求是"纯 JS、
 * 零新依赖"，故这里只用 Node 内置的 `zlib` 解 IDAT，自带一个**够用即可**的 PNG 解码器。
 * 不支持的情形（非 8 位、隔行扫描、未支持的色彩类型）一律返回 `null` —— 调用方**回退到
 * 原图**（tesseract 自己也能解码），绝不静默产坏图。
 *
 * ⚠️ 只做 PNG：JPEG/WEBP 等编码器不在本模块（引 `jpeg-js` 与否是 `子方案` §十 的待决项），
 * 其预处理暂时跳过（原图直接交给 tesseract）。
 */

import { inflateSync } from 'node:zlib'

import { encodePngRaw } from './parse/png.js'

/** 原始像素（行优先；每像素 `channels` 字节）。`channels` 仅 1/3/4（灰度/RGB/RGBA） */
export interface RawImage {
  data: Uint8Array
  width: number
  height: number
  channels: number
}

/**
 * 预处理时的最小边长阈值：短边小于它的图按整数倍放大。
 *
 * 依据：文档里的小图（缩略图、截图里的小字）在 96 DPI 下字高往往只有十几个像素，
 * tesseract 的 LSTM 直接读不出。放大本身不增信息，但把笔画撑开后有利于分割。
 * 阈值与倍数都保守（最多 4 倍），避免把正常尺寸的扫描页吹到内存爆炸。
 */
const MIN_UPSCALE_SIDE = 100
const MAX_UPSCALE_FACTOR = 4

/** 灰度化：RGB→亮度；带 alpha 的先合成到白底（扫描件透明背景按白纸处理） */
function toGrayscale(image: RawImage): Uint8Array {
  const { data, width, height, channels } = image
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i += 1, p += channels) {
    if (channels === 1) {
      out[i] = data[p] ?? 0
      continue
    }
    const r = data[p] ?? 0
    const g = data[p + 1] ?? r
    const b = data[p + 2] ?? r
    let lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (channels === 4) {
      const a = (data[p + 3] ?? 255) / 255
      lum = lum * a + 255 * (1 - a)
    }
    out[i] = lum
  }
  return out
}

/**
 * 对比度拉伸：把亮度直方图的 0.5% / 99.5% 分位点拉满到 0–255。
 *
 * 用分位点而不是 min/max：扫描件常有零星极黑/极白噪点，按 min/max 拉伸等于**不拉伸**。
 */
function stretchContrast(gray: Uint8Array): Uint8Array {
  const hist = new Uint32Array(256)
  for (const value of gray) hist[value] = (hist[value] ?? 0) + 1
  const total = gray.length
  const clip = Math.max(1, Math.floor(total * 0.005))
  let low = 0
  let high = 255
  let acc = 0
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v] ?? 0
    if (acc > clip) {
      low = v
      break
    }
  }
  acc = 0
  for (let v = 255; v >= 0; v -= 1) {
    acc += hist[v] ?? 0
    if (acc > clip) {
      high = v
      break
    }
  }
  if (high - low < 16) return gray // 近乎纯色，拉伸无意义且会放大噪声
  const scale = 255 / (high - low)
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i += 1) {
    const norm = ((gray[i] ?? 0) - low) * scale
    out[i] = norm < 0 ? 0 : norm > 255 ? 255 : norm
  }
  return out
}

/** 灰度图最近邻整数倍放大（见 {@link MIN_UPSCALE_SIDE}） */
function upscale(gray: Uint8Array, width: number, height: number): { data: Uint8Array; width: number; height: number; factor: number } {
  const minSide = Math.min(width, height)
  const factor = minSide >= MIN_UPSCALE_SIDE ? 1 : Math.min(MAX_UPSCALE_FACTOR, Math.ceil(MIN_UPSCALE_SIDE / minSide))
  if (factor <= 1) return { data: gray, width, height, factor: 1 }
  const outW = width * factor
  const outH = height * factor
  const out = new Uint8Array(outW * outH)
  for (let y = 0; y < outH; y += 1) {
    const sy = (y / factor) | 0
    for (let x = 0; x < outW; x += 1) {
      out[y * outW + x] = gray[sy * width + ((x / factor) | 0)] ?? 0
    }
  }
  return { data: out, width: outW, height: outH, factor }
}

/** Otsu 自适应阈值（不写死一个 128：光照不均时写死必崩一半） */
function otsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (const value of gray) hist[value] = (hist[value] ?? 0) + 1
  const total = gray.length
  let sum = 0
  for (let v = 0; v < 256; v += 1) sum += v * (hist[v] ?? 0)
  let sumB = 0
  let weightB = 0
  let best = 0
  let threshold = 128
  for (let v = 0; v < 256; v += 1) {
    weightB += hist[v] ?? 0
    if (weightB === 0) continue
    const weightF = total - weightB
    if (weightF === 0) break
    sumB += v * (hist[v] ?? 0)
    const meanB = sumB / weightB
    const meanF = (sum - sumB) / weightF
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF)
    if (between > best) {
      best = between
      threshold = v
    }
  }
  return threshold
}

/** 二值化：小于阈值 → 0（前景墨迹），否则 → 255（背景） */
function binarize(gray: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i += 1) out[i] = (gray[i] ?? 0) > threshold ? 255 : 0
  return out
}

/** 轻量去噪：只在同一像素的 3×3 邻域与它"完全相反"时翻面（去孤立盐/椒点，不动笔画） */
function denoise(binary: Uint8Array, width: number, height: number): Uint8Array {
  if (width < 3 || height < 3) return binary
  const out = binary.slice()
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x
      const center = binary[idx] ?? 0
      let white = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          if ((binary[(y + dy) * width + (x + dx)] ?? 0) > 127) white += 1
        }
      }
      // 中心是白、8 邻域全黑 ⇒ 孤立亮点；反之是孤立黑点
      if (center > 127 && white === 0) out[idx] = 0
      else if (center <= 127 && white === 8) out[idx] = 255
    }
  }
  return out
}

/**
 * 原始像素 → 预处理后的**灰度单通道**像素（可直接喂 {@link encodePngRaw}）。
 *
 * @returns 始终返回 1 通道（灰度二值）图；`channels` 记为 1
 */
export function preprocessPixels(image: RawImage): RawImage {
  const gray = toGrayscale(image)
  const stretched = stretchContrast(gray)
  const scaled = upscale(stretched, image.width, image.height)
  const binary = binarize(scaled.data, otsuThreshold(scaled.data))
  const clean = denoise(binary, scaled.width, scaled.height)
  return { data: clean, width: scaled.width, height: scaled.height, channels: 1 }
}

// ───────────────────────────── 极简 PNG 解码器（见文件头） ─────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 色彩类型 → 每像素通道数（解码器只支持 8 位） */
const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 解码 PNG → RGBA 原始像素。
 *
 * @returns 解码结果；**不支持的情形返回 `null`**（非 PNG / 非 8 位 / 隔行扫描 / 未知色彩类型），
 *          由调用方回退到原图 —— 不是错误，只需不预处理。
 */
export function decodePng(buffer: Buffer): RawImage | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null

  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = 0
  let interlace = 0
  const idat: Buffer[] = []
  let palette: Buffer | null = null

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) return null // 截断
    const chunk = buffer.subarray(start, end)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8] ?? 0
      colorType = chunk[9] ?? -1
      interlace = chunk[12] ?? 0
    } else if (type === 'PLTE') {
      palette = chunk
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4 // 跳过 CRC
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0) return null
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (channels === undefined || (colorType === 3 && palette === null)) return null
  if (idat.length === 0) return null

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }

  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null

  // 逐行反滤波（filter 0..4；行内 in-place，需 prev 行的**已还原**结果）
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0
    const rowStart = y * (stride + 1) + 1
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rowStart + x] ?? 0
      const a = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0
      const b = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0
      const c = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0
      let value: number
      switch (filter) {
        case 0:
          value = rawByte
          break
        case 1:
          value = rawByte + a
          break
        case 2:
          value = rawByte + b
          break
        case 3:
          value = rawByte + ((a + b) >> 1)
          break
        case 4:
          value = rawByte + paethPredictor(a, b, c)
          break
        default:
          return null
      }
      pixels[y * stride + x] = value & 0xff
    }
  }

  // 统一转成 RGBA（下游 toGrayscale 会处理）
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    let r: number
    let g: number
    let b: number
    let a = 255
    if (colorType === 0 || colorType === 4) {
      r = g = b = pixels[p] ?? 0
      if (colorType === 4) a = pixels[p + 1] ?? 255
    } else if (colorType === 2 || colorType === 6) {
      r = pixels[p] ?? 0
      g = pixels[p + 1] ?? 0
      b = pixels[p + 2] ?? 0
      if (colorType === 6) a = pixels[p + 3] ?? 255
    } else {
      const index = pixels[p] ?? 0
      r = palette?.[index * 3] ?? 0
      g = palette?.[index * 3 + 1] ?? 0
      b = palette?.[index * 3 + 2] ?? 0
    }
    const q = i * 4
    rgba[q] = r
    rgba[q + 1] = g
    rgba[q + 2] = b
    rgba[q + 3] = a
  }
  return { data: rgba, width, height, channels: 4 }
}

/**
 * 编码图片（PNG）→ 预处理后的 PNG 字节。
 *
 * @returns 预处理后的 PNG；非 PNG 或解码不支持时返回 `null`（调用方回退原图）
 */
export function preprocessEncodedPng(buffer: Buffer): Buffer | null {
  const decoded = decodePng(buffer)
  if (decoded === null) return null
  const processed = preprocessPixels(decoded)
  return encodePngRaw(processed.data, processed.width, processed.height, processed.channels)
}
