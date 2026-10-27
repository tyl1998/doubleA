/**
 * 对话页的错误 / 断线文案（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §五（`error` 行："错误 toast + **消息流内错误卡**；释放输入区；
 *      **CONFLICT 专用文案「该会话正在生成中」**"）、§4.1（"`CONFLICT`（同会话并发发送）→
 *      toast「该会话正在生成中」"、"断线 → 顶部黄条提示，点击黄条 = 立即拉取历史对齐"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个文件存在的唯一理由：**同一句话只许有一处写法**（`06` §六 第 ⑰ 条）
 * ─────────────────────────────────────────────────────────────────────
 * `ErrorCard.tsx` 早在 P0-1-32 就把「该会话正在生成中」写成了一条私有常量
 * （当时只有一个消费方，那样写是对的）。P0-1-33 要让 **toast** 也说同一句话 ⇒ 从这一刻起
 * 它有两个消费方；若各写一份，改文案时必有一条先腐烂 —— 本仓在 P0-1-29 就吃过这个亏
 * （`PASSWORD_ALPHABET` 的注释与常量差一个字母，而"照注释写"的正则被复制到了两处，
 * 症状是"约 1/4 概率随机红"）。故一律搬到这里，两个消费方都从本文件取。
 *
 * ⚠️ 服务端**也**有一句更长的原文（`orchestrator/sse.ts` 的
 * `'该会话正在生成中，请等当前回答结束或先停止它'`）。两者不是重复：
 *   · 短句是**标题**（`03` §4.1 点名的那句，用于 toast 标题与错误卡标题）；
 *   · 服务端原文是**说明**（错误卡的 description / toast 的描述行），它带"该怎么办"。
 * 断言方式见 `verify-chat-sse` 的 J 组：短句必须是服务端原文的**前缀**
 * （这样"将来服务端改了口径"与"前端自己编了一句"能被区分开）。
 */

import { translate, type Locale, type MessageKey } from '@doubulea/shared'

/**
 * 流内错误码 → **面向用户的短标题**的 key（没有列出的错误码走通用标题）。
 *
 * 目前只有一条：`CONFLICT`。为什么不把 `BUSY` / `NEED_CREDENTIAL` 也列上：
 *   · `BUSY`（沙箱并发闸满）在 P0 阶段**没有产生路径**，且它的文案与"排队位次"绑定（P0-3）；
 *   · `NEED_CREDENTIAL` 的处理是"给一个跳转按钮"（`03` §4.1 的工具卡那一行），属 P0-2。
 * 提前写只会是猜的文案 —— 契约没写的，不发明（`06` §六 第 ③ 条）。
 *
 * ⚠️ P1-23：存 **key 不存文案**（`translate(locale, ...)` 落译文）—— 原来的一份中文常量
 * 是"第二真相"，改了字典漏了这里就会出现"字典英文、这一格中文"。
 */
export const CHAT_ERROR_TITLE_KEY_BY_CODE: Readonly<Record<string, MessageKey>> = Object.freeze({
  CONFLICT: 'chat.errorConflictTitle',
})

/** 兜底标题的 key（错误码未收录时的通用说法 —— 与 `ErrorCard` P0-1-32 的原文一致） */
export const CHAT_ERROR_TITLE_FALLBACK_KEY: MessageKey = 'chat.errorFallbackTitle'

/** 流内错误 → 标题（`CONFLICT` 走专用文案，见文件头） */
export function chatErrorTitle(code: string, locale: Locale): string {
  return translate(locale, CHAT_ERROR_TITLE_KEY_BY_CODE[code] ?? CHAT_ERROR_TITLE_FALLBACK_KEY)
}

/**
 * 流内错误 → 说明行。
 *
 * 专用文案那条**只显示服务端原文**（它已经包含 "请等当前回答结束或先停止它"，把错误码再拼上去
 * 只会让用户读一串英文）；其余错误码带上错误码 —— 那是用户唯一能报给管理员的东西。
 */
export function chatErrorDescription(code: string, message: string): string {
  return code === 'CONFLICT' ? message : `${code} · ${message}`
}

/**
 * 这一轮失败时要不要弹 toast（`03` §五 的 `error` 行："错误 toast + 消息流内错误卡"）。
 *
 * ⚠️ **只对"服务端说的故障"弹**（`errorSource === 'server'`），客户端侧的中断不弹：
 *   · 服务端故障（含 `CONFLICT`）—— 用户没做错什么，但**界面必须主动说话**（toast + 错误卡 + 释放输入区）；
 *   · 客户端中断（连接断了 / 读流抛错）—— 它的提示通道是**顶部黄条**（§4.1）+ 错误卡，
 *     再加一个 toast 就成了"同一件事说三遍"，反而把黄条那句"点此对齐历史"淹掉。
 * 这条分界与后端"两类失败、两个出口"（`shared/src/sse.ts` 文件头 ③）是同一思路的不同层次：
 * **谁发现的、对谁有意义，决定用哪个通道**。
 */
export function shouldToastChatError(round: {
  status: string
  errorSource: 'server' | 'client' | null
}): boolean {
  return round.status === 'error' && round.errorSource === 'server'
}

/**
 * 顶部黄条（`03` §4.1："断线 → 顶部黄条提示，**点击黄条 = 立即拉取历史对齐**"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一句话覆盖三种触发（它们对用户来说是同一件事）
 * ─────────────────────────────────────────────────────────────────────
 * 会亮黄条的三条路径（都在 `useChatStream.ts` 里，且都是"客户端侧中断"）：
 *   ① **连接中断** —— 读流时连接断了 / 服务端被 kill（没有终帧就结束了）；
 *   ② **停止超时** —— 点了停止、`POST /stop` 也成功了，但 5s 内没等到 `done{STOPPED}`；
 *   ③ **停止信号没发出去** —— `POST /stop` 自己失败（网络/401/404），于是直接 abort 兜底。
 * 三者的共同点是**同一句话**："本地这一轮被中断了，但**没有服务端的收口确认**" ⇒
 * 本地看到的内容与库里可能不一致。故文案只有一份，具体线索放 `extra` 一行
 * （错误码 / 服务端答复），而不是给三种情况各编一套说辞 ——
 * 用户要做的事（点黄条对齐）与它的结果（以服务端为准）本来就一样。
 */
export const DISCONNECT_BANNER_TITLE_KEY: MessageKey = 'chat.disconnectTitle'
export const DISCONNECT_BANNER_ACTION_KEY: MessageKey = 'chat.disconnectAction'
export const DISCONNECT_BANNER_DETAIL_KEY: MessageKey = 'chat.disconnectDetail'
