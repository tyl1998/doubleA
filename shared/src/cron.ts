/**
 * cron 表达式解析与「下一次触发时刻」计算（P1-6，2026-10-09 需求变更）
 *
 * 依据：`docs/01` 决策 28（定时任务）/ 需求 38、`docs/02` §4.8、`docs/03` §4.7。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么自写而不是引依赖（`06` §六 第 12 条：新增原生依赖要登记，且本仓一贯「零新依赖」）
 * ─────────────────────────────────────────────────────────────────────
 * 只需要一个**纯函数**：把 5 段 cron 解析成集合、再算「给定时刻之后的下一次」。
 * 引一个 cron 库会带来时区 / 秒级字段 / 秒级 tick 等我们**不用**的语义面，反而更难对齐。
 * 本文件因此只做标准 5 段（分 时 日 月 周），**时区 = 服务器本地时区**（与前端时间读数同口径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 支持语法（文档写明，避免"看起来支持其实不支持"）
 * ─────────────────────────────────────────────────────────────────────
 * · 字段：`分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6，0=周日；也接受 7=周日)`
 * · 取值：`*` / `a` / `a-b` / `a-b/step` / 全量加步长（星号加 `/step`）/ `a/step`（= a 到上界，步长 step）/ 逗号列表
 * · **不支持**：秒、`@daily` 之类别名、`L`/`W`/`#`、月份/星期英文名、`?`（要就给上界写法）
 * · **日 vs 周 的合并语义**：两者**都**被限定（都不是 `*`）时按标准 cron —— **命中其一即触发**；
 *   否则按"都要命中"（未限定的那一侧恒真，两种写法等价）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * P1-23（末批）：`describeCron` 的"人话描述"改走字典（**多收 `locale`**）
 * ─────────────────────────────────────────────────────────────────────
 * 本文件此前是**零外部依赖**（纯函数 + 常量）。`describeCron` 曾经直接拼中文，
 * 于是英文界面下任务表单仍显示「约 每天 09:00；」。
 *
 * 处置口径（`子方案/界面语言切换.md` §3.5 的"纯函数多收 locale"）：
 *   · 描述文案的**真相搬进字典**（`cron.desc.*`），本文件只保留"认出哪种形状"的判据；
 *   · 于是本文件多了**唯一一个**依赖：`./i18n/index.js`（`translate` + `Locale`），
 *     与 `document.ts` 同款。⚠️ **不要把 i18n 的别的东西引进来**（尤其别引前端 store）——
 *     本文件仍要能被后端与零依赖验收档直接 import。
 *   · 代价与收益：`describeCron` 不再是"零参数纯函数"，但它仍是**纯函数**（同输入同输出），
 *     且"中文形态逐字未变"由 `backend/scripts/cron-regression.ts` 的 E1 守住。
 */

import { translate, type Locale } from './i18n/index.js'

/** 解析后的 cron 五段（集合形态，供匹配与下一次计算共用） */
export interface ParsedCron {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  daysOfWeek: ReadonlySet<number>
  /** 日字段是否被限定（决定日/周的 AND/OR 语义，见文件头） */
  domRestricted: boolean
  /** 周字段是否被限定 */
  dowRestricted: boolean
}

/** 解析失败（`message` 是给用户看的一句话，路由据此回 400） */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

/** 下一次触发的最远搜索天数（≈5 年，足够覆盖"2 月 29 日"这类四年一遇） */
const SEARCH_DAYS = 366 * 5

interface FieldSpec {
  label: string
  min: number
  max: number
  /** 周字段把 7 折算成 0（周日两种写法） */
  normalize?: (value: number) => number
}

const FIELDS: readonly FieldSpec[] = [
  { label: '分钟', min: 0, max: 59 },
  { label: '小时', min: 0, max: 23 },
  { label: '日', min: 1, max: 31 },
  { label: '月', min: 1, max: 12 },
  { label: '周', min: 0, max: 7, normalize: (value) => (value === 7 ? 0 : value) },
]

/** 逐项解析一个字段（逗号分隔），返回集合 */
function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>()
  for (const token of raw.split(',')) {
    const part = token.trim()
    if (part === '') throw new CronParseError(`${spec.label}字段有空项（检查多余的逗号）`)

    const slash = part.split('/')
    if (slash.length > 2) throw new CronParseError(`${spec.label}字段「${part}」的 / 用多了`)

    const rangePart = slash[0] ?? ''
    const step = slash.length === 2 ? Number(slash[1]) : 1

    if (slash.length === 2 && (!Number.isInteger(step) || step < 1)) {
      throw new CronParseError(`${spec.label}字段「${part}」的步长必须是正整数`)
    }

    let start: number
    let end: number
    if (rangePart === '*') {
      start = spec.min
      end = spec.max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      start = Number(a)
      end = Number(b)
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new CronParseError(`${spec.label}字段「${part}」的区间端点不是整数`)
      }
    } else {
      start = Number(rangePart)
      end = slash.length === 2 ? spec.max : start // `a/step` = a 到上界；裸 `a` = 就它一个
      if (!Number.isInteger(start)) {
        throw new CronParseError(`${spec.label}字段「${part}」不是整数`)
      }
    }

    if (start < spec.min || end > spec.max || start > end) {
      throw new CronParseError(
        `${spec.label}字段「${part}」超出范围（允许 ${spec.min}-${spec.max}，且起点不大于终点）`,
      )
    }

    for (let value = start; value <= end; value += step) {
      out.add(spec.normalize === undefined ? value : spec.normalize(value))
    }
  }
  if (out.size === 0) throw new CronParseError(`${spec.label}字段没有匹配任何取值`)
  return out
}

/**
 * 解析 5 段 cron。失败抛 {@link CronParseError}（`message` 可直接展示）。
 *
 * 5 段而不是 6 段是刻意的：本仓调度粒度是**分钟**（tick 默认 30s，取分钟边界触发），
 * 多一段秒只会造出"写了 60 秒但实际上做不到"的空间。
 */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError('cron 必须是 5 段：分 时 日 月 周（例如 `0 9 * * 1`）')
  }
  const sets = FIELDS.map((spec, index) => parseField(parts[index] ?? '', spec))
  return {
    minutes: sets[0] ?? new Set(),
    hours: sets[1] ?? new Set(),
    daysOfMonth: sets[2] ?? new Set(),
    months: sets[3] ?? new Set(),
    daysOfWeek: sets[4] ?? new Set(),
    domRestricted: (parts[2] ?? '') !== '*',
    dowRestricted: (parts[4] ?? '') !== '*',
  }
}

/** 表达式是否合法（供表单校验与 body schema 的 `refine` 用） */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

/** 某个时刻（本地时间）是否命中这个 cron（只到分钟粒度） */
export function cronMatches(parsed: ParsedCron, at: Date): boolean {
  if (!parsed.minutes.has(at.getMinutes())) return false
  if (!parsed.hours.has(at.getHours())) return false
  if (!parsed.months.has(at.getMonth() + 1)) return false

  const domMatch = parsed.daysOfMonth.has(at.getDate())
  const dowMatch = parsed.daysOfWeek.has(at.getDay())
  // 日 / 周都被限定 ⇒ 标准 cron 的 OR；否则 AND（未限定的一侧恒真）
  return parsed.domRestricted && parsed.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch
}

/**
 * 计算 `from`（不含）之后**下一次**命中的时刻；找不到（如 `0 0 30 2 *` 永不成立）返回 `null`。
 *
 * 返回的是**本地时区**的 `Date`（服务器本地，与 `parseCron`/`cronMatches` 同口径）。
 * 逐分钟暴力扫描最坏是"5 年 × 1440"，但对"很少命中"的表达式会在少数候选日里快速命中，
 * 对"每分钟"的表达式则第一分钟就返回 —— 因而实际很快（这是本函数唯一允许的"够用就好"）。
 *
 * ⚠️ 不处理夏令时跳变（本仓部署在内网、时区固定；为它加复杂度不划算，文档写明）。
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  return nextCronRunParsed(parseCron(expr), from)
}

/** {@link nextCronRun} 的已解析版本（避免对同一表达式重复解析） */
export function nextCronRunParsed(parsed: ParsedCron, from: Date): Date | null {
  // 从"下一分钟"开始（cron 语义：`from` 这一分钟不再触发）
  const start = new Date(from)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const hours = [...parsed.hours].sort((a, b) => a - b)
  const minutes = [...parsed.minutes].sort((a, b) => a - b)

  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const day = new Date(start)
    day.setDate(start.getDate() + offset)
    if (!parsed.months.has(day.getMonth() + 1)) continue
    const domMatch = parsed.daysOfMonth.has(day.getDate())
    const dowMatch = parsed.daysOfWeek.has(day.getDay())
    const dayMatch =
      parsed.domRestricted && parsed.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch
    if (!dayMatch) continue

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day)
        candidate.setHours(hour, minute, 0, 0)
        if (candidate.getTime() >= start.getTime()) return candidate
      }
    }
  }
  return null
}

/**
 * 从 `from` 起连算接下来 `count` 次触发（本地时区）。
 *
 * 供**表单预览**用（`03` §4.7：输入 cron 后显示"下次执行时间"），也让"这个表达式到底多久跑一次"
 * 变成看得见的读数，而不是让用户自己脑补。找不到（不可能成立）就返回已找到的那些（可能为空）。
 */
export function nextCronRuns(expr: string, count: number, from: Date = new Date()): Date[] {
  const parsed = parseCron(expr)
  const out: Date[] = []
  let cursor = from
  for (let index = 0; index < count; index += 1) {
    const next = nextCronRunParsed(parsed, cursor)
    if (next === null) break
    out.push(next)
    cursor = next
  }
  return out
}

/** 星期 → i18n key（`0` = 周日；与 `label.weekday.*` 同一份真相，前端读数也用这组 key） */
const WEEKDAY_KEYS = [
  'label.weekday.0',
  'label.weekday.1',
  'label.weekday.2',
  'label.weekday.3',
  'label.weekday.4',
  'label.weekday.5',
  'label.weekday.6',
] as const

/** 两位补零 */
const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * cron 的**人类可读描述**（best-effort，只认几种常见形状；认不出返回 `null`）。
 *
 * ⚠️ 刻意**不做**"通用表达式 → 自然语言"的完整翻译：那是个坑（多值/区间/步长/日周 OR 语义组合起来
 * 极易描述错，而**描述错的代价比不给描述大**）。认得出的给一句话，认不出的让调用方回落去显示
 * "接下来 N 次执行时间"（{@link nextCronRuns}，那才是权威读数）。
 *
 * ⚠️ `locale` 是**必填**（P1-23 末批）：早先它是"零参纯函数、直接返回中文"，英文界面下这里就成了
 * 界面上唯一的汉语。现在只保留"认出哪种形状"的判据，文案一律 `translate(locale, 'cron.desc.*')`。
 * **zh 的译文与旧版逐字一致**（`backend/scripts/cron-regression.ts` 的 E1 逐条守着）。
 */
export function describeCron(expr: string, locale: Locale): string | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
  const isInt = (value: string): boolean => /^\d+$/.test(value)
  const hhmm = (h: string, m: string): string => `${pad2(Number(h))}:${pad2(Number(m))}`

  if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return translate(locale, 'cron.desc.everyMinute')
  }
  const step = /^\*\/(\d+)$/.exec(min)
  if (step !== null && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return translate(locale, 'cron.desc.everyNMinutes', { n: step[1] ?? '' })
  }
  if (isInt(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return translate(locale, 'cron.desc.hourlyAtMinute', { minute: pad2(Number(min)) })
  }
  if (isInt(min) && isInt(hour) && dom === '*' && month === '*' && dow === '*') {
    return translate(locale, 'cron.desc.dailyAt', { time: hhmm(hour, min) })
  }
  if (isInt(min) && isInt(hour) && dom === '*' && month === '*' && dow === '1-5') {
    return translate(locale, 'cron.desc.weekdaysAt', { time: hhmm(hour, min) })
  }
  if (isInt(min) && isInt(hour) && dom === '*' && month === '*' && isInt(dow)) {
    const day = translate(locale, WEEKDAY_KEYS[Number(dow) % 7] ?? 'label.weekday.0')
    return translate(locale, 'cron.desc.weeklyAt', { day, time: hhmm(hour, min) })
  }
  if (isInt(min) && isInt(hour) && isInt(dom) && month === '*' && dow === '*') {
    return translate(locale, 'cron.desc.monthlyAt', { day: Number(dom), time: hhmm(hour, min) })
  }
  return null
}
