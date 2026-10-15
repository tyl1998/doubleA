#!/usr/bin/env node
/**
 * verify-memory-ui.mjs —— 长期记忆面板前端**无依赖**验收（P1-8）
 *
 * 跑法：`pnpm verify:memory-ui`（= `node --import tsx scripts/verify-memory-ui.mjs`）
 *
 * 为什么一条依赖都不需要：本批前端侧的风险集中在 `memoryModel.ts` 的**纯展示函数**上 ——
 * 来源文案错了**不会报错**，但会把"原会话已删除"显示成一个可点击的失效链接（把不可用说成可用）。
 * 全是纯函数 ⇒ 直接喂字面量逐条断言（P0-1-35 / P1-7 同款手法）。
 *
 * ⚠️ 本档**验不了**：后端记忆读写/上限/权限、浏览器里面板渲染成什么样 ⇒ 分别属后端与浏览器端测。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const useColor = process.stdout.isTTY === true
const c = { g: useColor ? '\u001b[32m' : '', r: useColor ? '\u001b[31m' : '', x: useColor ? '\u001b[0m' : '' }
let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const { memorySourceText, memoryKindLabel, memoryKindColor, memoryScopeLabel } = await import(
  '../src/pages/tasks/memoryModel.ts'
)

console.log('── M1 memorySourceText（来源文案）──')
it('原会话存在 ⇒ 显示标题', () => {
  eq(
    memorySourceText({ sourceConversationId: 'c1', sourceAvailable: true, sourceTopic: '报销流程' }),
    '报销流程',
    '有标题',
  )
})
it('原会话存在但未命名 ⇒ 未命名会话', () => {
  eq(
    memorySourceText({ sourceConversationId: 'c1', sourceAvailable: true, sourceTopic: null }),
    '未命名会话',
    '未命名',
  )
})
it('原会话已删 ⇒ 原会话已删除（不可点）', () => {
  eq(
    memorySourceText({ sourceConversationId: 'c1', sourceAvailable: false, sourceTopic: null }),
    '原会话已删除',
    '已删除',
  )
})
it('没有来源（手动添加）⇒ 手动添加', () => {
  eq(
    memorySourceText({ sourceConversationId: null, sourceAvailable: false, sourceTopic: null }),
    '手动添加',
    '手动',
  )
})

console.log('── M2 类型 / 作用域 标签 ──')
it('v2 类型标签（画像/重点）与色', () => {
  eq(memoryKindLabel('PROFILE'), '画像', 'PROFILE label')
  eq(memoryKindLabel('HIGHLIGHT'), '重点', 'HIGHLIGHT label')
  eq(memoryKindColor('PREFERENCE'), 'purple', 'PREFERENCE color')
})
it('作用域标签（全局记忆 / Agent 记忆）', () => {
  eq(memoryScopeLabel('USER'), '全局记忆', 'USER scope')
  eq(memoryScopeLabel('AGENT'), 'Agent 记忆', 'AGENT scope')
})

console.log('── M3 源码级守门（契约接线）──')
it('对话页接了记忆开关与提示组件', () => {
  // ⚠️ R4（2026-10-13）：会话级记忆开关从 AntD `Switch` 改为**输入框下方的图标按钮**
  // （`ConversationSettings` 里的「记入记忆」控制，`BulbOutlined` + `onToggleMemoryExcluded`）。
  // 守门分两处读：提示栈在 ChatPage、开关在 ConversationSettings。
  const chat = readFileSync(join(here, '../src/pages/chat/ChatPage.tsx'), 'utf8')
  const settings = readFileSync(join(here, '../src/features/chat/ConversationSettings.tsx'), 'utf8')
  if (!chat.includes('MemoryNoticeStack') || !chat.includes('ConversationSettings')) {
    throw new Error('ChatPage 未接入 ConversationSettings / MemoryNoticeStack')
  }
  if (!settings.includes('BulbOutlined') || !settings.includes('onToggleMemoryExcluded')) {
    throw new Error('ConversationSettings 未接入会话记忆开关（图标按钮）')
  }
})
it('任务中心挂了「活动」「记忆」两个 tab', () => {
  const tasks = readFileSync(join(here, '../src/pages/tasks/TasksPage.tsx'), 'utf8')
  if (!tasks.includes('<ActivityPanel />') || !tasks.includes('<MemoryPanel />')) {
    throw new Error('TasksPage 未挂 ActivityPanel / MemoryPanel')
  }
})
it('记忆面板支持作用域与提升为全局（P1-8a）', () => {
  const panel = readFileSync(join(here, '../src/pages/tasks/MemoryPanel.tsx'), 'utf8')
  if (!panel.includes('提升为全局') || !panel.includes('作用域')) {
    throw new Error('MemoryPanel 未实现作用域选择 / 提升为全局')
  }
})

console.log('── M4 记忆提示修复守门 ──')
it('后端 `drainMemoryNotices` 只消费 AUTO、保留 SUGGEST（否则点"记住"找不到条目、静默不落库）', () => {
  const svc = readFileSync(join(here, '../../backend/src/services/memory.service.ts'), 'utf8')
  if (!svc.includes("notice.kind === 'SUGGEST'")) {
    throw new Error('drainMemoryNotices 未保留 SUGGEST ⇒ 点"记住"会 applied:false、记忆写不进去')
  }
})
it('提示栈：按 id 去重 + AUTO「撤销」直接删记忆 + SUGGEST 关闭走 REJECT', () => {
  const src = readFileSync(join(here, '../src/features/chat/MemoryControls.tsx'), 'utf8')
  for (const needle of [
    'useDeleteMemory',
    '!seen.has(item.id)',
    'removeMemory.mutate',
    "action: 'REJECT'",
  ]) {
    if (!src.includes(needle)) throw new Error(`MemoryControls 缺少修复点：${needle}`)
  }
})

console.log(`\n${failed === 0 ? c.g : c.r}memory-ui：${passed} 通过，${failed} 失败${c.x}`)
process.exit(failed === 0 ? 0 : 1)
