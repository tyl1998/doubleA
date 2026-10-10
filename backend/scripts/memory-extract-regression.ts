#!/usr/bin/env node
/**
 * memory-extract-regression.ts —— 长期记忆"显式记住"链路的**自证基线**
 *
 * 跑法：`pnpm --filter @doubulea/backend memory:regression`
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §8.2（kind v2）/§8.3（抽取 v2）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么只验**纯函数**（不碰上游、不碰 DB）
 * ─────────────────────────────────────────────────────────────────────
 * 归一本身要问对话模型，真跑取证留给用户（`06` §六 第 30 条：智能体只做自证）。本脚本守的是
 * 这条链路里**最容易写错、也最该回归**的确定性部分（它们错了都不会报错，只会把噪声写进画像）：
 *   ① **模型回复解析**：JSON / ```json 围栏 / 坏 JSON / 空列表 时分别得到什么（解析失败必须抛，
 *      让调用方走降级 —— 与"模型明确说没有可记的"是两回事）；
 *   ② **非陈述过滤**：疑问句 / 非法 kind / 空文本不进画像；
 *   ③ **规则式降级**：初版把"把 X 记住"的第二句问句吞进画像（实测），这里逐字断言不再复现。
 */

const { parseMemoryProfileStatements, buildMemoryProfileMessages, extractRememberCandidates, hasRememberMarker } =
  await import('../src/orchestrator/memoryProfile.js')

// ───────────────────────────── 断言脚手架 ─────────────────────────────

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

function eq(label: string, actual: unknown, expected: unknown): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `实得 ${JSON.stringify(actual)}`)
}

function throws(label: string, fn: () => unknown): void {
  try {
    fn()
    check(label, false, '期望抛错，但没有')
  } catch {
    check(label, true)
  }
}

// ───────────────────────────── ① 模型回复解析 ─────────────────────────────

console.log('── ① parseMemoryProfileStatements（模型回复 → 陈述）──')

eq('标准 JSON', parseMemoryProfileStatements('{"statements":[{"text":"我是测试工程师","kind":"PROFILE"}]}'), [
  { text: '我是测试工程师', kind: 'PROFILE' },
])

eq(
  '```json 围栏 + 前后解释',
  parseMemoryProfileStatements('好的：\n```json\n{"statements":[{"text":"我一般周五做回归","kind":"HABIT"}]}\n```\n以上。'),
  [{ text: '我一般周五做回归', kind: 'HABIT' }],
)

eq('kind 小写也认', parseMemoryProfileStatements('{"statements":[{"text":"以后都用中文","kind":"preference"}]}'), [
  { text: '以后都用中文', kind: 'PREFERENCE' },
])

eq('空列表 ⇒ 空数组（模型判定无可记）', parseMemoryProfileStatements('{"statements":[]}'), [])

throws('没有 JSON ⇒ 抛错（走降级）', () => parseMemoryProfileStatements('抱歉，我不太确定。'))
throws('坏 JSON ⇒ 抛错（走降级）', () => parseMemoryProfileStatements('{ not json }'))
throws('缺 statements ⇒ 抛错（走降级）', () => parseMemoryProfileStatements('{"foo":1}'))

console.log('── ② 非陈述过滤 ──')

eq(
  '疑问句 / 非法 kind / 空文本都被丢弃 + 逐字去重',
  parseMemoryProfileStatements(
    JSON.stringify({
      statements: [
        { text: '为什么记不住？', kind: 'PROFILE' },
        { text: '', kind: 'PROFILE' },
        { text: '我是测试人员', kind: 'BOGUS' },
        { text: '我是测试人员', kind: 'PROFILE' },
        { text: '我是测试人员', kind: 'PROFILE' },
      ],
    }),
  ),
  [{ text: '我是测试人员', kind: 'PROFILE' }],
)

check('prompt 会带上用户原文', buildMemoryProfileMessages('记住：我是测试工程师').some((m) => String(m.content).includes('我是测试工程师')))

// ───────────────────────────── ③ 规则式降级 ─────────────────────────────

console.log('── ③ extractRememberCandidates（规则式降级）──')

check('命中"记住"标记', hasRememberMarker('把内容规范与协作流程记住'))
check('没有标记时不命中', !hasRememberMarker('这条规范很重要'))

eq(
  '★ 实测缺陷不再复现：问句不被吞进画像，"把 X 记住"取到宾语',
  extractRememberCandidates('你应该把这个内容规范以及协作流程记住，为什么记的东西那么奇怪？'),
  ['这个内容规范以及协作流程'],
)

eq('记住：X ⇒ 取标记之后', extractRememberCandidates('记住：我是测试工程师，负责 STG 环境'), [
  '我是测试工程师，负责 STG 环境',
])

eq('纯问句不产生候选', extractRememberCandidates('为什么记的东西那么奇怪？'), [])

eq('"记住这个吗"（疑问）被过滤', extractRememberCandidates('记住这个吗'), [])

eq('多句时各自成候选', extractRememberCandidates('记住：我用中文。也记住：我负责 STG'), [
  '我用中文',
  '我负责 STG',
])

// ───────────────────────────── 汇总 ─────────────────────────────

console.log(`\nmemory-extract：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
