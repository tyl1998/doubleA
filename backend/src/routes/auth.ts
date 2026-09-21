/**
 * 认证路由（P0-1-7）
 *
 * 依据：`docs/02-后端设计.md` §4.1 四个端点 + 首登强制改密注记；`01` §3.1 需求 1/3
 *
 * 职责边界（本文件只做三件事）：
 *   校验请求（schema）→ 调 `services/auth.service` → 组装信封 + 收发会话 Cookie。
 * 认证逻辑一律不在路由里；会话的发放/销毁一律走 `plugins/session.ts` 的
 * `issueSession`/`endSession`（Cookie 属性集中在一处定义，前后端与登出才不会各写一套）。
 *
 * 四个端点在"是否要登录"上的差别（这也是首登闸门白名单的由来，见 `installPasswordChangeGate`）：
 *
 * | 端点 | 需登录 | 首登未改密时 | 说明 |
 * |------|--------|--------------|------|
 * | POST /api/auth/login | 否 | 放行 | 否则永远拿不到会话，改密也就无从谈起 |
 * | GET  /api/auth/me | 是 | 放行 | 前端要靠它读到 `mustChangePassword` 才知道该跳改密页 |
 * | POST /api/auth/password | 是 | 放行 | 强制改密本身的出口 |
 * | POST /api/auth/logout | 否（幂等） | 放行 | 允许"改密前先退出" |
 */

import { ok, changePasswordBodySchema, loginBodySchema, type ChangePasswordBody, type LoginBody } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { getLogger } from '../infra/logger.js'
import { endSession, issueSession, requireAuthContext } from '../plugins/session.js'
import { changePassword, login, toAuthUser } from '../services/auth.service.js'

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * 登录（`02` §4.1）。
   * 成功即下发会话 Cookie —— 此时**不**判断 `mustChangePassword`：会话照发，
   * 由首登闸门把其余 API 拦住，前端据 `/auth/me` 的标记把人导到改密页。
   */
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      const user = await login(request.body)
      await issueSession(reply, user.id)
      return ok(user)
    },
  )

  /** 登出：销毁会话 + 清 Cookie。幂等（无会话/重复登出都成功），见 `endSession` 的注释 */
  app.post('/api/auth/logout', async (request, reply) => {
    await endSession(request, reply)
    getLogger().info('登出完成')
    return ok(null)
  })

  /** 当前用户（含 `mustChangePassword`，`02` §4.1）。数据直接取自 `requireAuth` 已解析的用户快照 */
  app.get('/api/auth/me', { preHandler: app.requireAuth }, async (request) =>
    ok(toAuthUser(requireAuthContext(request).user)),
  )

  /**
   * 改密（旧密码校验）。**首登强制改密也走这个端点** —— 所以它必须在闸门白名单里，
   * 否则用户会被自己的强制改密要求拦住（典型死循环）。
   */
  app.post<{ Body: ChangePasswordBody }>(
    '/api/auth/password',
    { preHandler: app.requireAuth, schema: { body: changePasswordBodySchema } },
    async (request) => {
      const { user } = requireAuthContext(request)
      return ok(await changePassword(user.id, request.body))
    },
  )
}
