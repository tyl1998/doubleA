/**
 * 工作区事件的**跨进程广播**（2026-11-20）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 3（事件总线）/ §十六 A（多机下的粘性与进程内状态）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 解决什么问题
 * ─────────────────────────────────────────────────────────────────────
 * watcher 与事件总线都是**进程内**的。工作区路由按 `sandbox:owner` 粘性（`shared#classifyRoute`），
 * 但**粘性键过期 / 换机 / 容器由别处持有 / 网关没拿到目录**时，SSE 会连到 A、watcher 跑在 B：
 * 只靠进程内 `Map` 就永远收不到事件 —— 症状是"agent 写完了，文件树不刷新"，而且**没有任何报错**。
 *
 * 于是 `workspace/events.ts#publishWorkspaceEventItem` 在本地投递之后再发一份到 Redis 频道
 * （{@link workspaceEventsChannel}），**持有该会话 SSE 订阅者的那台**收到后投进自己的订阅表。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条纪律
 * ─────────────────────────────────────────────────────────────────────
 *   · **只转发实时事件，不做持久**：断线补发仍只认 `workspace_events` 表（`listWorkspaceEventsAfter`）；
 *     广播丢了最坏是"这一拍没实时刷到"，重连/下一次对账会补齐；
 *   · **按会话订阅**：只在"本进程有该会话的订阅者"期间 `SUBSCRIBE`，最后一个订阅者离开即 `UNSUBSCRIBE`
 *     —— 不让每个实例都订阅全体会话（那是 `PSUBSCRIBE workspace.events.redis:*` 的做法，会被无关流量打满）；
 *   · **丢弃自己的回声**：消息体带 `instanceId`，等于 `config.sandbox.instanceId` 的直接忽略
 *     （本进程在 {@link broadcastWorkspaceEvent} 之前已经本地投递过了）；
 *   · **全链路失败只 debug**：实时性增强不该因为 Redis 抖动把写入路径拖出异常
 *     （事件已经落库，正确性不受影响）。
 *
 * ⚠️ 用**独立连接**订阅（`createRedisConnection`）：ioredis 进入 subscriber 模式后，
 *    `SUBSCRIBE` 那条连接上只能收发 pub/sub，不能跑业务命令。
 */

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { createRedisConnection, ensureRedisConnected, workspaceEventsChannel } from '../infra/redis.js'
import type { WorkspaceEventItem } from '@doubulea/shared'

/** 频道消息体（`event` 原样就是 SSE payload；`instanceId` 只用来丢回声） */
interface WorkspaceEventBroadcastMessage {
  instanceId: string
  event: WorkspaceEventItem
}

/** 本进程的订阅者连接（**懒创建**：没有工作区 SSE 的部署形态不会为此多开一条 Redis 连接） */
let subscriber: ReturnType<typeof createRedisConnection> | undefined
/** 已 `SUBSCRIBE` 的会话（=`workspace/events.ts#listeners` 里有订阅者的会话） */
const subscribed = new Set<string>()

/**
 * 发一份广播（**尽力而为，同步返回**：调用方在写入路径上，不能等 Redis）。
 *
 * 失败只 debug —— 见文件头第 4 条。
 */
export function broadcastWorkspaceEvent(conversationId: string, event: WorkspaceEventItem): void {
  const payload: WorkspaceEventBroadcastMessage = { instanceId: config.sandbox.instanceId, event }
  void ensureRedisConnected()
    .then((redis) => redis.publish(workspaceEventsChannel(conversationId), JSON.stringify(payload)))
    .catch((error: unknown) => {
      getLogger().debug({ err: error, conversationId, path: event.path }, '工作区事件广播失败（别的实例这一拍收不到；不落库、重连会补齐）')
    })
}

/**
 * 确保本进程已订阅这个会话的广播（幂等；由 `subscribeWorkspaceEvents` 在第一个订阅者到达时调用）。
 *
 * 订阅是**异步**建立的，失败只 warn —— 失败时退化为"只靠本地投递"（单实例形态不受影响）。
 */
export function ensureWorkspaceEventBroadcast(conversationId: string): void {
  if (subscribed.has(conversationId)) return
  subscribed.add(conversationId)
  void subscribeOn(conversationId).catch((error: unknown) => {
    // 回滚登记，下一次有订阅者时会重试（Redis 抖动期间不该永久放弃）
    subscribed.delete(conversationId)
    getLogger().warn({ err: error, conversationId }, '工作区事件广播订阅失败（本进程暂时只收本地事件；重连会补齐）')
  })
}

/** 本进程已没有该会话的订阅者 ⇒ 退订（幂等） */
export function releaseWorkspaceEventBroadcast(conversationId: string): void {
  if (!subscribed.delete(conversationId)) return
  const connection = subscriber
  if (connection === undefined) return
  void connection.unsubscribe(workspaceEventsChannel(conversationId)).catch((error: unknown) => {
    getLogger().debug({ err: error, conversationId }, '工作区事件广播退订失败（连接会在进程退出时整体收尾）')
  })
}

/** 当前订阅的会话数（观测/验收用） */
export function workspaceBroadcastSubscriptionCount(): number {
  return subscribed.size
}

async function subscribeOn(conversationId: string): Promise<void> {
  if (subscriber === undefined) {
    const connection = createRedisConnection('workspace-broadcast')
    connection.on('message', (channel: string, raw: string) => handleMessage(channel, raw))
    // 断线重连后 ioredis 会**自己重发** SUBSCRIBE（它记着当前订阅表）⇒ 这里不用补订阅
    subscriber = connection
  }
  await ensureRedisConnected(subscriber)
  await subscriber.subscribe(workspaceEventsChannel(conversationId))
}

function handleMessage(channel: string, raw: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    getLogger().debug({ channel }, '工作区广播消息不是合法 JSON（已忽略）')
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const { instanceId, event } = parsed as Partial<WorkspaceEventBroadcastMessage>
  if (typeof instanceId !== 'string' || typeof event !== 'object' || event === null) return
  // 自己的回声：本进程在 publish 时已经本地投递过，再投一次会让前端收到重复事件
  if (instanceId === config.sandbox.instanceId) return
  const { id, type, path, at } = event as Partial<WorkspaceEventItem>
  if (typeof id !== 'string' || typeof type !== 'string' || typeof path !== 'string' || typeof at !== 'string') return
  const conversationId = conversationIdOfChannel(channel)
  if (conversationId === undefined) return
  deliver(conversationId, event as WorkspaceEventItem)
}

/** 从频道名取会话 id（`workspace.events.redis:{conversationId}`）；认不出返回 undefined（不猜） */
function conversationIdOfChannel(channel: string): string | undefined {
  const prefix = `workspace.events.redis:`
  if (!channel.startsWith(prefix)) return undefined
  const conversationId = channel.slice(prefix.length)
  return conversationId === '' ? undefined : conversationId
}

/** 投递到本进程的订阅表（**动态 import**：`events.ts` 静态依赖本文件，反向静态 import 会成环） */
function deliver(conversationId: string, event: WorkspaceEventItem): void {
  void import('./events.js')
    .then(({ deliverBroadcastWorkspaceEvent }) => deliverBroadcastWorkspaceEvent(conversationId, event))
    .catch((error: unknown) => {
      getLogger().debug({ err: error, conversationId }, '工作区广播投递失败（已忽略）')
    })
}

/** 进程退出 / 测试收尾：退订全部并断开独立连接 */
export async function stopWorkspaceEventBroadcast(): Promise<void> {
  subscribed.clear()
  const connection = subscriber
  subscriber = undefined
  if (connection === undefined) return
  try {
    await connection.quit()
  } catch {
    connection.disconnect()
  }
}
