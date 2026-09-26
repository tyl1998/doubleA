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
 *  ③.5 snapshotWorkFiles(...)        → **派活之前**拍产物基线（P0-3-7）
 *  ④ runTurn(content, {signal})      → 派活 + 等 **`agent_settled`**（不是 `agent_end`，见 `bridge.ts`）
 *  ④.5 collectRoundArtifacts(...)    → 对照基线 ⇒ 传对象 + 建行 ⇒ `artifact` 事件（P0-3-7）
 *  ⑤ 冲刷帧队列 + 清 `/active`       → 帧必须写完再落库（顺序即"事件即真相"）
 *  ⑥ persistRoundQuietly + done{usage}
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
 * ③ **usage 是「覆盖」不是「相加」**：引擎给的 `message_update.usage` 是
 *    **latest cumulative**（pi `docs/json.md` 原话）⇒ 后一帧直接盖掉前一帧。
 *    这与 `chatBot.ts` 的 `sumUsages` 是两件不同的事（那边一轮里调了好几次上游）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 本批**刻意不含**的（属后续批次，不要顺手补）
 * ═══════════════════════════════════════════════════════════════════════
 *   · **产物下载 / 列表 / 预览端点**（`GET /:id/artifacts`、`GET /artifacts/:id/download`、
 *     `.../content`）→ **P0-3-9 / P0-3-10**。本批只把行建出来、事件发出去，前端还没有消费面。
 *   · **MCP 工具卡与后端代理**（`kind:MCP` + `serverId` 反查）→ **P0-3-9b**；
 *     于是本层发出的工具卡 `kind` **恒为 `SANDBOX`**（`map.ts` 是它的唯一出处）。
 *   · **跨请求提问原语**（`askConversation()` / 活跃通道注册表）→ ✅ **已在 P0-3-6b 落地**
 *     （`sse.ts`）。⚠️ 但**本层不用它**：容器内的 `bash` / `read` / `write` / `edit`
 *     **不做**逐工具确认（`子方案③` §八 5 的判据 —— **只有"跨出容器边界"的动作才需要确认卡**；
 *     容器内的破坏面已被容器边界框死）。它的调用方是 **P0-3-9b** 的沙箱 MCP 代理端点。
 *   · **停止路径的沙箱回收**（停流之后要不要杀容器）→ **P0-3-8**；本层只把 `signal` 传下去，
 *     中断由 `bridge#runTurn` 的 abort 监听转成 `abort` 命令（`bridge.ts` 自己处理宽限）。
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
import {
  collectRoundArtifacts,
  ensureSandbox,
  getSandboxRpc,
  snapshotWorkFiles,
  type SandboxAcquireFailure,
  type SandboxHandle,
  type SandboxRpc,
  type TurnFailureReason,
  type TurnOutcome,
  type WorkSnapshot,
} from '../sandbox/index.js'
import { createEngineEventMapper, type EngineUsage } from '../sandbox/map.js'
import { persistRoundQuietly } from './persist.js'
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
     * 本轮用量。⚠️ 引擎给的是**累积值** ⇒ 每次直接覆盖（判据 ③）；
     * `null` = 至今没有哪一帧带过它（`readEngineUsage` 两个数都取不到时返回 `null`，不编 0）。
     */
    usage: null as EngineUsage | null,
    /** 收到的正文增量条数（日志用；也是 TTFT 的判据） */
    deltaCount: 0,
    // ── 引擎事件的"可解释性"计数器（`map.ts` 文件头的 known / anomaly）──
    /** 引擎发过、但映射表里没有的事件名（版本漂移）。**只留痕**，不进事件流 */
    unknownEventTypes: new Set<string>(),
    /** 认识、但载荷用不了（缺必填字段）的次数 —— 每一条都当场 warn，见下面的处理 */
    anomalies: 0,
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
  let outcome: TurnOutcome | null = null
  let failure: unknown = null
  /**
   * 产物基线（③.5 拍、④.5 用）。`undefined` = 没拍成（`snapshotWorkFiles` 内部已 warn）
   * ⇒ 收集整轮跳过：**宁可不收，不重复收**（拿空基线当对照会把复用容器里上一轮的产物
   * 全部再报一次 —— `子方案③` §十一 1 点名的症状）。
   */
  let baseline: WorkSnapshot | undefined
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

    try {
      // ═════════════════════════════════════════════════════════════
      // ② 引擎桥（一个会话一条、与容器同寿命；容器换了它会自己重attach）
      // ═════════════════════════════════════════════════════════════
      bridge = await getSandboxRpc(conversationId, handle.containerId)

      // ═════════════════════════════════════════════════════════════
      // ③ 订阅（判据 ①：**必须早于派活**）
      // ═════════════════════════════════════════════════════════════
      // ③.5 拍产物基线（P0-3-7；P0-3-6 详规传下来的口径 ②：**必须在派活之前**，
      //     不许收尾之后补 —— 否则"基线"里已经混进了这一轮的产物，对照出来永远为空）
      baseline = await snapshotWorkFiles(handle.containerId)

      const mapper = createEngineEventMapper()
      unsubscribe = bridge.onEvent((event) => {
        const mapped = mapper.map(event)

        // ── 同步那一半：把"这一轮发生过什么"记下来 ──
        for (const frame of mapped.events) {
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
        // 覆盖而不是相加（判据 ③）；`null` 表示这一帧没带 usage，**不该盖掉**已有的值
        if (mapped.usage !== null) round.usage = mapped.usage
        if (mapped.toolRecord !== undefined) round.toolRecords.push(mapped.toolRecord)

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
        enqueue(mapped.events, mapped.snapshot)
      })

      // ═════════════════════════════════════════════════════════════
      // ④ 派活（`runTurn` 内部：先挂 `agent_settled` 等待者，再 `send(prompt)`）
      // ═════════════════════════════════════════════════════════════
      outcome = await bridge.runTurn(content, { signal })
    } catch (error) {
      // 中断与故障在这里**都只是"记下来"**，统一的收尾在下面（顺序即优先级，与 chatBot 同款）
      failure = error
    } finally {
      // 退订必须做：桥活得比这一轮久（复用容器），不退就是每一轮多一个监听器 + 多一份泄漏的引用
      unsubscribe?.()
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ④.5 收产物（P0-3-7）
  // ═══════════════════════════════════════════════════════════════════
  // 排在⑤冲刷**之前** ⇒ `artifact` 帧与内容帧同一条串行队列，顺序天然正确（先过程、后产物、最后 done）。
  // **中断/故障的轮也照收**（`子方案③` §九 5：用户点停止通常正是因为他已经拿到想要的东西了）；
  // 引擎挂了的那轮会因容器已死而在扫描处自然失败为空集。
  // ⚠️ 收集失败 ≠ 这一轮失败：产物是本轮的赠品，任何异常只 warn、不进 `error` 帧（见 `artifacts.ts` 文件头）。
  if (sandbox !== null && baseline !== undefined) {
    try {
      const collected = await collectRoundArtifacts({
        conversationId,
        containerId: sandbox.containerId,
        baseline,
      })
      artifactItems.push(...collected)
      if (collected.length > 0) {
        enqueue(collected.map((item) => ({ name: 'artifact', data: item } as const satisfies SseEvent)))
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

  const messageId = await persistRoundQuietly({
    conversationId,
    content,
    assistantText: round.assistantText,
    thinkingText: round.thinkingText,
    // TaskAgent 本轮**不检索** ⇒ 恒为空（知识库绑定经 §七 代理以工具形态出现，属 P0-3-9b）
    citations: [],
    toolRecords: round.toolRecords,
    // 本轮建成的产物行（P0-3-7）：事件里发过的那几张卡，刷新后从 `content.artifacts` 恢复
    artifacts: artifactItems,
    usage: round.usage,
    logger,
  })

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
      // 引擎给的**累积**用量（`message_update.usage`），某一路取不到就是 `null`（不知道就不编 0）
      tokensIn: round.usage?.tokensIn ?? null,
      tokensOut: round.usage?.tokensOut ?? null,
      durationMs: Date.now() - requestedAtMs,
    },
    'TaskAgent 本轮结束',
  )

  return { messageId, finishReason, usage: round.usage }
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
