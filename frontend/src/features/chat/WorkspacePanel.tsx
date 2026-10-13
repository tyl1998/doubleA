/**
 * 工作区面板（P1-9 · P3 前端；R12 重设计为 **VS Code 式 IDE 布局**）
 *
 * 依据：`docs/03-前端设计.md` §4.x、`子方案/Code模式工作区.md` §六 / §十。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 形态（第三列 / 窄屏抽屉同一份组件）
 * ─────────────────────────────────────────────────────────────────────
 *   ┌ 工作区头（资源管理器折叠 · 撤销本轮）─────────────────────────┐
 *   │ ┌ 资源管理器 ─┐ ┌ 标签条（多标签 · dirty 圆点 · 关闭）──────┐ │
 *   │ │ 文件树      │ │ 面包屑 + 工具栏（重载/下载/保存/删除）    │ │
 *   │ │ …           │ │ CodeMirror / 图片 / 只读说明              │ │
 *   │ │ 最近变更 ▾  │ │ 状态栏（语言 · vN · 大小 · 保存态）       │ │
 *   │ └─────────────┘ └───────────────────────────────────────────┘ │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 编辑态**按路径**存（`docs`）：多标签各自保留草稿，切标签不丢未保存改动。
 *    SSE 命中当前文件时才重载；**有草稿的**不静默覆盖 —— 走冲突横幅（`子方案` §六 2）。
 * ⚠️ 宽度拖拽在 `ChatPage`（第三列是 grid 的一列），本组件只管面板内部布局。
 */

import {
  CloseOutlined,
  CodeOutlined,
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
  FolderOpenOutlined,
  FolderOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { Alert, Button, Empty, Input, Modal, Popconfirm, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { foldWorkspaceEvents, WORKSPACE_ACTOR_LABELS, type WorkspaceEventItem } from '@doubulea/shared'

import { ApiError } from '../../api/client.js'
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  fetchWorkspaceFile,
  moveWorkspaceFile,
  revertWorkspaceRound,
  saveWorkspaceFile,
  streamWorkspaceEvents,
  useWorkspaceTree,
  workspaceRawUrl,
  workspaceTreeQueryKey,
} from '../../api/workspace.js'
import { useFeedback } from '../../app/feedback.js'
import { useWorkspaceStore, useWorkspaceTabs } from '../../stores/workspace.js'
import { CodeMirrorEditor } from './CodeMirrorEditor.js'
import {
  buildWorkspaceTree,
  changeTagColor,
  conflictText,
  eventTouchesPath,
  fileIconKind,
  filterWorkspaceTree,
  formatBytes,
  isContentEvent,
  isEditableRead,
  isImageMime,
  revertSummaryText,
  workspaceBaseName,
  workspaceEditorLanguage,
  workspaceLanguageLabel,
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

export function WorkspacePanel({ conversationId, codeMode }: { conversationId: string; codeMode: boolean }) {
  const feedback = useFeedback()
  const queryClient = useQueryClient()
  const { openPaths, activePath } = useWorkspaceTabs(conversationId)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const activateFile = useWorkspaceStore((state) => state.activateFile)
  const closeFile = useWorkspaceStore((state) => state.closeFile)
  const renameFile = useWorkspaceStore((state) => state.renameFile)

  const [explorerOpen, setExplorerOpen] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  /** 新建 / 重命名路径输入弹窗（同一套壳，两种模式） */
  const [prompt, setPrompt] = useState<{ mode: 'create' } | { mode: 'rename' } | null>(null)

  const treeQuery = useWorkspaceTree(conversationId, codeMode)
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

  /** 改名 / 移动（`POST .../workspace/move`）：迁移打开态与草稿，刷新树 */
  const doRename = async (to: string): Promise<void> => {
    setPrompt(null)
    const from = activePath
    if (from === null || to === from) return
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

  /**
   * 「撤销本轮」（P1-9 · P4 · R2）：把上一轮 agent/人的写入回退到轮初。
   * 结果按落点动作汇总提示（冲突 / 缺历史 / 不支持都如实展示，见 `revertSummaryText`）。
   */
  const revert = async (): Promise<void> => {
    setReverting(true)
    try {
      const result = await revertWorkspaceRound(conversationId)
      feedback.ok(revertSummaryText(result))
      void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
      // 打开的文件全量重读：干净的重铺，有草稿的进冲突（不静默覆盖）
      void queryClient.invalidateQueries({ queryKey: ['workspace-file', conversationId] })
    } catch (error) {
      feedback.fail(error, '撤销本轮失败')
    } finally {
      setReverting(false)
    }
  }

  // ── 事件流：内容事件 ⇒ 刷新树；命中当前文件 ⇒ 重载；`deleted` 命中打开的文件 ⇒ 关标签 ──
  const [recentEvents, setRecentEvents] = useState<WorkspaceEventItem[]>([])
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
        void queryClient.invalidateQueries({ queryKey: workspaceTreeQueryKey(conversationId) })
        if (event.type === 'deleted' && (useWorkspaceStore.getState().tabsByConversation[conversationId]?.openPaths ?? []).includes(event.path)) {
          closeFile(conversationId, event.path)
          return
        }
        if (eventTouchesPath(event, activePathRef.current)) void fileQuery.refetch()
      },
      onIssue: () => undefined,
    }).catch(() => undefined)
    return () => controller.abort()
    // 只在会话 / 开关变化时重连（`fileQuery.refetch` / `closeFile` 通过 ref 与 getState 引用）
  }, [conversationId, codeMode, queryClient, closeFile])

  const changes = useMemo(() => foldWorkspaceEvents(recentEvents).slice(0, 8), [recentEvents])

  if (!codeMode) {
    return <Empty description="当前会话未开启 Code 模式" />
  }

  const language = activePath === null ? 'text' : workspaceEditorLanguage(activePath)

  return (
    <div className="ws" data-testid="workspace-panel">
      <header className="ws__head">
        <button
          type="button"
          className={`ws__icon-btn${explorerOpen ? ' is-on' : ''}`}
          onClick={() => setExplorerOpen((open) => !open)}
          title={explorerOpen ? '收起资源管理器' : '展开资源管理器'}
          aria-pressed={explorerOpen}
        >
          <FolderOutlined />
        </button>
        <span className="ws__title">工作区</span>
        <div className="u-right">
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
        {/* 资源管理器：P1-15 起可**折叠成 44px 图标条**（只留文件夹 / 文件图标），把宽度让给编辑器
            —— 而不是像改造前那样整块消失（消失后要回到"树"得先展开、再找不到刚才那个文件）。 */}
        <div className={`ws__explorer${explorerOpen ? '' : ' ws__explorer--collapsed'}`}>
          <div className="ws__explorer-head">
            <span className="ws__explorer-title">资源管理器</span>
              <span className="u-right ws__explorer-actions">
                <button
                  type="button"
                  className="ws__icon-btn"
                  onClick={() => setPrompt({ mode: 'create' })}
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
            <div className="ws__tree-scroll">
              {treeQuery.isLoading ? (
                <Spin />
              ) : visibleNodes.length === 0 ? (
                <p className="ws__hint" data-testid="workspace-empty">
                  （空工作区；agent 派活后可生成文件）
                </p>
              ) : (
                <WorkspaceTree
                  nodes={visibleNodes}
                  selectedPath={activePath}
                  onSelect={(path) => openFile(conversationId, path)}
                />
              )}
            </div>

            {changes.length > 0 && (
              <div className={`ws__recent${recentOpen ? ' is-open' : ''}`}>
                <button type="button" className="ws__recent-head" onClick={() => setRecentOpen((open) => !open)}>
                  <RightOutlined className="ws__chevron" rotate={recentOpen ? 90 : 0} /> 最近变更 {changes.length}
                </button>
                {recentOpen && (
                  <ul className="ws__recent-list">
                    {changes.map((change) => (
                      <li key={`${change.path}-${change.at}`}>
                        <Tag color={changeTagColor(change.type)} style={{ marginInlineEnd: 0 }}>
                          {change.type}
                        </Tag>
                        <button
                          type="button"
                          className="ws__recent-path"
                          title={change.path}
                          onClick={() => openFile(conversationId, change.path)}
                        >
                          {workspaceBaseName(change.path)}
                        </button>
                        <span className="ws__recent-actor">{WORKSPACE_ACTOR_LABELS[change.actor]}</span>
                      </li>
                    ))}
                  </ul>
                )}
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
                description={openPaths.length === 0 ? '从左侧选一个文件开始' : '正在读取文件…'}
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
                  <Tooltip title="重命名 / 移动">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setPrompt({ mode: 'rename' })} />
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
                  <Popconfirm
                    title="删除这个文件？"
                    description="软删 + 墓碑；可在历史里找回（若在保留期内）。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(activePath)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
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
                      <Spin />
                    ) : editable ? (
                      <CodeMirrorEditor
                        value={activeDoc.text}
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
        mode={prompt?.mode ?? 'create'}
        initialValue={prompt?.mode === 'rename' ? activePath ?? '' : ''}
        onCancel={() => setPrompt(null)}
        onSubmit={(path) => (prompt?.mode === 'rename' ? void doRename(path) : void createFile(path))}
      />
    </div>
  )
}

/** 新建 / 重命名共用的路径输入弹窗（相对路径；服务端负责归一化与越界校验） */
function WorkspacePathPrompt(props: {
  open: boolean
  mode: 'create' | 'rename'
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
  return (
    <Modal
      open={props.open}
      title={isRename ? '重命名 / 移动' : '新建文件'}
      okText={isRename ? '重命名' : '新建'}
      cancelText="取消"
      onOk={submit}
      onCancel={props.onCancel}
      destroyOnClose
    >
      <Input
        value={value}
        autoFocus
        placeholder="例如 src/index.ts"
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={submit}
      />
      <p className="ratio" style={{ marginTop: 8 }}>
        相对工作区根目录的路径；目录不存在会自动建。{isRename ? '目标已存在会被拒绝。' : '同名已存在会被拒绝。'}
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

/** 资源管理器文件树（可折叠目录 + 当前文件高亮） */
function WorkspaceTree(props: {
  nodes: readonly WorkspaceTreeNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  return (
    <ul className="ws__tree">
      {props.nodes.map((node) =>
        node.kind === 'dir' ? (
          <li key={node.path}>
            <button type="button" className="ws__tree-row ws__tree-row--dir" onClick={() => toggle(node.path)}>
              <span className="ws__chevron">
                {collapsed.has(node.path) ? <RightOutlined /> : <DownOutlined />}
              </span>
              {collapsed.has(node.path) ? <FolderOutlined /> : <FolderOpenOutlined />}
              <span className="ws__tree-name">{node.name}</span>
            </button>
            {!collapsed.has(node.path) && (
              <WorkspaceTree nodes={node.children} selectedPath={props.selectedPath} onSelect={props.onSelect} />
            )}
          </li>
        ) : (
          <li key={node.path}>
            <button
              type="button"
              className={`ws__tree-row${props.selectedPath === node.path ? ' is-active' : ''}`}
              title={`${node.path} · ${formatBytes(node.entry.size)}`}
              onClick={() => props.onSelect(node.path)}
            >
              <span className="ws__chevron" />
              <FileGlyph path={node.path} />
              <span className="ws__tree-name">{node.name}</span>
              {/* 行内尺寸读数（P1-15）：与状态栏同一口径（`formatBytes`），浏览时一眼看到大小 */}
              <span className="ws__tree-size num">{formatBytes(node.entry.size)}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  )
}
