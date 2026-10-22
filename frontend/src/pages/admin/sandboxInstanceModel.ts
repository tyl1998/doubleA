/**
 * 沙箱实例页的**零依赖纯逻辑**（P1-14 · R5）
 *
 * 依据：`shared/src/sandboxInstance.ts`（契约）、`docs/子方案/沙箱多机部署.md` §八 4 / §九·补。
 *
 * 只有两类东西：**负载展示口径**（占用率 / 队深 / 在飞 / 年龄）与**状态推导**（活 / 负载过期）。
 * 不 import `antd` / `react` / `api` ⇒ 能进无依赖验收档逐条断言。
 *
 * ⚠️ 「过期」有两个**不同**的口径，页面要分开显示，不能合成一个红点：
 *   · **注册项过期**（`startedAt` 超过 `3× 心跳`）：实例心跳停了 ⇒ 网关会等 TTL 才摘除；
 *     后端只给了 `startedAt`，TTL 由调用方传（`registrationTtlMs`），缺省按 `3× loadStaleMs/2` 推。
 *   · **负载过期**（`load.sampledAt` 超过 `loadStaleMs` = `2× 心跳`）：实例在线，但这份负载不能拿来比较。
 */

import type { SandboxInstanceItem } from '@doubulea/shared'

/** 实例的展示状态（`online` = 注册新鲜且负载新鲜；`load-stale` = 在线但负载不可用；`stale` = 注册快过期） */
export type SandboxInstanceState = 'online' | 'load-stale' | 'stale'

export interface SandboxInstanceView {
  state: SandboxInstanceState
  /** 负载年龄（毫秒）；无负载为 `null` */
  loadAgeMs: number | null
  /** 沙箱占用率（`slotsUsed / slotsTotal`）；无负载 / 上限为 0 时为 `null` */
  slotRatio: number | null
}

/**
 * 推导一条实例的展示状态。
 *
 * @param registrationTtlMs 注册项 TTL（缺省 `3 × 心跳`；页面传 `loadStaleMs * 1.5` ⇒ 等价于 3× 心跳）
 */
export function sandboxInstanceState(
  item: SandboxInstanceItem,
  options: { now: number; loadStaleMs: number; registrationTtlMs?: number },
): SandboxInstanceView {
  const loadAgeMs = item.load === null ? null : Math.max(0, options.now - item.load.sampledAt)
  const slotRatio =
    item.load === null || item.load.slotsTotal <= 0 ? null : item.load.slotsUsed / item.load.slotsTotal
  const ttl = options.registrationTtlMs ?? options.loadStaleMs * 1.5
  if (options.now - item.startedAt > ttl) return { state: 'stale', loadAgeMs, slotRatio }
  if (loadAgeMs !== null && loadAgeMs > options.loadStaleMs) return { state: 'load-stale', loadAgeMs, slotRatio }
  return { state: 'online', loadAgeMs, slotRatio }
}

export const SANDBOX_INSTANCE_STATE_LABELS: Readonly<Record<SandboxInstanceState, string>> = {
  online: '在线',
  'load-stale': '负载过期',
  stale: '心跳超时',
}

/**
 * 摘流按钮该显示什么（2026-10-21）：**只挡新会话**，已钉在它上面的会话照常接。
 *
 * 抽成纯函数是为了让「按钮文案 / 确认框文案 / 后果说明」三处永远一致 —— 这三处在三个组件里，
 * 各写一遍就会出现"按钮说恢复、弹窗还说摘流"这类只靠肉眼才能发现的错。
 */
export function drainActionView(item: SandboxInstanceItem): {
  /** `true` = 当前已摘流（按钮应该是「恢复接收」） */
  drained: boolean
  /** 按钮文案 */
  actionLabel: string
  /** 确认框标题 */
  confirmTitle: string
  /** 确认框正文（说清"会发生什么、不会发生什么"） */
  confirmBody: string
} {
  if (item.drained) {
    return {
      drained: true,
      actionLabel: '恢复接收',
      confirmTitle: `让实例 ${item.instanceId} 重新接收新会话？`,
      confirmBody:
        '恢复后网关会重新把它列入新会话的候选（按负载 P2C 挑选）。它名下的已有会话不受影响。生效时间：本机立即，其它机器 ≤ 3× 心跳。',
    }
  }
  return {
    drained: false,
    actionLabel: '摘流',
    confirmTitle: `把实例 ${item.instanceId} 从新会话里摘掉？`,
    confirmBody:
      '摘流后网关不再把**新会话**派给它（例如你要手工换镜像、腾空这台机器）。' +
      '已钉在这台上的会话（容器与工作区都在它本地盘）**仍会继续服务**，不会掉线；' +
      '这台机器也不会下线（注册键继续续期）。生效时间：本机立即，其它机器 ≤ 3× 心跳。',
  }
}

/** 占用率的展示文案（`3/10 · 30%`）；没有负载时说"未知"而不是 `0%` */
export function slotRatioText(item: SandboxInstanceItem): string {
  if (item.load === null) return '未知'
  const total = item.load.slotsTotal
  if (total <= 0) return `${item.load.slotsUsed}/0`
  return `${item.load.slotsUsed}/${total} · ${Math.round((item.load.slotsUsed / total) * 100)}%`
}

/** 负载年龄（"3s 前"式短文案）；没有负载返回 `—` */
export function loadAgeText(ageMs: number | null): string {
  if (ageMs === null) return '—'
  const seconds = Math.round(ageMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/** 心跳时刻（本地时间；`startedAt` 是最近一次续期，不是进程启动时刻） */
export function heartbeatText(item: SandboxInstanceItem): string {
  return new Date(item.startedAt).toLocaleTimeString()
}
