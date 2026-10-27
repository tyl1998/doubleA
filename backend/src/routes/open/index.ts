/**
 * 开放平台对外路由（**P1-22**；`/open/v1/**`，17 条）
 *
 * 依据：`docs/08-开放平台-智能体OpenAPI(APIKey).md` §6（端点总表、scope、限速、示例）
 *      + `docs/07-第三方接入-会话确认(confirm)协议.md`（**就是本族的对外协议页**，SSE 语义逐字复用）
 *      + `shared/src/openApi.ts` / `shared/src/sse.ts`（契约，一处定义）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 本文件是**薄路由**：翻译 Key → userId，然后调**同一批**内部 service
 * ─────────────────────────────────────────────────────────────────────
 * 每一条 handler 的形状都是：`app.requireOpenApi(scope)` 校验 → 取上下文 →
 * 用 `{ id: context.userId }` 调内部函数 → 用 `shared#openApi` 的投影回包。
 * 于是"内部与外部看到的是同一份数据、同一套判据"（`docs/08` §2 的红利），
 * **不要**在这里写第二份归属判据：加重叠判据只有一处（`assertOpenConversation`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 17 条端点的 scope 归属（§6.3，逐条对应下面的路由）
 * ─────────────────────────────────────────────────────────────────────
 * ```
 * 无 scope（只要求 Key 有效）           GET  /agent 、GET /usage
 * chat（发消息 / 模型 / 停止 / 插话 / 确认 / 自动审批 / 附件）
 *                                     GET  /agent/models
 *                                     POST /conversations/:id/{chat,regenerate,stop,steer,confirm,auto-approve}
 *                                     POST /files
 * conversation:read                    GET  /conversations 、GET /conversations/:id 、/:id/messages 、
 *                                          /:id/active 、/:id/stream
 * conversation:write                   POST /conversations 、DELETE /conversations/:id
 * ```
 * ⚠️ `GET /agent` 与 `GET /usage` **不挂 scope**：前者是"我是谁"（客户端拿到 Key 的第一件事，
 * 连 scope 都还没法从别处知道），后者是"我的额度"（只读自己的账）。两者都不泄漏任何会话内容。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ SSE 的两条战线（§7）
 * ─────────────────────────────────────────────────────────────────────
 * · 前置失败（401/403/404/400/409/424/429）走 **JSON 信封**（在写出第一帧之前）；
 * · 并发冲突仍走**流内** `error{code:'CONFLICT'}`（主语是"这一轮"）—— 全部由
 *   `orchestrator/sse.ts#streamChatReply` 决定，本文件不重复实现。
 * 网关粘性由 `shared/src/router.ts#classifyRoute` 给（`/open/v1/conversations/:id/{chat,regenerate,stream}`）。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import { appMsg,
  AppError,
  openAgentModelsResultSchema,
  openAgentProfileSchema,
  openChatBodySchema,
  openConfirmBodySchema,
  openCreateConversationBodySchema,
  openListConversationsQuerySchema,
  openListMessagesQuerySchema,
  openRegenerateBodySchema,
  openSetAutoApproveBodySchema,
  openSteerBodySchema,
  openUploadFileResultSchema,
  openUsageResultSchema,
  UPLOAD_FILE_FIELD,
  type OpenChatBody,
  type OpenConfirmBody,
  type ConversationItem,
  type OpenConversationActive,
  type OpenConversationIdParams,
  type OpenConversationListResult,
  type OpenCreateConversationBody,
  type OpenListConversationsQuery,
  type OpenListMessagesQuery,
  type OpenMessagePageResult,
  type OpenRegenerateBody,
  type OpenSetAutoApproveBody,
  type OpenSteerBody,
  type SseEvent,
  type UserRole,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../../config.js'
import { getLogger } from '../../infra/logger.js'
import { getPrisma } from '../../infra/prisma.js'
import {
  ensureRedisConnected,
  openApiIdempotencyKey,
  OPEN_API_IDEMPOTENCY_TTL_SEC,
} from '../../infra/redis.js'
import { subscribeFrames } from '../../orchestrator/frameBus.js'
import { resolveChatProducer } from '../../orchestrator/index.js'
import {
  answerConfirm,
  serializeSseFrame,
  setAutoApprove,
  signalSteer,
  signalStop,
  SSE_RESPONSE_HEADERS,
  streamChatReply,
} from '../../orchestrator/sse.js'
import { openApiUtcDay } from '../../orchestrator/persist.js'
import {
  acquireOpenConcurrency,
  assertOpenConversation,
  readOpenApiDayTokens,
  readOpenApiRateLimitUsed,
  requireOpenApiContext,
  type OpenRequestContext,
} from '../../plugins/openAuth.js'
import type { ConversationViewer } from '../../services/conversation.service.js'
import {
  assertConversationRegenerable,
  assertConversationSendable,
  createConversation,
  getConversationActive,
  listConversationsForAgent,
  listMessages,
  recallLastRound,
  removeConversation,
  renameConversation,
} from '../../services/conversation.service.js'
import { uploadChatFile } from '../../services/file.service.js'
import { isOpenConversationReadOnly } from '../../services/openApiKey.service.js'
import { projectOpenMessage } from './messageParts.js'
import {
  decorateOpenResponse,
  openRoute,
  openViewer,
  openViewerRole,
  toOpenActive,
  toOpenConversation,
} from './shared.js'

// ───────────────────────────── 小工具 ─────────────────────────────

/** 取上下文（`requireOpenApi` 已保证非空；这里是类型收窄 + 兜底） */
function contextOf(request: FastifyRequest): OpenRequestContext {
  return requireOpenApiContext(request)
}

/** 每个 handler 都要的"调用者"（Key → userId + 真实角色；见 `shared.ts` 文件头 ②） */
async function viewerOf(request: FastifyRequest): Promise<{ userId: string; role: UserRole }> {
  const context = contextOf(request)
  return { userId: context.userId, role: await openViewerRole(context.userId) }
}

// ───────────────────────────── 注册 ─────────────────────────────

export function registerOpenApiRoutes(app: FastifyInstance): void {
  // ═══════════════ 我是谁 / 能力 ═══════════════

  /**
   * `GET /open/v1/agent` —— **我是谁**（§6.5 示例 ①）。无 scope。
   *
   * 返回 Key 绑定的智能体**公开画像** + 能力 + 本 Key 生效中的限额。刻意不含 `systemPrompt`
   * （所属人的私有知识）与 `visibility`（内部概念，对外无意义）。
   * 模型的 `available` 用"池成员 ∧ 模型与 Provider 都启用"这一条判据（与内部可选列表同口径）。
   */
  app.get('/open/v1/agent', { preHandler: app.requireOpenApi(null) }, async (request, reply) => {
    decorateOpenResponse(request, reply)
    const context = contextOf(request)
    const payload = await openRoute(async () => {
      const agent = await getPrisma().agent.findUniqueOrThrow({
        where: { id: context.agentId },
        select: {
          id: true,
          name: true,
          description: true,
          type: true,
          icon: true,
          openingRemarks: true,
          guideQuestions: true,
          modelId: true,
          pool: {
            orderBy: { createdAt: 'asc' },
            select: {
              model: {
                select: {
                  id: true,
                  modelName: true,
                  label: true,
                  enabled: true,
                  supportsVision: true,
                  provider: { select: { enabled: true } },
                },
              },
            },
          },
        },
      })
      const models = agent.pool.map((entry) => ({
        id: entry.model.id,
        modelName: entry.model.modelName,
        label: entry.model.label,
        available: entry.model.enabled && entry.model.provider.enabled,
        supportsVision: entry.model.supportsVision,
      }))
      const guideQuestions = Array.isArray(agent.guideQuestions)
        ? agent.guideQuestions.filter((q): q is string => typeof q === 'string')
        : []
      return openAgentProfileSchema.parse({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        type: agent.type,
        icon: agent.icon,
        openingRemarks: agent.openingRemarks,
        guideQuestions,
        defaultModelId: agent.modelId,
        models,
        capabilities: {
          streaming: true,
          confirm: true,
          // Q7 + X7：能不能**开**自动审批由本 Key 的开关决定（`/auto-approve` 会校验它）
          autoApprove: context.allowAutoApprove,
          attachments: true,
          steer: true,
          regenerate: true,
        },
        limits: {
          maxConcurrency: context.limits.maxConcurrency,
          rateLimitPerMin: context.limits.rateLimitPerMin,
          confirmTimeoutSec: context.confirmTimeoutSec,
          dailyTokenLimit: context.limits.dailyTokenLimit,
        },
      })
    })
    return payload
  })

  /** `GET /open/v1/agent/models` —— 可选的模型（scope `chat`） */
  app.get('/open/v1/agent/models', { preHandler: app.requireOpenApi('chat') }, async (request, reply) => {
    decorateOpenResponse(request, reply)
    const context = contextOf(request)
    return openRoute(async () => {
      const agent = await getPrisma().agent.findUniqueOrThrow({
        where: { id: context.agentId },
        select: {
          modelId: true,
          pool: {
            orderBy: { createdAt: 'asc' },
            select: {
              model: {
                select: {
                  id: true,
                  modelName: true,
                  label: true,
                  enabled: true,
                  supportsVision: true,
                  provider: { select: { enabled: true } },
                },
              },
            },
          },
        },
      })
      return openAgentModelsResultSchema.parse({
        defaultModelId: agent.modelId,
        items: agent.pool.map((entry) => ({
          id: entry.model.id,
          modelName: entry.model.modelName,
          label: entry.model.label,
          available: entry.model.enabled && entry.model.provider.enabled,
          supportsVision: entry.model.supportsVision,
        })),
      })
    })
  })

  // ═══════════════ 会话（建 / 列 / 详情 / 删）═══════════════

  /**
   * `POST /open/v1/conversations` —— 建会话（**Q11：必须先建会话再发消息**）。
   *
   * 三处刻意：
   *   · 只落到 Key 绑定的那个 Agent（请求体没有 `agentId`）⇒ 不存在"用 A 的 Key 在 B 下开会话"；
   *   · 支持 `Idempotency-Key` 头（24h Redis）：重复投递返回**第一次**的结果（§6.1 幂等约定）——
   *     网络重试不该在用户列表里留下两个空会话；
   *   · `title` 可省（省则走内部"首条消息落库时自动命名"）。
   */
  app.post(
    '/open/v1/conversations',
    { preHandler: app.requireOpenApi('conversation:write'), schema: { body: openCreateConversationBodySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { userId, role } = await viewerOf(request)
      const body = request.body as OpenCreateConversationBody
      const viewer = openViewer(context, role)

      const idempotencyKey = readIdempotencyKey(request)
      // ⚠️ 键里只有"客户端给的 Idempotency-Key" + Key id：同一把 Key 重放同一个值才是一次重试
      const cacheKey =
        idempotencyKey === undefined ? undefined : openApiIdempotencyKey(context.keyId, idempotencyKey)

      if (cacheKey !== undefined) {
        const cached = await readIdempotentResult(cacheKey)
        if (cached !== undefined) {
          getLogger().info({ openKeyId: context.keyId, conversationId: cached }, '命中建会话幂等键（返回首次结果）')
          const item = await getPrisma().conversation.findFirstOrThrow({
            where: { id: cached, userId },
            select: CONVERSATION_OPEN_SELECT,
          })
          return openRoute(async () => toOpenConversation(toItemOf(item)))
        }
      }

      return openRoute(async () => {
        const created = await createConversation({ agentId: context.agentId }, viewer)
        // 标题：内部建会话不收标题（首条消息自动命名），这里多一次 PATCH 把它提前定名 —— 
        // 复用 renameConversation 的同一套校验与判据（别在这里写第二条 update）
        const item = body.title === undefined ? created : await renameConversation(created.id, { topic: body.title }, viewer)
        if (cacheKey !== undefined) await writeIdempotentResult(cacheKey, item.id)
        return toOpenConversation(item)
      })
    },
  )

  /**
   * `GET /open/v1/conversations` —— **我这把 Key 对应的 `(我, 该 Agent)`** 的会话列表（X5：同用户多 Key 共享池）。
   *
   * 与内部 `listConversationsForAgent` **完全同形状**（`where { agentId, userId }`）——
   * 于是"界面里建的会话在开放层可见、Key A 与 Key B 看到同一批"是这条复用的**直接推论**，
   * 不是额外实现出来的行为。分页用**游标**（会话在变，offset 会漂）：游标是"上一页最后一条的 id"。
   */
  app.get(
    '/open/v1/conversations',
    { preHandler: app.requireOpenApi('conversation:read'), schema: { querystring: openListConversationsQuerySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const query = request.query as OpenListConversationsQuery
      const { role } = await viewerOf(request)
      const viewer = openViewer(context, role)

      return openRoute(async () => {
        const cursorOffset = await resolveConversationCursor(context, query.cursor)
        // 内部服务是 offset/limit（`02` §四 的列表口径），这里用"游标 → offset"换算：
        // 会话列表按 `lastMessageAt desc nulls first` 排序，新会话会插到最前 ⇒ 跨页期间可能
        // 重复/漏一条。这对"翻历史会话"是可接受的（客户端按 id 去重即可），
        // 换成真游标就要在内部服务上加第二套排序 —— 本期不做（写进 docs/08 的已知限制）。
        const page = await listConversationsForAgent(
          context.agentId,
          { offset: cursorOffset, limit: query.limit },
          viewer,
        )
        const items = page.items.map(toOpenConversation)
        const consumed = cursorOffset + items.length
        const hasMore = consumed < page.total
        const nextCursor = hasMore && items.length > 0 ? (items[items.length - 1]?.id ?? null) : null
        return { items, nextCursor, hasMore } satisfies OpenConversationListResult
      })
    },
  )

  /** `GET /open/v1/conversations/:id` —— 会话详情（含 `status` / `readOnly`） */
  app.get<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id',
    { preHandler: app.requireOpenApi('conversation:read') },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { userId } = await viewerOf(request)
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        const row = await getPrisma().conversation.findFirstOrThrow({
          where: { id: request.params.id, userId },
          select: CONVERSATION_OPEN_SELECT,
        })
        return toOpenConversation(toItemOf(row))
      })
    },
  )

  /**
   * `DELETE /open/v1/conversations/:id` —— 删除（**级联消息**）。
   *
   * 响应带 `deletedMessages`（用户在外部界面上也该看到"删掉了多少条"）；
   * 产物行不跟着删（内部口径：产物转"会话产物"保留，见 `conversation.service.ts` 文件头 ⑥）。
   */
  app.delete<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id',
    { preHandler: app.requireOpenApi('conversation:write') },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        const removed = await removeConversation(request.params.id, openViewer(context, role))
        return { id: removed.id, deletedMessages: removed.deletedMessages }
      })
    },
  )

  /**
   * `GET /open/v1/conversations/:id/messages` —— 历史（**行 id 游标**、时间正序）。
   *
   * ⚠️ **开放层比内部宽一处**：`limit` 上限 500（内部 100）。理由很具体 ——
   * 我们的游标**只能向更早翻**（`beforeId`），而"一次取最近 N 条、按时间正序"这种最常见的
   * 第三方诉求（协议驱动代理的"历史全量"配置）在内部口径下要客户端反复回填 + 自己拼顺序，
   * 而拼错的症状是"历史顺序颠倒"（只在第二页显形）。所以这里在**服务端把 500 内部拆成
   * 若干段 100 循环拉**，对外仍是一页。
   * ⚠️ 只在**没有 `beforeId`** 时走这条聚合：带游标的请求本来就是"向更早翻一页"，
   * 多拉没有意义（而且容易把"下一页的边界"算错）。
   * ⚠️ 500 是硬上限：更大的量应该由客户端自己分段（否则一次响应可能几 MB）。
   *
   * ★ `?parts=`（2026-10-22）：内部 `content` 是富对象（工具卡/引用/思考都在其它键里），
   * 而第三方的"历史"往往只想拿一段文本 —— 只给 `content.text` 会把卡片丢掉。
   * 三种模式见 `shared#OPEN_MESSAGE_PARTS`；**默认 `text`，旧调用行为不变**。
   * 投影在 `./messageParts.ts#projectOpenMessage`（三种模式唯一实现处）。
   */
  app.get<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/messages',
    {
      preHandler: app.requireOpenApi('conversation:read'),
      schema: { querystring: openListMessagesQuerySchema },
    },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const query = request.query as OpenListMessagesQuery
      const { role } = await viewerOf(request)
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        const page = await readOpenMessagePage(
          request.params.id,
          { limit: query.limit, ...(query.beforeId === undefined ? {} : { beforeId: query.beforeId }) },
          openViewer(context, role),
        )
        const result: OpenMessagePageResult = {
          items: page.items.map((item) => projectOpenMessage(item, query.parts)),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        }
        return result
      })
    },
  )

  /** `GET /open/v1/conversations/:id/active` —— 断线恢复：在跑？排队第几？等谁确认？ */
  app.get<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/active',
    { preHandler: app.requireOpenApi('conversation:read') },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      return openRoute<OpenConversationActive>(async () => {
        const row = await assertOpenConversation(request.params.id, context)
        const active = await getConversationActive(request.params.id, openViewer(context, role))
        return toOpenActive(active, row.status)
      })
    },
  )

  /**
   * `GET /open/v1/conversations/:id/stream` —— **只读观察流**（§6.2 表格；粘性）。
   *
   * 与内部同一条实现（`frameBus`）：订阅后**先回放本轮已发的帧**（迟到者补齐开头），
   * 整轮已结束则立刻收尾（`frameBus` 的 `close` 语义）；心跳是注释行 `: ping`。
   */
  app.get<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/stream',
    { preHandler: app.requireOpenApi('conversation:read') },
    async (request, reply) => {
      const context = contextOf(request)
      await assertOpenConversation(request.params.id, context)
      const conversationId = request.params.id

      reply.hijack()
      reply.raw.writeHead(200, { ...SSE_RESPONSE_HEADERS, 'x-open-key-id': context.keyId })
      reply.raw.flushHeaders()

      let closed = false
      const write = (event: SseEvent): void => {
        if (closed) return
        try {
          reply.raw.write(serializeSseFrame(event))
        } catch {
          closed = true
        }
      }
      const unsubscribe = subscribeFrames(conversationId, write)
      const ping = setInterval(() => {
        if (closed) return
        try {
          reply.raw.write(': ping\n\n')
        } catch {
          closed = true
        }
      }, config.limits.ssePingIntervalSec * 1000)
      ping.unref()

      const cleanup = (): void => {
        if (closed) return
        closed = true
        clearInterval(ping)
        unsubscribe()
      }
      reply.raw.once('close', cleanup)
      reply.raw.once('error', cleanup)
    },
  )

  // ═══════════════ 对话动作（SSE / 停止 / 插话 / 确认 / 自动审批）═══════════════

  /**
   * `POST /open/v1/conversations/:id/chat` —— **SSE 发消息**（粘性）。
   *
   * 与内部 `/chat` **同一条链路**（`assertConversationSendable` → `streamChatReply`），
   * 差别只有三处、且都写在参数里：
   *   ① `openKeyId` 透传 ⇒ 落库时 `usage_records.channel='OPEN_API' / open_key_id`（X1）；
   *   ② `confirmTimeoutSec` 透传 ⇒ 确认卡按 Key 的超时（P1-22 §4.1）；
   *   ③ **并发名额**：`acquireOpenConcurrency` 占一个（超限 429），流结束时释放（`finally`）。
   *
   * ⚠️ 并发名额必须在**闸门之前**占、在**流结束之后**放：占得太晚（流开始后）会让"排队中的
   * 请求"也占住上游名额；放得太早（`streamChatReply` 返回前）会让同一个 Key 在收尾阶段
   * 多跑一条。`finally` 是唯一正确的位置。
   */
  app.post<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/chat',
    { preHandler: app.requireOpenApi('chat'), schema: { body: openChatBodySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      const body = request.body as OpenChatBody
      const conversationId = request.params.id

      const row = await assertOpenConversation(conversationId, context)
      if (isOpenConversationReadOnly(row.status)) {
        throw AppError.conflict(appMsg('app.m021'))
      }

      const lease = await acquireOpenConcurrency(context, request.id)
      try {
        const viewer = openViewer(context, role)
        // 前置闸门（404 / 409 / 424）在加锁与 hijack **之前**跑完 ⇒ 走 JSON 信封
        const sendable = await assertConversationSendable(
          conversationId,
          viewer,
          body.modelId,
          body.attachmentFileIds,
        )
        await streamChatReply({
          reply,
          conversationId: sendable.conversationId,
          agentId: sendable.agentId,
          content: body.content,
          attachments: sendable.attachments,
          target: sendable.target,
          producer: resolveChatProducer(sendable.agentType),
          openKeyId: context.keyId,
          ...(context.confirmTimeoutSec === config.mcp.confirmTimeoutSec
            ? {}
            : { confirmTimeoutSec: context.confirmTimeoutSec }),
        })
      } finally {
        await lease.release()
      }
    },
  )

  /**
   * `POST /open/v1/conversations/:id/regenerate` —— 重新生成（SSE，粘性）。
   * 语义与内部**逐字相同**：撤掉上一轮 + 重跑同一段正文（正文取自库里，不收请求体）。
   */
  app.post<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/regenerate',
    { preHandler: app.requireOpenApi('chat'), schema: { body: openRegenerateBodySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      const body = request.body as OpenRegenerateBody
      const conversationId = request.params.id

      const row = await assertOpenConversation(conversationId, context)
      if (isOpenConversationReadOnly(row.status)) {
        throw AppError.conflict(appMsg('app.m104'))
      }

      const lease = await acquireOpenConcurrency(context, request.id)
      try {
        const viewer = openViewer(context, role)
        const regenerable = await assertConversationRegenerable(conversationId, viewer, body.modelId)
        await streamChatReply({
          reply,
          conversationId: regenerable.conversationId,
          agentId: regenerable.agentId,
          content: regenerable.content,
          target: regenerable.target,
          producer: resolveChatProducer(regenerable.agentType),
          openKeyId: context.keyId,
          ...(context.confirmTimeoutSec === config.mcp.confirmTimeoutSec
            ? {}
            : { confirmTimeoutSec: context.confirmTimeoutSec }),
          onLockAcquired: async () => {
            await recallLastRound(regenerable.conversationId, viewer)
          },
        })
      } finally {
        await lease.release()
      }
    },
  )

  /**
   * `POST /open/v1/conversations/:id/stop` —— 停止本轮（**幂等**：`signaled:false` 不是错误）。
   * 判据顺序与内部一致（先读 `/active`，真的在跑才写停止键）。
   */
  app.post<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/stop',
    { preHandler: app.requireOpenApi('chat') },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        const active = await getConversationActive(request.params.id, openViewer(context, role))
        if (!active.streaming) return { id: request.params.id, signaled: false }
        return { id: request.params.id, signaled: await signalStop(request.params.id) }
      })
    },
  )

  /** `POST /open/v1/conversations/:id/steer` —— 中途插话（幂等：`accepted:false` 不是错误） */
  app.post<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/steer',
    { preHandler: app.requireOpenApi('chat'), schema: { body: openSteerBodySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      const body = request.body as OpenSteerBody
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        const active = await getConversationActive(request.params.id, openViewer(context, role))
        if (!active.streaming) return { id: request.params.id, accepted: false, steerId: null }
        const result = await signalSteer(request.params.id, body.message)
        return { id: request.params.id, accepted: result.accepted, steerId: result.steerId }
      })
    },
  )

  /**
   * `POST /open/v1/conversations/:id/confirm` —— **快速确认**（Q2 点名的能力）。
   *
   * 与内部同一实现（`answerConfirm`）：`applied:false` = 没人在等这个 id（已超时/已处理/迟到点击），
   * **正常终局，不要重试**（`docs/07` §3.2）。
   */
  app.post<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/confirm',
    { preHandler: app.requireOpenApi('chat'), schema: { body: openConfirmBodySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      const body = request.body as OpenConfirmBody
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        const active = await getConversationActive(request.params.id, openViewer(context, role))
        const result = await answerConfirm(request.params.id, body, active.pendingConfirmId)
        return {
          id: result.id,
          confirmId: result.confirmId,
          accepted: result.accepted,
          applied: result.applied,
        }
      })
    },
  )

  /**
   * `POST /open/v1/conversations/:id/auto-approve` —— 会话级自动审批（Q7）。
   *
   * ⚠️ **受 Key 的 `allowAutoApprove` 约束**（X7）：Key 禁止时，`enabled:true` ⇒ 403 `FORBIDDEN`；
   * `enabled:false` 永远允许（关掉一个危险模式不该被拒绝 —— 否则客户无法自保）。
   */
  app.post<{ Params: OpenConversationIdParams }>(
    '/open/v1/conversations/:id/auto-approve',
    { preHandler: app.requireOpenApi('chat'), schema: { body: openSetAutoApproveBodySchema } },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)
      const { role } = await viewerOf(request)
      const body = request.body as OpenSetAutoApproveBody
      return openRoute(async () => {
        await assertOpenConversation(request.params.id, context)
        if (body.enabled && !context.allowAutoApprove) {
          throw AppError.forbidden(appMsg('app.m105'))
        }
        // 先过所有权（不是我的会话 ⇒ 404），再写开关 —— 顺序与内部 `/auto-approve` 一致
        await getConversationActive(request.params.id, openViewer(context, role))
        await setAutoApprove(request.params.id, body.enabled)
        return { id: request.params.id, autoApprove: body.enabled }
      })
    },
  )

  // ═══════════════ 附件 ═══════════════

  /**
   * `POST /open/v1/files` —— 附件上传（multipart，字段名 `file`；scope `chat`）。
   *
   * 复用内部 `uploadChatFile`（同一套格式白名单 / MIME / 魔数 / 大小校验）：上传主语是
   * Key 的归属用户 ⇒ 之后 `/chat` 的 `attachmentFileIds` 归属校验天然通过（同一个 `uploader_id`）。
   */
  app.post(
    '/open/v1/files',
    { preHandler: app.requireOpenApi('chat'), bodyLimit: config.limits.uploadBodyLimitBytes },
    async (request, reply) => {
      decorateOpenResponse(request, reply)
      const context = contextOf(request)

      let file: { fileName: string; declaredMime: string | undefined; bytes: Buffer } | undefined
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        const bytes = await part.toBuffer()
        if (part.file.truncated) {
          throw AppError.validation(appMsg('app.m106', { p0: config.limits.uploadBodyLimitRaw, p1: part.filename || '未命名文件' }),
          )
        }
        if (file !== undefined) {
          throw AppError.validation(appMsg('app.m107', { p0: UPLOAD_FILE_FIELD }))
        }
        file = { fileName: part.filename, declaredMime: part.mimetype, bytes }
      }
      if (file === undefined) {
        throw AppError.validation(appMsg('app.m108', { p0: UPLOAD_FILE_FIELD }))
      }
      if (file.bytes.length === 0) {
        throw AppError.validation(appMsg('app.m010', { p0: file.fileName || '未命名文件' }))
      }

      return openRoute(async () => {
        // 内部投影叫 `fileId`、对外叫 `id`（`docs/08` §6.5 示例）—— 转换**只在这里**做一次
        const uploaded = await uploadChatFile({ uploaderId: context.userId, ...file })
        return openUploadFileResultSchema.parse({
          id: uploaded.fileId,
          name: uploaded.name,
          mime: uploaded.mime,
          size: uploaded.size,
          kind: uploaded.kind,
        })
      })
    },
  )

  // ═══════════════ 用量 ═══════════════

  /**
   * `GET /open/v1/usage` —— 本 Key 的用量与余量（自助看额度，§6.4 / X6）。
   *
   * 三个数据源刻意不同：
   *   · `dayTokens` ← `usage_records`（**真账**：`channel='OPEN_API' ∧ open_key_id`，当日 UTC）；
   *   · `rateLimitRemaining` ← Redis 当前分钟窗口的计数（瞬时状态，查库没有意义）；
   *   · `limits` ← 本 Key 的生效值（已把 `null` 换成全局默认）。
   */
  app.get('/open/v1/usage', { preHandler: app.requireOpenApi(null) }, async (request, reply) => {
    decorateOpenResponse(request, reply)
    const context = contextOf(request)
    return openRoute(async () => {
      const day = openApiUtcDay()
      const [tokens, used] = await Promise.all([
        readOpenApiDayTokens(context.keyId, day),
        readOpenApiRateLimitUsed(context.keyId),
      ])
      const limit = context.limits.dailyTokenLimit
      return openUsageResultSchema.parse({
        keyId: context.keyId,
        scopes: context.scopes,
        limits: {
          maxConcurrency: context.limits.maxConcurrency,
          rateLimitPerMin: context.limits.rateLimitPerMin,
          confirmTimeoutSec: context.confirmTimeoutSec,
          dailyTokenLimit: limit,
        },
        usage: {
          day,
          dayTokens: tokens.tokens,
          dayTokensUnknown: tokens.unknown,
          dailyTokenLimit: limit,
          dailyTokenRemaining: limit <= 0 ? null : Math.max(0, limit - tokens.tokens),
          rateLimitRemaining: Math.max(0, context.limits.rateLimitPerMin - used),
        },
      })
    })
  })
}

// ───────────────────────────── 消息分页（开放层的 500 上限聚合） ─────────────────────────────

/** 内部单页上限（`shared#MESSAGE_PAGE_LIMIT_MAX`）—— 聚合时每段最多这么多 */
const INTERNAL_MESSAGE_PAGE_MAX = 100

/**
 * 读一页消息（**唯一**的"500 → 内部 100"落地点，见 handler 的注释）。
 *
 * 三种情况：
 *   · `limit <= 100` 或**带了 `beforeId`** ⇒ 直接透传（一次内部调用）；
 *   · `limit > 100` 且不带游标 ⇒ 从**最新**开始，每段 100 往回翻，直到攒够 `limit` 或没有更早的了；
 *     内部每页是**时间正序**的，拼接时**前插**（`unshift` 等价物是 `pages[i] + acc`），
 *     最后再按 `limit` 截取**最靠近现在**的那些（保持"正序 + 取最近 N 条"的语义）。
 *   · 中途出错 ⇒ 原样抛出（不做"部分成功"：半个历史比报错更难查）。
 *
 * ⚠️ `hasMore` 的口径与内部一致：**还有更早的**才为 true；聚合到上限时，只要上界之内还有更早的
 * （即最后一次内部调用回了 `hasMore:true` 或恰好被 limit 截断）就为 true —— 否则客户端会以为
 * "到最早了"，翻不到 500 之前的消息。
 */
async function readOpenMessagePage(
  conversationId: string,
  query: { limit: number; beforeId?: string },
  viewer: ConversationViewer,
) {
  if (query.limit <= INTERNAL_MESSAGE_PAGE_MAX || query.beforeId !== undefined) {
    return listMessages(conversationId, query, viewer)
  }

  const pages: { items: Awaited<ReturnType<typeof listMessages>>['items']; hasMore: boolean }[] = []
  let cursor: string | undefined
  let collected = 0
  while (collected < query.limit) {
    const want = Math.min(INTERNAL_MESSAGE_PAGE_MAX, query.limit - collected)
    const page = await listMessages(
      conversationId,
      { limit: want, ...(cursor === undefined ? {} : { beforeId: cursor }) },
      viewer,
    )
    pages.unshift({ items: page.items, hasMore: page.hasMore })
    collected += page.items.length
    // 这一页没有更早的了 ⇒ 停（`nextCursor` 为 null 时 `hasMore` 也是 false）
    if (!page.hasMore || page.nextCursor === null || page.items.length === 0) break
    cursor = page.nextCursor
  }

  const items = pages.flatMap((page) => page.items)
  // 聚合可能略多于 limit（每段按 100 取整）：**保留最靠近现在的 limit 条**（尾部）
  const trimmed = items.length > query.limit ? items.slice(items.length - query.limit) : items
  const oldestPage = pages[0]
  // 被截断 ⇒ 前面一定还有更早的；否则看最早那页自己的 hasMore
  const truncated = items.length > trimmed.length
  const hasMore = truncated || (oldestPage?.hasMore ?? false)
  const nextCursor = hasMore ? (trimmed[0]?.id ?? null) : null
  return { items: trimmed, nextCursor, hasMore }
}

// ───────────────────────────── 会话投影 / 幂等的内部小件 ─────────────────────────────

/** 会话行 → 内部 `ConversationItem`（列表与详情共用的投影；`agent` 是快照 join） */
const CONVERSATION_OPEN_SELECT = {
  id: true,
  agentId: true,
  topic: true,
  status: true,
  runtime: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: { name: true, type: true } },
} as const

/** 与 `conversation.service.ts#toItem` 逐字段同形（**只在本文件用**，不导出） */
function toItemOf(row: {
  id: string
  agentId: string
  topic: string | null
  status: ConversationItem['status']
  runtime: string
  lastMessageAt: Date | null
  createdAt: Date
  updatedAt: Date
  agent: { name: string; type: ConversationItem['agentType'] }
}): ConversationItem {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent.name,
    agentType: row.agent.type,
    topic: row.topic,
    status: row.status,
    runtime: row.runtime,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 读 `Idempotency-Key` 头（长度兜底：过长/空串当作没给） */
function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key']
  if (typeof header !== 'string') return undefined
  const value = header.trim()
  if (value === '' || value.length > 200) return undefined
  return value
}

/** 幂等键的值：**第一次**建出来的会话 id；未命中 ⇒ undefined */
async function readIdempotentResult(cacheKey: string): Promise<string | undefined> {
  const redis = await ensureRedisConnected()
  const value = await redis.get(cacheKey)
  return value === null || value === '' ? undefined : value
}

/** 写幂等结果（24h）。失败只 warn：幂等是"更好"，不是"必须" */
async function writeIdempotentResult(cacheKey: string, conversationId: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.set(cacheKey, conversationId, 'EX', OPEN_API_IDEMPOTENCY_TTL_SEC)
  } catch (error) {
    getLogger().warn({ err: error }, '写建会话幂等结果失败（重试会多建一个会话）')
  }
}

/**
 * 会话列表游标 → offset（见 `GET /conversations` 的注释：本期用 offset 换算）。
 *
 * 游标是"上一页最后一条的 id"：要求它**是本用户在该 Agent 下的会话**（否则 400）——
 * 这样"拿别人/别的 Agent 的 id 当游标"不会变成一次越权读取，只是一次参数错误。
 */
async function resolveConversationCursor(context: OpenRequestContext, cursor: string | undefined): Promise<number> {
  if (cursor === undefined || cursor === '') return 0
  const rows = await getPrisma().conversation.findMany({
    where: { agentId: context.agentId, userId: context.userId },
    select: { id: true },
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }, { id: 'desc' }],
  })
  const index = rows.findIndex((row) => row.id === cursor)
  if (index < 0) throw AppError.validation(appMsg('app.m109'))
  return index + 1
}
