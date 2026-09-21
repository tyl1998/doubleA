/**
 * Redis 客户端 + 键空间（P0-1-4 起连接，P0-1-6 起承载会话）
 *
 * 依据：`docs/02-后端设计.md` §4.9（`/health` 探 Redis）+ §十 安全设计
 *      （「HttpOnly + SameSite=Lax Cookie + Redis 存储（登出即毁）」）
 *
 * 本模块只有两件事，**不做业务策略**：
 *   1. 把连接收敛成一个单例（`getRedis()`）—— P0-1-6（会话）/ P0-1-17（流水线队列）/
 *      P0-1-26（停止信号、会话互斥锁）都复用它，不各建各的连接。
 *   2. 定义键名与读写原语（会话 / 用户状态快照缓存）—— 「什么时候读库、失效怎么算」
 *      属于 `plugins/session.ts` 的策略，不放这里。
 *
 * 四个刻意的取值（都为了「依赖挂掉时进程要能照样给出结论」）：
 * 1. `lazyConnect` —— import 本模块不拨号（config 校验失败时更不该拨）。
 * 2. `enableOfflineQueue` 保持 ioredis 默认的 true：命令短暂排队比立刻失败更符合会话语义。
 * 3. `maxRetriesPerRequest: 1` + **有限重试**（见 `retryStrategy`）—— 连不上时不无限重连，
 *    否则 `/health` 只能等到外层超时、拿不到「连接被拒」这个真正的原因。
 * 4. session/缓存命令**一律先 `ensureRedisConnected()`** —— 否则在 `wait` 状态下命令会进
 *    离线队列里干等，调用方看到的是"卡住"而不是"连不上"。
 */

import { randomBytes } from 'node:crypto'

import { Redis } from 'ioredis'

import { config } from '../config.js'
import { getLogger } from './logger.js'
import type { UserRole, UserStatus } from './prisma.js'


/** 首连失败后的自动重连次数上限（约 1.5s 放弃；避免探活被无限重连拖成超时） */
const RECONNECT_LIMIT = 5
/** 重连退避上限（毫秒） */
const RECONNECT_MAX_DELAY_MS = 500

let client: Redis | undefined
/** 「本轮连接故障是否已告警」——避免 redis 宕机期间每次重试都刷一条 warn */
let downNotified = false
/**
 * 最近一次**连接层**错误。
 * 为什么要单独记：ioredis 在连不上时，命令报的是「达到重试上限」这类**结果**错误，
 * 真正的根因（`ECONNREFUSED 127.0.0.1:16379`）只在连接层的 error 事件里 ——
 * 而 `/health` 的 detail 正是要告诉运维「为什么不可用」，故这里留一份。
 */
let lastConnectionError: Error | undefined

/** 取（必要时创建）单例客户端 */
export function getRedis(): Redis {
  if (client !== undefined) return client
  client = new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: config.limits.healthProbeTimeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > RECONNECT_LIMIT ? null : Math.min(times * 100, RECONNECT_MAX_DELAY_MS)),
  })
  // ⚠️ 必须挂：ioredis 每次失败都会 emit('error')，EventEmitter 无人监听即抛出未捕获异常。
  //    策略：一轮故障只 warn 一次，恢复时再补一条 info（宕机期不刷屏，恢复有痕迹）。
  client.on('error', (error: unknown) => {
    lastConnectionError = error instanceof Error ? error : new Error(String(error))
    if (downNotified) {
      getLogger().debug({ err: error }, 'Redis 连接异常（本轮已告警过，降为 debug）')
      return
    }
    downNotified = true
    getLogger().warn({ err: error }, 'Redis 连接异常（本轮同类错误降为 debug，恢复时会再报一次）')
  })
  client.on('ready', () => {
    lastConnectionError = undefined
    if (!downNotified) return
    downNotified = false
    getLogger().info('Redis 连接已恢复')
  })
  return client
}

/**
 * 确保连接已建立。
 *
 * 为什么必要：`lazyConnect` 下客户端停在 `wait`（还没拨号），`end` 则是上轮重试放弃后已关闭。
 * 这两种状态下直接发命令，命令会进离线队列**干等** —— 调用方看到的是"卡住"而不是
 * "连不上"。显式 `connect()` 让「连接被拒」作为一个明确错误抛出（与 {@link pingRedis} 同一手法）。
 *
 * 导出给 P0-1-17（队列）/ P0-1-26（锁）复用：任何 Redis 命令前都该先过这里。
 */
export async function ensureRedisConnected(): Promise<Redis> {
  const redis = getRedis()
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect()
  return redis
}

/**
 * 把「客户端状态 + 最近一次连接层错误」拼进消息。
 * `/health` 的 detail 直接用它；会话读写失败时的日志也用它 ——
 * ioredis 命令层的报错只有"达到重试上限"这种**结果**信息，根因在连接层（见 {@link lastConnectionError}）。
 */
function describeRedisFailure(redis: Redis, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const cause = lastConnectionError === undefined ? '' : `；最近一次连接错误：${lastConnectionError.message}`
  return new Error(`${message}（客户端状态：${redis.status}${cause}）`, { cause: error })
}

/**
 * Redis 探活：`PING`。
 *
 * 未连接时先显式 `connect()`（`wait` = 懒连接未拨号；`end` = 上轮重试放弃后已关闭），
 * 这样「连接被拒」会作为一个明确错误抛出，而不是让 PING 在队列里干等。
 * 失败时统一把「客户端状态 + 最近一次连接层错误」拼进消息 —— `/health` 的 detail 直接用
 * {@link pingRedis} 抛出的 message，所以要在这里把诊断信息补齐（见 `lastConnectionError` 注释）。
 */
export async function pingRedis(): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    const pong = await redis.ping()
    if (pong !== 'PONG') throw new Error(`PING 返回了非预期结果：${pong}`)
  } catch (error) {
    // 带上 `cause`：诊断信息进 detail，但原始错误对象也保留在错误链上（日志/调试能看到堆栈）
    throw describeRedisFailure(getRedis(), error)
  }
}

/** 关闭客户端（优雅退出用）；优先 QUIT 让服务端正常收尾，失败则强断 */
export async function closeRedis(): Promise<void> {
  const current = client
  client = undefined
  if (current === undefined) return
  try {
    if (current.status === 'ready') await current.quit()
    else current.disconnect()
  } catch {
    current.disconnect()
  }
}

// ═══════════════════════════ 会话与状态缓存（P0-1-6）═══════════════════════════
//
// 两个键，职责不同：
//
//   session:{sid}        → `{userId, renewedAt}`，TTL = 会话有效期
//                          「这个浏览器持有的是谁的会话」—— 登出 / 失效即 DEL（`02` §十）
//   auth-user:{userId}   → 用户快照（id/username/role/status/mustChangePassword），TTL = 60s
//                          「每请求校验 user.status」的缓存（`02` §十）
//
// 为什么快照里放的是**整份用户信息**而不只是 `status`：`requireAuth` 每个请求都要
// username/role/mustChangePassword（响应体、权限判定、首登改密闸门都要），
// 若只缓存 status，其余字段仍得回库 —— 那就等于没缓存。整份快照一次读 Redis 搞定。
//
// ⚠️ 键名不加全局前缀（如 `doubulea:`）：`REDIS_URL` 指向的是本项目独占的实例/库
//    （端口在 `infra/.env` 单独避让过），再加一层前缀只会让 `redis-cli KEYS *` 更难读。

/** 会话键前缀（`sid` 是 43 字符的 base64url 随机串） */
const SESSION_KEY_PREFIX = 'session:'
/** 用户快照缓存键前缀 */
const USER_SNAPSHOT_KEY_PREFIX = 'auth-user:'
/**
 * 滑动续期阈值：已用掉的有效期超过这个比例才续期。
 *
 * 为什么不做成"每请求都续"：那等于每个请求多一次 Redis 写（登录成功后前端会立刻并发
 * 若干个初始化请求），而收益只是把过期点往后推几秒。按半衰期续期后，
 * 「活跃用户不会被踢」与「写放大」两个目标都能满足。
 */
const RENEW_AFTER_RATIO = 0.5

/** 会话 ID 字节数：32 字节 = 256 bit 熵（远超"猜不出来"的要求），base64url 编码后 43 字符 */
const SESSION_ID_BYTES = 32

/** 用户快照：`requireAuth` 每请求需要的最小字段集合（**不含 password_hash**，`02` §十 密钥零下发） */
export interface UserSnapshot {
  id: string
  username: string
  /** 显示名（P0-1-7 加入：`/auth/me` 与顶部用户区要用，不值得为此单独回库） */
  nickname: string | null
  role: UserRole
  status: UserStatus
  mustChangePassword: boolean
}

/** 会话在 Redis 里的值（`renewedAt` 用于半衰期滑动续期判定） */
interface SessionRecord {
  userId: string
  /** 上次续期时刻（epoch ms） */
  renewedAt: number
}

/** `session:{sid}` 键名 */
export function sessionKey(sid: string): string {
  return `${SESSION_KEY_PREFIX}${sid}`
}

/** `auth-user:{userId}` 键名 */
export function userSnapshotKey(userId: string): string {
  return `${USER_SNAPSHOT_KEY_PREFIX}${userId}`
}

/**
 * 新建会话并返回 `sid`。
 *
 * `sid` **由本函数生成**（而不是由调用方传入）：会话 ID 是安全令牌，
 * 让它只能从这一个地方（CSPRNG）产生，调用方就没有"传个弱 ID 进来"的机会。
 */
export async function createSession(userId: string, ttlSeconds: number): Promise<string> {
  const sid = randomBytes(SESSION_ID_BYTES).toString('base64url')
  const record: SessionRecord = { userId, renewedAt: Date.now() }
  try {
    const redis = await ensureRedisConnected()
    await redis.set(sessionKey(sid), JSON.stringify(record), 'EX', ttlSeconds)
  } catch (error) {
    throw describeRedisFailure(getRedis(), error)
  }
  return sid
}

/** 解析会话值；结构不对（人工改过/旧格式）返回 undefined，由调用方删键自愈 */
function parseSessionRecord(raw: string): SessionRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { userId, renewedAt } = parsed as Partial<SessionRecord>
    if (typeof userId !== 'string' || userId === '') return undefined
    if (typeof renewedAt !== 'number' || !Number.isFinite(renewedAt)) return undefined
    return { userId, renewedAt }
  } catch {
    return undefined
  }
}

/**
 * 读会话 → `userId`；不存在返回 undefined。
 *
 * 顺带做半衰期滑动续期（见 {@link RENEW_AFTER_RATIO}），以及**脏数据自愈**
 * （值解析不出来就删键：不删的话每个请求都要白解析一次，且永远等不到过期）。
 */
export async function readSessionUserId(sid: string, ttlSeconds: number): Promise<string | undefined> {
  const redis = await ensureRedisConnected()
  const key = sessionKey(sid)
  let raw: string | null
  try {
    raw = await redis.get(key)
  } catch (error) {
    throw describeRedisFailure(redis, error)
  }
  if (raw === null) return undefined

  const record = parseSessionRecord(raw)
  if (record === undefined) {
    await destroySession(sid)
    return undefined
  }

  if (Date.now() - record.renewedAt >= (ttlSeconds * 1000) * RENEW_AFTER_RATIO) {
    const renewed: SessionRecord = { userId: record.userId, renewedAt: Date.now() }
    try {
      await redis.set(key, JSON.stringify(renewed), 'EX', ttlSeconds)
    } catch (error) {
      // 续期失败不该让一个本来有效的会话作废：本次照常放行，下次请求再试
      getLogger().warn({ err: describeRedisFailure(redis, error), key }, '会话续期失败（本次请求仍放行）')
    }
  }
  return record.userId
}

/** 销毁会话（登出 / 校验失败时自毁）。`DEL` 返回 0 也算成功（幂等） */
export async function destroySession(sid: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.del(sessionKey(sid))
  } catch (error) {
    throw describeRedisFailure(getRedis(), error)
  }
}

/** 写入用户快照缓存（`requireAuth` 回库后的结果） */
export async function writeUserSnapshot(
  userId: string,
  snapshot: UserSnapshot,
  ttlSeconds: number,
): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.set(userSnapshotKey(userId), JSON.stringify(snapshot), 'EX', ttlSeconds)
  } catch (error) {
    // 缓存写失败不该让请求失败（下次回库就是了），但值得留痕：Redis 挂了会影响所有请求的尾延迟
    getLogger().warn(
      { err: describeRedisFailure(getRedis(), error), userId },
      '用户快照写缓存失败（不影响本次请求）',
    )
  }
}

/** 读用户快照缓存；未命中返回 undefined（调用方回库） */
export async function readUserSnapshot(userId: string): Promise<UserSnapshot | undefined> {
  let raw: string | null
  try {
    const redis = await ensureRedisConnected()
    raw = await redis.get(userSnapshotKey(userId))
  } catch (error) {
    throw describeRedisFailure(getRedis(), error)
  }
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { id, username, nickname, role, status, mustChangePassword } = parsed as Partial<UserSnapshot>
    if (
      typeof id !== 'string' ||
      typeof username !== 'string' ||
      // ⚠️ 字段增删会让**旧缓存**在这里被判为不合法 → 视为未命中，回库重取。
      //    （比"容忍缺字段"安全：容忍会让调用方拿到 undefined 的 nickname，前端莫名不显示。)
      (nickname !== null && typeof nickname !== 'string') ||
      typeof role !== 'string' ||
      typeof status !== 'string' ||
      typeof mustChangePassword !== 'boolean'
    ) {
      return undefined
    }
    return {
      id,
      username,
      nickname: typeof nickname === 'string' ? nickname : null,
      role: role as UserRole,
      status: status as UserStatus,
      mustChangePassword,
    }
  } catch {
    return undefined
  }
}

/**
 * **主动失效**用户快照缓存 —— 「停用立即失效」的关键一半（`06` P0-1-6 坑预判）。
 *
 * 时序问题说清楚：`requireAuth` 每请求校验 `user.status`，但读的是 60s 缓存；
 * 若不主动删，停用一个账号后最坏要等 60s 才踢得掉（验收门槛写的是「60s 内失效」，
 * 但"立即"才符合用户对"停用"的直觉）。故**写侧**（P0-1-8 的启停 / 改角色 / 重置密码）必须调本函数：
 * 缓存只兜底"有人直接在库里改状态"这种非本机写入。
 */
export async function invalidateUserSnapshot(userId: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.del(userSnapshotKey(userId))
  } catch (error) {
    // 故意**向上抛**：停用/降权的调用方必须知道"缓存没清掉"（否则它会以为已经立即生效）。
    // 与 writeUserSnapshot 的"写失败只告警"刻意相反 —— 失效是正确性要求，缓存只是性能优化。
    throw describeRedisFailure(getRedis(), error)
  }
}

// ═══════════════════════════ 登录限速（P0-1-7）═══════════════════════════
//
// `02` §十：**同账号连续 5 次密码错误 → 锁 10 分钟**（Redis 计数）。
// 计数键按**归一化后的用户名**存（与登录查询口径一致），键在 10 分钟后自然过期即"自动解锁"。
//
// 为什么用滑动窗口而不是固定窗口：每次**未达上限**的失败都把 TTL 重置为 10 分钟 ——
// 这既保证"5 次都发生在 10 分钟内才算连续"（隔一天再错一次不该累加），
// 又保证锁一旦形成就**不再被新尝试续期**（否则攻击者一直点就能把它锁到天荒地老，
// 顺便把自己的账号永久锁死 —— 那是个自伤式 DoS）。

/** 登录失败计数键前缀 */
const LOGIN_FAIL_KEY_PREFIX = 'login-fail:'
/** 触发锁定的失败次数（`02` §十） */
export const LOGIN_MAX_FAILURES = 5
/** 锁定时长（秒）＝ 计数键 TTL（`02` §十：10 分钟） */
export const LOGIN_LOCK_TTL_SEC = 600

/** `login-fail:{username}` 键名（`username` 必须是归一化后的值） */
export function loginFailKey(username: string): string {
  return `${LOGIN_FAIL_KEY_PREFIX}${username}`
}

/** 登录锁状态：已锁定时给出剩余秒数（用于「请 N 分钟后重试」） */
export interface LoginLock {
  failures: number
  retryAfterSec: number
}

/**
 * 读登录锁状态；**未锁定返回 undefined**。
 * 只有失败次数达到 {@link LOGIN_MAX_FAILURES} 才算锁定 —— 恰好 5 次时第 6 次被拒
 * （`01` §五 门槛 5 的口径：「连续 5 次密码错误 → 第 6 次返回已锁定」）。
 */
export async function readLoginLock(username: string): Promise<LoginLock | undefined> {
  try {
    const redis = await ensureRedisConnected()
    const key = loginFailKey(username)
    const [raw, ttl] = await Promise.all([redis.get(key), redis.ttl(key)])
    const failures = raw === null ? 0 : Number.parseInt(raw, 10)
    if (!Number.isFinite(failures) || failures < LOGIN_MAX_FAILURES) return undefined
    // TTL 为 -1/-2（无过期或键不存在）时兜底给 1 秒，避免前端显示"0 分钟后重试"
    return { failures, retryAfterSec: ttl > 0 ? ttl : 1 }
  } catch (error) {
    throw describeRedisFailure(getRedis(), error)
  }
}

/**
 * 记一次失败，返回累计次数。
 * 仅在**未达上限**时重置 TTL（见本小节头注释：锁定后不再续期，锁才会真的到期）。
 */
export async function recordLoginFailure(username: string): Promise<number> {
  try {
    const redis = await ensureRedisConnected()
    const key = loginFailKey(username)
    const failures = await redis.incr(key)
    if (failures <= LOGIN_MAX_FAILURES) await redis.expire(key, LOGIN_LOCK_TTL_SEC)
    return failures
  } catch (error) {
    throw describeRedisFailure(getRedis(), error)
  }
}

/**
 * 清除失败计数（**登录成功即清**，`06` P0-1-7 坑预判：「成功即 DEL 计数键」）。
 * 幂等；不清的话"错了 4 次 → 成功 → 再错 1 次"就会被锁，与用户直觉不符。
 */
export async function clearLoginFailures(username: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.del(loginFailKey(username))
  } catch (error) {
    // 清计数失败不该让一次**成功**的登录失败（否则用户明明密码对却登不进来）——
    // 代价只是"下次失败会从旧计数继续累加"，最坏多锁一次。
    getLogger().warn({ err: describeRedisFailure(getRedis(), error), username }, '清除登录失败计数失败（本次登录仍放行）')
  }
}

