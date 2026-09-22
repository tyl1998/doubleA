/**
 * 智能体路由（P0-1-22）
 *
 * 依据：`docs/02-后端设计.md` §4.4（`/api/agents[…/:id]` 五端点）+ §四 约定
 *      + `01` §3.3（决策 18：全员可建可看可用；创建者 + ADMIN 可编删）
 *      + `03` §二 的路由权限列（`/`、`/agents/new` 是「登录」，`/agents/:id/edit` 是「创建者/ADMIN」）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：`preHandler` **只用 `requireAuth`**，权限收窄在行级
 * ─────────────────────────────────────────────────────────────────────
 * `03` §二 的编辑页写着"创建者/ADMIN"，而这一条**不是**通过给路由加 `requireAdmin` 实现的
 * ——那样会把"创建者本人也改不了自己的东西"（ADMIN 才配改）变成事实。
 * 三族资源的权限口径**刻意各不相同**，照抄邻居必错（本仓已因此踩过两次）：
 *
 * | 资源 | 读 | 写 | 落点 |
 * |------|----|----|------|
 * | `/api/model-providers`、`/api/models` | `requireAdmin` | `requireAdmin` | `(A)` 端点 |
 * | `/api/knowledge-bases` | `requireAuth` | `requireAuth`（**无 owner 列**） | 全员共享资源 |
 * | `/api/agents` | `requireAuth` | `requireAuth` + **行级判定** | `01` 决策 18 |
 *
 * 行级判定落在 `services/agent.service.ts` 的 {@link canEditAgent}（`shared` 里的唯一实现），
 * 路由这一层**不重复实现也不提前拦**：把它写在路由上，`GET`/`POST` 就得各自分支，
 * 而"哪个 handler 漏了一次判定"是这类越权最经典的来源。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 刻意**尚未注册**的两条路由（不要顺手补）
 * ─────────────────────────────────────────────────────────────────────
 *   · `PUT /api/agents/:id/components` —— P0-1-23（组件整体替换）。本批只在**读侧**
 *     回显绑定（详情/列表里的 `components`），写侧留给下一批，验收也随之分开。
 *   · `POST /api/agents/:id/copy` —— **P1**（`02` §4.4 已标 P1、`01` §3.3 复制 Agent 也是 P1）。
 *     P0 不做，验收脚本里有一条"它必须 404"守着，防止有人"顺手"把它实现出来。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  agentIdParamsSchema,
  createAgentBodySchema,
  listAgentsQuerySchema,
  ok,
  updateAgentBodySchema,
  type AgentIdParams,
  type CreateAgentBody,
  type ListAgentsQuery,
  type UpdateAgentBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createAgent,
  getAgent,
  listAgents,
  removeAgent,
  updateAgent,
  type AgentViewer,
} from '../services/agent.service.js'

/**
 * 取调用者（`id` + `role`）。
 *
 * 用 `requireAuthContext` 而不是自己判 `request.auth === null`：本文件的每条路由都挂了
 * `app.requireAuth`，所以那个分支永远不会触发 —— 散在各处只会掩盖真正的逻辑；
 * 而它同时兜住"有人忘了挂 preHandler"这种真实的接线错误（此时它会 401 而不是拿 null 崩）。
 */
function viewerOf(request: FastifyRequest): AgentViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

export function registerAgentRoutes(app: FastifyInstance): void {
  /**
   * 列表（**登录即可**，全员可见全部智能体，含 `canEdit` 标记）。
   * `03` §二 的首页就是这个列表 —— 它不是"我的智能体"，是"所有人的智能体"。
   */
  app.get<{ Querystring: ListAgentsQuery }>(
    '/api/agents',
    { preHandler: app.requireAuth, schema: { querystring: listAgentsQuerySchema } },
    async (request) => ok(await listAgents(request.query, viewerOf(request))),
  )

  /**
   * 详情（**登录即可**，含组件绑定）。软删的一律 404。
   *
   * 静态段/参数段不冲突：本批没有 `/api/agents/available` 这类子路径
   * （与模型池不同 —— 智能体列表本来就对全员开放，不存在第二套投影）。
   */
  app.get<{ Params: AgentIdParams }>(
    '/api/agents/:id',
    { preHandler: app.requireAuth, schema: { params: agentIdParamsSchema } },
    async (request) => ok(await getAgent(request.params.id, viewerOf(request))),
  )

  /**
   * 创建（**登录即可**；创建者记为当前用户，见服务层注释）。
   * 成功返回 `200`（信封 `code=0` 是唯一契约，与其余建接口同口径，**不引入 201**）。
   */
  app.post<{ Body: CreateAgentBody }>(
    '/api/agents',
    { preHandler: app.requireAuth, schema: { body: createAgentBodySchema } },
    async (request) => ok(await createAgent(request.body, viewerOf(request))),
  )

  /** 编辑（**登录即可进入，行级判定：创建者或 ADMIN**，否则 403） */
  app.patch<{ Params: AgentIdParams; Body: UpdateAgentBody }>(
    '/api/agents/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: agentIdParamsSchema, body: updateAgentBodySchema },
    },
    async (request) => ok(await updateAgent(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 删除（**登录即可进入，行级判定：创建者或 ADMIN**，否则 403）。
   *
   * ⚠️ **软删**（`02` §4.4）：会话转只读保留、组件绑定解除，三件事在服务层一个事务里做完。
   * 响应带 `removedComponents` / `finishedConversations` 两个数 —— `03` §七 的级联删除
   * 确认框（"将同时影响 N 个会话"）要用它。
   */
  app.delete<{ Params: AgentIdParams }>(
    '/api/agents/:id',
    { preHandler: app.requireAuth, schema: { params: agentIdParamsSchema } },
    async (request) => ok(await removeAgent(request.params.id, viewerOf(request))),
  )
}
