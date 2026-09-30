/**
 * 片段（chunk）服务（P0-1-35 增量：文档「块内容预览」）
 *
 * 依据：`docs/02` §4.6 的文档端点表（本文补 `GET .../documents/:docId/chunks` 一条）
 *      + `shared/src/document.ts` 的 `chunkItemSchema`（本文件是它唯一的产出方）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这条端点（它补的是哪个洞）
 * ─────────────────────────────────────────────────────────────────────
 * 上传后列表只给每篇文档的 `chunkCount`（一个数字），用户看不到"内容到底被切成了什么样"。
 * 检索测试抽屉里的 `snippet` 是**命中窗口**、只回 topK 条，也回答不了"这篇文档有哪些块"。
 * 于是"分块合理不合理"在界面上完全不可观测 —— 本端点按 `seq` 顺序给出整块原文，填掉这个洞。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条与"列表"有关的取舍
 * ─────────────────────────────────────────────────────────────────────
 * · **按 `seq` 升序**（不是多数列表的"时间倒序"）：块序是文档内部的空间顺序，
 *   预览要从头读起；`chunks` 上的 `[docId, seq]` 索引正好服务这条排序（见 schema 注释）。
 * · **不回 `embedding`**：1024 维向量对"看内容"毫无用处，却是这份响应里最大的一列
 *   （`chunkItemSchema` 的注释）。用 `select` 显式挑列，不靠"默认全给"。
 * · **`total` 与当页同事务取**：与 `listDocuments` 同款，否则翻页器会错位。
 *
 * ⚠️ `docId` 必须属于路径上的 `kbId`（`findFirst({ id, kbId })`）：只按 docId 查会让 `:id`
 *    变成一个装饰，也等于"知道 id 就能看任何库的正文"——与 retry/delete/download 同口径。
 */

import { AppError, type ChunkItem, type DocumentChunkListResult } from '@doubulea/shared'

import { getPrisma } from '../infra/prisma.js'
import { parseChunkMeta } from './retrieval.js'

/** 片段投影（与 `shared` 的 `chunkItemSchema` 一一对应；**不含 embedding**，见文件头） */
const CHUNK_SELECT = {
  id: true,
  docId: true,
  seq: true,
  content: true,
  meta: true,
} as const

/**
 * 列出某篇文档的片段（`GET /api/knowledge-bases/:id/documents/:docId/chunks`，登录即可）。
 *
 * `meta` 的解析复用检索层的 {@link parseChunkMeta}（唯一的口径，两种输入形状都收）
 * —— `page` / `headingPath` 的兜底规则不在这里再写一遍。
 *
 * @throws {AppError} `NOT_FOUND`(404) 文档不存在或不属于该知识库
 */
export async function listDocumentChunks(params: {
  kbId: string
  docId: string
  offset: number
  limit: number
}): Promise<DocumentChunkListResult> {
  const db = getPrisma()

  const doc = await db.document.findFirst({
    where: { id: params.docId, kbId: params.kbId },
    select: { id: true },
  })
  if (doc === null) throw AppError.notFound('文档不存在（或不属于该知识库）')

  const [rows, total] = await db.$transaction([
    db.chunk.findMany({
      where: { docId: doc.id },
      select: CHUNK_SELECT,
      // `id` 兜底同 `seq` 的意外重复：让分页顺序在数据异常时也保持确定（uuid7 时间有序）
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      skip: params.offset,
      take: params.limit,
    }),
    db.chunk.count({ where: { docId: doc.id } }),
  ])

  const items: ChunkItem[] = rows.map((row) => {
    const meta = parseChunkMeta(row.meta)
    return {
      id: row.id,
      docId: row.docId,
      seq: row.seq,
      content: row.content,
      page: meta.page,
      headingPath: meta.headingPath,
    }
  })

  return { items, total, offset: params.offset, limit: params.limit }
}
