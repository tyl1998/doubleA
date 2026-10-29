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

import { validationMessage } from './i18n/validation.js'

import type { MessageKey } from './i18n/index.js'

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

/**
 * 参与者 → i18n key（P1-23：前端面板据此取译文；**中文那份 {@link WORKSPACE_ACTOR_LABELS} 保留**
 * 给后端与其它中文消费方用，见 `子方案/界面语言切换.md` §3.5 的"前端主译、标签表保留兜底"）。
 */
export const WORKSPACE_ACTOR_KEY: Record<WorkspaceActor, MessageKey> = {
  AGENT: 'label.workspaceActor.agent',
  USER: 'label.workspaceActor.user',
  SYSTEM: 'label.workspaceActor.system',
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

/**
 * 这段路径是不是 **git 自己的内部文件**（`<repo>/.git/…`，或 `--separate-git-dir` 那种 `.git`
 * 文件本身）—— **纯函数**，前后端共用一处判据。
 *
 * ★ 为什么要单独判（2026-10-27，用户反馈「git 都没变更，为什么拉取下来那些算变更」）：
 *   `.git/` 里的对象 / 索引 / 锁文件在工作区里也是普通文件，`clone --depth` 中途会被
 *   `reconcileWorkspaceOnce` 一条条记成 `created`/`updated`/`deleted`（实测某会话 12 秒里
 *   1988 条事件，其中就有 `repo/.git/objects/pack/tmp_pack_*`、`repo/.git/index.lock`）。
 *   它们已经是工作区索引的一部分（`.git` 属工作区内容、进冷备），但**不该出现在「最近变更」**：
 *   那份清单要回答"谁动了哪些代码"，不是 git 的中间产物。
 *
 * 与 {@link isWorkspaceHiddenPath} 的区别：那个是"任一段以 `.` 开头"（会连 `.doubulea/memory.md`
 * 一起算），这里**只认 `.git` 这一段**（`.github/` 是正常目录，不算）。
 */
export function isGitInternalPath(path: string): boolean {
  return path.split('/').some((segment) => segment === '.git')
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
  .string({
    required_error: validationMessage('validation.workspace.pathMissing'),
    invalid_type_error: validationMessage('validation.workspace.pathNotString'),
  })
  .transform((value, ctx) => {
    const normalized = normalizeWorkspacePath(value)
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage('validation.workspace.pathInvalid'),
      })
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
 * 也不分页：`WORKSPACE_MAX_FILES`（默认 20000）就是单会话上界，一次给全量比翻页更省事。
 */
export const workspaceTreeResultSchema = z.object({
  items: z.array(workspaceFileEntrySchema),
})
export type WorkspaceTreeResult = z.infer<typeof workspaceTreeResultSchema>

/**
 * 工作区里的**一个 git 仓库**（`GET /api/conversations/:id/workspace/git` 的 `repos[]`）。
 *
 * 为什么要有：工作区里 clone 下来的项目，用户第一眼想知道的往往是"我现在在哪个分支"。
 * 判据只读仓库自己的 `.git/HEAD`（**不调 git 二进制** —— 宿主上不保证有，且没必要），
 * 所以这里只给"分支名"，不给 ahead/behind / 脏不脏（那些要跑 git；留待需要时再说）。
 */
export const workspaceGitRepoSchema = z.object({
  /** 仓库根**相对工作区**的路径（`''` = 工作区根就是仓库；否则如 `qatt-platform-qa`） */
  path: z.string(),
  /**
   * 当前分支名（如 `master`）；**detached HEAD** 时给短 SHA（7 位）；
   * `.git/HEAD` 读不到 / 形状不认识时 `null`（前端按"未知"显示，不猜）。
   */
  branch: z.string().nullable(),
  /** 是否处于 detached HEAD（`branch` 那一栏装的是短 SHA） */
  detached: z.boolean(),
  /**
   * 这个仓库**此刻是否还在 clone / pull 中途**（P1-24，2026-10-27）：`index.lock` / `shallow.lock` 还在。
   *
   * 为什么要给前端：`clone --depth 1` 会在工作区里一口气长出几千个文件、`.git` 也在反复重写；
   * 面板据此把「已就绪」推后（树先按原始根展示、不自动展开、也不拉文件树），避免 clone 中途的
   * 半棵树被当成"新文件到了"而层层展开。
   */
  cloning: z.boolean().default(false),
})
export type WorkspaceGitRepo = z.infer<typeof workspaceGitRepoSchema>

/**
 * 工作区 git 概况（`repos` 按"工作区根 → 一层子目录"的顺序，**空数组 = 这个工作区没有 git**）。
 * 只探两层：`/work` 里的常见形态就两种 —— 根是仓库，或 clone 到某个子目录（如 `qatt-platform-qa/`）。
 */
export const workspaceGitResultSchema = z.object({
  repos: z.array(workspaceGitRepoSchema),
})
export type WorkspaceGitResult = z.infer<typeof workspaceGitResultSchema>

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
  content: z.string({ required_error: validationMessage('validation.workspace.contentMissing') }),
  /**
   * 写前读到的版本号。`0` = "我认为这个文件还不存在"（新建）。
   * 与当前版本不一致 ⇒ 409（并发写冲突，§七 1 第 ③ 层）。
   */
  baseVersion: z.coerce
    .number()
    .int()
    .min(0, validationMessage('validation.workspace.baseVersionNotNegative'))
    .default(0),
})
export type WorkspaceWriteFileBody = z.infer<typeof workspaceWriteFileBodySchema>

/**
 * 「上传至平台」（`POST /api/conversations/:id/workspace/artifact`，2026-10-29）。
 *
 * Code 模式下**不再自动收产物**（用户定案：agent 动过的文件由工作区面板呈现即可）。
 * 要让某个文件进"产物面板 / 会话产物 / 可下载清单"，由人在文件树上**显式**点一次上传。
 * `path` = 工作区相对路径（文件必须已存在，服务端从**工作区字节**读取，不经浏览器重新上传）。
 */
export const workspaceArtifactBodySchema = z.object({
  path: workspacePathSchema,
})
export type WorkspaceArtifactBody = z.infer<typeof workspaceArtifactBodySchema>

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
  .refine((value) => value.from !== value.to, {
    message: validationMessage('validation.workspace.samePath'),
    path: ['to'],
  })
export type WorkspaceMoveBody = z.infer<typeof workspaceMoveBodySchema>

/** 路径查询参数（读 / 写 / 删共用：`?path=out/report.csv`） */
export const workspacePathQuerySchema = z.object({ path: workspacePathSchema })
export type WorkspacePathQuery = z.infer<typeof workspacePathQuerySchema>

/**
 * 删除文件夹（`DELETE /api/conversations/:id/workspace/dir?path=`）的结果。
 *
 * 语义 = **递归删除该目录下的所有已索引文件**：逐个软删（墓碑）+ 各落一条 `deleted` 事件，
 * 再把目录整份落盘删除（含未索引的残留，如依赖目录）。空目录 / 命中 0 个也按幂等成功回 `0`。
 *
 * ⚠️ 与单文件删除同族：**删前把每个文件的当前内容存进历史字节**（保留期内仍可在历史里找回）。
 */
export const workspaceDeleteDirResultSchema = z.object({
  path: z.string(),
  /** 实际软删（转墓碑）的文件数；目录为空 / 不存在时为 `0` */
  deleted: z.number().int().min(0),
})
export type WorkspaceDeleteDirResult = z.infer<typeof workspaceDeleteDirResultSchema>

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
export const WORKSPACE_CHANGE_SEGMENTS = ['current', 'earlier'] as const
/**
 * 这条变更属于**哪一段**：`current` = 本轮（最后一次 agent 派活窗口 + 其后的编辑），
 * `earlier` = 更早的轮次 / 更早的改动。
 *
 * ★ 2026-10-28（用户定案）：同一路径若**两段都动过**，清单里给**两条**（各带自己的版本范围），
 *   这样"更早改过、本轮又改过"是看得出来的。以前按路径折叠成一条，本轮那条会把更早那次盖掉。
 */
export type WorkspaceChangeSegment = (typeof WORKSPACE_CHANGE_SEGMENTS)[number]

export const workspaceChangeEntrySchema = z.object({
  path: z.string(),
  /** 这条路径**最后**一次事件的类型 */
  type: z.enum(WORKSPACE_EVENT_TYPES),
  /** 内容事件有版本；`claim`/`release` 为 `null` */
  version: z.number().int().min(1).nullable(),
  actor: z.enum(WORKSPACE_ACTORS),
  actorId: z.string().nullable(),
  at: z.string(),
  /**
   * **该段的基线版本**（这条路径在**这一段**第一次被改之前的版本）。
   *
   * ★ 2026-10-28（用户反馈「实际编辑了 2 行，本轮只展示 1 行」）：徽标/差异弹窗原来按
   *   `version - 1` 取基线，那是**最后一跳**（v24→v25），不是**这一段整体**（v23→v25）。
   *   同一轮里连改两次，就只看到最后一次改动，看起来像"改动丢了"。
   *   这里给出与「撤销本轮」**同一个判据**（`planWorkspaceRevert#beforeVersion`）算出的基线，
   *   差异一律按 `该段基线 → 该段末版本` 展示，与撤销回滚的落点完全一致。
   *
   * `null` = 该段开始时该路径**不存在**（新建）或无从判定（如 `deleted` 的边界）；
   * 缺省（`undefined`）= 这条清单没有窗口信息（全量口径），调用方退回"前一版"。
   */
  beforeVersion: z.number().int().min(1).nullable().optional(),
  /**
   * 这条属于哪一段（见 {@link WorkspaceChangeSegment}）。缺省 = `current`（实时事件天然是"此刻"）。
   *
   * 同一路径在两段都动过时，服务端会回**两条**（`current` + `earlier`），各自的
   * `beforeVersion → version` 就是那一段的版本范围。
   */
  segment: z.enum(WORKSPACE_CHANGE_SEGMENTS).optional(),
})
export type WorkspaceChangeEntry = z.infer<typeof workspaceChangeEntrySchema>

/**
 * 变更集响应 = `{ items, round }`（按 `at` 倒序；只含 `[since, now]` 窗口内动过的路径各一条）。
 *
 * ★ 2026-10-28（用户定案：「最近变更」按轮分组显示 本轮 / 更早）：把**本轮窗口**一并回给前端，
 *   让它能把同一份清单切成两段，而不必再发一次请求、也不必在前端猜"本轮从哪开始"。
 *
 * `round` 缺省（`undefined`）= 这个会话还没有过任何一轮（新会话 / 从没派过活）⇒ 全部算「更早」。
 * ⚠️ `start` 是本轮**起点**（`workspace.round.start`），不是"最近 24 小时"之类的近似。
 */
export const workspaceChangesResultSchema = z.object({
  items: z.array(workspaceChangeEntrySchema),
  /** 本轮窗口（Redis 轮次标记）；没有过轮次时缺省 */
  round: z
    .object({
      /** 本轮起点（ISO 8601）；`at >= start` 的条目算「本轮」 */
      start: z.string(),
      /** 本轮终点（ISO 8601）；轮还没收尾时缺省 */
      end: z.string().optional(),
    })
    .optional(),
})
export type WorkspaceChangesResult = z.infer<typeof workspaceChangesResultSchema>

/** 变更集查询（`GET /api/conversations/:id/workspace/changes?since=<iso>`；`since` 缺省 = 全量） */
export const workspaceChangesQuerySchema = z.object({
  /** 只看这个时刻**之后**（含）的事件（ISO 8601）。轮末用它 = 本轮开始时刻 */
  since: z.string().datetime({ offset: true }).optional(),
})
export type WorkspaceChangesQuery = z.infer<typeof workspaceChangesQuerySchema>

// ═════════════════════════════ 工作区保留期提示（2026-10-28） ═════════════════════════════

/**
 * 到期保护原因：命中任一 ⇒ 即使到了保留期，reaper 也**不会**清这个工作区。
 *
 * 依据 2026-10-28 用户反馈（agent 生成的 docx 被静默清掉）：到期清理必须让用户**提前**看见，
 * 且"工作区里装着交付物 / 我手写过"这两种情况不能真删。
 */
export const WORKSPACE_RETENTION_PROTECTIONS = ['ARTIFACT_PRESENT', 'USER_EDIT_PROTECTED'] as const
export type WorkspaceRetentionProtection = (typeof WORKSPACE_RETENTION_PROTECTIONS)[number]

/** 工作区保留期提示（`GET /api/conversations/:id/workspace/retention`） */
export const workspaceRetentionInfoSchema = z.object({
  /** 工作区保留期（天） */
  retentionDays: z.number().int(),
  /** 工作区**内容**最后一次变动（`workspaces.updated_at`）；`null` = 还没建过工作区 */
  updatedAt: z.string().nullable(),
  /** 预计清理时刻（ISO）；`null` = 还没建过 */
  expiresAt: z.string().nullable(),
  /** 该会话仍在保留期内的产物数（交付物） */
  artifactCount: z.number().int(),
  /** 用户手写的额外保护期（天；`0` = 关闭） */
  protectUserEditDays: z.number().int(),
  /** 命中的保护原因（空 = 到点会真删） */
  protectedReasons: z.array(z.enum(WORKSPACE_RETENTION_PROTECTIONS)),
  /** 等价于 `protectedReasons.length > 0`（前端直接读这一位） */
  protected: z.boolean(),
})
export type WorkspaceRetentionInfo = z.infer<typeof workspaceRetentionInfoSchema>

// ═════════════════════════════ 文件差异（P1-9 · 验收标记） ═════════════════════════════

/**
 * 逐行差异的一行。
 *   · `context` = 未变的行（两侧都有行号）；
 *   · `add` = 新增行（只有新行号）；`del` = 删除行（只有旧行号）；
 *   · `gap` = **被折叠的一长段未变行**（`gap` 记行数）—— 让长文件里"改在末尾"也能一眼看到改动。
 */
export const WORKSPACE_DIFF_LINE_TYPES = ['context', 'add', 'del', 'gap'] as const
export type WorkspaceDiffLineType = (typeof WORKSPACE_DIFF_LINE_TYPES)[number]

export const workspaceDiffLineSchema = z.object({
  type: z.enum(WORKSPACE_DIFF_LINE_TYPES),
  /** 旧文件行号（1-based）；`add` / `gap` 为 `null` */
  oldLine: z.number().int().min(1).nullable(),
  /** 新文件行号（1-based）；`del` / `gap` 为 `null` */
  newLine: z.number().int().min(1).nullable(),
  /** 行文本（`gap` 时为空串） */
  text: z.string(),
  /** 仅 `gap`：被折叠的未变行数 */
  gap: z.number().int().min(0).optional(),
})
export type WorkspaceDiffLine = z.infer<typeof workspaceDiffLineSchema>

/**
 * 一个文件"旧版本 → 当前"的行级差异（P1-9 · 验收）。
 *
 * 旧字节来自**历史字节存储**（`workspace/blob.ts`，覆盖/删除前自动存档）；当前字节来自宿主 FS。
 * 二进制 / 缺历史字节 / 超体积时 `available:false` 且 `lines` 为空，`message` 给一句人话原因。
 */
export const workspaceFileDiffSchema = z.object({
  path: z.string(),
  /** 对比的基线版本；`null` = 该文件在基线时不存在（= 新建，整篇都是新增） */
  baseVersion: z.number().int().min(1).nullable(),
  /** 当前版本；`null` = 当前已删除 / 不存在（整篇都是删除） */
  currentVersion: z.number().int().min(1).nullable(),
  /** 新增 / 删除行数（用于列表徽标 `+N −M`） */
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  /** 能否给出逐行差异（二进制 / 无历史字节时为 `false`） */
  available: z.boolean(),
  /** 不可用时的一句人话原因（`available:false` 才有） */
  message: z.string().optional(),
  /** 逐行差异因超上限被截断（`added`/`removed` 仍是完整计数） */
  truncated: z.boolean(),
  /** 逐行差异；`?stats=1` 时**省略**（只取徽标计数，不传逐行内容） */
  lines: z.array(workspaceDiffLineSchema).optional(),
})
export type WorkspaceFileDiff = z.infer<typeof workspaceFileDiffSchema>

/** 文件差异查询（`GET .../workspace/file/diff?path=…&baseVersion=…&stats=1`） */
export const workspaceFileDiffQuerySchema = z.object({
  path: z.string().min(1),
  /**
   * 显式指定基线版本；缺省 = 当前版本的前一版（新建时为 `null`）。
   *
   * ★ 2026-10-28：`0` = **明确"基线不存在"**（该段里这个文件是新建的）。缺省（不传）仍然是
   *   "用默认基线"。两者必须能区分 —— 「更早」那一段里"新建 → v2"与"v1 → v2"是两个不同的故事，
   *   而 `min(1)` 会把前者悄悄退化成后者。
   */
  baseVersion: z.coerce.number().int().min(0).optional(),
  /**
   * 差异的**到哪个版本**为止（缺省 = 当前盘上内容）。
   *
   * ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条，各自标明版本范围）：点「更早」那条时，
   *   要比的是**那一段**（`该段基线 → 该段末版本`），而不是一路比到此刻的文件内容 ——
   *   否则两行会给出同一个"从很久以前到现在"的差异，等于没分开。
   */
  toVersion: z.coerce.number().int().min(1).optional(),
  /** `1` = 只回计数（徽标用），不返回逐行差异 */
  stats: z.coerce.number().int().optional(),
  /**
   * `1` = 基线取**本轮基线**（这条路径在本轮第一次被改之前的版本），由服务端自己算。
   *
   * ★ 2026-10-28（用户反馈「编辑 4 行只显示 1 行，刷新后才变 +4 −3」）：`baseVersion` 由前端
   *   从清单里带过来，而清单会因为实时事件合并、`beforeVersion` 偶发缺失而退回"前一版"，
   *   于是**即时视图和刷新后不一致**。让服务端按同一窗口自己算基线，前端不必再传、
   *   也不会因合并丢字段而漂移。`baseVersion` 显式给了仍然优先（高级用法）。
   */
  roundBase: z.coerce.number().int().optional(),
})
export type WorkspaceFileDiffQuery = z.infer<typeof workspaceFileDiffQuerySchema>

/**
 * 把"旧 → 新"的逐行差异**折叠长段未变行**（纯函数，前后端共用）。
 *
 * ⚠️ 后端在 `workspace/diff.ts` 里已有等价实现（它产出带行号的序列）；本函数只负责把**已有的
 * `context` 长段**折成 `context(3) + gap + context(3)`，便于渲染端与回归脚本共用同一口径。
 */
export function collapseWorkspaceDiffContext(
  lines: readonly WorkspaceDiffLine[],
  contextLines = 3,
): WorkspaceDiffLine[] {
  const out: WorkspaceDiffLine[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.type !== 'context') {
      out.push(line)
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && lines[end]?.type === 'context') end += 1
    const run = end - index
    if (run <= contextLines * 2 + 1) {
      for (let cursor = index; cursor < end; cursor += 1) out.push(lines[cursor] as WorkspaceDiffLine)
    } else {
      for (let cursor = index; cursor < index + contextLines; cursor += 1) out.push(lines[cursor] as WorkspaceDiffLine)
      out.push({ type: 'gap', oldLine: null, newLine: null, text: '', gap: run - contextLines * 2 })
      for (let cursor = end - contextLines; cursor < end; cursor += 1) out.push(lines[cursor] as WorkspaceDiffLine)
    }
    index = end
  }
  return out
}

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

/**
 * 撤销**范围**（2026-10-28 用户定案：「撤销怎么选」）。
 *
 * 默认是 `AGENT_ONLY`（最安全）：用户手写是不可再生的，不许被一个"撤销本轮"顺手冲掉；
 * 想连手写一起撤，必须显式换成 `ALL` 或逐条勾选（`SELECTED`）。
 */
export const WORKSPACE_REVERT_SCOPES = ['AGENT_ONLY', 'ALL', 'SELECTED'] as const
export type WorkspaceRevertScope = (typeof WORKSPACE_REVERT_SCOPES)[number]

/** 撤销**跳过**的原因（预演三栏里"不会动"那一栏；前端按 key 取文案） */
export const WORKSPACE_REVERT_SKIP_REASONS = [
  /** 这一段以用户手写收尾 —— 默认范围下**故意不动**（不是漏了） */
  'USER_EDIT_EXCLUDED',
  /** 本轮末之后又被改过（不静默覆盖） */
  'CONFLICT',
  /** 历史字节缺失，无从还原 */
  'UNAVAILABLE',
  /** 改名/移动、二进制等本版不支持 */
  'UNSUPPORTED',
  /** 建了又删，净变化为零 */
  'NET_ZERO',
] as const
export type WorkspaceRevertSkipReason = (typeof WORKSPACE_REVERT_SKIP_REASONS)[number]

/**
 * 撤销**预演**（`dryRun=true` 时随结果一并回）：点之前就能看见"会还原什么 / 会删除什么 / 会跳过什么"。
 *
 * `skip` 里带原因 —— 尤其 `USER_EDIT_EXCLUDED` 必须**单独灰显并注明**，
 * 让用户知道"系统不是漏了，是故意没动你的手写"。
 */
export const workspaceRevertPreviewSchema = z.object({
  /** 会改写成某历史版本的路径 */
  restore: z.array(z.string()),
  /** 这一段新建的 ⇒ 撤销 = 删除 */
  remove: z.array(z.string()),
  /** 不会动，附原因 */
  skip: z.array(z.object({ path: z.string(), reason: z.enum(WORKSPACE_REVERT_SKIP_REASONS) })),
})
export type WorkspaceRevertPreview = z.infer<typeof workspaceRevertPreviewSchema>

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
  /**
   * 回滚点是怎么定的。
   *
   * ★ 2026-10-29 起「撤销本轮」= 文件级**退一步**（回到本段最后一跳之前那一版），
   *   所以现在固定回 `segment-start`（历史值，语义已变成"退一步"）；
   *   `after-user-edit` 只为兼容旧响应保留，新响应不再产生。
   */
  rollbackFrom: z.enum(['segment-start', 'after-user-edit']).optional(),
  /** 这一条在**默认范围**下是否会被勾选（用户手写收尾的为 `false`） */
  defaultSelected: z.boolean().optional(),
})
export type WorkspaceRevertEntry = z.infer<typeof workspaceRevertEntrySchema>

/** 撤销本轮响应（`{since, until, dryRun, items}`；`since`/`until` = 实际生效的窗口，ISO 8601） */
export const workspaceRevertResultSchema = z.object({
  since: z.string(),
  until: z.string(),
  /** 只预演不落盘（`dryRun`）：`items` 的动作是"将会怎样" */
  dryRun: z.boolean(),
  items: z.array(workspaceRevertEntrySchema),
  /** 本次实际生效的撤销范围（回显，便于前端把预演与结果对齐） */
  scope: z.enum(WORKSPACE_REVERT_SCOPES).optional(),
  /** 预演三栏：会还原 / 会删除 / 会跳过（缺省 = 没算，`dryRun=true` 时一定有） */
  preview: workspaceRevertPreviewSchema.optional(),
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
  /**
   * 撤销范围（2026-10-28 用户定案，见 `子方案`「撤销怎么选」）：
   *   · `AGENT_ONLY`（**缺省**）：只撤 agent 覆盖过的文件 —— 这一段**最后一次写入是 agent** 的路径；
   *   · `ALL`：这一段里出现过就撤（**含用户手写**，显式选择才生效）；
   *   · `SELECTED`：只撤 `paths` 里列出的路径（逐条勾选）。
   */
  scope: z.enum(WORKSPACE_REVERT_SCOPES).optional(),
  /** `scope=SELECTED` 时勾选的路径（其它范围忽略） */
  paths: z.array(z.string().min(1)).max(5000).optional(),
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