/**
 * ChatBot 编排循环（P0-1-27；`docs/02-后端设计.md` §六）
 *
 * ```
 * 入口：POST /chat（已建会话，type=CHATBOT）
 *  1. 并发闸：信号量（上限 50），满则 error{code: BUSY}
 *  2. 组装上下文：system = agent.system_prompt +（绑库时）能力说明 + 引用规则 + 可用知识库清单；
 *     history = 最近 20 轮；user = content（⚠️ **无前置检索**：知识库走工具式，见 `knowledge_search`）
 *  3. LLM 流式调用 → delta / thinking 透传
 *  4. 工具循环（MCP）→ 已落地（P0-2-8 起；危险工具先过确认 ⇒ P0-2-10）
 *  5. 收尾：按**回答里真正引用的文档**发 `citations`（产品反馈 2026-09-30）→ `done` + 落库 + usage 透传
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件在整条链路里的位置
 * ─────────────────────────────────────────────────────────────────────
 * `routes/conversations.ts` →（前置闸门 `assertConversationSendable`）→ `orchestrator/sse.ts`
 * （通道：帧 / 互斥锁 / 停止 / 心跳）→ **本文件**（生产帧）→ `llm/client.ts`（传输层）。
 * 它由 `orchestrator/index.ts#resolveChatProducer()` 单点接回 —— 路由一行都不用改（P0-1-26 的接回点）。
 * 纯逻辑（system prompt / 检索块拼装 / 历史截断 / 落库形态）在 `chatContext.ts`（可进无依赖档），
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
 * ② **前置失败（智能体没了 / 会话没了 / 模型池不合法）不落库**：落库的单位是"**一轮问答**"，
 *    而这一轮根本没发生（一个字的回答都没有、用户看到的是流内错误卡）。
 *    留一条"只有问题、永远没有答案"的记录，会让下次刷新时用户以为自己问过但被丢了。
 *    ⚠️ 2026-09-30 起**知识库检索不再是前置步骤**（改成工具式，见 `KNOWLEDGE_USAGE_RULES`），
 *    所以"检索失败"也不再是前置失败 —— 它发生在工具循环里，按"单条工具失败"回填给模型
 *    （整轮不因此失败，见下面的内置工具分支）。
 *
 * ③ **`usage_records` 表 P1-7 起 ChatBot 也写**：
 *    表本身在 **P0-3-12** 就落地了（`schema.prisma#UsageRecord`，按月分区）—— 当时 `子方案③` §十
 *    要求 **TaskAgent** 写它（`01` 决策 20），而 ChatBot 侧的口径是 **"首版只打日志"**
 *    （`01` 决策 20「用量统计 P1 基础版」、`02` §6.2 ⑦）。**P1-7** 兑现了 P0-3-12 留的接回点：
 *    收尾时把 `usageRecord` 一起交给 `persistRoundQuietly`（与消息**同一个事务**）⇒
 *    "一行 = 一轮对话"从此对**两个编排器**都成立（报表不再只有任务型那一半数据）。
 *    本批同时保留"计量**透传**"：`done.usage` 事件给前端（前端据此在收尾行显示每轮 token）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 工具循环（P0-2-8）的三条判据
 * ─────────────────────────────────────────────────────────────────────
 * ① **"还允不允许要工具"的判据是"已执行了几轮"，不是"请求了几次"**（`06` 门槛 3 的口径）：
 *    到 `TOOL_LOOP_LIMIT` 后**当轮就把 `tools` 撤掉**，而不是等模型再多要一次工具才拒。
 *    两者的可观测结果一致（门槛 3 取证的是"假 MCP 的调用计数恰好 **10** + `done{COMPLETE}`"），
 *    但撤掉省一次明知不会执行的上游往返；而且**只有"请求里没有 `tools` 字段"才是真的禁工具**
 *    —— 只在提示里写"不许调"，模型仍可能吐一个工具名出来（那时只能收尾，见循环里那个分支）。
 * ② **工具失败 ≠ 这一轮失败**（门槛 2）：`isError` / 缺凭据 / 传输故障**全部**变成
 *    `tool_call{ERROR}` 卡 + 把错误文本回填给模型，让模型自己决定怎么说 ——
 *    这才是 `01` §3.6"失败错误可见"的正确形态（整轮失败会让用户只看到一张错误卡、
 *    拿不到任何解释）。**唯一的例外是中断**（`McpAbortError`）—— 那要真的停下来。
 * ③ **凭据的主语来自"当前会话"**（`02` §9.3 不变式）：`viewer.userId` 从 `conversations` 行
 *    **现查**（懒加载，只有真要执行工具时才查一次），不从请求体、不从路径、不顺着调用链传
 *    —— 传一次就多一个"传错人"的机会，而现查的代价只有一次主键查询。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑤ 确认闸门（P0-2-10）的两条判据
 * ─────────────────────────────────────────────────────────────────────
 * ① **"要不要问"读 `route.dangerous`，本层不再判一次**：判定是 `mcp/risk.ts` 的纯函数，
 *    结果由 `toolSchema.ts` 算进路由表（真值表见 `02` §9.9）—— 两处判 = 迟早有一处先腐烂。
 *    挂起点**排在取凭据 / 发 `RUNNING` 卡之前**：确认的全部意义就是"发出去之前问一句"。
 * ② **"问了之后"不是二选一，是三选一**（`ConfirmDecision` = 确认 / 取消 / 超时），
 *    而**三条里的两条都通向"不执行但这一轮继续"**：取消与超时都回填一条"未执行"的工具结果
 *    （文案刻意分开，见 `chatContext.ts` 的两个常量），让模型自己解释 —— 这与 ④② 同一条形态
 *    （`01` §3.6「取消后流程可继续」）。⚠️ **中断（用户点停止）不走这条路**：那不是"确认的结局"，
 *    而是"这一轮结束了"，由 `awaitConfirm` 抛出 `ChatStoppedError` 交给收尾（见文件头 ①）。
 */

import {
  AppError,
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  MEMORY_TOOL_SERVER_NAME,
  RECALL_MEMORY_TOOL_NAME,
  REMEMBER_TOOL_NAME,
  SEND_NOTIFICATION_TOOL_NAME,
  type CitationItem,
  type ErrorCode,
  type RetrievalHit,
  type SseEvent,
  type SseToolCallPayload,
  type ToolCallRecord,
  type ToolCallStatus,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import {
  LlmAbortError,
  chatStream,
  parseToolArguments,
  sumUsages,
  type ChatMessage,
  type ChatStreamSummary,
  type ChatUsage,
} from '../llm/client.js'
import {
  McpAbortError,
  type McpElicitReply,
  type McpElicitRequest,
} from '../mcp/client.js'
import { executeMcpToolCall, resolveMcpToolCatalog } from '../services/mcpCall.service.js'
import { MESSAGE_CHRONO_ORDER } from '../services/conversation.service.js'
import { buildMemoryToc, buildUserProfileBlock, getMemorySettings } from '../services/memory.service.js'
import { executeSendNotification, getNotifyTarget, notifyOpenAiTool, NOTIFY_TOOL_SERVER_NAME } from '../notify/index.js'
import {
  KNOWLEDGE_CATALOG_MAX_DOCS_PER_KB,
  KNOWLEDGE_TOOL_SERVER_NAME,
  TOOL_CONFIRM_REJECTED_OUTPUT,
  TOOL_CONFIRM_TIMEOUT_OUTPUT,
  TOOL_LOOP_LIMIT_NOTICE,
  attachmentItemsOf,
  buildAssistantToolCallsMessage,
  buildSystemPrompt,
  buildToolResultMessages,
  buildUserChatMessage,
  createToolCallTextFilter,
  knowledgeListTool,
  knowledgeSearchTool,
  readDocumentTool,
  selectHistoryMessages,
  stripToolCallMarkup,
  summarizeToolInput,
  toUsedCitationItems,
  toolLoopLimitUnexecutedOutput,
  toolLoopLimitUserNotice,
  truncateToolResult,
  type HistoryRow,
  type ToolOutcome,
} from './chatContext.js'
import { executeKnowledgeTool, isKnowledgeToolName, loadKnowledgeCatalog } from './knowledgeTools.js'
import { runMemoryExtraction } from './memoryExtract.js'
import { executeMemoryTool, executeRecallMemoryTool, recallMemoryTool, rememberTool } from './memoryTools.js'
import { persistRoundQuietly } from './persist.js'
import { createSemaphore } from './semaphore.js'
import { createToolTextOffsetTracker } from './toolTextOffset.js'
import {
  ChatStoppedError,
  abortReasonOf,
  readAutoApprove,
  type ChatProducer,
  type ConfirmDecision,
} from './sse.js'

/**
 * 进程级并发闸（`02` §六 第 1 步）。**模块级单例**：名额是"这个进程同时在跑几轮生成"，
 * 每轮各造一个信号量等于没有闸门。
 */
const chatBotSlots = createSemaphore(config.concurrency.chatbot)

/**
 * ⚠️ `abortReasonOf(signal)` 自 **P0-3-6** 起搬到了 `sse.ts`（它有了第二个调用方 ——
 * `taskAgent.ts` 的编排循环要同一个判据，而"同一口径只留一处"是硬要求）。
 * 行为逐字未变；`user` / `client` / `lock-lost` 的区别在本文件里只用得到一处：
 * **`lock-lost` 不能落库**（见文件头 ①）。
 */

/**
 * ChatBot 的编排循环（`orchestrator/index.ts` 的返回值）。
 *
 * @throws {AppError} `BUSY`(429) 并发闸满 / `NOT_FOUND`(404) 智能体已不存在
 *   （⚠️ 知识库检索自 2026-09-30 起在工具循环内完成，它的失败**不会**从这里抛出，见文件头 ②）
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
  /**
   * 本轮引用卡条目。
   *
   * ⚠️ **故意不在这里初始化**：它在回答结束后由 {@link toUsedCitationItems} 一次性算出
   * （判据是"回答里真的引用了哪几篇"，见 ⑤′），早于那里读它都是错的；不给初值能让
   * "在算出来之前被读到"变成编译期错误，而不是一个静默的空数组。
   */
  let citations: CitationItem[]
  /**
   * 本轮的**工具调用记录**（P0-2-8）。
   *
   * 放在外层（而不是循环里）是因为它要活到收尾：落库时它是助手消息的 `content.tool_calls`
   * —— **工具调用也是"这一轮发生的事"**，中断/故障照样落库（同下面那条 `assistantText`）。
   */
  const toolRecords: ToolCallRecord[] = []

  try {
    const db = getPrisma()

    // ── ②″ 会话行（owner + 会话级「不记入记忆」；长期记忆注入与收尾提取都要用）──
    const conversationRow = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, memoryExcluded: true },
    })
    if (conversationRow === null) throw AppError.notFound('会话不存在')
    // 长期记忆 v2（P1-8a）：② USER 画像**常驻** + ③ AGENT 记忆**极简目录 TOC**（不含正文）；
    //    AGENT 记忆细节由 agent 按需调 `recall_memory`（见 `memoryTools.ts`）。两段在总开关关掉时为空。
    const memorySettings = await getMemorySettings(conversationRow.userId)
    const userProfile = await buildUserProfileBlock({ userId: conversationRow.userId })
    const memoryToc = await buildMemoryToc({ userId: conversationRow.userId, agentId })

    // ── ② 智能体与它绑定的知识库 / MCP server ──
    const agent = await db.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: {
        systemPrompt: true,
        // ⚠️ 一次取全部组件再在内存里分流（`componentType` 是判别列）：Prisma 不允许在同一次
        //    查询里对同一个关系写两个 `select` 分支，而分两次查会多一次往返。
        //    `orderBy: refId asc` 与 P0-1-23 起的历史口径相同 —— 两个列表都按它排序。
        components: { orderBy: { refId: 'asc' }, select: { componentType: true, refId: true } },
      },
    })
    // 走到这里还查不到 = 软删与发消息的竞态（`assertConversationSendable` 已用 409 挡过一次）
    if (agent === null) throw AppError.notFound('智能体不存在')
    const kbIds = agent.components
      .filter((component) => component.componentType === 'KNOWLEDGE')
      .map((component) => component.refId)
    const mcpServerIds = agent.components
      .filter((component) => component.componentType === 'MCP')
      .map((component) => component.refId)

    // ── ②′ 可用知识库清单（库名 + 文档名）──
    /**
     * "Agent 绑了哪几个库、每个库里有哪些文档" —— **prompt 概览**与「知识库目录」工具**共用**这一份读取。
     *
     * 为什么要它：模型是"看不见"知识库的，只有我们告诉它才可能答"我有哪些知识/文档"。
     * 文档名本身就是需求/主题的大类（"NGPOS星礼包对接需求"…），所以这份清单既是**给模型的概况**，
     * 也是 `list_knowledge` 工具要回的**目录本体**。
     *
     * ⚠️ 文档名**按库限量取**（`maxDocsPerKb`）：库里可能有上千篇，全量塞进 prompt 会撑爆上下文。
     *    prompt 概览只取 {@link KNOWLEDGE_CATALOG_MAX_DOCS_PER_KB}（30）篇；目录工具另取
     *    {@link KNOWLEDGE_LIST_MAX_DOCS}（200）篇 —— 因为"列全"正是它的职责。两者都**不静默省略**：
     *    超出时清单里写「其余 N 篇未列出」。
     * ⚠️ 排序与文档列表端点一致（`createdAt desc, id desc`）—— 让"清单里看到的头几篇"与用户在
     *    知识库页面上看到的头几篇是同一批。
     */
    // ⚠️ 执行体与"目录读取"同源：`knowledgeTools.ts`（TaskAgent 的沙箱代理路径也用它）
    const knowledgeCatalog = await loadKnowledgeCatalog(kbIds, KNOWLEDGE_CATALOG_MAX_DOCS_PER_KB)

    /**
     * 命中累积：**只来自模型的主动检索**（内置「知识库检索」工具，2026-09-30）。
     *
     * ⚠️ 这里**不再有**"开场自动检索"：默认前置检索（Static RAG）已按产品反馈去掉 —— 无关问题
     * 也先查一次是纯浪费，且与"工具式（Agentic RAG）"相悖。检索现在发生在工具循环里（见下面的
     * 内置工具分支），命中的文档同样要进引用卡（否则模型据工具结果回答、卡片却指不出来源）。
     */
    const searchHits: RetrievalHit[] = []
    // ⚠️ `citations` 的**发送**推迟到回答结束后（见 ⑥ 收尾）：判据是"模型真的引用了哪几篇"
    //    而不是"检索命中了几条"。何时发、发哪几条都由 {@link toUsedCitationItems} 定，见其注释。

    // ── ③ 本轮可用的工具（内置检索 + MCP，P0-2-8）──
    /**
     * 读 `tool_cache` 列组装工具表：**不联网、不碰凭据**（见 `mcpCall.service.ts` 文件头 ⑤）。
     *
     * ⚠️ 凭据不在这里判 —— "没配凭据"要到**真的点这个工具**时才以
     * `tool_call{ERROR, NEED_CREDENTIAL}` 的形式出现（`02` §9.3）。反过来做的代价：
     * 用户一进对话页就会看到一堆"缺凭据"，而他可能压根没打算用那台 server。
     */
    const catalog = await resolveMcpToolCatalog(mcpServerIds)
    /** `serverId → 展示名`：工具卡片要显示"工具来自哪个系统"，**失败时也要显示** */
    const serverNameById = new Map(catalog.servers.map((server) => [server.id, server.name]))
    if (mcpServerIds.length > 0 && catalog.tools.length === 0) {
      // 绑了 server 却一个工具都没下发：最可能的原因是"从没成功拉过工具列表"
      // （每台这样的 server 在 `resolveMcpToolCatalog` 里已各有一条 warn，这里只记本轮）
      logger.warn(
        { conversationId, agentId, mcpServerCount: mcpServerIds.length },
        '本轮绑定了 MCP server，但没有一个工具下发给模型（工具缓存为空）',
      )
    }

    /**
     * 内置工具：**绑了知识库才有**「知识库目录 + 检索 + 整篇阅读」（`list_knowledge` /
     * `knowledge_search` / `read_document`）。
     *
     * 它们与 MCP 工具**同表下发**（一个数组），但执行时按名字分流（见循环里的 `isKnowledgeToolName`）——
     * 不进 `catalog.routes`：那不是 MCP 工具，没有 server / 凭据 / 危险确认，硬塞进 `McpToolRoute`
     * 只会让那条"名字 → 哪台 server 的哪个工具"的映射表多出一种它描述不了的形状。
     * 排在 MCP 工具**前面**：让模型先看到它们，与系统提示里"知识库优先"的顺序一致。
     */
    const builtinTools = kbIds.length === 0 ? [] : [knowledgeListTool(), knowledgeSearchTool(), readDocumentTool()]
    // 「记住」+「按需检索记忆」内置工具（P1-8/P1-8a）：与知识库无关、**始终下发** —— 记忆是平台级能力
    builtinTools.push(rememberTool(), recallMemoryTool())
    // 通知工具（P1-6，场景 1）：只在该会话属于一个**配了通知渠道**的定时任务运行（含"立即执行"）时下发
    if (getNotifyTarget(conversationId) !== undefined) builtinTools.push(notifyOpenAiTool())
    const tools = [...builtinTools, ...catalog.tools]

    // ── ④ 历史（最近 N 轮）+ system + 本轮用户消息 ──
    const rounds = config.limits.contextRounds
    const historyRows = await db.message.findMany({
      where: { conversationId },
      // ⚠️ 排序口径**与 `GET /:id/messages`（P0-1-28）共用同一个常量** ——
      //    "模型看到的最近几轮"与"界面上显示的最近几条"必须是同一批。
      //    这里原来手写过一遍 `[{ createdAt: 'desc' }, { id: 'desc' }]`（P0-1-27），
      //    两处各写一份就会有"改了一处忘了另一处"的漂移，故 P0-1-28 收成一个常量。
      //    `id desc` 是**确定性**的兜底：`created_at` 是毫秒精度，同一事务里写的两条可能同值
      //    （messages 的主键是 `(id, created_at)`，`id` 是 uuid(7) ⇒ 时间有序）
      orderBy: [...MESSAGE_CHRONO_ORDER],
      take: rounds * 2,
      select: { role: true, content: true },
    })
    historyRows.reverse() // 上面是倒序取的（要"最近的 N 条"），还原成时间正序再组装
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(agent.systemPrompt, knowledgeCatalog, {
          userProfileBlock: userProfile.block,
          memoryTocBlock: memoryToc.block,
          memoryRules: memorySettings.enabled,
        }),
      },
      ...selectHistoryMessages(historyRows as HistoryRow[], rounds),
      // 本轮用户消息 + 附件（P1-4）：图片→多模态 part、文本类→拼进正文（见 `buildUserChatMessage`）
      buildUserChatMessage(content, input.attachments),
    ]

    // ── ⑤ LLM 流式调用 + 工具循环（`delta` / `thinking` 透传；P0-2-8 起含 MCP 工具）──
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

    /** 发一张工具卡（同一 `callId` 多次推送 = 状态机流转；前端按 `callId` upsert） */
    const toolTextOffsets = createToolTextOffsetTracker(() => assistantText.length)
    const withToolTextOffset = <T extends { callId: string }>(payload: T): T & { textOffset: number } => ({
      ...payload,
      textOffset: toolTextOffsets.offsetFor(payload.callId),
    })
    const emitToolCard = (payload: SseToolCallPayload): void => {
      enqueue({ name: 'tool_call', data: withToolTextOffset(payload) })
    }

    /** TTFT（`02` §十三：阶段一"首字 < 3s"验收的**唯一**测量依据，不能事后补） */
    const requestedAtMs = Date.parse(input.startedAt)
    let ttftLogged = false

    let summary: ChatStreamSummary | null = null
    let failure: unknown = null
    /**
     * 本轮的**总**用量：工具循环里每一轮上游各给一份 ⇒ 相加（`sumUsages`，
     * **不是** `mergeUsage` —— 那个合的是"同一次调用的两半"，见 `protocol.ts`）。
     */
    let totalUsage: ChatUsage | null = null
    /** 本轮累计收到多少个非空增量（跨多轮之和，日志用） */
    let totalDeltas = 0
    /** 已经**执行**过几轮工具（判据是"执行了几轮"，见文件头 ④①） */
    let toolRounds = 0
    /** "已达上限"那条提示**只注入一次**（否则每次都要多一轮上游往返） */
    let limitNoticeSent = false
    /**
     * 本轮**是否触发过工具轮数上限**（= 上面对模型注入过 {@link TOOL_LOOP_LIMIT_NOTICE}）。
     * 收尾时据此决定要不要给用户追加一句"已达上限"的说明（见 {@link toolLoopLimitUserNotice}）。
     */
    let limitReached = false
    /** 上限值（收尾文案要用；循环里每轮重读 config，这里缓存触发时的那份） */
    let limitRounds = 0
    /**
     * 流式出口的脏文本过滤器（见 `chatContext.ts#createToolCallTextFilter`）：把模型**回吐进
     * 正文**的工具调用标记（`<tool_call><function=…>`，mimo 实测）扣下并丢弃，别让它上流/落库。
     */
    const toolTextFilter = createToolCallTextFilter()
    /** 实际流过的上游轮数（= 1 + 工具轮数；日志与排查用） */
    let upstreamRounds = 0

    /**
     * 调用者（会话的 owner）—— **懒加载**（见文件头 ④③）。
     *
     * 只有"真的要执行一个工具"时才查：绝大多数轮次根本不碰 MCP，为一次不存在的需求
     * 每轮多查一次 `conversations` 是白花钱。查到就缓存（同一轮里多个工具共用一个）。
     */
    let viewerUserId: string | null = null
    const resolveViewer = async (): Promise<{ userId: string }> => {
      if (viewerUserId === null) {
        const row = await db.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true },
        })
        // 会话在流中途消失基本不可能（进门前 `assertConversationSendable` 已查过）
        if (row === null) throw AppError.notFound('会话不存在')
        viewerUserId = row.userId
      }
      return { userId: viewerUserId }
    }

    /**
     * 本轮（这一条用户消息）里**已被用户取消 / 等待超时**过的危险工具名。
     *
     * 🔧 修复"反复弹卡"：`TOOL_CONFIRM_REJECTED_OUTPUT` 已经明说"请不要重试"，但模型并不总是
     * 听话 —— 它把同一个工具再报一次，就会**又弹一张确认卡**，一轮一轮直到工具轮数上限。
     * 用户的观感是"取消了却一直在弹同一张卡 / 卡住"。这里按**工具名**记住"本轮已经拒过它"，
     * 之后模型再请求同名工具时**不再弹卡**，直接按取消回填 —— 用户对同一个工具只需拒一次。
     * 作用域是"这一轮用户消息"（放在 `for(;;)` 之外），下一条消息重新开始。
     */
    const blockedToolNames = new Set<string>()

    /**
     * 会话级自动审批（读一次缓存）——只用于决定"危险工具要不要**提前**落 RUNNING 卡"。
     * 开了自动审批 ⇒ 不会弹确认卡，提前落 RUNNING 不矛盾；没开 ⇒ 危险工具仍等确认卡（见下）。
     * 中途切换开关的极短竞态可接受（下一轮才生效）。
     */
    const autoApprove = await readAutoApprove(conversationId)

    try {
      for (;;) {
        const limit = config.limits.toolLoopLimit
        /**
         * "还允不允许要工具"（见文件头 ④①）：到上限后就**当轮撤掉 `tools`** + 注入提示。
         * 撤掉比"等它要了再拒"少一次上游往返，而且**只有请求里没有 `tools` 才是真的禁工具**。
         */
        const atToolLimit = toolRounds >= limit
        const withTools = tools.length > 0 && !atToolLimit
        if (atToolLimit && !limitNoticeSent) {
          limitNoticeSent = true
          limitReached = true
          limitRounds = limit
          messages.push({ role: 'user', content: TOOL_LOOP_LIMIT_NOTICE })
        }

        // 进度提示（ChatBot 现在也发 `status`，与 TaskAgent 同款口径）：上游还没吐字时，
        // 让占位/进度行有话说，而不是干等一个转圈。
        enqueue({
          name: 'status',
          data: { text: toolRounds === 0 ? '模型正在思考…' : '模型正在根据工具结果继续…' },
        })
        upstreamRounds += 1
        const round = await chatStream(
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
                    tools: tools.length,
                  },
                  '本轮首字延迟（TTFT）',
                )
              }
              /**
               * ⚠️ 过滤**在累加与上流之前**（不是落库前）：模型回吐的工具调用标记（如
               * `<tool_call><function=…>`）不该出现在用户眼前，也不该进 `assistantText`
               * （否则会进引用筛选 / 落库 / 回填历史）。过滤器按流扣住跨分片的半截标记，见
               * `chatContext.ts#createToolCallTextFilter`。
               */
              const clean = toolTextFilter.push(text)
              if (clean === '') return
              assistantText += clean
              enqueue({ name: 'delta', data: { text: clean } })
            },
            onThinking: (text) => {
              thinkingText += text
              enqueue({ name: 'thinking', data: { text } })
            },
            /**
             * 提前落"待调用"卡（体验修复）：模型先把**工具名**报出来、参数再一段段吐，而参数可能
             * 流很久（实测一轮 9 个调用花了 20+ 秒）。这里一知道"要调哪个工具"就先发一张 RUNNING 卡，
             * 别让那段时间界面一条事件都没有（看起来像卡死）。
             *   · 只对**目录里认得、且不需要确认**的 MCP 调用提前发：内置工具通常秒回；
             *     危险工具要先弹确认卡 —— 只有开了自动审批才不矛盾（用上面缓存的 `autoApprove` 兜住）。
             *   · `callId` 唯一 ⇒ 前端按 `callId` upsert，后面同一 `callId` 的真 RUNNING / 终态会覆盖它。
             */
            onToolCallStart: (call) => {
              const route = catalog.routes[call.name]
              if (route === undefined) return
              if (route.dangerous && !autoApprove) return
              emitToolCard({
                callId: call.id,
                toolName: call.name,
                serverName: serverNameById.get(route.serverId) ?? '',
                serverId: route.serverId,
                kind: 'MCP',
                status: 'RUNNING',
                inputSummary: '',
              })
            },
            // ⚠️ **不写 `onUsage`**：用量从每一轮返回的 `round.usage` 里取（那是外壳合并好的
            //    完整值）。两者同时算会把同一轮的用量记两遍（`onUsage` 回的就是 `round.usage`）。
          },
          withTools ? { abortSignal: signal, tools } : { abortSignal: signal },
        )
        summary = round
        totalUsage = sumUsages(totalUsage, round.usage)
        totalDeltas += round.deltaCount

        // 没有工具请求 ⇒ 这一轮就是最终回答
        if (round.toolCalls.length === 0) break

        if (atToolLimit) {
          /**
           * 已经撤掉 `tools` 并且提示过"不能再调工具"，模型**仍然**报了一个工具调用 ——
           * 模型侧的行为不可控 ⇒ 只能收尾：不能执行（那就是突破上限），也不能再追加一次提示
           * （那会变成无限循环）。
           *
           * ⚠️ 但**不能静默丢弃**（旧行为就是直接 `break`）：这里给每个未执行的调用补一张
           * `tool_call{status:ERROR}` 卡（上流 + 落库），让用户与排查都能看到"为什么这些调用没跑"，
           * 而不是让模型那一段被过滤掉的脏文本成为唯一的线索。
           */
          for (const call of round.toolCalls) {
            const route = catalog.routes[call.name]
            const parsed = parseToolArguments(call.arguments)
            const inputSummary = parsed.ok
              ? summarizeToolInput(parsed.value)
              : summarizeToolInput({ raw: call.arguments })
            const finished = {
              callId: call.id,
              toolName: call.name,
              serverName: route === undefined ? '' : (serverNameById.get(route.serverId) ?? ''),
              ...(route === undefined ? {} : { serverId: route.serverId }),
              kind: 'MCP' as const,
              status: 'ERROR' as const,
              inputSummary,
              output: toolLoopLimitUnexecutedOutput(limit),
            }
            emitToolCard(finished)
            toolRecords.push({ ...withToolTextOffset(finished), arguments: call.arguments })
          }
          logger.warn(
            {
              conversationId,
              agentId,
              limit,
              toolCalls: round.toolCalls.map((call) => call.name),
            },
            '已禁用工具并提示达上限，模型仍要求调用工具 ⇒ 不再执行，直接收尾（已补 ERROR 卡留痕）',
          )
          break
        }

        // 助手这一轮"我要调这些工具"的消息 —— **必须排在结果之前**（三协议都要求成对）
        // ⚠️ `round.text` 过一遍 `stripToolCallMarkup`：模型可能把工具调用**回吐进正文**，
        //    那半截脏文本回填给模型会强化"用文本模仿调用"的行为（见 `chatContext.ts`）。
        messages.push(buildAssistantToolCallsMessage(stripToolCallMarkup(round.text), round.toolCalls))

        const outcomes: ToolOutcome[] = []
        for (const call of round.toolCalls) {
          // ── 内置知识库工具（检索 / 目录 / 整篇阅读）：在**第一行**与 MCP 调用分流 ──
          //
          // 它们没有 MCP server / 凭据 / 危险确认，走不了下面那套（`route` 查不到、`McpToolRoute`
          // 也描述不了）。检索命中累积进 `searchHits`，供回答结束后的引用卡筛选。
          // 白名单判据收在 `isKnowledgeToolName`（唯一实现）—— 增删内置工具时不必回来改这里。
          const isBuiltinKnowledgeTool = kbIds.length > 0 && isKnowledgeToolName(call.name)
          if (isBuiltinKnowledgeTool) {
            const parsed = parseToolArguments(call.arguments)
            const inputSummary = parsed.ok
              ? summarizeToolInput(parsed.value)
              : summarizeToolInput({ raw: call.arguments })
            const base = {
              callId: call.id,
              toolName: call.name,
              serverName: KNOWLEDGE_TOOL_SERVER_NAME,
              kind: 'BUILTIN' as const,
            }
            emitToolCard({ ...base, status: 'RUNNING', inputSummary })
            await input.updateSnapshot({ currentTool: call.name })

            /**
             * ★ 执行体在 `orchestrator/knowledgeTools.ts`（**唯一实现**）：TaskAgent 经沙箱代理
             *   调用的是同一个函数。这里只负责发卡 + 攒引用命中（`searchHits`）。
             */
            const outcome = await executeKnowledgeTool({
              kbIds,
              name: call.name,
              arguments: call.arguments,
              log: { conversationId, agentId },
            })
            const status: ToolCallStatus = outcome.isError ? 'ERROR' : 'SUCCESS'
            const isError = outcome.isError
            const output = outcome.output
            searchHits.push(...outcome.hits)

            const finished = { ...base, status, inputSummary, output }
            emitToolCard(finished)
            toolRecords.push({ ...withToolTextOffset(finished), arguments: call.arguments })
            outcomes.push({ callId: call.id, text: output, isError })
            continue
          }

          // ── 内置「发送通知」工具（P1-6，场景 1）：与知识库同属内置族，按名字分流 ──
          if (call.name === SEND_NOTIFICATION_TOOL_NAME && getNotifyTarget(conversationId) !== undefined) {
            const parsed = parseToolArguments(call.arguments)
            const inputSummary = parsed.ok
              ? summarizeToolInput(parsed.value)
              : summarizeToolInput({ raw: call.arguments })
            const base = {
              callId: call.id,
              toolName: call.name,
              serverName: NOTIFY_TOOL_SERVER_NAME,
              kind: 'BUILTIN' as const,
            }
            emitToolCard({ ...base, status: 'RUNNING', inputSummary })
            await input.updateSnapshot({ currentTool: call.name })
            // 执行体在 `notify/index.ts`（**唯一实现**）：TaskAgent 经沙箱代理调的是同一个函数
            const outcome = await executeSendNotification({ conversationId, arguments: call.arguments })
            const status: ToolCallStatus = outcome.isError ? 'ERROR' : 'SUCCESS'
            const finished = { ...base, status, inputSummary, output: outcome.output }
            emitToolCard(finished)
            toolRecords.push({ ...withToolTextOffset(finished), arguments: call.arguments })
            outcomes.push({ callId: call.id, text: outcome.output, isError: outcome.isError })
            continue
          }

          // ── 内置「记住」工具（P1-8）：与知识库同属内置族，按名字分流 ──
          if (call.name === REMEMBER_TOOL_NAME) {
            const parsed = parseToolArguments(call.arguments)
            const inputSummary = parsed.ok
              ? summarizeToolInput(parsed.value)
              : summarizeToolInput({ raw: call.arguments })
            const base = {
              callId: call.id,
              toolName: call.name,
              serverName: MEMORY_TOOL_SERVER_NAME,
              kind: 'BUILTIN' as const,
            }
            emitToolCard({ ...base, status: 'RUNNING', inputSummary })
            await input.updateSnapshot({ currentTool: call.name })
            // 主语（user_id）来自**会话行**（现查），不从模型参数取（见 `memoryTools.ts`）
            const outcome = await executeMemoryTool({
              userId: conversationRow.userId,
              agentId,
              conversationId,
              arguments: call.arguments,
            })
            const status: ToolCallStatus = outcome.isError ? 'ERROR' : 'SUCCESS'
            const finished = { ...base, status, inputSummary, output: outcome.output }
            emitToolCard(finished)
            toolRecords.push({ ...withToolTextOffset(finished), arguments: call.arguments })
            outcomes.push({ callId: call.id, text: outcome.output, isError: outcome.isError })
            continue
          }

          // ── 内置「按需检索记忆」工具（P1-8a）：与 remember 同族，按名字分流 ──
          if (call.name === RECALL_MEMORY_TOOL_NAME) {
            const parsed = parseToolArguments(call.arguments)
            const inputSummary = parsed.ok
              ? summarizeToolInput(parsed.value)
              : summarizeToolInput({ raw: call.arguments })
            const base = {
              callId: call.id,
              toolName: call.name,
              serverName: MEMORY_TOOL_SERVER_NAME,
              kind: 'BUILTIN' as const,
            }
            emitToolCard({ ...base, status: 'RUNNING', inputSummary })
            await input.updateSnapshot({ currentTool: call.name })
            const outcome = await executeRecallMemoryTool({
              userId: conversationRow.userId,
              agentId,
              arguments: call.arguments,
            })
            const status: ToolCallStatus = outcome.isError ? 'ERROR' : 'SUCCESS'
            const finished = { ...base, status, inputSummary, output: outcome.output }
            emitToolCard(finished)
            toolRecords.push({ ...withToolTextOffset(finished), arguments: call.arguments })
            outcomes.push({ callId: call.id, text: outcome.output, isError: outcome.isError })
            continue
          }

          const route = catalog.routes[call.name]
          // `serverName` 从目录取（**不依赖执行成功**：失败时卡片也要显示"来自哪台 server"）
          const serverName = route === undefined ? '' : (serverNameById.get(route.serverId) ?? '')
          /**
           * 卡片与落库记录共用的那几列（`status` / `output` / `errorCode` 逐条不同）。
           *
           * ⚠️ **刻意不含 `arguments`**：SSE 的 `tool_call` payload 由
           * `toolCallRecordSchema.omit({ arguments: true })` 派生（完整入参**只留档、不上线**，见
           * `shared/src/conversation.ts`），而 `emit()` **序列化的是原对象、不是 `parsed.data`**
           * （zod 的 strip 只在 `parsed.data` 上生效）⇒ 一旦把 `arguments` 混进 payload 对象，
           * 它就会**原样出现在流里**。所以完整入参只在**落库那一份**上补（见下面 `toolRecords.push`）。
           *
           * ⚠️ **`serverId` 是 P0-2-11 加的**（`shared#toolCallRecordSchema` 的注释写了理由）：
           * 前端工具卡的「去配置凭据」要跳到 `/settings/credentials?serverId=…`，而 `serverName` 只是展示名。
           * 它与 `serverName` **同源地**取自目录（`route.serverId`）⇒ 两者要么都在、要么都不在；
           * `route === undefined`（模型报了一个我们没下发的工具名，见下面那段收尾）时两个都缺 ——
           * 那时卡片本来就没有"哪台 server"可指，跳转按钮也不会出现。
           */
          const base = {
            callId: call.id,
            toolName: call.name,
            serverName,
            ...(route === undefined ? {} : { serverId: route.serverId }),
            kind: 'MCP' as const,
          }
          const parsed = parseToolArguments(call.arguments)
          // 摘要取**解析后**的参数（与真的要发出去的那份一致）；解析失败时退回原串（如实展示）
          const inputSummary = parsed.ok
            ? summarizeToolInput(parsed.value)
            : summarizeToolInput({ raw: call.arguments })

          /**
           * ⚠️⚠️ **P0-2-10 的挂起点（原"接回点"）—— 危险工具必须先拿到用户确认才执行。**
           *
           * 位置是刻意的：**在取凭据、发 `RUNNING` 卡之前**。晚一步的后果是"确认卡上已经写着
           * 『运行中』、工具也已经发出去了"，而确认的全部意义就是"发出去之前问一句"。
           *
           * 三条判据（每条都对应一种"问了或没问都不该发生"的情形）：
           *   · **要不要问**读的是 `route.dangerous` —— 判定本身**已在 P0-2-9 做好**
           *     （`mcp/risk.ts`，判定表见 `02` §9.9）⇒ 本处**不再判一次**（两处判 = 迟早有一处先腐烂）。
           *   · **只对"本来能执行"的调用发问**：`route === undefined`（模型编了个名字）与
           *     `!parsed.ok`（参数不是合法 JSON）两条路**无论如何都不会执行任何东西** ——
           *     让用户在那种时候点一次确认，是在为一个必然失败的调用付交互成本。
           *   · **答案不是"确认"就不执行**（三种结局见 `ConfirmDecision`），但**这一轮不失败**：
           *     回填一条"未执行"的结果给模型，让它自己决定怎么说 —— 与 P0-2-8 门槛 2 同一条形态
           *     （`01` §3.6 的"取消后流程可继续"）。
           */
          /**
           * 🔧 反复弹卡修复：只有"本轮还没拒过这个工具"时才真的弹卡。
           *   · 已经拒过（或超时过）⇒ 直接按 `REJECTED` 处理，**不再弹第二张卡**；
           *   · 第一次遇到 ⇒ 弹卡等应答；应答是"取消 / 超时"则把工具名记进 `blockedToolNames`，
           *     使模型的后续同名请求走上面那条"不弹卡"分支。
           */
          let blocked: ConfirmDecision | null = null
          if (route !== undefined && parsed.ok && route.dangerous) {
            if (blockedToolNames.has(call.name)) {
              blocked = 'REJECTED'
              logger.info(
                { conversationId, agentId, toolName: call.name },
                '该工具本轮已被用户取消/超时，模型再次请求 ⇒ 不再弹确认卡，直接按取消处理',
              )
            } else {
              blocked = await input.awaitConfirm({ source: 'PLATFORM', toolName: call.name, inputSummary })
              // 取消与超时都意味着"这一轮不该再为它弹卡"（见 `blockedToolNames` 的注释）
              if (blocked === 'REJECTED' || blocked === 'TIMEOUT') blockedToolNames.add(call.name)
            }
          }
          const blockedOutput =
            blocked === null || blocked === 'CONFIRMED'
              ? null
              : blocked === 'TIMEOUT'
                ? TOOL_CONFIRM_TIMEOUT_OUTPUT
                : TOOL_CONFIRM_REJECTED_OUTPUT

          /**
           * 同一次调用的"二次确认去重"（`docs/08-…` §8）：本次调用已经过 PLATFORM 卡且用户确认了
           * （`route.dangerous` 为真且 `blocked === 'CONFIRMED'`）⇒ 同一调用途中的服务端
           * elicitation / `input_required` **自动 accept、不再弹第二张卡** —— 用户已经为
           * "执行这个危险工具"确认过一次。非危险工具（没弹过 PLATFORM 卡）不受影响，服务端卡照弹。
           */
          const platformConfirmed =
            route !== undefined && parsed.ok && route.dangerous && blocked === 'CONFIRMED'

          /**
           * 被用户拦下的调用**不发 `RUNNING` 卡**：那张卡的含义是"已经在跑"，而它其实没跑过。
           * 前端按 `callId` upsert（`shared#toolCallRecordSchema`）⇒ 只发那最后一张 ERROR 卡就够，
           * 不会出现"先运行中、再取消"的假状态流转。
           */
          if (blockedOutput === null) {
            emitToolCard({ ...base, status: 'RUNNING', inputSummary })
            await input.updateSnapshot({ currentTool: call.name })
          }

          let status: ToolCallStatus = 'SUCCESS'
          let output: string
          let errorCode: ErrorCode | undefined
          let isError = false

          if (blockedOutput !== null) {
            status = 'ERROR'
            isError = true
            output = blockedOutput
          } else if (route === undefined) {
            status = 'ERROR'
            isError = true
            output =
              `工具调用失败：本轮没有向模型提供名为「${call.name}」的工具` +
              '（可能是模型自己编的名字，或该工具所属的 MCP server 已被解绑）。'
          } else if (!parsed.ok) {
            status = 'ERROR'
            isError = true
            // 回填原参数（截断过）：模型据此改一次往往就成了 —— 这才是"失败可自愈"的形态
            output = `工具调用失败：${parsed.reason}。模型给出的原文：${truncateToolResult(call.arguments)}`
          } else {
            try {
              /**
               * server 反向 elicitation（`tools/call` 途中的 `elicitation/create`）⇒
               * **同一个挂起原语**（`06` P0-2-10 坑预判 1）：前端只有一种确认卡形态，
               * 所以两条来源都发 `confirm` 事件、都由 `POST /:id/confirm` 应答，
               * 差别只在 payload 的 `source`（决定前端那句话怎么写）。
               *
               * 三条映射口径（MCP 的 `ElicitResult.action` 只有这三个值）：
               *   · 用户确认 ⇒ `accept` —— P0 只有确认/取消二元语义（`02` §六 第 4 步明写
               *     "不做自由输入表单"）。⚠️ **v2 起（2026-07-28 的 `input_required`）：
               *     服务端的确认表单要求 accept 带表单值**（apitest 的 `mrtrGate` 读
               *     `acceptedContent(...,'confirm').confirm === true`），裸 accept 会被它
               *     当成 decline/cancel ⇒ 删除在服务端直接失败。P0 不做自由输入，只填
               *     "布尔 confirm"这一种表单（见 `confirmFormContent`）；对不上就仍不带 content；
               *   · 用户取消 ⇒ `decline`（MCP 的语义是"用户明确拒绝"）；
               *   · **超时 ⇒ `cancel`**（语义是"用户没给出答复就结束了"）——
               *     与 `decline` 分开，是因为服务端可能对这两种的处理不同。
               *
               * ⚠️ **与 `PLATFORM` 的挂起不同：拒答之后工具照常执行完** —— 那是服务端自己的
               * elicitation 流程（它拿到 `decline`/`cancel` 之后怎么做是它的事），
               * 我方不替它决定"这一条工具算不算没执行"（`isError` 由服务端回什么就是什么）。
               * ⚠️ 中断（用户点停止）在这里翻成 `cancel` 而不是抛出去：让上游收到一个**正常的**
               * 答复（它不会看到一个协议错误），而本轮的收尾由**信号**负责 —— 紧接着的下一次
               * 上游调用会以 `LlmAbortError` 结束，`chatBot` 据此按 `STOPPED` 收尾。
               */
              const onElicit = async (request: McpElicitRequest): Promise<McpElicitReply> => {
                // 同一次调用已过 PLATFORM 确认卡 ⇒ 服务端再问的那一次自动 accept（不弹第二张卡）。
                // 用户已经为"执行这个危险工具"确认过一次；服务端的 elicitation 只是它自己的确认回合
                // （`docs/08-…` §8 的去重）。应答形状与手动确认后的 accept 完全一致（含布尔 confirm 表单值）。
                if (platformConfirmed) {
                  logger.info(
                    {
                      conversationId,
                      agentId,
                      toolName: call.name,
                      serverName,
                      message: request.message,
                    },
                    '同一次调用已过 PLATFORM 确认卡 ⇒ 服务端 elicitation 自动 accept（不弹第二张卡）',
                  )
                  const content = confirmFormContent(request.requestedSchema)
                  return content === null ? { action: 'accept' } : { action: 'accept', content }
                }
                let decision: ConfirmDecision
                try {
                  decision = await input.awaitConfirm({
                    source: 'SERVER',
                    toolName: call.name,
                    // 服务端给的那句话原样给用户看（`02` §9.3：elicitation 请求 → confirm 事件挂起）
                    inputSummary: request.message,
                  })
                } catch (error) {
                  if (error instanceof ChatStoppedError) return { action: 'cancel' }
                  throw error
                }
                if (decision === 'CONFIRMED') {
                  const content = confirmFormContent(request.requestedSchema)
                  return content === null ? { action: 'accept' } : { action: 'accept', content }
                }
                return decision === 'TIMEOUT' ? { action: 'cancel' } : { action: 'decline' }
              }

              const execution = await executeMcpToolCall({
                serverId: route.serverId,
                viewer: await resolveViewer(),
                // ⚠️ MCP 侧的**原始**工具名（`routes` 里那个），不是下发给模型的 `call.name`
                toolName: route.toolName,
                args: parsed.value,
                signal,
                onElicit,
              })
              isError = execution.isError
              status = execution.isError ? 'ERROR' : 'SUCCESS'
              output = truncateToolResult(execution.text)
            } catch (error) {
              // 用户的「停止」**不是**工具失败 —— 它要真的中断这一轮（见文件头 ④②）
              if (error instanceof McpAbortError) throw error
              /**
               * 其余全部（缺凭据 424 / server 没了 404 / 上游 502/504）都**只是这一条工具失败**：
               * 卡片报错 + 错误文本回填，让模型自己决定怎么说（`01` §3.6"失败错误可见"的形态）。
               * 整轮失败会让用户只看到一张错误卡、拿不到任何解释 —— 比"这一轮答得不好"更差。
               */
              status = 'ERROR'
              isError = true
              errorCode = error instanceof AppError ? error.code : 'INTERNAL'
              output = truncateToolResult(
                `工具调用失败：${
                  error instanceof AppError ? error.message : DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL
                }`,
              )
              logger.warn(
                {
                  conversationId,
                  agentId,
                  toolName: call.name,
                  mcpServerId: route.serverId,
                  errorCode,
                  err: error,
                },
                'MCP 工具执行失败（已作为错误结果回填给模型，本轮不因此失败）',
              )
            }
          }

          const finished = {
            ...base,
            status,
            inputSummary,
            output,
            ...(errorCode === undefined ? {} : { errorCode }),
          }
          emitToolCard(finished)
          // ⚠️ 完整入参**只补在落库这一份**上（`base` 里刻意没有它，见上面那段注释）——
          //    卡片要的是 `inputSummary` 摘要，而"模型到底传了什么"只有完整入参能回答。
          toolRecords.push({ ...withToolTextOffset(finished), arguments: call.arguments })
          outcomes.push({ callId: call.id, text: output, isError })
        }

        messages.push(...buildToolResultMessages(outcomes))
        // 工具段结束：`/active` 的 `currentTool` 要清掉（否则重连的人会以为还在跑那个工具）
        await input.updateSnapshot({ currentTool: null })
        toolRounds += 1
      }
    } catch (error) {
      // 中断与故障在这里**都**只是"记下来"，统一的收尾在下面（见文件头 ①）：
      // 两条路都要落库（锁丢那一路除外），只是最终发出去的帧不同
      failure = error
    }

    // ── ⑤″ 流式过滤器的收尾 + "已达工具轮数上限"的用户可见提示 ──
    //
    // 1) `flush()`：放行过滤器 `carry` 里最后那段安全文本（若它其实以工具标记开头 ⇒ 判定为半截
    //    脏文本，丢弃）。不做这一步，流结束时扣住的尾巴会**凭空少一段正文**。
    // 2) 触发过工具轮数上限时，明确告诉用户"为什么停了"：模型回吐的脏文本已被滤掉，正文可能显得
    //    没头没尾，这一句是唯一的解释来源（见 `chatContext.ts#toolLoopLimitUserNotice`）。
    //    ⚠️ 只在**正常收尾**（无故障、未被中断）时补 —— 故障/中断下用户看到的是错误/停止卡，
    //    再叠一句"工具达上限"会让人误判这一轮到底是哪种结局。
    const trailing = toolTextFilter.flush()
    if (trailing !== '') {
      assistantText += trailing
      enqueue({ name: 'delta', data: { text: trailing } })
    }
    if (limitReached && failure === null && abortReasonOf(signal) === undefined) {
      const notice = toolLoopLimitUserNotice(limitRounds)
      assistantText += notice
      enqueue({ name: 'delta', data: { text: notice } })
    }

    // ── ⑤′ 引用卡：只在回答**真的引用了某篇文档**时才发（产品反馈 2026-09-30）──
    //
    // 判据与筛选在 `toUsedCitationItems`（纯函数）：回答里出现某个命中的文档名 ⇒ 算它被引用；
    // 按文档去重；回答为空则一条都不发。**不再**"检索到几条就发几条"。
    // ⚠️ 经**串行队列**发（不是直接 `await input.emit`）：此刻队列里可能还压着没写完的 `delta`，
    //    直接 emit 会插队、让引用卡跑到正文前面。`enqueue` 保证它排在正文之后、`done` 之前。
    citations = toUsedCitationItems(searchHits, assistantText)
    if (citations.length > 0) {
      enqueue({ name: 'citations', data: { items: citations } })
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
      // 附件（P1-4）：随用户消息落库，刷新后用户气泡里仍能看到当时带过什么
      attachments: attachmentItemsOf(input.attachments),
      assistantText,
      thinkingText,
      citations,
      toolRecords,
      // 产品优化 2026-09-29：把"本轮实际用的模型"记进助手消息的 content.model 段，
      // 重进会话时头部模型选择器据此回显（`input.target` 就是闸门解析出来的那个目标）。
      model: {
        modelId: input.target.modelId,
        modelName: input.target.modelName,
        modelLabel: input.target.label,
      },
      usage: totalUsage,
      // ── 计量行（P1-7）：ChatBot 也写 `usage_records` ──
      // P0-3-12 留的接回点就是这里（见文件头 ③）。口径与 TaskAgent 一致：**这一轮真的发生过**
      // 才写（前置失败 / 锁丢都在本函数之前抛出去了）；token 取不到就 `null`，不编 0；
      // `rounds` = 本轮上游请求轮数（`upstreamRounds`，含工具循环）、`durationMs` = 本轮墙钟。
      usageRecord: {
        model: input.target.modelName,
        tokensIn: totalUsage?.tokensIn ?? null,
        tokensOut: totalUsage?.tokensOut ?? null,
        durationMs: Date.now() - requestedAtMs,
        rounds: upstreamRounds,
        createdAt: new Date(),
      },
      logger,
    })

    if (emitFailure !== undefined) throw emitFailure
    if (fatal) throw failure

    // ── 长期记忆提取（P1-8）：**落库之后**、与 bot 类型无关（见 `memoryExtract.ts`）──
    // 只对正常/被停止的一轮做（`fatal` 已抛出去）：显式"记住"、偏好建议、显式"忘掉"都在这里发生。
    await runMemoryExtraction({
      conversationId,
      userId: conversationRow.userId,
      agentId,
      userText: content,
      assistantText,
      enabled: memorySettings.enabled,
      autoExtract: memorySettings.autoExtract,
      fullAuto: memorySettings.fullAuto,
      conversationExcluded: conversationRow.memoryExcluded,
      // 画像模型归一用它解析上游目标（与本轮对话同一个模型）
      modelId: input.target.modelId,
    })

    const finishReason = interrupted ? 'STOPPED' : 'COMPLETE'
    if (!interrupted && summary !== null && summary.rawFinishReason !== null && summary.rawFinishReason !== 'stop') {
      // `length`（被 max_tokens 截断）/ `content_filter` 之类：契约里没有对应的 finishReason
      // （SSE 契约只有 COMPLETE|STOPPED|ERROR）⇒ 如实按 COMPLETE 收尾，但**必须留痕**，
      // 否则"回答被腰斩"在服务端没有任何线索（`02` §6.1：归一化会丢掉这个决策信息）
      logger.warn(
        { conversationId, rawFinishReason: summary.rawFinishReason, deltaCount: totalDeltas },
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
        // 工具循环的三条实况：调过几次工具 / 下发了几个工具 / 上游共流了几轮
        toolCalls: toolRecords.length,
        tools: catalog.tools.length,
        upstreamRounds,
        deltaCount: totalDeltas,
        durationMs: Date.now() - requestedAtMs,
        // ⚠️ 多轮的**总**用量（`sumUsages`）；某次上游没给 usage ⇒ 该字段为 `null`（不知道就不编）
        tokensIn: totalUsage?.tokensIn ?? null,
        tokensOut: totalUsage?.tokensOut ?? null,
      },
      'ChatBot 本轮结束',
    )

    return {
      messageId,
      finishReason,
      usage: totalUsage === null ? null : { tokensIn: totalUsage.tokensIn, tokensOut: totalUsage.tokensOut },
    }
  } finally {
    release()
  }
}

/**
 * ⚠️ `persistRoundQuietly()` 与它的入参类型自 **P0-3-6** 起搬到了 `persist.ts`。
 *
 * 理由：**两个编排器**（本文件的 ChatBot、`taskAgent.ts` 的 TaskAgent）收尾时要落同一件事，
 * 而"助手消息什么时候该写"这类判据在两处各写一份必然有一处先腐烂（`06` §六 第 ⑰ 条）。
 * 行为**逐字未变**（只搬位置 + 把 `usage` 的入参收窄成 `RoundUsage`）——
 * 想核对时看 `git log -p -- backend/src/orchestrator/chatBot.ts` 里删除的那一段。
 */

/**
 * 二进制确认表单 → accept 时要回填的 `content`。
 *
 * 现代协议（2026-07-28 的 `input_required`）下，服务端（如 apitest 的 MRTR）用**表单式**
 * elicitation 请求确认，`requestedSchema` 是 `{type:'object', properties:{confirm:{type:'boolean'}},
 * required:['confirm']}`，其 `mrtrGate` 读的是 `acceptedContent(...,'confirm').confirm === true`。
 * P0 不做自由输入，只认这一种"布尔 confirm"表单；schema 形状对不上就返回 `null`
 * （保持裸 accept，legacy 反向通道的旧行为不变）。
 */
function confirmFormContent(schema: unknown): Record<string, boolean> | null {
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isPlainObject(schema)) return null
  if (schema.type !== 'object') return null
  const properties = schema.properties
  if (!isPlainObject(properties)) return null
  const confirm = properties.confirm
  if (!isPlainObject(confirm) || confirm.type !== 'boolean') return null
  return { confirm: true }
}
