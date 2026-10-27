/**
 * 确认卡的**纯逻辑**（P0-2-11）
 *
 * 依据：`shared/src/sse.ts`（`sseConfirmPayloadSchema` 的 `source` / `expiresAt`、
 *      `confirmConversationResultSchema` 的 `applied`）、`docs/03` §4.1 消息流渲染规则表第 7 行、
 *      `docs/02` §9.10（确认流契约）、`06` P0-2-11 坑预判 3（倒计时**只读服务端给的时刻**）。
 *
 * 为什么单独一个文件、而不是塞进 `mcpModel.ts`：确认卡是**对话域**的组件
 * （它挂在输入区里、由 SSE 的 `confirm` 事件驱动），而 `pages/mcp/mcpModel.ts` 是 **MCP 页面**
 * 的纯逻辑。让 `features/chat/` 反过来 import `pages/` 会是一条方向错误的依赖
 * —— 迟早出现"改一次 MCP 页面、对话页跟着挂"的耦合。
 * ⚠️ 但也**不要**因此把倒计时的判据复制一份到 `mcpModel.ts`：两份判据必然各自演化
 * （`docs/06` §六 第 ⑰ 条）。它在哪，就只有哪一份。
 *
 * 与其它零依赖文件同款：不 import React、不发请求、不 import antd
 * ⇒ `frontend/scripts/verify-mcp-ui.mjs` 能在 node 里直接跑它逐条断言。
 */

import type { ConfirmSource, Locale } from '@doubulea/shared'
import { translate } from '@doubulea/shared'

/**
 * 剩余秒数（**向上取整**，最小 `0`）。
 *
 * ⚠️ 输入是**服务端给的绝对时刻**（`sseConfirmPayload.expiresAt`），
 * 而**不是**前端自己另起的一个 120s（`06` P0-2-11 坑预判 3）：
 * 两边只要有一点点差（网络、时钟、重连）就会变成"界面说还没到、服务端已按取消处理"，
 * 而用户看到的是"我点了确认但什么都没发生"。有了绝对时刻，重连之后也能算对剩余时间。
 *
 * ⚠️ **向上取整**而不是向下：`expiresAt` 还差 0.4s 时显示 `1s`（还有希望），
 * 向下取整会让它在还剩不到 1 秒时就先跳到"已超时" —— 而那时按钮其实还能生效。
 *
 * ⚠️ `nowMs` 是**注入参数**（默认 `Date.now()`）：纯函数才能被无依赖档断言
 * （同一手法见 `conversationList.ts` 的时间读数与 `knowledgeModel` 的轮询判据）。
 * `expiresAt` 解析不出来（坏串）⇒ 返回 `0`，界面显示「已超时」而不是 `NaN`。
 */
export function remainingSeconds(expiresAt: string, nowMs: number = Date.now()): number {
  const deadline = Date.parse(expiresAt)
  if (Number.isNaN(deadline)) return 0
  return Math.max(0, Math.ceil((deadline - nowMs) / 1000))
}

/**
 * 倒计时读数。
 *
 * 到点是「**已超时**」而不是 `0s`：那三个字是此时唯一的实话（服务端很可能已经把这条提问
 * 按取消处理掉了），而 `0s` 只是一个看着还在数的数字。
 */
export function confirmCountdownText(remaining: number, locale: Locale): string {
  return remaining <= 0 ? translate(locale, 'confirm.timeoutText') : `${remaining}s`
}

/**
 * 确认卡的说明文案：**按"谁在问"分支**。
 *
 * `shared#sseConfirmPayloadSchema` 的注释定了这件事：两种来源的 payload 形状、挂起原语、
 * 应答端点**完全一致**（都走 `POST /:id/confirm` 的确认/取消二元语义），
 * 差异只在**前端这句说明**上 —— 所以 `source` 是一个判别字段，而不是两个事件、两张卡。
 */
export function confirmSourceHint(source: ConfirmSource, locale: Locale): string {
  return translate(locale, source === 'PLATFORM' ? 'confirm.sourcePlatform' : 'confirm.sourceServer')
}

/**
 * 答复结果的「幂等忽略」提示。
 *
 * ⚠️ `applied: false` **不是失败**（`shared#confirmConversationResultSchema` 的注释）：
 * 那个提问已经不存在了（超时按取消处理完 / 已被答复过 / 这一轮已经结束），所以什么都没发生。
 * 文案必须说成"**这次确认没有生效**"，而**不是**"确认失败：请求与当前状态冲突"
 * —— 后者会让用户去处理一个他无从理解的竞态。
 *
 * 返回 `null` = 无需提示（`applied:true` 时由 {@link confirmAnsweredText} 说一句更具体的）。
 * 调用方据此走 `feedback.note`（中性），**不走 `fail`**（那是给服务端故障的通道）。
 */
export function confirmIgnoredNote(applied: boolean, locale: Locale): string | null {
  return applied ? null : translate(locale, 'confirm.ignored')
}

/** `applied:true` 时的提示（成功通道） */
export function confirmAnsweredText(accepted: boolean, locale: Locale): string {
  return translate(locale, accepted ? 'confirm.answeredAccepted' : 'confirm.answeredRejected')
}
