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

import { useState } from 'react'

import { useFeedback } from '../../app/feedback.js'
import { fileContentUrl } from '../../api/files.js'
import { AssistantMessage } from './AssistantMessage.js'
import type { AttachmentView, ChatMessageView } from './messageModel.js'

/** 人类可读的体积（附件条上的一行小字；不引入依赖，纯展示） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 用户消息的附件区（**P1-4**）。`kind` 由**服务端**判定：`IMAGE` 渲染缩略图、
 * `DOCUMENT` 渲染文件条（前端**不看扩展名** —— 判据只有服务端一处）。
 */
function UserAttachments({ items }: { items: readonly AttachmentView[] }) {
  if (items.length === 0) return null
  return (
    <div className="msg__attachments" data-testid="user-message-attachments">
      {items.map((item) =>
        item.kind === 'IMAGE' ? (
          <a
            key={item.fileId}
            className="msg__attachment-image"
            href={fileContentUrl(item.fileId)}
            target="_blank"
            rel="noreferrer"
            title={item.name}
          >
            <img src={fileContentUrl(item.fileId)} alt={item.name} />
          </a>
        ) : (
          <span key={item.fileId} className="msg__attachment-doc" title={item.name}>
            <span className="msg__attachment-doc-icon" aria-hidden="true">
              📄
            </span>
            <span className="msg__attachment-doc-name">{item.name}</span>
            <span className="msg__attachment-doc-size num">{formatSize(item.size)}</span>
          </span>
        ),
      )}
    </div>
  )
}

export interface MessageListProps {
  messages: readonly ChatMessageView[]
  /** 助手消息头部显示的名字（= Agent 名） */
  agentName: string
  /**
   * 可撤回的"最新一轮"用户消息（产品优化 2026-09-29）。`null` = 不显示撤回/修改重发。
   * `hadTools` 是页面从该轮助手消息判出来的（工具效果无法复原的警告要用）。
   */
  recallable?: { key: string; hadTools: boolean } | null
  /** 撤回最新一轮（正文 + 该轮是否调过工具） */
  onRecall?: (text: string, hadTools: boolean) => void
  /** 修改重发最新一轮（撤回后把正文放回输入框） */
  onResend?: (text: string, hadTools: boolean) => void
  /**
   * 可「重新生成」的那条**助手消息**（P1-3）。`null` = 不提供（有流在跑 / 没有会话 /
   * 最后一轮不是一条回答）。判据（哪一条是"最新一轮的回答"）在页面，这里只比对 key。
   */
  regenerable?: { key: string } | null
  /** 点「重新生成」（P1-3）——页面据此调 `useChatStream#regenerate` */
  onRegenerate?: () => void
}

/** 用户消息头部的时刻：`09-22 17:41`（流式消息没有 `createdAt`，那一行就不显示时刻） */
function formatStamp(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function UserMessage({
  view,
  recallable,
  onRecall,
  onResend,
}: {
  view: ChatMessageView
  recallable: { key: string; hadTools: boolean } | null | undefined
  onRecall?: (text: string, hadTools: boolean) => void
  onResend?: (text: string, hadTools: boolean) => void
}) {
  const feedback = useFeedback()
  const [copying, setCopying] = useState(false)
  const stamp = formatStamp(view.createdAt)
  // `recallable?.key` 一次覆盖 `null` / `undefined` / key 不匹配三种"不提供撤回"的情况
  const isRecallable = recallable?.key === view.key
  const hadTools = recallable === null || recallable === undefined ? false : recallable.hadTools

  const copy = async (): Promise<void> => {
    if (view.text === '') return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(view.text)
      feedback.ok('已复制')
    } catch (error) {
      // 复制失败不静默：用户要的是那段文字，不是"点了按钮"（与助手消息的复制同一口径）
      feedback.fail(error, '复制失败')
    } finally {
      setCopying(false)
    }
  }

  return (
    <article className="msg msg--user" data-testid="user-message">
      <p className="msg__head">{stamp === null ? '刚刚' : <span className="num">{stamp}</span>}</p>
      <UserAttachments items={view.attachments} />
      <div className="bubble bubble--user">{view.text}</div>
      <div className="msg__tools">
        {/* 快捷复制（产品优化 2026-09-29）：用户消息也要能快速复制 —— 之前只有助手消息有 */}
        <button type="button" onClick={() => void copy()} disabled={copying || view.text === ''}>
          复制
        </button>
        {/* 撤回 / 修改重发（产品优化 2026-09-29）：只挂在"最新一轮"的用户消息上 */}
        {isRecallable && onRecall !== undefined && onResend !== undefined && (
          <>
            <button type="button" onClick={() => onRecall(view.text, hadTools)}>
              撤回
            </button>
            <button type="button" onClick={() => onResend(view.text, hadTools)}>
              修改重发
            </button>
          </>
        )}
      </div>
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

export function MessageList({
  messages,
  agentName,
  recallable,
  onRecall,
  onResend,
  regenerable,
  onRegenerate,
}: MessageListProps) {
  // ⚠️ **不在这里包 `.stream` / `.stream__inner`**：滚动容器与居中列由页面的 `StreamFrame`
  // （`ChatPage.tsx`）持有，三态（骨架 / 错误 / 空态）与消息流共用同一个外框。
  // 之前在这里再包一层，实测会得到**两层 `.stream`** —— padding 被叠加、还多出一个嵌套滚动容器
  // （结构上错了但没有任何报错，只有 `document.querySelectorAll('.stream').length` 能看到它）。
  return (
    <>
      {messages.map((view) => {
        if (view.key === 'opening') return <OpeningMessage key={view.key} view={view} agentName={agentName} />
        if (view.role === 'USER') {
          return (
            <UserMessage
              key={view.key}
              view={view}
              recallable={recallable}
              onRecall={onRecall}
              onResend={onResend}
            />
          )
        }
        if (view.plain === true) return <OpeningMessage key={view.key} view={view} agentName={agentName} />
        // 「重新生成」只挂在被 `regenerable` 点中的那一条（= 最新一轮的回答）；其余不传回调
        return (
          <AssistantMessage
            key={view.key}
            view={view}
            agentName={agentName}
            {...(regenerable?.key === view.key && onRegenerate !== undefined ? { onRegenerate } : {})}
          />
        )
      })}
    </>
  )
}
