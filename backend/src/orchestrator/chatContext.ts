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
 */

import type { CitationItem, MessageContent, RetrievalHit } from '@doubulea/shared'

import type { ChatMessage } from '../llm/client.js'

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
 * 取最近 `rounds` 轮的对话历史（`CONTEXT_ROUNDS=20`），还原成 LLM 入参。
 *
 * 三条口径（每一条都对应一种"看不太出来"的坏结果）：
 *   ① **一轮 = 一问一答，故取 `rounds × 2` 条**：只按"条"取 20 条等于只给 10 轮，
 *      而 `02` §六 写的是"最近 20 轮"；
 *   ② **截断后必须从 `user` 开始**：截点常常落在一个助手的回答中间 ⇒ 开头是一条没有问题的回答，
 *      模型会把它当成"要继续写下去的上文"（症状是回答莫名其妙地接着上一轮的结论说）；
 *   ③ **丢掉空文本的助手消息**：停止得很早的那一轮会留下 `text: ''` 的助手行
 *      （P0-1-27 停止时"已生成部分保留"，一个字都没生成时只有用户消息——
 *      但若先吐了 thinking 再被停止，就会留下"有 thinking 没 text"的助手行）。
 *      一条 `content: ''` 的 assistant 消息对上下文没有贡献，却会让严格的实现直接报 400。
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
    if (text === '') continue // 见 ③
    mapped.push({ role: row.role === 'USER' ? 'user' : 'assistant', content: text })
  }

  let start = 0
  while (start < mapped.length && mapped[start]?.role !== 'user') start += 1
  return mapped.slice(start)
}

// ═════════════════════════════════════════════════════════════════════
// 落库形态
// ═════════════════════════════════════════════════════════════════════

/** {@link buildAssistantContent} 的入参 */
export interface AssistantContentInput {
  text: string
  thinking: string
  citations: readonly CitationItem[]
}

/**
 * 组装助手消息的 `content`（jsonb）—— **只写实际产生过的部分**。
 *
 * 两条口径：
 *   · **空的 `thinking` / 空的 `citations` 不加键**：省掉这个键表示"这一段本来就没有"，
 *     与"有但是空"在界面上是两件事（`03` §五：思考折叠区与引用区都是**有才出现**）；
 *   · **`text` 恒写**（可以是空串）：它是历史重建时唯一进入上下文的部分
 *     （见 {@link selectHistoryMessages}）—— 缺了键，P0-1-28 的读取端会把它当"旧版本的行"。
 */
export function buildAssistantContent(input: AssistantContentInput): MessageContent {
  const content: MessageContent = { text: input.text }
  if (input.thinking !== '') content.thinking = input.thinking
  if (input.citations.length > 0) content.citations = [...input.citations]
  return content
}
