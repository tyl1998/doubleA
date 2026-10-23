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

import type {
  ArtifactItem,
  AttachmentItem,
  CitationItem,
  MessageModelSegment,
  SteerRecord,
  ThinkingSegment,
  ToolCallRecord,
  UsageChannel,
} from '@doubulea/shared'
import { deriveConversationTopic } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import {
  ensureRedisConnected,
  OPEN_API_DAILY_TOKEN_TTL_SEC,
  openApiDailyTokenKey,
} from '../infra/redis.js'
import { touchConversation } from '../services/conversation.service.js'
import { buildAssistantContent } from './chatContext.js'
import { generateConversationTitle } from './titleGenerate.js'

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
  /**
   * 调用来源（**P1-22** · X1）：`INTERNAL`（平台界面）/ `OPEN_API`（开放平台）。
   * 不传 = `INTERNAL`（库列默认值同值）⇒ 内部路径**零改动**，回归断言"内部聊一轮后
   * `channel='INTERNAL' ∧ open_key_id IS NULL`"因此天然成立。
   */
  channel?: UsageChannel
  /** 仅 `OPEN_API` 行有值（哪把 Key 花掉的）；内部行为 `undefined` ⇒ 库里 NULL */
  openKeyId?: string | null
}

/** {@link persistRoundQuietly} 的入参 */
export interface PersistRoundInput {
  conversationId: string
  content: string
  /**
   * 本轮用户消息携带的附件（**P1-4**；落进 USER 消息的 `content.attachments` 段）。
   * 不传 / 空数组都表示"本轮没有附件" —— 省键即"本来就没有"（与 `artifacts` 同口径）。
   */
  attachments?: readonly AttachmentItem[]
  assistantText: string
  /**
   * 本轮思考的**分段文本**（2026-10-21；每段一次模型请求里的推理）。
   * 空数组 ⇒ 落库不写 `thinking_segments` 键（与 `citations` 同款口径）。
   */
  thinkingSegments: readonly ThinkingSegment[]
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
  /**
   * 本轮**中途插话**（2026-10-21；落进助手消息的 `content.steers` 段）。
   * 不传 / 空数组 ⇒ 省键（本轮没有投递过的插话）。被撤回的插话由编排层摘掉后再传（见 `taskAgent.ts`）。
   */
  steers?: readonly SteerRecord[]
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
 * 去掉字符串里的 **NUL（`\u0000`）** —— 落库前的最后一道清洗（**递归覆盖整份 `content`**）。
 *
 * ⚠️ **为什么必须在写入端做**：Postgres 的 `text` / `jsonb` **存不了 NUL**
 * （驱动报 `22P05 unsupported Unicode escape sequence` / `\u0000 cannot be converted to text`）。
 * 而沙箱（TaskAgent）里读二进制文件、或引擎/上游把 NUL 混进 `thinking` / `delta` / 工具 `output`
 * 都是真实会发生的 ⇒ 只要某一轮的内容里有一个 `\u0000`，**整个落库事务回滚**。
 * 后果不是"少存一个字符"，而是**用户消息与助手消息一起丢**（它们在同一个事务里）——
 * 症状正是"聊完切走再切回 / 刷新后，**这一轮凭空消失**"，而流式时明明看得到。
 *
 * ⚠️ 递归而不是逐字段列举：`content` 的段会继续长（`attachments` / `artifacts` / 将来的段），
 * 逐字段写必漏一处，而漏掉的那一处就是下一次"整轮消失"。NUL 在文本里本就不可见、无意义，
 * 直接删除（不替换成 `\uFFFD`）—— 与"这段内容原样透出"的口径不冲突。
 *
 * ⚠️ **导出仅供断言**（与 `conversation.service.ts#toMessagePage` 同款做法）：它是纯函数，
 * 可以被无依赖档直接喂"带 NUL 的 content"逐段断言，而不必连真库。
 */
export function stripNulChars<T>(value: T): T {
  // ⚠️ 用 `replaceAll('\u0000', '')` 而不是正则 `/\u0000/g`：后者会被 ESLint 的
  //    `no-control-regex` 拦下（正则里出现控制字符本身就是一个要复核的信号）。
  if (typeof value === 'string') return value.replaceAll('\u0000', '') as T
  if (Array.isArray(value)) return value.map((entry) => stripNulChars(entry)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = stripNulChars(entry)
    return out as T
  }
  return value
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
    attachments,
    assistantText,
    thinkingSegments,
    citations,
    toolRecords,
    artifacts,
    model,
    steers,
    usage,
    usageRecord,
    logger,
  } = input
  const hasAssistantContent =
    assistantText !== '' ||
    thinkingSegments.length > 0 ||
    citations.length > 0 ||
    toolRecords.length > 0 ||
    (artifacts?.length ?? 0) > 0 ||
    // 本轮只有插话、没有正文（用户插话后立刻停止）：插话也是"这一轮发生的事"，
    // 不写助手行的话这几条插话刷新后就消失了（它们挂在助手消息的 `content.steers` 上）
    (steers?.length ?? 0) > 0
  try {
    const db = getPrisma()
    const { assistantMessageId, upgradeFrom } = await db.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          conversationId,
          role: 'USER',
          // 附件（P1-4）：只在非空时写这个键（省键 = 本轮没有附件，与 `buildAssistantContent` 同口径）。
          // 它让"刷新后用户气泡里还能看到当时带过什么"成立（历史消息原样透出 `content`）。
          // ⚠️ `stripNulChars`：见它的注释 —— NUL 会让整个事务回滚（这一轮凭空消失）。
          content: stripNulChars(
            attachments === undefined || attachments.length === 0
              ? { text: content }
              : { text: content, attachments: [...attachments] },
          ),
        },
      })
      let assistantMessageId: string | null = null
      if (hasAssistantContent) {
        const created = await tx.message.create({
          data: {
            conversationId,
            role: 'ASSISTANT',
            // ⚠️ `stripNulChars`：引擎/上游把 NUL 混进正文 / 思考 / 工具 output 是真实会发生的
            //（沙箱读二进制文件）⇒ 不清洗就是"整轮落库回滚、这一轮凭空消失"（见它的注释）。
            content: stripNulChars(
              buildAssistantContent({
                text: assistantText,
                thinkingSegments,
                citations,
                toolCalls: toolRecords,
                artifacts,
                ...(model === undefined ? {} : { model }),
                ...(steers === undefined ? {} : { steers }),
              }),
            ),
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
      const derivedTopic = stripNulChars(deriveConversationTopic(content))
      let topicDerived = false
      if (derivedTopic !== '') {
        const written = await tx.conversation.updateMany({
          where: { id: conversationId, topic: null },
          data: { topic: derivedTopic },
        })
        // `count === 1` ⟺ **本**轮写下了这条确定性标题（= 这是首条消息、且无人抢先改名）。
        // 它是下面"要不要尝试模型升级"的**唯一**判据：只有本函数刚写的这一条才允许被升级
        // （见事务外那段注释的 provenance 口径）。
        topicDerived = written.count === 1
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
            // P1-22 · X1：分内外（报表）与按 Key 归集；内部路径不传 ⇒ 库默认 INTERNAL / NULL
            ...(usageRecord.channel === undefined ? {} : { channel: usageRecord.channel }),
            openKeyId: usageRecord.openKeyId ?? null,
          },
        })
      }
      return { assistantMessageId, upgradeFrom: topicDerived ? derivedTopic : null }
    })
    // ── 模型升级标题（2026-10-22）：确定性标题刚由**本**轮写下时，尽力把它升级成模型生成的短标题 ──
    //
    // provenance 口径（与 `hermes-agent` 的 `derived < llm < user` 同源）：
    //   · 只在 `upgradeFrom !== null`（= 本函数**刚写的**那条确定性标题）时尝试 —— **绝不覆盖**：
    //       · 用户手打的标题（`topic` 早已非 null ⇒ 事务里 CAS 没写成功 ⇒ `upgradeFrom === null`）；
    //       · 更早那轮已经升级成的 `llm` 标题（同样 CAS 不成功 ⇒ `upgradeFrom !== null` 不成立）。
    //     于是"升级"只会把**这一级的**`derived` 换成更好的一条，优先级链条天然成立。
    //   · 更新语句带 `topic: upgradeFrom` 作为 CAS 守卫：生成期间用户手动改名 ⇒ 条件不成立、
    //     这次升级被安全丢弃（不会把用户刚起的名字冲掉）。
    //
    // ⚠️ **刻意不 `await`、也不阻塞落库**：标题是"美化"，不该拖慢这一轮回给用户的时间；
    //     生成慢 / 卡住都不影响消息已经落库这件事。失败一律静默回落（保留 `derived` 那条）。
    //     `void` + 内部 try/catch：这是唯一不给 unhandled rejection 的写法（`generateConversationTitle`
    //     自身也永不抛，这里是第二道保险）。
    if (upgradeFrom !== null) {
      void upgradeGeneratedTitle(conversationId, content, upgradeFrom, logger)
    }
    // ── 开放平台当日 token 累计（P1-22 · X6）：与落库同一判据（这一轮真的落库了才记账）──
    //
    // 为什么在**落库之后**累加而不是在请求前:这是"已经花掉"的账 —— 请求前累加会在失败/停止的
    // 轮次里多算，而 `usage_records` 那一行恰恰是"这一轮真的跑过"的唯一证据。
    // ⚠️ **尽力而为**（`void` + 内部永不抛）：Redis 抖动只该让"日额度"少算一点，
    //    绝不能把已经落库的回答变成一次失败（用户会看到"答案没了"）。
    //
    // `tokensIn/Out` 允许为 NULL（上游没上报）：那种轮次**不计**入当天总量，也不编 0 ——
    // 与 `usage_records` 的 NULL 口径一致（"不知道"不是"用了 0"）。
    if (usageRecord?.openKeyId != null) {
      void accumulateOpenApiDailyTokens(usageRecord.openKeyId, usageRecord.tokensIn, usageRecord.tokensOut, logger)
    }
    return assistantMessageId
  } catch (error) {
    logger.error(
      { err: error, conversationId, hasAssistantContent, generatedChars: assistantText.length },
      '本轮消息落库失败（回答已流给用户，但历史里不会有这一轮）',
    )
    return null
  }
}

/**
 * 落库事务**之外**的标题升级（见 {@link persistRoundQuietly} 的注释）。
 *
 * **永不抛**：这是 `void` 调用的后台动作，任何异常都不能变成未处理的 rejection。三件事：
 *   ① 让配置的标题模型把首条消息压成短标题（未配 / 不可用 ⇒ `null`，回落）；
 *   ② 升级条件 `topic = derivedTopic`（CAS：生成期间用户没改名、且这条还是当初那条）；
 *   ③ 生成不出 / 更新不成立 ⇒ 什么都不做（保留已有的确定性标题）。
 */
async function upgradeGeneratedTitle(
  conversationId: string,
  firstUserText: string,
  derivedTopic: string,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  try {
    const generated = await generateConversationTitle(firstUserText)
    if (generated === null || generated === derivedTopic) return
    await getPrisma().conversation.updateMany({
      // ⚠️ `topic: derivedTopic` 是 CAS 守卫（不是 `topic: null`）：只升级**本函数刚写的**那一条，
      //    且生成期间用户没改过名 —— 后写覆盖先写在这里是错的（会把用户的名字冲掉）。
      where: { id: conversationId, topic: derivedTopic },
      data: { topic: generated },
    })
    logger.debug({ conversationId }, '会话标题已由模型生成升级')
  } catch (error) {
    logger.warn({ err: error, conversationId }, '会话标题模型升级失败（已保留确定性标题）')
  }
}

/**
 * 把本轮 token 累加进「本 Key 当日用量」（P1-22 · X6；键 `open:day:tok:{keyId}:{YYYY-MM-DD}`）。
 *
 * **永不抛**（`void` 调用）：调用方是已经落库成功的收尾路径，任何异常都只该是一条 warn。
 * 日界按 **UTC** 算：与 `usage_records.created_at`（`TIMESTAMPTZ`，跨环境按时刻对齐）的统计口径
 * 一致；`/open/v1/usage` 回带的 `day` 就是这个 UTC 日期，客户端据此理解"什么时候重置"。
 */
async function accumulateOpenApiDailyTokens(
  keyId: string,
  tokensIn: number | null,
  tokensOut: number | null,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  const total = (tokensIn ?? 0) + (tokensOut ?? 0)
  // 两列都没上报 ⇒ 这一轮没有可计的数（不写 0，避免把"不知道"记成"用了 0"）
  if (tokensIn === null && tokensOut === null) return
  if (total <= 0) return
  try {
    const redis = await ensureRedisConnected()
    const key = openApiDailyTokenKey(keyId, openApiUtcDay())
    const next = await redis.incrby(key, total)
    if (next === total) await redis.expire(key, OPEN_API_DAILY_TOKEN_TTL_SEC)
  } catch (error) {
    logger.warn({ err: error, keyId, tokens: total }, '累加开放平台当日 token 失败（仅影响日额度读数）')
  }
}

/** 当前 UTC 日期（`YYYY-MM-DD`）—— 开放平台"当日"的唯一口径（见 {@link accumulateOpenApiDailyTokens}） */
export function openApiUtcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
