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
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 凭据模板的**深度校验**（P0-2-3）：形状之外的语义层，三条规则**按注入位置分**
 * ─────────────────────────────────────────────────────────────────────
 * P0-2-2 只做了形状（键齐不齐、取值域对不对）；本段补三条"形状合法、但注入出去一定出错"的规则。
 * 三条的共同点是：**错了都不会在这里报错，而要等到调用时**（甚至只表现为"凭据没生效"）——
 * 所以必须在**模板落地的那一刻**拦下来：
 *   · `HEADER` ⇒ `key` 必须是合法的 HTTP 头名（RFC 7230 的 `token`），且**不得占用平台自己要发的
 *     那几个头**（`Accept` / `Content-Type` / `mcp-session-id` / …）。占了的后果最隐蔽：
 *     我们把它的值写进去会**覆盖掉** `Accept` ⇒ Streamable HTTP 的响应形态谈没了（P0-2-7 坑预判 1）。
 *   · `QUERY` ⇒ `key` 不得含 `&` / `=`（它们会把 URL 的查询串切开，服务端收到的键名与用户写的不同）。
 *   · `BODY` ⇒ `key` 不得是 JSON-RPC 请求对象的保留成员（`jsonrpc`/`id`/`method`/`params`）——
 *     顶层额外字段本身是**可行的**（`verify:mcp-client` 的 H 组有线级取证），但撞上保留键
 *     会把报文语义毁掉（覆盖掉 `method` ⇒ 服务端按"未知方法"处理）。
 * 另加一条与注入位置无关的：**同一模板内 `key` 不得重复**（`superRefine` + `addIssue({path})`
 * 让报错精确指到 `['credentialSchema', i, 'key']`，P0-1-23 的手法）。
 *
 * ⚠️ **两条刻意的边界（不是遗漏）**：
 *   · 判重按 key **字面**比较（若按忽略大小写判，`tenant_id` 与 `Tenant_Id` 会被误判成重复）。
 *     代价是 HEADER 的大小写变体（`Token` 与 `token` 在 HTTP 语义上是同一个头）本阶段不拦。
 *   · `QUERY` 只拦 `&` / `=`（文档口径），key 里的空白 / `#` / `%` 不在这里判 —— 注入端统一百分号编码。
 *
 * ⚠️ **与"缓存该不该清"是两件事、两个判据**（别互相合并）：服务层用 `sameJson` 判
 * "模板**整体**有没有变"（连 `label` 改了也清缓存）；`diffCredentialSchema` 判的是
 * "**已存凭据会受什么影响**"（只有"增/删/换注入位置"这三种 key 级的改动才算）。两者对同一份
 * 输入给出**不同**的结论是**对的**，差别写在两处的注释里。
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

/** 凭据参数名的上限（列没有、是渲染与可读性的口径；与 `label` 同长） */
export const MCP_CREDENTIAL_KEY_MAX = 64

/**
 * **平台自己要发的请求头**（`HEADER` 注入的 `key` 不得占用它们）。
 *
 * 为什么必须在模板层拦：用户取一个叫 `accept` 的参数，注入时会把平台的 `Accept` 覆盖掉，
 * 而 Streamable HTTP 的**响应形态**（回 JSON 还是回 SSE）正是靠那个头谈出来的 ——
 * 症状是"这个 server 的凭据一配上，工具就调不动了"，而报错会指向上游（P0-2-7 坑预判 1）。
 * 名单按**小写**比较（HTTP 头名不区分大小写）。
 */
export const MCP_RESERVED_HEADER_NAMES: readonly string[] = [
  'accept',
  'content-type',
  'content-length',
  'host',
  // 这两个是 Streamable HTTP 传输层自己的；占用了就等于把会话与协议协商搞坏
  'mcp-session-id',
  'mcp-protocol-version',
]

/**
 * JSON-RPC 2.0 请求对象的**保留成员**（`BODY` 注入的 `key` 不得占用它们）。
 *
 * ⚠️ 按**字面**比较：JSON 的键区分大小写，`Method` 与 `method` 是两个键，前者不会覆盖后者。
 * ⚠️ 键名集合只有这四个 —— **响应**对象里的 `result`/`error` 不在其中（我们发的是请求）。
 */
export const MCP_JSONRPC_RESERVED_KEYS: readonly string[] = ['jsonrpc', 'id', 'method', 'params']

/**
 * 合法的 HTTP 头名（RFC 7230 的 `token`）：`tchar` 不含空格、冒号、引号、括号、逗号、
 * 斜杠、以及任何非 ASCII 字符。⚠️ 用**正则**而不是"不含空白"这类粗略判据 ——
 * `X-User Token` 与 `X-User:Token` 都会在注入时被 fetch/undici 直接拒绝（或更糟：静默截断）。
 */
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

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

// ───────────────────────────── 凭据模板（形状 + P0-2-3 的深度校验）─────────────────────────────

/**
 * 凭据参数模板的一行（`02` §九：`{ key, label, type, inject, required?, placeholder? }`）。
 *
 * ⚠️ **这里只有"形状"**（键齐不齐、长度、取值域）。`key` 的**合法性按注入位置分**、
 * 以及"同一模板内不得重复"这类**语义层**规则在 {@link credentialSchemaSchema} 的 `superRefine`
 * 与 {@link validateCredentialSchema} 里（两者共用同一份实现，见下）。
 */
export const credentialSchemaEntrySchema = z.object({
  /** 参数名（HEADER 里是头名、QUERY 里是查询键、BODY 里是顶层键） */
  key: z
    .string({ required_error: '请填写凭据参数名' })
    .trim()
    .min(1, '请填写凭据参数名')
    .max(MCP_CREDENTIAL_KEY_MAX, `凭据参数名最多 ${MCP_CREDENTIAL_KEY_MAX} 个字符`),
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

// ───────────────────────────── 深度校验（P0-2-3）─────────────────────────────

/**
 * 一条**深度校验**的结论。
 *
 * ⚠️ `path` 是**相对模板数组**的（`[1, 'key']` 表示"第 2 行的 key"）—— 调用方自己拼前缀
 * （zod 的 `superRefine` 会自动把外层的 `credentialSchema` 拼上去，见 `verify:app` 的断言）。
 * 这是 `02` 的字段级报错口径：接口只回 `data.fields[].path`，前端按 path 定位到输入框。
 */
export interface CredentialSchemaIssue {
  path: (string | number)[]
  message: string
}

/** {@link validateCredentialSchema} 的结论：**只会有一个方向**（`ok` 是判别式） */
export type CredentialSchemaValidation =
  | { ok: true }
  | { ok: false; issues: CredentialSchemaIssue[] }

/**
 * 语义层的三条规则 —— **唯一实现**（`credentialSchemaSchema` 的 `superRefine` 与
 * {@link validateCredentialSchema} 都调它，别再写第二份）。
 *
 * 入参已经过 {@link credentialSchemaEntrySchema}：**形状错的行不会走到这里**
 * （否则一条 `inject: 'COOKIE'` 会同时报"取值域错"与一串次生的语义错，把真正的错淹没）。
 * 因此这里要显式带上原始下标（`index`）—— 过滤之后下标就没了。
 */
function credentialSchemaDeepIssues(
  entries: readonly { index: number; entry: CredentialSchemaEntry }[],
): CredentialSchemaIssue[] {
  const issues: CredentialSchemaIssue[] = []
  /** key → 首次出现的下标（判重按 key **字面**，见文件头 ④ 的边界说明） */
  const firstSeenAt = new Map<string, number>()

  for (const { index, entry } of entries) {
    const { key, inject } = entry
    if (inject === 'HEADER') {
      if (MCP_RESERVED_HEADER_NAMES.includes(key.toLowerCase())) {
        issues.push({
          path: [index, 'key'],
          message: `「${key}」是平台自己要用到的请求头，不能作为凭据参数名（换个名字，例如 X-User-Token）`,
        })
      } else if (!HTTP_HEADER_NAME_RE.test(key)) {
        issues.push({
          path: [index, 'key'],
          message: 'HTTP 头名不能含空格、冒号或非 ASCII 字符（只能用小写/大写字母、数字与 !#$%&\'*+-.^_`|~）',
        })
      }
    } else if (inject === 'QUERY') {
      if (key.includes('&') || key.includes('=')) {
        issues.push({
          path: [index, 'key'],
          message: 'URL 查询参数名不能含 `&` 或 `=`（它们会把查询串切开，服务端收到的键名与这里写的不同）',
        })
      }
    } else if (MCP_JSONRPC_RESERVED_KEYS.includes(key)) {
      // BODY：顶层额外字段本身可行（H 组有取证），但撞上保留键会覆盖报文语义
      issues.push({
        path: [index, 'key'],
        message: `「${key}」是 JSON-RPC 报文的保留字段，作为 BODY 参数会把报文本身覆盖掉`,
      })
    }

    const first = firstSeenAt.get(key)
    if (first === undefined) firstSeenAt.set(key, index)
    else {
      issues.push({ path: [index, 'key'], message: `参数名「${key}」与第 ${first + 1} 个参数重复` })
    }
  }
  return issues
}

/**
 * 凭据模板的**深度校验**（形状 + 语义），**永不抛错** —— 独立入口，不依赖 zod 的解析上下文。
 *
 * 与 {@link credentialSchemaSchema} 的分工：那条路径上形状由 zod 自己报（`superRefine` 里
 * 只补语义），这条路径（本函数）自己要**两样都做**，因此适合"手上只有一份 `unknown`"的调用方
 * （从 jsonb 读出来的、或者将来别的非 HTTP 入口）。
 *
 * ⚠️ **不要拿它当读取端的兜底**：读取端要的是 {@link normalizeCredentialSchema}（逐条过滤、
 * 只求"能渲染"）；本函数是**写端的闸门**（有错就要 400）。
 */
export function validateCredentialSchema(raw: unknown): CredentialSchemaValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, issues: [{ path: [], message: '凭据参数模板必须是一个数组' }] }
  }
  const issues: CredentialSchemaIssue[] = []
  if (raw.length > MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES) {
    issues.push({
      path: [],
      message: `凭据参数最多 ${MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES} 个`,
    })
  }

  const valid: { index: number; entry: CredentialSchemaEntry }[] = []
  raw.forEach((rawEntry, index) => {
    const parsed = credentialSchemaEntrySchema.safeParse(rawEntry)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: [index, ...issue.path], message: issue.message })
      }
      return
    }
    valid.push({ index, entry: parsed.data })
  })

  issues.push(...credentialSchemaDeepIssues(valid))
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

/**
 * 凭据模板整体：**数组**（不是对象）—— 顺序即界面顺序，刻意保留（P0-2-3 坑预判 4）。
 *
 * `superRefine` 挂在**数组**上（不是每条上）：判重是**跨行**的，逐条 refine 看不到别的行。
 * ⚠️ 形状错由 `.max()` 与逐条 schema 自己报，这里**只补语义**（见 `credentialSchemaDeepIssues`），
 * 否则同一个错会被报两遍（前端会看到两行一模一样的红字）。
 */
export const credentialSchemaSchema = z
  .array(credentialSchemaEntrySchema)
  .max(MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES, `凭据参数最多 ${MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES} 个`)
  .superRefine((entries, ctx) => {
    for (const issue of credentialSchemaDeepIssues(
      entries.map((entry, index) => ({ index, entry })),
    )) {
      // ⚠️ path 相对**本数组**；zod 会把外层的 `credentialSchema` 拼上去
      //    （实测：`[1,'key']` ⇒ `['credentialSchema',1,'key']` ⇒ 接口里 `body.credentialSchema.1.key`）
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message })
    }
  })
export type CredentialSchema = z.infer<typeof credentialSchemaSchema>

// ───────────────────────────── 模板变更的影响（P0-2-3）─────────────────────────────

/**
 * 两个模板之间的**key 级**差异（`06` P0-2-3：被移除 / 被新增 / 被改注入位置）。
 *
 * ⚠️ **只按 key 判，不看 `label`/`required`/`placeholder`** —— 改文案对"已存的值"没有任何影响，
 * 把它算进来只会让用户收到一堆"某某参数受影响"的无意义警告。
 * ⚠️ **顺序不算改动**：模板是数组、顺序即界面顺序，但"换了个位置"不该被报成增删
 * （P0-1-23 第 ④ 条"集合语义判等"的同源口径）。
 * ⚠️ 判重与判差异都用 key 的**字面**（见文件头 ④）：把 `Token` 改名成 `token` 会被如实报成
 * "移除 + 新增"—— 那正是要让用户看到的（他改的确实是一个"新键"）。
 *
 * 三个数组的**顺序都取输入顺序**（`removedKeys`/`retargetedKeys` 取旧模板序、
 * `addedKeys` 取新模板序）：纯函数要可断言，顺手也让提示读起来跟表单一个顺序。
 */
export interface CredentialSchemaDiff {
  /** 旧模板有、新模板没有的 key（"已存凭据里那些值不会再被注入出去"） */
  removedKeys: string[]
  /** 新模板有、旧模板没有的 key（"未配置清单里会多出它"） */
  addedKeys: string[]
  /** 两边都有、但 `inject` 位置变了的 key（值不用重填，但它被注入到哪里变了） */
  retargetedKeys: string[]
}

/** 按 key 建索引（**首次出现**为准；正常模板不会有重复，重复已被写端拦住） */
function indexByKey(schema: readonly CredentialSchemaEntry[]): Map<string, CredentialSchemaEntry> {
  const index = new Map<string, CredentialSchemaEntry>()
  for (const entry of schema) if (!index.has(entry.key)) index.set(entry.key, entry)
  return index
}

/**
 * 模板变更的 key 级差异（**纯函数**，见 {@link CredentialSchemaDiff} 的四条口径）。
 *
 * ⚠️ 与"缓存该不该清"（服务层的 `sameJson` 整体比较）**刻意是两个判据**：
 * 那边的答案是"整体变没变"（连 `label` 改了也要清缓存），这边的答案是"**已存凭据会受什么影响**"。
 * 同一份输入得出不同结论是**对的**，别为了"统一"把它们合并。
 */
export function diffCredentialSchema(
  oldSchema: readonly CredentialSchemaEntry[],
  newSchema: readonly CredentialSchemaEntry[],
): CredentialSchemaDiff {
  const before = indexByKey(oldSchema)
  const after = indexByKey(newSchema)
  const removedKeys: string[] = []
  const retargetedKeys: string[] = []
  for (const [key, entry] of before) {
    const next = after.get(key)
    if (next === undefined) removedKeys.push(key)
    else if (next.inject !== entry.inject) retargetedKeys.push(key)
  }
  const addedKeys = [...after.keys()].filter((key) => !before.has(key))
  return { removedKeys, addedKeys, retargetedKeys }
}

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
 *
 * ⚠️ 它**不跑语义层校验**（`credentialSchemaDeepIssues`）：库里已经存着的数据即使"key 是个
 * 保留头名"也照样要下发（否则用户的表单会凭空少一行，而他根本改不了那个事实）。写端的闸门是
 * {@link credentialSchemaSchema} 与 {@link validateCredentialSchema}。
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
 * **一次模板变更对"已存凭据"的影响**（`06` P0-2-3 的验收门槛 3）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① `affectedCredentials` 本批**恒为 `null`** —— 凭据表属 P0-2-4
 * ─────────────────────────────────────────────────────────────────────
 * 它是"值里含 `removedKeys` 之一的凭据条数"，而 `mcp_credentials` 表要到 **P0-2-4** 才建。
 * 这里**刻意留白而不是填 0**：`0` 会被读成"**没有凭据受影响**"（一句关于一个还不存在的功能的
 * 断言），而后端此刻根本没有能力回答这个问题。**说不出来的数字宁可留白，也不要编一个**
 * （P0-1-34/35 第 ⑦ 条的同一条原则）。
 * ⇒ **接回点（P0-2-4 兑现）**：建表后把 `null` 换成真数（数 `values` 里含 `removedKeys` 的行）。
 * `verify:app` 里有一条**守着"它现在必须是 null"**的断言，P0-2-4 落地时**翻转**它即可
 * （同 §七"刻意未注册型断言的保质期"的既有套路）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 只提示、**永不自动清理**
 * ─────────────────────────────────────────────────────────────────────
 * 模板删掉一个 key 时**绝不能**顺手把用户已填的值删掉（`06` P0-2-3 坑预判 2）：用户可能只是
 * 临时改错了模板，而"值没了"是**不可逆**的 —— 他什么都没做，凭据却没了。真要清理由用户
 * 在凭据页自己点（P0-2-4 的 `DELETE`）。
 * ⇒ 这个对象存在的唯一理由是**让前端能说一句人话**（"以下参数已从模板移除，已填的值不会被使用，
 * 如不再需要请到「我的凭据」里清理"）。
 */
export const credentialSchemaImpactSchema = z.object({
  /** 旧模板有、新模板没有的 key（顺序 = 旧模板顺序） */
  removedKeys: z.array(z.string()),
  /** 新模板有、旧模板没有的 key（顺序 = 新模板顺序） */
  addedKeys: z.array(z.string()),
  /** 两边都有、但注入位置变了的 key（顺序 = 旧模板顺序） */
  retargetedKeys: z.array(z.string()),
  /** 受影响的已存凭据条数；**本批恒 `null`**（见上 ①，凭据表属 P0-2-4） */
  affectedCredentials: z.number().int().min(0).nullable(),
})
export type CredentialSchemaImpact = z.infer<typeof credentialSchemaImpactSchema>

/**
 * `diff` → 契约里的 impact；**空 diff ⇒ `null`**。
 *
 * 为什么把"空 ⇒ null"收在这里而不是让调用方各判一次：`null` 在这份契约里只有一个含义 ——
 * **"本次没有任何需要提示的影响"**（既包括没提交模板，也包括提交了一份与现状等价的模板）。
 * 让"三个数组都空"的形态在线上出现，前端就得多写一个 `length === 0` 的分支，
 * 而那条分支与 `null` 分支做的事一模一样（P0-1-21 的"同一份数据两种形状"）。
 */
export function credentialSchemaImpactOf(diff: CredentialSchemaDiff): CredentialSchemaImpact | null {
  if (
    diff.removedKeys.length === 0 &&
    diff.addedKeys.length === 0 &&
    diff.retargetedKeys.length === 0
  ) {
    return null
  }
  // ⚠️ `affectedCredentials` 的**唯一**赋值点就在这里（本批恒 null，见 schema 的注释）
  return { ...diff, affectedCredentials: null }
}

/**
 * `PATCH /api/mcp/servers/:id` 的响应：**裸 item + 本次模板变更的影响**。
 *
 * 与 `POST /` 的 `{server,test}` **同族**：`McpServerItem` 仍是全端点唯一形状，而
 * "本次请求特有的一条提示"不进 item（否则等于承认同一份数据有两种形状 —— P0-2-2 定案 ② 的
 * 同一条理由）。
 *
 * ⚠️ **它是刻意的一次契约变更**（P0-2-2 时 PATCH 回的是**裸 item**）：加 `credentialSchemaImpact`
 * 只能走这条"复合响应"的路，没有第三种既不污染 item 又能把提示带回来的写法。
 * ⚠️ `null` = 本次没有需要提示的影响（没提交模板 / 提交了但等价），**不是**"没有模板"。
 */
export const updateMcpServerResultSchema = z.object({
  server: mcpServerItemSchema,
  credentialSchemaImpact: credentialSchemaImpactSchema.nullable(),
})
export type UpdateMcpServerResult = z.infer<typeof updateMcpServerResultSchema>

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
 *
 * ⚠️ `credentialSchema` 是**整体替换**（数组语义，"提交什么就是什么"）且**深度校验在 schema 层**
 * （P0-2-3：按 `inject` 判 `key`、同模板内判重，报错 path 精确到 `[i,'key']`）——
 * 非法模板**进不到服务层**。而"这次变更对已存凭据有什么影响"由**响应**里的
 * {@link updateMcpServerResultSchema} 带回（**只提示，绝不自动清理**）。
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
