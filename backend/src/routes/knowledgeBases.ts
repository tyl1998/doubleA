/**
 * 知识库路由（P0-1-15）
 *
 * 依据：`docs/02-后端设计.md` §4.6（`GET/POST/PATCH/DELETE /api/knowledge-bases[…/:id]`）+ §四 约定。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：**权限是「登录即可」，不是 ADMIN**
 * ─────────────────────────────────────────────────────────────────────
 * `03` §25 的路由权限列：`/admin/models`、`/admin/users` 是 **ADMIN**，而 `/knowledge`、
 * `/knowledge/:id`、`/mcp` 是 **登录**。`02` §三 的 `knowledge_bases` 也没有 owner 列 ——
 * 与 `mcp_servers` 同族：全员可维护、人人可见的共享资源。
 *
 * 所以这里**一个 `requireAdmin` 都没有**，并且**不拆"管理列表 / 全员可选列表"两套投影**
 * ——那是 P0-1-11 为模型池做的补救（模型池的管理列表是 ADMIN 专属，可 `03` §4.2 的
 * Agent 编辑页又要一个"列出全部 KB"的下拉）。本资源的列表本来就对全员开放，
 * 一个端点同时服务管理页与下拉，**不存在**需要 `/available` 子路径的理由。
 *
 * ⚠️ 代价（见 `shared/src/knowledgeBase.ts` 文件头 ①）：没有 owner ⇒ 任何登录用户都能改/删
 * 任意库。这是文档口径的推论，不是实现疏漏；要收紧得先改 `01`/`02` 加 `created_by`
 * 并定"创建者与 admin 可编删"（决策 18 对 Agent 就是这么定的），本批不自行发明权限模型。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  createKnowledgeBaseBodySchema,
  knowledgeBaseIdParamsSchema,
  listKnowledgeBasesQuerySchema,
  ok,
  searchKnowledgeBaseBodySchema,
  transferAssetBodySchema,
  updateKnowledgeBaseBodySchema,
  type AssetViewer,
  type CreateKnowledgeBaseBody,
  type KnowledgeBaseIdParams,
  type ListKnowledgeBasesQuery,
  type SearchKnowledgeBaseBody,
  type TransferAssetBody,
  type UpdateKnowledgeBaseBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  rebuildKnowledgeBase,
  removeKnowledgeBase,
  transferKnowledgeBase,
  updateKnowledgeBase,
} from '../services/kb.service.js'
import { searchKnowledgeBase } from '../services/retrieval.js'

/** 取调用者（`id` + `role`）—— P1-13 起知识库也走行级权限，服务层需要它 */
function viewerOf(request: FastifyRequest): AssetViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

export function registerKnowledgeBaseRoutes(app: FastifyInstance): void {
  /** 列表（登录即可；P1-13 起按"对我可见"过滤） */
  app.get<{ Querystring: ListKnowledgeBasesQuery }>(
    '/api/knowledge-bases',
    { preHandler: app.requireAuth, schema: { querystring: listKnowledgeBasesQuerySchema } },
    async (request) => ok(await listKnowledgeBases(request.query, viewerOf(request))),
  )

  /** 详情（登录即可；私有库对他人 404） */
  app.get<{ Params: KnowledgeBaseIdParams }>(
    '/api/knowledge-bases/:id',
    { preHandler: app.requireAuth, schema: { params: knowledgeBaseIdParamsSchema } },
    async (request) => ok(await getKnowledgeBase(request.params.id, viewerOf(request))),
  )

  /**
   * 建库（登录即可）。成功返回 `200`（信封 `code=0` 是唯一契约，与 `/api/users`、
   * `/api/models`、`/api/model-providers` 同口径，**不引入 201**）。
   *
   * ⚠️ 需要服务端 embedding 已就绪：`embedding_model` 是建库时的快照、取不到就 500
   * （P0-1-14 定案、P0-1-15 前置里写明的前置条件，见服务层文件头 ②）。
   */
  app.post<{ Body: CreateKnowledgeBaseBody }>(
    '/api/knowledge-bases',
    { preHandler: app.requireAuth, schema: { body: createKnowledgeBaseBodySchema } },
    async (request) => ok(await createKnowledgeBase(request.body, viewerOf(request))),
  )

  /** 部分更新（登录即可进入，行级判定：所属人或 ADMIN）。三态与局部合并的语义在服务层收口 */
  app.patch<{ Params: KnowledgeBaseIdParams; Body: UpdateKnowledgeBaseBody }>(
    '/api/knowledge-bases/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: knowledgeBaseIdParamsSchema, body: updateKnowledgeBaseBodySchema },
    },
    async (request) => ok(await updateKnowledgeBase(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 转移所属人（P1-13，**所属人或 ADMIN**）。`{ toUserId }`；接收方须为 ACTIVE 用户、不能转给自己。
   */
  app.post<{ Params: KnowledgeBaseIdParams; Body: TransferAssetBody }>(
    '/api/knowledge-bases/:id/transfer',
    {
      preHandler: app.requireAuth,
      schema: { params: knowledgeBaseIdParamsSchema, body: transferAssetBodySchema },
    },
    async (request) =>
      ok(await transferKnowledgeBase(request.params.id, request.body.toUserId, viewerOf(request))),
  )

  /** 删除（登录即可进入，行级判定：所属人或 ADMIN）。连带清 chunks 与 S3 原文件；被 Agent 绑定时自动解绑 */
  app.delete<{ Params: KnowledgeBaseIdParams }>(
    '/api/knowledge-bases/:id',
    { preHandler: app.requireAuth, schema: { params: knowledgeBaseIdParamsSchema } },
    async (request) => ok(await removeKnowledgeBase(request.params.id, viewerOf(request))),
  )

  /**
   * 整库重建（登录即可；P1-5，`02` §4.6 的 `POST /:id/rebuild`）。
   *
   * 把该库全部文档逐篇按 `REBUILD` 重新入队，用该库**当前选定**的 embedding 模型重跑
   * 解析 → 分块 → 向量化 → 入库（`子方案①` §八："换模型后整库重建"）。
   *
   * 三条口径（细节在服务层文件头）：**先把全库翻成 `PARSING`**（否则 worker 会因"已是 READY"
   * 全部跳过）、**刻意不清旧 chunk**（重建窗口内检索照常命中旧内容 ⇒ 无检索空窗）、
   * 入队**逐篇失败隔离**并把 `failed` 数量如实回报。响应 `{ id, total, enqueued, failed }`。
   *
   * ⚠️ 无请求体：重建用的模型由库自己决定（`embeddingModelId` **不可改**，`shared` 的
   *    `updateKnowledgeBaseBodySchema` 注释）。维度变化的新表切换不在本批范围。
   */
  app.post<{ Params: KnowledgeBaseIdParams }>(
    '/api/knowledge-bases/:id/rebuild',
    { preHandler: app.requireAuth, schema: { params: knowledgeBaseIdParamsSchema } },
    async (request) => ok(await rebuildKnowledgeBase(request.params.id, viewerOf(request))),
  )

  /**
   * 检索（登录即可；`02` §4.6 的"检索测试"，`子方案①` §六 的双路 + RRF）。
   *
   * ⚠️ 单库检索：本批的端点是 `/api/knowledge-bases/:id/search`，而检索内核
   * （`services/retrieval.ts` 的 SQL）写的是 `kb_id = ANY($2)` —— 那是 `§6-1` 的形状，
   * F 包的对话编排要一次查 Agent 绑定的多个库，届时只需改调用方，SQL 不必动。
   *
   * 三条口径（细节在服务层文件头）：`mode`/`topK` 可在请求里覆盖（试查页要能"同一 query
   * 试三种模式"，且**不污染**库配置）；向量路在"库快照的 embedding 模型 ≠ 当前模型"时
   * 跳过并告警（§八 的降级路径）而不是 500；`VECTOR` 模式没有可退的路，则报 409。
   */
  app.post<{ Params: KnowledgeBaseIdParams; Body: SearchKnowledgeBaseBody }>(
    '/api/knowledge-bases/:id/search',
    {
      preHandler: app.requireAuth,
      schema: { params: knowledgeBaseIdParamsSchema, body: searchKnowledgeBaseBodySchema },
    },
    async (request) => ok(await searchKnowledgeBase({ kbId: request.params.id, ...request.body })),
  )
}
