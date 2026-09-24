/**
 * MCP server 路由（P0-2-2）
 *
 * 依据：`docs/02-后端设计.md` §4.7（`/api/mcp/servers[…/:id]` 六条）+ §四 约定
 *      + `docs/06-实施计划.md` §四 4.2（第五族权限）与 P0-2-2（内容 / 验收门槛）
 *      + `03` §4.4（MCP 管理页）、`01` §3.6（决策 22：全员可注册）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：**权限是「登录即可」，且没有 owner 列收窄**
 * ─────────────────────────────────────────────────────────────────────
 * `06` §4.2 把这一族定得很清楚：`/api/mcp/**` 一律"登录即可"，
 * **最接近 knowledge-bases**（同样没有 owner 列、同样是"人人可见的共享资源"）。三族的差别：
 *
 * | 资源 | 路由挂什么 | 判据 |
 * |------|-----------|------|
 * | `/api/users`、`/api/model-providers`、`/api/models` | `requireAdmin` | `(A)` 端点 |
 * | `/api/knowledge-bases`、**`/api/mcp/servers`** | **`requireAuth`** | **无 owner 列** |
 * | `/api/agents` | `requireAuth` + **行级判定** | `01` 决策 18（创建者 + ADMIN） |
 *
 * ⇒ **一个 `requireAdmin` 都没有**，而且**刻意不做**"只有创建者能改/删"的收窄：
 * `mcp_servers.created_by` 只是**留痕**（前端显示"谁注册的"），不参与判定。
 * 代价是"任何登录用户都能改/删别人注册的 server"，这是 `01` 决策 22 的直接推论 ——
 * 要收紧得先改 `01`/`02`，**本批不自行发明权限模型**。
 * `verify:mcp-servers` 里有两条反向守卫盯着它（MEMBER 能改、MEMBER 能删别人建的）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 六条路由与它们的信封（第五族的形态见 `shared/src/mcp.ts` 的注释）
 * ─────────────────────────────────────────────────────────────────────
 *   GET    /            列表 → `{items,total,offset,limit}`
 *   POST   /            注册 → `{server,test}`（裸 item + 一次 best-effort 探测结果，**不是 201**）
 *   PATCH  /:id         改   → 裸 `McpServerItem`
 *   DELETE /:id         删   → `{id,name}`
 *   POST   /:id/test    测试 → **恒 200** + `{ok,tools}` / `{ok,error}`
 *   GET    /:id/tools   工具 → 裸 `{tools,fetchedAt,cached}`（本批纯读缓存）
 *
 * ⚠️ 凭据那三条（`/api/mcp/credentials**`）**属 P0-2-4**，**不要顺手补**：
 * 它们的收窄不在角色上而在 `user_id` 上（只能动自己的），且要有 `mcp_credentials` 表。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createMcpServerBodySchema,
  listMcpServersQuerySchema,
  mcpServerIdParamsSchema,
  ok,
  updateMcpServerBodySchema,
  type CreateMcpServerBody,
  type ListMcpServersQuery,
  type McpServerIdParams,
  type UpdateMcpServerBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createMcpServer,
  getMcpServerTools,
  listMcpServers,
  removeMcpServer,
  testMcpServer,
  updateMcpServer,
  type McpViewer,
} from '../services/mcpServer.service.js'

/**
 * 取调用者。用 `requireAuthContext` 而不是自己判 `request.auth === null`：本文件的每条路由
 * 都挂了 `requireAuth`，"走到 handler 就一定有身份"是那个中间件的契约；
 * 自己判会让"漏挂 preHandler"变成**静默的匿名可写**（而 `requireAuthContext` 会抛 401）。
 */
function viewerOf(request: FastifyRequest): McpViewer {
  return { userId: requireAuthContext(request).user.id }
}

export function registerMcpServerRoutes(app: FastifyInstance): void {
  /** 列表（登录即可；`03` §4.4 的 MCP 管理页表格） */
  app.get<{ Querystring: ListMcpServersQuery }>(
    '/api/mcp/servers',
    { preHandler: app.requireAuth, schema: { querystring: listMcpServersQuerySchema } },
    async (request) => ok(await listMcpServers(request.query)),
  )

  /**
   * 注册（登录即可）。成功返回 `200`（信封 `code=0` 是唯一契约，与 `/api/users`、`/api/models`、
   * `/api/knowledge-bases` 同口径，**不引入 201**）。
   *
   * ⚠️ **不要求上游可达**（`06` P0-2-2 验收门槛 4）：响应里的 `test` 是 best-effort 结论，
   * 失败**不影响注册成功**。注册信息变更会让工具缓存失效，见服务层。
   */
  app.post<{ Body: CreateMcpServerBody }>(
    '/api/mcp/servers',
    { preHandler: app.requireAuth, schema: { body: createMcpServerBodySchema } },
    async (request) => ok(await createMcpServer(request.body, viewerOf(request))),
  )

  /** 部分更新（登录即可）。`OAUTH` 400；注册信息变更 ⇒ 清工具缓存（语义在服务层收口） */
  app.patch<{ Params: McpServerIdParams; Body: UpdateMcpServerBody }>(
    '/api/mcp/servers/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: mcpServerIdParamsSchema, body: updateMcpServerBodySchema },
    },
    async (request) => ok(await updateMcpServer(request.params.id, request.body)),
  )

  /** 删除（登录即可）。被 Agent 绑定时 409（`agent_components` 是多态外键、没有 FK 兜底） */
  app.delete<{ Params: McpServerIdParams }>(
    '/api/mcp/servers/:id',
    { preHandler: app.requireAuth, schema: { params: mcpServerIdParamsSchema } },
    async (request) => ok(await removeMcpServer(request.params.id)),
  )

  /**
   * 连通测试（登录即可）。**HTTP 恒 200**，结论放在 `{ok,…}` 里。
   *
   * ⚠️ 语义是"探活端点自身是请求成功"（`02` §4.9 的 `/health` 同源口径）：
   * `ok:false` 是一条**信息**（这个 server 现在通不通），把它映射成 502/504 会让界面
   * 把"一个可用的结论"渲染成"一个错误"。只有 server 不存在才是 404（请求本身的问题）。
   *
   * ⚠️ **本层不带用户凭据**（P0-2-5 坑预判 1 定案）：`tools/list` 用"注册者视角"。
   * 有些 server 的 `tools/list` 也要求鉴权 —— 那时这里会如实报 `ok:false` + 可读原因。
   */
  app.post<{ Params: McpServerIdParams }>(
    '/api/mcp/servers/:id/test',
    { preHandler: app.requireAuth, schema: { params: mcpServerIdParamsSchema } },
    async (request) => ok(await testMcpServer(request.params.id)),
  )

  /** 工具列表（登录即可）。本批**纯读缓存**，不联网（P0-2-5 会加 `?refresh=1`） */
  app.get<{ Params: McpServerIdParams }>(
    '/api/mcp/servers/:id/tools',
    { preHandler: app.requireAuth, schema: { params: mcpServerIdParamsSchema } },
    async (request) => ok(await getMcpServerTools(request.params.id)),
  )
}
