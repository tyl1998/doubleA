/**
 * 用量统计契约（P1-7）
 *
 * 依据：`01` 决策 20 + §3.8 需求 37（用量统计：按用户/Agent 的 token 累计与简单报表，admin）、
 *      `02` §三（`usage_records` 列清单）/§四（`GET /api/usage/summary`）、`03` §4.8（`/admin/usage`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 数据源只有 `usage_records`，且**一行 = 一轮派活/一轮问答**
 * ─────────────────────────────────────────────────────────────────────
 * 表由 **P0-3-12** 上线（当时只有 TaskAgent 写）；**P1-7** 起 ChatBot 也写
 * （接回点 `persist.ts#PersistRoundInput.usageRecord` 早在 P0-3-12 就留好了）。
 * 于是"一行"的语义从"一轮 TaskAgent 派活"**泛化**为"一轮对话"（两个编排器同口径）。
 *
 * ⚠️ 表里**没有费用列** —— 需求 37 的验收要点是"可回答『这个月谁用最多』"，
 * 而"多少钱"取决于各 provider 的计价，平台侧不知道 ⇒ 报表**只统计 token / 时长 / 轮次**，
 * 不编一个费用数字（`01` 决策 20 的原文也只说 token 累计）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② `NULL` ≠ `0`：token 可能压根没上报
 * ─────────────────────────────────────────────────────────────────────
 * `tokens_in` / `tokens_out` 可空（引擎/上游在流式阶段不报 usage 时就是"不知道"，P0-3-12 起
 * 全 0 按"没上报"处理 ⇒ `NULL`）。报表的口径因此是：
 *   · 聚合值 = **已知的** token 之和（`_sum` 会跳过 `NULL`），全组都没上报 ⇒ 该列为 `null`；
 *   · `tokenRecords` = 组内**真的上报了 token** 的条数 ⇒ 让读者能分辨"0"与"不知道"；
 *   · `tokensTotal` = 已知的 `in + out`（两者都 `null` ⇒ `null`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 三个分组维度（`groupBy`）走同一条端点
 * ─────────────────────────────────────────────────────────────────────
 * `user`（默认，回答"谁用最多"）/ `agent` / `model`（上游真实型号名）。前端并排三张表
 * ⇒ 同一次区间筛选发三个请求（`groupBy` 不同），互不阻塞。
 */

import { z } from 'zod'

import type { MessageKey } from './i18n/index.js'

// ───────────────────────────── 分组维度 ─────────────────────────────

/**
 * 分组维度。
 * · `user`  —— 按 `usage_records.user_id`（"这个月谁用最多"）；
 * · `agent` —— 按 `usage_records.agent_id`；
 * · `model` —— 按 `usage_records.model`（**上游真实型号名**，见 `schema.prisma#UsageRecord.model`）。
 */
export const USAGE_GROUP_BY = ['user', 'agent', 'model'] as const
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number]

/** 维度 → 中文名（表头 / 帮助文案共用一份，别在两处各写一遍） */
export const USAGE_GROUP_LABELS: Record<UsageGroupBy, string> = {
  user: '按用户',
  agent: '按智能体',
  model: '按模型',
}

/** 维度 → i18n key（P1-23；中文那份 {@link USAGE_GROUP_LABELS} 保留给其它中文消费方） */
export const USAGE_GROUP_KEY: Record<UsageGroupBy, MessageKey> = {
  user: 'label.usageGroup.user',
  agent: 'label.usageGroup.agent',
  model: 'label.usageGroup.model',
}

/** 分组名称列的表头（每个维度的"名字"叫法不同） */
export const USAGE_GROUP_KEY_LABELS: Record<UsageGroupBy, string> = {
  user: '用户',
  agent: '智能体',
  model: '模型',
}

/** 分组名称列的表头 → i18n key（P1-23） */
export const USAGE_GROUP_HEADER_KEY: Record<UsageGroupBy, MessageKey> = {
  user: 'label.usageGroupKey.user',
  agent: 'label.usageGroupKey.agent',
  model: 'label.usageGroupKey.model',
}

// ───────────────────────────── 查询 ─────────────────────────────

/**
 * `GET /api/usage/summary` 的查询参数。
 *
 * `from` / `to` 是 **ISO 8601 字符串**（本地时区、含偏移量），左闭右开 `[from, to)`：
 *   · 都省略 ⇒ 服务端取**本月**（`from` = 当月 1 日 00:00，`to` = 此刻）；
 *   · 只给 `from` ⇒ `to` = 此刻；只给 `to` ⇒ `from` = 当月 1 日。
 * 解析不出（不是合法时间）⇒ **400**（服务层判，不在 schema 里做 —— 与其余查询参数同款）。
 */
export const usageSummaryQuerySchema = z.object({
  groupBy: z.enum(USAGE_GROUP_BY).default('user'),
  from: z.string().optional(),
  to: z.string().optional(),
})
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>

// ───────────────────────────── 结果 ─────────────────────────────

/**
 * 一个分组（用户 / 智能体 / 模型）的累计读数。
 *
 * `key` 是分组的原始值（`userId` / `agentId` / `model` 字符串），`label` 是给界面看的名字。
 * `label` 与 `key` **分开给**：智能体可重名、用户看的是用户名，而"到底是谁"由 `key` 唯一确定。
 */
export const usageSummaryItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** 记录条数（这一组有多少行 `usage_records`） */
  records: z.number().int().min(0),
  /** **已知**的输入 token 之和；全组都没上报 ⇒ `null`（不是 0） */
  tokensIn: z.number().int().min(0).nullable(),
  /** **已知**的输出 token 之和；全组都没上报 ⇒ `null` */
  tokensOut: z.number().int().min(0).nullable(),
  /** 已知的 `in + out`；两者都 `null` ⇒ `null` */
  tokensTotal: z.number().int().min(0).nullable(),
  /** 组内**真的上报了 token** 的条数（覆盖度，见文件头 ②） */
  tokenRecords: z.number().int().min(0),
  /** 累计墙钟耗时（毫秒，我方量） */
  durationMs: z.number().int().min(0),
  /** 累计模型请求轮次（`turn_start` 条数之和） */
  rounds: z.number().int().min(0),
})
export type UsageSummaryItem = z.infer<typeof usageSummaryItemSchema>

/**
 * 报表响应。
 *
 * `from` / `to` 回显**服务端实际采用的区间**（ISO）—— 请求省略时间时前端据此显示
 * "本月（08-01 ~ 08-13）"，而不是自己猜一个。
 */
export const usageSummaryResultSchema = z.object({
  groupBy: z.enum(USAGE_GROUP_BY),
  from: z.string(),
  to: z.string(),
  items: z.array(usageSummaryItemSchema),
})
export type UsageSummaryResult = z.infer<typeof usageSummaryResultSchema>
