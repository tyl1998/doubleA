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
  updateModelProviderBodySchema,
  type CreateModelProviderBody,
  type ListModelProvidersQuery,
  type ModelProviderIdParams,
  type UpdateModelProviderBody,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import {
  createModelProvider,
  listModelProviders,
  listProviderRemoteModels,
  removeModelProvider,
  updateModelProvider,
} from '../services/model.service.js'

export function registerModelProviderRoutes(app: FastifyInstance): void {
  /** 列表（`02` §4.3）：offset/limit 分页，默认 20；Key 只以掩码形式出现 */
  app.get<{ Querystring: ListModelProvidersQuery }>(
    '/api/model-providers',
    { preHandler: app.requireAdmin, schema: { querystring: listModelProvidersQuerySchema } },
    async (request) => ok(await listModelProviders(request.query)),
  )

  /**
   * 新建（`02` §4.3）：`apiKey` 可选（先建后配是正常流程），给了就**加密落库**。
   * 成功仍返回 `200`（与 `/api/users` 同口径：信封的 `code=0` 是唯一契约，不引入 201）。
   */
  app.post<{ Body: CreateModelProviderBody }>(
    '/api/model-providers',
    { preHandler: app.requireAdmin, schema: { body: createModelProviderBodySchema } },
    async (request) => ok(await createModelProvider(request.body)),
  )

  /** 部分更新：`apiKey` 三态（缺省不动 / `null` 清空 / 有值写入）见 shared 的契约注释 */
  app.patch<{ Params: ModelProviderIdParams; Body: UpdateModelProviderBody }>(
    '/api/model-providers/:id',
    {
      preHandler: app.requireAdmin,
      schema: { params: modelProviderIdParamsSchema, body: updateModelProviderBodySchema },
    },
    async (request) => ok(await updateModelProvider(request.params.id, request.body)),
  )

  /**
   * 拉取上游模型列表（P0-1-12；`02` §4.3）。
   *
   * 为什么挂在 Provider 下而不是模型下：它有 `baseUrl` 与 Key 这两个前提，
   * 而这两个都在 Provider 上；挂这里正好表达"探的是这个配置"。
   *
   * 这是一条**子路径**（`/:id/remote-models`），不是"用查询参数分流" —— 与 P0-1-11 的结论一致：
   * 同路径同方法注册两次会在**启动期**抛 `FST_ERR_DUPLICATED_ROUTE`，只能拆路径。
   *
   * 只读、不落库、不改任何数据；**不要求 Provider 启用、也不要求配 Key**
   * （诊断场景，理由见 `services/model.service.ts#listProviderRemoteModels`）。
   */
  app.get<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id/remote-models',
    { preHandler: app.requireAdmin, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await listProviderRemoteModels(request.params.id)),
  )

  /**
   * 删除（`02` §4.3）：其下 `models` 级联删除；但只要有一个模型被 Agent 引用，
   * 就会在服务层被 409 拦下（`agents.model_id` 是 RESTRICT，见 `02` §三 删除语义）。
   */
  app.delete<{ Params: ModelProviderIdParams }>(
    '/api/model-providers/:id',
    { preHandler: app.requireAdmin, schema: { params: modelProviderIdParamsSchema } },
    async (request) => ok(await removeModelProvider(request.params.id)),
  )
}
