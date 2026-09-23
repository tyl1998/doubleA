/**
 * 消息流内错误卡（P0-1-32；`docs/03` §五 的 `error` 行）
 *
 * 规则原文："错误 toast + **消息流内错误卡**；释放输入区；**CONFLICT 专用文案"该会话正在生成中"**"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它在消息流里，而不是在通知栏里 —— 这个位置是契约定的，不是排版偏好
 * ─────────────────────────────────────────────────────────────────────
 * `shared/src/sse.ts` 文件头 ③ 把失败分成两类，分界线是**主语**：
 *   · 主语是"这个请求/目标"（未登录、参数非法、会话不是我的、只读、缺凭据）⇒ **统一 JSON 信封**
 *     ⇒ 根本进不到消息流（`api/client.ts#openEventStream` 在拿到响应头时就抛了）；
 *   · 主语是"**这一轮生成**"（并发冲突、本轮故障）⇒ 流内 `error` 事件 ⇒ 客户端**已经发起了对话**，
 *     前端按单一渲染路径在**对话区**收口 —— 就是这个组件。
 * 所以这里出现的每一个错误，都属于"用户以为自己发了、其实这一轮没成"的语义，
 * 而它必须紧贴着那两条气泡出现，否则用户不知道是哪一轮失败了。
 *
 * ⚠️ 文案**不在本文件**：`P0-1-33` 起 toast 也要说同一句话（"该会话正在生成中"），
 * 于是那句专用文案被搬到 `streamErrors.ts`（一处定义、两个消费方）—— 见那个文件的文件头
 * （`06` §六 第 ⑰ 条："同一口径在两处各写一遍，必有一处先腐烂"）。
 * 本组件因此只剩"把 code/message 映射成 AntD `Alert` 的 message/description"这一件事。
 *
 * ⚠️ 错误码与文案都来自服务端（`sseErrorPayloadSchema` 的 `code` 必须是 `shared` 的错误码）
 * ⇒ 本组件**不发明文案**，只对 `CONFLICT` 这一个码做覆盖（因为契约点名了那句话）。
 */

import { Alert } from 'antd'

import { chatErrorDescription, chatErrorTitle } from './streamErrors.js'

export interface ErrorCardProps {
  /** `shared/src/errors.ts` 的错误码（客户端侧的网络故障用伪码 `NETWORK`） */
  code: string
  message: string
}

export function ErrorCard({ code, message }: ErrorCardProps) {
  return (
    <div data-testid="error-card">
      <Alert
        type="error"
        showIcon
        message={chatErrorTitle(code)}
        description={chatErrorDescription(code, message)}
      />
    </div>
  )
}
