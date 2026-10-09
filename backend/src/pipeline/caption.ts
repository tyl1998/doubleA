/**
 * 图片"含义"理解 —— VLM 描述（**P1-11**，轨道二）
 *
 * 依据：`docs/子方案/图片OCR与图片理解.md` §五（轨道二 · VLM 图片描述）、§五·补（流程图 → Mermaid、
 *      低清防护）、§八（描述模型）、§十一（图片处理三开关）、§十（待决 6：低清判据定标）。
 *      描述模型是**知识库级**（`knowledge_bases.caption_model_id`），由 worker 解析后经
 *      `PipelineContext.captionTarget` 注入；本模块不碰 DB、不读 env。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么 OCR 取不到"含义"、而这里能
 * ─────────────────────────────────────────────────────────────────────
 * OCR 只认"字"：流程图的语义 = 节点文字 **+ 边（顺序/分支/条件）**，而边没有文字 ⇒ OCR 天然丢掉
 * 图的结构。只有 vision 模型能"看图"，把流程图转译成 Mermaid + 摘要 + 节点标签（§五·补）。
 * 故本模块**不替代** OCR，而是在其之上补一层"含义"（文字密集的文档用 OCR，图形/截图用 VLM）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条硬约束（都来自实测，不是"顺手这么写"）
 * ─────────────────────────────────────────────────────────────────────
 * ① **低清图不交给 VLM**（§五·补 实证）：导出件里的内嵌图常是 `293×250` 级别的缩略图，
 *    可靠 OCR 都读不出，而 VLM 却会"非常自信地幻觉"出与原文毫不相关的内容。故短边低于
 *    `IMAGE_CAPTION_MIN_PX` 的图片直接标记 `unreliable`、**不产出图结构**（宁缺毋滥）。
 * ② **失败一律降级、绝不使文档 FAILED**：描述是可选的"锦上添花"，任何一次上游抖动都不该把
 *    一篇本可正常入库的文档打成失败。调用点（阶段）负责 try/catch 并只记 warn。
 * ③ **纯函数与调用分离**：{@link probeImageSize} / {@link parseCaptionReply} / {@link descriptionTextOf}
 *    不依赖上游，可被回归脚本（`backend/scripts/caption-regression.ts`）直接断言。
 */

import { chat, type ChatMessage, type LlmTarget } from '../llm/client.js'
import type { ParsedImage } from './parse/types.js'

/** 描述结果（VLM 返回结构化 JSON 后的归一形态；缺字段一律取保守默认值） */
export interface ImageDescription {
  /** `flowchart` / `chart` / `diagram` / `photo` / `text` / `unknown` */
  kind: string
  /** 流程图/结构图的 Mermaid（非此类图为空串） */
  mermaid: string
  /** 中文摘要（检索友好） */
  summary: string
  /** 图中关键文字标签（关键词兜底 —— VLM 的结构可能错，标签至少能召回） */
  labels: string[]
}

/**
 * 图表感知的 prompt（§五·补 的"统一做法"）：要求模型返回**结构化 JSON**，而不是一段散文 ——
 * 散文没法区分"流程图"与"照片"，也没法把 Mermaid 抽出给前端渲染。
 */
export const CAPTION_PROMPT = [
  '你是文档图片理解助手。请阅读这张图片，用**中文**判断它的类型与要点。',
  '',
  '严格只输出一个 JSON 对象（可包在 ```json 代码块里），字段如下：',
  '{',
  '  "kind": "flowchart | chart | diagram | photo | text | unknown",',
  '  "mermaid": "若为流程图/结构图，输出可渲染的 Mermaid（如 flowchart TD; A[提交]-->B{金额>500?}）；否则空串",',
  '  "summary": "一到三句话的中文描述；文字密集的截图请包含图中的关键文字",',
  '  "labels": ["图中关键文字/节点标签，逐个列出；没有则空数组"]',
  '}',
  '',
  '要求：',
  '- 只描述你**确实看到**的内容；若图片过小、模糊或无法辨认，返回 {"kind":"unknown","mermaid":"","summary":"","labels":[]}，**不要猜测**。',
  '- 流程图优先产出 Mermaid；图表（chart）用文字描述数据与趋势；照片（photo）描述画面要点。',
  '- 不要把图中的文字逐字转抄成整篇；summary 要精炼。',
].join('\n')

// ═════════════════════════════════════════════════════════════════════
// 纯函数：图片尺寸嗅探（低清防护的判据）
// ═════════════════════════════════════════════════════════════════════

export interface ImageSize {
  width: number
  height: number
}

/** 读大端无符号整数（PNG/JPEG 用） */
function u32be(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset)
}

/**
 * 从**文件头**读出图片的像素尺寸（不整图解码，零依赖）。
 *
 * 支持 PNG / JPEG / GIF / BMP / WEBP（覆盖仓库图片解析的全部格式）。**读不出返回 `null`**
 * （异常字节、未知变体）—— 调用方此时**照常交给 VLM**（宁可信其可辨识，也不因探测失败而漏掉含义；
 * 低清防护只对"确实测出短边过小"的图生效）。
 */
export function probeImageSize(bytes: Buffer, mime: string): ImageSize | null {
  try {
    if (mime === 'image/png' || startsWith(bytes, '\x89PNG')) {
      // PNG：签名 8 字节 + IHDR 长度(4)+类型(4) ⇒ 宽在 16、高在 20（大端）
      if (bytes.length < 24) return null
      const width = u32be(bytes, 16)
      const height = u32be(bytes, 20)
      return valid(width, height)
    }
    if (mime === 'image/gif' || startsWith(bytes, 'GIF8')) {
      // GIF：宽/高各 2 字节小端（偏移 6 / 8）
      if (bytes.length < 10) return null
      return valid(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    }
    if (mime === 'image/bmp' || startsWith(bytes, 'BM')) {
      // BMP：DIB 头宽/高（偏移 18 / 22，小端有符号；高度可为负表示自上而下）
      if (bytes.length < 26) return null
      return valid(Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22)))
    }
    if (mime === 'image/jpeg' || startsWith(bytes, '\xff\xd8')) {
      return jpegSize(bytes)
    }
    if (mime === 'image/webp' && bytes.length >= 30 && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
      return webpSize(bytes)
    }
  } catch {
    return null
  }
  return null
}

function startsWith(bytes: Buffer, ascii: string): boolean {
  return bytes.length >= ascii.length && bytes.subarray(0, ascii.length).toString('latin1') === ascii
}

function valid(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null
}

/** JPEG：扫段找 SOF 标记（C0–CF，除 C4/C8/CC），其内高在 +5、宽在 +7（大端） */
function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    // 无长度字段的独立标记（填充 / RSTn）—— 跳过
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return valid(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
    }
    offset += 2 + length
  }
  return null
}

/** WEBP：VP8X 画布宽高（24 位小端，值-1 修正）/ VP8 有损 / VP8L 无损 */
function webpSize(bytes: Buffer): ImageSize | null {
  const fourcc = bytes.subarray(12, 16).toString('latin1')
  if (fourcc === 'VP8X') {
    const width = 1 + readUInt24LE(bytes, 24)
    const height = 1 + readUInt24LE(bytes, 27)
    return valid(width, height)
  }
  if (fourcc === 'VP8 ') {
    // 关键帧起始码 9d 01 2a 之后：宽 2 字节（低 14 位）、高 2 字节（低 14 位）
    if (bytes.length < 30) return null
    const width = bytes.readUInt16LE(26) & 0x3fff
    const height = bytes.readUInt16LE(28) & 0x3fff
    return valid(width, height)
  }
  if (fourcc === 'VP8L') {
    // 签名 0x2f 之后 14 位宽-1、14 位高-1
    if (bytes.length < 25) return null
    const bits = bytes.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return valid(width, height)
  }
  return null
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

// ═════════════════════════════════════════════════════════════════════
// 纯函数：VLM 回复 → 结构化描述
// ═════════════════════════════════════════════════════════════════════

/** 从自由文本里截出第一个平衡的 `{…}` JSON 对象（模型常包在 ```json 或前后加解释） */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 解析 VLM 回复：优先取 JSON；JSON 缺失/非法时**降级**为"整段当 summary、kind=unknown"
 * （模型偶尔只回一段散文 —— 丢掉太可惜，保留文本至少能进全文路）。
 */
export function parseCaptionReply(text: string): ImageDescription {
  const raw = text.trim()
  const json = extractJsonObject(raw)
  if (json !== null) {
    try {
      const record = JSON.parse(json) as Record<string, unknown>
      const labels = Array.isArray(record.labels)
        ? record.labels.map((item) => toText(item)).filter((item) => item !== '')
        : []
      return {
        kind: toText(record.kind) === '' ? 'unknown' : toText(record.kind),
        mermaid: toText(record.mermaid),
        summary: toText(record.summary),
        labels,
      }
    } catch {
      // 落到下面的散文降级
    }
  }
  return { kind: 'unknown', mermaid: '', summary: raw, labels: [] }
}

/**
 * 结构化描述 → 写进块 `content` 的文本（OCR 块 / MULTIMODAL 图片块共用同一口径）。
 *
 * 顺序刻意固定：**摘要 → Mermaid → 标签**。摘要在前（检索/引用最先读到"讲了什么"），
 * Mermaid 次之（前端可选渲染），标签兜底关键词召回。全空时返回空串（调用方据此判"没产出"）。
 */
export function descriptionTextOf(description: ImageDescription): string {
  const parts: string[] = []
  if (description.summary !== '') parts.push(description.summary)
  if (description.mermaid !== '') parts.push('```mermaid\n' + description.mermaid + '\n```')
  if (description.labels.length > 0) parts.push('图中标签：' + description.labels.join('、'))
  return parts.join('\n\n')
}

// ═════════════════════════════════════════════════════════════════════
// 调用：把一张图交给 vision 模型
// ═════════════════════════════════════════════════════════════════════

/**
 * 用 vision 对话模型描述一张图片。
 *
 * 走的是与真实对话**同一条** `chat()`（非流式 + 多模态 content part），协议差异（图片落哪个
 * 字段）自动被处理（`llm/protocol.ts#buildInputMessage`）。`temperature: 0` 求稳定。
 *
 * ⚠️ **刻意不传 `maxTokens`**（原为常量 800，2026-10-08 移除）：`max_tokens` 是"输出预算"，
 * 而思考类模型的推理 token 也从这里扣 —— 实测 `mimo-v2.6-flash` 在 800 下三张时序图全部
 * `finishReason: 'length'`（半截 JSON 被当 summary、或思考吃光预算后 `text` 为空直接判失败）。
 * 输出长度应由模型/上游默认决定，平台不替用户设上限（成本另外算给他）；故这里不再传上限。
 *
 * ⚠️ **失败由调用方处置**（本函数会抛）：阶段层 try/catch，降级为"只保留图注/OCR"、不使文档失败。
 *
 * @throws {AppError} 上游非 2xx / 超时（`llm/client.ts#chat` 的既有错误）
 */
export async function describeImageWithTarget(
  target: LlmTarget,
  image: ParsedImage,
): Promise<ImageDescription> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: image.mime, dataBase64: image.data.toString('base64') },
        { type: 'text', text: CAPTION_PROMPT },
      ],
    },
  ]
  const result = await chat(target, messages, { temperature: 0 })
  return parseCaptionReply(result.text)
}
