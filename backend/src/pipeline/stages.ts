/**
 * 流水线阶段（P0-1-17 定骨架；P0-1-18/19 在此中间插入阶段）
 *
 * 依据：`docs/子方案/知识库流水线.md` §三（流程总览 ③~⑧）、§4-1（解析）、§4-2（分块）、§4-4（入库）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么把"处理步骤"从 worker 里拆出来
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §三 的流水线是**八个步骤**，本批只到 ③（解析）：④ 空文本检测与 ⑤ 分块是 P0-1-18，
 * ⑥ embedding 与 ⑦ 入库是 P0-1-19。若把这几步直接写在 worker 的循环里，每批都要改那个循环
 * （并发、幂等、状态机写入全在同一段代码里），风险最高的那部分代码会被改三次。
 * 拆成"阶段数组"之后：**每批只往数组中间插一个阶段**，worker 的并发/幂等/失败处理一行不动。
 * 另一个直接收益是验收可注入：`startPipelineWorker({ stages })` 能塞一组慢速假阶段，
 * 从而**确定性地**观测并发闸与幂等（见 `verify-pipeline.mjs` 的 D 组）。
 *
 * 阶段之间的数据传递只有一个方向：`load-source` 写 `ctx.source` → `parse` 读它、写 `ctx.parsed`
 * → （P0-1-19 的 `index` 读 `parsed`、写 `chunkCount`）。用可选的字段而不是"每阶段一个返回值"，
 * 是因为后续阶段往往要用到**前面好几步**的产物（入库要用 `parsed.blocks` 的 meta 与 KB 的入库参数）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 阶段抛出的错误会变成用户的 `error_msg` ⇒ 文案必须是**可展示**的
 * ─────────────────────────────────────────────────────────────────────
 * worker 把失败的 `AppError.message` 原样写进 `documents.error_msg`（前端展示），
 * 所以本文件里的每一条错误消息都按"用户能不能照着做点什么"来写：
 * "对象存储里找不到《x》，请重新上传" / "文件内容与扩展名不符，请确认没有被改名"。
 * 技术细节（bucket、S3 键、堆栈）只进日志，不进消息。
 */

import type { Logger } from 'pino'

import { AppError } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getS3Client } from '../infra/s3.js'
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
}

/** 一次任务处理的上下文（生命周期 = 一个 job） */
export interface PipelineContext {
  job: PipelineJob
  document: PipelineDocument
  /** 原始文件字节（`load-source` 写） */
  source?: Buffer
  /** 解析结果（`parse` 写；P0-1-18 的空文本检测与分块、P0-1-19 的入库都读它） */
  parsed?: ParseResult
  /** 已入库的 chunk 数（P0-1-19 的 `index` 写；本批不写 ⇒ worker 落 0） */
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
      '解析完成（分块与入库属 P0-1-18/19，本批到这一步为止）',
    )
  },
}

/**
 * 默认阶段序列（当前只有 ③ 解析；④⑤ 由 P0-1-18、⑥⑦ 由 P0-1-19 插进来）。
 *
 * ⚠️ 本批的产物是**骨架**：解析成功后 worker 直接把文档置 `READY`，而 `chunk_count` 仍是 0、
 * chunk 一行也没有 ⇒ 此刻 `READY` 的含义是"解析这一关过了"，还不是"可检索"。
 * 这是**中间态**，P0-1-18/19 完成后才有真正的 `chunk_count=N`；验收（`verify-pipeline.mjs`）
 * 对这一点的断言写在明处：`chunkCount === 0` 是**预期**，不是漏了。
 * 另外 `子方案①` §五 的"空文本检测"也在 P0-1-18 ⇒ 本批"扫描件"（解析出 0 字）也会变 `READY`。
 */
export const defaultPipelineStages: readonly PipelineStage[] = [loadSourceStage, parseStage]
