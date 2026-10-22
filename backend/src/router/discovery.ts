/**
 * 网关侧的**实例自动发现**（P1-14 §八 4；R1 部署编排的配套件）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 4（"第一版静态表即可 / 可选自动发现"）、§九（实例数变化要同步）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它做什么（只做一件，且可整体关掉）
 * ─────────────────────────────────────────────────────────────────────
 * 周期扫 Redis 的实例在线注册表 `sandbox:instance:*`（后端心跳写的）→ 解析 → 与**静态种子**
 * 合并成网关的上游表。`ROUTER_DISCOVERY_SEC=0` 时退化为纯静态表（R9 时的行为，逐字不变）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 三条刻意的取舍
 * ─────────────────────────────────────────────────────────────────────
 *   ① **静态表永远保留**：自动发现只做增量（`shared#mergeUpstreams`）。心跳被关掉、Redis 抖动、
 *      注册值写坏 —— 任何一种情况下网关都还有静态表可用（`§八 4`：静态种子是冷启动兜底）。
 *   ② **"过期"只影响排序、不影响可用性**：判"是否过期"用本进程**见过它成功续期**的时刻
 *      （不只是 Redis 的 TTL 剩余），过期项仍保留在上游表里，只是排到后面 —— 网关没有权利
 *      因为"我觉得它死了"就把它从表里摘掉（那会把"Redis 慢了一拍"变成"实例凭空消失"）。
 *   ③ **失败不空表**：本轮 Redis 失败 ⇒ 保持上一轮的表（首次失败 ⇒ 静态表）。
 *
 * ⚠️ 纯逻辑（解析 / 合并 / 排序）都在 `shared/src/routerInstance.ts`，本文件只做 I/O 编排
 *   （Redis `SCAN` + 定时轮询），因此回归脚本可以只测纯函数、不必起 Redis。
 */

import {
  isSandboxInstanceId,
  mergeUpstreams,
  parseInstanceRegistrationWithPort,
  SANDBOX_DRAIN_KEY_PREFIX,
  SANDBOX_INSTANCE_KEY_PREFIX,
} from '@doubulea/shared'
import type { InstanceLoad, InstanceRegistration, UpstreamCandidate } from '@doubulea/shared'

/**
 * 读注册表的最小接口（回归脚本可注入假实现）。
 *
 * ⚠️ 这两个签名**逐字对齐 ioredis 的重载**（`scan` 只接受 `MATCH`/`COUNT`/`TYPE` 的字面量 token，
 *    `mget` 是 variadic）—— 写成 `(...args: string[])` 会让真实的 `Redis` 客户端赋不进来。
 */
export interface InstanceRegistryReader {
  scan: (
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: string,
  ) => Promise<[cursor: string, keys: string[]]>
  mget: (...keys: string[]) => Promise<Array<string | null>>
}

export interface DiscoveryOptions {
  /** 静态种子（`ROUTER_UPSTREAMS`） */
  seed: readonly string[]
  /** 注册值缺端口时的补全端口（`BACKEND_PORT`） */
  fallbackPort: number
  /** 过期阈值（毫秒，= 3 × 心跳） */
  ttlMs: number
  /** 负载新鲜度阈值（毫秒，= 2 × 心跳；P1-14 · R3）。缺省 ⇒ 全部负载视为过期 */
  loadStaleMs?: number
  now?: () => number
}

/** 一轮发现的结果 */
export interface DiscoverySnapshot {
  /** 本轮完整上游表（静态在前、发现到的在后） */
  upstreams: string[]
  /** 自动发现新增的地址 */
  discovered: string[]
  /** 认作过期的地址（仍在上游表里，只是排后） */
  stale: string[]
  /**
   * 节点自检**明确未就绪**的地址（`ready === false`）。
   *
   * ⚠️ 与 {@link stale} 不同：过期只是"我最近没看见它续期"，仍可转发；未就绪是它**自己说**
   *    "我还不能用"（docker / 网 / egress 缺项）⇒ 网关**不再把它当候选**（`gateway.ts` 里剔除）。
   * ⚠️ 只收 `ready === false`；`undefined`（老版本没上报 / 非 taskAgent 档位）**不算**未就绪。
   */
  unready: string[]
  /**
   * **已摘流**的地址（注册值 `drained === true`；2026-10-21 运维摘流）。
   *
   * ⚠️ 与 {@link unready} 刻意分开：两者都"不接**新**会话"，但
   *    · `unready` 里全是未就绪时，网关会**退回完整表**（`gateway.ts`：宁可试一台也不 503）；
   *    · 摘流不能走那条退路 —— 运维按着不让它接新活时，把它塞回候选等于**点了没反应**。
   *    所以 `gateway.ts` 只把摘流项从 **owner 候选**里剔除（粘性命中仍然照常转发，见那里的注释）。
   */
  drained: string[]
  /** 本轮成功解析出的实例注册项数（`/health` 用：读的人要能看出"自动发现到底看见了几台"） */
  registrations: number
  /** 最近一次成功扫描的时刻（epoch ms）；从未成功为 `undefined` */
  lastScanAt?: number
  /**
   * 实例 **id → 地址**（`advertiseAddr`）。
   *
   * ⚠️ 必须单独给出来：会话目录（`sandbox:owner:{id}`）里存的是**实例 id**（后端写的），
   *    而上游表是 `host:port`。网关不做这层翻译的话，粘性路由永远命不中（"owner 不在线"⇒ 轮询）。
   */
  targets: Record<string, string>
  /**
   * 每台上游的**负载**（地址 → 负载 / 是否过期；P1-14 · R3）。
   *
   * ⚠️ 静态种子里没有负载（没有实例自报就给不出）：它不出现在本表里 ⇒ 视为"没有负载"（轮询次序）。
   */
  loads: Record<string, { load: InstanceLoad; stale: boolean }>
  /** 上游 → 负载的候选视图（顺序与 `upstreams` 一致；直接喂 `selectUpstream`） */
  candidates: UpstreamCandidate[]
}

/**
 * 从 `SCAN` 的一批键 + 值算出本轮快照（纯函数式：`now` 注入，便于回归脚本逐条核对）。
 *
 * @param seenAt  上一轮之前就"见过"的地址 → 它们的最近续期时刻（本函数负责刷新）
 */
export function buildDiscoverySnapshot(
  options: DiscoveryOptions,
  keys: readonly string[],
  values: ReadonlyArray<string | null>,
  seenAt: ReadonlyMap<string, number>,
  /**
   * 本轮 `SCAN sandbox:drain:*` 读到的**实例 id**（2026-10-21 运维摘流）。
   *
   * ⚠️ 摘流**不经过**注册值（不是被摘那台"自报"）：标记键在共享 Redis 里，网关与后台页
   *    各自直接读它 ⇒ ① 被摘那台跑的是**旧版本**也立刻生效（它不会读标记、不会上报）；
   *    ② 不依赖心跳节奏（少一拍就少延迟一个周期）；③ 判据只有一处（键在不在）。
   *    曾经让心跳把 `drained` 写进注册值的做法已废弃（2026-10-21 实测：容器里的旧实例永不生效）。
   */
  drainedInstanceIds: readonly string[] = [],
): { snapshot: DiscoverySnapshot; nextSeenAt: Map<string, number> } {
  const now = (options.now ?? Date.now)()
  const nextSeenAt = new Map(seenAt)
  const registrations: InstanceRegistration[] = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) continue
    const keyInstanceId = key.startsWith(`${SANDBOX_INSTANCE_KEY_PREFIX}:`)
      ? key.slice(SANDBOX_INSTANCE_KEY_PREFIX.length + 1)
      : undefined
    const registration = parseInstanceRegistrationWithPort(values[index] ?? null, options.fallbackPort, keyInstanceId)
    if (registration === undefined) continue
    registrations.push(registration)
    // 本进程"看见它"就算续期（注册值里的 startedAt 是进程启动时刻、不是心跳时刻）
    nextSeenAt.set(registration.advertiseAddr, now)
  }
  const merged = mergeUpstreams(
    options.seed,
    [...registrations].sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
  )
  const stale: string[] = []
  for (const target of merged.discovered) {
    const lastSeen = nextSeenAt.get(target)
    if (lastSeen !== undefined && now - lastSeen > options.ttlMs) stale.push(target)
  }
  // 过期项排后（数组稳定排序：同组内保持"静态在前、发现到的按 instanceId"的相对次序）
  const ordered = [...merged.upstreams].sort((left, right) => Number(stale.includes(left)) - Number(stale.includes(right)))
  const targets: Record<string, string> = {}
  const loads: Record<string, { load: InstanceLoad; stale: boolean }> = {}
  const unready: string[] = []
  const drained: string[] = []
  const loadStaleMs = options.loadStaleMs ?? 0
  for (const registration of registrations) {
    targets[registration.instanceId] = registration.advertiseAddr
    // 节点自检未就绪（P1-14 部署优化）：它自己说不能用 ⇒ 路由候选要剔除（不能等它 5xx 再冷却）
    if (registration.ready === false && !unready.includes(registration.advertiseAddr)) unready.push(registration.advertiseAddr)
    if (registration.load === undefined) continue
    // ⚠️ 新鲜度看**注册值里的 `sampledAt`**（心跳写的时刻），不看"网关看见它的时刻"：
    //    前者才是负载的年龄（心跳停了但键还没 TTL 掉时，负载会如实变旧）。
    loads[registration.advertiseAddr] = { load: registration.load, stale: now - registration.load.sampledAt > loadStaleMs }
  }
  // 摘流 id → 地址（地址映射不到 = 该实例已不在线，摘流无从生效，忽略）
  for (const instanceId of drainedInstanceIds) {
    const target = targets[instanceId]
    if (target !== undefined && !drained.includes(target)) drained.push(target)
  }
  return {
    snapshot: {
      upstreams: ordered,
      discovered: merged.discovered,
      stale,
      unready,
      drained,
      registrations: registrations.length,
      lastScanAt: now,
      targets,
      loads,
      candidates: ordered.map((target) => {
        const entry = loads[target]
        return entry === undefined ? { target } : { target, load: entry.load, stale: entry.stale }
      }),
    },
    nextSeenAt,
  }
}

/**
 * 读一遍**摘流标记**（`SCAN sandbox:drain:*`；返回实例 id 列表）。
 *
 * ⚠️ 只 `SCAN` 不 `GET`：标记的语义就是"键在不在"，值内容不参与判定（值是 `1`，但没人读它）。
 * ⚠️ 与 {@link readInstanceRegistrations} 分成两个函数：**标记的读者不该依赖注册值能不能解析**
 *    —— 一台注册值写坏了也该能被摘流排除。
 */
export async function readInstanceDrainMarks(redis: InstanceRegistryReader): Promise<string[]> {
  const pattern = `${SANDBOX_DRAIN_KEY_PREFIX}:*`
  const ids: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100')
    cursor = next
    for (const key of batch) {
      const instanceId = key.slice(SANDBOX_DRAIN_KEY_PREFIX.length + 1)
      if (isSandboxInstanceId(instanceId) && !ids.includes(instanceId)) ids.push(instanceId)
    }
  } while (cursor !== '0')
  return ids
}

/** 读一遍注册表（`SCAN` 全量；数量级 = 实例数，几十个以内） */
export async function readInstanceRegistrations(redis: InstanceRegistryReader): Promise<{ keys: string[]; values: Array<string | null> }> {
  const pattern = `${SANDBOX_INSTANCE_KEY_PREFIX}:*`
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100')
    cursor = next
    for (const key of batch) if (!keys.includes(key)) keys.push(key)
  } while (cursor !== '0')
  if (keys.length === 0) return { keys, values: [] }
  const values = await redis.mget(...keys)
  return { keys, values }
}

/**
 * 自动发现的**常驻轮询器**（进程内定时器；`start`/`stop` 成对）。
 *
 * ⚠️ 与业务后端的心跳一样是**后台组件**：失败只 warn、绝不抛出（网关的核心职责是转发，
 *    "看不见某个实例"该退化成"用静态表"，而不是让网关挂掉）。
 */
export class InstanceDiscovery {
  private timer: NodeJS.Timeout | undefined
  private seenAt = new Map<string, number>()
  private snapshot: DiscoverySnapshot

  constructor(
    private readonly reader: InstanceRegistryReader,
    private readonly options: DiscoveryOptions,
    private readonly intervalMs: number,
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
  ) {
    this.snapshot = {
      upstreams: [...options.seed],
      discovered: [],
      stale: [],
      unready: [],
      drained: [],
      registrations: 0,
      targets: {},
      loads: {},
      candidates: options.seed.map((target) => ({ target })),
    }
  }

  /** 当前快照（网关每个请求都读它；毫秒级，无 I/O） */
  current(): DiscoverySnapshot {
    return this.snapshot
  }

  /** 跑一轮（幂等；`intervalMs=0` 时调用方只会跑启动那一次） */
  async refresh(): Promise<DiscoverySnapshot> {
    try {
      const { keys, values } = await readInstanceRegistrations(this.reader)
      // 摘流标记：单独一次 SCAN（同一连接、同一轮）。失败 ⇒ 当作"没有摘流"，
      // **不**让整轮发现失败（看见实例比尊重摘流更基础：Redis 抖一下不该让上游表空掉）。
      const drainedInstanceIds = await readInstanceDrainMarks(this.reader).catch((error: unknown) => {
        this.log({ scope: 'router', level: 'warn', event: 'drain-scan-failed', err: describeError(error) })
        return [] as string[]
      })
      const { snapshot, nextSeenAt } = buildDiscoverySnapshot(this.options, keys, values, this.seenAt, drainedInstanceIds)
      this.seenAt = nextSeenAt
      const changed =
        snapshot.upstreams.length !== this.snapshot.upstreams.length ||
        snapshot.upstreams.some((target, index) => target !== this.snapshot.upstreams[index])
      this.snapshot = snapshot
      if (changed) {
        this.log({ scope: 'router', event: 'discovery', upstreams: snapshot.upstreams, discovered: snapshot.discovered, stale: snapshot.stale })
      }
      return snapshot
    } catch (error) {
      // 保持上一轮（首次失败 ⇒ 静态表）：不把"Redis 抖了一下"变成"上游表空了"
      this.log({ scope: 'router', level: 'warn', event: 'discovery-failed', err: error instanceof Error ? error.message : String(error) })
      return this.snapshot
    }
  }

  start(): boolean {
    if (this.timer !== undefined) return false
    if (this.intervalMs <= 0) {
      this.log({ scope: 'router', event: 'discovery-disabled' })
      return false
    }
    this.timer = setInterval(() => void this.refresh(), this.intervalMs)
    this.timer.unref()
    return true
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}

/** 错误 → 单行（日志里不带堆栈） */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
