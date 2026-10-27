#!/usr/bin/env node
/**
 * cron-regression.ts —— 定时任务 cron 解析/下一次计算的**无依赖**自证（P1-6）
 *
 * 跑法：`pnpm --filter @doubulea/backend cron:regression`（= `node --import tsx scripts/cron-regression.ts`）
 *
 * 依据：`docs/06` §六 第 8 条（计算值实测）/ 第 9 条（脚本用 Node）；被测对象 =
 *      `shared/src/cron.ts`（经 `shared/dist` 运行期解析 —— 改过 `shared/src` 要先 build）。
 *
 * ⚠️ 它验的是**纯函数**：解析的取值域、日/周 AND-OR 语义、下一次触发的边界、非法表达式。
 *    它**验不了**调度器 tick / 真派活（那要 PG/Redis/沙箱与一个 TaskAgent ⇒ 交给用户真跑）。
 */

import {
  cronMatches,
  describeCron,
  isValidCron,
  nextCronRun,
  nextCronRuns,
  parseCron,
} from '@doubulea/shared'

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
/** 英文描述里不许出现汉字（漏传 locale 的症状；`describeCron` 末批前恒返回中文） */
function assertNoCjk(value: string | null, label: string): void {
  assert(value !== null && !/[\u4e00-\u9fff]/.test(value), `${label}：en 描述里还有中文 → ${String(value)}`)
}

/** 本地时刻（与 `nextCronRun` 同一口径：本地时区） */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0)

console.log('── A 解析 ──')
it('A1 `0 9 * * 1` 解析为 分{0} 时{9} 周{1}，日未限定/周已限定', () => {
  const c = parseCron('0 9 * * 1')
  eq([...c.minutes], [0], 'minutes')
  eq([...c.hours], [9], 'hours')
  eq([...c.daysOfWeek], [1], 'dow')
  eq(c.domRestricted, false, 'domRestricted')
  eq(c.dowRestricted, true, 'dowRestricted')
})
it('A2 区间 + 步长：`*/15` ⇒ 0,15,30,45；`1-5` ⇒ 1..5', () => {
  eq([...parseCron('*/15 * * * *').minutes], [0, 15, 30, 45], '*/15')
  eq([...parseCron('0 9 * * 1-5').daysOfWeek], [1, 2, 3, 4, 5], '1-5')
})
it('A3 周 7 折算成 0（周日两种写法等价）', () => {
  eq([...parseCron('0 9 * * 7').daysOfWeek], [0], '7 → 0')
})
it('A4 逗号列表', () => {
  eq([...parseCron('0 9,18 * * *').hours], [9, 18], '9,18')
})

console.log('── B 非法表达式 ──')
it('B1 段数不是 5 ⇒ 非法', () => {
  eq(isValidCron('0 9 * *'), false, '4 段')
  eq(isValidCron('0 9 * * * *'), false, '6 段')
})
it('B2 越界 ⇒ 非法（分 60 / 周 8 / 月 13）', () => {
  eq(isValidCron('60 9 * * *'), false, '分 60')
  eq(isValidCron('0 9 * * 8'), false, '周 8')
  eq(isValidCron('0 9 * 13 *'), false, '月 13')
})
it('B3 空项 / 起点大于终点 ⇒ 非法', () => {
  eq(isValidCron('0 9, * * *'), false, '空项')
  eq(isValidCron('5-1 * * * *'), false, '5-1')
})
it('B4 合法表达式 ⇒ true', () => {
  eq(isValidCron('0 9 * * 1'), true, '周一 9 点')
  eq(isValidCron('*/15 * * * *'), true, '每 15 分钟')
})

console.log('── C 命中判据 ──')
it('C1 `0 9 * * *` 命中 09:00、不命中 09:01', () => {
  const c = parseCron('0 9 * * *')
  eq(cronMatches(c, at(2026, 10, 9, 9, 0)), true, '09:00')
  eq(cronMatches(c, at(2026, 10, 9, 9, 1)), false, '09:01')
})
it('C2 日/周都限定时按 OR（`0 0 1 * 1`：每月 1 日 或 每周一）', () => {
  const c = parseCron('0 0 1 * 1')
  // 2026-10-05 是周一（非 1 日）⇒ 命中
  eq(at(2026, 10, 5).getDay(), 1, '夹具：2026-10-05 应是周一')
  eq(cronMatches(c, at(2026, 10, 5, 0, 0)), true, '周一命中')
  // 2026-10-01 是周四但是 1 日 ⇒ 命中
  eq(cronMatches(c, at(2026, 10, 1, 0, 0)), true, '1 日命中')
  // 2026-10-07 既非 1 日也非周一 ⇒ 不命中
  eq(cronMatches(c, at(2026, 10, 7, 0, 0)), false, '不命中')
})

console.log('── D 下一次触发 ──')
it('D1 `0 9 * * *` 从 00:00 起 ⇒ 当天 09:00', () => {
  eq(nextCronRun('0 9 * * *', at(2026, 10, 9, 0, 0))?.getTime(), at(2026, 10, 9, 9, 0).getTime(), '当天 9 点')
})
it('D2 `0 9 * * *` 从 09:00 起 ⇒ 次日 09:00（本分钟不再触发）', () => {
  eq(nextCronRun('0 9 * * *', at(2026, 10, 9, 9, 0))?.getTime(), at(2026, 10, 10, 9, 0).getTime(), '次日')
})
it('D3 `*/15 * * * *` 从 08:07 起 ⇒ 08:15', () => {
  eq(nextCronRun('*/15 * * * *', at(2026, 10, 9, 8, 7))?.getTime(), at(2026, 10, 9, 8, 15).getTime(), '08:15')
})
it('★ D4 永不成立（2 月 30 日）⇒ null', () => {
  eq(nextCronRun('0 0 30 2 *', at(2026, 1, 1)), null, 'null')
})

console.log('── E 人类描述与多次预览 ──')
it('E1 常见形状给一句话（zh；P1-23 末批起 `describeCron` 多收 locale）', () => {
  eq(describeCron('* * * * *', 'zh'), '每分钟', '每分钟')
  eq(describeCron('*/15 * * * *', 'zh'), '每 15 分钟', '每 15 分钟')
  eq(describeCron('0 * * * *', 'zh'), '每小时的 00 分', '每小时')
  eq(describeCron('0 9 * * *', 'zh'), '每天 09:00', '每天')
  eq(describeCron('0 9 * * 1', 'zh'), '每周一 09:00', '每周一')
  eq(describeCron('0 18 * * 1-5', 'zh'), '工作日 18:00', '工作日')
  eq(describeCron('0 0 1 * *', 'zh'), '每月 1 日 00:00', '每月')
})
it('E1b 同一个表达式在 en 下给英文（末批之前这里恒为中文）', () => {
  eq(describeCron('* * * * *', 'en'), 'Every minute', 'everyMinute')
  eq(describeCron('*/15 * * * *', 'en'), 'Every 15 minutes', 'everyNMinutes')
  eq(describeCron('0 9 * * 1', 'en'), 'Every Mon at 09:00', 'weeklyAt')
  eq(describeCron('0 0 1 * *', 'en'), 'Monthly on day 1 at 00:00', 'monthlyAt')
  // 反证：en 下不许再落回中文（漏接 locale 的症状就是这一条）
  assertNoCjk(describeCron('0 9 * * *', 'en'), 'dailyAt')
})
it('E2 复杂形状 ⇒ null（认不出就不硬描述）', () => {
  eq(describeCron('0 9,18 * * *', 'zh'), null, '多值')
  eq(describeCron('0 9 1,15 * *', 'zh'), null, '多日')
})
it('E3 `nextCronRuns` 连算 N 次（本地时区）', () => {
  const runs = nextCronRuns('0 9 * * *', 3, at(2026, 10, 9, 0, 0))
  eq(runs.length, 3, '数量')
  eq(runs[0]?.getTime(), at(2026, 10, 9, 9, 0).getTime(), '第 1 次')
  eq(runs[1]?.getTime(), at(2026, 10, 10, 9, 0).getTime(), '第 2 次')
  eq(runs[2]?.getTime(), at(2026, 10, 11, 9, 0).getTime(), '第 3 次')
})

console.log(
  failed === 0
    ? `\n✅ cron 自证通过（P1-6）：${passed} 项全通过`
    : `\n❌ cron 自证未通过：${failed} 项失败 / ${passed} 项通过`,
)
process.exit(failed === 0 ? 0 : 1)
