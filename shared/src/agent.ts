/**
 * 智能体契约（P0-1-22；`02` §4.4 + §三、`01` §3.3 决策 18、`03` §二 / §4.2）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：**全员可建可看可用；创建者 + ADMIN 可编删** —— 与知识库/模型池都不同
 * ─────────────────────────────────────────────────────────────────────
 * 三族资源的权限口径**刻意各不相同**，写代码前必须查文档而不是照抄邻居（本仓已因此踩过
 * 两次"顺手加 `requireAdmin`"）：
 *
 * | 资源 | 建 | 看 | 编 / 删 | 依据 |
 * |------|----|----|---------|------|
 * | 模型池 `/api/models`、Provider | ADMIN | ADMIN | ADMIN | `03` §25 权限列 + `(A)` 标记 |
 * | 知识库 `/api/knowledge-bases` | 登录 | 登录 | 登录（**没有 owner 列**） | `03` §25 + `02` §三 无 owner |
 * | **智能体 `/api/agents`** | 登录 | 登录 | **创建者 + ADMIN** | `01` §3.3 决策 18 + `agents.created_by` 列 |
 *
 * 判据就是 `02` §三 里**有没有 owner 列**：`knowledge_bases` 没有 ⇒ 谁也"没有理由"独占它；
 * `agents.created_by` 有 ⇒ 必须按它判权。{@link canEditAgent} 是这条规则的**唯一实现**
 * （服务端与验收脚本共用），漏掉"创建者本人"或"ADMIN 也算"任一半都会立刻红。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 列表/详情/建/改**共用一套投影**（{@link agentItemSchema}）
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-21 的教训：同一份数据在多个出口出现不同形状，是前端最容易踩的坑。故这里只有**一个**
 * `AgentItem`，`GET /api/agents`、`GET /api/agents/:id`、`POST`、`PATCH` 的响应用的是同一个 schema。
 * 代价是列表要多查一次 `agent_components`（一次 `findMany` 覆盖整页，不是 N+1）—— 值得。
 *
 * 组件绑定**只给 `{componentType, refId}`，刻意不带目标名**：`mcp_servers` 表要到 P0-2 才建，
 * 现在给不出 MCP 侧的 name，而"只有知识库有名字"的不对称投影比"都没有名字"更难用。
 * 名字由前端从各自的列表端点（`/api/knowledge-bases` 等）映射 —— 建/改智能体的页面本来
 * 就要拉这些列表来渲染多选框（`03` §4.2 第 4 条）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ②·bis 组件绑定的**写侧**是"整体替换"，且只放行**能验证存在**的引用（P0-1-23）
 * ─────────────────────────────────────────────────────────────────────
 * `PUT /api/agents/:id/components` 收**全量集合**（`02` §4.4 原文："全量提交，避免增量 diff"）——
 * 增量 diff 要在服务端算差集，而差集算错的表现是"点了解绑没生效"或"别人的绑定被顺带删了"。
 * 引用完整性由服务层负责（`agent_components.ref_id` 是**多态外键、没有 FK**），
 * 而"能验证的"只有 KNOWLEDGE 一侧：`mcp_servers` 表要到 **P0-2** 才建，
 * 现在给一个 MCP 引用**无从验证真伪** ⇒ **明确拒绝**（400 + 指向 P0-2 的文案），
 * 而不是先写进去、等 P0-2 再收拾孤儿绑定 —— `kb.service.ts` 文件头 ④ 已经把
 * "库里说绑着某物、那个物已经不存在"的场景定性为最难查的一类坏法。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 删除是**软删**（`02` §4.4），且是"三件事一起做"
 * ─────────────────────────────────────────────────────────────────────
 * 「删除（软删：会话转只读保留、组件绑定解除）」—— 三件事缺一不可，且必须在**一个事务**里：
 *   ① `agents.deleted_at = now()`；② 删 `agent_components` 行；③ 该 Agent 的 `conversations`
 *   全部 `status = FINISHED`。只做 ① 的后果最隐蔽：绑定的知识库从此**删不掉**
 *   （`kb.service.ts` 的引用计数看的是 `agent_components`），而界面上那个 Agent 已经"没了"。
 *
 * 也因此：软删后**它对谁都不再"可编辑"**（{@link canEditAgent} 会返回 false），
 * 详情接口也 404 —— 留一个"看起来还能改"的页面，等于诱导用户去改一条已经作废的记录。
 * 历史会话那边要靠 **join 出来**的 `agentName` 快照来显示（不走本文件的投影，不受软删过滤）。
 */

import { z } from 'zod'

import { type UserRole } from './auth.js'
import {
  ASSET_VISIBILITIES,
  agentAudienceInputSchema,
  agentAudienceSchema,
  audienceIsEmpty,
  canEditAsset,
} from './assetAcl.js'
import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 取值域 ─────────────────────────────

/** Agent 类型（`schema.prisma` 的 `enum AgentType`；`01` 决策 4：ChatBot 主 + TaskAgent 辅） */
export const AGENT_TYPES = ['CHATBOT', 'TASK_AGENT'] as const
export type AgentType = (typeof AGENT_TYPES)[number]

/**
 * 可绑定的组件类型（`schema.prisma` 的 `enum ComponentType`；`01` 决策 7：只有知识库 + MCP）。
 *
 * 放在这里而不是留给 P0-1-23 自己定义：**读侧（详情回显）在本批就要落地**，
 * 而写侧（PUT 整体替换）在 P0-1-23 —— 两批共用一个枚举，否则就是两处 enum 各自漂移。
 */
export const COMPONENT_TYPES = ['KNOWLEDGE', 'MCP'] as const
export type ComponentType = (typeof COMPONENT_TYPES)[number]

// ───────────────────────────── 权限判据（唯一实现） ─────────────────────────────

/**
 * 「这个智能体对该调用者是否可编辑/可删除」—— `01` §3.3 决策 18 的唯一落点。
 *
 * 三条：
 *   · **ADMIN 一律可以**（"创建者 + admin 可编删"里的后半句）；
 *   · **创建者本人可以**（前半句）。注意这两个条件是**或**关系，写成"ADMIN 或者 owner"
 *     的常见错误写法是"仅 owner"（ADMIN 改不了任何东西）—— P0-1-23 的验收里有一条
 *     "普通用户 PATCH 他人 Agent → 403"，只有配上"ADMIN 改同一个 Agent → 200"才能把方向钉死；
 *   · **已软删的一律不可**（见文件头 ③）：它连详情都查不到，再判"可编辑"没有意义。
 *
 * `deletedAt` 收宽到 `Date | string | null`：服务端从 Prisma 拿到 `Date`，验收脚本从 JSON 里
 * 拿到 `string`，两者都要能用同一个判据（不然"可编辑"这条规则就会有第二份实现）。
 *
 * 注意：本函数只回答"**能不能**"，不负责拒绝 —— 拒绝时的 404/403 顺序由服务层定
 * （先 404 再 403：智能体的 id 本来就出现在全员可见的列表里，藏不住也不必藏）。
 */
export function canEditAgent(
  agent: { createdBy: string; deletedAt: Date | string | null },
  viewer: { id: string; role: UserRole },
): boolean {
  // P1-13：判据统一收口到 `assetAcl`（见文件头）；可见性不影响"编/删"（公开资产他人仍不可编删 → 403）
  return canEditAsset({ ownerId: agent.createdBy, deletedAt: agent.deletedAt }, viewer)
}

// ───────────────────────────── 公共字段 ─────────────────────────────

/**
 * 各文本字段的长度上限（**导出成常量**：它们既要出现在 schema 的报错文案里，也要出现在
 * 前端表单的提示文案里 —— 见 `docs/06` §六 那条"同一口径在两处各写一遍，必有一处先腐烂"。
 * P0-1-31 的编辑页照原型写过一次 `8000`，而真上限是 `10000`：原型上的数字是**装饰**，
 * 落地必须从常量取）。
 */
export const AGENT_NAME_MAX_CHARS = 128
export const AGENT_DESCRIPTION_MAX_CHARS = 2000
export const AGENT_ICON_MAX_CHARS = 255
export const AGENT_SYSTEM_PROMPT_MAX_CHARS = 10_000
export const AGENT_OPENING_REMARKS_MAX_CHARS = 2000

/** 名称（列 `VARCHAR(128)`） */
const agentNameSchema = z
  .string({ required_error: '请输入智能体名称' })
  .trim()
  .min(1, '请输入智能体名称')
  .max(AGENT_NAME_MAX_CHARS, `名称最多 ${AGENT_NAME_MAX_CHARS} 个字符`)

/**
 * 描述（列 `TEXT`，无硬上限）。2000 字是**防误操作**上限（与知识库描述同口径：
 * 把整篇文档粘进描述框是最常见的脏数据），不是存储约束。
 */
const agentDescriptionSchema = z
  .string()
  .trim()
  .max(AGENT_DESCRIPTION_MAX_CHARS, `描述最多 ${AGENT_DESCRIPTION_MAX_CHARS} 个字符`)

/**
 * 图标（列 `VARCHAR(255)`）。
 *
 * ⚠️ 本批它是**一个字符串**（emoji 或图片 URL），不是文件引用：`03` §4.2 写的是"图标上传"，
 * 但 P0-1 没有文件上传端点（`files` 表要到 P1 的附件/图标功能才用）。给一个 `VARCHAR(255)`
 * 就能表达的字段是对的 —— 将来真做上传时，存进去的内容变成 URL，**契约不用改**。
 */
const agentIconSchema = z.string().trim().max(AGENT_ICON_MAX_CHARS, `图标最多 ${AGENT_ICON_MAX_CHARS} 个字符`)

/**
 * 系统提示词 / 开场白：**刻意不 `trim()`**（与名称/描述相反）。
 *
 * 理由：这两项是**多行自由文本**，缩进与前导换行是提示词排版的一部分；`trim()` 会把
 * "先空一行再写角色设定"这种常见写法悄悄改掉，而用户看不到自己写的内容被改了。
 * 上限是防误操作（`TEXT` 列本身没有上限）。
 */
const agentSystemPromptSchema = z
  .string()
  .max(AGENT_SYSTEM_PROMPT_MAX_CHARS, `系统提示词最多 ${AGENT_SYSTEM_PROMPT_MAX_CHARS} 个字符`)
const agentOpeningRemarksSchema = z
  .string()
  .max(AGENT_OPENING_REMARKS_MAX_CHARS, `开场白最多 ${AGENT_OPENING_REMARKS_MAX_CHARS} 个字符`)

/** 引导问题条数上限（`03` §4.2："可增删的列表"；防误操作，不是存储约束——jsonb 不限） */
export const GUIDE_QUESTIONS_MAX = 10
/** 单个引导问题的长度上限（它是**按钮文案**，超过一行就没有按钮的样子了） */
export const GUIDE_QUESTION_MAX_CHARS = 200

/**
 * 引导问题（列 `guide_questions` jsonb，默认 `[]`）。
 *
 * 三个约束都是**防误操作**，且都必须在这里（写入口）拦：列是 jsonb，数据库不会替我们拒绝
 * "塞进去 5 万个字符串"或"塞进去一个数字"。元素用 `.trim().min(1)` 挡掉空白项 ——
 * 空白按钮渲染出来就是一个点不了的按钮，用户只会以为是前端坏了。
 *
 * 刻意**不做去重**：那是"自己发明约束"（P0-1-11 的教训 —— 想当然加一条校验会把合法配置
 * 挡在门外），而重复的引导问题最多是难看，前端自己 dedupe 即可。
 */
export const guideQuestionsSchema = z
  .array(
    z
      .string({ invalid_type_error: '引导问题必须是字符串' })
      .trim()
      .min(1, '引导问题不能为空')
      .max(GUIDE_QUESTION_MAX_CHARS, `每个引导问题最多 ${GUIDE_QUESTION_MAX_CHARS} 个字符`),
    { invalid_type_error: '引导问题必须是字符串数组' },
  )
  .max(GUIDE_QUESTIONS_MAX, `引导问题最多 ${GUIDE_QUESTIONS_MAX} 条`)

/** 绑定的模型（`:modelId` 是 uuid(7) 字符串） */
const agentModelIdSchema = z
  .string({ required_error: '请选择模型' })
  .uuid('模型 ID 不是合法 UUID')

/** 模型池上限（防误操作；池是"对话时可选的模型集合"，几十个足够，不是存储约束） */
export const AGENT_MODEL_POOL_MAX = 50

/**
 * 智能体的**模型池**（`modelIds`）——对话时可在其中选具体模型。
 *
 * · **非空**：一个没有任何可选模型的智能体发不出消息；
 * · **必须包含默认模型**（`modelId`）：默认模型是"对话不指定模型时走的那一个"，
 *   它天然是池成员。这条跨字段约束在**同一请求同时给了两者**时由 schema 拦
 *   （见 {@link createAgentBodySchema} / {@link updateAgentBodySchema} 的 superRefine）；
 *   只给其一时由服务层结合库里现状补齐（服务层会把新默认模型自动并入池）。
 * · **不在 schema 层去重**：服务层用 Set 去重即可，重复项最多是前端多选了一次。
 */
const agentModelPoolSchema = z
  .array(agentModelIdSchema)
  .min(1, '请至少选择一个模型')
  .max(AGENT_MODEL_POOL_MAX, `模型池最多 ${AGENT_MODEL_POOL_MAX} 个模型`)

// ───────────────────────────── 补默认值（读取端唯一入口） ─────────────────────────────

/**
 * jsonb（`guide_questions`）→ **一定可用**的 `string[]`。**永不抛错**。
 *
 * 为什么读取端也要有这一层（与 `normalizeRetrievalConfig` 同族的问题）：DB 默认值
 * 只在"INSERT 时不给该列"才生效，而这三种数据都拿不到那个默认值 ——
 *   · 本批之前手工插的 agent 行（P0-1-15 的验收脚本就造过）；
 *   · 直接在库里改过的行；
 *   · 将来某次迁移/导入带进来的行。
 * 前端对 `guideQuestions` 的行为是 `.map()` 渲染引导气泡 —— 拿到一个数字或 `null`
 * 就是一个**白屏**，而且报错指不到数据库那条脏数据上。
 *
 * ⚠️ 只做**类型收敛**（非数组 → `[]`、非字符串元素丢弃、`trim()` 后为空的丢弃），
 * **不做截断**：读的时候把超出的条目悄悄丢掉，等于界面上少了几条而用户永远不知道
 * （"列表少了几条"是最难查的一类）。条数上限只在**写入口**拦（{@link guideQuestionsSchema}），
 * 而写入口是本端点唯一的数据来源 —— 所以"读到超长数组"这件事本身只可能来自手工改库。
 */
export function normalizeGuideQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    out.push(trimmed)
  }
  return out
}

// ───────────────────────────── 输出投影（唯一一套） ─────────────────────────────

/**
 * 一条组件绑定（读侧形态）。字段名与列名一致（`componentType` / `refId`），
 * 见文件头 ② —— **不带目标名**。
 *
 * `pinnedToolNames` 是 **P1-19** 加的（只对 `componentType=MCP` 有意义）：**常驻工具**的
 * MCP 原始工具名 —— 当 Agent 绑定的 MCP 工具总数超过网关阈值时，只有这些**直接下发**给模型，
 * 其余由 `mcp_list_tools` / `mcp_call_tool` 按需触达（见 `backend/src/services/mcpCall.service.ts`）。
 * 存储落在 `agent_components.config` 这个既有 jsonb 列（`{ pinnedMcpTools: [...] }`）。
 * `KNOWLEDGE` 行不带它。
 */
export const agentComponentRefSchema = z.object({
  componentType: z.enum(COMPONENT_TYPES),
  /** `KNOWLEDGE` → `knowledge_bases.id`；`MCP` → `mcp_servers.id`（多态，无外键，`02` §3.1） */
  refId: z.string(),
  /** 常驻的 MCP 工具原始名（仅 `MCP`；缺省 = 无常驻，工具多时全走网关） */
  pinnedToolNames: z.array(z.string()).optional(),
})
export type AgentComponentRef = z.infer<typeof agentComponentRefSchema>

/** 单个组件绑定能标的**常驻工具数**上限（防"把整台 server 的工具全常驻"把阈值架空） */
export const MCP_PINNED_TOOL_NAMES_MAX = 200

/**
 * 从 `agent_components.config`（jsonb）里读出**常驻工具名**。**永不抛错**（读侧的唯一入口）。
 *
 * 形状是 `{ pinnedMcpTools: string[] }`。逐条过滤（非字符串 / 空串丢掉）、去重、封顶 ——
 * 与 `normalizeGuideQuestions` 同族的"读取端只求能渲染、坏值静默丢弃"：config 是 jsonb，
 * 手工改库 / 跨环境导入都可能塞进半截数据。
 */
export function pinnedMcpToolNamesFromConfig(config: unknown): string[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
  const raw = (config as { pinnedMcpTools?: unknown }).pinnedMcpTools
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= MCP_PINNED_TOOL_NAMES_MAX) break
  }
  return out
}

/**
 * 模型池里的**一个可选模型**（对话页的模型选择器逐项渲染）。
 *
 * `available` = 模型与其 Provider 都启用（与 `GET /api/models/available` 同口径）。
 * 停用的模型仍留在池投影里（`available:false`），前端把它置灰而不是让它凭空消失
 * —— 与 `modelAvailable` 对默认模型的处理同款：让用户看得见"它被停用了"，而不是"少了一个"。
 */
export const agentModelOptionSchema = z.object({
  modelId: z.string(),
  /** 上游型号名（会原样放进请求体的 `model` 字段） */
  modelName: z.string(),
  /** 模型别名（界面上给业务同学看的名字） */
  modelLabel: z.string(),
  /** 现在能否直接用于对话（`models.enabled && model_providers.enabled`） */
  available: z.boolean(),
})
export type AgentModelOption = z.infer<typeof agentModelOptionSchema>

/**
 * 智能体（**列表 / 详情 / 建 / 改共用的唯一投影**，见文件头 ②）。
 *
 * 几个字段的存在理由：
 *   · `canEdit` —— 列表是全员可见的，前端据此决定"编辑/删除"按钮是否可点。
 *     服务端**不依赖它**做鉴权（每次请求重新判），它只是给界面用的同一份判据的投影。
 *   · `modelAvailable` —— 绑定的模型**现在**还能不能用（模型与它所属 Provider 都启用）。
 *     与知识库的 `embeddingModelChanged` 同族：没有它，管理员停用一个模型之后，
 *     所有绑了它的智能体在界面上都"看着正常"，直到用户发消息才炸。
 *   · `creatorName` —— 列表对全员开放，显示"谁建的"是最基本的协作信息（昵称优先，回落用户名）。
 *   · `guideQuestions` 恒为数组（列默认 `[]`），前端可以无脑 `.map()`。
 */
export const agentItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  type: z.enum(AGENT_TYPES),
  systemPrompt: z.string().nullable(),
  openingRemarks: z.string().nullable(),
  guideQuestions: z.array(z.string()),
  /**
   * 绑定的模型 id。**可空**：删模型商/删模型会把引用它的智能体自动解绑（`schema.prisma`
   * 的 `agents.model_id` = `onDelete: SetNull`），此时为 `null` ⇒ 「未绑定模型」，
   * 需重新绑定后才能对话。创建时必填（{@link createAgentBodySchema}），只有"被动解绑"会变空。
   */
  modelId: z.string().nullable(),
  /** 上游型号名（会原样放进请求体的 `model` 字段）；未绑定模型时为 `null` */
  modelName: z.string().nullable(),
  /** 模型别名（界面上给业务同学看的名字）；未绑定模型时为 `null` */
  modelLabel: z.string().nullable(),
  /**
   * 绑定模型当前**可直接用于对话**吗（`models.enabled && model_providers.enabled`，与可选列表同口径）。
   * **未绑定模型**（`modelId === null`）时恒为 `false` —— 前端据此提示"去编辑页重新绑定模型"。
   */
  modelAvailable: z.boolean(),
  /**
   * **模型池**：对话时可选的模型集合（`agent_models` 关联）。
   *
   * 默认模型（`modelId`）恒为池成员（服务层保证）。发消息时前端可在此选一个具体模型
   * （`POST /:id/chat` 的 `modelId`）；不选则走默认模型。未绑定模型的旧智能体此处可能为空数组。
   */
  models: z.array(agentModelOptionSchema),
  createdBy: z.string(),
  /** 创建者显示名（昵称优先、回落用户名） */
  creatorName: z.string(),
  /**
   * P1-18：**可见范围**。`PRIVATE` = 仅所属人（+ ADMIN）；`SHARED` = 所属人 + 受众（见
   * {@link agentAudienceSchema}）+ ADMIN（**仅 Agent 有这一档**）；`PUBLIC` = 全员。
   * 判据见 `assetAcl#canViewAsset`。私有/指定用户 Agent 对受众外的人**列表不可见、详情 404**。
   */
  visibility: z.enum(ASSET_VISIBILITIES),
  /**
   * P1-18：**受众**（`visibility=SHARED` 时给出：用户 ∪ 组）。非 `SHARED` 时恒为空数组。
   * 回显用（建/改页面据此恢复选择）。
   */
  audience: agentAudienceSchema,
  /** `01` §3.3 决策 18：创建者（= 所属人）+ ADMIN 可编删（见 {@link canEditAgent}） */
  canEdit: z.boolean(),
  /** 已绑定的组件（`02` §4.4 详情"含组件绑定"）；解绑走 P0-1-23 的 `PUT …/components` 整体替换 */
  components: z.array(agentComponentRefSchema),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentItem = z.infer<typeof agentItemSchema>

// ───────────────────────────── 组件绑定（写侧，P0-1-23） ─────────────────────────────

/**
 * 一条要**写入**的组件引用（`PUT /api/agents/:id/components` 的元素）。
 *
 * 与读侧的 {@link agentComponentRefSchema} 刻意分开，两处约束不同：
 *   · 读侧是"库里有什么就回显什么"，`refId` 只要求是字符串（万一库里被人手工塞了脏值，
 *     读取端也不该因为它而 500 —— 与 `normalizeGuideQuestions` 同族的思路）；
 *   · 写侧要**先拦形态**：`ref_id` 是 `@db.Uuid` 列，非 uuid 的串到 DB 才炸就是一个 500
 *     （而且报错文案是 Prisma 的，用户看不出哪里错了）。
 */
export const agentComponentInputSchema = z.object({
  componentType: z.enum(COMPONENT_TYPES, {
    errorMap: () => ({ message: `componentType 只能是 ${COMPONENT_TYPES.join('/')}` }),
  }),
  refId: z
    .string({ required_error: '请提供组件引用 ID' })
    .uuid('组件引用 ID 不是合法 UUID（KNOWLEDGE 必须是知识库 id）'),
  /**
   * 常驻的 MCP 工具原始名（仅 `MCP`；P1-19）。省略 / 空数组 = 无常驻。
   * ⚠️ 常驻只是"**优先直接下发**"：工具总数没超阈值时本来就全部下发，常驻不起作用。
   */
  pinnedToolNames: z
    .array(z.string().trim().min(1).max(256), { invalid_type_error: 'pinnedToolNames 必须是字符串数组' })
    .max(MCP_PINNED_TOOL_NAMES_MAX, `常驻工具最多 ${MCP_PINNED_TOOL_NAMES_MAX} 个`)
    .optional(),
})
export type AgentComponentInput = z.infer<typeof agentComponentInputSchema>

/**
 * `PUT /api/agents/:id/components` 请求体：**整体替换**（`02` §4.4 的"全量提交，避免增量 diff"）。
 *
 * **`components` 必填**，清空要显式传 `[]`。刻意不把"省略"当作"清空"：
 * 前端保存时会串行发 `PATCH` + `PUT`（`03` §4.2 第 5 条），一旦某次忘了带这个字段，
 * "省略 = 清空"就会**静默解绑所有知识库**，而用户看到的是"保存成功"。
 * 这与 `guideQuestions` 用 `[]` 表达清空是同一套口径 —— 清空只有一种写法。
 *
 * **重复项直接 400**（而不是去重或让 DB 的唯一索引兜）：`agent_components` 上有
 * `@@unique([agentId, componentType, refId])`，重复项落库会得到 P2002 ⇒ 500；
 * 而"提交了一份带重复项的集合"本就是调用方的 bug（多选框选不出重复值），
 * 说清楚比悄悄去重好 —— 悄悄去重会让"我提交的 ≠ 我拿到响应的"变成一件查不出来的事。
 * ⚠️ 用 `superRefine` 而不是 `.refine()`：前者能给出**真的字段路径**
 * （`['components', 1, 'refId']`），前端可以精确高亮到那一行；`.refine()` 的 `path` 是空串
 * （P0-1-22 在"空 body"那条上踩过，只能靠遍历 message 定位）。
 *
 * **刻意不设条数上限**：可绑的知识库数量本身没有业务上限，加一个"看起来合理"的数字
 * 就会把"有 60 个库想全绑上"变成一件做不到的事（P0-1-11 的教训：自己发明约束会把合法配置挡在门外）。
 * 报文大小由框架的 bodyLimit 兜。
 */
export const replaceAgentComponentsBodySchema = z
  .object({
    components: z.array(agentComponentInputSchema, {
      required_error: '请提供 components（全量替换；要清空请传空数组）',
      invalid_type_error: 'components 必须是数组',
    }),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.components.forEach((item, index) => {
      const key = `${item.componentType}:${item.refId}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components', index, 'refId'],
          message: '同一条绑定重复提交了（全量替换里每对 componentType + refId 只能出现一次）',
        })
        return
      }
      seen.add(key)
    })
  })
export type ReplaceAgentComponentsBody = z.infer<typeof replaceAgentComponentsBodySchema>

// ───────────────────────────── 列表 ─────────────────────────────

/**
 * `GET /api/agents` 查询参数（offset/limit，与其余列表同口径）。
 *
 * **不做 `type` 过滤**：`03` §二 的首页（智能体列表）没有类型筛选器，`02` §4.4 也没写。
 * 加一个没人要的参数，等于让"列表为什么少了几条"变成一件要靠猜的事。
 */
export const listAgentsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const agentListResultSchema = offsetPageOf(agentItemSchema)
export type AgentListResult = z.infer<typeof agentListResultSchema>

// ───────────────────────────── 建 ─────────────────────────────

/**
 * `POST /api/agents` 请求体（全员可建）。
 *
 * `type` **必填且无默认值**：ChatBot 与 TaskAgent 的运行方式完全不同（RAG 直连 vs 沙箱 ACP），
 * 给一个默认值等于让"忘了传"的调用方建出一个他没想要的东西，而且**建完改不了**（见下）。
 *
 * `modelId` 必填：一个没有模型的智能体发不出消息，创建时不允许留空。
 * （列本身 `onDelete: SetNull` 可空，但那只用于"删模型商/删模型时被动解绑"，
 * 不是创建入口能表达的状态。）
 * 服务层会校验它"存在 + 启用 + 所属 Provider 也启用 + `type=CHAT`"（`01` §3.2 验收要点）。
 *
 * 三个可省字段（`description` / `icon` / `systemPrompt` / `openingRemarks`）省略与 `null` 同义。
 * `guideQuestions` 省略时取库里的 `[]` 默认值。
 */
export const createAgentBodySchema = z
  .object({
    name: agentNameSchema,
    description: agentDescriptionSchema.nullish(),
    icon: agentIconSchema.nullish(),
    type: z.enum(AGENT_TYPES, {
      errorMap: () => ({ message: `type 只能是 ${AGENT_TYPES.join('/')}` }),
    }),
    systemPrompt: agentSystemPromptSchema.nullish(),
    openingRemarks: agentOpeningRemarksSchema.nullish(),
    guideQuestions: guideQuestionsSchema.optional(),
    modelId: agentModelIdSchema,
    /**
     * 模型池（对话时可选）。**可省**：省略时服务层按 `[modelId]` 建池（向后兼容单模型）。
     * 给了就必须包含 `modelId`（默认模型），见下面的 superRefine。
     */
    modelIds: agentModelPoolSchema.optional(),
    /**
     * P1-18：可见范围。**可省** ⇒ 服务层按 `PRIVATE`（安全默认）。
     * `SHARED` 时必须带非空 `audience`；`PRIVATE`/`PUBLIC` 时不得带（见下方 superRefine）。
     * ⚠️ 建/改为 `PUBLIC`/`SHARED` **不再**校验引用的组件是否公开（**取消可见性闭包**，
     * P1-18 定案：组件通过 Agent 被使用时授权来自 Agent 的受众，见 `assetAcl` 文件头 ①）。
     */
    visibility: z
      .enum(ASSET_VISIBILITIES, {
        errorMap: () => ({ message: `visibility 只能是 ${ASSET_VISIBILITIES.join('/')}` }),
      })
      .optional(),
    /** P1-18：受众（仅 `visibility=SHARED` 允许给；`SHARED` 时至少一个主体非空） */
    audience: agentAudienceInputSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.modelIds !== undefined && !body.modelIds.includes(body.modelId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelId'],
        message: '默认模型必须在模型池中',
      })
    }
    // P1-18：可见范围 × 受众（创建时缺省即 PRIVATE ⇒ 不允许带 audience）
    const visibility = body.visibility ?? 'PRIVATE'
    if (visibility === 'SHARED') {
      if (body.audience === undefined || audienceIsEmpty(normalizeForCheck(body.audience))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['audience'],
          message: '可见范围为「指定用户」时，至少要选择一位用户或一个组',
        })
      }
    } else if (body.audience !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: '只有可见范围为「指定用户」时才能设置受众',
      })
    }
  })
export type CreateAgentBody = z.infer<typeof createAgentBodySchema>

/** 受众输入 → 是否为空（superRefine 用；不引服务层的 normalize，避免契约层依赖过长） */
function normalizeForCheck(audience: { userIds?: string[]; groupIds?: string[] }): {
  userIds: string[]
  groupIds: string[]
} {
  return { userIds: audience.userIds ?? [], groupIds: audience.groupIds ?? [] }
}

// ───────────────────────────── 改 ─────────────────────────────

/**
 * `PATCH /api/agents/:id` 请求体：**至少给一个字段**；权限 = 创建者或 ADMIN。
 *
 * 两处"三态"与一处"不可改"，全部写在这里而不是留给服务层猜：
 *
 * · `description` / `icon` / `systemPrompt` / `openingRemarks` 是**三态**：
 *   **不带 = 不动** / `null` = **清空** / 值 = 设置。必须是 `.nullable().optional()`，
 *   **绝不能加 `.default()`** —— 加了就会把"清空系统提示词"与"只改个名字"合并成同一种效果
 *   （P0-1-10 / P0-1-11 的同款坑，本仓踩过两次）。
 *
 * · `guideQuestions` 的"清空"**天然可表达**（`[]`），所以它是普通的 `.optional()`：
 *   `undefined` = 不动、`[]` = 清空。⚠️ 不要再叠一个 `null` 分支 —— 两种"清空"写法并存，
 *   前端迟早会有人只处理其中一个。
 *
 * · `type` **可传但改不了**（值不同 → 409）。放进 schema 正是为了**把静默 no-op 变成显式报错**：
 *   字段压根不在 schema 里时，zod 会把多余键剥掉，调用方以为自己改成功了，实际什么都没发生
 *   （`03` §4.2 已写明"类型创建后不可改"，而"不可改"必须能**被用户感知到**）。
 *   传同值放行（幂等：前端整表单提交时"没改"不该失败）。
 *
 * · `modelId` **可以改**（换绑默认模型是正常操作），改的时候走与创建**同一段**可用性校验。
 * · `modelIds` **可以改**（整体替换模型池）：非空，服务层保证默认模型并入池、逐个校验可用性。
 */
export const updateAgentBodySchema = z
  .object({
    name: agentNameSchema.optional(),
    /** ⚠️ 三态，见上 */
    description: agentDescriptionSchema.nullable().optional(),
    icon: agentIconSchema.nullable().optional(),
    /** ⚠️ 可传但不可改（不同值 → 409），见上 */
    type: z
      .enum(AGENT_TYPES, { errorMap: () => ({ message: `type 只能是 ${AGENT_TYPES.join('/')}` }) })
      .optional(),
    systemPrompt: agentSystemPromptSchema.nullable().optional(),
    openingRemarks: agentOpeningRemarksSchema.nullable().optional(),
    /** `[]` = 清空（不是三态，见上） */
    guideQuestions: guideQuestionsSchema.optional(),
    modelId: agentModelIdSchema.optional(),
    /** 整体替换模型池（非空）；与 `modelId` 的一致性见下方 superRefine 与服务层 */
    modelIds: agentModelPoolSchema.optional(),
    /** P1-18：可见范围（`SHARED` 需带非空 `audience`；合并后的一致性由服务层最终判定） */
    visibility: z
      .enum(ASSET_VISIBILITIES, {
        errorMap: () => ({ message: `visibility 只能是 ${ASSET_VISIBILITIES.join('/')}` }),
      })
      .optional(),
    /** P1-18：受众（整体替换；`visibility≠SHARED` 时不得给） */
    audience: agentAudienceInputSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      // `null`（清空）也算"给了字段"：`null !== undefined`，正是想要的效果
      body.description !== undefined ||
      body.icon !== undefined ||
      body.type !== undefined ||
      body.systemPrompt !== undefined ||
      body.openingRemarks !== undefined ||
      body.guideQuestions !== undefined ||
      body.modelId !== undefined ||
      body.modelIds !== undefined ||
      body.visibility !== undefined ||
      body.audience !== undefined,
    { message: '至少要提供一个要修改的字段' },
  )
  .superRefine((body, ctx) => {
    // 同一请求同时给了默认模型与模型池 ⇒ 默认模型必须在池里（只给其一时由服务层结合库里现状补齐）
    if (body.modelId !== undefined && body.modelIds !== undefined && !body.modelIds.includes(body.modelId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelId'],
        message: '默认模型必须在模型池中',
      })
    }
    // P1-18：同请求内 visibility × audience 的**局部**一致性（合并库里现状后的最终判定在服务层）
    if (body.visibility !== undefined && body.visibility !== 'SHARED' && body.audience !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: '只有可见范围为「指定用户」时才能设置受众',
      })
    }
    if (
      body.visibility === 'SHARED' &&
      body.audience !== undefined &&
      audienceIsEmpty(normalizeForCheck(body.audience))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: '可见范围为「指定用户」时，至少要选择一位用户或一个组',
      })
    }
  })
export type UpdateAgentBody = z.infer<typeof updateAgentBodySchema>

// ───────────────────────────── 路径参数与删除结果 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const agentIdParamsSchema = z.object({
  id: z.string().uuid('智能体 ID 不是合法 UUID'),
})
export type AgentIdParams = z.infer<typeof agentIdParamsSchema>

/**
 * `DELETE /api/agents/:id` 的响应。
 *
 * 带上两个数量是刻意的（与删库的 `deletedDocuments` 同族）：删除**连带**做了两件用户可见的事
 * —— 解绑了组件、把会话转成了只读 —— 只回一个 `ok` 的话，界面无法给出有信息量的确认提示
 * （"将同时影响 N 个会话"，`03` §七 的级联删除确认框正需要这个数字）。
 */
export const removeAgentResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 连带解除的组件绑定数 */
  removedComponents: z.number().int().min(0),
  /** 连带转为只读（`FINISHED`）的会话数 */
  finishedConversations: z.number().int().min(0),
})
export type RemoveAgentResult = z.infer<typeof removeAgentResultSchema>
