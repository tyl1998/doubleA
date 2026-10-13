/**
 * 路由网关的配置（P1-14 §四/§八 4；**独立小进程**，不由 `config.ts` 承载）
 *
 * ⚠️ 为什么**不**复用 `backend/src/config.ts`：那是"业务后端"的配置（必填 `DATABASE_URL`/`S3_*`
 *    /`CREDENTIAL_MASTER_KEY`…）。网关只做一件事 —— 查 Redis 目录 + 转发 HTTP ——
 *    让它继承业务后端的全量校验，会变成"只想起网关却因为没配 S3 而失败"（同 P0-1-5 坑 4 的
 *    `prisma.config.ts` 那条推理）。故这里只读它真正需要的几个变量，缺了才大声失败。
 *
 * 变量（`infra/.env.example` 的「路由网关」段）：
 *   · `ROUTER_PORT`（默认 13000）        —— 对外入口；后端 `BACKEND_PORT` 退到内网
 *   · `ROUTER_HOST`（默认 `0.0.0.0`）    —— 监听地址
 *   · `ROUTER_UPSTREAMS`（必填）         —— 在线实例地址表 `a:13000,b:13000`（静态种子）
 *   · `REDIS_URL`                        —— 读 `sandbox:owner:*`（默认 `redis://127.0.0.1:6379`）
 *   · `SANDBOX_OWNER_KEY_PREFIX`         —— 与后端**同名同值**（默认 `sandbox:owner`）
 */

export interface RouterConfig {
  host: string
  port: number
  /** 在线实例地址表（`host:port`）；静态种子（自动发现为后续增强，见 `子方案` §八 4） */
  upstreams: string[]
  redisUrl: string
  ownerKeyPrefix: string
  /** 转发到上游的等待（到响应头）上限（毫秒）。SSE 只受"到响应头"影响，长连接不受它约束 */
  upstreamTimeoutMs: number
}

export interface RouterConfigResult {
  config?: RouterConfig
  /** 致命问题清单（非空 ⇒ 不启动）；调用方打印后 `exit 1` */
  errors: string[]
}

/** `host:port` / `host` → 规范化；非法返回 `null` */
export function parseUpstream(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null
  const match = /^([a-z0-9._-]+)(?::(\d{1,5}))?$/iu.exec(value)
  if (match === null) return null
  const port = match[2] === undefined ? undefined : Number(match[2])
  if (port !== undefined && (port < 1 || port > 65_535)) return null
  return value
}

export function loadRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfigResult {
  const errors: string[] = []
  const rawUpstreams = (env.ROUTER_UPSTREAMS ?? '').split(',')
  const upstreams: string[] = []
  for (const raw of rawUpstreams) {
    if (raw.trim() === '') continue
    const parsed = parseUpstream(raw)
    if (parsed === null) errors.push(`ROUTER_UPSTREAMS 里有非法地址：${raw.trim()}`)
    else if (!upstreams.includes(parsed)) upstreams.push(parsed)
  }
  if (upstreams.length === 0) {
    errors.push('ROUTER_UPSTREAMS 未配置（形如 `a:13000,b:13000`）—— 网关不知道把请求转给谁')
  }

  const port = Number(env.ROUTER_PORT ?? 13000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.push(`ROUTER_PORT 非法：${env.ROUTER_PORT ?? ''}（应为 1~65535 的整数）`)
  }
  const timeoutMs = Number(env.ROUTER_UPSTREAM_TIMEOUT_MS ?? 30_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    errors.push(`ROUTER_UPSTREAM_TIMEOUT_MS 非法：${env.ROUTER_UPSTREAM_TIMEOUT_MS ?? ''}（应 ≥ 1000）`)
  }

  if (errors.length > 0) return { errors }
  return {
    config: {
      host: env.ROUTER_HOST ?? '0.0.0.0',
      port,
      upstreams,
      redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      ownerKeyPrefix: env.SANDBOX_OWNER_KEY_PREFIX ?? 'sandbox:owner',
      upstreamTimeoutMs: timeoutMs,
    },
    errors,
  }
}
