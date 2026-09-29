/**
 * 会话路由（P0-1-25 起；P0-1-26 加 SSE 出口与停止）
 *
 * 依据：`docs/02-后端设计.md` §4.5（`/api/conversations` 九端点 + `/api/agents/:id/conversations`）
 *      + §四 约定（信封 / offset-limit 分页）+ §五（SSE 协议全文）+ §5.2（互斥 / 心跳 / 停止 / 断线）
 *      + `01` §3.3 功能表第 9 条 + `03` §4.1（会话侧栏与输入区状态机）/ §七（会话删除是级联删除）。
 *
 * 九条已全部落地（P0-1-25 五条 + P0-1-26 两条 + **P0-1-28 的消息历史** +
 * **P0-2-10 的确认应答**）：Agent 会话列表 / 新建 / 重命名 / 删除 / `/active` /
 * **`/chat`（SSE）** / **`/stop`** / **`/messages`** / **`/confirm`**。
 * `02` §4.5 那张表的九条路由**至此无缺口** ⇒ 本文头部"仍缺一条"的旧注记已删除。
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
  chatRequestBodySchema,
  confirmRequestBodySchema,
  conversationIdParamsSchema,
  createConversationBodySchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  ok,
  renameConversationBodySchema,
  agentIdParamsSchema,
  type AgentIdParams,
  type ChatRequestBody,
  type ConfirmRequestBody,
  type ConversationIdParams,
  type CreateConversationBody,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type RenameConversationBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { resolveChatProducer } from '../orchestrator/index.js'
import { answerConfirm, signalStop, streamChatReply } from '../orchestrator/sse.js'
import { requireAuthContext } from '../plugins/session.js'
import {
  assertConversationSendable,
  createConversation,
  getConversationActive,
  listConversationsForAgent,
  listMessages,
  recallLastRound,
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
   * 撤回最新一轮（产品优化 2026-09-29）。**只允许最新一轮**（产品口径，见服务层函数注释）。
   *
   * ⚠️ **不按 `status` 拦**（与服务层同族）：只读会话照样能撤回自己的历史。
   * 响应带 `deletedMessages` / `deletedArtifacts`（同一个事务里数出来）——
   * 界面的成功提示要说"删掉了什么"（TaskAgent 那一轮的产物也一并删）。
   */
  app.post<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/recall',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => ok(await recallLastRound(request.params.id, viewerOf(request))),
  )

  /**
   * 活跃流状态（`02` §4.5 / §5.2，断线重连先查它）。**无流时恒为 `{streaming:false, …null}`**。
   *
   * ⚠️ 写侧（`chat.active:{id}` 的锁）在 **P0-1-26** 落地 ⇒ 本端点现在是**真的**能读到
   * "在流 / 排队位次 / 当前工具"：一条 SSE 流在跑时它就是 `streaming:true`。
   * 读侧的口径（派生 `streaming`、值坏逐字段降级、先查库再查 Redis）由 P0-1-25 定案并保持不变。
   */
  app.get<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/active',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => ok(await getConversationActive(request.params.id, viewerOf(request))),
  )

  /**
   * 消息历史（`GET /api/conversations/:id/messages`，P0-1-28）。
   *
   * 游标分页（`02` §四 的约定：**只有 messages 用游标**，其余列表是 offset/limit）：
   * `?beforeId=&limit=` —— 都不传就是"最新一页"。响应 `{ items, nextCursor, hasMore }`，
   * 其中 `items` 是**时间正序（旧 → 新）**、`nextCursor` 指向**更早**那一页
   * （= 本页第一条的 id）。⚠️ 这两句必须一起看，理由写在 `shared` 的
   * `messagePageResultSchema` 注释里（正序是为了与事件流的"追加"语义共用一套渲染）。
   * 断线重连的完整恢复流程是 `/active`（拿进度）→ 本端点（补齐消息），见 §5.2。
   *
   * 三处刻意：
   *   · **不返回进行中的消息**：`02` §5.2 明写"历史不含进行中消息，进行中状态由 `/active` 提供"
   *     —— 半条回答只存在于那条 SSE 连接上，落库发生在 `done` 时（`chatBot.ts` 的收尾）。
   *   · **`content` 原样透出**（不过 `messageContentSchema`）：`tool_calls`（P0-2）与
   *     `attachments`（P1）将来要能随历史一起还原（`01` §3.4「完整还原」），
   *     用写入端的 schema 过滤会把它们**静默**剥掉。
   *   · **不查 `status`**：`FINISHED`（Agent 被软删 ⇒ 会话转只读**保留**）的历史照样看得见。
   */
  app.get<{ Params: ConversationIdParams; Querystring: ListMessagesQuery }>(
    '/api/conversations/:id/messages',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, querystring: listMessagesQuerySchema },
    },
    async (request) => ok(await listMessages(request.params.id, request.query, viewerOf(request))),
  )

  /**
   * 发起对话（SSE；`02` §五 全文 + §5.2）。**本仓第二个不返回 JSON 信封的端点**（第一个是文档下载）。
   *
   * ── 两类失败、两个出口（`shared/src/sse.ts` 文件头 ③ 的完整理由）──
   * **前置失败走统一 JSON 信封** —— 它们的**主语是"这个请求/目标"**，与"这一轮流"无关：
   *   ① 未登录 401 / body 非法 400 —— `preHandler` 与路由级 schema 拦下；
   *   ② 会话不存在或不是我的 → 404；
   *   ③ 会话只读（Agent 被软删）→ 409、绑定模型不可用 → 409 / 424。
   * ⚠️ **会话互斥冲突（同会话已有流在跑）走 `error{code:CONFLICT}` 事件**，不是信封 ——
   *    它的**主语是"这一轮生成"**：客户端已经发起了对话，被拒的是这一次生成。`02` §4.5/§5.2、
   *    `03` §五（配了"消息流内错误卡"）、`06` 的验收原文**四处**都写的是流内 `error`
   *    ⇒ 前端按单一渲染路径在对话区收口。实现落在 `orchestrator/sse.ts#writeSseErrorReply`。
   * 成功则 `200 text/event-stream`：之后的一切（含流内故障）都走事件（`done` / `error`）。
   *
   * ⚠️ **handler 里不能 `await` 完之后再 `return` 任何值**：`streamChatReply` 内部已 `hijack`，
   * 响应归它管（Fastify 的 `reply.sent` 因此恒为 true，不会再碰这个响应）。
   *
   * ⚠️ 本段原有一句"本批的流是空流（编排循环属 P0-1-27）"—— **P0-1-27 已兑现**（真编排循环），
   * 且 **P0-3-6 起按 `agent.type` 分流**：`CHATBOT` 走后端 RAG 编排（`chatBot.ts`），
   * `TASK_AGENT` 走沙箱里的 pi 引擎（`taskAgent.ts`）。分流点**只在**
   * `orchestrator/index.ts#resolveChatProducer(agentType)`，本 handler 连"有几种链路"都不需要知道。
   */
  app.post<{ Params: ConversationIdParams; Body: ChatRequestBody }>(
    '/api/conversations/:id/chat',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, body: chatRequestBodySchema },
    },
    async (request, reply) => {
      // 前置闸门（404 / 只读 409 / 424）在加锁与 hijack **之前**跑完，它们走 JSON 信封；
      // 会话互斥的 CONFLICT 由 `streamChatReply` 内部以 `error` 事件收尾（见上面的分界说明）
      // 本轮指定模型（模型池特性）由请求体透传：省略则走该会话智能体的默认模型
      const sendable = await assertConversationSendable(
        request.params.id,
        viewerOf(request),
        request.body.modelId,
      )
      await streamChatReply({
        reply,
        conversationId: sendable.conversationId,
        agentId: sendable.agentId,
        // `content` 已由路由级 schema（`chatRequestBodySchema`）trim 过；它**同时**是
        // 检索的 query 与落库时用户消息的正文（P0-1-27 的编排循环两处都要用）
        content: request.body.content,
        target: sendable.target,
        // ⚠️ 判据来自闸门（= 库里的 `agents.type`），**不是请求体** —— 见 `ChatSendContext#agentType`
        producer: resolveChatProducer(sendable.agentType),
      })
    },
  )

  /**
   * 停止生成（`02` §5.2：写 `chat.stop:{id}`，TTL 60s，编排循环在可中断点检查）。
   *
   * **幂等**，两种结果都是 200：`signaled:true` = 有一个正在跑的流收到了信号；
   * `signaled:false` = 当前没有在生成的回答（`03` §4.1 的停止按钮只在流中出现，
   * 但"流刚好结束"的竞态必然存在 —— 把它做成 4xx 只会让用户看到一个没有信息量的报错）。
   *
   * 判据复用 P0-1-25 的 `/active` 读侧（**顺带完成"这不是我的会话就 404"**）：
   * 先看 `streaming`，真的有流才写键。顺序反了（先写再判）会在"流刚结束"时留下一个
   * **没人消费的停止键**，它会在 60s 内让用户的下一条消息**秒停**（见 `infra/redis.ts` 的
   * `CHAT_STOP_TTL_SEC`）。
   *
   * 刻意**不按会话类型分流**（`02` §4.5 的表里写着"停流 / 停流+回收沙箱"，P0-3-8 已定案
   * **分流点不在本路由**）：本端点只负责**写那一个信号键**，被停止的那条流怎么收尾是它
   * 自己的事 —— TaskAgent 一侧由 `bridge.ts#runTurn` 的 abort 监听把信号翻成引擎的
   * `abort` 命令（+ 15s 宽限等 `agent_settled`），随后在 `taskAgent.ts` 收尾里、
   * **产物收集与落库之后**，回收容器与具名卷。若在这里直接回收，杀掉的是一个还没收完
   * 产物的容器（顺序即正确性）—— 所以"分流"落在编排层收尾，路由对两种会话类型同形。
   */
  app.post<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/stop',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => {
      const active = await getConversationActive(request.params.id, viewerOf(request))
      if (!active.streaming) return ok({ id: request.params.id, signaled: false })
      return ok({ id: request.params.id, signaled: await signalStop(request.params.id) })
    },
  )

  /**
   * 确认 / 取消一次挂起中的确认（`02` §4.5 的第九条路由；P0-2-10，`docs/02` §9.10）。
   *
   * 它是 `confirm` 事件的**唯一应答口**：流在"危险工具 / 服务端 elicitation"处挂起
   * （`orchestrator/sse.ts#awaitConfirm`）等待本端点的答案，上限 `MCP_CONFIRM_TIMEOUT_SEC`
   * （默认 120s），超时按取消处理（`02` §5.2）。
   *
   * ── 判据只有一条：**有没有人在等这个 `confirmId`** ──
   * 与 `/stop` 同款：先读 `/active`（**顺带完成"这不是我的会话就 404"**，判据是
   * `services/conversation.service.ts` 文件头 ① 那一条，本处**不另起一套**），
   * 再把 `pendingConfirmId` 原样交给 `answerConfirm` 按 id 匹配。
   *
   * 刻意**不**在这里分"会话只读（Agent 被软删）"那一支（`06` P0-2-10 门槛 4 的原文写了 409）：
   * 只读会话**必定**没有活跃流 ⇒ `pendingConfirmId === null` ⇒ 走"幂等忽略"、结论一模一样；
   * 而单开那一支会让"Agent 在流中途被软删、用户正在看确认卡"这一路误报 409
   * （那时流还在跑、这次确认**是**有效的）。完整推理见 `orchestrator/sse.ts#answerConfirm`。
   *
   * ⚠️ **顺序：先读 `/active`、再写信号**（与 `/stop` 同一条纪律）。反了会在"确认刚好超时"
   * 时往一个没人消费的槽位写一条应答；它虽然会被下一次 `awaitConfirm` 的清理点抹掉，
   * 但那 60s 里 Redis 里躺着一个查不明白的键。
   *
   * 三种结局都是 200（**幂等**）：`applied:true` = 有一个等待中的流收到了这个答案；
   * `applied:false` = 没有人在等（已超时/已取消/这一轮早结束了/`confirmId` 是上一轮的迟到点击
   * —— 见 `shared#confirmConversationResultSchema`）。做成 4xx 只会让用户看到一个
   * 没有信息量的报错，而**重复点击**必然发生（用户看到卡片没消失就会再点一次）。
   */
  app.post<{ Params: ConversationIdParams; Body: ConfirmRequestBody }>(
    '/api/conversations/:id/confirm',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, body: confirmRequestBodySchema },
    },
    async (request) => {
      const active = await getConversationActive(request.params.id, viewerOf(request))
      return ok(
        await answerConfirm(request.params.id, request.body, active.pendingConfirmId),
      )
    },
  )
}
