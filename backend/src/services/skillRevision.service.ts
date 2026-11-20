/**
 * 「更新到 Skill」的目标选择（P1-24c-4；`docs/子方案/会话生成Skill.md` §10.1 / §10.3 / §10.5）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与邻居的分工
 * ─────────────────────────────────────────────────────────────────────
 * · 抽取与草稿在 `skillExtract.service.ts`（本文件不调模型、不写草稿）；
 * · 行级 ACL 在 `skill.service.ts`（`canEditSkill` —— 所属人 / ADMIN）；
 * · 「上次加载过哪一版」读 Redis `skill:last-loaded:{conversationId}`（a-4 的哈希，**只读**）；
 * · **本文件 = 一份候选清单**：本会话里"可以当作更新对象"的 Skill + 影响范围 + 我能不能直接改。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条口径（每条错了都会让用户"点了更新却改了别的 Skill"）
 * ─────────────────────────────────────────────────────────────────────
 * ① **候选来自两处并集**：本会话 `load_skill` 读过的（Redis 哈希）+ 本会话智能体**绑定**的 Skill。
 *    前者是"真的用过"，后者兜住"刚绑上还没加载"——只取后者会让默认目标落到一个没用过的 Skill。
 * ② **排序 = 最近加载优先**：Redis 哈希的插入顺序近似"最后写的在前"（`hset` 每次覆盖会移到末尾），
 *    所以按哈希键的**逆序**取；没有加载记录的按绑定顺序。
 * ③ **归属判据只有一处**：`canEditSkill`（非所属人 ⇒ `canUpdate=false`，前端只能 fork / 会话覆写）。
 *    **不在这里 403**：清单本身对任何会话所有者可见，拒绝发生在真正发起 REVISION 抽取时。
 * ④ **影响范围只数未软删的智能体**：`agentsFollowing` = 没固定版本的绑定，`agentsPinned` = 固定了版本的；
 *    软删智能体的绑定行还在库里，但它已经不会被用了 —— 数进去只会让用户以为"改一下影响很多人"。
 */

import {
  AppError,
  appMsg,
  effectiveSkillRuntime,
  skillVersionFromConfig,
  type SkillRevisionTarget,
  type SkillRevisionTargets,
} from '@doubulea/shared'

import { getPrisma } from '../infra/prisma.js'
import { readSkillLastLoaded } from '../infra/redis.js'
import { SKILL_SELECT, canEditSkill, canViewSkill, type SkillViewer } from './skill.service.js'

/** 会话归属（**唯一判据**：`userId` 在 where 里；不是你的 = 不存在 = 404，与抽取端点同一条） */
async function requireMyConversation(
  conversationId: string,
  viewer: SkillViewer,
): Promise<{ agentId: string }> {
  const row = await getPrisma().conversation.findFirst({
    where: { id: conversationId, userId: viewer.id },
    select: { id: true, agentId: true },
  })
  // 404 文案复用抽取端点的同一句（`skillExtract.service.ts#requireMyConversation`）
  if (row === null) throw AppError.notFound(appMsg('app.m001'))
  return { agentId: row.agentId }
}

/**
 * 本会话"当作更新对象"的 Skill id（① 加载过 ∪ 绑定过；**不含可见性判断**）。
 *
 * 可见性只决定"进不进给用户的候选清单"，不改变"这个会话到底在用哪些 Skill"——
 * 后者是运行时口径（P1-18：组件随 Agent 受众可用），`list_skills` 与候选清单必须同源。
 */
async function revisionCandidateIdsOf(
  conversationId: string,
  agentId: string,
): Promise<{ candidateIds: string[]; lastLoaded: Record<string, number> }> {
  const lastLoaded = (await readSkillLastLoaded(conversationId)) ?? {}
  const loadedOrder = Object.keys(lastLoaded).reverse()
  const bindings = await getPrisma().agentComponent.findMany({
    where: { agentId, componentType: 'SKILL' },
    select: { refId: true },
    orderBy: { createdAt: 'asc' },
  })
  return { candidateIds: [...new Set([...loadedOrder, ...bindings.map((row) => row.refId)])], lastLoaded }
}

/**
 * 本会话可更新的 Skill 候选（`GET /api/conversations/:id/skill-targets`）。
 *
 * 读的是**元数据**（`skills` 的 `slug/name/description/runtime/version/visibility/createdBy`），
 * 不读文件、不碰 S3 —— 与 `loadSkillSnapshot` 同一条纪律（§4.2.1）。
 */
export async function listSkillRevisionTargets(
  conversationId: string,
  viewer: SkillViewer,
): Promise<SkillRevisionTargets> {
  const db = getPrisma()
  const { agentId } = await requireMyConversation(conversationId, viewer)

  const { candidateIds, lastLoaded } = await revisionCandidateIdsOf(conversationId, agentId)
  if (candidateIds.length === 0) return { conversationId, items: [], hasLoadedSkill: false }

  const rows = await db.skill.findMany({
    where: { id: { in: candidateIds }, deletedAt: null },
    select: SKILL_SELECT,
  })
  const rowById = new Map(rows.map((row) => [row.id, row]))

  // 影响范围：一次查完所有绑定，再按 skillId 归并（避免逐个 count 打 N 次库）
  const allBindings = await db.agentComponent.findMany({
    where: { componentType: 'SKILL', refId: { in: candidateIds } },
    select: { refId: true, config: true, agent: { select: { deletedAt: true } } },
  })
  const impact = new Map<string, { agentsFollowing: number; agentsPinned: number }>()
  for (const binding of allBindings) {
    if (binding.agent.deletedAt !== null) continue
    const current = impact.get(binding.refId) ?? { agentsFollowing: 0, agentsPinned: 0 }
    if (skillVersionFromConfig(binding.config) === undefined) current.agentsFollowing += 1
    else current.agentsPinned += 1
    impact.set(binding.refId, current)
  }

  const items: SkillRevisionTarget[] = []
  for (const skillId of candidateIds) {
    const row = rowById.get(skillId)
    // 已软删 / 对我不可见（私有且非本人）⇒ 不当候选（不是 403：清单里干脆不出现）
    if (row === undefined || !canViewSkill(row, viewer)) continue
    const loaded = lastLoaded[skillId]
    items.push({
      skillId: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      runtime: effectiveSkillRuntime(row.runtime),
      version: row.version,
      loadedVersion: loaded ?? null,
      mostRecent: false,
      canUpdate: canEditSkill(row, viewer),
      visibility: row.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
      impact: impact.get(skillId) ?? { agentsFollowing: 0, agentsPinned: 0 },
    })
  }
  // ② 最近加载优先：`loadedOrder` 已经是"最后写入的在前"，其余保持绑定顺序（候选顺序本身）
  // 预选 = 列表第一项（本会话最后读过的那个；没有加载记录时退化成第一个绑定）
  const first = items[0]
  if (first !== undefined) first.mostRecent = true
  const hasLoadedSkill = items.some((item) => item.loadedVersion !== null)

  return { conversationId, items, hasLoadedSkill }
}

/** 本会话在用、但当前用户看不到也改不了的 Skill（只给工具回"没有权限"，**不进端点清单**） */
export interface HiddenSkillRevisionTarget {
  skillId: string
  name: string
  slug: string
  version: number
}

/**
 * 「本会话绑定 / 加载过，但对我不可见」的 Skill（P1-24c-4 · 私有且非本人）。
 *
 * 为什么单列一条而不是把端点清单放宽：`GET /skill-targets` 是**资产视角**（私有且非本人
 * ⇒ 不出现，与知识库同一条 ACL）；但会话运行时是按 Agent 受众用组件的（P1-18）——
 * 这些 Skill 确实在会话里被 `list_skills` / `load_skill` 读到了。用户点名要更新它们时，
 * 真实原因是"没有权限"而不是"不在候选 / 没绑定"，工具据此回 `FOREIGN` 而不是
 * `TARGET_NOT_FOUND`（后者会把模型引向"先加载一下再试"这条根本无效的路）。
 */
export async function listHiddenSkillRevisionTargets(
  conversationId: string,
  viewer: SkillViewer,
): Promise<HiddenSkillRevisionTarget[]> {
  const { agentId } = await requireMyConversation(conversationId, viewer)
  const { candidateIds } = await revisionCandidateIdsOf(conversationId, agentId)
  if (candidateIds.length === 0) return []

  const rows = await getPrisma().skill.findMany({
    where: { id: { in: candidateIds }, deletedAt: null },
    select: SKILL_SELECT,
  })
  return rows
    .filter((row) => !canViewSkill(row, viewer))
    .map((row) => ({ skillId: row.id, name: row.name, slug: row.slug, version: row.version }))
}
