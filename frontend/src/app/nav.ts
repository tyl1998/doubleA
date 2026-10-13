/**
 * 全局导航定义（P0-1-30）
 *
 * 依据：`docs/03-前端设计.md` §二（14 条路由与权限列）、§三（全局布局：左侧栏 + 顶栏面包屑 +
 *      头像菜单 + **「管理」入口仅 ADMIN 可见**）、§七（文案词表：统一「智能体」）。
 *
 * **全局导航只有一个渲染出口：左侧栏**（顶栏已改成「快捷页面导航」= 面包屑，不再是目的地列表）。
 * 左侧栏与对话页的「工作台」下拉共用本列表（`visibleNavItems`），分开写两份必然出现
 * "某一处少了某项"这类不一致。**权限判据只有一处**：`adminOnly`。
 *
 * ⚠️ 原型（`design/*.html`）的左侧栏上写的是 `00 / LG / AG / ED / CH / KB / MC` —— 那是
 * **设计原型自己的屏号**（00=定调页、LG=登录页、ED=编辑页…），不是产品路由。落地时必须按
 * `03` §二 重新推导，只保留"真实目的地"。以下保留的字母缩写只作**稳定标识**（本仓用它认领图标），
 * 不是照抄原型。
 */

import type { UserRole } from '@doubulea/shared'

import { AGENTS_PATH, HOME_PATH } from './paths.js'

export interface NavItem {
  /** 导航项的稳定标识（本仓用它映射图标；原型里是左侧栏上的等宽字形） */
  code: string
  label: string
  path: string
  /** 仪器读数式的屏号，显示在左侧栏底部（`design/*.html` 的 `.rail__serial`） */
  serial: string
  /** ADMIN 专属入口（`03` §三：管理入口仅 ADMIN 可见） */
  adminOnly?: boolean
  /**
   * 该条目对应的页面属哪个批次。
   *
   * ⚠️ 这是一个**给维护者看的台账，当前没有任何渲染出口**（占位页的批次文案来自路由表里
   * 那条 `BatchPlaceholderPage` 的 `batch` prop）。所以它不会自己消失：**页面落地时必须手工删掉
   * 这一项**（P0-1-31 把 `AG` 的值清掉了），否则这份台账会慢慢变成"哪些页还没做"的错误答案
   * —— 而它存在的唯一理由就是回答这个问题。
   */
  batch?: string
}

/**
 * 顺序即导航顺序。`03` §三 的顶栏是「智能体 / 知识库 / MCP / 任务」，
 * 这里做了两处**有依据的**调整：
 * - 加「我的凭据」：`03` §二 路由表里它是独立页面（P0），且 §4.2 要求"从 Agent 编辑页
 *   或工具失败卡直达"，放进全局导航才不会成为孤岛（§三 的动线要求）。⚠️ 它**与 MCP 解耦**：
 *   路由是 `/settings/credentials`（个人设置族，与 `/settings/password` 同族），
 *   **刻意不排在 `MC` 后面**，免得被读成 MCP 的子页；
 * - 「任务」P1-6 已落地（`03` §4.7 的**定时任务**管理），本批进导航（此前因"点进去是空壳"而刻意不进）。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // 已落地 ⇒ 不带 `batch`。⚠️ **P1-15 起 `/` 是聊天主页**，智能体列表搬到这里（管理目的地之一）；
  // 对话从聊天主页进，不再从列表进 —— 列表页仍保留「对话」入口（直达新会话态）。
  { code: 'AG', label: '智能体', path: AGENTS_PATH, serial: 'S-02 · 智能体' },
  // 已落地 ⇒ 不带 `batch`（P0-1-35 把知识库列表与详情换成真实页面）
  { code: 'KB', label: '知识库', path: '/knowledge', serial: 'S-05 · 知识库' },
  // 已落地 ⇒ 不带 `batch`（P0-2-11 把 MCP 管理页换成真实页面）
  { code: 'MC', label: 'MCP', path: '/mcp', serial: 'S-06 · MCP' },
  // 已落地 ⇒ 不带 `batch`（P1-6 把任务中心占位页换成真页面：**定时任务**管理）
  { code: 'TK', label: '任务', path: '/tasks', serial: 'S-09 · 任务中心' },
  // 已落地 ⇒ 不带 `batch`（会话产物：跨会话汇总本人全部产物，登录即可、可预览/下载/删除）
  { code: 'AH', label: '会话产物', path: '/artifacts', serial: 'S-10 · 会话产物' },
  // 已落地 ⇒ 不带 `batch`（P0-2-11 把凭据页换成真实页面）。⚠️ **与 MCP 解耦**：路由归入
  // `/settings` 一族（个人设置族），排在个人项这一端，不跟在 `MC` 后面。
  // ⚠️ Git 凭据（P1-9 · R11）**不单列导航项**：它是本页内嵌的一个区块（`GitCredentialsSection`），
  // 「我的凭据」是个人凭据的唯一入口。
  { code: 'CR', label: '我的凭据', path: '/settings/credentials', serial: 'S-08b · 凭据' },
  /**
   * 用量统计（P1-7 落地；**P1-15 起登录即可**）。
   *
   * `03` §三 的原话是「管理入口仅 ADMIN 可见（用户/模型池/用量）」，但 **P1-15 的产品口径
   * 把用量放开**（`子方案/聊天主页与信息架构改造.md` §八）：这是**有意的放宽**，不是漏写
   * `adminOnly` —— 放开的是"平台级用量报表"这一份共享事实，与会话/凭据那类私有资源无关。
   * 故它从"管理三条"移到普通分组（放在 `CR` 之后、ADMIN 两条之前）。
   */
  { code: 'UT', label: '用量统计', path: '/admin/usage', serial: 'S-07c · 用量' },
  // 管理面**两条**（P0-1-36 落地；仅 ADMIN）。
  // ⚠️ 为什么必须拆而不是"留一条、另一条走头像菜单"：`serialForPath` 的读数来自 `matchNavItem`，
  // 而 `/admin/models` 若不在表里，左侧栏底部会显示兜底的「S-00 · 工作台」。
  { code: 'US', label: '用户管理', path: '/admin/users', serial: 'S-07 · 用户管理', adminOnly: true },
  { code: 'ML', label: '模型池', path: '/admin/models', serial: 'S-07b · 模型池', adminOnly: true },
] as const

/**
 * 不在导航里的页面的屏号（登录 / 改密 / 智能体编辑 / 未找到…），供左侧栏继续显示"第几屏"。
 *
 * ⚠️ `/agents` 这一条是**必须的**：`matchNavItem` 判 `/agents/new` 时，导航项 `AG` 的 path 是 `/`
 * 而它只对**恰好等于** `/` 的路径成立（否则它以 `/` 为前缀，命中一切路径）⇒ 落到本表。
 * 不加这条，编辑页的左侧栏会显示兜底的「S-00 · 工作台」，而它明明是第 3 屏
 * —— 一个读数错了的仪表比没有仪表更容易误导（原型上这里写的是 `S-03 · 编辑`）。
 */
const SERIAL_BY_PREFIX: readonly (readonly [string, string])[] = [
  // P1-15 起对话不再是"从列表进的二级页"，而是聊天主页的两态（`/c/:id` 定位、`/new/:agentId` 新会话）。
  // 它们不占导航项（对话不是"管理目的地"），但左侧栏底部那行"第几屏"照样要读对。
  // 老深链 `/chat/...` 只是重定向入口，也会经过这里，一并登记。
  ['/c/', 'S-04 · 对话'],
  ['/new/', 'S-04 · 对话'],
  ['/chat', 'S-04 · 对话'],
  ['/settings/password', 'S-08 · 改密'],
  ['/login', 'S-01 · 登录'],
] as const

/** 按角色过滤。`role` 为 `undefined`（还没读到当前用户）时按"只有公开项"处理 */
export function visibleNavItems(role: UserRole | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => item.adminOnly !== true || role === 'ADMIN')
}

/** 命中当前路径的导航项（取**最长前缀**，保证带子路径的地址命中**最具体**的那一项；
 *  当前各项互不为前缀，但这条规则对将来的子页面仍然必要） */
export function matchNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.filter((item) =>
    item.path === '/' ? pathname === '/' : pathname.startsWith(item.path),
  ).sort((a, b) => b.path.length - a.path.length)[0]
}

/** 左侧栏底部那行"第几屏"：先找导航项，再找补充表，最后给一个中性的兜底 */
export function serialForPath(pathname: string): string {
  const item = matchNavItem(pathname)
  if (item !== undefined) return item.serial
  return SERIAL_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'S-00 · 工作台'
}

/**
 * 顶栏面包屑的一段。`to` 有值且**不是最后一段** ⇒ 渲染成链接；最后一段恒为「当前页」。
 */
export interface CrumbSegment {
  label: string
  to?: string
}

/**
 * 少数路由的模块名与导航项标签不同（面包屑沿用页面原本的写法，不为了统一而改文案）。
 * 目前只有 MCP：导航里叫「MCP」，面包屑里一直是「MCP server」。
 */
const CRUMB_MODULE_LABEL: Record<string, string> = {
  '/mcp': 'MCP server',
}

/**
 * 顶栏面包屑（快捷页面导航）的**静态前缀**：`工作台 / <模块>`。
 *
 * 二级页（知识库详情 / 智能体编辑 / 占位页）的**细节段**不在这里 —— 那些名字来自查询数据，
 * 路径里没有，由页面用 `usePageCrumb(label)` 交给顶栏。
 *
 * 返回的数组恒以「工作台」开头；末段是否渲染成链接由调用方按"有没有细节段"决定：
 * 有细节段 ⇒ 前缀各段都是链接；没有 ⇒ 末段就是当前页。
 */
export function crumbBaseForPath(pathname: string): CrumbSegment[] {
  const trail: CrumbSegment[] = [{ label: '工作台', to: HOME_PATH }]
  const item = matchNavItem(pathname)
  if (item !== undefined && item.path !== HOME_PATH) {
    trail.push({ label: CRUMB_MODULE_LABEL[item.path] ?? item.label, to: item.path })
    return trail
  }
  if (item !== undefined) {
    // 首页（`/`）：模块名本身就是当前页
    trail.push({ label: item.label })
    return trail
  }
  // 不在导航里的页面
  if (pathname.startsWith('/settings/password')) {
    trail.push({ label: '修改密码' })
    return trail
  }
  // 占位页 / 未找到：只给「工作台」，细节段（页面标题）由 `NoticePage` 交给顶栏
  return trail
}
