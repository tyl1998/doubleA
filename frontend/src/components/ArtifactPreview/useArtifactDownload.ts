/**
 * 「下载这个产物」的**唯一实现**（P0-3-11）
 *
 * 依据：`docs/03-前端设计.md` §4.1（产物卡那一行「[预览] [下载]」）、§4.6（弹层标题栏的「下载」），
 *      `docs/06-实施计划.md` §五 P0-3-11 行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么抽出来：P0-3-11 让「下载」出现了**第二个**入口
 * ─────────────────────────────────────────────────────────────────────
 * P0-3-10 只有弹层标题栏那一个下载按钮（它的实现在 `ArtifactPreviewDrawer` 里）。
 * 本批把产物卡上的「下载」也接上了（消息流里的卡 + 面板里的卡，共用一个 `ArtifactCard`），
 * 于是同一段动作有了两处调用点：`saveArtifactFile` → 成功/失败提示 → `downloading` 态。
 *
 * 抄一份的代价不是那六行，而是 **`docs/06` §六 第 ⑰ 条**那句话：同一口径在两处各写一遍，
 * 必有一处先腐烂 —— 下载失败时的文案（"下载失败"）、成功时的（"已开始下载"）、
 * 以及"按钮在飞时禁用"的判据，只要有人改了其中一处，两个入口的行为就开始不一致，
 * 而这**不会报任何错**。故判据与副作用都收在这一处，两个消费方共用。
 *
 * ⚠️ `saveArtifactFile` 抛出的 `ApiError` **原样交给 `feedback.fail`**（不自己拼文案）：
 * 「失败长什么样」在全站只有一个口径（`app/feedback.ts`，`03` §六 的坑预判）。
 */

import { useState } from 'react'

import { saveArtifactFile } from '../../api/artifacts.js'
import { useFeedback } from '../../app/feedback.js'

export interface ArtifactDownload {
  /** 这一次下载在飞（按钮据此 `disabled` + `loading`，防连点） */
  downloading: boolean
  /** 触发下载。**返回 `void` 而不是 Promise**：调用方没有"下载完之后"要做的事 */
  download: (artifact: { artifactId: string; fileName: string }) => void
}

export function useArtifactDownload(): ArtifactDownload {
  const feedback = useFeedback()
  const [downloading, setDownloading] = useState(false)

  function download(artifact: { artifactId: string; fileName: string }): void {
    setDownloading(true)
    void saveArtifactFile(artifact)
      .then(() => {
        feedback.ok('已开始下载')
      })
      .catch((error: unknown) => {
        feedback.fail(error, '下载失败')
      })
      .finally(() => {
        setDownloading(false)
      })
  }

  return { downloading, download }
}
