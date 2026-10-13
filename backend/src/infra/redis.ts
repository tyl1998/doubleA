/**
 * Redis 客户端 + 键空间（P0-1-4 起连接，P0-1-6 起承载会话）
 *
 * 依据：`docs/02-后端设计.md` §4.9（`/health` 探 Redis）+ §十 安全设计
 *      （「HttpOnly + SameSite=Lax Cookie + Redis 存储（登出即毁）」）
 *
 * 本模块只有两件事，**不做业务策略**：
 *   1. 把连接收敛成一个单例（`getRedis()`）—— P0-1-6（会话）/ P0-1-17（流水线队列）/
 *      P0-1-26（停止信号、会话互斥锁）都复用它，不各建各的连接。
 *      唯一的例外是**阻塞式命令**：`BRPOP` 会把整条连接占住，故队列用
 *      {@link createRedisConnection} 另开一条（理由见该函数注释）。
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

import { sandboxInstanceKey, sandboxOwnerKey as buildSandboxOwnerKey } from '@doubulea/shared'

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
  client = buildClient()
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
 * 连接参数（主连接与额外连接共用一份 —— 两处各写一遍必然漂移）。
 * 四个取值的理由见文件头；`lazyConnect` 的后果是"命令会自动触发拨号"，
 * 故额外连接不需要调用方显式 `connect()`，但**仍需**过 {@link ensureRedisConnected}（见其注释）。
 */
function buildClient(): Redis {
  return new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: config.limits.healthProbeTimeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > RECONNECT_LIMIT ? null : Math.min(times * 100, RECONNECT_MAX_DELAY_MS)),
  })
}

/**
 * 另开一条**独立连接**（P0-1-17 起供流水线队列的阻塞读使用）。
 *
 * 为什么必须独立：`BRPOP` 是**阻塞**命令 —— ioredis 在它返回之前不会在同一条连接上发送
 * 后续命令。拿共享的会话连接去 BRPOP，等于把 `/api/auth`、`/health` 以及所有会话读写
 * 一起钉在队列上（症状：队列空闲时整个后端的请求都莫名变慢甚至超时）。
 * `role` 只用于日志区分（如 `pipeline-queue`），不参与任何逻辑。
 *
 * ⚠️ 返回的连接**不受 `closeRedis()` 管理** ⇒ 调用方必须自己收尾
 * （见 `pipeline/queue.ts#closePipelineQueue`），否则进程退出时会挂在这条连接上。
 */
export function createRedisConnection(role: string): Redis {
  const extra = buildClient()
  // 与主连接同一套"一轮故障只告警一次"策略，但状态**各自独立**（两条连接的可用性互不影响）
  let extraDownNotified = false
  extra.on('error', (error: unknown) => {
    if (extraDownNotified) {
      getLogger().debug({ err: error, role }, `Redis 连接异常（${role}，本轮已告警过，降为 debug）`)
      return
    }
    extraDownNotified = true
    getLogger().warn({ err: error, role }, `Redis 连接异常（${role}；本轮同类错误降为 debug）`)
  })
  extra.on('ready', () => {
    if (!extraDownNotified) return
    extraDownNotified = false
    getLogger().info({ role }, `Redis 连接已恢复（${role}）`)
  })
  return extra
}

/**
 * 确保连接已建立。
 *
 * 为什么必要：`lazyConnect` 下客户端停在 `wait`（还没拨号），`end` 则是上轮重试放弃后已关闭。
 * 这两种状态下直接发命令，命令会进离线队列**干等** —— 调用方看到的是"卡住"而不是
 * "连不上"。显式 `connect()` 让「连接被拒」作为一个明确错误抛出（与 {@link pingRedis} 同一手法）。
 *
 * 导出给 P0-1-17（队列）/ P0-1-26（锁）复用：任何 Redis 命令前都该先过这里。
 * P0-1-17 起接受一个**非单例**客户端（见 {@link createRedisConnection}）。
 */
export async function ensureRedisConnected(connection: Redis = getRedis()): Promise<Redis> {
  const redis = connection
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
 * `chat.active:{conversationId}` 键名 —— **会话的活跃流锁，同时也是活跃流状态**（P0-1-25 定义，P0-1-26 落地写侧）。
 *
 * 依据：`02` §5.2「会话互斥：Redis 锁 `chat.active:{conversationId}`；持锁期间同一会话再次发送
 * 返回错误（`code=CONFLICT`）」+ §5.1/§5.2 的 `ping` 心跳（空闲期保活）。
 *
 * 三条口径（P0-1-25 定案，写进 `02` §4.5/§5.2 的契约增量）：
 *   ① **只有一个键**：锁与"是否在流"必须是同一件事（分成两个键就会有两套真相）；
 *   ② 值是 `conversationActiveSnapshotSchema` 的 JSON（`queuedPosition`/`currentTool`/`startedAt`）,
 *      故 `GET /:id/active` 能一次读全"在流 / 排队位次 / 当前工具"；
 *   ③ **写侧归 P0-1-26**（本文件只放键名与常量；"锁怎么加、心跳怎么续期、怎么按归属释放"
 *      都在 `orchestrator/sse.ts`，那些是**编排层的语义**，不是 Redis 客户端的事）：
 *      流开始时 `SET … NX EX`（拿不到 ⇒ 409 `CONFLICT`）、每写一帧续期、结束时按归属 `DEL`。
 *      ⚠️ **必须带 TTL**：进程被杀时锁要能自己过期，否则这个会话会永久 `CONFLICT`。
 */
export function chatActiveKey(conversationId: string): string {
  return `chat.active:${conversationId}`
}

/** `chat.stop:{conversationId}` 键名（停止信号，见下） */
export function chatStopKey(conversationId: string): string {
  return `chat.stop:${conversationId}`
}

/**
 * `chat.confirm:{conversationId}` 键名 —— **确认应答槽**（P0-2-10，`02` §9.10）。
 *
 * 依据：`02` §5.2「confirm 挂起：确认等待上限 120s，超时按取消处理」+ §六 第 4 步
 *      （`elicitation 请求 → confirm 事件挂起 → /confirm 应答`）。
 *
 * ⚠️ **一个会话只有一个槽位、且值是结构化的**（`{confirmId, accepted}`）—— 这两条都与
 * `chat.stop:{id}` 刻意不同，理由各一条：
 *   · 停止信号是"有没有"（布尔），而确认应答要回答"**答的是哪一个提问**"。用"有没有"的形态
 *     会让上一轮的迟到点击被下一轮当成答案消费掉，症状是"**确认卡一闪而过**"
 *     （`06` P0-2-10 坑预判 2）⇒ 值里必须带 `confirmId`，由消费方按 id 匹配；
 *   · 槽位只有一个：同一会话同一时刻只可能有一个待答确认（流是串行的、工具是**顺序**执行的）。
 *     写第二个应答只会覆盖第一个 —— 而那是"用户点了两次"的正常形态，覆盖掉的又恰好是同一个值。
 *
 * ⚠️ 消费方（`orchestrator/sse.ts#awaitConfirm`）**读到匹配的应答后立即 DEL**：
 * 不清的话下一轮 `awaitConfirm` 会立刻拿到上一轮的答案（同一个"一闪而过"的症状）。
 * 新起一轮等待时还会**再清一次** —— 两道防线，与 `chat.stop` 同款。
 */
export function chatConfirmKey(conversationId: string): string {
  return `chat.confirm:${conversationId}`
}

/**
 * 确认应答键的 TTL（秒）。
 *
 * 与 {@link CHAT_STOP_TTL_SEC} **同一条推理**、取同一个量级：正常路径下消费方读到就删
 * （延迟 = 一次轮询，250ms–2s），TTL 只为"键写了、流却已经死了"兜底。
 * 不能取长：残留的应答会让**下一次** `awaitConfirm` 立刻命中一个**不同的** `confirmId`
 * ⇒ 被按 id 不匹配丢弃（安全），但"为什么 Redis 里躺着一个没人要的应答"会变成一个查不明白的问题。
 * ⚠️ 也不能短于一次轮询周期 —— 应答在消费方读到之前过期，用户就会看到"点了确认但没反应"。
 */
export const CHAT_CONFIRM_TTL_SEC = 60

/**
 * `chat.autoapprove:{conversationId}` 键名 —— **会话级自动审批开关**。
 *
 * 打开后，本会话内危险的 MCP 工具（以及服务端反向 elicitation）在编排层
 * (`orchestrator/sse.ts#awaitConfirm`) 被直接按"确认"放行，不再逐次弹确认卡。
 *
 * 三条口径：
 *   · 值只认 `'1'`（开）；键不存在 = 关 —— **安全默认**：任何读取失败/键丢失都退回"要确认"；
 *   · 它是**会话级、运行时**的模式开关，不落库、不参与断线重连快照，故**单独一个键**
 *     （不塞进 `chat.active:{id}`：那个键的语义是"有没有流在跑"，混进去会让 409 判定多一个维度）；
 *   · 主机制是**显式清除**（界面关掉 / 删除会话时 `removeConversation` 删键），TTL 只作兜底。
 */
export function chatAutoApproveKey(conversationId: string): string {
  return `chat.autoapprove:${conversationId}`
}

/**
 * 自动审批开关的 TTL（秒）。
 *
 * 与 {@link SANDBOX_TOKEN_TTL_SEC} 同一条推理：**主机制是显式清除**（用户关掉 / 删会话时删键），
 * TTL 只为"模式被打开后彻底没人管"兜底。取 12 小时是刻意的：既足够覆盖"一个跑很久的自动化场景"，
 * 又不会让一个被遗忘的"自动放行"在库里永久留存。
 */
export const CHAT_AUTO_APPROVE_TTL_SEC = 12 * 3600

/**
 * 停止信号的 TTL（秒）—— `02` §5.2 明文规定 60s，不是随手取的数。
 *
 * 它是**兜底**：正常路径下流结束时（`finally`）就把键删掉；TTL 只为"键写了、流却已经死了"
 * 这种情况兜底（比如停止信号与流结束几乎同时、或进程中途被杀）。
 * 之所以要兜底得这么紧：**残留的停止键会让下一个流秒停** —— 用户的症状是
 * "刚发出去的回答立刻就停在原地"，且没有任何报错。故新流启动时还会**再清一次**
 * （见 `orchestrator/sse.ts` 的 `clearStopSignal`），两道防线。
 */
export const CHAT_STOP_TTL_SEC = 60

/**
 * `chat.steer:{conversationId}` 键名 —— **中途插话信号**（P1-9 · P4 · R1）。
 *
 * 与 {@link chatStopKey} 是**同族但形态不同**：
 *   · 停止信号回答"有没有"（布尔、单值），而插话要带**内容**，且可能连着来几条
 *     ⇒ 用**列表**（`RPUSH` 入、消费方 `LPOP` 取），顺序 = 用户点击顺序；
 *   · 生产方（路由 `POST /:id/steer`）与消费方（{@link SseChannel} 的轮询）在**不同进程**里
 *     （多实例 / 定时任务）⇒ 必须过 Redis，不能像 `askConversation` 那样只查进程内注册表。
 *
 * ⚠️ **消费只有一个出口**：`orchestrator/sse.ts` 的通道轮询 `LPOP` 交给 producer 注册的
 * steer 监听器（TaskAgent 把它投给引擎的 `steer` 命令）。没有监听器时**不消费**（消息留在列表里），
 * 于是"流还没接上 steer"这段窗口里的插话不会丢。
 */
export function chatSteerKey(conversationId: string): string {
  return `chat.steer:${conversationId}`
}

/**
 * 插话信号的 TTL（秒）。与 {@link CHAT_STOP_TTL_SEC} **同一条推理**：
 * 主机制是收尾时显式 `DEL`，TTL 只为"键写了、流却已经死了"兜底。
 * ⚠️ 不能短于一次轮询周期，否则插话在消费方读到之前就过期（用户看到"发了没反应"）。
 */
export const CHAT_STEER_TTL_SEC = 60

/**
 * `workspace.round.start:{conversationId}` —— 工作区**本轮起点**标记（P1-9 · P4 · R2）。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §七 5（"每轮 agent 开始时记录…"）。TaskAgent 一轮开始
 * （派活 `runTurn` 之前）写入 ISO 时刻；「撤销本轮」（`POST .../workspace/revert`）读它作为窗口左界。
 *
 * ⚠️ 与 {@link chatActiveKey} 不同：那是"有没有流在跑"的是非题（锁语义），这里是"上一轮从何时起"的
 *    时间戳，且**只在工作区能力里被消费** ⇒ 单独一个键。缺省时「撤销本轮」返回明确错误（无标记 = 无从定义本轮）。
 */
export function workspaceRoundStartKey(conversationId: string): string {
  return `workspace.round.start:${conversationId}`
}

/**
 * `workspace.round.end:{conversationId}` —— 工作区**本轮终点**标记（P1-9 · P4 · R2）。
 *
 * 存在的理由：只记起点会让"轮末之后、下一次派活之前"的人为改动也落进窗口。有了终点，
 * 撤销窗口 = `[start, end]`；终点缺失（轮在跑 / 崩了）时退化到"start 到此刻"。
 */
export function workspaceRoundEndKey(conversationId: string): string {
  return `workspace.round.end:${conversationId}`
}

/**
 * 工作区轮次标记的 TTL（秒）—— 7 天。
 *
 * 它只用于「撤销本轮」这一个事后动作（不需要跨进程实时性），故取一个**宽松**的值：
 * 让人在一天后回来仍能撤销上一轮；又不至于让过期会话的标记永久留存。主机制是每轮起点覆盖写。
 */
export const WORKSPACE_ROUND_TTL_SEC = 7 * 24 * 3600

/**
 * `workspace.write:{conversationId}:{windowStart}` —— 工作区**写入限流**计数键（P1-9 · P6 · R6）。
 *
 * 依据：`子方案/Code模式工作区.md` §九（配额「超限拒绝并留痕」）+ §十二 P6（硬化）。挡"失控
 * agent 每秒几百次写"把 PG / FS / S3 打满。
 *
 * 两条口径（与 {@link loginFailKey} 同款推理，但**固定窗口**而非滑动窗口）：
 *   · **窗口起点进键名**（`Math.floor(now / 1min)`）：时间一到键名就翻新 ⇒ 天然"过窗即清零"，
 *     不必读改写；旧键由 TTL 自然回收；
 *   · **计数方是 `workspace/rateLimit.ts`**（`INCR` + 首次 `EXPIRE`）—— "超限了怎么办"是**领域**
 *     语义（抛 `BUSY` / 留痕），不是 Redis 客户端的事，故这里只放键名与常量。
 *
 * ⚠️ 只在**跨进程**（多实例 / 沙箱代理与公网路由分属不同 listener）才有意义：工作区路由本就
 *    要求粘性（§十六 A），故它主要服务"公网路由 + 沙箱代理"两条入口的合并计数。
 */
export function workspaceWriteRateKey(conversationId: string, windowStartMs: number): string {
  return `workspace.write:${conversationId}:${windowStartMs}`
}

/**
 * 写入限流计数键的 TTL（秒）。**必须 ≥ 一个窗口**（60s）—— 短于窗口的话计数会在窗口内过期、
 * 限流形同虚设。取 120s：覆盖窗口本身 + 一点跨边界的容差；旧键最多多留一个窗口。
 */
export const WORKSPACE_WRITE_RATE_TTL_SEC = 120

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

// ═══════════════════════════ 沙箱 MCP 代理（P0-3-9b）═══════════════════════════
//
// 一个容器 **两个键**，它们是"容器凭什么能调后端"的全部答案：
//
//   sandbox.token:{token}            → `{conversationId, userId, agentId}`（**解析方向**）
//   sandbox.convToken:{conversationId} → `token`（**撤销方向**）
//
// ⚠️ **为什么是两个键而不是一个**：审计上这两问的**方向**不同 ——
//   ① 容器带着一个不透明字符串找上来，我们要回答"**你是谁**"（token → 身份）；
//   ② 回收时要回答"**这个会话的令牌是哪个**"（会话 → token）。Redis 没有"按值查键"
//      这个操作（`SCAN` 一遍全场不是可接受的实现），所以只能把两个方向都写下来。
//   两处**必须同写同删**（`sandbox/token.ts` 把它们收在一对函数里，不给第二个写入点）。
//
// ⚠️ 令牌一旦泄露 = 别人能冒充会话去调**该会话发起者的 MCP 凭据**（`子方案③` §七 3 ② 原话）。
//    所以：值里**不放任何凭据**、TTL 跟着容器寿命走、回收时显式删。

/** `sandbox.token:{token}` 键名（`token` 是 43 字符的 base64url 随机串，见 `sandbox/token.ts`） */
export function sandboxTokenKey(token: string): string {
  return `sandbox.token:${token}`
}

/** `sandbox.convToken:{conversationId}` 键名（撤销方向，见本节头注释） */
export function sandboxConversationTokenKey(conversationId: string): string {
  return `sandbox.convToken:${conversationId}`
}

/**
 * `sandbox.mcp:{conversationId}` 键名 —— **工具清单的别名映射**（`子方案③` §七 4）。
 *
 * 值是 `{ servers: [{alias, serverId, serverName}], tools: { "<注册名>": {alias, serverId, serverName, toolName, annotations} } }`：
 * 后端按会话分配 `s1` / `s2` …，容器侧只有**已重命名**的工具名（`mcp_<alias>_<tool>`）⇒
 * 卡片要填 `serverId` 时**唯一**能反查的就是这张表（**不能靠工具名 slug 反推** —— slug 刻意不唯一，
 * 反推会指错 server，而症状只是"卡片上的 server 名不对"，不报错）。
 */
export function sandboxMcpMapKey(conversationId: string): string {
  return `sandbox.mcp:${conversationId}`
}

/**
 * 令牌与别名映射的 TTL（秒）—— **它是"容器寿命"的兜底，不是主机制**。
 *
 * 与 `chat.stop` / `chat.confirm` 同款的两道防线：
 *   · **主机制**：回收（`recycleSandbox`）时**显式删**；
 *   · **兜底**：TTL —— 回收失败 / 进程被杀 / 容器被手工删掉时，凭证不该永久留在 Redis 里。
 *
 * ⚠️ 取 12 小时而不是"跟空闲回收一个数"（30 分钟）：一个**一直在输出事件**的容器不会被空闲回收
 *   （`reapIdleSandboxes` 的判据是 `last_active_at`），活过 30 分钟是常态。取小了会造出
 *   "长任务的 MCP 调用跑到一半开始 401"这一种极难联想的现象。
 *   实际寿命由 `resolveSandboxToken()` **每次命中都续期**决定（同 `readSessionUserId` 的滑动续期口径）
 *   ⇒ 这里的数字只在"这个容器彻底静默了 12 小时"时才生效。
 */
export const SANDBOX_TOKEN_TTL_SEC = 12 * 3600

/** `sandbox.mcp:{id}` 的 TTL（秒）。与令牌**同一条推理**，同取 12 小时 */
export const SANDBOX_MCP_MAP_TTL_SEC = 12 * 3600

// ═══════════════════════════ 沙箱多机归属（P1-14；P1-9 · R9 复用）═══════════════════════════
//
// 两张表（键名构造在 `shared/src/router.ts`，判据只有一处）：
//
//   sandbox:owner:{conversationId}   → `{instanceId}`       会话**钉在哪台**（路由的唯一事实来源）
//   sandbox:instance:{instanceId}    → `{advertiseAddr,…}`   哪几台**在线**（网关实例表 + 同名自检）
//
// ⚠️ 为什么 owner 目录**不能**用 `hash(conversationId) % N` 替代（`子方案` §三 5）：哈希把落点
//    钉死成"会话 id 的函数"，一旦某台宕机，它名下的会话**没法在别的机器重建**（哈希还指向那台）。
//    目录法把落点当**运行期事实**记录，天然支持"换机重建"。
//
// ⚠️ 取值**不设** `SET NX` 失败即冲突：并发首个 `/chat` 已由 `chat.active:{id}` 锁串行化，
//    登记只可能有一个赢家；输家读回已有值即可。写目录的时机是"抢锁之后、建容器之前"。

/** `sandbox:owner:{conversationId}` —— 会话→实例目录（值 = instanceId；前缀走 `SANDBOX_OWNER_KEY_PREFIX`） */
export function sandboxOwnerKey(conversationId: string): string {
  return buildSandboxOwnerKey(config.sandbox.ownerKeyPrefix, conversationId)
}

/**
 * `sandbox:instance:{instanceId}` —— 在线实例注册表（复用 §五 1 的同一个键）。
 * 值与 TTL 由 `sandbox/owner.ts` 管理（`SET NX EX` + 周期续期 + 退出 `DEL`）。
 */
export { sandboxInstanceKey }

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

