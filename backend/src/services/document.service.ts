/**
 * 文档服务（P0-1-16 起；P0-1-17 补入队）
 *
 * 依据：`docs/02-后端设计.md` §4.6（上传端点）+ `子方案/知识库流水线.md` §三（流水线总览）、
 *      §4-1（四格式 + 上传前置校验）、§七（覆盖重建的判重语义）、§十（队列）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本服务做到"入库登记 + 原文件落 S3 + **入队**"，解析在 worker 里
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §三 的流程是「① 入库登记 → ② 入队 → worker 消费」。P0-1-16 落了 ①，
 * **P0-1-17 补上 ②**（`pipeline/queue.ts`）；真正的处理在 `pipeline/worker.ts` + `stages.ts`。
 * 上传端点**刻意不同步解析**：大 PDF 的解析 + 向量化是分钟级的，挂在 HTTP 请求里会把上传变成
 * "转圈几分钟"，而 §十 引入队列正是为了解决它。所以响应里的 `status` 恒为 `PARSING`，
 * 想知道结果得看列表接口（P0-1-21）或直接查库。
 *
 * ⚠️ ① 与 ② 是**同一件事的两半**：入队失败必须把 ① 一起撤掉，否则留下"永远转圈且重传无救"
 *   的文档 —— 见 `rollbackRegistration` 的注释。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 顺序：**先 S3、再落库、最后入队**（与"删库"正好相反）
 * ─────────────────────────────────────────────────────────────────────
 * 删库是"先 DB 后 S3"（见 `kb.service.ts` 文件头 ⑤），理由是"库还在但文件没了"比
 * "文件还在但库没了"坏。上传这一侧对称地反过来：
 * · 若"先落库再传 S3"，一旦 S3 失败就留下一条 `PARSING` 的文档行**而它的文件不存在** ——
 *   worker 取到它会报一个与根因无关的错（"文件读不到"），用户看到的却是"上传成功"，
 *   且这条行永远不会自愈（重传会被判重命中而跳过）。
 * · 若"先传 S3 再落库"，落库失败时只是**多了一个无人引用的对象**（存储垃圾，可清理）
 *   —— 而且这里还顺手做了补偿删除，连垃圾都不留。
 * 入队放在**最后**：它失败时前面两步的产物都还在手边（行 id 与对象名），一次回滚就能全撤掉。
 *
 * ─────────────────────────────────────────────────────────────────────
 * S3 键的形状：`kb/{kbId}/{随机段}/source.{ext}`
 * ─────────────────────────────────────────────────────────────────────
 * · **不用原始文件名**：文件名里的空格/emoji/路径分隔符在不同 SDK 与网关上的转义行为不一致，
 *   而它唯一的作用是"给人看" —— 那就让 `documents.file_name` 承担展示与下载命名
 *   （P0-1-21 的下载端点用 `Content-Disposition` 还原原名），S3 键只求稳定可定位。
 * · **随机段与 `docId` 无关**（用 `randomUUID()` 的 v4，不是文档主键）：这样"写 S3"就不需要
 *   提前知道文档 id（`documents.file_key` 这一列的存在意义正是记这个映射）。
 *   为什么不把 `docId` 放进键里：那样就得在落库前先生成 id，而 Prisma 的
 *   `@default(uuid(7))` 只在 `create` 时赋值 ⇒ 要么自己手搓 uuid7（给"主键时间有序"
 *   这条不变式加第二个实现），要么把顺序倒过来。两条都不划算，见下方"uuid v7 曾想在这里
 *   手生成"一段的实测记录。
 * · **为什么不是"按内容哈希命名"**：同内容并发上传（双击/重试）会拿到**同一个键**，
 *   两条文档行共享一个对象 ⇒ 删掉其中一条就会带走另一条还要用的文件。
 *   随机段让每次上传各自持有一个对象，没有"共享对象"这类隐患。
 * · 扩展名取**判定出的格式**（不是用户给的名字里的）：白名单已保证两者一致，
 *   而格式是**校验过的**那个值（含".pdf 其实是文本"这类已被拦掉的情况）。
 *
 * ⚠️ 留给 P0-1-19 的一条：覆盖重建（`子方案①` §七）会写一个**新键**并更新
 *   `documents.file_key` —— 那时**必须显式删掉旧键指向的对象**，否则对象会永久残留
 *   （本批还没有 reupload 端点；删库路径不受影响，它按行里的 file_key 清）。
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  AppError,
  type DocumentItem,
  type UploadDocumentResult,
  type UploadExtension,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureBucket, getS3Client } from '../infra/s3.js'
import { detectFormat } from '../pipeline/parse/index.js'
import { enqueuePipelineJob } from '../pipeline/queue.js'

/** 文档投影（与 `shared` 的 `documentItemSchema` 一一对应；列表端点 P0-1-21 复用它） */
const DOCUMENT_SELECT = {
  id: true,
  kbId: true,
  fileName: true,
  status: true,
  chunkCount: true,
  errorMsg: true,
  createdAt: true,
  updatedAt: true,
} as const

type DocumentRow = {
  id: string
  kbId: string
  fileName: string
  status: string
  chunkCount: number
  errorMsg: string | null
  createdAt: Date
  updatedAt: Date
}

function toItem(row: DocumentRow): DocumentItem {
  return {
    id: row.id,
    kbId: row.kbId,
    fileName: row.fileName,
    // Prisma 的枚举在类型层是本仓 `schema.prisma` 里的字面量联合；这里只做形状收口
    status: row.status as DocumentItem['status'],
    chunkCount: row.chunkCount,
    errorMsg: row.errorMsg,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * uuid v7 曾想在这里手生成 —— **没做，原因记下来**
 *
 * S3 键最初写的是 `kb/{kbId}/{docId}/...`，而 `docId` 由 Prisma 的 `@default(uuid(7))`
 * 在 `create` 时赋值 ⇒ 想"先写 S3 再落库"就得自己先生成 id。于是先在
 * `crypto.randomUUID({ version: 7 })` 上试了一把，**实测有两层问题**：
 *   ① Node 22.22 的 `crypto.randomUUID` **不支持** `version` 选项 —— 它静默忽略并返回 **v4**
 *      （`docs/06` P0-1-16 的 issue_fix 有原始输出：拿到的 id 第 15 位是 `4`）；
 *   ② `@types/node@22.20.4` 的类型里也没有这个字段（所以连"类型层提醒"都没有）。
 * 结论：**不自己手搓 uuid7**（那是给"主键时间有序"这条不变式加第二个实现），
 * 改成"对象名里放一个与文档 id 无关的随机段"，见下面的 `fileKey` 说明 ——
 * 于是既不需要提前知道 id，也把 `uuid(7)` 的唯一实现留给 Prisma。
 */

/** Prisma 错误码鸭式判断（`instanceof` 跨包会失效，见 `user.service.ts` / `kb.service.ts` 同款） */
function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  )
}

export interface UploadDocumentInput {
  kbId: string
  /** 原始文件名（用户设备上的名字） */
  fileName: string
  /** 客户端声明的 MIME（可能缺失） */
  declaredMime: string | undefined
  /** 文件内容（multipart 已读进内存；上限见 `UPLOAD_BODY_LIMIT`） */
  bytes: Buffer
}

/**
 * 上传（入库登记）：前置校验 → S3 → 建行 `status=PARSING`。
 *
 * 去重的语义（`子方案①` §4-1 第 4 条 + §七）：**同一知识库内**已有 `content_hash` 相同的文档时
 * **不新建行**，直接返回那一条并标 `deduplicated=true`。为什么必须在这一层做：
 * 用户重复点上传、或用浏览器重试一次请求，是最常见的现场；不拦的话同一份内容会在库里
 * 变成两条文档、两套 chunk，检索时同一段话被引用两次（这正是 §七 说的"引用出现重复文档名，
 * 比空窗更糟"）。
 *
 * **判重是"每库"而不是"全局"**：同一份制度文件放进两个知识库是合法用法
 * （`knowledge_bases` 之间没有继承关系），所以查询必须带 `kbId`。
 *
 * @throws {AppError} `NOT_FOUND`(404) 知识库不存在 / `VALIDATION`(400) 前置校验不过 /
 *   `INTERNAL`(500) S3 写入失败或**入队失败**（后者会把本次登记整个回滚）
 */
export async function uploadDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  const db = getPrisma()
  const logger = getLogger()

  // ① 知识库必须存在 —— 放在格式校验**之前**：库不存在时"文件格式不对"这类提示毫无意义
  const kb = await db.knowledgeBase.findUnique({ where: { id: input.kbId }, select: { id: true } })
  if (kb === null) throw AppError.notFound('知识库不存在')

  // ② 三道前置校验（扩展名 / MIME / 文件头），不合法抛 400
  const format: UploadExtension = detectFormat(input)

  // ③ 内容判重（`子方案①` §4-1 第 4 条）
  const contentHash = createHash('sha256').update(input.bytes).digest('hex')
  const existing = await db.document.findFirst({
    where: { kbId: input.kbId, contentHash },
    select: DOCUMENT_SELECT,
    orderBy: { createdAt: 'desc' },
  })
  if (existing !== null) {
    logger.info(
      { kbId: input.kbId, docId: existing.id, fileName: input.fileName, status: existing.status },
      '上传的文件与库内已有文档内容相同，未新建文档行',
    )
    return { document: toItem(existing), deduplicated: true }
  }

  // ④ S3：先落对象，再落库（顺序理由见文件头）
  //    对象名里的 `randomUUID()`（v4）是**存储层的随机段**，与文档 id 无关 —— 理由见文件头
  //    "uuid v7 曾想在这里手生成" 一段；`02` §3.1 的 `uuid(7)` 是**主键**的口径
  //    （作用在"时间有序"上），对象名不需要有序。
  const fileKey = `kb/${input.kbId}/${randomUUID()}/source.${format}`
  const bucket = config.s3.bucket
  try {
    const s3 = getS3Client()
    await ensureBucket(bucket)
    await s3.putObject(bucket, fileKey, input.bytes, input.bytes.length, {
      'Content-Type': 'application/octet-stream',
    })
  } catch (error) {
    logger.error({ err: error, bucket, fileKey }, '原文件写入 S3 失败，已中止上传（未建文档行）')
    throw AppError.internal(`原文件写入对象存储失败，上传已中止：${String(error)}`)
  }

  // ⑤ 落库（`status=PARSING` —— 等 P0-1-17 的 worker 消费）
  let created: DocumentRow
  try {
    created = await db.document.create({
      data: {
        kbId: input.kbId,
        fileKey,
        fileName: input.fileName,
        contentHash,
        // id / status / chunkCount 全走 schema 默认值：`@default(uuid(7))` 是 Prisma 侧
        // 生成（P0-1-14 的实测：函数型默认值不进 DDL），本服务**不**自己生成 id
      },
      select: DOCUMENT_SELECT,
    })
  } catch (error) {
    // 补偿：删掉刚写上去的对象。删不掉也不能让请求"看起来失败得不明不白" —— 记 error 后照常抛出
    await removeQuietly(bucket, fileKey)
    if (hasPrismaCode(error, 'P2003')) {
      // 外键失败 = 知识库在"查存在"与"建行"之间被删了（并发）。给 404 而不是 500
      throw AppError.notFound('知识库不存在（可能在本次上传期间被删除）')
    }
    throw error
  }

  // ⑥ 入队（`子方案①` §三 ②）—— 与 ⑤ 是**同一件事的两半**，见下方回滚的注释
  try {
    await enqueuePipelineJob({
      docId: created.id,
      kbId: input.kbId,
      contentHash,
      mode: 'NEW',
    })
  } catch (error) {
    await rollbackRegistration(created.id, bucket, fileKey, error)
    throw AppError.internal(
      `任务入队失败（队列不可用），本次上传已回滚，请稍后重试：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  logger.info(
    {
      kbId: input.kbId,
      docId: created.id,
      fileName: created.fileName,
      format,
      bytes: input.bytes.length,
    },
    '文档已登记并入队，等待流水线 worker 消费',
  )
  return { document: toItem(created), deduplicated: false }
}

/**
 * 入队失败时把"登记"整个撤掉（删行 + 删对象）。
 *
 * 为什么必须撤：上传端点对用户的承诺是"**已经交给流水线**" —— `子方案①` §三 的 ① 登记与 ② 入队
 * 是同一件事的两半。只留 ① 的后果是最坏的一种：那行文档永远是 `PARSING`，**没有任何人会来消费它**，
 * 而用户重传还会被 `content_hash` 判重命中直接跳过（`deduplicated: true`、连新行都不建）——
 * 于是界面上出现一个"上传成功、永远转圈、重传也没用"的文档。撤销并让这次请求失败，
 * 用户看到的是"上传失败，请重试"，这才是真相。
 *
 * 清理失败只记 error（调用方正在抛真正的错误，别用清理失败把它盖掉），但把残留是什么写清楚，
 * 便于事后手工清。
 */
async function rollbackRegistration(
  docId: string,
  bucket: string,
  fileKey: string,
  cause: unknown,
): Promise<void> {
  const logger = getLogger()
  try {
    // 用 `deleteMany` 而不是 `delete`：删不存在的行时 `delete` 会抛 P2025（而这里只想尽力而为），
    // 且 Prisma 的查询日志会把整个堆栈打到 stdout，反而盖住真正的原因（P0-1-11 的教训）
    await getPrisma().document.deleteMany({ where: { id: docId } })
  } catch (error) {
    logger.error({ err: error, docId }, '入队失败后回滚文档行失败，库里可能残留一条 PARSING 记录')
  }
  await removeQuietly(bucket, fileKey)
  logger.error({ err: cause, docId, fileKey }, '任务入队失败，已回滚本次上传（文档行与 S3 对象）')
}

/** 尽力删除一个对象（失败只记日志：调用方正在抛出真正的错误，别用清理失败把它盖掉） */
async function removeQuietly(bucket: string, fileKey: string): Promise<void> {
  try {
    await getS3Client().removeObject(bucket, fileKey)
  } catch (error) {
    getLogger().error({ err: error, bucket, fileKey }, '补偿删除 S3 对象失败，可能残留一个孤立对象')
  }
}
