/**
 * embedding · 本地推理的 **worker 线程**（`02` §二：onnx 批量推理走 `worker_threads`）
 *
 * 这个文件**只在线程里跑**：主线程通过 `new Worker(new URL('./embedding.worker.js', import.meta.url))`
 * 拉起它（见 `local.ts#workerEntryUrl`）。协议与运行时模块的契约都在 `local.ts` 里声明，
 * 这里 `import type` 引用（编译期擦除，因此不会把本文件拉进主线程）。
 *
 * 职责刻意只有三件：
 *   ① 加载运行时模块（`LOCAL_EMBEDDING_RUNTIME_MODULE`，契约见 `docs/02` §八）并做 init 自检；
 *   ② 按 `EMBEDDING_BATCH_SIZE` 切片、**串行**调用推理（一个线程里跑，批与批之间串行是刻意的：
 *      CPU 密集任务并行只会互相抢核，并发层级留给流水线的 `PIPELINE_CONCURRENCY`）；
 *   ③ 把结果/错误原样回给主线程（**错误不吞**：主线程要靠它区分"运行时没装""模型不对"）。
 *
 * ⚠️ 为什么"分词"和"onnx 推理"不在本文件里实现：见 `local.ts` 文件头 —— 取决于最终拿到
 * 哪一份 bge-m3 交付物，而 `docs/06` §七 待决事项 2 尚未关闭。本文件因此只做"运行时模块的宿主"。
 */

import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, threadId } from 'node:worker_threads'

import type {
  LocalRuntimeEmbedder,
  LocalRuntimeFactory,
  LocalWorkerRequest,
  LocalWorkerResponse,
} from './local.js'

const port = parentPort
if (port === null) {
  throw new Error('embedding.worker 必须由 worker_threads 启动（直接执行它是没有意义的）')
}

let embedder: LocalRuntimeEmbedder | null = null
let batchSize = 32

port.on('message', (message: LocalWorkerRequest) => {
  void handle(message)
})

async function handle(message: LocalWorkerRequest): Promise<void> {
  try {
    if (message.type === 'init') {
      batchSize = message.batchSize
      embedder = await createEmbedder(message.runtimeModule, message.modelPath, message.dim)
      reply({
        id: message.id,
        ok: true,
        info: { threadId, runtimeModule: message.runtimeModule, ...(embedder.describe?.() ?? {}) },
      })
      return
    }

    if (message.type === 'embed') {
      if (embedder === null) throw new Error('尚未初始化（缺少 init 步骤）')
      const vectors: number[][] = []
      for (let start = 0; start < message.texts.length; start += batchSize) {
        const batch = message.texts.slice(start, start + batchSize)
        const batchVectors = await embedder.embed(batch)
        // 逐条转成普通数组：worker postMessage 走结构化克隆，这里显式转一次让"回给主线程的
        // 是什么"没有歧义（Float32Array / TypedArray 也照收，但统一成 number[]）
        for (const vector of batchVectors) vectors.push(Array.from(vector))
      }
      reply({ id: message.id, ok: true, vectors })
      return
    }

    // dispose
    const current = embedder
    embedder = null
    await current?.dispose?.()
    reply({ id: message.id, ok: true })
  } catch (error) {
    reply({
      id: message.id,
      ok: false,
      error: { message: errorText(error), modelMissing: isModuleResolutionError(error) },
    })
  }
}

function reply(response: LocalWorkerResponse): void {
  port?.postMessage(response)
}

/**
 * 加载运行时模块并建 embedder。
 *
 * 模块标识可以是**裸包名**（`some-embedding-runtime`）也可以是**绝对路径**
 * （模型卷里跟着模型一起放的那份 `runtime.mjs`）；相对标识按"相对本文件"解析 ——
 * 与 Node 的 `import()` 语义一致，不做额外约定。
 */
async function createEmbedder(
  runtimeModule: string,
  modelPath: string,
  dim: number,
): Promise<LocalRuntimeEmbedder> {
  if (runtimeModule.trim() === '') {
    throw new Error('未配置 LOCAL_EMBEDDING_RUNTIME_MODULE（本地推理运行时）')
  }

  const module = (await import(toImportSpecifier(runtimeModule))) as Record<string, unknown>
  const factory = module.createEmbedder ?? module.default
  if (typeof factory !== 'function') {
    throw new Error(
      `运行时模块 ${runtimeModule} 没有导出 createEmbedder()（契约见 docs/02 §八：` +
        'createEmbedder({ modelPath, dim }) → { dim?, embed(texts), dispose?, describe? }）',
    )
  }

  const created = await (factory as LocalRuntimeFactory['createEmbedder'])({ modelPath, dim })
  if (created === null || typeof created !== 'object' || typeof created.embed !== 'function') {
    throw new Error(`运行时模块 ${runtimeModule} 的 createEmbedder() 没有返回含 embed() 的对象`)
  }
  // 自报维度就当场校验：一旦不符，宁可"一分钟都别跑"（写进 vector(1024) 的数据没法事后修补）
  if (typeof created.dim === 'number' && created.dim !== dim) {
    throw new Error(
      `运行时模块自报 ${created.dim} 维，与 EMBEDDING_DIM=${dim} 不一致` +
        `（chunks.embedding 是 vector(${dim})，子方案① §4-4）`,
    )
  }
  return created
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 模块标识 → `import()` 能吃的形态（绝对路径要转成 file URL；裸包名/相对标识原样交给解析器） */
function toImportSpecifier(specifier: string): string {
  return isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier
}

/** `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` —— 主线程据此补一句"运行时没装/路径不对" */
function isModuleResolutionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME'
}
