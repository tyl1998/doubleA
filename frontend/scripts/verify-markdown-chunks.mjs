#!/usr/bin/env node
/**
 * verify-markdown-chunks.mjs —— 流式正文化块（内存优化 P3）**无依赖**验收
 *
 * 跑法：`node --import tsx frontend/scripts/verify-markdown-chunks.mjs`
 *      （或 `pnpm --filter @doubulea/frontend verify:markdown-chunks`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一段必须单独断言
 * ─────────────────────────────────────────────────────────────────────
 * `markdownChunks.ts#streamingMarkdownChunks` 决定"把哪一段交给 `react-markdown`" ——
 * 切错了**不会报错**，只会：
 *   · 把围栏代码块切成"半截代码 + 一段普通文本"（看着像模型输出坏了）；
 *   · 或者永远切不出前缀（等于没有优化，每帧仍然全量解析）。
 * 两条都是"界面看起来只是有点怪"的那类问题，只有断言抓得住。
 *
 * 本档只验纯函数（不导入 React / 不解析 Markdown）：
 *   ① 没有任何完整块时 `stable === ''`（整段进尾巴）；
 *   ② 有完整块时，前缀以空行结尾、尾巴不含那个空行；
 *   ③ **围栏代码块内部的空行不算边界**（这是最容易写错的一条）；
 *   ④ 未闭合的围栏之后的内容一律进尾巴；
 *   ⑤ 前缀 + 尾巴 === 原文（切分不能丢字符）；
 *   ⑥ 增量喂入时，前缀一旦出现就不再变化（优化的前提）；
 *   ⑦ `shouldParseTail` 的阈值口径。
 */

import assert from 'node:assert/strict'

import {
  STREAMING_TAIL_RENDER_LIMIT,
  shouldParseTail,
  streamingMarkdownChunks,
} from '../src/features/chat/markdownChunks.ts'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

console.log('A. 基本切分')

check('A1 没有空行 ⇒ 全部进尾巴', () => {
  const chunks = streamingMarkdownChunks('第一段还没写完')
  assert.equal(chunks.stable, '')
  assert.equal(chunks.tail, '第一段还没写完')
})

check('A2 一个完整段落后有空行 ⇒ 前缀截止到空行', () => {
  const text = '第一段。\n\n第二段还在写'
  const chunks = streamingMarkdownChunks(text)
  assert.equal(chunks.stable, '第一段。\n\n')
  assert.equal(chunks.tail, '第二段还在写')
})

check('A3 多个空行 ⇒ 取**最后一个**边界', () => {
  const text = 'A\n\nB\n\nC 还在写'
  const chunks = streamingMarkdownChunks(text)
  assert.equal(chunks.stable, 'A\n\nB\n\n')
  assert.equal(chunks.tail, 'C 还在写')
})

check('A4 前缀 + 尾巴 === 原文（任何输入都不丢字符）', () => {
  const samples = [
    '',
    'x',
    'x\n',
    'x\n\n',
    'x\n\n\n',
    'a\n\nb\n\nc',
    '中文\n\n```js\nconst a = 1\n```\n\n尾巴',
  ]
  for (const sample of samples) {
    const { stable, tail } = streamingMarkdownChunks(sample)
    assert.equal(stable + tail, sample, `切分丢了字符：${JSON.stringify(sample)}`)
  }
})

console.log('B. 围栏代码块（最容易写错的一条）')

check('B1 围栏内部的空行**不算**边界', () => {
  const text = '```js\nconst a = 1\n\nconst b = 2\n'
  const chunks = streamingMarkdownChunks(text)
  // 围栏还没闭合 ⇒ 没有任何安全边界 ⇒ 全部进尾巴（按纯文本渲染，不会切出半截代码块）
  assert.equal(chunks.stable, '')
  assert.equal(chunks.tail, text)
})

check('B2 围栏闭合之后才出现边界', () => {
  const text = '```js\nconst a = 1\n\nconst b = 2\n```\n\n说明还在写'
  const chunks = streamingMarkdownChunks(text)
  assert.equal(chunks.stable, '```js\nconst a = 1\n\nconst b = 2\n```\n\n')
  assert.equal(chunks.tail, '说明还在写')
})

check('B3 ~~~ 围栏同样识别（且不把 ``` 当闭围栏）', () => {
  const text = '~~~\ncode\n\nmore\n~~~\n\n尾巴'
  const chunks = streamingMarkdownChunks(text)
  assert.equal(chunks.stable, '~~~\ncode\n\nmore\n~~~\n\n')
  assert.equal(chunks.tail, '尾巴')
})

check('B4 正文里偶发的 ``` 片段不算开围栏（info string 含反引号）', () => {
  const text = '写了一个 ```js 片段\n\n下一段'
  const chunks = streamingMarkdownChunks(text)
  // 反引号围栏的 info string 不能含反引号 ⇒ 第一行不是围栏 ⇒ 空行是合法边界
  assert.equal(chunks.stable, '写了一个 ```js 片段\n\n')
  assert.equal(chunks.tail, '下一段')
})

check('B5 缩进 3 空格以内的围栏也算围栏', () => {
  const text = '   ```\ncode\n\nmore\n   ```\n\n尾巴'
  const chunks = streamingMarkdownChunks(text)
  assert.equal(chunks.tail, '尾巴')
})

console.log('C. 增量稳定性（优化的前提）')

check('C1 逐字符喂入：前缀一旦出现就不再变化（不跨过新边界时）', () => {
  const target = '第一段写完了。\n\n第二段：\n\n第三段还在写'
  let previousStable = ''
  let grewWithoutChange = 0
  for (let index = 1; index <= target.length; index += 1) {
    const { stable } = streamingMarkdownChunks(target.slice(0, index))
    // 前缀必须是上一次前缀的前缀扩展（只能变长，不能改内容）
    assert.ok(stable.startsWith(previousStable), `前缀被改写了：${JSON.stringify(previousStable)} → ${JSON.stringify(stable)}`)
    if (stable === previousStable) grewWithoutChange += 1
    previousStable = stable
  }
  // 大部分字符（尾巴段）不应改变前缀 —— 否则"稳定前缀"名不副实
  assert.ok(grewWithoutChange > target.length / 2, `前缀变化过于频繁（${grewWithoutChange}/${target.length}）`)
})

check('C2 同一段文本重复调用得到同一份切分（纯函数）', () => {
  const text = 'A\n\nB\n\nC'
  assert.deepEqual(streamingMarkdownChunks(text), streamingMarkdownChunks(text))
})

console.log('D. 尾巴长度阈值')

check('D1 短尾巴交给纯文本渲染', () => {
  assert.equal(shouldParseTail('短'), false)
})

check('D2 超过阈值才交给解析器（极端长行）', () => {
  assert.equal(shouldParseTail('x'.repeat(STREAMING_TAIL_RENDER_LIMIT)), false)
  assert.equal(shouldParseTail('x'.repeat(STREAMING_TAIL_RENDER_LIMIT + 1)), true)
})

console.log(`\n✓ verify-markdown-chunks：${passed} 条断言全部通过`)
