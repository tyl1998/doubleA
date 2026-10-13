/**
 * 工作区**历史字节**存储（P1-9 · P4 · R2）—— 宿主本地、内容寻址（sha256）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 4（冷备与恢复：**内容寻址** blob）、
 *      §七 5（撤销本轮需要"被覆盖文件的历史字节"）、§196（S3 键规则 `…/blobs/{sha256}`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它：版本表只存 `contentHash`，字节在盘上会被覆盖
 * ─────────────────────────────────────────────────────────────────────
 * `workspace_file_versions` 每版本只留 `contentHash`（判"内容是否真变"），**不留字节**。
 * 而「撤销本轮」要按 `beforeVersion` 把内容**写回去** ⇒ 必须有那个版本的字节。本模块就是
 * 这份字节的落点：**每次将要被覆盖/删除的内容先按 sha256 存一份**，于是"任一历史版本"都可
 * 按 hash 取回。
 *
 * ⚠️ 这是 **P5 S3 冷备的本地半边**：S3 上行（`workspaces/{id}/blobs/{sha256}`）与 blob GC
 *    仍属 P5；本批先落"宿主本地可还原"，兑现「撤销本轮」。（多机下换机重建仍需 S3，见 §十六 E）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 放在**会话目录之外**（`{root}/.blobs/{conversationId}/{sha256}`）
 * ─────────────────────────────────────────────────────────────────────
 * 会话目录会被 bind mount 进容器 `/work`、也会被产物扫描 `find /work` 看到。放到它外面，
 * 这三个出口（容器可见 / 产物候选 / 工作区内容）就**天然都不包含** blob —— 不用额外加排除规则。
 */

import { mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { getLogger } from '../infra/logger.js'

/** blob 根目录名（`{WORKSPACE_ROOT}/.blobs/{conversationId}/…`；见文件头） */
export const WORKSPACE_BLOB_DIR = '.blobs'

/** 一个会话的 blob 目录（绝对路径） */
export function workspaceBlobDirOf(root: string, conversationId: string): string {
  return join(root, WORKSPACE_BLOB_DIR, conversationId)
}

/** 某个内容 hash 的 blob 绝对路径 */
export function workspaceBlobPathOf(root: string, conversationId: string, hash: string): string {
  return join(workspaceBlobDirOf(root, conversationId), hash)
}

/**
 * 存一份字节（内容寻址）—— 已存在即**跳过**（相同内容零新增对象，§196）。
 *
 * @param hash 调用方算好的 sha256（`service#sha256`；避免本模块再引一份哈希实现）
 * @returns 是否**新写入**（`false` = 已存在，跳过了）
 */
export async function putWorkspaceBlob(
  root: string,
  conversationId: string,
  hash: string,
  data: Buffer,
): Promise<boolean> {
  const target = workspaceBlobPathOf(root, conversationId, hash)
  if (await blobExists(target)) return false
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(tmp, data, { mode: 0o644 })
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch((cleanupError: unknown) => {
      getLogger().debug({ err: cleanupError, tmp }, '清理工作区 blob 临时文件失败')
    })
    throw error
  }
  return true
}

/** 读一份字节；不存在返回 `null`（调用方据此判 `unavailable`） */
export async function readWorkspaceBlob(root: string, conversationId: string, hash: string): Promise<Buffer | null> {
  try {
    return await readFile(workspaceBlobPathOf(root, conversationId, hash))
  } catch {
    return null
  }
}

/** blob 是否存在 */
export async function workspaceBlobExists(root: string, conversationId: string, hash: string): Promise<boolean> {
  return await blobExists(workspaceBlobPathOf(root, conversationId, hash))
}

async function blobExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}
