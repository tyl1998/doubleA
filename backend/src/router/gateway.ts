/**
 * 路由网关（P1-14 §三 6；**自研小网关**，§十 1 定案）—— 「按会话粘性 + 其余轮询」
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §三 6（路由分类表 + 判定流程）、§六（竞态与降级）、§八 4（SSE 透传）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它只做一件事（刻意）
 * ─────────────────────────────────────────────────────────────────────
 *   查目录（`sandbox:owner:{conversationId}`）→ 粘性路由转发到 owner，其余按静态实例表轮询。
 * 前端**不动**：仍只连一个同源 `/api`（dev 是 Vite proxy、生产是 nginx → 本网关）。前端不需要
 * 知道有几台后端 —— 它眼里的"后端"永远是那一个同源入口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么零依赖式地转发（`node:http` 而不是 `undici`/`http-proxy`）
 * ─────────────────────────────────────────────────────────────────────
 * 两个硬要求决定了不能"先读全 body 再转发"：
 *   ① **SSE 透传**（`/chat`、`/stream`、`/workspace/events`）：响应是一段长字节流，必须边收边写、
 *      且**对已建立连接不设 idle 超时**（否则模型静默期一过就被网关掐断 —— 同 `sandbox-relay.mjs` 的取舍）；
 *   ② **上传**（`POST /api/files` 等非粘性路由）：body 可能是几十 MB，缓冲会打爆网关内存。
 * 所以请求体与响应体都**按流透传**（`req.body` 由一个"原样返回流"的 content-type parser 产出）。
 *
 * ⚠️ **实例降级（§六 2）**：owner 连接失败时本请求回 502，并把该上游放进一个**短冷却表**；
 *   冷却期内选上游时跳过它 ⇒ "owner 宕机"之后的 `/chat` 会落到别的实例重建（目录随后被覆盖）。
 *   本请求**不重试**：body 是流、已被那次失败连接消费，重放需要缓冲（与上面两条硬要求冲突）。
 */

import { request as httpRequest } from 'node:http'
import type { Readable } from 'node:stream'

import { classifyRoute, instanceTargetOf, isLongRunningRoute, selectUpstream } from '@doubulea/shared'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import type { RouterConfig } from './config.js'
import type { DiscoverySnapshot } from './discovery.js'

/** 上游连接失败后的冷却时长（毫秒）：这段时间内不再往它转发（给它重启的机会） */
export const UPSTREAM_COOLDOWN_MS = 15_000

export interface RouterDeps {
  config: RouterConfig
  /** 查会话→实例目录（Redis）。失败/未命中一律 `undefined`（⇒ 轮询） */
  resolveOwner: (conversationId: string) => Promise<string | undefined>
  /**
   * 当前上游表（R1 自动发现）。缺省 = 恒返回静态 `config.upstreams`（R9 时的行为，逐字不变）。
   *
   * ⚠️ 每个请求都读一次：它是**进程内快照**（无 I/O），换来的是"实例上下线不用重启网关"。
   */
  upstreams?: () => readonly string[]
  /** 发现状态（只给 `/health` 看；缺省表示未启用自动发现） */
  discovery?: () => DiscoverySnapshot
  /** 结构化日志（默认 `console.log`）；`line` 里**只有方法、路径、目标**，不含 body */
  log?: (event: Record<string, unknown>) => void
  /** 随机源（P2C 选两台用；缺省 `Math.random`）。注入点只为回归脚本可复现，生产不传 */
  random?: () => number
}

/**
 * 造网关的 Fastify 实例。
 *
 * 拆成"注入 `resolveOwner`"的形状是为了**可测**：回归脚本能塞一个假目录进去、不连真 Redis。
 */
export function buildRouterApp(deps: RouterDeps): FastifyInstance {
  const log = deps.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)))
  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 1_073_741_824 })
  /** 轮询游标（进程内；命中 owner 时不推进，见 `selectUpstream`） */
  let cursor = 0
  /** 冷却中的上游 → 冷却截止时刻 */
  const cooldown = new Map<string, number>()

  // ★ 请求体**原样按流**交给 handler（见文件头）：不解析、不缓冲、不设 bodyLimit。
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload)
  })

  const currentUpstreams = (): readonly string[] => deps.upstreams?.() ?? deps.config.upstreams

  app.get('/health', async () => {
    const discovery = deps.discovery?.()
    return {
      ok: true,
      service: 'doubulea-router',
      // `upstreams` = **此刻真正在用的表**（静态种子 ∪ 自动发现），与 R9 时同名字段兼容追加
      upstreams: currentUpstreams(),
      cooling: coolingTargets(cooldown, Date.now()),
      // P1-14 · R3/R4：每台上游的负载（静态种子里没有自报 ⇒ 不出现在这里）。
      // `ageMs` = 负载年龄（采样到现在）；`stale` = 超过 `ROUTER_LOAD_STALE_MS`（该台退回轮询次序）。
      load: loadReport(discovery, Date.now()),
      ...(discovery === undefined
        ? {}
        : {
            discovery: {
              enabled: deps.config.discoveryIntervalMs > 0,
              // 静态种子（`ROUTER_UPSTREAMS`）：自动发现关掉时它就是全部
              seed: deps.config.upstreams,
              discovered: discovery.discovered,
              stale: discovery.stale,
              // 未就绪实例（`ready=false`）：不参与路由，但在这里可见，便于判断"某台为什么不接流量"
              unready: discovery.unready,
              registrations: discovery.registrations,
              lastScanAt: discovery.lastScanAt ?? null,
            },
          }),
    }
  })

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/*',
    handler: async (request, reply) => {
      const method = request.raw.method ?? 'GET'
      const url = request.raw.url ?? '/'
      const dispatch = classifyRoute(method, url)
      const owner =
        dispatch.kind === 'sticky' ? await resolveOwnerSafely(deps.resolveOwner, dispatch.conversationId, log) : undefined
      // ★ 点名实例（运行时的构建任务：任务只存在于发起它的进程）—— 只认"确实在候选表里"的实例，
      //   不在表里（含未就绪）就当作没点名（照旧轮询），不能因为一个 id 把请求打到不可达地址。
      const instanceTarget = instanceTargetOf(url)
      const now = Date.now()
      const upstreams = currentUpstreams()
      const snapshot = deps.discovery?.()
      // ★ 节点自检未就绪的实例**不进候选**（P1-14 部署优化）：它自己的心跳说"还缺 docker/网/egress"，
      //   继续给它派新会话只会 5xx 再进冷却，用户侧看到的是"新建会话跑到那台、然后失败"。
      //   ⚠️ 只认明确的 `ready === false`；未上报（老版本 / 非 taskAgent）照旧参与。
      //   ⚠️ 全都不就绪 ⇒ 退回完整表（宁可试一台"也许刚好好了"的，也不 503）。
      const unready = new Set(snapshot?.unready ?? [])
      const readyUpstreams = unready.size === 0 ? upstreams : upstreams.filter((target) => !unready.has(target))
      const routable = readyUpstreams.length > 0 ? readyUpstreams : upstreams
      const available = routable.filter((target) => !isCooling(cooldown, target, now))
      // owner 是**实例 id**（目录里存的就是它），而上游表是 `host:port` ⇒ 先用自动发现的
      // "id → 地址"映射翻译一次。映射不存在（纯静态表）⇒ 原样交给 `selectUpstream`，
      // 于是 R9 的行为逐字不变（静态表里直接写实例 id 的老用法也继续成立）。
      const named = instanceTarget === undefined ? undefined : (snapshot?.targets[instanceTarget] ?? instanceTarget)
      const namedTarget = named !== undefined && routable.includes(named) ? named : undefined
      const ownerTarget = owner === undefined ? undefined : (snapshot?.targets[owner] ?? owner)
      // 冷却把候选表缩小；全都在冷却 ⇒ 退回完整表（宁可试一个也不 503）
      const usable = available.length > 0 ? available : routable
      const selection = selectUpstream({
        // 负载只从**自动发现**来（静态表里没有自报）；关掉自动发现 / 没给快照 ⇒ 纯轮询，与 R9 一致
        candidates: snapshot === undefined ? undefined : snapshot.candidates.filter((item) => usable.includes(item.target)),
        upstreams: usable,
        owner: ownerTarget,
        // 点名优先（粘性仍然先于它：粘性请求不会带 ?instanceId，见 classifyRoute 的注释）
        pinned: namedTarget,
        cursor,
        loadAware: deps.config.loadAware,
        random: deps.random,
      })
      cursor = selection.nextCursor
      if (selection.target === undefined) {
        reply.code(503).send({ code: 503, msg: '没有可用的上游实例', data: null })
        return
      }
      log({
        scope: 'router',
        method,
        url,
        sticky: dispatch.kind === 'sticky',
        pinned: namedTarget ?? null,
        target: selection.target,
        reason: selection.reason,
      })
      // ★ 长任务路由（`POST /api/admin/node/bootstrap` 这类**同步长操作**）单独放宽
      //   「到响应头」上限：默认 30s 会在拉镜像/建镜像中途掐断（目标机不停 ⇒ "点两次
      //   才成功"的假象）。判据清单在 shared#isLongRunningRoute，与本文件的路由分类同源。
      forward(selection.target, request, reply, {
        timeoutMs: isLongRunningRoute(method, url) ? deps.config.upstreamTimeoutLongMs : deps.config.upstreamTimeoutMs,
        onFailure: () => cooldown.set(selection.target as string, Date.now() + UPSTREAM_COOLDOWN_MS),
        log,
      })
    },
  })

  return app
}

// ───────────────────────────── 转发 ─────────────────────────────

interface ForwardOptions {
  timeoutMs: number
  onFailure: () => void
  log: (event: Record<string, unknown>) => void
}

/**
 * 把一个请求**按流**转发到 `target`（`host:port`），响应也按流写回。
 *
 * 用 `reply.hijack()`：从这里起整个响应由我们手写 `reply.raw`（Fastify 不再插手），
 * 于是 SSE 的长连接、注释行心跳、不被缓冲都能原样透传。
 */
function forward(target: string, request: FastifyRequest, reply: FastifyReply, options: ForwardOptions): void {
  const raw = reply.raw
  reply.hijack()
  // 不设 idle 超时：SSE 的静默期是正常的（见文件头）
  raw.socket?.setTimeout(0)

  const { host, port } = splitHostPort(target)
  const headers = { ...request.raw.headers }
  delete headers.connection
  headers.host = target

  const upstreamReq = httpRequest(
    { host, port, method: request.raw.method, path: request.raw.url, headers },
    (upstreamRes) => {
      raw.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(raw)
    },
  )
  upstreamReq.setTimeout(options.timeoutMs, () => {
    upstreamReq.destroy(new Error(`上游 ${target} 在 ${options.timeoutMs}ms 内没有响应头`))
  })
  upstreamReq.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    options.onFailure()
    options.log({ scope: 'router', level: 'warn', target, err: message })
    if (raw.headersSent) {
      raw.destroy()
      return
    }
    raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    raw.end(JSON.stringify({ code: 502, msg: '上游实例不可达（网关会把后续请求转给其它实例）', data: null }))
  })

  const body = request.body
  if (isReadable(body)) body.pipe(upstreamReq)
  else upstreamReq.end()
}

function isReadable(value: unknown): value is Readable {
  return typeof value === 'object' && value !== null && typeof (value as Readable).pipe === 'function'
}

/** `host:port` / `host` → `{ host, port }`（缺省端口 80） */
export function splitHostPort(target: string): { host: string; port: number } {
  const index = target.lastIndexOf(':')
  if (index < 0) return { host: target, port: 80 }
  return { host: target.slice(0, index), port: Number(target.slice(index + 1)) }
}

/**
 * `/health` 的负载视图（P1-14 · R4：全局可观测）。
 *
 * ⚠️ 读的人要能同时看出"谁忙"和"这份数据有多旧"：`ageMs` 由注册值里的 `sampledAt` 算出，
 *    不是"网关刚看了一眼" ⇒ 心跳停了会如实变大。
 */
function loadReport(discovery: DiscoverySnapshot | undefined, now: number): Record<string, Record<string, unknown>> {
  const report: Record<string, Record<string, unknown>> = {}
  if (discovery === undefined) return report
  for (const [target, entry] of Object.entries(discovery.loads)) {
    report[target] = {
      slotsUsed: entry.load.slotsUsed,
      slotsTotal: entry.load.slotsTotal,
      queueDepth: entry.load.queueDepth,
      chatbotInFlight: entry.load.chatbotInFlight,
      ageMs: Math.max(0, now - entry.load.sampledAt),
      stale: entry.stale,
    }
  }
  return report
}

function isCooling(cooldown: Map<string, number>, target: string, now: number): boolean {
  const until = cooldown.get(target)
  if (until === undefined) return false
  if (until <= now) {
    cooldown.delete(target)
    return false
  }
  return true
}

function coolingTargets(cooldown: Map<string, number>, now: number): string[] {
  return [...cooldown.entries()].filter(([, until]) => until > now).map(([target]) => target)
}

/** 查目录；失败只 warn 并返回 `undefined`（⇒ 轮询）。目录不可用不该让整个网关瘫掉 */
async function resolveOwnerSafely(
  resolveOwner: RouterDeps['resolveOwner'],
  conversationId: string,
  log: (event: Record<string, unknown>) => void,
): Promise<string | undefined> {
  try {
    return await resolveOwner(conversationId)
  } catch (error) {
    log({ scope: 'router', level: 'warn', err: error instanceof Error ? error.message : String(error), conversationId })
    return undefined
  }
}
