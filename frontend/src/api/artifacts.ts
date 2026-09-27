/**
 * 产物接口封装（P0-3-10：**预览取文本 + 触发下载**）
 *
 * 依据：`docs/02-后端设计.md` §4.8（`/api/artifacts/:id/content` 与 `/download`）、§4.9（不套信封）、
 *      `docs/子方案/文件预览.md` §三/§四（两条出口、后端代理）、`docs/03-前端设计.md` §4.6
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 两条端点都是**不套信封**的（成功 = 字节流 / 失败 = 信封）
 * ─────────────────────────────────────────────────────────────────────
 * ⇒ 一律走 `api/client.ts#requestBlob`（它按**响应形状**分支，失败时抛出的 `ApiError`
 * 与普通接口完全一致，页面可复用同一套错误提示与 401 收口）。**不许**自己 `fetch` 一遍
 * —— 那样"会话过期"会变成"预览区一片空白"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么 import 方向是 `api/` → `components/ArtifactPreview/artifactPreview.ts`
 * ─────────────────────────────────────────────────────────────────────
 * `子方案④` §七 1 把"两个 URL 的构造"钉在**那一个纯逻辑文件**里（那里才能进无依赖验收档，
 * 而验收里的 F 组要断言 `/api/artifacts/` 这个字符串在 `frontend/src` 下**恰好一处**）。
 * 所以本文件只负责**发请求**，URL 由它给 —— 反向（在那里 import 本文件）会让它连上
 * `api/client.ts`，那一档就跑不起来了。
 */

import { requestBlob } from './client.js'
import {
  artifactContentUrl,
  artifactDownloadUrl,
  decodeUtf8Text,
} from '../components/ArtifactPreview/artifactPreview.js'

/**
 * 取回产物的**文本**（MD / CSV / 纯文本那一路专用）。
 *
 * 两件事必须这么写：
 *   ① **先取 `arrayBuffer()` 再严格解码**：`response.text()` 是**宽松** UTF-8，
 *      非法字节变成 `U+FFFD` ⇒ 一份 GBK 的 CSV 会显示成满屏 `�`，而用户**以为表里就是这个内容**。
 *      只有严格解码才能给出"编码不是 UTF-8，请下载后用本地工具打开"这句可照做的话
 *      （`子方案④` §五 5 / §八 3）；
 *   ② **体积闸门在调用之前**：`shared` 的两个常量决定了"值不值得拉"，超过上限**根本不发请求**
 *      （否则要么白拉 50MB、要么前端自己抄一个数）。
 *
 * @returns 解码后的文本；**不是 UTF-8 时返回 `null`**（不是异常 —— 它是"换一种展示"的依据）
 * @throws {ApiError} 401 / 404（产物不存在或不是我的）/ 500
 */
export async function fetchArtifactText(
  artifactId: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const { blob } = await requestBlob(artifactContentUrl(artifactId), options)
  return decodeUtf8Text(await blob.arrayBuffer())
}

/**
 * 触发浏览器下载产物（**不走 `<a href>` 直链**：那样失败会渲染一页 JSON，
 * 见 `api/client.ts#requestBlob` 的理由）。
 *
 * ⚠️ 文件名优先用响应头的（RFC 5987 的中文名），解析不出时退回产物自己的 `fileName` ——
 * 两个来源是同一份数据，后者还是列表里正在显示的那个名字。
 */
export async function saveArtifactFile(artifact: { artifactId: string; fileName: string }): Promise<void> {
  const { blob, fileName } = await requestBlob(artifactDownloadUrl(artifact.artifactId))
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  // `file_name` 可能是容器内的相对路径（`out/report.csv`）—— 服务端已在响应头里剔除了
  // 路径分隔符（`buildContentDisposition`），这里是"解析不出来"的兜底
  anchor.download = fileName ?? artifact.fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立刻释放：blob 已被浏览器接管（下载不依赖这个 URL 活着），不释放会一直占着内存
  URL.revokeObjectURL(url)
}
