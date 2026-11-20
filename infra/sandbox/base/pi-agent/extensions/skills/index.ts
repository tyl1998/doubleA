/**
 * skills —— 沙箱内的 **Skill 只读扩展**（P1-24b-2）
 *
 * 依据：`docs/子方案/Skill能力.md` §4.3（装配）/ §4.13（manifest）/ §4.15（容器内工具注册）/
 *      §4.16（失败与重建）/ §4.17（只读、路径判据）/ §4.19（验收）；`docs/06-实施计划.md` P1-24b-2。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一句话：把宿主副本目录里的 Skill **就地**交给模型 —— 读本地文件，一次网络请求都不发
 * ═══════════════════════════════════════════════════════════════════════
 * ```
 * session_start / /doubulea:skills-refresh
 *   → 读 $SKILLS_DIR/manifest.json（宿主只读 bind；后端同步器原子写的）
 *   → 按 manifest.tools[] 注册 list_skills / load_skill / read_skill_file（**不手写第二份 schema**）
 * 模型调 load_skill({slug})
 *   → 在 manifest 里按 slug 找 → 读 `$SKILLS_DIR/<entry.path>/SKILL.md`
 *   → 自己按 manifest.maxChars 切片（与后端同一套 skillPageOf 语义）→ 返回一页 + nextOffset
 * ```
 * ⚠️ **不请求 `/api/sandbox/builtin/call`**（验收项之一）：Skill 文件就在容器里，绕一圈后端只会
 *    把一个"容器内读本地文件"的动作变成一次网络往返 + 一份后端侧的 S3 读取。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 五条硬口径
 * ═══════════════════════════════════════════════════════════════════════
 * ① **目录只读**：`$SKILLS_DIR` 是以 `ReadOnly: true` 的 bind 进来的（`spec.ts`），扩展**只读不写**；
 *    想写就写 `/work`（b-3 的脚本产物）。
 * ② **版本以 manifest 的 `path` 为准**，不用 `current/<slug>`：`path` 是这一轮同步时固定下来的；
 *    `current` 只是给 `bash` 跑脚本的稳定入口（b-3），两者的切换顺序保证"先目录后 manifest"。
 * ③ **刷新只在工具集合变化时发生**（后端 `needsSkillsRefresh` 判）：本扩展的 `syncTools` 幂等 ——
 *    同名再注册只是覆盖定义；新清单没有的工具从本扩展的工具表里摘掉。
 * ④ **`throw` 才是失败**：参数错误 / slug 不存在 / 文件不存在 ⇒ 抛（pi 把 message 当失败结果给模型），
 *    不返回 `{isError:true}` 风格的对象（返回对象不算失败）。**失败不影响已注册的工具**。
 * ⑤ **失败只走 stderr**（与 mcp-bridge 同款：本层没有可用的 UI 通道）；`/doubulea:skills-refresh`
 *    自己**不抛**（命令失败会把整条 prompt 变成错误，代价远大于收益）。
 *
 * ⚠️ 四条 pi 上游约束同 mcp-bridge：工厂里只读 env、不起 socket / 定时器；`registerTool` 可在
 *    `session_start` 与运行期调用；不用 `ctx.ui`；不做任何地址兜底。
 *
 * ⚠️ 下面这些**都是跨边界契约**，与 `shared/src/skill.ts` / `backend/src/sandbox/spec.ts` 逐字对应
 *    （`skill-sync:regression` 读本目录源码断言）：目录 env 名、三个工具名、刷新命令名、分页常量。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'

import {
  LOG_PREFIX,
  SKILL_ENTRY_PATH,
  SKILL_LIST_TOOL_NAME,
  SKILL_LOAD_TOOL_NAME,
  SKILL_MANIFEST_FILE,
  SKILL_READ_FILE_TOOL_NAME,
  SKILLS_REFRESH_COMMAND,
  findManifestEntry,
  isSkillRequestToolName,
  formatSkillList,
  formatSkillPageText,
  isSafeSkillPath,
  listSkillEntries,
  normalizePagingArgs,
  pageLimitOf,
  parseManifest,
  skillPageOf,
  skillPageTitle,
  type SkillManifest,
  type SkillManifestEntry,
} from './contract.js'

// ───────────────────────────── 跨边界常量 ─────────────────────────────

/**
 * 宿主副本在容器里的挂载点（**由后端写进容器 env**，见 `backend/src/sandbox/spec.ts` 的
 * `SANDBOX_SKILLS_DIR_ENV`）。缺省 = 挂载点的固定值（扩展在手工 `docker run` 调试时也能用）。
 */
const SKILLS_DIR_ENV = 'DOUBULEA_SKILLS_DIR'
const DEFAULT_SKILLS_DIR = '/home/agent/.skills'

/**
 * 后端的沙箱代理基地址与令牌（与 `mcp-bridge` 同一组 env；**身份来自令牌**）。
 *
 * 只读工具在容器内读本地文件，**一次网络请求都不发**；只有草稿入口工具（`request_skill_draft` /
 * `request_skill_revision` / `revise_skill_draft`）需要把"抽取要读 DB / S3 / 模型"的动作代理回后端
 * `/api/sandbox/builtin/call`（容器不执行抽取）。
 */
const BACKEND_URL_ENV = 'SANDBOX_BACKEND_URL'
const TOKEN_ENV = 'SANDBOX_TOKEN'
const PROXY_TIMEOUT_ENV = 'SANDBOX_PROXY_TIMEOUT_MS'
const BUILTIN_CALL_PATH = '/api/sandbox/builtin/call'
const TOKEN_HEADER = 'x-sandbox-token'
const DEFAULT_PROXY_TIMEOUT_MS = 180_000

/** `pi.registerTool` 的返回形状（与 mcp-bridge 同款） */
interface ToolResult {
  content: { type: 'text'; text: string }[]
  details: undefined
}

// ───────────────────────────── 扩展本体 ─────────────────────────────

export default function skillsExtension(pi: ExtensionAPI): void {
  // ⚠️ 约束①：工厂里只读 env、只挂 handler（不起 socket / 定时器）。
  //    目录只在执行期用（`skillsDir()`），这里喊一声只为了把"env 装配漏了"写进日志。
  announceSkillsDir()
  // ⚠️ 不能写成 `const skillsDir = skillsDir()`：同名 `const` 会让右侧的解析落到它自己身上
  //    （TDZ）⇒ 扩展加载即抛 `Cannot access 'skillsDir' before initialization`，引擎直接退出。
  const skillsRoot = skillsDir()
  const backend = {
    backendUrl: process.env[BACKEND_URL_ENV]?.trim() ?? '',
    token: process.env[TOKEN_ENV]?.trim() ?? '',
    timeoutMs: timeoutOf(process.env[PROXY_TIMEOUT_ENV]),
  }

  /** 本扩展当前已注册的工具名（热更新按它做 diff；`null` = 还没同步过） */
  let registeredNames: Set<string> | null = null
  /** 最近一次同步用的 manifest（**工具调用读它** ⇒ 同一轮内版本固定，manifest 换了下一轮才生效） */
  let currentManifest: SkillManifest | null = null
  /** 上次记录的 manifest 指纹（只在变化时打日志，免得每次 refresh 都刷一行） */
  let lastFingerprint = ''

  /** 读一次 manifest（**恒不抛**：缺失 / 坏 JSON / 形状不符 ⇒ `null`） */
  async function loadManifest(): Promise<SkillManifest | null> {
    let text: string
    try {
      text = await readFile(join(skillsRoot, SKILL_MANIFEST_FILE), 'utf8')
    } catch (error) {
      log('WARN', `读不到 ${SKILL_MANIFEST_FILE}（${describeError(error)}）⇒ 本会话不注册 Skill 工具`)
      return null
    }
    try {
      return parseManifest(JSON.parse(text) as unknown)
    } catch (error) {
      log('ERROR', `${SKILL_MANIFEST_FILE} 不是合法 JSON（${describeError(error)}）⇒ 本会话不注册 Skill 工具`)
      return null
    }
  }

  /** 执行体要的 manifest：**用同步时那份**（拿不到就现读一次，绝不返回一个"半新"的组合） */
  async function manifestForCall(): Promise<SkillManifest> {
    if (currentManifest !== null) return currentManifest
    const manifest = await loadManifest()
    if (manifest === null) throw new Error('这个会话现在没有可用的 Skill（没有 manifest 或其中没有工具定义）。')
    return manifest
  }

  /**
   * 同步工具集合（`session_start` 与 `/doubulea:skills-refresh` **同一份实现**）。
   *
   * 三条顺序上的事：
   *   ① 先读 manifest（读失败 ⇒ `null` ⇒ 把已注册的全摘掉，**不沿用旧清单**：后端已经决定了这一轮
   *      没有 Skill，沿用会让模型去 load 一个已经不存在的 Skill）；
   *   ② 摘掉新清单里没有的（改 `extension.tools` 不触发 refresh，所以 ③ 必须补）；
   *   ③ 注册新清单里的每一个（同名覆盖定义，`registerTool` 每次都会 `refreshTools()`）。
   */
  async function syncTools(): Promise<{ added: string[]; removed: string[]; count: number }> {
    const manifest = await loadManifest()
    currentManifest = manifest
    const nextNames = new Set((manifest?.tools ?? []).map((tool) => tool.name))
    const previous = registeredNames

    const added = [...nextNames].filter((name) => previous === null || !previous.has(name))
    const removed = previous === null ? [] : [...previous].filter((name) => !nextNames.has(name))

    if (removed.length > 0) {
      const table = toolTableOf(pi)
      for (const name of removed) table.delete(name)
    }
    for (const tool of manifest?.tools ?? []) {
      registerSkillTool(pi, tool.name, tool.description, tool.inputSchema, () => manifestForCall(), backend)
    }
    registeredNames = nextNames

    const fingerprint = manifest?.fingerprint ?? ''
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint
      log(
        'INFO',
        `Skill 工具已同步：${String(nextNames.size)} 个工具 / ${String(manifest?.skills.length ?? 0)} 个 Skill` +
          `（新增 ${String(added.length)}、移除 ${String(removed.length)}，fingerprint=${fingerprint === '' ? '（无）' : fingerprint}）`,
      )
    }
    return { added, removed, count: nextNames.size }
  }

  pi.on('session_start', async () => {
    try {
      await syncTools()
    } catch (error) {
      // 不抛（session_start 抛错会让会话起不来）；不注册任何工具 = 模型这轮看不到 Skill
      log('ERROR', `Skill 工具同步失败 ⇒ 本会话不注册 Skill 工具：${describeError(error)}`)
    }
  })

  /**
   * 刷新命令（P1-21 同款通道）：`/doubulea:skills-refresh`。
   *
   * · 命令名与后端 `SKILLS_REFRESH_COMMAND` 逐字相同（后端在"首次绑定 / 全部解绑"时注入这一行）；
   * · 参数可有可无；
   * · 失败**不抛**，已注册的工具照旧可用（它们读的是本地文件，与清单无关）。
   */
  pi.registerCommand(SKILLS_REFRESH_COMMAND, {
    description: '重新读取 Skill manifest 并注册 / 注销 Skill 工具（平台在首次绑定或全部解绑后会调用）',
    handler: async () => {
      try {
        const result = await syncTools()
        log('INFO', `Skill 工具已刷新（新增 ${String(result.added.length)}、移除 ${String(result.removed.length)}）`)
      } catch (error) {
        log('WARN', `Skill 工具刷新失败（沿用已注册的工具）：${describeError(error)}`)
      }
    },
  })
}

// ───────────────────────────── 三个工具的实现 ─────────────────────────────

/** 读一个超时 env（非数字 / 越界 ⇒ 默认值；与 `mcp-bridge` 同款兜底） */
function timeoutOf(raw: string | undefined): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROXY_TIMEOUT_MS
  return Math.trunc(value)
}

/** 拼后端地址（与 `mcp-bridge#endpoint` 同形：不猜、不兜底地址） */
function endpointOf(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

/**
 * 一次草稿入口工具调用（容器 → 后端 `/api/sandbox/builtin/call`）。
 *
 * 出口与 `mcp-bridge#callBuiltin` 逐字同款：200 + `isError:false` ⇒ 返回文本；
 * `isError:true` ⇒ **抛**（pi 把 message 当失败结果给模型）；传输层失败 ⇒ 抛。
 */
async function callBuiltinTool(input: {
  backendUrl: string
  token: string
  timeoutMs: number
  name: string
  params: Record<string, unknown>
}): Promise<ToolResult> {
  if (input.backendUrl === '' || input.token === '') {
    throw new Error(`草稿入口工具不可用：容器 env 缺少 ${input.backendUrl === '' ? BACKEND_URL_ENV : TOKEN_ENV}`)
  }
  let response: Response
  try {
    response = await fetch(endpointOf(input.backendUrl, BUILTIN_CALL_PATH), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: input.token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, arguments: input.params }),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
  } catch (error) {
    throw new Error(`调用草稿入口工具失败：${describeError(error)}。本次调用未完成。`, { cause: error })
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`调用草稿入口工具失败：HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail}`}`)
  }
  const body = (await response.json().catch(() => null)) as { isError?: unknown; text?: unknown } | null
  if (body === null || typeof body.text !== 'string') {
    throw new Error('调用草稿入口工具失败：后端返回的形状不对。')
  }
  if (body.isError === true) throw new Error(body.text)
  return { content: [{ type: 'text', text: body.text }], details: undefined }
}

/**
 * 注册一个 manifest 里的工具（`list_skills` / `load_skill` / `read_skill_file`）。
 *
 * ⚠️ 参数 schema **直接转交 manifest 的 `inputSchema`**（与 mcp-bridge `parametersFor` 同一条
 *    理由：TypeBox 1.x 接受纯 JSON Schema）；schema 不是对象时退回 `Type.Object({})`（不抛 ——
 *    抛了会让整份清单注册不上，代价只是那一个工具的参数对模型不具约束力）。
 */
function registerSkillTool(
  pi: ExtensionAPI,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  manifest: () => Promise<SkillManifest>,
  backend: { backendUrl: string; token: string; timeoutMs: number },
): void {
  pi.registerTool({
    name,
    label: name,
    description,
    parameters: parametersFor(inputSchema),
    async execute(_toolCallId, params): Promise<ToolResult> {
      // 只读工具在容器内读本地文件；草稿入口工具不读 manifest，直接代理回后端。
      if (isSkillRequestToolName(name)) {
        return await callBuiltinTool({
          ...backend,
          name,
          params: params as Record<string, unknown>,
        })
      }
      const text = await runSkillTool(name, await manifest(), params as unknown)
      return { content: [{ type: 'text', text }], details: undefined }
    },
  })
}

/** 工具分流（**不认识的工具名直接抛**：清单与执行体不一致时宁可失败，也不返回一句"我没有这个工具"） */
async function runSkillTool(name: string, manifest: SkillManifest, args: unknown): Promise<string> {
  if (name === SKILL_LIST_TOOL_NAME) return await runListSkills(manifest, args)
  if (name === SKILL_LOAD_TOOL_NAME) return await runLoadSkill(manifest, args)
  if (name === SKILL_READ_FILE_TOOL_NAME) return await runReadSkillFile(manifest, args)
  throw new Error(`不支持的工具：${name}（本扩展只提供 ${SKILL_LIST_TOOL_NAME} / ${SKILL_LOAD_TOOL_NAME} / ${SKILL_READ_FILE_TOOL_NAME}）`)
}

/** `list_skills({ query? })` —— 只列 manifest 里的（= 本 Agent 绑定的） */
async function runListSkills(manifest: SkillManifest, args: unknown): Promise<string> {
  const raw = normalizePagingArgs(args).raw
  const query = typeof raw.query === 'string' ? raw.query : undefined
  const entries = listSkillEntries(manifest, query)
  return formatSkillList(entries, manifest.skills.length)
}

/** `load_skill({ slug, offset?, limit? })` —— 读 `<entry.path>/SKILL.md`，按页给 */
async function runLoadSkill(manifest: SkillManifest, args: unknown): Promise<string> {
  const { offset, raw } = normalizePagingArgs(args)
  const slug = requiredString(raw.slug, 'slug')
  const entry = findManifestEntry(manifest, slug)
  if (entry === undefined) throw new Error(unknownSkillError(manifest, slug))
  const text = await readSkillText(entry, SKILL_ENTRY_PATH)
  const limit = pageLimitOf(manifest, optionalNumber(raw.limit))
  const page = skillPageOf(text, offset, limit)
  return formatSkillPageText({
    title: skillPageTitle(entry),
    page,
    toolName: SKILL_LOAD_TOOL_NAME,
    nextArgs: `slug="${entry.slug}"`,
    overrideRevision: entry.overrideRevision,
  })
}

/** `read_skill_file({ slug, path, offset?, limit? })` —— 只能读该 Skill 目录里的相对路径 */
async function runReadSkillFile(manifest: SkillManifest, args: unknown): Promise<string> {
  const { offset, raw } = normalizePagingArgs(args)
  const slug = requiredString(raw.slug, 'slug')
  const path = requiredString(raw.path, 'path')
  const entry = findManifestEntry(manifest, slug)
  if (entry === undefined) throw new Error(unknownSkillError(manifest, slug))
  if (!isSafeSkillPath(path)) {
    throw new Error(`文件路径不合法（只能是 Skill 内的相对路径，不能含 .. 或绝对路径）：${path}`)
  }
  const text = await readSkillText(entry, path)
  const limit = pageLimitOf(manifest, optionalNumber(raw.limit))
  const page = skillPageOf(text, offset, limit)
  return formatSkillPageText({
    title: skillPageTitle(entry, path),
    page,
    toolName: SKILL_READ_FILE_TOOL_NAME,
    nextArgs: `slug="${entry.slug}", path="${path}"`,
    overrideRevision: entry.overrideRevision,
  })
}

// ───────────────────────────── 读本地文件 ─────────────────────────────

/** 读一个 Skill 版本目录里的文本文件（先 `realpath` 判越界，再读；读不到给出可执行的建议） */
async function readSkillText(entry: SkillManifestEntry, path: string): Promise<string> {
  const base = join(skillsDir(), entry.path)
  const absolute = join(base, path)
  try {
    // ⚠️ 只判"是不是个文件"：路径本身已由 `isSafeSkillPath` 拦过（无 `..` / 绝对路径 / 反斜杠），
    //    而版本目录里的 symlink 在导入闸门（`skillZip.ts` 读中央目录的 external attributes）就被拒了。
    const real = await stat(absolute)
    if (!real.isFile()) throw new Error(`不是文件：${path}`)
    return await readFile(absolute, 'utf8')
  } catch (error) {
    if (path === SKILL_ENTRY_PATH) {
      throw new Error(
        `这个 Skill 缺少 ${SKILL_ENTRY_PATH}（${entry.slug} v${String(entry.version)}）：${describeError(error)}。请告诉用户重新导入该 Skill。`,
        { cause: error },
      )
    }
    const available = await listFilesIn(base)
    throw new Error(`读不到 ${path}（${entry.slug} v${String(entry.version)}）：${describeError(error)}。${available}`, {
      cause: error,
    })
  }
}

/** 目录里的文件清单（报错时给模型一个"能读什么"的提示；读不到就返回空串） */
async function listFilesIn(base: string): Promise<string> {
  try {
    const names = await readdir(base, { recursive: true, withFileTypes: true })
    const files = names
      .filter((item) => item.isFile())
      .map((item) => relativePathOf(item.parentPath || item.path, base, item.name))
      .filter((path) => path !== '' && !path.startsWith('.'))
      .sort()
    if (files.length === 0) return ''
    return `这个 Skill 现有的文件：${files.slice(0, 50).join(', ')}${files.length > 50 ? ' …' : ''}`
  } catch {
    return ''
  }
}

/** `Dirent.parentPath`（Node 22）/ `path`（老版本）都可能给绝对路径；这里统一成相对 base 的 */
function relativePathOf(parent: string, base: string, name: string): string {
  const joined = join(parent, name)
  const prefix = base.endsWith('/') ? base : `${base}/`
  return joined.startsWith(prefix) ? joined.slice(prefix.length) : name
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** manifest 里没有这个 slug 时的错误（列出可用 slug：模型据此自己纠正） */
function unknownSkillError(manifest: SkillManifest, slug: string): string {
  const available = manifest.skills.map((entry) => entry.slug)
  const suffix = available.length === 0 ? '当前没有绑定任何 Skill。' : `可用的 slug：${available.join(', ')}。`
  return `没有名为 ${slug} 的 Skill（只能用当前智能体绑定的 Skill）。${suffix}`
}

/** 必填字符串参数（不宽容：非字符串 / 空串 ⇒ 抛） */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`参数 ${field} 必填（字符串）。`)
  return value.trim()
}

/** `registerTool` 要的 `parameters`（纯 JSON Schema → TypeBox；非对象 ⇒ 空对象） */
function parametersFor(inputSchema: unknown): TSchema {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as TSchema
  }
  return Type.Object({})
}

/**
 * 取**本扩展**的工具表（上游没有公开 `unregisterTool`，`registerTool` 的落点是一张 Map；
 * 从它上面 `delete` 就是注销，只是不会自动 `refreshTools()` —— 所以调用方随后必然再注册一次）。
 * 取不到时返回一次性空表（`delete` 变空操作），只 warn，不抛。
 */
function toolTableOf(pi: ExtensionAPI): { delete: (name: string) => boolean } {
  const holder = pi as unknown as { tools?: Map<string, unknown>; extension?: { tools?: Map<string, unknown> } }
  const table = holder.tools ?? holder.extension?.tools
  if (table !== undefined) return table
  log('WARN', '取不到本扩展的工具表 ⇒ 已下线的 Skill 工具不会被摘除（上游内部结构变了）')
  return { delete: () => false }
}

/**
 * Skill 目录（容器内绝对路径）。
 *
 * ⚠️ 写成**函数**而不是模块级常量：`skillsDir()` 在工具执行时再读一次 env，手工在活容器里改
 *    env 的调试路径也能生效（正常路径上后端一定会给 `DOUBULEA_SKILLS_DIR`）。
 */
function skillsDir(): string {
  const raw = process.env[SKILLS_DIR_ENV]
  const trimmed = raw === undefined ? '' : raw.trim()
  return trimmed === '' ? DEFAULT_SKILLS_DIR : trimmed
}

/** 启动时喊一声挂载点（只用于日志：让"env 装配漏了"一眼可见） */
function announceSkillsDir(): void {
  if (process.env[SKILLS_DIR_ENV] === undefined) {
    log('INFO', `容器 env 里没有 ${SKILLS_DIR_ENV} ⇒ 按默认挂载点 ${DEFAULT_SKILLS_DIR} 读 Skill`)
  }
}

/** `offset/limit` 这类可选数字参数（非数字 ⇒ `undefined`，交给 `pageLimitOf` 用缺省值） */
function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value))
  return undefined
}

/** 异常 → 一句人话 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 往 stderr 写一行（约束⑤：本层唯一的对外出口；后端把容器 stderr 收进日志，已脱敏） */
function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${level} ${message}\n`)
}
