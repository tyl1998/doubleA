/**
 * MCP 工具网关的**纯函数**层（P1-19）
 *
 * 依据：本批（"MCP 工具数量爆炸 ⇒ 渐进披露")的定案 —— 见 `shared/src/mcp.ts` 的
 * 「工具网关」段与 `backend/src/orchestrator/mcpGatewayTools.ts`（执行体）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一层回答三个问题，且**不碰任何运行期依赖**（同 `mcp/toolSchema.ts` 的取舍）
 * ─────────────────────────────────────────────────────────────────────
 *   ① {@link selectMcpInlineTools} —— 这一轮**哪些工具直接下发**、要不要开网关；
 *   ② {@link filterMcpToolEntries} —— 目录工具（`mcp_list_tools`）该回哪几条；
 *   ③ {@link formatMcpToolCatalog} —— 那些条目怎么排版成模型读得懂的文本。
 * 三者都是纯函数 ⇒ 断言不需要起 DB / Redis / 上游。调用方（`mcpCall.service.ts` 与
 * `orchestrator/mcpGatewayTools.ts`）只做 I/O 与拼装。
 */

import { MCP_LIST_TOOLS_MAX_RESULTS } from '@doubulea/shared'

/**
 * 一件**已被命名**的 MCP 工具（下发给模型的名字 + 它是谁 + 一行说明）。
 *
 * ⚠️ 它是目录/检索的**唯一事实来源**：`mcp_list_tools` 回给模型的就是它，`mcp_call_tool`
 * 用 `name` 反查路由。`name` 恒是下发给模型的（OpenAI）名字，`toolName` 是 MCP 侧**原始**名。
 */
export interface McpCatalogToolEntry {
  /** 下发给模型的名字（`mcp_{slug}_{tool}`，已去重/截断） */
  name: string
  serverId: string
  /** 展示名（目录里用来分组） */
  serverName: string
  /** MCP 侧**原始**工具名（`tools/call` 要原样回给它） */
  toolName: string
  /** 给模型看的说明（已按 {@link MCP_TOOL_DESCRIPTION_MAX} 截断过，与下发的工具同一份） */
  description: string
  /**
   * 参数的 **JSON Schema 原文**（= `tools/list` 里那份 `inputSchema`，经 P0-2-6 兼容处理后）。
   *
   * ⚠️ **网关模式下这是模型唯一的参数说明书**：走网关时真实工具定义不下发，模型只拿得到
   * 目录文本 + `mcp_call_tool` 的通用 `arguments`。若目录里不说清必填项，模型只能靠猜 ——
   * 2026-10-22 实测：上游把 `projectId` 注入成必填，网关模式的模型不知道，连调 4 次都被
   * 上游的闸门回 `-32601`。所以 {@link formatMcpToolCatalog} 必须从这里读出必填项。
   */
  inputSchema: unknown
  /** 危险工具（仅留档；目录里不暴露这个策略） */
  dangerous: boolean
}

/** {@link selectMcpInlineTools} 的结论 */
export interface McpInlineSelection {
  /** **直接下发**的工具名集合（其余走网关） */
  inline: Set<string>
  /** 是否有工具改走网关（= 模型需要用 `mcp_list_tools` 才能看到它们） */
  gatewayActive: boolean
}

/**
 * 「这一轮直接下发哪些 MCP 工具」（**唯一**策略点）。
 *
 * 规则（与 `config.mcp.inlineToolLimit` 的注释逐字对应）：
 *   · 全部工具数 ≤ `inlineLimit` ⇒ **全部直接下发**（`gatewayActive:false`，与旧行为一致）；
 *   · 超过 `inlineLimit` ⇒ 只直接下发 `pinnedNames` 里的（Agent 标的"常驻工具"），
 *     其余走网关（`gatewayActive:true`）；没有常驻 ⇒ 一个都不直接下发。
 *
 * ⚠️ `pinnedNames` 是**下发给模型的名字**（`entry.name`），不是 MCP 原始名 —— 由调用方
 * （`mcpCall.service.ts`，它手上有 server→原始名的映射与命名结果）负责翻译。
 * ⚠️ 常驻工具即使 `total ≤ inlineLimit` 也不再单独处理：那种情况下本来就全下发了。
 */
export function selectMcpInlineTools(
  entries: readonly McpCatalogToolEntry[],
  pinnedNames: ReadonlySet<string>,
  inlineLimit: number,
): McpInlineSelection {
  if (entries.length <= inlineLimit) {
    return { inline: new Set(entries.map((entry) => entry.name)), gatewayActive: false }
  }
  const inline = new Set<string>()
  for (const entry of entries) if (pinnedNames.has(entry.name)) inline.add(entry.name)
  return { inline, gatewayActive: true }
}

/** `mcp_list_tools` 的检索条件（两都可选；与 `shared#mcpListToolsArgsSchema` 同形） */
export interface McpToolSearchQuery {
  /** server 名或 id（大小写不敏感） */
  server?: string
  /** 关键词（工具名 / 原始名 / 描述 的包含匹配） */
  query?: string
}

/** {@link filterMcpToolEntries} 的结论 */
export interface McpToolCatalogPage {
  /** 实际列出的条目（≤ {@link MCP_LIST_TOOLS_MAX_RESULTS}） */
  entries: McpCatalogToolEntry[]
  /** **命中总数**（可能 > `entries.length` —— 超出部分未列出，要给模型明说） */
  total: number
}

/**
 * 检索用的**同义词组**（组内任一命中即算命中该词）。
 *
 * 依据（2026-10-22 实测）：模型常把意图写成一组同义词/中英混写 ——
 * `"delete environment 删除环境"`、`"remove"` 都 0 命中，而工具名其实是 `delete_environment`。
 * 整串子串匹配对这种输入毫无胜算，所以先分词、再对每个词做同义词归一。
 *
 * ⚠️ 刻意**不做**语义/向量检索：这只是一张 20 行的手写表（增删工具时顺手补），
 * 目的是"别让明显该命中的落空"，不是"理解用户想干什么"。
 */
const MCP_QUERY_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['delete', 'remove', 'drop', 'del', '删除', '移除', '清除'],
  ['create', 'add', 'new', 'upsert', 'insert', '新建', '创建', '添加'],
  ['update', 'edit', 'modify', 'patch', 'set', '修改', '更新', '编辑'],
  ['get', 'show', 'detail', 'read', '查看', '详情', '获取', '查询'],
  ['list', 'search', 'find', 'query', '列表', '搜索', '查找', '列出'],
  ['run', 'execute', 'exec', 'trigger', 'start', '运行', '执行', '触发'],
  ['stop', 'cancel', 'abort', '停止', '取消', '中断'],
  ['env', 'environment', 'environments', '环境', '环境变量'],
  ['case', 'cases', '用例', '测试用例'],
  ['endpoint', 'endpoints', 'api', '接口'],
  ['flow', 'flows', 'flowchart', '流程', '编排'],
  ['suite', 'suites', '套件', '测试集'],
  ['ci', 'task', 'tasks', 'pipeline', '任务', '流水线'],
  ['script', 'scripts', '脚本'],
  ['run', 'runs', 'execution', 'executions', 'report', '报告', '执行记录'],
  ['project', 'projects', '项目'],
  ['copy', 'clone', 'duplicate', '复制', '克隆'],
  ['log', 'logs', '日志'],
]

/** 同义词 → 组内全部词（**查表式的双向展开**：给 `remove` 也要能命中 `delete`） */
const MCP_QUERY_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map(
  MCP_QUERY_SYNONYM_GROUPS.flatMap((group) => group.map((word) => [word, group] as const)),
)

/** 分词用的分隔符（空白 + 常见标点；中英混写里也常出现逗号/斜杠/下划线） */
const MCP_QUERY_SEPARATORS = /[\s,，、;；/|()（）[\]【】"'`]+/u

/** 只有这些长度的"词"才被视为有效检索词（见 `expandMcpToolQueryTerms` 的过滤口径） */
const SINGLE_NOISE_WORD = /^[a-z0-9]$|^[^\p{L}\p{N}]+$/u

/**
 * 已知词表（同义词组的所有词）里**最长**的那个的长度 —— 中文切分时的窗口上限。
 * 中文没有空格，`"删除环境"` 必须被切成 `删除` + `环境` 才可能命中；窗口上限决定最多看几个字。
 */
const MCP_QUERY_MAX_WORD = Math.max(...[...MCP_QUERY_SYNONYMS.keys()].map((word) => [...word].length))

/**
 * 切一段（已小写、已按标点切开的）文本 → 词列表。
 *
 * **贪心最长匹配 + 回退单字**（面向中文这类无空格语言）：
 *   · `"删除环境"` 在词表里有 `删除`、`环境` ⇒ 切成两个词；
 *   · `"删除环境"` 里的 `删除环` 不在词表 ⇒ 不会切出来（避免把已有词切碎）；
 *   · 都不在词表 ⇒ 退化成**逐字**（`"环境"` 本身在词表里，能命中；纯未知串也能命中数字/字母片段）。
 *
 * ⚠️ 为什么不用 Intl.Segmenter：它按**通用**语言规则切（词典里没有我们的业务词），
 *    `删除环境` 在它眼里是一个词 —— 而我们要的是"能对上工具名里的英文词"。
 */
function segmentMcpQueryText(text: string): string[] {
  const chars = [...text]
  const words: string[] = []
  let i = 0
  while (i < chars.length) {
    let matched = ''
    for (let length = Math.min(MCP_QUERY_MAX_WORD, chars.length - i); length > 0; length -= 1) {
      const candidate = chars.slice(i, i + length).join('')
      if (MCP_QUERY_SYNONYMS.has(candidate)) {
        matched = candidate
        break
      }
    }
    // ⚠️ 连同一个"连续的字母/数字块"一起收：`list_endpoints` 这类整体标识符不该被拆成单字母，
    //    否则 `zzz` 会变成三个 `z`（见 `SINGLE_NOISE_WORD`）
    if (matched === '') {
      const run = /^[a-z0-9_]+/u.exec(chars.slice(i).join(''))?.[0] ?? ''
      if (run !== '' && run.length > 1) matched = run
      else if (run !== '') {
        // 单字母/单数字：**连同后面对齐的一段**一起吃（`zzz` → 一个词 `zzz`，而不是三个 `z`）
        const tail = /^[a-z0-9_]+/u.exec(chars.slice(i).join(''))?.[0] ?? run
        matched = tail
      }
    }
    if (matched === '') matched = chars[i] as string
    words.push(matched)
    i += [...matched].length
  }
  return words
}

/**
 * `query` → 检索单元列表（**每个单元是一组同义词**）。
 *
 * 四条口径：
 *   · **切分**：按空白与标点切开后，每段再走 {@link segmentMcpQueryText}（中文没有空格）；
 *   · **同义展开**：每个词换成它的整组（查不到就只保留自己）；
 *   · **去重**：多个词落在同一组时只保留一份（否则 AND 会重复要求同一件事）；
 *   · **丢空**：切完什么都没有 ⇒ 返回空数组（调用方按"不筛"处理）。
 */
export function expandMcpToolQueryTerms(keyword: string): string[][] {
  const words = keyword
    .toLowerCase()
    .split(MCP_QUERY_SEPARATORS)
    // ⚠️ 整段就是一个词表里的词 / 一个标识符（`delete_environment`、`remove`）⇒ **先按整段取**，
    //    不要走切分：切分会把 `delete_environment` 拆成 `delete` + `_environment`，虽然能命中，
    //    但会连带命中 `upsert_environment` 之类（相关性反而变差）。
    .flatMap((chunk) => (MCP_QUERY_SYNONYMS.has(chunk) || /^[a-z0-9_]{2,}$/u.test(chunk) ? [chunk] : segmentMcpQueryText(chunk)))
    .flatMap((chunk) => segmentMcpQueryText(chunk))
    .map((word) => word.trim())
    // ⚠️ 单个字母/数字/符号**不参与检索**：`zzz` 会被切成 `z`+`z`+`z`、`---` 切成孤儿标点，
    //    它们作为子串几乎命中一切（实测 59 个工具里命中 13~34 个）—— 那不是检索，是噪音。
    .filter((word) => word !== '' && !SINGLE_NOISE_WORD.test(word))
  const units: string[][] = []
  const seen = new Set<string>()
  for (const word of words) {
    const group = MCP_QUERY_SYNONYMS.get(word)
    const unit = group === undefined ? [word] : [...group]
    const key = [...unit].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    units.push(unit)
  }
  return units
}

/** 一条工具是否命中**一个**检索单元（任一别名出现在 名字/原始名/描述 里） */
function entryMatchesUnit(entry: McpCatalogToolEntry, unit: readonly string[]): boolean {
  const haystacks = [entry.name.toLowerCase(), entry.toolName.toLowerCase(), entry.description.toLowerCase()]
  return unit.some((word) => haystacks.some((text) => text.includes(word)))
  // ⚠️ 原始名先做一次"下划线→空格"归一不在这里做：`includes` 对 `delete_environment`
  //    已经能命中 `delete`；而把下划线换成空格反而会让 `upsert` 之外的两字词更容易误命中
}

/**
 * 目录工具（`mcp_list_tools`）的检索：先按 `server` 收窄，再按 `query` 检索，最后封顶。
 *
 * **`query` 的语义（2026-10-22 版）**：分词 + 同义词归一后**逐个单元 AND** ——
 * `"delete environment 删除环境"` = 「删除组」且「环境组」，正好把 `delete_environment` 捞出来，
 * 而不会因为整串匹配失败返回 0 条。
 *
 * ⚠️ **不静默截断**：`total` 一定回命中总数，调用方据此写「其余 N 个未列出」（同
 * `knowledgeTools.ts` 的目录口径）。`query` 为空 = 不筛（列全部，但仍受上限约束）。
 * ⚠️ **零命中的降级**：整串 `query` 一次 AND 也没命中、但**按整串子串**能命中时，用后者兜底 ——
 *    既保住老行为（精确串搜索），又不会让分词把原本能命中的查出来变成 0 条。
 */
export function filterMcpToolEntries(
  entries: readonly McpCatalogToolEntry[],
  query: McpToolSearchQuery,
): McpToolCatalogPage {
  const server = query.server?.trim().toLowerCase() ?? ''
  const keyword = query.query?.trim().toLowerCase() ?? ''
  const scoped = entries.filter((entry) => {
    if (server === '') return true
    const byId = entry.serverId.toLowerCase() === server
    const byName = entry.serverName.toLowerCase() === server
    return byId || byName
  })
  if (keyword === '') {
    return { entries: scoped.slice(0, MCP_LIST_TOOLS_MAX_RESULTS), total: scoped.length }
  }

  const units = expandMcpToolQueryTerms(keyword)
  // 切完一个词都不剩（例如整串都是标点）⇒ 视同"没给 query"，不要把所有工具都判成不匹配
  if (units.length === 0) {
    return { entries: scoped.slice(0, MCP_LIST_TOOLS_MAX_RESULTS), total: scoped.length }
  }
  const scored = scoped
    .filter((entry) => units.every((unit) => entryMatchesUnit(entry, unit)))
    // **相关度**：原始工具名精确等于整串 query（或包含它）的排最前 —— 用户/模型常常已经知道名字，
    // 这时"名字里就有这一串"比"描述里凑巧提到"更相关。
    .map((entry) => {
      const raw = entry.toolName.toLowerCase()
      // 相关度分三档（**名字 > 描述**是这里唯一的口径）：
      //   · 自身标识符里就带着整串 query（`delete_environment` ← `delete_environment`）⇒ 3，最前；
      //   · 名字命中全部检索单元 ⇒ 2（如 `delete environment` ← `delete_environment`）；
      //   · 只是描述里提到 ⇒ 1（`get_execution` 的描述里也有 "environment"）。
      // 不做这层排序时，描述里泛泛提到 env 的只读工具会排在真正要调的那个前面（实测）。
      const unitsInName = units.filter((unit) => unit.some((word) => raw.includes(word))).length
      const score = raw === keyword ? 4 : raw.includes(keyword) ? 3 : unitsInName === units.length ? 2 : 1
      return { entry, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry)
  let matched = scored
  if (matched.length === 0) {
    // 降级：老口径（整串子串）—— 保住"用户就是搜一个完整名字/片段"的场景
    matched = scoped.filter(
      (entry) =>
        entry.name.toLowerCase().includes(keyword) ||
        entry.toolName.toLowerCase().includes(keyword) ||
        entry.description.toLowerCase().includes(keyword),
    )
  }
  return { entries: matched.slice(0, MCP_LIST_TOOLS_MAX_RESULTS), total: matched.length }
}

/** 目录里**每行**参数清单的长度上限（码点）—— 目录是索引，但必填项一个都不能漏 */
const MCP_CATALOG_PARAMS_MAX = 300

/**
 * 目录文本的**字符预算**（不是条数上限）。
 *
 * 取值比工具结果回填上限（`TOOL_RESULT_MAX_CHARS` = 8000）小一截：给外层的 `truncateToolResult`
 * 留出余量（它还会拼截断标记），也避免"正好卡在边界上"时把最后一条的 JSON 劈开。
 */
const MCP_CATALOG_MAX_CHARS = 7000

/** 一条条目在目录文本里大致占多少字符（描述 + JSON schema + 前缀与换行） */
function entryCostChars(entry: McpCatalogToolEntry): number {
  let schemaChars: number
  try {
    schemaChars = JSON.stringify(entry.inputSchema)?.length ?? 0
  } catch {
    schemaChars = 64
  }
  return entry.name.length + entry.description.length + schemaChars + 24
}

/** `unknown` → 普通对象（数组 / null / 非对象一律不算） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 从 `inputSchema` 里读出来的一行参数摘要 */
interface McpToolParamsSummary {
  /** 顶层属性名（保持声明顺序） */
  names: string[]
  /** 必填项 */
  required: string[]
  /** `属性名: 枚举值` 的补充（只对短枚举展示） */
  enums: Map<string, string[]>
  /** `属性名: 类型描述`（`object` / `string` / `integer` / 对象嵌套等） */
  types: Map<string, string>
  /** `additionalProperties === false`（"只认这些参数"是有约束力的，必须告诉模型） */
  closed: boolean
}

/**
 * 一个 JSON Schema 属性 → **给模型看的类型描述**。
 *
 * ⚠️ 只覆盖"模型最容易做错"的几档，不做完整 schema 渲染：
 *   · `object` 一律写成 `object`（`Map<string,string>` 这种值类型也带上）——网关模式下
 *     这是"别把对象序列化成字符串"的唯一提醒（2026-10-22：`variables` 是 `object`，
 *     模型连传 3 次字符串，每次都要走一趟上游校验 + 一张确认卡）；
 *   · 数组写 `array<T>`、可空写 `T | null`、联合写 `a | b`。
 * 没声明类型的属性**不编一个**（缺 `type` 在 JSON Schema 里是真的"什么都收"）。
 */
function describeSchemaType(node: unknown, depth = 0): string {
  const schema = asRecord(node)
  if (schema === null) return ''
  if (depth > 2) return '…'
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (union !== null) {
    const parts = [...new Set(union.map((branch) => describeSchemaType(branch, depth + 1)).filter((part) => part !== ''))]
    return parts.length === 0 ? '' : parts.join(' | ')
  }
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null
  const declared = typeof schema.type === 'string' ? schema.type : null
  if (declared === 'object') {
    const values = describeSchemaType(schema.additionalProperties, depth + 1)
    const closed = schema.additionalProperties === false
    if (values !== '') return closed ? `object(Map<string,${values}>)` : `object<string,${values}>`
    return 'object'
  }
  if (declared === 'array') {
    const items = describeSchemaType(schema.items, depth + 1)
    return items === '' ? 'array' : `array<${items}>`
  }
  if (declared !== null) return declared
  if (enumValues !== null) {
    const first = enumValues.find((value) => typeof value === 'string' || typeof value === 'number')
    return first === undefined ? '' : typeof first === 'number' ? 'number' : 'string'
  }
  return ''
}

/**
 * 读 `inputSchema` 的顶层参数摘要（**不做 schema 推导**，只读模型真正需要知道的几样）。
 *
 * ⚠️ 为什么只读顶层：目录是"索引"，嵌套结构由工具自己的 schema 描述；网关能替模型补足的
 * 只有"**必填哪些、各是什么类型**"这两条 —— 而它们恰恰是网关模式丢掉信息最多的两处
 * （见 {@link McpCatalogToolEntry.inputSchema} 的注释）。
 */
function summarizeInputSchema(inputSchema: unknown): McpToolParamsSummary {
  const schema = asRecord(inputSchema)
  const properties = asRecord(schema?.properties) ?? {}
  const names = Object.keys(properties)
  const requiredRaw = Array.isArray(schema?.required) ? schema.required : []
  const required = requiredRaw.filter((key): key is string => typeof key === 'string' && names.includes(key))
  const enums = new Map<string, string[]>()
  const types = new Map<string, string>()
  for (const name of names) {
    const property = asRecord(properties[name])
    if (property === null) continue
    const type = describeSchemaType(property)
    if (type !== '') types.set(name, type)
    // 短枚举（≤ 8 条）值得直接摆出来：模型最常错的就是"填了不在取值域里的值"
    const values = Array.isArray(property.enum) ? property.enum : []
    if (values.length > 0 && values.length <= 8) {
      enums.set(
        name,
        values.filter((value) => typeof value === 'string' || typeof value === 'number').map(String),
      )
    }
  }
  return { names, required, enums, types, closed: schema?.additionalProperties === false }
}

/**
 * 一行参数清单（`必填 a: string, b: object; 可选 c: integer；c ∈ {x | y}`）。没有可说的参数时返回空串。
 *
 * ⚠️ **必填项与类型必须并列给出**：网关模式下模型看不到工具 schema，只靠这一行知道
 * "少了它会失败、给错类型也会失败"。
 */
function formatParamsLine(summary: McpToolParamsSummary): string {
  if (summary.names.length === 0) return summary.closed ? '（无参数）' : ''
  const requiredSet = new Set(summary.required)
  const withType = (name: string): string => {
    const type = summary.types.get(name)
    return type === undefined ? name : `${name}: ${type}`
  }
  const optional = summary.names.filter((name) => !requiredSet.has(name))
  const parts: string[] = []
  if (summary.required.length > 0) parts.push(`必填 ${summary.required.map(withType).join(', ')}`)
  if (optional.length > 0) parts.push(`可选 ${optional.map(withType).join(', ')}`)
  for (const [name, values] of summary.enums) parts.push(`${name} ∈ {${values.join(' | ')}}`)
  const text = parts.join('；')
  if ([...text].length <= MCP_CATALOG_PARAMS_MAX) return text
  /**
   * ⚠️ 超长时**不能整行硬截断**：工具多、参数多时（apitest 的 59 个工具里有的十几个参数），
   * 硬截断会先丢掉**必填段之后**的内容 —— 也就是类型与枚举，正好是模型最需要的部分。
   * ⇒ 分段按预算裁：必填段优先完整保留，可选段只保留"名字: 类型"里放得下的前几个并注明省略数，
   * 枚举段按剩余预算给（一个都给不下就整段省略，而不是留半截）。
   */
  const budget = MCP_CATALOG_PARAMS_MAX
  const kept: string[] = []
  let used = 0
  const push = (segment: string): boolean => {
    const cost = [...segment].length + (kept.length === 0 ? 0 : 1)
    if (used + cost > budget) return false
    kept.push(segment)
    used += cost
    return true
  }
  if (summary.required.length > 0) push(`必填 ${summary.required.map(withType).join(', ')}`)
  if (optional.length > 0) {
    // 可选参数逐个尝试，放不下的按"其余 N 个"汇总（不静默丢）
    const shown: string[] = []
    for (const name of optional) {
      const candidate = `可选 ${[...shown, withType(name)].join(', ')}`
      const cost = [...candidate].length + (kept.length === 0 ? 0 : 1)
      if (used + cost > budget) break
      shown.push(withType(name))
    }
    const remaining = optional.length - shown.length
    const segment =
      remaining === 0
        ? `可选 ${shown.join(', ')}`
        : shown.length === 0
          ? `另有 ${remaining} 个可选参数（用带该参数的调用即可，缺失不报错）`
          : `可选 ${shown.join(', ')}, 另有 ${remaining} 个`
    push(segment)
  }
  for (const [name, values] of summary.enums) push(`${name} ∈ {${values.join(' | ')}}`)
  return kept.join('；')
}

/**
 * 一次 `mcp_call_tool` 的**本地类型体检**结论。
 *
 * ⚠️ 它**不是**完整 JSON Schema 校验（没有 `$ref`、`allOf`、`pattern`、数值区间…）——
 * 只覆盖"网关模式最容易让模型走错路"的几条：**必填缺失**、**顶层类型不符**（尤其
 * "对象/数组被序列化成字符串"）。目的不是代替上游校验，而是把"上游一句
 * `data/variables must be object`" 翻成模型一次就能改对的话，并省掉一次上游往返和一张确认卡。
 */
export type McpArgumentIssue =
  | { kind: 'MISSING'; path: string; expected: string }
  | { kind: 'TYPE'; path: string; expected: string; actual: string }

/** `unknown` → 人读的类型名（与 `describeSchemaType` 的词汇对齐） */
function actualTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  return typeof value
}

/** 声明的 `type` → 值是否算"这一档"（`integer` 接受整数；`number` 接受任何数） */
function valueSatisfiesType(value: unknown, declared: string): boolean {
  const actual = actualTypeOf(value)
  if (declared === 'integer') return actual === 'integer'
  if (declared === 'number') return actual === 'integer' || actual === 'number'
  return actual === declared
}

/**
 * 把一串 {@link McpArgumentIssue} 写成模型读得懂的一段话（含"你给的是什么"）。
 *
 * 三段结构（与 `TOOL_CONFIRM_REJECTED_OUTPUT` 同族：先结论、再说怎么改）：
 *   ① 一句"没有发出去"（模型必须知道这不是上游的失败，改完可以立刻重发）；
 *   ② 每条问题的 `参数名` + 期望类型 + 实际类型；
 *   ③ 一条通用的"对象/数组要直接给字面量，不要 JSON 序列化"提醒。
 */
export function formatArgumentIssues(issues: readonly McpArgumentIssue[]): string {
  const lines = issues.map((issue) => {
    if (issue.kind === 'MISSING') return `- 缺少必填参数 ${issue.path}（应为 ${issue.expected}）`
    return `- 参数 ${issue.path} 应为 ${issue.expected}，实际给的是 ${issue.actual}`
  })
  return [
    `工具调用未发出：参数与工具声明的类型不符（共 ${issues.length} 处）。请修正后用相同的工具名再调用一次。`,
    ...lines,
    '提示：object / array 参数要在 arguments 里直接给 JSON 字面量（例如 "variables": {"k": "v"}），',
    '不要把它序列化成字符串（"{\\"k\\": \\"v\\"}" 是 string，不是 object）。',
  ].join('\n')
}

/**
 * 按工具自己的 `inputSchema` 做**少量**参数体检（判据见 {@link McpArgumentIssue}）。
 *
 * 返回空数组 = 没发现问题（**不代表**上游一定接受：这里刻意只拦"明显必错"的那些，
 * 其余交给上游 —— 把不完整校验当成防火墙会让合法调用被本地拒掉，比不做更糟）。
 */
export function findMcpArgumentIssues(
  inputSchema: unknown,
  args: Readonly<Record<string, unknown>>,
): McpArgumentIssue[] {
  const schema = asRecord(inputSchema)
  if (schema === null) return []
  const properties = asRecord(schema.properties) ?? {}
  const issues: McpArgumentIssue[] = []

  const requiredRaw = Array.isArray(schema.required) ? schema.required : []
  for (const key of requiredRaw) {
    if (typeof key !== 'string') continue
    if (args[key] === undefined || args[key] === null) {
      issues.push({ kind: 'MISSING', path: key, expected: describeSchemaType(properties[key]) || '已声明' })
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const property = asRecord(properties[key])
    if (property === null || value === null || value === undefined) continue
    const union = Array.isArray(property.anyOf) ? property.anyOf : Array.isArray(property.oneOf) ? property.oneOf : null
    const declaredTypes =
      union !== null
        ? union
            .map((branch) => asRecord(branch)?.type)
            .filter((type): type is string => typeof type === 'string')
        : typeof property.type === 'string'
          ? [property.type]
          : []
    if (declaredTypes.length === 0) continue
    if (declaredTypes.some((declared) => valueSatisfiesType(value, declared))) continue
    issues.push({
      kind: 'TYPE',
      path: key,
      expected: describeSchemaType(property) || declaredTypes.join(' | '),
      actual: actualTypeOf(value),
    })
  }
  return issues
}

/**
 * 把检索结果排版成模型读得懂的**目录文本**（按 server 分组）。
 *
 * 四条口径：
 *   · **工具名原样给出**（`entry.name`）—— 模型要拿它去调 `mcp_call_tool`，改一个字符就调不到；
 *   · 每条只给**截断到一行**的描述（{@link MCP_LIST_TOOLS_ENTRY_DESCRIPTION_MAX}）：目录是"索引"
 *     不是"说明书"，完整描述在真的调用时才需要；
 *   · 但**参数必填项必须列出**（{@link formatParamsLine}）：网关模式下真实工具定义不下发，
 *     这一行是模型唯一的参数说明书 —— 缺了它模型只能猜（2026-10-22 的 `projectId` 事故）；
 *   · 命中数超上限 / 为空时**明说**（不静默省略、不假装"没有工具"）。
 */
export function formatMcpToolCatalog(page: McpToolCatalogPage): string {
  if (page.total === 0) {
    return '没有匹配的 MCP 工具。可以换一个关键词，或不带 query 再列一次看看有哪些工具。'
  }
  /**
   * ⚠️ **按预算截条数，而不是事后截字符串**（2026-10-22）：
   * 每条工具现在带完整 `inputSchema`（约 200~2000 字符），59 个工具约 53K 字符，
   * 而工具结果回填上限是 8000 字符（`TOOL_RESULT_MAX_CHARS`）—— 事后硬截会把最后一条
   * 的 JSON 劈成半截，模型拿到**非法 JSON** 比没有更糟。
   * ⇒ 这里自己按条装箱：装不下就停，并明确告诉模型"还有 N 条，请用 query 缩小"。
   */
  const shown: McpCatalogToolEntry[] = []
  let budget = MCP_CATALOG_MAX_CHARS
  for (const entry of page.entries) {
    const cost = entryCostChars(entry)
    if (shown.length > 0 && cost > budget) break
    shown.push(entry)
    budget -= cost
  }

  const byServer = new Map<string, McpCatalogToolEntry[]>()
  for (const entry of shown) {
    const list = byServer.get(entry.serverName) ?? []
    list.push(entry)
    byServer.set(entry.serverName, list)
  }

  const lines: string[] = []
  if (page.total > shown.length) {
    lines.push(`共匹配 ${page.total} 个工具，以下列出 ${shown.length} 个（其余请用 query 缩小范围后再列）：`)
  } else {
    lines.push(`共 ${page.total} 个工具：`)
  }
  for (const [serverName, list] of byServer) {
    lines.push(`【${serverName}】`)
    for (const entry of list) {
      // 描述**不截断**：搜索返回的就是这个工具的完整信息（含下面的 inputSchema），
      // 截断会让模型读不到约束原文（`variables` 的说明正是被截掉的那一段，2026-10-22 实测）。
      const desc = entry.description === '' ? '' : `：${entry.description}`
      lines.push(`- ${entry.name}${desc}`)
      lines.push(`  inputSchema: ${formatInputSchemaJson(entry.inputSchema)}`)
    }
  }
  if (page.total > shown.length) {
    lines.push(`（其余 ${page.total - shown.length} 个未列出，请用更具体的 query 再列一次。）`)
  }
  lines.push(
    '要调用某个工具，用 mcp_call_tool：name 填上面的工具名，arguments 必须是该工具 inputSchema 描述的对象' +
      '（必填项必须给；object / array 直接给 JSON 字面量，不要序列化成字符串）。',
  )
  return lines.join('\n')
}

/**
 * 一条工具的 `inputSchema` → **单行 JSON**（内嵌进目录文本）。
 *
 * ⚠️ 为什么是 JSON 而不是再写一行"必填 a: string"：模型要做的是**按 schema 生成参数**，
 * 压缩成人读摘要会丢信息（类型、`additionalProperties`、嵌套、描述），而 2026-10-22 的事故
 * 正是"摘要里看不出 `variables` 必须是 object"。JSON 是模型最擅长的形态，且**无损**。
 * ⚠️ 单行（`JSON.stringify` 无缩进）：目录是给模型读的文本，多行 JSON 会把它撑爆且难对照；
 * 单行仍合法、可解析。序列化失败（循环引用等脏数据）⇒ 退回可读摘要，绝不抛。
 */
function formatInputSchemaJson(inputSchema: unknown): string {
  try {
    const text = JSON.stringify(inputSchema)
    if (typeof text === 'string' && text !== '') return text
  } catch {
    // 落到下面的兜底
  }
  const params = formatParamsLine(summarizeInputSchema(inputSchema))
  return params === '' ? '{"type":"object","properties":{}}' : JSON.stringify({ summary: params })
}
