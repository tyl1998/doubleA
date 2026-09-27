/**
 * PDF 预览（`子方案④` §五 6）—— 交给**浏览器内置 viewer**
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 刻意**不加** CSP `sandbox`（与 HTML 那一路唯一的差别）
 * ─────────────────────────────────────────────────────────────────────
 * MDN 明确说 sandbox "prevents the execution of **plugins**"，而 PDF 的浏览器内置 viewer
 * 属这一类 ⇒ 加了会**渲染不出来**（空框或直接触发下载，看起来像"我们的 PDF 坏了"）。
 *
 * ⚠️ 因此这一路的安全边界**如实写明**：我们**没有**给 PDF 加隔离头，
 * "PDF 内嵌 JS 会不会执行"取决于浏览器内置 viewer 的实现（不是我们的策略）。
 * 这是 `子方案④` **唯一一处把安全交给浏览器**的地方 —— 写在此处而不是藏在代码注释里。
 *
 * ⚠️ 后端代理**不支持 Range**（`子方案④` §八 2）⇒ 大 PDF 会**整份下载后**才显示，
 * 跳页不省流量（产物单文件上限 50MB，且体积闸门已先拦过一次）。
 */

import { artifactContentUrl } from './artifactPreview.js'

export interface PdfPreviewProps {
  artifactId: string
  fileName: string
}

export function PdfPreview({ artifactId, fileName }: PdfPreviewProps) {
  return (
    <iframe
      className="preview__frame"
      src={artifactContentUrl(artifactId)}
      // ⚠️ **没有** `sandbox` 属性 —— 见文件头（加了 PDF 就渲染不出来）
      referrerPolicy="no-referrer"
      title={fileName}
    />
  )
}
