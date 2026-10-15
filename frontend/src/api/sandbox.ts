/**
 * 沙箱相关 API（前端）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2（P1-17a）。
 *   · 探测本机可用运行时（**有就提供、没有就不提供**，用户 2026-10-14 定案）；
 *   · ★ 2026-10-14 修订：按需构建**改成长任务** —— 启动拿 `buildId`、轮询进度、可取消。
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import type {
  ListSandboxRuntimesResult,
  SandboxBuildJob,
  SandboxRuntimeSelection,
  StartSandboxBuildResult,
} from '@doubulea/shared'

import { request } from './client.js'

/** 运行时列表的 query key（`["sandbox-runtimes"]`；平台级、与具体会话无关） */
export const sandboxRuntimesQueryKey = ['sandbox-runtimes'] as const

/** 拉本机探测到的可用运行时 + 组件目录 + 能否按需构建 */
export function fetchSandboxRuntimes(): Promise<ListSandboxRuntimesResult> {
  return request<ListSandboxRuntimesResult>('/api/sandbox/runtimes')
}

/** 运行时列表的查询钩子（会话设置的选择器用它；缓存交给 react-query 默认口径） */
export function useSandboxRuntimes(): UseQueryResult<ListSandboxRuntimesResult> {
  return useQuery({
    queryKey: sandboxRuntimesQueryKey,
    queryFn: fetchSandboxRuntimes,
    staleTime: 30_000,
  })
}

/** **启动**一个运行时构建任务（P1-17a 定案 B）；立刻回 `buildId` 供轮询 */
export function startSandboxBuild(components: SandboxRuntimeSelection[]): Promise<StartSandboxBuildResult> {
  return request<StartSandboxBuildResult>('/api/sandbox/runtimes/build', {
    method: 'POST',
    body: { components },
  })
}

/** 拿一个构建任务的当前状态（前端轮询它画进度条） */
export function fetchSandboxBuildJob(buildId: string): Promise<SandboxBuildJob> {
  return request<SandboxBuildJob>(`/api/sandbox/runtimes/build/${buildId}`)
}

/** 取消一个构建任务（杀 docker build 进程；幂等） */
export function cancelSandboxBuildJob(buildId: string): Promise<SandboxBuildJob> {
  return request<SandboxBuildJob>(`/api/sandbox/runtimes/build/${buildId}/cancel`, { method: 'POST' })
}

/** 启动构建任务的 mutation（成功后失效运行时列表，让新镜像出现在下拉里） */
export function useStartSandboxBuild() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: startSandboxBuild,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sandboxRuntimesQueryKey })
    },
  })
}
