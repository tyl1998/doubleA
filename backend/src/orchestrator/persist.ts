/**
 * 一轮问答的落库（**P0-3-6 从 `chatBot.ts` 原样抽出**）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么抽出来（而不是在 `taskAgent.ts` 里再写一份）
 * ─────────────────────────────────────────────────────────────────────
 * P0-3-6 起**两个编排器**（`chatBot.ts` 的 ChatBot、`taskAgent.ts` 的 TaskAgent）都要在收尾时
 * 落同一件事：这一轮的用户消息 + 助手消息（`content` 的三段：正文 / 思考 / 工具卡）+ 活跃时间，
 * 且都要求"**一个事务**"与"**失败不外抛**"。
 * 两处各写一遍的后果不是"多几行代码"，而是**两套落库口径**会各自演化：
 * 比如"助手消息什么时候该写"（内容全空就不写）这条判据只要在一处被改松，刷新之后就会多出
 * 一个空气泡，而**没有任何一条断言会红**（`docs/06` §六 第 ⑰ 条："同一口径在两处各写一遍，
 * 必有一处先腐烂"）。
 *
 * ⚠️ 行为**逐字未变**（P0-3-6 只搬位置 + 收窄 usage 的入参类型）—— 想核对时对照
 * `git log -p -- backend/src/orchestrator/chatBot.ts` 里删除的那一段。
 *
 * ⚠️ **产物（`artifacts`）不在本函数里**：`messageContentSchema` 目前**没有** `artifacts` 段
 * （属 P0-3-7 / P0-3-10 的契约增量），本函数照原口径只写 `text` / `thinking` / `citations` / `tool_calls`。
 */

import type { CitationItem, ToolCallRecord } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { touchConversation } from '../services/conversation.service.js'
import { buildAssistantContent } from './chatContext.js'

/**
 * 落库需要的那两项用量。
 *
 * 收成自己的类型（而不是直接收 `llm/client.ts` 的 `ChatUsage`）是因为**两个编排器的用量来源
 * 完全不同**：ChatBot 那份由 `sumUsages` 把多轮上游相加得到，TaskAgent 那份由引擎的
 * `message_update.usage` 累积覆盖得到（`sandbox/map.ts#readEngineUsage`）。
 * 落库只关心这两列 ⇒ 入参窄到"这两列"就不会诱导谁来这边取第三个数
 * （`ChatUsage` 结构上仍满足它，调用方一个字段都不用改）。
 */
export interface RoundUsage {
  tokensIn: number | null
  tokensOut: number | null
}

/** {@link persistRoundQuietly} 的入参 */
export interface PersistRoundInput {
  conversationId: string
  content: string
  assistantText: string
  thinkingText: string
  citations: CitationItem[]
  /** 本轮的工具调用记录（P0-2-8 起：ChatBot 是 `kind=MCP`，P0-3-6 起 TaskAgent 是 `kind=SANDBOX`） */
  toolRecords: readonly ToolCallRecord[]
  usage: RoundUsage | null
  logger: ReturnType<typeof getLogger>
}

/**
 * 把这一轮落库：**用户消息 + 助手消息 + 活跃时间，同一个事务**。
 *
 * 三件事一起做的理由（`02` §4.5 ④）：`touchConversation` 的签名收
 * `Pick<PrismaClientInstance,'conversation'>` **就是为了能被这里的 `tx` 直接传入** ——
 * 它自己不开事务，否则"消息落库"与"活跃时间"会变成两次写入（中间失败就出现
 * "会话里有消息、侧栏却不动"）。
 *
 * 助手消息**只在真的有内容时才写**：`text` / `thinking` / `citations` / `tool_calls` 四者全空时
 * （用户刚发出去就点了停止）不写助手行 —— 留一条空消息会在界面上画出一个空气泡。
 * 此时 `done.messageId` 为 `null`，它的语义正是"**这一轮没有产生可持久化的消息**"
 * （`shared/src/sse.ts` 文件头 ④）。
 * ⚠️ **工具记录也算内容**（P0-2-8）：一轮"只调了工具、还没等到最终回答就被停止"的生成
 * 在界面上是有东西的（工具卡），把它当成"空"会让那一轮的卡片在刷新后消失。
 *
 * **落库失败不外抛**：回答已经完整地流给用户看了，此时再用 `error` 帧覆盖掉
 * "回答成功"这件事，是拿一条基础设施故障去否定一个已经发生的事实。
 * 处置是**如实报告**：日志记 error + `messageId: null`（"没有产生可持久化的消息"这句字面为真），
 * 前端据此可以说"本条未写入历史"。⚠️ 代价写在这里：这一轮在历史里查不到（刷新后会消失）。
 */
export async function persistRoundQuietly(input: PersistRoundInput): Promise<string | null> {
  const { conversationId, content, assistantText, thinkingText, citations, toolRecords, usage, logger } = input
  const hasAssistantContent =
    assistantText !== '' || thinkingText !== '' || citations.length > 0 || toolRecords.length > 0
  try {
    const db = getPrisma()
    return await db.$transaction(async (tx) => {
      await tx.message.create({
        data: { conversationId, role: 'USER', content: { text: content } },
      })
      let assistantMessageId: string | null = null
      if (hasAssistantContent) {
        const created = await tx.message.create({
          data: {
            conversationId,
            role: 'ASSISTANT',
            content: buildAssistantContent({
              text: assistantText,
              thinking: thinkingText,
              citations,
              toolCalls: toolRecords,
            }),
            // `tokens_*` 可空（`schema.prisma` 的说明：上游不给 usage 时就是不知道，不编一个 0）
            tokensIn: usage?.tokensIn ?? null,
            tokensOut: usage?.tokensOut ?? null,
          },
        })
        assistantMessageId = created.id
      }
      await touchConversation(tx, conversationId, new Date())
      return assistantMessageId
    })
  } catch (error) {
    logger.error(
      { err: error, conversationId, hasAssistantContent, generatedChars: assistantText.length },
      '本轮消息落库失败（回答已流给用户，但历史里不会有这一轮）',
    )
    return null
  }
}
