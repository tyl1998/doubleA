/**
 * 产物卡（P0-1-32；`docs/03` §4.1 消息流渲染规则表第 6 行："文件名 + 大小 + [预览] [下载]"；
 * **P0-3-11 把两个按钮接上了**）
 *
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-32 → P0-3-11：两个按钮从 disabled 变成能点，这一步**只做了一件事**
 * ─────────────────────────────────────────────────────────────────────
 * P0-1-32 把按钮写成 `disabled` 是刻意的（`03` §六 的同一条纪律："不提供点不通的入口" ——
 * 那时下载端点是 P0-3-9、预览弹层是 P0-3-10，两个都还没落地）。P0-3-11 它们齐了，
 * 于是卡片不必再自己解释"属哪个批次"：
 *   · 「预览」把产物放进 `stores/artifactPreview.ts`（弹层住在 `ChatPage`，见那个文件的说明）；
 *   · 「下载」走 `useArtifactDownload`（**与弹层标题栏那个按钮同一份实现**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 「预览」按钮**不是所有产物都有** —— 判据是 `previewAvailability`
 * ─────────────────────────────────────────────────────────────────────
 * `子方案④` §九 两条验收点写在同一件事上：
 *   · `none` 类型（zip / docx / 未知）⇒ **没有**「预览」按钮；
 *   · 超大产物（> 10 MiB 图片 / > 2 MiB 文本）⇒ **无预览入口**、只有下载。
 * 两句话是同一条规则的两种情形 ⇒ 用的是**同一个**函数（`previewAvailability`，
 * 它内部调 `shared#previewKindOf`）。于是"哪些产物能预览"只有一处判据 ——
 * 弹层那边也用同一个函数（它是最后一道兜底，见 `ArtifactPreviewDrawer` 的文件头）。
 *
 * ⚠️ 刻意**不做成"置灰的预览按钮"**：能力有无是事实，不是"暂不可用"
 * （`03` §4.5 同款口径）。给 zip 一个永远点不开的「预览」，用户会以为是自己用错了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `timeText`：产物面板用它，消息流不用
 * ─────────────────────────────────────────────────────────────────────
 * 产物面板（`design/chat.html` 的 `.artifact__meta`）写的是 `8.4 KB · 刚生成`，而消息流里的
 * 产物卡（`03` §4.1 那一行）只有 `8.4 KB`。两种读数**不是同一个来源**：面板那份来自服务端列表
 * 的 `createdAt`，而流式产物**根本没有 `createdAt`**（`artifact` 事件是现发的）。
 * 故时间读数做成**可选入参**：面板传，消息流不传 —— 而不是在卡片里判"我现在在哪一列"
 * （那会让这张卡知道自己的父亲是谁）。
 *
 * 它同时解释了为什么卡片**不 import `artifactPanelModel.ts`**：那个纯逻辑档是面板的，
 * 卡片只接受一个已经算好的字符串。
 */

import { Button, Checkbox, Popconfirm } from 'antd'
import { memo, useState } from 'react'

import { formatBytes } from '../../app/format.js'
import { useArtifactDownload } from '../../components/ArtifactPreview/useArtifactDownload.js'
import { previewAvailability } from '../../components/ArtifactPreview/artifactPreview.js'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.js'
import type { ArtifactView } from './messageModel.js'

export interface ArtifactCardProps {
  artifact: ArtifactView
  /**
   * 人类可读的"什么时候产出的"（`8.4 KB · 刚生成` 的后半句）。
   * `null` / `undefined` = 这一处不显示时间（消息流：流式产物没有落库时刻）。
   */
  timeText?: string | null
  /**
   * 提供时渲染「删除」按钮（**会话产物页**用；对话页 / 产物面板不传 ⇒ 行为逐字不变）。
   *
   * 删除是**真删除**（对象 + 行），故做成 `Popconfirm` 二次确认；`onDelete` 返回 Promise
   * 时按钮进入 loading 直到它落定 —— 失败由调用方（页面）统一提示。
   */
  onDelete?: () => Promise<void> | void
  /**
   * 提供时在卡片最左侧渲染一个**勾选框**（**会话产物页**用；对话页 / 产物面板不传 ⇒
   * 行为逐字不变）。与 `onDelete` 同一条口径：可选入参，只有会话产物页传。
   *
   * ⚠️ 判据是 `onSelectedChange` 是否提供（不是 `selected`）—— 与 `onDelete` 同款：
   * "能不能选"由调用方决定，卡片自己不认识"批量删除"这件事。
   */
  selected?: boolean
  onSelectedChange?: (checked: boolean) => void
}

/** 卡片左侧的方框里写什么：取扩展名（大写、最多 4 字符），没有扩展名就写 `FILE` */
function kindOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1 || dot === fileName.length - 1) return 'FILE'
  return fileName.slice(dot + 1).toUpperCase().slice(0, 4)
}

/**
 * ⚠️ `memo`（内存优化 P2，`docs/子方案/前端长会话内存优化.md`）：流式期间父组件每帧重渲染，
 * 而历史消息的 `artifact` 引用稳定 ⇒ 整块跳过。
 */
export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  timeText = null,
  onDelete,
  selected = false,
  onSelectedChange,
}: ArtifactCardProps) {
  const openPreview = useArtifactPreviewStore((state) => state.openPreview)
  const { downloading, download } = useArtifactDownload()
  const [deleting, setDeleting] = useState(false)

  // 「这个产物能不能预览」—— 唯一的判据（见文件头）。不可预览时不渲染按钮，
  // 而不是渲染一个置灰的：`none` 与"超大"是两件不同的事，但结论相同（只有下载）。
  const canPreview = previewAvailability(artifact).available

  const meta = timeText === null ? formatBytes(artifact.size) : `${formatBytes(artifact.size)} · ${timeText}`

  return (
    <div className="artifact" data-testid="artifact-card">
      {onSelectedChange ? (
        <Checkbox
          checked={selected}
          onChange={(event) => {
            onSelectedChange(event.target.checked)
          }}
          aria-label={`选择 ${artifact.fileName}`}
        />
      ) : null}
      <span className="artifact__kind" aria-hidden="true">
        {kindOf(artifact.fileName)}
      </span>
      <div className="artifact__body">
        <p className="artifact__name">{artifact.fileName}</p>
        <p className="artifact__meta num">{meta}</p>
      </div>
      <div className="artifact__ops">
        {canPreview ? (
          <Button
            size="small"
            onClick={() => {
              // 只传四个字段之外的原对象：`ArtifactPanelItem` 多带的 `createdAt` / `live`
              // 与弹层无关，但也没必要在这里剥（弹层只读它要的那四个，见 store 的注释）
              openPreview(artifact)
            }}
          >
            预览
          </Button>
        ) : null}
        <Button
          size="small"
          loading={downloading}
          onClick={() => {
            download({ artifactId: artifact.artifactId, fileName: artifact.fileName })
          }}
        >
          下载
        </Button>
        {onDelete ? (
          <Popconfirm
            title="删除这个产物？"
            description="删除后不可恢复：文件与记录都会一并移除。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              setDeleting(true)
              try {
                await onDelete()
              } catch {
                // 删除失败由调用方（页面）统一提示；这里只负责结束 loading，不再往外抛
              } finally {
                setDeleting(false)
              }
            }}
          >
            <Button size="small" danger loading={deleting}>
              删除
            </Button>
          </Popconfirm>
        ) : null}
      </div>
    </div>
  )
})
