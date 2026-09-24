/**
 * 输入区（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §4.1 的版式（`[📎] [输入框…] [停止/发送]`，📎 附件属 P1 ⇒ **P0 不渲染**）
 *      与「输入区状态机」全文、§七 的键盘约定（"Enter 发送（对话输入框）"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它自己**不做任何判断**
 * ─────────────────────────────────────────────────────────────────────
 * "现在是什么状态、按钮长什么样、能不能发、占位符写什么"全部来自
 * {@link composeState}（`composerState.ts`，纯函数、被无依赖档逐状态断言）。
 * 这个组件只做三件事：把状态画出来、把用户意图（发送 / 停止 / 改草稿）转成回调、发 `data-testid`
 * 供端测定点观测。**一旦这里出现 `if (streaming) …` 这类判断，就会有两处状态语义** ——
 * 而无依赖档只守得住 `composerState.ts` 那一处。
 *
 * ⚠️ 「停止」按钮**不能**是 `htmlType="submit"`：它在一个 `<form>` 里，submit 会触发发送
 * （症状是"点停止反而又发了一条"）。
 *
 * ⚠️ 这里是**原生 `<textarea>`**（不是 AntD 的 `Input.TextArea`）：它与内联按钮一起构成
 * "方框内左侧自适应高度输入 + 右侧按钮"这个 AntD 表达不了的布局（与 `styles/app.css` 里
 * `.composer textarea` 的注释一致）。
 */

import { Button } from 'antd'
import type { KeyboardEvent } from 'react'

import { ConfirmCard } from './ConfirmCard.js'
import { composeState, isSubmitKey } from './composerState.js'
import type { StreamRound } from './roundReducer.js'

export interface ChatInputProps {
  /** 当前会话进行中的那一轮（`null` = 空闲） */
  round: StreamRound | null
  /**
   * `send()` 在飞（含"建会话 + 建流"的空窗）
   */
  sending: boolean
  /** 点了停止、正在 5s 窗口里等收口 */
  stopping: boolean
  /**
   * **另一个**会话正在生成（P0-1-34）。判据在页面里：
   * `streamingId !== null && streamingId !== conversationId`（见 `useChatStream` 的
   * `streamingId`）—— 这里只负责把它交给状态机，**不自己判**。
   */
  elsewhere: boolean
  draft: string
  onDraftChange: (text: string) => void
  /** 提交（发送）。**是否真的发**由状态机的 `canSend` 决定，这里不再判一次 */
  onSubmit: () => void
  /** 点「停止」（时序在 `stopController.ts`，这里只管把意图转出去） */
  onStop: () => void
  /**
   * 答复确认卡（P0-2-11）：`true` = 确认执行、`false` = 取消。
   *
   * ⚠️ 本组件**不碰请求**（`03` §六："组件内不写请求，全部走 api 层"）—— 它只把意图转出去，
   * 由 `ChatPage#handleConfirm` 决定发什么、以及答复之后怎么收卡（见 `ConfirmCard` 文件头 ③）。
   */
  onConfirmAnswer: (accepted: boolean) => void
  /** 确认应答正在提交（两个按钮都禁用，防连点） */
  confirmPending: boolean
}

export function ChatInput({
  round,
  sending,
  stopping,
  elsewhere,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  onConfirmAnswer,
  confirmPending,
}: ChatInputProps) {
  const view = composeState({ round, sending, stopping, elsewhere, draft })

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 判据在 `composerState.ts#isSubmitKey`（含中文输入法候选词的 `isComposing` 那一条 ——
    // 少了它，拼音打到一半按 Enter 就会把半截拼音发出去）
    if (!isSubmitKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) {
      return
    }
    event.preventDefault()
    if (view.canSend) onSubmit()
  }

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (view.canSend) onSubmit()
      }}
    >
      <div className="composer__inner">
        {/* 确认卡：`confirm` 事件到达 ⇒ 锁输入显示确认卡（`03` §4.1）。
            ⚠️ **P0-2-11 起它接的是真数据源**：`source` / `expiresAt` 都来自服务端的
            `confirm` 事件（`round.confirm` 就是那个载荷），倒计时读 `expiresAt` 而不是
            前端自己数 120 秒；两个按钮真发 `POST /:id/confirm`（由页面实现）。
            卡片的消失仍是**页面**决定的（答复之后 `clearConfirm()`），不是卡片自己撤销。 */}
        {round?.confirm === null || round?.confirm === undefined ? null : (
          <ConfirmCard
            source={round.confirm.source}
            toolName={round.confirm.toolName}
            inputSummary={round.confirm.inputSummary}
            expiresAt={round.confirm.expiresAt}
            pending={confirmPending}
            onAnswer={onConfirmAnswer}
          />
        )}

        <div className="composer__box" data-composer-state={view.state}>
          <textarea
            rows={1}
            value={draft}
            disabled={!view.canType}
            placeholder={view.placeholder}
            aria-label="输入消息"
            data-testid="composer-input"
            onChange={(event) => {
              onDraftChange(event.target.value)
            }}
            onKeyDown={handleKeyDown}
          />

          {view.primary.action === 'stop' ? (
            // 流式中：按钮变 [停止]（`03` §4.1）。用 `danger` 是因为它会中断一次已经在跑的生成
            <Button
              danger
              // ⚠️ `htmlType="button"` 而不是 `type="button"`：AntD 的 `type` 是**外观变体**
              // （`primary` / `dashed` / `link`…），HTML 的 `type` 才叫 `htmlType`。
              // 写成 `type="button"` 会得到一个"既不是 primary 也不是 default"的告警型按钮，
              // 而且它**仍然会提交表单**（点停止反而又发了一条）
              htmlType="button"
              data-testid="composer-primary"
              disabled={view.primary.disabled}
              onClick={onStop}
            >
              {view.primary.label}
            </Button>
          ) : (
            <Button
              type="primary"
              htmlType="submit"
              data-testid="composer-primary"
              disabled={view.primary.disabled}
              loading={view.primary.kind === 'busy'}
            >
              {view.primary.label}
            </Button>
          )}
        </div>

        <div className="composer__hint">
          <span>
            <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          </span>
          {/* 提示文案与按钮同源（`composerState.ts` 的 TEXT）：不会出现"按钮说停止、提示说发送" */}
          <span data-testid="composer-hint">{view.hint}</span>
          {/* 状态名（端测/截图时的可读锚点）。⚠️ 用 `data-composer-led` 而不是复用 `.led--run`
              那套类：那几个类只设 `background`，加在一段**文字**上会把文字底色涂成色块 */}
          <span
            className="composer__state num"
            data-composer-led={view.led}
            data-testid="composer-state"
          >
            state: {view.label}
          </span>
        </div>
      </div>
    </form>
  )
}
