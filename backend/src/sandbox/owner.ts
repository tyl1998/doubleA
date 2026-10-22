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

import { isSandboxInstanceId, type InstanceLoad, type InstanceRegistration } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { ensureRedisConnected, sandboxInstanceKey, sandboxOwnerKey } from '../infra/redis.js'
import { chatBotSlots } from '../orchestrator/load.js'
import { getSandboxStats, listAvailableSandboxRuntimes } from './manager.js'
import { maybeInspectNodeReadiness } from './nodeBootstrap.js'
import { canBuildSandboxRuntime } from './runtimeBuild.js'
import { sandboxQueueDepth } from './queue.js'

/** 目录项（`sandbox:owner:{id}` 的值）：值 = 实例 id；用 JSON 包一层以便将来扩字段 */
interface OwnerRecord {
  instanceId: string
  /** 写目录的时刻（epoch ms）—— 排障时能看出"这条钉了多久" */
  at: number
}

/**
 * 实例注册项（`sandbox:instance:{id}` 的值）。
 *
 * ⚠️ 形状与解析**只在 `shared/src/routerInstance.ts` 定义一份**：网关自动发现读同一个键
 * （R1 起网关按它增删上游），两边各写一份 `JSON.parse` 会在字段一改时**静默**失配。
 * 这里只做别名，写值与解析都走共享契约。
 */
type InstanceRecord = InstanceRegistration

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
 *
 * **接管判据（2026-10-20 修订：拿掉"90s 等 TTL"）**
 *   · 同宿主 + `pid` 已死（`stalePid`）⇒ 崩溃留下的僵尸键，接管；
 *   · 同宿主 + `instanceId` 相同 ⇒ **同一个实例身份的另一个进程**。容器里的 pid 会复用
 *     （实测 v1/v2 都是 pid 6），`kill -9` 甚至 `docker rm -f` 重建容器后 `/tmp` 里的重启标记也一起没了
 *     ⇒ 旧规则在这种情况下会把安全护栏变成"改镜像重启必卡满 3× 心跳（90s）"。
 *     代价（同宿主跑两个**同名**进程会互相误杀对账）由两点兜住：
 *       ① 同一个容器里不可能并存两个后端（端口 + pid 1 启动）；
 *       ② 真要同宿主跑两份，用不同的 `SANDBOX_INSTANCE_ID` —— 这正是"实例 id 必须唯一"的本意。
 *     ⇒ 同宿主一律接管：宁可让"配错 id 的第二个进程"覆盖键，也不要让每次重启都有一段
 *     "网关以为它在、其实没人接"的窗口（那期间的新会话会被转发到已死的地址）。
 *   · **不同宿主**（另一台机器上的同名实例）⇒ 键里写的就是**活着的证据**（它每 3× 心跳续期一次），
 *     仍然拒绝启动 —— 这才是这条护栏真正要防的事。
 *
 * @param opts.startupReady `false` = **启动中**（对账 / 依赖还没就绪）：接管来的键**继承旧值的 TTL**，
 *   不续到满 TTL。这样"这一次启动自己崩了"会在原 TTL 内自然消失，而不是让网关误以为这台可用 90s。
 * @returns `{ ok:true }` 拿到（或接管）；`{ ok:false, heldBy }` 有同名活实例在线
 */
export async function claimInstanceIdentity(opts: {
  startupReady?: boolean
} = {}): Promise<{ ok: true; tookOver: boolean } | { ok: false; heldBy: string }> {
  const redis = await ensureRedisConnected()
  const key = sandboxInstanceKey(config.sandbox.instanceId)
  const record: InstanceRecord = {
    instanceId: config.sandbox.instanceId,
    advertiseAddr: instanceAdvertiseAddr(),
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
  }
  const registration = await withInstanceLoad(record)
  const ttl = instanceRegistrationTtlSec()
  const claimed = await redis.set(key, JSON.stringify(registration), 'EX', ttl, 'NX')
  if (claimed !== null) return { ok: true, tookOver: false }

  const existing = parseInstanceRecord(await redis.get(key))
  const sameHost = existing !== undefined && existing.host === record.host && existing.instanceId === record.instanceId
  // 两次启动之间没有任何"活着的进程能证明身份"的信号可用（容器里 pid 往返、宿主 pid 名字空间不同），
  // ⇒ 同宿主的同名键一律按"上一个进程已不在"接管（判据见函数头：护栏真正要防的是**另一台机器**）。
  if (sameHost) {
    // 接管时**继承旧 TTL**（启动中）而不是续到满 TTL：这次启动自己崩了也会在原来的剩余时间内消失。
    const remaining = opts.startupReady === false ? await redis.pttl(key) : -1
    if (remaining > 0) await redis.set(key, JSON.stringify(registration), 'PX', remaining, 'XX')
    else await redis.set(key, JSON.stringify(registration), 'EX', ttl, 'XX')
    getLogger().warn(
      {
        instanceId: config.sandbox.instanceId,
        previousPid: existing.pid,
        previousAlive: isPidAlive(existing.pid),
        ttlInheritedMs: remaining > 0 ? remaining : null,
      },
      '接管了同宿主上一个进程留下的同名注册键（容器 pid 会复用；不同宿主仍拒启）',
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

/**
 * **启动阶段的就绪闸**：`false` 时心跳照常续期，但注册值里写 `ready=false` / `missing=['startup']`。
 *
 * 为什么需要：`app.listen()` 早于沙箱启动对账（`reconcileOnBoot` 要拉镜像 / 删旧容器 / 清队列），
 * 这期间端口已经在接流量了，但"本机能不能跑容器"还不成立。网关此前只按注册键在不在判断可用性，
 * 于是重启窗口里的新会话会被转发过来、在 `ensureSandbox` 里失败。
 * ⇒ 启动时**先以未就绪发布**（`ready=false`，网关剔除候选 + 网关请求返回 503），对账完成后再翻成真实就绪。
 */
let startupReady = false

/** 对账完成（或确认无需对账）后调用：下一次心跳起按**真实**自检结果发布 */
export function isSandboxStartupReady(): boolean {
  return startupReady
}

export function markInstanceStartupReady(): void {
  startupReady = true
  void refreshInstanceRegistration('startup-ready')
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
    const registration = startupReady ? await withInstanceLoad(record) : { ...record, ready: false, missing: ['startup'] }
    // ⚠️ 摘流（`sandbox:drain:{id}`）**不经过**心跳：网关的自动发现与后台页各自直接读那个键
    //   （2026-10-21 修正）。曾经让心跳把 `drained` 写进注册值 —— 实测在容器里跑旧版本的实例上
    //   永远不生效（它根本不会读标记），于是"点了摘流但页面没反应"。判据只有一处：键在不在。
    await redis.set(sandboxInstanceKey(config.sandbox.instanceId), JSON.stringify(registration), 'EX', instanceRegistrationTtlSec())
  } catch (error) {
    getLogger().warn({ err: error, scope }, '实例注册续期失败（网关可能把本实例当离线，下一拍再试）')
  }
}

/**
 * 采样本实例负载并挂到注册值上（P1-14 · R3；`子方案` §九·补 2.1）。
 *
 * 三个数都是**本机本地**的现成只读出口（零新依赖）：沙箱名额册 `registry.size/limit`、
 * 排队深度 `ZCARD`、ChatBot 在飞 `chatBotSlots.inFlight`。
 *
 * ⚠️ **尽力而为**：队列深度要一次 Redis 往返，失败时**不带负载**继续续期 —— 在线注册比负载重要
 *    （注册键断了 = 自动发现看不见这台 ⇒ 退回静态表/轮询；少了负载只是退回轮询）。
 */
export async function sampleInstanceLoad(now: number = Date.now()): Promise<InstanceLoad | undefined> {
  const stats = getSandboxStats()
  let queueDepth: number
  try {
    queueDepth = await sandboxQueueDepth()
  } catch (error) {
    getLogger().debug({ err: error }, '采样排队深度失败（本轮注册值不带负载，网关按轮询处理）')
    return undefined
  }
  return {
    slotsUsed: stats.active,
    slotsTotal: stats.limit,
    queueDepth,
    chatbotInFlight: chatBotSlots.inFlight,
    sampledAt: now,
  }
}

/**
 * 运行时能力的缓存（毫秒）：探测是**本机 Docker `listImages`**，比队列深度那次 Redis 往返贵得多，
 * 没必要每 30s 一拍都跑一遍。镜像集合在两次构建之间几乎不变 ⇒ 5 分钟足够，且构建成功后
 * 下一次心跳就会带上新 id。
 */
const RUNTIME_CAPABILITY_TTL_MS = 5 * 60 * 1000

/** 上次探测到的运行时 id 列表 + 时刻（进程内；`null` = 还没探测过或上次失败） */
let runtimesCache: { ids: string[]; canBuild: boolean; at: number } | undefined

/**
 * 采样本实例**已就绪的运行时**（变体 id 列表；探不到 ⇒ `undefined`，注册值里就不带这一项）。
 *
 * 与 `GET /api/sandbox/runtimes` 走**同一个**探测出口（`listAvailableSandboxRuntimes`）：
 * 两边给用户的清单与心跳报给网关的能力必须出自一处，否则"页面说有、网关却不去那台"。
 */
export async function sampleInstanceRuntimes(
  now: number = Date.now(),
): Promise<{ runtimes: string[]; canBuild: boolean } | undefined> {
  if (!config.sandbox.enabled) return undefined
  if (runtimesCache !== undefined && now - runtimesCache.at < RUNTIME_CAPABILITY_TTL_MS) {
    return { runtimes: runtimesCache.ids, canBuild: runtimesCache.canBuild }
  }
  const [items, canBuild] = await Promise.all([
    listAvailableSandboxRuntimes(),
    // 构建能力也一起缓存：它读的是文件系统 + 动态 import，比列镜像便宜但也别每拍都跑
    canBuildSandboxRuntime().catch(() => false),
  ])
  // ⚠️ 空列表**照样缓存**：Docker 不可达时它会返回 `[]`（见该函数），缓存住可避免每分钟都去撞一次超时；
  //    真出现"有镜像却报空"，最多 5 分钟自愈。
  runtimesCache = { ids: items.map((item) => item.id), canBuild, at: now }
  return { runtimes: runtimesCache.ids, canBuild: runtimesCache.canBuild }
}

/** 注册值 + 负载 + 运行时能力（任一项采样失败 ⇒ 只缺那一项，不阻断续期） */
async function withInstanceLoad(record: InstanceRecord): Promise<InstanceRecord> {
  const load = await sampleInstanceLoad(Date.now())
  const capabilities = await sampleInstanceRuntimes(Date.now()).catch(() => undefined)
  // 节点就绪（P1-14 部署优化）：只给 taskAgent 档位采样（chatbot 不建容器，没有可判的项）
  const readiness = await maybeInspectNodeReadiness().catch(() => undefined)
  return {
    ...record,
    ...(load === undefined ? {} : { load }),
    ...(capabilities === undefined ? {} : { runtimes: capabilities.runtimes, canBuild: capabilities.canBuild }),
    ...(readiness === undefined
      ? {}
      : {
          ready: readiness.ready,
          missing: readiness.missing,
          hostPlatform: readiness.hostPlatform,
          needsRelay: readiness.needsRelay,
        }),
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
 * **按用户意图**把会话钉到某台实例（P1-14 多机：`POST /api/conversations/:id/instance`）。
 *
 * 与 {@link registerSandboxOwner} 的区别只在"谁来当赢家"：
 *   · 自动路径 = 谁先拿到 `/chat` 谁登记；
 *   · 本函数 = **用户点名**，但沿用同一个键、同一套 TTL、同一份 `SET NX` 语义（网关不用改）。
 *
 * 三种结果（**不覆盖别人的 owner** —— 容器与工作区字节都可能在原机上）：
 *   · `written`：键不存在，登记成功；
 *   · `unchanged`：键已存在且**就是**目标实例（刷新 TTL）；
 *   · `conflict`：键已存在且指向别的实例。要换机必须先让原实例回收（现在不做自动迁移），
 *     所以这里**拒绝并如实回报当前 owner**，由上层给出可读错误。
 *
 * ⚠️ 这里**不**校验实例"具备该运行时"：那是调用方（路由）的事 —— 本模块只认"哪些实例在线"
 *    与目录，能力判据在 `routes/conversations.ts`（避免 owner.ts 依赖 Docker 探测）。
 */
export async function pinSandboxOwner(
  conversationId: string,
  instanceId: string,
  options: { allowReselect?: boolean } = {},
): Promise<{ status: 'written' | 'unchanged' | 'reselected' } | { status: 'conflict'; current: string }> {
  const redis = await ensureRedisConnected()
  const key = sandboxOwnerKey(conversationId)
  const record: OwnerRecord = { instanceId, at: Date.now() }
  const payload = JSON.stringify(record)
  const written = await redis.set(key, payload, 'EX', config.sandbox.ownerTtlSec, 'NX')
  if (written !== null) return { status: 'written' }
  const current = await readSandboxOwner(conversationId)
  // ★ 自动重选（P1-14 × P1-17a）：**仅**在"原实例不满足所选运行时"时由调用方授权覆盖。
  //   覆盖是有代价的：原实例上的容器/工作区不会自己消失（下次它派活会被 `ensureSandbox` 按
  //   `doubulea.runtime` 标签比对而重建；老旧容器由原实例的空闲回收/启动对账收掉）。
  //   所以这里只换目录，**不做跨机清理**（`recycleSandbox` 只认本机行）。
  if (options.allowReselect === true && current !== undefined && current !== instanceId) {
    const replaced = await redis.set(key, payload, 'EX', config.sandbox.ownerTtlSec, 'XX')
    if (replaced !== null) {
      getLogger().warn(
        { conversationId, from: current, to: instanceId },
        '自动重选落点：原实例不满足所选运行时 ⇒ 覆盖会话目录（原实例的容器/工作区由它自己的回收兜底）',
      )
      return { status: 'reselected' }
    }
    return { status: 'conflict', current: current }
  }
  if (current === instanceId) {
    // 已经是目标实例：只续期，不改成新值（保持"先到先得"的值稳定，便于排障比对）
    await redis.expire(key, config.sandbox.ownerTtlSec)
    return { status: 'unchanged' }
  }
  return { status: 'conflict', current: current ?? '（值不可读）' }
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

/**
 * 解析注册值。
 *
 * ⚠️ 这里**刻意不要求** `advertiseAddr` 带端口（共享契约 `parseInstanceRegistration` 要求）：
 *    业务后端读它只用于"同名自检的僵尸判定"（同宿主 + 旧 pid 已死 ⇒ 接管），不看地址；
 *    而历史注册值里可能有过不带端口的地址 —— 判它无效会让**崩溃重启后的接管**失效、
 *    在 TTL 窗口内集体拒启。网关那边（自动发现）则用严格版约定（没有端口就没法转发）。
 */
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
