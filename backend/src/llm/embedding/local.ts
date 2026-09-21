/**
 * embedding · **local 模式**（worker_threads 里跑本地推理）
 *
 * 依据：`docs/02-后端设计.md` §二（「onnx 批量推理走 `worker_threads`，避免 CPU 密集任务
 *      阻塞在线请求」）、§八（local：onnxruntime-node + bge-m3 int8，挂载卷 `/models/bge-m3-int8`；
 *      启动懒加载、批量推理、CPU 即可）、§十一（`LOCAL_EMBEDDING_MODEL_PATH`；
 *      `EMBEDDING_DIM` 与 `chunks.embedding` 的 `vector(1024)` 必须一致）、
 *      `子方案/知识库流水线.md` §4-3（批 32、onnx 走 worker_threads）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件里**唯一**没有就位的东西，是"onnx 推理 + 分词"本身
 * ─────────────────────────────────────────────────────────────────────
 * `06` P0-1-13 的坑预判已写明：**模型文件需另行下载**（`/models/bge-m3-int8`，来源见
 * §七 待决事项 2）→ 「本步先落 `api` 模式跑通链路，`local` 模式依赖模型就位后补验」。
 * 而 bge-m3 的"分词"（XLM-RoBERTa 的 sentencepiece/unigram）**取决于**最终拿到的是哪一份
 * 交付物（`model.onnx` + `tokenizer.json`？还是 transformer 导出包？），此刻写死等于赌。
 *
 * 所以这里只把**与推理库无关**的部分做完整（这些部分今天就能验，且占了本模式 90% 的坑）：
 *   · 就绪自检（目录/onnx 文件/运行时模块三态，各自给出**可执行**的报错文案）；
 *   · worker 线程隔离（CPU 密集不阻塞在线请求）+ 懒加载 + 生命周期的显式管理；
 *   · 批 32 切片（`EMBEDDING_BATCH_SIZE`）、返回条数与维度校验；
 *   · 失败语义（worker 崩了/抛错 → 明确报错；`dispose()` 后能重新懒加载）。
 *
 * **推理运行时（含分词）通过 `LOCAL_EMBEDDING_RUNTIME_MODULE` 注入**，模块契约：
 *
 * ```ts
 * // runtime.mjs —— 模块可以放在模型卷里、也可以是本仓将来补的 runtimes/bge-m3-onnx.ts
 * export async function createEmbedder({ modelPath, dim }) {
 *   return {
 *     dim,                                    // 可选：报了自己这一份的维度，init 时立刻校验
 *     async embed(texts) { return [[...], ...] },  // 返回 number[][]（长度 = texts.length）
 *     async dispose() {},                     // 可选：释放 onnx session
 *     describe() { return { providers: ['cpu'] } }, // 可选：进日志
 *   }
 * }
 * ```
 *
 * 为什么不是"我们直接 `import('onnxruntime-node')` 完事"：那样会把**分词**一起写死在这里，
 * 而分词恰恰是最需要对着真实模型文件调的部分（tokenizer.json 的 vocabulary/normalizer 形态
 * 有好几种）。契约留在这里，"模型就位"那天只需要丢一个模块进去 —— 验收脚本已经证明
 * **这个缝是真的能插上并且真的跑在独立线程里**（见 `verify-embedding.mjs` 的 local 组）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { Worker } from 'node:worker_threads'

import { AppError } from '@doubulea/shared'

import { getLogger } from '../../infra/logger.js'
import type { EmbeddingProvider } from './index.js'

// ═════════════════════════════════════════════════════════════════════
// worker 协议（`embedding.worker.ts` 用 `import type` 引这一组，编译期擦除、不产生运行期环）
// ═════════════════════════════════════════════════════════════════════

export interface LocalWorkerInitRequest {
  id: number
  type: 'init'
  runtimeModule: string
  modelPath: string
  dim: number
  batchSize: number
}

export interface LocalWorkerEmbedRequest {
  id: number
  type: 'embed'
  texts: string[]
}

export interface LocalWorkerDisposeRequest {
  id: number
  type: 'dispose'
}

export type LocalWorkerRequest =
  | LocalWorkerInitRequest
  | LocalWorkerEmbedRequest
  | LocalWorkerDisposeRequest

export type LocalWorkerResponse =
  | { id: number; ok: true; vectors?: number[][]; info?: Record<string, unknown> }
  | { id: number; ok: false; error: { message: string; modelMissing?: boolean } }

/** 成功那一支（`#send()` 已把失败支转成抛错，调用方只需处理这一支） */
export type LocalWorkerSuccess = Extract<LocalWorkerResponse, { ok: true }>

/**
 * `Omit` 对联合类型**不分发**（`Omit<A | B, K>` 只剩公共键），这里要的是"每个分支各自去掉 id"。
 * 直接写 `Omit<LocalWorkerRequest, 'id'>` 会让 `{ type: 'embed', texts }` 通不过类型检查。
 */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type LocalWorkerCommand = WithoutId<LocalWorkerRequest>

/**
 * 本地推理运行时模块的契约（写在 `docs/02` §八；模型就位后只需提供一个模块）。
 * 这里刻意只声明**运行期用得到的两个成员**，不引入任何 onnx 类型 —— 本仓因此**零新增依赖**。
 */
export interface LocalRuntimeEmbedder {
  embed(texts: string[]): Promise<ArrayLike<number>[]>
  /** 可选：自报维度，`init` 时与 `EMBEDDING_DIM` 校验 */
  dim?: number
  /** 可选：释放底层会话 */
  dispose?(): Promise<void> | void
  /** 可选：进日志的自述 */
  describe?(): Record<string, unknown>
}

export interface LocalRuntimeFactory {
  createEmbedder(options: { modelPath: string; dim: number }): Promise<LocalRuntimeEmbedder> | LocalRuntimeEmbedder
}

export interface LocalEmbeddingOptions {
  modelPath: string
  /** 见文件头：推理（含分词）由它提供；未配置即"local 模式尚未就绪" */
  runtimeModule: string | null
  dim: number
  batchSize: number
}

/**
 * local 模式的就绪自检（**返回问题清单**，不抛）。
 *
 * 三态各给一条可执行的话：目录不存在 / 目录里没有 onnx / 没配运行时模块。
 * 前两条是"模型没就位"，第三条是"运行时没就位"——**运维看到的必须是同一句人话**，
 * 而不是等到第一次入库才炸出一个 ENOENT。
 */
export function localEmbeddingProblems(options: LocalEmbeddingOptions): string[] {
  const problems: string[] = []
  const { modelPath, runtimeModule } = options

  if (!existsSync(modelPath)) {
    problems.push(
      `本地 embedding 模型目录不存在：${modelPath}（LOCAL_EMBEDDING_MODEL_PATH）。` +
        'bge-m3 int8 模型文件需另行获取（docs/06 §七 待决事项 2），或改用 EMBEDDING_MODE=api',
    )
  } else if (statSync(modelPath).isDirectory() && !readdirSync(modelPath).some((name) => name.endsWith('.onnx'))) {
    problems.push(
      `本地 embedding 模型目录里没有 .onnx 文件：${modelPath}。` +
        '请确认模型文件已完整放入（bge-m3 int8 至少需要一份 model.onnx）',
    )
  }

  if (runtimeModule === null || runtimeModule.trim() === '') {
    problems.push(
      '本地 embedding 推理运行时未配置：请设置 LOCAL_EMBEDDING_RUNTIME_MODULE 指向一个导出 ' +
        'createEmbedder({ modelPath, dim }) 的模块（契约见 docs/02 §八），或改用 EMBEDDING_MODE=api',
    )
  }

  return problems
}

/**
 * 本地推理 provider（`worker_threads` 里跑，主线程只做队列与校验）。
 *
 * 生命周期：**懒加载** —— 构造时不碰文件系统；第一次 `embed()` 才起线程、加载运行时。
 * 起线程失败（就绪自检不过 / 模块加载不了）也是那时才报错并**给全问题清单**。
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly #options: LocalEmbeddingOptions
  /** 一个线程串行跑（CPU 密集；并发交给流水线的 PIPELINE_CONCURRENCY，见文件头） */
  #worker: Worker | null = null
  #starting: Promise<void> | null = null
  #pending = new Map<number, { resolve: (value: LocalWorkerResponse) => void; reject: (error: unknown) => void }>()
  #seq = 0
  /** `init` 时 worker 回的现场信息（线程 id、运行时自述），进日志用 */
  #info: Record<string, unknown> | null = null

  constructor(options: LocalEmbeddingOptions) {
    this.#options = options
  }

  /** 落库标记：`local:<模型目录名>` —— 换一份模型（目录名不同）即判定为"需重建"（§八） */
  name(): string {
    return `local:${basename(this.#options.modelPath)}`
  }

  dim(): number {
    return this.#options.dim
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    await this.#ensureWorker()
    const response = await this.#send({ type: 'embed', texts })
    const vectors = response.vectors ?? []
    if (vectors.length !== texts.length) {
      throw AppError.internal(
        `本地 embedding 返回的向量条数与输入不符（输入 ${texts.length} 条，返回 ${vectors.length} 条）—— 运行时模块未遵守契约（docs/02 §八）`,
      )
    }
    for (const [position, vector] of vectors.entries()) {
      if (vector.length !== this.#options.dim) {
        throw AppError.internal(
          `本地 embedding 第 ${position} 条返回 ${vector.length} 维，与 EMBEDDING_DIM=${this.#options.dim} 不一致。` +
            `chunks.embedding 是 vector(${this.#options.dim})，维度不符会写坏数据（子方案① §4-4）`,
        )
      }
    }
    return vectors
  }

  /** 释放 worker（`resetEmbeddingProvider()` / 进程退出时调用）；之后再 `embed()` 会重新懒加载 */
  async dispose(): Promise<void> {
    const worker = this.#worker
    this.#worker = null
    this.#starting = null
    this.#info = null
    if (worker === null) return
    try {
      // 先请运行时自己释放（onnx session），再强杀线程 —— 后者是兜底，不能省
      await this.#send({ type: 'dispose' }, worker).catch(() => undefined)
    } finally {
      this.#failAll(AppError.internal('本地 embedding 已释放'))
      await worker.terminate()
    }
  }

  // ─────────────────────────── 内部 ───────────────────────────

  async #ensureWorker(): Promise<void> {
    if (this.#worker !== null) return
    if (this.#starting !== null) return this.#starting
    this.#starting = this.#start()
    try {
      await this.#starting
    } finally {
      this.#starting = null
    }
  }

  async #start(): Promise<void> {
    // 就绪自检放在起线程**之前**：问题清单一句话说完，而不是让模块加载抛出个 ERR_MODULE_NOT_FOUND
    const problems = localEmbeddingProblems(this.#options)
    if (problems.length > 0) {
      throw AppError.internal(`本地 embedding 未就绪：${problems.join('；')}`)
    }

    const entry = workerEntryUrl()
    const worker = new Worker(entry, {
      name: 'doubulea-embedding-local',
      // ⚠️ 只给 `.ts` 入口继承 `process.execArgv`（dev 下 tsx 靠 `--import` 注入加载器，
      //    否则 worker 加载不了 `.ts`）。编译产物 `.js` 一律**不给**任何 execArgv ——
      //    踩过：父进程若是 `node --input-type=module -e ...` 起的（验收脚本的子进程就是），
      //    继承下来的 `--input-type` 会让 worker 直接崩：
      //    "`--input-type` can only be used with string input via --eval, --print, or STDIN"。
      execArgv: entry.pathname.endsWith('.ts') ? process.execArgv : [],
    })
    // ⚠️ **刻意不 unref**：unref 掉之后，如果进程里没有别的活句柄（验收脚本就是这种情形），
    //    Node 可能在"等 embedding 返回"的当口直接退出进程，而调用方以为它在算。
    //    释放交给显式 `dispose()`（脚本收尾 / 进程退出时的 process.exit 都会带走它）。
    this.#worker = worker
    worker.on('message', (message: LocalWorkerResponse) => this.#onMessage(message))
    // ⚠️ worker 崩了必须**立刻**让所有在途请求失败：否则调用方会永久等一个永远不会来的回复
    worker.on('error', (error) => {
      getLogger().error({ err: error }, '本地 embedding worker 崩溃')
      this.#failAll(AppError.internal(`本地 embedding worker 崩溃：${error.message}`))
    })
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = null
      this.#failAll(AppError.internal(`本地 embedding worker 退出（code=${code}）`))
    })

    const init = await this.#send(
      {
        type: 'init',
        runtimeModule: this.#options.runtimeModule ?? '',
        modelPath: this.#options.modelPath,
        dim: this.#options.dim,
        batchSize: this.#options.batchSize,
      },
      worker,
    ).catch(async (error: unknown) => {
      // ⚠️ init 失败（运行时没装/维度不符/模型不对）时必须把线程收掉：
      //    留着一个"半初始化"的线程，下一次调用会得到"尚未初始化"的怪错误 ——
      //    而调用方刚按提示改好了模型目录、重启进程前压根没机会自愈。
      this.#worker = null
      await worker.terminate()
      throw error
    })
    this.#info = init.info ?? null
    getLogger().info(
      { ...(this.#info ?? {}), modelPath: this.#options.modelPath, dim: this.#options.dim, batchSize: this.#options.batchSize },
      '本地 embedding 运行时已就绪',
    )
  }

  #send(
    request: LocalWorkerCommand,
    target?: Worker,
  ): Promise<LocalWorkerSuccess> {
    const worker = target ?? this.#worker
    if (worker === null) return Promise.reject(AppError.internal('本地 embedding worker 尚未启动'))

    this.#seq += 1
    const id = this.#seq
    return new Promise<LocalWorkerResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      worker.postMessage({ ...request, id })
    }).then((response) => {
      if (!response.ok) {
        throw AppError.internal(
          `本地 embedding 调用失败：${response.error.message}` +
            (response.error.modelMissing
              ? '（运行时模块尚未安装或路径不对 —— 见 LOCAL_EMBEDDING_RUNTIME_MODULE）'
              : ''),
        )
      }
      return response
    })
  }

  #onMessage(message: LocalWorkerResponse): void {
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    pending.resolve(message)
  }

  #failAll(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

/**
 * worker 入口文件。
 *
 * 优先 `.js`（构建产物里 `embedding.worker.js` 与 `local.js` 同目录），退到 `.ts`（dev 下 tsx 直接跑源码）。
 * 之所以要两种：`06` 的验收脚本跑的是 dist，而开发时 `pnpm dev:backend` 跑的是 tsx ——
 * 只认一种会让另一边得到一个"文件不存在"的怪错误。
 */
function workerEntryUrl(): URL {
  for (const relative of ['./embedding.worker.js', './embedding.worker.ts']) {
    const url = new URL(relative, import.meta.url)
    if (existsSync(url)) return url
  }
  throw AppError.internal(
    '找不到 embedding worker 入口（embedding.worker.js / .ts）—— 构建产物不完整，请重新 pnpm build',
  )
}
