/**
 * 用量统计页的**零依赖纯逻辑**（P1-7）
 *
 * 依据：`docs/03` §4.8（`/admin/usage`）、`shared/src/usage.ts`（契约）。
 *
 * 放在这里的东西只有两类：**时间区间**（预设 + 格式化）与**读数格式化**（token / 时长 / 轮次）。
 * 它们都不 import `antd` / `react` / `api`，因此能进无依赖验收档逐条断言
 * （`pnpm verify:usage-ui`）—— 时间区间的边界最容易写错（"本月"包不包含今天、"近 7 天"是 7 个
 * 自然日还是 168 小时），而它错了的后果是"报表少算了一天的量"这种**看着合理的错**。
 *
 * ⚠️ 时间一律用**本地时区**构造、再 `toISOString()`（带 `Z` 的绝对时刻）发给后端；
 * 后端按 `usage_records.created_at`（`timestamptz`）比较。区间**左闭右开** `[from, to)`，
 * 与 `shared/src/usage.ts` 的口径一致。
 */

/** 一个时间区间（ISO 8601 绝对时刻字符串） */
export interface UsageRange {
  from: string
  to: string
}

/** 当月 1 日 00:00:00.000（本地时区） */
function startOfMonth(date: Date, monthOffset = 0): Date {
  return new Date(date.getFullYear(), date.getMonth() + monthOffset, 1, 0, 0, 0, 0)
}

/**
 * 本月：当月 1 日 00:00 → **此刻**（不是"下月 1 日"）。
 *
 * `to` 取此刻而不是月末：报表是"到目前为止"的读数（未来的量当然是 0，但显示一个未来时刻
 * 当区间终点会让人以为"这个月已经过完了"）。
 */
export function thisMonthRange(now: Date = new Date()): UsageRange {
  return { from: startOfMonth(now).toISOString(), to: now.toISOString() }
}

/** 上月：上月 1 日 00:00 → 本月 1 日 00:00（整月，左闭右开正好是"上个月"） */
export function lastMonthRange(now: Date = new Date()): UsageRange {
  return { from: startOfMonth(now, -1).toISOString(), to: startOfMonth(now).toISOString() }
}

/** 近 N 个自然日（含今天）：`N=7` ⇒ 今天往前数 7 天 00:00 → 此刻 */
export function lastDaysRange(days: number, now: Date = new Date()): UsageRange {
  const span = Math.max(1, Math.trunc(days))
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (span - 1), 0, 0, 0, 0)
  return { from: from.toISOString(), to: now.toISOString() }
}

/** 预设区间的稳定标识（UI 高亮用） */
export type UsageRangePresetKey = 'thisMonth' | 'lastMonth' | 'last7' | 'last30'

export interface UsageRangePreset {
  key: UsageRangePresetKey
  label: string
  range: UsageRange
}

/** 预设区间（顺序即界面顺序；"本月"是默认） */
export function usageRangePresets(now: Date = new Date()): UsageRangePreset[] {
  return [
    { key: 'thisMonth', label: '本月', range: thisMonthRange(now) },
    { key: 'lastMonth', label: '上月', range: lastMonthRange(now) },
    { key: 'last7', label: '近 7 天', range: lastDaysRange(7, now) },
    { key: 'last30', label: '近 30 天', range: lastDaysRange(30, now) },
  ]
}

/** `Date` → `YYYY-MM-DD`（本地时区；给 `<input type="date">` 回填用） */
export function dateInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * `YYYY-MM-DD`（本地）→ 当天 00:00 的 ISO；解析不出 ⇒ `null`。
 *
 * ⚠️ `new Date('2026-08-01')` 会被当成 **UTC** 午夜（规范如此），在东八区就成了当天 08:00
 * ⇒ 必须显式 `new Date(y, m-1, d)` 按**本地**构造（"本月 1 日"与用户看到的那一天才是同一天）。
 */
export function dayStartIso(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (match === null) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0)
  if (Number.isNaN(date.getTime())) return null
  // 反向校验（`2026-02-31` 会被 Date 静默进位成 3 月）—— 进位了就当非法输入
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) {
    return null
  }
  return date.toISOString()
}

/** `YYYY-MM-DD`（本地）→ **次日** 00:00 的 ISO（右开边界 = "这一天结束"）；解析不出 ⇒ `null` */
export function dayEndIso(day: string): string | null {
  const start = dayStartIso(day)
  if (start === null) return null
  const next = new Date(start)
  next.setDate(next.getDate() + 1)
  return next.toISOString()
}

/**
 * 由两个日期输入框的值构造区间（左闭右开）。
 *
 * `to` 取"那一天的次日 00:00" ⇒ 用户选 08-01 ~ 08-13 时，08-13 当天**算在内**（符合直觉）。
 * 任一非法或起点不早于终点 ⇒ `null`（调用方据此禁用查询 / 提示）。
 */
export function rangeFromDayInputs(fromDay: string, toDay: string): UsageRange | null {
  const from = dayStartIso(fromDay)
  const toExclusive = dayEndIso(toDay)
  if (from === null || toExclusive === null) return null
  if (new Date(from).getTime() >= new Date(toExclusive).getTime()) return null
  return { from, to: toExclusive }
}

/** 千分位分组（不用 `toLocaleString`：输出随环境变化，报表读数要能对照截图） */
function groupThousands(value: number): string {
  const sign = value < 0 ? '-' : ''
  const digits = String(Math.abs(Math.trunc(value)))
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** token 数：`null`（没上报）⇒ `—`（不是 0）；否则千分位 */
export function formatTokens(value: number | null): string {
  return value === null ? '—' : groupThousands(value)
}

/** 记录数 / 轮次：普通整数（千分位） */
export function formatCount(value: number): string {
  return groupThousands(value)
}

/** 时长：`< 1s` 给毫秒、`< 1min` 给秒（一位小数）、否则给"分 + 秒" */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

/**
 * 覆盖度读数：`tokenRecords / records`（有多少条真的上报了 token）。
 *
 * 报表里 token 之和是"**已知的**和"（`NULL` 被跳过）⇒ 不给出这个分母，
 * 读者无法分辨"这组真的只用了这么多"与"一半记录没上报"（`NULL` ≠ `0`）。
 */
export function coverageText(tokenRecords: number, records: number): string {
  if (records <= 0) return '—'
  return `${groupThousands(tokenRecords)} / ${groupThousands(records)} 条上报`
}
