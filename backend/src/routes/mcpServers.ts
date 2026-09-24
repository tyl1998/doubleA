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
 * （历史上 `verify:mcp-servers` 有两条反向守卫盯着它；该脚本随 2026-09-24 的定案移除，
 * 现在这两条要靠人工端测 —— 用 `MEMBER` 账号去改/删别人建的 server，看是不是 200。）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 六条路由与它们的信封（第五族的形态见 `shared/src/mcp.ts` 的注释）
 * ─────────────────────────────────────────────────────────────────────
 *   GET    /            列表 → `{items,total,offset,limit}`
 *   POST   /            注册 → `{server,test}`（裸 item + 一次 best-effort 探测结果，**不是 201**）
 *   PATCH  /:id         改   → **`{server,credentialSchemaImpact}`**（P0-2-3 加的复合响应）
 *   DELETE /:id         删   → `{id,name}`
 *   POST   /:id/test    测试 → **恒 200** + `{ok,tools}` / `{ok,error}`
 *   GET    /:id/tools   工具 → 裸 `{tools,fetchedAt,cached}`（**不传 `refresh` = 纯读缓存；
 *                        `?refresh=1` = 真拉一次并落库**，P0-2-5；拉不到且无缓存 ⇒ 502）
 *
 * ⚠️ **`PATCH` 的回包在 P0-2-3 变过一次**（原先是裸 item）：模板变更要带回一条"本次请求特有"的
 * 提示（`credentialSchemaImpact`），而进 item 就破了"全端点唯一形状"（P0-2-2 定案 ② 的同一条
 * 理由）⇒ 走 `{server, credentialSchemaImpact}` 这条复合响应的路，与 `POST /` 的 `{server,test}` 同族。
 * `credentialSchemaImpact` 为 `null` = 本次没有需要提示的影响（没提交模板 / 提交了但等价），
 * 且**它只提示、绝不自动删任何已存凭据**（P0-2-3 坑预判 2）。
 *
 * ⚠️ 凭据那三条（`/api/mcp/credentials**`）**属 P0-2-4**（已落地）：它们的收窄不在角色上、
 * 而在 `user_id` 上（只能动自己的）—— 与本文件的 `/api/mcp/servers/**` **同一个前缀却刻意两族**，
 * 别照抄（差别见 `routes/mcpCredentials.ts` 文件头）。
 *
 * ⚠️ **工具列表与连通测试都**不带用户凭据**（P0-2-5 坑预判 1 的定案）**：`tools/list` 走
 * "注册者视角"，于是 `tool_cache` 也是**每个 server 一份、全员共享**的（与用户无关）。
 * 有些 server 要求 `tools/list` 也鉴权 ⇒ 那时如实报出"本阶段不支持带用户凭据拉列表"
 * （文案在 `mcp/errors.ts`、按 `stage` 分支）——**不要**顺手带上某个人的凭据：
 * 那会造出"工具列表依赖谁先点过测试"的诡异状态。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createMcpServerBodySchema,
  listMcpServersQuerySchema,
  mcpServerIdParamsSchema,
  mcpServerToolsQuerySchema,
  ok,
  updateMcpServerBodySchema,
  type CreateMcpServerBody,
  type ListMcpServersQuery,
  type McpServerIdParams,
  type McpServerToolsQuery,
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

  /**
 * 部分更新（登录即可）。三条闸门的位置要点：
 *   · `OAUTH` 400 与**模板深度校验**（P0-2-3）都在**路由级 schema** 上 ⇒ 校验失败时
 *     服务层根本不会被调用（"先校验、后写库"这条在框架层就成立了）；
 *   · 注册信息变更 ⇒ 清工具缓存，语义在服务层收口；
 *   · 模板变更 ⇒ 回包里带 `credentialSchemaImpact`（**只提示、不删任何已存凭据**）。
 */
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

  /**
   * 工具列表（登录即可）。**不传 `refresh` = 纯读缓存**（绝不联网、无副作用）；
   * **`?refresh=1` = 真拉一次并落库**（P0-2-5）。
   *
   * ⚠️ 两个出口的分界（`02` §九 / 服务层文件头 ⑦）：拉不到但**有缓存 ⇒ 200**（回缓存、
   * `cached:true`）；拉不到且**缓存空 ⇒ 502** —— 那时唯一的"成功响应"只能是 `{tools:[]}`，
   * 而它会冒充"这个 server 没有工具"。这与 `POST /:id/test` **恒 200** 不冲突：
   * 那个端点的形状里**有** `{ok:false,error}` 这个位置来承载"连不上"。
   *
   * `refresh` 的取值域是白名单（`1`/`0`/`true`/`false`），**拼错就是 400** ——
   * 见 `shared#mcpServerToolsQuerySchema` 的注释（`z.coerce.boolean()` 会把 `'0'` 判成真）。
   */
  app.get<{ Params: McpServerIdParams; Querystring: McpServerToolsQuery }>(
    '/api/mcp/servers/:id/tools',
    {
      preHandler: app.requireAuth,
      schema: { params: mcpServerIdParamsSchema, querystring: mcpServerToolsQuerySchema },
    },
    async (request) =>
      ok(await getMcpServerTools(request.params.id, { refresh: request.query.refresh })),
  )
}
