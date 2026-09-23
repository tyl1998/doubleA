/**
 * 应用外壳（P0-1-30）
 *
 * 依据：`docs/03-前端设计.md` §三（全局布局：Logo + 导航 + 头像菜单 + ADMIN 才可见的管理入口）、
 *      `design/agents.html` 的 `.shell` 构成（左仪表轨 + 顶栏 + `.page` 内容区）。
 *
 * 三件事只在这里做，别的页面不要重复：
 * 1. **`<main>` 地标与页面级留白**（`.page`）—— 页面组件只渲染自己的内容；
 * 2. **导航的权限过滤与当前项高亮** —— 判据来自 `nav.ts` 的 `adminOnly` 单一来源；
 * 3. **全局服务状态灯** —— 真实数据来自 `GET /health`（`api/health.ts`），不是装饰。
 *
 * 顶部两块导航（仪表轨的字母、顶栏的文字）是**同一批目的地**：点击行为一致，只是密度不同。
 * 这不是重复劳动 —— 仪表轨是随手可达的锚点，顶栏是第一次用的人能读懂的文字。
 */

import { Button, Dropdown, type MenuProps } from 'antd'
import type { AuthUser } from '@doubulea/shared'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useCurrentUser, useLogout } from '../api/auth.js'
import { HEALTH_TARGET_LABEL, useHealth } from '../api/health.js'
import { useUiStore } from '../stores/ui.js'
import { useFeedback } from './feedback.js'
import { matchNavItem, serialForPath, visibleNavItems, type NavItem } from './nav.js'
import { ADMIN_MODELS_PATH, ADMIN_USERS_PATH, HOME_PATH, PASSWORD_PATH, loginPath } from './paths.js'

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

function RailNavItem({ item }: { item: NavItem }) {
  return (
    <li>
      <NavLink
        className="rail__btn"
        to={item.path}
        end={item.path === HOME_PATH}
        title={item.label}
        aria-label={item.label}
      >
        {item.code}
      </NavLink>
    </li>
  )
}

function TopNavItem({ item }: { item: NavItem }) {
  return (
    <li>
      <NavLink className="nav__item" to={item.path} end={item.path === HOME_PATH}>
        {item.label}
      </NavLink>
    </li>
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
  // 退出登录后 queryClient 被 clear，本组件可能在卸载前再渲染一次 ⇒ 兜一下 undefined
  if (user === undefined || user === null) return null

  const items = visibleNavItems(user.role)
  const led = serviceLed(health)
  const current = matchNavItem(location.pathname)

  return (
    <div className="shell">
      <aside className="rail" aria-label="全局导航">
        <Link className="rail__mark" to={HOME_PATH} aria-label="doubuleA 工作台">
          A
        </Link>
        <div className="rail__rule" aria-hidden="true" />
        <ul className="rail__nav">
          {items.map((item) => (
            <RailNavItem key={item.path} item={item} />
          ))}
        </ul>
        <div className="rail__status">
          <span className={led.className} title={led.title} role="img" aria-label={led.title} />
          <span className="rail__serial num">{serialForPath(location.pathname)}</span>
        </div>
      </aside>

      <div>
        <header className="topbar">
          <Link className="topbar__brand" to={HOME_PATH}>
            doubuleA <span>工作台</span>
          </Link>
          <nav aria-label="主导航">
            <ul className="nav">
              {items.map((item) => (
                <TopNavItem key={item.path} item={item} />
              ))}
            </ul>
          </nav>
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

        {/* 页面组件不再自带 `.page` 包裹 —— 留白与地标只在这里定义一次 */}
        <main className="page" aria-label={current?.label ?? '工作台'}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
