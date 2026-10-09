/**
 * 模型池 · 模型契约（P0-1-11；管理面 `(A)` 仅 ADMIN，可选列表全员可读）
 *
 * 依据：`docs/02-后端设计.md` §4.3（`/api/models[…/:id]` 模型管理 + `GET /api/models?type=CHAT`
 *      全员可选模型列表）+ §三（`models` 表）+ `01` §3.2「无效模型创建 Agent 时不可选」
 *      + `03` §4.2 第 2 条（智能体编辑页的模型下拉：显示上下文长度 / 是否支持图片）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件最要紧的一件事：**同前缀下两套投影，路径必须分开**
 * ─────────────────────────────────────────────────────────────────────
 *
 * `02` §4.3 把两个用途写在了同一条 `GET /api/models` 上（管理列表 / 全员可选列表），
 * `06` 的坑预判也点了这个雷（"用方法+查询参数分流"）。实际做下来，**按角色决定返回哪套投影
 * 是错的**，理由很硬：
 *
 *   智能体编辑页（`03` §4.2）用同一个列表渲染模型下拉。ADMIN 也要建智能体 ——
 *   如果「是不是 ADMIN」决定投影，那么 **ADMIN 在模型下拉里会看到 `enabled=false` 的模型**，
 *   而 `01` §3.2 的验收要点明确要求「无效模型创建 Agent 时不可选」。同一份代码，
 *   换个身份就违反自己家的验收门槛。
 *
 * 所以拆成两条路径，**用途**决定投影，与身份无关：
 *
 * | 端点 | 权限 | 投影 | 给谁用 |
 * |------|------|------|--------|
 * | `GET /api/models` | ADMIN | {@link ModelItem} | `/admin/models` 管理页：要看得见停用项、要分页 |
 * | `GET /api/models/available?type=` | 登录即可 | {@link ModelOption} | 建/改智能体的模型下拉：只要"能选的" |
 *
 * 路径这么摆还有个好处：与 `/api/model-providers`、`/api/users` 一致 ——
 * **资源根的 `(A)` CRUD 在根路径**，"视图型"的子集走子路径。
 * （`03` §116 原写作 `GET /api/models?type=CHAT`，P0-1-11 已同步改成
 * `GET /api/models/available?type=CHAT`。）
 *
 * `available` 的 `type` **必填**而不是可选：它的唯一用途就是填一个"选模型"的下拉，
 * 而对话与向量是两种不能互换的东西 —— 让 `type` 有默认值，等于允许"忘了传"的调用方
 * 把 CHAT 模型塞进向量库（不会报错，只会静默产生垃圾向量）。必填 + 400 更安全。
 */

import { z } from 'zod'

import { offsetPageOf } from './envelope.js'
// 取值域复用 Provider 那一份：`models.type` 与 `model_providers.type` 是同一个数据库枚举
// （`schema.prisma` 的 `enum ModelType`），拆两份迟早会出现"这里加了、那里忘了"。
// 刻意**不再 re-export**（`MODEL_TYPES` 已由 `modelProvider.ts` 出口）：`index.ts` 用
// `export *`，同一个名字从两个模块出来会让"是否算歧义"取决于运行时实现，没必要冒这个险。
import { MODEL_TYPES } from './modelProvider.js'

// ───────────────────────────── 输出形态（两套投影） ─────────────────────────────

/**
 * **管理投影**（`GET /api/models`，仅 ADMIN）。
 *
 * 与 {@link ModelOption} 的差别不是"多几个字段"，而是**受众不同**：
 * 这里给的是配置管理员——他需要 `enabled`（停用的模型也要能看见才能改回来）、
 * `agentCount`（"为什么删不掉"的依据）、`providerEnabled`（"配了却不生效"的常见原因）。
 */
export const modelItemSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  /** 上游 Provider 名。列表里直接显示，避免管理员再点一次 Provider 才认得出是谁 */
  providerName: z.string(),
  /** Provider 是否启用。**停用的 Provider 下的模型不会出现在可选列表**，管理页要能看出这一点 */
  providerEnabled: z.boolean(),
  /** 上游真实型号名（会原样放进请求体的 `model` 字段） */
  modelName: z.string(),
  /** 别名：界面上给业务同学看的名字 */
  label: z.string(),
  type: z.enum(MODEL_TYPES),
  /** 上下文长度（token）；未填为 `null`。**对话模型专属**（向量模型为 `null`） */
  maxContext: z.number().int().nullable(),
  /** **向量模型专属**：embedding 输出维度；对话模型为 `null` */
  embeddingDim: z.number().int().nullable(),
  /** **向量模型专属**：是否走多模态 embedding 端点；对话模型恒 `false` */
  embeddingMultimodal: z.boolean(),
  supportsVision: z.boolean(),
  /** 是否支持"深度思考"（reasoning / thinking）。见 `createModelBodySchema` 的字段注释 */
  supportsReasoning: z.boolean(),
  enabled: z.boolean(),
  /**
   * 有多少个 Agent 绑了这个模型。
   * ⚠️ **含软删的 Agent**（`agents.deleted_at` 非空的也算）—— 删模型时外键是 `RESTRICT`，
   * 软删的 Agent 照样占着引用；这个数字要和删除守卫的口径一致，否则会出现
   * "显示 0 个却能删不掉"（`02` §三 删除语义、P0-1-10 同款结论）。
   */
  agentCount: z.number().int().min(0),
  /**
   * 有多少个**知识库**把该模型用作 embedding（`knowledge_bases.embedding_model_id`；对话模型恒为 0）。
   *
   * 编辑一个**被引用**的向量模型（改型号 / 改维度 / 改多模态 / 停用）会让那些库里已有的向量作废
   * ⇒ 它们需要重建索引。模型编辑弹窗据此弹确认并列出库名（P1-5 补）。
   * 与 `agentCount` 不同，它**不**是删除守卫：删模型会把 `embedding_model_id` 置空（`onDelete: SetNull`）。
   */
  knowledgeBaseCount: z.number().int().min(0),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ModelItem = z.infer<typeof modelItemSchema>

/**
 * **可选投影**（`GET /api/models/available`，登录即可）。
 *
 * 刻意**不含** `enabled`：这份列表按定义只含"能选的"，再下发一个恒为 true 的字段，
 * 只会诱使前端写 `if (option.enabled)` 这种永远为真的分支。
 * 也刻意不含 `agentCount`（管理口径）与 `createdAt/updatedAt`（管理口径）。
 */
export const modelOptionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  modelName: z.string(),
  label: z.string(),
  type: z.enum(MODEL_TYPES),
  /** `03` §4.2：下拉要显示上下文长度 */
  maxContext: z.number().int().nullable(),
  /** 向量模型专属：输出维度（对话模型为 `null`） */
  embeddingDim: z.number().int().nullable(),
  /** `03` §4.2：下拉要显示是否支持图片 */
  supportsVision: z.boolean(),
  /** 是否支持"深度思考"（reasoning / thinking）：选模型时也要看得见这个能力 */
  supportsReasoning: z.boolean(),
})
export type ModelOption = z.infer<typeof modelOptionSchema>

/** `GET /api/models/available` 的响应：`{ items }`（不分页，理由见 {@link listAvailableModelsQuerySchema}） */
export const modelOptionListResultSchema = z.object({ items: z.array(modelOptionSchema) })
export type ModelOptionListResult = z.infer<typeof modelOptionListResultSchema>

// ───────────────────────────── 列表（管理） ─────────────────────────────

/** `GET /api/models` 的查询参数（管理面，offset/limit 与其它列表一致） */
export const listModelsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
  /** 可选过滤：只按类型筛 */
  type: z
    .enum(MODEL_TYPES, { errorMap: () => ({ message: `type 只能是 ${MODEL_TYPES.join('/')}` }) })
    .optional(),
  /** 可选过滤：只看某个 Provider 下的模型（管理页按 Provider 分组的入口） */
  providerId: z.string().uuid('providerId 不是合法 UUID').optional(),
  /** 可选过滤：只启用的 / 只停用的。不传 = 全都要（管理页默认看全部） */
  enabled: z
    .enum(['true', 'false'], { errorMap: () => ({ message: 'enabled 只能是 true 或 false' }) })
    .transform((value) => value === 'true')
    .optional(),
})
export type ListModelsQuery = z.infer<typeof listModelsQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const modelListResultSchema = offsetPageOf(modelItemSchema)
export type ModelListResult = z.infer<typeof modelListResultSchema>

// ───────────────────────────── 可选列表（全员） ─────────────────────────────

/**
 * `GET /api/models/available` 的查询参数。
 *
 * **`type` 必填**，理由见文件头（防"忘了传"把 CHAT 模型塞进向量库）。
 * **不分页**：模型池由管理员人工维护，量级是"几十"，加一层分页只会让前端多写循环。
 * 若将来出现批量导入把量级推到几百，应当先补分页再放量 —— 而不是在这里悄悄 `take` 一个上限
 * （静默截断会让"某几个模型从下拉里消失"变成一条没人能查的幽灵 bug）。
 */
export const listAvailableModelsQuerySchema = z.object({
  /**
   * ⚠️ 这里**只能**用 `errorMap`，不能再叠一个 `required_error`：zod v3 明确禁止
   * "`required_error` 与自定义 error map 同时给"，而且它是**在模块加载期** `throw` 的
   * （不是校验期）—— 表现是整个进程 import 就死，`typecheck` 完全查不出来。
   * 故"必填"这条文案改由 `errorMap` 里分派 `invalid_type` 产出。
   */
  type: z.enum(MODEL_TYPES, {
    errorMap: (issue) =>
      issue.code === 'invalid_type'
        ? { message: `type 必填（${MODEL_TYPES.join('/')}）：这个端点只用来填"选模型"的下拉` }
        : { message: `type 只能是 ${MODEL_TYPES.join('/')}` },
  }),
})
export type ListAvailableModelsQuery = z.infer<typeof listAvailableModelsQuerySchema>

// ───────────────────────────── 公共字段 ─────────────────────────────

/**
 * 上游型号名：`@db.VarChar(128)`。
 *
 * 只把"内部空白"拒掉，理由是**失败要发生在配置时**：上游的 model id 从不含空格
 * （`gpt-4o-mini` / `text-embedding-3-small` / `us.anthropic.claude-…` / `bge-m3` / `qwen2.5:7b`），
 * 从文档里粘过来最常见的脏数据是**尾随空格或换行**（会被 `trim` 吃掉）；
 * 而"中间真的夹了空格"这种输入放行下去，只会在第一次调用上游时变成一个 404/400，
 * 排查成本远高于现在就告诉管理员"这个型号名不对"。
 */
const modelNameSchema = z
  .string({ required_error: '请输入型号名' })
  .trim()
  .min(1, '请输入型号名')
  .max(128, '型号名最多 128 个字符')
  .refine((value) => /^\S+$/.test(value), '型号名不能含空格（填写上游的 model id，如 gpt-4o-mini）')

/** 别名（界面上给业务同学看的名字，可以是中文） */
const labelSchema = z
  .string({ required_error: '请输入别名' })
  .trim()
  .min(1, '请输入别名')
  .max(128, '别名最多 128 个字符')

/**
 * 上下文长度（token）。允许 `null`（= 未填写/展示为未知）。
 *
 * 上限取 1000 万：数据库列是 `INTEGER`（上限约 21 亿），但真实模型没有接近千万级的；
 * 给一个宽但明确的上限，能挡掉"把 token 数错填成字节数"这类量级错误。
 */
const maxContextSchema = z
  .number({ invalid_type_error: 'maxContext 必须是数字' })
  .int('maxContext 必须是整数')
  .min(1, 'maxContext 至少为 1')
  .max(10_000_000, 'maxContext 最多 10000000')

// ───────────────────────────── 建 ─────────────────────────────

/** `POST /api/models` 请求体 */
export const createModelBodySchema = z.object({
  providerId: z.string({ required_error: '请选择 Provider' }).uuid('providerId 不是合法 UUID'),
  modelName: modelNameSchema,
  label: labelSchema,
  type: z.enum(MODEL_TYPES, { errorMap: () => ({ message: `type 只能是 ${MODEL_TYPES.join('/')}` }) }),
  /** 可缺省：`null` 与缺省同义（未填写） */
  maxContext: maxContextSchema.nullish(),
  /**
   * **向量模型专属**：embedding 输出维度。
   *
   * 可缺省 —— 后端会**尽力**向上游探测一次；探测不到（多模态/特殊实现、或端点暂时不可用）
   * 就留空，**不会因此拒绝创建**，由管理员在编辑里手动填写维度。
   * 对话模型忽略该字段。
   */
  embeddingDim: z
    .number({ invalid_type_error: 'embeddingDim 必须是数字' })
    .int('embeddingDim 必须是整数')
    .min(1, 'embeddingDim 至少为 1')
    .max(1_000_000, 'embeddingDim 过大')
    .optional(),
  /**
   * **向量模型专属**：是否走**多模态 embedding 端点**（`POST {baseUrl}/embeddings/multimodal`，
   * `input` 为 `[{type:"text",text}]`）。默认 `false` = 标准 OpenAI 形状。对话模型忽略。
   */
  embeddingMultimodal: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  /**
   * 是否支持"深度思考"（reasoning / thinking）。可缺省（缺省 = `false`）。
   *
   * 它**不只是读数**：对话链路会据此决定是否向上游请求思考 —— 各协议的落点不同
   * （OpenAI 兼容 `reasoning_effort`、Responses `reasoning.effort`、Anthropic `thinking`），
   * 见 `backend/src/llm/protocol.ts` 各 `buildBody`。关掉它 = 不向上游发任何思考参数
   * （回到默认行为：上游若自发思考，`reasoning_content` 仍会被解析显示）。
   */
  supportsReasoning: z.boolean().optional(),
  enabled: z.boolean().optional(),
})
export type CreateModelBody = z.infer<typeof createModelBodySchema>

// ───────────────────────────── 改 ─────────────────────────────

/**
 * `PATCH /api/models/:id` 请求体：**至少给一个字段**。
 *
 * 两处"三态"与三处"不可改"，都写在这里而不是留给服务层猜：
 *
 * · `maxContext` 三态（同 `model-providers` 的 `apiKey`）：**不带 = 不动**；`null` = **清空**；
 *   数字 = 设置。若用 `.optional().default(null)` 把二者合并，"改个别名"会顺手把上下文长度抹掉。
 *
 * · `providerId` 可传但**改不了**（值不同 → 409）。放进来是为了**把静默 no-op 变成显式报错**：
 *   字段压根不在 schema 里时，zod 会把多余键剥掉，调用方以为自己迁移成功了，实际什么都没发生。
 *   传同值放行（幂等，前端整表单提交时不会因为"没改"而失败）。
 *
 * · `type` 可改，但**被 Agent 引用时不允许**（服务层 409）—— 那等于让已绑定的智能体
 *   悄悄换到另一类模型上（对话模型 ↔ 向量模型不可互换）。
 */
export const updateModelBodySchema = z
  .object({
    providerId: z.string().uuid('providerId 不是合法 UUID').optional(),
    modelName: modelNameSchema.optional(),
    label: labelSchema.optional(),
    type: z
      .enum(MODEL_TYPES, { errorMap: () => ({ message: `type 只能是 ${MODEL_TYPES.join('/')}` }) })
      .optional(),
    /** ⚠️ 必须是 `.nullable().optional()`（**不要**加 `.default()`）：要区分"不动"与"清空" */
    maxContext: maxContextSchema.nullable().optional(),
    /** **向量模型专属**：手动指定/覆盖输出维度（缺省时后端尽力探测；对话模型忽略） */
    embeddingDim: z
      .number({ invalid_type_error: 'embeddingDim 必须是数字' })
      .int('embeddingDim 必须是整数')
      .min(1, 'embeddingDim 至少为 1')
      .max(1_000_000, 'embeddingDim 过大')
      .optional(),
    /** **向量模型专属**：是否走多模态 embedding 端点（见 `createModelBodySchema` 同名字段） */
    embeddingMultimodal: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.providerId !== undefined ||
      body.modelName !== undefined ||
      body.label !== undefined ||
      body.type !== undefined ||
      // `maxContext: null`（清空）也算"给了字段"：`null !== undefined`，正是想要的效果
      body.maxContext !== undefined ||
      body.embeddingDim !== undefined ||
      body.embeddingMultimodal !== undefined ||
      body.supportsVision !== undefined ||
      body.supportsReasoning !== undefined ||
      body.enabled !== undefined,
    { message: '至少要提供一个要修改的字段' },
  )
export type UpdateModelBody = z.infer<typeof updateModelBodySchema>

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const modelIdParamsSchema = z.object({
  id: z.string().uuid('模型 ID 不是合法 UUID'),
})
export type ModelIdParams = z.infer<typeof modelIdParamsSchema>

// ───────────────────────────── 探测向量模型维度（P0-1-37 增补）─────────────────────────────

/**
 * `POST /api/models/probe-embedding` 请求体（仅 ADMIN）。
 *
 * 用**当前表单值**向该 Provider 试发一次 embedding，用来在建/改**向量模型**时**当场**看到
 * 维度或真实报错（不必翻后端日志、也不必先保存）。**不落库**、不改任何状态。
 */
export const probeEmbeddingBodySchema = z.object({
  providerId: z.string({ required_error: '请选择 Provider' }).uuid('providerId 不是合法 UUID'),
  modelName: z.string({ required_error: '请先填写型号名' }).trim().min(1, '请先填写型号名').max(255),
  /** 是否走多模态端点（见 `createModelBodySchema.embeddingMultimodal`） */
  embeddingMultimodal: z.boolean().optional(),
})
export type ProbeEmbeddingBody = z.infer<typeof probeEmbeddingBodySchema>

/** 探测成功的结果（失败一律是 `UPSTREAM_ERROR`，消息里带上游原文与请求 URL） */
export const probeEmbeddingResultSchema = z.object({
  dim: z.number().int(),
  providerName: z.string(),
  modelName: z.string(),
  /** 实际请求的完整 URL（不含凭据）—— 排查"路径对不对"用 */
  url: z.string(),
})
export type ProbeEmbeddingResult = z.infer<typeof probeEmbeddingResultSchema>

// ───────────────────────────── 对话模型连通测试（P1-1）─────────────────────────────

/**
 * `POST /api/models/probe-chat` 请求体（仅 ADMIN）。
 *
 * 与向量维度探测（`probeEmbeddingBodySchema`）同款：用**当前表单值**向该 Provider 试发一次
 * **极小对话请求**（`max_tokens: 1`），用来在建/改**对话模型**时**当场**验证
 * `baseUrl` / Key / 协议 / 型号名这一整条链路通不通（不必先保存、也不必等到第一次发消息才以 404 暴露）。
 * **不落库**、不改任何状态。
 */
export const probeChatBodySchema = z.object({
  providerId: z.string({ required_error: '请选择 Provider' }).uuid('providerId 不是合法 UUID'),
  modelName: z.string({ required_error: '请先填写型号名' }).trim().min(1, '请先填写型号名').max(255),
})
export type ProbeChatBody = z.infer<typeof probeChatBodySchema>

/** 连通测试成功的结果（失败一律是 `UPSTREAM_ERROR`/`UPSTREAM_TIMEOUT`，消息里带上游原文与请求 URL） */
export const probeChatResultSchema = z.object({
  providerName: z.string(),
  modelName: z.string(),
  /** 实际请求的完整 URL（不含凭据）—— 排查"路径/协议对不对"用 */
  url: z.string(),
  /**
   * 上游回的文字（极小请求，可能为空串：思考型模型在 `max_tokens:1` 下可能只产思考）。
   * 它是"确实通到了模型"的**直接证据**，不是给业务用的回答。
   */
  reply: z.string(),
  /** 上游原值结束原因（OpenAI 词表；可能为 `null`） */
  finishReason: z.string().nullable(),
  /** 本次上游调用耗时（毫秒） */
  durationMs: z.number().int(),
})
export type ProbeChatResult = z.infer<typeof probeChatResultSchema>
