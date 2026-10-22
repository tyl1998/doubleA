/**
 * 工具卡的**内联定位**（`tool_call.textOffset`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这张卡该插在哪
 * ─────────────────────────────────────────────────────────────────────
 * 卡片要插在"它被调用时正文写到第几个字符"的位置，而不是全堆在正文最前 / 最后。
 * 做法：每次正文增长后，**第一次**见到某个 `callId` 时把当前正文字符数记下来；同一 `callId` 的
 * 后续帧（`RUNNING` → `SUCCESS`/`ERROR`）**复用同一个偏移** —— 否则卡片会在状态流转的那一瞬间
 * "跳位置"（前端按 `callId` upsert，两帧若各算一次，第二次的正文已经变长）。
 *
 * ⚠️ **两条编排路径（`chatBot.ts` 与 `taskAgent.ts`）必须共用这一份**：TaskAgent 早先漏了这一步，
 * 于是它落库的 `tool_calls` 没有 `textOffset` ⇒ 刷新后历史里卡片全挤在正文最前面
 * （产品反馈 2026-10-14）。`getTextLength` 由调用方给（各自维护自己的正文累积）。
 *
 * 本模块是**纯函数**，可直接断言（见 `scripts/tool-text-offset-regression.ts`）。
 */

import type { SseEvent, ToolCallRecord } from '@doubulea/shared'

/**
 * 内联定位的追踪器（2026-10-21 从"只给工具卡"扩到**思考段与工具卡共用一条时间线**）。
 *
 * 一轮里正文、思考段、工具卡交替出现，三者要按发生顺序插进同一条流里。位置由两个数决定：
 *   · `textOffset` = 条目出现时**正文写到第几个字符**（工具卡沿用它做"插在哪段正文之间"）；
 *   · `seq` = 条目在**本轮内联序列**里的序号（思考段与工具卡**共用一个递增计数器**）——
 *     同一偏移时靠它定先后（典型：思考 A 之后紧接着一次工具调用，两者偏移相同，
 *     没有 `seq` 就会把后出现的思考 B 排到卡片前面）。
 *
 * ⚠️ 只在**首次**见到某个 key 时分配（同一工具 `callId` 的 start/end 两帧必须复用同一对值，
 * 否则卡片会在状态流转那一刻跳位置）；两次分配**在同一步**取偏移与序号，保证二者一致。
 */
export interface InlinePosition {
  textOffset: number
  seq: number
}

export interface ToolTextOffsetTracker {
  /** 取（或首次记下）某个 key（工具 `callId` 或思考段的段号）出现时的内联位置 */
  positionFor: (key: string) => InlinePosition
  /** 取（或首次记下）某次工具调用出现时的正文字符偏移（工具卡既有调用点的便捷写法） */
  offsetFor: (callId: string) => number
}

/** 造一个追踪器；`getTextLength` 读调用方当前的**正文字符数**（每次正文增长后仍是同一个回调） */
export function createToolTextOffsetTracker(getTextLength: () => number): ToolTextOffsetTracker {
  const positions = new Map<string, InlinePosition>()
  /** 下一个可用序号（跨"思考段 + 工具卡"这一整条内联序列递增） */
  let nextSeq = 0
  const positionFor = (key: string): InlinePosition => {
    const existing = positions.get(key)
    if (existing !== undefined) return existing
    const allocated: InlinePosition = { textOffset: getTextLength(), seq: nextSeq }
    nextSeq += 1
    positions.set(key, allocated)
    return allocated
  }
  return {
    positionFor,
    offsetFor: (callId) => positionFor(callId).textOffset,
  }
}

/**
 * 给一条引擎事件的产出补上 `textOffset`：`tool_call` 帧（进 SSE 流）与 `toolRecord`（进库）各一份。
 *
 * ⚠️ 两者都补、且**共用同一个 `offsetFor`**，否则"流里看着对、刷新后全挤在最前面"
 * （这正是 TaskAgent 之前的症状）。返回新对象，不改入参。
 * 只处理 `tool_call` 帧 —— `delta` / `thinking` / `artifact` 等原样透传。
 */
export function attachToolTextOffsets(
  events: readonly SseEvent[],
  toolRecord: ToolCallRecord | undefined,
  tracker: ToolTextOffsetTracker,
): { events: SseEvent[]; toolRecord: ToolCallRecord | undefined } {
  const decorate = <T extends { textOffset?: number; seq?: number }>(item: T, callId: string): T => {
    const { textOffset, seq } = tracker.positionFor(callId)
    return { ...item, textOffset, seq }
  }
  const decoratedEvents = events.map((event) =>
    event.name === 'tool_call' ? { ...event, data: decorate(event.data, event.data.callId) } : event,
  )
  const decoratedRecord = toolRecord === undefined ? undefined : decorate(toolRecord, toolRecord.callId)
  return { events: decoratedEvents, toolRecord: decoratedRecord }
}

/**
 * 给**思考段首帧**补上内联位置（2026-10-21）。
 *
 * `segKey` = 这一段的稳定 key（调用方用"段号"即可，如 `think-0` / `think-1`）——
 * 同一段只在**首帧**调一次（后续增量沿用首帧位置，无需再算）。
 * 与工具卡**共用同一个 {@link ToolTextOffsetTracker}** ⇒ `seq` 在同一条序列上递增，
 * 前端据此把「思考 A → 工具卡 → 思考 B」按发生顺序排（同偏移时序号定先后）。
 */
export function attachThinkingPosition<T extends object>(
  frame: T,
  segKey: string,
  tracker: ToolTextOffsetTracker,
): T & { textOffset: number; seq: number } {
  const { textOffset, seq } = tracker.positionFor(segKey)
  return { ...frame, textOffset, seq }
}

/**
 * 把一条工具记录**并进**本轮的工具表（同一 `callId` **覆盖**，不追加）。
 *
 * ★ **为什么必须合并（P1-21，2026-10-21，真机取证）**：引擎的 `tool_execution_start` 与
 *   `tool_execution_end` 是**两条事件**，各自带一条 `toolRecord`。原先 `taskAgent.ts` 用
 *   `push` 把它们都收进 `round.toolRecords` ⇒ 一条工具调用在库里变成**两行同 `callId` 的记录**：
 *   先 `{status:'ERROR', arguments}`（start 那条被"未结卡收口"改成了 ERROR），后
 *   `{status:'SUCCESS', output}`。而两条的键集**不一样**（后者不带 `status:ERROR` 的那套上下文、
 *   前者没有 `output`）⇒ 前端 `messageModel` 逐条渲染时不合并，卡片就停在"失败/运行中"，
 *   看起来像**卡住**（实际文件早就改完了）。实测 2026-10-20 的会话里每张卡都成对出现。
 *
 * ⚠️ 合并规则刻意**只保留一条**（而不是"两条都留、让前端去合"）：同一 `callId` 在一次调用里
 *   只有**一个终态**，留两行等于让每个消费方（前端历史、导出、模型回看）各写一遍合并逻辑。
 * ⚠️ 位置保持在**首次出现**的下标（`textOffset` 是首帧算的），后到的覆盖只换内容不换槽位。
 * ⚠️ 纯函数：不改入参数组，返回新数组。
 */
export function upsertToolRecord(
  records: readonly ToolCallRecord[],
  next: ToolCallRecord,
): ToolCallRecord[] {
  const index = records.findIndex((record) => record.callId === next.callId)
  if (index === -1) return [...records, next]
  const merged = [...records]
  // 后到的那条（end）是权威：状态、输出、`serverName` 都以它为准；它**没带**的
  // `arguments` / `textOffset` / `seq` 从旧记录里继承（end 事件本身没有 `args`，见 `map.ts`）
  const previous = records[index]
  merged[index] = {
    ...previous,
    ...next,
    // ⚠️ **`output` 只增不删**：start 那条没有 `output`（工具还没跑完），end 那条才有；
    //    反过来若某条 end 帧因为 `truncateToolResult` 取到空串而被省掉这个键，也不能把
    //    已经拿到的输出抹掉（前端显示 `output ?? liveOutput`，抹掉就退回"没有结果"）。
    ...(next.output === undefined && previous?.output !== undefined ? { output: previous.output } : {}),
    ...(next.arguments === undefined && previous?.arguments !== undefined
      ? { arguments: previous.arguments }
      : {}),
  }
  return merged
}
