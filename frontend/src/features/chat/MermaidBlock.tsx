/**
 * Mermaid 图表块（2026-10-29，用户需求：「返回了流程图，能渲染吗（支持放大缩小原文查看）」）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 接回点
 * ─────────────────────────────────────────────────────────────────────
 * `AssistantMarkdown` 的 `components.code` 是**唯一**的接回点（那个文件头早就写明了）。
 * 围栏语言是 `mermaid` 时，把默认的 `<pre><code>` 换成这里；其余语言**逐字不变**。
 * 产物预览的 MD（`MarkdownPreview`）走同一个 `AssistantMarkdown` ⇒ 同时受益。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **按需加载**：`mermaid` 约 25MB 未压缩、gzip 后数百 KB ⇒ 只在**真的出现 mermaid 围栏**时
 *    才 `import()`，不进口包、不拖首屏（`vite` 自动切成独立 chunk）。
 * ② **`securityLevel: 'strict'`**：图表源码来自模型输出（外部输入）。strict 关掉 HTML 标签、
 *    点击回调等能力，且渲染结果是**取回的 SVG 字符串**再插进 DOM —— 这里用 `img src=data:`
 *    之外的第三种做法时有风险，故配合下面的「只接受无 `<script>` / 无 `on*` 的 SVG」兜底。
 * ③ **失败不空白**：解析失败时**回落到源码**并给一句说明（mermaid 语法写错很常见，
 *    这时用户最想看的就是原文）。
 *
 * ⚠️ **流式期间不渲染**：`streaming` 时围栏内容每帧都在变，每次都跑一遍 mermaid 会让长回答
 *   卡死（且图表多半是半截语法）。流式直接显示源码，结束（`streaming = false`）再渲染。
 */

import {
  CopyOutlined,
  DownloadOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { App, Segmented, Spin, Tooltip } from 'antd'
import { useEffect, useState } from 'react'

import { useT } from '../../app/i18n.js'

/** 缩放档位（按钮±25%，范围 25%~400%） */
const MIN_SCALE = 0.25
const MAX_SCALE = 4
const SCALE_STEP = 0.25

/** 同一时间只渲染一张：`mermaid.render` 内部本就串行，这里再排一次队只为拿到唯一 id */
let renderSeq = 0

/** 极简的 SVG 安全闸：模型输出进的 SVG 里不允许出现脚本或事件属性。
 *
 * mermaid 的 `securityLevel: 'strict'` 已经挡了绝大部分（它自己会清理 label 里的 HTML），
 * 但这一层是**我们的判据**（不依赖上游实现的版本行为）：命中就直接回落到源码。
 * 注：`<foreignObject>` 里的 `onclick` 也算命中（正则不区分大小写）。
 */
function svgLooksSafe(svg: string): boolean {
  if (/<script[\s>]/i.test(svg)) return false
  if (/\son[a-z]+\s*=/i.test(svg)) return false
  if (/<iframe[\s>]/i.test(svg)) return false
  return true
}

/** `mermaid` 的默认导出（`dist/mermaid.d.ts` 的 `Mermaid` 接口，这里只用到三个方法） */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
  parse: (text: string) => Promise<unknown>
}

let modulePromise: Promise<MermaidApi> | null = null
/** 是否已按当前主题初始化过（主题切换要重新 initialize 才能换配色） */
let initializedFor: string | null = null

/** 懒加载 + 按主题初始化（同一主题只初始化一次） */
async function loadMermaid(theme: 'default' | 'dark'): Promise<MermaidApi> {
  modulePromise ??= import('mermaid').then((mod) => mod.default)
  const mermaid = await modulePromise
  if (initializedFor !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // 外部输入：关掉会执行脚本 / 触发回调的能力
      securityLevel: 'strict',
      theme,
      fontFamily: 'var(--font-body)',
      // 不计时、不报时（Gantt 之类会带「今天」标记，不想要它随时间漂移的渲染）
      deterministicIds: true,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
    })
    initializedFor = theme
  }
  return mermaid
}

/** 主题（跟随 `[data-theme]`，与 `stores/ui.ts` 的口径一致；无标记时按浅色） */
function currentMermaidTheme(): 'default' | 'dark' {
  if (typeof document === 'undefined') return 'default'
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'default'
}

export interface MermaidBlockProps {
  /** 围栏里的图表源码（原样，不做 trim 以外的处理） */
  source: string
  /** 仍在流式生成：只显示源码，不渲染（见文件头 ③ 的说明） */
  streaming: boolean
}

/**
 * 一块 Mermaid 图表：工具栏（缩放 / 重置 / 复制 / 下载）+ 画布 +「图表 / 原文」切换。
 *
 * 「原文」不是可编辑的 —— 这里是**阅读**界面；要改就复制出去。
 */
export function MermaidBlock({ source, streaming }: MermaidBlockProps): React.JSX.Element {
  const { t } = useT()
  const { message } = App.useApp()
  const [view, setView] = useState<'chart' | 'source'>('chart')
  const [scale, setScale] = useState(1)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 手动重试计数：解析失败后点「重试」= 改这个值触发重新渲染 */
  const [attempt, setAttempt] = useState(0)
  /**
   * 渲染。
   *
   * ⚠️ 依赖里**不能有 `scale`** —— 缩放只是 CSS 变换，重渲染一次就白跑一次 mermaid。
   * ⚠️ `cancelled` 只拦 setState：mermaid 的渲染本身是同步排队的，拦不住也没必要拦。
   */
  useEffect(() => {
    if (streaming || source.trim() === '') {
      setSvg(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const mermaid = await loadMermaid(currentMermaidTheme())
        // 先解析：语法错时给的是可读的错误，而不是 render 内部抛出的一坨
        await mermaid.parse(source)
        const id = `mermaid-block-${(renderSeq += 1)}`
        const result = await mermaid.render(id, source)
        if (cancelled) return
        if (!svgLooksSafe(result.svg)) {
          setSvg(null)
          setError(t('assistant.mermaidUnsafe'))
          return
        }
        setSvg(result.svg)
      } catch (cause) {
        if (cancelled) return
        setSvg(null)
        // mermaid 的 Error.message 是「Parse error on line N...」，对用户最有用的就是它
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, streaming, attempt, t])

  const showChart = view === 'chart' && !streaming && svg !== null && error === null
  const showSourceArea = streaming || view === 'source' || svg === null || error !== null

  const copySource = (): void => {
    void navigator.clipboard
      .writeText(source)
      .then(() => message.success(t('assistant.mermaidCopied')))
      .catch(() => message.error(t('assistant.mermaidCopyFailed')))
  }

  const download = (): void => {
    if (svg === null) return
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `mermaid-${Date.now()}.svg`
    link.click()
    // 立刻 revoke 会让部分浏览器来不及下载 ⇒ 下一拍再收
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <figure className="mermaid-block" data-testid="assistant-mermaid">
      <div className="mermaid-block__bar">
        <span className="mermaid-block__label">{t('assistant.mermaidTitle')}</span>
        <Segmented
          size="small"
          value={view}
          onChange={(next) => setView(next as 'chart' | 'source')}
          options={[
            { label: t('assistant.mermaidChart'), value: 'chart' },
            { label: t('assistant.mermaidSource'), value: 'source' },
          ]}
        />
        <span className="mermaid-block__ops">
          {showChart ? (
            <>
              <Tooltip title={t('assistant.mermaidZoomOut')}>
                <button
                  type="button"
                  className="ws__icon-btn"
                  disabled={scale <= MIN_SCALE}
                  onClick={() => setScale((value) => Math.max(MIN_SCALE, +(value - SCALE_STEP).toFixed(2)))}
                  aria-label={t('assistant.mermaidZoomOut')}
                >
                  <MinusOutlined />
                </button>
              </Tooltip>
              <span className="mermaid-block__scale" data-testid="mermaid-scale">
                {Math.round(scale * 100)}%
              </span>
              <Tooltip title={t('assistant.mermaidZoomIn')}>
                <button
                  type="button"
                  className="ws__icon-btn"
                  disabled={scale >= MAX_SCALE}
                  onClick={() => setScale((value) => Math.min(MAX_SCALE, +(value + SCALE_STEP).toFixed(2)))}
                  aria-label={t('assistant.mermaidZoomIn')}
                >
                  <PlusOutlined />
                </button>
              </Tooltip>
              <Tooltip title={t('assistant.mermaidReset')}>
                <button
                  type="button"
                  className="ws__icon-btn"
                  onClick={() => setScale(1)}
                  aria-label={t('assistant.mermaidReset')}
                >
                  <ReloadOutlined />
                </button>
              </Tooltip>
              <Tooltip title={t('assistant.mermaidDownload')}>
                <button
                  type="button"
                  className="ws__icon-btn"
                  onClick={download}
                  aria-label={t('assistant.mermaidDownload')}
                >
                  <DownloadOutlined />
                </button>
              </Tooltip>
            </>
          ) : null}
          <Tooltip title={t('assistant.mermaidCopySource')}>
            <button
              type="button"
              className="ws__icon-btn"
              onClick={copySource}
              aria-label={t('assistant.mermaidCopySource')}
            >
              <CopyOutlined />
            </button>
          </Tooltip>
        </span>
      </div>

      {loading ? (
        <div className="mermaid-block__loading">
          <Spin size="small" />
        </div>
      ) : null}

      {/*
        图表区：SVG 用 `dangerouslySetInnerHTML` 插入 —— 已经过 `securityLevel: 'strict'`
        与 `svgLooksSafe` 两道检查（见文件头）。缩放用 `transform`，外包一层滚动容器，
        放大后可以直接拖动滚动条看局部。
      */}
      {showChart ? (
        <div className="mermaid-block__canvas" data-testid="mermaid-canvas">
          <div
            className="mermaid-block__stage"
            style={{ transform: `scale(${scale})` }}
            dangerouslySetInnerHTML={{ __html: svg ?? '' }}
          />
        </div>
      ) : null}

      {showSourceArea ? (
        <pre className="mermaid-block__source">
          <code>{source}</code>
        </pre>
      ) : null}

      {error !== null ? (
        <div className="mermaid-block__error" data-testid="mermaid-error">
          <span>{t('assistant.mermaidFailed', { detail: error })}</span>
          <button
            type="button"
            className="ws__icon-btn"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('assistant.mermaidRetry')}
          </button>
        </div>
      ) : null}
    </figure>
  )
}
