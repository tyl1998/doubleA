/**
 * 进程级并发闸（P0-1-27）
 *
 * 依据：`docs/02-后端设计.md` §六 第 1 步「并发闸：信号量（上限 50），满则 `error{code: BUSY}`」
 *      + §十一（`CHATBOT_CONCURRENCY`）+ `01` 决策 8（并发控制）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（而不是写在 `chatBot.ts` 里）
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**不 import 任何东西**（不碰 `config`、不碰 `prisma`、不碰日志）——
 * 于是它的上下界断言可以进**无依赖档**（`verify:app`），不需要 PG/Redis/上游。
 * 同 `pipeline/chunk/` 的手法（P0-1-18 定案）：**能在无依赖档验的纯逻辑，别让它粘上依赖**。
 * 用到 `config` 的那一行留在 `chatBot.ts`（`createSemaphore(config.concurrency.chatbot)`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么"满了立刻拒"而不是排队
 * ─────────────────────────────────────────────────────────────────────
 * `02` §六 给两个编排器的口径是**不同**的，别照着邻居抄：
 *   · **ChatBot**（本文件）：满 ⇒ `error{code: BUSY}`（429 的语义）。用户可以重发，且立刻知道自己
 *     被拒了 —— 这比"消息发出去之后毫无反馈地挂着"好；
 *   · **TaskAgent**（P0-3）：满 ⇒ `queued` 事件 + 排队位次（沙箱是最贵的资源，等待是常态）。
 * 排队在 ChatBot 这一侧没有对应的 UI（`03` §五 的 `queued` 行写的是"沙箱并发满"），
 * 顺手给 ChatBot 也做一个排队队列，只会造出一种前端不知道该画什么的中间态。
 *
 * ⚠️ **闸门的粒度是"一次生成"，不是"一条流"**：占名额的是"正在调 LLM 的这一轮"，
 * 而 SSE 通道本身（帧/心跳/锁）不占名额 —— 与 `orchestrator/sse.ts` 文件头那句
 * "并发闸属 P0-1-27（进程级信号量）"是同一件事的两面。
 */

export interface Semaphore {
  /**
   * 尝试占一个名额。
   *
   * @returns 占到了就返回**释放函数**（幂等：重复调用只释放一次，不会把计数减负）；
   *          满则返回 `null` —— **刻意不返回 Promise**：不排队（见文件头）。
   */
  tryAcquire(): (() => void) | null
  /** 当前在飞的数量（日志与验收用；不是控制路径） */
  readonly inFlight: number
  /** 上限（构造时定，便于日志里写出"x/limit"） */
  readonly limit: number
}

/**
 * 造一个计数信号量。
 *
 * @param limit 上限。`< 1` 会被抬到 1：`0` 会让**所有**请求都被拒（一个永远打不开的服务），
 *   而"0 个并发"不是任何一个部署想要的语义（要停服务应该走停机，不是把闸门关成 0）。
 */
export function createSemaphore(limit: number): Semaphore {
  const capacity = Math.max(1, Math.floor(limit))
  let inFlight = 0

  return {
    tryAcquire(): (() => void) | null {
      if (inFlight >= capacity) return null
      inFlight += 1
      let released = false
      return () => {
        // 幂等：调用方可能把它放进 `finally`，而异常路径上又手动释放过一次。
        // 不幂等的后果是计数**减负** ⇒ 闸门形同不存在（上限被悄悄放到无穷）。
        if (released) return
        released = true
        inFlight -= 1
      }
    },
    get inFlight(): number {
      return inFlight
    },
    get limit(): number {
      return capacity
    },
  }
}
