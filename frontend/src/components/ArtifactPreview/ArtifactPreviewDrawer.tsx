/**
 * 产物预览弹层（P0-3-10；**P0-3-11 接上进来了**）
 *
 * 形态：AntD `Drawer`（右侧，`width: min(1080px, 92vw)`）+ 标题栏（文件名 + 大小 + 「下载」）。
 * 它只做三件事：**按 `previewKindOf` 选渲染器**、**按体积闸门说清为什么不能预览**、
 * **把"取不到"的两种原因分开显示**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ P0-3-11：接入点已经定在 `ChatPage`（本文件仍然不认识任何入口）
 * ─────────────────────────────────────────────────────────────────────
 * 两个入口（消息流里的产物卡、产物面板里的卡）都只做一件事：把那个产物放进
 * `stores/artifactPreview.ts`；`ChatPage` 订阅它并渲染本弹层。本文件**自己不订阅**
 * 任何 store、也不知道"谁点的我" —— 它是一台只认 `artifact` / `open` / `onClose` 的机器。
 *
 * ⚠️ 「下载」的实现搬去了 `useArtifactDownload`（P0-3-11 起产物卡上也有一个下载按钮，
 * 两处必须同源）。本文件只调它。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 三种"看不到内容"的原因必须分开（`03` §4.6 / `子方案④` §五 4）
 * ─────────────────────────────────────────────────────────────────────
 *   ① **格式不支持**（`previewKindOf` = `none`）⇒ "该格式不支持在线预览"；
 *   ② **体积超限** ⇒ "文件较大（X，超过上限 Y），请下载查看"；
 *   ③ **请求失败 / 不是 UTF-8** ⇒ 明确说"会话可能已过期"或"编码不是 UTF-8"。
 * 合成一句"暂时无法预览"会让用户去做一件治不好的动作（反复刷新）。
 *
 * ⚠️ `!view.available` 那一支在 P0-3-11 之后**从两个入口都到不了**：产物卡的「预览」按钮
 * 用的判据就是同一个 `previewAvailability`（不可预览时**根本不渲染按钮**，
 * `子方案④` §九："`none` ⇒ 没有「预览」按钮"、"超大产物 ⇒ 无预览入口、只有下载"）。
 * 它留在这里是**刻意的**：本文件是一台独立的机器，入口契约只保证"调用方会传一个产物"，
 * 真传进来一个不可预览的（例如将来多出来的第三种入口忘了判），这里得**说得出为什么**，
 * 而不是渲染一片空白。所以它不是死代码，是**最后一道兜底**。
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Alert, Button, Drawer, Skeleton } from 'antd'

import type { ArtifactItem } from '@doubulea/shared'

import { fetchArtifactText } from '../../api/artifacts.js'
import { describeError } from '../../api/client.js'
import { CsvPreview } from './CsvPreview.js'
import { HtmlPreview } from './HtmlPreview.js'
import { ImagePreview } from './ImagePreview.js'
import { MarkdownPreview } from './MarkdownPreview.js'
import { PdfPreview } from './PdfPreview.js'
import { TextPreview } from './TextPreview.js'
import { useArtifactDownload } from './useArtifactDownload.js'
import {
  csvDelimiterOf,
  formatBytes,
  previewAvailability,
  type PreviewAvailability,
} from './artifactPreview.js'

/** 文本类（`text`）那一路的取数状态 —— 图片 / PDF / HTML 是浏览器自己取，不进这里 */
type TextState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; text: string }
  /** 不是 UTF-8（`子方案④` §五 5）：**明确提示**而不是满屏 `�` */
  | { phase: 'not-utf8' }
  | { phase: 'error'; message: string }

export interface ArtifactPreviewDrawerProps {
  /** 要预览的产物；`null` = 没有在预览（弹层 `open` 由调用方控） */
  artifact: ArtifactItem | null
  open: boolean
  onClose: () => void
}

export function ArtifactPreviewDrawer({ artifact, open, onClose }: ArtifactPreviewDrawerProps) {
  // 下载的实现只有一处（`useArtifactDownload`）：产物卡上的那个按钮走的是同一个 hook
  // —— P0-3-11 起「下载」有了第二个入口，两处的文案与禁用判据必须同源
  const { downloading, download } = useArtifactDownload()
  const [text, setText] = useState<TextState>({ phase: 'idle' })

  const artifactId = artifact?.artifactId ?? ''
  const fileName = artifact?.fileName ?? ''
  const size = artifact?.size ?? 0
  const mime = artifact?.mime ?? ''
  const view: PreviewAvailability | null = artifact === null ? null : previewAvailability(artifact)
  const delimiter = csvDelimiterOf(mime)

  // ⚠️ 依赖用**原始值**而不是 `artifact` 对象：调用方可能每次渲染都新建一个对象字面量，
  //    那样这个 effect 会每次重跑（预览区一直闪 loading）。
  useEffect(() => {
    if (!open || artifactId === '' || view === null || !view.available || view.kind !== 'text') {
      setText({ phase: 'idle' })
      return
    }
    const controller = new AbortController()
    setText({ phase: 'loading' })
    void (async () => {
      try {
        const loaded = await fetchArtifactText(artifactId, { signal: controller.signal })
        setText(loaded === null ? { phase: 'not-utf8' } : { phase: 'ready', text: loaded })
      } catch (error) {
        // 关弹层 / 切产物引发的 abort 不是错误：**不写状态**（写了会盖掉新一轮的 loading）
        if (controller.signal.aborted) return
        setText({ phase: 'error', message: describeError(error).message })
      }
    })()
    return () => controller.abort()
  }, [open, artifactId, view?.available, view?.kind])

  /** 渲染器分派：**只有这一处**（`子方案④` §五 1：判据是 `previewKindOf`，不看扩展名） */
  function body(): ReactElement | null {
    if (view === null || !view.available) return null

    switch (view.kind) {
      case 'html':
        return <HtmlPreview artifactId={artifactId} fileName={fileName} />
      case 'image':
        return <ImagePreview artifactId={artifactId} fileName={fileName} />
      case 'pdf':
        return <PdfPreview artifactId={artifactId} fileName={fileName} />
      case 'text':
        break
      default:
        return null
    }

    // `text` 一路：MD / CSV·TSV / 其余（plain、json）—— 三种形态，见 TextPreview 文件头
    if (text.phase === 'loading') return <Skeleton active paragraph={{ rows: 12 }} />
    if (text.phase === 'not-utf8') {
      return (
        <Alert
          type="warning"
          showIcon
          message="这个文件的编码不是 UTF-8"
          description="预览只支持 UTF-8（宽松解码会得到满屏问号，那比报错更糟）。请点「下载」后用本地工具打开。"
        />
      )
    }
    if (text.phase === 'error') {
      return <Alert type="error" showIcon message="没能取到文件内容" description={text.message} />
    }
    if (text.phase !== 'ready') return null

    if (delimiter !== null) return <CsvPreview text={text.text} delimiter={delimiter} />
    if (mime.startsWith('text/markdown')) return <MarkdownPreview text={text.text} />
    return <TextPreview text={text.text} />
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(1080px, 92vw)"
      title={fileName === '' ? '产物预览' : fileName}
      extra={
        <Button
          size="small"
          loading={downloading}
          disabled={artifact === null}
          onClick={() => {
            if (artifact !== null) download({ artifactId: artifact.artifactId, fileName: artifact.fileName })
          }}
        >
          下载
        </Button>
      }
    >
      {artifact !== null && view !== null && (
        <div className="stack">
          <p className="ratio">
            {formatBytes(size)} · {mime === '' ? '未知类型' : mime}
          </p>

          {!view.available && (
            <Alert
              type="info"
              showIcon
              // 两种原因的文案**刻意不同**：一个是"这个格式没有预览"，一个是"这份太大"
              message={view.kind === 'none' ? '该格式不支持在线预览' : '文件较大，未在线预览'}
              description={`${view.reason ?? ''}。「下载」拿到的始终是没有改过字节的原文件。`}
            />
          )}

          {body()}
        </div>
      )}
    </Drawer>
  )
}
