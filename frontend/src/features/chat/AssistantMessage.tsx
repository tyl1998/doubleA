/**
 * 助手消息（P0-1-32）
 *
 * `docs/03` §4.1 的消息流渲染规则表里，助手那一条消息由**五块**按到达顺序拼成：
 * 思考块 → 工具卡（可多张）→ 正文 Markdown → 引用卡 → 产物卡，末尾是收尾信息。
 * 这个顺序**不是排版偏好**：它就是 SSE 事件在一条流里的自然顺序
 * （`orchestrator/chatBot.ts` 先 thinking、再 tool_call、再 delta、`citations` 在检索阶段、
 * `artifact` 在沙箱阶段），而 `03` §五 要求"事件即真相"——界面按事件顺序生长，
 * 刷新后按同一套组件重画。**两种来源的长相必须一致**，这一点由
 * `messageModel.ts#messageToView` 与 `roundReducer.ts#roundToViews` 共同保证。
 *
 * ⚠️ 收尾信息（`done · COMPLETE · tokens …`）**只说真实存在的东西**：
 *   · `usage` 可能为 `null`（上游不给）⇒ 那一行不出现，而不是显示 `tokens 0 in / 0 out`；
 *   · 没有"用时"字段（`done` 事件里没有耗时，原型的 `12.4s` 来自演示数据）⇒ **不显示**；
 *   · `messageId === null`（这一轮没有可持久化的消息，`shared/src/sse.ts` 文件头 ④）
 *     ⇒ **显式说出来**，否则用户会在刷新后觉得"我刚才的回答丢了"。
 *
 * ⚠️ 「复制全文」按 `03` §4.1 用 `navigator.clipboard`（localhost 是安全上下文，开发期可用）。
 * 失败时不静默：复制不到就得告诉用户（他要的是那段文字，而不是"我点了按钮"）。
 */

import { useState } from 'react'

import { useFeedback } from '../../app/feedback.js'
import { ArtifactCard } from './ArtifactCard.js'
import { AssistantMarkdown } from './AssistantMarkdown.js'
import { CitationCard } from './CitationCard.js'
import { ErrorCard } from './ErrorCard.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCard } from './ToolCard.js'
import { isAssistantEmpty, type ChatMessageView } from './messageModel.js'

export interface AssistantMessageProps {
  view: ChatMessageView
  /** 头部显示的名字（`03` §4.1 的 `msg__head`） */
  agentName: string
}

/** token 用量 → 一行文案；两个数各自可空（`usage.tokensIn` 是 `number | null`） */
function usageText(usage: ChatMessageView['usage']): string | null {
  if (usage === null || usage === undefined) return null
  const input = usage.tokensIn === null ? '—' : String(usage.tokensIn)
  const output = usage.tokensOut === null ? '—' : String(usage.tokensOut)
  return `tokens ${input} in / ${output} out`
}

/**
 * 收尾行要说的那句话（`03` §五 的 `done` 行："结束流；`finishReason=STOPPED` 标注「已停止」
 * （COMPLETE 为正常结束）"）。返回 `null` = 这一行不出现。
 */
function footerText(view: ChatMessageView): string | null {
  if (view.status === 'streaming') return null
  // 失败由错误卡承担（它就在同一个 `<article>` 里），这里再来一句是重复
  if (view.status === 'error') return null

  const usage = usageText(view.usage)
  if (view.status === 'stopped') {
    return ['已停止 · 已生成的内容保留', usage].filter((part) => part !== null).join(' · ')
  }
  return ['已完成', usage].filter((part) => part !== null).join(' · ')
}

/** 头部状态灯：在写 = 脉冲；收尾后按结果给颜色（与 `led--*` 同一套语义） */
function headLedClass(view: ChatMessageView): string {
  if (view.status === 'streaming') return 'led led--run'
  if (view.status === 'error') return 'led led--fail'
  if (view.status === 'stopped') return 'led led--idle'
  return 'led led--ok'
}

export function AssistantMessage({ view, agentName }: AssistantMessageProps) {
  const feedback = useFeedback()
  const [copying, setCopying] = useState(false)

  const empty = isAssistantEmpty(view)
  const footer = footerText(view)

  const copyAll = async (): Promise<void> => {
    if (view.text === '') return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(view.text)
      feedback.ok('已复制全文')
    } catch (error) {
      // 复制失败不静默（见文件头）：用户要的是那段文字，不是"点了按钮"
      feedback.fail(error, '复制失败')
    } finally {
      setCopying(false)
    }
  }

  return (
    <article className="msg msg--agent" data-testid="assistant-message">
      <p className="msg__head">
        <span className={headLedClass(view)} aria-hidden="true" />
        {agentName}
      </p>

      {/* 思考块：`thinking` 为空串 = 这一段本来就没有 ⇒ 不渲染（`03` §4.1 的"可选而非默认"口径） */}
      {view.thinking === '' ? null : (
        <ThinkingBlock text={view.thinking} streaming={view.status === 'streaming'} />
      )}

      {view.tools.map((tool) => (
        <ToolCard key={tool.callId} tool={tool} />
      ))}

      {empty ? (
        <p className="ratio" data-testid="assistant-placeholder">
          {view.status === 'streaming' ? (
            // 流式但**一个字都还没到**：先显示 TaskAgent 的生命周期中间态（`status` 事件，
            // "沙箱就绪 → 引擎启动 → 引擎就绪"），没有就回落成"等待上游响应"占位。
            // 状态行只是"还没内容时"的进度指示，真实内容一到归约层就会清掉它。
            <>
              {view.statusText ?? '正在等待上游响应…'}
              <span className="caret" aria-hidden="true" />
            </>
          ) : view.status === 'stopped' ? (
            '已停止：本轮没有产生内容'
          ) : (
            '本轮没有产生内容'
          )}
        </p>
      ) : (
        <>
          {view.text === '' ? null : <AssistantMarkdown text={view.text} />}
          {view.status === 'streaming' ? (
            // 流式光标：`design/styles/components.css` 的 `.caret`（块状、闪烁，暗示"打字机"）
            <span className="caret" aria-hidden="true" />
          ) : null}
        </>
      )}

      {/* 引用卡：`null` = 本轮没有引用 ⇒ 整块不渲染（未命中知识库时后端不发 citations 事件） */}
      {view.citations === null ? null : <CitationCard items={view.citations} />}

      {view.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.artifactId} artifact={artifact} />
      ))}

      {view.status === 'error' && view.error !== undefined ? (
        <ErrorCard code={view.error.code} message={view.error.message} />
      ) : null}

      {footer === null ? null : (
        <p className="ratio num" data-testid="assistant-footer">
          {footer}
          {view.persisted === false ? ' · 本轮没有可保存的内容（刷新后不会出现在历史里）' : ''}
        </p>
      )}

      <div className="msg__tools">
        <button
          type="button"
          onClick={() => {
            void copyAll()
          }}
          disabled={copying || view.text === ''}
        >
          复制全文
        </button>
      </div>
    </article>
  )
}
