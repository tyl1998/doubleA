/**
 * **按实例**执行节点运维（P1-14 部署优化；2026-10-19 用户定案）。
 *
 * 管理页要能对**任意在线实例**做自检 / 初始化，而自举必须驱动**那台机器**的 Docker。
 * 做法：当前后端（管理员请求落到的这台）以 `NODE_OPS_SECRET` 签发一次性令牌，把请求转发到
 * 目标实例的**内部端点** `/internal/node/{self,bootstrap}`；目标实例校验签名 + 消费 nonce 后执行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 判据
 * ─────────────────────────────────────────────────────────────────────
 *   · 目标是**本实例** ⇒ 直接本地执行（不绕网络、不需要令牌）。
 *   · 目标是远端 ⇒ `advertiseAddr` 必须可连；令牌密钥未配置 ⇒ 如实回"未启用跨实例运维"。
 *   · 远端返回什么就原样回什么（结构化步骤 + 自检报告），不在这里改写结论。
 *
 * ⚠️ 安全：内部端点**只认签名**（不认用户会话）；它只做"自检 / 自举"两件事，不做任意命令执行。
 * ⚠️ `advertiseAddr` 来自注册表（心跳写的）：跨实例转发天然只发生在集群内部网。
 */

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { bootstrapNode, inspectNode, type NodeBootstrapResult, type NodeReport, type NodeRoleName } from './nodeBootstrap.js'
import { signNodeOpsToken } from './nodeOpsToken.js'

/** 目标实例的地址（注册表里的 `advertiseAddr`） */
export interface NodeTarget {
  instanceId: string
  advertiseAddr: string
}

/** 转发失败的可读结果（页面直接展示） */
export class NodeOpsError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-configured' | 'unreachable' | 'rejected' | 'bad-response',
  ) {
    super(message)
    this.name = 'NodeOpsError'
  }
}

/** 把 `host:port` 变成 base URL（容忍注册表里没带协议） */
function baseUrlOf(advertiseAddr: string): string {
  return /^https?:\/\//u.test(advertiseAddr) ? advertiseAddr : `http://${advertiseAddr}`
}

function isSelf(target: NodeTarget): boolean {
  return target.instanceId === config.sandbox.instanceId
}

async function forward(
  target: NodeTarget,
  op: 'self' | 'bootstrap',
  payload: { role: NodeRoleName },
): Promise<unknown> {
  const token = signNodeOpsToken({ iss: config.sandbox.instanceId, aud: target.instanceId, op })
  if (token === undefined) {
    throw new NodeOpsError(
      '未配置 NODE_OPS_SECRET ⇒ 只能管理本机实例（在目标实例上配置同一份密钥后即可跨机运维）',
      'not-configured',
    )
  }
  const url = `${baseUrlOf(target.advertiseAddr)}/internal/node/${op}`
  let response: Response
  try {
    response = await fetch(url, {
      method: op === 'self' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-node-ops-token': token },
      body: op === 'self' ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(op === 'self' ? 15_000 : 15 * 60_000),
    })
  } catch (error) {
    throw new NodeOpsError(
      `连不上实例 ${target.instanceId}（${target.advertiseAddr}）：${error instanceof Error ? error.message : String(error)}`,
      'unreachable',
    )
  }
  const text = await response.text()
  if (!response.ok) {
    throw new NodeOpsError(
      `实例 ${target.instanceId} 拒绝了请求（HTTP ${String(response.status)}）：${text.slice(0, 300)}`,
      'rejected',
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new NodeOpsError(`实例 ${target.instanceId} 的响应不是 JSON`, 'bad-response')
  }
}

/** 按实例自检（本机直跑；远端带签名转发） */
export async function inspectNodeOn(target: NodeTarget, role: NodeRoleName): Promise<NodeReport> {
  if (isSelf(target)) return inspectNode({ role, instanceId: target.instanceId })
  const body = (await forward(target, 'self', { role })) as { data?: NodeReport } | NodeReport
  return 'data' in body && body.data !== undefined ? body.data : (body as NodeReport)
}

/** 按实例自举（本机直跑；远端带签名转发） */
export async function bootstrapNodeOn(target: NodeTarget, role: NodeRoleName): Promise<NodeBootstrapResult> {
  if (isSelf(target)) return bootstrapNode({ role, instanceId: target.instanceId })
  getLogger().info({ target, op: 'bootstrap' }, '节点自举转发到远端实例')
  const body = (await forward(target, 'bootstrap', { role })) as { data?: NodeBootstrapResult } | NodeBootstrapResult
  return 'data' in body && body.data !== undefined ? body.data : (body as NodeBootstrapResult)
}
