/**
 * 沙箱实例注册表的**只读服务**（P1-14 · R5 后台可观测）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 4（实例发现）、§九·补 2.1（负载进注册表）；
 *      契约 `shared/src/sandboxInstance.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它与网关的自动发现是**同一份判据**（刻意的）
 * ─────────────────────────────────────────────────────────────────────
 * `readInstanceRegistrations`（`router/discovery.ts`，纯 I/O 的 `SCAN` + `MGET`）与
 * `parseInstanceRegistrationWithPort`（`shared/src/routerInstance.ts`，形状判据）都被网关用过；
 * 这里直接复用，只是**不做**"过期只排后"与"Redis 失败保持上一轮"那套内存快照：
 * 后台页面要看的是**此刻 Redis 里到底有什么**，所以失败就如实报 `error`、不做兜底。
 *
 * ⚠️ 本文件**不写**注册表：心跳写入只在 `sandbox/owner.ts`（同 `token.ts` 的纪律）。
 */

import {
  mergeUpstreams,
  parseInstanceRegistrationWithPort,
  SANDBOX_INSTANCE_KEY_PREFIX,
  sandboxInstancesResultSchema,
  type SandboxInstanceItem,
  type SandboxInstancesResult,
} from '@doubulea/shared'

import { config } from '../config.js'
import { resolveEnvFile } from '../config.js'
import { ensureRedisConnected } from '../infra/redis.js'
import { loadRouterConfig, resolveRouterEnvFile } from '../router/config.js'
import { readInstanceRegistrations } from '../router/discovery.js'
import { detectSandboxRole } from '../sandbox/roleOverride.js'

/**
 * 读一遍实例注册表（只读、幂等、无缓存）。
 *
 * `upstreams` 的种子取**网关那份配置**（`ROUTER_UPSTREAMS` 读同一份 env 文件）—— 业务后端自己的
 * AppConfig 不含它（那是网关变量）。读不到网关配置时退回空种子（只列发现的实例）。
 */
export async function listSandboxInstances(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxInstancesResult> {
  const role = detectSandboxRole(env, () => config.sandbox.enabled).role
  const loadStaleMs = (config.sandbox.instanceHeartbeatSec > 0 ? config.sandbox.instanceHeartbeatSec * 2 : 120) * 1000
  const seed = routerUpstreamSeeds(env)

  let items: SandboxInstanceItem[] = []
  let error: string | null = null
  try {
    const redis = await ensureRedisConnected()
    const { keys, values } = await readInstanceRegistrations(redis)
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      if (key === undefined) continue
      const keyInstanceId = key.startsWith(`${SANDBOX_INSTANCE_KEY_PREFIX}:`)
        ? key.slice(SANDBOX_INSTANCE_KEY_PREFIX.length + 1)
        : undefined
      const registration = parseInstanceRegistrationWithPort(values[index] ?? null, config.port, keyInstanceId)
      if (registration === undefined) continue
      items.push({
        instanceId: registration.instanceId,
        advertiseAddr: registration.advertiseAddr,
        pid: registration.pid,
        host: registration.host,
        startedAt: registration.startedAt,
        load: registration.load ?? null,
        runtimes: registration.runtimes ?? null,
        canBuild: registration.canBuild ?? null,
        readiness:
          registration.ready === undefined
            ? null
            : {
                ready: registration.ready,
                // 宿主平台由节点自检上报（老版本没有 ⇒ 空串）；`needsRelay` 由平台推不出来时不猜
                hostPlatform: registration.hostPlatform ?? '',
                needsRelay: registration.needsRelay === true,
                missing: registration.missing ?? [],
              },
      })
    }
    items = items.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  } catch (caught) {
    // 读失败要**如实**告诉页面（而不是显示"零台实例"——那会把 Redis 抖动误读成"全下线"）
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const merged = mergeUpstreams(
    seed,
    items.map((item) => ({
      instanceId: item.instanceId,
      advertiseAddr: item.advertiseAddr,
      pid: item.pid,
      host: item.host,
      startedAt: item.startedAt,
    })),
  )
  return sandboxInstancesResultSchema.parse({
    upstreams: merged.upstreams,
    discovered: merged.discovered,
    items,
    role,
    selfInstanceId: role === 'backend' ? config.sandbox.instanceId : null,
    loadStaleMs,
    error,
  })
}

/** 网关的静态种子（`ROUTER_UPSTREAMS`）。读不到 / 没配 ⇒ 空数组（不报错：本端点仍要能列发现的实例） */
function routerUpstreamSeeds(env: NodeJS.ProcessEnv): string[] {
  // 与网关同一口径：先补 env 文件（**只在**调用方没显式给 `env` 时才读文件，避免测试被本机文件污染）
  if (env === process.env) {
    const info = resolveEnvFile(env)
    if (info.path !== undefined) process.loadEnvFile(info.path)
    resolveRouterEnvFile(env)
  }
  return loadRouterConfig({ ...env }).config?.upstreams ?? []
}
