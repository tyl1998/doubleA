/**
 * 开放平台鉴权插件（**P1-22**；`docs/08-开放平台-智能体OpenAPI(APIKey).md` §5「鉴权设计」）
 *
 * 依据：`docs/08` §5.1（Key 形态）/ §5.2（校验链 ①–⑦）/ §6.4（限速与配额）
 *      + `shared/src/openApi.ts`（Key / scope / 状态判据的唯一实现）
 *      + `plugins/session.ts` 文件头 ②（**依赖故障 = 500，不是 401**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 这是一条**旁路**，与 Cookie 会话互不可替代
 * ─────────────────────────────────────────────────────────────────────
 * · `/open/**` **不读不写** Cookie：它能工作的唯一凭据是 `Authorization: Bearer oak_…`；
 * · `/api/**` **不接受** API Key：拿 Key 打内部接口只会在 Cookie 那里 401。
 * 于是"首登改密闸门"只拦 `/api/**`（`session.ts#installPasswordChangeGate`）⇒ `/open/**` 天然不经过，
 * 这是 `docs/08` §2 表格里的那一条，不是巧合。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 校验链的**顺序就是安全属性**（§5.2 原文编号）
 * ─────────────────────────────────────────────────────────────────────
 * ```
 * ① 取 Key → 无 ⇒ 401（不碰 Redis/DB：不做存在性预言机）
 * ② 形态校验（oak_ + 长度）→ 非法 ⇒ 401
 * ③ 缓存 open:key:{sha256}（TTL 60s）命中 ⇒ 用；未命中 ⇒ 查库回填
 * ④a 状态：revoked / expires / user.status=DISABLED ⇒ 401（**同一句文案**，不区分）
 * ④b 资源：agent 未软删 ∧ type=CHATBOT ⇒ 否则 403 NOT_OPENABLE
 *              ∧ canViewAsset(agent, {用户}) ⇒ 否则 403 NOT_OPENABLE（转移后原 Key 失效）
 * ⑤ 作用域：所需 scope ∉ key.scopes ⇒ 403 FORBIDDEN
 * ⑥ 限速 / 并发 / 日 token ⇒ 429 BUSY + Retry-After
 * ⑦ 挂 `request.open` + enrichRequestContext（日志自动带 userId / openKeyId）
 * ```
 * 三处刻意的口径：
 *   · **④a 的四种失败同一句文案**（"API Key 无效或已失效"）：区分"过期"与"吊销"就等于告诉
 *     探测者"这把 Key 曾经存在"，而我们没有任何理由对外公开这件事。
 *   · **④b 与 ⑤ 都用 403 但**不同错误码**（`NOT_OPENABLE` / `FORBIDDEN`，X4）：前者的处置是
 *     "找所属人开通"，后者是"换一把 Key / 加 scope" —— 同一个码会让客户去改错东西。
 *   · **失败语义只有三种**：401（Key 问题）/ 403（授权问题）/ 429（额度问题）；
 *     依赖故障一律 500 —— 把 Redis/PG 抖动映射成 401 会让客户以为自己的 Key 坏了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 与内部会话链的叠加判据只有一条（§5.3）
 * ─────────────────────────────────────────────────────────────────────
 * 每条带 `:conversationId` 的开放端点都必须**额外**校验 `conversation.agentId === key.agentId`
 * （防"用 A 智能体的 Key 去操作同用户 B 智能体的会话"）。归属本身仍由
 * `conversation.service.ts` 的 `where { id, userId }` 给 —— 这一条是**叠加**，实现只有
 * {@link assertOpenConversation} 一处，不许散到各路由里。
 */

import { createHash, randomBytes } from 'node:crypto'

import {
  AppError,
  canViewAsset,
  openApiKeyStatusOf,
  openApiKeyUsable,
  OPEN_API_KEY_PREFIX,
  OPEN_API_KEY_SECRET_LENGTH,
  type ConversationStatus,
  type ErrorCode,
  type OpenApiKeyStatus,
  type OpenApiScope,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { enrichRequestContext, getLogger } from '../infra/logger.js'
import { getPrisma, UserStatus } from '../infra/prisma.js'
import {
  ensureRedisConnected,
  openApiConcurrencyKey,
  openApiKeyCacheKey,
  openApiRateLimitKey,
  OPEN_API_CONCURRENCY_TTL_SEC,
  OPEN_API_RATE_LIMIT_TTL_SEC,
} from '../infra/redis.js'
import { groupIdsOfUser } from '../services/userGroup.service.js'

/** Key 明文的固定长度（`oak_` + 32 个 base62 字符）—— 形态校验就是"长度 + 前缀 + 字符集" */
const KEY_PLAINTEXT_LENGTH = OPEN_API_KEY_PREFIX.length + OPEN_API_KEY_SECRET_LENGTH
const KEY_BODY_PATTERN = /^[A-Za-z0-9]+$/u

/** 明文 → 库里那份 sha256（hex 小写，`CHAR(64)`）。**这是加入缓存/查库的唯一键** */
export function hashOpenApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/** 从请求头取 Key 明文（`Authorization: Bearer` 优先，`X-API-Key` 兼容，§5.1） */
export function readOpenApiKeyPlaintext(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string') {
    const matched = /^Bearer\s+(.+)$/iu.exec(authorization.trim())
    if (matched?.[1] !== undefined) return matched[1].trim()
  }
  const header = request.headers['x-api-key']
  if (typeof header === 'string' && header.trim() !== '') return header.trim()
  return undefined
}

/** 形态校验（②）：前缀 + 长度 + 字符集。不合法 ⇒ 不查缓存、不查库（不做预言机） */
export function isWellFormedOpenApiKey(plaintext: string): boolean {
  if (plaintext.length !== KEY_PLAINTEXT_LENGTH) return false
  if (!plaintext.startsWith(OPEN_API_KEY_PREFIX)) return false
  return KEY_BODY_PATTERN.test(plaintext.slice(OPEN_API_KEY_PREFIX.length))
}

/**
 * 缓存里的 Key 快照（③）。**是所有外部状态的合并视图**，因此 TTL 到期前它们可能过时：
 * `revokedAt` / `expiresAt` / `userStatus` / `agent` 的当前状态 —— 这正是 §4.4 接受的口径
 * （吊销走**主动删键**，其余最多晚 `OPEN_API_KEY_CACHE_TTL_SEC`）。
 *
 * `status` 是缓存时的派生结论（`openApiKeyStatusOf`），但**过期判定不缓存**：每次请求都用
 * `expiresAt` 现算（key 的过期时刻是确定的，没必要延迟一秒才生效）。
 */
export interface OpenKeySnapshot {
  id: string
  keyPrefix: string
  userId: string
  agentId: string
  scopes: readonly string[]
  expiresAt: string | null
  revokedAt: string | null
  allowAutoApprove: boolean
  confirmTimeoutSec: number | null
  maxConcurrency: number | null
  rateLimitPerMin: number | null
  dailyTokenLimit: number | null
  status: OpenApiKeyStatus
  userStatus: UserStatus
  agent: {
    id: string
    name: string
    type: string
    ownerId: string
    visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC'
    deletedAt: string | null
    audienceUserIds: readonly string[]
    audienceGroupIds: readonly string[]
  }
}

/** 通过校验链后挂在 `request.open` 上的上下文（⑦） */
export interface OpenRequestContext {
  keyId: string
  keyPrefix: string
  /** Key 的归属用户 = 会话的 `user_id`（Q1：真人身份，不是虚拟账号） */
  userId: string
  agentId: string
  scopes: readonly OpenApiScope[]
  allowAutoApprove: boolean
  /** 本 Key 生效中的确认卡超时（秒；已填全局默认） */
  confirmTimeoutSec: number
  /** 本 Key 生效中的限额（已填全局默认；`dailyTokenLimit` 的 0 = 不限） */
  limits: { maxConcurrency: number; rateLimitPerMin: number; dailyTokenLimit: number }
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * 开放层 `preHandler` 工厂：校验 Key 并声明所需 scope。
     * 用法：`preHandler: app.requireOpenApi('chat')`；无 scope 的端点传 `null`。
     */
    requireOpenApi: (scope: OpenApiScope | null) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    open: OpenRequestContext | null
  }
}

// ───────────────────────────── ④a / ④b：从库里读 ─────────────────────────────

/**
 * 查库构造快照（缓存未命中时）。**软删的 Agent 也要读出来**（④b 要据此给出
 * `NOT_OPENABLE` 而不是 401 —— 那是对外的"开通"信号，与"Key 坏了"是两件事）。
 */
async function loadSnapshot(keyHash: string): Promise<OpenKeySnapshot | undefined> {
  const db = getPrisma()
  const row = await db.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      keyPrefix: true,
      userId: true,
      agentId: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      allowAutoApprove: true,
      confirmTimeoutSec: true,
      maxConcurrency: true,
      rateLimitPerMin: true,
      dailyTokenLimit: true,
      user: { select: { status: true } },
      agent: {
        select: {
          id: true,
          name: true,
          type: true,
          createdBy: true,
          visibility: true,
          deletedAt: true,
          audiences: { select: { subjectType: true, subjectId: true } },
        },
      },
    },
  })
  if (row === null) return undefined
  return {
    id: row.id,
    keyPrefix: row.keyPrefix,
    userId: row.userId,
    agentId: row.agentId,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    allowAutoApprove: row.allowAutoApprove,
    confirmTimeoutSec: row.confirmTimeoutSec,
    maxConcurrency: row.maxConcurrency,
    rateLimitPerMin: row.rateLimitPerMin,
    dailyTokenLimit: row.dailyTokenLimit,
    status: openApiKeyStatusOf(row),
    userStatus: row.user.status,
    agent: {
      id: row.agent.id,
      name: row.agent.name,
      type: row.agent.type,
      ownerId: row.agent.createdBy,
      visibility: row.agent.visibility,
      deletedAt: row.agent.deletedAt?.toISOString() ?? null,
      audienceUserIds: row.agent.audiences.filter((a) => a.subjectType === 'USER').map((a) => a.subjectId),
      audienceGroupIds: row.agent.audiences.filter((a) => a.subjectType === 'GROUP').map((a) => a.subjectId),
    },
  }
}

/** 读缓存 → 未命中回库并回填（③）。Redis 故障**向上抛**（外层翻成 500，见文件头 ②） */
async function resolveSnapshot(keyHash: string): Promise<OpenKeySnapshot | undefined> {
  const ttl = config.openApi.keyCacheTtlSec
  if (ttl <= 0) return loadSnapshot(keyHash)

  const redis = await ensureRedisConnected()
  const cacheKey = openApiKeyCacheKey(keyHash)
  const cached = await redis.get(cacheKey)
  if (cached !== null) {
    try {
      return JSON.parse(cached) as OpenKeySnapshot
    } catch {
      // 值坏了当作未命中（下一次 fetch 会覆盖它）—— 不因为一个脏值把请求打成 500
      getLogger().warn({ cacheKey }, '开放 Key 缓存值无法解析，已按未命中处理')
    }
  }

  const snapshot = await loadSnapshot(keyHash)
  if (snapshot === undefined) return undefined
  await redis.set(cacheKey, JSON.stringify(snapshot), 'EX', ttl)
  return snapshot
}

/** ④b：这个 Agent 对该用户**此刻**是否可开放（未软删 ∧ CHATBOT ∧ 能看见） */
async function isAgentOpenable(
  snapshot: OpenKeySnapshot,
  viewerRole: 'ADMIN' | 'MEMBER',
): Promise<boolean> {
  // `role` = **Key 归属用户**的角色（不是 Key 签发人）：判据主语永远是"这个用户能不能看见这个 Agent"
  const agent = snapshot.agent
  if (agent.deletedAt !== null) return false
  if (agent.type !== 'CHATBOT') return false
  const groupIds = agent.visibility === 'SHARED' ? await groupIdsOfUser(snapshot.userId) : []
  return canViewAsset(
    {
      ownerId: agent.ownerId,
      visibility: agent.visibility,
      deletedAt: agent.deletedAt,
      audienceUserIds: agent.audienceUserIds,
      audienceGroupIds: agent.audienceGroupIds,
    },
    { id: snapshot.userId, role: viewerRole, groupIds },
  )
}

// ───────────────────────────── ⑥ 限速 / 并发 / 日 token ─────────────────────────────

/** 429 + `Retry-After`（`docs/08` §6.4：「超限统一 429 BUSY + Retry-After」） */
function tooBusy(message: string, retryAfterSec: number, extra: Record<string, unknown> = {}): AppError {
  return AppError.busy(message, { retryAfterSec, ...extra })
}

/** 当前分钟窗口的起点（秒）—— 固定窗口计数用，宁可简单（滑动窗口的成本换不来什么） */
function minuteStartSec(now: Date): number {
  return Math.floor(now.getTime() / 60_000) * 60
}

/** 幂等自增 + 只在首次设置 TTL（避免 INCR 把 TTL 清掉，与 `workspace/rateLimit.ts` 同一手法） */
async function incrWithTtl(key: string, ttlSec: number): Promise<number> {
  const redis = await ensureRedisConnected()
  const next = await redis.incr(key)
  if (next === 1) await redis.expire(key, ttlSec)
  return next
}

/**
 * 每分钟请求计数（固定窗口）。**超限抛 429**（`Retry-After` = 本窗口剩余秒数）。
 *
 * ⚠️ 计数发生在**鉴权成功之后**（④a/④b/⑤ 之后）：坏 Key 不该消耗额度，也不该让攻击者
 * 用无效 Key 把合法 Key 的窗口打满。
 */
async function assertRateLimit(context: OpenRequestContext, requestId: string): Promise<void> {
  const now = new Date()
  const startSec = minuteStartSec(now)
  const key = openApiRateLimitKey(context.keyId, startSec)
  const count = await incrWithTtl(key, OPEN_API_RATE_LIMIT_TTL_SEC)
  const retryAfterSec = Math.max(1, startSec + 60 - Math.floor(now.getTime() / 1000))
  if (count > context.limits.rateLimitPerMin) {
    getLogger().warn(
      { openKeyId: context.keyId, requestId, count, limit: context.limits.rateLimitPerMin },
      '开放平台请求超出每分钟上限（429）',
    )
    throw tooBusy('请求过于频繁，请稍后重试', retryAfterSec, { limit: context.limits.rateLimitPerMin })
  }
}

/** 当前分钟窗口已用请求数（`/open/v1/usage` 用来算余量；只读，不计数） */
export async function readOpenApiRateLimitUsed(keyId: string, now: Date = new Date()): Promise<number> {
  const redis = await ensureRedisConnected()
  const raw = await redis.get(openApiRateLimitKey(keyId, minuteStartSec(now)))
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 当日 token 累计（**读** `usage_records`，不是 Redis）。
 *
 * 为什么不用 Redis 那个计数：它是"尽力而为"的累加（`persist.ts` 里 `void` 调用，见其注释），
 * 用来**拒绝**请求会误伤（漏算 ⇒ 超额放行；多算 ⇒ 误拦）。库里的行是真账，
 * 而"一把 Key 当日的行"是个小集合（有 `(open_key_id, created_at desc)` 索引）。
 */
export async function readOpenApiDayTokens(
  keyId: string,
  day: string,
): Promise<{ tokens: number; unknown: number }> {
  const start = new Date(`${day}T00:00:00.000Z`)
  const end = new Date(start.getTime() + 24 * 3600 * 1000)
  const rows = await getPrisma().usageRecord.findMany({
    where: {
      openKeyId: keyId,
      createdAt: { gte: start, lt: end },
    },
    select: { tokensIn: true, tokensOut: true },
  })
  let tokens = 0
  let unknown = 0
  for (const row of rows) {
    if (row.tokensIn === null && row.tokensOut === null) {
      unknown += 1
      continue
    }
    tokens += (row.tokensIn ?? 0) + (row.tokensOut ?? 0)
  }
  return { tokens, unknown }
}

/** ⑥ 日 token 配额（`0` = 不限）。超限 ⇒ 429（**不是** 403：它是额度用完，明天会恢复） */
async function assertDailyTokenQuota(context: OpenRequestContext, requestId: string): Promise<void> {
  const limit = context.limits.dailyTokenLimit
  if (limit <= 0) return
  const day = new Date().toISOString().slice(0, 10)
  const { tokens } = await readOpenApiDayTokens(context.keyId, day)
  if (tokens < limit) return
  // 到下一个 UTC 零点还有多少秒（`Retry-After` 要能让客户端算出"什么时候再来"）
  const now = Date.now()
  const nextDay = Date.parse(`${day}T00:00:00.000Z`) + 24 * 3600 * 1000
  const retryAfterSec = Math.max(1, Math.ceil((nextDay - now) / 1000))
  getLogger().warn(
    { openKeyId: context.keyId, requestId, dayTokens: tokens, limit },
    '开放平台当日 token 额度已用尽（429）',
  )
  throw tooBusy('当日 token 额度已用尽，请明天再试或联系所属人调整额度', retryAfterSec, {
    dayTokens: tokens,
    dailyTokenLimit: limit,
  })
}

/** 单 Key 并发闸的**租约**（`/chat` 用：流结束时必须 `release`，否则计数只会涨） */
export interface OpenConcurrencyLease {
  release: () => Promise<void>
}

/**
 * 占用一个并发名额（⑥）。超限 ⇒ 429（`Retry-After` 给 5s：并发是"等别人跑完"而不是"等窗口"）。
 *
 * 实现是 `INCR` + 比较（ioredis 没有"带上限的自增"）：`INCR` 之后发现超过上限就**减回去**再抛 ——
 * 这一对命令之间有一个极短的窗口内计数偏高，但**不会**放进不该放行的请求（宁可偶发多拒一个）。
 * 计数键带 TTL（`OPEN_API_CONCURRENCY_TTL_SEC`）：进程被杀时名额要能自己回来。
 */
export async function acquireOpenConcurrency(
  context: OpenRequestContext,
  requestId: string,
): Promise<OpenConcurrencyLease> {
  const limit = context.limits.maxConcurrency
  const key = openApiConcurrencyKey(context.keyId)
  const current = await incrWithTtl(key, OPEN_API_CONCURRENCY_TTL_SEC)
  if (current > limit) {
    await ensureRedisConnected().then((redis) => redis.decr(key)).catch(() => undefined)
    getLogger().warn(
      { openKeyId: context.keyId, requestId, current: current - 1, limit },
      '开放平台并发超限（429）',
    )
    throw tooBusy('该 Key 同时进行的对话过多，请等前一条结束后再发', 5, { limit })
  }
  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      try {
        const redis = await ensureRedisConnected()
        const next = await redis.decr(key)
        if (next <= 0) await redis.del(key)
      } catch (error) {
        // 释放失败只 warn：计数键有 TTL，最坏情况是这把 Key 在 TTL 内被少放行几次
        getLogger().warn({ err: error, openKeyId: context.keyId }, '释放开放平台并发名额失败（键会随 TTL 归零）')
      }
    },
  }
}

// ───────────────────────────── 装饰器 ─────────────────────────────

/** 依赖故障的统一出口（文件头 ②：**500，不是 401**） */
function dependencyUnavailable(scope: string, error: unknown): AppError {
  getLogger().error({ err: error, scope }, '开放平台鉴权依赖不可用')
  return AppError.internal('鉴权服务暂不可用，请稍后重试')
}

/** ④a 的统一拒绝文案（四种原因**同一句**，见文件头 ②） */
function invalidKey(): AppError {
  return AppError.unauthorized('API Key 无效或已失效')
}

/**
 * 校验链本体（①–⑦）。返回填好的上下文；任何一步失败都抛 `AppError`（由 errorHandler 转信封）。
 */
async function authenticate(
  request: FastifyRequest,
  requiredScope: OpenApiScope | null,
): Promise<OpenRequestContext> {
  // ① 无 Key：直接 401，不碰 Redis/DB
  const plaintext = readOpenApiKeyPlaintext(request)
  if (plaintext === undefined || plaintext === '') throw invalidKey()
  // ② 形态
  if (!isWellFormedOpenApiKey(plaintext)) throw invalidKey()

  const keyHash = hashOpenApiKey(plaintext)
  let snapshot: OpenKeySnapshot | undefined
  try {
    // ③ 缓存 / 回库
    snapshot = await resolveSnapshot(keyHash)
  } catch (error) {
    throw dependencyUnavailable('resolve-open-key', error)
  }
  if (snapshot === undefined) throw invalidKey()

  // ④a 状态：吊销 / 过期 / 账号停用 —— 同一句文案
  if (!openApiKeyUsable(snapshot)) throw invalidKey()
  if (snapshot.userStatus === UserStatus.DISABLED) throw invalidKey()

  // ④b 资源：未软删 ∧ CHATBOT ∧ 该用户能看见（转移后原 Key 失效，§4.4）
  try {
    const user = await getPrisma().user.findUnique({ where: { id: snapshot.userId }, select: { role: true } })
    const role: 'ADMIN' | 'MEMBER' = user?.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'
    if (!(await isAgentOpenable(snapshot, role))) {
      throw AppError.forbidden('该智能体当前不开放调用（已停用、非对话型或你已无权访问）')
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw dependencyUnavailable('check-openable', error)
  }

  // ⑤ 作用域
  const scopes = snapshot.scopes.filter((scope): scope is OpenApiScope => typeof scope === 'string') as OpenApiScope[]
  if (requiredScope !== null && !scopes.includes(requiredScope)) {
    throw AppError.forbidden(`该 API Key 缺少作用域 ${requiredScope}`, { requiredScope, scopes })
  }

  const context: OpenRequestContext = {
    keyId: snapshot.id,
    keyPrefix: snapshot.keyPrefix,
    userId: snapshot.userId,
    agentId: snapshot.agentId,
    scopes,
    allowAutoApprove: snapshot.allowAutoApprove,
    confirmTimeoutSec: snapshot.confirmTimeoutSec ?? config.mcp.confirmTimeoutSec,
    limits: {
      maxConcurrency: snapshot.maxConcurrency ?? config.openApi.maxConcurrency,
      rateLimitPerMin: snapshot.rateLimitPerMin ?? config.openApi.rateLimitPerMin,
      dailyTokenLimit: snapshot.dailyTokenLimit ?? config.openApi.dailyTokenLimit,
    },
  }

  // ⑥ 限速 / 日配额
  try {
    await assertRateLimit(context, request.id)
    await assertDailyTokenQuota(context, request.id)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw dependencyUnavailable('rate-limit', error)
  }

  // ⑦ 上下文 + 日志
  request.open = context
  enrichRequestContext({ userId: context.userId, openKeyId: context.keyId })
  return context
}

/**
 * `preHandler` 工厂（⑦）。**所有** `/open/v1/**` 路由都必须挂它（含 `GET /open/v1/agent`：
 * 无 scope 也要先证明"你手里这把 Key 是有效的"）。
 */
function requireOpenApi(
  scope: OpenApiScope | null,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    await authenticate(request, scope)
  }
}

/** 取已通过校验的上下文（handler 里用；与 `requireAuthContext` 同款） */
export function requireOpenApiContext(request: FastifyRequest): OpenRequestContext {
  const context = request.open
  if (context === null) throw invalidKey()
  return context
}

/**
 * **叠加判据**（§5.3）：这条会话必须属于 Key 绑定的那个 Agent。
 *
 * 存在性/归属仍由服务层的 `where { id, userId }` 判（别人的会话与不存在的 id 都是 404）——
 * 本函数只回答"它的 `agent_id` 是不是这把 Key 的那个"，返回该行的 `agentId`/`status`
 * 供调用方复用（省一次查询）。取不到（不存在 / 不是我的）⇒ 同样的 404。
 */
export async function assertOpenConversation(
  conversationId: string,
  context: OpenRequestContext,
): Promise<{ id: string; agentId: string; status: ConversationStatus }> {
  const row = await getPrisma().conversation.findFirst({
    where: { id: conversationId, userId: context.userId },
    select: { id: true, agentId: true, status: true },
  })
  if (row === null) throw AppError.notFound('会话不存在')
  if (row.agentId !== context.agentId) {
    // **404 而不是 403**：与"不是我的会话"同一个结论 —— 不泄漏"'这个 id 在你的另一个智能体下存在"
    throw AppError.notFound('会话不存在')
  }
  return row
}

/**
 * 写一条**结构化审计**（§8：`{openKeyId, userId, agentId, route, status, latencyMs}`）。
 *
 * 为什么不复用 `onResponse` 那条访问日志：那条是"每个请求都打"的运营日志（`app.ts` ⑤），
 * 而这条是**只给开放层**、只在这些时刻补一条 warn/info：鉴权失败、429、以及每 N 次成功的
 * 低频采样（默认不打 —— 量太大）。失败一律打，因为那才是要对账/查问题的时刻。
 */
export function auditOpenApiRejection(
  request: FastifyRequest,
  error: ErrorCode | 'UNKNOWN',
  extra: Record<string, unknown> = {},
): void {
  getLogger().warn(
    {
      route: `${request.method} ${request.url.split('?')[0] ?? request.url}`,
      code: error,
      // ⚠️ 拒在鉴权链上的请求 **没有** `request.open`（Key 没通过或根本没带）⇒ 只能记 null。
      //    这本身就是有意义的信息："这条被拒的请求是哪把 Key？" 如果 null，说明 Key 没被认下来。
      openKeyId: request.open?.keyId ?? null,
      userId: request.open?.userId ?? null,
      ...extra,
    },
    '开放平台请求被拒（审计）',
  )
}

/** 装配（在 `app.ts` 里于路由注册前调用） */
export function installOpenApiAuth(app: FastifyInstance): void {
  app.decorateRequest('open', null)
  app.decorate('requireOpenApi', requireOpenApi)
}

// ───────────────────────────── 给管理面用的派生工具 ─────────────────────────────

/** base62 字母表（Key 明文的随机段用它 —— 不含 `-`/`_`，于是"是不是 Key"只看前缀就行） */
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 生成一把新 Key 的明文：`oak_` + {@link OPEN_API_KEY_SECRET_LENGTH} 个 base62 字符。
 *
 * **拒绝采样**而不是 `byte % 62`：62 不整除 256，直接取模会让前 8 个字符的概率略高
 * （对 sha256 之后的安全性没有实质影响，但"随手做对"的成本为零，也没有任何理由留一个偏差）。
 */
export function generateOpenApiKeyPlaintext(): string {
  const out: string[] = []
  while (out.length < OPEN_API_KEY_SECRET_LENGTH) {
    for (const byte of randomBytes(OPEN_API_KEY_SECRET_LENGTH * 2)) {
      if (byte >= 248) continue
      const char = KEY_ALPHABET[byte % KEY_ALPHABET.length]
      if (char === undefined) continue
      out.push(char)
      if (out.length >= OPEN_API_KEY_SECRET_LENGTH) break
    }
  }
  return `${OPEN_API_KEY_PREFIX}${out.join('')}`
}
