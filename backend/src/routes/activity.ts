/**
 * 活动时间线路由（P1-8 · L0）—— `/api/activity` 与 `/api/activity/search`
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §4.1（L0）/§4.6（L0 先行）、
 *      `shared/src/memory.ts`（契约）。
 *
 *  L0 = "我做过哪些事"：**本人**的会话列表（主题/时间/产物数/用量/小结）+ 对**自己的**会话与消息搜索。
 *  权限与会话同族（**仅本人**）—— 判据在服务层 `where` 里，本文件一个权限函数都没有。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  listActivityQuerySchema,
  ok,
  searchActivityQuerySchema,
  type ListActivityQuery,
  type SearchActivityQuery,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import { listActivity, searchActivity } from '../services/activity.service.js'

function viewerOf(request: FastifyRequest): { id: string } {
  return { id: requireAuthContext(request).user.id }
}

export function registerActivityRoutes(app: FastifyInstance): void {
  /** 活动时间线：本人的会话 + 读数（消息数 / 产物数 / 用量 / L1 小结） */
  app.get<{ Querystring: ListActivityQuery }>(
    '/api/activity',
    { preHandler: app.requireAuth, schema: { querystring: listActivityQuerySchema } },
    async (request) => ok(await listActivity(request.query, viewerOf(request))),
  )

  /** 消息搜索：在**本人的**会话里按 `content.text` 包含关键词检索 */
  app.get<{ Querystring: SearchActivityQuery }>(
    '/api/activity/search',
    { preHandler: app.requireAuth, schema: { querystring: searchActivityQuerySchema } },
    async (request) => ok(await searchActivity(request.query, viewerOf(request))),
  )
}
