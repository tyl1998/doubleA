/**
 * Skill 契约（P1-24a-1；`docs/子方案/Skill能力.md` §2 / §3 / §4 / §6.4）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① Skill 不是 Tool：只有**三个固定内置工具**
 * ─────────────────────────────────────────────────────────────────────
 * 不为每个 Skill 注册一个 function tool（数量可能很多，`tools` 会被撑爆）。运行时只暴露
 * `list_skills` / `load_skill` / `read_skill_file` 三个固定工具，模型**按需**渐进披露：
 * 目录（`slug + name + description + version`）→ `SKILL.md` 正文 → references / assets。
 * ChatBot（后端进程内执行）与 TaskAgent（容器 `skills` 扩展执行）**共用本文件这一份定义**
 * （容器是独立运行时、不能 import `shared` ⇒ 后端用 {@link buildSkillManifestTools} 生成
 * manifest 的 `tools[]` 下发，`skill:contract` 回归逐字比对两边）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 两个硬边界
 * ─────────────────────────────────────────────────────────────────────
 * · **脚本只在 TaskAgent 沙箱执行**：`CHATBOT` 不能绑 `SANDBOX` Skill（409 `data.code =
 *   SKILL_RUNTIME_NOT_ALLOWED`）；`runtime=inline` 不得带 `scripts/**`。
 * · **他人的 sandbox Skill 一律 403**（`SKILL_SANDBOX_FOREIGN_DENIED`），只能 fork 成自己的；
 *   这条判据**只在绑定期执行**，不做"执行期确认后放行"（`bash` 面前无法可靠区分跑的是哪个脚本）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 错误子码走 `AppError.data.code`，**不新增 `ERROR_CODES`**
 * ─────────────────────────────────────────────────────────────────────
 * `ERROR_CODES`（`errors.ts`）是封闭枚举，每个值都牵着 `HTTP_STATUS_BY_ERROR_CODE` 与前端
 * `error.<CODE>` 兜底文案。Skill 专属子码一律放进 `AppError.data.code`（HTTP 状态复用既有码），
 * 前端展示顺序 = `data.code` 有文案就用它，否则退回 `code` 的通用文案。见 {@link SKILL_ERROR_CODES}。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 分页与截断是两套机制（§4.1）
 * ─────────────────────────────────────────────────────────────────────
 * `truncateToolResult`（`TOOL_RESULT_MAX_CHARS = 8000`）是**兜底**，**不返回 `nextOffset`**。
 * Skill 工具必须**自己先按 `limit` 切片**（按**码点**，复用 `truncateChars` 同款语义），
 * 切片后长度一定 ≤ 上限 ⇒ 正常路径不会触发兜底；每页返回 `{ text, offset, limit, totalChars,
 * truncated, nextOffset }`，最后一页 `nextOffset = null`。容器侧必须实现**同一套**算法
 * （`maxChars` 由 manifest 携带），`skill:contract` 逐字比对两边的 `nextOffset`。
 */

import { z } from 'zod'

import { ASSET_VISIBILITIES } from './assetAcl.js'
import { offsetPageOf } from './envelope.js'
import { validationMessage } from './i18n/validation.js'

// ───────────────────────────── 取值域 ─────────────────────────────

/**
 * Skill 的运行时要求（与 `schema.prisma` 的 `enum SkillRuntime` 逐字一致）。
 *
 * ⚠️ **不要**复用 `ASSET_VISIBILITIES` 那套三值习惯：这里的 `SANDBOX` 不是"权限更高"，
 * 而是"需要容器与脚本"，它决定的是**能不能绑到 ChatBot**。
 */
export const SKILL_RUNTIMES = ['INLINE', 'SANDBOX'] as const
export type SkillRuntime = (typeof SKILL_RUNTIMES)[number]

/**
 * Skill 的可见性 —— **只支持两档**（`子方案/Skill能力.md` §3.1 / §5.3）。
 *
 * 列是 `AssetVisibility`（三值），但 Skill 没有受众表：声明 `SHARED` 只会退化成"只有
 * owner / ADMIN 可见"，是一个**看起来能选、实际没有效果**的档位 ⇒ 服务层与契约都拒绝它
 * （`VALIDATION` 400）。授权主路径是 **Agent 受众**：Skill 被某个 Agent 绑定后，能用该
 * Agent 的人就能用它的 Skill；Skill 自身可见性只决定"能否独立发现并绑到自己的 Agent"。
 */
export const SKILL_VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number]

/** Skill 来源（与 `schema.prisma` 的 `enum SkillSourceType` 逐字一致；不参与授权判定） */
export const SKILL_SOURCE_TYPES = ['MANUAL', 'IMPORT', 'CONVERSATION'] as const
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number]

/** Skill 名称 / description / 文件路径的上限（**导出成常量**：schema 报错文案与前端提示同源） */
export const SKILL_NAME_MAX_CHARS = 128
export const SKILL_DESCRIPTION_MAX_CHARS = 1000
export const SKILL_SLUG_MAX_CHARS = 128
export const SKILL_PATH_MAX_CHARS = 1024

/**
 * `description` 的上限按**码点**算（不是 UTF-16 长度）—— 与截断口径一致；中文场景下
 * `String.length` 恰好等于码点数，但 emoji 会差一倍，所以这里统一用 `[...text].length`。
 */
function codePointLength(text: string): number {
  return [...text].length
}

// ───────────────────────────── 工具名（单一生成源）─────────────────────────────

/** 目录工具：**只列当前 Agent 绑定的 Skill**（不查全平台可见资产） */
export const SKILL_LIST_TOOL_NAME = 'list_skills'
/** 正文工具：读取 `SKILL.md`，支持 `offset/limit` 分页 */
export const SKILL_LOAD_TOOL_NAME = 'load_skill'
/** 资源工具：读取 `references/` / `assets/` 下的单个文件，支持 `offset/limit` 分页 */
export const SKILL_READ_FILE_TOOL_NAME = 'read_skill_file'
/**
 * 脚本工具：**第一阶段不下发**（ChatBot 永远没有；TaskAgent 用既有 `bash` 执行
 * `$SKILL_DIR/scripts/...`）。名字先占住，避免第二阶段上线时与别处撞名。
 */
export const SKILL_RUN_SCRIPT_TOOL_NAME = 'run_skill_script'

/**
 * 工具卡上的"来自哪个系统"（`toolCallRecordSchema.serverName`；与 `KNOWLEDGE_TOOL_SERVER_NAME` 同族）。
 *
 * ⚠️ ChatBot 与 TaskAgent **两处都要用它**：`taskAgent.ts#builtinToolServerName` 必须加一个
 * `isSkillToolName(toolName)` 分支，否则容器侧的 `load_skill` 会落进「内置工具」兜底，
 * 与 ChatBot 的卡片显示不一致（`skill:contract` 守着这条）。
 */
export const SKILL_TOOL_SERVER_NAME = 'Skill'

/**
 * 容器内 Skill 扩展的刷新命令（复用 P1-21 的跨边界命令通道；与
 * `infra/sandbox/base/pi-agent/extensions/skills/index.ts` 逐字相同）。
 *
 * **只在工具集合变化时注入**（0→N 首次绑定 / N→0 全部解绑）；仅版本变化只换 manifest / current。
 */
export const SKILLS_REFRESH_COMMAND = 'doubulea:skills-refresh'

/** 三个 Skill 工具名（下发顺序固定，`skill:contract` 按它逐字比对） */
export const SKILL_TOOL_NAMES = [
  SKILL_LIST_TOOL_NAME,
  SKILL_LOAD_TOOL_NAME,
  SKILL_READ_FILE_TOOL_NAME,
] as const
export type SkillToolName = (typeof SKILL_TOOL_NAMES)[number]

/** 这个工具名是不是 Skill 的内置工具（ChatBot 分流与工具卡归集共用） */
export function isSkillToolName(name: string): name is SkillToolName {
  return (SKILL_TOOL_NAMES as readonly string[]).includes(name)
}

// ───────────────────────────── 结果上限与分页参数 ─────────────────────────────

/**
 * 回填给模型的工具结果上限（字符，按码点）—— **与 `TOOL_RESULT_MAX_CHARS` 同值**。
 *
 * ⚠️ 这里刻意**再声明一次常量**而不是 import 后端那份：`shared` 不能依赖 `backend`
 * （依赖方向反了），而容器侧又要按同一个数字切片 ⇒ 唯一可行的做法是把它放进契约层，
 * 后端 `chatContext.ts#TOOL_RESULT_MAX_CHARS` 与它同值（`skill:contract` 断言两者相等）。
 */
export const SKILL_RESULT_MAX_CHARS = 8000

/**
 * `limit` 的缺省值 = 上限 − 512（预留 JSON 包装与 `nextOffset` 字段的额度，见 §4.1 口径 1）。
 */
export const SKILL_PAGE_DEFAULT_LIMIT = SKILL_RESULT_MAX_CHARS - 512

/** `limit` 的硬上限（不得超过 `SKILL_RESULT_MAX_CHARS`） */
export const SKILL_PAGE_MAX_LIMIT = SKILL_RESULT_MAX_CHARS

// ───────────────────────────── 参数 schema ─────────────────────────────

/** 分页参数（`offset` = 字符偏移、`limit` = 本页最多多少字符；都是**码点**语义） */
const skillPagingShape = {
  offset: z
    .number({ invalid_type_error: validationMessage('validation.skill.offsetNotNumber') })
    .int(validationMessage('validation.skill.offsetNotInteger'))
    .min(0, validationMessage('validation.skill.offsetNotNegative'))
    .optional(),
  limit: z
    .number({ invalid_type_error: validationMessage('validation.skill.limitNotNumber') })
    .int(validationMessage('validation.skill.limitNotInteger'))
    .min(1, validationMessage('validation.skill.limitMin'))
    .max(SKILL_PAGE_MAX_LIMIT, validationMessage('validation.skill.limitMax', { max: SKILL_PAGE_MAX_LIMIT }))
    .optional(),
} as const

/**
 * `list_skills` 参数：可选关键词（按 `slug` / `name` / `description` 做大小写不敏感的包含匹配）。
 * 缺省 = 列出全部绑定 Skill。
 */
export const listSkillsArgsSchema = z.object({
  query: z.string().trim().max(200, validationMessage('validation.skill.queryTooLong', { max: 200 })).optional(),
})
export type ListSkillsArgs = z.infer<typeof listSkillsArgsSchema>

/** `load_skill` 参数：`slug` 必填，`offset` / `limit` 可选 */
export const loadSkillArgsSchema = z.object({
  slug: z
    .string({ required_error: validationMessage('validation.skill.slugRequired') })
    .trim()
    .min(1, validationMessage('validation.skill.slugRequired')),
  ...skillPagingShape,
})
export type LoadSkillArgs = z.infer<typeof loadSkillArgsSchema>

/**
 * `read_skill_file` 参数：`slug` + `path` 必填，`offset` / `limit` 可选。
 *
 * `path` **只能是该 Skill 文件索引里的相对路径**（服务层/容器侧都必须再校验一次：
 * 禁止 `..`、绝对路径、盘符与 NUL —— 见 `backend/src/services/skillZip.ts#isSafeSkillPath`）。
 */
export const readSkillFileArgsSchema = z.object({
  slug: z
    .string({ required_error: validationMessage('validation.skill.slugRequired') })
    .trim()
    .min(1, validationMessage('validation.skill.slugRequired')),
  path: z
    .string({ required_error: validationMessage('validation.skill.pathRequired') })
    .trim()
    .min(1, validationMessage('validation.skill.pathRequired'))
    .max(SKILL_PATH_MAX_CHARS, validationMessage('validation.skill.pathTooLong', { max: SKILL_PATH_MAX_CHARS }))
    // 同一判据在 {@link isSafeSkillPath}（服务层 / 容器侧仍各自再校验一次：zod 只管形态）
    .regex(/^(?!.*(?:\\|\.\.|^\/|[A-Za-z]:))/u, validationMessage('validation.skill.pathUnsafe')),
  ...skillPagingShape,
})
export type ReadSkillFileArgs = z.infer<typeof readSkillFileArgsSchema>

// ───────────────────────────── 结果形状 ─────────────────────────────

/**
 * 一页文本（`load_skill` 与 `read_skill_file` 共用；**两边实现必须逐字同形**）。
 *
 * · `text`   —— 本页内容（按码点切片，长度 ≤ `limit`）；
 * · `offset` —— 本页起点（码点）；
 * · `limit`  —— 本页请求的上限（缺省 = {@link SKILL_PAGE_DEFAULT_LIMIT}）；
 * · `totalChars` —— 原文总长（码点；模型据此判断"还有多少没读"）；
 * · `truncated`  —— 后面是否还有内容；
 * · `nextOffset` —— 下一页的 `offset`；`truncated=false` 时**必须**是 `null`。
 */
export const skillPageSchema = z.object({
  text: z.string(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  totalChars: z.number().int().min(0),
  truncated: z.boolean(),
  nextOffset: z.number().int().min(0).nullable(),
})
export type SkillPage = z.infer<typeof skillPageSchema>

/**
 * 按**码点**切一页（`skillPageOf` 是它的唯一实现，ChatBot 与容器侧共用同一套语义）。
 *
 * 为什么要自己切而不是 `truncateToolResult`：后者截断后**不返回 `nextOffset`**，
 * 模型拿不到"下一页从哪开始"就永远读不完一篇长 `SKILL.md`（见文件头 ④）。
 * `offset` 超过全文长度 ⇒ 返回空页（`truncated=false`、`nextOffset=null`）：模型多翻一页
 * 不该收到错误，它需要的是"已经读完了"这个结论。
 */
export function skillPageOf(
  text: string,
  offset = 0,
  limit: number = SKILL_PAGE_DEFAULT_LIMIT,
): SkillPage {
  const chars = [...text]
  const totalChars = chars.length
  const safeOffset = Math.max(0, Math.trunc(offset))
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), SKILL_PAGE_MAX_LIMIT)
  const slice = chars.slice(safeOffset, safeOffset + safeLimit)
  const consumed = safeOffset + slice.length
  const truncated = consumed < totalChars
  return {
    text: slice.join(''),
    offset: safeOffset,
    limit: safeLimit,
    totalChars,
    truncated,
    nextOffset: truncated ? consumed : null,
  }
}

// ───────────────────────────── 目录指纹（P1-24a-4）─────────────────────────────

/**
 * 目录指纹的形状 —— `sha256:` + 64 位小写十六进制。
 *
 * ⚠️ **不是**防篡改的哈希：它只回答"这一轮的目录与上一次读到的目录是不是同一份"（要不要重新提示
 * "Skill 已更新"）。真相源永远是 DB / S3，指纹只是快速判据（与 b-1 的 `manifest.fingerprint` 同用途）。
 */
export const SKILL_CATALOG_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u

/**
 * 算一份目录指纹（**唯一实现**：ChatBot 的版本提示判据与 b-1 的 manifest 共用同一套算法）。
 *
 * 输入是 {@link skillCatalogFingerprintLines} 产出的行再 `join('\n')`。输出 `sha256:<hex>`。
 *
 * ⚠️ **同步、纯 JS**（见 {@link sha256Hex}）：`shared` 同时被 Node 与浏览器加载，指纹只用在
 *    "两串文本是否相同"上，不需要抗碰撞之外的任何密码学保证 —— 但**必须**是标准 SHA-256，
 *    否则容器侧（Node `crypto`）与后端算出来的指纹会分叉，`skill:contract` 用已知向量守着。
 * ⚠️ **按 UTF-8 字节**算（不是 UTF-16 码元）：`TextEncoder` 与 Node 的 `update(text, 'utf8')` 一致。
 */
export function skillCatalogFingerprint(text: string): string {
  return `sha256:${sha256Hex(text)}`
}

/**
 * 把快照项摊成指纹的**输入行**（每行一条，字段用 `\u0000` 分隔 ⇒ 字段里出现分隔符不会撞车）。
 *
 * ⚠️ 行里**只有决定"模型看到什么"的四件事**：`slug` / `version` / `name` / `description`。
 *    不把 `runtime` / `pinnedVersion` / `bound` 算进去：它们变化时目录文本一个字节都不变，
 *    算进去只会造出"目录没变却报版本变化"的假提示。
 * ⚠️ 顺序由调用方决定（`slug asc`）：同一份目录必须得到同一个指纹。
 */
export function skillCatalogFingerprintLines(
  entries: readonly { slug: string; version: number; name: string; description: string }[],
): string[] {
  return entries.map((entry) => [entry.slug, `v${String(entry.version)}`, entry.name, entry.description].join('\u0000'))
}

/** SHA-256 的初始哈希值（FIPS 180-4 §5.3.3） */
const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

/** SHA-256 的轮常量（前 64 个素数立方根小数部分；FIPS 180-4 §4.2.2） */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

/**
 * 标准 SHA-256（FIPS 180-4），输入按 **UTF-8**，输出小写十六进制。
 *
 * 为什么不用 `crypto.subtle`：它是**异步**的，而指纹要出现在同步的纯函数里（快照构建、回归断言、
 * 前端渲染路径）。为什么不用 `node:crypto`：`shared` 会被前端打包，`node:` 前缀进不了浏览器图。
 * 实现只做一件小事（对几十到几百字节的文本做哈希），不追求吞吐。
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLength = bytes.length * 8
  // 填充：0x80 + 若干 0x00，使总长 ≡ 56 (mod 64)，末尾 8 字节是大端位长
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const tail = padded.length - 8
  // ⚠️ 位长用两个 32 位字写（JS 位运算只有 32 位；文本不会超过 2^53 位，高 32 位按除法取）
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  padded[tail] = (high >>> 24) & 0xff
  padded[tail + 1] = (high >>> 16) & 0xff
  padded[tail + 2] = (high >>> 8) & 0xff
  padded[tail + 3] = high & 0xff
  padded[tail + 4] = (low >>> 24) & 0xff
  padded[tail + 5] = (low >>> 16) & 0xff
  padded[tail + 6] = (low >>> 8) & 0xff
  padded[tail + 7] = low & 0xff

  const hash: number[] = [...SHA256_INIT]
  const w = new Uint32Array(64)
  const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = block + index * 4
      w[index] = ((padded[at]! << 24) | (padded[at + 1]! << 16) | (padded[at + 2]! << 8) | padded[at + 3]!) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3)
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10)
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number]
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + SHA256_K[index]! + w[index]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, h]
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index]! + next[index]!) >>> 0
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('')
}

// ───────────────────────────── 目录栏 / 正文切片 / 目录注入阈值（P1-24a-3）─────────────────────────────

/**
 * `TOOL_RESULT_MAX_CHARS` 的**实际值**（`backend/src/orchestrator/chatContext.ts:640`）。
 *
 * ⚠️ 这里刻意**再写一次数字**而不是 import 后端那份：`shared` 不能依赖 `backend`（依赖方向反了），
 * 而 a-3 的"一页正文 + 目录栏"要把整段工具结果压在这个上限以下 —— 全仓只有这一处用到，
 * 用一个**命名常量**比在注释里写"8000"多一个可被 `skill:contract` 断言的点。
 */
export const SKILL_TOOL_RESULT_LIMIT = 8000

/**
 * 目录栏（system prompt 里的「可用 Skill」段）的**安全余量**（码点）。
 *
 * 目录栏最多占 `limit − 余量`，剩下的额度留给分类标题 / 规则段 / 翻页提示 ——
 * 这样"一条工具结果"（目录 + 标题 + 分页页脚）就永远在 {@link SKILL_TOOL_RESULT_LIMIT} 以内，
 * **不需要** `truncateToolResult` 兜底（§4.1 那条 ⚠️：分页与截断是两套机制）。
 */
export const SKILL_CATALOG_RESERVE_CHARS = 600

/**
 * 每个 Skill 在目录栏里占的额度（码点）—— 超出时只截 description，**不丢条目**。
 *
 * 为什么要按条限额：一条 description 上限 {@link SKILL_DESCRIPTION_MAX_CHARS}（1000），
 * 绑 10 个就能把整段目录撑到 1 万字；而目录的作用只是"让模型知道该不该 load"，
 * 前一两百字足够。截断处带省略号，模型据此知道"完整说明要 load_skill 才有"。
 */
export const SKILL_CATALOG_ENTRY_MAX_CHARS = 240

/**
 * 目录**全量注入**的阈值（Skill 条数）。超过它只注入"有 N 个可用 Skill，先调用 list_skills"。
 *
 * ⚠️ 与 P1-19 的 `MCP_INLINE_TOOL_LIMIT` **同思路但不共用常量**（一个是 MCP 工具、一个是 Skill），
 * 阈值口径见 `子方案` §4.4：MVP 阶段绑定的 Skill 是个位数，全量注入更省一次往返。
 */
export const SKILL_CATALOG_INLINE_LIMIT = 20

/** 目录栏里的一条（`slug + name + description + version`；**不含正文**） */
export interface SkillCatalogEntry {
  slug: string
  name: string
  description: string
  version: number
}

/** 目录栏格式化结果：`inline = false` 时 `text` 只有一行"有 N 个可用 Skill…" */
export interface SkillCatalogBlock {
  inline: boolean
  /** 条数（`inline = false` 时模型据此知道"有多少个"，真正清单要 `list_skills`） */
  total: number
  /** 已列入目录的条目（`inline = false` 时为空数组） */
  entries: SkillCatalogEntry[]
  /** 目录正文（不含标题、不含使用规则；空串 = 一条都没有，调用方不要注入这一段） */
  text: string
}

/** 按**码点**截断并补省略号（目录栏专用；与 `skillPageOf` 的分页语义无关） */
function clipCodePoints(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * 把绑定的 Skill 排成 system prompt 的目录栏（**唯一实现**；ChatBot 目录段与 `list_skills` 共用同一套排版）。
 *
 * 三条口径（§4.2.1）：
 *   ① **顺序稳定**（调用方先按 `slug asc` 排）—— 未变化时字符串逐字一致，provider 的 prompt cache 才能命中；
 *   ② **全量注入优先**：`entries.length ≤ SKILL_CATALOG_INLINE_LIMIT` 且总长在预算内 ⇒ 全列；
 *      超出条数阈值 ⇒ 只回一行"有 N 个可用 Skill，请先调用 `list_skills`"；
 *      条数没超但**总长**超预算（description 写得长）⇒ 逐条压到 {@link SKILL_CATALOG_ENTRY_MAX_CHARS}；
 *   ③ **一条都没有时 `text` 为空串**（调用方据此不注入这一段 —— 没绑 Skill 却写"可用 Skill："是造假）。
 */
export function formatSkillCatalogBlock(
  entries: readonly SkillCatalogEntry[],
  options: { maxChars?: number; inlineLimit?: number } = {},
): SkillCatalogBlock {
  const maxChars = options.maxChars ?? SKILL_TOOL_RESULT_LIMIT - SKILL_CATALOG_RESERVE_CHARS
  const inlineLimit = options.inlineLimit ?? SKILL_CATALOG_INLINE_LIMIT
  const total = entries.length
  if (total === 0) return { inline: true, total: 0, entries: [], text: '' }
  if (total > inlineLimit) {
    return {
      inline: false,
      total,
      entries: [],
      text: `（当前智能体绑定了 ${String(total)} 个 Skill，数量较多，这里不列出；请先调用 \`${SKILL_LIST_TOOL_NAME}\` 查看目录，再按需 \`${SKILL_LOAD_TOOL_NAME}\`。）`,
    }
  }

  const render = (entry: SkillCatalogEntry, description: string): string =>
    `- ${entry.slug}（v${String(entry.version)}）${entry.name}：${description}`
  const full = entries.map((entry) => render(entry, entry.description))
  if ([...full.join('\n')].length <= maxChars) {
    return { inline: true, total, entries: [...entries], text: full.join('\n') }
  }

  // 总长超预算：逐条压 description（**不丢条目**）；仍超就继续按比例收紧，直到放得下
  let perEntry = SKILL_CATALOG_ENTRY_MAX_CHARS
  for (;;) {
    const lines = entries.map((entry) => render(entry, clipCodePoints(entry.description, perEntry)))
    const text = lines.join('\n')
    if ([...text].length <= maxChars || perEntry <= 40) {
      return { inline: true, total, entries: [...entries], text: clipCodePoints(text, maxChars) }
    }
    perEntry = Math.max(40, Math.floor(perEntry / 2))
  }
}

// ───────────────────────────── 错误子码（`data.code`）─────────────────────────────

/**
 * Skill 的**业务子码**（放 `AppError.data.code`，**不新增 `ERROR_CODES`**）。
 *
 * 与 HTTP 状态复用的对应关系见 `子方案/Skill能力.md` §6.4。实现里的写法一律是
 * `new AppError('CONFLICT', msg, { code: SKILL_ERROR_CODES.RUNTIME_NOT_ALLOWED })`，
 * **不要**往 `ERROR_CODES` 里加 `SKILL_*`。
 */
export const SKILL_ERROR_CODES = {
  /** ChatBot 绑 sandbox Skill ⇒ 409 `CONFLICT` */
  RUNTIME_NOT_ALLOWED: 'SKILL_RUNTIME_NOT_ALLOWED',
  /** 绑他人的 sandbox Skill（非 ADMIN）⇒ 403 `FORBIDDEN` */
  SANDBOX_FOREIGN_DENIED: 'SKILL_SANDBOX_FOREIGN_DENIED',
  /** 未删除范围内 slug / name 重名 ⇒ 409 `CONFLICT` */
  SLUG_TAKEN: 'SKILL_SLUG_TAKEN',
  NAME_TAKEN: 'SKILL_NAME_TAKEN',
  /** 并发保存 / 固定版本冲突 ⇒ 409 `CONFLICT` */
  VERSION_CONFLICT: 'SKILL_VERSION_CONFLICT',
  STALE: 'SKILL_STALE',
  /** 固定版本已被保留期回收 ⇒ 409 `CONFLICT` */
  VERSION_PURGED: 'SKILL_VERSION_PURGED',
  /** ChatBot 传 `mode=TRACE` ⇒ 400 `VALIDATION` */
  TRACE_NOT_ALLOWED: 'SKILL_TRACE_NOT_ALLOWED',
  /** 草稿过期 / 非本人草稿 ⇒ 404（不区分，统一 404） */
  DRAFT_EXPIRED: 'DRAFT_EXPIRED',
  /** 抽取模型不可用 ⇒ 502 `UPSTREAM_ERROR` */
  EXTRACT_MODEL_UNAVAILABLE: 'EXTRACT_MODEL_UNAVAILABLE',
  /** TaskAgent Skill 同步失败 ⇒ 500 `INTERNAL` */
  SYNC_FAILED: 'SKILL_SYNC_FAILED',
  /** 导入校验失败（路径穿越 / symlink / 脚本但 inline / zip bomb / slug 为空）⇒ 400，`data.reasons[]` 给逐条原因 */
  IMPORT_INVALID: 'SKILL_IMPORT_INVALID',
  /** 会话级覆写并发冲突（P1-24c-4b）⇒ 409 */
  OVERRIDE_CONFLICT: 'SKILL_OVERRIDE_CONFLICT',
} as const
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[keyof typeof SKILL_ERROR_CODES]

/** 从任意错误 `data` 里读出 Skill 子码（**永不抛错**；形状不符返回 `undefined`）。前端按它选文案。 */
export function skillErrorCodeOf(data: unknown): SkillErrorCode | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const code = (data as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  const all: readonly string[] = Object.values(SKILL_ERROR_CODES)
  return all.includes(code) ? (code as SkillErrorCode) : undefined
}

// ───────────────────────────── 会话级覆写的覆写位（P1-24c-4b 回填）─────────────────────────────

/**
 * 一个 Skill 在**某一轮**解析出来的快照（`skillSnapshot`；`子方案/Skill能力.md` §5.9 / §5.16.3）。
 *
 * 解析优先级（服务端唯一实现，模型不能在一次工具调用里换版本）：
 *   ① 会话级覆写（`conversation_skill_overrides`，P1-24c-4b）→ ② Agent 固定版本
 *   （`agent_components.config.skillVersion`）→ ③ Skill 当前版本（`skills.version`）。
 *
 * ⚠️ **本批（a-1）行为恒为"无覆写"**：`override` 恒 `false`、`overrideRevision` 恒 `null`。
 * 覆写位先占好（字段与签名现在就定死），c-4b 落地时只填内容、不改形状 ——
 * 否则那一批要回头改 a / a-3 / b-1 / b-2 的契约与回归。
 *
 * `contentKey` 是**读取正文与文件的唯一来源**：命中覆写时是
 * `skill-overrides/{conversationId}/{skillId}/r{revision}/`，否则是 `skills/{id}/v{version}/`。
 */
export interface SkillSnapshot {
  skillId: string
  slug: string
  /** 审计与展示用的"上游版本"（命中覆写时 = `basedOnVersion`） */
  version: number
  runtime: SkillRuntime
  /** 本轮是否命中会话级覆写（a-1 恒 `false`） */
  override: boolean
  /** 覆写的递增号（a-1 恒 `null`；"没有这个值" ≠ "用了 r0"） */
  overrideRevision: number | null
  /** S3 前缀（见上） */
  contentKey: string
}

/**
 * 解析函数签名（ChatBot 与 TaskAgent **共用同一个解析函数**）。
 *
 * ⚠️ `override?` 是 **c-4b 的预留位**：本批恒不传（或传 `null`）。`fingerprint` 计算**已含**
 * `overrideRevision`（值为 `null` 时不改变哈希）—— 见 `子方案/Skill能力.md` §4.13。
 */
export type ResolveSkillSnapshotInput = {
  skillId: string
  slug: string
  runtime: SkillRuntime
  /** Skill 当前版本（`skills.version`） */
  currentVersion: number
  /** Agent 绑定的固定版本（`agent_components.config.skillVersion`；缺省 = 跟随最新） */
  pinnedVersion?: number | null
  /** 会话级覆写（c-4b；本批恒缺省） */
  override?: {
    basedOnVersion: number
    revision: number
  } | null
  /** 覆写的 S3 前缀生成器（c-4b 传入；缺省按标准前缀拼） */
  conversationId?: string
}

/**
 * Skill 的 S3 前缀（**全仓唯一拼法**；出现第二种即视为设计漂移）。
 *
 * · `skills/{skillId}/v{version}/` —— 上游版本（不可变）；
 * · `skill-overrides/{conversationId}/{skillId}/r{revision}/` —— 会话级覆写（c-4b）。
 */
export function skillStoragePrefix(skillId: string, version: number): string {
  return `skills/${skillId}/v${version}/`
}

/** 会话级覆写的 S3 前缀（c-4b；a-1 只在这里定义形状，不产生数据） */
export function skillOverridePrefix(conversationId: string, skillId: string, revision: number): string {
  return `skill-overrides/${conversationId}/${skillId}/r${revision}/`
}

/**
 * 解析本轮 `skillSnapshot`（**唯一实现**；优先级见 {@link SkillSnapshot}）。
 *
 * a-1 只做"无覆写"的三态合并：`override` 缺省 ⇒ 固定版本优先于当前版本。
 * c-4b 接入时只需在调用点把覆写查出来传进来 —— 这里的签名与返回值**不再变**。
 */
export function resolveSkillSnapshot(input: ResolveSkillSnapshotInput): SkillSnapshot {
  const override = input.override ?? null
  if (override !== null) {
    return {
      skillId: input.skillId,
      slug: input.slug,
      version: override.basedOnVersion,
      runtime: input.runtime,
      override: true,
      overrideRevision: override.revision,
      contentKey:
        input.conversationId === undefined
          ? skillOverridePrefix('', input.skillId, override.revision)
          : skillOverridePrefix(input.conversationId, input.skillId, override.revision),
    }
  }
  const version = input.pinnedVersion ?? input.currentVersion
  return {
    skillId: input.skillId,
    slug: input.slug,
    version,
    runtime: input.runtime,
    override: false,
    overrideRevision: null,
    contentKey: skillStoragePrefix(input.skillId, version),
  }
}

// ───────────────────────────── manifest tools[] 生成（单一生成源）─────────────────────────────

/** manifest 里的一条工具定义（name / description / JSON Schema） */
export interface SkillManifestTool {
  name: SkillToolName
  description: string
  inputSchema: Record<string, unknown>
}

/** 工具描述（模型据此判断"什么时候调"；两边共用，改这里就两边一起变） */
const SKILL_TOOL_DESCRIPTIONS: Readonly<Record<SkillToolName, string>> = {
  [SKILL_LIST_TOOL_NAME]:
    '列出当前智能体已绑定的 Skill 目录（slug / 名称 / 用途 / 版本）。可选 query 按关键词过滤。',
  [SKILL_LOAD_TOOL_NAME]:
    '读取某个 Skill 的 SKILL.md 完整说明（按 slug）。长文按 offset/limit 分页，返回 nextOffset；先 load 再执行。',
  [SKILL_READ_FILE_TOOL_NAME]:
    '读取某个 Skill 内的参考资料或模板（按 slug + 相对 path）。只能读该 Skill 的文件；同样支持 offset/limit 分页。',
}

/**
 * 由 zod 参数 schema 生成 JSON Schema（**最小子集**：object / string / integer / boolean + required）。
 *
 * ⚠️ 刻意不引 `zod-to-json-schema`：三个 schema 的形状是固定的、且容器侧只消费这一份 ——
 * 多一个依赖只为了让"三个对象"少写十几行不值得。形状一变（新增字段类型）要同步这里。
 */
function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> }
  if (def.typeName === 'ZodObject') {
    const shape = def.shape?.() ?? {}
    // `limit` 在 JSON Schema 里给一个具体上限 = 契约上的"切页预算"（容器侧据此定默认分页）
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJsonSchema(value)
      if (!(value.isOptional?.() ?? false)) required.push(key)
    }
    return required.length > 0
      ? { type: 'object', properties, required }
      : { type: 'object', properties }
  }
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
    const inner = (schema as z.ZodOptional<z.ZodTypeAny>)._def.innerType as z.ZodTypeAny
    return toJsonSchema(inner)
  }
  if (def.typeName === 'ZodString') {
    // 路径类字段把"不许 `\` / 不许 `..`"也带进 schema（容器侧只消费这份定义）
    const checks = ((schema as z.ZodString)._def.checks ?? []) as { kind: string }[]
    if (checks.some((check) => check.kind === 'regex')) return { type: 'string', pattern: '^(?!.*(?:\\|\\.\\.))' }
    return { type: 'string' }
  }
  if (def.typeName === 'ZodNumber') return { type: 'integer' }
  if (def.typeName === 'ZodBoolean') return { type: 'boolean' }
  // 兜底：任何未覆盖的形状给"任意值"，宁可宽松也不产出错的约束（契约回归会发现）
  return {}
}

/**
 * 生成容器 manifest 的 `tools[]`（**完整工具定义**：name / description / inputSchema）。
 *
 * 容器是独立运行时、不能 import `shared` ⇒ 后端在同步前用它生成，容器侧**只消费**。
 * 只放字符串名的话，容器就只能手写第二份 schema（`子方案/Skill能力.md` §4.6 明确禁止）。
 *
 * @param names 要下发的工具名（缺省 = 三个固定工具；`run_skill_script` 第一阶段恒不下发）
 */
export function buildSkillManifestTools(names: readonly SkillToolName[] = SKILL_TOOL_NAMES): SkillManifestTool[] {
  const schemaOf: Record<SkillToolName, z.ZodTypeAny> = {
    [SKILL_LIST_TOOL_NAME]: listSkillsArgsSchema,
    [SKILL_LOAD_TOOL_NAME]: loadSkillArgsSchema,
    [SKILL_READ_FILE_TOOL_NAME]: readSkillFileArgsSchema,
  }
  return names.map((name) => ({
    name,
    description: SKILL_TOOL_DESCRIPTIONS[name],
    inputSchema: toJsonSchema(schemaOf[name]),
  }))
}

// ───────────────────────────── OpenAI 工具定义（ChatBot 下发；P1-24a-3）─────────────────────────────

/** 下发时的一条工具（形状与 `backend/src/mcp/toolSchema.ts#OpenAiFunctionTool` 逐字一致） */
export interface SkillOpenAiTool {
  type: 'function'
  function: { name: SkillToolName; description: string; parameters: Record<string, unknown> }
}

/**
 * 三个工具给模型的**参数说明**（`description` 里那句"什么时候调"）。
 *
 * ⚠️ 与 {@link SKILL_TOOL_DESCRIPTIONS} **分工不同、不能合并**：那边是"这个工具做什么"（manifest 用，
 * 容器侧消费）；这里是"什么时候该调它"（ChatBot 下发用）。两段都来自 §4.2 的规则文案。
 */
const SKILL_TOOL_PARAMETER_HINTS: Readonly<Record<SkillToolName, string>> = {
  [SKILL_LIST_TOOL_NAME]: '列出当前智能体绑定的 Skill 目录（slug / 名称 / 用途 / 版本）。可用 query 按关键词过滤。',
  [SKILL_LOAD_TOOL_NAME]:
    '读取某个 Skill 的 SKILL.md 完整说明（按 slug）。任务与某个 Skill 匹配时**先调用它**再执行；' +
    '长说明会分页返回，若结果里提示还有内容，用返回的 offset 继续读，直到读完。',
  [SKILL_READ_FILE_TOOL_NAME]:
    '读取某个 Skill 内的参考资料 / 模板（按 slug + 相对 path）。只能读该 Skill 里真实存在的文件；' +
    '不要假装已经读过未加载的文件。同样支持 offset / limit 分页。',
}

/**
 * 生成 ChatBot 下发的三个 Skill 工具（**与 manifest 共用同一份参数 schema**）。
 *
 * 为什么也放在契约层：参数 schema 的**单一生成源**是 `shared`（`06` P1-24 跨批约束 1），
 * 后端只做 `zod → JSON Schema` 的翻译；若在 `chatContext.ts` 手写第二份 `parameters`，
 * 模型看到的参数与容器侧校验的参数就会分叉，而症状是"ChatBot 传对了、TaskAgent 报参数错"。
 */
export function buildSkillOpenAiTools(names: readonly SkillToolName[] = SKILL_TOOL_NAMES): SkillOpenAiTool[] {
  const schemaOf: Record<SkillToolName, Record<string, unknown>> = {
    [SKILL_LIST_TOOL_NAME]: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '（可选）关键词：按 slug / 名称 / 用途做包含匹配；省略则列出全部' },
      },
    },
    [SKILL_LOAD_TOOL_NAME]: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Skill 的 slug（目录里每一项开头那个标识）' },
        offset: { type: 'integer', description: '（可选）从第几个字符开始读（从 0 起）；翻页时用上一页返回的 nextOffset' },
        limit: { type: 'integer', description: `（可选）本页最多多少字符（1–${String(SKILL_PAGE_MAX_LIMIT)}）` },
      },
      required: ['slug'],
    },
    [SKILL_READ_FILE_TOOL_NAME]: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Skill 的 slug' },
        path: { type: 'string', description: 'Skill 内的相对路径（如 references/api.md）' },
        offset: { type: 'integer', description: '（可选）从第几个字符开始读（从 0 起）' },
        limit: { type: 'integer', description: `（可选）本页最多多少字符（1–${String(SKILL_PAGE_MAX_LIMIT)}）` },
      },
      required: ['slug', 'path'],
    },
  }
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: SKILL_TOOL_PARAMETER_HINTS[name], parameters: schemaOf[name] },
  }))
}

// ───────────────────────────── 校验辅助（导入 / 覆写共用）─────────────────────────────

/**
 * 路径是否安全（Skill 内相对路径）。**唯一的路径判据**（导入解包与运行时读取都用它）。
 *
 * 拒绝：空串 / 含 NUL / 反斜杠（统一用 `/`）/ 绝对路径 / `..` 段 / `.` 段 / 盘符（`c:`）/ 超长。
 * ⚠️ 不做 URL 解码：解包后的 zip 条目名就是最终路径，多一次解码只会引入新的绕过面。
 */
export function isSafeSkillPath(path: string): boolean {
  if (path === '' || path.length > SKILL_PATH_MAX_CHARS) return false
  if (path.includes('\u0000') || path.includes('\\')) return false
  if (path.startsWith('/')) return false
  if (/^[A-Za-z]:/u.test(path)) return false
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/** 这个路径是不是脚本（`scripts/**`）—— 与 `runtime=INLINE` 互斥（§2.2 一致性校验） */
export function isSkillScriptPath(path: string): boolean {
  return path === 'scripts' || path.startsWith('scripts/')
}

/** `SKILL.md` 的固定路径（Skill 根的说明文件；必须存在且必须叫这个名字） */
export const SKILL_ENTRY_PATH = 'SKILL.md'

/**
 * `requires.scripts` / `scripts/**` / `runtime` 三者的一致性校验（导入、重新导入、草稿保存共用）。
 *
 * 规则只有一条：**有脚本就必须是 `SANDBOX`；`INLINE` 不得带脚本**（§2.2 / §6.1）。
 * 返回不合法原因（空数组 = 合法）；调用方把它塞进 `SKILL_IMPORT_INVALID` 的 `data.reasons[]`。
 */
export function checkSkillRuntimeConsistency(input: {
  runtime: SkillRuntime
  requiresScripts: boolean
  paths: readonly string[]
}): string[] {
  const reasons: string[] = []
  const hasScriptFiles = input.paths.some((path) => isSkillScriptPath(path))
  if (input.runtime === 'INLINE' && (input.requiresScripts || hasScriptFiles)) {
    reasons.push('runtime=inline 的 Skill 不得声明 requires.scripts 或包含 scripts/ 文件')
  }
  if (input.runtime === 'SANDBOX' && !input.requiresScripts && !hasScriptFiles) {
    // 允许：sandbox 也可以只是"读资料 + 需要容器环境"。这里**不**报错（自己发明约束会挡住合法配置）
  }
  return reasons
}

/**
 * `description` 的码点长度校验（超限返回 `false`，由调用方给具体文案）。
 * 不做截断后静默入库（§2.2："不要截断后静默入库"）。
 */
export function skillDescriptionWithinLimit(description: string): boolean {
  return codePointLength(description.trim()) <= SKILL_DESCRIPTION_MAX_CHARS
}

// ═════════════════════════════════════════════════════════════════════
// 管理面契约（P1-24a-2；`子方案/Skill能力.md` §5.1 / §5.2 / §5.3）
// ═════════════════════════════════════════════════════════════════════
//
// 端点（**全部只需登录**；改/删/导入/转移由服务层行级判定 = 所属人或 ADMIN）：
//   GET    /api/skills                       列表（`offset/limit`；按可见性过滤）
//   GET    /api/skills/:id                   详情（含文件索引 + 版本 + 变更记录）
//   PATCH  /api/skills/:id                   改元数据（名称 / 描述 / 可见范围；**不动文件、不升版本**）
//   DELETE /api/skills/:id                   软删（**被 Agent 绑定时 409**）
//   POST   /api/skills                       创建（multipart：`file` = zip + 可选 `runtime`）
//   POST   /api/skills/:id/import            重新导入（multipart；生成新版本，不覆盖旧对象）
//   POST   /api/skills/:id/transfer          转移所属人（`{ toUserId }`，复用 `transferAssetBodySchema`）
//   GET    /api/skills/:id/file?path=&version=   单文件预览（JSON：文本 / 二进制元数据）
//
// 三条口径（落地时最容易走偏的三处）：
//   ① **内容只走 zip**：`PATCH` 不接 `markdown` / `files` / `storageKey` —— 内容编辑属草稿链（c 批）。
//   ② **取消/归档的旧版本**：`skill_files` 行还在但 `storageKey === ''` ⇒ 预览/下载回 409
//      `data.code = SKILL_VERSION_PURGED`，不返回空文件、也不悄悄换成最新版。
//   ③ **列表一律 `offset/limit`**（仓库既有约定），`parentSkillId/parentVersion` 一并投影
//      （fork 关系属 c-5，本批只透出既有列）。

/** 变更记录的来源（与 `schema.prisma` 的 `enum SkillChangeSource` 逐字一致） */
export const SKILL_CHANGE_SOURCES = ['MANUAL', 'CONVERSATION_CORRECTION', 'PROPOSAL'] as const
export type SkillChangeSource = (typeof SKILL_CHANGE_SOURCES)[number]

/** 列表 / 详情共用的元数据投影（`canEdit` / `creatorName` / `visibility` 与既有资产口径一致） */
export const skillItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  runtime: z.enum(SKILL_RUNTIMES),
  /** 当前整版快照号（`skills.version`） */
  version: z.number().int().min(1),
  visibility: z.enum(SKILL_VISIBILITIES),
  sourceType: z.enum(SKILL_SOURCE_TYPES),
  requiresBins: z.array(z.string()),
  createdBy: z.string(),
  creatorName: z.string(),
  canEdit: z.boolean(),
  /** fork 来源（逻辑引用；无 FK） */
  parentSkillId: z.string().nullable(),
  parentVersion: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SkillItem = z.infer<typeof skillItemSchema>

/** 列表结果（`OffsetPage`，与知识库 / MCP 同形） */
export const skillListResultSchema = offsetPageOf(skillItemSchema)
export type SkillListResult = z.infer<typeof skillListResultSchema>

/** 列表查询：分页 + 可选关键词（`slug` / `name` / `description` 包含匹配，大小写不敏感） */
export const listSkillsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(200, validationMessage('validation.common.limitMax'))
    .default(50),
  query: z.string().trim().max(200, validationMessage('validation.skill.queryTooLong', { max: 200 })).optional(),
})
export type ListSkillsQuery = z.infer<typeof listSkillsQuerySchema>

/** `:id` 路径参数 */
export const skillIdParamsSchema = z.object({
  id: z.string({ required_error: validationMessage('validation.skill.idRequired') })
    .uuid(validationMessage('validation.skill.idNotUuid')),
})
export type SkillIdParams = z.infer<typeof skillIdParamsSchema>

/**
 * 文件索引项（文件树 + 预览 + 下载共用）。
 *
 * `purged = true` ⇒ 该版本正文已归档（保留期内可读，之后只剩路径 + sha256，见 `SkillFile` 注释）。
 */
export const skillFileEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().min(0),
  mime: z.string(),
  sha256: z.string(),
  /** 文本可直接预览（`text/*` / `application/json` / `+json` / `+xml` 等） */
  previewable: z.boolean(),
  purged: z.boolean(),
})
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>

/** 版本列表项（只读；MVP 不做回滚） */
export const skillVersionSchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.string(),
  fileCount: z.number().int().min(0),
  /** 该版本是否已全部归档（S3 对象已回收） */
  purged: z.boolean(),
})
export type SkillVersion = z.infer<typeof skillVersionSchema>

/** 变更记录项（`skill_changes`；正文不在这里，正文在 `skill_files` 的版本行里） */
export const skillChangeSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  changeSummary: z.string(),
  source: z.enum(SKILL_CHANGE_SOURCES),
  createdBy: z.string(),
  creatorName: z.string(),
  createdAt: z.string(),
})
export type SkillChange = z.infer<typeof skillChangeSchema>

/** 详情（`GET /api/skills/:id`）：元数据 + 当前版本文件索引 + 版本 / 变更记录 */
export const skillDetailSchema = skillItemSchema.extend({
  /** 当前版本的文件索引（按 path 升序） */
  files: z.array(skillFileEntrySchema),
  /** 版本列表（`version` 降序） */
  versions: z.array(skillVersionSchema),
  /** 变更记录（`createdAt` 降序；上限由服务层定） */
  changes: z.array(skillChangeSchema),
  /** 引用它的 Agent 数（删除守卫的提示量） */
  agentCount: z.number().int().min(0),
})
export type SkillDetail = z.infer<typeof skillDetailSchema>

/**
 * 改元数据（`PATCH /api/skills/:id`）：**只改名 / 描述 / 可见范围**。
 *
 * · 三态：不带 = 不动；`visibility` 只接受 `PRIVATE` / `PUBLIC`（`SHARED` ⇒ 400）；
 * · **刻意不接受 `runtime` / `slug` / 文件**：`runtime` 与 `scripts/**` 互斥，
 *   单独改它会造出"看起来能用、绑定就 409/导入才炸"的资产；改运行时等于重发一个包。
 * · 并发保护：带 `expectedUpdatedAt`（ISO 串），不匹配 ⇒ 409 `SKILL_STALE`（不自动合并）。
 */
export const updateSkillBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, validationMessage('validation.skill.nameRequired'))
      .max(SKILL_NAME_MAX_CHARS, validationMessage('validation.skill.nameTooLong', { max: SKILL_NAME_MAX_CHARS }))
      .optional(),
    description: z
      .string()
      .trim()
      .min(1, validationMessage('validation.skill.descriptionRequired'))
      .max(
        SKILL_DESCRIPTION_MAX_CHARS,
        validationMessage('validation.skill.descriptionTooLong', { max: SKILL_DESCRIPTION_MAX_CHARS }),
      )
      .optional(),
    visibility: z
      .enum(ASSET_VISIBILITIES, {
        errorMap: () => ({
          message: validationMessage('validation.skill.visibilityAllowed', { allowed: SKILL_VISIBILITIES.join(' / ') }),
        }),
      })
      .optional(),
    expectedUpdatedAt: z
      .string({ invalid_type_error: validationMessage('validation.skill.expectedUpdatedAtInvalid') })
      .datetime({ message: validationMessage('validation.skill.expectedUpdatedAtInvalid') })
      .optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.visibility !== undefined,
    { message: validationMessage('validation.common.atLeastOneField') },
  )
export type UpdateSkillBody = z.infer<typeof updateSkillBodySchema>

/**
 * 删除结果（`DELETE /api/skills/:id`）。
 *
 * ⚠️ **软删**（`deleted_at`）：`skill_files` 行与 S3 对象都留着 —— 历史消息里的
 * `tool_calls` 还要能回看"当时用了哪个版本、哪些路径"。硬删是清理器的职责，不在管理面。
 */
export const removeSkillResultSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type RemoveSkillResult = z.infer<typeof removeSkillResultSchema>

/** 导入结果：`created = true` 表示新建（`POST /api/skills`），否则是重新导入（新版本号） */
export const importSkillResultSchema = z.object({
  skill: skillItemSchema,
  /** 本次生成的版本号 */
  version: z.number().int().min(1),
  fileCount: z.number().int().min(0),
  created: z.boolean(),
})
export type ImportSkillResult = z.infer<typeof importSkillResultSchema>

/**
 * 单文件预览（`GET /api/skills/:id/file?path=&version=`）。
 *
 * · 文本 ⇒ `kind = 'TEXT'` + `text`（**按码点切片**，复用 {@link skillPageOf}；`nextOffset` 语义同工具侧）；
 * · 二进制 ⇒ `kind = 'BINARY'` + 元信息（前端给"下载"入口；`GET /:id/file?download=1` 走字节流）。
 *
 * `SKILL.md` 的 `text` 是**服务端按 DB 字段重生成了 frontmatter** 的版本（`composeSkillMarkdown`），
 * 与模型将来读到的一致 —— 包里那份过期的 frontmatter 不展示。
 */
export const skillFilePreviewSchema = z.object({
  path: z.string(),
  version: z.number().int().min(1),
  mime: z.string(),
  size: z.number().int().min(0),
  sha256: z.string(),
  kind: z.enum(['TEXT', 'BINARY']),
  /** 仅 `kind = TEXT` 时非空（一页文本） */
  page: skillPageSchema.nullable(),
})
export type SkillFilePreview = z.infer<typeof skillFilePreviewSchema>

/** 单文件预览的查询参数 */
export const skillFileQuerySchema = z.object({
  path: z
    .string({ required_error: validationMessage('validation.skill.pathRequired') })
    .min(1, validationMessage('validation.skill.pathRequired'))
    .max(SKILL_PATH_MAX_CHARS, validationMessage('validation.skill.pathTooLong', { max: SKILL_PATH_MAX_CHARS })),
  /** 缺省 = 当前版本 */
  version: z.coerce
    .number({ invalid_type_error: validationMessage('validation.skill.versionNotNumber') })
    .int(validationMessage('validation.skill.versionNotInteger'))
    .min(1, validationMessage('validation.skill.versionMin'))
    .optional(),
  offset: z.coerce
    .number({ invalid_type_error: validationMessage('validation.skill.offsetNotNumber') })
    .int(validationMessage('validation.skill.offsetNotInteger'))
    .min(0, validationMessage('validation.skill.offsetNotNegative'))
    .optional(),
  limit: z.coerce
    .number({ invalid_type_error: validationMessage('validation.skill.limitNotNumber') })
    .int(validationMessage('validation.skill.limitNotInteger'))
    .min(1, validationMessage('validation.skill.limitMin'))
    .max(SKILL_PAGE_MAX_LIMIT, validationMessage('validation.skill.limitMax', { max: SKILL_PAGE_MAX_LIMIT }))
    .optional(),
})
export type SkillFileQuery = z.infer<typeof skillFileQuerySchema>

/** 整包下载的查询参数（`version` 缺省 = 当前版本） */
export const skillDownloadQuerySchema = skillFileQuerySchema.pick({ version: true })
export type SkillDownloadQuery = z.infer<typeof skillDownloadQuerySchema>

/** `SKILL.md` 之外哪些 MIME 可以直接以文本预览（二进制一律走下载） */
const TEXT_PREVIEW_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/yaml'] as const

/**
 * 该文件的 MIME 是否允许**以文本预览**（`子方案` §5.1："文本预览只返回允许的 MIME"）。
 *
 * 只按 MIME 前缀判，不嗅探内容：解包时 `mime` 由扩展名表定（`skillZip.ts#mimeOf`），
 * 而扩展名是用户在包里给的 —— 所以这里的作用是"别把 PDF 当文本吐给浏览器"，
 * 不是安全边界（读到 `.md` 里的脚本原文是**预期行为**，它是给模型看的说明）。
 */
export function isPreviewableSkillMime(mime: string): boolean {
  const normalized = mime.toLowerCase()
  if ((TEXT_PREVIEW_MIME_PREFIXES as readonly string[]).some((prefix) => normalized.startsWith(prefix))) return true
  return normalized.endsWith('+json') || normalized.endsWith('+xml')
}
