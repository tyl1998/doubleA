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

import { classifyRoute, selectUpstream } from '@doubulea/shared'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import type { RouterConfig } from './config.js'

/** 上游连接失败后的冷却时长（毫秒）：这段时间内不再往它转发（给它重启的机会） */
export const UPSTREAM_COOLDOWN_MS = 15_000

export interface RouterDeps {
  config: RouterConfig
  /** 查会话→实例目录（Redis）。失败/未命中一律 `undefined`（⇒ 轮询） */
  resolveOwner: (conversationId: string) => Promise<string | undefined>
  /** 结构化日志（默认 `console.log`）；`line` 里**只有方法、路径、目标**，不含 body */
  log?: (event: Record<string, unknown>) => void
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

  app.get('/health', async () => ({
    ok: true,
    service: 'doubulea-router',
    upstreams: deps.config.upstreams,
    cooling: coolingTargets(cooldown, Date.now()),
  }))

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/*',
    handler: async (request, reply) => {
      const method = request.raw.method ?? 'GET'
      const url = request.raw.url ?? '/'
      const dispatch = classifyRoute(method, url)
      const owner =
        dispatch.kind === 'sticky' ? await resolveOwnerSafely(deps.resolveOwner, dispatch.conversationId, log) : undefined
      const now = Date.now()
      const available = deps.config.upstreams.filter((target) => !isCooling(cooldown, target, now))
      const selection = selectUpstream({
        // 冷却把候选表缩小；全都在冷却 ⇒ 退回完整表（宁可试一个也不 503）
        upstreams: available.length > 0 ? available : deps.config.upstreams,
        owner,
        cursor,
      })
      cursor = selection.nextCursor
      if (selection.target === undefined) {
        reply.code(503).send({ code: 503, msg: '没有可用的上游实例', data: null })
        return
      }
      log({ scope: 'router', method, url, sticky: dispatch.kind === 'sticky', target: selection.target })
      forward(selection.target, request, reply, {
        timeoutMs: deps.config.upstreamTimeoutMs,
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
