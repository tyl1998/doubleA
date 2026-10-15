/**
 * 长期记忆路由（P1-8 · L2）—— `/api/memories` 系列 + 会话级「不记入记忆」
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §5（HCI：记忆面板 / 开关 / 提示）、
 *      `shared/src/memory.ts`（契约）、`01` 决策 6、`03` §4.7（记忆并入 `/tasks` 活动中心）。
 *
 * 端点：
 *   · `GET    /api/memories`                    本人的记忆列表（分页 + `kind`/关键词过滤）
 *   · `POST   /api/memories`                    手动新增
 *   · `PATCH  /api/memories/:id`                改（正文 / 类型 / 置顶）
 *   · `DELETE /api/memories/:id`                删（硬删）
 *   · `GET    /api/memories/settings`           读开关
 *   · `PATCH  /api/memories/settings`           改开关
 *   · `GET    /api/memories/notices`            取走"待展示提示"（toast 晚一拍；AUTO 取出即消费、SUGGEST 留到作答）
 *   · `POST   /api/memories/notices/:noticeId`  对一条偏好建议作答（记住 / 忽略）
 *   · `PUT    /api/conversations/:id/memory-excluded`  会话级「不记入记忆」
 *
 * 权限与会话/产物/任务同族：**仅本人**（判据在服务层 `where` 里），本文件一个 `requireAdmin` 都没有。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createMemoryBodySchema,
  listMemoriesQuerySchema,
  memoryIdParamsSchema,
  memoryNoticeActionResultSchema,
  memoryNoticeActionBodySchema,
  ok,
  setConversationMemoryExcludedBodySchema,
  setConversationMemoryExcludedResultSchema,
  updateMemoryBodySchema,
  updateMemorySettingsBodySchema,
  conversationIdParamsSchema,
  type ConversationIdParams,
  type CreateMemoryBody,
  type ListMemoriesQuery,
  type MemoryIdParams,
  type MemoryNoticeActionBody,
  type SetConversationMemoryExcludedBody,
  type UpdateMemoryBody,
  type UpdateMemorySettingsBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { requireAuthContext } from '../plugins/session.js'
import {
  actOnMemoryNotice,
  createMemory,
  drainMemoryNotices,
  getMemorySettings,
  listMemories,
  removeMemory,
  requireMemoryConversation,
  setConversationMemoryExcluded,
  updateMemory,
  updateMemorySettings,
} from '../services/memory.service.js'

/** 取调用者 —— **只取 `id`**（记忆按 `user_id` 收窄，不按角色判权） */
function viewerOf(request: FastifyRequest): { id: string } {
  return { id: requireAuthContext(request).user.id }
}

/** `GET /api/memories/notices` 的查询参数（提示是**按会话**缓冲的） */
const noticesQuerySchema = z.object({
  conversationId: z.string().uuid('会话 ID 不是合法 UUID'),
})

/** `POST /api/memories/notices/:noticeId` 的路径参数 */
const noticeIdParamsSchema = z.object({
  noticeId: z.string().min(1, '提示 ID 不能为空'),
})

export function registerMemoryRoutes(app: FastifyInstance): void {
  /** 本人的记忆列表（offset/limit 分页 + 可选 `kind`/`q`） */
  app.get<{ Querystring: ListMemoriesQuery }>(
    '/api/memories',
    { preHandler: app.requireAuth, schema: { querystring: listMemoriesQuerySchema } },
    async (request) => ok(await listMemories(request.query, viewerOf(request))),
  )

  /** 读开关（面板顶部三个开关 + `maxPerUser`） */
  app.get(
    '/api/memories/settings',
    { preHandler: app.requireAuth },
    async (request) => ok(await getMemorySettings(viewerOf(request).id)),
  )

  /** 改开关（逐字段可选） */
  app.patch<{ Body: UpdateMemorySettingsBody }>(
    '/api/memories/settings',
    { preHandler: app.requireAuth, schema: { body: updateMemorySettingsBodySchema } },
    async (request) => ok(await updateMemorySettings(viewerOf(request).id, request.body)),
  )

  /**
   * 取走"待展示提示"（toast 晚一拍；AUTO 取出即消费、SUGGEST 留到作答，见 `memory.service#drainMemoryNotices`）。
   * 先过会话归属（不是我的会话 ⇒ 404，与 `/memories` 同族判据）。
   */
  app.get<{ Querystring: { conversationId: string } }>(
    '/api/memories/notices',
    { preHandler: app.requireAuth, schema: { querystring: noticesQuerySchema } },
    async (request) => {
      await requireMemoryConversation(request.query.conversationId, viewerOf(request))
      return ok({ items: await drainMemoryNotices(request.query.conversationId) })
    },
  )

  /** 对一条偏好建议作答（记住 / 忽略）；`applied:false` = 提示已过期（幂等） */
  app.post<{ Params: { noticeId: string }; Querystring: { conversationId: string }; Body: MemoryNoticeActionBody }>(
    '/api/memories/notices/:noticeId',
    {
      preHandler: app.requireAuth,
      schema: {
        params: noticeIdParamsSchema,
        querystring: noticesQuerySchema,
        body: memoryNoticeActionBodySchema,
      },
    },
    async (request) => {
      const viewer = viewerOf(request)
      const { agentId } = await requireMemoryConversation(request.query.conversationId, viewer)
      const result = await actOnMemoryNotice({
        conversationId: request.query.conversationId,
        noticeId: request.params.noticeId,
        action: request.body.action,
        ...(request.body.text === undefined ? {} : { text: request.body.text }),
        viewer,
        agentId,
      })
      return ok(memoryNoticeActionResultSchema.parse(result))
    },
  )

  /** 手动新增一条记忆（任何类型都允许 —— 这是"用户显式添加"的入口） */
  app.post<{ Body: CreateMemoryBody }>(
    '/api/memories',
    { preHandler: app.requireAuth, schema: { body: createMemoryBodySchema } },
    async (request) => ok(await createMemory(request.body, viewerOf(request))),
  )

  /** 改一条记忆（正文 / 类型 / 置顶） */
  app.patch<{ Params: MemoryIdParams; Body: UpdateMemoryBody }>(
    '/api/memories/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: memoryIdParamsSchema, body: updateMemoryBodySchema },
    },
    async (request) => ok(await updateMemory(request.params.id, request.body, viewerOf(request))),
  )

  /** 硬删一条记忆 */
  app.delete<{ Params: MemoryIdParams }>(
    '/api/memories/:id',
    { preHandler: app.requireAuth, schema: { params: memoryIdParamsSchema } },
    async (request) => ok(await removeMemory(request.params.id, viewerOf(request))),
  )

  /** 会话级「不记入记忆」开关（HCI §5.2.1；入口 = 会话头 `⋯` 菜单） */
  app.put<{ Params: ConversationIdParams; Body: SetConversationMemoryExcludedBody }>(
    '/api/conversations/:id/memory-excluded',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, body: setConversationMemoryExcludedBodySchema },
    },
    async (request) =>
      ok(
        setConversationMemoryExcludedResultSchema.parse(
          await setConversationMemoryExcluded(
            request.params.id,
            request.body.excluded,
            viewerOf(request),
          ),
        ),
      ),
  )
}
