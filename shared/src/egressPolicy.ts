/**
 * 沙箱出网策略契约（egress 黑白名单）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.5（出网平台化 + 实时注入，原为后置演进项）
 *      + `docs/子方案/沙箱与引擎集成.md` §四 3（出口①：容器在 internal bridge 上只可能经 egress 代理出公网）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一条规则：**模式由两张表推导，不单独存**（避免出现不可达 / 自相矛盾的状态）
 * ─────────────────────────────────────────────────────────────────────
 * 平台只有两个可配字段：`allowHosts`（白名单）与 `denyHosts`（黑名单）。`mode` 是它们的**纯推导**：
 *   · 两者都空                  ⇒ `ALLOW_ALL`   （默认全放行 —— Code 模式 git 出网的口径）；
 *   · 只有白名单                ⇒ `WHITELIST`   （只放行白名单；**模型池主机恒并入**，见下）；
 *   · 只有黑名单                ⇒ `BLACKLIST`   （除黑名单外全放行）；
 *   · 黑白都配                  ⇒ `WHITELIST`   （**deny 优先**：命中黑名单即拒，其余看白名单）。
 * ⇒ 不要给 `mode` 单开一个字段存库：那会造出"`mode=ALLOW_ALL` 但白名单非空"这类无法解释的行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 「模型池主机默认注入」发生在**同步层**，不在这份契约里
 * ─────────────────────────────────────────────────────────────────────
 * 无论平台怎么配，**模型池 baseURL 的主机永远放行**（否则 agent 连不上模型）。
 * 这条不写进 `allowHosts`（那是"人配的白名单"），而是在 `egress-up.sh` 写策略文件时**并集注入**
 * —— 所以 `WHITELIST` 模式下生效的放行集 = `allowHosts ∪ 模型池主机`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 规则形状（与 `infra/scripts/egress-proxy.mjs#matchRule` **逐字一致**）
 * ─────────────────────────────────────────────────────────────────────
 * `host` / `host:port` / `*.host`。两处各有一份实现（前端/后端用 TS，代理是零依赖 .mjs 且不引仓内代码）
 * ⇒ 改动一处必须同步另一处（回归脚本 `egress-regression` 钉住 TS 这份的语义）。
 */

import { z } from 'zod'

import { validationMessage } from './i18n/validation.js'

import type { MessageKey } from './i18n/index.js'

/** 单条主机规则上限 / 单表条数上限（防"贴一整份 CN 域名表"） */
export const EGRESS_HOST_MAX = 253
export const EGRESS_POLICY_MAX_HOSTS = 500

/**
 * 出网模式（**推导值**，不是存储字段，见文件头）。
 *   · `ALLOW_ALL` —— 全放行（默认；含"什么都没配"）；
 *   · `WHITELIST` —— 只放行白名单（模型池主机恒并入）；
 *   · `BLACKLIST` —— 除黑名单外全放行。
 */
export const EGRESS_POLICY_MODES = ['ALLOW_ALL', 'WHITELIST', 'BLACKLIST'] as const
export type EgressPolicyMode = (typeof EGRESS_POLICY_MODES)[number]

/**
 * 归一化一条主机规则；不合法返回 `null`（不抛错、不做"最接近的猜测"）。
 *
 * 合法形态：`example.com` / `example.com:443` / `*.example.com`（通配只允许在最左整段）。
 * 拒绝：空串 / 含空白 / 含 `/`（那是 URL 不是主机）/ 通配不在左段（`foo.*.com`）/ 超长。
 */
export function normalizeEgressHostEntry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return null
  // `*` = 显式全放行（等同"两张表都空"；留给"我知道自己在做什么"的显式写法）
  if (trimmed === '*') return '*'
  if (trimmed.length > EGRESS_HOST_MAX) return null
  if (/[\s/\\]/.test(trimmed)) return null
  // 去掉可选端口后校验主机部分
  const match = /^(?<host>\*\.)?(?<base>[a-z0-9.-]+)(?::(?<port>\d{1,5}))?$/.exec(trimmed)
  if (match?.groups === undefined) return null
  const port = match.groups.port
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null
  const base = match.groups.base ?? ''
  if (base === '' || base.startsWith('.') || base.endsWith('.') || base.includes('..')) return null
  return trimmed
}

/** 归一化一组规则：逐条 `normalizeEgressHostEntry`、丢非法、去重（保持输入顺序） */
export function normalizeEgressHostList(raw: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    const normalized = normalizeEgressHostEntry(item)
    if (normalized !== null && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

/** 由两张表推导模式（**纯函数**；见文件头）。`allow` 里出现 `*` 视为全放行 */
export function deriveEgressMode(allowHosts: readonly string[], denyHosts: readonly string[]): EgressPolicyMode {
  if (allowHosts.includes('*')) return 'ALLOW_ALL'
  if (allowHosts.length > 0) return 'WHITELIST'
  if (denyHosts.length > 0) return 'BLACKLIST'
  return 'ALLOW_ALL'
}

/**
 * 一条规则是否命中 `host:port`（**纯函数**；与 `egress-proxy.mjs#matchRule` 语义一致）。
 * `*` 命中一切；`host:port` 只在端口相等时命中；`*.host` 命中 `host` 本身与任意子域。
 */
export function matchEgressRule(rule: string, host: string, port: number): boolean {
  if (rule === '*') return true
  let ruleHost = rule
  let rulePort: number | null = null
  const colon = rule.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(rule.slice(colon + 1))) {
    ruleHost = rule.slice(0, colon)
    rulePort = Number(rule.slice(colon + 1))
  }
  if (rulePort !== null && rulePort !== port) return false
  const h = host.toLowerCase()
  const rh = ruleHost.toLowerCase()
  if (rh.startsWith('*.')) {
    const base = rh.slice(2)
    return h === base || h.endsWith(`.${base}`)
  }
  return h === rh
}

/** 放行判定结论（带**原因**，供审计与前端"为什么被拦"复用） */
export type EgressDecisionReason = 'deny-list' | 'not-in-allow-list' | 'allow-all' | 'in-allow-list' | 'no-deny-match'

export interface EgressDecision {
  allowed: boolean
  reason: EgressDecisionReason
}

/**
 * 判定某个 `host:port` 是否放行（**纯函数**，唯一的策略判据）。
 *
 * 顺序（deny 优先，与代理侧逐字一致）：
 *   ① 命中 `denyHosts` ⇒ 拒（`deny-list`）；
 *   ② 模式 `ALLOW_ALL` / `BLACKLIST` ⇒ 放；
 *   ③ 模式 `WHITELIST` ⇒ 命中 `allowHosts` 才放，否则拒（`not-in-allow-list`）。
 *
 * ⚠️ 调用方传入的 `allowHosts` 应已**并入模型池主机**（同步层做，见文件头）。
 */
export function decideEgress(
  host: string,
  port: number,
  allowHosts: readonly string[],
  denyHosts: readonly string[],
): EgressDecision {
  if (denyHosts.some((rule) => matchEgressRule(rule, host, port))) return { allowed: false, reason: 'deny-list' }
  const mode = deriveEgressMode(allowHosts, denyHosts)
  if (mode !== 'WHITELIST') return { allowed: true, reason: mode === 'ALLOW_ALL' ? 'allow-all' : 'no-deny-match' }
  return allowHosts.some((rule) => matchEgressRule(rule, host, port))
    ? { allowed: true, reason: 'in-allow-list' }
    : { allowed: false, reason: 'not-in-allow-list' }
}

// ═════════════════════════════ 平台出网范围（P1-16a）═════════════════════════
//
// 依据：`docs/子方案/Code模式工作区.md` §五 7.5b。
// ⚠️ **2026-10-14 施工修订（用户定案）**：出网范围**改为平台级**（配在 `/admin/egress` 的出网策略里），
//    **不在会话里配** —— 用户原话"不要在会话配置、在出网策略内配置、默认都是全放行"。
//
// 给平台策略补一个**粗粒度范围**（`egress_policy.scope`）：它决定**基线放行集**，与既有的黑白名单
// **并列补充**（范围给基线，白名单再加零散主机，黑名单永远硬拒）。
//
// ⚠️ 这不是"能力档 / 执行档"：**能否执行由 `codeMode` 决定**（Code 模式即执行模式）。

/**
 * 平台出网范围（`egress_policy.scope`；与 `schema.prisma#enum EgressScope` 逐字一致）。
 *   · `ALL`      —— **默认**：全放行（除黑名单）；
 *   · `NONE`     —— 只放行模型池（+ 白名单里额外配的主机）；
 *   · `REGISTRY` —— 模型池 + 注册表 + git 主机（+ 白名单里额外配的主机）。
 */
export const EGRESS_SCOPES = ['ALL', 'NONE', 'REGISTRY'] as const
export type EgressScope = (typeof EGRESS_SCOPES)[number]

/** 平台出网范围的默认值（`ALL` = 全放行，行为不变） */
export const EGRESS_SCOPE_DEFAULT: EgressScope = 'ALL'

/** 范围的中文名（前端下拉 / 日志复用一处，避免两处各写一份） */
export const EGRESS_SCOPE_LABELS: Record<EgressScope, string> = {
  ALL: '全放行',
  NONE: '仅模型',
  REGISTRY: '模型 + 取包',
}

/** 范围 → i18n key（P1-23；中文那份 {@link EGRESS_SCOPE_LABELS} 保留给日志等中文消费方） */
export const EGRESS_SCOPE_KEY: Record<EgressScope, MessageKey> = {
  ALL: 'label.egressScope.ALL',
  NONE: 'label.egressScope.NONE',
  REGISTRY: 'label.egressScope.REGISTRY',
}

/**
 * 「注册表」范围放行的取包主机（P1-16a 的保守默认；P1-16b 会换成网内镜像）。
 * ⚠️ 清单属 `子方案` §十三 待决 13 ④（注册表清单与是否允许 git 依赖）—— 待拍板前只放"官方公共源"。
 */
export const EGRESS_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  // P1-17a 起的运行时栈：Java 的 Maven Central + Rust 的 crates.io（含稀疏索引与静态下载）
  'repo.maven.apache.org',
  'repo1.maven.org',
  'index.crates.io',
  'static.crates.io',
  'crates.io',
] as const

/** 「注册表」范围同时放行的 **git 主机**（clone / pull 的出网目标；`host` 命中即含其 22/443） */
export const EGRESS_GIT_HOSTS = [
  'github.com',
  '*.github.com',
  'gitlab.com',
  '*.gitlab.com',
  'bitbucket.org',
  '*.bitbucket.org',
] as const

/**
 * 平台出网范围 + 两张表 → **解析后的放行 / 拒绝两张表**（**纯函数**，TS 侧唯一判据）。
 *
 * 解析口径（与 `egress-up.sh#compute_policy` / `egress-proxy.mjs` 同步）：
 *   · `ALL`      ⇒ allow = `['*']`（白名单无意义）；deny = 黑名单；
 *   · `NONE`     ⇒ allow = 模型池 ∪ 白名单；deny = 黑名单；
 *   · `REGISTRY` ⇒ allow = 模型池 ∪ 注册表 ∪ git ∪ 白名单；deny = 黑名单。
 *
 * ⚠️ **空兜底**：`NONE` / `REGISTRY` 而放行集为空 ⇒ `deny=['*']`（拒绝一切）——
 *    否则两张空表会被 `deriveEgressMode` 判成"全放行"，与语义**正好相反**。
 * ⚠️ **模型池主机恒并入** `NONE` / `REGISTRY` 的放行集（"模型默认放行"）：否则容器连模型都调不通。
 */
export function resolveEgressPolicy(input: {
  scope: EgressScope
  allowHosts: readonly string[]
  denyHosts: readonly string[]
  modelHosts: readonly string[]
}): { allow: string[]; deny: string[] } {
  const deny = normalizeEgressHostList(input.denyHosts)
  if (input.scope === 'ALL') return { allow: ['*'], deny }
  const base =
    input.scope === 'REGISTRY'
      ? [...input.modelHosts, ...EGRESS_REGISTRY_HOSTS, ...EGRESS_GIT_HOSTS]
      : [...input.modelHosts]
  const allow = normalizeEgressHostList([...base, ...input.allowHosts])
  return { allow, deny: allow.length === 0 ? ['*'] : deny }
}

// ═════════════════════════════ 请求 / 响应 schema ═════════════════════════════

/** 一组规则字段（请求体用；逐条归一化、去非法、去重、限条数） */
const hostListSchema = z
  .array(z.string(), { invalid_type_error: validationMessage('validation.egressPolicy.hostsNotStringArray') })
  .max(
    EGRESS_POLICY_MAX_HOSTS,
    validationMessage('validation.egressPolicy.hostsTooMany', { max: EGRESS_POLICY_MAX_HOSTS }),
  )
  .transform((items) => normalizeEgressHostList(items))

/**
 * 更新策略（`PUT /api/admin/egress-policy`）—— **整体替换**语义（范围 + 两张表一起交）。
 *
 * ⚠️ 与"合并语义"的凭据刻意相反：策略是**平台级单一事实**，前端拿得到全量 ⇒ 整体替换才对
 * （合并会让"清空黑名单"变成一个必须显式表达的操作，容易漏）。
 * `scope` 可省 ⇒ 默认 `ALL`（老客户端 / 手写请求不传它时行为不变）。
 */
export const updateEgressPolicyBodySchema = z.object({
  scope: z
    .enum(EGRESS_SCOPES, {
      invalid_type_error: validationMessage('validation.egressPolicy.scopeAllowed', {
        allowed: EGRESS_SCOPES.join(' / '),
      }),
    })
    .default(EGRESS_SCOPE_DEFAULT),
  allowHosts: hostListSchema,
  denyHosts: hostListSchema,
})
export type UpdateEgressPolicyBody = z.infer<typeof updateEgressPolicyBodySchema>

/** 策略投影（唯一出口）：范围 + 两张表 + 推导模式 + 更新时间 */
export const egressPolicySchema = z.object({
  /** 平台出网范围（粗粒度基线放行集；默认 `ALL`） */
  scope: z.enum(EGRESS_SCOPES),
  allowHosts: z.array(z.string()),
  denyHosts: z.array(z.string()),
  /**
   * **生效模式**（对"范围解析后的两张表"推导，见 `resolveEgressPolicy` + `deriveEgressMode`）：
   * `ALL` ⇒ `ALLOW_ALL`；`NONE`/`REGISTRY` 有放行项 ⇒ `WHITELIST`，无 ⇒ `BLACKLIST`。前端据此显示"当前模式"。
   */
  mode: z.enum(EGRESS_POLICY_MODES),
  updatedAt: z.string(),
})
export type EgressPolicy = z.infer<typeof egressPolicySchema>
