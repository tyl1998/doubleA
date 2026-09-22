/**
 * 编排层入口（P0-1-26 起；**P0-1-27 把占位 producer 换成真编排循环**）
 *
 * 这一层是"对话怎么发生的"：SSE 出口（`sse.ts`）负责把帧写对，编排循环负责**产生**帧。
 * 本文件只解决一个问题：**路由该调用哪个 producer**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 接回点已兑现（P0-1-26 留的那一句"下一批只改这里"）
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-26 的 producer 是**占位**的（只发 `ping` 的空流），当时的承诺是：
 * "P0-1-27 落地时，把 {@link resolveChatProducer} 的返回换成 `chatBot.ts` 导出的编排循环
 * 即可 —— 路由、SSE 通道、互斥锁、停止信号、心跳**都不用动**"。
 *
 * 本批兑现的结果：**真的一行都没动**。
 *   · `routes/conversations.ts` 的 `/chat` handler 只多传了一个字段（`content`）；
 *   · `sse.ts` 只把 `content` 从入参转交给 producer（并在 `ChatProducerInput` 上写明它为什么存在）；
 *   · 通道部分（帧序列化 / 心跳 / 互斥锁 / 停止信号 / 收尾规则）**零改动**。
 * 这不是巧合：P0-1-26 把 `ChatProducer` / `ChatProducerInput` 这两个类型当成**交付物**
 * 定下来（而不是留一个 TODO），为的就是让本批是在"实现一个已知形状的东西"。
 *
 * ⚠️ 唯一被迫改契约的地方在这里，记一笔：`ChatProducerInput` 原本**没有用户消息正文** ——
 * P0-1-26 的占位实现不需要它（它不检索、不落库）。而编排循环既要拿它当检索 query、
 * 又要拿它当"落库时用户消息的正文"（此刻那条消息还没落库，见 `02` §5.2"事件即真相"）
 * ⇒ 加 `content` 字段。这个字段**只能由出口层转交**（路由 → `streamChatReply` → producer），
 * 因为只有路由见过请求体。
 */

import type { ChatProducer } from './sse.js'
import { chatBotProducer } from './chatBot.js'

/**
 * 取当前生效的编排循环。
 *
 * 刻意做成函数（而不是把 producer 直接导出去让路由 import）：
 * ① 换实现时**只有这一处**要改，路由那边的 `import` 一行不动（P0-1-26 → P0-1-27 已验证）；
 * ② 将来若需要按 Agent 类型分流（TaskAgent 走沙箱引擎 —— P0-3），分流的落点也在这里
 *    （那时它要读 `agent.type`，函数签名会自然地长出一个参数，而不是让路由去 if/else）。
 *
 * ⚠️ 返回值是 `chatBotProducer` 这个**模块级常量**（不是箭头函数）：并发闸是
 * `chatBot.ts` 里的一个模块级信号量（"这个进程同时在跑几轮生成"）—— 每次调用都新建一个
 * producer 无所谓（它不持有状态），但**状态必须只有一份**，故不要在返回处包一层闭包去"顺便"做点什么。
 */
export function resolveChatProducer(): ChatProducer {
  return chatBotProducer
}
