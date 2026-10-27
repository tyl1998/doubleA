/**
 * 观察一条会话的**活跃运行**（P1-6 方案 A）—— 把"不是本页发起的那一轮"实时画出来。
 *
 * 依据：`docs/03` §4.1、`docs/02` §5.2。典型场景：定时任务到点或"立即执行"时，后端在**后台**跑一轮
 * （`scheduledRun.ts`），帧发进**帧总线**（`frameBus`）。本 hook 打开
 * `GET /api/conversations/:id/stream` 订阅那条会话的帧，并喂进 `chatStream` store
 * —— 于是用户打开那个会话窗口就能看到实时内容，而不是等落库。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 帧**不带来源** ⇒ 文案必须问 `/active`（2026-10-22 修）
 * ─────────────────────────────────────────────────────────────────────
 * 帧总线对所有发起方一视同仁：界面里的 `/chat`、开放层 `/open/v1/**` 的第三方调用、定时任务的
 * 后台运行写进去的是**同一种帧**，`SseEvent` 里没有任何来源字段。早先这里把占位正文写死成
 * "（定时任务正在运行…）"，于是**通过 Open API 调用的会话**在聊天页里也被显示成定时任务执行中
 * —— 帧没有说谎，是文案在替它编来源。
 *
 * 现在的口径：占位正文按 `/active` 回来的 `startedBy` 说人话（`SCHEDULED` / `OPEN_API` / `UI`），
 * 读不到（旧后端、值坏）就退成中性的"这一轮正在生成…"，**绝不**默认说成定时任务。
 * ⚠️ `/active` 是**观察开始时**读一次（这一轮的发起方不会中途变），失败不拦观察：
 *    帧照喂、正文用中性占位 —— 宁可少说一句，也不误报来源。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 与"本页自己发起的那一轮"互斥（防重复画两遍）
 * ─────────────────────────────────────────────────────────────────────
 * · 若本页**自己**正在为这个会话跑一轮（`rounds[conversationId]` 已经存在，走 `POST /chat`），
 *   本 hook **不订阅** —— 那些帧由 `/chat` 那条连接负责，再订阅一次就会把同一帧画两遍。
 * · 观察到的第一帧到来且本地没有本轮次时，用一句占位正文 `begin` 开一轮（后端没把任务指令
 *   随帧下发，且它很快就会由落库的历史替换掉，见下面 `done`/`error` 的收尾）。
 * · **P1-19 起不再有"别的会话在跑就不抢"这条**：store 按会话存（`rounds[conversationId]`），
 *   各会话的观察互不覆盖（早先只有一个轮次槽时才需要这条守卫）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 终帧的收尾：以**落库的历史为准**
 * ─────────────────────────────────────────────────────────────────────
 * 收到 `done`/`error`（或连接结束）时刷新消息历史与产物，并清掉本地这一轮 —— 落库版本随即从历史里
 * 冒出来（与 `useChatStream#align` 的"服务端存下来了就丢掉流式版本"同一条口径：同一轮不能画两遍）。
 * ⚠️ 观察流**本身是长连**（没运行只发心跳）⇒ 收尾后**不关闭连接**，下一次运行还能接着看。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import type { ConversationRunOrigin } from '@doubulea/shared'
import { translate, type Locale } from '@doubulea/shared'

import {
  conversationMessagesQueryKey,
  fetchConversationActive,
  streamConversationWatch,
} from '../../api/conversations.js'
import { conversationArtifactsQueryKey } from '../../api/artifacts.js'
import { currentLocale } from '../../stores/locale.js'
import { roundOf, useChatStreamStore } from '../../stores/chatStream.js'
import { reportSseIssue } from './chatStream.js'

/**
 * 观察产生的轮次用的占位用户文案（很快会被落库的历史替换）。
 *
 * ⚠️ **按来源分文案**：这段文字是用户在聊天页里唯一能看到的"这一轮从哪来"的线索，
 * 写死一句就等于把外部调用、别的窗口发起的轮次全都说成定时任务（2026-10-22 的 bug）。
 * 来源不明时用中性措辞 —— 少说，但不能说错。
 */
export function watchPlaceholderText(origin: ConversationRunOrigin | null | undefined, locale: Locale): string {
  switch (origin) {
    case 'SCHEDULED':
      return translate(locale, 'watch.scheduled')
    case 'OPEN_API':
      return translate(locale, 'watch.openApi')
    case 'UI':
      return translate(locale, 'watch.ui')
    default:
      return translate(locale, 'watch.unknown')
  }
}

/**
 * 观察开始时读一次"这一轮是谁发起的"。**永不抛错**：读不到就返回 `null`（= 中性文案）。
 *
 * 为什么要读 `/active` 而不是从流里拿：帧里没有来源字段（见文件头），而 `/active` 的
 * `startedBy` 由**发起方**写进锁里（`orchestrator/sse.ts` / `scheduledRun.ts`）。
 */
async function readWatchOrigin(conversationId: string): Promise<ConversationRunOrigin | null> {
  try {
    const active = await fetchConversationActive(conversationId)
    return active.startedBy
  } catch {
    return null
  }
}

export function useConversationWatch(conversationId: string | undefined): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (conversationId === undefined) return
    // 本页自己发起的那一轮（`rounds[conversationId]` 已在）由 `useChatStream`/`POST /chat` 负责，
    // 别重复订阅
    if (useChatStreamStore.getState().rounds[conversationId] !== undefined) return

    const controller = new AbortController()
    let opened = false // 是否由"观察"开出了一轮（决定收尾时要不要清它）

    const finishObservedRound = (): void => {
      void queryClient.invalidateQueries({ queryKey: conversationMessagesQueryKey(conversationId) })
      void queryClient.invalidateQueries({ queryKey: conversationArtifactsQueryKey(conversationId) })
      if (opened && roundOf(useChatStreamStore.getState(), conversationId) !== null) {
        useChatStreamStore.getState().reset(conversationId)
        opened = false
      }
    }

    void (async () => {
      try {
        // 先问来源（一次只读 GET），再开流：这样第一帧到达时占位文案已经是对的
        const origin = await readWatchOrigin(conversationId)
        if (controller.signal.aborted) return
        await streamConversationWatch(
          conversationId,
          {
            onEvent: (event) => {
              const state = useChatStreamStore.getState()
              if (opened) {
                // 这一轮是我们**观察**开出来的：只要本会话的轮次还在就继续喂。
                // ⚠️ **不能**用"本页自己发起"那套判据（观察 `begin` 之后它也像本页发起的）；
                //    区分靠本地 `opened` 这个闭包标志。轮次被别处 `reset` 掉了就停喂。
                if (state.rounds[conversationId] === undefined) return
                useChatStreamStore.getState().apply(conversationId, event)
              } else {
                // 还没开轮：若是本页自己发起的（`POST /chat`）⇒ 交给 `useChatStream`，别重复画
                if (state.rounds[conversationId] !== undefined) return
                // 第一帧：开一轮（占位正文），此后由上面的 `opened` 分支继续喂
                useChatStreamStore
                  .getState()
                  .begin(conversationId, watchPlaceholderText(origin, currentLocale()), new Date().toISOString(), 'send')
                opened = true
                useChatStreamStore.getState().apply(conversationId, event)
              }
              if (event.name === 'done' || event.name === 'error') finishObservedRound()
            },
            onIssue: reportSseIssue,
          },
          controller.signal,
        )
        // 连接结束（服务端关闭 / 断线）：以服务端为准对齐，并清掉观察轮次
        finishObservedRound()
      } catch {
        // 读流失败（含主动 abort）：不弹错 —— 观察是"顺带看一眼"，失败不该打扰正在正常使用的页面。
        // 清掉可能残留的观察轮次即可。
        if (opened && roundOf(useChatStreamStore.getState(), conversationId) !== null) {
          useChatStreamStore.getState().reset(conversationId)
        }
      }
    })()

    return () => {
      controller.abort()
      // 卸载时也要清：这个页面的观察轮次不该留到下一个页面
      if (opened && roundOf(useChatStreamStore.getState(), conversationId) !== null) {
        useChatStreamStore.getState().reset(conversationId)
      }
    }
  }, [conversationId, queryClient])
}
