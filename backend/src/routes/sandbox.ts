/**
 * 沙箱路由（主应用）—— 运行时清单与**按需构建**（P1-17a）。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2；**2026-10-14 用户定案 B**：
 * 可用运行时由后端**探测本机镜像**得到（有就提供），用户选了本机没有的组合 ⇒ 后端**按需构建**。
 *
 * ★ 2026-10-14 修订：构建**改成长任务**（进度条 + 可取消）—— 四条端点：
 *   `GET  /api/sandbox/runtimes`                     已就绪的运行时 + 组件目录 + 能否按需构建
 *   `POST /api/sandbox/runtimes/build`               启动（或复用已在进行/已就绪的）→ 回 `buildId`
 *   `GET  /api/sandbox/runtimes/build/:buildId`      拿任务状态（阶段 / 百分比 / 日志尾 / 结局）
 *   `POST /api/sandbox/runtimes/build/:buildId/cancel` 取消（杀 docker build 进程）
 *
 * 全部端点登录即可读/用 —— 它们不含任何秘密，是"这台机器的运行时能力"。
 */

import { appMsg,
  AppError,
  buildSandboxRuntimeBodySchema,
  buildSandboxRuntimeResultSchema,
  listSandboxRuntimesResultSchema,
  ok,
  SANDBOX_RUNTIME_LANGUAGE_SPECS,
  sandboxBuildJobSchema,
  sandboxVariantLabel,
  type BuildSandboxRuntimeBody,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { config } from '../config.js'
import { listSandboxInstances } from '../services/sandboxInstance.service.js'
import { listAvailableSandboxRuntimes } from '../sandbox/manager.js'
import {
  cancelSandboxBuild,
  canBuildSandboxRuntime,
  getSandboxBuildJob,
  startSandboxRuntimeBuild,
} from '../sandbox/runtimeBuild.js'

const buildIdParamsSchema = z.object({ buildId: z.string().min(1).max(128) })
/** 带实例的任务定位（多实例：任务只在那台的进程里） */
const instanceBuildIdParamsSchema = z.object({
  instanceId: z.string().min(1).max(120),
  buildId: z.string().min(1).max(128),
})

export function registerSandboxRoutes(app: FastifyInstance): void {
  /**
   * `GET /api/sandbox/runtimes` —— 已就绪运行时 + 组件目录 + 能否按需构建（供会话选择器用）。
   *
   * ★ 多机（P1-14）：顶层 `runtimes/canBuild` = **承接本次请求的那台**（兼容旧前端）；
   *   `instances[]` 给出每台在线实例各自的能力（来自心跳），`servedBy` 指向本机那一项。
   *   ⚠️ 只依赖 Redis 注册表 + 本机探测，**不**去远端实例拉取（网关没有服务身份，见 `router/`）。
   */
  app.get('/api/sandbox/runtimes', { preHandler: app.requireAuth }, async () => {
    const [localRuntimes, canBuild] = await Promise.all([listAvailableSandboxRuntimes(), canBuildSandboxRuntime()])
    const registry = await listSandboxInstances()
    const selfId = config.sandbox.instanceId
    // 远端实例：能力来自心跳里的变体 id；镜像 ref 由版本线推出（与本地探测同一套 `repo:<id>-v<层>`）
    const repo = config.sandbox.runtimeRepo
    const instances = registry.items
      .map((item) => {
        if (item.instanceId === selfId) {
          return {
            instanceId: item.instanceId,
            advertiseAddr: item.advertiseAddr,
            runtimes: localRuntimes,
            canBuild,
            load: item.load === null ? null : { slotsUsed: item.load.slotsUsed, slotsTotal: item.load.slotsTotal, queueDepth: item.load.queueDepth },
            ready: item.readiness === null ? null : item.readiness.ready,
            missing: item.readiness?.missing ?? [],
            known: true,
          }
        }
        const ids = item.runtimes
        return {
          instanceId: item.instanceId,
          advertiseAddr: item.advertiseAddr,
          runtimes: (ids ?? []).map((id) => ({ id, label: sandboxVariantLabel(id), image: `${repo}:${id}` })),
          // 远端能否构建由**它自己**决定（构建上下文在它那台）⇒ 用它心跳上报的值；未上报按 false
          canBuild: item.canBuild === true,
          load: item.load === null ? null : { slotsUsed: item.load.slotsUsed, slotsTotal: item.load.slotsTotal, queueDepth: item.load.queueDepth },
          ready: item.readiness === null ? null : item.readiness.ready,
          missing: item.readiness?.missing ?? [],
          known: ids !== null,
        }
      })
    // ★ 未就绪的实例**可见但不可选**：从会话选择列表里排除（页面在 `/admin/sandbox-instances` 仍能看到它）
    const selectable = instances.filter((item) => item.ready !== false)
    selectable.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
    return ok(
      listSandboxRuntimesResultSchema.parse({
        runtimes: localRuntimes,
        languages: SANDBOX_RUNTIME_LANGUAGE_SPECS.map((spec) => ({
          language: spec.language,
          label: spec.label,
          defaultVersion: spec.defaultVersion,
          suggestions: [...spec.suggestions],
          hint: spec.hint,
          baseVersion: spec.baseVersion ?? null,
        })),
        fallbackImage: config.sandbox.image ?? null,
        canBuild,
        instances: selectable,
        // ⚠️ 必须在**过滤前**的 `instances` 上算：本机自己未就绪时它不在 `selectable` 里，
        //    用过滤后的表算会让 `servedBy` 变成 `null`，"这次请求到底哪台接的"就无从判断了。
        servedBy: instances.some((item) => item.instanceId === selfId) ? selfId : null,
      }),
    )
  })

  /**
   * `POST /api/sandbox/runtimes/build` —— **启动**一个构建任务（P1-17a · 定案 B）。
   *
   * 幂等/去重：已有同变体镜像 ⇒ 直接回 `succeeded` 快照；同 tag 已有在跑的 job ⇒ 复用它的快照。
   * **立刻返回**（不阻塞在 docker build 上）—— 前端拿 `buildId` 去轮询 {@link getSandboxBuildJob}。
   */
  app.post<{ Body: BuildSandboxRuntimeBody }>(
    '/api/sandbox/runtimes/build',
    { preHandler: app.requireAuth, schema: { body: buildSandboxRuntimeBodySchema } },
    async (request) =>
      ok(
        buildSandboxRuntimeResultSchema.parse(
          await startSandboxRuntimeBuild(request.body.components, { expectedInstanceId: request.body.instanceId ?? undefined }),
        ),
      ),
  )

  /**
   * `GET /api/sandbox/runtimes/build/:instanceId/:buildId` —— 拿构建任务状态（前端轮询画进度条）。
   *
   * ★ 多实例（P1-14）：任务**只存在于发起它的那个进程** ⇒ 路径里带实例 id，网关据此**点名路由**
   *   （`shared/router.ts#instanceTargetOf` + `selectUpstream` 的 `pinned`）。落到别的实例时是 404，
   *   且该实例只会认**自己**的 buildId（`expectedInstanceId`）。
   *
   * 旧的 `/build/:buildId` 保留：单实例/直连后端时仍可用（多实例下可能被路由到别的实例而 404 —— 这正是要避免的）。
   */
  app.get<{ Params: { instanceId: string; buildId: string } }>(
    '/api/sandbox/runtimes/build/:instanceId/:buildId',
    { preHandler: app.requireAuth, schema: { params: instanceBuildIdParamsSchema } },
    async (request) => {
      const job = getSandboxBuildJob(request.params.buildId, request.params.instanceId)
      if (job === undefined) throw AppError.notFound(appMsg('app.m022'))
      return ok(sandboxBuildJobSchema.parse(job))
    },
  )

  app.get<{ Params: { buildId: string } }>(
    '/api/sandbox/runtimes/build/:buildId',
    { preHandler: app.requireAuth, schema: { params: buildIdParamsSchema } },
    async (request) => {
      const job = getSandboxBuildJob(request.params.buildId)
      if (job === undefined) throw AppError.notFound(appMsg('app.m023'))
      return ok(sandboxBuildJobSchema.parse(job))
    },
  )

  /** `POST /api/sandbox/runtimes/build/:instanceId/:buildId/cancel` —— 取消（该实例上的那一份；幂等） */
  app.post<{ Params: { instanceId: string; buildId: string } }>(
    '/api/sandbox/runtimes/build/:instanceId/:buildId/cancel',
    { preHandler: app.requireAuth, schema: { params: instanceBuildIdParamsSchema } },
    async (request) => {
      const job = cancelSandboxBuild(request.params.buildId, request.params.instanceId)
      if (job === undefined) throw AppError.notFound(appMsg('app.m022'))
      return ok(sandboxBuildJobSchema.parse(job))
    },
  )

  /** `POST /api/sandbox/runtimes/build/:buildId/cancel`（旧路径；见上） */
  app.post<{ Params: { buildId: string } }>(
    '/api/sandbox/runtimes/build/:buildId/cancel',
    { preHandler: app.requireAuth, schema: { params: buildIdParamsSchema } },
    async (request) => {
      const job = cancelSandboxBuild(request.params.buildId)
      if (job === undefined) throw AppError.notFound(appMsg('app.m023'))
      return ok(sandboxBuildJobSchema.parse(job))
    },
  )
}
