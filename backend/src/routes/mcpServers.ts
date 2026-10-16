/**
 * MCP server 路由（P0-2-2）
 *
 * 依据：`docs/02-后端设计.md` §4.7（`/api/mcp/servers[…/:id]` 六条）+ §四 约定
 *      + `docs/06-实施计划.md` §四 4.2（第五族权限）与 `docs/归档/06-P0-2-实施步骤.md` P0-2-2（内容 / 验收门槛）
 *      + `03` §4.4（MCP 管理页）、`01` §3.6（决策 22：全员可注册）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：**建/看登录即可；改/删 = 注册者 + ADMIN**（⚠️ P0-2-12 改过口径）
 * ─────────────────────────────────────────────────────────────────────
 * **原文（P0-2-2）是"`/api/mcp/**` 一律登录即可、没有 owner 列收窄、最接近 knowledge-bases"**；
 * 2026-09-24 收窄了**改/删**那两条。四族的现状：
 *
 * | 资源 | 路由挂什么 | 判据 |
 * |------|-----------|------|
 * | `/api/users`、`/api/model-providers`、`/api/models` | `requireAdmin` | `(A)` 端点 |
 * | `/api/knowledge-bases` | `requireAuth` | **无 owner 列** |
 * | **`/api/mcp/servers`** | **`requireAuth`** + **改/删行级判定** | `mcp_servers.created_by` ⇒ `shared#canEditMcpServer` |
 * | `/api/agents` | `requireAuth` + **行级判定** | `01` 决策 18（创建者 + ADMIN） |
 *
 * ⇒ 仍然**一个 `requireAdmin` 都没有**（行级判定**不走路由钩子**，与 `agents` 同款实现）：
 * 服务层**先 404 再 403**。⚠️ **2026-10-16 修订（用户定案）**：`POST /:id/test` **改为行级判定**
 * —— 它用的是**所属人**的凭据，让任何登录用户都能点等于"拿别人的凭据去探活"；现在只有
 * 所属人或 ADMIN 能发起（不可见先 404、可见非所属人 403）。
 * `GET /:id/tools`（**纯读缓存**）仍不判定 —— 它是"看"，收窄它只会造出"server 建完就没人能看工具了"。
 * ⚠️ 与 `/api/mcp/credentials/**` **同一个前缀却仍是两族**（那边按 `user_id` 收窄、ADMIN 无后门，
 * 见那个文件头）—— 别照抄。
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
 * ⚠️ **工具列表与连通测试用**注册者（所属人）的凭据**（P0-2-12；原文是"都不带用户凭据"）**：
 * `tools/list` 的主语是 `mcp_servers.created_by` ⇒ `tool_cache` 仍是**每个 server 一份、
 * 全员共享**的，与"谁点的测试"无关（**串用户**被结构性排除掉了）。
 * ⚠️ 这**不是**"顺手带上某个人的凭据"—— 那正是原文要挡的；换主语的正当理由是
 * **注册者唯一确定**（见 `services` 文件头 ⑤）。
 * 注册者没配齐必填凭据时**不发起上游请求**（`ok:false` 点名"所属人尚未配置"）。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createMcpServerBodySchema,
  listMcpServersQuerySchema,
  mcpServerIdParamsSchema,
  mcpServerToolsQuerySchema,
  ok,
  transferAssetBodySchema,
  updateMcpServerBodySchema,
  type CreateMcpServerBody,
  type ListMcpServersQuery,
  type McpServerIdParams,
  type McpServerToolsQuery,
  type TransferAssetBody,
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
  transferMcpServer,
  updateMcpServer,
  type McpViewer,
} from '../services/mcpServer.service.js'

/**
 * 取调用者。用 `requireAuthContext` 而不是自己判 `request.auth === null`：本文件的每条路由
 * 都挂了 `requireAuth`，"走到 handler 就一定有身份"是那个中间件的契约；
 * 自己判会让"漏挂 preHandler"变成**静默的匿名可写**（而 `requireAuthContext` 会抛 401）。
 *
 * ⚠️ P0-2-12 起要带上 `role`：改/删的**行级判定**（`shared#canEditMcpServer`）要用它判
 * "ADMIN 也算"。少带它编译期就过不去（`McpViewer.role` 是必填）。
 */
function viewerOf(request: FastifyRequest): McpViewer {
  const { user } = requireAuthContext(request)
  return { userId: user.id, role: user.role }
}

export function registerMcpServerRoutes(app: FastifyInstance): void {
  /** 列表（登录即可 —— **看**不收窄；每项带 `canEdit`，`03` §4.4 的 MCP 管理页据此决定按钮） */
  app.get<{ Querystring: ListMcpServersQuery }>(
    '/api/mcp/servers',
    { preHandler: app.requireAuth, schema: { querystring: listMcpServersQuerySchema } },
    async (request) => ok(await listMcpServers(request.query, viewerOf(request))),
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
 * 部分更新（**只有注册者或 ADMIN** —— P0-2-12 起；原文"登录即可"已作废）。三条闸门的位置要点：
 *   · `OAUTH` 400 与**模板深度校验**（P0-2-3）都在**路由级 schema** 上 ⇒ 校验失败时
 *     服务层根本不会被调用（"先校验、后写库"这条在框架层就成立了）；
 *   · **行级判定在服务层**（先 404 再 403）—— 它要读那一行才知道 `created_by`，路由层拿不到；
 *   · 注册信息变更 ⇒ 清工具缓存，语义在服务层收口；
 *   · 模板变更 ⇒ 回包里带 `credentialSchemaImpact`（**只提示、不删任何已存凭据**）。
 */
  app.patch<{ Params: McpServerIdParams; Body: UpdateMcpServerBody }>(
    '/api/mcp/servers/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: mcpServerIdParamsSchema, body: updateMcpServerBodySchema },
    },
    async (request) => ok(await updateMcpServer(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 删除（**只有注册者或 ADMIN** —— P0-2-12 起）。被 Agent 绑定时 409
   * （`agent_components` 是多态外键、没有 FK 兜底）；⚠️ 它还会**连带删掉所有人的凭据**
   * （`mcp_credentials` 是 `ON DELETE CASCADE`）⇒ 权限必须收窄。
   */
  app.delete<{ Params: McpServerIdParams }>(
    '/api/mcp/servers/:id',
    { preHandler: app.requireAuth, schema: { params: mcpServerIdParamsSchema } },
    async (request) => ok(await removeMcpServer(request.params.id, viewerOf(request))),
  )

  /**
   * 转移所属人（P1-13，**注册者或 ADMIN**）。`{ toUserId }`。
   * ⚠️ **MCP 特例**：转移后**探测主语**变为新所属人 —— 若新所属人没配该 server 的凭据，
   * 测试/工具列表会失败（`tools/call` 仍用调用者自己的凭据）。前端弹窗须提示。
   */
  app.post<{ Params: McpServerIdParams; Body: TransferAssetBody }>(
    '/api/mcp/servers/:id/transfer',
    {
      preHandler: app.requireAuth,
      schema: { params: mcpServerIdParamsSchema, body: transferAssetBodySchema },
    },
    async (request) =>
      ok(await transferMcpServer(request.params.id, request.body.toUserId, viewerOf(request))),
  )

  /**
   * 连通测试（**登录即可 + 所属人/ADMIN 行级**）。**HTTP 恒 200**，结论放在 `{ok,…}` 里。
   *
   * ⚠️ 语义是"探活端点自身是请求成功"（`02` §4.9 的 `/health` 同源口径）：
   * `ok:false` 是一条**信息**（这个 server 现在通不通），把它映射成 502/504 会让界面
   * 把"一个可用的结论"渲染成"一个错误"。只有 server 不存在才是 404（请求本身的问题）。
   *
   * ⚠️ **2026-10-16 修订（用户定案）**：只有**所属人或 ADMIN** 能发起（服务层先 404 再 403）——
   * 这条探测用**所属人的凭据**，不该让任何登录用户都能拿它去探活。
   *
   * ⚠️ **P0-2-12 起它用注册者（所属人）的凭据**（原文"本层不带用户凭据"已作废）：
   * 有些 server 的 `tools/list` 也要求鉴权 —— 以前那类 server 在这里恒 401（⇒ 工具数恒 0
   * ⇒ 对话里永远触发不了工具），现在带**注册者**的凭据就能拉到。
   * ⚠️ 注册者没配齐必填凭据时**不发起上游请求**，`ok:false` 的文案点名"所属人尚未配置"。
   */
  app.post<{ Params: McpServerIdParams }>(
    '/api/mcp/servers/:id/test',
    { preHandler: app.requireAuth, schema: { params: mcpServerIdParamsSchema } },
    async (request) => ok(await testMcpServer(request.params.id, viewerOf(request))),
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
      ok(
        await getMcpServerTools(
          request.params.id,
          { refresh: request.query.refresh },
          viewerOf(request),
        ),
      ),
  )
}
