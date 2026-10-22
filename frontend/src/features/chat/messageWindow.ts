/**
 * 消息流的**渲染窗口**（内存优化 P5a，`docs/子方案/前端长会话内存优化.md`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它（而不是一上来就做虚拟滚动）
 * ─────────────────────────────────────────────────────────────────────
 * 一个聊得很久的会话，`messages` 可以有几千条视图（历史每一轮两条 + 插话若干）。全部交给
 * `MessageList` 渲染意味着：
 *   · 几千棵 `<article>`，其中一半是 `react-markdown` 的输出（长回答一棵上千节点）；
 *   · 每次流式帧、每次滚动、每次窗口缩放，浏览器都要在这么一棵树上做样式 / 布局。
 * 真·虚拟滚动能把 DOM 数量压到"视口那几十条"，但它要和"贴底跟随（`pinnedRef`）""流式长高"
 * 两套逻辑一起改，风险明显高于收益 —— 所以本批先做一个**温和的上限**：
 *
 *   · 默认只渲染**最近 N 条视图**（{@link HISTORY_RENDER_LIMIT}）；
 *   · 更早的部分收成消息流最上面的一条「加载更早的消息」占位（与现有分页按钮同一位置、同一手势）；
 *   · 用户点开后**本次会话内保持展开**（`expanded === true` 时等于不设上限）。
 *
 * 数据层完全不动：`useInfiniteQuery` 仍然持有翻过的所有页，这里只决定"画多少"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么按"视图"而不是"消息"
 * ─────────────────────────────────────────────────────────────────────
 * `messagesToViews` 会把一条助手消息展开成"回答 + N 条插话"，而 `MessageList` 的入参就是这个
 * 视图数组。按视图计数才是"DOM 条目数"的近似；按消息计数会让插话多的会话悄悄翻倍。
 *
 * 纯函数、零依赖 ⇒ 可被无依赖档直接断言。
 */

/**
 * 默认渲染多少条视图（≈ 60 轮问答）。
 *
 * 数字的依据：一屏约 3～5 条消息，60 轮 ≈ 120～200 条视图 ⇒ 屏外至少还有十几屏可滚，
 * 用户**不会**觉得"历史被藏起来了"。它对应约 3000～6000 个 DOM 节点（含 Markdown），
 * 在这一量级以下布局与 GC 都很稳。
 */
export const HISTORY_RENDER_LIMIT = 120

export interface MessageWindow {
  /** 实际交给 `MessageList` 的那些视图（顺序原样，只截前段） */
  visible: readonly unknown[]
  /** 被收起来的条数（`0` = 什么都没藏，界面上不该出现占位） */
  hiddenCount: number
}

/**
 * 计算渲染窗口。
 *
 * @param messages 全部视图（旧 → 新）
 * @param options.limit 上限（默认 {@link HISTORY_RENDER_LIMIT}）
 * @param options.expanded 用户已点开"更早的消息" ⇒ 返回全量
 *
 * ⚠️ 刻意**保留尾部**（最新的那些）：贴底跟随、`regenerable` / `recallable` 判"最新一轮"、
 * 流式那一轮都挂在尾部 —— 截掉尾部会同时坏掉四件事。截头部只影响"更早的历史"。
 */
export function windowMessages<T>(
  messages: readonly T[],
  options: { limit?: number; expanded?: boolean } = {},
): MessageWindow {
  const limit = Math.max(1, options.limit ?? HISTORY_RENDER_LIMIT)
  if (options.expanded === true || messages.length <= limit) {
    return { visible: messages, hiddenCount: 0 }
  }
  const start = messages.length - limit
  return { visible: messages.slice(start), hiddenCount: start }
}
