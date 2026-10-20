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

/**
 * **启动**一个运行时构建任务（P1-17a 定案 B）；立刻回 `buildId` 供轮询。
 *
 * `targetInstanceId`：期望在**哪台实例**上构建（P1-14）。同时放进 query 与 body —— query 是给
 * **网关**点名路由用的（网关不解析 body），body 是给**后端**校验落地是否为目标实例用的。
 */
export function startSandboxBuild(
  components: SandboxRuntimeSelection[],
  targetInstanceId?: string | null,
): Promise<StartSandboxBuildResult> {
  const query = targetInstanceId === undefined || targetInstanceId === null ? '' : `?instanceId=${encodeURIComponent(targetInstanceId)}`
  return request<StartSandboxBuildResult>(`/api/sandbox/runtimes/build${query}`, {
    method: 'POST',
    body: { components, instanceId: targetInstanceId ?? null },
  })
}

/**
 * 拿一个构建任务的当前状态（前端轮询它画进度条）。
 *
 * `instanceId`：**哪台实例上的任务**（任务只存在于那个进程）。路径形态
 * `/build/:instanceId/:buildId` 会被网关点名路由到该实例；省略时走旧路径（单实例/直连）。
 */
export function fetchSandboxBuildJob(buildId: string, instanceId?: string | null): Promise<SandboxBuildJob> {
  const path =
    instanceId === undefined || instanceId === null
      ? `/api/sandbox/runtimes/build/${encodeURIComponent(buildId)}`
      : `/api/sandbox/runtimes/build/${encodeURIComponent(instanceId)}/${encodeURIComponent(buildId)}`
  return request<SandboxBuildJob>(path)
}

/** 取消一个构建任务（杀 docker build 进程；幂等）。`instanceId` 的语义同 {@link fetchSandboxBuildJob} */
export function cancelSandboxBuildJob(buildId: string, instanceId?: string | null): Promise<SandboxBuildJob> {
  const path =
    instanceId === undefined || instanceId === null
      ? `/api/sandbox/runtimes/build/${encodeURIComponent(buildId)}/cancel`
      : `/api/sandbox/runtimes/build/${encodeURIComponent(instanceId)}/${encodeURIComponent(buildId)}/cancel`
  return request<SandboxBuildJob>(path, { method: 'POST' })
}

/** 启动构建任务的 mutation（成功后失效运行时列表，让新镜像出现在下拉里） */
export function useStartSandboxBuild() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (components: SandboxRuntimeSelection[]) => startSandboxBuild(components),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sandboxRuntimesQueryKey })
    },
  })
}
