/**
 * **内部**节点运维端点（P1-14 部署优化）—— `/internal/node/*`，**只认签名**。
 *
 * 调用方：另一台实例的后端（`sandbox/nodeOps.ts`），凭 `NODE_OPS_SECRET` 签发的**一次性**令牌。
 * ⚠️ 不走用户会话、不挂 `requireAuth`；校验不过一律 401/403，且不透露"哪一步不对"之外的细节。
 * ⚠️ 只做两件事：自检、自举。**不做任意命令执行**（即便签名有效）。
 */

import { ok } from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { bootstrapNode, inspectNode, type NodeRoleName } from '../sandbox/nodeBootstrap.js'
import { consumeNodeOpsNonce, verifyNodeOpsToken } from '../sandbox/nodeOpsToken.js'

/** 从请求头取令牌并校验收到的操作是否与令牌里的一致 */
async function authorize(request: FastifyRequest, op: 'self' | 'bootstrap'): Promise<NodeRoleName> {
  const token = String(request.headers['x-node-ops-token'] ?? '')
  const verdict = verifyNodeOpsToken(token, config.sandbox.instanceId)
  if (!verdict.ok) {
    getLogger().warn({ reason: verdict.reason, op }, '内部节点运维请求被拒（令牌校验失败）')
    throw Object.assign(new Error(`令牌无效：${verdict.reason}`), { statusCode: 401 })
  }
  if (verdict.payload.op !== op) {
    throw Object.assign(new Error(`令牌操作不匹配（期望 ${op}，实为 ${verdict.payload.op}）`), { statusCode: 403 })
  }
  if (!(await consumeNodeOpsNonce(verdict.payload))) {
    throw Object.assign(new Error('令牌已被使用（重放）'), { statusCode: 409 })
  }
  const body = (request.body ?? {}) as { role?: unknown }
  const role: NodeRoleName = body.role === 'chatbot' ? 'chatbot' : 'taskAgent'
  return role
}

export function registerNodeInternalRoutes(app: FastifyInstance): void {
  app.get('/internal/node/self', async (request) => {
    const role = await authorize(request, 'self')
    return ok(await inspectNode({ role, instanceId: config.sandbox.instanceId }))
  })

  app.post('/internal/node/bootstrap', async (request) => {
    const role = await authorize(request, 'bootstrap')
    getLogger().info({ role, from: 'peer' }, '收到远端发起的节点自举')
    return ok(await bootstrapNode({ role, instanceId: config.sandbox.instanceId }))
  })
}
