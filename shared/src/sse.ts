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
 * （`01` 决策 5）。两者在**编排层**完成映射，中间层（SSE 出口）只认下面这 **11 个**事件 ——
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

import {
  artifactItemSchema,
  CHAT_ATTACHMENT_MAX_COUNT,
  citationItemSchema,
  toolCallRecordSchema,
} from './conversation.js'
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
  /** 本轮生命周期中间态（沙箱就绪 / 引擎启动 / 引擎就绪…；TaskAgent 专属） */
  'status',
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

/**
 * 工具来源与状态机（`02` §5.1 的 `tool_call.kind` / `.status`）。
 *
 * ⚠️ **P0-2-8 起它们的家在 `conversation.ts`**（那里是**落库**形态：`messages.content.tool_calls[]`）
 * —— 同一套取值域现在同时出现在"落库"与"事件"两处，各写一份字面量必然有一处先腐烂。
 * 本文件**刻意不在这里再导出一次**（`shared/src/index.ts` 是 `export *`，同一名字从两个模块
 * 星导出会让它在包根变成"歧义名"）⇒ 调用方一律从包根 `import { TOOL_CALL_STATUSES } from '@doubulea/shared'`，
 * 一个字都不用改。
 */

/** SSE 响应的 Content-Type（含 charset —— 中文增量必须明确编码，否则有的客户端按 latin-1 解） */
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8'

// ───────────────────────────── 11 个事件的 payload ─────────────────────────────

/** `delta`：助手回答文本增量 */
export const sseDeltaPayloadSchema = z.object({ text: z.string() })
export type SseDeltaPayload = z.infer<typeof sseDeltaPayloadSchema>

/** `thinking`：思考过程增量（`reasoning_content` / `reasoning` 两种上游写法的归一化结果，见 `llm/client.ts`） */
export const sseThinkingPayloadSchema = z.object({ text: z.string() })
export type SseThinkingPayload = z.infer<typeof sseThinkingPayloadSchema>

/**
 * `tool_call`：工具卡片（同一 `callId` 多次推送 = 状态机流转）。
 *
 * ⚠️ **由 `conversation.ts#toolCallRecordSchema` 派生（P0-2-8）**，只去掉 `arguments`：
 * 那张卡有**两个来源**（本事件、刷新后从 `messages.content.tool_calls` 恢复），
 * 派生保证"加字段忘了同步"在结构上不可能（同 `conversationActiveSchema` 的手法）。
 * `output` 可省（`RUNNING` 时还没有结果）；`inputSummary` 是**摘要**（完整入参只在库里），
 * 因为这是要画在卡片上的一行字（`01` 决策 17「名称 + 参数摘要 + 状态」）。
 * `errorCode` 也是可省的 —— `02` §9.3 要的"『去配置』跳转"需要一个**结构化**信号（人话里认不出来）。
 */
export const sseToolCallPayloadSchema = toolCallRecordSchema.omit({ arguments: true })
export type SseToolCallPayload = z.infer<typeof sseToolCallPayloadSchema>

/**
 * 确认请求的**来源**（P0-2-10；`02` §9.10）。
 *
 * 两件不同的事必须收进**同一个** `confirm` 事件（前端只有一种确认卡形态）：
 *   · `PLATFORM` —— **平台强制**的确认：工具被判为危险（`mcp/risk.ts`，判定表见 `02` §9.9）
 *     ⇒ 在**编排层**发起，不依赖 server 主动请求（`01` 决策 22）；
 *   · `SERVER` —— MCP server 在 `tools/call` 途中反向发起的 `elicitation/create`
 *     （应答方是 `mcp/client.ts` 注册的 handler，见其文件头判据 5）。
 *
 * ⚠️ 判据是"**谁在问**"，不是"问了什么"：两者的 payload 形状、挂起原语、应答端点完全一致
 * （都走 `POST /:id/confirm` 的确认/取消二元语义），差异只在**前端那句说明文案**上
 * —— 所以它是一个**判别字段**，而不是两个事件。
 */
export const CONFIRM_SOURCES = ['PLATFORM', 'SERVER'] as const
export type ConfirmSource = (typeof CONFIRM_SOURCES)[number]

/**
 * `confirm`：等待用户确认（P0 只有确认/取消二元语义，不做自由输入表单，`02` §六 第 4 步）。
 *
 * ⚠️ **P0-2-10 的契约增量**：多了 `source` 与 `expiresAt` 两个键（原先只有三个）。
 *   · `source` 见 {@link CONFIRM_SOURCES}：前端据此选说明文案（"工具需要确认" / "对方要求确认"）；
 *   · `expiresAt` 是**服务端**这次等待的截止时刻（ISO 8601，= 发起时刻 + `MCP_CONFIRM_TIMEOUT_SEC`）。
 *     为什么由服务端给：`03` §4.1 的"120s 倒计时"**是服务端超时在前端的投影** ——
 *     让前端自己另起一个 120s，两边只要有一点点差（网络、时钟、重连）就会变成
 *     "界面说还没到、服务端已按取消处理"，而用户看到的是"我点了确认但什么都没发生"
 *     （`06` P0-2-11 坑预判 3）。有了绝对时刻，重连之后也能算对剩余时间。
 *
 * ⚠️ **`toolName` 的含义随 `source` 变**：`PLATFORM` 时是**下发给模型的那个工具名**
 * （`mcp_{slug}_{tool}`，与 `tool_call` 卡一致）；`SERVER` 时是**正在执行的那个工具**
 * （elicitation 发生在它的 `tools/call` 途中）—— 所以两处都不为空，前端不必分支。
 */
export const sseConfirmPayloadSchema = z.object({
  confirmId: z.string().min(1),
  source: z.enum(CONFIRM_SOURCES),
  toolName: z.string().min(1),
  inputSummary: z.string(),
  /** 服务端等待的截止时刻（ISO 8601）—— 前端倒计时**只**读它，不自己另起一个 120s */
  expiresAt: z.string(),
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

/**
 * `artifact`：TaskAgent 产出文件。
 *
 * ⚠️ **P0-3-7 起由 `conversation.ts#artifactItemSchema` 派生**（原先是一份独立的内联
 * schema —— P0-1 预留时还没有"落库段"这回事）。派生而不是两份的理由与 `tool_call`
 * 完全同款：这张卡有**两个来源**（本事件、刷新后从 `messages.content.artifacts` 恢复），
 * 各写一份会让"流里看到的卡"与"历史恢复出来的卡"悄悄分叉。
 */
export const sseArtifactPayloadSchema = artifactItemSchema
export type SseArtifactPayload = z.infer<typeof sseArtifactPayloadSchema>

/** `queued`：沙箱并发满时的排队位次（**1 = 下一个**，与 `conversationActiveSnapshotSchema` 同口径） */
export const sseQueuedPayloadSchema = z.object({ position: z.number().int().min(1) })
export type SseQueuedPayload = z.infer<typeof sseQueuedPayloadSchema>

/**
 * `status`：本轮生命周期的**中间态**（P0-3-13；TaskAgent 专属 —— ChatBot 恒不发）。
 *
 * 解决的问题：TaskAgent 一轮的"无输出期"很长（建沙箱 → 起引擎 → 跑任务，首字可能几十秒），
 * 没有它用户只能看到"正在等待上游响应…"的占位，分不清到底在干什么、是不是卡了。
 * 编排层在**每个阶段切换点**发一条，前端把它显示成助手消息里的一行小字；
 * 一旦真实内容（`delta` / `thinking` / `tool_call`）到达，归约层就会清掉它 ——
 * 状态行只是"还没内容时"的进度指示，不追求跟真实内容同时存在。
 *
 * ⚠️ 它是**进度语**不是数据：不落库（`done` 时整条落库只含正文/工具/引用/产物）、
 * 不参与断线重连（`/active` 快照有自己的 `queuedPosition` / `currentTool`），
 * 断了重连靠历史补齐，历史里没有这条中间态是**刻意的**。
 */
export const sseStatusPayloadSchema = z.object({ text: z.string() })
export type SseStatusPayload = z.infer<typeof sseStatusPayloadSchema>

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
  status: sseStatusPayloadSchema,
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
 * `attachmentFileIds` 是**本轮附件**（P1-4）：先走 `POST /api/files/upload` 拿到 `fileId`，
 * 发消息时把 id 列表带上；服务端按归属解析、按类型决定"多模态直读 / 文本解析注入"。
 *   · **上限 = `CHAT_ATTACHMENT_MAX_COUNT`**（前后端同源）：它是字段级校验
 *     （错误落在 `data.fields[].path = body.attachmentFileIds`），前端能高亮到上传区；
 *   · **只收 id 不复传文件**：正文（base64 / 解析文本）由服务端按 id 现取，客户端无从伪造内容。
 */
export const chatRequestBodySchema = z.object({
  content: z
    .string({
      required_error: '请输入消息内容',
      invalid_type_error: '消息内容必须是文本',
    })
    .trim()
    .min(1, '消息内容不能为空')
    .max(MAX_CHAT_CONTENT_CHARS, `单条消息最多 ${MAX_CHAT_CONTENT_CHARS} 个字符`),
  /**
   * 本轮**指定使用的模型**（模型池特性）。**可省**：省略时走该会话所属智能体的默认模型
   * （`agents.model_id`）。给了就必须是该智能体**模型池的成员**且当前可用 ——
   * 服务层（`assertConversationSendable`）负责校验归属与可用性，非成员/已停用一律 409，
   * 不存在 404。这样"对话时选具体模型"不必新建会话，也不会绕过智能体的模型白名单。
   */
  modelId: z.string().uuid('模型 ID 不是合法 UUID').optional(),
  attachmentFileIds: z
    .array(z.string().uuid('附件 ID 不是合法 UUID'))
    .max(CHAT_ATTACHMENT_MAX_COUNT, `一次最多携带 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件`)
    .optional(),
})
export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>

/**
 * `POST /api/conversations/:id/regenerate` 请求体（**P1-3 重新生成**；`01` §3.4 / 决策 27）。
 *
 * 需求原文是"重跑**最后一轮用户消息**，替换原回答，原回答丢弃，**不产生重复消息**"。
 * 由此推出两条契约口径：
 *   · **不收 `content`**：正文取自库里最后一条 `USER` 消息 —— 让客户端传正文就等于允许它
 *     把这一轮改写成任意内容，那是"修改重发"（已有入口）而不是"重新生成"；
 *   · 只有一个可选项 `modelId`（与 `/chat` 同一套语义：省略走该智能体默认模型，给了就必须
 *     是它的模型池成员）。它让"换个模型重跑一遍"成为可能，而这正是重新生成最常见的用法。
 *
 * ⚠️ **它不是 `chatRequestBodySchema` 的变体**：那个 schema 的必填 `content` 在这里恰恰是
 * 不该存在的东西。两者只在"`modelId` 的可选语义"上相同，硬合并成一个会让"要不要正文"
 * 变成一个随字段有无而变的隐式判据。
 */
export const regenerateConversationBodySchema = z.object({
  modelId: z.string().uuid('模型 ID 不是合法 UUID').optional(),
})
export type RegenerateConversationBody = z.infer<typeof regenerateConversationBodySchema>

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

// ───────────────────────────── 中途插话（steer，P1-9 · P4 · R1）─────────────────────────────

/**
 * 一条「中途插话」的长度上限 —— **与用户消息同一个上限**（{@link MAX_CHAT_CONTENT_CHARS}）。
 *
 * 为什么复用而不是另取一个数：steer 与 `prompt` 最终都变成**同一条发给模型的用户消息**
 * （pi `docs/rpc-commands.md#steer`：投递到助手 turn 边界，与下一条 prompt 同族），
 * 两处各写一个上限必然先腐烂一处（`docs/06` §六 第 ⑰ 条）。
 */
export const STEER_MESSAGE_MAX_CHARS = MAX_CHAT_CONTENT_CHARS

/**
 * `POST /api/conversations/:id/steer` 请求体（**P1-9 · P4 · R1**）—— 向**运行中**的 agent 插一句话。
 *
 * 「用户改了 path（vN），请重读后再继续」是本端点的典型内容（人机共享工作区的主动感知），
 * 但契约本身**不含任何工作区字段**：它就是一句普通文本，由后端在助手 turn 边界投给引擎
 * （pi RPC `steer`，pin `0.87.1` 已复核 —— 见 `docs/子方案/Code模式工作区.md` §十五）。
 */
export const steerConversationBodySchema = z.object({
  message: z
    .string({
      required_error: '请输入插话内容',
      invalid_type_error: '插话内容必须是文本',
    })
    .trim()
    .min(1, '插话内容不能为空')
    .max(STEER_MESSAGE_MAX_CHARS, `插话内容最多 ${STEER_MESSAGE_MAX_CHARS} 个字符`),
})
export type SteerConversationBody = z.infer<typeof steerConversationBodySchema>

/**
 * `POST /api/conversations/:id/steer` 的响应。
 *
 * **幂等**（与 `/stop` 同款）：`accepted:false` = "当前没有正在生成的回答"（流刚好结束的竞态码必然存在），
 * **不是错误** —— 做成 4xx 只会让用户看到一条没有信息量的报错。
 * `accepted:true` = 这条插话确实写给了**一个正在跑的流**（它会在下一个助手 turn 边界读到）。
 */
export const steerConversationResultSchema = z.object({
  id: z.string(),
  accepted: z.boolean(),
})
export type SteerConversationResult = z.infer<typeof steerConversationResultSchema>

// ───────────────────────────── 确认应答（P0-2-10）─────────────────────────────

/**
 * `POST /api/conversations/:id/confirm` 的请求体（`02` §4.5 的表：`{confirmId, accepted}`）。
 *
 * ⚠️ **这个请求的全部结果都走 JSON 信封**（含"幂等忽略"的 `applied:false`），
 * **绝不**往那条 SSE 流里补帧：它是独立于流的一次普通请求，主语是"这一次答复"，
 * 而不是"这一轮生成"（`shared/src/sse.ts` 文件头 ③ 的两类失败口径）。
 *
 * `confirmId` 是 `confirm` 事件里那个 id —— **它存在的唯一理由是"答案是回答哪一个提问"**：
 * 一个会话的应答键只有一个槽位，没有它就无法区分"回答当前这个"与"上一轮的迟到点击"
 * （后者若被当成当前答案消费掉，症状是"**确认卡一闪而过**"，`06` P0-2-10 坑预判 2）。
 *
 * ⚠️ 刻意**不写 `.uuid()`**：id 的形态是**实现细节**（现在是 `randomUUID()` 的 v4），
 * 而这里要判的是"答的是不是这一个"，不是"它长得像不像 uuid"。用 `.min(1)` 只挡空值，
 * 其余交给服务端的**匹配**去判 —— 否则某天换了 id 生成方式，这一行会静默把所有应答变成 400。
 */
export const confirmRequestBodySchema = z.object({
  confirmId: z
    .string({
      required_error: '缺少 confirmId（应回传 confirm 事件里的那个值）',
      invalid_type_error: 'confirmId 必须是字符串',
    })
    .min(1, 'confirmId 不能为空'),
  accepted: z.boolean({
    required_error: '缺少 accepted（true = 确认执行，false = 取消）',
    invalid_type_error: 'accepted 必须是布尔值',
  }),
})
export type ConfirmRequestBody = z.infer<typeof confirmRequestBodySchema>

/**
 * 确认应答的结果。
 *
 * `applied` 是**这个端点的全部信息量**（其余三列是把请求原样回带，便于前端对账）：
 *   · `true` = 这个答复确实交给了**正在等待**的那一轮，工具会照此执行或跳过；
 *   · `false` = **幂等忽略**：那个提问已经不存在了（超时按取消处理完 / 已被答复过 /
 *     这一轮已经结束），所以什么都没发生。
 *
 * ⚠️ **`applied:false` 是 200 而不是 4xx** —— 与 `/stop` 的 `signaled:false`**同一条理由**：
 * "确认卡刚超时、用户此刻正好点了确认"这个竞态**必然存在**（`02` §5.2 的 120s 上限就是这么定的），
 * 而它是一条**正常的终局**（那一轮已经按取消走完了），不是用户的错误操作。
 * 把它做成 4xx，前端就会为一个用户无法处理、也无从理解的竞态弹一条红色报错。
 * ⇒ 拿不准的时候，用户应当看到的是"这次确认没生效、这一轮已按取消处理"，
 * 而不是"确认失败：请求与当前状态冲突"。
 *
 * ⚠️ **刻意没有 `status` 之类的会话状态回带**：调用方要状态就查 `/active`，
 * 这里多回一列等于给"会话状态"开第二个读取点（P0-1-21 的"同一份数据不许有第二种形状"）。
 */
export const confirmConversationResultSchema = z.object({
  id: z.string(),
  confirmId: z.string(),
  accepted: z.boolean(),
  applied: z.boolean(),
})
export type ConfirmConversationResult = z.infer<typeof confirmConversationResultSchema>
