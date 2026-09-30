/**
 * 沙箱 MCP 工具清单的**别名映射**（P0-3-9b）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §七 4（工具清单下发与命名 + **唯一反查点**）
 *      + §七 3 ②（per-container token）+ §七 6 ②（"只能调这个 agent 绑定的 server"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一层是什么：`alias ⇄ serverId` 的一张表，**且只有一处能回答它**
 * ─────────────────────────────────────────────────────────────────────
 * 容器里的引擎看到的名字是**后端改过的**：`mcp_<alias>_<toolName>`，`alias` 由后端按会话内序号
 * 分配（`s1` / `s2` …）。于是"卡片上的这一条属于哪个 server"必须靠**这张表**回答：
 *
 *   · **写入方向**：`proxy.ts#buildSandboxMcpCatalog()` 算出来 → {@link writeSandboxMcpCatalog}；
 *   · **读取方向**：`map.ts` 的映射器（反查填 `tool_call.serverId`）与代理端点（alias → serverId）；
 *   · **清理方向**：容器回收时 {@link clearSandboxMcpMap}。
 *
 * ⚠️⚠️ **不要靠"工具名 slug"反推 server**（§七 4 点名的坑）：`slug` **刻意不唯一**
 * （`shared/src/mcp.ts` 文件头 ③：`mcp_servers.slug` 没有唯一约束、纯中文名还会整串折成
 * `server`）⇒ 反推会指错 server，而症状只是"卡片上显示的 server 名不对"，**不报错**。
 * `alias` 由本次会话分配、映射由后端持有，唯一且可随会话回滚。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件**不 import 数据库、不 import 编排层**（只有 Redis 的键助手与日志）
 * ─────────────────────────────────────────────────────────────────────
 * 这不是洁癖：`manager.ts`（生命周期）要调 {@link clearSandboxMcpMap}，而它不该因此把
 * 「SSE 通道 / MCP 客户端 / Prisma」整条链拖进来。同一个理由让 `spec.ts` / `queue.ts` 保持单薄。
 * **算清单**（要查库）在 `proxy.ts`；**存与取**在这里。
 */

import {
  MCP_TOOL_DESCRIPTION_MAX,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_NAME_PREFIX,
  type McpToolDescriptor,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { ensureRedisConnected, sandboxMcpMapKey, SANDBOX_MCP_MAP_TTL_SEC } from '../infra/redis.js'
import { toDescription } from '../mcp/toolSchema.js'

/** 一个绑定在 Agent 上的 server 在本会话里的别名 */
export interface SandboxMcpServerRef {
  /** `s1` / `s2` …（见 {@link sandboxMcpAliasAt}） */
  alias: string
  serverId: string
  /** 展示名 —— **卡片要用的就是它**（不是 slug，见文件头那段） */
  serverName: string
}

/** 一个已下发给容器的工具 */
export interface SandboxMcpToolRef {
  alias: string
  serverId: string
  serverName: string
  /** MCP 侧的**原始**工具名（`tools/call` 要原样回给它；卡片上也显示它） */
  toolName: string
  /**
   * MCP `Tool.annotations` —— **危险判定的输入**（`mcp/risk.ts#isDangerousTool`）。
   *
   * ⚠️ 它**只留在后端**、**不下发给容器**：判定是平台策略，容器侧知道"这个工具危不危险"
   * 只会诱使下一批在扩展里再判一次（§七 5 明确要求"两处各自调同一个纯函数"，而容器里
   * 根本没有那个纯函数）。
   */
  annotations: McpToolDescriptor['annotations']
  /** 给模型看的说明（`description` 回落 `title`，超长按码点截断 —— 与 ChatBot 路径同一份实现） */
  description: string
  /** 原样的 JSON Schema（容器侧据此给模型声明参数） */
  inputSchema: unknown
}

/**
 * 一项**平台内置工具**（不是 MCP：没有 server / 凭据 / 危险确认）。
 *
 * 当前只有「知识库」一族（`knowledge_search` / `list_knowledge`）。它们与 MCP 工具**同一次下发**
 * （同一个 `/api/sandbox/mcp/tools`），但**不写进 {@link SandboxMcpCatalog.tools}** ——
 * 那张表是「`mcp_<alias>_<tool>` → 哪台 server 的哪个工具」的反查表，塞进内置工具会让
 * `map.ts` 把它们当 MCP 卡（`kind:MCP` + 一个假的 `serverId`），而那不是它们。
 */
export interface SandboxBuiltinToolRef {
  /** 注册给引擎的名字（内置名**就是** `knowledge_search` / `list_knowledge`，不加 `mcp_` 前缀） */
  name: string
  description: string
  /** 原样的 JSON Schema（容器侧据此给模型声明参数） */
  inputSchema: unknown
}

/** 一次会话的工具清单 + 别名映射 */
export interface SandboxMcpCatalog {
  /** 参与本轮下发的 server（顺序 = 别名分配顺序） */
  servers: SandboxMcpServerRef[]
  /** **注册给引擎的名字**（`mcp_<alias>_<tool>`）→ 这个工具是谁 */
  tools: Record<string, SandboxMcpToolRef>
  /** 平台内置工具（知识库检索 / 目录）。**没有就是空数组**（绝大多数 Agent 不绑 KB） */
  builtins: SandboxBuiltinToolRef[]
}

/** 空清单（Agent 没绑任何 MCP server / 知识库 —— 这是最常见的一种） */
export function emptySandboxMcpCatalog(): SandboxMcpCatalog {
  return { servers: [], tools: {}, builtins: [] }
}

// ───────────────────────────── 纯函数：命名 ─────────────────────────────

/** 别名前缀（`s1` / `s2` …）。写成常量只为让"这个名字长什么样"只有一处 */
export const SANDBOX_MCP_ALIAS_PREFIX = 's'

/**
 * 第 `index`（0 起）个 server 的别名。
 *
 * 为什么是"序号"而不是"server 名派生"：`slug` 不唯一（见文件头）、`name` 可以重名且含中文，
 * 而序号的**确定性**只需要一个稳定的排序（`proxy.ts` 按 `(name, id)` 升序，与
 * `resolveMcpToolCatalog` 同一条口径）—— 于是"扩展拉的清单"与"编排层预热算的清单"
 * **必然一致**，不需要互相通气。
 */
export function sandboxMcpAliasAt(index: number): string {
  return `${SANDBOX_MCP_ALIAS_PREFIX}${index + 1}`
}

/** 非 `[A-Za-z0-9_-]` 折成 `_`（与 `mcp/toolSchema.ts#sanitizeToolName` 同口径，理由同） */
const TOOL_NAME_CHARS_RE = /[^A-Za-z0-9_-]/gu

/**
 * 注册给引擎的工具名：`mcp_<alias>_<toolName>`（清洗 + 截断 + 去重）。
 *
 * ⚠️ **必须清洗**：pi 的工具名与各家 provider 一样受字符集限制（`02` §9.7），而 MCP 的
 * `tool.name` 理论上可以是任意字符串。**折成 `_` 而不是删掉**：删除会让 `a.b` 与 `ab`
 * 变成同名（与 `toolSchema.ts` 的同一条取舍）。
 * ⚠️ **必须去重**：清洗本身会制造碰撞（`a.b` 与 `a-b` 都折成 `a_b`）⇒ 同一台 server 的两个
 * 不同工具会撞成一个名字，而症状是"后一个工具静默覆盖前一个"（模型永远调不到它）。
 * 去重手法与 `toolSchema.ts#disambiguate` 逐字同款：**先按后缀长度截短再拼序号**
 * （只截断不加序号 ⇒ 两个长名截断后撞在一起；只加序号不截短 ⇒ 后缀被截掉）。
 *
 * @param taken 本次会话已占用的注册名（跨 server 累积）；不给就不去重（纯函数便于逐条核查）
 */
export function registeredSandboxMcpToolName(
  alias: string,
  toolName: string,
  taken?: Iterable<string>,
): string {
  const base = `${MCP_TOOL_NAME_PREFIX}${alias}_${toolName.replace(TOOL_NAME_CHARS_RE, '_')}`.slice(
    0,
    MCP_TOOL_NAME_MAX,
  )
  const used = taken === undefined ? undefined : taken instanceof Set ? taken : new Set(taken)
  if (used === undefined || !used.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const head = base.slice(0, Math.max(1, MCP_TOOL_NAME_MAX - suffix.length)).replace(/-+$/u, '')
    const candidate = `${head}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * 引擎侧报上来的工具名 → 这个工具是谁；**不认识返回 `undefined`**。
 *
 * 这是 §七 4 那个"唯一反查点"的**纯函数形态**：`map.ts` 的映射器通过注入的 resolver 调它，
 * 代理端点也用同一条（先按 alias 找 server，再核对 `toolName` 确实下发过）。
 */
export function resolveSandboxMcpTool(
  catalog: SandboxMcpCatalog,
  engineToolName: string,
): SandboxMcpToolRef | undefined {
  // ⚠️ 用 `Object.prototype.hasOwnProperty` 而不是 `catalog.tools[name]` 直接取：
  //    工具名恒以 `mcp_` 开头（撞不上 `constructor` / `toString` 这类键），但展开成"取值"
  //    会让"不是工具名"的自由字符串也一路走到真值判断上 —— 显式判存在更便宜也更清楚。
  if (!Object.prototype.hasOwnProperty.call(catalog.tools, engineToolName)) return undefined
  return catalog.tools[engineToolName]
}

/** 由一张工具清单里的工具造描述（**唯一实现**：`mcp/toolSchema.ts#toDescription`，别在这里再写一份） */
export function sandboxMcpToolDescription(tool: McpToolDescriptor): string {
  return toDescription(tool)
}

/** 描述上限（导出只是为了让"截断到多少"这件事在别处可断言，值本身来自 `shared`） */
export const SANDBOX_MCP_DESCRIPTION_MAX = MCP_TOOL_DESCRIPTION_MAX

// ───────────────────────────── 存与取（Redis）─────────────────────────────

/**
 * 把清单写进 `sandbox.mcp:{conversationId}`（TTL 见 `SANDBOX_MCP_MAP_TTL_SEC`）。
 *
 * 写失败只 warn（**不抛**）：清单是"让卡片更好看 + 让代理端点能反查"的东西，而调用它的两条路
 * （扩展拉清单、编排层预热）都不该因为一次 Redis 抖动而整体失败 —— 拉清单失败的那一侧，
 * 扩展会**显式失败并记 stderr**（而不是装作"没有工具"，见扩展文件头）。
 */
export async function writeSandboxMcpCatalog(conversationId: string, catalog: SandboxMcpCatalog): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.set(
      sandboxMcpMapKey(conversationId),
      JSON.stringify(catalog),
      'EX',
      SANDBOX_MCP_MAP_TTL_SEC,
    )
  } catch (error) {
    getLogger().warn(
      { err: error, conversationId, serverCount: catalog.servers.length, toolCount: Object.keys(catalog.tools).length },
      '写入沙箱 MCP 别名映射失败（工具仍可用；卡片可能填不上 serverId）',
    )
  }
}

/**
 * 读回清单；**没有 / 读不出来一律 `null`**（= 当成"还没下发过"）。**永不抛错**。
 *
 * 三条降级口径（都是"宁可少填一个字段，也不要凭空造一个"）：
 *   · 键不存在（扩展还没拉过 / 已过期 / 已被回收清掉）⇒ `null`；
 *   · JSON 坏 ⇒ `null` + 删键（不清的话每次调用都要白解析一次，且永远等不到过期）；
 *   · 形状对不上（人工改过 Redis）⇒ `null`。
 *
 * ⚠️ **不逐条过滤**（与 `parseToolCache` 同一条理由）：这张表是**一次下发动作的快照**，
 * 留下半份只会让"某些工具反查得到、某些反查不到"，而那种不一致**没有任何报错**。
 */
export async function readSandboxMcpCatalog(conversationId: string): Promise<SandboxMcpCatalog | null> {
  const redis = await ensureRedisConnected()
  const key = sandboxMcpMapKey(conversationId)
  let raw: string | null
  try {
    raw = await redis.get(key)
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '读取沙箱 MCP 别名映射失败（本次按"没下发过"处理）')
    return null
  }
  if (raw === null) return null
  const catalog = parseCatalog(raw)
  if (catalog === null) {
    getLogger().warn({ conversationId }, '沙箱 MCP 别名映射的形状不对（人工改过 Redis？）⇒ 已删除该键')
    await clearSandboxMcpMap(conversationId)
    return null
  }
  return catalog
}

/**
 * 删掉某会话的清单（**回收时调**，见 `manager.ts#recycleSandbox`）。
 *
 * 幂等、失败只 warn —— 与 `revokeSandboxToken` 同款（调用点在回收路径上，
 * 那里每个清理动作的失败都只该留下一条 warn）。
 */
export async function clearSandboxMcpMap(conversationId: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.del(sandboxMcpMapKey(conversationId))
  } catch (error) {
    getLogger().warn({ err: error, conversationId }, '清除沙箱 MCP 别名映射失败（TTL 会兜底）')
  }
}

// ───────────────────────────── 内部：值的形状 ─────────────────────────────

/** 值 → 清单；读不出来返回 `null`（同 `parseTokenRecord` 的口径） */
function parseCatalog(raw: string): SandboxMcpCatalog | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { servers, tools, builtins } = parsed as { servers?: unknown; tools?: unknown; builtins?: unknown }
    if (!Array.isArray(servers)) return null
    if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) return null
    // `builtins` 是本批新增的字段：老值（本批之前写进 Redis 的）没有它 ⇒ 缺失按空数组（TTL 会兜底）

    const serverRefs: SandboxMcpServerRef[] = []
    for (const entry of servers) {
      if (typeof entry !== 'object' || entry === null) return null
      const { alias, serverId, serverName } = entry as Partial<SandboxMcpServerRef>
      if (typeof alias !== 'string' || alias === '') return null
      if (typeof serverId !== 'string' || serverId === '') return null
      if (typeof serverName !== 'string') return null
      serverRefs.push({ alias, serverId, serverName })
    }

    const toolRefs: Record<string, SandboxMcpToolRef> = {}
    for (const [name, entry] of Object.entries(tools as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) return null
      const { alias, serverId, serverName, toolName, annotations, description, inputSchema } =
        entry as Partial<SandboxMcpToolRef>
      if (typeof alias !== 'string' || alias === '') return null
      if (typeof serverId !== 'string' || serverId === '') return null
      if (typeof serverName !== 'string') return null
      if (typeof toolName !== 'string' || toolName === '') return null
      if (typeof description !== 'string') return null
      if (annotations !== null && (typeof annotations !== 'object' || Array.isArray(annotations))) return null
      toolRefs[name] = {
        alias,
        serverId,
        serverName,
        toolName,
        annotations: (annotations ?? null) as SandboxMcpToolRef['annotations'],
        description,
        inputSchema: inputSchema ?? null,
      }
    }

    const builtinRefs: SandboxBuiltinToolRef[] = []
    if (builtins !== undefined) {
      if (!Array.isArray(builtins)) return null
      for (const entry of builtins) {
        if (typeof entry !== 'object' || entry === null) return null
        const { name, description, inputSchema } = entry as Partial<SandboxBuiltinToolRef>
        if (typeof name !== 'string' || name === '') return null
        if (typeof description !== 'string') return null
        builtinRefs.push({ name, description, inputSchema: inputSchema ?? null })
      }
    }

    return { servers: serverRefs, tools: toolRefs, builtins: builtinRefs }
  } catch {
    return null
  }
}
