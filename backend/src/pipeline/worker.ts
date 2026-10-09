/**
 * 流水线 worker（P0-1-17 骨架）
 *
 * 依据：`docs/子方案/知识库流水线.md` §十（异步队列与并发）+ §三（幂等/失败两段）、
 *      `docs/02-后端设计.md` §二（"仅文档流水线 worker 作为**进程内**异步任务"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本模块只做"机制"，不做"处理"
 * ─────────────────────────────────────────────────────────────────────
 * 机制 = 取件、并发闸、幂等判定、状态机写入、失败落 `error_msg`、可观测计数；
 * 处理 = 具体步骤（解析 / 空文本检测 / 分块 / 入库），在 `stages.ts`，可以整组替换（验收就是这么注入慢阶段的）。
 * 分开的直接收益：P0-1-18/19 各插一个阶段，**本文件一处都不用改** —— 而它恰好是风险最高的那段
 * （状态写坏、并发写重、失败没落库，任何一条都很难在事后发现）。
 *
 * ⚠️ P0-1-18 的实证（把这句"一处都不用改"订正得更准）：插入 ④⑤ 两个阶段时，本文件**只改了
 * 一处** —— `JOB_DOCUMENT_SELECT` 多带了 `kb` 的分块参数（`PipelineDocument` 的字段增量，
 * 是阶段间的数据契约，不是机制）。真正的机制（并发闸、四道幂等、CAS 写状态、失败翻译）
 * **一行未动** —— 这正是当初拆阶段数组要买到的东西。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 幂等有四道，缺一不可（`子方案①` §三 只写了第一道）
 * ─────────────────────────────────────────────────────────────────────
 * 取到 job 后按顺序判定：
 *   ① **同进程内在飞**（`inFlightDocIds`）→ 跳过。同一文档的两个 job 被连着取走时
 *      （比如用户双击上传、或重投了一次）必须只处理一次 —— 否则两条链路同时往同一文档写内容。
 *      本进程只有一个阻塞消费者，故"取走 → 登记"之间没有窗口，这条是**确定性**的。
 *   ② **文档已不存在**（被删了）→ 跳过。删库/删文档后队列里剩下的 job 是常态。
 *   ③ **`contentHash` 与 job 不符** → 跳过。这是 §三 的"content_hash 未变"那半句：
 *      文档在投递之后被重新上传过，这个 job 描述的是**旧内容**，再跑一遍只会把新内容按旧任务算。
 *   ④ **已是 `READY`** → 跳过（§三 的原话）。前三条是"文档变了"，这条是"活已经干完了"。
 * 四条都跳过时**一个字节都不写库**（验收里"重复投递不产生重复写入"就是断言 `updatedAt` 逐字不变）。
 * 反过来：`PARSING` 与 `FAILED` 且 hash 相符的 job **会真的处理** —— 这正是"队列不保证送达"的
 * 补救口：worker 崩溃后重投同一个 job，文档就能从 `PARSING`/`FAILED` 重新走到 `READY`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 失败要区分"文档的问题"与"基础设施的问题"（但两者都得落库）
 * ─────────────────────────────────────────────────────────────────────
 * 阶段抛出的错 → `FAILED` + `error_msg`（可展示）。读行这一步就失败（PG 挂了）→ **不写状态**，
 * 只记日志：那是"我们查不了"，不是"这个文档坏了"，把基础设施故障写成业务失败会让用户去重传
 * 一个其实没问题的文件。代价是文档停在 `PARSING` —— 这正是重试入口要覆盖的场景。
 *
 * ⚠️ 与 `app.ts` 的分工：worker **不在** `buildApp()` 里启动（否则 `verify:app` 这种
 *    不需要 Redis 的契约验收会被迫连队列，`app.inject` 也会莫名其妙开始消费任务）。
 *    启停在**进程入口** `index.ts`（listen 成功后 start、优雅退出时 stop）。
 */

import type { Logger } from 'pino'

import { AppError, canTransitionDocumentStatus, MULTIMODAL_MODEL_REQUIRED_HINT, normalizeRetrievalConfig, type DocumentStatus, type ImageRecognition } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import type { LlmTarget } from '../llm/client.js'
import { buildPoolEmbeddingProvider } from '../llm/embedding/index.js'
import { resolveChatTarget, resolveEmbeddingTarget } from '../services/model.service.js'
import { closePipelineQueue, dequeuePipelineJob, pipelineQueueKey, type PipelineJob } from './queue.js'
import { defaultPipelineStages, type PipelineDocument, type PipelineContext, type PipelineStage } from './stages.js'

/** 取件循环出错（Redis 抖动）后的退避：够短以免"恢复后半天不干活"，够长以免刷屏 */
const LOOP_FAILURE_BACKOFF_MS = 1_000

/** 停止时等在途任务的宽限（超过就放弃等待并记日志；`index.ts` 的退出兜底是 10s，这里要更短） */
const DEFAULT_STOP_GRACE_MS = 5_000

/** `error_msg` 的长度上限（数据库是 `text`，不设限也没事；但界面上一条几百字的报错没人看） */
const FAILED_MESSAGE_MAX_CHARS = 300

/** worker 从 `documents` 行里取的最小投影（阶段要用的字段，不含 chunk 等无关列） */
const JOB_DOCUMENT_SELECT = {
  id: true,
  kbId: true,
  fileKey: true,
  fileName: true,
  contentHash: true,
  status: true,
  imageRecognize: true,
  imageVectorize: true,
  /**
   * 分块参数住在**知识库**上（`chunk_size` / `chunk_overlap` 两列 + `retrieval_config.splitStrategy`），
   * 而处理一份文档离不开它们（P0-1-18 的 chunk 阶段要用）。
   * 用一次联表带出来，而不是让阶段自己再查一遍库：三个阶段各查一次就是"同一份数据、三种读法"
   * 的开始，而且那三次查询都发生在**已经拿到行之后**，纯粹是白花的往返。
   */
  kb: {
    select: {
      chunkSize: true,
      chunkOverlap: true,
      retrievalConfig: true,
      // 该库选定的 embedding 模型 + 维度（本批起入库用它，而不是进程级环境变量）
      embeddingModelId: true,
      embeddingDim: true,
      // 该库选定的图片描述模型（P1-11；可空 = 该库不产出图片描述）
      captionModelId: true,
    },
  },
} as const

/** 可观测计数（验收断言并发与幂等靠它；也是将来 `/health` 或运维面板的雏形） */
export interface PipelineWorkerStats {
  running: boolean
  /** 当前队列键（换键即换队列，见 `PIPELINE_QUEUE_KEY`） */
  queueKey: string
  concurrency: number
  /** 阶段名序列（能一眼看出跑的是哪几个阶段） */
  stages: string[]
  /** 当前在途任务数 */
  inFlight: number
  /** 历史峰值（验收据此断言"并发没超过上限，且确实用满了"） */
  peakInFlight: number
  processed: number
  failed: number
  /** 跳过计数，按原因分组（`duplicate-inflight` / `doc-missing` / `stale` / `already-ready`） */
  skipped: Record<string, number>
}

export interface StartPipelineWorkerOptions {
  /** 阶段序列（默认 {@link defaultPipelineStages}）。验收注入慢速假阶段以确定性观测并发 */
  stages?: readonly PipelineStage[]
  /** 并发上限（默认为 `PIPELINE_CONCURRENCY`，config 已保证 ≥1） */
  concurrency?: number
}

interface WorkerState {
  running: boolean
  stages: readonly PipelineStage[]
  concurrency: number
  inFlight: number
  peakInFlight: number
  processed: number
  failed: number
  skipped: Record<string, number>
  /** 正在处理中的文档 id（幂等第 ① 道；见文件头） */
  inFlightDocIds: Set<string>
  /** 在途任务的 promise（停止时等它们收尾） */
  inFlightTasks: Set<Promise<void>>
  /** 等待"空出一个槽位"的唤醒函数 */
  slotWaiters: Array<() => void>
  loopTask: Promise<void> | undefined
}

const state: WorkerState = {
  running: false,
  stages: defaultPipelineStages,
  concurrency: 1,
  inFlight: 0,
  peakInFlight: 0,
  processed: 0,
  failed: 0,
  skipped: {},
  inFlightDocIds: new Set(),
  inFlightTasks: new Set(),
  slotWaiters: [],
  loopTask: undefined,
}

/** 取一份计数快照（**同步** —— 全是内存里的数，验收可以高频轮询） */
export function getPipelineWorkerStats(): PipelineWorkerStats {
  return {
    running: state.running,
    queueKey: pipelineQueueKey(),
    concurrency: state.concurrency,
    stages: state.stages.map((stage) => stage.name),
    inFlight: state.inFlight,
    peakInFlight: state.peakInFlight,
    processed: state.processed,
    failed: state.failed,
    skipped: { ...state.skipped },
  }
}

/** worker 是否在跑（`index.ts` 的退出流程与验收收尾都会问一句） */
export function isPipelineWorkerRunning(): boolean {
  return state.running
}

/**
 * 启动 worker（**幂等**：已在跑就只告警并返回当前计数）。
 *
 * 刻意是同步函数：它只登记状态并 kick 出一个循环，不占用调用方的启动时序
 * （`index.ts` 在 listen 成功之后调用，不能因为队列抖动而卡住启动）。
 */
export function startPipelineWorker(options: StartPipelineWorkerOptions = {}): PipelineWorkerStats {
  const log = getLogger()
  if (state.running) {
    log.warn('文档流水线 worker 已在运行，本次启动被忽略')
    return getPipelineWorkerStats()
  }

  state.stages = options.stages ?? defaultPipelineStages
  // `options.concurrency` 是验收用的注入口，故这里也兜一道底（config 侧 intVar 已保证 ≥1）
  state.concurrency = Math.max(1, options.concurrency ?? config.concurrency.pipeline)
  state.inFlight = 0
  state.peakInFlight = 0
  state.processed = 0
  state.failed = 0
  state.skipped = {}
  state.inFlightDocIds.clear()
  state.inFlightTasks.clear()
  state.slotWaiters = []
  state.running = true

  log.info(
    {
      queueKey: pipelineQueueKey(),
      concurrency: state.concurrency,
      stages: state.stages.map((stage) => stage.name),
    },
    '文档流水线 worker 已启动（进程内，消费 Redis List）',
  )
  state.loopTask = consumeLoop()
  return getPipelineWorkerStats()
}

/**
 * 停止 worker：① 停取件 → ② 打断挂起的 `BRPOP` → ③ 等在途任务收尾（有宽限）。
 *
 * 幂等；未启动时是空操作。`graceMs` 到期仍有在途任务时**照常返回**：调用方（进程退出）
 * 不能为了等一个卡住的任务而不退出 —— 那些文档会停在 `PARSING`，重投即可恢复
 * （这正是"List 无 ack ⇒ 必须有重试入口"的另一面，见 `queue.ts` 文件头）。
 */
export async function stopPipelineWorker(graceMs: number = DEFAULT_STOP_GRACE_MS): Promise<void> {
  const log = getLogger()
  if (!state.running && state.loopTask === undefined) return

  log.info({ inFlight: state.inFlight }, '正在停止文档流水线 worker')
  state.running = false
  releaseSlot()

  // ② 打断挂起的 BRPOP：断开专用连接会让它立刻以"连接已关闭"失败，循环随即退出
  await closePipelineQueue()

  const loop = state.loopTask
  state.loopTask = undefined
  if (loop !== undefined) await loop

  const pending = [...state.inFlightTasks]
  if (pending.length > 0) {
    const finished = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      delay(graceMs).then(() => false),
    ])
    if (!finished) {
      log.warn(
        { inFlight: state.inFlight, graceMs },
        '停止时仍有在途任务未收尾（相应文档会停在 PARSING，重新投递该任务即可恢复）',
      )
    }
  }

  state.inFlight = 0
  state.inFlightDocIds.clear()
  state.inFlightTasks.clear()
  log.info(getPipelineWorkerStats(), '文档流水线 worker 已停止')
}

// ═════════════════════════ 取件循环 ═════════════════════════

/** 睡眠（只用于退避与宽限，不用它做任何同步） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 不让这个定时器把进程留住（退出流程里我们不希望为退避再等 1 秒）
    timer.unref()
  })
}

/** 唤醒一个在等槽位的循环（槽位释放时调用） */
function releaseSlot(): void {
  const waiter = state.slotWaiters.shift()
  waiter?.()
}

/** 等一个空槽位（并发闸；见 {@link consumeLoop}） */
function waitForSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    state.slotWaiters.push(resolve)
  })
}

/**
 * 取件循环。
 *
 * 并发是"**取之前**先等槽位"而不是"取回来再排队"：取回来排队等于把队列里的任务挪到内存里排队，
 * 进程一崩这些任务既不在队列里、也没被处理 —— 而 List 又没有 ack，丢了就是丢了。
 * 只有一个阻塞消费者（一条 `BRPOP` 专线），所以并发度 = 在途任务数，不靠多条连接堆出来。
 */
async function consumeLoop(): Promise<void> {
  const log = getLogger()
  let reportedFailure = false

  while (state.running) {
    try {
      if (state.inFlight >= state.concurrency) {
        await waitForSlot()
        continue
      }

      const job = await dequeuePipelineJob()
      // ⚠️ 这里刻意**不再**检查 running：任务已经从队列里取走了（List 没有 ack，取走即出队），
      //    此时丢下它等于凭空消失；处理完它（最多占满一次宽限）比丢掉更划算。
      if (job === undefined) continue

      reportedFailure = false
      state.inFlight += 1
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight)
      const task = handleJob(job)
        .catch((error: unknown) => {
          // handleJob 内部已兜住业务失败；能冒到这里的只有"连日志都没写成"级别的意外
          log.error({ err: error, job }, '处理流水线任务时出现未预期错误（已忽略，继续消费）')
        })
        .finally(() => {
          state.inFlight -= 1
          state.inFlightTasks.delete(task)
          releaseSlot()
        })
      state.inFlightTasks.add(task)
    } catch (error) {
      if (!state.running) break // 停止流程刚把连接断掉，这条"失败"是预期内的
      if (!reportedFailure) {
        reportedFailure = true
        log.warn({ err: error, queueKey: pipelineQueueKey() }, '取件失败（Redis 不可用？），退避后重试')
      } else {
        log.debug({ err: error }, '取件仍失败（本轮已告警过）')
      }
      await delay(LOOP_FAILURE_BACKOFF_MS)
    }
  }
}

// ═════════════════════════ 单个任务 ═════════════════════════

/**
 * 处理一个任务：四道幂等判定 → 跑阶段 → 写状态。
 * **本函数不抛**（业务失败自己落库 + 记日志），保证循环永远不会因为一个坏文档而停摆。
 */
async function handleJob(job: PipelineJob): Promise<void> {
  const log = getLogger().child({ docId: job.docId, kbId: job.kbId, mode: job.mode })

  // 幂等 ①（同步完成：登记与判定之间没有 await，故同一文档的并发投递必然被后续那次看到）
  if (state.inFlightDocIds.has(job.docId)) {
    countSkip('duplicate-inflight')
    log.warn('该文档已在处理中，跳过本次重复投递')
    return
  }
  state.inFlightDocIds.add(job.docId)

  try {
    const db = getPrisma()
    const row = await db.document.findUnique({ where: { id: job.docId }, select: JOB_DOCUMENT_SELECT })

    // 幂等 ②：文档没了（删了库/删了文档，或这个 job 是上一辈子留下的）
    if (row === null) {
      countSkip('doc-missing')
      log.warn('任务对应的文档已不存在，跳过（可能已被删除）')
      return
    }
    // 幂等 ③：job 描述的是旧内容（文档在投递之后被重新上传过）
    if (row.contentHash !== job.contentHash) {
      countSkip('stale')
      log.warn(
        { jobHash: job.contentHash, rowHash: row.contentHash },
        '任务已过期（文档内容已更新），跳过；新内容会由它自己的任务处理',
      )
      return
    }
    // 幂等 ④：活已经干完了
    if (row.status === 'READY') {
      countSkip('already-ready')
      log.info('文档已是 READY，跳过本次重复投递')
      return
    }

    const document: PipelineDocument = {
      id: row.id,
      kbId: row.kbId,
      fileKey: row.fileKey,
      fileName: row.fileName,
      contentHash: row.contentHash,
      chunkSize: row.kb.chunkSize,
      chunkOverlap: row.kb.chunkOverlap,
      // jsonb 里可能缺键（老数据 / PATCH 只改了一半）⇒ 一律走 shared 的补默认值，
      // **不在这里写 `?? 'hybrid'`**（那是"散落的第二个真相"，见 `shared/src/knowledgeBase.ts` 文件头 ②）
      splitStrategy: normalizeRetrievalConfig(row.kb.retrievalConfig).splitStrategy,
      imageRecognize: row.imageRecognize,
      imageVectorize: row.imageVectorize,
    }
    const ctx: PipelineContext = { job, document, log }
    let status: DocumentStatus = row.status

    // 重试的起点：上一次失败的原因必须清掉，否则界面上"正在重试"与"上次失败"会同时挂着
    if (status === 'FAILED') {
      if (await transition(document, status, 'PARSING', { errorMsg: null }, log)) status = 'PARSING'
    }

    try {
      // 解析该库**选定**的 embedding 模型（入库用它，而不是进程级环境变量）——
      // 查库 + 解密 Key 都在这里；失败按"文档处理失败"落库（消息可展示），不是基础设施故障。
      const target = await resolveEmbeddingTarget(row.kb.embeddingModelId)
      // 防御性复核：勾了「图片向量化」要求该库模型支持多模态端点（上传时已校验过一次，
      // 但模型可能在文档排队期间被改过 —— 这里再拦一道，避免图片被当文本静默吞掉）
      if (row.imageVectorize && !target.embeddingMultimodal) {
        throw AppError.conflict(MULTIMODAL_MODEL_REQUIRED_HINT)
      }
      // 维度对齐（P1-5 修复）：worker 是**唯一**用"该库当前模型"做向量化的收口点（重试 / 新上传 /
      // 整库重建都经过它）。模型池里那一行可能被改过维度（或本功能上线前建的库维度快照为空），
      // 若继续用知识库那个可能过期的 `embeddingDim`，上游会报"返回 N 维、期望 M 维"整批失败
      // （2026-10-08 实测：模型改名后点「重试」失败，走重建才恢复）。故以**模型当前维度**为准，
      // 顺便把知识库快照刷新成它（后续检索按新维度收窄旧 chunk）。
      const alignedDim = await alignEmbeddingDim(row.kbId, row.kb.embeddingDim, target.embeddingDim, log)
      ctx.embeddingDim = requireEmbeddingDim(alignedDim)
      ctx.embeddingBatchSize = config.embedding.batchSize
      ctx.embeddingProvider = buildPoolEmbeddingProvider(
        {
          providerName: target.providerName,
          baseUrl: target.baseUrl,
          customUrl: target.customUrl,
          multimodal: target.embeddingMultimodal,
          apiKey: target.apiKey,
          apiModel: target.modelName,
        },
        ctx.embeddingDim,
        ctx.embeddingBatchSize,
      )
      // 图片"含义"理解（P1-11）：勾了「图片含义识别」+ 该库配了描述模型时解析其 vision 目标并注入。
      // 解析失败 / 模型不支持视觉得**降级为 no-op**（不使文档失败）—— 描述是可选的锦上添花。
      ctx.captionTarget = await resolveCaptionTarget(
        row.kb.captionModelId,
        row.imageRecognize,
        log,
      )

      for (const stage of state.stages) await stage.run(ctx)
      const ok = await transition(
        document,
        'PARSING',
        'READY',
        { errorMsg: null, chunkCount: ctx.chunkCount ?? 0 },
        log,
      )
      if (!ok) return
      state.processed += 1
      log.info(
        {
          chars: ctx.parsed?.meta.charCount ?? null,
          blocks: ctx.parsed?.blocks.length ?? null,
          chunks: ctx.chunks?.length ?? 0,
          // 至 P0-1-19，这个数来自 ⑦ 入库的真实写入行数（不再是恒 0 的占位）——
          // 它写进 `documents.chunk_count`，与 `chunks` 表逐行一致
          chunkCount: ctx.chunkCount ?? 0,
          embeddingName: ctx.embeddingName ?? null,
        },
        // 八步齐全：解析 → 空文本检测 → 分块 → embedding → 入库。此刻的 `READY` 才是
        // 真正的"可检索"（库里已有带向量的 chunk）；仍差的是**检索端点本身**（P0-1-20）
        '文档处理完成（解析 + 空文本检测 + 分块 + 向量化 + 入库）',
      )
    } catch (error) {
      const message = describeFailure(error)
      log.error({ err: error }, `文档处理失败：${message}`)
      state.failed += 1
      // 失败写入的 `from` 同样是当前状态：从 `FAILED` 出发再失败一次时，
      // 状态机只允许 `FAILED → PARSING` ⇒ 这次不写（值没变，`error_msg` 顺手更新没有意义）
      await transition(document, status, 'FAILED', { errorMsg: message, chunkCount: 0 }, log)
    }
  } catch (error) {
    // 走到这里说明**基础设施**出了问题（读行/写状态失败），不是文档的问题 ——
    // 刻意不写 FAILED：那是把"我们查不了"写成"这个文档坏了"，用户会去重传一个没问题的文件。
    // 文档停在 PARSING，靠重投恢复（`子方案①` §十 的"必须有重试入口"正为此）。
    log.error({ err: error }, '处理任务时数据库不可用，本次未改动文档状态（重投该任务即可恢复）')
  } finally {
    state.inFlightDocIds.delete(job.docId)
  }
}

/** 累加一个跳过原因（计数进 {@link PipelineWorkerStats.skipped}） */
function countSkip(reason: string): void {
  state.skipped[reason] = (state.skipped[reason] ?? 0) + 1
}

/**
 * 该库必须已有 embedding 维度快照（建库时探测写入）。
 * `null` = 本功能上线前建的老库 ⇒ 给一句可操作的失败文案，而不是让维度 `undefined` 滑到 SQL 里。
 */
function requireEmbeddingDim(dim: number | null): number {
  if (dim === null) {
    throw AppError.validation(
      '该知识库未记录 embedding 维度（可能是本功能上线前建的老库）。请重建知识库并重新选择 embedding 模型后再上传文档',
    )
  }
  return dim
}

/**
 * 解析图片描述（P1-11）用的 vision 模型目标。
 *
 * 模型来源是**知识库级**的 `kb.captionModelId`（建/改库时从模型池选定，见 `kb.service`），
 * 不再是进程级环境变量。
 *
 * 与 embedding 目标**刻意不同**：这里**不抛**，任何不可用都降级为 `undefined`（→ 描述阶段 no-op），
 * 因为描述是可选的增强、且失败不该影响入库。三类降级各留一条 warn 便于运维定位：
 * 该库未配置 / 识别方式不是「大模型识别（LLM）」/ 模型不可用（不存在·停用·未配 Key）/ 不支持视觉。
 */
async function resolveCaptionTarget(
  modelId: string | null,
  imageRecognize: ImageRecognition,
  log: Logger,
): Promise<LlmTarget | undefined> {
  if (modelId === null || imageRecognize !== 'LLM') return undefined
  try {
    const target = await resolveChatTarget(modelId)
    if (!target.supportsVision) {
      log.warn(
        { modelId, modelName: target.modelName },
        '该库选定的图片描述模型不支持视觉（supportsVision=false），图片描述阶段跳过',
      )
      return undefined
    }
    return target
  } catch (error) {
    log.warn(
      { err: error, modelId },
      '图片描述模型不可用（不存在/停用/未配 Key），图片描述阶段跳过（不影响文档入库）',
    )
    return undefined
  }
}

/**
 * 让"这一篇用哪个维度入库"与该库**当前模型**的输出维度一致（P1-5 修复）。
 *
 * 优先级：模型的 `embeddingDim`（模型池里改名/改维度后 `updateModel` 会重探它）> 知识库快照。
 * 两者不一致（或快照为空）时把**知识库快照**刷新成模型维度 —— 一致性由知识库快照承载
 * （检索也读它），刷新后新入库的行与检索口径同一维度，旧 chunk 被维度收窄自然排除。
 *
 * ⚠️ 只刷 `embeddingDim`，**不动 `embeddingModel`（"向量来源"名字快照）** —— 那条由整库重建
 * 成功后收口（`kb.service#rebuildKnowledgeBase`），避免"只重试了一篇就把'需重建'告警清掉"。
 *
 * @returns 本次入库应使用的维度（模型维度可用则用它，否则回落知识库快照，由调用方判空）
 */
async function alignEmbeddingDim(
  kbId: string,
  snapshotDim: number | null,
  modelDim: number | null,
  log: Logger,
): Promise<number | null> {
  if (modelDim === null || modelDim === snapshotDim) return snapshotDim
  await getPrisma().knowledgeBase.update({ where: { id: kbId }, data: { embeddingDim: modelDim } })
  log.warn(
    { kbId, from: snapshotDim, to: modelDim },
    '知识库 embedding 维度快照与当前模型不一致，已按模型维度刷新（旧 chunk 在重建完成前被维度收窄排除）',
  )
  return modelDim
}

/**
 * 按状态机写状态（**带 CAS**）。
 *
 * 两重保护：
 * ① 转换合法性来自 `shared` 的 `canTransitionDocumentStatus`（唯一事实来源）——
 *    非法转换**只告警不写**：这里已经不在用户请求上下文里，抛错只能变成日志，
 *    而真正要守住的是"库里那行别被写坏"（典型场景：过期 job 想把 READY 打回 FAILED）。
 * ② `where` 里带上 `status: from` ⇒ 这是一次**比较并交换**：期间若有别的写者改了状态，
 *    本次改动不会生效（`count === 0`），也就不会用陈旧的前置状态覆盖别人的结果。
 */
async function transition(
  document: PipelineDocument,
  from: DocumentStatus,
  to: DocumentStatus,
  data: { errorMsg?: string | null; chunkCount?: number },
  log: Logger,
): Promise<boolean> {
  if (!canTransitionDocumentStatus(from, to)) {
    log.warn({ from, to }, '拒绝一次非法的文档状态转换（按状态机定义，该转换不允许）')
    return false
  }
  const { count } = await getPrisma().document.updateMany({
    where: { id: document.id, status: from },
    data: { status: to, ...data },
  })
  if (count === 0) {
    log.warn({ from, to }, '状态转换未生效：该文档的状态已被其他写者改动过（本进程不覆盖）')
    return false
  }
  return true
}

/**
 * 把异常翻译成写进 `documents.error_msg` 的文案。
 *
 * `AppError` 的消息是**特意写给用户看**的（见 `stages.ts` 文件头），原样采用；
 * 其余异常（编程错误、未预料的上游异常）加"内部错误"前缀 —— 至少要让人看出
 * "这不是文档的问题、别反复重传"，同时把原始消息留一段便于对日志。
 */
function describeFailure(error: unknown): string {
  const detail =
    error instanceof AppError
      ? error.message
      : `内部错误：${error instanceof Error ? error.message : String(error)}`
  return detail.length > FAILED_MESSAGE_MAX_CHARS ? `${detail.slice(0, FAILED_MESSAGE_MAX_CHARS)}…` : detail
}
