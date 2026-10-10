/**
 * 用量统计服务（P1-7）—— `GET /api/usage/summary` 的唯一实现
 *
 * 依据：`01` 决策 20 + §3.8 需求 37、`02` §三（`usage_records`）/§四（`GET /api/usage/summary`）、
 *      `shared/src/usage.ts`（契约）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：仅 ADMIN（`(A)` 族，与用户/模型池同族）
 * ─────────────────────────────────────────────────────────────────────
 * 路由挂 `app.requireAdmin`。这是**平台级报表**（"这个月谁用最多"），不是"看自己的用量" ——
 * 与"会话/产物/任务仅本人"刻意相反。普通用户看自己的 token 走**消息历史**那条路
 * （`messageItemSchema` 的 `tokensIn/tokensOut`，P1-7 契约增量），不经过本端点。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 聚合在 DB、排序在 JS
 * ─────────────────────────────────────────────────────────────────────
 * `groupBy` + `_sum` 交给 PG（分区裁剪 + `(user_id, created_at desc)` 等索引），
 * 但**排序**在 JS 里做：排序键是**派生的** `tokensTotal`（`in + out`，两者都空才是 `null`），
 * 它不是一个列，Prisma 的 `orderBy` 表达不了；而分组的个数是"用户/智能体/型号"量级（个位到几百），
 * 拉回来在内存里排的代价可以忽略。排序规则：`tokensTotal` 降序（`null` 排最后）→ `records` 降序
 * → `label` 升序（**并列段必须有副键**，否则每次请求顺序可能不同）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ `NULL` ≠ `0`（见 `shared/src/usage.ts` 文件头 ②）
 * ─────────────────────────────────────────────────────────────────────
 * `_sum` 会跳过 `NULL` ⇒ 全组都没上报时该列是 `null`；`tokenRecords`（= `_count.tokensIn`，
 * 数非空值）让读者能分辨"真的用了 0"与"没上报"。
 */

import {
  AppError,
  type UsageGroupBy,
  type UsageSummaryItem,
  type UsageSummaryQuery,
  type UsageSummaryResult,
} from '@doubulea/shared'

import { getPrisma } from '../infra/prisma.js'

/** 解析区间端点；省略用兜底值，解析不出直接 400（不在 schema 层做，与其余查询参数同款） */
function boundaryOf(value: string | undefined, fallback: Date): Date {
  if (value === undefined || value.trim() === '') return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw AppError.validation('时间区间不是合法的时间')
  return date
}

/** 一个分组聚合的中间形态（与 `groupBy` 的原始返回解耦，便于按维度归一） */
interface UsageGroup {
  key: string
  records: number
  tokensIn: number | null
  tokensOut: number | null
  tokenRecords: number
  durationMs: number
  rounds: number
}

/** 把 Prisma `groupBy` 的一行归一成 {@link UsageGroup}（`_sum` 的可空列逐列兜底） */
function toGroup(
  key: string,
  count: { _all: number; tokensIn: number },
  sum: {
    tokensIn: number | null
    tokensOut: number | null
    durationMs: number | null
    rounds: number | null
  },
): UsageGroup {
  return {
    key,
    records: count._all,
    tokensIn: sum.tokensIn,
    tokensOut: sum.tokensOut,
    tokenRecords: count.tokensIn,
    durationMs: sum.durationMs ?? 0,
    rounds: sum.rounds ?? 0,
  }
}

/** 已知的 `in + out`；两者都 `null` ⇒ `null`（"不知道"不是"0"） */
function totalOf(group: UsageGroup): number | null {
  if (group.tokensIn === null && group.tokensOut === null) return null
  return (group.tokensIn ?? 0) + (group.tokensOut ?? 0)
}

/**
 * 按维度聚合。三个维度**各自显式**调 `groupBy`（而不是 `by: [computedField]`）——
 * Prisma 的 `by` 要的是字面量字段名，传一个 `string` 变量过不了类型检查。
 */
async function groupUsage(groupBy: UsageGroupBy, where: { createdAt: { gte: Date; lt: Date } }): Promise<UsageGroup[]> {
  const db = getPrisma()
  const aggregate = {
    where,
    _count: { _all: true, tokensIn: true },
    _sum: { tokensIn: true, tokensOut: true, durationMs: true, rounds: true },
  } as const

  if (groupBy === 'model') {
    const rows = await db.usageRecord.groupBy({ by: ['model'], ...aggregate })
    return rows.map((row) => toGroup(row.model, row._count, row._sum))
  }
  if (groupBy === 'agent') {
    const rows = await db.usageRecord.groupBy({ by: ['agentId'], ...aggregate })
    return rows.map((row) => toGroup(row.agentId, row._count, row._sum))
  }
  const rows = await db.usageRecord.groupBy({ by: ['userId'], ...aggregate })
  return rows.map((row) => toGroup(row.userId, row._count, row._sum))
}

/** 给分组补上展示名（用户取用户名、智能体取名；模型名就是 key 本身） */
async function attachLabels(
  groupBy: UsageGroupBy,
  groups: UsageGroup[],
): Promise<Map<string, string>> {
  const db = getPrisma()
  const labels = new Map<string, string>()
  const keys = groups.map((group) => group.key)
  if (groupBy === 'user') {
    const users = await db.user.findMany({
      where: { id: { in: keys } },
      select: { id: true, username: true },
    })
    for (const user of users) labels.set(user.id, user.username)
  } else if (groupBy === 'agent') {
    const agents = await db.agent.findMany({
      where: { id: { in: keys } },
      select: { id: true, name: true },
    })
    for (const agent of agents) labels.set(agent.id, agent.name)
  } else {
    for (const key of keys) labels.set(key, key)
  }
  return labels
}

/**
 * 汇总用量报表（`GET /api/usage/summary`）。
 *
 * 区间左闭右开 `[from, to)`；省略时 `from` = 本月 1 日 00:00（本地时区）、`to` = 此刻。
 *
 * @throws {AppError} `VALIDATION`(400) 时间不合法 / 起点不早于终点
 */
export async function summarizeUsage(query: UsageSummaryQuery): Promise<UsageSummaryResult> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  const from = boundaryOf(query.from, monthStart)
  const to = boundaryOf(query.to, now)
  if (from.getTime() >= to.getTime()) {
    throw AppError.validation('时间区间的起点必须早于终点')
  }

  const where = { createdAt: { gte: from, lt: to } }
  const groups = await groupUsage(query.groupBy, where)
  const labels = await attachLabels(query.groupBy, groups)

  const items: UsageSummaryItem[] = groups
    .map((group) => ({
      key: group.key,
      label: labels.get(group.key) ?? group.key,
      records: group.records,
      tokensIn: group.tokensIn,
      tokensOut: group.tokensOut,
      tokensTotal: totalOf(group),
      tokenRecords: group.tokenRecords,
      durationMs: group.durationMs,
      rounds: group.rounds,
    }))
    // 排序：合计降序（null 最后）→ 记录数降序 → 名称升序（并列段副键，见文件头 ②）
    .sort((a, b) => {
      const totalDiff = (b.tokensTotal ?? -1) - (a.tokensTotal ?? -1)
      if (totalDiff !== 0) return totalDiff
      if (b.records !== a.records) return b.records - a.records
      return a.label.localeCompare(b.label)
    })

  return {
    groupBy: query.groupBy,
    from: from.toISOString(),
    to: to.toISOString(),
    items,
  }
}
