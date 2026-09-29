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
 * ⚠️ **产物（`artifacts`）段在 P0-3-7 起属于本函数**（`messageContentSchema` 定型了
 * `artifacts` 段，写入端就是这里）；ChatBot 不传该参数 ⇒ 它的落库口径与从前**逐字不变**。
 */

import type { ArtifactItem, CitationItem, MessageModelSegment, ToolCallRecord } from '@doubulea/shared'
import { deriveConversationTopic } from '@doubulea/shared'

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

/**
 * 一条计量行（`usage_records`，**P0-3-12**；`02` §三 / §七、`01` 决策 20）。
 *
 * ⚠️ **刻意不收 `userId` / `agentId`**（虽然表里有这两列）：它们的唯一权威是**会话行**，
 * 而本函数与消息落库在**同一个事务**里 —— 让那一列在事务内读出来，行与消息才真正同生共死。
 * 由编排层"顺手带下来"的 id 会制造第二种来源（今天它们恰好相等，明天换个调用方就不一定）。
 *
 * ⚠️ **`tokensIn/Out` 允许为 `null`**（引擎没上报 / 不上报 usage 的 provider ⇒ 全程 0，
 * 见 `sandbox/map.ts#readEngineUsage`）：`NULL` = 不知道，`0` = 真的没用 ——
 * `01` 决策 20 明确允许前者，所以**不要**为了"字段不留空"编一个 0。
 * 取不到 token 时这条记录仍然有意义：`durationMs`（我们自己量的）与 `rounds`
 * （引擎自己报的 turn 数）与"有没有上报"无关。
 */
export interface UsageRecordInput {
  /** 上游真实型号名（`LlmTarget.modelName`）。见 `schema.prisma#UsageRecord.model` 的说明 */
  model: string
  tokensIn: number | null
  tokensOut: number | null
  /** 本轮派活的墙钟耗时（**调用方量**；本函数不自己看表 —— 它要的是"这一轮"，不是"这一次落库"） */
  durationMs: number
  /** 引擎这一轮跑了几轮（`turn_start` 条数 = 模型请求次数） */
  rounds: number
  /** ⚠️ 由调用方显式传入（本机 PG 会话时区非 UTC 时 `@default(now())` 会偏一个时区，见 `02` 的已知问题） */
  createdAt: Date
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
  /**
   * 本轮的产出文件（P0-3-7 起；TaskAgent 专属）。**不传 / 空数组都表示"本轮没有产物"** ——
   * `content.artifacts` 段只在非空时出现（`buildAssistantContent` 的省键口径）。
   */
  artifacts?: readonly ArtifactItem[]
  /**
   * 本轮**实际使用**的模型（产品优化 2026-09-29；ChatBot 传、TaskAgent 不传）。
   * 落进助手消息的 `content.model` 段，供"重进会话回显上次用的模型"（见
   * `shared#messageModelSegmentSchema`）。
   */
  model?: MessageModelSegment
  usage: RoundUsage | null
  /**
   * 本轮的计量行（**P0-3-12**；TaskAgent 专属）。
   *
   * **不传 = 这一轮不计量**（口径与 `artifacts` 同款）：
   *   · `chatBot.ts` 至今不传 ⇒ 它的落库口径与从前**逐字不变**（"本版本不写 `usage_records`"
   *     是 **ChatBot 侧**的 P0-1-27 口径；它的接回点就是**这个参数**，P1 传一次即可）；
   *   · TaskAgent 在"**这一轮引擎真的跑过**"时才传（判据在 `taskAgent.ts`：用户排队时点停止
   *     ⇒ 引擎没跑 ⇒ 不计量）。
   *
   * 为什么由本函数写、而不是编排层再开一次写：**与消息同一个事务**。
   * 分开写的后果是两种半截状态 —— "有消息没计量"与"有计量没消息"（后者更糟：账上多了一条
   * 用户翻遍历史也找不到对应对话的用量）。
   */
  usageRecord?: UsageRecordInput
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
 * 助手消息**只在真的有内容时才写**：`text` / `thinking` / `citations` / `tool_calls` / `artifacts`
 * 五者全空时（用户刚发出去就点了停止）不写助手行 —— 留一条空消息会在界面上画出一个空气泡。
 * 此时 `done.messageId` 为 `null`，它的语义正是"**这一轮没有产生可持久化的消息**"
 * （`shared/src/sse.ts` 文件头 ④）。
 * ⚠️ **工具记录也算内容**（P0-2-8）：一轮"只调了工具、还没等到最终回答就被停止"的生成
 * 在界面上是有东西的（工具卡），把它当成"空"会让那一轮的卡片在刷新后消失。
 * ⚠️ **产物同理**（P0-3-7）：一轮"只产出文件、正文为空"的任务在界面上有产物卡，
 * 刷新后要能恢复（产物卡的第二个来源就是 `messages.content.artifacts`）。
 *
 * **落库失败不外抛**：回答已经完整地流给用户看了，此时再用 `error` 帧覆盖掉
 * "回答成功"这件事，是拿一条基础设施故障去否定一个已经发生的事实。
 * 处置是**如实报告**：日志记 error + `messageId: null`（"没有产生可持久化的消息"这句字面为真），
 * 前端据此可以说"本条未写入历史"。⚠️ 代价写在这里：这一轮在历史里查不到（刷新后会消失）。
 */
export async function persistRoundQuietly(input: PersistRoundInput): Promise<string | null> {
  const {
    conversationId,
    content,
    assistantText,
    thinkingText,
    citations,
    toolRecords,
    artifacts,
    model,
    usage,
    usageRecord,
    logger,
  } = input
  const hasAssistantContent =
    assistantText !== '' ||
    thinkingText !== '' ||
    citations.length > 0 ||
    toolRecords.length > 0 ||
    (artifacts?.length ?? 0) > 0
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
              artifacts,
              ...(model === undefined ? {} : { model }),
            }),
            // `tokens_*` 可空（`schema.prisma` 的说明：上游不给 usage 时就是不知道，不编一个 0）
            tokensIn: usage?.tokensIn ?? null,
            tokensOut: usage?.tokensOut ?? null,
          },
        })
        assistantMessageId = created.id
      }
      await touchConversation(tx, conversationId, new Date())
      // ── 自动命名（产品优化 2026-09-29）：首条用户消息落库时给会话一个标题 ──
      // 判据是"`topic` 还是 `null`"（CAS 更新，不是先读再写）：
      //   · 流式中用户手动改名 ⇒ `topic` 已非 null ⇒ 这里不会覆盖（后写覆盖先写是错的）；
      //   · 之后每一轮都一样 —— 标题只由"第一条消息"或"手动重命名"产生，二选一。
      const derivedTopic = deriveConversationTopic(content)
      if (derivedTopic !== '') {
        await tx.conversation.updateMany({
          where: { id: conversationId, topic: null },
          data: { topic: derivedTopic },
        })
      }
      // ── 计量行（P0-3-12）：与上面两条消息、会话活跃时间同一个事务 ──
      // `user_id` / `agent_id` 从**会话行**读（它们是这两个身份的唯一权威，见 `UsageRecordInput`）。
      // ⚠️ 走到这里会话行**必然存在**：上面两条 `message.create` 带着 `conversations` 外键，
      // 同一个事务里它们已经成功过。真为 `null` 只能是"外键被绕过"这种不可能状态 ⇒
      // **直接抛**（整轮回滚 + 外层那条 error 日志），而不是静默跳过这一行 ——
      // 静默跳过正是这条口径要避免的半截状态（"有消息、没账"）。
      if (usageRecord !== undefined) {
        const conversation = await tx.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, agentId: true },
        })
        if (conversation === null) throw new Error(`计量落库时会话行不见了：${conversationId}`)
        await tx.usageRecord.create({
          data: {
            userId: conversation.userId,
            agentId: conversation.agentId,
            model: usageRecord.model,
            tokensIn: usageRecord.tokensIn,
            tokensOut: usageRecord.tokensOut,
            durationMs: usageRecord.durationMs,
            rounds: usageRecord.rounds,
            createdAt: usageRecord.createdAt,
          },
        })
      }
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
