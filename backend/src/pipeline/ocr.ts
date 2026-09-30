/**
 * 本地 OCR（P0-4-x；文档图片按 `OCR` 模式解析时把图片转成文字）
 *
 * 用 `tesseract.js`（WASM 版 Tesseract）在**本机**离线识别，不把图片内容发给任何第三方。
 * 语言包与核心 wasm 由 tesseract.js 按需加载：默认从 CDN 拉取并缓存到 `cachePath`；
 * 内网/离线环境可用 `OCR_LANG_PATH` / `OCR_CACHE_PATH` 指向本地目录（见 `config.ts`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"单例 + 串行队列"
 * ─────────────────────────────────────────────────────────────────────
 * 一个 tesseract worker 内部是单线程的，并发 `recognize` 会互相干扰；而流水线的
 * `PIPELINE_CONCURRENCY` 可能同时处理多篇文档。故：
 *   · worker 懒建一次、进程内复用（每次新建都要重新加载语言包，代价高）；
 *   · 所有识别走一条 `Promise` 链**串行**执行，天然避免并发。
 * 首次识别才初始化 worker（不在启动期）—— 没传图片的部署不需要付出这份资源。
 */

import { AppError } from '@doubulea/shared'
import { createWorker, type Worker } from 'tesseract.js'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'

type LogFn = (message: object, msg?: string) => void

let workerPromise: Promise<Worker> | null = null
/** 串行队列：所有识别按入队顺序依次跑（见文件头） */
let queue: Promise<unknown> = Promise.resolve()

/** 懒建并复用 tesseract worker；失败不缓存（下次可重试） */
function getWorker(): Promise<Worker> {
  if (workerPromise === null) {
    const langs = config.ocr.langs
    getLogger().info({ langs, langPath: config.ocr.langPath }, '初始化本地 OCR（tesseract）')
    workerPromise = createWorker(langs, 1, {
      // `null` 表示用 tesseract 默认（CDN）；给了就用本地目录（离线部署）
      ...(config.ocr.langPath === null ? {} : { langPath: config.ocr.langPath }),
      ...(config.ocr.cachePath === null ? {} : { cachePath: config.ocr.cachePath }),
    }).catch((error: unknown) => {
      workerPromise = null
      throw AppError.internal(
        `本地 OCR 初始化失败（tesseract）：${String(error)}。` +
          '若为离线环境，请配置 OCR_LANG_PATH / OCR_CACHE_PATH 指向本地语言包与缓存目录',
      )
    })
  }
  return workerPromise
}

/**
 * 识别一张图片上的文字。
 *
 * @returns 识别出的文本（可能为空串 —— 图中没有可识别文字是正常情况）
 * @throws {AppError} `INTERNAL`(500) worker 初始化/识别失败（消息可展示）
 */
export async function recognizeImage(image: Buffer, log: LogFn = getLogger().error.bind(getLogger())): Promise<string> {
  const run = async (): Promise<string> => {
    const worker = await getWorker()
    const { data } = await worker.recognize(image)
    return (data.text ?? '').trim()
  }
  // 入队：无论上一步成功失败都继续（失败只影响那一次的结果）
  const result = queue.then(run, run)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  try {
    return await result
  } catch (error) {
    if (error instanceof AppError) throw error
    log({ err: error }, 'OCR 识别失败')
    throw AppError.internal(`图片 OCR 识别失败：${String(error)}`)
  }
}

/** 释放 worker（进程优雅退出时可调；不调也不会漏 —— worker 是子线程，随进程结束） */
export async function disposeOcr(): Promise<void> {
  const current = workerPromise
  workerPromise = null
  if (current === null) return
  try {
    const worker = await current
    await worker.terminate()
  } catch {
    // 退出路径，忽略
  }
}
