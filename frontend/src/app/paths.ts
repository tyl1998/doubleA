/**
 * 路由路径常量（P0-1-30）
 *
 * 为什么要有这个文件：登录页、守卫、头像菜单、以及将来所有"跳去改密/跳到登录"的地方
 * 都要引用这几个地址。字符串散在各处时，`/login?view=password` 这种**带查询参数的重定向**
 * 一旦写歪（少一个 `?` 或参数名不一致），症状是"跳过去了但停在登录态"—— 很难联想。
 */

import type { Location } from 'react-router-dom'

export const LOGIN_PATH = '/login'
export const PASSWORD_PATH = '/settings/password'
export const HOME_PATH = '/'
export const ADMIN_USERS_PATH = '/admin/users'
export const ADMIN_MODELS_PATH = '/admin/models'

/** 登录页的两种视图（`docs/03` §二：`/login` 是"登录（含首登改密）"，两态同屏） */
export type LoginView = 'login' | 'password'

/** 登录页地址。`view=password` = 首登强制改密那一态 */
export function loginPath(view: LoginView = 'login'): string {
  return view === 'login' ? LOGIN_PATH : `${LOGIN_PATH}?view=password`
}

/**
 * 从 `location` 还原"登录后该回哪去"。
 *
 * 只接受**站内路径**（以单个 `/` 开头）：`from` 是放进 `location.state` 的，
 * 而 state 会被 301/分享链接等途径带过来，若直接 `navigate(from)` 就等于开放了一个
 * 任意跳转点（`//evil.com` 会被浏览器当作协议相对 URL 跳到站外）。
 */
export function safeRedirectTarget(location: Location | undefined, fallback = HOME_PATH): string {
  const from = (location?.state as { from?: unknown } | null)?.from
  if (typeof from !== 'string') return fallback
  if (!from.startsWith('/') || from.startsWith('//')) return fallback
  return from
}
