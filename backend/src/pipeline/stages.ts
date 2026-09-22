/**
 * 流水线阶段（P0-1-17 定骨架；P0-1-18 插入空文本检测与分块；P0-1-19 再插 embedding 与入库）
 *
 * 依据：`docs/子方案/知识库流水线.md` §三（流程总览 ③~⑧）、§4-1（解析）、§4-2（分块）、
 *      §五（空文本检测）、§4-4（入库）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么把"处理步骤"从 worker 里拆出来
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §三 的流水线是**八个步骤**，P0-1-17 只到 ③（解析），本批补上 ④（空文本检测）
 * 与 ⑤（分块），⑥ embedding 与 ⑦ 入库留给 P0-1-19。若把这几步直接写在 worker 的循环里，
 * 每批都要改那个循环（并发、幂等、状态机写入全在同一段代码里），风险最高的那部分代码
 * 会被改三次。拆成"阶段数组"之后：**每批只往数组中间插一个阶段**，worker 的并发/幂等/
 * 失败处理一行不动（P0-1-18 实证：`worker.ts` 本批只改了一处 select，见其注释）。
 * 另一个直接收益是验收可注入：`startPipelineWorker({ stages })` 能塞一组慢速假阶段，
 * 从而**确定性地**观测并发闸与幂等（见 `verify-pipeline.mjs` 的 E 组）。
 *
 * 阶段之间的数据传递只有一个方向：`load-source` 写 `ctx.source` → `parse` 读它、写 `ctx.parsed`
 * → `detect-empty-text`/`chunk` 读 `parsed`（后者写 `ctx.chunks`）→（P0-1-19 的 `index`
 * 读 `parsed`/`chunks`、写 `ctx.chunkCount`）。用可选的字段而不是"每阶段一个返回值"，
 * 是因为后续阶段往往要用到**前面好几步**的产物（入库要用 `parsed.blocks` 的 meta 与 KB 的入库参数）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 阶段抛出的错误会变成用户的 `error_msg` ⇒ 文案必须是**可展示**的
 * ─────────────────────────────────────────────────────────────────────
 * worker 把失败的 `AppError.message` 原样写进 `documents.error_msg`（前端展示），
 * 所以本文件里的每一条错误消息都按"用户能不能照着做点什么"来写：
 * "对象存储里找不到《x》，请重新上传" / "文件内容与扩展名不符，请确认没有被改名" /
 * "解析结果内容过少……疑似扫描件，请上传可复制文本的文件"。
 * 技术细节（bucket、S3 键、阈值来源、堆栈）只进日志，不进消息。
 */

import type { Logger } from 'pino'

import { AppError } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getS3Client } from '../infra/s3.js'
import { DEFAULT_CHUNK_MIN_CHARS, splitIntoChunks, type Chunk } from './chunk/index.js'
import { detectFormat, parseDocument, type ParseResult } from './parse/index.js'
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
}

/** 一次任务处理的上下文（生命周期 = 一个 job） */
export interface PipelineContext {
  job: PipelineJob
  document: PipelineDocument
  /** 原始文件字节（`load-source` 写） */
  source?: Buffer
  /** 解析结果（`parse` 写；空文本检测、分块、P0-1-19 的入库都读它） */
  parsed?: ParseResult
  /** 已切好的块（`chunk` 写；P0-1-19 的 `index` 读它并落库） */
  chunks?: Chunk[]
  /**
   * 已入库的 chunk 数（P0-1-19 的 `index` 写）。
   *
   * ⚠️ **只有真的写进 `chunks` 表之后才可以写它** —— P0-1-18 已经把块算出来了，
   * 但落库属 P0-1-19，故本批**刻意不写**（`chunks` 表一行也没有）。理由见
   * {@link chunkStage} 的注释与 `schema.prisma` 对 `chunk_count` 的定义。
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
    const parsed = await parseDocument(format, source)
    ctx.parsed = parsed
    ctx.log.debug(
      {
        format,
        blocks: parsed.blocks.length,
        chars: parsed.meta.charCount,
        pageCount: parsed.meta.pageCount,
        encoding: parsed.meta.encoding,
        hasHeadings: parsed.meta.hasHeadings,
      },
      '解析完成',
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
    if (charCount < threshold) {
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
    '本系统暂不支持图片型 PDF，请上传可复制文本的文件。'
  )
}

/**
 * ⑤ 分块（`子方案①` §4-2，策略可插拔 —— 实现在 `chunk/`）。
 *
 * ⚠️ **本批只"算"不"存"**：块已经切出来了（`ctx.chunks`），但**刻意不写 `chunk_count`**
 * （更不写 `chunks` 表 —— 那是 P0-1-19 的 `index` 阶段，要连 embedding 一起事务写入）。
 *
 * 为什么不让 worker 顺手把块数写进 `documents.chunk_count`：
 * `schema.prisma` 对那一列的定义是"**已入库**的 chunk 数"，而本批库里一行 chunk 都没有。
 * 写了它就会出现"接口说这个文档有 12 块、检索却什么也搜不到"，且 P0-1-19 还得回头把它
 * 改成"其实没入库"——不如让它老实停在 0，把"READY = 解析与分块都过了，但还不可检索"
 * 这个中间态**暴露出来**（这也是 `docs/06` 本批边界那一条的凭据）。
 * 分块结果进日志（`chunks` 条数），于是"切了几块"依然可观测。
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
    const chunks = splitIntoChunks(parsed, options, document.splitStrategy)
    ctx.chunks = chunks
    ctx.log.debug(
      {
        strategy: document.splitStrategy,
        chunkSize: options.chunkSize,
        chunkOverlap: options.chunkOverlap,
        chunks: chunks.length,
        chars: parsed.meta.charCount,
      },
      '分块完成（写入 chunks 表与 chunk_count 属 P0-1-19，本批不落库）',
    )
  },
}

/**
 * 默认阶段序列：③ 解析 → ④ 空文本检测 → ⑤ 分块（⑥⑦ 由 P0-1-19 插进来）。
 *
 * ⚠️ 顺序不可换：空文本检测必须在分块**之前**（§五 的流程图就是"解析完成 → 判空 → 继续分块"）。
 * 反过来的话，一份扫描件会先被切成若干块、再被判失败 —— 白干一遍，且失败文案里
 * "chunk 数为 0"的直觉会不成立。
 *
 * ⚠️ 本批的 `READY` 含义推进了半步：现在是"解析**与分块**都过了"，但**仍不是"可检索"**
 * （`chunk_count` 仍是 0、chunk 一行也没有 ⇒ ⑥⑦ 属 P0-1-19）。验收对这一点有明写的断言
 * （`verify-pipeline.mjs` 的 C 组：`chunkCount === 0` 是**预期**，不是漏了）。
 *
 * 本批之后仍未做的边界：扫描件**会被**正确拦下（本批补上 ④），但"解析出 0 字"以外的
 * 低质量解析（如全篇乱码、表格错行）不判；分块结果**不入库**，故检索要到 P0-1-20 才有。
 */
export const defaultPipelineStages: readonly PipelineStage[] = [
  loadSourceStage,
  parseStage,
  detectEmptyTextStage,
  chunkStage,
]

