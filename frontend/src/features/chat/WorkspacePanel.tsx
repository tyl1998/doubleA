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
  QuestionCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  CloudUploadOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  WORKSPACE_ACTOR_KEY,
  isWorkspaceHiddenPath,
  isWorkspaceTextMime,
  type WorkspaceChangeEntry,
  type WorkspaceDiffLine,
  type WorkspaceEventItem,
  type WorkspaceRevertResult,
  type WorkspaceRevertScope,
  type WorkspaceRevertSkipReason,
  type WorkspaceRetentionInfo,
  type PreviewKind,
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
  uploadWorkspaceArtifact,
  uploadWorkspaceFile,
  useWorkspaceGit,
  useWorkspaceTree,
  workspaceDirZipUrl,
  workspaceFileDiffQueryKey,
  workspaceFileQueryKey,
  workspaceGitQueryKey,
  useWorkspaceRetention,
  workspaceRawUrl,
  workspaceRenderUrl,
  workspaceTreeQueryKey,
} from '../../api/workspace.js'
import { conversationArtifactsQueryKey } from '../../api/artifacts.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
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
  isGitInternalPath,
  isWorkspacePathInDir,
  WORKSPACE_RECENT_MAX_PER_GROUP,
  WORKSPACE_RETENTION_NOTICE_DAYS,
  groupWorkspaceChangesByRound,
  mergeWorkspaceChanges,
  revertActionLabel,
  revertSummaryText,
  toggleExpandedDir,
  workspacePreviewKindOf,
  workspaceAncestorDirs,
  workspaceBaseName,
  workspaceChangeGrouping,
  retentionDaysLeft,
  workspaceCopyValue,
  workspaceDiffScope,
  workspaceEditorLanguage,
  workspaceGitChipLabel,
  workspaceGitChipTitle,
  workspaceLanguageLabel,
  workspaceMoveTargetPath,
  workspaceNewFolderPlaceholderPath,
  workspaceParentDir,
  workspaceResolvePromptPath,
  joinWorkspacePath,
  workspaceCopyItems,
  WORKSPACE_COPY_ITEM_KEYS,
  type WorkspaceCopyKind,
  type WorkspaceFileIconKind,
  type WorkspaceTreeNode,
} from './workspaceModel.js'

/** 空目录集合（"全部折叠"的展开状态；`resetKey` 非 0 且用户还没点过目录时用它） */
const EMPTY_DIRS: readonly string[] = []

/** 会话头 Code 模式开关（新会话态也能开 —— 先把意图记在本地，建出会话后落地；见 `ChatPage`） */
export function CodeModeSwitch(props: {
  conversationId: string | undefined
  enabled: boolean
  loading: boolean
  onToggle: (enabled: boolean) => void
}) {
  const { t } = useT()
  return (
    <Switch
      size="small"
      checked={props.enabled}
      loading={props.loading}
      checkedChildren={t('workspace.codeModeOn')}
      unCheckedChildren={t('workspace.codeModeOff')}
      onChange={props.onToggle}
      title={
        props.conversationId === undefined
          ? t('workspace.codeModeTitleNew')
          : t('workspace.codeModeTitleExisting')
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
  /** 「下载为 zip」：把这个目录（含子孙）打包下载（2026-10-29） */
  downloadDir: (dir: string) => void
  /** 「上传至平台」：把这个工作区文件登记成产物（2026-10-29；Code 模式不再自动收产物） */
  uploadArtifact: (path: string) => void
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
  /** 用户点名的实例（P1-14 多机；`null` = 自动） */
  preferredInstance?: string | null
  onPreferredInstanceChange?: (instanceId: string | null) => void
}

export function WorkspacePanelPlaceholder(props: WorkspaceRuntimeControls) {
  const { t } = useT()
  return (
    <div className="ws" data-testid="workspace-panel-placeholder">
      <header className="ws__head">
        <span className="ws__icon-btn ws__icon-btn--static" title={t('workspace.explorer')} aria-hidden="true">
          <FolderOutlined />
        </span>
        <span className="ws__title">{t('workspace.title')}</span>
        <div className="u-right">
          {/* 新会话态也能选运行时：会话建出来前先记意图、开流前落地（见 ChatPage#runtimePresetRef） */}
          <RuntimeSelect
            runtime={props.runtime}
            pending={props.runtimePending}
            onSelect={props.onSelectRuntime}
            preferredInstance={props.preferredInstance ?? null}
            onPreferredInstanceChange={props.onPreferredInstanceChange}
          />
        </div>
      </header>
      <div className="ws__body">
        <div className="ws__empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workspace.placeholderEmpty')} />
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
  const { t, locale } = useT()
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
  /**
   * 从「最近变更」点开文件时带来的**版本范围**（`本轮` / `更早` 各一条，同路径出现两次时靠它区分）。
   *
   * ★ 2026-10-28（用户定案）：「同一路径出现两次，需要标明各自版本范围（**点击文件后展示**，
   *   在文件列表里展示会把文件名都盖住）」。所以这里只在**打开该文件之后**、编辑器工具栏上
   *   显示 `本轮 · v3 → v5` 这样的胶囊；列表行里不写版本范围。
   *   换文件 / 从文件树打开 / 关标签时清掉（范围属于那条变更，不属于文件本身）。
   */
  const [openedRange, setOpenedRange] = useState<{
    path: string
    segment: 'current' | 'earlier'
    from: number | null
    to: number
  } | null>(null)
  /**
   * 正在查看差异的文件 + 它的版本（`null` = 弹窗关着）。
   *
   * ★ 2026-10-27：以前只存 path，弹窗的 query key 里**没有版本** ⇒ 同一文件再看一次时
   *   key 不变，react-query 直接回旧缓存（文件已经又改过），显示的还是上一次的 diff。
   *   把版本一起带上，key 才真正代表"这一条变更"。
   */
  const [diffTarget, setDiffTarget] = useState<{
    path: string
    version: number | null
    beforeVersion?: number | null
    /**
     * 这条属于哪一段（`current` = 本轮 / `earlier` = 更早）。
     *
     * ★ 2026-10-28（用户定案）：同一路径两段都动过时列表里是**两条**，点开必须看到**各自那一段**
     *   的版本范围，而不是同一个"很久以前 → 现在"。段决定基线怎么取、比到哪个版本。
     */
    segment?: 'current' | 'earlier'
  } | null>(null)
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
  // 2026-10-28: 保留期提示（还有几天清理、到期会不会被保护）—— 提前告知，避免静默真删。
  const retentionQuery = useWorkspaceRetention(conversationId, codeMode)
  const retention = retentionQuery.data
  const [retentionDismissed, setRetentionDismissed] = useState(false)
  /**
   * 工作区**此刻是否已经"定型"**（P1-24，2026-10-27）—— 一次 `git clone` / `git pull` 还没跑完时
   * 它是 `false`，面板据此按"原始根"展示：树**不自动展开**、也不实时拉文件树。
   *
   * 为什么要它（用户反馈：「git 拉取下来目录又是默认全部展开了」）：`clone --depth` 期间工作区
   * 在几十秒里长出几千个文件，每一条 `created` 事件都会 `expandDirs(它的所有祖先目录)`
   * ⇒ clone 一结束，「repo/」下面几十个目录全是展开的（实测该会话 308 个祖先目录全部进了
   * `doubulea.ws-expanded`，且这份状态还持久化在 localStorage）。而用户要的是"clone 完看到 repo/，
   * 里面自己展开"。所以：**克隆期间不接收"新文件到了"这个信号**，等 git 把锁文件删掉再正常一轮。
   */
  const workspaceReady = gitRepos.every((repo) => !repo.cloning)
  const treeNodes = useMemo(() => buildWorkspaceTree(treeQuery.data?.items ?? []), [treeQuery.data])
  const visibleNodes = useMemo(() => filterWorkspaceTree(treeNodes, showHidden), [treeNodes, showHidden])
  const fileCount = useMemo(() => treeQuery.data?.items.length ?? 0, [treeQuery.data])

  // ── 当前标签的读 ──
  const fileQuery = useQuery({
    queryKey: workspaceFileQueryKey(conversationId, activePath ?? ''),
    queryFn: ({ signal }) => fetchWorkspaceFile(conversationId, activePath ?? '', { signal }),
    enabled: codeMode && activePath !== null,
    // 内存优化 P4（`docs/子方案/前端长会话内存优化.md`）：一份正文最大 1 MiB —— 标签关掉之后
    // 没有任何人还会读它，别让它在缓存里躺满全局默认的 5 分钟。
    gcTime: 60_000,
  })

  // ── 按路径的编辑态 ──
  const [docs, setDocs] = useState<Record<string, WorkspaceDoc>>({})
  const [savingPath, setSavingPath] = useState<string | null>(null)
  /** 正在「上传至平台」的路径（按钮态；同一时刻只允许一个，避免重复点产生两份产物行） */
  const [uploadingArtifact, setUploadingArtifact] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)

  /**
   * 草稿只保留**还开着的标签**（内存优化 P4）。
   *
   * `docs` 里每条都是**两份**整篇正文（`text` + `baseText`）。标签被关掉之后它们没人读 ——
   * 但 `closeFile` 只是 store 上的一个动作，页面这边的 `docs` 不会自己变小（agent 侧删文件、
   * 「删除文件夹」、改名等路径都会让 `openPaths` 变短）。所以判据挂在 `openPaths` 上：
   * 它一变就裁一次，**一处覆盖所有"标签消失"的路径**。
   */
  useEffect(() => {
    setDocs((prev) => {
      const alive = new Set(openPaths)
      const keys = Object.keys(prev)
      if (keys.every((path) => alive.has(path))) return prev
      const next: Record<string, WorkspaceDoc> = {}
      for (const path of keys) {
        const doc = prev[path]
        if (alive.has(path) && doc !== undefined) next[path] = doc
      }
      return next
    })
  }, [openPaths])

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
  /**
   * 只读文件的预览形态（`null` = 没有在线预览，只给下载占位）。
   * ⚠️ 可编辑的一律走 CodeMirror，不经过它（判据只在 `workspacePreviewKindOf` 一处）。
   */
  const previewKind = editable || fileQuery.data === undefined ? null : workspacePreviewKindOf(fileQuery.data.mime)
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

  /**
   * 本端改完工作区之后**统一刷新一次**（保存 / 新建 / 删除 / 改名 / 上传 / 删目录都走它）。
   *
   * ★ 2026-10-28（用户定案「本轮改动 = 当前保存改动的内容，文件保存列表要同步更新呀」）：
   *   这些动作以前**只**刷了文件树 ——「最近变更」要等 SSE 事件或重新进会话才更新，于是刚保存完
   *   列表还是旧的（看起来"保存没生效"）。三样一起刷：树、差异（版本变了，徽标要重算）、变更清单。
   */
  const refreshAfterWrite = (): void => {
    void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
    void queryClient.invalidateQueries({ queryKey: ['workspace-diff', conversationId] })
    reloadChangesRef.current()
  }

  /**
   * 本端新建之后**让它看得见**（2026-10-29 用户实测"新建了 a/x.py，树里找不到"）。
   *
   * 两个坑叠在一起：
   *   · 文件树默认**折叠**（展开状态按目录持久化）⇒ 新目录的祖先若收着，建完还是一片安静；
   *   · 隐藏过滤（`.` 开头的段，含新建文件夹的 `.gitkeep` 占位）默认**开着** ⇒ 只含隐藏文件的
   *     新目录会被 `filterWorkspaceTree` 整枝滤掉。
   * 所以：①把这条路径的祖先目录（**含它自己**，目录才需要展开）全部展开；
   *       ②这条路径会被隐藏过滤掉的话，临时打开"显示隐藏文件"——用户刚亲手建的，不能"创建成功却看不见"。
   */
  const revealCreated = (path: string, kind: 'file' | 'dir'): void => {
    const dirs = kind === 'dir' ? [...workspaceAncestorDirs(path), path] : workspaceAncestorDirs(path)
    if (dirs.length > 0) expandDirs(conversationId, dirs)
    if (isWorkspaceHiddenPath(path)) setShowHidden(true)
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
      refreshAfterWrite()
      feedback.ok(t('workspace.savedOk'))
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
        feedback.fail(error, t('workspace.saveConflict'))
      } else {
        feedback.fail(error, t('workspace.saveFailed'))
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
      refreshAfterWrite()
      feedback.ok(t('workspace.deletedOk'))
    } catch (error) {
      feedback.fail(error, t('workspace.deleteFailed'))
    }
  }

  /** 右键「删除」：软删仍可在历史里找回，故确认一次即可 */
  const confirmRemove = (path: string): void => {
    modal.confirm({
      title: t('workspace.deleteFileTitle'),
      content: t('workspace.deleteFileContent', { path }),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
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
      refreshAfterWrite()
      feedback.ok(
        result.deleted > 0
          ? t('workspace.deleteDirOk', { count: result.deleted })
          : t('workspace.deleteDirOkPlain'),
      )
    } catch (error) {
      feedback.fail(error, t('workspace.deleteDirFailed'))
    }
  }

  /** 右键「删除文件夹」：递归软删仍可在历史里找回，故确认一次即可（但明示"整目录递归"） */
  const confirmRemoveDir = (dir: string): void => {
    modal.confirm({
      title: t('workspace.deleteDirTitle'),
      content: t('workspace.deleteDirContent', { dir }),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => removeDir(dir),
    })
  }

  /**
   * 新建文件（`POST .../workspace/file`）：成功后刷新树并直接打开它
   *
   * ★ 2026-10-29（实测）：`a/` 下新建后树里看不到 —— 除 `.gitkeep` 外没有任何文件的分支（以及
   *   `.` 开头目录，如 `a/.b/x.py`）默认被 `filterWorkspaceTree` 隐藏；而且**折叠状态不回退**：
   *   新目录的祖先若在折叠集合里，建完仍是收起的。所以建完要 ①展开目标目录（已有祖先也展开）
   *   ②本次新建路径若被隐藏过滤掉，就临时打开"显示隐藏文件"（否则"创建成功却看不见"）。
   */
  const createFile = async (path: string): Promise<void> => {
    setPrompt(null)
    try {
      await createWorkspaceFile(conversationId, path)
      revealCreated(path, 'file')
      refreshAfterWrite()
      openFile(conversationId, path)
      feedback.ok(t('workspace.createdOk'))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') feedback.fail(error, t('workspace.sameNameFile'))
      else feedback.fail(error, t('workspace.createFailed'))
    }
  }

  /**
   * 新建文件夹：工作区模型里**空目录不算内容**（树由文件路径派生），故落一个隐藏占位文件
   * （`.gitkeep`）让目录可见 —— 与 git 保留空目录同一手法。
   *
   * ★ 2026-10-29：`dir` 是**已解析好的最终目录**（调用方已按右键目标去掉重复前缀），
   *   所以这里只负责在它下面落占位，不再自己拼父目录；建完同样要展开 + 必要时显示隐藏文件，
   *   否则"新建了文件夹却没出现"（`.gitkeep` 是隐藏文件，默认被过滤）。
   */
  const createFolder = async (dir: string): Promise<void> => {
    setPrompt(null)
    const placeholder = workspaceNewFolderPlaceholderPath(workspaceParentDir(dir), workspaceBaseName(dir))
    try {
      await createWorkspaceFile(conversationId, placeholder)
      revealCreated(dir, 'dir')
      refreshAfterWrite()
      feedback.ok(t('workspace.folderCreatedOk'))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') feedback.fail(error, t('workspace.sameNameFolder'))
      else feedback.fail(error, t('workspace.folderCreateFailed'))
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
      // ★ 2026-10-29：移到收起的目录 / 隐藏目录后同样会"改名成功却找不到"（同 `revealCreated`）
      revealCreated(to, 'file')
      refreshAfterWrite()
      feedback.ok(t('workspace.renamedOk'))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') feedback.fail(error, t('workspace.targetExists'))
      else feedback.fail(error, t('workspace.renameFailed'))
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
        // ★ 2026-10-29：上传到收起的目录 / 隐藏目录也要立刻看得见（同 `revealCreated`）
        revealCreated(joinWorkspacePath(dir, file.name.split(/[\\/]/u).pop() ?? file.name), 'file')
      } catch (error) {
        feedback.fail(error, t('workspace.uploadFailed', { name: file.name }))
      }
    }
    if (okCount > 0) {
      refreshAfterWrite()
      feedback.ok(t('workspace.uploadedOk', { count: okCount }))
    }
  }

  /**
   * 右键「上传至平台」（2026-10-29）：把这个工作区文件登记成**产物**。
   *
   * 为什么是显式动作：Code 模式下 agent 改过的文件由工作区面板完整呈现，"哪些算产物"在那里无法
   * 可靠判定（clone 的整棵树 / build 目录 / 下载的压缩包都会混进来）⇒ 服务端不再自动收；
   * 要让文件进产物面板（可预览 / 可下载 / 会话产物清单），由人点这一下。
   * 成功后刷新产物列表（`conversationArtifactsQueryKey`）—— 面板不在 Code 模式下也预取好。
   */
  const uploadArtifact = async (path: string): Promise<void> => {
    // 同一时刻只跑一个：连点两次会建两条产物行（服务端不去重，字节相同但行不同）
    if (uploadingArtifact !== null) return
    setUploadingArtifact(path)
    try {
      await uploadWorkspaceArtifact(conversationId, path)
      feedback.ok(t('workspace.artifactUploadedOk', { name: workspaceBaseName(path) }))
      void queryClient.invalidateQueries({ queryKey: conversationArtifactsQueryKey(conversationId) })
    } catch (error) {
      feedback.fail(error, t('workspace.artifactUploadFailed', { name: workspaceBaseName(path) }))
    } finally {
      setUploadingArtifact(null)
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
   * 目录行右键「下载为 zip」（2026-10-29）：把该目录（含子孙）打包一次下载。
   *
   * 用 `<a download>` 直接打服务端字节出口（`GET .../workspace/dir/zip`）—— 打包在服务端做，
   * 前端不必把整包读进内存；文件数超上限时服务端回信封（浏览器会显示下载失败），
   * 这是可接受的：真要在前端重做一次才能给出友好提示，而那种情况很少见。
   */
  const downloadDir = (dir: string): void => {
    const link = document.createElement('a')
    link.href = workspaceDirZipUrl(conversationId, dir)
    link.download = `${workspaceBaseName(dir) || 'workspace'}.zip`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  /**
   * 「撤销本轮」（P1-9 · P4 · R2；2026-10-28 重做**范围选择**）。
   *
   * ★ 2026-10-28 用户定案（「撤销怎么选」）：不再一点就撤。顺序是
   *   ① **先预演**（`dryRun`）拿三栏：会还原 / 会删除 / 会跳过（含"故意不动你的手写"）；
   *   ② 让用户选范围：**默认只撤 agent**，可显式切「包含我的修改」或**逐条勾选**；
   *   ③ 再真正落盘，并把结果逐条列出。
   *   为什么必须预演：以前是盲撤 —— 用户看不到范围，点下去才知道撤了什么。
   */
  const revert = (): void => {
    void (async () => {
      setReverting(true)
      try {
        const preview = await revertWorkspaceRound(conversationId, { dryRun: true })
        const current = grouped.current
        modal.confirm({
          title: t('workspace.revertChooseTitle'),
          width: 620,
          okText: t('workspace.revertOk'),
          cancelText: t('workspace.revertCancel'),
          content: (
            <RevertScopeDialog
              preview={preview}
              currentPaths={current.map((change) => change.path)}
              defaultSelected={current.filter((change) => change.actor !== 'USER').map((change) => change.path)}
            />
          ),
          onOk: async () => {
            // 弹窗里选了什么由 `RevertScopeDialog` 写到 DOM 上（AntD confirm 无受控 state）
            const picked = readRevertScopeChoice()
            const result = await revertWorkspaceRound(conversationId, {
              scope: picked.scope,
              ...(picked.scope === 'SELECTED' ? { paths: picked.paths } : {}),
            })
            modal.info({
              title: t('workspace.revertDoneTitle'),
              width: 560,
              okText: t('workspace.revertAck'),
              content: (
                <div data-testid="revert-report">
                  <p className="ws__revert-summary">{revertSummaryText(result, locale)}</p>
                  {result.items.length > 0 && (
                    <ul className="ws__revert-list">
                      {result.items.map((item) => (
                        <li key={`${item.action}:${item.path}`} className="ws__revert-item">
                          <span className={`ws__revert-action ws__revert-action--${item.action}`}>
                            {revertActionLabel(item.action, locale)}
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
            // ★ 2026-10-27（用户反馈「点撤销本轮也没有恢复」）：撤销**改了盘上的字节**，所以清单里的
            //   版本号、`+N −M` 徽标、差异弹窗全都作废了。以前只刷了树和正文缓存，这三样还留旧值 ——
            //   文件其实已经回滚，界面却仍显示"改过 v9"，看起来就是「没恢复」。
            void queryClient.invalidateQueries({ queryKey: ['workspace-diff', conversationId] })
            reloadChangesRef.current()
          },
          onCancel: () => undefined,
        })
      } catch (error) {
        feedback.fail(error, t('workspace.revertFailed'))
      } finally {
        setReverting(false)
      }
    })()
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
  /** 本轮窗口（服务端随变更集一起回；`undefined` = 该会话还没派过活） */
  const [serverRound, setServerRound] = useState<{ start: string; end?: string } | undefined>(undefined)
  /**
   * 重取上面那份基线（**给"保存 / 撤销本轮"用**）。
   *
   * ★ 2026-10-27（用户反馈「撤销本轮也没有恢复」「变更信息不是最新的」）：这份基线原来只在
   *   **进会话时取一次**，之后再不刷新 —— 于是文件改回去 / 被撤销之后，`serverChanges` 里那条
   *   `updated vN` 还在，`mergeWorkspaceChanges` 又按 `at` 取最新，列表**永远显示旧的**。
   *   撤销完文件明明已经回到原样，界面却还说"改过"，看起来就是「没恢复」。
   */
  const reloadChangesRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!codeMode) return
    let cancelled = false
    const load = (): void => {
      void fetchWorkspaceChanges(conversationId)
        .then((result) => {
          if (cancelled) return
          setServerChanges(result.items)
          setServerRound(result.round)
        })
        .catch(() => undefined)
    }
    reloadChangesRef.current = load
    load()
    return () => {
      cancelled = true
      reloadChangesRef.current = () => undefined
    }
  }, [conversationId, codeMode])
  /**
   * 切会话 / 面板卸载时把**本会话的正文缓存整份收掉**（内存优化 P4）。
   *
   * 三层都要清，缺一层就漏：
   *   · 页面里的 `docs`（草稿 + 基线，两份整篇）；
   *   · react-query 的 `['workspace-file', conversationId, *]`（每打开过一个文件就有一份）；
   *   · 差异查询 `['workspace-diff', conversationId, *]`（行级差异也不小）。
   * 切走再回来是重新读一次文件 —— 这是**正确的**：回来时服务端可能已经变了，缓存本来也不该
   * 跨"离开"这一段时间被当成真相。
   */
  useEffect(() => {
    // ⚠️ 先清掉**上一个会话**留下的那一份（effect 重跑时闭包里拿到的仍是旧 `conversationId`，
    //    这正是我们要清的那一份）；本次会话那份由**下一次**重跑 / 卸载负责。
    setDocs({})
    // 「最近变更」点开文件带来的版本范围只属于上一个会话的某条变更 ⇒ 一并清掉
    setOpenedRange(null)
    queryClient.removeQueries({ queryKey: ['workspace-file', conversationId] })
    queryClient.removeQueries({ queryKey: ['workspace-diff', conversationId] })
    return () => {
      setDocs({})
      queryClient.removeQueries({ queryKey: ['workspace-file', conversationId] })
      queryClient.removeQueries({ queryKey: ['workspace-diff', conversationId] })
    }
  }, [conversationId, queryClient])

  const activePathRef = useRef<string | null>(activePath)
  activePathRef.current = activePath
  /**
   * 事件回调里读"此刻是否已定型"（P1-24）。用 ref 而不是把 `workspaceReady` 放进依赖 ——
   * 放进依赖会让 SSE 在"clone 开始 / 结束"各重连一次，断开那一下正好会丢事件。
   */
  const readyRef = useRef(true)
  readyRef.current = workspaceReady
  useEffect(() => {
    if (!codeMode) return
    const controller = new AbortController()
    void streamWorkspaceEvents(conversationId, {
      signal: controller.signal,
      onEvent: (event) => {
        setRecentEvents((prev) => [...prev.slice(-199), event])
        if (!isContentEvent(event)) return
        // ★ clone / pull 进行中**不接收**"新文件到了"这个信号（P1-24）：
        //   否则几千条 `created` 各自展开祖先目录，clone 一结束整棵树就是全展开的（用户反馈）。
        //   锁文件一消失 `readyRef` 就变回 true，之后的改动照旧自动展开。
        if (readyRef.current) {
          // agent 改了某个文件 ⇒ 自动展开它所在的目录：文件树**默认全折叠**（`WorkspaceTree`），
          // 不展开就看不见深处的新文件（用户反馈："agent 新增/编辑过的文件没有展示"）。
          const dirs = workspaceAncestorDirs(event.path)
          if (dirs.length > 0) expandDirs(conversationId, dirs)
          // ★ 2026-10-27（用户反馈「编辑后再改，变更里展示的 diff 不是最新的」）：
          //   `['workspace-diff', …]` 以前**从没被失效过** —— 只有「切会话」才 removeQueries。
          //   于是 `RecentChangeRow` 的 `+N −M` 徽标与差异弹窗一直吃旧缓存（徽标还带 staleTime: 30s），
          //   文件内容变了、条目版本也变了，数字却停在第一次算出来的那一份。
          //   按**路径前缀**失效：只动这个文件的那几条（版本号是 key 的第 4 段）不影响别的文件。
          void queryClient.invalidateQueries({ queryKey: ['workspace-diff', conversationId, event.path] })
          // 服务端那份「最近变更」基线也要跟着重取：否则文件被改回去/撤销后，列表还挂旧条目。
          // ⚠️ 放在 `readyRef` 里面：clone 期间几千条事件，逐条重取会把面板打爆（那时列表本就是空的）。
          reloadChangesRef.current()
        }
        void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
        // 分支可能刚被换成别的（`git checkout` 会写 `.git/HEAD` ⇒ 也是工作区事件）⇒ 一并失效；
        // ⚠️ 连 clone 的锁状态一起刷（`readyRef` 的输入就是它，不刷就永远等不到"结束"）。
        void queryClient.invalidateQueries({ queryKey: workspaceGitQueryKey(conversationId) })
        // ⚠️ 这里**不要**再重复失效 diff / 重取变更：上面 `readyRef.current` 分支里已经做过，
        //   重复一遍会在 clone 期间把「最近变更」的请求量翻倍（2026-10-29 review 修正）。
        if (event.type === 'deleted' && (useWorkspaceStore.getState().tabsByConversation[conversationId]?.openPaths ?? []).includes(event.path)) {
          closeFile(conversationId, event.path)
          return
        }
        if (eventTouchesPath(event, activePathRef.current)) void fileQuery.refetch()
      },
      onIssue: () => undefined,
    }).catch(() => undefined)
    return () => controller.abort()
    // 只在会话 / 开关变化时重连（`fileQuery.refetch` / `closeFile` / `expandDirs` / `readyRef` 通过 ref 与稳定引用）
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
  //
  // ★ P1-24（2026-10-27，用户反馈「git 都没变更，为什么拉取下来那些算变更」）：
  //   `git clone` / `git pull` 会在工作区里**新建**（或改写）每一个文件 —— 对工作区来说它们
  //   确实是 `created`/`updated` 事件，于是整棵仓库都进了这份清单。但那不是"谁改了代码"，
  //   是"仓库只是被拉下来了"。所以：**clone/pull 进行中产生的变更不进「最近变更」**
  //   （`workspaceReady` 为 false 的那段窗口；判据见 `useWorkspaceGit` 的 `cloning`）。
  //   拉完之后 agent 真正改的文件照常显示。
  // ★ 2026-10-28（用户反馈「clone 期间列表突然空了又满了」）：
  //   **不再**在 clone 期间把整份列表清空。clone 只是"新内容正在进来"，用户已有的改动
  //   （尤其手写的）没有任何理由消失。改用 `syncing` 标记：列表照常显示，只是标题旁提示"同步中"。
  //   ⚠️ 多仓库时按仓库各自判就绪 ⇒ 一个仓库在 clone 不影响另一个仓库的条目。
  const grouped = useMemo(() => {
    const merged = mergeWorkspaceChanges(serverChanges, recentEvents).filter(
      // `.git/**` 是 git 自己的中间产物（对象 / 索引 / 锁文件），不是"谁改了代码"。
      // ⚠️ 别把 `.doubulea/**` 也剔掉：记忆文档是**真实写入**，属工作区改动（2026-10-28 用户指正）。
      (change) => !isGitInternalPath(change.path),
    )
    const all = groupWorkspaceChangesByRound(merged, serverRound)
    return {
      current: all.current.slice(0, WORKSPACE_RECENT_MAX_PER_GROUP),
      earlier: all.earlier.slice(0, WORKSPACE_RECENT_MAX_PER_GROUP),
      /** 本轮 / 更早的**真实**条数（截断前；标题用真实数字，截断才看得见） */
      currentTotal: all.current.length,
      earlierTotal: all.earlier.length,
      /**
       * 展示口径（`workspaceChangeGrouping`，纯函数）：
       * `history` = 本会话从没出现过 agent 改动 ⇒ 这是**你的编辑历史**，不切成「本轮 / 更早」。
       */
      grouping: workspaceChangeGrouping(merged),
    }
  }, [serverChanges, recentEvents, serverRound])
  const changes = useMemo(
    () => [...grouped.current, ...grouped.earlier],
    [grouped],
  )

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
      .then(() => feedback.ok(t('workspace.copiedOk', { value })))
      .catch((error: unknown) => feedback.fail(error, t('workspace.copyFailed')))
  }

  /** 文件树右键 / 拖拽要用的动作集合（下传给 `WorkspaceTree`） */
  const treeActions: TreeActions = {
    open: (path) => {
      // 从文件树打开 = 只是看文件，不带"某条变更的版本范围"（那条范围属于「最近变更」里的那一条）
      setOpenedRange(null)
      openFile(conversationId, path)
    },
    rename: (path) => setPrompt({ mode: 'rename', path }),
    remove: confirmRemove,
    removeDir: confirmRemoveDir,
    download: downloadPath,
    downloadDir,
    uploadArtifact: (path) => void uploadArtifact(path),
    copy: copyPath,
    newFile: (dir) => setPrompt({ mode: 'createFile', dir }),
    newFolder: (dir) => setPrompt({ mode: 'createFolder', dir }),
    upload: pickUpload,
    move: (from, dir) => void moveToDir(from, dir),
  }

  if (!codeMode) {
    return <Empty description={t('workspace.notCodeMode')} />
  }

  const language = activePath === null ? 'text' : workspaceEditorLanguage(activePath)

  /** 弹窗初始值：重命名 = 原路径；新建 = 目标目录加尾斜杠（空目录 = 根，空串） */
  const promptInitial =
    prompt === null ? '' : prompt.mode === 'rename' ? prompt.path : prompt.dir === '' ? '' : `${prompt.dir}/`

  /**
   * ★ 2026-10-29（用户反馈"新目录 a 里建的文件看不到"）：`WorkspacePathPrompt` 的 `initialValue`
   *   是**字符串 prop**，`useState(props.initialValue)` 只在首次挂载取值。输入框原本常驻挂载，
   *   上一次弹窗的值就成了下一次的初值 —— 右键 `b` 新建时框里还是上一次的 `a/`，
   *   看一眼"没预填"就补输入，于是又落到旧目录里。
   *   与 `WorkspaceDiffModal` 同款处理：目标为空就整块不挂载（`destroyOnClose` 只是卸载内部 DOM，
   *   组件自己的 `useState` 不会跟着重置）。
   */
  const promptOpen = prompt !== null

  /**
   * 版本范围胶囊（「最近变更」点开文件后展示）。
   *
   * ★ 2026-10-28（用户定案）：同一路径两段都动过时列表里是两条，各自的版本范围**点击文件后**展示
   *   ——放在列表里会把文件名遮住。所以挂在编辑器工具栏的路径后面，且只在"当前打开的就是那条
   *   变更的路径"时出现；换文件 / 从文件树打开 / 关标签都会清掉。
   */
  const visibleRange =
    openedRange !== null && openedRange.path === activePath ? openedRange : null

  return (
    <div className="ws" data-testid="workspace-panel">
      <header className="ws__head">
        <span className="ws__icon-btn ws__icon-btn--static" title={t('workspace.explorer')} aria-hidden="true">
          <FolderOutlined />
        </span>
        <span className="ws__title">{t('workspace.title')}</span>
        <div className="u-right">
          {/* 运行时选择（P1-17a）：建容器（派活）时用哪份预烘焙镜像；下次派活生效 */}
          <RuntimeSelect
            runtime={runtimeControls.runtime}
            pending={runtimeControls.runtimePending}
            onSelect={runtimeControls.onSelectRuntime}
            preferredInstance={runtimeControls.preferredInstance ?? null}
            onPreferredInstanceChange={runtimeControls.onPreferredInstanceChange}
          />
          {/*
            ★ 2026-10-28（浏览器实测发现）：这里原来套着 `Popconfirm`（"撤销本轮？…"），
            一确认就直接落盘 —— 我新加的「范围选择 + 预演」弹窗根本没机会出现。
            现在**去掉确认气泡**，按钮直接进入 `revert()`：先 `dryRun` 预演，再让用户选范围。
            旧气泡文案（`revertConfirmTitle`/`revertConfirmDescription`）已无人使用。
          */}
          <Button
            size="small"
            icon={<UndoOutlined />}
            loading={reverting}
            data-testid="workspace-revert"
            onClick={() => revert()}
          >
            {t('workspace.revertButton')}
          </Button>
        </div>
      </header>

      {/*
        ★ 2026-10-29（用户反馈「点击上传至平台后提示成功，但刷新后看不到」）：
        「上传至平台」是**一次真实的 S3 上传 + 建行**，大文件 / 网络慢时会持续几秒到几十秒；
        以前只弹一个成功 toast，用户以为已经存好了，刷新（或看产物面板）却是空的。
        现在给出**持续可见**的进行中提示（文件名 + 转圈），完成才换成成功 toast。
      */}
      {uploadingArtifact === null ? null : (
        <div className="ws__upload-notice" data-testid="workspace-artifact-uploading">
          <Spin size="small" />
          <span>{t('workspace.artifactUploading', { name: workspaceBaseName(uploadingArtifact) })}</span>
        </div>
      )}

      <div className="ws__body">
        {/* 资源管理器：**常驻整宽**（不再折叠成 44px 图标条 —— 折叠态形态别扭，用户反馈去掉）；
            树行右键出菜单、可拖拽移动到目录；空白区右键 = 根目录级的新建 / 上传 */}
        <div className="ws__explorer">
          <div className="ws__explorer-head">
            <span className="ws__explorer-title">{t('workspace.explorer')}</span>
              <span className="u-right ws__explorer-actions">
                <button
                  type="button"
                  className="ws__icon-btn"
                  onClick={() => setPrompt({ mode: 'createFile', dir: '' })}
                  title={t('workspace.newFile')}
                >
                  <FileAddOutlined />
                </button>
                <button
                  type="button"
                  className={`ws__icon-btn${showHidden ? ' is-on' : ''}`}
                  onClick={() => setShowHidden((value) => !value)}
                  title={showHidden ? t('workspace.hideDotFiles') : t('workspace.showDotFiles')}
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
              // P1-24：clone / pull 还没跑完 ⇒ 一律按"原始根"展示（不读本会话的展开状态）
              resetKey={workspaceReady ? 0 : 1}
              uploadingArtifact={uploadingArtifact !== null}
            />
          )}

            {/* 2026-10-28: 保留期提示 —— 只在「快到清理时间且不会被保护」时出现，可关闭。 */}
            {retention !== undefined && !retentionDismissed && retention.expiresAt !== null && (
              <RetentionNotice
                info={retention}
                daysLeft={retentionDaysLeft(retention.expiresAt, Date.now())}
                onDismiss={() => setRetentionDismissed(true)}
              />
            )}

            {changes.length > 0 && (
              <div className={`ws__recent${recentOpen ? ' is-open' : ''}`}>
                {/*
                  ★ 2026-10-28（用户定案）：按轮分组 —— 「本轮」= `at >= 轮起点`，其余归「更早」。
                  两段各自最多 `WORKSPACE_RECENT_MAX_PER_GROUP` 条，标题直接给**真实条数**，
                  所以"被截断"这件事是看得见的（不再是一个看不出所以然的 `最近变更 8`）。
                */}
                {/*
                  ★ 2026-10-28（用户要求）：「最近变更」的口径说明不再占一行正文，改成标题右侧的
                  **? 图标**，悬浮/聚焦时用 Tooltip 展示完整说明。正文只在展开时保留一句极短的
                  分组提示（避免长句把列表挤下去）。
                */}
                <div className="ws__recent-head-row">
                  <button
                    type="button"
                    className="ws__recent-head"
                    aria-label={
                      grouped.grouping === 'history'
                        ? t('workspace.changeHistory', { count: changes.length })
                        : t('workspace.recentChanges', { count: changes.length })
                    }
                    onClick={() => setRecentOpen((open) => !open)}
                  >
                    <RightOutlined className="ws__chevron" rotate={recentOpen ? 90 : 0} />{' '}
                    {/* ★ 2026-10-28：纯手写会话叫「变更历史」，不编造「本轮」 */}
                    {grouped.grouping === 'history'
                      ? t('workspace.changeHistory', { count: changes.length })
                      : t('workspace.recentChanges', { count: changes.length })}
                    {grouped.grouping !== 'history' && grouped.current.length > 0 && (
                      <span className="ws__recent-badge">
                        {t('workspace.recentCurrentCount', { count: grouped.currentTotal })}
                      </span>
                    )}
                  </button>
                  <Tooltip
                    title={
                      grouped.grouping === 'history'
                        ? t('workspace.changeHistoryHint')
                        : t('workspace.recentChangesHint')
                    }
                    placement="left"
                  >
                    <button
                      type="button"
                      className="ws__recent-help"
                      aria-label={t('workspace.recentChangesHint')}
                      data-testid="recent-changes-help"
                      onClick={(e) => e.preventDefault()}
                    >
                      <QuestionCircleOutlined />
                    </button>
                  </Tooltip>
                </div>
                {!workspaceReady && (
                  <p className="ws__recent-syncing" data-testid="recent-syncing">
                    {t('workspace.recentSyncing')}
                  </p>
                )}
                {recentOpen && (
                  <>
                    {grouped.grouping === 'history' && (
                      <>
                        <p className="ws__recent-group" data-testid="recent-group-history">
                          {t('workspace.changeHistory', { count: grouped.earlierTotal })}
                        </p>
                        <ul className="ws__recent-list">
                          {grouped.earlier.map((change) => (
                            <RecentChangeRow
                              key={`history-${change.path}-${change.at}`}
                              conversationId={conversationId}
                              change={change}
                              onOpenFile={() => {
                                setOpenedRange(null)
                                openFile(conversationId, change.path)
                              }}
                              onOpenDiff={() =>
                                setDiffTarget({
                                  path: change.path,
                                  version: change.version,
                                  beforeVersion: change.beforeVersion,
                                  segment: change.segment,
                                })
                              }
                            />
                          ))}
                        </ul>
                      </>
                    )}
                    {grouped.grouping === 'rounds' && grouped.current.length > 0 && (
                      <>
                        <p className="ws__recent-group" data-testid="recent-group-current">
                          {t('workspace.recentGroupCurrent', { count: grouped.currentTotal })}
                        </p>
                        <ul className="ws__recent-list">
                          {grouped.current.map((change) => (
                            <RecentChangeRow
                              key={`current-${change.path}-${change.at}`}
                              conversationId={conversationId}
                              change={change}
                              onOpenFile={() => {
                                openFile(conversationId, change.path)
                                setOpenedRange({
                                  path: change.path,
                                  segment: 'current',
                                  from: change.beforeVersion ?? null,
                                  to: change.version ?? 0,
                                })
                              }}
                              onOpenDiff={() =>
                                setDiffTarget({
                                  path: change.path,
                                  version: change.version,
                                  beforeVersion: change.beforeVersion,
                                  segment: 'current',
                                })
                              }
                            />
                          ))}
                        </ul>
                      </>
                    )}
                    {grouped.grouping === 'rounds' && grouped.earlier.length > 0 && (
                      <>
                        <p className="ws__recent-group" data-testid="recent-group-earlier">
                          {t('workspace.recentGroupEarlier', { count: grouped.earlierTotal })}
                        </p>
                        <ul className="ws__recent-list">
                          {grouped.earlier.map((change) => (
                            <RecentChangeRow
                              key={`earlier-${change.path}-${change.at}`}
                              conversationId={conversationId}
                              change={change}
                              onOpenFile={() => {
                                openFile(conversationId, change.path)
                                setOpenedRange({
                                  path: change.path,
                                  segment: 'earlier',
                                  from: change.beforeVersion ?? null,
                                  to: change.version ?? 0,
                                })
                              }}
                              onOpenDiff={() =>
                                setDiffTarget({
                                  path: change.path,
                                  version: change.version,
                                  beforeVersion: change.beforeVersion,
                                  segment: 'earlier',
                                })
                              }
                            />
                          ))}
                        </ul>
                      </>
                    )}
                  </>
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
                  <div key={repo.path} className="ws__git-row" title={workspaceGitChipTitle(repo, locale)}>
                    <BranchesOutlined className="ws__git-icon" />
                    {gitRepos.length > 1 && repo.path !== '' ? <span className="ws__git-repo">{repo.path}</span> : null}
                    <span className="ws__git-branch">{workspaceGitChipLabel(repo, locale)}</span>
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
                    <button type="button" className="ws__tab-name" title={path} onClick={() => {
                        // 切到别的标签 ⇒ 那条变更的版本范围不再适用（范围属于"某一条变更"，不属于文件）
                        setOpenedRange(null)
                        activateFile(conversationId, path)
                      }}>
                      <FileGlyph path={path} />
                      <span className="ws__tab-label">{workspaceBaseName(path)}</span>
                      {tabDirty && <span className="ws__tab-dot" aria-label={t('workspace.unsaved')} />}
                    </button>
                    <button
                      type="button"
                      className="ws__tab-close"
                      title={t('workspace.tabClose')}
                      onClick={(event) => {
                        event.stopPropagation()
                        // 关掉这条变更对应的文件 ⇒ 它的版本范围不再有意义
                        if (openedRange?.path === path) setOpenedRange(null)
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
                    ? t('workspace.pickFile')
                    : fileQuery.isError
                      ? t('workspace.fileUnreadable')
                      : t('workspace.fileLoading')
                }
              />
            </div>
          ) : (
            <>
              <div className="ws__toolbar">
                <span className="ws__crumb" title={activePath}>
                  {activePath}
                </span>
                {/*
                  ★ 2026-10-28（用户定案）：点「最近变更」里的文件后，在这里标明**这条是哪一段、
                  版本范围是多少**（同路径两条时这是唯一能分清它们的地方；放列表里会遮挡文件名）。
                */}
                {visibleRange !== null && (
                  <span className="ws__range-chip" data-testid="workspace-range-chip">
                    <span className="ws__range-segment">
                      {t(
                        visibleRange.segment === 'current'
                          ? 'workspace.recentGroupCurrentShort'
                          : 'workspace.recentGroupEarlierShort',
                      )}
                    </span>
                    <span className="ws__range-version">
                      {visibleRange.to === 0
                        ? t('workspace.diffRangeDeletedShort', { from: visibleRange.from ?? 0 })
                        : visibleRange.from === null
                          ? t('workspace.diffRangeNewShort', { to: visibleRange.to })
                          : t('workspace.diffRange', { from: visibleRange.from, to: visibleRange.to })}
                    </span>
                  </span>
                )}
                <Space size="small" className="u-right">
                  <Tooltip title={t('workspace.reloadTooltip')}>
                    <Button size="small" type="text" icon={<ReloadOutlined />} onClick={reloadActive} />
                  </Tooltip>
                  <Tooltip title={t('workspace.downloadTooltip')}>
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
                      {t('workspace.save')}
                    </Button>
                  )}
                </Space>
              </div>

              {fileQuery.isError ? (
                <div className="ws__placeholder">
                  <Typography.Text type="danger">{t('workspace.fileUnreadablePeriod')}</Typography.Text>
                </div>
              ) : (
                <>
                  {activeDoc.conflict !== null && (
                    <div className="ws__banner">
                      <Alert
                        type="warning"
                        showIcon
                        message={conflictText(activeDoc.conflict.currentVersion, locale)}
                        action={
                          <Button size="small" onClick={reloadActive}>
                            {t('workspace.reload')}
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
                    ) : previewKind !== null ? (
                      /*
                        ★ 2026-10-30（用户反馈「Code 模式下图片 / docx 不能预览」）：只读文件不再一律
                        落到"只能下载"占位 —— 按 `previewKindOf` 分派（与产物预览**同一个判据**）：
                        image → `<img>`；html / pdf → 沙箱 iframe；docx / xlsx → 服务端渲染出口。
                        ⚠️ SVG 是 `image/*` 但归 html 一族（能带脚本），绝不能丢进 `<img>`。
                      */
                      <WorkspaceFilePreview
                        kind={previewKind}
                        rawUrl={workspaceRawUrl(conversationId, activePath)}
                        renderUrl={workspaceRenderUrl(conversationId, activePath)}
                        name={activePath}
                      />
                    ) : (
                      <div className="ws__placeholder">
                        <Typography.Text type="secondary">
                          {/*
                            ★ 2026-10-28（用户反馈「txt 文件也需要支持展示」）：文本类**但没内联正文**只有
                            两种原因 —— 太大（超过内联上限）或内容其实是二进制（改名而来的假 txt）。
                            套 `notText`（"该文件不是文本（text/plain）"）对前者是自相矛盾的。
                          */}
                          {isWorkspaceTextMime(fileQuery.data?.mime ?? null)
                            ? t('workspace.textTooLarge')
                            : t('workspace.notText', { mime: fileQuery.data?.mime ?? '' })}
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                  <div className="ws__status" data-testid="workspace-status">
                    <span>{workspaceLanguageLabel(language, locale)}</span>
                    <span>v{activeDoc.version}</span>
                    <span>{formatBytes(fileQuery.data?.size ?? 0)}</span>
                    <span
                      className={`u-right${dirty ? ' ws__status--dirty' : ''}${
                        activeDoc.conflict !== null ? ' ws__status--conflict' : ''
                      }`}
                    >
                      {activeDoc.conflict !== null
                        ? t('workspace.conflictTag')
                        : dirty
                          ? t('workspace.unsaved')
                          : t('workspace.saved')}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {promptOpen && (
        <WorkspacePathPrompt
          open={promptOpen}
          mode={prompt?.mode ?? 'createFile'}
          initialValue={promptInitial}
          onCancel={() => setPrompt(null)}
          onSubmit={(path) => {
            if (prompt === null) return
            if (prompt.mode === 'rename') void doRename(prompt.path, path)
            else {
              // ★ 2026-10-29：框里预填了 `a/`，用户连前缀一起敲（`a/x.py`）不再叠成 `a/a/x.py`
              const resolved = workspaceResolvePromptPath(prompt.dir, path)
              if (resolved === '') return
              void (prompt.mode === 'createFolder' ? createFolder(resolved) : createFile(resolved))
            }
          }}
        />
      )}

      {/* 行级差异（验收标记）：点「最近变更」某条的「差异」打开 */}
      <WorkspaceDiffModal
        conversationId={conversationId}
        target={diffTarget}
        onClose={() => setDiffTarget(null)}
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
 * 保留期提示（2026-10-28）—— 面板上的一条可关闭提示。
 *
 * 只在**快到清理时间**（`WORKSPACE_RETENTION_NOTICE_DAYS` 天内）或**已被保护**时出现；
 * 被保护的话要说清"到点也不会清"，否则用户会以为马上要丢东西。
 */
function RetentionNotice(props: {
  info: WorkspaceRetentionInfo
  daysLeft: number
  onDismiss: () => void
}): React.JSX.Element | null {
  const { t } = useT()
  const { info, daysLeft, onDismiss } = props
  const expired = daysLeft <= 0
  // ★ 2026-10-28 浏览器实测修正（三条）：
  //   ① **没到期就别因为"有保护"弹出来** —— 原判据 `!protected && daysLeft > N` 会让
  //      "未到期 + 有保护"也弹，且文案写"已到期"（实测：updated_at 是今天，7 天后才到期）。
  //   ② 第二行原来无条件拼 `count`，于是出现"因为这里还有 0 个产物，或你近期手写过文件"——
  //      应按**实际命中**的保护原因分别说。
  //   ③ "已到期"只在真的过期时才出现。
  if (daysLeft > WORKSPACE_RETENTION_NOTICE_DAYS) return null
  const hasArtifact = info.protectedReasons.includes('ARTIFACT_PRESENT')
  const hasUserEdit = info.protectedReasons.includes('USER_EDIT_PROTECTED')
  const why =
    hasArtifact && hasUserEdit
      ? t('workspace.retentionWhyBoth', { count: info.artifactCount })
      : hasArtifact
        ? t('workspace.retentionWhyArtifact', { count: info.artifactCount })
        : hasUserEdit
          ? t('workspace.retentionWhyUserEdit', { days: info.protectUserEditDays })
          : ''
  const message = expired
    ? info.protected
      ? t('workspace.retentionExpiredProtected')
      : t('workspace.retentionExpiredWillClean', { total: info.retentionDays })
    : t('workspace.retentionSoon', { days: daysLeft, total: info.retentionDays })
  return (
    <div className="ws__retention-notice" data-testid="workspace-retention-notice">
      <Alert
        type={expired ? (info.protected ? 'info' : 'warning') : 'info'}
        showIcon
        closable
        onClose={onDismiss}
        message={message}
        description={
          <>
            {why !== '' && <div>{why}</div>}
            <div>{t('workspace.retentionWhereStored', { days: info.retentionDays })}</div>
          </>
        }
      />
    </div>
  )
}

/**
 * 「撤销本轮」的范围选择弹窗（2026-10-28 用户定案「撤销怎么选」）。
 *
 * 三档范围（**默认最安全**）：
 *   · 只撤 agent —— 这一段**以你的手写收尾**的文件**故意不动**（预演里已标出来）；
 *   · 包含我的修改 —— 显式选择才生效；
 *   · 逐条勾选 —— 默认勾选状态 = "只撤 agent" 的口径。
 *
 * ⚠️ AntD 的 `modal.confirm` 内容不受控，这里用 `data-*` 把选择写回 DOM，
 *   由 {@link readRevertScopeChoice} 在 `onOk` 时读回 —— 避免为了一个弹窗引入受控状态树。
 */
function RevertScopeDialog(props: {
  preview: WorkspaceRevertResult
  currentPaths: readonly string[]
  defaultSelected: readonly string[]
}): React.JSX.Element {
  const { t } = useT()
  const { preview, currentPaths, defaultSelected } = props
  const [scope, setScope] = useState<'AGENT_ONLY' | 'ALL' | 'SELECTED'>('AGENT_ONLY')
  const [picked, setPicked] = useState<string[]>([...defaultSelected])
  /**
   * ★ 2026-10-29（用户定案「选哪一个哪一个就要回退」）：逐条勾选时三栏必须**跟着勾选变**。
   *   以前三栏固定是"默认范围"的预演 ⇒ 勾上手写收尾的文件后仍写着"跳过"，与勾了以后实际会撤对不上。
   *
   * 实现上**不再发请求**：`preview.items` 是同一份候选逐条算出来的（含每条的落点），
   * 这里按"勾选 + `shouldRevertPath` 同款规则"本地重算即可 —— 没有网络往返，
   * 也就不存在"用户点确定时预演还落后于勾选"的竞态。
   */
  const shown = useMemo(() => previewByScope(preview, scope, picked), [preview, scope, picked])
  // 把当前选择同步到 DOM（`onOk` 读回，不依赖回调闭包里的旧值）
  revertScopeChoiceRef.current = { scope, paths: picked }
  const skipped = shown.skip
  return (
    <div className="ws__revert-scope" data-testid="revert-scope-dialog">
      <p className="ws__revert-scope-hint">{t('workspace.revertScopeHint')}</p>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <label className="ws__revert-scope-option">
          <input type="radio" name="ws-revert-scope" checked={scope === 'AGENT_ONLY'} onChange={() => setScope('AGENT_ONLY')} />
          {t('workspace.revertScopeAgentOnly')}
        </label>
        <label className="ws__revert-scope-option">
          <input type="radio" name="ws-revert-scope" checked={scope === 'ALL'} onChange={() => setScope('ALL')} />
          {t('workspace.revertScopeAll')}
        </label>
        <label className="ws__revert-scope-option">
          <input type="radio" name="ws-revert-scope" checked={scope === 'SELECTED'} onChange={() => setScope('SELECTED')} />
          {t('workspace.revertScopeSelected')}
        </label>
        {scope === 'SELECTED' && <p className="ws__revert-scope-hint">{t('workspace.revertScopeSelectedHint')}</p>}
      </Space>
      <ul className="ws__revert-preview">
        <li>{t('workspace.revertPreviewRestore', { count: shown.restore.length })}</li>
        <li>{t('workspace.revertPreviewRemove', { count: shown.remove.length })}</li>
        <li data-testid="revert-preview-skip">{t('workspace.revertPreviewSkip', { count: skipped.length })}</li>
      </ul>
      {skipped.length > 0 && (
        <ul className="ws__revert-preview-skip">
          {skipped.map((entry) => (
            <li key={`${entry.reason}:${entry.path}`}>
              <span className="ws__revert-path">{entry.path}</span>
              <span className="ws__revert-message">{t(`workspace.revertSkipReason.${entry.reason}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {scope === 'SELECTED' && (
        <ul className="ws__revert-pick">
          {currentPaths.map((path) => (
            <li key={path}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.includes(path)}
                  onChange={(event) =>
                    setPicked((prev) => (event.target.checked ? [...prev, path] : prev.filter((item) => item !== path)))
                  }
                />
                {path}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 按当前选择**本地重算**预演三栏（纯函数，`RevertScopeDialog` 用）。
 *
 * 判据与后端 `buildWorkspaceRevertPreview` 对齐（2026-10-29）：跳过 = 不在范围内 / 不可撤销 /
 * 已经无可撤；删除 = 那一条的落点就是"不存在"（`action === 'deleted'`），其余算还原。
 * `dryRun` 的 `items` 已经带好每条落点，所以这里只做分类，不再猜版本号。
 */
function previewByScope(
  result: WorkspaceRevertResult,
  scope: WorkspaceRevertScope,
  selected: readonly string[],
): { restore: string[]; remove: string[]; skip: { path: string; reason: WorkspaceRevertSkipReason }[] } {
  const out: { restore: string[]; remove: string[]; skip: { path: string; reason: WorkspaceRevertSkipReason }[] } = {
    restore: [],
    remove: [],
    skip: [],
  }
  for (const item of result.items) {
    // 范围：默认只撤"不是自己最后一次写入"的；ALL 全撤；SELECTED 只撤勾上的
    const inScope =
      scope === 'SELECTED' ? selected.includes(item.path) : scope === 'ALL' ? true : item.defaultSelected === true
    if (item.action === 'unsupported') {
      out.skip.push({ path: item.path, reason: 'UNSUPPORTED' })
      continue
    }
    if (!inScope) {
      out.skip.push({ path: item.path, reason: item.defaultSelected === false ? 'USER_EDIT_EXCLUDED' : 'CONFLICT' })
      continue
    }
    if (item.action === 'skipped') {
      out.skip.push({ path: item.path, reason: 'NET_ZERO' })
      continue
    }
    if (item.action === 'deleted') out.remove.push(item.path)
    else if (item.action === 'restored') out.restore.push(item.path)
    else out.skip.push({ path: item.path, reason: item.action === 'conflict' ? 'CONFLICT' : 'UNAVAILABLE' })
  }
  return out
}

/** 撤销弹窗里选了什么（`modal.confirm` 的 `onOk` 读回；见 {@link RevertScopeDialog}） */
const revertScopeChoiceRef: { current: { scope: WorkspaceRevertScope; paths: string[] } } = {
  current: { scope: 'AGENT_ONLY', paths: [] },
}

function readRevertScopeChoice(): { scope: WorkspaceRevertScope; paths: string[] } {
  return revertScopeChoiceRef.current
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
  const { t, locale } = useT()
  // 逐行差异的**计数**（只回 `+N −M`，不带逐行内容）：每行一个轻量查询，点开才取全文
  //
  // ★ 2026-10-28（用户反馈「编辑 4 行只显示 1 行，刷新后才 +4 −3」）：基线以**服务端**为准。
  //
  //   历史教训：基线先后取过 `version - 1`（只有最后一跳）和 `change.beforeVersion`
  //   （清单里带的字段）—— 后者会因**实时 SSE 事件合并**丢字段而悄悄退回最后一跳，
  //   于是"改完立刻看"和"刷新后看"两个数字不一样。
  //   现在对本轮内的条目直接发 `roundBase=1`，由服务端按**本轮窗口**算（与「撤销本轮」同一判据）：
  //   前端不再需要 `beforeVersion`，合并怎么变都不会漂移。
  //   本轮之外的条目（更早）仍用清单里的 `beforeVersion` / 前一版（那些没有"本轮基线"可言）。
  //
  // ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条）：每条**只比自己那一段**。
  //   判据在 `workspaceDiffScope`（纯函数，徽标与弹窗共用同一份）——「更早」那条到版本是它自己的
  //   `version`，不是"此刻盘上的内容"；否则点开两条会看到同一个"很久以前 → 现在"的差异。
  const scope = workspaceDiffScope(change)
  const stats = useQuery({
    queryKey: workspaceFileDiffQueryKey(conversationId, change.path, scope.baseVersion, true, scope.toVersion),
    queryFn: () =>
      fetchWorkspaceFileDiff(conversationId, change.path, {
        ...scope,
        stats: true,
      }),
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
        <button type="button" className="ws__recent-diff" onClick={onOpenDiff} title={t('workspace.diffViewTooltip')}>
          <span className="ws__diff-added">+{badge.added}</span>
          <span className="ws__diff-removed">−{badge.removed}</span>
        </button>
      ) : (
        <button
          type="button"
          className="ws__recent-diff ws__recent-diff--muted"
          onClick={onOpenDiff}
          title={badge?.message ?? t('workspace.diffViewTooltipShort')}
        >
          {t('workspace.diff')}
        </button>
      )}
      <span className="ws__recent-actor">{t(WORKSPACE_ACTOR_KEY[change.actor], { locale })}</span>
    </li>
  )
}

/**
 * 文件**行级差异**弹窗（验收标记）：旧行号 / 新行号 / `+/−` 号 / 文本；
 * 未变长段由后端折成「⋯ N 行未变⋯」一条（`gap`）。
 */
function WorkspaceDiffModal(props: {
  conversationId: string
  target: {
    path: string
    version: number | null
    beforeVersion?: number | null
    segment?: 'current' | 'earlier'
  } | null
  onClose: () => void
}) {
  const { conversationId, target, onClose } = props
  const { t } = useT()
  const path = target?.path ?? null
  // 与「最近变更」那一行的徽标同源：本轮基线 → 当前。**和徽标必须同一基线**，
  // 否则会出现"徽标 +2 −1、点开只有 +1 −0"这种自相矛盾（2026-10-28 用户反馈）。
  //
  // ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条）：弹窗也必须**只比那一段**，
  //   且与列表徽标用**同一个** `workspaceDiffScope`（否则徽标与弹窗数字会打架）。
  const scope = workspaceDiffScope({
    version: target?.version ?? null,
    ...(target?.beforeVersion === undefined ? {} : { beforeVersion: target.beforeVersion }),
    ...(target?.segment === undefined ? {} : { segment: target.segment }),
  })
  const query = useQuery({
    queryKey: workspaceFileDiffQueryKey(conversationId, path ?? '', scope.baseVersion, false, scope.toVersion),
    queryFn: () => fetchWorkspaceFileDiff(conversationId, path ?? '', scope),
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
          {t('workspace.diffTitle')}
          {/*
            ★ 2026-10-28（用户定案）：同一路径两段都动过时列表里是两条，弹窗要说明**这条是哪一段**，
            否则两条的标题长得一模一样、只有版本号不同。（文件名本身在列表里不重复标注 —— 那样会把
            文件名遮住；段与版本范围在这里展示。）
          */}
          {target?.segment !== undefined && (
            <span className="ws__diff-title-segment">
              {t(target.segment === 'current' ? 'workspace.recentGroupCurrentShort' : 'workspace.recentGroupEarlierShort')}
            </span>
          )}
          <span className="ws__diff-title-path">{path}</span>
          {/*
            ★ 2026-10-28：把"跟哪个版本比"写出来。用户要知道的是**这一段**改了什么，
            而不是"最后一跳"；`diff.baseVersion → diff.currentVersion` 就是这次比较的两端。
          */}
          {diff !== undefined && diff.available ? (
            <>
              <span className="ws__diff-title-range">
                {diff.currentVersion === null
                  ? t('workspace.diffRangeDeleted', { from: diff.baseVersion ?? 0 })
                  : diff.baseVersion === null
                    ? t('workspace.diffRangeNew', { to: diff.currentVersion })
                    : t('workspace.diffRange', { from: diff.baseVersion, to: diff.currentVersion })}
              </span>
              <span className="ws__diff-title-stat">
                <span className="ws__diff-added">+{diff.added}</span>{' '}
                <span className="ws__diff-removed">−{diff.removed}</span>
              </span>
            </>
          ) : null}
        </span>
      }
    >
      {query.isError ? (
        <div className="ws__placeholder">
          <Typography.Text type="danger">{t('workspace.diffReadFailed')}</Typography.Text>
        </div>
      ) : diff === undefined ? (
        <div className="ws__loading">
          <Spin />
        </div>
      ) : !diff.available ? (
        <div className="ws__placeholder">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={diff.message ?? t('workspace.diffNotComparable')} />
        </div>
      ) : lines.length === 0 ? (
        <div className="ws__placeholder">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workspace.diffNoChange')} />
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
  const { t } = useT()
  if (line.type === 'gap') {
    return (
      <div className="ws__diff-line ws__diff-line--gap">
        {t('workspace.diffGapLines', { count: line.gap ?? 0 })}
      </div>
    )
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
  const { t } = useT()
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
      title={
        isRename
          ? t('workspace.promptRenameTitle')
          : isFolder
            ? t('workspace.promptFolderTitle')
            : t('workspace.promptFileTitle')
      }
      okText={isRename ? t('workspace.promptOkRename') : t('workspace.promptOk')}
      cancelText={t('common.cancel')}
      onOk={submit}
      onCancel={props.onCancel}
      destroyOnClose
    >
      <Input
        value={value}
        autoFocus
        placeholder={
          isFolder ? t('workspace.promptPlaceholderFolder') : t('workspace.promptPlaceholderFile')
        }
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={submit}
      />
      <p className="ratio" style={{ marginTop: 8 }}>
        {isFolder
          ? t('workspace.promptHintFolder')
          : isRename
            ? t('workspace.promptHintRename')
            : t('workspace.promptHintFile')}
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

/**
 * 只读文件的**在线预览**（2026-10-30）—— 按 `previewKindOf` 分派，与产物预览同一套判据。
 *
 *   · `image` → `<img>`（raw 出口）。失败给因由，同 `ArtifactPreview/ImagePreview` 的纪律；
 *   · `html`（含 SVG）→ **沙箱 iframe** 打 raw 出口：脚本不给、同源不给 —— 隔离头由后端
 *     `HTML_PREVIEW_CSP` 上（响应头才是第一道，`sandbox=""` 只是第二道，同 `HtmlPreview`）；
 *   · `pdf` → iframe 打 raw 出口，**刻意不加 `sandbox`**（加了浏览器内置 viewer 渲染不出来）；
 *   · `docx` / `xlsx` → iframe 打**渲染出口**（服务端 mammoth / xlsx 读取器转成 HTML），
 *     与 html 那一路同款沙箱。
 *
 * ⚠️ SVG 会不会落到 `image`？不会 —— `previewKindOf` 把它归 `html`（见那里的判据 ②）。
 */
function WorkspaceFilePreview(props: {
  kind: PreviewKind
  rawUrl: string
  renderUrl: string
  name: string
}) {
  if (props.kind === 'image') return <WorkspaceImagePreview url={props.rawUrl} alt={props.name} />
  const sandboxed = props.kind !== 'pdf'
  return (
    <iframe
      className="ws__frame"
      src={props.kind === 'docx' || props.kind === 'xlsx' ? props.renderUrl : props.rawUrl}
      /* HTML/SVG/渲染出来的 OOXML：空串 = 最严格（不含 allow-scripts / allow-same-origin） */
      {...(sandboxed ? { sandbox: '' } : {})}
      referrerPolicy="no-referrer"
      title={props.name}
    />
  )
}

/** 只读图片预览（内联；失败给因由，同 `ArtifactPreview/ImagePreview` 的纪律） */
function WorkspaceImagePreview({ url, alt }: { url: string; alt: string }) {
  const { t } = useT()
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="ws__placeholder">
        <Alert
          type="warning"
          showIcon
          message={t('workspace.imageFailedTitle')}
          description={t('workspace.imageFailedDescription')}
        />
      </div>
    )
  }
  return (
    <div className="ws__image">
      {/* `decoding="async"`：内存优化 P1（同 `MessageList` 附件缩略图）—— 预览需要解码，只能异步化 */}
      <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
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
 *
 * ⚠️ `resetKey` 变了就**忽略**这份持久化（P1-24）：一次 `git clone` / `git pull` 没跑完时，
 * 面板按"原始根"展示 —— 用户此刻点开的目录既不进 store，也不被翻出来用，clone 一结束再正常一轮。
 */
function WorkspaceTree(props: {
  conversationId: string
  nodes: readonly WorkspaceTreeNode[]
  selectedPath: string | null
  actions: TreeActions
  /** 0 = 正常（读持久化的展开状态）；非 0 = 忽略持久化，一律按"全部折叠"展示 */
  resetKey: number
  /** 正在「上传至平台」的文件（非空 ⇒ 菜单里那一项禁用，避免连点建出两条产物行） */
  uploadingArtifact: boolean
}) {
  const { t, locale } = useT()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 被**展开**的目录（持久化在 store；初始为空 = 全部折叠，只看到顶层） */
  const stored = useWorkspaceExpandedDirs(props.conversationId)
  const expandedDirs = props.resetKey === 0 ? stored : EMPTY_DIRS
  const toggleExpanded = useWorkspaceStore((state) => state.toggleExpanded)
  /** 忽略持久化期间，点开/收起的目录仅本组件内有效（clone 结束后交给 store 那一份） */
  const [transient, setTransient] = useState<readonly string[]>(EMPTY_DIRS)
  const shownDirs = props.resetKey === 0 ? expandedDirs : transient
  const expanded = useMemo(() => new Set(shownDirs), [shownDirs])
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

  const toggle = (path: string): void => {
    if (props.resetKey === 0) {
      toggleExpanded(props.conversationId, path)
      return
    }
    // 忽略持久化期间：只动本组件那一份，别把 clone 中途的临时浏览写进 localStorage
    setTransient((prev) => toggleExpandedDir(prev, path))
  }

  /**
   * 「复制」子菜单（**文件与目录同款**）。三个子项直接取自 `WORKSPACE_COPY_ITEMS`
   * —— 菜单文案与"复制出来到底是什么"同源一份，不会出现"写着相对路径、复制的是绝对路径"。
   */
  const copySubmenu = (): NonNullable<MenuProps['items']>[number] => ({
    key: 'copy',
    icon: <CopyOutlined />,
    label: t('workspace.menuCopy'),
    children: workspaceCopyItems(locale).map((item) => ({ key: `copy-${item.key}`, label: item.label })),
  })

  /** 命中的是不是「复制」子项 ⇒ 是就执行并回 `true`（调用方据此提前返回） */
  const handleCopyKey = (key: string, path: string): boolean => {
    const kind = WORKSPACE_COPY_ITEM_KEYS.find((item) => `copy-${item.key}` === key)?.key
    if (kind === undefined) return false
    props.actions.copy(kind, path)
    return true
  }

  const fileMenu = (path: string): MenuProps => ({
    items: [
      { key: 'open', label: t('workspace.menuOpen') },
      { key: 'rename', icon: <EditOutlined />, label: t('workspace.menuRename') },
      { key: 'download', icon: <DownloadOutlined />, label: t('workspace.menuDownload') },
      {
        key: 'uploadArtifact',
        icon: <CloudUploadOutlined />,
        label: t('workspace.menuUploadArtifact'),
        // 上传进行中禁掉入口（同一时刻只跑一个；连点会建两条产物行）
        disabled: props.uploadingArtifact,
      },
      { type: 'divider' },
      copySubmenu(),
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: t('workspace.menuDelete'), danger: true },
    ],
    onClick: ({ key }) => {
      if (handleCopyKey(key, path)) return
      if (key === 'open') props.actions.open(path)
      else if (key === 'rename') props.actions.rename(path)
      else if (key === 'download') props.actions.download(path)
      else if (key === 'uploadArtifact') props.actions.uploadArtifact(path)
      else if (key === 'delete') props.actions.remove(path)
    },
  })

  const dirMenu = (dir: string): MenuProps => ({
    items: [
      { key: 'newFile', icon: <FileAddOutlined />, label: t('workspace.newFile') },
      { key: 'newFolder', icon: <FolderAddOutlined />, label: t('workspace.newFolder') },
      { key: 'upload', icon: <UploadOutlined />, label: t('workspace.menuUploadHere') },
      { key: 'downloadDir', icon: <DownloadOutlined />, label: t('workspace.menuDownloadDir') },
      { type: 'divider' },
      copySubmenu(),
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: t('workspace.menuDeleteDir'), danger: true },
    ],
    onClick: ({ key }) => {
      if (handleCopyKey(key, dir)) return
      if (key === 'newFile') props.actions.newFile(dir)
      else if (key === 'newFolder') props.actions.newFolder(dir)
      else if (key === 'upload') props.actions.upload(dir)
      else if (key === 'downloadDir') props.actions.downloadDir(dir)
      else if (key === 'delete') props.actions.removeDir(dir)
    },
  })

  const blankMenu: MenuProps = {
    items: [
      { key: 'newFile', icon: <FileAddOutlined />, label: t('workspace.newFile') },
      { key: 'newFolder', icon: <FolderAddOutlined />, label: t('workspace.newFolder') },
      { key: 'upload', icon: <UploadOutlined />, label: t('workspace.menuUpload') },
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
            {t('workspace.emptyTree')}
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
