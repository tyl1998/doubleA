/**
 * 模型池 · Provider 契约（P0-1-10，`(A)` 仅 ADMIN）
 *
 * 依据：`docs/02-后端设计.md` §4.3（`/api/model-providers` CRUD，Key 写入加密、读脱敏）
 *      + §十 安全设计「凭据/Provider Key：AES-256-GCM，主密钥仅环境变量注入」
 *      + `01` §3.2 需求 1「Provider 管理（维护 baseURL + API Key，加密存储，区分 chat/embedding）」
 *        —— 其验收要点就一句：**Key 不回显明文**。
 *
 * 本文件最要紧的一条：**`apiKey` 有进无出**。
 * 请求体里可以带 `apiKey`（明文，走 HTTPS 到后端后立即加密落库）；
 * 响应体里**永远没有** `apiKey` 这个字段 —— 只有 {@link ModelProviderItem.apiKeyPreview}
 * （`sk-****abcd` 形态的掩码）与 {@link ModelProviderItem.hasKey}（布尔）。
 * `03` 的前端表单据此把"已配置"渲染成掩码 + "重新设置"按钮，而不是回填输入框。
 *
 * 前端页面：`/admin/models`（`03` §二，ADMIN）。
 */

import { z } from 'zod'

import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 取值域 ─────────────────────────────

/**
 * Provider / 模型的两个类型（与 `schema.prisma` 的 `enum ModelType` 逐字一致）。
 *
 * 为什么在这里用 `as const` 数组而不是 TS 枚举：zod 的 `z.enum` 要的是字面量元组，
 * 而且数组能直接 `join('/')` 拼错误文案（见各处 `errorMap`），与 `auth.ts` 的
 * `USER_ROLES` / `USER_STATUSES` 同款写法。
 */
export const MODEL_TYPES = ['CHAT', 'EMBEDDING'] as const
export type ModelType = (typeof MODEL_TYPES)[number]

/** 按类型给出中文名（错误文案/前端下拉共用，避免各处自己拼一份） */
export const MODEL_TYPE_LABELS: Readonly<Record<ModelType, string>> = {
  CHAT: '对话',
  EMBEDDING: '向量',
}

/**
 * 掩码低于这个长度就**只露尾巴**。
 *
 * 口径：`apiKeyPreview` 的作用是"让管理员核对配置的是哪一把 key"（人对末尾 4 位最敏感），
 * 不是让前端把 key 拼回去。所以宁可少露：短 key 连前缀也不给（前缀可能只占 8 个字符的 3 个），
 * 长 key 才给 `前3 + **** + 后4`（真实 key 通常 40~64 字符，露出比例 < 12%）。
 */
const PREVIEW_FULL_MASK_BELOW = 16
/** 短到这个程度连尾巴都不露（4 位尾巴占 8 字符的一半，太划算了） */
const PREVIEW_TAIL_ONLY_BELOW = 8

/**
 * 明文 Key → 可下发的掩码。**纯函数**，前后端共用（前端要按同一规则做本地预览时不必重写）。
 *
 * 返回值不含可还原信息：后缀固定 4 位、中间恒为 `****`，且短 key 退化为 `****`。
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length >= PREVIEW_FULL_MASK_BELOW) {
    return `${apiKey.slice(0, 3)}****${apiKey.slice(-4)}`
  }
  if (apiKey.length >= PREVIEW_TAIL_ONLY_BELOW) {
    return `****${apiKey.slice(-4)}`
  }
  return '****'
}

// ───────────────────────────── 输出形态 ─────────────────────────────

/**
 * Provider 的**统一输出形态**（列表 / 建 / 改三个响应共用）。
 *
 * ⚠️ 刻意**没有** `apiKey` / `apiKeyEnc` / `apiKeyEncrypted` 之类的字段：
 * `02` §十 不变式「Provider Key 只在后端解密，任何响应体不得含明文」。
 * 前端判断"是否已配置 Key"只看 {@link ModelProviderItem.hasKey}。
 */
export const modelProviderItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 已去掉尾部斜杠（拼接 `/chat/completions` 时不会出现 `//`，见 {@link providerBaseUrlSchema}） */
  baseUrl: z.string(),
  type: z.enum(MODEL_TYPES),
  enabled: z.boolean(),
  /** 是否已配置 Key。**只有布尔**，不泄露长度等元信息 */
  hasKey: z.boolean(),
  /**
   * Key 的掩码（如 `sk-****abcd`）；未配置时为 `null`。
   * 由后端**解密后**取首尾生成 —— 也就是说"能看到掩码"本身证明了密文可解（主密钥没换错）。
   */
  apiKeyPreview: z.string().nullable(),
  /** 该 Provider 下挂的模型数（前端删 Provider 前的提示、"这个能不能删"的依据） */
  modelCount: z.number().int().min(0),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ModelProviderItem = z.infer<typeof modelProviderItemSchema>

// ───────────────────────────── 列表 ─────────────────────────────

/** 列表分页参数（`02` §四：除消息外的列表用 offset/limit，默认 20） */
export const listModelProvidersQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListModelProvidersQuery = z.infer<typeof listModelProvidersQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const modelProviderListResultSchema = offsetPageOf(modelProviderItemSchema)
export type ModelProviderListResult = z.infer<typeof modelProviderListResultSchema>

// ───────────────────────────── 建 ─────────────────────────────

/**
 * `baseUrl` 校验 + 归一化：必须是 `http(s)://` 开头的合法 URL，且**去掉尾部斜杠**。
 *
 * 为什么要 `transform` 而不是只校验：这个值将来会被拼成 `${baseUrl}/chat/completions`
 * （P0-1-12 的 LLM client）。管理员从浏览器地址栏复制来的地址十有八九带尾斜杠，
 * 拼出来就是 `https://x/v1//chat/completions` —— 有的网关把双斜杠当 404，排查起来很费时间。
 * 归一化放在契约层，前后端对"存下来的到底是什么"就不会有分歧。
 *
 * 同时拒绝 `file://` / `ftp://` 之类：这个值最终会被后端拿去发 HTTP 请求，
 * 允许任意 scheme 等于把 URL 解析与协议选择交给配置者（SSRF 面变大）。
 */
export const providerBaseUrlSchema = z
  .string({ required_error: '请输入 baseUrl' })
  .trim()
  .min(1, '请输入 baseUrl')
  // 2048 是常见网关/浏览器的 URL 上限量级，超出基本可以断定填错了
  .max(2048, 'baseUrl 最多 2048 个字符')
  .refine((value) => /^https?:\/\//i.test(value), 'baseUrl 必须以 http:// 或 https:// 开头')
  .refine((value) => {
    try {
      // `new URL` 比正则严格得多（能挡掉 `http://`、`https://a b`、`http://x:abc` 等）
      new URL(value)
      return true
    } catch {
      return false
    }
  }, 'baseUrl 不是合法的 URL')
  .transform((value) => value.replace(/\/+$/, ''))

/**
 * 明文 `apiKey`：**不接受空串**。
 *
 * 空串是"我想清空"的常见误用写法，但它在两种语义之间摇摆（是"没配"还是"配了个空值"？）。
 * 契约里只留两条明确的路：**不带这个字段 = 不动**；**传 `null` = 清空**。
 * 传空串会得到 400 + `data.fields`，文案直接告诉调用方该怎么做。
 */
export const providerApiKeySchema = z
  .string({ required_error: 'apiKey 不能为空（要清空请传 null，不动则不传该字段）' })
  .trim()
  .min(1, 'apiKey 不能为空字符串（要清空请传 null，不动则不传该字段）')
  // 512 远超任何厂商的 key 长度（常见 40~200）；超长基本是粘错了东西
  .max(512, 'apiKey 最多 512 个字符')

/** 建 Provider 请求体 */
export const createModelProviderBodySchema = z.object({
  name: z
    .string({ required_error: '请输入名称' })
    .trim()
    .min(1, '请输入名称')
    .max(128, '名称最多 128 个字符'),
  baseUrl: providerBaseUrlSchema,
  type: z.enum(MODEL_TYPES, { errorMap: () => ({ message: `type 只能是 ${MODEL_TYPES.join('/')}` }) }),
  enabled: z.boolean().optional(),
  /** 可缺省（先建 Provider 后配 Key 是正常流程）。`null` 与缺省同义：不配置 Key */
  apiKey: providerApiKeySchema.nullish(),
})
export type CreateModelProviderBody = z.infer<typeof createModelProviderBodySchema>

// ───────────────────────────── 改（三态） ─────────────────────────────

/**
 * `PATCH /api/model-providers/:id` 请求体：**至少给一个字段**。
 *
 * **`apiKey` 的三态**（`06` P0-1-10 坑预判：前端极易误清空）：
 *
 * | 传法 | 语义 | 典型场景 |
 * |------|------|---------|
 * | 不带 `apiKey` 字段 | **不动原 Key** | 改个名字/启停，表单里 Key 显示的是掩码、用户没碰它 |
 * | `"apiKey": null`（或 `""`→400） | **清空** | 明确要移除凭据 |
 * | `"apiKey": "sk-..."` | **写入新 Key** | 换了一把 key |
 *
 * 关键点：**「没带」与「带 null」必须区分开**。如果用 `.optional().default(null)` 之类把二者合并，
 * 那么"改个名字"会顺手把 Key 抹掉 —— 而且是静默的（响应里只有 `hasKey: false`），
 * 要等到真正调用模型时才发现。所以这里刻意**不做 default**，让 `undefined` 原样传到服务层。
 */
export const updateModelProviderBodySchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(128, '名称最多 128 个字符').optional(),
    baseUrl: providerBaseUrlSchema.optional(),
    type: z
      .enum(MODEL_TYPES, { errorMap: () => ({ message: `type 只能是 ${MODEL_TYPES.join('/')}` }) })
      .optional(),
    enabled: z.boolean().optional(),
    /**
     * ⚠️ 这里必须是 `.nullable().optional()`（**不能**用 `.nullish()` 之外的简化写法，
     * 也不要加 `.default()`）：要保留 `undefined`（不动）与 `null`（清空）两个不同的输入。
     */
    apiKey: providerApiKeySchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.baseUrl !== undefined ||
      body.type !== undefined ||
      body.enabled !== undefined ||
      // `apiKey: null`（清空）在这里也判为 true —— `null !== undefined`，正是想要的效果；
      // 只有"整个字段缺席"（undefined）才算没给。
      body.apiKey !== undefined,
    { message: '至少要提供一个要修改的字段' },
  )
export type UpdateModelProviderBody = z.infer<typeof updateModelProviderBodySchema>

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const modelProviderIdParamsSchema = z.object({
  id: z.string().uuid('Provider ID 不是合法 UUID'),
})
export type ModelProviderIdParams = z.infer<typeof modelProviderIdParamsSchema>

// ───────────────────── 拉取上游模型列表（P0-1-12） ─────────────────────

/**
 * 上游 `GET {baseUrl}/models` 的一项（三种常见形态已在后端归一化，见
 * `backend/src/llm/client.ts#normalizeRemoteModels`）。
 *
 * ⚠️ 这个端点是**只读探测**，不落库：把上游的真实情况照实回给管理页，
 * 让管理员自己决定"要不要把它加成模型"（自动化增删是另一件事，`01` §3.2 没要求，
 * 而且上游的模型清单里常常混着一堆不能用的：embedding、图像、老版本……）。
 */
export const remoteModelItemSchema = z.object({
  /** 上游的 model id（要原样填进 `POST /api/models` 的 `modelName`） */
  id: z.string(),
  /** `owned_by` / `organization`，各家命名不一，缺失为 `null` */
  ownedBy: z.string().nullable(),
  /** 上游给的 Unix 秒级创建时间，缺失为 `null` */
  created: z.number().int().nullable(),
})
export type RemoteModelItem = z.infer<typeof remoteModelItemSchema>

/**
 * `GET /api/model-providers/:id/remote-models` 的响应。
 *
 * 刻意**不带** Provider 的 `apiKey`/明文/掩码 —— 与 Provider 的读接口同一条不变式
 * （`02` §十：Key 有进无出）。`baseUrl` 回显是为了让管理员一眼看到"探的是哪个地址"
 * （配错 baseUrl 是这个端点最常暴露的问题）。
 */
export const remoteModelListResultSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  baseUrl: z.string(),
  /** 上游**真实**条数（去重后） */
  total: z.number().int().min(0),
  /** `items` 是否被上限截断（截断是**显式**的，不做静默截断） */
  truncated: z.boolean(),
  items: z.array(remoteModelItemSchema),
})
export type RemoteModelListResult = z.infer<typeof remoteModelListResultSchema>
