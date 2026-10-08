/**
 * 产物收集（P0-3-7）—— 「工作卷扫 → 对象存储 → `artifacts` 行 → `artifact` 事件」的四段链
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §十一（产物收集与交付，全文）+ §九 1（"产物立刻出容器"）、
 *      `docs/02-后端设计.md` §三（`artifacts` 表）/ §5.2（"done 时整条落库，含 artifacts 结构"）、
 *      `docs/06-实施计划.md` §五 P0-3-7 行
 *
 * ```
 * 编排层（taskAgent.ts）在本轮的两端各调一次本模块：
 *   派活之前    snapshotWorkFiles()   → 拍基线（P0-3-6 详规传下来的口径 ②：
 *                                      基线必须**在派活之前**拍，不许收尾之后补）
 *   agent_settled collectRoundArtifacts() → 对照 → 过滤 → 传对象 → 建行
 *                                      → 把建好的行交回编排层发 `artifact` 事件
 * 保留期        reapExpiredArtifacts() → 周期清理（挂在对账器同一轮里，§十一 4）
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据一：扫描的是「**这一轮**新出现或修改的」（§十一 1）
 * ═══════════════════════════════════════════════════════════════════════
 * 基线**每一轮拍**（派活之前），不是子方案原文写的"容器启动时拍一次"——那是 P0-3-6 详规
 * 传下来的修正口径：复用容器跑第二轮时，"启动时的基线"会让第一轮的产物**再报一次**
 * （症状：产物列表里同一个文件两份、时间还不一样）。改成"每轮派活之前拍"，第二轮的
 * 基线天然是上一轮的收尾态，多轮语义自动成立，且**不需要任何跨轮的进程内状态**
 * （后端重启、容器换血都不会留脏账）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据二：过滤规则**全部要留痕**（§十一 2 —— "都要有日志，不静默丢"）
 * ═══════════════════════════════════════════════════════════════════════
 *   · 隐藏文件/目录（路径任一段以 `.` 开头）⇒ 跳过（引擎自己的 dotfile 全在这一条里，
 *     如 pi 的 `.pi` —— 不需要为它们单列黑名单）；
 *   · `ARTIFACT_EXCLUDED_DIRS`（见下方）⇒ 跳过（引擎/依赖的工作目录，显式列出、
 *     一处定义 —— 子方案要求"名单显式列在配置里，不要写死一串 magic path"）；
 *   · 单文件超过 `ARTIFACT_MAX_FILE_MB` ⇒ 跳过 + **warn**；
 *   · 总数超过 `ARTIFACT_SCAN_MAX_FILES` ⇒ **截断** + warn（防引擎写一万个小文件打爆上传）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据三：顺序不能反 —— **先传对象、再建行**（§十一 3）
 * ═══════════════════════════════════════════════════════════════════════
 * 反过来会出现"列表里有个文件、点下载才发现对象不存在"。建行失败时**补偿删对象**
 * （与 `document.service.ts` 的上传同一条纪律）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 两条边界（写在这里免得下次误改）
 * ═══════════════════════════════════════════════════════════════════════
 *   · **产物不跟会话/Agent 的删除走**（`TaskAgent记忆与产物` 块 3 起**字面成立**）：
 *     schema 的 `Artifact.conversationId` 是可空 + `onDelete: SetNull` —— 删会话只把
 *     `conversation_id` 置空、产物行保留（归"会话产物"，按 `user_id` 可查，可在
 *     「会话产物」页主动删除）；文件与行的**过期收口只有保留期清理器**
 *     （`02` §三"消息与产物都不删"的完整语义）。
 *   · **收集失败 ≠ 这一轮失败**：编排层对本模块的一切异常都 catch + warn 后继续收尾
 *     （产物是本轮的**赠品**，不是交付物本体；正文已经流出去了）。
 */

import { randomUUID } from 'node:crypto'

import type { ArtifactItem } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureBucket, getS3Client } from '../infra/s3.js'
import { execInSandbox } from './docker.js'
import { SANDBOX_WORK_DIR } from './spec.js'

/**
 * 扫描排除的**顶层相对目录**（`子方案③` §十一 2 的"引擎自身的工作文件"名单）。
 *
 * ⚠️ **显式列出、一处定义**（不写死散落）：加名字只改这一处；隐藏目录（`.` 开头）
 * 由那条通用规则单独覆盖、不进本名单（两套规则混写就会出现"删了规则忘了名单"的分叉）。
 * - `node_modules`：镜像刻意不装包管理器，但工具运行期（pandas/jq 等）可能解出依赖目录 ——
 *   那是**环境**不是**产物**，且动辄几千个小文件，只会打爆 `ARTIFACT_SCAN_MAX_FILES`。
 */
export const ARTIFACT_EXCLUDED_DIRS: readonly string[] = ['node_modules']

/**
 * 单条 `docker exec` 的时限（代码常量，不进 env —— 与 `map.ts` 两个数值常量同款取舍：
 * 它不是"行为窗口"，改它不改变契约）。扫描（find）与读文件（cat，最大 50MB）都够用。
 */
export const ARTIFACT_EXEC_TIMEOUT_MS = 60_000

/**
 * 一个产物文件在对象存储里的键前缀（与 `kb/` 平级的命名空间 —— 两类对象永不混淆）。
 */
const ARTIFACT_KEY_PREFIX = 'artifacts'

/** work 卷快照里一个文件的三个读数（路径 → 这三项） */
export interface WorkFileStat {
  /** 字节数（`find -printf %s`） */
  size: number
  /** mtime 的十进制秒（`find -printf %T@`，GNU 格式含小数）—— 只用于比对，不落库 */
  mtime: string
}

/**
 * work 卷快照：相对路径 → `{size, mtime}`。
 * `Map` 而不是数组：对照侧按路径点查，线性扫会把过滤逻辑写成 O(²)。
 */
export type WorkSnapshot = Map<string, WorkFileStat>

/**
 * 派活之前拍基线：`find /work` 一把抓「相对路径 + 大小 + mtime」。
 *
 * ⚠️ **失败即放弃本轮收集**（返回 `undefined` 而不是"当空基线"）：空基线会把
 * 复用容器里**上一轮的产物全部再报一次**（判据一的症状），比"这一轮少收了产物"糟。
 * 调用方（`taskAgent.ts`）对 `undefined` 的处置 = 跳过收集 + warn。
 */
export async function snapshotWorkFiles(containerId: string): Promise<WorkSnapshot | undefined> {
  let result
  try {
    result = await execInSandbox(
      containerId,
      ['find', SANDBOX_WORK_DIR, '-type', 'f', '-printf', '%P\t%s\t%T@\n'],
      { timeoutMs: ARTIFACT_EXEC_TIMEOUT_MS },
    )
  } catch (error) {
    getLogger().warn({ err: error, containerId }, '产物基线扫描失败：本轮跳过产物收集（避免把旧产物再报一次）')
    return undefined
  }
  if (result.exitCode !== 0) {
    getLogger().warn(
      { containerId, exitCode: result.exitCode, stderr: result.stderr.toString('utf8').slice(0, 500) },
      '产物基线扫描未成功（find 非 0 退出）：本轮跳过产物收集',
    )
    return undefined
  }
  return parseFindOutput(result.stdout)
}

/**
 * 解析 `find -printf '%P\t%s\t%T@\n'` 的输出（导出为纯函数是为了核查矩阵可以不连 Docker）。
 *
 * 三条解析纪律：
 *   · 含 `\n` / `\r` / `\t` 的路径**没法用这个格式无歧义表达** ⇒ 当场跳过并 warn
 *     （不静默丢；这类文件名几乎总是引擎在捣乱，不是用户的产物）；
 *   · 大小/时刻列不是合法数字 ⇒ 跳过并 warn；
 *   · 空行直接忽略（输出尾部惯例性的换行）。
 */
export function parseFindOutput(stdout: Buffer): WorkSnapshot {
  const snapshot: WorkSnapshot = new Map()
  const text = stdout.toString('utf8')
  const lines = text.split('\n')
  const skipped: string[] = []
  for (const line of lines) {
    if (line === '') continue
    const tab1 = line.indexOf('\t')
    const tab2 = line.indexOf('\t', tab1 + 1)
    if (tab1 < 0 || tab2 < 0) {
      skipped.push(line)
      continue
    }
    const path = line.slice(0, tab1)
    const size = Number(line.slice(tab1 + 1, tab2))
    const mtime = line.slice(tab2 + 1)
    if (path === '' || !Number.isInteger(size) || size < 0 || mtime === '') {
      skipped.push(line)
      continue
    }
    snapshot.set(path, { size, mtime })
  }
  if (skipped.length > 0) {
    getLogger().warn(
      { count: skipped.length, sample: skipped.slice(0, 5) },
      '基线扫描：部分文件名的路径含换行/制表符或读数不合法，已跳过（不静默丢，留痕于此）',
    )
  }
  return snapshot
}

/**
 * 基线对照（纯函数）：**这一轮新出现或修改的**文件。
 * 修改的判据 = `size` 或 `mtime` 与基线不一致（`find` 的 `%T@` 精度足以区分"重写过"）。
 */
export function diffWorkFiles(baseline: WorkSnapshot, current: WorkSnapshot): string[] {
  const changed: string[] = []
  for (const [path, stat] of current) {
    const before = baseline.get(path)
    if (before === undefined || before.size !== stat.size || before.mtime !== stat.mtime) {
      changed.push(path)
    }
  }
  return changed
}

/**
 * 过滤规则（§十一 2，全部带日志）。
 * 返回按路径排序后的**可上传清单**（顺序稳定 ⇒ 截断与日志在两次运行之间可比较）。
 * ⚠️ 单文件**大小**不在这里判（它依赖 `find` 的读数，而读数在"扫描 → 读出"之间可能失效）
 * —— 统一挪到 `collectRoundArtifacts` 里按实际读到的字节复核，一处判据。
 */
export function filterChangedFiles(paths: readonly string[], scanMaxFiles: number): string[] {
  const logger = getLogger()
  const accepted: string[] = []
  for (const path of paths) {
    // ① 隐藏文件 / 隐藏目录：路径里**任一段**以 `.` 开头都算（`out/.hidden` 与 `.cache/x` 同罪）
    if (path.split('/').some((segment) => segment.startsWith('.'))) continue
    // ② 引擎/依赖工作目录（顶层相对名，见 ARTIFACT_EXCLUDED_DIRS 的说明）
    const head = path.split('/')[0] ?? ''
    if (ARTIFACT_EXCLUDED_DIRS.includes(head)) continue
    accepted.push(path)
  }
  // ③ 单轮数量上限：超出即截断 + warn（防引擎写一万个小文件打爆上传）
  const limited = accepted.slice(0, scanMaxFiles)
  if (limited.length < accepted.length) {
    logger.warn(
      { changed: accepted.length, kept: limited.length, scanMaxFiles },
      '产物扫描：变化的文件数超过单轮上限，已截断（防引擎写一万个小文件打爆上传；其余文件留待下轮对照）',
    )
  }
  limited.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return limited
}

/**
 * 产物 `mime` 的判定（扫描时定一次，之后**所有人只读 `artifacts.mime`** —— `子方案④` §四）。
 *
 * 名单收得**刻意保守**：认识几类常见产物（文本/表格/网页/图片/PDF）就够，认识不了的一律
 * `application/octet-stream`（`previewKindOf` 对它返回 `none`，前端不给「预览」按钮，
 * 下载不受影响）。不做嗅探（嗅探猜错是静默的，`子方案④` §八 同款理由）。
 */
const ARTIFACT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  py: 'text/x-python',
  js: 'text/javascript',
  ts: 'text/typescript',
  sh: 'text/x-shellscript',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  log: 'text/plain',
}

/** 按扩展名定 mime（小写；不认识 → `application/octet-stream`）。导出为纯函数便于核对。 */
export function artifactMimeOf(path: string): string {
  const matched = /\.([^./\\]+)$/u.exec(path)
  const ext = matched?.[1]?.toLowerCase()
  return (ext !== undefined && ext in ARTIFACT_MIME_BY_EXTENSION ? ARTIFACT_MIME_BY_EXTENSION[ext] : undefined)
    ?? 'application/octet-stream'
}

/** 对象键里的文件名安全段：路径分隔符与控制字符一律 `_`（键是内部实现，不参与展示） */
function safeKeySegment(fileName: string): string {
  // 这里**就是要匹配控制字符**（ASCII 0x00–0x1F 会让 S3 键在某些客户端上难以处理）⇒ 显式豁免
  // eslint-disable-next-line no-control-regex
  return fileName.replace(/["\\\r\n\u0000-\u001f]/gu, '_')
}

/**
 * 收一轮产物：对照 → 过滤 → 逐个「读出文件 → 传对象 → 建行」。
 *
 * **尽力而为**：单个文件失败只 warn 并跳过（继续传其余），整体抛错由调用方决定是否吞掉
 * （编排层会吞）。**建行成功之前不对外可见** —— `artifact` 事件由编排层拿着返回值发，
 * 顺序天然满足"先传对象、再建行、最后发事件"。
 *
 * @returns 建好的行（形状 = `shared#artifactItemSchema`，可直接当 `artifact` 事件 payload
 *          与消息 `content.artifacts` 段用）
 */
export async function collectRoundArtifacts(input: {
  conversationId: string
  containerId: string
  /** 派活之前拍的基线（`snapshotWorkFiles` 的返回值；`undefined` 时调用方不该调本函数） */
  baseline: WorkSnapshot
}): Promise<ArtifactItem[]> {
  const { conversationId, containerId, baseline } = input
  const logger = getLogger()

  // 建行要写 `user_id`（`TaskAgent记忆与产物` 块 3：删除会话后产物行靠它归回给用户）。
  // 从会话行查一次（不信任任何传入值 —— 归属**只能**来自会话的 owner 列）。
  // ⚠️ 查不到 = 会话已经被删：产物无处归属，这一轮**整轮跳过**（比"每行都建失败再补偿删对象"
  //    干净 —— 那不是一次两次的偶发，而是结构性的事）。
  const owner = await getPrisma().conversation.findFirst({
    where: { id: conversationId },
    select: { userId: true },
  })
  if (owner === null) {
    logger.warn({ conversationId, containerId }, '产物收集时会话已不存在，本轮产物跳过（无法确定归属用户）')
    return []
  }

  const current = await snapshotWorkFiles(containerId)
  if (current === undefined) return []

  const changed = filterChangedFiles(diffWorkFiles(baseline, current), config.limits.artifactScanMaxFiles)
  if (changed.length === 0) return []

  const bucket = config.s3.bucket
  const maxFileBytes = config.limits.artifactMaxFileMb * 1024 * 1024
  const items: ArtifactItem[] = []

  for (const path of changed) {
    const stat = current.get(path)
    if (stat === undefined) continue
    // ③ 大小上限放行前判一次（find 的读数），读出后再按实际字节数复核（见下方）
    if (stat.size > maxFileBytes) {
      logger.warn(
        { conversationId, containerId, path, sizeMb: Math.round(stat.size / (1024 * 1024)) },
        '产物超过单文件上限，已跳过（文件仍在容器里，只是不收进产物面板）',
      )
      continue
    }

    try {
      const read = await execInSandbox(
        containerId,
        ['cat', '--', `${SANDBOX_WORK_DIR}/${path}`],
        { timeoutMs: ARTIFACT_EXEC_TIMEOUT_MS },
      )
      if (read.exitCode !== 0) {
        logger.warn(
          { conversationId, containerId, path, exitCode: read.exitCode, stderr: read.stderr.toString('utf8').slice(0, 300) },
          '产物读出失败，已跳过该文件',
        )
        continue
      }
      const bytes = read.stdout
      if (bytes.length !== stat.size) {
        logger.warn(
          { conversationId, path, findSize: stat.size, actualSize: bytes.length },
          '产物大小在读出前后不一致（文件在扫描与读取之间被改动），按实际读到的字节继续',
        )
      }
      if (bytes.length > maxFileBytes) {
        logger.warn(
          { conversationId, path, sizeMb: Math.round(bytes.length / (1024 * 1024)) },
          '产物实际读出的字节超过单文件上限，已跳过',
        )
        continue
      }

      const mime = artifactMimeOf(path)
      const fileKey = `${ARTIFACT_KEY_PREFIX}/${conversationId}/${randomUUID()}/${safeKeySegment(path)}`
      await ensureBucket(bucket)
      // ⚠️ 对象的 ContentType 刻意不写 mime：产物响应头的唯一来源是 `artifacts.mime`
      // （子方案④ §四），S3 元数据写一份就多一个分叉点
      await getS3Client().putObject(bucket, fileKey, bytes, bytes.length, {
        'Content-Type': 'application/octet-stream',
      })

      const createdAt = new Date()
      try {
        const row = await getPrisma().artifact.create({
          data: {
            conversationId,
            // 归属用户（删除会话后"我的会话产物"的唯一判据，见 schema.prisma#Artifact.userId）
            userId: owner.userId,
            fileKey,
            fileName: path,
            size: bytes.length,
            mime,
            // ⚠️ 由 JS 侧显式写入（PG 会话时区非 UTC 时 @default(now()) 会偏一个时区，
            // 而保留期清理正是 JS 侧边界比较 —— 见 schema.prisma 该列的注释）
            createdAt,
          },
          select: { id: true, fileName: true, size: true, mime: true },
        })
        items.push({ artifactId: row.id, fileName: row.fileName, size: row.size, mime: row.mime })
      } catch (rowError) {
        // 补偿：刚传上去的对象没有行认领了 ⇒ 删掉（删不掉也只 warn，与 document.service 同款）
        try {
          await getS3Client().removeObject(bucket, fileKey)
        } catch (removeError) {
          logger.error({ err: removeError, bucket, fileKey }, '产物行创建失败后的对象补偿删除也失败了（将成孤儿，保留期清理器不会认识它）')
        }
        logger.warn({ err: rowError, conversationId, path }, '产物行创建失败，已跳过该文件（对象已补偿删除）')
      }
    } catch (error) {
      logger.warn({ err: error, conversationId, containerId, path }, '产物收集单文件失败，已跳过（其余文件继续）')
    }
  }

  if (items.length > 0) {
    logger.info(
      { conversationId, containerId, collected: items.length, changed: changed.length },
      '本轮产物收集完成',
    )
  }
  return items
}

/**
 * 保留期清理（§十一 4，挂在对账器同一轮里跑）：`created_at` 早于
 * `ARTIFACT_RETENTION_DAYS` 的产物，**对象与行一起删**。
 *
 * ⚠️ 这是产物唯一的过期收口（会话被删 / Agent 被软删 ⇒ 产物**不跟着删**，
 * 到期由这里统一收 —— "只涨不跌的口子"就是靠这个函数关上的）。
 *
 * @returns 删掉的行数（= 对象数；删失败的留到下一轮）
 */
export async function reapExpiredArtifacts(): Promise<number> {
  const logger = getLogger()
  const retentionDays = config.limits.artifactRetentionDays
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const prisma = getPrisma()

  const stale = await prisma.artifact.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, fileKey: true },
    take: 500,
  })
  if (stale.length === 0) return 0

  const bucket = config.s3.bucket
  let removed = 0
  for (const row of stale) {
    try {
      await getS3Client().removeObject(bucket, row.fileKey)
    } catch (error) {
      // 对象删不掉**就不删行**：行是下载的唯一入口，先删行会留下"对象还在、谁也找不到"的暗账；
      // S3 对"不存在的键"并不总是抛错，真正的故障（网络/权限）下一轮还会再遇到
      logger.warn({ err: error, bucket, fileKey: row.fileKey }, '保留期清理：删产物对象失败（行保留，下一轮再试）')
      continue
    }
    try {
      await prisma.artifact.delete({ where: { id: row.id } })
      removed += 1
    } catch (error) {
      logger.warn({ err: error, artifactId: row.id }, '保留期清理：对象已删但行删除失败（行将成为“对象已不在”的 404，由下载端点兜底）')
    }
  }
  logger.info({ candidates: stale.length, removed, retentionDays }, '产物保留期清理完成')
  return removed
}
