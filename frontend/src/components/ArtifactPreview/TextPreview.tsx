/**
 * 纯文本 / JSON 预览（`子方案④` §四 2 里 `text` 那一路的**剩余部分**）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 这是 `子方案④` §七 1 那五个渲染器之外的**第六个**，理由要写清
 * ─────────────────────────────────────────────────────────────────────
 * `shared#previewKindOf` 的 `text` 一族里除了 MD（`text/markdown`）与表格（`text/csv` /
 * `text/tab-separated-values`），还有 `text/plain` 与 `application/json` —— 后两种
 * **不能**交给 Markdown 渲染器：react-markdown 会把连续换行折叠成一段（plain 的可读性全在
 * 换行上），也会把 JSON 里的缩进与特殊字符当 Markdown 语法吃掉。所以用 `<pre>` 原样呈现。
 *
 * ⇒ 五个格式（MD / HTML / 图片 / CSV / PDF）不变，本文件只是给 `text` 那一路补上
 * "既不是 MD 也不是表格"的余量。分派在 `ArtifactPreviewDrawer` 一处。
 */

export interface TextPreviewProps {
  text: string
}

export function TextPreview({ text }: TextPreviewProps) {
  return (
    <div className="preview preview--text">
      <pre className="preview__pre">{text}</pre>
    </div>
  )
}
