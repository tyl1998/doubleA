/**
 * 会话路由（P0-1-25）
 *
 * 依据：`docs/02-后端设计.md` §4.5（`/api/conversations` 五端点 + `/api/agents/:id/conversations`）
 *      + §四 约定（信封 / offset-limit 分页）+ §5.2（断线重连查 `/active`）
 *      + `01` §3.3 功能表第 9 条 + `03` §4.1（会话侧栏）/ §七（会话删除是级联删除）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 权限：**只有本人**，且靠"查询条件里带 userId"实现，路由层没有任何判据
 * ─────────────────────────────────────────────────────────────────────
 * 与会话相关的一切都挂在 `requireAuth` 上、**没有一条 `requireAdmin`**，也**没有** `canEditXxx`
 * 这类判据函数 —— 判据就是"这一行是不是你的"，落在服务层的 `where` 里（见
 * `services/conversation.service.ts` 文件头 ①）。这样别人的会话与不存在的 id 返回**同一个 404**，
 * 不存在"忘了判权限"或"判了但顺序写错"的空间。
 *
 * 与三族邻居的差别再写一遍（照抄邻居必错）：模型池 = `requireAdmin`；知识库 = 登录即可
 * （无 owner 列）；智能体 = 创建者 + ADMIN 的**行级**判定（路由仍只用 `requireAuth`）；
 * **会话 = 仅本人**（`conversations.user_id`）。`01`/`02`/`03` 都没有一处给管理员开"看别人的
 * 聊天记录"的口子，故这里刻意不给 —— 那是隐私升级，不是便利。
 *
 * ⚠️ `GET /api/agents/:id/conversations` **注册在本文件而不是 `routes/agents.ts`**：
 * 它读的是 `conversations` 表（"这个智能体下**我**的会话"），索引也是 `(agent_id, last_message_at)`；
 * 而 `agents.ts` 的文件头从 P0-1-22 起就把这条列为"刻意未注册（属 P0-1-25）"，本批落地后
 * 已把它改标为"P0-1-25 已落地、注册在 `routes/conversations.ts`"。
 * 同一前缀下两个文件各注册自己的路径是安全的（Fastify 的静态/参数段按段匹配，路径不同就不会撞）——
 * 与 P0-1-11「同路径同方法注册两次会在**启动期**抛 `FST_ERR_DUPLICATED_ROUTE`」是两回事。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  conversationIdParamsSchema,
  createConversationBodySchema,
  listConversationsQuerySchema,
  ok,
  renameConversationBodySchema,
  agentIdParamsSchema,
  type AgentIdParams,
  type ConversationIdParams,
  type CreateConversationBody,
  type ListConversationsQuery,
  type RenameConversationBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  createConversation,
  getConversationActive,
  listConversationsForAgent,
  removeConversation,
  renameConversation,
  type ConversationViewer,
} from '../services/conversation.service.js'

/**
 * 取调用者 —— **只取 `id`**（见服务层文件头 ①：本资源不按角色判权）。
 *
 * 用 `requireAuthContext` 而不是自己判 `request.auth === null`：每条路由都挂了 `app.requireAuth`，
 * 那个分支永远不会触发；而它同时兜住"有人忘了挂 preHandler"这种真实的接线错误
 * （那时会 401 而不是拿 null 崩）。
 */
function viewerOf(request: FastifyRequest): ConversationViewer {
  return { id: requireAuthContext(request).user.id }
}

export function registerConversationRoutes(app: FastifyInstance): void {
  /**
   * 某智能体下**我**的会话列表（`03` §4.1 的会话侧栏）。
   *
   * ⚠️ **软删的智能体照样能查**（`02` §4.4：会话"只读保留"）—— 这是 P0-1-24 门槛④
   * "删除 Agent 后其会话仍在（只读）"在端点层的取证入口；只有"智能体不存在"才 404。
   * 排序与 `nulls` 口径见服务层文件头 ③。
   */
  app.get<{ Params: AgentIdParams; Querystring: ListConversationsQuery }>(
    '/api/agents/:id/conversations',
    {
      preHandler: app.requireAuth,
      schema: { params: agentIdParamsSchema, querystring: listConversationsQuerySchema },
    },
    async (request) =>
      ok(await listConversationsForAgent(request.params.id, request.query, viewerOf(request))),
  )

  /**
   * 新建会话（`02` §4.5 的 body 只有 `agentId`）。
   *
   * 成功返回 `200`（信封 `code=0` 是唯一契约，与其余建接口同口径，**不引入 201**）。
   * ⚠️ `03` §4.1 的界面流程是"**首条消息发送时才创建会话**"（进入对话页只是展示开场白），
   * 所以这条端点是被"发第一条消息"调用的，不是被"打开对话页"调用的 —— 本批只提供端点，
   * 那个流程属 P0-1-26/27。
   */
  app.post<{ Body: CreateConversationBody }>(
    '/api/conversations',
    { preHandler: app.requireAuth, schema: { body: createConversationBodySchema } },
    async (request) => ok(await createConversation(request.body, viewerOf(request))),
  )

  /**
   * 重命名（`03` §4.1 的行内编辑）。**不按 `status` 拦**（服务层文件头 ⑤）。
   * 请求体只收非空 `topic`（**`null` 会被拒**，见 `shared` 的 schema 注释）。
   */
  app.patch<{ Params: ConversationIdParams; Body: RenameConversationBody }>(
    '/api/conversations/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, body: renameConversationBodySchema },
    },
    async (request) => ok(await renameConversation(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 删除（**级联**：`messages` 由外键连带清除）。
   *
   * 响应带**删前在同一个事务里数出来的** `deletedMessages` —— `03` §七 的级联删除确认框
   * （"将同时删除 N 条消息"）要用它；只回 `ok` 的话界面给不出有信息量的提示。
   * 顺带清掉活跃流锁与（P0-1 阶段恒为空的）S3 对象，两者失败都只告警。
   */
  app.delete<{ Params: ConversationIdParams }>(
    '/api/conversations/:id',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => ok(await removeConversation(request.params.id, viewerOf(request))),
  )

  /**
   * 活跃流状态（`02` §4.5 / §5.2，断线重连先查它）。**无流时恒为 `{streaming:false, …null}`**。
   *
   * ⚠️ 写侧（`chat.active:{id}` 的锁）归 **P0-1-26** ⇒ 本批这个端点**恒为无流**。
   * 验收脚本直接往那个键里写一份快照来验读侧（等价取证的写法见 `verify-conversations.mjs` 的 F 组），
   * 那时必须能读到"在流 / 排队位次 / 当前工具"三件套。
   */
  app.get<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/active',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => ok(await getConversationActive(request.params.id, viewerOf(request))),
  )
}
