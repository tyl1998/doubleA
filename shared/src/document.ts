/**
 * 文档契约（P0-1-16；`02` §4.6 + `子方案/知识库流水线.md` §4-1/§三/§七）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 上传的"四道前置校验"里有两道在这里定案（白名单 + 扩展名/格式的对应）
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §4-1 的四道校验是：① 扩展名白名单 ② `.doc` 直接拒绝 ③ MIME 与扩展名交叉校验
 * ④ 大小 ≤ `UPLOAD_BODY_LIMIT`。本文件承载"格式知识"（哪些扩展名、哪些 MIME 算合法），
 * 后端 `pipeline/parse/index.ts` 承载"判定逻辑"（扩展名 + MIME + **文件头魔数**三重比对），
 * 前端 `accept` 白名单也读这里 —— 三处的"白名单"必须是同一份，否则 "前端能选、后端拒收"
 * 这类矛盾会反复出现。
 *
 * ⚠️ **为什么还要看魔数（文档只说 MIME）**：MIME 是**客户端声明**的，把 `a.txt` 改名成
 * `a.pdf` 后浏览器照样声明 `application/pdf` —— 单靠"MIME vs 扩展名"这一对**抓不到改名**。
 * 真正能抓住的是"文件头字节与扩展名不符"，故本批在文档要求的 MIME 交叉校验之外，
 * 补了魔数比对（P0-1-16 落地要点，验收里有一条"改名的假 PDF 被拦下"正是盯它）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② `status` 是**流水线状态机**的投影，不是"有没有文件"
 * ─────────────────────────────────────────────────────────────────────
 * `PARSING` = 已入库、文件在 S3，**等 worker 消费**（P0-1-17）；`READY` = chunk 已入库可检索；
 * `FAILED` = 解析/入库失败，`errorMsg` 是给用户看的原因（如"疑似扫描件"）。
 * `chunkCount` 默认 0 而非 null：`PARSING` 期间就是"当前有 0 个可用 chunk"
 * （schema 注释与 `子方案①` §七 的"更新中，暂不参与检索"都依赖它）。
 */

import { z } from 'zod'

/** 文档流水线状态（与 `schema.prisma` 的 `document_status` 枚举逐字一致） */
export const DOCUMENT_STATUSES = ['PARSING', 'READY', 'FAILED'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * 可上传的扩展名白名单（`子方案①` §4-1 第 1 条）。
 * ⚠️ 与 `.doc` 是**互斥**的两件事：`.doc` 不在白名单里，但它有**专门**的拦截分支
 * （给"请另存为 .docx 后重传"这句可读提示），不能混成一句"不支持的文件类型"。
 */
export const UPLOAD_EXTENSIONS = ['pdf', 'docx', 'md', 'txt'] as const
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number]

/** 旧版 Word 二进制格式（决策 10：**不做解析**，直接拒绝并给可操作提示） */
export const LEGACY_DOC_EXTENSION = 'doc'

/** 拒收 `.doc` 时的提示（前端与后端**共用同一句**，避免两边文案漂移） */
export const LEGACY_DOC_HINT = '请另存为 .docx 后重传'

/**
 * multipart 里文件字段名（`02` §4.6 只写了"multipart"，没定字段名 —— 本批定案并回写文档）。
 * 契约：**只接受一个文件字段** `file`，多文件/缺文件都按 400 处理。
 */
export const UPLOAD_FILE_FIELD = 'file'

/** 扩展名 → 允许的声明 MIME（第三道校验；`application/octet-stream` 一律放行，见后端注释） */
export const MIME_BY_EXTENSION: Readonly<Record<UploadExtension, readonly string[]>> = {
  pdf: ['application/pdf', 'application/x-pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  txt: ['text/plain'],
}

/** 文档列表项 / 上传响应里的文档对象（`GET .../documents` 是 P0-1-21，**同一套投影**） */
export const documentItemSchema = z.object({
  id: z.string(),
  kbId: z.string(),
  /** 用户上传时的原始文件名（用于展示与下载时的 Content-Disposition） */
  fileName: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  /** 已入库的 chunk 数；非 `READY` 时为 0（见文件头 ②） */
  chunkCount: z.number().int().min(0),
  /** 仅 `FAILED` 时有值，内容是可直接展示给用户的中文原因 */
  errorMsg: z.string().nullable(),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DocumentItem = z.infer<typeof documentItemSchema>

/**
 * `POST /api/knowledge-bases/:id/documents` 的响应。
 *
 * `deduplicated` = `true` 表示**同库内已有内容完全相同的文档**（`content_hash` 命中），
 * 此时**不新建 documents 行**、返回的是已有那一条（`子方案①` §4-1 第 4 条：
 * "同 KB 内 content_hash 已存在 → 走覆盖重建分支（§七），不新建文档行"）。
 * 用布尔而不是"直接返回已有文档"是因为调用方需要知道**这次到底有没有产生新文档** ——
 * 否则前端会以为上传成功并新建了一条，随后在列表里找不到"新"文档。
 *
 * ⚠️ P0-1-16 只做到"命中就不新建"；命中的完整语义（清旧 chunk、按新文件重跑、
 * 或"内容未变化，已跳过"）属 P0-1-19 的 `reupload` 端点，届时扩展本契约。
 */
export const uploadDocumentResultSchema = z.object({
  document: documentItemSchema,
  deduplicated: z.boolean(),
})
export type UploadDocumentResult = z.infer<typeof uploadDocumentResultSchema>

/** 路径参数：`:id` = 知识库，`:docId` = 文档（后续 reupload/retry/delete/download 共用） */
export const documentParamsSchema = z.object({
  id: z.string().uuid('知识库 ID 不是合法 UUID'),
  docId: z.string().uuid('文档 ID 不是合法 UUID'),
})
export type DocumentParams = z.infer<typeof documentParamsSchema>
