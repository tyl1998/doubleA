#!/usr/bin/env node
/**
 * title-model-regression.ts —— 会话标题模型生成里**确定性部分**的自证基线
 *
 * 跑法：`pnpm --filter @doubulea/backend title:regression`
 *      （= `node --import tsx scripts/title-model-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：契约 `shared/src/titleModel.ts`（`normalizeGeneratedTitle` / `deriveConversationTopic`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么只验**纯函数**（不碰上游、不碰 DB）
 * ─────────────────────────────────────────────────────────────────────
 * 真跑"用模型生成标题"要一个真实 Provider，留给用户手动验。本脚本守的是这条链路里
 * **最容易写错、也最该回归**的确定性部分（错了都不会报错，只会把脏标题写进库）：
 *   ① **模型回复归一**：代码围栏 / 引号 / 句末标点 / 多行解释 / 超长 各自得到什么；
 *   ② **回落判据**：解析不出时必须返回 `null`（⇒ 调用方保留确定性标题），而不是写一个空标题；
 *   ③ **确定性截断的对照**：确认未配置时仍走 `deriveConversationTopic`（原文截断）。
 */

import { deriveConversationTopic, normalizeGeneratedTitle, TITLE_GENERATE_MAX_CHARS } from '@doubulea/shared'

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n    实际 ${a}\n    期望 ${e}`)
}

console.log('title-model-regression —— 会话标题生成（纯函数）\n')

it('归一：去掉代码围栏', () => {
  assertEqual(normalizeGeneratedTitle('```json\n修复登录按钮\n```'), '修复登录按钮', '去掉 ```json 围栏')
  assertEqual(normalizeGeneratedTitle('```\n修复登录按钮\n```'), '修复登录按钮', '去掉裸围栏')
})

it('归一：去掉引号 / 书名号 / 各类成对包裹', () => {
  assertEqual(normalizeGeneratedTitle('「修复登录按钮」'), '修复登录按钮', '中文书名号')
  assertEqual(normalizeGeneratedTitle('“修复登录按钮”'), '修复登录按钮', '中文引号')
  assertEqual(normalizeGeneratedTitle('"修复登录按钮"'), '修复登录按钮', '英文引号')
  assertEqual(normalizeGeneratedTitle('《修复登录按钮》'), '修复登录按钮', '书名号')
})

it('归一：去掉句末标点', () => {
  assertEqual(normalizeGeneratedTitle('修复登录按钮。'), '修复登录按钮', '句号')
  assertEqual(normalizeGeneratedTitle('修复登录按钮？'), '修复登录按钮', '问号')
  assertEqual(normalizeGeneratedTitle('Fix the login button!'), 'Fix the login button', '感叹号')
})

it('归一：多行时取第一行非空文本（模型可能"标题 + 解释"两行都给）', () => {
  assertEqual(
    normalizeGeneratedTitle('\n\n修复登录按钮\n\n这个标题概括了用户想做的事'),
    '修复登录按钮',
    '取第一行',
  )
})

it('归一：压空白（多空格 / 换行内空白 → 单空格）', () => {
  assertEqual(normalizeGeneratedTitle('  修复   登录   按钮  '), '修复 登录 按钮', '压空白')
})

it('归一：超长按码点截断到上限', () => {
  const long = '标'.repeat(TITLE_GENERATE_MAX_CHARS + 20)
  const out = normalizeGeneratedTitle(long)
  assertEqual(out === null ? -1 : [...out].length, TITLE_GENERATE_MAX_CHARS, '截断到上限')
})

it('归一：拿不到可用标题时返回 null（⇒ 调用方保留确定性标题，不写空标题）', () => {
  assertEqual(normalizeGeneratedTitle(''), null, '空串')
  assertEqual(normalizeGeneratedTitle('   \n  '), null, '纯空白')
  assertEqual(normalizeGeneratedTitle('```\n```'), null, '只有围栏')
  assertEqual(normalizeGeneratedTitle('」。'), null, '只有标点与包裹')
})

it('对照：确定性截断仍可用（未配置 / 回落时走它）', () => {
  // `deriveConversationTopic` 是原文截断：trim + 连续空白压单空格 + 按码点截到 255
  assertEqual(
    deriveConversationTopic('  帮我看一下  新建会话的标题回填  '),
    '帮我看一下 新建会话的标题回填',
    '原文截断（压空白、去首尾）',
  )
})

console.log('')
console.log(`title-model-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)