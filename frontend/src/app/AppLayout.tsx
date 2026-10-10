/**
 * 应用外壳（P0-1-30；本次改版：左侧栏 + 顶栏面包屑）
 *
 * 依据：`docs/03-前端设计.md` §三（全局布局：左侧栏 + 顶栏面包屑 + 头像菜单 +
 *      ADMIN 才可见的管理入口）。
 *
 * 两块导航：
 * - **左侧栏**（`.rail`）：承载**全部导航项**，每项 = 图标 + 文字，且可**收起**成图标条
 *   （默认展开）。文字标签来自 `nav.ts#NAV_ITEMS`。**所有页面都用它** —— 对话页也不例外
 *   （改版前对话页走"专注布局"隐藏侧栏、改用「工作台」下拉，现按用户要求取消：保持侧栏）。
 * - **顶栏**（`.topbar`）：不再是全局文字导航，改为**快捷页面导航**（面包屑
 *   `工作台 / 模块 / 细节`）。静态前缀由 `nav.ts#crumbBaseForPath` 推出，二级页的细节段
 *   由页面用 `usePageCrumb` 上报（见 `crumbContext.ts`）。对话页 = `工作台 / 智能体 / <智能体名>`。
 *
 * 三件事只在这里做，别的页面不要重复：
 * 1. **`<main>` 地标与页面级留白**（`.page`）—— 页面组件只渲染自己的内容；
 * 2. **导航的权限过滤与当前项高亮** —— 判据来自 `nav.ts` 的 `adminOnly` 单一来源；
 * 3. **全局服务状态灯** —— 真实数据来自 `GET /health`（`api/health.ts`），不是装饰。
 */

import {
  ApiOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  BookOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  KeyOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Button, Dropdown, type MenuProps } from 'antd'
import type { AuthUser } from '@doubulea/shared'
import { Fragment, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useCurrentUser, useLogout } from '../api/auth.js'
import { HEALTH_TARGET_LABEL, useHealth } from '../api/health.js'
import { useUiStore } from '../stores/ui.js'
import { useFeedback } from './feedback.js'
import { PageCrumbContext } from './crumbContext.js'
import {
  crumbBaseForPath,
  matchNavItem,
  serialForPath,
  visibleNavItems,
  type CrumbSegment,
  type NavItem,
} from './nav.js'
import { ADMIN_MODELS_PATH, ADMIN_USERS_PATH, HOME_PATH, PASSWORD_PATH, loginPath } from './paths.js'

/** 每个导航项一个图标（按 `NavItem.code` 认领，`nav.ts` 因此不必认识 antd） */
const ICON_BY_CODE: Record<string, ReactNode> = {
  AG: <RobotOutlined />,
  KB: <BookOutlined />,
  MC: <ApiOutlined />,
  AH: <HistoryOutlined />,
  TK: <ScheduleOutlined />,
  CR: <KeyOutlined />,
  US: <TeamOutlined />,
  ML: <DatabaseOutlined />,
  UT: <BarChartOutlined />,
}

/** 头像上的字：中文名取首字，拉丁名取前两位（`design/*.html` 的 `avatar__face`） */
function initialsOf(user: AuthUser): string {
  const name = user.nickname ?? user.username
  if (name === '') return '?'
  const chars = [...name]
  const isLatin = /^[\x20-\x7e]+$/.test(name)
  return isLatin ? chars.slice(0, 2).join('').toUpperCase() : (chars[0] ?? '?')
}

/** 服务灯：三态（正常 / 降级 / 取不到），文案在 title 里给全，避免只有一个颜色 */
function serviceLed(health: ReturnType<typeof useHealth>): { className: string; title: string } {
  if (health.isPending) return { className: 'led led--idle', title: '正在读取服务状态…' }
  const report = health.data
  if (report === undefined) return { className: 'led led--fail', title: '取不到服务状态（/health 未响应）' }
  if (report.status === 'ok') {
    return {
      className: 'led led--ok',
      title: `服务正常 · v${report.version} · ${report.env}`,
    }
  }
  const broken = report.checks
    .filter((check) => !check.ok)
    .map((check) => `${HEALTH_TARGET_LABEL[check.target]}：${check.detail}`)
    .join('；')
  return { className: 'led led--warn', title: `部分依赖不可用 —— ${broken}` }
}

function RailNavItem({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <li>
      <NavLink
        className="rail__btn"
        to={item.path}
        end={item.path === HOME_PATH}
        // 收起时文字被隐藏 ⇒ 用 `title` 补回可读性
        title={collapsed ? item.label : undefined}
        aria-label={item.label}
      >
        <span className="rail__icon" aria-hidden="true">
          {ICON_BY_CODE[item.code] ?? <AppstoreOutlined />}
        </span>
        <span className="rail__label">{item.label}</span>
      </NavLink>
    </li>
  )
}

/**
 * 顶栏的「快捷页面导航」（面包屑）。
 *
 * 静态前缀来自 `crumbBaseForPath(pathname)`（`工作台 / 模块`），`detail` 非空时追加为当前段
 * （二级页用 `usePageCrumb` 上报）。有 `detail` 时前缀各段渲染成链接，否则末段即当前页。
 */
function PageCrumb({ pathname, detail }: { pathname: string; detail: string | null }) {
  const base = crumbBaseForPath(pathname)
  const trail: CrumbSegment[] = detail === null ? base : [...base, { label: detail }]

  return (
    <nav className="crumb" aria-label="面包屑">
      {trail.map((segment, index) => {
        const last = index === trail.length - 1
        return (
          <Fragment key={`${segment.label}-${index}`}>
            {index > 0 ? (
              <span className="crumb__sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {!last && segment.to !== undefined ? (
              <Link to={segment.to}>{segment.label}</Link>
            ) : (
              <span className={last ? 'crumb__here' : undefined}>{segment.label}</span>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

function UserMenu({ user }: { user: AuthUser }) {
  const navigate = useNavigate()
  const feedback = useFeedback()
  const logout = useLogout()

  const menuItems: MenuProps['items'] = [
    { key: 'password', label: '修改密码' },
    ...(user.role === 'ADMIN'
      ? [
          { key: 'admin-users', label: '用户管理' },
          { key: 'admin-models', label: '模型池管理' },
        ]
      : []),
    { type: 'divider' as const },
    { key: 'logout', label: '退出登录', danger: true },
  ]

  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'password') navigate(PASSWORD_PATH)
    if (key === 'admin-users') navigate(ADMIN_USERS_PATH)
    if (key === 'admin-models') navigate(ADMIN_MODELS_PATH)
    if (key === 'logout') {
      logout.mutate(undefined, {
        onSuccess: () => {
          feedback.ok('已退出登录')
        },
        // 无论成败都回登录页：登出失败（网络不通）时把用户留在"看着还登录着"的界面上，
        // 比清掉本地状态更糟 —— 服务端会话迟早会过期，而他会以为刚才那下成功了。
        onSettled: () => {
          navigate(loginPath(), { replace: true })
        },
      })
    }
  }

  return (
    <Dropdown menu={{ items: menuItems, onClick }} trigger={['click']} placement="bottomRight">
      <button className="avatar" type="button" aria-haspopup="menu">
        <span className="avatar__face" aria-hidden="true">
          {initialsOf(user)}
        </span>
        <span className="avatar__meta">
          <span className="avatar__name">{user.nickname ?? user.username}</span>
          <span className="avatar__role">{user.role}</span>
        </span>
      </button>
    </Dropdown>
  )
}

export function AppLayout() {
  const location = useLocation()
  // 本组件只挂在 RequireAuth 里面 ⇒ 这里 `data` 必然是已登录用户
  const { data: user } = useCurrentUser()
  const themeMode = useUiStore((state) => state.themeMode)
  const toggleThemeMode = useUiStore((state) => state.toggleThemeMode)
  const health = useHealth()
  /** 左侧栏是否收起（默认展开；本组件跨路由常驻，故状态天然保持） */
  const [railCollapsed, setRailCollapsed] = useState(false)
  /** 二级页上报给顶栏面包屑的**细节段**（见 `crumbContext.ts`） */
  const [crumbDetail, setCrumbDetail] = useState<string | null>(null)
  // 退出登录后 queryClient 被 clear，本组件可能在卸载前再渲染一次 ⇒ 兜一下 undefined
  if (user === undefined || user === null) return null

  const items = visibleNavItems(user.role)
  const led = serviceLed(health)
  const current = matchNavItem(location.pathname)
  // 左侧栏默认展开；本组件跨路由常驻，收起状态天然保持
  const shellClass = `shell${railCollapsed ? '' : ' shell--rail-open'}`

  const topbar = (
    <header className="topbar">
      <Link className="topbar__brand" to={HOME_PATH}>
        doubuleA <span>工作台</span>
      </Link>
      <PageCrumb pathname={location.pathname} detail={crumbDetail} />
      <div className="topbar__right">
        <Button
          size="small"
          type="text"
          onClick={toggleThemeMode}
          title="切换配色（浅色为交付主态）"
          aria-pressed={themeMode === 'dark'}
        >
          {themeMode === 'dark' ? '暗色' : '浅色'}
        </Button>
        <UserMenu user={user} />
      </div>
    </header>
  )

  // 页面组件不再自带 `.page` 包裹 —— 留白与地标只在这里定义一次
  const page = (
    <main className="page" aria-label={current?.label ?? '工作台'}>
      <Outlet />
    </main>
  )

  return (
    <PageCrumbContext.Provider value={setCrumbDetail}>
      <div className={shellClass}>
        <aside className={`rail${railCollapsed ? ' rail--collapsed' : ''}`} aria-label="全局导航">
          <div className="rail__head">
            <Link className="rail__mark" to={HOME_PATH} aria-label="doubuleA 工作台">
              A
            </Link>
            <button
              className="rail__toggle"
              type="button"
              onClick={() => {
                setRailCollapsed((value) => !value)
              }}
              aria-label={railCollapsed ? '展开导航' : '收起导航'}
              aria-expanded={!railCollapsed}
              title={railCollapsed ? '展开导航' : '收起导航'}
            >
              {railCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </button>
          </div>
          <div className="rail__rule" aria-hidden="true" />
          <ul className="rail__nav">
            {items.map((item) => (
              <RailNavItem key={item.path} item={item} collapsed={railCollapsed} />
            ))}
          </ul>
          <div className="rail__status">
            <span className={led.className} title={led.title} role="img" aria-label={led.title} />
            <span className="rail__serial num">{serialForPath(location.pathname)}</span>
          </div>
        </aside>

        <div>
          {topbar}
          {page}
        </div>
      </div>
    </PageCrumbContext.Provider>
  )
}
