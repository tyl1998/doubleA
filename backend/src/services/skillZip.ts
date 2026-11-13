/**
 * Skill 导入：zip 解包与校验（P1-24a-1；`docs/子方案/Skill能力.md` §2.2 / §6.1 / §5.1）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么新写一个，而不是复用 `xlsxPreview.ts#readZipEntries`
 * ─────────────────────────────────────────────────────────────────────
 * 那个只读**中央目录的名字与数据**，**不读 external attributes** ⇒ 判不出"这条是符号链接"。
 * 而 Skill 是会被**执行**的资产（`scripts/**` 在 TaskAgent 容器里由 `bash` 跑），
 * 一条 `references → /etc` 的符号链接在解包时被"原样落盘"就等价于把宿主目录带进容器。
 * 本模块因此单独实现：中央目录 + external attributes + 大小/条数/深度/压缩比四道闸。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 六条拒绝理由（全部在**落盘之前**判，失败不留半成品）
 * ─────────────────────────────────────────────────────────────────────
 *   ① 路径穿越：绝对路径 / `..` / `.` 段 / 盘符 / 反斜杠 / NUL（`shared#isSafeSkillPath`）；
 *   ② 符号链接 / 硬链接（external attributes 的高 16 位是 Unix mode，`S_IFLNK = 0xA000`）；
 *   ③ 文件数 / 单文件 / 总字节 / 路径深度超限；
 *   ④ 压缩比异常（zip bomb）；
 *   ⑤ 缺 `SKILL.md`、frontmatter 解析失败、`description` 缺失或超长、`slug` 为空；
 *   ⑥ `runtime` / `requires.scripts` / `scripts/**` 三者不一致（`shared#checkSkillRuntimeConsistency`）。
 *
 * 任一条不满足 ⇒ 抛 `VALIDATION` 400 + `data.code = SKILL_IMPORT_INVALID` + `data.reasons[]`
 * （**逐条**列出原因，而不是只回第一条：用户一次改一处的来回成本太高）。
 *
 * ⚠️ 本模块**只解包与校验，不写 S3、不写 DB**：落库顺序（先把对象写全 → 再在事务里切版本）
 * 属 a-2 的导入服务，那里要在 S3 成功后失败时按前缀回收孤儿对象（`子方案` §3.2）。
 */

import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

import {
  appMsg,
  AppError,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  SKILL_RUNTIMES,
  SKILL_DESCRIPTION_MAX_CHARS,
  checkSkillRuntimeConsistency,
  isSafeSkillPath,
  skillDescriptionWithinLimit,
  type SkillRuntime,
} from '@doubulea/shared'

import { config } from '../config.js'

/** 一条解包后的文件（**路径已归一化**：`/` 分隔、无前导 `./`） */
export interface SkillZipEntry {
  /** Skill 内相对路径（见 {@link isSafeSkillPath}） */
  path: string
  /** 文件字节 */
  bytes: Buffer
  /** 小写扩展名（无则空串） */
  ext: string
  mime: string
  sha256: string
}

/** frontmatter 里与 DB 字段对应、且**参与一致性校验**的那几个键 */
export interface SkillFrontmatter {
  name?: string
  description?: string
  requires: {
    runtime?: string
    scripts?: boolean
    bins?: string[]
  }
  /** 原始解析结果（`skill.manifest` 存它，便于将来扩展） */
  raw: Record<string, unknown>
}

/** 一个**通过全部校验**的 Skill 包（还不含 slug / 名称判重 —— 那要看 DB） */
export interface ParsedSkillZip {
  frontmatter: SkillFrontmatter
  runtime: SkillRuntime
  requiresBins: string[]
  files: SkillZipEntry[]
  /** `SKILL.md` 的文本（frontmatter 已解析；正文原样） */
  entryMarkdown: string
  /** `SKILL.md` 的正文长度（码点；a-2 写库前的"太长了"提示可用） */
  totalBytes: number
}

// ───────────────────────────── zip 结构 ─────────────────────────────

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Unix mode 的高 16 位（external attributes）；`S_IFMT` / `S_IFLNK` 是 Linux `stat.h` 的定义 */
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

/** `.zip` 的 32 位上限与"需要 ZIP64"的哨兵值 */
const ZIP32_MAX = 0xffff
const UINT32_MAX = 0xffffffff

interface CentralEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttributes: number
  /** Unix mode（external attributes 高 16 位）；DOS 打出来的包是 0 */
  unixMode: number
  isDirectory: boolean
}

/** 读 CD 的一条：只解析元数据（真正的数据在 local header 之后，按 `localOffset` 取） */
function readCentralDirectory(buffer: Buffer): CentralEntry[] {
  let eocd = -1
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) {
    throw importError(['不是有效的 zip：找不到中央目录结束记录（EOCD）'])
  }
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === ZIP32_MAX || centralOffset === UINT32_MAX || centralSize === UINT32_MAX) {
    throw importError(['不支持 ZIP64 格式的 Skill 包（单包文件数或体积超过 4GB/65535 个）'])
  }
  if (centralOffset + centralSize > buffer.length) {
    throw importError(['zip 中央目录越界（文件被截断或结构损坏）'])
  }

  const entries: CentralEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw importError(['zip 中央目录损坏（第 ' + String(index + 1) + ' 条记录读不出来）'])
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const rawName = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen

    // 高 8 位是"生成平台"：3 = Unix ⇒ external attributes 的高 16 位才是 Unix mode
    const hostPlatform = versionMadeBy >> 8
    const unixMode = hostPlatform === 3 ? (externalAttributes >>> 16) & 0xffff : 0
    const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\')

    entries.push({
      name: rawName,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      externalAttributes,
      unixMode,
      isDirectory,
    })
  }
  return entries
}

/** 取一条条目解压后的字节（`method` 0 = stored、8 = deflate；其它一律拒绝） */
function readEntryData(buffer: Buffer, entry: CentralEntry): Buffer {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIG) {
    throw importError([`zip 本地头损坏：${entry.name}`])
  }
  const localNameLen = buffer.readUInt16LE(entry.localOffset + 26)
  const localExtraLen = buffer.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) {
    throw importError([`zip 条目数据越界：${entry.name}`])
  }
  const raw = buffer.subarray(dataStart, dataEnd)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) {
    // `maxOutputLength` 让 zlib 自己兜"声明 1KB 实际炸 500MB"的那种条目
    try {
      return inflateRawSync(raw, { maxOutputLength: Math.max(entry.uncompressedSize, 1) + 1024 })
    } catch {
      throw importError([`zip 条目解压失败（压缩流损坏或声明大小与实际不符）：${entry.name}`])
    }
  }
  throw importError([`不支持的 zip 压缩方式（method=${String(entry.method)}）：${entry.name}`])
}

/** 路径归一化：去掉 `./` 前缀与多余斜杠；**不做 URL 解码**（多一次解码只会引入新的绕过面） */
function normalizeZipPath(raw: string): string {
  return raw.replace(/^\.\//u, '').replace(/\/{2,}/gu, '/')
}

/** 路径深度（`a/b/c` = 3；`SKILL.md` = 1） */
function depthOf(path: string): number {
  return path.split('/').length
}

/** 扩展名（小写、不含点；无扩展名 / 以点开头的隐藏文件 → 空串） */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * 扩展名 → mime（**只认 Skill 里会出现的那些**；未知扩展名落 `application/octet-stream`）。
 *
 * ⚠️ 刻意不引 `mime-types`：Skill 包里 99% 是 md / json / py / sh / csv / xlsx 这几类，
 * 多一个依赖只为了一张 20 行的表不值得。二进制一律按 `application/octet-stream` 走下载，
 * 不参与 `read_skill_file` 的文本返回（`子方案` §5.1："文本预览只返回允许的 MIME"）。
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  sql: 'application/sql',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  toml: 'application/toml',
  ini: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  zip: 'application/zip',
}

function mimeOf(path: string): string {
  return MIME_BY_EXT[extensionOf(path)] ?? 'application/octet-stream'
}

// ───────────────────────────── frontmatter ─────────────────────────────

/** 极简 YAML 子集解析：只认 Skill frontmatter 实际会用的 `key: value` 与一层 `嵌套:`（`requires`） */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let currentMap: Record<string, unknown> | null = null
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue
    const indented = /^\s+/u.test(rawLine)
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const valueText = line.slice(colon + 1).trim()
    if (indented && currentMap !== null) {
      currentMap[key] = parseScalar(valueText)
      continue
    }
    if (valueText === '') {
      const nested: Record<string, unknown> = {}
      out[key] = nested
      currentMap = nested
      continue
    }
    out[key] = parseScalar(valueText)
    currentMap = null
  }
  return out
}

/** 标量：去引号 / `[a, b]` 列表 / `true` / `false` */
function parseScalar(text: string): unknown {
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item !== '')
  }
  if (text === 'true') return true
  if (text === 'false') return false
  return stripQuotes(text)
}

function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

interface ParsedMarkdown {
  frontmatter: SkillFrontmatter
  body: string
}

/**
 * 拆 `SKILL.md`：`---` frontmatter + 正文。
 *
 * 失败（没有 frontmatter / 不是对象 / `description` 缺失）一律抛 `SKILL_IMPORT_INVALID`：
 * `description` 是**模型选择 Skill 的唯一依据**（`子方案` §2.2），缺了它这个 Skill
 * 在目录里就是一行没有用途说明的 slug —— 与其入库后让用户自己发现，不如导入时就说清楚。
 */
function parseSkillMarkdown(markdown: string): ParsedMarkdown {
  const normalized = markdown.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---')) {
    throw importError([`${SKILL_ENTRY_PATH} 缺少 YAML frontmatter（文件必须以 "---" 开头）`])
  }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) {
    throw importError([`${SKILL_ENTRY_PATH} 的 frontmatter 没有结束标记 "---"`])
  }
  const headerText = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\r?\n/u, '')
  const raw = parseSimpleYaml(headerText)
  const requiresRaw = raw.requires
  const requires =
    requiresRaw !== null && typeof requiresRaw === 'object' && !Array.isArray(requiresRaw)
      ? (requiresRaw as Record<string, unknown>)
      : {}

  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const reasons: string[] = []
  if (description === '') reasons.push(`${SKILL_ENTRY_PATH} 的 frontmatter 缺少 description（写明什么时候用这个 Skill）`)
  if (description !== '' && !skillDescriptionWithinLimit(description)) {
    reasons.push(`description 超长（上限 ${String(SKILL_DESCRIPTION_MAX_CHARS)} 个字符），请精简后再导入`)
  }
  const runtimeRaw = typeof requires.runtime === 'string' ? requires.runtime.trim().toLowerCase() : ''
  const runtime = runtimeRaw === '' ? 'inline' : runtimeRaw
  if (runtime !== 'inline' && runtime !== 'sandbox') {
    reasons.push(`requires.runtime 只能是 inline / sandbox（收到 "${runtimeRaw}"）`)
  }
  if (reasons.length > 0) throw importError(reasons)

  const binsRaw = requires.bins
  const bins = Array.isArray(binsRaw)
    ? binsRaw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []

  return {
    frontmatter: {
      ...(typeof raw.name === 'string' && raw.name.trim() !== '' ? { name: raw.name.trim() } : {}),
      description,
      requires: {
        runtime,
        ...(requires.scripts === true ? { scripts: true } : {}),
        ...(bins.length > 0 ? { bins } : {}),
      },
      raw,
    },
    body,
  }
}

// ───────────────────────────── 错误出口 ─────────────────────────────

/**
 * 导入校验失败的**唯一出口**（`VALIDATION` 400 + `data.code=SKILL_IMPORT_INVALID` + `data.reasons[]`）。
 *
 * ⚠️ 不走 `AppError.data.code` 之外的新错误码：`ERROR_CODES` 是封闭枚举（见 `shared/src/skill.ts` 文件头 ③）。
 */
export function importError(reasons: string[]): AppError {
  // 逐条原因拼成一句人话（`data.reasons[]` 仍保留结构化清单，前端可逐条展示）
  return AppError.validation(appMsg('app.m289', { p0: reasons.join('；') }), {
    code: SKILL_ERROR_CODES.IMPORT_INVALID,
    reasons,
  })
}

// ───────────────────────────── 主入口 ─────────────────────────────

/**
 * 解包并校验一个 Skill zip。
 *
 * @param buffer zip 原始字节（`application/zip`；其它格式会在 EOCD 那一步报"不是有效的 zip"）
 * @param options.expectedRuntime 调用方**显式声明**的运行时（`POST /api/skills` 的表单字段）。
 *   给了就与 frontmatter 的 `requires.runtime` **必须一致**（不一致 ⇒ 拒绝，不静默以某一边为准：
 *   导入是"整包发布"，两边各说一套时很难判断用户到底要哪一种）。
 *
 * @throws {@link importError}（`VALIDATION` 400）任何一条校验不通过
 */
export function parseSkillZip(
  buffer: Buffer,
  options: { expectedRuntime?: SkillRuntime } = {},
): ParsedSkillZip {
  if (buffer.length === 0) throw importError(['Skill 包是空的（0 字节）'])

  const limits = config.skill
  const entries = readCentralDirectory(buffer)

  // ── ① 条数 / 深度 / 链接 ──
  const reasons: string[] = []
  const linkEntries = entries.filter((entry) => (entry.unixMode & S_IFMT) === S_IFLNK)
  for (const entry of linkEntries) reasons.push(`不允许符号链接：${entry.name}`)
  // Windows 打出来的包里"目录"不一定是 `dir/`，但 external attributes 的 `FILE_ATTRIBUTE_DIRECTORY`
  // (0x10) 会在低 16 位；两种判法并上，避免把一个目录当文件读
  const isDirEntry = (entry: CentralEntry): boolean => entry.isDirectory || (entry.externalAttributes & 0x10) !== 0
  const fileEntries = entries.filter((entry) => !isDirEntry(entry))
  if (fileEntries.length > limits.maxFiles) {
    reasons.push(`文件数超限：${String(fileEntries.length)} 个（上限 ${String(limits.maxFiles)}）`)
  }

  const parsed: SkillZipEntry[] = []
  let totalBytes = 0
  for (const entry of fileEntries) {
    const path = normalizeZipPath(entry.name.replace(/\\/gu, '/'))
    if (!isSafeSkillPath(path)) {
      reasons.push(`不允许的路径（绝对路径 / .. / 盘符 / 反斜杠 / 空段）：${entry.name}`)
      continue
    }
    if (depthOf(path) > limits.maxPathDepth) {
      reasons.push(`路径层级超限（上限 ${String(limits.maxPathDepth)} 层）：${path}`)
      continue
    }
    // 只放"普通文件"：`unixMode` 非 0 且不是 REG 的（FIFO / socket / device）一律拒绝。
    // ⚠️ 不保留可执行位：脚本统一由解释器执行（`bash script.sh` / `python3 script.py`），
    //    权限位在容器里由策略决定（`子方案` §6.1）。
    if (entry.unixMode !== 0 && (entry.unixMode & S_IFMT) !== S_IFREG) {
      reasons.push(`不支持的特殊文件类型（只接受普通文件）：${path}`)
      continue
    }
    if (entry.uncompressedSize > limits.maxFileBytes) {
      reasons.push(`单文件超限：${path}（${String(entry.uncompressedSize)} 字节，上限 ${String(limits.maxFileBytes)}）`)
      continue
    }
    const bytes = readEntryData(buffer, entry)
    if (bytes.length > limits.maxFileBytes) {
      reasons.push(`单文件超限：${path}（实际 ${String(bytes.length)} 字节，上限 ${String(limits.maxFileBytes)}）`)
      continue
    }
    totalBytes += bytes.length
    if (totalBytes > limits.maxTotalBytes) {
      reasons.push(`解压后总体积超限（上限 ${String(limits.maxTotalBytes)} 字节）`)
      break
    }
    parsed.push({
      path,
      bytes,
      ext: extensionOf(path),
      mime: mimeOf(path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }

  // ── ② zip bomb：压缩比 ──
  if (totalBytes > 0 && buffer.length > 0) {
    const ratio = totalBytes / buffer.length
    if (ratio > limits.maxCompressionRatio) {
      reasons.push(
        `压缩比异常（${ratio.toFixed(0)} 倍，上限 ${String(limits.maxCompressionRatio)} 倍）—— 疑似 zip bomb，已拒绝`,
      )
    }
  }

  // ── ③ 重名（大小写敏感；同一路径出现两次会让 `@@unique([skillId, version, path])` 落库炸 500）──
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (seen.has(entry.path)) {
      reasons.push(`包里有两个同名文件：${entry.path}`)
      continue
    }
    seen.add(entry.path)
  }

  // ── ④ `SKILL.md` 必须在根上 ──
  const entry = parsed.find((item) => item.path === SKILL_ENTRY_PATH)
  if (entry === undefined) {
    reasons.push(`缺少 ${SKILL_ENTRY_PATH}（必须放在包根目录）`)
  }
  if (reasons.length > 0 || entry === undefined) throw importError(reasons)

  // ── ⑤ frontmatter（含 description 校验）──
  const markdown = entry.bytes.toString('utf8')
  const { frontmatter } = parseSkillMarkdown(markdown)

  // ── ⑥ runtime 一致性（DB 字段是真相源，但导入时两边必须说同一件事）──
  const rawRuntime = frontmatter.requires.runtime
  const runtime = (rawRuntime === 'sandbox' ? 'SANDBOX' : 'INLINE') as SkillRuntime
  if (options.expectedRuntime !== undefined && options.expectedRuntime !== runtime) {
    throw importError([
      `请求声明的运行时（${options.expectedRuntime}）与 ${SKILL_ENTRY_PATH} 里的 requires.runtime（${SKILL_RUNTIMES[runtime === 'SANDBOX' ? 1 : 0].toLowerCase()}）不一致`,
    ])
  }
  const consistency = checkSkillRuntimeConsistency({
    runtime,
    requiresScripts: frontmatter.requires.scripts === true,
    paths: parsed.map((item) => item.path),
  })
  if (consistency.length > 0) throw importError(consistency)

  return {
    frontmatter,
    runtime,
    requiresBins: frontmatter.requires.bins ?? [],
    files: parsed,
    entryMarkdown: markdown,
    totalBytes,
  }
}

/**
 * 把 `frontmatter` + DB 字段重新拼成 `SKILL.md`（**frontmatter 由服务端生成**）。
 *
 * DB 字段是真相源（`子方案` §2.2 最后一条）：用户改名 / 改描述后，模型读到的必须是最新值，
 * 而不是包里那份过期的 frontmatter。正文原样保留。
 *
 * a-1 只提供这个**纯函数**（导入服务在 a-2 用它；c 批的草稿保存也用它），本批不调用。
 */
/**
 * `SKILL.md` 的正文（去掉 frontmatter 块）。
 *
 * 三处消费同一份（`06` §六 ⑰「同一口径只留一处」）：导入时重生成 frontmatter 前的“正文”、
 * 管理面单文件预览（a-2），以及 ChatBot 的 `load_skill`（a-3 —— 模型读到的必须是**同一份**重生成结果）。
 * 没有 frontmatter 时原样返回（不抛：本函数只切块，不负责校验）。
 */
export function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(markdown)
  return match === null ? markdown : markdown.slice(match[0].length)
}

export function composeSkillMarkdown(input: {
  name: string
  description: string
  runtime: SkillRuntime
  requiresScripts: boolean
  requiresBins: readonly string[]
  body: string
  /**
   * 包里 frontmatter 的**其余键**（P1-24a-2）：`license` / `version` / 自定义字段等。
   *
   * ⚠️ 只重生成**本函数拥有的四个键**（`name` / `description` / `requires.runtime` /
   * `requires.scripts` / `requires.bins`），其余键**原样保留** —— 否则一次"改名"
   * 就会把用户写在 `SKILL.md` 里的 `license`、`allowed-tools` 之类悄悄抹掉，
   * 而症状是"重新导入后 Skill 行为变了"，极难归因。
   */
  extra?: Readonly<Record<string, unknown>>
}): string {
  const lines = ['---', `name: ${yamlScalar(input.name)}`, `description: ${yamlScalar(input.description)}`]
  // 其余顶层键（顺序按原包；只做标量 / 一行数组的简单渲染）
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (key === 'name' || key === 'description' || key === 'requires') continue
    const rendered = yamlValue(value)
    if (rendered !== null) lines.push(`${key}: ${rendered}`)
  }
  lines.push('requires:')
  lines.push(`  runtime: ${input.runtime === 'SANDBOX' ? 'sandbox' : 'inline'}`)
  if (input.requiresScripts) lines.push('  scripts: true')
  if (input.requiresBins.length > 0) {
    lines.push(`  bins: [${input.requiresBins.map((bin) => yamlScalar(bin)).join(', ')}]`)
  }
  lines.push('---', '', input.body)
  return lines.join('\n')
}

/**
 * 任意 JSON 值 → YAML 行内表示；**认不出的形状返回 `null`**（调用方跳过该键）。
 *
 * 刻意只覆盖"容易写对"的几种：字符串 / 数字 / 布尔 / 字符串数组。
 * 嵌套对象原样 `JSON.stringify`（YAML 是 JSON 的超集，流式写法合法）。
 */
function yamlValue(value: unknown): string | null {
  if (typeof value === 'string') return yamlScalar(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return `[${(value as string[]).map((item) => yamlScalar(item)).join(', ')}]`
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return null
}

/** YAML 标量：含特殊字符时用双引号包起来（够用即可；不做完整 YAML 转义） */
function yamlScalar(text: string): string {
  if (/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .\-/()（）]*$/u.test(text)) return text
  return JSON.stringify(text)
}
