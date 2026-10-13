#!/usr/bin/env node
/**
 * router-regression.ts —— 沙箱多机路由（P1-14 / P1-9 · R9）的**无 Redis / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend router:regression`
 *      （= `node --import tsx scripts/router-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06` §六 第 8/9 条；被测对象 = `shared/src/router.ts`（路由分类 / 键名 / 上游选择）
 *      + `backend/src/router/{config,gateway}.ts`（上游地址解析 / `host:port` 拆解）。
 *
 * ⚠️ 它验的是**纯判据**：粘性清单、键名构造、轮询游标推进、配置校验。它**验不了**端到端
 *    （要真 Redis + 多实例）：目录命中转发、owner 宕机降级、SSE 透传 —— 那些按 §六 第 30 条
 *    留给用户真跑（`子方案/沙箱多机部署.md` §八 6 的 R1~R6）。
 */

import {
  classifyRoute,
  isSandboxInstanceId,
  SANDBOX_INSTANCE_KEY_PREFIX,
  SANDBOX_OWNER_KEY_PREFIX_DEFAULT,
  sandboxInstanceKey,
  sandboxOwnerKey,
  selectUpstream,
} from '@doubulea/shared'

import { loadRouterConfig, parseUpstream } from '../src/router/config.js'
import { splitHostPort, UPSTREAM_COOLDOWN_MS } from '../src/router/gateway.js'

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
const CID = '11111111-2222-3333-4444-555555555555'
const sticky = (path: string, method = 'POST'): unknown => classifyRoute(method, path)

// ───────────────────────────── A 粘性路由分类 ─────────────────────────────

console.log('── A 路由分类（shared#classifyRoute）──')
it('A1 沙箱流三路由粘性：/chat、/stream、/regenerate', () => {
  eq(sticky(`/api/conversations/${CID}/chat`), { kind: 'sticky', conversationId: CID }, '/chat')
  eq(classifyRoute('GET', `/api/conversations/${CID}/stream`), { kind: 'sticky', conversationId: CID }, '/stream')
  eq(sticky(`/api/conversations/${CID}/regenerate`), { kind: 'sticky', conversationId: CID }, '/regenerate')
})
it('A2 工作区全部子路由粘性（含 SSE events / 字节出口 file/raw）', () => {
  for (const path of [
    `/api/conversations/${CID}/workspace`,
    `/api/conversations/${CID}/workspace/`,
    `/api/conversations/${CID}/workspace/changes`,
    `/api/conversations/${CID}/workspace/file`,
    `/api/conversations/${CID}/workspace/file/raw`,
    `/api/conversations/${CID}/workspace/move`,
    `/api/conversations/${CID}/workspace/revert`,
    `/api/conversations/${CID}/workspace/events`,
  ]) {
    eq(classifyRoute('GET', path), { kind: 'sticky', conversationId: CID }, path)
  }
})
it('A3 方法/query 不影响判据（粘性看路径，非粘性看是否在清单里）', () => {
  eq(classifyRoute('DELETE', `/api/conversations/${CID}/workspace/file?path=a.txt`), { kind: 'sticky', conversationId: CID }, '带 query')
  eq(sticky(`/api/conversations/${CID}/chat?x=1`), { kind: 'sticky', conversationId: CID }, '带 query 的 /chat')
  eq(sticky(`http://backend-a:13000/api/conversations/${CID}/chat`), { kind: 'sticky', conversationId: CID }, '绝对 URL')
})
it('★ A4 非粘性清单（落任意实例都正确）：stop/confirm/steer/auto-approve/active/code-mode/messages/recall', () => {
  for (const endpoint of ['stop', 'confirm', 'steer', 'auto-approve', 'code-mode', 'active', 'messages', 'recall']) {
    eq(classifyRoute('POST', `/api/conversations/${CID}/${endpoint}`), { kind: 'round-robin' }, endpoint)
  }
})
it('A5 非会话路由轮询（登录/列表/健康）', () => {
  eq(classifyRoute('POST', '/api/auth/login'), { kind: 'round-robin' }, '登录')
  eq(classifyRoute('GET', '/api/agents/x/conversations'), { kind: 'round-robin' }, '会话列表')
  eq(classifyRoute('GET', '/health'), { kind: 'round-robin' }, '健康检查')
})
it('A6 近似路径不误判（/workspaces、/chatty 不是工作区/chat）', () => {
  eq(classifyRoute('GET', `/api/conversations/${CID}/workspaces`), { kind: 'round-robin' }, 'workspaces')
  eq(classifyRoute('POST', `/api/conversations/${CID}/chatty`), { kind: 'round-robin' }, 'chatty')
})

// ───────────────────────────── B 键名 ─────────────────────────────

console.log('── B 键名（shared#sandboxOwnerKey / sandboxInstanceKey）──')
it('B1 会话目录键 = {prefix}:{conversationId}', () => {
  eq(sandboxOwnerKey(SANDBOX_OWNER_KEY_PREFIX_DEFAULT, CID), `sandbox:owner:${CID}`, '默认前缀')
  eq(sandboxOwnerKey('my:owner', 'abc'), 'my:owner:abc', '自定义前缀')
})
it('B2 实例注册键 = sandbox:instance:{id}', () => {
  eq(sandboxInstanceKey('b'), `${SANDBOX_INSTANCE_KEY_PREFIX}:b`, '实例键')
  eq(SANDBOX_INSTANCE_KEY_PREFIX, 'sandbox:instance', '前缀常量')
})
it('B3 实例 id 合法性（非空/无空白/≤120）', () => {
  eq(isSandboxInstanceId('b'), true, '普通')
  eq(isSandboxInstanceId('  b  '), false, '含空白一律拒（配置侧已 trim，这里不再宽容）')
  eq(isSandboxInstanceId(''), false, '空串')
  eq(isSandboxInstanceId('a b'), false, '含空格')
  eq(isSandboxInstanceId('a'.repeat(121)), false, '超长')
  eq(isSandboxInstanceId(123), false, '非字符串')
})

// ───────────────────────────── C 上游选择 ─────────────────────────────

console.log('── C 上游选择（shared#selectUpstream）──')
const U = ['a:13000', 'b:13000', 'c:13000']
it('C1 owner 命中且在线 ⇒ 粘性命中，且**不推进游标**', () => {
  eq(selectUpstream({ upstreams: U, owner: 'b:13000', cursor: 0 }), { target: 'b:13000', nextCursor: 0 }, '命中 owner')
})
it('C2 owner 不在线 / 未登记 ⇒ 轮询（游标推进）', () => {
  eq(selectUpstream({ upstreams: U, owner: 'gone:13000', cursor: 0 }), { target: 'a:13000', nextCursor: 1 }, 'owner 下线')
  eq(selectUpstream({ upstreams: U, owner: undefined, cursor: 1 }), { target: 'b:13000', nextCursor: 2 }, '无 owner')
  eq(selectUpstream({ upstreams: U, owner: undefined, cursor: 3 }), { target: 'a:13000', nextCursor: 4 }, '游标回绕')
})
it('C3 无上游 ⇒ target undefined（网关回 503）', () => {
  eq(selectUpstream({ upstreams: [], owner: 'a:13000', cursor: 0 }), { target: undefined, nextCursor: 0 }, '空表')
})

// ───────────────────────────── D 网关配置 / 地址 ─────────────────────────────

console.log('── D 网关配置（router/config.ts）──')
it('D1 parseUpstream 接受 host / host:port，拒绝非法', () => {
  eq(parseUpstream('b:13000'), 'b:13000', 'host:port')
  eq(parseUpstream('b '), 'b', 'host')
  eq(parseUpstream(''), null, '空')
  eq(parseUpstream('b:0'), null, '端口 0')
  eq(parseUpstream('b:70000'), null, '端口越界')
  eq(parseUpstream('http://b:13000'), null, '带 scheme')
})
it('★ D2 loadRouterConfig：缺 ROUTER_UPSTREAMS 大声失败', () => {
  const result = loadRouterConfig({})
  eq(result.config, undefined, '无配置')
  assert(result.errors.some((line) => line.includes('ROUTER_UPSTREAMS')), '错误里应点名 ROUTER_UPSTREAMS')
})
it('D3 loadRouterConfig：正常值 + 去重 + 默认端口/前缀', () => {
  const result = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000, b:13000 ,a:13000' })
  assert(result.config !== undefined, '应通过')
  eq(result.config?.upstreams, ['a:13000', 'b:13000'], '去重后的实例表')
  eq(result.config?.port, 13000, '默认端口')
  eq(result.config?.ownerKeyPrefix, 'sandbox:owner', '默认目录前缀')
  eq(result.config?.redisUrl, 'redis://127.0.0.1:6379', '默认 Redis')
})
it('D4 splitHostPort：缺省端口 80；IPv4 host:port 拆解', () => {
  eq(splitHostPort('b'), { host: 'b', port: 80 }, '无端口')
  eq(splitHostPort('172.17.0.9:13000'), { host: '172.17.0.9', port: 13000 }, 'IPv4')
})
it('D5 冷却常量是正整数（进程内降级窗口）', () => {
  assert(Number.isInteger(UPSTREAM_COOLDOWN_MS) && UPSTREAM_COOLDOWN_MS > 0, '冷却应 > 0')
})

console.log('')
console.log(`router-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
