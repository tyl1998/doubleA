/**
 * zod 校验消息的"key + 参数"收口（P1-23 末批）
 *
 * 依据：`docs/子方案/界面语言切换.md` §3.5 / §3.5a（zod 消息改口径）、`docs/02-后端设计.md` §四 规则 3。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要发明一个"带参数字符串"，而不是直接写 key
 * ─────────────────────────────────────────────────────────────────────
 * zod 的 `message` **只能是字符串**（`.min(1, { message })` 的入参类型是
 * `string | { message?: string }`，塞不进 `params`），而 `data.fields[{path,message}]`
 * 是既有的前后端契约（`02` §四 规则 3）—— 改它的形状要同时动后端 `RequestValidationError`
 * 与前端 `ApiError`，收益不抵风险。
 *
 * 所以采用**最小侵入**的编码：消息串以 `@` 开头（一眼看出"这不是正文"），后面是
 * `MessageKey`，需要参数时再接 `|{JSON}`：
 *
 * ```
 * @validation.usernameRequired
 * @validation.usernameTooLong|{"max":64}
 * ```
 *
 * 三个性质（缺一不可）：
 *   1. **老消息零影响**：不以 `@` 开头的消息一律原样返回（现存 ~320 处中文 zod 消息
 *      在 zh 下照旧显示，本批不碰 —— 见台账）；
 *   2. **后端零改动**：后端只是把 `issue.message` 透传进 `data.fields`（它不解析内容），
 *      所以没必要让后端认识这套 key；
 *   3. **可增量**：一个 schema 一个 schema 地改，改过的走字典、没改的仍是中文 ——
 *      不会出现"改一半就全体变 key"的中间态。
 *
 * ⚠️ 解析失败（坏 JSON / 不认识的 key）⇒ **原样返回**，绝不抛错：校验文案的解析失败
 * 不该让表单提交路径挂掉。
 */

import { translate, type Locale, type MessageKey } from './index.js'

/** 可插值的参数（与 `translate` 的占位符取值同型：只允许字符串/数字） */
export type ValidationParams = Readonly<Record<string, string | number>>

/**
 * 消息串的"这是 key 不是正文"标记。
 *
 * 选 `@` 的理由：中文正文不会以它开头，且它不干扰任何既有正则/断言。
 */
export const VALIDATION_KEY_PREFIX = '@'

/**
 * 造一条 zod 消息：`key`（+ 可选参数）。
 *
 * 用法（见 `shared/src/auth.ts` 的样本）：
 * ```ts
 * z.string({ required_error: validationMessage('validation.usernameRequired') })
 *   .max(64, validationMessage('validation.usernameTooLong', { max: 64 }))
 * ```
 */
export function validationMessage(key: MessageKey, params?: ValidationParams): string {
  const base = `${VALIDATION_KEY_PREFIX}${key}`
  if (params === undefined) return base
  return `${base}|${JSON.stringify(params)}`
}

interface ParsedValidationMessage {
  key: string
  params: ValidationParams | undefined
}

/** 拆一条 `@key|{…}` 串；不是这个形状（或 JSON 坏了）⇒ `null` */
export function parseValidationMessage(raw: string): ParsedValidationMessage | null {
  if (!raw.startsWith(VALIDATION_KEY_PREFIX)) return null
  const body = raw.slice(VALIDATION_KEY_PREFIX.length)
  const bar = body.indexOf('|')
  if (bar < 0) return { key: body, params: undefined }
  try {
    const parsed: unknown = JSON.parse(body.slice(bar + 1))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const params: Record<string, string | number> = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') params[name] = value
    }
    return { key: body.slice(0, bar), params }
  } catch {
    return null
  }
}

/**
 * 把一条字段级消息**渲染成当前语言的正文**。
 *
 * - 不是 `@…` 形状 ⇒ **原样返回**（未迁的 zod 消息与后端自造的中文细节仍照旧显示）；
 * - 是 `@…` 但字典里没有这个 key ⇒ 原样返回（`translate` 对未知 key 就是返回 key 本身，
 *   这里补回 `@` 前缀只是为了让"这是没译到的 key"在界面上还认得出来）。
 *
 * 组件不要直接调它 —— 前端在 `api/client.ts#readFieldIssues` **一处**统一渲染
 * （字段级消息的出口只有一个，散在页面里必然漏）。
 */
export function validationText(locale: Locale, raw: string): string {
  const parsed = parseValidationMessage(raw)
  if (parsed === null) return raw
  const rendered = translate(locale, parsed.key as MessageKey, parsed.params)
  return rendered === parsed.key ? raw : rendered
}
