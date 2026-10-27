/**
 * 失败通知的**文案判定**（纯函数，零依赖）
 *
 * 从 `app/feedback.ts` 抽出来的唯一理由：那个文件 `import { App } from 'antd'`，
 * 于是"英文界面下该显示哪句话"这条判据**没法在零依赖验收档里断言**——
 * 而它恰好是一个**曾经写错过**的判据（见下），必须能被测到。
 *
 * 依据：`docs/03-前端设计.md` §七（反馈通道）、`docs/子方案/界面语言切换.md` §3.5 / §六 第 3 条。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 判据是「这条消息里有没有汉字」，不是「它的错误码认不认识」
 * ─────────────────────────────────────────────────────────────────────
 * 后端还有 ~320 条 `AppError` 细节消息是**中文**（`子方案` §六 第 3 条，刻意没改）⇒
 * 英文界面下不能原样回显，要换成 `error.<CODE>` 这类"这一类错误说什么"的译文。
 *
 * 但**前端自己造**的文案（`api/client.ts` 的网络层自造句、`useChatStream.ts` 的本地失败）
 * 从 2026-10-27 收尾 ④ 起已经在**构造期**按当前语言落好了。若仍按"非 zh ⇒ 一律换成
 * `error.<CODE>`"处理，那些翻好的英文会被丢掉：
 *   · `NETWORK` **不在** `ERROR_CODES` 里 ⇒ 必然退化成 `common.operationFailed`
 *     （症状：英文界面下网络断了只显示一句 "Operation failed"，且没有任何报错）；
 *   · `INTERNAL` 之类会退化成 `error.INTERNAL`，把"响应不是合法的 JSON"这类可排查的信息抹平。
 *
 * 所以判据改成「**含汉字才替换**」。语义上也更准 —— 这段兜底存在的唯一理由就是
 * "服务端那句是中文"，没有汉字就没什么要兜的。
 */

import {
  appMessageText,
  ERROR_CODES,
  translate,
  type AppMessagePayload,
  type ErrorCode,
  type Locale,
} from '@doubulea/shared'

/** 契约错误码集合（`ClientErrorCode` 里的 `UNKNOWN` / `NETWORK` 不在其中） */
const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES)

/** 有没有汉字（与 `verify-i18n.mjs` 的 `CJK` 同一条正则） */
const CJK = /[\u4e00-\u9fff]/

/**
 * 失败通知里那句**主文案**。
 *
 * @param locale   当前界面语言
 * @param code     错误码（`describeError` 的产物；可能是前端伪码 `NETWORK` / `UNKNOWN`）
 * @param fallback `ApiError.message`（**可能已经是当前语言**，见文件头）
 *
 * 三条分支：
 * 1. **zh** ⇒ 原样用 `fallback`（服务端那句是中文母语写的，信息量比 `error.<CODE>` 大）；
 * 2. **非 zh 且 `fallback` 里没有汉字** ⇒ 原样用（它已经是当前语言了，别再降级）；
 * 3. **非 zh 且含汉字** ⇒ 换成 `error.<CODE>`；码不认识时退到 `common.operationFailed`。
 */
export function failureMessage(
  locale: Locale,
  code: string,
  fallback: string,
  msgKey?: AppMessagePayload | null,
): string {
  // ① 服务端给了结构化 key ⇒ 按当前语言渲染（P1-23 收尾 ⑤）。
  //    这条**优先于**下面所有分支：它既不是"已翻好的英文"也不是"要兜底的中文"，
  //    而是"同一个意思的另一种语言的写法"—— zh 下与 `fallback` 逐字相同，en 下是真译文。
  if (msgKey !== null && msgKey !== undefined) return appMessageText(locale, fallback, msgKey)
  if (locale === 'zh') return fallback
  if (!CJK.test(fallback)) return fallback
  if (!ERROR_CODE_SET.has(code)) return translate(locale, 'common.operationFailed')
  return translate(locale, `error.${code as ErrorCode}`)
}
