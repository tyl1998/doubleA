/**
 * 围栏代码块（2026-10-30，用户需求：「聊天窗口渲染的代码块现在可以复制吗」⇒ 加一个块级复制按钮）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么包在 `pre` 上
 * ─────────────────────────────────────────────────────────────────────
 * `react-markdown` 渲染围栏时给的是 `<pre><code class="language-x">`。复制按钮必须**贴在块上**
 * （每条回答末尾的「复制全文」是整条回答，含 Markdown 标记，不是用户要的那一段）。
 * 唯一带「这一块」语义的节点是 `pre` ⇒ 覆盖 `components.pre`，按钮挂在它右上角。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **复制纯文本**：直接从渲染后的 `<pre>` DOM 上取 `textContent`（而不是从 React children
 *    重建字符串）—— 那才是用户看到的东西，缩进 / 空行与代码块逐字一致。
 *    ⚠️ 必须从 DOM 取：`children` 是一棵 React 元素树，`String(children)` 会得到 `[object Object]`。
 * ② **失败不静默**：`navigator.clipboard` 需要安全上下文；失败时给一句说明
 *    （与 `AssistantMessage` 的「复制全文」同一口径）。
 * ③ **Mermaid 块不套这一层**：`MermaidBlock` 自带「复制源码」，再包一层会出两个复制按钮。
 *    判据是子节点里有没有 `.mermaid-block`，在 effect 里查（首帧就能定下来）。
 */

import { CopyOutlined } from '@ant-design/icons'
import { App, Tooltip } from 'antd'
import { useEffect, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'

import { useT } from '../../app/i18n.js'

/** 按钮显示「已复制」的时长（毫秒） */
const COPIED_FEEDBACK_MS = 1200

/** `react-markdown` 给覆盖件的 props（`ExtraProps` 带 `node`，其余是原生 `<pre>` 的属性） */
type PreProps = React.ClassAttributes<HTMLPreElement> &
  React.HTMLAttributes<HTMLPreElement> &
  ExtraProps

/**
 * 围栏代码块的壳：`<div class="md__codeblock"><pre>…</pre><button>复制</button></div>`。
 *
 * ⚠️ 按钮**包在 `pre` 外面**而不是塞进 `pre` 里：`pre` 是滚动容器（`overflow-x: auto`），
 * 绝对定位的子元素会跟着内容一起滚走；包一层相对定位的壳后，按钮钉在可视区右上角。
 */
export function CodeBlock({ children, node: _node, ...rest }: PreProps): React.JSX.Element {
  const { t } = useT()
  const { message } = App.useApp()
  const [copied, setCopied] = useState(false)
  /** 是否为 Mermaid 块（自带复制入口 ⇒ 这里不再出按钮） */
  const [isMermaid, setIsMermaid] = useState(false)
  const preRef = useRef<HTMLPreElement | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    setIsMermaid(preRef.current?.querySelector('.mermaid-block') !== null)
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const copy = (): void => {
    const text = preRef.current?.textContent ?? ''
    if (text === '') return
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
        return undefined
      })
      .catch(() => {
        // 失败不静默（与「复制全文」同口径）
        message.error(t('assistant.codeCopyFailed'))
      })
  }

  return (
    <div className="md__codeblock">
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
      {isMermaid ? null : (
        <Tooltip title={t('assistant.codeCopy')}>
          <button
            type="button"
            className={`md__codecopy${copied ? ' is-copied' : ''}`}
            onClick={copy}
            aria-label={t('assistant.codeCopy')}
            data-testid="code-copy"
          >
            <CopyOutlined />
            <span>{copied ? t('assistant.codeCopied') : t('assistant.codeCopy')}</span>
          </button>
        </Tooltip>
      )}
    </div>
  )
}
