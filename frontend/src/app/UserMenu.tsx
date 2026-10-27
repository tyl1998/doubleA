/**
 * 头像菜单 + 用户名首字母（P0-1-30 起住在旧外壳 `AppLayout` 的顶栏；P1-15 提为公共组件）
 *
 * 依据：`docs/03-前端设计.md` §三（"头像菜单"）、§九（P1-23 界面语言：菜单里另给一个切换项）。
 *
 * ⚠️ 与 {@link ServiceLed} 同款理由（见那个文件头）：P1-15 修订后外壳收敛为一个（`AppShell`），
 * 左列会话栏 `ConvRail` 常驻，**退出登录 / 改密 / ADMIN 入口**这些动线就收在它的底部，
 * 用的是**同一份**（含"无论成败都回登录页"那条推理），不会出现两处各写一遍登出逻辑。
 *
 * ## P1-23：菜单项文案走 i18n
 *
 * 菜单项的 `label` 是运行时拼出来的（AntD `MenuProps`），**不能**存 key —— 所以原来"文案只
 * 写一处"的位置就从"菜单定义"挪到了"key 目录"。`key` 字段（`password` / `logout` …）是
 * **业务判据**、**不翻译**（它下面的 `onClick` 直接按它分支）；只有 `label` 走 `t()`。
 *
 * ## 2026-10-26：配色 / 语言两个界面偏好收进本菜单
 *
 * 用户口径（侧栏优化）：底层**只展示当前用户**，把「英文切换」与「配色（样式）切换」都搬进
 * 头像菜单 —— 即在这个下拉框内**新增两项**。故 `ConvRail` 底部那两枚按钮已删，本菜单是唯一入口。
 */

import { Dropdown, type MenuProps } from 'antd'
import type { AuthUser } from '@doubulea/shared'

import { useLogout } from '../api/auth.js'
import { useFeedback } from './feedback.js'
import { useNavigate } from 'react-router-dom'
import { useT } from './i18n.js'
import { localeToggleLabel } from './locale.js'
import { useLocaleStore } from '../stores/locale.js'
import { useUiStore } from '../stores/ui.js'
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
  const { t } = useT()
  const locale = useLocaleStore((state) => state.locale)
  const toggleLocale = useLocaleStore((state) => state.toggleLocale)
  const themeMode = useUiStore((state) => state.themeMode)
  const toggleThemeMode = useUiStore((state) => state.toggleThemeMode)

  const menuItems: MenuProps['items'] = [
    { key: 'password', label: t('user.changePassword') },
    // 两个界面偏好（2026-10-26 从会话栏底部搬进来）：**纯客户端偏好**，点一下即切、不跳转、不刷新。
    // 语言按钮上写的是"另一种语言"（当前中文显示 EN），与 `ConvRail` 旧的底部按钮同一份 store。
    {
      key: 'language',
      label: t('user.language'),
      extra: localeToggleLabel(locale),
    },
    {
      key: 'theme',
      label: t('user.theme'),
      extra: themeMode === 'dark' ? t('rail.themeDark') : t('rail.themeLight'),
    },
    ...(user.role === 'ADMIN'
      ? [
          { key: 'admin-users', label: t('user.adminUsers') },
          { key: 'admin-models', label: t('user.adminModels') },
        ]
      : []),
    { type: 'divider' as const },
    { key: 'logout', label: t('user.logout'), danger: true },
  ]

  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'password') navigate(PASSWORD_PATH)
    if (key === 'language') toggleLocale()
    if (key === 'theme') toggleThemeMode()
    if (key === 'admin-users') navigate(ADMIN_USERS_PATH)
    if (key === 'admin-models') navigate(ADMIN_MODELS_PATH)
    if (key === 'logout') {
      logout.mutate(undefined, {
        onSuccess: () => {
          feedback.ok(t('user.loggedOut'))
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
          {/* 角色码（ADMIN / MEMBER）是**契约值**，不翻译 —— 它是对照后端与原型的稳定标识 */}
          <span className="avatar__role">{user.role}</span>
        </span>
      </button>
    </Dropdown>
  )
}