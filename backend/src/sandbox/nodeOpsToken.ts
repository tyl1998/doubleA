/**
 * **跨实例节点运维**的签名（P1-14 部署优化；2026-10-19 用户定案）。
 *
 * 场景：管理员在 A 的前端上点“初始化实例 b”。自举必须驱动**b 本机**的 Docker，A 做不到 ⇒
 * A 以管理员身份**代发**一次到 b 的内部端点。为此需要一个 A、b 都认的凭据。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 设计
 * ─────────────────────────────────────────────────────────────────────
 *   · 密钥 = `NODE_OPS_SECRET`（三台**同一份**，与 `CREDENTIAL_MASTER_KEY` 同一处理：不进日志、不进 git）。
 *     未配置 ⇒ 跨实例运维**显式关闭**（只能管本机），而不是用弱密钥凑合。
 *   · 令牌 = base64url(payload) + '.' + base64url(HMAC-SHA256(payload))，payload 含：
 *     `{ iss: 发起方实例, aud: 目标实例, op: 操作, exp: 过期 epoch 秒, nonce: 随机串 }`。
 *   · **一次性**：目标实例把 nonce 写进 Redis（`SET NX EX`），重复使用即拒（重放防护）。
 *   · **最短有效期**：60s（只用于一次 HTTP 转发；不需要长寿命）。
 *   · 校验顺序：结构 → 签名（时间安全比较）→ `aud` 等于本实例 → 未过期 → nonce 未用过。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { ensureRedisConnected } from '../infra/redis.js'

/** 令牌有效期（秒）：只够一次转发 */
export const NODE_OPS_TOKEN_TTL_SEC = 60

/** nonce 的 Redis 键前缀（TTL = 2× 令牌有效期，过期后无需再记） */
const NONCE_KEY_PREFIX = 'sandbox:node-ops:nonce'

export interface NodeOpsPayload {
  /** 发起方实例 id */
  iss: string
  /** 目标实例 id */
  aud: string
  /** 操作名（`self` / `bootstrap` / `buildToolkit` / …） */
  op: string
  /** 过期时刻（epoch 秒） */
  exp: number
  /** 一次性随机串 */
  nonce: string
}

/** 读密钥（未配置 ⇒ `undefined`：调用方据此关闭跨实例能力） */
export function nodeOpsSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.NODE_OPS_SECRET ?? '').trim()
  return raw === '' ? undefined : raw
}

function sign(payloadBase64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadBase64).digest('base64url')
}

/** 签发令牌（`undefined` = 未配置密钥） */
export function signNodeOpsToken(
  payload: Omit<NodeOpsPayload, 'exp' | 'nonce'> & { exp?: number; nonce?: string },
  options: { secret?: string | undefined; now?: number } = {},
): string | undefined {
  const secret = options.secret ?? nodeOpsSecret()
  if (secret === undefined) return undefined
  const now = options.now ?? Date.now()
  const full: NodeOpsPayload = {
    iss: payload.iss,
    aud: payload.aud,
    op: payload.op,
    exp: payload.exp ?? Math.floor(now / 1000) + NODE_OPS_TOKEN_TTL_SEC,
    nonce: payload.nonce ?? randomBytes(16).toString('base64url'),
  }
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/** 校验结论 */
export type NodeOpsVerify =
  | { ok: true; payload: NodeOpsPayload }
  | { ok: false; reason: 'disabled' | 'malformed' | 'bad-signature' | 'wrong-audience' | 'expired' }

/**
 * 校验令牌（**不含 nonce 一次性判定** —— 那一步要碰 Redis，由 {@link consumeNodeOpsNonce} 做）。
 *
 * ⚠️ 签名比较用 `timingSafeEqual`（长度不等直接拒，不泄露长度信息以外的差异）。
 */
export function verifyNodeOpsToken(
  token: string,
  expectedAudience: string,
  options: { secret?: string | undefined; now?: number } = {},
): NodeOpsVerify {
  const secret = options.secret ?? nodeOpsSecret()
  if (secret === undefined) return { ok: false, reason: 'disabled' }
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [body, signature] = parts as [string, string]
  const expected = sign(body, secret)
  const given = Buffer.from(signature, 'utf8')
  const want = Buffer.from(expected, 'utf8')
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'bad-signature' }
  let payload: NodeOpsPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as NodeOpsPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof payload.aud !== 'string' || payload.aud !== expectedAudience) {
    return { ok: false, reason: 'wrong-audience' }
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' }
  return { ok: true, payload }
}

/**
 * nonce 一次性消费（`SET NX EX`）。`false` = 已被用过（重放）。
 *
 * ⚠️ Redis 不可达时**拒绝**（fail closed）：这是"谁能替别人执行自举"的闸门，宁可这几次点不动作。
 */
export async function consumeNodeOpsNonce(payload: NodeOpsPayload): Promise<boolean> {
  const redis = await ensureRedisConnected()
  const key = `${NONCE_KEY_PREFIX}:${payload.nonce}`
  const written = await redis.set(key, payload.iss, 'EX', NODE_OPS_TOKEN_TTL_SEC * 2, 'NX')
  return written !== null
}
