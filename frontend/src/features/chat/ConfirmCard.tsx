/**
 * 确认卡（P0-1-32 落地形态；产生路径属 P0-2）
 *
 * `docs/03` §4.1 消息流渲染规则表第 7 行："工具名 + 入参摘要 + [确认] [取消]；
 * **阻塞输入区**；120s 倒计时"；版式图里它在**输入区**里（不是消息流里）。
 *
 * ⚠️ **P0 阶段这张卡永远不出现**：`confirm` 事件的产生方是 MCP 工具的危险判定
 * （`annotations.destructiveHint` 或 `readOnlyHint` 缺失，`01` 需求 21–27），属 **P0-2**；
 * 它的应答端点 `POST /api/conversations/:id/confirm` **也不存在**（`02` §4.5 的九条路由里
 * 唯一没有出口的那一条）。`shared/src/sse.ts` 已经定好 payload 形状，归约层也存下了
 * （`StreamRound.confirm`），所以本组件先落地形态，**没有数据源**。
 *
 * ⚠️ 两个按钮刻意 disabled：见 `ArtifactCard.tsx` 的说明（P0-1-31 的「不提供点不通的入口」）。
 * 「120s 倒计时」同理不实现 —— 它需要"剩多少秒"的数据（超时按取消的判据在服务端），
 * 现在写一个本地数数的倒计时会与真实超时**各数各的**，那种不一致比没有倒计时更难查。
 */

import { Button } from 'antd'

export interface ConfirmCardProps {
  toolName: string
  inputSummary: string
  /** 服务端给的超时（秒）—— 只用于文案，见文件头 */
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
          应答端点（`POST /:id/confirm`）属 P0-2，本版本无法确认或取消；超时后由服务端按取消处理。
        </p>
      </div>
      <div className="confirm-card__foot">
        <Button type="primary" disabled title="确认/取消应答属 P0-2（需要 mcp_servers 表）">
          确认
        </Button>
        <Button disabled title="确认/取消应答属 P0-2（需要 mcp_servers 表）">
          取消
        </Button>
      </div>
    </div>
  )
}
