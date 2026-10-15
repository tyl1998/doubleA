/**
 * 渲染预览的 HTML 外壳（P1-16）—— DOCX / XLSX 两条 `/render` 转换**共用**的文档包装与样式
 *
 * ⚠️ **为什么单独一个文件**：`docxPreview.ts` 与 `xlsxPreview.ts` 都要"把一段 HTML 片段包成
 * 一份完整、带 `charset` 与基础排版的文档"，两处各写一遍必然分叉（例如一处忘了转义 `<title>`）。
 * 判据只有一处，是 `service/previewHeaders.ts` 那条纪律的同款。
 *
 * ⚠️ 样式用**内联 `<style>`**（不是外部样式表）：`/render` 出口上的 CSP 是
 * `style-src 'unsafe-inline'`、`default-src 'none'` ⇒ 外部 CSS 根本加载不了（见 `HTML_PREVIEW_CSP`）。
 */

/** 文本 → HTML 文本节点（`<title>` / 单元格 / 小标题都走它，避免 `<`/`&` 破结构） */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** 基础排版：**只给可读性，不还原版面**（两张表都用它） */
export const PREVIEW_BASE_STYLE = [
  'body{margin:0;padding:24px 28px;font:14px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff;overflow-wrap:anywhere}',
  'h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.2em 0 .5em}h1{font-size:1.6em}h2{font-size:1.4em}h3{font-size:1.2em}',
  'p{margin:.6em 0}ul,ol{padding-left:1.6em}',
  'table{border-collapse:collapse;margin:.8em 0}td,th{border:1px solid #d0d7de;padding:4px 8px}',
  'img{max-width:100%;height:auto}a{color:#0969da}',
].join('')

/**
 * 把 HTML 片段包成完整文档（`charset=utf-8` + 基础样式 + 可选的追加样式）。
 *
 * @param extraStyle 追加的 `<style>`（如表格预览的网格样式）；空串则不加
 */
export function wrapPreviewDocument(bodyHtml: string, title: string, extraStyle = ''): string {
  const style = extraStyle === '' ? PREVIEW_BASE_STYLE : PREVIEW_BASE_STYLE + extraStyle
  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtmlText(title)}</title><style>${style}</style></head><body>${bodyHtml}</body></html>`
  )
}
