/**
 * 消息投影：`?parts=text|full|timeline`（**P1-22 · 2026-10-22**）
 *
 * 依据：`shared/src/openApi.ts` 的 `OPEN_MESSAGE_PARTS` / `openMessageRichSchema`
 *      + `shared/src/conversation.ts#messageContentSchema`（内部富内容）
 *      + `docs/03` §五（"单一渲染路径"：历史与流式必须落在同一结构上）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么需要这个文件（一句话）
 * ─────────────────────────────────────────────────────────────────────
 * 内部 `content` 是**富对象**：正文在 `text`，而工具卡片 / 引用 / 思考在**其它键**里。
 * 第三方（尤其"协议配置驱动"的代理）只想拿一段文本 ⇒ 只看 `content.text` 就会把卡片丢掉。
 * 三种模式让调用方**自己选**粒度，而默认 `text` 保证**旧调用行为不变**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 三条硬规则
 * ─────────────────────────────────────────────────────────────────────
 * · **绝不 `String(对象)`**：那会得到 `[object Object]`（第三方踩过，`reply-…provider导入JSON.md` §1.2）；
 * · **历史数据可能是字符串**：那时三种模式都**原样**给出，不包成 `{text: …}`（否则形状随数据新旧漂）；
 * · **`timeline` 只拍平、不发明**：条目来自 `thinking_segments` / `tool_calls` 的**原文**，
 *   排序键是 `seq`（同一序列），正文按 `textOffset` 切开 ⇒ 卡片回到它本来出现的位置。
 *   这里**不做**任何"渲染"决定（不合并引用、不生成摘要）。
 */

import {
  openMessageRichSchema,
  type MessageItem,
  type OpenMessageFullExtras,
  type OpenMessageParts,
  type OpenMessageRich,
  type OpenMessageTimelinePart,
  type OpenMessageTimelineTool,
} from '@doubulea/shared'



/** 内部 `content` 的**宽松**读取（jsonb 原样，键都可能是缺的；不存在就按空处理） */
export interface LooseMessageContent {
  text?: unknown
  thinking?: unknown
  thinking_segments?: unknown
  citations?: unknown
  tool_calls?: unknown
  attachments?: unknown
}

/** 把任意 jsonb 值当对象读（不是对象就返回空对象 —— **绝不** `String(对象)`，那会变成 `[object Object]`） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 把任意值当数组读（不是数组 ⇒ 空数组） */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 字符串字段的宽松读取（缺省 = 空串；数字转字符串只为"别丢"） */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 非负整数（缺省 = `null`，**不编 0**：0 与"没有这个信息"是两件事） */
function asOffset(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

/** 工具卡 → 对外形状（`parts=timeline` 与 `parts=full` 共用；唯一一处翻译） */
function toOpenTimelineTool(raw: unknown): OpenMessageTimelineTool {
  const tool = asRecord(raw)
  const kind = tool['kind']
  const status = tool['status']
  return {
    callId: asText(tool['callId']),
    toolName: asText(tool['toolName']),
    serverName: asText(tool['serverName']),
    kind: kind === 'MCP' || kind === 'SANDBOX' || kind === 'BUILTIN' ? kind : 'MCP',
    status: status === 'RUNNING' || status === 'SUCCESS' || status === 'ERROR' ? status : 'ERROR',
    inputSummary: asText(tool['inputSummary']),
    // `output` 在 RUNNING 时没有键 ⇒ 对外统一成 `null`（"还没有输出"）
    output: typeof tool['output'] === 'string' ? tool['output'] : null,
    errorCode: typeof tool['errorCode'] === 'string' ? tool['errorCode'] : null,
  }
}

/**
 * 把 `content` 拍成**时间线**（`parts=timeline`）。三条规则（顺序即正确性）：
 *
 * ① **排序键是 `seq`**（思考段与工具卡共用同一序列，2026-10-21 定型）；旧消息没有 `seq`
 *    ⇒ 回落到 `textOffset`（正文偏移），再回落到"数组顺序"（`seq = null` 排最后，稳定排序保序）。
 * ② **正文按 `textOffset` 切开**：工具卡 / 思考段各自带"在正文里的位置"，正文片段取两次位置之间的部分
 *    ⇒ 于是"正文 → 工具卡 → 正文"的夹心结构能被还原（这正是卡片要显示在原位的原因）。
 * ③ **相邻正文片段合并**（同一 `textOffset` 的多次切分），减少条目数。
 *
 * ⚠️ `content.text` 为空（比如这一轮只有工具调用）时，`parts` 里**没有** `TEXT` 条目。
 */
export function buildTimeline(content: LooseMessageContent): OpenMessageTimelinePart[] {
  const text = asText(content.text)
  const thinking = asArray(content.thinking_segments)
    .map((raw) => {
      const segment = asRecord(raw)
      return {
        text: asText(segment['text']),
        seq: asOffset(segment['seq']),
        textOffset: asOffset(segment['textOffset']),
      }
    })
    .filter((segment) => segment.text !== '')
  const tools = asArray(content.tool_calls).map(toOpenTimelineTool)

  /** 一条"带位置"的条目（用于排序与切正文） */
  type Entry =
    | { type: 'THINKING'; seq: number | null; offset: number | null; text: string }
    | { type: 'TOOL'; seq: number | null; offset: number | null; tool: OpenMessageTimelineTool }

  const entries: Entry[] = [
    ...thinking.map((segment) => ({
      type: 'THINKING' as const,
      seq: segment.seq,
      offset: segment.textOffset,
      text: segment.text,
    })),
    ...tools.map((tool, index) => ({
      type: 'TOOL' as const,
      // 旧消息没有 `seq` ⇒ `null`（排最后）；用索引只为稳定排序
      seq: asOffset(asRecord(asArray(content.tool_calls)[index])['seq']),
      offset: asOffset(asRecord(asArray(content.tool_calls)[index])['textOffset']),
      tool,
    })),
  ]

  const rank = (entry: Entry): [number, number, number] => [
    entry.seq ?? Number.MAX_SAFE_INTEGER,
    entry.offset ?? Number.MAX_SAFE_INTEGER,
    entry.type === 'THINKING' ? 0 : 1,
  ]
  entries.sort((left, right) => {
    const [ls, lo, lt] = rank(left)
    const [rs, ro, rt] = rank(right)
    return ls - rs || lo - ro || lt - rt
  })

  /** 正文按"条目位置"切段（位置为 `null` 的条目**不切正文**，直接跳过） */
  const parts: OpenMessageTimelinePart[] = []
  let cursor = 0
  let pending = ''
  const flushText = (): void => {
    if (pending === '') return
    parts.push({ type: 'TEXT', text: pending, textOffset: null, seq: null })
    pending = ''
  }
  for (const entry of entries) {
    if (entry.offset !== null && entry.offset > cursor && entry.offset <= text.length) {
      pending += text.slice(cursor, entry.offset)
      cursor = entry.offset
      flushText()
    }
    if (entry.type === 'THINKING') {
      parts.push({ type: 'THINKING', text: entry.text, textOffset: entry.offset, seq: entry.seq })
    } else {
      parts.push({ type: 'TOOL', text: '', textOffset: entry.offset, seq: entry.seq, tool: entry.tool })
    }
  }
  // 尾部正文（或整段正文都没被切过 ⇒ 一整段）
  if (cursor < text.length) pending += text.slice(cursor)
  flushText()

  // 相邻正文合并（第 ③ 条）
  const merged: OpenMessageTimelinePart[] = []
  for (const part of parts) {
    const previous = merged[merged.length - 1]
    if (part.type === 'TEXT' && previous?.type === 'TEXT') {
      merged[merged.length - 1] = { ...previous, text: previous.text + part.text }
      continue
    }
    merged.push(part)
  }
  return merged
}

/** `parts=full` 的附加段（**已翻成对外名字**，客户端不必知道内部键名） */
export function buildFullExtras(content: LooseMessageContent): OpenMessageFullExtras {
  return {
    thinkingSegments: asArray(content.thinking_segments).map((raw) => {
      const segment = asRecord(raw)
      return {
        text: asText(segment['text']),
        seq: asOffset(segment['seq']) ?? 0,
        textOffset: asOffset(segment['textOffset']) ?? 0,
      }
    }),
    citations: asArray(content.citations).map((raw) => {
      const citation = asRecord(raw)
      return {
        docName: asText(citation['docName']),
        snippet: asText(citation['snippet']),
        score: typeof citation['score'] === 'number' ? citation['score'] : 0,
      }
    }),
    toolCalls: asArray(content.tool_calls).map(toOpenTimelineTool),
    attachments: asArray(content.attachments).map((raw) => {
      const attachment = asRecord(raw)
      return {
        id: asText(attachment['fileId']),
        name: asText(attachment['name']),
        mime: asText(attachment['mime']),
        size: typeof attachment['size'] === 'number' ? attachment['size'] : 0,
      }
    }),
  }
}

/**
 * 一条消息 → 对外投影（`parts` 的**唯一实现处**）。
 *
 * · `text`（默认）：`content` = **字符串**（`content.text`）—— 与旧版**逐字一致**；
 * · `full`：`content` = 内部富对象原样 + `extras`（已翻译的副本）；
 * · `timeline`：`content` = 字符串（同 `text`）+ `parts[]`（拍平的时间线）。
 *
 * ⚠️ 历史消息的 `content` 可能是**字符串**（旧数据 / 非富结构）：那时三种模式都**原样**给出该字符串
 * —— 不把它包成 `{text: ...}`，否则对外形状会因数据新旧而漂。
 */
export function projectOpenMessage(item: MessageItem, parts: OpenMessageParts): OpenMessageRich {
  const raw = item.content
  const base = {
    id: item.id,
    role: item.role === 'ASSISTANT' ? ('ASSISTANT' as const) : ('USER' as const),
    createdAt: item.createdAt,
    tokensIn: item.tokensIn,
    tokensOut: item.tokensOut,
  }
  if (typeof raw === 'string') {
    return openMessageRichSchema.parse({ ...base, content: raw })
  }
  const content = asRecord(raw) as LooseMessageContent
  if (parts === 'full') {
    return openMessageRichSchema.parse({ ...base, content: raw, extras: buildFullExtras(content) })
  }
  const text = asText(content.text)
  if (parts === 'timeline') {
    return openMessageRichSchema.parse({ ...base, content: text, parts: buildTimeline(content) })
  }
  return openMessageRichSchema.parse({ ...base, content: text })
}

