/**
 * Skill 文件树（`/skills/:id` 左栏）。
 *
 * 为什么不再平铺：真实 Skill 包会有 `scripts/`、`references/`、`assets/` 多层目录，
 * 平铺会把"哪个是脚本、哪个在哪个目录"全部抹掉。这里按目录折叠展示，并对**跨目录**的
 * 可执行文件（如根目录 `vision.js`）打「脚本」标记。
 *
 * 2026-11-17（用户定案）：视觉与 Code 模式文件树保持一致 —— 复用 `.ws__tree-*` 行样式
 * （chevron / 文件夹开合图标 / 行高亮 / 固定行高缩进）与 `FileTypeGlyph` 的扩展名图标。
 * 但这里是**只读浏览**：不提供工作区那些右键菜单 / 拖拽移动 / 新建删除 / 上传动作。
 */

import {
  DownOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Input, Tag } from 'antd'
import { useMemo, useState } from 'react'
import type { SkillFileEntry } from '@doubulea/shared'
import { isLikelyScriptPath } from '@doubulea/shared'

import { useT } from '../../app/i18n.js'
import { formatBytes } from '../../app/format.js'
import { FileTypeGlyph } from '../../components/FileTypeGlyph.js'

interface DirNode {
  type: 'dir'
  name: string
  path: string
  children: TreeNode[]
  fileCount: number
  scriptCount: number
}

interface FileNode {
  type: 'file'
  name: string
  path: string
  file: SkillFileEntry
}

type TreeNode = DirNode | FileNode

/** 每一层目录的缩进（px），与 Code 模式文件树的 `TREE_INDENT` 同值 */
const TREE_INDENT = 12

function buildTree(files: readonly SkillFileEntry[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [], fileCount: 0, scriptCount: 0 }
  for (const file of files) {
    const segments = file.path.split('/')
    let current = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] ?? ''
      const path = current.path === '' ? name : `${current.path}/${name}`
      let next = current.children.find((node): node is DirNode => node.type === 'dir' && node.path === path)
      if (next === undefined) {
        next = { type: 'dir', name, path, children: [], fileCount: 0, scriptCount: 0 }
        current.children.push(next)
      }
      current = next
    }
    const name = segments.at(-1) ?? file.path
    current.children.push({ type: 'file', name, path: file.path, file })
  }

  function finalize(dir: DirNode): void {
    for (const child of dir.children) if (child.type === 'dir') finalize(child)
    dir.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    dir.fileCount = dir.children.reduce(
      (sum, child) => sum + (child.type === 'file' ? 1 : child.fileCount),
      0,
    )
    dir.scriptCount = dir.children.reduce(
      (sum, child) =>
        sum + (child.type === 'file' ? (isLikelyScriptPath(child.path) ? 1 : 0) : child.scriptCount),
      0,
    )
  }
  finalize(root)
  return root.children
}

function filterTree(nodes: readonly TreeNode[], keyword: string): TreeNode[] {
  const q = keyword.trim().toLowerCase()
  if (q === '') return [...nodes]
  const kept: TreeNode[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.path.toLowerCase().includes(q)) kept.push(node)
      continue
    }
    const children = filterTree(node.children, keyword)
    if (children.length > 0) kept.push({ ...node, children })
  }
  return kept
}

interface TreeRow {
  node: TreeNode
  depth: number
}

/** 按"展开 / 折叠"把树压成线性行（与 Code 模式的 `flattenWorkspaceTree` 同口径；本页文件少，不做虚拟滚动） */
function flattenTree(nodes: readonly TreeNode[], isCollapsed: (path: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: readonly TreeNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth })
      if (node.type === 'dir' && !isCollapsed(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return rows
}

export function SkillFileTree({
  files,
  selectedPath,
  onSelect,
  statusOf,
}: {
  files: readonly SkillFileEntry[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /**
   * 审核场景的改动标记（`ADDED` / `MODIFIED`）。详情页不传 ⇒ 不渲染任何标记，
   * 与旧行为逐字一致。
   */
  statusOf?: (path: string) => 'ADDED' | 'MODIFIED' | null
}) {
  const { t } = useT()
  const [keyword, setKeyword] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildTree(files), [files])
  const visible = useMemo(() => filterTree(tree, keyword), [tree, keyword])
  const searching = keyword.trim() !== ''
  const rows = useMemo(
    () => flattenTree(visible, (path) => !searching && collapsed.has(path)),
    [visible, collapsed, searching],
  )

  function toggle(path: string): void {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="stack stack--tight">
      <Input
        allowClear
        value={keyword}
        prefix={<SearchOutlined />}
        placeholder={t('skillDetail.fileSearch')}
        onChange={(event) => setKeyword(event.target.value)}
      />
      {files.length === 0 ? (
        <p className="ratio">{t('skillDetail.noFiles')}</p>
      ) : visible.length === 0 ? (
        <p className="ratio">{t('skillDetail.fileSearchEmpty')}</p>
      ) : (
        <div className="skill-tree-scroll">
          <ul className="ws__tree" data-testid="skill-file-tree">
            {rows.map(({ node, depth }) => {
              const indent = { paddingLeft: `calc(var(--sp-3) + ${depth * TREE_INDENT}px)` }
              if (node.type === 'dir') {
                const open = searching || !collapsed.has(node.path)
                return (
                  <li key={`dir:${node.path}`} className="ws__tree-item">
                    <button
                      type="button"
                      className="ws__tree-row ws__tree-row--dir"
                      style={indent}
                      title={node.path}
                      onClick={() => toggle(node.path)}
                    >
                      <span className="ws__chevron">{open ? <DownOutlined /> : <RightOutlined />}</span>
                      {open ? <FolderOpenOutlined /> : <FolderOutlined />}
                      <span className="ws__tree-name">{node.name}</span>
                      <span className="ws__tree-size num">
                        {t('skillDetail.folderFiles', { count: node.fileCount })}
                        {node.scriptCount > 0 && ` · ${t('skillDetail.scriptCount', { count: node.scriptCount })}`}
                      </span>
                    </button>
                  </li>
                )
              }
              return (
                <li key={`file:${node.path}`} className="ws__tree-item">
                  <button
                    type="button"
                    className={`ws__tree-row${selectedPath === node.path ? ' is-active' : ''}`}
                    style={indent}
                    title={`${node.path} · ${formatBytes(node.file.size)}`}
                    onClick={() => onSelect(node.path)}
                  >
                    <span className="ws__chevron" />
                    <FileTypeGlyph path={node.path} />
                    <span className="ws__tree-name">{node.name}</span>
                    {statusOf?.(node.path) === 'ADDED' ? (
                      <span className="skill-status skill-status--added">{t('skillDraft.statusAdded')}</span>
                    ) : statusOf?.(node.path) === 'MODIFIED' ? (
                      <span className="skill-status skill-status--modified">{t('skillDraft.statusModified')}</span>
                    ) : null}
                    {isLikelyScriptPath(node.path) && <Tag color="orange">{t('skillDetail.fileScript')}</Tag>}
                    <span className="ws__tree-size num">
                      {formatBytes(node.file.size)}
                      {!node.file.previewable && ` · ${t('skillDetail.binaryHint')}`}
                      {node.file.purged && ` · ${t('skillDetail.purgedTag')}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}