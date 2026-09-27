/**
 * 图片预览（`子方案④` §五 4）—— **直出**，不 fetch、不进 JS 堆
 *
 * ★ **不含 SVG**：`image/svg+xml` 由 `shared#previewKindOf` 判给 **HTML 那一路**
 * （iframe + 双隔离）—— SVG 是能带 `<script>` 的文档，`<img>` 上下文里脚本不执行（安全），
 * 但"在新标签页打开"就会以**我们站点的源**执行 ⇒ 它与 HTML 同级。代价只是"SVG 不在 `<img>`
 * 里直出"，观感完全一样。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ `onError` 的兜底文案**必须有**
 * ─────────────────────────────────────────────────────────────────────
 * 会话过期 / 归属不对时，`/content` 回的是一份 **401 的 JSON** ⇒ `<img>` 只会"裂开"，
 * 用户看到的是一块空白而不知道为什么（`子方案④` §五 4 / `03` §4.6 的"两种取不到要分开显示"）。
 * 所以失败态要**明确写出来**："可能是会话已过期或你没有这个产物的访问权限"。
 */

import { useState } from 'react'
import { Alert } from 'antd'

import { artifactContentUrl } from './artifactPreview.js'

export interface ImagePreviewProps {
  artifactId: string
  fileName: string
}

export function ImagePreview({ artifactId, fileName }: ImagePreviewProps) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <Alert
        type="warning"
        showIcon
        message="图片没能加载"
        description="可能是会话已过期、或你没有这个产物的访问权限。可重新登录后重试，或点右上角「下载」看原文件。"
      />
    )
  }

  return (
    <div className="preview preview--image">
      <img
        src={artifactContentUrl(artifactId)}
        alt={fileName}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  )
}
