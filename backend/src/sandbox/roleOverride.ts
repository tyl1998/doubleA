/**
 * 沙箱角色：路由网关 / 业务后端（P1-14 · R1 部署编排）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 1（后端容器硬约束）/ §八 2（每台机器上跑什么）/ §八 3（拓扑）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────────────
 * R1 的部署形态是：**每台机器一个后端实例** + **一个（或 ≥2 副本的）路由网关**，两者用**同一个镜像**、
 * 只换启动命令（`router/main.ts` 文件头早已这么定）。可是"换启动命令"并不足以区分它们：
 *
 *   · `infra/.env` 是**三台共用**的（`shared.env`）⇒ 网关容器也会读到 `SANDBOX_IMAGE` /
 *     `SANDBOX_EGRESS_PROXY_URL` / `WORKSPACE_ROOT` 这些**只对后端有意义**的键；
 *   · 网关若照着配置跑沙箱，会在网关容器里**抢实例名**（`sandbox:instance:{id}`）、
 *     起 reaper（跨机误杀）、起 listener —— 全是**错**的，而且错得很安静（网关"看起来很健康"）。
 *
 * 所以网关进程必须能**显式声明"我不是沙箱宿主"**，把"本进程要不要碰沙箱"的判据收敛到一处。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 判据（刻意的两条，按优先级）
 * ─────────────────────────────────────────────────────────────────────
 *   ① `DOUBULEA_SANDBOX_ROLE=router|backend` 显式声明（compose 里给网关写 `router`）；
 *   ② 未声明时**推断**：本地**能拿到 Docker** 且配置了 `SANDBOX_IMAGE` ⇒ 视为后端宿主，否则视为
 *      "非宿主"（退化为无沙箱）。推断只在"没声明"时用，避免把运维手写的声明覆盖掉。
 *
 * ⚠️ 覆盖是**就地改写配置单例**（`config.sandbox.enabled`），由进程入口在**第一次有人读它之前**调用，
 *    而不是让每个消费方各自再判一次"角色"；消费方仍只按既有的 `enabled` / `image` 口径判断。
 */

import { existsSync } from 'node:fs'

/** `DOUBULEA_SANDBOX_ROLE` 的合法值 */
export const SANDBOX_ROLES = ['backend', 'router'] as const
export type SandboxRole = (typeof SANDBOX_ROLES)[number]

/**
 * 节点**能力档位**（2026-10-19 用户定案）—— 与 {@link SandboxRole} 正交：
 *   · `chatbot`  = 只做对话（不建沙箱、不登记实例、不进实例列表）；部署最轻，不需要 docker/egress/relay；
 *   · `taskAgent` = 承担沙箱宿主（后端角色），可被网关路由沙箱会话。
 *
 * ⚠️ 用**单独的 env**（`DOUBULEA_NODE_ROLE`）而不是塞进 `DOUBULEA_SANDBOX_ROLE`：后者区分的是
 *    "业务后端 / 路由网关"，前者区分的是"这台后端要不要沙箱能力"。两者组合才有意义
 *    （`router` + 任意档位 = 网关；`backend` + `chatbot` = 纯对话后端）。
 */
export const NODE_ROLES = ['chatbot', 'taskAgent'] as const
export type NodeRole = (typeof NODE_ROLES)[number]

/** 读节点档位：未设 / 非法 ⇒ `undefined`（不替用户猜；由调用方按沙箱角色推断） */
export function detectNodeRole(env: NodeJS.ProcessEnv = process.env): NodeRole | undefined {
  const raw = (env.DOUBULEA_NODE_ROLE ?? '').trim()
  if (raw === '') return undefined
  return (NODE_ROLES as readonly string[]).includes(raw) ? (raw as NodeRole) : undefined
}

/** 本进程的沙箱角色（`backend` = 沙箱宿主；`router` = 纯转发进程，不碰本机沙箱） */
export interface SandboxRoleDecision {
  role: SandboxRole
  /** 为什么这么判（写日志用；`explicit` = 显式声明，`inferred` = 推断） */
  source: 'explicit' | 'inferred'
  reason: string
}

/**
 * 推断"本机是否是沙箱宿主"：**能拿到 Docker** 且配置了 `SANDBOX_IMAGE`。
 *
 * ⚠️ 只看"有没有配镜像"不够 —— 网关容器同样会读到共用 env 里的 `SANDBOX_IMAGE`；
 *    而"能不能拿到 docker"才是路线 A 下"这台是不是宿主"的物理判据（后端容器挂了
 *    `/var/run/docker.sock`，网关容器不挂）。两者都成立才认为是宿主。
 *
 * ⚠️ 这与 dockerode 的解析口径**刻意保持一致**（同 `backend/src/sandbox/docker.ts` 的「同一份 env
 *    解析两遍」取舍）：它读 `DOCKER_HOST` / `DOCKER_SOCKET` 这类环境变量，不读我们的 `AppConfig`。
 *
 * @param socketExists 注入"socket 文件是否存在"（回归脚本用：不依赖本机真有 Docker）
 */
export function detectSandboxRole(
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
): SandboxRoleDecision {
  const declared = (env.DOUBULEA_SANDBOX_ROLE ?? '').trim().toLowerCase()
  if (declared === 'backend' || declared === 'router') {
    return { role: declared, source: 'explicit', reason: `DOUBULEA_SANDBOX_ROLE=${declared}` }
  }
  if (declared !== '') {
    return {
      role: 'router',
      source: 'inferred',
      reason: `DOUBULEA_SANDBOX_ROLE 取值无法识别（${declared}）⇒ 按非宿主运行（只允许 backend / router）`,
    }
  }
  const configuredImage = (env.SANDBOX_IMAGE ?? '').trim() !== ''
  const dockerHost = (env.DOCKER_HOST ?? '').trim()
  // dockerode 的 socket 路径来源顺序：DOCKER_SOCKET → 平台默认 `/var/run/docker.sock`
  const socketPath = (env.DOCKER_SOCKET ?? '').trim() || '/var/run/docker.sock'
  const dockerReachable = dockerHost !== '' || socketExists(socketPath)
  if (configuredImage && dockerReachable) {
    return { role: 'backend', source: 'inferred', reason: `配了 SANDBOX_IMAGE 且 Docker 可达（${dockerHost || socketPath}）` }
  }
  return {
    role: 'router',
    source: 'inferred',
    reason: configuredImage
      ? `配了 SANDBOX_IMAGE 但本机拿不到 Docker（${dockerHost || socketPath}）⇒ 按非宿主运行，沙箱路径不可用`
      : '未配 SANDBOX_IMAGE（或未声明角色）⇒ 按非宿主运行，沙箱路径不可用',
  }
}

/** 沙箱角色的**覆盖结果**（`enabled` = 覆盖后是否启用沙箱） */
export interface SandboxRoleOverride {
  decision: SandboxRoleDecision
  /** 显式声明的节点档位（未声明或非法 ⇒ `undefined` = 沿用沙箱角色推断） */
  nodeRole?: NodeRole | undefined
  /** 覆盖前 `config.sandbox.enabled` 的值（写日志：区分"本来就是关的"与"被本模块关掉"） */
  wasEnabled: boolean
  enabled: boolean
}

/**
 * 把角色判据**写进配置对象**（唯一落点）。
 *
 * ⚠️ 只改 `enabled`，不动其它字段：`manager.ts` / `reaper.ts` / `listener.ts` 都先看 `enabled`
 *    （"未配置镜像即跳过沙箱"的既有口径），所以这一次改写就足以让网关进程**不抢实例名、不起
 *    reaper、不起 listener**，而不需要它们各自知道"角色"这个概念。
 *
 * @param sandbox  `config.sandbox`（就地改写 —— 配置对象是单例，与各消费方共享同一个引用）
 */
export function applySandboxRoleOverride(
  sandbox: { enabled: boolean },
  env: NodeJS.ProcessEnv = process.env,
  socketExists?: (path: string) => boolean,
): SandboxRoleOverride {
  const decision = socketExists === undefined ? detectSandboxRole(env) : detectSandboxRole(env, socketExists)
  const nodeRole = detectNodeRole(env)
  const wasEnabled = sandbox.enabled
  // 网关恒不碰沙箱；`chatbot` 档位同样关掉（它不需要 docker.sock / egress / relay）
  if (decision.role === 'router' || nodeRole === 'chatbot') sandbox.enabled = false
  return { decision, nodeRole, wasEnabled, enabled: sandbox.enabled }
}
