/**
 * Code 模式工作区契约（P1-9）
 *
 * 依据：`docs/子方案/Code模式工作区.md`（§三 数据模型 / §六 人侧集成 / §七 并发协议 / §九 安全 / §十一 参数总表）、
 *      `01`（能力增量登记）、`05` §三·补 P1-9。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 单一真相：工作区 = 会话级、人机共享、可版本化的工作目录
 * ─────────────────────────────────────────────────────────────────────
 * 一个会话一份 canonical 工作区（字节在宿主 FS，bind mount 进容器 `/work`；索引/版本/事件在 Postgres、
 * 冷备在 S3）。**人和 agent 读写同一份**，任何写入都带 `baseVersion` 做 CAS —— 杜绝静默覆盖
 * （§一 不变量 I1/I2）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 路径是**归一化后的相对路径**，且只有一种合法写法
 * ─────────────────────────────────────────────────────────────────────
 * {@link normalizeWorkspacePath} 是前后端**唯一**的路径判据（施工纪律第 5 条：schema 定义在 `shared/`）：
 *   · 一律 `/` 分隔（Windows 反斜杠先折叠）；
 *   · 相对 root，**不许**以 `/` 开头、**不许**任何 `..` 段（`a/../b` 也拒，不做"化简后放行"——
 *     那会把"能不能逃逸出 root"变成一个需要读懂化简规则才能回答的问题）；
 *   · 空段 / `.` 段折叠掉；结果非空、长度 ≤ {@link WORKSPACE_PATH_MAX}。
 * 归一化**只解决"是不是一条合法的相对路径"**，"最终落点是否真的在 root 内（符号链接逃逸）"
 * 由后端在写盘前用 `realpath` 再判一次（§九 路径逃逸）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 读写契约围绕 `version`（不是 mtime）
 * ─────────────────────────────────────────────────────────────────────
 * 读文件返回 `version`；写文件携带 `baseVersion` —— 不匹配即 **409 冲突**，由前端决定合并
 * （§七 冲突时序）。`version` 是**每个文件**单调递增的修订号（`workspace_files.version`），
 * 工作区级另有 `headVersion`（事件序号，前端断线补发游标，不出现在本文件的大部分契约里）。
 */

import { z } from 'zod'

// ═════════════════════════════ 工作区参与者 ═════════════════════════════

/**
 * 一次写入的**参与者**（`workspace_files.updated_by` / `workspace_events.actor`）。
 *
 * `SYSTEM` 覆盖"非人非 agent"的写入来源：watcher 捕获的**未中介写**（`bash` 落盘、宿主手工改）、
 * 冷备恢复回填、保留期清理等。它**不是**"未知"的同义词 —— 未知写入一样要归到 `AGENT`/`USER`
 * 之下（§五 3 的 bash 兜底按当时的 turn 归属）。
 */
export const WORKSPACE_ACTORS = ['AGENT', 'USER', 'SYSTEM'] as const
export type WorkspaceActor = (typeof WORKSPACE_ACTORS)[number]

/** 参与者 → 中文名（事件流 / 面板标签共用一份，别在两处各写一遍） */
export const WORKSPACE_ACTOR_LABELS: Record<WorkspaceActor, string> = {
  AGENT: 'Agent',
  USER: '我',
  SYSTEM: '系统',
}

// ═════════════════════════════ 事件 ═════════════════════════════

/**
 * 工作区事件类型（`workspace_events.type`）。
 *
 *   · `created` —— 新建文件；
 *   · `updated` —— 内容变化（版本 +1）；
 *   · `deleted` —— 软删（墓碑）；
 *   · `renamed` —— 改名 / 移动（`path` 记**新路径**，旧路径见当时那条 `deleted`/日志）；
 *   · `claim` / `release` —— 文件级软锁的取/放（§七 1 第 ② 层）。
 *
 * ⚠️ `claim` / `release` **不进前端"文件变更"高亮**（它们不改变字节），但一样落 `workspace_events`
 * 供断线补发与审计 —— 判据是"事件类型"，前端按 {@link WORKSPACE_CONTENT_EVENT_TYPES} 分流。
 */
export const WORKSPACE_EVENT_TYPES = ['created', 'updated', 'deleted', 'renamed', 'claim', 'release'] as const
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number]

/** 会**改变工作区内容**的事件（前端据此刷新文件树 / 重载编辑器）—— `claim`/`release` 不计入 */
export const WORKSPACE_CONTENT_EVENT_TYPES = ['created', 'updated', 'deleted', 'renamed'] as const
export type WorkspaceContentEventType = (typeof WORKSPACE_CONTENT_EVENT_TYPES)[number]

// ═════════════════════════════ 路径归一化（前后端唯一判据） ═════════════════════════════

/** 归一化后相对路径的长度上限（字符，与 `schema.prisma#WorkspaceFile.path VarChar(1024)` 同源） */
export const WORKSPACE_PATH_MAX = 1024

/**
 * 把任意输入归一化成**合法的工作区相对路径**；不合法一律返回 `null`（不抛错、不做"最接近的猜测"）。
 *
 * 返回 `null` 的输入：非字符串 / 空串 / 以 `/` 开头（绝对路径）/ 含 NUL / 任一 `..` 段 /
 * 折叠后为空（如 `.`、`./`）/ 超长。**符号链接逃逸不在这里判**（见文件头 ②）。
 *
 * ⚠️ 刻意**不做**"先化简再判"：`a/../..` 化简成 `..` 才拒，会让"这条路径安全吗"依赖化简实现；
 * 现在是"只要出现 `..` 段就拒"，一个不了解上下文的读者也能一眼判。
 */
export function normalizeWorkspacePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.includes('\0')) return null
  // Windows 反斜杠折叠成 `/`（同一个路径在两种分隔符下必须是同一个字符串，否则索引会出现两条）
  const slashed = trimmed.replace(/\\/gu, '/')
  if (slashed.startsWith('/')) return null
  const segments: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null
  const normalized = segments.join('/')
  if (normalized.length > WORKSPACE_PATH_MAX) return null
  return normalized
}

/** 判断一段归一化路径是否是"隐藏/内部"目录（`.` 前缀段）—— 前端可折叠、冷备/产物可分流用 */
export function isWorkspaceHiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.') && segment !== '.')
}

// ═════════════════════════════ 前端闸门常量（与后端 config 默认值同源） ═════════════════════════════

/**
 * 编辑器可内联打开的**文本**体积上限默认值（MB，= `WORKSPACE_MAX_FILE_MB` 的默认）。
 *
 * ⚠️ 真正生效的值由后端下发（`WORKSPACE_MAX_FILE_MB`）—— 这里只给前端一个**默认闸门**，
 * 免得"后端限制 10MB、前端试开 50MB"这种口径分叉（性质同 `shared#PREVIEW_*` 的体积闸门）。
 */
export const WORKSPACE_TEXT_INLINE_MAX_MB_DEFAULT = 2

// ═════════════════════════════ 响应 / 请求 schema ═════════════════════════════

/** 归一化路径的 zod 字段（请求体 / 查询参数共用；不合法 = `VALIDATION` 400） */
export const workspacePathSchema = z
  .string({ required_error: '缺少路径', invalid_type_error: '路径必须是字符串' })
  .transform((value, ctx) => {
    const normalized = normalizeWorkspacePath(value)
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '不是合法的工作区相对路径（不许绝对路径 / `..` / 空）' })
      return z.NEVER
    }
    return normalized
  })

/** 工作区文件树里的一条（`GET /api/conversations/:id/workspace` 的 `items[]`） */
export const workspaceFileEntrySchema = z.object({
  /** 归一化相对路径（含子目录，如 `out/report.csv`） */
  path: z.string(),
  /** 字节数（`workspace_files.size`，DB 侧 BigInt，契约里是 number —— 上限 512MB/会话远未到 2^53） */
  size: z.number().int().min(0),
  /** MIME（写入时按扩展名判定；见 §六 的响应头分派复用手法） */
  mime: z.string(),
  /** 每文件单调版本（CAS 的 base） */
  version: z.number().int().min(1),
  /** 最近一次写入的参与者 */
  updatedBy: z.enum(WORKSPACE_ACTORS),
  /** 最近一次写入的时刻（ISO 8601；JS 侧写入，见 `schema.prisma` 的时区纪律） */
  updatedAt: z.string(),
})
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>

/**
 * 文件树响应 = `{ items: WorkspaceFileEntry[] }`。
 *
 * ⚠️ **目录不单独作为行**（DB 索引里只有文件）：前端从 `path` 的 `/` 段自建目录层级 ——
 * 空目录在工作区模型里不存在（与 git 一致：一个没有文件的目录不是"内容"）。
 * 也不分页：`WORKSPACE_MAX_FILES`（默认 2000）就是单会话上界，一次给全量比翻页更省事。
 */
export const workspaceTreeResultSchema = z.object({
  items: z.array(workspaceFileEntrySchema),
})
export type WorkspaceTreeResult = z.infer<typeof workspaceTreeResultSchema>

/**
 * 读文件（`GET /api/conversations/:id/workspace/file?path=`）。
 *
 * `text` **只有文本文件**（`previewKindOf(mime) === 'text'` 且体积 ≤ 内联上限）才有值；
 * 其余为 `null`（前端改走 `/workspace/file/raw` 的字节出口，复用产物预览那套响应头分派）。
 * 这样文本编辑器总是拿到 `text`，二进制/大文件永远不走内联字符串（避免把 base64 塞进 JSON）。
 */
export const workspaceFileReadSchema = z.object({
  path: z.string(),
  version: z.number().int().min(1),
  size: z.number().int().min(0),
  mime: z.string(),
  /** 文本内容；二进制 / 超内联上限时不适用 ⇒ `null` */
  text: z.string().nullable(),
})
export type WorkspaceFileRead = z.infer<typeof workspaceFileReadSchema>

/** 写文件请求体（`PUT /api/conversations/:id/workspace/file?path=`）—— 核心是 `baseVersion` 的 CAS */
export const workspaceWriteFileBodySchema = z.object({
  content: z.string({ required_error: '缺少 content' }),
  /**
   * 写前读到的版本号。`0` = "我认为这个文件还不存在"（新建）。
   * 与当前版本不一致 ⇒ 409（并发写冲突，§七 1 第 ③ 层）。
   */
  baseVersion: z.coerce.number().int().min(0, 'baseVersion 不能为负').default(0),
})
export type WorkspaceWriteFileBody = z.infer<typeof workspaceWriteFileBodySchema>

/** 新建文件请求体（`POST /api/conversations/:id/workspace/file`）—— `path` 在 body 里（无查询参数） */
export const workspaceCreateFileBodySchema = z.object({
  path: workspacePathSchema,
  content: z.string().default(''),
})
export type WorkspaceCreateFileBody = z.infer<typeof workspaceCreateFileBodySchema>

/** 改名 / 移动（`POST /api/conversations/:id/workspace/move`）—— 两端都是归一化路径，且不许相同 */
export const workspaceMoveBodySchema = z
  .object({
    from: workspacePathSchema,
    to: workspacePathSchema,
  })
  .refine((value) => value.from !== value.to, { message: '源路径与目标路径相同', path: ['to'] })
export type WorkspaceMoveBody = z.infer<typeof workspaceMoveBodySchema>

/** 路径查询参数（读 / 写 / 删共用：`?path=out/report.csv`） */
export const workspacePathQuerySchema = z.object({ path: workspacePathSchema })
export type WorkspacePathQuery = z.infer<typeof workspacePathQuerySchema>

// ═════════════════════════════ 事件 schema（SSE 断线补发 + 审计） ═════════════════════════════

/**
 * 一条工作区事件。
 *
 * ⚠️ `actorId` 对 `USER` 是 userId、对 `AGENT` 是 turnId、对 `SYSTEM` 可空 —— **不保证可 join**
 * （它是留痕字段，不是外键；同 `memories.source_*` 的纪律）。响应里**不回 `conversationId`**：
 * 事件总是按会话订阅的，回一个恒定值只会让 payload 变大。
 */
export const workspaceEventSchema = z.object({
  id: z.string(),
  type: z.enum(WORKSPACE_EVENT_TYPES),
  path: z.string(),
  /** 内容事件有版本；`claim`/`release` 为 `null` */
  version: z.number().int().min(1).nullable(),
  actor: z.enum(WORKSPACE_ACTORS),
  actorId: z.string().nullable(),
  /** ISO 8601 */
  at: z.string(),
})
export type WorkspaceEventItem = z.infer<typeof workspaceEventSchema>

/** 事件补发查询（`GET /api/conversations/:id/workspace/events?after=<headVersion>`） */
export const workspaceEventsQuerySchema = z.object({
  /** 只回 `headVersion` 大于它的补发（断线重连用）；缺省 = 只订阅不补发 */
  after: z.coerce.number().int().min(0).optional(),
})
export type WorkspaceEventsQuery = z.infer<typeof workspaceEventsQuerySchema>

// ═════════════════════════════ 变更集（P4） ═════════════════════════════

/**
 * 变更集里的一条：**按路径折叠后的最新状态**（不是逐条事件）。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §六 3（轮末变更集 = "本轮这个工作区动过哪些文件"）。
 * 折叠口径见 {@link foldWorkspaceEvents}。
 */
export const workspaceChangeEntrySchema = z.object({
  path: z.string(),
  /** 这条路径**最后**一次事件的类型 */
  type: z.enum(WORKSPACE_EVENT_TYPES),
  /** 内容事件有版本；`claim`/`release` 为 `null` */
  version: z.number().int().min(1).nullable(),
  actor: z.enum(WORKSPACE_ACTORS),
  actorId: z.string().nullable(),
  at: z.string(),
})
export type WorkspaceChangeEntry = z.infer<typeof workspaceChangeEntrySchema>

/** 变更集响应 = `{ items }`（按 `at` 倒序；只含 `[since, now]` 窗口内动过的路径各一条） */
export const workspaceChangesResultSchema = z.object({
  items: z.array(workspaceChangeEntrySchema),
})
export type WorkspaceChangesResult = z.infer<typeof workspaceChangesResultSchema>

/** 变更集查询（`GET /api/conversations/:id/workspace/changes?since=<iso>`；`since` 缺省 = 全量） */
export const workspaceChangesQuerySchema = z.object({
  /** 只看这个时刻**之后**（含）的事件（ISO 8601）。轮末用它 = 本轮开始时刻 */
  since: z.string().datetime({ offset: true }).optional(),
})
export type WorkspaceChangesQuery = z.infer<typeof workspaceChangesQuerySchema>

/**
 * 把一串工作区事件**按路径折叠**成变更集（**纯函数，前后端共用**）。
 *
 * 口径：
 *   · 同一路径多次事件只留**最后一条**（`at` 最大；`at` 相同按输入顺序后者胜）—— 变更集回答的是
 *     "这条路径现在是什么状态"，不是"它被改了几次"；
 *   · **输入无需预排序**（本函数自己按 `at` 取最大），调用方不必先 orderBy；
 *   · 结果按 `at` **倒序**（最近动的在前）。
 * ⚠️ `claim`/`release` 也会出现（它们也是事件）—— 但"内容有没有变"要看 `type`，前端据此分流
 * （见 `WORKSPACE_CONTENT_EVENT_TYPES`）。
 */
export function foldWorkspaceEvents(events: readonly WorkspaceEventItem[]): WorkspaceChangeEntry[] {
  const latest = new Map<string, WorkspaceEventItem>()
  for (const event of events) {
    const current = latest.get(event.path)
    // `>=`：`at` 相同时保留**后出现**的那条（同一时刻的多次写，后写者胜）
    if (current === undefined || event.at >= current.at) latest.set(event.path, event)
  }
  return [...latest.values()]
    .map((event) => ({
      path: event.path,
      type: event.type,
      version: event.version,
      actor: event.actor,
      actorId: event.actorId,
      at: event.at,
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

// ═════════════════════════════ 撤销本轮（P4 · R2） ═════════════════════════════

/**
 * 「撤销本轮」对**每一条路径**的落点结论（`POST .../workspace/revert` 的 `items[]`）。
 *
 *   · `restored`    —— 已把该路径内容回退到轮初版本（写入成功）；
 *   · `deleted`     —— 本轮前不存在 ⇒ 撤销 = 删掉它（已删 / 幂等）；
 *   · `skipped`     —— 净变化为零（本轮内建了又删）或本就走不通，无事可做；
 *   · `conflict`    —— 轮末之后有人又改过（当前版本 ≠ 本轮末版本）⇒ **不静默覆盖**，留给人工裁决；
 *   · `unavailable` —— 轮初版本的历史字节缺失（冷备前/预置内容）⇒ 无从还原；
 *   · `unsupported` —— 改名/移动、二进制文件等本版不支持的撤销。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §七 5（撤销本轮：按 `beforeVersion` 走同一套 CAS 回写；
 * 当前版本 ≠ 轮末版本时不静默覆盖）。
 */
export const WORKSPACE_REVERT_ACTIONS = ['restored', 'deleted', 'skipped', 'conflict', 'unavailable', 'unsupported'] as const
export type WorkspaceRevertAction = (typeof WORKSPACE_REVERT_ACTIONS)[number]

/** 撤销结果里的一行（每路径一条） */
export const workspaceRevertEntrySchema = z.object({
  path: z.string(),
  action: z.enum(WORKSPACE_REVERT_ACTIONS),
  /** 撤销**前**该路径的当前版本（不存在 = `0`；墓碑也是旧版本号，见 `planWorkspaceRevert`） */
  currentVersion: z.number().int().min(0),
  /** 要还原到的**轮初版本**；`null` = 本轮前不存在（撤销 = 删除） */
  fromVersion: z.number().int().min(1).nullable(),
  /** 实际写入后落成的新版本；未写入（skipped/conflict/…）时为 `null` */
  toVersion: z.number().int().min(1).nullable(),
  /** 失败/跳过的原因（给人看；`restored`/`deleted` 时缺省） */
  message: z.string().optional(),
})
export type WorkspaceRevertEntry = z.infer<typeof workspaceRevertEntrySchema>

/** 撤销本轮响应（`{since, until, dryRun, items}`；`since`/`until` = 实际生效的窗口，ISO 8601） */
export const workspaceRevertResultSchema = z.object({
  since: z.string(),
  until: z.string(),
  /** 只预演不落盘（`dryRun`）：`items` 的动作是"将会怎样" */
  dryRun: z.boolean(),
  items: z.array(workspaceRevertEntrySchema),
})
export type WorkspaceRevertResult = z.infer<typeof workspaceRevertResultSchema>

/**
 * 撤销本轮请求体（`POST /api/conversations/:id/workspace/revert`）。
 *
 * `since`/`until` 缺省 = 由服务端读**本轮标记**（TaskAgent 一轮开始时记下的窗口，见 `workspace/round.ts`）；
 * 显式传入用于"撤销某个已知窗口"（测试 / 高级用法）。`dryRun=true` = 只算不写。
 */
export const workspaceRevertBodySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  dryRun: z.boolean().optional(),
})
export type WorkspaceRevertBody = z.infer<typeof workspaceRevertBodySchema>

/** 计划里的一条（`planWorkspaceRevert` 的产物）：撤销这条路径应该做什么 */
export interface WorkspaceRevertPlanEntry {
  path: string
  /** 轮初该路径的版本；`null` = 轮初不存在（撤销 = 删除） */
  beforeVersion: number | null
  /** 轮末该路径应有的状态（CAS 校验："此后无人再动"的判据） */
  expect: { deleted: true } | { deleted: false; version: number }
  /** 不可撤销的原因（如 `renamed`）；有值即跳过 */
  unsupported?: string
}

/**
 * 把窗口内的内容事件**按路径折叠**成撤销计划（**纯函数**）。
 *
 * 口径（`子方案` §七 5）：
 *   · 每条路径取窗口内**最早**的 `first` 与**最晚**的 `last`；
 *   · `beforeVersion`：`first.type === 'created'` ⇒ `null`（轮初不存在）；`'updated'` ⇒ `first.version - 1`
 *     （`1` ⇒ `null`）；`'deleted'` ⇒ `first.version`（被删前的版本，内容未变）；
 *   · `expect`：`last.type === 'deleted'` ⇒ 轮末应"已删"；否则 = `last.version`；
 *   · `renamed`（改名/移动）本版**不可撤销**：`path` 只记新路径、旧路径不明 ⇒ 标记 `unsupported`。
 *
 * ⚠️ 每条路径**只对一次窗口**（"这轮动过它"），不是逐条事件 —— 与 {@link foldWorkspaceEvents} 同源。
 */
export function planWorkspaceRevert(events: readonly WorkspaceEventItem[]): WorkspaceRevertPlanEntry[] {
  const byPath = new Map<string, { first: WorkspaceEventItem; last: WorkspaceEventItem }>()
  for (const event of events) {
    if (!(WORKSPACE_CONTENT_EVENT_TYPES as readonly string[]).includes(event.type)) continue
    const current = byPath.get(event.path)
    if (current === undefined) {
      byPath.set(event.path, { first: event, last: event })
      continue
    }
    if (event.at < current.first.at) current.first = event
    // `>=`：`at` 相同时后出现者胜（与 `foldWorkspaceEvents` 同款）
    if (event.at >= current.last.at) current.last = event
  }

  const plan: WorkspaceRevertPlanEntry[] = []
  for (const [path, { first, last }] of byPath) {
    if (first.type === 'renamed' || last.type === 'renamed') {
      plan.push({
        path,
        beforeVersion: null,
        expect: { deleted: false, version: 0 },
        unsupported: '改名/移动暂不支持整轮撤销',
      })
      continue
    }
    let beforeVersion: number | null
    if (first.type === 'created') beforeVersion = null
    else if (first.type === 'updated') beforeVersion = (first.version ?? 1) - 1 > 0 ? (first.version ?? 1) - 1 : null
    else beforeVersion = first.version ?? null // deleted：被删前的版本
    const expect =
      last.type === 'deleted' ? ({ deleted: true } as const) : ({ deleted: false, version: last.version ?? 0 } as const)
    plan.push({ path, beforeVersion, expect })
  }
  return plan.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// ═════════════════════════════ MIME 判定（前后端同源） ═════════════════════════════

/**
 * 工作区文件的扩展名 → MIME 表（**比产物那张宽**：工作区是代码目录，编辑器要认 `.ts`/`.go`…）。
 *
 * ⚠️ 与 `backend/src/sandbox/artifacts.ts#ARTIFACT_MIME_BY_EXTENSION` **刻意不是同一张**：
 * 产物那张是"**交付物要给用户看什么形态**"（保守，只认常见几类），这张是"**编辑器能不能开**"
 * （要覆盖常见语言）。两者混用会让"能不能预览"与"能不能编辑"互相绑死。
 * ⚠️ 但**同一个扩展名在两处的结论不应矛盾**（常见文本/图片类逐字一致）；新增时两处对照。
 */
export const WORKSPACE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonc: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  py: 'text/x-python',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  go: 'text/x-go',
  rs: 'text/x-rust',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  sql: 'text/x-sql',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/x-toml',
  ini: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  dockerfile: 'text/plain',
  gradle: 'text/plain',
  properties: 'text/plain',
  vue: 'text/html',
  svelte: 'text/html',
}

/** 按扩展名定 MIME（小写；不认识 → `application/octet-stream`）。纯函数，前后端共用 */
export function workspaceMimeOf(path: string): string {
  const matched = /\.([^./\\]+)$/u.exec(path)
  const ext = matched?.[1]?.toLowerCase()
  const found = ext === undefined ? undefined : WORKSPACE_MIME_BY_EXTENSION[ext]
  return found ?? 'application/octet-stream'
}

/**
 * "这个文件能不能当文本打开编辑"—— 编辑器与内联读的**唯一判据**。
 *
 * 口径：`text/*` 一律可编辑；其余常见"其实是文本"的类型（json/xml/javascript/typescript/
 * shellscript/yaml/sql/toml）显式列出。**不认识的类型一律不可编辑**（只读/下载）——
 * "猜它是文本"会得到乱码编辑器，比"不给编辑"更坏（同 `previewKindOf` 的保守名单纪律）。
 * ⚠️ 与 `previewKindOf` 不同：后者只认 4 种文本形态（给浏览器渲染），这里要覆盖一整棵代码树。
 */
const WORKSPACE_EDITABLE_NON_TEXT_MIMES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'text/javascript',
  'text/typescript',
  'text/x-shellscript',
  'text/yaml',
  'text/x-sql',
  'text/x-toml',
])

export function isWorkspaceTextMime(mime: string | null | undefined): boolean {
  if (typeof mime !== 'string') return false
  const base = mime.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  if (base === '') return false
  return base.startsWith('text/') || WORKSPACE_EDITABLE_NON_TEXT_MIMES.has(base)
}