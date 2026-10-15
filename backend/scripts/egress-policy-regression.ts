#!/usr/bin/env node
/**
 * egress-policy-regression.ts —— 沙箱出网策略（egress 黑白名单）的**无 DB / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend egress:regression`
 *      （= `node --import tsx scripts/egress-policy-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.5；被测对象 = `shared/src/egressPolicy.ts`（纯判据）。
 *
 * ⚠️ 它验的是**纯函数语义**：模式推导、规则匹配、deny 优先的判定顺序、归一化丢非法。
 *    它与 `infra/scripts/egress-proxy.mjs` 的 `matchRule`/`decide` **是两份实现**（代理是零依赖 .mjs，
 *    不引仓内代码）⇒ 本档钉住 TS 这份的语义，代理侧另有 `node --check` + 冒烟（见 `egress-up.sh` 输出）。
 */

import {
  decideEgress,
  deriveEgressMode,
  EGRESS_GIT_HOSTS,
  EGRESS_REGISTRY_HOSTS,
  EGRESS_SCOPES,
  matchEgressRule,
  normalizeEgressHostEntry,
  normalizeEgressHostList,
  resolveEgressPolicy,
} from '@doubulea/shared'

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n    实际 ${a}\n    期望 ${e}`)
}

console.log('egress-policy-regression —— egress 黑白名单\n')

it('归一化：合法形态 host / host:port / *.host / *', () => {
  assertEqual(normalizeEgressHostEntry('Example.COM'), 'example.com', 'host 小写')
  assertEqual(normalizeEgressHostEntry(' github.com:443 '), 'github.com:443', 'host:port 去空白')
  assertEqual(normalizeEgressHostEntry('*.github.com'), '*.github.com', '通配子域')
  assertEqual(normalizeEgressHostEntry('*'), '*', '显式全放行')
})

it('归一化：非法形态一律 null（不做"最接近的猜测"）', () => {
  assertEqual(normalizeEgressHostEntry(''), null, '空串')
  assertEqual(normalizeEgressHostEntry('foo bar'), null, '含空白')
  assertEqual(normalizeEgressHostEntry('https://github.com/x'), null, 'URL 不是主机（含 /）')
  assertEqual(normalizeEgressHostEntry('foo.*.com'), null, '通配不在最左段')
  assertEqual(normalizeEgressHostEntry('github.com:99999'), null, '端口越界')
  assertEqual(normalizeEgressHostEntry('a..b'), null, '空标签')
  assertEqual(normalizeEgressHostEntry(123), null, '非字符串')
})

it('归一化列表：丢非法 + 去重 + 保序', () => {
  assertEqual(
    normalizeEgressHostList(['B.com', 'a.com', 'b.com', 'bad host', '*.x.com']),
    ['b.com', 'a.com', '*.x.com'],
    '去重保序、丢非法',
  )
  assertEqual(normalizeEgressHostList([]), [], '空数组')
})

it('模式推导：都空=全放行 / 只白=白名单 / 只黑=黑名单 / 都有=白名单(deny 优先)', () => {
  assertEqual(deriveEgressMode([], []), 'ALLOW_ALL', '都空 ⇒ 全放行')
  assertEqual(deriveEgressMode(['a.com'], []), 'WHITELIST', '只白 ⇒ 白名单')
  assertEqual(deriveEgressMode([], ['bad.com']), 'BLACKLIST', '只黑 ⇒ 黑名单')
  assertEqual(deriveEgressMode(['a.com'], ['bad.com']), 'WHITELIST', '都有 ⇒ 白名单（deny 优先）')
  assertEqual(deriveEgressMode(['*'], []), 'ALLOW_ALL', 'allow 含 * ⇒ 全放行')
})

it('规则匹配：host / host:port / *.host / *', () => {
  assert(matchEgressRule('github.com', 'github.com', 443), '精确主机')
  assert(!matchEgressRule('github.com', 'evil.com', 443), '不同主机不命中')
  assert(matchEgressRule('github.com:443', 'github.com', 443), '端口相等命中')
  assert(!matchEgressRule('github.com:443', 'github.com', 80), '端口不等不命中')
  assert(matchEgressRule('*.github.com', 'github.com', 443), '通配命中根域')
  assert(matchEgressRule('*.github.com', 'api.github.com', 443), '通配命中子域')
  assert(!matchEgressRule('*.github.com', 'evilgithub.com', 443), '通配不命中相邻域')
  assert(matchEgressRule('*', 'anything', 1), '全通配')
})

it('判定：deny 优先于一切（含 allow 命中）', () => {
  assertEqual(decideEgress('bad.com', 443, ['bad.com'], ['bad.com']), { allowed: false, reason: 'deny-list' }, 'deny 命中即拒')
})

it('判定：白名单模式只放行名单内', () => {
  assertEqual(decideEgress('ok.com', 443, ['ok.com'], []), { allowed: true, reason: 'in-allow-list' }, '名单内放行')
  assertEqual(
    decideEgress('other.com', 443, ['ok.com'], []),
    { allowed: false, reason: 'not-in-allow-list' },
    '名单外拒绝',
  )
})

it('判定：黑名单模式除黑名单外全放行', () => {
  assertEqual(decideEgress('bad.com', 443, [], ['bad.com']), { allowed: false, reason: 'deny-list' }, '黑名单命中拒绝')
  assertEqual(decideEgress('any.com', 443, [], ['bad.com']), { allowed: true, reason: 'no-deny-match' }, '其余放行')
})

it('判定：两张表都空 = 全放行', () => {
  assertEqual(decideEgress('any.com', 443, [], []), { allowed: true, reason: 'allow-all' }, '默认全放行')
})

// ───────────────────── 平台出网范围（P1-16a）─────────────────────

it('出网范围：三档取值域', () => {
  assertEqual([...EGRESS_SCOPES], ['ALL', 'NONE', 'REGISTRY'], '三档')
})

it('范围解析：ALL ⇒ allow=[*]（全放行），白名单无意义，黑名单保留', () => {
  assertEqual(
    resolveEgressPolicy({ scope: 'ALL', allowHosts: ['x.com'], denyHosts: ['bad.com'], modelHosts: ['api.model.com'] }),
    { allow: ['*'], deny: ['bad.com'] },
    'ALL 全放行',
  )
})

it('范围解析：NONE ⇒ allow = 模型池 ∪ 白名单', () => {
  assertEqual(
    resolveEgressPolicy({ scope: 'NONE', allowHosts: ['x.com'], denyHosts: [], modelHosts: ['api.model.com'] }),
    { allow: ['api.model.com', 'x.com'], deny: [] },
    '仅模型 + 白名单',
  )
})

it('范围解析：REGISTRY ⇒ allow = 模型池 ∪ 注册表 ∪ git ∪ 白名单', () => {
  const resolved = resolveEgressPolicy({
    scope: 'REGISTRY',
    allowHosts: ['x.com'],
    denyHosts: [],
    modelHosts: ['api.model.com'],
  })
  assert(resolved.allow.includes('api.model.com'), '含模型池')
  assert(resolved.allow.includes(EGRESS_REGISTRY_HOSTS[0]), '含注册表主机')
  assert(resolved.allow.includes(EGRESS_GIT_HOSTS[0]), '含 git 主机')
  assert(resolved.allow.includes('x.com'), '含白名单')
  assertEqual(resolved.deny, [], '无黑名单')
})

it('范围解析：NONE/REGISTRY 空放行项 ⇒ deny=[*]（拒绝一切，不落进"全放行"）', () => {
  assertEqual(
    resolveEgressPolicy({ scope: 'NONE', allowHosts: [], denyHosts: [], modelHosts: [] }),
    { allow: [], deny: ['*'] },
    '空模型池 + 空白名单',
  )
  // 与"两张空表"的语义对比：那是全放行，这里必须不是
  assertEqual(deriveEgressMode([], []), 'ALLOW_ALL', '对照：两张空表 = 全放行')
})

it('范围解析后的判定：NONE 只放模型与白名单', () => {
  const resolved = resolveEgressPolicy({ scope: 'NONE', allowHosts: [], denyHosts: [], modelHosts: ['api.model.com'] })
  assertEqual(decideEgress('evil.com', 443, resolved.allow, resolved.deny), {
    allowed: false,
    reason: 'not-in-allow-list',
  }, '范围外被拒')
  assertEqual(decideEgress('api.model.com', 443, resolved.allow, resolved.deny), {
    allowed: true,
    reason: 'in-allow-list',
  }, '模型放行')
})

it('范围解析后的判定：黑名单永远硬拒（ALL 也拦得住）', () => {
  const resolved = resolveEgressPolicy({ scope: 'ALL', allowHosts: [], denyHosts: ['bad.com'], modelHosts: [] })
  assertEqual(decideEgress('bad.com', 443, resolved.allow, resolved.deny), { allowed: false, reason: 'deny-list' }, 'deny 优先')
})

console.log('')
console.log(`egress-policy-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
