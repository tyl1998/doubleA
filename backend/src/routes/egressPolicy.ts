/**
 * 沙箱出网策略路由（egress 范围 + 黑白名单）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.5（出网平台化）+ §五 7.5b（出网范围，P1-16a）。
 *
 * 两条端点（**仅 ADMIN** —— 这是平台级配置，不是"每个人自己的东西"）：
 *   `GET /api/admin/egress-policy`  读当前策略（范围 + 两张表 + 推导模式）
 *   `PUT /api/admin/egress-policy`  整体替换（范围 + 两张表一起交）
 *
 * ⚠️ **出网范围是平台级、不是会话级**（2026-10-14 用户定案）：**不在会话设置里配**，
 *    统一配在本页（`/admin/egress`）。会话/容器只把流量交给代理，代理按本策略判定。
 *
 * ⚠️ 与 git 凭据那族**刻意不同**：凭据挂 `requireAuth`（用户级、ADMIN 无后门）；
 *    这里是**平台级共享事实**，只有 ADMIN 能读能改（与 `/api/model-providers` 同族）。
 *
 * `mode` 是服务层推导的（`deriveEgressMode` 对范围解析后的两张表），请求体**不含它**。
 */

import { egressPolicySchema, ok, updateEgressPolicyBodySchema, type UpdateEgressPolicyBody } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { getEgressPolicy, setEgressPolicy } from '../services/egressPolicy.service.js'

export function registerEgressPolicyRoutes(app: FastifyInstance): void {
  /** 读当前策略（仅 ADMIN）。响应再过一次 schema，与其余路由"响应也过 schema"的口径一致。 */
  app.get('/api/admin/egress-policy', { preHandler: app.requireAdmin }, async () =>
    ok(egressPolicySchema.parse(await getEgressPolicy())),
  )

  /** 整体替换策略（仅 ADMIN）。`scope` / `allowHosts` / `denyHosts` 都是**整体替换** */
  app.put<{ Body: UpdateEgressPolicyBody }>(
    '/api/admin/egress-policy',
    { preHandler: app.requireAdmin, schema: { body: updateEgressPolicyBodySchema } },
    async (request) => ok(egressPolicySchema.parse(await setEgressPolicy(request.body))),
  )
}
