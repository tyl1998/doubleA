/**
 * 全局导航定义（P0-1-30）
 *
 * 依据：`docs/03-前端设计.md` §二（14 条路由与权限列）、§三（全局布局：Logo + 导航项 +
 *      头像菜单 + **「管理」入口仅 ADMIN 可见**）、§七（文案词表：统一「智能体」）。
 *
 * 两处导航共用一个列表（原型里的「仪表轨」与顶栏文字导航是同一批目的地）：
 * 分开写两份必然出现"轨上有、顶栏没有"这类不一致。**权限判据只有一处**：`adminOnly`。
 *
 * ⚠️ 原型的仪表轨上写的是 `00 / LG / AG / ED / CH / KB / MC` —— 那是**设计原型自己的屏号**
 * （00=定调页、LG=登录页、ED=编辑页…），不是产品路由。落地时必须按 `03` §二 重新推导，
 * 只保留"真实目的地"。以下保留的字母缩写是推导结果，不是照抄。
 */

import type { UserRole } from '@doubulea/shared'

export interface NavItem {
  /** 仪表轨上的等宽字形：2 个字母，每个都指向一个真实目的地（原型记忆点 ①） */
  code: string
  label: string
  path: string
  /** 仪器读数式的屏号，显示在仪表轨底部（`design/*.html` 的 `.rail__serial`） */
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
 *   或工具失败卡直达"，放进全局导航才不会成为孤岛（§三 的动线要求）；
 * - 「任务」是 P1（`03` §4.7），本阶段不进导航 —— 摆一个点进去是空壳的入口比没有更差。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // 已落地 ⇒ 不带 `batch`（P0-1-31 起把首页换成真实的智能体列表；编辑页不带导航项，
  // 它由列表与摘要卡进入，屏号在 `SERIAL_BY_PREFIX` 里）
  { code: 'AG', label: '智能体', path: '/', serial: 'S-02 · 智能体' },
  { code: 'KB', label: '知识库', path: '/knowledge', serial: 'S-05 · 知识库', batch: 'P0-1-35' },
  { code: 'MC', label: 'MCP', path: '/mcp', serial: 'S-06 · MCP', batch: 'P0-2（MCP 端点尚未存在）' },
  {
    code: 'CR',
    label: '我的凭据',
    path: '/mcp/credentials',
    serial: 'S-06b · 凭据',
    batch: 'P0-2（凭据端点尚未存在）',
  },
  {
    code: 'AD',
    label: '管理',
    path: '/admin/users',
    serial: 'S-07 · 管理',
    adminOnly: true,
    batch: 'P0-1-36',
  },
] as const

/**
 * 不在导航里的页面的屏号（登录 / 改密 / 智能体编辑 / 未找到…），供仪表轨继续显示"第几屏"。
 *
 * ⚠️ `/agents` 这一条是**必须的**：`matchNavItem` 判 `/agents/new` 时，导航项 `AG` 的 path 是 `/`
 * 而它只对**恰好等于** `/` 的路径成立（否则它以 `/` 为前缀，命中一切路径）⇒ 落到本表。
 * 不加这条，编辑页的仪表轨会显示兜底的「S-00 · 工作台」，而它明明是第 3 屏
 * —— 一个读数错了的仪表比没有仪表更容易误导（原型上这里写的是 `S-03 · 编辑`）。
 */
const SERIAL_BY_PREFIX: readonly (readonly [string, string])[] = [
  ['/agents', 'S-03 · 智能体编辑'],
  // `/chat` 不进导航项（`03` §二：它是从智能体列表/列表页进入的页面，不是导航目的地），
  // 但仪表轨底部那行"第几屏"照样要读对 —— P0-1-32 起这是真页面了
  ['/chat', 'S-04 · 对话'],
  ['/settings/password', 'S-08 · 改密'],
  ['/login', 'S-01 · 登录'],
] as const

/** 按角色过滤。`role` 为 `undefined`（还没读到当前用户）时按"只有公开项"处理 */
export function visibleNavItems(role: UserRole | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => item.adminOnly !== true || role === 'ADMIN')
}

/** 命中当前路径的导航项（取**最长前缀**，保证 `/mcp/credentials` 不会命中 `/mcp`） */
export function matchNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.filter((item) =>
    item.path === '/' ? pathname === '/' : pathname.startsWith(item.path),
  ).sort((a, b) => b.path.length - a.path.length)[0]
}

/** 仪表轨底部那行"第几屏"：先找导航项，再找补充表，最后给一个中性的兜底 */
export function serialForPath(pathname: string): string {
  const item = matchNavItem(pathname)
  if (item !== undefined) return item.serial
  return SERIAL_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'S-00 · 工作台'
}
