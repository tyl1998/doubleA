/**
 * 上下文组装（P0-1-27）—— **纯函数**，可进无依赖档
 *
 * 依据：`docs/02-后端设计.md` §六 第 2 步「组装上下文」：
 * ```
 * system  = agent.system_prompt + 检索块（绑定 KB 逐库混合检索，拼「来源：文档名」前缀）
 * history = 最近 20 轮 messages（含工具调用结构化还原）
 * user    = content + 附件（附件属 P1，本版本只有文本）
 * ```
 *      + `01` 决策 12（知识库引用：**未命中时不编造引用**）+ `03` §五（事件 → UI 的单一渲染路径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件：**这些函数是"错了很难查"的那一半**
 * ─────────────────────────────────────────────────────────────────────
 * 上下文组装的错法都很安静：system prompt 少了一段 ⇒ 模型开始编造来源；检索块格式错了 ⇒
 * 回答里引用的是"文档名"但检索片段没进去；历史截断错一格 ⇒ 多轮对话答非所问。
 * 它们**全都没有 HTTP 表现**（流照常结束、状态码 200），所以必须由**纯函数断言**守着
 * （`verify:app` 的"上下文组装"一节，见 `06` P0-1-18 的"能无依赖验的纯逻辑别粘依赖"）。
 * 于是本文件**不 import 任何运行期模块**（`import type` 会被 `verbatimModuleSyntax` 抹掉）：
 * `config` / `prisma` / 日志一律不碰 —— 用到 `config` 的部分留在 `chatBot.ts`。
 *
 * ⚠️ 唯一一处**运行期** import 是 `@doubulea/shared` 的 `toolCallRecordSchema`（P0-2-8）——
 * 它没有任何副作用、也不碰上面那三样，而"历史里的 `tool_calls` 长什么样"**必须**与写入端
 * 共用同一个 schema（自己再写一遍收窄逻辑就是两处一起腐烂的开端）。
 * 先例：同为零依赖档的 `mcp/toolCache.ts` 也这么用 `mcpToolDescriptorSchema`。
 */

import {
  toolCallRecordSchema,
  type ArtifactItem,
  type CitationItem,
  type MessageContent,
  type RetrievalHit,
  type ToolCallRecord,
} from '@doubulea/shared'

import type { ChatMessage, ChatToolCall } from '../llm/client.js'

// ═════════════════════════════════════════════════════════════════════
// system prompt
// ═════════════════════════════════════════════════════════════════════

/**
 * 智能体没写 system prompt 时的兜底。
 *
 * 为什么必须有兜底：`agents.system_prompt` 可空（P0-1-22 定案它是**三态**字段，
 * "清空"是合法状态）。空 system prompt 会让模型在"你是知识库助手"与"你是通用助手"之间摇摆 ——
 * 而下面那段规则（不许编造来源）**必须**有一个"当前场景"作为载体。
 */
export const DEFAULT_SYSTEM_PROMPT = '你是一个乐于助人的智能助手，请使用中文回答用户的问题。'

/**
 * 检索使用的规则（**每一轮都注入**，无论有没有命中）。
 *
 * ⚠️ 这是 `01` 决策 12「未命中时不编造引用」在 **prompt 层**的落点 —— 它和"不发 `citations`
 * 事件"是这条要求的**两半**，缺一半都只是治表面：
 *   · 只做"不发引用卡" ⇒ 模型照样会在正文里写"根据《XX制度》…"（凭空造一个文档名），
 *     而界面上没有引用卡 ⇒ 用户看到的是**一段看起来有出处、其实没有的回答**；
 *   · 只做 prompt 约束 ⇒ 模型偶尔还是会编，引用卡是用户唯一能核对的东西。
 */
export const RETRIEVAL_RULES = [
  '回答用户问题时，如果使用了下方「知识库检索结果」中的内容，请以「来源：文档名」的形式在相应位置标注。',
  '如果「知识库检索结果」为空或其中没有与问题相关的内容，请直接说明知识库中没有找到依据，不要推测、不要编造文档名或来源。',
].join('\n')

/** 检索块的标题（**同时**用于 prompt 与断言：这条标题是"检索块有没有进去"的可观测点） */
export const RETRIEVAL_BLOCK_TITLE = '知识库检索结果'

/** 没有命中时写进检索块的正文 —— 明确写出来，而不是留白（留白等于让模型自己决定"有没有"） */
export const RETRIEVAL_EMPTY_HINT = '（本次没有检索到与问题相关的知识库内容）'

/**
 * 把命中片段拼成**检索块**（`02` §六 第 2 步的"拼「来源：文档名」前缀"）。
 *
 * 形状（一行一个来源，正文原样跟着）：
 * ```
 * 知识库检索结果（每条的「来源」是文档名）：
 * 1. 来源：报销制度.txt
 * 出差住宿标准为每晚上限 500 元，超出部分需部门负责人审批……
 * ```
 * 两条口径：
 *   · **片段原样**（不截断、不再加工）：`snippet` 是由检索层给出的原文窗口
 *     （`SNIPPET_WINDOW_CHARS`），在编排层再截一次会让"引用卡里显示的片段"与
 *     "模型看到的片段"**不一样** —— 而引用卡的全部意义就是"用户能核对模型看到了什么"；
 *   · **序号从 1 开始且连续**：模型在正文里写「来源：X」就是靠这份对应关系，
 *     跳号会让它把两条不同的片段认成同一条。
 */
export function formatRetrievalBlock(hits: readonly RetrievalHit[]): string {
  const lines = [`${RETRIEVAL_BLOCK_TITLE}（每条的「来源」是文档名）：`]
  if (hits.length === 0) {
    lines.push(RETRIEVAL_EMPTY_HINT)
    return lines.join('\n')
  }
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. 来源：${hit.docName}`)
    lines.push(hit.snippet)
  })
  return lines.join('\n')
}

/**
 * 组装本轮 system prompt = 智能体提示词 + 检索规则 + 检索块。
 *
 * 顺序**刻意固定**：模型提示词在前（定义"你是谁、怎么说话"），规则与资料在后
 * （"这一轮你手里有什么"）—— 反过来会让"角色设定"被一大段资料冲淡。
 * `agentPrompt` 为空白（`null` / 空串 / 全空格）时用 {@link DEFAULT_SYSTEM_PROMPT}：
 * 三态字段的"清空"是合法状态，不能让它变成"没有 system 消息"。
 */
export function buildSystemPrompt(
  agentPrompt: string | null | undefined,
  hits: readonly RetrievalHit[],
): string {
  const persona = agentPrompt === null || agentPrompt === undefined || agentPrompt.trim() === ''
    ? DEFAULT_SYSTEM_PROMPT
    : agentPrompt
  return [persona, RETRIEVAL_RULES, formatRetrievalBlock(hits)].join('\n\n')
}

// ═════════════════════════════════════════════════════════════════════
// 多库命中的合并
// ═════════════════════════════════════════════════════════════════════

/**
 * 把"逐库检索"的结果合并成一份列表（顺序 = 注入 prompt 的顺序 = 引用卡的顺序）。
 *
 * **排序与检索层同款**：`rrfScore desc`，同分按 `chunkId asc`（P0-1-20 定案的确定性口径）。
 * 为什么非得有 tie-break：多库的分数分布不同、撞分很常见，而"两次调用顺序不同"会让
 * 引用卡在刷新前后换位置 —— 用户会以为是"答案变了"。
 *
 * ⚠️ **刻意不设条数上限**：每个库的 `topK` 是它自己的配置（建库时快照、事后可改），
 * 在编排层再叠一个隐藏上限会造出"我配了 topK=10，进模型的却只有 5 条"这种**查不出来**的事
 * （与 P0-1-23"组件绑定刻意不设条数上限"同款判断）。
 */
export function mergeRetrievalHits(perKb: readonly (readonly RetrievalHit[])[]): RetrievalHit[] {
  const all = perKb.flat()
  return [...all].sort((a, b) => {
    if (a.rrfScore !== b.rrfScore) return b.rrfScore - a.rrfScore
    return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0
  })
}

/**
 * 命中 → 引用卡条目（`citations` 事件的 `items`，同时也是 `messages.content.citations`）。
 *
 * `score` 取 `rrfScore`（融合分）：`§九` 的口径是"对外只给融合分"，
 * 且 `vectorScore` / `bigm_similarity` 量纲不可比（一个是余弦、一个是 bigram 相似度），
 * 混在一张卡上会让用户无法解释自己看到的数字。
 */
export function toCitationItems(hits: readonly RetrievalHit[]): CitationItem[] {
  return hits.map((hit) => ({ docName: hit.docName, snippet: hit.snippet, score: hit.rrfScore }))
}

// ═════════════════════════════════════════════════════════════════════
// 历史还原与截断
// ═════════════════════════════════════════════════════════════════════

/** 历史行（只取组装上下文要用的两列 —— 入参形状窄到不能再窄，纯函数才验得干净） */
export interface HistoryRow {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM'
  /** jsonb 原值（`MessageContent`；形状不保证 ⇒ 由 {@link textOfHistoryRow} 兜底） */
  content: unknown
}

/**
 * 从一条消息的 `content` 里取出**文本**（读取端的唯一兜底点，`parseActiveSnapshot` 同族）。
 *
 * 为什么读历史也要兜底：`messages.content` 是 jsonb —— 它的形状由写入时的版本决定，
 * 而历史是**跨版本**读的（P0-1-27 写入的 20 轮，可能被 P0-3 的版本读）。一个解析不出来的行
 * 不该让整轮对话失败（那意味着"三年前的一条脏数据让今天的提问用不了"）。
 * ⚠️ 只做**类型收敛**，不做任何"猜测"（不去猜 html / 数组 / 对象里的某个字段）。
 */
export function textOfHistoryRow(row: HistoryRow): string {
  const content = row.content
  if (typeof content === 'string') return content
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return ''
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/**
 * 从一条历史行的 `content` 里取出**工具调用记录**（P0-2-8）—— 读不出来就是"没有"。
 *
 * ⚠️ 用**写入端那一个** `toolCallRecordSchema` 逐条校验（不是自己 `as` 一下）：
 * `content` 是跨版本读的（同 {@link textOfHistoryRow}），一条坏记录不该让整轮对话失败，
 * 但也不该被当成"看起来像就拿来用"—— 逐条 `safeParse`、坏的就跳过。
 */
function toolCallsOfHistoryRow(row: HistoryRow): ToolCallRecord[] {
  const content = row.content
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return []
  const raw = (content as { tool_calls?: unknown }).tool_calls
  if (!Array.isArray(raw)) return []
  const records: ToolCallRecord[] = []
  for (const entry of raw) {
    const parsed = toolCallRecordSchema.safeParse(entry)
    if (parsed.success) records.push(parsed.data)
  }
  return records
}

/**
 * 取最近 `rounds` 轮的对话历史（`CONTEXT_ROUNDS=20`），还原成 LLM 入参。
 *
 * 四条口径（每一条都对应一种"看不太出来"的坏结果）：
 *   ① **一轮 = 一问一答，故取 `rounds × 2` 条**：只按"条"取 20 条等于只给 10 轮，
 *      而 `02` §六 写的是"最近 20 轮"；
 *   ② **截断后必须从 `user` 开始**：截点常常落在一个助手的回答中间 ⇒ 开头是一条没有问题的回答，
 *      模型会把它当成"要继续写下去的上文"（症状是回答莫名其妙地接着上一轮的结论说）；
 *   ③ **丢掉空文本的助手消息**：停止得很早的那一轮会留下 `text: ''` 的助手行
 *      （P0-1-27 停止时"已生成部分保留"，一个字都没生成时只有用户消息——
 *      但若先吐了 thinking 再被停止，就会留下"有 thinking 没 text"的助手行）。
 *      一条 `content: ''` 的 assistant 消息对上下文没有贡献，却会让严格的实现直接报 400。
 *      ⚠️ **例外**：**有工具调用**的助手行即便正文为空也要留（P0-2-8）—— 它不是空消息。
 *   ④ **工具段只在"每个调用都有结果"时才还原**（P0-2-8，见下面的长注释）。
 *
 * ⚠️ **本版本刻意不做 token 级裁剪**：唯一的边界手段是"轮数"。理由：
 * `model.maxContext` 存在库里但**没有可用的 tokenizer**（embedding 用的是另一套模型），
 * 按字符估算再裁会得到"看起来在保护上下文、实际按一个错误的折算率乱切"的假保护 ——
 * 那比"明确只按轮数裁"更坏（`02` §六 也只写了轮数）。这条留在待回补清单里（见 `06` 落地要点）。
 */
export function selectHistoryMessages(rows: readonly HistoryRow[], rounds: number): ChatMessage[] {
  const limit = Math.max(0, Math.floor(rounds)) * 2
  const recent = limit === 0 ? [] : rows.slice(Math.max(0, rows.length - limit))

  const mapped: ChatMessage[] = []
  for (const row of recent) {
    if (row.role === 'SYSTEM') continue // 本版本没有写入 SYSTEM 消息的路径（`02` §三 的取值域里留着）
    const text = textOfHistoryRow(row)
    if (row.role === 'USER') {
      if (text === '') continue // 见 ③（用户消息为空只可能是脏数据）
      mapped.push({ role: 'user', content: text })
      continue
    }

    /**
     * 助手行：正文 + 工具段。
     *
     * ⚠️ **工具段只在"每个调用都有结果"时还原**（P0-2-8 的核心判据）。三协议都要求
     * `tool_calls` 与工具结果**成对**：一条没有结果的调用是 400
     * （Anthropic："tool_use ids were found without tool_result blocks"；OpenAI 同理）。
     * 而"工具跑到一半被停止 / 那一轮整体失败"正好会留下这种半截记录 ⇒
     * **整个工具段一起丢**（只留正文），而不是留下一条会让**之后每一轮**都 400 的记录
     * —— 后者的症状是"这个会话从此再也发不出消息"，且完全指不到历史里那一行。
     *
     * ⚠️ 已知的**保真度折损**（记在这里，别当 bug）：落库单位是"一轮问答"，而模型实际调了
     * 好几次上游 ⇒ 还原出来的顺序是 `assistant{正文+toolCalls}` → `tool{结果}`，
     * 即"最终正文"排在了"工具结果"**之前**。结构上合法（每个调用后都有结果），
     * 语义上略有倒置。要修得先改成"按上游调用粒度落库"，那是一次独立的改动。
     */
    const calls = toolCallsOfHistoryRow(row)
    const answered = calls.filter((call) => call.status !== 'RUNNING' && call.output !== undefined)
    const restorable = calls.length > 0 && answered.length === calls.length

    if (text === '' && !restorable) continue // 见 ③
    if (restorable) {
      mapped.push({
        role: 'assistant',
        content: text,
        toolCalls: answered.map((call) => ({
          id: call.callId,
          name: call.toolName,
          // 完整入参在库里（`arguments`）；老记录没这一列时给空串 —— `parseToolArguments('')` = `{}`
          arguments: call.arguments ?? '',
        })),
      })
      for (const call of answered) {
        mapped.push({
          role: 'tool',
          toolCallId: call.callId,
          content: call.output ?? '',
          isError: call.status === 'ERROR',
        })
      }
      continue
    }
    mapped.push({ role: 'assistant', content: text })
  }

  let start = 0
  while (start < mapped.length && mapped[start]?.role !== 'user') start += 1
  return mapped.slice(start)
}

// ═════════════════════════════════════════════════════════════════════
// 工具调用（P0-2-8）—— 全是纯函数
// ═════════════════════════════════════════════════════════════════════

/**
 * **回填给模型**的工具结果上限（字符，按码点算）。
 *
 * 为什么必须有上界：一个工具可以回几百 KB（搜索结果、日志、表格导出），而它会被塞进
 * **下一轮请求**的报文里 —— 不设界就是"模型侧 400 / 拖垮一次问答"，且用户完全看不懂。
 *
 * ⚠️ 口径是"**给模型的那份**与**给卡片看的那份是同一份**"（`06` P0-2-8 坑预判 3，
 * 同 P0-1-27 为引用片段立的那条规矩）：两处各截一次，症状是"用户核对不了模型到底看到了什么"。
 * ⚠️ 刻意是**常量而不是配置项**（`06` 原文"定上界（常量）"）：要按 server 调就必须做成
 * server 级配置，而那会顺带引出"界面上怎么展示这个配置"—— 属 P1。
 */
export const TOOL_RESULT_MAX_CHARS = 8000

/** 工具卡上"参数摘要"的上限（字符）—— 它是要画在卡片上的一行字（`01` 决策 17） */
export const TOOL_INPUT_SUMMARY_MAX_CHARS = 200

/**
 * 截断标记。⚠️ 它是**文本的一部分**，所以模型与用户都会看到 ——
 * 于是它不能只说"已截断"，得把"接下来该怎么办"一起说了（模型据此换成更精确的调用参数）。
 */
export const TOOL_RESULT_TRUNCATED_MARK = '\n\n…（结果过长，已截断；以上是不完整的内容）'

/**
 * 按**码点**截断（不是 `String.prototype.slice`）。
 *
 * 为什么不用 `slice`：它按 UTF-16 码元切，会把代理对（emoji / 罕用汉字）**劈成两半**、
 * 产出非法字符串，而这一层**毫无报错**（P0-1-18 的老坑，`shared` 里有一处同款注释）。
 * 快路径：UTF-16 长度 ≤ 码点数 ⇒ 长度没超上限时一定没超，省掉一次整串展开。
 */
function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text
  return [...text].slice(0, max).join('')
}

/**
 * 工具结果 → 给模型与卡片看的**那一份**（见 {@link TOOL_RESULT_MAX_CHARS}）。
 *
 * 空结果给一句明确的话而不是空串：空串在报文里是一个"什么都没有"的内容块，
 * 有的实现会把它当成非法报文；而且模型看到空串会以为工具"什么都没返回"并开始瞎猜。
 */
export function truncateToolResult(text: string): string {
  const trimmed = text.trim() === '' ? '（工具执行成功，但没有返回内容）' : text
  if (trimmed.length <= TOOL_RESULT_MAX_CHARS) return trimmed
  // ⚠️ 标记本身要占额度：先按"上限 - 标记长度"截，再拼 —— 反过来拼会让结果超上限
  const head = truncateChars(trimmed, TOOL_RESULT_MAX_CHARS - TOOL_RESULT_TRUNCATED_MARK.length)
  return `${head}${TOOL_RESULT_TRUNCATED_MARK}`
}

/**
 * 参数名**看起来像凭据**的判定（大小写不敏感；只匹配这几个词，不用"包含 `key` 就算"）。
 *
 * ⚠️ **这是尽力而为，不是安全边界**。真正的保证在另一条线上：**凭据从不下发给模型**
 * （`02` §九 不变式 —— 注入发生在传输层，模型只看到工具的参数 schema）⇒
 * 参数里出现的值**只可能是用户自己贴进对话的内容**。因此这里遮的是"别在卡片上回显
 * 用户自己的秘密"，而不是"防止凭据泄漏"（后者不是靠这行判断做到的）。
 * 不写"包含 `key` 就遮"：`{"key": "查询关键词"}` 是很常见的普通参数，遮了反而看不懂卡片。
 */
const SENSITIVE_PARAM_KEYS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'cookie',
  'session',
] as const

function looksLikeSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_PARAM_KEYS.some((hint) => lower.includes(hint))
}

/**
 * 参数 → 卡片上的**摘要**（`tool_call.inputSummary`）。
 *
 * 三条口径：
 *   · **截断**（{@link TOOL_INPUT_SUMMARY_MAX_CHARS}）：这是要画在卡片上的一行字；
 *   · **凭据形状的参数值遮掉**（{@link looksLikeSensitiveKey}）—— 只遮**顶层**参数名，
 *     嵌套里的不管（卡片上也不看嵌套）；
 *   · 保持 JSON 的形状（`JSON.stringify`）而**不是**自己拼 `key=value`：
 *     模型给的参数本来就是 JSON，原样透出让用户能逐字对上"模型到底传了什么"。
 *
 * ⚠️ 不抛错：到不了这里的是"参数无法序列化"（它来自 `JSON.parse`，理论上不可能），
 * 真到了也绝不能让一次工具调用把整轮对话变成 500。
 */
export function summarizeToolInput(args: Record<string, unknown>): string {
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    masked[key] = looksLikeSensitiveKey(key) ? '***' : value
  }
  let serialized: string
  try {
    serialized = JSON.stringify(masked) || '{}'
  } catch {
    serialized = '（参数无法序列化）'
  }
  return truncateChars(serialized, TOOL_INPUT_SUMMARY_MAX_CHARS)
}

/** 一次工具执行的**结论**（编排层算好之后交给纯函数的部分 —— 这三样正好是回填要的全部） */
export interface ToolOutcome {
  /** 对应哪一个调用（= 上游给的 `id`） */
  callId: string
  /** 给模型与卡片看的**同一份**文本（已过 {@link truncateToolResult}） */
  text: string
  /** 工具自报失败（`isError`）—— **不是**"我们没调到它"（那类走 `errorCode`） */
  isError: boolean
}

/**
 * 工具结果 → 协议无关的消息（`role:'tool'`）。
 *
 * **三协议怎么落到报文里由 `protocol.buildBody` 负责**（OpenAI 的 `role:'tool'` +
 * `tool_call_id`、Anthropic 的用户消息里 `tool_result` 块、Responses 的
 * `function_call_output` item）—— 编排层**绝不能**在这里手拼报文（`06` 坑预判 2：
 * 那样"换了协议就调不动工具"，而 `verify:llm` 不会红 —— 它不跑编排循环）。
 */
export function buildToolResultMessages(outcomes: readonly ToolOutcome[]): ChatMessage[] {
  return outcomes.map((outcome) => ({
    role: 'tool',
    toolCallId: outcome.callId,
    content: outcome.text,
    isError: outcome.isError,
  }))
}

/**
 * 助手那一轮"我要调这些工具"的消息 —— **必须排在工具结果之前**（三协议都要求成对）。
 *
 * `text` 是这一轮已经吐出来的正文（通常是空的：模型决定调工具时往往不说话；也有一边说
 * "我查一下"一边调的）。它**不截断** —— 它是模型的正式输出，会原样落库并展示。
 */
export function buildAssistantToolCallsMessage(text: string, toolCalls: readonly ChatToolCall[]): ChatMessage {
  return { role: 'assistant', content: text, toolCalls: [...toolCalls] }
}

/**
 * 超过轮数上限时**注入的那条提示**（`06` 门槛 3："注入一条『工具调用已达上限』的提示并禁工具"）。
 *
 * ⚠️ 它是一条 `user` 消息而不是"系统提示"：我们**不改 system**（那一份是本轮的静态上下文，
 * 中途改它会让上游的提示缓存失效、也让"模型看到的规则"与"日志里记的规则"不一致）。
 * 用 `user` 角色还有一个好处：Anthropic/OpenAI 都保证它会被当成"最新的一轮输入"。
 * ⚠️ 措辞是**给模型**的指令（不是给用户看的），所以要说清"做什么"，不是只说"到上限了"。
 */
export const TOOL_LOOP_LIMIT_NOTICE =
  '（系统提示：本次回答中可用的工具调用次数已达上限，后续不能再调用任何工具。' +
  '请仅根据已获得的信息给出最终回答；如果信息仍不完整，请如实说明还缺什么。）'

/**
 * 用户**点了取消**（或超时按取消）时，回填给模型的工具结果（P0-2-10）。
 *
 * 三条口径：
 *   · **它不是故障**（`01` §3.6 的"取消后流程可继续"）：所以文案里要写"用户已取消"而不是
 *     "调用失败" —— 模型据此**不该**重试，也不该把它描述成系统出了问题；
 *   · **明确写"不要重试"**：模型看到"没执行"的第一反应常常是"那我再调一次"，
 *     而重试会**再弹一次确认卡**（用户刚拒绝过）—— 那是明确的坏体验，且会消耗工具轮数；
 *   · **两种结局分开**（`ConfirmDecision` 的三个值里有两个走这里）：
 *     "用户已取消"与"等待确认超时"对用户是两件事（我按的 vs 没人按），
 *     合成一句会让用户读不出自己那一按到底生效了没有。
 *
 * ⚠️ 这两条与 {@link TOOL_LOOP_LIMIT_NOTICE} 一样是**给模型**的指令（不是给用户看的通知）；
 * 用户看到的是那张 `tool_call{status:ERROR}` 卡片上的同一段文本（`06` P0-2-8 坑预判 3：
 * 给模型的那份与给卡片看的那份**是同一份**）。
 */
export const TOOL_CONFIRM_REJECTED_OUTPUT =
  '工具调用未执行：用户已取消本次操作。请不要重试，直接基于已有信息继续回答；' +
  '如果这个操作对回答是必需的，请如实说明需要用户先确认。'

/** 等确认**超时**（服务端按取消处理）时的回填文本 —— 与"用户主动取消"刻意分开，见上一段 */
export const TOOL_CONFIRM_TIMEOUT_OUTPUT =
  '工具调用未执行：等待用户确认超时（已按取消处理）。请不要重试，直接基于已有信息继续回答；' +
  '如果这个操作对回答是必需的，请如实说明该工具需要用户确认后才能执行。'

// ═════════════════════════════════════════════════════════════════════
// 落库形态
// ═════════════════════════════════════════════════════════════════════

/** {@link buildAssistantContent} 的入参 */
export interface AssistantContentInput {
  text: string
  thinking: string
  citations: readonly CitationItem[]
  /** 本轮的**工具调用记录**（按发生顺序；P0-2-8 起定型，见 `shared#toolCallRecordSchema`） */
  toolCalls?: readonly ToolCallRecord[]
  /**
   * 本轮的**产出文件**（按收集顺序；P0-3-7 起定型，见 `shared#artifactItemSchema`）。
   * ChatBot 恒不传（没有沙箱就没有产物），TaskAgent 在收集失败时也不传 —— 省键即"本轮没有"。
   */
  artifacts?: readonly ArtifactItem[]
}

/**
 * 组装助手消息的 `content`（jsonb）—— **只写实际产生过的部分**。
 *
 * 三条口径：
 *   · **空的 `thinking` / 空的 `citations` / 空的 `tool_calls` 不加键**：省掉这个键表示
 *     "这一段本来就没有"，与"有但是空"在界面上是两件事（`03` §五：思考折叠区、引用区、
 *     工具区都是**有才出现**）；
 *   · **`text` 恒写**（可以是空串）：它是历史重建时唯一进入上下文的部分
 *     （见 {@link selectHistoryMessages}）—— 缺了键，P0-1-28 的读取端会把它当"旧版本的行"；
 *   · 工具记录**原样落库**（含完整 `arguments`）：卡片的 `inputSummary` 只是摘要，
 *     而"模型到底传了什么"只有完整入参能回答（`06` P0-2-8 的原文）。
 */
export function buildAssistantContent(input: AssistantContentInput): MessageContent {
  const content: MessageContent = { text: input.text }
  if (input.thinking !== '') content.thinking = input.thinking
  if (input.citations.length > 0) content.citations = [...input.citations]
  if (input.toolCalls !== undefined && input.toolCalls.length > 0) {
    content.tool_calls = [...input.toolCalls]
  }
  if (input.artifacts !== undefined && input.artifacts.length > 0) {
    content.artifacts = [...input.artifacts]
  }
  return content
}
