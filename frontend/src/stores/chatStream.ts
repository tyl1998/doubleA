/**
 * 对话流状态（zustand，P0-1-32；P0-1-33 加"停止收口"与"断线黄条"）
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
import type { AttachmentView } from '../features/chat/messageModel.js'
import { beginRound, reduceRound, type RoundKind, type StreamRound } from '../features/chat/roundReducer.js'

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
  /** 本轮所属会话 id；`null` = 没有进行中的流（此时 `round` 也是 `null`） */
  streamFor: string | null
  /** 当前这一轮的归约态（`null` = 空闲） */
  round: StreamRound | null
  /** 顶部黄条（`null` = 本地与后端状态一致） */
  disconnect: DisconnectState | null
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
  /** 喂一帧（未开轮时静默忽略：`done` 之后仍可能有尾帧，那是正常现象） */
  apply: (event: SseEvent) => void
  /**
   * **客户端侧**的收口失败（连接中断 / 读流抛错）—— 与流内 `error` 事件落到同一个出口
   * （消息流内错误卡），只是错误码可能来自 `api/client.ts` 的伪码 `NETWORK`。
   * 只有"这一轮已经开始过"时才该调它（见 `useChatStream.ts` 的三类失败表）。
   *
   * ⚠️ 它把 `errorSource` 标成 `'client'`（P0-1-33）：由此页面才知道该走**黄条**而不是 toast
   * （`streamErrors.ts#shouldToastChatError`）。
   */
  fail: (error: { code: ClientErrorCode; message: string }) => void
  /**
   * 客户端侧把这一轮标成"已停止"（P0-1-33）：点了停止、`POST /stop` 也成功了，
   * 但 **5s 窗口内没等到 `done{STOPPED}`** ⇒ 由 `stopController` 的 abort 兜底之后调用。
   *
   * 语义上它与收到 `done{STOPPED}` 等价（用户确实点了停止、服务端确实收到了信号），
   * 差别只在**没有服务端的确认**：`persisted` 因此保持 `null`（不知道落没落库），
   * 于是收尾行**不会**声称"刷新后不会出现在历史里"（那句只在 `persisted === false` 时说，
   * 见 `AssistantMessage`）—— 不知道的事，界面不许说。
   */
  stoppedLocally: () => void
  /** 亮顶部黄条（三条客户端侧中断路径调它，文案见 `streamErrors.ts`） */
  showDisconnect: (payload: DisconnectState) => void
  /** 收黄条（用户点过它 = 已经对齐过了；开新一轮时也清） */
  clearDisconnect: () => void
  /**
   * 收掉当前这张确认卡（P0-2-11）。
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
  clearConfirm: () => void
  /** 清空（切换会话 / 卸载页面 / 前置失败回滚时调用） */
  reset: () => void
}

export const useChatStreamStore = create<ChatStreamState>((set) => ({
  streamFor: null,
  round: null,
  disconnect: null,

  begin: (conversationId, userText, startedAt, kind, userAttachments) => {
    // 开新一轮 ⇒ 上一轮的黄条自动消失（`03` §4.1 的状态机里，`idle → streaming` 是一个干净的起点；
    // 留着旧黄条会让用户以为**这一轮**出问题了）
    set({
      streamFor: conversationId,
      round: beginRound(userText, startedAt, kind, userAttachments),
      disconnect: null,
    })
  },

  apply: (event) => {
    set((state) => (state.round === null ? state : { round: reduceRound(state.round, event) }))
  },

  fail: (error) => {
    set((state) =>
      state.round === null
        ? state
        : { round: { ...state.round, status: 'error', error, errorSource: 'client' } },
    )
  },

  stoppedLocally: () => {
    set((state) =>
      state.round === null
        ? state
        : {
            round: {
              ...state.round,
              status: 'stopped',
              finishReason: 'STOPPED',
              error: null,
              errorSource: null,
            },
          },
    )
  },

  showDisconnect: (payload) => {
    set({ disconnect: payload })
  },

  clearDisconnect: () => {
    set({ disconnect: null })
  },

  clearConfirm: () => {
    // ⚠️ `round === null` 时是**空操作**（没有轮次就没有卡片可言）；
    //    `confirm` 已经是 `null` 时**返回同一引用** —— zustand 的 `set` 拿到 `state`
    //    本身即"状态未变"，不会触发任何重渲染（与归约层返回同一引用的口径一致）。
    set((state) =>
      state.round === null || state.round.confirm === null
        ? state
        : { round: { ...state.round, confirm: null } },
    )
  },

  reset: () => {
    // ⚠️ 刻意**不动** `disconnect`：`reset()` 也被"对齐历史"这条路调用
    //（丢掉流式版本），而那正是黄条该留下来的场景 —— 见 `DisconnectState` 的注释。
    // 清黄条只有一个入口：`clearDisconnect()`（用户点过它）。
    set({ streamFor: null, round: null })
  },
}))
