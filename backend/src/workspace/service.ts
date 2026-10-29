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
  isGitInternalPath,
  isWorkspaceTextMime,
  planWorkspaceRevert,
  workspaceMimeOf,
  type WorkspaceActor,
  type WorkspaceChangeEntry,
  type WorkspaceChangesResult,
  type WorkspaceDeleteDirResult,
  type WorkspaceEventItem,
  type WorkspaceRevertScope,
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
// ★ 2026-10-28（用户反馈「txt 文件在 Code 模式下不能展示」）：文本解码复用知识库那条**唯一**的
//   编码嗅探（BOM → 严格 UTF-8 → GBK），不再一律 `toString('utf8')` —— 后者对 UTF-16 / GBK 的 txt
//   只会给出一屏乱码（而乱码同样是"不能展示"）。该函数文件头已注明"`.md` 也用同一套判据"，
//   编码这件事全仓只该有一份实现。
import { decodeTextBuffer } from '../pipeline/parse/txt.js'
import { filterGitCleanPaths } from '../sandbox/gitArtifacts.js'
import { putWorkspaceBlob, readWorkspaceBlob } from './blob.js'
import { buildZip, type ZipEntry } from './zip.js'
import {
  buildWorkspaceRevertPreview,
  contentEventTimes,
  isWorkspaceChangeStillPresent,
  pickUsableRoundStart,
  planWorkspaceRevertCandidates,
  revertRollbackVersion,
  shouldRevertPath,
  splitWorkspaceChangesByRound,
  segmentKey,
  type WorkspacePathStates,
  type WorkspaceRevertCandidate,
  type WorkspaceVersionHashOf,
} from './changesModel.js'
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
  // ★ 2026-10-28（用户反馈「txt 不能展示」）：解码走编码嗅探（UTF-8 / UTF-16 BOM / GBK），
  //   而不是一律按 UTF-8 解 —— 后者把 UTF-16 / GBK 的 txt 解成乱码，等于没展示。
  const text =
    isWorkspaceTextMime(source.mime) && !source.binary && source.size <= inlineMax
      ? decodeTextBuffer(source.body).text
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
 * 把一个**目录**（含子孙）打包成 zip 的字节（`GET .../workspace/dir/zip?path=`，2026-10-29）。
 *
 * 用途：目录行右键「下载为 zip」—— 用户明确要的是"按目录下载"，而逐个文件点下载在大目录上
 * 不可用。**只读**：从工作区索引取该前缀下的活文件（依赖目录 / 隐藏目录本就不在索引里，
 * 天然不进包），再从宿主 FS 读字节。
 *
 * ⚠️ 大小闸门：整包（`ZIP_MAX_BYTES` = 4GiB）与**单包文件数**（`WORKSPACE_ZIP_MAX_FILES`）两道上限，
 *    超了给 413 而不是拼一个半天的包把实例拖住；单文件超过上限的跳过并在结果的 `skipped` 里留痕
 *    （不静默丢，与产物收集同一条纪律）。
 */
export async function readWorkspaceDirectoryZip(
  conversationId: string,
  rawPath: unknown,
): Promise<{ fileName: string; body: Buffer; entries: number; skipped: string[] }> {
  const handle = await ensureWorkspace(conversationId)
  const { relative } = resolveWorkspacePath(handle.rootPath, rawPath)
  const prefix = relative === '' ? '' : `${relative}/`

  const rows = await getPrisma().workspaceFile.findMany({
    where: { conversationId, deletedAt: null, ...(prefix === '' ? {} : { path: { startsWith: prefix } }) },
    orderBy: { path: 'asc' },
    select: { path: true },
    take: config.workspace.zipMaxFiles + 1,
  })
  if (rows.length > config.workspace.zipMaxFiles) {
    throw AppError.validation(appMsg('app.m284', { p0: String(config.workspace.zipMaxFiles) }))
  }

  const entries: ZipEntry[] = []
  const skipped: string[] = []
  for (const row of rows) {
    const absolute = join(handle.rootPath, row.path)
    const size = await workspaceFileSize(absolute)
    if (size === undefined) continue
    if (size > config.limits.artifactMaxFileMb * 1024 * 1024) {
      skipped.push(row.path)
      continue
    }
    entries.push({ name: row.path, data: await readWorkspaceBytes(absolute) })
  }

  const body = buildZip(entries)
  const baseName = relative === '' ? 'workspace' : (relative.split('/').pop() ?? relative)
  return { fileName: `${baseName}.zip`, body, entries: entries.length, skipped }
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
export async function listWorkspaceChanges(
  conversationId: string,
  since?: string,
  options: { excludeRepositoryImports?: boolean } = {},
): Promise<WorkspaceChangesResult> {
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
  // ★ P1-24（2026-10-27，用户反馈「git 都没变更，为什么拉取下来那些算变更」）：
  //   `.git/**` 是 git 自己的中间产物（对象 / 索引 / 锁文件），在折叠里也是普通路径
  //   （实测某会话 12 秒里 1988 条事件，含 `repo/.git/index.lock`、`objects/pack/tmp_pack_*`）。
  //   「最近变更」要回答"谁动了哪些代码"，不是"git 干了什么" ⇒ 在这里一次剔掉。
  //
  //   ⚠️ 只剔 `.git`（纯判据、不碰 FS）。**"clone/pull 的初始填充"不在这里剔** —— 那需要跑 git
  //   （`sandbox/gitArtifacts#filterGitCleanPaths`），属**展示侧**的取舍，落在消费这份清单的地方：
  //     · 产物收集已在 `collectRoundArtifacts` 里做（已决 6）；
  //     · 面板「最近变更」在 `routes/workspace.ts` 的那条 GET 里做。
  //   本函数保持"窗口内动过哪些路径"这个**底层事实**（`taskAgent` 收产物也读它）。
  // ★ 2026-10-28（用户反馈「编辑 4 行只显示 1 行，刷新后才 +4 −3」）：给每条**落在本轮内**的
  //   变更补「本轮基线」。判据直接复用 `planWorkspaceRevert`（撤销本轮用的同一套），不另写一份 ——
  //   于是"徽标/差异展示的范围"与"撤销会回滚到哪"永远是同一个答案。
  //   同一轮里改了两次也不会丢：基线取的是**这条路径在本轮第一次被改之前**的版本。
  //   ⚠️ 只剔 `.git`：`.doubulea/memory.md` 是**真实写入**（每轮重写），属工作区改动，必须照常展示
  //   —— 本轮/更早由边界与"当前内容仍在"判，不由路径白名单判（2026-10-28 用户指正：
  //      曾误把 `.doubulea/**` 当"平台簿记"排除，导致记忆文档的改动凭空消失）。
  let contentRows = rows.map(toWorkspaceEventItem).filter((item) => !isGitInternalPath(item.path))
  // ★ 2026-10-28（用户定案「git 拉下来的不算」下沉到数据层）：
  //   以前这条过滤只在路由层做（且 git 一失败就整份退回原样）⇒ 面板会看到几千条仓库自带文件
  //   （实测某会话 4238 条 `created`，其中 4222 条是 checkout 产生的、现在仍是 v1）。
  //   现在由**调用方声明**是否需要剔除（面板 / 撤销要；`taskAgent` 收产物自己有同一套判据）。
  //   ⚠️ 保守失败：git 不可用 / 失败 / 非仓库 ⇒ **一条都不剔**（退回现状），绝不因此让接口报错。
  if (options.excludeRepositoryImports === true && contentRows.length > 0) {
    try {
      const handle = await ensureWorkspace(conversationId)
      const { excluded } = await filterGitCleanPaths(
        handle.rootPath,
        [...new Set(contentRows.map((item) => item.path))],
      )
      const drop = new Set(excluded)
      // 仓库自带文件在检出那一刻记的 `created v1` 也不是"谁新建的" ⇒ 一并剔（只剔 created，
      // 之后被改脏的 `updated` 是真实改动，必须留）。
      contentRows = contentRows.filter((item) => !(drop.has(item.path) && item.type === 'created'))
    } catch (error) {
      getLogger().warn({ err: error, conversationId }, '最近变更：git 过滤失败，按原变更集回（不影响返回）')
    }
  }
  const visible = foldWorkspaceEvents(contentRows)
  // ★ 2026-10-28：`since` 显式给 = **窗口内清单**（`taskAgent` 收产物读这条口径），不分组、
  //   `beforeVersion` 按该窗口算 —— 产物只关心"这一段动过哪些路径"，同一路径一条。
  if (since !== undefined) return { items: withWindowBaselines(contentRows, visible) }

  // ★ 2026-10-28（用户定案，重做）：
  //   `本轮改动 = 当前保存改动的内容`、`更早 = 非本轮改动（git 拉取下来的不算）`。
  //
  //   上一版按 Redis 轮次标记切时间窗，实测（会话 01a17c6d「拉取代码」）彻底错位：标记被写成
  //   `08:23:31Z` 而该轮事件在 `00:23:31Z`（偏 8 小时、且 `ttl=-1` 永不过期）⇒ 那一轮真正的编辑
  //   被判成「更早」，昨天的随手保存被判成「本轮」。
  //
  // ★ 2026-10-28 二次定案（「按次：每次保存各算一轮」+「更早压成一条」）：
  //   · **本轮 = 最近一次保存**（最后一跳）。同一段里先改 33 行、再改 44 行 ⇒
  //     本轮是「33→44 那次」，前一次退回更早（用户："编辑第二次不应该是第二轮了吗"）。
  //   · **更早 = 该路径轮前那段整体压成一条**（`轮前最早 → 轮前末版本`），不让几十次历史撑爆清单。
  //   · **本轮还要过"当前内容仍在"**（比内容 hash）：改回去了就不是"当前保存的改动"；
  //     **更早不过这个滤** —— 历史发生过就是发生过（第一轮建 B、第二轮删 B：B 的「新建」必须留着）。
  //   分段本身在 `changesModel#splitWorkspaceChangesByRound`（纯函数，可逐条断言）。
  const states = await loadWorkspacePathStates(conversationId)
  const boundary = await resolveChangeBoundary(conversationId)
  // 「按次」口径下，本轮就是**最后一跳**（`splitWorkspaceChangesByRound` 自己判），
  // 用户消息边界只用来回 `round.start`（前端标题 / 撤销入口复用），不参与分段。
  // 基线 = **这一跳之前的那一版**（「按次」口径的核心），逐事件算一次：
//   · 同一路径上更早的内容事件存在 ⇒ 基线 = 它的版本（通常是 `version - 1`）；
//   · 没有更早事件 ⇒ `null`（这一跳把文件从"不存在"变成存在 ⇒ 整篇新增）。
//   `splitWorkspaceChangesByRound` 的两处用法都靠它：
//     · 本轮 = 最后一跳 ⇒ 基线就是它的前一版（v35→v36），**不合并历史**；
//     · 更早压成一条时传"轮前最早那次" ⇒ 它的基线自然是轮前最早之前（整段历史的开头）。
const previousCache = new Map<string, number | null>()
{
  const latestVersionByPath = new Map<string, number>()
  const ascending = [...contentRows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  for (const event of ascending) {
    // 先记"这条事件之前的版本"，再把它自己登记为后续事件的上一版（顺序不能反）
    previousCache.set(segmentKey(event), latestVersionByPath.get(event.path) ?? null)
    if (event.version !== null) latestVersionByPath.set(event.path, event.version)
  }
}
const beforeOf = (event: WorkspaceEventItem): number | null => previousCache.get(segmentKey(event)) ?? null
  const hashOf = await loadVersionHashes(conversationId, contentRows)
  const split = splitWorkspaceChangesByRound(contentRows, beforeOf)
  // ★ 2026-10-28（用户定案「两段同规则」）：**两段都过"当前内容仍在"的检查**。
  //   以前只查「本轮」，「更早」原样返回 ⇒ 同一个文件"改回去了"在本轮被正确隐藏、
  //   在更早里却还挂着一条 +3 −2，点开内容与原来一模一样（`changesModel` 文件头要修的问题 ②）。
  //   ⚠️ 已删除的条目仍然保留（`isWorkspaceChangeStillPresent` 对 `type='deleted'` 判"是否仍不在"），
  //      历史删除是真实发生过的事，不属于"改回去了"。
  const current = keepStillPresent(split.current as WorkspaceChangeEntry[], states, hashOf)
  const earlier = keepStillPresent(split.earlier as WorkspaceChangeEntry[], states, hashOf)
  // 排序口径：两段各自按 `at` 倒序（最近的在前），「本轮」整段排在「更早」之前
  const byRecent = (a: WorkspaceChangeEntry, b: WorkspaceChangeEntry): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
  return {
    items: [...current.sort(byRecent), ...earlier.sort(byRecent)],
    ...(boundary === undefined ? {} : { round: { start: boundary } }),
  }
}

/** 只保留"当前内容里仍在"的条目（改回去了 ⇒ 不是当前保存的改动） */
function keepStillPresent(
  items: readonly WorkspaceChangeEntry[],
  states: WorkspacePathStates,
  hashOf: WorkspaceVersionHashOf,
): WorkspaceChangeEntry[] {
  return items.filter((item) => isWorkspaceChangeStillPresent(item, states, hashOf))
}

/** 各路径的**当前落库状态**（`workspace_files` 当前态；墓碑也算一条，用于判"删除后有没有被重建"） */
async function loadWorkspacePathStates(conversationId: string): Promise<WorkspacePathStates> {
  const rows = await getPrisma().workspaceFile.findMany({
    where: { conversationId },
    select: { path: true, version: true, deletedAt: true, contentHash: true },
  })
  const states = new Map<string, { version: number; deleted: boolean; contentHash: string }>()
  for (const row of rows) {
    states.set(row.path, { version: row.version, deleted: row.deletedAt !== null, contentHash: row.contentHash })
  }
  return states
}

/**
 * 一次取齐这批变更**用得到的**历史版本 hash（`(path, version) → hash`）。
 *
 * ★ 2026-10-28：判"改回去了"要比**内容**（实测 `repo/pytest.ini` 的 v1 与 v3 hash 相同、版本号不同）。
 *   只为清单里出现过的基线版本各查一次，不扫全表；查不到就当"无从判定"（保守保留）。
 */
async function loadVersionHashes(
  conversationId: string,
  rows: readonly WorkspaceEventItem[],
): Promise<WorkspaceVersionHashOf> {
  const wanted = new Set<number>()
  const byPath = new Map<string, Set<number>>()
  const note = (path: string, version: number | null | undefined): void => {
    if (version === null || version === undefined || version <= 0) return
    wanted.add(version)
    const set = byPath.get(path) ?? new Set<number>()
    set.add(version)
    byPath.set(path, set)
  }
  for (const entry of planWorkspaceRevert(rows)) {
    note(entry.path, entry.beforeVersion)
    if (entry.expect.deleted === false) note(entry.path, entry.expect.version)
  }
  // ★ 2026-10-28 实测补充：**事件流里每个版本**都要取 —— 「更早」那条的末版本（如 v37）
  //   不一定是 `planWorkspaceRevert` 的 `expect.version`（那是全局末版本 v38）。
  //   判"这一段净变化是否为零"要比的是**段内末版本**与基线（实测 v1 与 v37 hash 相同）。
  for (const row of rows) note(row.path, row.version)
  const hashes = new Map<string, string>()
  if (wanted.size === 0) return (path, version) => hashes.get(`${path}\u0000${version}`)
  const files = await getPrisma().workspaceFile.findMany({
    where: { conversationId, path: { in: [...byPath.keys()] } },
    select: { id: true, path: true },
  })
  const idOf = new Map(files.map((file) => [file.path, file.id]))
  const versions = await getPrisma().workspaceFileVersion.findMany({
    where: { fileId: { in: [...idOf.values()] }, version: { in: [...wanted] } },
    select: { fileId: true, version: true, contentHash: true },
  })
  const pathOfId = new Map(files.map((file) => [file.id, file.path]))
  for (const version of versions) {
    const path = pathOfId.get(version.fileId)
    if (path === undefined) continue
    hashes.set(`${path}\u0000${version.version}`, version.contentHash)
  }
  return (path, version) => hashes.get(`${path}\u0000${version}`)
}

/**
 * 「本轮」的起点（ISO）—— 取**库里最后一条用户消息**，它才是派活的真实触发点。
 *
 * 为什么不用 Redis 轮次标记做主判据：那是**易失**的旁路数据（实测出现过 8 小时偏差、
 * `ttl=-1` 且永不过期），一旦写坏就把两段整体错位。消息是持久事实、与工作区事件同一套时钟。
 * 标记只作**兜底**，且必须与事件流自洽（`pickUsableRoundStart`：窗口里一条内容事件都没有 ⇒ 不可用）。
 *
 * `undefined` = 这个会话还没有过任何用户消息 ⇒ 没有「本轮」，全部算「更早」。
 */
async function resolveChangeBoundary(conversationId: string): Promise<string | undefined> {
  const lastUserMessage = await getPrisma().message.findFirst({
    where: { conversationId, role: 'USER' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (lastUserMessage !== null) return lastUserMessage.createdAt.toISOString()
  const marker = await readWorkspaceRoundWindow(conversationId)
  const recent = await getPrisma().workspaceEvent.findMany({
    where: { conversationId, type: { in: [...WORKSPACE_CONTENT_EVENT_TYPES] } },
    orderBy: { at: 'desc' },
    take: 2000,
    select: { at: true },
  })
  const start = pickUsableRoundStart(marker, contentEventTimes(recent), Date.now())
  return start ?? undefined
}

/**
 * 给一批"窗口内已折叠"的变更补**该窗口的基线**（`beforeVersion`）与段标记。
 *
 * 判据复用 `planWorkspaceRevert`（与「撤销本轮」同一套）：基线 = 这条路径在**这段窗口
 * 第一次被改之前**的版本，于是"同一段里连改两次"也不会只剩最后一跳
 * （2026-10-28 用户反馈「编辑 4 行只显示 1 行」）。
 *
 * ★ 两段都用**同一口径**，才是"首尾相接的两个故事"：`更早 = v1→v3`、`本轮 = v3→v5`。
 *   若「更早」改用"最后一跳"口径，多跳的那一段会变成 `v2→v3`，`v1→v2` 凭空消失
 *   —— 用户看到的仍是"改动丢了"。
 */
function withWindowBaselines(
  rows: readonly WorkspaceEventItem[],
  folded: readonly WorkspaceChangeEntry[],
  segment?: 'current' | 'earlier',
): WorkspaceChangeEntry[] {
  if (folded.length === 0) return []
  const beforeByPath = new Map<string, number | null>()
  for (const entry of planWorkspaceRevert(rows)) beforeByPath.set(entry.path, entry.beforeVersion)
  return folded.map((item) => ({
    ...item,
    ...(segment === undefined ? {} : { segment }),
    ...(beforeByPath.has(item.path) ? { beforeVersion: beforeByPath.get(item.path) ?? null } : {}),
  }))
}

/**
 * 解析某路径的**本轮基线版本**（`null` = 本轮开始时不存在 / 不在本轮内）。
 *
 * ★ 2026-10-28（重做）：边界改成 `resolveChangeBoundary`（库里最后一条用户消息，与「最近变更」
 *   列表**同一判据**）。以前这里读 Redis 轮次标记，而标记实测会写坏（偏 8 小时 / 永不过期）
 *   ⇒ 列表与徽标各用一份错位的窗口，两处数字对不上。
 *
 * 判据仍复用 `planWorkspaceRevert`：算基线的方式与「撤销本轮」同一套。
 * 不在本轮内（更早的改动）⇒ `undefined`，调用方退回默认基线（前一版）。
 */
async function resolveRoundBaseVersion(
  conversationId: string,
  relative: string,
): Promise<number | null | undefined> {
  const boundary = await resolveChangeBoundary(conversationId)
  if (boundary === undefined) return undefined
  const rows = await getPrisma().workspaceEvent.findMany({
    where: {
      conversationId,
      path: relative,
      type: { in: [...WORKSPACE_CONTENT_EVENT_TYPES] },
      at: { gte: new Date(boundary) },
    },
    select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
  })
  const plan = planWorkspaceRevert(rows.map(toWorkspaceEventItem))
  const entry = plan.find((candidate) => candidate.path === relative)
  if (entry === undefined) return undefined
  // ★ 2026-10-28：「本轮新建」（`beforeVersion: null`）必须**原样传 null** —— 它是"基线不存在，
  //   整篇都是新增"。以前这里折成 `undefined`，于是退回默认基线（`version - 1`），
  //   本轮新建的文件只显示"最后一跳"的新增行，而不是整篇新增。
  return entry.beforeVersion
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
  roundBase = false,
  toVersion?: number,
): Promise<WorkspaceFileDiff> {
  const handle = await ensureWorkspace(conversationId)
  const { relative, absolute } = resolveWorkspacePath(handle.rootPath, rawPath)
  // ★ 2026-10-28：`roundBase` ⇒ 基线由**服务端**按本轮窗口自己算（与「撤销本轮」同一判据），
  //   前端不再传 `beforeVersion`，也就不会因"实时事件合并丢字段"而退回最后一跳。
  //
  //   ⚠️ 服务端算出 `null`（本轮新建）时必须**当成"基线不存在"**传下去，不能退回默认基线 ——
  //   否则本轮新建的文件只显示最后一跳的新增行，而不是整篇新增。
  let baseVersion_ = baseVersion
  if (roundBase && baseVersion === undefined) {
    const resolved = await resolveRoundBaseVersion(conversationId, relative)
    if (resolved !== undefined) {
      baseVersion_ = resolved === null ? 0 : resolved
    }
  }
  baseVersion = baseVersion_
  const row = await findRow(conversationId, relative)
  const rowDeleted = row === null || row.deletedAt !== null
  const rowVersion = row === null ? null : (row as FileRow).version

  // ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条，各自标明版本范围）：
  //   `toVersion` ⇒ 比到**那一段的末版本**为止，而不是一路比到此刻盘上的内容。
  //   「更早」那条要比的是"上上段 → 上段末"，否则两行都会给出"很久以前 → 现在"的同一个差异。
  //   末版本可能**就是**当前版本（「本轮」那条）⇒ 仍然读盘（盘上是最新的真实字节）。
  if (toVersion !== undefined && toVersion !== rowVersion) {
    const hash = await versionHashOf(conversationId, relative, toVersion)
    if (hash === null) {
      return diffUnavailable(relative, baseOf(baseVersion), toVersion, `版本 v${toVersion} 无索引（可能早于本功能）`)
    }
    const bytes = await readWorkspaceBlob(config.workspace.root, conversationId, hash)
    if (bytes === null) {
      return diffUnavailable(relative, baseOf(baseVersion), toVersion, `版本 v${toVersion} 的字节缺失（冷备前的历史）`)
    }
    if (workspaceContentIsBinary(bytes)) {
      return diffUnavailable(relative, baseOf(baseVersion), toVersion, '二进制文件不支持逐行差异')
    }
    // 「到 vN」那条：基线缺省 = vN 的前一版（与默认口径一致）；
    // 显式 `0` = 明确"基线不存在"（那一段里是新建）⇒ 不能拿 0 当版本号去查历史字节。
    const base = baseVersion === undefined ? (toVersion > 1 ? toVersion - 1 : null) : baseVersion === 0 ? null : baseVersion
    const oldText = await blobTextOf(conversationId, relative, base)
    if (typeof oldText !== 'string') return diffUnavailable(relative, base, toVersion, oldText.message)
    const result = lineDiffWorkspace(oldText, decodeTextBuffer(bytes).text)
    return {
      path: relative,
      baseVersion: base,
      currentVersion: toVersion,
      added: result.added,
      removed: result.removed,
      available: true,
      ...(result.truncated ? { message: '文件较大，仅显示前部分差异' } : {}),
      truncated: result.truncated,
      ...(statsOnly ? {} : { lines: result.lines }),
    }
  }

  const currentDeleted = rowDeleted
  const currentVersion = currentDeleted ? null : rowVersion

  // 基线版本：
  //   · 显式给了就用它（`0` = 明确"基线不存在"，见 `baseOf`）；否则——当前存在 ⇒ 前一版
  //     （v1 = 新建，前一版为 null）；当前是墓碑 ⇒ **保留的那个版本**（= 被删那一刻的内容，整篇都算删除）。
  const base =
    baseVersion !== undefined
      ? baseOf(baseVersion)
      : row === null
        ? null
        : row.deletedAt !== null
          ? row.version
          : row.version > 1
            ? row.version - 1
            : null

  let oldText = ''
  if (base !== null) {
    const text = await blobTextOf(conversationId, relative, base)
    if (typeof text !== 'string') return diffUnavailable(relative, base, currentVersion, text.message)
    oldText = text
  }

  let newText = ''
  if (!currentDeleted) {
    try {
      const bytes = await readWorkspaceBytes(absolute)
      if (workspaceContentIsBinary(bytes)) {
        return diffUnavailable(relative, base, currentVersion, '二进制文件不支持逐行差异')
      }
      newText = decodeTextBuffer(bytes).text
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

/**
 * 取某历史版本的**文本**（差异用）。返回 `string` = 成功；返回 `{ message }` = 取不到（人话原因）。
 *
 * ★ 2026-10-28：抽出来是因为「到某个版本为止」那条路（`toVersion`）与"基线版本"那条路
 *   判据必须**逐字一致**（无索引 / 字节缺失 / 二进制各一句），否则同一份缺失会给出两种解释。
 */
async function blobTextOf(
  conversationId: string,
  relative: string,
  version: number | null,
): Promise<string | { message: string }> {
  if (version === null) return ''
  const hash = await versionHashOf(conversationId, relative, version)
  if (hash === null) return { message: `版本 v${version} 无索引（可能早于本功能）` }
  const bytes = await readWorkspaceBlob(config.workspace.root, conversationId, hash)
  if (bytes === null) return { message: `版本 v${version} 的字节缺失（冷备前的历史）` }
  if (workspaceContentIsBinary(bytes)) return { message: '二进制文件不支持逐行差异' }
  return decodeTextBuffer(bytes).text
}

/**
 * 请求里的 `baseVersion` → 差异两端的"基线版本"（`null` = 基线不存在）。
 *
 * `0` 是**显式的"没有基线"**（那一段里这个文件是新建的），不是"版本 0"。直接把它当版本号
 * 去查历史字节会查到不存在的一行，于是新建的文件被报成"无索引"而不是"整篇新增"。
 */
function baseOf(baseVersion: number | undefined): number | null {
  return baseVersion === undefined || baseVersion === 0 ? null : baseVersion
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
 * 「撤销本轮」（P4 · R2；2026-10-28 重做**范围与回滚点**）—— 把**这一段**里 agent 的写入回退。
 *
 * ★ 2026-10-28 用户定案（「撤销怎么选」）：
 *   ① **范围**默认 `AGENT_ONLY` —— 只撤"这一段最后一次写入是 agent"的路径；
 *      用户手写收尾的路径**故意不动**（预演里标 `USER_EDIT_EXCLUDED`）。
 *      想连手写一起撤必须显式 `ALL` / `SELECTED`。
 *   ② **回滚点**：~~手写之后 / 段初~~ —— 2026-10-29 已改为"退一步"（见下条），这里仅留历史。
 *   ③ 预演（`dryRun`）回 **restore / remove / skip 三栏**，点之前就看得见范围与结果。
 *
 * ★ 2026-10-29 用户定案（**撤销 = 退一步**）：回滚点 = 每个路径**本段最后一跳之前的那一版**
 *   （{@link WorkspaceRevertCandidate.previousVersion}），不是"段初"、也不再看手写：
 *   `v1 我建 → v2 agent → v3 我` ⇒ 撤销回到 **v2**，文件不会消失。
 *   唯一会删除文件的场景：这一跳本身就是"新建"（v1 就是最后一跳）。
 *
 * ★ 2026-10-29 用户实测反馈（会话「NGPOS星礼包」）：`gen_doc.py` agent 建、随后用户手改两次，
 *   点撤销把**整个文件删了**。两条根因，两条都已修：
 *   · **窗口**：以前 `since` = 全会话第一条内容事件，于是"更早"几轮里新建的文件也被折成
 *     `created` ⇒ 段初 = 不存在 ⇒ `ALL` 删它。现在窗口 = **本轮**（各路径最后一跳，
 *     与「最近变更」的 current 段同一条划分，见 {@link resolveRevertWindow}）。
 *   · **回滚点**：以前按"段初 / 手写之后"二选一，段初不存在时就是删除；现在是"退一步"。
 *
 * 这一段 = **与「最近变更」同一段划分**（`splitWorkspaceChangesByRound` 的 current 段），
 * 于是"列表上看到的本轮"与"撤销会动的"永远是同一批路径。
 *
 * 每条路径仍走同一套 CAS 回写：当前版本 ≠ 段末版本（此后又动过）⇒ 记 `conflict`，不静默覆盖；
 * 段初字节缺失 ⇒ `unavailable`；二进制 / 改名 ⇒ `unsupported`。
 *
 * @throws AppError(VALIDATION) 既无显式 `since`、也没有本轮标记
 */
export async function revertWorkspaceRound(
  conversationId: string,
  options: {
    since?: string
    until?: string
    dryRun?: boolean
    scope?: WorkspaceRevertScope
    paths?: readonly string[]
  } = {},
): Promise<WorkspaceRevertResult> {
  await ensureWorkspace(conversationId)
  const window = await resolveRevertWindow(conversationId, options)
  const requested: WorkspaceRevertScope = options.scope ?? 'AGENT_ONLY'
  const rows = await getPrisma().workspaceEvent.findMany({
    where: {
      conversationId,
      at: { gte: new Date(window.since), ...(window.until === undefined ? {} : { lte: new Date(window.until) }) },
    },
    orderBy: { at: 'asc' },
    select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
  })
  const events = rows.map(toWorkspaceEventItem).filter((item) => !isGitInternalPath(item.path))
  // ★ 2026-10-29（用户定案「撤销 = 退一步」）：回滚点统一取**本段最后一跳之前的那一版**
  //   （`candidate.previousVersion`），不再看"手写"也不再看"段初"。
  //   例 `v1 我建 → v2 agent → v3 我`：撤销 = 回到 v2，文件不会消失。
  //   ⚠️ 不要再把"窗口外的用户手写版本"塞进候选：回滚点会变成**比当前还新/相等的版本**
  //      ⇒ 预演说还原、执行却是跳过，甚至把旧内容写回新文件（"回到未来"）。
  const candidates = planWorkspaceRevertCandidates(events)
  const scope: WorkspaceRevertScope = requested
  const selected = options.paths ?? []
  const preview = buildWorkspaceRevertPreview(candidates, scope, selected)
  const dryRun = options.dryRun === true
  const items: WorkspaceRevertEntry[] = []
  for (const candidate of candidates) {
    items.push(await applyRevertCandidate(conversationId, candidate, scope, selected, dryRun))
  }
  return {
    since: window.since,
    until: window.until ?? new Date().toISOString(),
    dryRun,
    scope,
    preview,
    items,
  }
}

/**
 * 解析撤销窗口：显式 `since` 优先；否则 = **与「最近变更」本轮同一段**。
 *
 * ★ 2026-10-28 浏览器实测修正（**关键**）：
 *   原来这里拿"最后一条用户消息的时刻"当 `since`。实测会话 `01a17c6d`：
 *   最后一条用户消息是 **10-27 00:24**，而所有工作区事件都在 **10-28**（之后）——
 *   窗口开在消息时刻之前，撤销会把"消息之后的一切"都算进去；
 *   而面板「本轮」显示的是"每个文件最后一跳"，两边根本不是同一批路径。
 *   更糟的是：用户手写可以发生在任何时刻（不需要发消息），按消息时间切永远对不上。
 *
 *   现在改成**按事件流自身切**：取 `AGENT_ONLY` 这一段 = 各路径的最后一跳（与列表同口径）；
 *   撤销动作本身按候选逐条判定（`shouldRevertPath`），窗口只用于取事件、不再承担分段语义。
 *   显式 `since` 仍优先（高级用法 / 只撤某一段）。
 *
 * ★ 2026-10-29 用户实测修正（会话「NGPOS星礼包」`gen_doc.py`）：起点曾用"**第一条**内容事件"
 *   （"足够早"）。可那个文件是**更早几轮**里建的 ⇒ 在本窗口里第一条就是 `created` ⇒
 *   `beforeVersion = null` ⇒ `ALL` 判定"段初不存在"⇒ **整份文件被删**（用户手改的那两版一起没了）。
 *   撤销要回答的是"**这一轮**动了什么" ⇒ 起点 = **各路径最后一跳里最早的那个时刻**
 *   （=「最近变更」current 段的窗口）。更早轮次的历史保留在基线里（`beforeVersion` 仍在），
 *   只是不再被当成"本段内新建"。
 */
async function resolveRevertWindow(
  conversationId: string,
  options: { since?: string; until?: string },
): Promise<{ since: string; until?: string }> {
  if (options.since !== undefined) {
    return { since: options.since, ...(options.until === undefined ? {} : { until: options.until }) }
  }
  // ★ 2026-10-28 浏览器实测（**必须是"第一条**非**仓库自带**事件**，不是全局第一条**）：
  //   放宽到全局第一条会把这个会话 1979 条 `git clone` 产生的 `created` 全框进来 ⇒ 预演
  //   报「会删除 1950 个文件（本轮新建）」。那是仓库自带内容，不该被撤销动到。
  //   ⇒ 先剔掉"仓库自带 = 该路径被 git 跟踪且当时是干净检出"（判据同 `filterGitCleanPaths`），
  //     再在剩下的"真实改动"里找窗口起点。
  // ★ 2026-10-29：起点 = 各路径**最后一跳**里最早的时刻（见上面注释），不是第一条事件。
  const candidates = await getPrisma().workspaceEvent.findMany({
    where: { conversationId, type: { in: [...WORKSPACE_CONTENT_EVENT_TYPES] } },
    orderBy: { at: 'asc' },
    select: { at: true, path: true, type: true },
    take: 5000,
  })
  if (candidates.length === 0) {
    // 一条内容事件都没有 ⇒ 没有可撤的东西（与"标记缺失"同一种用户可见结论）
    throw AppError.validation(appMsg('app.m237'))
  }
  const handle = await ensureWorkspace(conversationId)
  let repositoryImports: ReadonlySet<string> = new Set()
  try {
    const { excluded } = await filterGitCleanPaths(
      handle.rootPath,
      [...new Set(candidates.map((item) => item.path))],
    )
    repositoryImports = new Set(excluded)
  } catch {
    // git 不可用 ⇒ 一条都不剔（保守：宁可多框一点，也不要漏掉真实改动）
  }
  const real = candidates.filter(
    (item) => !(repositoryImports.has(item.path) && item.type === 'created'),
  )
  if (real.length === 0) throw AppError.validation(appMsg('app.m237'))
  // 各路径最后一跳（`at` 相同取后出现者，与 `foldWorkspaceEvents` 同款）
  const lastByPath = new Map<string, string>()
  for (const item of real) {
    const at = item.at.toISOString()
    const previous = lastByPath.get(item.path)
    if (previous === undefined || at >= previous) lastByPath.set(item.path, at)
  }
  const since = [...lastByPath.values()].reduce((min, at) => (at < min ? at : min))
  return { since }
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

/** 落一条撤销（范围判定 → 回滚点 → CAS 校验 → 删除 / 写回 / 记结论） */
async function applyRevertCandidate(
  conversationId: string,
  candidate: WorkspaceRevertCandidate,
  scope: WorkspaceRevertScope,
  selected: readonly string[],
  dryRun: boolean,
): Promise<WorkspaceRevertEntry> {
  const row = await findRow(conversationId, candidate.path)
  const currentVersion = row?.version ?? 0
  const currentDeleted = row === null || row.deletedAt !== null
  // ★ 2026-10-29（用户定案「无论如何都是前一个版本」）：回滚点 = 本段最后一跳之前那一版。
  //   `rollbackAfterUserEdit` 那套"手写后 / 段初"二选一已废弃 —— 无论选哪个范围，撤销都只退一步。
  const rollback = revertRollbackVersion(candidate)
  const base = {
    path: candidate.path,
    currentVersion,
    fromVersion: candidate.beforeVersion,
    rollbackFrom: rollback.reason,
    defaultSelected: candidate.lastActor !== 'USER',
  }

  if (candidate.unsupported !== undefined) {
    return { ...base, action: 'unsupported', toVersion: null, message: candidate.unsupported }
  }

  // ★ 2026-10-28：范围判定在这里统一收口（默认只撤 agent；手写收尾的故意不动）
  if (!shouldRevertPath(candidate, scope, selected)) {
    return {
      ...base,
      action: 'skipped',
      toVersion: null,
      message:
        candidate.lastActor === 'USER'
          ? '这一段以你的手写收尾，默认不撤销（需要的话切到「包含我的修改」或逐条勾选）'
          : '不在本次撤销范围内',
    }
  }

  // CAS：确认"此后无人再动"（段末状态 == 当前状态）
  if (candidate.expect.deleted) {
    if (!currentDeleted) {
      return { ...base, action: 'conflict', toVersion: null, message: '本轮之后该文件又被改动，未自动覆盖' }
    }
  } else if (currentDeleted || currentVersion !== candidate.expect.version) {
    return {
      ...base,
      action: 'conflict',
      toVersion: null,
      message: `本轮之后该文件又被改动（当前 v${currentVersion}），未自动覆盖`,
    }
  }

  // ★ 回滚点：本段最后一跳之前那一版（= 文件级"撤销一步"）。
  //   回滚点不存在 ⇒ 唯一成因是"这一跳本身就是新建"⇒ 撤销 = 删掉这个新文件。
  const target = rollback.version
  if (target === null) {
    if (currentDeleted) {
      return { ...base, action: 'skipped', toVersion: null, message: '本轮内建了又删，净变化为零' }
    }
    if (!dryRun) await deleteWorkspaceFile(conversationId, candidate.path, REVERT_ACTOR)
    return { ...base, fromVersion: null, action: 'deleted', toVersion: null }
  }
  // 回滚点 == 当前版本 ⇒ 已经是那个状态（例如手写后 agent 没改动过），无可撤
  if (!candidate.expect.deleted && target === candidate.expect.version) {
    return { ...base, action: 'skipped', toVersion: null, message: '回滚点就是当前版本，无可撤销的改动' }
  }

  const hash = await versionHashOf(conversationId, candidate.path, target)
  if (hash === null) {
    return { ...base, fromVersion: target, action: 'unavailable', toVersion: null, message: `版本 v${target} 无索引` }
  }
  const bytes = await readWorkspaceBlob(config.workspace.root, conversationId, hash)
  if (bytes === null) {
    return {
      ...base,
      fromVersion: target,
      action: 'unavailable',
      toVersion: null,
      message: `版本 v${target} 的字节缺失（冷备前的历史）`,
    }
  }
  const mime = workspaceMimeOf(candidate.path)
  // 二进制（按扩展名**或**按内容嗅探，P6 · R6）都不支持整轮撤销：写回要走文本写接口，
  // 而该接口对二进制一律拒收 —— 这里如实记 `unsupported`，不让它在写回时炸出 VALIDATION。
  if (!isWorkspaceTextMime(mime) || workspaceContentIsBinary(bytes)) {
    return {
      ...base,
      fromVersion: target,
      action: 'unsupported',
      toVersion: null,
      message: isWorkspaceTextMime(mime) ? '文件内容为二进制，不支持整轮撤销' : `二进制文件（${mime}）不支持整轮撤销`,
    }
  }
  if (dryRun) return { ...base, fromVersion: target, action: 'restored', toVersion: null }
  // ★ 2026-10-28：还原时同样走编码嗅探 —— UTF-16 / GBK 的历史字节按 UTF-8 解再写回，等于把文件写坏。
  const written = await writeWorkspaceFile(
    conversationId,
    candidate.path,
    decodeTextBuffer(bytes).text,
    currentVersion,
    REVERT_ACTOR,
  )
  return { ...base, fromVersion: target, action: 'restored', toVersion: written.version }
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