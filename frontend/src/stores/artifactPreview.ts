/**
 * 「正在预览哪个产物」—— P0-3-11（产物面板 + 预览弹层的接入点）
 *
 * 依据：`docs/03-前端设计.md` §4.1（产物卡「[预览] [下载]」）、§4.6（统一为抽屉/全屏弹层）、
 *      `docs/子方案/文件预览.md` §七 1（「产物卡（`features/chat/ArtifactCard`）把 `artifactId`
 *      交给弹层」）、`docs/06-实施计划.md` §五 P0-3-11 行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是一个 store，而不是从 `ChatPage` 逐层传下去
 * ─────────────────────────────────────────────────────────────────────
 * 弹层必须住在 `ChatPage`（产物面板与消息流是 `.chat` 下的**两个兄弟列**，弹层要在两列之上），
 * 而「点预览」这个动作发生在**四个层级之下**：`ChatPage → MessageList → AssistantMessage → ArtifactCard`
 * —— 中间两层是纯展示组件（`MessageList` 的文件头写着它的入参就是"一个 `ChatMessageView[]`"），
 * 为了一个点击事件给它们各加一个自己不用的回调参数，是把接线成本摊到与它无关的组件上。
 *
 * ⚠️ 这个 store 里放的**不是服务端数据**（`stores/ui.ts` 的纪律"服务端数据一律不进 zustand"
 * 在这里不冲突）：它存的是"用户此刻打开了哪一张卡"这个**纯客户端选择**，
 * 而那四个字段（id / 名字 / 大小 / mime）只是弹层标题栏要显示的东西 —— 它们同时也在
 * 那张卡自己手上（面板项来自列表、卡来自 `artifact` 事件），这里不做任何缓存或去重。
 * 于是它不会与 TanStack Query 里那份列表分叉：**唯一的真相仍在 `ArtifactCard` 手上**。
 *
 * ⚠️ 刻意**不做成 `Map` / 队列**：一次只可能预览一个产物（抽屉是独占的），
 * 留一个"打开过哪些"的列表只会引出"关掉最上面那个之后该显示哪个"这种凭空的问题。
 */

import { create } from 'zustand'

import type { ArtifactItem } from '@doubulea/shared'

interface ArtifactPreviewState {
  /** 正在预览的产物；`null` = 没有在预览（抽屉的 `open`） */
  preview: ArtifactItem | null
  openPreview: (artifact: ArtifactItem) => void
  closePreview: () => void
}

export const useArtifactPreviewStore = create<ArtifactPreviewState>((set) => ({
  preview: null,
  /**
   * 打开预览。
   *
   * ⚠️ 传进来的对象**存引用不拷贝**：`ArtifactPanelItem`（列表那一路）与 `ArtifactView`
   * （`artifact` 事件那一路）都比 `ArtifactItem` 多带了字段，拷贝会把这些字段丢掉 ——
   * 而弹层只读那四个（`artifactId` / `fileName` / `size` / `mime`），多带的字段不会造成伤害。
   * 反过来说：**弹层不许读那四个之外的字段**（它拿到的对象可能来自任何一路）。
   */
  openPreview: (artifact) => set({ preview: artifact }),
  /**
   * 关掉预览。
   *
   * ⚠️ 只把 `preview` 置 `null`，**不 abort 在飞的取文本请求** —— 那是 `ArtifactPreviewDrawer`
   * 自己的 effect 卸载时做的事（它的 `AbortController` 在组件内部）。在这里 abort
   * 等于让 store 去管一个它看不见的对象。
   */
  closePreview: () => set({ preview: null }),
}))
