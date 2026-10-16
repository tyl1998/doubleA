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
  filterMcpToolEntries,
  formatMcpToolCatalog,
  selectMcpInlineTools,
  type McpCatalogToolEntry,
} from '../src/mcp/gatewayModel.js'
import { resolveMcpGatewayCall } from '../src/orchestrator/mcpGatewayTools.js'

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
  assert(text.includes('其余 50 个未列出'), '排版应写明未列出的条数')
})
it('C4 无命中 ⇒ 明说没有，不假装"没有工具"', () => {
  const text = formatMcpToolCatalog(filterMcpToolEntries(entries(3), { query: 'zzz' }))
  assert(text.includes('没有匹配的 MCP 工具'), text)
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

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
