/**
 * 任务中心页面模型（P1-6，2026-10-09 需求变更：定时任务）—— **零依赖纯逻辑**
 *
 * 依据：`docs/03` §4.7、`shared/src/task.ts`（契约）、`shared/src/cron.ts`（cron 唯一解析）。
 *
 * ⚠️ cron 合法性**不在前端重算**：用 `shared` 的 `isValidCron`（前后端同一份解析器）。
 * 本文件只放"展示翻译"：cron 预设与人类可读摘要、运行状态文案/色。
 */

import type { NotifyType, ScheduledRunStatus } from '@doubulea/shared'
import { describeCron, isValidCron, nextCronRuns } from '@doubulea/shared'

/** 通知渠道 → 中文（`01` 场景 1） */
export const NOTIFY_TYPE_LABELS: Record<NotifyType, string> = {
  NONE: '不通知',
  WECOM: '企业微信群机器人',
  FEISHU: '飞书自定义机器人',
  WEBHOOK: '通用 webhook',
}

/** 列表里的通知读数；`NONE` ⇒ `null`（界面那一格不显示） */
export function notifySummary(type: NotifyType): string | null {
  return type === 'NONE' ? null : NOTIFY_TYPE_LABELS[type]
}

/** 运行状态 → 中文 */
const RUN_STATUS_LABEL: Record<ScheduledRunStatus, string> = {
  NEVER: '从未运行',
  RUNNING: '运行中',
  SUCCESS: '成功',
  FAILED: '失败',
}

/** 运行状态 → AntD `Tag` 色 */
const RUN_STATUS_COLOR: Record<ScheduledRunStatus, string> = {
  NEVER: 'default',
  RUNNING: 'processing',
  SUCCESS: 'success',
  FAILED: 'error',
}

export function taskRunStatusLabel(status: ScheduledRunStatus): string {
  return RUN_STATUS_LABEL[status]
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
export const CRON_PRESETS: readonly { expr: string; label: string }[] = [
  { expr: '*/15 * * * *', label: '每 15 分钟' },
  { expr: '0 * * * *', label: '每小时整点' },
  { expr: '0 9 * * *', label: '每天 09:00' },
  { expr: '0 18 * * 1-5', label: '工作日 18:00' },
  { expr: '0 9 * * 1', label: '每周一 09:00' },
  { expr: '0 0 1 * *', label: '每月 1 日 00:00' },
]

/** 列表里的 cron 读数：命中预设就用预设名，否则原样显示表达式 */
export function scheduleSummary(cronExpr: string): string {
  const preset = CRON_PRESETS.find((item) => item.expr === cronExpr)
  return preset === undefined ? cronExpr : `${preset.label}（${cronExpr}）`
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 下一次执行时刻的读数（`MM-DD 周X HH:mm`，本地时区） */
function formatRunAt(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${WEEKDAY_LABELS[at.getDay()]} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** cron 输入后的**即时解析**读数：一句话描述（认得才给）+ 接下来 N 次执行时间（权威） */
export function cronHint(expr: string, count = 3): { description: string | null; next: string[] } {
  if (expr.trim() === '' || !isValidCron(expr)) return { description: null, next: [] }
  return {
    description: describeCron(expr),
    next: nextCronRuns(expr, count).map(formatRunAt),
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
