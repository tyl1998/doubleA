/**
 * workspace —— 沙箱内的**工作区中介扩展**（P1-9 · P2 的实现骨架）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 2（工具中介：同名覆盖 `read`/`write`/`edit`）、
 *      §五 5（中途感知：写 CAS 失败回喂模型）、§七 1 第 ②/③ 层（claim + CAS）、§十五（上游能力确认）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一句话：把引擎的 `read`/`write`/`edit` 换成**版本感知**版 —— 写走 CAS，冲突回喂模型
 * ═══════════════════════════════════════════════════════════════════════
 * ```
 * 模型调 write(path, content)
 *   → 本扩展：先看"我上次读到的 version"（没有就先 read 一次拿 version）
 *   → POST {SANDBOX_BACKEND_URL}/api/sandbox/workspace/write  {path, content, baseVersion}
 *   → 后端：CAS（baseVersion ≠ 当前 ⇒ 冲突）→ 200 {ok:false, code:'CONFLICT', currentVersion}
 *   → 本扩展：**抛**一句"文件已被修改（vN），请重新读取后再写" ⇒ 模型重读再改（不静默覆盖）
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 默认**关闭**（env 开关），本批只做代码落地，不改变现有 TaskAgent 行为
 * ═══════════════════════════════════════════════════════════════════════
 * 只有容器 env 里 `DOUBULEA_WORKSPACE_MEDIATION=1` 时，本扩展才覆盖 `read`/`write`/`edit`；
 * 否则**一个工具都不注册**（工厂直接返回）。理由：覆盖内置工具是**侵入性**改动，而"会话级
 * codeMode 开关"（§六 4）属 **P3** —— 在开关落地前用一个 env 把它钉在门外，安全且可回滚。
 *
 * ✅ **已在 pin 版 `0.87.1` 上做最小原型复核**（R8，2026-10-12，`子方案` §十五）：在
 *    `doubulea/sandbox-toolkit`（pi `0.87.1`）里 `DOUBULEA_WORKSPACE_MEDIATION=1` 起容器、逼模型
 *    调一次 `write`，确认 ① **同名覆盖生效**（发给 LLM 的 `tools` 里 `read`/`write`/`edit` 是本扩展
 *    的定义，不是内置）；② `write` 走代理 CAS（`baseVersion` 带上、冲突文案回喂模型）。
 *    ⚠️ 复核同时订正了两处**与 0.87.1 的偏差**：内置 `edit` 的形状是
 *    `{ path, edits: [{ oldText, newText }] }`（**不是** Claude 系的 `old_string`/`new_string`）
 *    ⇒ 本扩展按 0.87.1 对齐；覆盖时若不给 `promptSnippet`/`promptGuidelines`，会**连带丢掉**
 *    内置工具在系统提示里的条目与用法提示 ⇒ 三个工具都补上。
 *
 * ⚠️ 与 mcp-bridge 同族的四条约束：工厂里只读 env 不起 socket；`throw` 才算失败
 *    （返回对象不算 `isError`）；失败只走 stderr；不做地址兜底。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

// ───────────────────────────── 跨边界常量 ─────────────────────────────

/** 后端沙箱代理基地址（同 `sandbox/spec.ts#sandboxEgressEnv` 的 `SANDBOX_BACKEND_URL`） */
const BACKEND_URL_ENV = 'SANDBOX_BACKEND_URL'
/** per-container 代理令牌（同 `sandbox/spec.ts#SANDBOX_TOKEN_ENV`） */
const TOKEN_ENV = 'SANDBOX_TOKEN'
/** 单次代理调用超时（同 `sandbox/spec.ts#SANDBOX_PROXY_TIMEOUT_ENV`） */
const PROXY_TIMEOUT_ENV = 'SANDBOX_PROXY_TIMEOUT_MS'
/**
 * 中介开关（**本批默认关闭**，见文件头）。后端在 P3 接上"会话级 codeMode"后改为按会话注入。
 * ⚠️ 名字与后端约定的注入点（P3）必须一致。
 */
const MEDIATION_ENV = 'DOUBULEA_WORKSPACE_MEDIATION'

const READ_PATH = '/api/sandbox/workspace/read'
const WRITE_PATH = '/api/sandbox/workspace/write'
const EDIT_PATH = '/api/sandbox/workspace/edit'
/** 令牌头名（小写；`spec.ts#SANDBOX_TOKEN_HEADER`） */
const TOKEN_HEADER = 'x-sandbox-token'

const DEFAULT_TIMEOUT_MS = 180_000
const LOG_PREFIX = '[workspace]'

/** `POST /api/sandbox/workspace/*` 的响应（后端侧 = `workspace/proxy.ts#WorkspaceProxyResult`） */
type WorkspaceProxyResult =
  | { ok: true; version: number; path: string; mime?: string; size?: number; content?: string }
  | { ok: false; code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION' | 'FORBIDDEN' | 'INTERNAL'; message: string; currentVersion?: number }

/** `pi.registerTool` 的结果形状（与 mcp-bridge 同款） */
interface ToolResult {
  content: { type: 'text'; text: string }[]
  details: undefined
}

/** 一处替换（与 pin `0.87.1` 内置 `edit` 的 `edits[]` 逐字同形；后端侧 = `workspace/edit.ts#WorkspaceEdit`） */
interface WorkspaceEdit {
  oldText: string
  newText: string
}

// ───────────────────────────── 扩展本体 ─────────────────────────────

export default function workspaceMediation(pi: ExtensionAPI): void {
  // ⚠️ 约束 ①：工厂里只读 env，不起 socket（fetch 全在 session_start 之后）
  const enabled = readEnv(MEDIATION_ENV) === '1'
  const backendUrl = readEnv(BACKEND_URL_ENV)
  const token = readEnv(TOKEN_ENV)
  const timeoutMs = readProxyTimeoutMs()

  // 默认关闭：不覆盖任何内置工具（见文件头）
  if (!enabled) return

  /**
   * 每个路径"agent 上次读到的版本"（进程内、per runtime）。
   * 写/编辑带上它 ⇒ **"人读之后、写之前改过"** 会被后端 CAS 拦下（§七 2 的时序）。
   * ⚠️ 这只是**尽力提示**：拿不到版本时先读一次；真正的杜绝静默覆盖由后端 CAS 保证。
   */
  const lastReadVersion = new Map<string, number>()

  /** 每路径的 read-modify-write 串行链（本地实现，避免依赖未复核的 `withFileMutationQueue` 导出） */
  const chains = new Map<string, Promise<void>>()

  let registered = false

  pi.on('session_start', () => {
    if (registered) return
    if (backendUrl === undefined || token === undefined) {
      log('ERROR', `容器 env 里缺少 ${backendUrl === undefined ? BACKEND_URL_ENV : TOKEN_ENV} ⇒ 不注册工作区中介工具`)
      return
    }

    // ── read：直接走后端（拿到最新字节 + version）──
    // ⚠️ `promptSnippet`/`promptGuidelines`/`constrainedSampling` 与内置工具**逐字对齐**
    //    （R8 复核）：覆盖内置工具时若不给 `promptSnippet`，内置工具在系统提示 `<tools>` 里的条目
    //    会**静默消失**、`promptGuidelines` 也会被丢掉 ⇒ 模型少了"用 read 而不是 cat/sed"这类引导。
    pi.registerTool({
      name: 'read',
      label: 'read',
      description: '读取工作区文件内容（与人类用户共享的工作区；返回最新版本）。',
      promptSnippet: 'Read file contents',
      promptGuidelines: ['Use read to examine files instead of cat or sed.'],
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      parameters: Type.Object({
        path: Type.String({ description: '工作区相对路径' }),
        offset: Type.Optional(Type.Number({ description: '起始行（1 起，可选）' })),
        limit: Type.Optional(Type.Number({ description: '最多读多少行（可选）' })),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const p = params as { path: string; offset?: number; limit?: number }
        const result = await postJson(backendUrl, token, timeoutMs, READ_PATH, { path: p.path })
        if (!result.ok) throw new Error(result.message)
        lastReadVersion.set(p.path, result.version)
        return { content: [{ type: 'text', text: sliceLines(result.content ?? '', p.offset, p.limit) }], details: undefined }
      },
    })

    // ── write：CAS（baseVersion 取上次读到的；没有就先读）──
    pi.registerTool({
      name: 'write',
      label: 'write',
      description: '写入工作区文件（带版本校验；文件被别人改过会被拒绝，需重新读取后再写）。',
      promptSnippet: 'Create or overwrite files',
      promptGuidelines: ['Use write only for new files or complete rewrites.'],
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      parameters: Type.Object({
        path: Type.String({ description: '工作区相对路径' }),
        content: Type.String({ description: '文件完整内容' }),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const p = params as { path: string; content: string }
        return withPathQueue(chains, p.path, async () => {
          const baseVersion = await resolveBaseVersion(backendUrl, token, timeoutMs, p.path, lastReadVersion)
          const result = await postJson(backendUrl, token, timeoutMs, WRITE_PATH, {
            path: p.path,
            content: p.content,
            baseVersion,
          })
          if (!result.ok) throw new Error(conflictText(result))
          lastReadVersion.set(p.path, result.version)
          return { content: [{ type: 'text', text: `已写入 ${result.path}（v${result.version}）` }], details: undefined }
        })
      },
    })

    // ── edit：读 → 后端局部替换（后端自己做 CAS）──
    // ⚠️ 形状**逐字对齐 pin 0.87.1 的内置 `edit`**（R8 复核）：`{ path, edits: [{ oldText, newText }] }`。
    //    `prepareArguments` 同样照抄内置的兼容 shim（`edits` 被模型序列化成 JSON 字符串 / 传成单个对象 /
    //    旧的 `old_string`/`new_string` 形态都归一成 `edits[]`），否则某些模型（Opus / GLM 系）的"习惯写法"
    //    会在 schema 校验这一步就失败。
    pi.registerTool({
      name: 'edit',
      label: 'edit',
      description:
        '对工作区文件做局部字符串替换（带版本校验；每处 oldText 须在文件里唯一匹配，多处区域不得重叠）。',
      promptSnippet:
        'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      promptGuidelines: [
        'Use edit for precise changes (edits[].oldText must match exactly)',
        'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
        'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
        'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
      ],
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      parameters: Type.Object({
        path: Type.String({ description: '工作区相对路径' }),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String({ description: '要被替换的原文（须在文件里唯一匹配）' }),
            newText: Type.String({ description: '替换成的新文本' }),
          }),
          { description: '一处或多处替换（各 oldText 须互相不重叠，且都按原文件匹配）' },
        ),
      }),
      prepareArguments: prepareEditArguments,
      async execute(_id, params): Promise<ToolResult> {
        const p = params as { path: string; edits: WorkspaceEdit[] }
        return withPathQueue(chains, p.path, async () => {
          const baseVersion = await resolveBaseVersion(backendUrl, token, timeoutMs, p.path, lastReadVersion)
          const result = await postJson(backendUrl, token, timeoutMs, EDIT_PATH, {
            path: p.path,
            edits: p.edits,
            baseVersion,
          })
          if (!result.ok) throw new Error(conflictText(result))
          lastReadVersion.set(p.path, result.version)
          return {
            content: [{ type: 'text', text: `已编辑 ${result.path}（v${result.version}，${p.edits.length} 处）` }],
            details: undefined,
          }
        })
      },
    })

    registered = true
    log('INFO', '工作区中介已启用：已覆盖 read / write / edit（版本 CAS）')
  })
}

// ───────────────────────────── 代理调用 ─────────────────────────────

async function postJson(
  backendUrl: string,
  token: string,
  timeoutMs: number,
  path: string,
  body: Record<string, unknown>,
): Promise<WorkspaceProxyResult> {
  let response: Response
  try {
    response = await fetch(endpoint(backendUrl, path), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`工作区代理不可达：${describeError(error)}`, { cause: error })
  }
  if (!response.ok) throw new Error(await describeFailure(response))
  const parsed = (await response.json()) as Partial<WorkspaceProxyResult>
  if (typeof parsed.ok !== 'boolean') throw new Error('工作区代理响应形状不对（缺 ok）')
  return parsed as WorkspaceProxyResult
}

/** 取写文件要带的 `baseVersion`：优先用上次读到的；没有就先读一次（拿到最新版本） */
async function resolveBaseVersion(
  backendUrl: string,
  token: string,
  timeoutMs: number,
  path: string,
  known: Map<string, number>,
): Promise<number | undefined> {
  const cached = known.get(path)
  if (cached !== undefined) return cached
  const read = await postJson(backendUrl, token, timeoutMs, READ_PATH, { path })
  if (read.ok) {
    known.set(path, read.version)
    return read.version
  }
  // 文件还不存在（NOT_FOUND / VALIDATION）⇒ baseVersion=0（新建）
  return 0
}

/** 把"冲突 / 失败"讲成模型能照着做的一句话（§五 5：写被挡下并被告知） */
function conflictText(result: Extract<WorkspaceProxyResult, { ok: false }>): string {
  if (result.code === 'CONFLICT') {
    const v = result.currentVersion === undefined ? '' : `（当前 v${result.currentVersion}）`
    return `文件已被修改${v}，请重新读取后再写。${result.message}`
  }
  return result.message
}

/**
 * `edit` 的入参兼容 shim（照抄 pin `0.87.1` 内置 `edit#prepareEditArguments` 的口径，R8 复核）。
 *
 * ⚠️ 它在 **schema 校验之前**跑、必须返回一个符合 `parameters` 的对象（`{path, edits:[…]}`）。
 *   把四种"模型习惯写法"都归一成 `edits: [{oldText,newText}]`：
 *     ① `edits` 被序列化成 JSON 字符串（部分模型会这样）；
 *     ② `edits` 传成单个 `{oldText,newText}` 对象；
 *     ③ 旧的 `old_string`/`new_string`（+ `replace_all`）形态；
 *     ④ `oldText`/`newText` 直接在 `edits` 数组元素里（正常形态，无需处理）。
 */
function prepareEditArguments(input: unknown): { path?: unknown; edits?: WorkspaceEdit[] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const args = { ...(input as Record<string, unknown>) }

  const asSingleEdit = (value: unknown): WorkspaceEdit | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const v = value as Record<string, unknown>
    return typeof v.oldText === 'string' && typeof v.newText === 'string'
      ? { oldText: v.oldText, newText: v.newText }
      : undefined
  }

  if (typeof args.edits === 'string') {
    try {
      const parsed: unknown = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
      else {
        const single = asSingleEdit(parsed)
        if (single !== undefined) args.edits = [single]
      }
    } catch {
      // 解析不了就原样留着，交给 schema 校验去报错（不在这里吞掉成一次静默成功）
    }
  } else {
    const single = asSingleEdit(args.edits)
    if (single !== undefined) args.edits = [single]
  }

  const edits: WorkspaceEdit[] = Array.isArray(args.edits) ? [...(args.edits as WorkspaceEdit[])] : []
  const legacyOld = typeof args.old_string === 'string' ? args.old_string : undefined
  const legacyNew = typeof args.new_string === 'string' ? args.new_string : undefined
  if (legacyOld !== undefined && legacyNew !== undefined) {
    edits.push({ oldText: legacyOld, newText: legacyNew })
    delete args.old_string
    delete args.new_string
    delete args.replace_all
  }
  if (edits.length > 0) args.edits = edits
  return args as { path?: unknown; edits?: WorkspaceEdit[] }
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** 每路径串行（read-modify-write 不许交错；本地实现，见文件头） */
async function withPathQueue<T>(chains: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  let settle!: () => void
  const next = new Promise<void>((resolve) => {
    settle = resolve
  })
  chains.set(key, next)
  try {
    await previous.catch(() => undefined)
    return await task()
  } finally {
    settle()
    if (chains.get(key) === next) chains.delete(key)
  }
}

/** 按行切片（`offset` 1 起；给 read 的 `offset`/`limit` 一个本地实现） */
function sliceLines(text: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return text
  const lines = text.split('\n')
  const start = offset === undefined || offset <= 1 ? 0 : offset - 1
  const end = limit === undefined ? lines.length : start + limit
  return lines.slice(start, end).join('\n')
}

function endpoint(base: string, path: string): string {
  return base.endsWith('/') ? `${base.slice(0, -1)}${path}` : `${base}${path}`
}

async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } }
    const message = typeof body.error?.message === 'string' ? body.error.message : undefined
    if (message !== undefined) return `工作区代理拒绝了这次请求（HTTP ${response.status}）：${message}`
  } catch {
    // 非 JSON ⇒ 落到下面
  }
  return `工作区代理返回了 HTTP ${response.status}`
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '等待工作区代理响应超时'
    return error.message
  }
  return String(error)
}

function readEnv(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function readProxyTimeoutMs(): number {
  const raw = readEnv(PROXY_TIMEOUT_ENV)
  if (raw === undefined) return DEFAULT_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${level} ${message}\n`)
}