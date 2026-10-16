#!/usr/bin/env node
/**
 * verify-mcp-ui.mjs —— MCP 页面 + 确认卡 + 工具卡的前端**无依赖**验收（P0-2-11）
 *
 * 跑法：`pnpm verify:mcp-ui`
 *      （= `node --import tsx frontend/scripts/verify-mcp-ui.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险集中在几处**错了不会报错、只会看到一句假话或一个点不动的按钮**的地方：
 *   · **凭据表单的提交体**：它是"合并语义"的落点 —— 把整张表都提交一遍，用户只改一个 key 时
 *     其余空的输入框会以**空串**提交，而空串的语义是"清空该 key"⇒ **他什么都没做，值却没了**。
 *     这个错没有任何界面症状（保存成功、提示也对），只有另一个 key 悄悄失效；
 *   · **模板编辑器的校验**：前端自己再写一遍"HEADER 名不能撞保留头 / 同模板内不能重名"
 *     必然与后端各自演化 —— 症状是"本地放行、后端 400"，而两处文案还不一样；
 *   · **`0` 与"没拉过"**：工具数是 `0` 时显示 `0` 还是 `—`，决定了用户会不会去上游找一个
 *     并不存在的配置问题；
 *   · **`?serverId=` 的定位目标**：带了个不在清单里的 id（server 被删了 / 别人发的链接）
 *     时若不返回 `null`，页面会去找一个不存在的锚点 —— 用户点了"去配置凭据"、页面也跳了、
 *     就是**什么都不发生**；
 *   · **确认卡的倒计时**：读服务端给的 `expiresAt` 还是前端自己另起 120s，两边只要有一点差
 *     就变成"界面说还没到、服务端已按取消处理"⇒ 用户看到"我点了确认但什么都没发生"；
 *   · **工具卡的「去配置凭据」**：判据少一个条件（`serverId`）就会拼出 `?serverId=`（空值）
 *     的链接，症状同上。
 * 这些全是纯函数或"可注入依赖的判据"，所以本档直接喂字面量、手写夹具，逐条断言最终形状
 * —— 本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法（对照 `verify-knowledge-ui`）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · React 渲染与交互（表格长什么样、弹窗能不能关、滚动有没有真的发生）⇒ 归浏览器端测
 *     （`README`「浏览器端测 · MCP」，**这是阶段二唯一的浏览器端测点**）；
 *   · 真后端（注册的 400 文案、`PATCH` 的 `credentialSchemaImpact` 数值、`/:id/test` 的
 *     恒 200、`/:id/tools` 的 502 与"有缓存就 200"）⇒ 归 `README` 里那些**内联假上游**的
 *     命令行端测（`㉒` / `㉓`）；
 *   · 打包后的行为（本档跑的是**源码**，不经 vite）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一处**刻意不做**的事：本档不 import `api/mcp.ts`
 * ─────────────────────────────────────────────────────────────────────
 * 那个文件 import `@tanstack/react-query`（要 React 运行环境），在 node 里加载它会顺带把
 * 整个 react-query 拉进来。所以涉及它的断言走**源码级**（H 组），与
 * `verify-knowledge-ui` 对 `api/knowledgeBases.ts` 的手法一致（它也只 import `api/client.ts`）。
 * `api/client.ts` 那一处需要 `import.meta.env` 的钩子，本档照抄（**只为 H 组读源码**，
 * 仍注册着以便将来要用）。
 *
 * 断言脚手架与 `verify-knowledge-ui.mjs` 同款，**刻意各留一份**：验收脚本要能被单独拷出来跑
 * （共用 `_harness.mjs` 会让"跑这一档"变成"跑得动整个 scripts 目录"）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

const VITE_ENV_SHIM = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (url.endsWith('/api/client.ts') && result.source != null) {
    const source =
      typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: source.split('import.meta.env').join('({})'), shortCircuit: true }
  }
  return result
}
`
register(`data:text/javascript,${encodeURIComponent(VITE_ENV_SHIM)}`, import.meta.url)

// ───────────────────────────── 断言脚手架 ─────────────────────────────

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  y: useColor ? '\u001b[33m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0
let currentGroup = null
const groups = []

function groupStart(id, title, note) {
  currentGroup = { id, title, note, passed: 0, failed: 0 }
  groups.push(currentGroup)
  console.log(`\n${c.b}── ${id} ${title} ──${c.x}`)
  if (note !== undefined) console.log(`   ${c.d}${note}${c.x}`)
}

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    if (currentGroup !== null) currentGroup.passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    if (currentGroup !== null) currentGroup.failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

function assertExcludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && !haystack.includes(needle),
    `${label}：不该含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

/** 深比较**先规范化键序**再比（经 jsonb 往返的值键序会被 PG 重排，直比会出**假红**） */
function canonical(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

function assertDeepEqual(actual, expected, label) {
  assert(canonical(actual) === canonical(expected), `${label}：期望 ${canonical(expected)}，实际 ${canonical(actual)}`)
}

function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '')
}

// ───────────────────────────── 被测对象 ─────────────────────────────

const { MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES, CREDENTIAL_INJECT_LOCATIONS } = await import('@doubulea/shared')

const {
  appendTemplateRow,
  buildCreateServerBody,
  buildCredentialSubmitValues,
  buildServerUpdateBody,
  canAppendTemplateRow,
  credentialCell,
  credentialDraftsFromFields,
  credentialGroupAnchorId,
  credentialImpactHint,
  emptyServerFormDraft,
  formatToolCount,
  formLevelTemplateIssues,
  hasCredentialInput,
  keyIssueFor,
  missingAfterSubmit,
  removeTemplateRow,
  resolveScrollTarget,
  serverFormDraftFrom,
  serverStatusView,
  setCredentialDraftValue,
  sortCredentialGroups,
  templateRowIssues,
  templateRowLimit,
  templateRowsFromSchema,
  templateRowsToSchema,
  unconfiguredCount,
  updateTemplateRow,
  INJECT_LOCATIONS,
  INJECT_LOCATION_LABEL,
} = await import('../src/pages/mcp/mcpModel.ts')

const { confirmCountdownText, confirmAnsweredText, confirmIgnoredNote, confirmSourceHint, remainingSeconds } =
  await import('../src/features/chat/confirmModel.ts')

const { canConfigureCredential, errorCodeLabel, messageToView, toolErrorHint, toolViewFromEvent } = await import(
  '../src/features/chat/messageModel.ts'
)

// ───────────────────────────── 夹具 ─────────────────────────────

/** 一行模板草稿 */
function row(rowId, key, label, inject, extra = {}) {
  return { rowId, key, label, inject, required: false, placeholder: '', ...extra }
}

/** 一个 server（字段不全时用默认值补齐，形状与 `shared#mcpServerItemSchema` 一致） */
function makeServer(overrides = {}) {
  return {
    id: '11111111-1111-7111-8111-111111111111',
    name: 'git',
    slug: 'git',
    endpointUrl: 'https://mcp.internal/git',
    authType: 'NONE',
    credentialSchema: [],
    toolCount: 3,
    status: 'OK',
    createdBy: 'admin',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  }
}

/** 一个凭据模板行（服务端投影 `McpCredentialField`） */
function field(key, extra = {}) {
  return { key, label: key, inject: 'HEADER', required: false, hasValue: false, placeholder: null, ...extra }
}

/** 一个凭据条目（`McpCredentialItem`） */
function credItem(serverId, configured, extra = {}) {
  return {
    serverId,
    serverName: serverId.slice(0, 4),
    serverSlug: serverId.slice(0, 4),
    fields: [field('token', { required: true })],
    missingKeys: configured ? [] : ['token'],
    configured,
    updatedAt: configured ? '2026-09-24T10:00:00.000Z' : null,
    ...extra,
  }
}

// ═════════════════════════════ A 组：凭据表单（合并语义） ═════════════════════════════

groupStart(
  'A',
  '凭据表单：**只写不改**（提交体只带真改过的 key）',
  '这一段错了**零界面症状**：保存成功、提示也对，只有另一个 key 悄悄失效',
)

await it('A1 一个都没填 ⇒ `buildCredentialSubmitValues` 返回 `null`（调用方据此**不发请求**）', () => {
  const rows = credentialDraftsFromFields([
    field('token', { required: true, hasValue: true }),
    field('site'),
  ])
  assertEqual(rows[0].value, '', '初值必须是空串（值不下发，无从回填）')
  assertEqual(buildCredentialSubmitValues(rows), null, '没改就不该有提交体')
  assertEqual(hasCredentialInput(rows), false, '`hasCredentialInput` 同理（保存按钮应禁用）')
})

await it('A2 **只改一个 key** ⇒ 提交体里只有那一个（另一个不会被空串清空）', () => {
  const rows = credentialDraftsFromFields([
    field('token', { required: true, hasValue: true }),
    field('site', { hasValue: true }),
  ])
  const next = setCredentialDraftValue(rows, 'token', 'new-token')
  assertDeepEqual(buildCredentialSubmitValues(next), { token: 'new-token' }, '只带 token')
  // 关键反例：把整张表提交一遍会是什么样
  assertExcludes(canonical(buildCredentialSubmitValues(next)), '"site"', '`site` 绝不能出现（否则 = 清空）')
})

await it('A3 空格**是合法的凭据内容**（判定"改过"只看长度，不做 `trim`）', () => {
  const rows = [/* 一行 */ credentialDraftsFromFields([field('token')])[0]]
  const spaced = setCredentialDraftValue(rows, 'token', ' ')
  assertDeepEqual(buildCredentialSubmitValues(spaced), { token: ' ' }, '一个空格也是一个值')
})

await it('A4 必填项的"已填齐"要认**旧值**（`hasValue`），不然"没重填"会被误判成"没填"', () => {
  const withOld = credentialDraftsFromFields([field('token', { required: true, hasValue: true })])
  assertDeepEqual(missingAfterSubmit(withOld), [], '本来就有值 ⇒ 什么都不用做')
  const withoutOld = credentialDraftsFromFields([field('token', { required: true, hasValue: false })])
  assertDeepEqual(missingAfterSubmit(withoutOld), ['token'], '既没旧值、这次也没填 ⇒ 会 400')
  assertDeepEqual(
    missingAfterSubmit(setCredentialDraftValue(withoutOld, 'token', 'x')),
    [],
    '这次填了就齐了',
  )
})

await it('A5 草稿从 `McpCredentialField` 还原时**不带任何值**（连掩码都没有）', () => {
  const rows = credentialDraftsFromFields([
    field('token', { label: 'Personal Access Token', required: true, hasValue: true, placeholder: '粘贴 token' }),
  ])
  assertDeepEqual(
    rows[0],
    {
      key: 'token',
      label: 'Personal Access Token',
      inject: 'HEADER',
      required: true,
      placeholder: '粘贴 token',
      hasValue: true,
      value: '',
    },
    '唯一能带过来的只有"有没有值"这个布尔',
  )
})

// ═════════════════════════════ B 组：未配置计数与排序 ═════════════════════════════

groupStart('B', '未配置的计数与置顶（**只有一个来源**：`GET /api/mcp/credentials` 的两个数组）')

await it('B1 徽标数 = `unconfigured.length`（**不自己 filter 一遍**）', () => {
  assertEqual(unconfiguredCount([{ serverId: 'a' }, { serverId: 'b' }]), 2, '两个')
  assertEqual(unconfiguredCount([]), 0, '零个')
})

await it('B2 凭据页分组顺序：**未配置的置顶**，组内保持服务端顺序（排序必须稳定）', () => {
  const items = [
    credItem('ok-1', true),
    credItem('miss-1', false),
    credItem('ok-2', true),
    credItem('miss-2', false),
  ]
  assertDeepEqual(
    sortCredentialGroups(items).map((item) => item.serverId),
    ['miss-1', 'miss-2', 'ok-1', 'ok-2'],
    '未配置的在前，且同类内不打乱服务端给的顺序',
  )
  assertDeepEqual(
    items.map((item) => item.serverId),
    ['ok-1', 'miss-1', 'ok-2', 'miss-2'],
    '**原数组不能被就地改动**（否则 React 拿到的顺序会自己变）',
  )
})

await it('B3 表格里那一格的三种读数（无需凭据 / 已配置 / 未配置）', () => {
  assertEqual(credentialCell(credItem('s', true, { fields: [] })).kind, 'none', '模板为空 ⇒ 无需凭据')
  assertEqual(credentialCell(credItem('s', true, { fields: [] })).label, '无需凭据', '文案固定')
  assertEqual(credentialCell(credItem('s', true)).kind, 'configured', '必填都有值 ⇒ 已配置')
  const missing = credentialCell(credItem('s', false))
  assertEqual(missing.kind, 'missing', '缺值 ⇒ 未配置')
  assertDeepEqual(missing.missingKeys, ['token'], '要能说出**缺哪几个**')
})

await it('B4 清单还没读到 ⇒ 「未知」而**不是**「未配置」（说不出来的事不冒充结论）', () => {
  const unknown = credentialCell(undefined)
  assertEqual(unknown.kind, 'none', '中性那一档')
  assertEqual(unknown.label, '未知', '不能显示成「未配置」—— 那会是一批假警报')
})

// ═════════════════════════════ C 组：?serverId= 定位 ═════════════════════════════

groupStart('C', '`?serverId=` 的定位目标（`03` §4.5：自动滚动 + 高亮该分组）')

await it('C1 命中 ⇒ 返回锚点 id（唯一构造点）', () => {
  const items = [credItem('aaa', true), credItem('bbb', false)]
  assertEqual(resolveScrollTarget('bbb', items), credentialGroupAnchorId('bbb'), '命中的那一个')
  assertIncludes(credentialGroupAnchorId('bbb'), 'bbb', '锚点里要带 id（页面按它查 DOM）')
})

await it('C2 三种"不用滚"的情形**都返回 `null`**（没带 / 空串 / 不在清单里）', () => {
  const items = [credItem('aaa', true)]
  assertEqual(resolveScrollTarget(null, items), null, '没带参数')
  assertEqual(resolveScrollTarget('', items), null, '空串（**绝不能**拼出 `#cred-`）')
  assertEqual(resolveScrollTarget('gone', items), null, 'server 被删了 / 别人发的链接')
})

await it('C3 清单还没到 ⇒ 也返回 `null`（不能对一个还不存在的 DOM 动手）', () => {
  assertEqual(resolveScrollTarget('aaa', []), null, '空清单')
})

// ═════════════════════════════ D 组：模板编辑器 ═════════════════════════════

groupStart('D', '凭据参数模板编辑器（增删行 + 与后端**同一份**校验）')

await it('D1 增删行：移除越界时**原样返回同一引用**（不抛、也不生成新数组）', () => {
  const rows = [row('r1', 'a', 'A', 'HEADER'), row('r2', 'b', 'B', 'QUERY')]
  const appended = appendTemplateRow(rows, 'r3')
  assertEqual(appended.length, 3, '追加一行')
  assertEqual(appended[2].key, '', '新行是空的')
  assertEqual(appended[2].inject, 'HEADER', '注入位置给一个默认值（最常见的那一个）')
  assert(removeTemplateRow(rows, -1) === rows, '越界（负）⇒ 同一引用')
  assert(removeTemplateRow(rows, 9) === rows, '越界（超长）⇒ 同一引用')
  assertEqual(removeTemplateRow(rows, 0).length, 1, '正常移除')
  assertEqual(rows.length, 2, '**不就地改动**原数组')
  assertEqual(canAppendTemplateRow(rows), true, '没到上限 ⇒ 能加')
})

await it('D2 上限来自 `shared` 的常量（**同一个数**，不在前端再写一遍 64）', () => {
  assertEqual(templateRowLimit(), MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES, '同一个常量')
  const full = Array.from({ length: MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES }, (_, index) =>
    row(`r${index}`, `k${index}`, `L${index}`, 'HEADER'),
  )
  assertEqual(canAppendTemplateRow(full), false, '到上限 ⇒ 「+ 添加参数」应禁用')
})

await it('D3 注入位置的取值域与标签都来自 `shared`（**受控下拉**，不出现裸英文）', () => {
  assertDeepEqual(INJECT_LOCATIONS, CREDENTIAL_INJECT_LOCATIONS, '取值域同一份')
  assertEqual(INJECT_LOCATIONS.length, 3, '三个值')
  for (const location of INJECT_LOCATIONS) {
    assertIncludes(INJECT_LOCATION_LABEL[location], location, `${location} 的中文标签要带上英文取值（可对照）`)
  }
})

await it('D4 HEADER 名撞平台保留头 / 或不是合法头名 ⇒ 都报在**那一行的 key 上**（与后端同一条语义规则）', () => {
  // ① 撞保留头：`accept` 在 `MCP_RESERVED_HEADER_NAMES` 里（**小写比较** —— 头名不区分大小写）
  //    ⚠️ 别拿 `Authorization` 当反例：它**不在**保留名单里、也是合法头名 ⇒ 什么都不报
  const reserved = templateRowIssues([row('r1', 'Accept', 'Token', 'HEADER')])
  assertEqual(reserved.length, 1, '大写的 `Accept` 也要拦下（按小写比较）')
  assertEqual(reserved[0].rowId, 'r1', '定位到那一行')
  assertEqual(reserved[0].field, 'key', '定位到 `key` 那一列')
  assertIncludes(keyIssueFor(reserved, 'r1'), 'Accept', '文案里要点出是哪个名字')
  // ② 合法但**不是合法 HTTP 头名**（含空格）⇒ 走的是另一条分支，文案说的是原因
  const malformed = templateRowIssues([row('r1', 'X-User Token', 'Token', 'HEADER')])
  assertEqual(malformed.length, 1, '含空格的伪头名也要拦下')
  assertEqual(malformed[0].field, 'key', '同样报在 key 上')
  assertIncludes(keyIssueFor(malformed, 'r1'), '空格', '文案要点出是哪一类问题')
  // ③ 对照：真的合法的头名 ⇒ 一条都不报（否则上面两条断言只是在证明"什么都拦"）
  assertDeepEqual(templateRowIssues([row('r1', 'Authorization', 'Token', 'HEADER')]), [], 'Authorization 是合法的')
})

await it('D5 QUERY 名不能含 `&`/`=`、BODY 名不能撞 JSON-RPC 保留键', () => {
  const query = templateRowIssues([row('r1', 'a=b', 'X', 'QUERY')])
  assertEqual(query.length, 1, '`=` 被拦下')
  assertEqual(query[0].field, 'key', '报在 key 上')
  const body = templateRowIssues([row('r1', 'method', 'X', 'BODY')])
  assertEqual(body.length, 1, '`method` 是 JSON-RPC 保留键')
  // 同款名字放在 HEADER 里是合法的（判据**按注入位置分**，不是一刀切）
  assertDeepEqual(templateRowIssues([row('r1', 'method', 'X', 'HEADER')]), [], 'HEADER 里 `method` 合法')
})

await it('D6 同一模板内重名 ⇒ 报在后出现的那一行，并点名**第几个**', () => {
  const rows = [row('r1', 'token', 'T', 'HEADER'), row('r2', 'token', 'Again', 'HEADER')]
  const issues = templateRowIssues(rows)
  assertEqual(issues.length, 1, '只报一条（别把两行都标红）')
  assertEqual(issues[0].rowId, 'r2', '报在后一行')
  assertIncludes(issues[0].message, '第 1 个', '要说出与第几个重复')
})

await it('D7 空 `key` / 空 `label` ⇒ 逐字段报（`path` 精确到列）', () => {
  const issues = templateRowIssues([row('r1', '', '', 'HEADER')])
  const fields = issues.map((issue) => issue.field)
  assert(fields.includes('key'), 'key 必填')
  assert(fields.includes('label'), 'label 必填')
  assertEqual(issues.every((issue) => issue.rowId === 'r1'), true, '都归到那一行')
})

await it('D8 数量超限 ⇒ **没有归属到某一行**的错误（渲染在表单级）', () => {
  const tooMany = Array.from({ length: MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES + 1 }, (_, index) =>
    row(`r${index}`, `k${index}`, `L${index}`, 'HEADER'),
  )
  const issues = templateRowIssues(tooMany)
  assertEqual(formLevelTemplateIssues(issues).length, 1, '恰好一条表单级错误')
  assert(formLevelTemplateIssues(issues)[0].message.includes(String(MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES)), '文案要点出上限')
})

await it('D9 草稿 → 契约形态：**trim**、`required` 只在为真时才带、`type` 恒 `string`', () => {
  const rows = [row('r1', '  token  ', '  Token  ', 'QUERY', { required: true, placeholder: '  粘贴  ' })]
  assertDeepEqual(
    templateRowsToSchema(rows),
    [{ key: 'token', label: 'Token', type: 'string', inject: 'QUERY', required: true, placeholder: '粘贴' }],
    '裁空白 + 只带有内容的可选键',
  )
  assertDeepEqual(
    templateRowsToSchema([row('r1', 'a', 'A', 'HEADER')]),
    [{ key: 'a', label: 'A', type: 'string', inject: 'HEADER' }],
    '非必填、无占位符 ⇒ 那两个键**根本不出现**',
  )
})

await it('D10 契约形态 → 草稿能往返（编辑一个已注册的 server 时不会丢行）', () => {
  const schema = [
    { key: 'token', label: 'Token', type: 'string', inject: 'HEADER', required: true },
    { key: 'site', label: 'Site', type: 'string', inject: 'QUERY', placeholder: 'x.atlassian.net' },
  ]
  const rows = templateRowsFromSchema(schema)
  assertEqual(rows.length, 2, '两行都在')
  assertDeepEqual(templateRowsToSchema(rows), schema, '往返后与原来一致（键序无关）')
  assertEqual(rows[0].required, true, 'required 还原')
  assertEqual(rows[1].placeholder, 'x.atlassian.net', 'placeholder 还原')
  assertEqual(updateTemplateRow(rows, 1, { key: 'site2' })[1].key, 'site2', '改单列')
  assertEqual(updateTemplateRow(rows, 1, { key: 'site2' })[1].rowId, 't1', 'rowId 不被改动（它是 React key）')
})

// ═════════════════════════════ E 组：server 表单的请求体 ═════════════════════════════

groupStart('E', '注册 / 编辑的请求体（"没改就不发" + 集合语义判等）')

await it('E1 新建：`authType` **不提交**、模板空数组也照提交', () => {
  const draft = emptyServerFormDraft()
  draft.name = '  git  '
  draft.endpointUrl = ' https://mcp.internal/git '
  assertDeepEqual(
    buildCreateServerBody(draft),
    { name: 'git', endpointUrl: 'https://mcp.internal/git', credentialSchema: [] },
    '裁空白 + 不带 authType + 带空模板',
  )
})

await it('E2 编辑：一个字段都没改 ⇒ `null`（调用方不发请求，且提示「没有需要保存的改动」）', () => {
  const server = makeServer({ credentialSchema: [{ key: 'token', label: 'T', type: 'string', inject: 'HEADER' }] })
  assertEqual(buildServerUpdateBody(server, serverFormDraftFrom(server)), null, '零改动')
})

await it('E3 只改 endpoint ⇒ 只带那一个键（模板不跟着发）', () => {
  const server = makeServer()
  const draft = serverFormDraftFrom(server)
  draft.endpointUrl = 'https://mcp.internal/git2'
  assertDeepEqual(buildServerUpdateBody(server, draft), { endpointUrl: 'https://mcp.internal/git2' }, '只带 endpointUrl')
})

await it('E4 **换了两行的顺序**不算改动（集合语义判等，别用 `JSON.stringify` 直比）', () => {
  const server = makeServer({
    credentialSchema: [
      { key: 'a', label: 'A', type: 'string', inject: 'HEADER' },
      { key: 'b', label: 'B', type: 'string', inject: 'QUERY' },
    ],
  })
  const draft = serverFormDraftFrom(server)
  draft.credentialSchema = [draft.credentialSchema[1], draft.credentialSchema[0]]
  assertEqual(buildServerUpdateBody(server, draft), null, '顺序变了不该发 PATCH（更不该弹"影响了 N 份凭据"）')
})

await it('E5 **只改 label** 也不算改动（改文案对已存的值没有任何影响）', () => {
  const server = makeServer({
    credentialSchema: [{ key: 'a', label: 'A', type: 'string', inject: 'HEADER' }],
  })
  const draft = serverFormDraftFrom(server)
  draft.credentialSchema = updateTemplateRow(draft.credentialSchema, 0, { label: '改个说明' })
  assertEqual(buildServerUpdateBody(server, draft), null, 'label 不参与差异判定')
})

await it('E6 删掉一个 key ⇒ 带上整份模板（整体替换语义）', () => {
  const server = makeServer({
    credentialSchema: [
      { key: 'a', label: 'A', type: 'string', inject: 'HEADER' },
      { key: 'b', label: 'B', type: 'string', inject: 'QUERY' },
    ],
  })
  const draft = serverFormDraftFrom(server)
  draft.credentialSchema = removeTemplateRow(draft.credentialSchema, 1)
  assertDeepEqual(
    buildServerUpdateBody(server, draft),
    { credentialSchema: [{ key: 'a', label: 'A', type: 'string', inject: 'HEADER' }] },
    '整份提交（数组语义，"提交什么就是什么"）',
  )
})

await it('E7 清空模板 ⇒ 提交 `[]`（这是"这台 server 不要用户填东西"的明确写法）', () => {
  const server = makeServer({
    credentialSchema: [{ key: 'a', label: 'A', type: 'string', inject: 'HEADER' }],
  })
  const draft = serverFormDraftFrom(server)
  draft.credentialSchema = removeTemplateRow(draft.credentialSchema, 0)
  assertDeepEqual(buildServerUpdateBody(server, draft), { credentialSchema: [] }, '清空就是 `[]`')
})

await it('E8 模板影响 → 一句人话：**只提示、绝不承诺清理**', () => {
  const hint = credentialImpactHint({
    removedKeys: ['old'],
    addedKeys: ['fresh'],
    retargetedKeys: ['token'],
    affectedCredentials: 2,
  })
  assertIncludes(hint, 'old', '点名被移除的参数')
  assertIncludes(hint, '2 份凭据', '说出影响面')
  assertIncludes(hint, 'token', '点名注入位置变了的参数')
  assertIncludes(hint, 'fresh', '点名新增的参数')
  assertIncludes(hint, '不会被自动清理', '**必须说不清**（P0-2-3 定案：只提示、绝不自动清理）')
  assertExcludes(hint, '已清理', '绝不能出现"已清理"这种承诺')
  assertExcludes(hint, '已删除', '也不能说"已删除"')
  assertEqual(credentialImpactHint(null), null, '没有影响 ⇒ 不弹（`null` 不是"空影响对象"）')
})

await it('E9 只有"新增"时：只说"缺值"，不提任何失效 / 删除 / 清理', () => {
  const hint = credentialImpactHint({ removedKeys: [], addedKeys: ['x'], retargetedKeys: [], affectedCredentials: 0 })
  assertIncludes(hint, '需要在「我的凭据」里填', '新增的后果是"缺值"')
  assertExcludes(hint, '不再被注入', '没移除任何参数 ⇒ 不能说有值失效')
  assertExcludes(hint, '已删除', '不提删除')
  assertExcludes(hint, '已清理', '不提清理')
  // 结尾那句兜底是**整条提示的定语**，不按 `removedKeys` 分叉：
  // 分叉会让同一句提示有两种形态，而"我填过的东西还在吗"这个疑问与"这次改了什么"无关
  // （`06` P0-2-11 坑预判 5 的原话就是"**必须含**不会被自动清理"）
  assertIncludes(hint, '不会被自动清理', '兜底那句恒在')
})

// ═════════════════════════════ F 组：列表读数（`0` 与"没拉过"） ═════════════════════════════

groupStart('F', '列表读数：工具数 `0` 与"没拉过"、连通状态三档')

await it('F1 `UNKNOWN` 且 `toolCount === 0` ⇒ 显示 `—`（"没拉过"不是"没有工具"）', () => {
  assertEqual(formatToolCount({ status: 'UNKNOWN', toolCount: 0 }), '—', '没拉过 ⇒ 留白')
  assertEqual(formatToolCount({ status: 'OK', toolCount: 0 }), '0', '拉过且真的没有 ⇒ 显示 0（一句真话）')
  assertEqual(formatToolCount({ status: 'OK', toolCount: 3 }), '3', '正常读数')
  assertEqual(formatToolCount({ status: 'ERROR', toolCount: 0 }), '0', '握手失败但缓存里有 0 —— 那是缓存的事实')
})

await it('F2 连通状态三档：`UNKNOWN` 是「未测试」而**不是**「异常」', () => {
  assertEqual(serverStatusView('OK').led, 'ok', 'OK ⇒ 绿灯')
  assertEqual(serverStatusView('ERROR').led, 'fail', 'ECONN 失败 ⇒ 红灯')
  assertEqual(serverStatusView('UNKNOWN').led, 'idle', '没握过手 ⇒ 中性灯（**不是红灯**）')
  assertEqual(serverStatusView('UNKNOWN').label, '未测试', '文案要说"没测过"而不是"有问题"')
  for (const status of ['OK', 'ERROR', 'UNKNOWN']) {
    assert(serverStatusView(status).hint.length > 0, `${status} 要有悬浮说明`)
  }
})

// ═════════════════════════════ G 组：确认卡 ═════════════════════════════

groupStart(
  'G',
  '确认卡：倒计时**只读服务端的 `expiresAt`**（`06` P0-2-11 坑预判 3）',
  '前端自己另起一个 120s ⇒ "界面说还没到、服务端已按取消处理"',
)

await it('G1 剩余秒数：向上取整，最小 0', () => {
  const now = Date.parse('2026-09-24T10:00:00.000Z')
  assertEqual(remainingSeconds('2026-09-24T10:02:00.000Z', now), 120, '整两分钟')
  assertEqual(remainingSeconds('2026-09-24T10:00:00.400Z', now), 1, '还差 0.4s ⇒ 显示 1s（向上取整）')
  assertEqual(remainingSeconds('2026-09-24T09:59:59.000Z', now), 0, '已经过了 ⇒ 0（不出现负数）')
  assertEqual(remainingSeconds('不是时间', now), 0, '坏串 ⇒ 0（**不能是 `NaN`**）')
})

await it('G2 倒计时文案：到点说「已超时」，不说 `0s`', () => {
  assertEqual(confirmCountdownText(120), '120s', '正常读数')
  assertEqual(confirmCountdownText(1), '1s', '最后一秒')
  assertEqual(confirmCountdownText(0), '已超时', '到点那一档')
  assertEqual(confirmCountdownText(-5), '已超时', '负数也归这一档（防御）')
})

await it('G3 两种来源的说明文案**不同**（`source` 只决定这一句）', () => {
  const platform = confirmSourceHint('PLATFORM')
  const server = confirmSourceHint('SERVER')
  assert(platform !== server, '两句话不一样')
  assertIncludes(platform, '平台', 'PLATFORM ⇒ 平台判定的危险操作')
  assertIncludes(server, 'MCP server', 'SERVER ⇒ server 反过来要求确认')
})

await it('G4 `applied:false` 是**幂等忽略**，不是失败（文案不许说"失败"）', () => {
  const ignored = confirmIgnoredNote(false)
  assertEqual(ignored !== null, true, '要给出提示')
  assertIncludes(ignored, '没有生效', '口径是"这次确认没生效"')
  assertExcludes(ignored, '失败', '**不能说"失败"**（那是服务端故障的通道）')
  assertEqual(confirmIgnoredNote(true), null, '真生效了 ⇒ 不提示（由成功通道说更具体的一句）')
})

await it('G5 生效时的两句（确认 / 取消，后果不同）', () => {
  assertIncludes(confirmAnsweredText(true), '继续执行', '确认 ⇒ 工具继续')
  assertIncludes(confirmAnsweredText(false), '不会执行', '取消 ⇒ 工具不执行')
  assert(confirmAnsweredText(true) !== confirmAnsweredText(false), '两句必须不同')
})

// ═════════════════════════════ H 组：工具卡「去配置凭据」与错误码 ═════════════════════════════

groupStart('H', '工具卡：`NEED_CREDENTIAL` + **有 `serverId`** 才给「去配置凭据」')

await it('H1 三个条件缺一不可', () => {
  assertEqual(
    canConfigureCredential({ status: 'ERROR', errorCode: 'NEED_CREDENTIAL', serverId: 'sid' }),
    true,
    '三个都满足',
  )
  assertEqual(
    canConfigureCredential({ status: 'ERROR', errorCode: 'NEED_CREDENTIAL' }),
    false,
    '缺 `serverId` ⇒ **不给按钮**（否则拼出 `?serverId=` 空值，点了什么都不发生）',
  )
  assertEqual(
    canConfigureCredential({ status: 'RUNNING', errorCode: 'NEED_CREDENTIAL', serverId: 'sid' }),
    false,
    '还在跑 ⇒ 不给',
  )
  assertEqual(
    canConfigureCredential({ status: 'ERROR', errorCode: 'UPSTREAM_ERROR', serverId: 'sid' }),
    false,
    '别的错误码 ⇒ 不给（去配置凭据解决不了上游故障）',
  )
  assertEqual(
    canConfigureCredential({ status: 'ERROR', errorCode: 'NEED_CREDENTIAL', serverId: '' }),
    false,
    '空串等于没有（契约里"没有这个键"与"有但是空"是两件事，但这一条判据都该拦）',
  )
})

await it('H2 两条 MCP 特有错误码有可操作的补充说明，其余一律 `null`', () => {
  assertIncludes(toolErrorHint('NEED_CREDENTIAL'), '去配置凭据', '缺凭据 ⇒ 指路')
  assertEqual(toolErrorHint('UPSTREAM_TIMEOUT') !== null, true, '超时 ⇒ 有说明')
  assertEqual(toolErrorHint('UPSTREAM_ERROR') !== null, true, '上游异常 ⇒ 有说明')
  assertEqual(toolErrorHint('CONFLICT'), null, '其余 ⇒ 不叠加解释（只显示服务端原文）')
  assertEqual(toolErrorHint(undefined), null, '没有错误码 ⇒ 不解释')
})

await it('H3 错误码 → 默认文案只有一个来源（`shared` 那张表，且取值域外的返 `null`）', () => {
  assertEqual(errorCodeLabel('NEED_CREDENTIAL'), '尚未配置所需凭据', '取自 `DEFAULT_MESSAGE_BY_ERROR_CODE`')
  assertEqual(errorCodeLabel('NOT_FOUND'), '资源不存在', '同款')
  assertEqual(errorCodeLabel('不是错误码'), null, '取值域外 ⇒ null（**不要**编"未知错误"）')
  assertEqual(errorCodeLabel(undefined), null, '没有 ⇒ null')
})

await it('H4 `tool_call` 事件 → 工具卡：`serverId` / `errorCode` 走**三态**（有才带上）', () => {
  const withBoth = toolViewFromEvent({
    callId: 'c1',
    toolName: 'mcp_git_status',
    serverName: 'git',
    serverId: 'sid',
    kind: 'MCP',
    status: 'ERROR',
    inputSummary: '{}',
    output: '缺凭据',
    errorCode: 'NEED_CREDENTIAL',
  })
  assertEqual(withBoth.serverId, 'sid', 'serverId 带上')
  assertEqual(withBoth.errorCode, 'NEED_CREDENTIAL', 'errorCode 带上')
  const sandbox = toolViewFromEvent({
    callId: 'c2',
    toolName: 'run_python',
    serverName: '',
    kind: 'SANDBOX',
    status: 'SUCCESS',
    inputSummary: '{}',
  })
  assertEqual('serverId' in sandbox, false, '沙箱工具**没有这个键**（不是空串）')
  assertEqual('errorCode' in sandbox, false, '没失败就没有 errorCode 这个键')
})

await it('H5 历史里的 `tool_calls` 能还原成工具卡（P0-2-8 定型、P0-2-11 接回）', () => {
  const view = messageToView({
    id: 'm1',
    conversationId: 'c1',
    role: 'ASSISTANT',
    content: {
      text: '我看一下。',
      tool_calls: [
        {
          callId: 'c1',
          toolName: 'mcp_git_status',
          serverName: 'git',
          serverId: 'sid',
          kind: 'MCP',
          status: 'ERROR',
          inputSummary: '{"repo":"a"}',
          errorCode: 'NEED_CREDENTIAL',
          // ⚠️ `arguments` 是落库留档用的原样 JSON，**不该进视图模型**
          arguments: '{"token":"SECRET"}',
        },
      ],
    },
    createdAt: '2026-09-24T10:00:00.000Z',
  })
  assertEqual(view.tools.length, 1, '还原出一张工具卡')
  assertEqual(view.tools[0].toolName, 'mcp_git_status', '工具名')
  assertEqual(view.tools[0].serverId, 'sid', 'serverId 要在（它是"去配置"的落点）')
  assertEqual(view.tools[0].errorCode, 'NEED_CREDENTIAL', '错误码要在（判据的另一半）')
  assertEqual(canConfigureCredential(view.tools[0]), true, '于是历史里的失败卡也带得出「去配置凭据」')
  assertExcludes(canonical(view.tools[0]), 'SECRET', '**`arguments` 绝不能上屏**（那里面有凭据值）')
  assertExcludes(canonical(view.tools[0]), 'arguments', '连键都不带上来')
})

await it('H6 历史里坏的工具段**逐项丢弃**（一项坏不该让整轮渲染不出来）', () => {
  const view = messageToView({
    id: 'm1',
    conversationId: 'c1',
    role: 'ASSISTANT',
    content: {
      text: '',
      tool_calls: [
        { callId: '', toolName: 'x' }, // 缺字段，坏项
        { callId: 'c2', toolName: 'mcp_a_b', serverName: 'a', kind: 'MCP', status: 'SUCCESS', inputSummary: '{}' },
      ],
    },
    createdAt: '2026-09-24T10:00:00.000Z',
  })
  assertEqual(view.tools.length, 1, '只保留合法的那一项')
  assertEqual(view.tools[0].callId, 'c2', '保留的是它')
})

await it('H7 `tool_calls` 不在 `content` 里 ⇒ 空数组（不是 undefined，渲染层不用再判一次）', () => {
  const view = messageToView({
    id: 'm1',
    conversationId: 'c1',
    role: 'USER',
    content: { text: '你好' },
    createdAt: '2026-09-24T10:00:00.000Z',
  })
  assertDeepEqual(view.tools, [], '空数组')
})

// ═════════════════════════════ I 组：源码级守门 ═════════════════════════════

groupStart('I', '源码级守门（"没有别的观测面"的几条正确性）')

/** 读 `frontend/src` 下所有 .ts/.tsx 的源码（去掉注释，避免注释里的示例命中） */
function sourceFiles() {
  const root = new URL('../src/', import.meta.url)
  const base = fileURLToPath(root)
  const names = readdirSync(root, { recursive: true })
    .filter((name) => typeof name === 'string' && /\.(ts|tsx)$/.test(name))
    .map((name) => name.replaceAll('\\', '/'))
  return names.map((name) => ({ name, source: stripComments(readFileSync(`${base}${name}`, 'utf8')) }))
}

await it('I1 导航里 `MC` / `CR` 两条的 `batch` 台账已删（页面落地必须手工删掉那一项）', () => {
  const nav = sourceFiles().find(({ name }) => name === 'app/nav.ts')
  assert(nav !== undefined, '找不到 app/nav.ts')
  assertIncludes(nav.source, "path: '/mcp'", '/mcp 还在导航里')
  assertIncludes(nav.source, "path: '/settings/credentials'", '我的凭据**与 MCP 解耦**后的路由（个人设置族）也在')
  assertExcludes(nav.source, "path: '/mcp/credentials'", '旧路由必须消失（不再跟在 MCP 后面）')
  assertExcludes(nav.source, '端点尚未存在', '两条台账文案必须删掉（否则这份台账会变成"哪些页还没做"的错误答案）')
})

await it('I2 `/mcp` 两条路由指向真页面，**不再**是占位页', () => {
  const app = sourceFiles().find(({ name }) => name === 'app/App.tsx')
  assert(app !== undefined, '找不到 app/App.tsx')
  assertIncludes(app.source, '<McpServersPage />', '列表页')
  assertIncludes(app.source, '<McpCredentialsPage />', '凭据页')
  // 占位页只应剩 `/tasks` 与 `/admin/usage` 两条（P1）
  assertExcludes(app.source, "batch=\"P0-2\"", '不该还有 P0-2 的占位页')
})

await it('I3 「从别处跳到凭据页」只有**一个**构造点（`app/paths.ts#credentialsPath`）', () => {
  const files = sourceFiles()
  // 2026-10-16：凭据页分区后地址形如 `?section=mcp&serverId=…`，故按 `serverId=` 判（`?serverId=` 不再出现）
  const withQuery = files.filter(({ source }) => source.includes('serverId='))
  assertDeepEqual(
    withQuery.map((file) => file.name),
    ['app/paths.ts'],
    '`serverId=` 这个字面只能出现在 paths.ts（三处入口都调那个函数）',
  )
})

await it('I4 未配置的判据只有一处（Agent 编辑页读 `unconfigured`，不自己算 `missingKeys`）', () => {
  const page = sourceFiles().find(({ name }) => name === 'pages/agents/AgentFormPage.tsx')
  assert(page !== undefined, '找不到智能体编辑页')
  assertIncludes(page.source, 'unconfigured', '读服务端派生的 `unconfigured`')
  assertExcludes(page.source, 'missingKeys', '**不自己算**（否则与凭据页的徽标各说各话）')
})

await it('I5 确认卡的两个按钮**真的**接了回调，且倒计时读 `expiresAt`（不再有写死的 120）', () => {
  const card = sourceFiles().find(({ name }) => name === 'features/chat/ConfirmCard.tsx')
  assert(card !== undefined, '找不到确认卡')
  assertIncludes(card.source, 'expiresAt', '读服务端的截止时刻')
  assertIncludes(card.source, 'onAnswer(true)', '确认按钮接回调')
  assertIncludes(card.source, 'onAnswer(false)', '取消按钮接回调')
  assertExcludes(card.source, 'timeoutSec', '旧的写死参数必须消失')
  const input = sourceFiles().find(({ name }) => name === 'features/chat/ChatInput.tsx')
  assertIncludes(input.source, 'confirmPending', '按钮的禁用态来自页面')
  assertExcludes(input.source, 'timeoutSec: 120', '不再传写死的 120')
})

await it('I6 确认应答走 `POST /:id/confirm`，且**收卡**由 store 的一个显式动作承担', () => {
  const api = sourceFiles().find(({ name }) => name === 'api/mcp.ts')
  assert(api !== undefined, '找不到 api/mcp.ts')
  assertIncludes(api.source, '/confirm', '应答端点')
  assertIncludes(api.source, 'confirmConversation', '导出的那个函数')
  const store = sourceFiles().find(({ name }) => name === 'stores/chatStream.ts')
  assertIncludes(store.source, 'clearConfirm', 'store 上要有收卡的动作（服务端不会为此发事件）')
  const page = sourceFiles().find(({ name }) => name === 'pages/chat/ChatPage.tsx')
  assertIncludes(page.source, 'clearConfirm(', '页面在答复之后必须调它')
})

await it('I7 工具卡的「去配置凭据」用**那一个**路径构造点（不手拼字符串）', () => {
  const card = sourceFiles().find(({ name }) => name === 'features/chat/ToolCard.tsx')
  assert(card !== undefined, '找不到工具卡')
  assertIncludes(card.source, 'credentialsPath(', '用 paths.ts 的函数')
  assertIncludes(card.source, 'canConfigureCredential(', '判据来自 messageModel')
  assertExcludes(card.source, '?serverId=', '不手拼查询串')
})

await it('I8 两个纯逻辑文件都**不 import React / antd / api**（否则无依赖档跑不动）', () => {
  for (const name of ['pages/mcp/mcpModel.ts', 'features/chat/confirmModel.ts']) {
    const file = sourceFiles().find((entry) => entry.name === name)
    assert(file !== undefined, `找不到 ${name}`)
    assertExcludes(file.source, "from 'react'", `${name} 不该 import React`)
    assertExcludes(file.source, "from 'antd'", `${name} 不该 import antd`)
    assertExcludes(file.source, '/api/', `${name} 不该 import api 层`)
    assertExcludes(file.source, '/styles/', `${name} 不该 import 样式`)
  }
})

await it('I9 「测试」按钮也归入 canEdit 门禁（2026-10-16：测试用所属人凭据，只有所属人/ADMIN 能点）', () => {
  const page = sourceFiles().find(({ name }) => name === 'pages/mcp/McpServersPage.tsx')
  assert(page !== undefined, '找不到 MCP 列表页')
  const canEditAt = page.source.indexOf('server.canEdit ? (')
  const testAt = page.source.indexOf('testServer.mutate(')
  assert(canEditAt >= 0, 'canEdit 门禁必须存在')
  assert(testAt > canEditAt, '测试按钮要落在 `server.canEdit ? (` 之后（同门禁），不能无条件渲染')
  assertIncludes(page.source, '测试 / 编辑 / 删除都需要', '无权限的说明要涵盖测试')
})

// ───────────────────────────── 汇总 ─────────────────────────────

console.log(`\n${c.b}── 分组小结 ──${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✓${c.x}` : `${c.r}✗${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.b}── P0-2-11 验收门槛第 ① 条（无依赖纯逻辑档覆盖）对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 凭据表单的"只改一个 key"请求体构造 ...... A1~A3（没改不发、只带改过的、空格算值）`)
console.log(`  ${c.g}②${c.x} 未配置计数与排序 ........................ B1/B2（计数同源、未配置置顶且排序稳定）`)
console.log(`  ${c.g}③${c.x} \`?serverId=\` 定位的滚动目标 ............... C1~C3（三种"不用滚"都返回 null）`)
console.log(`  ${c.g}④${c.x} 模板编辑器增删行与校验 .................. D1~D8（与后端**同一份** ` + '`validateCredentialSchema`' + `）`)
console.log(`  ${c.g}⑤${c.x} 确认卡倒计时文案与"取消"分支 ............ G1~G5（读 expiresAt，不另起 120s）`)
console.log(`  ${c.g}⑥${c.x} 逐个错误码 → 文案 ....................... H2/H3（两条来源一张表，取值域外返 null）`)
console.log(`  ${c.g}+${c.x} 本批新增的两条接线：工具卡"去配置凭据" H1/H5、历史工具卡还原 H5/H6`)
console.log(`  ${c.g}坑${c.x} 坑预判 4（红点只有一个来源）.............. I4（编辑页读 ` + '`unconfigured`' + `，不自己算）`)
console.log(`  ${c.g}坑${c.x} 坑预判 2（只写不改）...................... A1~A5 + E8（提示里不出现"已清理"）`)
console.log(`  ${c.g}坑${c.x} 坑预判 3（倒计时只读服务端）.............. G1/G2 + I5（写死的 120 必须消失）`)

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · React 渲染与交互（表格 / 弹窗 / 模板编辑器长什么样、滚动有没有真的发生、"点得动"）`)
console.log(`    ⇒ 浏览器端测：\`README\`「浏览器端测 · MCP」（**阶段二唯一的浏览器端测点**）`)
console.log(`  · 真后端：注册的 400 文案、\`PATCH\` 的影响计数、\`/:id/test\` 恒 200、`)
console.log(`    \`/:id/tools\` 的 502 与"有缓存就 200" ⇒ \`README\` 里那些**内联假上游**的命令行端测（㉒/㉓）`)
console.log(`  · 打包产物：本档跑的是**源码**（\`node --import tsx\`），不经 vite${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ MCP 页面前端验收通过（P0-2-11）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ MCP 页面前端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
