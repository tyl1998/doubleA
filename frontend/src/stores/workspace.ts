/**
 * 工作区面板的**纯客户端选择**（P1-9 · P3；R12 多标签 · 跨会话保留）
 *
 * 依据：`stores/ui.ts` 的纪律（**服务端数据一律不进 zustand**）、`03` §六。
 * 这里只放"每个会话打开了哪些文件 / 哪个是当前标签"这个**客户端选择** —— 文件树 / 文件内容 /
 * 草稿都来自 react-query 与面板本地编辑态，不进本 store（与 `stores/artifactPreview.ts` 同款取舍）。
 *
 * ⚠️ 标签**按会话**存（`tabsByConversation`）：切走再切回，之前打开的文件还在。会话被删除时由
 * `ChatPage` 调 {@link dropConversation} 回收，避免长期挂着的会话表无限增长。
 */

import { create } from 'zustand'

import { nextActiveOnClose, renameOpenTab, toggleExpandedDir, withOpenedTab } from '../features/chat/workspaceModel.js'

/** 一个会话的标签态 */
export interface WorkspaceTabs {
  /** 打开的标签（插入顺序）；`[]` = 没有打开任何文件 */
  openPaths: string[]
  /** 当前聚焦的标签（**归一化相对路径**）；`null` = 编辑器空态 */
  activePath: string | null
}

const EMPTY_TABS: WorkspaceTabs = { openPaths: [], activePath: null }
/** 没有展开任何目录时的稳定引用（`[]` 每次新建会让 selector 空转重渲染） */
const EMPTY_EXPANDED: readonly string[] = []

/**
 * "被展开的目录"落 localStorage 的键。
 *
 * ⚠️ 与 `openPaths` **不同**：标签是"本次会话的临时选择"，刷新丢掉可接受；而"我展开了哪些目录"
 * 是**用户对工作区的浏览位置**，重进会话 / 刷新页面都该记得住（产品反馈 2026-10-14）。
 * 所以这一份**持久化**（写法对齐 `stores/ui.ts` 的 `doubulea.theme`）。
 */
const EXPANDED_STORAGE_KEY = 'doubulea.ws-expanded'

/** localStorage 在隐私模式 / 存储被禁用时会抛异常 —— 浏览位置丢失不值得让页面挂掉 */
function readStoredExpanded(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) out[conversationId] = value.filter((item): item is string => typeof item === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function writeStoredExpanded(value: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 存不下就只在本次会话生效，不打扰用户
  }
}

interface WorkspaceState {
  tabsByConversation: Record<string, WorkspaceTabs>
  /** 每个会话"被展开的目录"（初始空 = 全部折叠，见 `WorkspaceTree`）；落 localStorage，重进/刷新记得住 */
  expandedByConversation: Record<string, string[]>
  /** 打开（或聚焦已打开的）一个文件 */
  openFile: (conversationId: string, path: string) => void
  /** 聚焦一个已打开的标签 */
  activateFile: (conversationId: string, path: string) => void
  /** 关闭一个标签；关的是当前标签时按邻居补位 */
  closeFile: (conversationId: string, path: string) => void
  /** 改名 / 移动：把打开态里 `from` 迁到 `to`（去重），当前标签也跟着迁 */
  renameFile: (conversationId: string, from: string, to: string) => void
  /** 展开 / 折叠一个目录（`WorkspaceTree` 用） */
  toggleExpanded: (conversationId: string, path: string) => void
  /** 关闭某会话的所有标签 */
  closeAll: (conversationId: string) => void
  /** 会话被删除：整份回收（避免 `tabsByConversation` 无限增长） */
  dropConversation: (conversationId: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  tabsByConversation: {},
  expandedByConversation: readStoredExpanded(),
  openFile: (conversationId, path) =>
    set((state) => {
      const tabs = state.tabsByConversation[conversationId] ?? EMPTY_TABS
      return {
        tabsByConversation: {
          ...state.tabsByConversation,
          [conversationId]: { openPaths: withOpenedTab(tabs.openPaths, path), activePath: path },
        },
      }
    }),
  activateFile: (conversationId, path) =>
    set((state) => {
      const tabs = state.tabsByConversation[conversationId]
      if (tabs === undefined || tabs.activePath === path) return state
      return {
        tabsByConversation: { ...state.tabsByConversation, [conversationId]: { ...tabs, activePath: path } },
      }
    }),
  closeFile: (conversationId, path) =>
    set((state) => {
      const tabs = state.tabsByConversation[conversationId]
      if (tabs === undefined || !tabs.openPaths.includes(path)) return state
      const next: WorkspaceTabs = {
        openPaths: tabs.openPaths.filter((item) => item !== path),
        activePath: tabs.activePath === path ? nextActiveOnClose(tabs.openPaths, path) : tabs.activePath,
      }
      return { tabsByConversation: { ...state.tabsByConversation, [conversationId]: next } }
    }),
  renameFile: (conversationId, from, to) =>
    set((state) => {
      const tabs = state.tabsByConversation[conversationId]
      if (tabs === undefined || !tabs.openPaths.includes(from)) return state
      const next: WorkspaceTabs = {
        openPaths: renameOpenTab(tabs.openPaths, from, to),
        activePath: tabs.activePath === from ? to : tabs.activePath,
      }
      return { tabsByConversation: { ...state.tabsByConversation, [conversationId]: next } }
    }),
  toggleExpanded: (conversationId, path) =>
    set((state) => {
      const expandedByConversation = {
        ...state.expandedByConversation,
        [conversationId]: toggleExpandedDir(state.expandedByConversation[conversationId] ?? [], path),
      }
      writeStoredExpanded(expandedByConversation)
      return { expandedByConversation }
    }),
  closeAll: (conversationId) =>
    set((state) =>
      state.tabsByConversation[conversationId] === undefined
        ? state
        : { tabsByConversation: { ...state.tabsByConversation, [conversationId]: EMPTY_TABS } },
    ),
  dropConversation: (conversationId) =>
    set((state) => {
      const hasTabs = conversationId in state.tabsByConversation
      const hasExpanded = conversationId in state.expandedByConversation
      if (!hasTabs && !hasExpanded) return state
      const tabsByConversation = { ...state.tabsByConversation }
      delete tabsByConversation[conversationId]
      const expandedByConversation = { ...state.expandedByConversation }
      delete expandedByConversation[conversationId]
      writeStoredExpanded(expandedByConversation)
      return { tabsByConversation, expandedByConversation }
    }),
}))

/** 订阅某会话的标签态（两条独立 selector：避免每次返回新对象导致的空转重渲染） */
export function useWorkspaceTabs(conversationId: string): WorkspaceTabs {
  const openPaths = useWorkspaceStore((state) => state.tabsByConversation[conversationId]?.openPaths ?? EMPTY_TABS.openPaths)
  const activePath = useWorkspaceStore(
    (state) => state.tabsByConversation[conversationId]?.activePath ?? EMPTY_TABS.activePath,
  )
  return { openPaths, activePath }
}

/** 订阅某会话"被展开的目录"（返回稳定引用：没展开过时是同一个空数组） */
export function useWorkspaceExpandedDirs(conversationId: string): readonly string[] {
  return useWorkspaceStore((state) => state.expandedByConversation[conversationId] ?? EMPTY_EXPANDED)
}
