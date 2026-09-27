/**
 * 产物预览弹层（P0-3-10；`子方案④` §七 1 + `03` §4.6）
 *
 * 形态：AntD `Drawer`（右侧，`width: min(1080px, 92vw)`）+ 标题栏（文件名 + 大小 + 「下载」）。
 * 它只做三件事：**按 `previewKindOf` 选渲染器**、**按体积闸门说清为什么不能预览**、
 * **把"取不到"的两种原因分开显示**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本批的**接入点不在本文件**：谁把 `artifactId` 交给它属 **P0-3-11**
 * ─────────────────────────────────────────────────────────────────────
 * （产物面板与对话页里的「预览」按钮）。本批落地的是"预览能力"本身 —— 弹层、五个渲染器、
 * 纯逻辑档，以及后端那条端点。`ArtifactCard` 上的按钮仍是 P0-1-32 留下的 disabled 形态，
 * **刻意不动**（动它就是替 P0-3-11 定接入形态）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 三种"看不到内容"的原因必须分开（`03` §4.6 / `子方案④` §五 4）
 * ─────────────────────────────────────────────────────────────────────
 *   ① **格式不支持**（`previewKindOf` = `none`）⇒ "该格式不支持在线预览"；
 *   ② **体积超限** ⇒ "文件较大（X，超过上限 Y），请下载查看"；
 *   ③ **请求失败 / 不是 UTF-8** ⇒ 明确说"会话可能已过期"或"编码不是 UTF-8"。
 * 合成一句"暂时无法预览"会让用户去做一件治不好的动作（反复刷新）。
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Alert, Button, Drawer, Skeleton } from 'antd'

import type { ArtifactItem } from '@doubulea/shared'

import { fetchArtifactText, saveArtifactFile } from '../../api/artifacts.js'
import { describeError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { CsvPreview } from './CsvPreview.js'
import { HtmlPreview } from './HtmlPreview.js'
import { ImagePreview } from './ImagePreview.js'
import { MarkdownPreview } from './MarkdownPreview.js'
import { PdfPreview } from './PdfPreview.js'
import { TextPreview } from './TextPreview.js'
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
  const feedback = useFeedback()
  const [downloading, setDownloading] = useState(false)
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

  async function download(): Promise<void> {
    if (artifact === null) return
    setDownloading(true)
    try {
      await saveArtifactFile({ artifactId: artifact.artifactId, fileName: artifact.fileName })
      feedback.ok('已开始下载')
    } catch (error) {
      feedback.fail(error, '下载失败')
    } finally {
      setDownloading(false)
    }
  }

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
        <Button size="small" loading={downloading} disabled={artifact === null} onClick={() => void download()}>
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
