/**
 * 工作区面板的**纯展示逻辑**（P1-9 · P3）
 *
 * 依据：`docs/03-前端设计.md` §六（纯函数放 `*Model.ts`，便于无依赖验收）、
 *      `子方案/Code模式工作区.md` §六（文件树 / 编辑器 / 冲突提示）。
 *
 * ⚠️ 本文件**只做纯函数**（不 import react / antd / fetch）：文件树怎么从扁平路径长出来、
 * 事件算不算"内容变更"、体积怎么显示 —— 这些错了都**不报错**（只是显示不对），
 * 正是 `verify:workspace-ui` 要逐条钉住的（同 `memoryModel.ts` 的手法）。
 */

import {
  WORKSPACE_CONTENT_EVENT_TYPES,
  isWorkspaceTextMime,
  isWorkspaceHiddenPath,
  type WorkspaceEventItem,
  type WorkspaceFileEntry,
  type WorkspaceFileRead,
  type WorkspaceRevertResult,
} from '@doubulea/shared'

/** 文件树节点（目录从 `path` 的 `/` 段**派生** —— DB 索引里只有文件，空目录不是内容） */
export type WorkspaceTreeNode =
  | { kind: 'dir'; name: string; path: string; children: WorkspaceTreeNode[]; hidden: boolean }
  | { kind: 'file'; name: string; path: string; entry: WorkspaceFileEntry; hidden: boolean }

/**
 * 把扁平的 `items`（相对路径 + 元数据）拼成一棵树，目录**从路径派生**。
 *
 * 排序：目录在前、文件在后，各自按名字字典序（`localeCompare`）—— 稳定、可预期。
 * `hidden`（任一段以 `.` 开头，如 `.git`）由 {@link isWorkspaceHiddenPath} 判，供 UI 折叠/灰显。
 * 同名冲突（一个路径既是文件又是目录）在后端就被 `@@unique(conversation_id, path)` 与路径判据
 * 排除了，这里按"先建的目录节点、文件后到就覆盖成文件"的简单口径处理，不去构造不可能的状态。
 */
export function buildWorkspaceTree(items: readonly WorkspaceFileEntry[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode[] = []
  for (const entry of items) {
    const segments = entry.path.split('/')
    const hidden = isWorkspaceHiddenPath(entry.path)
    let level = root
    let prefix = ''
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index] ?? ''
      prefix = prefix === '' ? name : `${prefix}/${name}`
      const isLeaf = index === segments.length - 1
      if (isLeaf) {
        level.push({ kind: 'file', name, path: entry.path, entry, hidden })
      } else {
        let dir = level.find((node) => node.kind === 'dir' && node.name === name)
        if (dir === undefined) {
          dir = { kind: 'dir', name, path: prefix, children: [], hidden }
          level.push(dir)
        }
        if (dir.kind !== 'dir') continue
        level = dir.children
      }
    }
  }
  sortTree(root)
  return root
}

function sortTree(nodes: WorkspaceTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) if (node.kind === 'dir') sortTree(node.children)
}

/** 文件树里所有文件节点（深度优先；给"下一个 / 上一个文件"这类导航用） */
export function flattenTreeFiles(nodes: readonly WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  const out: WorkspaceTreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node)
    else out.push(...flattenTreeFiles(node.children))
  }
  return out
}

/** 这条事件是否**改变内容**（→ 前端要刷新文件树 / 重载编辑器）；`claim`/`release` 不算 */
export function isContentEvent(event: Pick<WorkspaceEventItem, 'type'>): boolean {
  return (WORKSPACE_CONTENT_EVENT_TYPES as readonly string[]).includes(event.type)
}

/** 读结果是否**可编辑**（文本内联成功 = `text !== null`；二进制 / 超大 ⇒ 只读） */
export function isEditableRead(read: Pick<WorkspaceFileRead, 'text' | 'mime'>): boolean {
  return read.text !== null && isWorkspaceTextMime(read.mime)
}

/**
 * 事件是否**命中当前打开的文件**（决定要不要重载编辑器）。
 * `renamed` 的 `path` 是**新路径**：只有"打开的就是新路径"时才算命中（旧路径那一侧靠文件树刷新兜）。
 */
export function eventTouchesPath(event: Pick<WorkspaceEventItem, 'path'>, openPath: string | null): boolean {
  return openPath !== null && event.path === openPath
}

/**
 * 字节数 → 人类可读（**P1-15 起全仓唯一实现在 `app/format.ts`**）。
 *
 * 这里**重导出**是为了让 `WorkspacePanel` / `verify-workspace-ui` 原来的 import 一字不动
 * （与 `app/format.ts` 文件头说的"跨批次抽取"同一手法）。别再在本文件里写第二份实现。
 */
export { formatBytes } from '../../app/format.js'

/**
 * 保存冲突时的提示文案（把服务端当前版本讲清楚，好让用户"重新加载"）。
 *
 * ⚠️ 与后端容器扩展里那句（`请重新读取后再写`）是**同一件事的两种受众**：这里给人看，
 * 那里给模型看；两者都不许把它写成"保存失败"就完 —— 用户得知道**为什么**（别人/agent 改过）。
 */
export function conflictText(currentVersion: number | undefined): string {
  const version = currentVersion === undefined ? '' : `（当前 v${currentVersion}）`
  return `文件已被他人修改${version}，请重新加载后再保存。`
}

/** 文件图标用的后缀（纯展示；不认识回空串） */
export function fileExtension(path: string): string {
  const matched = /\.([^./\\]+)$/u.exec(path)
  return matched?.[1]?.toLowerCase() ?? ''
}

/**
 * 编辑器（CodeMirror 6）该给哪套语法高亮（P1-9 · R7）。
 *
 * 判据只看**扩展名**（`fileExtension`）—— 与后端 `workspaceMimeOf` 同源同向，但那是"文件是什么"
 * 的 MIME、这里是"编辑器挂哪个语言包"，用途不同故各留一份。不认识 / 无扩展 ⇒ `'text'`（纯文本，
 * 编辑器仍可编辑，只是不高亮）。
 *
 * ⚠️ 本函数**纯函数**：由 CodeMirror 包 import 的映射（`CodeMirrorEditor.tsx`）消费；
 *    语言 id → 语言包的绑定留在组件里（`workspaceModel.ts` 不 import 任何 CodeMirror 包，
 *    保持"零依赖纯逻辑 + 可无依赖验收"的纪律）。
 */
export type WorkspaceEditorLanguage =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'html'
  | 'css'
  | 'python'
  | 'markdown'
  | 'text'

export function workspaceEditorLanguage(path: string): WorkspaceEditorLanguage {
  switch (fileExtension(path)) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'json':
    case 'jsonc':
      return 'json'
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html'
    case 'css':
    case 'scss':
    case 'less':
      return 'css'
    case 'py':
    case 'pyw':
      return 'python'
    case 'md':
    case 'markdown':
      return 'markdown'
    default:
      return 'text'
  }
}

/**
 * 打开一个标签（已在则原样返回，保持插入顺序）。
 *
 * ⚠️ **纯函数**：`stores/workspace.ts` 用它维护 `openPaths`，不在这里就做去重以外的事
 * （激活 / 关闭的补位另有 {@link nextActiveOnClose}）。
 */
export function withOpenedTab(openPaths: readonly string[], path: string): string[] {
  return openPaths.includes(path) ? [...openPaths] : [...openPaths, path]
}

/**
 * 关闭某标签后**当前标签该落到谁**（纯函数；`null` = 没有邻居了，编辑器回空态）。
 *
 * 口径同 VS Code：优先取**右边**那个；右边没有则取**左边**；一个不剩 = `null`。
 * ⚠️ 入参是**关闭前**的完整列表（内部自己找下标），别传已过滤的。
 */
export function nextActiveOnClose(openPaths: readonly string[], closingPath: string): string | null {
  const index = openPaths.indexOf(closingPath)
  if (index === -1) return openPaths[0] ?? null
  const remaining = openPaths.filter((item) => item !== closingPath)
  return remaining[index] ?? remaining[index - 1] ?? null
}

/**
 * 改名 / 移动后，把打开态里的 `from` 一并迁到 `to`（去重，保持顺序）。纯函数，给 store 用。
 */
export function renameOpenTab(openPaths: readonly string[], from: string, to: string): string[] {
  const mapped = openPaths.map((path) => (path === from ? to : path))
  return mapped.filter((path, index) => mapped.indexOf(path) === index)
}

/**
 * 展开 / 折叠一个目录（纯函数，给 `stores/workspace.ts` 维护"被展开的目录"列表）。
 *
 * 已在列表里 ⇒ 移除（折叠）；不在 ⇒ 追加（展开，保持插入顺序 ⇒ 稳定）。
 * 列表初始为空 = **全部折叠**（产品要求：一进来不铺开几千个文件，见 `WorkspaceTree`）。
 */
export function toggleExpandedDir(expanded: readonly string[], path: string): string[] {
  return expanded.includes(path) ? expanded.filter((item) => item !== path) : [...expanded, path]
}

/** 文件树里按名字取末段（标签文字用） */
export function workspaceBaseName(path: string): string {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? path
}

/** 取父目录（`'a/b/c.ts'` ⇒ `'a/b'`；根层文件 ⇒ `''`）。右键"上传到此 / 拖到此处"的目标目录用它。 */
export function workspaceParentDir(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/**
 * 把目录与一个名字拼成工作区相对路径（目录为空 = 根）。
 *
 * ⚠️ 纯拼接，**不做归一化 / 越界校验**（那是 `@doubulea/shared#normalizeWorkspacePath` 的职责，
 * 服务端还会再判一次）—— 这里只服务于"拖到某个目录后目标路径是什么"这类展示逻辑。
 */
export function joinWorkspacePath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/** 「新建文件夹」的占位文件名：工作区模型里空目录不算内容（树由文件路径派生），故落一个隐藏占位使目录可见 */
export const WORKSPACE_FOLDER_PLACEHOLDER = '.gitkeep'

/** 「新建文件夹」实际要创建的文件路径（`dir/name` 目录下的占位文件） */
export function workspaceNewFolderPlaceholderPath(dir: string, name: string): string {
  return joinWorkspacePath(joinWorkspacePath(dir, name), WORKSPACE_FOLDER_PLACEHOLDER)
}

/** 拖拽移动的目标路径：把 `from` 移到 `dir` 目录下，名字不变 */
export function workspaceMoveTargetPath(from: string, dir: string): string {
  return joinWorkspacePath(dir, workspaceBaseName(from))
}

/**
 * 过滤隐藏节点（`.` 前缀段，如 `.git`）：`includeHidden=false` 时**整棵子树**都不出现
 * （`buildWorkspaceTree` 已把隐藏标记推到每个后代）。纯函数，给文件树的"显示隐藏文件"开关用。
 */
export function filterWorkspaceTree(nodes: readonly WorkspaceTreeNode[], includeHidden: boolean): WorkspaceTreeNode[] {
  if (includeHidden) return [...nodes]
  return nodes
    .filter((node) => !node.hidden)
    .map((node) => (node.kind === 'dir' ? { ...node, children: filterWorkspaceTree(node.children, includeHidden) } : node))
}

/** 虚拟滚动列表的一行：节点 + 缩进层级（目录 / 文件都由**扁平列表**渲染） */
export interface WorkspaceTreeRow {
  node: WorkspaceTreeNode
  depth: number
}

/**
 * 把（已过滤隐藏项的）树按"展开 / 折叠"压成**线性行列表**，供文件树**虚拟滚动**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么压平 + 虚拟滚动（产品反馈 2026-10-14：打开多文件后浏览器占 1.5G）
 * ─────────────────────────────────────────────────────────────────────
 * 工作区里一次 `git clone` 就可能长出几千个文件（实测某会话 2231 个）。旧实现把整棵树
 * **全量渲染**，且每行套一个 antd `Dropdown`（右键菜单）—— 实测 2534 行 ⇒ 约 2.4 万 DOM 节点、
 * 2536 个 `Dropdown` 实例，基线 JS 堆数百 MB，而且每个内容事件都会整树重渲。
 * 压平后组件只渲染**视口内**的十几行（按 `index × 行高` 绝对定位），渲染成本与文件总数**脱钩**。
 *
 * 折叠的目录**整段不进列表**（其子树直接跳过）；`nodes` 传入前应已过 {@link filterWorkspaceTree}。
 * 纯函数 ⇒ 断言进 `verify-workspace-ui.mjs`。
 */
export function flattenWorkspaceTree(
  nodes: readonly WorkspaceTreeNode[],
  isCollapsed: (path: string) => boolean,
): WorkspaceTreeRow[] {
  const rows: WorkspaceTreeRow[] = []
  const walk = (list: readonly WorkspaceTreeNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth })
      if (node.kind === 'dir' && !isCollapsed(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return rows
}

/** 文件图标大类（纯展示；组件据此挑图标与配色，本模块不 import 任何图标库） */
export type WorkspaceFileIconKind =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css'
  | 'python'
  | 'image'
  | 'shell'
  | 'yaml'
  | 'text'

export function fileIconKind(path: string): WorkspaceFileIconKind {
  switch (fileExtension(path)) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
    case 'jsonc':
      return 'json'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html'
    case 'css':
    case 'scss':
    case 'less':
      return 'css'
    case 'py':
    case 'pyw':
      return 'python'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'bmp':
    case 'ico':
      return 'image'
    default:
      return 'text'
  }
}

/** mime 是不是图片（决定只读文件走 `<img>` 内联预览还是"只能下载"） */
export function isImageMime(mime: string | null | undefined): boolean {
  if (typeof mime !== 'string') return false
  return mime.trim().toLowerCase().startsWith('image/')
}

/** 编辑器语言 id → 状态栏人读文案（纯展示） */
const WORKSPACE_LANGUAGE_LABELS: Record<WorkspaceEditorLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  python: 'Python',
  markdown: 'Markdown',
  text: '纯文本',
}

export function workspaceLanguageLabel(language: WorkspaceEditorLanguage): string {
  return WORKSPACE_LANGUAGE_LABELS[language]
}

/**
 * 第三列（IDE 面板）宽度下限（px）。
 *
 * ⚠️ **P1-15 从 420 抬到 560**：Code 模式的最小可用宽度是"资源管理器（224px）+ 编辑器"，
 * 420 − 资源管理器之后编辑器只剩 ~196px，长代码必须横向滚（用户原话："展示的内容文件显示
 * 大小不符合预期"）。抬到 560 后即便资源管理器不折叠，编辑器也有 ~336px。
 */
export const WORKSPACE_PANEL_MIN_W = 560
/** 第三列宽度上限（px；再宽就把消息流挤没了） */
export const WORKSPACE_PANEL_MAX_W = 900
/**
 * 第三列默认宽度（px；开 Code 模式时的初始值）。
 *
 * ⚠️ **P1-15 从 560 抬到 640**：默认值必须 ≥ 下限（见 `clampWorkspacePanelWidth`），
 * 且这里给的是"资源管理器展开 + 编辑器仍可读"的舒适值。
 */
export const WORKSPACE_PANEL_DEFAULT_W = 640

/**
 * 把拖拽出来的面板宽度夹到合法区间（纯函数；视口很窄时上限跟着收）。
 *
 * 上限 = `min(900, 视口 × 0.72)`，且**永不低于下限**（否则夹取区间会翻转、`Math.min/max` 打架）。
 */
export function clampWorkspacePanelWidth(width: number, viewportWidth: number): number {
  const upper = Math.max(WORKSPACE_PANEL_MIN_W, Math.min(WORKSPACE_PANEL_MAX_W, Math.floor(viewportWidth * 0.72)))
  return Math.round(Math.min(Math.max(width, WORKSPACE_PANEL_MIN_W), upper))
}

/** 变更类型 → antd Tag 颜色（纯展示；`claim`/`release` 用中性色） */
export function changeTagColor(type: string): string {
  switch (type) {
    case 'created':
      return 'green'
    case 'updated':
      return 'blue'
    case 'deleted':
      return 'red'
    case 'renamed':
      return 'orange'
    default:
      return 'default'
  }
}

/**
 * 「撤销本轮」结果的**汇总文案**（纯展示；按落点动作计数）。
 *
 * `dryRun` 前置 `[预演]`；空结果 = "本轮无工作区改动"。冲突/不可用不隐藏 —— 它们正是
 * 用户需要知道"为什么没全撤销"的部分（`子方案` §七 5：冲突不静默覆盖）。
 */
export function revertSummaryText(result: Pick<WorkspaceRevertResult, 'dryRun' | 'items'>): string {
  const count = (action: string): number => result.items.filter((item) => item.action === action).length
  const parts: string[] = []
  const restored = count('restored')
  const deleted = count('deleted')
  const skipped = count('skipped')
  const conflict = count('conflict')
  const unavailable = count('unavailable')
  const unsupported = count('unsupported')
  if (restored > 0) parts.push(`还原 ${restored}`)
  if (deleted > 0) parts.push(`删除 ${deleted}`)
  if (skipped > 0) parts.push(`跳过 ${skipped}`)
  if (conflict > 0) parts.push(`冲突 ${conflict}`)
  if (unavailable > 0) parts.push(`缺历史 ${unavailable}`)
  if (unsupported > 0) parts.push(`不支持 ${unsupported}`)
  const body = parts.length === 0 ? '本轮无工作区改动' : parts.join('，')
  return result.dryRun ? `[预演] ${body}` : body
}