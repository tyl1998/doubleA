/**
 * SSE 归一化出口（P0-1-26）
 *
 * 依据：`docs/02-后端设计.md` §五（协议全文：事件全集 / 语义规则）+ §5.2（互斥、心跳、停止、断线）
 *      + §六 第 1 步（入口）、§4.5（`POST /:id/chat` / `/stop`）+ `03` §4.1（输入区状态机）/ §五（事件→UI）
 *      + `01` 决策 8（并发控制）、决策 15（停止即中断，已生成内容保留）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一层负责什么：把"一帧一帧往外写"这件事做对
 * ─────────────────────────────────────────────────────────────────────
 * 它**不认识 LLM、不碰数据库、不组装上下文** —— 那些是编排层（P0-1-27 的 `chatBot.ts`）。
 * 它只做四件事，四件都是"错了很难查"的那类：
 *
 * **① 帧的序列化与写出**（`event:` / `data:` 两行 + 空行；见 {@link serializeSseFrame}）
 *    · 每帧先过 `SSE_PAYLOAD_SCHEMAS` 校验：形状不对的事件在**这里**报出来（连带 zod 明细），
 *      而不是让前端在渲染层炸（前端按事件名分派，坏帧的报错指不回来）。
 *    · **背压**：客户端不读时 `res.write()` 返回 false，`emit` 会等到 `drain` 再返回 ——
 *      于是 `await emit(...)` 的编排循环被自然限速，不会把整条回答堆在内存里。
 *
 * **② 心跳**（{@link SseChannel}）—— `06` P0-1-26 的坑预判点名：心跳要覆盖**排队 / confirm 挂起 /
 *    引擎长静默**三种空闲态。这里刻意做成**无条件周期**（而不是"空闲才发"）：
 *    空闲态会随编排层演化而增加（将来还有沙箱启动、产物收集），而"空闲才发"要求**每一个等待点
 *    都记得重置计时器** —— 那是把正确性寄托在"每个新增等待点都没忘"上（P0-1-11 的教训）。
 *    无条件周期的代价只是活跃时多几个几十字节的帧，而前端对 `ping` **静默忽略**（`03` §五）。
 *    顺带一个好处：这个周期同时是**锁的续期节拍**（见 ③），两个机制共用一条时间线。
 *
 * **③ 会话互斥锁**（`02` §5.2：`chat.active:{conversationId}`）—— 加了锁才允许往外写内容，
 *    避免双标签页把同一会话的历史写乱。三条实现口径：
 *    · **`SET … NX EX` 一步拿到锁**：判断与写入必须是一次原子操作（"先 EXISTS 再 SET"在两次
 *      请求同时到达时都会通过）；
 *    · **锁的 TTL 跟着心跳走**（3 个心跳周期）：每写一帧就续期，所以只要进程活着锁就不会掉；
 *      而进程一死（被 kill / OOM），这个会话最迟 3 个心跳周期后自动解锁 —— 用户不必等一个长 TTL，
 *      也不会永远卡在 `CONFLICT` 上（这是"必须带 TTL"的全部目的）；
 *    · **释放要按归属**（`startedAt` 是本次流的身份）：直接 `DEL` 会把"已经属于下一个流"的锁删掉，
 *      于是第三个流也能进来 ⇒ 真的并发写同一份历史。**加锁是无条件的、释放是有条件的**。
 *
 * **④ 停止信号**（`02` §5.2：`chat.stop:{id}`，TTL 60s）——
 *    `/stop` **只写键**（`orchestrator` 不做进程内注册表：多进程部署下注册表只有本进程看得见，
 *    而 Redis 键是所有形态下都对的那一种）；本层用一个小周期**轮询**这个键，
 *    发现即 `abort(…, 'user')`：给 producer 的 `AbortSignal` 会中断正在进行的上游调用，
 *    producer 自己 catch 中断、把已生成的内容落库、返回 `STOPPED`（`01` 决策 15）。
 *    轮询间隔跟着 `SSE_PING_INTERVAL_SEC` 缩放（心跳周期的 1/10，夹在 250ms–2s），
 *    于是"注入一个小心跳 = 所有窗口一起变小"，验收不必等生产默认值（P0-1-6 的教训）。
 *    这个键的存活期严格等于"有一个待消费的停止信号"：新流启动时清（防误伤下一轮）、
 *    本条流收尾时清（在释放锁**之前**，理由见 `streamChatReply` 的 finally）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 收尾规则：一条流以 `done` **或** `error` 结尾（二选一、各一次）
 * ─────────────────────────────────────────────────────────────────────
 * 详见 `shared/src/sse.ts` 文件头 ③。四条实现要点：
 *   · **前置失败**（未登录 401 / 参数 400 / 会话不存在或不是我的 404 / 会话只读 409 /
 *     缺凭据 424 / 绑定模型停用 409）一律走 JSON 信封 —— 那些在**路由层**就抛了，
 *     `reply.hijack()` 还没发生，Fastify 的 errorHandler 照常工作；
 *   · **⚠️ 例外：并发冲突走 `error{code:CONFLICT}` 事件**（不抛、由本层的
 *     {@link writeSseErrorReply} 收尾）。分界线是**主语**而不是"能不能在写帧前判定"：
 *     `02` §4.5/§5.2 + `03` §五 + `06` 验收原文四处都把它定义成流内 `error`
 *     （`03` §五 还配了"消息流内错误卡"）—— 详见 `shared/src/sse.ts` 文件头 ③；
 *   · `producer` **自己接住中断**（它才知道已生成的内容）⇒ 返回 `{messageId, finishReason:'STOPPED'}`；
 *     只有它没接住时，本层才兜底成 `done{STOPPED, messageId:null}`（`null` 的语义见
 *     `shared/src/sse.ts` 文件头 ④：**这一轮没有产生可持久化的消息**，不是"忘了填"）；
 *   · **`lock-lost` 一律走 `error`，且由本层改判**：producer 可能压根没察觉锁已丢
 *     （占位实现就只等 abort）⇒ 不能看"它返回得正常"就发 `done`，否则前端把
 *     "服务端状态异常、零产出"显示成"你点了停止"（`01` 决策 15 的反面）；
 *   · 非 `AppError` 的异常一律收敛为 `error{code:'INTERNAL'}` + 通用文案（`02` §十 不透传内部细节），
 *     原始错误连同堆栈只进日志。唯一的例外是本层自己抛的 `ChatStoppedError`（它的文案本就是
 *     写给用户的，见 `SseChannel#fail`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本层**刻意不做**的（属后续批次，不要顺手补）
 * ─────────────────────────────────────────────────────────────────────
 *   · **并发闸**（`CHATBOT_CONCURRENCY` 满则 429 `BUSY`）→ **P0-1-27**：它是进程级信号量，
 *     而本层只跑"一进一出"的通道（见 `conversation.service.ts#assertConversationSendable` 的注释）；
 *   · `queued` 事件的**产生者**（沙箱排队位次）→ P0-3；
 *   · `confirm` 的**应答端点** `POST /:id/confirm` → **P0-2**（要 `mcp_servers` 表）；
 *   · 断线重连的**前端**逻辑（先查 `/active` 再拉历史）→ P0-1-32；本层只保证"断开即释放锁
 *     + `/active` 读得到进度"这两半。
 */

import {
  AppError,
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  SSE_CONTENT_TYPE,
  SSE_PAYLOAD_SCHEMAS,
  type ConversationActiveSnapshot,
  type SseDonePayload,
  type SseErrorPayload,
  type SseEvent,
  type SseEventName,
} from '@doubulea/shared'
import type { FastifyReply } from 'fastify'
import type { ServerResponse } from 'node:http'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import {
  CHAT_STOP_TTL_SEC,
  chatActiveKey,
  chatStopKey,
  ensureRedisConnected,
  getRedis,
} from '../infra/redis.js'
import { LlmAbortError, type LlmTarget } from '../llm/client.js'

// ═════════════════════════════════════════════════════════════════════
// 常量与纯函数
// ═════════════════════════════════════════════════════════════════════

/**
 * SSE 响应头（`06` P0-1-26 坑预判「SSE 响应头要禁缓冲」的落点）。
 *
 * 四行的理由各不相同，少一行都会在**某种部署形态下**表现为"回答卡住不出来"：
 *   · `content-type` 带 `charset=utf-8`：中文增量必须有明确编码（有的客户端会按 latin-1 解，
 *     症状是个别字变成乱码，而 JSON 里的转义让它在本地测不出来）；
 *   · `cache-control: no-cache, no-transform`：`no-transform` 专门挡"中间层合并/重写正文"
 *     （有的企业代理会把小帧攒成大帧，那会让流式变成"憋半天一次性出现"）；
 *   · `x-accel-buffering: no`：nginx 系的缓冲开关在**应用侧**的表达（`02` §十二 的部署前提
 *     里也写了 `proxy_buffering off`，但网关配置不是我们能保证的，双写一遍更稳）；
 *   · `connection: keep-alive`：显式声明长连接（老代理看到 `close` 会当一次性请求收尾）。
 */
const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': SSE_CONTENT_TYPE,
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
}

/**
 * 锁 TTL = 心跳周期的多少倍。
 *
 * 3 倍 = 允许连丢两个心跳都不掉锁。为什么不更长：TTL 是"进程被杀之后，这个会话多久能重新发消息"
 * 的**唯一上限**（正常路径是 `finally` 里主动释放）—— 取 30 分钟会让一次 kill 变成"这个会话
 * 半小时内一直报 CONFLICT"，而用户完全不知道该等什么。
 */
const LOCK_TTL_PING_MULTIPLIER = 3
/** 锁 TTL 的下限（秒）：心跳周期被注入成 1s 时（验收常用），锁也别短到一次 GC 就掉 */
const LOCK_TTL_MIN_SEC = 30

/**
 * 帧序列化 —— **纯函数**（`verify:app` 的无依赖档断言它）。
 *
 * 只写 `event:` 与 `data:` 两行，**刻意不写 `id:`**：本系统不做 SSE 重放（`02` §5.2「事件即真相」），
 * 带上 `id` 只会让未来的读者以为存在 `Last-Event-ID` 续传。
 * `JSON.stringify` 的输出里不会有裸换行（换行被转义成 `\n`），故正文恒为**单行** ——
 * 这是 SSE 的硬要求：`data:` 之后遇到换行即视为帧结束，未转义的多行内容会被前端当两帧。
 * 结尾的 `\n\n` 是帧分隔符（缺了它，最后几帧会一直留在客户端缓冲里，症状是"回答末尾少一段"）。
 */
export function serializeSseFrame(event: SseEvent): string {
  return `event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`
}

/** 停止信号的轮询间隔（毫秒）：心跳周期的 1/10，夹在 250ms–2s（见文件头 ④） */
function stopPollIntervalMs(): number {
  const tenth = (config.limits.ssePingIntervalSec * 1000) / 10
  return Math.min(2000, Math.max(250, tenth))
}

/** 当前锁的 TTL（秒），见 {@link LOCK_TTL_PING_MULTIPLIER} */
function lockTtlSec(): number {
  return Math.max(LOCK_TTL_MIN_SEC, config.limits.ssePingIntervalSec * LOCK_TTL_PING_MULTIPLIER)
}

/**
 * "活跃锁丢了"的**用户文案**（唯一一份）。
 *
 * 为什么单独拎出来：它在**两个**地方要用 —— `SseChannel#renewLock` 的中断，以及
 * `streamChatReply` 里对"producer 正常返回、但锁已经丢了"的改判（见那里的注释）。
 * 两份文案漂移的症状：同一件事在两条路径上给出两种解释。
 *
 * 措辞上**不提"锁"**：这是内部状态异常，用户能做且该做的只有一件事 —— 重发。
 * 技术原因（过期 / 被清理）由 `#renewLock` 的 warn 日志承载，工程排查不缺线索。
 */
const LOCK_LOST_MESSAGE = '会话状态异常，本次生成已中断，请重新发送消息'

// ═════════════════════════════════════════════════════════════════════
// 停止信号（`chat.stop:{id}`）：路由写入、通道轮询
// ═════════════════════════════════════════════════════════════════════

/**
 * 写停止信号，返回"是否确实有一个正在跑的流"。
 *
 * 调用方（路由）已经用 `/active` 判过一遍 `streaming`，这里再判一次 `EXISTS` 是**刻意的重复**：
 * 键的消失只有可能是"流刚结束"，而那种情况下写进去就是一个**没人消费的残留键** ——
 * 它会在 60s 内让用户下一条消息**秒停**（见 `CHAT_STOP_TTL_SEC` 的注释）。宁可多一次 EXISTS。
 */
export async function signalStop(conversationId: string): Promise<boolean> {
  const redis = await ensureRedisConnected()
  const exists = await redis.exists(chatActiveKey(conversationId))
  if (exists === 0) return false
  // 值放时间戳而不是 `'1'`：`redis-cli GET` 一眼能看出"谁在什么时候停的"
  await redis.set(chatStopKey(conversationId), new Date().toISOString(), 'EX', CHAT_STOP_TTL_SEC)
  return true
}

/**
 * 清掉停止信号键。**两个调用点，缺一不可**：
 *
 *   · **新流启动时**（`streamChatReply` ②）：防"上一轮停止留下的键"把刚发出去的回答秒停；
 *   · **本条流收尾时**（`streamChatReply` 的 finally，且在释放锁**之前**）：让这个键的存活期
 *     严格等于"有一个待消费的停止信号"——否则收尾后它还要挂 60s，`redis-cli` 上看就是
 *     "明明没人点了，却有一个待处理的停止"。正常路径主动清 + TTL 自愈，两层都留着：
 *     进程被杀（键来不及清）时就只剩 TTL 这一层，而那时第一道防线负责兜住。
 *
 * 不清的后果都是坏体验：第一种是"刚发出去的回答停在原地，没有任何报错"。
 */
export async function clearStopSignal(conversationId: string): Promise<void> {
  try {
    await getRedis().del(chatStopKey(conversationId))
  } catch (error) {
    // 清不掉不阻塞开工/收尾：最坏是这一轮被残留信号秒停（可重发），而抛出去会让"发消息"整个失败
    getLogger().warn({ err: error, conversationId }, '清除停止信号失败（本次流可能被残留信号中断）')
  }
}

// ═════════════════════════════════════════════════════════════════════
// 会话互斥锁（`chat.active:{id}` = 锁 + 活跃流状态，见 `infra/redis.ts#chatActiveKey`）
// ═════════════════════════════════════════════════════════════════════

/**
 * 尝试拿锁。**`SET NX EX` 一条命令**（见文件头 ③）。
 *
 * @returns `true` = 拿到了（此时 `chat.active:{id}` 已存在、`/active` 会读出 `streaming:true`）
 */
export async function acquireConversationLock(
  conversationId: string,
  snapshot: ConversationActiveSnapshot,
): Promise<boolean> {
  const redis = await ensureRedisConnected()
  const result = await redis.set(
    chatActiveKey(conversationId),
    JSON.stringify(snapshot),
    'EX',
    lockTtlSec(),
    'NX',
  )
  return result === 'OK'
}

/**
 * 释放锁 —— **按归属**（只有值里的 `startedAt` 是本此流的才删），见文件头 ③。
 *
 * @returns `true` = 确实删掉了自己那把锁
 */
export async function releaseConversationLock(
  conversationId: string,
  startedAt: string,
): Promise<boolean> {
  const redis = await ensureRedisConnected()
  const key = chatActiveKey(conversationId)
  const raw = await redis.get(key)
  if (raw === null) return false
  if (readStartedAt(raw) !== startedAt) return false
  await redis.del(key)
  return true
}

/** 从锁值里取 `startedAt`（**不抛错**：值坏时返回 `undefined` ⇒ 释放时按"不是我的"处理） */
function readStartedAt(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = (parsed as { startedAt?: unknown }).startedAt
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 更新 `/active` 快照（读-合-写）。**锁不存在时静默跳过**。
 *
 * 抽成模块级函数（而不是只留在 {@link SseChannel} 里）有两个理由：
 *   · 通道方法要能调它（`SseChannel#updateSnapshot` 就是一层薄委托，只剩 `#closed` 判断）；
 *   · **验收需要单独调用它**（`verify-chat-stream.mjs`）：占位 producer 不会走到这条路，
 *     而"写侧→读侧一致"这条断言不能等到 P0-1-27 才有第一条 HTTP 路径 ——
 *     与 P0-1-25 把 `touchConversation` 做成可单独调用的函数是同一种取证手法。
 *
 * @param startedAt 本次流的身份。**不要从调用方臆造**：它与锁的归属标识必须逐字相同，
 *   否则将来"按归属释放"会认不出自己的锁。
 */
export async function updateActiveSnapshot(
  conversationId: string,
  startedAt: string,
  patch: Partial<ConversationActiveSnapshot>,
): Promise<void> {
  const redis = await ensureRedisConnected()
  const key = chatActiveKey(conversationId)
  const raw = await redis.get(key)
  if (raw === null) {
    // 锁没了 ⇒ 这个会话此刻没有活跃流（流已被 #renewLock 中断 / 已释放）。不在读路径上做中断，
    // 只记一条 —— 与 `SseChannel#updateSnapshot` 的口径一致。
    getLogger().debug({ conversationId }, '活跃流锁不存在，跳过快照更新')
    return
  }
  // 以库里的值为底（保留 streaming 判定所需的 startedAt 等字段），再盖本次 patch
  let merged: Record<string, unknown> = { ...patch, startedAt }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) merged = { ...parsed, ...patch }
  } catch {
    // 值坏了就以本次快照为准（它马上会被覆盖成合法值）
  }
  // ⚠️ `SET` 不带 `EX` 会**清掉 TTL** ⇒ 锁变成永不过期 —— 这正是"进程被杀后永久 CONFLICT"的成因
  await redis.set(key, JSON.stringify(merged), 'EX', lockTtlSec())
}

// ═════════════════════════════════════════════════════════════════════
// 给 producer 的上下文（编排层与出口层之间唯一的交换面）
// ═════════════════════════════════════════════════════════════════════

/** 流被中断的原因（决定收尾事件与日志口径） */
export type ChatStopReason =
  /** 用户点了停止（`/stop` 写了 `chat.stop:{id}`） */
  | 'user'
  /** 客户端断开（关标签页 / 网络断 / 前端主动 abort） */
  | 'client'
  /** 锁丢了（被过期或被删——见文件头 ③），继续写就等于和别的流抢同一份历史 */
  | 'lock-lost'

/**
 * 中断（或主动放弃）本条流时抛出的错误。
 *
 * 它是 `AbortSignal` 的 **abort reason**（`controller.abort(new ChatStoppedError(...))`），
 * 于是 producer 侧有两种等价写法：`await` 里自然抛出，或在每个可中断点主动
 * `signal.throwIfAborted()`（原生方法，抛出来的就是这个对象）——即 `02` §5.2 说的
 * "编排循环每个可中断点检查"。
 */
export class ChatStoppedError extends Error {
  readonly reason: ChatStopReason

  constructor(reason: ChatStopReason, message: string) {
    super(message)
    this.name = 'ChatStoppedError'
    this.reason = reason
  }
}

/** producer 完成后交给出口层的收尾信息 */
export interface ChatProducerResult {
  /**
   * 这一轮落库的消息 id；`null` = **没有产生可持久化的消息**
   * （`shared/src/sse.ts` 文件头 ④ —— 不是"忘了填"，故不许编一个假 id）。
   */
  messageId: string | null
  finishReason: SseDonePayload['finishReason']
  /** 本轮的 token 用量；`null` = 没有上游调用（或上游不给 usage） */
  usage: SseDonePayload['usage']
}

/**
 * producer 能用的东西（编排层唯一依赖的接口）。
 *
 * 三个成员各有明确用途，**都不是便利方法**：
 *   · `emit` —— 写一帧（带 schema 校验与背压等待，见文件头 ①）。**已结束/客户端断开后静默丢弃**：
 *     producer 收尾时不必自己判断"还能不能写"。
 *   · `signal` —— 中断信号。必须传给它发起的每一次上游调用（`chatStream` 的 `abortSignal`），
 *     否则点"停止"只会停止我方的循环、上游连接还挂着（P0-1-12 的教训：中断要在每帧之前显式生效）。
 *   · `updateSnapshot` —— 更新 `/active` 快照（`currentTool` / `queuedPosition`）。
 *     断线重连的用户就是靠它知道"现在在干什么"（`02` §5.2）。
 */
export interface ChatProducerInput {
  conversationId: string
  agentId: string
  /** 已解析的上游目标（含明文 Key ⇒ 只进内存，日志用 `describeTarget`） */
  target: LlmTarget
  /** 本次流的开始时刻（ISO 8601）—— 同时也是锁的归属标识（见文件头 ③） */
  startedAt: string
  signal: AbortSignal
  emit: (event: SseEvent) => Promise<void>
  updateSnapshot: (patch: Partial<ConversationActiveSnapshot>) => Promise<void>
}

/** 编排循环（P0-1-27）要实现的形状；本批的占位实现见 `orchestrator/index.ts` */
export type ChatProducer = (input: ChatProducerInput) => Promise<ChatProducerResult>

// ═════════════════════════════════════════════════════════════════════
// 通道：定时器 / 写帧 / 收尾
// ═════════════════════════════════════════════════════════════════════

/**
 * 一条 SSE 通道的生命周期。做成类而不是一堆闭包，是因为它有**四个需要被正确清理的状态**
 * （两个定时器、一个 closed 标记、一个 AbortController）—— 闭包写法在异常路径上极易漏掉其中一个。
 *
 * 清理顺序在 {@link dispose} 里，理由写在那里。
 */
class SseChannel {
  readonly #raw: ServerResponse
  readonly #conversationId: string
  readonly #startedAt: string
  readonly #controller: AbortController
  #pingTimer: NodeJS.Timeout | undefined
  #stopTimer: NodeJS.Timeout | undefined
  #closed = false
  /** 已写出的帧数（按事件名计数）—— 收尾日志用它，也是"这条流到底发生了什么"的唯一线索 */
  readonly #frameCounts = new Map<SseEventName, number>()

  constructor(raw: ServerResponse, conversationId: string, startedAt: string) {
    this.#raw = raw
    this.#conversationId = conversationId
    this.#startedAt = startedAt
    this.#controller = new AbortController()
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get closed(): boolean {
    return this.#closed
  }

  /** 中断原因（未中断为 `undefined`）—— 收尾时据此决定发 `done` 还是 `error` */
  get stopReason(): ChatStopReason | undefined {
    const reason = this.#controller.signal.reason
    return reason instanceof ChatStoppedError ? reason.reason : undefined
  }

  /** 从锁值里读回"是不是已经被别人接管"不会有副作用，故这里只做标记 */
  get startedAt(): string {
    return this.#startedAt
  }

  /** 帧数统计（日志用；`Map` 转成普通对象更好读） */
  frameCounts(): Record<string, number> {
    return Object.fromEntries(this.#frameCounts)
  }

  /**
   * 中断本流（幂等）。`user` / `client` / `lock-lost` 的区别只在收尾事件与日志里用得到。
   */
  abort(reason: ChatStopReason, message: string): void {
    if (this.#controller.signal.aborted) return
    this.#controller.abort(new ChatStoppedError(reason, message))
    // 客户端断开 ⇒ 这条响应已经没人读了。后续 `emit` 一律静默丢弃（`#closed`），
    // 更重要的是**不再尝试写**：写了只会掉进 {@link #waitDrain} 去等一个不会到来的 drain。
    // `user` / `lock-lost` 刻意不这么设 —— 那两种情况下连接还在，收尾帧必须真的写出去。
    if (reason === 'client') this.#closed = true
  }

  /**
   * 写一帧。三条保证：
   *   ① 先过 payload schema（失败抛出 ⇒ 由收尾逻辑变成 `error` 帧，并留下 zod 明细）；
   *   ② 已关闭（客户端断开 / 流已收尾）时**静默丢弃**（不抛：producer 收尾时的收尾帧不该让它失败）；
   *   ③ 背压：`write()` 返回 false 时等到 `drain`（或连接关闭）再返回。
   */
  async emit(event: SseEvent): Promise<void> {
    // ① 形状校验。用 `safeParse` 而不是 `parse`：失败要走"收尾成 error 帧"，而不是把 zod 的
    //    错误对象直接抛到 producer 外面（那样用户只会看到一句"内部错误"）。
    //    ⚠️ 校验通过后直接序列化**原对象**：SSE 的 payload schema 刻意全是"纯形状"（无 `.transform()`），
    //    故 `parsed.data` 与 `event.data` 逐字段相等。将来若给某个 payload 加了 transform，
    //    就必须把这一行改成序列化 `parsed.data`（否则 transform 静默不生效）。
    const parsed = SSE_PAYLOAD_SCHEMAS[event.name].safeParse(event.data)
    if (!parsed.success) {
      throw AppError.internal(
        `内部事件形状不合法（${event.name}）：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
        { event: event.name },
      )
    }

    // 连接已经没了 ⇒ 静默丢弃，**不要**再尝试写（`write()` 在已销毁的 socket 上会异步抛
    // `ERR_STREAM_DESTROYED`，那是个没有调用方能接的 'error' 事件；见 {@link #waitDrain}）
    if (this.#closed || this.#raw.destroyed) return

    try {
      const flushed = this.#raw.write(serializeSseFrame(event))
      this.#frameCounts.set(event.name, (this.#frameCounts.get(event.name) ?? 0) + 1)
      if (!flushed) await this.#waitDrain()
    } catch (error) {
      // 写失败基本只有一种原因：连接没了（EPIPE）。标记关闭即可 —— 后续 emit 全部静默丢弃，
      // 而 producer 会在下一次上游/循环检查点上被 `close` 事件（见 `streamChatReply`）中断
      this.#closed = true
      getLogger().debug({ err: error, conversationId: this.#conversationId }, 'SSE 写帧失败（连接可能已断开）')
    }
  }

  /**
   * `write()` 返回 false 时等排空；连接关闭也 resolve。
   *
   * ⚠️ **必须先判"连接还在不在"** —— 这个提前返回不是优化，是修一个会让整条流挂死的 bug：
   * 下面两个 `once` 监听器只在**将来**的事件上触发。客户端已经断开时，`close` 早已发生过，
   * `once('close')` 就**再也不会**触发了 ⇒ 这个 `await` 永久挂住 ⇒ `finish()` 回不来 ⇒
   * `streamChatReply` 的 `finally` 永远走不到 ⇒ **活跃流锁一直不释放**，直到 3 个心跳周期的 TTL。
   * （症状：用户关掉标签页之后，这个会话在 TTL 内一直报 CONFLICT —— 而这正是 D 组要防的那件事；
   * 同时每次心跳都会再挂一个永不触发的监听器，Node 会刷 `MaxListenersExceededWarning`。）
   * `destroyed` / `writableEnded` 是对"事件已经过去了"的同步可见表示，故用它兜住。
   */
  #waitDrain(): Promise<void> {
    if (this.#raw.destroyed || this.#raw.writableEnded) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        this.#raw.off('drain', done)
        this.#raw.off('close', done)
        resolve()
      }
      this.#raw.once('drain', done)
      this.#raw.once('close', done)
    })
  }

  /**
   * 起心跳与停止轮询（见文件头 ②④）。
   *
   * 两个定时器都 `unref()`：它们**不该阻止进程退出**（优雅退出时靠 `request` 的 close 与
   * `dispose` 收尾；万一某条流没被正常收尾，进程也不该被它拖住）。
   */
  start(): void {
    const pingMs = config.limits.ssePingIntervalSec * 1000
    this.#pingTimer = setInterval(() => {
      // 心跳：写一帧 + 续锁。两件事**必须一起做**（续锁节拍就是这个定时器，见文件头 ③）
      void this.#beat()
    }, pingMs)
    this.#pingTimer.unref()

    this.#stopTimer = setInterval(() => {
      void this.#pollStopSignal()
    }, stopPollIntervalMs())
    this.#stopTimer.unref()
  }

  /** 一次心跳：写 `ping` + 续锁（失败只告警，见各自注释） */
  async #beat(): Promise<void> {
    try {
      await this.#renewLock()
    } catch (error) {
      getLogger().warn({ err: error, conversationId: this.#conversationId }, '活跃流锁续期失败（本轮跳过）')
    }
    try {
      await this.emit({ name: 'ping', data: { ts: new Date().toISOString() } })
    } catch (error) {
      getLogger().debug({ err: error, conversationId: this.#conversationId }, 'SSE 心跳帧写入失败')
    }
  }

  /**
   * 续期锁。
   *
   * `EXPIRE` 返回 0 = **锁已经不在了** ⇒ 说明我们的锁过期了（或被人删了）——
   * 此时必须中断本流：没有锁还继续写，就是和另一个流抢同一份历史（文件头 ③ 的最后一条）。
   * 这是"续期"这个动作的**第二个职责**，也是唯一能发现"锁悄悄丢了"的地方。
   */
  async #renewLock(): Promise<void> {
    if (this.#closed) return
    const redis = await ensureRedisConnected()
    const renewed = await redis.expire(chatActiveKey(this.#conversationId), lockTtlSec())
    if (renewed === 0) {
      getLogger().warn({ conversationId: this.#conversationId }, '活跃流锁已丢失（过期或已被清理），中断本次流')
      this.abort('lock-lost', LOCK_LOST_MESSAGE)
    }
  }

  /** 轮询停止信号（`02` §5.2：`/stop` 写键、编排循环检查） */
  async #pollStopSignal(): Promise<void> {
    if (this.#closed || this.#controller.signal.aborted) return
    try {
      const redis = await ensureRedisConnected()
      const signaled = await redis.exists(chatStopKey(this.#conversationId))
      if (signaled === 0) return
      getLogger().info({ conversationId: this.#conversationId }, '收到停止信号，正在中断本次生成')
      this.abort('user', '用户已停止生成')
    } catch (error) {
      getLogger().warn({ err: error, conversationId: this.#conversationId }, '读取停止信号失败（本轮跳过，下轮再试）')
    }
  }

  /**
   * 更新 `/active` 快照（读-合-写；**必须带 `EX`**，见 {@link updateActiveSnapshot}）。
   *
   * 这里只多一层 `#closed` 判断（流已收尾就不必再写了），其余逻辑全在模块级函数里
   * —— 那样验收脚本可以不经通道直接调同一段代码。
   */
  async updateSnapshot(patch: Partial<ConversationActiveSnapshot>): Promise<void> {
    if (this.#closed) return
    await updateActiveSnapshot(this.#conversationId, this.#startedAt, patch)
  }

  /** 把 `producer` 的返回值写成 `done` 帧 */
  async finish(result: ChatProducerResult): Promise<void> {
    await this.emit({
      name: 'done',
      data: { messageId: result.messageId, finishReason: result.finishReason, usage: result.usage },
    })
  }

  /**
   * 把异常写成 `error` 帧（**不抛**）。
   *
   * 三类输入的出口各不相同：
   *   · `AppError` 的 `message` 是为用户写的中文文案，可以出去；
   *   · `ChatStoppedError` 是**本层自己**抛的，唯一会走到这里的是 `lock-lost`
   *     （`user` / `client` 都走 `done`），它的 `message` 也是写给用户的 ⇒ 同样可以出去；
   *   · 其余错误（含堆栈、SQL、上游报文）只进日志，出口是通用文案（`02` §十）。
   */
  async fail(error: unknown): Promise<void> {
    const appError =
      error instanceof AppError
        ? error
        : error instanceof ChatStoppedError
          ? AppError.internal(error.message)
          : AppError.internal(DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL)

    if (error instanceof AppError || error instanceof ChatStoppedError) {
      getLogger().warn(
        { err: error, conversationId: this.#conversationId, code: appError.code },
        'SSE 流以 error 事件收尾',
      )
    } else {
      getLogger().error(
        { err: error, conversationId: this.#conversationId },
        'SSE 流内发生非预期错误（已收敛为 INTERNAL，原始错误见本行）',
      )
    }

    await this.emit({
      name: 'error',
      data: { code: appError.code, message: appError.message },
    })
  }

  /**
   * 收尾：清定时器 → 关连接。**幂等**（正常路径与异常路径都会调）。
   *
   * 顺序不能反：先清定时器（否则 `raw.end()` 之后心跳还会往里写，日志里刷一串 EPIPE），
   * 再 `end()`（向客户端表明"流结束"，让前端的读循环自然退出）。
   */
  dispose(): void {
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer)
    if (this.#stopTimer !== undefined) clearInterval(this.#stopTimer)
    this.#pingTimer = undefined
    this.#stopTimer = undefined
    this.#closed = true
    if (!this.#raw.writableEnded) this.#raw.end()
  }
}

// ═════════════════════════════════════════════════════════════════════
// 主入口：一条流的完整生命周期
// ═════════════════════════════════════════════════════════════════════

/** {@link streamChatReply} 的入参 */
export interface StreamChatReplyInput {
  reply: FastifyReply
  /** 会话与上游目标（由 `services/conversation.service.ts#assertConversationSendable` 产出） */
  conversationId: string
  agentId: string
  target: LlmTarget
  /** 编排循环（P0-1-27）；本批是占位实现，见 `orchestrator/index.ts` */
  producer: ChatProducer
}

/**
 * 用一条**只有 `error` 事件**的 SSE 响应回绝这次请求（见 `shared/src/sse.ts` 文件头 ③）。
 *
 * 为什么并发冲突走事件而不是 JSON 信封：`02` §4.5 / §5.2、`03` §五、`06` 的验收原文四处
 * 都写的是流内 `error{code: CONFLICT}`，且 `03` §五 给它配了"消息流内错误卡"。语义上
 * 它的**主语是"这一轮生成"**（客户端已经发起了对话），而 401/400/404/只读 409/424 的主语是
 * **"这个请求或目标"** —— 后者换任何客户端都该先被拦下，前者是对话区自己的事。
 *
 * ⚠️ 本函数**在 `reply.hijack()` 之后**，故内部绝不能让异常逃出去（逃出去的错误处理器
 * 拿不到这个已经被接管的响应，症状是请求悬挂）。故整段包 try/catch，失败只记日志。
 */
async function writeSseErrorReply(reply: FastifyReply, payload: SseErrorPayload): Promise<void> {
  try {
    reply.hijack()
    reply.raw.writeHead(200, SSE_RESPONSE_HEADERS)
    reply.raw.flushHeaders()
    reply.raw.write(serializeSseFrame({ name: 'error', data: payload }))
    reply.raw.end()
  } catch (error) {
    getLogger().warn({ err: error, code: payload.code }, '写 SSE 拒绝帧失败（连接可能已断开）')
  }
}

/**
 * 跑完一条 SSE 流（路由 handler 的唯一调用点）。
 *
 * 时序（每一步的位置都有理由）：
 * ```
 * ① 加锁（SET NX）            ← 失败 ⇒ `error{code:CONFLICT}` 事件收尾并 return（见 ①′）
 * ①′ （锁失败分支）hijack + 写头 + 只写一帧 error + end   ← `writeSseErrorReply`
 * ② clearStopSignal          ← 清掉上一轮的残留停止键
 * ③ reply.hijack() + 写头      ← 从这一刻起响应归我们管，Fastify 不再碰它
 * ④ flushHeaders             ← 必须立刻冲：占位 producer 要 20s 之后才有第一帧，
 *                              不冲头客户端的 fetch 就一直不 resolve（症状：前端以为请求没发出去）
 * ⑤ 起心跳 / 挂 close 监听
 * ⑥ await producer(...)      ← 编排循环
 * ⑦ 收尾帧（done / error）
 * ⑧ finally：清定时器 → 清停止键 → 释放锁（按归属）→ end()
 * ```
 * ⚠️ ③ 之后**绝不能抛**：`reply` 已 hijack，抛出去的错误处理器拿不到这个响应
 * （症状是请求悬挂 + 日志里一条"处理失败"）。故 ⑤ 之后的所有路径都包在 try/catch 里，
 * 而 ①′ 的收尾自带 try/catch（{@link writeSseErrorReply}）。
 *
 * 📌 日志的 requestId 为什么在流内也带得上：`app.ts` 的 `onRequest` 钩子用
 * `AsyncLocalStorage` 装了请求上下文，而本函数的定时器/回调都是在这个上下文里创建的
 * （ALS 会传播到其后创建的异步资源）⇒ 心跳与收尾日志天然与发起请求对齐（`02` §十三）。
 */
export async function streamChatReply(input: StreamChatReplyInput): Promise<void> {
  const { reply, conversationId, agentId, target, producer } = input
  const logger = getLogger()
  const startedAt = new Date().toISOString()

  // ① 会话互斥（`02` §5.2）。`streaming` 与锁是同一件事（`infra/redis.ts#chatActiveKey`）
  const locked = await acquireConversationLock(conversationId, {
    queuedPosition: null,
    currentTool: null,
    startedAt,
  })
  if (!locked) {
    // 被拒的这次**不进**下面的 finally（没拿锁就没什么可释放的），但必须走 SSE 事件收尾：
    // 见 {@link writeSseErrorReply} 的注释（`02` §5.2 / `03` §五 / `06` 验收原文都是 `error` 事件）
    logger.info({ conversationId, agentId }, '同会话已有流在跑，本次发送被拒（CONFLICT）')
    await writeSseErrorReply(reply, {
      code: 'CONFLICT',
      message: '该会话正在生成中，请等当前回答结束或先停止它',
    })
    return
  }

  let channel: SseChannel | undefined
  try {
    // ② 残留停止信号：两道防线里的第二道（第一道在 `/stop` 侧的 EXISTS，见 `signalStop`）
    await clearStopSignal(conversationId)

    // ③④ 接管响应
    reply.hijack()
    reply.raw.writeHead(200, SSE_RESPONSE_HEADERS)
    reply.raw.flushHeaders()

    channel = new SseChannel(reply.raw, conversationId, startedAt)
    channel.start()

    // ⑤ 客户端断开 = 流结束。**这一条是"锁不会漏"的关键**：没有它，用户关掉标签页之后
    //    这条流会一直跑（占着锁与上游连接）直到锁的 TTL 到期。
    //    ⚠️ 监听的是 **`reply.raw`（响应）而不是 `request.raw`（请求）**：请求体早已读完，
    //    请求流上的 `close` 语义（"请求已完成"）与"客户端还在不在"不是一回事。
    //    响应的 `close` 才是"这个连接没了"—— 这也是所有 SSE 库的通行做法。
    const onClientClose = (): void => {
      channel?.abort('client', '客户端已断开连接')
    }
    reply.raw.once('close', onClientClose)

    // 兜住响应流自身的 'error'：hijack 之后这条响应归我们管，而 Fastify 不会再给它挂任何
    // 错误处理 ⇒ 一旦有 'error' 事件没有监听器，Node 会把它当**未捕获异常**抛出去。
    // 最常见的来源就是"客户端已断开，心跳还在写"（`ERR_STREAM_DESTROYED` / EPIPE）。
    // 这里只记一条 debug：断线是正常现象，不该刷 error 日志，更不该影响进程。
    const onRawError = (error: Error): void => {
      logger.debug({ err: error, conversationId }, 'SSE 响应流报错（通常是客户端已断开）')
    }
    reply.raw.once('error', onRawError)

    logger.info(
      { conversationId, agentId, modelId: target.modelId, pingIntervalSec: config.limits.ssePingIntervalSec },
      'SSE 流已开始',
    )

    try {
      const result = await producer({
        conversationId,
        agentId,
        target,
        startedAt,
        signal: channel.signal,
        emit: (event) => channel?.emit(event) ?? Promise.resolve(),
        updateSnapshot: (patch) => channel?.updateSnapshot(patch) ?? Promise.resolve(),
      })
      // ⚠️ producer **正常返回**不等于"流正常结束"：锁在生成过程中丢掉时，producer 可能压根没察觉
      //    （占位实现就只是等 abort；真实的编排循环也可能把中断吞在某个 `catch` 里）。
      //    这种时候必须由**本层**改判成 `error` —— 否则会发出 `done{STOPPED}`，
      //    前端就把"服务端状态异常、什么都没生成"显示成"你点了停止"（`01` 决策 15 的反面）。
      //    重抛进下面的 catch，让"收尾怎么发"只有一个决策点。
      if (channel.stopReason === 'lock-lost') {
        throw new ChatStoppedError('lock-lost', LOCK_LOST_MESSAGE)
      }
      await channel.finish(result)
    } catch (error) {
      // 中断（用户停止 / 客户端断开 / 锁丢失）与故障在这里分开处理：前者是**正常收尾**
      // （`01` 决策 15：停止即中断，已生成内容保留），后者才是 `error` 帧
      const reason = channel.stopReason
      if (reason === 'lock-lost') {
        await channel.fail(error)
      } else if (reason !== undefined) {
        // producer 没接住中断时的兜底：`messageId: null` 的含义见 `shared/src/sse.ts` 文件头 ④
        logger.info(
          { conversationId, reason, frames: channel.frameCounts() },
          'SSE 流被中断收尾（producer 未接住中断，未产生落库消息）',
        )
        await channel.finish({ messageId: null, finishReason: 'STOPPED', usage: null })
      } else if (error instanceof LlmAbortError) {
        // 上游调用被中断，但本层没有记录到中断原因 ⇒ 说明是 producer 自己的 abort（如它自己
        // 换了信号）。按"停止"处理比按"故障"处理更接近事实：它不是上游故障
        await channel.finish({ messageId: null, finishReason: 'STOPPED', usage: null })
      } else {
        await channel.fail(error)
      }
    } finally {
      reply.raw.off('close', onClientClose)
      reply.raw.off('error', onRawError)
      channel.dispose()
      // ⚠️ 顺序：清停止键必须在**释放锁之前**（此刻锁还在我们手上 ⇒ 不可能有别的流在跑 ⇒
      //    这个键只可能是写给我们的）。挪到外层 finally 之后就可能和新流的 `/stop` 抢键 ——
      //    把新流刚拿到的停止信号删掉，症状是"点了停止但停不下来"。
      //    （另一侧"新流启动时也清一次"在 ② —— 两道防线各挡一种残留。）
      await clearStopSignal(conversationId)
      logger.info(
        {
          conversationId,
          agentId,
          stopReason: channel.stopReason ?? null,
          durationMs: Date.now() - Date.parse(startedAt),
          frames: channel.frameCounts(),
        },
        'SSE 流已结束',
      )
    }
  } finally {
    // ⑧ 释放锁：**按归属**（见文件头 ③）。失败只告警 —— 键有 TTL，最坏 3 个心跳周期后自愈，
    //    而在这里抛会让一个已经写完响应的请求再报一次错
    try {
      await releaseConversationLock(conversationId, startedAt)
    } catch (error) {
      logger.warn({ err: error, conversationId }, '活跃流锁释放失败（键会在 TTL 后自行过期）')
    }
  }
}
