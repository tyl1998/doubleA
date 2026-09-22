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

/** 路径参数：`:id` = 知识库，`:docId` = 文档（reupload/retry/delete/download 共用） */
export const documentParamsSchema = z.object({
  id: z.string().uuid('知识库 ID 不是合法 UUID'),
  docId: z.string().uuid('文档 ID 不是合法 UUID'),
})
export type DocumentParams = z.infer<typeof documentParamsSchema>

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
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>

/**
 * 列表响应：`{ items, total, offset, limit }`，每项与上传/重建响应里的 `document` **同一套投影**
 * （`documentItemSchema`）—— 同一份数据在四个出口出现四种形状，是前端最容易踩的坑。
 */
export const documentListResultSchema = offsetPageOf(documentItemSchema)
export type DocumentListResult = z.infer<typeof documentListResultSchema>

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

