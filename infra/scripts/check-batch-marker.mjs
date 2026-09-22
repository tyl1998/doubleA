#!/usr/bin/env node
/**
 * check-batch-marker.mjs —— **批次标识自检**（P0-1-20 新增，`pnpm check:batch`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ─────────────────────────────────────────────────────────────────────
 * `backend/src/index.ts` 启动信封里的 `step` 是"一批手改一次"的字符串，它的作用是
 * **冒烟时能一眼看出跑的是哪一版代码**。这条纪律写进了文档、也写进了收尾清单，
 * 但实际漏了 4 次（P0-1-7 / 8 / 9 连漏三批，P0-1-19 又漏一次 —— 启动日志一直报
 * 「P0-1-18」，而那一版的 `READY` 语义已经完全不同）。
 *
 * 结论：**靠人记的"每批手改一次"必然腐烂**，于是把它变成一条机器检查 —— 比对
 * 「`docs/06` 里最后一个 `[✓]` 的批次号」与「`index.ts` 里 `step` 的批次号」。
 * 两者不一致时**唯一**的两种可能：① 代码改了忘改标识（本脚本想抓的）；
 * ② `docs/06` 状态回写漏了（同样是收尾纪律问题）。
 *
 * ⚠️ 它必须在**文档回写之后**跑（批次状态与标识在同一步收尾里改）—— 所以它是收尾的
 *    倒数第二步（`git commit` 之前的最后一道），不放进 `verify:app`：后者在批次进行中
 *    会被反复执行，那时 `docs/06` 还没标 `[✓]`，会变成"一直在报一件本来就还没做的事"。
 *
 * 用法：
 *   pnpm check:batch        # 通过 → exit 0；不一致 → 打印两边实际值 + 怎么改，exit 1
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PLAN = resolve(repoRoot, 'docs/06-实施计划.md')
const ENTRY = resolve(repoRoot, 'backend/src/index.ts')

/** `#### P0-1-19 入库 + …  \`[✓]\` 2026-09-22` —— 批次标题行 + 已完成标记 */
const BATCH_HEADING = /^####\s+(P\d+-\d+-\d+)\s+/
const DONE_MARK = '`[✓]`'
/** `step: 'P0-1-20 双路检索 + RRF 融合',` */
const STEP_LINE = /step:\s*'([^']+)'/

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

/** `docs/06` 里**最后一个**标了 `[✓]` 的批次（批次是按时间序排列的） */
function lastCompletedBatch(planText) {
  let found = null
  planText.split('\n').forEach((line, index) => {
    if (!line.includes(DONE_MARK)) return
    const matched = BATCH_HEADING.exec(line)
    if (matched === null) return
    found = {
      id: matched[1],
      // 标题行尾部还挂着完成日期（`… \`[✓]\` 2026-09-22`），打印时去掉更干净
      title: line
        .replace(BATCH_HEADING, '')
        .replace(DONE_MARK, '')
        .replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, '')
        .trim(),
      line: index + 1,
    }
  })
  return found
}

const planText = readText(PLAN)
const entryText = readText(ENTRY)

const done = lastCompletedBatch(planText)
if (done === null) {
  console.error('❌ 在 docs/06-实施计划.md 里找不到任何标了 `[✓]` 的批次标题 —— 检查文档格式是否被改坏')
  process.exit(2)
}

const stepMatch = STEP_LINE.exec(entryText)
if (stepMatch === null) {
  console.error('❌ 在 backend/src/index.ts 里找不到 `step: \'…\'` —— 启动信封是不是被改写了？')
  process.exit(2)
}
const step = stepMatch[1]

if (step.includes(done.id)) {
  console.log(`✅ 批次标识一致：docs/06 最后完成的批次 = ${done.id}（第 ${done.line} 行），启动信封 step = "${step}"`)
  process.exit(0)
}

console.error(
  [
    '❌ 批次标识不一致 —— 「每批手改一次」的 step 漏改了（`docs/06` §七 的收尾纪律）：',
    `   · docs/06 最后完成的批次：${done.id} ${done.title}（第 ${done.line} 行）`,
    `   · backend/src/index.ts 的 step："${step}"`,
    '   修法：把 index.ts 的 step 改成当前批次（形如 `P0-1-20 <批次标题>`），再重跑本脚本。',
  ].join('\n'),
)
process.exit(1)
