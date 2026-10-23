/**
 * 输入区状态机（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §4.1「输入区状态机」全文 + §七 的键盘约定
 *      （"Enter 发送（对话输入框）/ Esc 关闭弹窗与抽屉"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么把它抽成一个**不 import React** 的纯文件
 * ─────────────────────────────────────────────────────────────────────
 * `03` §4.1 那段状态机只有九行，但它规定了**五处**互相制约的东西：
 *
 * ```
 *   idle ──发送（建会话 + 建流）──▶ sending ──首个 round 出现──▶ streaming ──┐
 *     ▲                                                                │      │
 *     │                                                  点[停止] ──────┘      │
 *     │                                                     ▼                 │
 *     │                                                  stopping ──收口───────┤
 *     └──────────────── 停止 / 完成（收口）────────────────────────────────────┘
 *   confirm 到达 ⇒ 锁输入显示确认卡（优先级最高，可从 streaming/sending 进入）
 * ```
 *
 * ⚠️ **P1-19 删掉了第六态 `elsewhere`**（"别的会话在生成 ⇒ 只能输入、不能发"）。它是
 * "一个轮次槽"（P0-1-34）的产物；多流（`stores/chatStream.ts` 改按会话存）之后"另一条流在跑"
 * 不再是拦阻条件 ⇒ 那个态永远为假，留着就是"测一个不可能发生的状态"。
 *
 *   · **谁可编辑**（streaming 中允许继续输入但发送禁用）；
 *   · **谁可发送**（流式中禁用 ⇒ 这是"防并发"的必要最小集，`shared/src/sse.ts` 文件头 ③）；
 *   · **主按钮是什么**（发送 / 停止 / 停止中 / 发送中——它随状态换形态，不是两个按钮）；
 *   · **占位符与提示行**（同一状态在两处说同一件事，写两遍必然漂移）；
 *   · **Enter 是否等于发送**（中文输入法候选词也用 Enter 确认 ⇒ `isComposing` 时必须不发送）。
 *
 * 这五处若散在 JSX 里，改一条契约要同时改五处，而且**错了不报错**：症状只是"某个状态下按钮
 * 点不动"或"拼音打到一半就发出去了"。做成纯函数之后，它可以被无依赖档（`verify:chat-sse`）
 * 逐状态断言 —— 沿用本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的手法
 * （对照 `backend` 的 `chatContext.ts` / `semaphore.ts`、前端的 `sseParser.ts` / `roundReducer.ts`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 状态的名字与判据都来自"这一轮"和"这次发送"，**不来自草稿或按钮**
 * ─────────────────────────────────────────────────────────────────────
 * 输入：`round`（这一轮的归约态，可能为 `null`）+ `sending`（`send()` 在飞）+ `stopping`
 *      （点了停止、正在等收口）+ `draft`（只用于算"发送按钮是否可点"）。
 * 于是"状态"是**推导出来的**，不是另存一份的 —— 另存一份必然在某条路径上不同步
 * （最典型：前置失败后 round 是 `null` 但状态还停在 `streaming`，输入区从此发不出消息）。
 *
 * ⚠️ **`sending` 不是冗余字段**：从"用户按下发送"到"store 里出现这一轮"之间有一段真实的空窗
 * （先 `POST /api/conversations` 建会话、再 `POST /chat` 建流）。这段窗口里 `round` 还是 `null`，
 * 若只看 `round` 就会判成 `idle` ⇒ 用户再按一次 Enter 会**再建一个会话**（真事故，不是理论风险：
 * `submit` 里清空草稿是异步的 React 状态更新，两次回车都读得到同一份草稿）。
 * 故这一段有名字（`sending`），并且由 {@link createSendGate} 在**同步层**再兜一次。
 */

import type { StreamRound } from './roundReducer.js'

/**
 * 输入区的**五个**状态（`03` §4.1 的 `idle` / `streaming` / `confirm` 三个显式命名，
 * 另两个是本仓落地时**必须**分开的：`sending` 与 `stopping` 是 P0-1-33 定案的两段空窗）。
 * ⚠️ 早先还有第六态 `elsewhere`（P0-1-34 "别的会话在生成"），**P1-19 多流后已删除**。
 */
export type ComposerState = 'idle' | 'sending' | 'streaming' | 'stopping' | 'confirm'

/** 主按钮形态：同一位置在四个状态下的四种样子（`03` §4.1："streaming: 按钮变 [停止]"） */
export interface ComposerPrimary {
  kind: 'send' | 'stop' | 'busy'
  label: string
  disabled: boolean
  /**
   * 点击时该做什么。**只有 `send` / `stop` 两个动作**，`busy` 恒为 `null`
   * （形状上就写不出"停止中还能点出别的事"，省掉 JSX 里的 `if`）。
   */
  action: 'send' | 'stop' | null
}

export interface ComposerView {
  state: ComposerState
  /** 输入框是否可编辑（`confirm` 到达 ⇒ 锁输入，`03` §4.1） */
  canType: boolean
  /** 发送是否可提交（`true` 时 Enter 与按钮都发送） */
  canSend: boolean
  /** `confirm` 到达 ⇒ 整个输入区被占用（渲染层据此把 textarea 置灰 + 显示确认卡） */
  locked: boolean
  primary: ComposerPrimary
  /**
   * 「边跑边插话」入口的可见性（**P1-9 · P4 · R1**）。
   *
   * 只有"本会话是沙箱（TaskAgent）+ 正在 streaming + 草稿非空"时才 `visible` ——
   * 此时输入框里那句还没发出去的话可以**不打断当前一轮**地插给运行中的 agent
   * （服务端投到**助手 turn 边界**）。其余状态一律隐藏（`disabled:true`）。
   */
  steer: ComposerSteer
  placeholder: string
  /** 主按钮下方那行提示（与 `placeholder` 同源，避免"按钮说停止、提示说发送"） */
  hint: string
  /** 状态灯的语义色（`styles/app.css` 的 `.led--*`）—— 与 `hint` 一起表达"现在在干什么" */
  led: 'idle' | 'run' | 'warn'
  /** `.composer__state` 那行显示的状态名（端测/截图时的可读锚点） */
  label: ComposerState
}

/** 「边跑边插话」入口（P1-9 · P4 · R1）的可见性/可用性 */
export interface ComposerSteer {
  visible: boolean
  disabled: boolean
}

/** 非 streaming 态的插话入口（隐藏 + 禁用）—— 一处定义，六处引用，避免各写一份 */
const HIDE_STEER: ComposerSteer = Object.freeze({ visible: false, disabled: true })

export interface ComposerInput {
  /** 当前会话进行中的那一轮（`null` = 空闲）。**必须是"属于当前会话"的那一个**（防串台） */
  round: StreamRound | null
  /** `send()` 在飞（含"建会话 + 建流"这段 `round` 还不存在的窗口） */
  sending: boolean
  /** 用户点了停止、正在等这一轮收口（5s 窗口内） */
  stopping: boolean
  /** 草稿（只用于算 `canSend`；空草稿时按钮禁用，避免"点一下发现没反应"） */
  draft: string
  /**
   * 服务端侧**还有一轮在跑，但本页没有它的事件流**（2026-10-22；`stores/chatStream.ts#serverRun`）。
   * 缺省 `false` ⇒ 与引入前逐字一致（与 `steerable` 同款：缺省值即历史行为）。
   */
  serverRunning?: boolean
  /**
   * 本会话是否支持**中途插话**（P1-9 · P4 · R1；**P1-20 起两种会话都支持**）。
   * 判据在页面（现在恒为 `true`）；缺省 `false` ⇒ 与引入前逐字一致（`view.steer` 恒隐藏）。
   * ⚠️ 真正的"能不能插"仍由本状态机决定：只在 `streaming`（正在生成）且草稿非空时放出。
   */
  steerable?: boolean
}

/** 各状态的文案。**一处定义**：placeholder / hint / 按钮 label 全从这里取 */
const TEXT = {
  idle: {
    placeholder: '输入消息，Enter 发送，Shift+Enter 换行…',
    hint: 'Enter 发送 · Shift+Enter 换行',
  },
  sending: {
    placeholder: '正在建立连接…',
    hint: '正在发送，稍候即可继续输入',
  },
  streaming: {
    placeholder: '正在生成，可以先构思下一条…',
    hint: '流式中仍可输入，点「停止」可中断这一轮',
  },
  stopping: {
    placeholder: '正在停止，已生成的内容会保留…',
    hint: '已发出停止信号，等这一轮收口（约 5 秒内）',
  },
  confirm: {
    placeholder: '请先处理上面的确认卡',
    hint: '有待确认的工具调用，输入区暂不可用',
  },
} as const satisfies Record<ComposerState, { placeholder: string; hint: string }>

/**
 * 由"这一轮 + 这次发送"推出输入区的样子。
 *
 * 优先级（顺序即正确性，四条都有真实的错法）：
 *   ① `confirm` —— 它在 `03` §4.1 里写的是"**锁输入**显示确认卡"：即使这一轮还在 streaming，
 *      也要锁（确认卡是"流挂起等你应答"，此时能编辑正文没有任何意义）；
 *   ② `stopping` —— 用户已经点过停止 ⇒ 主按钮必须立刻变成"停止中"（而不是仍可再点一次
 *      「停止」：那会让用户以为没点上，反复点）；
 *   ③ `round.streaming` —— 服务端正在产出（`03` §4.1 唯一的"正经流式态"）；
 *   ④ `sending` —— 上面那段"建会话/建流"的空窗（`round` 还不存在，但它已经不是 `idle` 了）。
 */
export function composeState(input: ComposerInput): ComposerView {
  const { round, sending, stopping, draft, steerable = false, serverRunning = false } = input

  // ① confirm：锁输入（优先级最高）
  if (round !== null && round.confirm !== null) {
    return {
      state: 'confirm',
      canType: false,
      canSend: false,
      locked: true,
      primary: { kind: 'busy', label: '等待确认', disabled: true, action: null },
      steer: HIDE_STEER,
      ...TEXT.confirm,
      led: 'warn',
      label: 'confirm',
    }
  }

  // ② stopping：点过停止、等收口
  if (stopping) {
    return {
      state: 'stopping',
      canType: true,
      canSend: false,
      locked: false,
      primary: { kind: 'busy', label: '停止中…', disabled: true, action: null },
      steer: HIDE_STEER,
      ...TEXT.stopping,
      led: 'warn',
      label: 'stopping',
    }
  }

  // ③ streaming：按钮变 [停止]；**输入不禁**（`03` §4.1："streaming 中允许继续输入但发送禁用"）。
  //    ★ P1-9 · P4 · R1：沙箱会话在此态下，草稿非空时额外露出「插话」入口（不打断当前一轮）。
  if (round !== null && round.status === 'streaming') {
    return {
      state: 'streaming',
      canType: true,
      canSend: false,
      locked: false,
      primary: { kind: 'stop', label: '停止', disabled: false, action: 'stop' },
      steer: { visible: steerable && draft.trim() !== '', disabled: false },
      ...TEXT.streaming,
      led: 'run',
      label: 'streaming',
    }
  }

  // ④ sending：建会话 / 建流的空窗
  if (sending) {
    return {
      state: 'sending',
      canType: true,
      canSend: false,
      locked: false,
      primary: { kind: 'busy', label: '发送中…', disabled: true, action: null },
      steer: HIDE_STEER,
      ...TEXT.sending,
      led: 'run',
      label: 'sending',
    }
  }

  // ④′ **服务端在跑但本页没有这一轮**（2026-10-22）：切走再切回 / 刷新后进入 / **外部
  //    Open API 调用**与定时任务后台运行。✅ 这一轮**不归本页** ⇒ 主按钮不能给「停止」
  //    （没有可收口的流，点了只会发一个无法确认的信号），发送也禁用（服务端有锁，发必冲突）。
  //    早先这里直接落到 `idle`，界面上看不出"它还在跑"—— 用户只能从消息流末尾那行状态里读出来。
  if (serverRunning) {
    return {
      state: 'streaming',
      canType: true,
      canSend: false,
      locked: false,
      primary: { kind: 'busy', label: '正在生成…', disabled: true, action: null },
      steer: HIDE_STEER,
      placeholder: '正在生成（不是本页发起），可以先构思下一条…',
      hint: '这一轮由别处发起（外部调用 / 定时任务 / 另一个窗口），结束后即可继续',
      led: 'run',
      label: 'streaming',
    }
  }

  // idle：可输入、可发送（草稿为空时按钮禁用 —— 只禁用按钮，Enter 也照样空转，
  //       两者同源：`canSend` 就是唯一的判据）
  const canSend = draft.trim() !== ''
  return {
    state: 'idle',
    canType: true,
    canSend,
    locked: false,
    primary: { kind: 'send', label: '发送', disabled: !canSend, action: 'send' },
    steer: HIDE_STEER,
    ...TEXT.idle,
    led: 'idle',
    label: 'idle',
  }
}

/**
 * Enter / Shift+Enter 的判据（`03` §4.1："Enter 发送 / Shift+Enter 换行"；§七 键盘约定）。
 *
 * ⚠️ **`isComposing` 时必须返回 `false`**：中文输入法的**候选词也用 Enter 确认**
 * （`keydown` 的 `key` 仍是 `'Enter'`），少了这一条的症状是
 * "我打「你好」的时候，拼音打到一半就发出去了" —— 这是端测（`README` ㉕）能一眼看出来的缺陷，
 * 而它在本函数里是一行断言的事。
 *
 * 其余按键、以及 `Enter + Shift`（换行）都不提交。
 */
export function isSubmitKey(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey) return false
  if (event.isComposing) return false
  return true
}

/**
 * 同标签页重复发送的**同步**闸门（P0-1-33）。
 *
 * 为什么状态机之外还要它：React 的重渲染是异步的 —— 两次极快的 Enter（或在同一个事件循环里
 * 被触发的第二次提交）都读得到"还没更新"的 `draft`，于是两道请求同时发出。
 * 后果不是"多发一条"这么轻：`send()` 在"还没有会话"时会**各建一个会话**
 * （`03` §4.1：首条消息才建会话）⇒ 用户看到两个空会话、第一条消息落在其中一个。
 *
 * 故闸门必须是**同步的**（一个布尔量，进入即置位），与渲染无关：
 *   · `enter()` —— 拿到闸门返回 `true`，否则说明上一次发送还没结束；
 *   · `leave()` —— 释放（放在 `finally` 里，任何失败路径都要放）。
 *
 * ⚠️ 它**不是**"服务端互斥"的替代品：两者管的是不同的事 ——
 *   · 这道闸门管"同一个标签页别发两遍"（预防）；
 *   · 服务端的 `CONFLICT`（`chat.active:{id}` 锁）管"任何客户端都只能有一个流"（兜底）。
 * 断线后本地以为空闲、服务端还在跑的那种情况，只有服务端的锁拦得住 ⇒ 前端仍要处理 `CONFLICT`
 * （专用 toast，见 `streamErrors.ts`）。
 */
export interface SendGate {
  /** 尝试占用：`true` = 可以发（调用方**必须**在 `finally` 里 `leave()`） */
  enter: () => boolean
  leave: () => void
  /** 当前是否有人在发（调试/断言用） */
  readonly busy: boolean
}

export function createSendGate(): SendGate {
  let busy = false
  return {
    enter: () => {
      if (busy) return false
      busy = true
      return true
    },
    leave: () => {
      busy = false
    },
    get busy() {
      return busy
    },
  }
}
