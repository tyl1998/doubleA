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
 * 「施工图里最后一个 `[✓]` 的批次号」与「`index.ts` 里 `step` 的批次号」。
 * 两者不一致时**唯一**的两种可能：① 代码改了忘改标识（本脚本想抓的）；
 * ② 施工图状态回写漏了（同样是收尾纪律问题）。
 *
 * ⚠️ **2026-09-26 起扫描范围变了**（施工图拆分）：`docs/06-实施计划.md` 的完成态详规
 *    （含全部 `[✓]` 批次标题行）已移入 `docs/归档/` ⇒ 本脚本改为**扫主文件 + 归档目录**，
 *    并**按批次号取最大**（不再依赖"文件里最后出现的那个"，因为现在跨文件了）。
 *    ⚠️ 拆出去的归档必须保持 `#### P0-x-y … \`[✓]\`` 的标题层级 —— 改了层级本脚本就失明。
 *
 * ⚠️ 它必须在**文档回写之后**跑（批次状态与标识在同一步收尾里改）—— 所以它是收尾的
 *    倒数第二步（`git commit` 之前的最后一道），不放进 `verify:app`：后者在批次进行中
 *    会被反复执行，那时施工图还没标 `[✓]`，会变成"一直在报一件本来就还没做的事"。
 *
 * ⚠️ **2026-09-26 起批次号允许字母后缀**（`P0-3-0a` / `0b` / `6b` / `9b`）：P0-3 的步骤表里有
 *    四个"插在整数步之间的子步"，若沿用只认纯数字的正则，本脚本会**读不出它们** ⇒ 从 P0-3 起
 *    会一直停在 `P0-2-13`、**每批收尾必红**，纪律随之废掉。故两处放宽：正则接受 `[0-9a-z]+`，
 *    排序键把字母后缀折算成一个小权重（排在同一个数字键的后面、下一个数字键的前面）。
 *
 * 用法：
 *   pnpm check:batch        # 通过 → exit 0；不一致 → 打印两边实际值 + 怎么改，exit 1
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DOCS = resolve(repoRoot, 'docs')
const ENTRY = resolve(repoRoot, 'backend/src/index.ts')

/** `#### P0-1-19 入库 + …  \`[✓]\` 2026-09-22` —— 批次标题行 + 已完成标记 */
const BATCH_HEADING = /^####\s+(P\d+-\d+-[0-9a-z]+)\s+/
const DONE_MARK = '`[✓]`'
/** `step: 'P0-1-20 双路检索 + RRF 融合',` */
const STEP_LINE = /step:\s*'([^']+)'/

/** 施工图主文件 + 归档目录里所有 `06*.md` —— 完成态的批次标题住在归档里 */
function planFiles() {
  const found = []
  for (const dir of [DOCS, resolve(DOCS, '归档')]) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (/^06.*\.md$/.test(name)) found.push(resolve(dir, name))
    }
  }
  return found
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

/**
 * `P0-2-13` → 可比较的数值键（键最大者 = 最后完成的批次）。
 *
 * 字母后缀（`P0-3-0a` / `6b`）排在**同一个数字键之后、下一个数字键之前**：
 * `P0-3-0` < `P0-3-0a` < `P0-3-0b` < `P0-3-1` < `P0-3-6b` < `P0-3-7`。
 */
function batchKey(id) {
  const m = /^P(\d+)-(\d+)-(\d+)([a-z]*)$/.exec(id)
  if (m === null) return -1
  const suffix = m[4] === '' ? 0 : m[4].charCodeAt(0) - 96 // a=1, b=2 …
  return Number(m[1]) * 1e9 + Number(m[2]) * 1e6 + Number(m[3]) * 1e3 + suffix
}

/** 扫全部施工图文件，收集标了 `[✓]` 的批次标题，取**批次号最大**的那个 */
function lastCompletedBatch() {
  const found = []
  for (const path of planFiles()) {
    const text = readText(path)
    text.split('\n').forEach((line, index) => {
      if (!line.includes(DONE_MARK)) return
      const matched = BATCH_HEADING.exec(line)
      if (matched === null) return
      found.push({
        id: matched[1],
        // 标题行尾部还挂着完成日期（`… \`[✓]\` 2026-09-22`），打印时去掉更干净
        title: line
          .replace(BATCH_HEADING, '')
          .replace(DONE_MARK, '')
          .replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, '')
          .trim(),
        file: relative(repoRoot, path),
        line: index + 1,
      })
    })
  }
  found.sort((a, b) => batchKey(a.id) - batchKey(b.id))
  return found.length > 0 ? found[found.length - 1] : null
}

const done = lastCompletedBatch()
if (done === null) {
  console.error(
    '❌ 在 docs/06-实施计划.md 及其归档里找不到任何标了 `[✓]` 的批次标题 —— 检查文档格式或归档目录是否被改坏',
  )
  process.exit(2)
}

const entryText = readText(ENTRY)
const stepMatch = STEP_LINE.exec(entryText)
if (stepMatch === null) {
  console.error('❌ 在 backend/src/index.ts 里找不到 `step: \'…\'` —— 启动信封是不是被改写了？')
  process.exit(2)
}
const step = stepMatch[1]

if (step.includes(done.id)) {
  console.log(
    `✅ 批次标识一致：施工图最后完成的批次 = ${done.id}（${done.file} 第 ${done.line} 行），启动信封 step = "${step}"`,
  )
  process.exit(0)
}

console.error(
  [
    '❌ 批次标识不一致 —— 「每批手改一次」的 step 漏改了（`docs/06` §六 的收尾纪律）：',
    `   · 施工图最后完成的批次：${done.id} ${done.title}（${done.file} 第 ${done.line} 行）`,
    `   · backend/src/index.ts 的 step："${step}"`,
    '   修法：把 index.ts 的 step 改成当前批次（形如 `P0-1-20 <批次标题>`），再重跑本脚本。',
  ].join('\n'),
)
process.exit(1)
