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
 *   · 断线重连的**前端**逻辑（先查 `/active` 再拉历史）→ P0-1-32；本层只保证"断开即释放锁
 *     + `/active` 读得到进度"这两半。
 * ✅ `confirm` 挂起（{@link SseChannel#awaitConfirm}）与其应答端点（{@link answerConfirm} +
 *    `routes/conversations.ts` 的第九条路由）**已在 P0-2-10 落地** —— 从"刻意不做"一栏移出。
 * ✅ **跨请求提问原语**（活跃通道注册表 + {@link askConversation}）**已在 P0-3-6b 落地** ——
 *    它不是新功能，只是把上面那个挂起原语从"只有本层内部调得到"变成"**另一个 HTTP 请求**
 *    也调得到"，服务的是沙箱 MCP 代理（`子方案③` §七 的那条独立请求）。见文件后半那一节。
 */

import {
  appMsg,
  AppError,
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  EMPTY_ACTIVE_SNAPSHOT,
  SSE_CONTENT_TYPE,
  SSE_PAYLOAD_SCHEMAS,
  type ConfirmConversationResult,
  type ConfirmRequestBody,
  type ConfirmSource,
  type ConversationActiveSnapshot,
  type SseDonePayload,
  type SseErrorPayload,
  type SseEvent,
  type SseEventName,
} from '@doubulea/shared'
import type { FastifyReply } from 'fastify'
import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import {
  CHAT_AUTO_APPROVE_TTL_SEC,
  CHAT_CONFIRM_TTL_SEC,
  CHAT_STEER_TTL_SEC,
  CHAT_STOP_TTL_SEC,
  chatActiveKey,
  chatAutoApproveKey,
  chatConfirmKey,
  chatSteerKey,
  chatStopKey,
  ensureRedisConnected,
  getRedis,
} from '../infra/redis.js'
import { LlmAbortError, type LlmTarget } from '../llm/client.js'
import type { ChatAttachmentContext } from '../services/file.service.js'
import { closeRun, openRun, publishFrame } from './frameBus.js'

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
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
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

/**
 * 信号（停止 / 确认应答）的轮询间隔（毫秒）：心跳周期的 1/10，夹在 250ms–2s（见文件头 ④）。
 *
 * 两类信号共用同一个间隔、同一个量级 —— 它们的**时效要求完全一样**（都是"用户按了按钮之后
 * 多久生效"），分成两个常量只会在调一个的时候忘掉另一个。
 */
function signalPollIntervalMs(): number {
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

/**
 * 把中断信号翻成一个**带用户文案**的错误。
 *
 * 为什么需要它：`ChatStoppedError` 是 `SseChannel#fail` 唯一放行 `message` 的两个类型之一
 * （另一个是 `AppError`）—— 若在这里抛一个裸 `Error`，用户看到的会从
 * "用户已停止生成"退化成通用的"服务内部错误"（P0-1-26 全量回归抓过的同款问题）。
 * 正常路径下 `signal.reason` 一定是 `ChatStoppedError`（`abort()` 装配的）；
 * fallback 只为"运行时允许 `abort(undefined)`"这件事兜底。
 */
function abortErrorOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof ChatStoppedError ? reason : new ChatStoppedError('client', '本次生成已中断')
}

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

/**
 * 读停止信号（**不消费**）。给 **headless 运行**（`scheduledRun.ts`）轮询用：
 * `signalStop` 写入后，`SseChannel` 自己会轮询，而定时运行没有通道 ⇒ 由它自己按心跳节奏读，
 * 读到即中断。读不到时返回 `false`（Redis 抖动不该让"停止"误触发）。
 */
export async function readStopSignal(conversationId: string): Promise<boolean> {
  try {
    return (await getRedis().get(chatStopKey(conversationId))) !== null
  } catch {
    return false
  }
}

// ═════════════════════════════════════════════════════════════════════
// 中途插话（steer，P1-9 · P4 · R1）：路由/producer 写入、通道轮询消费
// ═════════════════════════════════════════════════════════════════════

/**
 * 一条插话信号（写进 `chat.steer:{id}` 列表的 JSON 形态）。
 *
 * `id` 由**入队时**生成（`randomUUID`）：前端乐观插入与出口层 `steer` 帧按它去重，
 * 取消端点也用它精确移除（2026-10-21）。
 */
export interface SteerSignalEntry {
  id: string
  message: string
  at: string
}

/** 取消哨兵：通道按 FIFO 取到它时，调 producer 的取消钩子（清空引擎插话队列） */
const STEER_CANCEL_TOKEN = JSON.stringify({ __cancel: true })

/**
 * 写一条插话信号，返回"是否确实有一个正在跑的流"与这条插话的 id。
 *
 * 调用方（路由）已经用 `/active` 判过一遍 `streaming`，这里再判一次 `EXISTS` 是**刻意的重复**
 * （与 {@link signalStop} 同一条理由）：键的消失只可能是"流刚结束"，那样写进去就是一条
 * **没人消费的残留**（`RPUSH` 后没人 `LPOP`，要等 TTL 才清）。
 */
export async function signalSteer(
  conversationId: string,
  message: string,
): Promise<{ accepted: boolean; steerId: string | null }> {
  const redis = await ensureRedisConnected()
  const exists = await redis.exists(chatActiveKey(conversationId))
  if (exists === 0) return { accepted: false, steerId: null }
  const key = chatSteerKey(conversationId)
  const entry: SteerSignalEntry = { id: randomUUID(), message, at: new Date().toISOString() }
  // 值放 JSON（id + message + 入队时刻）：`redis-cli LRANGE` 一眼能看出"谁在什么时候插的话"
  await redis.rpush(key, JSON.stringify(entry))
  // 每次入队都续期：列表活得比单条信号久，TTL 只兜"流死了、键没人清"
  await redis.expire(key, CHAT_STEER_TTL_SEC)
  return { accepted: true, steerId: entry.id }
}

/**
 * 撤回一条插话（2026-10-21）。返回撤回范围；`null` = 当前没有在跑的流（无可撤）。
 *
 * 两段式（顺序即正确性）：
 *   ① **还没被通道取走** ⇒ 在列表里按 id 找到原始行、`LREM` 精确移除（`'one'`）；
 *   ② **已被通道取走**（正在引擎的插话队列里）⇒ pi 只支持整体清空（`clear_queue`，没有"删指定一条"），
 *      所以推一个**取消哨兵**。列表是 FIFO ⇒ 哨兵一定排在所有更晚入队的插话之后，
 *      通道取到它时清空引擎队列，语义是"这些还没投递的插话都作废"（`'all'`）。
 *
 * ⚠️ 第 ③ 种结局"已经被模型读走"**无法从这一层判断**（引擎队列的真相在容器里）——
 * 前端据 `steer_queue` 快照把「取回编辑」收掉，只在"仍待接收"时才让人点。
 */
export async function signalSteerCancel(
  conversationId: string,
  steerId: string,
): Promise<'one' | 'all' | null> {
  const redis = await ensureRedisConnected()
  const exists = await redis.exists(chatActiveKey(conversationId))
  if (exists === 0) return null
  const key = chatSteerKey(conversationId)
  // ① 精确移除（尚在列表里 = 通道还没取走）
  const rows = await redis.lrange(key, 0, -1)
  for (const raw of rows) {
    const entry = parseSteerEntry(raw)
    if (entry === null || entry.id !== steerId) continue
    // `LREM` 的返回值是"真的删掉几条"：0 = LRANGE 之后被通道取走了 ⇒ 落到 ② 的清队列
    const removed = await redis.lrem(key, 1, raw)
    if (removed > 0) return 'one'
    break
  }
  // ② 已交给引擎：推取消哨兵，由通道按顺序清空引擎插话队列
  await redis.rpush(key, STEER_CANCEL_TOKEN)
  await redis.expire(key, CHAT_STEER_TTL_SEC)
  return 'all'
}

/**
 * 清掉插话信号键。**与停止信号同款的两个调用点**：
 *   · **新流启动时**（`streamChatReply` ②）：防上一轮残留的插话被这一轮读到（症状同"秒停"）；
 *   · **本条流收尾时**（finally，且在释放锁**之前**）。
 */
export async function clearSteerSignal(conversationId: string): Promise<void> {
  try {
    await getRedis().del(chatSteerKey(conversationId))
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '清除插话信号失败（残留会在 TTL 后自愈）')
  }
}

/**
 * 一次轮询取到的条目（2026-10-21）：**保持 FIFO 顺序**。
 *
 * ⚠️ 顺序有意义，不能拆成"先撤全部、再投全部"两趟：
 *   · `[插话 A, 取消]` ⇒ 必须"先投 A、再清队列"（A 也被撤掉）—— 反了就变成 A 被清后又投回去；
 *   · `[取消, 插话 B]` ⇒ 必须"先清、再投 B"（B 是撤回之后新插的）—— 反了 B 会被一起清掉。
 */
export type SteerDrainItem = { kind: 'steer'; entry: SteerSignalEntry } | { kind: 'cancel' }

/**
 * 取走该会话**当前积压**的全部插话与取消信号（`LPOP` 到空，保留原顺序）。
 *
 * ⚠️ **只在"有 steer 监听器"时调用**（见 {@link SseChannel} 的 `#pollSteering`）—— 没有消费者时
 * 消息要留在列表里，否则"流还没接上 steer"这段窗口里的插话会被白白取走丢掉。
 * 解析失败（值坏）**跳过该条**（不抛错）：坏值不该让整轮插话失效。
 */
export async function drainSteerSignals(conversationId: string): Promise<SteerDrainItem[]> {
  const redis = await ensureRedisConnected()
  const key = chatSteerKey(conversationId)
  const items: SteerDrainItem[] = []
  // 有上界：一次最多取 50 条，防止"有人刷了一万条"在一帧里全投进引擎
  for (let i = 0; i < 50; i += 1) {
    const raw = await redis.lpop(key)
    if (raw === null) break
    if (raw === STEER_CANCEL_TOKEN) {
      items.push({ kind: 'cancel' })
      continue
    }
    const entry = parseSteerEntry(raw)
    if (entry !== null) items.push({ kind: 'steer', entry })
  }
  return items
}

/**
 * 解析一条插话信号（**不抛错**：坏值返回 `null`，调用方跳过）。
 *
 * `id` 缺失时用 `at#message` 合成一个确定性标识（旧版写入的残留值 / 手工塞的测试值）——
 * 宁可给一个合成 id，也不要丢掉用户说过的话。
 */
function parseSteerEntry(raw: string): SteerSignalEntry | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { id?: unknown; message?: unknown; at?: unknown }
    const message = record.message
    if (typeof message !== 'string' || message.trim() === '') return null
    const at = typeof record.at === 'string' ? record.at : new Date().toISOString()
    const id =
      typeof record.id === 'string' && record.id !== '' ? record.id : `${at}#${message}`
    return { id, message, at }
  } catch {
    return null
  }
}

// ═════════════════════════════════════════════════════════════════════
// 确认应答（`chat.confirm:{id}`）：路由写入、通道等待（P0-2-10）
// ═════════════════════════════════════════════════════════════════════

/**
 * 一次确认提问 —— **两条来源共用的形状**（`shared/src/sse.ts#CONFIRM_SOURCES`）。
 *
 * `source` 决定前端选哪句说明文案（"这个工具需要确认" / "对方要求确认"），
 * 而**挂起与应答的机制完全相同**：这正是 `06` P0-2-10 坑预判 1 要的"一个共同的挂起原语"
 * —— 不为 elicitation 单开一套（那会让第二个来源只能"验一半"，`mcp/client.ts` 里那个
 * `onElicit` 开关也就白留了）。
 */
export interface ConfirmQuestion {
  source: ConfirmSource
  /** 提问是关于哪个工具的（`PLATFORM` 是下发给模型的名字，`SERVER` 是正在执行的那个） */
  toolName: string
  /** 给用户看的一句话（`PLATFORM` 是参数摘要，`SERVER` 是服务端给的消息原文） */
  inputSummary: string
  /**
   * 这次问的是**重复执行**（本轮同名同参的危险工具已经成功执行过一次）。
   * 只影响前端措辞与 `confirm` 帧里的标记；挂起与应答机制完全相同（见 {@link ConfirmQuestion}）。
   */
  duplicate?: boolean
}

/**
 * 等待的三种结局。
 *
 * ⚠️ **三条都通向"不执行这个工具"**，但它们**必须分得开**：回填给模型的那句话里，
 * "用户已取消"与"等待确认超时"是两件不同的事 —— 前者是用户的决定（模型不该再劝），
 * 后者是没人应答（模型可以说"这次没能执行"）。合成一种会让用户在界面上读不出
 * 自己刚才那一按到底生效了没有。
 *
 * ⚠️ **中断不在这里**（用户点停止 / 客户端断开 / 锁丢失）：那三种是 `awaitConfirm`
 * **抛出** `ChatStoppedError`（`signal.reason`），由 `streamChatReply` 按"本轮被中断"收尾 ——
 * 它们不是"确认的结局"，而是"这一轮结束了"。
 */
export type ConfirmDecision = 'CONFIRMED' | 'REJECTED' | 'TIMEOUT'

/** 应答槽里的值（见 `infra/redis.ts#chatConfirmKey`） */
interface ConfirmAnswer {
  confirmId: string
  accepted: boolean
}

/**
 * 解析应答槽的值。**不抛错**（与 `readStartedAt` / `parseActiveSnapshot` 同款）：
 * 值坏（人工改过 / 旧格式）⇒ `null` ⇒ 消费方按"还没答"处理，下一轮再试；
 * 而"值坏"这件事值得留痕 —— 它会表现为"用户点了确认但一直等到超时"。
 */
function parseConfirmAnswer(raw: string): ConfirmAnswer | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { confirmId, accepted } = parsed as Partial<ConfirmAnswer>
    if (typeof confirmId !== 'string' || confirmId === '') return null
    if (typeof accepted !== 'boolean') return null
    return { confirmId, accepted }
  } catch {
    return null
  }
}

/**
 * 清应答槽。**两个调用点**（与 `clearStopSignal` 同款，但语义更硬）：
 *   · **新一次等待开始前**：上一轮的答案、或上一轮 `/confirm` 的**迟到点击**，
 *     绝不能被这一次等待消费掉 —— 否则症状是"确认卡一闪而过"（`06` P0-2-10 坑预判 2，
 *     本步最容易出的静默 bug）；
 *   · **本次等待结束时**（`awaitConfirm` 的 `finally`，含超时与中断）：不清的话这个键要挂 60s，
 *     而 `/active` 的 `pendingConfirmId` 已经回 `null` ⇒ 那两个出口就开始互相矛盾。
 *
 * 失败只告警：清不掉最多是"这次等待被一条残留应答提前结束"（用户重发一次即可），
 * 而抛出去会让一次**已经成功**的确认变成 500。
 */
export async function clearConfirmSignal(conversationId: string): Promise<void> {
  try {
    await getRedis().del(chatConfirmKey(conversationId))
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '清除确认应答失败（本次等待可能被残留应答提前结束）')
  }
}

/**
 * 写一条确认应答（`POST /api/conversations/:id/confirm` 的落点）。
 *
 * ── 为什么第二参是"调用方刚读到的 `pendingConfirmId`"，而不是本函数自己再读一次 ──
 * 那个值只有一个合法来源：`GET /:id/active`（它同时承担"这不是我的会话就 404"的判据）。
 * 让本函数再读一遍就是**同一次请求读两遍**，而两遍之间可能变化（确认刚好超时）⇒
 * 判据会变成"两次读里较新/较旧的那一次"，这种不确定性没有任何好处。
 * ⚠️ 残留的 TOCTOU 是**已知且无害**的：两读之间确认刚好结束 ⇒ 我们往一个没人消费的槽位写
 * 一条应答，`applied` 略微乐观；那条键会在下一次 `awaitConfirm` 的 ① 里被清掉。
 *
 * ── `applied:false`（幂等忽略）覆盖的全部情形 ──
 *   · 这个会话当前没有活跃流（`streaming:false` ⇒ 一定没有待答确认）；
 *   · 有流、但当前没有待答确认（`pendingConfirmId === null`）—— 最常见的是"这一轮已经按超时
 *     取消走完了"，用户此刻才点；
 *   · `confirmId` 对不上（上一轮卡片的迟到点击、或用户开着两个标签页）。
 * 三种都是**正常终局**，故回 200 + `applied:false`（理由见 `confirmConversationResultSchema`）。
 *
 * ⚠️ 刻意**不**为"会话只读（Agent 被软删）"单开一个 409（`06` P0-2-10 门槛 4 的原文）：
 * 会话只读**必定**没有活跃流 ⇒ 它已经被第一条覆盖，结论完全一样；而为它单开一个分支会让
 * "Agent 在流中途被软删、用户正在看确认卡"这一路拿到一个**错误**的 409（那时流还在跑、
 * 确认是有效的）。所以判据只有一条：**有没有人在等这个 id**。
 *
 * @param pendingConfirmId 调用方刚从 `/active` 读到的 `pendingConfirmId`（唯一判据来源）
 * @throws {AppError} `INTERNAL`(500) Redis 写失败 —— 这一条**不能**吞：用户点的是"执行"，
 *   我们告诉他"已确认"而信号其实没写进去，等于把一次破坏性操作的失败说成成功。
 */
export async function answerConfirm(
  conversationId: string,
  input: ConfirmRequestBody,
  pendingConfirmId: string | null,
): Promise<ConfirmConversationResult> {
  const result: ConfirmConversationResult = {
    id: conversationId,
    confirmId: input.confirmId,
    accepted: input.accepted,
    applied: false,
  }
  if (pendingConfirmId === null || pendingConfirmId !== input.confirmId) {
    getLogger().info(
      { conversationId, confirmId: input.confirmId, pendingConfirmId, accepted: input.accepted },
      '确认应答不属于当前提问 ⇒ 幂等忽略（这一轮可能已按取消/超时走完）',
    )
    return result
  }

  const redis = await ensureRedisConnected()
  await redis.set(
    chatConfirmKey(conversationId),
    JSON.stringify({ confirmId: input.confirmId, accepted: input.accepted } satisfies ConfirmAnswer),
    'EX',
    CHAT_CONFIRM_TTL_SEC,
  )
  getLogger().info(
    { conversationId, confirmId: input.confirmId, accepted: input.accepted },
    '确认应答已交给等待中的那一轮',
  )
  return { ...result, applied: true }
}

// ═════════════════════════════════════════════════════════════════════
// 会话级自动审批开关（`chat.autoapprove:{id}`）
// ═════════════════════════════════════════════════════════════════════

/**
 * 读会话的自动审批开关。**永不抛错**：值坏 / Redis 读失败一律按 `false`（关）返回。
 *
 * 为什么失败要退回"关"而不是向上抛：本函数的调用点在 {@link SseChannel.awaitConfirm} 里，
 * 而那里是"这一轮能不能继续跑下去"的必经之路 —— Redis 抖一下就让一次工具调用失败（甚至
 * 让整轮报错）是不可接受的。代价只是"这次多问用户一句"，而**危险工具的默认口径本来就是"要问"**。
 */
export async function readAutoApprove(conversationId: string): Promise<boolean> {
  try {
    const redis = await ensureRedisConnected()
    // 只认 `'1'`：与 `infra/redis.ts#chatAutoApproveKey` 的注释一致（键不存在 = 关）
    return (await redis.get(chatAutoApproveKey(conversationId))) === '1'
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '读取自动审批开关失败（按关闭处理）')
    return false
  }
}

/**
 * 写会话的自动审批开关（`POST /api/conversations/:id/auto-approve` 的落点）。
 *
 * `enabled=false` 走 `DEL`（而不是写 `'0'`）：**键的存在与否**是唯一判据，写 `'0'` 会让
 * `redis-cli KEYS chat.autoapprove:*` 里躺着一条"看着像开着、其实是关"的键。
 *
 * @throws {AppError} Redis 写失败——**向上抛**：用户点了"打开自动审批"，我们却告诉他"已打开"
 *   而键其实没写进去，等于把一次会放行破坏性操作的模式开关说成成功（与 `answerConfirm` 同款）。
 */
export async function setAutoApprove(conversationId: string, enabled: boolean): Promise<void> {
  const redis = await ensureRedisConnected()
  if (enabled) {
    await redis.set(chatAutoApproveKey(conversationId), '1', 'EX', CHAT_AUTO_APPROVE_TTL_SEC)
  } else {
    await redis.del(chatAutoApproveKey(conversationId))
  }
  getLogger().info({ conversationId, enabled }, '会话自动审批开关已更新')
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

/**
 * 从中断信号里读回"为什么中断"。
 *
 * ★ **两个编排器都要它**（P0-3-6 从 `chatBot.ts` 的私有函数升到这里）：
 * `chatBot.ts`（ChatBot）与 `taskAgent.ts`（TaskAgent）在收尾时都要做同一个判断 ——
 * **`lock-lost` 不能落库**（那时这个会话可能已经有**另一个流**在写历史，我们再写一次就是
 * 两边往同一份历史里插消息），而 `user` / `client` 要落库（`01` 决策 15「停止即中断，
 * **已生成内容保留**」—— 保留的前提就是落库，否则刷新之后用户看到的是"我停了一下，问题没了"）。
 * 判据必须**只有一处来源**（`docs/06` §六 第 ⑰ 条），故它不该在两个编排器里各写一遍。
 *
 * `signal.reason` 是 `abort(reason)` 塞进去的那个对象（见 {@link SseChannel.abort}），
 * 它可能是任何东西（运行时允许 `abort(undefined)`）⇒ 这里只认 {@link ChatStoppedError}，
 * 其余一律当作"不知道原因"。
 */
export function abortReasonOf(signal: AbortSignal): ChatStopReason | undefined {
  const reason: unknown = signal.reason
  return reason instanceof ChatStoppedError ? reason.reason : undefined
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
 * 四个成员各有明确用途，**都不是便利方法**：
 *   · `emit` —— 写一帧（带 schema 校验与背压等待，见文件头 ①）。**已结束/客户端断开后静默丢弃**：
 *     producer 收尾时不必自己判断"还能不能写"。
 *   · `signal` —— 中断信号。必须传给它发起的每一次上游调用（`chatStream` 的 `abortSignal`），
 *     否则点"停止"只会停止我方的循环、上游连接还挂着（P0-1-12 的教训：中断要在每帧之前显式生效）。
 *   · `updateSnapshot` —— 更新 `/active` 快照（`currentTool` / `queuedPosition` / `pendingConfirmId`）。
 *     断线重连的用户就是靠它知道"现在在干什么"（`02` §5.2）。
 *   · `awaitConfirm` —— **挂起等用户应答**（P0-2-10，见其注释）。它与前三个的区别是它**会等**：
 *     前三个都是"发出去就返回"，它是唯一会占住这一轮的地方。
 */
export interface ChatProducerInput {
  conversationId: string
  agentId: string
  /**
   * 本轮由**哪把开放平台 Key** 发起（**P1-22**）：`undefined` = 内部界面。
   *
   * 只用于计量归属（`usage_records.channel/open_key_id`，X1）—— **不是**权限判据。
   * 由出口层从 `StreamChatReplyInput#openKeyId` 原样转交，编排层一个分支都不用加。
   */
  openKeyId?: string
  /**
   * 本轮用户消息的正文（**已 trim**）—— 来自请求体（`shared` 的 `chatRequestBodySchema`）。
   *
   * 为什么由出口层转交、而不是让编排层回头查库：这条消息**此刻还没落库**
   * （落库发生在 `done`，见 `02` §5.2"事件即真相"），而它同时是"检索的 query"与
   * "落库时用户消息的正文"（P0-1-27 的编排循环两处都要用）。
   */
  content: string
  /**
   * 本轮附件（**P1-4**；已归属校验 + 已解析，见 `services/file.service.ts#ChatAttachmentContext`）。
   * 空数组 = 没有附件。编排层只用它两件事：拼本轮用户消息的报文、随用户消息落库 `content.attachments`。
   */
  attachments: readonly ChatAttachmentContext[]
  /** 已解析的上游目标（含明文 Key ⇒ 只进内存，日志用 `describeTarget`） */
  target: LlmTarget
  /** 本次流的开始时刻（ISO 8601）—— 同时也是锁的归属标识（见文件头 ③） */
  startedAt: string
  signal: AbortSignal
  emit: (event: SseEvent) => Promise<void>
  updateSnapshot: (patch: Partial<ConversationActiveSnapshot>) => Promise<void>
  /**
   * 挂起并等待用户对一次确认的应答（P0-2-10；`02` §9.10、`shared#sseConfirmPayloadSchema`）。
   *
   * **编排层唯一该调它的地方**是"真的要动那个危险工具之前"（`chatBot.ts` 工具循环里
   * 取凭据 / 发 `RUNNING` 卡**之前**那一处）—— 晚一步的后果是"确认卡上已经写着『运行中』"，
   * 而确认的全部意义就是"发出去之前问一句"。
   *
   * 四条实现约定（都由通道保证，调用方不必自己处理）：
   *   · **超时按取消**：`MCP_CONFIRM_TIMEOUT_SEC`（默认 120s）到点返回 `'TIMEOUT'`
   *     —— 不抛错（超时是一条**正常结论**，见 `ConfirmDecision`）；
   *   · **中断抛出**：用户点停止 / 客户端断开 / 锁丢失 ⇒ 抛 `signal.reason`（一个
   *     `ChatStoppedError`）⇒ 由 `streamChatReply` 按"本轮被中断"收尾。
   *     ⚠️ 这条是**必须**的：挂起期间停止按钮不能失效（`06` P0-2-10 坑预判 5）；
   *   · **挂起期间心跳与锁照常**：心跳是无条件周期、锁跟着心跳续期（文件头 ②③），
   *     所以"挂起是安全的"这件事不需要本方法做额外的续期 —— 门槛 5 那两条是**既有机制**的推论；
   *   · **幂等前提**：同一时刻一条流只该有一个待答确认（工具是顺序执行的）。并发调用
   *     （一轮里并行问两次）会让后一个覆盖前一个的 `pendingConfirmId`，前一个只能等到超时
   *     —— 不是被允许，而是当前编排层**不会**这么调。
   *     ⚠️ 沙箱代理**也从同一条槽**问（P0-3-9b）⇒ "同一时刻只有一个待答确认"这条前提
   *     对它同样有效（那里用"危险调用串行化"保证，见 `子方案③` §七 6）。
   *
   * 📌 另一条调用路径是 {@link askConversation}（**跨请求**，P0-3-6b）—— 两条路径进的是
   * **同一个**挂起与应答机制（`chat.confirm:{id}` 单槽 + `/confirm` 应答），这正是 P0-2-10
   * 要的"一个共同的挂起原语"。
   */
  awaitConfirm: (question: ConfirmQuestion) => Promise<ConfirmDecision>
  /**
   * 注册一个"运行中收到插话（steer）"的监听器（**P1-9 · P4 · R1**）。返回退订函数。
   *
   * 与 {@link ChatProducerInput.awaitConfirm} 的关系：那个是"编排层**主动挂起**等用户答一次"，
   * 这个是"用户（或工作区 watcher）**主动**塞一句话进来、编排层在合适时机转投给引擎"。
   * 通道负责轮询 Redis 与派发；producer 只负责"收到这句话之后怎么处理"
   * （TaskAgent = 投给 pi 的 `steer` 命令，落到**助手 turn 边界**）。
   *
   * ⚠️ **没有监听器时消息不消费**（留在 Redis 列表里）：这正是"桥还没建好就有人插话"
   * 不丢消息的机制（见 `drainSteerSignals`）。注册必须**早于派活**，否则那之前的插话要等到
   * 下一帧轮询才派发。
   * ⚠️ 回调是**同步**的（与 `emit` 的异步不同）：producer 自己决定要不要 `await`
   * （TaskAgent 用 `void bridge.steer(...)` 尽力而为 —— 投不进去只记日志，不中断这一轮）。
   */
  onSteer: (listener: (entry: SteerSignalEntry) => void) => () => void
  /**
   * 注册一个"**撤回插话**"的监听器（2026-10-21）。返回退订函数。
   *
   * 触发路径 = `POST /:id/steer/cancel` → 列表里出现取消哨兵 → 通道轮询取到 → 本钩子。
   * producer 侧语义：**清空引擎侧还没投递的插话队列**（pi `clear_queue`；ChatBot = 清空 `steerInbox`），
   * 并把"还没投递的插话"从本轮待落库的清单里摘掉（它们既没进模型上下文、也不该留在历史里）。
   * ⚠️ 已经被模型读走的插话**撤不回来**（引擎不支持回滚已投递的消息）—— 那时前端已经不显示「取回」。
   */
  onSteerCancel: (listener: () => void) => () => void
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
  /**
   * 中途插话（steer）的监听器（P1-9 · P4 · R1）。由 producer 通过
   * {@link ChatProducerInput.onSteer} 注册（TaskAgent 把它转投给引擎）。
   * **空集合 = 没人消费** ⇒ {@link #pollSteering} 不 `LPOP`（消息留在 Redis 列表里，见其注释）。
   */
  readonly #steerListeners = new Set<(entry: SteerSignalEntry) => void>()
  /** 撤回插话的监听器（2026-10-21）；与 {@link #steerListeners} 同一条"没人消费就不取"的纪律 */
  readonly #steerCancelListeners = new Set<() => void>()

  /** 本轮确认卡的超时（秒，P1-22）：来自 `StreamChatReplyInput#confirmTimeoutSec`，缺省走全局配置 */
  readonly #confirmTimeoutSec: number

  constructor(raw: ServerResponse, conversationId: string, startedAt: string, confirmTimeoutSec?: number) {
    this.#raw = raw
    this.#conversationId = conversationId
    this.#startedAt = startedAt
    this.#confirmTimeoutSec = confirmTimeoutSec ?? config.mcp.confirmTimeoutSec
    this.#controller = new AbortController()
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /**
   * 这个通道是哪个会话的。
   *
   * 为什么要开这个口（而不是让注册表自己记一份 id）：活跃通道表是
   * `Map<conversationId, SseChannel>`，键与"通道自己认的会话"**必须是同一个值** ——
   * 两处各记一份，`askConversation` 就会把提问投给"另一个会话的流"
   * （症状是确认卡出现在错误的对话里，而两边都不会报错）。
   */
  get conversationId(): string {
    return this.#conversationId
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
   * 注册中途插话（steer）监听器（P1-9 · P4 · R1）。返回退订函数。
   *
   * 一经注册，{@link #pollSteering} 就会在每次轮询把积压的插话派发过来。producer 在
   * 收尾的 `finally` 里必须退订（与 {@link SandboxRpc.onEvent} 同款纪律：桥/通道活得比一轮久）。
   */
  onSteer(listener: (entry: SteerSignalEntry) => void): () => void {
    this.#steerListeners.add(listener)
    return () => {
      this.#steerListeners.delete(listener)
    }
  }

  /**
   * 注册"撤回插话"监听器（2026-10-21）。返回退订函数；收尾的 `finally` 里必须退订（同款纪律）。
   */
  onSteerCancel(listener: () => void): () => void {
    this.#steerCancelListeners.add(listener)
    return () => {
      this.#steerCancelListeners.delete(listener)
    }
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
   *   ② 已关闭（客户端断开 / 流已收尾）时**不再写这条连接**（静默丢弃、不抛：producer 收尾时的
   *      收尾帧不该让它失败）—— 但**仍然广播给观察者**（帧总线与这条连接无关，见下面 ⚠️）；
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
        appMsg('app.m279', {
          p0: event.name,
          p1: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；'),
        }),
        { event: event.name },
      )
    }

    // 广播给"订阅了这个会话的观察者"（P1-6 方案 A：后台/他处运行可被实时看到）。
    //
    // ⚠️ **必须在 `#closed` 判断之前**：本连接断开（用户刷新 / 关页）时这条流会被
    //    `abort('client')` ⇒ `#closed = true`，但这一轮**仍会收尾**（落库 + `done`/`error`）。
    //    观察者（另一个连接 / **刷新后的新页面**）正是靠这条**终帧**才知道"该拉历史对齐了"
    //    （`useConversationWatch` 只在 `done`/`error` 上重取落库历史并清掉观察轮次）。
    //    少了它，刷新后的页面会停在观察轮次上、永远不重取 ⇒ 落库的那一轮在界面上"消失"，
    //    切走再切回（换了 query key、重新拉历史）才回来。
    //    `publishFrame` 只进进程内总线、与 `#raw` 无关 ⇒ 与"能不能写回这条连接"解耦。
    publishFrame(this.conversationId, event)

    // 连接已经没了 ⇒ 静默丢弃**写**，不要再尝试写（`write()` 在已销毁的 socket 上会异步抛
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
      // 中途插话（P1-9 · P4 · R1）与停止信号**共用同一个节拍**（`signalPollIntervalMs` 的注释
      // 说"两类信号时效要求完全一样"，插话是第三类，同一条推理）。
      void this.#pollSteering()
    }, signalPollIntervalMs())
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
   * 轮询中途插话（steer）并派发给监听器（P1-9 · P4 · R1）。
   *
   * 三条判据：
   *   · **没有监听器 ⇒ 不消费**（`drainSteerSignals` 不调）：消息留在列表里等着被接上
   *     —— 这是"桥还没建好就有人插话"不丢消息的机制；
   *   · **流已收尾 / 被中断 ⇒ 不消费**：收尾路径会清掉那个键，这里再判一次，避免在
   *     "清键"与"下一次轮询"之间把一条本该丢弃的插话读出来；
   *   · 单个监听器抛错**只忽略该监听器本次回调**（与 `emit` 的订阅者同款）——
   *     producer 的 bug 不该把通道带走。
   */
  async #pollSteering(): Promise<void> {
    if (this.#closed || this.#controller.signal.aborted) return
    if (this.#steerListeners.size === 0) return
    let items: SteerDrainItem[]
    try {
      items = await drainSteerSignals(this.#conversationId)
    } catch (error) {
      getLogger().warn({ err: error, conversationId: this.#conversationId }, '读取插话信号失败（本轮跳过，下轮再试）')
      return
    }
    if (items.length === 0) return
    // ⚠️ 严格按 FIFO 顺序处理（见 `SteerDrainItem` 的注释：先撤后投 / 先投后撤语义完全不同）
    for (const item of items) {
      if (item.kind === 'cancel') {
        getLogger().info(
          { conversationId: this.#conversationId },
          '收到插话撤回信号，转交给本轮编排（清空引擎插话队列）',
        )
        for (const listener of [...this.#steerCancelListeners]) {
          try {
            listener()
          } catch (error) {
            getLogger().warn(
              { err: error, conversationId: this.#conversationId },
              '插话撤回监听器抛错（只忽略该监听器本次回调）',
            )
          }
        }
        continue
      }
      const { entry } = item
      getLogger().info(
        { conversationId: this.#conversationId, steerId: entry.id },
        '收到中途插话，转交给本轮编排（投给运行中的引擎）',
      )
      // ★ 先让界面**看得见**这条插话（P1-20，产品反馈："发出去了但聊天界面上看不到，像丢消息"）：
      //   发一帧 `steer`（进本连接 SSE 流 + 帧总线），前端在消息流里补一条用户气泡；
      //   **再**派发给编排层（TaskAgent 投引擎 / ChatBot 在下一次上游调用前注入）。
      //   ⚠️ 顺序是刻意的：先发帧，即便随后的投递失败（尽力而为），用户也已经看到"我插了这句话"。
      //   `id` / `at` 用**入队时**那一份（早先 `at` 取的是派发时刻，比真实插话时间晚一个轮询周期）。
      try {
        await this.emit({ name: 'steer', data: { id: entry.id, message: entry.message, at: entry.at } })
      } catch (error) {
        getLogger().warn({ err: error, conversationId: this.#conversationId }, '插话事件发帧失败（不影响投递）')
      }
      for (const listener of [...this.#steerListeners]) {
        try {
          listener(entry)
        } catch (error) {
          getLogger().warn(
            { err: error, conversationId: this.#conversationId },
            '中途插话监听器抛错（只忽略该监听器本次回调）',
          )
        }
      }
    }
  }

  /**
   * 挂起并等待用户对一次确认的应答（P0-2-10 的核心，`02` §9.10）。
   *
   * 时序（每一步的顺序都是正确性）：
   * ```
   * ① 清应答槽        ← 上一轮的答案 / 迟到点击绝不能被本轮消费（坑预判 2）
   * ② 登记 pendingConfirmId  ← 必须早于 ③：反过来的话，用户在事件到达的一瞬间点确认会拿到
   *                           `applied:false`（槽位里还是旧的 `null`）
   * ③ 发 `confirm` 帧  ← 前端据此弹卡（带 `expiresAt`，倒计时读它）
   * ④ 轮询应答槽（受 signal 与超时约束）
   * ⑤ finally：清应答槽 + `pendingConfirmId` 回 null  ← 不管什么结局都要清
   *    （不清 ⇒ `/active` 一直说"有确认待答"，而 `/confirm` 会继续接受一个已经不存在的提问）
   * ```
   *
   * ⚠️ **`confirmId` 用 `randomUUID()`（v4）**：本仓"别手搓 uuid7"那条纪律针对的是**主键**
   * （`@default(uuid(7))` 是它唯一合法的来源）；这里要的是一个**一次性、不可预测**的标识，
   * v4 正是普通 `randomUUID()` 的用途（同 S3 键的做法），不存在版本位语义。
   *
   * ⚠️ **等待期间不做任何"续期"动作**：心跳是无条件周期、锁跟着心跳续期（文件头 ②③）
   * ⇒ 挂起时 `ping` 照发、锁不丢（`06` P0-2-10 门槛 5 的两条**都是既有机制的推论**）。
   * 若在这里另起一个续期，就会造出第二条续期路径（迟早与心跳那条打架）。
   */
  async awaitConfirm(question: ConfirmQuestion): Promise<ConfirmDecision> {
    /**
     * 会话级自动审批（`chat.autoapprove:{id}`）：开了就直接按"已确认"返回，**不登记
     * `pendingConfirmId`、不发 `confirm` 帧、不挂起**。于是前端根本看不到确认卡，工具直接执行。
     *
     * ⚠️ 它对本函数的两条来源（`PLATFORM` 危险判定 / `SERVER` elicitation）**一视同仁** ——
     * "本会话不再逐次确认"就是这个开关的语义，不该只放行其中一条。
     * ⚠️ **中断优先**：信号已中止时不放行，抛 `ChatStoppedError` 交给收尾（否则"点了停止
     * 却还把破坏性工具跑完"）。判据与 {@link #waitForConfirm} 的 ① 同款。
     * ⚠️ 读开关**每次调用都读**（而不是开流时快照一次）⇒ 用户中途打开/关闭能立刻生效。
     */
    if (await readAutoApprove(this.#conversationId)) {
      if (this.#controller.signal.aborted) throw abortErrorOf(this.#controller.signal)
      getLogger().info(
        {
          conversationId: this.#conversationId,
          source: question.source,
          toolName: question.toolName,
        },
        '会话已开启自动审批 ⇒ 跳过确认卡，直接放行',
      )
      return 'CONFIRMED'
    }

    await clearConfirmSignal(this.#conversationId)

    const confirmId = randomUUID()
    // P1-22：本轮的超时（Key 可覆盖）；`#waitForConfirm` 与日志共用这一个值
    const timeoutMs = this.#confirmTimeoutSec * 1000
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString()

    // 见 ②：登记在发帧**之前**
    await this.updateSnapshot({ pendingConfirmId: confirmId })
    /**
     * 本次提问的**终局**（见 `finally` 里的 `confirm_resolved`）：三处退出点都只写这一个变量，
     * 于是"发终局帧"只有一处实现 —— 少一处就少一种"卡不消失"的路径。
     */
    let decision: ConfirmDecision | 'ABORTED' = 'ABORTED'
    try {
      await this.emit({
        name: 'confirm',
        data: {
          confirmId,
          source: question.source,
          toolName: question.toolName,
          inputSummary: question.inputSummary,
          expiresAt,
          ...(question.duplicate === true ? { duplicate: true } : {}),
        },
      })
      getLogger().info(
        {
          conversationId: this.#conversationId,
          confirmId,
          source: question.source,
          toolName: question.toolName,
          timeoutSec: this.#confirmTimeoutSec,
        },
        '已发出确认请求（本轮挂起等待应答）',
      )
      decision = await this.#waitForConfirm(confirmId, timeoutMs)
      return decision
    } finally {
      /**
       * ⑥ **通知前端这次提问结束了**（2026-10-22）：`confirm` 帧只是"开始提问"，而结束可能
       * 由**别人**触发（第三方代理替用户点了 `/confirm`）、或超时/中断 —— 早先前端只在
       * "自己点过"之后才撤卡，于是对方确认后我们这边工具都跑完了、确认卡还挂在输入区
       * （它还锁着输入）直到整轮流结束。
       * ⚠️ 放在 `finally` 且**先于**清快照：即使这一轮因为中断在抛错，前端也该先收到"卡作废"。
       * ⚠️ 发帧失败**不掩盖**原结论（`emit` 的失败由出口层统一处理，这里不让它改变 decision）。
       */
      try {
        await this.emit({ name: 'confirm_resolved', data: { confirmId, decision } })
      } catch {
        // 流已断（用户关页 / 客户端断开）：没有接收方，忽略
      }
      // 见 ⑤：结局无论如何都要把"待答"清干净（`updateSnapshot` 在流已收尾时会自己短路）
      await clearConfirmSignal(this.#conversationId)
      await this.updateSnapshot({ pendingConfirmId: null })
    }
  }

  /**
   * 轮询应答槽，直到"有人答了"或"到点"或"被中断"。
   *
   * 三条判据的**顺序**（与 `06` P0-2-1 判据 2 的"顺序即正确性"同族）：
   *   ① **中断优先**：信号已中止就直接抛，不必再读 Redis —— 用户按了停止之后还去消费一个
   *      应答、甚至继续跑完这段等待，是"停止按钮失效"的经典形态（坑预判 5）。
   *   ② **先看应答、再看截止时刻**：两者同时到达时按"用户答了"处理 —— 他不知道截止时刻
   *      与服务端是否同一刻，而"点了确认却被说超时"是更坏的那个结果。
   *      （`confirmId` 不匹配的应答被丢弃，所以这里不存在"消费了别人的答案"的风险。）
   *   ③ 读 Redis 失败**不结束等待**（当"还没答"，下一轮再试）：Redis 抖一下不该让一次
   *      已经展示给用户的确认直接失败。
   *
   * ⚠️ **不 `await` 在 `setTimeout` 上的写法**（`await sleep(...)`）：那样没法把 `signal` 与
   * 超时都收进同一个 promise，还得再挂一个 abort 监听器去 `clearTimeout`（P0-1-26 的教训：
   * 监听器泄漏 / 事件已经过去了）。这里用"每轮 tick 自己 schedule"的形态，退出点只有
   * `done` / `fail` 两个，都在里面 `clearTimeout`。
   */
  #waitForConfirm(confirmId: string, timeoutMs: number): Promise<ConfirmDecision> {
    const deadline = Date.now() + timeoutMs
    const pollMs = signalPollIntervalMs()
    return new Promise<ConfirmDecision>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const done = (decision: ConfirmDecision): void => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(decision)
      }
      const fail = (error: unknown): void => {
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      }

      const tick = async (): Promise<void> => {
        if (this.#controller.signal.aborted) {
          fail(abortErrorOf(this.#controller.signal))
          return
        }
        try {
          const redis = await ensureRedisConnected()
          const raw = await redis.get(chatConfirmKey(this.#conversationId))
          if (raw !== null) {
            const answer = parseConfirmAnswer(raw)
            // 无论匹配与否都**删掉**：它是"一条待消费的应答"，而唯一的消费者就是本次等待
            // （匹配按 id）⇒ 不匹配的那种永远不会有人要（迟到点击 / 手工写的脏值）。
            await redis.del(chatConfirmKey(this.#conversationId))
            if (answer !== null && answer.confirmId === confirmId) {
              getLogger().info(
                { conversationId: this.#conversationId, confirmId, accepted: answer.accepted },
                '收到确认应答（本轮继续）',
              )
              done(answer.accepted ? 'CONFIRMED' : 'REJECTED')
              return
            }
            getLogger().warn(
              { conversationId: this.#conversationId, confirmId, receivedConfirmId: answer?.confirmId ?? null },
              '丢弃一条不属于本次等待的确认应答（可能是上一轮的迟到点击）',
            )
          }
        } catch (error) {
          getLogger().warn(
            { err: error, conversationId: this.#conversationId },
            '读取确认应答失败（本轮跳过，下轮再试）',
          )
        }
        if (Date.now() >= deadline) {
          getLogger().info(
            { conversationId: this.#conversationId, confirmId, timeoutSec: this.#confirmTimeoutSec },
            '等待确认超时 ⇒ 按取消处理（`02` §5.2）',
          )
          done('TIMEOUT')
          return
        }
        timer = setTimeout(() => {
          void tick()
        }, pollMs)
      }

      void tick()
    })
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
      data: {
        code: appError.code,
        message: appError.message,
        // 有结构化 key 就带上（P1-23 收尾 ⑤）—— 前端错误卡据此在 en 下显示真译文
        ...(appError.msgKey === null ? {} : { msgKey: appError.msgKey }),
      },
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
// 跨请求提问原语（P0-3-6b）：活跃通道注册表 + askConversation()
// ═════════════════════════════════════════════════════════════════════

/**
 * "本进程里，这个会话的活跃通道是谁"。
 *
 * ── 为什么要它（问题原样，见 `02` §9.10 ⑧ / `子方案③` §八 1） ──
 * {@link SseChannel.awaitConfirm} 是通道的**实例方法**，而通道实例是 {@link streamChatReply}
 * 里的一个局部 `const` ⇒ 跨请求只有**"回答"**的路（`/confirm` 写应答槽
 * `chat.confirm:{id}`），**没有"提问"**的路。而沙箱的 MCP 代理
 * （P0-3-9b 的 `POST /api/sandbox/mcp/call`）恰恰是一条**独立的 HTTP 请求**：
 * 容器里的引擎要动一个危险工具时，它得向"这个会话那条 SSE 流"问一句"用户同意吗"。
 *
 * ── 为什么是"只做取实例"的表，不兼做判据 ──
 * "这个会话是不是有人在跑"**只有一个判据**：Redis 的活跃流锁（`chat.active:{id}`，
 * 见文件头 ③）。本表回答的是另一个问题："**这个 id 的通道实例在不在本进程里**"。
 * 两者**不要混成一个真相源**：混了之后"锁在、通道不在"（刚重启 / 不在同一实例）
 * 这种状态就会被误判成"可以提问"。
 */
const activeChannels = new Map<string, SseChannel>()

/**
 * 一次**跨请求提问**的结局 = 确认的三种（{@link ConfirmDecision}）+ 一种"**根本没问成**"。
 *
 * ⚠️ 第四种**必须与 `REJECTED` 分得开**（`子方案③` §八 2 的纪律 ②）：
 * `REJECTED` 是"用户点了取消"，`NO_CHANNEL` 是"这个会话的通道不在本进程里"
 * （流已经结束 / 压根不在这个实例上）。两者都**通向"不执行这个工具"**，但回给模型的话
 * 不一样 —— 把后者说成"用户已取消"是把**我们的状态问题**说成**用户的决定**。
 */
export type AskConfirmOutcome = ConfirmDecision | 'NO_CHANNEL'

/** 通道建成后登记（{@link streamChatReply} 里紧跟 `new SseChannel(...)`） */
function registerActiveChannel(channel: SseChannel): void {
  activeChannels.set(channel.conversationId, channel)
}

/**
 * 注销（{@link streamChatReply} 的 finally 里、`dispose()` **之前**）。
 *
 * ⚠️ **按身份撤销**，不是 `delete(conversationId)` —— 理由与
 * {@link releaseConversationLock} 的"按归属释放"**同一条**：并发冲突的判据是 Redis 那把锁，
 * 而锁**有 TTL**（文件头 ③）⇒ 锁一旦过期，同一个会话就可能有**第二条流**拿到锁、建出第二个
 * 通道并覆盖本表。此时老通道的 finally 若直接 `delete(id)`，删掉的是**新通道**的登记 ——
 * 此后该会话的 `askConversation()` 会一直答 `NO_CHANNEL`（症状是"这个会话的危险工具全都说
 * 无法确认"），**没有任何报错**，只能靠读代码发现。
 */
function unregisterActiveChannel(channel: SseChannel): void {
  if (activeChannels.get(channel.conversationId) !== channel) return
  activeChannels.delete(channel.conversationId)
}

/**
 * 跨请求向某个会话的活跃流提一个确认问（`02` §9.10 ⑧；调用方 = P0-3-9b 的代理端点）。
 *
 * 实现只有两步：**查表 → 该通道的 `awaitConfirm(question)`**（提问这件事的重心是
 * "往哪条响应流写 `confirm` 帧"，那只能是通道实例本身）。
 *
 * ── 三条纪律（缺了会出静默坏事；`子方案③` §八 2） ──
 *  ① **本表不是"谁是主人"的判据**（见 {@link activeChannels} 的注释）——
 *     主人判据仍然只有 Redis 的活跃流锁。
 *  ② ★ **查不到通道 ⇒ 调用方必须按"拒绝执行"处理**：回一条"无法确认 ⇒ 未执行"的结果，
 *     **不是静默放行、也不是当成功**。安全默认拒绝 —— 查不到只可能是因为流已经结束
 *     （那这一轮本来也该结束），或这个会话不在本进程上（见 ③）。
 *     ⚠️ **非危险工具不依赖本表**，照常执行：本函数只被"要动危险工具"那一条路调用。
 *  ③ **本表是进程内的** ⇒ 与 `SANDBOX_CONCURRENCY` 的作用域是**同一条扩容前提**
 *     （`子方案③` §九 3）：横向扩容时容器与 SSE 流可能不在同一实例上。那时**不能只是把
 *     `Map` 换成 Redis** —— "提问"要往一条具体的响应流写帧，那不可能跨进程；正确修法是
 *     "按会话把代理调用路由到持有该流的实例"（与 §四 3 的后端地址一起改）。
 *
 * ── 两条实现约定（都由 {@link SseChannel#awaitConfirm} 保证，调用方不必自己处理） ──
 *   · **超时按取消**：到点回 `'TIMEOUT'`（不抛错 —— 超时是一条**正常结论**）；
 *   · ⚠️ **中断照旧抛出**：轮次被中断（用户停止 / 客户端断开 / 锁丢失）时抛
 *     `ChatStoppedError`（= `signal.reason`），本函数**不接、原样透传** —— 它与"确认的结局"
 *     是两件事（见 {@link ConfirmDecision}）。代理端点要自己接住它、把结果按"未执行"回给引擎
 *     （`sandbox/proxy.ts#runDangerousCall` 已接住，P0-3-9b）。
 *
 * 📌 `question` 的形状与 `ChatProducerInput#awaitConfirm` 的入参是**同一个**
 * （{@link ConfirmQuestion}）—— 编排层自己问、代理端点代问，走的是**同一套**挂起与应答机制。
 */
export async function askConversation(
  conversationId: string,
  question: ConfirmQuestion,
): Promise<AskConfirmOutcome> {
  const channel = activeChannels.get(conversationId)
  if (channel === undefined || channel.closed) {
    // 两个条件合成一条出口：查不到 = 这个会话没有活跃流；`closed` 是"表里还留着、流已收尾"
    // 的兜底 —— 注销与 `dispose()` 之间没有 `await`（见 streamChatReply 的 finally），
    // 理论上留不下窗口；留着它是因为**这里的失败方向只能是"拒绝"**，代价只是一次比较。
    getLogger().warn(
      {
        conversationId,
        source: question.source,
        toolName: question.toolName,
        // 区分"没登记过"与"登记了但已关闭"：排查"注销漏了"时这是唯一的线索
        registered: channel !== undefined,
      },
      '本进程里没有该会话的活跃通道 ⇒ 无法提问（危险调用必须按"未执行"处理）',
    )
    return 'NO_CHANNEL'
  }
  getLogger().info(
    { conversationId, source: question.source, toolName: question.toolName },
    '跨请求提问：已交给该会话的活跃流，等待用户应答',
  )
  return channel.awaitConfirm(question)
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
  /** 本轮用户消息正文（`shared` 的 `chatRequestBodySchema` 已 trim）—— 转交给 producer */
  content: string
  /** 本轮附件（P1-4；已解析）—— 转交给 producer，`regenerate` 恒传空数组 */
  attachments?: readonly ChatAttachmentContext[]
  target: LlmTarget
  /** 编排循环（P0-1-27）；本批是占位实现，见 `orchestrator/index.ts` */
  producer: ChatProducer
  /**
   * 拿到会话互斥锁之后、写出任何响应之前执行的准备动作（**P1-3 重新生成**的唯一用途）。
   *
   * 为什么入口在这里、而不是在路由里：它要删掉"上一轮"（用户名下的消息 + 产物），
   * 而**删必须发生在锁之后** —— 拿不到锁即意味着这个会话已有另一条流在跑，
   * 那时删掉的是**别人正在写的历史**（症状：另一条流的落库凭空少一轮）。
   * 路由层拿到不到"锁已就绪"这一刻，故由本层在 ② 之后回调它。
   *
   * ⚠️ 它被安排在 `reply.hijack()` **之前**：失败（如会话在闸门之后被删）走的是
   * **JSON 信封**（Fastify errorHandler）而不是一个 SSE `error` 帧 —— 与其余前置失败同口径。
   */
  onLockAcquired?: () => Promise<void>
  /**
   * 开放平台调用来源（**P1-22**）：本轮由哪把 Key 发起。`undefined` = 内部界面。
   * 透传进 `ChatProducerInput#openKeyId` ⇒ 落库时写 `usage_records.channel='OPEN_API' / open_key_id`。
   */
  openKeyId?: string
  /**
   * 本轮的**确认卡超时**（秒；**P1-22**）：开放层按 Key 配置覆盖全局 `MCP_CONFIRM_TIMEOUT_SEC`。
   *
   * 为什么按"每次流"而不是"进程配置"：同一个进程里内部用户与外部客户并存 —— 外部人工审批更慢
   * （`docs/08` §4.1 允许配到 300s），改全局配置会把内部 UI 的等待也一起拉长。
   * 不传 ⇒ 走 `config.mcp.confirmTimeoutSec`（内部路径零改动）。
   */
  confirmTimeoutSec?: number
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
 * ⑤ 登记活跃通道（P0-3-6b）→ 起心跳 / 挂 close 监听
 * ⑥ await producer(...)      ← 编排循环
 * ⑦ 收尾帧（done / error）
 * ⑧ finally：注销活跃通道（P0-3-6b）→ 清定时器 → 清停止键 → 释放锁（按归属）→ end()
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
  const { reply, conversationId, agentId, content, attachments, target, producer, onLockAcquired } = input
  const logger = getLogger()
  const startedAt = new Date().toISOString()

  // ① 会话互斥（`02` §5.2）。`streaming` 与锁是同一件事（`infra/redis.ts#chatActiveKey`）
  // ⚠️ 用 `EMPTY_ACTIVE_SNAPSHOT` 铺底而**不是**逐字段手写（P0-2-10 改这里时正好踩过）：
  //    手写的版本在加第四个字段 `pendingConfirmId` 时**不会报错也不会漂** —— 它只是少一个键，
  //    而少这一个键的后果是"所有 `/confirm` 应答都变成 `applied:false`"（静默到只有类型检查能抓）。
  // ★ `startedBy`（2026-10-22）：**发起方必须由发起方自己说**。帧总线（`frameBus`）对所有
  //   `/chat` 来路一视同仁地广播 —— 开放层的第三方调用与界面里的发送是同一种帧，观察者
  //   无法从帧上分辨 ⇒ 只能记在锁里，让 `/active` 与观察流如实回答"这一轮是谁发起的"。
  //   判据是"有没有 Key 上下文"（`openKeyId` 由开放层透传，见 `StreamChatReplyInput#openKeyId`）。
  const locked = await acquireConversationLock(conversationId, {
    ...EMPTY_ACTIVE_SNAPSHOT,
    startedAt,
    startedBy: input.openKeyId === undefined ? 'UI' : 'OPEN_API',
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
    // ②″ 残留插话（P1-9 · P4 · R1）：同款第二道防线 —— 上一轮没被消费完的插话绝不能被本轮读到
    //     （症状同"秒停"：刚发出去的一条消息被一句"用户修改了 X"顶掉）。
    await clearSteerSignal(conversationId)

    // ②′ 锁已就绪的准备动作（**P1-3 重新生成**：先撤掉上一轮再跑全新的流）。
    //     位置见 `StreamChatReplyInput#onLockAcquired`：必须在锁之后（否则会删掉别人的历史）、
    //     且必须在 `hijack()` 之前（失败走 JSON 信封）。它抛错 ⇒ 外层 finally 释放锁、异常照常上抛。
    if (onLockAcquired !== undefined) await onLockAcquired()

    // ③④ 接管响应
    reply.hijack()
    reply.raw.writeHead(200, SSE_RESPONSE_HEADERS)
    reply.raw.flushHeaders()

    channel = new SseChannel(reply.raw, conversationId, startedAt, input.confirmTimeoutSec)
    /**
     * 非空别名：`channel` 是 `let`（外层 `finally` 要读它），而 TS 在**闭包**里会把它重置为
     * `SseChannel | undefined` ⇒ `channel.awaitConfirm(...)` 编不过。用 `const` 取一次，
     * 新的那个成员就不必写 `?.` 兜底（`emit` / `updateSnapshot` 的 `?.` 是历史写法，保持不动）。
     */
    const activeChannel = channel
    /**
     * ★ P0-3-6b：登记进活跃通道表。**紧跟构造**（在 `start()` 之前）—— "通道活着"与
     * "能被跨请求提问"从这一刻起同时成立；晚一步登记的后果见 ⑤ 的注释（危险工具会被
     * 判成"无法确认"）。
     */
    registerActiveChannel(activeChannel)
    channel.start()
    // 开这条会话的帧频道（P1-6 方案 A）：本流发出的每一帧都会进总线，供观察者订阅
    openRun(conversationId)

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
        ...(input.openKeyId === undefined ? {} : { openKeyId: input.openKeyId }),
        content,
        attachments: attachments ?? [],
        target,
        startedAt,
        signal: channel.signal,
        emit: (event) => channel?.emit(event) ?? Promise.resolve(),
        updateSnapshot: (patch) => channel?.updateSnapshot(patch) ?? Promise.resolve(),
        awaitConfirm: (question) => activeChannel.awaitConfirm(question),
        onSteer: (listener) => activeChannel.onSteer(listener),
        onSteerCancel: (listener) => activeChannel.onSteerCancel(listener),
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
      /**
       * ★ P0-3-6b：**先注销、再 `dispose()`**。
       *
       * 这两步都是同步调用、中间没有 `await` ⇒ 不存在"表里有、通道已死"的可观测窗口；
       * 顺序这样写只是让"通道不再可用"与"表里查不到它"在同一步完成（连 `closed` 兜底
       * 都成了纯保险）。⚠️ 必须**按身份撤销** —— 见 {@link unregisterActiveChannel}。
       */
      unregisterActiveChannel(activeChannel)
      channel.dispose()
      // 关帧频道（P1-6 方案 A）：停止缓冲；观察者的连接各自关闭时再 unsubscribe
      closeRun(conversationId)
      // ⚠️ 顺序：清停止键必须在**释放锁之前**（此刻锁还在我们手上 ⇒ 不可能有别的流在跑 ⇒
      //    这个键只可能是写给我们的）。挪到外层 finally 之后就可能和新流的 `/stop` 抢键 ——
      //    把新流刚拿到的停止信号删掉，症状是"点了停止但停不下来"。
      //    （另一侧"新流启动时也清一次"在 ② —— 两道防线各挡一种残留。）
      await clearStopSignal(conversationId)
      // 插话信号同款：清在释放锁之前（同一把锁还在手上 ⇒ 这个键只可能是写给我们的）
      await clearSteerSignal(conversationId)
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
