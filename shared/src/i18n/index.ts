/**
 * 界面语言（i18n）运行时（P1-23）
 *
 * 依据：`docs/01-整体需求与实施步骤.md` 决策 **38**、`docs/03-前端设计.md` §九、
 * `docs/子方案/界面语言切换.md`。
 *
 * ## 三条硬约束（本文件的形状全由它们决定）
 *
 * 1. **typed**：`MessageKey` 从 `messages.zh.ts` 推出，`messages.en.ts` 以
 *    `Record<MessageKey, string>` 约束 ⇒ **漏译 = 编译期报错**（不靠运行时 warning）。
 * 2. **纯函数**：{@link translate} 不读 `window`、不读 localStorage、不 import 任何前端模块
 *    ⇒ 后端与"零依赖验收档"（`frontend/scripts/verify-i18n.mjs`）都能直接跑。
 * 3. **零依赖**：不引 i18next / react-intl（口径同自写的 `shared/src/cron.ts`）。
 *
 * ## 边界
 *
 * - locale 是**纯客户端偏好**（存哪、怎么写，是前端 `stores/locale.ts` 的事）——
 *   本模块只提供"语言集合 + 字典 + 查表"。
 * - 只有 `zh` / `en` 两种；新增语言要动 `LOCALES` 与两份字典（`en` 那份是"非默认语言"的样板）。
 */

import { zh } from './messages.zh.js'
import { en } from './messages.en.js'

/**
 * 两份消息目录**原样导出**。
 *
 * 为什么导出而不只是内部用：它们是**可机检的数据**（不是纯实现细节）——
 * 零依赖验收档（`frontend/scripts/verify-i18n.mjs`）要逐 key 比对两份目录
 * （漏译 / 多译 / 空串 / 占位符不齐 / en 里残留中文），工具与脚本都得能拿到原始字面量。
 * 组件**不要**直接用它们取文案（那样绕过了 locale 判定）；组件走 `useT()`。
 */
export { zh, en }
export type { ZhMessages } from './messages.zh.js'

/** 支持的界面语言（顺序 = 切换器里的展示顺序；`zh` 恒为默认） */
export const LOCALES = ['zh', 'en'] as const

export type Locale = (typeof LOCALES)[number]

/** 默认语言（缺省 / 非法值一律回落它） */
export const DEFAULT_LOCALE: Locale = 'zh'

/** 文案 key 全集（从 zh 推出 —— zh 是真相来源，见 `messages.zh.ts` 文件头） */
export type MessageKey = keyof typeof zh

/** key → 该语言的模板串 */
const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { zh, en }

/** 字符串是不是受支持的 locale（前端读 localStorage 后用它做合法性判定） */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** 任意值 → 合法 locale（不认识就回落默认值；**不抛错** —— 界面语言不该让页面挂掉） */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE
}

/**
 * 取一条文案。
 *
 * - **未知 key**：回退到默认语言（zh）的同 key；两份都没有时**原样返回 key**
 *   （看得见"这里少了一条"，比返回空串更容易被发现）。
 * - **插值**：`{name}` 形式；`params` 里缺的键**原样保留占位符**（不抛错、不静默吞 ——
 *   缺参数是调用方的错，但要让它显形）。
 * - 不做复数 / 性别等复杂规则（平台只有 zh/en，用不上库里那套）。
 */
export function translate(locale: Locale, key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const template = DICTIONARIES[locale][key] ?? zh[key]
  if (template === undefined) return key
  if (params === undefined) return template
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}