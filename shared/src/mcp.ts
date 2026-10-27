/**
 * MCP server 契约（P0-2-2 起；`02` §三 + §4.7 + §九，`06` §四 4.0 / 4.2 / 4.3，`01` §3.6，`03` §4.4）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：**建/看登录即可；改/删 = 注册者（`created_by`）+ ADMIN**（⚠️ P0-2-12 改过口径）
 * ─────────────────────────────────────────────────────────────────────
 * **原文（P0-2-2 定的"第五族"）是"`/api/mcp/**` 一律登录即可、`mcp_servers` 没有 owner 列收窄"**
 * —— 那是 `01` 决策 22"全员可注册"的直接推论。**2026-09-24（P0-2-12）用户改了口径**：
 * `created_by` 升为**权限判据**（⇒ 本族从"与知识库同族"变成"**与 `agents` 同族**"）。三段切分：
 *   · **建 / 看**（`GET`、`POST /api/mcp/servers`）—— **登录即可**（不变）；
 *   · **改 / 删**（`PATCH`、`DELETE /:id`）—— **注册者 + ADMIN**，判据 {@link canEditMcpServer}；
 *   · **测试 / 工具列表**（`POST /:id/test`、`GET /:id/tools`）—— **登录即可**，它们是"**使用**"
 *     而不是编辑（不写任何人的东西，只刷 server 级的 `tool_cache` / `status`）。
 * ⚠️ 凭据那几条路径（P0-2-4）的收窄**不在角色上、而在 `user_id` 上**（第四族同源，ADMIN 无后门），
 * 与本节**是两个判据**，别混。
 * ⚠️ **`created_by` 同时是"探测主语"**（P0-2-12）：测试 / 工具列表用**注册者**的凭据连上游
 * （`mcpServer.service.ts#probeServer`），而 `tools/call` 仍用**调用者**的凭据。理由：`tool_cache`
 * 是 **server 级共享**的 ⇒ 主语必须**唯一确定**，不能是"谁点的测试"（那会造出
 * "谁先点过测试、别人的列表就是谁的视角"的**串用户** —— 正是 P0-2-5 当初定"不带凭据"要挡的东西）。
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
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑤ 凭据**值**（P0-2-4）：`PUT` 合并 / 只有 key 与 hasValue 出网 / AAD 绑 (server,user,key)
 * ─────────────────────────────────────────────────────────────────────
 * 与 ④ 的模板是两层不同的东西：模板是**注册者**定义的表单（人人可见），值是**每个用户**自己填的
 * 令牌（只进不出）。四条口径：
 *   · **`PUT` 是合并语义**（只动提交里出现的 key），与 P0-1 的 `components`（整体替换）**刻意相反**
 *     —— 分辨方式只有一个：**不可回填的字段只能合并**。值不下发（连掩码都没有）⇒ 整体替换
 *     必然静默清空用户没填的 key。见 {@link putMyCredentialBodySchema}。
 *   · **出网只有 `key` + `hasValue`**（{@link mcpCredentialFieldSchema}），**没有值、没有掩码**：
 *     Provider Key 的掩码是为了"管理员确认没配错"，而这是每个人自己的令牌 —— 下发掩码收益为零。
 *   · **AAD 必须含 `serverId` + `userId`**（后端 `mcpCredentialAad`）：否则"把 A 的密文粘到 B 的行上"
 *     能解开，那"绑定层"的验收就成了摆设（`06` P0-2-4 坑预判 3）。多带 `key` 是为了让值
 *     不能在字段之间搬运；**刻意不带行 id** —— 那样 upsert 就得先有 id（P0-1-10 的 Provider 是
 *     反例：它的 AAD 含 id，所以加密只能发生在拿到 id 之后）。
 *   · **`configured` 按"我是否真的填过值"判**（见 {@link isCredentialConfigured}；2026-10-16 修订：
 *     原判据"必填项齐全"会让没勾必填的模板对**所有人**都返回已配置，等于把别人的凭据当成你的）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑥ 工具列表（P0-2-5）：两种取法 / `refresh` 是白名单 / 缓存是"每个 server 一份"
 * ─────────────────────────────────────────────────────────────────────
 *   · **不传 `refresh` = 纯读缓存**（绝不联网、无副作用）；**`refresh=1` = 真拉一次并落库**。
 *     响应形状**一个字没改** —— `cached` 从 P0-2-2 就在契约里等着今天分叉：拉到 ⇒ `false`；
 *     拉不到但**有缓存** ⇒ `true`（`fetchedAt` 偏旧，这是"不是刚拉的"的**全部**信号）；
 *     **拉不到且缓存也空 ⇒ 502**（**不在**这个形状里，理由见 {@link mcpServerToolsResultSchema}：
 *     `{tools:[]}` 会冒充"这个 server 没有工具"）。
 *   · **`refresh` 是白名单**（{@link mcpServerToolsQuerySchema}）：只收 `1`/`0`/`true`/`false`，
 *     **拼错就 400**。⚠️ 不能用 `z.coerce.boolean()`：`Boolean('0') === true` 会把
 *     `?refresh=0` 判成"要刷新"，而这是**零症状**的（用户以为关掉了，其实每次都联网打上游）。
 *   · **`tools/list` 不带用户凭据** ⇒ 缓存与"谁在看"无关（每个 server 一份、全员共享）。
 *     ⚠️ 这条直接决定 401/403 的文案：**拉列表阶段不能说"去配凭据"**（配了也不会被带上），
 *     而要说"本阶段不支持带用户凭据拉列表"（后端 `mcp/errors.ts` 按 `stage` 分支）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑦ 注入端（P0-2-7）：**模板是唯一的路由表**，模板里没有的 key 一律不注入
 * ─────────────────────────────────────────────────────────────────────
 * `buildCredentialInjection`（backend `mcp/inject.ts`）**只遍历模板**、不遍历用户存了什么 ——
 * 于是"模板里删掉的 key 不会被注入"这件事**结构性成立**，不靠"清理过期值"来保证
 * （P0-2-3 的定案是**只提示、绝不自动清理**；两者必须能同时成立）。
 * ⚠️ 因此 `normalizeCredentialSchema`（读取端）与 `credentialSchemaDeepIssues`（写端）的分工
 * 在注入端**必须各自被尊重**：注入端既不能因语义问题丢行（那会让界面少一行），
 * 也不能把不合法/保留名的 key 真注入出去（见下面三个判据函数）。
 */

import { z } from 'zod'

import { validationMessage } from './i18n/validation.js'

import { canEditAsset, KB_MCP_VISIBILITIES } from './assetAcl.js'
import { type UserRole } from './auth.js'
import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 权限判据（唯一实现）─────────────────────────────

/**
 * "这台 MCP server 我能不能改/删"（P0-2-12；`06` §4.2、`02` §三③、`01` §3.6）。
 *
 * 规则与 {@link canEditAgent} **逐字同源**（`01` §3.6 的"注册者 + ADMIN"）—— 本函数是**唯一实现**：
 * 服务端判 403 用它、`McpServerItem.canEdit` 也由它算。漏掉"注册者本人"或"ADMIN 也算"
 * 任一半都会立刻红（前者 ⇒ 注册者改不了自己的 server，后者 ⇒ 管理员在界面上没有编辑入口）。
 *
 * ⚠️ 与 `canEditAgent` **刻意不同的一处**：这里**没有 `deletedAt` 那一半**。`mcp_servers` 是
 * **硬删**（`02` §三：没有 `deleted_at` 列）⇒ 删掉的 server 就是不存在（404），
 * 不存在"软删之后还能读到一个不能再编辑的行"这种中间态。
 *
 * ⚠️ 它**不参与**"测试 / 工具列表"的判定（见文件头 ①）：那两个端点是**使用** —— 全员可用，
 * 只是**用注册者的凭据**连上游。别顺手把本函数用到那两条路由上：那会造出
 * "server 建完就没人能测了"（注册者离职/停用 ⇒ 一台能用的 server 永远显示不了工具）。
 */
export function canEditMcpServer(
  server: { createdBy: string },
  viewer: { id: string; role: UserRole },
): boolean {
  // P1-13：判据统一收口到 `assetAcl`（可见性不影响编删权）
  return canEditAsset({ ownerId: server.createdBy }, viewer)
}

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
 * 工具名（下发给模型的 OpenAI `function.name`）的长度上限（**P0-2-6 定案**）。
 *
 * 取 64 而不是"各家 provider 里最长的那一档"：名字是**跨协议共用**的（`02` §9.7），
 * 按最紧的一档算一次，将来接别家协议时不用重算。⚠️ 截断**只发生在产出侧**、且截断后
 * 仍保证唯一（截断 + 序号）—— 若放任上游去截，模型回 `tool_calls` 时给的名字会与我们
 * 登记的名字对不上，而那种失败**没有任何报错**（只是"找不到工具"）。
 *
 * 字符集口径同一条：`[A-Za-z0-9_-]`（见 `mcp/toolSchema.ts#sanitizeToolName`）。
 */
export const MCP_TOOL_NAME_MAX = 64

/**
 * 工具名前缀：`mcp_{slug}_{toolName}`（`02` §九）。
 *
 * ⚠️ 前缀是**必须的**：同一次请求里既有 MCP 工具（P0-2）也可能有平台内置工具（P0-3），
 * 前缀让"这个名字属于哪一族"一眼可判，也顺手避开了与 `Object.prototype` 同名键
 * （反向映射表是个普通对象）。
 */
export const MCP_TOOL_NAME_PREFIX = 'mcp_'

/**
 * 工具**描述**下发给模型时的长度上限（**P0-2-6 定案**）。
 *
 * 描述是进上下文的（每个工具一份），一个啰嗦的工具说明会直接挤掉对话本身；
 * 1024 是"够写清用途与注意事项"的经验值。⚠️ 按**码点**截断（不是 UTF-16 码元）——
 * `String.prototype.slice` 会把代理对劈成两半、产出非法字符串，而这一层毫无报错（P0-1-18）。
 */
export const MCP_TOOL_DESCRIPTION_MAX = 1024

/**
 * 非 object 根 schema 的**包装键名**（P0-2-6 坑预判 3 的处置）。
 *
 * OpenAI 的 `parameters` 必须是 object 根，而 MCP 工具的 `inputSchema` 理论上可以是
 * 任意 JSON Schema ⇒ 遇到非 object 根时包成 `{ type:'object', properties:{ input: <原 schema> } }`。
 * ⚠️ 这是一个**已知边界**：包装后模型会传 `{ input: … }`，而那个工具真正想要的是顶层标量 ⇒
 * 这次调用**会失败**。之所以仍然包（而不是丢弃该工具）：包住至少"参数提示里的约束还在"，
 * 用户能从工具卡片看到原始 schema 并去修服务端；丢了就只剩"这个工具神秘消失"。
 */
export const MCP_TOOL_WRAPPER_KEY = 'input'

// ───────────────────────────── 工具网关（渐进披露，P1-19）─────────────────────────────
//
// 背景：Agent 可以绑**多台** MCP server、每台几十个工具 ⇒ 若把全部工具一次性放进 `tools`
// 下发给模型，上下文会被几十上百个工具定义挤爆，模型挑工具的准确率也会掉。
// 处置：**工具网关** —— 数量多时只下发两个固定工具（list / call），其余工具**按需发现**；
// 少量工具（或 Agent 明确标的"常驻工具"）仍直接下发。策略的纯函数在
// `backend/src/orchestrator/mcpGatewayModel.ts`，执行体在 `mcpGatewayTools.ts`。

/**
 * 「列出 / 搜索 MCP 工具」内置工具名（工具网关的**发现**侧）。
 *
 * ⚠️ 它**带 `mcp_` 前缀**，与真实 MCP 工具（`mcp_{slug}_{tool}`）同形 ⇒ **不能靠前缀**
 * 区分网关工具与真实工具，必须按**精确名字**判（见 {@link isMcpGatewayToolName}）。
 * 为避免真实工具撞上它，装配时会先把这两个名字塞进跨 server 的「已占用名字」集合
 * （`mcp/toolSchema.ts#disambiguate` 的 `taken`）—— 于是真实工具会被逼成 `mcp_list_tools-2` 之类。
 */
export const MCP_LIST_TOOLS_TOOL_NAME = 'mcp_list_tools'

/**
 * 「调用 MCP 工具」内置工具名（工具网关的**执行**侧）。
 *
 * 模型先用 {@link MCP_LIST_TOOLS_TOOL_NAME} 拿到工具名，再用本工具按名调用。参数 `name`
 * 是**下发给模型的名字**（`mcp_{slug}_{tool}`；沙箱里是 `mcp_{alias}_{tool}`），
 * `arguments` 是那台工具自己的参数对象。
 */
export const MCP_CALL_TOOL_TOOL_NAME = 'mcp_call_tool'

/** 两个网关工具名（装配时用于占用名字、分流时用于识别） */
export const MCP_GATEWAY_TOOL_NAMES = [MCP_LIST_TOOLS_TOOL_NAME, MCP_CALL_TOOL_TOOL_NAME] as const

/** 这个名字是不是网关工具（**精确匹配**，见 {@link MCP_LIST_TOOLS_TOOL_NAME} 的注释） */
export function isMcpGatewayToolName(name: string): boolean {
  return (MCP_GATEWAY_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * `mcp_list_tools` 一次最多返回多少条工具。
 *
 * 它是"**给模型看的目录**"、不是"必须列全"：超出的部分明确写「其余 N 个未列出，请用 query
 * 缩小范围」，让模型自己收敛（同 `knowledgeTools.ts#KNOWLEDGE_LIST_MAX_DOCS` 的取舍）。
 */
export const MCP_LIST_TOOLS_MAX_RESULTS = 100

/** 目录里**每条工具**描述的截断上限（码点）：目录要短，完整描述在真的调用时才有意义 */
export const MCP_LIST_TOOLS_ENTRY_DESCRIPTION_MAX = 160

/** `mcp_list_tools` 的入参（都可选：不给 query 就列全部，不给 server 就跨全部 server） */
export const mcpListToolsArgsSchema = z.object({
  /** 只看某一台 server（收 server 名或 id；见执行体） */
  server: z.string().trim().max(MCP_SERVER_NAME_MAX).optional(),
  /** 关键词（按工具名与描述做包含匹配） */
  query: z.string().trim().max(200).optional(),
})

/** `mcp_call_tool` 的入参（`name` 必填；`arguments` 省略 = 无参调用） */
export const mcpCallToolArgsSchema = z.object({
  name: z.string().trim().min(1),
  arguments: z.record(z.unknown()).optional(),
})

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
 * **单个凭据值**的上限（P0-2-4）。
 *
 * 定 4096 的理由：凭据就是"一次 HTTP 请求里能带出去的东西"——令牌 / JWT / 签名（JWT 带一堆
 * 声明也很少过 2KB）/ API Key，4096 够用且能挡住"把整个证书或私钥贴进来"。
 * ⚠️ 它是一个**明文长度**的口径，不是密文列宽（`values` 是 jsonb，没有列宽）。
 * ⚠️ 校验按**字符数**（`z.string().max`）而不是字节：一个 4096 字符的中文串编成 UTF-8 是 12KB，
 * 但那种值本来就不可能是一个令牌 —— 逐字节判只会让报错文案更难解释。
 */
export const MCP_CREDENTIAL_VALUE_MAX = 4096

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

// ───────────────────────────── 注入前的三条判据（P0-2-7 复用，唯一实现）─────────────────────────────
//
// ⚠️ **这三条判据有两个消费方、必须只有一份实现**：
//   · **写端闸门**（`credentialSchemaDeepIssues`）—— 模板落地的**那一刻**拦下不合法的 key；
//   · **注入端**（backend `mcp/inject.ts`）—— 库里可能**已经存着**不合法的 key（P0-2-3 落地前
//     存进去的、或手工改库的），而 `normalizeCredentialSchema` **刻意不跑语义层校验**
//     （读取端既不报错也不丢行）。⇒ 注入端必须**再判一次并跳过**。
// 两处各写一份的后果与 P0-1-29 的 `PASSWORD_ALPHABET` 一模一样：谁改了一处，
// 另一处就**静默腐烂**（而这里腐烂的表现是"某个凭据悄悄不生效"）。

/** `key` 是不是合法的 HTTP 头名（RFC 7230 `token`）；**唯一实现**（写端与注入端共用） */
export function isValidHttpHeaderName(name: string): boolean {
  return HTTP_HEADER_NAME_RE.test(name)
}

/** `key` 是不是平台自己要发的头（**按小写比较** —— HTTP 头名不区分大小写） */
export function isReservedHeaderName(name: string): boolean {
  return MCP_RESERVED_HEADER_NAMES.includes(name.toLowerCase())
}

/** `key` 是不是 JSON-RPC **请求**对象的保留成员（**按字面**比较 —— JSON 的键区分大小写） */
export function isReservedJsonRpcKey(key: string): boolean {
  return MCP_JSONRPC_RESERVED_KEYS.includes(key)
}

/** `key` 是不是会切开 URL 查询串的字符组合（`QUERY` 注入的判据） */
export function hasQueryDelimiter(key: string): boolean {
  return key.includes('&') || key.includes('=')
}

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
    .string({ required_error: validationMessage('validation.mcp.credentialKeyRequired') })
    .trim()
    .min(1, validationMessage('validation.mcp.credentialKeyRequired'))
    .max(
      MCP_CREDENTIAL_KEY_MAX,
      validationMessage('validation.mcp.credentialKeyTooLong', { max: MCP_CREDENTIAL_KEY_MAX }),
    ),
  /** 给填值的人看的说明（`03` §4.5 的表单逐行显示它） */
  label: z
    .string({ required_error: validationMessage('validation.mcp.credentialLabelRequired') })
    .trim()
    .min(1, validationMessage('validation.mcp.credentialLabelRequired'))
    .max(64, validationMessage('validation.mcp.credentialLabelTooLong', { max: 64 })),
  /**
   * 取值类型。**P0 只支持 `string`**（`02` §九 原文如此）—— 不做 number/boolean/file。
   * 接回点：`credentialValueSchema` 上按 `type` 分支，不影响别处。
   */
  type: z.literal('string', {
    errorMap: () => ({ message: validationMessage('validation.mcp.credentialTypeOnlyString') }),
  }),
  inject: z.enum(CREDENTIAL_INJECT_LOCATIONS, {
    errorMap: () => ({
      message: validationMessage('validation.mcp.credentialInjectAllowed', {
        allowed: CREDENTIAL_INJECT_LOCATIONS.join('/'),
      }),
    }),
  }),
  /** 是否必填（P0-2-4 用来判"整体是否已配置"）；省略 = 非必填 */
  required: z.boolean().optional(),
  /** 输入框的占位提示（纯展示） */
  placeholder: z
    .string()
    .trim()
    .max(128, validationMessage('validation.mcp.credentialPlaceholderTooLong', { max: 128 }))
    .optional(),
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
      if (isReservedHeaderName(key)) {
        issues.push({
          path: [index, 'key'],
          message: validationMessage('validation.mcp.reservedHeaderKey', { key }),
        })
      } else if (!isValidHttpHeaderName(key)) {
        issues.push({
          path: [index, 'key'],
          message: validationMessage('validation.mcp.invalidHttpHeaderName'),
        })
      }
    } else if (inject === 'QUERY') {
      if (hasQueryDelimiter(key)) {
        issues.push({
          path: [index, 'key'],
          message: validationMessage('validation.mcp.queryDelimiter'),
        })
      }
    } else if (isReservedJsonRpcKey(key)) {
      // BODY：顶层额外字段本身可行（H 组有取证），但撞上保留键会覆盖报文语义
      issues.push({
        path: [index, 'key'],
        message: validationMessage('validation.mcp.reservedJsonRpcKey', { key }),
      })
    }

    const first = firstSeenAt.get(key)
    if (first === undefined) firstSeenAt.set(key, index)
    else {
      issues.push({
        path: [index, 'key'],
        message: validationMessage('validation.mcp.duplicateKey', { key, index: first + 1 }),
      })
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
    return { ok: false, issues: [{ path: [], message: validationMessage('validation.mcp.schemaNotArray') }] }
  }
  const issues: CredentialSchemaIssue[] = []
  if (raw.length > MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES) {
    issues.push({
      path: [],
      message: validationMessage('validation.mcp.schemaTooMany', { max: MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES }),
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
  .max(
    MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES,
    validationMessage('validation.mcp.schemaTooMany', { max: MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES }),
  )
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

// ───────────────────────────── 凭据值（P0-2-4）─────────────────────────────

/**
 * `values`（jsonb）里**真正有值**的那些 key —— 读取端的唯一入口，**永不抛错**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么"有值"要单独定义，而不是读 `Object.keys(values)`
 * ─────────────────────────────────────────────────────────────────────
 * 「清空某个 key」的语义是**把它从对象里删掉**，而不是存一个空串：
 * `encryptSecret('')` 会得到一个**结构合法**的密文（`v1.<iv>.<tag>.`），
 * 若"键在 = 有值"，清空过的参数会永远显示成"已配置"（`03` §4.5 的 ✓ 是骗人的）。
 * ⇒ 判据统一为"**值是长度 > 0 的字符串**"，空串 / 非字符串一律当"没有值"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 为什么必须过它：`values` 是 jsonb，读出来的东西不保证是我们写的形状
 * ─────────────────────────────────────────────────────────────────────
 * 与 `normalizeCredentialSchema` 同一条理由（手工改库、跨环境导入、半截数据）：
 * 一个 `null` 值会让 `Object.keys` 之外的所有读法在渲染期炸掉。
 *
 * ⚠️ **返回的是集合语义，不是数组顺序**：PG 的 jsonb **会重排键**，所以调用方
 * **不得依赖顺序**（要比就按集合比 / 先 sort）。`verify:app` 有一条断言专门盯这件事。
 */
export function credentialValueKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const keys: string[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') keys.push(key)
  }
  return keys
}

/**
 * **必填、而我还没有值**的 key（顺序 = 模板顺序，便于界面直接渲染提示）。
 *
 * ⚠️ 这是 `configured` 的唯一判据来源，见 {@link isCredentialConfigured}。
 */
export function missingRequiredCredentialKeys(
  schema: readonly CredentialSchemaEntry[],
  presentKeys: Iterable<string>,
): string[] {
  const present = new Set(presentKeys)
  return schema.filter((entry) => entry.required === true && !present.has(entry.key)).map((entry) => entry.key)
}

/**
 * 「我这份凭据算不算配好了」—— **按"我是否真的填过值"判**（2026-10-16 修订）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不再按「必填项齐全」判（原 P0-2-4 口径）
 * ─────────────────────────────────────────────────────────────────────
 * 原判据是 `missingRequiredCredentialKeys(...).length === 0`，于是**注册者没把任何参数勾成必填**时，
 * 每个人（哪怕从没配过）都会被算成「已配置」—— 而 MCP server 是**按人各配一份**的（`(serverId,userId)`），
 * 于是"注册者/admin 配的凭据"看起来像是**对所有人都生效**了。用户 2026-10-16 定案：这一列必须
 * **区分到人**（列表里我到底配没配），故判据改成"**我这边至少有一个（模板内的）值**"。
 *
 * 四条：
 *   · 模板**没有参数**（空模板 / 内网无鉴权服务）⇒ `true`（没有任何东西要他填，不进"未配置"计数）；
 *   · 我有 ≥1 个**模板内**的值 ⇒ `true`（哪怕还有必填项没填齐 —— 那是 `missingKeys` 的事，
 *     界面上仍会提示"还缺 X"，但那不是"我完全没配"）；
 *   · 我没有任何模板内的值 ⇒ `false`（界面显示「未配置」并给"去配置"入口）；
 *   · 只统计**当前模板里还认的 key**：模板里被删掉的 key 即使库里还留着值也不会被注入，
 *     不拿它冒充"我配过了"。
 */
export function isCredentialConfigured(
  schema: readonly CredentialSchemaEntry[],
  presentKeys: Iterable<string>,
): boolean {
  if (schema.length === 0) return true
  const templateKeys = new Set(schema.map((entry) => entry.key))
  for (const key of presentKeys) {
    if (templateKeys.has(key)) return true
  }
  return false
}

/**
 * 模板一行 + **我这边有没有值**（`03` §4.5 的"每个参数一行：label + 密码框 + 已配置 ✓"）。
 *
 * ⚠️ **没有任何"值"的字段**（连掩码都没有，与 Provider Key 的 `apiKeyPreview` 刻意不同）：
 * Provider Key 是**管理员**配的一份、掩码是为了"确认没配错"；而这里是每个用户自己的令牌，
 * 下发掩码等于把"这个人的令牌长什么样"放进了一个更多人可以读到的通道，
 * 收益却是零（他自己知道填了什么）。**有进无出，连影子都不给。**
 */
export const mcpCredentialFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  inject: z.enum(CREDENTIAL_INJECT_LOCATIONS),
  /** 归一化后的必填标记（模板里省略 = 非必填）——界面上用它决定是否标红星 */
  required: z.boolean(),
  /** 我这边这个 key 有没有值（**只有真假，没有值本身**） */
  hasValue: z.boolean(),
  placeholder: z.string().nullable(),
})
export type McpCredentialField = z.infer<typeof mcpCredentialFieldSchema>

/**
 * 一个 server × 我 的凭据状态（`GET /api/mcp/credentials` 的一项 / `PUT` 的响应）。
 *
 * ⚠️ **`fields` 是按"模板"投影的，不是按"我存了什么"**：模板里删掉的 key 即使库里还留着值
 * （P0-2-3 定案：**只提示、绝不自动清理**），也**不出现在这里** —— 它已经不会被注入，
 * 界面不该拿它冒充一个可用参数。清理由用户在 `DELETE` 里自己做。
 * ⚠️ 所以 `hasValue` 的覆盖面是 `credentialValueKeys(values)`（**全部有值的 key**），
 * 而不是 `fields` 里那些（后者只是"模板里还认的"）。
 */
export const mcpCredentialItemSchema = z.object({
  serverId: z.string(),
  /** 冗余带上名字与 slug：凭据页是"按 server 分组的一张表单"，让前端不再去 join `/api/mcp/servers` */
  serverName: z.string(),
  serverSlug: z.string(),
  fields: z.array(mcpCredentialFieldSchema),
  /** 当前模板的必填项里我还没值的（顺序 = 模板顺序）；空 ⇒ `configured:true` */
  missingKeys: z.array(z.string()),
  /** = 「我这边至少有一个（模板内的）值」（见 {@link isCredentialConfigured}；**不是**"必填齐全"、
   *  更不是"表里有没有行"）。⚠️ 它**按人算** —— 同一台 server 对不同人给出不同答案。 */
  configured: z.boolean(),
  /**
   * 我这份凭据最后一次写入时间；`null` = **从没写过**（没有行）。
   * ⚠️ 与 `configured` 大致同向但不完全等价：空模板（无参数）时"从没写过"也是 `configured:true`。
   */
  updatedAt: z.string().nullable(),
})
export type McpCredentialItem = z.infer<typeof mcpCredentialItemSchema>

/**
 * 「未配置的 server」条目（**瘦投影**：`03` §4.5"未配置的 server 置顶提示"只要名字 + 缺哪些 key）。
 *
 * 它是 `items.filter((item) => !item.configured)` 的**派生结论**，服务层一次查询算出两半，
 * 传的仍是同一份事实 —— 不是"同一份数据的第二种形状"（P0-2-2 定案 ② 那条禁的是后者）。
 */
export const mcpUnconfiguredServerSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  serverSlug: z.string(),
  missingKeys: z.array(z.string()),
})
export type McpUnconfiguredServer = z.infer<typeof mcpUnconfiguredServerSchema>

/**
 * `GET /api/mcp/credentials` 的响应：**两面都给**（`06` P0-2-4 验收门槛 5）。
 *
 * ⚠️ **刻意不分页**（与 `/api/models/available` 同为"取全集"型端点，另几个列表端点是"翻页表格"）：
 * 本页是一张**按 server 分组的长表单**，"未配置的置顶提示"必须跨全部 server 成立 ——
 * 一旦分页，"置顶"只对当前页有效（用户翻到第 3 页时提示会凭空消失）。
 * 代价是响应大小随 server 数增长；本仓的规模口径是"几百人的内部系统"（`01` §1.3），
 * server 量级在几十 —— 真到需要分页时（P1）它也不会是"加 offset"就够的（要改成按需展开）。
 */
export const mcpCredentialListResultSchema = z.object({
  /** 全部 server（按录入顺序 `createdAt asc`），每个都带"我这边缺什么" */
  items: z.array(mcpCredentialItemSchema),
  /** `items` 里 `configured:false` 的那些（瘦投影，置顶提示用） */
  unconfigured: z.array(mcpUnconfiguredServerSchema),
})
export type McpCredentialListResult = z.infer<typeof mcpCredentialListResultSchema>

/**
 * `DELETE /api/mcp/credentials/:serverId` 的响应 —— 与其它"删类"端点同形（`{id,name}` 那一族）。
 *
 * ⚠️ 删除是**幂等**的语义选择：本来就没配 ⇒ **404**（与"这个 server 不存在"同码）。
 * 理由：本端点删的是"**我的那份**"，反馈"你没有可删的东西"比"删除成功"更准确 ——
 * 前端点删除时弹的是 Popconfirm，"其实什么都没有"正是它该说的话。
 */
export const removeMyCredentialResultSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
})
export type RemoveMyCredentialResult = z.infer<typeof removeMyCredentialResultSchema>

/**
 * `PUT /api/mcp/credentials/:serverId` 请求体：**合并语义**（只动提交里出现的 key）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 这一条与 P0-1 的 `components`（整体替换）**刻意相反**，别互相"统一"
 * ─────────────────────────────────────────────────────────────────────
 * `06` P0-2-4 坑预判 1：Agent 的组件绑定定为**整体替换**，理由是"省略 = 清空会让前端忘带字段
 * 变成**静默解绑**"。而凭据这里必须**反过来**，理由同样硬：
 * **值不下发**（连掩码都没有）⇒ 前端**根本无从回填** ⇒ 若整体替换，用户只改一个 key 时
 * 提交 `{token:'新值'}` 会把他没填的另一个 key **静默清空**（他什么都没做，值却没了）。
 * ⇒ 两条口径都写在契约注释里（`shared/src/agent.ts` 的 `components` / 本处），
 * 分辨方式：**"不可回填的字段只能合并"**。
 *
 * 三个配套规则：
 *   · **空串 = 清空该 key**（把键从 `values` 里删掉，而不是存一个空密文）；
 *   · **清空整份凭据走 `DELETE /:serverId`**（本端点不接受"清空所有 key 的语义"——
 *     提交空对象是**没有意义的请求**，直接 400，免得它被当成一种"清空"的第二条路）；
 *   · **不在当前模板里的 key ⇒ 400**：存下一个永远不会被注入的值，是给用户一个
 *     "我明明填了"的错觉（且它是**静默**的 —— 注入端只会按模板找 key）。
 */
export const putMyCredentialBodySchema = z.object({
  values: z
    .record(
      z
        .string({ required_error: validationMessage('validation.mcp.credentialValueNotString') })
        .max(
          MCP_CREDENTIAL_VALUE_MAX,
          validationMessage('validation.mcp.credentialValueTooLong', { max: MCP_CREDENTIAL_VALUE_MAX }),
        ),
    )
    .refine((values) => Object.keys(values).length > 0, {
      message: validationMessage('validation.mcp.valuesEmpty'),
    }),
})
export type PutMyCredentialBody = z.infer<typeof putMyCredentialBodySchema>

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
  /**
   * 注册者 id（= **所属人**，`mcp_servers.created_by`）。
   * ⚠️ **P0-2-12 起它是权限判据**（原注释"**留痕**字段、不参与权限判定"已作废，见文件头 ①）。
   */
  createdBy: z.string(),
  /**
   * 注册者**显示名**（昵称优先、回落用户名 —— 同 `AgentItem.creatorName` 的口径）。
   * 列表对**全员**开放 ⇒ 用户必须能看出"这台 server 该找谁去配凭据"，只给一个 uuid 是没有用的。
   */
  creatorName: z.string(),
  /** P1-18：可见范围（**两档**：私有 / 公开；MCP server 不接受「指定用户」） */
  visibility: z.enum(KB_MCP_VISIBILITIES),
  /**
   * P0-2-12：**我能不能改/删这台 server**（判据 = {@link canEditMcpServer}，注册者 + ADMIN）。
   * ⚠️ 由**服务端现算**（它依赖 viewer）—— 前端**不要**自己拿 `createdBy` 跟当前用户 id 比：
   * 那样"ADMIN 也能改"这半条会在界面上消失（页面只认 id 相等，管理员反而没有编辑入口）。
   * 与 `AgentItem.canEdit` / `modelAvailable` 同族：服务端算好的**非表列**字段。
   */
  canEdit: z.boolean(),
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
 * ① `affectedCredentials`：**P0-2-3 留白的那个数，P0-2-4 填上了**
 * ─────────────────────────────────────────────────────────────────────
 * 它是"`values` 里含 `removedKeys` 之一的**已存凭据条数**"（全库口径，不是"我自己的"）。
 * P0-2-3 时 `mcp_credentials` 表还不存在，后端**没有能力**回答 ⇒ 那时恒 `null`
 * （**刻意留白而不是填 0**：`0` 会被读成"没有凭据受影响"这个此刻无法作出的断言）。
 * ⇒ **P0-2-4 建表后兑现**：`credentialSchemaImpactOf` 的第二个参数变成**必填**，
 * `null` 这个取值**从契约里彻底消失**（不再是"nullable 但恒真有值"的死分支）——
 * 说不出来的数字宁可留白，**能说出来的就必须说**。
 * ⚠️ 只有 `removedKeys` 进这个数：`addedKeys` 是"缺值"（没有任何已存的值受影响）、
 * `retargetedKeys` 是"值还在、只是注入到了别处"（改注入位置**不会**让值失效）。
 * 三者里只有"被删掉的 key"会让用户已填的值**再也用不上**。
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
  /**
   * `values` 里含任一 `removedKeys` 的**已存凭据条数**（全库口径）。
   * ⚠️ 它是"**几条凭据里有值会被这次改动废掉**"，不是"几个 key"也不是"几个用户"。
   */
  affectedCredentials: z.number().int().min(0),
})
export type CredentialSchemaImpact = z.infer<typeof credentialSchemaImpactSchema>

/**
 * `diff` → 契约里的 impact；**空 diff ⇒ `null`**。
 *
 * 为什么把"空 ⇒ null"收在这里而不是让调用方各判一次：`null` 在这份契约里只有一个含义 ——
 * **"本次没有任何需要提示的影响"**（既包括没提交模板，也包括提交了一份与现状等价的模板）。
 * 让"三个数组都空"的形态在线上出现，前端就得多写一个 `length === 0` 的分支，
 * 而那条分支与 `null` 分支做的事一模一样（P0-1-21 的"同一份数据两种形状"）。
 *
 * @param affectedCredentials `values` 里含 `removedKeys` 的已存凭据条数（**调用方查库得到**）。
 *   ⚠️ **必填**（P0-2-4 定案）：它是"本函数不做 IO"与"这个数必须真实"之间的取舍 ——
 *   纯函数保持可断言，而"必须给出真数"由签名强制（忘了传就编译不过，
 *   而不是悄悄回一个 `null` 让界面以为"没人受影响"）。
 */
export function credentialSchemaImpactOf(
  diff: CredentialSchemaDiff,
  affectedCredentials: number,
): CredentialSchemaImpact | null {
  if (
    diff.removedKeys.length === 0 &&
    diff.addedKeys.length === 0 &&
    diff.retargetedKeys.length === 0
  ) {
    return null
  }
  return { ...diff, affectedCredentials }
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
 * `?refresh=` 的取值域（**白名单**，`06` P0-2-5 定案）。前两个是"要刷新"。
 *
 * ⚠️ **刻意不用 `z.coerce.boolean()`**：`Boolean('0') === true` —— `?refresh=0` 会被判成
 * "要刷新"，而这种错**零症状**（用户以为关掉了刷新，其实每次请求都联网打上游）。
 * 反过来，放宽成"任意字符串"同样不行：`?refresh=yes` 静默等于不刷新，
 * 用户点了刷新却看到旧列表（又一种零症状的失败）。
 * ⇒ 收窄成白名单，**拼错就 400**（字段级 path 是 `querystring.refresh`，见 `02` §四）。
 *
 * 收 `true`/`false` 是因为前端 `URLSearchParams` 拼出来就是这个形态（`1`/`0` 是 curl 习惯）。
 * 名单与判据挨着放：分成两处写，改一处忘另一处就会静默腐烂。
 */
const MCP_REFRESH_VALUES = ['1', 'true', '0', 'false'] as const
type McpRefreshValue = (typeof MCP_REFRESH_VALUES)[number]

/** 白名单里哪些表示"要刷新"——**唯一**判据，`transform` 复用它（别在别处再写一遍 `=== '1'`） */
function isRefreshRequested(value: McpRefreshValue): boolean {
  return value === '1' || value === 'true'
}

/**
 * `GET /api/mcp/servers/:id/tools` 的查询参数（`06` P0-2-5）。
 *
 * `schema.querystring` 上的 `.default()` + `.transform()` 都会被 `zodValidatorCompiler`
 * 写回 `request.query`（`plugins/errorHandler.ts` 的注释），所以 handler 拿到的是 **boolean**。
 */
export const mcpServerToolsQuerySchema = z.object({
  // ⚠️ 用 `{ message }` 而**不是** `{ errorMap }`：zod v3 的 `processCreateParams` 在
  //    "同时给 `errorMap` 与 `required_error`" 时**模块加载期就抛**（`types.js:50`），
  //    而 `message` 这条短路既够用、又不碰那个雷（enum 的 `invalid_enum_value` 会取它）
  refresh: z
    .enum(MCP_REFRESH_VALUES, { message: validationMessage('validation.mcp.refreshValue') })
    .default('0')
    .transform(isRefreshRequested),
})
export type McpServerToolsQuery = z.infer<typeof mcpServerToolsQuerySchema>

/**
 * `GET /api/mcp/servers/:id/tools` 的响应（**裸对象**，`06` §4.3 定的第五族形态）。
 *
 * 两种取法（P0-2-5 起）：
 *   · **不传 `refresh`** —— 纯读缓存，绝不联网、无副作用；
 *   · **`?refresh=1`** —— 真去拉一次并**落库**（`status` 变 `OK`）。
 *
 * `cached` 的语义 = **这份列表来自 `tool_cache` 列**（而不是本次实时拉取的）：
 *   · 纯读 ⇒ 恒等于 `fetchedAt !== null`；
 *   · `?refresh=1` 且拉成功 ⇒ `false`（`fetchedAt` 就是刚刚那一刻）；
 *   · `?refresh=1` 但拉失败、缓存还在 ⇒ **`true`** —— 这是"你看到的**不是**刚拉的"的**唯一信号**
 *     （`fetchedAt` 会明显偏旧）。⚠️ 刻意**不加** `warning` 之类的字段来复述这件事：
 *     界面按 `cached` + `fetchedAt` 就能画"缓存于 X"，多一个字段等于同一件事两个来源。
 *
 * ⚠️ **拉失败且缓存也空 ⇒ 整个请求 502**（本形状里**没有**"失败字段"）。
 * 理由（`02` §九）：「给不出工具列表」是**请求本身**的失败，与「这个 server 没有工具」
 * （`{tools:[], fetchedAt:'<时刻>', cached:true}`）**必须分得开** ——
 * 后者是一句真话（它确实没工具），前者是一句"我们答不了"。把它做成 200 + 空数组，
 * 界面就只能显示"0 个工具"，而用户会去 MCP server 上找一个其实不存在的配置问题。
 * 这与 `POST /:id/test` **恒 200** 不矛盾：那个端点**有** `{ok:false,error}` 这个合法形态
 * 来承载"连不上"，而这个端点没有。
 */
export const mcpServerToolsResultSchema = z.object({
  tools: z.array(mcpToolDescriptorSchema),
  /** **这份列表被拉到**的时刻（ISO 8601）；从未成功拉过 → `null`（与 `tools:[]` 组合起来才是"从没拉过"） */
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
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
})
export type ListMcpServersQuery = z.infer<typeof listMcpServersQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const mcpServerListResultSchema = offsetPageOf(mcpServerItemSchema)
export type McpServerListResult = z.infer<typeof mcpServerListResultSchema>

// ───────────────────────────── 公共字段 ─────────────────────────────

/** server 名（列 `VARCHAR(128)`） */
const mcpServerNameSchema = z
  .string({ required_error: validationMessage('validation.mcp.serverNameRequired') })
  .trim()
  .min(1, validationMessage('validation.mcp.serverNameRequired'))
  .max(MCP_SERVER_NAME_MAX, validationMessage('validation.mcp.serverNameTooLong', { max: MCP_SERVER_NAME_MAX }))

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
  .string({ required_error: validationMessage('validation.mcp.endpointRequired') })
  .trim()
  .min(1, validationMessage('validation.mcp.endpointRequired'))
  .max(
    MCP_ENDPOINT_URL_MAX,
    validationMessage('validation.mcp.endpointTooLong', { max: MCP_ENDPOINT_URL_MAX }),
  )
  .superRefine((value, ctx) => {
    let protocol: string
    try {
      protocol = new URL(value).protocol
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage('validation.mcp.endpointNotUrl'),
      })
      return
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage('validation.mcp.endpointScheme'),
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
      errorMap: () => ({
        message: validationMessage('validation.mcp.authTypeAllowed', { allowed: MCP_AUTH_TYPES.join('/') }),
      }),
    })
    .optional(),
  credentialSchema: credentialSchemaSchema.optional(),
  /** P1-18：可见范围（**两档**：私有 / 公开）。**可省** ⇒ 服务层按 `PRIVATE`（安全默认） */
  visibility: z
    .enum(KB_MCP_VISIBILITIES, {
      errorMap: () => ({
        message: validationMessage('validation.mcp.visibilityAllowed', {
          allowed: KB_MCP_VISIBILITIES.join('/'),
        }),
      }),
    })
    .optional(),
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
        errorMap: () => ({
        message: validationMessage('validation.mcp.authTypeAllowed', { allowed: MCP_AUTH_TYPES.join('/') }),
      }),
      })
      .optional(),
    /** 整体替换（数组语义，"提交什么就是什么"）；清空提交 `[]` */
    credentialSchema: credentialSchemaSchema.optional(),
    /** P1-18：可见范围（两档：私有 / 公开） */
    visibility: z
      .enum(KB_MCP_VISIBILITIES, {
        errorMap: () => ({
        message: validationMessage('validation.mcp.visibilityAllowed', {
          allowed: KB_MCP_VISIBILITIES.join('/'),
        }),
      }),
      })
      .optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.endpointUrl !== undefined ||
      body.authType !== undefined ||
      body.credentialSchema !== undefined ||
      body.visibility !== undefined,
    { message: validationMessage('validation.common.atLeastOneField') },
  )
export type UpdateMcpServerBody = z.infer<typeof updateMcpServerBodySchema>

// ───────────────────────────── 路径参数 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const mcpServerIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.mcp.serverIdNotUuid')),
})
export type McpServerIdParams = z.infer<typeof mcpServerIdParamsSchema>

/**
 * 凭据端点的路径参数：`:serverId`。
 *
 * ⚠️ **名字是 `serverId` 不是 `id`**（所以不能复用上面那个）：凭据的主语是"**我的这一份**"，
 * 路径里的 uuid 指向的是 **server**，行本身由 `(serverId, 我)` 推出来 —— 前端不该、也无法指定
 * 凭据行 id（那会立刻引出"能不能删别人的行"这个问题，而答案是"根本没有这个入口"）。
 * 少一个 `id` 就少一整类越权可能（`02` §4.7 的"收窄在 `user_id` 上，不在角色上"。
 */
export const mcpCredentialServerIdParamsSchema = z.object({
  serverId: z.string().uuid(validationMessage('validation.mcp.serverIdNotUuid')),
})
export type McpCredentialServerIdParams = z.infer<typeof mcpCredentialServerIdParamsSchema>
