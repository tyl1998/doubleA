/**
 * 沙箱实例注册表的**读出口契约**（P1-14 · R2① 自动发现 / R3 负载 / R5 后台可观测）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 4（实例发现）、§九·补 2.1（负载进注册表）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这一份（而不是让前端读网关的 `/health`）
 * ─────────────────────────────────────────────────────────────────────
 * `sandbox:instance:*` 原本只有**网关**读（自动发现）。要在后台页面上看见"现在有哪些实例注册"，
 * 有两条路：
 *   · 让浏览器直接打网关 `/health` —— 那会把网关的运维契约（`upstreams` / `cooling` / 发现内部状态）
 *     暴露给前端，且开发期 Vite 只代理 `/api`（本地根本打不到）；
 *   · **业务后端开一个只读端点**（本文件），复用网关**同一套**解析契约 —— 判据只有一处。
 *
 * ⚠️ 这是**只读视图**：心跳写入仍只由 `sandbox/owner.ts` 负责（同 `token.ts` 的纪律）。
 * ⚠️ 注册键消失 = 实例下线（TTL = 3× 心跳）；本契约只做形状与推导，不判"应不应该在线"。
 */

import { z } from 'zod'

/** `GET /api/admin/sandbox/instances` 的一条（一台实例的注册值 + 推导状态） */
export const sandboxInstanceItemSchema = z.object({
  instanceId: z.string().min(1),
  /** 网关回连本实例的 `host:port` */
  advertiseAddr: z.string().min(1),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  /** 最近一次心跳 / 抢注的时刻（epoch ms）—— ⚠️ 心跳每次续期都会刷新它 */
  startedAt: z.number().int().positive(),
  /** 是否有负载快照（心跳关掉 / 老版本注册值 / 采样失败 ⇒ `null`） */
  load: z
    .object({
      slotsUsed: z.number().int().nonnegative(),
      slotsTotal: z.number().int().nonnegative(),
      queueDepth: z.number().int().nonnegative(),
      chatbotInFlight: z.number().int().nonnegative(),
      sampledAt: z.number().int().positive(),
    })
    .nullable(),
  /**
   * 该实例**已就绪的沙箱运行时**（变体 id；P1-17a × P1-14）。
   * `null` = 老版本注册值 / 该实例没报（**未知**，不是"没有"）；`[]` = 明确没有额外运行时。
   */
  runtimes: z.array(z.string()).nullable(),
  /** 该实例能否按需构建运行时；`null` = 未上报（未知） */
  canBuild: z.boolean().nullable(),
  /**
   * 节点**自检结论**（P1-14 部署优化）：`null` = 该实例没上报（老版本 / 非 taskAgent 档位）。
   * `ready=false` ⇒ 可见但**不可选**（`GET /api/sandbox/runtimes` 会把它排除在选择之外）。
   */
  readiness: z
    .object({
      ready: z.boolean(),
      hostPlatform: z.string(),
      needsRelay: z.boolean(),
      /** 未就绪的必需项（页面据此显示"缺什么"） */
      missing: z.array(z.string()),
    })
    .nullable(),
})

/** 读出口响应的 `data` */
export const sandboxInstancesResultSchema = z.object({
  /** 候选上游表 = 静态 `ROUTER_UPSTREAMS` 种子 ∪ 发现的实例（与网关 `mergeUpstreams` 同口径） */
  upstreams: z.array(z.string()),
  /** 自动发现到的地址（不在静态种子里） */
  discovered: z.array(z.string()),
  /** 本进程**能读出**的实例注册项（按 `instanceId` 升序；坏值不计入） */
  items: z.array(sandboxInstanceItemSchema),
  /** 本进程的角色（`router` = 网关进程、不跑业务端点；`backend` = 沙箱宿主） */
  role: z.enum(['backend', 'router']),
  /** 本实例自己的 id（网关进程为 `null`：它不登记） */
  selfInstanceId: z.string().nullable(),
  /** 负载新鲜度阈值（毫秒）：超过即视为过期（`2 × 心跳`，与网关 `ROUTER_LOAD_STALE_MS` 同式） */
  loadStaleMs: z.number().int().positive(),
  /** 读注册表失败的原因（Redis 抖动等）；非 `null` 时 `items` 为空、`upstreams` 退回静态种子 */
  error: z.string().nullable(),
})

export type SandboxInstanceItem = z.infer<typeof sandboxInstanceItemSchema>
export type SandboxInstancesResult = z.infer<typeof sandboxInstancesResultSchema>
