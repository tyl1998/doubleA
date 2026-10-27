/**
 * AntD 内置语言包的选择（P1-23）
 *
 * ## 为什么单独一个文件（而不是塞进 `app/locale.ts`）
 *
 * `app/locale.ts` 刻意**不 import 任何组件库**：它是纯常量 + localStorage 小工具，
 * 于是"零依赖验收档"（`frontend/scripts/verify-i18n.mjs`）能在 Node 里直接跑它
 * （不拖进 AntD / React）。AntD 的 locale 是**组件对象**，必须 import 组件库 ⇒ 放这里。
 *
 * ## 一张表，两个使用者（不许在别处再写一遍）
 *
 * `AppProviders` 取它给 `ConfigProvider`。**判据只有这一处**：
 * 别处若要按语言分支 AntD 行为，也用这张表，不要自己写 `locale === 'zh' ? ...`。
 */

import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type { Locale } from '@doubulea/shared'

/** locale → AntD locale 组件（`satisfies` 保证两种语言一个不漏） */
export const ANTD_LOCALE = { zh: zhCN, en: enUS } as const satisfies Record<Locale, typeof zhCN>