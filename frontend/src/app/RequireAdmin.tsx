/**
 * ADMIN 守卫（P0-1-30）
 *
 * **必须嵌在 {@link RequireAuth} 里面**（外层已经等过 `/auth/me`）：
 * 单独用它会拿到 `undefined`，而 `undefined` 与"不是 ADMIN"是两件事 —— 前者是
 * "还没问到"，后者才是"确实没权限"。这里仍然区分处理，因为守卫写错方向
 * （把未登录当无权限）会让用户在刷新时看到一次"没有权限"的闪烁。
 *
 * 判据只有 `role === 'ADMIN'` 一个（`02` §4.2：仅 ADMIN / MEMBER 两种角色，无自注册）。
 */

import { Outlet } from 'react-router-dom'

import { useCurrentUser } from '../api/auth.js'
import { ForbiddenPage } from '../pages/NoticePage.js'
import { BootScreen } from './BootScreen.js'

export function RequireAdmin() {
  const { data: user } = useCurrentUser()

  if (user === undefined) return <BootScreen />
  if (user === null) return <BootScreen />
  if (user.role !== 'ADMIN') return <ForbiddenPage />

  return <Outlet />
}
