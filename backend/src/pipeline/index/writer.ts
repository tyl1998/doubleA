/**
 * 入库层：⑥ embedding + ⑦ 写入 `chunks`（P0-1-19）
 *
 * 依据：`docs/子方案/知识库流水线.md` §4-3（embedding：批 32 / 单批失败重试 2 次 / `name()` 落 meta）、
 *      §4-4（DDL 与索引）、§三（⑦ 事务写入）、§七（覆盖重建的"先删后建"）；
 *      `docs/02-后端设计.md` §八（`EmbeddingProvider` 三方法）、§三（`chunks` 表）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独成模块（而不是塞进 worker 的某个阶段里）
 * ─────────────────────────────────────────────────────────────────────
 * 这里是**唯一**往 `chunks` 表写数据的地方，也是整条流水线里唯一"手写 SQL"的地方 ——
 * 而 `chunks.embedding` 是 Prisma 不认识的 `vector(1024)`（`Unsupported` 列），
 * 一旦写错（维度不对、事务没包住、delete 漏了）事后**几乎无法分辨**：库里有行、检索却没结果，
 * 或者同一段落被引用两次。集中在一个文件里，才可能被一次读透。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两个函数各自守一条不变式
 * ─────────────────────────────────────────────────────────────────────
 * · {@link embedChunks}：**向量的条数与顺序必须与输入逐条对应**。上游乱序返回是常态
 *   （`api.ts` 用 `index` 归位），但"归位错了"这件事在数据层看不出来 —— 你只会看到
 *   "检索结果答非所问"。所以条数不符在这里直接抛，宁可整篇 FAILED。
 * · {@link writeChunks}：**同一 doc 的 chunk 集合是一次原子替换**。先 `DELETE ... WHERE doc_id`
 *   再写入，且**全部在一个事务里** —— 中途失败必须回到"旧的那一份"或"没有"，不能出现
 *   半新半旧（§七 的"无重复、无孤儿"就是这条）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 一处**刻意偏离 `§4-4` 的草稿**：不写 `INSERT ... SELECT unnest(...)`
 * ─────────────────────────────────────────────────────────────────────
 * 草稿给的写法是 `INSERT INTO chunks (...) SELECT ... FROM unnest($1::uuid[], ...)`，
 * 它要求**自带 id 数组**。而 `chunks.id` 的口径是 `uuid(7)`（`02` §3.1），
 * 且 P0-1-16 已定案 **"不手搓 uuid7"**（那次实测：`crypto.randomUUID({ version: 7 })` 在
 * Node 22.22 上静默返回 v4，类型缺口还把谎说圆了）——`uuid(7)` 在本仓只有一个实现：
 * **Prisma 的 `@default(uuid(7))`**。要拿它必须走 Prisma 的写入路径。
 *
 * 于是本文件的做法是：**Prisma 建行（拿 id）→ 手写 `UPDATE ... FROM unnest(...)` 回填向量**，
 * 两步在**同一个事务**里。这样：
 *   · id 仍然只有 Prisma 一个来源 ⇒ `uuid(7)` 这条不变式不被"加第二个实现"；
 *   · 批量仍然是 `unnest` + 每批 {@link CHUNK_WRITE_BATCH} 行（一条 SQL 一批）；
 *   · `embedding` 仍然是手写 SQL 写进去的（`Unsupported` 列没别的办法）。
 * 代价是多一次 `UPDATE`（一条 SQL，不是 N 条）。验收里有一条"id 的版本位必须是 7"专门守它。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `meta` 里放什么
 * ─────────────────────────────────────────────────────────────────────
 * `{ headingPath, page, embeddingName }`：前两个来自 P0-1-18 的分块结果（引用要显示"第 N 页"、
 * 检索要能按标题定位），`embeddingName` 来自 provider 的 `name()` —— `§八` 的"换模型检测"靠它
 * 判断"这库里存的向量是哪个模型产的"。**每行都存一份**（而不是只存文档级）：将来换模型时
 * 要能分辨"哪些行是旧模型产的"，那正是重建路径的输入。
 */

import type { Logger } from 'pino'

import { AppError } from '@doubulea/shared'

import { config } from '../../config.js'
import { getLogger } from '../../infra/logger.js'
import { getPrisma } from '../../infra/prisma.js'
import { getEmbeddingProvider, type EmbeddingProvider } from '../../llm/embedding/index.js'
import type { Chunk } from '../chunk/index.js'

/**
 * 单批写入行数（`§4-4` 的"单批 200 行"）。
 *
 * 为什么要有上限：一次 `unnest` 塞进去几千个 1024 维向量，参数文本会到 MB 级（每个数约 20 字符），
 * 既撑大协议帧也更容易触发驱动的参数长度限制；而 200 × 1024 维 ≈ 4MB 文本，是"一条 SQL 的
 * 合理体量"。分批之间**不需要事务隔离**（整个写入本来就在一个事务里）。
 */
export const CHUNK_WRITE_BATCH = 200

/**
 * 单批 embedding 失败后的重试退避（`§4-3`："单批失败重试 2 次（指数退避 1s/3s）"）。
 * 长度即"重试次数" —— 2 个元素 = 失败后再试 2 次、共 3 次尝试。
 *
 * 为什么重试要落在**这个层**而不是 provider 里：provider 的 `embed()` 会自己按 `batchSize`
 * 切批，它看到的是"一次调用" —— 而 §4-3 要的重试粒度是**单批**。所以本文件先把文本按
 * `chunk_embed_batch` 切好，每次只喂一批（provider 内部循环于是只跑一轮），
 * 重试的边界才与"批"对齐。
 */
export const EMBED_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000]

/** ⑥ 的产物：与 {@link Chunk} 数组**逐条对应**的向量 + 落库用的模型标识 */
export interface EmbedOutcome {
  vectors: number[][]
  /** `EmbeddingProvider.name()`（写进每行 `meta.embeddingName`） */
  embeddingName: string
}

/**
 * ⑥ embedding：按 `EMBEDDING_BATCH_SIZE` 切批逐批调用，单批失败重试 2 次。
 *
 * 为什么"一批失败就放弃整篇"（而不是跳过这批继续）：向量缺失的 chunk 进了库会永久留在检索池里
 * 却永远排不上号，而"这篇文档少了几段"在界面上完全看不出来。整篇 FAILED + 可重试
 * （`POST .../retry`）是**可见且可恢复**的失败。
 *
 * @throws {AppError} `INTERNAL`(500) —— 消息是给用户看的（"文本向量化失败…请稍后重试"），
 *   上游细节由 `llm/upstream.ts` 保证已脱敏（P0-1-12 的 401 回显坑）
 */
export async function embedChunks(chunks: readonly Chunk[], log: Logger = getLogger()): Promise<EmbedOutcome> {
  const provider = getEmbeddingProvider()
  if (chunks.length === 0) return { vectors: [], embeddingName: provider.name() }

  const batchSize = config.embedding.batchSize
  const vectors: number[][] = []
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize)
    const batchVectors = await embedBatchWithRetry(
      provider,
      batch.map((chunk) => chunk.content),
      log,
    )
    if (batchVectors.length !== batch.length) {
      // provider 契约里已有一条同样的校验；这里再拦一道是因为**它才是"顺序对得上"的保证**：
      // 少了这一条，上面 `vectors.push(...)` 的错位会一路滑到库里（检索答非所问）
      throw AppError.internal(
        `文本向量化结果条数不符（本批 ${batch.length} 条，返回 ${batchVectors.length} 条），已中止本次入库`,
      )
    }
    vectors.push(...batchVectors)
  }
  return { vectors, embeddingName: provider.name() }
}

/** 单批 + 重试（见 {@link EMBED_RETRY_DELAYS_MS}） */
async function embedBatchWithRetry(
  provider: EmbeddingProvider,
  texts: string[],
  log: Logger,
): Promise<number[][]> {
  let lastError: unknown
  for (let attempt = 0; attempt <= EMBED_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await provider.embed(texts)
    } catch (error) {
      lastError = error
      const delay = EMBED_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      log.warn(
        { err: error, attempt: attempt + 1, retryInMs: delay, batchSize: texts.length },
        '单批 embedding 失败，退避后重试',
      )
      await sleep(delay)
    }
  }
  throw AppError.internal(`文本向量化失败（已重试 ${EMBED_RETRY_DELAYS_MS.length} 次）：${describe(lastError)}`)
}

/** 睡眠（只为退避；`unref` 以免在退出流程里把进程多留 1 秒） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/** 把异常收成一段可展示的文字（`AppError` 的消息本来就是写给用户的，原样采用） */
function describe(error: unknown): string {
  if (error instanceof AppError) return error.message
  return `内部错误：${error instanceof Error ? error.message : String(error)}`
}

export interface WriteChunksInput {
  docId: string
  kbId: string
  /** P0-1-18 的产物（`seq` / `content` / `meta`） */
  chunks: readonly Chunk[]
  /** 与 `chunks` 逐条对应的向量（{@link embedChunks} 的产物） */
  vectors: readonly number[][]
  /** 写进每行 `meta.embeddingName` */
  embeddingName: string
}

/**
 * ⑦ 事务写入：`DELETE ... WHERE doc_id` → 建行（Prisma 生成 uuid(7)）→ `UPDATE ... FROM unnest` 回填向量。
 *
 * 返回写入行数（调用方把它写进 `documents.chunk_count` —— 那是**唯一**允许写那一列的地方）。
 *
 * @throws {AppError} `INTERNAL`(500) 条数不符（编程错误）；其余数据库异常原样上抛
 *   （worker 会区分"文档的问题"与"基础设施的问题"，见其文件头）
 */
export async function writeChunks(input: WriteChunksInput): Promise<number> {
  const { docId, kbId, chunks, vectors, embeddingName } = input
  if (chunks.length !== vectors.length) {
    throw AppError.internal(
      `入库参数不一致：${chunks.length} 个块 / ${vectors.length} 条向量。这是编程错误，请上报。`,
    )
  }
  if (chunks.length === 0) {
    // 空文本检测（`§五`）已经拦掉了"解析出 0 字"的情况，走到这里说明分块真的产出为空
    // —— 那不是"没问题"，而是分块策略坏了。静默写 0 行会让文档显示 READY 却没有任何内容。
    throw AppError.internal('分块结果为空，未写入任何 chunk（请上报：这不该发生在通过空文本检测的文档上）')
  }

  const db = getPrisma()
  const inserted = await db.$transaction(async (tx) => {
    // ⚠️ 先删后建（`§七` 的取舍）：窗口期在**事务内**，其他事务在提交前看到的仍是旧数据；
    //    真正的"检索空窗"来自 reupload 端点在流水线**开始时**就删掉了旧 chunk（§七 原文）。
    //    这里再删一次是**幂等收口**：重试路径（上一次写入失败留下半套）、以及"内容变了的重建"
    //    都靠它保证"同一 doc 的 chunk 集合 = 本次写入的那一套"。
    await tx.chunk.deleteMany({ where: { docId } })

    const created = await tx.chunk.createManyAndReturn({
      data: chunks.map((chunk) => ({
        docId,
        kbId,
        seq: chunk.seq,
        content: chunk.content,
        // id / createdAt 走 schema 默认值：`@default(uuid(7))` 是 Prisma 客户端侧生成
        // （P0-1-14 实测：函数型默认值不进 DDL），本模块**不**自己生成 id —— 见文件头
        meta: {
          headingPath: chunk.meta.headingPath,
          page: chunk.meta.page,
          embeddingName,
        },
      })),
      select: { id: true, seq: true },
    })

    // `createManyAndReturn` 的返回顺序没有承诺 ⇒ 按 `seq` 归位（`seq` 是文档内唯一序号）
    const idBySeq = new Map(created.map((row) => [row.seq, row.id]))
    const ids: string[] = []
    for (const chunk of chunks) {
      const id = idBySeq.get(chunk.seq)
      if (id === undefined) {
        throw AppError.internal(`建行后拿不到第 ${chunk.seq} 块的 id（返回了 ${created.length} 行）`)
      }
      ids.push(id)
    }

    // 向量走手写 SQL：`embedding` 是 `Unsupported("vector(1024)")`，Prisma 写不了它。
    // 用**文本数组**而不是 `vector[]`：pgvector 对 `text::vector` 的解析是官方推荐路径，
    // 而 `vector[]` 需要驱动层先认识这个类型（P0-1-20 的 `embedding <=> $1` 也是同款文本入参）。
    const literals = vectors.map((vector) => `[${vector.join(',')}]`)
    for (let start = 0; start < ids.length; start += CHUNK_WRITE_BATCH) {
      const batchIds = ids.slice(start, start + CHUNK_WRITE_BATCH)
      const batchVectors = literals.slice(start, start + CHUNK_WRITE_BATCH)
      await tx.$executeRaw`
        UPDATE chunks AS c
        SET embedding = v.emb::vector
        FROM unnest(${batchIds}::uuid[], ${batchVectors}::text[]) AS v(id, emb)
        WHERE c.id = v.id
      `
    }
    return created.length
  })

  return inserted
}
