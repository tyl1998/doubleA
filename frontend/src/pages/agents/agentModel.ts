/**
 * 智能体表单的**纯逻辑**与展示口径（P0-1-31）
 *
 * 依据：`shared/src/agent.ts`（三态语义、`guideQuestions` 的清空口径、`PUT …/components` 的
 *      整体替换语义）、`docs/03` §4.2（四区表单 + 保存 = PATCH + PUT components 串行）、
 *      §七（文案词表、保存语义）。
 *
 * 为什么把这段逻辑单独放一个文件（而不是写在页面组件里）：
 * 它是"哪些字段变了 → 该发哪个请求 → 失败时该标哪个区块"的唯一判据，**列表页与编辑页共用**
 * （删除确认与保存都要用它）。写在组件里就只能靠 `useState` 散着写，一处漏掉就是
 * "界面显示保存成功、数据其实没变"。这里全部是**纯函数**：输入基线 + 当前值，
 * 输出要发的请求体与脏区块 —— 没有 React、没有请求，读起来就是契约本身。
 *
 * ⚠️ **三态是这套逻辑的中心**（`shared` 的字段注释）：
 *   · 不带 = 不动 ｜ `null` = 清空 ｜ 值 = 设置。
 * 所以"只有真的变了才放进请求体"不是优化，而是**语义正确性**：把没改的字段也带上，
 * 就等于每次保存都把用户的系统提示词重写一遍（并可能把一个 `null` 变成 `''`）。
 */

import type {
  AgentComponentInput,
  AgentItem,
  AgentType,
  CreateAgentBody,
  UpdateAgentBody,
} from '@doubulea/shared'

// ───────────────────────────── 展示口径（文案词表只此一处） ─────────────────────────────

/** `03` §七 文案词表：界面统一用「智能体」；类型名沿用产品命名而不是枚举字面量 */
export const AGENT_TYPE_LABEL: Readonly<Record<AgentType, string>> = {
  CHATBOT: 'ChatBot',
  TASK_AGENT: 'TaskAgent',
}

/** 类型选择器的副标题（`design/agent-edit.html` 的 `.check__meta`） */
export const AGENT_TYPE_HINT: Readonly<Record<AgentType, string>> = {
  CHATBOT: '即时问答，一轮一轮对话',
  TASK_AGENT: '带沙箱与产物面板（沙箱执行属 P0-3）；类型创建后不可改',
}

// 类型选项**不在这里再定义一份**：`shared` 的 `AGENT_TYPES` 就是取值域，编辑页直接迭代它。
// 抄一份 `AGENT_TYPE_OPTIONS` 的代价不是"多几行"，而是新增类型时改一处、漏一处，
// 症状是"后端认这个类型、前端选不出来"（本仓 P0-1-22 已为同类重复枚举立过规矩）。

/** 表单分区（`03` §4.2 的四区）。顺序即页面上的区块顺序 */
export const AGENT_SECTIONS = ['basic', 'model', 'prompt', 'components'] as const
export type AgentSectionKey = (typeof AGENT_SECTIONS)[number]

export const AGENT_SECTION_LABEL: Readonly<Record<AgentSectionKey, string>> = {
  basic: '基本信息',
  model: '模型',
  prompt: '提示词',
  components: '组件绑定',
}

/** 区块序号（原型左侧的 `01 / …`） */
export function sectionOrdinal(section: AgentSectionKey): string {
  return String(AGENT_SECTIONS.indexOf(section) + 1).padStart(2, '0')
}

/**
 * 把若干"哪些区块脏了"的结论**按页面顺序**合并去重。
 *
 * 为什么要有这个函数：脏区块有**两个来源** —— 文本/模型字段的差异（{@link changedSections}）
 * 与组件绑定的集合差异（它不在表单值里，见编辑页）。两处各自产生的数组直接 `concat` 会得到
 * `[basic, model, components, prompt]` 这种**不是页面顺序**的结果，而它会被用来渲染左侧的红线
 * 与标签 —— 顺序错了不会报错，只会让"哪一个区块没保存"看起来随机。
 */
export function orderSections(sections: Iterable<AgentSectionKey>): AgentSectionKey[] {
  const set = new Set(sections)
  return AGENT_SECTIONS.filter((section) => set.has(section))
}

// ───────────────────────────── 表单值 ─────────────────────────────

/**
 * 表单值的形状。
 *
 * 与 `AgentItem` 的差别只有一处、且是刻意的：**可空的文本字段在这里一律是 `string`**
 * （`null` → `''`）。AntD 的受控输入不接受 `null`，而"空串"与"清空"在界面上本来就是同一件事
 * —— 三态里的 `null` 由 {@link buildUpdateBody} 在**提交那一刻**决定，不在表单态里表达。
 */
export interface AgentFormValues {
  name: string
  description: string
  icon: string
  type: AgentType
  modelId: string
  systemPrompt: string
  openingRemarks: string
  guideQuestions: string[]
}

/**
 * 新建态的"全空"表单值。
 *
 * `type` 取**字面量** `'CHATBOT'` 而不是 `AGENT_TYPES[0]`：后者要数数组才知道默认是什么，
 * 而且一旦有人重排 `AGENT_TYPES`，新建智能体的默认类型就会**静默**改掉
 * （`shared` 的 `canEditAgent` 里已经为同一个理由把 `ADMIN` 写成字面量）。
 */
export const EMPTY_AGENT_FORM_VALUES: AgentFormValues = {
  name: '',
  description: '',
  icon: '',
  type: 'CHATBOT',
  modelId: '',
  systemPrompt: '',
  openingRemarks: '',
  guideQuestions: [],
}

/** 服务端投影 → 表单值（`null` → `''`，见 {@link AgentFormValues}） */
export function valuesFromAgent(item: AgentItem): AgentFormValues {
  return {
    name: item.name,
    description: item.description ?? '',
    icon: item.icon ?? '',
    type: item.type,
    modelId: item.modelId,
    systemPrompt: item.systemPrompt ?? '',
    openingRemarks: item.openingRemarks ?? '',
    // 拷贝一份：表单会原地改这个数组（Form.List 的增删），不能与 query 缓存共享引用
    guideQuestions: [...item.guideQuestions],
  }
}

// ───────────────────────────── 文本字段的归一化（三态的唯一判据） ─────────────────────────────

export type TextField = 'description' | 'icon' | 'systemPrompt' | 'openingRemarks'

/** 基本信息区的两个文本字段 */
const BASIC_TEXT_FIELDS = ['description', 'icon'] as const satisfies readonly TextField[]
/** 提示词区的两个文本字段 */
const PROMPT_TEXT_FIELDS = ['systemPrompt', 'openingRemarks'] as const satisfies readonly TextField[]

/**
 * 可空文本字段的**归一化方式**。
 *
 * ⚠️ 与 `shared` 的 schema 逐条对应、**不能统一成一种**：
 *   · `description` / `icon` 在 schema 里是 `.trim()` 过的 ⇒ 归一化也 trim（否则
 *     "把描述末尾多打一个空格"会被判成改动，白白发一次 PATCH）；
 *   · `systemPrompt` / `openingRemarks` **刻意不 trim**（缩进与前导换行是提示词排版的一部分，
 *     `shared/src/agent.ts` 的注释）⇒ 归一化必须**原样保留**，否则"用户没动过"与
 *     "用户删掉了首行空行"会变成同一件事。
 */
const TEXT_FIELD_MODE: Readonly<Record<TextField, 'trim' | 'verbatim'>> = {
  description: 'trim',
  icon: 'trim',
  systemPrompt: 'verbatim',
  openingRemarks: 'verbatim',
}

function normalizeTextField(field: TextField, raw: string): string {
  return TEXT_FIELD_MODE[field] === 'trim' ? raw.trim() : raw
}

/** 归一化后为空 ⇒ 提交 `null`（**清空**）；否则提交归一化后的值 */
function nullableTextField(field: TextField, raw: string): string | null {
  const value = normalizeTextField(field, raw)
  return value === '' ? null : value
}

/**
 * 引导问题的归一化：**逐条 trim、丢掉空条目**。
 *
 * 为什么在提交前丢掉而不是让后端拒：编辑器里「+ 添加引导问题」会先插一个空行，用户没填就走
 * —— 后端会回 400「引导问题不能为空」并指向 `guideQuestions`，但界面上"哪一行错了"无从高亮
 * （`docs/06` §六 第 ② 条：字段级文案在 `data.fields`，而数组元素的位置对用户没有意义）。
 * 空行**不是内容**，丢掉它是"清空"的另一种写法，与用 `[]` 表达清空同一口径。
 *
 * 不去重：那是自己发明约束（重复的按钮难看，但不是错误），与 `shared` 的注释一致。
 */
export function normalizeGuideQuestionsForSubmit(raw: readonly string[]): string[] {
  return raw.map((item) => item.trim()).filter((item) => item !== '')
}

// ───────────────────────────── 组件绑定 ─────────────────────────────

/** 绑定的集合键 —— 与后端 `agent_components` 的 `@@unique([agentId, componentType, refId])` 同口径 */
export function componentKey(component: { componentType: string; refId: string }): string {
  return `${component.componentType}:${component.refId}`
}

/**
 * 集合判等（**顺序无关**）。
 *
 * 用来决定"要不要发 `PUT`"：绑定是**集合语义**，把顺序换来换去提交不算改动。
 * 不做这一步的后果不是报错，而是**看不见的改写**（每次保存都重写 `agent_components` 的行，
 * `id`/`created_at` 全换一遍）—— P0-1-23 已为这类"写了但看起来没变"立过规矩。
 */
export function sameComponentSet(
  a: readonly { componentType: string; refId: string }[],
  b: readonly { componentType: string; refId: string }[],
): boolean {
  if (a.length !== b.length) return false
  const left = new Set(a.map(componentKey))
  return b.every((item) => left.has(componentKey(item)))
}

/** 服务端投影里的绑定 → 写侧形态（`AgentItem.components` 与写侧 schema 是同一对字段名） */
export function componentsFromAgent(item: AgentItem): AgentComponentInput[] {
  return item.components.map((component) => ({
    componentType: component.componentType,
    refId: component.refId,
  }))
}

/**
 * 过滤出**能提交**的绑定：只留 `KNOWLEDGE`。
 *
 * P0-1-23 定案：`mcp_servers` 表属 P0-2，本阶段 `PUT …/components` **明确拒绝 MCP 引用（400）**
 * ——因为当前不存在任何真实 server，收到的 MCP id 必然是伪造/过期的，写进去就是
 * "永远修不好的孤儿绑定"（`ref_id` 是无 FK 的多态外键，数据库不会拦）。
 * 所以 UI 上既**不提供 MCP 勾选**，提交时也不带 MCP 项。
 *
 * ⚠️ 副作用要如实说：若某条 `MCP` 绑定**已经**存在（本阶段只能由手工写库产生），本页保存时
 * 会把它清掉 —— 因为整体替换的语义就是"提交的集合就是全部"。{@link mcpRefsOf} 负责把这件事
 * **显示出来**（编辑页的 MCP 区会给出警示条），而不是悄悄丢掉。
 */
export function submittableComponents(
  components: readonly { componentType: string; refId: string }[],
): AgentComponentInput[] {
  return components
    .filter((component) => component.componentType === 'KNOWLEDGE')
    .map((component) => ({ componentType: 'KNOWLEDGE' as const, refId: component.refId }))
}

/** 当前表单里的绑定（知识库多选 → 写侧形态） */
export function knowledgeSelectionOf(selectedIds: readonly string[]): AgentComponentInput[] {
  return selectedIds.map((refId) => ({ componentType: 'KNOWLEDGE' as const, refId }))
}

/** 从绑定集合里取出知识库 id 列表（供多选框的 `value`） */
export function knowledgeIdsOf(components: readonly { componentType: string; refId: string }[]): string[] {
  return components.filter((c) => c.componentType === 'KNOWLEDGE').map((c) => c.refId)
}

/** 从绑定集合里取出 MCP 引用（本阶段只可能由手工写库产生，见 {@link submittableComponents}） */
export function mcpRefsOf(
  components: readonly { componentType: string; refId: string }[],
): { componentType: 'MCP'; refId: string }[] {
  return components
    .filter((c) => c.componentType === 'MCP')
    .map((c) => ({ componentType: 'MCP' as const, refId: c.refId }))
}

// ───────────────────────────── 差异 → 请求体 ─────────────────────────────

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

function textChanged(fields: readonly TextField[], baseline: AgentFormValues, values: AgentFormValues): boolean {
  return fields.some(
    (field) => normalizeTextField(field, values[field]) !== normalizeTextField(field, baseline[field]),
  )
}

function guidesChanged(baseline: AgentFormValues, values: AgentFormValues): boolean {
  return !sameStrings(
    normalizeGuideQuestionsForSubmit(values.guideQuestions),
    normalizeGuideQuestionsForSubmit(baseline.guideQuestions),
  )
}

/**
 * 与"最后一次落库的快照"有差异的区块 —— 用于区块上的「未保存」标记。
 *
 * ⚠️ 新建态（快照 = {@link EMPTY_AGENT_FORM_VALUES}）下，用户一填名字 basic 就是"未保存"。
 * 这是**刻意的**：那时确实什么都还没落库。别为了"看起来干净"把新建态特判掉
 * —— 那会让"保存失败后哪些区块还没落库"这件事在新建态彻底不可见。
 */
export function changedSections(baseline: AgentFormValues, values: AgentFormValues): AgentSectionKey[] {
  const changed = new Set<AgentSectionKey>()
  if (values.name !== baseline.name || textChanged(BASIC_TEXT_FIELDS, baseline, values)) changed.add('basic')
  if (values.modelId !== baseline.modelId) changed.add('model')
  if (textChanged(PROMPT_TEXT_FIELDS, baseline, values) || guidesChanged(baseline, values)) changed.add('prompt')
  return AGENT_SECTIONS.filter((section) => changed.has(section))
}

/**
 * `PATCH /api/agents/:id` 的请求体：**只放真的变了的字段**（三态，见文件头）。
 * 没有任何字段变化时返回 `null` —— 调用方据此**不发这个请求**（少一次写，也少一次
 * "保存成功"其实什么都没改的误导）。
 */
export function buildUpdateBody(baseline: AgentFormValues, values: AgentFormValues): UpdateAgentBody | null {
  const body: UpdateAgentBody = {}

  if (values.name !== baseline.name) body.name = values.name.trim()
  for (const field of [...BASIC_TEXT_FIELDS, ...PROMPT_TEXT_FIELDS]) {
    if (normalizeTextField(field, values[field]) !== normalizeTextField(field, baseline[field])) {
      body[field] = nullableTextField(field, values[field])
    }
  }
  if (values.modelId !== baseline.modelId) body.modelId = values.modelId
  if (guidesChanged(baseline, values)) body.guideQuestions = normalizeGuideQuestionsForSubmit(values.guideQuestions)

  return Object.keys(body).length === 0 ? null : body
}

/** `POST /api/agents` 的请求体（新建时**字段一次给全**：那时还没有"原值"，三态不适用） */
export function buildCreateBody(values: AgentFormValues): CreateAgentBody {
  return {
    name: values.name.trim(),
    description: nullableTextField('description', values.description),
    icon: nullableTextField('icon', values.icon),
    type: values.type,
    systemPrompt: nullableTextField('systemPrompt', values.systemPrompt),
    openingRemarks: nullableTextField('openingRemarks', values.openingRemarks),
    guideQuestions: normalizeGuideQuestionsForSubmit(values.guideQuestions),
    modelId: values.modelId,
  }
}

/**
 * 一个 `PATCH` 请求体覆盖了哪些区块 —— 它失败时据此标注"哪个区块没保存成功"。
 *
 * `type` **不在请求体里**（`03` §4.2：创建后不可改），故它永远不会出现在这批区块里。
 */
export function sectionsOfUpdateBody(body: UpdateAgentBody): AgentSectionKey[] {
  const sections = new Set<AgentSectionKey>()
  if (body.name !== undefined || BASIC_TEXT_FIELDS.some((field) => body[field] !== undefined)) sections.add('basic')
  if (body.modelId !== undefined) sections.add('model')
  if (PROMPT_TEXT_FIELDS.some((field) => body[field] !== undefined) || body.guideQuestions !== undefined) {
    sections.add('prompt')
  }
  return AGENT_SECTIONS.filter((section) => sections.has(section))
}

// ───────────────────────────── 展示助手 ─────────────────────────────

/**
 * 时间格式化：`09-22 15:04`（与原型一致）。
 *
 * 刻意**不用 `toLocaleString`**：它的输出随运行环境（语言 / 时区 / ICU 版本）变化，而这个读数
 * 会被拿来与文档、截图对照 —— 一个本地化格式会让"这里显示的时间对不对"变成不可判的事。
 * 取本地时区这一点是刻意的（用户看的是自己机器上的时间）。
 */
export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
