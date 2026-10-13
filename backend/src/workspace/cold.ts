/**
 * 工作区 **S3 冷备与恢复**（P1-9 · P5 · R3）—— 内容寻址的字节冷备 + 换机/重建还原
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 4（同步/恢复/GC 三个时机）、§三（S3 键规则
 *      `workspaces/{conversationId}/blobs/{sha256}`）、§十三 已决 7（`.git` 进冷备）、
 *      §十二 P5（"容器回收后工作区仍在；宿主迁移后从 S3 重建"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与 `blob.ts`（本地历史字节）的关系：这是它的 **S3 另一半**
 * ─────────────────────────────────────────────────────────────────────
 * `blob.ts` 把"将要被覆盖/删除的旧字节"按 sha256 落到**宿主本地**（P4 R2 撤销本轮据此）。
 * 本模块把**同一批内容**再镜像到 S3：`workspaces/{conversationId}/blobs/{sha256}`。两条线
 * 共用"内容寻址"这一条判据 ⇒ 冷备对象即历史字节对象的远端副本，恢复只需按 hash 取字节。
 *
 * ⚠️ **上行是异步去抖的（尽力而为）**：写盘是热路径，不该等一个跨网络的对象存储往返
 *    （与产物/记忆等旁路同款纪律）。失败只 warn，等下一次写同一内容时再试。
 *
 * ⚠️ **恢复只在"目录缺失/为空"时发生**：那是"换机 / 宿主重建 / 目录被清"的判据。
 *    正常运行时（目录有内容）绝不触发，避免把人正在编辑的工作区从冷备**回滚**。
 */

import type { Readable } from 'node:stream'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureBucket, getS3Client, isS3NoSuchKey } from '../infra/s3.js'
import { planWorkspaceRestore, workspaceColdKey, workspaceColdPrefix } from './coldModel.js'
import { resolveWorkspacePath, workspaceDirOf, WORKSPACE_BACKUP_DEBOUNCE_MS } from './paths.js'
import { ensureWorkspaceDir, writeWorkspaceBytes } from './store.js'

// ───────────────────────────── 上行（写后异步冷备） ─────────────────────────────

/** 一次待上行的内容（按对象键去重） */
interface PendingBackup {
  conversationId: string
  hash: string
  data: Buffer
}

/** 去抖窗口里攒着的内容（键 = S3 对象键 ⇒ 同内容只上行一次；后写者覆盖旧值，内容其实相同） */
const pendingBackups = new Map<string, PendingBackup>()
/** 本进程已确认上行的对象键（免去每次写的 HEAD 探测；重启后重探一次也无害） */
const backedUpKeys = new Set<string>()
let flushTimer: NodeJS.Timeout | undefined

/**
 * 排一份内容进"待冷备"队列（**同步返回、不阻塞写盘**）。
 *
 * 由工作区服务（`service.ts`）在**每次内容版本落盘后**调用 —— 覆盖写 / 删除前的**旧**内容与
 * **新**内容都各自会被排队 ⇒ 任一历史版本都能在 S3 找到。
 */
export function scheduleWorkspaceBlobBackup(conversationId: string, hash: string, data: Buffer): void {
  const key = workspaceColdKey(conversationId, hash)
  if (backedUpKeys.has(key)) return
  pendingBackups.set(key, { conversationId, hash, data })
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flushWorkspaceColdBackups()
    }, WORKSPACE_BACKUP_DEBOUNCE_MS)
    // `unref`：这个定时器不该拖住进程退出（去抖只是省请求，不是正确性）
    flushTimer.unref?.()
  }
}

/**
 * 立即排空待冷备队列（进程退出前 / 自证脚本里调）。
 *
 * @returns 尝试上行 / 成功上行的条数（`uploaded` 不含"对象已存在、跳过"的）
 */
export async function flushWorkspaceColdBackups(): Promise<{ attempted: number; uploaded: number }> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  const batch = [...pendingBackups.values()]
  pendingBackups.clear()
  let uploaded = 0
  for (const item of batch) {
    if (await backupWorkspaceBlob(item.conversationId, item.hash, item.data)) uploaded += 1
  }
  return { attempted: batch.length, uploaded }
}

/**
 * 把一份内容即时上行到 S3（内容寻址、幂等）并回填 `s3Key`。**失败只 warn、返回 `false`**。
 *
 * 三步：
 *   ① 对象不存在才 `putObject`（内容寻址 ⇒ 已存在即同一份字节，跳过省一次上传）；
 *   ② 记进本进程的"已上行"集合（省后续 HEAD 探测）；
 *   ③ 回填 `workspace_files` / `workspace_file_versions` 的 `s3Key`（可观测：这一版是否已冷备）。
 */
export async function backupWorkspaceBlob(conversationId: string, hash: string, data: Buffer): Promise<boolean> {
  const key = workspaceColdKey(conversationId, hash)
  if (backedUpKeys.has(key)) return false
  const logger = getLogger()
  try {
    const bucket = config.s3.bucket
    const s3 = getS3Client()
    await ensureBucketOnce(bucket)
    if (!(await objectExists(bucket, key))) {
      await s3.putObject(bucket, key, data, data.byteLength, { 'Content-Type': 'application/octet-stream' })
    }
    backedUpKeys.add(key)
    await backfillS3Key(conversationId, hash, key)
    return true
  } catch (error) {
    logger.warn({ err: error, conversationId, hash }, '工作区冷备上行失败（内容仍在宿主本地，下次再试）')
    return false
  }
}

/** 回填 `s3Key`（对象键可由内容 hash 推导，回填只为"这一版是否已冷备"在库结构上可查） */
async function backfillS3Key(conversationId: string, hash: string, key: string): Promise<void> {
  const prisma = getPrisma()
  await prisma.workspaceFile.updateMany({
    where: { conversationId, contentHash: hash, s3Key: null },
    data: { s3Key: key },
  })
  await prisma.workspaceFileVersion.updateMany({
    where: { contentHash: hash, s3Key: null, file: { conversationId } },
    data: { s3Key: key },
  })
}

// ───────────────────────────── 恢复（换机 / 重建） ─────────────────────────────

/** 一次恢复的计数（观测 / 验收用） */
export interface WorkspaceRestoreReport {
  /** 成功写回宿主目录的文件数 */
  restored: number
  /** 索引里有、S3 无对象的文件数（冷备未覆盖到这个版本） */
  missing: number
  /** 取字节 / 落盘失败的文件数 */
  failed: number
  /** 索引行残缺（无 hash）被跳过的文件数 */
  skipped: number
}

/** 同一会话的恢复进行中 ⇒ 复用同一个 Promise（避免并发 ensure 触发两次全量还原） */
const restoreInflight = new Map<string, Promise<WorkspaceRestoreReport>>()

/**
 * 从 S3 按**最新版本**重建这个会话的工作区目录（幂等）。
 *
 * ⚠️ 调用方只在"目录缺失/为空"时调（见 `service#ensureWorkspace` 的判据）；这里不再自判，
 *    以免"目录里有一部分内容"时把缺的部分当正常并静默不回填。
 */
export function restoreWorkspaceFromCold(conversationId: string): Promise<WorkspaceRestoreReport> {
  const existing = restoreInflight.get(conversationId)
  if (existing !== undefined) return existing
  const promise = doRestoreWorkspaceFromCold(conversationId).finally(() => {
    restoreInflight.delete(conversationId)
  })
  restoreInflight.set(conversationId, promise)
  return promise
}

async function doRestoreWorkspaceFromCold(conversationId: string): Promise<WorkspaceRestoreReport> {
  const report: WorkspaceRestoreReport = { restored: 0, missing: 0, failed: 0, skipped: 0 }
  const rows = await getPrisma().workspaceFile.findMany({
    where: { conversationId, deletedAt: null },
    select: { path: true, contentHash: true, mime: true, size: true },
  })
  const plan = planWorkspaceRestore(rows)
  report.skipped = plan.skipped.length
  if (plan.items.length === 0) return report

  const rootPath = workspaceDirOf(config.workspace.root, conversationId)
  await ensureWorkspaceDir(rootPath)
  const bucket = config.s3.bucket
  const s3 = getS3Client()

  for (const item of plan.items) {
    try {
      const key = workspaceColdKey(conversationId, item.hash)
      let bytes: Buffer
      try {
        // ⚠️ `getObject` 对不存在的键**不在 await 时抛错**（错误发生在读流时，同产物取流口径）
        bytes = await streamToBuffer(await s3.getObject(bucket, key))
      } catch (error) {
        if (isS3NoSuchKey(error)) {
          report.missing += 1
          continue
        }
        throw error
      }
      const { absolute } = resolveWorkspacePath(rootPath, item.path)
      await writeWorkspaceBytes(absolute, bytes)
      report.restored += 1
    } catch (error) {
      report.failed += 1
      getLogger().warn({ err: error, conversationId, path: item.path }, '工作区冷备恢复：文件还原失败（继续其余）')
    }
  }
  getLogger().info({ conversationId, ...report }, '工作区冷备恢复完成')
  return report
}

// ───────────────────────────── 清理（孤儿 / 保留期） ─────────────────────────────

/** 一次冷备清理的结论（`failed` = 有对象没删掉 ⇒ 调用方应保留行以便下一轮重试） */
export interface WorkspaceColdDeleteReport {
  /** 真的删掉的对象数 */
  removed: number
  /** 是否有失败（列举出错 / 部分对象删失败 / 网络错误） */
  failed: boolean
}

/**
 * 删掉一个会话的全部冷备对象（reaper 清孤儿工作区 / 超保留期工作区时一并收）。
 *
 * ⚠️ **按前缀整体删**：内容寻址的对象没有"逐文件行"可对照（同一对象可能被多个版本引用），
 *    所以判据是"这个会话的冷备前缀下还有没有对象"，而不是逐 hash 删。
 *
 * ★ **成功才让调用方删行**（与 `reapExpiredArtifacts` 同款纪律：对象删成功才删行）：失败如实
 *   返回 `failed: true`，调用方**保留 DB 行**、下一轮再试 —— 否则会留下"行没了、对象还在"的暗账。
 *   桶不存在 ⇒ 没有对象可删，不算失败（`failed: false`）。
 */
export async function deleteWorkspaceColdBlobs(conversationId: string): Promise<WorkspaceColdDeleteReport> {
  const logger = getLogger()
  const bucket = config.s3.bucket
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) return { removed: 0, failed: false }
    const names: string[] = []
    const stream = s3.listObjectsV2(bucket, workspaceColdPrefix(conversationId), true)
    for await (const item of stream) {
      if (typeof item.name === 'string' && item.name !== '') names.push(item.name)
    }
    if (names.length === 0) return { removed: 0, failed: false }
    const results = await s3.removeObjects(bucket, names)
    const failed = results.filter((entry) => entry != null && entry.Error != null).length
    if (failed > 0) {
      logger.warn({ conversationId, failed }, '工作区冷备清理：部分对象删除失败（保留行，下一轮再试）')
      return { removed: names.length - failed, failed: true }
    }
    return { removed: names.length, failed: false }
  } catch (error) {
    logger.warn({ err: error, conversationId }, '工作区冷备清理失败（保留行，下一轮再试）')
    return { removed: 0, failed: true }
  }
}

/**
 * 丢弃某会话仍在**去抖窗口**里的冷备上行，并忘掉本进程的"已上行"记忆（清理工作区后调用）。
 *
 * 两条都必须做，否则清理会被**反噬**：
 *   · 不丢 `pendingBackups` ⇒ 去抖定时器稍后仍会把这批内容传上去（刚删完 S3 又冒出来）；
 *   · 不清 `backedUpKeys` ⇒ 将来同内容的工作区会以为"已上行"而**跳过上传**（S3 缺对象）。
 */
export function dropPendingWorkspaceBackups(conversationId: string): void {
  const prefix = workspaceColdPrefix(conversationId)
  for (const key of [...pendingBackups.keys()]) {
    if (key.startsWith(prefix)) pendingBackups.delete(key)
  }
  for (const key of [...backedUpKeys]) {
    if (key.startsWith(prefix)) backedUpKeys.delete(key)
  }
}

// ───────────────────────────── 内部工具 ─────────────────────────────

/** 桶只探一次（首次上传时按需建；失败则下次再探） */
let bucketReady: Promise<void> | undefined

function ensureBucketOnce(bucket: string): Promise<void> {
  bucketReady ??= ensureBucket(bucket).catch((error: unknown) => {
    bucketReady = undefined
    throw error
  })
  return bucketReady
}

/** 对象是否存在（`statObject` 探测；不存在返回 `false`，其余错误抛出） */
async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getS3Client().statObject(bucket, key)
    return true
  } catch (error) {
    if (isS3NoSuchKey(error)) return false
    throw error
  }
}

/** 把 minio 的可读流收成 Buffer（恢复需要完整字节才能原子落盘） */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    const value: unknown = chunk
    if (Buffer.isBuffer(value)) chunks.push(value)
    else if (typeof value === 'string') chunks.push(Buffer.from(value))
    else if (value instanceof Uint8Array) chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
