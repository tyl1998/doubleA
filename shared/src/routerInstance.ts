/**
 * 实例在线注册表的**值契约**（P1-14 §八 4 自动发现；R1 部署编排的配套判据）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §三 5（实例身份）、§五 1（启动抢注）、§八 4（实例发现）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么值契约要放在 `shared`（而不是各写一份）
 * ─────────────────────────────────────────────────────────────────────
 * 同一个键 `sandbox:instance:{instanceId}` 有**两个方向**的使用者：
 *   · **写**：业务后端（`backend/src/sandbox/owner.ts#startInstanceHeartbeat` 心跳续期、
 *     `claimInstanceIdentity` 启动抢注）；
 *   · **读**：路由网关（`backend/src/router/gateway.ts` 自动发现 —— 读注册表得到**在线实例表**）。
 * 两边手写一份 `JSON.parse` + 形状假设，症状会是**静默**的：字段名一改，网关只是"看不见实例"，
 * 退回静态表、日志里一条错都没有。⇒ 值的**解析判据只此一处**（同 `router.ts` 的分类判据）。
 *
 * ⚠️ 本文件**零 IO**（不碰 Redis/PG/FS）⇒ 后端与网关进程都能直接引用，回归脚本也能逐条核对。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ `advertiseAddr` 是**网关可回连的地址**，不是实例 id
 * ─────────────────────────────────────────────────────────────────────
 * 网关的目标是 `host:port`（`ROUTER_UPSTREAMS` 与 `selectUpstream` 同一形态）。注册值里的
 * `advertiseAddr` 就是实例自报的 `host:port`（`SANDBOX_INSTANCE_ADVERTISE_ADDR`，未配时
 * `os.hostname() + BACKEND_PORT`）⇒ 自动发现时**直接拿来用**，不做任何拼接/推断。
 */

import { isSandboxInstanceId, type InstanceLoad } from './router.js'

/** 实例注册值（`sandbox:instance:{instanceId}` 的 JSON 体） */
export interface InstanceRegistration {
  instanceId: string
  /** 网关回连本实例的 `host:port`（同 `ROUTER_UPSTREAMS` 的形态） */
  advertiseAddr: string
  /** 进程 pid（同宿主重启时用于判定"旧键是不是僵尸"） */
  pid: number
  /** 宿主名（同 pid 一起做僵尸判定；跨宿主同名时另一台看不出它死了，交给 TTL） */
  host: string
  /** 最近一次心跳 / 抢注的时刻（epoch ms） */
  startedAt: number
  /**
   * 本实例负载快照（P1-14 · R3；`§九·补` 2.1）。
   * **可选**：心跳关掉 / 老版本注册值 / 采样失败都可能是 `undefined` ⇒ 网关按"没有负载"处理（退回轮询）。
   */
  load?: InstanceLoad | undefined
  /**
   * 本实例**已就绪的沙箱运行时**（P1-17a × P1-14；可选）。
   *
   * ⚠️ **可选、且坏值不废除整条注册值**（与 {@link load} 同一纪律）：老版本注册值没有这个字段，
   *    网关/后台页只需要"在线"，能力缺失时按"未知"展示（不是"没有"）。
   * ⚠️ 只放**变体 id**（`node22-python310` 这种）；镜像 ref 随时可由版本线推出，放进心跳只会
   *    让"同一 id 在两台机器上 tag 不同"这种差异把注册值写得又长又容易失配。
   */
  runtimes?: string[] | undefined
  /**
   * 本实例**能否按需构建**运行时镜像（构建上下文可见 + docker 可用；P1-17a）。
   * 可选：未上报 ⇒ `undefined`（**未知**），网关侧不需要它，只有"选在这台构建"时用。
   */
  canBuild?: boolean | undefined
  /**
   * 节点**就绪**（P1-14 部署优化：docker / 沙箱网 / egress / relay / toolkit / 工作区都满足）。
   * 可选；未上报 ⇒ `undefined`（老版本，按"未知"处理 —— 不因此把实例排除）。
   * `false` ⇒ 网关**仍保留**它（可见），但会话选择列表不提供它。
   */
  ready?: boolean | undefined
  /** 未就绪的必需项（键来自 `sandbox/nodeBootstrap.ts` 的 `NodeCheckItem.key`） */
  missing?: string[] | undefined
  /** 宿主平台（`darwin` / `linux` / `darwin-or-windows-vm`；页面展示用） */
  hostPlatform?: string | undefined
  /** 是否需要 relay（macOS/Windows 的 Docker 在 VM 里） */
  needsRelay?: boolean | undefined
}

/**
 * 解析运行时能力（只留**非空字符串**；整体形状不对 ⇒ `undefined`）。
 *
 * ⚠️ 与 {@link parseInstanceLoad} 同一条纪律：形状不对只丢这一项，**不作废整条注册值**。
 *    `[]` 是有效值（"这台确实没有额外运行时"），与 `undefined`（"不知道"）刻意区分。
 */
export function parseInstanceRuntimes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 解析负载字段（形状不对 ⇒ `undefined`，**不因此作废整条注册值**：在线与否比负载更重要） */
export function parseInstanceLoad(value: unknown): InstanceLoad | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { slotsUsed, slotsTotal, queueDepth, chatbotInFlight, sampledAt } = value as Record<string, unknown>
  if (!isCount(slotsUsed) || !isCount(slotsTotal) || !isCount(queueDepth) || !isCount(chatbotInFlight)) return undefined
  if (typeof sampledAt !== 'number' || !Number.isFinite(sampledAt) || sampledAt <= 0) return undefined
  if (slotsUsed > slotsTotal) return undefined
  return { slotsUsed, slotsTotal, queueDepth, chatbotInFlight, sampledAt }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * 解析注册值（**唯一判据**）。
 *
 * 形状不对、字段缺失、`advertiseAddr` 不是 `host:port`、`instanceId` 与键后缀不一致 ⇒ `undefined`。
 * ⚠️ `instanceId` 必须与**键的后缀**一致：不一致说明键被人写坏了（或两代代码混跑），此时
 *    宁可当它不在线（网关退回静态表/轮询），也不要拿一个对不上的 id 去参与路由。
 */
export function parseInstanceRegistration(raw: string | null | undefined, keyInstanceId?: string): InstanceRegistration | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { instanceId, advertiseAddr, pid, host, startedAt, load, runtimes, canBuild, ready, missing, hostPlatform, needsRelay } =
    parsed as Record<string, unknown>
  if (!isSandboxInstanceId(instanceId)) return undefined
  if (keyInstanceId !== undefined && instanceId !== keyInstanceId) return undefined
  if (typeof advertiseAddr !== 'string' || !isAdvertiseAddr(advertiseAddr)) return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof host !== 'string' || host.trim() === '') return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return undefined
  const parsedLoad = parseInstanceLoad(load)
  const parsedRuntimes = parseInstanceRuntimes(runtimes)
  return {
    instanceId,
    advertiseAddr: advertiseAddr.trim(),
    pid,
    host,
    startedAt,
    ...(parsedLoad === undefined ? {} : { load: parsedLoad }),
    ...(parsedRuntimes === undefined ? {} : { runtimes: parsedRuntimes }),
    ...(typeof canBuild === 'boolean' ? { canBuild } : {}),
    ...(typeof ready === 'boolean' ? { ready } : {}),
    ...(typeof hostPlatform === 'string' && hostPlatform.trim() !== '' ? { hostPlatform: hostPlatform.trim() } : {}),
    ...(typeof needsRelay === 'boolean' ? { needsRelay } : {}),
    ...(Array.isArray(missing)
      ? {
          missing: missing.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()),
        }
      : {}),
  }
}

/**
 * `host:port`（与 `router/config.ts#parseUpstream` 同一形态，但**端口必填**）。
 *
 * 为什么必填：`ROUTER_UPSTREAMS` 里 `a` 可以（缺省 80，运维手写表），但**实例自报的地址**
 * 少了端口意味着配置漏写（`SANDBOX_INSTANCE_ADVERTISE_ADDR=b` 而不是 `b:13000`）⇒ 网关会往
 * 80 端口转发、表现为"实例不可达"，而不是"配置写错了"。这里宁可判它无效、让网关退回静态表。
 */
export function isAdvertiseAddr(value: string): boolean {
  const trimmed = value.trim()
  const match = /^([a-z0-9._-]+):(\d{1,5})$/iu.exec(trimmed)
  if (match === null) return false
  const port = Number(match[2])
  return port >= 1 && port <= 65_535
}

/**
 * 带**兼容补全**的解析：注册值里 `advertiseAddr` 没写端口时，用 `fallbackPort`（后端的 `BACKEND_PORT`）补上。
 *
 * ⚠️ 为什么需要：注册值由**后端**写，地址默认 `os.hostname() + BACKEND_PORT`（带端口）；但历史上
 *    也允许手工设成 `b`（不带端口）—— 网关不能因为"端口没写"就把一个**在线**实例当成离线
 *    （那会表现为"自动发现看不见某台"，且日志里只有一行 warn）。补全后的地址仍要能通过
 *    {@link isAdvertiseAddr}（host 段非法照样判无效）。
 */
export function parseInstanceRegistrationWithPort(
  raw: string | null | undefined,
  fallbackPort: number,
  keyInstanceId?: string,
): InstanceRegistration | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = { ...(parsed as Record<string, unknown>) }
  const addr = candidate.advertiseAddr
  if (typeof addr === 'string' && /^[a-z0-9._-]+$/iu.test(addr.trim())) {
    candidate.advertiseAddr = `${addr.trim()}:${fallbackPort}`
  }
  return parseInstanceRegistration(JSON.stringify(candidate), keyInstanceId)
}

/**
 * 把在线注册表**归一成网关用的上游表**（纯函数）：
 *   · 丢掉解析不出来的值；
 *   · 按 `instanceId` 去重（同 id 的过期重复值只算一次）；
 *   · 以**静态种子在前、发现到的在后**的顺序给出（静态表是运维手写的冷启动兜底，
 *     自动发现只做增量，不改变静态表里已有序的相对次序）；
 *   · 顺带返回"哪些地址是自动发现的"，供 `/health` 与日志区分。
 *
 * ⚠️ 静态表里的地址**永远保留**（即使自动发现没看见它）：那是"网关知道要找谁"的种子，
 *    也是心跳被关掉（`SANDBOX_INSTANCE_HEARTBEAT_SEC=0`）时唯一的来源（`子方案` §八 4）。
 */
export function mergeUpstreams(
  seed: readonly string[],
  registrations: readonly InstanceRegistration[],
): { upstreams: string[]; discovered: string[] } {
  const upstreams: string[] = []
  for (const target of seed) {
    if (target.trim() !== '' && !upstreams.includes(target)) upstreams.push(target)
  }
  const discovered: string[] = []
  for (const registration of registrations) {
    const target = registration.advertiseAddr
    if (upstreams.includes(target)) continue
    upstreams.push(target)
    discovered.push(target)
  }
  return { upstreams, discovered }
}
