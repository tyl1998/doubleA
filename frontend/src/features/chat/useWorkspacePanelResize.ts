/**
 * 第三列（工作区 IDE 面板）宽度拖拽（P1-9 · R12；P1-15 · 宽度记忆）
 *
 * 依据：`03` §六 的 hook 纪律（`useMinuteTick.ts` 同款：把"带副作用的时序/手势"收进一个 hook，
 * 让 `ChatPage` 只拿到 `width + 一个 pointerdown`）；`子方案/聊天主页与信息架构改造.md` §七 5
 * （"面板宽度写入 `localStorage`，刷新恢复，替代刷新回默认"）。
 *
 * ⚠️ 宽度只是**客户端选择**，不进 store、不落库：它不影响任何人机共享的真相。
 * 但**要能刷新恢复** ⇒ 存 `localStorage`。键按会话（`storageKey` = 会话 id）——
 * 一个会话的 Code 工作区宽度带到另一个会话是没有道理的（两处文件树 / 编辑器宽度需求不同）。
 *
 * 拖拽时在 `window` 上挂 move/up（而不是元素上），否则指针移出 6px 的把手就丢事件。
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { clampWorkspacePanelWidth, WORKSPACE_PANEL_DEFAULT_W } from './workspaceModel.js'

export interface WorkspacePanelResize {
  /** 当前面板宽度（px） */
  width: number
  /** 正在拖拽（把手高亮用） */
  dragging: boolean
  /** 绑在左侧把手上的 `onPointerDown` */
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

/** `localStorage` 键前缀（按会话存；改前缀 = 所有人的宽度记忆作废一次，故固定） */
const STORAGE_PREFIX = 'doubulea.wsPanelW:'

function storageKeyOf(key: string | undefined): string | null {
  return key === undefined || key === '' ? null : `${STORAGE_PREFIX}${key}`
}

/** 读回记忆宽度（读不到 / 解析失败 / 越界 ⇒ `null`，由调用方回落到默认值） */
function readStoredWidth(key: string): number | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) return null
    return clampWorkspacePanelWidth(value, viewportWidth())
  } catch {
    // 隐私模式 / 存储被禁用：读不到就当没有记忆（不抛、不影响对话）
    return null
  }
}

function writeStoredWidth(key: string, width: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, String(width))
  } catch {
    // 写不进去就算了（记忆是锦上添花，不该因此让拖拽报错）
  }
}

export function useWorkspacePanelResize(enabled: boolean, storageKey?: string): WorkspacePanelResize {
  const key = storageKeyOf(storageKey)
  const [width, setWidth] = useState(() => {
    const stored = key === null ? null : readStoredWidth(key)
    return stored ?? clampWorkspacePanelWidth(WORKSPACE_PANEL_DEFAULT_W, viewportWidth())
  })
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ x: 0, width: 0 })

  // 换会话 ⇒ 换记忆键，把该会话记下的宽度读回来（没有则回默认）
  useEffect(() => {
    if (key === null) return
    const stored = readStoredWidth(key)
    if (stored !== null) setWidth(stored)
    // 只在键变化时重读：拖拽期间的 setWidth 不该被这条 effect 覆盖
  }, [key])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return
      event.preventDefault()
      startRef.current = { x: event.clientX, width }
      setDragging(true)
    },
    [enabled, width],
  )

  // 拖拽期间：向左拖 ⇒ 变宽（把手在面板左缘）
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent): void => {
      const delta = startRef.current.x - event.clientX
      setWidth(clampWorkspacePanelWidth(startRef.current.width + delta, viewportWidth()))
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging])

  // 拖拽结束 ⇒ 记下这次宽度（按会话）
  useEffect(() => {
    if (dragging || key === null) return
    writeStoredWidth(key, width)
  }, [dragging, key, width])

  // 视口变窄时把当前宽度重新夹回合法区间（否则面板会吃掉整条消息流）
  useEffect(() => {
    const onResize = (): void => setWidth((current) => clampWorkspacePanelWidth(current, viewportWidth()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return { width, dragging, onPointerDown }
}