/**
 * 确认卡（P0-1-32 落地形态；**P0-2-11 接真数据源**）
 *
 * `docs/03` §4.1 消息流渲染规则表第 7 行："工具名 + 入参摘要 + [确认] [取消]；
 * **阻塞输入区**；120s 倒计时"；版式图里它在**输入区**里（不是消息流里）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 倒计时**只读服务端给的绝对时刻**（`expiresAt`），前端不另起 120s
 * ─────────────────────────────────────────────────────────────────────
 * 这是 `06` P0-2-11 坑预判 3 的原话。理由：`03` §4.1 的"120s"**是服务端超时在前端的投影**
 * —— 让前端自己另起一个 120s，两边只要有一点点差（网络、时钟、重连）就会变成
 * "界面说还没到、服务端已按取消处理"，而用户看到的是"我点了确认但什么都没发生"。
 * 有了绝对时刻，卡片重挂之后也能算对剩余时间（`remainingSeconds(expiresAt, now)`）。
 *
 * ⚠️ 本组件**不做**"到点了就自己把卡撤掉"这件事：撤卡的判据是**服务端**的
 * （它按取消处理完、这一轮继续跑）。前端把读数停在「已超时」并**禁用两个按钮**
 * —— 那正是此时的事实：点了也不会生效（`applied:false`）。自己撤卡会让用户以为
 * "这一轮卡住了"，而它其实已经往下走了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 两个按钮的文案与后果由 `source` 决定**说明行**，按钮本身不变
 * ─────────────────────────────────────────────────────────────────────
 * `PLATFORM`（平台的危险判定）与 `SERVER`（MCP 反向发起的 elicitation）的 payload 形状、
 * 挂起原语、应答端点**完全一致**（`shared#sseConfirmPayloadSchema` 的注释），
 * 差异只在"谁在问"这句说明上 —— 所以它是一个判别字段，而不是两种卡片。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 「已答复」是一个**本地瞬时态**，不是服务端状态
 * ─────────────────────────────────────────────────────────────────────
 * 点下去之后到页面从 store 里收掉这张卡之间有一小段（一次往返）。
 * 这期间必须**两个按钮都禁用**（否则用户能连点两次、发两次应答，第二次会拿到
 * `applied:false` 并弹一句让人困惑的提示）。用 `pending` 表达，**不引入新状态机**
 * —— 卡片消失的判据始终是 store 里那个 `confirm` 还在不在。
 */

import { Button } from 'antd'
import { useEffect, useState } from 'react'

// ⚠️ 纯逻辑在**同目录**的 `confirmModel.ts`（不能取 `pages/mcp/mcpModel.ts` —— 那会造出
//    `features/chat/` → `pages/` 的反向依赖，见 `confirmModel.ts` 文件头的说明）
import { confirmCountdownText, confirmSourceHint, remainingSeconds } from './confirmModel.js'
import type { ConfirmSource } from '@doubulea/shared'

export interface ConfirmCardProps {
  /** 谁在问（决定说明行，见文件头 ②） */
  source: ConfirmSource
  toolName: string
  inputSummary: string
  /** 服务端这次等待的截止时刻（ISO 8601）—— 倒计时的**唯一**输入 */
  expiresAt: string
  /**
   * 这次问的是**重复执行**：本轮同名同参的危险工具已经成功执行过一次。
   * 只为把标题与说明换成"会再执行一次"，机制与普通确认完全相同。
   */
  duplicate?: boolean
  /** 正在提交（两个按钮都禁用，见文件头 ③） */
  pending: boolean
  /**
   * 用户的选择。**是否真的发请求、发什么**由页面决定（`ChatPage#handleConfirm`）——
   * 卡片只把"确认 / 取消"这个意图转出去，与 `ChatInput` 只转"发送 / 停止"同款分工。
   */
  onAnswer: (accepted: boolean) => void
}

/**
 * 倒计时的节拍：**1 秒一跳**。
 *
 * ⚠️ 用 `setInterval` 自己起拍、每拍重新从 `expiresAt` 算**剩余秒数**，
 * 而不是"本地减一"：减一会累积漂移（标签页被挂起时定时器不精确，减一算出来的
 * 剩余时间与真实截止时刻越差越远），而重算每拍都是幂等的。
 * 走 `countdown` 这个 state 只为触发重渲染 —— 读数仍由 `expiresAt` 决定。
 */
function useCountdownTick(expiresAt: string): number {
  const [remaining, setRemaining] = useState(() => remainingSeconds(expiresAt))
  useEffect(() => {
    setRemaining(remainingSeconds(expiresAt))
    const timer = window.setInterval(() => {
      setRemaining(remainingSeconds(expiresAt))
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [expiresAt])
  return remaining
}

export function ConfirmCard({
  source,
  toolName,
  inputSummary,
  expiresAt,
  duplicate = false,
  pending,
  onAnswer,
}: ConfirmCardProps) {
  const remaining = useCountdownTick(expiresAt)
  const expired = remaining <= 0

  return (
    <div className="confirm-card" data-testid="confirm-card">
      <div className="confirm-card__head">
        <span className="led led--warn" />
        <p className="confirm-card__title">
          {duplicate ? '工具请求重复执行：' : '工具请求确认：'}
          {toolName}
        </p>
        {/* 读数只读服务端给的时刻（见文件头 ①）；到点显示「已超时」而不是 `0s` */}
        <span className="countdown num" data-testid="confirm-countdown">
          {confirmCountdownText(remaining)}
        </span>
      </div>
      <div className="confirm-card__body">
        <p className="ratio">
          {duplicate
            ? '本轮已经用完全相同的参数执行过这个工具。确认会再执行一次（例如再删一次、再写一次）；不确认则跳过。'
            : confirmSourceHint(source)}
        </p>
        {/* 入参摘要：`inputSummary` 里的凭据值已经被平台抹除（`chatContext#summarizeToolInput`）
            ⇒ 它可以直接显示，不需要再做一层遮罩 */}
        <div className="code-block">{inputSummary}</div>
        {expired ? (
          <p className="ratio">
            服务端的等待窗口已经结束，它会按「取消」处理并继续这一轮；这两个按钮现在点了也不会生效。
          </p>
        ) : (
          <p className="ratio">超时后会由服务端按「取消」处理，这一轮不会卡住。</p>
        )}
      </div>
      <div className="confirm-card__foot">
        <Button
          type="primary"
          disabled={pending || expired}
          loading={pending}
          data-testid="confirm-accept"
          onClick={() => onAnswer(true)}
        >
          确认执行
        </Button>
        <Button disabled={pending || expired} data-testid="confirm-reject" onClick={() => onAnswer(false)}>
          取消
        </Button>
      </div>
    </div>
  )
}
