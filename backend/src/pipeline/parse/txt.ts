/**
 * TXT 解析（P0-1-16；`子方案/知识库流水线.md` §4-1）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批点名必测的坑：**编码嗅探**
 * ─────────────────────────────────────────────────────────────────────
 * GBK 文件用 UTF-8 解**不报错**，只是整篇变成乱码 —— 而乱码文本照样能入库、照样能被
 * 向量化，最后表现为"检索命中一个看不懂的文档"，根因（编码）早就看不见了。
 * 所以这里显式判编码，宁可多几步也不"默认 UTF-8"。
 *
 * 判据的顺序（**确定性证据优先于猜测**）：
 *   ① BOM —— 文件自己声明了编码，直接采信（UTF-8 / UTF-16LE / UTF-16BE）；
 *   ② 无 BOM → 用**严格模式**（`fatal: true`）试解 UTF-8：能过就是 UTF-8；
 *   ③ 过不了 → 按 GBK 解（中文环境下剩下的绝大多数情况）。
 * 为什么这样排：GBK 双字节码几乎不可能恰好构成合法 UTF-8 序列（前导字节区间不重叠），
 * 反过来合法 UTF-8 的中文也不会被 GBK 解对 —— 两个方向都足够干净，不需要统计式嗅探
 * （`jschardet` 之类只会多一个依赖与一份"偶尔猜错"的不确定性）。
 *
 * ⚠️ 解码器用 Node 内置的 `TextDecoder`（**不引 iconv-lite**）：Node 官方发行版带完整 ICU，
 * `TextDecoder('gbk')` 就能解 GBK/GB18030。若哪天跑在 small-icu 的精简构建上，
 * `TextDecoder` 构造会抛 `RangeError` —— 这里把它转成一条点名"缺 ICU"的错误，
 * 而不是让它以"未知编码"的样子混过去。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么每行一个 block（而不是按空行分段）
 * ─────────────────────────────────────────────────────────────────────
 * 内部知识库里的 txt 绝大多数是**清单/日志/逐条条文**（一行一条），"行"就是它的语义单元；
 * 按空行分段会把几十条记录拍成一段，检索时 `snippet` 的 80 字符窗口只能截到第 1~2 条。
 * 代价是"整段散文被硬折行"的 txt 会多出几个 block —— 而 hybrid 分块本来就会把相邻段
 * 累积到 `chunk_size` 才封块（`子方案①` §4-2），多几个段不影响块边界。
 */

import { appMsg, AppError } from '@doubulea/shared'

import { buildParseResult, type ParseResult, type ParsedBlock } from './types.js'

/** 编码嗅探结果 */
export interface DecodedText {
  text: string
  /** 实际采用的编码（进 `meta.encoding`，是"嗅探真的发生了"的取证） */
  encoding: 'utf-8' | 'gbk' | 'utf-16le' | 'utf-16be'
}

/** 取解码器；`TextDecoder` 不认识该编码时给出可诊断的错误（small-icu 构建） */
function decoderFor(label: string) {
  try {
    return new TextDecoder(label)
  } catch (error) {
    throw AppError.internal(appMsg('app.m261', { p0: label, p1: String(error) }),
    )
  }
}

/**
 * 字节 → 文本（编码嗅探，见文件头）。**导出的原因**：`.md` 也用同一套判据
 * （GBK 的 markdown 同样是真实现场），而"编码"这件事只该有一份实现 ——
 * 单独开 `encoding.ts` 会让本批的产出清单与目录结构对不上，故由这里出口。
 */
export function decodeTextBuffer(bytes: Buffer): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decoderFor('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decoderFor('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decoderFor('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    // 严格 UTF-8 失败 ⇒ 按 GBK 解（非 fatal：个别坏字节会变成 U+FFFD，但不至于让整篇失败）
    return { text: decoderFor('gbk').decode(bytes), encoding: 'gbk' }
  }
}

/** 把一段文本按行切成 block（空行与纯空白行丢弃） */
function linesToBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  for (const line of text.split(/\r\n|\r|\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    blocks.push({ text: trimmed, headingPath: [], page: null })
  }
  return blocks
}

/** TXT → 解析结果（每行一段；见文件头） */
export function parseTxt(bytes: Buffer): ParseResult {
  const { text, encoding } = decodeTextBuffer(bytes)
  return buildParseResult('txt', linesToBlocks(text), { encoding })
}
