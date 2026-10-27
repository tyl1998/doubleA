/**
 * 界面语言的**前端接线**（P1-23）
 *
 * 依据：`docs/03-前端设计.md` §九、`docs/子方案/界面语言切换.md` §3.3/§3.4。
 *
 * ## 本文件是"三张一处来源"里的第二张
 *
 * 1. `shared/src/i18n` —— key 与译文的唯一来源；
 * 2. **本文件** —— locale 常量 / localStorage 键 / **AntD locale 映射** / `<html lang>`；
 * 3. `app/i18n.tsx#useT()` —— 组件取文案的唯一入口。
 *
 * **AntD 的 locale 映射只写在这里**：别处（页面、组件、`AppProviders` 内联）不要再写一遍
 * `locale === 'zh' ? zhCN : enUS` —— 那是"同一判断第二份实现"的经典形态，改一处漏一处。
 *
 * ## 与 `stores/ui.ts`（主题）的同款口径
 *
 * locale 与 themeMode 一样是**纯客户端偏好**：存 localStorage、写 `<html>` 属性、
 * 存储异常时"只在本次会话生效、不打扰用户"、首帧之前先把属性写好（避免闪烁）。
 * 区别只有一处：theme 写 `data-theme`，locale 写 `lang`（后者是浏览器与无障碍的真实语义）。
 */

import type { Locale } from '@doubulea/shared'

/** 目标语言（与 `shared` 的 `LOCALES` 同集合；这里是**前端默认值**，缺省/非法都落它） */
export const DEFAULT_FRONTEND_LOCALE: Locale = 'zh'

/** localStorage 键名（前缀同 `doubulea.theme`，一眼看出是本应用的键） */
export const LOCALE_STORAGE_KEY = 'doubulea.locale'

/**
 * locale → AntD 内置包。
 *
 * ⚠️ **静态 import**（不是动态 `import()`）：AntD 的 locale 包很小（就是几十条组件文案），
 * 动态加载会让"切语言"多一次异步 + 一次可能的闪烁，收益不值。两个都进 bundle。
 */
export const ANTD_LOCALE_PACKAGE = {
  zh: 'zh_CN',
  en: 'en_US',
} as const satisfies Record<Locale, string>

/** locale → dayjs 的 locale 名（`dayjs.locale()` 的入参；`zh-cn` 是 dayjs 对中文的命名） */
export const DAYJS_LOCALE_NAME = {
  zh: 'zh-cn',
  en: 'en',
} as const satisfies Record<Locale, string>

/** locale → `<html lang>` 的值（`zh-CN` 带地区，`en` 不带；都符合 BCP 47） */
export const HTML_LANG = {
  zh: 'zh-CN',
  en: 'en',
} as const satisfies Record<Locale, string>

/**
 * locale → `Date.prototype.toLocaleString()` 的入参 tag。
 *
 * 为什么要单独一处：日期格式化**不能**用 `locale` 本身（`'en'` 与 `'zh'` 都不是合法的完整 tag，
 * `toLocaleString('zh')` 会静默回落宿主语言 ⇒ 英文界面下日期仍是中文格式）。这里给的是
 * 带地区的完整 tag（`zh-CN` / `en-US`），与 `HTML_LANG` 同族 —— **判据仍然只有一处**。
 */
export const INTL_LOCALE_TAG = {
  zh: 'zh-CN',
  en: 'en-US',
} as const satisfies Record<Locale, string>

/**
 * 取当前 locale 对应的日期 tag（`toLocaleString` / `toLocaleDateString` 用）。
 * 值就是 {@link INTL_LOCALE_TAG}，**别在页面里手写 `'zh-CN'`**（那样英文界面下日期不会跟着变）。
 */
export function localeTag(locale: Locale): string {
  return INTL_LOCALE_TAG[locale]
}

/**
 * 把 locale 写到 `<html lang>`。
 *
 * 为什么是 `lang` 属性而不是自造 `data-locale`：`lang` 是浏览器/读屏/换行规则
 * （CSS `:lang()`、`hyphens`）真正会读的标准属性，能顺带把"中文不自动断词"这类
 * 浏览器行为也带正确。**同 theme 的 `data-theme` 一样，只在这一处写。**
 */
export function applyHtmlLang(locale: Locale): void {
  document.documentElement.lang = HTML_LANG[locale]
}

/** localStorage 在隐私模式 / 存储被禁用时会抛异常 —— 语言偏好丢失不值得让页面挂掉 */
export function readStoredLocale(): Locale | undefined {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return raw === 'zh' || raw === 'en' ? raw : undefined
  } catch {
    return undefined
  }
}

export function writeStoredLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 存不下就只在本次会话生效，不打扰用户
  }
}

/** 另一种语言（切换器用；目前只有两种，`zh ⇄ en`） */
export function otherLocale(locale: Locale): Locale {
  return locale === 'zh' ? 'en' : 'zh'
}

/**
 * 切换器按钮上显示的字 —— **用另一种语言写**（当前中文时显示 `EN`、英文时显示 `中`）。
 *
 * ⚠️ 这两个字**刻意不进字典**（`verify:i18n` F 组对本文件有一条白名单）：
 * 它的语义就是"写成**目标**语言的自称" —— 如果按当前语言取译文，中文界面会显示「中文」、
 * 英文界面会显示「English」，那正是这个按钮**不该**说的话（用户看不出点了会变成什么）。
 * 判据是"目标语言自称"，与 locale 无关 ⇒ 它是**数据**而不是文案。
 */
export function localeToggleLabel(locale: Locale): string {
  return locale === 'zh' ? 'EN' : '中'
}