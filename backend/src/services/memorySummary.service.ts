/**
 * 会话小结服务（P1-8 · L1）—— `conversation_summaries` 的唯一实现
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §4.1（L1 会话小结）/§三 CB-2（滚动摘要）、
 *      `01` 决策 6、`shared/src/memory.ts#conversationSummarySchema`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 与 ChatBot 滚动摘要（CB-2）**共用同一张表、同一件事**
 * ─────────────────────────────────────────────────────────────────────
 * L1 的"会话小结"就是"整段会话的滚动摘要"，不是两份数据（设计 §三 CB-2 明写"与长期记忆 L1 共用"）。
 * 生成在**每轮收尾**（后端、与 bot 类型无关）—— 于是 ChatBot 与 TaskAgent 都有一致的小结。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② ★ 本批是**抽取式**小结，不是模型生成的摘要（如实写明的边界）
 * ─────────────────────────────────────────────────────────────────────
 * 设计要求"交给一次内部模型调用生成结构化小结"。本批**刻意先做确定性的抽取式小结**
 * （主题 + 首/末轮 + 计数），理由：它**可验证、零额外 token、无上游依赖**；模型生成的摘要需要一个
 * 可靠可测的降级路径（fail-open + 成本闸门，见 CB-2），那是独立的一次改动。
 * ⚠️ 因此本批的边界是：**小结质量取决于会话本身是否被命名/是否有清晰的首末轮**；
 *    升级成模型摘要时，本文件的对外函数签名（`upsertConversationSummary` / `getSummariesFor`）不变。
 */

import { CONVERSATION_UNTITLED_HINT } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { MESSAGE_CHRONO_ORDER } from './conversation.service.js'

/** 一节里单段文本进小结的码点上限（超长只留开头，够认出"聊过什么"即可） */
export const SUMMARY_SEGMENT_MAX_CHARS = 160

/** 小结要看到的最多消息条数（首末都看，中间省略） */
export const SUMMARY_MESSAGE_SCAN = 40

/** 从一条 `content`（jsonb）里取文本（与 `chatContext#textOfHistoryRow` 同口径的轻量版） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return ''
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/** 压成单行 + 按码点截断（小结是给人看的一句话，不保留换行） */
function squeeze(text: string, max = SUMMARY_SEGMENT_MAX_CHARS): string {
  const collapsed = text.trim().replace(/\s+/gu, ' ')
  const chars = [...collapsed]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : collapsed
}

/**
 * 为**单个会话**重算并 Upsert 一条小结。
 *
 * 判据：会话存在即可（`conversation_summaries.conversation_id` 是外键 ⇒ 会话没了会级联删行）。
 * 恒不抛 —— 生成小结是收尾的**赠品**，失败只 warn（与 `memory.service#insertMemory` 同款取舍）。
 *
 * @returns 写入的正文；会话不存在或读取失败时返回 `null`
 */
export async function upsertConversationSummary(
  conversationId: string,
): Promise<{ text: string; upToMessageId: string | null } | null> {
  try {
    const db = getPrisma()
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { topic: true },
    })
    if (conversation === null) return null

    const rows = await db.message.findMany({
      where: { conversationId },
      orderBy: [...MESSAGE_CHRONO_ORDER],
      take: SUMMARY_MESSAGE_SCAN,
      select: { id: true, role: true, content: true },
    })
    // 上面是"新 → 旧"；还原成时间正序再取首/末
    const chronological = [...rows].reverse()
    const text = renderSummary(conversation.topic, chronological)
    const upToMessageId = chronological.at(-1)?.id ?? null

    await db.conversationSummary.upsert({
      where: { conversationId },
      create: { conversationId, text, upToMessageId },
      update: { text, upToMessageId },
    })
    return { text, upToMessageId }
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '生成会话小结失败（已忽略，不影响本轮）')
    return null
  }
}

/**
 * 纯渲染：会话 + 正序消息 → 一句小结（**不碰 DB**，便于逐字核对）。
 *
 * 形状（单段文本）：
 * `主题「X」；首轮：<用户第一句>；最近：<用户最近一句> → <助手最近回答开头>`（末尾附消息数）。
 */
export function renderSummary(
  topic: string | null,
  messages: readonly { role: string; content: unknown }[],
): string {
  const title = topic === null || topic.trim() === '' ? CONVERSATION_UNTITLED_HINT : topic.trim()
  const users = messages.filter((row) => row.role === 'USER').map((row) => textOfContent(row.content))
  const assistants = messages
    .filter((row) => row.role === 'ASSISTANT')
    .map((row) => textOfContent(row.content))
  const firstUser = users.find((text) => text.trim() !== '')
  const lastUser = [...users].reverse().find((text) => text.trim() !== '')
  const lastAssistant = [...assistants].reverse().find((text) => text.trim() !== '')

  const parts: string[] = [`主题「${squeeze(title)}」`]
  if (firstUser !== undefined) parts.push(`首轮：${squeeze(firstUser)}`)
  if (lastUser !== undefined) {
    const tail =
      lastAssistant === undefined ? squeeze(lastUser) : `${squeeze(lastUser)} → ${squeeze(lastAssistant)}`
    parts.push(`最近：${tail}`)
  }
  parts.push(`共 ${messages.length} 条消息`)
  return parts.join('；')
}

/** 批量取若干会话的小结（活动时间线列表用它，避免逐行 N+1） */
export async function getSummariesFor(
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(conversationIds)]
  if (unique.length === 0) return new Map()
  const rows = await getPrisma().conversationSummary.findMany({
    where: { conversationId: { in: unique } },
    select: { conversationId: true, text: true },
  })
  return new Map(rows.map((row) => [row.conversationId, row.text]))
}
