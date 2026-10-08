/**
 * per-container 代理令牌（**P0-3-9b**）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §七 3 ②（per-container token）与 §七 6 ①
 *      （**token ⇒ 会话是唯一身份**：`conversationId` / `userId` / `agentId` 全从 token 解析，
 *      请求体里不带、带了也不信）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须有它（没有会怎样）
 * ─────────────────────────────────────────────────────────────────────
 * 沙箱代理 listener（`listener.ts`，出口②）是**内网可达**的一个 HTTP 面：同一个 bridge 里的
 * **任何**容器都能连上它。没有令牌的话，一个沙箱可以拿它自己的会话 id 之外的任何 id 去调
 * `POST /api/sandbox/mcp/call` —— 于是它不只是"能冒充某个会话"，还能顺带**用那个会话发起者的
 * MCP 凭据**（`mcpCall.service.ts#resolveMcpCallContext` 的主语就是 `userId`）。
 * 令牌把"谁能调"从"谁连得上"缩小成"谁拿着这一只容器的那串随机数"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **令牌由本模块生成**（而不是由调用方传入）：与 `createSession` 同一条理由 ——
 *    让凭证只能从这一个地方（CSPRNG）产生，调用方就没有"传个弱令牌进来"的机会。
 * ② **两个方向同写同删**：`sandbox.token:{token}` 与 `sandbox.convToken:{conversationId}`
 *    （为什么是两个键见 `infra/redis.ts` 那一节）。写入点只有 {@link bindSandboxToken} 一个，
 *    删除点只有 {@link revokeSandboxToken} 一个 —— 不给第二处，就不会有一处漏删。
 * ③ **续期在解析时做**（滑动）：`SANDBOX_TOKEN_TTL_SEC` 因此是"最后一次使用的 12 小时后"
 *    而不是"容器建立后的 12 小时"（同 `readSessionUserId` 的口径）。续期失败**只 warn**：
 *    它影响的只是"这个令牌还能活多久"，不该让一次**本来能跑**的 MCP 调用失败。
 *
 * ⚠️ 本模块是**唯一**知道令牌长什么样、存在哪、怎么过期的地方；`proxy.ts` 只调
 *    {@link resolveSandboxToken}，不认识 Redis 键。
 */

import { randomBytes } from 'node:crypto'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import {
  ensureRedisConnected,
  sandboxConversationTokenKey,
  sandboxTokenKey,
  SANDBOX_TOKEN_TTL_SEC,
} from '../infra/redis.js'

/**
 * 一个令牌解析出来的身份 —— **一次沙箱调用的全部权限信息**。
 *
 * ⚠️ 三个字段都从 Redis 值里来，**没有一个来自请求体**（§七 6 ①）。`agentId` 参与两处判据：
 *   ① 工具清单（按 `agentId` 的绑定下发）；② 每次调用的越权检查（"这个 server 真绑在这个 agent 上吗"）。
 */
export interface SandboxTokenRecord {
  conversationId: string
  /** 会话**发起者**（`conversations.user_id`）—— MCP 凭据的主语 */
  userId: string
  agentId: string
}

/**
 * 生一只代理令牌。
 *
 * 长度取 `SANDBOX_TOKEN_LEN`（§二 的 43 = 32 字节 base64url 的字符数，256 bit 熵）。
 * 生成 32 字节再按 `tokenLen` 截断：**先多要一点再截**，于是"把 tokenLen 调大一点"也能真的变长
 * （按 `bytes = tokenLen*3/4` 直接取会在非 4 的倍数上少给一两个字符）。
 */
export function generateSandboxToken(): string {
  const bytes = Math.ceil((config.sandbox.tokenLen * 3) / 4)
  return randomBytes(bytes).toString('base64url').slice(0, config.sandbox.tokenLen)
}

/**
 * 绑定一只令牌（**建容器时调**，见 `manager.ts#createSandbox`）。
 *
 * 返回生成的令牌 —— 调用方把它写进容器的 `SANDBOX_TOKEN` 环境变量
 * （唯一消费方是容器内的桥扩展；它**只认识这一个字符串**，不认识会话 id）。
 *
 * ⚠️ 必须在**容器启动之前**写完：容器一起来 pi 就会加载扩展并拿它去拉工具清单，
 *    晚一步就是一次"清单拉不到"（而扩展那边看起来像"后端不可达"）。
 */
export async function bindSandboxToken(record: SandboxTokenRecord): Promise<string> {
  const token = generateSandboxToken()
  const redis = await ensureRedisConnected()
  const payload = JSON.stringify(record)
  await redis
    .multi()
    .set(sandboxTokenKey(token), payload, 'EX', SANDBOX_TOKEN_TTL_SEC)
    .set(sandboxConversationTokenKey(record.conversationId), token, 'EX', SANDBOX_TOKEN_TTL_SEC)
    .exec()
  getLogger().info(
    { conversationId: record.conversationId, agentId: record.agentId, ttlSec: SANDBOX_TOKEN_TTL_SEC },
    '已为沙箱签发代理令牌（容器 env 里的那一串；值本身不进日志）',
  )
  return token
}

/**
 * 解析一只令牌 → 身份；**不认就返回 `undefined`**（`null` / 空串 / 值坏 / 已过期都走这条路）。
 *
 * ⚠️ 两个刻意的"不区分"：
 *   · **不区分"没这个令牌"与"令牌过期了"**：对调用方（代理端点）两者是同一件事
 *     （401 未授权），而对攻击者区分它们只会多给一个信息位；
 *   · **不区分"值坏了"与"记录不存在"**：都在这里归一成 `undefined`，由调用方回 401。
 *     值坏（人工改过 Redis / 旧格式）会**留下一个不认识的键**直到 TTL 到期 —— 代价可接受，
 *     真想立刻清掉可以在 `redis-cli` 里删（不值得为它写一条自愈路径）。
 */
export async function resolveSandboxToken(raw: string | undefined): Promise<SandboxTokenRecord | undefined> {
  if (raw === undefined) return undefined
  const token = raw.trim()
  if (token === '') return undefined
  // 长度先挡一道：一个几 KB 的"令牌"不该变成一次 Redis 大键查询
  if (token.length > config.sandbox.tokenLen * 2) return undefined

  const redis = await ensureRedisConnected()
  // ⚠️ 这里**不接住异常**（不吞成 `undefined`，也就不写 try/catch）：Redis 挂了时
  // "令牌无效"（401）与"我们查不了"（500）必须分得开 —— 吞掉会让容器以为自己的令牌是错的，
  // 而它会照常报一条"代理拒绝了我"，把基础设施故障伪装成一个配置问题。
  const payload = await redis.get(sandboxTokenKey(token))
  const record = parseTokenRecord(payload)
  if (record === undefined) return undefined

  // 滑动续期（口径 ③）：失败只 warn，本次照常放行。
  // ⚠️ 日志里**只有方向、没有键名** —— 键名里就带着令牌本身（`sandbox.token:{token}`）。
  await Promise.all([
    renew(redis, sandboxTokenKey(token), 'token'),
    renew(redis, sandboxConversationTokenKey(record.conversationId), 'conv'),
  ])
  return record
}

/**
 * 撤销某个会话的令牌（**回收时调**，见 `manager.ts#recycleSandbox`）。
 *
 * 幂等：没有记录 / 已经删过 / Redis 挂了都只是 warn。⚠️ **不能抛**：调用点在回收路径上，
 * 那里已经有一堆"清理失败也只 warn"的兄弟（容器、卷、账本行），令牌不该成为唯一一个
 * 会把"回收"变成"抛出"的东西 —— 残留那份由 TTL 兜底。
 */
export async function revokeSandboxToken(conversationId: string): Promise<boolean> {
  try {
    const redis = await ensureRedisConnected()
    const indexKey = sandboxConversationTokenKey(conversationId)
    const token = await redis.get(indexKey)
    // 两个 `del` 各自返回"删掉了几个键"（删一个不存在的键返回 0，幂等）
    const removedIndex = await redis.del(indexKey)
    const removedToken = token === null ? 0 : await redis.del(sandboxTokenKey(token))
    const removed = removedIndex + removedToken
    if (removed > 0) getLogger().debug({ conversationId }, '沙箱代理令牌已撤销')
    return removed > 0
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '撤销沙箱代理令牌失败（TTL 会兜底）')
    return false
  }
}

// ───────────────────────────── 内部小工具 ─────────────────────────────

/** 值 → 记录；**读不出来一律 `undefined`**（同 `parseSessionRecord` 的口径） */
function parseTokenRecord(payload: string | null): SandboxTokenRecord | undefined {
  if (payload === null) return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const { conversationId, userId, agentId } = parsed as Partial<SandboxTokenRecord>
    if (typeof conversationId !== 'string' || conversationId === '') return undefined
    if (typeof userId !== 'string' || userId === '') return undefined
    if (typeof agentId !== 'string' || agentId === '') return undefined
    return { conversationId, userId, agentId }
  } catch {
    return undefined
  }
}

/** 续期一个存在的键（`EXPIRE` 对不存在的键返回 0，无害） */
async function renew(
  redis: Awaited<ReturnType<typeof ensureRedisConnected>>,
  key: string,
  direction: string,
): Promise<void> {
  try {
    await redis.expire(key, SANDBOX_TOKEN_TTL_SEC)
  } catch (error) {
    getLogger().warn({ err: error, direction }, '沙箱代理令牌续期失败（本次照常放行）')
  }
}
