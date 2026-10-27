/**
 * i18n 的 React 接入（P1-23）
 *
 * 依据：`docs/03-前端设计.md` §九、`docs/子方案/界面语言切换.md` §3.3。
 *
 * ## 本文件是"取文案的唯一入口"
 *
 * 组件里**不要**直接 `import { translate } from '@doubulea/shared'` 再自己读 store ——
 * 那样每个组件都要记得订阅 locale（忘了订阅的症状是"切了语言这一块不跟着变"，
 * 且不报任何错）。一律走 {@link useT}：它订阅 store，语言一变整棵用到它的树都重渲染。
 *
 * ## 为什么是 hook + `t` 函数，而不是 `<T k="nav.agents" />` 组件
 *
 * 本仓文案大量出现在**属性位置**（`title` / `aria-label` / `placeholder` / `message` 参数），
 * 组件形态在这些位置很难用；而且很多文案要**插值**（`rail.renameAria` 带会话名）。
 * `t(key, params)` 一处在手，两种用法都覆盖。
 *
 * ## `t` 的引用稳定性
 *
 * `useT` 返回的对象按 `locale` `useMemo` —— 同一语言下引用不变，
 * 于是 `memo` 的组件（如 `ConvRail` 的行）不会因为"父组件重渲染但语言没变"而被击穿。
 * ⚠️ 但**别把 `t` 塞进 `memo` 组件的 props**：语言一变引用就变，那是**期望行为**
 * （那正是它要重渲染的原因）。
 */

import { translate, type Locale, type MessageKey } from '@doubulea/shared'
import { useMemo } from 'react'

import { useLocaleStore } from '../stores/locale.js'

/** 文案函数：key + 可选插值参数 → 当前语言下的字符串 */
export type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

export interface I18n {
  /** 当前界面语言（需要按语言分支时用，如"中文时显示 EN"这类切换器文案） */
  locale: Locale
  /** 取文案（唯一入口） */
  t: Translate
}

export function useT(): I18n {
  const locale = useLocaleStore((state) => state.locale)

  return useMemo<I18n>(
    () => ({
      locale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale],
  )
}