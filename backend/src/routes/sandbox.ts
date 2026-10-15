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

import {
  AppError,
  buildSandboxRuntimeBodySchema,
  buildSandboxRuntimeResultSchema,
  listSandboxRuntimesResultSchema,
  ok,
  SANDBOX_RUNTIME_LANGUAGE_SPECS,
  sandboxBuildJobSchema,
  type BuildSandboxRuntimeBody,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { config } from '../config.js'
import { listAvailableSandboxRuntimes } from '../sandbox/manager.js'
import {
  cancelSandboxBuild,
  canBuildSandboxRuntime,
  getSandboxBuildJob,
  startSandboxRuntimeBuild,
} from '../sandbox/runtimeBuild.js'

const buildIdParamsSchema = z.object({ buildId: z.string().min(1).max(128) })

export function registerSandboxRoutes(app: FastifyInstance): void {
  /** `GET /api/sandbox/runtimes` —— 已就绪运行时 + 组件目录 + 能否按需构建（供会话选择器用） */
  app.get('/api/sandbox/runtimes', { preHandler: app.requireAuth }, async () =>
    ok(
      listSandboxRuntimesResultSchema.parse({
        runtimes: await listAvailableSandboxRuntimes(),
        languages: SANDBOX_RUNTIME_LANGUAGE_SPECS.map((spec) => ({
          language: spec.language,
          label: spec.label,
          defaultVersion: spec.defaultVersion,
          suggestions: [...spec.suggestions],
          hint: spec.hint,
          baseVersion: spec.baseVersion ?? null,
        })),
        fallbackImage: config.sandbox.image ?? null,
        canBuild: await canBuildSandboxRuntime(),
      }),
    ),
  )

  /**
   * `POST /api/sandbox/runtimes/build` —— **启动**一个构建任务（P1-17a · 定案 B）。
   *
   * 幂等/去重：已有同变体镜像 ⇒ 直接回 `succeeded` 快照；同 tag 已有在跑的 job ⇒ 复用它的快照。
   * **立刻返回**（不阻塞在 docker build 上）—— 前端拿 `buildId` 去轮询 {@link getSandboxBuildJob}。
   */
  app.post<{ Body: BuildSandboxRuntimeBody }>(
    '/api/sandbox/runtimes/build',
    { preHandler: app.requireAuth, schema: { body: buildSandboxRuntimeBodySchema } },
    async (request) => ok(buildSandboxRuntimeResultSchema.parse(await startSandboxRuntimeBuild(request.body.components))),
  )

  /** `GET /api/sandbox/runtimes/build/:buildId` —— 拿构建任务的当前状态（前端轮询它画进度条） */
  app.get<{ Params: { buildId: string } }>(
    '/api/sandbox/runtimes/build/:buildId',
    { preHandler: app.requireAuth, schema: { params: buildIdParamsSchema } },
    async (request) => {
      const job = getSandboxBuildJob(request.params.buildId)
      if (job === undefined) throw AppError.notFound('构建任务不存在或已过期（可能是后端重启过）')
      return ok(sandboxBuildJobSchema.parse(job))
    },
  )

  /** `POST /api/sandbox/runtimes/build/:buildId/cancel` —— 取消构建（杀 docker build 进程；幂等） */
  app.post<{ Params: { buildId: string } }>(
    '/api/sandbox/runtimes/build/:buildId/cancel',
    { preHandler: app.requireAuth, schema: { params: buildIdParamsSchema } },
    async (request) => {
      const job = cancelSandboxBuild(request.params.buildId)
      if (job === undefined) throw AppError.notFound('构建任务不存在或已过期（可能是后端重启过）')
      return ok(sandboxBuildJobSchema.parse(job))
    },
  )
}
