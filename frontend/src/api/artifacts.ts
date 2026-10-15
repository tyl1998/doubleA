/**
 * 产物接口封装（P0-3-10：**预览取文本 + 触发下载**；P0-3-11：补**产物列表**）
 *
 * 依据：`docs/02-后端设计.md` §4.8（`/api/artifacts/:id/content` 与 `/download`）、§4.9（不套信封）、
 *      `docs/子方案/文件预览.md` §三/§四（两条出口、后端代理）、`docs/03-前端设计.md` §4.6
 *      + §4.1（TaskAgent 的产物面板）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 两条端点是**不套信封**的（成功 = 字节流 / 失败 = 信封），列表那条**套信封**
 * ─────────────────────────────────────────────────────────────────────
 * 下载与预览一律走 `api/client.ts#requestBlob`（它按**响应形状**分支，失败时抛出的 `ApiError`
 * 与普通接口完全一致，页面可复用同一套错误提示与 401 收口）。**不许**自己 `fetch` 一遍
 * —— 那样"会话过期"会变成"预览区一片空白"。
 * 产物**列表**（P0-3-11 接回）是标准的 `{items,total,offset,limit}` 信封 ⇒ 走 `request`，
 * 与其余列表同款。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么 import 方向是 `api/` → `components/ArtifactPreview/artifactPreview.ts`
 * ─────────────────────────────────────────────────────────────────────
 * `子方案④` §七 1 把"两个 URL 的构造"钉在**那一个纯逻辑文件**里（那里才能进无依赖验收档，
 * 而验收里的 F 组要断言 `/api/artifacts/` 这个字符串在 `frontend/src` 下**恰好一处**）。
 * 所以本文件只负责**发请求**，URL 由它给 —— 反向（在那里 import 本文件）会让它连上
 * `api/client.ts`，那一档就跑不起来了。
 * ⚠️ 产物**列表**的路径是 `/api/conversations/:id/artifacts`（会话作用域），
 * 它**不是** `/api/artifacts/` 那个前缀 —— 所以 F 组那条断言（"恰好一处"）不受影响，
 * 这里可以放心写出完整路径。
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query'

import type { ArtifactListResult, BatchDeleteArtifactsResult } from '@doubulea/shared'

import { request, requestBlob } from './client.js'
import {
  artifactBatchDeleteUrl,
  artifactContentUrl,
  artifactDeleteUrl,
  artifactDownloadUrl,
  artifactsCollectionUrl,
  decodeUtf8Text,
} from '../components/ArtifactPreview/artifactPreview.js'

// ───────────────────────────── 产物列表（P0-3-11） ─────────────────────────────

/**
 * 面板一次取多少条。
 *
 * 与侧栏会话列表同口径：**一次取满 100 + 客户端不再分页**（`ARTIFACT_PAGE_LIMIT_MAX`）。
 * 面板是一列滚动清单，为它接一套分页会引出"翻页时用户滚到哪儿"这个凭空的问题；
 * 超过 100 个产物时第 100 条之后看不到 —— 这是**写明的边界**（`artifactPanelModel.ts` 的
 * `artifactPanelOverflowNote` 会把它如实说出来），不是漏了。
 */
export const ARTIFACTS_PAGE_LIMIT = 100

/**
 * 产物列表的缓存键。
 *
 * ⚠️ 与消息历史（`['conversation', id]`）**共前缀**不是巧合：两者都随"这个会话又跑了一轮"
 * 而变，共用前缀 ⇒ `useChatStream` 收尾时一次失效两处（见那里的 `finally`）。
 * 若它们各用一个不相干的前缀，就得在每个"这一轮落库了"的地方记得失效两次 —— 迟早漏一个，
 * 症状是"消息更新了、面板还是旧的"。
 */
export function conversationArtifactsQueryKey(conversationId: string): readonly [string, string, string] {
  return ['conversation', conversationId, 'artifacts'] as const
}

/** 取一页产物（`created_at desc`，最新在前 —— 顺序由服务端定，前端一列都不动） */
export function fetchConversationArtifacts(conversationId: string, limit: number): Promise<ArtifactListResult> {
  const search = new URLSearchParams({ offset: '0', limit: String(limit) })
  return request<ArtifactListResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/artifacts?${search.toString()}`,
  )
}

/**
 * 产物列表（面板那一列的唯一数据来源）。
 *
 * `conversationId === undefined`（新会话态）**不发请求** —— 那时还没有会话，
 * 打出去只会是一个 400/404。
 *
 * `keepPreviousData`：切走再切回时面板**不会闪成空白**（与侧栏列表同款理由）。
 * ⚠️ **但它只在"两个都有会话"之间保持**：新建会话态（`conversationId === undefined`）必须
 * **关掉它**（`placeholderData: undefined`）—— 否则它会把**上一个会话**的产物一直顶在面板里
 * （`TaskAgent 记忆与产物` 问题 2：新建会话后仍显示旧会话产物；`enabled:false` 只让查询
 * 停发请求，`keepPreviousData` 照样把旧数据喂给渲染）。这是在 `undefined` 与"切换会话"
 * 之间**刻意区分**：前者是"没有这个列表"，后者才是"上一个列表还在加载"。
 *
 * ⚠️ 它是**"刷新后产物还在"的唯一出口**：`artifact` 事件只发一次、历史消息里的
 * `content.artifacts` 只覆盖那一轮（`messageModel.ts` 的 `messageToView` 刻意返回 `[]`）。
 * 所以关掉它等于"刷新页面之后产物面板空掉"，而那不是真的。
 */
export function useConversationArtifacts(conversationId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: conversationArtifactsQueryKey(conversationId ?? ''),
    queryFn: () => fetchConversationArtifacts(conversationId ?? '', ARTIFACTS_PAGE_LIMIT),
    enabled: enabled && conversationId !== undefined,
    // 新会话态（无 id）不给 placeholder：见上方那条 ⚠️（问题 2 的修复点）
    placeholderData: conversationId === undefined ? undefined : keepPreviousData,
  })
}

// ───────────────────── 会话产物（跨会话汇总本人全部产物） ─────────────────────

/**
 * 会话产物列表的缓存键。
 *
 * ⚠️ 与 `['conversation', …]` **刻意不同前缀**：会话产物是**用户作用域**的
 * （`userId = me`），不随某一个会话的流变化；用会话前缀会让"这一轮跑完"顺手失效一份
 * 与它无关的列表。
 * ⚠️ `offset` 进键：分页是服务端做的，翻到第 2 页就该是另一次查询（与面板"一次取满"不同）。
 */
export function myArtifactsQueryKey(offset: number, limit: number): readonly [string, string, number, number] {
  return ['artifacts', 'collection', offset, limit] as const
}

/** 取一页会话产物（`GET /api/artifacts`，`created_at desc`） */
export function fetchMyArtifacts(offset: number, limit: number): Promise<ArtifactListResult> {
  return request<ArtifactListResult>(artifactsCollectionUrl(offset, limit))
}

/**
 * 会话产物列表（**仅本人**：服务端按 `user_id` 过滤，前端不需要、也无法指定别人的）。
 *
 * `keepPreviousData`：翻页时上一页的卡片先留着（不闪白），与侧栏列表同款。
 */
export function useMyArtifacts(offset: number, limit: number) {
  return useQuery({
    queryKey: myArtifactsQueryKey(offset, limit),
    queryFn: () => fetchMyArtifacts(offset, limit),
    placeholderData: keepPreviousData,
  })
}

/**
 * 删除一个产物（`DELETE /api/artifacts/:id`，**真删除**：S3 对象与行一并移除）。
 *
 * 失败（404 不是我的 / 500 存储不可用）与其余接口同款抛 `ApiError`，
 * 由调用方（会话产物页）复用统一的错误提示。
 */
export function deleteArtifact(artifactId: string): Promise<null> {
  return request<null>(artifactDeleteUrl(artifactId), { method: 'DELETE' })
}

/**
 * 批量删除产物（`POST /api/artifacts/batch-delete`，**真删除**：S3 对象与行一并移除）。
 *
 * ⚠️ **用 POST 而不是带 body 的 DELETE**（见 `shared#batchDeleteArtifactsBodySchema`）：
 * 一部分代理会丢掉 DELETE 的 body，那样就是"删了 0 个却报成功"的静默失败。
 *
 * 服务端会按 `userId = me` 过滤：**返回的 `deleted` 是实际删掉的行数**，可能小于
 * `ids.length`（混进"不是我的"或"已不存在"的会被如实扣掉）—— 界面据此报数，别照勾选数报。
 *
 * 失败（401 / 400 参数非法 / 500 存储不可用）与其余接口同款抛 `ApiError`。
 */
export function deleteArtifacts(artifactIds: string[]): Promise<BatchDeleteArtifactsResult> {
  return request<BatchDeleteArtifactsResult>(artifactBatchDeleteUrl(), {
    method: 'POST',
    body: { ids: artifactIds },
  })
}

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
