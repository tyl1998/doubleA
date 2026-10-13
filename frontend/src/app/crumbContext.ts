/**
 * 顶栏面包屑的「细节段」通道（本次布局改造）
 *
 * 背景：面包屑从**页面内部**挪到了**顶栏**（`AppShell`），但二级页的细节名来自查询数据
 * （知识库名 / 智能体名 / 占位页标题），路径里没有 ⇒ 不能在 `nav.ts` 里算出来。
 *
 * 做法：`AppShell` 在顶栏渲染 `工作台 / <模块>`（静态前缀，来自 `nav.ts#crumbBaseForPath`），
 * 二级页在挂载时用 {@link usePageCrumb} 把细节段**上报**给顶栏；离开时清掉。
 *
 * ⚠️ 为什么用 context 而不是在 `AppShell` 里 reset：子组件的 effect 先于父组件运行，
 *    父组件里"按 pathname reset"会在子组件上报之后把它清掉。置空交给上报页自己的
 *    cleanup（卸载 / 依赖变化），顺序天然正确。
 *
 * ⚠️ 列表页**不调用**它 —— 它们的"当前页"就是模块名本身，静态前缀已经够了。
 */

import { createContext, useContext, useEffect } from 'react'

type SetCrumbDetail = (label: string | null) => void

/** 由 `AppShell` 提供；页面侧只用 {@link usePageCrumb}，不要直接消费它。 */
export const PageCrumbContext = createContext<SetCrumbDetail | null>(null)

/**
 * 把一个**细节段**交给顶栏面包屑（`工作台 / 模块 / <label>`）。
 *
 * 必须在组件顶层调用（遵守 Hooks 规则）：页面每次渲染传入当前 label，卸载时自动清空。
 */
export function usePageCrumb(label: string | null): void {
  const setDetail = useContext(PageCrumbContext)
  useEffect(() => {
    if (setDetail === null) return
    setDetail(label)
    return () => {
      setDetail(null)
    }
  }, [setDetail, label])
}
