/**
 * 工具卡片（P0-1-32；`docs/03` §4.1 消息流渲染规则表第 4 行；**P0-2-11 接上「去配置凭据」**）
 *
 * 规则原文："图标 + 工具名 + 参数摘要 + 状态灯（运行/成功/失败）；点击展开完整入参/出参；
 * 失败卡片显示原因；**"需配置凭据"卡片带跳转按钮**"。
 *
 * 状态灯与左侧刻度（`.tool--run/ok/fail`）都由 `status` 驱动，**判据只有这一处**
 * （`TOOL_CALL_STATUSES` 是 DB/契约的取值域，与 `tool_call` 事件同源）。
 *
 * ⚠️ **P0-2-11 起「去配置凭据」真的接上了**（这个按钮在 P0-1 期间是**刻意不提供**的：
 * 目标页当时还是占位页，摆一个点不通的入口比没有更差）。
 * 现在判据是 `messageModel#canConfigureCredential`（**三个条件缺一不可**：
 * `ERROR` + `errorCode === 'NEED_CREDENTIAL'` + **有 `serverId`**）。第三条是最容易漏的一条，
 * 漏了会拼出一个 `?serverId=`（空值）的链接 —— 用户点了、页面也跳了、就是什么都不发生。
 *
 * ⚠️ 入参那一行**不显示 `arguments`**：卡片上要显示的是 `inputSummary`（截断过、且凭据值已抹除）。
 * `arguments` 是落库留档用的原样 JSON（`messageModel#pickToolCalls` 刻意没把它带上来）。
 */

import { Button, Tag } from 'antd'
import { memo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  canConfigureCredential,
  errorCodeLabel,
  toolErrorHint,
  type ToolCallView,
} from './messageModel.js'
import { credentialsPath } from '../../app/paths.js'

/** 状态 → 中文标签与刻度类（唯一一份映射，别在 JSX 里再判一次 status） */
const STATUS_PRESENTATION: Record<ToolCallView['status'], { label: string; className: string }> = {
  RUNNING: { label: '运行中', className: 'tool--run' },
  SUCCESS: { label: '成功', className: 'tool--ok' },
  ERROR: { label: '失败', className: 'tool--fail' },
}

/**
 * 工具来源 → 卡片上的中文名（唯一一份映射）。
 * `BUILTIN` = 平台内置工具（当前只有「知识库检索」），它没有 MCP server，也没有凭据可配
 * ⇒ 卡片不会出现「去配置凭据」（判据在 `messageModel#canConfigureCredential`：缺 `serverId` 即不提供）。
 */
const KIND_LABEL: Record<ToolCallView['kind'], string> = {
  MCP: 'MCP 工具',
  SANDBOX: '沙箱工具',
  BUILTIN: '内置工具',
}

export interface ToolCardProps {
  tool: ToolCallView
}

/**
 * ⚠️ `memo`（2026-10-21）：正文流式期间父组件每帧重渲染，而绝大多数卡片的 `tool` 引用没变
 * （`roundReducer` 按 `callId` upsert，只有被更新的那一张换了对象）⇒ memo 让其余卡片整块跳过，
 * 展开/收起状态与滚动位置都不会被无谓刷新。
 */
export const ToolCard = memo(function ToolCard({ tool }: ToolCardProps) {
  const presentation = STATUS_PRESENTATION[tool.status]
  // 运行中的卡默认展开（用户此刻最想知道它在干什么）；终态默认折叠，把空间还给正文
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const open = userChoice ?? tool.status === 'RUNNING'

  // 终态**优先**权威 `output`（落库那份、与回填模型的是同一份）；`RUNNING` 时没有 `output`，
  // 退回实时快照 `liveOutput`（`tool_output` 事件，覆盖语义；不落库、刷新后即无 —— 见 `roundReducer`）。
  const detail = tool.output ?? tool.liveOutput
  const hasDetail = detail !== undefined && detail !== ''
  const needsCredential = canConfigureCredential(tool)
  const hint = toolErrorHint(tool.errorCode)

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
        <p className="kicker">
          {KIND_LABEL[tool.kind]} · 调用 ID {tool.callId}
          {/* 失败原因**必须显示**（`03` §4.1 第 4 行："失败卡片显示原因"）。
              ⚠️ 错误码与 HTTP 状态码是两回事：前者是 `shared/src/errors.ts` 的取值域。
              文案取自 `errorCodeLabel`（= `shared` 那张表的**唯一**来源，
              见 `messageModel#errorCodeLabel` 的注释：卡片手上是字符串、不是 `Error` 对象）。 */}
          {tool.errorCode === undefined
            ? null
            : ` · ${tool.errorCode}${errorCodeLabel(tool.errorCode) === null ? '' : `（${errorCodeLabel(tool.errorCode)}）`}`}
        </p>
        {/* 完整入参（摘要之外的那一份）：事件里给的是 `inputSummary`，完整入参由
            `messageContentSchema` 的 `tool_calls.arguments` 承载、**但刻意不上屏**
            （凭据值已在 `inputSummary` 里抹除，而 `arguments` 是原样 JSON）——
            所以这里如实说明"哪里能看到更全的"，而不是拿摘要冒充完整入参。 */}
        <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
          入参摘要：{tool.inputSummary}
        </p>
        {hasDetail ? (
          <div className="code-block" style={{ marginTop: 'var(--sp-3)' }}>
            {detail}
          </div>
        ) : (
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {tool.status === 'RUNNING' ? '等待结果…' : '本次调用没有返回内容'}
          </p>
        )}

        {/* 失败原因之外的**可操作那一步**（`02` §9.3）。判据见 `canConfigureCredential`：
            没有 `serverId` 时**不渲染按钮** —— 那时链接落不到任何一组凭据上，
            与其给一个"点了没反应"的入口，不如只把原因说清楚。 */}
        {hint === null ? null : (
          <div className="row row--wrap" style={{ marginTop: 'var(--sp-3)', gap: 'var(--sp-3)' }}>
            <span className="ratio">{hint}</span>
            {needsCredential && tool.serverId !== undefined ? (
              <Link to={credentialsPath(tool.serverId)}>
                <Button size="small" type="primary">
                  去配置凭据
                </Button>
              </Link>
            ) : null}
          </div>
        )}
      </div>
    </details>
  )
})
