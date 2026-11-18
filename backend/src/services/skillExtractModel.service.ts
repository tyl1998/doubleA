/**
 * 从会话抽取 Skill 的模型配置服务（平台级单例；P1-24c-2）
 *
 * 依据：契约 `shared/src/skillExtractModel.ts`、落点 `skill_extract_model_config`（**单例行**），
 *      口径出自 `docs/子方案/会话生成Skill.md` §4.3 / §六。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与 `titleModel.service.ts` 的一处**关键差别**（别照抄它）
 * ─────────────────────────────────────────────────────────────────────
 * 标题模型不可用 ⇒ 返回 `null` 让调用方"回落确定性截断"（无害兜底）；
 * 抽取模型不可用 ⇒ 也返回 `null`，但**调用方必须据此抛 502**（`EXTRACT_MODEL_UNAVAILABLE`）。
 * 理由：抽出来的东西会变成用户 Skill 的正文，**用错模型 / 没模型还硬抽**比报错糟得多。
 * 于是本文件只回答"有没有能用的目标"，不做任何降级判断。
 *
 * 解析顺序（§4.3 的原文 + 2026-11-17 用户修订）：
 *   ① 配置关            ⇒ `null`
 *   ② 配了抽取模型       ⇒ 用它（不可用 ⇒ `null`，**不**再退到标题模型：显式配置优先且必须成立）
 *   ③ 没配抽取模型       ⇒ 优先用**本会话当前模型**（工具调用 = 本轮实际模型；直连 API = 智能体默认模型）；
 *                          拿不到再回落标题模型（标题模型自己不可用 ⇒ `null`）
 *
 * 为什么 ③ 不再直接回落标题模型：标题模型只是为"起个名字"挑的（常见是便宜的免费模型），
 * 而抽取要输出严格 JSON；用户正在用的会话模型至少已经证明能用（2026-11-17 用户反馈）。
 */

import {
  appMsg,
  AppError,
  SKILL_EXTRACT_MODEL_MUST_BE_CHAT_HINT,
  type SkillExtractModelConfig,
  type UpdateSkillExtractModelBody,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { resolveChatTarget } from './model.service.js'
import { getTitleModelConfig } from './titleModel.service.js'
import type { LlmTarget } from '../llm/client.js'

/** 单例行的固定主键（与迁移里的 seed 一致） */
const EXTRACT_MODEL_CONFIG_ID = 'default'

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

function toConfig(row: ConfigRow, fallbackToTitleModel: boolean): SkillExtractModelConfig {
  return {
    enabled: row.enabled,
    modelId: row.modelId,
    modelLabel: row.model?.label ?? null,
    fallbackToTitleModel: row.enabled && row.modelId === null && fallbackToTitleModel,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 读当前配置（单例，缺失则懒建 —— 正常由迁移 seed 出来；读路径**不写库**，同 titleModel） */
export async function getSkillExtractModelConfig(): Promise<SkillExtractModelConfig> {
  const prisma = getPrisma()
  const existing = await prisma.skillExtractModelConfig.findUnique({
    where: { id: EXTRACT_MODEL_CONFIG_ID },
    select: CONFIG_SELECT,
  })
  let row: ConfigRow
  if (existing !== null) {
    row = existing
  } else {
    row = await prisma.skillExtractModelConfig
      .create({ data: { id: EXTRACT_MODEL_CONFIG_ID }, select: CONFIG_SELECT })
      .catch(async (error: unknown) => {
        const raced = await prisma.skillExtractModelConfig.findUnique({
          where: { id: EXTRACT_MODEL_CONFIG_ID },
          select: CONFIG_SELECT,
        })
        if (raced === null) throw error
        return raced
      })
  }
  // `fallbackToTitleModel` 只用于界面提示，读失败不该让配置页 500
  const title = await getTitleModelConfig().catch(() => null)
  const titleUsable = title !== null && title.enabled && title.modelId !== null
  return toConfig(row, titleUsable)
}

/** 整体替换配置（`PUT /api/admin/skill-extract-model`）：总开关 + 选定模型一起交 */
export async function setSkillExtractModelConfig(input: UpdateSkillExtractModelBody): Promise<SkillExtractModelConfig> {
  const modelId = await assertExtractModel(input.modelId ?? null)
  await getPrisma().skillExtractModelConfig.upsert({
    where: { id: EXTRACT_MODEL_CONFIG_ID },
    create: { id: EXTRACT_MODEL_CONFIG_ID, enabled: input.enabled, modelId },
    update: { enabled: input.enabled, modelId },
  })
  getLogger().info({ enabled: input.enabled, modelId }, 'Skill 抽取模型配置已更新')
  return getSkillExtractModelConfig()
}

/**
 * 把"这次抽取该用哪个模型"解析成可调用的目标；拿不到 ⇒ `null`（**调用方据此抛 502**，见文件头）。
 *
 * 顺序见文件头 ①②③；每一步的"不可用"都只 warn（留下"配了却没生效"的线索），不在这里抛。
 */
export async function resolveSkillExtractTarget(
  /** ③ 的"会话当前模型"（调用方按上下文提供；不提供 = 直接走标题模型） */
  resolveConversationTarget?: () => Promise<LlmTarget | null>,
): Promise<LlmTarget | null> {
  const config = await getSkillExtractModelConfig()
  if (!config.enabled) {
    getLogger().warn({}, 'Skill 抽取模型未启用，抽取请求将直接失败（不降级）')
    return null
  }
  if (config.modelId !== null) {
    try {
      // 显式配置按平台级动作解析（`subjectUserId=null`，不动某个用户的私人 Key）
      return await resolveChatTarget(config.modelId, null)
    } catch (error) {
      getLogger().warn({ err: error, modelId: config.modelId }, 'Skill 抽取模型不可用（已停用 / 被删 / 未配 Key）')
      return null
    }
  }
  if (resolveConversationTarget !== undefined) {
    const target = await resolveConversationTarget()
    if (target !== null) {
      getLogger().info({ modelId: target.modelId }, '没有配置 Skill 抽取模型，使用本会话当前模型')
      return target
    }
  }
  const modelId = await titleModelIdForFallback()
  if (modelId === null) return null
  try {
    return await resolveChatTarget(modelId, null)
  } catch (error) {
    getLogger().warn({ err: error, modelId }, 'Skill 抽取模型不可用（已停用 / 被删 / 未配 Key）')
    return null
  }
}

/** ③ 的最后回落：标题模型（**只取 id**，可用性交给 `resolveChatTarget` 判） */
async function titleModelIdForFallback(): Promise<string | null> {
  try {
    const title = await getTitleModelConfig()
    if (!title.enabled || title.modelId === null) return null
    return title.modelId
  } catch (error) {
    getLogger().warn({ err: error }, '读取标题模型配置失败（抽取没有可回落的模型）')
    return null
  }
}

/**
 * 校验一个模型 id 可否用于**抽取**（写入路径）：必须是 `type=CHAT` 且模型与 Provider 都启用。
 * 与 `assertTitleModel` 同一条判据（抽取是纯文本任务，不要求 vision，也不要求已配 Key）。
 */
async function assertExtractModel(modelId: string | null): Promise<string | null> {
  if (modelId === null) return null
  const row = await getPrisma().model.findUnique({
    where: { id: modelId },
    select: { id: true, type: true, enabled: true, label: true, provider: { select: { enabled: true } } },
  })
  if (row === null) throw AppError.notFound(appMsg('app.m224'))
  if (row.type !== 'CHAT') {
    throw AppError.validation(SKILL_EXTRACT_MODEL_MUST_BE_CHAT_HINT, {
      fields: [{ path: 'body.modelId', message: SKILL_EXTRACT_MODEL_MUST_BE_CHAT_HINT }],
    })
  }
  if (!row.enabled) throw AppError.conflict(appMsg('app.m225', { p0: row.label }))
  if (!row.provider.enabled) throw AppError.conflict(appMsg('app.m226', { p0: row.label }))
  return row.id
}
