/**
 * 对话流状态（zustand，P0-1-32）
 *
 * 依据：`docs/03-前端设计.md` §六（"SSE 状态集中在 `useChatStream`（fetch 流解析 → store 分发），
 *      页面组件只读 store"、"`stores/` 放 zustand（会话侧栏、SSE 流状态、全局 UI）"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个 store 只做一件事：把归约结果放进来
 * ─────────────────────────────────────────────────────────────────────
 * 全部事件语义都在 `features/chat/roundReducer.ts`（纯函数、可被无依赖档直接断言）。
 * 这里**不许**出现 `if (event.name === 'delta')` 这类分支 —— 一旦出现就有两处事件语义，
 * 而无依赖档只守得住其中一处。store 的接口因此只有三个动作：开一轮、喂一帧、清空。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `streamFor` 是**防串台**的守卫，不是冗余字段
 * ─────────────────────────────────────────────────────────────────────
 * 一次流要跑几秒到几十秒，这期间用户完全可以切到另一个会话（P0-1-34 的侧栏会让它变得更容易）。
 * 那时：
 *   · 旧流的帧还在往 store 里灌（fetch 没被中断）；
 *   · 而页面正在渲染**新会话**的历史。
 * 若渲染层不区分"这一轮属于哪个会话"，用户就会在新会话里看到上一轮的残留气泡。
 * 故 `streamFor` 记下本轮归属，页面用 `streamFor === 当前会话` 决定要不要把它拼进消息列表。
 * （P0-1-33 会在切换会话时主动 abort —— 但"主动中断"与"渲染时判断归属"是两件事：
 *   前者是优化与省流，后者是**正确性**，两者都要有。）
 *
 * ⚠️ 与 `stores/ui.ts` 的分工：那个是"与业务无关的界面开关"（配色），
 * 这个是**一次请求的生命周期**。服务端数据（历史消息 / 会话列表）一律不进这里 —— 那是
 * TanStack Query 的职责，两处都存必然不一致（`03` §六）。
 */

import type { SseEvent } from '@doubulea/shared'
import { create } from 'zustand'

import type { ClientErrorCode } from '../api/client.js'
import { beginRound, reduceRound, type StreamRound } from '../features/chat/roundReducer.js'

interface ChatStreamState {
  /** 本轮所属会话 id；`null` = 没有进行中的流（此时 `round` 也是 `null`） */
  streamFor: string | null
  /** 当前这一轮的归约态（`null` = 空闲） */
  round: StreamRound | null
  /** 开一轮：**流已经成功建立之后**才调用（前置失败不该在界面上留下任何痕迹） */
  begin: (conversationId: string, userText: string, startedAt: string) => void
  /** 喂一帧（未开轮时静默忽略：`done` 之后仍可能有尾帧，那是正常现象） */
  apply: (event: SseEvent) => void
  /**
   * **客户端侧**的收口失败（连接中断 / 读流抛错）—— 与流内 `error` 事件落到同一个出口
   * （消息流内错误卡），只是错误码可能来自 `api/client.ts` 的伪码 `NETWORK`。
   * 只有"这一轮已经开始过"时才该调它（见 `useChatStream.ts` 的三类失败表）。
   */
  fail: (error: { code: ClientErrorCode; message: string }) => void
  /** 清空（切换会话 / 卸载页面 / 前置失败回滚时调用） */
  reset: () => void
}

export const useChatStreamStore = create<ChatStreamState>((set) => ({
  streamFor: null,
  round: null,

  begin: (conversationId, userText, startedAt) => {
    set({ streamFor: conversationId, round: beginRound(userText, startedAt) })
  },

  apply: (event) => {
    set((state) => (state.round === null ? state : { round: reduceRound(state.round, event) }))
  },

  fail: (error) => {
    set((state) =>
      state.round === null ? state : { round: { ...state.round, status: 'error', error } },
    )
  },

  reset: () => {
    set({ streamFor: null, round: null })
  },
}))
