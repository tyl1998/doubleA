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
  SseDonePayload,
  SseEvent,
} from '@doubulea/shared'

import {
  artifactViewFromEvent,
  toolViewFromEvent,
  type ArtifactView,
  type ChatMessageView,
  type ToolCallView,
} from './messageModel.js'

/** 事件来源（决定"没有收口就该报断线"的文案与处置，P0-1-33 用） */
export type RoundStatus = 'streaming' | 'stopped' | 'complete' | 'error'

/** 流式助手消息的累积内容（一帧一帧长出来） */
export interface StreamAssistant {
  text: string
  thinking: string
  /** `null` = 还没有 `citations` 事件（**与"有引用但为空"不同**，见 `messageModel.ts`） */
  citations: CitationItem[] | null
  tools: ToolCallView[]
  artifacts: ArtifactView[]
}

/** 当前这一轮的全部状态（用户消息 + 助手消息 + 收尾信息） */
export interface StreamRound {
  /** 本轮用户消息的正文（已 trim，与后端落库的正文一致） */
  userText: string
  /** 本轮开始时刻（ISO 8601，客户端侧）—— 与后端 `done` 无关，只用于"已用时"展示 */
  startedAt: string
  assistant: StreamAssistant
  status: RoundStatus
  /** 流内 `error` 事件的载荷（`status === 'error'` 时才有） */
  error: { code: string; message: string } | null
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
   * 待应答的确认（`02` §六 第 4 步：`confirm` 事件到达 ⇒ 锁输入区）。
   * ⚠️ **P0 阶段恒为 `null`**：`confirm` 的产生方是 MCP 工具的危险判定，属 **P0-2**；
   * 它的应答端点 `POST /:id/confirm` 也属 P0-2。归约与渲染先就位，产生路径等那一批。
   */
  confirm: { confirmId: string; toolName: string; inputSummary: string } | null
  /**
   * 沙箱排队位次（`queued` 事件，**1 = 下一个**）。
   * ⚠️ **P0 阶段恒为 `null`**：产生方是沙箱并发闸，属 **P0-3**（`CHATBOT_CONCURRENCY` 满时
   * 走的是流内 `error{BUSY}`，不是 `queued` —— 那是两个不同的机制，别混）。
   */
  queuedPosition: number | null
}

/** 开一轮（用户按下发送、且流已经成功建立时调用） */
export function beginRound(userText: string, startedAt: string): StreamRound {
  return {
    userText,
    startedAt,
    assistant: { text: '', thinking: '', citations: null, tools: [], artifacts: [] },
    status: 'streaming',
    error: null,
    finishReason: null,
    usage: null,
    persisted: null,
    assistantMessageId: null,
    confirm: null,
    queuedPosition: null,
  }
}

/** 是否已经收口（`done` / `error` 都算）—— 收口后不再接受内容事件 */
export function isSettled(round: StreamRound): boolean {
  return round.status !== 'streaming'
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
      return {
        ...round,
        assistant: { ...round.assistant, text: round.assistant.text + event.data.text },
      }

    case 'thinking':
      return {
        ...round,
        assistant: { ...round.assistant, thinking: round.assistant.thinking + event.data.text },
      }

    case 'tool_call': {
      // 同一个 `callId` 多次推送 = 状态机流转（RUNNING → SUCCESS/ERROR）⇒ **upsert**，不是追加
      const next = toolViewFromEvent(event.data)
      const index = round.assistant.tools.findIndex((tool) => tool.callId === next.callId)
      if (index === -1) {
        return { ...round, assistant: { ...round.assistant, tools: [...round.assistant.tools, next] } }
      }
      const tools = [...round.assistant.tools]
      // `output` 可省：`RUNNING` 那一帧没有它 ⇒ **保留旧值**，别把它抹成 undefined
      const previous = tools[index]
      tools[index] =
        next.output === undefined && previous?.output !== undefined
          ? { ...next, output: previous.output }
          : next
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

    case 'queued':
      return { ...round, queuedPosition: event.data.position }

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
          ? { error: { code: 'INTERNAL', message: '生成过程中断，已生成的内容保留' } }
          : {}),
      }

    case 'error':
      return {
        ...round,
        status: 'error',
        error: { code: event.data.code, message: event.data.message },
      }

    default:
      return round
  }
}

/** 一轮对话 → 消息列表（**两条**：用户 + 助手），顺序与流里出现的顺序一致 */
export function roundToViews(round: StreamRound): ChatMessageView[] {
  return [
    {
      key: 'stream:user',
      role: 'USER',
      text: round.userText,
      thinking: '',
      citations: null,
      tools: [],
      artifacts: [],
      createdAt: null,
      status: 'complete',
    },
    {
      key: 'stream:assistant',
      role: 'ASSISTANT',
      text: round.assistant.text,
      thinking: round.assistant.thinking,
      citations: round.assistant.citations,
      tools: round.assistant.tools,
      artifacts: round.assistant.artifacts,
      createdAt: null,
      status: round.status,
      ...(round.finishReason === null ? {} : { finishReason: round.finishReason }),
      ...(round.usage === null ? {} : { usage: round.usage }),
      ...(round.error === null ? {} : { error: round.error }),
      persisted: round.persisted,
    },
  ]
}

/**
 * ⚠️ 「助手消息是否什么都还没有」的判据（`isAssistantEmpty`）**不住在本文件**：
 * 它是**视图**层面的判断，与 {@link ChatMessageView} 一起放在 `messageModel.ts`
 * （历史消息也要能被同一个函数判断 —— 例如"只落了引用卡、正文为空"的那一轮，见 P0-1-29 坑 2）。
 */
