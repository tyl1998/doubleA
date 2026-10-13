/**
 * 产物收集（P0-3-7 建；P1-9 · R4 把判据换成「产物 = 工作区变更集视图」）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §十一（产物收集与交付，全文）+ §九 1（"产物立刻出容器"）、
 *      `docs/子方案/Code模式工作区.md` §五 6 / §十三 已决 6（**产物 = 工作区变更集视图**）+
 *      §七 5（轮末变更集）、`docs/02-后端设计.md` §三（`artifacts` 表）/ §5.2（"done 时整条落库"）。
 *
 * ```
 * 编排层（taskAgent.ts）在本轮的两端各调一次工作区/产物：
 *   派活之前    reconcileWorkspaceOnce() + recordWorkspaceRoundStart()  → 对账 setup 写 + 记窗口起点
 *   agent_settled reconcileWorkspaceOnce() + collectRoundArtifacts()    → 取本轮变更集 → 过滤 → 传对象 → 建行
 * 保留期        reapExpiredArtifacts()                                 → 周期清理（挂在对账器同一轮里，§十一 4）
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据一（P1-9 · R4）：产物 = **本轮工作区变更集**，不再是容器快照 diff
 * ═══════════════════════════════════════════════════════════════════════
 * P0-3-7 的原始口径是"派活前拍 `/work` 快照（size+mtime）、收尾对照取本轮新出现/修改的"。R4 把判据
 * 换成**工作区变更集**（`workspace_events` 在轮次窗口内按路径折叠，`shared#foldWorkspaceEvents`，见
 * `artifactChanges.ts`）—— 单一真相是工作区（§二），产物只是它的**交付视图**：
 *   · `git clone` 等初始填充 / 依赖安装若发生在轮次窗口**之前**（setup 步），天然不算产物；
 *   · 窗口**之后**人再改的也不进本轮产物（窗口 = `[轮次起点, now]`，同「撤销本轮」的时间口径）；
 *   · `.git`、记忆文档（`.doubulea/`）由"隐藏路径"规则排除，`node_modules` 由显式名单排除。
 * ⚠️ 时效性由编排层在收产物前 `reconcileWorkspaceOnce` 保证：`bash` / 原生工具的**未中介写**必须先
 *    进工作区索引与事件（`workspace/watcher.ts`），否则这一轮它看不到。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 判据二：过滤规则**全部要留痕**（§十一 2 —— "都要有日志，不静默丢"）
 * ═══════════════════════════════════════════════════════════════════════
 * 过滤逻辑（隐藏 / 显式名单 / 截断）在 `artifactChanges.ts#filterArtifactPaths`（纯函数，可单测）；
 * 单文件超过 `ARTIFACT_MAX_FILE_MB` ⇒ 跳过 + **warn**（在按实际读到的字节判，一处判据）。
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
 *     「会话产物」页主动删除）；文件与行的**过期收口只有保留期清理器**。
 *   · **收集失败 ≠ 这一轮失败**：编排层对本模块的一切异常都 catch + warn 后继续收尾
 *     （产物是本轮的**赠品**，不是交付物本体；正文已经流出去了）。
 */

import { randomUUID } from 'node:crypto'

import { type ArtifactItem, type WorkspaceChangeEntry } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureBucket, getS3Client } from '../infra/s3.js'
import { resolveWorkspacePath } from '../workspace/paths.js'
import { ensureWorkspace } from '../workspace/service.js'
import { readWorkspaceBytes, workspaceFileSize } from '../workspace/store.js'
import { ARTIFACT_EXCLUDED_DIRS, artifactChangePaths } from './artifactChanges.js'

/**
 * 一个产物文件在对象存储里的键前缀（与 `kb/` 平级的命名空间 —— 两类对象永不混淆）。
 */
const ARTIFACT_KEY_PREFIX = 'artifacts'

/**
 * 单条 `docker exec` 的时限（代码常量，不进 env —— 与 `map.ts` 两个数值常量同款取舍：
 * 它不是"行为窗口"，改它不改变契约）。
 *
 * ⚠️ 产物收集自 P1-9 · R4 起改走**宿主工作区 FS**、不再用它；保留导出是因为
 * `memoryDoc.ts` / `attachmentFiles.ts` 写容器（记忆文档 / 附件）时复用它作 exec 超时。
 */
export const ARTIFACT_EXEC_TIMEOUT_MS = 60_000

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
 * 收一轮产物：**本轮工作区变更集 → 过滤 → 逐个「读字节 → 传对象 → 建行」**（P1-9 · R4）。
 *
 * **尽力而为**：单个文件失败只 warn 并跳过（继续传其余），整体抛错由调用方决定是否吞掉
 * （编排层会吞）。**建行成功之前不对外可见** —— `artifact` 事件由编排层拿着返回值发，
 * 顺序天然满足"先传对象、再建行、最后发事件"。
 *
 * 字节来源 = **工作区宿主 FS**（`WORKSPACE_ROOT/{conversationId}`，即 bind 进容器 `/work` 的那份
 * canonical 字节）—— 不再走 `docker exec` 扫容器：单一真相是工作区，容器只是它的一次性运行时。
 *
 * @param changes 本轮工作区变更集（`listWorkspaceChanges(conversationId, 轮次起点)` 的 `items`；
 *                内容事件之外的（`claim`/`release`）与 `deleted` 由本模块筛掉）
 * @returns 建好的行（形状 = `shared#artifactItemSchema`，可直接当 `artifact` 事件 payload
 *          与消息 `content.artifacts` 段用）
 */
export async function collectRoundArtifacts(input: {
  conversationId: string
  changes: readonly WorkspaceChangeEntry[]
}): Promise<ArtifactItem[]> {
  const { conversationId, changes } = input
  const logger = getLogger()

  // 建行要写 `user_id`（`TaskAgent记忆与产物` 块 3：删除会话后产物行靠它归回给用户）。
  // 从会话行查一次（不信任任何传入值 —— 归属**只能**来自会话的 owner 列）。
  // ⚠️ 查不到 = 会话已经被删：产物无处归属，这一轮**整轮跳过**。
  const owner = await getPrisma().conversation.findFirst({
    where: { id: conversationId },
    select: { userId: true },
  })
  if (owner === null) {
    logger.warn({ conversationId }, '产物收集时会话已不存在，本轮产物跳过（无法确定归属用户）')
    return []
  }

  const changed = artifactChangePaths(changes, {
    excludedDirs: ARTIFACT_EXCLUDED_DIRS,
    maxFiles: config.limits.artifactScanMaxFiles,
    onTruncate: (accepted, kept, maxFiles) => {
      logger.warn(
        { conversationId, changed: accepted, kept, maxFiles },
        '产物扫描：本轮变更的工作区文件数超过单轮上限，已截断（防引擎写一万个小文件打爆上传；其余文件留待下轮对账）',
      )
    },
  })
  if (changed.length === 0) return []

  // 工作区根（宿主 canonical 目录；`ensureWorkspace` 幂等，顺带带上冷备恢复）
  const handle = await ensureWorkspace(conversationId)
  const bucket = config.s3.bucket
  const maxFileBytes = config.limits.artifactMaxFileMb * 1024 * 1024
  const items: ArtifactItem[] = []

  for (const path of changed) {
    try {
      const { absolute } = resolveWorkspacePath(handle.rootPath, path)
      // ⓪ 大小上限放行前判一次（先 `stat`，避免把超大文件整个读进内存）
      const size = await workspaceFileSize(absolute)
      if (size === undefined) {
        logger.warn({ conversationId, path }, '产物收集时工作区文件已不在盘上（本轮内被删/改名），已跳过')
        continue
      }
      if (size > maxFileBytes) {
        logger.warn(
          { conversationId, path, sizeMb: Math.round(size / (1024 * 1024)) },
          '产物超过单文件上限，已跳过（文件仍在工作区里，只是不收进产物面板）',
        )
        continue
      }

      const bytes = await readWorkspaceBytes(absolute)
      if (bytes.length !== size) {
        logger.warn(
          { conversationId, path, statSize: size, actualSize: bytes.length },
          '产物大小在统计与读出之间不一致（文件在两步之间被改动），按实际读到的字节继续',
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
      logger.warn({ err: error, conversationId, path }, '产物收集单文件失败，已跳过（其余文件继续）')
    }
  }

  if (items.length > 0) {
    logger.info(
      { conversationId, collected: items.length, changed: changed.length },
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
