/**
 * 记忆面板的**零依赖纯逻辑**（P1-8 / v2 P1-8a）
 *
 * 依据：`shared/src/memory.ts`（契约）、`docs/子方案/TaskAgent会话持久化与长期记忆.md` §五（HCI）/§八（v2）。
 * 只放"展示翻译"：类型/作用域标签色、来源文案。
 */

import type { MemoryKind, MemoryScope } from '@doubulea/shared'
import {
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  MEMORY_SCOPE_LABELS,
  MEMORY_SCOPES,
} from '@doubulea/shared'

/** 类型下拉的选项（顺序与 `MEMORY_KINDS` 一致） */
export const MEMORY_KIND_OPTIONS = MEMORY_KINDS.map((kind) => ({ value: kind, label: MEMORY_KIND_LABELS[kind] }))

/** 作用域下拉的选项（全部 / 全局记忆 / Agent 记忆） */
export const MEMORY_SCOPE_OPTIONS = MEMORY_SCOPES.map((scope) => ({
  value: scope,
  label: MEMORY_SCOPE_LABELS[scope],
}))

/** 类型 → AntD `Tag` 色 */
const KIND_COLOR: Record<MemoryKind, string> = {
  PROFILE: 'blue',
  PREFERENCE: 'purple',
  HABIT: 'cyan',
  HIGHLIGHT: 'geekblue',
  OTHER: 'default',
}

export function memoryKindLabel(kind: MemoryKind): string {
  return MEMORY_KIND_LABELS[kind]
}

export function memoryKindColor(kind: MemoryKind): string {
  return KIND_COLOR[kind]
}

export function memoryScopeLabel(scope: MemoryScope): string {
  return MEMORY_SCOPE_LABELS[scope]
}

/**
 * 来源文案（HCI §5.5：原会话被删 ⇒ 显示"原会话已删除"，不带跳转）。
 * `sourceConversationId` 为 `null` = 用户手动添加。
 */
export function memorySourceText(input: {
  sourceConversationId: string | null
  sourceAvailable: boolean
  sourceTopic: string | null
}): string {
  if (input.sourceConversationId === null) return '手动添加'
  if (!input.sourceAvailable) return '原会话已删除'
  return input.sourceTopic ?? '未命名会话'
}
