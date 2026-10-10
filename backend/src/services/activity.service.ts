/**
 * 活动时间线服务（P1-8 · L0）—— `/api/activity` 与 `/api/activity/search` 的唯一实现
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §4.1（L0 活动时间线）/§4.6（分阶段 L0 先行）、
 *      `shared/src/memory.ts`（契约）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① L0 = "我做过哪些事"，**零新增存储**
 * ─────────────────────────────────────────────────────────────────────
 * 复用 `conversations`（join `agents`）+ `messages` / `artifacts` 计数 + `usage_records` 汇总
 * + `conversation_summaries`（L1 小结）—— 不发一句 prompt 就能回答"我做过哪些事"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 权限：只有本人；判据落在 `where` 里
 * ─────────────────────────────────────────────────────────────────────
 * 与会话同族（`conversations.user_id`）：别人的会话与不存在的会话不在结果里（连 ADMIN 也无后门）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 消息搜索走 jsonb 路径过滤（`content->>'text'`）
 * ─────────────────────────────────────────────────────────────────────
 * `messages.content` 是 jsonb，Prisma 的 `path: ['text']` + `string_contains` 正好译成
 * `content->>'text' LIKE '%q%'`。**大小写敏感**（Json 过滤没有 `mode`）——对中文无影响，
 * 对英文关键词是"区分大小写"，这是如实记录的边界（要大小写不敏感得加表达式索引 + 手写 SQL）。
 */

import {
  CONVERSATION_UNTITLED_HINT,
  type ActivityItem,
  type ActivityListResult,
  type ActivitySearchHit,
  type ActivitySearchResult,
  type ListActivityQuery,
  type SearchActivityQuery,
} from '@doubulea/shared'

import { getPrisma } from '../infra/prisma.js'
import { MESSAGE_CHRONO_ORDER } from './conversation.service.js'
import { getSummariesFor } from './memorySummary.service.js'

/** 会话归属判据（与其余"仅本人"资源同款） */
export interface ActivityViewer {
  id: string
}

/** 从一条 `content`（jsonb）里取文本（轻量版；不抛） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return ''
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/** 命中位置附近的一小段（前后各留一段），供结果列表显示 */
function snippetAround(text: string, query: string, window = 60): string {
  const collapsed = text.trim().replace(/\s+/gu, ' ')
  if (collapsed === '') return ''
  const index = collapsed.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) {
    return collapsed.length > window * 2 ? `${collapsed.slice(0, window * 2)}…` : collapsed
  }
  const start = Math.max(0, index - window)
  const end = Math.min(collapsed.length, index + query.length + window)
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`
}

/**
 * L0 活动时间线：本人的会话 + 读数（消息数 / 产物数 / 用量 / L1 小结）。
 *
 * 排序与会话侧栏一致（`lastMessageAt desc`，`null` 在前 —— 见 `shared#conversationItemSchema` 文件头 ③）。
 * `q` 对**会话标题**做不区分大小写的包含匹配（省略 = 全部）。
 */
export async function listActivity(
  query: ListActivityQuery,
  viewer: ActivityViewer,
): Promise<ActivityListResult> {
  const db = getPrisma()
  const where = {
    userId: viewer.id,
    ...(query.q === undefined
      ? {}
      : { topic: { contains: query.q, mode: 'insensitive' as const } }),
  }
  const [rows, total] = await Promise.all([
    db.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      skip: query.offset,
      take: query.limit,
      select: {
        id: true,
        agentId: true,
        topic: true,
        status: true,
        lastMessageAt: true,
        createdAt: true,
        agent: { select: { name: true, type: true } },
        _count: { select: { messages: true, artifacts: true } },
      },
    }),
    db.conversation.count({ where }),
  ])
  const ids = rows.map((row) => row.id)

  // 用量：一次分组聚合（`usage_records` 没有 conversationId ⇒ 只能按人 + 时间近似？）
  // ⚠️ `usage_records` **刻意没有 `conversation_id` 列**（`02` §三：账不随会话走）⇒ 无法按会话归集。
  //    本列表的 token 读数因此**按消息累计**（`messages.tokens_in/out`，P1-7 起两个编排器都会写），
  //    这正是"这个会话用了多少 token"最直接的来源。
  const usageRows =
    ids.length === 0
      ? []
      : await db.message.groupBy({
          by: ['conversationId'],
          where: { conversationId: { in: ids } },
          _sum: { tokensIn: true, tokensOut: true },
        })
  const usageByConversation = new Map(
    usageRows.map((row) => [
      row.conversationId,
      row._sum.tokensIn === null && row._sum.tokensOut === null
        ? null
        : (row._sum.tokensIn ?? 0) + (row._sum.tokensOut ?? 0),
    ]),
  )
  const summaries = await getSummariesFor(ids)

  const items: ActivityItem[] = rows.map((row) => ({
    conversationId: row.id,
    agentId: row.agentId,
    agentName: row.agent.name,
    agentType: row.agent.type,
    topic: row.topic,
    status: row.status,
    messageCount: row._count.messages,
    artifactCount: row._count.artifacts,
    tokensTotal: usageByConversation.get(row.id) ?? null,
    lastMessageAt: row.lastMessageAt === null ? null : row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    summary: summaries.get(row.id) ?? null,
  }))
  return { items, total, offset: query.offset, limit: query.limit }
}

/**
 * L0 消息搜索：在**本人的**会话里，按 `messages.content->>'text'` 包含关键词检索。
 *
 * 返回命中消息（含所属会话的标题 / Agent 名快照），供结果列表显示 + 跳回会话。
 * `snippet` 是命中位置附近的截取（见 {@link snippetAround}）。
 *
 * ⚠️ 分页：与其余列表同口径（offset/limit）。`createdAt desc` 让"最近提到的"排在前面。
 */
export async function searchActivity(
  query: SearchActivityQuery,
  viewer: ActivityViewer,
): Promise<ActivitySearchResult> {
  const db = getPrisma()
  const where = {
    // 权限：消息所属会话必须是本人的（`conversation` 关系过滤）
    conversation: { userId: viewer.id },
    // jsonb 路径过滤：`content->>'text' LIKE '%q%'`（见文件头 ③）
    content: { path: ['text'], string_contains: query.q },
  } as const

  const [rows, total] = await Promise.all([
    db.message.findMany({
      where,
      orderBy: [...MESSAGE_CHRONO_ORDER],
      skip: query.offset,
      take: query.limit,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
        conversationId: true,
        conversation: {
          select: {
            agentId: true,
            topic: true,
            agent: { select: { name: true } },
          },
        },
      },
    }),
    db.message.count({ where }),
  ])

  const items: ActivitySearchHit[] = rows.map((row) => ({
    conversationId: row.conversationId,
    agentId: row.conversation.agentId,
    agentName: row.conversation.agent.name,
    topic: row.conversation.topic ?? CONVERSATION_UNTITLED_HINT,
    role: row.role,
    snippet: snippetAround(textOfContent(row.content), query.q),
    createdAt: row.createdAt.toISOString(),
  }))
  return { items, total, offset: query.offset, limit: query.limit }
}
