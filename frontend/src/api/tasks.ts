/**
 * 任务中心（定时任务）接口封装（P1-6，2026-10-09 需求变更）
 *
 * 依据：`docs/02` §4.8、`shared/src/task.ts`（契约）。
 *
 * | 端点 | 成功响应的 `data` |
 * |------|------------------|
 * | `GET /api/tasks` | `{ items, total, offset, limit }` |
 * | `POST /api/tasks` | **裸 `ScheduledTaskItem`** |
 * | `PATCH /api/tasks/:id` | **裸 `ScheduledTaskItem`** |
 * | `DELETE /api/tasks/:id` | **裸 `{ id }`** |
 * | `POST /api/tasks/:id/run` | **裸 `{ id, conversationId }`**（立即执行，**不等整轮**） |
 *
 * 权限与会话同族（**仅本人**）。全部写操作成功后失效 `['tasks']` 整棵子树。
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateScheduledTaskBody,
  RunScheduledTaskResult,
  ScheduledTaskItem,
  ScheduledTaskListResult,
  UpdateScheduledTaskBody,
} from '@doubulea/shared'

import { request } from './client.js'
import { scheduledTasksRefetchInterval } from '../pages/tasks/taskModel.js'

export const TASKS_QUERY_KEY = ['tasks'] as const

/** 列表一次取多少条（与其余列表同口径） */
export const TASKS_PAGE_LIMIT = 20

export function tasksListQueryKey(offset: number, limit: number): readonly [string, number, number] {
  return ['tasks', offset, limit] as const
}

export function fetchScheduledTasks(offset: number, limit: number): Promise<ScheduledTaskListResult> {
  const search = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return request<ScheduledTaskListResult>(`/api/tasks?${search.toString()}`)
}

export function useScheduledTasks(offset: number, limit: number) {
  return useQuery({
    queryKey: tasksListQueryKey(offset, limit),
    queryFn: () => fetchScheduledTasks(offset, limit),
    placeholderData: keepPreviousData,
    // 有任务在跑时每 3s 重拉（跑完那行自动从"运行中"翻成成功/失败，见 `taskModel.ts`）
    refetchInterval: (query) => scheduledTasksRefetchInterval(query.state.data?.items),
  })
}

/** 建（成功返回裸 `ScheduledTaskItem`） */
export function useCreateScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateScheduledTaskBody) =>
      request<ScheduledTaskItem>('/api/tasks', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY })
    },
  })
}

/** 改（名字/指令/cron/启停；逐字段可选） */
export function useUpdateScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateScheduledTaskBody }) =>
      request<ScheduledTaskItem>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY })
    },
  })
}

/** 删（硬删；正在跑的那一轮不受影响） */
export function useDeleteScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<{ id: string }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY })
    },
  })
}

/** 立即执行：返回本次运行的会话 id（去对话页看过程/产物）；同一任务在跑时后端回 409 */
export function useRunScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<RunScheduledTaskResult>(`/api/tasks/${encodeURIComponent(id)}/run`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY })
    },
  })
}
