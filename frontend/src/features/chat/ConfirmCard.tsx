/**
 * 确认卡（P0-1-32 落地形态；**数据源自 P0-2-10 起已经通了**，但接真数据属 P0-2-11）
 *
 * `docs/03` §4.1 消息流渲染规则表第 7 行："工具名 + 入参摘要 + [确认] [取消]；
 * **阻塞输入区**；120s 倒计时"；版式图里它在**输入区**里（不是消息流里）。
 *
 * ⚠️ **P0-2-10 起这张卡的"上游"变了**（本文件因此只是改注释、**行为一个字没改**）：
 * 事件产生方（`chatBot.ts` 的危险工具闸门 + MCP `elicitation/create`）与应答端点
 * `POST /api/conversations/:id/confirm` **都已落地**（`02` §9.10）⇒ 事件真的会到、
 * `roundReducer` 也真的会把它存进 `StreamRound.confirm`。
 * 但**本批不是它接真数据的批次**：`timeoutSec` 仍是写死的、`expiresAt` 还没被消费、
 * 两个按钮仍是 `disabled` ⇒ **界面上会看到卡、点不动**，120s 后由服务端按取消处理、流程继续。
 * 这不是坏了，是 **P0-2-11** 的活（它才是浏览器可端测里程碑）。
 * ⚠️ 而且现在**浏览器里根本走不到这里**：`/mcp` 是占位页（建不了 server）⇒ 没有危险工具可触发。
 *
 * ⚠️ 两个按钮**刻意** disabled：见 `ArtifactCard.tsx` 的说明（P0-1-31 的「不提供点不通的入口」）。
 * 「120s 倒计时」同理不实现 —— 它需要"剩多少秒"的数据（超时按取消的判据在服务端），
 * 现在写一个本地数数的倒计时会与真实超时**各数各的**，那种不一致比没有倒计时更难查。
 * ✅ **P0-2-11 的现成答案**：服务端已经给出 `expiresAt`（`shared#sseConfirmPayloadSchema`）——
 * 倒计时**只读它**、不要自己另起一个 120s。
 */

import { Button } from 'antd'

export interface ConfirmCardProps {
  toolName: string
  inputSummary: string
  /** 服务端给的超时（秒）—— 只用于文案，见文件头（P0-2-11 换成 `expiresAt` 算出来的倒数） */
  timeoutSec: number
}

export function ConfirmCard({ toolName, inputSummary, timeoutSec }: ConfirmCardProps) {
  return (
    <div className="confirm-card" data-testid="confirm-card">
      <div className="confirm-card__head">
        <span className="led led--warn" />
        <p className="confirm-card__title">工具请求确认：{toolName}</p>
        <span className="countdown num">{timeoutSec}s</span>
      </div>
      <div className="confirm-card__body">
        <p className="ratio">该工具被判定为需要人工确认（危险操作或未声明只读）。</p>
        <div className="code-block">{inputSummary}</div>
        <p className="ratio">
          界面上的确认 / 取消属 P0-2-11（服务端应答端点 `POST /:id/confirm` 已可用）；超时后由服务端按取消处理。
        </p>
      </div>
      <div className="confirm-card__foot">
        <Button type="primary" disabled title="按钮接线属 P0-2-11（服务端应答端点已可用）">
          确认
        </Button>
        <Button disabled title="按钮接线属 P0-2-11（服务端应答端点已可用）">
          取消
        </Button>
      </div>
    </div>
  )
}
