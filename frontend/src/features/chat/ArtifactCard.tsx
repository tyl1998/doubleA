/**
 * 产物卡（P0-1-32；`docs/03` §4.1 消息流渲染规则表第 6 行："文件名 + 大小 + [预览] [下载]"）
 *
 * ⚠️ **P0 阶段流里不会出现 `artifact`**：产物的产生方是 TaskAgent 的沙箱执行，属 **P0-3**；
 * 文件预览（`03` §4.6 的六种格式）属 **子方案④**，下载端点也还没落地。
 * 事件形状已经定义（`sseArtifactPayloadSchema`），故卡片先就位、**没有数据源**。
 *
 * ⚠️ **预览与下载按钮刻意是 disabled**：这是 P0-1-31 定下的同一条纪律 ——
 * 「**不提供点不通的入口**」（那一批是"UI 上不提供 MCP 勾选"，因为后端明确拒绝）。
 * 摆一个能点但只会 404 或弹一句"暂不可用"的按钮，比没有按钮更糟：
 * 用户会以为是自己用错了。按钮保留是为了让**卡片的形态**（`03` §4.1 的那一行）
 * 现在就能被看到与验收，`title` 里如实写明"属哪个批次"。
 */

import { Button } from 'antd'

import type { ArtifactView } from './messageModel.js'

export interface ArtifactCardProps {
  artifact: ArtifactView
}

/** 文件大小（`artifact.size` 是字节数）—— 人类可读，1 位小数 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 卡片左侧的方框里写什么：取扩展名（大写、最多 4 字符），没有扩展名就写 `FILE` */
function kindOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1 || dot === fileName.length - 1) return 'FILE'
  return fileName.slice(dot + 1).toUpperCase().slice(0, 4)
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  return (
    <div className="artifact" data-testid="artifact-card">
      <span className="artifact__kind" aria-hidden="true">
        {kindOf(artifact.fileName)}
      </span>
      <div>
        <p className="artifact__name">{artifact.fileName}</p>
        <p className="artifact__meta num">{formatSize(artifact.size)}</p>
      </div>
      <div className="artifact__ops">
        <Button size="small" disabled title="产物预览属 P0-3（与沙箱执行一起交付）">
          预览
        </Button>
        <Button size="small" disabled title="产物下载属 P0-3（下载端点尚未落地）">
          下载
        </Button>
      </div>
    </div>
  )
}
