#!/usr/bin/env node
/**
 * mcp-gateway-regression.ts —— MCP 工具网关（P1-19）的**纯函数**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend gateway:regression`
 *      （= `node --import tsx scripts/mcp-gateway-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`backend/src/mcp/gatewayModel.ts`（策略 / 检索 / 排版）+ `backend/src/orchestrator/mcpGatewayTools.ts`
 *      的 `resolveMcpGatewayCall`（入参改写）。被测的只是**纯判据**：
 *   · `selectMcpInlineTools` —— 阈值内全下发、超阈值只下发常驻、无常驻则全走网关；
 *   · `filterMcpToolEntries` / `formatMcpToolCatalog` —— 按 server / query 筛、封顶不静默；
 *   · `resolveMcpGatewayCall` —— 名字不在目录 / 参数非法都被翻成一句可读原因。
 * ⚠️ 它**验不了**端到端（要真 DB/Redis/上游）：`resolveMcpToolCatalog` 读 `tool_cache` 组装、
 *    chatBot 的工具循环分流、沙箱代理端点 —— 那些留给用户真跑。
 */

import { MCP_CALL_TOOL_TOOL_NAME, MCP_LIST_TOOLS_TOOL_NAME, isMcpGatewayToolName } from '@doubulea/shared'

import {
  expandMcpToolQueryTerms,
  filterMcpToolEntries,
  formatMcpToolCatalog,
  selectMcpInlineTools,
  type McpCatalogToolEntry,
} from '../src/mcp/gatewayModel.js'
import { resolveMcpGatewayCall } from '../src/orchestrator/mcpGatewayTools.js'
import {
  TOOL_CONFIRM_REJECTED_OUTPUT,
  TOOL_CONFIRM_TIMEOUT_OUTPUT,
  failedToolNamesOf,
  failedToolNotice,
} from '../src/orchestrator/chatContext.js'
import { PROTOCOLS, TOOL_RESULT_ERROR_PREFIX } from '../src/llm/protocol.js'

let passed = 0
let failed = 0
function it(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

const entry = (name: string, serverId = 'srv-1', serverName = '系统'): McpCatalogToolEntry => ({
  name,
  serverId,
  serverName,
  toolName: name.replace(/^mcp_[^_]+_/, ''),
  description: `说明 ${name}`,
  inputSchema: { type: 'object', properties: {} },
  dangerous: false,
})
const entries = (n: number): McpCatalogToolEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`mcp_a_t${i}`))

// ───────────────────────────── A 阈值内：全量下发 ─────────────────────────────

console.log('── A 阈值内全量下发（selectMcpInlineTools）──')
it('A1 工具数 ≤ 阈值 ⇒ 全部直接下发，网关不启用', () => {
  const all = entries(5)
  const r = selectMcpInlineTools(all, new Set(), 24)
  eq(r.gatewayActive, false, 'gatewayActive')
  eq(r.inline.size, 5, 'inline 数量')
})
it('A2 恰好等于阈值 ⇒ 仍全量下发', () => {
  const r = selectMcpInlineTools(entries(24), new Set(), 24)
  eq(r.gatewayActive, false, 'gatewayActive')
  eq(r.inline.size, 24, 'inline 数量')
})

// ───────────────────────────── B 超阈值：常驻 + 网关 ─────────────────────────────

console.log('── B 超阈值走网关（selectMcpInlineTools）──')
it('B1 超过阈值且无常驻 ⇒ 一个都不直接下发，网关启用', () => {
  const r = selectMcpInlineTools(entries(30), new Set(), 24)
  eq(r.gatewayActive, true, 'gatewayActive')
  eq(r.inline.size, 0, 'inline 数量')
})
it('B2 超过阈值且有常驻 ⇒ 只下发常驻的那些', () => {
  const all = entries(30)
  const pinned = new Set([all[2]!.name, all[7]!.name])
  const r = selectMcpInlineTools(all, pinned, 24)
  eq(r.gatewayActive, true, 'gatewayActive')
  eq([...r.inline].sort(), [all[2]!.name, all[7]!.name].sort(), 'inline 集合')
})
it('B3 阈值设 0 ⇒ 永远走网关（即便只有 1 个工具）', () => {
  const r = selectMcpInlineTools(entries(1), new Set(), 0)
  eq(r.gatewayActive, true, 'gatewayActive')
  eq(r.inline.size, 0, 'inline 数量')
})

// ───────────────────────────── C 目录检索与排版 ─────────────────────────────

console.log('── C 目录检索 / 排版（filterMcpToolEntries / formatMcpToolCatalog）──')
it('C1 按 server 名收窄（大小写不敏感）', () => {
  const all = [
    { ...entry('mcp_a_x', 'srv-1', 'Alpha'), toolName: 'x' },
    { ...entry('mcp_b_y', 'srv-2', 'Beta'), toolName: 'y' },
  ]
  const page = filterMcpToolEntries(all, { server: 'alpha' })
  eq(page.total, 1, 'total')
  eq(page.entries[0]!.name, 'mcp_a_x', '命中的名字')
})
it('C2 按关键词匹配原始工具名 / 描述', () => {
  const all = [
    { ...entry('mcp_a_createOrder', 'srv-1', 'Alpha'), toolName: 'createOrder', description: '下单' },
    { ...entry('mcp_a_listUser', 'srv-1', 'Alpha'), toolName: 'listUser', description: '查用户' },
  ]
  eq(filterMcpToolEntries(all, { query: 'order' }).total, 1, 'query=order')
  eq(filterMcpToolEntries(all, { query: '查用户' }).total, 1, 'query=中文描述')
})
it('C3 命中数超上限 ⇒ 只列出上限条，但 total 如实给全（不静默）', () => {
  const page = filterMcpToolEntries(entries(150), {})
  eq(page.total, 150, 'total')
  eq(page.entries.length, 100, '列出的条数')
  const text = formatMcpToolCatalog(page)
  assert(text.includes('共匹配 150 个工具'), '排版应写明命中总数')
  assert(/其余 \d+ 个未列出/.test(text), '排版应写明未列出的条数')
})
it('C4 无命中 ⇒ 明说没有，不假装"没有工具"', () => {
  const text = formatMcpToolCatalog(filterMcpToolEntries(entries(3), { query: 'zzz' }))
  assert(text.includes('没有匹配的 MCP 工具'), text)
})
/**
 * C5：**网关模式下工具的完整信息必须出现在目录里**（2026-10-22 实测事故的定稿口径）。
 *
 * 事故：`variables` 声明是 `object`，模型却传 JSON 字符串连传 3 次。当时的目录只给一行
 * `参数: 必填 …；可选 variables: object<string,string>` 摘要 —— 摘要**不等于 schema**。
 * 定稿：搜索返回的就是**这个工具的完整 `inputSchema`（JSON，无损）**，模型按它生成参数。
 */
it('C5 每条工具都带完整 inputSchema（合法 JSON，含必填与类型）', () => {
  const withSchema: McpCatalogToolEntry[] = [
    {
      ...entry('mcp_a_list_executions'),
      toolName: 'list_executions',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'target project id' },
          limit: { type: 'integer' },
          status: { type: 'string', enum: ['pass', 'fail'] },
        },
        required: ['projectId'],
      },
    },
  ]
  const text = formatMcpToolCatalog(filterMcpToolEntries(withSchema, {}))
  const line = text.split('\n').find((row) => row.trim().startsWith('inputSchema:'))
  assert(line !== undefined, text)
  const schema = JSON.parse(line.trim().replace(/^inputSchema:\s*/, '')) as Record<string, unknown>
  eq(schema['required'], ['projectId'], 'required')
  const properties = schema['properties'] as Record<string, Record<string, unknown>>
  eq(properties['status']!['enum'], ['pass', 'fail'], 'enum')
})
it('C5b object / array / 嵌套类型原样给出（不是压成一行摘要）', () => {
  const text = formatMcpToolCatalog(
    filterMcpToolEntries(
      [
        {
          ...entry('mcp_a_upsert_environment'),
          inputSchema: {
            type: 'object',
            required: ['projectId', 'name'],
            properties: {
              projectId: { type: 'string' },
              name: { type: 'string' },
              variables: { type: 'object', additionalProperties: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      ],
      {},
    ),
  )
  assert(text.includes('"variables":{"type":"object","additionalProperties":{"type":"string"}}'), text)
  assert(text.includes('"tags":{"type":"array","items":{"type":"string"}}'), text)
})
it('C5c 描述不截断（约束原文必须完整给到模型）', () => {
  const long = 'x'.repeat(400)
  const text = formatMcpToolCatalog(filterMcpToolEntries([{ ...entry('mcp_a_long'), description: long }], {}))
  assert(text.includes(long), '描述被截断了')
})
it('C6 目录按字符预算装箱：不劈开 JSON，超出的条数明确告知', () => {
  const many: McpCatalogToolEntry[] = Array.from({ length: 40 }, (_, i) => ({
    ...entry(`mcp_a_tool_${i}`),
    description: 'y'.repeat(200),
    inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  }))
  const text = formatMcpToolCatalog({ entries: many, total: many.length })
  assert(text.length <= 7000, `实际 ${text.length} 字符`)
  assert(/以下列出 \d+ 个/.test(text), text.split('\n')[0] ?? '')
  assert(text.includes('其余'), text.split('\n').at(-2) ?? '')
  for (const line of text.split('\n')) {
    const match = line.match(/^\s+inputSchema: (.*)$/)
    if (match === null) continue
    JSON.parse(match[1] as string) // 每一条都必须是合法 JSON
  }
})
it('C7 坏 inputSchema 不炸（退回可读摘要）', () => {
  const cyclic: Record<string, unknown> = { type: 'object' }
  cyclic['self'] = cyclic
  const text = formatMcpToolCatalog(
    filterMcpToolEntries([{ ...entry('mcp_a_cyclic'), inputSchema: cyclic }], {}),
  )
  assert(text.includes('mcp_a_cyclic'), text)
  assert(text.includes('inputSchema:'), text)
})

// ───────────────────────────── C′ query 分词 / 同义词（2026-10-22）─────────────────────────────

console.log('── C′ query 分词与同义词（expandMcpToolQueryTerms / filterMcpToolEntries）──')
const apiTools: McpCatalogToolEntry[] = [
  'delete_environment',
  'upsert_environment',
  'list_environments',
  'get_execution',
  'run_case',
  'list_endpoints',
].map((toolName) => ({
  ...entry(`mcp_apitest_${toolName}`),
  toolName,
  description:
    toolName.includes('environment') ? 'environment variables' : toolName.includes('execution') ? 'run records' : '',
}))

it('C′1 中文无空格也要切得开：`删除环境` ⇒ 删除组 ∧ 环境组', () => {
  const units = expandMcpToolQueryTerms('删除环境')
  eq(units.length, 2, '单元数')
  assert(units.some((unit) => unit.includes('delete') && unit.includes('删除')), JSON.stringify(units))
  assert(units.some((unit) => unit.includes('env') && unit.includes('环境')), JSON.stringify(units))
})
it('C′2 中英混写 + 同义展开：`delete environment 删除环境` 命中 delete_environment 且排第一', () => {
  const page = filterMcpToolEntries(apiTools, { query: 'delete environment 删除环境' })
  assert(page.total > 0, '应有命中')
  eq(page.entries[0]!.toolName, 'delete_environment', '首位')
})
it('C′3 同义词（remove → delete）：能命中删除类工具', () => {
  const page = filterMcpToolEntries(apiTools, { query: 'remove' })
  assert(
    page.entries.some((item) => item.toolName === 'delete_environment'),
    page.entries.map((item) => item.toolName).join(','),
  )
})
it('C′4 名字命中优先于描述命中（`创建 环境` ⇒ upsert_environment 第一）', () => {
  const page = filterMcpToolEntries(apiTools, { query: '创建 环境' })
  eq(page.entries[0]!.toolName, 'upsert_environment', '首位')
})
it('C′5 标识符整体优先：`delete_environment` 不做切分，自身排第一', () => {
  const page = filterMcpToolEntries(apiTools, { query: 'delete_environment' })
  eq(page.entries[0]!.toolName, 'delete_environment', '首位')
})
it('C′6 纯噪音 query（`zzz` / 全是标点）不把一切判成命中', () => {
  eq(filterMcpToolEntries(apiTools, { query: 'zzz' }).total, 0, 'zzz')
  // 全是标点 ⇒ 视同没给 query（列全部），而不是 0 条也不是"全部命中"
  eq(filterMcpToolEntries(apiTools, { query: '---' }).total, apiTools.length, '纯标点')
})

// ───────────────────────────── D mcp_call_tool 入参改写 ─────────────────────────────

console.log('── D 网关调用改写（resolveMcpGatewayCall）──')
const routes = {
  mcp_a_echo: { toolName: 'echo', serverId: 'srv-1', dangerous: false },
}
it('D1 合法名字 ⇒ 改写成原生调用，参数原样带上', () => {
  const r = resolveMcpGatewayCall(routes, JSON.stringify({ name: 'mcp_a_echo', arguments: { msg: 'hi' } }))
  assert(r.ok, '应成功')
  if (r.ok) {
    eq(r.name, 'mcp_a_echo', 'name')
    eq(JSON.parse(r.arguments), { msg: 'hi' }, 'arguments')
  }
})
it('D2 名字不在目录 ⇒ 不抛，回一句可读原因', () => {
  const r = resolveMcpGatewayCall(routes, JSON.stringify({ name: 'mcp_a_nope' }))
  assert(!r.ok, '应失败')
  if (!r.ok) assert(r.output.includes('没有名为'), r.output)
})
it('D3 缺 name 参数 ⇒ 回一句可读原因', () => {
  const r = resolveMcpGatewayCall(routes, JSON.stringify({ arguments: {} }))
  assert(!r.ok, '应失败')
  if (!r.ok) assert(r.output.includes('缺少 name'), r.output)
})
/**
 * D5~D8：**本地参数体检**（2026-10-22）。判据只在 `gatewayModel.ts#findMcpArgumentIssues`：
 * 只拦"明显必错"的（必填缺失、顶层类型不符），不冒充上游的完整校验。
 */
const upsertSchema = {
  type: 'object',
  required: ['projectId', 'name'],
  properties: {
    projectId: { type: 'string' },
    name: { type: 'string' },
    variables: { type: 'object', additionalProperties: { type: 'string' } },
    limit: { type: 'integer' },
  },
}
it('D5 object 参数被序列化成字符串 ⇒ 本地拦下，并说清"实际是 string"', () => {
  const bad = resolveMcpGatewayCall(
    routes,
    JSON.stringify({
      name: 'mcp_a_echo',
      arguments: { projectId: 'p', name: 'n', variables: '{"k":"v"}' },
    }),
    { mcp_a_echo: upsertSchema },
  )
  assert(!bad.ok, '应被本地拦下')
  if (!bad.ok) {
    assert(bad.output.includes('变量') || bad.output.includes('variables'), bad.output)
    assert(bad.output.includes('实际给的是 string'), bad.output)
    assert(bad.output.includes('object'), bad.output)
    assert(bad.output.includes('不要把它序列化成字符串'), bad.output)
  }
})
it('D6 缺必填 ⇒ 本地拦下并点名缺哪个', () => {
  const r = resolveMcpGatewayCall(routes, JSON.stringify({ name: 'mcp_a_echo', arguments: { name: 'n' } }), {
    mcp_a_echo: upsertSchema,
  })
  assert(!r.ok, '应被本地拦下')
  if (!r.ok) {
    assert(r.output.includes('缺少必填参数 projectId'), r.output)
  }
})
it('D7 类型正确（含 object 与 integer）⇒ 放行，参数原样交给上游', () => {
  const r = resolveMcpGatewayCall(
    routes,
    JSON.stringify({
      name: 'mcp_a_echo',
      arguments: { projectId: 'p', name: 'n', variables: { k: 'v' }, limit: 3 },
    }),
    { mcp_a_echo: upsertSchema },
  )
  assert(r.ok, '应放行')
  if (r.ok) eq(JSON.parse(r.arguments), { projectId: 'p', name: 'n', variables: { k: 'v' }, limit: 3 }, 'arguments')
})
it('D8 没有 schema 时不做体检（不误伤老路径 / 拿不到定义的调用）', () => {
  const r = resolveMcpGatewayCall(
    routes,
    JSON.stringify({ name: 'mcp_a_echo', arguments: { variables: '{"k":"v"}' } }),
  )
  assert(r.ok, '无 schema 时不该本地拒绝')
})
it('D4 参数不是合法 JSON ⇒ 回一句可读原因', () => {
  const r = resolveMcpGatewayCall(routes, '{not json')
  assert(!r.ok, '应失败')
  if (!r.ok) assert(r.output.includes('工具调用失败'), r.output)
})

// ───────────────────────────── E 网关名字识别 ─────────────────────────────

console.log('── E 网关工具名（shared#isMcpGatewayToolName）──')
it('E1 只精确匹配两个网关名，真实工具名不算', () => {
  eq(isMcpGatewayToolName(MCP_LIST_TOOLS_TOOL_NAME), true, 'list')
  eq(isMcpGatewayToolName(MCP_CALL_TOOL_TOOL_NAME), true, 'call')
  eq(isMcpGatewayToolName('mcp_list_tools-2'), false, '带序号的真实工具不算')
  eq(isMcpGatewayToolName('knowledge_search'), false, '内置工具不算')
})

// ───────────────────────────── F 失败结果的表述（2026-10-22）─────────────────────────────

console.log('── F 失败结果的表述（禁止"没做成却说做成"）──')
it('F1 取消 / 超时文案都明写"本次没有任何执行结果"并禁止声称完成', () => {
  for (const text of [TOOL_CONFIRM_REJECTED_OUTPUT, TOOL_CONFIRM_TIMEOUT_OUTPUT]) {
    assert(text.includes('本次没有任何执行结果'), text)
    assert(text.includes('不得把这次操作描述为已完成'), text)
    assert(text.includes('不得引用历史消息里的 ID'), text)
  }
})
it('F2 收尾核对：只汇总失败的工具名（去重、保持出现顺序）', () => {
  const records = [
    { toolName: 'mcp_a_upsert', status: 'ERROR' },
    { toolName: 'mcp_a_delete', status: 'SUCCESS' },
    { toolName: 'mcp_a_upsert', status: 'ERROR' },
    { toolName: 'mcp_a_run', status: 'ERROR' },
  ]
  eq(failedToolNamesOf(records), ['mcp_a_upsert', 'mcp_a_run'], '失败工具名')
  eq(failedToolNamesOf([{ toolName: 'x', status: 'SUCCESS' }]), [], '全成功 ⇒ 空')
})
it('F3 没有失败 ⇒ 不加更正；有失败 ⇒ 更正里点名工具且开头可辨认', () => {
  eq(failedToolNotice([]), '', '空输入不产出提示')
  const notice = failedToolNotice(['mcp_a_upsert'])
  assert(notice.includes('mcp_a_upsert'), notice)
  assert(notice.includes('系统核对'), notice)
  assert(notice.includes('都不成立'), notice)
})
it('F4 OpenAI 兼容 / Responses 的工具失败结果带机器可读前缀；Anthropic 走 is_error', () => {
  const messages = [
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }] },
    { role: 'tool' as const, toolCallId: 'c1', content: '已取消', isError: true },
    { role: 'tool' as const, toolCallId: 'c2', content: 'ok', isError: false },
  ]
  type Row = Record<string, unknown>
  const pick = (rows: Row[], predicate: (row: Row) => boolean): Row => {
    const found = rows.find(predicate)
    if (found === undefined) throw new Error('没找到预期的那一条报文')
    return found
  }

  const openai = PROTOCOLS.OPENAI_COMPAT.buildBody({ model: 'm', messages }) as unknown as { messages: Row[] }
  const toolRow = pick(openai.messages, (row) => row['role'] === 'tool' && row['tool_call_id'] === 'c1')
  assert(String(toolRow['content']).startsWith(TOOL_RESULT_ERROR_PREFIX), JSON.stringify(toolRow))
  const okRow = pick(openai.messages, (row) => row['role'] === 'tool' && row['tool_call_id'] === 'c2')
  assert(okRow['content'] === 'ok', '成功结果不加前缀')

  const responses = PROTOCOLS.OPENAI_RESPONSES.buildBody({ model: 'm', messages }) as unknown as { input: Row[] }
  const out = pick(responses.input, (item) => item['type'] === 'function_call_output' && item['call_id'] === 'c1')
  assert(String(out['output']).startsWith(TOOL_RESULT_ERROR_PREFIX), JSON.stringify(out))

  const anthropic = PROTOCOLS.ANTHROPIC_MESSAGES.buildBody({ model: 'm', messages }) as unknown as {
    messages: { content: Row[] }[]
  }
  const blocks = anthropic.messages.flatMap((row) => row.content)
  const failed = pick(blocks, (block) => block['type'] === 'tool_result' && block['tool_use_id'] === 'c1')
  assert(failed['is_error'] === true, JSON.stringify(failed))
  assert(!String(failed['content']).includes(TOOL_RESULT_ERROR_PREFIX), 'Anthropic 有 is_error，不重复加前缀')
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
