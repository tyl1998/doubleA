/**
 * 任务中心契约（P1-6，2026-10-09 **需求变更**：定时任务）
 *
 * 依据：`01` 决策 28 + §3.7 需求 38（**重定义**）、`02` §4.8、`03` §4.7。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 「任务」= 一条**定时任务**（新资源），不是会话
 * ─────────────────────────────────────────────────────────────────────
 * 一条定时任务 = 「某个**智能体（ChatBot / TaskAgent）** + 一段**指令** + 一个 **cron 周期**」。到点由后端调度器
 * **新建一个会话**把指令发给该智能体（见 `docs/02` §4.8 的执行口径），消息与产物因而天然
 * 按会话归档 —— 复用既有编排链路（ChatBot 走 RAG、TaskAgent 走沙箱），**不新造执行器**。运行状态记在任务行上。
 *
 * ⚠️ **与"会话视图"无关**：初版 `01` 需求 38 写的是"TaskAgent 会话的任务视图"，用户 2026-10-09
 * 明确"不需要、可删除"，改为本能力 ⇒ 本文件不定义任何"会话投影"字段。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② cron 校验在 `shared`（前后端同一份解析器）
 * ─────────────────────────────────────────────────────────────────────
 * `shared/src/cron.ts#isValidCron` 是唯一判据：前端表单即时校验、后端 body schema 的 `refine`
 * 都调它 —— 两处各写一遍的话，会出现"前端说合法、后端 400"或反过来的稳定错位。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ `enabled` 与 `nextRunAt` 的关系
 * ─────────────────────────────────────────────────────────────────────
 * `nextRunAt` 是**下一次该跑的时刻**（本地时区，JS 侧计算并显式写入，见 `06` §六 的时区纪律）。
 * `enabled=false` 时**不排期**（`nextRunAt=null`）；`enabled=true` 时必有一个未来时刻。
 * 调度器只查 `enabled && nextRunAt <= now`，每跑一次就把 `nextRunAt` 推进到下一次。
 */

import { z } from 'zod'

import { isValidCron } from './cron.js'
import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 取值域与上限 ─────────────────────────────

/** 任务名 / 指令 的长度上限（指令放宽到与 `chatRequestBodySchema` 同量级） */
export const SCHEDULED_TASK_NAME_MAX = 120
export const SCHEDULED_TASK_PROMPT_MAX = 20_000
/** cron 表达式长度上限（5 段，正常几十字符） */
export const SCHEDULED_TASK_CRON_MAX = 120

/**
 * 最近一次运行的状态。
 * · `NEVER`   —— 从未跑过；
 * · `RUNNING` —— 正在跑（调度器置位，跑完改回终态；进程崩溃会残留，下次启动可自愈）；
 * · `SUCCESS`/`FAILED` —— 终态。
 */
export const SCHEDULED_RUN_STATUSES = ['NEVER', 'RUNNING', 'SUCCESS', 'FAILED'] as const
export type ScheduledRunStatus = (typeof SCHEDULED_RUN_STATUSES)[number]

/**
 * 通知渠道类型（`01` 场景 1：定时获取信息后经消息渠道通知我）。
 * · `NONE`    —— 不通知；
 * · `WECOM`   —— 企业微信群机器人 webhook；
 * · `FEISHU`  —— 飞书自定义机器人 webhook（可选签名校验）；
 * · `WEBHOOK` —— 通用 webhook（POST `{ text }`）。
 */
export const NOTIFY_TYPES = ['NONE', 'WECOM', 'FEISHU', 'WEBHOOK'] as const
export type NotifyType = (typeof NOTIFY_TYPES)[number]

/** 通知正文上限（企微 markdown 约 4096 字节；超出即截断，不报错） */
export const NOTIFY_TEXT_MAX = 4000

/** 通知模板长度上限 */
export const NOTIFY_TEMPLATE_MAX = 2000

/**
 * 通知模板可用占位符（任务级；`notify_template`）。**顺序即帮助文案的顺序**。
 * 留空模板 = 用内置默认（各渠道按自身渲染）。
 */
export const NOTIFY_TEMPLATE_PLACEHOLDERS = [
  { key: 'task', label: '任务名' },
  { key: 'time', label: '运行时间' },
  { key: 'status', label: '状态（成功/失败）' },
  { key: 'result', label: '运行结果正文' },
] as const

/**
 * 智能体的「发送通知」内置工具名（`01` 场景 1 的第二种形态）。
 *
 * ⚠️ 它**不是** MCP 工具：与知识库一族同属"平台内置工具"，经后端代跑（ChatBot 在进程内、
 * TaskAgent 经沙箱代理到 `/api/sandbox/builtin/call`）。只在该会话属于一个**配了通知渠道**的
 * 定时任务运行（含"立即执行"）时才下发给模型。
 */
export const SEND_NOTIFICATION_TOOL_NAME = 'send_notification'

// ───────────────────────────── 一行任务 ─────────────────────────────

export const scheduledTaskItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** Agent 名**快照**（Agent 可能已软删；软删后任务停用、不再触发） */
  agentName: z.string(),
  name: z.string(),
  /** 到点发给该智能体的指令正文 */
  prompt: z.string(),
  cronExpr: z.string(),
  enabled: z.boolean(),
  /** 无人值守时对危险工具（MCP 破坏性操作）的处置：`true` = 自动放行、`false` = 拒绝 */
  autoApprove: z.boolean(),
  /** 通知渠道类型（`NONE` = 不通知） */
  notifyType: z.enum(NOTIFY_TYPES),
  /** 是否已配置 webhook 地址（**不回显地址本身** —— 它含密钥，只报"已设置"） */
  notifyUrlSet: z.boolean(),
  /** 是否已配置签名密钥（飞书可选；同样只报"已设置"） */
  notifySecretSet: z.boolean(),
  /** 通知模板（明文；占位符见 {@link NOTIFY_TEMPLATE_PLACEHOLDERS}）。`null` = 用内置默认 */
  notifyTemplate: z.string().nullable(),
  /** 下一次触发时刻（ISO 8601，本地时区）；停用时为 `null` */
  nextRunAt: z.string().nullable(),
  /** 最近一次**开始**运行的时刻；从未跑过为 `null` */
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(SCHEDULED_RUN_STATUSES),
  /** 最近一次运行产生的会话 id（去对话页看过程/产物）；从未跑过为 `null` */
  lastConversationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ScheduledTaskItem = z.infer<typeof scheduledTaskItemSchema>

// ───────────────────────────── 列表 ─────────────────────────────

export const listScheduledTasksQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListScheduledTasksQuery = z.infer<typeof listScheduledTasksQuerySchema>

export const scheduledTaskListResultSchema = offsetPageOf(scheduledTaskItemSchema)
export type ScheduledTaskListResult = z.infer<typeof scheduledTaskListResultSchema>

// ───────────────────────────── 建 / 改 ─────────────────────────────

/** cron 字段的**唯一校验**（前后端共用，见文件头 ②）；错误文案直接给用户看 */
const cronExprSchema = z
  .string({ required_error: '请填写 cron 表达式' })
  .trim()
  .min(1, '请填写 cron 表达式')
  .max(SCHEDULED_TASK_CRON_MAX, `cron 表达式最长 ${SCHEDULED_TASK_CRON_MAX} 个字符`)
  .refine(isValidCron, 'cron 表达式不合法（5 段：分 时 日 月 周）')

export const createScheduledTaskBodySchema = z.object({
  /** 必须是 **TASK_AGENT**（ChatBot 没有沙箱，定时派活无意义）—— 服务端会再校验一次 */
  agentId: z.string({ required_error: '请选择智能体' }).uuid('智能体 ID 不是合法 UUID'),
  name: z
    .string({ required_error: '请填写任务名' })
    .trim()
    .min(1, '请填写任务名')
    .max(SCHEDULED_TASK_NAME_MAX, `任务名最长 ${SCHEDULED_TASK_NAME_MAX} 个字符`),
  prompt: z
    .string({ required_error: '请填写指令' })
    .trim()
    .min(1, '请填写指令')
    .max(SCHEDULED_TASK_PROMPT_MAX, `指令最长 ${SCHEDULED_TASK_PROMPT_MAX} 个字符`),
  cronExpr: cronExprSchema,
  /** 省略 = 建完即启用 */
  enabled: z.boolean().default(true),
  /**
   * 无人值守时对危险工具（MCP 破坏性操作）的处置：`true` = 自动放行、`false` = 拒绝。
   * 省略 = 默认 `true`（定时任务本就要能干活；不想要的用户显式关掉）。
   */
  autoApprove: z.boolean().default(true),
  /** 通知渠道（省略 = 不通知）。非 `NONE` 时必须给 `notifyUrl`（服务层校验） */
  notifyType: z.enum(NOTIFY_TYPES).default('NONE'),
  /** webhook 地址（企微/飞书群机器人的完整 URL，含 key）；非空才会被加密存储 */
  notifyUrl: z.string().trim().max(2048, 'webhook 地址过长').optional(),
  /** 飞书自定义机器人的签名密钥（可选） */
  notifySecret: z.string().trim().max(512, '签名密钥过长').optional(),
  /** 通知模板（可选；留空 = 内置默认）。占位符见 `NOTIFY_TEMPLATE_PLACEHOLDERS` */
  notifyTemplate: z.string().trim().max(NOTIFY_TEMPLATE_MAX, `通知模板最长 ${NOTIFY_TEMPLATE_MAX} 个字符`).optional(),
})
export type CreateScheduledTaskBody = z.infer<typeof createScheduledTaskBodySchema>

/**
 * 改任务：**逐字段可选**（只改传了的）。
 *
 * `enabled` 是**三态之外的两态**（`true`/`false`，不带 = 不改）：`z.boolean().optional()`。
 * ⚠️ `agentId` **不可改**（换 Agent = 换任务意图，删了重建更清楚；也让"这个任务的会话历史"
 * 不至于横跨两个 Agent）。
 */
export const updateScheduledTaskBodySchema = z
  .object({
    name: z.string().trim().min(1, '请填写任务名').max(SCHEDULED_TASK_NAME_MAX).optional(),
    prompt: z.string().trim().min(1, '请填写指令').max(SCHEDULED_TASK_PROMPT_MAX).optional(),
    cronExpr: cronExprSchema.optional(),
    enabled: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
    notifyType: z.enum(NOTIFY_TYPES).optional(),
    /** 传空串 = 清除地址；省略 = 不改 */
    notifyUrl: z.string().trim().max(2048).optional(),
    /** 传空串 = 清除密钥；省略 = 不改 */
    notifySecret: z.string().trim().max(512).optional(),
    /** 传空串 = 清除模板（回落内置默认）；省略 = 不改 */
    notifyTemplate: z.string().trim().max(NOTIFY_TEMPLATE_MAX).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少要改一项')
export type UpdateScheduledTaskBody = z.infer<typeof updateScheduledTaskBodySchema>

/** 「立即执行」的响应：本次运行的会话 id（去对话页看过程/产物） */
export const runScheduledTaskResultSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
})
export type RunScheduledTaskResult = z.infer<typeof runScheduledTaskResultSchema>

/** 路径参数 `:id`（改 / 删 / 立即执行共用） */
export const scheduledTaskIdParamsSchema = z.object({
  id: z.string().uuid('定时任务 ID 不是合法 UUID'),
})
export type ScheduledTaskIdParams = z.infer<typeof scheduledTaskIdParamsSchema>
