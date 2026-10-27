/**
 * 记忆面板的**零依赖纯逻辑**（P1-8 / v2 P1-8a）
 *
 * 依据：`shared/src/memory.ts`（契约）、`docs/子方案/TaskAgent会话持久化与长期记忆.md` §五（HCI）/§八（v2）。
 * 只放"展示翻译"：类型/作用域标签色、来源文案。
 *
 * ## P1-23：读数取 key + 传 locale（**不在本文件里写死中文**）
 *
 * 这个文件是"零依赖纯逻辑"，被 `verify-memory-ui.mjs` 直接 import 逐条断言 —— 所以它**不能**
 * import React（`useT()`）或前端 store。改成"函数多收一个 `locale` 参数 + 内部用 `shared#translate`"：
 * `translate` 是纯函数、零依赖 ⇒ 这个文件仍然可被无依赖验收档直接跑（口径同 §3.5）。
 *
 * ⚠️ 为什么不在这里再留一份中文常量（原 `memorySourceText` 那样）：那是一份**第二真相** ——
 * 改了字典而漏了这里，界面就会出现"字典是英文、这一格是中文"。键与译文都只在 `shared/src/i18n`。
 */

import type { MemoryKind, MemoryScope, MessageKey } from '@doubulea/shared'
import { MEMORY_KINDS, MEMORY_SCOPES, translate, type Locale } from '@doubulea/shared'

/** 类型 → i18n key（`shared#MEMORY_KIND_LABELS` 的前端覆盖，§3.5） */
export const MEMORY_KIND_KEY: Record<MemoryKind, MessageKey> = {
  PROFILE: 'label.memoryKind.PROFILE',
  PREFERENCE: 'label.memoryKind.PREFERENCE',
  HABIT: 'label.memoryKind.HABIT',
  HIGHLIGHT: 'label.memoryKind.HIGHLIGHT',
  OTHER: 'label.memoryKind.OTHER',
}

/** 作用域 → i18n key（`shared#MEMORY_SCOPE_LABELS` 的前端覆盖，§3.5） */
export const MEMORY_SCOPE_KEY: Record<MemoryScope, MessageKey> = {
  USER: 'label.memoryScope.USER',
  AGENT: 'label.memoryScope.AGENT',
}

/** 类型下拉的选项（顺序与 `MEMORY_KINDS` 一致；label 按 `locale` 取译文） */
export function memoryKindOptions(locale: Locale): { value: MemoryKind; label: string }[] {
  return MEMORY_KINDS.map((kind) => ({ value: kind, label: translate(locale, MEMORY_KIND_KEY[kind]) }))
}

/** 作用域下拉的选项（全部 / 全局记忆 / Agent 记忆） */
export function memoryScopeOptions(locale: Locale): { value: MemoryScope; label: string }[] {
  return MEMORY_SCOPES.map((scope) => ({ value: scope, label: translate(locale, MEMORY_SCOPE_KEY[scope]) }))
}

/** 类型 → AntD `Tag` 色（**不是文案，与语言无关**，故仍是常量） */
const KIND_COLOR: Record<MemoryKind, string> = {
  PROFILE: 'blue',
  PREFERENCE: 'purple',
  HABIT: 'cyan',
  HIGHLIGHT: 'geekblue',
  OTHER: 'default',
}

export function memoryKindLabel(kind: MemoryKind, locale: Locale): string {
  return translate(locale, MEMORY_KIND_KEY[kind])
}

export function memoryKindColor(kind: MemoryKind): string {
  return KIND_COLOR[kind]
}

export function memoryScopeLabel(scope: MemoryScope, locale: Locale): string {
  return translate(locale, MEMORY_SCOPE_KEY[scope])
}

/**
 * 来源文案（HCI §5.5：原会话被删 ⇒ 显示"原会话已删除"，不带跳转）。
 * `sourceConversationId` 为 `null` = 用户手动添加。
 *
 * ⚠️ 返回的**会话标题**（`sourceTopic`）是运行时数据，**原样返回**（不翻译）——
 * 只有"手动添加 / 原会话已删除 / 未命名会话"三种边角读数走字典。
 */
export function memorySourceText(
  input: {
    sourceConversationId: string | null
    sourceAvailable: boolean
    sourceTopic: string | null
  },
  locale: Locale,
): string {
  if (input.sourceConversationId === null) return translate(locale, 'memory.sourceManual')
  if (!input.sourceAvailable) return translate(locale, 'memory.sourceDeleted')
  return input.sourceTopic ?? translate(locale, 'memory.sourceUnnamed')
}