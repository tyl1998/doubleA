/**
 * 会话标题生成模型服务（平台级单例）
 *
 * 依据：产品优化（2026-09-29 会话标题自动命名）的延伸 —— 用一个廉价模型把首条消息压成短标题；
 *      契约 `shared/src/titleModel.ts`、落点为 `title_model_config`（**单例行**，见 schema.prisma）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本服务只做三件事：读单行、写单行、把选定的模型解析成可用于上游调用的目标
 * ─────────────────────────────────────────────────────────────────────
 *   · **不做实际生成**：生成 prompt / 调上游 / 解析回复在 `orchestrator/titleGenerate.ts`
 *     （那里要落"调用失败一律回落"的分支，本服务只负责"有没有配置 / 配了什么"）。
 *   · **不做权限判定**：路由挂 `requireAdmin`（平台级配置，见 `routes/titleModel.ts`）。
 *   · **写入时校验模型**：与 `kb.service.ts#resolveCaptionModelId` 同款 —— 必须是 `type=CHAT`
 *     且模型与 Provider 都启用。⚠️ **不要求 Provider 已配 Key**（与 caption 一致）：标题是可选增强，
 *     缺 Key 时生成阶段会**降级回落**确定性截断，没有理由因此不让人先配好选型。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 「未配置」不是错误，而是**要回落到确定性截断**的第一类信号
 * ─────────────────────────────────────────────────────────────────────
 * {@link resolveTitleTarget} 在"关 / 没配 / 模型被删 / 模型或 Provider 停用 / 缺 Key"时一律返回
 * `null`（**不抛**），调用方据此直接用 `deriveConversationTopic` 的原文截断 —— 这正是用户要的
 * "调用不通或者没有配置则用当前逻辑"。把这些情形抛给调用方，会让"改了个配置就把会话标题弄崩"
 * 成为一个常态。
 */

import { appMsg, AppError, TITLE_MODEL_MUST_BE_CHAT_HINT, type TitleModelConfig, type UpdateTitleModelBody } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { resolveChatTarget } from './model.service.js'
import type { LlmTarget } from '../llm/client.js'

/** 单例行的固定主键（与迁移里的 seed 一致） */
const TITLE_MODEL_CONFIG_ID = 'default'

/** 投影用的列（不 select 多余列）；`model.label` 是展示名快照（模型可能已删 ⇒ `null`） */
const CONFIG_SELECT = {
  enabled: true,
  modelId: true,
  updatedAt: true,
  model: { select: { label: true } },
} as const

interface ConfigRow {
  enabled: boolean
  modelId: string | null
  updatedAt: Date
  model: { label: string } | null
}

function toConfig(row: ConfigRow): TitleModelConfig {
  return {
    enabled: row.enabled,
    modelId: row.modelId,
    // 模型被删（`onDelete: SetNull`）后 `modelId` 已为 `null`；这里 `?.` 只为兜"读了脏行"的极罕见情形
    modelLabel: row.model?.label ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 读当前配置（单例，缺失则懒建 —— 正常由迁移 seed 出来，这里只兜"迁移没跑到"的罕见情形）。
 *
 * ⚠️ 读路径**不写库**（同 `egressPolicy.service.ts#getEgressPolicy` 纪律）：`@updatedAt` 会在
 * 任何 update 上推进，若每次读都 upsert，`updated_at` 会被读操作持续刷新。
 */
export async function getTitleModelConfig(): Promise<TitleModelConfig> {
  const prisma = getPrisma()
  const existing = await prisma.titleModelConfig.findUnique({
    where: { id: TITLE_MODEL_CONFIG_ID },
    select: CONFIG_SELECT,
  })
  if (existing !== null) return toConfig(existing)
  const created = await prisma.titleModelConfig
    .create({ data: { id: TITLE_MODEL_CONFIG_ID }, select: CONFIG_SELECT })
    .catch(async (error: unknown) => {
      // 并发首次创建：唯一键冲突 ⇒ 回读（"两处同时建"不是错误）
      const raced = await prisma.titleModelConfig.findUnique({
        where: { id: TITLE_MODEL_CONFIG_ID },
        select: CONFIG_SELECT,
      })
      if (raced === null) throw error
      return raced
    })
  return toConfig(created)
}

/**
 * 整体替换配置（`PUT /api/admin/title-model`）：**总开关 + 选定模型一起交**。
 *
 * `modelId` 三态（见 `shared` 的 schema）：`null` / 省略 = 清除（未配置）；uuid = 设置。
 * 设置时先过 {@link assertTitleModel}（校验是 CHAT + 都启用）。
 */
export async function setTitleModelConfig(input: UpdateTitleModelBody): Promise<TitleModelConfig> {
  const modelId = await assertTitleModel(input.modelId ?? null)
  const row = await getPrisma().titleModelConfig.upsert({
    where: { id: TITLE_MODEL_CONFIG_ID },
    create: { id: TITLE_MODEL_CONFIG_ID, enabled: input.enabled, modelId },
    update: { enabled: input.enabled, modelId },
    select: CONFIG_SELECT,
  })
  getLogger().info(
    { enabled: input.enabled, modelId, modelLabel: row.model?.label ?? null },
    '会话标题模型配置已更新',
  )
  return toConfig(row)
}

/**
 * 把选定的模型解析成**可用于上游调用的**目标；任一环节不成立 ⇒ 返回 `null`（**不抛**，见文件头）。
 *
 * 判据（顺序即短路顺序）：
 *   ① 配置关          ⇒ `null`；
 *   ② 未配模型        ⇒ `null`；
 *   ③ `resolveChatTarget` 抛（模型被删 / 停用 / Provider 停用 / 缺 Key）⇒ 捕获后 `null`。
 *
 * ⚠️ ③ **捕获而非上抛**：这正是"调用不通则回落确定性截断"的落点。记一条 warn 留下线索
 *    （"配了却一直没生效"是运维最该看到的一种静默失效），但绝不因为配置坏了而让整轮会话失败。
 */
export async function resolveTitleTarget(): Promise<LlmTarget | null> {
  const config = await getTitleModelConfig()
  if (!config.enabled || config.modelId === null) return null
  try {
    // `subjectUserId` 传 `null`：标题生成是**平台级**动作，不属于某个用户；若所选 Provider 是
    // "各自 Key"模式，`resolveChatTarget(null)` 会抛 `NEED_CREDENTIAL` ⇒ 落到下面的 `null` 回落
    // （平台级生成本就不该用某个用户的私人 Key）。
    return await resolveChatTarget(config.modelId, null)
  } catch (error) {
    getLogger().warn(
      { err: error, modelId: config.modelId },
      '标题模型不可用（已停用 / 被删 / 未配 Key），本轮标题回落确定性截断',
    )
    return null
  }
}

/**
 * 校验一个模型 id 可否用于**标题生成**（写入路径）。
 *
 * 与 `kb.service.ts#resolveCaptionModelId` 同族，但**不要求** `supportsVision`（标题是纯文本任务），
 * 且**不要求 Provider 已配 Key**（见文件头）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 模型不存在 / `VALIDATION`(400) 非对话模型
 *   / `CONFLICT`(409) 模型或 Provider 停用
 */
async function assertTitleModel(modelId: string | null): Promise<string | null> {
  if (modelId === null) return null
  const row = await getPrisma().model.findUnique({
    where: { id: modelId },
    select: { id: true, type: true, enabled: true, label: true, provider: { select: { enabled: true } } },
  })
  if (row === null) throw AppError.notFound(appMsg('app.m224'))
  if (row.type !== 'CHAT') {
    throw AppError.validation(TITLE_MODEL_MUST_BE_CHAT_HINT, {
      fields: [{ path: 'body.modelId', message: TITLE_MODEL_MUST_BE_CHAT_HINT }],
    })
  }
  if (!row.enabled) throw AppError.conflict(appMsg('app.m225', { p0: row.label }))
  if (!row.provider.enabled) {
    throw AppError.conflict(appMsg('app.m226', { p0: row.label }))
  }
  return row.id
}