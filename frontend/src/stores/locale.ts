/**
 * 界面语言状态（zustand，P1-23）
 *
 * 依据：`docs/03-前端设计.md` §九、`docs/子方案/界面语言切换.md` §3.2。
 *
 * ## 为什么和"主题"长一个样
 *
 * locale 与 `stores/ui.ts#themeMode` 是**同一类东西**：纯客户端偏好、刷新要记住、
 * 归属 `<html>` 上的一个属性。所以这里刻意逐条对齐那个文件的做法（初始化时机、
 * 存储异常吞掉、首帧前写属性），只在属性名上分开（theme → `data-theme`，locale → `lang`）。
 *
 * ## 为什么单独一个 store 而不是塞进 `ui.ts`
 *
 * `ui.ts` 的文件头写得很清楚：它的定位是"与业务无关的界面开关"，**不要往那里堆** ——
 * 加进去会让那个文件同时承担两套判据。而 locale 有一个 `ui.ts` 没有的性质：
 * **它是被 `shared` 的纯函数消费的**（`translate(locale, ...)`），所以它多一个"必须能从
 * 非组件上下文读到当前值"的需求（`getState()` 在 `feedback.ts` 这类非 hook 处用）。
 *
 * ## 服务端数据一律不进 zustand —— locale 不是服务端数据（它不进任何接口）
 */

import { create } from 'zustand'
import { DEFAULT_LOCALE, type Locale } from '@doubulea/shared'

import { applyHtmlLang, readStoredLocale, writeStoredLocale } from '../app/locale.js'

/** 初始语言：有存储以存储为准（用户显式点过），否则默认中文（**刻意不跟随 `navigator.language`**） */
const INITIAL_LOCALE: Locale = readStoredLocale() ?? DEFAULT_LOCALE

interface LocaleState {
  locale: Locale
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: INITIAL_LOCALE,
  setLocale: (locale) => {
    writeStoredLocale(locale)
    applyHtmlLang(locale)
    set({ locale })
  },
  /**
   * 两种语言之间切换（切换器按钮只调它）。
   *
   * ⚠️ 与 `ui.ts#toggleThemeMode` 一样**只支持两种**：加第三种语言时这里必须跟着改成
   * "按 `LOCALES` 顺序轮转"，否则第三个语言永远轮不到（且不会有任何报错 —— 静默失效）。
   */
  toggleLocale: () => {
    get().setLocale(get().locale === 'zh' ? 'en' : 'zh')
  },
}))

/** 首帧之前就把 `<html lang>` 写好，避免"中文渲染一瞬再变英文"（`main.tsx` 在 render 前调用） */
export function initLocale(): void {
  applyHtmlLang(INITIAL_LOCALE)
}

/**
 * 非组件上下文取当前语言（`feedback.ts` 这类不在 React 里的地方用）。
 * 组件里请用 `app/i18n.tsx#useT()` —— 它订阅变化、会重渲染；`getState()` 不会。
 */
export function currentLocale(): Locale {
  return useLocaleStore.getState().locale
}