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
  isGitInternalPath as sharedIsGitInternalPath,
  isWorkspaceTextMime,
  isWorkspaceHiddenPath,
  translate,
  type Locale,
  type MessageKey,
  type WorkspaceChangeEntry,
  type WorkspaceEventItem,
  type WorkspaceFileEntry,
  type WorkspaceFileRead,
  type WorkspaceRevertAction,
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
export function conflictText(currentVersion: number | undefined, locale: Locale): string {
  return currentVersion === undefined
    ? translate(locale, 'workspace.conflictNoVersion')
    : translate(locale, 'workspace.conflictWithVersion', { version: currentVersion })
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

/**
 * 把一批目录并进"已展开"集合（去重、保持既有顺序、新目录追加到末尾）—— 纯函数，给 store 用。
 *
 * 用于"agent 改了某个文件 ⇒ 自动展开它所在的目录"（`WorkspacePanel` 的 SSE 处理里调）：
 * 文件树默认全部折叠，不展开就看不见深处的新文件。已在集合里的目录**不动**（不重排，稳定）。
 */
export function unionExpandedDirs(existing: readonly string[], paths: readonly string[]): string[] {
  const seen = new Set(existing)
  const out = [...existing]
  for (const path of paths) {
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * 这条路径是不是 **git 自己的内部文件**（`<repo>/.git/…`，或 `--separate-git-dir` 那种
 * `.git` 文件本身）。
 *
 * 判据本体在 `shared#isGitInternalPath`（前后端**同一处**）——这里只是按本模块的既有习惯
 * 转出一次，免得 `WorkspacePanel` 直接从 `shared` 取（本模块其它判据也都从这里取）。
 *
 * ★ 为什么要单独判（2026-10-27，用户反馈「git 都没变更，为什么拉取下来那些算变更」）：
 *   `.git/` 里的对象 / 索引 / 锁文件在工作区里也是普通文件，`clone --depth` 中途会被
 *   `reconcileWorkspaceOnce` 一条条记成 `created`/`updated`/`deleted`（实测该会话 12 秒里
 *   1988 条事件，其中就有 `repo/.git/objects/pack/tmp_pack_*`、`repo/.git/index.lock`）。
 *   它们已经算工作区内容（进索引、进冷备），但**不该出现在「最近变更」**：用户看那份清单要的是
 *   "谁动了哪些代码"，不是 git 的中间产物。
 */
export const isGitInternalPath = sharedIsGitInternalPath

/**
 * 「最近变更」**每段**最多渲染多少条（本轮 / 更早各算一份）。
 *
 * ★ 2026-10-28：原来是整份清单 `slice(0, 8)`，那是**静默截断** —— 标题里的 count 也是截断后的
 *   数字，容易让人以为"这一轮只改了 8 个文件"。改成按轮分组后各段独立截断，配合标题上的真实
 *   条数（`本轮 · 12` 而不是 8），截断这件事才看得见。
 */
export const WORKSPACE_RECENT_MAX_PER_GROUP = 20

/**
 * 文件差异的 react-query key（会话 + 路径 + 基线版本 + 到版本 + **是否只取计数**）。
 *
 * ★ 2026-10-27（用户反馈「徽标显示 +1 −1，点进去却没有内容改动」）：`stats` 必须进 key。
 *   徽标请求 `{ stats: true }` 只回 `added/removed`、**不带 `lines`**；差异弹窗要的是 `lines`。
 *   两者以前用同一个 key ⇒ 点徽标命中"只有计数"的那份缓存，弹窗拿到 `lines = []`，
 *   于是"有 +1 −1、点开却空"。key 里带上 `stats` 才是两个不同的查询。
 *
 * ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条，各自版本范围）：`toVersion` 也必须进 key。
 *   两条路径相同、基线也可能相同，只有"比到哪个版本"不一样 —— 少这一段，两行会读到同一份缓存，
 *   于是「更早」那条点开显示的是「本轮」的差异。`0` = 不指定（比到当前）。
 *
 * 放在这个**纯函数**模块里（而不是 `api/workspace.ts`）是为了能被零依赖的
 * `verify:workspace-ui` 直接断言 —— 那边不能加载 `import.meta.env`。
 */
export function workspaceFileDiffQueryKey(
  conversationId: string,
  path: string,
  baseVersion?: number,
  stats?: boolean,
  toVersion?: number,
): readonly [string, string, string, number, boolean, number] {
  return ['workspace-diff', conversationId, path, baseVersion ?? 0, stats === true, toVersion ?? 0]
}

/**
 * 一条变更**该跟哪个版本比**（徽标与差异弹窗共用，纯函数）。
 *
 * ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条，各自标明版本范围）：两条的差别**只**在
 *   版本范围里 —— 基线是那一段起点、到版本是那一段末尾。判据写在这里，调用点（列表徽标 /
 *   差异弹窗）才不会各自推一遍而给出"徽标 +2 −1、点开只有 +1 −0"（2026-10-28 用户反馈过）。
 *
 *   · `current` ：「本轮」= 最后一次 agent 派活窗口（或轮末之后的编辑）。
 *     基线优先用服务端给的本轮基线（`beforeVersion`），**并让服务端按本轮窗口复核**（`roundBase`）；
 *     到版本 = 当前盘上内容（不传 `toVersion`）。这样"这一轮整体改了什么"与「撤销本轮」一致。
 *   · `earlier`：「更早」= 本轮起点之前。基线 = 那一段的 `beforeVersion`，
 *     到版本 = 那一段的末版本（`version`）—— 不一路比到此刻，否则两条会显示同一个差异。
 *
 * `baseVersion === undefined` ⇒ 不显式指定，由服务端按默认（前一版）取。
 */
export function workspaceDiffScope(change: {
  version: number | null
  beforeVersion?: number | null
  segment?: 'current' | 'earlier'
}): { roundBase: boolean; baseVersion?: number; toVersion?: number } {
  // ★ 2026-10-28（用户定案「按次：每次保存各算一轮」）：**两段用同一判据** ——
  //   基线就是这条变更自己的 `beforeVersion`（= 这一跳之前那一版）。
  //   ① 本级那条不再请求 `roundBase`（那是"本轮窗口整体"口径，会把多次保存合并）；
  //   ② 「更早」那一条的到版本 = 它自己的末版本（`toVersion`），不一路比到此刻，
  //      否则同一文件两条会显示同一个"从很久以前到现在"的差异。
  //   `beforeVersion === null` = 那一段开始时文件不存在（新建）⇒ 明确传 0（基线不存在）。
  const baseVersion =
    change.beforeVersion === null
      ? 0
      : (change.beforeVersion ??
        (change.version !== null && change.version > 1 ? change.version - 1 : undefined))
  const hasBaseline = change.beforeVersion === undefined ? false : true
  return {
    // 保留 `roundBase` 字段（后端仍支持），但只有在**拿不到**这条自己的基线时才回退到它
    roundBase: !hasBaseline,
    ...(baseVersion === undefined ? {} : { baseVersion }),
    ...(change.segment === 'earlier' && change.version !== null ? { toVersion: change.version } : {}),
  }
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
 * 容器内的工作区挂载点（`/work`）—— 工作区绝对路径的**根**。
 *
 * ⚠️ 这是**容器里**的路径，不是宿主路径：它正是 agent 看到的那个（`bash` / 编辑器 / 我写的代码
 * 都在 `/work/<相对路径>`），而且与部署无关 —— 宿主路径随机器而变，复制出去对谁都不可用。
 * （挂载点由 `backend/src/sandbox/spec.ts` 的 bind mount 决定；两处是同一件事的两种说法。）
 */
export const WORKSPACE_CONTAINER_ROOT = '/work'

/** 右键「复制」的三种口径（见 {@link workspaceCopyValue}） */
export type WorkspaceCopyKind = 'relative' | 'absolute' | 'name'

/**
 * 右键「复制」要写进剪贴板的那条字符串（**纯函数**）。
 *
 *   · `relative` ⇒ `Demo/debug/debug_demo.py`（工作区相对路径，唯一无歧义的那种）
 *   · `absolute` ⇒ `/work/Demo/debug/debug_demo.py`（容器内绝对路径；见 {@link WORKSPACE_CONTAINER_ROOT}）
 *   · `name`     ⇒ `debug_demo.py`（末段名字；文件与目录同款）
 */
export function workspaceCopyValue(kind: WorkspaceCopyKind, path: string): string {
  if (kind === 'name') return workspaceBaseName(path)
  if (kind === 'absolute') return `${WORKSPACE_CONTAINER_ROOT}/${path}`
  return path
}

/**
 * 菜单里三种口径的文案（与 {@link workspaceCopyValue} **一一对应**，顺序也用这一份 ——
 * 免得"菜单写着一套、复制出来另一套"这种只有用户点了才知道的错位）。
 */
export const WORKSPACE_COPY_ITEM_KEYS: readonly { key: WorkspaceCopyKind; labelKey: MessageKey }[] = [
  { key: 'relative', labelKey: 'workspace.copyRelative' },
  { key: 'absolute', labelKey: 'workspace.copyAbsolute' },
  { key: 'name', labelKey: 'workspace.copyName' },
]

/** 复制子菜单的项（`label` 已按当前语言译好；`absolute` 那条插进容器根路径） */
export function workspaceCopyItems(locale: Locale): { key: WorkspaceCopyKind; label: string }[] {
  return WORKSPACE_COPY_ITEM_KEYS.map((item) => ({
    key: item.key,
    label: translate(locale, item.labelKey, { root: WORKSPACE_CONTAINER_ROOT }),
  }))
}

/**
 * git 分支 chip 上显示的文本（**纯函数**）。
 *
 * 分支名直显；detached HEAD 时 `branch` 里装的是短 SHA ⇒ 显成 `detached@<短SHA>`（一眼看出不是分支）；
 * `branch === null`（HEAD 形状不认识 / 读不到）⇒ `未知分支`，**不猜**。
 */
export function workspaceGitChipLabel(repo: { branch: string | null; detached: boolean }, locale: Locale): string {
  if (repo.branch === null) return translate(locale, 'workspace.branchUnknown')
  return repo.detached ? `detached@${repo.branch}` : repo.branch
}

/** git chip 的 `title`（鼠标悬停的完整口径：仓库位置 + detached 说明） */
export function workspaceGitChipTitle(
  repo: { path: string; branch: string | null; detached: boolean },
  locale: Locale,
): string {
  const where = repo.path === '' ? translate(locale, 'workspace.gitRoot') : repo.path
  const what = workspaceGitChipLabel(repo, locale)
  return repo.detached
    ? translate(locale, 'workspace.gitDetached', { where, what })
    : translate(locale, 'workspace.gitTitle', { where, what })
}

/**
 * `path` 是否落在目录 `dir` **之下**（含任意深）—— 删除文件夹时用它筛"该关掉哪些标签 / 清哪些草稿"。
 *
 * ⚠️ 尾斜杠是判据的关键：`'out'` 只匹配 `'out/…'`，不误伤同前缀的 `'outsider.txt'` / `'out2/x'`。
 *   （后端同一判据在 `backend/src/workspace/dirModel.ts`，两处口径一致。）
 */
export function isWorkspacePathInDir(path: string, dir: string): boolean {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  return path.startsWith(prefix)
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

/**
 * 输入框里那串最终落到哪个路径（纯函数）—— 右键目标目录会**预填**在框里（`a/`），
 * 用户很容易连前缀一起再敲一遍（`a/x.py`）。
 *
 * ★ 2026-10-29 用户实测：在 `a` 上右键新建、输入 `a/x.py` ⇒ 实际建出 `a/a/x.py`。
 *   口径：预填就是"这个目录下"，用户从**预填值**接着敲（`a/x.py`）时不再叠前缀；
 *   而用户主动改成别的目录（`b/x.py`）则按用户写的走 —— 判据是"是否以预填值开头"，
 *   不是"有没有出现过斜杠"。
 *
 * @param dir   右键的目标目录（根 = `''`）
 * @param input 输入框里的原文
 */
export function workspaceResolvePromptPath(dir: string, input: string): string {
  const value = input.trim().replace(/\\/gu, '/')
  if (dir === '') return value
  const prefix = `${dir}/`
  if (value.startsWith(prefix)) return value.slice(prefix.length)
  // 用户只敲了目录本身（`a`）⇒ 等价于"在 a 下"，名字留空由调用方拦（空名不该创建）
  return value === dir ? '' : value
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
/**
 * 语言 id → 读数。
 *
 * ⚠️ 除 `text` 外都是**专有名词**（JavaScript / TypeScript / JSON…），zh/en 两语言**同形**，
 * 所以它们不是 i18n key（进字典只会得到两份一模一样的译文）。只有 `text` 的读法随语言变
 * （中文「纯文本」/ 英文 `Plain text`）。
 */
const WORKSPACE_LANGUAGE_LABELS: Record<WorkspaceEditorLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  python: 'Python',
  markdown: 'Markdown',
  text: '',
}

export function workspaceLanguageLabel(language: WorkspaceEditorLanguage, locale: Locale): string {
  return language === 'text' ? translate(locale, 'workspace.languageText') : WORKSPACE_LANGUAGE_LABELS[language]
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
 * 一条文件路径的**所有祖先目录**（`a/b/c.ts` ⇒ `['a', 'a/b']`；根层文件 ⇒ `[]`）。
 *
 * 给"agent 改了某个文件 ⇒ 自动展开它所在的目录"用：文件树**默认全部折叠**（`WorkspaceTree`），
 * 于是 agent 深处的改动不展开就看不见（用户反馈："agent 新增/编辑过的文件没有展示"）。纯函数。
 */
export function workspaceAncestorDirs(path: string): string[] {
  const segments = path.split('/')
  const dirs: string[] = []
  let prefix = ''
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? ''
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    dirs.push(prefix)
  }
  return dirs
}

/**
 * 保留期提示的**提示阈值**（天）：剩余天数 ≤ 这个值才在面板上提醒。
 *
 * 2026-10-28：这是"该备份了"的提前量，不是保留期本身 —— 保留期在服务端 env 里。
 */
export const WORKSPACE_RETENTION_NOTICE_DAYS = 2

/**
 * 距到期还有几天（向上取整，纯函数）—— 已过期返回 `0`，绝不返回负数。
 *
 * ★ 2026-10-28（用户反馈"docx 被静默删掉"）：提示文案要能说"还有 N 天"，
 *   这个数字必须与 `expiresAt` 同一口径（JS 侧毫秒差），不能拿服务端天数减本地日期猜。
 */
export function retentionDaysLeft(expiresAt: string, nowMs: number): number {
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return 0
  const diff = at - nowMs
  if (diff <= 0) return 0
  return Math.ceil(diff / (24 * 60 * 60 * 1000))
}

/**
 * 一份变更清单该按哪种口径展示（纯函数；与后端 `changesModel#workspaceChangeGrouping` 同一判据）。
 *
 * ★ 2026-10-28（用户定案「手写是一等公民」）：**从没派过活、只有手写的会话**不该出现
 *   「本轮 / 更早」两段 —— 那是"二手数据"的视觉，用户会以为自己看到的是残缺状态。
 *   判据只用清单**自身**已有的数据：
 *   · 清单里有 `AGENT` 写入 ⇒ `rounds`（分「本轮 / 更早」）；
 *   · 全是 `USER` / `SYSTEM` ⇒ `history`（标题叫「变更历史」，一条平铺清单）。
 *
 * ⚠️ 不拿 `round.start` 是否存在来判：那个字段按「最后一条用户消息」算，纯手写会话也可能有。
 */
export function workspaceChangeGrouping(
  items: readonly Pick<WorkspaceChangeEntry, 'actor'>[],
): 'rounds' | 'history' {
  // ★ 2026-10-28 实测修正：不是"有 AGENT 才算 rounds"，而是"全是 USER 才算 history" ——
  //   真跑过 agent 的会话，事件往往是 `SYSTEM`（对账 / clone / 引擎写），`AGENT` 一条都没有。
  if (items.length === 0) return 'history'
  return items.every((item) => item.actor === 'USER') ? 'history' : 'rounds'
}

/**
 * 「最近变更」里一条的**去重键**：段 + 路径。
 *
 * ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各留一条）：服务端会为"两段都动过"的路径回
 *   **两条**，各自带那一段的版本范围。所以合并键**不能只有路径** —— 否则后一条会把前一条顶掉，
 *   又退回"一条盖住另一段"。实时事件永远算「本轮」，只更新本轮那条，不碰更早那条。
 */
function changeMergeKey(change: Pick<WorkspaceChangeEntry, 'path' | 'segment'>): string {
  return `${change.segment ?? 'current'}\u0000${change.path}`
}

/**
 * 把**服务端变更集**（刷新 / 初次进入会话时拉的那份，已是"按段按路径折叠后的最新状态"）与
 * **实时 SSE 事件**合并成展示用的「最近变更」清单（**纯函数**，前后端同用 `foldWorkspaceEvents` 的口径）。
 *
 * 口径：
 *   · **同一段、同一路径**只留**最后一条**（`at` 最大；`at` 相同以实时事件胜）；
 *     同一路径的两段（本轮 / 更早）各自保留一条（见 {@link changeMergeKey}）；
 *   · **只认内容事件**（`created`/`updated`/`deleted`/`renamed`）—— `claim`/`release` 不改变字节，
 *     混进来会把真正的改动顶掉（看起来像"改的是锁、不是文件"）；
 *   · 结果按 `at` 倒序（最近动的在前）。
 *
 * ⚠️ 为什么要有它：面板原来**只**累积实时 SSE 事件 ⇒ 刷新 / 刚进会话时列表是空的
 * （服务端那份变更集从未被拉取），于是"最近变更"看起来永远不出现。
 */
export function mergeWorkspaceChanges(
  serverChanges: readonly WorkspaceChangeEntry[],
  liveEvents: readonly WorkspaceEventItem[],
): WorkspaceChangeEntry[] {
  const byKey = new Map<string, WorkspaceChangeEntry>()
  for (const change of serverChanges) {
    if (!isContentEvent(change)) continue
    byKey.set(changeMergeKey(change), change)
  }
  // ★ 2026-10-28（用户定案：**每个文件各自最近一次保存**进「本轮」）：
  //   实时事件就是该文件的最近一次保存 ⇒ 它进「本轮」。别的文件的条目**不受影响**
  //   （key 含 path ⇒ A、B、C 各自一条；不会出现"最后只展示 C"）。
  //
  //   ⚠️ 同一文件原来那条「本轮」不能被悄悄覆盖掉（否则"编辑第二次"就看不出前后两次了）：
  //   它要**降级成「更早」**留下，与服务端重新拉取后的划分一致（`S4` 用例锁住这个口径）。
  for (const event of liveEvents) {
    if (!isContentEvent(event)) continue
    const key = changeMergeKey({ path: event.path, segment: 'current' })
    const replaced = byKey.get(key)
    if (replaced !== undefined && replaced.at < event.at) {
      // 被这次保存顶掉的那一条 ⇒ 降级为更早（同一路径可能已有更早条目，保留较新的一条）
      const earlierKey = changeMergeKey({ path: replaced.path, segment: 'earlier' })
      const existingEarlier = byKey.get(earlierKey)
      if (existingEarlier === undefined || existingEarlier.at < replaced.at) {
        // 「更早」压成一条 ⇒ 取**较新**那一跳的末版本，但基线沿用原更早那条（= 轮前段起点），
        // 否则基线会退化成"上一跳之前"，把更早那段的开头丢掉。
        byKey.set(earlierKey, {
          ...replaced,
          segment: 'earlier',
          ...(existingEarlier?.beforeVersion === undefined
            ? {}
            : { beforeVersion: existingEarlier.beforeVersion }),
        })
      }
    }
    const current = byKey.get(key)
    if (current === undefined || event.at >= current.at) {
      byKey.set(key, {
        path: event.path,
        type: event.type,
        version: event.version,
        actor: event.actor,
        actorId: event.actorId,
        at: event.at,
        segment: 'current',
        // ★ 2026-10-28：基线必须跟着**这一跳**走。本轮 = 该文件最近一次保存 ⇒ 基线 = 前一版
        //   （`version - 1`，与服务端 `beforeOf` 同口径）。不能沿用被顶掉那条的基线 ——
        //   那会把"33→44 这次"显示成"轮初→44"，正是用户指出的问题。
        ...(event.version === null || event.version <= 1 ? {} : { beforeVersion: event.version - 1 }),
      })
    }
  }
  return [...byKey.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/**
 * 把「最近变更」清单按**轮次**切成两段：`本轮`（`at >= 轮起点`）与 `更早`。
 *
 * ★ 2026-10-28（用户定案）：面板原来是一条扁平列表，标题叫「最近变更」，很容易被误读成
 *   "这一轮改了什么"；实际它是**本会话工作区历来的改动**（见 `listWorkspaceChanges` 的全量口径）。
 *   这里按后端回的**本轮窗口**（`round.start`）分组，让"本轮"与"更早"一眼分开。
 *
 * ★ 2026-10-28 追加（用户定案）：同一路径两段都动过时**各留一条**。服务端已经把每条的 `segment`
 *   标好了（`current`/`earlier`），这里**以标记为准**；只有标记缺省时（旧响应 / 实时事件）
 *   才退回时间比较。两条各自带自己那一段的版本范围，才是"能看出两段都动过这个文件"。
 *
 * 纯函数（不碰时间以外的东西），`verify:workspace-ui` 可直接断言：
 *   · `round === undefined`（从没派过活 / 新会话）⇒ 全部算「更早」，不编造一个空「本轮」；
 *   · 边界取 `>=`（起点那一刻的写入算**本轮**，与 `listWorkspaceChanges(since)` 同口径）；
 *   · 两段各自保持入参顺序（调用方已按 `at` 倒序），不重排。
 */
export function groupWorkspaceChangesByRound(
  changes: readonly WorkspaceChangeEntry[],
  round: { start: string; end?: string } | undefined,
): { current: WorkspaceChangeEntry[]; earlier: WorkspaceChangeEntry[] } {
  if (round === undefined) return { current: [], earlier: [...changes] }
  const startMs = Date.parse(round.start)
  if (Number.isNaN(startMs)) return { current: [], earlier: [...changes] }
  const current: WorkspaceChangeEntry[] = []
  const earlier: WorkspaceChangeEntry[] = []
  for (const change of changes) {
    if (change.segment !== undefined) {
      // 服务端标的段优先（它就是"按轮分段、同路径两条"的真相）
      if (change.segment === 'current') current.push(change)
      else earlier.push(change)
      continue
    }
    const at = Date.parse(change.at)
    // 兜底：`at` 解析不了 ⇒ 算「更早」（宁可少标本轮，也不把旧的冒充成本轮）
    if (!Number.isNaN(at) && at >= startMs) current.push(change)
    else earlier.push(change)
  }
  return { current, earlier }
}

/** 撤销落点动作 → 人读文案（「撤销本轮」报告用；纯展示） */
const REVERT_ACTION_KEYS: Record<WorkspaceRevertAction, MessageKey> = {
  restored: 'workspace.revertActionRestored',
  deleted: 'workspace.revertActionDeleted',
  skipped: 'workspace.revertActionSkipped',
  conflict: 'workspace.revertActionConflict',
  unavailable: 'workspace.revertActionUnavailable',
  unsupported: 'workspace.revertActionUnsupported',
}

export function revertActionLabel(action: WorkspaceRevertAction, locale: Locale): string {
  return translate(locale, REVERT_ACTION_KEYS[action])
}

/**
 * 「撤销本轮」结果的**汇总文案**（纯展示；按落点动作计数）。
 *
 * `dryRun` 前置 `[预演]`；空结果 = "本轮无工作区改动"。冲突/不可用不隐藏 —— 它们正是
 * 用户需要知道"为什么没全撤销"的部分（`子方案` §七 5：冲突不静默覆盖）。
 */
export function revertSummaryText(
  result: Pick<WorkspaceRevertResult, 'dryRun' | 'items'>,
  locale: Locale,
): string {
  const count = (action: string): number => result.items.filter((item) => item.action === action).length
  const parts: string[] = []
  const buckets: { action: WorkspaceRevertAction; key: MessageKey }[] = [
    { action: 'restored', key: 'workspace.revertSummaryRestored' },
    { action: 'deleted', key: 'workspace.revertSummaryDeleted' },
    { action: 'skipped', key: 'workspace.revertSummarySkipped' },
    { action: 'conflict', key: 'workspace.revertSummaryConflict' },
    { action: 'unavailable', key: 'workspace.revertSummaryUnavailable' },
    { action: 'unsupported', key: 'workspace.revertSummaryUnsupported' },
  ]
  for (const bucket of buckets) {
    const n = count(bucket.action)
    if (n > 0) parts.push(translate(locale, bucket.key, { count: n }))
  }
  const body =
    parts.length === 0
      ? translate(locale, 'workspace.revertSummaryNone')
      : parts.join(translate(locale, 'workspace.revertSummarySeparator'))
  return result.dryRun ? translate(locale, 'workspace.revertSummaryDryRunPrefix', { body }) : body
}