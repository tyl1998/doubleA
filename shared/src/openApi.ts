/**
 * 开放平台契约（**P1-22**；`docs/08-开放平台-智能体OpenAPI(APIKey).md`）
 *
 * 这个文件同时服务**两条互不相干的链路**，务必分清：
 *
 * | 用途 | 路径 | 鉴权 | 投影 |
 * |------|------|------|------|
 * | **外部调用** | `/open/v1/**` | `Authorization: Bearer oak_…` | `openAgent*` / `openConversation*` / … |
 * | **内部管理** | `/api/open-keys`（**我的**,2026-10-22 定） | Cookie 会话 | `openApiKeyItemSchema` 等 |
 *
 * ⚠️ 管理面**按人**而不是按智能体（2026-10-22 用户定案）：Key 的主语是「人 × 智能体」，
 * 挂在智能体编辑页会让人以为"给这个智能体开了 Key ⇒ 所有人都能用"。所以入口在**我的凭据**，
 * 列表/吊销是 `/api/open-keys…`（"我的"），**签发时**用请求体里的 `agentId` 指定关联哪个智能体。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① Key 的归属是 `(userId, agentId)`，不是"一把 Key 一个虚拟账号"（Q1）
 * ─────────────────────────────────────────────────────────────────────
 * 会话的 `user_id` 就是**签发 Key 的真人** ⇒ 开放层调的是内部同一批 service
 * （`conversation.service.ts` 的判据"这一行是不是你的"原样生效），结构性增量只有一张
 * `open_api_keys` 表 + 一层薄路由。同一用户在同一智能体下的**多把 Key 共享会话池**（X5）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 明文只出现一次：`createOpenApiKeyResultSchema` 是唯一带 `plaintext` 的投影
 * ─────────────────────────────────────────────────────────────────────
 * 库里只有 `sha256(明文)`（不可逆）。创建响应里的 `plaintext` **不会**出现在任何列表/详情里 ——
 * 丢了只能吊销重签。`keyPrefix`（`oak_` + 8 字符）与 `keySuffix`（尾 4 位）是给人眼对日志用的。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ scope 是**闭集**，且与端点一一对应（§6.3）
 * ─────────────────────────────────────────────────────────────────────
 * | scope | 覆盖 |
 * |-------|------|
 * | `chat` | chat / regenerate / stop / steer / confirm / auto-approve / files / agent/models |
 * | `conversation:read` | 会话列表/详情/消息/active/stream |
 * | `conversation:write` | 建 / 删会话 |
 *
 * 缺 scope ⇒ 403 `FORBIDDEN`；智能体不可开放 ⇒ 403 `NOT_OPENABLE`（X4）。两者刻意分开：
 * 前者是"换一把 Key / 改 scope"，后者是"这个智能体本来就不对外"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ SSE 契约**不在本文件**：逐字复用 `shared/src/sse.ts`（`docs/07` 即对外协议页）
 * ─────────────────────────────────────────────────────────────────────
 * 事件全集、`confirm` 卡、`ping`、`done`/`error` 收尾规则全部照旧 —— 开放层只是"另一个出口"，
 * 不是另一套协议。本文件只定义 `/open/v1` 自己的 **JSON** 请求/响应投影。
 */

import { z } from 'zod'

import { AGENT_TYPES } from './agent.js'
import { CHAT_ATTACHMENT_MAX_COUNT, CONVERSATION_RUN_ORIGINS, CONVERSATION_STATUSES } from './conversation.js'
import { cursorPageOf } from './envelope.js'
import type { MessageKey } from './i18n/index.js'
import { validationMessage } from './i18n/validation.js'
import { MAX_CHAT_CONTENT_CHARS } from './sse.js'

// ═════════════════════════════ 常量与判据 ═════════════════════════════

/** Key 前缀（`open api key`）。凡是 `oak_` 开头的字符串都能被日志/扫描器识别出来脱敏 */
export const OPEN_API_KEY_PREFIX = 'oak_'

/** 明文里随机段的长度（**base62 字符数**）—— 32 字节随机 ≈ 43 字符，本处取 32 已足够 */
export const OPEN_API_KEY_SECRET_LENGTH = 32

/** `keyPrefix` 的列宽（`oak_` + 8） */
export const OPEN_API_KEY_PREFIX_DISPLAY_LENGTH = 8

/** Key 名称长度上限（与 `open_api_keys.name VARCHAR(64)` 同源） */
export const OPEN_API_KEY_NAME_MAX = 64

/** 作用域（见文件头 ③） */
export const OPEN_API_SCOPES = ['chat', 'conversation:read', 'conversation:write'] as const
export type OpenApiScope = (typeof OPEN_API_SCOPES)[number]

/** scope → 中文名（界面与错误文案共用一份） */
export const OPEN_API_SCOPE_LABELS: Readonly<Record<OpenApiScope, string>> = {
  chat: '对话（发消息/停止/插话/确认/附件）',
  'conversation:read': '读会话（列表/详情/历史/观察流）',
  'conversation:write': '写会话（新建/删除）',
}

/**
 * 作用域 → i18n key（P1-23：前端据此取译文）。
 * ⚠️ 中文那份 {@link OPEN_API_SCOPE_LABELS} **保留**：后端 `openV1Spec.ts` 仍在消费（OpenAPI 文档）。
 */
export const OPEN_API_SCOPE_KEY: Readonly<Record<OpenApiScope, MessageKey>> = {
  chat: 'label.openApiScope.chat',
  'conversation:read': 'label.openApiScope.conversationRead',
  'conversation:write': 'label.openApiScope.conversationWrite',
}

/** 界面预设：默认全选；"只读"只给 `conversation:read` */
export const OPEN_API_SCOPE_PRESETS = {
  full: OPEN_API_SCOPES,
  readonly: ['conversation:read'] as const,
} as const

/** Key 状态（**派生**，不落库）—— 列表里显示"有效 / 过期 / 已吊销" */
export const OPEN_API_KEY_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const
export type OpenApiKeyStatus = (typeof OPEN_API_KEY_STATUSES)[number]

/**
 * 从列值派生状态。**过期优先于吊销**：两者都发生时，先碰到哪一个都不改变"用不了"的结论，
 * 但界面上"已过期"比"已吊销"更接近用户此刻看到的现象（他自己没点过吊销）。
 */
export function openApiKeyStatusOf(
  input: { revokedAt: Date | string | null; expiresAt: Date | string | null },
  now: Date = new Date(),
): OpenApiKeyStatus {
  if (input.expiresAt !== null && new Date(input.expiresAt).getTime() <= now.getTime()) return 'EXPIRED'
  if (input.revokedAt !== null) return 'REVOKED'
  return 'ACTIVE'
}

/** 是否**此刻可用**（校验链第 ④a 步的纯判据：与 `status === 'ACTIVE'` 完全等价） */
export function openApiKeyUsable(
  input: { revokedAt: Date | string | null; expiresAt: Date | string | null },
  now: Date = new Date(),
): boolean {
  return openApiKeyStatusOf(input, now) === 'ACTIVE'
}

/** 开放层的速率/并发/确认超时上限（Key 可覆盖，但都有天花板；`null` = 用全局默认） */
export const OPEN_API_MAX_CONCURRENCY_LIMIT = 20
export const OPEN_API_RATE_LIMIT_PER_MIN_LIMIT = 6000
export const OPEN_API_CONFIRM_TIMEOUT_SEC_LIMIT = 3600

/** `usage_records.channel` 的取值域（X1；字符串而非 enum —— 分区表加 enum 在多环境迁移里更易卡住） */
export const USAGE_CHANNELS = ['INTERNAL', 'OPEN_API'] as const
export type UsageChannel = (typeof USAGE_CHANNELS)[number]

// ═════════════════════════════ 内部管理（`/api/agents/:id/open-keys`）═════════════════════════════

/**
 * 一把 Key 的**元数据投影**（列表 / 详情；**永不含明文**）。
 *
 * `status` 是派生的：`ACTIVE` / `EXPIRED` / `REVOKED`（见 {@link openApiKeyStatusOf}）。
 * 限速四项原样回带（`null` = 用全局默认），界面据此显示"默认 2 并发 / 120 RPM / 不限日 token"。
 */
export const openApiKeyItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** 关联的智能体名（列表要显示"这把 Key 是给谁签的"；签发时由服务端回填，客户端不传） */
  agentName: z.string(),
  /** 智能体类型：非 `CHATBOT` 的 Key 签得出来但**调不通**（403 `NOT_OPENABLE`，Q9） */
  agentType: z.enum(AGENT_TYPES),
  /** Key 的归属用户（= 会话的 `user_id`）。ADMIN 代建时可能不是自己 */
  userId: z.string(),
  userName: z.string(),
  name: z.string(),
  /** 展示用前缀（`oak_xxxxxxxx`） */
  keyPrefix: z.string(),
  /** 尾 4 位，便于和人眼看到的日志对齐 */
  keySuffix: z.string(),
  scopes: z.array(z.enum(OPEN_API_SCOPES)),
  status: z.enum(OPEN_API_KEY_STATUSES),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  allowAutoApprove: z.boolean(),
  confirmTimeoutSec: z.number().int().positive().nullable(),
  maxConcurrency: z.number().int().positive().nullable(),
  rateLimitPerMin: z.number().int().positive().nullable(),
  /** `null` / `0` = 不限 */
  dailyTokenLimit: z.number().int().nonnegative().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export type OpenApiKeyItem = z.infer<typeof openApiKeyItemSchema>

/**
 * `GET /api/open-keys` 的响应（**我的全部 Key**，可按 `agentId` 过滤）。
 *
 * 不分页：一个人的 Key 是个位数量级，而"我到底给了谁什么"必须能一眼看全 —— 分页会让
 * "这个智能体是不是也有一把"变成一次翻页动作。
 */
export const listOpenApiKeysResultSchema = z.object({
  items: z.array(openApiKeyItemSchema),
})
export type ListOpenApiKeysResult = z.infer<typeof listOpenApiKeysResultSchema>

// ─── 签发与编辑**共用**的字段校验（文案与上限只有一处；两边各自 `.optional()`） ───

const openApiKeyNameField = z
  .string({ required_error: validationMessage('validation.openApi.keyNameRequired') })
  .trim()
  .min(1, validationMessage('validation.openApi.keyNameEmpty'))
  .max(OPEN_API_KEY_NAME_MAX, validationMessage('validation.openApi.keyNameTooLong', { max: OPEN_API_KEY_NAME_MAX }))

const openApiKeyScopesField = z
  .array(z.enum(OPEN_API_SCOPES))
  .min(1, validationMessage('validation.openApi.scopesRequired'))

const openApiKeyExpiresAtField = z
  .string()
  .datetime({ message: validationMessage('validation.openApi.expiresAtNotIso') })
  .nullable()

const openApiKeyConfirmTimeoutField = z
  .number()
  .int()
  .min(1)
  .max(OPEN_API_CONFIRM_TIMEOUT_SEC_LIMIT)
  .nullable()

const openApiKeyMaxConcurrencyField = z.number().int().min(1).max(OPEN_API_MAX_CONCURRENCY_LIMIT).nullable()

const openApiKeyRateLimitField = z.number().int().min(1).max(OPEN_API_RATE_LIMIT_PER_MIN_LIMIT).nullable()

const openApiKeyDailyTokenField = z.number().int().min(0).nullable()

/**
 * 签发请求体（`POST /api/open-keys`）。
 *
 * · `userId` 只有 **ADMIN 代建**时才需要（R2：Key 的归属记到目标用户头上；MEMBER 传了也忽略 ——
 *   服务层按"调用者本人"写，避免出现"给别人的账号发流量"的口子）；
 * · `expiresAt` 可省（Q12：`null` = 不过期，但界面默认建议填）；
 * · 四个数值项可省（`null`/缺省 = 用全局默认），都有天花板（见 `OPEN_API_*_LIMIT`）。
 */
export const createOpenApiKeyBodySchema = z.object({
  /**
   * 关联的智能体（**必填**，2026-10-22 起从路径挪到体里）：Key 的身份是「我 × 这个智能体」。
   * 服务端校验"我能看见它 ∧ 未软删"，否则 404（与资产族同口径，不泄漏存在性）。
   */
  agentId: z
    .string({ required_error: validationMessage('validation.openApi.agentRequired') })
    .uuid(validationMessage('validation.openApi.agentIdNotUuid')),
  name: openApiKeyNameField,
  scopes: openApiKeyScopesField.optional(),
  expiresAt: openApiKeyExpiresAtField.optional(),
  allowAutoApprove: z.boolean().optional(),
  confirmTimeoutSec: openApiKeyConfirmTimeoutField.optional(),
  maxConcurrency: openApiKeyMaxConcurrencyField.optional(),
  rateLimitPerMin: openApiKeyRateLimitField.optional(),
  dailyTokenLimit: openApiKeyDailyTokenField.optional(),
  /** **仅 ADMIN**：把 Key 记到另一个用户头上（R2） */
  userId: z.string().uuid(validationMessage('validation.openApi.userIdNotUuid')).optional(),
})
export type CreateOpenApiKeyBody = z.infer<typeof createOpenApiKeyBodySchema>

/**
 * 编辑请求体（`PUT /api/open-keys/:keyId`；2026-10-22 追加，用户定案：**元数据可编辑**）。
 *
 * · **合并语义**：缺省的字段保持原值（与 MCP 凭据的 `PUT` 同方向 —— 界面表单全量提交时两者等价，
 *   partial 客户端则不必先 GET 再拼）；
 * · **不可编辑的字段刻意不在 schema 里**：明文（库里只有 sha256，本来就不存在"改值"）、
 *   `agentId`（Key 身份的另一半 —— 换关联智能体等于换会话池，走"吊销 + 重签"）、
 *   `userId`（归属不转移；要把 Key 让给别人就重签一把）；
 * · `expiresAt: null` 显式表示"改为不过期"；非 null 必须是未来时刻（与签发同口径，
 *   把已过期的 Key 续到未来 = 重新启用，这是编辑的主要用途之一）；
 * · 已吊销的 Key 拒绝编辑（服务层 409）—— 吊销是终态，"反悔"只能重签。
 */
export const updateOpenApiKeyBodySchema = z.object({
  name: openApiKeyNameField.optional(),
  scopes: openApiKeyScopesField.optional(),
  expiresAt: openApiKeyExpiresAtField.optional(),
  allowAutoApprove: z.boolean().optional(),
  confirmTimeoutSec: openApiKeyConfirmTimeoutField.optional(),
  maxConcurrency: openApiKeyMaxConcurrencyField.optional(),
  rateLimitPerMin: openApiKeyRateLimitField.optional(),
  dailyTokenLimit: openApiKeyDailyTokenField.optional(),
})
export type UpdateOpenApiKeyBody = z.infer<typeof updateOpenApiKeyBodySchema>

/**
 * 签发响应 = 元数据 + **明文**（唯一一次）。
 *
 * ⚠️ 明文只在这里出现；客户端必须当场复制。界面用一次性弹窗 + 复制按钮承载它。
 */
export const createOpenApiKeyResultSchema = openApiKeyItemSchema.extend({
  plaintext: z.string(),
})
export type CreateOpenApiKeyResult = z.infer<typeof createOpenApiKeyResultSchema>

/** `DELETE /api/open-keys/:keyId` 的响应（**幂等**：重复吊销也回 `revoked:true`） */
export const revokeOpenApiKeyResultSchema = z.object({
  id: z.string(),
  revoked: z.boolean(),
})
export type RevokeOpenApiKeyResult = z.infer<typeof revokeOpenApiKeyResultSchema>

/** `GET /api/open-keys` 的查询参数：可只列某个智能体下的（"这个智能体我签过几把"） */
export const listOpenApiKeysQuerySchema = z.object({
  agentId: z.string().uuid(validationMessage('validation.openApi.agentIdNotUuid')).optional(),
  /** 是否把**已吊销 / 已过期**的也列出来（默认列 —— 界面要能看出"外部为什么进不来"） */
  includeInactive: z.coerce.boolean().default(true),
})
export type ListOpenApiKeysQuery = z.infer<typeof listOpenApiKeysQuerySchema>

/** 路径参数：`/api/open-keys/:keyId`（吊销） */
export const openApiKeyIdParamsSchema = z.object({
  keyId: z.string().uuid(validationMessage('validation.openApi.keyIdNotUuid')),
})
export type OpenApiKeyIdParams = z.infer<typeof openApiKeyIdParamsSchema>

// ═════════════════════════════ 外部：我是谁 / 模型 ═════════════════════════════

/** 智能体公开画像里的模型项（只含"池内且可用"的） */
export const openAgentModelSchema = z.object({
  id: z.string(),
  modelName: z.string(),
  label: z.string(),
  available: z.boolean(),
  supportsVision: z.boolean(),
})
export type OpenAgentModel = z.infer<typeof openAgentModelSchema>

/** 开放层的**能力表**：客户端据此决定要不要显示某个交互（与 scope 无关，是"这个智能体具备什么"） */
export const openAgentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  confirm: z.boolean(),
  autoApprove: z.boolean(),
  attachments: z.boolean(),
  steer: z.boolean(),
  regenerate: z.boolean(),
})
export type OpenAgentCapabilities = z.infer<typeof openAgentCapabilitiesSchema>

/** 本 Key 生效中的限额（Key 覆盖后的**实际值**，已把 `null` 换成全局默认） */
export const openAgentLimitsSchema = z.object({
  maxConcurrency: z.number().int().positive(),
  rateLimitPerMin: z.number().int().positive(),
  confirmTimeoutSec: z.number().int().positive(),
  /** `0` = 不限 */
  dailyTokenLimit: z.number().int().nonnegative(),
})
export type OpenAgentLimits = z.infer<typeof openAgentLimitsSchema>

/**
 * `GET /open/v1/agent` 的响应：Key 绑定的智能体**公开画像** + 能力 + 本 Key 的限额。
 *
 * 刻意**不含** `systemPrompt`（它是所属人的私有知识，不是对外契约的一部分）与 `visibility`。
 */
export const openAgentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(AGENT_TYPES),
  icon: z.string().nullable(),
  openingRemarks: z.string().nullable(),
  guideQuestions: z.array(z.string()),
  defaultModelId: z.string().nullable(),
  models: z.array(openAgentModelSchema),
  capabilities: openAgentCapabilitiesSchema,
  limits: openAgentLimitsSchema,
})
export type OpenAgentProfile = z.infer<typeof openAgentProfileSchema>

/** `GET /open/v1/agent/models` 的响应 */
export const openAgentModelsResultSchema = z.object({
  /** 默认模型（不指定 `modelId` 时走它）；未绑定 ⇒ `null` */
  defaultModelId: z.string().nullable(),
  items: z.array(openAgentModelSchema),
})
export type OpenAgentModelsResult = z.infer<typeof openAgentModelsResultSchema>

// ═════════════════════════════ 外部：会话 ═════════════════════════════

/**
 * 一条会话（开放层投影）。
 *
 * 与内部 `ConversationItem` 的差别只有三条，且都不是新数据：
 *   · 去掉 `agentName` / `agentType` / `runtime` / `updatedAt`（Key 已经绑死了 Agent，会话又只对
 *     ChatBot 开放 ⇒ 这三个字段恒为同一个值，发给客户端只是噪音）；
 *   · 加 `readOnly`（= `status !== 'ACTIVE'`，见 `isConversationReadOnly`）—— 客户端**不该**自己
 *     比较 `status` 字面量，判据只有一处；
 *   · `title` 即内部的 `topic`（对外开放用更通用的词）。
 */
export const openConversationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  status: z.enum(CONVERSATION_STATUSES),
  readOnly: z.boolean(),
  createdAt: z.string(),
  lastMessageAt: z.string().nullable(),
})
export type OpenConversation = z.infer<typeof openConversationSchema>

/**
 * 建会话请求体（Q11：**必须先建会话再发消息**）。
 *
 * `title` 可省 —— 内部口径是"首条消息落库时自动命名"（`persist.ts#deriveConversationTopic`），
 * 外部给一个标题只是提前定名（等价于建完再 `PATCH`，但省一次往返）。
 * ⚠️ 建会话**只能**落到 Key 绑定的那个 Agent 上，请求体里**刻意没有** `agentId`。
 */
export const openCreateConversationBodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, validationMessage('validation.openApi.titleEmpty'))
    .max(255, validationMessage('validation.openApi.titleTooLong', { max: 255 }))
    .optional(),
})
export type OpenCreateConversationBody = z.infer<typeof openCreateConversationBodySchema>

/** `GET /open/v1/conversations` 的查询参数（**游标**分页：会话在变，offset 会漂） */
export const openListConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** 上一页最后一条的 id；省略 = 第一页 */
  cursor: z.string().optional(),
})
export type OpenListConversationsQuery = z.infer<typeof openListConversationsQuerySchema>

/** 会话列表响应（游标分页；`nextCursor === null` = 到底了） */
export const openConversationListResultSchema = cursorPageOf(openConversationSchema)
export type OpenConversationListResult = z.infer<typeof openConversationListResultSchema>

/** 路径参数：`/open/v1/conversations/:id` */
export const openConversationIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.openApi.conversationIdNotUuid')),
})
export type OpenConversationIdParams = z.infer<typeof openConversationIdParamsSchema>

/** `DELETE /open/v1/conversations/:id` 的响应 */
export const openRemoveConversationResultSchema = z.object({
  id: z.string(),
  deletedMessages: z.number().int().nonnegative(),
})
export type OpenRemoveConversationResult = z.infer<typeof openRemoveConversationResultSchema>

/**
 * 一条消息（开放层投影）—— 字段与内部 `MessageItem` **逐字一致**。
 *
 * ⚠️ `content` 的**形状取决于 `?parts=`**（见 {@link OPEN_MESSAGE_PARTS}）：
 *   · `parts=text`（默认）⇒ **字符串**（= 内部 `content.text`），工具卡/引用/思考**不在这**；
 *   · `parts=full`   ⇒ **富对象**（内部 `messageContentSchema` 原样，卡片与引用都在里面）；
 *   · `parts=timeline` ⇒ **字符串**（同 `text`）+ 同级 `parts[]`（拍平的时间线，卡片在里面）。
 * 所以这里用 `z.unknown()`：同一个字段在三种模式下是三种形状，钉死一种就等于说谎。
 */
export const openMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['USER', 'ASSISTANT']),
  content: z.unknown(),
  createdAt: z.string(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
})
export type OpenMessage = z.infer<typeof openMessageSchema>

/**
 * `messages` 的**段落裁剪**（`?parts=`，2026-10-22；为第三方代理的"历史还原"而加）。
 *
 * 背景：内部 `content` 是 `{ text, thinking_segments?, citations?, tool_calls?, attachments?, steers?, model? }`
 * 的**富对象**（`conversation.ts#messageContentSchema`）。第三方的"历史"通常只想要一段文本，
 * 但**工具卡片 / 引用 / 思考就在其它键里** —— 只取 `content.text` 会把它们丢掉。
 *
 * | 取值 | `items[].content` |
 * |------|-------------------|
 * | `text`（**默认**） | **字符串**（= `content.text`）。最省事，**丢卡片** |
 * | `full` | **富对象原样**（与平台前端看到的完全一致；键见 `messageContentSchema`） |
 * | `timeline` | **字符串** + 同级 `parts[]`：正文片段 / 思考段 / 工具卡按同一时间线（`seq`、`textOffset`）拍平 |
 *
 * ⚠️ 默认仍是 `text`：不传 `parts` 的调用**行为不变**（新增可选参数，不是破坏性变更）。
 */
export const OPEN_MESSAGE_PARTS = ['text', 'full', 'timeline'] as const
export type OpenMessageParts = (typeof OPEN_MESSAGE_PARTS)[number]

/** 时间线条目里工具卡的部分（`parts=timeline` 时的 `TOOL` 条目） */
export const openMessageTimelineToolSchema = z.object({
  callId: z.string(),
  /** 下发给模型的名字（`mcp_{slug}_{tool}`） */
  toolName: z.string(),
  serverName: z.string(),
  kind: z.enum(['MCP', 'SANDBOX', 'BUILTIN']),
  status: z.enum(['RUNNING', 'SUCCESS', 'ERROR']),
  /** 已抹敏的参数摘要（≤200 字符，可能被截断） */
  inputSummary: z.string(),
  output: z.string().nullable(),
  /** 失败时的错误码（不是 HTTP 状态码）；成功为 null */
  errorCode: z.string().nullable(),
})
export type OpenMessageTimelineTool = z.infer<typeof openMessageTimelineToolSchema>

/** 一条"流内条目"（`parts=timeline`）；正文 / 思考 / 工具卡共用同一序列 */
export const openMessageTimelinePartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('TEXT'),
    /** 连续正文片段（相邻正文会合并，减少条目数） */
    text: z.string(),
    textOffset: z.number().int().nonnegative().nullable(),
    seq: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal('THINKING'),
    text: z.string(),
    textOffset: z.number().int().nonnegative().nullable(),
    /** 思考段序号（一次模型推理 = 一段） */
    seq: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal('TOOL'),
    text: z.literal(''),
    textOffset: z.number().int().nonnegative().nullable(),
    seq: z.number().int().nonnegative().nullable(),
    /** 工具卡（`type: "TOOL"` 时恒非空） */
    tool: openMessageTimelineToolSchema,
  }),
])
export type OpenMessageTimelinePart = z.infer<typeof openMessageTimelinePartSchema>

/**
 * `parts=full` 时**额外**给的结构化段（`content` 里已有原始键；这两个是"已翻译成对外名字"的副本，
 * 便于不想解析内部键名的客户端）。
 *
 * 刻意**不重复** `text`（它在 `content` 里）、也不给 `steers` / `model`（第三方用不上）。
 */
export const openMessageFullExtrasSchema = z.object({
  thinkingSegments: z.array(
    z.object({ text: z.string(), seq: z.number().int().nonnegative(), textOffset: z.number().int().nonnegative() }),
  ),
  citations: z.array(z.object({ docName: z.string(), snippet: z.string(), score: z.number() })),
  toolCalls: z.array(openMessageTimelineToolSchema),
  attachments: z.array(
    z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number().int().nonnegative() }),
  ),
})
export type OpenMessageFullExtras = z.infer<typeof openMessageFullExtrasSchema>

/** 消息的**富投影**：在基础消息上，按 `parts` 多带 `parts[]` 或 `extras`（不需要时两者都不出现） */
export const openMessageRichSchema = openMessageSchema.extend({
  /** `parts=timeline` 时才有 */
  parts: z.array(openMessageTimelinePartSchema).optional(),
  /** `parts=full` 时才有 */
  extras: openMessageFullExtrasSchema.optional(),
})
export type OpenMessageRich = z.infer<typeof openMessageRichSchema>

/**
 * `GET /open/v1/conversations/:id/messages` 的查询参数（与内部同为**行 id 游标**、正序返回）。
 *
 * ⚠️ **上限从 100 提到 500**（2026-10-22，为第三方代理的"一次拉全量历史"诉求）：
 * 之所以放开，是因为**分页方向是相反的** —— 我们的 `beforeId` 只能**向更早**翻，
 * 而"从最新往回翻到 500 条"必须让客户端反复回填并自己拼顺序；开放层为此在服务端
 * **内部按 100 一段循环拉满**，对外仍是一页。500 是硬的：超过这个量应该**分段**取。
 * 这是唯一一个"开放层比内部宽"的端点，理由写在 `routes/open/index.ts` 的 messages handler。
 */
export const OPEN_MESSAGES_PAGE_LIMIT_MAX = 500

export const openListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(OPEN_MESSAGES_PAGE_LIMIT_MAX).default(50),
  /** 上一页**第一条**的 id（= 更早那一页的边界）；省略 = 取最新的一段 */
  beforeId: z.string().optional(),
  /** 段落裁剪（见 {@link OPEN_MESSAGE_PARTS}）；默认 `text` = 只给正文，与旧版行为一致 */
  parts: z.enum(OPEN_MESSAGE_PARTS).default('text'),
})
export type OpenListMessagesQuery = z.infer<typeof openListMessagesQuerySchema>

/** 消息分页响应（`items` 时间正序；`nextCursor` 指向**更早**那一页） */
export const openMessagePageResultSchema = cursorPageOf(openMessageRichSchema)
export type OpenMessagePageResult = z.infer<typeof openMessagePageResultSchema>

/** 开放层暴露的发起方 = 内部同一份取值域（`shared/src/conversation.ts#CONVERSATION_RUN_ORIGINS`） */
export const openConversationRunOriginSchema = z.enum(CONVERSATION_RUN_ORIGINS)
export type OpenConversationRunOrigin = z.infer<typeof openConversationRunOriginSchema>

/**
 * `GET /open/v1/conversations/:id/active` —— 断线恢复的三个问题：
 * **在跑吗 / 排在第几 / 有没有在等我确认**（与内部 `/active` 同源，字段是我方需要的子集）。
 */
export const openConversationActiveSchema = z.object({
  streaming: z.boolean(),
  currentTool: z.string().nullable(),
  startedAt: z.string().nullable(),
  queuedPosition: z.number().int().min(1).nullable(),
  pendingConfirmId: z.string().nullable(),
  autoApprove: z.boolean(),
  readOnly: z.boolean(),
  /**
   * 这一轮的发起方（2026-10-22 契约增量，与内部 `/active` 的 `startedBy` 同源）：
   * `UI` 界面 / `OPEN_API` 开放层 / `SCHEDULED` 定时任务；`null` = 旧快照或来源不明。
   * 外部客户端据此区分"我自己刚发的这一轮"与"定时任务后台跑的那一轮"。
   */
  startedBy: openConversationRunOriginSchema.nullable(),
})
export type OpenConversationActive = z.infer<typeof openConversationActiveSchema>

// ═════════════════════════════ 外部：对话动作 ═════════════════════════════

/**
 * `POST /open/v1/conversations/:id/chat` 请求体。
 *
 * 与内部 `/api/conversations/:id/chat` **同形**（`docs/07` 是同一份协议页）：
 * `content` / 可选 `modelId` / 可选 `attachmentFileIds`。凭据不在 body 里（走 `Authorization`），
 * 会话也不在 body 里（在路径上）—— 于是"这条消息发给谁"没有任何可被构造的余地。
 */
export const openChatBodySchema = z.object({
  content: z
    .string({
      required_error: validationMessage('validation.openApi.contentRequired'),
      invalid_type_error: validationMessage('validation.openApi.contentNotText'),
    })
    .trim()
    .min(1, validationMessage('validation.openApi.contentEmpty'))
    .max(MAX_CHAT_CONTENT_CHARS, validationMessage('validation.openApi.contentTooLong', { max: MAX_CHAT_CONTENT_CHARS })),
  modelId: z.string().uuid(validationMessage('validation.openApi.modelIdNotUuid')).optional(),
  attachmentFileIds: z
    .array(z.string().uuid(validationMessage('validation.openApi.fileIdNotUuid')))
    .max(CHAT_ATTACHMENT_MAX_COUNT, validationMessage('validation.openApi.attachmentsTooMany', { max: CHAT_ATTACHMENT_MAX_COUNT }))
    .optional(),
})
export type OpenChatBody = z.infer<typeof openChatBodySchema>

/** `POST /open/v1/conversations/:id/regenerate` 请求体（与内部同口径：不收正文） */
export const openRegenerateBodySchema = z.object({
  modelId: z.string().uuid(validationMessage('validation.openApi.modelIdNotUuid')).optional(),
})
export type OpenRegenerateBody = z.infer<typeof openRegenerateBodySchema>

/** 停止 / 插话 / 确认 / 自动审批 的响应 —— 与内部同形（幂等结论，不是错误） */
export const openStopResultSchema = z.object({
  id: z.string(),
  signaled: z.boolean(),
})
export type OpenStopResult = z.infer<typeof openStopResultSchema>

export const openSteerBodySchema = z.object({
  message: z
    .string({ required_error: validationMessage('validation.openApi.steerRequired') })
    .trim()
    .min(1, validationMessage('validation.openApi.steerEmpty'))
    .max(MAX_CHAT_CONTENT_CHARS, validationMessage('validation.openApi.steerTooLong', { max: MAX_CHAT_CONTENT_CHARS })),
})
export type OpenSteerBody = z.infer<typeof openSteerBodySchema>

export const openSteerResultSchema = z.object({
  id: z.string(),
  accepted: z.boolean(),
  steerId: z.string().nullable(),
})
export type OpenSteerResult = z.infer<typeof openSteerResultSchema>

export const openConfirmBodySchema = z.object({
  confirmId: z
    .string({ required_error: validationMessage('validation.openApi.confirmIdMissing') })
    .min(1, validationMessage('validation.openApi.confirmIdEmpty')),
  accepted: z.boolean({ required_error: validationMessage('validation.openApi.acceptedMissing') }),
})
export type OpenConfirmBody = z.infer<typeof openConfirmBodySchema>

export const openConfirmResultSchema = z.object({
  id: z.string(),
  confirmId: z.string(),
  accepted: z.boolean(),
  /** `false` = 没人在等这个 id（已超时/已处理/迟到点击）—— **正常终局，不要重试** */
  applied: z.boolean(),
})
export type OpenConfirmResult = z.infer<typeof openConfirmResultSchema>

/**
 * `POST /open/v1/conversations/:id/auto-approve` 请求体（Q7）。
 *
 * ⚠️ `enabled: true` 需要本 Key 的 `allowAutoApprove=true`（X7 默认 true，但界面可以关掉）；
 * 关掉后本端点对该 Key 恒 403 `FORBIDDEN`（不是静默不生效 —— 那会让外部以为破坏性工具已经放行）。
 */
export const openSetAutoApproveBodySchema = z.object({
  enabled: z.boolean({ required_error: validationMessage('validation.openApi.enabledMissing') }),
})
export type OpenSetAutoApproveBody = z.infer<typeof openSetAutoApproveBodySchema>

export const openSetAutoApproveResultSchema = z.object({
  id: z.string(),
  autoApprove: z.boolean(),
})
export type OpenSetAutoApproveResult = z.infer<typeof openSetAutoApproveResultSchema>

/** `POST /open/v1/files` 的响应（multipart，字段名与内部同为 `file`） */
export const openUploadFileResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** `IMAGE` = 多模态直读；`DOCUMENT` = 文本解析后注入 */
  kind: z.enum(['IMAGE', 'DOCUMENT']),
})
export type OpenUploadFileResult = z.infer<typeof openUploadFileResultSchema>

// ═════════════════════════════ 外部：用量 ═════════════════════════════

/**
 * `GET /open/v1/usage` —— 本 Key 的用量与**余量**（自助看额度，§6.4 / X6）。
 *
 * `dayTokens` 是 `usage_records` 当日累计（`channel='OPEN_API' ∧ open_key_id = 本 Key`），
 * `dailyTokenLimit = 0` ⇒ `dailyTokenRemaining` 为 `null`（不限）。
 * `rateLimitRemaining` 是**当前分钟窗口**的剩余请求数（Redis 计数器），客户端可据此退避。
 */
export const openUsageResultSchema = z.object({
  keyId: z.string(),
  scopes: z.array(z.enum(OPEN_API_SCOPES)),
  limits: openAgentLimitsSchema,
  usage: z.object({
    /** UTC 当天（`YYYY-MM-DD`） */
    day: z.string(),
    dayTokens: z.number().int().nonnegative(),
    dayTokensUnknown: z.number().int().nonnegative(),
    dailyTokenLimit: z.number().int().nonnegative(),
    dailyTokenRemaining: z.number().int().nonnegative().nullable(),
    rateLimitRemaining: z.number().int().nonnegative(),
  }),
})
export type OpenUsageResult = z.infer<typeof openUsageResultSchema>
