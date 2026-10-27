/**
 * 定时任务的**无人值守执行**（P1-6，2026-10-09 需求变更）
 *
 * 这是本仓第一个**没有 HTTP 客户端**的编排调用点：调度器到点后，直接把指令交给该智能体的
 * 编排生产者（`ChatProducer`）—— **ChatBot 与 TaskAgent 都支持**（ChatBot 也能调 MCP 工具干活），
 * 事件发进一个**空 sink**、不写任何 SSE 响应。
 *
 * 依据：`docs/02` §4.8 的执行口径、`docs/03` §4.7、`service/scheduledTask.service.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么复用生产者而不是重写一个"跑一轮"的函数
 * ─────────────────────────────────────────────────────────────────────
 * `streamChatReply` 层**硬依赖 `FastifyReply`**（`reply.hijack()` / `reply.raw`），无法后台调用；
 * 但生产者层（`ChatProducer`）**只依赖回调**（`emit` / `updateSnapshot` / `awaitConfirm` + `signal`），
 * 与 HTTP 无关。故本文件直接调 `resolveChatProducer(agentType)(input)` —— 编排、落库、产物收集
 * 全是既有那一套，**不新增执行器**（`docs/06` §六 第 ⑰ 条：同一口径不写第二份）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 三条与"有人看着"的刻意差异（写在明处，别当成 bug）
 * ─────────────────────────────────────────────────────────────────────
 *   ① **事件丢弃**：`emit` 是空实现（没有客户端）。过程仍会落进消息（`done` 时 `persistRoundQuietly`），
 *      产物也照收 —— 用户事后进那个会话就能看到完整过程。
 *   ② **危险工具按任务配置处置**：`awaitConfirm` 依任务的 `autoApprove` 返回 —— `true` = `'CONFIRMED'`
 *      （自动放行，等价于"会话级自动审批"的语义）、`false` = `'REJECTED'`。无人值守时**没有第二个人**
 *      能确认，所以策略必须**随任务持久化、由任务 owner 决定**（默认 `true`；见 `shared/src/task.ts`）。
 *   ③ **墙钟上限**：没有"用户点停止"这条兜底 ⇒ 用 `AbortController` + `SCHEDULED_TASK_RUN_TIMEOUT_MIN`
 *      兜底，卡住的引擎不会一直占着沙箱名额。
 *
 * ⚠️ **不持会话互斥锁**（`chat.active:{id}`）：定时任务开的是一个**新会话**，没有并发写入者；
 * 持锁只会让 `/active` 多一处需要清理的状态。已知边界：若用户恰好在这条流跑的时候打开该新会话
 * 并发送，两端都不会看到对方的"正在生成"（新会话通常是任务刚建的，正常不会发生）。
 */

import { appMsg, AppError, EMPTY_ACTIVE_SNAPSHOT } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { assertConversationSendable } from '../services/conversation.service.js'
import type { ConversationViewer } from '../services/conversation.service.js'
import { closeRun, openRun, publishFrame } from './frameBus.js'
import { resolveChatProducer } from './index.js'
import {
  abortReasonOf,
  acquireConversationLock,
  ChatStoppedError,
  clearSteerSignal,
  clearStopSignal,
  drainSteerSignals,
  type SteerSignalEntry,
  readStopSignal,
  releaseConversationLock,
  updateActiveSnapshot,
} from './sse.js'

/** 一次无人值守运行的结果（给调度器记状态用） */
export interface ScheduledRunOutcome {
  conversationId: string
  /** 兜底中断（墙钟超时）时为 `true` */
  timedOut: boolean
}

/**
 * 跑一轮：校验可发 → 直接驱动该智能体的生产者到收口。
 *
 * ⚠️ **会话由调用方创建**（调度器先 `createConversation` 再调本函数）：这样"立即执行"能在
 * 建好会话的那一刻就把 `conversationId` 交回给 HTTP 响应（后台继续跑），而不必等整轮结束。
 *
 * `userId` 是任务的 owner（那个新会话的 `conversations.user_id`）—— 于是这一轮的消息、产物、
 * 计量都归到本人名下，用户进对话页就能看到。
 *
 * @throws {AppError} 闸门失败（智能体被软删、模型停用/缺 Key 等）—— 由调用方记为 FAILED
 */
export async function runScheduledTaskTurn(input: {
  conversationId: string
  userId: string
  agentId: string
  content: string
  /** 危险工具策略：见文件头 ②（任务级配置，`true` = 自动放行、`false` = 拒绝） */
  autoApprove: boolean
}): Promise<ScheduledRunOutcome> {
  const viewer: ConversationViewer = { id: input.userId }
  const conversationId = input.conversationId

  // 闸门：只读 / 模型池 / Provider Key 检查（与 /chat 同一条，见 conversation.service）
  const sendable = await assertConversationSendable(conversationId, viewer)

  // ③ 墙钟上限（见文件头 ③）
  const controller = new AbortController()
  const timeoutTimer = setTimeout(() => {
    controller.abort()
  }, config.scheduledTask.runTimeoutMin * 60_000)
  timeoutTimer.unref()

  const startedAt = new Date().toISOString()

  /**
   * ★ 方案 A：让这一轮**可被订阅**。
   * 拿会话锁（`/active.streaming` 从此为真）+ 开帧频道（`openRun`）+ 把 `emit` 改成广播
   * （`publishFrame`）——于是任何一个打开该会话窗口的页面都能实时看到这一轮。
   * 与 `streamChatReply` 的区别只在于"帧去哪了"：那边写 `reply.raw`，这边写帧总线。
   */
  const locked = await acquireConversationLock(conversationId, {
    ...EMPTY_ACTIVE_SNAPSHOT,
    startedAt,
    // 发起方（2026-10-22）：定时任务是**唯一**没有 HTTP 客户端的发起方 ⇒ 观察者要能据此
    // 如实显示"定时任务正在运行"，而不是把别的来源（外部 Open API 调用）也说成定时任务。
    startedBy: 'SCHEDULED',
  })
  if (!locked) {
    clearTimeout(timeoutTimer)
    throw AppError.conflict(appMsg('app.m065'))
  }
  openRun(conversationId)

  // ★ 中途插话（P1-9 · P4 · R1）：headless 运行**没有 `SseChannel`**，所以插话要在这里自己消费
  //   —— 否则 `POST /:id/steer` 会 `accepted:true`（本运行确实持锁、`streaming` 为真）却永远没人读，
  //   症状是"插了话、界面说已送达、agent 却不知道"（静默丢弃，最难查的一类）。
  //   机制与通道同款：producer 注册监听器（TaskAgent 转投引擎 `steer`），心跳里 `LPOP` 派发。
  const steerListeners = new Set<(entry: SteerSignalEntry) => void>()
  /** 撤回插话的监听器（2026-10-21） */
  const steerCancelListeners = new Set<() => void>()
  // 残留插话（上一轮没消费完的）先清掉，别被这一轮读到（与 `streamChatReply` ② 同款）
  await clearSteerSignal(conversationId)

  /**
   * 心跳：三件事一起做 —— ①续锁（`updateActiveSnapshot` 的 `SET ... EX` 顺带刷新 TTL，
   * 否则长静默期里锁会过期、`/active` 会误报"没有流在跑"）；②消费停止信号（这样页面上的
   * 「停止」对定时运行**也生效** —— `signalStop` 写 `chat.stop:{id}`，这里读到就中断）；
   * ③消费中途插话（P1-9 · P4 · R1）—— 没有监听器时不消费（消息留在列表里）。
   */
  const heartbeat = setInterval(() => {
    void updateActiveSnapshot(conversationId, startedAt, {}).catch(() => undefined)
    void readStopSignal(conversationId)
      .then((stopped) => {
        if (stopped) controller.abort(new ChatStoppedError('user', '用户停止了本次运行'))
      })
      .catch(() => undefined)
    void drainSteerSignals(conversationId)
      .then((items) => {
        if (steerListeners.size === 0) return
        // ⚠️ 严格按 FIFO 顺序处理（2026-10-21；与交互式出口层 `#pollSteering` 同一条纪律）：
        //    `[插话, 取消]` 与 `[取消, 插话]` 的语义完全不同（见 `SteerDrainItem`）。
        for (const item of items) {
          if (item.kind === 'cancel') {
            for (const listener of [...steerCancelListeners]) listener()
            continue
          }
          for (const listener of [...steerListeners]) listener(item.entry)
        }
      })
      .catch(() => undefined)
  }, config.limits.ssePingIntervalSec * 1000)
  heartbeat.unref()

  try {
    const result = await resolveChatProducer(sendable.agentType)({
      conversationId,
      agentId: sendable.agentId,
      content: input.content,
      attachments: [],
      target: sendable.target,
      startedAt,
      signal: controller.signal,
      // ① 帧广播（没有 HTTP 客户端，但观察者订阅了帧总线）
      emit: async (event) => {
        publishFrame(conversationId, event)
      },
      // 进度快照（断线/新打开的页面靠它恢复"在干什么"）
      updateSnapshot: async (patch) => {
        await updateActiveSnapshot(conversationId, startedAt, patch)
      },
      // ② 危险工具按任务配置处置（见文件头 ②）：`autoApprove` ⇒ 自动按"已确认"放行
      awaitConfirm: async () => (input.autoApprove ? 'CONFIRMED' : 'REJECTED'),
      // ③ 中途插话（P1-9 · P4 · R1）：TaskAgent 注册后，心跳里的 `drainSteerSignals` 把插话派过来
      onSteer: (listener) => {
        steerListeners.add(listener)
        return () => {
          steerListeners.delete(listener)
        }
      },
      // ④ 撤回插话（2026-10-21）：headless 没有 SSE 出口层，心跳里的 `cancels` 直接派到这里
      onSteerCancel: (listener) => {
        steerCancelListeners.add(listener)
        return () => {
          steerCancelListeners.delete(listener)
        }
      },
    })
    // ★ 终帧：观察者靠它收口（否则会永远停在"运行中"，用户实测即此）。
    //   交互式那条路由出口层 `SseChannel#finish` 发 `done`；headless 绕过了出口层 ⇒ 自己发。
    publishFrame(conversationId, { name: 'done', data: result })
    getLogger().info(
      { conversationId, finishReason: result.finishReason, messageId: result.messageId },
      '定时任务一轮完成',
    )
    return { conversationId, timedOut: controller.signal.aborted && abortReasonOf(controller.signal) === undefined }
  } catch (error) {
    // 同样要收口：中断 ⇒ `done{STOPPED}`（与交互式出口层同口径）；真故障 ⇒ `error`。
    // 不发的话观察者收不到终帧，会一直显示"运行中"。
    if (abortReasonOf(controller.signal) !== undefined) {
      publishFrame(conversationId, {
        name: 'done',
        data: { messageId: null, finishReason: 'STOPPED', usage: null },
      })
    } else {
      publishFrame(conversationId, {
        name: 'error',
        data: { code: 'INTERNAL', message: '定时任务运行失败' },
      })
    }
    throw error
  } finally {
    clearTimeout(timeoutTimer)
    clearInterval(heartbeat)
    await clearStopSignal(conversationId).catch(() => undefined)
    await clearSteerSignal(conversationId).catch(() => undefined)
    steerListeners.clear()
    steerCancelListeners.clear()
    await releaseConversationLock(conversationId, startedAt).catch(() => undefined)
    closeRun(conversationId)
  }
}
