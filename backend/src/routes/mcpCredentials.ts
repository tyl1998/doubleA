/**
 * MCP 凭据路由（P0-2-4）
 *
 * 依据：`docs/02-后端设计.md` §4.7（`/api/mcp/credentials**` 三条）+ §九（核心定制点）
 *      + `docs/归档/06-P0-2-实施步骤.md` P0-2-4（内容 / 验收门槛 / 坑预判）+ `03` §4.5（我的凭据页）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：**权限收窄不在角色上，而在 `user_id` 上**
 * ─────────────────────────────────────────────────────────────────────
 * 与隔壁 `mcpServers.ts` 刻意形成对照（值得连着读）：
 *
 * | 资源 | 挂什么 | 判据 | ADMIN |
 * |------|--------|------|-------|
 * | `/api/mcp/servers**` | `requireAuth` | **没有 owner 列**：人人可改可删（第五族） | 无特殊 |
 * | **`/api/mcp/credentials**`** | **`requireAuth`** | **`user_id` 收窄**（第四族，与 conversations 同源） | **也没有后门** |
 *
 * ⇒ 两条路由挂的都是 `requireAuth`（**不是** `requireAdmin` —— 凭据是"每个登录用户自己的东西"，
 * 不是管理员的配置），而"只能动自己的"这条**由服务层的 `viewer.userId` 收窄**：
 * `where: { serverId, userId }`，别人的行进不了读写路径。
 * ⚠️ 路径里**没有凭据行 id**（只有 `:serverId`）：行由 `(serverId, 我)` 推出来 ——
 * 少一个 id 就少一整类"能不能删别人的行"的问题。
 * ⚠️ 他人的凭据**不存在 403 这种反馈**：`PUT` 别人的 serverId 不是越权（那台 server 上
 * **我**的那份本来就可以写），`DELETE` 没配过的东西是 **404**。整个文件里没有"403"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条路由与它们的信封
 * ─────────────────────────────────────────────────────────────────────
 *   GET    /              → `{items, unconfigured}`（**刻意不分页**，见 shared 的注释）
 *   PUT    /:serverId     → **裸条目**（`McpCredentialItem`，与"其余 create/update 是裸 item"同口径）
 *   DELETE /:serverId     → `{serverId, serverName}`（"删类多回 `{id,<name>}`"这一族的写法）
 *
 * ⚠️ **`PUT` 是合并语义**（只动提交里出现的 key），与 P0-1 的 `components`（整体替换）**刻意相反**：
 * 值不下发（连掩码都没有）⇒ 前端无从回填 ⇒ 整体替换会静默清空用户没填的 key。
 * 分辨方式只有一个：**不可回填的字段只能合并**。见 `shared#putMyCredentialBodySchema`。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  mcpCredentialServerIdParamsSchema,
  ok,
  putMyCredentialBodySchema,
  type McpCredentialServerIdParams,
  type PutMyCredentialBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  listMyCredentials,
  putMyCredential,
  removeMyCredential,
  type McpCredentialViewer,
} from '../services/mcpCredential.service.js'

/**
 * 取调用者。用 `requireAuthContext` 而不是自己判 `request.auth === null`：
 * 本文件每条路由都挂了 `requireAuth`，"走到 handler 就一定有身份"是那个中间件的契约；
 * 自己判会让"漏挂 preHandler"变成**静默的匿名可写**（而 `requireAuthContext` 会抛 401）。
 * ⚠️ 这里的 `userId` 是**权限本身**（不是留痕）：服务层拿它当 `where` 的一部分。
 */
function viewerOf(request: FastifyRequest): McpCredentialViewer {
  return { userId: requireAuthContext(request).user.id }
}

export function registerMcpCredentialRoutes(app: FastifyInstance): void {
  /**
   * 我的凭据清单（登录即可）。`03` §4.5 的两面一起给：
   * `items`（按 server 分组渲染表单）+ `unconfigured`（置顶提示"哪些 server 还没配"）。
   */
  app.get('/api/mcp/credentials', { preHandler: app.requireAuth }, async (request) =>
    ok(await listMyCredentials(viewerOf(request))),
  )

  /**
   * 保存我的凭据（登录即可）。**合并语义**（见文件头），响应是**裸条目**。
   *
   * 校验分工：形状与值长在路由级 schema（400 走统一信封）；"key 在不在模板里"必须查库，
   * 在服务层（`VALIDATION` 400，消息只列**键名**，绝不含值）。
   */
  app.put<{ Params: McpCredentialServerIdParams; Body: PutMyCredentialBody }>(
    '/api/mcp/credentials/:serverId',
    {
      preHandler: app.requireAuth,
      schema: { params: mcpCredentialServerIdParamsSchema, body: putMyCredentialBodySchema },
    },
    async (request) => ok(await putMyCredential(request.params.serverId, request.body, viewerOf(request))),
  )

  /**
   * 删除我的凭据（登录即可）。⚠️ **本来就没配 ⇒ 404**（不是幂等 200）：
   * 删的是"我的那一份"，"你没有可删的东西"比"删除成功"更准确。
   */
  app.delete<{ Params: McpCredentialServerIdParams }>(
    '/api/mcp/credentials/:serverId',
    { preHandler: app.requireAuth, schema: { params: mcpCredentialServerIdParamsSchema } },
    async (request) => ok(await removeMyCredential(request.params.serverId, viewerOf(request))),
  )
}
