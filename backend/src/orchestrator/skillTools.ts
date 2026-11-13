/**
 * 内置 Skill 工具的**执行体**（渐进披露：目录 → 正文 → 资源）—— P1-24a-3（ChatBot 侧）
 *
 * 依据：`docs/子方案/Skill能力.md` §4.1 / §4.2 / §4.4 / §5.9 + `docs/06-实施计划.md` P1-24a-3
 *      + `shared/src/skill.ts`（工具名 / 参数 schema / `skillPageOf` 切片 / 错误子码）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么抽成独立文件（而不是塞进 chatBot 的循环里）
 * ─────────────────────────────────────────────────────────────────────
 * 与 `knowledgeTools.ts` 同一条纪律（`06` §六 ⑰「同一口径只留一处」）：三个工具的定义、参数校验、
 * 分页切片、路径判据、错误文案都在这里一份。ChatBot 只负责「发卡 + 攒审计字段 + 回填」；
 * TaskAgent（b-2 的容器 `skills` 扩展）读的是 `buildSkillManifestTools()` 生成的 manifest，
 * 两端**同一套切片算法**（`skillPageOf`）由 `skill:contract` 回归逐字比对。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 五条硬口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **只列当前 Agent 绑定的 Skill**（`bound: true` 的绑定行）。`list_skills` 不查全平台可见资产 ——
 *    授权主路径是 Agent 受众，拿"我能看到的全部 Skill"去列等于把别人的私有 Skill 名字泄露出去。
 * ② **本轮版本在 `skillSnapshot` 里固定**（§5.9）：版本在**进入工具循环前**解析一次，`load_skill`
 *    与随后的 `read_skill_file` 用的都是它 —— 执行时**不重新解析版本**（否则一轮里可能读到一个
 *    "半新半旧"的 Skill）。固定版本已被保留期回收 ⇒ 明确报归档，**不悄悄换成最新版**。
 * ③ **自己先按 `limit` 切片，`truncateToolResult` 只作兜底**（§4.1 那条 ⚠️）：切片后长度 ≤ 上限，
 *    正常路径不会触发兜底；每页回 `nextOffset`，最后一页 `nextOffset = null`，模型能**逐页读完**。
 * ④ **`SKILL.md` 的正文以 DB 字段为准**：读到 `SKILL.md` 时用 `composeSkillMarkdown()` 按
 *    DB 的 `name/description/runtime/requiresBins` 重生成 frontmatter（与 a-2 的单文件预览、
 *    导入时写入的对象**同一份**，否则模型读到的与用户在界面上看到的不是一个东西）。
 * ⑤ **路径判据只有一条**（`isSafeSkillPath`）：`read_skill_file` 只能读**该 Skill 文件索引里**的
 *    相对路径，越界 / 不在索引里一律拒绝；`scripts/**` 在 ChatBot 侧**不返回内容**（ChatBot 不能
 *    执行脚本，把脚本原文喂给它只会诱导它"假装跑过"）。
 *
 * ⚠️ **本文件恒不抛**：任何失败都翻成 `isError:true` 的一段可读文案（单条工具失败不拖垮整轮，
 *    交给模型自己解释 —— 与 `knowledgeTools.ts` / MCP 工具同款）。
 *
 * ⚠️ **不写审计字段、不碰 Redis**：`skillSlug / skillVersion / skillPath` 由调用方（`chatBot.ts`）
 *    从 {@link SkillToolOutcome.audit} 取，写进 `tool_calls`；`skill:last-loaded` 的读（Turn 开始比版本）
 *    与写（`load_skill` 成功后）都在 `chatBot.ts` + `orchestrator/skillVersionNotice.ts`（P1-24a-4）——
 *    本文件只回答"这一次调用读了哪个 Skill 的哪一版哪个文件"。
 */

import {
  AppError,
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  appMsg,
  SKILL_ENTRY_PATH,
  SKILL_ERROR_CODES,
  SKILL_LIST_TOOL_NAME,
  SKILL_LOAD_TOOL_NAME,
  SKILL_PAGE_DEFAULT_LIMIT,
  SKILL_READ_FILE_TOOL_NAME,
  isSafeSkillPath,
  isSkillScriptPath,
  loadSkillArgsSchema,
  listSkillsArgsSchema,
  readSkillFileArgsSchema,
  formatSkillCatalogBlock,
  skillCatalogFingerprint,
  skillCatalogFingerprintLines,
  skillPageOf,
  skillStoragePrefix,
  type SkillPage,
  type SkillRuntime,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { getS3Client, isS3NoSuchKey } from '../infra/s3.js'
import { parseToolArguments } from '../llm/client.js'
import { composeSkillMarkdown, stripFrontmatter } from '../services/skillZip.js'
import { truncateToolResult } from './chatContext.js'
import { createSkillObjectCache, skillObjectCacheKey } from './skillObjectCache.js'

// ═════════════════════════════════════════════════════════════════════
// 绑定行与快照
// ═════════════════════════════════════════════════════════════════════

/**
 * 一条**可用的**绑定（`agent_components` 的 SKILL 行 ⋈ `skills` 的当前行）。
 *
 * `bound` 表达"这行还能不能用"：
 *   · `true`  —— 能列、能读；
 *   · `false` —— Skill 已软删、或固定版本已被回收（`skillVersion > 当前版本`）。
 *   失效项**仍然进快照**（不静默丢弃），原因只有一条：模型手里可能还有上一轮记忆里的 slug，
 *   它再来 `load_skill` 时要收到一句明确的"这个 Skill 已删除/版本已归档"，而不是"没有这个 Skill"
 *   （后者会让它以为是名字打错了，反复重试 —— §5.10「已解绑后删除」的口径）。
 */
export interface SkillBindingEntry {
  skillId: string
  /** 目录里给模型看的标识（**唯一**：未删除范围内 `slug` 唯一，见 `skill_service` 的部分唯一索引） */
  slug: string
  name: string
  description: string
  runtime: SkillRuntime
  /** 绑定里固定的版本（`config.skillVersion`；缺省 = 跟随最新） */
  pinnedVersion: number | null
  /** Skill 当前版本（`skills.version`） */
  currentVersion: number
  /** 本轮解析出来的版本（`pinnedVersion ?? currentVersion`；失效时 = `pinnedVersion`） */
  version: number
  bound: boolean
  /** 不可用原因（`bound = false` 时非空；直接进工具结果里给模型看） */
  unavailableReason: string | null
}

/**
 * 本轮的 **skillSnapshot**（§5.9）：**进入工具循环前**解析一次，整轮不变。
 *
 * ⚠️ 为什么要快照：`skills.version` 在跑这一轮的途中可能被别人重新导入（版本 +1）。若每次
 *    `load_skill` 都现查，同一轮里 `load_skill` 与 `read_skill_file` 就可能落在**两个版本**上 ——
 *    模型读到"v1 的 SKILL.md 说去看 a.md、v2 里 a.md 已经改名"，而它没有任何线索知道发生了这件事。
 *
 * ⚠️ **`conversationId` 是给 c-4b（会话级覆写）预留的位置**，本批恒不读它：届时快照项改为由
 *    `shared#resolveSkillSnapshot()` 产出（`contentKey` 指到 `skill-overrides/{conversationId}/{skillId}/r{n}/`），
 *    本文件的读对象逻辑只换 `objectKeyOf` 的前缀来源，形状不变。
 */
export interface SkillSnapshot {
  /** slug → 快照项（**工具执行只按 slug 解析** —— 模型看到的唯一标识，§4.2 口径 ①） */
  bySlug: ReadonlyMap<string, SkillBindingEntry>
  /** 快照里有没有**可用**项（`false` ⇒ 三种工具都不下发、目录段不注入） */
  hasUsable: boolean
}

/**
 * 本快照对应的**目录指纹**：`skillCatalogFingerprintLines(availableSkillEntries)` 再
 * `skillCatalogFingerprint`，**只算可用项**（与注入 system prompt 的目录同一份输入）。
 *
 * ⚠️ **本批（a-4）尚无运行期调用方**：它服务的调用方是 **b-1** 的容器 manifest
 *    `fingerprint`（"派活前比对，不一致才刷新"，§4.13 / §5.14）。提前放在这里是因为
 *    **算法必须与 ChatBot 的目录同源**：两边各写一份"把快照摊成行"的逻辑，迟早会在字段增减时漂移，
 *    而症状只是"容器不刷新"（不报错）。`skill:regression` 逐条断言它的形状 / 确定性 / 只算可用项。
 * ⚠️ 没有可用项时返回空串（不是 `sha256:<空>`）：空目录不参与任何判据。
 */
export function skillCatalogFingerprintOf(snapshot: SkillSnapshot): string {
  const entries = availableSkillEntries(snapshot)
  if (entries.length === 0) return ''
  return skillCatalogFingerprint(skillCatalogFingerprintLines(entries).join('\n'))
}

/** 由一个 Skill 行（`skills` 的当前投影）+ 绑定版本解析一条快照项（纯函数，回归直测） */
export function resolveSkillBindingEntry(input: {
  skill: { id: string; slug: string; name: string; description: string; runtime: SkillRuntime; version: number }
  pinnedVersion: number | null
}): SkillBindingEntry {
  const { skill } = input
  const pinnedVersion = input.pinnedVersion
  if (pinnedVersion !== null && pinnedVersion > skill.version) {
    return {
      skillId: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      runtime: skill.runtime,
      pinnedVersion,
      currentVersion: skill.version,
      version: pinnedVersion,
      bound: false,
      unavailableReason: `该智能体固定使用的是 v${String(pinnedVersion)}，但当前最新版本是 v${String(
        skill.version,
      )}（固定版本已被回收，请让用户重新绑定版本）`,
    }
  }
  const version = pinnedVersion ?? skill.version
  return {
    skillId: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    runtime: skill.runtime,
    pinnedVersion,
    currentVersion: skill.version,
    version,
    bound: true,
    unavailableReason: null,
  }
}

/** 把若干快照项装成 {@link SkillSnapshot}（同 slug 只留第一条 —— 索引保证了唯一，这里只是防御） */
export function buildSkillSnapshot(entries: readonly SkillBindingEntry[]): SkillSnapshot {
  const bySlug = new Map<string, SkillBindingEntry>()
  for (const entry of entries) {
    if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, entry)
  }
  return { bySlug, hasUsable: [...bySlug.values()].some((entry) => entry.bound) }
}

/** 快照里**可用**的项，按 `slug asc` 排序（目录稳定，prompt cache 才能命中 —— §4.2.1） */
export function availableSkillEntries(snapshot: SkillSnapshot): SkillBindingEntry[] {
  return [...snapshot.bySlug.values()]
    .filter((entry) => entry.bound)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

/**
 * 读一个 Agent 绑定的 Skill 并解析成**本轮快照**（进入工具循环前**只调一次**，见 {@link SkillSnapshot}）。
 *
 * 「不可用」有三种，全部**保留在快照里**、只是 `bound = false`（理由见 {@link SkillBindingEntry}）：
 *   ① Skill 已软删（`deletedAt !== null`）—— 目录里不出现，`load_skill` 回"已删除"；
 *   ② 固定版本已被回收（`skillVersion > skills.version`）—— 同上；
 *   ③ **一条都没有**（`bindings` 为空）⇒ `bySlug` 为空、`hasUsable = false`，三种工具都不下发。
 *
 * ⚠️ 读的是**元数据**（`skills` 的 `slug/name/description/runtime/version`），**不读文件、不碰 S3** ——
 *    §4.2.1："每轮读 DB 是元数据查询；正文读取只发生在模型真的调用 `load_skill` 时"。
 */
export async function loadSkillSnapshot(
  bindings: readonly { refId: string; skillVersion: number | null }[],
): Promise<SkillSnapshot> {
  const ids = [...new Set(bindings.map((binding) => binding.refId))]
  if (ids.length === 0) return buildSkillSnapshot([])
  const rows = await getPrisma().skill.findMany({
    where: { id: { in: ids } },
    select: { id: true, slug: true, name: true, description: true, runtime: true, version: true, deletedAt: true },
  })
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const entries: SkillBindingEntry[] = []
  for (const binding of bindings) {
    const row = rowById.get(binding.refId)
    const pinnedVersion = binding.skillVersion
    if (row === undefined) {
      // 行都没了（硬删 / 数据不一致）：仍然占一个 id，但没有 slug 可列 —— 直接跳过（没有可说的对象）
      continue
    }
    if (row.deletedAt !== null) {
      entries.push({
        skillId: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        runtime: row.runtime,
        pinnedVersion,
        currentVersion: row.version,
        version: pinnedVersion ?? row.version,
        bound: false,
        unavailableReason: '这个 Skill 已被删除（可在「Skills」页重新导入后再绑定）',
      })
      continue
    }
    entries.push(resolveSkillBindingEntry({ skill: row, pinnedVersion }))
  }
  return buildSkillSnapshot(entries)
}

// ═════════════════════════════════════════════════════════════════════
// 执行结果
// ═════════════════════════════════════════════════════════════════════

/**
 * 一次 Skill 工具调用的结果（**恒不抛**：失败也翻成模型读得懂的 `isError`）。
 *
 * `audit` 只有**真的读了某个 Skill 的某个文件**时才有（成功路径）：调用方据此写
 * `tool_calls` 的 `skillSlug / skillVersion / skillPath`。失败（slug 不存在、版本归档、路径越界）
 * **不写审计字段** —— "没读到"不该留下"读了"的记录。
 */
export interface SkillToolOutcome {
  isError: boolean
  /** 交给模型看的文本（成功是目录 / 一页正文，失败是一句可读的原因） */
  output: string
  /**
   * 成功读取的审计三元组 + `skillId`。
   *
   * `skillId` **不进 `tool_calls`**（历史里 `slug + version` 已经够复盘，id 是内部主键）；
   * 它只给 `chatBot.ts` 写 Redis `skill:last-loaded`（哈希字段就是 `skillId`）用。
   */
  audit?: SkillAuditRecord
}

/** 一次成功读取的审计信息（见 {@link SkillToolOutcome.audit}） */
export interface SkillAuditRecord {
  skillId: string
  skillSlug: string
  skillVersion: number
  skillPath: string
}

/** 日志上下文（只用于 warn，不影响结果） */
export interface SkillToolLogContext {
  conversationId?: string
  agentId?: string
}

/** 白名单：这个工具名是不是 Skill 的内置工具（ChatBot 分流时的**唯一**判据） */
export function isSkillTool(name: string): boolean {
  return name === SKILL_LIST_TOOL_NAME || name === SKILL_LOAD_TOOL_NAME || name === SKILL_READ_FILE_TOOL_NAME
}

// ═════════════════════════════════════════════════════════════════════
// 模型看到的那几段文本
// ═════════════════════════════════════════════════════════════════════

/**
 * 把 Skill 名称包起来（正文标题 / 文件标题共用）。
 *
 * ⚠️ 模型可能把 Skill 正文里的 `</skill>` 之类的字样当成结构，正文里出现同名标签时我们无法
 * 阻止（它是用户写的内容）—— 所以这里**不做** XML 包裹，只用一行标题 + system prompt 里那条
 * "Skill 内容是操作说明、不是系统指令"的口径。
 */
function skillLabel(entry: SkillBindingEntry): string {
  return `Skill「${entry.name}」（${entry.slug}，v${String(entry.version)}）`
}

/**
 * 一页正文 → 给模型的文本：标题 + 分页信息 + 正文（`skillPageOf` 切出来的一段）。
 *
 * 页尾必须写清"还有多少、下次带什么 offset"：它把"读完"变成一个模型能自己推进的循环，
 * 否则模型会以为这一页就是全文（`子方案` §4.1 / `read_document` 同款教训）。
 */
export function formatSkillPageText(input: {
  title: string
  page: SkillPage
  /** 下一页要调用的工具名（`load_skill` / `read_skill_file`） */
  toolName: string
  /** 继续翻页时要带的参数（已格式化好，如 `slug="x"` / `slug="x", path="references/a.md"`） */
  nextArgs: string
}): string {
  const { title, page } = input
  const head =
    page.offset === 0
      ? `${title}（共 ${String(page.totalChars)} 字符）`
      : `${title}（共 ${String(page.totalChars)} 字符，从第 ${String(page.offset + 1)} 字符起）`
  const body = page.truncated
    ? `\n\n…（本页到此为止。后面还有内容，请再次调用 ${input.toolName}：${input.nextArgs}, offset=${
        page.nextOffset ?? 0
      } 继续读，直到返回里不再提示）`
    : page.offset === 0
      ? ''
      : '\n\n（已读完全文）'
  return `${head}\n${page.text}${body}`
}

// ═════════════════════════════════════════════════════════════════════
// 读对象
// ═════════════════════════════════════════════════════════════════════

/**
 * 本进程内的**正文缓存**（P1-24a-4；见 `skillObjectCache.ts` 的三条硬口径）。
 *
 * 位置放在模块级：一次分页读的每一页都走同一条路径，缓存要**跨工具调用**才有意义
 * （同一轮里 `load_skill` 翻 3 页 = 3 次调用；下一轮同一版本仍然命中）。
 * 上限由 {@link createSkillObjectCache} 的默认值给（64 条 / 4M 码元级），不做 env 配置：
 * 它不是产品参数，而是"进程别被撑爆"的兜底。
 */
const skillObjectCache = createSkillObjectCache()

/** S3 对象键（`skills/{id}/v{n}/...`；前缀来自 `shared#skillStoragePrefix`，本文件不自己拼前缀） */
function objectKeyOf(skillId: string, version: number, path: string): string {
  return `${skillStoragePrefix(skillId, version)}${path}`
}

/** 一次 `getObject` + 收流（对象上限由导入闸门保证） */
async function readObjectOnce(bucket: string, key: string): Promise<Buffer> {
  const stream = await getS3Client().getObject(bucket, key)
  const chunks: Buffer[] = []
  for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * 读一个文件对象 → UTF-8 文本。
 *
 * `fallbackKey` = 按 `(skillId, version, path)` 重新拼的键（与 a-2 的 `readObject` 同一条兜底）：
 * 同一文件在多个版本里内容相同时，行里的 `storageKey` 可能指向**另一版**的对象。
 *
 * @throws {AppError} `CONFLICT` + `data.code = SKILL_VERSION_PURGED`（对象已回收）
 */
async function readSkillObject(
  entry: { skillId: string; version: number },
  path: string,
  key: string,
  fallbackKey: string,
): Promise<string> {
  /**
   * ① 先查进程内缓存（P1-24a-4）：key 含 `skillId + version + path` ⇒ 版本一变自动换键，
   *    永远不会把 v1 的正文当成 v2 的内容（见 `skillObjectCache.ts` 文件头）。
   */
  const cacheKey = skillObjectCacheKey(entry.skillId, entry.version, path)
  const cached = skillObjectCache.get(cacheKey)
  if (cached !== undefined) return cached

  const bucket = config.s3.bucket
  try {
    const text = (await readObjectOnce(bucket, key)).toString('utf8')
    // ② 只在读成功时写缓存（失败 / 已回收一律不缓存，见文件头 ③）
    skillObjectCache.set(cacheKey, text)
    return text
  } catch (error) {
    if (!isS3NoSuchKey(error) || fallbackKey === key) throw asPurged(error, path, fallbackKey)
    try {
      const text = (await readObjectOnce(bucket, fallbackKey)).toString('utf8')
      skillObjectCache.set(cacheKey, text)
      return text
    } catch (fallbackError) {
      throw asPurged(fallbackError, path, fallbackKey)
    }
  }
}

/** 读失败 → `409 SKILL_VERSION_PURGED`（对象不在）/ `500`（其它上游故障） */
function asPurged(error: unknown, path: string, key: string): AppError {
  if (isS3NoSuchKey(error)) {
    getLogger().warn({ path, key }, 'Skill 对象已丢失（固定版本已过保留期或被回收）')
    return AppError.conflict(appMsg('app.m301', { p0: path }), {
      code: SKILL_ERROR_CODES.VERSION_PURGED,
    })
  }
  getLogger().error({ err: error, path, key }, '读取 Skill 对象失败')
  return AppError.internal(DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL)
}

/**
 * 按快照取该 Skill 该版本的文件索引（**唯一数据源**：`skill_files`）。
 *
 * @returns `null` = 该版本在索引里一个文件都没有（已归档 / 版本不存在）
 */
async function loadFileIndex(
  entry: SkillBindingEntry,
): Promise<{ path: string; storageKey: string }[] | null> {
  const rows = await getPrisma().skillFile.findMany({
    where: { skillId: entry.skillId, version: entry.version },
    select: { path: true, storageKey: true },
    orderBy: { path: 'asc' },
  })
  if (rows.length === 0) return null
  // `storageKey === ''` 的行**保留在索引里**，但正文已归档 —— 读的时候按归档报（不是"文件不存在"：
  // 文件当时确实存在过，模型拿到的结论应当能区分"名字写错了"与"这一版已被回收"）
  return rows
}

// ═════════════════════════════════════════════════════════════════════
// 参数解析（zod schema 是契约；这里只做"宽容一点"的补全）
// ═════════════════════════════════════════════════════════════════════

/**
 * 把模型给的宽松输入（`offset: "20"`、`limit: 0`）规整成 schema 能过的形状。
 *
 * 为什么宽容：`offset` / `limit` 是**翻页游标**，模型偶尔给字符串数字很常见；为一个游标格式
 * 让整次读取失败，比"退回默认值"坏得多（`knowledgeTools.ts#normalizeReadOffset` 同款判断）。
 * ⚠️ **`slug` / `path` 不宽容**：那是"读哪个对象"，含糊就报错并列出可选值，让模型自己纠正。
 */
function normalizePagingArgs(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value }
  for (const key of ['offset', 'limit'] as const) {
    const raw = out[key]
    if (raw === undefined || raw === null) {
      delete out[key]
      continue
    }
    if (typeof raw === 'string' && raw.trim() !== '' && /^\d+$/u.test(raw.trim())) {
      out[key] = Number(raw.trim())
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) delete out[key]
  }
  return out
}

/** schema 校验失败 → 一句可读原因（`issues` 的第一条足够；模型据此改参数重试） */
function schemaErrorOf(error: { issues: { message: string; path: (string | number)[] }[] }): string {
  const issue = error.issues[0]
  if (issue === undefined) return '参数不合法'
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}：`
  return `${where}${issue.message}`
}

// ═════════════════════════════════════════════════════════════════════
// 执行体
// ═════════════════════════════════════════════════════════════════════

/**
 * 执行一次内置 Skill 工具（`list_skills` / `load_skill` / `read_skill_file`）。
 *
 * ★ 三条工具的行为（与 `子方案` §4.2 逐条对应）：
 *   · `list_skills({ query? })` —— 列出**当前 Agent 绑定的** Skill（按关键词过滤 slug/name/description）；
 *   · `load_skill({ slug, offset?, limit? })` —— 只返回该 Skill 的 `SKILL.md`，按**码点**分页；
 *   · `read_skill_file({ slug, path, offset?, limit? })` —— 只读该 Skill 文件索引里的路径，
 *     禁止 `..` / 绝对路径；`scripts/**` 在 ChatBot 侧**不返回内容**。
 *
 * ⚠️ **不抛**：任何内部异常都翻成 `isError:true` 的一段文案 —— 单条工具失败不拖垮整轮。
 */
export async function executeSkillTool(input: {
  snapshot: SkillSnapshot
  /** 工具名（调用方已按 {@link isSkillTool} 分流） */
  name: string
  /** 模型给的 `arguments` **原文**（JSON 串） */
  arguments: string
  log?: SkillToolLogContext
}): Promise<SkillToolOutcome> {
  const logger = getLogger()
  const { snapshot, name, log } = input

  try {
    const parsed = parseToolArguments(input.arguments)
    if (!parsed.ok) {
      return {
        isError: true,
        output: `工具调用失败：${parsed.reason}。模型给出的原文：${truncateToolResult(input.arguments)}`,
      }
    }
    const args = normalizePagingArgs(parsed.value)

    if (name === SKILL_LIST_TOOL_NAME) {
      const result = listSkillsArgsSchema.safeParse(args)
      if (!result.success) {
        return { isError: true, output: `工具调用失败：${schemaErrorOf(result.error)}` }
      }
      return executeListSkills(snapshot, result.data.query)
    }
    if (name === SKILL_LOAD_TOOL_NAME) {
      const result = loadSkillArgsSchema.safeParse(args)
      if (!result.success) {
        return { isError: true, output: `工具调用失败：${schemaErrorOf(result.error)}` }
      }
      return await executeLoadSkill(snapshot, result.data.slug, result.data.offset, result.data.limit)
    }
    if (name === SKILL_READ_FILE_TOOL_NAME) {
      const result = readSkillFileArgsSchema.safeParse(args)
      if (!result.success) {
        return { isError: true, output: `工具调用失败：${schemaErrorOf(result.error)}` }
      }
      return await executeReadSkillFile(
        snapshot,
        result.data.slug,
        result.data.path,
        result.data.offset,
        result.data.limit,
      )
    }
    // 走到这里 = 调用方的白名单与本文件不一致（编程错误，不是模型的问题）
    return { isError: true, output: `工具调用失败：未知的工具 ${name}` }
  } catch (error) {
    logger.warn(
      { conversationId: log?.conversationId, agentId: log?.agentId, toolName: name, err: error },
      '内置 Skill 工具执行失败（已作为错误结果回填，本轮不因此失败）',
    )
    return {
      isError: true,
      output: truncateToolResult(
        `工具调用失败：${error instanceof AppError ? error.message : DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL}`,
      ),
    }
  }
}

/** `list_skills` 的执行体：**只列绑定的**；关键词缺失 = 全列 */
function executeListSkills(snapshot: SkillSnapshot, query: string | undefined | null): SkillToolOutcome {
  const entries = availableSkillEntries(snapshot)
  const keyword = (query ?? '').trim().toLowerCase()
  const matched =
    keyword === ''
      ? entries
      : entries.filter(
          (entry) =>
            entry.slug.toLowerCase().includes(keyword) ||
            entry.name.toLowerCase().includes(keyword) ||
            entry.description.toLowerCase().includes(keyword),
        )
  // 显式列全（不受 system prompt 的目录注入阈值约束）：把 `inlineLimit` 抬到条数以上即可
  const catalogOf = (items: readonly SkillBindingEntry[]): string =>
    items.length === 0
      ? '（当前智能体没有绑定任何可用的 Skill）'
      : formatSkillCatalogBlock(items, { inlineLimit: items.length }).text
  if (matched.length === 0) {
    return {
      isError: false,
      output:
        entries.length === 0
          ? catalogOf(entries)
          : `没有匹配「${keyword}」的 Skill。当前可用的 Skill：\n${catalogOf(entries)}`,
    }
  }
  return { isError: false, output: `可用 Skill（${String(matched.length)} 个）：\n${catalogOf(matched)}` }
}

/** 按 slug 取快照项；找不到 / 不可用 ⇒ 一句明确的原因（**列出可选 slug**，让模型自愈） */
function resolveBucket(
  snapshot: SkillSnapshot,
  slug: string,
): { entry: SkillBindingEntry } | { error: string } {
  const entry = snapshot.bySlug.get(slug)
  if (entry === undefined) {
    const available = availableSkillEntries(snapshot)
    return {
      error: `没有名为「${slug}」的 Skill（可能已删除，或不属于当前智能体）。${
        available.length === 0
          ? '当前智能体没有绑定任何可用的 Skill。'
          : `可用的 slug：${available.map((item) => item.slug).join('、')}`
      }`,
    }
  }
  if (!entry.bound) {
    return { error: `Skill「${entry.name}」（${entry.slug}）当前不可用：${entry.unavailableReason ?? '已删除或版本已归档'}` }
  }
  return { entry }
}

/** `load_skill` 的执行体：读 `SKILL.md`（frontmatter 按 DB 字段重生成）→ 按码点切一页 */
async function executeLoadSkill(
  snapshot: SkillSnapshot,
  slug: string,
  offset: number | undefined,
  limit: number | undefined,
): Promise<SkillToolOutcome> {
  const resolved = resolveBucket(snapshot, slug)
  if ('error' in resolved) return { isError: true, output: `工具调用失败：${resolved.error}` }
  const { entry } = resolved

  const index = await loadFileIndex(entry)
  const row = index?.find((item) => item.path === SKILL_ENTRY_PATH)
  if (row === undefined) {
    return {
      isError: true,
      output: `工具调用失败：Skill「${entry.name}」的 v${String(entry.version)} 里没有 ${SKILL_ENTRY_PATH}（该版本已归档或索引缺失）`,
    }
  }
  if (row.storageKey === '') {
    return {
      isError: true,
      output: `工具调用失败：Skill「${entry.name}」v${String(
        entry.version,
      )} 的 ${SKILL_ENTRY_PATH} 正文已归档（超过保留期），只剩路径与摘要；请让用户重新导入`,
    }
  }

  const raw = await readSkillObject(
    entry,
    row.path,
    row.storageKey,
    objectKeyOf(entry.skillId, entry.version, row.path),
  )
  const markdown = composeSkillMarkdown({
    name: entry.name,
    description: entry.description,
    runtime: entry.runtime,
    // 与 a-2 的 `skillMarkdownOf` 同判据：包里声明了 `requires.scripts: true` 就保留它
    requiresScripts: /^\s{2}scripts:\s*true\s*$/mu.test(raw),
    requiresBins: [],
    body: stripFrontmatter(raw),
  })
  const page = skillPageOf(markdown, offset ?? 0, limit ?? SKILL_PAGE_DEFAULT_LIMIT)
  return {
    isError: false,
    output: truncateToolResult(
      formatSkillPageText({
        title: skillLabel(entry),
        page,
        toolName: SKILL_LOAD_TOOL_NAME,
        nextArgs: `slug="${entry.slug}"`,
      }),
    ),
    audit: { skillId: entry.skillId, skillSlug: entry.slug, skillVersion: entry.version, skillPath: SKILL_ENTRY_PATH },
  }
}

/** `read_skill_file` 的执行体：只在**该 Skill 的文件索引**里找，越界 / 脚本 / 二进制一律拒绝 */
async function executeReadSkillFile(
  snapshot: SkillSnapshot,
  slug: string,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
): Promise<SkillToolOutcome> {
  const resolved = resolveBucket(snapshot, slug)
  if ('error' in resolved) return { isError: true, output: `工具调用失败：${resolved.error}` }
  const { entry } = resolved

  if (!isSafeSkillPath(path)) {
    return { isError: true, output: `工具调用失败：文件路径不合法（只能是 Skill 内的相对路径，不能含 .. 或绝对路径）：${path}` }
  }
  if (isSkillScriptPath(path)) {
    return {
      isError: true,
      output: `工具调用失败：${path} 是脚本文件，ChatBot 不能执行也不能读取 Skill 里的脚本；如果任务必须运行脚本，请告诉用户改用 TaskAgent`,
    }
  }

  const index = await loadFileIndex(entry)
  if (index === null) {
    return {
      isError: true,
      output: `工具调用失败：Skill「${entry.name}」的 v${String(entry.version)} 已归档（索引缺失），请让用户重新导入`,
    }
  }
  const row = index.find((item) => item.path === path)
  if (row === undefined) {
    const readable = index
      .map((item) => item.path)
      .filter((item) => !isSkillScriptPath(item))
      .slice(0, 50)
    return {
      isError: true,
      output: `工具调用失败：Skill「${entry.name}」里没有文件「${path}」。可读的文件：${readable.join('、') || '（无）'}`,
    }
  }
  if (row.storageKey === '') {
    return {
      isError: true,
      output: `工具调用失败：文件「${path}」的正文已归档（版本 v${String(
        entry.version,
      )} 超过保留期，对象已回收），只剩路径与摘要`,
    }
  }

  const text = await readSkillObject(
    entry,
    row.path,
    row.storageKey,
    objectKeyOf(entry.skillId, entry.version, row.path),
  )
  const page = skillPageOf(text, offset ?? 0, limit ?? SKILL_PAGE_DEFAULT_LIMIT)
  return {
    isError: false,
    output: truncateToolResult(
      formatSkillPageText({
        title: `${skillLabel(entry)} · ${path}`,
        page,
        toolName: SKILL_READ_FILE_TOOL_NAME,
        nextArgs: `slug="${entry.slug}", path="${path}"`,
      }),
    ),
    audit: { skillId: entry.skillId, skillSlug: entry.slug, skillVersion: entry.version, skillPath: path },
  }
}
