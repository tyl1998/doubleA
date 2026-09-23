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
 * ⚠️ `CONFLICT` 的专用文案（"该会话正在生成中"）在本批**已经生效**（`03` §五 明写的那句话）。
 * P0-1-33 要补的是"同标签页重复发送时的专用 toast + 输入区状态机"，与这里不重复。
 *
 * ⚠️ 错误码与文案都来自服务端（`sseErrorPayloadSchema` 的 `code` 必须是 `shared` 的错误码）
 * ⇒ 本组件**不发明文案**，只对 `CONFLICT` 这一个码做覆盖（因为契约点名了那句话）。
 */

import { Alert } from 'antd'

export interface ErrorCardProps {
  /** `shared/src/errors.ts` 的错误码（客户端侧的网络故障用伪码 `NETWORK`） */
  code: string
  message: string
}

/** `03` §五 点名的专用文案：并发冲突时说人话，而不是让用户读 `CONFLICT` */
const CONFLICT_TITLE = '该会话正在生成中'

export function ErrorCard({ code, message }: ErrorCardProps) {
  const title = code === 'CONFLICT' ? CONFLICT_TITLE : '这一轮没有生成成功'
  const description = code === 'CONFLICT' ? message : `${code} · ${message}`

  return (
    <div data-testid="error-card">
      <Alert type="error" showIcon message={title} description={description} />
    </div>
  )
}
