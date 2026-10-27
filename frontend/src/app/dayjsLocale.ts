/**
 * dayjs 语言同步（P1-23）
 *
 * ## 为什么需要一个单独的文件
 *
 * dayjs 的 locale 是**进程级全局**（`dayjs.locale(name)` 改的是单例）—— 它不像 AntD 的
 * locale 那样能通过 props 传。而用到 dayjs 的地方（如日期选择器 `OpenApiKeysSection`）
 * 各自 import 各自的 dayjs 实例，**不会**自动跟着界面语言走 ⇒ 必须有人在一处统一设。
 *
 * 判据仍是"一处来源"：语言名映射在 `app/locale.ts#DAYJS_LOCALE_NAME`，本文件只负责
 * "按它去设"，`AppProviders` 在语言变化时调 {@link applyDayjsLocale}。
 *
 * ## `zh-cn` 要显式 import
 *
 * dayjs 的内置语言默认只有 `en`；`zh-cn` 必须 `import 'dayjs/locale/zh-cn'` 才注册得上，
 * 否则 `dayjs.locale('zh-cn')` 会**静默失败**（保持 en，不报错）—— 这正是要在一处写死的原因。
 */

import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import type { Locale } from '@doubulea/shared'

import { DAYJS_LOCALE_NAME } from './locale.js'

/** 把 dayjs 的全局语言设成当前界面语言（在 `AppProviders` 的 effect 里按 locale 调） */
export function applyDayjsLocale(locale: Locale): void {
  dayjs.locale(DAYJS_LOCALE_NAME[locale])
}