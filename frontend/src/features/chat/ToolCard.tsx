/**
 * 工具卡片（P0-1-32；`docs/03` §4.1 消息流渲染规则表第 4 行）
 *
 * 规则原文："图标 + 工具名 + 参数摘要 + 状态灯（运行/成功/失败）；点击展开完整入参/出参；
 * 失败卡片显示原因；**"需配置凭据"卡片带跳转按钮**"。
 *
 * 状态灯与左侧刻度（`.tool--run/ok/fail`）都由 `status` 驱动，**判据只有这一处**
 * （`TOOL_CALL_STATUSES` 是 DB/契约的取值域，与 `tool_call` 事件同源）。
 *
 * ⚠️ **P0 阶段流里不会出现 `tool_call`**：ChatBot 的 MCP 工具属 **P0-2**、TaskAgent 的沙箱工具
 * 属 **P0-3**（`shared/src/sse.ts` 的事件全集注释）。本文件是"事件 → UI 映射表"的落地，
 * 事件形状已经定义好（`sseToolCallPayloadSchema`），所以卡片先就位；**没有数据源，
 * 不是没做**。等 P0-2 的编排层产出 `tool_call` 之后，这里一行都不用改。
 *
 * ⚠️ 原型上还有「NEED_CREDENTIAL 的失败卡带「去配置凭据」按钮（跳 `/mcp/credentials?serverId=`）」：
 * 那条跳转的目标页（我的凭据）属 **P0-2**，现在搁一个按钮过去会落到占位页上 ——
 * 处置与 `AgentFormPage` 对 MCP 多选的处置一致：**不提供点不通的入口**，
 * 在卡片上如实给出错误码与原因（用户知道发生了什么，只是修复入口要等 P0-2）。
 */

import { Tag } from 'antd'
import { useState } from 'react'

import type { ToolCallView } from './messageModel.js'

/** 状态 → 中文标签与刻度类（唯一一份映射，别在 JSX 里再判一次 status） */
const STATUS_PRESENTATION: Record<ToolCallView['status'], { label: string; className: string }> = {
  RUNNING: { label: '运行中', className: 'tool--run' },
  SUCCESS: { label: '成功', className: 'tool--ok' },
  ERROR: { label: '失败', className: 'tool--fail' },
}

export interface ToolCardProps {
  tool: ToolCallView
}

export function ToolCard({ tool }: ToolCardProps) {
  const presentation = STATUS_PRESENTATION[tool.status]
  // 运行中的卡默认展开（用户此刻最想知道它在干什么）；终态默认折叠，把空间还给正文
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const open = userChoice ?? tool.status === 'RUNNING'

  const hasDetail = tool.output !== undefined && tool.output !== ''

  return (
    <details className={`tool ${presentation.className}`} open={open} data-testid="tool-card">
      <summary
        className="tool__head"
        onClick={(event) => {
          event.preventDefault()
          setUserChoice(!open)
        }}
      >
        <span className="tool__name">{tool.toolName}</span>
        {tool.serverName === '' ? null : <span className="ratio">{tool.serverName}</span>}
        <span className="tool__arg">{tool.inputSummary}</span>
        <span className="tool__head-right">
          {tool.status === 'RUNNING' ? (
            <span className="row" style={{ gap: 'var(--sp-2)' }}>
              <span className="led led--run" />
              <span className="ratio">运行中</span>
            </span>
          ) : (
            <Tag className={tool.status === 'SUCCESS' ? 'tag--ok' : 'tag--danger'}>
              {presentation.label}
            </Tag>
          )}
          <span className="think__caret" aria-hidden="true">
            ›
          </span>
        </span>
      </summary>
      <div className="tool__body">
        <p className="kicker">{tool.kind === 'MCP' ? 'MCP 工具' : '沙箱工具'} · 调用 ID {tool.callId}</p>
        {/* 完整入参（摘要之外的那一份）：事件里给的是 `inputSummary`，完整入参由
            `messageContentSchema` 的 `tool_calls` 段承载（属 P0-2 定型）——
            所以这里如实说明"哪里能看到更全的"，而不是拿摘要冒充完整入参。 */}
        <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
          入参摘要：{tool.inputSummary}
        </p>
        {hasDetail ? (
          <div className="code-block" style={{ marginTop: 'var(--sp-3)' }}>
            {tool.output}
          </div>
        ) : (
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {tool.status === 'RUNNING' ? '等待结果…' : '本次调用没有返回内容'}
          </p>
        )}
      </div>
    </details>
  )
}
