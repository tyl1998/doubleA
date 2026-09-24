/**
 * MCP server 契约（P0-2-2；`02` §三 + §4.7 + §九，`06` §四 4.0 / 4.2 / 4.3，`01` §3.6，`03` §4.4）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：**登录即可（全员可注册）**，且**没有 owner 列收窄** —— 与知识库同族
 * ─────────────────────────────────────────────────────────────────────
 * `06` §4.2 的第五族：`/api/mcp/**` 一律"登录即可"，与 users（ADMIN）、conversations（仅本人）
 * 都不像。⚠️ 但**凭据那几条路径**（P0-2-4）的收窄不在角色上而在 `user_id` 上。
 * 本文件对应的 `mcp_servers` 表**没有 owner 列的收窄** —— `created_by` 只作**留痕**
 * （记"谁注册的这个 server"），不参与任何权限判定。⇒ 代价是"任何登录用户都能改/删别人注册的
 * server"，这是 `01` 决策 22 的直接推论，**不是实现疏漏**；要收紧得先改 `01`/`02`。
 * `verify:mcp-servers` 里专门有一条**反向守卫**盯着它（"能删掉别人建的 server"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② `auth_type` / `oauth_config` 是**接口留位、能力不做**（`06` §4.0 口径 1）
 * ─────────────────────────────────────────────────────────────────────
 * 列先建出来（免得 P1 再改表），但 **P0 只接受 `NONE`**：收到 `OAUTH` ⇒ 400 且文案指向 P1。
 * 理由与 P0-1-23 拒绝 `MCP` 绑定的定案同源：**不"先收下、等以后有表了再收拾"** ——
 * 存下一个 `OAUTH` 的 server 却发现没有授权端点，用户会以为它能用（真故障是"调用时才 401"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ `slug` 从 `name` 派生、**创建时生成后不再变**（`06` §4.3 + P0-2-5 坑预判 2）
 * ─────────────────────────────────────────────────────────────────────
 * 它的唯一用途是**工具名前缀**（P0-2-6：`mcp_{slug}_{toolName}`）。改名**不改**工具名是刻意的：
 * 工具名会进历史消息的 `content.tool_calls`，跟着改名会让**历史卡片对不上真实调用**。
 * ⚠️ 因此 `PATCH` **不接受 `slug`**（契约里根本没有这个字段），派生函数
 * {@link slugifyServerName} / {@link uniqueSlug} 是**纯函数**（`verify:app` 无需依赖即可断言）。
 * ⚠️ 唯一性只是 **best-effort**：`slug` 列**刻意没有唯一约束**（两个不同请求并发同名注册时
 * 不该有一个 500），最终防线在 P0-2-6 的"工具名冲突加序号"（它本来就要处理同名工具）。
 */

import { z } from 'zod'

import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 取值域与上限（常量即契约）─────────────────────────────

/**
 * 注册方式（`02` §三 的 `auth_type(NONE|OAUTH)`）。
 * P0 只支持 `NONE`（用户级凭据注入覆盖了绝大多数鉴权需求，`04` 评审建议 A7 的选项 (a)）。
 */
export const MCP_AUTH_TYPES = ['NONE', 'OAUTH'] as const
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number]

/**
 * server 的**连通健康态**（`02` §三 原文只写了列名 `status`、没给取值域；本批补定）。
 *
 * `UNKNOWN` = 从未测过（刚注册且探测失败 / 探测被跳过）；`OK` / `ERROR` = 最近一次
 * `POST /:id/test` 的结论。⚠️ 它**不是启停开关** —— 本批不提供"停用"入口，因为
 * "停用"要配一套"停用后工具不可见"的行为（属 P0-2-5/P0-2-6），现在加一个只有写入没有读取的
 * 状态位只会造出"看着能停、其实照跑"的假开关。
 */
export const MCP_SERVER_STATUSES = ['UNKNOWN', 'OK', 'ERROR'] as const
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number]

/** 凭据参数的注入位置（`02` §九；`01` §3.6 的"header·query·body"） */
export const CREDENTIAL_INJECT_LOCATIONS = ['HEADER', 'QUERY', 'BODY'] as const
export type CredentialInjectLocation = (typeof CREDENTIAL_INJECT_LOCATIONS)[number]

/** server 名（列 `VARCHAR(128)`，与 `knowledge_bases.name` 同口径） */
export const MCP_SERVER_NAME_MAX = 128

/**
 * `endpoint_url` 上限（列 `VARCHAR(2048)`）。
 * 2048 是"任何浏览器/网关都认"的经验上限；真实 MCP 端点通常不到 100 字符。
 */
export const MCP_ENDPOINT_URL_MAX = 2048

/**
 * 凭据模板的条目数上限。
 *
 * 定 64 的理由是**它同时是渲染上限**：`03` §4.4 的模板编辑器是一行一个参数的表单，
 * 超过这个量级说明设计走偏了（该拆成多个 server）。同时它顺手挡住"把一整个大 JSON
 * 塞进 jsonb"这类误用（模板是**给用户填的表单**，不是任意配置仓库）。
 */
export const MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES = 64

/** `slug` 上限（`06` P0-2-5 坑预判 2 定案：小写 + 非字母数字转 `-` + 截断 32） */
export const MCP_SLUG_MAX = 32

/** `name` 里没有任何 ASCII 字母数字时的兜底 slug（中文名会走到这条路上） */
export const MCP_SLUG_FALLBACK = 'server'

// ───────────────────────────── slug 派生（纯函数，唯一实现）─────────────────────────────

/**
 * `name` → `slug`（小写 ASCII；非 `[a-z0-9]` 一律折成 `-`；截断 {@link MCP_SLUG_MAX}）。
 *
 * ⚠️ 纯 ASCII 化的后果要说清楚：**纯中文名会整串折成空串**（如"内部工单平台" ⇒ `''`），
 * 于是回落到 {@link MCP_SLUG_FALLBACK}。这是刻意的取舍 —— slug 要进**工具名**，
 * 而工具名的字符集被各家 provider 限制在 `[A-Za-z0-9_-]`（P0-2-6 坑预判 3）。
 * 可读性由 `name` 承担（工具卡片显示的是 `name`，不是 slug）。
 */
export function slugifyServerName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MCP_SLUG_MAX)
    // ⚠️ 先 slice 再去尾 `-`：截断可能正好落在分隔符上，留个尾巴会产出 `foo--2` 这种名字
    .replace(/-+$/, '')
  return normalized === '' ? MCP_SLUG_FALLBACK : normalized
}

/**
 * 在 `taken` 里挑一个不冲突的 slug：未占用就用 `base`，否则依次试 `base-2`、`base-3`…
 *
 * ⚠️ 这是 **best-effort**（见文件头 ③）：调用方把"库里已用的 slug"传进来即可，
 * **不要**为它加唯一约束 —— 并发的同名注册不该有一个失败。最终唯一性由 P0-2-6 的工具名
 * 序号机制保证。后缀计算时会把 base 截短，保证总长不超过 {@link MCP_SLUG_MAX}
 * （否则"截断到 32"会让 `-2` 被截掉、两个 slug 又撞在一起）。
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken : new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const head = base
      .slice(0, Math.max(1, MCP_SLUG_MAX - suffix.length))
      .replace(/-+$/, '')
    const candidate = `${head}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

// ───────────────────────────── 工具投影（与 P0-2-1 的出口**同一形状**）─────────────────────────────

/**
 * 工具描述符 —— `tools/list` 的投影。
 *
 * ⚠️ **类型的唯一落点在这里**（`backend/src/mcp/client.ts` 改成重导出，不再自己写一份 interface）。
 * 两边各写一份的后果是"P0-2-1 的 client 加了字段、HTTP 出口不知道"，而 `typecheck` 不会报
 * —— 契约与实现是同一个东西时，这个风险才结构性消失（同 P0-1-27 的"引用卡形状只定义一次"）。
 *
 * 六个键**恒存在**：`name` 是字符串；`title`/`description`/`annotations` 缺失一律落 `null`；
 * `inputSchema` **原样**（任何兼容处理属 P0-2-6）；`hasOutputSchema` 是布尔（服务端有没有声明 `outputSchema`）。
 */
export const mcpToolDescriptorSchema = z.object({
  name: z.string(),
  /** 服务端给的人读标题；缺失 → `null` */
  title: z.string().nullable(),
  /** 给模型看的说明；缺失 → `null`（`''` 原样保留，非缺失） */
  description: z.string().nullable(),
  /** MCP 声明的 JSON Schema，**原样**（P0-2-6 才做兼容处理） */
  inputSchema: z.unknown(),
  /** 危险判定的依据（P0-2-9 消费）；缺失 → `null` */
  annotations: z.record(z.unknown()).nullable(),
  /** 服务端是否声明了 `outputSchema`（见 P0-2-1 的注释：SDK 对"声明了却回不出"的工具会抛） */
  hasOutputSchema: z.boolean(),
})
export type McpToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>

// ───────────────────────────── 凭据模板（形状属本批；深度校验属 P0-2-3）─────────────────────────────

/**
 * 凭据参数模板的一行（`02` §九：`{ key, label, type, inject, required?, placeholder? }`）。
 *
 * ⚠️ **本批只做形状校验**（键齐不齐、取值域对不对）。按注入位置判 `key` 的合法性
 * （HEADER 必须是合法头名 / QUERY 不能含 `&`、`=`）、同一模板内 `key` 重复的字段级报错、
 * 以及 `diffCredentialSchema` —— **都属 P0-2-3**（它有专门的验收门槛与 `superRefine` 手法）。
 * **接回点**：`validateCredentialSchema(raw)` → `{ ok, issues }`，本 schema 直接换成它即可，
 * 接口形态（400 + `data.fields[].path`）不变。
 */
export const credentialSchemaEntrySchema = z.object({
  /** 参数名（HEADER 里是头名、QUERY 里是查询键、BODY 里是顶层键） */
  key: z
    .string({ required_error: '请填写凭据参数名' })
    .trim()
    .min(1, '请填写凭据参数名')
    .max(64, '凭据参数名最多 64 个字符'),
  /** 给填值的人看的说明（`03` §4.5 的表单逐行显示它） */
  label: z
    .string({ required_error: '请填写参数说明' })
    .trim()
    .min(1, '请填写参数说明')
    .max(64, '参数说明最多 64 个字符'),
  /**
   * 取值类型。**P0 只支持 `string`**（`02` §九 原文如此）—— 不做 number/boolean/file。
   * 接回点：`credentialValueSchema` 上按 `type` 分支，不影响别处。
   */
  type: z.literal('string', {
    errorMap: () => ({ message: 'type 目前只支持 string' }),
  }),
  inject: z.enum(CREDENTIAL_INJECT_LOCATIONS, {
    errorMap: () => ({ message: `inject 只能是 ${CREDENTIAL_INJECT_LOCATIONS.join('/')}` }),
  }),
  /** 是否必填（P0-2-4 用来判"整体是否已配置"）；省略 = 非必填 */
  required: z.boolean().optional(),
  /** 输入框的占位提示（纯展示） */
  placeholder: z.string().trim().max(128, 'placeholder 最多 128 个字符').optional(),
})
export type CredentialSchemaEntry = z.infer<typeof credentialSchemaEntrySchema>

/**
 * 凭据模板整体：**数组**（不是对象）—— 顺序即界面顺序，刻意保留（P0-2-3 坑预判 4）。
 * ⚠️ 因此"模板有没有变"必须按 **key 集合**判（改顺序不算改动），属 P0-2-3 的 `diffCredentialSchema`。
 */
export const credentialSchemaSchema = z
  .array(credentialSchemaEntrySchema)
  .max(MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES, `凭据参数最多 ${MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES} 个`)
export type CredentialSchema = z.infer<typeof credentialSchemaSchema>

/**
 * jsonb → **可用**的 {@link CredentialSchema}。**永不抛错**（读取端的唯一入口）。
 *
 * 为什么读取端必须过一遍它：`credential_schema` 是 jsonb，DB 默认值只在"INSERT 时不给该列"
 * 才生效 —— 手工改库、从别的环境导入、或将来加字段造成的半截数据都读得出"数组里混着坏条目"。
 * 更关键的是**它会被直接下发给前端渲染表单**（`03` §4.4 的模板编辑器）：一个 `undefined` 的
 * `inject` 会让整个表单崩在渲染期，而 `GET /:id/tools`、列表、详情三条路径都会用到它。
 *
 * 处置：**逐条过滤**（坏的那一条丢掉、好的留下），而不是"整份作废" —— 与
 * `normalizeRetrievalConfig` 的逐键兜底同一条理由：`null`（没配）与"配了但读不出来"
 * 是两件事，后者不该被静默升级成前者。
 */
export function normalizeCredentialSchema(raw: unknown): CredentialSchema {
  if (!Array.isArray(raw)) return []
  const out: CredentialSchema = []
  for (const entry of raw) {
    const parsed = credentialSchemaEntrySchema.safeParse(entry)
    if (parsed.success) out.push(parsed.data)
    if (out.length >= MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES) break
  }
  return out
}

// ───────────────────────────── 输出投影 ─────────────────────────────

/**
 * 一个 MCP server（列表项 / 详情 / 建改的响应，**一套投影**）。
 *
 * ⚠️ 两个键**刻意不在这里**：
 *   · `oauthConfig` —— P1 的字段（`02` §三 标"可选"）。下发一个恒为 `null` 的字段只会诱使
 *     前端写永远走不到的分支（与 `agent_components.config` "不进契约"是同一条定案）。
 *   · `toolCache`（完整工具数组）—— 列表页要的是**工具数**（`toolCount`），
 *     要完整列表走 `GET /:id/tools`。把 N 个 server 的完整 schema 塞进列表响应会让
 *     一次翻页变成几百 KB（工具 schema 是很啰嗦的 JSON）。
 */
export const mcpServerItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * 工具名前缀用的派生名（见文件头 ③）。**创建时生成、之后不变**，且**不可由调用方指定**
   * （它一旦可改，"历史消息里的工具名对不上真实调用"就只是时间问题）。
   */
  slug: z.string(),
  /** Streamable HTTP 的**单一 URL**（不是 baseUrl + 路径拼接） */
  endpointUrl: z.string(),
  /** P0 恒为 `NONE`（见文件头 ②） */
  authType: z.enum(MCP_AUTH_TYPES),
  /** 注册者定义的参数模板（数组 = 界面顺序，见 {@link credentialSchemaSchema}） */
  credentialSchema: credentialSchemaSchema,
  /**
   * 缓存里的工具数（`tool_cache.tools.length`）。
   * ⚠️ `0` 有两种含义：**没拉过**（`status === 'UNKNOWN'` 或缓存在注册信息变更时被清掉）
   * 与**真的没有工具**。界面据此显示 `—` 还是 `0`（同"未命中的一路是 `null` 不是 0"的
   * 老口径：**说不出来的数字宁可留白**）。
   */
  toolCount: z.number().int().min(0),
  /** 连通健康态（见 {@link MCP_SERVER_STATUSES}） */
  status: z.enum(MCP_SERVER_STATUSES),
  /** **留痕**字段：谁注册的。⚠️ 不参与权限判定（见文件头 ①） */
  createdBy: z.string(),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type McpServerItem = z.infer<typeof mcpServerItemSchema>

/**
 * `POST /api/mcp/servers/:id/test` 的响应。
 *
 * **HTTP 恒 200**（`06` §4.3 定案）：连通测试**自身是请求成功** —— 它确实给出了结论
 * （"连不上"就是一个结论），把上游抖动映射成 5xx 会让"这个 server 现在通不通"这件事
 * 从"一个可用信息"变成"一个错误"。理由与 `/health` 恒 200（§4.9）完全同源。
 *
 * ⚠️ 两个分支**互斥**（用 union 而不是"两个可选键"）：`ok:true` 必带 `tools`、
 * `ok:false` 必带 `error`。写成两个 `.optional()` 会允许"成功但没工具列表"这种
 * 前端无法渲染的中间态。
 */
export const mcpServerTestResultSchema = z.union([
  z.object({ ok: z.literal(true), tools: z.array(mcpToolDescriptorSchema) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type McpServerTestResult = z.infer<typeof mcpServerTestResultSchema>

/**
 * `POST /api/mcp/servers` 的响应：**裸 item + 一次 best-effort 探测结果**。
 *
 * `01` §3.6 的验收要点写着"注册时连通测试"，但把它做成**注册前置**是错的（`06` P0-2-2 坑预判 2）：
 *   · 上游临时抖动会变成"建不了 server"，而用户没有别的入口；
 *   · 而且**刚注册时还没有任何人有凭据**（凭据是每用户每 server 一份），
 *     "这次测试用谁的凭据"这个问题无解。
 * ⇒ 定案：**注册照常成功**，响应里带回这次探测的结论（`test`），正式入口是 `POST /:id/test`。
 *
 * ⚠️ 因此**不要**把它做成"裸 item 再多一个键"：`McpServerItem` 是全端点唯一形状，
 * 加一个只有 create 才有的键就等于承认"同一份数据有两种形状"（P0-1-21 的教训）。
 */
export const mcpServerCreateResultSchema = z.object({
  server: mcpServerItemSchema,
  test: mcpServerTestResultSchema,
})
export type McpServerCreateResult = z.infer<typeof mcpServerCreateResultSchema>

/**
 * `GET /api/mcp/servers/:id/tools` 的响应（**裸对象**，`06` §4.3 定的第五族形态）。
 *
 * 本批它是**纯读缓存**（绝不联网、无副作用）—— "真去拉"走 `POST /:id/test`。
 * `cached` 的语义 = **这份列表来自 `tool_cache` 列**（而不是本次实时拉取）：
 * 对该只读接口它恒等于 `fetchedAt !== null`。P0-2-5 加 `?refresh=1` 之后这两个值才会分叉
 * （"拉失败但缓存还在 ⇒ `cached:true`"），故现在就把它写进契约、界面不必改。
 */
export const mcpServerToolsResultSchema = z.object({
  tools: z.array(mcpToolDescriptorSchema),
  /** 上一次成功拉取的时间（ISO 8601）；从未拉过 → `null` */
  fetchedAt: z.string().nullable(),
  /** 这份列表是否来自缓存（见上） */
  cached: z.boolean(),
})
export type McpServerToolsResult = z.infer<typeof mcpServerToolsResultSchema>

/**
 * `DELETE /api/mcp/servers/:id` 的响应。
 * 与"删 Provider"（`{id,name}`）同口径：删除是"这一个东西没了"，回 id + name 让人能确认删对没有。
 */
export const removeMcpServerResultSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type RemoveMcpServerResult = z.infer<typeof removeMcpServerResultSchema>

// ───────────────────────────── 列表 ─────────────────────────────

/** `GET /api/mcp/servers` 查询参数（offset/limit，与 `/api/users`、`/api/knowledge-bases` 同口径） */
export const listMcpServersQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListMcpServersQuery = z.infer<typeof listMcpServersQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const mcpServerListResultSchema = offsetPageOf(mcpServerItemSchema)
export type McpServerListResult = z.infer<typeof mcpServerListResultSchema>

// ───────────────────────────── 公共字段 ─────────────────────────────

/** server 名（列 `VARCHAR(128)`） */
const mcpServerNameSchema = z
  .string({ required_error: '请输入 MCP server 名称' })
  .trim()
  .min(1, '请输入 MCP server 名称')
  .max(MCP_SERVER_NAME_MAX, `名称最多 ${MCP_SERVER_NAME_MAX} 个字符`)

/**
 * 端点 URL：**只接受 `http` / `https`**（`06` P0-2-2 验收门槛 5）。
 *
 * ⚠️ **必须自己判 scheme**：`z.string().url()` 用的是 `new URL()`，它**接受任何协议**
 * （`ftp://`、`file://`、`gopher://` 全都过）—— 那样"其它协议 400"这条验收就是假的。
 * ⚠️ 用**字段级** `superRefine`（不是 object 级 `.refine()`）：后者的 `path` 是空串，
 * 前端定位不到输入框（P0-1-23 的老坑）。字段级的话 zod 会把键名拼进 `issue.path`。
 *
 * ⚠️⚠️ **SSRF 面（已知边界，P0 不修）**：全员可注册 ⇒ **任何登录用户都能让后端去连任意地址**
 * （打内网服务、探端口、读云元数据 `169.254.169.254`）。本批的处置只有两条：
 * **校验 scheme** + **把这条写进 `02` §4.7 / README 的已知边界**。
 * 真正的防护（denylist / 出站代理 / 域名白名单）**属 P1**（`06` P0-2-2 坑预判 1 定案）。
 * ⇒ 这条**必须留在文档里**，否则它就是一个没人知道的洞。
 */
const mcpEndpointUrlSchema = z
  .string({ required_error: '请填写 endpoint URL' })
  .trim()
  .min(1, '请填写 endpoint URL')
  .max(MCP_ENDPOINT_URL_MAX, `endpoint URL 最多 ${MCP_ENDPOINT_URL_MAX} 个字符`)
  .superRefine((value, ctx) => {
    let protocol: string
    try {
      protocol = new URL(value).protocol
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endpoint URL 不是合法的 URL' })
      return
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint URL 只支持 http / https（Streamable HTTP）',
      })
    }
  })

// ───────────────────────────── 建 ─────────────────────────────

/**
 * `POST /api/mcp/servers` 请求体。
 *
 * `authType` 省略即 `NONE`；`credentialSchema` 省略即 `[]`（"这个 server 不需要用户填任何东西"，
 * 是最常见的一种 —— 内网无鉴权服务）。两者不给默认值语义上的"三态"：
 * `authType` 不是三态字段（枚举没有"清空"可言），`credentialSchema` 的"清空"就是提交 `[]`。
 *
 * ⚠️ `slug` **不在契约里**（服务端从 `name` 派生，见文件头 ③）；`status` / `toolCache` 同理
 * （它们是**服务端观测到的**事实，不由调用方指定）。
 */
export const createMcpServerBodySchema = z.object({
  name: mcpServerNameSchema,
  endpointUrl: mcpEndpointUrlSchema,
  authType: z
    .enum(MCP_AUTH_TYPES, {
      errorMap: () => ({ message: `authType 只能是 ${MCP_AUTH_TYPES.join('/')}` }),
    })
    .optional(),
  credentialSchema: credentialSchemaSchema.optional(),
})
export type CreateMcpServerBody = z.infer<typeof createMcpServerBodySchema>

// ───────────────────────────── 改 ─────────────────────────────

/**
 * `PATCH /api/mcp/servers/:id` 请求体：**至少给一个字段**。
 *
 * ⚠️ 三个字段的"变更"都有副作用（`06` P0-2-2 坑预判 3）：`endpointUrl` / `credentialSchema` /
 * `authType` 任一变了 ⇒ **必须清 `tool_cache`**（"改了 endpoint，工具列表还是旧 server 的"
 * 是**纯静默**的错 —— 界面上那个数字看着完全正常）。判定与执行都在服务层
 * （`updateMcpServer`），此处只负责形状。
 *
 * ⚠️ 改名（`name`）**不动 slug、也不清缓存**：name 不参与连通 —— 清了只会让用户白等一次重拉。
 * 这三条"清 / 不清"的判断是本批最容易写错的地方，验收里有专门的用例盯着（改 endpoint 后
 * `toolCount` 归 0 且 `status` 回 `UNKNOWN`；只改 name 则两者都不动）。
 *
 * `authType: 'OAUTH'` ⇒ 400（属 P1，见文件头 ②）。
 */
export const updateMcpServerBodySchema = z
  .object({
    name: mcpServerNameSchema.optional(),
    endpointUrl: mcpEndpointUrlSchema.optional(),
    authType: z
      .enum(MCP_AUTH_TYPES, {
        errorMap: () => ({ message: `authType 只能是 ${MCP_AUTH_TYPES.join('/')}` }),
      })
      .optional(),
    /** 整体替换（数组语义，"提交什么就是什么"）；清空提交 `[]` */
    credentialSchema: credentialSchemaSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.endpointUrl !== undefined ||
      body.authType !== undefined ||
      body.credentialSchema !== undefined,
    { message: '至少要提供一个要修改的字段' },
  )
export type UpdateMcpServerBody = z.infer<typeof updateMcpServerBodySchema>

// ───────────────────────────── 路径参数 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const mcpServerIdParamsSchema = z.object({
  id: z.string().uuid('MCP server ID 不是合法 UUID'),
})
export type McpServerIdParams = z.infer<typeof mcpServerIdParamsSchema>
