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

import { useMemo, useRef } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PhrasingContent, Root, RootContent } from 'mdast'
import type { Plugin } from 'unified'

import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCard } from './ToolCard.js'
import { shouldParseTail, streamingMarkdownChunks } from './markdownChunks.js'
import type { ThinkingSegmentView, ToolCallView } from './messageModel.js'

/** 工具卡的占位节点：渲染器按 `dataToolId` 把它换成 `ToolCard`（见 {@link AssistantMarkdown}）。 */
function toolCardNode(callId: string): RootContent {
  return {
    type: 'paragraph',
    children: [],
    data: { hName: 'div', hProperties: { dataToolId: callId } },
  }
}

/** 思考段的占位节点：渲染器按 `dataThinkIndex` 把它换成 `ThinkingBlock`。 */
function thinkingNode(index: number): RootContent {
  return {
    type: 'paragraph',
    children: [],
    data: { hName: 'div', hProperties: { dataThinkIndex: String(index) } },
  }
}

/**
 * 内联时间线上的一个条目（2026-10-21：**思考段与工具卡共用一条线**）。
 *
 * 用户报的问题：思考 A → 工具调用 → 思考 B 时，B 被渲染到了卡片**前面**（因为思考是整体
 * 堆在正文上方的）。修法 = 给二者同一套位置（`offset` 决定插在哪段正文之间、`order` 决定
 * 同偏移时的先后），按 `(offset, order)` 排成一条线再插。
 */
type InlineEntry =
  | { kind: 'tool'; callId: string; offset: number; order: number }
  | { kind: 'think'; index: number; offset: number; order: number }

/**
 * 把内联条目排成一条线。`offset` 缺省（旧消息）按 0；`order` 缺省时用"同类数组下标"兜底，
 * 并让**旧消息**里思考排在工具卡之前（P0-1 时代的历史口径：思考在上、卡片在下）。
 * ⚠️ 显式 `seq` 一定优先 —— 那是新数据里跨两类**共用**的递增序号（唯一可靠的先后判据）。
 */
function orderedInlineEntries(
  tools: readonly ToolCallView[],
  segments: readonly ThinkingSegmentView[],
): InlineEntry[] {
  const entries: InlineEntry[] = []
  tools.forEach((tool, index) => {
    entries.push({ kind: 'tool', callId: tool.callId, offset: tool.textOffset ?? 0, order: tool.seq ?? index })
  })
  segments.forEach((segment, index) => {
    // 旧消息（只有 `thinking` 字符串、既无偏移也无序号）保持历史口径：**排在所有卡片之前**
    //（那时思考块整体渲染在正文与卡片之上）；新数据的段一定带 `seq`，走正常排序。
    const legacy = segment.textOffset === undefined && segment.seq === undefined
    entries.push({
      kind: 'think',
      index,
      offset: segment.textOffset ?? 0,
      order: segment.seq ?? (legacy ? -1 : index),
    })
  })
  return entries.sort((a, b) => a.offset - b.offset || a.order - b.order)
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
 * Parse the whole document first, then place each entry before the first complete block after its offset.
 *
 * ⚠️ 先按偏移把「条目落在块内部」的文本块切开（{@link splitTextBlockAt}），再插入 —— 两步缺一不可，
 * 否则同一段里的多个条目会叠在一起（见该函数的说明）。切开之后每个条目都落在块边界上，
 * 插入规则仍是"插在**第一个起始偏移 ≥ 它的块**之前"；落在不可切分块（列表 / 代码围栏）内部的
 * 条目自然落到该块之后（与原行为一致）。
 *
 * ⚠️ 顺序完全由 {@link orderedInlineEntries} 决定（`(offset, order)`）—— 插入循环只按那个顺序
 * 往同一个位置 `splice`，所以**同偏移时先出的一定先插**（这正是"思考 A 在工具卡前"的判据）。
 */
function insertInlineEntries(tree: Root, entries: readonly InlineEntry[]): void {
  if (entries.length === 0) return
  const positioned: { node: RootContent; start: number }[] = []
  for (const block of tree.children) {
    const start = block.position?.start.offset
    const end = block.position?.end.offset
    if (start === undefined || end === undefined) {
      positioned.push({ node: block, start: Number.POSITIVE_INFINITY })
      continue
    }
    const inside = entries
      .filter((item) => item.offset > start && item.offset < end)
      .map((item) => item.offset)
    const parts = inside.length === 0 ? null : splitTextBlockAt(block, inside)
    if (parts === null) {
      positioned.push({ node: block, start })
      continue
    }
    positioned.push(...parts)
  }

  tree.children = positioned.map((item) => item.node)
  let entryIndex = 0
  let inserted = 0
  for (const item of positioned) {
    while (entryIndex < entries.length && entries[entryIndex]!.offset <= item.start) {
      const entry = entries[entryIndex]!
      tree.children.splice(
        inserted,
        0,
        entry.kind === 'tool' ? toolCardNode(entry.callId) : thinkingNode(entry.index),
      )
      inserted += 1
      entryIndex += 1
    }
    inserted += 1
  }
  while (entryIndex < entries.length) {
    const entry = entries[entryIndex]!
    tree.children.push(entry.kind === 'tool' ? toolCardNode(entry.callId) : thinkingNode(entry.index))
    entryIndex += 1
  }
}

/** 只插工具卡（保留给产物预览等"没有思考段"的调用点；行为与 2026-10-21 之前逐字一致） */
export function remarkToolCards(tools: readonly ToolCallView[]): Plugin<[], Root> {
  return () => (tree) => {
    if (tools.length === 0) return
    insertInlineEntries(tree, orderedInlineEntries(tools, []))
  }
}

/**
 * 把**思考段与工具卡**按内联时间线插进正文（2026-10-21；`AssistantMarkdown` 用它）。
 * 二者共用一个 `(offset, seq)` 序列 ⇒「思考 A → 工具卡 → 思考 B → 正文」按发生顺序落位。
 */
export function remarkInlineBlocks(
  tools: readonly ToolCallView[],
  segments: readonly ThinkingSegmentView[],
): Plugin<[], Root> {
  return () => (tree) => {
    insertInlineEntries(tree, orderedInlineEntries(tools, segments))
  }
}

export interface AssistantMarkdownProps {
  text: string
  /** Optional tool cards positioned among complete Markdown blocks. */
  tools?: readonly ToolCallView[]
  /**
   * 思考段（2026-10-21）：与工具卡**同一条内联时间线** —— 按 `(textOffset, seq)` 一起插进正文。
   * 这样「思考 A → 工具卡 → 思考 B」才会按发生顺序出现（用户报的正是 B 跑到卡片前面）。
   */
  thinkingSegments?: readonly ThinkingSegmentView[]
  /** 思考段里**仍在生成**的那一段（其余段落已完成、默认折叠）；不传 = 都当已完成 */
  streamingThinkingIndex?: number
  /**
   * 这一条消息**正在流式生成**（内存优化 P3，`docs/子方案/前端长会话内存优化.md`）。
   *
   * `true` 时正文走"稳定前缀 + 尾巴"两段渲染（见 `markdownChunks.ts`）：
   * 已完成的块只解析一次，末尾还在长的部分按纯文本渲染 —— 于是**一帧不再全量重解析**。
   * 收尾（`false` / 不传）时整篇解析一次，与历史消息逐字同款。
   * 默认 `false`：历史消息、产物预览等"一次性渲染"的调用点不需要它。
   */
  streaming?: boolean
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

/**
 * ⚠️ **renderers 必须稳定**（2026-10-21，修"流式期间点不开工具卡"）：
 *
 * react-markdown 每次渲染都会重建整棵元素树，而 `div` 覆盖件的**函数引用就是元素 type**。
 * 早先这个闭包在每次渲染时新建 ⇒ 每次 delta/thinking 帧（一轮几千次）都让 React 认为
 * "组件类型变了" ⇒ **整棵 markdown 子树卸载重挂** ⇒ `ToolCard` 的 `userChoice` 状态
 * 几十毫秒内被重置回默认值（表现：点了「展开」又自己弹回去、根本点不开），
 * 顺带把 CPU 花在全量重解析 + 重挂上。
 *
 * 修法：闭包**只建一次**（依赖只有"有没有工具卡"），工具数据经 `ref` 取最新 ——
 * 于是 type 稳定、ToolCard 实例得以保留（再配合 `ToolCard` 的 `memo`，未变化的卡片连重渲染都省掉）。
 * `tools` 的引用在 `roundReducer` 的 `delta`/`thinking` 分支是**保留**的（只有工具帧才换数组），
 * 所以这层 memo 在正文流式期间不会失效。
 */
export function AssistantMarkdown({
  text,
  tools,
  thinkingSegments,
  streamingThinkingIndex,
  streaming = false,
  components,
}: AssistantMarkdownProps) {
  const hasTools = tools !== undefined && tools.length > 0
  const hasThinking = thinkingSegments !== undefined && thinkingSegments.length > 0
  const hasInline = hasTools || hasThinking
  /** 最新一份 `callId → 工具`（渲染期写入，闭包里读 —— 见上面的说明） */
  const toolByIdRef = useRef<Map<string, ToolCallView>>(new Map())
  toolByIdRef.current = new Map((tools ?? []).map((tool) => [tool.callId, tool]))
  /** 最新一份思考段（同款：闭包里读 ref，保证 renderer 的 type 稳定） */
  const segmentsRef = useRef<readonly ThinkingSegmentView[]>([])
  segmentsRef.current = thinkingSegments ?? []
  const streamingThinkingRef = useRef<number | undefined>(undefined)
  streamingThinkingRef.current = streamingThinkingIndex

  const renderers = useMemo<Components | undefined>(() => {
    if (!hasInline) return components
    return {
      ...components,
      div: ({ node, ...props }) => {
        const toolId = node?.properties?.['dataToolId']
        if (toolId !== undefined) {
          const tool = toolByIdRef.current.get(String(toolId))
          if (tool !== undefined) return <ToolCard tool={tool} />
        }
        const thinkIndex = node?.properties?.['dataThinkIndex']
        if (thinkIndex !== undefined) {
          const index = Number(thinkIndex)
          const segment = segmentsRef.current[index]
          if (segment !== undefined) {
            return <ThinkingBlock text={segment.text} streaming={streamingThinkingRef.current === index} />
          }
        }
        return <div {...props} />
      },
    }
  }, [components, hasInline])

  // 插件数组本身不参与元素 type 判定（同步版 Markdown 每帧都会重跑解析），
  // 但它决定"条目插在哪" ⇒ 只在清单变化时重建（正文增量不重建）。
  // ⚠️ 思考段的 text 会随时增长，而位置在段首就定死了 ⇒ 插件只需拿到 (offset, seq)；
  //    这里仍按引用重建（数组变了才重建），代价只是重新插一遍，不影响元素 type。
  const remarkPlugins = useMemo(
    () =>
      hasInline
        ? [remarkGfm, remarkInlineBlocks(tools ?? [], thinkingSegments ?? [])]
        : [remarkGfm],
    [hasInline, tools, thinkingSegments],
  )

  /**
   * 流式分块（内存优化 P3）：见 `markdownChunks.ts`。`stable` 在未跨过新的块边界时**是同一个字符串**
   * ⇒ `Markdown` 的 children 引用不变 ⇒ 已完成的部分不再重新解析。
   *
   * ⚠️ 内联条目（工具卡 / 思考段）在分块期间**由尾巴那一次解析承载**：`markdownChunks.ts` 的
   * 边界取"最后一个空行之后"，而条目到达的那一刻，它锚定的正文块**已经写完**（后端按
   * `textOffset` 定位，正文先到、卡片随后）⇒ 条目的偏移必然 ≥ 尾巴的起点。
   * 于是：
   *   · 稳定段（纯正文前缀）用**没有条目**的插件解析 —— 它的结果因此与条目无关、可稳定复用；
   *   · 尾巴用**全量条目**的插件解析 —— 条目落在尾巴内部（`insertInlineEntries` 只看相对位置），
   *     落在尾巴之前的条目会被它插在尾巴开头（视觉上就在"正文之间"，与一次性解析一致）。
   * 收尾时（`streaming === false`）走整篇解析，所以最终形态与历史消息逐字同款。
   */
  const chunks = useMemo(
    () => (streaming ? streamingMarkdownChunks(text) : { stable: text, tail: '' }),
    [streaming, text],
  )
  /** 尾巴是否交给解析器（极长且没有空行的正文，见 `shouldParseTail`） */
  const parseTail = chunks.tail !== '' && shouldParseTail(chunks.tail)
  /** 稳定段：纯正文前缀 ⇒ 插件里**不带**条目（见上面 ⚠️ 第三条） */
  const stablePlugins = useMemo(() => [remarkGfm], [])

  if (!streaming || chunks.tail === '') {
    return (
      // `.md` 的样式在 `styles/base.css`（P0-1-30 从 `design/styles/base.css` 搬入），
      // 含 `pre` / `code` / `table` / `blockquote` 的完整口径 —— 这里不重复写任何样式
      <div className="md">
        <Markdown
          remarkPlugins={remarkPlugins}
          {...(renderers === undefined ? {} : { components: renderers })}
        >
          {text}
        </Markdown>
      </div>
    )
  }

  return (
    <div className="md">
      {chunks.stable === '' ? null : (
        <Markdown
          remarkPlugins={stablePlugins}
          {...(renderers === undefined ? {} : { components: renderers })}
        >
          {chunks.stable}
        </Markdown>
      )}
      {chunks.tail === '' ? null : parseTail ? (
        <Markdown
          remarkPlugins={remarkPlugins}
          {...(renderers === undefined ? {} : { components: renderers })}
        >
          {chunks.tail}
        </Markdown>
      ) : (
        // 尾巴按纯文本（`pre-wrap` 保留换行）：它可能是一个还没写完的代码围栏 / 表格，
        // 解析出来只会是"半截语法"。收尾时整篇解析一次，立刻恢复正常渲染。
        <div className="md md--tail" style={{ whiteSpace: 'pre-wrap' }}>
          {chunks.tail}
        </div>
      )}
    </div>
  )
}
