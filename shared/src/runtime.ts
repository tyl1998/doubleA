/**
 * 沙箱**运行时：语言 + 版本**（P1-17a）—— 契约层：UI 能勾哪些语言、版本怎么规范化成变体 id。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2。演进：
 *   · 2026-10-14：运行时 = 组件（语言+版本）的集合，组件来自**有限目录** `SANDBOX_RUNTIME_COMPONENTS`；
 *   · **2026-10-15（用户定案）：不再枚举版本** —— UI 只列**语言**，勾选语言后在输入框里**填版本号**；
 *     后端按 `语言=版本` 组合按需 `docker build`（各语言的任意版本由 `runtime/install-*.sh` 负责装）。
 *   · 仍然：**不在前端写死"可选运行时"** —— 已就绪的运行时由后端探测本机镜像得到（有就提供）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个概念，别混
 * ─────────────────────────────────────────────────────────────────────
 *   · **选择项（selection）**：`{ language, version }`，如 `{ language: 'python', version: '3.12' }`。
 *   · **组件 id**：`语言 + 版本`（**无分隔符**，版本保留 `.`），如 `python3.12` / `node20` / `go1.22`。
 *     语言名之间互不为前缀 ⇒ 可由 id 反解回 `{ language, version }`（见 {@link parseSandboxComponentId}）。
 *   · **变体（variant）**：一组选择项的规范化 id —— 按 `SANDBOX_RUNTIME_LANGUAGES` 顺序、每语言取一个版本、
 *     组件 id 用 `-` 连接（空集合 = `none`），如 `node20-python3.12`。它是 `Conversation.runtime` 的值、
 *     也是镜像 tag 的可读部分：`<repo>:<variant>-v<层版本>`。
 *
 * ⚠️ **规范化规则是唯一的、且必须与构建侧一致**（`infra/sandbox/versions.mjs` 有一份等价实现）：
 *   按 `SANDBOX_RUNTIME_LANGUAGES` 顺序排序、每语言一个版本、`-` 连接。
 *   两处不一致 ⇒ "建出来的 tag"与"选出来的 tag"对不上（症状：明明建了却说没有、反复重建）。
 * ⚠️ **版本里不能含 `-`**（会与变体分隔符冲突）—— 见 {@link sandboxComponentId}。
 */

import { z } from 'zod'

/** 支持的语言（顺序 = 变体 id 里组件的排序键；与 `infra/sandbox/versions.mjs` 一致） */
export const SANDBOX_RUNTIME_LANGUAGES = ['node', 'python', 'go', 'java', 'rust'] as const
export type SandboxRuntimeLanguage = (typeof SANDBOX_RUNTIME_LANGUAGES)[number]

/** 一个选择项：某语言的某个版本 */
export interface SandboxRuntimeSelection {
  language: SandboxRuntimeLanguage
  /** 版本字符串（如 `3.12` / `20` / `1.22` / `stable`）；**不得含 `-`** */
  version: string
}

/**
 * 一门语言的**元信息**（UI 勾选语言后据此渲染版本输入框）—— 与 `versions.mjs#RUNTIME_LANGUAGE_SPECS` 一致。
 *
 * ⚠️ 这里**不再枚举"支持哪些版本"**：`defaultVersion` 只是输入框预填、`suggestions` 只是候选提示；
 *    用户可填任意版本，能否装上由 `runtime/Dockerfile` 的装法与构建结果决定（构建失败会在任务里回显）。
 */
export interface SandboxRuntimeLanguageSpec {
  language: SandboxRuntimeLanguage
  /** 界面显示名（如 `Python`） */
  label: string
  /** 勾选后版本输入框的**预填**值 */
  defaultVersion: string
  /** 常见版本候选（前端做输入建议，不强制） */
  suggestions: readonly string[]
  /** 版本输入提示（格式） */
  hint: string
  /** base/toolkit 里**自带**的版本（有则系统命令名指它，其它版本用带版本号的命令名）；无则省略 */
  baseVersion?: string
}

export const SANDBOX_RUNTIME_LANGUAGE_SPECS: readonly SandboxRuntimeLanguageSpec[] = [
  { language: 'node', label: 'Node.js', defaultVersion: '22', suggestions: ['22', '20', '18'], hint: '大版本，如 20', baseVersion: '22' },
  { language: 'python', label: 'Python', defaultVersion: '3.11', suggestions: ['3.13', '3.12', '3.11', '3.10', '3.9', '3.8'], hint: '如 3.12', baseVersion: '3.11' },
  { language: 'go', label: 'Go', defaultVersion: '1.22', suggestions: ['1.23', '1.22', '1.21'], hint: '如 1.22' },
  { language: 'java', label: 'Java', defaultVersion: '17', suggestions: ['21', '17', '11', '8'], hint: '大版本，如 21' },
  { language: 'rust', label: 'Rust', defaultVersion: 'stable', suggestions: ['stable', '1.80', '1.79'], hint: '如 1.80 或 stable' },
]

/** 语言在排序里的序号（未知语言排最后） */
function languageOrder(language: string): number {
  const index = SANDBOX_RUNTIME_LANGUAGES.indexOf(language as SandboxRuntimeLanguage)
  return index < 0 ? SANDBOX_RUNTIME_LANGUAGES.length : index
}

const LANGUAGE_SET: ReadonlySet<string> = new Set(SANDBOX_RUNTIME_LANGUAGES)

/** 空集合的变体 id（= 只有 toolkit，不额外装语言运行时） */
export const SANDBOX_VARIANT_EMPTY = 'none'

/** 语言显示名（未知回退原串） */
export function sandboxLanguageLabel(language: string): string {
  return SANDBOX_RUNTIME_LANGUAGE_SPECS.find((spec) => spec.language === language)?.label ?? language
}

/** 版本串规范化（去首尾空白） */
function normalizeVersion(version: string): string {
  return version.trim()
}

/** 版本是否可用于组件 id（非空、且不含 `-`） */
function isUsableVersion(version: string): boolean {
  return version !== '' && !version.includes('-')
}

/** `(language, version)` → **组件 id**（`语言+版本`，无分隔符）；非法版本 ⇒ 抛 */
export function sandboxComponentId(language: string, version: string): string {
  const normalized = normalizeVersion(version)
  if (!isUsableVersion(normalized)) throw new Error(`非法版本：${version}（不能为空或含 -）`)
  return `${language}${normalized}`
}

/** 组件 id → `{ language, version }`（按语言前缀反解；认不出 ⇒ `undefined`） */
export function parseSandboxComponentId(id: string): SandboxRuntimeSelection | undefined {
  for (const language of SANDBOX_RUNTIME_LANGUAGES) {
    if (!id.startsWith(language)) continue
    const version = id.slice(language.length)
    if (version !== '') return { language, version }
  }
  return undefined
}

/** 选择项集合 → **规范变体 id**（每语言取一个版本、按语言顺序、`-` 连接；空 = `none`） */
export function sandboxVariantIdFromSelection(selection: readonly SandboxRuntimeSelection[]): string {
  const byLanguage = new Map<string, SandboxRuntimeSelection>()
  for (const item of selection) {
    if (!LANGUAGE_SET.has(item.language)) continue
    const version = normalizeVersion(item.version)
    if (!isUsableVersion(version)) continue
    byLanguage.set(item.language, { language: item.language, version })
  }
  if (byLanguage.size === 0) return SANDBOX_VARIANT_EMPTY
  return [...byLanguage.values()]
    .sort((a, b) => languageOrder(a.language) - languageOrder(b.language))
    .map((item) => sandboxComponentId(item.language, item.version))
    .join('-')
}

/** 变体 id → 选择项列表（`none`/空 → `[]`；含无法反解的片段 ⇒ `undefined`，表示"不是我们的组合"） */
export function sandboxSelectionFromVariantId(variant: string): SandboxRuntimeSelection[] | undefined {
  if (variant === '' || variant === SANDBOX_VARIANT_EMPTY) return []
  const pieces = variant.split('-').filter((piece) => piece !== '')
  const result: SandboxRuntimeSelection[] = []
  for (const piece of pieces) {
    const parsed = parseSandboxComponentId(piece)
    if (parsed === undefined) return undefined
    result.push(parsed)
  }
  return result
}

/** 选择项集合 → 给 `runtime/Dockerfile` 的 `COMPONENTS` 串（`lang=ver,…`，按语言顺序） */
export function sandboxComponentsArg(selection: readonly SandboxRuntimeSelection[]): string {
  const byLanguage = new Map<string, SandboxRuntimeSelection>()
  for (const item of selection) {
    if (!LANGUAGE_SET.has(item.language)) continue
    const version = normalizeVersion(item.version)
    if (!isUsableVersion(version)) continue
    byLanguage.set(item.language, { language: item.language, version })
  }
  return [...byLanguage.values()]
    .sort((a, b) => languageOrder(a.language) - languageOrder(b.language))
    .map((item) => `${item.language}=${item.version}`)
    .join(',')
}

/** 变体 id → 显示名（拼成「Node.js 20 + Python 3.12」；未知回退原串） */
export function sandboxVariantLabel(variant: string): string {
  const selection = sandboxSelectionFromVariantId(variant)
  if (selection === undefined) return variant
  if (selection.length === 0) return '无（仅基础工具）'
  return selection.map((item) => `${sandboxLanguageLabel(item.language)} ${item.version}`).join(' + ')
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

/** `GET /api/sandbox/runtimes` 响应里的一项：一门语言（UI 勾选 + 填版本） */
export const sandboxRuntimeLanguageSchema = z.object({
  language: z.enum(SANDBOX_RUNTIME_LANGUAGES),
  label: z.string(),
  defaultVersion: z.string(),
  suggestions: z.array(z.string()),
  hint: z.string(),
  baseVersion: z.string().nullable(),
})
export type SandboxRuntimeLanguageInfo = z.infer<typeof sandboxRuntimeLanguageSchema>

/** `GET /api/sandbox/runtimes` 的响应 */
export const listSandboxRuntimesResultSchema = z.object({
  /** 本机**已就绪**的运行时（有镜像才算） */
  runtimes: z.array(sandboxRuntimeSchema),
  /** **语言清单**（UI 据此渲染"勾选语言 + 填版本"；勾完的组合若不在 runtimes 里 ⇒ 可按需构建） */
  languages: z.array(sandboxRuntimeLanguageSchema),
  /** 回退镜像（会话 runtime 找不到对应镜像时用它）；未配置为 `null` */
  fallbackImage: z.string().nullable(),
  /** 后端能否**按需构建**（构建上下文存在 + docker 可用）；`false` 时前端只让选已就绪的 */
  canBuild: z.boolean(),
})
export type ListSandboxRuntimesResult = z.infer<typeof listSandboxRuntimesResultSchema>

/** `POST /api/sandbox/runtimes/build` 的请求体：要构建的**语言 + 版本**列表 */
export const buildSandboxRuntimeBodySchema = z.object({
  components: z
    .array(
      z.object({
        language: z.enum(SANDBOX_RUNTIME_LANGUAGES),
        version: z.string().trim().min(1, '版本不能为空').max(32, '版本过长'),
      }),
      { required_error: '缺少 components（语言+版本列表）' },
    )
    .min(1, '至少选一个语言')
    .max(8, '语言过多'),
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
