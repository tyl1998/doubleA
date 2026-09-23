/**
 * 停止时序（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §4.1 的输入区状态机原文 ——
 *      **"停止时序：点[停止] → POST /stop → 等 `done{STOPPED}` 收口；5s 未收口才 abort fetch，
 *      随后拉历史对齐"**（`04` 评审报告第 10 条把它列为"必须写明"的一条）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不能"点停止就 abort"（`06` P0-1-33 的坑预判原文）
 * ─────────────────────────────────────────────────────────────────────
 * `abort()` 断的是**读流这一侧**，服务端可能在同一个 TCP 包里已经把最后一段 `delta` 发出来了
 * （P0-1-12 的坑 ②："响应已在同一个包里缓冲好时，`abort()` 之后 `for await` 仍会把缓冲读完"
 * 说的是相反方向的同一件事）。直接 abort 的后果是**丢掉最后一段已生成内容**，
 * 与本批验收原文"停止后……不丢已生成内容"直接冲突。
 * 故顺序是：**先请求服务端收口（`/stop` 只写键）→ 等服务端自己发 `done{STOPPED}`（那条消息
 * 因此也能带上 `messageId` 落库）→ 只有等不到时才用 abort 兜底**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条路径（`stop-request-failed` 这条路是"兜底不能省"的直接推论）
 * ─────────────────────────────────────────────────────────────────────
 * | 路径 | 触发 | 处置 |
 * |------|------|------|
 * | `nothing-to-stop` | 此刻没有在跑的这一轮 | 什么都不做（不发请求、不 abort） |
 * | `already-running` | 上一次停止还在窗口里 | 直接返回（**不重复 POST**：双击不该产生两个请求） |
 * | `settled` | 窗口内等到了 `done` / `error` | 拉历史对齐（**不 abort** —— 流已经自己收口了） |
 * | `settled-locally` | 窗口内没等到 | `abort()` 兜底 + 客户端侧收口 + 拉历史对齐 |
 * | `stop-request-failed` | `POST /stop` 自己失败（网络 / 401 / 404） | **不等窗口**，直接 abort + 对齐 |
 *
 * 最后一条值得单独说：用户点了停止，界面**必须立刻有反应**。若因为"停止信号没发出去"就
 * 停在 `stopping` 上干等 5 秒，用户看到的是一个**点了没反应的按钮** —— 而真正该做的是
 * 用 abort 兜底（本地至少能停下来），再把失败如实报出来。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 可注入：窗口是**参数**，不是常量
 * ─────────────────────────────────────────────────────────────────────
 * `06` §六 的验收纪律"窗口类配置：注入小值，或等过窗口再断言" —— 生产取
 * {@link STOP_SETTLE_TIMEOUT_MS}（5s，`03` §4.1 点名的数），验收脚本注入 30ms 一类的值，
 * 于是"5s 未收口才 abort"这条规则能被**真的跑到**，而不是靠等 5 秒、也不是靠读代码相信它。
 * 三个副作用（`requestStop` / `waitSettled` / `abort` / `align`）全部由调用方注入 ⇒
 * 本文件不 import React、不 import store、不碰 fetch，可以被无依赖档直接断言**调用顺序**。
 *
 * ⚠️ **`signaled` 不参与控制流**：`POST /stop` 的响应里 `signaled:false` 表示"服务端此刻没有
 * 在生成的回答"（`shared/src/conversation.ts#stopConversationResultSchema`），它是**竞态的正常
 * 结果**而不是失败。本实现照样走 5s 窗口 —— 因为"服务端没有锁"与"这条 TCP 上的流已经死了"
 * 无法区分，而窗口的代价只是最多 5 秒（服务端真的停了的话，那条流通常已经在收尾）。
 * 它只用于**提示文案**（`README` 的端测清单里那条"刚结束就点停止"的用例）。
 */

/** 停止收口窗口（`03` §4.1 点名的 5s）。注入 `timeoutMs` 可覆盖它 */
export const STOP_SETTLE_TIMEOUT_MS = 5000

/** 停止过程中走过的阶段（`onPhase` 回调的入参；联调时按它看时序，不靠猜） */
export type StopPhase = 'signaling' | 'waiting' | 'settled' | 'aborted' | 'aligned'

/** `stop()` 的结果。**页面据此决定说什么**（本文件不产生任何用户可见文案） */
export type StopOutcome =
  | { kind: 'nothing-to-stop' }
  | { kind: 'already-running' }
  | { kind: 'settled'; signaled: boolean }
  | { kind: 'settled-locally'; signaled: boolean; timeoutMs: number }
  | { kind: 'stop-request-failed'; error: unknown; timeoutMs: number }

export interface StopDeps {
  /** 此刻是否真的有一轮在跑（没有就什么都不做） */
  isRunning: () => boolean
  /**
   * `POST /api/conversations/:id/stop`。
   * 返回 `{ signaled }`：`false` = 服务端此刻没有在生成的回答（**正常竞态**，不是失败）。
   */
  requestStop: () => Promise<{ signaled: boolean }>
  /** 等这一轮收口；`true` = 在 `timeoutMs` 内等到了（见 {@link waitForRoundSettled}） */
  waitSettled: (timeoutMs: number) => Promise<boolean>
  /** 兜底中断读流（**只有等不到收口时才允许调用**） */
  abort: () => void
  /** 拉历史对齐（`03` §4.1 的"随后拉历史对齐"）—— 三条收尾路径都会走到它 */
  align: () => Promise<void>
  /** 窗口（默认 {@link STOP_SETTLE_TIMEOUT_MS}）；验收注入小值 */
  timeoutMs?: number
  /** 每阶段留痕（可选） */
  onPhase?: (phase: StopPhase) => void
}

export interface StopController {
  /**
   * 点一次「停止」。**幂等**：窗口内重复调用直接返回 `already-running`，不会重复发请求。
   * 无论走哪条路径，`stopping` 都会在返回前复位（放在 `finally` 里）。
   */
  stop: () => Promise<StopOutcome>
  /** 是否正在窗口里（渲染层据此把按钮换成"停止中…"） */
  readonly stopping: boolean
}

/**
 * 创建停止控制器。
 *
 * 做成闭包（而不是一个自由函数）的**唯一**理由是那个"正在停止"的闸门：它必须与
 * {@link StopController.stop} 同一个生命周期，放在页面里就会变成"谁都能改的一个布尔量"。
 */
export function createStopController(deps: StopDeps): StopController {
  const timeoutMs = deps.timeoutMs ?? STOP_SETTLE_TIMEOUT_MS
  let stopping = false

  const stop = async (): Promise<StopOutcome> => {
    if (stopping) return { kind: 'already-running' }
    if (!deps.isRunning()) return { kind: 'nothing-to-stop' }

    stopping = true
    try {
      // ① 请求服务端收口。它只写 `chat.stop:{id}`，真正"停了"由 `done{STOPPED}` 宣布
      deps.onPhase?.('signaling')
      let signaled: boolean
      try {
        const result = await deps.requestStop()
        signaled = result.signaled
      } catch (error) {
        // 兜底不能省（见文件头）：用户点了停止，界面必须立刻有反应
        deps.onPhase?.('aborted')
        deps.abort()
        await deps.align()
        deps.onPhase?.('aligned')
        return { kind: 'stop-request-failed', error, timeoutMs }
      }

      // ② 等流内 `done{STOPPED}` —— 这一步就是"不丢最后一段 delta"的全部实现
      deps.onPhase?.('waiting')
      const settled = await deps.waitSettled(timeoutMs)

      if (!settled) {
        // ③ 窗口内没收口 ⇒ abort 兜底（服务端已收到停止信号，已生成部分照样落库）
        deps.onPhase?.('aborted')
        deps.abort()
      } else {
        deps.onPhase?.('settled')
      }

      // ④ 拉历史对齐（两条路径都要）：收口后的落库版本才是"刷新后能看到的那一份"
      await deps.align()
      deps.onPhase?.('aligned')

      return settled ? { kind: 'settled', signaled } : { kind: 'settled-locally', signaled, timeoutMs }
    } finally {
      // 复位必须在这里：`align()` 抛错时若不复位，输入区会永远卡在"停止中"
      stopping = false
    }
  }

  return {
    stop,
    get stopping() {
      return stopping
    },
  }
}

// ───────────────────────────── 「等这一轮收口」 ─────────────────────────────

/** 观察"这一轮是否已收口"所需的两件事（抽出来是为了让无依赖档能注入一个假的） */
export interface SettleWatchDeps {
  /** 订阅状态变化，返回退订函数（`useChatStreamStore.subscribe` 即可） */
  subscribe: (listener: () => void) => () => void
  /**
   * 当前是否已经收口。
   * ⚠️ **`round` 为 `null` 也算收口**（没有任何一轮在跑 ⇒ 没什么可等的）——
   * 少了这一条，`reset()` 之后 `waitSettled` 会一直等到超时（症状是"点了停止 5 秒后才恢复"）。
   */
  isSettled: () => boolean
}

/**
 * 等这一轮收口；`true` = 在 `timeoutMs` 内等到了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条必须写对的细节
 * ─────────────────────────────────────────────────────────────────────
 * ① **先判一次再订阅**：`done{STOPPED}` 完全可能在 `POST /stop` 回来之前就到了
 *    （服务端本来就快收尾了）⇒ 只订阅的话会白等满 5 秒。
 * ② **两条出口都要退订 + 清定时器**：否则每点一次停止泄漏一个监听器与一个定时器
 *    （本仓 P0-1-26 有一条同族教训：监听器泄漏的唯一线索是 `MaxListenersExceededWarning`）。
 *    验收对应用例断言"收口后活动订阅数回到 0"。
 * ③ **它不抛错**：超时是**正常返回值**（`false`），由调用方决定 abort。把它写成"超时抛错"
 *    会让调用方多一层 try/catch，而那个 catch 里能做的事与返回值一模一样。
 */
export function waitForRoundSettled(deps: SettleWatchDeps, timeoutMs: number): Promise<boolean> {
  if (deps.isSettled()) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (unsubscribe !== null) {
        unsubscribe()
        unsubscribe = null
      }
    }

    unsubscribe = deps.subscribe(() => {
      if (!deps.isSettled()) return
      cleanup()
      resolve(true)
    })

    timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
  })
}
