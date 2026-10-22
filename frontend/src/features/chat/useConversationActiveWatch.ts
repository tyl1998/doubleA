/**
 * 会话栏的"生成中"灯：**服务端侧**的活跃判据（2026-10-21 用户反馈 → 新增）
 *
 * 依据：`docs/03` §4.1（侧栏一行的状态灯）、`docs/02` §4.5 / §5.2（`/active` 回答"现在有没有在跑"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么光有 `rounds` 不够（用户报的那一幕）
 * ─────────────────────────────────────────────────────────────────────
 * 侧栏的"生成中"早先只来自流 store 的 `rounds`（本页**画得出**的那一轮）。而 `rounds` 只在两种时刻存在：
 *   · 本页 `POST /chat` 发起的流；
 *   · 当前**正打开**的那条会话的观察流（`useConversationWatch`）。
 * 于是"在 A 里发起 → 切到 B"那一刻，页面上没有任何东西在维护 A 的轮次 ⇒ 侧栏把 A 显示成"可继续"，
 * 而服务端那条流其实还在跑（`chat.active:{id}` 锁还在）。同理：刷新后进入、另一个标签页 / 另一台机器
 * 发起的轮次，也完全看不见。
 *
 * 本 hook 用**唯一的真值**（`GET /:id/active`，`streaming` 由 Redis 活跃锁派生）补这一块：
 *   · 有正在跑的（`rounds` 或 `serverRun` 任一非空）⇒ 2s 一轮（切换窗口后要尽快亮灯）；
 *   · 全都空闲 ⇒ 页面可见时 10s 一轮（后台发起的轮次要能被发现），页面隐藏时不轮询
 *     （用户看不到，白打请求；`visibilitychange` 回来会立刻补一轮）。
 *
 * ⚠️ 只问**可见列表里的会话**（最多 100 条，见 `MY_CONVERSATIONS_PAGE_LIMIT_MAX`），并加并发上限：
 * 一次刷新 = N 个轻量 GET（只读 Redis 快照，不碰库里的消息）。
 * ⚠️ 它**不碰** `rounds`（本页自己的事件流），只写 `noteServerRun` —— 见 `stores/chatStream.ts#serverRun`。
 */

import { useEffect, useRef } from 'react'
import type { ConversationActive } from '@doubulea/shared'

import { fetchConversationActive } from '../../api/conversations.js'
import { useChatStreamStore } from '../../stores/chatStream.js'

/** 有流在跑时的轮询间隔（用户刚切走，灯必须尽快亮） */
export const ACTIVE_POLL_BUSY_MS = 2_000
/** 全都空闲时的轮询间隔（后台 / 别处发起的轮次靠它被发现） */
export const ACTIVE_POLL_IDLE_MS = 10_000
/** 一轮刷新里同时在飞的请求数上限（100 条会话也不该一次性打满连接池） */
const ACTIVE_POLL_CONCURRENCY = 4

/** 刷新一轮：逐个问"还在跑吗"，把结论写进 store。返回是否至少有一条在跑 */
async function refresh(
  conversationIds: readonly string[],
  signal: AbortSignal,
  isMounted: () => boolean,
): Promise<{ busy: boolean }> {
  let index = 0
  let busy = false
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted || !isMounted()) return
      const id = conversationIds[index]
      index += 1
      if (id === undefined) return
      let active: ConversationActive
      try {
        active = await fetchConversationActive(id)
      } catch {
        // 读不到就**不动**这个会话的现有结论（不因为一次网络抖动把灯灭掉）
        continue
      }
      if (signal.aborted || !isMounted()) return
      const streaming = active.streaming
      if (streaming) busy = true
      useChatStreamStore.getState().noteServerRun(id, streaming, active.startedAt ?? null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(ACTIVE_POLL_CONCURRENCY, conversationIds.length) }, worker))
  return { busy }
}

/**
 * 维护"服务端侧正在跑"的会话集合（`stores/chatStream.ts#serverRun`）。
 *
 * @param conversationIds 侧栏列表里此刻可见的会话 id（顺序无关、去重由调用方保证）
 */
export function useConversationActiveWatch(conversationIds: readonly string[]): void {
  // 间隔随"有没有在跑"变 ⇒ 用 ref 读最新结论，避免把它写进 effect 依赖（那会每次亮灯都重建定时器）
  const busyRef = useRef(false)
  const rounds = useChatStreamStore((state) => state.rounds)
  const serverRun = useChatStreamStore((state) => state.serverRun)
  const busy =
    Object.values(rounds).some((round) => round.status === 'streaming') || Object.keys(serverRun).length > 0
  busyRef.current = busy

  // 列表变化时"成员比较"用：id 顺序变了但成员没变就不该重开定时器（排序会随消息落库变化）
  const idsKey = [...conversationIds].sort().join(',')

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',')
    if (ids.length === 0) return

    const controller = new AbortController()
    let mounted = true
    const isMounted = (): boolean => mounted
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = (delayMs: number): void => {
      if (!mounted) return
      timer = setTimeout(() => {
        void tick()
      }, delayMs)
    }

    const tick = async (): Promise<void> => {
      if (document.hidden) {
        // 页面不可见：不轮询，等 `visibilitychange` 回来再补一轮（不排新定时器）
        return
      }
      const outcome = await refresh(ids, controller.signal, isMounted).catch(() => ({ busy: false }))
      if (controller.signal.aborted || !mounted) return
      schedule(outcome.busy || busyRef.current ? ACTIVE_POLL_BUSY_MS : ACTIVE_POLL_IDLE_MS)
    }

    const onVisibility = (): void => {
      if (document.hidden) return
      if (timer !== undefined) clearTimeout(timer)
      void tick()
    }

    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      mounted = false
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [idsKey])
}

