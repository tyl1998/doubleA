#!/usr/bin/env node
/**
 * probe-upload-once.mjs —— 在**纯净子进程**里跑一次 `uploadDocument`，结果以 JSON 打给 stdout
 *
 * 为什么需要它（P0-1-17 的 G 组）：要验"入队失败 ⇒ 整次上传回滚"这条不变式，就得让
 * **Redis 不可用而 PG/S3 正常**。在父进程里改 `REDIS_URL` 会把同脚本后面所有用例一起毒化
 * （会话、队列全废），所以只能起一个只带原始那几个环境变量的子进程 —— 这也是 P0-1-13 定的
 * 「外部件/故障注入一律走子进程」的做法。
 *
 * 同一个探针跑两遍才是**完整的对照**：
 *   · 真 Redis → 应当成功（证明这套探针本身是通的，否则"失败"可能是别的原因造成的假通过）
 *   · 死 Redis → 应当失败，且父进程能断言"库里没有行、S3 里没有对象"
 *
 * 入参（全部通过环境变量，见 `verify-pipeline.mjs` 的 G 组）：
 *   PROBE_KB_ID     目标知识库 id（父进程建好传进来）
 *   PROBE_CONTENT   文件内容（每个用例给不同内容，避免被判重命中而跳过）
 * 输出：一行 JSON —— `{ok:true,docId,status}` 或 `{ok:false,name,message}`
 * 退出码恒为 0（成败由 JSON 表达；父进程看的是 JSON + 库/存储的实际情况）
 */

process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'

const kbId = process.env.PROBE_KB_ID ?? ''
const content = process.env.PROBE_CONTENT ?? ''

const { uploadDocument } = await import('../dist/backend/src/services/document.service.js')
const { closePrisma } = await import('../dist/backend/src/infra/prisma.js')
const { closeRedis } = await import('../dist/backend/src/infra/redis.js')

let payload
try {
  const uploaded = await uploadDocument({
    kbId,
    fileName: 'probe.md',
    declaredMime: 'text/markdown',
    bytes: Buffer.from(content, 'utf8'),
  })
  payload = { ok: true, docId: uploaded.document.id, status: uploaded.document.status }
} catch (error) {
  payload = {
    ok: false,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  }
}

process.stdout.write(`${JSON.stringify(payload)}\n`)

// 子进程也要好好收尾：不然死 Redis 那条路上 ioredis 的重连计时器会把进程留住
await closePrisma().catch(() => undefined)
await closeRedis().catch(() => undefined)
process.exit(0)
