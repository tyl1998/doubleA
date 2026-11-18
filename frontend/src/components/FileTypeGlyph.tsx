/**
 * 文件类型图标（Code 模式文件树 / 标签条 / Skills 文件树共用）。
 *
 * 判据在 `workspaceModel#fileIconKind`（纯函数，可单测）；这里只负责"大类 → 图标 + 配色"。
 * 两个入口共用同一份映射，避免 Code 模式与 Skills 树对同一种扩展名给出不同图标。
 */

import {
  CodeOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'

import { fileIconKind, type WorkspaceFileIconKind } from '../features/chat/workspaceModel.js'

const FILE_ICON_COLORS: Record<WorkspaceFileIconKind, string> = {
  typescript: '#3178c6',
  javascript: '#b8860b',
  json: '#8a5a00',
  markdown: '#3f6ea5',
  html: '#c04a20',
  css: '#6a4bbb',
  python: '#3572a5',
  image: '#1f6f4a',
  shell: '#4a5568',
  yaml: '#8a5a00',
  text: '#666a73',
}

const FILE_ICON_NODES: Record<WorkspaceFileIconKind, ReactNode> = {
  typescript: <CodeOutlined />,
  javascript: <CodeOutlined />,
  json: <CodeOutlined />,
  markdown: <FileMarkdownOutlined />,
  html: <CodeOutlined />,
  css: <CodeOutlined />,
  python: <CodeOutlined />,
  image: <FileImageOutlined />,
  shell: <CodeOutlined />,
  yaml: <FileOutlined />,
  text: <FileOutlined />,
}

export function FileTypeGlyph({ path }: { path: string }) {
  const kind = fileIconKind(path)
  return (
    <span className="file-glyph" style={{ color: FILE_ICON_COLORS[kind] }}>
      {FILE_ICON_NODES[kind]}
    </span>
  )
}