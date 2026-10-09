#!/usr/bin/env node
/**
 * frame-bus-regression.ts —— 会话帧总线的**无依赖**自证（P1-6 方案 A）
 *
 * 跑法：`pnpm --filter @doubulea/backend frame-bus:regression`
 *
 * 依据：`docs/06` §六 第 9 条（脚本用 Node）；被测对象 = `backend/src/orchestrator/frameBus.ts`
 *      （进程内 pub/sub，无 DB / Redis / HTTP 依赖）。
 *
 * ⚠️ 它验的是**总线语义**：实时推送、迟到补齐（回放缓冲）、运行结束清缓冲、取消订阅。
 *    它**验不了**端到端实时（要真跑一轮 + 浏览器 ⇒ 交给用户真跑）。
 */

import {
  closeRun,
  frameBusStats,
  openRun,
  publishFrame,
  subscribeFrames,
} from '../src/orchestrator/frameBus.js'
import type { SseEvent } from '@doubulea/shared'

let passed = 0
let failed = 0
function it(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

const delta = (text: string): SseEvent => ({ name: 'delta', data: { text } })
const texts = (events: SseEvent[]): string[] => events.map((e) => (e.data as { text: string }).text)

console.log('── A 实时推送 ──')
it('A1 订阅后收到的实时帧', () => {
  const conv = 'c-a1'
  openRun(conv)
  const got: SseEvent[] = []
  const off = subscribeFrames(conv, (e) => got.push(e))
  publishFrame(conv, delta('1'))
  publishFrame(conv, delta('2'))
  off()
  closeRun(conv)
  eq(texts(got), ['1', '2'], '收到')
})

console.log('── B 迟到补齐（回放缓冲）──')
it('★ B1 后订阅者先拿到缓冲（开头不丢），再接实时', () => {
  const conv = 'c-b1'
  openRun(conv)
  publishFrame(conv, delta('a'))
  publishFrame(conv, delta('b'))
  const got: SseEvent[] = []
  const off = subscribeFrames(conv, (e) => got.push(e)) // 迟到者
  publishFrame(conv, delta('c'))
  off()
  closeRun(conv)
  eq(texts(got), ['a', 'b', 'c'], '回放 + 实时')
})

console.log('── C 运行生命周期 ──')
it('★ C1 `closeRun` 清缓冲：之后订阅不再回放旧帧', () => {
  const conv = 'c-c1'
  openRun(conv)
  publishFrame(conv, delta('old'))
  closeRun(conv)
  const got: SseEvent[] = []
  const off = subscribeFrames(conv, (e) => got.push(e))
  off()
  eq(texts(got), [], '无回放')
})
it('C2 无活跃运行时订阅（页面常开），运行开始后能收到', () => {
  const conv = 'c-c2'
  const got: SseEvent[] = []
  const off = subscribeFrames(conv, (e) => got.push(e)) // 先订阅（此时没有运行）
  openRun(conv)
  publishFrame(conv, delta('live'))
  off()
  closeRun(conv)
  eq(texts(got), ['live'], '收到')
})

console.log('── D 取消订阅 / 统计 ──')
it('D1 取消后不再收到', () => {
  const conv = 'c-d1'
  openRun(conv)
  const got: SseEvent[] = []
  const off = subscribeFrames(conv, (e) => got.push(e))
  publishFrame(conv, delta('x'))
  off()
  publishFrame(conv, delta('y'))
  closeRun(conv)
  eq(texts(got), ['x'], '停收')
})
it('D2 `frameBusStats` 反映订阅数/缓冲数/活跃态', () => {
  const conv = 'c-d2'
  openRun(conv)
  const off = subscribeFrames(conv, () => {})
  publishFrame(conv, delta('z'))
  eq(frameBusStats(conv), { subscribers: 1, buffered: 1, active: true }, '统计')
  off()
  closeRun(conv)
})

console.log(
  failed === 0
    ? `\n✅ 帧总线自证通过（P1-6 方案 A）：${passed} 项全通过`
    : `\n❌ 帧总线自证未通过：${failed} 项失败 / ${passed} 项通过`,
)
process.exit(failed === 0 ? 0 : 1)
