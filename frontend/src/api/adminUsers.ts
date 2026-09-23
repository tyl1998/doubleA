/**
 * 用户管理接口封装（`/admin/users`，P0-1-36；端点本身是 P0-1-8 就绪的）
 *
 * 依据：`docs/02-后端设计.md` §4.2（四个端点 + 权限 + 状态码）、`shared/src/user.ts`
 *      （`UserListItem` / `InitialPasswordResult` 唯一一套投影）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 信封层级逐个核对过（本仓四族形态刻意不同，别照抄邻居）
 * ─────────────────────────────────────────────────────────────────────
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/users`                  | `{ items, total, offset, limit }` |
 * | `POST /api/users`                 | `{ user, initialPassword }`（**唯一一次明文**） |
 * | `PATCH /api/users/:id`            | **裸 `UserListItem`** |
 * | `POST /api/users/:id/reset-password` | `{ user, initialPassword }`（同上） |
 *
 * ⚠️ 后两个的差别是**动词与路径都不同**（重置是 `POST .../reset-password`，不是 PATCH）。
 * 写成 `PATCH { status }` 去"重置"会得到一个 200 + 什么都没发生，而界面上会显示"已重置"
 * —— 那是本档最坏的一种错（看着成功）。验收档有一条断言盯着这两个 URL。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 权限：`(A)` 仅 ADMIN，且**不在首登闸门白名单**里
 * ─────────────────────────────────────────────────────────────────────
 * 四个端点都挂 `app.requireAdmin`，而根级首登闸门会先把 `must_change_password=true` 的管理员
 * 拦成 403 —— 也就是说"刚被建出来的管理员"进不来这一页，这是对的（`02` §4.2：强制改密期间
 * 只能改密/看自己/登出）。路由侧另有 `RequireAdmin`，两处判据同源（角色）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 失效范围：写操作要动的是**同一个列表键**
 * ─────────────────────────────────────────────────────────────────────
 * 建号 / 改角色 / 启停 / 重置密码都会改变列表里某一行的读数（`status`、`role`、
 * `mustChangePassword`），所以全部失效 `['admin','users']` —— 一个键，一次失效。
 * 刻意**不做乐观更新**：这几个动作都可能被后端拒（`409` 不能操作自己、`409` 用户名已存在），
 * 先改本地再回滚会让"那一下到底成没成"闪烁两次。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateUserBody, InitialPasswordResult, UpdateUserBody, UserListItem, UserListResult } from '@doubulea/shared'

import { request } from './client.js'

/** 管理面的键根（模型池那边也挂在这个根下：一次 Provider 写操作要连带失效模型列表） */
export const ADMIN_USERS_QUERY_KEY = ['admin', 'users'] as const

/** 与 `listUsersQuerySchema` 的 `limit` 上限同源（100）；列表页一次取满，翻页交给 AntD Table */
export const ADMIN_USERS_PAGE_LIMIT_MAX = 100

export function fetchAdminUsers(offset = 0, limit = ADMIN_USERS_PAGE_LIMIT_MAX): Promise<UserListResult> {
  return request<UserListResult>(`/api/users?offset=${offset}&limit=${limit}`)
}

/**
 * 列表查询参数。⚠️ 与 `api/agents.ts#ListAgentsParams`、`api/modelPool.ts#ListModelPoolParams`
 * 同款**对象参数**：`offset` 与 `limit` 都是 `number`，位置参数下"只传想传的那个"必然错位
 *（模型池就因此真出过一次事故，见 `modelPool.ts` 里那段说明）。
 */
export interface ListAdminUsersParams {
  offset?: number
  limit?: number
}

/**
 * 用户列表。
 *
 * 排序由后端定（`username asc, id asc`，`02` §4.2）—— 前端**不再排一次**：分页要的是稳定
 * 顺序，前端再排一次会让"翻到第二页时同一个人又出现一次"（与侧栏会话列表同一条教训）。
 *
 * `placeholderData: keepPreviousData` 的理由同知识库文档表：写操作后失效重取时不要让
 * 表格闪成骨架屏（用户刚点完"停用"，正盯着那一行看结果）。
 */
export function useAdminUsers(params: ListAdminUsersParams = {}) {
  const offset = params.offset ?? 0
  const limit = params.limit ?? ADMIN_USERS_PAGE_LIMIT_MAX
  return useQuery({
    queryKey: [...ADMIN_USERS_QUERY_KEY, offset, limit] as const,
    queryFn: () => fetchAdminUsers(offset, limit),
    placeholderData: keepPreviousData,
  })
}

/**
 * 建号。响应里的 `initialPassword` 是**唯一一次明文**，页面必须当场展示
 * （`01` §3.1：admin 建号发初始密码）—— 所以调用方拿到结果后要立刻把它送进一次性弹窗，
 * **不要**先 `feedback.ok` 再"稍后显示"。
 */
export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateUserBody) => request<InitialPasswordResult>('/api/users', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY })
    },
  })
}

/**
 * 启停 / 改角色。请求体由 `pages/admin/adminModel.ts#buildUpdateUserBody` 构造
 * （"没改动就不带字段"由那边收口），本函数不做任何裁剪。
 */
export function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserBody }) =>
      request<UserListItem>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY })
    },
  })
}

/**
 * 重置密码（`POST .../reset-password`）。
 *
 * 连带的两个后端动作值得在界面上说清（`02` §4.2）：① 失效对方快照缓存 ⇒ 他**在线的会话**
 * 会被首登闸门赶到改密页；② **清掉登录失败计数** —— 现实里"重置密码"往往正是因为对方
 * 连错 5 次被锁，不清计数的话重置完还要再等最多 10 分钟，看着就是"重置没生效"。
 */
export function useResetUserPassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<InitialPasswordResult>(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY })
    },
  })
}
