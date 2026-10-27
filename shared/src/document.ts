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
 * `PARSING` = 已入库、文件在 S3，**已入队**、等 worker 消费或正在消费（P0-1-17 起队列与 worker
 * 都已就位）；`READY` = 处理完成可检索；`FAILED` = 处理失败，`errorMsg` 是给用户看的原因
 * （如"疑似扫描件"）。`chunkCount` 默认 0 而非 null：`PARSING` 期间就是"当前有 0 个可用 chunk"
 * （schema 注释与 `子方案①` §七 的"更新中，暂不参与检索"都依赖它）。
 * 状态之间的**合法转换**见 {@link DOCUMENT_STATUS_TRANSITIONS}。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 列表与"可不可检索"的判据（P0-1-21 增量）
 * ─────────────────────────────────────────────────────────────────────
 * 列表项与上传/重建响应**共用 `documentItemSchema` 一套投影**，并补两个"给界面用的规则"：
 * {@link DOCUMENT_PARSING_HINT}（`PARSING` 态必须显式说明"暂不参与检索"）与
 * {@link isDocumentSearchable}（`READY` ⟺ 可检索）。两个都写在 shared 而不是各自写在界面里：
 * 前者是**用户看得见的一句话**（两边各写一遍必然漂），后者是一条**语义随批次变过的判据**
 * （P0-1-17 时 `READY` 只是"解析完成"，P0-1-19 起才是"可检索"）。
 */

import { z } from 'zod'

import { validationMessage } from './i18n/validation.js'

import { translate, type Locale, type MessageKey } from './i18n/index.js'
import { offsetPageOf } from './envelope.js'

/** 文档流水线状态（与 `schema.prisma` 的 `document_status` 枚举逐字一致） */
export const DOCUMENT_STATUSES = ['PARSING', 'READY', 'FAILED'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * 状态机的**唯一**定义（P0-1-17；`子方案①` §三 的"幂等/失败"两段 + schema 的枚举注释）。
 *
 * ```
 * PARSING ──→ READY      处理成功（worker 跑完全部阶段）
 * PARSING ──→ FAILED     任一步抛错（error_msg 落可读原因）
 * FAILED  ──→ PARSING    重新入队重试（重投同一 job；P0-1-19 的 /retry 复用这条）
 * READY   ──→ PARSING    覆盖重建 / 重新上传（P0-1-19 的 /reupload）
 * PARSING ──→ PARSING    同态：重复投递或重试的**起点**（清掉上次的 error_msg）
 * ```
 *
 * ⚠️ 刻意**不允许** `READY → FAILED`：那正是"一个过期 job 把已经成功的文档打回失败"的唯一形态，
 * 也是这一层最值得拦下的一种写入 —— 用户会看到"内容明明能用却报失败"，且**无法自愈**
 * （重投同一 job 会被 READY 幂等规则跳过，状态永远停在 FAILED）。
 * 同理不允许 `FAILED → READY`：跳过 PARSING 就等于跳过了"正在重试"这个可观测的中间态。
 *
 * 为什么放在 `shared` 而不是 worker 里：前端要用它决定"这个状态要不要继续轮询"，
 * 而"哪些转换合法"是契约而不是 worker 的实现细节（`docs/02` §4.6 的状态机口径）。
 */
export const DOCUMENT_STATUS_TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  PARSING: ['PARSING', 'READY', 'FAILED'],
  READY: ['PARSING'],
  FAILED: ['PARSING'],
}

/** 状态转换是否合法（`from === to` 是否算合法**随状态而定**，见上面的表） */
export function canTransitionDocumentStatus(from: DocumentStatus, to: DocumentStatus): boolean {
  return DOCUMENT_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 可上传的扩展名白名单（`子方案①` §4-1 第 1 条；P0-4-x 起并入图片格式）。
 *
 * ⚠️ 与 `.doc` 是**互斥**的两件事：`.doc` 不在白名单里，但它有**专门**的拦截分支
 * （给"请另存为 .docx 后重传"这句可读提示），不能混成一句"不支持的文件类型"。
 *
 * ⚠️ 图片格式（png/jpg/jpeg/webp/gif/bmp）只有在上传时**至少勾了一个图片选项**
 * 时才真正接受 —— 判据在服务层，见 `IMAGE_FILE_REQUIRES_MODE_HINT`。
 * 单独把扩展名放进白名单，是为了让 `.doc` 那样的"格式知识"只有一份。
 */
export const UPLOAD_EXTENSIONS = ['pdf', 'docx', 'md', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number]

/** 图片格式（= 直接上传的独立图片文件；区别于文档内的内嵌图） */
export const IMAGE_UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const
export type ImageUploadExtension = (typeof IMAGE_UPLOAD_EXTENSIONS)[number]

/** 是否是独立图片文件 */
export function isImageUploadExtension(ext: string): ext is ImageUploadExtension {
  return (IMAGE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * 文档内图片的**识别方式**（**按文档**，上传/覆盖重建时选择；`documents.image_recognize` 列）。
 *
 * 2026-10-08 由旧的三值 `ImageMode`（NONE/OCR/MULTIMODAL）重构而来。用户定案：**OCR 与大模型识别
 * 互斥**（VLM 看一张图本就reads 上面的文字，再叠一遍本地 OCR 是重复劳动），故"怎么识别"是**三选一**：
 *   · `NONE` —— 不识别图片（可与"图片向量化"组合，即只向量化不产文字）；
 *   · `OCR`  —— **图片文字识别**：本地 OCR 出图上文字（`pipeline/ocr.ts`，离线、无依赖）；
 *   · `LLM`  —— **图片含义识别**：用该库选定的「图片描述模型」生成含义/描述（P1-11，VLM）。
 *
 * 与**图片向量化**（{@link DocumentImageOptions.imageVectorize}）**正交**：识别产出**文本块**，
 * 向量化产出**图片块**，可各自独立开关（含"只识别不向量化""只向量化不识别"）。
 */
export const IMAGE_RECOGNITIONS = ['NONE', 'OCR', 'LLM'] as const
export type ImageRecognition = (typeof IMAGE_RECOGNITIONS)[number]

/** 默认识别方式（与 `documents.image_recognize` 的 DB 默认值一致） */
export const DEFAULT_IMAGE_RECOGNITION: ImageRecognition = 'NONE'

/** 界面展示用的中文标签（前后端共用同一份，避免两边各写一遍漂移） */
export const IMAGE_RECOGNITION_LABELS: Readonly<Record<ImageRecognition, string>> = Object.freeze({
  NONE: '不识别图片',
  OCR: '图片文字识别（本地 OCR）',
  LLM: '图片含义识别（大模型）',
})

/**
 * 识别方式 → i18n key（P1-23：前端据此取译文；**中文那份 {@link IMAGE_RECOGNITION_LABELS} 保留**
 * 给后端与其它中文消费方用，见 `子方案/界面语言切换.md` §3.5）。
 */
export const IMAGE_RECOGNITION_KEY: Readonly<Record<ImageRecognition, MessageKey>> = Object.freeze({
  NONE: 'label.imageRecognition.NONE',
  OCR: 'label.imageRecognition.OCR',
  LLM: 'label.imageRecognition.LLM',
})

/** 文档内图片的处理选项：识别方式（三选一）+ 是否向量化 */
export interface DocumentImageOptions {
  imageRecognize: ImageRecognition
  imageVectorize: boolean
}

/** 默认：不识别 + 不向量化（= 不处理图片，与旧 `NONE` 一致） */
export const DEFAULT_DOCUMENT_IMAGE_OPTIONS: DocumentImageOptions = Object.freeze({
  imageRecognize: DEFAULT_IMAGE_RECOGNITION,
  imageVectorize: false,
})

/** 上传/覆盖重建时携带图片选项的 multipart 字段名（与文件字段 `file` 并列） */
export const UPLOAD_IMAGE_RECOGNIZE_FIELD = 'imageRecognize'
export const UPLOAD_IMAGE_VECTORIZE_FIELD = 'imageVectorize'

/** 图片向量化选项的展示标签（识别方式的标签见 {@link IMAGE_RECOGNITION_LABELS}） */
export const IMAGE_VECTORIZE_LABEL = '图片向量化（多模态）'

/** 图片向量化选项的 i18n key（P1-23：前端据此取译文；中文那份 {@link IMAGE_VECTORIZE_LABEL} 保留） */
export const IMAGE_VECTORIZE_KEY: MessageKey = 'label.imageVectorize'

/** 是否至少选了一种图片处理（独立图片文件必须为 true；全不选 = 不处理图片） */
export function hasAnyImageOption(options: DocumentImageOptions): boolean {
  return options.imageRecognize !== 'NONE' || options.imageVectorize
}

/** 人读的一句话，列出这篇文档的图片处理（文档表格里显示；全不选返回空串） */
export function describeImageOptions(options: DocumentImageOptions, locale: Locale): string {
  const parts: string[] = []
  if (options.imageRecognize === 'OCR') parts.push(translate(locale, 'label.imageOption.ocr'))
  else if (options.imageRecognize === 'LLM') parts.push(translate(locale, 'label.imageOption.llm'))
  if (options.imageVectorize) parts.push(translate(locale, 'label.imageOption.vectorize'))
  return parts.join(translate(locale, 'label.imageOption.join'))
}

/**
 * 上传了独立图片文件、但既没选识别方式也没开向量化时的提示。
 *
 * 与 `LEGACY_DOC_HINT` 同款：**前后端共用同一句**，且它必须是"用户的下一步动作"
 * （回上传弹窗至少选一项），而不是一句笼统的"不支持"。
 */
export const IMAGE_FILE_REQUIRES_MODE_HINT =
  '图片文件需要在上传时至少选择一种图片处理方式（图片文字识别 / 图片含义识别 / 图片向量化）'

/**
 * 勾了"图片向量化"、但知识库所选 embedding 模型不支持多模态时的提示。
 *
 * 依赖 `/embeddings/multimodal` 端点，只有模型池里标了 `embeddingMultimodal` 的向量模型才有；
 * 用错模型时**宁可当场拒绝**，也不要等流水线跑完才发现图片进不了向量空间。
 */
export const MULTIMODAL_MODEL_REQUIRED_HINT =
  '当前知识库使用的 embedding 模型不支持多模态，无法对图片做"图片向量化"；请关闭该选项，或把知识库换成支持多模态的向量模型后重建'

/**
 * 勾了"图片含义识别"、但该知识库没有选「图片描述模型」时的提示。
 *
 * 含义识别的模型是**知识库级**配置（建/改库时选一个支持视觉的对话模型）；没选就该当场拒绝，
 * 否则用户以为识别开了、结果什么都没产出。
 */
export const IMAGE_DESCRIBE_MODEL_REQUIRED_HINT =
  '当前知识库未选择「图片描述模型」，无法做"图片含义识别"；请到知识库编辑里选一个支持图片的对话模型，或关闭该选项'

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
  // 图片：浏览器对同一张 jpg 可能报 image/jpeg 或 image/jpg，两者都放行
  png: ['image/png'],
  jpg: ['image/jpeg', 'image/jpg'],
  jpeg: ['image/jpeg', 'image/jpg'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
}

/**
 * 对话附件**额外**支持的纯文本格式（**P1-4 补 · 2026-10-01**）：`json` / `csv`。
 *
 * ⚠️ **刻意不进 `UPLOAD_EXTENSIONS`**：那是**知识库文档**的白名单（含其解析流水线能力），
 * 知识库格式已被需求收窄为 pdf/docx/md/txt（连 `.doc` 都拒绝）—— 把 json/csv 混进去会
 * 让知识库也放行它，而流水线没有为它们做结构性解析。对话附件是另一条链路（文本解析注入），
 * 故它有自己的白名单（见后端 `pipeline/parse` 的 `CHAT_ATTACHMENT_FORMAT_PROFILE`）。
 */
export const CHAT_ATTACHMENT_TEXT_EXTENSIONS = ['json', 'csv'] as const
export type ChatAttachmentTextExtension = (typeof CHAT_ATTACHMENT_TEXT_EXTENSIONS)[number]

/** 对话附件的完整扩展名白名单 = 文档白名单 + {@link CHAT_ATTACHMENT_TEXT_EXTENSIONS} */
export const CHAT_ATTACHMENT_EXTENSIONS = [...UPLOAD_EXTENSIONS, ...CHAT_ATTACHMENT_TEXT_EXTENSIONS] as const
export type ChatAttachmentExtension = (typeof CHAT_ATTACHMENT_EXTENSIONS)[number]

/**
 * 对话附件的「扩展名 → 允许声明的 MIME」表（第三道校验用；`application/octet-stream` 一律放行）。
 *
 * `json` / `csv` 都放行 `text/plain`：不少系统（含部分浏览器 / 代理）会把它们报成 plain text，
 * 那**不是**矛盾声明（真正能抓住"改名"的是文件头与扩展名，而不是声明）。
 */
export const MIME_BY_CHAT_ATTACHMENT_EXTENSION: Readonly<Record<ChatAttachmentExtension, readonly string[]>> = {
  ...MIME_BY_EXTENSION,
  json: ['application/json', 'text/json', 'text/plain'],
  csv: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
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
  /** 图片识别方式（三选一：不识别 / 本地 OCR / 大模型含义；上传/覆盖重建时选定） */
  imageRecognize: z.enum(IMAGE_RECOGNITIONS),
  /** 图片向量化（多模态；与识别方式正交，可独立开关） */
  imageVectorize: z.boolean(),
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

/** 路径参数：`:id` = 知识库，`:docId` = 文档（reupload/retry/delete/download 共用） */
export const documentParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.document.kbIdNotUuid')),
  docId: z.string().uuid(validationMessage('validation.document.docIdNotUuid')),
})
export type DocumentParams = z.infer<typeof documentParamsSchema>

// ───────────────────────────── 重命名文件名（2026-10-16）─────────────────────────────

/**
 * 文档文件名的长度上限（列 `documents.file_name` 是 `VARCHAR(255)`）—— 前端输入框与校验共用。
 */
export const DOCUMENT_FILE_NAME_MAX_CHARS = 255

/**
 * `PATCH /api/knowledge-bases/:id/documents/:docId` 请求体：给这篇文档**换个展示名**。
 *
 * ── 它只改 `file_name`，不碰任何内容 ──
 * `documents.file_name` 在本仓只承担两件事：列表页的展示名，以及下载端点的
 * `Content-Disposition` 文件名（见 `document.service.ts#openDocumentSource`）。重命名**不动**
 * `file_key`（S3 对象）、`content_hash`、chunk —— 也就是"内容一个字节都没变，只是换个名字"。
 *
 * ⚠️ **扩展名必须保持不变**（服务层判、给 400）：下载/预览的 `Content-Type` 是按**文件名里的扩展名**
 * 推出来的（`downloadContentType`），而真实字节没变 —— 把 `报告.pdf` 改成 `报告.txt` 会让下载
 * 声明的类型与内容对不上。所以这里只接受"改基名"。
 */
export const renameDocumentBodySchema = z.object({
  fileName: z
    .string({ required_error: validationMessage('validation.document.fileNameRequired') })
    .trim()
    .min(1, validationMessage('validation.document.fileNameEmpty'))
    .max(
      DOCUMENT_FILE_NAME_MAX_CHARS,
      validationMessage('validation.document.fileNameTooLong', { max: DOCUMENT_FILE_NAME_MAX_CHARS }),
    ),
})
export type RenameDocumentBody = z.infer<typeof renameDocumentBodySchema>

// ───────────────────────────── 覆盖重建 / 重试 / 删除（P0-1-19）─────────────────────────────

/**
 * 覆盖重建命中"内容没变"时的提示（`子方案①` §七 的原文）。
 *
 * 与 `LEGACY_DOC_HINT` 同款理由：**前端与后端共用同一句**，避免两边文案漂移 ——
 * 这条提示是"用户的下一步动作"（要么别传了，要么去改内容），措辞漂了就会让人以为是两种问题。
 * 用常量而不是把它塞进响应体的 `message` 字段：本仓的"文案→界面"一直走 shared 常量
 * （`DEFAULT_MESSAGE_BY_ERROR_CODE` 是同一套路），响应体里放一段中文等于给文案开了第二个出口。
 */
export const REUPLOAD_UNCHANGED_HINT = '内容未变化，已跳过'

/**
 * `POST /api/knowledge-bases/:id/documents/:docId/reupload` 的响应。
 *
 * 与上传响应刻意用**不同的字段名**（`unchanged` vs `deduplicated`），因为两者回答的问题不同：
 * · 上传的 `deduplicated`：库里**已有**同样内容 ⇒ 这次没有产生新文档（也是上传端点的判重分支）；
 * · 重建的 `unchanged`：**这一篇文档**的内容没变 ⇒ 没触发流水线、没换对象、没动 chunk。
 * 复用同一个字段名会让"传了个新文档但内容与另一个文档相同"与"重建时内容没改"混成一种形状。
 *
 * `unchanged=true` 时：**不落新 S3 对象、不删旧 chunk、不入队** —— 三个"没做"都是刻意的
 * （`子方案①` §七："视为用户误操作，直接返回 200"）。"没做"的证据在验收里逐条取证。
 */
export const reuploadDocumentResultSchema = z.object({
  document: documentItemSchema,
  unchanged: z.boolean(),
})
export type ReuploadDocumentResult = z.infer<typeof reuploadDocumentResultSchema>

/**
 * `POST /api/knowledge-bases/:id/documents/:docId/retry` 的响应。
 *
 * 只回一条文档（`status` 必为 `PARSING`）：重试**不做**同步处理，只是重新入队 ——
 * 与上传同款（`子方案①` §三 的"登记/入队"与"处理"分离）。
 *
 * ⚠️ 状态守卫在服务层：`READY`（没东西可重试）与 `PARSING`（已经在处理中）都返回 **409**
 * 而不是"装作入队成功"—— 后者会让用户在界面上看到一个永远不动的"正在重试"。
 */
export const retryDocumentResultSchema = z.object({
  document: documentItemSchema,
})
export type RetryDocumentResult = z.infer<typeof retryDocumentResultSchema>

/**
 * `DELETE /api/knowledge-bases/:id/documents/:docId` 的响应。
 *
 * 带上 `deletedChunks`：删除会连带清掉 chunk（外键 CASCADE）与 S3 原文件，
 * 只回 `ok` 会让调用方无从给一个有信息量的提示（与删库回 `deletedDocuments` 同款口径）。
 */
export const removeDocumentResultSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  /** 连带删除的 chunk 数（DB 侧 CASCADE 的结果，删前先数） */
  deletedChunks: z.number().int().min(0),
})
export type RemoveDocumentResult = z.infer<typeof removeDocumentResultSchema>

// ───────────────────────────── 列表 / 下载（P0-1-21，包 D 收口）─────────────────────────────

/**
 * `GET /api/knowledge-bases/:id/documents` 查询参数（offset/limit，与 `/api/users`、
 * `/api/knowledge-bases` 同口径）。
 *
 * 上限 100 与其余列表一致：那是"一屏看不过来的量"，真要看更多就该翻页 ——
 * 知识库的文档数是千级（`01` §1.3 的规模假设），没有"一次拉全"的需求。
 */
export const listDocumentsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
})
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>

/**
 * 列表响应：`{ items, total, offset, limit }`，每项与上传/重建响应里的 `document` **同一套投影**
 * （`documentItemSchema`）—— 同一份数据在四个出口出现四种形状，是前端最容易踩的坑。
 */
export const documentListResultSchema = offsetPageOf(documentItemSchema)
export type DocumentListResult = z.infer<typeof documentListResultSchema>

// ───────────────────────────── 文档片段（chunk）预览（P0-1-35 增量）─────────────────────────────

/**
 * 文档的一个片段（`chunks` 表的一行，投影给"块内容预览"用）。
 *
 * ── 为什么单开一个端点/投影，而不是复用检索结果 ──
 * `retrievalHitSchema` 的 `snippet` 是**命中位置附近的原文窗口**（`buildSnippet`），不是整块原文，
 * 而且只返回 topK 条 —— 它回答的是"这次查询命中了什么"，回答不了"这篇文档被切成了哪些块"。
 * 预览要的是**按 `seq` 顺序的完整块**，语义不同，故不能复用。
 *
 * ── 逐字段的取值口径 ──
 * · `seq`：块在文档内的序号（0 起，`chunks` 表的口径），预览里就是"第几块"；
 * · `content`：整块原文（**不加工、不截断**）—— 预览的价值就是让人核对切分是否合理；
 * · `page` / `headingPath`：来自 `chunks.meta`，缺键的历史行回落 `null` / `[]`
 *   （读取口径见后端 `retrieval.ts#parseChunkMeta`，两处必须是同一份兜底）。
 *
 * ⚠️ **刻意不含 `embedding`**：它是 1024 维向量（数千字符的字符串），预览页用不上，
 * 放进列表响应会让一页 20 条变成几百 KB 的无用载荷。
 */
export const chunkItemSchema = z.object({
  /** `chunks.id`（uuid(7)） */
  id: z.string(),
  docId: z.string(),
  /** 块在文档内的序号（从 0 开始） */
  seq: z.number().int().min(0),
  /** 整块原文（不加工、不截断） */
  content: z.string(),
  /** `meta.page`：PDF 才有页码，其余为 `null` */
  page: z.number().int().nullable(),
  /** `meta.headingPath`：块所属的标题层级（无标题层级的格式为 `[]`） */
  headingPath: z.array(z.string()),
})
export type ChunkItem = z.infer<typeof chunkItemSchema>

/**
 * `GET /api/knowledge-bases/:id/documents/:docId/chunks` 查询参数（与文档列表同口径）。
 *
 * 默认 `limit` **比文档列表小**（20 而不是它的一次取满 100）：一个块的内容可能上千字符，
 * 一屏看不了几条；而 `total` 会如实给出，前端据此分页。上限仍是 100（与其余列表一致）。
 */
export const listDocumentChunksQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
})
export type ListDocumentChunksQuery = z.infer<typeof listDocumentChunksQuerySchema>

/** 片段列表响应：`{ items, total, offset, limit }`（与文档列表同一套分页形状） */
export const documentChunkListResultSchema = offsetPageOf(chunkItemSchema)
export type DocumentChunkListResult = z.infer<typeof documentChunkListResultSchema>

/**
 * `PARSING` 态在列表里的提示文案（`子方案①` §七 → `06` P0-1-19 的坑预判：**必须做**）。
 *
 * 为什么这句话不能省：`§七` 的"先删后建"意味着**一段检索空窗**（窗口 = 一次流水线耗时，
 * 大 PDF 可达分钟级）—— 这期间该文档的 `chunk_count` 是 0，检索自然不返回它，**不报错、只是查不到**。
 * 列表页不显式提示的话，用户看到的是"文档明明在、就是搜不到"，而这条从任何报错里都推不出来。
 *
 * 与 `LEGACY_DOC_HINT` / `REUPLOAD_UNCHANGED_HINT` 同款：**前后端共用同一句**，
 * 免得两边文案各写一遍、漂了之后被当成两种问题。
 */
export const DOCUMENT_PARSING_HINT = '更新中，暂不参与检索'

/**
 * 这篇文档**能不能被检索到**（列表页据此把不可检索的行置灰/加提示）。
 *
 * 判据就是 `READY`：P0-1-19 起流水线的八步全过才置 `READY`，而 `chunk_count` 是同一个事务里
 * 写入的真数 ⇒ **`READY` ⟺ 库里有带向量的 chunk**。
 *   · `PARSING`：我们还在干活（可能正处在检索空窗里，见 {@link DOCUMENT_PARSING_HINT}）；
 *   · `FAILED`：要人介入 —— **与 `PARSING` 必须用不同的样式**（一个"别急"、一个"要你处理"，
 *     混成一种"失败"会让用户去重试一件其实正在正常进行的事）。
 *
 * 写成 shared 的纯函数而不是让前端各处写 `status === 'READY'`：这条判据的语义变过一次
 * （P0-1-17 时 `READY` 只是"解析完成"），散落的字面量比较会在语义再变时漏掉。
 */
export function isDocumentSearchable(status: DocumentStatus): boolean {
  return status === 'READY'
}

