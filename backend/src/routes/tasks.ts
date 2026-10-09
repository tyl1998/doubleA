/**
 * 任务中心路由（P1-6，2026-10-09 需求变更：定时任务）—— `/api/tasks` 五条
 *
 * 依据：`docs/02` §4.8（任务与产物 · 定时任务）、`01` 决策 28 + §3.7 需求 38、`03` §4.7。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 「任务中心」= **定时任务的 CRUD + 立即执行**（不是会话视图）
 * ─────────────────────────────────────────────────────────────────────
 * 一条定时任务 = 某个 TaskAgent + 一段指令 + 一个 cron 周期。到点由调度器新建会话派活（见
 * `scheduler/scheduledTasks.ts`）。五条端点：
 *   · `GET    /api/tasks`        本人的定时任务列表；
 *   · `POST   /api/tasks`        新建（校验是 TaskAgent + cron 合法）；
 *   · `PATCH  /api/tasks/:id`    改（名字/指令/cron/启停；**不改 agentId**）；
 *   · `DELETE /api/tasks/:id`    删；
 *   · `POST   /api/tasks/:id/run` **立即执行**（不等整轮，立刻回本次的会话 id）。
 *
 * 权限与会话同族：**仅本人**（`scheduled_tasks.user_id`），判据落在服务层 `where` 里，
 * 本文件一个权限函数都没有 —— 别人的任务与不存在的 id 返回**同一个 404**。
 * ⚠️ **不要**在这里加 `requireAdmin`：任务中心不是管理页，是本人的定时任务。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createScheduledTaskBodySchema,
  listScheduledTasksQuerySchema,
  ok,
  runScheduledTaskResultSchema,
  scheduledTaskIdParamsSchema,
  updateScheduledTaskBodySchema,
  type CreateScheduledTaskBody,
  type ListScheduledTasksQuery,
  type ScheduledTaskIdParams,
  type UpdateScheduledTaskBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import { triggerScheduledTaskRun } from '../scheduler/scheduledTasks.js'
import {
  createScheduledTask,
  findMyScheduledTask,
  listScheduledTasks,
  removeScheduledTask,
  updateScheduledTask,
} from '../services/scheduledTask.service.js'

/** 取调用者 —— **只取 `id`**（任务按 `scheduled_tasks.user_id` 收窄，不按角色判权） */
function viewerOf(request: FastifyRequest): { id: string } {
  return { id: requireAuthContext(request).user.id }
}

export function registerTaskRoutes(app: FastifyInstance): void {
  /** 本人的定时任务列表（offset/limit 分页，`createdAt desc`） */
  app.get<{ Querystring: ListScheduledTasksQuery }>(
    '/api/tasks',
    { preHandler: app.requireAuth, schema: { querystring: listScheduledTasksQuerySchema } },
    async (request) => ok(await listScheduledTasks(request.query, viewerOf(request))),
  )

  /** 新建定时任务（服务层校验：目标必须是 TaskAgent；cron 合法性由 body schema 拦下） */
  app.post<{ Body: CreateScheduledTaskBody }>(
    '/api/tasks',
    { preHandler: app.requireAuth, schema: { body: createScheduledTaskBodySchema } },
    async (request) => ok(await createScheduledTask(request.body, viewerOf(request))),
  )

  /** 改定时任务（逐字段可选；`enabled` 变或 `cronExpr` 变会重排下一次触发） */
  app.patch<{ Params: ScheduledTaskIdParams; Body: UpdateScheduledTaskBody }>(
    '/api/tasks/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: scheduledTaskIdParamsSchema, body: updateScheduledTaskBodySchema },
    },
    async (request) => ok(await updateScheduledTask(request.params.id, request.body, viewerOf(request))),
  )

  /** 删定时任务（硬删；正在跑的那一轮不受影响 —— 它的会话与产物照常保留） */
  app.delete<{ Params: ScheduledTaskIdParams }>(
    '/api/tasks/:id',
    { preHandler: app.requireAuth, schema: { params: scheduledTaskIdParamsSchema } },
    async (request) => ok(await removeScheduledTask(request.params.id, viewerOf(request))),
  )

  /**
   * 立即执行（`POST /api/tasks/:id/run`）。
   *
   * **不等整轮**：建好会话、置 `RUNNING` 就返回本次的 `conversationId`，驱动在后台继续
   * （整轮可能几分钟，HTTP 不该挂着等）。用户拿 `conversationId` 去对话页看过程与产物。
   * 同一任务已在跑 ⇒ **409**（他点的是同步动作，静默忽略最糟，见 `scheduler` 文件头）。
   */
  app.post<{ Params: ScheduledTaskIdParams }>(
    '/api/tasks/:id/run',
    { preHandler: app.requireAuth, schema: { params: scheduledTaskIdParamsSchema } },
    async (request) => {
      const viewer = viewerOf(request)
      const task = await findMyScheduledTask(request.params.id, viewer)
      // `task` 已是"我的"（findMyScheduledTask 按 userId 收窄）⇒ owner 就是 viewer
      const { conversationId } = await triggerScheduledTaskRun({
        id: task.id,
        userId: viewer.id,
        agentId: task.agentId,
        name: task.name,
        prompt: task.prompt,
        autoApprove: task.autoApprove,
        notifyType: task.notifyType,
        notifyUrl: task.notifyUrl,
        notifySecret: task.notifySecret,
        notifyTemplate: task.notifyTemplate,
      })
      return ok(runScheduledTaskResultSchema.parse({ id: task.id, conversationId }))
    },
  )
}
