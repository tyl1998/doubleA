/**
 * HTML / SVG 预览（`子方案④` §五 3）—— **沙箱 iframe**
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★★ 两条隔离，缺一不可（且**响应头才是第一道**）
 * ─────────────────────────────────────────────────────────────────────
 * ① **响应头 `Content-Security-Policy: sandbox …`**（后端 `routes/artifacts.ts#HTML_PREVIEW_CSP`）
 *    —— iframe 的 `sandbox` 属性**只在被嵌进 iframe 时生效**：用户在弹层里右键
 *    "在新标签页打开"、或直接把 `/content` URL 贴进地址栏，那份文档就**不在 iframe 里**了，
 *    此时唯一还在生效的就是响应头。CSP `sandbox` 对 standalone document 同样生效
 *    （MDN 在 `allow-top-navigation` 系列上专门注明"这些值对 standalone document 无效"——
 *    反过来说明该指令确实作用于 standalone document）。
 *    这也是产物预览走**后端代理**而不是签名 URL 的决定性理由（签名 URL 的响应由对象存储直发，
 *    我们一个头都加不上）。
 * ② **这里的 `sandbox=""`**（空串 = 最严格）是第二道。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个"不给"，每一个都有理由
 * ─────────────────────────────────────────────────────────────────────
 *   · ★ **永不给 `allow-same-origin`**：给了它，iframe 文档就保留**我们站点的源**
 *     ⇒ 它能读 `document.cookie` / `localStorage`。一份引擎产出的 HTML 不该拥有登录态。
 *   · ★ **不给 `allow-scripts`**：需求 30 的"HTML 预览仅沙箱 iframe"就是这一步。
 *   · **不给 `allow-downloads` / `allow-popups` / `allow-forms`**：默认全关，别顺手加。
 *
 * ⚠️ **已知边界**（`子方案④` §八 1）：HTML 产物里的**相对资源**（`<img src="chart.png">`）
 * 会以 `/api/artifacts/:id/content` 为 base 解析 ⇒ 打到 `/api/artifacts/:id/chart.png` ⇒ 404。
 * P0 **不做资源重写**，用户可下载原文件看。
 */

import { artifactContentUrl } from './artifactPreview.js'

export interface HtmlPreviewProps {
  artifactId: string
  /** 用于 iframe 的无障碍标题（文件名） */
  fileName: string
  /**
   * iframe 的 `src`。缺省 = {@link artifactContentUrl}（HTML/SVG 的字节直出）；
   * **DOCX 传 {@link artifactRenderUrl}**（`/render`，服务端渲染好的 HTML）——
   * 两者都是"同源的 HTML 文档"，故共用本组件与同一套沙箱属性。
   */
  src?: string
}

export function HtmlPreview({ artifactId, fileName, src }: HtmlPreviewProps) {
  return (
    <iframe
      className="preview__frame"
      src={src ?? artifactContentUrl(artifactId)}
      // 空串 = 最严格：**不含 `allow-scripts`、不含 `allow-same-origin`**
      sandbox=""
      referrerPolicy="no-referrer"
      title={fileName}
    />
  )
}
