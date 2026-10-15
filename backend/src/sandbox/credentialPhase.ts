/**
 * 沙箱**执行相 / 凭据隔离**（P1-17c）—— "跑不可信代码时不给凭据"的唯一判据与开关。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 4（凭据隔离：**默认取 a 分相 + b 只读**，
 *      §十三 已决 10）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它解的是什么（§五之二 4 原文的风险）
 * ═══════════════════════════════════════════════════════════════════════
 * 一旦允许 "装依赖 + 跑项目代码"，依赖的 `postinstall` / 项目脚本**会执行**，而 git 凭据 helper
 * 在**同一容器里** ⇒ 恶意脚本可回调 `POST /api/sandbox/git/credential` 取密钥并外带。
 * 分相 = `clone`（要凭据）与 `run`（跑不可信代码）**分开**；跑代码时后端**拒绝**该会话的凭据请求。
 *
 * ⚠️ **本文件的实现把"分相"落在后端闸门上**（而不是"两个容器"）：一个会话仍只有一个容器，
 *    但**一旦本会话执行过"装依赖 / 跑项目"命令**（纯判据 {@link isExecutionCommand}），
 *    就把它钉进 `run` 相（Redis，带 TTL 兜底）⇒ 之后的 `POST /api/sandbox/git/credential`
 *    一律 4xx（`sandbox/gitProxy.ts` 消费本判据），helper 拿不到凭据、安静退出。
 *    ⚠️ 语义是**单向**的（clone → run）：这是"先 clone、后跑"这条常见路径的正确取舍；
 *       "跑完再要 clone"要另起一个**无代码执行**的容器（§五之二 4 的"两个容器"是它的完整形态，
 *       属后续演进 —— 现状用"一个容器 + 单向翻转"覆盖主要风险）。
 *
 * ⚠️ 判据**只增不减**风险面：{@link isExecutionCommand} 是**保守启发式**（宁可多判几次，
 *    让凭据更早被收走），误判的代价是"这一轮之后 git 拉不动了"，可用新会话/新容器恢复。
 */

import { getLogger } from '../infra/logger.js'
import { getRedis } from '../infra/redis.js'

/** 一个会话的**执行相**：`clone`（可以取凭据）/ `run`（跑不可信代码，拒绝凭据） */
export const SANDBOX_CREDENTIAL_PHASES = ['CLONE', 'RUN'] as const
export type SandboxCredentialPhase = (typeof SANDBOX_CREDENTIAL_PHASES)[number]

/**
 * 执行相键名。**会话级、运行时**（不落库，同 `chat.autoapprove`）：它只影响"这一只容器还配不配拿
 * 凭据"，不需要跨实例一致（容器本身已是本实例的）。
 */
export function sandboxCredentialPhaseKey(conversationId: string): string {
  return `sandbox:credphase:${conversationId}`
}

/**
 * 相键 TTL（秒）—— 兜底：主机制是**显式清除**（新容器 / 删会话时删键），TTL 只为"被遗忘的 run 相"
 * 不永久留存。取 12 小时（与 `CHAT_AUTO_APPROVE_TTL_SEC` 同量级、同一条推理）。
 */
export const SANDBOX_CREDENTIAL_PHASE_TTL_SEC = 12 * 3600

/**
 * **纯判据**：这条 `bash` 命令是不是"装依赖 / 跑项目"（⇒ 该进入 `run` 相）。
 *
 * 覆盖 P1-17a 运行时的各栈：npm/pnpm/yarn/bun、pip/poetry/uv、go、maven/gradle、cargo、make。
 * 口径**保守**（宁可多命中）：命令里出现这些子串之一即算。不匹配 `git`（clone/fetch 要凭据）。
 *
 * ⚠️ 只看命令文本、不做 shell 解析：`bash` 工具能跑任意命令，"解析"是做不到的；这里是**尽力而为
 *    的降险**（把明显是"装/跑"的命令识别出来），不是一堵密不透风的墙（§五之二 4 的 c 审计是兜底）。
 */
export function isExecutionCommand(command: string): boolean {
  const text = command.toLowerCase()
  // ⚠️ 逐个写、别合并成一条大正则：可读 + 每条都能对着"它为什么是该栈的装/跑动作"解释。
  const patterns: readonly RegExp[] = [
    // 包管理器装依赖
    /\bnpm\s+(ci|i|install|test|run)\b/u,
    /\bpnpm\s+(i|install|test|run|exec)\b/u,
    /\byarn(\s|$)/u,
    /\bbun\s+(install|run|test)\b/u,
    // python
    /\bpip3?\s+install\b/u,
    /-m\s+pip\s+install\b/u,
    /\bpoetry\s+install\b/u,
    /\buv\s+(pip|sync|run)\b/u,
    // go
    /\bgo\s+(build|test|run|generate|mod)\b/u,
    // java
    /\b(mvn|mvnw|gradle|gradlew)\b/u,
    // rust
    /\bcargo\s+(build|run|test|check|install)\b/u,
    // 通用构建
    /\bmake(\s|$)/u,
  ]
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * 从一条工具记录里取出"这条命令"（**纯函数**；`kind=SANDBOX` 的 `bash` 工具）。
 *
 * 只有 `bash` 有命令；`arguments` 是模型给的 **JSON 原样字符串**（可能不是合法 JSON）⇒ 解析失败
 * 一律返回 `undefined`（**不抛**：判据只用于"多收紧一点"，坏载荷不该打断本轮编排）。
 */
export function executionCommandOf(toolName: string, argumentsJson: string | undefined): string | undefined {
  if (toolName !== 'bash' || argumentsJson === undefined || argumentsJson === '') return undefined
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { command?: unknown }).command === 'string') {
      return (parsed as { command: string }).command
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 把会话钉进 `run` 相（幂等）。失败只 warn —— 它是"额外收紧"，不该让它盖掉真正的编排错误。 */
export async function enterRunPhase(conversationId: string): Promise<void> {
  try {
    await getRedis().set(
      sandboxCredentialPhaseKey(conversationId),
      'RUN',
      'EX',
      SANDBOX_CREDENTIAL_PHASE_TTL_SEC,
    )
    getLogger().info(
      { conversationId, phase: 'RUN' },
      '会话进入 run 相（检测到装依赖/跑项目命令）⇒ 之后拒绝本会话的 git 凭据请求（P1-17c 分相）',
    )
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '写入 run 相失败（已忽略：下次派活仍会重试）')
  }
}

/** 这个会话是不是已在 `run` 相（读不到/键缺失都当 `CLONE`）。⚠️ Redis 抛错时**向上抛**（与令牌校验同口径）。 */
export async function isRunPhase(conversationId: string): Promise<boolean> {
  return (await getRedis().get(sandboxCredentialPhaseKey(conversationId))) === 'RUN'
}

/** 清除相键（新容器 / 删会话时调）—— 新容器从 `CLONE` 相开始。失败只 warn。 */
export async function clearCredentialPhase(conversationId: string): Promise<void> {
  try {
    await getRedis().del(sandboxCredentialPhaseKey(conversationId))
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '清除执行相失败（已忽略：TTL 会兜底）')
  }
}
