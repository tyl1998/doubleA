/**
 * 沙箱多机路由契约（P1-14「沙箱多机部署 · 路线 A」/ P1-9 · R9「多机粘性路由」）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §三 5/§三 6（会话→实例目录 + 路由分类表）、
 *      `docs/子方案/Code模式工作区.md` §十六 A–C（工作区路由纳入粘性 + 钉机记录寿命跟随工作区）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么有这张表：**只有一部分路由能轮询到任意实例**
 * ─────────────────────────────────────────────────────────────────────
 * 后端本身无状态可水平扩（会话/锁/停止/确认在 Redis，数据在 PG/S3）⇒ **大多数路由**落到任意
 * 实例都正确。真正有状态的只有两样：
 *   · **容器**（建在本机 Docker 上）⇒ `/chat`、`/stream`、`/regenerate` 必须落到持有它的实例；
 *   · **工作区字节**（P1-9 起是**宿主本地盘** bind mount，不在 PG/S3）⇒ `/workspace*` 全部路由
 *     必须落到持有该工作区的那台机器（落错 ⇒ 读/写**别的机器**的本地盘 ⇒ **丢改**）。
 * `stream` / `workspace/events` 是 SSE，而**帧总线与工作区 watcher 都是进程内**的 ⇒ 同样必须粘性。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 判据是"目录"不是"哈希"（这里只定义**读目录用的键**与**路由分类**）
 * ─────────────────────────────────────────────────────────────────────
 * 容器落点是**运行期事实**（按需创建、可能落在任意实例），不是 `hash(conversationId) % N`
 * 能算出来的 ⇒ 目录表（Redis `sandbox:owner:{conversationId}`）是唯一事实来源。本文件只提供
 * **键名构造**与**纯函数路由分类**（网关与后端共用一份判据，§六 第 5 条：判据只有一处）。
 *
 * ⚠️ 本文件**零 IO**（不碰 Redis/PG/FS），只放契约与纯函数 —— 于是它能被回归脚本逐条核对
 *    （见 `backend/scripts/router-regression.ts`），也能被 `infra` 侧网关进程直接 `import`。
 */

// ═════════════════════════════ 键名 ═════════════════════════════

/** 会话→实例目录的键前缀默认值（`SANDBOX_OWNER_KEY_PREFIX`） */
export const SANDBOX_OWNER_KEY_PREFIX_DEFAULT = 'sandbox:owner'

/**
 * 实例在线注册表的键前缀（`sandbox:instance:{instanceId}`）。
 * 与 §五 1 的"同名实例抢注"自检**共用同一个键**：抢不到 = 有同名实例在线 ⇒ 拒启。
 */
export const SANDBOX_INSTANCE_KEY_PREFIX = 'sandbox:instance'

/** 会话→实例目录的键（`{prefix}:{conversationId}`） */
export function sandboxOwnerKey(prefix: string, conversationId: string): string {
  return `${prefix}:${conversationId}`
}

/** 实例在线注册表的键（`sandbox:instance:{instanceId}`） */
export function sandboxInstanceKey(instanceId: string): string {
  return `${SANDBOX_INSTANCE_KEY_PREFIX}:${instanceId}`
}

/**
 * **摘流标记**的键前缀（`sandbox:drain:{instanceId}`）。
 *
 * 为什么不能直接删 `sandbox:instance:{id}`：注册键由**那台实例自己**的心跳续期，删掉后一个心跳周期
 * 就长回来了 —— "从服务里摘掉"必须是一个**别人写入、被摘的那台自己读到并上报**的标记，
 * 而不是一次会自愈的删除。
 *
 * 语义（刻意收窄）：`drained=true` = **不再成为新会话的 owner**。已钉在这台的会话仍可继续
 * （它们的字节/容器本来就在本机），运维想让它们也走开就等空闲回收或重启。
 */
export const SANDBOX_DRAIN_KEY_PREFIX = 'sandbox:drain'

/** 摘流标记的键（`sandbox:drain:{instanceId}`） */
export function sandboxDrainKey(instanceId: string): string {
  return `${SANDBOX_DRAIN_KEY_PREFIX}:${instanceId}`
}

/** 在线的实例 id 是否合法（非空、无空白、不太长）—— 网关与自检都按它筛 */
export function isSandboxInstanceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/\s/u.test(value)
}

// ═════════════════════════════ 路由分类 ═════════════════════════════

/**
 * 路由分派结论：粘性（带上要查目录的 `conversationId`）/ **点名实例** / 可落到任意实例。
 *
 * `instance` = 请求**自带**一个实例 id（目前只有运行时的构建任务：任务只存在于发起它的进程里，
 * 见 `backend/src/sandbox/runtimeBuild.ts`）。它不是粘性路由，也不是 P2C 的新判据：
 * 网关只在"该实例确实在上游表里"时用它，否则照旧走轮询 —— **不改 P2C 口径**。
 */
export type RouteDispatch = { kind: 'sticky'; conversationId: string } | { kind: 'instance'; instanceId: string } | { kind: 'round-robin' }

/**
 * **非**工作区、但同样粘性的会话路由（容器在本机 / 帧总线进程内）。
 * 形态与 `子方案/沙箱多机部署.md` §三 6 的路由分类表逐字对应。
 */
const STICKY_CONVERSATION_ENDPOINTS: Record<string, ReadonlySet<string>> = {
  POST: new Set(['chat', 'regenerate']),
  GET: new Set(['stream']),
}

const CONVERSATION_ENDPOINT = /^\/api\/conversations\/([^/?#]+)\/([^/?#]+)\/?$/

/**
 * **开放平台**的会话路由（P1-22）：`/open/v1/conversations/:id/(chat|regenerate|stream)`。
 *
 * 为什么必须在这里（而不是"反正本期只有 ChatBot"就省掉）：粘性与否取决于**状态在不在本机**，
 * 与调用方是谁无关 —— 帧总线（`/stream` 的迟到补帧）与编排进程都是**进程内**的，
 * 开放层落错实例的症状与内部路径**一模一样**（流能发出去、重连续不上，或者一条流跑到一半
 * 被另一台当成"没有流"）。
 *
 * ⚠️ 前缀是 `/open/v1`（带版本号），与内部的 `/api/conversations` 是两条不同的路径 ——
 * 用同一个正则去匹配会漏掉这一族，所以单列一个常量（判据仍然只有 `classifyRoute` 一处）。
 */
const OPEN_CONVERSATION_ENDPOINT = /^\/open\/v1\/conversations\/([^/?#]+)\/([^/?#]+)\/?$/
/** `/workspace` 及其全部子路由（树/读/写/建/移/删/changes/revert/file/raw/events），任意方法 */
const WORKSPACE_ROUTE = /^\/api\/conversations\/([^/?#]+)\/workspace(?:\/(?:[^?#]*))?$/

/**
 * 一条请求该落到**持有其工作区的实例**还是**任意实例**？
 *
 * @param method   HTTP 方法（大写或小写都接受）
 * @param pathname 请求路径（可带 query，本函数会先剥掉 `?...`；也接受绝对 URL）
 *
 * 粘性清单（`子方案` §三 6 + `Code模式工作区.md` §十六 A）：
 *   · `POST /api/conversations/:id/chat`（建/用本机会话容器、推帧）
 *   · `GET  /api/conversations/:id/stream`（读本机帧总线）
 *   · `POST /api/conversations/:id/regenerate`（同 `/chat` 链路）
 *   · `/api/conversations/:id/workspace` 及**全部**子路由（字节在本机本地盘）
 *
 * ⚠️ **刻意不粘性**：`stop` / `confirm` / `steer` / `auto-approve`（写 Redis 信号）、`active`
 *    （读 Redis + 库）、**`code-mode`**（只写 `conversations.code_mode` 一列，不碰本地盘）——
 *    它们落哪台都正确（`子方案` §三 6）。`code-mode` 的"提前钉机"由**处理它的实例**顺手
 *    `ensureWorkspaceOwner`（§十六 B）：开启即"首次 code 触达"，之后的 `/workspace*` 便命中同一台。
 */
export function classifyRoute(method: string, pathname: string): RouteDispatch {
  const path = pathnameOnly(pathname)
  const workspace = WORKSPACE_ROUTE.exec(path)
  if (workspace !== null) {
    const conversationId = workspace[1]
    return conversationId === undefined ? { kind: 'round-robin' } : { kind: 'sticky', conversationId }
  }
  for (const pattern of [CONVERSATION_ENDPOINT, OPEN_CONVERSATION_ENDPOINT]) {
    const matched = pattern.exec(path)
    if (matched === null) continue
    const conversationId = matched[1]
    const endpoint = matched[2]
    const stickyMethods = endpoint === undefined ? undefined : STICKY_CONVERSATION_ENDPOINTS[method.toUpperCase()]
    if (conversationId !== undefined && endpoint !== undefined && stickyMethods?.has(endpoint) === true) {
      return { kind: 'sticky', conversationId }
    }
  }
  return { kind: 'round-robin' }
}

// ═════════════════════════════ 可重放的请求体 ═════════════════════════════

/**
 * 哪些路由的请求体**可以在网关里缓冲后再转发**（2026-10-21：实例不可达时的一次重试）。
 *
 * ★ 为什么只放 `/chat`：
 *   · 网关默认**不缓冲**请求体（SSE 透传 + 几十 MB 上传都不许过内存，见 `router/gateway.ts` 文件头）；
 *   · 但 `/chat` 的 body 是一个**小的 JSON**（一条用户消息），而它恰恰是最"尴尬"的那条 ——
 *     上游实例刚死时用户会看到一个 502，再手点一次才行。缓冲它就能自动重试一次。
 *   · **不放** `/regenerate`：它不带 body（重放等于重跑一轮，语义不同）；
 *   · **不放** `/workspace*`：写操作可能带几 MB 内容，且重放有丢改风险（落点变化）。
 *
 * ⚠️ 只按**方法 + 路径**判定，不看 body 大小：真正的大小上限由网关的常量把着
 *    （超限 ⇒ 退回"不缓冲、不重试"的旧行为，而不是 413）。
 */
export function isReplayableBodyRoute(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  const path = pathnameOnly(pathname)
  // 开放层（P1-22）的 `/chat` 与内部同一条链路、同一个 body 形态 ⇒ 同一套"首跳重试"待遇
  for (const pattern of [CONVERSATION_ENDPOINT, OPEN_CONVERSATION_ENDPOINT]) {
    const matched = pattern.exec(path)
    if (matched !== null) return matched[2] === 'chat' && matched[1] !== undefined
  }
  return false
}

// ═════════════════════════════ 长任务路由 ═════════════════════════════
/**
 * **长任务路由清单**（2026-10-20：一键初始化 30s 超时坑）。
 *
 * 这些路由的 handler 是**同步长操作**（等 Docker 拉镜像 / 建镜像 / 起容器跑完才回响应头），
 * 普通 30s「到响应头」上限会把它们掐断 —— 而目标机上的活没停，用户看到失败、实际后台
 * 还在跑，再点一次"才成功"的假象就是这么来的（回归 I5 旁的实测日志）。
 *
 * 网关据此清单**单独放宽**到 `ROUTER_UPSTREAM_TIMEOUT_LONG_MS`（默认 15 分钟，与
 * `nodeOps.ts` 跨实例转发的上限对齐）。清单要**穷举**（新增长同步端点必须加进来），
 * 与 `STICKY_CONVERSATION_ENDPOINTS` 同一条纪律：判据只有一处。
 *
 * ⚠️ 只列**等响应头就等很久**的；SSE 不适用（它们到响应头很快，长的是流本体，
 *    而 `forward()` 只对"到响应头"计时，长连接不设 idle 超时）。
 */
const LONG_RUNNING_ADMIN_ENDPOINTS: ReadonlySet<string> = new Set(['node/bootstrap'])

/** 该请求是否长任务路由（网关用：放宽「到响应头」上限） */
export function isLongRunningRoute(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  const path = pathnameOnly(pathname)
  const matched = /^\/api\/admin\/([^?#]+)/.exec(path)
  // 端点名可能是多段（`node/bootstrap`）⇒ 捕获到 query 之前，剥掉尾斜杠后按清单**精确比对**
  const endpoint = matched?.[1]?.replace(/\/+$/u, '')
  return endpoint !== undefined && LONG_RUNNING_ADMIN_ENDPOINTS.has(endpoint)
}

/**
 * 从请求里取"用户点名的构建实例"（P1-14）：只用**两个不需要读 body** 的位置。
 *
 *   ① `?instanceId=<id>`（启动端点：与 body 里的 `instanceId` 等价，前端两个都发）；
 *   ② `/api/sandbox/runtimes/build/<instanceId>/<buildId>`（任务查询/取消：路径里带实例）。
 *
 * ⚠️ 为什么不在网关里读 body：网关按流透传请求体、刻意不解析（`gateway.ts` 文件头）——
 *    为了路由去缓冲一个可能很大的 body，会破坏"第一字节就转发"的语义。
 * ⚠️ 只认合法实例 id（`isSandboxInstanceId`）；查不到 / 不合法 ⇒ `undefined`，照旧轮询。
 */
export function instanceTargetOf(pathname: string): string | undefined {
  const byQuery = /[?&]instanceId=([^&#]+)/u.exec(pathname)
  if (byQuery !== null) {
    const raw = byQuery[1]
    if (raw !== undefined) {
      try {
        const decoded = decodeURIComponent(raw).trim()
        if (isSandboxInstanceId(decoded)) return decoded
      } catch {
        // 非法百分号编码：忽略，继续看路径形态
      }
    }
  }
  const byPath = /^\/api\/sandbox\/runtimes\/build\/([^/?#]+)\/[^/?#]+\/?$/u.exec(pathnameOnly(pathname))
  const candidate = byPath?.[1]
  return candidate !== undefined && isSandboxInstanceId(candidate) ? candidate : undefined
}

/** 从路径里剥掉 query/hash，并容忍绝对 URL（`http://host/a?b` → `/a`） */
function pathnameOnly(pathname: string): string {
  let path = pathname
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu.exec(path)
  if (scheme !== null) path = path.slice(scheme[0].length)
  const cut = Math.min(...[path.indexOf('?'), path.indexOf('#')].filter((index) => index >= 0), path.length)
  return cut > 0 ? path.slice(0, cut) : path
}

// ═════════════════════════════ 上游选择 ═════════════════════════════

/**
 * 一台实例的**负载快照**（P1-14 · R3；`子方案/沙箱多机部署.md` §九·补 2.1）。
 *
 * 全部是**每台本地**的量（槽位与队列的作用域都是单个实例，见 `sandbox/registry.ts` 文件头），
 * 由后端心跳采样写进注册值、网关读出来参与选择 —— 网关自己**不做任何聚合**。
 */
export interface InstanceLoad {
  /** 沙箱槽位占用（`registry.size`） */
  slotsUsed: number
  /** 沙箱槽位上限（`registry.limit`） */
  slotsTotal: number
  /** 本实例沙箱排队深度（`ZCARD`，队列键带 `:instanceId`） */
  queueDepth: number
  /** 本实例 ChatBot 在飞（`chatBotSlots.inFlight`） */
  chatbotInFlight: number
  /** 采样时刻（epoch ms；心跳写的时刻，不是"网关看到的时刻"） */
  sampledAt: number
}

/**
 * 选择时的实例视图：地址 + 可选负载。
 *
 * `stale === true` 表示这份负载**已过期**（超过 `ROUTER_LOAD_STALE_MS`）⇒ 与"没有负载"同等对待
 * （该实例退回轮询次序，不参与 P2C 比较）。
 */
export interface UpstreamCandidate {
  target: string
  load?: InstanceLoad | undefined
  stale?: boolean | undefined
}

/** 选一个上游实例的结论（`target` 为 `undefined` = 没有可用实例，网关应回 503） */
export interface UpstreamSelection {
  target: string | undefined
  /** 传给下一次调用的游标（`target` 命中 owner 时**不变**：粘性不该推动轮询指针） */
  nextCursor: number
  /** 本次选择的口径（写日志 / `/health` 用：`sticky` 粘性命中，`load` 按负载挑，`round-robin` 轮询） */
  reason: 'sticky' | 'pinned' | 'load' | 'round-robin' | 'none'
}

/** 负载口径的三级字典序（§九·补 4 · ③）：沙箱占用率 → 队列深度 → ChatBot 在飞 */
function loadOrder(left: InstanceLoad, right: InstanceLoad): number {
  const leftRate = left.slotsTotal > 0 ? left.slotsUsed / left.slotsTotal : 0
  const rightRate = right.slotsTotal > 0 ? right.slotsUsed / right.slotsTotal : 0
  if (leftRate !== rightRate) return leftRate < rightRate ? -1 : 1
  if (left.queueDepth !== right.queueDepth) return left.queueDepth < right.queueDepth ? -1 : 1
  if (left.chatbotInFlight !== right.chatbotInFlight) return left.chatbotInFlight < right.chatbotInFlight ? -1 : 1
  return 0
}

/**
 * 网关的目标选择（**纯函数**，便于逐条核对）：
 *   ① 目录命中且该实例**在线** ⇒ 转发到 owner（粘性，**永远优先**，不看负载）；
 *   ② 否则挑一个：
 *      · 给了 `loadAware`（`ROUTER_LOAD_AWARE`，默认开）且**至少两台带新鲜负载** ⇒ **P2C**：
 *        随机取两台、挑较空；**并列按游标**（`cursor % 2` 决定先看谁）；
 *      · 其余一切情况（没给负载 / 负载过期 / 心跳关掉 / 只有一台有负载）⇒ 按游标**轮询**
 *        （与 R9 逐字一致）。
 *
 * ⚠️ 命中 owner 时**不推进游标**：粘性路由如果也参与轮询计数，会让"谁的位次到了"变得依赖
 *    前一条请求是不是粘性，从而在实例数变化时错乱。
 *
 * ⚠️ **为什么是 P2C 而不是"全局最小"**（§九·补 §3）：全局最小会让同一瞬间涌来的新请求**全都**
 *    落到同一台"最空"的实例上（惊群）；随机取两台挑较空，突发下天然分散。
 *
 * ⚠️ **随机源注入**（`random`）：默认 `Math.random`，回归脚本传定值 ⇒ 本函数仍是可逐条核对的纯函数。
 */
export function selectUpstream(input: {
  /** 旧形状：纯地址表（不参与负载决策） */
  upstreams?: readonly string[] | undefined
  /** 新形状：地址 + 可选负载（与 `upstreams` 二选一；两者都给时以 `candidates` 为准） */
  candidates?: readonly UpstreamCandidate[] | undefined
  owner?: string | undefined
  /**
   * 点名实例（请求自带的 `?instanceId=` / 任务路径里的 `<instanceId>`）。优先级：
   * **粘性 owner > 点名 > P2C/轮询**。点名不在候选表里 ⇒ 忽略（不让一个过期 id 把请求打空）。
   */
  pinned?: string | undefined
  cursor: number
  /** 是否启用负载感知（缺省 = 不启用 ⇒ 轮询，与 R9 一致） */
  loadAware?: boolean | undefined
  /** 随机源（P2C 取两台用）；缺省 `Math.random` */
  random?: (() => number) | undefined
}): UpstreamSelection {
  const { upstreams, owner, pinned, cursor, loadAware = false, random = Math.random } = input
  const targets = (input.candidates ?? (upstreams ?? []).map((target) => ({ target }))).map((item) => item.target)
  if (targets.length === 0) return { target: undefined, nextCursor: cursor, reason: 'none' }
  if (owner !== undefined && targets.includes(owner)) return { target: owner, nextCursor: cursor, reason: 'sticky' }
  // 点名优先于负载：请求方**要求**落到这台（构建任务只存在于那台的进程里），不打散也不推进游标
  if (pinned !== undefined && targets.includes(pinned)) return { target: pinned, nextCursor: cursor, reason: 'pinned' }
  if (!loadAware) return roundRobin(targets, cursor)

  const ordered = orderByCursor(targets, cursor)
  const fresh = new Map<string, InstanceLoad>()
  for (const item of input.candidates ?? []) {
    if (item.load !== undefined && item.stale !== true) fresh.set(item.target, item.load)
  }
  // 单实例 / 只有一台有新鲜负载：P2C 与轮询同结论，直接走轮询口径（日志里也好区分）
  if (fresh.size < 2) return roundRobin(targets, cursor)

  // P2C：按轮询次序随机取两台（不重复）——随机源**只用一次**，第二次取用"游标奇偶"决定
  // （游标偶 ⇒ 取次序里的下一台；游标奇 ⇒ 取反）⇒ 平局时先看谁由 `cursor % 2` 决定，
  // 不引入第三个随机数，也保持"两台"语义
  const first = pickIndex(random(), ordered.length)
  let second = cursor % 2 === 0 ? first + 1 : first - 1
  if (second >= ordered.length) second = 0
  if (second < 0) second = ordered.length - 1
  const [left, right] = cursor % 2 === 0 ? [first, second] : [second, first]
  const leftTarget = ordered[left] as string
  const rightTarget = ordered[right] as string
  const leftLoad = fresh.get(leftTarget)
  const rightLoad = fresh.get(rightTarget)
  // 只有一台有新鲜负载 ⇒ 有数据的那台优先（没数据的视为"不可比较"，不去猜它空）
  const chosen =
    leftLoad === undefined ? rightTarget : rightLoad === undefined ? leftTarget : loadOrder(leftLoad, rightLoad) <= 0 ? leftTarget : rightTarget
  return { target: chosen, nextCursor: cursor + 1, reason: 'load' }
}

/** 轮询（R9 口径，逐字不变）：取游标那台并推进游标，`reason` 留给日志用 */
function roundRobin(targets: readonly string[], cursor: number): UpstreamSelection {
  const index = ((cursor % targets.length) + targets.length) % targets.length
  return { target: targets[index], nextCursor: cursor + 1, reason: 'round-robin' }
}

/** 把地址表按游标旋转（游标那台在最前），长度不变 */
function orderByCursor(targets: readonly string[], cursor: number): string[] {
  const length = targets.length
  const start = ((cursor % length) + length) % length
  return [...targets.slice(start), ...targets.slice(0, start)]
}

/** `random()` ⇒ `[0, length)` 的整数（随机源给到边界值时也收敛在范围内） */
function pickIndex(random: number, length: number): number {
  if (!Number.isFinite(random) || length <= 0) return 0
  return Math.min(length - 1, Math.max(0, Math.floor(random * length)))
}
