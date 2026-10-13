/**
 * 头像菜单 + 用户名首字母（P0-1-30 起住在旧外壳 `AppLayout` 的顶栏；P1-15 提为公共组件）
 *
 * 依据：`docs/03-前端设计.md` §三（"头像菜单"）。
 *
 * ⚠️ 与 {@link ServiceLed} 同款理由（见那个文件头）：P1-15 修订后外壳收敛为一个（`AppShell`），
 * 左列会话栏 `ConvRail` 常驻，**退出登录 / 改密 / ADMIN 入口**这些动线就收在它的底部，
 * 用的是**同一份**（含"无论成败都回登录页"那条推理），不会出现两处各写一遍登出逻辑。
 */

import { Dropdown, type MenuProps } from 'antd'
import type { AuthUser } from '@doubulea/shared'

import { useLogout } from '../api/auth.js'
import { useFeedback } from './feedback.js'
import { useNavigate } from 'react-router-dom'
import { ADMIN_MODELS_PATH, ADMIN_USERS_PATH, PASSWORD_PATH, loginPath } from './paths.js'

/** 头像上的字：中文名取首字，拉丁名取前两位（`design/*.html` 的 `avatar__face`） */
export function initialsOf(user: AuthUser): string {
  const name = user.nickname ?? user.username
  if (name === '') return '?'
  const chars = [...name]
  const isLatin = /^[\x20-\x7e]+$/.test(name)
  return isLatin ? chars.slice(0, 2).join('').toUpperCase() : (chars[0] ?? '?')
}

export function UserMenu({ user }: { user: AuthUser }) {
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
