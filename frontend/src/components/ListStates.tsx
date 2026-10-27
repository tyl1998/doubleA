/**
 * 列表三态的统一实现（P0-1-31）
 *
 * 依据：`docs/03-前端设计.md` §七「列表三态」——**空态带引导按钮 / 加载骨架屏 / 错误带重试**。
 * `03` §六 把「空态」列进了 `components/` 通用组件的职责里，理由很实际：这三态会在
 * 智能体（P0-1-31）、知识库（P0-1-35）、用户与模型池（P0-1-36）四类列表上各出现一次；
 * 各写一遍的后果不是"多写几行"，而是**四处的重试入口/文案各不一样**（`docs/06` §六
 * 那条"同一口径在两处各写一遍，必有一处先腐烂"）。
 *
 * 样式复用 `styles/app.css` 里已有的 `.empty` / `.skeleton` / `.skel-line*`（P0-1-30 落地），
 * 本批**不新增**三态的自有样式 —— 它们已经够用，另起一套只会让"三态长什么样"有两个真相。
 */

import { Alert, Button } from 'antd'
import type { ReactNode } from 'react'

import { describeError } from '../api/client.js'
import { useT } from '../app/i18n.js'

export interface EmptyStateProps {
  title: string
  lead: ReactNode
  /** 引导动作（`03` §七 要求空态**必须**带引导按钮，不能只说"没有数据"） */
  action?: ReactNode
}

/** 空态：图纸上的"未标注框" + 一句能照着做的话 + 一个按钮 */
export function EmptyState({ title, lead, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__frame" aria-hidden="true" />
      <p className="empty__title">{title}</p>
      <p className="empty__lead">{lead}</p>
      {action}
    </div>
  )
}

export interface TableSkeletonProps {
  rows?: number
}

/**
 * 表格加载骨架：**保留真实列宽的行高比例**（`design/agents.html` 的加载态注释），
 * 避免数据到位那一刻表格"跳一下"。
 */
export function TableSkeleton({ rows = 5 }: TableSkeletonProps) {
  return (
    <div className="card card--pad" aria-busy="true" aria-live="polite">
      <div className="skeleton">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div className="row" key={rowIndex} style={{ gap: 'var(--sp-4)' }}>
            <span className="skel-line skel-line--w40" />
            <span className="skel-line skel-line--w55" />
            <span className="skel-line skel-line--w70" />
          </div>
        ))}
      </div>
    </div>
  )
}

export interface ErrorStateProps {
  title: string
  error: unknown
  onRetry: () => void
  retrying?: boolean
}

/**
 * 错误态：**给错误码与重试，不给"出错了"三个字**（原型那条注释）。
 *
 * 文案来自 `describeError`（= 服务端已写好的中文 + 错误码），本组件**不自己拼错误文案**
 * —— `03` §六 把"错误码 → 文案"的映射定在 `api/client.ts` 一处，页面级组件再拼一遍
 * 就是第二份会腐烂的口径。
 *
 * 用 AntD `Alert` 而不是自写 `.alert`：`docs/06` P0-1-30 已定案「AntD 已有的样式不重写」
 * （`.alert` / `.btn` / `.input` 交给 AntD + token），而 `styles/app.css` 里**没有** `.alert`
 * 的定义 —— 照原型类名写会得到一个**完全没有样式**的 div。
 *
 * ⚠️ **不显示 request-id**：原型上有一行 `request-id 8f31c2a0`，但本仓客户端没有把这个响应头
 * 读出来 —— 编一个 id 上去比不显示更糟。
 */
export function ErrorState({ title, error, onRetry, retrying = false }: ErrorStateProps) {
  const { t } = useT()
  const { code, message } = describeError(error)
  return (
    <div className="card card--pad">
      <Alert
        type="error"
        showIcon
        message={title}
        description={`${code} · ${message}`}
        action={
          <Button onClick={onRetry} loading={retrying}>
            {t('common.retry')}
          </Button>
        }
      />
    </div>
  )
}
