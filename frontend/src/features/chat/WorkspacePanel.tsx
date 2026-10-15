/**
 * 工作区面板（P1-9 · P3 前端；R12 重设计为 **VS Code 式 IDE 布局**）
 *
 * 依据：`docs/03-前端设计.md` §4.x、`子方案/Code模式工作区.md` §六 / §十。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 形态（第三列 / 窄屏抽屉同一份组件）
 * ─────────────────────────────────────────────────────────────────────
 *   ┌ 工作区头（撤销本轮）─────────────────────────────────────────┐
 *   │ ┌ 资源管理器 ─┐ ┌ 标签条（多标签 · dirty 圆点 · 关闭）──────┐ │
 *   │ │ 文件树      │ │ 面包屑 + 工具栏（重载 / 下载 / 保存）     │ │
 *   │ │ （右键菜单）│ │ CodeMirror / 图片 / 只读说明              │ │
 *   │ │ 最近变更 ▾  │ │ 状态栏（语言 · vN · 大小 · 保存态）       │ │
 *   │ └─────────────┘ └───────────────────────────────────────────┘ │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 资源管理器**不再折叠**（常驻整宽）：文件行**右键**出菜单（打开 / 重命名·移动、下载、删除）；
 *   目录行**右键**出菜单（新建文件 / 文件夹、上传到此目录、**删除文件夹（递归）**）；
 *   文件行**可拖动**到目录或空白区完成移动；空白区右键 = 根级操作。
 * ⚠️ 文本文件**默认显示点文件**（`.git` 等），可用资源管理器头部的眼睛按钮隐藏。
 *
 * ⚠️ 编辑态**按路径**存（`docs`）：多标签各自保留草稿，切标签不丢未保存改动。
 *    SSE 命中当前文件时才重载；**有草稿的**不静默覆盖 —— 走冲突横幅（`子方案` §六 2）。
 * ⚠️ 宽度拖拽在 `ChatPage`（第三列是 grid 的一列），本组件只管面板内部布局。
 */

import {
  BranchesOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Popconfirm, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  WORKSPACE_ACTOR_LABELS,
  type WorkspaceChangeEntry,
  type WorkspaceDiffLine,
  type WorkspaceEventItem,
} from '@doubulea/shared'

import { ApiError } from '../../api/client.js'
import { RuntimeSelect } from './RuntimeSelect.js'
import {
  createWorkspaceFile,
  deleteWorkspaceDirectory,
  deleteWorkspaceFile,
  fetchWorkspaceChanges,
  fetchWorkspaceFile,
  fetchWorkspaceFileDiff,
  moveWorkspaceFile,
  revertWorkspaceRound,
  saveWorkspaceFile,
  streamWorkspaceEvents,
  uploadWorkspaceFile,
  useWorkspaceGit,
  useWorkspaceTree,
  workspaceFileDiffQueryKey,
  workspaceGitQueryKey,
  workspaceRawUrl,
  workspaceTreeQueryKey,
} from '../../api/workspace.js'
import { useFeedback } from '../../app/feedback.js'
import { useWorkspaceExpandedDirs, useWorkspaceStore, useWorkspaceTabs } from '../../stores/workspace.js'
import { CodeMirrorEditor } from './CodeMirrorEditor.js'
import {
  buildWorkspaceTree,
  changeTagColor,
  conflictText,
  eventTouchesPath,
  fileIconKind,
  filterWorkspaceTree,
  flattenWorkspaceTree,
  formatBytes,
  isContentEvent,
  isEditableRead,
  isImageMime,
  isWorkspacePathInDir,
  mergeWorkspaceChanges,
  revertActionLabel,
  revertSummaryText,
  workspaceAncestorDirs,
  workspaceBaseName,
  workspaceCopyValue,
  workspaceEditorLanguage,
  workspaceGitChipLabel,
  workspaceGitChipTitle,
  workspaceLanguageLabel,
  workspaceMoveTargetPath,
  workspaceNewFolderPlaceholderPath,
  workspaceParentDir,
  WORKSPACE_COPY_ITEMS,
  type WorkspaceCopyKind,
  type WorkspaceFileIconKind,
  type WorkspaceTreeNode,
} from './workspaceModel.js'

/** 会话头 Code 模式开关（新会话态也能开 —— 先把意图记在本地，建出会话后落地；见 `ChatPage`） */
export function CodeModeSwitch(props: {
  conversationId: string | undefined
  enabled: boolean
  loading: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <Switch
      size="small"
      checked={props.enabled}
      loading={props.loading}
      checkedChildren="Code 模式"
      unCheckedChildren="普通"
      onChange={props.onToggle}
      title={
        props.conversationId === undefined
          ? '打开后本会话的工作区走人机共享可编辑形态（发送第一条消息时生效）'
          : '打开后本会话的工作区走人机共享可编辑形态（下次派活生效）'
      }
    />
  )
}

/** 每个路径的编辑态：草稿 + 基线（判断 dirty）+ 基线版本（CAS）+ 冲突 */
interface WorkspaceDoc {
  /** 编辑器里的当前文本（草稿） */
  text: string
  /** 最后一次"已落盘 / 已加载"的文本基线；`text !== baseText` = dirty */
  baseText: string
  /** 草稿基于的服务端版本（保存时作 CAS `baseVersion`） */
  version: number
  /** 保存遇到 409 时的服务端当前版本（横幅用） */
  conflict: { currentVersion?: number } | null
}

/** 资源管理器里的路径输入弹窗（新建文件 / 新建文件夹 / 重命名·移动） */
type PromptState =
  | { mode: 'createFile'; dir: string }
  | { mode: 'createFolder'; dir: string }
  | { mode: 'rename'; path: string }
  | null

/** 文件树拖拽的私有 MIME：只认"从工作区行里拖出来的"，浏览器拖进来的别的东西不当作移动 */
const WS_DRAG_MIME = 'application/x-workspace-path'

/** 这次拖拽是不是工作区里的行（dragover 阶段拿不到 data，只能看 `types`） */
function hasWorkspaceDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(WS_DRAG_MIME)
}

/** 文件树每一行 / 空白区要用的动作（由 `WorkspacePanel` 提供，递归 `WorkspaceTree` 只负责触发） */
interface TreeActions {
  open: (path: string) => void
  rename: (path: string) => void
  remove: (path: string) => void
  removeDir: (dir: string) => void
  download: (path: string) => void
  /** 复制三种口径之一（`relative` / `absolute`=容器 `/work/…` / `name`）；文件与目录同款 */
  copy: (kind: WorkspaceCopyKind, path: string) => void
  newFile: (dir: string) => void
  newFolder: (dir: string) => void
  upload: (dir: string) => void
  move: (from: string, dir: string) => void
}

/**
 * 新会话态（`conversationId` 尚未生成）的 Code 模式第三列占位。
 *
 * ⚠️ 工作区是**按会话**存在的（`doubulea-work-<conversationId>` 卷），新会话态还没有会话 ⇒
 * 没有工作区可读。但用户此刻已经开了 Code 模式，第三列就不该回落到**产物面板** —— 那会让
 * "开了 Code 模式"看起来没生效，且首条消息建出会话后还会从产物面板突变成工作区面板。
 * 这里给一个与 {@link WorkspacePanel} 同壳的空态：会话建出来后由 `ChatPage` 换成真面板。
 */
/** 运行时选择器的三件套（由 `ChatPage` 持有真值，见 P1-17a）；工作区头部用它 */
export interface WorkspaceRuntimeControls {
  runtime: string
  runtimePending: boolean
  /** `ready` = 目标组合本机已有镜像（true）/ 需要先构建（false）；见 `RuntimeSelectProps#onSelect` */
  onSelectRuntime: (runtime: string, ready: boolean) => void
}

export function WorkspacePanelPlaceholder(props: WorkspaceRuntimeControls) {
  return (
    <div className="ws" data-testid="workspace-panel-placeholder">
      <header className="ws__head">
        <span className="ws__icon-btn ws__icon-btn--static" title="资源管理器" aria-hidden="true">
          <FolderOutlined />
        </span>
        <span className="ws__title">工作区</span>
        <div className="u-right">
          {/* 新会话态也能选运行时：会话建出来前先记意图、开流前落地（见 ChatPage#runtimePresetRef） */}
          <RuntimeSelect runtime={props.runtime} pending={props.runtimePending} onSelect={props.onSelectRuntime} />
        </div>
      </header>
      <div className="ws__body">
        <div className="ws__empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="发送第一条消息后创建工作区" />
        </div>
      </div>
    </div>
  )
}

export function WorkspacePanel({
  conversationId,
  codeMode,
  ...runtimeControls
}: { conversationId: string; codeMode: boolean } & WorkspaceRuntimeControls) {
  const feedback = useFeedback()
  const { modal } = App.useApp()
  const queryClient = useQueryClient()
  const { openPaths, activePath } = useWorkspaceTabs(conversationId)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const activateFile = useWorkspaceStore((state) => state.activateFile)
  const closeFile = useWorkspaceStore((state) => state.closeFile)
  const renameFile = useWorkspaceStore((state) => state.renameFile)
  const expandDirs = useWorkspaceStore((state) => state.expandDirs)

  const [showHidden, setShowHidden] = useState(true)
  const [recentOpen, setRecentOpen] = useState(false)
  /** 正在查看差异的文件路径（`null` = 差异弹窗关着） */
  const [diffPath, setDiffPath] = useState<string | null>(null)
  /** 路径输入弹窗（新建文件 / 新建文件夹 / 重命名·移动，同一套壳） */
  const [prompt, setPrompt] = useState<PromptState>(null)
  /** 右键"上传到此处"的目标目录（'' = 根）；配合隐藏的 `<input type="file">` */
  const [uploadDir, setUploadDir] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

  const treeQuery = useWorkspaceTree(conversationId, codeMode)
  /**
   * 项目 git 概况（有哪些仓库 + 当前分支）。**锦上添花**：失败就当作没有 git，不打扰用户
   * （`repos: []` 与"请求失败"在界面上都是"不显示分支 chip"，见头部的渲染条件）。
   */
  const gitQuery = useWorkspaceGit(conversationId, codeMode)
  /** 有 git 才渲染分支 chip（见头部那段注释：空数组与失败都不显示） */
  const gitRepos = gitQuery.data?.repos ?? []
  const treeNodes = useMemo(() => buildWorkspaceTree(treeQuery.data?.items ?? []), [treeQuery.data])
  const visibleNodes = useMemo(() => filterWorkspaceTree(treeNodes, showHidden), [treeNodes, showHidden])
  const fileCount = useMemo(() => treeQuery.data?.items.length ?? 0, [treeQuery.data])

  // ── 当前标签的读 ──
  const fileQuery = useQuery({
    queryKey: ['workspace-file', conversationId, activePath ?? ''],
    queryFn: ({ signal }) => fetchWorkspaceFile(conversationId, activePath ?? '', { signal }),
    enabled: codeMode && activePath !== null,
  })

  // ── 按路径的编辑态 ──
  const [docs, setDocs] = useState<Record<string, WorkspaceDoc>>({})
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)

  // 读回结果（首次 / 服务端版本前进）⇒ 铺草稿；有草稿且服务端也前进 ⇒ 只挂冲突，不覆盖
  useEffect(() => {
    const data = fileQuery.data
    const path = activePath
    if (data === undefined || path === null) return
    setDocs((prev) => {
      const doc = prev[path]
      if (doc === undefined) {
        return { ...prev, [path]: { text: data.text ?? '', baseText: data.text ?? '', version: data.version, conflict: null } }
      }
      if (data.version !== doc.version) {
        if (doc.text !== doc.baseText) {
          return { ...prev, [path]: { ...doc, conflict: { currentVersion: data.version } } }
        }
        return { ...prev, [path]: { text: data.text ?? '', baseText: data.text ?? '', version: data.version, conflict: null } }
      }
      return prev
    })
  }, [fileQuery.data, activePath])

  const activeDoc = activePath === null ? undefined : docs[activePath]
  const editable = fileQuery.data !== undefined && isEditableRead(fileQuery.data)
  const dirty = activeDoc !== undefined && activeDoc.text !== activeDoc.baseText

  const editText = (path: string, text: string): void => {
    setDocs((prev) => {
      const doc = prev[path]
      if (doc === undefined) return prev
      return { ...prev, [path]: { ...doc, text } }
    })
  }

  /**
   * 「重新加载」：**直接**用当前读结果重铺草稿（丢弃未保存改动、清冲突），再 refetch 拉最新。
   *
   * ⚠️ 不能只靠 `refetch` 后由上面那个 effect 铺 —— 冲突场景下服务端版本**早已进缓存**
   * （SSE 那次 refetch 拉回来的），再 refetch 拿到的是**同一个对象引用**，effect 的依赖
   * 不会变、也就不会重铺。所以这里就地重铺，refetch 只是兜住"缓存比服务端旧"的情形。
   */
  const reloadActive = (): void => {
    const path = activePath
    if (path === null) return
    const data = fileQuery.data
    if (data !== undefined) {
      const text = data.text ?? ''
      setDocs((prev) => ({
        ...prev,
        [path]: { text, baseText: text, version: data.version, conflict: null },
      }))
    }
    void fileQuery.refetch()
  }

  const save = async (path: string): Promise<void> => {
    const doc = docs[path]
    if (doc === undefined) return
    setSavingPath(path)
    try {
      const entry = await saveWorkspaceFile(conversationId, path, doc.text, doc.version)
      setDocs((prev) => {
        const current = prev[path]
        if (current === undefined) return prev
        return { ...prev, [path]: { ...current, baseText: current.text, version: entry.version, conflict: null } }
      })
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      feedback.ok('已保存')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        const data = error.data as { currentVersion?: number } | null
        setDocs((prev) => {
          const current = prev[path]
          if (current === undefined) return prev
          return {
            ...prev,
            [path]: {
              ...current,
              conflict: { ...(data?.currentVersion === undefined ? {} : { currentVersion: data.currentVersion }) },
            },
          }
        })
        feedback.fail(error, '保存冲突')
      } else {
        feedback.fail(error, '保存失败')
      }
    } finally {
      setSavingPath(null)
    }
  }

  const remove = async (path: string): Promise<void> => {
    try {
      await deleteWorkspaceFile(conversationId, path)
      closeFile(conversationId, path)
      setDocs((prev) => {
        if (!(path in prev)) return prev
        const next = { ...prev }
        delete next[path]
        return next
      })
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      feedback.ok('已删除')
    } catch (error) {
      feedback.fail(error, '删除失败')
    }
  }

  /** 右键「删除」：软删仍可在历史里找回，故确认一次即可 */
  const confirmRemove = (path: string): void => {
    modal.confirm({
      title: '删除这个文件？',
      content: `${path}（软删 + 墓碑；可在历史里找回，若在保留期内）`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => remove(path),
    })
  }

  /**
   * 右键「删除文件夹」：**递归**删除该目录下所有文件（后端逐个软删 + 墓碑 + 各一条 `deleted` 事件，
   * 再把目录整份落盘删除）。成功后关掉该目录下已打开的标签、清掉它们的草稿。
   */
  const removeDir = async (dir: string): Promise<void> => {
    try {
      const result = await deleteWorkspaceDirectory(conversationId, dir)
      // 目录连同其下文件一起没了 ⇒ 关标签 + 清草稿（`isWorkspacePathInDir` 带尾斜杠，不误伤同前缀兄弟）
      for (const path of openPaths.filter((item) => isWorkspacePathInDir(item, dir))) closeFile(conversationId, path)
      setDocs((prev) => {
        const next: Record<string, WorkspaceDoc> = {}
        for (const [path, doc] of Object.entries(prev)) {
          if (!isWorkspacePathInDir(path, dir)) next[path] = doc
        }
        return next
      })
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      feedback.ok(result.deleted > 0 ? `已删除文件夹（${result.deleted} 个文件）` : '已删除文件夹')
    } catch (error) {
      feedback.fail(error, '删除文件夹失败')
    }
  }

  /** 右键「删除文件夹」：递归软删仍可在历史里找回，故确认一次即可（但明示"整目录递归"） */
  const confirmRemoveDir = (dir: string): void => {
    modal.confirm({
      title: '删除这个文件夹？',
      content: `${dir}/ —— 将递归删除其中的所有文件（软删 + 墓碑；可在历史里找回，若在保留期内）`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => removeDir(dir),
    })
  }

  /** 新建文件（`POST .../workspace/file`）：成功后刷新树并直接打开它 */
  const createFile = async (path: string): Promise<void> => {
    setPrompt(null)
    try {
      await createWorkspaceFile(conversationId, path)
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      openFile(conversationId, path)
      feedback.ok('已新建')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') feedback.fail(error, '同名文件已存在')
      else feedback.fail(error, '新建失败')
    }
  }

  /**
   * 新建文件夹：工作区模型里**空目录不算内容**（树由文件路径派生），故落一个隐藏占位文件
   * （`.gitkeep`）让目录可见 —— 与 git 保留空目录同一手法。
   */
  const createFolder = async (dir: string): Promise<void> => {
    setPrompt(null)
    const placeholder = workspaceNewFolderPlaceholderPath(workspaceParentDir(dir), workspaceBaseName(dir))
    try {
      await createWorkspaceFile(conversationId, placeholder)
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      feedback.ok('已新建文件夹')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') feedback.fail(error, '同名文件夹已存在')
      else feedback.fail(error, '新建文件夹失败')
    }
  }

  /** 改名 / 移动（`POST .../workspace/move`）：迁移打开态与草稿，刷新树 */
  const doRename = async (from: string, to: string): Promise<void> => {
    setPrompt(null)
    if (to === from) return
    try {
      await moveWorkspaceFile(conversationId, from, to)
      setDocs((prev) => {
        if (!(from in prev)) return prev
        const next = { ...prev }
        next[to] = next[from] as WorkspaceDoc
        delete next[from]
        return next
      })
      renameFile(conversationId, from, to)
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      feedback.ok('已重命名')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') feedback.fail(error, '目标路径已存在')
      else feedback.fail(error, '重命名失败')
    }
  }

  /** 拖拽移动：把文件移到某个目录下（名字不变）；目录相同则不做事 */
  const moveToDir = async (from: string, dir: string): Promise<void> => {
    const to = workspaceMoveTargetPath(from, dir)
    if (to === from) return
    if (workspaceParentDir(from) === dir) return
    await doRename(from, to)
  }

  /** 右键「上传到此处」：记下目标目录并唤起隐藏的文件选择器 */
  const pickUpload = (dir: string): void => {
    setUploadDir(dir)
    uploadInputRef.current?.click()
  }

  /** 选中文件后逐个上传（multipart 单文件），全部完成后刷新树并提示 */
  const onUploadPicked = async (files: FileList | null): Promise<void> => {
    const dir = uploadDir ?? ''
    const list = files === null ? [] : Array.from(files)
    setUploadDir(null)
    if (uploadInputRef.current !== null) uploadInputRef.current.value = ''
    if (list.length === 0) return
    let okCount = 0
    for (const file of list) {
      try {
        await uploadWorkspaceFile(conversationId, dir, file)
        okCount += 1
      } catch (error) {
        feedback.fail(error, `上传失败：${file.name}`)
      }
    }
    if (okCount > 0) {
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      feedback.ok(`已上传 ${okCount} 个文件`)
    }
  }

  /** 右键菜单「下载」：用 `<a download>` 走字节出口（与会话已文件名一致） */
  const downloadPath = (path: string): void => {
    const link = document.createElement('a')
    link.href = workspaceRawUrl(conversationId, path)
    link.download = workspaceBaseName(path)
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  /**
   * 「撤销本轮」（P1-9 · P4 · R2）：把上一轮 agent/人的写入回退到轮初。
   *
   * ★ 结果**逐条列出**（用户反馈："点「撤销本轮」时没有展示撤销了什么"）：汇总一句 + 每个落点
   *   一行（路径 / 动作 / 说明）。冲突 / 缺历史 / 不支持都如实展示，而不是只弹一句"还原 N"。
   */
  const revert = async (): Promise<void> => {
    setReverting(true)
    try {
      const result = await revertWorkspaceRound(conversationId)
      modal.info({
        title: '已撤销本轮',
        width: 560,
        okText: '知道了',
        content: (
          <div data-testid="revert-report">
            <p className="ws__revert-summary">{revertSummaryText(result)}</p>
            {result.items.length > 0 && (
              <ul className="ws__revert-list">
                {result.items.map((item) => (
                  <li key={`${item.action}:${item.path}`} className="ws__revert-item">
                    <span className={`ws__revert-action ws__revert-action--${item.action}`}>
                      {revertActionLabel(item.action)}
                    </span>
                    <span className="ws__revert-path">{item.path}</span>
                    {item.message !== undefined && item.message !== '' && (
                      <span className="ws__revert-message">{item.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ),
      })
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      // 打开的文件全量重读：干净的重铺，有草稿的进冲突（不静默覆盖）
      void queryClient.invalidateQueries({ queryKey: ['workspace-file', conversationId] })
    } catch (error) {
      feedback.fail(error, '撤销本轮失败')
    } finally {
      setReverting(false)
    }
  }

  // ── 事件流：内容事件 ⇒ 刷新树 + 自动展开所在目录；命中当前文件 ⇒ 重载；`deleted` 命中打开的文件 ⇒ 关标签 ──
  const [recentEvents, setRecentEvents] = useState<WorkspaceEventItem[]>([])
  /**
   * 服务端变更集（`GET /workspace/changes`）：刷新 / 刚进会话时那份"改过哪些文件"的**基线**。
   *
   * ⚠️ 面板原来**只**累积实时 SSE 事件 ⇒ 刷新后 / 刚进会话时「最近变更」永远是空的
   *    （用户反馈："「最近变更」你也看不到"）。这份基线补上那一段，实时事件再叠在它上面。
   */
  const [serverChanges, setServerChanges] = useState<WorkspaceChangeEntry[]>([])
  useEffect(() => {
    if (!codeMode) return
    let cancelled = false
    void fetchWorkspaceChanges(conversationId)
      .then((result) => {
        if (!cancelled) setServerChanges(result.items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [conversationId, codeMode])
  const activePathRef = useRef<string | null>(activePath)
  activePathRef.current = activePath
  useEffect(() => {
    if (!codeMode) return
    const controller = new AbortController()
    void streamWorkspaceEvents(conversationId, {
      signal: controller.signal,
      onEvent: (event) => {
        setRecentEvents((prev) => [...prev.slice(-199), event])
        if (!isContentEvent(event)) return
        // agent 改了某个文件 ⇒ 自动展开它所在的目录：文件树**默认全折叠**（`WorkspaceTree`），
        // 不展开就看不见深处的新文件（用户反馈："agent 新增/编辑过的文件没有展示"）。
        const dirs = workspaceAncestorDirs(event.path)
        if (dirs.length > 0) expandDirs(conversationId, dirs)
        void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
        // 分支可能刚被换成别的（`git checkout` 会写 `.git/HEAD` ⇒ 也是工作区事件）⇒ 一并失效
        void queryClient.invalidateQueries({ queryKey: workspaceGitQueryKey(conversationId) })
        if (event.type === 'deleted' && (useWorkspaceStore.getState().tabsByConversation[conversationId]?.openPaths ?? []).includes(event.path)) {
          closeFile(conversationId, event.path)
          return
        }
        if (eventTouchesPath(event, activePathRef.current)) void fileQuery.refetch()
      },
      onIssue: () => undefined,
    }).catch(() => undefined)
    return () => controller.abort()
    // 只在会话 / 开关变化时重连（`fileQuery.refetch` / `closeFile` / `expandDirs` 通过 ref 与稳定引用）
  }, [conversationId, codeMode, queryClient, closeFile, expandDirs])

  // ── ⌘S / Ctrl+S：编辑器聚焦时由 CodeMirror 拦截；焦点在别处（文件树 / 标签）时由这里兜底保存 ──
  const saveActiveRef = useRef<() => void>(() => undefined)
  saveActiveRef.current = () => {
    if (activePath !== null && editable && dirty && savingPath === null) void save(activePath)
  }
  useEffect(() => {
    if (!codeMode) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveActiveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [codeMode])

  // ── 有未保存草稿时离开页面给浏览器一次拦截（"文件被编辑了"的防丢改动兜底）──
  const hasDirtyRef = useRef(false)
  hasDirtyRef.current = openPaths.some((path) => {
    const doc = docs[path]
    return doc !== undefined && doc.text !== doc.baseText
  })
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!hasDirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // 「最近变更」= 服务端基线（刷新/刚进会话时那份）∪ 实时事件，按路径折叠、只认内容事件、按时间倒序。
  // ⚠️ 不能只 `foldWorkspaceEvents(recentEvents)`：那样刷新后 / 刚进会话时列表是空的。
  const changes = useMemo(() => mergeWorkspaceChanges(serverChanges, recentEvents).slice(0, 8), [serverChanges, recentEvents])

  /**
   * 右键「复制」：三种口径见 `workspaceModel#workspaceCopyValue`（相对路径 / 容器内 `/work/…` / 名称）。
   *
   * ⚠️ 复制失败**不静默**（与用户消息、助手消息两处复制同一口径）：用户要的是那段字符串，
   *    不是"点了菜单项"。`navigator.clipboard` 需要安全上下文（localhost / https）。
   */
  const copyPath = (kind: WorkspaceCopyKind, path: string): void => {
    const value = workspaceCopyValue(kind, path)
    navigator.clipboard
      .writeText(value)
      .then(() => feedback.ok(`已复制：${value}`))
      .catch((error: unknown) => feedback.fail(error, '复制失败'))
  }

  /** 文件树右键 / 拖拽要用的动作集合（下传给 `WorkspaceTree`） */
  const treeActions: TreeActions = {
    open: (path) => openFile(conversationId, path),
    rename: (path) => setPrompt({ mode: 'rename', path }),
    remove: confirmRemove,
    removeDir: confirmRemoveDir,
    download: downloadPath,
    copy: copyPath,
    newFile: (dir) => setPrompt({ mode: 'createFile', dir }),
    newFolder: (dir) => setPrompt({ mode: 'createFolder', dir }),
    upload: pickUpload,
    move: (from, dir) => void moveToDir(from, dir),
  }

  if (!codeMode) {
    return <Empty description="当前会话未开启 Code 模式" />
  }

  const language = activePath === null ? 'text' : workspaceEditorLanguage(activePath)

  /** 弹窗初始值：重命名 = 原路径；新建 = 目标目录加尾斜杠（空目录 = 根，空串） */
  const promptInitial =
    prompt === null ? '' : prompt.mode === 'rename' ? prompt.path : prompt.dir === '' ? '' : `${prompt.dir}/`

  return (
    <div className="ws" data-testid="workspace-panel">
      <header className="ws__head">
        <span className="ws__icon-btn ws__icon-btn--static" title="资源管理器" aria-hidden="true">
          <FolderOutlined />
        </span>
        <span className="ws__title">工作区</span>
        <div className="u-right">
          {/* 运行时选择（P1-17a）：建容器（派活）时用哪份预烘焙镜像；下次派活生效 */}
          <RuntimeSelect
            runtime={runtimeControls.runtime}
            pending={runtimeControls.runtimePending}
            onSelect={runtimeControls.onSelectRuntime}
          />
          <Popconfirm
            title="撤销本轮？"
            description="把上一轮 agent / 你的写入回退到轮初；此后又被改过的文件不会被覆盖。"
            okText="撤销"
            cancelText="取消"
            onConfirm={() => void revert()}
          >
            <Button size="small" icon={<UndoOutlined />} loading={reverting} data-testid="workspace-revert">
              撤销本轮
            </Button>
          </Popconfirm>
        </div>
      </header>

      <div className="ws__body">
        {/* 资源管理器：**常驻整宽**（不再折叠成 44px 图标条 —— 折叠态形态别扭，用户反馈去掉）；
            树行右键出菜单、可拖拽移动到目录；空白区右键 = 根目录级的新建 / 上传 */}
        <div className="ws__explorer">
          <div className="ws__explorer-head">
            <span className="ws__explorer-title">资源管理器</span>
              <span className="u-right ws__explorer-actions">
                <button
                  type="button"
                  className="ws__icon-btn"
                  onClick={() => setPrompt({ mode: 'createFile', dir: '' })}
                  title="新建文件"
                >
                  <FileAddOutlined />
                </button>
                <button
                  type="button"
                  className={`ws__icon-btn${showHidden ? ' is-on' : ''}`}
                  onClick={() => setShowHidden((value) => !value)}
                  title={showHidden ? '隐藏点文件（.git 等）' : '显示点文件（.git 等）'}
                  aria-pressed={showHidden}
                >
                  {showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                </button>
                <span className="ws__count">{fileCount}</span>
              </span>
            </div>
          {treeQuery.isLoading ? (
            <div className="ws__loading">
              <Spin />
            </div>
          ) : (
            <WorkspaceTree
              conversationId={conversationId}
              nodes={visibleNodes}
              selectedPath={activePath}
              actions={treeActions}
            />
          )}

            {changes.length > 0 && (
              <div className={`ws__recent${recentOpen ? ' is-open' : ''}`}>
                <button type="button" className="ws__recent-head" onClick={() => setRecentOpen((open) => !open)}>
                  <RightOutlined className="ws__chevron" rotate={recentOpen ? 90 : 0} /> 最近变更 {changes.length}
                </button>
                {recentOpen && (
                  <ul className="ws__recent-list">
                    {changes.map((change) => (
                      <RecentChangeRow
                        key={`${change.path}-${change.at}`}
                        conversationId={conversationId}
                        change={change}
                        onOpenFile={() => openFile(conversationId, change.path)}
                        onOpenDiff={() => setDiffPath(change.path)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/*
              项目 git 分支：**固定一栏**，钉在「最近变更」下面（用户反馈 2026-10-15：原来挤在
              "资源管理器"标题行里，长分支名 / 多仓库根本看不全）。
              数据来自只读的 `.git/HEAD`（`api/workspace.ts#useWorkspaceGit`）；
              `repos: []`（没有 git / 工作区还没建 / 请求失败）⇒ **整栏不渲染** —— 宁可没有，
              也不要一个空标签或"无 git"占位。
            */}
            {gitRepos.length > 0 && (
              <div className="ws__git-bar" data-testid="workspace-git">
                {gitRepos.map((repo) => (
                  <div key={repo.path} className="ws__git-row" title={workspaceGitChipTitle(repo)}>
                    <BranchesOutlined className="ws__git-icon" />
                    {gitRepos.length > 1 && repo.path !== '' ? <span className="ws__git-repo">{repo.path}</span> : null}
                    <span className="ws__git-branch">{workspaceGitChipLabel(repo)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        <div className="ws__editor">
          {openPaths.length > 0 && (
            <div className="ws__tabs" role="tablist">
              {openPaths.map((path) => {
                const doc = docs[path]
                const tabDirty = doc !== undefined && doc.text !== doc.baseText
                const isActive = path === activePath
                return (
                  <div
                    key={path}
                    role="tab"
                    aria-selected={isActive}
                    className={`ws__tab${isActive ? ' is-active' : ''}`}
                  >
                    <button type="button" className="ws__tab-name" title={path} onClick={() => activateFile(conversationId, path)}>
                      <FileGlyph path={path} />
                      <span className="ws__tab-label">{workspaceBaseName(path)}</span>
                      {tabDirty && <span className="ws__tab-dot" aria-label="未保存" />}
                    </button>
                    <button
                      type="button"
                      className="ws__tab-close"
                      title="关闭"
                      onClick={(event) => {
                        event.stopPropagation()
                        closeFile(conversationId, path)
                      }}
                    >
                      <CloseOutlined />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {activePath === null || activeDoc === undefined ? (
            <div className="ws__placeholder">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  // ⚠️ 读失败（文件被删 / 没权限）时**不能**一直显示"正在读取文件…"（产品反馈）：
                  //    那种情况 `docs[path]` 永远不会被填上 ⇒ 这个占位会一直是"加载中"。
                  activePath === null
                    ? '从左侧选一个文件开始'
                    : fileQuery.isError
                      ? '文件读不到（可能已被删除，或没有权限）'
                      : '正在读取文件…'
                }
              />
            </div>
          ) : (
            <>
              <div className="ws__toolbar">
                <span className="ws__crumb" title={activePath}>
                  {activePath}
                </span>
                <Space size="small" className="u-right">
                  <Tooltip title="重新加载（丢弃未保存改动）">
                    <Button size="small" type="text" icon={<ReloadOutlined />} onClick={reloadActive} />
                  </Tooltip>
                  <Tooltip title="下载">
                    <a href={workspaceRawUrl(conversationId, activePath)} download>
                      <Button size="small" type="text" icon={<DownloadOutlined />} />
                    </a>
                  </Tooltip>
                  {editable && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<SaveOutlined />}
                      loading={savingPath === activePath}
                      disabled={!dirty}
                      onClick={() => void save(activePath)}
                    >
                      保存
                    </Button>
                  )}
                </Space>
              </div>

              {fileQuery.isError ? (
                <div className="ws__placeholder">
                  <Typography.Text type="danger">文件读不到（可能已被删除，或没有权限）。</Typography.Text>
                </div>
              ) : (
                <>
                  {activeDoc.conflict !== null && (
                    <div className="ws__banner">
                      <Alert
                        type="warning"
                        showIcon
                        message={conflictText(activeDoc.conflict.currentVersion)}
                        action={
                          <Button size="small" onClick={reloadActive}>
                            重新加载
                          </Button>
                        }
                      />
                    </div>
                  )}
                  <div className="ws__editor-main">
                    {fileQuery.isLoading ? (
                      <div className="ws__loading">
                        <Spin />
                      </div>
                    ) : editable ? (
                      <CodeMirrorEditor
                        value={activeDoc.text}
                        docKey={activePath}
                        language={language}
                        onChange={(value) => editText(activePath, value)}
                        onSave={() => {
                          if (dirty && savingPath === null) void save(activePath)
                        }}
                      />
                    ) : isImageMime(fileQuery.data?.mime) ? (
                      <WorkspaceImagePreview
                        url={workspaceRawUrl(conversationId, activePath)}
                        alt={activePath}
                      />
                    ) : (
                      <div className="ws__placeholder">
                        <Typography.Text type="secondary">
                          该文件不是文本（{fileQuery.data?.mime}），只能下载 / 预览。
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                  <div className="ws__status" data-testid="workspace-status">
                    <span>{workspaceLanguageLabel(language)}</span>
                    <span>v{activeDoc.version}</span>
                    <span>{formatBytes(fileQuery.data?.size ?? 0)}</span>
                    <span
                      className={`u-right${dirty ? ' ws__status--dirty' : ''}${
                        activeDoc.conflict !== null ? ' ws__status--conflict' : ''
                      }`}
                    >
                      {activeDoc.conflict !== null ? '冲突' : dirty ? '未保存' : '已保存'}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <WorkspacePathPrompt
        open={prompt !== null}
        mode={prompt?.mode ?? 'createFile'}
        initialValue={promptInitial}
        onCancel={() => setPrompt(null)}
        onSubmit={(path) => {
          if (prompt === null) return
          if (prompt.mode === 'rename') void doRename(prompt.path, path)
          else if (prompt.mode === 'createFolder') void createFolder(path)
          else void createFile(path)
        }}
      />

      {/* 行级差异（验收标记）：点「最近变更」某条的「差异」打开 */}
      <WorkspaceDiffModal
        conversationId={conversationId}
        path={diffPath}
        onClose={() => setDiffPath(null)}
      />

      {/* 上传入口：右键菜单触发选择器，多选逐个 multipart 上传（同一时刻只有一个在传） */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => void onUploadPicked(event.target.files)}
      />
    </div>
  )
}

/**
 * 「最近变更」里的一行：类型标签 + 路径 + **变更量徽标**（`+N −M`）+ 发起者。
 *
 * 打开文件与打开差异是**两个动作**：已删除的路径不能打开（读不存在的文件会卡在"加载中"），
 * 但仍可**看差异**（整篇删除，能核对 agent 到底删了什么）。
 */
function RecentChangeRow(props: {
  conversationId: string
  change: WorkspaceChangeEntry
  onOpenFile: () => void
  onOpenDiff: () => void
}) {
  const { conversationId, change, onOpenFile, onOpenDiff } = props
  // 逐行差异的**计数**（只回 `+N −M`，不带逐行内容）：每行一个轻量查询，点开才取全文
  const stats = useQuery({
    queryKey: workspaceFileDiffQueryKey(conversationId, change.path, change.version ?? undefined),
    queryFn: () => fetchWorkspaceFileDiff(conversationId, change.path, { stats: true }),
    enabled: change.version !== null,
    staleTime: 30_000,
  })
  const badge = stats.data
  const deleted = change.type === 'deleted'
  return (
    <li>
      <Tag color={changeTagColor(change.type)} style={{ marginInlineEnd: 0 }}>
        {change.type}
      </Tag>
      {deleted ? (
        // 已删除的路径**不可点**（产品反馈：点了"一直展示文件加载中"）——但仍可看差异
        <span className="ws__recent-path ws__recent-path--deleted" title={change.path}>
          {workspaceBaseName(change.path)}
        </span>
      ) : (
        <button type="button" className="ws__recent-path" title={change.path} onClick={onOpenFile}>
          {workspaceBaseName(change.path)}
        </button>
      )}
      {badge !== undefined && badge.available ? (
        <button type="button" className="ws__recent-diff" onClick={onOpenDiff} title="查看行级差异">
          <span className="ws__diff-added">+{badge.added}</span>
          <span className="ws__diff-removed">−{badge.removed}</span>
        </button>
      ) : (
        <button
          type="button"
          className="ws__recent-diff ws__recent-diff--muted"
          onClick={onOpenDiff}
          title={badge?.message ?? '查看差异'}
        >
          差异
        </button>
      )}
      <span className="ws__recent-actor">{WORKSPACE_ACTOR_LABELS[change.actor]}</span>
    </li>
  )
}

/**
 * 文件**行级差异**弹窗（验收标记）：旧行号 / 新行号 / `+/−` 号 / 文本；
 * 未变长段由后端折成「⋯ N 行未变⋯」一条（`gap`）。
 */
function WorkspaceDiffModal(props: { conversationId: string; path: string | null; onClose: () => void }) {
  const { conversationId, path, onClose } = props
  const query = useQuery({
    queryKey: workspaceFileDiffQueryKey(conversationId, path ?? ''),
    queryFn: () => fetchWorkspaceFileDiff(conversationId, path ?? ''),
    enabled: path !== null,
  })
  const diff = query.data
  const lines = diff?.lines ?? []
  return (
    <Modal
      open={path !== null}
      onCancel={onClose}
      footer={null}
      width={760}
      title={
        <span className="ws__diff-title">
          差异
          <span className="ws__diff-title-path">{path}</span>
          {diff !== undefined && diff.available ? (
            <span className="ws__diff-title-stat">
              <span className="ws__diff-added">+{diff.added}</span>{' '}
              <span className="ws__diff-removed">−{diff.removed}</span>
            </span>
          ) : null}
        </span>
      }
    >
      {query.isError ? (
        <div className="ws__placeholder">
          <Typography.Text type="danger">差异读取失败。</Typography.Text>
        </div>
      ) : diff === undefined ? (
        <div className="ws__loading">
          <Spin />
        </div>
      ) : !diff.available ? (
        <div className="ws__placeholder">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={diff.message ?? '该文件无法逐行比较'} />
        </div>
      ) : lines.length === 0 ? (
        <div className="ws__placeholder">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="内容没有变化" />
        </div>
      ) : (
        <div className="ws__diff" data-testid="workspace-diff">
          {lines.map((line, index) => (
            <WorkspaceDiffLineRow key={`${index}:${line.type}:${line.oldLine ?? ''}:${line.newLine ?? ''}`} line={line} />
          ))}
        </div>
      )}
    </Modal>
  )
}

/** 差异里的一行（`gap` = 折叠的未变长段） */
function WorkspaceDiffLineRow({ line }: { line: WorkspaceDiffLine }) {
  if (line.type === 'gap') {
    return <div className="ws__diff-line ws__diff-line--gap">⋯ {line.gap ?? 0} 行未变 ⋯</div>
  }
  return (
    <div className={`ws__diff-line ws__diff-line--${line.type}`}>
      <span className="ws__diff-no">{line.oldLine ?? ''}</span>
      <span className="ws__diff-no">{line.newLine ?? ''}</span>
      <span className="ws__diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
      <span className="ws__diff-text">{line.text}</span>
    </div>
  )
}

/** 新建文件 / 新建文件夹 / 重命名共用的路径输入弹窗（相对路径；服务端负责归一化与越界校验） */
function WorkspacePathPrompt(props: {
  open: boolean
  mode: 'createFile' | 'createFolder' | 'rename'
  initialValue: string
  onCancel: () => void
  onSubmit: (path: string) => void
}) {
  const [value, setValue] = useState(props.initialValue)
  useEffect(() => {
    if (props.open) setValue(props.initialValue)
  }, [props.open, props.initialValue])
  const submit = (): void => {
    const path = value.trim()
    if (path === '') return
    props.onSubmit(path)
  }
  const isRename = props.mode === 'rename'
  const isFolder = props.mode === 'createFolder'
  return (
    <Modal
      open={props.open}
      title={isRename ? '重命名 / 移动' : isFolder ? '新建文件夹' : '新建文件'}
      okText={isRename ? '重命名' : isFolder ? '新建' : '新建'}
      cancelText="取消"
      onOk={submit}
      onCancel={props.onCancel}
      destroyOnClose
    >
      <Input
        value={value}
        autoFocus
        placeholder={isFolder ? '例如 src/utils' : '例如 src/index.ts'}
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={submit}
      />
      <p className="ratio" style={{ marginTop: 8 }}>
        相对工作区根目录的路径；目录不存在会自动建。{isFolder ? '文件夹内会落一个 .gitkeep 占位。' : isRename ? '目标已存在会被拒绝。' : '同名已存在会被拒绝。'}
      </p>
    </Modal>
  )
}

/** 文件图标（按 `fileIconKind` 挑图标 + 配色；纯展示，判据在纯函数里） */
function FileGlyph({ path }: { path: string }) {
  const kind = fileIconKind(path)
  const color = FILE_ICON_COLORS[kind]
  return <span className="ws__glyph" style={{ color }}>{FILE_ICON_NODES[kind]}</span>
}

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

/** 只读图片预览（内联；失败给因由，同 `ArtifactPreview/ImagePreview` 的纪律） */
function WorkspaceImagePreview({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="ws__placeholder">
        <Alert type="warning" showIcon message="图片没能加载" description="可能是会话已过期或没有权限；可点右上角「下载」看原文件。" />
      </div>
    )
  }
  return (
    <div className="ws__image">
      <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </div>
  )
}

/** 虚拟滚动：每行固定高度（px）—— 必须与 CSS `.ws__tree-row` 的 `height` 一致 */
const TREE_ROW_HEIGHT = 24
/** 视口上下各多渲染几行，减少快速滚动时的白屏 */
const TREE_OVERSCAN = 8
/** 每一层目录的缩进（px），与旧的 `.ws__tree .ws__tree { padding-left }` 同值 */
const TREE_INDENT = 12

/**
 * 资源管理器文件树：**虚拟滚动 + 单一右键菜单**（可折叠目录 + 当前文件高亮 + 拖拽移动到目录）。
 *
 * ⚠️ 只渲染**视口内**的行（压平逻辑见 `workspaceModel#flattenWorkspaceTree`）：几千个文件也只挂
 * 十几行 DOM。右键菜单由**容器上的一个 `Dropdown`** 承担（旧实现是**每行一个** —— 2534 行就有
 * 2536 个 `Dropdown` 实例）；`onContextMenu` 时按命中的行（`data-ws-path` / `data-ws-kind`）决定菜单项。
 *
 * ⚠️ **目录默认全部折叠**（产品要求 2026-10-14：不要一进来就把几千个文件全铺开）：状态记的是
 * "哪些目录**被展开**"（初始空集），而不是"哪些被折叠" —— 前者天然是"默认折叠"，后者要反着写。
 * 这份状态**按会话持久化**在 `stores/workspace.ts#expandedByConversation`（落 localStorage）：
 * 重进会话 / 刷新页面都记得住（与"标签是本次会话的临时选择"不同，浏览位置该被记住）。
 */
function WorkspaceTree(props: {
  conversationId: string
  nodes: readonly WorkspaceTreeNode[]
  selectedPath: string | null
  actions: TreeActions
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 被**展开**的目录（持久化在 store；初始为空 = 全部折叠，只看到顶层） */
  const expandedDirs = useWorkspaceExpandedDirs(props.conversationId)
  const toggleExpanded = useWorkspaceStore((state) => state.toggleExpanded)
  const expanded = useMemo(() => new Set(expandedDirs), [expandedDirs])
  /** 当前被拖到其上的目录（高亮落点） */
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  /** 视口（滚动位置 + 高度）—— 决定渲染哪一段行 */
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  /** 当前右键菜单（`null` = 还没右键过，用空白区菜单兜底） */
  const [menu, setMenu] = useState<MenuProps | null>(null)

  const rows = useMemo(
    () => flattenWorkspaceTree(props.nodes, (path) => !expanded.has(path)),
    [props.nodes, expanded],
  )

  // 监听滚动 / 尺寸：只更新视口，不动数据
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const update = (): void => setViewport({ top: el.scrollTop, height: el.clientHeight })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  const toggle = (path: string): void => toggleExpanded(props.conversationId, path)

  /**
   * 「复制」子菜单（**文件与目录同款**）。三个子项直接取自 `WORKSPACE_COPY_ITEMS`
   * —— 菜单文案与"复制出来到底是什么"同源一份，不会出现"写着相对路径、复制的是绝对路径"。
   */
  const copySubmenu = (): NonNullable<MenuProps['items']>[number] => ({
    key: 'copy',
    icon: <CopyOutlined />,
    label: '复制',
    children: WORKSPACE_COPY_ITEMS.map((item) => ({ key: `copy-${item.key}`, label: item.label })),
  })

  /** 命中的是不是「复制」子项 ⇒ 是就执行并回 `true`（调用方据此提前返回） */
  const handleCopyKey = (key: string, path: string): boolean => {
    const kind = WORKSPACE_COPY_ITEMS.find((item) => `copy-${item.key}` === key)?.key
    if (kind === undefined) return false
    props.actions.copy(kind, path)
    return true
  }

  const fileMenu = (path: string): MenuProps => ({
    items: [
      { key: 'open', label: '打开' },
      { key: 'rename', icon: <EditOutlined />, label: '重命名 / 移动' },
      { key: 'download', icon: <DownloadOutlined />, label: '下载' },
      { type: 'divider' },
      copySubmenu(),
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
    ],
    onClick: ({ key }) => {
      if (handleCopyKey(key, path)) return
      if (key === 'open') props.actions.open(path)
      else if (key === 'rename') props.actions.rename(path)
      else if (key === 'download') props.actions.download(path)
      else if (key === 'delete') props.actions.remove(path)
    },
  })

  const dirMenu = (dir: string): MenuProps => ({
    items: [
      { key: 'newFile', icon: <FileAddOutlined />, label: '新建文件' },
      { key: 'newFolder', icon: <FolderAddOutlined />, label: '新建文件夹' },
      { key: 'upload', icon: <UploadOutlined />, label: '上传文件到此目录' },
      { type: 'divider' },
      copySubmenu(),
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除文件夹', danger: true },
    ],
    onClick: ({ key }) => {
      if (handleCopyKey(key, dir)) return
      if (key === 'newFile') props.actions.newFile(dir)
      else if (key === 'newFolder') props.actions.newFolder(dir)
      else if (key === 'upload') props.actions.upload(dir)
      else if (key === 'delete') props.actions.removeDir(dir)
    },
  })

  const blankMenu: MenuProps = {
    items: [
      { key: 'newFile', icon: <FileAddOutlined />, label: '新建文件' },
      { key: 'newFolder', icon: <FolderAddOutlined />, label: '新建文件夹' },
      { key: 'upload', icon: <UploadOutlined />, label: '上传文件' },
    ],
    onClick: ({ key }) => {
      if (key === 'newFile') props.actions.newFile('')
      else if (key === 'newFolder') props.actions.newFolder('')
      else if (key === 'upload') props.actions.upload('')
    },
  }

  /** 右键：命中行（`data-ws-path`）按其类型出菜单，否则出根级菜单 */
  const onTreeContextMenu = (event: React.MouseEvent): void => {
    const hit = (event.target as HTMLElement).closest<HTMLElement>('[data-ws-path]')
    if (hit === null) {
      setMenu(blankMenu)
      return
    }
    const path = hit.dataset['wsPath'] ?? ''
    setMenu(hit.dataset['wsKind'] === 'dir' ? dirMenu(path) : fileMenu(path))
  }

  const onRootDragOver = (event: React.DragEvent): void => {
    if (!hasWorkspaceDrag(event)) return
    event.preventDefault()
    setRootDropActive(true)
  }
  const onRootDragLeave = (event: React.DragEvent): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return
    setRootDropActive(false)
  }
  const onRootDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setRootDropActive(false)
    const from = event.dataTransfer.getData(WS_DRAG_MIME)
    if (from !== '') props.actions.move(from, '')
  }

  // 只取视口内的一段（± overscan）；行按 `index × 行高` 绝对定位，撑出总高度
  const start = Math.max(0, Math.floor(viewport.top / TREE_ROW_HEIGHT) - TREE_OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / TREE_ROW_HEIGHT) + TREE_OVERSCAN)
  const slice = rows.slice(start, end)

  return (
    <Dropdown menu={menu ?? blankMenu} trigger={['contextMenu']}>
      <div
        ref={scrollRef}
        className={`ws__tree-scroll${rootDropActive ? ' is-drop' : ''}`}
        data-testid="workspace-tree"
        onContextMenu={onTreeContextMenu}
        onDragOver={onRootDragOver}
        onDragLeave={onRootDragLeave}
        onDrop={onRootDrop}
      >
        {rows.length === 0 ? (
          <p className="ws__hint" data-testid="workspace-empty">
            （空工作区；右键可新建文件 / 文件夹，或上传文件）
          </p>
        ) : (
          <ul className="ws__tree" style={{ height: rows.length * TREE_ROW_HEIGHT, position: 'relative' }}>
            {slice.map((row, offset) => {
              const index = start + offset
              const indent = { paddingLeft: `calc(var(--sp-3) + ${row.depth * TREE_INDENT}px)` }
              const position = {
                position: 'absolute' as const,
                top: index * TREE_ROW_HEIGHT,
                left: 0,
                right: 0,
                height: TREE_ROW_HEIGHT,
              }
              return (
                <li
                  key={row.node.path}
                  className={`ws__tree-item${dropDir === row.node.path ? ' is-drop' : ''}`}
                  style={position}
                >
                  {row.node.kind === 'dir' ? (
                    <button
                      type="button"
                      className="ws__tree-row ws__tree-row--dir"
                      data-ws-path={row.node.path}
                      data-ws-kind="dir"
                      style={indent}
                      onClick={() => toggle(row.node.path)}
                      onDragOver={(event) => {
                        if (!hasWorkspaceDrag(event)) return
                        event.preventDefault()
                        event.stopPropagation()
                        setDropDir(row.node.path)
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node)) return
                        setDropDir((current) => (current === row.node.path ? null : current))
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setDropDir(null)
                        const from = event.dataTransfer.getData(WS_DRAG_MIME)
                        if (from !== '') props.actions.move(from, row.node.path)
                      }}
                    >
                      <span className="ws__chevron">
                        {expanded.has(row.node.path) ? <DownOutlined /> : <RightOutlined />}
                      </span>
                      {expanded.has(row.node.path) ? <FolderOpenOutlined /> : <FolderOutlined />}
                      <span className="ws__tree-name">{row.node.name}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`ws__tree-row${props.selectedPath === row.node.path ? ' is-active' : ''}`}
                      data-ws-path={row.node.path}
                      data-ws-kind="file"
                      style={indent}
                      title={`${row.node.path} · ${formatBytes(row.node.entry.size)}`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(WS_DRAG_MIME, row.node.path)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onClick={() => props.actions.open(row.node.path)}
                    >
                      <span className="ws__chevron" />
                      <FileGlyph path={row.node.path} />
                      <span className="ws__tree-name">{row.node.name}</span>
                      {/* 行内尺寸读数（P1-15）：与状态栏同一口径（`formatBytes`），浏览时一眼看到大小 */}
                      <span className="ws__tree-size num">{formatBytes(row.node.entry.size)}</span>
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dropdown>
  )
}
