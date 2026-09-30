/**
 * 产物服务（P0-3-9）—— 产物**列表**与**下载**的服务层
 *
 * 依据：`docs/02-后端设计.md` §4.8（任务与产物：`GET /api/conversations/:id/artifacts` +
 *      `/api/artifacts/:id/download`）+ §三（`artifacts` 表与两个索引）
 *      + `docs/子方案/文件预览.md` §三（交付形态、归属校验、第二个不套信封的端点）
 *      + `docs/06-实施计划.md` §五 P0-3-9 行
 *
 * 本批（P0-3-9）交付**列表 + 下载**两条端点；`/api/artifacts/:id/content`（预览）属 **P0-3-10**，
 * 它复用本文件的 {@link openArtifactSource}，只差响应头那一组（`子方案④` §四 2 的分派表）。
 * ✅ **P0-3-10 已落地**：预览端点接在同一条归属判据与同一个取流函数上 —— 本文件**零改动**
 * （"下载与预览只差响应头"这条设计判断因此被实现验证了一次）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据一：产物是**会话的私有资源**，两条端点都必须过「产物 → 会话 → 本人」
 * ═══════════════════════════════════════════════════════════════════════
 * 与知识库文档下载那条**刻意不同**（`子方案④` §三 3 点名了这件事）：文档是"登录即可"
 * （`knowledge_bases` 没有 owner 列），而产物挂在 `conversations.user_id` 下。
 * **照抄文档下载那条就会漏掉归属校验** —— 症状是"任何登录用户拿着别人的 `artifactId`
 * 就能下载任意会话的产物"，而两条端点在代码上长得几乎一样。
 *
 * 别人的产物一律 **404 而不是 403**（与会话同族，`shared/src/conversation.ts` 文件头 ①）：
 * `artifactId` 不出现在任何对他人可见的列表里，403 等于**确认这个 id 有效**。
 * 判据落在查询的 `where` 里 —— 于是"忘了判归属"这件事在结构上不存在
 * （与 `conversation.service.ts` 文件头 ① 同一条纪律）。
 * ⚠️ **自「TaskAgent 记忆与产物」块 3 起归属判据是 `artifacts.user_id` 直查**（不再是
 * `conversation: { userId }` join）：产物行建行时写入 owner，删会话后 `conversation_id`
 * 被置空、转成"历史产物"，那条 join 会 404 —— 直查 `userId` 才是"这是不是我的"的稳定答案。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据二：下载是**后端流式代理**，不是签名 URL
 * ═══════════════════════════════════════════════════════════════════════
 * `02` §4.8 原文写的是"签名 URL（默认 30 分钟）"，`子方案④` §三 2 把它改成代理，三条理由：
 * ① **CSP 隔离头只有我方响应头加得上**（签名 URL 的响应由对象存储直发，我们加不了任何头）；
 * ② `S3_ENDPOINT` 不必是浏览器可达的地址；③ 不必给 MinIO 配 CORS。
 * ⇒ `ARTIFACT_URL_TTL_MIN` 在 P0 **不生效但保留登记**（P1 若改回签名 URL 再启用）。
 * "时效"没有丢：链接**根本无法被分享给第二个人**（别人点开是 401/404），
 * 安全性高于"拿到链接就能下载 30 分钟"。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据三：对象可能已经不在（保留期清理 / 删失败的补偿）⇒ **404 + 专句文案、不动数据库**
 * ═══════════════════════════════════════════════════════════════════════
 * 这是 P0-3-7 传下来的口径 ①。`artifacts.ts` 的保留期清理是"对象删成功才删行"，
 * 但反过来（对象没了、行还在）由本文件的 404 兜底 —— **不删行、不改状态**：
 * 行是"这个会话产出过什么"的历史记录，把它抹掉等于把用户的历史改小。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 两条刻意不做（写在明处）
 * ═══════════════════════════════════════════════════════════════════════
 *   · **不支持 Range / 断点续传**（`子方案④` §八 2）：要透传 Range 头与 206 响应，
 *     与"先 `statObject` 再 `getObject`"的既有形态要重新对齐 ⇒ 大 PDF 整份下载后才显示；
 *   · **不在这里定 `preview_ready` 的语义**（属 P0-3-10）：它 P0-3-7 起恒为 `false`，
 *     本批连列表都不带这一列（带了就是替下一批定语义，见 `shared#artifactListItemSchema`）。
 */

import type { Readable } from 'node:stream'

import {
  AppError,
  type ArtifactListResult,
  type ArtifactListItem,
  type ListArtifactsQuery,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { getS3Client, isS3NoSuchKey } from '../infra/s3.js'
import type { ConversationViewer } from './conversation.service.js'

/**
 * 列表的查询字段（`02` §三 的列集合；**刻意不带 `fileKey` 与 `previewReady`** ——
 * 前者是存储层实现细节、后者属 P0-3-10，见文件头与 `shared#artifactListItemSchema`）。
 */
const ARTIFACT_SELECT = {
  id: true,
  fileName: true,
  size: true,
  mime: true,
  createdAt: true,
} as const

/**
 * 排序：`created_at desc` 且以 `id` 兜底（P0-1-20 的教训：并列段没有副键就是"顺序随机"）。
 *
 * 索引 `(conversation_id, created_at desc)`（`schema.prisma`）正是这条顺序 ⇒ 列表不排序。
 * ⚠️ 这里的"新 → 旧"与消息历史那个"旧 → 新"**刻意相反**：产物面板是"最近产出在最上"，
 * 而对话流是"新消息追加在末尾"（`shared#messagePageResultSchema` 有完整理由）。
 */
const ARTIFACT_CHRONO_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const

function toListItem(row: {
  id: string
  fileName: string
  size: number
  mime: string
  createdAt: Date
}): ArtifactListItem {
  return {
    artifactId: row.id,
    fileName: row.fileName,
    size: row.size,
    mime: row.mime,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * 产物列表（`GET /api/conversations/:id/artifacts`，仅本人）。
 *
 * 两件事：
 *   · **先判"这个会话是不是我的"**（404）—— 若跳过这一步直接按 `conversationId` 查产物，
 *     这个端点就变成"知道会话 id 就能列别人的产物"；
 *   · **当页数据与 `total` 在同一个事务里取**（与文档列表同款）：分页器错位是
 *     "总数变了但页码没变"这类静默问题，代价只是一次事务。
 *
 * @throws {AppError} `NOT_FOUND`(404) 会话不存在或不是我的
 */
export async function listArtifacts(
  conversationId: string,
  query: ListArtifactsQuery,
  viewer: ConversationViewer,
): Promise<ArtifactListResult> {
  const db = getPrisma()
  const owned = await db.conversation.findFirst({
    where: { id: conversationId, userId: viewer.id },
    select: { id: true },
  })
  if (owned === null) throw AppError.notFound('会话不存在')

  const where = { conversationId: owned.id }
  const [rows, total] = await db.$transaction([
    db.artifact.findMany({
      where,
      select: ARTIFACT_SELECT,
      orderBy: [...ARTIFACT_CHRONO_ORDER],
      skip: query.offset,
      take: query.limit,
    }),
    db.artifact.count({ where }),
  ])

  return { items: rows.map(toListItem), total, offset: query.offset, limit: query.limit }
}

/**
 * 历史产物列表（`GET /api/artifacts/history`，仅本人；**P0-3 记忆与产物 块 4**）。
 *
 * 查的是「删过会话、产物行保留下来」的那一批：`conversationId = null` + `userId = me`。
 * 判据落在 `where` 里（与其余会话族同一条纪律）：别人的历史产物与不存在的行都是空页，
 * **不存在"忘了判归属"的写法**。
 *
 * ⚠️ 与 {@link listArtifacts} 的三处不同（都是"为什么不能照抄"的理由）：
 *   · **不需要先判会话归属**：这里没有会话（`conversationId` 恒 `null`），归属就是 `userId` 一列；
 *   · **`conversationId = null` 必须显式写**：它是"历史产物"的定义，漏了就会把当前会话的
 *     产物也拉进来（那已经是 `GET /:id/artifacts` 的事）；
 *   · 排序/分页/投影与列表**完全同款**（`ARTIFACT_CHRONO_ORDER` + `ARTIFACT_SELECT`）——
 *     前端复用同一套卡片渲染。
 */
export async function listArtifactHistory(
  userId: string,
  query: ListArtifactsQuery,
): Promise<ArtifactListResult> {
  const db = getPrisma()
  const where = { userId, conversationId: null } as const
  const [rows, total] = await db.$transaction([
    db.artifact.findMany({
      where,
      select: ARTIFACT_SELECT,
      orderBy: [...ARTIFACT_CHRONO_ORDER],
      skip: query.offset,
      take: query.limit,
    }),
    db.artifact.count({ where }),
  ])

  return { items: rows.map(toListItem), total, offset: query.offset, limit: query.limit }
}

/** 打开一个产物后的只读结果（路由层据此上响应头；**不读进内存**） */
export interface ArtifactSource {
  artifactId: string
  /** 容器内相对 `/work` 的路径（`out/report.csv` 这种形态），`Content-Disposition` 用它 */
  fileName: string
  /**
   * 扫描时定的 mime（`artifacts.mime`）—— **产物 `Content-Type` 的唯一来源**
   * （`子方案④` §四 2：既不是 S3 对象的 `ContentType`、也不是扩展名的运行期再判）。
   */
  mime: string
  /** 对象实际字节数（来自 `statObject`，不是行里的 `size`） */
  contentLength: number
  /** 对象内容（流）—— 路由层直接 `reply.send()` */
  body: Readable
}

/**
 * 打开产物（`GET /api/artifacts/:id/download` 与 **P0-3-10 起的 `/content`**，仅本人）。
 *
 * ⚠️ **两条出口共用这一个函数**（`子方案④` §四 1）：下载与预览差的**只有响应头**，
 * 响应头分派在路由层做（`routes/artifacts.ts#previewHeadersFor`）⇒ 服务层不认识"预览"这件事。
 *
 * ⚠️ **P0-3 记忆与产物（块 2/3）起归属判据换成了 `userId` 直查**：产物行自
 * 建行起带 `user_id`，不再经由 `conversation → user` join —— 否则"删除会话后产物
 * 转历史产物（`conversation_id` 置空）"的那些行会因 join 不到会话而 404。
 * 判据仍是"产物 → 本人"，只是主语从会话换成了产物自己的 owner 列。
 *
 * 四步各有理由：
 *   ① **归属在 `where` 里一次判完**（`userId`），别人的产物与不存在的 id
 *      拿到**同一个 404**（文件头判据一）；
 *   ② **先 `statObject` 再 `getObject`**：后者对不存在的键**不会**在 `await` 时抛错
 *      （它返回一个流，错误在读取时才发生）⇒ 只调它会把 200 与响应头先发出去，
 *      客户端看到的是"下载到一半断了"而不是"文件不存在"；`stat` 顺带给出 `Content-Length`；
 *   ③ **流式返回**：产物单文件上限 `ARTIFACT_MAX_FILE_MB`（默认 50MB），读进内存等于让一个
 *      下载请求吃掉 50MB 堆（与 `openDocumentSource` 同款）；
 *   ④ **"行在对象没了" ⇒ 404 + 专句文案、不动数据库**（文件头判据三）。
 *
 * ⚠️ `statObject` 到 `getObject` 之间对象仍可能被删（TOCTOU）：那时流会报错，
 *    响应头已发出，只能断流 —— 流式响应的固有边界，**不**假装能回一个 JSON 错误。
 *
 * @throws {AppError} `NOT_FOUND`(404) 产物不存在 / 不是我的 / **原文件已不在存储里**
 *   （第三种是另一句文案：行还在、只是对象没了 —— 用户该做的是重跑一次任务）
 *   `INTERNAL`(500) 存储不可用（连不上 MinIO 这类基础设施问题）
 */
export async function openArtifactSource(params: {
  artifactId: string
  userId: string
}): Promise<ArtifactSource> {
  return openArtifactSourceWhere(
    { id: params.artifactId, userId: params.userId },
    '产物不存在',
  )
}

/**
 * 打开产物（**沙箱产物下载** `GET /api/sandbox/artifacts/:artifactId`，P0-3 记忆与产物 块 2）。
 *
 * 归属判据与 {@link openArtifactSource} 同一条、**主语换成 `conversationId`**：
 * 容器经 per-container token 自证身份后，只能取回**自己这个会话**产出的文件
 * （`token → conversationId` 与产物行 `conversation_id` 必须相等）。
 *
 * ⚠️ 与公网下载共用**同一个取流实现**（{@link openArtifactSourceWhere}）—— S3 的判据
 * （stat → getObject、行在对象没了 ⇒ 404 不动库）**只写一份**，两条出口不会各自演化。
 *
 * @throws {AppError} `NOT_FOUND`(404) 产物不存在 / 不属于这个会话 / 对象已不在存储里
 */
export async function openArtifactSourceForConversation(params: {
  artifactId: string
  conversationId: string
}): Promise<ArtifactSource> {
  return openArtifactSourceWhere(
    { id: params.artifactId, conversationId: params.conversationId },
    '产物不存在',
  )
}

/** 归属判据的两种形态（`userId` 直查 / `conversationId` 直查）—— `findFirst` 的 where 都满足它 */
type ArtifactOwnershipWhere = { id: string; userId: string } | { id: string; conversationId: string }

/**
 * 取流实现（两条出口共用，见上）：`where` 里一次判完归属 → `statObject` → `getObject`。
 *
 * 文案 `missingMessage` 由调用方给：两种出口的"为什么找不到"主语不同（公网是"不是你的"、
 * 沙箱是"不属于这个会话"），而 404 是同一个形态。
 */
async function openArtifactSourceWhere(
  where: ArtifactOwnershipWhere,
  missingMessage: string,
): Promise<ArtifactSource> {
  const db = getPrisma()
  const row = await db.artifact.findFirst({
    where,
    select: { id: true, fileName: true, mime: true, fileKey: true },
  })
  if (row === null) throw AppError.notFound(missingMessage)

  const bucket = config.s3.bucket
  const s3 = getS3Client()

  let size: number
  try {
    const stat = await s3.statObject(bucket, row.fileKey)
    size = stat.size
  } catch (error) {
    if (isS3NoSuchKey(error)) {
      getLogger().warn(
        { artifactId: row.id, fileKey: row.fileKey },
        '产物行存在但 S3 对象已丢失，下载返回 404（行保留不动：它是"这个会话产出过什么"的历史）',
      )
      throw AppError.notFound('该产物已超过保留期或被清理，请重新运行任务生成')
    }
    getLogger().error({ err: error, artifactId: row.id, fileKey: row.fileKey }, '读取产物对象元数据失败')
    throw AppError.internal('存储服务暂时不可用，请稍后重试')
  }

  const body = await s3.getObject(bucket, row.fileKey)
  return {
    artifactId: row.id,
    fileName: row.fileName,
    mime: row.mime,
    contentLength: size,
    body,
  }
}

/** 下载响应的 `Content-Type`：唯一来源是 `artifacts.mime`（`子方案④` §四 2 判据 ⑤）。 */
export function artifactDownloadContentType(mime: string): string {
  return mime.trim() === '' ? 'application/octet-stream' : mime.trim()
}
