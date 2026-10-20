#!/usr/bin/env node
/**
 * router-regression.ts —— 沙箱多机路由（P1-14 / P1-9 · R9）的**无 Redis / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend router:regression`
 *      （= `node --import tsx scripts/router-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06` §六 第 8/9 条；被测对象 = `shared/src/router.ts`（路由分类 / 键名 / 上游选择）
 *      + `shared/src/routerInstance.ts`（实例注册值契约，R1）+ `backend/src/router/{config,gateway,discovery}.ts`
 *      （上游地址解析 / `host:port` 拆解 / 自动发现快照）+ `backend/src/sandbox/roleOverride.ts`（沙箱角色，R1）。
 *
 * ⚠️ 它验的是**纯判据**：粘性清单、键名构造、轮询游标推进、配置校验。它**验不了**端到端
 *    （要真 Redis + 多实例）：目录命中转发、owner 宕机降级、SSE 透传 —— 那些按 §六 第 30 条
 *    留给用户真跑（`子方案/沙箱多机部署.md` §八 6 的 R1~R6）。
 */

import {
  classifyRoute,
  isAdvertiseAddr,
  instanceTargetOf,
  isLongRunningRoute,
  isSandboxInstanceId,
  mergeUpstreams,
  parseInstanceRegistration,
  parseInstanceRegistrationWithPort,
  parseInstanceLoad,
  SANDBOX_INSTANCE_KEY_PREFIX,
  SANDBOX_OWNER_KEY_PREFIX_DEFAULT,
  sandboxInstanceKey,
  sandboxOwnerKey,
  selectUpstream,
} from '@doubulea/shared'

import { loadRouterConfig, parseUpstream, resolveRouterEnvFile } from '../src/router/config.js'
import { buildDiscoverySnapshot } from '../src/router/discovery.js'
import { splitHostPort, UPSTREAM_COOLDOWN_MS } from '../src/router/gateway.js'
import { signNodeOpsToken, verifyNodeOpsToken } from '../src/sandbox/nodeOpsToken.js'
import { applySandboxRoleOverride, detectNodeRole, detectSandboxRole } from '../src/sandbox/roleOverride.js'

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
it('★ A7 长任务路由（shared#isLongRunningRoute）：只有清单内的 POST 才放宽超时', () => {
  eq(isLongRunningRoute('POST', '/api/admin/node/bootstrap'), true, '一键初始化')
  eq(isLongRunningRoute('POST', '/api/admin/node/bootstrap?x=1'), true, '带 query')
  eq(isLongRunningRoute('post', '/api/admin/node/bootstrap'), true, '方法小写')
  eq(isLongRunningRoute('GET', '/api/admin/node/bootstrap'), false, 'GET 不算')
  eq(isLongRunningRoute('POST', '/api/admin/node/self'), false, '自检（只读、秒级）不算')
  eq(isLongRunningRoute('POST', '/api/admin/nodes/bootstrap'), false, '近似路径不误判')
  eq(isLongRunningRoute('POST', '/api/admin/node/bootstrap/extra'), false, '更深的子路径不算')
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
/** 只看 target / nextCursor（R3 起结论多了 `reason`，老断言的口径不变） */
const pick = (input: Parameters<typeof selectUpstream>[0]): { target: string | undefined; nextCursor: number } => {
  const { target, nextCursor } = selectUpstream(input)
  return { target, nextCursor }
}
it('C1 owner 命中且在线 ⇒ 粘性命中，且**不推进游标**', () => {
  eq(pick({ upstreams: U, owner: 'b:13000', cursor: 0 }), { target: 'b:13000', nextCursor: 0 }, '命中 owner')
})
it('C2 owner 不在线 / 未登记 ⇒ 轮询（游标推进）', () => {
  eq(pick({ upstreams: U, owner: 'gone:13000', cursor: 0 }), { target: 'a:13000', nextCursor: 1 }, 'owner 下线')
  eq(pick({ upstreams: U, owner: undefined, cursor: 1 }), { target: 'b:13000', nextCursor: 2 }, '无 owner')
  eq(pick({ upstreams: U, owner: undefined, cursor: 3 }), { target: 'a:13000', nextCursor: 4 }, '游标回绕')
})
it('C3 无上游 ⇒ target undefined（网关回 503）', () => {
  eq(pick({ upstreams: [], owner: 'a:13000', cursor: 0 }), { target: undefined, nextCursor: 0 }, '空表')
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
it('★ D2 loadRouterConfig：缺 ROUTER_UPSTREAMS 且关了自动发现 ⇒ 大声失败', () => {
  const result = loadRouterConfig({ ROUTER_DISCOVERY_SEC: '0' })
  eq(result.config, undefined, '无配置')
  assert(result.errors.some((line) => line.includes('ROUTER_UPSTREAMS')), '错误里应点名 ROUTER_UPSTREAMS')
})
it('★ D2b loadRouterConfig：只开自动发现（静态表空）也可以启动', () => {
  const result = loadRouterConfig({ ROUTER_UPSTREAMS: '', ROUTER_DISCOVERY_SEC: '10' })
  assert(result.config !== undefined, `应通过，实际：${result.errors.join(' / ')}`)
  eq(result.config?.upstreams, [], '静态种子为空')
  eq(result.config?.discoveryIntervalMs, 10_000, '发现间隔')
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
it('★ D6 loadRouterConfig：R1 新变量的默认值 / 校验', () => {
  const ok = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000' }).config
  assert(ok !== undefined, '应通过')
  eq(ok?.discoveryIntervalMs, 10_000, 'ROUTER_DISCOVERY_SEC 默认 10s')
  eq(ok?.instanceTtlMs, 90_000, '注册项 TTL = 3× 默认心跳 30s')
  eq(ok?.fallbackBackendPort, 3000, 'BACKEND_PORT 默认 3000')
  const noHeartbeat = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', SANDBOX_INSTANCE_HEARTBEAT_SEC: '0' }).config
  eq(noHeartbeat?.instanceTtlMs, 120_000, '关心跳 ⇒ 120s（与后端 instanceRegistrationTtlSec 同式）')
  const bad = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_DISCOVERY_SEC: '-1', BACKEND_PORT: 'x' })
  eq(bad.config, undefined, '非法值应拒')
  assert(bad.errors.some((line) => line.includes('ROUTER_DISCOVERY_SEC')), '点名 ROUTER_DISCOVERY_SEC')
  assert(bad.errors.some((line) => line.includes('BACKEND_PORT')), '点名 BACKEND_PORT')
})
it('★ D7 resolveRouterEnvFile：两个开关（与后端同名同义）', () => {
  eq(resolveRouterEnvFile({ DOUBULEA_SKIP_ENV_FILE: '1' }).path, undefined, '跳过开关生效')
  eq(resolveRouterEnvFile({ DOUBULEA_ENV_FILE: '/definitely/not/here.env' }).path, undefined, '显式指向不存在的文件 ⇒ 不加载')
})

// ───────────────────────────── E 实例注册值（R1 自动发现的契约）─────────────────────────────

console.log('── E 实例注册值（shared#parseInstanceRegistration* / mergeUpstreams）──')
const REG = JSON.stringify({ instanceId: 'b', advertiseAddr: 'b:13000', pid: 42, host: 'host-b', startedAt: 1_700_000_000_000 })
it('E1 parseInstanceRegistration：合法值 + 键后缀一致', () => {
  eq(parseInstanceRegistration(REG, 'b')?.advertiseAddr, 'b:13000', '解析出地址')
  eq(parseInstanceRegistration(REG, 'c'), undefined, '键后缀与 instanceId 不一致 ⇒ 无效')
  eq(parseInstanceRegistration('not-json'), undefined, '非 JSON')
  eq(parseInstanceRegistration(null), undefined, '空值')
})
it('★ E2 parseInstanceRegistration：advertiseAddr 必须带端口（少了会转发到 80，属配置漏写）', () => {
  const noPort = JSON.stringify({ instanceId: 'b', advertiseAddr: 'b', pid: 42, host: 'host-b', startedAt: 1 })
  eq(parseInstanceRegistration(noPort, 'b'), undefined, '严格版拒')
  eq(parseInstanceRegistrationWithPort(noPort, 3000, 'b')?.advertiseAddr, 'b:3000', '兼容版按后端端口补全')
  eq(parseInstanceRegistrationWithPort(noPort, 3000, 'c'), undefined, '补全后仍校验键后缀')
})
it('E3 isAdvertiseAddr：host:port 必填、端口范围', () => {
  eq(isAdvertiseAddr('b:13000'), true, '正常')
  eq(isAdvertiseAddr('b'), false, '缺端口')
  eq(isAdvertiseAddr('b:0'), false, '端口 0')
  eq(isAdvertiseAddr('b:65536'), false, '越界')
})
it('E4 mergeUpstreams：静态在前、发现到的去重追加', () => {
  const regs = [
    parseInstanceRegistration(JSON.stringify({ ...JSON.parse(REG), instanceId: 'c', advertiseAddr: 'c:13000' }), 'c'),
    parseInstanceRegistration(REG, 'b'),
  ].filter((item) => item !== undefined)
  const merged = mergeUpstreams(['a:13000', 'b:13000'], regs)
  eq(merged.upstreams, ['a:13000', 'b:13000', 'c:13000'], '静态表优先 + 去重')
  eq(merged.discovered, ['c:13000'], '只有 c 是自动发现的')
})

// ───────────────────────────── F 自动发现快照（纯函数）─────────────────────────────

console.log('── F 自动发现（router/discovery.ts#buildDiscoverySnapshot）──')
it('★ F1 静态种子保留 + 发现到的追加 + id→地址映射（粘性翻译用）', () => {
  const { snapshot } = buildDiscoverySnapshot(
    { seed: ['a:13000'], fallbackPort: 3000, ttlMs: 90_000, now: () => 1_000_000 },
    [`${SANDBOX_INSTANCE_KEY_PREFIX}:b`],
    [REG],
    new Map(),
  )
  eq(snapshot.upstreams, ['a:13000', 'b:13000'], '上游表')
  eq(snapshot.targets, { b: 'b:13000' }, '实例 id → 地址')
  eq(snapshot.discovered, ['b:13000'], '发现到的')
  eq(snapshot.stale, [], '刚看见 ⇒ 不过期')
})
it('★ F2 过期项仍在上游表里（只排后，不摘除）', () => {
  const seen = new Map([['b:13000', 0]])
  const { snapshot } = buildDiscoverySnapshot(
    { seed: ['a:13000'], fallbackPort: 3000, ttlMs: 1_000, now: () => 5_000 },
    [`${SANDBOX_INSTANCE_KEY_PREFIX}:b`],
    [REG],
    seen,
  )
  eq(snapshot.upstreams, ['a:13000', 'b:13000'], '仍在表里')
})
it('F3 坏值 / 键后缀不匹配的注册项被丢弃（不污染上游表）', () => {
  const { snapshot } = buildDiscoverySnapshot(
    { seed: [], fallbackPort: 3000, ttlMs: 1_000, now: () => 1 },
    [`${SANDBOX_INSTANCE_KEY_PREFIX}:b`, `${SANDBOX_INSTANCE_KEY_PREFIX}:c`],
    ['garbage', REG],
    new Map(),
  )
  eq(snapshot.upstreams, [], '只保留解析通过的（c 的键与 instanceId=b 不匹配）')
})

it('★ F4 未就绪（ready=false）进 snapshot.unready：网关据此剔除候选；未上报不算未就绪', () => {
  const reg = (id: string, ready?: boolean) =>
    JSON.stringify({ instanceId: id, advertiseAddr: `${id}:13000`, pid: 1, host: `h-${id}`, startedAt: 1, ...(ready === undefined ? {} : { ready }) })
  const options = { seed: [] as string[], fallbackPort: 3000, ttlMs: 90_000, now: () => 1_000_000 }
  const { snapshot } = buildDiscoverySnapshot(
    options,
    [`${SANDBOX_INSTANCE_KEY_PREFIX}:a`, `${SANDBOX_INSTANCE_KEY_PREFIX}:b`, `${SANDBOX_INSTANCE_KEY_PREFIX}:c`],
    [reg('a', true), reg('b', false), reg('c')],
    new Map(),
  )
  eq(snapshot.unready, ['b:13000'], '只有明确 ready=false 的那台')
  eq(snapshot.upstreams, ['a:13000', 'b:13000', 'c:13000'], '未就绪**仍在上游表**里（摘不摘由网关决定）')
})

// ───────────────────────────── G 沙箱角色（R1：同一镜像跑后端与网关）─────────────────────────────

console.log('── G 沙箱角色（sandbox/roleOverride.ts）──')
it('★ G1 显式声明优先（compose 给网关写 router）', () => {
  const router = detectSandboxRole({ DOUBULEA_SANDBOX_ROLE: 'router', SANDBOX_IMAGE: 'x:1' }, () => true)
  eq([router.role, router.source], ['router', 'explicit'], '网关')
  const backend = detectSandboxRole({ DOUBULEA_SANDBOX_ROLE: 'backend' }, () => false)
  eq([backend.role, backend.source], ['backend', 'explicit'], '后端（即使本机看不到 socket 也按声明）')
})
it('★ G2 未声明时推断：配了镜像 + Docker 可达 ⇒ 宿主；否则非宿主', () => {
  eq(detectSandboxRole({ SANDBOX_IMAGE: 'x:1' }, () => true).role, 'backend', '镜像 + socket')
  eq(detectSandboxRole({ SANDBOX_IMAGE: 'x:1' }, () => false).role, 'router', '镜像但无 socket（共用 env 的网关）')
  eq(detectSandboxRole({}, () => true).role, 'router', '无镜像')
  eq(detectSandboxRole({ DOCKER_HOST: 'tcp://1.2.3.4:2375', SANDBOX_IMAGE: 'x:1' }, () => false).role, 'backend', 'DOCKER_HOST 也算可达')
})
it('★ G3 非法声明 ⇒ 按非宿主（不猜、不冒险）', () => {
  eq(detectSandboxRole({ DOUBULEA_SANDBOX_ROLE: 'worker', SANDBOX_IMAGE: 'x:1' }, () => true).role, 'router', '未知取值')
})
it('★ G4 applySandboxRoleOverride：只改 enabled；网关必须被关掉', () => {
  const gate = { enabled: true }
  eq(applySandboxRoleOverride(gate, { DOUBULEA_SANDBOX_ROLE: 'router' }).enabled, false, '网关')
  const host = { enabled: true }
  eq(applySandboxRoleOverride(host, { DOUBULEA_SANDBOX_ROLE: 'backend' }).enabled, true, '后端保持')
  eq(applySandboxRoleOverride(host, { DOUBULEA_SANDBOX_ROLE: 'backend' }).wasEnabled, true, '记录原值')
})

// ───────────────────────────── H 负载感知（R3：P2C 选择）─────────────────────────────

console.log('── H 负载感知（shared#selectUpstream · P2C）──')
/** 固定随机源：按给定序列返回（用尽后重复最后一个） */
const seq = (...values: number[]): (() => number) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)] as number
}
const load = (slotsUsed: number, slotsTotal: number, queueDepth = 0, chatbotInFlight = 0) => ({
  slotsUsed,
  slotsTotal,
  queueDepth,
  chatbotInFlight,
  sampledAt: 1_000,
})
const cand = (target: string, l?: ReturnType<typeof load>, stale = false) =>
  l === undefined ? { target } : { target, load: l, stale }
it('★ H1 不带负载 ⇒ 与 R9 逐字一致（轮询 + 游标推进 + reason=round-robin）', () => {
  eq(selectUpstream({ upstreams: U, cursor: 1 }), { target: 'b:13000', nextCursor: 2, reason: 'round-robin' }, '无负载')
  eq(selectUpstream({ upstreams: U, cursor: 0, loadAware: true }), { target: 'a:13000', nextCursor: 1, reason: 'round-robin' }, '开了开关但没数据')
})
it('★ H2 粘性永远优先（不看负载），且不推进游标', () => {
  const candidates = [cand('a:13000', load(10, 10, 9)), cand('b:13000', load(0, 10))]
  eq(selectUpstream({ candidates, owner: 'a:13000', cursor: 0, loadAware: true, random: seq(0) }), {
    target: 'a:13000',
    nextCursor: 0,
    reason: 'sticky',
  }, 'owner 满载也照样转发')
})
it('★ H3 P2C：随机取两台，挑占用率较低的那台', () => {
  // 三台：a 满、b 空、c 半。随机取 [a,b] / [a,c] / [b,c] 三种组合
  const candidates = [cand('a:13000', load(4, 4)), cand('b:13000', load(0, 4)), cand('c:13000', load(2, 4))]
  eq(selectUpstream({ candidates, cursor: 0, loadAware: true, random: seq(0, 0) }), { target: 'b:13000', nextCursor: 1, reason: 'load' }, '[a,b] ⇒ b')
  eq(selectUpstream({ candidates, cursor: 0, loadAware: true, random: seq(1) }), { target: 'c:13000', nextCursor: 1, reason: 'load' }, '[c,a] ⇒ c')
  eq(selectUpstream({ candidates, cursor: 0, loadAware: true, random: seq(1 / 3, 1) }), { target: 'b:13000', nextCursor: 1, reason: 'load' }, '[b,c] ⇒ b')
})
it('★ H4 占用率相同 ⇒ 比队深；再相同 ⇒ 比 ChatBot 在飞（三级字典序）', () => {
  const queue = [cand('a:13000', load(2, 4, 5)), cand('b:13000', load(2, 4, 1))]
  eq(selectUpstream({ candidates: queue, cursor: 0, loadAware: true, random: seq(0) }).target, 'b:13000', '队深浅者优先')
  const inflight = [cand('a:13000', load(2, 4, 1, 3)), cand('b:13000', load(2, 4, 1, 0))]
  eq(selectUpstream({ candidates: inflight, cursor: 0, loadAware: true, random: seq(0) }).target, 'b:13000', 'ChatBot 少者优先')
})
it('★ H5 全平 ⇒ 按游标打破平局（cursor 偶取先看的那台、奇取另一台）', () => {
  const candidates = [cand('a:13000', load(1, 4)), cand('b:13000', load(1, 4))]
  eq(selectUpstream({ candidates, cursor: 0, loadAware: true, random: seq(0) }).target, 'a:13000', 'cursor 偶 ⇒ 先看游标那台')
  eq(selectUpstream({ candidates, cursor: 1, loadAware: true, random: seq(0) }).target, 'a:13000', 'cursor 奇 ⇒ 先看邻居（b），平局回落到 a')
  eq(selectUpstream({ candidates, cursor: 1, loadAware: true, random: seq(1) }).target, 'b:13000', 'cursor 奇且随机取到 b ⇒ b 在前')
})
it('★ H6 降级：负载过期 / 过期标记 / 只有一台有负载 ⇒ 退回轮询', () => {
  const stale = [cand('a:13000', load(4, 4), true), cand('b:13000', load(0, 4), true)]
  eq(selectUpstream({ candidates: stale, cursor: 0, loadAware: true, random: seq(0) }), {
    target: 'a:13000',
    nextCursor: 1,
    reason: 'round-robin',
  }, '全部过期')
  const single = [cand('a:13000', load(4, 4)), cand('b:13000')]
  eq(selectUpstream({ candidates: single, cursor: 1, loadAware: true, random: seq(0) }), {
    target: 'b:13000',
    nextCursor: 2,
    reason: 'round-robin',
  }, '只有一台有新鲜负载')
  eq(selectUpstream({ candidates: [cand('a:13000', load(0, 4))], cursor: 0, loadAware: true }).reason, 'round-robin', '单实例')
})
it('★ H7 kill switch：loadAware=false 时即使有负载也按轮询', () => {
  const candidates = [cand('a:13000', load(4, 4)), cand('b:13000', load(0, 4))]
  eq(selectUpstream({ candidates, cursor: 0, loadAware: false, random: seq(0) }), {
    target: 'a:13000',
    nextCursor: 1,
    reason: 'round-robin',
  }, '关掉开关')
})
it('★ H8 空表 ⇒ reason=none', () => {
  eq(selectUpstream({ upstreams: [], cursor: 0, loadAware: true }), { target: undefined, nextCursor: 0, reason: 'none' }, '空表')
})
it('★ H9 parseInstanceLoad：负载字段校验（坏值 ⇒ 不带负载，但注册值仍有效）', () => {
  eq(parseInstanceLoad(load(1, 4)), load(1, 4), '正常')
  eq(parseInstanceLoad({ ...load(1, 4), slotsUsed: 5 }), undefined, '占用 > 上限')
  eq(parseInstanceLoad({ ...load(1, 4), queueDepth: -1 }), undefined, '负数')
  eq(parseInstanceLoad({ ...load(1, 4), sampledAt: 0 }), undefined, '采样时刻非法')
  eq(parseInstanceLoad(undefined), undefined, '无负载')
  const withBadLoad = JSON.stringify({ ...JSON.parse(REG), load: { slotsUsed: 'x' } })
  eq(parseInstanceRegistration(withBadLoad, 'b')?.advertiseAddr, 'b:13000', '坏负载不作废整条注册值')
  const withLoad = JSON.stringify({ ...JSON.parse(REG), load: load(2, 4, 1, 0) })
  eq(parseInstanceRegistration(withLoad, 'b')?.load, load(2, 4, 1, 0), '好负载被解析出来')
})

// ───────────────────────────── I 负载进快照（R3/R4）─────────────────────────────

console.log('── I 负载进快照 + 配置（router/discovery.ts / router/config.ts）──')
it('★ I1 buildDiscoverySnapshot：负载进 loads / candidates；静态种子没有负载', () => {
  const withLoad = (id: string, addr: string, l: ReturnType<typeof load>) =>
    JSON.stringify({ instanceId: id, advertiseAddr: addr, pid: 1, host: `h-${id}`, startedAt: 1, load: l })
  const { snapshot } = buildDiscoverySnapshot(
    { seed: ['a:13000'], fallbackPort: 3000, ttlMs: 90_000, loadStaleMs: 60_000, now: () => 100_000 },
    [`${SANDBOX_INSTANCE_KEY_PREFIX}:b`],
    [withLoad('b', 'b:13000', load(1, 4, 2, 1))],
    new Map(),
  )
  eq(snapshot.loads['b:13000']?.load, load(1, 4, 2, 1), '负载')
  eq(snapshot.loads['b:13000']?.stale, true, 'sampledAt=1s、now=100s ⇒ 99s 前采样，超过 60s 判过期')
  eq(snapshot.candidates, [{ target: 'a:13000' }, { target: 'b:13000', load: load(1, 4, 2, 1), stale: true }], '候选视图')
})
it('★ I2 新鲜度看采样时刻：sampledAt 新 ⇒ 不过期；旧 ⇒ 过期', () => {
  const records = (sampledAt: number) =>
    JSON.stringify({ instanceId: 'b', advertiseAddr: 'b:13000', pid: 1, host: 'h', startedAt: 1, load: { ...load(1, 4), sampledAt } })
  const options = { seed: [] as string[], fallbackPort: 3000, ttlMs: 1_000, loadStaleMs: 60_000, now: () => 100_000 }
  eq(buildDiscoverySnapshot(options, [`${SANDBOX_INSTANCE_KEY_PREFIX}:b`], [records(99_000)], new Map()).snapshot.loads['b:13000']?.stale, false, '1s 前采样')
  eq(buildDiscoverySnapshot(options, [`${SANDBOX_INSTANCE_KEY_PREFIX}:b`], [records(1_000)], new Map()).snapshot.loads['b:13000']?.stale, true, '99s 前采样')
})
it('★ I3 loadRouterConfig：ROUTER_LOAD_AWARE 默认开 / 可关 / 非法拒；ROUTER_LOAD_STALE_MS 派生 2× 心跳', () => {
  const ok = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000' }).config
  eq([ok?.loadAware, ok?.loadStaleMs], [true, 60_000], '默认开 + 派生 60s')
  eq(loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_LOAD_AWARE: 'false' }).config?.loadAware, false, 'kill switch')
  eq(
    loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', SANDBOX_INSTANCE_HEARTBEAT_SEC: '15' }).config?.loadStaleMs,
    30_000,
    '调快心跳 ⇒ 阈值自动 30s',
  )
  eq(
    loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_LOAD_STALE_MS: '5000' }).config?.loadStaleMs,
    5_000,
    '显式配置覆盖派生值',
  )
  const bad = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_LOAD_AWARE: 'maybe', ROUTER_LOAD_STALE_MS: '10' })
  eq(bad.config, undefined, '非法值应拒')
  assert(bad.errors.some((line) => line.includes('ROUTER_LOAD_AWARE')), '点名 ROUTER_LOAD_AWARE')
  assert(bad.errors.some((line) => line.includes('ROUTER_LOAD_STALE_MS')), '点名 ROUTER_LOAD_STALE_MS')
})
it('★ I4 loadRouterConfig：ROUTER_UPSTREAM_TIMEOUT_LONG_MS 默认 15 分钟 / 可配 / 不得小于普通上限', () => {
  const ok = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000' }).config
  eq(ok?.upstreamTimeoutLongMs, 900_000, '默认 15 分钟（与 nodeOps 转发上限对齐）')
  eq(
    loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_UPSTREAM_TIMEOUT_LONG_MS: '1200000' }).config?.upstreamTimeoutLongMs,
    1_200_000,
    '显式配置生效',
  )
  const bad = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_UPSTREAM_TIMEOUT_LONG_MS: '500' })
  eq(bad.config, undefined, '低于 1s 应拒')
  assert(bad.errors.some((line) => line.includes('ROUTER_UPSTREAM_TIMEOUT_LONG_MS')), '点名变量')
  const inverted = loadRouterConfig({ ROUTER_UPSTREAMS: 'a:13000', ROUTER_UPSTREAM_TIMEOUT_LONG_MS: '5000' })
  eq(inverted.config, undefined, '小于普通上限应拒（长任务只会更慢）')
})

it('★ J1 运行时能力进注册值：合法列表被保留、去重；空数组 = 明确没有（不是未知）', () => {
  const base = { instanceId: 'b', advertiseAddr: 'b:13000', pid: 1, host: 'h', startedAt: 1 }
  eq(parseInstanceRegistration(JSON.stringify({ ...base, runtimes: ['node22-python310', 'node22-python310', ' java17 '] }), 'b')?.runtimes, ['node22-python310', 'java17'], '去重 + 去空白')
  eq(parseInstanceRegistration(JSON.stringify({ ...base, runtimes: [] }), 'b')?.runtimes, [], '空数组保留')
  eq(parseInstanceRegistration(JSON.stringify(base), 'b')?.runtimes, undefined, '老注册值没有该字段 ⇒ undefined（未知）')
})
it('★ J2 坏运行时字段不作废整条注册值（与坏 load 同一条纪律）', () => {
  const base = { instanceId: 'b', advertiseAddr: 'b:13000', pid: 1, host: 'h', startedAt: 1 }
  const parsed = parseInstanceRegistration(JSON.stringify({ ...base, runtimes: { nope: true } }), 'b')
  eq(parsed?.advertiseAddr, 'b:13000', '注册值仍有效')
  eq(parsed?.runtimes, undefined, '坏值被丢弃')
  eq(parseInstanceRegistration(JSON.stringify({ ...base, runtimes: [1, null, ''] }), 'b')?.runtimes, [], '非字符串项被跳过')
})

it('★ J4 instanceTargetOf：只认合法实例 id（query 与任务路径两种形态；否则 undefined ⇒ 轮询）', () => {
  eq(instanceTargetOf('/api/sandbox/runtimes/build?instanceId=b'), 'b', '启动端点 query')
  eq(instanceTargetOf('/api/sandbox/runtimes/build?a=1&instanceId=b%20c'), undefined, '非法 id（含空白）忽略')
  eq(instanceTargetOf('/api/sandbox/runtimes/build/b/abc-123'), 'b', '任务状态路径')
  eq(instanceTargetOf('/api/sandbox/runtimes/build/b/abc-123/cancel'), undefined, '取消路径（三段）不由这里点名')
  eq(instanceTargetOf('/api/sandbox/runtimes/build/abc-123'), undefined, '旧单段路径不点名')
  eq(instanceTargetOf('/api/conversations/x/chat'), undefined, '其它路由不点名')
})
it('★ J5 selectUpstream 点名优先：粘性 > 点名 > P2C；点名不在表里 ⇒ 忽略', () => {
  const base = { upstreams: ['a:1', 'b:1'], cursor: 0, loadAware: true, random: () => 0.99 }
  eq(selectUpstream({ ...base, pinned: 'b:1' }), { target: 'b:1', nextCursor: 0, reason: 'pinned' }, '点名且不推进游标')
  eq(selectUpstream({ ...base, owner: 'a:1', pinned: 'b:1' }).reason, 'sticky', '粘性仍优先')
  eq(selectUpstream({ ...base, pinned: 'z:1' }).reason !== 'pinned', true, '点名不在表里 ⇒ 走原口径')
})
it('★ J6 就绪进注册值：ready/missing/hostPlatform/needsRelay 被保留；坏值不猜', () => {
  const base = { instanceId: 'b', advertiseAddr: 'b:13000', pid: 1, host: 'h', startedAt: 1 }
  const ok = parseInstanceRegistration(
    JSON.stringify({ ...base, ready: false, missing: ['egress', ' ', 'relay'], hostPlatform: 'linux', needsRelay: false }),
    'b',
  )
  eq(ok?.ready, false, 'ready=false 保留（可见但不可选）')
  eq(ok?.missing, ['egress', 'relay'], '空项被滤掉')
  eq(ok?.hostPlatform, 'linux', '平台')
  eq(ok?.needsRelay, false, 'needsRelay')
  eq(parseInstanceRegistration(JSON.stringify({ ...base, ready: 'yes' }), 'b')?.ready, undefined, '非布尔 ⇒ 未知')
})
it('★ J3 canBuild 进注册值：布尔值被保留；其它类型 ⇒ 字段缺失（不猜）', () => {
  const base = { instanceId: 'b', advertiseAddr: 'b:13000', pid: 1, host: 'h', startedAt: 1 }
  eq(parseInstanceRegistration(JSON.stringify({ ...base, canBuild: true }), 'b')?.canBuild, true, 'true 保留')
  eq(parseInstanceRegistration(JSON.stringify({ ...base, canBuild: false }), 'b')?.canBuild, false, 'false 保留')
  eq(parseInstanceRegistration(JSON.stringify({ ...base, canBuild: 'yes' }), 'b')?.canBuild, undefined, '字符串 ⇒ 未知')
})

it('★ K1 节点档位：chatbot 关掉沙箱；taskAgent 不关；非法值不猜', () => {
  const sandbox = { enabled: true }
  const chatbot = applySandboxRoleOverride(sandbox, { DOUBULEA_SANDBOX_ROLE: 'backend', DOUBULEA_NODE_ROLE: 'chatbot' }, () => true)
  eq(chatbot.enabled, false, 'chatbot ⇒ 不建容器')
  eq(chatbot.nodeRole, 'chatbot', '档位被识别')
  const task = applySandboxRoleOverride({ enabled: true }, { DOUBULEA_SANDBOX_ROLE: 'backend', DOUBULEA_NODE_ROLE: 'taskAgent' }, () => true)
  eq(task.enabled, true, 'taskAgent ⇒ 正常启用')
  eq(detectNodeRole({ DOUBULEA_NODE_ROLE: 'bogus' }), undefined, '非法档位 ⇒ undefined')
})
it('★ K2 跨实例令牌：签名/受众/过期；错密钥与错受众一律拒', () => {
  const secret = 'test-secret'
  // `now` 是**毫秒**（内部换算成 epoch 秒），TTL 60s ⇒ 验证时刻放在签发后 10s
  const token = signNodeOpsToken({ iss: 'a', aud: 'b', op: 'bootstrap' }, { secret, now: 1_000_000_000 }) as string
  const okVerdict = verifyNodeOpsToken(token, 'b', { secret, now: 1_000_010_000 })
  eq(okVerdict.ok, true, '正常令牌通过')
  eq(verifyNodeOpsToken(token, 'c', { secret, now: 1_000_010_000 }).ok, false, '受众不符 ⇒ 拒')
  eq(verifyNodeOpsToken(token, 'b', { secret: 'other', now: 1_000_010_000 }).ok, false, '密钥不符 ⇒ 拒')
  eq(verifyNodeOpsToken(token, 'b', { secret, now: 1_000_200_000 }).ok, false, '过期 ⇒ 拒')
  eq(verifyNodeOpsToken('garbage', 'b', { secret }).ok, false, '结构坏 ⇒ 拒')
})

console.log('')
console.log(`router-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
