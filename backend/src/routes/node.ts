/**
 * 节点管理路由（P1-14 部署优化；2026-10-19 用户定案修订）—— **仅 ADMIN**。
 *
 * 与上一版的区别（用户纠偏）：不是"只能看到本机"，而是**按实例管理**：
 *   · `GET  /api/admin/node/self?instanceId=<id>`              → 指定实例的自检报告
 *   · `POST /api/admin/node/bootstrap/jobs { instanceId }`      → **启动**初始化任务（立即返回 jobId + 步骤计划）
 *   · `GET  /api/admin/node/bootstrap/jobs/:instanceId/:jobId`  → 进度快照（步骤 / 百分比 / 结论）
 *   · `POST /api/admin/node/bootstrap { instanceId }`            → 旧版**同步**初始化（保留：脚本/回归仍可用）
 *
 * ★ 2026-10-20（用户反馈）：「点了初始化切到别的页面再回来，就看不到进度了」。
 *   根因是进度**只存在于发起请求那个组件的内存里**：请求一断、组件一卸载就没了，而且真跑几分钟时
 *   浏览器/网关还可能先超时。现在改成**任务化**：`POST /jobs` 立刻返回，进度由目标实例的 Redis
 *   承载（`sandbox/nodeJobStore.ts`），页面随时 `GET` 回来看。旧同步端点保留以免破坏调用方，
 *   但它**不写任务快照**（同步等待的调用方自己看响应即可）。
 *
 * 执行方式（`sandbox/nodeOps.ts`）：目标是本实例 ⇒ 本地执行；远端 ⇒ 用 `NODE_OPS_SECRET`
 * 签发的一次性令牌转发到那台的 `/internal/node/*` 执行。**因此能真正管理任意在线实例**，
 * 前提是三台配置同一份 `NODE_OPS_SECRET`（未配置时只有本机可用，错误里会写清楚）。
 *
 * ⚠️ 实例必须在线（注册表里有 `sandbox:instance:*`）——离线实例连地址都没有，无法代发。
 */

import { z } from 'zod'
import { appMsg, AppError, ok } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { config } from '../config.js'
import { listSandboxInstances } from '../services/sandboxInstance.service.js'
import { isNodeRole, detectNodeRoleSafe } from '../services/nodeRole.js'
import { startBootstrapJob } from '../services/nodeBootstrapJob.service.js'
import type { NodeRoleName } from '../sandbox/nodeBootstrap.js'
import { bootstrapNodeOn, inspectNodeOn, NodeOpsError, type NodeTarget } from '../sandbox/nodeOps.js'
import { getCurrentJob, getJob } from '../sandbox/nodeJobStore.js'

const targetQuerySchema = z.object({ instanceId: z.string().min(1).max(120) })
const targetBodySchema = z.object({ instanceId: z.string().min(1).max(120) })
const jobParamsSchema = z.object({
  instanceId: z.string().min(1).max(120),
  jobId: z.string().min(1).max(160),
})
const currentQuerySchema = z.object({
  instanceId: z.string().min(1).max(120),
  /** 可选：优先看这个任务（页面记得自己上次起的那个） */
  jobId: z.string().min(1).max(160).optional(),
})

/** 本节点的档位：显式 `DOUBULEA_NODE_ROLE` 优先；否则按沙箱是否启用推断 */
function currentNodeRole(): NodeRoleName {
  const explicit = detectNodeRoleSafe()
  if (isNodeRole(explicit)) return explicit
  return config.sandbox.enabled ? 'taskAgent' : 'chatbot'
}

/** 从注册表解析目标实例（本实例不走 Redis —— 它一定"在线"） */
async function resolveTarget(instanceId: string): Promise<NodeTarget> {
  if (instanceId === config.sandbox.instanceId) {
    // 本实例不走网络（`nodeOps` 里会直接本地执行，地址只是占位）
    return { instanceId, advertiseAddr: `127.0.0.1:${String(config.port)}` }
  }
  const { items } = await listSandboxInstances()
  const found = items.find((item) => item.instanceId === instanceId)
  if (found !== undefined) return { instanceId, advertiseAddr: found.advertiseAddr }
  throw AppError.notFound(appMsg('app.m102', { p0: instanceId }))
}

function toAppError(error: unknown): never {
  if (error instanceof NodeOpsError) throw AppError.conflict(error.message)
  throw error
}

export function registerNodeRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { instanceId: string } }>(
    '/api/admin/node/self',
    { preHandler: app.requireAdmin, schema: { querystring: targetQuerySchema } },
    async (request) => {
      const target = await resolveTarget(request.query.instanceId)
      const role = target.instanceId === config.sandbox.instanceId ? currentNodeRole() : 'taskAgent'
      return ok(await inspectNodeOn(target, role).catch(toAppError))
    },
  )

  /**
   * **启动**一键初始化（立即返回）。
   *
   * 返回 `{ job, reused }`：`reused=true` 表示这台实例**已经在跑**，本次没有叠跑（前端直接接管展示）。
   * 幂等语义没变（只修坏项），只是"等它跑完"从 HTTP 生命周期里拿了出来。
   */
  app.post<{ Body: { instanceId: string } }>(
    '/api/admin/node/bootstrap/jobs',
    { preHandler: app.requireAdmin, schema: { body: targetBodySchema } },
    async (request) => {
      const target = await resolveTarget(request.body.instanceId)
      const role = target.instanceId === config.sandbox.instanceId ? currentNodeRole() : 'taskAgent'
      const started = await startBootstrapJob(target, role, { isSelf: target.instanceId === config.sandbox.instanceId })
      return ok(started)
    },
  )

  /** 进度快照（找不到 / 已过期 ⇒ 404，页面据此显示"没有可回看的任务"） */
  app.get<{ Params: { instanceId: string; jobId: string } }>(
    '/api/admin/node/bootstrap/jobs/:instanceId/:jobId',
    { preHandler: app.requireAdmin, schema: { params: jobParamsSchema } },
    async (request) => {
      const job = await getJob(request.params.instanceId, request.params.jobId)
      if (job === undefined) throw AppError.notFound(appMsg('app.m103'))
      return ok(job)
    },
  )

  /**
   * 这台实例的**当前任务**：在跑的优先，否则给最近结束的那个；`null` = 从没初始化过。
   * 页面挂载时先问它 —— 这就是"切页回来还能看到进度"的落点。
   */
  app.get<{ Querystring: { instanceId: string; jobId?: string } }>(
    '/api/admin/node/bootstrap/current',
    { preHandler: app.requireAdmin, schema: { querystring: currentQuerySchema } },
    async (request) => ok(await getCurrentJob(request.query.instanceId, request.query.jobId)),
  )

  /** 旧版：**同步**执行（保留兼容；等它跑完可能数分钟，超时由网关的长任务清单放宽） */
  app.post<{ Body: { instanceId: string } }>(
    '/api/admin/node/bootstrap',
    { preHandler: app.requireAdmin, schema: { body: targetBodySchema } },
    async (request) => {
      const target = await resolveTarget(request.body.instanceId)
      const role = target.instanceId === config.sandbox.instanceId ? currentNodeRole() : 'taskAgent'
      return ok(await bootstrapNodeOn(target, role).catch(toAppError))
    },
  )
}
