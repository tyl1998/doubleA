/**
 * 详情页文件树 + 右侧文件面板（P1-24a-7，2026-11-19 用户定案）。
 *
 * 交互**照 Code 模式**（`features/chat/WorkspacePanel.tsx`）：
 *   · 树行**右键**出菜单 —— 文件：重命名 / 删除；目录：新建文件 / 新建文件夹 / 上传到此目录 / 重命名 / 删除；
 *   · 空白区右键 = 根目录级的新建 / 上传；左键点行 = 选中并在右栏看。
 *
 * 右栏沿用审核页那套「对比 / 内容 / 编辑」（`SkillDraftReview.tsx#ReviewFilePane` 的同一套用法）：
 *   · `SKILL.md` 可编辑正文（Markdown 实时预览）；
 *   · 其它**文本文件**也可直接在「编辑」里改（保存时进 vN+1，不再只有"替换文件"一条路）；
 *   · 二进制只能整文件替换（与原行为一致）；
 *   · `docx` / `xlsx` / `xmind` 走 `/file/render` 渲染出口（服务端转成 HTML，沙箱 iframe 展示）；
 *   · 已删除的文件在树里置灰、右栏提示可撤销。
 */

import { DeleteOutlined, EditOutlined, FileAddOutlined, FolderAddOutlined, UndoOutlined, UploadOutlined } from '@ant-design/icons'
import { SKILL_ENTRY_PATH, computeSkillLineChanges, type SkillFileEntry } from '@doubulea/shared'
import { Alert, Button, Dropdown, Empty, Input, Tag, type MenuProps } from 'antd'
import { useMemo, useRef, useState, type ReactNode } from 'react'

import { useT } from '../../app/i18n.js'
import { formatBytes } from '../../app/format.js'
import type { XmindOutline } from '@doubulea/shared'

import { MarkdownPreview } from '../../components/ArtifactPreview/MarkdownPreview.js'
import { XmindOutlinePreview } from '../../components/XmindOutline/XmindOutlinePreview.js'
import { isMarkdownMime } from '../../components/ArtifactPreview/artifactPreview.js'
import { FileTypeGlyph } from '../../components/FileTypeGlyph.js'
import type { SkillFileTreeStatus } from './SkillFileTree.js'
import type { DetailFileStatus } from './skillDetailTreeModel.js'

interface FileNode {
  type: 'file'
  name: string
  path: string
  file: SkillFileEntry
}

interface DirNode {
  type: 'dir'
  name: string
  path: string
  children: TreeNode[]
  fileCount: number
  scriptCount: number
}

type TreeNode = FileNode | DirNode

const TREE_INDENT = 12

/** 由扁平清单建树（与 `SkillFileTree` 同口径；详情页要的是"右键菜单命中哪一行 + 展开状态"） */
function buildTree(
  files: readonly SkillFileEntry[],
  emptyDirs: readonly string[] = [],
  removedPaths: readonly string[] = [],
): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [], fileCount: 0, scriptCount: 0 }
  const removed = new Set(removedPaths)
  // 先建出空的（新建但还没放文件的）目录：目录不是存储对象，只能由这里补进树
  for (const dir of emptyDirs) {
    const segments = dir.split('/')
    let current = root
    for (const name of segments) {
      const path = current.path === '' ? name : `${current.path}/${name}`
      let next = current.children.find((node): node is DirNode => node.type === 'dir' && node.path === path)
      if (next === undefined) {
        next = { type: 'dir', name, path, children: [], fileCount: 0, scriptCount: 0 }
        current.children.push(next)
      }
      current = next
    }
  }
  for (const file of files) {
    // 已删除的**基准文件**仍要留在树里（置灰 + 可撤销），所以这里不按 `removed` 过滤；
    // 只是它们不计入目录的"文件数"，避免"空目录却有 3 个文件"的错觉。
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
    current.children.push({ type: 'file', name: segments.at(-1) ?? file.path, path: file.path, file })
  }
  function finalize(dir: DirNode): void {
    for (const child of dir.children) if (child.type === 'dir') finalize(child)
    dir.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    dir.fileCount = dir.children.reduce(
      (sum, child) =>
        sum + (child.type === 'file' ? (removed.has(child.path) ? 0 : 1) : child.fileCount),
      0,
    )
  }
  finalize(root)
  return root.children
}

interface TreeRow {
  node: TreeNode
  depth: number
}

function flatten(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: readonly TreeNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth })
      if (node.type === 'dir' && !collapsed.has(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return rows
}

export interface DetailTreeActions {
  rename: (path: string, kind: 'FILE' | 'DIR') => void
  remove: (path: string) => void
  removeDir: (dir: string) => void
  newFile: (dir: string) => void
  newFolder: (dir: string) => void
  upload: (dir: string) => void
  /** 撤销删除（只对还没保存的墓碑生效） */
  restore: (path: string) => void
}

/** 详情页的文件树：单一右键菜单（容器级 `Dropdown`，与 Code 模式同一套实现） */
export function DetailFileTree({
  files,
  emptyDirs = [],
  removedPaths = [],
  selectedPath,
  onOpen,
  actions,
  editable,
  statusOf,
}: {
  files: readonly SkillFileEntry[]
  /** 新建但还没放文件的目录（空目录不落版本，保存时忽略；这里只为"看得见 / 能操作"） */
  emptyDirs?: readonly string[]
  /** 已标记删除、还没保存的基准路径（行置灰 + 删除线；有「撤销删除」入口） */
  removedPaths?: readonly string[]
  selectedPath: string | null
  onOpen: (path: string) => void
  actions: DetailTreeActions
  editable: boolean
  statusOf: (path: string) => DetailFileStatus
}) {
  const { t } = useT()
  const tree = useMemo(() => buildTree(files, emptyDirs, removedPaths), [files, emptyDirs, removedPaths])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuProps | null>(null)
  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed])

  const toggle = (path: string): void =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const fileMenu = (path: string): MenuProps => ({
    items: [
      { key: 'open', label: t('skillFile.open') },
      { key: 'rename', icon: <EditOutlined />, label: t('skillFile.rename') },
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: t('skillFile.delete'), danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'open') onOpen(path)
      else if (key === 'rename') actions.rename(path, 'FILE')
      else if (key === 'delete') actions.remove(path)
    },
  })

  const dirMenu = (dir: string): MenuProps => ({
    items: [
      { key: 'newFile', icon: <FileAddOutlined />, label: t('skillFile.newFile') },
      { key: 'newFolder', icon: <FolderAddOutlined />, label: t('skillFile.newFolder') },
      { key: 'upload', icon: <UploadOutlined />, label: t('skillFile.uploadHere') },
      { type: 'divider' },
      { key: 'rename', icon: <EditOutlined />, label: t('skillFile.rename') },
      { key: 'delete', icon: <DeleteOutlined />, label: t('skillFile.deleteDir'), danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'newFile') actions.newFile(dir)
      else if (key === 'newFolder') actions.newFolder(dir)
      else if (key === 'upload') actions.upload(dir)
      else if (key === 'rename') actions.rename(dir, 'DIR')
      else if (key === 'delete') actions.removeDir(dir)
    },
  })

  const blankMenu: MenuProps = {
    items: [
      { key: 'newFile', icon: <FileAddOutlined />, label: t('skillFile.newFile') },
      { key: 'newFolder', icon: <FolderAddOutlined />, label: t('skillFile.newFolder') },
      { key: 'upload', icon: <UploadOutlined />, label: t('skillFile.upload') },
    ],
    onClick: ({ key }) => {
      if (key === 'newFile') actions.newFile('')
      else if (key === 'newFolder') actions.newFolder('')
      else if (key === 'upload') actions.upload('')
    },
  }

  /** 右键命中的是"哪个节点"：优先看最近的行（`button`），再退回它的 `li`（行与行之间的空隙也算这一行） */
  const hitNodeOf = (target: EventTarget | null): { path: string; kind: 'dir' | 'file' } | null => {
    const element = target as HTMLElement | null
    if (element === null) return null
    const row =
      element.closest<HTMLElement>('[data-skill-path]') ??
      element.closest<HTMLElement>('[data-skill-item]')?.querySelector<HTMLElement>('[data-skill-path]') ??
      null
    if (row === null) return null
    return {
      path: row.dataset['skillPath'] ?? '',
      kind: row.dataset['skillKind'] === 'dir' ? 'dir' : 'file',
    }
  }

  /**
   * 右键只负责"选中要操作的行"。菜单本身由下面那**一个** `Dropdown` 统一给（`trigger: contextMenu`）：
   * 之前这里既改了 `menu` 状态、又让 `Dropdown` 自己开菜单，两者发生在同一个事件里，未必都能生效
   * （2026-11-19 用户反馈"只有对着文件右键才有反应"）。
   */
  const onContextMenu = (event: React.MouseEvent): void => {
    const hit = hitNodeOf(event.target)
    if (hit === null) {
      setMenu(blankMenu)
      return
    }
    if (hit.path === SKILL_ENTRY_PATH) {
      setMenu({ items: [{ key: 'open', label: t('skillFile.open') }] })
      return
    }
    setMenu(hit.kind === 'dir' ? dirMenu(hit.path) : fileMenu(hit.path))
  }

  const statusTag = (path: string): ReactNode => {
    const status: SkillFileTreeStatus | null = statusOf(path)
    if (status === null) return null
    const color = status === 'REMOVED' ? 'red' : status === 'MODIFIED' ? 'orange' : 'green'
    const label =
      status === 'ADDED'
        ? t('skillDraft.statusAdded')
        : status === 'REMOVED'
          ? t('skillDraft.statusRemoved')
          : status === 'RENAMED'
            ? t('skillDraft.statusRenamed')
            : t('skillDraft.statusModified')
    return <Tag color={color}>{label}</Tag>
  }

  return (
    <Dropdown menu={menu ?? blankMenu} trigger={['contextMenu']}>
      {/*
        ⚠️ 不能给 `Dropdown` 传 `disabled={!editable}`：`@rc-component/trigger` 会把 `disabled`
        通过 `cloneElement` **写给唯一的子元素**（这里的 `div`），React 视之为未知的布尔属性并告警；
        且 `disabled` 时 trigger 不再接管右键 —— 读权限下右键会走浏览器原生菜单。只读时直接不挂
        `onContextMenu`（见下），让浏览器自己处理。
      */}
      {/*
        ⚠️ 右键**整块面板**都算树的空白区：用户反馈（2026-11-19）"只有右键文件才有菜单"，
        因为 `.skill-tree-scroll` 只包住那几行，行下方的留白不在它里面 ⇒ 事件根本到不了这里。
        `display: flex + min-height: 100%` 让列表撑满容器，空白处右键 = 根目录级新建 / 上传。
      */}
      <div
        className="skill-tree-scroll skill-tree-scroll--fill"
        data-testid="skill-detail-tree"
        onContextMenu={editable ? onContextMenu : undefined}
      >
        {rows.length === 0 ? (
          <p className="ratio" style={{ minHeight: 72 }}>
            {t('skillDetail.noFiles')}
          </p>
        ) : (
          <ul className="ws__tree" style={{ minHeight: '100%' }}>
            {rows.map(({ node, depth }) => {
              const indent = { paddingLeft: `calc(var(--sp-3) + ${depth * TREE_INDENT}px)` }
              if (node.type === 'dir') {
                const open = !collapsed.has(node.path)
                return (
                  <li key={`dir:${node.path}`} className="ws__tree-item" data-skill-item={node.path}>
                    <div className="ws__tree-liner">
                    <button
                      type="button"
                      className="ws__tree-row ws__tree-row--dir"
                      data-skill-path={node.path}
                      data-skill-kind="dir"
                      style={indent}
                      title={node.path}
                      onClick={() => toggle(node.path)}
                    >
                      <span className="ws__chevron">{open ? '▾' : '▸'}</span>
                      <span className="ws__tree-name">{node.name}</span>
                      <span className="ws__tree-size num">{t('skillDetail.folderFiles', { count: node.fileCount })}</span>
                    </button>
                    </div>
                  </li>
                )
              }
              const removed = statusOf(node.path) === 'REMOVED'
              return (
                <li key={`file:${node.path}`} className="ws__tree-item" data-skill-item={node.path}>
                  <div className="ws__tree-liner">
                  <button
                    type="button"
                    className={`ws__tree-row${selectedPath === node.path ? ' is-active' : ''}${removed ? ' is-removed' : ''}`}
                    data-skill-path={node.path}
                    data-skill-kind="file"
                    style={indent}
                    title={node.path}
                    onClick={() => {
                      if (!removed) onOpen(node.path)
                    }}
                  >
                    <span className="ws__chevron" />
                    <FileTypeGlyph path={node.path} />
                    <span className={`ws__tree-name${removed ? ' ws__tree-name--struck' : ''}`}>{node.name}</span>
                    {statusTag(node.path)}
                    <span className="ws__tree-size num">{formatBytes(node.file.size)}</span>
                  </button>
                  {editable && removed ? (
                    <span className="skill-tree__row-actions">
                      <Button
                        type="text"
                        size="small"
                        icon={<UndoOutlined />}
                        title={t('skillFile.restore')}
                        onClick={() => actions.restore(node.path)}
                      >
                        {t('skillFile.restore')}
                      </Button>
                    </span>
                  ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dropdown>
  )
}

/** 右栏：对比 / 内容 / 编辑（与审核页同一套视图语义；`SKILL.md` 与普通文本文件都能编辑） */
export function DetailFilePane({
  entry,
  visible,
  selectedKind,
  renderUrl,
  outline,
  textState,
  textEdit,
  pendingText,
  markdown,
  editableVersion,
  canEdit,
  version,
  onCommitText,
  onCommitMarkdown,
  onReplaceBinary,
  onRemove,
  onRestore,
}: {
  /** 当前版本里的文件行（新建 / 上传的文件为 `null` —— 直接以 `textEdit` / `pendingText` 显示） */
  entry: SkillFileEntry | null
  visible: SkillFileEntry | null
  selectedKind: 'text' | 'image' | 'pdf' | 'html' | 'docx' | 'xlsx' | 'xmind' | 'none' | null
  /** 渲染出口 URL 的来源（`docx` / `xlsx` / `pdf` / `html` 预览要用；`null` = 无法构造，如未落库的新建文件） */
  renderUrl: string | null
  /** `xmind` 的大纲（页面按当前路径 / 版本取回；`undefined` 整体 = 取数中，`error` 非空 = 取数失败） */
  outline: { data: XmindOutline | undefined; error: string | null } | undefined
  textState: { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; text: string } | { phase: 'not-utf8' } | { phase: 'error'; message: string }
  textEdit: string | undefined
  pendingText: string | undefined
  /** 当前版本的 `SKILL.md` 正文（diff 基线） */
  markdown: string
  editableVersion: boolean
  canEdit: boolean
  version: number
  onCommitText: (path: string, text: string) => void
  onCommitMarkdown: (text: string) => void
  onReplaceBinary: (path: string, file: File) => void
  onRemove: (path: string) => void
  /** 撤销删除（已删除的文件在右栏给「撤销」） */
  onRestore: (path: string) => void
  /** 基准路径（`SKILL.md` 的 diff 用；这里只用来判"是不是当前版本里已有的文件"） */
  basePaths: readonly string[]
}) {
  const { t } = useT()
  const [mode, setMode] = useState<'CONTENT' | 'EDIT'>('CONTENT')
  if (visible === null) return <p className="ratio">{t('skillDetail.previewPick')}</p>
  const isEntry = visible.path === SKILL_ENTRY_PATH
  const isText = isEntry || selectedKind === 'text'
  const loaded = textState.phase === 'ready' ? textState.text : ''
  const current = isEntry ? markdown : (textEdit ?? pendingText ?? loaded)
  const readOnly = !editableVersion || !canEdit
  const binary = !isEntry && (selectedKind === 'none' || entry?.purged === true)
  void onRestore

  function renderDiff(): ReactNode {
    if (textEdit === undefined || textEdit === loaded) return <p className="ratio">{t('skillDraft.diffFileNoChanges')}</p>
    const diff = computeSkillLineChanges(loaded, textEdit)
    if (diff.changes.length === 0) return <p className="ratio">{t('skillDraft.diffFileNoChanges')}</p>
    return (
      <div className="code-block skill-diff">
        {diff.changes.map((change, index) => (
          <span
            key={`${change.op}-${change.line}-${String(index)}`}
            className={`skill-diff__line ${change.op === 'add' ? 'skill-diff__line--add' : 'skill-diff__line--del'}`}
          >
            {change.op === 'add' ? '+' : '-'} {String(change.line).padStart(5, ' ')} {change.text}
            {'\n'}
          </span>
        ))}
      </div>
    )
  }

  return (
    <>
      <div className="skill-review__pane-head">
        <code>{visible.path}</code>
        <span className="ratio num">{formatBytes(visible.size)}</span>
        <span className="ratio"> {t('skillDetail.previewVersion', { version })}</span>
      </div>
      <div className="skill-review__pane-head">
        <div className="seg" role="group" aria-label={t('skillDraft.viewMode')}>
          <button type="button" aria-pressed={mode === 'CONTENT'} onClick={() => setMode('CONTENT')}>
            {t('skillDraft.viewContent')}
          </button>
          {isText && !readOnly ? (
            <button type="button" aria-pressed={mode === 'EDIT'} onClick={() => setMode('EDIT')}>
              {t('skillDraft.viewEdit')}
            </button>
          ) : null}
        </div>
        {!isEntry && editableVersion && canEdit && !binary ? (
          <Button size="small" danger onClick={() => onRemove(visible.path)}>
            {t('skillFile.delete')}
          </Button>
        ) : null}
        {!isEntry && editableVersion && canEdit && binary ? (
          <FilePickerButton label={t('skillDetail.replaceBinary')} onPick={(file) => onReplaceBinary(visible.path, file)} />
        ) : null}
      </div>

      {mode === 'CONTENT' ? (
        isEntry ? (
          current.trim() === '' ? (
            <Empty description={t('skillDraft.previewEmpty')} />
          ) : (
            <MarkdownPreview text={current} />
          )
        ) : isText ? (
          textState.phase === 'loading' ? (
            <p className="ratio">{t('skillDraft.diffFileLoading')}</p>
          ) : textState.phase === 'not-utf8' ? (
            <Alert type="warning" showIcon message={t('skillDetail.previewNotUtf8')} />
          ) : textState.phase === 'error' ? (
            <Alert type="warning" showIcon message={textState.message} />
          ) : current.trim() === '' ? (
            <Empty description={t('skillDraft.previewEmpty')} />
          ) : isMarkdownMime(visible.mime) ? (
            <MarkdownPreview text={current} />
          ) : (
            <pre className="code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto', margin: 0 }}>
              <code>{current}</code>
            </pre>
          )
        ) : binary ? (
          <Alert type="info" showIcon message={t('skillDraft.fileBinaryTitle')} description={t('skillDraft.fileBinaryHint')} />
        ) : selectedKind === 'xmind' ? (
          // XMind 不走 HTML：服务端解成大纲 JSON，这里与产物预览同一个"左树 + 右阅读区"
          <XmindOutlinePreview
            outline={outline === undefined ? undefined : outline.data}
            error={outline === undefined ? null : outline.error}
          />
        ) : renderUrl !== null ? (
          // 渲染出口（`docx` / `xlsx`）—— 服务端把二进制 OOXML 转成 HTML，这里与产物预览同一个沙箱 iframe
          // （空 `sandbox` = 不含脚本、不含同源；隔离头由后端响应头上）。
          <iframe
            className="preview__frame"
            src={renderUrl}
            sandbox=""
            referrerPolicy="no-referrer"
            title={visible.path}
          />
        ) : (
          <Alert type="info" showIcon message={t('artifact.preview.unsupportedTitle')} />
        )
      ) : (
        <div className="stack stack--tight">
          {isEntry ? (
            <div className="skill-review__editor">
              <Input.TextArea
                autoSize={{ minRows: 16, maxRows: 40 }}
                value={markdown}
                onChange={(event) => onCommitMarkdown(event.target.value)}
                spellCheck={false}
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <div className="skill-review__editor-preview">
                <p className="ratio">{t('skillDraft.previewLabel')}</p>
                {markdown.trim() === '' ? <Empty description={t('skillDraft.previewEmpty')} /> : <MarkdownPreview text={markdown} />}
              </div>
            </div>
          ) : (
            <>
              <Input.TextArea
                autoSize={{ minRows: 16, maxRows: 40 }}
                value={current}
                onChange={(event) => onCommitText(visible.path, event.target.value)}
                spellCheck={false}
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <p className="ratio">{t('skillDraft.fileEditHint')}</p>
              {textEdit !== undefined && textEdit !== loaded ? <p className="ratio">{t('skillDetail.diffTitleShort')}</p> : null}
              {renderDiff()}
            </>
          )}
        </div>
      )}
    </>
  )
}

/** 一个"替换某个二进制文件"的按钮（隐藏 input，避免为每个文件各挂一个 `Upload`） */
function FilePickerButton({ label, onPick }: { label: string; onPick: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file !== undefined) onPick(file)
        }}
      />
      <Button size="small" icon={<UploadOutlined />} onClick={() => inputRef.current?.click()}>
        {label}
      </Button>
    </>
  )
}
