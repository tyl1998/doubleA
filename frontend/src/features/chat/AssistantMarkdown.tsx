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

export interface AssistantMarkdownProps {
  text: string
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

export function AssistantMarkdown({ text, components }: AssistantMarkdownProps) {
  return (
    // `.md` 的样式在 `styles/base.css`（P0-1-30 从 `design/styles/base.css` 搬入），
    // 含 `pre` / `code` / `table` / `blockquote` 的完整口径 —— 这里不重复写任何样式
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} {...(components === undefined ? {} : { components })}>
        {text}
      </Markdown>
    </div>
  )
}
