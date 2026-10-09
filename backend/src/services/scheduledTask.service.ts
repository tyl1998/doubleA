/**
 * 定时任务服务（P1-6，2026-10-09 需求变更）—— CRUD 与投影
 *
 * 依据：`01` 决策 28 + §3.7 需求 38（**重定义**：任务中心 = 定时任务）、`02` §4.8、`03` §4.7、
 *      `shared/src/task.ts`（契约）、`shared/src/cron.ts`（cron 唯一解析）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 权限：仅本人（`scheduled_tasks.user_id`），与会话同族
 * ─────────────────────────────────────────────────────────────────────
 * 判据落在查询 `where`（`userId: viewer.id`），路由层不写任何权限函数 —— 别人的任务与不存在
 * 的 id 返回**同一个 404**（与会话/产物同款，`02` §4.5 ①）。连 ADMIN 也不开后门。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ `nextRunAt` 的写入只有一处（建 / 改）
 * ─────────────────────────────────────────────────────────────────────
 * `nextRunAt = enabled ? nextCronRun(cronExpr, now) : null`。调度器只负责"跑完推进到下一次"，
 * 建/改由本文件算。两处各算一遍，迟早出现"改完 cron 后要等到旧周期才生效"这种静默错位。
 */

import {
  AppError,
  nextCronRun,
  type CreateScheduledTaskBody,
  type ListScheduledTasksQuery,
  type NotifyType,
  type ScheduledTaskItem,
  type ScheduledTaskListResult,
  type UpdateScheduledTaskBody,
} from '@doubulea/shared'

import { encryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import type { ConversationViewer } from './conversation.service.js'

const SCHEDULED_TASK_SELECT = {
  id: true,
  agentId: true,
  name: true,
  prompt: true,
  cronExpr: true,
  enabled: true,
  autoApprove: true,
  notifyType: true,
  notifyUrl: true,
  notifySecret: true,
  notifyTemplate: true,
  nextRunAt: true,
  lastRunAt: true,
  lastRunStatus: true,
  lastConversationId: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: { name: true } },
} as const

/** {@link SCHEDULED_TASK_SELECT} 的产物形态（手写出来给 {@link toItem} 收窄用） */
export interface ScheduledTaskRow {
  id: string
  agentId: string
  name: string
  prompt: string
  cronExpr: string
  enabled: boolean
  autoApprove: boolean
  notifyType: NotifyType
  notifyUrl: string | null
  notifySecret: string | null
  notifyTemplate: string | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  lastRunStatus: ScheduledTaskItem['lastRunStatus']
  lastConversationId: string | null
  createdAt: Date
  updatedAt: Date
  agent: { name: string }
}

/** 行 → 对外形态（**唯一出口**） */
export function toScheduledTaskItem(row: ScheduledTaskRow): ScheduledTaskItem {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent.name,
    name: row.name,
    prompt: row.prompt,
    cronExpr: row.cronExpr,
    enabled: row.enabled,
    autoApprove: row.autoApprove,
    notifyType: row.notifyType,
    notifyUrlSet: row.notifyUrl !== null,
    notifySecretSet: row.notifySecret !== null,
    notifyTemplate: row.notifyTemplate,
    nextRunAt: row.nextRunAt === null ? null : row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt === null ? null : row.lastRunAt.toISOString(),
    lastRunStatus: row.lastRunStatus,
    lastConversationId: row.lastConversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 下一次触发时刻：启用时按 cron 算，停用时为 `null`（见文件头） */
function nextRunAtFor(cronExpr: string, enabled: boolean, now: Date = new Date()): Date | null {
  if (!enabled) return null
  const next = nextCronRun(cronExpr, now)
  if (next === null) {
    // cron 合法但 5 年内无解（如 `0 0 30 2 *`）—— 如实拒绝，而不是留一个永远不会触发的任务
    throw AppError.validation('cron 表达式在可预见的未来没有匹配时刻（检查 日/月 组合）')
  }
  return next
}

/** 校验目标智能体：存在且未软删（**两种类型都允许** —— ChatBot 也能调 MCP 工具干活，见 `01` 决策 28） */
async function assertSchedulableAgent(agentId: string): Promise<void> {
  const agent = await getPrisma().agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select: { id: true },
  })
  if (agent === null) throw AppError.notFound('智能体不存在')
}

/** webhook 地址 / 密钥的加密：`undefined` = 不改（update）；空串 = 清除；非空 = 加密存储 */
function encryptOrNull(plain: string | undefined): string | null | undefined {
  if (plain === undefined) return undefined
  const trimmed = plain.trim()
  return trimmed === '' ? null : encryptSecret(trimmed)
}

/** 选了渠道却没地址 ⇒ 拒绝（一条永远发不出去的通知没有意义） */
function assertNotifyUsable(notifyType: NotifyType, urlCipher: string | null): void {
  if (notifyType !== 'NONE' && urlCipher === null) {
    throw AppError.validation('选择了通知渠道就必须填写 webhook 地址')
  }
}

// ───────────────────────────── 列表 ─────────────────────────────

/**
 * 本人定时任务列表（`GET /api/tasks`）。排序：`createdAt desc`（最近建的在前），以 `id` 兜底
 * （P0-1-20 的教训：并列段没有副键就是"顺序随机"）。`total` 与当页同一个事务。
 */
export async function listScheduledTasks(
  query: ListScheduledTasksQuery,
  viewer: ConversationViewer,
): Promise<ScheduledTaskListResult> {
  const db = getPrisma()
  const where = { userId: viewer.id } as const
  const [rows, total] = await db.$transaction([
    db.scheduledTask.findMany({
      where,
      select: SCHEDULED_TASK_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.scheduledTask.count({ where }),
  ])
  return {
    items: (rows as unknown as ScheduledTaskRow[]).map(toScheduledTaskItem),
    total,
    offset: query.offset,
    limit: query.limit,
  }
}

// ───────────────────────────── 取一条（本人的） ─────────────────────────────

/** 取本人一条任务（列表外的单条读写共用）；不是我的 / 不存在都 404 */
export async function findMyScheduledTask(
  id: string,
  viewer: ConversationViewer,
): Promise<ScheduledTaskRow> {
  const row = await getPrisma().scheduledTask.findFirst({
    where: { id, userId: viewer.id },
    select: SCHEDULED_TASK_SELECT,
  })
  if (row === null) throw AppError.notFound('定时任务不存在')
  return row as unknown as ScheduledTaskRow
}

// ───────────────────────────── 建 ─────────────────────────────

export async function createScheduledTask(
  body: CreateScheduledTaskBody,
  viewer: ConversationViewer,
): Promise<ScheduledTaskItem> {
  await assertSchedulableAgent(body.agentId)
  const nextRunAt = nextRunAtFor(body.cronExpr, body.enabled)
  const notifyUrl = encryptOrNull(body.notifyUrl) ?? null
  const notifySecret = encryptOrNull(body.notifySecret) ?? null
  assertNotifyUsable(body.notifyType, notifyUrl)
  const created = await getPrisma().scheduledTask.create({
    data: {
      userId: viewer.id,
      agentId: body.agentId,
      name: body.name,
      prompt: body.prompt,
      cronExpr: body.cronExpr,
      enabled: body.enabled,
      autoApprove: body.autoApprove,
      notifyType: body.notifyType,
      notifyUrl,
      notifySecret,
      notifyTemplate: body.notifyTemplate === undefined || body.notifyTemplate === '' ? null : body.notifyTemplate,
      nextRunAt,
    },
    select: SCHEDULED_TASK_SELECT,
  })
  getLogger().info({ taskId: created.id, userId: viewer.id, agentId: body.agentId }, '已创建定时任务')
  return toScheduledTaskItem(created as unknown as ScheduledTaskRow)
}

// ───────────────────────────── 改 ─────────────────────────────

export async function updateScheduledTask(
  id: string,
  body: UpdateScheduledTaskBody,
  viewer: ConversationViewer,
): Promise<ScheduledTaskItem> {
  const existing = await findMyScheduledTask(id, viewer)
  const enabled = body.enabled ?? existing.enabled
  const cronExpr = body.cronExpr ?? existing.cronExpr
  // 只有"启用态**真的变了**或 cron 变了"才重排下一次 —— 改个名字（或把同一个 enabled 原样回传）
  // 不该把下一次触发往后推
  const enabledChanged = body.enabled !== undefined && body.enabled !== existing.enabled
  const scheduleChanged = enabledChanged || body.cronExpr !== undefined

  const notifyType = body.notifyType ?? existing.notifyType
  const notifyUrlNew = encryptOrNull(body.notifyUrl)
  const notifyUrl = notifyUrlNew === undefined ? existing.notifyUrl : notifyUrlNew
  const notifySecretNew = encryptOrNull(body.notifySecret)
  const notifySecret = notifySecretNew === undefined ? existing.notifySecret : notifySecretNew
  assertNotifyUsable(notifyType, notifyUrl)

  const updated = await getPrisma().scheduledTask.update({
    where: { id: existing.id },
    data: {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
      ...(body.cronExpr === undefined ? {} : { cronExpr: body.cronExpr }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.autoApprove === undefined ? {} : { autoApprove: body.autoApprove }),
      ...(body.notifyType === undefined ? {} : { notifyType: body.notifyType }),
      notifyUrl,
      notifySecret,
      ...(body.notifyTemplate === undefined
        ? {}
        : { notifyTemplate: body.notifyTemplate === '' ? null : body.notifyTemplate }),
      ...(scheduleChanged ? { nextRunAt: nextRunAtFor(cronExpr, enabled) } : {}),
    },
    select: SCHEDULED_TASK_SELECT,
  })
  return toScheduledTaskItem(updated as unknown as ScheduledTaskRow)
}

// ───────────────────────────── 删 ─────────────────────────────

export async function removeScheduledTask(
  id: string,
  viewer: ConversationViewer,
): Promise<{ id: string }> {
  const existing = await findMyScheduledTask(id, viewer)
  await getPrisma().scheduledTask.delete({ where: { id: existing.id } })
  return { id: existing.id }
}
