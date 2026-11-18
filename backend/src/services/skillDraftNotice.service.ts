/**
 * Skill 草稿提示卡队列（P1-24c-4c；`docs/子方案/会话生成Skill.md` §8.1.2）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它是什么 / 不是什么
 * ─────────────────────────────────────────────────────────────────────
 * · **是**：一条 Redis 短 TTL 队列 `skill-draft-notice:{conversationId}` —— 草稿入口工具
 *   （`request_skill_draft` / `request_skill_revision`）产出的"待展示提示"；
 * · **不是**：草稿本身（草稿在 `skill-draft:{draftId}`，见 c-1）、也不是记忆（同族形态，不同键）。
 *
 * 与 `memory.service` 的"待展示提示"同一套取舍：**不依赖同一轮 SSE 流**（`done` 之后工具才
 * 可能写完草稿）⇒ 前端在下一次拉取（本轮结束 / 聚焦 / 重连）时取。提示卡可关闭、幂等
 * （同一 `draftId` 只保留一条），消费后不再出现。
 *
 * 四条口径：
 *  ① **归属判据只有一处**：`conversations.userId`（不是你的 = 不存在 = 404，与抽取端点同一条）；
 *  ② **`GET` 不消费**：打开页面 / 重连会重复拉到，前端按 `id` 去重；只有 `POST`（OPEN / DISMISS）才移除；
 *  ③ **草稿没了提示也就不弹**：`draftId` 指向的 Redis 草稿已过期 ⇒ 拉取时顺手丢弃（`FOREIGN` 无草稿保留）；
 *  ④ **读写恒不抛给业务错误**：Redis 抖动 ⇒ 按"没有提示"处理（提示只是锦上添花，不能拖垮对话页）。
 */

import { AppError, appMsg, type SkillDraftNotice } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureRedisConnected, readSkillDraftRaw } from '../infra/redis.js'

/** Redis 键（按会话；会话归本人，故不需要再带 userId） */
export function skillDraftNoticeKey(conversationId: string): string {
  return `skill-draft-notice:${conversationId}`
}

/** 提示卡 TTL 与草稿同源：草稿没了提示也没有意义 */
function noticeTtlSec(): number {
  return config.skill.draft.ttlSec
}

function noticeIdOf(): string {
  return `sn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function expiresAtOf(createdAt: string): string {
  return new Date(Date.parse(createdAt) + noticeTtlSec() * 1000).toISOString()
}

/** 宽松解析 Redis 里的提示数组（坏值一律当空；不抛） */
function parseNoticeList(raw: string | null): SkillDraftNotice[] {
  if (raw === null || raw.trim() === '') return []
  try {
    const decoded = JSON.parse(raw) as unknown
    if (!Array.isArray(decoded)) return []
    return decoded.filter(
      (item): item is SkillDraftNotice =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { conversationId?: unknown }).conversationId === 'string' &&
        typeof (item as { kind?: unknown }).kind === 'string',
    )
  } catch {
    return []
  }
}

/** 会话归属（**唯一判据**：`userId` 在 where 里；不是你的 = 不存在 = 404） */
async function requireMyConversation(conversationId: string, viewer: { id: string }): Promise<void> {
  const row = await getPrisma().conversation.findFirst({
    where: { id: conversationId, userId: viewer.id },
    select: { id: true },
  })
  if (row === null) throw AppError.notFound(appMsg('app.m001'))
}

/**
 * 推一条提示（工具执行成功后调用）。
 *
 * 幂等：同一 `draftId` 的旧提示先删掉（"改草稿"会复用同一份草稿 ⇒ 不能让旧卡留在队列里）；
 * `FOREIGN`（`draftId === null`）按 `kind + targetSkillId + reason` 去重。
 */
export async function pushSkillDraftNotice(
  conversationId: string,
  notice: Omit<SkillDraftNotice, 'id' | 'createdAt' | 'expiresAt'>,
): Promise<SkillDraftNotice | null> {
  const createdAt = new Date().toISOString()
  const item: SkillDraftNotice = {
    ...notice,
    id: noticeIdOf(),
    conversationId,
    createdAt,
    expiresAt: expiresAtOf(createdAt),
  }
  try {
    const redis = await ensureRedisConnected()
    const key = skillDraftNoticeKey(conversationId)
    const raw = await redis.get(key)
    const list = parseNoticeList(raw).filter((existing) => {
      if (item.draftId !== null) return existing.draftId !== item.draftId
      return !(
        existing.kind === item.kind &&
        existing.targetSkillId === item.targetSkillId &&
        existing.reason === item.reason
      )
    })
    list.push(item)
    await redis.set(key, JSON.stringify(list), 'EX', Math.max(1, Math.trunc(noticeTtlSec())))
    return item
  } catch (error) {
    getLogger().warn({ err: error, conversationId, kind: item.kind }, '写入 Skill 草稿提示失败（前端本轮看不到提示）')
    return null
  }
}

/**
 * 拉取待展示提示（**不消费**）。`draftId` 指向的草稿已过期 ⇒ 顺手丢弃。
 *
 * Redis 抖动 / 坏值 ⇒ 空数组（与 `readSkillLastLoaded` 同一条"锦上添花"判断）。
 */
export async function listSkillDraftNotices(
  conversationId: string,
  viewer: { id: string },
): Promise<SkillDraftNotice[]> {
  await requireMyConversation(conversationId, viewer)
  try {
    const redis = await ensureRedisConnected()
    const key = skillDraftNoticeKey(conversationId)
    const raw = await redis.get(key)
    if (raw === null) return []
    const list = parseNoticeList(raw)
    const kept: SkillDraftNotice[] = []
    for (const notice of list) {
      if (notice.draftId !== null && (await readSkillDraftRaw(notice.draftId)) === undefined) continue
      kept.push(notice)
    }
    if (kept.length !== list.length) {
      if (kept.length === 0) await redis.del(key)
      else {
        const ttl = await redis.ttl(key)
        await redis.set(key, JSON.stringify(kept), 'EX', ttl > 0 ? ttl : Math.max(1, Math.trunc(noticeTtlSec())))
      }
    }
    return kept
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '读取 Skill 草稿提示失败（按无提示处理）')
    return []
  }
}

/**
 * 消费一条提示（`OPEN` / `DISMISS` 都只是移除；差别在前端的下一步，不在服务端）。
 *
 * @returns `applied=false` = 提示已过期 / 不存在（幂等，不报错）
 */
export async function consumeSkillDraftNotice(input: {
  conversationId: string
  noticeId: string
  action: 'OPEN' | 'DISMISS'
  viewer: { id: string }
}): Promise<{ id: string; applied: boolean }> {
  await requireMyConversation(input.conversationId, input.viewer)
  try {
    const redis = await ensureRedisConnected()
    const key = skillDraftNoticeKey(input.conversationId)
    const raw = await redis.get(key)
    const list = parseNoticeList(raw)
    const matched = list.find((notice) => notice.id === input.noticeId)
    if (matched === undefined) return { id: input.noticeId, applied: false }
    const rest = list.filter((notice) => notice.id !== input.noticeId)
    if (rest.length === 0) await redis.del(key)
    else {
      const ttl = await redis.ttl(key)
      await redis.set(key, JSON.stringify(rest), 'EX', ttl > 0 ? ttl : Math.max(1, Math.trunc(noticeTtlSec())))
    }
    getLogger().info(
      { conversationId: input.conversationId, noticeId: input.noticeId, kind: matched.kind, action: input.action },
      'Skill 草稿提示已消费',
    )
    return { id: input.noticeId, applied: true }
  } catch (error) {
    getLogger().warn({ err: error, conversationId: input.conversationId }, '消费 Skill 草稿提示失败（按已消费处理）')
    return { id: input.noticeId, applied: false }
  }
}
