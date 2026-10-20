/**
 * 路由网关进程入口（P1-14 §三 6；`pnpm router:start`）
 *
 * 形态：**独立小进程**（自研 Fastify，§十 1 定案）。职责只有一件 —— 对"沙箱流路由"查目录并转发，
 * 其余轮询（见 `gateway.ts` 文件头）。
 *
 * ⚠️ 它**不**加载业务后端的 `config.ts`（只管 Redis + 转发，不需要 DB/S3/Docker）——
 *    理由见 `router/config.ts` 文件头。但它**会读 `infra/.env`**（`ROUTER_*` / `REDIS_URL`），
 *    与后端同一套"进程环境优先、文件只补缺"的口径 —— 这样本机 `pnpm router:dev` 不必手工 export。
 *
 * 容器化（P1-14 · R1）：镜像由 `infra/router/Dockerfile` 构建（与业务后端**同一个镜像**，
 * 只是启动命令不同，见该文件头）。网关容器**不挂 docker.sock**、不声明沙箱角色 ——
 * 配置里给 `DOUBULEA_SANDBOX_ROLE=router`（`infra/router/docker-compose.router.yml`）。
 */

import { Redis } from 'ioredis'

import { isSandboxInstanceId, sandboxOwnerKey } from '@doubulea/shared'

import { loadRouterConfig, loadRouterEnvFile } from './config.js'
import { InstanceDiscovery } from './discovery.js'
import { buildRouterApp, type RouterDeps } from './gateway.js'

// ★ 先加载 `infra/.env`（不覆盖已存在的进程环境变量）—— 部署时这些值由 compose 直接注入，
//   本机开发则来自文件；两种形态用同一条代码路径（同一份 `loadRouterConfig` 校验）。
const envFile = loadRouterEnvFile()

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

// ───────────────────────── 实例自动发现（R1；`ROUTER_DISCOVERY_SEC=0` 关闭）─────────────────────────
const discovery = new InstanceDiscovery(redis, {
  seed: config.upstreams,
  fallbackPort: config.fallbackBackendPort,
  ttlMs: config.instanceTtlMs,
  loadStaleMs: config.loadStaleMs,
}, config.discoveryIntervalMs)

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
  // 只有开了自动发现才接上：关掉时 `selectUpstream` 拿到的是 `undefined` ⇒ 退回 `config.upstreams`，
  // 与 R9 的静态表行为逐字一致（含"粘性命中要求 owner 正好写在上游表里"的老口径）。
  ...(config.discoveryIntervalMs > 0
    ? {
        upstreams: () => discovery.current().upstreams,
        discovery: () => discovery.current(),
      }
    : {}),
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
    discovery.stop()
    await app.close()
    redis.disconnect()
  } catch (error) {
    console.error('[router] 退出时出错（仍会退出）：', error)
  }
  process.exit(0)
}

try {
  // 启动先扫一轮：不然新起的实例要等一个轮询周期才被看见（"刚扩容却不接流量"很反直觉）
  if (config.discoveryIntervalMs > 0) await discovery.refresh()
  await app.listen({ host: config.host, port: config.port })
  const active = config.discoveryIntervalMs > 0 ? discovery.current().upstreams : config.upstreams
  console.log(
    `[router] 已启动：http://${config.host}:${config.port} → 上游 [${active.join(', ')}]` +
      `（目录前缀 ${config.ownerKeyPrefix}；SSE 透传、不设 idle 超时；` +
      (config.discoveryIntervalMs > 0
        ? `自动发现每 ${config.discoveryIntervalMs / 1000}s 扫 sandbox:instance:*，缺端口时补 ${config.fallbackBackendPort}）`
        : '自动发现关闭，只用静态 ROUTER_UPSTREAMS）') +
      `\n[router] env 文件：${envFile.path ?? envFile.note}`,
  )
  discovery.start()
} catch (error) {
  console.error(`[router] 监听 ${config.host}:${config.port} 失败：`, error)
  process.exit(1)
}
