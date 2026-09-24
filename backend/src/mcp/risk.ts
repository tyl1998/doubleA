/**
 * MCP 工具的危险判定（**P0-2-9**）
 *
 * 依据：`01` 决策 22（"tool annotations 的 `destructiveHint` → **平台侧强制确认**，
 * 不依赖 server 主动发起 elicitation"）+ `02` §9.9（**判定表本身就是契约**）。
 *
 * 消费方是 **P0-2-10** 的确认流（`chatBot.ts` 工具循环里"取凭据 / 发 `RUNNING` 卡**之前**"那一处
 * 的挂起）；判定结果已经由 `mcp/toolSchema.ts#toOpenAiTools` 算好挂在 `McpToolRoute.dangerous` 上
 * —— 那一处手上只有"模型回的工具名"和这张映射表，没有工具描述符。
 *
 * ⚠️ 本模块**只有一条 `import type`**，不 import 任何运行期模块（不碰 config / prisma / 日志 / SDK）
 * —— 与 `mcp/toolCache.ts` / `mcp/toolSchema.ts` 同款：于是它的**真值表断言不需要起任何依赖**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 判定表（**"安全"只有一种形状**）
 * ─────────────────────────────────────────────────────────────────────
 * 只有两个 hint 参与判定，每个的取值域是 `{true, false, 缺失}`（"非布尔值"归到**缺失**，见下）：
 *
 * | `readOnlyHint` | `destructiveHint` | 结论 | 理由 |
 * |---|---|---|---|
 * | 缺失 | 缺失 | **危险** | 保守：服务端**没说**它是只读的，我们替它猜"安全"是把风险转移给用户 |
 * | 缺失 | `false` | **危险** | `false` 只说"不是破坏性的"，推不出"只读"（可能是新增/追加） |
 * | 缺失 | `true` | **危险** | 明说破坏性 |
 * | `false` | 缺失 | **危险** | 明说"会写" |
 * | `false` | `false` | **危险** | 明说"会写、但不是破坏性的"—— 会写就够了（保守） |
 * | `false` | `true` | **危险** | 明说"会写、且破坏性" |
 * | `true` | 缺失 | **安全** | 服务端明确声明只读（规范里 `destructiveHint` 此时"无意义"，见下） |
 * | `true` | `false` | **安全** | 同上（两个声明互相印证） |
 * | `true` | `true` | **危险** | **自相矛盾**的声明（只读却破坏性）⇒ 保守取胜 |
 *
 * 等价的一句话判据：**`readOnlyHint === true` 且 `destructiveHint !== true` ⇒ 安全，其余一律危险。**
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条刻意的取舍（每一条都在防一种"以为安全、其实没有"）
 * ─────────────────────────────────────────────────────────────────────
 * ① ⚠️ **`annotations` 是服务端"自报"的 —— 不是事实、也不可信**：一个恶意（或只是粗糙）的 server
 *    只要声明 `readOnlyHint: true` 就能让它的删除操作绕过确认卡。**P0 的边界就到这里** ——
 *    平台侧的"强制名单 / 逐工具策略（管理员按 server+tool 钉死危险）"属 **P1**，见 `02` §十。
 *    本模块做的事因此**不是**"识别危险工具"，而是"**在没有可信信息时按危险处理**"。
 * ② ⚠️ **判定的输入是"这个工具"，不是"这个 server"**（`06` P0-2-9 坑预判 2）：同一台 server 里
 *    既可能有只读查询、也可能有删除操作 ⇒ 判定只能逐工具做。这也是它挂 `McpToolRoute`（一行 = 一个工具）
 *    而不是挂在 server 上的理由。
 * ③ ⚠️ **`idempotentHint` 与 `openWorldHint` 不进判定表**（哪怕规范里有它们）：前者只说"同参数重复调用
 *    没有额外副作用"（**删两次**照样是破坏性的），后者只说"会与外部实体交互"（一个只读的联网查询也是
 *    `openWorldHint: true`）⇒ 两者都**推不出**"安全"，而本表的口径是"**拿不准就确认**"。
 *    `06` P0-2-9 的验收写"三个 hint 各自的组合"，本节的真值表对这两个 hint 是**显式的不变量**：
 *    无论它们取什么值，结论都不变（核查脚本里有一组专门盯它）。
 * ④ ⚠️ **严格 `=== true`，不做真值转换**：`"true"` / `1` / `"1"` / `{}` 一律按**缺失**处置
 *    （`annotations` 在契约里是 `z.record(z.unknown())` —— 值可以是任何东西）。
 *    `Boolean(x)` / `x == true` 这类宽松写法会让一个**拼错类型的服务端**静默获得"只读"资格，
 *    而症状正好是"确认卡该弹没弹" —— 唯一一种用户永远发现不了的故障。
 */

import type { McpToolDescriptor } from '@doubulea/shared'

/** `readOnlyHint` 的规范键名（写成常量只为"判定表里出现的名字只有一处"） */
const HINT_READ_ONLY = 'readOnlyHint'
/** `destructiveHint` 的规范键名 */
const HINT_DESTRUCTIVE = 'destructiveHint'

/**
 * {@link isDangerousTool} 的输入 —— **结构类型**，只要"能给出 `annotations`"就行。
 *
 * 刻意不写成 `McpToolDescriptor`：那一份还要求 `name` / `inputSchema` / `hasOutputSchema` 等五列，
 * 而判定一个字节都用不到（用不到的东西进签名 = 调用方要为了满足类型而**伪造**数据）。
 * `McpToolDescriptor` 天然可赋给它（`annotations: Record<string, unknown> | null`）。
 * ⚠️ 值的类型**从契约派生**（`McpToolDescriptor['annotations']`）而不是手抄一遍：
 * 契约里 `annotations` 换了形状时，这里跟着动，不会留下"两处各写一份、必有一处先腐烂"的缺口。
 */
export interface McpToolAnnotationsCarrier {
  /** MCP `Tool.annotations`；缺失 / `null` / 非对象一律按"服务端没声明"处置（⇒ 危险） */
  annotations?: McpToolDescriptor['annotations']
}

/**
 * 这个工具要不要走平台的确认流。**保守口径**：读不出"明确只读"就返回 `true`。
 *
 * ⚠️ 返回 `true` **不等于**"这个工具是破坏性的"，而是"**我们没有足够的可信信息放它过去**"
 * —— 判据是"拿不准就确认"。所以它**不能**被当成"危险工具清单"来用（比如拿去做界面标记）；
 * 界面上"要不要提示"是另一件事（P0-2-11），别复用这个布尔。
 */
export function isDangerousTool(tool: McpToolAnnotationsCarrier): boolean {
  const annotations = tool.annotations
  // `null` / `undefined` / 数组 / 字符串… 都落进这里 —— 判定表的"缺失"一行不是"理论情况"，
  // 而是任何一台没写 annotations 的 server（MCP 里它是可选的）的**常态**
  if (!isPlainObject(annotations)) return true

  if (annotations[HINT_READ_ONLY] !== true) return true
  // 走到这里 = 明确只读。此时若它又声明了"破坏性"，那是**自相矛盾** ⇒ 保守取胜
  if (annotations[HINT_DESTRUCTIVE] === true) return true
  return false
}

/**
 * `typeof x === 'object' && x !== null && !Array.isArray(x)`
 *
 * ⚠️ 不接受数组：`z.record()` 在 SDK 那一侧已经把数组判成"不合法"落成 `null`，但本函数是
 * **最后一道**，（历史缓存里的）原始 JSON 也可能直接喂进来 ⇒ 在这里再挡一次比"信任上游投影"便宜。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
