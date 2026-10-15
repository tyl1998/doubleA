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

/** 工具卡内联定位的追踪器 */
export interface ToolTextOffsetTracker {
  /** 取（或首次记下）某次工具调用出现时的正文字符偏移 */
  offsetFor: (callId: string) => number
}

/** 造一个追踪器；`getTextLength` 读调用方当前的**正文字符数**（每次正文增长后仍是同一个回调） */
export function createToolTextOffsetTracker(getTextLength: () => number): ToolTextOffsetTracker {
  const offsets = new Map<string, number>()
  return {
    offsetFor: (callId) => {
      const existing = offsets.get(callId)
      if (existing !== undefined) return existing
      const offset = getTextLength()
      offsets.set(callId, offset)
      return offset
    },
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
  const decoratedEvents = events.map((event) =>
    event.name === 'tool_call'
      ? { ...event, data: { ...event.data, textOffset: tracker.offsetFor(event.data.callId) } }
      : event,
  )
  const decoratedRecord =
    toolRecord === undefined ? undefined : { ...toolRecord, textOffset: tracker.offsetFor(toolRecord.callId) }
  return { events: decoratedEvents, toolRecord: decoratedRecord }
}
