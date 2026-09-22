/**
 * SSE 协议契约（P0-1-26；`02` §五「SSE 协议（前后端唯一契约，双链路归一化）」）
 *
 * 本文件是**事件全集**的唯一事实来源：后端 `orchestrator/sse.ts` 按它序列化每一帧，
 * 前端（P0-1-32 的 `useChatStream`）按它分派渲染（`03` §五 的事件 → UI 映射表逐行对应）。
 * 事件名/payload 形状在别处**不许再写一遍字符串**（同 `ERROR_CODES` 的口径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 归一化的意义：两条链路 → 同一套事件
 * ─────────────────────────────────────────────────────────────────────
 * ChatBot 走"后端 RAG 编排 + MCP 工具"，TaskAgent 走"沙箱 ACP 引擎 + bash/read/write 工具"
 * （`01` 决策 5）。两者在**编排层**完成映射，中间层（SSE 出口）只认下面这 10 个事件 ——
 * 于是前端只有一套渲染路径，将来接新引擎也不必动前端。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 「事件即真相」：不做 SSE 重放
 * ─────────────────────────────────────────────────────────────────────
 * `02` §5.2：前端渲染**只依赖事件流**；持久化由后端在 `done` 时整条落库（含 tool_calls /
 * citations / artifacts 结构），历史拉取直接读库。断线重连时**不重放** —— 先查
 * `GET /:id/active` 拿"在流 / 排队位次 / 当前工具"（`shared/src/conversation.ts` 的
 * `conversationActiveSnapshotSchema`），再拉历史补齐。
 * 这条口径的直接后果：**流里的事件不必可重放、也没有 `id:` 字段**（SSE 的 `Last-Event-ID`
 * 机制在本系统里没有消费方），故 `orchestrator/sse.ts` 的帧只有 `event:` / `data:` 两行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 收尾规则（本批定案）：一条流以 `done` **或** `error` 结尾，二选一、且只出现一次
 * ─────────────────────────────────────────────────────────────────────
 * `02` §5.1 写的是"`error` 错误（流终止）"，`03` §五 的 `error` 行写的是"错误 toast +
 * 消息流内错误卡；**释放输入区**" —— 即**前端把 `error` 当作终结事件**（它自己收口，不等
 * 后面的 `done`）。故本文件把规则钉死为：
 *   · 正常结束 / 用户停止 ⇒ 最后一个事件是 `done`；
 *   · 流进行中出故障 ⇒ 最后一个事件是 `error`（**不再补 `done`**）。
 * `CHAT_FINISH_REASONS` 里的 `ERROR` 因此**当前没有产生路径**，它是 `02` §5.1 定下的取值域、
 * 留给"流已经开始、又必须以失败收口且前端需要 finishReason 区分"的将来形态（如 P0-3 沙箱
 * 中途崩溃）；本批与 P0-1-27 都**不使用**它 —— 保留它是因为"契约取值域由设计文档定义，
 * 实现进度不该反过来裁剪契约"。
 *
 * ⚠️ **两类失败、两个出口** —— 分界线是「**这个请求/目标**有问题」还是「**这一轮生成**被拒绝」，
 * *不是* 实现上的"能不能在写出第一帧之前判定"：
 *   · **前置失败 ⇒ 统一 JSON 信封**（`02` §四）：未登录 401 / 参数 400 / 会话不存在或不是我的
 *     404 / 会话只读 409 / 缺凭据 424 / 绑定模型停用 409。它们的**主语是请求或目标**，
 *     与"这一轮流"无关，换任何客户端都该先被拦下。
 *   · **并发冲突 ⇒ `error{code: CONFLICT}` 事件**：`02` §4.5、§5.2、`03` §五、以及 `06`
 *     P0-1-26 的验收原文（"同会话并发发送第二次得 `error{code:CONFLICT}`"）**四处**都写的是
 *     流内 `error`，且 `03` §五 给了它一个具体 UI（错误 toast + **消息流内错误卡** + 释放输入区）。
 *     它的**主语是"这一轮对话"**：客户端已经发起了对话，被拒的是这一次生成 ⇒ 前端按
 *     **单一渲染路径**在对话区收口。（实现见 `orchestrator/sse.ts#writeSseErrorReply`；
 *     单看"未 hijack"会误判成信封 —— 这里刻意按契约的语义词性分流。）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 两个字段刻意可为 `null`（本批的契约增量，不是"还没填"）
 * ─────────────────────────────────────────────────────────────────────
 * `done.messageId` 与 `done.usage` 都是**可空**的：
 *   · `messageId: null` = **这一轮没有产生可持久化的消息**（停止时一个字都没生成、
 *     或上游压根没吐过任何增量）。给它编一个假 id 会让前端认为"历史里有这条"，
 *     刷新后却查不到 —— 那比 `null` 难查得多（`02` §5.2"事件即真相"要求事件不许说谎）。
 *   · `usage: null` = 这次没有上游调用（如上游不给 usage，或本轮没走到 LLM）。
 */

import { z } from 'zod'

import { citationItemSchema } from './conversation.js'
import { ERROR_CODES } from './errors.js'

// ───────────────────────────── 事件名与取值域 ─────────────────────────────

/**
 * 事件全集（`02` §5.1 的表逐行对应，**顺序即文档顺序**）。
 *
 * `ping` 与 `done`/`error` 由 SSE 出口层自己产生（心跳 / 收尾），其余由编排层产生；
 * 但两者用**同一套名字与形状**，前端不必区分来源。
 */
export const SSE_EVENT_NAMES = [
  /** 助手回答文本增量 */
  'delta',
  /** 思考过程增量（可折叠渲染） */
  'thinking',
  /** 工具调用卡片（同一 callId 多次推送 = 状态机流转） */
  'tool_call',
  /** elicitation：弹确认卡，流挂起等 `/confirm` */
  'confirm',
  /** 本轮知识库引用 */
  'citations',
  /** TaskAgent 产出文件 */
  'artifact',
  /** 沙箱并发满，排队中 */
  'queued',
  /** 心跳（空闲期保活；前端静默忽略） */
  'ping',
  /** 流结束 */
  'done',
  /** 错误（流终止） */
  'error',
] as const
export type SseEventName = (typeof SSE_EVENT_NAMES)[number]

/** 流结束原因（`02` §5.1 的 `done.finishReason`）；`ERROR` 当前无产生路径，见文件头 ③ */
export const CHAT_FINISH_REASONS = ['COMPLETE', 'STOPPED', 'ERROR'] as const
export type ChatFinishReason = (typeof CHAT_FINISH_REASONS)[number]

/** 工具来源（`02` §5.1 的 `tool_call.kind`）：ChatBot 的 MCP 工具 / TaskAgent 的沙箱工具 */
export const TOOL_CALL_KINDS = ['MCP', 'SANDBOX'] as const
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number]

/** 工具调用状态机（`RUNNING` → `SUCCESS` / `ERROR`） */
export const TOOL_CALL_STATUSES = ['RUNNING', 'SUCCESS', 'ERROR'] as const
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number]

/** SSE 响应的 Content-Type（含 charset —— 中文增量必须明确编码，否则有的客户端按 latin-1 解） */
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8'

// ───────────────────────────── 10 个事件的 payload ─────────────────────────────

/** `delta`：助手回答文本增量 */
export const sseDeltaPayloadSchema = z.object({ text: z.string() })
export type SseDeltaPayload = z.infer<typeof sseDeltaPayloadSchema>

/** `thinking`：思考过程增量（`reasoning_content` / `reasoning` 两种上游写法的归一化结果，见 `llm/client.ts`） */
export const sseThinkingPayloadSchema = z.object({ text: z.string() })
export type SseThinkingPayload = z.infer<typeof sseThinkingPayloadSchema>

/**
 * `tool_call`：工具卡片。
 *
 * `output` 可省：`RUNNING` 时还没有结果。`inputSummary` 是**摘要**（完整入参留在库里/由历史接口给），
 * 因为这是要画在卡片上的一行字（`01` 决策 17「名称 + 参数摘要 + 状态」）。
 */
export const sseToolCallPayloadSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  /** MCP server 名（`kind=MCP` 时有值，展示"工具来自哪个系统"） */
  serverName: z.string(),
  kind: z.enum(TOOL_CALL_KINDS),
  status: z.enum(TOOL_CALL_STATUSES),
  inputSummary: z.string(),
  output: z.string().optional(),
})
export type SseToolCallPayload = z.infer<typeof sseToolCallPayloadSchema>

/** `confirm`：等待用户确认（P0 只有确认/取消二元语义，不做自由输入表单，`02` §六 第 4 步） */
export const sseConfirmPayloadSchema = z.object({
  confirmId: z.string().min(1),
  toolName: z.string().min(1),
  inputSummary: z.string(),
})
export type SseConfirmPayload = z.infer<typeof sseConfirmPayloadSchema>

/**
 * `citations`：本轮知识库引用（文档名 + 片段原文 + 分数；`01` 决策 12）。
 *
 * ⚠️ `items[]` 的形状来自 `conversation.ts#citationItemSchema`（**只定义一次**）：
 * 同一个引用卡既由本事件现画、又由 `messages.content.citations` 在刷新后重画，
 * 两处各写一份会让"流里看到的卡"与"历史恢复出来的卡"悄悄分叉（`03` §五 的单一渲染路径）。
 */
export const sseCitationsPayloadSchema = z.object({
  items: z.array(citationItemSchema),
})
export type SseCitationsPayload = z.infer<typeof sseCitationsPayloadSchema>

/** `artifact`：TaskAgent 产出文件（P0-3 才产生；形状先定下来，前端映射表不必等） */
export const sseArtifactPayloadSchema = z.object({
  artifactId: z.string().min(1),
  fileName: z.string(),
  size: z.number().int().min(0),
  mime: z.string(),
})
export type SseArtifactPayload = z.infer<typeof sseArtifactPayloadSchema>

/** `queued`：沙箱并发满时的排队位次（**1 = 下一个**，与 `conversationActiveSnapshotSchema` 同口径） */
export const sseQueuedPayloadSchema = z.object({ position: z.number().int().min(1) })
export type SseQueuedPayload = z.infer<typeof sseQueuedPayloadSchema>

/**
 * `ping`：心跳。
 *
 * `ts` 用 **ISO 8601 字符串**（与本仓其余时间字段同口径）：`02` §5.1 只写了 `{ts}`，
 * 本批定为 ISO 串 —— 前端静默忽略它，但排查"流是不是活着"时人能直接读。
 */
export const ssePingPayloadSchema = z.object({ ts: z.string() })
export type SsePingPayload = z.infer<typeof ssePingPayloadSchema>

/** `done`：流结束。`messageId` 与 `usage` 可空的理由见文件头 ④ */
export const sseDonePayloadSchema = z.object({
  /** `null` = 这一轮没有产生可持久化的消息 */
  messageId: z.string().nullable(),
  finishReason: z.enum(CHAT_FINISH_REASONS),
  /** `null` = 本轮没有上游调用（或上游不给 usage）；两个 token 数各自也可空 */
  usage: z
    .object({
      tokensIn: z.number().int().min(0).nullable(),
      tokensOut: z.number().int().min(0).nullable(),
    })
    .nullable(),
})
export type SseDonePayload = z.infer<typeof sseDonePayloadSchema>

/**
 * `error`：流终止。
 *
 * `code` **必须是 `shared/src/errors.ts` 的错误码**（不是 HTTP 状态码）：前端的文案映射层
 * 按它取文案（`03` §六），自由字符串会让"该给用户看什么"变成每个页面各自决定。
 */
export const sseErrorPayloadSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
})
export type SseErrorPayload = z.infer<typeof sseErrorPayloadSchema>

// ───────────────────────────── 事件 → payload 查表 ─────────────────────────────

/**
 * 事件名 → payload schema。
 *
 * 存在的意义有两个，都不是"省几行 if"：
 * ① SSE 出口在**每一帧写出之前**用它校验 payload（见 `orchestrator/sse.ts` 的 `emit`）——
 *    形状不对的事件会以 `error` 收尾并留下 zod 明细，而不是把一帧畸形数据发给前端
 *    （前端按事件名分派渲染，形状不对是在**渲染层**炸，比在后端报出来难查得多）；
 * ② 它是"事件全集"的自检点：键集合必须与 {@link SSE_EVENT_NAMES} 逐字相等
 *    （`verify:app` 有断言守着，新增事件忘了补 schema 会立刻红）。
 */
export const SSE_PAYLOAD_SCHEMAS = {
  delta: sseDeltaPayloadSchema,
  thinking: sseThinkingPayloadSchema,
  tool_call: sseToolCallPayloadSchema,
  confirm: sseConfirmPayloadSchema,
  citations: sseCitationsPayloadSchema,
  artifact: sseArtifactPayloadSchema,
  queued: sseQueuedPayloadSchema,
  ping: ssePingPayloadSchema,
  done: sseDonePayloadSchema,
  error: sseErrorPayloadSchema,
} as const

/** 各事件的 payload 类型（按事件名索引） */
export type SsePayloadByName = { [K in SseEventName]: z.infer<(typeof SSE_PAYLOAD_SCHEMAS)[K]> }

/**
 * 一个事件（判别联合：`name` 决定 `data` 的类型）。
 *
 * 编排层与出口层之间的唯一交换形态 —— 于是 `emit({ name: 'delta', data: { text } })` 里
 * 事件名与 payload 不可能对不上（写错在 `tsc` 阶段就报）。
 */
export type SseEvent = { [K in SseEventName]: { name: K; data: SsePayloadByName[K] } }[SseEventName]

// ───────────────────────────── 请求体 ─────────────────────────────

/**
 * 单条用户消息的长度上限（**字符**，按码点算）。
 *
 * 上限取值刻意宽松（远离任何真实输入）：它不是"限制用户打字"，而是让"超大请求"**可被拒绝**。
 * 没有上限时，超长内容会以"上游 400 / 超 context"的形式失败 —— 用户只看到一句听不懂的英文。
 * 真正的边界是模型上下文窗口（`model.maxContext`），历史截断与超长处理属 P0-1-27。
 */
export const MAX_CHAT_CONTENT_CHARS = 20_000

/**
 * `POST /api/conversations/:id/chat` 请求体（`02` §五 开头：`{ content, attachmentFileIds?[] }`）。
 *
 * ⚠️ `attachmentFileIds` **刻意在本批不可用**：附件要落 `files` 表，而它属 **P1**
 * （`01` §3.4 的"文件附件 P1"），表还不存在。这里的处置与 P0-1-23 对 MCP 引用的处置同款 ——
 * **明确拒绝并指向版本**，而不是"先收下、以后再用"：
 *   · 收下不用 ⇒ 用户以为附件生效了（界面上传成功、回答里却没有图），而且没有任何报错能提示他；
 *   · 明确 400 ⇒ 调用方立刻知道"这个版本还不支持"。
 * 用 `.max(0, …)` 而不是"不给这个字段"的原因：**字段级路径**（错误落在
 * `data.fields[].path = body.attachmentFileIds`，前端能高亮到那个上传按钮），
 * 而 `.refine()` 的失败 path 是空串、只能挂到表单级（P0-1-23 的教训）。
 * P1 的接回点：把 `.max(0, …)` 换成 `.max(附件上限, …)`，其余不变。
 */
export const chatRequestBodySchema = z.object({
  content: z
    .string({
      required_error: '请输入消息内容',
      invalid_type_error: '消息内容必须是字符串',
    })
    .trim()
    .min(1, '消息内容不能为空')
    .max(MAX_CHAT_CONTENT_CHARS, `单条消息最多 ${MAX_CHAT_CONTENT_CHARS} 个字符`),
  attachmentFileIds: z
    .array(z.string().uuid('附件 ID 不是合法 UUID'))
    .max(0, '附件上传属 P1（files 表尚未落地）；本版本请只发送文本')
    .optional(),
})
export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>

/**
 * `POST /api/conversations/:id/stop` 的响应。
 *
 * **幂等**：`signaled: false` = "当前没有正在生成的回答"，**不是错误**（`03` §4.1 的停止按钮
 * 只在流中出现，但"流刚好结束"的竞态必然存在 —— 把它做成 4xx 会让用户看到一个没有信息量的报错）。
 * `signaled: true` = 停止信号确实写给了**一个正在跑的流**。
 */
export const stopConversationResultSchema = z.object({
  id: z.string(),
  signaled: z.boolean(),
})
export type StopConversationResult = z.infer<typeof stopConversationResultSchema>
