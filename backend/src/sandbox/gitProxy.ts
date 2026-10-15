/**
 * 沙箱 git 凭据代理端点（`POST /api/sandbox/git/credential`）—— **按需拉取**（P1-9 · R11 修订）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.4 / §7.5、`docs/子方案/沙箱与引擎集成.md` §七 6 ①。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一句话：**凭据不进容器**，容器里的 git helper 用时才回调本端点取
 * ═══════════════════════════════════════════════════════════════════════
 * ```
 * 容器里的 git（credential helper / SSH 包装器，/opt/sandbox-git/*.mjs）
 *   → POST {SANDBOX_BACKEND_URL}/api/sandbox/git/credential   （头：x-sandbox-token）
 *   → 本文件：① 校验令牌 → {conversationId,userId,agentId}
 *             ② 解密该 userId 的 git 凭据（唯一明文出口 decryptUserGitCredentials）
 *             ③ 按 (protocol, host) 挑一条 → 回 {kind:'https'|'ssh', …}
 *   → helper 把凭据交给 git / ssh
 * ```
 * ★ 与 MCP / 工作区代理**同一个通道与同一套认证**（`proxyAuth.ts`）：令牌即会话身份，
 *   请求体里的任何身份字段都不信 —— 凭据的主语恒为**令牌解析出的会话发起者**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三条口径
 * ═══════════════════════════════════════════════════════════════════════
 * ① **不套统一信封**（与 `proxy.ts` 同）：这一侧唯一客户端是我们的 helper 脚本，
 *    `{error:{code,message}}` 比两层信封更好写；
 * ② **没配凭据 = 404**（不是 200 空体）：helper 据此**安静地不输出**、让 git 走自己的失败路径，
 *    而不是"回了个空用户名密码"被 git 当成一次真正的认证尝试（那会把上游锁号）；
 * ③ **响应里只有这一条凭据的明文**（HTTPS 的 username/password 或 SSH 的私钥），
 *    **绝不记进日志**（只记 `kind` 与条数）。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { getLogger } from '../infra/logger.js'
import { decryptUserGitCredentials } from '../services/gitCredential.service.js'
import { isRunPhase } from './credentialPhase.js'
import { selectGitCredential } from './gitCredential.js'
import { authenticateSandboxProxy, sandboxTokenFromHeader, sendSandboxProxyError } from './proxyAuth.js'
import { SANDBOX_GIT_CREDENTIAL_PATH } from './spec.js'

/** 请求体：git 传来的 `protocol` + 可选 `host`（`host` 仅 HTTPS 用；SSH 交给包装器统一处理） */
const gitCredentialBodySchema = z.object({
  protocol: z.enum(['https', 'ssh']),
  host: z.string().trim().max(255).nullish(),
})

export function registerSandboxGitRoutes(app: FastifyInstance): void {
  app.post(SANDBOX_GIT_CREDENTIAL_PATH, async (request, reply) => {
    const auth = await authenticateSandboxProxy(sandboxTokenFromHeader(request.headers))
    if (!auth.ok) return sendSandboxProxyError(reply, 401, 'UNAUTHORIZED', auth.message)

    const parsed = gitCredentialBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return sendSandboxProxyError(reply, 400, 'VALIDATION', '请求体不合法：需要 { protocol: "https" | "ssh" }')
    }
    const { protocol } = parsed.data
    const host = parsed.data.host ?? null

    // ★ P1-17c（凭据隔离 · 分相）：本会话一旦执行过"装依赖 / 跑项目"命令，就不再向这只容器发凭据
    //   —— 防的是"依赖的 postinstall / 项目脚本回调本端点取密钥并外带"（§五之二 4）。
    //   ⚠️ 403 而不是 404：helper 对非 404 一律**安静退出**（git 走自己的失败路径），与"没有匹配
    //      凭据"区分开是为了后端排障能看出"这是被分相闸门挡的"。
    if (await isRunPhase(auth.record.conversationId)) {
      getLogger().warn(
        { conversationId: auth.record.conversationId, protocol, hasHost: host !== null },
        '沙箱取 git 凭据被拒：会话已在 run 相（P1-17c 分相，跑不可信代码时不给凭据）',
      )
      return sendSandboxProxyError(
        reply,
        403,
        'CREDENTIAL_ISOLATED',
        '本会话已进入执行相（跑过装依赖/项目命令），不再提供 git 凭据。',
      )
    }

    // 唯一一次"解密成明文"——主语是令牌解析出的会话发起者，请求体里没有身份字段
    const creds = await decryptUserGitCredentials(auth.record.userId)
    const resolution = selectGitCredential(creds, protocol, host)
    if (resolution === null) {
      getLogger().info(
        { conversationId: auth.record.conversationId, protocol, hasHost: host !== null },
        '沙箱按需取 git 凭据：该用户没有匹配的凭据 ⇒ 404（helper 将安静退出）',
      )
      return sendSandboxProxyError(reply, 404, 'NO_CREDENTIAL', '该用户没有可用于本次 git 操作的凭据。')
    }

    // ⚠️ 只记 kind 与条数，**绝不记明文**
    getLogger().info(
      {
        conversationId: auth.record.conversationId,
        protocol,
        hasHost: host !== null,
        kind: resolution.kind,
        sshKeyCount: resolution.kind === 'ssh' ? resolution.keys.length : 0,
      },
      '沙箱按需取回 git 凭据',
    )
    return reply.send(resolution)
  })
}
