/**
 * 开放平台 Key 的内部管理路由（**P1-22**；`docs/08` §8「管理面」）
 *
 * | 方法 | 路径 | 说明 |
 * |------|------|------|
 * | GET | `/api/open-keys?agentId=&includeInactive=` | **我名下的** Key（可按智能体过滤） |
 * | POST | `/api/open-keys` | 签发；`agentId` 在**体里** |
 * | PUT | `/api/open-keys/:keyId` | 编辑元数据（**合并语义**；明文/`agentId` 不可改，已吊销 409；即删缓存键） |
 * | DELETE | `/api/open-keys/:keyId` | 吊销（幂等） |
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么是 `/api/open-keys` 而不是 `/api/agents/:id/open-keys`（2026-10-22 用户定案）
 * ─────────────────────────────────────────────────────────────────────
 * Key 的主语是「**我** × 这个智能体」。挂在 `/api/agents/:id/...` 下读起来像"这个智能体的 Key"，
 * 于是编辑页上放它会让其他受众以为"给这个智能体开了 Key ⇒ 大家都能用"——语义是错的。
 * 按人组织（入口在「我的凭据」的新 tab）后：
 *   · 列表天然是"我给了谁什么"（别人签的 Key 我看不到，也不需要看）；
 *   · **关联哪个智能体**变成签发时的一个字段（`body.agentId`），判据是"这个智能体我能不能看见"
 *     （所属人 / ADMIN / `SHARED` 受众 —— 受众给自己签 Key 正是 R3 允许的那条）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 三条刻意的口径
 * ─────────────────────────────────────────────────────────────────────
 * · **preHandler 只用 `requireAuth`**，判权全在服务层的行级判定里（与 `routes/agents.ts` 同一家族）；
 * · **不做 `/open/v1/admin/*`**（Q13）：Key 的签发/吊销只在平台界面里，外部拿 Key 永远签不出新 Key；
 * · **明文只出现在 POST 的响应里**（一次）：其余三个端点返回的投影永不含它。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createOpenApiKeyBodySchema,
  listOpenApiKeysQuerySchema,
  ok,
  openApiKeyIdParamsSchema,
  updateOpenApiKeyBodySchema,
  type CreateOpenApiKeyBody,
  type ListOpenApiKeysQuery,
  type OpenApiKeyIdParams,
  type UpdateOpenApiKeyBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createOpenApiKey,
  listOpenApiKeys,
  revokeOpenApiKey,
  updateOpenApiKey,
  type OpenKeyViewer,
} from '../services/openApiKey.service.js'

/** 取调用者（`id` + `role`）：判权的两个输入，与 `routes/agents.ts#viewerOf` 同款 */
function viewerOf(request: FastifyRequest): OpenKeyViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

export function registerOpenApiKeyRoutes(app: FastifyInstance): void {
  /** 我的 Key（默认含失效的；`agentId` 可选过滤） */
  app.get<{ Querystring: ListOpenApiKeysQuery }>(
    '/api/open-keys',
    { preHandler: app.requireAuth, schema: { querystring: listOpenApiKeysQuerySchema } },
    async (request) => {
      const { agentId, includeInactive } = request.query
      return ok(
        await listOpenApiKeys({ includeInactive, ...(agentId === undefined ? {} : { agentId }) }, viewerOf(request)),
      )
    },
  )

  /**
   * 签发。**响应里的 `plaintext` 只此一次** —— 前端必须当场展示并提供复制按钮
   * （`docs/08` §8 的"创建后一次性弹明文 + 复制按钮"）。
   */
  app.post<{ Body: CreateOpenApiKeyBody }>(
    '/api/open-keys',
    { preHandler: app.requireAuth, schema: { body: createOpenApiKeyBodySchema } },
    async (request) => ok(await createOpenApiKey(request.body, viewerOf(request))),
  )

  /** 编辑元数据（合并语义；**即删缓存键** ⇒ 新策略立即生效，见 service ②/③） */
  app.put<{ Params: OpenApiKeyIdParams; Body: UpdateOpenApiKeyBody }>(
    '/api/open-keys/:keyId',
    {
      preHandler: app.requireAuth,
      schema: { params: openApiKeyIdParamsSchema, body: updateOpenApiKeyBodySchema },
    },
    async (request) =>
      ok(await updateOpenApiKey(request.params.keyId, request.body, viewerOf(request))),
  )

  /** 吊销（**幂等**；立即删缓存 ⇒ 外部下一次请求就是 401） */
  app.delete<{ Params: OpenApiKeyIdParams }>(
    '/api/open-keys/:keyId',
    { preHandler: app.requireAuth, schema: { params: openApiKeyIdParamsSchema } },
    async (request) => ok(await revokeOpenApiKey(request.params.keyId, viewerOf(request))),
  )
}
