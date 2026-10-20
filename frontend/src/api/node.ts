/**
 * 节点自检 / 自举接口（P1-14 部署优化；**仅 ADMIN**）。
 *
 * | 端点 | 作用 |
 * |------|------|
 * | `GET  /api/admin/node/self?instanceId=` | 指定实例自检（角色 / 平台 / 各项是否就绪 / 缺什么） |
 * | `POST /api/admin/node/bootstrap/jobs` | **启动**初始化任务（立即返回 jobId + 完整步骤计划） |
 * | `GET  /api/admin/node/bootstrap/jobs/:instanceId/:jobId` | 任务进度快照（轮询用） |
 * | `GET  /api/admin/node/bootstrap/current?instanceId=` | 这台的当前 / 最近一次任务（切页回来据此恢复） |
 *
 * ★ 2026-10-20（用户反馈「切到别的页面再回来就看不到进度」）：进度不再是某个组件里的
 *   `Promise` + 假进度条，而是**后端的任务快照**。页面卸载/重挂、换设备、换实例都能接着看。
 *
 * 远端实例由后端用 `NODE_OPS_SECRET` 签发的一次性令牌**转发到那台执行**（见 `sandbox/nodeOps.ts`），
 * 因此管理页可以真正操作任意在线实例；三台未配置同一份密钥时只有本机可用（错误里会说明）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  NodeBootstrapJob,
  NodeBootstrapResult,
  NodeReport,
} from '@doubulea/shared'

import { request } from './client.js'
import { SANDBOX_INSTANCES_QUERY_KEY } from './sandboxInstances.js'

// 契约与后端同源：`shared/src/node.ts`（`backend/src/sandbox/nodeBootstrap.ts` 实现）
export type { NodeBootstrapJob, NodeBootstrapResult, NodeBootstrapTaskStep, NodeCheckItem, NodeReport } from '@doubulea/shared'

export const NODE_SELF_QUERY_KEY = (instanceId: string) => ['admin-node-self', instanceId] as const
/** 任务快照的 query key（`instanceId` 为 `null` 时不会发请求） */
export const NODE_JOB_QUERY_KEY = (instanceId: string | null, jobId: string | null) =>
  ['admin-node-job', instanceId ?? '', jobId ?? 'current'] as const

/** 指定实例的自检（远端实例由后端带签名转发到那台执行） */
export function fetchNodeSelf(instanceId: string): Promise<NodeReport> {
  return request<NodeReport>(`/api/admin/node/self?instanceId=${encodeURIComponent(instanceId)}`)
}

/** 指定实例的自检（默认 30s 刷新；失败不重试 —— 页面显示错误，不把"连不上"当成抖动） */
export function useNodeSelf(instanceId: string | null) {
  return useQuery({
    queryKey: NODE_SELF_QUERY_KEY(instanceId ?? ''),
    queryFn: () => fetchNodeSelf(instanceId as string),
    enabled: instanceId !== null,
    refetchInterval: 30_000,
    retry: false,
  })
}

export interface StartedBootstrapJob {
  job: NodeBootstrapJob
  /** `true` = 这台实例已经在跑，本次没有叠跑（后端返回的是同一个任务） */
  reused: boolean
}

/** 启动初始化任务（**立即返回**；进度靠 {@link useNodeBootstrapJob} 轮询） */
export function useStartBootstrapJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (instanceId: string) =>
      request<StartedBootstrapJob>('/api/admin/node/bootstrap/jobs', { method: 'POST', body: { instanceId } }),
    onSuccess: (started, instanceId) => {
      // 把刚拿到的快照直接当作这一格的初始数据，页面立刻有东西可画（不用等第一次轮询）
      queryClient.setQueryData(NODE_JOB_QUERY_KEY(instanceId, started.job.jobId), started.job)
      queryClient.setQueryData(NODE_JOB_QUERY_KEY(instanceId, null), started.job)
      void queryClient.invalidateQueries({ queryKey: ['admin-node-bootstrap', instanceId] })
    },
  })
}

/**
 * 任务进度（**有 `running` 时才轮询**，且只在展开 / 页面可见时跑）。
 *
 * `jobId = null` ⇒ 读"这台实例的当前任务"（切页回来时用它：不需要记住 jobId 也能接上进度）。
 */
export function useNodeBootstrapJob(instanceId: string | null, jobId: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: NODE_JOB_QUERY_KEY(instanceId, jobId),
    queryFn: async () => {
      const query = `instanceId=${encodeURIComponent(instanceId as string)}${
        jobId === null ? '' : `&jobId=${encodeURIComponent(jobId)}`
      }`
      return request<NodeBootstrapJob | null>(`/api/admin/node/bootstrap/current?${query}`)
    },
    enabled: instanceId !== null && options.enabled !== false,
    // 1.5s：步骤是秒级变化的（拉镜像 / 起容器），慢一点也无妨；跑完立刻停（下面 refetchInterval 返回 false）
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1_500 : false),
    refetchIntervalInBackground: false,
    // 快照不存在（过期 / 记错了 id）不是错误：当作"没有任务"
    retry: false,
  })
}

/** 旧版**同步**初始化（保留给脚本/回归；页面已改用任务式） */
export function useBootstrapNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (instanceId: string) =>
      request<NodeBootstrapResult>('/api/admin/node/bootstrap', { method: 'POST', body: { instanceId } }),
    onSuccess: (_result, instanceId) => {
      void queryClient.invalidateQueries({ queryKey: NODE_SELF_QUERY_KEY(instanceId) })
      void queryClient.invalidateQueries({ queryKey: SANDBOX_INSTANCES_QUERY_KEY })
    },
  })
}
