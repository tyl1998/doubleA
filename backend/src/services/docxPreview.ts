/**
 * DOCX 渲染预览（P1-16）—— 把 `.docx` 的**原始字节**转成一份可安全渲染的 HTML 文档
 *
 * 依据：`docs/子方案/文件预览.md` §五（格式落法）+ §六（六条安全判据）+ §五 8（本格式）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么复用 mammoth（backend 已有依赖）、而不是前端引解析库
 * ─────────────────────────────────────────────────────────────────────
 * `mammoth` 自 P0-1-16 起就是 **backend 的已声明依赖**（知识库流水线在用它：`pipeline/parse/docx.ts`）。
 * 产物预览只需在同一依赖上多接一个出口（{@link renderDocxToHtml}），**不必给前端再引一套渲染引擎**
 * （前端引 mammoth/SheetJS 之类是 10^5 字节级、还要自己净化）—— 这正是本仓"省事、好维护"的取舍。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 安全：靠**响应头 CSP `sandbox`**（第一道），不靠净化 HTML 串
 * ─────────────────────────────────────────────────────────────────────
 * 本函数**只负责产出 HTML**，隔离由调用方的响应头承担（`routes/artifacts.ts` 的 `/render` 出口上
 * `HTML_PREVIEW_CSP`：`sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'`）。
 * ⇒ 脚本、网络、外链全被 CSP 挡住；mammoth 的**默认图片转换器会把内嵌图转成 `data:` URI**
 * （正好命中 `img-src data:`），所以文档里的图片能显示。
 * ⚠️ 因此**不要**在这里手写"去 `<script>`"之类的净化 —— 那会与 CSP 形成两套口径，
 *    而真正生效的是响应头（判据 ①：iframe 属性只是第二道，响应头才是第一道）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 已知边界（与既有预览口径一致）
 * ─────────────────────────────────────────────────────────────────────
 *   · 只吃 `.docx`（OOXML）。`.doc`（OLE2 二进制）不在产物 mime 映射里 ⇒ 仍只给下载；
 *   · 不做分页 / 页眉页脚还原（mammoth 输出的是**语义结构**，不是版面）；
 *   · 不缓存转换结果：产物单文件 ≤ `ARTIFACT_MAX_FILE_MB`，预览是"点开才转"，先保持简单。
 */

import mammoth from 'mammoth'

import { getLogger } from '../infra/logger.js'
import { wrapPreviewDocument } from './previewShell.js'

/**
 * DOCX 字节 → 可渲染的完整 HTML 文档串（见文件头）。
 *
 * `mammoth.messages` 是它的**告警通道**（未识别样式 / 未知元素），不是错误 ——
 * 与 `pipeline/parse/docx.ts` 同口径，记 debug 供排查（正常路径打 info 会被刷满）。
 *
 * @throws 解析失败（不是合法 OOXML：损坏 / 改名 / 截断）由 mammoth 抛错，调用方兜成 4xx
 */
export async function renderDocxToHtml(bytes: Buffer, title: string): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: bytes })
  if (result.messages.length > 0) {
    getLogger().debug(
      { messages: result.messages.slice(0, 5), total: result.messages.length },
      'docx 渲染告警（mammoth messages）',
    )
  }
  return wrapPreviewDocument(result.value, title)
}
