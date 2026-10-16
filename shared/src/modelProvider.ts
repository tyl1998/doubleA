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

// ───────────────────────── 上游协议（P0-1-37） ─────────────────────────

/**
 * **上游协议**：这个 Provider 的上游"怎么说话"（`docs/02` §6.1 的三协议映射表）。
 *
 * ⚠️ 与 {@link MODEL_TYPES} 是**两件事**：`type` 是**用途**（对话 / 向量），协议是**报文形状**。
 * 同一个用途可以有多种协议（对话可以是 OpenAI 兼容、OpenAI Responses、Anthropic 原生），
 * 而向量只有一条路（见 {@link DEFAULT_UPSTREAM_PROTOCOL}）。
 *
 * 与 `schema.prisma` 的 `enum UpstreamProtocol` **逐字一致**。
 */
export const UPSTREAM_PROTOCOLS = ['OPENAI_COMPAT', 'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const
export type UpstreamProtocol = (typeof UPSTREAM_PROTOCOLS)[number]

/** 协议的中文名（管理页列、下拉、错误文案共用一处） */
export const UPSTREAM_PROTOCOL_LABELS: Readonly<Record<UpstreamProtocol, string>> = {
  OPENAI_COMPAT: 'OpenAI 兼容',
  OPENAI_RESPONSES: 'OpenAI Responses',
  ANTHROPIC_MESSAGES: 'Anthropic Messages',
}

/**
 * 每个协议该往 `baseUrl` 里填什么。
 *
 * 三条都要求"**填到版本段为止**"（如 `…/v1`）—— 这是最常填错的一处：把
 * `https://api.anthropic.com/v1/messages` 整条粘进 baseUrl 会拼成
 * `…/v1/messages/messages` ⇒ 404，而 404 的文案只会说"请检查 baseUrl 是否包含正确的版本段"。
 */
export const UPSTREAM_PROTOCOL_BASE_URL_HINTS: Readonly<Record<UpstreamProtocol, string>> = {
  OPENAI_COMPAT: '如 https://api.openai.com/v1 —— 填到版本段为止（后端会拼 /chat/completions）',
  OPENAI_RESPONSES: '如 https://api.openai.com/v1 —— 填到版本段为止（后端会拼 /responses）',
  ANTHROPIC_MESSAGES: '如 https://api.anthropic.com/v1 —— 填到版本段为止（后端会拼 /messages）',
}

/**
 * **默认协议**，同时也是**向量（embedding）唯一允许**的协议。
 *
 * 两个用途合成一个常量是刻意的 —— 它们本来就是同一个事实："OpenAI 兼容"是这个系统
 * 既有的、也是最普遍可用的那一条路（P0-1-37 之前**全部**流量都走它，所以它天然是默认值；
 * 而 `02` §八 规定 embedding 只有 `/embeddings` 一条路，所以它也是向量侧的唯一解）。
 * 拆成两个常量会让"默认协议改了、但向量白名单没跟着改"变成一个静默的不一致。
 */
export const DEFAULT_UPSTREAM_PROTOCOL: UpstreamProtocol = 'OPENAI_COMPAT'

/**
 * 「向量 Provider 只能配默认协议」这一条判据的**唯一实现**（schema 与 service 共用）。
 *
 * ⚠️ 写成纯函数而不是两处各写一遍 `type === 'EMBEDDING' && protocol !== …`：
 * 建与改两条路径都要判它，而**改**那条只能拿"库里的 type + 请求里的 protocol"合并后再判
 * （请求里可能一个字段都没带）⇒ 判据必须能被两处用**不同入参**调用。
 */
export function protocolAllowedForType(type: ModelType, protocol: UpstreamProtocol): boolean {
  return type !== 'EMBEDDING' || protocol === DEFAULT_UPSTREAM_PROTOCOL
}

/** 上一条的中文说明（400 的字段级文案与前端提示共用） */
export const EMBEDDING_PROTOCOL_CONFLICT_MESSAGE = `向量类型的 Provider 只能用 ${DEFAULT_UPSTREAM_PROTOCOL} 协议（embedding 只有 OpenAI 兼容一条路）`

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
 * **凭据模式**（P1-18 · 子批 C；与"可见范围"**正交**）：Provider 的 Key 从哪来。
 *
 * · `SHARED`（默认，共享 Key）= 用 Provider 自己配的那把 Key（既有行为）；
 * · `PER_USER`（各自 Key）= 每个调用者用自己的 Key（`provider_user_credentials`）；
 *   缺 ⇒ **424 `NEED_CREDENTIAL`**（走既有的缺凭据提示通道）。
 *
 * 与 `schema.prisma` 的 `enum ProviderCredentialMode` 逐字一致。
 */
export const PROVIDER_CREDENTIAL_MODES = ['SHARED', 'PER_USER'] as const
export type ProviderCredentialMode = (typeof PROVIDER_CREDENTIAL_MODES)[number]

export const PROVIDER_CREDENTIAL_MODE_LABELS: Readonly<Record<ProviderCredentialMode, string>> = {
  SHARED: '共享 Key',
  PER_USER: '各自 Key',
}

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
  /**
   * 自定义 URL（P0：非规范第三方端点）。为 `true` 时 {@link baseUrl} **就是完整端点**，
   * 后端原样发请求、**不再拼**任何路径后缀（`/chat/completions` 等）。默认 `false` = 既有拼接。
   * ⚠️ 开启后「远程拉模型」（`GET /models` 探测）无法从固定后缀派生，型号名需手动录入。
   */
  customUrl: z.boolean(),
  type: z.enum(MODEL_TYPES),
  /**
   * 上游协议（P0-1-37）。⚠️ 与 `type` 是两件事：这个是"**怎么说话**"，`type` 是"**干什么用**"。
   * 管理页把它当一列显示（改错协议的症状是"一发消息就 404/401"）。
   */
  protocol: z.enum(UPSTREAM_PROTOCOLS),
  enabled: z.boolean(),
  /** 是否已配置**共享** Key（`credentialMode=SHARED` 时才有意义）。**只有布尔**，不泄露长度等元信息 */
  hasKey: z.boolean(),
  /**
   * 共享 Key 的掩码（如 `sk-****abcd`）；未配置时为 `null`。
   * 由后端**解密后**取首尾生成 —— 也就是说"能看到掩码"本身证明了密文可解（主密钥没换错）。
   */
  apiKeyPreview: z.string().nullable(),
  /** P1-18：**凭据模式**（共享 Key / 各自 Key）。见 {@link PROVIDER_CREDENTIAL_MODES} */
  credentialMode: z.enum(PROVIDER_CREDENTIAL_MODES),
  /**
   * P1-18：**当前调用者**是否已配置自己的 Key（`credentialMode=PER_USER` 时才有意义）。
   * 前端据此把"我的 Key"入口渲染成"已配置（掩码）/ 去设置"。
   */
  userHasKey: z.boolean(),
  /** 该 Provider 下挂的模型数（前端删 Provider 前的提示、"这个能不能删"的依据） */
  modelCount: z.number().int().min(0),
  /**
   * P1-13：**所属人**（新增 `created_by` 列，存量回填最早的 ADMIN）。编/删/转移 = 所属人 + ADMIN。
   * ⚠️ **系统级 Provider**（`createdBy` 是 ADMIN）**只有 ADMIN** 能改/删
   * （非 ADMIN 既不是所属人、也不是 ADMIN ⇒ `canEdit` 恒 false，防普通用户改坏系统模型）。
   */
  createdBy: z.string(),
  /** 所属人显示名（昵称优先、回落用户名） */
  creatorName: z.string(),
  /**
   * P1-18：**Provider 没有可见范围**（`PUBLIC`/`PRIVATE` 与定向分享都已删除）。
   *
   * 2026-10-16 修订：**读 = 全体登录用户**（Provider/Model 即"平台模型池"，人人可见、只读），
   * **写 = 所属人 + ADMIN**（本字段逐行下发供前端门禁编 / 删 / 转移 / 建模型）。
   * 原因：模型只能通过某个 **Agent** 被使用 ⇒ 全局"曝光"不承担访问控制（那归 Agent 可见范围）；
   * 但"能不能看见平台模型池"是产品需求（管理员维护、全员选用），故读不设限、写按所属人收敛。
   * 见 `shared/src/assetAcl.ts` 文件头 ①。
   */
  canEdit: z.boolean(),
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
  /**
   * 自定义 URL（非规范第三方端点）。缺省即 `false`（= 既有拼接行为）。
   * 与 `protocol` 同款：`.optional()` 而非 `.default()`，默认值只在服务层补一处。
   */
  customUrl: z.boolean().optional(),
  /**
   * 上游协议；**缺省即 {@link DEFAULT_UPSTREAM_PROTOCOL}**（= P0-1-37 之前的所有行为）。
   *
   * ⚠️ 这里用 `.optional()` 而**不是** `.default()`：与 `update` 保持同一口径，
   * 默认值只在**服务层**补一处（`?? DEFAULT_UPSTREAM_PROTOCOL`）。用 `.default()` 会让
   * `z.infer` 变成 required、`z.input` 变成 optional —— 同一个字段两套类型，
   * 服务层读到的类型与运行时不一致（`06` P0-1-24 那类"看着对、其实对不上"的坑）。
   */
  protocol: z
    .enum(UPSTREAM_PROTOCOLS, {
      errorMap: () => ({ message: `protocol 只能是 ${UPSTREAM_PROTOCOLS.join('/')}` }),
    })
    .optional(),
  enabled: z.boolean().optional(),
  /**
   * P1-18：**凭据模式**（缺省即 `SHARED`）。`PER_USER` 时每个调用者用自己的 Key（缺 ⇒ 424）。
   * 与 `protocol` 同款：`.optional()` 而非 `.default()`，默认值只在服务层补一处。
   */
  credentialMode: z
    .enum(PROVIDER_CREDENTIAL_MODES, {
      errorMap: () => ({ message: `credentialMode 只能是 ${PROVIDER_CREDENTIAL_MODES.join('/')}` }),
    })
    .optional(),
  /** 可缺省（先建 Provider 后配 Key 是正常流程）。`null` 与缺省同义：不配置 Key */
  apiKey: providerApiKeySchema.nullish(),
})
  /**
   * ⚠️ 用 `superRefine` 而不是 `.refine()`：后者失败时 `path` 是**空串**，
   * 前端没法把错误挂到 `protocol` 那个下拉上（`06` P0-1-24 的教训）。
   */
  .superRefine((body, ctx) => {
    // 缺省按默认协议判（与 service 层补的默认值同一口径）
    if (!protocolAllowedForType(body.type, body.protocol ?? DEFAULT_UPSTREAM_PROTOCOL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocol'],
        message: EMBEDDING_PROTOCOL_CONFLICT_MESSAGE,
      })
    }
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
    /** 自定义 URL 开关（两态：不带 = 不动；给值 = 改成它）。不加 `.default()`，理由同 `protocol` */
    customUrl: z.boolean().optional(),
    type: z
      .enum(MODEL_TYPES, { errorMap: () => ({ message: `type 只能是 ${MODEL_TYPES.join('/')}` }) })
      .optional(),
    /**
     * 上游协议（P0-1-37）。**三态与 `apiKey` 不同**：这里没有"清空"这个概念
     * （协议总得有一个值），所以只有"不带 = 不动"与"给值 = 改成它"两态。
     * ⚠️ 正因为如此，**绝不能加 `.default()`** —— 那会把"改个名字"顺手改成默认协议。
     */
    protocol: z
      .enum(UPSTREAM_PROTOCOLS, {
        errorMap: () => ({ message: `protocol 只能是 ${UPSTREAM_PROTOCOLS.join('/')}` }),
      })
      .optional(),
    enabled: z.boolean().optional(),
    /**
     * P1-18：**凭据模式**（两态：不带 = 不动；给值 = 改成它）。不加 `.default()`，理由同 `protocol`。
     * 改成 `PER_USER` 后共享 Key 不再被使用（保留原密文，便于改回）；改成 `SHARED` 恢复使用共享 Key。
     */
    credentialMode: z
      .enum(PROVIDER_CREDENTIAL_MODES, {
        errorMap: () => ({ message: `credentialMode 只能是 ${PROVIDER_CREDENTIAL_MODES.join('/')}` }),
      })
      .optional(),
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
      body.customUrl !== undefined ||
      body.type !== undefined ||
      body.protocol !== undefined ||
      body.enabled !== undefined ||
      body.credentialMode !== undefined ||
      // `apiKey: null`（清空）在这里也判为 true —— `null !== undefined`，正是想要的效果；
      // 只有"整个字段缺席"（undefined）才算没给。
      body.apiKey !== undefined,
    { message: '至少要提供一个要修改的字段' },
  )
  /**
   * ⚠️ 这里**只能**判"请求里同时给了 `type=EMBEDDING` 与一个非默认协议"这一种情况。
   * 「库里的 type 是 EMBEDDING、而这次只改 protocol」拿不到库值 ⇒ 必须在**服务层**判
   * （那里才查得到这一行）。两处共用 {@link protocolAllowedForType}，判据只有一份。
   */
  .superRefine((body, ctx) => {
    if (
      body.type !== undefined &&
      body.protocol !== undefined &&
      !protocolAllowedForType(body.type, body.protocol)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocol'],
        message: EMBEDDING_PROTOCOL_CONFLICT_MESSAGE,
      })
    }
  })
export type UpdateModelProviderBody = z.infer<typeof updateModelProviderBodySchema>

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const modelProviderIdParamsSchema = z.object({
  id: z.string().uuid('Provider ID 不是合法 UUID'),
})
export type ModelProviderIdParams = z.infer<typeof modelProviderIdParamsSchema>

// ───────────────────── 我的 Key（P1-18 · 子批 C；per-user 凭据） ─────────────────────

/**
 * `GET/PUT/DELETE /api/model-providers/:id/my-credential` 的响应：**当前调用者**的 Key 状态。
 *
 * ⚠️ 与 Provider 的 `apiKey` 同一条不变式：只有布尔 + 掩码，**没有明文**。
 * 任何人（含被 Agent 受众圈进的普通用户）都能给自己的 Key，**ADMIN 也读不到别人的**（凭据是个人隐私）。
 */
export const providerUserCredentialItemSchema = z.object({
  hasKey: z.boolean(),
  apiKeyPreview: z.string().nullable(),
})
export type ProviderUserCredentialItem = z.infer<typeof providerUserCredentialItemSchema>

/**
 * `PUT /api/model-providers/:id/my-credential` 请求体：写入/替换**我的** Key。
 * 清空走 `DELETE`（不在这里用 `null` 表达——那是 Provider 共享 Key 的三态口径，这里只有一条路）。
 */
export const setProviderUserCredentialBodySchema = z.object({
  apiKey: providerApiKeySchema,
})
export type SetProviderUserCredentialBody = z.infer<typeof setProviderUserCredentialBodySchema>

/**
 * `GET /api/model-providers/my-credentials` 的一行（P1-18 ·「我的凭据」页的 Provider 凭据清单）。
 *
 * 为什么需要它：`credentialMode=PER_USER` 的 Provider 每个使用者各配一把 Key；缺了，对话返回 424
 * 「尚未配置所需凭据」。「我的凭据」页需要一份**带凭据状态**的 Provider 清单来就地配置。
 *
 * ⚠️ 2026-10-16 修订（用户定案）：**只列"我自己的"** ——
 *   · **我作为所属人**的 Provider（任何模式），其中 **`SHARED` 共享 Key 只给所属人看**（别人看不到）；
 *   · **全部启用的「各自 Key」Provider**（`PER_USER`，**含未配置**）—— 平台模型池人人可见，
 *     任何使用者都可能要给它配自己的 Key，故一律给配置入口。
 *   与我无关的 `SHARED` Provider 不列。
 *
 * ⚠️ 只有布尔 + 掩码，**无明文**。
 *
 * ⚠️ 两种模式下 `hasKey`/`apiKeyPreview` 的**主语不同**：
 *   · `PER_USER` ⇒ 是**我自己的** Key 状态（可就地配置）。
 *   · `SHARED`   ⇒ 是该 Provider **共享 Key** 的状态与掩码（**只读**，改它去模型池编辑表单）。
 *   判定"我该不该配"时要**先看 `credentialMode`** —— 别把共享 Key 的"未配置"当成我要处理的事。
 */
export const myProviderCredentialEntrySchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  /** 该 Provider 的**凭据模式**（决定 `hasKey`/`apiKeyPreview` 说的是谁的 Key） */
  credentialMode: z.enum(PROVIDER_CREDENTIAL_MODES),
  /**
   * 是否已配置 Key —— **主语随 `credentialMode` 变**：
   * `PER_USER` = 我是否配了自己的那把；`SHARED` = 该 Provider 是否配了共享 Key（或：凭据是否已就绪）。
   */
  hasKey: z.boolean(),
  /** 掩码（主语同上）；未配置为 `null`。**永不含明文** */
  apiKeyPreview: z.string().nullable(),
})
export type MyProviderCredentialEntry = z.infer<typeof myProviderCredentialEntrySchema>

export const myProviderCredentialsResultSchema = z.object({ items: z.array(myProviderCredentialEntrySchema) })
export type MyProviderCredentialsResult = z.infer<typeof myProviderCredentialsResultSchema>


// ─────────────── 删除前的"被绑定模型"清单 + 删除结果（删模型商自动解绑） ───────────────

/**
 * `GET /api/model-providers/:id/bound-models` 的一项：该 Provider 下**正被智能体绑定**的一个模型。
 *
 * 用于删除弹窗如实列出"删了会解绑哪些"。`agentCount` **只算未软删的在线智能体**
 * （软删的智能体本就该被视作已解绑，不该再吓唬管理员）。
 */
export const providerBoundModelSchema = z.object({
  modelId: z.string(),
  /** 模型别名（界面名） */
  label: z.string(),
  /** 上游型号名 */
  modelName: z.string(),
  /** 绑定这个模型的**在线**智能体数（>0 才会出现在列表里） */
  agentCount: z.number().int().min(1),
})
export type ProviderBoundModel = z.infer<typeof providerBoundModelSchema>

/**
 * `GET /api/model-providers/:id/bound-models` 的响应。
 *
 * `models` 是该 Provider 下**被在线智能体绑定**的模型清单（没有绑定的模型不列）；
 * `agentTotal` 是受影响的（去重）智能体数 —— 删除后它们会被自动解绑、变为"未绑定模型"。
 */
export const providerBoundModelsResultSchema = z.object({
  providerId: z.string(),
  models: z.array(providerBoundModelSchema),
  /** 受影响的在线智能体总数（去重） */
  agentTotal: z.number().int().min(0),
})
export type ProviderBoundModelsResult = z.infer<typeof providerBoundModelsResultSchema>

/**
 * `DELETE /api/model-providers/:id` 的响应。
 *
 * 删 Provider 会级联删其下模型；引用这些模型的在线智能体被**自动解绑**（`model_id` 置空）。
 * `unboundAgents` 报出被解绑的智能体数，供界面给出有信息量的确认提示。
 */
export const removeModelProviderResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 连带删除的模型数 */
  deletedModels: z.number().int().min(0),
  /** 被自动解绑（`model_id` 置空）的在线智能体数 */
  unboundAgents: z.number().int().min(0),
})
export type RemoveModelProviderResult = z.infer<typeof removeModelProviderResultSchema>

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
  /**
   * 上游给的上下文长度（token）。**只有部分实现返回**（OpenRouter 的 `context_length`、
   * vLLM 的 `max_model_len` 等）；标准 OpenAI `/models` 不含此字段，缺失为 `null`。
   * 用于"新建模型时默认填充上下文长度"（读不到就留空，管理员手填）。
   */
  contextLength: z.number().int().nullable(),
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
