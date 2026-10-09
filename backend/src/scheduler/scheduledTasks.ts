/**
 * 定时任务调度器（P1-6，2026-10-09 需求变更）—— **进程级后台组件**
 *
 * 依据：`docs/02` §4.8 的执行口径、`docs/01` 决策 28、`docs/06` §六（后台组件的生命周期归
 *      `index.ts`，不放进 `buildApp()` —— 否则 `app.inject` 式契约验收会顺带把调度器拉起来）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 一轮 tick 干三件事
 * ─────────────────────────────────────────────────────────────────────
 *   ① 查到期任务（`enabled && nextRunAt <= now`，按 `nextRunAt` 升序、每轮封顶 `maxDuePerTick`）；
 *   ② **先把 `nextRunAt` 推进到下一次**（`updateMany` 拿旧值做 CAS），推进成功才触发 ——
 *      CAS 既是"防重复触发"（多进程也只有一个 `count===1`），也是"防崩溃后原地卡死"
 *      （先推进再跑，进程中途死掉也不会把同一分钟反复触发）；
 *   ③ **立即执行**（不 await 整轮）：建一个新会话 → 记 `RUNNING` → 后台驱动该智能体（ChatBot / TaskAgent），
 *      跑完改回 `SUCCESS`/`FAILED`。整轮可能几分钟，不能让 tick 被它卡住。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 并发 / 自愈
 * ─────────────────────────────────────────────────────────────────────
 * · `inFlight` 是本进程的"这个任务正在跑"集合：调度器遇到在跑的**跳过**（等下一轮），
 *   "立即执行"遇到在跑的**回 409**（显式告诉用户——他点的是同步动作，静默忽略最糟）。
 * · 进程崩溃会残留 `lastRunStatus='RUNNING'`：不影响调度（判据是 `nextRunAt`），
 *   只是那一条读数停在哪一步；下一次该任务触发会把它覆盖成新状态。
 */

import { AppError, nextCronRunParsed, parseCron, type NotifyType } from '@doubulea/shared'

import { config } from '../config.js'
import { decryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { clearNotifyTarget, sendNotification, setNotifyTarget, type NotifyTarget } from '../notify/index.js'
import { runScheduledTaskTurn } from '../orchestrator/scheduledRun.js'
import { createConversation } from '../services/conversation.service.js'

/** 调度器运行态（启动日志 / 探活 / 调试读它） */
export interface ScheduledTaskStats {
  running: boolean
  tickSec: number
  /** 本进程此刻在跑的任务数 */
  inFlight: number
  /** 上一轮 tick 处理的到期任务数；从未跑过为 undefined */
  lastDueCount?: number
  /** 上一轮 tick 的时刻（epoch ms） */
  lastTickAt?: number
  /** 上一轮 tick 里触发失败的条数（CAS 抢占不算失败） */
  lastFailedCount?: number
}

/** tick 只读这几列（触发用 + 推进下一次）；`name` 不参与调度，不拉它 */
const DUE_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  name: true,
  prompt: true,
  cronExpr: true,
  autoApprove: true,
  notifyType: true,
  notifyUrl: true,
  notifySecret: true,
  notifyTemplate: true,
  nextRunAt: true,
} as const

/** 触发一个任务所需的最小信息（"立即执行"也用它，见 {@link triggerScheduledTaskRun}） */
export interface RunnableTask {
  id: string
  userId: string
  agentId: string
  name: string
  prompt: string
  /** 无人值守时对危险工具的处置（见 `scheduledRun.ts`） */
  autoApprove: boolean
  /** 通知渠道（密文；`NONE` 时 url 为 null） */
  notifyType: NotifyType
  notifyUrl: string | null
  notifySecret: string | null
  /** 通知模板（明文；空 = 内置默认） */
  notifyTemplate: string | null
}

interface DueTask extends RunnableTask {
  cronExpr: string
  nextRunAt: Date | null
}

/** 把任务的通知列（密文）解成可用目标；未配置/解不开都返回 `null`（只记 warn，不影响运行） */
function notifyTargetOf(task: RunnableTask): NotifyTarget | null {
  if (task.notifyType === 'NONE' || task.notifyUrl === null) return null
  try {
    const url = decryptSecret(task.notifyUrl)
    const secret = task.notifySecret === null ? null : decryptSecret(task.notifySecret)
    return { type: task.notifyType, url, secret, title: task.name }
  } catch (error) {
    getLogger().warn({ err: error, taskId: task.id }, '通知渠道解密失败（本轮不发通知）')
    return null
  }
}

/** 读该会话最后一条助手消息的正文（跑完自动推送的内容来源） */
async function readFinalText(conversationId: string): Promise<string> {
  const row = await getPrisma().message.findFirst({
    where: { conversationId, role: 'ASSISTANT' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { content: true },
  })
  if (row === null) return ''
  const content = row.content as { text?: unknown }
  return typeof content.text === 'string' ? content.text.trim() : ''
}

/** "这个任务正在跑"的进程内集合（见文件头） */
const inFlight = new Set<string>()
let timer: NodeJS.Timeout | undefined
let lastDueCount: number | undefined
let lastTickAt: number | undefined
let lastFailedCount: number | undefined

/**
 * 「立即执行」与调度器共用的启动路径。
 *
 * 建会话 + 置 `RUNNING` 是**同步完成**的（很快），随后返回 `conversationId`；真正的驱动在后台
 * 继续（`performRun`）。这样"立即执行"能立刻把会话交回给用户，而调度器也不会被整轮卡住。
 *
 * @throws {AppError} `CONFLICT`(409) —— 同一任务已在跑（仅"立即执行"这条会根据它回 409）
 */
export async function triggerScheduledTaskRun(task: RunnableTask): Promise<{ conversationId: string }> {
  if (inFlight.has(task.id)) throw AppError.conflict('这个任务正在运行中')
  return startRun(task)
}

async function startRun(task: RunnableTask): Promise<{ conversationId: string }> {
  const db = getPrisma()
  inFlight.add(task.id)
  let conversationId: string | null = null
  try {
    const created = await createConversation({ agentId: task.agentId }, { id: task.userId })
    conversationId = created.id
    // 通知渠道登记到本次会话上（`send_notification` 工具与跑完自动推送都按 conversationId 取）
    const target = notifyTargetOf(task)
    if (target !== null) setNotifyTarget(created.id, target)
    await db.scheduledTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: 'RUNNING',
        lastConversationId: created.id,
      },
    })
    // 后台驱动：整轮可能几分钟，不 await
    void performRun(task, created.id, target).catch((error: unknown) => {
      getLogger().error({ err: error, taskId: task.id }, '定时任务运行收尾时抛出（已吞，见 performRun）')
    })
    return { conversationId: created.id }
  } catch (error) {
    // 建会话/置 RUNNING 就失败了：没有后台任务接手，这里必须自己从 inFlight 摘掉
    if (conversationId !== null) clearNotifyTarget(conversationId)
    inFlight.delete(task.id)
    throw error
  }
}

/** 后台整轮：驱动该智能体，跑完把状态改成终态（**永不抛出**，错误只落日志与状态） */
async function performRun(
  task: RunnableTask,
  conversationId: string,
  target: NotifyTarget | null,
): Promise<void> {
  const db = getPrisma()
  try {
    const outcome = await runScheduledTaskTurn({
      conversationId,
      userId: task.userId,
      agentId: task.agentId,
      content: task.prompt,
      autoApprove: task.autoApprove,
    })
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { lastRunStatus: 'SUCCESS' },
    })
    getLogger().info(
      { taskId: task.id, conversationId, timedOut: outcome.timedOut },
      '定时任务运行完成',
    )
    // 跑完自动推送结果（场景 1 的第一种形态）：无渠道则跳过；带 run 元信息（时间/状态），各渠道按自身渲染
    if (target !== null) {
      const finalText = await readFinalText(conversationId).catch(() => '')
      await sendNotification(target, {
        title: task.name,
        text: finalText,
        run: { at: new Date(), ok: true },
        template: task.notifyTemplate,
      })
    }
  } catch (error) {
    await db.scheduledTask
      .update({ where: { id: task.id }, data: { lastRunStatus: 'FAILED' } })
      .catch(() => undefined)
    getLogger().warn(
      { err: error, taskId: task.id, conversationId },
      '定时任务运行失败（已记为 FAILED）',
    )
    if (target !== null) {
      await sendNotification(target, {
        title: task.name,
        text: '运行失败，请到任务中心查看该会话。',
        run: { at: new Date(), ok: false },
        template: task.notifyTemplate,
      })
    }
  } finally {
    clearNotifyTarget(conversationId)
    inFlight.delete(task.id)
  }
}

/**
 * 跑一轮调度（导出是为了能**不启定时器**地单测/验收：喂当前时刻，断言"到点的被推进了"）。
 */
export async function runScheduledTaskTick(now: Date = new Date()): Promise<{ due: number; failed: number }> {
  const db = getPrisma()
  const due = (await db.scheduledTask.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: DUE_SELECT,
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
    take: config.scheduledTask.maxDuePerTick,
  })) as unknown as DueTask[]

  let failed = 0
  for (const task of due) {
    if (inFlight.has(task.id)) continue
    let parsed
    try {
      parsed = parseCron(task.cronExpr)
    } catch (error) {
      // 不该发生（建/改时校验过）；真发生了就停用并告警，免得每轮都刷同一句
      getLogger().error({ err: error, taskId: task.id, cronExpr: task.cronExpr }, '定时任务 cron 非法，已停用')
      await db.scheduledTask
        .update({ where: { id: task.id }, data: { enabled: false, nextRunAt: null } })
        .catch(() => undefined)
      failed += 1
      continue
    }

    const next = nextCronRunParsed(parsed, now)
    // ★ 先推进下一次（CAS：拿查出来的旧值当条件）；只有抢占成功的那一个才触发
    const advanced = await db.scheduledTask.updateMany({
      where: { id: task.id, nextRunAt: task.nextRunAt },
      data: { nextRunAt: next },
    })
    if (advanced.count !== 1) continue

    try {
      await startRun(task)
    } catch (error) {
      failed += 1
      getLogger().warn({ err: error, taskId: task.id }, '定时任务触发失败（会话/闸门），本轮到点已跳过')
    }
  }

  lastDueCount = due.length
  lastFailedCount = failed
  lastTickAt = now.getTime()
  return { due: due.length, failed }
}

/**
 * 启动对账：把上一个进程遗留的 `RUNNING` 标为 `FAILED`。
 *
 * ⚠️ **必需**（与沙箱 `reconcileOnBoot` 同一条理由）：后台运行在**本进程内**，进程一没，那一轮就
 * 断了 —— 但 `lastRunStatus='RUNNING'` 已经写进库了。不做对账，用户会看到一条**永远停在"运行中"**
 * 的任务（用户实测即此：删了会话、重启后仍显示运行中）。启动时 `inFlight` 必为空 ⇒ 此刻库里的
 * `RUNNING` 全是孤儿，直接清成 `FAILED` 是安全的。
 */
export async function reconcileScheduledRunsOnBoot(): Promise<number> {
  const result = await getPrisma().scheduledTask.updateMany({
    where: { lastRunStatus: 'RUNNING' },
    data: { lastRunStatus: 'FAILED' },
  })
  if (result.count > 0) {
    getLogger().warn({ count: result.count }, '启动对账：把上个进程遗留的 RUNNING 定时任务标为 FAILED')
  }
  return result.count
}

/** 启动调度器（幂等）；返回是否真的启动了。定时器 `unref()` —— 它不该成为进程退不掉的原因 */
export function startScheduledTaskScheduler(): boolean {
  if (timer !== undefined) return false
  // 先对账（清掉上个进程遗留的 RUNNING），再开始调度
  void reconcileScheduledRunsOnBoot().catch((error: unknown) => {
    getLogger().warn({ err: error }, '定时任务启动对账失败（不影响调度）')
  })
  const intervalMs = config.scheduledTask.tickSec * 1000
  timer = setInterval(() => {
    void runScheduledTaskTick().catch((error: unknown) => {
      getLogger().warn({ err: error }, '定时任务调度 tick 失败（下一轮重试）')
    })
  }, intervalMs)
  timer.unref()
  // 启动即跑一轮：上一个进程可能停在某个到期时刻上，等 30s 才开始没有必要
  void runScheduledTaskTick().catch((error: unknown) => {
    getLogger().warn({ err: error }, '定时任务调度首轮 tick 失败')
  })
  getLogger().info({ tickSec: config.scheduledTask.tickSec }, '定时任务调度器已启动')
  return true
}

/** 停止调度器（幂等；在飞的那几轮不打断 —— 它们跑完自己收尾）。返回是否真的停了 */
export async function stopScheduledTaskScheduler(): Promise<boolean> {
  if (timer === undefined) return false
  clearInterval(timer)
  timer = undefined
  return true
}

/** 运行态快照（启动日志 / `/health` 之类的诊断消费） */
export function getScheduledTaskStats(): ScheduledTaskStats {
  return {
    running: timer !== undefined,
    tickSec: config.scheduledTask.tickSec,
    inFlight: inFlight.size,
    ...(lastDueCount === undefined ? {} : { lastDueCount }),
    ...(lastTickAt === undefined ? {} : { lastTickAt }),
    ...(lastFailedCount === undefined ? {} : { lastFailedCount }),
  }
}
