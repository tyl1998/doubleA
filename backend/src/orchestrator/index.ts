/**
 * 编排层入口（P0-1-26 起；P0-1-27 把占位 producer 换成真编排循环；P0-3-6 起按 Agent 类型分流）
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
 * P0-1-27 兑现的结果：**真的一行都没动**。
 *   · `routes/conversations.ts` 的 `/chat` handler 只多传了一个字段（`content`）；
 *   · `sse.ts` 只把 `content` 从入参转交给 producer（并在 `ChatProducerInput` 上写明它为什么存在）；
 *   · 通道部分（帧序列化 / 心跳 / 互斥锁 / 停止信号 / 收尾规则）**零改动**。
 * 这不是巧合：P0-1-26 把 `ChatProducer` / `ChatProducerInput` 这两个类型当成**交付物**
 * 定下来（而不是留一个 TODO），为的就是让本批是在"实现一个已知形状的东西"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ P0-3-6：按 `agent.type` 分流（P0-1-26 预留的那个"自然地长出一个参数"）
 * ─────────────────────────────────────────────────────────────────────
 * 一次会话的编排方式由**智能体类型**决定（`01` 决策 4：ChatBot 主 + TaskAgent 辅）：
 *   · `CHATBOT` → `chatBot.ts`：后端 RAG 编排（检索 + MCP 工具循环）；
 *   · `TASK_AGENT` → `taskAgent.ts`：沙箱里的 pi 引擎（`pi --mode rpc`）+ 容器内工具。
 * 两者产出**同一套 SSE 事件**（`shared/src/sse.ts` 的 10 个），于是前端只有一套渲染路径。
 *
 * ⚠️ 判据来自**库里的 `agents.type`**（`assertConversationSendable` 的 select 里带出来的
 * `agentType`），**不是**请求体 —— 请求体里根本没有这个字段，客户端无从指定"我要哪条链路"。
 *
 * ⚠️ 返回值是那两个 producer 的**模块级常量**（不是新建的闭包）：
 * `chatBot.ts` 里的并发闸是一个模块级信号量（"这个进程同时在跑几轮生成"），而
 * `manager.ts#ensureSandbox` 的名额册同理 —— **状态必须只有一份**，
 * 故不要在返回处包一层闭包去"顺便"做点什么。
 */

import type { AgentType } from '@doubulea/shared'

import { chatBotProducer } from './chatBot.js'
import type { ChatProducer } from './sse.js'
import { taskAgentProducer } from './taskAgent.js'

/**
 * 取当前会话该用的编排循环。
 *
 * 刻意做成函数（而不是把 producer 直接导出去让路由 import）：
 * ① 换实现时**只有这一处**要改，路由那边的 `import` 一行不动（P0-1-26 → P0-1-27 已验证）；
 * ② 按 Agent 类型分流的落点也在这里（P0-1-26 就写下了这句，P0-3-6 兑现）——
 *    于是路由里没有 `if (type === …)`，它连"有几种链路"都不需要知道。
 *
 * ⚠️ `switch` 而不是三元：将来加第三种类型（如 `01` 里的其它形态）时，
 * 漏一支会由 TS 的穷尽性检查报出来，而不是静默落到某个"默认"上。
 */
export function resolveChatProducer(agentType: AgentType): ChatProducer {
  switch (agentType) {
    case 'TASK_AGENT':
      return taskAgentProducer
    case 'CHATBOT':
      return chatBotProducer
  }
}
