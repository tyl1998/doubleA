/**
 * 任务中心页面模型（P1-6，2026-10-09 需求变更：定时任务）—— **零依赖纯逻辑**
 *
 * 依据：`docs/03` §4.7、`shared/src/task.ts`（契约）、`shared/src/cron.ts`（cron 唯一解析）。
 *
 * ⚠️ cron 合法性**不在前端重算**：用 `shared` 的 `isValidCron`（前后端同一份解析器）。
 * 本文件只放"展示翻译"：cron 预设与人类可读摘要、运行状态文案/色。
 */

import type { MessageKey, NotifyType, ScheduledRunStatus } from '@doubulea/shared'
import { describeCron, isValidCron, nextCronRuns, translate, type Locale } from '@doubulea/shared'

/**
 * 通知渠道 → i18n key（P1-23：**存 key 不存中文**，§3.5 的 `label.*` 覆盖口径）。
 *
 * ⚠️ 为什么常量里不放中文：这份表被表单下拉与列表读数共用，写死中文就等于"第二份真相"
 * （改了字典漏了这里）。取值交给调用方（`useT()` / 需要纯函数时传 `locale`）。
 */
export const NOTIFY_TYPE_KEY: Record<NotifyType, MessageKey> = {
  NONE: 'label.notifyType.NONE',
  WECOM: 'label.notifyType.WECOM',
  FEISHU: 'label.notifyType.FEISHU',
  WEBHOOK: 'label.notifyType.WEBHOOK',
}

/** 列表里的通知读数；`NONE` ⇒ `null`（界面那一格不显示） */
export function notifySummary(type: NotifyType, locale: Locale): string | null {
  return type === 'NONE' ? null : translate(locale, NOTIFY_TYPE_KEY[type])
}

/** 运行状态 → i18n key */
const RUN_STATUS_KEY: Record<ScheduledRunStatus, MessageKey> = {
  NEVER: 'label.runStatus.NEVER',
  RUNNING: 'label.runStatus.RUNNING',
  SUCCESS: 'label.runStatus.SUCCESS',
  FAILED: 'label.runStatus.FAILED',
}

/** 运行状态 → AntD `Tag` 色 */
const RUN_STATUS_COLOR: Record<ScheduledRunStatus, string> = {
  NEVER: 'default',
  RUNNING: 'processing',
  SUCCESS: 'success',
  FAILED: 'error',
}

export function taskRunStatusLabel(status: ScheduledRunStatus, locale: Locale): string {
  return translate(locale, RUN_STATUS_KEY[status])
}

export function taskRunStatusColor(status: ScheduledRunStatus): string {
  return RUN_STATUS_COLOR[status]
}

/** 运行状态 → 状态灯（`.led--*` 的取值域；与列表页其它表的用法一致） */
const RUN_STATUS_LED: Record<ScheduledRunStatus, string> = {
  NEVER: 'idle',
  RUNNING: 'run',
  SUCCESS: 'ok',
  FAILED: 'fail',
}

export function taskRunStatusLed(status: ScheduledRunStatus): string {
  return RUN_STATUS_LED[status]
}

/**
 * cron 预设（表单里给常见几种，也可手填自定义）。
 *
 * `expr` 与 `label` 都写死在一处：表单下拉与列表的"人类可读摘要"共用同一张表，
 * 两处各写一份的话，改了预设而列表还显示旧文案，用户会以为没保存成功。
 */
export const CRON_PRESETS: readonly { expr: string; labelKey: MessageKey }[] = [
  { expr: '*/15 * * * *', labelKey: 'label.cronPreset.every15min' },
  { expr: '0 * * * *', labelKey: 'label.cronPreset.hourly' },
  { expr: '0 9 * * *', labelKey: 'label.cronPreset.daily9' },
  { expr: '0 18 * * 1-5', labelKey: 'label.cronPreset.weekday18' },
  { expr: '0 9 * * 1', labelKey: 'label.cronPreset.monday9' },
  { expr: '0 0 1 * *', labelKey: 'label.cronPreset.monthly1' },
]

/** 列表里的 cron 读数：命中预设就用预设名，否则原样显示表达式 */
export function scheduleSummary(cronExpr: string, locale: Locale): string {
  const preset = CRON_PRESETS.find((item) => item.expr === cronExpr)
  return preset === undefined ? cronExpr : `${translate(locale, preset.labelKey)}（${cronExpr}）`
}

/** 周几读数的 key（周日起；与 `Date#getDay()` 同序） */
const WEEKDAY_KEY: readonly MessageKey[] = [
  'label.weekday.0',
  'label.weekday.1',
  'label.weekday.2',
  'label.weekday.3',
  'label.weekday.4',
  'label.weekday.5',
  'label.weekday.6',
]

/** 下一次执行时刻的读数（`MM-DD 周X HH:mm`，本地时区） */
function formatRunAt(at: Date, locale: Locale): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${translate(locale, WEEKDAY_KEY[at.getDay()] ?? 'label.weekday.0')} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * cron 输入后的**即时解析**读数：一句话描述（认得才给）+ 接下来 N 次执行时间（权威）。
 *
 * ⚠️ `description` 来自 `shared#describeCron(expr, locale)`（P1-23 末批起**也走字典**）——
 * 那个纯函数只保留"认出哪种形状"的判据，文案在 `cron.desc.*`；于是 en 下
 * "约 每天 09:00；"这句描述也是英文。`next` 的周几读数同样走 `label.weekday.*`。
 */
export function cronHint(expr: string, locale: Locale, count = 3): { description: string | null; next: string[] } {
  if (expr.trim() === '' || !isValidCron(expr)) return { description: null, next: [] }
  return {
    description: describeCron(expr, locale),
    next: nextCronRuns(expr, count).map((at) => formatRunAt(at, locale)),
  }
}

/**
 * 任务列表的轮询间隔：**只要有任务处于「运行中」，就每 3s 重拉一次**，跑完就停。
 *
 * ⚠️ 没有它，"立即执行"后页面会**一直停在「运行中」**（那一行是后端点完就写的，
 * 跑完改成 SUCCESS/FAILED 时页面毫不知情）—— 这正是用户看到"删了会话还显示运行中"的原因。
 * 判据只在服务端（`lastRunStatus`），前端只据它决定要不要继续轮询。
 */
export const TASKS_ACTIVE_POLL_MS = 3000

export function scheduledTasksRefetchInterval(
  items: readonly { lastRunStatus: ScheduledRunStatus }[] | undefined,
): number | false {
  if (items === undefined) return false
  return items.some((item) => item.lastRunStatus === 'RUNNING') ? TASKS_ACTIVE_POLL_MS : false
}
