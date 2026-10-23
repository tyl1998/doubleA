/**
 * `/open/v1` 的 OpenAPI 3.1 spec（**P1-22 · B4**；`docs/08` §9「契约的生产方式」）
 *
 * 依据：`docs/08` §9（`@fastify/swagger` → 只有 `/open/v1` 进 spec → CI 导出 `openapi/open-v1.json`
 *      → 文档站渲染该文件）+ §6.2/§6.3（端点与 scope 总表）+ `shared/src/openApi.ts`（契约）
 *      + `shared/src/sse.ts`（**SSE 事件全集不在本文件重抄**，只在 `POST …/chat` 的 description 里
 *        指向 `docs/07` 与 `shared/src/sse.ts` —— 一套协议只有一处定义）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么契约束在**一张表**上，而不是 `@fastify/swagger` 扫路由
 * ─────────────────────────────────────────────────────────────────────
 * 本仓的校验器是 **zod**（`plugins/errorHandler.ts` 的 `zodValidatorCompiler`），路由 schema 里
 * 放的是 zod 实例而不是 JSON Schema。`@fastify/swagger` 是**运行期扫描路由 schema** 的，
 * 它必须读到 JSON Schema —— 实测（装 `@fastify/swagger@9.9.2` 试过，已撤掉）：
 *   · 装成插件并注册后，`/api/**` 那些 zod schema 让它直接抛
 *     `Cannot read properties of null (reading 'examples')`（它把 zod 实例当 JSON Schema 遍历）；
 *     `/api/auth/*` 之类路由又必须排在它的 `onRoute` 钩子之后注册才"能装"——两者不可兼得；
 *   · 换成 `zod → JSON Schema` 派生就要再引一条链路（+ 字段映射的长期维护），且那条链路本身
 *     又需要 zod 的 `_def` 内部结构，升级即坏。
 * ⇒ **契约就是本文件的 {@link OPEN_ROUTE_DOCS}**（17 条，与 `docs/08` §6.2/§6.3 一一对应），
 *   由 `backend/scripts/export-openapi.ts` 写成入库的 `openapi/open-v1.json`。
 *
 * **反向的护栏**（比"生成器"更值得信）在 `backend/scripts/openapi-regression.ts` 的 A5/A6：
 *   · spec 里的路径集合 == Fastify 真实注册的 17 条业务端点（不多不少）；
 *   · 每条 operation 都有 `security` 与 `x-open-scope`；
 *   · 入库的 JSON 与重新导出结果逐字节一致（`pnpm openapi:check`）。
 * 于是"写了接口没写文档"与"写了文档没实现"**两侧**都会红。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 为什么 JSON Schema 写在这里而不是 zod 派生
 * ─────────────────────────────────────────────────────────────────────
 * `zod-to-json-schema` 不在依赖里，而引它会让"契约"多一条链路（zod → 生成 → 再读回来）。
 * 这里手写的是**开放层独有的那些形状**（请求体/分页/投影），并挂在 `OPEN_ROUTE_DOCS` 这张表上。
 * ⚠️ 改了 `shared/src/openApi.ts` 的字段 ⇒ 必须同步改这里（A5 会抓路由/spec 的**结构**漂移，
 *    字段级漂移靠 review；这是手写 spec 的已知成本，换掉 zod 派生的那条链路是刻意的取舍）。
 */

import {
  CHAT_ATTACHMENT_MAX_COUNT,
  MAX_CHAT_CONTENT_CHARS,
  OPEN_API_KEY_NAME_MAX,
  OPEN_MESSAGE_PARTS,
  OPEN_MESSAGES_PAGE_LIMIT_MAX,
  OPEN_API_MAX_CONCURRENCY_LIMIT,
  OPEN_API_RATE_LIMIT_PER_MIN_LIMIT,
  OPEN_API_SCOPES,
  OPEN_API_SCOPE_LABELS,
  type OpenApiScope,
} from '@doubulea/shared'

/** 每条开放端点的 spec 元数据（**表就是契约**：与 `docs/08` §6.2/§6.3 一一对应） */
export interface OpenRouteDoc {
  /** `get` / `post` / `delete` */
  method: 'get' | 'post' | 'delete'
  /** Fastify 路径（带 `:id` 占位） */
  path: string
  /** OpenAPI 路径（`/open/v1/conversations/{id}`） */
  openApiPath: string
  summary: string
  description?: string
  /** 所需 scope；`null` = 只要求 Key 有效（§6.3 的 `GET /agent`、`GET /usage`） */
  scope: OpenApiScope | null
  /** 该端点的 query/body/params JSON Schema（缺省 = 无请求体） */
  request?: Record<string, unknown>
  /** 成功响应的 JSON Schema（`data` 包裹前的实体）；SSE 端点留空 */
  response?: Record<string, unknown>
  /** 是否返回 SSE（`text/event-stream`） */
  sse?: boolean
}

// ───────────────────────────── 复用的 JSON Schema 片段 ─────────────────────────────

/** 可空字符串 */
const nullableString = { type: ['string', 'null'] } as const
/** 可空整数 */
const nullableInt = { type: ['integer', 'null'] } as const

/**
 * 错误信封（`docs/02` §四 / `shared/src/envelope.ts` 的 {@link Envelope}）。
 *
 * ⚠️ **不是** `{ok, data, error, requestId}` —— 本仓的信封是 **`{ code, msg, data }`**：
 *   · 成功 `code = 0`、`msg = "ok"`、`data` = 业务数据；
 *   · 失败 `code = <ErrorCode 字符串>`、`msg` = 可直接展示的中文、`data` 可为 `null` 或附加信息
 *     （如 `{ fields: [...] }` / `{ retryAfterSec }`）；
 *   · `requestId` 只在响应头 `x-request-id`（日志/工单对齐用），**不在体内**。
 * 这条曾经写错过一次（初版照"通用 REST 信封"写成了 `{ok,…}`，与实现不符 —— 实测 `/open/v1/agent`
 * 无 Key 时返回的是 `{"code":"UNAUTHORIZED","msg":"…","data":null}`）⇒ 以实现的契约为准。
 */
const ERROR_ENVELOPE = {
  type: 'object',
  required: ['code', 'msg', 'data'],
  properties: {
    code: {
      type: 'string',
      description:
        'UNAUTHORIZED（Key 缺失/形态非法/吊销/过期/账号停用，**同一句文案**）/ FORBIDDEN（缺 scope）/ NOT_OPENABLE（该智能体不开放：软删、非 CHATBOT、或无权限）/ NOT_FOUND / VALIDATION / CONFLICT / NEED_CREDENTIAL / BUSY（429）/ INTERNAL',
    },
    msg: { type: 'string', description: '可直接展示的中文文案（前端不再二次拼装）' },
    data: { description: '失败时可为 null，或附加信息（fields / retryAfterSec 等）' },
  },
} as const

/** 成功信封（`ok(data)`：`code = 0`、`msg = "ok"`） */
function successEnvelope(dataSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    required: ['code', 'msg', 'data'],
    properties: {
      code: { type: 'integer', const: 0, description: '成功恒为 0' },
      msg: { type: 'string', const: 'ok' },
      data: dataSchema,
    },
  }
}

/** 会话路径参数 */
const conversationParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid', description: '会话 id' } },
} as const

/** 模型项 */
const MODEL = {
  type: 'object',
  required: ['id', 'modelName', 'label', 'available', 'supportsVision'],
  properties: {
    id: { type: 'string' },
    modelName: { type: 'string' },
    label: { type: 'string' },
    available: { type: 'boolean', description: '池内且模型与 Provider 都启用；false 时选它会被 400/424' },
    supportsVision: { type: 'boolean' },
  },
} as const

/** 会话投影 */
const CONVERSATION = {
  type: 'object',
  required: ['id', 'agentId', 'title', 'status', 'readOnly', 'createdAt', 'lastMessageAt'],
  properties: {
    id: { type: 'string' },
    agentId: { type: 'string' },
    title: nullableString,
    status: { type: 'string', enum: ['ACTIVE', 'FINISHED'] },
    readOnly: { type: 'boolean', description: '= status !== ACTIVE；只读会话不能再发消息（409）' },
    createdAt: { type: 'string', format: 'date-time' },
    lastMessageAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const

/** 消息投影（`content` 是不透明结构：字符串或带 tool_calls/citations 的对象） */
const MESSAGE = {
  type: 'object',
  required: ['id', 'role', 'content', 'createdAt', 'tokensIn', 'tokensOut'],
  properties: {
    id: { type: 'string' },
    role: { type: 'string', enum: ['USER', 'ASSISTANT'] },
    content: {
      description:
        '形状由 `?parts=` 决定：`text`（默认）= 字符串（正文）；`full` = 富对象（含 tool_calls/citations/thinking_segments）；`timeline` = 字符串 + 同级 `parts[]`（拍平的时间线）',
    },
    createdAt: { type: 'string', format: 'date-time' },
    tokensIn: nullableInt,
    tokensOut: nullableInt,
  },
} as const

/** 时间线条目（`?parts=timeline`） */
const TIMELINE_PART = {
  type: 'object',
  required: ['type', 'text', 'seq', 'textOffset'],
  properties: {
    type: { type: 'string', enum: ['TEXT', 'THINKING', 'TOOL'] },
    text: { type: 'string', description: '正文片段 / 思考文字（`TOOL` 时为空串）' },
    seq: { type: ['integer', 'null'], description: '时间线序号（与 content 里 thinking_segments/tool_calls 的 seq 同序列）' },
    textOffset: { type: ['integer', 'null'], description: '正文里的字符偏移' },
    tool: {
      type: ['object', 'null'],
      description: '`type=TOOL` 时的工具卡（callId / toolName / serverName / kind / status / inputSummary / output / errorCode）',
    },
  },
} as const

/** 富消息（= 基础消息 + 按 `parts` 附加的 `parts[]` / `extras`） */
const RICH_MESSAGE = {
  type: 'object',
  required: ['id', 'role', 'content', 'createdAt', 'tokensIn', 'tokensOut'],
  properties: {
    ...MESSAGE.properties,
    parts: { type: 'array', items: TIMELINE_PART, description: '`parts=timeline` 时才有' },
    extras: {
      type: 'object',
      description: '`parts=full` 时才有：已翻译成对外名字的 thinkingSegments / citations / toolCalls / attachments',
    },
  },
} as const

const SCOPE_PROPERTY = {
  type: 'array',
  items: { type: 'string', enum: [...OPEN_API_SCOPES] },
  description: '本 Key 的作用域',
} as const

// ───────────────────────────── 表：17 条端点 ─────────────────────────────

/**
 * §6.2 的 17 条端点（顺序与 `docs/08` 一致；`backend/scripts/openapi-regression.ts` 的 A5
 * 用 `method + path` 与 Fastify 真实路由表**逐条**比对）。
 */
export const OPEN_ROUTE_DOCS: readonly OpenRouteDoc[] = [
  {
    method: 'get',
    path: '/open/v1/agent',
    openApiPath: '/open/v1/agent',
    summary: '我是谁：Key 绑定的智能体公开画像 + 能力 + 本 Key 限额',
    description:
      '客户端拿到 Key 的第一件事。**不含** `systemPrompt`（所属人的私有知识）与 `visibility`（内部概念）。' +
      '无 scope 要求（只要求 Key 有效）。',
    scope: null,
    response: {
      type: 'object',
      required: [
        'id',
        'name',
        'description',
        'type',
        'icon',
        'openingRemarks',
        'guideQuestions',
        'defaultModelId',
        'models',
        'capabilities',
        'limits',
      ],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: nullableString,
        type: { type: 'string', enum: ['CHATBOT', 'TASK_AGENT'], description: '本期只有 CHATBOT 可调' },
        icon: nullableString,
        openingRemarks: nullableString,
        guideQuestions: { type: 'array', items: { type: 'string' } },
        defaultModelId: nullableString,
        models: { type: 'array', items: MODEL },
        capabilities: {
          type: 'object',
          required: ['streaming', 'confirm', 'autoApprove', 'attachments', 'steer', 'regenerate'],
          properties: {
            streaming: { type: 'boolean' },
            confirm: { type: 'boolean' },
            autoApprove: { type: 'boolean', description: 'false = 本 Key 未获准开启自动审批（X7）' },
            attachments: { type: 'boolean' },
            steer: { type: 'boolean' },
            regenerate: { type: 'boolean' },
          },
        },
        limits: {
          type: 'object',
          required: ['maxConcurrency', 'rateLimitPerMin', 'confirmTimeoutSec', 'dailyTokenLimit'],
          properties: {
            maxConcurrency: { type: 'integer', minimum: 1 },
            rateLimitPerMin: { type: 'integer', minimum: 1 },
            confirmTimeoutSec: { type: 'integer', minimum: 1 },
            dailyTokenLimit: { type: 'integer', minimum: 0, description: '0 = 不限' },
          },
        },
      },
    },
  },
  {
    method: 'get',
    path: '/open/v1/agent/models',
    openApiPath: '/open/v1/agent/models',
    summary: '可选模型（池内）',
    scope: 'chat',
    response: {
      type: 'object',
      required: ['defaultModelId', 'items'],
      properties: { defaultModelId: nullableString, items: { type: 'array', items: MODEL } },
    },
  },
  {
    method: 'post',
    path: '/open/v1/conversations',
    openApiPath: '/open/v1/conversations',
    summary: '建会话',
    description:
      '只能落到 Key 绑定的那个智能体（**请求体没有 agentId**）。可选 `Idempotency-Key` 头（24h）：' +
      '同一把 Key 重放同一个值返回**第一次**建出来的会话。',
    scope: 'conversation:write',
    request: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 255 } },
    },
    response: CONVERSATION,
  },
  {
    method: 'get',
    path: '/open/v1/conversations',
    openApiPath: '/open/v1/conversations',
    summary: '我的会话列表（游标分页）',
    description:
      '列出（我 × 本 Key 的智能体）名下的会话 —— 同用户的多把 Key **共享同一批**（X5）。' +
      '排序 `lastMessageAt desc`；`cursor` = 上一页最后一条的 id。⚠️ 实现用"游标 → offset"换算，' +
      '跨页期间新会话可能造成重复/漏一条，客户端按 id 去重即可。',
    scope: 'conversation:read',
    request: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string' },
      },
    },
    response: {
      type: 'object',
      required: ['items', 'nextCursor', 'hasMore'],
      properties: {
        items: { type: 'array', items: CONVERSATION },
        nextCursor: nullableString,
        hasMore: { type: 'boolean' },
      },
    },
  },
  {
    method: 'get',
    path: '/open/v1/conversations/:id',
    openApiPath: '/open/v1/conversations/{id}',
    summary: '会话详情',
    scope: 'conversation:read',
    request: conversationParams,
    response: CONVERSATION,
  },
  {
    method: 'delete',
    path: '/open/v1/conversations/:id',
    openApiPath: '/open/v1/conversations/{id}',
    summary: '删除会话（级联消息）',
    scope: 'conversation:write',
    request: conversationParams,
    response: {
      type: 'object',
      required: ['id', 'deletedMessages'],
      properties: { id: { type: 'string' }, deletedMessages: { type: 'integer', minimum: 0 } },
    },
  },
  {
    method: 'get',
    path: '/open/v1/conversations/:id/messages',
    openApiPath: '/open/v1/conversations/{id}/messages',
    summary: '历史消息（行 id 游标，时间正序）',
    description:
      '`items` 是**时间正序**；`nextCursor` / `beforeId` 都指向**更早**那一页（唯一的翻页方向）。' +
      '`limit` 上限 500（不带 `beforeId` 时服务端内部按 100 分段聚合，返回最近的 N 条）。',
    scope: 'conversation:read',
    request: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        // 开放层的上限是 500（内部 100；服务端按 100 分段聚合，见 handler 注释）
        limit: { type: 'integer', minimum: 1, maximum: OPEN_MESSAGES_PAGE_LIMIT_MAX, default: 50 },
        beforeId: { type: 'string' },
        parts: {
          type: 'string',
          enum: [...OPEN_MESSAGE_PARTS],
          default: 'text',
          description:
            '段落裁剪：text（默认，只给正文，**丢工具卡/引用/思考**）/ full（富对象原样 + extras）/ timeline（正文 + 拍平的时间线 parts[]）',
        },
      },
    },
    response: {
      type: 'object',
      required: ['items', 'nextCursor', 'hasMore'],
      properties: {
        items: { type: 'array', items: RICH_MESSAGE },
        nextCursor: nullableString,
        hasMore: { type: 'boolean' },
      },
    },
  },
  {
    method: 'get',
    path: '/open/v1/conversations/:id/active',
    openApiPath: '/open/v1/conversations/{id}/active',
    summary: '断线恢复：在跑吗 / 排队第几 / 等谁确认',
    scope: 'conversation:read',
    request: conversationParams,
    response: {
      type: 'object',
      required: ['streaming', 'currentTool', 'startedAt', 'queuedPosition', 'pendingConfirmId', 'autoApprove', 'readOnly'],
      properties: {
        streaming: { type: 'boolean' },
        currentTool: nullableString,
        startedAt: { type: ['string', 'null'], format: 'date-time' },
        queuedPosition: nullableInt,
        pendingConfirmId: nullableString,
        autoApprove: { type: 'boolean' },
        readOnly: { type: 'boolean' },
      },
    },
  },
  {
    method: 'post',
    path: '/open/v1/conversations/:id/chat',
    openApiPath: '/open/v1/conversations/{id}/chat',
    summary: '发消息（SSE，粘性）',
    description:
      '返回 `text/event-stream`。事件全集、`confirm` 卡、`ping`、`done`/`error` 收尾、断线恢复流程' +
      '**逐字复用** `docs/07-第三方接入-会话确认(confirm)协议.md`（`shared/src/sse.ts`）。' +
      '前置失败（400/401/403/404/409/424/429）走 JSON 信封；并发冲突是**流内** `error{code:"CONFLICT"}`。' +
      '网关侧必须粘性（同一会话的 chat/regenerate/stream 落同一实例）。',
    scope: 'chat',
    request: {
      type: 'object',
      required: ['id', 'content'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        // 上限来自 `shared#MAX_CHAT_CONTENT_CHARS`（**不许在这里另写一个数**）
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_CHAT_CONTENT_CHARS,
          description: '单条消息正文（已 trim）',
        },
        modelId: { type: 'string', format: 'uuid', description: '不传 = 用智能体默认模型' },
        attachmentFileIds: {
          type: 'array',
          // 上限来自 `shared#CHAT_ATTACHMENT_MAX_COUNT`
          maxItems: CHAT_ATTACHMENT_MAX_COUNT,
          items: { type: 'string', format: 'uuid' },
          description: '先经 POST /open/v1/files 上传',
        },
      },
    },
    sse: true,
  },
  {
    method: 'get',
    path: '/open/v1/conversations/:id/stream',
    openApiPath: '/open/v1/conversations/{id}/stream',
    summary: '只读观察流（SSE，粘性）',
    description:
      '订阅这一轮的帧；迟到者**先回放**本轮已发的帧，整轮已结束则立刻收尾。心跳是注释行 `: ping`。' +
      '与 `POST …/chat` 是同一套事件（`docs/07`）。',
    scope: 'conversation:read',
    request: conversationParams,
    sse: true,
  },
  {
    method: 'post',
    path: '/open/v1/conversations/:id/regenerate',
    openApiPath: '/open/v1/conversations/{id}/regenerate',
    summary: '重新生成（SSE，粘性）',
    description: '撤掉上一轮 + 重跑同一段正文（正文取自库里，**不收**请求体）。',
    scope: 'chat',
    request: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        modelId: { type: 'string', format: 'uuid' },
      },
    },
    sse: true,
  },
  {
    method: 'post',
    path: '/open/v1/conversations/:id/stop',
    openApiPath: '/open/v1/conversations/{id}/stop',
    summary: '停止本轮（幂等）',
    description: '`signaled:false` = 当时没有在跑（**不是错误**）。',
    scope: 'chat',
    request: conversationParams,
    response: {
      type: 'object',
      required: ['id', 'signaled'],
      properties: { id: { type: 'string' }, signaled: { type: 'boolean' } },
    },
  },
  {
    method: 'post',
    path: '/open/v1/conversations/:id/steer',
    openApiPath: '/open/v1/conversations/{id}/steer',
    summary: '中途插话（幂等）',
    description: '`accepted:false` = 当时没有在跑（**不是错误**）。',
    scope: 'chat',
    request: {
      type: 'object',
      required: ['id', 'message'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        message: { type: 'string', minLength: 1 },
      },
    },
    response: {
      type: 'object',
      required: ['id', 'accepted', 'steerId'],
      properties: {
        id: { type: 'string' },
        accepted: { type: 'boolean' },
        steerId: nullableString,
      },
    },
  },
  {
    method: 'post',
    path: '/open/v1/conversations/:id/confirm',
    openApiPath: '/open/v1/conversations/{id}/confirm',
    summary: '快速确认（确认卡）',
    description:
      '`applied:false` = 没人在等这个 id（已超时/已处理/迟到点击）—— **正常终局，不要重试**（`docs/07` §3.2）。',
    scope: 'chat',
    request: {
      type: 'object',
      required: ['id', 'confirmId', 'accepted'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        confirmId: { type: 'string' },
        accepted: { type: 'boolean' },
      },
    },
    response: {
      type: 'object',
      required: ['id', 'confirmId', 'accepted', 'applied'],
      properties: {
        id: { type: 'string' },
        confirmId: { type: 'string' },
        accepted: { type: 'boolean' },
        applied: { type: 'boolean' },
      },
    },
  },
  {
    method: 'post',
    path: '/open/v1/conversations/:id/auto-approve',
    openApiPath: '/open/v1/conversations/{id}/auto-approve',
    summary: '会话级自动审批开关',
    description:
      '`enabled:true` 需要本 Key 的 `allowAutoApprove`（`GET /open/v1/agent` 的 `capabilities.autoApprove`），' +
      '否则 403 FORBIDDEN；`enabled:false` 永远允许（关掉危险模式不该被拒绝）。',
    scope: 'chat',
    request: {
      type: 'object',
      required: ['id', 'enabled'],
      properties: { id: { type: 'string', format: 'uuid' }, enabled: { type: 'boolean' } },
    },
    response: {
      type: 'object',
      required: ['id', 'autoApprove'],
      properties: { id: { type: 'string' }, autoApprove: { type: 'boolean' } },
    },
  },
  {
    method: 'post',
    path: '/open/v1/files',
    openApiPath: '/open/v1/files',
    summary: '上传附件（multipart，字段名 file）',
    description:
      '与内部上传同一套格式白名单 / MIME / 魔数 / 大小校验；上传主语 = Key 的归属用户 ⇒ 之后 ' +
      '`POST …/chat` 的 `attachmentFileIds` 归属校验天然通过。',
    scope: 'chat',
    request: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
    response: {
      type: 'object',
      required: ['id', 'name', 'mime', 'size', 'kind'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        mime: { type: 'string' },
        size: { type: 'integer', minimum: 0 },
        kind: { type: 'string', enum: ['IMAGE', 'DOCUMENT'] },
      },
    },
  },
  {
    method: 'get',
    path: '/open/v1/usage',
    openApiPath: '/open/v1/usage',
    summary: '本 Key 的用量与余量',
    description:
      '`dayTokens` 读 `usage_records`（`channel=OPEN_API` ∧ 本 Key，UTC 当日真账）；' +
      '`rateLimitRemaining` 读 Redis 当前分钟窗口；`dailyTokenLimit=0` ⇒ `dailyTokenRemaining=null`（不限）。' +
      '无 scope 要求（只读自己的账）。',
    scope: null,
    response: {
      type: 'object',
      required: ['keyId', 'scopes', 'limits', 'usage'],
      properties: {
        keyId: { type: 'string' },
        scopes: SCOPE_PROPERTY,
        limits: {
          type: 'object',
          required: ['maxConcurrency', 'rateLimitPerMin', 'confirmTimeoutSec', 'dailyTokenLimit'],
          properties: {
            maxConcurrency: { type: 'integer' },
            rateLimitPerMin: { type: 'integer' },
            confirmTimeoutSec: { type: 'integer' },
            dailyTokenLimit: { type: 'integer' },
          },
        },
        usage: {
          type: 'object',
          required: [
            'day',
            'dayTokens',
            'dayTokensUnknown',
            'dailyTokenLimit',
            'dailyTokenRemaining',
            'rateLimitRemaining',
          ],
          properties: {
            day: { type: 'string', description: 'UTC 日期 YYYY-MM-DD' },
            dayTokens: { type: 'integer', minimum: 0 },
            dayTokensUnknown: { type: 'integer', minimum: 0, description: '上游没上报 token 的轮次数（不计入）' },
            dailyTokenLimit: { type: 'integer', minimum: 0 },
            dailyTokenRemaining: { type: ['integer', 'null'], minimum: 0 },
            rateLimitRemaining: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
]

// ───────────────────────────── spec 组装 ─────────────────────────────

/** `operationId` 的主体（无方法后缀）：去掉 `/open/v1/`、`{id}` 与分隔符后转驼峰 */
function operationBaseNameOf(doc: OpenRouteDoc): string {
  const segments = doc.openApiPath.replace('/open/v1/', '').split('/')
  // ⚠️ **列表**与**详情**必须可区分：`GET /conversations`（列表）与 `GET /conversations/{id}`（详情）
  //    去掉 `{id}` 后同名 ⇒ 后者在末尾补 `Item`（`conversationsItemGet` vs `conversationsGet`）。
  const tail = segments.at(-1) === '{id}' ? ['Item'] : []
  return [...segments, ...tail]
    .filter((segment) => segment !== '' && segment !== '{id}')
    .flatMap((segment) => segment.replace(/[^a-zA-Z0-9]+/gu, ' ').split(' '))
    .filter((segment) => segment !== '')
    .map((segment, index) => (index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
    .join('')
}

/**
 * 稳定的 `operationId`（客户端 SDK 生成用）：`GET /open/v1/conversations/{id}/messages`
 * ⇒ `conversationsMessages`；同路径不同方法要**不同** id ⇒ 末尾加方法名（`conversationsCreate` 等）。
 *
 * 规则刻意简单（去掉 `{id}`、去分隔符、首词驼峰）：稳定比好看更重要 —— 客户端的 SDK 在升级
 * 时靠它对上"这是同一个方法"。
 */
export function operationIdOf(doc: OpenRouteDoc): string {
  const camel = operationBaseNameOf(doc)
  // **确定性**规则（不依赖"谁先出现"）：`operationId` = 主体 + 方法后缀，**总是**带后缀。
  // 于是同一主体的任何两条操作都不同（`conversationsGet` / `conversationsCreate` /
  // `conversationsDelete`），而不同主体天然不同 —— 不需要再判断"撞没撞"。
  // ⚠️ 试过三种"只在必要时加"的规则，各有一个反例（`GET /conversations` vs `GET /conversations/{id}`、
  //    以及"谁先出现"依赖）⇒ 统一加后缀是唯一稳定的写法，代价只是 id 长一点。
  return `${camel}${METHOD_SUFFIX[doc.method]}`
}

/**
 * 方法后缀：同一路径上的不同方法**必须**得到不同 `operationId`。
 *
 * ⚠️ 不能只给 post 加后缀：`/conversations/{id}` 的 GET（详情）与 DELETE 去掉 `{id}` 后都变成
 * `conversations`，会撞成同一个 id（实测：17 条只产出 16 个唯一 id）。所以后缀是**按方法固定映射**，
 * 而"同一路径上的多个 POST"（`/conversations/{id}/{chat|stop|…}`）靠各自的末段区分，不会再撞。
 */
const METHOD_SUFFIX: Readonly<Record<OpenRouteDoc['method'], string>> = {
  get: 'Get',
  post: 'Create',
  delete: 'Delete',
}

/**
 * 生成 OpenAPI 3.1 文档（**只含 `/open/v1`**）。
 *
 * 三条与 `docs/08` §9 对齐的做法：
 *   · 全局 `security: [{ bearerAuth: [] }]` + 每条 operation 的 `x-open-scope`（`null` 表示只要 Key 有效）；
 *   · 每条 operation 都有 `400/401/403/404/409/424/429/500` 里**实际可能**的那几个 responses；
 *   · `servers` 用相对地址（`/`）：客户拿到 spec 后按自己部署的域名拼，不写死 host。
 */
export function buildOpenV1Spec(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const doc of OPEN_ROUTE_DOCS) {
    const operation: Record<string, unknown> = {
      operationId: operationIdOf(doc),
      summary: doc.summary,
      ...(doc.description === undefined ? {} : { description: doc.description }),
      tags: [doc.scope === null ? 'agent' : doc.scope.split(':')[0]],
      security: [{ bearerAuth: [] }],
      'x-open-scope': doc.scope ?? '',
      parameters: specParametersOf(doc),
      responses: responsesOf(doc),
    }
    if (doc.request !== undefined && doc.method !== 'get' && doc.method !== 'delete' && doc.sse !== true) {
      operation.requestBody = requestBodyOf(doc)
    }
    paths[doc.openApiPath] = { ...(paths[doc.openApiPath] ?? {}), [doc.method]: operation }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Doubulea 开放平台 · 智能体 OpenAPI',
      version: 'v1',
      description:
        '用「我的凭据」里签发的 API Key（`Authorization: Bearer oak_…`）调用**你本人**名下的智能体。\n\n' +
        '- 凭据 = 「我 × 某个智能体」：会话出现在**你**的会话列表中，其他用户看不到也影响不到。\n' +
        '- 本期只对 **ChatBot** 开放；`TASK_AGENT` ⇒ 403 `NOT_OPENABLE`。\n' +
        '- SSE 协议（事件全集、`confirm` 卡、`ping`、`done`/`error`、断线恢复）见 `docs/07`。\n' +
        '- 失败语义只有三类：401（Key 问题）/ 403（授权问题）/ 429（额度问题）；依赖故障是 500。\n' +
        '- 统一信封 `{code, msg, data}`：成功 `code = 0`、`msg = "ok"`；失败 `code` 是错误码字符串。\n' +
        '- 请求 id 在响应头 `x-request-id`（与平台内部日志可对齐）。',
    },
    servers: [{ url: '/', description: '当前部署（相对地址；按实际域名拼）' }],
    tags: [
      { name: 'agent', description: '我是谁 / 能力 / 用量' },
      { name: 'conversation', description: '会话、消息与对话动作（含 SSE）' },
      { name: 'chat', description: '发消息 / 停止 / 插话 / 确认 / 自动审批 / 附件' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: `API Key 明文（\`oak_\` 前缀）。也可用 \`X-API-Key\` 头。作用域：${OPEN_API_SCOPES.map(
            (scope) => `\`${scope}\`（${OPEN_API_SCOPE_LABELS[scope]}）`,
          ).join('；')}。`,
        },
      },
      schemas: {
        ErrorEnvelope: ERROR_ENVELOPE,
      },
    },
    paths,
  }
}

/** POST 的请求体：把 `properties` 里**不在路径参数中**的字段挑出来（`id` 这类路径参数不进 body） */
function requestBodyOf(doc: OpenRouteDoc): Record<string, unknown> {
  const schema = (doc.request ?? {}) as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  const properties: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (doc.openApiPath.includes(`{${name}}`)) continue
    properties[name] = property
  }
  const required = (schema.required ?? []).filter((name) => properties[name] !== undefined)
  const isMultipart = doc.path === '/open/v1/files'
  return {
    required: true,
    content: isMultipart
      ? { 'multipart/form-data': { schema: { type: 'object', required, properties } } }
      : {
          'application/json': {
            schema: { type: 'object', ...(required.length === 0 ? {} : { required }), properties },
          },
        },
  }
}

/** 响应：SSE 端点只声明 `200 text/event-stream`；其余声明 JSON 成功 + 错误信封 */
function responsesOf(doc: OpenRouteDoc): Record<string, unknown> {
  if (doc.sse === true) {
    return {
      '200': {
        description:
          'SSE 流。帧格式与事件全集见 `docs/07`（`shared/src/sse.ts`）。**鉴权/授权失败走 JSON 信封（在首帧之前）**。',
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
      '401': errorResponse('API Key 无效或已失效'),
      '403': errorResponse('缺 scope（FORBIDDEN）或该智能体不开放（NOT_OPENABLE）'),
      '404': errorResponse('会话不存在（含"不是你的会话"/"不属于这个智能体"）'),
      '409': errorResponse('会话只读 / 同一会话正在跑'),
      '424': errorResponse('模型所需凭据未配置（NEED_CREDENTIAL）'),
      '429': errorResponse('超出并发 / 每分钟 / 日 token（BUSY，含 retryAfterSec）', true),
      '500': errorResponse('依赖故障（Redis / DB / 上游）'),
    }
  }
  return {
    '200': {
      description: '成功（`ok(data)` 信封）',
      content: { 'application/json': { schema: successEnvelope(doc.response ?? {}) } },
    },
    ...(doc.method === 'get' || doc.method === 'delete'
      ? {}
      : { '400': errorResponse('参数校验失败（VALIDATION，含 fields）') }),
    '401': errorResponse('API Key 无效或已失效'),
    '403': errorResponse('缺 scope（FORBIDDEN）或该智能体不开放（NOT_OPENABLE）'),
    '404': errorResponse('资源不存在（含不属于你 / 不属于这个智能体）'),
    '429': errorResponse('超出并发 / 每分钟 / 日 token（BUSY，含 retryAfterSec）', true),
  }
}

/** 参数：路径参数 + query（zod 的 `path`/`query` 已合并进 `request` 里，这里按位置拆开） */
function specParametersOf(doc: OpenRouteDoc): Record<string, unknown>[] {
  const schema = doc.request
  if (schema === undefined) return []
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema['required'] as string[] | undefined) ?? [])
  const out: Record<string, unknown>[] = []
  for (const [name, property] of Object.entries(properties)) {
    // 路径里出现的 `{name}` ⇒ 路径参数；其余在 GET/DELETE 上是 query、在 POST 上是 body 的字段
    if (doc.openApiPath.includes(`{${name}}`)) {
      out.push({
        name,
        in: 'path',
        required: true,
        schema: property,
      })
      continue
    }
    if (doc.method === 'get') {
      out.push({
        name,
        in: 'query',
        required: required.has(name),
        schema: property,
      })
    }
  }
  return out
}

/** 错误响应（引用 `ErrorEnvelope`，header 里带 `Retry-After` 时才加） */
function errorResponse(description: string, withRetryAfter = false): Record<string, unknown> {
  return {
    description,
    ...(withRetryAfter
      ? { headers: { 'Retry-After': { description: '多久之后可以再试（秒）', schema: { type: 'integer' } } } }
      : {}),
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  }
}

/** 限额常量（spec 的 description 里提到的天花板；脚本用它断言"文档写的上限 = 常量"） */
export const OPEN_API_LIMITS_IN_SPEC = {
  nameMax: OPEN_API_KEY_NAME_MAX,
  maxConcurrency: OPEN_API_MAX_CONCURRENCY_LIMIT,
  rateLimitPerMin: OPEN_API_RATE_LIMIT_PER_MIN_LIMIT,
} as const
