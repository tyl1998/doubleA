/**
 * TaskAgent 编排循环（P0-3-6）—— 「一次派活」的完整生命周期
 *
 * 依据：`docs/02-后端设计.md` §七（TaskAgent 编排概要：1 沙箱获取 / 2 会话容器 / 2.5 LLM 注入 /
 *      3 引擎桥 / 4 MCP 后端代理 / 5 空闲回收与停止 —— **「谁派活、事件怎么映射」这一步就是本文件**）、
 *      `docs/子方案/沙箱与引擎集成.md` §六（桥与映射表）+ §七（MCP 走后端代理）+ §九 2（停止与回收）、
 *      `docs/06-实施计划.md` §五 P0-3-6 行（事件映射 + 编排）
 *
 * ```
 * 入口：POST /chat（会话的 Agent 是 TASK_AGENT）
 *  ① ensureSandbox(conversationId)   → 排队位次 ⇒ `queued` 事件 + `/active` 快照
 *  ② getSandboxRpc(...)              → 一个会话一条桥，与容器同寿命（P0-3-5）
 *  ③ onEvent(map.ts)                 → 引擎事件 ⇒ `delta` / `thinking` / `tool_call{kind:SANDBOX}`
 *  ③.4 写会话记忆 + 前置阅读指令   → `memoryDoc.ts`（块 1）：写 /work/.doubulea/memory.md，
 *                                     有内容时在这轮 prompt 前加一句"先读它"（落库仍是用户原文）
 *  ③.4 写会话记忆 + 前置阅读指令   → `memoryDoc.ts`（块 1）：写 /work/.doubulea/memory.md，
 *                                     有内容时在这轮 prompt 前加一句"先读它"（落库仍是用户原文）
 *  ③.5 reconcile + 记轮次起点        → 把 setup 写（记忆文档 / 附件）对账进工作区索引，再记窗口起点
 *                                     （P1-9 · R4：产物判据 = 本轮工作区变更集，起点 = 窗口左界）
 *  ④ runTurn(content, {signal})      → 派活 + 等 **`agent_settled`**（不是 `agent_end`，见 `bridge.ts`）
 *  ④.5 reconcile + collectRoundArtifacts(...) → 取本轮变更集 ⇒ 传对象 + 建行 ⇒ `artifact` 事件（R4）
 *  ⑤ 冲刷帧队列 + 清 `/active`       → 帧必须写完再落库（顺序即"事件即真相"）
 *  ⑤ 冲刷帧队列 + 清 `/active`       → 帧必须写完再落库（顺序即"事件即真相"）
 *  ⑥ persistRoundQuietly + 计量（`usage_records`）+ done{usage}
 *  ⑦ 用户停止 ⇒ 收沙箱              → closeSandboxRpc + recycleSandbox（容器与具名卷一并回收，P0-3-8）
 * ```
 * 它由 `orchestrator/index.ts#resolveChatProducer()` 按 `agent.type` 单点接回 ——
 * 路由与 SSE 出口层**一行都不用改**（这是 P0-1-26 定 `ChatProducer` 这个形状时就留下的接回点）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 落库判据 = 「**这一轮真的发生过**」，唯一例外是 `lock-lost`
 * ═══════════════════════════════════════════════════════════════════════
 * 与 `chatBot.ts` **同一条**（这条口径只许有一处来源，两边各写一遍必先腐烂一处）：
 *   · **发生过** ⇒ 落库（哪怕只有一个工具卡、哪怕用户中途停了 —— `01` 决策 15「停止即中断，
 *     已生成内容保留」：保留的前提就是落库，否则刷新之后用户看到的是"我停了一下，问题没了"）；
 *   · **没发生过**（拿不到沙箱 / 模型不可用 / 建容器失败）⇒ **不落库**，留一条"只有问题、
 *     永远没有答案"的记录会让下次刷新时用户以为自己问过但被丢了（`chatBot.ts` 文件头 ② 同款）；
 *   · ⚠️ **`lock-lost` 一律不落库**（判据见 `sse.ts#abortReasonOf`）：那时这个会话可能已经有
 *     **另一个流**在写历史，我们再写一次就是两边往同一份历史里插消息。
 * 用户**在排队时**点了停止算"发生过"（他发起了、又主动停了）：这一轮确实存在，只是没有产出
 * ⇒ 落库（只写用户消息，助手消息因为内容全空而不写）⇒ `done{messageId:null, STOPPED}`。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 失败码 → 出口：**只在本层映射，别在映射层再发明一套**
 * ═══════════════════════════════════════════════════════════════════════
 * `ensureSandbox` 的 `SandboxAcquireFailure` 与 `runTurn` 的 `TurnFailureReason` 都是**枚举**
 * （不是文案），正是为了让"回什么"这件事集中在两个纯函数里（见文件末尾
 * `sandboxAcquireError` / `engineFailureError`，各有取值域与理由表）。
 *
 * ⚠️ **两者最终都出口成流内 `error{code}` 帧** —— 这一点容易想错，写在这里免得下次误改：
 * `producer` 是 `streamChatReply` 在 **`reply.hijack()` 之后**才调用的（那里要先把互斥锁、
 * 心跳、停止轮询都挂上），所以本函数抛出的 `AppError` 一定被出口层的 `catch` 接住、走
 * `SseChannel#fail` ⇒ `error` 帧（HTTP 早已是 200 的 SSE）。**JSON 信封只属于"在
 * `streamChatReply` 之前就抛"的那一类**（未登录 / 参数 / 会话不是我的 / 会话只读 / 缺凭据 ——
 * 全在 `assertConversationSendable` 里）。这与 `chatBot.ts` 的并发闸 `AppError.busy` 是
 * **同一条路径**（它也在 producer 里抛）。
 *
 * 于是"选哪个 `AppError` 工厂"的唯一作用 = **选 `error` 帧里的 `code`**（前端按它取文案，
 * `03` §六），`status` 在这条路径上用不到。两条纪律仍然成立：
 *   · 主语是"**这一轮生成**"（沙箱是**每一轮**的资源）⇒ 该在对话区以错误卡收口，而不是信封；
 *   · ⚠️ **pi 与沙箱的原始细节只进日志、绝不进 SSE**（`02` §十）：引擎报错常是一句英文 +
 *     路径 + 内部状态，直接发给用户既读不懂也定位不了 ⇒ `message` 一律是我们自己写的中文；
 *     唯一例外是 `ensureSandbox` 那几条**本来就写给用户看**的配置类文案。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 三条实现判据（每条都对应一种"跑起来才知道"的静默失败）
 * ═══════════════════════════════════════════════════════════════════════
 * ① **订阅必须早于派活**：`bridge.ts#runTurn` 内部已经保证"先挂 `agent_settled` 等待者再
 *    `send(prompt)`"，本层同理 —— `onEvent` 挂在 `runTurn` **之前**。反过来的症状是
 *    "一次极快的收尾里，前几条增量没进过我们的 accumulator"（回答少一截，历史看着完整）。
 * ② **累积是同步的、发帧是串行的**：`bridge` 的事件回调是**同步**的（它逐行解析 stdout），
 *    而 `emit` 是异步的（过 schema + 背压等 `drain`）⇒ 分两半做：
 *    「记下来」（`assistantText` / `toolRecords` / `usage`）**在回调里同步完成**，
 *    「发出去」进一条串行队列（`enqueue`）。`void emit(...)` 会同时丢掉**帧顺序**与**错误**。
 * ③ **usage 要按引擎的 turn 归集：同一 turn 内「覆盖」、跨 turn「相加」**（P0-3-12 订正）：
 *    引擎给的 `message_update.usage` 是「**这一个 assistant turn** 的累积值」（pi `docs/json.md`：
 *    "latest cumulative provider-reported usage for **the assistant response**"），
 *    而 **一个 turn = 一次模型请求**（pi `how-pi-works.md`："…That completes one turn. If tool
 *    results … require another model request, Pi starts another turn."）⇒ 两条一起才是对的：
 *      · **同一 turn 内**逐帧递增 ⇒ 后一帧**盖掉**前一帧（不要累加，会重复计）；
 *      · **turn 结束时**把这个 turn 的值**并进总数**，下一 turn 从零开始 ⇒ 多轮工具循环
 *        的总量 = 各 turn 相加（与 ChatBot 的 `sumUsages` 同一条口径，`子方案③` §十 的原文要求）。
 *    ⚠️ **P0-3-6 时只做了前半句**（"覆盖不是相加"），于是多轮工具循环里**只留了最后一轮**的
 *    用量 —— 客户端看到的 token 数偏小，而**没有任何断言会红**（它是个"看起来合理"的数）。
 *    P0-3-12 做的是计量，这条偏小直接进 `usage_records`，所以必须在这一批订正。
 *    ⚠️ 另一处同族修正：**全 0 的 usage 视为"没上报"**（不上报 usage 的 provider 全程给 0，
 *    见 `map.ts#readEngineUsage`）—— 那不是"用了 0 个 token"。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 本批**刻意不含**的（属后续批次，不要顺手补）
 * ═══════════════════════════════════════════════════════════════════════
 *   · **产物下载 / 列表 / 预览端点**（`GET /:id/artifacts`、`GET /artifacts/:id/download`、
 *     `.../content`）→ **P0-3-9 / P0-3-10**。本批只把行建出来、事件发出去，前端还没有消费面。
 *   · **MCP 工具卡与后端代理**（`kind:MCP` + `serverId` 反查）→ ✅ **已在 P0-3-9b 落地**：
 *     本层 ③.4 预热工具清单并把 `resolveMcpTool` 注进 `createEngineEventMapper`，于是
 *     "经 §七 代理出去的 MCP 工具"确实会发成 `kind: MCP` 的卡（带 `serverId`）；
 *     ⚠️ 清单**拿不到**时（Redis 抖动 / 没绑定）本层**不落轮**，映射器退回 `kind: SANDBOX`。
 *   · **跨请求提问原语**（`askConversation()` / 活跃通道注册表）→ ✅ **P0-3-6b 落地**（`sse.ts`）。
 *     ⚠️ 但**本层不用它**：容器内的 `bash` / `read` / `write` / `edit`
 *     **不做**逐工具确认（`子方案③` §八 5 的判据 —— **只有"跨出容器边界"的动作才需要确认卡**；
 *     容器内的破坏面已被容器边界框死）。它的唯一调用方是 **P0-3-9b** 的沙箱 MCP 代理端点
 *     （`sandbox/proxy.ts#runDangerousCall`）。
 *   · **停止路径的沙箱回收** → ✅ **已在 P0-3-8 落地**（见下方 ⑦）：只在**用户停止**
 *     （`stopReason === 'user'`）时回收，且排在**收产物与落库之后**；`bridge#runTurn` 的
 *     abort 监听把信号翻成引擎的 `abort` 命令 + 15s 宽限（P0-3-5 落的），宽限内没收尾的
 *     卡死引擎由回收时的 `force` 删除（SIGKILL）兜底 —— 这就是"要不要升级成回收容器"的答案。
 *
 * 📌 `input.target` 在本层**刻意不用**（也不是"忘了"）：容器里的 pi 用的是**注入进容器的那一份**
 * 目标（P0-3-4，`ensureSandbox` 内部自己解析 `agents.model_id`），后端这边一次 LLM 调用都不发。
 * 路由的闸门仍会解析一次 —— 那不是浪费：它把"缺凭据"在**流开始之前**变成一个 424 信封
 * （`02` §五 的前置失败口径），比流内 `error{NEED_CREDENTIAL}` 对用户更清楚。
 */

import {
  AppError,
  type ArtifactItem,
  type ConversationActiveSnapshot,
  type SseEvent,
  type ToolCallRecord,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { sumUsages, type ChatUsage } from '../llm/protocol.js'
import {
  closeSandboxRpc,
  collectRoundArtifacts,
  ensureSandbox,
  ensureSandboxMcpCatalog,
  getSandboxRpc,
  recycleSandbox,
  resolveSandboxMcpTool,
  type SandboxAcquireFailure,
  type SandboxHandle,
  type SandboxMcpCatalog,
  type PiSessionEvent,
  type SandboxRpc,
  type TurnFailureReason,
  type TurnOutcome,
} from '../sandbox/index.js'
import {
  createEngineEventMapper,
  engineTurnBoundaryOf,
  type EngineBuiltinToolCard,
  type EngineMcpToolCard,
  type EngineUsage,
} from '../sandbox/map.js'
import { enterRunPhase, executionCommandOf, isExecutionCommand } from '../sandbox/credentialPhase.js'
import {
  KNOWLEDGE_CATALOG_MAX_DOCS_PER_KB,
  KNOWLEDGE_TOOL_SERVER_NAME,
  KNOWLEDGE_USAGE_RULES,
  ATTACHMENT_CONTEXT_NOTE,
  MEMORY_TOOL_RULES,
  RETRIEVAL_RULES,
  attachmentItemsOf,
  formatKnowledgeCatalog,
} from './chatContext.js'
import { taskAttachmentPromptBlock, writeAttachmentFiles } from './attachmentFiles.js'
import { boundKnowledgeBaseIds, loadKnowledgeCatalog } from './knowledgeTools.js'
import { runMemoryExtraction } from './memoryExtract.js'
import { buildMemoryDoc, memoryDocReadInstruction, writeMemoryDoc } from './memoryDoc.js'
import { persistRoundQuietly, type UsageRecordInput } from './persist.js'
import { attachToolTextOffsets, createToolTextOffsetTracker } from './toolTextOffset.js'
import { getMemorySettings } from '../services/memory.service.js'
import {
  recordWorkspaceRoundEnd,
  recordWorkspaceRoundStart,
  listWorkspaceChanges,
  reconcileWorkspaceOnce,
  subscribeWorkspaceEvents,
  workspaceEditSteerMessage,
} from '../workspace/index.js'
import { ChatStoppedError, abortReasonOf, type ChatProducer } from './sse.js'

/**
 * TaskAgent 的编排循环（`orchestrator/index.ts` 按 `agent.type` 取它）。
 *
 * @throws {AppError} 前置失败（`06` §五 P0-3-6 的取值域见 `sandboxAcquireError`）：
 *   `INTERNAL`(500) 镜像/代理没配或建容器失败 / `BUSY`(429) 排队超时 /
 *   `CONFLICT`(409) 会话已结束或本轮模型不可用
 * @throws {AppError} 流内故障（`engineFailureError`）：`UPSTREAM_ERROR`(502) 引擎退出或被拒 /
 *   `UPSTREAM_TIMEOUT`(504) 引擎长时间不响应 —— **已生成的内容照样落库**后才抛
 * @returns 正常 / 中断都以 `done` 收尾（`finishReason` = `COMPLETE` | `STOPPED`）
 */
/**
 * ★ 模型相位静默看门狗的**提示间隔**（ms）。
 *
 * 处于「等模型」相位且这么久没有任何引擎事件 ⇒ 推一条 `status` 帧（**只提示、不中止**）。
 * 判据、相位划分与取舍见 `taskAgentProducer` 里那段注释。
 */
const MODEL_SILENCE_NOTICE_MS = 60_000

export const taskAgentProducer: ChatProducer = async (input) => {
  const logger = getLogger()
  const { conversationId, agentId, content, signal, startedAt } = input
  /** TTFT 与总耗时的**唯一**基准（`02` §十三：不能事后补） */
  const requestedAtMs = Date.parse(startedAt)

  /**
   * 本轮的累积状态（"这一轮真的发生过"的四个东西 + 引擎侧的两条实况）。
   *
   * ⚠️ 装在**一个对象**里而不是散成几个 `let`，不是风格偏好：本对象的所有写入都发生在
   * `bridge.onEvent` 的**同步回调**里，而读取发生在回调之外 —— TS 的控制流分析看不见
   * 闭包里那次赋值，会把散放的 `let` 一路窄化成初始值（`null` / `''`），
   * 于是在收尾处读 `round.usage?.tokensIn` 会直接报
   * `Property 'tokensIn' does not exist on type 'never'`（`null?.x` 的推导结果）。
   * **对象属性不受这条规则影响**（实测过两种写法，只有对象形态能过 `tsc`）。
   */
  const round = {
    /** 助手正文（引擎的 `text_delta` 逐条累加；落库后是助手消息的 `content.text`） */
    assistantText: '',
    /** 思考过程（引擎的 `thinking_delta`；`01` 决策 · 可折叠渲染） */
    thinkingText: '',
    /** 工具调用记录（落库那份**带 `arguments`** —— 见 `map.ts#EngineEventMapping.toolRecord`） */
    toolRecords: [] as ToolCallRecord[],
    /**
     * 本轮**总量**（跨 turn 相加后的结果；落 `messages.tokens_*`、`usage_records` 与 `done.usage`）。
     * ⚠️ 类型用 `ChatUsage`（含 `tokensTotal`）只为**复用 `sumUsages`** —— 那个函数是
     * "多轮用量相加"这条口径的**唯一实现**（ChatBot 的工具循环也是它，`子方案③` §十 明确
     * 要求两边同口径）。对外只投影 `tokensIn` / `tokensOut`（见 `toEngineUsage`）。
     */
    usageTotal: null as ChatUsage | null,
    /**
     * **当前 turn** 的最新值（引擎在同一 turn 内逐帧递增 ⇒ 直接覆盖）。`null` = 这个 turn
     * 至今没有哪一帧带过它。turn 结束时并进 {@link round.usageTotal} 再清空。
     */
    currentTurnUsage: null as EngineUsage | null,
    /** 引擎这一轮跑了几轮（`turn_start` 条数 = 模型请求次数）。`usage_records.rounds` 用它 */
    turns: 0,
    /** 收到的正文增量条数（日志用；也是 TTFT 的判据） */
    deltaCount: 0,
    // ── 引擎事件的"可解释性"计数器（`map.ts` 文件头的 known / anomaly）──
    /** 引擎发过、但映射表里没有的事件名（版本漂移）。**只留痕**，不进事件流 */
    unknownEventTypes: new Set<string>(),
    /** 认识、但载荷用不了（缺必填字段）的次数 —— 每一条都当场 warn，见下面的处理 */
    anomalies: 0,
  }

  /**
   * 工具卡的**正文偏移**追踪（`textOffset`）—— 卡片插在"它出现时正文写到哪"的位置。
   * 与 ChatBot **同一份实现**（`toolTextOffset.ts`）；`getTextLength` 读本轮的正文累积。
   */
  const toolTextOffsets = createToolTextOffsetTracker(() => round.assistantText.length)

  /**
   * 把"当前 turn"的用量并进总数（判据 ③ 的后半句）。
   *
   * 三个调用点各有理由，缺一个都会漏计或重复计：
   *   · `turn_end` —— 这一个 turn 的 usage 已定稿（**正常路径**，pi `docs/json.md`）；
   *   · `turn_start` —— **防呆**：万一 `turn_end` 没收到（引擎异常/中断在两条事件之间），
   *     下一个 turn 开始时先把上一个 turn 的值归位，而不是让它被覆盖掉；
   *   · **收尾**（`runTurn` 之后）—— 最后一个 turn 可能还没 `turn_end`（被中断、或引擎
   *     直接退出）⇒ 那之前产生的 token 是**真实的**，照算。
   */
  const flushTurnUsage = (): void => {
    const current = round.currentTurnUsage
    if (current === null) return
    round.usageTotal = sumUsages(round.usageTotal, { ...current, tokensTotal: null })
    round.currentTurnUsage = null
  }

  /**
   * 帧的串行队列（判据 ②）。
   *
   * 与 `chatBot.ts` 里那条同名机制**同款**：`enqueue` 把"发一组帧 + 更新一次 `/active` 快照"
   * 排成一条链，首个错误记在 `frameFailure` 里（留到落库之后统一抛，见收尾）。
   * 空数组 + 无快照 = 空操作（不占一个微任务）。
   */
  let frameChain: Promise<void> = Promise.resolve()
  let frameFailure: unknown
  const enqueue = (events: readonly SseEvent[], snapshot?: Partial<ConversationActiveSnapshot>): void => {
    if (events.length === 0 && snapshot === undefined) return
    frameChain = frameChain
      .then(async () => {
        for (const event of events) await input.emit(event)
        if (snapshot !== undefined) await input.updateSnapshot(snapshot)
      })
      .catch((error: unknown) => {
        frameFailure ??= error
      })
  }

  /**
   * ★ 模型相位静默看门狗（**可见性，不中止**）。
   *
   * 为什么：引擎在容器里直连模型端点，平台侧只有事件流。一次真跑中上游"回了响应头、
   * 正文 356s 一个字节都没有"，整轮 `ttftMs≈468s`（几乎等于总耗时），界面表现是
   * 「一直转圈、毫无反馈」。出网代理侧已对模型端点加了空闲上限（掐断后交给引擎自己的
   * `auto_retry` 重发那一次 provider 请求）；这里补的是**可见性**：处于「等模型」相位且
   * 长时间没有任何引擎事件时，推一条 `status` 帧，让用户知道还在等、不是死了。
   *
   * ⚠️ **必须分相位**：只有「等模型」才算静默异常（正常模型流会持续吐 delta）；工具相位
   *    （`bash` 跑 npm/pytest）本来就可能长时间零输出 ⇒ **不提示、更不中止**。
   * ⚠️ `turn_start` 起是「等模型」，`tool_execution_*` / `turn_end` 起离开该相位 —— 不能用
   *    "整轮静默"当判据，那会把长工具误判成卡死。
   */
  let inModelPhase = false
  let silenceTimer: ReturnType<typeof setInterval> | null = null
  let silenceSinceMs: number | null = null

  const stopSilenceWatchdog = (): void => {
    if (silenceTimer !== null) clearInterval(silenceTimer)
    silenceTimer = null
    silenceSinceMs = null
  }

  /** 引擎事件到达：更新相位并重置静默计时（任何事件都算"有活动"） */
  const noteEnginePhase = (event: PiSessionEvent): void => {
    switch (event.type) {
      case 'turn_start':
        inModelPhase = true
        break
      case 'message_start': {
        const message = event.message
        const role =
          message !== null && typeof message === 'object'
            ? (message as { role?: unknown }).role
            : undefined
        inModelPhase = role === 'assistant'
        break
      }
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
      case 'turn_end':
      case 'agent_end':
      case 'agent_settled':
        inModelPhase = false
        break
      default:
        break
    }
    stopSilenceWatchdog()
    if (!inModelPhase) return
    silenceSinceMs = Date.now()
    silenceTimer = setInterval(() => {
      if (!inModelPhase || silenceSinceMs === null) return
      const waitedSec = Math.round((Date.now() - silenceSinceMs) / 1000)
      enqueue([
        {
          name: 'status',
          data: { text: `上游模型已 ${waitedSec}s 无响应，仍在等待（连接超时后会自动重试）…` },
        },
      ])
    }, MODEL_SILENCE_NOTICE_MS)
    silenceTimer.unref()
  }

  // ═══════════════════════════════════════════════════════════════════
  // ① 拿沙箱（前置失败在这里抛出 —— 此时还没 hijack，走 JSON 信封）
  // ═══════════════════════════════════════════════════════════════════
  const acquired = await ensureSandbox(conversationId, {
    signal,
    // 位次变化 ⇒ `queued` 帧 + `/active` 的 `queuedPosition`。两个出口**必须一起**更新：
    // `queued` 卡是"现在看得到"的，快照是"断线重连之后还看得到"的（`02` §5.2）。
    onQueued: (position) => {
      enqueue([{ name: 'queued', data: { position } }], { queuedPosition: position })
    },
  })

  if (!acquired.ok) {
    /**
     * `ABORTED` 的特殊之处：它**不是失败**，而是"用户在排队期间点了停止"。
     * 若在这里抛，用户看到的就是一张错误卡 —— 而他自己的动作被说成了系统故障。
     * ⇒ 记下来，走下面的收尾（落库 + `done{STOPPED}`），与"生成到一半被停止"同一条路。
     */
    if (acquired.code !== 'ABORTED') throw sandboxAcquireError(acquired.code, acquired.message)
    logger.info(
      { conversationId, agentId },
      '排队等待沙箱名额时被取消（本轮无产出，按"用户已停止"收尾）',
    )
  }

  let sandbox: SandboxHandle | null = null
  let bridge: SandboxRpc | null = null
  let unsubscribe: (() => void) | null = null
  /**
   * 中途插话（P1-9 · P4 · R1）的两条订阅，都必须在 `finally` 退订（桥/通道活得比一轮久）。
   *   · {@link unsubscribeSteer} —— **用户主动插话**（`POST /:id/steer` → Redis → 通道 → 这里）；
   *   · {@link unsubscribeWorkspaceEdits} —— **工作区主动感知**（人在 agent 跑的时候改了文件
   *     ⇒ 投一句"用户修改了 X（vN），请重读后再继续"）。见下方挂载处的注释。
   */
  let unsubscribeSteer: (() => void) | null = null
  let unsubscribeWorkspaceEdits: (() => void) | null = null
  let outcome: TurnOutcome | null = null
  let failure: unknown = null
  /**
   * 这一轮**有没有真的把 prompt 发出去**（= 走到了 `bridge.runTurn`）。
   *
   * 它是"要不要记一条计量"的判据（见收尾处），**不能**用 `outcome !== null` 代替：
   * `runTurn` 抛异常时 `outcome` 仍是 `null`，可那时 prompt 已经发出去了 —— 用量真实发生。
   */
  let engineStarted = false
  /**
   * 本轮**工作区窗口起点**（③.5 记、④.5 用；P1-9 · R4）。产物判据 = **本轮工作区变更集**
   * （`listWorkspaceChanges(conversationId, roundStartedAt)`，`shared#foldWorkspaceEvents` 折叠），
   * `null` = 没走到派活（拿不到沙箱等）⇒ 不收产物。
   *
   * ⚠️ 必须排在**记忆文档 / 附件写盘之后**：它们是"本轮基线"的一部分，不该成为本轮产物 ——
   * 起点之前先 `reconcileWorkspaceOnce` 把它们的索引事件落定，起点才干净（见挂载处注释）。
   */
  let roundStartedAt: Date | null = null
  /**
   * **发给引擎**的这一轮消息（默认 = 用户原文）。记忆文档有内容时会被前置一条"先读记忆"的指令
   * （`TaskAgent记忆与产物` 块 1 的读取触发点；见 `memoryDoc.ts#memoryDocReadInstruction`）。
   * ⚠️ **只改这一份** —— 落库仍用 `content` 原文（`persistRoundQuietly`），用户看不到这条指令。
   */
  let engineContent = content
  /** 本轮建成的产物行（发 `artifact` 帧 + 落 `content.artifacts` 段，同一份数据两个去向） */
  const artifactItems: ArtifactItem[] = []

  if (acquired.ok) {
    const handle = acquired.sandbox
    sandbox = handle
    logger.info(
      {
        conversationId,
        agentId,
        sandboxId: handle.sandboxId,
        containerId: handle.containerId,
        image: handle.image,
        reused: handle.reused,
        // 排队 + 建容器的总耗时：它是"第一帧为什么这么慢"的第一个候选解释
        acquireMs: Date.now() - requestedAtMs,
      },
      '沙箱已就绪（开始接引擎）',
    )
    // 名额到手 ⇒ `queuedPosition` 归零。不清的话断线重连的人会一直看到"排队中"
    enqueue([], { queuedPosition: null })
    // 中间态（P0-3-13）：接下来是无输出的引擎启动期，先让前端知道"在干什么"。
    // 这些事件不落库、不进 `/active` 快照（`shared#sseStatusPayloadSchema` 文件头写明）。
    enqueue([{ name: 'status', data: { text: '沙箱已就绪，正在启动引擎…' } }])

    try {
      // ═════════════════════════════════════════════════════════════
      // ② 引擎桥（一个会话一条、与容器同寿命；容器换了它会自己重attach）
      // ═════════════════════════════════════════════════════════════
      bridge = await getSandboxRpc(conversationId, handle.containerId)
      // 桥建立返回 = 引擎已就绪（`openSandboxRpc` 内部那条预热命令已经确认它能对话）
      enqueue([{ name: 'status', data: { text: '引擎已就绪，正在准备…' } }])

      // ═════════════════════════════════════════════════════════════
      // ②.5 中途插话（P1-9 · P4 · R1）—— 运行中向引擎投递消息（pi RPC `steer`）
      // ═════════════════════════════════════════════════════════════
      // 两条来源、同一条投递路径（`engine.steer`，落到**助手 turn 边界**）：
      //   · **人主动插话**：`input.onSteer`（`POST /:id/steer` → `chat.steer:{id}` → 通道轮询）。
      //   · **工作区主动感知**（`子方案` §五 5）：这一轮在跑时，人在工作区里改了文件
      //     ⇒ 投一句"用户修改了 X（vN），请重读后再继续"。**只认 `USER` 的内容事件**
      //     （agent 自己的写是 `AGENT`、watcher 兜底是 `SYSTEM`，都不该回喂给模型），
      //     且**只在这一轮内订阅**（人机共享编辑只在 agent 跑的时候需要它知道）。
      // ⚠️ 两条都**尽力而为**：`bridge.steer` 自己吞掉失败并只记 debug（见 `bridge.ts`）——
      //   插话是锦上添花，投不进去不该把已经跑起来的一轮搞成故障。
      // ⚠️ **注册必须早于派活**（与 ③ 的订阅同一条纪律）：晚一秒，那段窗口里的插话会漏。
      const engine = bridge
      unsubscribeSteer = input.onSteer((message) => {
        void engine.steer(message)
      })
      unsubscribeWorkspaceEdits = subscribeWorkspaceEvents(conversationId, (event) => {
        const steerMessage = workspaceEditSteerMessage(event)
        if (steerMessage !== null) void engine.steer(steerMessage)
      })

      // ═════════════════════════════════════════════════════════════
      // ③ 订阅（判据 ①：**必须早于派活**）
      // ═════════════════════════════════════════════════════════════
      // ③.5 写记忆文档 → 拍产物基线（P0-3-7；P0-3-6 详规传下来的口径 ②：基线**必须在派活
      //     之前**拍，不许收尾之后补 —— 否则"基线"里已经混进了这一轮的产物，对照出来永远为空）
      // ═════════════════════════════════════════════════════════════
      // ★ 「TaskAgent 记忆与产物」块 1：容器回收后 /work 与 pi 的临时记忆都会清空 ⇒ agent 失忆。
      //   每次派活前**从 DB 现组装**一份记忆（最近几轮对话 + 产物清单）写进容器，
      //   容器重建 / 复用都能拿到最新的。⚠️ **必须排在拍基线之前**：记忆文件每次都会变，
      //   写在基线之前它才落在基线里、不会被当成本轮新产物（另有一道隐藏目录兜底，见 memoryDoc.ts）。
      //   ⚠️ 失败只 warn 不落轮：记忆是本轮的赠品，写不进去 agent 照样能干活。
      //
      //   ★ P1-17a 修订（2026-10-14）：**只在容器新建那一轮**才让引擎读它。
      //     判据 = `handle.reused`：复用同一容器时 pi 的 session（`/tmp/pi-sessions`，tmpfs）
      //     仍活着、自己持有完整会话状态（工具调用 / thinking / compaction 摘要）⇒ 每轮再读
      //     memory.md 是冗余的（白烧一次 read 的 token、也让 agent 每轮多一个多余动作）。
      //     容器新建（`reused === false`）时 session 已随之消失 ⇒ 这一轮才是真需要"先读记忆"
      //     以恢复"聊过什么、产出过哪些文件、附件怎么取回"的时刻。
      //     ⚠️ 文件**照样每轮写**（内容随对话/产物变化，且是 session 卷缺失/损坏时的兜底），
      //        只是**读取指令**的触发时机收窄到"新建容器那一轮"。
      //     ⚠️ `hasContent === false`（全新会话第一轮）时仍不加（那句话只会是"读一个空文件"）。
      try {
        const memory = await buildMemoryDoc(conversationId)
        await writeMemoryDoc(handle.containerId, memory.markdown)
        // 写入成功 + 确有内容 + **本容器是新起的** ⇒ 让引擎先读它。
        // ⚠️ 只改发给引擎的那份；落库仍是 `content` 原文（见 engineContent 的注释）。
        if (memory.hasContent && !handle.reused) {
          engineContent = `${memoryDocReadInstruction()}\n\n${content}`
        }
      } catch (error) {
        logger.warn(
          { err: error, conversationId, containerId: handle.containerId },
          '记忆文档写入失败（本轮 agent 看不到会话历史与产物清单；派活不受影响）',
        )
      }

      // ★ 知识库概览（绑定知识库时）—— 与 ChatBot 的 system prompt **同一段口径**
      //   （`buildSystemPrompt` 的知识库部分）。为什么走 prompt 前缀而不是 system：
      //   TaskAgent 经 pi 的 RPC 派活只有一条 `prompt` 消息、**没有 system 通道**，
      //   所以把「能力说明 + 引用规则 + 可用知识库清单」作为前缀拼进发给引擎的那份。
      //   ⚠️ 只改 `engineContent`（发给引擎的），落库仍是 `content` 原文（见其注释）；
      //   ⚠️ 失败只 warn：模型这轮可能不知道有哪些库，但派活与工具注册都不受影响。
      try {
        const kbIds = await boundKnowledgeBaseIds(agentId)
        if (kbIds.length > 0) {
          const knowledgeCatalog = await loadKnowledgeCatalog(kbIds, KNOWLEDGE_CATALOG_MAX_DOCS_PER_KB)
          const catalogBlock = formatKnowledgeCatalog(knowledgeCatalog)
          if (catalogBlock !== '') {
            engineContent = `${KNOWLEDGE_USAGE_RULES}\n\n${RETRIEVAL_RULES}\n\n${catalogBlock}\n\n${engineContent}`
          }
        }
      } catch (error) {
        logger.warn(
          { err: error, conversationId, agentId },
          '知识库概览注入失败（本轮 agent 可能不知道绑定了哪些库；工具注册与派活不受影响）',
        )
      }

      // ★ 长期记忆工具说明 + 反幻觉（P1-8a）：启用记忆时把 remember/recall_memory 的用法与
      //   "未命中不得编造"拼进发给引擎的 prompt。⚠️ 只改 engineContent（落库仍是用户原文）。
      try {
        const memoryConv = await getPrisma().conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true },
        })
        if (memoryConv !== null) {
          const memorySettingsForTurn = await getMemorySettings(memoryConv.userId)
          if (memorySettingsForTurn.enabled) {
            engineContent = `${MEMORY_TOOL_RULES}\n\n${engineContent}`
          }
        }
      } catch (error) {
        logger.warn({ err: error, conversationId }, '记忆工具说明注入失败（不影响派活）')
      }

      // ★ 附件（P1-4，2026-10-01 修订）—— 两件事，且**都必须在拍基线之前**：
      //   ① 原文件写进容器 `/work/attachments/`（写晚了会被当成"本轮 agent 新产物"上传）；
      //   ② 拼 prompt 块：文本类的正文直接可读，所有文件的容器内路径都告诉 agent。
      //   ⚠️ 引擎经 pi 只有 `prompt` 文本通道 ⇒ **图片不能直接"看"**，但文件本体落盘后
      //   agent 可以用工具处理（尺寸/转码/图像工具）。写失败只 warn：文本类正文仍已可用。
      //   **落库仍是 `content` 原文**，界面气泡的附件由 `persist` 另存（见其调用处）。
      let attachmentPaths: string[] | null = null
      if (input.attachments.length > 0) {
        try {
          attachmentPaths = await writeAttachmentFiles(handle.containerId, input.attachments)
        } catch (error) {
          logger.warn(
            { err: error, conversationId, containerId: handle.containerId },
            '附件写入容器失败（本轮 agent 拿不到文件本体；文本类正文仍拼进了 prompt）',
          )
        }
      }
      const attachmentBlock = taskAttachmentPromptBlock(input.attachments, attachmentPaths, ATTACHMENT_CONTEXT_NOTE)
      if (attachmentBlock !== '') engineContent = `${attachmentBlock}\n\n${engineContent}`

      // ═════════════════════════════════════════════════════════════
      // ③.4 MCP 工具清单（P0-3-9b）—— 反查 `tool_call.serverId` 的唯一依据
      // ═════════════════════════════════════════════════════════════
      // 规则是「**每个容器一份快照**」（`sandbox/proxy.ts#ensureSandboxMcpCatalog`）：
      // 已发布过就**原样读回**（容器注册的正是那一份），没发布过才算一份并发布。
      // ⚠️ **失败不落轮**：拿不到清单只意味着 MCP 工具卡少填一个 `serverId`
      // （`map.ts` 退回 `kind: SANDBOX`），而工具**本身照样能调** ——
      // 容器侧的注册与实际调用都走代理端点，不依赖后端这份内存副本。
      let mcpCatalog: SandboxMcpCatalog | null = null
      try {
        mcpCatalog = await ensureSandboxMcpCatalog(conversationId, agentId)
      } catch (error) {
        logger.warn(
          { err: error, conversationId, agentId },
          '沙箱 MCP 工具清单预热失败（本轮 MCP 工具卡将不带 serverId；工具本身不受影响）',
        )
      }
      // ⚠️ 过一次 `const`：`let` 变量在闭包里 TS 不会保留窄化 ⇒ 直接闭合 `mcpCatalog` 会报"可能为 null"
      const resolverCatalog: SandboxMcpCatalog | null = mcpCatalog
      const resolveMcpTool =
        resolverCatalog === null
          ? undefined
          : (engineToolName: string): EngineMcpToolCard | undefined => {
              const ref = resolveSandboxMcpTool(resolverCatalog, engineToolName)
              return ref === undefined
                ? undefined
                : { serverId: ref.serverId, serverName: ref.serverName, toolName: ref.toolName }
            }

      /**
       * 内置工具（知识库）的反查：**认名字**（`knowledge_search` / `list_knowledge` / `read_document`）—— 它们
       * 不是 MCP、没有 `alias`，判据只有"清单里下发过它"这一条（`resolverCatalog.builtins`）。
       * 认出来 ⇒ 卡片 `kind: BUILTIN` + 展示名"知识库"（与 ChatBot 路径同一个 kind）。
       */
      const resolveBuiltinTool =
        resolverCatalog === null
          ? undefined
          : (engineToolName: string): EngineBuiltinToolCard | undefined =>
              resolverCatalog.builtins.some((tool) => tool.name === engineToolName)
                ? { serverName: KNOWLEDGE_TOOL_SERVER_NAME, toolName: engineToolName }
                : undefined

      const mapper = createEngineEventMapper({ resolveMcpTool, resolveBuiltinTool })
      unsubscribe = bridge.onEvent((event) => {
        // ★ 先记相位与静默看门狗（只读这一条事件的类型/角色，不影响下面的映射）
        noteEnginePhase(event)
        const mapped = mapper.map(event)
        // ── 工具卡**内联定位**：给 `tool_call` 帧（进 SSE 流）与 `toolRecord`（进库）各补一份
        //   `textOffset`。同一 `callId` 的 start/end 两帧共用同一偏移（追踪器记忆）⇒ 卡片流转不跳位置；
        //   落库那份也带 ⇒ 刷新后历史里的卡片仍插在正文对应处。与 ChatBot 共用 `toolTextOffset.ts`。
        const { events, toolRecord } = attachToolTextOffsets(mapped.events, mapped.toolRecord, toolTextOffsets)

        // ── 同步那一半：把"这一轮发生过什么"记下来 ──
        for (const frame of events) {
          if (frame.name === 'delta') {
            round.assistantText += frame.data.text
            round.deltaCount += 1
            // 只有第一条记日志（一次回答有成百上千条增量）
            if (round.deltaCount === 1) {
              logger.info(
                {
                  conversationId,
                  agentId,
                  sandboxId: handle.sandboxId,
                  containerId: handle.containerId,
                  ttftMs: Date.now() - requestedAtMs,
                },
                '本轮首字延迟（TTFT）',
              )
            }
          } else if (frame.name === 'thinking') {
            round.thinkingText += frame.data.text
          }
        }
        // ── 用量：按引擎的 turn 归集（判据 ③）──
        // 顺序不能反：**先处理边界、再收本帧的 usage** —— `turn_end` 与它那个 turn 的最后
        // 一帧 `message_update` 谁先到由引擎决定，先收后并可以两种顺序都不漏；
        // 反过来（先并后收）会把"边界那一帧自己带的 usage"算进**下一个** turn 里。
        const boundary = engineTurnBoundaryOf(event)
        if (boundary === 'start') {
          flushTurnUsage() // 防呆：上一个 turn 的 `turn_end` 没收到时在这里归位
          round.turns += 1
        } else if (boundary === 'end') {
          flushTurnUsage()
        }
        // 同一 turn 内覆盖（`null` 表示这一帧没带，**不该盖掉**已有值）；跨 turn 靠上面那次归位
        if (mapped.usage !== null) round.currentTurnUsage = mapped.usage
        if (toolRecord !== undefined) {
          round.toolRecords.push(toolRecord)
          // ★ P1-17c（凭据隔离 · 分相）：`bash` 工具一跑"装依赖 / 跑项目"命令，就把这个会话钉进
          //   `run` 相 ⇒ 之后的 git 凭据请求被后端拒绝（`gitProxy.ts` 消费）。异步、尽力而为，
          //   不阻塞本轮回调（写失败只 warn，下次命令还会再试）。
          if (toolRecord.toolName === 'bash') {
            const command = executionCommandOf('bash', toolRecord.arguments)
            if (command !== undefined && isExecutionCommand(command)) {
              void enterRunPhase(conversationId)
            }
          }
        }

        // ── 可解释性：未知事件只留痕；"认识但载荷坏了"当场 warn ──
        if (!mapped.known) round.unknownEventTypes.add(event.type)
        if (mapped.anomaly !== undefined) {
          round.anomalies += 1
          logger.warn(
            { conversationId, agentId, engineEvent: event.type, anomaly: mapped.anomaly },
            '引擎事件载荷用不了（这一条不进事件流，也不落库）',
          )
        }

        // ── 异步那一半：排队发出去（判据 ②）──
        enqueue(events, mapped.snapshot)
      })

      // ═════════════════════════════════════════════════════════════
      // ④ 派活（`runTurn` 内部：先挂 `agent_settled` 等待者，再 `send(prompt)`）
      // ═════════════════════════════════════════════════════════════
      // ★ 工作区**轮次起点**（P1-9 · P4 · R2 + P1-9 · R4）：在派活这一刻记下"本轮从何时起" ——
      //   ① 「撤销本轮」（`POST .../workspace/revert`）据此把窗口圈定为**这一轮**；
      //   ② R4 的产物收集据此取"本轮工作区变更集"。
      //   ⚠️ 必须排在**记忆文档 / 附件写盘之后**（那些是"本轮基线"，不该被算成这一轮 agent 的改动）；
      //   且**先对账再记起点** —— `reconcileWorkspaceOnce` 把刚才的 setup 写落进工作区索引与事件，
      //   否则它们会落在 `[起点, now]` 窗口里、被当成本轮产物收上去。
      //   收尾（`finally`）记终点。
      await reconcileWorkspaceOnce(conversationId)
      roundStartedAt = new Date()
      await recordWorkspaceRoundStart(conversationId, roundStartedAt)
      engineStarted = true // 计量判据（见收尾处）：从这一行起，token 就已经可能花出去了
      enqueue([{ name: 'status', data: { text: '任务运行中…' } }])
      // 图片附件（P1-4）：走 pi RPC `prompt.images` 原生字段（引擎模型需支持图片输入，闸门已拦）。
      // 与"写进容器"并存：容器里是原文件（可被工具处理），这里是让**模型**直接看到。
      const imageParts = input.attachments
        .filter(
          (item): item is typeof item & { dataBase64: string } =>
            item.kind === 'IMAGE' && typeof item.dataBase64 === 'string' && item.dataBase64 !== '',
        )
        .map((item) => ({ type: 'image' as const, data: item.dataBase64, mimeType: item.mime }))
      outcome = await bridge.runTurn(engineContent, {
        signal,
        ...(imageParts.length === 0 ? {} : { images: imageParts }),
      })
    } catch (error) {
      // 中断与故障在这里**都只是"记下来"**，统一的收尾在下面（顺序即优先级，与 chatBot 同款）
      failure = error
    } finally {
      // 退订必须做：桥活得比这一轮久（复用容器），不退就是每一轮多一个监听器 + 多一份泄漏的引用
      unsubscribe?.()
      // ★ 静默看门狗同理：桥比一轮久，定时器必须在这一轮结束时收掉
      stopSilenceWatchdog()
      // 中途插话的两条订阅（P1-9 · P4 · R1）：同款理由 —— 通道与工作区事件总线都活得比一轮久
      unsubscribeSteer?.()
      unsubscribeWorkspaceEdits?.()
      // 工作区**轮次终点**（P1-9 · P4 · R2）：圈定本轮窗口右界（含异常/被停止的轮）。
      // ⚠️ 即便起点没记成（Redis 失败），这里也照记 —— 端点会据"无起点"报明确错误，不会误撤。
      await recordWorkspaceRoundEnd(conversationId)
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ④.6 用量收口：把最后一个 turn 的值并进总数（判据 ③）
  // ═══════════════════════════════════════════════════════════════════
  // 必须排在这里（退订之后、读取之前）而不是等到落库那一行：后面有三处读它
  // （`persistRoundQuietly` 的 `tokens_*`、`usage_records` 的 `tokens_*`、结束日志与 `done.usage`），
  // 漏了这一步的症状是"最后一个 turn 的 token 不见了"（中断的轮尤其明显：它根本没有 `turn_end`）。
  flushTurnUsage()
  /** 本轮用量（跨 turn 相加后的**对外形状**）：落库、计量、`done.usage` 三处共用这一份 */
  const roundUsage: EngineUsage | null = toEngineUsage(round.usageTotal)

  // ═══════════════════════════════════════════════════════════════════
  // ④.5 收产物（P0-3-7 起；P1-9 · R4 判据 = 「本轮工作区变更集」）
  // ═══════════════════════════════════════════════════════════════════
  // 排在⑤冲刷**之前** ⇒ `artifact` 帧与内容帧同一条串行队列，顺序天然正确（先过程、后产物、最后 done）。
  // **中断/故障的轮也照收**（`子方案③` §九 5：用户点停止通常正是因为他已经拿到想要的东西了）。
  // ⚠️ 收集失败 ≠ 这一轮失败：产物是本轮的赠品，任何异常只 warn、不进 `error` 帧（见 `artifacts.ts` 文件头）。
  if (sandbox !== null && roundStartedAt !== null) {
    try {
      // 先把 agent 的**未中介写**（`bash` / 原生工具）对账进工作区索引与事件 —— 否则这一轮它看不到。
      // ⚠️ 对账**与产物无关**：Code 模式下工作区面板仍要实时看到 agent 的改动，故这一句照跑。
      await reconcileWorkspaceOnce(conversationId)
      /**
       * ★ 产物口径（用户定案 2026-10-15）：**Code 模式下不再计算 agent 产物** —— 只有**非 Code
       * 的 TaskAgent** 才算产物。理由：Code 模式里 agent 动过的文件已经由**工作区面板**（文件树 +
       * 「最近变更」）完整呈现，"哪些算产物"在那里不好定义，再收一份只会与工作区重复、且容易算错。
       * 判据 = 会话持久列 `codeMode`（与建容器时注入 `DOUBULEA_WORKSPACE_MEDIATION` 同一个来源）。
       */
      const conversationRow = await getPrisma().conversation.findUnique({
        where: { id: conversationId },
        select: { codeMode: true },
      })
      const codeMode = conversationRow?.codeMode ?? false
      if (!codeMode) {
        // 本轮窗口 = `[起点, now]`：起点之后动过的路径，按路径折叠成变更集（`shared#foldWorkspaceEvents`）。
        const { items: changes } = await listWorkspaceChanges(conversationId, roundStartedAt.toISOString())
        const collected = await collectRoundArtifacts({ conversationId, changes })
        artifactItems.push(...collected)
        if (collected.length > 0) {
          enqueue(collected.map((item) => ({ name: 'artifact', data: item } as const satisfies SseEvent)))
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, conversationId, agentId, containerId: sandbox.containerId },
        '本轮产物收集失败（回答与工具过程不受影响，产物面板将缺这一轮）',
      )
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ⑤ 收尾
  // ═══════════════════════════════════════════════════════════════════
  // 先把累下来的帧写完，再决定落库与收尾 —— `emit` 是异步的，而"回答已经给用户看了"
  // 这件事必须发生在"写进历史"之前（否则落库失败时用户还没看到内容）
  if (sandbox !== null) enqueue([], { currentTool: null, queuedPosition: null })
  await frameChain

  const stopReason = abortReasonOf(signal)

  /**
   * ⚠️ **锁丢了 ⇒ 一个字都不写库**，并且**优先抛 `signal.reason`**（那个 `ChatStoppedError`
   * 带用户文案）而不是 `failure`：锁丢时引擎往往正好也被中断，`failure` 很可能是桥的技术异常
   * （没有用户文案）⇒ 抛错对象选错，用户看到的就从"请重新发送消息"退化成"服务内部错误"。
   * 与 `chatBot.ts` 同一条（`06` §六 第 ⑰ 条：同一口径只留一处）。
   */
  if (stopReason === 'lock-lost') {
    logger.warn(
      {
        conversationId,
        agentId,
        sandboxId: sandbox?.sandboxId ?? null,
        generatedChars: round.assistantText.length,
      },
      '活跃流锁已丢失，本轮不落库（避免与另一个流抢同一份历史）',
    )
    throw signal.reason instanceof ChatStoppedError ? signal.reason : (failure ?? (signal.reason as Error))
  }

  /** 引擎如实回的失败（`aborted` 不算：那是"被中断"，不是"出故障"） */
  const engineFailure = outcome !== null && !outcome.ok && outcome.reason !== 'aborted' ? outcome : null
  if (engineFailure !== null) {
    // pi 的原文与 stderr 尾巴只在这里留痕（`02` §十：不进 SSE）
    logger.warn(
      {
        conversationId,
        agentId,
        sandboxId: sandbox?.sandboxId ?? null,
        containerId: sandbox?.containerId ?? null,
        reason: engineFailure.reason,
        engineMessage: engineFailure.message,
        stderr: bridge?.stderrTail() ?? null,
        generatedChars: round.assistantText.length,
        toolCalls: round.toolRecords.length,
      },
      `沙箱引擎未能跑完这一轮（${engineFailure.reason}）`,
    )
  }

  /** 故障：过程里抛的，或引擎如实回的失败结局。⚠️ 与中断可能同时成立 ⇒ **以故障为准** */
  const fatalError: unknown =
    failure ?? (engineFailure === null ? null : engineFailureError(engineFailure.reason, engineFailure.message))
  /**
   * 中断：信号里记了原因（用户停止 / 客户端断开）、排队时就被取消、或引擎如实回 `aborted`。
   * ⚠️ 用户**排队时**点停止也算中断（`acquired` 那一段已把 `ABORTED` 排除在失败之外）。
   */
  const interrupted =
    stopReason !== undefined || (outcome !== null && !outcome.ok && outcome.reason === 'aborted')

  /**
   * 本轮的墙钟耗时（`startedAt` → 现在）。取**一次**、三处共用（计量行、结束日志、`usage_records`）
   * —— 分三处各算一次的话，同一轮在报表与日志里会得到三个不同的数（而它们都"看起来对"）。
   */
  const durationMs = Date.now() - requestedAtMs

  /**
   * 本轮要不要记一条计量（`usage_records`，P0-3-12；`01` 决策 20）。
   *
   * ★ 判据 = **"这一轮引擎真的跑过"**（{@link engineStarted}），而不是"落库判据"。
   *   两者的差别**只有一种情形**：**用户排队时点了停止** —— 落库要写（他确实发起了、
   *   又主动停了），计量不记（那一轮连 `prompt` 都没发出去，没有用量可言）。
   *   ⚠️ 反过来"引擎跑了但没产出内容"（被中断 / 引擎故障）**照记**：token 是真的花掉了，
   *   `01` 决策 15 的"停止即中断"也不该让账目消失。
   *   ⚠️ 与落库同一条例外：**`lock-lost` 到不了这里**（上面已提前 throw）—— 那时可能已有
   *   另一个流在写同一份历史，我们连消息都不写，更不该往账里加一条。
   *
   * ★ 两条取值口径（`01` 决策 20 的"允许 token 字段为空"）：
   *   · `tokensIn/Out` 取**跨 turn 相加**后的值；引擎没上报（或全 0，见 `map.ts#readEngineUsage`）
   *     ⇒ `null`，**不编 0** —— 报表里 `NULL` 是"不知道"，`0` 是"真的没用"，两件事。
   *   · 取不到 token 时这两列之外的字段照填：**时长是我们自己量的、轮次是引擎自己报的**，
   *     它们与"有没有 usage 上报"无关 ⇒ 一条"零信息量"的行不会出现。
   */
  const usageRecord: UsageRecordInput | undefined = engineStarted
    ? {
        model: input.target.modelName,
        tokensIn: roundUsage?.tokensIn ?? null,
        tokensOut: roundUsage?.tokensOut ?? null,
        durationMs,
        rounds: round.turns,
        createdAt: new Date(),
      }
    : undefined

  /**
   * 收口"没等到结局"的工具卡（`RUNNING` → `ERROR`）。
   *
   * ⚠️ 引擎先发 `tool_execution_start`（落一张 `RUNNING` 卡）、`tool_execution_end` 才改成
   * `SUCCESS`/`ERROR`。一轮被**中断 / 超时 / 引擎异常**时，最后一张卡可能永远等不到 end ⇒
   * 落库后刷新会话就会看到一张**永远转圈**的工具卡（用户实测：headless 定时任务里
   * `bash ls -la /work` 一直显示"运行中"—— 那一轮其实已经中断，只是卡没被收口）。
   * 这里在落库前把仍是 `RUNNING` 的卡一律改成 `ERROR`，与"这一轮没跑完"的事实一致；
   * 已结束的卡（同一 `callId` 的 end 记录）不受影响（前端按 `callId` upsert，后者覆盖前者）。
   */
  const finalToolRecords = round.toolRecords.map((record) =>
    record.status === 'RUNNING' ? { ...record, status: 'ERROR' as const } : record,
  )

  const messageId = await persistRoundQuietly({
    conversationId,
    content,
    // 附件（P1-4）：随用户消息落库（刷新后气泡上仍能看到当时带过什么）
    attachments: attachmentItemsOf(input.attachments),
    assistantText: round.assistantText,
    thinkingText: round.thinkingText,
    // TaskAgent **不发引用卡**（那一族是 ChatBot 的 rendering）：知识库走**内置工具卡**
    // （`knowledge_search` / `list_knowledge` / `read_document` 经 `/api/sandbox/builtin/call`，见 `proxy.ts`），
    // 结果以 `tool_calls` 落库/展示 ⇒ `citations` 恒为空。这是刻意的口径，不是漏接。
    citations: [],
    toolRecords: finalToolRecords,
    // 本轮建成的产物行（P0-3-7）：事件里发过的那几张卡，刷新后从 `content.artifacts` 恢复
    artifacts: artifactItems,
    usage: roundUsage,
    // 计量行与消息**同一个事务**（P0-3-12）：要么都写、要么都不写 ⇒ 不会出现
    // "有消息没计量"或"有计量没消息"两种半截状态
    usageRecord,
    logger,
  })

  // ── 长期记忆提取（P1-8）：落库之后、与 bot 类型无关（见 `memoryExtract.ts`）──
  //    TaskAgent 的显式"记住"、偏好建议、显式"忘掉"都在这里发生；失败只 warn（本轮不受影响）。
  try {
    const conversationRow = await getPrisma().conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, memoryExcluded: true },
    })
    if (conversationRow !== null) {
      const memorySettings = await getMemorySettings(conversationRow.userId)
      await runMemoryExtraction({
        conversationId,
        userId: conversationRow.userId,
        agentId,
        userText: content,
        assistantText: round.assistantText,
        enabled: memorySettings.enabled,
        autoExtract: memorySettings.autoExtract,
        fullAuto: memorySettings.fullAuto,
        conversationExcluded: conversationRow.memoryExcluded,
        // 画像模型归一用它解析上游目标（与本轮对话同一个模型）
        modelId: input.target.modelId,
      })
    }
  } catch (error) {
    logger.warn({ err: error, conversationId }, '长期记忆提取失败（已忽略，不影响本轮）')
  }

  // ═══════════════════════════════════════════════════════════════════
  // ⑦ 用户停止 ⇒ 收沙箱（P0-3-8；`子方案③` §九 5 第 4 条：容器与具名卷一并回收）
  // ═══════════════════════════════════════════════════════════════════
  // ★ **触发表**（`ChatStopReason` 三值逐个有结论，别凭"中断了就回收"的直觉）：
  //   · `'user'`          ⇒ **回收**。用户明确说了"停"；停止的语义就是结束这个任务 ⇒
  //     下一轮重新建容器（`01` 阶段三验收的"停止 → 会话恢复"即"重发即重建"）。
  //     宽限（`ABORT_SETTLE_GRACE_MS` 15s）内没收尾的卡死引擎也在这条路上被
  //     `force` 删除（SIGKILL）兜底 —— "要不要升级成回收容器"的答案就是这一句。
  //   · `'client'`        ⇒ **不回收**。断线 ≠ 结束任务：用户可能重连续问，容器留给复用
  //     （30min 空闲回收兜底）。断线与停止在落库上同待遇（都保留已生成内容），
  //     但在"要不要留容器"上必须分开 —— 这正是 `ChatStopReason` 做成三值的原因之一。
  //   · `'lock-lost'`     ⇒ **绝不回收**（且到不了这里：上面已提前 throw）。锁丢了说明
  //     同会话可能已有**另一条流**在跑，它名下可能已有新容器 —— 回收就是杀别人的容器。
  //   · 正常完成 / 引擎故障 ⇒ **不回收**：前者是"会话即容器"复用的初衷；后者的容器
  //     多半已是尸体（pi 是主进程），由复用判定的"在跑"检查（P0-3-8 收紧，
  //     `manager.ts` ① / `docker.ts#inspectSandboxContainerState`）在**下一轮**收走。
  //
  // ★ **顺序即正确性**：回收必须排在 ④.5 收产物与 ⑥ 落库**之后** —— 这也是为什么
  //   "停流 + 回收沙箱"的分流点在**编排层收尾**而不在 `/stop` 路由（`02` §4.5 那句
  //   "按会话类型分流"的落法）：路由若直接回收，杀掉的是还没收完产物的容器。
  //
  // ★ **inline await、不 fire-and-forget**：`void recycleSandbox(...)` 会让紧随其后的
  //   "直接追问"（`01` 决策 15）撞上竞态 —— 新一轮 `ensureSandbox` 的复用判定可能
  //   在删除完成前读到"容器还在"，随后 `attach` 失败成一条莫名的 `UPSTREAM_ERROR`。
  //   inline 的代价（`done{STOPPED}` 晚几十毫秒~秒级到达）远小于那个竞态。
  if (stopReason === 'user') {
    try {
      // 先拆桥、再杀容器：桥的 `close()` 幂等且让在飞等待**立刻**失败（而不是等超时）；
      // 容器一删 socket 也会自断，但显式关把时序钉在我们手里
      closeSandboxRpc(conversationId, 'user-stop')
      const recycled = await recycleSandbox(conversationId, 'user-stop')
      logger.info(
        { conversationId, agentId, recycled, messageId },
        '用户停止：沙箱已回收（下一轮重新建容器 —— 会话恢复 = 重发）',
      )
    } catch (error) {
      // 回收失败 ≠ 停止失败：`done{STOPPED}` 照发（用户要的"停"已经成立）；
      // 残留的容器/卷/账本行留给对账器（它按 label 找得到，且 `recycleSandbox` 幂等）
      logger.warn(
        { err: error, conversationId, agentId, sandboxId: sandbox?.sandboxId ?? null },
        '用户停止后回收沙箱失败（留给对账器兜底）',
      )
    }
  }

  // 帧写坏了（schema 不过）是"我们自己的 bug"：内容已落库，但这一轮必须以 error 收尾
  if (frameFailure !== undefined) throw frameFailure
  if (fatalError !== null) throw fatalError

  const finishReason = interrupted ? 'STOPPED' : 'COMPLETE'
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
      sandboxId: sandbox?.sandboxId ?? null,
      containerId: sandbox?.containerId ?? null,
      reused: sandbox?.reused ?? null,
      finishReason,
      messageId,
      toolCalls: round.toolRecords.length,
      deltaCount: round.deltaCount,
      artifacts: artifactItems.length,
      // ⚠️ 引擎侧的两条"可解释性"实况：非空即意味着映射表要跟着引擎升级（见 `map.ts` 文件头）
      unknownEngineEvents: round.unknownEventTypes.size === 0 ? null : [...round.unknownEventTypes].sort(),
      engineAnomalies: round.anomalies,
      // 本轮用量的三个数（P0-3-12 起口径见判据 ③）：跨 turn **相加**后的 token（某一路
      // 没上报就是 `null`，不知道就不编 0）+ 我们自己量的时长 + **引擎自己报的轮次**
      tokensIn: roundUsage?.tokensIn ?? null,
      tokensOut: roundUsage?.tokensOut ?? null,
      durationMs,
      // ⚠️ `0` 是**真实可能的**（引擎一次 turn 都没开：派活刚发出去就被中断）——
      // 它与"取不到 token"（`null`）是两件事，别把两者混成一个"没有"
      rounds: round.turns,
    },
    'TaskAgent 本轮结束',
  )

  return { messageId, finishReason, usage: roundUsage }
}

/**
 * 跨 turn 累加后的用量 → **对外形状**（`done.usage` 的 `tokensIn` / `tokensOut` 两项）。
 *
 * 内部用 `ChatUsage` 只是为复用 `sumUsages`；`tokensTotal` 在契约里没有位置
 * （`shared#sseDonePayloadSchema` 的 `usage` 刻意只投影两项，见 `map.ts#EngineUsage`），
 * 所以出口处**显式**把它丢掉，而不是让它顺着类型漏出去。
 */
function toEngineUsage(total: ChatUsage | null): EngineUsage | null {
  return total === null ? null : { tokensIn: total.tokensIn, tokensOut: total.tokensOut }
}

// ═════════════════════════════════════════════════════════════════════
// 失败码 → 异常（两个纯函数；"回什么"这件事集中在这里）
// ═════════════════════════════════════════════════════════════════════

/**
 * 「拿不到沙箱」→ 抛什么。
 *
 * ⚠️ 这些失败的出口是**流内 `error{code}` 帧**（不是 JSON 信封 —— 见文件头那一段：
 * `producer` 是在 `reply.hijack()` 之后才跑的）。所以本函数的作用**只有一个**：
 * 替用户挑一个 `error` 帧里的 `code`（`03` §六 的前端文案按它分派）。
 *
 * 六种码的处置与理由：
 *
 * | 码 | `AppError` | 为什么挑它（= 用户看到哪一类文案） |
 * |----|-----------|--------------------------------|
 * | `QUEUE_TIMEOUT` | `BUSY` 429 | 容量问题，**等一等再来**就有机会成 —— 与 `CHATBOT_CONCURRENCY` 满同一条语义 |
 * | `NOT_CONFIGURED` | `INTERNAL` 500 | `SANDBOX_IMAGE` / egress 代理没配：**管理员**的动作，用户做什么都没用 |
 * | `MODEL_NOT_AVAILABLE` | `CONFLICT` 409 | 目标（模型/Provider）不可用 —— 与 `resolveChatTarget` 的"模型已停用 409"同族；文案已指向"去改智能体的模型" |
 * | `CONVERSATION_NOT_FOUND` | `CONFLICT` 409 | 撞到的是"会话已结束（只读）"这个**状态**问题（真不存在的情况路由层已经 404 挡过），与 `assertConversationSendable` 的只读 409 口径一致 |
 * | `CREATE_FAILED` | `INTERNAL` 500 | 建容器失败（镜像缺失 / 卷建不出来 / Docker 不可达）：基础设施故障 |
 * | `ABORTED` | `BUSY` 429 | ⚠️ **理论上不可达**：取消一定经 `signal` ⇒ 调用方在 `!acquired.ok` 那一支已经先按"用户已停止"处理。真到了这里说明有人绕过了信号，按"暂时不可用"报（比编一个"已取消"更像事实） |
 *
 * ⚠️ `message` **原样透传**：`ensureSandbox` 的文案本来就是写给用户的中文（哪一项没配、
 * 排队等了多久），不需要在这一层重写一遍（重写 = 两份文案会漂移）。
 */
export function sandboxAcquireError(code: SandboxAcquireFailure, message: string): AppError {
  switch (code) {
    case 'QUEUE_TIMEOUT':
      return AppError.busy(message)
    case 'NOT_CONFIGURED':
      return AppError.internal(message)
    case 'MODEL_NOT_AVAILABLE':
      return AppError.conflict(message)
    case 'CONVERSATION_NOT_FOUND':
      return AppError.conflict(message)
    case 'CREATE_FAILED':
      return AppError.internal(message)
    case 'ABORTED':
      return AppError.busy(message)
  }
}

/**
 * 「引擎没能跑完这一轮」→ 抛什么（出口与 {@link sandboxAcquireError} 相同：流内 `error{code}` 帧）。
 *
 * ⚠️ **不用引擎的原文当 `message`**（`02` §十 不透传内部细节）：`TurnOutcome.message` 里是
 * pi 的说法（英文、含路径与内部状态），发给用户既读不懂也定位不了 —— 它的去处是**日志**
 * （`taskAgentProducer` 里那条 warn），用户看到的是下面这几句我们自己写的文案。
 *
 * | 码 | `AppError` | 用户看到的 |
 * |----|-----------|-----------|
 * | `engine-exited` / `closed` | `UPSTREAM_ERROR` 502 | 引擎已退出，重发一次（系统会自行重建沙箱） |
 * | `rejected` | `UPSTREAM_ERROR` 502 | 引擎拒绝了这次任务 |
 * | `timeout` | `UPSTREAM_TIMEOUT` 504 | 引擎长时间没有响应 |
 * | `aborted` | `BUSY` 429 | ⚠️ **不可达**：`aborted` 是"被中断"，调用方在构造故障之前就把它分流出去了 |
 *
 * ⚠️ 这两个 502 分支刻意**并列而不是合并**：`engine-exited` 意味着**容器没了**（下一轮会重建），
 * `rejected` 意味着**容器还活着但引擎不接这条命令**（重发大概率还会被拒）—— 用户该做的事不同。
 */
export function engineFailureError(reason: TurnFailureReason, message: string): AppError {
  switch (reason) {
    case 'engine-exited':
    case 'closed':
      return AppError.upstreamError('沙箱引擎已退出，本次生成中断。请重新发送消息（系统会自动重建沙箱）')
    case 'rejected':
      return AppError.upstreamError('沙箱引擎拒绝了这次任务，本次生成中断。请重新发送消息')
    case 'timeout':
      return AppError.upstreamTimeout('沙箱引擎长时间没有响应，本次生成已中断。请重新发送消息')
    case 'aborted':
      return AppError.busy(message)
  }
}
