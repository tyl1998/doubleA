/**
 * 文件附件接口封装（**P1-4**）
 *
 * 依据：`02` §四（`POST /api/files/upload`）、`shared#attachmentItemSchema`、`01` §3.4 需求 35。
 *
 * 两条出口：
 *   · {@link uploadChatFile} —— 上传一个附件，返回 `AttachmentItem`（发消息时只传 `fileId`）；
 *   · {@link fileContentUrl} —— 附件取内容的地址（**只给 `<img src>` 用**，见 `api/client.ts#apiUrl`）。
 *
 * ⚠️ 上传复用 `requestFormData`（与知识库文档上传同一条路）：`content-type` 必须由浏览器自己带
 * `boundary`，**绝不能让调用方手工设** —— 手设会得到一个"服务端说不是 multipart"的 400。
 */

import type { AttachmentItem } from '@doubulea/shared'

import { apiUrl, requestFormData } from './client.js'

/**
 * 上传单个附件。`file` 由输入区的 `<input type="file">` 给出。
 *
 * 失败（不支持的格式 / `.doc` / 超过体积上限 413）都是标准信封 ⇒ `ApiError`，
 * 由调用方按统一反馈通道提示（`app/feedback.ts`）。
 */
export function uploadChatFile(file: File): Promise<AttachmentItem> {
  const form = new FormData()
  form.append('file', file, file.name)
  return requestFormData<AttachmentItem>('/api/files/upload', form)
}

/** 附件取内容的地址（渲染图片用；登录 Cookie 由浏览器自动带上） */
export function fileContentUrl(fileId: string): string {
  return apiUrl(`/api/files/${encodeURIComponent(fileId)}/content`)
}
