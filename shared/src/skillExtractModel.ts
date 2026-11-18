/**
 * 从会话抽取 Skill 的模型契约（平台级单例配置；P1-24c-2）
 *
 * 依据：`docs/子方案/会话生成Skill.md` §4.3（"走平台模型池：默认独立抽取模型配置
 *      （`skill_extract_model`），标题模型只作 fallback"）与 §六（`EXTRACT_MODEL_UNAVAILABLE` 502）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径（与 `titleModel.ts` 的差别都在这里）
 * ─────────────────────────────────────────────────────────────────────
 * ① **失败不静默**：标题模型不可用时回落"原文截断"（那是零成本、语义无损的兜底），
 *    而抽取不可用时**必须报错** —— 用错模型 / 没模型还硬抽，产出的草稿会直接进用户的 Skill。
 *    故这里没有"降级"，只有 `null` ⇒ 调用方抛 502 `EXTRACT_MODEL_UNAVAILABLE`
 *    （唯一的例外是"没配抽取模型 ⇒ 用标题模型"，那是**配置层面的回落**，不是降级）。
 * ② **默认开**：抽取是用户显式点出来的动作，配了模型就该能用；关掉只用于"临时停用抽取"。
 * ③ **单例行**（`id` 固定 `default`）：平台级单一事实，只有 ADMIN 能读能改（与 `/api/admin/title-model` 同族）。
 */

import { z } from 'zod'

import { validationMessage } from './i18n/validation.js'

/** 抽取模型配置（`GET /api/admin/skill-extract-model` 的响应形状） */
export const skillExtractModelConfigSchema = z.object({
  /** 平台总开关 */
  enabled: z.boolean(),
  /** 选定的抽取模型 id（`models.id`）；`null` = 未配置 ⇒ 回落标题模型 */
  modelId: z.string().nullable(),
  /** 选定模型的**当前**展示名（未配 / 已删为 `null`），仅供界面显示 */
  modelLabel: z.string().nullable(),
  /** 是否正在**回落到标题模型**（`modelId === null` 且标题模型可用时为 `true`，界面据此提示） */
  fallbackToTitleModel: z.boolean(),
  /** ISO 8601 */
  updatedAt: z.string(),
})
export type SkillExtractModelConfig = z.infer<typeof skillExtractModelConfigSchema>

/** `PUT /api/admin/skill-extract-model`：总开关 + 选定模型（**整体替换**，三态同 `titleModel`） */
export const updateSkillExtractModelBodySchema = z.object({
  enabled: z.boolean({
    required_error: validationMessage('validation.skillExtractModel.enabledMissing'),
    invalid_type_error: validationMessage('validation.skillExtractModel.enabledNotBoolean'),
  }),
  modelId: z
    .string({ invalid_type_error: validationMessage('validation.skillExtractModel.modelIdNotString') })
    .uuid(validationMessage('validation.skillExtractModel.modelIdNotUuid'))
    .nullable()
    .optional(),
})
export type UpdateSkillExtractModelBody = z.infer<typeof updateSkillExtractModelBodySchema>

/** 写入路径的校验失败提示（模型不是 CHAT / 停用）—— 与标题模型同一份口径 */
export const SKILL_EXTRACT_MODEL_MUST_BE_CHAT_HINT =
  '所选抽取模型必须是对话模型（CHAT），且模型与其所属 Provider 都已启用'
