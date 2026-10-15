/**
 * 沙箱**运行时组件目录 + 组合**（P1-17a）—— 契约层：UI 能勾什么、组合怎么规范化。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2。**2026-10-14 定案（用户）**：
 *   · 运行时 = **语言 + 版本** 的**组件集合**（如 Python 3.10 + Node 22），**不写死成枚举**；
 *   · **不在前端写死"可选运行时"** —— 由后端探测本机镜像得到"已经有哪些"；
 *   · **用户选了本机没有的组合 ⇒ 后端按需 `docker build`**（不再要求运维预先猜组合）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个概念，别混
 * ─────────────────────────────────────────────────────────────────────
 *   · **组件（component）**：一门语言的**一个版本**，id 如 `python310` / `node22` / `go`。
 *     目录 = `SANDBOX_RUNTIME_COMPONENTS`（**有限**：每条都要 `runtime/Dockerfile` 知道怎么装）。
 *   · **变体（variant）**：一个**组件集合**的规范化 id，如 `node22-python310`（按目录顺序排序、`-` 连接；
 *     空集合 = `none`）。它是 **`Conversation.runtime` 的值**、也是镜像 tag 的可读部分。
 *   · **镜像**：`<repo>:<variant>-v<层版本>`，由变体构建而来。
 *
 * ⚠️ **规范化规则是唯一的、且必须与构建侧一致**（`infra/sandbox/versions.mjs` 有一份等价实现）：
 *   排序按 `SANDBOX_RUNTIME_LANGUAGES` 的顺序、同语言按目录出现顺序；`-` 连接。
 *   两处不一致 ⇒ "建出来的 tag"与"选出来的 tag"对不上（症状：明明建了却说没有、反复重建）。
 */

import { z } from 'zod'

/** 支持的语言（顺序 = 变体 id 里组件的排序键；与 `infra/sandbox/versions.mjs` 一致） */
export const SANDBOX_RUNTIME_LANGUAGES = ['node', 'python', 'go', 'java', 'rust'] as const
export type SandboxRuntimeLanguage = (typeof SANDBOX_RUNTIME_LANGUAGES)[number]

/** 目录里的一个组件（语言的一个版本） */
export interface SandboxRuntimeComponent {
  language: SandboxRuntimeLanguage
  /** 语言版本字符串；`default` = 该语言在基础镜像里的默认版本（如 go / rust） */
  version: string
  /** 组件 id（tag 安全、无 `-`）：变体 id 用它拼 */
  id: string
  /** 界面显示名 */
  label: string
}

/**
 * **组件目录**（有限、可预烘焙）—— 决定 UI 能给用户勾什么、`Dockerfile` 要能装什么。
 *
 * ⚠️ 加一条 = 确认 `runtime/Dockerfile` 能装这门语言的这个版本（python 走 `install-python-version.sh`；
 *    go/java/rust 走 apt；node 由 base 提供）。**不需要**预先构建镜像 —— 用户选到就按需构建。
 * ⚠️ node 目前只有 22（= base 镜像自带的版本）：换 node 版本要换 base 镜像，本层不支持。
 */
export const SANDBOX_RUNTIME_COMPONENTS: readonly SandboxRuntimeComponent[] = [
  { language: 'node', version: '22', id: 'node22', label: 'Node.js 22' },
  { language: 'python', version: '3.11', id: 'python311', label: 'Python 3.11' },
  { language: 'python', version: '3.10', id: 'python310', label: 'Python 3.10' },
  { language: 'python', version: '3.8', id: 'python38', label: 'Python 3.8' },
  { language: 'go', version: 'default', id: 'go', label: 'Go' },
  { language: 'java', version: '17', id: 'java17', label: 'Java 17' },
  { language: 'rust', version: 'default', id: 'rust', label: 'Rust' },
]

const COMPONENT_BY_ID: ReadonlyMap<string, SandboxRuntimeComponent> = new Map(
  SANDBOX_RUNTIME_COMPONENTS.map((component) => [component.id, component]),
)

/** 语言在排序里的序号（未知语言排最后） */
function languageOrder(language: string): number {
  const index = SANDBOX_RUNTIME_LANGUAGES.indexOf(language as SandboxRuntimeLanguage)
  return index < 0 ? SANDBOX_RUNTIME_LANGUAGES.length : index
}

/** 空集合的变体 id（= 只有 toolkit，不额外装语言运行时） */
export const SANDBOX_VARIANT_EMPTY = 'none'

/** 基础镜像里已经有的语言版本（选它等于"什么都不装"）——用于给用户提示，不参与构建决策 */
export const SANDBOX_BASE_NODE_VERSION = '22'
export const SANDBOX_BASE_PYTHON_VERSION = '3.11'

/**
 * 组件 id 集合 → **规范变体 id**（按语言顺序排序、`-` 连接；空集合 = `none`）。
 * ⚠️ 未知 id 一律丢弃（不抛）：变体 id 只由目录里的组件构成。
 */
export function sandboxVariantIdFromComponents(ids: readonly string[]): string {
  const known = [...new Set(ids)].filter((id) => COMPONENT_BY_ID.has(id))
  if (known.length === 0) return SANDBOX_VARIANT_EMPTY
  known.sort((a, b) => {
    const ca = COMPONENT_BY_ID.get(a) as SandboxRuntimeComponent
    const cb = COMPONENT_BY_ID.get(b) as SandboxRuntimeComponent
    const byLang = languageOrder(ca.language) - languageOrder(cb.language)
    if (byLang !== 0) return byLang
    return SANDBOX_RUNTIME_COMPONENTS.indexOf(ca) - SANDBOX_RUNTIME_COMPONENTS.indexOf(cb)
  })
  return known.join('-')
}

/** 变体 id → 组件 id 列表（`none` → `[]`；含未知 id ⇒ `undefined`，表示"不是本目录的组合"） */
export function sandboxComponentsFromVariantId(variant: string): string[] | undefined {
  if (variant === SANDBOX_VARIANT_EMPTY || variant === '') return []
  const ids = variant.split('-').filter((piece) => piece !== '')
  return ids.every((id) => COMPONENT_BY_ID.has(id)) ? ids : undefined
}

/** 组件 id 集合 → 给 `runtime/Dockerfile` 的 `COMPONENTS` 串（`lang=ver,…`，按语言顺序） */
export function sandboxComponentsArg(ids: readonly string[]): string {
  const known = [...new Set(ids)].filter((id) => COMPONENT_BY_ID.has(id))
  known.sort((a, b) => {
    const ca = COMPONENT_BY_ID.get(a) as SandboxRuntimeComponent
    const cb = COMPONENT_BY_ID.get(b) as SandboxRuntimeComponent
    return languageOrder(ca.language) - languageOrder(cb.language)
  })
  return known.map((id) => {
    const component = COMPONENT_BY_ID.get(id) as SandboxRuntimeComponent
    return `${component.language}=${component.version}`
  }).join(',')
}

/** 变体 id → 显示名（用组件 label 拼成「Node.js 22 + Python 3.10」；未知回退原串） */
export function sandboxVariantLabel(variant: string): string {
  const ids = sandboxComponentsFromVariantId(variant)
  if (ids === undefined) return variant
  if (ids.length === 0) return '无（仅基础工具）'
  const labels = ids.map((id) => (COMPONENT_BY_ID.get(id) as SandboxRuntimeComponent).label)
  return labels.join(' + ')
}

// ───────────────────────────── 接口契约 ─────────────────────────────

/** 后端探测到的一个**已就绪**运行时（本机已有镜像）—— `GET /api/sandbox/runtimes` 的一项 */
export const sandboxRuntimeSchema = z.object({
  /** 变体 id（= `Conversation.runtime` 的值、镜像 tag 的可读部分） */
  id: z.string(),
  /** 显示名（后端已算好，前端直接用） */
  label: z.string(),
  /** 具体镜像 ref（`<repo>:<id>-v<层版本>`） */
  image: z.string(),
})
export type SandboxRuntimeItem = z.infer<typeof sandboxRuntimeSchema>

/** `GET /api/sandbox/runtimes` 的响应 */
export const listSandboxRuntimesResultSchema = z.object({
  /** 本机**已就绪**的运行时（有镜像才算） */
  runtimes: z.array(sandboxRuntimeSchema),
  /** **组件目录**（UI 据此渲染"可勾选的组件"；勾完的组合若不在 runtimes 里 ⇒ 可按需构建） */
  components: z.array(
    z.object({ id: z.string(), language: z.string(), version: z.string(), label: z.string() }),
  ),
  /** 回退镜像（会话 runtime 找不到对应镜像时用它）；未配置为 `null` */
  fallbackImage: z.string().nullable(),
  /** 后端能否**按需构建**（构建上下文存在 + docker 可用）；`false` 时前端只让选已就绪的 */
  canBuild: z.boolean(),
})
export type ListSandboxRuntimesResult = z.infer<typeof listSandboxRuntimesResultSchema>

/** `POST /api/sandbox/runtimes/build` 的请求体：要构建的**组件 id 集合** */
export const buildSandboxRuntimeBodySchema = z.object({
  components: z
    .array(z.string().min(1).max(64), { required_error: '缺少 components（组件 id 列表）' })
    .min(1, '至少选一个组件')
    .max(8, '组件过多'),
})
export type BuildSandboxRuntimeBody = z.infer<typeof buildSandboxRuntimeBodySchema>

// ───────────────────────────── 按需构建：异步构建任务（P1-17a · 进度/取消）─────────────────────────────
//
// 2026-10-14 用户定案：构建**改成长任务**（不再阻塞在一个 HTTP 请求里）—— 前端轮询状态拿**进度条**，
// 并支持**取消**。三条端点：
//   · `POST /api/sandbox/runtimes/build`            → 启动（或复用已在进行/已就绪的）→ 立刻回 `buildId`
//   · `GET  /api/sandbox/runtimes/build/:buildId`   → 拿当前状态（阶段 / 百分比 / 日志尾 / 结局）
//   · `POST /api/sandbox/runtimes/build/:buildId/cancel` → 取消（杀 docker build 进程）
//
// ⚠️ 阶段（phase）是**粗粒度**的（few 个），百分比只用于进度条观感；两者都**只增不减**。

/** 构建任务状态：待跑/在跑、成功、失败、已取消 */
export const SANDBOX_BUILD_STATUSES = ['running', 'succeeded', 'failed', 'canceled'] as const
export type SandboxBuildStatus = (typeof SANDBOX_BUILD_STATUSES)[number]

/** 构建阶段（比百分比更"人话"，前端显示"正在做什么"）—— 未知阶段回退 `building` */
export const SANDBOX_BUILD_PHASES = [
  'queued',
  'preparing',
  'apt',
  'language',
  'verifying',
  'done',
] as const
export type SandboxBuildPhase = (typeof SANDBOX_BUILD_PHASES)[number]

/** 各阶段的中文显示名（后端算不出"人话"时前端也有兜底，但这里给出统一口径） */
export const SANDBOX_BUILD_PHASE_LABELS: Readonly<Record<SandboxBuildPhase, string>> = {
  queued: '排队中…',
  preparing: '准备构建上下文…',
  apt: '安装系统依赖（apt）…',
  language: '安装语言运行时…',
  verifying: '运行时自检…',
  done: '构建完成',
}

/** `GET /api/sandbox/runtimes/build/:buildId` 的响应（也是启动端点的响应形状） */
export const sandboxBuildJobSchema = z.object({
  /** 任务 id（前端轮询用） */
  buildId: z.string(),
  /** 目标变体 id 与显示名 */
  variant: z.string(),
  label: z.string(),
  status: z.enum(SANDBOX_BUILD_STATUSES),
  /** 当前阶段 */
  phase: z.enum(SANDBOX_BUILD_PHASES),
  /** 阶段显示文案（后端已按当前组件算出，前端直接用） */
  phaseLabel: z.string(),
  /** 进度 0..1（粗粒度；只增不减，仅用于进度条观感） */
  progress: z.number().min(0).max(1),
  /** 构建日志**尾部**（给"查看日志"用；截断，避免几何膨胀） */
  log: z.string(),
  /** 成功后的镜像 ref；未成功为 `null` */
  image: z.string().nullable(),
  /** 失败原因（`status==='failed'` 时非空）；给用户看的、可取 stderr 尾部 */
  error: z.string().nullable(),
  /** 已耗时（毫秒） */
  durationMs: z.number(),
})
export type SandboxBuildJob = z.infer<typeof sandboxBuildJobSchema>

/** `POST /api/sandbox/runtimes/build` 的响应：回带刚落定的任务状态（含 `buildId` 供轮询） */
export const startSandboxBuildResultSchema = sandboxBuildJobSchema
export type StartSandboxBuildResult = z.infer<typeof startSandboxBuildResultSchema>

/**
 * 兼容旧名（`buildSandboxRuntimeResultSchema` / `BuildSandboxRuntimeResult`）——
 * 启动端点现在回的是**任务状态**而非终态；保留别名以免调用点集中改动。
 */
export const buildSandboxRuntimeResultSchema = startSandboxBuildResultSchema
export type BuildSandboxRuntimeResult = StartSandboxBuildResult
