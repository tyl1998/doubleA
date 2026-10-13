/**
 * 路由网关进程入口（P1-14 §三 6；`pnpm router:start`）
 *
 * 形态：**独立小进程**（自研 Fastify，§十 1 定案）。职责只有一件 —— 对"沙箱流路由"查目录并转发，
 * 其余轮询（见 `gateway.ts` 文件头）。
 *
 * ⚠️ 它**不**加载业务后端的 `config.ts`（只管 Redis + 转发，不需要 DB/S3/Docker）——
 *    理由见 `router/config.ts` 文件头。
 *
 * 容器化：可直接用 `doubulea-backend` 镜像、只覆盖启动命令
 * （`node dist/backend/src/router/main.js`），无需另做一个镜像（`子方案` §八 4 的
 * `doubulea-router` 可由它派生）。
 */

import { Redis } from 'ioredis'

import { isSandboxInstanceId, sandboxOwnerKey } from '@doubulea/shared'

import { loadRouterConfig } from './config.js'
import { buildRouterApp, type RouterDeps } from './gateway.js'

const loaded = loadRouterConfig()
if (loaded.config === undefined) {
  // 配置缺失/非法 ⇒ 大声失败（同后端 `config.ts` 的纪律：不进半可用状态）
  console.error('路由网关启动失败（配置问题）：')
  for (const error of loaded.errors) console.error(`  · ${error}`)
  console.error('  修法：参考 infra/.env.example 的「路由网关」段配好 ROUTER_UPSTREAMS / ROUTER_PORT。')
  process.exit(1)
}
const config = loaded.config

/** 读目录用的 Redis 客户端（失败只 warn：目录不可用时网关退化为轮询，不该整个瘫掉） */
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 })
redis.on('error', (error: unknown) => {
  console.warn(`[router] Redis 连接异常：${error instanceof Error ? error.message : String(error)}（目录不可用 ⇒ 退化为轮询）`)
})

const deps: RouterDeps = {
  config,
  resolveOwner: async (conversationId) => {
    const payload = await redis.get(sandboxOwnerKey(config.ownerKeyPrefix, conversationId))
    if (payload === null) return undefined
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const { instanceId } = parsed as { instanceId?: unknown }
      return isSandboxInstanceId(instanceId) ? instanceId : undefined
    } catch {
      return undefined
    }
  },
}

const app = buildRouterApp(deps)

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

let closing = false
async function shutdown(reason: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`[router] 收到 ${reason}，正在退出`)
  try {
    await app.close()
    redis.disconnect()
  } catch (error) {
    console.error('[router] 退出时出错（仍会退出）：', error)
  }
  process.exit(0)
}

try {
  await app.listen({ host: config.host, port: config.port })
  console.log(
    `[router] 已启动：http://${config.host}:${config.port} → 上游 [${config.upstreams.join(', ')}]` +
      `（目录前缀 ${config.ownerKeyPrefix}；SSE 透传、不设 idle 超时）`,
  )
} catch (error) {
  console.error(`[router] 监听 ${config.host}:${config.port} 失败：`, error)
  process.exit(1)
}
