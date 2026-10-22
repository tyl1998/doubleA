#!/usr/bin/env node
/**
 * tool-text-offset-regression.ts —— 工具卡**内联定位**（`textOffset`）的自证基线
 *
 * 跑法：`pnpm --filter @doubulea/backend tool-text-offset:regression`
 *
 * 依据：产品反馈 2026-10-14「TaskAgent 历史里工具卡全挤在正文最前面（不在调用的地方）」——
 * 根因是 **TaskAgent 没给 `tool_call` 帧 / 落库记录补 `textOffset`**（ChatBot 早已补），
 * 于是刷新后历史侧拿不到偏移、全按 0 处理。
 *
 * 本档守的是那条**两条路径共用**的纯契约（`orchestrator/toolTextOffset.ts`）：
 *   ① **首次**出现某 `callId` 时取**当时**的正文字符数；
 *   ② 同一 `callId` 的 start/end 两帧取**同一个**偏移（不随正文继续增长而漂移）；
 *   ③ 补的是 `tool_call` 帧与 `toolRecord` **两份**，`delta` / 其它帧原样透传；
 *   ④ 纯函数：不改入参。
 *
 * ⚠️ 与 `workspace:regression` 同款：自包含、不连上游 / 不连 DB / 不连容器，永远可跑。
 */

import type { SseEvent, ToolCallRecord } from '@doubulea/shared'

const { createToolTextOffsetTracker, attachToolTextOffsets, attachThinkingPosition, upsertToolRecord } =
  await import('../src/orchestrator/toolTextOffset.ts')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

/** 造一条 `tool_call` SSE 帧（`kind=SANDBOX` 时 `serverName` 为空串） */
function toolFrame(callId: string, status: 'RUNNING' | 'SUCCESS'): SseEvent {
  return {
    name: 'tool_call',
    data: { callId, toolName: 'bash', serverName: '', kind: 'SANDBOX', status, inputSummary: '{}' },
  }
}

/** 造一条落库记录（与帧同形状 + 可选 `arguments`） */
function toolRecord(callId: string, status: 'RUNNING' | 'SUCCESS'): ToolCallRecord {
  return { callId, toolName: 'bash', serverName: '', kind: 'SANDBOX', status, inputSummary: '{}' }
}

// ① 首次取当时正文长度；同一 callId 复用（start/end 不漂移）
{
  let text = 'abcde'
  const tracker = createToolTextOffsetTracker(() => text.length)
  check('首次出现取当时正文字符数', tracker.offsetFor('A') === 5, `实得 ${tracker.offsetFor('A')}`)
  text = 'abcdefghij'
  check('同一 callId 复用首帧偏移（不随正文增长漂移）', tracker.offsetFor('A') === 5, `实得 ${tracker.offsetFor('A')}`)
  check('新 callId 取新的正文长度', tracker.offsetFor('B') === 10, `实得 ${tracker.offsetFor('B')}`)
}

// ①′ 内联序列（2026-10-21）：思考段与工具卡**共用**一个递增序号，同 key 复用
{
  let text = ''
  const tracker = createToolTextOffsetTracker(() => text.length)
  const thinkA = tracker.positionFor('think-0')
  const toolA = tracker.positionFor('call-A')
  text = '前半'
  const thinkB = tracker.positionFor('think-1')
  check('思考 A 序号 0', thinkA.seq === 0, `实得 ${thinkA.seq}`)
  check('工具卡与思考段共用序列（紧随其后 = 1）', toolA.seq === 1, `实得 ${toolA.seq}`)
  check('正文增长后新段序号继续递增 = 2', thinkB.seq === 2, `实得 ${thinkB.seq}`)
  check('新段偏移 = 当时正文长度', thinkB.textOffset === 2, `实得 ${thinkB.textOffset}`)
  check('同一 key 复用（不重复分配序号）', tracker.positionFor('think-0').seq === 0, '重复分配了')
  const stamped = attachThinkingPosition({ text: 'x', newSegment: true }, 'think-2', tracker)
  check('段首帧补上 textOffset + seq', stamped.seq === 3 && stamped.textOffset === 2, JSON.stringify(stamped))
}

// ①″ 段 key 唯一性（2026-10-21 的真 bug）：首段与新段**绝不能**拿到同一个 key
//     （早先用 `segments.length` 当 key，而 push 在 map 之后 ⇒ 两段都是 `think-0` ⇒
//       第二段复用第一段的 `seq` ⇒ 前端「重新推理」与工具卡换位）
{
  const text = ''
  const tracker = createToolTextOffsetTracker(() => text.length)
  const seg = { seq: 0 }
  const nextKey = () => `think-${seg.seq++}`
  const a = tracker.positionFor(nextKey())
  const tool = tracker.positionFor('call-1')
  const b = tracker.positionFor(nextKey())
  check('首段 seq = 0', a.seq === 0, `实得 ${a.seq}`)
  check('工具卡 seq = 1（夹在两段之间）', tool.seq === 1, `实得 ${tool.seq}`)
  check('重新推理段 seq = 2（不复用首段）', b.seq === 2, `实得 ${b.seq}`)
  check('三段序号严格递增', a.seq < tool.seq && tool.seq < b.seq, `${a.seq},${tool.seq},${b.seq}`)
}

// ② attach：tool_call 帧 + toolRecord 两份都补、且同偏移；其它帧不动；不改入参
{
  const tracker = createToolTextOffsetTracker(() => 7)
  const events: SseEvent[] = [
    { name: 'delta', data: { text: 'hi' } },
    toolFrame('A', 'RUNNING'),
    toolFrame('A', 'SUCCESS'),
  ]
  const original = JSON.parse(JSON.stringify(events)) as SseEvent[]
  const out = attachToolTextOffsets(events, toolRecord('A', 'SUCCESS'), tracker)

  const first = out.events[1]
  const second = out.events[2]
  check('tool_call 帧补上 textOffset', first.name === 'tool_call' && first.data.textOffset === 7)
  check('同一 callId 的 start/end 两帧同偏移', second.name === 'tool_call' && second.data.textOffset === 7)
  const head = out.events[0]
  check('delta 帧原样透传（不带 textOffset）', head.name === 'delta' && !('textOffset' in head.data))
  check('落库那份也补上同一偏移', out.toolRecord?.textOffset === 7)
  check('纯函数：不改入参', JSON.stringify(events) === JSON.stringify(original))
}

// ③ 没有 toolRecord / 没有事件时保持形状
{
  const tracker = createToolTextOffsetTracker(() => 0)
  const out = attachToolTextOffsets([], undefined, tracker)
  check('无 toolRecord ⇒ 仍 undefined；空事件 ⇒ 空数组', out.toolRecord === undefined && out.events.length === 0)
}

// ④ 同一 callId 落库**只留一条**（P1-21：start/end 两条记录不许都进 `tool_calls`）
{
  const start: ToolCallRecord = {
    ...toolRecord('X', 'RUNNING'),
    arguments: '{"path":"a.md"}',
    textOffset: 3,
  }
  const end: ToolCallRecord = {
    ...toolRecord('X', 'SUCCESS'),
    output: '已编辑 a.md（v2）',
    textOffset: 3,
  }
  const records = upsertToolRecord(upsertToolRecord([], start), end)
  check('同一 callId 只留一条（不追加）', records.length === 1, `实得 ${records.length}`)
  check('终态覆盖（SUCCESS + 输出）', records[0]?.status === 'SUCCESS' && records[0]?.output === '已编辑 a.md（v2）')
  check('end 没带的 arguments / textOffset 从 start 继承', records[0]?.arguments === '{"path":"a.md"}' && records[0]?.textOffset === 3)

  // 顺序反了（end 先到）也不该被 start 抹掉输出
  const reversed = upsertToolRecord(upsertToolRecord([], end), start)
  check('乱序到达时 output 不被抹掉', reversed.length === 1 && reversed[0]?.output === '已编辑 a.md（v2）')

  // 两次不同的调用仍然是两条
  const two = upsertToolRecord(records, { ...toolRecord('Y', 'SUCCESS') })
  check('不同 callId 各占一条', two.length === 2)
  check('纯函数：不改入参数组', records.length === 1)
}

console.log('')
console.log(`tool-text-offset-regression：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
