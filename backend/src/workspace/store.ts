/**
 * 工作区字节层（P1-9 · P0）—— 宿主 FS 上的 canonical 工作区的读写/列举
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 1（热路径 = 本地 FS）、§五 1（uid 对齐）、§九（配额/二进制）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件只认"绝对路径"，**不解析相对路径、不做包含性校验**
 * ─────────────────────────────────────────────────────────────────────
 * 路径判据一律走 `workspace/paths.ts#resolveWorkspacePath`（归一化 + realpath 包含性），
 * 本文件拿到的一定已经是"确认落在根内"的绝对路径。这样切分后：
 *   · 判据可以在临时目录里逐条核对；
 *   · 本文件的每个函数都只做一件 FS 事，错误重试/补偿的边界清晰。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 写入一律"先写临时名、再 rename"（原子替换）
 * ─────────────────────────────────────────────────────────────────────
 * 直接 `writeFile` 到目标名，读侧可能读到**半截**（尤其 agent 与人在同一时刻读）。
 * rename 在同一个目录内是原子的 ⇒ 读侧要么看到旧整份、要么看到新整份，不会看到中间态。
 * 临时名以 `.workspace-tmp-` 开头，**列举时排除**（它不该成为工作区内容）。
 */

import { chown, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { getLogger } from '../infra/logger.js'
import { SANDBOX_AGENT_UID } from '../sandbox/spec.js'
import { looksBinaryWorkspaceContent } from './quotaModel.js'
import { isWorkspaceDependencyDirName } from './dependencyModel.js'

/** 原子写的临时文件名前缀（列举时排除；见文件头） */
export const WORKSPACE_TMP_PREFIX = '.workspace-tmp-'

/** 工作区目录的权限（rwxr-xr-x；容器内 agent 需要能读写） */
const WORKSPACE_DIR_MODE = 0o755
/** 文件的默认权限 */
const WORKSPACE_FILE_MODE = 0o644

/** 建（或确认）一个会话的工作区目录；返回其绝对路径 */
export async function ensureWorkspaceDir(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true, mode: WORKSPACE_DIR_MODE })
  await alignAgentOwnership(rootDir)
}

/**
 * 尽力把目录/文件的属主对齐到容器内 `agent` 的 uid（§五 1：bind mount 属主不匹配 ⇒ 容器里读写失败）。
 *
 * ⚠️ **只在以 root 运行时才尝试**（本地开发以普通用户跑，`chown` 必失败且无意义）；
 * 失败只 debug 日志、**不抛错** —— 属主是**部署形态**问题（多数生产是 root 起的后端），
 * 不该让一次正常写盘因为"本机不能 chown"而失败。`SANDBOX_AGENT_UID` 是镜像与运行时的契约常量。
 */
export async function alignAgentOwnership(target: string): Promise<void> {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    await chown(target, SANDBOX_AGENT_UID, SANDBOX_AGENT_UID)
  } catch (error) {
    getLogger().debug({ err: error, target }, '工作区属主对齐失败（非致命：以部署形态为准）')
  }
}

/**
 * 工作区目录是否**缺失或为空**（= "需要从冷备恢复"的判据，P1-9 · R3）。
 *
 * 三条口径：
 *   · 目录不存在 ⇒ `true`（换机 / 宿主重建后的第一态）；
 *   · 目录里只有原子写的临时文件（{@link WORKSPACE_TMP_PREFIX}）⇒ `true`（不算内容）；
 *   · 其余任何条目（含子目录、符号链接）⇒ `false`（有内容，绝不从冷备回滚覆盖它）。
 */
export async function workspaceDirIsEmpty(rootDir: string): Promise<boolean> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    return entries.every((entry) => entry.name.startsWith(WORKSPACE_TMP_PREFIX))
  } catch {
    return true
  }
}

/** 读一个文件的完整字节 */
export async function readWorkspaceBytes(absolute: string): Promise<Buffer> {
  return await readFile(absolute)
}

/**
 * 内容**二进制嗅探**（P1-9 · P6 · R6）—— 字节层出口，判据本体在 `quotaModel.ts`（纯函数可自证）。
 *
 * 看的是**实际字节**（前 {@link WORKSPACE_BINARY_SAMPLE_BYTES} 内的 NUL），不是扩展名：
 * 一个叫 `notes.txt` 却含 NUL 的文件照样判为二进制 ⇒ 读路径不给内联文本（否则编辑器是乱码）、
 * 写路径拒收（工作区文本写接口不接二进制）。与 `isWorkspaceTextMime`（按扩展名）**互为补充**：
 * 后者回答"这类文件该不该给编辑器"，前者回答"这份内容到底是不是文本"。
 */
export function workspaceContentIsBinary(data: Buffer): boolean {
  return looksBinaryWorkspaceContent(data)
}

/** 是否存在（含文件/目录；不跟随符号链接判断，交给上层 realpath 判据） */
export async function workspaceExists(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute)
    return true
  } catch {
    return false
  }
}

/** 文件大小（字节）；不存在/不可统计时返回 `undefined` */
export async function workspaceFileSize(absolute: string): Promise<number | undefined> {
  try {
    const info = await stat(absolute)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * 原子写：`mkdir -p` 父目录 → 写临时文件 → `rename` 覆盖目标（见文件头）。
 * @returns 写入的字节数
 */
export async function writeWorkspaceBytes(absolute: string, data: Buffer): Promise<number> {
  const parent = dirname(absolute)
  await mkdir(parent, { recursive: true, mode: WORKSPACE_DIR_MODE })
  await alignAgentOwnership(parent)
  const tmp = join(parent, `${WORKSPACE_TMP_PREFIX}${randomBytes(8).toString('hex')}`)
  try {
    await writeFile(tmp, data, { mode: WORKSPACE_FILE_MODE })
    await rename(tmp, absolute)
  } catch (error) {
    // 临时文件残留会让下次列举看到一半的垃圾 ⇒ 尽力清掉（失败只 debug）
    await rm(tmp, { force: true }).catch((cleanupError: unknown) => {
      getLogger().debug({ err: cleanupError, tmp }, '清理工作区临时文件失败')
    })
    throw error
  }
  await alignAgentOwnership(absolute)
  return data.byteLength
}

/** 删除一个文件（不存在视为成功）；返回是否真的删掉了 */
export async function removeWorkspaceFile(absolute: string): Promise<boolean> {
  if (!(await workspaceExists(absolute))) return false
  await rm(absolute, { force: true })
  return true
}

/** 改名/移动（父目录自动建）；跨目录移动时同卷 `rename` 即原子 */
export async function moveWorkspaceFile(fromAbsolute: string, toAbsolute: string): Promise<void> {
  await mkdir(dirname(toAbsolute), { recursive: true, mode: WORKSPACE_DIR_MODE })
  await rename(fromAbsolute, toAbsolute)
  await alignAgentOwnership(toAbsolute)
}

/** 递归列举里的一条（相对根路径 + 字节数 + mtime） */
export interface WorkspaceScanEntry {
  relative: string
  size: number
  mtimeMs: number
}

/** {@link scanWorkspaceTree} 的结果：源码条目 + **依赖字节单独计量**（P1-17b 的"配额口径区分"） */
export interface WorkspaceScanResult {
  entries: WorkspaceScanEntry[]
  /**
   * 依赖目录（{@link WORKSPACE_DEPENDENCY_DIRS}）里的字节总数。
   * **不进 `entries`**（依赖不被索引 → 不进文件树 / 源码配额 / 冷备），但单独量出来供观测：
   * 这样"源码配额"与"依赖体积"是两个数，而不是一个混在一起的数（`子方案` §五之二 3 ③）。
   */
  dependencyBytes: number
}

/**
 * 递归扫描工作区目录（**内容事件 + 轮末对账的输入**；watcher 与"重建索引"共用）。
 *
 * 四条口径：
 *   · **跳过临时文件**（{@link WORKSPACE_TMP_PREFIX} 开头）—— 它们不是内容；
 *   · **依赖目录不下钻进索引**（{@link isWorkspaceDependencyDirName}，P1-17b）—— 只累计其字节数；
 *   · **符号链接不跟随**（`lstat` 判 `isSymbolicLink` ⇒ 跳过）—— 跟随会把根外的文件也列进来，
 *     与 `resolveWorkspacePath` 的逃逸判据配套：**列举侧与读取侧都不能穿过符号链接**；
 *   · 排序稳定（字典序），便于逐条比对；目录本身不作为条目（空目录不是内容）。
 */
export async function scanWorkspaceTree(rootDir: string): Promise<WorkspaceScanResult> {
  const entries: WorkspaceScanEntry[] = []
  const state = { dependencyBytes: 0 }
  await walk(rootDir, '', entries, state)
  entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
  return { entries, dependencyBytes: state.dependencyBytes }
}

/** 只要条目（旧签名，保留给只关心"有哪些文件"的调用方；依赖目录同样被排除） */
export async function scanWorkspaceFiles(rootDir: string): Promise<WorkspaceScanEntry[]> {
  return (await scanWorkspaceTree(rootDir)).entries
}

/** 递归过程中跨层累积的读数（`dependencyBytes` 是唯一的可变状态） */
interface WalkState {
  dependencyBytes: number
}

async function walk(
  dirAbsolute: string,
  prefix: string,
  out: WorkspaceScanEntry[],
  state: WalkState,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true })
  } catch (error) {
    // 目录在扫描途中被删（agent/host 并发）不该让整次扫描失败
    getLogger().debug({ err: error, dir: dirAbsolute }, '扫描工作区目录失败（跳过该目录）')
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(WORKSPACE_TMP_PREFIX)) continue
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const childAbsolute = join(dirAbsolute, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      // ★ P1-17b：依赖目录**不进索引**（不产生条目、不产生事件、不进文件树/配额/冷备），
      //   但把它的字节数**量出来**（观测用；见 WorkspaceScanResult.dependencyBytes）。
      if (isWorkspaceDependencyDirName(entry.name)) {
        state.dependencyBytes += await measureDirBytes(childAbsolute)
        continue
      }
      await walk(childAbsolute, relative, out, state)
    } else if (entry.isFile()) {
      try {
        const info = await stat(childAbsolute)
        out.push({ relative, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // 扫描与删除竞态：跳过
      }
    }
  }
}

/**
 * 量一个目录（通常是依赖目录）的**总字节**（`du -sb` 的等价物，纯 Node）。
 *
 * ⚠️ 它是**观测口径**、不是配额判据：只累加普通文件字节，符号链接不跟随（与列举同纪律）。
 *    依赖目录可能上万个文件，故这里用 `readdir` 逐层下钻（Node 没有内置 `du`）。
 */
async function measureDirBytes(dirAbsolute: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const childAbsolute = join(dirAbsolute, entry.name)
    if (entry.isDirectory()) total += await measureDirBytes(childAbsolute)
    else if (entry.isFile()) {
      try {
        total += (await stat(childAbsolute)).size
      } catch {
        // 竞态（扫描途中被删）：跳过
      }
    }
  }
  return total
}