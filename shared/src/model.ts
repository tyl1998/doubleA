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
import { validationMessage } from './i18n/validation.js'
// 取值域定义在 `modelProvider.ts`（`MODEL_TYPES` / `PROVIDER_CREDENTIAL_MODES`）——
// `models.type` 用的就是那个 `enum ModelType`（`schema.prisma`）。刻意**不再 re-export**
// （`index.ts` 用 `export *`，同一个名字从两个模块出来会让"是否算歧义"取决于运行时实现）。
import { MODEL_TYPES, PROVIDER_CREDENTIAL_MODES } from './modelProvider.js'

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
  /**
   * 所属 Provider 的 `baseUrl`（P1-18 追加）。
   *
   * 为什么随模型下发：同名 Provider 靠 id 区分，用户只看名字认不出"这个模型到底打到哪个上游"；
   * 模型表把 Provider 的 `baseUrl` 作为副行显示，一眼就能核对。它是**只读读数**，不参与编删。
   */
  providerBaseUrl: z.string(),
  /** Provider 是否启用。**停用的 Provider 下的模型不会出现在可选列表**，管理页要能看出这一点 */
  providerEnabled: z.boolean(),
  /** 上游真实型号名（会原样放进请求体的 `model` 字段） */
  modelName: z.string(),
  /** 别名：界面上给业务同学看的名字 */
  label: z.string(),
  /**
   * **模型自己的用途**（对话 / 向量化）。
   *
   * ⚠️ 2026-10-22 起它**不再要求**等于所属 Provider 的 `type` —— 同一个 Provider（同一个
   * baseUrl + 同一把 Key）下可以同时挂对话与向量模型。`Provider.type` 只是"新建模型的默认类型"。
   * 见 `docs/子方案/Provider与模型类型解耦.md`。
   */
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
   * 有多少个 Agent 绑了这个模型（**默认模型 ∪ 模型池成员**，同一 Agent 只算一次）。
   * ⚠️ **只算在线（未软删）的 Agent**（`agents.deleted_at` 为空的）—— 删 Agent 会把 `model_id` 置空、
   * 并清掉其池成员行，自动解绑，与删除守卫的口径一致（`02` §4.3）。
   *
   * 口径 = `removeModel` 守卫的引用数（默认模型 `agents.model_id` ∪ 池成员 `agent_models`）。因不变式
   * 「默认模型恒为池成员」（`agent.service.ts` 建/改/复制三处保证），池成员集合已覆盖默认集合，故按
   * `agent_models` 计数即为并集。前端 `modelDeleteBlockedNotice` / `modelTypeChangeBlocked` 据此判断
   * "删除键是否标灰 / 类型是否锁死"，必须与后端守卫**同口径**（否则出现"显示 0 却删不掉"）。
   */
  agentCount: z.number().int().min(0),
  /**
   * 有多少个**知识库**把该模型用作 embedding（`knowledge_bases.embedding_model_id`；对话模型恒为 0）。
   *
   * 编辑一个**被引用**的向量模型（改型号 / 改维度 / 改多模态 / 停用）会让那些库里已有的向量作废
   * ⇒ 它们需要重建索引。模型编辑弹窗据此弹确认并列出库名（P1-5 补）。
   * ⚠️ 2026-10-22 起**也是删除守卫的一部分**：删模型会把 `embedding_model_id` 置空（`onDelete: SetNull`），
   * 静默让那些库无法入库/检索 ⇒ `removeModel` 会 409 拦下。
   */
  knowledgeBaseCount: z.number().int().min(0),
  /**
   * 有多少个**知识库**把该模型用作**图片描述（VLM）**（`knowledge_bases.caption_model_id`，2026-10-22 补）。
   *
   * 与 {@link knowledgeBaseCount} 同款：`onDelete: SetNull` ⇒ 删模型会静默清空这些库的图片描述模型
   * （此后"图片描述"入库会 409）⇒ 也在删除守卫里拦。
   */
  captionKnowledgeBaseCount: z.number().int().min(0),
  /**
   * 该模型是否被平台选为**会话标题生成模型**（`title_model_config.model_id`，单例配置，2026-10-22 补）。
   *
   * 同款 `onDelete: SetNull`：删它会静默把平台标题模型清空（会话标题退回确定性截断）⇒ 也在删除守卫里拦。
   */
  usedAsTitleModel: z.boolean(),
  /**
   * P1-13：模型**随 Provider 归属** —— 以下字段取自其 Provider（Model 本身没有可见性/归属列）。
   * ⚠️ P1-13 修订（2026-10-16）：Provider **不再有可见性** ⇒ 这里没有 `providerVisibility`。
   * `providerOwnerId`/`providerOwnerName` 用于"所属人"列；`canEdit` = 该 Provider 的所属人或 ADMIN。
   */
  providerOwnerId: z.string(),
  providerOwnerName: z.string(),
  /**
   * P1-13：**我能不能改/删这个模型** —— 判据 = 其 Provider 的 `canEditAsset`（所属人或 ADMIN）。
   * ⚠️ 系统级 Provider（owner=ADMIN）下的模型**只有 ADMIN** 能改/删。
   */
  canEdit: z.boolean(),
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
  /** **模型自己的用途**（对话 / 向量化）；与所属 Provider 的 `type`（默认值）无关，见 {@link modelItemSchema} */
  type: z.enum(MODEL_TYPES),
  /** `03` §4.2：下拉要显示上下文长度 */
  maxContext: z.number().int().nullable(),
  /** 向量模型专属：输出维度（对话模型为 `null`） */
  embeddingDim: z.number().int().nullable(),
  /** `03` §4.2：下拉要显示是否支持图片 */
  supportsVision: z.boolean(),
  /** 是否支持"深度思考"（reasoning / thinking）：选模型时也要看得见这个能力 */
  supportsReasoning: z.boolean(),
  /**
   * P1-18：该模型所属 Provider 的**凭据模式**（共享 Key / 各自 Key）。
   *
   * 为什么放这里：智能体表单要能就地下判断——"我选的这个模型，它的 Provider 是不是
   * 要我配自己的 Key，而我还没配"。表单是**按模型**判断的（一次请求即拿到 模型 ↔ 其 Provider
   * 的凭据模式 + 我有没有 Key），不必再单独拉一张凭据表 ⇒ 随模型一起下发最直接、最可靠。
   */
  providerCredentialMode: z.enum(PROVIDER_CREDENTIAL_MODES),
  /**
   * P1-18：**当前调用者**是否已为该 Provider 配置了自己的 Key
   * （仅 `providerCredentialMode=PER_USER` 时有意义）。凭据是个人隐私：**只有布尔**，无明文/掩码。
   */
  providerUserHasKey: z.boolean(),
})
export type ModelOption = z.infer<typeof modelOptionSchema>

/** `GET /api/models/available` 的响应：`{ items }`（不分页，理由见 {@link listAvailableModelsQuerySchema}） */
export const modelOptionListResultSchema = z.object({ items: z.array(modelOptionSchema) })
export type ModelOptionListResult = z.infer<typeof modelOptionListResultSchema>

// ───────────────────────────── 列表（管理） ─────────────────────────────

/** `GET /api/models` 的查询参数（管理面，offset/limit 与其它列表一致） */
export const listModelsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
  /** 可选过滤：只按类型筛 */
  type: z
    .enum(MODEL_TYPES, {
      errorMap: () => ({ message: validationMessage('validation.model.typeAllowed', { allowed: MODEL_TYPES.join('/') }) }),
    })
    .optional(),
  /** 可选过滤：只看某个 Provider 下的模型（管理页按 Provider 分组的入口） */
  providerId: z.string().uuid(validationMessage('validation.model.providerIdNotUuid')).optional(),
  /** 可选过滤：只启用的 / 只停用的。不传 = 全都要（管理页默认看全部） */
  enabled: z
    .enum(['true', 'false'], { errorMap: () => ({ message: validationMessage('validation.model.enabledFlag') }) })
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
        ? {
            message: validationMessage('validation.model.typeRequiredForPicker', {
              allowed: MODEL_TYPES.join('/'),
            }),
          }
        : { message: validationMessage('validation.model.typeAllowed', { allowed: MODEL_TYPES.join('/') }) },
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
  .string({ required_error: validationMessage('validation.model.modelNameRequired') })
  .trim()
  .min(1, validationMessage('validation.model.modelNameRequired'))
  .max(128, validationMessage('validation.model.modelNameTooLong', { max: 128 }))
  .refine((value) => /^\S+$/.test(value), validationMessage('validation.model.modelNameNoWhitespace'))

/** 别名（界面上给业务同学看的名字，可以是中文） */
const labelSchema = z
  .string({ required_error: validationMessage('validation.model.labelRequired') })
  .trim()
  .min(1, validationMessage('validation.model.labelRequired'))
  .max(128, validationMessage('validation.model.labelTooLong', { max: 128 }))

/**
 * 上下文长度（token）。允许 `null`（= 未填写/展示为未知）。
 *
 * 上限取 1000 万：数据库列是 `INTEGER`（上限约 21 亿），但真实模型没有接近千万级的；
 * 给一个宽但明确的上限，能挡掉"把 token 数错填成字节数"这类量级错误。
 */
const maxContextSchema = z
  .number({ invalid_type_error: validationMessage('validation.model.maxContextNotNumber') })
  .int(validationMessage('validation.model.maxContextNotInteger'))
  .min(1, validationMessage('validation.model.maxContextMin', { min: 1 }))
  .max(10_000_000, validationMessage('validation.model.maxContextMax', { max: 10_000_000 }))

// ───────────────────────────── 建 ─────────────────────────────

/** `POST /api/models` 请求体 */
export const createModelBodySchema = z.object({
  providerId: z
    .string({ required_error: validationMessage('validation.model.providerRequired') })
    .uuid(validationMessage('validation.model.providerIdNotUuid')),
  modelName: modelNameSchema,
  label: labelSchema,
  /**
   * **模型自己的用途**（对话 / 向量化）；**不再要求**等于该 Provider 的 `type`。
   *
   * 服务层另有一条与 Provider 相关的约束：`type=EMBEDDING` 时该 Provider 的协议必须是
   * OpenAI 兼容（`embeddingModelAllowedOnProtocol`）—— embedding 只有 `/embeddings` 一条路。
   */
  type: z.enum(MODEL_TYPES, {
    errorMap: () => ({ message: validationMessage('validation.model.typeAllowed', { allowed: MODEL_TYPES.join('/') }) }),
  }),
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
    .number({ invalid_type_error: validationMessage('validation.model.embeddingDimNotNumber') })
    .int(validationMessage('validation.model.embeddingDimNotInteger'))
    .min(1, validationMessage('validation.model.embeddingDimMin', { min: 1 }))
    .max(1_000_000, validationMessage('validation.model.embeddingDimTooLarge', { max: 1_000_000 }))
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
 *   ⚠️ 2026-10-22 起它**不再**要求等于 Provider 的 `type`；改成 `EMBEDDING` 时服务层另判
 *   "该 Provider 的协议是否兼容"（`embeddingModelAllowedOnProtocol`）。
 */
export const updateModelBodySchema = z
  .object({
    providerId: z.string().uuid(validationMessage('validation.model.providerIdNotUuid')).optional(),
    modelName: modelNameSchema.optional(),
    label: labelSchema.optional(),
    type: z
      .enum(MODEL_TYPES, {
        errorMap: () => ({
          message: validationMessage('validation.model.typeAllowed', { allowed: MODEL_TYPES.join('/') }),
        }),
      })
      .optional(),
    /** ⚠️ 必须是 `.nullable().optional()`（**不要**加 `.default()`）：要区分"不动"与"清空" */
    maxContext: maxContextSchema.nullable().optional(),
    /** **向量模型专属**：手动指定/覆盖输出维度（缺省时后端尽力探测；对话模型忽略） */
    embeddingDim: z
      .number({ invalid_type_error: validationMessage('validation.model.embeddingDimNotNumber') })
      .int(validationMessage('validation.model.embeddingDimNotInteger'))
      .min(1, validationMessage('validation.model.embeddingDimMin', { min: 1 }))
      .max(1_000_000, validationMessage('validation.model.embeddingDimTooLarge', { max: 1_000_000 }))
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
    { message: validationMessage('validation.common.atLeastOneField') },
  )
export type UpdateModelBody = z.infer<typeof updateModelBodySchema>

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const modelIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.model.idNotUuid')),
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
  providerId: z
    .string({ required_error: validationMessage('validation.model.providerRequired') })
    .uuid(validationMessage('validation.model.providerIdNotUuid')),
  modelName: z
    .string({ required_error: validationMessage('validation.model.modelNameFillFirst') })
    .trim()
    .min(1, validationMessage('validation.model.modelNameFillFirst'))
    .max(255),
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
  providerId: z
    .string({ required_error: validationMessage('validation.model.providerRequired') })
    .uuid(validationMessage('validation.model.providerIdNotUuid')),
  modelName: z
    .string({ required_error: validationMessage('validation.model.modelNameFillFirst') })
    .trim()
    .min(1, validationMessage('validation.model.modelNameFillFirst'))
    .max(255),
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
