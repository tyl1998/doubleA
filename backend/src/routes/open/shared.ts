/**
 * 开放层路由的共用件（**P1-22**）：错误出口 + 会话投影 + 会话互斥读取
 *
 * 依据：`docs/08` §6.1（通用约定）/ §7（SSE 踩坑清单）/ `docs/02` §四（信封）
 *      + `shared/src/openApi.ts`（对外投影）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 三处共用件，每一处的理由都是"照抄会漏"
 * ─────────────────────────────────────────────────────────────────────
 * · {@link openRoute}：把 handler 的返回值包成 `ok(data)`（**唯一成功形状**，返回类型被钉成
 *   `Envelope<T>`）。**刻意不做 try/catch**：`errorHandler` 已经统一转信封，再包一层只会让
 *   "谁决定状态码"多一处；审计（{@link auditFailure}）由 `app.ts` 的 `setErrorHandler`
 *   在**一处**触发 —— 于是"哪个端点上忘了记审计"在结构上不可能发生。
 * · {@link toOpenConversation}：内部 `ConversationItem` → 对外投影。**投影只在这里转换一次**，
 *   免得 6 个端点各自挑字段（挑漏了 `readOnly` 就会出现"客户端以为能发"）。
 * · {@link readOpenActive}：会话活跃快照（`streaming / pendingConfirmId / autoApprove / readOnly`）。
 *   内部那个 `getConversationActive` 回的是超大对象（含 `memoryExcluded` / `codeMode` / `runtime`），
 *   而外部只需要"在跑吗 / 等谁确认 / 能不能写" —— **裁剪在开放层做**，内部服务一行不改。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 为什么开放层的**权限主语**永远是 `key.userId`
 * ─────────────────────────────────────────────────────────────────────
 * Q1 定案"Key 归属 = 用户 + 智能体" ⇒ 会话的 `user_id` 就是签发人本人。于是开放层调内部服务时
 * 传的 `viewer` 恒为 `{ id: context.userId }`（`ConversationViewer`），**不是**"Key 的虚拟身份"
 * —— 内部那套"这一行是不是你的"判据原样生效，一行都不用改（`docs/08` §2 的红利）。
 * `role` 额外带上（`ADMIN` / `MEMBER`）：只用于"所选模型对我是否可见"这条**资产**判据（P1-13）。
 */

import {
  isConversationReadOnly,
  ok,
  type ConversationActive,
  type ConversationItem,
  type ConversationStatus,
  type Envelope,
  type OpenConversation,
  type OpenConversationActive,
  type UserRole,
} from '@doubulea/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { getPrisma } from '../../infra/prisma.js'
import { getConversationActive, type ConversationViewer } from '../../services/conversation.service.js'
import type { OpenRequestContext } from '../../plugins/openAuth.js'

/**
 * 把 handler 的返回值包成信封；抛出的任何异常原样上抛（由 `errorHandler` 统一转）。
 *
 * ⚠️ 本函数**不做 try/catch**：`errorHandler` 已经把 `AppError` → 信封、未知异常 → 500 都收好了
 * （`plugins/errorHandler.ts`）。在这里再包一层只会让"到底谁决定了状态码"多一处。
 * 它存在的意义只有两条：**所有开放端点的成功形状只有一个**（`ok(data)`），以及
 * **返回类型被钉成 `Envelope<T>`**（漏写 `ok` 会在编译期报错，而不是把裸对象发出去）。
 */
export async function openRoute<T>(fn: () => Promise<T>): Promise<Envelope<T>> {
  return ok(await fn())
}

/** 开放层的会话调用者（见文件头 ②） */
export function openViewer(context: OpenRequestContext, role: UserRole): ConversationViewer {
  return { id: context.userId, role }
}

/**
 * 开放层要不要给这个用户按 ADMIN 算？—— 只有"这个 Agent 是我自己的"才按 ADMIN 算。
 *
 * 为什么不是直接用 `users.role`：ADMIN 的 Key 借用的是**他自己的**额度与身份，判"模型对我可见"
 * 时用 ADMIN 身份是合理的（他能看到全部资产）。但**受众用户的 Key** 必须是 MEMBER 口径
 * （否则 `SHARED` Agent 的受众调用私有 Provider 的模型会凭空放行）—— 那条判据本来就只看
 * `role` 与模型所属 Provider 的所属人，用真实角色即可，无需特殊处理。
 * ⇒ 这里直接返回**真实角色**（查一次，带 60s 的用户快照缓存可复用同一张表，代价可忽略）。
 */
export async function openViewerRole(userId: string): Promise<UserRole> {
  const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { role: true } })
  return user?.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'
}

/** 内部会话投影 → 对外投影（唯一转换点，见文件头 ①） */
export function toOpenConversation(item: ConversationItem): OpenConversation {
  return {
    id: item.id,
    agentId: item.agentId,
    title: item.topic,
    status: item.status,
    readOnly: isConversationReadOnly(item.status),
    createdAt: item.createdAt,
    lastMessageAt: item.lastMessageAt,
  }
}

/**
 * 内部活跃快照 → 对外投影（只留客户端要回答的三个问题，见文件头 ①）。
 *
 * `status` 必须由调用方**从库里的那一行**传进来：`ConversationActive` 只有 Redis 快照与两个开关，
 * 没有会话状态（`conversation.ts` 文件头 ⑤）。让本函数去查库就等于多一次往返，且那次查询的
 * `where` 还得再写一遍"是我的"—— 判据会变成两处。
 */
export function toOpenActive(active: ConversationActive, status: ConversationStatus): OpenConversationActive {
  return {
    streaming: active.streaming,
    currentTool: active.currentTool,
    startedAt: active.startedAt,
    queuedPosition: active.queuedPosition,
    pendingConfirmId: active.pendingConfirmId,
    autoApprove: active.autoApprove,
    readOnly: isConversationReadOnly(status),
    // 发起方（2026-10-22）：与内部 `/active` 同源透出 —— 外部客户端要能区分
    // "我自己发的那一轮"与"定时任务后台跑的那一轮"（内部观察流也是同一份语义）
    startedBy: active.startedBy,
  }
}

/**
 * 读会话活跃快照（**顺带完成"这不是我的会话 / 不是这个 Agent 的会话"的 404**）。
 *
 * 两步刻意分开写：
 *   ① `assertOpenConversation`（`plugins/openAuth.ts`）：会话存在 ∧ 是我的 ∧ `agentId` 是 Key 的那个；
 *   ② `getConversationActive`：内部只读快照（它自己也会带 `userId` 再查一次 —— 那次重复查询是
 *      **可接受**的，换掉它就要在开放层复制一份活跃快照的读取逻辑，那才是真正的第二实现）。
 *
 * ⚠️ 调用顺序：先 `assertOpenConversation`（拿到库里的 `status` 并判完归属/Agent 归属），
 * 再调本函数。顺序反了不会出错，但会多一次"判了归属却还没判 Agent"的中间态。
 */
export async function readOpenActive(
  conversationId: string,
  viewer: ConversationViewer,
): Promise<ConversationActive> {
  return getConversationActive(conversationId, viewer)
}

/**
 * 统一给响应加开放层头（§6.1）：`X-Open-Key-Id`（客户对账）。
 *
 * ⚠️ 只在**鉴权成功之后**的响应上出现（`request.open === null` 时什么都不加）：
 * 给 401 加一个 Key id 等于告诉对方"这个 id 存在"。
 * 余量（`X-RateLimit-Remaining`）只在 429 与 `/open/v1/usage` 上给：每个响应都查一次计数
 * 等于把一个读放大到全部端点，而客户真正需要的"还剩多少"由专用端点回答。
 */
export function decorateOpenResponse(request: FastifyRequest, reply: FastifyReply): void {
  const context = request.open
  if (context === null) return
  void reply.header('x-open-key-id', context.keyId)
}
