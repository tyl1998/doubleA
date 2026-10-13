/**
 * 沙箱代理端点的**共用认证/响应小工具**（P1-9 · P2 从 `sandbox/proxy.ts` 抽出）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §七 6 ①（令牌 ⇒ 会话身份）、`docs/02-后端设计.md` §4.10。
 *
 * ⚠️ **抽出来的理由**：容器 → 后端的代理端点不只有 MCP（P2 起多了工作区读写），而"令牌校验 +
 * `x-sandbox-token` 取头 + 不套信封的错误体"这三件事**必须逐字一致** —— 两处各写一遍，
 * 迟早有一处漏掉"空令牌也算无效"这类边界。客户端只有一个（我们的容器扩展），协议越集中越好。
 */

import type { FastifyReply } from 'fastify'

import { getLogger } from '../infra/logger.js'
import { SANDBOX_TOKEN_HEADER } from './spec.js'
import { resolveSandboxToken, type SandboxTokenRecord } from './token.js'

/**
 * 令牌校验（两件事合成一个结论）：**头在不在** + **Redis 认不认**。
 *
 * ⚠️ 失败路径**不区分**"没带令牌" / "令牌不认" / "已过期"（统一一句 401 文案）：
 * 对攻击者区分它们只会多给一个信息位；对排障，真正的线索在**后端日志**里。
 * ⚠️ Redis 抛错时**向上抛**（→ 500）：那说明"我们查不了"，与"令牌是错的"必须分得开。
 */
export async function authenticateSandboxProxy(
  raw: string | undefined,
): Promise<{ ok: true; record: SandboxTokenRecord } | { ok: false; message: string }> {
  const record = await resolveSandboxToken(raw)
  if (record === undefined) {
    getLogger().warn(
      { hasToken: raw !== undefined && raw.trim() !== '' },
      '沙箱代理端点上收到一个无效令牌 ⇒ 401（分辨"没带"与"带了但不认"只为日志）',
    )
    return { ok: false, message: '沙箱代理令牌无效或已过期。' }
  }
  return { ok: true, record }
}

/** 统一的错误响应（**不套信封**：这一侧客户端只有我们的扩展，见 `proxy.ts` 文件头） */
export function sendSandboxProxyError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } })
}

/**
 * 从请求头里取令牌。
 *
 * ⚠️ `request.headers[...]` 的类型是 `string | string[] | undefined`（同名头出现多次时是数组）
 * ⇒ 归一成"第一个值或 `undefined`"。刻意**不**把数组拼成一个串：那会凭空造出一个永远不认的令牌。
 */
export function sandboxTokenFromHeader(headers: NodeJS.Dict<string | string[]>): string | undefined {
  const raw = headers[SANDBOX_TOKEN_HEADER]
  return Array.isArray(raw) ? raw[0] : raw
}