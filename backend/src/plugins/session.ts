/**
 * 会话插件（P0-1-6）
 *
 * 依据：`docs/02-后端设计.md` §十 安全设计 —— 「会话：HttpOnly + SameSite=Lax Cookie +
 *      Redis 存储（登出即毁）；**每请求校验 user.status（60s TTL 缓存），停用账号立即失效**」
 *      + §4.1（`/api/auth/*` 四个端点会用到本插件）+ §四（错误出口走统一信封）
 *
 * 本文件提供四样东西：
 *   1. {@link installSession} —— 装配：注册 `@fastify/cookie`、挂 `requireAuth`/`requireAdmin`
 *      装饰器、声明 `request.auth`。
 *   2. `requireAuth` —— 路由 `preHandler`：解析 Cookie → 查 Redis 会话 → **校验 user.status**
 *      → 把用户快照挂到 `request.auth`，并把 userId 补进日志上下文。
 *   3. `requireAdmin` —— 在其上再加一层角色判定（`(A)` 端点用）。
 *   4. {@link issueSession} / {@link endSession} —— 登录与登出的会话收发（P0-1-7 直接用）。
 *
 * 三条刻意的口径：
 *
 * **① 会话令牌不带签名，也不需要。** Cookie 里是 43 字符的 CSPRNG 随机串，**身份的真相在
 *    Redis**（值里存 userId）。签名只能证明"这串没被改过"，而改成一串无对应键的随机值
 *    同样会被判为无会话 —— 加签只是多一个要轮转的密钥，不增加任何安全属性。
 *
 * **② 会话存储不可用 → 500，不是 401。** 语义上「Redis 挂了」是服务端依赖故障，不是
 *    「你的凭据不对」。映射成 401 会让所有在线用户被前端踢回登录页（还以为是会话过期），
 *    运维看到的也只是 401 而非 5xx，容易把依赖事故当成鉴权问题查。
 *
 * **③ 校验失败的会话一律**自毁**（删 Redis 键 + 清 Cookie）。** 账号被停用/删除后，
 *    客户端手里那枚 Cookie 已经没有意义，留着只会在每个请求上重复走一遍失败路径。
 */

import cookie from '@fastify/cookie'
import { AppError } from '@doubulea/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { enrichRequestContext, getLogger } from '../infra/logger.js'
import { UserRole, UserStatus, getPrisma } from '../infra/prisma.js'
import {
  createSession,
  destroySession,
  readSessionUserId,
  readUserSnapshot,
  writeUserSnapshot,
  type UserSnapshot,
} from '../infra/redis.js'

/**
 * 会话 Cookie 名。**刻意不做成环境变量**：同一域名下若前后端各自配一个名字，
 * 「登录成功但仍未登录」会变成最难查的一类问题；真要改就改这一处。
 */
export const SESSION_COOKIE_NAME = 'doubulea_sid'

/**
 * Cookie 属性（登录与登出**必须完全一致** —— 登出时若 path/domain/secure/sameSite 对不上，
 * 浏览器不会覆盖那枚旧 Cookie，表现为"点了登出还是登录态"）。
 *
 * 类型取自 `@fastify/cookie` 自己给 `reply.setCookie` 声明的第三个参数：
 * 该包用的是 `export =` 形态，**取不到** `CookieSerializeOptions` 这个名字来直接 import，
 * 而这样写同时还能让 `satisfies` 真的校验一遍属性名/取值（写错 `sameSite` 会在编译期报错）。
 */
type SessionCookieOptions = NonNullable<Parameters<FastifyReply['setCookie']>[2]>

const SESSION_COOKIE_OPTIONS = {
  path: '/',
  /** JS 读不到（`document.cookie` 里没有）—— 即使有 XSS 也偷不走会话 */
  httpOnly: true,
  /**
   * Lax：跨站 POST 不带 Cookie（挡掉绝大部分 CSRF），站内跳转/直达链接仍带（不影响体验）。
   * 刻意不用 None（那要求 Secure，且等于放弃 CSRF 防线）；也不用 Strict（从外部链接进入
   * 本系统会被判为未登录，内部工具里链接互传很常见）。
   */
  sameSite: 'lax',
  /** 仅 HTTPS 回传；默认跟随 NODE_ENV（`config.session.cookieSecure`，生产置 false 会告警） */
  secure: config.session.cookieSecure,
} as const satisfies Partial<SessionCookieOptions>

/** 认证上下文：`requireAuth` 成功后挂在 `request.auth` 上（未认证时为 null） */
export interface AuthContext {
  /** 本次请求使用的会话 ID（登出/主动踢下线用） */
  sessionId: string
  /** 用户快照（`02` §十：每请求校验 status 的那份数据） */
  user: UserSnapshot
}

declare module 'fastify' {
  interface FastifyInstance {
    /** 需要登录的路由当 `preHandler` 用；未通过时**抛 `AppError`**（由 errorHandler 转信封） */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** 在 `requireAuth` 之上再加「仅 ADMIN」（`02` §四 约定：`(A)` = 仅 ADMIN） */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    /** 已认证用户；未认证为 null（默认值由 `decorateRequest` 给出） */
    auth: AuthContext | null
  }
}

// ───────────────────────────── Cookie 收发 ─────────────────────────────

/** 写会话 Cookie（登录成功后 / 首登改密后刷新有效期时） */
export function setSessionCookie(reply: FastifyReply, sid: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, sid, {
    ...SESSION_COOKIE_OPTIONS,
    // 与 Redis 侧的 TTL 保持一致：浏览器本地也不会多留一枚已经无效的令牌
    maxAge: config.session.ttlSeconds,
  })
}

/** 清会话 Cookie（登出 / 会话失效时）。属性必须与写入时一致，否则覆盖不掉 */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS)
}

/**
 * 登录成功后的会话发放（P0-1-7 的 `/api/auth/login` 直接调它）。
 * 返回 `sid` 供日志排查（**不要**把它写进响应体 —— `02` §十 密钥零下发）。
 */
export async function issueSession(reply: FastifyReply, userId: string): Promise<string> {
  const sid = await createSession(userId, config.session.ttlSeconds)
  setSessionCookie(reply, sid)
  return sid
}

/**
 * 登出（P0-1-7 的 `/api/auth/logout` 直接调它）。
 *
 * 取 sid 的顺序：Cookie 优先，其次 `request.auth.sessionId`（万一 Cookie 已被清掉）。
 * 两处都没有（重复登出 / 未登录调登出）也**不报错** —— 登出是幂等操作，
 * 对"已经没有会话"的客户端报错只会让前端多写一段无意义的错误分支。
 */
export async function endSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = request.cookies?.[SESSION_COOKIE_NAME] ?? request.auth?.sessionId
  if (sid !== undefined) {
    try {
      await destroySession(sid)
    } catch (error) {
      // Redis 不可用时仍要把浏览器那枚 Cookie 清掉：用户在客户端"登出成功"，
      // 服务端的会话键会随 TTL 自行消失（最多到 SESSION_TTL_HOURS）。反而这里报错
      // 会留下"点了登出还是登录态"的观感。
      getLogger().warn({ err: error }, '登出时删除会话键失败（Cookie 仍会清除）')
    }
  }
  clearSessionCookie(reply)
}

// ───────────────────────────── 快照读取（带 60s 缓存）─────────────────────────────

/**
 * 取用户快照：先看 Redis 缓存（`02` §十 的 60s TTL），未命中回库并回填。
 * 返回 undefined 表示用户已不存在（会话应当自毁）。
 */
async function resolveSnapshot(userId: string): Promise<UserSnapshot | undefined> {
  const cached = await readUserSnapshot(userId)
  if (cached !== undefined) return cached

  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    // 只取 `requireAuth` 需要的字段：**绝不带出 password_hash**（`02` §十 密钥零下发）
    select: { id: true, username: true, role: true, status: true, mustChangePassword: true },
  })
  if (user === null) return undefined

  const snapshot: UserSnapshot = {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
  }
  await writeUserSnapshot(userId, snapshot, config.session.statusCacheTtlSec)
  return snapshot
}

/** 自毁式失败：删 Redis 键 + 清 Cookie，再按传入的错误抛出（删键失败不掩盖原错误） */
async function failSession(sid: string, reply: FastifyReply, error: AppError): Promise<never> {
  try {
    await destroySession(sid)
  } catch (cause) {
    getLogger().warn({ err: cause }, '会话自毁失败（键会随 TTL 过期，不影响本次拒绝）')
  }
  clearSessionCookie(reply)
  throw error
}

// ───────────────────────────── 装饰器 ─────────────────────────────

/** 会话存储（Redis）不可用的统一出口 —— 见文件头「②」 */
function storageUnavailable(scope: string, error: unknown): AppError {
  getLogger().error({ err: error, scope }, '会话存储不可用，无法完成会话校验')
  return AppError.internal('会话存储暂不可用，请稍后重试')
}

/**
 * 「必须已登录」的 `preHandler`。
 *
 * 顺序（每一步失败都给出**不同**但同样不泄露信息的结论）：
 *   ① 无 Cookie            → 401 未登录（**不碰 Redis**，未登录的探测请求不该打在依赖上）
 *   ② 会话键不存在/已过期  → 401 并清掉那枚废 Cookie
 *   ③ 用户已不存在         → 401 并自毁会话
 *   ④ `status=DISABLED`    → 401「账号已停用」并自毁会话（`02` §十：停用立即失效）
 *   ⑤ 通过 → 挂 `request.auth` + userId 进日志上下文
 */
async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = request.cookies?.[SESSION_COOKIE_NAME]
  if (sid === undefined || sid === '') {
    throw AppError.unauthorized('未登录或会话已失效')
  }

  let userId: string | undefined
  try {
    userId = await readSessionUserId(sid, config.session.ttlSeconds)
  } catch (error) {
    throw storageUnavailable('read-session', error)
  }
  if (userId === undefined) {
    // 会话键不在（登出/过期/伪造）：清掉客户端那枚 Cookie，避免它每个请求都再走一遍
    clearSessionCookie(reply)
    throw AppError.unauthorized('未登录或会话已失效')
  }

  let snapshot: UserSnapshot | undefined
  try {
    snapshot = await resolveSnapshot(userId)
  } catch (error) {
    // 回库失败 vs Redis 失败都归到这里：对调用方而言都是"服务端暂时没法给出结论"
    throw storageUnavailable('resolve-snapshot', error)
  }
  if (snapshot === undefined) {
    return failSession(sid, reply, AppError.unauthorized('未登录或会话已失效'))
  }
  // `02` §十：停用账号立即失效 —— 每请求都对照快照里的 status（缓存 60s，写侧主动失效）
  if (snapshot.status === UserStatus.DISABLED) {
    return failSession(sid, reply, AppError.unauthorized('账号已停用，请联系管理员'))
  }

  request.auth = { sessionId: sid, user: snapshot }
  // 让后续业务日志自动带 userId（`02` §十三：requestId 贯穿；userId 同理）
  enrichRequestContext({ userId: snapshot.id })
}

/** 「仅 ADMIN」的 `preHandler`（`02` §四：`(A)` 端点全部用它） */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply)
  const auth = request.auth
  // requireAuth 成功必然写入 auth；这里的判断只是给类型收窄 + 兜住"有人误把它当独立钩子用"
  if (auth === null) throw AppError.unauthorized('未登录或会话已失效')
  if (auth.user.role !== UserRole.ADMIN) throw AppError.forbidden('该操作仅限管理员')
}

/**
 * 装配（在 `app.ts` 里于路由注册前调用）。
 *
 * `@fastify/cookie` 用 `register` 进队列（与 CORS 同一手法）：插件在 `ready()` 时装载，
 * 早于任何路由的 handler 执行；`decorateRequest`/`decorate` 则必须**直接调用** ——
 * 走 `register` 只会装饰那个插件作用域，根作用域的路由拿不到（`errorHandler.ts` 同款坑）。
 */
export function installSession(app: FastifyInstance): void {
  void app.register(cookie, {
    // 在 onRequest 阶段解析 Cookie：`requireAuth` 是 preHandler，必须能直接读 `request.cookies`
    hook: 'onRequest',
  })

  // 默认值必须是 null 而不是 undefined：Fastify 用它做"未设置"的判定，
  // 且 null 让下游的 `request.auth === null` 判断有明确语义。
  app.decorateRequest('auth', null)
  app.decorate('requireAuth', requireAuth)
  app.decorate('requireAdmin', requireAdmin)
}
