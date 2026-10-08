/**
 * 智能体路由（P0-1-22 / P0-1-23）
 *
 * 依据：`docs/02-后端设计.md` §4.4（`/api/agents[…/:id]` 六端点）+ §四 约定
 *      + `01` §3.3（决策 18：全员可建可看可用；创建者 + ADMIN 可编删；决策 7：组件只有知识库 + MCP）
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
 * 刻意**尚未注册**的路由（不要顺手补）
 * ─────────────────────────────────────────────────────────────────────
 *   · `POST /api/agents/:id/copy` —— **P0 不做、P1-2 已落地**（见本文件末尾的复制路由）。
 *     ⚠️ P0-1 当时的验收脚本有一条"它必须 404"守着"防顺手实现"，P1-2 落地时那条断言
 *     **随脚本删除一并作废**（`verify-app.mjs` 已于 2026-09-24 整目录删除）。
 *   · `GET /api/agents/:id/conversations` —— **P0-1-25 已落地**（包 F 的会话管理），
 *     注册在 `routes/conversations.ts`（它读的是 `conversations` 表，见该文件头）。
 *     ⚠️ P0-1-22 时这一条在"刻意不做"清单里，P0-1-23 时 `PUT …/components` 也翻转过一次 ——
 *     两档无依赖验收（`verify-app.mjs`）里的对应断言都已同步翻转。
 *   · `GET /api/conversations/:id/messages` 仍属后续批次（**P0-1-28**），本批**不要顺手补**。
 *     `POST /api/conversations/:id/chat`（SSE）与 `/:id/stop` 已在 **P0-1-26** 落地，
 *     同样注册在 `routes/conversations.ts`（它们读写的都是 `conversations` 与 Redis 的活跃流锁）。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  agentIdParamsSchema,
  createAgentBodySchema,
  listAgentsQuerySchema,
  ok,
  replaceAgentComponentsBodySchema,
  updateAgentBodySchema,
  type AgentIdParams,
  type CreateAgentBody,
  type ListAgentsQuery,
  type ReplaceAgentComponentsBody,
  type UpdateAgentBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  copyAgent,
  createAgent,
  getAgent,
  listAgents,
  removeAgent,
  replaceAgentComponents,
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

  /**
   * 复制（**登录即可**；P1-2）。无请求体：新名字由服务端生成「原名（副本）」，
   * 内容整份沿用源（含模型池与组件绑定），`createdBy` 记为**调用者**。
   *
   * ⚠️ **不做行级权限判定**（与 `PATCH`/`DELETE` 刻意不同）：源本就全员可见
   * （详情含系统提示词），复制产出的新智能体归调用者，语义是"以它为模板起一个自己的"。
   * 见服务层 `copyAgent` 的口径 ①。
   */
  app.post<{ Params: AgentIdParams }>(
    '/api/agents/:id/copy',
    { preHandler: app.requireAuth, schema: { params: agentIdParamsSchema } },
    async (request) => ok(await copyAgent(request.params.id, viewerOf(request))),
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

  /**
   * 组件绑定**整体替换**（**登录即可进入，行级判定：创建者或 ADMIN**，否则 403）。
   *
   * `PUT` 而不是 `PATCH`：语义是"这个集合就是全部"（`02` §4.4 的"全量提交，避免增量 diff"），
   * 幂等地重复提交同一份不产生任何副作用（服务层会跳过写库）。
   * ⚠️ `components` **必填**，清空要传 `[]` —— "省略 = 清空"会让前端某次忘带字段
   * 变成静默解绑（见 `shared` 的 `replaceAgentComponentsBodySchema`）。
   *
   * 响应是**同一套 `AgentItem` 投影**（不是只回一个 components 数组）：
   * 组件绑定只是这个资源的一部分，`03` §4.2 的保存流程拿到它就能直接刷新本地状态。
   */
  app.put<{ Params: AgentIdParams; Body: ReplaceAgentComponentsBody }>(
    '/api/agents/:id/components',
    {
      preHandler: app.requireAuth,
      schema: { params: agentIdParamsSchema, body: replaceAgentComponentsBodySchema },
    },
    async (request) =>
      ok(await replaceAgentComponents(request.params.id, request.body, viewerOf(request))),
  )
}
