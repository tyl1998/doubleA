/**
 * 工作区服务（P1-9 · P0）—— 版本索引 + CAS 写 + 事件，坐在"宿主 FS 字节"之上
 *
 * 依据：`docs/子方案/Code模式工作区.md` §二（三层职责）、§四 2（版本模型）、§七 1（四层防护里的
 *      串行 / CAS）、§九（配额）、§十四（接回点）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一条写 = 五件事，**顺序与原子性都是正确性的一部分**
 * ─────────────────────────────────────────────────────────────────────
 *   ① 路径判据（`resolveWorkspacePath`：归一化 + realpath 包含性）；
 *   ② 配额判据（单文件 / 文件数 / 总量）；
 *   ③ **CAS**：请求带的 `baseVersion` 必须等于当前版本，否则 **409**（杜绝静默覆盖）；
 *   ④ 落字节（原子写）；
 *   ⑤ 落索引（文件行 + 版本行 + 事件行 + `headVersion`）**同一事务**，提交后才发实时事件。
 *
 * ⚠️ ③ 必须在 ④ 之前：反过来就是"先覆盖了再报冲突"，那正是要杜绝的静默覆盖。
 * ⚠️ ⑤ 里事件与文件行同事务：否则会出现"索引新了、前端没收到事件"（断线补发游标也停在原地）。
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { appMsg,
  AppError,
  WORKSPACE_CONTENT_EVENT_TYPES,
  foldWorkspaceEvents,
  isWorkspaceTextMime,
  planWorkspaceRevert,
  workspaceMimeOf,
  type WorkspaceActor,
  type WorkspaceChangesResult,
  type WorkspaceDeleteDirResult,
  type WorkspaceEventItem,
  type WorkspaceFileEntry,
  type WorkspaceFileDiff,
  type WorkspaceFileRead,
  type WorkspaceRevertEntry,
  type WorkspaceRevertResult,
  type WorkspaceTreeResult,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { Prisma, getPrisma } from '../infra/prisma.js'
import { putWorkspaceBlob, readWorkspaceBlob } from './blob.js'
import { restoreWorkspaceFromCold, scheduleWorkspaceBlobBackup } from './cold.js'
import { lineDiffWorkspace } from './diff.js'
import { publishWorkspaceEventItem, toWorkspaceEventItem, workspaceEventCreateData } from './events.js'
import { resolveWorkspacePath, workspaceDirOf } from './paths.js'
import { readWorkspaceRoundWindow } from './round.js'
import { ensureWorkspaceOwner } from '../sandbox/owner.js'
import { decideWorkspaceQuota } from './quotaModel.js'
import { isWorkspaceDependencyPath } from './dependencyModel.js'
import { workspaceDirPrefix } from './dirModel.js'
import {
  ensureWorkspaceDir,
  moveWorkspaceFile as fsMove,
  readWorkspaceBytes,
  removeWorkspaceDir as fsRemoveDir,
  removeWorkspaceFile as fsRemove,
  workspaceContentIsBinary,
  workspaceDirIsEmpty,
  workspaceFileSize,
  writeWorkspaceBytes,
} from './store.js'

/** 一个会话的工作区句柄 */
export interface WorkspaceHandle {
  conversationId: string
  /** 宿主 canonical 目录（绝对路径） */
  rootPath: string
}

/** 一次写的发起者（落 `updated_by` / `updated_by_id`） */
export interface WorkspaceWriteActor {
  actor: WorkspaceActor
  actorId?: string | null
}

/** sha256（内容寻址 / 判"是否真变"） */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 同一个会话里"写索引"的**互斥**（P1-21）。
 *
 * ★ 为什么需要（2026-10-21 真机复现）：中介写（agent 的 `write`/`edit`）与 watcher 的
 *   `reconcileWorkspaceOnce`（1 秒一轮）都会在**事务外**算 `nextVersion = 当前版本 + 1`，再在事务里
 *   写 `workspace_files` 与 `workspace_file_versions`。两者交错时，后进事务的一方仍拿旧版本号去
 *   `create` ⇒ 撞唯一约束 `(file_id, version)`（Prisma `P2002`），整笔写 **500**。
 *   盘上字节其实已经写下去了（`writeWorkspaceBytes` 在事务之前）⇒ 症状正是"agent 明明改了文件，
 *   界面没有任何变化、还报错"。
 *
 * 口径：**同一个会话内的写索引串行化**（进程内排队）——
 *   · 粒度是"会话"而不是"文件"：会话内的写量很小（一次写几个 ms），串行不会成为瓶颈；
 *   · 只包住"算版本 → 事务 → 发事件"这一段，**不包**读盘/写盘/存历史字节（那些是慢 IO）；
 *   · 多实例部署时进程内锁管不到另一台 —— 所以版本行插入仍走
 *     {@link createVersionRowIfAbsent}（撞了就当"对方已记下"，不把写打成 500）。两道一起上：
 *     同机不撞、跨机撞了也不炸。
 */
const writeIndexLocks = new Map<string, Promise<unknown>>()

async function withWorkspaceWriteLock<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
  const previous = writeIndexLocks.get(conversationId) ?? Promise.resolve()
  // `then(run, run)`：前一个写失败也要继续跑下一个（队列不能被一次失败堵死）
  const next = previous.then(run, run)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  writeIndexLocks.set(conversationId, tail)
  try {
    return await next
  } finally {
    // 队尾仍是我 ⇒ 清键（不清的话这张 Map 会随会话数无限增长；有后来者时由后来者清）
    if (writeIndexLocks.get(conversationId) === tail) writeIndexLocks.delete(conversationId)
  }
}

/**
 * 把一份内容存进**历史字节**存储（P4 · R2；`blob.ts`）并排入 S3 冷备（P5 · R3；`cold.ts`）。
 *
 * ⚠️ **尽力而为**：它服务的是"事后能还原 / 换机能重建"，与本轮这次写是否成功**无关** ——
 * 存储失败只 warn，绝不让一次正常的工作区写因为"备份没存上"而失败（同产物/记忆等旁路纪律）。
 *
 * ⚠️ **本地 + 远端都在这一个函数里排队**：覆盖写/删除前的**旧**内容与随后的**新**内容都会流经
 * 这里 ⇒ 任一历史版本既有宿主本地副本（撤销本轮）、又有 S3 副本（换机重建）。
 */
async function stashWorkspaceBytes(conversationId: string, data: Buffer): Promise<void> {
  const hash = sha256(data)
  try {
    await putWorkspaceBlob(config.workspace.root, conversationId, hash, data)
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '工作区历史字节落盘失败（该版本将不可还原）')
  }
  scheduleWorkspaceBlobBackup(conversationId, hash, data)
}

/** 把**盘上现存**的某文件内容存进历史字节存储（覆盖/删除前调用；不存在/读失败则无事） */
async function stashCurrentFileIfAny(conversationId: string, absolute: string): Promise<void> {
  try {
    await stashWorkspaceBytes(conversationId, await readWorkspaceBytes(absolute))
  } catch {
    // 盘上没有（新建 / 已被外部删）——无需备份，静默
  }
}

/**
 * 懒创建：确保这个会话的工作区目录与 DB 行都存在（幂等）。
 *
 * ★ **冷备恢复的唯一入口**（P1-9 · R3，§四 4）：若目录**缺失/为空**（换机、宿主重建、目录被清），
 *   先确保 DB 行在，再从 S3 按最新版本把字节还原回目录 —— 这是"容器可丢弃 / 宿主迁移可重建"的兑现点。
 *   ⚠️ **只在目录空时还原**：目录有内容时绝不回滚（否则会把人和 agent 正在编辑的工作区覆盖回冷备）。
 *
 * ⚠️ 目录路径**由当前配置推导**（`WORKSPACE_ROOT/{conversationId}`），而 `rootPath` 落库只为留痕；
 * 多机换机时新宿主以自己盘上的路径重建目录并覆写（§十六 E）。
 */
export async function ensureWorkspace(conversationId: string): Promise<WorkspaceHandle> {
  const rootPath = workspaceDirOf(config.workspace.root, conversationId)
  // 判据必须先于 `ensureWorkspaceDir`：后者会把目录建出来，之后再判就永远"不为空"了
  const needsRestore = await workspaceDirIsEmpty(rootPath)
  await ensureWorkspaceDir(rootPath)
  const prisma = getPrisma()
  const existing = await prisma.workspace.findUnique({ where: { conversationId }, select: { conversationId: true } })
  if (existing === null) {
    // ★ **只在行缺失时才写**（P1-9 · R5）：`@updatedAt` 会在任何 update 上推进，而 `ensureWorkspace`
    //   是**读路径**（树/读/SSE、watcher 每秒对账都会走它）。若每次都对已存在的行 `upsert`
    //   （哪怕 `update: {}`），`workspaces.updated_at` 会被读操作持续刷新 ⇒「保留期清理」永远等不到
    //   "超期"。此处的 `upsert` 只兜"两处并发首次创建"这一竞态（非缺失路径不写）。
    await prisma.workspace.upsert({
      where: { conversationId },
      create: { conversationId, rootPath, headVersion: 0n },
      update: {},
    })
  }
  if (needsRestore) {
    await restoreWorkspaceFromCold(conversationId).catch((error: unknown) => {
      // 还原失败不影响"目录已就绪"：以现有目录为准，缺的内容由后续写/读自然补齐
      getLogger().warn({ err: error, conversationId }, '工作区冷备恢复失败（以现有目录为准继续）')
    })
  }
  // ★ P1-9 · R9 / P1-14 §十六 B：**钉机记录**（会话→实例目录）在工作区首次触达时写入，
  //   寿命跟随工作区（`retentionDays` 天，见 `sandbox/owner.ts#workspaceOwnerTtlSec`），
  //   而不是复用容器那 2h 的目录 TTL —— 否则容器回收后会话会被重钉到别的实例、工作区留在原机。
  //   ⚠️ 它**早于建容器**：人与 agent 都可能先编辑（`ensureWorkspace` 是读写/树/冷备恢复的公共入口），
  //   于是"工作区建在 B、容器建在 C"这种 bind mount 指空目录的情况不会发生。
  //   ⚠️ **尽力而为**（失败只 warn）：钉机是路由正确性的旁路，不该让一次正常的工作区读/写
  //   因为 Redis 抖动而失败（单实例下目录恒命中自己，漏钉的代价为零）。
  await ensureWorkspaceOwner(conversationId).catch((error: unknown) => {
    getLogger().warn({ err: error, conversationId }, '工作区钉机记录写入失败（多机下路由可能不粘性；单机无影响）')
  })
  return { conversationId, rootPath }
}

/** 文件树（DB 索引查询；**不 ListObjects / 不扫盘** —— §六 1） */
export async function listWorkspaceFiles(conversationId: string): Promise<WorkspaceTreeResult> {
  await ensureWorkspace(conversationId)
  const rows = await getPrisma().workspaceFile.findMany({
    where: { conversationId, deletedAt: null },
    orderBy: { path: 'asc' },
    select: { path: true, size: true, mime: true, version: true, updatedBy: true, updatedAt: true },
  })
  return { items: rows.map(toFileEntry) }
}

/** 读文件（文本在体积闸门内内联返回 `text`，其余 `text: null` 走字节出口） */
export async function readWorkspaceFile(conversationId: string, rawPath: unknown): Promise<WorkspaceFileRead> {
  const source = await openWorkspaceFileSource(conversationId, rawPath)
  const inlineMax = config.workspace.textInlineMaxMb * 1024 * 1024
  // ★ 二进制闸门（P1-9 · P6 · R6）：扩展名说是文本、**内容**却含二进制字节（如改名后的 PNG）
  //   ⇒ 不给内联文本（`text: null`），前端走只读预览 / 下载 —— 否则编辑器里是一屏乱码。
  const text =
    isWorkspaceTextMime(source.mime) && !source.binary && source.size <= inlineMax
      ? source.body.toString('utf8')
      : null

  return {
    path: source.path,
    version: source.version,
    size: source.size,
    mime: source.mime,
    text,
  }
}

/** 字节出口的取流结果（`GET .../workspace/file/raw`；形状对齐 `artifact.service#openArtifactSource`） */
export interface WorkspaceFileSource {
  path: string
  size: number
  mime: string
  version: number
  body: Buffer
  /** 内容嗅探结论（含 NUL ⇒ 二进制；P1-9 · P6 · R6）。取流方可据此决定是否当文本处理 */
  binary: boolean
}

/**
 * 打开一个工作区文件的**字节出口**（读原始字节 + `mime`/`version`）。
 *
 * ⚠️ 与 {@link readWorkspaceFile} 共用"盘上有、索引没有就补索引"的达致逻辑；区别只在这里
 * **始终回字节**（不判文本），供二进制 / 大文件的下载与预览走 {@link workspaceRawHeadersFor} 那组分派头。
 */
export async function openWorkspaceFileSource(conversationId: string, rawPath: unknown): Promise<WorkspaceFileSource> {
  const handle = await ensureWorkspace(conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, rawPath)

  let row = await findLiveRow(conversationId, relative)
  if (row === null) {
    if ((await workspaceFileSize(absolute)) === undefined) throw AppError.notFound(appMsg('app.m033'))
    await syncFileFromDisk(conversationId, handle.rootPath, relative, { actor: 'SYSTEM' })
    row = await findLiveRow(conversationId, relative)
    if (row === null) throw AppError.notFound(appMsg('app.m033'))
  }

  const body = await readWorkspaceBytes(absolute)
  return {
    path: row.path,
    size: body.byteLength,
    mime: row.mime,
    version: row.version,
    body,
    binary: workspaceContentIsBinary(body),
  }
}

/**
 * 归属判据（**仅本人**，与产物/会话同族）：会话不存在或不属于 `userId` 一律 404。
 *
 * 路由层在动工作区之前调它一次；工作区服务自身不重复判（判据只有一处，见文件头）。
 */
export async function assertWorkspaceOwner(conversationId: string, userId: string): Promise<void> {
  const owned = await getPrisma().conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } })
  if (owned === null) throw AppError.notFound(appMsg('app.m001'))
}

/**
 * 断线补发：取"工作区事件序号 `headVersion` 大于 `after`"的事件（时间正序）。
 *
 * ★ `headVersion` = 事件**累计条数**（每次落事件都 +1，且事件从不单独删除，只随会话级联）
 * ⇒ "缺了多少条" = `headVersion - after`，取最近这么多条即可。⚠️ 这个恒等式是本函数成立的
 * **前提**：任何"落事件而不 +headVersion"或"删事件"的改动都会让它算错（`events.ts` 已把两者放同一事务）。
 *
 * @param after 调用方上次看到的 `headVersion`；`0`/缺省 = 从头补发（上限 {@link WORKSPACE_EVENT_REPLAY_MAX}）
 */
export async function listWorkspaceEventsAfter(
  conversationId: string,
  after: number,
): Promise<WorkspaceEventItem[]> {
  const workspace = await getPrisma().workspace.findUnique({
    where: { conversationId },
    select: { headVersion: true },
  })
  if (workspace === null) return []
  const missed = Number(workspace.headVersion) - after
  if (missed <= 0) return []
  const take = Math.min(missed, WORKSPACE_EVENT_REPLAY_MAX)
  const rows = await getPrisma().workspaceEvent.findMany({
    where: { conversationId },
    orderBy: { at: 'desc' },
    take,
    select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
  })
  return rows.reverse().map(toWorkspaceEventItem)
}

/** 一次断线补发的上限（防"离线很久"时一次拉巨量事件把内存/带宽打满） */
export const WORKSPACE_EVENT_REPLAY_MAX = 500

/**
 * 轮末**变更集**（P4）：`[since, now]` 窗口内动过的路径，各折叠成一条（最新状态）。
 *
 * 依据：`子方案/Code模式工作区.md` §六 3（轮末变更集 = "本轮这个工作区动过哪些文件"）。
 * `since` 缺省 = 全量（不筛时间）。折叠口径 = `shared#foldWorkspaceEvents`（纯函数，前后端共用）。
 */
export async function listWorkspaceChanges(conversationId: string, since?: string): Promise<WorkspaceChangesResult> {
  const rows = await getPrisma().workspaceEvent.findMany({
    where: {
      conversationId,
      // ★ 只认**内容事件**（`created`/`updated`/`deleted`/`renamed`；P1-20）：`claim`/`release`
      //   是文件级软锁的取放，**不改变字节**。它们在折叠里会成为某条路径的"最新状态"，
      //   把真正的 `updated` 顶掉 ⇒「最近变更」显示成一条中性的锁事件（看起来像"没改"）。
      type: { in: [...WORKSPACE_CONTENT_EVENT_TYPES] },
      ...(since === undefined ? {} : { at: { gte: new Date(since) } }),
    },
    orderBy: { at: 'asc' },
    select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
  })
  return { items: foldWorkspaceEvents(rows.map(toWorkspaceEventItem)) }
}

/**
 * 一个文件"旧版本 → 当前"的**行级差异**（P1-9 · 验收标记）。
 *
 * 旧字节走**历史字节存储**（`blob.ts`：覆盖 / 删除前自动存档，§七 5）；当前字节走宿主 FS。
 * 基线缺省 = 当前版本的前一版（新建时 `null` = 整篇新增；软删墓碑取**保留的那个版本** = 整篇删除）。
 *
 * 二进制 / 无历史字节 / 超体积 ⇒ `available:false` + `message`，**不编造**差异。
 *
 * @param statsOnly `true` = 不回逐行内容（只给 `+N −M` 徽标用的计数）——「最近变更」每行一个徽标时用，
 *        避免为一个列表把多份大文件的逐行差异都传回浏览器。
 */
export async function getWorkspaceFileDiff(
  conversationId: string,
  rawPath: unknown,
  baseVersion: number | undefined,
  statsOnly: boolean,
): Promise<WorkspaceFileDiff> {
  const handle = await ensureWorkspace(conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, rawPath)
  const row = await findRow(conversationId, relative)
  const currentDeleted = row === null || row.deletedAt !== null
  const currentVersion = currentDeleted ? null : (row as FileRow).version

  // 基线版本：
  //   · 显式给了就用它；否则——当前存在 ⇒ 前一版（v1 = 新建，前一版为 null）；
  //     当前是墓碑 ⇒ **保留的那个版本**（= 被删那一刻的内容，整篇都算删除）。
  const base =
    baseVersion ??
    (row === null ? null : row.deletedAt !== null ? row.version : row.version > 1 ? row.version - 1 : null)

  let oldText = ''
  if (base !== null) {
    const hash = await versionHashOf(conversationId, relative, base)
    if (hash === null) {
      return diffUnavailable(relative, base, currentVersion, `基线版本 v${base} 无索引（可能早于本功能）`)
    }
    const bytes = await readWorkspaceBlob(config.workspace.root, conversationId, hash)
    if (bytes === null) {
      return diffUnavailable(relative, base, currentVersion, `基线版本 v${base} 的字节缺失（冷备前的历史）`)
    }
    if (workspaceContentIsBinary(bytes)) {
      return diffUnavailable(relative, base, currentVersion, '二进制文件不支持逐行差异')
    }
    oldText = bytes.toString('utf8')
  }

  let newText = ''
  if (!currentDeleted) {
    try {
      const bytes = await readWorkspaceBytes(absolute)
      if (workspaceContentIsBinary(bytes)) {
        return diffUnavailable(relative, base, currentVersion, '二进制文件不支持逐行差异')
      }
      newText = bytes.toString('utf8')
    } catch {
      // 盘上读不到（刚被删 / 权限）⇒ 当作"当前为空"，不编造内容
      newText = ''
    }
  }

  const result = lineDiffWorkspace(oldText, newText)
  return {
    path: relative,
    baseVersion: base,
    currentVersion,
    added: result.added,
    removed: result.removed,
    available: true,
    ...(result.truncated ? { message: '文件较大，仅显示前部分差异' } : {}),
    truncated: result.truncated,
    ...(statsOnly ? {} : { lines: result.lines }),
  }
}

/** 差异不可用时的统一形状（`available:false`；`lines` 省略） */
function diffUnavailable(
  path: string,
  baseVersion: number | null,
  currentVersion: number | null,
  message: string,
): WorkspaceFileDiff {
  return {
    path,
    baseVersion,
    currentVersion,
    added: 0,
    removed: 0,
    available: false,
    message,
    truncated: false,
  }
}

/** 撤销者身份（`SYSTEM` —— 它既不是 agent 也不是"此刻的人"，是平台代人执行的回退） */
const REVERT_ACTOR: WorkspaceWriteActor = { actor: 'SYSTEM', actorId: null }

/**
 * 「撤销本轮」（P4 · R2）—— 把一轮内 agent/人的写入回退到**轮初版本**。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §七 5。窗口 = `[since, until]`：
 *   · 缺省由服务端读**本轮标记**（{@link readWorkspaceRoundWindow}，TaskAgent 一轮起止时记录）；
 *   · 显式传入用于"撤销某个已知窗口"（测试 / 高级用法）。
 *
 * 每条路径按 {@link planWorkspaceRevert} 折叠出 `beforeVersion` / `expect`，再**走同一套 CAS 回写**：
 *   · 轮初不存在 ⇒ 删除；轮初有版本 ⇒ 从**历史字节**（`blob.ts`）取回写回；
 *   · 当前版本 ≠ 轮末版本（此后有人又动过）⇒ **不静默覆盖**，该条记 `conflict`；
 *   · 轮初字节缺失（冷备前的历史）⇒ 记 `unavailable`；二进制 / 改名 ⇒ `unsupported`。
 *
 * @throws AppError(VALIDATION) 既无显式 `since`、也没有本轮标记
 */
export async function revertWorkspaceRound(
  conversationId: string,
  options: { since?: string; until?: string; dryRun?: boolean } = {},
): Promise<WorkspaceRevertResult> {
  await ensureWorkspace(conversationId)
  const window = await resolveRevertWindow(conversationId, options)
  const rows = await getPrisma().workspaceEvent.findMany({
    where: {
      conversationId,
      at: { gte: new Date(window.since), ...(window.until === undefined ? {} : { lte: new Date(window.until) }) },
    },
    orderBy: { at: 'asc' },
    select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
  })
  const plan = planWorkspaceRevert(rows.map(toWorkspaceEventItem))
  const dryRun = options.dryRun === true
  const items: WorkspaceRevertEntry[] = []
  for (const entry of plan) items.push(await applyRevertEntry(conversationId, entry, dryRun))
  return { since: window.since, until: window.until ?? new Date().toISOString(), dryRun, items }
}

/** 解析撤销窗口：显式 `since` 优先；否则读本轮标记（起点缺失 ⇒ 明确的 VALIDATION） */
async function resolveRevertWindow(
  conversationId: string,
  options: { since?: string; until?: string },
): Promise<{ since: string; until?: string }> {
  if (options.since !== undefined) {
    return { since: options.since, ...(options.until === undefined ? {} : { until: options.until }) }
  }
  const marker = await readWorkspaceRoundWindow(conversationId)
  if (marker.start === undefined) {
    throw AppError.validation(appMsg('app.m237'))
  }
  return { since: marker.start, ...(marker.end === undefined ? {} : { until: marker.end }) }
}

/** 轮初版本 → 字节内容 hash（版本表按 `(fileId, version)` 唯一） */
async function versionHashOf(conversationId: string, path: string, version: number): Promise<string | null> {
  const file = await getPrisma().workspaceFile.findUnique({
    where: { conversationId_path: { conversationId, path } },
    select: { id: true },
  })
  if (file === null) return null
  const row = await getPrisma().workspaceFileVersion.findUnique({
    where: { fileId_version: { fileId: file.id, version } },
    select: { contentHash: true },
  })
  return row?.contentHash ?? null
}

/** 落一条撤销（CAS 校验 → 删除 / 写回 / 记结论） */
async function applyRevertEntry(
  conversationId: string,
  entry: ReturnType<typeof planWorkspaceRevert>[number],
  dryRun: boolean,
): Promise<WorkspaceRevertEntry> {
  const row = await findRow(conversationId, entry.path)
  const currentVersion = row?.version ?? 0
  const currentDeleted = row === null || row.deletedAt !== null
  const base = { path: entry.path, currentVersion, fromVersion: entry.beforeVersion }

  if (entry.unsupported !== undefined) {
    return { ...base, action: 'unsupported', toVersion: null, message: entry.unsupported }
  }

  // CAS：确认"此后无人再动"（轮末状态 == 当前状态）
  if (entry.expect.deleted) {
    if (!currentDeleted) {
      return { ...base, action: 'conflict', toVersion: null, message: '轮末之后该文件又被改动，未自动覆盖' }
    }
  } else if (currentDeleted || currentVersion !== entry.expect.version) {
    return {
      ...base,
      action: 'conflict',
      toVersion: null,
      message: `轮末之后该文件又被改动（当前 v${currentVersion}），未自动覆盖`,
    }
  }

  // 轮初不存在 ⇒ 撤销 = 删除（本轮新建的）
  if (entry.beforeVersion === null) {
    if (currentDeleted) {
      return { ...base, action: 'skipped', toVersion: null, message: '本轮内建了又删，净变化为零' }
    }
    if (!dryRun) await deleteWorkspaceFile(conversationId, entry.path, REVERT_ACTOR)
    return { ...base, action: 'deleted', toVersion: null }
  }

  // 轮初有版本 ⇒ 取历史字节写回
  const hash = await versionHashOf(conversationId, entry.path, entry.beforeVersion)
  if (hash === null) {
    return { ...base, action: 'unavailable', toVersion: null, message: `轮初版本 v${entry.beforeVersion} 无索引` }
  }
  const bytes = await readWorkspaceBlob(config.workspace.root, conversationId, hash)
  if (bytes === null) {
    return {
      ...base,
      action: 'unavailable',
      toVersion: null,
      message: `轮初版本 v${entry.beforeVersion} 的字节缺失（冷备前的历史）`,
    }
  }
  const mime = workspaceMimeOf(entry.path)
  // 二进制（按扩展名**或**按内容嗅探，P6 · R6）都不支持整轮撤销：写回要走文本写接口，
  // 而该接口对二进制一律拒收 —— 这里如实记 `unsupported`，不让它在写回时炸出 VALIDATION。
  if (!isWorkspaceTextMime(mime) || workspaceContentIsBinary(bytes)) {
    return {
      ...base,
      action: 'unsupported',
      toVersion: null,
      message: isWorkspaceTextMime(mime) ? '文件内容为二进制，不支持整轮撤销' : `二进制文件（${mime}）不支持整轮撤销`,
    }
  }
  if (dryRun) return { ...base, action: 'restored', toVersion: null }
  const written = await writeWorkspaceFile(conversationId, entry.path, bytes.toString('utf8'), currentVersion, REVERT_ACTOR)
  return { ...base, action: 'restored', toVersion: written.version }
}


/**
 * 写一条文件历史（`workspace_file_versions`），**容忍 (fileId, version) 的唯一约束冲突**。
 *
 * ★ **P1-21 修的是真实故障（2026-10-21，真机复现）**：中介写（agent 的 `write`/`edit`）与
 *   watcher 的 `reconcileWorkspaceOnce`（1 秒一轮，读盘 → `syncFileFromDisk`）会**同时**推进同一个
 *   文件：两边各自读到 `version = N`、都打算写 `N+1`，后者在 `create` 上撞
 *   `workspace_file_versions_file_id_version_key`（Prisma `P2002`）。
 *   症状是中介写**整笔 500**（工作区代理回 500 → 引擎的 `write` 失败 → 前端看到"agent 在改文件
 *   但修改没落地"），而盘上的字节其实已经写下去了（`writeWorkspaceBytes` 在事务之前）——
 *   于是"文件变了、索引没变、版本表炸了"。
 *
 * 口径：
 *   · **版本行已存在**（同一个 `(fileId, version)`）⇒ 说明另一个写者已经把它记下了，
 *     **跳过**即可：这一行的语义是"这个文件曾有过这个版本"，重复记录没有信息增量；
 *   · 其它错误照旧抛出（不能把真正的写失败悄悄吞掉）。
 *
 * ⚠️ 行内容（hash）可能与本事务算出来的不同：那正是竞态的另一个写者赢了的证据，
 *   而这恰恰是我们要的结果（先写赢的一方已经被记录）。
 */
async function createVersionRowIfAbsent(
  tx: Pick<Prisma.TransactionClient, 'workspaceFileVersion'>,
  data: { fileId: string; version: number; contentHash: string; actor: WorkspaceActor; actorId: string | null },
): Promise<void> {
  try {
    await tx.workspaceFileVersion.create({ data })
  } catch (error) {
    if (isUniqueViolation(error)) return
    throw error
  }
}

/** Prisma `P2002`（唯一约束）判定 —— 只认这一种，别的错误一律往外抛 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/**
 * 写入字节（文本写 / 上传两条入口共用的核心）—— **CAS 是核心**。
 *
 * @param baseVersion 写前读到的版本；`0` = 认为文件不存在（新建）
 * @param options.allowBinary `true` 时跳过二进制类型闸门（**仅显式上传**走这条）：
 *   上传是用户对"把这个字节放进来"的明确意图，二进制照样可以落地（读取侧本就只读预览 / 下载）；
 *   而文本编辑器的保存（`writeWorkspaceFile`）仍按 P6 · R6 拒收二进制，避免一屏乱码被写回。
 * @throws AppError(CONFLICT) `baseVersion` 与当前版本不符（并发写冲突）
 * @throws AppError(VALIDATION) 路径非法 / 超配额 / （文本入口）内容为二进制；`data.violation`
 */
async function writeWorkspaceFileBytes(
  conversationId: string,
  rawPath: unknown,
  data: Buffer,
  baseVersion: number,
  author: WorkspaceWriteActor,
  options: { allowBinary?: boolean; overwrite?: boolean } = {},
): Promise<WorkspaceFileEntry> {
  const handle = await ensureWorkspace(conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, rawPath)

  // ★ P1-17b：依赖目录是**环境不是内容** ⇒ 中介写（编辑器 / agent 的 write）不许落进去。
  //   与"索引不列依赖目录"同一条判据（`dependencyModel`，名单一处定义）；拒绝而不是静默落盘，
  //   否则会出现"盘上有、文件树里没有"的第三态（最难解释）。
  assertNotDependencyPath(relative)

  const existingRow = await findRow(conversationId, relative)
  // 墓碑行按"已删除"处理：它的 version 照样参与 CAS（写回需带该版本，与 `delete` 的语义对齐）
  const currentVersion = existingRow === null ? 0 : existingRow.version
  // `overwrite`（上传）不做 CAS：目标已存在就直接覆盖（文件管理器"上传"的常见语义）；
  // 文本保存（默认）仍严格 CAS，冲突即 409。
  if (options.overwrite !== true && baseVersion !== currentVersion) {
    throw AppError.conflict(appMsg('app.m238'), {
      path: relative,
      currentVersion,
      expectedVersion: baseVersion,
    })
  }

  // 更严的写闸门（P1-9 · P6 · R6）：二进制类型闸门 + 单文件大小 / 活文件数 / 行数（含墓碑）/ 总字节。
  // ⚠️ 必须在 ④ 落字节**之前**判（见文件头 ②/③）：先判后写，否则是"写进去了才发现超限"。
  await assertWithinQuota(conversationId, data.byteLength, {
    isNewFile: existingRow === null || existingRow.deletedAt !== null,
    createsRow: existingRow === null,
    binary: options.allowBinary === true ? false : workspaceContentIsBinary(data),
  })

  const hash = sha256(data)
  // 历史字节（P4 · R2）：先把将被覆盖的旧内容存档，再落新内容（两个版本都可还原）
  await stashCurrentFileIfAny(conversationId, absolute)
  await writeWorkspaceBytes(absolute, data)
  await stashWorkspaceBytes(conversationId, data)

  const mime = workspaceMimeOf(relative)
  const now = new Date()
  // ★ P1-21：**版本号必须在锁内重读**。锁外那次读（`currentVersion`）只用于 CAS 校验 ——
  //   在"读盘 → 写盘 → 落索引"这段窗口里，watcher 可能已经把同一个文件推进了一版；
  //   若这里仍用锁外那个数算 `nextVersion`，就会与 watcher 的记录撞唯一约束（整笔 500）。
  const event = await withWorkspaceWriteLock(conversationId, async () => {
    const latest = await findRow(conversationId, relative)
    const nextVersion = (latest?.version ?? 0) + 1
    return await getPrisma().$transaction(async (tx) => {
      const file = await tx.workspaceFile.upsert({
        where: { conversationId_path: { conversationId, path: relative } },
        create: {
          conversationId,
          path: relative,
          size: BigInt(data.byteLength),
          mime,
          contentHash: hash,
          version: nextVersion,
          updatedBy: author.actor,
          updatedById: author.actorId ?? null,
          deletedAt: null,
        },
        update: {
          size: BigInt(data.byteLength),
          mime,
          contentHash: hash,
          version: nextVersion,
          updatedBy: author.actor,
          updatedById: author.actorId ?? null,
          deletedAt: null,
        },
        select: { id: true },
      })
      // ⚠️ 与 watcher 对账并发时这一步会撞唯一约束 ⇒ 走容忍版（见 `createVersionRowIfAbsent`）
      await createVersionRowIfAbsent(tx, {
        fileId: file.id,
        version: nextVersion,
        contentHash: hash,
        actor: author.actor,
        actorId: author.actorId ?? null,
      })
      const created = await tx.workspaceEvent.create({
        data: workspaceEventCreateData({
          conversationId,
          type: currentVersion === 0 ? 'created' : 'updated',
          path: relative,
          version: nextVersion,
          actor: author.actor,
          actorId: author.actorId ?? null,
          at: now,
        }),
        select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
      })
      await tx.workspace.updateMany({ where: { conversationId }, data: { headVersion: { increment: 1 } } })
      return { event: toWorkspaceEventItem(created), version: nextVersion }
    })
    })
    publishWorkspaceEventItem(conversationId, event.event)

  return { path: relative, size: data.byteLength, mime, version: event.version, updatedBy: author.actor, updatedAt: now.toISOString() }
}

/** 写文件（`PUT .../workspace/file?path=`）—— **文本入口**，等价于"字节核心 + UTF-8 编码"，拒收二进制 */
export async function writeWorkspaceFile(
  conversationId: string,
  rawPath: unknown,
  content: string,
  baseVersion: number,
  author: WorkspaceWriteActor,
): Promise<WorkspaceFileEntry> {
  return writeWorkspaceFileBytes(conversationId, rawPath, Buffer.from(content, 'utf8'), baseVersion, author)
}

/**
 * 上传落盘（`POST .../workspace/upload`）。
 *
 * 与 {@link writeWorkspaceFile} 的差别：**允许二进制**（`allowBinary`）+ **覆盖语义**（`overwrite`，
 * 目标已存在直接覆盖，不走 CAS）—— 上传是"把这个字节放到这个路径"的显式意图，与文本保存的
 * 并发保护不同。配额（单文件 / 文件数 / 总字节）照旧判定。
 */
export async function uploadWorkspaceFile(
  conversationId: string,
  rawPath: unknown,
  data: Buffer,
  author: WorkspaceWriteActor,
): Promise<WorkspaceFileEntry> {
  return writeWorkspaceFileBytes(conversationId, rawPath, data, 0, author, { allowBinary: true, overwrite: true })
}

/** 新建文件（`POST .../workspace/file`）—— 等价于"`baseVersion=0` 的写"，已存在即 409 */
export async function createWorkspaceFile(
  conversationId: string,
  rawPath: unknown,
  content: string,
  author: WorkspaceWriteActor,
): Promise<WorkspaceFileEntry> {
  return await writeWorkspaceFile(conversationId, rawPath, content, 0, author)
}

/** 删除文件：落盘删除 + 索引**软删（墓碑）** + `deleted` 事件 */
export async function deleteWorkspaceFile(
  conversationId: string,
  rawPath: unknown,
  author: WorkspaceWriteActor,
): Promise<{ path: string }> {
  const handle = await ensureWorkspace(conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, rawPath)
  const existing = await findRow(conversationId, relative)
  if (existing === null || existing.deletedAt !== null) {
    // 已删/不存在都按幂等成功处理（DELETE 的语义），但仍要求盘上也许残留：清一次
    await stashCurrentFileIfAny(conversationId, absolute)
    await fsRemove(absolute)
    return { path: relative }
  }

  await stashCurrentFileIfAny(conversationId, absolute)
  await fsRemove(absolute)
  const now = new Date()
  const event = await getPrisma().$transaction(async (tx) => {
    await tx.workspaceFile.updateMany({
      where: { conversationId, path: relative, deletedAt: null },
      data: { deletedAt: now, updatedBy: author.actor, updatedById: author.actorId ?? null },
    })
    const created = await tx.workspaceEvent.create({
      data: workspaceEventCreateData({
        conversationId,
        type: 'deleted',
        path: relative,
        version: existing.version,
        actor: author.actor,
        actorId: author.actorId ?? null,
        at: now,
      }),
      select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
    })
    await tx.workspace.updateMany({ where: { conversationId }, data: { headVersion: { increment: 1 } } })
    return toWorkspaceEventItem(created)
  })
  publishWorkspaceEventItem(conversationId, event)
  return { path: relative }
}

/**
 * 删除**文件夹（递归）**：把该目录下所有已索引文件一次软删（墓碑 + 各一条 `deleted` 事件），
 * 再把目录整份落盘删除（含未索引的残留，如依赖目录 / `.git`）。空目录 / 不存在的目录按幂等成功回 `0`。
 *
 * ⚠️ **目录不是索引里的一行**（树由文件路径派生）：所以"删文件夹"= 挑出所有以 `dir/` 开头的
 *    活文件路径，逐个走**与单文件删除同一套**处理（先存历史字节 → 落盘删 → 落墓碑 + 事件）。
 * ⚠️ `headVersion` 按事件**条数**递增（N 条事件 ⇒ +N）—— 断线补发游标依赖这个恒等式（见 `events.ts`）。
 * @throws AppError(VALIDATION) 路径非法 / 该路径其实是一个**文件**（该走单文件删除）
 */
export async function deleteWorkspaceDirectory(
  conversationId: string,
  rawPath: unknown,
  author: WorkspaceWriteActor,
): Promise<WorkspaceDeleteDirResult> {
  const handle = await ensureWorkspace(conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, rawPath)

  // 目标若是个文件 ⇒ 走错端点了（前端只对"目录行"提供本操作，见 `WorkspacePanel`）
  if ((await workspaceFileSize(absolute)) !== undefined) {
    throw AppError.validation(appMsg('app.m239'))
  }

  const prefix = workspaceDirPrefix(relative)
  const rows = await getPrisma().workspaceFile.findMany({
    where: { conversationId, deletedAt: null, path: { startsWith: prefix } },
    orderBy: { path: 'asc' },
    select: { path: true, version: true },
  })

  // 删前把每个文件的**当前内容**存进历史字节（撤销/还原用）—— 与单文件删除同口径
  for (const row of rows) {
    await stashCurrentFileIfAny(conversationId, join(handle.rootPath, row.path))
  }
  // 盘上整份删（含未索引残留，如依赖目录 / `.git`）；目录缺失时 no-op（幂等）
  await fsRemoveDir(absolute)

  if (rows.length === 0) return { path: relative, deleted: 0 }

  const now = new Date()
  const events = await getPrisma().$transaction(async (tx) => {
    await tx.workspaceFile.updateMany({
      where: { conversationId, deletedAt: null, path: { startsWith: prefix } },
      data: { deletedAt: now, updatedBy: author.actor, updatedById: author.actorId ?? null },
    })
    const created: WorkspaceEventItem[] = []
    for (const row of rows) {
      const event = await tx.workspaceEvent.create({
        data: workspaceEventCreateData({
          conversationId,
          type: 'deleted',
          path: row.path,
          version: row.version,
          actor: author.actor,
          actorId: author.actorId ?? null,
          at: now,
        }),
        select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
      })
      created.push(toWorkspaceEventItem(event))
    }
    // ⚠️ headVersion = 事件条数：N 条事件 ⇒ +N（断线补发游标恒等式，见 `events.ts`）
    await tx.workspace.updateMany({ where: { conversationId }, data: { headVersion: { increment: rows.length } } })
    return created
  })
  for (const event of events) publishWorkspaceEventItem(conversationId, event)
  return { path: relative, deleted: rows.length }
}

/** 改名 / 移动：落盘 `rename` + 索引**换路径**（保留版本号递增）+ `renamed` 事件（`path` = 新路径） */
export async function moveWorkspaceFile(
  conversationId: string,
  rawFrom: unknown,
  rawTo: unknown,
  author: WorkspaceWriteActor,
): Promise<WorkspaceFileEntry> {
  const handle = await ensureWorkspace(conversationId)
  const from = resolveWorkspacePath(handle.rootPath, rawFrom)
  const to = resolveWorkspacePath(handle.rootPath, rawTo)
  if (from.relative === to.relative) {
    throw AppError.validation(appMsg('app.m240'))
  }
  // P1-17b：依赖目录是环境不是内容 ⇒ 不许移动进依赖目录（同写闸门一条判据）
  assertNotDependencyPath(to.relative)

  const sourceRow = await findLiveRow(conversationId, from.relative)
  if (sourceRow === null) throw AppError.notFound(appMsg('app.m241'))
  const targetRow = await findRow(conversationId, to.relative)
  if (targetRow !== null && targetRow.deletedAt === null) {
    throw AppError.conflict(appMsg('app.m242'), { path: to.relative })
  }

  await fsMove(from.absolute, to.absolute)

  const buffer = await readWorkspaceBytes(to.absolute)
  const hash = sha256(buffer)
  await stashWorkspaceBytes(conversationId, buffer)
  const mime = workspaceMimeOf(to.relative)
  const nextVersion = sourceRow.version + 1
  const now = new Date()
  const event = await getPrisma().$transaction(async (tx) => {
    // 墓碑/源行：源路径置墓碑（保版本），目标路径 upsert 成新行
    await tx.workspaceFile.updateMany({
      where: { conversationId, path: from.relative, deletedAt: null },
      data: { deletedAt: now, updatedBy: author.actor, updatedById: author.actorId ?? null },
    })
    const file = await tx.workspaceFile.upsert({
      where: { conversationId_path: { conversationId, path: to.relative } },
      create: {
        conversationId,
        path: to.relative,
        size: BigInt(buffer.byteLength),
        mime,
        contentHash: hash,
        version: nextVersion,
        updatedBy: author.actor,
        updatedById: author.actorId ?? null,
        deletedAt: null,
      },
      update: {
        size: BigInt(buffer.byteLength),
        mime,
        contentHash: hash,
        version: nextVersion,
        updatedBy: author.actor,
        updatedById: author.actorId ?? null,
        deletedAt: null,
      },
      select: { id: true },
    })
    await tx.workspaceFileVersion.create({
      data: {
        fileId: file.id,
        version: nextVersion,
        contentHash: hash,
        actor: author.actor,
        actorId: author.actorId ?? null,
      },
    })
    const created = await tx.workspaceEvent.create({
      data: workspaceEventCreateData({
        conversationId,
        type: 'renamed',
        path: to.relative,
        version: nextVersion,
        actor: author.actor,
        actorId: author.actorId ?? null,
        at: now,
      }),
      select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
    })
    await tx.workspace.updateMany({ where: { conversationId }, data: { headVersion: { increment: 1 } } })
    return toWorkspaceEventItem(created)
  })
  publishWorkspaceEventItem(conversationId, event)

  return { path: to.relative, size: buffer.byteLength, mime, version: nextVersion, updatedBy: author.actor, updatedAt: now.toISOString() }
}

// ───────────────────────────── 供 watcher / 读路径复用的低层 ─────────────────────────────

/**
 * 把**盘上的某个文件**同步进索引（watcher 与"读时补索引"共用）。
 *
 * 判据是 **contentHash**（不是 mtime）：内容没变直接返回 `null`（不产生事件）；变了则
 * `version + 1`、写版本行、发 `created`/`updated` 事件。**返回 `null` = 无变化**。
 *
 * ⚠️ 只处理"盘上存在"的文件；"索引里有、盘上没了"由 {@link softDeleteIndexedFile} 负责。
 */
export async function syncFileFromDisk(
  conversationId: string,
  rootPath: string,
  relative: string,
  author: WorkspaceWriteActor,
  at: Date = new Date(),
): Promise<WorkspaceFileEntry | null> {
  const absolute = join(rootPath, relative)
  const data = await readWorkspaceBytes(absolute)
  const hash = sha256(data)
  // 历史字节（P4 · R2）：watcher 捕获的**新**内容先存档（旧内容已被外部改动覆盖、不可得）
  await stashWorkspaceBytes(conversationId, data)
  const mime = workspaceMimeOf(relative)
  // ★ P1-21：与中介写共用同一把会话锁 —— 版本号在锁内重读（见 `withWorkspaceWriteLock`）
  const outcome = await withWorkspaceWriteLock(conversationId, async () => {
    const existing = await findRow(conversationId, relative)
    if (existing !== null && existing.deletedAt === null && existing.contentHash === hash && Number(existing.size) === data.byteLength) {
      return null
    }
    const nextVersion = (existing?.version ?? 0) + 1
    return await getPrisma().$transaction(async (tx) => {
      const file = await tx.workspaceFile.upsert({
        where: { conversationId_path: { conversationId, path: relative } },
        create: {
          conversationId,
          path: relative,
          size: BigInt(data.byteLength),
          mime,
          contentHash: hash,
          version: nextVersion,
          updatedBy: author.actor,
          updatedById: author.actorId ?? null,
          deletedAt: null,
        },
        update: {
          size: BigInt(data.byteLength),
          mime,
          contentHash: hash,
          version: nextVersion,
          updatedBy: author.actor,
          updatedById: author.actorId ?? null,
          deletedAt: null,
        },
        select: { id: true },
      })
      await createVersionRowIfAbsent(tx, {
        fileId: file.id,
        version: nextVersion,
        contentHash: hash,
        actor: author.actor,
        actorId: author.actorId ?? null,
      })
      const created = await tx.workspaceEvent.create({
        data: workspaceEventCreateData({
          conversationId,
          type: existing === null || existing.deletedAt !== null ? 'created' : 'updated',
          path: relative,
          version: nextVersion,
          actor: author.actor,
          actorId: author.actorId ?? null,
          at,
        }),
        select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
      })
      await tx.workspace.updateMany({ where: { conversationId }, data: { headVersion: { increment: 1 } } })
      return { event: toWorkspaceEventItem(created), version: nextVersion }
    })
    })
    if (outcome === null) return null
  publishWorkspaceEventItem(conversationId, outcome.event)
  return { path: relative, size: data.byteLength, mime, version: outcome.version, updatedBy: author.actor, updatedAt: at.toISOString() }
}

/** 索引里有、盘上没了 ⇒ 软删 + `deleted` 事件（watcher 用）。无变化返回 `null` */
export async function softDeleteIndexedFile(
  conversationId: string,
  relative: string,
  author: WorkspaceWriteActor,
  at: Date = new Date(),
): Promise<WorkspaceEventItem | null> {
  const existing = await findLiveRow(conversationId, relative)
  if (existing === null) return null
  const event = await getPrisma().$transaction(async (tx) => {
    await tx.workspaceFile.updateMany({
      where: { conversationId, path: relative, deletedAt: null },
      data: { deletedAt: at, updatedBy: author.actor, updatedById: author.actorId ?? null },
    })
    const created = await tx.workspaceEvent.create({
      data: workspaceEventCreateData({
        conversationId,
        type: 'deleted',
        path: relative,
        version: existing.version,
        actor: author.actor,
        actorId: author.actorId ?? null,
        at,
      }),
      select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
    })
    await tx.workspace.updateMany({ where: { conversationId }, data: { headVersion: { increment: 1 } } })
    return toWorkspaceEventItem(created)
  })
  publishWorkspaceEventItem(conversationId, event)
  return event
}

// ───────────────────────────── 内部 ─────────────────────────────

type FileRow = {
  path: string
  size: bigint
  mime: string
  version: number
  contentHash: string
  deletedAt: Date | null
  updatedBy: WorkspaceActor
  updatedAt: Date
}

async function findRow(conversationId: string, path: string): Promise<FileRow | null> {
  return await getPrisma().workspaceFile.findUnique({
    where: { conversationId_path: { conversationId, path } },
    select: { path: true, size: true, mime: true, version: true, contentHash: true, deletedAt: true, updatedBy: true, updatedAt: true },
  })
}

async function findLiveRow(conversationId: string, path: string): Promise<FileRow | null> {
  const row = await findRow(conversationId, path)
  return row === null || row.deletedAt !== null ? null : row
}

/**
 * 依赖目录写闸门（P1-17b）：中介写**不许落进依赖目录**（`node_modules` / `venv` / `target` …）。
 *
 * 判据本体在 `dependencyModel#isWorkspaceDependencyPath`（与"索引不列依赖目录""不进产物"同一份名单）。
 * 依赖目录由**运行期安装**（`npm ci` / `pip install`，经 bash 直接落盘、被 watcher 有意跳过）产生 ——
 * 它不是"内容"，所以编辑器 / agent 的 `write` 进不去；要改依赖就重装，不要手改。
 */
function assertNotDependencyPath(relative: string): void {
  if (!isWorkspaceDependencyPath(relative)) return
  throw AppError.validation(appMsg('app.m273', { p0: relative }),
  )
}

/**
 * 写闸门（§九 配额 + §十二 P6 硬化）：二进制类型闸门 + 单文件大小 / 活文件数 / **行数（含墓碑）** / 总字节。
 *
 * 判据本体在 `quotaModel#decideWorkspaceQuota`（纯函数，可在自证脚本里逐条核对）；本函数只做
 * **取现状**（两条查询）+ **抛错误**（带 `violation` 的 `VALIDATION`）。
 *
 * ⚠️ **先判后写**（在落盘之前），否则会出现"写进去了才发现超限"。
 * ⚠️ 行数（含墓碑）只在**会新增一行**时查（`createsRow`）—— 覆盖 / 复活既有行不改行数，
 *    多查一次没必要（`workspace_files` 唯一键 `(会话, 路径)`）。
 */
async function assertWithinQuota(
  conversationId: string,
  incomingBytes: number,
  options: { isNewFile: boolean; createsRow: boolean; binary: boolean },
): Promise<void> {
  const aggregate = await getPrisma().workspaceFile.aggregate({
    where: { conversationId, deletedAt: null },
    _count: { _all: true },
    _sum: { size: true },
  })
  const totalRowCount = options.createsRow
    ? await getPrisma().workspaceFile.count({ where: { conversationId } })
    : 0

  const decision = decideWorkspaceQuota(
    {
      incomingBytes,
      binary: options.binary,
      isNewFile: options.isNewFile,
      createsRow: options.createsRow,
      liveFileCount: aggregate._count._all ?? 0,
      totalRowCount,
      liveTotalBytes: Number(aggregate._sum.size ?? 0n),
    },
    {
      maxFileBytes: config.workspace.maxFileMb * 1024 * 1024,
      maxFiles: config.workspace.maxFiles,
      maxRows: config.workspace.maxRows,
      maxTotalBytes: config.workspace.maxTotalMb * 1024 * 1024,
    },
  )
  if (decision.ok) return

  // 留痕（§九「超限拒绝并留痕」）：二进制拒收是常规闸门，降为 info；配额类留 warn
  const context = { conversationId, violation: decision.violation, incomingBytes }
  if (decision.violation === 'BINARY_CONTENT') getLogger().info(context, '工作区写入被类型闸门拒绝（内容为二进制）')
  else getLogger().warn(context, '工作区写入被配额闸门拒绝')
  throw AppError.validation(decision.message, { violation: decision.violation })
}

function toFileEntry(row: {
  path: string
  size: bigint
  mime: string
  version: number
  updatedBy: WorkspaceActor
  updatedAt: Date
}): WorkspaceFileEntry {
  return {
    path: row.path,
    size: Number(row.size),
    mime: row.mime,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  }
}