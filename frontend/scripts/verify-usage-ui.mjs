#!/usr/bin/env node
/**
 * verify-usage-ui.mjs —— 用量统计页前端**无依赖**验收（P1-7）
 *
 * 跑法：`pnpm verify:usage-ui`
 *      （= `node --import tsx frontend/scripts/verify-usage-ui.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批前端侧的风险集中在**时间区间**与**读数格式化**两处纯函数上，它们错了**不会报错**：
 *   · "本月"的起点若用 `new Date('2026-08-01')`（被当 UTC 午夜）⇒ 东八区少了 8 小时，
 *     报表**少算月初 8 小时**的量，看着完全合理；
 *   · "到某天"若取当天 00:00 而不是次日 00:00 ⇒ 用户选的最后一天**整天不算**；
 *   · `2026-02-31` 会被 `Date` 静默进位成 3 月 ⇒ 必须反向校验；
 *   · `null`（没上报）若被格式化成 `0` ⇒ 报表说谎（`NULL` ≠ `0`）。
 * 这些全是纯函数 ⇒ 直接喂字面量逐条断言（P0-1-35 / P0-3-10 同款手法）。
 *
 * ⚠️ 本档**验不了**：后端聚合 SQL 对不对、`/admin/usage` 在浏览器里渲染成什么样、
 * 权限是不是真的仅 ADMIN ⇒ 分别属后端与浏览器端测。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ───────────────────────────── 断言脚手架 ─────────────────────────────

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0
let currentGroup = null
const groups = []

function groupStart(id, title, note) {
  currentGroup = { id, title, note, passed: 0, failed: 0 }
  groups.push(currentGroup)
  console.log(`\n${c.b}── ${id} ${title} ──${c.x}`)
  if (note !== undefined) console.log(`   ${c.d}${note}${c.x}`)
}

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    if (currentGroup !== null) currentGroup.passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    if (currentGroup !== null) currentGroup.failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ───────────────────────────── 被测源码 ─────────────────────────────

const {
  usageRangePresets,
  thisMonthRange,
  lastMonthRange,
  lastDaysRange,
  dateInputValue,
  dayStartIso,
  dayEndIso,
  rangeFromDayInputs,
  formatTokens,
  formatCount,
  formatDurationMs,
  coverageText,
} = await import('../src/pages/admin/usageModel.ts')

/** 固定"此刻"（本地时区）：2026-08-13 15:30 —— 让区间断言可复现 */
const NOW = new Date(2026, 7, 13, 15, 30, 0, 0)

// ═════════════════════════ A 组：时间区间 ═════════════════════════

groupStart('A', '时间区间（本地时区，左闭右开）', '本月 / 上月 / 近 N 天 / 自定义')

await it('A1 本月 = 当月 1 日 00:00 → 此刻', () => {
  const range = thisMonthRange(NOW)
  assertEqual(dateInputValue(range.from), '2026-08-01', '本月起点是 1 日（本地，不是 UTC）')
  assertEqual(range.to, NOW.toISOString(), '终点是此刻')
})

await it('A2 上月 = 上月 1 日 → 本月 1 日（整月）', () => {
  const range = lastMonthRange(NOW)
  assertEqual(dateInputValue(range.from), '2026-07-01', '上月起点')
  assertEqual(dateInputValue(range.to), '2026-08-01', '终点是本月 1 日（左闭右开正好一整月）')
})

await it('A3 近 7 天含今天：08-07 → 此刻', () => {
  const range = lastDaysRange(7, NOW)
  assertEqual(dateInputValue(range.from), '2026-08-07', '13 - 6 = 7 号')
  assertEqual(range.to, NOW.toISOString(), '终点是此刻')
})

await it('A4 预设齐全且本月默认（顺序即界面顺序）', () => {
  const presets = usageRangePresets(NOW)
  assertEqual(presets.map((preset) => preset.key).join(','), 'thisMonth,lastMonth,last7,last30', '预设键与顺序')
  assertEqual(presets[0].label, '本月', '第一项是本月')
})

await it('A5 `dayStartIso` 按本地构造（不是 UTC 午夜）', () => {
  const iso = dayStartIso('2026-08-01')
  assert(iso !== null, '合法日期')
  assertEqual(dateInputValue(iso), '2026-08-01', 'round-trip 回到同一天')
})

await it('A6 `dayEndIso` = 次日 00:00（右开边界）', () => {
  const iso = dayEndIso('2026-08-13')
  assert(iso !== null, '合法日期')
  assertEqual(dateInputValue(iso), '2026-08-14', '次日 00:00 ⇒ 13 号当天算在内')
})

await it('A7 非法日期（进位）⇒ null，不静默进位', () => {
  assertEqual(dayStartIso('2026-02-31'), null, '2 月没有 31 日')
  assertEqual(dayStartIso('2026-13-01'), null, '没有 13 月')
  assertEqual(dayStartIso('2026/08/01'), null, '格式不符')
})

await it('A8 自定义区间：08-01 ~ 08-13 覆盖到 14 号 00:00；倒置 ⇒ null', () => {
  const range = rangeFromDayInputs('2026-08-01', '2026-08-13')
  assert(range !== null, '合法区间')
  assertEqual(dateInputValue(range.from), '2026-08-01', '起点')
  assertEqual(dateInputValue(range.to), '2026-08-14', '终点右开 = 次日')
  assertEqual(rangeFromDayInputs('2026-08-13', '2026-08-01'), null, '起点晚于终点 ⇒ null')
})

// ═════════════════════════ B 组：读数格式化（NULL ≠ 0） ═════════════════════════

groupStart('B', '读数格式化', 'token / 记录数 / 时长 / 覆盖度')

await it('B1 token：null ⇒ `—`（不是 0），有值千分位', () => {
  assertEqual(formatTokens(null), '—', '没上报就是不知道')
  assertEqual(formatTokens(0), '0', '真的 0 就显示 0')
  assertEqual(formatTokens(1234567), '1,234,567', '千分位')
})

await it('B2 记录数 / 轮次：千分位', () => {
  assertEqual(formatCount(0), '0', '0')
  assertEqual(formatCount(12345), '12,345', '千分位')
})

await it('B3 时长：ms / s / 分秒三档', () => {
  assertEqual(formatDurationMs(0), '0 ms', '0')
  assertEqual(formatDurationMs(500), '500 ms', '< 1s')
  assertEqual(formatDurationMs(1500), '1.5 s', '< 1min')
  assertEqual(formatDurationMs(90_000), '1 分 30 秒', '>= 1min')
})

await it('B4 覆盖度：records=0 ⇒ `—`，否则 `x / y 条上报`', () => {
  assertEqual(coverageText(0, 0), '—', '没有记录')
  assertEqual(coverageText(3, 10), '3 / 10 条上报', '覆盖度读数')
})

// ═════════════════════════ C 组：源码级守门 ═════════════════════════

groupStart('C', '源码级守门', 'URL 只在一处拼（与产物预览同款纪律）')

/** 去掉 `//` 行注释与 `/* *\/` 块注释（否则注释里提到路径会误报） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 递归收集 `src/` 下的 .ts/.tsx 文件（相对 `frontend/`） */
function collectSources(dir, base = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) files.push(...collectSources(join(dir, entry.name), relative))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(relative)
  }
  return files
}

await it('C1 `/api/usage/` 在 frontend/src 下恰好出现在一处（api/usage.ts）', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url))
  const hits = collectSources(srcDir).filter((relative) =>
    stripComments(readFileSync(join(srcDir, relative), 'utf8')).includes('/api/usage/'),
  )
  assertEqual(hits.join(','), 'api/usage.ts', 'URL 只许在 api/usage.ts 里拼')
})

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── 结论表 ──${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 用量统计前端纯逻辑验收通过（P1-7）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 用量统计前端纯逻辑验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
