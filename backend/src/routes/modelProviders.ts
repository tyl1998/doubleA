/**
 * 模型池 · Provider 路由（P0-1-10，`(A)` 仅 ADMIN）
 *
 * 依据：`docs/02-后端设计.md` §4.3 四个端点 + §四 约定（`(A)` = 仅 ADMIN、列表 offset/limit）
 *
 * 职责边界：校验请求（schema）→ 调 `services/model.service` → 组装信封。
 * 权限用 `preHandler: app.requireAdmin` 声明；业务约束（Key 加密、删除/改类型的守卫）在服务层。
 *
 * ⚠️ 与 `/api/users` 一样，这四个端点**不在**首登改密闸门的白名单里 ——
 * `must_change_password=true` 的 admin 调它们会先被闸门 403（正确的：强制改密期间只能改密）。
 *
 * `apiKey` 只出现在**请求**方向（`POST`/`PATCH` 的 body）；**响应方向永远没有它**
 * （`02` §十 不变式，出口只有 `model.service.ts` 的 `toItem`）。
 */

import {
  createModelProviderBodySchema,
  listModelProvidersQuerySchema,
  modelProviderIdParamsSchema,
  ok,
  setProviderUserCredentialBodySchema,
  transferAssetBodySchema,
  updateModelProviderBodySchema,
  type AssetViewer,
  type CreateModelProviderBody,
  type ListModelProvidersQuery,
  type ModelProviderIdParams,
  type SetProviderUserCredentialBody,
  type TransferAssetBody,
  type UpdateModelProviderBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createModelProvider,
  deleteMyProviderCredential,
  getMyProviderCredential,
  getProviderBoundModels,
  listModelProviders,
  listMyProviderCredentials,
  listProviderRemoteModels,
  removeModelProvider,
  setMyProviderCredential,
  transferModelProvider,
  updateModelProvider,
} from '../services/model.service.js'

/**
 * 取调用者（P1-13 起模型池由 `(A)` 放宽为"登录 + 行级"）：
 * 列表按"对我可见"过滤（P1-18：访问 = 所属人 + ADMIN），编/删/转移在服务层按 `canEditAsset` 判定。
 */
function viewerOf(request: FastifyRequest): AssetViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

export function registerModelProviderRoutes(app: FastifyInstance): void {
  /** 列表（P1-13：登录即可；按"对我可见"过滤 —— 公开 / 我的 / 分享给我的） */
  app.get<{ Querystring: ListModelProvidersQuery }>(
    '/api/model-providers',
    { preHandler: app.requireAuth, schema: { querystring: listModelProvidersQuerySchema } },
    async (request) => ok(await listModelProviders(request.query, viewerOf(request))),
  )

  /**
   * 新建（P1-13：登录即可；`createdBy` = 调用者，成为所属人）。
   * 可见性默认按角色（ADMIN → `PUBLIC` 系统级、非 ADMIN → `PRIVATE`）；非 ADMIN 传 `PUBLIC` ⇒ 403。
   * `apiKey` 可选（先建后配是正常流程），给了就**加密落库**。
   */
  app.post<{ Body: CreateModelProviderBody }>(
    '/api/model-providers',
    { preHandler: app.requireAuth, schema: { body: createModelProviderBodySchema } },
    async (request) => ok(await createModelProvider(request.body, viewerOf(request))),
  )

  /** 部分更新（P1-13：登录即可进入，行级判定：所属人或 ADMIN）。`apiKey` 三态见 shared 契约 */
  app.patch<{ Params: ModelProviderIdParams; Body: UpdateModelProviderBody }>(
    '/api/model-providers/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: modelProviderIdParamsSchema, body: updateModelProviderBodySchema },
    },
    async (request) => ok(await updateModelProvider(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 转移所属人（P1-13，**所属人或 ADMIN**）。`{ toUserId }`。
   */
  app.post<{ Params: ModelProviderIdParams; Body: TransferAssetBody }>(
    '/api/model-providers/:id/transfer',
    {
      preHandler: app.requireAuth,
      schema: { params: modelProviderIdParamsSchema, body: transferAssetBodySchema },
    },
    async (request) =>
      ok(await transferModelProvider(request.params.id, request.body.toUserId, viewerOf(request))),
  )

  /**
   * P1-18：「我的凭据」页的 Provider 凭据清单（登录即可）——**只列"我自己的"**。
   *
   * 列**我作为所属人**的 Provider（任何模式；`SHARED` 共享 Key 只给所属人看）+ 我通过 Agent 可能用到的
   * `PER_USER` Provider（含未配置，便于就地配置）。与我无关的 `SHARED` 一律不列。
   * ⚠️ 静态段优先于 `/:id`，不冲突。
   */
  app.get(
    '/api/model-providers/my-credentials',
    { preHandler: app.requireAuth },
    async (request) => ok({ items: await listMyProviderCredentials(viewerOf(request)) }),
  )

  /**
   * P1-18：**我的 Key**（`credentialMode=PER_USER` 时生效）—— 读状态（仅布尔 + 掩码，无明文）。
   * **登录即可**：任何登录用户都能读**自己**的状态（凭据是个人隐私，ADMIN 无后门）。
   */
  app.get<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id/my-credential',
    { preHandler: app.requireAuth, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await getMyProviderCredential(request.params.id, viewerOf(request))),
  )

  /** P1-18：写入/替换**我的 Key**（登录即可；只影响调用者自己那一行）。 */
  app.put<{ Params: ModelProviderIdParams; Body: SetProviderUserCredentialBody }>(
    '/api/model-providers/:id/my-credential',
    {
      preHandler: app.requireAuth,
      schema: { params: modelProviderIdParamsSchema, body: setProviderUserCredentialBodySchema },
    },
    async (request) =>
      ok(await setMyProviderCredential(request.params.id, request.body.apiKey, viewerOf(request))),
  )

  /** P1-18：清空**我的 Key**（登录即可；幂等）。 */
  app.delete<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id/my-credential',
    { preHandler: app.requireAuth, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await deleteMyProviderCredential(request.params.id, viewerOf(request))),
  )

  /**
   * 拉取上游模型列表（P0-1-12；P1-13 起登录 + 行级）。
   * 只读、不落库；**不要求 Provider 启用、也不要求配 Key**（诊断场景）。仅所属人 / ADMIN。
   */
  app.get<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id/remote-models',
    { preHandler: app.requireAuth, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await listProviderRemoteModels(request.params.id, viewerOf(request))),
  )

  /**
   * 删除前列出"其下被在线智能体绑定的模型"（需求 3）：删除弹窗据此如实展示影响范围。
   * 只读、不落库。P1-13：登录 + 可见性判定。
   */
  app.get<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id/bound-models',
    { preHandler: app.requireAuth, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await getProviderBoundModels(request.params.id, viewerOf(request))),
  )

  /**
   * 删除（P1-13：登录 + 行级判定：所属人或 ADMIN）。其下 `models` 级联删除；引用这些模型的
   * **在线**智能体由 `agents.model_id` 的 `ON DELETE SET NULL` **自动解绑**。
   */
  app.delete<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id',
    { preHandler: app.requireAuth, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await removeModelProvider(request.params.id, viewerOf(request))),
  )
}
