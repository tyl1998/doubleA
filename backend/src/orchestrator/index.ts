/**
 * 编排层入口（P0-1-26 起）
 *
 * 这一层是"对话怎么发生的"：SSE 出口（`sse.ts`）负责把帧写对，编排循环负责**产生**帧。
 * 本文件只解决一个问题：**路由该调用哪个 producer** —— 也就是"下一批落地时改哪一行"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本批（P0-1-26）的 producer 是**占位**的：它是一条"空流"
 * ─────────────────────────────────────────────────────────────────────
 * `docs/06` P0-1-26 的产出只有 `orchestrator/sse.ts`（通道、互斥、停止、心跳）；
 * 真正的编排循环 —— 并发闸、上下文组装（system prompt + 检索块 + 最近 N 轮历史）、
 * LLM 流式调用、`citations`、`done` 时整条消息落库与计量 —— 属 **P0-1-27**
 * （`orchestrator/chatBot.ts`）。
 *
 * 为什么现在仍要注册 `POST /:id/chat`：本批的验收原文要求"**手动发一个空流**观察 `ping`
 * 按间隔到达 / 同会话并发得 CONFLICT / 停止后 5s 内收到 `done{STOPPED}`" —— 三条都只有在
 * 端点真的存在、真的开出一条流时才验得了。于是占位 producer 的行为就是那句验收原文本身：
 * **不发任何内容事件、不落库，只在被中断时收尾**。
 *
 * 这条边界的对外说法（写进 README 的"已知边界"，别当 bug）：
 *   · `POST /:id/chat` 现在会返回 `200 text/event-stream`，之后**只有 `ping` 心跳**；
 *   · 它**不会自己结束**，直到你调 `POST /:id/stop` 或断开连接；
 *   · 因此 `/active` 会读到 `streaming:true`（锁确实在），且**没有任何消息会被写入**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 接回点（P0-1-27 只改下面这一个函数体）
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-27 落地时，把 {@link resolveChatProducer} 的返回换成 `chatBot.ts` 导出的编排循环即可 ——
 * 路由、SSE 通道、互斥锁、停止信号、心跳**都不用动**。这不是"留一个 TODO 占位符"，
 * 而是本批刻意把**接口**先定下来（`ChatProducer` / `ChatProducerInput`）：接口定了，
 * 下一批才是在"实现一个已知形状的东西"，而不是"一边写循环一边改通道"。
 */

import type { ChatProducer } from './sse.js'

/**
 * **占位的编排循环**：一条不发任何事件、不落库的空流，直到被中断。
 *
 * 实现上就是"等中断信号" —— 用 `Promise` 包一次 `abort` 事件，而不是忙等：
 * ```
 * 中断前：await 一个永不 resolve 的 Promise（期间由 SSE 通道发心跳）
 * 中断后：resolve 成 { messageId: null, finishReason: 'STOPPED' }
 * ```
 * `messageId: null` 的含义见 `shared/src/sse.ts` 文件头 ④：**这一轮没有产生可持久化的消息**
 * —— 本批本来就不落库，编一个假 id 才是错的（前端会以为历史里有这条，刷新却查不到）。
 *
 * ⚠️ 它**没有超时**（这也是"空流"的字面意思）：真正的流上限由编排层的上游超时
 * （`LLM_REQUEST_TIMEOUT_MS` / `LLM_STREAM_IDLE_TIMEOUT_MS`）与用户的停止共同约束 ——
 * 在一个占位实现上编一个"30 秒自动结束"的规则，只会变成下一批要删掉的行为。
 */
const placeholderProducer: ChatProducer = async ({ signal, startedAt }) => {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  // `startedAt` 只是让"这条占位流从哪一刻开始的"在调试时可见（也避免解构出空参数）
  void startedAt
  return { messageId: null, finishReason: 'STOPPED', usage: null }
}

/**
 * 取当前生效的编排循环。
 *
 * 刻意做成函数（而不是把 `placeholderProducer` 直接导出去让路由 import）：
 * ① P0-1-27 换实现时**只有这一处**要改，路由那边的 `import` 一行不动；
 * ② 将来若需要按 Agent 类型分流（TaskAgent 走沙箱引擎 —— P0-3），分流的落点也在这里
 *    （那时它要读 `agent.type`，函数签名会自然地长出一个参数，而不是让路由去 if/else）。
 */
export function resolveChatProducer(): ChatProducer {
  return placeholderProducer
}
