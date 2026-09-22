/**
 * 文档服务（P0-1-16 起；P0-1-17 补入队；P0-1-19 补覆盖重建 / 重试 / 删除）
 *
 * 依据：`docs/02-后端设计.md` §4.6（上传/重建/重试/删除四个端点）+ `子方案/知识库流水线.md`
 *      §三（流水线总览）、§4-1（四格式 + 上传前置校验）、§七（覆盖重建）、§十（队列）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件里五个入口的"谁做什么"
 * ─────────────────────────────────────────────────────────────────────
 * · `uploadDocument`   —— 建行 + 落 S3 + 入队（首次入库）
 * · `reuploadDocument` —— **改**行 + 换 S3 对象 + 清旧 chunk + 入队（覆盖重建，不新建行）
 * · `retryDocument`    —— 只入队（外加把 FAILED 翻成 PARSING，让用户立刻看到"处理中"）
 * · `deleteDocument`   —— 删行（chunk 级联）+ 删 S3 对象
 * 四个入口都**不做**同步解析：大 PDF 的解析 + 向量化是分钟级的，挂在 HTTP 请求里会把上传
 * 变成"转圈几分钟"，而 §十 引入队列正是为了解决它。所以响应的 `status` 恒为 `PARSING`，
 * 想知道结果得看列表接口（P0-1-21）或直接查库。
 *
 * ⚠️ ①（登记）与 ②（入队）是**同一件事的两半**：入队失败必须把 ① 一起撤掉，否则留下
 *    "永远转圈且重传无救"的文档 —— 见 `rollbackRegistration` 的注释。
 *    覆盖重建做不到同样的回滚（旧 chunk 删了就回不来），它的补偿是"如实告知 + 可用的重试"，
 *    见 `reuploadDocument` 的注释。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 顺序：**先 S3、再落库、最后入队**（与"删库/删文档"正好相反）
 * ─────────────────────────────────────────────────────────────────────
 * 删是"先 DB 后 S3"（见 `kb.service.ts` 文件头 ⑤ 与 `deleteDocument`），理由是
 * "库还在但文件没了"比"文件还在但库没了"坏。上传这一侧对称地反过来：
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
 * · **覆盖重建会换一个新键**（同一个随机段规则），旧键由 `reuploadDocument` 显式删除 ——
 *   不删就是永久泄漏（行里已经指向新键，旧对象没人认领了）。
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  AppError,
  canTransitionDocumentStatus,
  type DocumentItem,
  type RemoveDocumentResult,
  type RetryDocumentResult,
  type ReuploadDocumentResult,
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

// ═══════════════════════════ 覆盖重建 / 重试 / 删除（P0-1-19）═══════════════════════════

/** 覆盖重建的入参 = 上传的入参 + 目标文档 id（路径参数 `:id` 是知识库，`:docId` 是文档） */
export interface ReuploadDocumentInput extends UploadDocumentInput {
  docId: string
}

/** 查询行时额外要的列（覆盖重建要旧 `fileKey` 与旧 `contentHash`，删除要 `fileKey`） */
const DOCUMENT_MUTATION_SELECT = {
  ...DOCUMENT_SELECT,
  fileKey: true,
  contentHash: true,
} as const

/**
 * 覆盖重建（`子方案①` §七）：**同文档替换内容**，不新建 `documents` 行。
 *
 * 为什么"不新建行"是硬要求（决策 13）：文档 id 稳定 ⇒ 引用、`agent_components.ref_id`
 * 的绑定、"某个 Agent 绑了这个库里的哪几篇"全都不受影响。
 *
 * 三条刻意的行为：
 * 1. **`content_hash` 相同 ⇒ 直接 200 + `unchanged: true`，什么都不做**（§七 原文）。
 *    "什么都不做"是**三个没做**：不落新对象、不删旧 chunk、不入队 —— 验收逐条取证。
 * 2. **先删 chunk 再改行，同一事务**（§七 的"先删后建"）。代价是**检索空窗**
 *    （窗口 = 一次流水线耗时），§七 明说是刻意取舍：双份共存会让同一内容被引用两次，
 *    比空窗更糟且更难向用户解释。缓解方式是把 `status=PARSING` 如实写出来，
 *    让列表页能显示"更新中，暂不参与检索"。
 * 3. **旧 S3 对象必须显式删**：改行之后它就没人引用了（`documents.file_key` 已指向新对象），
 *    不删就是永久泄漏。
 *
 * ⚠️ 与上传的**关键不对称**（入队失败时的补偿能力不同）：
 * 上传时入队失败能"整次回滚"（行是它刚建的）；这里**做不到** —— 旧 chunk 一旦删就回不来。
 * 故本函数的入队失败处理是"**如实报告 + 指向可用的恢复手段**"：内容已就位，
 * 用户点一次 `POST .../retry` 就能跑（`retry` 对 `PARSING` 是放行的，见 {@link retryDocument}）。
 * 把它伪装成"整次失败、什么都没变"才是真的害人。
 *
 * @throws {AppError} `NOT_FOUND`(404) 文档不存在或不属于该知识库 /
 *   `VALIDATION`(400) 前置校验不过（含 `.doc` 与改名） / `CONFLICT`(409) 状态机不允许 /
 *   `INTERNAL`(500) S3 写入失败或**入队失败**（后者内容已替换，提示用户点重试）
 */
export async function reuploadDocument(input: ReuploadDocumentInput): Promise<ReuploadDocumentResult> {
  const db = getPrisma()
  const logger = getLogger()

  // ① 文档必须存在**且属于路径上的那个知识库**：只按 docId 查会让 `:id` 变成一个装饰
  //    （用 A 库的路径改 B 库的文档），也顺带避免"能靠 docId 探测别人库里有什么"
  const row = await db.document.findFirst({
    where: { id: input.docId, kbId: input.kbId },
    select: DOCUMENT_MUTATION_SELECT,
  })
  if (row === null) throw AppError.notFound('文档不存在（或不属于该知识库）')

  // ② 三道前置校验（与上传同一个入口 —— 覆盖重建不能成为绕过校验的后门）
  const format: UploadExtension = detectFormat(input)

  // ③ 内容没变 ⇒ 视为误操作，直接返回（§七）。⚠️ 注意这里**在写 S3 之前**就返回，
  //    否则"什么都没做"就变成"落了一个没人引用的对象"
  const contentHash = createHash('sha256').update(input.bytes).digest('hex')
  if (contentHash === row.contentHash) {
    logger.info(
      { kbId: input.kbId, docId: row.id, fileName: input.fileName },
      '覆盖重建：内容与当前一致，未做任何改动',
    )
    return { document: toItem(row), unchanged: true }
  }

  // ④ 状态机守卫（防御性）：三种在库状态都允许回到 PARSING，所以正常永远进不来；
  //    真进来了说明状态值与状态机脱节了，宁可 409 也不要写坏那行
  if (!canTransitionDocumentStatus(row.status as DocumentItem['status'], 'PARSING')) {
    throw AppError.conflict(`该文档当前状态（${row.status}）不允许覆盖重建`)
  }

  // ⑤ 新对象（新随机段 —— 与上传同款理由：不共享对象，见文件头）
  const fileKey = `kb/${input.kbId}/${randomUUID()}/source.${format}`
  const bucket = config.s3.bucket
  try {
    const s3 = getS3Client()
    await ensureBucket(bucket)
    await s3.putObject(bucket, fileKey, input.bytes, input.bytes.length, {
      'Content-Type': 'application/octet-stream',
    })
  } catch (error) {
    logger.error({ err: error, bucket, fileKey }, '覆盖重建：原文件写入 S3 失败，已中止（未改动任何行）')
    throw AppError.internal(`原文件写入对象存储失败，覆盖重建已中止：${String(error)}`)
  }

  // ⑥ 事务：删旧 chunk + 改行（`§七` 步骤 2 的 a/b 两条，必须原子）
  let updated: DocumentRow
  try {
    updated = await db.$transaction(async (tx) => {
      await tx.chunk.deleteMany({ where: { docId: row.id } })
      return tx.document.update({
        where: { id: row.id },
        data: {
          // 回到 PARSING：`READY → PARSING` 正是"覆盖重建"这条转换（见 `shared` 的状态机表）
          status: 'PARSING',
          errorMsg: null,
          contentHash,
          fileKey,
          chunkCount: 0,
          /**
           * ⚠️ `file_name` 也一起换 —— **这是对 `§七` 列清单的一处刻意补全**。
           *
           * `§七` 写的 `UPDATE` 只列了 status / error_msg / content_hash / file_key / chunk_count。
           * 但 `documents.file_name` 在本仓承担两个职责：列表页的展示名、以及 P0-1-21 下载端点的
           * `Content-Disposition` 文件名。旧名字留下来就会**说谎**：用户把《旧制度.docx》换成
           * 《新制度.docx》之后，列表里永远显示旧名，而下载下来的字节是新文件、名字却是旧的
           * （且 `file_key` 里不带原名，事后无从分辨）。而"改名"这件事用户没有任何别的入口
           * —— 只能删掉重传，那会丢掉文档 id（决策 13 要保的正是 id 稳定）。
           * 故本服务一并更新，并把这条写进 `docs/06` 的落地要点与 `子方案①` §七 的落地口径。
           */
          fileName: input.fileName,
        },
        select: DOCUMENT_SELECT,
      })
    })
  } catch (error) {
    // 事务回滚了：库里还是旧内容 + 旧 chunk，只是多了一个没人引用的新对象 —— 删掉它再抛
    await removeQuietly(bucket, fileKey)
    throw error
  }

  // ⑦ 旧对象清理（尽力而为）。放在入队**之前**：此时 `documents.file_key` 已指向新对象，
  //    旧对象已经是孤儿；放在后面则"入队失败提前返回"会把清理一起跳过、泄漏一个对象
  if (row.fileKey !== fileKey) await removeQuietly(bucket, row.fileKey)

  // ⑧ 入队（`mode: REBUILD` —— 内容刚被替换）
  try {
    await enqueuePipelineJob({ docId: row.id, kbId: input.kbId, contentHash, mode: 'REBUILD' })
  } catch (error) {
    logger.error({ err: error, docId: row.id }, '覆盖重建：内容已替换但入队失败（文档留在 PARSING）')
    throw AppError.internal(
      '内容已替换成功，但任务入队失败（队列不可用）。' +
        '该文档暂时停在「处理中」且内容尚未入库，请稍后在该文档上点「重试」；' +
        `原因：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  logger.info(
    { kbId: input.kbId, docId: row.id, fileName: updated.fileName, format, bytes: input.bytes.length },
    '覆盖重建已登记并入队（旧 chunk 已清、旧对象已删）',
  )
  return { document: toItem(updated), unchanged: false }
}

/**
 * 失败重试（`子方案①` §三 的"失败 → `POST .../retry` 重新入队"）。
 *
 * 允许的状态：
 * · `FAILED` —— 常规重试；
 * · `PARSING` —— **这是"卡住了"的恢复入口**（P0-1-17 定的处置：worker 崩了/入队丢了/
 *   PG 挂了都会让文档停在 `PARSING`，`子方案①` §十 的"必须有重试入口"正是为它准备的）
 *   ⇒ **不能**因为"看起来正在处理"就 409，否则卡住的文档没有任何出路；
 * · `READY` —— **409**。没有东西可重试：入队也会被 worker 的幂等第 ④ 道跳过，
 *   返回 200 会让用户以为"正在重新处理"却看不到任何变化。
 *
 * 为什么在这里就把状态翻成 `PARSING`（而不是等 worker）：用户点完"重试"要**立刻**看到
 * "处理中"。交给 worker 的话，中间会有一段"按钮点了、界面还是失败"的空窗，看起来像没生效。
 * 用 CAS（`updateMany ... where status='FAILED'`）翻，`PARSING` 那种情况自然不匹配（它已经是了）。
 *
 * ⚠️ 重试**不改** `contentHash` / `chunkCount`：重试的是"当前这份内容"，
 * 而 `chunkCount` 要等 ⑦ 入库写成功才更新（写 0 会让"上次已经入库的块"看起来被清了）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 文档不存在 / `CONFLICT`(409) 已是 READY /
 *   `INTERNAL`(500) 入队失败（此时状态可能已翻成 PARSING，再点一次即可）
 */
export async function retryDocument(params: { kbId: string; docId: string }): Promise<RetryDocumentResult> {
  const db = getPrisma()
  const logger = getLogger()

  const row = await db.document.findFirst({
    where: { id: params.docId, kbId: params.kbId },
    select: DOCUMENT_MUTATION_SELECT,
  })
  if (row === null) throw AppError.notFound('文档不存在（或不属于该知识库）')
  if (row.status === 'READY') {
    throw AppError.conflict('该文档已是就绪状态，无需重试；如需替换内容请使用覆盖重建')
  }

  // 先把"上次失败的原因"清掉并翻到 PARSING（CAS：只对 FAILED 生效；PARSING 时本来就不匹配）
  const { count } = await db.document.updateMany({
    where: { id: row.id, status: 'FAILED' },
    data: { status: 'PARSING', errorMsg: null },
  })
  const next = count > 0 ? 'PARSING' : row.status

  try {
    await enqueuePipelineJob({
      docId: row.id,
      kbId: params.kbId,
      contentHash: row.contentHash,
      // `NEW` = "按当前内容做一次完整入库"（`queue.ts` 的 mode 口径：内容没变 ⇒ 不是 REBUILD）
      mode: 'NEW',
    })
  } catch (error) {
    logger.error({ err: error, docId: row.id }, '重试入队失败')
    throw AppError.internal(
      `任务入队失败（队列不可用），请稍后再次点击重试：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const fresh = await db.document.findUnique({ where: { id: row.id }, select: DOCUMENT_SELECT })
  if (fresh === null) throw AppError.notFound('文档不存在（可能刚被删除）')

  logger.info({ kbId: params.kbId, docId: row.id, from: row.status, to: next }, '文档已重新入队')
  return { document: toItem(fresh) }
}

/**
 * 删除文档：DB 行（chunk 由外键 CASCADE 连带）→ S3 对象。
 *
 * 顺序与删库一致（`kb.service.ts` 文件头 ⑤）：**先 DB 后 S3** —— 反过来一旦 DB 删除失败，
 * 就得到"库还在、文件没了"（用户看得见且会重试）；而"文件还在、库没了"只是泄漏一点存储。
 * 故 S3 那一步失败**只告警不阻塞**，返回的 `deletedChunks` 是删前数的（真实删掉的量）。
 *
 * `deletedChunks` 先 `count` 再删是刻意的：删完就数不出来了，而这个数要回给调用方
 * （与删库回 `deletedDocuments` 同款口径：只回 `ok` 会让界面给不出有信息量的提示）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 文档不存在（含"查到了但删的时候已经没了"的竞态）
 */
export async function deleteDocument(params: {
  kbId: string
  docId: string
}): Promise<RemoveDocumentResult> {
  const db = getPrisma()
  const logger = getLogger()

  const row = await db.document.findFirst({
    where: { id: params.docId, kbId: params.kbId },
    select: { id: true, fileName: true, fileKey: true },
  })
  if (row === null) throw AppError.notFound('文档不存在（或不属于该知识库）')

  const deletedChunks = await db.chunk.count({ where: { docId: row.id } })
  // `deleteMany` 而不是 `delete`：与"查到了但已经没了"的竞态正面相遇时，`delete` 会抛 P2025
  const { count } = await db.document.deleteMany({ where: { id: row.id } })
  if (count === 0) throw AppError.notFound('文档不存在（可能在本次请求期间已被删除）')

  await removeQuietly(config.s3.bucket, row.fileKey)

  logger.info(
    { kbId: params.kbId, docId: row.id, fileName: row.fileName, deletedChunks },
    '文档已删除（chunk 级联清除、原文件已清理）',
  )
  return { id: row.id, fileName: row.fileName, deletedChunks }
}

