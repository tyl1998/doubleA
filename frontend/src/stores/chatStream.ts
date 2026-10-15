/**
 * 对话流状态（zustand，P0-1-32；P0-1-33 加"停止收口"与"断线黄条"；**P1-19 改成多流**）
 *
 * 依据：`docs/03-前端设计.md` §六（"SSE 状态集中在 `useChatStream`（fetch 流解析 → store 分发），
 *      页面组件只读 store"、"`stores/` 放 zustand（会话侧栏、SSE 流状态、全局 UI）"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个 store 只做一件事：把归约结果放进来
 * ─────────────────────────────────────────────────────────────────────
 * 全部事件语义都在 `features/chat/roundReducer.ts`（纯函数、可被无依赖档直接断言）。
 * 这里**不许**出现 `if (event.name === 'delta')` 这类分支 —— 一旦出现就有两处事件语义，
 * 而无依赖档只守得住其中一处。每个会话的接口因此只有三个动作：开一轮、喂一帧、清空。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ P1-19：**按会话**存（`Map`），而不是一个全局轮次槽
 * ─────────────────────────────────────────────────────────────────────
 * 早先只有**一个** `round` + `streamFor`（"一个轮次槽"），于是"在 A 里发消息、没等收口就切到
 * B"会串台（`begin` 覆盖、`apply` 认不出这一帧属于谁）—— 当时的处置是**拦住**它（`elsewhere`
 * 状态 + `send` 的 `BUSY` 闸门，P0-1-34）。代价是：**只要 A 还在跑（TaskAgent 动辄数分钟），
 * B 就一直发不出消息**，用户看到的是"切过去就卡住"。
 *
 * 现在改成 `rounds: Record<conversationId, StreamRound>`：每个会话各占一格，`begin`/`apply`
 * 都带 `conversationId` ⇒ 互不覆盖、也不串台。于是：
 *   · 一轮在 A 跑的同时可以在 B 里再发一条（后端每个会话各有一把锁，本就允许并行）；
 *   · 切走再切回，A 的那一轮还在（`streamFor` 的历史语义由"键"自然承担）。
 * ⚠️ `apply` 现在**必须**知道这一帧属于谁：每个流的 `onEvent` 闭包各自捕获自己的 `targetId`
 *（见 `useChatStream` / `useConversationWatch`）—— 这是"多流"能成立的关键，写漏一处就会串台。
 *
 * ⚠️ 与 `stores/ui.ts` 的分工：那个是"与业务无关的界面开关"（配色），
 * 这个是**一次请求的生命周期**。服务端数据（历史消息 / 会话列表）一律不进这里 —— 那是
 * TanStack Query 的职责，两处都存必然不一致（`03` §六）。
 */

import type { SseEvent } from '@doubulea/shared'
import { create } from 'zustand'

import type { ClientErrorCode } from '../api/client.js'
import type { AttachmentView } from '../features/chat/messageModel.js'
import { beginRound, reduceRound, withInterjection, type RoundKind, type StreamRound } from '../features/chat/roundReducer.js'

/**
 * 顶部黄条（`03` §4.1："断线 → 顶部黄条提示，**点击黄条 = 立即拉取历史对齐**"）。
 *
 * ⚠️ **为什么它必须住在 store 里、而不是挂在轮次上**（P0-1-33 的一个顺序推导）：
 * 点黄条 = 对齐历史，而对齐的结论之一就是"服务端存下来了 ⇒ **丢掉流式轮次**"。
 * 若黄条跟着轮次走，那它会在用户点它的同一瞬间消失 —— 用户会看到"我点了一下，提示没了，
 * 但页面到底对齐了没有、对齐成了什么，什么都不知道"。放进 store 之后：
 *   · 轮次该丢就丢（避免同一轮渲染两遍）；
 *   · 黄条留到**调用方显式清**（点击后清），于是"对齐完成"这件事有一个可见的收尾动作。
 *
 * 文案在 `features/chat/streamErrors.ts`（三种触发共用一个口径）；这里只存**具体线索**。
 */
export interface DisconnectState {
  /** 附加一行线索（错误码 / 服务端答复）；没有具体线索时是 `null` */
  extra: string | null
}

interface ChatStreamState {
  /**
   * 每个会话进行中的那一轮（`conversationId → StreamRound`）。
   * **没有这个键** = 该会话空闲（旧版用 `streamFor === null` 表达）。
   */
  rounds: Record<string, StreamRound>
  /**
   * 每个会话的顶部黄条（`conversationId → DisconnectState`）。
   * **按会话存**：A 断线亮条不该在 B 的画面上出现（多流之后这是必须的）。
   */
  disconnects: Record<string, DisconnectState>

  /**
   * 开一轮：**流已经成功建立之后**才调用（前置失败不该在界面上留下任何痕迹）。
   * `kind` 默认 `'send'`；重新生成传 `'regenerate'` —— 只影响页面的"收起正在被替换的一轮"，
   * 事件归约与收尾**完全同款**（见 `roundReducer.ts#RoundKind`）。
   */
  begin: (
    conversationId: string,
    userText: string,
    startedAt: string,
    kind?: RoundKind,
    userAttachments?: readonly AttachmentView[],
  ) => void
  /** 喂一帧到**指定会话**（该会话没开轮时静默忽略：`done` 之后仍可能有尾帧，那是正常现象） */
  apply: (conversationId: string, event: SseEvent) => void
  /**
   * 往指定会话这一轮**乐观地**追加一条用户插话（P1-20）—— `POST /:id/steer` 成功后调它。
   *
   * ⚠️ 存在的理由：插话常常发生在轮次的最后几秒，出口层的 `steer` 回帧依赖"通道轮询在轮次结束前
   * 取到"，可能整个落空 ⇒ 界面上"插话直接消失了"。**用户说过的话必须看得见** ⇒ 展示以本地为准；
   * 出口层若真回了帧，归约层按正文去重（见 `withInterjection`）。已收口 / 没开轮时静默忽略。
   */
  addInterjection: (conversationId: string, text: string, at: string) => void
  /**
   * **客户端侧**的收口失败（连接中断 / 读流抛错）—— 与流内 `error` 事件落到同一个出口
   * （消息流内错误卡），只是错误码可能来自 `api/client.ts` 的伪码 `NETWORK`。
   * 只有"这一轮已经开始过"时才该调它（见 `useChatStream.ts` 的三类失败表）。
   *
   * ⚠️ 它把 `errorSource` 标成 `'client'`（P0-1-33）：由此页面才知道该走**黄条**而不是 toast
   * （`streamErrors.ts#shouldToastChatError`）。
   */
  fail: (conversationId: string, error: { code: ClientErrorCode; message: string }) => void
  /**
   * 客户端侧把这一轮标成"已停止"（P0-1-33）：点了停止、`POST /stop` 也成功了，
   * 但 **5s 窗口内没等到 `done{STOPPED}`** ⇒ 由 `stopController` 的 abort 兜底之后调用。
   *
   * 语义上它与收到 `done{STOPPED}` 等价（用户确实点了停止、服务端确实收到了信号），
   * 差别只在**没有服务端的确认**：`persisted` 因此保持 `null`（不知道落没落库），
   * 于是收尾行**不会**声称"刷新后不会出现在历史里"（那句只在 `persisted === false` 时说，
   * 见 `AssistantMessage`）—— 不知道的事，界面不许说。
   */
  stoppedLocally: (conversationId: string) => void
  /** 亮指定会话的顶部黄条（三条客户端侧中断路径调它，文案见 `streamErrors.ts`） */
  showDisconnect: (conversationId: string, payload: DisconnectState) => void
  /** 收指定会话的黄条（用户点过它 = 已经对齐过了；开新一轮时也清） */
  clearDisconnect: (conversationId: string) => void
  /**
   * 收掉指定会话的确认卡（P0-2-11）。
   *
   * ⚠️ **服务端不会为此发任何事件**：答复走的是 `POST /:id/confirm`（一次独立于流的普通请求），
   * 而流里那唯一的"提问"已经由这次答复消费掉了。若不在本地收卡，它会一直挂在输入区上方
   * —— 用户点了「确认」、工具也真的开始跑了，卡片却还在问同一个问题（P0-2-10 那条
   * 「确认卡一闪而过」的反面：**它不是一闪而过，而是不走**）。
   *
   * 归约层**不做**这件事（没有对应的事件），所以它是 store 上的一个显式动作 ——
   * 与 `clearDisconnect` 同款理由：界面上的一个东西消失，需要一个说得出来源的触发点
   * （这里就是"我方已经答复过了"）。
   */
  clearConfirm: (conversationId: string) => void
  /**
   * 丢掉**一个**会话的流式轮次（对齐历史后 / 观察收尾 / 让位时调用）。
   * ⚠️ 刻意**不动**该会话的 `disconnect`：`reset()` 也被"对齐历史"这条路调用
   *（丢掉流式版本），而那正是黄条该留下来的场景 —— 见 `DisconnectState` 的注释。
   */
  reset: (conversationId: string) => void
  /** 清空**全部**会话的轮次与黄条（对话页卸载时调用） */
  resetAll: () => void
}

/**
 * 一个会话的当前轮次（没有则是 `null`）。**给组件当选择器用**：`useChatStreamStore((s) => roundOf(s, id))`
 * 在轮次没变时返回**同一引用** ⇒ 不会无谓重渲染（zustand v5 严格比较）。
 */
export function roundOf(
  state: Pick<ChatStreamState, 'rounds'>,
  conversationId: string | undefined,
): StreamRound | null {
  if (conversationId === undefined) return null
  return state.rounds[conversationId] ?? null
}

/** 一个会话的顶部黄条（没有则是 `null`）。理由同 {@link roundOf} */
export function disconnectOf(
  state: Pick<ChatStreamState, 'disconnects'>,
  conversationId: string | undefined,
): DisconnectState | null {
  if (conversationId === undefined) return null
  return state.disconnects[conversationId] ?? null
}

/**
 * 正在生成的会话 id 集合（P0-1-34 的侧栏要给**每一条**点亮"生成中"灯，多流之后可能同时有多个）。
 *
 * ⚠️ **纯函数**（不在 store 里当场算，也不在组件里当 zustand 选择器直接返回新 `Set`）：
 * 每次调用都新建一个 `Set` ⇒ 直接用 `useChatStreamStore(streamingIdsOf)` 会**无限重渲染**。
 * 组件侧的正确用法是选 `rounds`（引用稳定）再 `useMemo(..., [rounds])` 调它（见 `ConvRail`）。
 */
export function streamingIdsOf(state: Pick<ChatStreamState, 'rounds'>): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const [id, round] of Object.entries(state.rounds)) {
    if (round.status === 'streaming') ids.add(id)
  }
  return ids
}

/** 去掉一个键的浅拷贝（`undefined` 也当"没有这个键"，避免留下 `{id: undefined}` 脏键） */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

export const useChatStreamStore = create<ChatStreamState>((set) => ({
  rounds: {},
  disconnects: {},

  begin: (conversationId, userText, startedAt, kind, userAttachments) => {
    // 开新一轮 ⇒ 该会话上一轮的黄条自动消失（`03` §4.1 的状态机里，`idle → streaming` 是一个
    // 干净的起点；留着旧黄条会让用户以为**这一轮**出问题了）。**只清本会话的**。
    set((state) => ({
      rounds: { ...state.rounds, [conversationId]: beginRound(userText, startedAt, kind, userAttachments) },
      disconnects: without(state.disconnects, conversationId),
    }))
  },

  apply: (conversationId, event) => {
    set((state) => {
      const round = state.rounds[conversationId]
      if (round === undefined) return state
      const next = reduceRound(round, event)
      // 归约层对 `ping` 等返回**同一引用** ⇒ 这里也返回同一 `state`，不触发任何重渲染
      if (next === round) return state
      return { rounds: { ...state.rounds, [conversationId]: next } }
    })
  },

  addInterjection: (conversationId, text, at) => {
    set((state) => {
      const round = state.rounds[conversationId]
      if (round === undefined) return state
      const next = withInterjection(round, { text, at })
      if (next === round) return state
      return { rounds: { ...state.rounds, [conversationId]: next } }
    })
  },

  fail: (conversationId, error) => {
    set((state) => {
      const round = state.rounds[conversationId]
      if (round === undefined) return state
      return {
        rounds: {
          ...state.rounds,
          [conversationId]: { ...round, status: 'error', error, errorSource: 'client' },
        },
      }
    })
  },

  stoppedLocally: (conversationId) => {
    set((state) => {
      const round = state.rounds[conversationId]
      if (round === undefined) return state
      return {
        rounds: {
          ...state.rounds,
          [conversationId]: {
            ...round,
            status: 'stopped',
            finishReason: 'STOPPED',
            error: null,
            errorSource: null,
          },
        },
      }
    })
  },

  showDisconnect: (conversationId, payload) => {
    set((state) => ({ disconnects: { ...state.disconnects, [conversationId]: payload } }))
  },

  clearDisconnect: (conversationId) => {
    set((state) => {
      const next = without(state.disconnects, conversationId)
      return next === state.disconnects ? state : { disconnects: next }
    })
  },

  clearConfirm: (conversationId) => {
    // ⚠️ 该会话没有轮次 / 没有卡片时是**空操作**（返回同一 `state`，不触发重渲染）
    //    —— 与归约层返回同一引用的口径一致。
    set((state) => {
      const round = state.rounds[conversationId]
      if (round === undefined || round.confirm === null) return state
      return { rounds: { ...state.rounds, [conversationId]: { ...round, confirm: null } } }
    })
  },

  reset: (conversationId) => {
    // ⚠️ 刻意**不动**该会话的 `disconnect`：见 `DisconnectState` 的注释。
    // 清黄条只有一个入口：`clearDisconnect(conversationId)`（用户点过它）。
    set((state) => {
      const rounds = without(state.rounds, conversationId)
      return rounds === state.rounds ? state : { rounds }
    })
  },

  resetAll: () => {
    set({ rounds: {}, disconnects: {} })
  },
}))
