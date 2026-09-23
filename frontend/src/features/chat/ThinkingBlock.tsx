/**
 * 思考块（P0-1-32；`docs/03` §4.1 消息流渲染规则表第 3 行）
 *
 * 规则原文："灰底可折叠块，**流式时默认展开**；**完成后自动折叠**"。
 * 这两句话合起来要求**受控的开合状态**，而原型的 `<details>` 是浏览器自己管的（不受控）
 * ⇒ 必须显式处理，否则遇到两种都不像 bug 的症状：
 *   · 完成后不折叠（内容一直摊在消息流里，长回答时把正文挤到屏幕外）；
 *   · 用户手动折叠后，下一帧 delta 又把它顶开（用户的操作被流式更新覆盖）。
 *
 * 落法（见 {@link ThinkingBlock}）：`open = 用户是否手动碰过 ? 用户的选择 : 是否在流式中`。
 * 用户一旦碰过，**以用户为准**（不再被流式状态牵着走）。
 *
 * ⚠️ 用 `<summary onClick={preventDefault}>` 而不是 `onToggle`：`onToggle` 在**程序化**
 * 改变 `open` 时也会触发（React 把 `open` 设回 false 时会再收到一次 toggle），
 * 于是"自动折叠"会被误记成"用户想折叠"。`preventDefault()` 恰好只挡原生点击切换、
 * 不挡 React 的 prop 更新 —— 语义正好。
 */

import { useState } from 'react'

export interface ThinkingBlockProps {
  /** 思考过程全文（累积的 `thinking` 增量） */
  text: string
  /** 是否仍在流式生成（决定"默认展开"这一半） */
  streaming: boolean
}

/** 显示的字数（用码点算，别用 `.length` —— emoji/中文混排时 UTF-16 长度会虚高） */
function charCount(text: string): number {
  return [...text].length
}

export function ThinkingBlock({ text, streaming }: ThinkingBlockProps) {
  // `null` = 用户还没碰过（跟随流式状态）；`true/false` = 用户的明确选择，一直生效
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const open = userChoice ?? streaming

  return (
    <details className="think" open={open} data-testid="thinking-block">
      <summary
        className="think__head"
        onClick={(event) => {
          // 阻止原生切换，改由 state 驱动（见文件头 ⚠️）
          event.preventDefault()
          setUserChoice(!open)
        }}
      >
        {/* ⚠️ 原型这里是「思考过程 · 4 步 · 2.1s」，而本仓的 `thinking` 事件只给文本增量
            —— 没有"步数"、也没有分段时刻。**不编造**：只报真实可算的那个数（字数）。 */}
        <span>思考过程 · {charCount(text)} 字{streaming ? ' · 生成中' : ''}</span>
        <span className="think__caret" aria-hidden="true">
          ›
        </span>
      </summary>
      {/* 思考过程刻意**不解析 Markdown**：它往往是模型的原始推理碎片，渲染成 Markdown 反而
          更容易出现"半截列表/半截表格"（流式期间每一帧都可能切断语法结构）。
          用 `white-space: pre-wrap` 保留换行即可。 */}
      <div className="think__body" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </div>
    </details>
  )
}
