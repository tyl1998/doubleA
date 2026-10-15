/**
 * 沙箱出网策略服务（egress 范围 + 黑白名单；平台级单例）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.5（出网平台化）+ §五 7.5b（出网范围，P1-16a）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本服务只做三件事：读单行、写单行、把 `mode` 推导出来
 * ─────────────────────────────────────────────────────────────────────
 *   · **不做实际拦截**：真实执行点在 **egress 代理容器**（容器在 internal bridge 上没有公网路由）。
 *     本服务只维护"平台声明"，由 `egress-up.sh --watch` 轮询落成代理挂载的策略文件。
 *     所以"保存后多久生效" = 同步间隔 + 代理热更新间隔（默认 30s + 5s）。
 *   · **不做权限判定**：路由挂 `requireAdmin`（平台级配置，见 `routes/egressPolicy.ts`）。
 *   · **`scope` 与两张表并列**（P1-16a）：`scope` 决定**基线放行集**（`ALL` 全放行 / `NONE` 仅模型 /
 *     `REGISTRY` 模型+注册表+git），白名单再加零散主机，黑名单永远硬拒。`mode` 是对**范围解析后**
 *     的两张表推导的（见 `resolveEgressPolicy`）—— 于是页面上的"当前模式"反映**生效**状态。
 */

import {
  deriveEgressMode,
  normalizeEgressHostList,
  resolveEgressPolicy,
  type EgressPolicy,
  type UpdateEgressPolicyBody,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'

/** 单例行的固定主键（与迁移里的 seed 一致） */
const EGRESS_POLICY_ID = 'default'

/** 投影用的列（不 select 多余列） */
const POLICY_SELECT = { scope: true, allowHosts: true, denyHosts: true, updatedAt: true } as const

interface PolicyRow {
  scope: 'ALL' | 'NONE' | 'REGISTRY'
  allowHosts: string[]
  denyHosts: string[]
  updatedAt: Date
}

function toPolicy(row: PolicyRow): EgressPolicy {
  // `mode` 是对**范围解析后**的放行/拒绝集推导的（模型池主机不在此投影里：它只影响白名单成员，
  // 不改变"全放行 / 白名单 / 黑名单"这一分类；`ALL`⇒ALLOW_ALL、`NONE`/`REGISTRY`⇒白名单或拒一切）。
  const effective = resolveEgressPolicy({
    scope: row.scope,
    allowHosts: row.allowHosts,
    denyHosts: row.denyHosts,
    modelHosts: [],
  })
  return {
    scope: row.scope,
    allowHosts: row.allowHosts,
    denyHosts: row.denyHosts,
    mode: deriveEgressMode(effective.allow, effective.deny),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 读当前策略（单例，缺失则懒建 —— 正常由迁移 seed 出来，这里只兜"迁移没跑到"的罕见情形）。
 *
 * ⚠️ 读路径**不写库**（同 `ensureWorkspace` 纪律）：`@updatedAt` 会在任何 update 上推进，
 * 若每次读都 upsert，`updated_at` 会被读操作持续刷新，"策略多久没改过"这个读数据就失真了。
 */
export async function getEgressPolicy(): Promise<EgressPolicy> {
  const prisma = getPrisma()
  const existing = await prisma.egressPolicy.findUnique({ where: { id: EGRESS_POLICY_ID }, select: POLICY_SELECT })
  if (existing !== null) return toPolicy(existing)
  const created = await prisma.egressPolicy
    .create({ data: { id: EGRESS_POLICY_ID }, select: POLICY_SELECT })
    .catch(async (error: unknown) => {
      // 并发首次创建：唯一键冲突 ⇒ 回读（"两处同时建"不是错误）
      const raced = await prisma.egressPolicy.findUnique({ where: { id: EGRESS_POLICY_ID }, select: POLICY_SELECT })
      if (raced === null) throw error
      return raced
    })
  return toPolicy(created)
}

/**
 * 整体替换策略（`PUT /api/admin/egress-policy`）：**范围 + 两张表一起交**。
 *
 * ⚠️ **整体替换**语义（见 `shared/egressPolicy.ts` 的说明）：策略是平台级单一事实、前端拿得到全量
 * ⇒ 替换才对；合并会让"清空黑名单"变成一个必须显式表达的操作，容易漏。
 * 两张表都过一次 `normalizeEgressHostList`（去空白/小写/去重/丢非法/限条数）——路由 schema 已归一化，
 * 这里再兜一次是为了"服务层被别处直接调用"时也归一（同一判据不依赖调用方）。
 */
export async function setEgressPolicy(input: UpdateEgressPolicyBody): Promise<EgressPolicy> {
  const scope = input.scope
  const allowHosts = normalizeEgressHostList(input.allowHosts)
  const denyHosts = normalizeEgressHostList(input.denyHosts)
  const row = await getPrisma().egressPolicy.upsert({
    where: { id: EGRESS_POLICY_ID },
    create: { id: EGRESS_POLICY_ID, scope, allowHosts, denyHosts },
    update: { scope, allowHosts, denyHosts },
    select: POLICY_SELECT,
  })
  // 只记范围 / 模式与条数，**不记具体主机**（域名清单可能含内网主机名，不该进日志正文）
  getLogger().info(
    {
      scope,
      mode: deriveEgressMode(allowHosts, denyHosts),
      allowCount: allowHosts.length,
      denyCount: denyHosts.length,
    },
    '沙箱出网策略已更新（egress 代理将在同步间隔内热更新）',
  )
  return toPolicy(row)
}
