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

const { createToolTextOffsetTracker, attachToolTextOffsets } = await import('../src/orchestrator/toolTextOffset.js')

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

console.log('')
console.log(`tool-text-offset-regression：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
