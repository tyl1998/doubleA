/**
 * 用户画像的**模型归一**（P1-8 · 显式"记住"路径）
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §8.2（kind v2）/§8.3（抽取 v2：USER 画像
 *      由系统识别 + 显式指令）、§8.4③（画像当"关于用户的背景"注入）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这个模块（踩过的坑）
 * ─────────────────────────────────────────────────────────────────────
 * 初版把"记住"之后的**原文**直接当记忆落库（`memoryExtract.ts` 的 `textAfterMarker`）。它有两个
 * 概念性错误，且都**不会报错**、只会把噪声写进用户画像（`PROFILE`，常驻注入每一次对话）：
 *   ① **不校验"是不是关于用户的陈述"** —— 命令句、疑问句、"工作规范/协作流程"这类非画像内容都漏进来；
 *      实测一条"你应该把…记住，为什么记的东西那么奇怪？"被拆出问句 `为什么记的东西那么奇怪？` 写进了画像；
 *   ② **"把 X 记住"取不到** —— 宾语在标记**前面**，规则只取标记之后 ⇒ 真内容丢了。
 * 故这里改成**让模型把用户意图归一成规范的第一人称陈述**，并判定 kind；非陈述一律不产出。
 *
 * ⚠️ 本模块只做"文本 → 结构化陈述"，**不碰 DB**（写入仍在 `memoryExtract.ts`）—— 于是纯函数
 *    （prompt 组装 / 回复解析）可被无依赖回归直接喂字面量断言。
 */

import { MEMORY_TEXT_MAX } from '@doubulea/shared'

import { chat, type ChatMessage, type LlmTarget } from '../llm/client.js'

/**
 * 允许写进 **USER 画像** 的 kind（`HIGHLIGHT` 属 AGENT 作用域，不在此列 —— 显式"记住"默认落 USER）。
 */
const USER_STATEMENT_KINDS = ['PROFILE', 'PREFERENCE', 'HABIT', 'OTHER'] as const
export type UserStatementKind = (typeof USER_STATEMENT_KINDS)[number]

/** 一条归一后的用户陈述 */
export interface ProfileStatement {
  text: string
  kind: UserStatementKind
}

/**
 * 画像归一 prompt：要求模型只回结构化 JSON，把用户的话压成"关于用户本人"的陈述。
 * 关键词是**只输出陈述** —— 命令/疑问/寒暄/与用户无关的内容都要丢掉（宁缺勿滥）。
 */
export const MEMORY_PROFILE_PROMPT = [
  '你是「用户画像」整理助手。请从下面的用户消息里，提取**关于用户本人、且值得长期记住的陈述性事实**，',
  '归一成规范的中文第一人称陈述句，并判断类型。',
  '',
  '严格只输出一个 JSON 对象（可包在 ```json 代码块里），不要输出任何其它文字：',
  '{',
  '  "statements": [',
  '    { "text": "规范的第一人称陈述句", "kind": "PROFILE | PREFERENCE | HABIT | OTHER" }',
  '  ]',
  '}',
  '',
  'kind 取值：',
  '- PROFILE：用户角色 / 身份（如"我是测试工程师，负责 STG 环境"）',
  '- PREFERENCE：用户的喜好 / 对助手的长期指令（如"以后都用中文回答"）',
  '- HABIT：用户的习惯 / 工作方式（如"我一般周五下午做回归"）',
  '- OTHER：其它关于用户本人的稳定事实',
  '',
  '要求：',
  '- 只输出**关于用户本人**的陈述句。**命令、疑问、寒暄、与用户无关的内容、一次性任务细节一律不要**。',
  '- 用户说"把 X 记住"时，把 X 归一成关于用户的陈述（例：把"内容规范与协作流程"记住 ⇒',
  '  一条 PREFERENCE 陈述，如"我要求协作时遵循既定的内容规范与协作流程"）。',
  '- 没有可记住的陈述就返回 {"statements":[]}，**不要编造**。',
  `- 每条一句话、去重、不超过 ${MEMORY_TEXT_MAX} 字。`,
].join('\n')

/** 组装"归一"这一次上游调用的消息（把用户原文附在指令之后） */
export function buildMemoryProfileMessages(userText: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `${MEMORY_PROFILE_PROMPT}\n\n用户消息：\n${userText}`,
    },
  ]
}

/** 从自由文本里截出第一个平衡的 `{…}` JSON 对象（模型常包在 ```json 或前后加解释） */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isUserStatementKind(value: string): value is UserStatementKind {
  return (USER_STATEMENT_KINDS as readonly string[]).includes(value)
}

/**
 * 安全兜底：**疑问句不算陈述**。模型偶尔仍会回一句问句，这里再拦一道（宁可不写也不写错）。
 * 判据与规则式提取共用（见 `memoryExtract.ts` 的降级路径）。
 */
export function isQuestionStatement(text: string): boolean {
  if (/[？?]\s*$/u.test(text)) return true
  // 句末"吗/呢"且无句末标点（规则式降级会把标点切走）⇒ 也当作疑问，补一道
  if (/[吗呢]\s*$/u.test(text)) return true
  return /^(为什么|为何|怎么|怎样|如何|是否|能否|能不能|可不可以|多少|哪些|哪一个|什么)/u.test(text)
}

// ═════════════════════════════ 规则式（模型不可用时的降级路径） ═════════════════════════════

/** "记住"类标记（命中任意一个即走显式"记住"路径） */
export const REMEMBER_MARKERS = ['记住', '帮我记住', '请记住', '牢记', '记一下', '记录一下', '要记住'] as const

/** 逐行取"标记之后"的正文（去掉紧跟着的冒号/顿号/空格等）；空则跳过 */
export function textAfterMarker(line: string, markers: readonly string[]): string | null {
  for (const marker of markers) {
    const index = line.indexOf(marker)
    if (index < 0) continue
    const rest = line
      .slice(index + marker.length)
      .replace(/^[：:，,、。.！!？?\s]+/u, '')
      .trim()
    if (rest !== '') return rest
  }
  return null
}

/** 消息里是否出现"记住"类标记（显式"记住"路径的判据；`把 X 记住` 也命中） */
export function hasRememberMarker(text: string): boolean {
  return REMEMBER_MARKERS.some((marker) => text.includes(marker))
}

/**
 * **保守规则式**的"记住"候选（模型不可用/失败时的降级路径；**纯函数**、可逐字断言）。
 *
 * 比初版多做三件事，正是初版把问句写进画像的那两个洞：
 *   · **按句末标点切句** —— 只在含"记住"的**那一句**里取内容，不把紧跟的下一句吞进来；
 *   · **支持"把/将 X 记住"** —— 宾语在标记**前面**（"把内容规范与协作流程记住"），初版结构上取不到；
 *   · **丢掉疑问句候选** —— 宁可不写也不写错（{@link isQuestionStatement}）。
 *
 * ⚠️ 它**做不到**"归一成陈述"（那是模型路径的职责），只保证"不乱写"。
 */
export function extractRememberCandidates(userText: string): string[] {
  const out: string[] = []
  for (const rawLine of userText.split(/\r?\n/u)) {
    for (const sentence of rawLine.split(/[。！？!?；;]/u)) {
      const line = sentence.trim()
      if (line === '' || !hasRememberMarker(line)) continue
      const object = line.match(/(?:把|将)(.+?)(?:都|也)?记住/u)?.[1]
      const candidate = (object ?? textAfterMarker(line, REMEMBER_MARKERS) ?? '')
        .replace(/^[：:，,、。.！!？?\s]+/u, '')
        .trim()
      if (candidate === '' || isQuestionStatement(candidate)) continue
      out.push(candidate)
    }
  }
  return out
}

/**
 * 解析模型回复 → 归一后的陈述列表（**纯函数**，便于逐字断言）。
 *
 * 健壮性口径：
 *   · 回复里没有 JSON / JSON 不可解析 / 缺 `statements` 数组 ⇒ **抛错** —— 让调用方走降级
 *     （"解析失败"与"模型明确说没有可记的"是两回事，不能都当空）；
 *   · `statements: []` ⇒ 返回空数组（模型判定无可记陈述，调用方**不写**任何记忆）；
 *   · 单条：`text` 空 / kind 非法 / 是疑问句 ⇒ 跳过；超长按码点截断；逐字去重。
 */
export function parseMemoryProfileStatements(raw: string): ProfileStatement[] {
  const json = extractJsonObject(raw.trim())
  if (json === null) throw new Error('模型回复里没有 JSON 对象')
  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch {
    throw new Error('模型回复的 JSON 不可解析')
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('模型回复的 JSON 不是对象')
  }
  const list = (decoded as { statements?: unknown }).statements
  if (!Array.isArray(list)) throw new Error('模型回复缺少 statements 数组')

  const out: ProfileStatement[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { text?: unknown; kind?: unknown }
    const text = toText(record.text)
    const kind = toText(record.kind).toUpperCase()
    if (text === '' || !isUserStatementKind(kind)) continue
    if (isQuestionStatement(text)) continue
    const chars = [...text]
    const clipped = chars.length > MEMORY_TEXT_MAX ? chars.slice(0, MEMORY_TEXT_MAX).join('') : text
    if (seen.has(clipped)) continue
    seen.add(clipped)
    out.push({ text: clipped, kind })
  }
  return out
}

/**
 * 让模型把用户消息归一成"关于用户的陈述"。
 *
 * `temperature: 0` 求稳定；**不传 `maxTokens`**（思考类模型的推理 token 也从输出预算扣，
 * 与 `pipeline/caption.ts` 同款取舍 —— 上限交给模型/上游）。
 *
 * @throws 上游故障 / 超时（`llm/client.ts#chat`）/ 解析失败（{@link parseMemoryProfileStatements}）
 */
export async function extractMemoryProfileStatements(
  target: LlmTarget,
  userText: string,
): Promise<ProfileStatement[]> {
  const result = await chat(target, buildMemoryProfileMessages(userText), { temperature: 0 })
  return parseMemoryProfileStatements(result.text)
}
