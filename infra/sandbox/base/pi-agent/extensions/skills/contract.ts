/**
 * skills 扩展的**纯契约层**（P1-24b-2）—— 无 io / 无 pi API / 无网络
 *
 * 依据：`docs/子方案/Skill能力.md` §4.1（切片与分页）/ §4.13（manifest）/ §4.15（工具注册）/
 *      §4.17（只读 + 路径判据）；`shared/src/skill.ts`（**同一套语义的权威定义**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件
 * ─────────────────────────────────────────────────────────────────────
 * 容器是**独立运行时**：它不能 `import '@doubulea/shared'`（镜像里没装 workspace 依赖），
 * 于是这里必须**手抄**一份 `shared` 的语义（分页切片、页文本、manifest 形状、路径判据）。
 * 抄写是唯一的做法，但**不能靠口头约定**：`backend/scripts/skill-sync-regression.ts` 用与后端
 * **同一段 9000 码点正文**逐字比对两边的 `skillPageOf` / `formatSkillPageText` / 入参归一化结果，
 * 并读本文件断言常量与 `shared` 一致（改一处漏一处 ⇒ 回归立刻红）。
 *
 * ⚠️ 本文件**不 import 任何东西**（连 `node:*` 都不要）：它要能被后端脚本用 tsx 直接加载。
 *    io（读目录 / 读文件 / 取 manifest）在 `index.ts`，pi API 只在 `index.ts`。
 */

// ───────────────────────────── 与 shared 逐字一致的常量 ─────────────────────────────

/** 结果上限（码点）—— `shared#SKILL_RESULT_MAX_CHARS` */
export const SKILL_RESULT_MAX_CHARS = 8000
/** `limit` 缺省 = 上限 − 512（`shared#SKILL_PAGE_DEFAULT_LIMIT`） */
export const SKILL_PAGE_DEFAULT_LIMIT = SKILL_RESULT_MAX_CHARS - 512
/** `limit` 硬上限（`shared#SKILL_PAGE_MAX_LIMIT`） */
export const SKILL_PAGE_MAX_LIMIT = SKILL_RESULT_MAX_CHARS

/** 三个只读工具名（`shared#SKILL_TOOL_NAMES`） */
export const SKILL_LIST_TOOL_NAME = 'list_skills'
export const SKILL_LOAD_TOOL_NAME = 'load_skill'
export const SKILL_READ_FILE_TOOL_NAME = 'read_skill_file'

/** 草稿入口工具名（`shared#SKILL_REQUEST_TOOL_NAMES`，P1-24c-4c） */
export const SKILL_REQUEST_DRAFT_TOOL_NAME = 'request_skill_draft'
export const SKILL_REQUEST_REVISION_TOOL_NAME = 'request_skill_revision'
export const SKILL_REVISE_DRAFT_TOOL_NAME = 'revise_skill_draft'

/** 草稿入口工具（需要代理回后端；只读工具在容器内本地读） */
export function isSkillRequestToolName(name: string): boolean {
  return (
    name === SKILL_REQUEST_DRAFT_TOOL_NAME ||
    name === SKILL_REQUEST_REVISION_TOOL_NAME ||
    name === SKILL_REVISE_DRAFT_TOOL_NAME
  )
}

/** 刷新命令（`shared#SKILLS_REFRESH_COMMAND`；**不带** `/`） */
export const SKILLS_REFRESH_COMMAND = 'doubulea:skills-refresh'

/** 入口文件名（`shared#SKILL_ENTRY_PATH`） */
export const SKILL_ENTRY_PATH = 'SKILL.md'

/** manifest 文件名（`shared#SKILL_MANIFEST_FILE`） */
export const SKILL_MANIFEST_FILE = 'manifest.json'

/** 路径长度上限（`shared#SKILL_PATH_MAX_CHARS`） */
export const SKILL_PATH_MAX_CHARS = 1024

/** 日志前缀（stderr 是本层的唯一出口，见 `index.ts` 文件头） */
export const LOG_PREFIX = '[skills]'

// ───────────────────────────── 分页（`shared#skillPageOf` 的容器副本）─────────────────────────────

export interface SkillPage {
  text: string
  offset: number
  limit: number
  totalChars: number
  truncated: boolean
  nextOffset: number | null
}

/**
 * 按**码点**切一页 —— 与 `shared#skillPageOf` **逐字同义**（回归用同一段 9000 码点正文比对）。
 *
 * `offset` 超过全文长度 ⇒ 空页（`truncated=false` / `nextOffset=null`）：模型多翻一页不是错误，
 * 它需要的是"已经读完了"这个结论。`limit` 超出硬上限 ⇒ 钳到上限（不报错）。
 */
export function skillPageOf(text: string, offset = 0, limit: number = SKILL_PAGE_DEFAULT_LIMIT): SkillPage {
  const chars = [...text]
  const totalChars = chars.length
  const safeOffset = Math.max(0, Math.trunc(offset))
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), SKILL_PAGE_MAX_LIMIT)
  const slice = chars.slice(safeOffset, safeOffset + safeLimit)
  const consumed = safeOffset + slice.length
  const truncated = consumed < totalChars
  return {
    text: slice.join(''),
    offset: safeOffset,
    limit: safeLimit,
    totalChars,
    truncated,
    nextOffset: truncated ? consumed : null,
  }
}

/** 一页 → 给模型的文本（`shared#formatSkillPageText` 的容器副本；**逐字同形**） */
export function formatSkillPageText(input: {
  title: string
  page: SkillPage
  toolName: string
  nextArgs: string
  overrideRevision?: number | null
}): string {
  const { page } = input
  const override = input.overrideRevision == null ? '' : ` · 会话覆写 r${String(input.overrideRevision)}`
  const head =
    page.offset === 0
      ? `${input.title}${override}（共 ${String(page.totalChars)} 字符）`
      : `${input.title}${override}（共 ${String(page.totalChars)} 字符，从第 ${String(page.offset + 1)} 字符起）`
  const body = page.truncated
    ? `\n\n…（本页到此为止。后面还有内容，请再次调用 ${input.toolName}：${input.nextArgs}, offset=${
        page.nextOffset ?? 0
      } 继续读，直到返回里不再提示）`
    : page.offset === 0
      ? ''
      : '\n\n（已读完全文）'
  return `${head}\n${page.text}${body}`
}

/**
 * 入参归一化（`shared#normalizeSkillPagingArgs` 的容器副本）。
 *
 * `offset/limit` **宽容**（缺省 / `null` / 非有限 / 小数 / 越界 ⇒ 钳位），`slug/path` **不宽容**
 * （非字符串或 trim 后为空 ⇒ 由调用方报参数错误）。容器里不跑 zod：JSON Schema 只用来告诉模型
 * "参数长什么样"，真正的钳位在这里。
 */
export function normalizePagingArgs(args: unknown): { offset: number; limit: number; raw: Record<string, unknown> } {
  const raw = args !== null && typeof args === 'object' && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {}
  const num = (value: unknown, fallback: number): number => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (!Number.isFinite(parsed)) return fallback
    return Math.trunc(parsed)
  }
  const offset = Math.max(0, num(raw.offset, 0))
  const limit = Math.min(Math.max(1, num(raw.limit, SKILL_PAGE_DEFAULT_LIMIT)), SKILL_PAGE_MAX_LIMIT)
  return { offset, limit, raw }
}

// ───────────────────────────── 路径判据（`shared#isSafeSkillPath` 的容器副本）─────────────────────────────

/**
 * Skill 内相对路径是否安全 —— 与 `shared#isSafeSkillPath` **逐字同义**。
 *
 * 拒绝：空串 / NUL / 反斜杠 / 绝对路径 / `..` 段 / `.` 段 / 盘符 / 超长。
 * ⚠️ 导入闸门（后端 `skillZip.ts`）早已拦过一次；这里再判一次是**纵深防御**：manifest 与目录内容
 *    都在宿主上，手工改过 / 半途失败都可能留下一个 `..` 路径，而容器侧是"直接读本机文件"的地方。
 */
export function isSafeSkillPath(path: string): boolean {
  if (path === '' || path.length > SKILL_PATH_MAX_CHARS) return false
  if (path.includes('\u0000') || path.includes('\\')) return false
  if (path.startsWith('/')) return false
  if (/^[A-Za-z]:/u.test(path)) return false
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/** 脚本路径（`scripts/**`）—— 容器里**允许读**（TaskAgent 要跑它），只是不对模型隐藏 */
export function isSkillScriptPath(path: string): boolean {
  return path === 'scripts' || path.startsWith('scripts/')
}

// ───────────────────────────── manifest 形状（`shared#skillManifestSchema` 的容器副本）─────────────────────────────

export interface SkillManifestEntry {
  id: string
  slug: string
  name: string
  version: number
  runtime: 'INLINE' | 'SANDBOX'
  /** 本轮生效版本目录（**相对副本根**），如 `v3/report-export` */
  path: string
  /** 稳定脚本路径（相对副本根），恒 `current/<slug>` */
  currentPath: string
  override: boolean
  overrideRevision: number | null
  description: string
  requires: { bins: string[] }
}

export interface SkillManifestTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface SkillManifest {
  generatedAt: string
  conversationId: string
  fingerprint: string
  maxChars: number
  skills: SkillManifestEntry[]
  tools: SkillManifestTool[]
}

/** 只想读"是不是这份副本"时用的最小形状（挂载探针用的就是它） */
export function manifestConversationIdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = (value as { conversationId?: unknown }).conversationId
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 校验并规整一份 manifest（**只读必要的字段**；缺字段 / 类型不对 ⇒ `null`）。
 *
 * 为什么不做严格 schema 校验：manifest 是**后端生成的**、同一份代码写的；容器里再实现一个 zod
 * 只会多一处漂移面。这里只判"能不能安全地用"：`skills[]` 每项要有 `slug/name/version/path/
 * currentPath`，`tools[]` 每项要有 `name/description/inputSchema`。不合法的条目**逐条丢弃**
 * （不整份丢：剩下合法的 Skill 仍可用），一个合法工具都没有时返回 `null`（= 不注册工具）。
 */
export function parseManifest(value: unknown): SkillManifest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const conversationId = manifestConversationIdOf(raw)
  if (conversationId === null) return null
  const skills = Array.isArray(raw.skills) ? raw.skills.map(parseEntry).filter((entry): entry is SkillManifestEntry => entry !== null) : []
  const tools = Array.isArray(raw.tools) ? raw.tools.map(parseTool).filter((tool): tool is SkillManifestTool => tool !== null) : []
  if (tools.length === 0) return null
  const maxCharsRaw = typeof raw.maxChars === 'number' && Number.isFinite(raw.maxChars) ? Math.trunc(raw.maxChars) : SKILL_RESULT_MAX_CHARS
  return {
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    conversationId,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    maxChars: Math.max(1, maxCharsRaw),
    skills,
    tools,
  }
}

function parseEntry(value: unknown): SkillManifestEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const { id, slug, name, version, path, currentPath } = raw
  if (typeof id !== 'string' || id === '') return null
  if (typeof slug !== 'string' || slug === '') return null
  if (typeof name !== 'string') return null
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null
  if (typeof path !== 'string' || !isSafeSkillPath(path)) return null
  if (typeof currentPath !== 'string' || !isSafeSkillPath(currentPath)) return null
  const requires = raw.requires !== null && typeof raw.requires === 'object' && !Array.isArray(raw.requires)
    ? (raw.requires as { bins?: unknown }).bins
    : undefined
  const overrideRevision = typeof raw.overrideRevision === 'number' && Number.isInteger(raw.overrideRevision) ? raw.overrideRevision : null
  return {
    id,
    slug,
    name,
    version,
    // manifest 只由后端写（`INLINE` 的 Skill 也允许绑到 TaskAgent：它只是"不需要容器"，不是"不能用"）
    runtime: raw.runtime === 'SANDBOX' ? 'SANDBOX' : 'INLINE',
    path,
    currentPath,
    override: raw.override === true,
    overrideRevision,
    description: typeof raw.description === 'string' ? raw.description : '',
    requires: { bins: Array.isArray(requires) ? requires.filter((item): item is string => typeof item === 'string') : [] },
  }
}

function parseTool(value: unknown): SkillManifestTool | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || raw.name === '') return null
  const inputSchema = raw.inputSchema !== null && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema)
    ? (raw.inputSchema as Record<string, unknown>)
    : { type: 'object', properties: {} }
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    inputSchema,
  }
}

// ───────────────────────────── 目录 / 查找 ─────────────────────────────

/** manifest 里按 slug 找一条（找不到 ⇒ `undefined`；不区分大小写**刻意不做**：slug 是标识） */
export function findManifestEntry(manifest: SkillManifest, slug: string): SkillManifestEntry | undefined {
  return manifest.skills.find((entry) => entry.slug === slug)
}

/**
 * `list_skills` 的条目（按 `slug asc` 稳定；`query` 做 slug / name / description 的包含匹配）。
 *
 * 与 ChatBot 的 `list_skills` **同口径**（只列 manifest 里的 = 只列本 Agent 绑定的）。
 */
export function listSkillEntries(manifest: SkillManifest, query?: string): SkillManifestEntry[] {
  const sorted = [...manifest.skills].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  const keyword = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (keyword === '') return sorted
  return sorted.filter((entry) =>
    [entry.slug, entry.name, entry.description].some((field) => field.toLowerCase().includes(keyword)),
  )
}

/** 目录栏文本（`list_skills` 的结果；与 ChatBot 的目录段同一种行文） */
export function formatSkillList(entries: readonly SkillManifestEntry[], total: number): string {
  if (total === 0) return '当前智能体没有绑定任何 Skill。'
  if (entries.length === 0) return `没有匹配的 Skill（共 ${String(total)} 个）。用 list_skills 不带关键词查看全部。`
  const lines = entries.map((entry) => `- ${entry.slug}（v${String(entry.version)}）${entry.name}：${entry.description}`)
  return `共 ${String(total)} 个 Skill，匹配 ${String(entries.length)} 个：\n${lines.join('\n')}`
}

/** 页头（与后端 `skillTools.ts#skillLabel` + ` · path` 同形） */
export function skillPageTitle(entry: SkillManifestEntry, path?: string): string {
  const base = `Skill「${entry.name}」（${entry.slug}，v${String(entry.version)}）`
  return path === undefined ? base : `${base} · ${path}`
}

/** 用 manifest 的 `maxChars` 求本页 limit（模型没给 limit 时用；同时不得超过硬上限） */
export function pageLimitOf(manifest: SkillManifest, requested: number | undefined): number {
  const cap = Math.min(Math.max(1, manifest.maxChars), SKILL_PAGE_MAX_LIMIT)
  const value = requested === undefined ? Math.min(SKILL_PAGE_DEFAULT_LIMIT, cap) : Math.trunc(requested)
  return Math.min(Math.max(1, value), cap)
}
