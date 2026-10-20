/**
 * 路由网关的配置（P1-14 §四/§八 4；**独立小进程**，不由 `config.ts` 承载）
 *
 * ⚠️ 为什么**不**复用 `backend/src/config.ts`：那是"业务后端"的配置（必填 `DATABASE_URL`/`S3_*`
 *    /`CREDENTIAL_MASTER_KEY`…）。网关只做一件事 —— 查 Redis 目录/注册表 + 转发 HTTP ——
 *    让它继承业务后端的全量校验，会变成"只想起网关却因为没配 S3 而失败"（同 P0-1-5 坑 4 的
 *    `prisma.config.ts` 那条推理）。故这里只读它真正需要的几个变量，缺了才大声失败。
 *
 * 变量（`infra/.env.example` 的「路由网关」段）：
 *   · `ROUTER_PORT`（默认 13000）        —— 对外入口；后端 `BACKEND_PORT` 退到内网
 *   · `ROUTER_HOST`（默认 `0.0.0.0`）    —— 监听地址
 *   · `ROUTER_UPSTREAMS`（必填）         —— 在线实例地址表 `a:13000,b:13000`（静态种子）
 *   · `REDIS_URL`                        —— 读 `sandbox:owner:*` / `sandbox:instance:*`
 *   · `SANDBOX_OWNER_KEY_PREFIX`         —— 与后端**同名同值**（默认 `sandbox:owner`）
 *   · `ROUTER_DISCOVERY_SEC`（默认 10）  —— 自动发现轮询间隔；`0` = 只用静态表
 *   · `SANDBOX_INSTANCE_HEARTBEAT_SEC`   —— 与后端**同名同值**（默认 30）；用于推导"注册项过期"
 *   · `BACKEND_PORT`（默认 3000）        —— **仅**用于"注册值没带端口"时补全（兼容旧心跳）
 *   · `ROUTER_LOAD_AWARE`（默认开）      —— 负载感知（P2C）的 kill switch；关掉 = 纯轮询（与 R9 一致）
 *   · `ROUTER_LOAD_STALE_MS`             —— 负载新鲜度阈值；**派生 = 2× 心跳**（默认 60s），显式配了才覆盖
 *   · `ROUTER_UPSTREAM_TIMEOUT_LONG_MS`  —— 长任务路由（`POST /api/admin/node/bootstrap` 等）的
 *                                           「到响应头」上限（默认 900000 = 15 分钟，与 nodeOps 转发上限对齐）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ R1 起：网关也读 `.env`（与业务后端同一口径）
 * ─────────────────────────────────────────────────────────────────────
 * 部署编排（compose）里网关**不挂 env_file**（它只需要几项，见 `infra/router/docker-compose.router.yml`），
 * 而本机开发 `pnpm router:dev` 又要能直接读到 `infra/.env` 里的 `REDIS_URL` / `ROUTER_UPSTREAMS`。
 * ⇒ 与业务后端同款规则：**已存在的进程环境变量优先**，只用文件补缺（`process.loadEnvFile` 的语义）。
 * ⚠️ 测试与 CI 用 `DOUBULEA_ENV_FILE` 显式指定 / `DOUBULEA_SKIP_ENV_FILE=1` 跳过 —— 与后端同一个开关名。
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与后端**同名**的两个开关（`backend/src/config.ts` 的 `resolveEnvFile`）：语义保持一致，否则排障时两套规则打架 */
const ENV_FILE_OVERRIDE = 'DOUBULEA_ENV_FILE'
const ENV_FILE_SKIP = 'DOUBULEA_SKIP_ENV_FILE'
/** 工作区根标志文件（与后端同一约定，用于跨平台定位 `infra/.env`） */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'
const MAX_ANCESTOR_HOPS = 8

/** 本文件所在目录（源码期 `backend/src/router`；构建后 `backend/dist/backend/src/router`） */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

export interface RouterConfig {
  host: string
  port: number
  /** 静态上游表（`host:port`）：冷启动种子；自动发现只做增量（§八 4） */
  upstreams: string[]
  redisUrl: string
  ownerKeyPrefix: string
  /** 转发到上游的等待（到响应头）上限（毫秒）。SSE 只受"到响应头"影响，长连接不受它约束 */
  upstreamTimeoutMs: number
  /** 长任务路由（一键初始化等同步长操作）的「到响应头」上限（毫秒） */
  upstreamTimeoutLongMs: number
  /** 自动发现轮询间隔（毫秒）；`0` = 关闭（只用静态 `ROUTER_UPSTREAMS`） */
  discoveryIntervalMs: number
  /** 实例注册项的存活期（毫秒）= 3 × `SANDBOX_INSTANCE_HEARTBEAT_SEC`（与后端 `instanceRegistrationTtlSec` 同式） */
  instanceTtlMs: number
  /** 注册值里 `advertiseAddr` 缺端口时补的端口（`BACKEND_PORT`） */
  fallbackBackendPort: number
  /** 是否按负载挑上游（`ROUTER_LOAD_AWARE`，默认 `true`；`false` = 纯轮询） */
  loadAware: boolean
  /** 负载新鲜度阈值（毫秒）：超过即视为过期 ⇒ 该台退回轮询次序 */
  loadStaleMs: number
}

export interface RouterConfigResult {
  config?: RouterConfig
  /** 致命问题清单（非空 ⇒ 不启动）；调用方打印后 `exit 1` */
  errors: string[]
}

/** 环境变量文件的定位信息（启动日志里带上，出问题时一眼看出读的是哪个文件） */
export interface RouterEnvFileInfo {
  path: string | undefined
  note: string
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

/** 向上找工作区根（含 `pnpm-workspace.yaml` 的目录）；源码期与产物期深浅不同，故按标志文件而不是相对层数 */
function findWorkspaceRoot(from: string): string | undefined {
  let dir = from
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 定位 `infra/.env`：`DOUBULEA_ENV_FILE` 显式指定 > 工作区根 `infra/.env` > cwd 及上级。
 * 与 `backend/src/config.ts#resolveEnvFile` 同一口径（含两个开关），只是不抛错、只给说明。
 */
export function resolveRouterEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  from: string = MODULE_DIR,
): RouterEnvFileInfo {
  const skip = (env[ENV_FILE_SKIP] ?? '').trim().toLowerCase()
  if (skip === '1' || skip === 'true') return { path: undefined, note: `${ENV_FILE_SKIP}=1 —— 只读进程环境` }

  const override = (env[ENV_FILE_OVERRIDE] ?? '').trim()
  if (override !== '') {
    const target = isAbsolute(override) ? override : resolve(process.cwd(), override)
    return existsSync(target)
      ? { path: target, note: `${ENV_FILE_OVERRIDE} 显式指定` }
      : { path: undefined, note: `${ENV_FILE_OVERRIDE} 指向的文件不存在：${target}` }
  }

  const candidates: string[] = []
  const root = findWorkspaceRoot(from)
  if (root !== undefined) candidates.push(resolve(root, 'infra/.env'))
  candidates.push(resolve(process.cwd(), 'infra/.env'))
  candidates.push(resolve(process.cwd(), '..', 'infra/.env'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, note: '自动定位（工作区根 / cwd）' }
  }
  return { path: undefined, note: `未找到 infra/.env（已尝试：${candidates.join(' / ')}）—— 只用进程环境变量` }
}

/**
 * 按 12-factor 语义加载 `.env`：**不覆盖**已存在的进程环境变量。
 *
 * @returns 实际加载的文件信息（未加载时 `path` 为 `undefined`，`note` 说明原因）
 */
export function loadRouterEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  from: string = MODULE_DIR,
): RouterEnvFileInfo {
  const info = resolveRouterEnvFile(env, from)
  if (info.path !== undefined) process.loadEnvFile(info.path)
  return info
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

  const port = Number(env.ROUTER_PORT ?? 13000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.push(`ROUTER_PORT 非法：${env.ROUTER_PORT ?? ''}（应为 1~65535 的整数）`)
  }
  const timeoutMs = Number(env.ROUTER_UPSTREAM_TIMEOUT_MS ?? 30_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    errors.push(`ROUTER_UPSTREAM_TIMEOUT_MS 非法：${env.ROUTER_UPSTREAM_TIMEOUT_MS ?? ''}（应 ≥ 1000）`)
  }
  // 长任务路由的上限（2026-10-20）：bootstrap 等 handler 是同步长操作（拉镜像/建镜像/起容器），
  // 普通 30s 会在中途掐断连接（目标机上的活没停 ⇒ "点两次才成功"的假象）。默认 15 分钟 =
  // `nodeOps.ts` 跨实例转发给 bootstrap 的上限，两边对齐。
  const timeoutLongMs = Number(env.ROUTER_UPSTREAM_TIMEOUT_LONG_MS ?? 900_000)
  if (!Number.isInteger(timeoutLongMs) || timeoutLongMs < 1000) {
    errors.push(`ROUTER_UPSTREAM_TIMEOUT_LONG_MS 非法：${env.ROUTER_UPSTREAM_TIMEOUT_LONG_MS ?? ''}（应 ≥ 1000）`)
  } else if (timeoutLongMs < timeoutMs) {
    errors.push(`ROUTER_UPSTREAM_TIMEOUT_LONG_MS（${String(timeoutLongMs)}）不应小于 ROUTER_UPSTREAM_TIMEOUT_MS（${String(timeoutMs)}）—— 长任务只会更慢，不会更快`)
  }
  const discoverySec = Number(env.ROUTER_DISCOVERY_SEC ?? 10)
  if (!Number.isInteger(discoverySec) || discoverySec < 0 || discoverySec > 3600) {
    errors.push(`ROUTER_DISCOVERY_SEC 非法：${env.ROUTER_DISCOVERY_SEC ?? ''}（应为 0~3600 的整数；0 = 关闭自动发现）`)
  }
  // 与后端 `instanceRegistrationTtlSec()` 同式：开心跳 = 3× 心跳；关心跳 = 120s（只够启动自检）
  const heartbeatSec = Number(env.SANDBOX_INSTANCE_HEARTBEAT_SEC ?? 30)
  if (!Number.isInteger(heartbeatSec) || heartbeatSec < 0 || heartbeatSec > 3600) {
    errors.push(
      `SANDBOX_INSTANCE_HEARTBEAT_SEC 非法：${env.SANDBOX_INSTANCE_HEARTBEAT_SEC ?? ''}（应为 0~3600 的整数，与后端同值）`,
    )
  }
  // 负载感知（P1-14 · R3）：kill switch，默认开（"状态上报了就该拿它决策"）。
  // ⚠️ 与自动发现联动：`ROUTER_DISCOVERY_SEC=0` 时没有负载来源，开与不开等价（轮询）。
  const rawLoadAware = (env.ROUTER_LOAD_AWARE ?? 'true').trim().toLowerCase()
  if (!['1', '0', 'true', 'false', 'on', 'off', 'yes', 'no'].includes(rawLoadAware)) {
    errors.push(`ROUTER_LOAD_AWARE 非法：${env.ROUTER_LOAD_AWARE ?? ''}（应为 true/false；默认 true）`)
  }
  const loadAware = ['1', 'true', 'on', 'yes'].includes(rawLoadAware)
  // 新鲜度默认**派生** = 2× 心跳（结构性容忍丢一拍）；显式配置才覆盖
  const derivedLoadStaleMs = (heartbeatSec > 0 ? heartbeatSec * 2 : 120) * 1000
  const loadStaleMs = env.ROUTER_LOAD_STALE_MS === undefined ? derivedLoadStaleMs : Number(env.ROUTER_LOAD_STALE_MS)
  if (!Number.isInteger(loadStaleMs) || loadStaleMs < 1000) {
    errors.push(`ROUTER_LOAD_STALE_MS 非法：${env.ROUTER_LOAD_STALE_MS ?? ''}（应为 ≥ 1000 的整数；不配则派生 2× 心跳）`)
  }
  const fallbackBackendPort = Number(env.BACKEND_PORT ?? 3000)
  if (!Number.isInteger(fallbackBackendPort) || fallbackBackendPort < 1 || fallbackBackendPort > 65_535) {
    errors.push(`BACKEND_PORT 非法：${env.BACKEND_PORT ?? ''}（应为 1~65535 的整数；仅用于补全注册值的端口）`)
  }

  // ⚠️ 静态表空**不再直接报错**，但必须满足其一：静态表非空 / 开了自动发现。
  //    两者都没有 = 网关不知道把请求转给谁 ⇒ 与 R9 时同样的"大声失败"口径。
  if (upstreams.length === 0 && discoverySec <= 0) {
    errors.push(
      'ROUTER_UPSTREAMS 未配置（形如 `a:13000,b:13000`）且 ROUTER_DISCOVERY_SEC=0（自动发现已关闭）—— 网关不知道把请求转给谁',
    )
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
      upstreamTimeoutLongMs: timeoutLongMs,
      discoveryIntervalMs: discoverySec * 1000,
      instanceTtlMs: (heartbeatSec > 0 ? heartbeatSec * 3 : 120) * 1000,
      fallbackBackendPort,
      loadAware,
      loadStaleMs,
    },
    errors,
  }
}
