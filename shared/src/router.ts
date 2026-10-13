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

/** 在线的实例 id 是否合法（非空、无空白、不太长）—— 网关与自检都按它筛 */
export function isSandboxInstanceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/\s/u.test(value)
}

// ═════════════════════════════ 路由分类 ═════════════════════════════

/** 路由分派结论：粘性（带上要查目录的 `conversationId`）或可落到任意实例 */
export type RouteDispatch = { kind: 'sticky'; conversationId: string } | { kind: 'round-robin' }

/**
 * **非**工作区、但同样粘性的会话路由（容器在本机 / 帧总线进程内）。
 * 形态与 `子方案/沙箱多机部署.md` §三 6 的路由分类表逐字对应。
 */
const STICKY_CONVERSATION_ENDPOINTS: Record<string, ReadonlySet<string>> = {
  POST: new Set(['chat', 'regenerate']),
  GET: new Set(['stream']),
}

const CONVERSATION_ENDPOINT = /^\/api\/conversations\/([^/?#]+)\/([^/?#]+)\/?$/
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
  const matched = CONVERSATION_ENDPOINT.exec(path)
  if (matched !== null) {
    const conversationId = matched[1]
    const endpoint = matched[2]
    const stickyMethods = endpoint === undefined ? undefined : STICKY_CONVERSATION_ENDPOINTS[method.toUpperCase()]
    if (conversationId !== undefined && endpoint !== undefined && stickyMethods?.has(endpoint) === true) {
      return { kind: 'sticky', conversationId }
    }
  }
  return { kind: 'round-robin' }
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

/** 选一个上游实例的结论（`target` 为 `undefined` = 没有可用实例，网关应回 503） */
export interface UpstreamSelection {
  target: string | undefined
  /** 传给下一次调用的游标（`target` 命中 owner 时**不变**：粘性不该推动轮询指针） */
  nextCursor: number
}

/**
 * 网关的目标选择（**纯函数**，便于逐条核对）：
 *   ① 目录命中且该实例**在线**（在 `upstreams` 里）⇒ 转发到 owner（粘性）；
 *   ② 否则按游标**轮询**挑一个（`owner` 过期 / 实例下线 / 未登记都走这条）。
 *
 * ⚠️ 命中 owner 时**不推进游标**：粘性路由如果也参与轮询计数，会让"谁的位次到了"变得依赖
 *    前一条请求是不是粘性，从而在实例数变化时错乱。
 */
export function selectUpstream(input: {
  upstreams: readonly string[]
  owner?: string | undefined
  cursor: number
}): UpstreamSelection {
  const { upstreams, owner, cursor } = input
  if (upstreams.length === 0) return { target: undefined, nextCursor: cursor }
  if (owner !== undefined && upstreams.includes(owner)) return { target: owner, nextCursor: cursor }
  const index = ((cursor % upstreams.length) + upstreams.length) % upstreams.length
  return { target: upstreams[index], nextCursor: cursor + 1 }
}
