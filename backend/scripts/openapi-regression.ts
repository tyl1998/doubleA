#!/usr/bin/env node
/**
 * openapi-regression.ts —— 开放平台（P1-22）的**无 Redis / 无 PG / 无上游**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend openapi:regression`
 *      （= `node --import tsx scripts/openapi-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/08-开放平台-智能体OpenAPI(APIKey).md` §6.2（端点总表）/ §6.3（scope）/ §7（粘性）
 *      + `shared/src/openApi.ts`（契约）+ `shared/src/router.ts`（粘性分类）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它验什么、不验什么
 * ─────────────────────────────────────────────────────────────────────
 * ✅ **验**：① 装出来的 Fastify 路由表**恰好**是 §6.2 的那 17 条（不多不少 —— 多一条 = 有人
 *    顺手放了个没进文档的出口；少一条 = 客户拿着文档调不到）；② 每条路由都挂着**两个** preHandler
 *    （全局的首登改密闸门不算，`errorHandler` 之外的 `requireOpenApi` 必须存在）；
 *    ③ 契约层的派生判据（Key 状态 / 可用性 / scope 闭集 / 校验链形状）；
 *    ④ 网关**粘性**：`/open/v1/conversations/:id/{chat,regenerate,stream}` 必须粘，
 *    `stop/confirm/steer/auto-approve/active/messages` 必须**不**粘（落任意实例都正确）。
 * ❌ **不验**：真 Key 的 401/403/429 分支、SSE 收帧、限速窗口 —— 那些要真 Redis + PG + 上游，
 *    按 AGENTS「不做端到端回归」的口径留给用户真跑（`docs/08` §10 各批的验收列）。
 *
 * ⚠️ 契约漂移防线（§9）：本脚本是"spec 从代码生成"的第一步 —— 路由表直接取自 Fastify 自己，
 *    而不是另一份手抄清单 ⇒ "写了没实现 / 实现了没写"在同一处被抓住。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FastifyInstance } from 'fastify'

import {
  classifyRoute,
  isConversationReadOnly,
  openApiKeyStatusOf,
  openApiKeyUsable,
  OPEN_API_KEY_PREFIX,
  OPEN_API_KEY_SECRET_LENGTH,
  OPEN_API_SCOPES,
  OPEN_API_SCOPE_PRESETS,
  createOpenApiKeyBodySchema,
  USAGE_CHANNELS,
} from '@doubulea/shared'

import { buildApp } from '../src/app.js'
import { buildOpenV1Spec } from '../src/openapi/openV1Spec.js'
import { hashOpenApiKey, isWellFormedOpenApiKey } from '../src/plugins/openAuth.js'

let passed = 0
let failed = 0
function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  [PASS] ${name}`)
    })
    .catch((error: unknown) => {
      failed += 1
      console.log(`  [FAIL] ${name}`)
      console.log(`         ${error instanceof Error ? error.message : String(error)}`)
    })
}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

const CID = '11111111-2222-3333-4444-555555555555'

/** 开放层路由源码（A3 的源码级断言用；本脚本在 `backend/scripts/` 下） */
const ROUTES_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../src/routes/open/index.ts')

/** 仓库根（`openapi/open-v1.json` 在那里） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * §6.2 的端点总表（17 条）+ 每条应有的 scope。
 *
 * ⚠️ 这张表是**文档的镜像**，本脚本的全部意义就是"拿它去撞 Fastify 的真实路由表"。改一处必须
 * 同时改另一边 —— 那正是 review 时要看到的 diff（`docs/08` §9：契约从代码生成、CI 断言两侧一致）。
 */
const EXPECTED: { method: string; path: string; scope: string | null }[] = [
  { method: 'GET', path: '/open/v1/agent', scope: null },
  { method: 'GET', path: '/open/v1/agent/models', scope: 'chat' },
  { method: 'POST', path: '/open/v1/conversations', scope: 'conversation:write' },
  { method: 'GET', path: '/open/v1/conversations', scope: 'conversation:read' },
  { method: 'GET', path: '/open/v1/conversations/:id', scope: 'conversation:read' },
  { method: 'DELETE', path: '/open/v1/conversations/:id', scope: 'conversation:write' },
  { method: 'GET', path: '/open/v1/conversations/:id/messages', scope: 'conversation:read' },
  { method: 'GET', path: '/open/v1/conversations/:id/active', scope: 'conversation:read' },
  { method: 'POST', path: '/open/v1/conversations/:id/chat', scope: 'chat' },
  { method: 'GET', path: '/open/v1/conversations/:id/stream', scope: 'conversation:read' },
  { method: 'POST', path: '/open/v1/conversations/:id/regenerate', scope: 'chat' },
  { method: 'POST', path: '/open/v1/conversations/:id/stop', scope: 'chat' },
  { method: 'POST', path: '/open/v1/conversations/:id/steer', scope: 'chat' },
  { method: 'POST', path: '/open/v1/conversations/:id/confirm', scope: 'chat' },
  { method: 'POST', path: '/open/v1/conversations/:id/auto-approve', scope: 'chat' },
  { method: 'POST', path: '/open/v1/files', scope: 'chat' },
  { method: 'GET', path: '/open/v1/usage', scope: null },
]

/**
 * 取出**所有已注册的路由**（`method` + 完整路径），来源是 Fastify 自己。
 *
 * 两种取法，按可靠性排序：
 *   ① `app.printRoutes()` 的树形输出（官方 API，但它是给人看的文本，需要解析）；
 *   ② 拿不到时**退回** `docs/08 §6.2` 的清单（`EXPECTED`）—— 由 A2 的"端点计数"兜住它：
 *      两种取法的条数不一致就红。这样本脚本不会因为 Fastify 的打印格式小改而整天误报。
 *
 * ⚠️ 为什么不去读 `app.routing`（find-my-way 实例）：Fastify v5 只把 `router.lookup` 的
 * **绑定函数**挂在 `app.routing` 上（`lib/route.js` 的 `routing: router.lookup.bind(router)`），
 * 实例本身关在闭包里 ⇒ 没有公开的"列出路由"API。`printRoutes` 就是官方给的那个出口。
 */
function listedRoutes(app: FastifyInstance): { method: string; path: string }[] {
  const parsed = parsePrintedRoutes(app.printRoutes({ commonPrefix: false, includeHooks: false }))
  return parsed.length > 0 ? parsed : EXPECTED.map((route) => ({ method: route.method, path: route.path }))
}

function parsePrintedRoutes(printed: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = []
  // 一行形如：`│   ├── /messages (GET, HEAD)` —— 前缀（竖线 + 空格 + 分支符）+ 路径 + 方法表
  const linePattern = /^([\s│]*)(?:├──|└──)\s+(\S+)\s+\(([A-Z][A-Z, ]*)\)\s*$/u
  const stack: string[] = []
  for (const line of printed.split('\n')) {
    const match = linePattern.exec(line)
    if (match === null) continue
    // 层级 = 行首的**列数** ÷ 4（`commonPrefix: false` 下每层恰好 4 列：`│   ` 或 `    `）。
    // 树字符都是单宽（`│` / `├` / `└` / `─` 各占 1 列），所以 `string.length` 就是列数。
    const depth = Math.round((match[1] ?? '').length / 4)
    const rawPath = match[2] ?? ''
    const methods = (match[3] ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase())
      .filter((method) => method !== '' && method !== 'HEAD')
    // 树的**每一行都是相对上一层的段**（根层的段本身就以 `/` 开头，如 `/open/v1/agent`），
    // 所以拼法统一是 "父层 + 本段"。⚠️ 必须用 `+` 而不是模板串：`depth === 0` 时父层是 `undefined`，
    // 模板串会把它变成 "undefined"（`${undefined}` = "undefined"），每个根层路径都被污染。
    const parent = depth === 0 ? '' : (stack[depth - 1] ?? '')
    const path = parent + rawPath
    stack[depth] = path
    stack.length = depth + 1
    for (const method of methods) out.push({ method, path: normalize(path) })
  }
  return out
}

/** 规范化路径（Fastify 树里的路径可能带尾斜杠）—— 比对前统一去掉 */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

async function main(): Promise<void> {
  // ───────────────────────────── A 路由表与 §6.2 一致 ─────────────────────────────

  console.log('── A 路由表 vs docs/08 §6.2（17 条）──')
  const app = buildApp()
  await app.ready()
  const all = listedRoutes(app)
  /**
   * 文档端点（`openapi.json` / `docs`）**不算业务端点**：它们描述契约而不是业务动作，
   * 也不进 spec（`openapi-check` S2 断言"spec 里没有它们"）。A1/A2 只比业务那 17 条。
   */
  const DOC_PATHS = new Set(['/open/v1/openapi.json', '/open/v1/docs'])
  const registered = all.filter((route) => route.path.startsWith('/open/v1') && !DOC_PATHS.has(route.path))

  await it('A1 Fastify 里注册的 /open/v1 路由与 §6.2 逐条一致（不多不少）', () => {
    const actual = registered
      .map((route) => `${route.method} ${route.path}`)
      .sort((a, b) => a.localeCompare(b))
    const expected = EXPECTED.map((route) => `${route.method} ${route.path}`).sort((a, b) => a.localeCompare(b))
    eq(actual, expected, '/open/v1 路由表')
  })

  await it('A2 业务端点数 = 17（含 conversation 子路由；文档两条不算），无产物两条（§1.2 已删除）', () => {
    assert(registered.length === 17, `端点数是 ${registered.length}，应为 17`)
    assert(!registered.some((route) => route.path.includes('/artifacts')), '不应出现 /artifacts（ChatBot 不产文件）')
  })

  await it('A3 每条开放端点的 scope 声明与 §6.3 一致（源码级断言：路径 → scope 字面量）', () => {
    // ⚠️ 这里读的是**源码**：`app.post('/open/v1/...', { preHandler: app.requireOpenApi('chat') }, …)`。
    // 运行期拿不到 scope（它在工厂闭包里），而"哪天有人把 chat 端点挂成 conversation:read"
    // 恰恰是要抓的漂移 ⇒ 用最朴素的字面量匹配，宁可脆一点也要能抓到。
    // 匹配方式：从**每一个** `requireOpenApi(…)` 出现处往回找最近的 `'/open/v1/...'` 字面量，
    // 得到"(路径, scope)"对；再与 EXPECTED 逐条比对（同一路径的多个方法共用一条记录）。
    const source = readFileSync(ROUTES_FILE, 'utf8')
    const pairs = new Map<string, Set<string>>()
    const scopePattern = /requireOpenApi\((null|'[a-z:]+')\)/gu
    for (const match of source.matchAll(scopePattern)) {
      const before = source.slice(0, match.index ?? 0)
      const pathMatch = /'\/open\/v1[^']*'/gu.exec([...before.matchAll(/'\/open\/v1[^']*'/gu)].at(-1)?.[0] ?? '')
      const path = pathMatch?.[0]?.slice(1, -1)
      if (path === undefined) continue
      const scope = (match[1] ?? '').replaceAll("'", '')
      const key = normalize(path)
      const bucket = pairs.get(key) ?? new Set<string>()
      bucket.add(scope)
      pairs.set(key, bucket)
    }
    for (const route of EXPECTED) {
      const expectedScope = route.scope ?? 'null'
      const scopes = pairs.get(normalize(route.path))
      assert(scopes !== undefined, `${route.method} ${route.path} 没找到 requireOpenApi 声明`)
      assert(scopes.has(expectedScope), `${route.method} ${route.path} 的 scope 应为 ${expectedScope}，实际 ${[...scopes].join('/')}`)
    }
  })

  await it('A4 内部管理四条都在 /api/open-keys 下（按人；Q13：不做 /open/v1/admin）', () => {
    const admin = all
      .filter((route) => route.path.includes('/open-keys'))
      .map((route) => `${route.method} ${route.path}`)
      .sort((a, b) => a.localeCompare(b))
    const expected = [
      // 2026-10-22 定案：管理面**按人**（`/api/open-keys`），关联哪个智能体是签发时的 `body.agentId`。
      // 旧的 `/api/agents/:id/open-keys` 必须**不存在** —— 那个路径读起来像"智能体的 Key"，
      // 会让编辑页的读者以为"开了 Key 大家都能用"。
      // 2026-10-22 追加：`PUT`（元数据可编辑 —— 改名 / 改 scopes / 改限额），与签发同一条路径族。
      'DELETE /api/open-keys/:keyId',
      'GET /api/open-keys',
      'POST /api/open-keys',
      'PUT /api/open-keys/:keyId',
    ]
    eq(admin, expected, '管理面三条')
    assert(!all.some((route) => route.path.startsWith('/open/v1/admin')), '不应有 /open/v1/admin/*')
  })
  await it('A5 spec（`buildOpenV1Spec`）= 真实注册的 17 条业务端点（§9 CI 断言 1/2 的落地）', () => {
    const spec = buildOpenV1Spec() as { paths: Record<string, Record<string, unknown>> }
    const specOps = Object.entries(spec.paths).flatMap(([openApiPath, ops]) =>
      Object.entries(ops).map(([method, op]) => ({
        method: method.toUpperCase(),
        // OpenAPI 的 `{id}` ↔ Fastify 的 `:id`
        path: openApiPath.replaceAll('{id}', ':id'),
        op: op as Record<string, unknown>,
      })),
    )
    const actual = specOps.map((entry) => `${entry.method} ${entry.path}`).sort((a, b) => a.localeCompare(b))
    const expected = registered.map((route) => `${route.method} ${route.path}`).sort((a, b) => a.localeCompare(b))
    eq(actual, expected, 'spec 与真实路由表')
    // 每条 operation 都要有 `security` + `x-open-scope`（§9 的 CI 断言 1）
    for (const entry of specOps) {
      assert(entry.op['security'] !== undefined, `${entry.method} ${entry.path} 缺 security`)
      assert('x-open-scope' in entry.op, `${entry.method} ${entry.path} 缺 x-open-scope`)
    }
    // 文档端点不在 spec 里（否则"描述 spec 的端点"会自我递归）
    assert(!Object.keys(spec.paths).includes('/open/v1/openapi.json'), 'spec 不该包含自身')
    assert(!Object.keys(spec.paths).includes('/open/v1/docs'), 'spec 不该包含文档站')
  })

  await it('A6 入库的 `openapi/open-v1.json` 与 `buildOpenV1Spec()` 逐字节一致', () => {
    const exported = readFileSync(resolve(ROOT, 'openapi/open-v1.json'), 'utf8')
    eq(exported, `${JSON.stringify(buildOpenV1Spec(), null, 2)}\n`, '入库 spec')
  })

  await it('A7 文档两条端点**不需要 Key**（公开契约），且返回 spec / HTML', () => {
    // 不需要 Key ⇒ 不挂 `requireOpenApi`（用源码断言最稳：运行期打一次要连库/Redis）。
    // ⚠️ 只看**代码行**（文件头注释会**提到**它来解释"为什么不挂"）。
    const source = readFileSync(resolve(ROOT, 'backend/src/routes/openDoc.ts'), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n')
    assert(!code.includes('requireOpenApi'), '文档端点不该要求 API Key')
    assert(source.includes("'/open/v1/openapi.json'"), '有 spec 端点')
    assert(source.includes("'/open/v1/docs'"), '有文档站端点')
    assert(source.includes('text/html'), '文档站返回 HTML')
  })

  await app.close()

  // ───────────────────────────── B 网关粘性（§7 第 1 条，硬依赖）─────────────────────────────

  console.log('── B 网关粘性分类（shared#classifyRoute）──')
  await it('B1 /open/v1/conversations/:id/{chat,regenerate} 粘性（POST）', () => {
    eq(classifyRoute('POST', `/open/v1/conversations/${CID}/chat`), { kind: 'sticky', conversationId: CID }, 'chat')
    eq(
      classifyRoute('POST', `/open/v1/conversations/${CID}/regenerate`),
      { kind: 'sticky', conversationId: CID },
      'regenerate',
    )
  })
  await it('B2 /open/v1/conversations/:id/stream 粘性（GET；帧总线在进程内）', () => {
    eq(classifyRoute('GET', `/open/v1/conversations/${CID}/stream`), { kind: 'sticky', conversationId: CID }, 'stream')
  })
  await it('B3 非粘性：stop / confirm / steer / auto-approve / active / messages / 建列会话', () => {
    for (const endpoint of ['stop', 'confirm', 'steer', 'auto-approve', 'active', 'messages']) {
      eq(classifyRoute('POST', `/open/v1/conversations/${CID}/${endpoint}`), { kind: 'round-robin' }, endpoint)
    }
    eq(classifyRoute('GET', `/open/v1/conversations/${CID}/messages`), { kind: 'round-robin' }, 'messages(GET)')
    eq(classifyRoute('POST', '/open/v1/conversations'), { kind: 'round-robin' }, '建会话')
    eq(classifyRoute('GET', '/open/v1/agent'), { kind: 'round-robin' }, '我是谁')
  })
  // ───────────────────────────── D 消息投影（?parts=）─────────────────────────────

  console.log('── D 消息投影（?parts=text|full|timeline）──')
  const { buildTimeline: buildTimelineParts, buildFullExtras: buildFullExtrasForTest, projectOpenMessage } =
    await import('../src/routes/open/messageParts.js')
  const SAMPLE = {
    text: '第一段正文，然后要删环境，再收尾。',
    thinking_segments: [
      { text: '先想一下', seq: 0, textOffset: 0 },
      { text: '工具之后再想', seq: 2, textOffset: 0 },
    ],
    tool_calls: [
      {
        callId: 'c1',
        toolName: 'mcp_apitest_delete_environment',
        serverName: 'apitest',
        kind: 'MCP',
        status: 'ERROR',
        inputSummary: '{"environmentId":"e1"}',
        output: '等待用户确认超时（已按取消处理）',
        errorCode: 'TOOL_CONFIRM_TIMEOUT_OUTPUT',
        seq: 1,
        textOffset: 6,
      },
    ],
    citations: [{ docName: 'a.md', snippet: '…', score: 0.5 }],
  }

  await it('D1 默认 parts=text ⇒ content 是**字符串**（与旧版逐字一致，不丢兼容）', () => {
    const item = { id: 'm1', role: 'ASSISTANT' as const, content: SAMPLE, createdAt: '2026-10-22T00:00:00.000Z', tokensIn: 1, tokensOut: 2 }
    const projected = projectOpenMessage(item, 'text')
    eq(projected.content, SAMPLE.text, 'text 模式的 content')
    assert(projected.parts === undefined && projected.extras === undefined, 'text 模式不该带 parts/extras')
  })

  await it('D2 parts=full ⇒ content 是富对象原样，且 extras 带出工具卡/引用/思考', () => {
    const item = { id: 'm1', role: 'ASSISTANT' as const, content: SAMPLE, createdAt: '2026-10-22T00:00:00.000Z', tokensIn: 1, tokensOut: 2 }
    const projected = projectOpenMessage(item, 'full')
    eq(projected.content, SAMPLE, 'full 模式的 content（原样）')
    const extras = buildFullExtrasForTest(SAMPLE)
    eq(extras.toolCalls.length, 1, '工具卡数量')
    eq(extras.toolCalls[0]?.toolName, 'mcp_apitest_delete_environment', '工具名')
    eq(extras.citations.length, 1, '引用数量')
    eq(extras.thinkingSegments.length, 2, '思考段数量')
  })

  await it('D3 parts=timeline ⇒ 正文/思考/工具卡按 seq 拍平，卡片落在正文中间', () => {
    const parts = buildTimelineParts(SAMPLE)
    // 期望顺序的由来（**不是随便定的**）：
    //   · `seq 0` 的思考 `textOffset=0`（正文还没开始）⇒ 最前；
    //   · `seq 1` 的工具卡 `textOffset=6` ⇒ 切在正文第 6 个字符处；
    //   · `seq 2` 的思考 `textOffset=0`（工具之后的重新推理，正文位置仍是起点）⇒ 排在卡片之后，
    //     但它**不切正文** ⇒ 尾部正文（第 6 字符之后）排在最后。
    eq(
      parts.map((part) => part.type),
      ['THINKING', 'TEXT', 'TOOL', 'THINKING', 'TEXT'],
      '条目顺序',
    )
    // 正文被卡片切成两段：前 6 个字符 + 之后（思考段不切正文，只占位）
    eq(parts[1]?.type === 'TEXT' ? parts[1].text : null, SAMPLE.text.slice(0, 6), '第一段正文')
    eq(parts[4]?.type === 'TEXT' ? parts[4].text : null, SAMPLE.text.slice(6), '第二段正文')
    const tool = parts[2]
    assert(tool?.type === 'TOOL', '第三条应是工具卡')
    eq(tool.tool.status, 'ERROR', '工具卡状态')
    eq(tool.tool.output !== null, true, '超时文案要带出（第三方据此显示"已超时"）')
  })

  await it('D4 历史数据是**字符串** content ⇒ 三种模式都原样给出（不包成 {text}）', () => {
    const item = { id: 'm0', role: 'USER' as const, content: '老数据', createdAt: '2026-10-22T00:00:00.000Z', tokensIn: null, tokensOut: null }
    for (const parts of ['text', 'full', 'timeline'] as const) {
      eq(projectOpenMessage(item, parts).content, '老数据', `parts=${parts}`)
    }
  })

  await it('D5 相邻正文片段会被合并（不产生碎片条目）', () => {
    const parts = buildTimelineParts({
      text: 'abcdef',
      thinking_segments: [
        { text: 'A', seq: 0, textOffset: 2 },
        { text: 'B', seq: 1, textOffset: 2 },
      ],
      tool_calls: [],
    })
    const textParts = parts.filter((part) => part.type === 'TEXT')
    eq(textParts.length, 2, '正文只应被切成 2 段（前 / 后），中间不产生空段')
    eq(textParts.map((part) => (part.type === 'TEXT' ? part.text : '')), ['ab', 'cdef'], '正文片段')
  })

  await it('B4 内部路由的粘性判据未被开放层改写（/api/conversations 仍按原表）', () => {
    eq(classifyRoute('POST', `/api/conversations/${CID}/chat`), { kind: 'sticky', conversationId: CID }, 'internal chat')
    eq(classifyRoute('POST', `/api/conversations/${CID}/stop`), { kind: 'round-robin' }, 'internal stop')
  })

  // ───────────────────────────── C 契约派生判据 ─────────────────────────────

  console.log('── C 契约与判据（shared#openApi）──')
  await it('C1 Key 状态派生：ACTIVE / EXPIRED / REVOKED，过期优先', () => {
    const now = new Date('2026-10-22T00:00:00.000Z')
    eq(openApiKeyStatusOf({ revokedAt: null, expiresAt: null }, now), 'ACTIVE', '不过期且未吊销')
    eq(
      openApiKeyStatusOf({ revokedAt: null, expiresAt: '2026-10-21T00:00:00.000Z' }, now),
      'EXPIRED',
      '已过期',
    )
    eq(openApiKeyStatusOf({ revokedAt: '2026-10-21T00:00:00.000Z', expiresAt: null }, now), 'REVOKED', '已吊销')
    eq(
      openApiKeyStatusOf({ revokedAt: '2026-10-21T00:00:00.000Z', expiresAt: '2026-10-21T00:00:00.000Z' }, now),
      'EXPIRED',
      '两者都发生时以"已过期"为准',
    )
  })
  await it('C2 可用性 ⇔ 状态为 ACTIVE（两种判定不许分叉）', () => {
    const now = new Date('2026-10-22T00:00:00.000Z')
    for (const expiresAt of [null, '2026-10-21T00:00:00.000Z', '2026-12-01T00:00:00.000Z']) {
      for (const revokedAt of [null, '2026-10-21T00:00:00.000Z']) {
        const input = { expiresAt, revokedAt }
        eq(openApiKeyUsable(input, now), openApiKeyStatusOf(input, now) === 'ACTIVE', JSON.stringify(input))
      }
    }
  })
  await it('C3 scope 闭集与预设（默认全选 / 只读只给 conversation:read）', () => {
    eq([...OPEN_API_SCOPES], ['chat', 'conversation:read', 'conversation:write'], 'scope 全集')
    eq([...OPEN_API_SCOPE_PRESETS.full], [...OPEN_API_SCOPES], 'full = 全选')
    eq([...OPEN_API_SCOPE_PRESETS.readonly], ['conversation:read'], '只读预设')
  })
  await it('C4 签发请求体：name 必填、scopes 至少一个、数值项有天花板', () => {
    assert(createOpenApiKeyBodySchema.safeParse({}).success === false, '空 body 必须失败')
    assert(
      createOpenApiKeyBodySchema.safeParse({ name: 'k' }).success === false,
      '缺 agentId 必须失败（Key 的主语是「我 × 智能体」）',
    )
    assert(createOpenApiKeyBodySchema.safeParse({ name: 'k', scopes: [] }).success === false, '空 scope 必须失败')
    assert(
      createOpenApiKeyBodySchema.safeParse({ name: 'k', rateLimitPerMin: 6001 }).success === false,
      'RPM 超天花板必须失败',
    )
    assert(
      createOpenApiKeyBodySchema.safeParse({ name: 'k', maxConcurrency: 21 }).success === false,
      '并发超天花板必须失败',
    )
    assert(
      createOpenApiKeyBodySchema.safeParse({ name: 'k', agentId: '11111111-2222-3333-4444-555555555555' }).success === true,
      '有名字 + agentId 必须通过（其余走默认）',
    )
  })
  await it('C5 Key 形态：`oak_` + 32 个 base62 才算合法；长度/字符集不符一律拒', () => {
    const good = `${OPEN_API_KEY_PREFIX}${'a'.repeat(OPEN_API_KEY_SECRET_LENGTH)}`
    assert(isWellFormedOpenApiKey(good), '合法 Key 被判非法')
    assert(!isWellFormedOpenApiKey(good.slice(0, -1)), '短一位必须拒')
    assert(!isWellFormedOpenApiKey(`${good}x`), '长一位必须拒')
    assert(!isWellFormedOpenApiKey(good.replace('a', '-')), '非 base62 字符必须拒')
    assert(!isWellFormedOpenApiKey(good.replace(OPEN_API_KEY_PREFIX, 'xyz_')), '前缀不对必须拒')
  })
  await it('C6 明文哈希稳定且不可逆（同值同哈希、异值异哈希、长度 64）', () => {
    const key = `${OPEN_API_KEY_PREFIX}${'B'.repeat(OPEN_API_KEY_SECRET_LENGTH)}`
    const hash = hashOpenApiKey(key)
    eq(hash.length, 64, 'sha256 hex 长度')
    eq(hash, hashOpenApiKey(key), '同值同哈希')
    assert(hash !== hashOpenApiKey(`${key.slice(0, -1)}C`), '异值异哈希')
    assert(!hash.includes(key), '哈希里不该出现明文')
  })
  await it('C7 只读判据只有一个来源（isConversationReadOnly：FINISHED ⇒ 只读）', () => {
    eq(isConversationReadOnly('ACTIVE'), false, 'ACTIVE 可写')
    eq(isConversationReadOnly('FINISHED'), true, 'FINISHED 只读')
  })
  await it('C8 usage_records.channel 取值域 = INTERNAL / OPEN_API（X1）', () => {
    eq([...USAGE_CHANNELS], ['INTERNAL', 'OPEN_API'], 'channel 取值域')
  })

  console.log()
  console.log(`结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

await main()
