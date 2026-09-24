/**
 * MCP `inputSchema` → OpenAI function 转换（**P0-2-6**）
 *
 * 依据：`06` §四 P0-2-6 + `02` §9.7。
 * 消费方是 **P0-2-8** 的编排循环（本批只交纯函数，**不接线** —— 与 `mcp/toolCache.ts`、
 * `pipeline/chunk/` 同款：本模块**不 import 任何运行期模块**（不碰 config / prisma / 日志 / SDK），
 * 于是它的断言不需要起依赖）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么"只做三件兼容处理"，而不是顺手把 schema 理顺
 * ─────────────────────────────────────────────────────────────────────
 * `06` P0-2-6 的坑预判 1 是一条**产品级**判断：**丢掉的约束会让模型传错参数，而报错发生在服务端**
 * —— 用户看到的是"这个工具调用失败"，错因却在平台。所以这里**主动裁剪 schema 是禁止的**，
 * 只做三件各自有理由的事：
 *   ① 剥 `$schema` —— 它只是**这份 schema 自己的方言声明**（`draft-07` 之类），对"参数长什么样"
 *      零信息量，而 OpenAI 的 `parameters` 位置不接受它；
 *   ② 缺 `type` 时补 `'object'` —— 缺 `type` 的 JSON Schema 在语义上"什么都接受"，但**必须**声明成
 *      object 才是合法的 `parameters`；
 *   ③ 非 object 根**包一层** —— 见 {@link MCP_TOOL_WRAPPER_KEY} 的注释（含"为什么明知会调失败还要包"）。
 * ⚠️ `additionalProperties` / `required` / `items` / `enum` / 嵌套 `$ref` 一律**原样透出**：
 * `additionalProperties: false` 是**有约束力的**（不是元信息），把它当"元信息"一起清掉
 * 会让"这个工具只认这两个参数"这条约束静默消失。
 */

import {
  MCP_TOOL_DESCRIPTION_MAX,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_NAME_PREFIX,
  MCP_TOOL_WRAPPER_KEY,
  type McpToolDescriptor,
} from '@doubulea/shared'

/** 出一个 server 的 slug 之外还**必须要 `id`**：见 {@link McpToolRoute} 的注释 */
export interface McpServerRef {
  id: string
  /** 工具名前缀的来源；**创建时派生、之后不再变**（`02` §9.1 ④） */
  slug: string
}

/** OpenAI 侧的一个工具（`tools` 数组的元素） */
export interface OpenAiFunctionTool {
  type: 'function'
  function: {
    /** 下发给模型的名字（`mcp_{slug}_{toolName}` 截断 + 去重后） */
    name: string
    /** 给模型看的说明（缺失时兜到 title，再兜到空串；超长按码点截断） */
    description: string
    /** JSON Schema，**object 根** */
    parameters: Record<string, unknown>
  }
}

/**
 * 反向映射表的一行：**OpenAI 名 → 要调哪个 server 的哪个工具**。
 *
 * ⚠️ 它是"名字 → 工具"的**唯一事实来源**（`06` P0-2-6 坑预判 4）：模型回 `tool_calls` 时只给名字，
 * **绝不能**在编排层"从名字里 split 出服务端"—— `slug` 里可能含 `_`（`a_b-2` 这种），
 * 且 `toolName` 自己也常含 `_`（MCP 工具名普遍是 `snake_case`），split 出来的"服务端"十有八九是错的。
 * ⚠️ 这里存 **`serverId` 而不是 `slug`**：P0-2-7 要按 `(serverId, userId)` 取凭据、P0-2-8 要按 id
 * 找 server —— 只给 slug 的话调用方还得自己再查一次库，白白多一次 round-trip 与一个出错点。
 * （这也是本函数第 1 参从文档写的 `serverSlug` 升级成 `{ id, slug }` 的**唯一原因**，见 `06` 落地要点。）
 */
export interface McpToolRoute {
  /** MCP 侧的**原始**工具名（`tools/call` 要原样回给它，不是我们改写过的那个） */
  toolName: string
  serverId: string
}

/** {@link toOpenAiTools} 的产出 */
export interface OpenAiToolConversion {
  tools: OpenAiFunctionTool[]
  /** 名字 → 路由；`Object.keys(routes)` 与 `tools.map(t => t.function.name)` **逐字同序同集合** */
  routes: Record<string, McpToolRoute>
  /**
   * 被 `limit` 截断时的实况（`{ total, kept }`），没截断是 `null`。
   *
   * ⚠️ 为什么由**调用方**打日志而不是在这里打：本模块零依赖（不 import 日志）。
   * `06` 的验收门槛写的是"超过 `MCP_TOOL_LIMIT` **截断并告警**"⇒ 告警落点在 P0-2-8 的调用点：
   * `if (conversion.truncated) logger.warn({ serverId, ...conversion.truncated }, '…')`。
   * ⚠️ 但它**不能**只在日志里：界面/工具卡片那一侧要能知道"这个 server 的工具没全下发"，
   * 所以它必须在**返回值**里，而不是像时间戳那样靠副作用。
   */
  truncated: { total: number; kept: number } | null
}

/**
 * MCP 工具列表 → OpenAI function 列表 + 反向映射表。
 *
 * @param server    目标 server（要 `id` 与 `slug` 两样，理由见 {@link McpToolRoute}）
 * @param tools     `tools/list` 的产出（P0-2-1 的 `McpToolDescriptor`，`inputSchema` 是原样的 `unknown`）
 * @param limit     单个 server 进 function 列表的工具数上限（`config.mcp.toolLimit`，即 `MCP_TOOL_LIMIT`）
 * @param taken     已经被**别的**来源占用的名字（跨 server 拼装工具列表时传入）。
 *                  ⚠️ 跨 server 的唯一性只能在这里兜（`slug` 列刻意不加唯一约束、
 *                  纯中文名还会整串折成 `server`），所以 P0-2-8 拼多个 server 时必须**依次**把
 *                  前一个的 `routes` 键喂进来，否则两个 server 的同名工具会撞成一个名字。
 */
export function toOpenAiTools(
  server: McpServerRef,
  tools: readonly McpToolDescriptor[],
  limit: number,
  taken?: Iterable<string>,
): OpenAiToolConversion {
  const total = tools.length
  // ⚠️ `config` 那一侧已由 `intVar` 保证落在 1..512；这里只是纯函数的自我保护，口径写死如下：
  //    `NaN` ⇒ 0（**宁可全截断，也不静默全放行** —— "上下文被几十个工具的 schema 塞爆"是难查的一类问题，
  //    而"一个工具都没给出"至少是能看见的）；`Infinity` ⇒ 不截断（显式的"无上限"）。
  const keep = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : limit === Number.POSITIVE_INFINITY ? total : 0
  const picked = tools.slice(0, keep)

  const used = new Set<string>(taken ?? [])
  const out: OpenAiFunctionTool[] = []
  const routes: Record<string, McpToolRoute> = {}

  for (const tool of picked) {
    const name = disambiguate(buildToolName(server.slug, tool.name), used)
    used.add(name)
    out.push({
      type: 'function',
      function: {
        name,
        description: toDescription(tool),
        parameters: toParameters(tool.inputSchema),
      },
    })
    // 名字恒以 `mcp_` 开头 ⇒ 不会撞上 `Object.prototype` 的键（constructor / toString…），
    // 所以这里用普通对象当映射表是安全的（P0-2-8 直接 `routes[name]` 取值）
    routes[name] = { toolName: tool.name, serverId: server.id }
  }

  return {
    tools: out,
    routes,
    truncated: keep < total ? { total, kept: picked.length } : null,
  }
}

/**
 * 非 `[A-Za-z0-9_-]` 的字符一律折成 `_`（不是**删掉**）。
 *
 * 为什么折而不删：删掉会让 `a.b` 与 `ab` 变成同一个名字（虽然序号兜得住，但那是把一个
 * "有区分度"的名字换成"靠顺序区分"的名字，映射表读起来也更容易让人看错）。折成 `_`
 * 至少保住了字符数，肉眼能看出"这里原来有个特殊字符"。
 */
function sanitizeToolName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** `mcp_{slug}_{toolName}` → 清洗字符集 → 截断到 {@link MCP_TOOL_NAME_MAX} */
function buildToolName(slug: string, toolName: string): string {
  // ⚠️ 不假设 `slug` 一定合法：它来自库里的一列（历史行 / 手工改库 / 将来的迁移都可能越界），
  //    而 `slugifyServerName` 只保证"**创建那一刻**产出的值是合法的"。整串统一过一遍最省心。
  return sanitizeToolName(`${MCP_TOOL_NAME_PREFIX}${slug}_${toolName}`).slice(0, MCP_TOOL_NAME_MAX)
}

/**
 * 名字去重：未被占用就用 `base`，否则依次试 `base-2`、`base-3`…
 *
 * ⚠️ 截断与序号必须**一起做**：只截断不做序号 ⇒ 两个长名字截断后撞在一起（后者**静默覆盖**前者，
 * 模型永远调不到它）；只做序号不截短 ⇒ 后缀被截掉，等于没加。所以这里**先按后缀长度截短 base**
 * （手法与 `shared#uniqueSlug` 逐字同款 —— 同一个问题在 slug 那一侧已经踩过）。
 */
function disambiguate(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const head = base
      .slice(0, Math.max(1, MCP_TOOL_NAME_MAX - suffix.length))
      .replace(/-+$/, '')
    const candidate = `${head}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * 给模型看的说明：`description` → `title` → `''`，超长按**码点**截断。
 *
 * ⚠️ 用 `title` 兜底不算"编造"：它是服务端自己给的**人读标题**，本来就是同一条信息；
 * 反过来——模型对一个只有名字的工具几乎必然传错参数，而"空 description"是**最贵**的一种省事。
 * ⚠️ 按码点（`[...str]`）而不是 `String.prototype.slice`：后者按 UTF-16 码元切，会把代理对
 * 劈成两半、产出非法字符串，而**这一层毫无报错**（P0-1-18 的老坑）。
 */
function toDescription(tool: McpToolDescriptor): string {
  const raw = tool.description ?? tool.title ?? ''
  // UTF-16 长度 ≤ 码点数 ⇒ 长度没超上限时一定没超，省掉一次整串展开
  if (raw.length <= MCP_TOOL_DESCRIPTION_MAX) return raw
  return [...raw].slice(0, MCP_TOOL_DESCRIPTION_MAX).join('')
}

/** `typeof x === 'object' && x !== null && !Array.isArray(x)`（值来自 JSON，不必防 Date/Map） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * MCP 的 `inputSchema` → OpenAI `parameters`（object 根）。三件处理各自的理由见文件头。
 *
 * ⚠️ 全是**浅拷贝**（`{ ...schema }`）：只删顶层 `$schema`、只补顶层 `type`，
 * 嵌套的 `additionalProperties` / `required` / `definitions` 一个都不动。
 */
function toParameters(inputSchema: unknown): Record<string, unknown> {
  // 不是普通对象（`null` / 数组 / 字符串 / 布尔）⇒ 它**不是合法的 JSON Schema**。
  // 这里不编造内容，退回"这个工具不接受参数"—— 比丢掉整个工具好（用户还能在工具卡片里
  // 看到原始值并去修服务端），也比塞一个 `{}`（"什么都接受"）更接近事实。
  if (!isPlainObject(inputSchema)) return { type: 'object', properties: {} }

  const schema: Record<string, unknown> = { ...inputSchema }
  delete schema.$schema

  // `type` 恰好是 `'object'` 才算 object 根。⚠️ `['object','null']` 这类**联合 type** 也算非 object：
  // OpenAI 的 `parameters` 不接受数组形式，包一层是唯一不会静默出错的处置（保守但安全）。
  if (schema.type !== undefined && schema.type !== 'object') {
    return {
      type: 'object',
      properties: { [MCP_TOOL_WRAPPER_KEY]: schema },
      required: [MCP_TOOL_WRAPPER_KEY],
    }
  }

  // 缺 `type`：语义上"什么都接受"，但 `parameters` 必须声明成 object
  if (schema.type === undefined) schema.type = 'object'
  return schema
}
