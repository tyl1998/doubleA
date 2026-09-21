/**
 * Markdown 解析（P0-1-16；`子方案/知识库流水线.md` §4-1：MD 原生，按 `#` 层级记录标题）
 *
 * 为什么"原生"（不引 markdown 解析库）：本层要的不是渲染，而是**结构 + 正文**，
 * 而 md 的标题/段落/代码围栏这三件事用行级正则就够 —— 引一个 AST 库会顺手带来
 * 表格、内联 HTML、脚注等一大堆与本项目无关的语义，且"到底什么算一个段落"会变成
 * 那个库的口径而不是我们的（下游 hybrid 分块要靠这个粒度）。
 *
 * 三条明确的口径（都是"选了就要写下来"的取舍）：
 *   · 只认 **ATX 标题**（`# 一级`…`###### 六级`）；setext 标题（下划线式）不做 ——
 *     它与分隔线 `---` 在行级无法可靠区分，误判会把分隔线吃成标题。
 *   · **代码围栏内的 `#` 不是标题**（``` / ~~~，可缩进）：这是 md 解析最常见的假阳性来源。
 *     围栏内容仍然收成一个 block（它是内容，只是不参与标题层级）。
 *   · 连续非空行算**一个段落**（内部换行保留）：md 的软换行是排版行为，不是语义分隔。
 */

import { buildParseResult, type ParseResult, type ParsedBlock } from './types.js'
import { decodeTextBuffer } from './txt.js'

/** 代码围栏起始/结束（``` 或 ~~~，允许缩进与语言标记） */
const FENCE = /^\s*(`{3,}|~{3,})/u
/** ATX 标题：1~6 个 `#` + 空格 + 标题；允许结尾的闭合 `#` */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u

export function parseMd(bytes: Buffer): ParseResult {
  const { text, encoding } = decodeTextBuffer(bytes)
  const blocks: ParsedBlock[] = []
  /** 标题栈（`stack[level-1]` = 第 level 级标题） */
  const stack: string[] = []

  let paragraph: string[] = []
  let fence: string | null = null
  let fenced: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ text: paragraph.join('\n').trim(), headingPath: [...stack], page: null })
    paragraph = []
  }
  const flushFence = (): void => {
    // 未闭合的围栏（文件被截断）也照常收成一块 —— 宁可有内容，不要静默丢掉半篇
    const content = fenced.join('\n').trim()
    if (content !== '') blocks.push({ text: content, headingPath: [...stack], page: null })
    fenced = []
    fence = null
  }

  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (fence !== null) {
      const marker = FENCE.exec(line)
      if (marker !== null && marker[1]?.[0] === fence[0]) {
        flushFence()
      } else {
        fenced.push(line)
      }
      continue
    }

    const marker = FENCE.exec(line)
    if (marker !== null) {
      flushParagraph()
      fence = marker[1] ?? '```'
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = heading[1]?.length ?? 1
      const title = (heading[2] ?? '').trim()
      // 层级跳变（如 `#` 后直接 `###`）时补齐栈：截到 level-1 再写第 level 层
      if (stack.length > level - 1) stack.length = level - 1
      if (title !== '') stack[level - 1] = title
      // 标题段自己也在自己的路径里（见 `types.ts` 的 `headingPath` 说明）
      if (title !== '') blocks.push({ text: title, headingPath: [...stack], page: null })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    paragraph.push(line.trim())
  }

  flushParagraph()
  if (fence !== null) flushFence()

  return buildParseResult('md', blocks, { encoding })
}
