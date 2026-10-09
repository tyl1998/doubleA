/**
 * 会话帧总线（P1-6 增量，方案 A：**让后台运行可被订阅**）
 *
 * 依据：`docs/02` §5.2 / §4.8、`docs/03` §4.1。解决的问题：定时任务一轮是 **headless** 的
 * （`scheduledRun.ts` 直接驱动 `ChatProducer`，没有 `SseChannel`/`FastifyReply`），它发出的帧
 * 原本进空 sink ⇒ 用户打开那个会话窗口看不到任何实时进展，只能等落库。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 一个会话一条"频道"：谁在跑都往这里发，谁在看都从这里收
 * ─────────────────────────────────────────────────────────────────────
 *   · **写侧**：`SseChannel#emit`（交互式运行）与 `scheduledRun`（后台运行）都把帧 `publishFrame`；
 *   · **读侧**：观察端点 `GET /api/conversations/:id/stream` `subscribeFrames` 后转发给浏览器。
 * 于是"实时视图"与"谁发起的那一条连接"解耦 —— 这正是后台运行能被一个**没发起它**的页面看到的前提。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 环形缓冲：迟到者要能补上"打开之前"的帧
 * ─────────────────────────────────────────────────────────────────────
 * 帧里带的是**增量**（`delta` 是一小段文本）。若只做"订阅之后的帧"，一个晚 200ms 打开页面的用户
 * 会丢掉**开头**，渲染出的回答前后不接。所以在**有活跃运行期间**本模块按会话缓存已发出的帧，
 * 新订阅者先把缓冲回放一遍、再接后续实时帧。缓冲在运行结束时清空（`closeRun`）。
 * 上界 `MAX_BUFFER` 兜底（正常一轮的增量远达不到；真超了就把最早的丢掉并记一条，宁可开头缺一点
 * 也不能把内存吃穿）。
 *
 * ⚠️ **进程内**（`Map`，与 `activeChannels` 同一取舍）：P0 单实例；横向扩容时要换成 Redis pub/sub
 * 或按会话粘性。这条边界写在这里，别当成 bug。
 */

import type { SseEvent } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'

type FrameSink = (event: SseEvent) => void

interface WatchChannel {
  /** 此刻在看这个会话的订阅者 */
  sinks: Set<FrameSink>
  /** 本轮已发出的帧（迟到订阅者回放用）；运行结束清空 */
  buffer: SseEvent[]
  /** 是否有活跃运行（决定要不要继续缓冲） */
  active: boolean
}

const channels = new Map<string, WatchChannel>()

/** 缓冲上界（帧数）；正常一轮远达不到，纯兜底 */
const MAX_BUFFER = 5000

/**
 * 开一轮（写侧在运行开始时调）：清空缓冲、标记活跃。**重复调用安全**（覆盖旧的空状态）。
 */
export function openRun(conversationId: string): void {
  const existing = channels.get(conversationId)
  if (existing !== undefined) {
    existing.buffer = []
    existing.active = true
    return
  }
  channels.set(conversationId, { sinks: new Set(), buffer: [], active: true })
}

/**
 * 结束一轮（写侧在运行收尾时调）：停止缓冲并清空。**保留订阅者**（它们各自的连接还在，
 * 由连接关闭时自行 unsubscribe）。
 */
export function closeRun(conversationId: string): void {
  const channel = channels.get(conversationId)
  if (channel === undefined) return
  channel.active = false
  channel.buffer = []
  if (channel.sinks.size === 0) channels.delete(conversationId)
}

/**
 * 发一帧（写侧）：先入缓冲（若活跃），再推给所有订阅者。
 *
 * 单个订阅者回调抛错不能影响其它订阅者，也不能影响写侧的运行 ⇒ 逐个 try/catch。
 */
export function publishFrame(conversationId: string, event: SseEvent): void {
  const channel = channels.get(conversationId)
  if (channel === undefined) return
  if (channel.active) {
    channel.buffer.push(event)
    if (channel.buffer.length > MAX_BUFFER) {
      channel.buffer.shift()
      getLogger().warn({ conversationId, max: MAX_BUFFER }, '会话帧缓冲超上限，丢弃最早的帧（订阅者可能缺一小段开头）')
    }
  }
  for (const sink of channel.sinks) {
    try {
      sink(event)
    } catch (error) {
      getLogger().debug({ err: error, conversationId }, '会话帧订阅者回调抛错（已忽略）')
    }
  }
}

/**
 * 订阅一个会话的帧（读侧）：**先同步回放缓冲**（迟到者补上开头），再接实时帧。
 *
 * @returns 取消订阅（连接关闭时务必调用）
 */
export function subscribeFrames(conversationId: string, sink: FrameSink): () => void {
  let channel = channels.get(conversationId)
  if (channel === undefined) {
    // 没有活跃运行也允许订阅（页面常开）：建一个非活跃的空频道，等有运行再缓冲
    channel = { sinks: new Set(), buffer: [], active: false }
    channels.set(conversationId, channel)
  }
  for (const event of channel.buffer) sink(event)
  channel.sinks.add(sink)

  return () => {
    const current = channels.get(conversationId)
    if (current === undefined) return
    current.sinks.delete(sink)
    if (current.sinks.size === 0 && !current.active) channels.delete(conversationId)
  }
}

/** 诊断用：某会话此刻的订阅者数 / 缓冲帧数 */
export function frameBusStats(conversationId: string): { subscribers: number; buffered: number; active: boolean } {
  const channel = channels.get(conversationId)
  return {
    subscribers: channel?.sinks.size ?? 0,
    buffered: channel?.buffer.length ?? 0,
    active: channel?.active ?? false,
  }
}
