#!/usr/bin/env node
/**
 * verify-message-window.mjs —— 消息流**渲染窗口**（内存优化 P5a）**无依赖**验收
 *
 * 跑法：`node --import tsx frontend/scripts/verify-message-window.mjs`
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须断言这一层
 * ─────────────────────────────────────────────────────────────────────
 * `windowMessages` 决定"画多少条"。它写错时**不报错**，只会：
 *   · 截掉了**尾部**（最新一轮 / 流式那一轮）⇒ 贴底跟随、撤回、重新生成、流式让位同时坏掉，
 *     而且表现为"偶尔少一条""点了撤回没反应"，最难查；
 *   · 或者 `hiddenCount` 与 `visible` 对不上 ⇒ 顶部占位的条数是假的；
 *   · 或者"展开"之后仍然有上限 ⇒ 用户点开也看不到更早的消息（以为数据丢了）。
 *
 * 本档只验纯函数（不导入 React）。
 */

import assert from 'node:assert/strict'

import { HISTORY_RENDER_LIMIT, windowMessages } from '../src/features/chat/messageWindow.ts'

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

const range = (count) => Array.from({ length: count }, (_, index) => index)

console.log('A. 基本窗口')

check('A1 不超过上限 ⇒ 全量渲染、不显示占位', () => {
  const messages = range(HISTORY_RENDER_LIMIT)
  const window = windowMessages(messages)
  assert.equal(window.hiddenCount, 0)
  assert.equal(window.visible.length, HISTORY_RENDER_LIMIT)
  assert.equal(window.visible[0], 0)
})

check('A2 超过上限 ⇒ **保留尾部**、截头部', () => {
  const messages = range(HISTORY_RENDER_LIMIT + 30)
  const window = windowMessages(messages)
  assert.equal(window.hiddenCount, 30)
  assert.equal(window.visible.length, HISTORY_RENDER_LIMIT)
  // 最后一条必须还在（流式 / 最新一轮 / 贴底跟随全挂在尾部）
  assert.equal(window.visible[window.visible.length - 1], messages[messages.length - 1])
  // 第一条是被留下的那一条（不是 0）
  assert.equal(window.visible[0], 30)
})

check('A3 顺序原样（不做任何重排）', () => {
  const messages = range(200)
  const { visible } = windowMessages(messages)
  for (let index = 1; index < visible.length; index += 1) {
    assert.ok(visible[index] > visible[index - 1], '窗口内的顺序被打乱了')
  }
})

check('A4 `visible + hiddenCount` 能还原总量', () => {
  for (const total of [0, 1, 119, 120, 121, 500]) {
    const { visible, hiddenCount } = windowMessages(range(total))
    assert.equal(visible.length + hiddenCount, total, `总量对不上：${total}`)
  }
})

console.log('B. 展开与边界')

check('B1 展开后返回全量、没有占位', () => {
  const messages = range(1000)
  const window = windowMessages(messages, { expanded: true })
  assert.equal(window.hiddenCount, 0)
  assert.equal(window.visible.length, 1000)
})

check('B2 自定义上限（测试与紧急下调用）', () => {
  const { visible, hiddenCount } = windowMessages(range(10), { limit: 3 })
  assert.equal(hiddenCount, 7)
  assert.deepEqual(visible, [7, 8, 9])
})

check('B3 上限非法（0 / 负数）不影响渲染（至少留 1 条）', () => {
  const { visible, hiddenCount } = windowMessages(range(5), { limit: 0 })
  assert.equal(visible.length, 1)
  assert.equal(hiddenCount, 4)
  assert.deepEqual(visible, [4])
})

check('B4 空列表 ⇒ 空窗口，不显示占位', () => {
  const window = windowMessages([])
  assert.equal(window.hiddenCount, 0)
  assert.equal(window.visible.length, 0)
})

check('B5 恰好等于上限时不显示占位（边界不差一）', () => {
  const window = windowMessages(range(HISTORY_RENDER_LIMIT), {})
  assert.equal(window.hiddenCount, 0)
  assert.equal(window.visible.length, HISTORY_RENDER_LIMIT)
})

console.log(`\n✓ verify-message-window：${passed} 条断言全部通过`)
