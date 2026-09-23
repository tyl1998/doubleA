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
 */

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export interface AssistantMarkdownProps {
  text: string
}

export function AssistantMarkdown({ text }: AssistantMarkdownProps) {
  return (
    // `.md` 的样式在 `styles/base.css`（P0-1-30 从 `design/styles/base.css` 搬入），
    // 含 `pre` / `code` / `table` / `blockquote` 的完整口径 —— 这里不重复写任何样式
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}
