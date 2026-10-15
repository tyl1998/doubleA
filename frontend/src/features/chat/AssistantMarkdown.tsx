/**
 * 助手正文的 Markdown 渲染（P0-1-32；`docs/03` §一 选型「react-markdown + 代码高亮」、
 * §4.1 消息流渲染规则表第 2 行："Markdown（代码高亮/表格/复制）"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"渲染器"而不是"自己写个极简 Markdown"
 * ─────────────────────────────────────────────────────────────────────
 * 助手回答里真实会出现表格、围栏代码块、嵌套列表、行内代码 —— 自己写的简化版**不报错、只是渲染得不对**
 * （表格变成一串竖线、代码块变成一大段斜体），而且流式期间每帧都要重新解析，边界问题会翻倍。
 * `03` §一 已经定了 react-markdown，照做。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条安全/口径约束
 * ─────────────────────────────────────────────────────────────────────
 * ① **不渲染原始 HTML**：`react-markdown` 默认就不解析 HTML（等价于 `skipHtml`），保持默认。
 *    模型输出里的 `<script>` 之类来自外部输入，不能进 DOM。
 * ② **`remark-gfm` 只为表格与删除线**：`03` §4.1 点名要表格；GFM 还带来任务列表等，
 *    都是"模型会写、用户期待看到"的语法。它不引入任何需要额外授权的行为。
 * ③ **不做语法高亮**（与 `03` §一 的"代码高亮"有一处**已记录的差异**）：
 *    高亮库（highlight.js 全量 / shiki）会显著增大前端产物，而本批的产物已经接近
 *    vite 的告警线（P0-1-30 记的 760KB 单块）；`manualChunks` 与是否引入高亮一起在
 *    **P0-1-36**（前端验收 + 产物优化）里定。现在代码块按 `.md pre code` 的等宽样式渲染，
 *    **不是"忘了"**。要补的话，接进本组件一处即可（`components.code` 的渲染器）。
 *
 *    ⚠️ **P0-1-36 定案：维持不引入。** 三条理由，任一条都足够：
 *      ① **验收门槛里没有它** —— `01` §3.4 对对话页的要求是引用 / 思考 / 停止 / 恢复历史，
 *         代码块只要**可读**（等宽 + 横向滚动，`.md pre code` 已有）；`03` §一 选型表里
 *         与它相关的那半句本来就是「**暂缓**」。
 *      ② **体积与依赖**：highlight.js 全量 gzip 后约 120 KB（语言包另计）、shiki 更大且要
 *         带 wasm/grammar；而本仓从 P0-1-30 起是一条**实际执行的纪律**（每批都写着"零新增依赖"）。
 *         为一个没有验收要求的效果引入本批最大的一个依赖，交换比不成立。
 *      ③ **它有明确的接回点**：真要加，动的是**这一个组件的一处**（`components.code`），
 *         不影响任何契约、服务端或数据。所以"暂缓"是可逆的 —— 这也是能安心定案的前提。
 */

import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PhrasingContent, Root, RootContent } from 'mdast'
import type { Plugin } from 'unified'

import { ToolCard } from './ToolCard.js'
import type { ToolCallView } from './messageModel.js'

/** 工具卡的占位节点：渲染器按 `dataToolId` 把它换成 `ToolCard`（见 {@link AssistantMarkdown}）。 */
function toolCardNode(callId: string): RootContent {
  return {
    type: 'paragraph',
    children: [],
    data: { hName: 'div', hProperties: { dataToolId: callId } },
  }
}

/**
 * 把**文本块**（段落 / 标题）在若干**块内偏移**处切开，返回 `{ 节点, 起始偏移 }` 的片段序列。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须切（产品反馈 2026-10-14："工具又跟上面的叠在了一起"）
 * ─────────────────────────────────────────────────────────────────────
 * 卡片位置是正文的**字符偏移**（`tool_call.textOffset`），而模型常常在**同一段**里写
 * "一句话 → 调工具 → 又一句话"（两句话之间没有空行，工具调用本身又不产生正文 ⇒ 两段正文
 * 被拼成一个段落）。旧实现只在**块边界**插卡（"绝不切开段落 / 列表 / 代码围栏"），于是
 * 落在段落内部的卡全被推到**段尾**：多张卡**叠在一起**，正文反而整段跑到卡片上方。
 * 切开之后，"第一张卡 → 后半句 → 第二张卡" 才会按调用顺序穿插。
 *
 * 只切**纯文本行内节点**（`value.slice`）；偏移恰好落在两个行内节点之间时按边界切；
 * 一旦落在**非文本行内节点内部**（如 `**粗体**`、行内代码、链接的中间）就放弃切分
 * （返回 `null`）—— 那种情况下硬切会产生**半截语法**，比"卡片位置略偏"更糟。
 * 非文本块（列表 / 代码围栏 / 表格 / 引用）一律不切，维持原行为（卡片排在该块之后）。
 */
function splitTextBlockAt(
  block: RootContent,
  offsets: readonly number[],
): { node: RootContent; start: number }[] | null {
  if (block.type !== 'paragraph' && block.type !== 'heading') return null
  const blockStart = block.position?.start.offset
  if (blockStart === undefined) return null
  const cuts = [...offsets].sort((a, b) => a - b)
  const parts: { children: PhrasingContent[]; start: number }[] = [{ children: [], start: blockStart }]
  const current = (): { children: PhrasingContent[]; start: number } => parts[parts.length - 1]!
  let cutIndex = 0
  for (const child of block.children) {
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    if (start === undefined || end === undefined) return null
    // 落在本节点**之前**的切点（含相邻行内节点之间的边界）⇒ 每个切点各开一段
    while (cutIndex < cuts.length && cuts[cutIndex]! <= start) {
      parts.push({ children: [], start: cuts[cutIndex]! })
      cutIndex += 1
    }
    // 落在本节点**内部**的切点：只有纯文本节点能切
    if (cutIndex < cuts.length && cuts[cutIndex]! < end) {
      if (child.type !== 'text') return null
      let from = start
      while (cutIndex < cuts.length && cuts[cutIndex]! < end) {
        const cut = cuts[cutIndex]!
        const piece = child.value.slice(from - start, cut - start)
        if (piece !== '') current().children.push({ ...child, value: piece })
        parts.push({ children: [], start: cut })
        from = cut
        cutIndex += 1
      }
      const rest = child.value.slice(from - start)
      if (rest !== '') current().children.push({ ...child, value: rest })
      continue
    }
    current().children.push(child)
  }
  // 同一偏移的多张卡会产生空段 ⇒ 丢掉（边界仍在：由后一段的 `start` 承载）
  return parts
    .filter((part) => part.children.length > 0)
    .map((part) => ({ node: { ...block, children: part.children }, start: part.start }))
}

/**
 * Parse the whole document first, then place each card before the first complete block after its offset.
 *
 * ⚠️ 先按偏移把「卡落在块内部」的文本块切开（{@link splitTextBlockAt}），再插卡 —— 两步缺一不可，
 * 否则同一段里的多张卡会叠在一起（见该函数的说明）。切开之后每张卡都落在块边界上，
 * 插入规则仍是"插在**第一个起始偏移 ≥ 它的块**之前"；落在不可切分块（列表 / 代码围栏）内部的卡
 * 自然落到该块之后（与原行为一致）。
 */
export function remarkToolCards(tools: readonly ToolCallView[]): Plugin<[], Root> {
  return () => (tree) => {
    if (tools.length === 0) return
    // 旧消息没有 `textOffset` ⇒ 按 0 处理（放在正文最前，见 `messageModel#ToolCallView`）
    const ordered = [...tools]
      .map((tool) => ({ callId: tool.callId, offset: tool.textOffset ?? 0 }))
      .sort((a, b) => a.offset - b.offset)

    // ① 切分：块的位置信息在切分后不再可靠（同一段的各片共享原位置）⇒ 显式带着 `start` 边界走
    const positioned: { node: RootContent; start: number }[] = []
    for (const block of tree.children) {
      const start = block.position?.start.offset
      const end = block.position?.end.offset
      if (start === undefined || end === undefined) {
        positioned.push({ node: block, start: Number.POSITIVE_INFINITY })
        continue
      }
      const inside = ordered
        .filter((item) => item.offset > start && item.offset < end)
        .map((item) => item.offset)
      const parts = inside.length === 0 ? null : splitTextBlockAt(block, inside)
      if (parts === null) {
        positioned.push({ node: block, start })
        continue
      }
      positioned.push(...parts)
    }

    // ② 插卡：每张卡插在"第一个起始偏移 ≥ 它的块"之前
    tree.children = positioned.map((item) => item.node)
    let toolIndex = 0
    let inserted = 0
    for (const item of positioned) {
      while (toolIndex < ordered.length && ordered[toolIndex]!.offset <= item.start) {
        tree.children.splice(inserted, 0, toolCardNode(ordered[toolIndex]!.callId))
        inserted += 1
        toolIndex += 1
      }
      inserted += 1
    }
    while (toolIndex < ordered.length) {
      tree.children.push(toolCardNode(ordered[toolIndex]!.callId))
      toolIndex += 1
    }
  }
}

export interface AssistantMarkdownProps {
  text: string
  /** Optional tool cards positioned among complete Markdown blocks. */
  tools?: readonly ToolCallView[]
  /**
   * 渲染器覆盖（**P0-3-10 新增，默认不给**）。
   *
   * 唯一的消费者是**产物预览里的 MD**（`components/ArtifactPreview/MarkdownPreview`）：
   * 那里要多传一个 `components.img` —— `react-markdown@10.1.0` 会把外链图片**原样保留**
   * （实测），渲染出来浏览器就真的去请求那个外网地址（追踪像素 / 泄露访问者 IP），
   * 这是 MD 一路**唯一**的残留风险 ⇒ 产物预览必须把它换成"可点击的链接"。
   *
   * ⚠️ **对话正文刻意不传**：助手正文里没有这个覆盖也不会有 XSS（raw HTML 被转义），
   * 而给整站加 `img-src` 会把一个预览的需求扩散成整个应用的约束（`子方案④` §五 2）。
   */
  components?: Components
}

export function AssistantMarkdown({ text, tools, components }: AssistantMarkdownProps) {
  const toolById = new Map(tools?.map((tool) => [tool.callId, tool]))
  const renderers: Components | undefined = tools === undefined || tools.length === 0 ? components : {
    ...components,
    div: ({ node, ...props }) => {
      const id = node?.properties?.['dataToolId']
      const tool = id === undefined ? undefined : toolById.get(String(id))
      if (tool !== undefined) return <ToolCard tool={tool} />
      return <div {...props} />
    },
  }
  return (
    // `.md` 的样式在 `styles/base.css`（P0-1-30 从 `design/styles/base.css` 搬入），
    // 含 `pre` / `code` / `table` / `blockquote` 的完整口径 —— 这里不重复写任何样式
    <div className="md">
      <Markdown
        remarkPlugins={tools === undefined || tools.length === 0 ? [remarkGfm] : [remarkGfm, remarkToolCards(tools)]}
        {...(renderers === undefined ? {} : { components: renderers })}
      >
        {text}
      </Markdown>
    </div>
  )
}
