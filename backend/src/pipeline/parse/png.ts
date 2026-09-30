/**
 * 极简 PNG 编码器（无第三方依赖）
 *
 * 用途：`unpdf#extractImages` 返回的是**解码后的原始像素**（`Uint8ClampedArray` + width/height/channels），
 * 而 OCR（tesseract）与多模态 embedding 都需要一张**真正的图片字节**（data URL/文件流）。
 * 把一个 RGB/RGBA/灰度缓冲编成 PNG 只需要 IHDR + IDAT（zlib deflate）+ IEND 三段，
 * 不值得为此引入 `sharp` / `@napi-rs/canvas`（两者都是需要平台二进制的原生依赖）。
 *
 * ⚠️ 只处理 **8 位**、filter 全 0（None）的常见情形 —— pdfjs 的 `paintImageXObject`
 * 交给我们的就是这种。这不是通用图片库，够用即可；遇到不支持的通道数直接抛，不静默产坏图。
 */

import { deflateSync } from 'node:zlib'

/** PNG 签名 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32（PNG 每个 chunk 的校验；标准多项式 0xEDB88320） */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 组装一个 chunk：长度(4) + 类型(4) + 数据 + CRC(4) */
function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/** 通道数 → PNG colorType（1 灰度 / 2 RGB / 4 RGBA） */
const COLOR_TYPE: Readonly<Record<number, number>> = { 1: 0, 3: 2, 4: 6 }

/**
 * 原始像素 → PNG 字节。
 *
 * @param data     每像素 `channels` 字节、行优先的原始缓冲
 * @param width    宽（像素）
 * @param height   高（像素）
 * @param channels 1（灰度）/ 3（RGB）/ 4（RGBA）
 * @throws 参数自洽性问题（长度对不上 / 通道数不支持）—— 这类是编程/上游错误，不能静默产坏图
 */
export function encodePngRaw(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
): Buffer {
  const colorType = COLOR_TYPE[channels]
  if (colorType === undefined) {
    throw new Error(`不支持的图片通道数：${channels}（仅支持 1/3/4）`)
  }
  if (width <= 0 || height <= 0 || data.length !== width * height * channels) {
    throw new Error(
      `图片尺寸与数据长度不符：${width}×${height}×${channels}，实际 ${data.length} 字节`,
    )
  }

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = colorType
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
