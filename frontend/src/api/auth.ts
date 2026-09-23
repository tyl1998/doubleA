/**
 * 认证接口封装（P0-1-30）
 *
 * 依据：`docs/02-后端设计.md` §4.1 四个端点 + 首登强制改密注记；`docs/03-前端设计.md` §二/§六。
 * 契约细节一律回到 `backend/src/routes/auth.ts` 与 `shared/src/auth.ts` 核对，**不按常识推断**：
 *
 * | 端点 | 需登录 | 首登未改密时 | 返回的 `data` |
 * |------|--------|--------------|----------------|
 * | POST /api/auth/login | 否 | 放行（否则永远拿不到会话） | `AuthUser`（**裸对象**，不是 `{user}`） |
 * | GET  /api/auth/me | 是 | 放行（前端靠它读 `mustChangePassword`） | `AuthUser` |
 * | POST /api/auth/password | 是 | 放行（强制改密本身的出口） | `AuthUser` |
 * | POST /api/auth/logout | 否（幂等） | 放行 | `null` |
 *
 * ⚠️ 本仓的信封**不是永远多包一层**：login / me / password 都是**裸 `AuthUser`**，
 * 而 `POST /api/users` 是 `{user, initialPassword}`、`GET /api/models/available` 是 `{items}`。
 * 照抄邻居的取值路径会**安静地拿到 `null`**（`docs/06` §六 那条"按错的信封层级取值"）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuthUser, ChangePasswordBody, LoginBody } from '@doubulea/shared'

import { ApiError, request } from './client.js'

/** 「当前用户」这一个键在全站只有一处写法（登录/改密/登出都失效它） */
export const CURRENT_USER_QUERY_KEY = ['auth', 'current-user'] as const

/**
 * 读当前用户。**未登录不是错误**（`null`）：
 * 路由守卫需要区分"还在问"「没登录」「登录了」三态，若把 401 当异常，
 * 每个页面都要写一遍 `error.code === 'UNAUTHORIZED'` 的判据。
 */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<AuthUser | null> {
  try {
    return await request<AuthUser>('/api/auth/me', signal === undefined ? {} : { signal })
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) return null
    throw error
  }
}

export function useCurrentUser() {
  return useQuery({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    // 401 已经由 fetchCurrentUser 收敛成 null，这里不必重试
    retry: false,
    /**
     * 比默认 30s 更长：这份数据的失效时机是**明确事件**（登录 / 改密 / 登出 / 其它接口 401），
     * 每处都会显式写缓存；靠"过期自动重拉"来发现"我被登出了"只会让页面无谓闪烁。
     */
    staleTime: 5 * 60_000,
  })
}

/**
 * 登录。
 *
 * 成功后**直接把返回值写进缓存**，不 invalidate、不重拉：
 * `POST /auth/login` 的 `data` 与 `GET /auth/me` 同构（`shared/auth.ts` 的注释），
 * 再打一次 `/me` 是纯粹的浪费 —— 而登录是"刚发生的事件"，重拉还可能撞上缓存窗口。
 */
export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: LoginBody) => request<AuthUser>('/api/auth/login', { method: 'POST', body }),
    onSuccess: (user) => {
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user)
    },
  })
}

/** 改密（含首登强制改密）。返回的也是 `AuthUser`，其中 `mustChangePassword` 已变 false */
export function useChangePassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ChangePasswordBody) =>
      request<AuthUser>('/api/auth/password', { method: 'POST', body }),
    onSuccess: (user) => {
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user)
    },
  })
}

/**
 * 登出。幂等（`02` §4.1），失败也不该拦住用户 —— 页面侧无论成败都清缓存并回登录页。
 *
 * `queryClient.clear()` 是必须的：下一个人登进来若看到上一个人的列表缓存，
 * 那是**A 的数据以 B 的身份展示**，比"白屏一下"严重得多。
 */
export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => request<null>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.clear()
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, null)
    },
  })
}
