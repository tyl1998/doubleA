/**
 * 全局 UI 状态（zustand，P0-1-30）
 *
 * `docs/03-前端设计.md` §六：`stores/` 放 zustand（会话侧栏、SSE 流状态、全局 UI）。
 * 本批只落地"全局 UI"里真的存在的那一项 —— **配色模式**：
 * 它是纯客户端状态（服务端不知道、也不该知道），刷新后要记住，且 AntD 主题与 CSS 令牌
 * 两处都要跟着切。后续批次的会话侧栏 / SSE 流状态各自建自己的 store（`stores/conversation.ts` 等），
 * **不要往这里堆**：这个 store 的定位是"与业务无关的界面开关"。
 *
 * 服务端数据一律不进 zustand —— 那是 TanStack Query 的职责，两处都存必然不一致。
 */

import { create } from 'zustand'

/** 与 `app/theme.ts` 的 `ThemeMode` 同义；这里不 import 它是为了不让 stores 反向依赖 app 层 */
export type UiThemeMode = 'light' | 'dark'

/** localStorage 键名（前缀统一成 `doubulea.`，便于一眼看出是本应用的键） */
const THEME_STORAGE_KEY = 'doubulea.theme'
/** 会话栏卡片样式（完整 / 省略）的持久化键 —— 与配色同款"纯客户端偏好" */
const RAIL_COMPACT_STORAGE_KEY = 'doubulea.railCompact'

/** localStorage 在隐私模式 / 存储被禁用时会抛异常 —— 偏好丢失不值得让页面挂掉 */
function readStoredString(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStoredString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 存不下就只在本次会话生效，不打扰用户
  }
}

function readStoredMode(): UiThemeMode | undefined {
  const raw = readStoredString(THEME_STORAGE_KEY)
  return raw === 'light' || raw === 'dark' ? raw : undefined
}

function writeStoredMode(mode: UiThemeMode): void {
  writeStoredString(THEME_STORAGE_KEY, mode)
}

/** 缺省 = 完整模式（原型与本仓的既有外观） */
function readStoredCompact(): boolean {
  return readStoredString(RAIL_COMPACT_STORAGE_KEY) === '1'
}

/**
 * 把模式写到 `<html data-theme>`。
 *
 * 为什么是**属性**而不是在 `<body>` 上挂 class：`tokens.css` 的暗色覆盖块写的就是
 * `[data-theme="dark"]`，且 `getComputedStyle(document.documentElement)` 读到的
 * 必须是**当前生效**的那一组变量（`app/theme.ts` 靠读变量生成 AntD 主题）。
 */
export function applyThemeMode(mode: UiThemeMode): void {
  document.documentElement.dataset['theme'] = mode
}

/**
 * 初始模式。
 *
 * **刻意不跟随 `prefers-color-scheme`**：本设计的交付主态是浅色"图纸"，
 * 暗色只做到"可用"（`design/README.md` §八），跟随系统会把一部分用户直接放进
 * 没有逐页精修过的那一态。有存储时以存储为准（用户显式点过）。
 */
const INITIAL_MODE: UiThemeMode = readStoredMode() ?? 'light'

/**
 * 会话栏卡片样式：`full` = 现有观感（标题 + 状态灯 + 状态文案 + 智能体徽标 + 时间）；
 * `compact` = 省略态（只留标题 + 状态色点，行更矮）。**纯客户端偏好**（存 localStorage），
 * 与配色 / 语言同款口径 —— 它只影响会话栏怎么画，不影响任何服务端事实。
 */
export type RailCardMode = 'full' | 'compact'

const INITIAL_CARD_MODE: RailCardMode = readStoredCompact() ? 'compact' : 'full'

interface UiState {
  themeMode: UiThemeMode
  setThemeMode: (mode: UiThemeMode) => void
  toggleThemeMode: () => void
  /** 会话栏卡片样式（完整 / 省略） */
  railCardMode: RailCardMode
  toggleRailCardMode: () => void
}

export const useUiStore = create<UiState>((set, get) => ({
  themeMode: INITIAL_MODE,
  setThemeMode: (mode) => {
    writeStoredMode(mode)
    applyThemeMode(mode)
    set({ themeMode: mode })
  },
  toggleThemeMode: () => {
    get().setThemeMode(get().themeMode === 'dark' ? 'light' : 'dark')
  },
  railCardMode: INITIAL_CARD_MODE,
  toggleRailCardMode: () => {
    const next: RailCardMode = get().railCardMode === 'compact' ? 'full' : 'compact'
    writeStoredString(RAIL_COMPACT_STORAGE_KEY, next === 'compact' ? '1' : '0')
    set({ railCardMode: next })
  },
}))

/** 首帧之前就把属性写好，避免"浅色闪一下再变暗"（`main.tsx` 在 render 前调用） */
export function initThemeMode(): void {
  applyThemeMode(INITIAL_MODE)
}
