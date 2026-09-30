/**
 * 流水线阶段（P0-1-17 定骨架；P0-1-18 插 ④⑤；P0-1-19 插 ⑥⑦ —— 至此八步齐全）
 *
 * 依据：`docs/子方案/知识库流水线.md` §三（流程总览 ③~⑧）、§4-1（解析）、§4-2（分块）、
 *      §五（空文本检测）、§4-3（embedding）、§4-4（入库）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么把"处理步骤"从 worker 里拆出来
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §三 的流水线是**八个步骤**，分三批落地：P0-1-17 落 ③（解析）、
 * P0-1-18 落 ④（空文本检测）与 ⑤（分块）、P0-1-19 落 ⑥（embedding）与 ⑦（入库）。
 * 若把这几步直接写在 worker 的循环里，每批都要改那个循环（并发、幂等、状态机写入全在同一段
 * 代码里），风险最高的那部分代码会被改三次。拆成"阶段数组"之后：**每批只往数组中间插阶段**，
 * worker 的并发/幂等/失败处理一行不动。
 * 三批的实证：P0-1-18 插 ④⑤ 时 worker 只改了选择字段（`JOB_DOCUMENT_SELECT` 多带 KB 参数）、
 * P0-1-19 插 ⑥⑦ 时 worker **一行未改**（阶段要的数据全在上下文里）。
 * 另一个直接收益是验收可注入：`startPipelineWorker({ stages })` 能塞一组慢速假阶段，
 * 从而**确定性地**观测并发闸与幂等（见 `verify-pipeline.mjs` 的 E 组）。
 *
 * 阶段之间的数据传递只有一个方向：
 *   `load-source` 写 `ctx.source` → `parse` 读它、写 `ctx.parsed`
 *   → `detect-empty-text` 读 `parsed` → `chunk` 读 `parsed`、写 `ctx.chunks`
 *   → `embed` 读 `chunks`、写 `ctx.vectors`/`ctx.embeddingName`
 *   → `index` 读前两者、写 `ctx.chunkCount`。
 * 用可选的字段而不是"每阶段一个返回值"，是因为后续阶段往往要用到**前面好几步**的产物
 * （入库要用 `parsed.blocks` 的 meta 与 KB 的入库参数）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 阶段抛出的错误会变成用户的 `error_msg` ⇒ 文案必须是**可展示**的
 * ─────────────────────────────────────────────────────────────────────
 * worker 把失败的 `AppError.message` 原样写进 `documents.error_msg`（前端展示），
 * 所以本文件里的每一条错误消息都按"用户能不能照着做点什么"来写：
 * "对象存储里找不到《x》，请重新上传" / "文件内容与扩展名不符，请确认没有被改名" /
 * "解析结果内容过少……疑似扫描件，请上传可复制文本的文件" / "文本向量化失败（已重试 2 次）…"。
 * 技术细节（bucket、S3 键、阈值来源、堆栈）只进日志，不进消息。
 */

import type { Logger } from 'pino'

import { AppError, type ImageMode } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getS3Client } from '../infra/s3.js'
import type { EmbeddingProvider } from '../llm/embedding/index.js'
import { buildImageChunks, DEFAULT_CHUNK_MIN_CHARS, splitIntoChunks, type Chunk } from './chunk/index.js'
import { CHUNK_WRITE_BATCH, embedChunks, writeChunks } from './index/writer.js'
import { recognizeImage } from './ocr.js'
import { buildParseResult, detectFormat, parseDocument, type ParsedBlock, type ParsedImage, type ParseResult } from './parse/index.js'
import type { PipelineJob } from './queue.js'

/** 阶段需要知道的文档字段（worker 从 `documents` 行投影出来，不把整个 Prisma 行透传下去） */
export interface PipelineDocument {
  id: string
  kbId: string
  /** S3 键（上传时写的 `kb/{kbId}/{随机段}/source.{ext}`） */
  fileKey: string
  /** 展示用原始文件名（也用于**再判定一次**格式，见 `parseStage`） */
  fileName: string
  contentHash: string
  /**
   * 分块参数：来自**文档所属知识库**（KB 级参数建库时快照、此后独立可改，`子方案①` §十一）。
   * worker 用一次联表把它们带出来（`JOB_DOCUMENT_SELECT` 的 `kb` 片段），
   * 阶段就不必自己再查一遍库 —— 每个阶段各查一次是"一处数据、多处读法"的开端。
   */
  chunkSize: number
  chunkOverlap: number
  /** 分块策略（`hybrid` | `fixed`；由 `retrieval_config.splitStrategy` 补默认值后得来） */
  splitStrategy: string
  /** 图片处理方式（`documents.image_mode`；决定解析是否抽图、以及图片如何进链路） */
  imageMode: ImageMode
}

/** 一次任务处理的上下文（生命周期 = 一个 job） */
export interface PipelineContext {
  job: PipelineJob
  document: PipelineDocument
  /** 原始文件字节（`load-source` 写） */
  source?: Buffer
  /** 解析结果（`parse` 写；空文本检测、分块、P0-1-19 的入库都读它） */
  parsed?: ParseResult
  /** 已切好的块（`chunk` 写；`embed` 读它、`index` 落库） */
  chunks?: Chunk[]
  /** 与 `chunks` 逐条对应的向量（`embed` 写；`index` 读它） */
  vectors?: number[][]
  /** 落库用的模型标识（`embed` 写 `EmbeddingProvider.name()`；`index` 写进每行 `meta.embeddingName`） */
  embeddingName?: string
  /**
   * 该库选定的 embedding provider（**worker 解析后注入**，`embed` 读它向量化）。
   *
   * ⚠️ 由 worker 注入而不是阶段自己查库：阶段层刻意不碰数据库（见 `stages.ts` 文件头），
   *    而"这个库用哪个模型"正是 worker 从 `kb.embedding_model_id` 解析出来的一次查询。
   */
  embeddingProvider?: EmbeddingProvider
  /** 该库 embedding 向量的维度（worker 注入；`index` 写进 `chunks.embedding_dim`） */
  embeddingDim?: number
  /** 单批文本数（worker 注入；来自 `EMBEDDING_BATCH_SIZE`） */
  embeddingBatchSize?: number
  /**
   * 已入库的 chunk 数（`index` 写）。
   *
   * ⚠️ **只有真的写进 `chunks` 表之后才可以写它** —— 它同时是 worker 落 `documents.chunk_count`
   * 的唯一来源（`schema.prisma` 对那一列的定义是"**已入库**的 chunk 数"）。
   * P0-1-18 曾刻意留空（那时只"算"不"存"），P0-1-19 起由 `indexStage` 填真数。
   */
  chunkCount?: number
  /** 带 docId 的子日志（阶段里别用 `getLogger()` —— 那会丢掉"哪个文档"这个最关键的信息） */
  log: Logger
}


/** 一个处理阶段：可以独立成功/失败、独立被替换（验收注入假阶段） */
export interface PipelineStage {
  /** 阶段名（日志与验收断言用它定位"卡在哪一步"） */
  name: string
  run: (ctx: PipelineContext) => Promise<void>
}

/**
 * ③ 读取原文件（S3 → 内存）。
 *
 * 单独成阶段（而不是并在 `parse` 里）是为了**失败归因**：`documents.error_msg` 要能区分
 * "文件取不到"（存储侧问题，重传即可）与"文件解析不了"（文件本身的问题，得换文件）。
 * 两者对用户的下一步动作完全不同。
 */
export const loadSourceStage: PipelineStage = {
  name: 'load-source',
  async run(ctx) {
    ctx.source = await readSourceObject(ctx.document)
  },
}

/**
 * 从 S3 读回原文件。
 * 空文件在这里也拦一道：上传侧已拦过 0 字节（`routes/documents.ts`），但对象可能被外部替换成
 * 空对象 —— 那时"解析出 0 字"会被 P0-1-18 判成"疑似扫描件"，指向完全错误的排查方向。
 */
async function readSourceObject(document: PipelineDocument): Promise<Buffer> {
  const bucket = config.s3.bucket
  const key = document.fileKey
  try {
    const stream = await getS3Client().getObject(bucket, key)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length === 0) {
      throw AppError.validation(`原文件《${document.fileName}》是空的（0 字节），无法解析。请重新上传。`)
    }
    return bytes
  } catch (error) {
    // AppError 是我们自己刚抛的那条（空文件），原样上抛；其余（NoSuchKey / 网络 / 权限）统一翻译
    if (error instanceof AppError) throw error
    getLogger().error({ err: error, bucket, key, docId: document.id }, '读取原文件失败')
    throw AppError.internal(
      `原文件读取失败：对象存储里找不到《${document.fileName}》，可能已被清理。请重新上传该文档。`,
    )
  }
}

/**
 * 解析（③ 的后半：格式判定 + 分发到四个解析器）。
 *
 * ⚠️ 这里**再跑一次** P0-1-16 的 `detectFormat`，不是多余：上传时校验的是**客户端发来的字节**，
 * 而此刻读到的是**存储里的字节**。两者不一致（对象被换、前缀串了、手工塞过一个文件）时，
 * 只有对"手上的字节"重跑判定才拦得住；顺带也拿到了"该用哪个解析器"这个事实 ——
 * 比"从 S3 键后缀猜格式"可靠（键是人写的，字节是物证）。
 * 再跑一次不需要声明 MIME（那是客户端的声明，此刻已经没有意义），故 `declaredMime` 不传。
 *
 * 抛出的错误已是可展示文案：`detectFormat`/四个解析器的 `AppError.validation` 都是中文可操作提示。
 */
export const parseStage: PipelineStage = {
  name: 'parse',
  async run(ctx) {
    const source = ctx.source
    if (source === undefined) {
      // 纯编程错误（阶段数组配错），不是用户能处理的事 —— 但也不能静默
      throw new Error('流水线配置错误：parse 阶段之前必须有一个 load-source 阶段')
    }
    const format = detectFormat({ fileName: ctx.document.fileName, bytes: source })
    const extractImages = ctx.document.imageMode !== 'NONE'
    const parsed = await parseDocument(format, source, {
      extractImages,
      maxImageBytes: config.pipeline.imageMaxBytes,
    })
    // 图片数量上限：防止"一本图册"把 OCR / 向量化拖成分钟级（超出部分忽略并记日志）
    if (parsed.images.length > config.pipeline.imageMaxCount) {
      ctx.log.warn(
        { found: parsed.images.length, capped: config.pipeline.imageMaxCount },
        '文档图片数超过上限，仅处理前若干张（IMAGE_MAX_COUNT）',
      )
      parsed.images = parsed.images.slice(0, config.pipeline.imageMaxCount)
    }
    ctx.parsed = parsed
    ctx.log.debug(
      {
        format,
        blocks: parsed.blocks.length,
        images: parsed.images.length,
        imageMode: ctx.document.imageMode,
        chars: parsed.meta.charCount,
        pageCount: parsed.meta.pageCount,
        encoding: parsed.meta.encoding,
        hasHeadings: parsed.meta.hasHeadings,
      },
      '解析完成',
    )
  },
}

/**
 * ③·补 图片 OCR（`子方案` 文档图片解析；仅 `imageMode=OCR` 生效）。
 *
 * 把抽取出的图片逐张本地 OCR，识别出的文字作为**普通文本块**追加回解析结果，
 * 于是下游（空文本检测、分块、向量化）**一行都不用改** —— OCR 与文本走同一条链路。
 * 处理完清空 `parsed.images`（图片已转成文字，不再需要图片分块）。
 *
 * 放在空文本检测**之前**：扫描件 PDF 常"零文本 + 全是图"，OCR 出的文字必须先算进
 * `charCount`，否则会被 §五 误判为"疑似扫描件"直接 FAILED。
 */
export const ocrImagesStage: PipelineStage = {
  name: 'ocr-images',
  async run(ctx) {
    const parsed = requireParsed(ctx, 'ocr-images')
    if (ctx.document.imageMode !== 'OCR' || parsed.images.length === 0) return

    // 按锚点把图片分回它在正文里的位置：`anchor = n` 表示"插在 `blocks[n]` 之前"。
    // 这样"订单入口"那张图的 OCR 文字就落在"订单入口"这段话后面，而不是全堆到文末。
    const byAnchor = new Map<number, ParsedImage[]>()
    const tail: ParsedImage[] = []
    for (const image of parsed.images) {
      if (image.anchor === undefined || image.anchor === null) {
        tail.push(image)
        continue
      }
      const key = Math.max(0, Math.min(image.anchor, parsed.blocks.length))
      const list = byAnchor.get(key)
      if (list === undefined) byAnchor.set(key, [image])
      else list.push(image)
    }

    const ocrBlockOf = async (image: ParsedImage): Promise<ParsedBlock | null> => {
      const text = await recognizeImage(image.data, (message, msg) => ctx.log.warn(message, msg))
      if (text === '') return null
      return {
        text: `[图片文字] ${text}`,
        headingPath: [...image.headingPath],
        page: image.page,
      }
    }

    // 一次遍历重建块序列：在 `blocks[i]` 之前插入锚在 i 的图片文字
    const outBlocks: ParsedBlock[] = []
    for (let i = 0; i <= parsed.blocks.length; i += 1) {
      for (const image of byAnchor.get(i) ?? []) {
        const block = await ocrBlockOf(image)
        if (block !== null) outBlocks.push(block)
      }
      const original = parsed.blocks[i]
      if (original !== undefined) outBlocks.push(original)
    }
    for (const image of tail) {
      const block = await ocrBlockOf(image)
      if (block !== null) outBlocks.push(block)
    }

    // 用统一的收口函数重建 text/meta（与解析器同一条口径，避免字符计数算法分叉）
    ctx.parsed = buildParseResult(parsed.meta.format, outBlocks, {
      pageCount: parsed.meta.pageCount,
      encoding: parsed.meta.encoding,
      images: [],
    })
    ctx.log.debug(
      { images: parsed.images.length, blocks: outBlocks.length },
      '图片 OCR 完成（按原位置并入文本块）',
    )
  },
}

/** 取上游阶段的产物；缺失说明**阶段数组配错了**（编程错误，不是用户能处理的事） */
function requireParsed(ctx: PipelineContext, stage: string): ParseResult {
  const parsed = ctx.parsed
  if (parsed === undefined) {
    throw new Error(`流水线配置错误：${stage} 阶段之前必须有一个 parse 阶段`)
  }
  return parsed
}

/**
 * ④ 空文本检测（`子方案①` §五）。
 *
 * 判据是**全文有效字符总数**（`parsed.meta.charCount`，去空白、按码点计），低于
 * `EMPTY_TEXT_THRESHOLD`（默认 50）即判失败。三处口径值得写下为什么：
 *
 * · **放在解析之后而不是上传之前**：上传时无从知道内容量 —— 一个 8MB 的 PDF 可能只有
 *   47 个字（扫描件），一个 2KB 的 txt 也可能有 2000 字。只能等解析结果。
 * · **按全文总量判，不按页判**：多页文档的封面页/目录页本身就近乎空白，
 *   按页判会把大量正常文档误杀（§五 明确点名了这条）。
 * · **失败但不删原文件**：用户得能下载回去核对"我传的到底是不是扫描件"
 *   （S3 对象由上传侧管理，本阶段不碰它）。
 *
 * 混合型文档（部分页有文本、部分页是扫描图）在这里**不会被拦**：全文总量通常够，
 * 结果是"只有文本的页进入检索"——§五 接受这个降级，并在文档列表页给弱提示。
 */
export const detectEmptyTextStage: PipelineStage = {
  name: 'detect-empty-text',
  async run(ctx) {
    const parsed = requireParsed(ctx, 'detect-empty-text')
    const threshold = config.pipeline.emptyTextThreshold
    const charCount = parsed.meta.charCount
    // 有图片（且选了图片解析方式）时不算"空"：纯图片文档/扫描件正是该被处理的场景，
    // 图片会被 OCR 转成文字（OCR 模式）或直接向量化（MULTIMODAL 模式）
    if (charCount < threshold && parsed.images.length === 0) {
      ctx.log.warn(
        { charCount, threshold, pageCount: parsed.meta.pageCount, format: parsed.meta.format },
        '空文本检测未通过（阈值来自 EMPTY_TEXT_THRESHOLD）',
      )
      throw AppError.validation(buildEmptyTextMessage(charCount, threshold))
    }
  },
}

/**
 * 空文本检测的**失败文案**（`子方案①` §五 的原文 + 具体数字）。
 *
 * 数字来自实测（`charCount` 与当前阈值）而不是把 50 写死在文案里：阈值是可配的
 * （`EMPTY_TEXT_THRESHOLD`），写死的话管理员调成 200 之后，用户看到的报错仍说"<50"，
 * 于是他改成一个 60 字的文件重传、再次失败 —— 报文与判据不一致是这类问题里最难查的一种。
 *
 * 导出它只为验收能逐字断言（`verify:pipeline` 的 I 组），业务代码请直接用阶段。
 */
export function buildEmptyTextMessage(charCount: number, threshold: number): string {
  return (
    `解析结果内容过少（有效字符 ${charCount}，不足 ${threshold} 个），疑似扫描件或空白文档；` +
    '若文档内容是图片（扫描件/截图），请在上传时选择"解析图片"方式（OCR 或多模态向量化）后重传。'
  )
}

/**
 * ⑤ 分块（`子方案①` §4-2，策略可插拔 —— 实现在 `chunk/`）。
 *
 * 只负责"切"，**不负责"存"**：产物放 `ctx.chunks`，落库是 ⑦ {@link indexStage} 的事。
 * 两者分开是因为失败归因完全不同 —— "切不出来"（文档的问题）与"写不进去"（库/存储的问题）
 * 对用户的下一步动作毫无共同点。
 *
 * P0-1-18 时它连 `chunk_count` 都不写（那时 ⑦ 还没实现，写了就会造出"说有 N 块却搜不到"）；
 * P0-1-19 起 `chunk_count` 由 ⑦ 写**真数**，本阶段仍然只碰 `ctx.chunks`。
 */
export const chunkStage: PipelineStage = {
  name: 'chunk',
  async run(ctx) {
    const parsed = requireParsed(ctx, 'chunk')
    const document = ctx.document
    const options = {
      chunkSize: document.chunkSize,
      chunkOverlap: document.chunkOverlap,
      // §二 的 `chunk_min`；见 `chunk/strategy.ts` 的 `DEFAULT_CHUNK_MIN_CHARS`（不是环境变量）
      chunkMin: DEFAULT_CHUNK_MIN_CHARS,
    }
    const textChunks = splitIntoChunks(parsed, options, document.splitStrategy)
    // `MULTIMODAL`：文本块之外再产图片块，并按块起点偏移**归并回原位**。
    // `OCR` 的图片已在 ocr 阶段变成文本块，`NONE` 没有图片 —— 两者都不会走到这里。
    const imageChunks =
      document.imageMode === 'MULTIMODAL' && parsed.images.length > 0
        ? buildImageChunks(parsed.images, parsed.blocks)
        : []
    // 归并排序：同偏移时保持"文本块在前"（稳定用原始下标兜底）；最后统一重排 `seq`
    const ordered = [...textChunks, ...imageChunks]
      .map((chunk, index) => ({ chunk, index }))
      .sort(
        (a, b) =>
          (a.chunk.offset ?? Number.POSITIVE_INFINITY) - (b.chunk.offset ?? Number.POSITIVE_INFINITY) ||
          a.index - b.index,
      )
      .map((entry, seq) => ({ ...entry.chunk, seq }))
    ctx.chunks = ordered
    ctx.log.debug(
      {
        strategy: document.splitStrategy,
        chunkSize: options.chunkSize,
        chunkOverlap: options.chunkOverlap,
        chunks: textChunks.length,
        imageChunks: imageChunks.length,
        chars: parsed.meta.charCount,
      },
      '分块完成（向量化与落库属 ⑥⑦）',
    )
  },
}

/** 取 ⑤ 的产物；缺失说明阶段数组配错了（与 {@link requireParsed} 同款） */
function requireChunks(ctx: PipelineContext, stage: string): Chunk[] {
  const chunks = ctx.chunks
  if (chunks === undefined) {
    throw new Error(`流水线配置错误：${stage} 阶段之前必须有一个 chunk 阶段`)
  }
  return chunks
}

/**
 * ⑥ embedding（`子方案①` §4-3）—— 批 32、单批失败重试 2 次（退避 1s/3s）。
 *
 * 实现在 `pipeline/index/writer.ts` 的 `embedChunks()`：本阶段只做"接线 + 失败归因"。
 * 失败时抛的是 `AppError`，消息直接给用户看（"文本向量化失败（已重试 2 次）…"）——
 * 失败最集中的这一环（配置缺项、上游不可达、维度不符）必须让用户看得出是**环境/上游**的问题，
 * 而不是"我的文档坏了"，否则他会去重传一个没问题的文件。
 */
export const embedStage: PipelineStage = {
  name: 'embed',
  async run(ctx) {
    const chunks = requireChunks(ctx, 'embed')
    const provider = ctx.embeddingProvider
    const batchSize = ctx.embeddingBatchSize
    if (provider === undefined || batchSize === undefined) {
      throw new Error('流水线配置错误：embed 阶段需要 worker 注入 embeddingProvider / embeddingBatchSize')
    }
    const { vectors, embeddingName } = await embedChunks(chunks, provider, batchSize, ctx.log)
    ctx.vectors = vectors
    ctx.embeddingName = embeddingName
    ctx.log.debug({ chunks: chunks.length, embeddingName, dim: ctx.embeddingDim ?? null }, '向量化完成')
  },
}

/**
 * ⑦ 入库（`子方案①` §4-4/§三）—— 事务内"先删后建"，返回写入行数。
 *
 * 产物写进 `ctx.chunkCount`，worker 据此落 `documents.chunk_count`。**这是全仓唯一**
 * 允许写那一列的地方（见 {@link PipelineContext.chunkCount} 的注释）。
 *
 * 与 ⑤ 的关系：⑦ 结束之后"库里的 chunk 集合"就等于 ⑤ 切出来的那一套 ——
 * 这也是 `§七` 的"无重复、无孤儿"在**代码层面**的定义。
 */
export const indexStage: PipelineStage = {
  name: 'index',
  async run(ctx) {
    const chunks = requireChunks(ctx, 'index')
    const vectors = ctx.vectors
    const embeddingName = ctx.embeddingName
    const embeddingDim = ctx.embeddingDim
    if (vectors === undefined || embeddingName === undefined || embeddingDim === undefined) {
      throw new Error('流水线配置错误：index 阶段之前必须有一个 embed 阶段，且 worker 已注入 embeddingDim')
    }
    ctx.chunkCount = await writeChunks({
      docId: ctx.document.id,
      kbId: ctx.document.kbId,
      chunks,
      vectors,
      embeddingName,
      embeddingDim,
    })
    ctx.log.debug(
      { chunkCount: ctx.chunkCount, embeddingName, batch: CHUNK_WRITE_BATCH },
      'chunk 已入库（同一文档的 chunk 集合被整次替换）',
    )
  },
}

/**
 * 默认阶段序列：③ 解析 → ④ 空文本检测 → ⑤ 分块 → ⑥ embedding → ⑦ 入库。
 *
 * ⚠️ 顺序不可换，三条理由各不相同：
 * · 空文本检测必须在分块**之前**（§五 的流程图）。反过来会先白切一遍再判失败，
 *   且"块数为 0 却报句子级错误"会把排查方向带偏。
 * · 分块必须在 embedding **之前**：embedding 的输入就是块（切法变了向量就该重算）。
 * · 入库必须在 embedding **之后**且**只此一次**：向量与块是同一条记录的两半，
 *   分开写会出现"有块没向量"（检索里它永远排不上号）或"有向量没块"。
 *
 * ⚠️ 至此 `READY` 的语义才完整：**"可检索"**（`chunks` 表有行、每行都有向量、
 * `documents.chunk_count` 与之一致）。P0-1-18 那段"只算不存"到此结束。
 * 仍差的一步是**检索端点本身**（P0-1-20）与文档列表端点（P0-1-21）。
 */
export const defaultPipelineStages: readonly PipelineStage[] = [
  loadSourceStage,
  parseStage,
  // 图片 OCR（仅 imageMode=OCR 生效；无图片/其它模式时是 no-op）
  ocrImagesStage,
  detectEmptyTextStage,
  chunkStage,
  embedStage,
  indexStage,
]

