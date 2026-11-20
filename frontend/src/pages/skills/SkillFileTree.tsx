/**
 * Skill 文件树（`/skills/:id` 左栏 / 草稿审核页左栏）。
 *
 * 为什么不再平铺：真实 Skill 包会有 `scripts/`、`references/`、`assets/` 多层目录，
 * 平铺会把"哪个是脚本、哪个在哪个目录"全部抹掉。这里按目录折叠展示，并对**跨目录**的
 * 可执行文件（如根目录 `vision.js`）打「脚本」标记。
 *
 * 2026-11-17（用户定案）：视觉与 Code 模式文件树保持一致 —— 复用 `.ws__tree-*` 行样式
 * （chevron / 文件夹开合图标 / 行高亮 / 固定行高缩进）与 `FileTypeGlyph` 的扩展名图标。
 *
 * P1-24a-7：增加**可选编辑模式**（`actions`）。默认**不传就是只读**，详情页调用方行为逐字不变；
 * 草稿审核页传 `actions` 才出现「新建 / 上传 / 重命名 / 删除 / 撤销删除」。
 * `SKILL.md` 的行操作一律置灰（正文只能在编辑器里改，不能删 / 重命名）。
 */

import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { Button, Input, Tag } from 'antd'
import { useMemo, useState } from 'react'
import type { SkillFileEntry } from '@doubulea/shared'
import { SKILL_ENTRY_PATH, isLikelyScriptPath } from '@doubulea/shared'

import { useT } from '../../app/i18n.js'
import { formatBytes } from '../../app/format.js'
import { FileTypeGlyph } from '../../components/FileTypeGlyph.js'

/** 改动标记（审核场景；`REMOVED` = 已删除的基准文件，仍在树里以便撤销） */
export type SkillFileTreeStatus = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED'

/** 编辑模式下父组件提供的动作（全部可选 —— 不实现的动作不渲染按钮） */
export interface SkillFileTreeActions {
  /** 在目录 `dir`（`''` = 根）下新建文件 / 文件夹 */
  onCreateFile?: (dir: string) => void
  onCreateDir?: (dir: string) => void
  /** 往目录 `dir` 上传文件 */
  onUpload?: (dir: string) => void
  onRename?: (path: string, kind: 'FILE' | 'DIR') => void
  onDelete?: (path: string, kind: 'FILE' | 'DIR') => void
  /** 撤销删除（把路径从墓碑里摘掉） */
  onRestore?: (path: string) => void
  /** 左栏主动作是否繁忙（新建 / 上传进行中） */
  busy?: boolean
}

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

/** 目录前缀（`a/b/c.md` 的父目录 = `a/b`；根文件 = `''`） */
function parentDirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '' : path.slice(0, index)
}

export function SkillFileTree({
  files,
  selectedPath,
  onSelect,
  statusOf,
  actions,
}: {
  files: readonly SkillFileEntry[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /**
   * 审核场景的改动标记（`ADDED` / `MODIFIED` / `REMOVED` / `RENAMED`）。详情页不传 ⇒
   * 不渲染任何标记，与旧行为逐字一致。
   */
  statusOf?: (path: string) => SkillFileTreeStatus | null
  /** P1-24a-7：编辑模式；**不传 = 只读**（详情页调用方不需要改一行） */
  actions?: SkillFileTreeActions
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

  function statusTag(path: string): JSX.Element | null {
    const status = statusOf?.(path) ?? null
    if (status === 'ADDED') return <span className="skill-status skill-status--added">{t('skillDraft.statusAdded')}</span>
    if (status === 'RENAMED') return <span className="skill-status skill-status--added">{t('skillDraft.statusRenamed')}</span>
    if (status === 'MODIFIED') return <span className="skill-status skill-status--modified">{t('skillDraft.statusModified')}</span>
    if (status === 'REMOVED') return <span className="skill-status skill-status--removed">{t('skillDraft.statusRemoved')}</span>
    return null
  }

  const editable = actions !== undefined

  return (
    <div className="stack stack--tight">
      <Input
        allowClear
        value={keyword}
        prefix={<SearchOutlined />}
        placeholder={t('skillDetail.fileSearch')}
        onChange={(event) => setKeyword(event.target.value)}
      />
      {editable && actions !== undefined ? (
        <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          {actions.onCreateFile !== undefined && (
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={actions.busy === true}
              onClick={() => actions.onCreateFile?.('')}
            >
              {t('skillFile.newFile')}
            </Button>
          )}
          {actions.onCreateDir !== undefined && (
            <Button
              size="small"
              icon={<FolderAddOutlined />}
              disabled={actions.busy === true}
              onClick={() => actions.onCreateDir?.('')}
            >
              {t('skillFile.newFolder')}
            </Button>
          )}
          {actions.onUpload !== undefined && (
            <Button
              size="small"
              icon={<UploadOutlined />}
              disabled={actions.busy === true}
              onClick={() => actions.onUpload?.('')}
            >
              {t('skillFile.upload')}
            </Button>
          )}
        </div>
      ) : null}
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
                    <div className="ws__tree-liner">
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
                      {editable && actions !== undefined ? (
                        <span className="skill-tree__row-actions">
                          {actions.onCreateFile !== undefined && (
                            <Button
                              type="text"
                              size="small"
                              icon={<PlusOutlined />}
                              title={t('skillFile.newFileHere')}
                              onClick={() => actions.onCreateFile?.(node.path)}
                            />
                          )}
                          {actions.onUpload !== undefined && (
                            <Button
                              type="text"
                              size="small"
                              icon={<UploadOutlined />}
                              title={t('skillFile.uploadHere')}
                              onClick={() => actions.onUpload?.(node.path)}
                            />
                          )}
                          {actions.onRename !== undefined && (
                            <Button
                              type="text"
                              size="small"
                              icon={<EditOutlined />}
                              title={t('skillFile.rename')}
                              onClick={() => actions.onRename?.(node.path, 'DIR')}
                            />
                          )}
                          {actions.onDelete !== undefined && (
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              title={t('skillFile.deleteDir')}
                              onClick={() => actions.onDelete?.(node.path, 'DIR')}
                            />
                          )}
                        </span>
                      ) : null}
                    </div>
                  </li>
                )
              }
              const removed = statusOf?.(node.path) === 'REMOVED'
              return (
                <li key={`file:${node.path}`} className="ws__tree-item">
                  <div className="ws__tree-liner">
                    <button
                      type="button"
                      className={`ws__tree-row${selectedPath === node.path ? ' is-active' : ''}${removed ? ' is-removed' : ''}`}
                      style={indent}
                      title={`${node.path} · ${formatBytes(node.file.size)}`}
                      onClick={() => {
                        if (removed) return
                        onSelect(node.path)
                      }}
                    >
                      <span className="ws__chevron" />
                      <FileTypeGlyph path={node.path} />
                      <span className={`ws__tree-name${removed ? ' ws__tree-name--struck' : ''}`}>{node.name}</span>
                      {removed ? (
                        statusTag(node.path)
                      ) : (
                        <>
                          {statusTag(node.path)}
                          {isLikelyScriptPath(node.path) && <Tag color="orange">{t('skillDetail.fileScript')}</Tag>}
                          <span className="ws__tree-size num">
                            {formatBytes(node.file.size)}
                            {!node.file.previewable && ` · ${t('skillDetail.binaryHint')}`}
                            {node.file.purged && ` · ${t('skillDetail.purgedTag')}`}
                          </span>
                        </>
                      )}
                    </button>
                    {editable && actions !== undefined && node.path !== SKILL_ENTRY_PATH ? (
                      <span className="skill-tree__row-actions">
                        {removed && actions.onRestore !== undefined ? (
                          <Button
                            type="text"
                            size="small"
                            icon={<UndoOutlined />}
                            title={t('skillFile.restore')}
                            onClick={() => actions.onRestore?.(node.path)}
                          />
                        ) : (
                          <>
                            {actions.onRename !== undefined && !removed && (
                              <Button
                                type="text"
                                size="small"
                                icon={<EditOutlined />}
                                title={t('skillFile.rename')}
                                onClick={() => actions.onRename?.(node.path, 'FILE')}
                              />
                            )}
                            {actions.onDelete !== undefined && (
                              <Button
                                type="text"
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                title={t('skillFile.delete')}
                                onClick={() => actions.onDelete?.(node.path, 'FILE')}
                              />
                            )}
                          </>
                        )}
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {editable ? (
        <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
          {t('skillFile.entryLockedHint')}
        </p>
      ) : null}
    </div>
  )
}

/** 目录前缀下的文件数（删除目录确认用；与后端"按前缀收集"同口径） */
export function countFilesUnder(files: readonly SkillFileEntry[], dir: string): number {
  return files.filter((file) => file.path === dir || file.path.startsWith(`${dir}/`)).length
}

/** 某路径的父目录（导出给草稿审核页"在哪个目录新建"用） */
export { parentDirOf }
