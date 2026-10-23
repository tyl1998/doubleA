/**
 * 一轮对话的**事件归约**（P0-1-32）
 *
 * 依据：`docs/03-前端设计.md` §五（事件 → UI 映射表**逐行**）、§4.1（输入区状态机与消息流渲染规则）、
 *      `shared/src/sse.ts`（10 个事件的 payload 与收尾规则）、`docs/02` §5.2（"事件即真相"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"纯归约"而不是"直接在 store 里改字段"
 * ─────────────────────────────────────────────────────────────────────
 * 这张映射表里有**九行**（`ping` 是第十行、要求"静默忽略"），每行都可能写错，而写错的表现
 * 大多**不是崩溃，是"少一张卡"或"多了个字"** —— 只有在真流上才能发现，而且很难复现。
 * 做成 `(round, event) => round` 的纯函数之后：
 *   · `frontend/scripts/verify-chat-sse.mjs` 可以直接喂**手写事件序列**，逐条断言最终形状；
 *   · store 只剩"把结果塞回去"这一件事（`stores/chatStream.ts`），没有第二处逻辑。
 * 这是本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法（`chatContext.ts` / `semaphore.ts`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `ping` 返回**同一个对象**（而不是"内容相同的新对象"）
 * ─────────────────────────────────────────────────────────────────────
 * 返回值被 zustand 用 `Object.is` 比较：返回同一个引用 ⇒ **一次重渲染都不会发生**。
 * 于是"静默忽略"这件事有了一个比"逐字段相等"更硬的取证方式（`strictEqual(before, after)`）。
 * `03` §五 的坑预判原文是"`ping` 误当数据渲染会让消息流出现空条目"——
 * 本仓的心跳默认 20s 一次、持续到整条流结束，误渲染的后果是**长回答里插进一串空气泡**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 收尾（`done` / `error`）之后**不再接受内容事件**
 * ─────────────────────────────────────────────────────────────────────
 * `shared/src/sse.ts` 文件头 ③：一条流以 `done` **或** `error` 结尾，二选一、各一次。
 * 收尾后若还收到 `delta`，只可能是"两侧契约漂了"或"流里有 bug" ⇒ 归约层**忽略**它，
 * 但**不改状态**（把已经收口的内容改花比丢一帧更糟）。这类情况由 `useChatStream` 记一条 warn。
 */

import type {
  ChatFinishReason,
  CitationItem,
  ConfirmSource,
  SseDonePayload,
  SseEvent,
} from '@doubulea/shared'

import {
  artifactViewFromEvent,
  toolViewFromEvent,
  type ArtifactView,
  type AttachmentView,
  type ChatMessageView,
  type ToolCallView,
} from './messageModel.js'

/** 事件来源（决定"没有收口就该报断线"的文案与处置，P0-1-33 用） */
export type RoundStatus = 'streaming' | 'stopped' | 'complete' | 'error'

/** 流式助手消息的累积内容（一帧一帧长出来） */
export interface StreamAssistant {
  text: string
  /**
   * 思考过程**分段**（2026-10-21）：一段 = 一次模型请求里的推理。`thinking` 帧带 `newSegment`
   * 时另起一段（「工具调用之后的重新推理」不追加到旧段），并带**内联位置**
   * （`textOffset` / `seq`，与工具卡共用一条序列）⇒ 渲染时按发生顺序插在正文/卡片之间。
   */
  thinkingSegments: {
    text: string
    textOffset?: number
    seq?: number
  }[]
  /** `null` = 还没有 `citations` 事件（**与"有引用但为空"不同**，见 `messageModel.ts`） */
  citations: CitationItem[] | null
  tools: ToolCallView[]
  artifacts: ArtifactView[]
}

/**
 * 这一轮是**怎么发起的**（P1-3）。
 *
 *   · `'send'` = 用户新发一条消息（默认）；
 *   · `'regenerate'` = **重新生成**最新一轮 —— 后端会先撤掉上一轮再重跑同一段正文
 *     （`POST /:id/regenerate`）。它唯一影响的是**渲染**：页面据此把历史里"正在被替换的
 *     那一轮"暂时收起（`messageModel.ts#dropLastRound`），否则会与这一轮渲染出重复气泡。
 *     归约/收尾逻辑与 `'send'` **逐字一致**（同一条 `/chat` 链路、同一套事件）。
 */
export type RoundKind = 'send' | 'regenerate'

/** 当前这一轮的全部状态（用户消息 + 助手消息 + 收尾信息） */
export interface StreamRound {
  /** 这一轮的发起方式（见 {@link RoundKind}）——只影响页面渲染，不影响事件归约 */
  kind: RoundKind
  /** 本轮用户消息的正文（已 trim，与后端落库的正文一致） */
  userText: string
  /**
   * 本轮用户消息携带的附件（**P1-4**）—— 由页面在 `begin` 时传入（此刻它们已经在服务端上传好了）。
   * `regenerate` 恒为空数组（重新生成不带附件，见 `useChatStream#regenerate`）。
   */
  userAttachments: readonly AttachmentView[]
  /** 本轮开始时刻（ISO 8601，客户端侧）—— 与后端 `done` 无关，只用于"已用时"展示 */
  startedAt: string
  assistant: StreamAssistant
  status: RoundStatus
  /** 流内 `error` 事件的载荷（`status === 'error'` 时才有） */
  error: { code: string; message: string } | null
  /**
   * 这一轮的失败是**谁**发现的（P0-1-33 新增）—— 它决定用哪个通道告诉用户：
   *   · `'server'` = 流内 `error` 事件（后端主动收口，含 `CONFLICT` / 上游故障）
   *     ⇒ `03` §五 的 `error` 行：**错误 toast + 消息流内错误卡**（`shouldToastChatError`）；
   *   · `'client'` = 本地读流失败 / 连接中断（`ChatStreamStore.fail`）
   *     ⇒ 消息流内错误卡 + **顶部黄条**（`03` §4.1："断线 → 顶部黄条提示"），**不弹 toast**
   *       （同一件事说三遍反而把黄条那句"点此对齐历史"淹掉）。
   * `null` = 这一轮没有失败（含正常收尾与用户停止）。
   *
   * ⚠️ 为什么不能只看 `status === 'error'`：两种失败的**后续处置完全不同** ——
   * 服务端故障要"释放输入区 + 报错"，客户端中断要"提示对齐历史"。
   * 混在一起时最典型的表现是"断线的黄条不出现"或"断线弹一个没用的 toast"。
   */
  errorSource: 'server' | 'client' | null
  finishReason: ChatFinishReason | null
  usage: SseDonePayload['usage'] | null
  /**
   * `false` = 这一轮没有产生可持久化的消息（`done.messageId === null`）。
   * `null` = 还没收尾。见 `shared/src/sse.ts` 文件头 ④。
   */
  persisted: boolean | null
  /**
   * `done.messageId` —— 本轮助手消息在**库里**的 id。
   *
   * 它的唯一用途是让页面判断"历史里已经拿到这条了"（见 `ChatPage` 的对齐 effect）：
   * 流收口后我们会让历史查询失效并重拉（`useChatStream.ts`），重拉到位之前**不能**把流式
   * 版本丢掉（否则消息流会闪一下"少一条"）；到位之后**必须**丢掉（否则同一条消息渲染两遍）。
   * `null` = 没落库或还没收尾。
   */
  assistantMessageId: string | null
  /**
   * 待应答的确认（`02` §六 第 4 步 / §9.10：`confirm` 事件到达 ⇒ 锁输入区）。
   *
   * ⚠️ **P0-2-11 起它真的会被填上**（产生方是 P0-2-9 的危险判定闸门与 MCP 的
   * `elicitation/create`，两个都在 P0-2-10 落地）。归约体没变 —— `event.data` 本来就是
   * `sseConfirmPayloadSchema` 的完整输出，只是**这个类型声明原先收窄成三个字段**，
   * 于是 `ConfirmCard` 读不到 `source` / `expiresAt`。
   * ⇒ 本批把类型补成完整载荷（**这正是一个"类型比事实窄"的坑**：归约层一直带着它，
   * 只是声明层把它藏了起来）。
   *
   * ⚠️ 倒计时**只读 `expiresAt`**（服务端给的绝对时刻），前端**不另起一个 120s**
   * （`06` P0-2-11 坑预判 3）：两边只要有一点点差（网络、时钟、重连）就会变成
   * "界面说还没到、服务端已按取消处理"，而用户看到的是"我点了确认但什么都没发生"。
   */
  confirm: {
    confirmId: string
    /** 谁在问（`PLATFORM` = 平台危险判定；`SERVER` = MCP server 反向发起）—— 只决定说明文案 */
    source: ConfirmSource
    toolName: string
    inputSummary: string
    /** 服务端这次等待的截止时刻（ISO 8601） */
    expiresAt: string
    /**
     * 这次问的是**重复执行**（本轮同名同参的危险工具已经成功执行过一次）——
     * 卡片据此换措辞，见 `ConfirmCard`。缺省 = 普通确认。
     */
    duplicate?: boolean
  } | null
  /**
   * 沙箱排队位次（`queued` 事件，**1 = 下一个**）。
   * ⚠️ **P0 阶段恒为 `null`**：产生方是沙箱并发闸，属 **P0-3**（`CHATBOT_CONCURRENCY` 满时
   * 走的是流内 `error{BUSY}`，不是 `queued` —— 那是两个不同的机制，别混）。
   */
  queuedPosition: number | null
  /**
   * 本轮生命周期的**中间态**（`status` 事件，TaskAgent 专属；`shared#sseStatusPayloadSchema`）。
   * `null` = 还没有 / 已被真实内容替代。它是"还没内容时"的进度指示：
   * `delta` / `thinking` / `tool_call` 一到达就清掉（真实进度已经可见）。
   */
  statusText: string | null
  /**
   * 本轮内联时间线的**下一个兜底序号**（2026-10-21）。
   *
   * 服务端会给思考段/工具卡带 `seq`（二者共用一条序列）；但旧服务端、或某帧漏带时前端不能
   * 退回"按数组下标"——那会随 upsert / 到达顺序变化，表现就是**块在流式中跳位置**。
   * 兜底 = 前端自己也维护一个单调计数器：没带 `seq` 的条目取 `nextInlineSeq`，带了就以其为准
   * 并把计数器推到它之后（保证后续兜底值不会插到已有序号前面）。
   */
  nextInlineSeq: number
  /**
   * 本轮**投递给运行中 agent 的用户插话**（`steer` 事件，P1-9 · P4 · R1；P1-20 起发帧）。
   *
   * ⚠️ 存在的唯一理由：**让插话在聊天界面看得见**。产品反馈："插话发出去后 agent 像收到了，
   * 但聊天界面看不到这条插话（像丢消息）"。每条插话在消息流里渲染成一条用户气泡
   * （见 `roundToViews`），于是"我插了这句话"与 agent 的后续回答对得上。
   *
   * `state`（2026-10-21）：`queued` = 还在引擎插话队列里（前端显示「待接收」+「取回编辑」）；
   * `delivered` = 不在 `steer_queue` 快照里了（模型读走 / ChatBot 注入完毕）⇒ 状态翻成「已投递」、
   * 收起「取回编辑」（引擎不支持回滚已投递的消息）。
   */
  interjections: { id: string; text: string; at: string; state: 'queued' | 'delivered' }[]
}

/** 开一轮（用户按下发送、且流已经成功建立时调用） */
export function beginRound(
  userText: string,
  startedAt: string,
  kind: RoundKind = 'send',
  userAttachments: readonly AttachmentView[] = [],
): StreamRound {
  return {
    kind,
    userText,
    userAttachments,
    startedAt,
    assistant: { text: '', thinkingSegments: [], citations: null, tools: [], artifacts: [] },
    nextInlineSeq: 0,
    status: 'streaming',
    error: null,
    errorSource: null,
    finishReason: null,
    usage: null,
    persisted: null,
    assistantMessageId: null,
    confirm: null,
    queuedPosition: null,
    statusText: null,
    interjections: [],
  }
}

/** 是否已经收口（`done` / `error` 都算）—— 收口后不再接受内容事件 */
export function isSettled(round: StreamRound): boolean {
  return round.status !== 'streaming'
}

/**
 * 往这一轮追加一条**用户插话**（P1-20）。**按正文去重**：前端在 `POST /:id/steer` 成功后**乐观**
 * 插入一条，稍后出口层（若那一轮真的轮询到了）再回一帧 `steer` —— 两者是同一条，别显示两遍。
 *
 * ⚠️ 为什么要有**乐观**插入这条路：出口层那一帧依赖"通道轮询在轮次结束前取到插话"。插话常常
 *    就发生在最后一两秒（用户看着回答快完了才补一句），轮询还没到点、这一轮就结束了 ⇒
 *    `clearSteerSignal` 把积压清掉 ⇒ 既没投给模型、也没发帧 ⇒ 界面上"插话直接消失了"。
 *    所以**展示以本地为准**（用户说过的话一定要看得见），出口层那一帧只当"确认送达"的第二次来源。
 */
export function withInterjection(
  round: StreamRound,
  item: { id: string; text: string; at: string },
): StreamRound {
  if (isSettled(round)) return round
  // ⚠️ **按 id 去重**（2026-10-21 起）：早先按正文去重 ⇒ 同一句话插两次会被吞掉一条。
  const existing = round.interjections.find((entry) => entry.id === item.id)
  if (existing !== undefined) {
    // 已存在（乐观插入先到 / 或反过来）：只补/刷新状态，不重复追加
    return round
  }
  return {
    ...round,
    interjections: [...round.interjections, { ...item, state: round.status === 'streaming' ? 'queued' : 'delivered' }],
  }
}

/**
 * 用引擎插话队列快照（`steer_queue`）刷新每条插话的投递状态（2026-10-21）。
 *
 * 判据只有一条：**不在队列里 = 已被模型读走**（`delivered`）。
 * ⚠️ 只做单向翻转（queued → delivered）：引擎不会把已投递的再放回队列；
 * 反过来写会让状态在两次快照之间来回跳。
 */
export function withSteerQueue(round: StreamRound, queued: readonly string[]): StreamRound {
  if (isSettled(round)) return round
  if (round.interjections.length === 0) return round
  const pending = new Set(queued)
  let changed = false
  const next = round.interjections.map((entry) => {
    if (entry.state === 'delivered') return entry
    if (pending.has(entry.text)) return entry
    changed = true
    return { ...entry, state: 'delivered' as const }
  })
  return changed ? { ...round, interjections: next } : round
}

/** 撤回一条插话（2026-10-21；取消端点返回 `scope:'one'` 时用）。找不到 = 原样返回 */
export function withoutInterjection(round: StreamRound, id: string): StreamRound {
  const next = round.interjections.filter((entry) => entry.id !== id)
  if (next.length === round.interjections.length) return round
  return { ...round, interjections: next }
}

/**
 * 撤掉**所有还没投递**的插话（取消端点返回 `scope:'all'` 时用：引擎只支持整体清空，
 * 所以"还在排队"的那几条都已作废；已投递的保留 —— 模型读过，撤不回来）。
 */
export function withoutQueuedInterjections(round: StreamRound): StreamRound {
  const next = round.interjections.filter((entry) => entry.state === 'delivered')
  if (next.length === round.interjections.length) return round
  return { ...round, interjections: next }
}

/**
 * 归约一帧。
 *
 * `round` 与返回值的关系有**三种**，都是刻意的：
 *   · 返回**同一个引用** ⇒ 这一帧不产生任何界面变化（`ping`、收口后的内容帧）；
 *   · 返回新对象 ⇒ 有可渲染的变化；
 *   · 返回 `round` 本身也用于"未知事件"（本层拿到的 `SseEvent` 已经过 schema 校验，
 *     所以"未知"只可能是上游加了新事件而这里没跟上 —— 忽略即可，不该让整条流失败）。
 */
export function reduceRound(round: StreamRound, event: SseEvent): StreamRound {
  // 已经收口（`done` / `error` 各一次，见 `shared/src/sse.ts` 文件头 ③）⇒ 之后**一切**都忽略：
  // 既保护已经渲染出来的内容不被后续帧改花，也让"第一个终态"成为唯一终态
  if (isSettled(round)) return round

  switch (event.name) {
    case 'ping':
      // 心跳：**静默忽略**（`03` §五）—— 返回同一引用，连一次重渲染都不触发
      return round

    case 'delta':
      // ⚠️ 空增量**不产生新对象**（内存优化 P5）：`apply` 用 `next === round` 判"没有可见变化"，
      //    返回同一引用就一次重渲染都不会发生。上游偶尔会发 `delta{text:''}`（心跳式的保活帧），
      //    早先它会让整棵消息列表白重渲染一次 —— 长会话里这类白帧是纯浪费。
      if (event.data.text === '') {
        return round.statusText === null ? round : { ...round, statusText: null }
      }
      return {
        ...round,
        statusText: null,
        assistant: { ...round.assistant, text: round.assistant.text + event.data.text },
      }

    case 'thinking': {
      // 分段累积（2026-10-21）：`newSegment` ⇒ 另起一段（带内联位置）；否则接到最后一段。
      // 段内仍是字符串拼接（同一段内本来就是逐字增量）。
      const segments = round.assistant.thinkingSegments
      const startsSegment = event.data.newSegment === true || segments.length === 0
      // 段首的序号：服务端给的为准；没给就用前端的兜底计数器（见 `nextInlineSeq` 的注释）
      const seq = startsSegment ? (event.data.seq ?? round.nextInlineSeq) : null
      const nextInlineSeq = seq === null ? round.nextInlineSeq : Math.max(round.nextInlineSeq, seq + 1)
      const next = startsSegment
        ? [
            ...segments,
            {
              text: event.data.text,
              ...(event.data.textOffset === undefined ? {} : { textOffset: event.data.textOffset }),
              ...(seq === null ? {} : { seq }),
            },
          ]
        : [
            ...segments.slice(0, -1),
            { ...segments[segments.length - 1]!, text: segments[segments.length - 1]!.text + event.data.text },
          ]
      return {
        ...round,
        statusText: null,
        nextInlineSeq,
        assistant: { ...round.assistant, thinkingSegments: next },
      }
    }

    case 'tool_call': {
      // 同一个 `callId` 多次推送 = 状态机流转（RUNNING → SUCCESS/ERROR）⇒ **upsert**，不是追加
      const next = toolViewFromEvent(event.data)
      const index = round.assistant.tools.findIndex((tool) => tool.callId === next.callId)
      if (index === -1) {
        // 首次见到这张卡：序号以服务端为准，缺省用前端的兜底计数器（同 `nextInlineSeq`）
        const seq = next.seq ?? round.nextInlineSeq
        return {
          ...round,
          statusText: null,
          nextInlineSeq: Math.max(round.nextInlineSeq, seq + 1),
          assistant: {
            ...round.assistant,
            tools: [...round.assistant.tools, { ...next, seq }],
          },
        }
      }
      const tools = [...round.assistant.tools]
      const previous = tools[index]
      // ⚠️ 内联位置**只增不减**（2026-10-21）：`textOffset` / `seq` 在首次出现时定死，
      //    后续帧（RUNNING → SUCCESS）若没带或带了不同的值，都不能让卡片"跳位置"
      //    —— 这正是流式中看到"卡一下跑到上面去"的来源之一。`output` 同款：可省。
      tools[index] = {
        ...next,
        ...(next.textOffset === undefined && previous?.textOffset !== undefined
          ? { textOffset: previous.textOffset }
          : {}),
        ...(next.seq === undefined && previous?.seq !== undefined ? { seq: previous.seq } : {}),
        ...(next.output === undefined && previous?.output !== undefined
          ? { output: previous.output }
          : {}),
      }
      return { ...round, statusText: null, assistant: { ...round.assistant, tools } }
    }

    case 'tool_output': {
      // 工具**执行中**的输出快照（覆盖语义）：按 `callId` 找到那张卡、**整体替换**实时输出。
      // ⚠️ 找不到卡就**忽略**（不为它凭空造一张没有名字/状态的卡）——正常情况下 start 那帧先到。
      // ⚠️ 不落库、不进历史（`liveOutput` 是流式专有字段）；终态帧到达后用权威 `output` 覆盖显示。
      const index = round.assistant.tools.findIndex((tool) => tool.callId === event.data.callId)
      if (index === -1) return round
      const previous = round.assistant.tools[index]
      if (previous === undefined) return round
      const tools = [...round.assistant.tools]
      tools[index] = { ...previous, liveOutput: event.data.text }
      return { ...round, assistant: { ...round.assistant, tools } }
    }

    case 'citations':
      // 空数组按"没有引用"处理：与 `messageToView` 的口径一致，避免渲染一张空引用卡
      return {
        ...round,
        assistant: {
          ...round.assistant,
          citations: event.data.items.length === 0 ? null : event.data.items,
        },
      }

    case 'artifact': {
      const next = artifactViewFromEvent(event.data)
      // 同一个产物重复推送时**不重复追加**（`artifact` 的语义是"产物面板追加条目"，
      // 而面板是按产物去重的清单；重复条目会让"产物 · N"这个计数说谎）
      if (round.assistant.artifacts.some((item) => item.artifactId === next.artifactId)) return round
      return {
        ...round,
        assistant: { ...round.assistant, artifacts: [...round.assistant.artifacts, next] },
      }
    }

    case 'confirm':
      return { ...round, confirm: event.data }

    /**
     * 提问**结束**（`confirm_resolved`）：只撤卡，不改正文/工具。
     *
     * ⚠️ 必须处理这一帧：结束可能由**第三方代理**替用户点了 `/confirm`，或超时/中断发生 ——
     * 本端 `ChatPage#handleConfirmAnswer` 的 `finally` 只覆盖"我点的"那一路。没有它，
     * 对方确认后我们这边工具都跑完了，确认卡还挂在输入区（并且继续锁着输入）。
     * ⚠️ 按 `confirmId` 比对：迟到/错配的终局帧不能撤掉**新**那张卡。
     */
    case 'confirm_resolved':
      if (round.confirm === null || round.confirm.confirmId !== event.data.confirmId) return round
      return { ...round, confirm: null }

    case 'queued':
      return { ...round, queuedPosition: event.data.position }

    case 'status':
      return { ...round, statusText: event.data.text }

    case 'steer':
      // 中途插话（P1-20）：**追加**一条用户插入（不清 `statusText`、不动助手内容）——
      // 它由出口层在"把插话投递给 agent"时发来，是"用户确实插了这句话"的第二重证据；
      // 与前端乐观插入的那条**按 id 去重**（见 `withInterjection`）。
      return withInterjection(round, {
        id: event.data.id,
        text: event.data.message,
        at: event.data.at,
      })

    case 'steer_queue':
      // 引擎插话队列快照（2026-10-21）：不在快照里的插话 = 已被模型读走（见 `withSteerQueue`）
      return withSteerQueue(round, event.data.messages)

    case 'done':
      return {
        ...round,
        // `finishReason: 'ERROR'` 在当前后端**没有产生路径**（`shared/src/sse.ts` 文件头 ③），
        // 但取值域里留着它（留给 P0-3 的"流已开始又必须失败收口"）。真收到时按**异常收尾**
        // 处理：它不是"正常完成"，按完成渲染会把故障显示成成功。
        status:
          event.data.finishReason === 'STOPPED'
            ? 'stopped'
            : event.data.finishReason === 'ERROR'
              ? 'error'
              : 'complete',
        finishReason: event.data.finishReason,
        usage: event.data.usage,
        persisted: event.data.messageId !== null,
        assistantMessageId: event.data.messageId,
        ...(event.data.finishReason === 'ERROR'
          ? {
              error: { code: 'INTERNAL', message: '生成过程中断，已生成的内容保留' },
              // 这是**服务端**说的失败（它自己给的 `finishReason:ERROR`）⇒ 与流内 `error` 事件同一个通道
              errorSource: 'server' as const,
            }
          : {}),
      }

    case 'error':
      return {
        ...round,
        status: 'error',
        error: { code: event.data.code, message: event.data.message },
        errorSource: 'server',
      }

    default:
      return round
  }
}

/** 一轮对话 → 消息列表（**用户 + 助手 + 本轮插话**），顺序与用户在界面上期待的阅读顺序一致 */
export function roundToViews(round: StreamRound): ChatMessageView[] {
  return [
    {
      key: 'stream:user',
      role: 'USER',
      text: round.userText,
      thinkingSegments: [],
      citations: null,
      tools: [],
      artifacts: [],
      attachments: round.userAttachments,
      createdAt: null,
      status: 'complete',
    },
    {
      key: 'stream:assistant',
      role: 'ASSISTANT',
      text: round.assistant.text,
      thinkingSegments: round.assistant.thinkingSegments,
      citations: round.assistant.citations,
      tools: round.assistant.tools,
      artifacts: round.assistant.artifacts,
      attachments: [],
      createdAt: null,
      startedAt: round.startedAt,
      status: round.status,
      ...(round.statusText === null ? {} : { statusText: round.statusText }),
      ...(round.finishReason === null ? {} : { finishReason: round.finishReason }),
      ...(round.usage === null ? {} : { usage: round.usage }),
      ...(round.error === null ? {} : { error: round.error }),
      persisted: round.persisted,
    },
    // 中途插话（P1-20；**2026-10-21 起改放本轮末尾**）：每条渲染成一条用户气泡 ⇒
    // 用户看得见"我插了这句话"（不再像丢消息）。
    // ⚠️ 为什么在助手消息**之后**：插话的语义是"边跑边补一句"，它属于**本轮尾部**——
    //    用户原话："插话发起后应该是直接在本轮末尾添加的，而不是放到本轮的回复前"。
    //    助手正文在这里是一坨整篇（`round.assistant.text`）⇒ 无法按时刻插进它内部；
    //    放在末尾是"这一轮完整回答 + 我中途补的话"的可读近似（历史侧同一顺序，见 `messageModel`）。
    ...round.interjections.map((item) => ({
      key: `stream:steer:${item.id}`,
      role: 'USER' as const,
      text: item.text,
      thinkingSegments: [],
      citations: null,
      tools: [],
      artifacts: [],
      attachments: [],
      createdAt: item.at,
      status: 'complete' as const,
      steer: true as const,
      steerId: item.id,
      steerState: item.state,
    })),
  ]
}

/**
 * ⚠️ 「助手消息是否什么都还没有」的判据（`isAssistantEmpty`）**不住在本文件**：
 * 它是**视图**层面的判断，与 {@link ChatMessageView} 一起放在 `messageModel.ts`
 * （历史消息也要能被同一个函数判断 —— 例如"只落了引用卡、正文为空"的那一轮，见 P0-1-29 坑 2）。
 */
