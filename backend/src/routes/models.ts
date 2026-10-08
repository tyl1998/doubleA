/**
 * 模型池 · 模型路由（P0-1-11）
 *
 * 依据：`docs/02-后端设计.md` §4.3（模型管理四端点 + 全员可选模型列表）+ §四 约定。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：同前缀下**两套权限、两套投影**
 * ─────────────────────────────────────────────────────────────────────
 *
 * `02` §4.3 原本把"管理列表"和"全员可选列表"都写成 `GET /api/models`，`06` 的坑预判也
 * 点了这个雷（"用方法+查询参数分流"）。实际做下来，**按调用者角色决定返回哪套投影是错的**，
 * 而且用一个可验证的反例就能推翻：
 *
 *   `03` §4.2 的智能体编辑页用同一份模型列表渲染下拉。ADMIN 也要建智能体。
 *   若"是不是 ADMIN"决定投影，那么 ADMIN 的下拉里会出现 `enabled=false` 的模型 ——
 *   直接违反 `01` §3.2 的验收要点「无效模型创建 Agent 时不可选」。
 *
 * 所以这里按**用途**分路径（与身份无关）：
 *   · `GET /api/models`            —— 管理列表，`(A)` 仅 ADMIN，`ModelItem` 投影（含停用项）
 *   · `GET /api/models/available`  —— 可选列表，登录即可，`ModelOption` 投影（按定义全是能用的）
 *
 * 这与 `/api/users`、`/api/model-providers` 的摆法一致：**资源根的 `(A)` CRUD 在根路径**，
 * "视图型"的子集走子路径。（`03` §116 的 `GET /api/models?type=CHAT` 已在本批同步改口径。）
 *
 * 附带澄清 `06` 坑预判里的"注意路由注册顺序"：`/api/models/available` 是**静态段**，
 * 而本项目在 `/api/models/:id` 上只注册了 `PATCH`/`DELETE`（没有 `GET`），
 * 两条 `GET` 的路径本就不同 —— 也就是说这里**不存在**被参数路由抢先匹配的问题。
 * 真正会炸的是"同路径注册两个 GET"（Fastify 在注册期就抛 `FST_ERR_DUPLICATED_ROUTE`），
 * 分路径正是为了避开它。verify 脚本有一条断言守着"available 没被 `:id` 吞掉"。
 */

import {
  createModelBodySchema,
  listAvailableModelsQuerySchema,
  listModelsQuerySchema,
  modelIdParamsSchema,
  ok,
  probeChatBodySchema,
  probeEmbeddingBodySchema,
  updateModelBodySchema,
  type CreateModelBody,
  type ListAvailableModelsQuery,
  type ListModelsQuery,
  type ModelIdParams,
  type ProbeChatBody,
  type ProbeEmbeddingBody,
  type UpdateModelBody,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import {
  createModel,
  listAvailableModels,
  listModels,
  probeModelChat,
  probeModelEmbedding,
  removeModel,
  updateModel,
} from '../services/model.service.js'

export function registerModelRoutes(app: FastifyInstance): void {
  // ── ① 全员可选列表（登录即可，**不带** requireAdmin）──
  // 注册在前只是排版习惯（两条 GET 路径不同，先后无影响）。
  // 首登强制改密期的用户会被根级闸门先拦成 403 —— 正确的：还没改密就不该建 Agent。
  app.get<{ Querystring: ListAvailableModelsQuery }>(
    '/api/models/available',
    { preHandler: app.requireAuth, schema: { querystring: listAvailableModelsQuerySchema } },
    async (request) => ok({ items: await listAvailableModels(request.query) }),
  )

  // ── ② 管理列表（仅 ADMIN）──
  // 与可选列表的差别：看得见 `enabled=false` 的模型、要分页、带 `agentCount` 等管理字段。
  app.get<{ Querystring: ListModelsQuery }>(
    '/api/models',
    { preHandler: app.requireAdmin, schema: { querystring: listModelsQuerySchema } },
    async (request) => ok(await listModels(request.query)),
  )

  /**
   * 新建（仅 ADMIN）。成功返回 `200`（信封的 `code=0` 是唯一契约，与 `/api/users`、
   * `/api/model-providers` 同口径，不引入 201）。
   */
  app.post<{ Body: CreateModelBody }>(
    '/api/models',
    { preHandler: app.requireAdmin, schema: { body: createModelBodySchema } },
    async (request) => ok(await createModel(request.body)),
  )

  /**
   * 探测向量模型维度（仅 ADMIN）：按表单值试发一次 embedding，**不落库**。
   *
   * 静态段 `/probe-embedding` 与 `POST /api/models`、`PATCH|DELETE /api/models/:id` 路径不同，
   * 不存在被参数路由抢先匹配的问题（见文件头）。
   */
  app.post<{ Body: ProbeEmbeddingBody }>(
    '/api/models/probe-embedding',
    { preHandler: app.requireAdmin, schema: { body: probeEmbeddingBodySchema } },
    async (request) => ok(await probeModelEmbedding(request.body)),
  )

  /**
   * 对话模型连通测试（仅 ADMIN；P1-1）：按表单值试发一次极小对话（`max_tokens: 1`），
   * **不落库**。与 `/probe-embedding` 同款——静态段、不会被 `:id` 参数路由抢先匹配。
   */
  app.post<{ Body: ProbeChatBody }>(
    '/api/models/probe-chat',
    { preHandler: app.requireAdmin, schema: { body: probeChatBodySchema } },
    async (request) => ok(await probeModelChat(request.body)),
  )

  /** 部分更新（仅 ADMIN）。三条守卫（迁移 Provider / 改 type 有引用 / 唯一冲突）在服务层 */
  app.patch<{ Params: ModelIdParams; Body: UpdateModelBody }>(
    '/api/models/:id',
    {
      preHandler: app.requireAdmin,
      schema: { params: modelIdParamsSchema, body: updateModelBodySchema },
    },
    async (request) => ok(await updateModel(request.params.id, request.body)),
  )

  /** 删除（仅 ADMIN）。被 Agent 引用时 409（`agents.model_id` 是 RESTRICT，见 `02` §三） */
  app.delete<{ Params: ModelIdParams }>(
    '/api/models/:id',
    { preHandler: app.requireAdmin, schema: { params: modelIdParamsSchema } },
    async (request) => ok(await removeModel(request.params.id)),
  )
}
