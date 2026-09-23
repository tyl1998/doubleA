/**
 * 登录守卫（P0-1-30）
 *
 * 验收（`docs/06` P0-1-30）：**未登录访问受保护路由被重定向**。
 * 四层判断，顺序不能换：
 *
 * 1. `isError` ⇒ 显示 {@link SessionErrorScreen}（**带重试**）。不能继续转圈，也不能
 *    当作"未登录"——后者会让后端挂掉表现成"你密码不对"。
 * 2. `isPending` / `user === undefined` ⇒ 等（{@link BootScreen}）。**不能把"还没问到"
 *    当成"没登录"** —— 那会让刷新已登录页面时必然先跳一次登录页。
 * 3. `user === null` ⇒ 回登录页，并记住来路（`location.state.from`），登录后原样回去。
 * 4. `user.mustChangePassword` ⇒ **强制改密**。前端这一跳是体验，约束在后端
 *    （`backend/src/plugins/session.ts` 的 `installPasswordChangeGate`：除
 *    login/logout/me/password 外所有 `/api/**` 一律 403）—— 所以即使用户手敲 URL
 *    绕过这里，也拿不到任何业务数据。
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { useCurrentUser } from '../api/auth.js'
import { BootScreen } from './BootScreen.js'
import { SessionErrorScreen } from './SessionErrorScreen.js'
import { loginPath } from './paths.js'

export function RequireAuth() {
  const { data: user, isPending, isError, error, isFetching, refetch } = useCurrentUser()
  const location = useLocation()

  // `isError` 必须排在 `undefined` 之前：出错时 `data` **也是** `undefined`，
  // 顺序写反就会退化成"永远在读登录态"。
  if (isError) {
    return (
      <SessionErrorScreen
        error={error}
        retrying={isFetching}
        onRetry={() => {
          void refetch()
        }}
      />
    )
  }

  // `data` 的类型是 `AuthUser | null | undefined`，而 TanStack Query 的 `isPending`
  // **不会**替 TS 收窄 `data` ⇒ 这里必须把 `undefined` 显式并入"还在问"那一支。
  // 三态语义：`undefined` = 还没问到，`null` = 明确未登录，对象 = 已登录。
  if (isPending || user === undefined) return <BootScreen />
  if (user === null) {
    return <Navigate to={loginPath()} replace state={{ from: `${location.pathname}${location.search}` }} />
  }
  if (user.mustChangePassword) return <Navigate to={loginPath('password')} replace />

  return <Outlet />
}
