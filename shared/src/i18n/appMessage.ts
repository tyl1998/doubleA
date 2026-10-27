/**
 * `AppError` 细节消息的"结构化 key"收口（P1-23 收尾 ⑤）
 *
 * 依据：`docs/子方案/界面语言切换.md` §3.5c / §六 第 3 条、`docs/02-后端设计.md` §四 规则 1。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 要解决的问题
 * ─────────────────────────────────────────────────────────────────────
 * 后端 ~400 处 `AppError` 的细节消息是**中文正文**（"智能体不存在" / "只有该 Provider 的
 * 所属人或管理员可以修改它"…）。它们在两个出口被展示：
 *   ① HTTP 信封 `msg` → 前端 `ApiError.message` → `feedback.fail` 的通知；
 *   ② SSE `error` 帧的 `message` → 对话页的错误卡。
 * 英文界面下这两条只能退化成 `error.<CODE>`（"资源不存在"），信息量掉一大截。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 做法：**双写**，而不是把 message 换成 key
 * ─────────────────────────────────────────────────────────────────────
 * `AppError.message` **保持中文原样**（它是日志、`documents.error_msg`、以及 zh 界面的
 * 既有真相 —— 换成 `@app.m000` 等于把运维可见的报错变成一串编号，那是净损失）。
 * 额外挂 {@link AppErrorMessage}：`{ key, params }`，随信封与 SSE 一起下发；
 * 前端在**边界**处（`api/client.ts` / `roundReducer`）优先用它取译文，没有就退回 `message`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"包裹调用点"而不是"按中文反查翻译"
 * ─────────────────────────────────────────────────────────────────────
 * 后者（拿已经插值完的中文去正则匹配模板）是**猜**：参数里可能正好含有模板的定界符，
 * 匹配错了不会报错、只会显示一句张冠李戴的英文。所以 key 由**调用点显式给出**
 * （`appMsg('app.m000')`），参数也显式给出（`appMsg('app.m116', { p0: id })`）——
 * 结构上不可能猜错。400 处由 codemod 一次性改写，`verify-i18n` 的 K 组守"没有漏网的裸中文"。
 */

import { translate, type MessageKey, type Locale } from './index.js'

/** 可插值的参数（与 `translate` 同型） */
export type AppMessageParams = Readonly<Record<string, string | number>>

/**
 * 登记表的一项：中文模板 → 字典 key + 位置参数名。
 *
 * `names` 与模板里的 `{0}` / `{1}` 一一对应，codemod 据此把调用点的实参绑回名字。
 */
export interface AppMessageEntry {
  key: MessageKey
  names: readonly string[]
}

/**
 * 一条"已结构化"的 `AppError` 消息。
 *
 * 这是个**带品牌的对象**（不是字符串）：`AppError` 构造器据此识别"这条消息有 key"，
 * 从而把中文正文与 key 分开存。用对象而不是"魔法字符串前缀"的理由：
 * 魔法前缀会被 `JSON.stringify`、日志格式化、以及 `message.startsWith('@')` 之外的
 * 任何地方当成正文，而对象不可能被误认。
 */
export interface AppMessage {
  readonly __appMessage: true
  readonly key: MessageKey
  readonly params: AppMessageParams | undefined
  /** 中文正文（构造时就渲染好，供日志 / `documents.error_msg` / zh 界面用） */
  readonly text: string
}

/**
 * 造一条结构化消息（后端调用点用这个，而不是直接写中文字符串）。
 *
 * ```ts
 * throw AppError.notFound(appMsg('app.m000'))                 // 智能体不存在
 * throw AppError.notFound(appMsg('app.m116', { p0: id }))     // 模型不存在：{p0}
 * ```
 *
 * ⚠️ `text` 在**构造时**按 zh 渲染：`AppError.message` 因此与改写前逐字一致
 * （日志、`documents.error_msg`、既有断言都不受影响）。
 */
export function appMsg(key: MessageKey, params?: AppMessageParams): AppMessage {
  return {
    __appMessage: true,
    key,
    // ⚠️ 模板里的占位符是**位置式**（`{0}` / `{1}`），而调用点给的是 `p0` / `p1`。
    // 这里把 `p0 → "0"` 转成 `translate` 认识的键：`translate` 的正则是 `\{(\w+)\}`
    // ⇒ 它找的是 `params['0']`，所以键名必须是 `'0'` 而不是 `'p0'`。
    params: params === undefined ? undefined : positionParams(params),
    text: translate('zh', key, params === undefined ? undefined : positionParams(params)),
  }
}

/**
 * `{ p0, p1 }` → `{ '0': …, '1': … }`。
 *
 * 为什么要这一步：登记表里的参数名（`names`）是给人读的（`p0`），而字典模板里的
 * 占位符是机器生成的（`{0}`）—— `translate` 按占位符里的**文本**查 `params`，
 * 所以两者必须在这里对齐一次。放在 `appMsg` 而不是 `translate` 里，
 * 是因为 zod 校验那套（`validation.*`）用的是**具名**占位符，不能一刀切。
 */
function positionParams(params: AppMessageParams): AppMessageParams {
  const out: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(params)) {
    out[name.startsWith('p') && /^p\d+$/.test(name) ? name.slice(1) : name] = value
  }
  return out
}

/** 类型守卫 */
export function isAppMessage(value: unknown): value is AppMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __appMessage?: unknown }).__appMessage === true &&
    typeof (value as { key?: unknown }).key === 'string'
  )
}

/**
 * 把一条 `AppError` 消息**按当前语言**渲染。
 *
 * 前端边界用：有结构化 key 就取译文，没有（老消息 / 非 `appMsg` 构造）就原样返回 `raw`。
 */
export function appMessageText(locale: Locale, raw: string, structured: AppMessagePayload | null | undefined): string {
  if (structured === null || structured === undefined) return raw
  return translate(locale, structured.key as MessageKey, structured.params)
}

/**
 * 随信封 / SSE 下发的形态（**只带 key + 参数**，不带中文正文 —— 正文由前端按语言渲染）。
 *
 * 与 {@link AppMessage} 的区别：后者是后端内部的"包裹对象"（含已渲染的 `text`），
 * 前者是**线格式**（`data` / SSE payload 里就是它，所以必须可 JSON 序列化且尽量小）。
 */
export interface AppMessagePayload {
  key: string
  params?: AppMessageParams
}
