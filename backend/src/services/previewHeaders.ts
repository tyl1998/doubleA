/**
 * 预览形态的**响应头分派**（`P0-3-10` 起；`P1-9` 抽成独立模块供工作区字节出口复用）
 *
 * 依据：`子方案/文件预览.md` §四 2（响应头分派表）+ `子方案/Code模式工作区.md` §六 1
 *      （"响应头复用 `routes/artifacts.ts#previewHeadersFor` 的分派与隔离头"）。
 *
 * ⚠️ **为什么抽出来**：产物预览（`routes/artifacts.ts`）与工作区字节出口（`routes/workspace.ts`）
 * 必须上**同一组头**（尤其 HTML/SVG 的 CSP `sandbox`）—— 两处各写一遍必然有一处先腐烂，而腐烂的
 * 方向正是"某个入口忘了隔离头"。判据只此一份。
 */

import { previewKindOf, type PreviewKind } from '@doubulea/shared'

/**
 * ★ HTML / SVG 的隔离头：`子方案④` §六 判据 ① 的**第一道**（iframe 属性只是第二道）。
 *
 * `default-src 'none'` + `img-src data:` + `style-src 'unsafe-inline'`：
 * 不给脚本、不给网络（连同源的 `/api/...` 都不给），只留内嵌图片与内联样式。
 */
export const HTML_PREVIEW_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/** 预览响应的 `Content-Disposition` 形态（`子方案④` §四 2 的最后一列） */
export type PreviewDisposition = 'inline' | 'attachment'

/** 预览响应头里"随形态变化"的那三样（其余头两条端点完全一样） */
export interface PreviewHeaders {
  contentType: string
  disposition: PreviewDisposition
  /** 只有 HTML/SVG 那一路有值（PDF **刻意不加**，见 {@link HTML_PREVIEW_CSP} 的对照说明） */
  csp: string | null
}

/** 取 `mime` 的主类型（`text/html; charset=utf-8` → `text/html`）—— 拼 `; charset=utf-8` 之前要先剥参数 */
function baseMimeOf(mime: string): string {
  const raw = mime.trim().toLowerCase()
  const semicolon = raw.indexOf(';')
  return (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim()
}

/**
 * 预览响应的**响应头分派**：按 `mime` 一处判据上不同的头（`子方案④` §四 2 的表）。
 *
 * 三条要点（都是"不写就会静默出错"的）：
 *   ① ★ **`text` 一律回 `text/plain`**，不回它声明的类型（防止把 `/content` URL 直接贴进地址栏时
 *      被浏览器当 HTML 渲染）；
 *   ② **PDF 刻意不加 CSP `sandbox`**：MDN 明确说 sandbox "prevents the execution of plugins"，
 *      而 PDF 的浏览器内置 viewer 属这一类 ⇒ 加了会渲染不出来；
 *   ③ **`none` / `docx` / `xlsx`（zip / 未知类型 / OOXML 原始字节）当作下载处理**（`attachment` + `octet-stream`）。
 *      ⚠️ `docx` / `xlsx` 的**在线预览**不在本函数（它们走 `/render` 出口，见 switch 里的注释）。
 */
export function previewHeadersFor(mime: string): PreviewHeaders {
  const kind: PreviewKind = previewKindOf(mime)
  switch (kind) {
    case 'html':
      // SVG 归这一路（`previewKindOf` 已定案）：它是能带 `<script>` 的文档
      return { contentType: `${baseMimeOf(mime)}; charset=utf-8`, disposition: 'inline', csp: HTML_PREVIEW_CSP }
    case 'image':
      // `<img>` 上下文不执行脚本 ⇒ 不需要 CSP；但 `nosniff` 照样要（调用方统一加）
      return { contentType: baseMimeOf(mime), disposition: 'inline', csp: null }
    case 'pdf':
      return { contentType: 'application/pdf', disposition: 'inline', csp: null }
    case 'text':
      return { contentType: 'text/plain; charset=utf-8', disposition: 'inline', csp: null }
    case 'docx':
    case 'xlsx':
      // ⚠️ `docx` / `xlsx` 的**原始字节**是二进制 OOXML，绝不能当 HTML 直出（`/content` 与工作区
      //    字节出口都走本函数）⇒ 与 `none` 同款：`octet-stream` + `attachment`，浏览器只会把它存下来。
      //    它们的**在线预览**由另一条出口 `GET /api/artifacts/:id/render` 负责
      //    （docx → mammoth、xlsx → 手写读取器，均产出 HTML），那个出口自己上
      //    `text/html` + {@link HTML_PREVIEW_CSP}（见 `routes/artifacts.ts`）。
      return { contentType: 'application/octet-stream', disposition: 'attachment', csp: null }
    default:
      return { contentType: 'application/octet-stream', disposition: 'attachment', csp: null }
  }
}

/**
 * 工作区字节出口的分派：在 {@link previewHeadersFor} 之上补一层"**代码文件也当文本**"。
 *
 * 为什么工作区要扩：`previewKindOf` 名单保守（只认 4 种文本形态），而工作区是一整棵代码树
 * （`.ts`/`.go`/… 都是 `text/*` 或显式白名单）—— 它们应 `inline` + `text/plain`（源码预览），
 * 而不是落到 `none` 被当二进制下载。判据复用 `shared#isWorkspaceTextMime`，不另写名单。
 */
export function workspaceRawHeadersFor(mime: string, isText: boolean): PreviewHeaders {
  if (isText && previewKindOf(mime) === 'none') {
    // 代码类：给 `text/plain` inline（源码可读、不会被当 HTML 渲染）
    return { contentType: 'text/plain; charset=utf-8', disposition: 'inline', csp: null }
  }
  return previewHeadersFor(mime)
}