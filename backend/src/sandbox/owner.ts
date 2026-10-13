/**
 * 会话→实例目录 + 实例在线注册表（**P1-14** 沙箱多机部署；**P1-9 · R9** 复用）
 *
 * 依据：`docs/子方案/沙箱多机部署.md`（§三 5 会话→实例目录 / §五 1 同名自检 / §八 4 实例发现）、
 *      `docs/子方案/Code模式工作区.md` §十六 B/C（钉机记录**早于建容器**、寿命**跟随工作区**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这里只有两张表、而且它们都是 Redis（不是 PG）
 * ─────────────────────────────────────────────────────────────────────
 * 容器归属是**运行期事实**（按需创建、可能落在任意实例），不是 `hash(会话) % N` 能算出来的 ⇒
 * 必须有一张登记表。放进 Redis 而不是 `sandboxes` 表，是因为：
 *   · 它是**软状态**（进程崩溃 / 实例下线后，由 TTL 自然摘除即可）—— 放 PG 会留下"指向死实例"
 *     的行，还得写一套对账去清；
 *   · 它是**路由的热路径**（每条粘性请求都要读）—— Redis 的一次 `GET` 比 DB 往返便宜得多。
 * `Sandbox.instanceId`（账本归属列，见 `prisma/schema.prisma`）仍落在 PG —— 那是"**曾经由谁创建**"
 * 的审计留痕，与"**此刻该去哪台**"是两问，刻意分开。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处 TTL 都是刻意的
 * ─────────────────────────────────────────────────────────────────────
 *   · **容器目录**（`handler=C`）：`SANDBOX_OWNER_TTL_SEC`（默认 2h），必须 > 容器空闲回收。
 *   · **工作区目录**（`handler=W`）：`retentionDays` 天 + 1h —— 工作区是**宿主本地盘**、寿命按天计
 *     （`Code模式工作区.md` §十六 C），用容器那 2h 会让"容器回收后会话被重钉、工作区留在原机"。
 *   · **实例注册**：`3 × 心跳`（`§八 4`）；关掉心跳时退化为一个短 TTL（仅够做启动同名自检）。
 *
 * ⚠️ 本模块是**唯一**写这两张表的地方（同 `token.ts` 的纪律）：读出口可以有很多，写出口只此一个。
 */

import { hostname } from 'node:os'

import { isSandboxInstanceId } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { ensureRedisConnected, sandboxInstanceKey, sandboxOwnerKey } from '../infra/redis.js'

/** 目录项（`sandbox:owner:{id}` 的值）：值 = 实例 id；用 JSON 包一层以便将来扩字段 */
interface OwnerRecord {
  instanceId: string
  /** 写目录的时刻（epoch ms）—— 排障时能看出"这条钉了多久" */
  at: number
}

/** 实例注册项（`sandbox:instance:{id}` 的值） */
interface InstanceRecord {
  instanceId: string
  /** 网关回连本实例的地址（`host:port`） */
  advertiseAddr: string
  /** 进程 pid（同宿主重启时用于判定"旧键是不是僵尸"） */
  pid: number
  /** 宿主名（同 pid 一起做僵尸判定；跨宿主同名时另一台看不出它死了，交给 TTL） */
  host: string
  /** 启动时刻（epoch ms） */
  startedAt: number
}

/** 实例心跳定时器（进程内；`start`/`stop` 成对） */
let heartbeatTimer: NodeJS.Timeout | undefined

// ───────────────────────────── 实例身份 ─────────────────────────────

/** 网关回连本实例的地址；未显式配置时由宿主名 + 监听端口拼出（`子方案` §四） */
export function instanceAdvertiseAddr(): string {
  return config.sandbox.instanceAdvertiseAddr ?? `${hostname()}:${config.port}`
}

/** 实例注册键的 TTL（秒）：开心跳 = 3× 心跳；关心跳 = 一个短 TTL（只够启动自检用） */
export function instanceRegistrationTtlSec(): number {
  const heartbeat = config.sandbox.instanceHeartbeatSec
  return heartbeat > 0 ? heartbeat * 3 : 120
}

/** 工作区钉机记录的 TTL（秒）：至少跟到工作区保留期之后（`§十六 C`） */
export function workspaceOwnerTtlSec(): number {
  return Math.max(config.sandbox.ownerTtlSec, config.workspace.retentionDays * 86_400 + 3_600)
}

/**
 * 启动时抢占本实例的 id（`子方案` §五 1，**硬约束**）。
 *
 * 抢不到 = 有同名实例在线 ⇒ 调用方**拒绝启动**（同 id 两实例会让对账互相误杀，比"起不来"更糟）。
 * 唯一的例外：键还在、但值指向**同一个宿主上已经不存在的 pid** ⇒ 那是一次崩溃留下的僵尸键，
 * **接管**它（否则 `tsx watch` / 崩溃重启会在 TTL 窗口内集体拒启，把一个安全护栏变成日常故障）。
 *
 * @returns `{ ok:true }` 拿到（或接管）；`{ ok:false, heldBy }` 有同名活实例在线
 */
export async function claimInstanceIdentity(): Promise<{ ok: true; tookOver: boolean } | { ok: false; heldBy: string }> {
  const redis = await ensureRedisConnected()
  const key = sandboxInstanceKey(config.sandbox.instanceId)
  const record: InstanceRecord = {
    instanceId: config.sandbox.instanceId,
    advertiseAddr: instanceAdvertiseAddr(),
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
  }
  const ttl = instanceRegistrationTtlSec()
  const claimed = await redis.set(key, JSON.stringify(record), 'EX', ttl, 'NX')
  if (claimed !== null) return { ok: true, tookOver: false }

  const existing = parseInstanceRecord(await redis.get(key))
  if (existing !== undefined && existing.host === record.host && existing.pid !== process.pid && !isPidAlive(existing.pid)) {
    // 同宿主、旧 pid 已死 ⇒ 僵尸键，直接接管（`SET XX` 不新建，避免与别人抢）
    await redis.set(key, JSON.stringify(record), 'EX', ttl, 'XX')
    getLogger().warn(
      { instanceId: config.sandbox.instanceId, stalePid: existing.pid },
      '接管了一个崩溃实例留下的同名注册键（同宿主、旧 pid 已不存在）',
    )
    return { ok: true, tookOver: true }
  }
  return { ok: false, heldBy: existing?.advertiseAddr ?? '（值不可读）' }
}

/**
 * 启动实例心跳：周期把注册键续到 3× 心跳的 TTL。
 * @returns 是否真的启动了（`SANDBOX_INSTANCE_HEARTBEAT_SEC=0` 时返回 `false`，退化为静态列表）
 */
export function startInstanceHeartbeat(): boolean {
  if (heartbeatTimer !== undefined) return false
  const heartbeatSec = config.sandbox.instanceHeartbeatSec
  if (heartbeatSec <= 0) {
    getLogger().info('SANDBOX_INSTANCE_HEARTBEAT_SEC=0 ⇒ 不续期实例注册（网关退化为静态 ROUTER_UPSTREAMS）')
    return false
  }
  heartbeatTimer = setInterval(() => {
    void refreshInstanceRegistration('heartbeat')
  }, heartbeatSec * 1000)
  heartbeatTimer.unref()
  getLogger().info(
    { instanceId: config.sandbox.instanceId, heartbeatSec, advertiseAddr: instanceAdvertiseAddr() },
    '实例心跳已启动（在线注册表续期；网关据此自动发现实例）',
  )
  return true
}

/** 停心跳并**摘除**本实例的注册键（优雅退出路径；崩溃则靠 TTL） */
export async function stopInstanceHeartbeat(): Promise<void> {
  if (heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  try {
    const redis = await ensureRedisConnected()
    await redis.del(sandboxInstanceKey(config.sandbox.instanceId))
  } catch (error) {
    getLogger().debug({ err: error }, '退出时摘除实例注册键失败（TTL 会兜底）')
  }
}

/** 续期实例注册键（尽力而为：失败只 warn，下一次心跳再试） */
async function refreshInstanceRegistration(scope: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    const record: InstanceRecord = {
      instanceId: config.sandbox.instanceId,
      advertiseAddr: instanceAdvertiseAddr(),
      pid: process.pid,
      host: hostname(),
      startedAt: Date.now(),
    }
    await redis.set(sandboxInstanceKey(config.sandbox.instanceId), JSON.stringify(record), 'EX', instanceRegistrationTtlSec())
  } catch (error) {
    getLogger().warn({ err: error, scope }, '实例注册续期失败（网关可能把本实例当离线，下一拍再试）')
  }
}

// ───────────────────────────── 会话 → 实例目录 ─────────────────────────────

/**
 * 写"容器目录"（**抢锁之后、建容器之前**，`子方案` §六 1）：`SET NX`，先到先得。
 *
 * ⚠️ `NX` 而非无条件 `SET`：并发首个 `/chat` 由 `chat.active:{id}` 锁串行化，登记只可能有一个赢家；
 * 输家读回已有值即可。**不设"NX 失败即冲突"**。
 *
 * @returns 写入之后目录里的实例 id（赢家是自己，输家读到自己的对手）
 */
export async function registerSandboxOwner(conversationId: string): Promise<string> {
  const redis = await ensureRedisConnected()
  const key = sandboxOwnerKey(conversationId)
  const record: OwnerRecord = { instanceId: config.sandbox.instanceId, at: Date.now() }
  await redis.set(key, JSON.stringify(record), 'EX', config.sandbox.ownerTtlSec, 'NX')
  return (await readSandboxOwner(conversationId)) ?? config.sandbox.instanceId
}

/**
 * 写"工作区目录"（**首次 code 触达 / 首次建工作区**，`§十六 B`）：寿命**跟随工作区**。
 *
 * 三态处理（不抢占别人的工作区）：
 *   · 键不存在 ⇒ `SET NX EX workspaceTtl`（首个触达者成为 owner）；
 *   · 键存在且 = 自己 ⇒ `EXPIRE workspaceTtl`（续到工作区寿命 —— 若此前是容器那 2h 的短 TTL，这里把它拉长）；
 *   · 键存在且 ≠ 自己 ⇒ **不动**（字节在那台机器上；网关会把后续 `/workspace*` 转发过去）。
 *
 * @returns 目录里最终生效的实例 id
 */
export async function ensureWorkspaceOwner(conversationId: string): Promise<string> {
  const redis = await ensureRedisConnected()
  const key = sandboxOwnerKey(conversationId)
  const existing = await readSandboxOwner(conversationId)
  if (existing === undefined) {
    const record: OwnerRecord = { instanceId: config.sandbox.instanceId, at: Date.now() }
    await redis.set(key, JSON.stringify(record), 'EX', workspaceOwnerTtlSec(), 'NX')
    return (await readSandboxOwner(conversationId)) ?? config.sandbox.instanceId
  }
  if (existing === config.sandbox.instanceId) {
    await redis.expire(key, workspaceOwnerTtlSec())
  }
  return existing
}

/** 读目录（值坏 / 不存在 / 键里没有 instanceId 一律 `undefined`） */
export async function readSandboxOwner(conversationId: string): Promise<string | undefined> {
  const redis = await ensureRedisConnected()
  const payload = await redis.get(sandboxOwnerKey(conversationId))
  if (payload === null) return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { instanceId } = parsed as Partial<OwnerRecord>
    return isSandboxInstanceId(instanceId) ? instanceId : undefined
  } catch {
    return undefined
  }
}

/**
 * 清目录（**回收成功后**调，`§六 4`）。
 * ⚠️ **只删自己的**：值不是自己时不动（回收路径的归属断言在 `manager.ts`，这里再兜一道）。
 */
export async function clearSandboxOwner(conversationId: string): Promise<boolean> {
  const existing = await readSandboxOwner(conversationId)
  if (existing !== config.sandbox.instanceId) return false
  const redis = await ensureRedisConnected()
  const removed = await redis.del(sandboxOwnerKey(conversationId))
  return removed > 0
}

// ───────────────────────────── 内部小工具 ─────────────────────────────

function parseInstanceRecord(payload: string | null): InstanceRecord | undefined {
  if (payload === null) return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { instanceId, advertiseAddr, pid, host, startedAt } = parsed as Partial<InstanceRecord>
    if (!isSandboxInstanceId(instanceId)) return undefined
    if (typeof advertiseAddr !== 'string' || typeof host !== 'string') return undefined
    if (typeof pid !== 'number' || typeof startedAt !== 'number') return undefined
    return { instanceId, advertiseAddr, pid, host, startedAt }
  } catch {
    return undefined
  }
}

/** pid 是否还活着（`signal 0` 只做存在性检查）。跨宿主 / 权限异常时保守返回 `true`（当成活） */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // `EPERM` = 进程存在但属于别的用户 ⇒ 活着；其余（`ESRCH`）⇒ 不存在
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
