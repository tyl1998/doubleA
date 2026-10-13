/**
 * 输入区（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §4.1 的版式（`[📎] [输入框…] [停止/发送]`；📎 附件自 **P1-4** 起渲染 ——
 *      选中即上传拿 `fileId`，发送时随 `attachmentFileIds` 带上，见 `api/files.ts`）
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
import { useEffect, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'

import { CHAT_ATTACHMENT_MAX_COUNT } from '@doubulea/shared'

import { fileContentUrl } from '../../api/files.js'
import { ConfirmCard } from './ConfirmCard.js'
import { composeState, isSubmitKey } from './composerState.js'
import type { AttachmentView } from './messageModel.js'
import type { StreamRound } from './roundReducer.js'

/**
 * 文件选择器的 `accept`（P1-4）。
 *
 * ⚠️ **刻意手写、不从 `MIME_BY_CHAT_ATTACHMENT_EXTENSION` 派生**：那张表里 docx 允许
 * `application/zip`（第三道校验要放行"客户端把 docx 报成 zip"），若拿它拼 accept，选择器就会
 * 把**任意 zip** 也当成可选 —— accept 只用来灰掉明显不支持的（`.exe`/`.xlsx`…），不是白名单本体。
 * 扩展名与 MIME **两种都写**：见使用处的注释（macOS Chrome 光靠扩展名不置灰）。
 */
const ACCEPT_ATTACHMENT = [
  '.pdf',
  '.docx',
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  'application/pdf',
  'application/json',
  'text/csv',
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
].join(',')

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
  /** 本轮已上传好的附件（P1-4；`fileId` + 展示信息） */
  attachments: readonly AttachmentView[]
  /** 有附件正在上传（此时发送按钮禁用，避免"附件还没传完就发出去"） */
  uploading: boolean
  /** 选中文件（页面负责上传与去重） */
  onPickFiles: (files: FileList) => void
  /** 移除一个附件 */
  onRemoveAttachment: (fileId: string) => void
  /**
   * 本会话是否支持**中途插话**（P1-9 · P4 · R1）。判据在页面（沙箱会话 / Code 模式）；
   * 这里只把它交给状态机（`composeState`），**不自己判**。
   */
  steerable: boolean
  /** 点「插话」：把当前草稿插给运行中的 agent（页面负责发请求与清草稿） */
  onSteer: () => void
  /** 插话请求在飞（按钮置 loading，防连点） */
  steerPending: boolean
  /**
   * 输入框下方的一排控件（R4：模型 / 自动审批 / 记忆 / Code 模式 / 专注 / 产物入口）。
   * 由页面（`ConversationSettings`）给，本组件只负责摆到 `.composer__box` 正下方。
   */
  controls?: ReactNode
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
  attachments,
  uploading,
  onPickFiles,
  onRemoveAttachment,
  steerable,
  onSteer,
  steerPending,
  controls,
}: ChatInputProps) {
  const view = composeState({ round, sending, stopping, elsewhere, draft, steerable })

  /**
   * 输入框高度**跟着正文走**（`app.css` 里 `.composer textarea` 的 `min-height`/`max-height`）。
   *
   * ⚠️ 原生 `<textarea>` **不会**因为内容变多而自己长高：`rows={1}` 把它钉在一行，超出部分
   * 只能在框内滚 —— 用户看到的就是"写多了后面的字被挡住"。`max-height`（180px）是**上限**
   * 而不是替代品：超过它才该内滚。所以这里每帧把 `height` 先归零再读 `scrollHeight`（不归零
   * 读到的是当前被撑开的高度，缩不回短内容；清空草稿时也靠这一步回到一行）。
   * `max-height` 仍由 CSS 兜底 ⇒ 这里不必再判上限。
   *
   * ⚠️ **只在 `draft` 变化时重算是不够的**：进入 / 退出「专注工作区」会把对话列压窄 / 放宽
   * （`app.css` 的 `.chat--focus-workspace`），**同样的文字**在新宽度下换行成更多 / 更少行，
   * 而 `draft` 没变 ⇒ 这个 effect 不重跑，textarea 就带着按**旧宽度**算出的高度：
   * 窄了内容溢出、冒出滚动条（用户报的"专注工作区模式下输入框又有滚动条"）。故再挂一个
   * `ResizeObserver`，宽度一变就重算（高度变化不触发重算，避免自激循环）。
   */
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const widthRef = useRef(0)
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea === null) return
    const resize = (): void => {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
    resize()
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      // 只在**宽度**变化时重算：设 `height` 也会触发本回调，宽度不变就跳过（否则反复读 layout）
      if (Math.abs(width - widthRef.current) < 0.5) return
      widthRef.current = width
      resize()
    })
    observer.observe(textarea)
    return () => {
      observer.disconnect()
    }
  }, [draft])

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
    // 有附件没传完 ⇒ 先不发送（与按钮禁用同一条判据，避免"附件没带上就发出去"）
    if (view.canSend && !uploading) onSubmit()
  }

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (view.canSend && !uploading) onSubmit()
      }}
    >
      <div className="composer__inner">
        {/* 已选附件（P1-4）：图片显缩略图、文本类显文件条；上传中不出现（传完才有 fileId） */}
        {attachments.length === 0 ? null : (
          <div className="composer__attachments" data-testid="composer-attachments">
            {attachments.map((item) => (
              <span key={item.fileId} className="attachment-chip" data-attachment-kind={item.kind}>
                {item.kind === 'IMAGE' ? (
                  <img className="attachment-chip__thumb" src={fileContentUrl(item.fileId)} alt={item.name} />
                ) : (
                  <span className="attachment-chip__doc" aria-hidden="true" />
                )}
                <span className="attachment-chip__name" title={item.name}>
                  {item.name}
                </span>
                <button
                  type="button"
                  className="attachment-chip__remove"
                  aria-label={`移除附件 ${item.name}`}
                  onClick={() => onRemoveAttachment(item.fileId)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
          {/* 附件入口（P1-4）：📎 选文件 → 页面负责上传；达到上限 / 不可输入时禁用 */}
          <label
            className="composer__attach"
            title={
              attachments.length >= CHAT_ATTACHMENT_MAX_COUNT
                ? `最多 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件`
                : '添加附件（图片 / PDF / Word / 文本 / JSON / CSV）'
            }
            data-disabled={!view.canType || uploading || attachments.length >= CHAT_ATTACHMENT_MAX_COUNT}
          >
            <span aria-hidden="true">📎</span>
            {/* `accept` 只是选择器初筛；真正的白名单判据在服务端（`detectFormat` + 附件画像），
                改这里不改后端不会放行 —— 与"判据只有一处"同款。
                ⚠️ **扩展名 + MIME 两种都写**：macOS 的 Chrome 光靠扩展名列表**不会把不支持的文件置灰**
                （它只是把选择器默认筛选到这些类型），补上 MIME 才能让原生弹窗把其余文件灰掉。
                这是浏览器/系统行为，不是本仓的判据 —— 因此后端那三道校验仍然必须留着。 */}
            <input
              type="file"
              multiple
              accept={ACCEPT_ATTACHMENT}
              data-testid="composer-file"
              disabled={!view.canType || uploading || attachments.length >= CHAT_ATTACHMENT_MAX_COUNT}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const files = event.target.files
                if (files !== null && files.length > 0) onPickFiles(files)
                // 复位，让同一个文件能被再次选中（否则第二次选它不会触发 change）
                event.target.value = ''
              }}
            />
          </label>

          <textarea
            rows={1}
            ref={textareaRef}
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

          {/* 插话（P1-9 · P4 · R1）：仅沙箱会话 streaming 且草稿非空时出现。
              与主按钮（停止）并列 —— 它**不打断**当前一轮，只是把草稿塞给运行中的 agent
              （服务端投到助手 turn 边界）。是否出现由状态机的 `view.steer` 决定，本组件不判。 */}
          {view.steer.visible ? (
            <Button
              htmlType="button"
              data-testid="composer-steer"
              disabled={view.steer.disabled || steerPending}
              loading={steerPending}
              onClick={onSteer}
            >
              插话
            </Button>
          ) : null}

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
              disabled={view.primary.disabled || uploading}
              loading={view.primary.kind === 'busy' || uploading}
            >
              {uploading ? '附件上传中…' : view.primary.label}
            </Button>
          )}
        </div>

        {/* 输入框下方的会话控件（R4）：模型 / 自动审批 / 记忆 / Code 模式 / 专注 / 产物入口 */}
        {controls === undefined ? null : <div className="composer__controls">{controls}</div>}

        <div className="composer__hint">
          <span>
            <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          </span>
          {/* 提示文案与按钮同源（`composerState.ts` 的 TEXT）：不会出现"按钮说停止、提示说发送"。
              ⚠️ `idle` 的文案（"Enter 发送 · Shift+Enter 换行"）与左边那行键盘约定**逐字相同**
              ⇒ 这一档不渲染它（否则同一句话连出两遍）；只有进入别的状态才用得着。 */}
          {view.state === 'idle' ? null : <span data-testid="composer-hint">{view.hint}</span>}
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
