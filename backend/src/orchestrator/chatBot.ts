/**
 * ChatBot 编排循环（P0-1-27；`docs/02-后端设计.md` §六）
 *
 * ```
 * 入口：POST /chat（已建会话，type=CHATBOT）
 *  1. 并发闸：信号量（上限 50），满则 error{code: BUSY}
 *  2. 组装上下文：system = agent.system_prompt + 检索块；history = 最近 20 轮；user = content
 *  3. LLM 流式调用 → delta / thinking 透传
 *  4. 工具循环（MCP）→ P0-2（本批不做）
 *  5. done：整条消息落库 + usage 透传
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件在整条链路里的位置
 * ─────────────────────────────────────────────────────────────────────
 * `routes/conversations.ts` →（前置闸门 `assertConversationSendable`）→ `orchestrator/sse.ts`
 * （通道：帧 / 互斥锁 / 停止 / 心跳）→ **本文件**（生产帧）→ `llm/client.ts`（传输层）。
 * 它由 `orchestrator/index.ts#resolveChatProducer()` 单点接回 —— 路由一行都不用改（P0-1-26 的接回点）。
 * 纯逻辑（system prompt / 检索块 / 历史截断 / 落库形态）在 `chatContext.ts`（可进无依赖档），
 * 并发闸在 `semaphore.ts`（同上），本文件只留"必须碰 DB / 上游 / 日志"的那一半。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条本批的契约判断（都不是"顺手这么写"）
 * ─────────────────────────────────────────────────────────────────────
 * ① **中断（用户停止 / 客户端断开）也要落库**：`01` 决策 15「停止即中断，**已生成内容保留**」——
 *    保留的前提是"落库"，否则刷新之后用户看到的是"我停了一下，问题没了"。
 *    客户端断开那一路尤其要注意：`02` §5.2 的断线恢复是"查 `/active` 拿进度 + 拉历史补齐"，
 *    历史里没有这半条回答，"补齐"就补不出来。
 *    ⚠️ **唯一的例外是锁丢了（`lock-lost`）**：那时这个会话可能已经有**另一个流**在写历史，
 *    我们再写一次就是两边往同一份历史里插消息（sse.ts 文件头 ③ 的最后一条）。
 *
 * ② **前置失败（智能体没了 / 知识库检索不可用）不落库**：落库的单位是"**一轮问答**"，
 *    而这一轮根本没发生（一个字的回答都没有、用户看到的是流内错误卡）。
 *    留一条"只有问题、永远没有答案"的记录，会让下次刷新时用户以为自己问过但被丢了。
 *    这与"检索失败要整轮失败"是同一判断的两面：检索层把"搜不了"报成 409/500 而不是空结果
 *    （P0-1-20 定案："空结果会被读成'库里没有相关内容'，是一句假话"），本层**不吞这个错**。
 *
 * ③ **`usage_records` 表在本版本不写**（`06` P0-1-27 的"内容"一行提到它）：
 *    该表属 **P1**（`01` 决策 20「用量统计 P1 基础版」、§150 的功能表也是 P1），且
 *    `02` §七 待决事项 4 已定案"首版只打日志"；本仓 `schema.prisma` 里**没有**这张表
 *    （P0-1 的 10 张表里不含它）。本批做的是"计量**透传**"：`done.usage` 事件给前端 +
 *    结束日志里带 `tokensIn/tokensOut`。**接回点**：P1 建表后，在 {@link chatBotProducer}
 *    落库的那个事务里加一条 `usageRecord.create`，并把本段注释改掉。
 */

import {
  AppError,
  type CitationItem,
  type RetrievalHit,
  type SseEvent,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import {
  LlmAbortError,
  chatStream,
  type ChatMessage,
  type ChatStreamSummary,
  type ChatUsage,
} from '../llm/client.js'
import { touchConversation } from '../services/conversation.service.js'
import { searchKnowledgeBase } from '../services/retrieval.js'
import {
  buildAssistantContent,
  buildSystemPrompt,
  mergeRetrievalHits,
  selectHistoryMessages,
  toCitationItems,
  type HistoryRow,
} from './chatContext.js'
import { createSemaphore } from './semaphore.js'
import { ChatStoppedError, type ChatProducer, type ChatStopReason } from './sse.js'

/**
 * 进程级并发闸（`02` §六 第 1 步）。**模块级单例**：名额是"这个进程同时在跑几轮生成"，
 * 每轮各造一个信号量等于没有闸门。
 */
const chatBotSlots = createSemaphore(config.concurrency.chatbot)

/**
 * 从中断信号里读回"为什么中断"。
 *
 * `signal.reason` 是 `AbortController.abort(reason)` 塞进去的那个对象（见 `sse.ts#SseChannel.abort`），
 * 它可能是任何东西（运行时允许 `abort(undefined)`）⇒ 这里只认 {@link ChatStoppedError}，
 * 其余一律当作"不知道原因"。`user` / `client` / `lock-lost` 的区别在本文件里只用得到一处：
 * **`lock-lost` 不能落库**（见文件头 ①）。
 */
function abortReasonOf(signal: AbortSignal): ChatStopReason | undefined {
  const reason: unknown = signal.reason
  return reason instanceof ChatStoppedError ? reason.reason : undefined
}

/**
 * ChatBot 的编排循环（`orchestrator/index.ts` 的返回值）。
 *
 * @throws {AppError} `BUSY`(429) 并发闸满 / `NOT_FOUND`(404) 智能体已不存在 /
 *   检索层的错误**原样透出**（知识库 409 / 500 ⇒ 整轮失败，见文件头 ②）
 * @throws {LlmAbortError} 只有"没接住的中断"才会漏出去（正常路径下中断被本函数接住并转成 `STOPPED`）
 */
export const chatBotProducer: ChatProducer = async (input) => {
  const logger = getLogger()
  const { conversationId, agentId, content, signal } = input

  // ── ① 并发闸（不排队，见 `semaphore.ts` 文件头）──
  const release = chatBotSlots.tryAcquire()
  if (release === null) {
    logger.warn(
      { conversationId, agentId, inFlight: chatBotSlots.inFlight, limit: chatBotSlots.limit },
      'ChatBot 并发闸已满，本轮被拒（BUSY）',
    )
    throw AppError.busy(`当前正在生成的对话已达上限（${chatBotSlots.limit}），请稍后重试`)
  }

  /**
   * ⚠️ 注意这里**没有**"是否落库"的开关：能走到收尾分支的，都是"这一轮真的发生了"的行
   * （前置失败会把异常直接抛出去，见文件头 ②）。于是落库的判据就是控制流本身，而不是一个标志位
   * —— 标志位与"到底哪条路走到了哪里"容易对不上，而控制流不会。
   */
  let assistantText = ''
  let thinkingText = ''
  let citations: CitationItem[] = []
  let usage: ChatUsage | null = null

  try {
    const db = getPrisma()

    // ── ② 智能体与绑定的知识库 ──
    const agent = await db.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: {
        systemPrompt: true,
        components: {
          where: { componentType: 'KNOWLEDGE' },
          orderBy: { refId: 'asc' },
          select: { refId: true },
        },
      },
    })
    // 走到这里还查不到 = 软删与发消息的竞态（`assertConversationSendable` 已用 409 挡过一次）
    if (agent === null) throw AppError.notFound('智能体不存在')
    const kbIds = agent.components.map((component) => component.refId)

    // ── ③ 逐库检索（`02` §六 第 2 步）──
    // ⚠️ 每个库各调一次 `searchKnowledgeBase` ⇒ **同一句 query 会被 embed 多次**。
    //    这是刻意的：那条函数是"一次检索"的完整语义（读库配置 → 双路 → RRF），
    //    为了省一次 embedding 就绕过它（自己拼 SQL）会让"检索口径"出现第二个实现。
    //    库的数量是个位数，代价可接受；要优化应当把它做成接受多库的函数（属后续批次）。
    const perKb: RetrievalHit[][] = []
    for (const kbId of kbIds) {
      const result = await searchKnowledgeBase({ kbId, query: content })
      perKb.push(result.items)
      if (result.warnings.length > 0) {
        logger.warn({ conversationId, kbId, warnings: result.warnings }, '本轮检索发生降级（已记入警告）')
      }
    }
    const hits = mergeRetrievalHits(perKb)
    citations = toCitationItems(hits)

    // ⚠️ **未命中时一个引用卡都不发**（`01` 决策 12 / `06` 的验收原文）——
    //    不是发一个 `items: []`：前端按"有没有 citations 事件"决定要不要画引用区
    //    （`03` §五"完成时随 citations 事件出现"），空事件会让它画一个空卡。
    if (citations.length > 0) {
      await input.emit({ name: 'citations', data: { items: citations } })
    }

    // ── ④ 历史（最近 N 轮）+ system + 本轮用户消息 ──
    const rounds = config.limits.contextRounds
    const historyRows = await db.message.findMany({
      where: { conversationId },
      // `id desc` 是**确定性**的兜底：`created_at` 是毫秒精度，同一事务里写的两条可能同值
      // （messages 的主键是 `(id, created_at)`，`id` 是 uuid(7) ⇒ 时间有序）
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: rounds * 2,
      select: { role: true, content: true },
    })
    historyRows.reverse() // 上面是倒序取的（要"最近的 N 条"），还原成时间正序再组装
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(agent.systemPrompt, hits) },
      ...selectHistoryMessages(historyRows as HistoryRow[], rounds),
      { role: 'user', content },
    ]

    // ── ⑤ LLM 流式调用（`delta` / `thinking` 透传）──
    /**
     * 帧的**串行队列**。
     *
     * 为什么要队列：`chatStream` 的回调是**同步**的（`onDelta: (text) => void`），而
     * `emit` 是异步的（它要过 schema 校验、还要在背压时等 `drain`）。`void emit(...)` 有两个
     * 真实后果：① 帧的**顺序**不再有保证（前一个在等 drain 时后一个已经写出去了）；
     * ② emit 抛错（schema 不合法）会变成**没人接的 promise rejection** —— 而它本该让这一轮
     * 以 `error` 收尾（出口层的 `fail`）。队列把这两件事一起解决：串行 + 把首个错误记下来。
     */
    let emitChain: Promise<void> = Promise.resolve()
    let emitFailure: unknown
    const enqueue = (event: SseEvent): void => {
      emitChain = emitChain.then(() => input.emit(event)).catch((error: unknown) => {
        emitFailure ??= error
      })
    }

    /** TTFT（`02` §十三：阶段一"首字 < 3s"验收的**唯一**测量依据，不能事后补） */
    const requestedAtMs = Date.parse(input.startedAt)
    let ttftLogged = false

    let summary: ChatStreamSummary | null = null
    let failure: unknown = null
    try {
      summary = await chatStream(
        input.target,
        messages,
        {
          onDelta: (text) => {
            if (!ttftLogged) {
              ttftLogged = true
              logger.info(
                {
                  conversationId,
                  agentId,
                  modelId: input.target.modelId,
                  ttftMs: Date.now() - requestedAtMs,
                  historyMessages: messages.length - 2, // 去掉 system 与本轮用户消息
                  citations: citations.length,
                },
                '本轮首字延迟（TTFT）',
              )
            }
            assistantText += text
            enqueue({ name: 'delta', data: { text } })
          },
          onThinking: (text) => {
            thinkingText += text
            enqueue({ name: 'thinking', data: { text } })
          },
          onUsage: (value) => {
            usage = value
          },
        },
        { abortSignal: signal },
      )
      usage = summary.usage ?? usage
    } catch (error) {
      // 中断与故障在这里**都**只是"记下来"，统一的收尾在下面（见文件头 ①）：
      // 两条路都要落库（锁丢那一路除外），只是最终发出去的帧不同
      failure = error
    }

    await emitChain

    // ── ⑥ 收尾 ──
    //
    // 三种情形的分流（**顺序即优先级**）：
    //   · 锁丢了 → 一个字都不写库 + 把异常交给出口层（下面第一支）
    //   · 故障（上游报错 / 非中断异常）→ **已生成的内容照样落库**，然后抛出去走 `error` 帧
    //   · 中断（用户停止 / 客户端断开）→ 落库 + 返回 `STOPPED`（`messageId` 因此能带上，
    //     而"让出口层兜底发 `done{STOPPED, messageId:null}`"会把已落库的那条丢掉）
    const stopReason = abortReasonOf(signal)
    if (stopReason === 'lock-lost') {
      logger.warn(
        { conversationId, agentId, generatedChars: assistantText.length },
        '活跃流锁已丢失，本轮不落库（避免与另一个流抢同一份历史）',
      )
      // ⚠️ **优先抛 `signal.reason`（那个 `ChatStoppedError`），而不是 `failure`**：
      //    锁丢时上游调用往往**正好也被中断**（出口层的 abort 会掐断在飞的那次 `fetch`），
      //    于是 `failure` 很可能是 `LlmAbortError` —— 一个**没有用户文案**的技术异常。
      //    抛错对象选错，用户看到的就从"会话状态异常，…请重新发送消息"（可行动的建议）
      //    退化成"服务内部错误"（`fail()` 只对 `AppError` / `ChatStoppedError` 放行 message）。
      //    📌 这条是**全量回归**抓到的：`verify:chat-stream` 的 E 组断言的是**文案**，不是状态码。
      throw signal.reason instanceof ChatStoppedError ? signal.reason : (failure ?? (signal.reason as Error))
    }

    /** 中断：信号里记了原因，或上游是以"调用方中断"结束的 */
    const interrupted = stopReason !== undefined || failure instanceof LlmAbortError
    /**
     * 故障：**不是**中止类错误。
     *
     * ⚠️ 两者可能同时成立（用户点停止的同一刻上游正好报错）⇒ 以故障为准：
     * 把"上游坏了"说成"你点了停止"会让用户去重试一个根本不通的链路（`01` 决策 15 的反面）。
     */
    const fatal = failure !== null && !(failure instanceof LlmAbortError)
    if (fatal) {
      logger.warn(
        { conversationId, agentId, err: failure, stopReason: stopReason ?? null, generatedChars: assistantText.length },
        '本轮生成失败（已生成的内容仍会落库，供刷新后查看）',
      )
    }

    const messageId = await persistRoundQuietly({
      conversationId,
      content,
      assistantText,
      thinkingText,
      citations,
      usage,
      logger,
    })

    if (emitFailure !== undefined) throw emitFailure
    if (fatal) throw failure

    const finishReason = interrupted ? 'STOPPED' : 'COMPLETE'
    if (!interrupted && summary !== null && summary.rawFinishReason !== null && summary.rawFinishReason !== 'stop') {
      // `length`（被 max_tokens 截断）/ `content_filter` 之类：契约里没有对应的 finishReason
      // （SSE 契约只有 COMPLETE|STOPPED|ERROR）⇒ 如实按 COMPLETE 收尾，但**必须留痕**，
      // 否则"回答被腰斩"在服务端没有任何线索（`02` §6.1：归一化会丢掉这个决策信息）
      logger.warn(
        { conversationId, rawFinishReason: summary.rawFinishReason, deltaCount: summary.deltaCount },
        '上游的结束原因不是 stop（回答可能被截断），契约里按 COMPLETE 收尾',
      )
    }
    if (interrupted) {
      logger.info(
        { conversationId, agentId, stopReason: stopReason ?? null, messageId },
        '本轮被中断收尾（已生成内容已落库）',
      )
    }

    logger.info(
      {
        conversationId,
        agentId,
        modelId: input.target.modelId,
        finishReason,
        messageId,
        citations: citations.length,
        deltaCount: summary?.deltaCount ?? 0,
        durationMs: Date.now() - requestedAtMs,
        tokensIn: usage?.tokensIn ?? null,
        tokensOut: usage?.tokensOut ?? null,
      },
      'ChatBot 本轮结束',
    )

    return {
      messageId,
      finishReason,
      usage: usage === null ? null : { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
    }
  } finally {
    release()
  }
}

/** {@link persistRoundQuietly} 的入参 */
interface PersistRoundInput {
  conversationId: string
  content: string
  assistantText: string
  thinkingText: string
  citations: CitationItem[]
  usage: ChatUsage | null
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
 * 助手消息**只在真的有内容时才写**：`text` / `thinking` / `citations` 三者全空时
 * （用户刚发出去就点了停止）不写助手行 —— 留一条空消息会在界面上画出一个空气泡。
 * 此时 `done.messageId` 为 `null`，它的语义正是"**这一轮没有产生可持久化的消息**"
 * （`shared/src/sse.ts` 文件头 ④）。
 *
 * **落库失败不外抛**：回答已经完整地流给用户看了，此时再用 `error` 帧覆盖掉
 * "回答成功"这件事，是拿一条基础设施故障去否定一个已经发生的事实。
 * 处置是**如实报告**：日志记 error + `messageId: null`（"没有产生可持久化的消息"这句字面为真），
 * 前端据此可以说"本条未写入历史"。⚠️ 代价写在这里：这一轮在历史里查不到（刷新后会消失）。
 */
async function persistRoundQuietly(input: PersistRoundInput): Promise<string | null> {
  const { conversationId, content, assistantText, thinkingText, citations, usage, logger } = input
  const hasAssistantContent = assistantText !== '' || thinkingText !== '' || citations.length > 0
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
            content: buildAssistantContent({ text: assistantText, thinking: thinkingText, citations }),
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
