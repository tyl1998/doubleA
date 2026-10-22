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
  AppError,
  mergeUpstreams,
  parseInstanceRegistrationWithPort,
  SANDBOX_INSTANCE_KEY_PREFIX,
  sandboxInstancesResultSchema,
  type SandboxDrainResult,
  type SandboxInstanceItem,
  type SandboxInstancesResult,
} from '@doubulea/shared'

import { config } from '../config.js'
import { resolveEnvFile } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { ensureRedisConnected, sandboxDrainedKey, sandboxInstanceKey } from '../infra/redis.js'
import { loadRouterConfig, resolveRouterEnvFile } from '../router/config.js'
import { readInstanceDrainMarks, readInstanceRegistrations } from '../router/discovery.js'
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
    // ★ 摘流标记**直接读键**（2026-10-21 修正）：不依赖被摘那台的心跳上报 ——
    //   容器里的实例可能跑的是旧版本（不会读标记），页面也必须立刻显示"已摘流"。
    //   读失败 ⇒ 空集（页面不因此报错：摘流状态读不到比"实例列表读不到"轻得多）。
    const drainMarks = new Set(await readInstanceDrainMarks(redis).catch(() => [] as string[]))
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
        // 摘流 = `sandbox:drain:{id}` 键存在（与网关自动发现**同一个事实来源**）
        drained: drainMarks.has(registration.instanceId),
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

/**
 * 摘流 / 恢复（`POST /api/admin/sandbox/instances/:id/drain`，**仅 ADMIN**；2026-10-21）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不能直接删 `sandbox:instance:{id}`
 * ─────────────────────────────────────────────────────────────────────
 * 那个键由**那台实例自己**的心跳续期：删掉后一个心跳周期就长回来了 —— 删键不是"摘流"，
 * 只是一次会自愈的抖动。真正能"留住"的只有两种写法：
 *   · 在**被摘那台自己**的进程里改状态（要么重启，要么有端点打到它）；
 *   · 写一个**它每拍心跳都会读**的外部标记 —— 就是这里做的（`sandbox:drain:{id}`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 语义刻意收窄：只挡**新会话**
 * ─────────────────────────────────────────────────────────────────────
 * `drained` 只让网关**不再把它当新 owner 的候选**；已钉在这台的会话（`sandbox:owner:*` 指向它、
 * 工作区/容器都在它本地盘）仍照常接。想连它们也挪走，要等空闲回收或重启这台 ——
 * 那是"迁移"（§4 的 P3），不是"摘流"。
 *
 * ⚠️ **摘流不等于下线**：它的注册键继续续期（网关仍然"看得见"它），`/health` 仍会轮到它。
 *    这是刻意的：摘流是运维的**软手段**（比如要手工换镜像、不想接新活），不是故障。
 *
 * @returns 写完之后**目标实例**的摘流状态
 * @throws `AppError.notFound`（404）：目标实例不在注册表里。摘一台不存在的机器没有意义，
 *   而且十有八九是 id 敲错了 —— 静默写入只会留下一个永远没人读的脏键。
 */
export async function setSandboxInstanceDrained(instanceId: string, drained: boolean): Promise<SandboxDrainResult> {
  const redis = await ensureRedisConnected()
  const registered = await redis.exists(sandboxInstanceKey(instanceId))
  if (registered === 0) {
    throw AppError.notFound(`实例 ${instanceId} 不在在线注册表里（可能已下线，或 id 写错）`)
  }
  const key = sandboxDrainedKey(instanceId)
  if (drained) await redis.set(key, '1')
  else await redis.del(key)
  getLogger().info({ instanceId, drained }, '实例摘流标记已更新（drained=true ⇒ 网关不再派新会话给它）')
  // ⚠️ 不需要"让被摘那台刷新注册值"：摘流状态由 `sandbox:drain:{id}` 这个**键**直接表达，
  //   页面（本接口）与网关（自动发现）各自读它 ⇒ 写完立刻可见，与对方的版本/心跳无关。
  return { instanceId, drained }
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
