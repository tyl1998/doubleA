/**
 * 消息流（P0-1-32；`docs/03` §4.1 的版式中栏、§六"流式渲染与历史渲染同一套组件"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个组件的入参只有**一个** `ChatMessageView[]` —— 这就是"单一渲染路径"的全部实现
 * ─────────────────────────────────────────────────────────────────────
 * 历史消息（`messageToView`）与流式消息（`roundToViews`）在进入本组件之前**已经被归一成同一形状**
 * （`messageModel.ts` 的文件头解释了为什么必须这样）。于是：
 *   · 页面不必判断"这是历史还是流式"（那种判断一旦散在 JSX 里，两边的卡片就会开始漂移）；
 *   · 新加一种卡片（P0-2 的工具卡、P0-3 的产物卡的**历史**版本）只需要改归一化那一层。
 *
 * 用户消息是**纯文本气泡**（`03` §4.1：用户气泡；原型的 `.bubble--user` 里也不解析 Markdown）
 * —— 用户输入的原样回显，解析 Markdown 会让"我打的 `#` 号"变成一个标题，
 * 而用户想确认的是"我到底发出去了什么"。
 *
 * ⚠️ 开场白（`plain: true`）走与用户气泡**同样的纯文本渲染**但用助手侧的气泡样式
 * （`03` §4.1 第一行："Agent 开场白纯文本气泡"）。
 */

import { AssistantMessage } from './AssistantMessage.js'
import type { ChatMessageView } from './messageModel.js'

export interface MessageListProps {
  messages: readonly ChatMessageView[]
  /** 助手消息头部显示的名字（= Agent 名） */
  agentName: string
}

/** 用户消息头部的时刻：`09-22 17:41`（流式消息没有 `createdAt`，那一行就不显示时刻） */
function formatStamp(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function UserMessage({ view }: { view: ChatMessageView }) {
  const stamp = formatStamp(view.createdAt)
  return (
    <article className="msg msg--user" data-testid="user-message">
      <p className="msg__head">{stamp === null ? '刚刚' : <span className="num">{stamp}</span>}</p>
      <div className="bubble bubble--user">{view.text}</div>
    </article>
  )
}

/** 开场白：纯文本气泡（`plain`），头部标"开场白"以免被误读成一条回答 */
function OpeningMessage({ view, agentName }: { view: ChatMessageView; agentName: string }) {
  return (
    <article className="msg msg--agent" data-testid="opening-message">
      <p className="msg__head">
        <span className="led led--idle" aria-hidden="true" />
        {agentName} · 开场白
      </p>
      <div className="bubble bubble--agent">{view.text}</div>
    </article>
  )
}

export function MessageList({ messages, agentName }: MessageListProps) {
  // ⚠️ **不在这里包 `.stream` / `.stream__inner`**：滚动容器与居中列由页面的 `StreamFrame`
  // （`ChatPage.tsx`）持有，三态（骨架 / 错误 / 空态）与消息流共用同一个外框。
  // 之前在这里再包一层，实测会得到**两层 `.stream`** —— padding 被叠加、还多出一个嵌套滚动容器
  // （结构上错了但没有任何报错，只有 `document.querySelectorAll('.stream').length` 能看到它）。
  return (
    <>
      {messages.map((view) => {
        if (view.key === 'opening') return <OpeningMessage key={view.key} view={view} agentName={agentName} />
        if (view.role === 'USER') return <UserMessage key={view.key} view={view} />
        if (view.plain === true) return <OpeningMessage key={view.key} view={view} agentName={agentName} />
        return <AssistantMessage key={view.key} view={view} agentName={agentName} />
      })}
    </>
  )
}
