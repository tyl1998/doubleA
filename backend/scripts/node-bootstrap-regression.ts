#!/usr/bin/env node
/**
 * node-bootstrap-regression.ts —— 一键初始化对**沙箱镜像版本漂移**的判据（纯函数，无 Docker / DB）。
 *
 * 跑法：`pnpm --filter @doubulea/backend node-bootstrap:regression`
 *
 * 守的是：
 *  ① `imageTagOf` 取的是**最后一段 tag**（不会把 `registry:5000` 的端口当 tag）；
 *  ② 配置 tag ≠ 期望 tag ⇒ 判漂移（平台升级后旧镜像还在，一键初始化不能再误报"已就绪"）；
 *  ③ 同 tag 的镜像仓库（mirror）不算漂移；读不到 versions.mjs（expected=null）也不算；
 *  ④ 升级提示必须包含可直接照抄的两行 env。
 */

import { imageTagOf, sandboxImageDriftOf, sandboxImageUpgradeHint } from '../src/sandbox/imageExpectation.ts'

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

const expected = { base: 'doubulea/sandbox-base:11', toolkit: 'doubulea/sandbox-toolkit:14' }

console.log('\n① tag 解析')
{
  check('普通 ref 取最后一个 tag', imageTagOf('doubulea/sandbox-toolkit:14') === '14')
  check('带端口 registry 不把端口当 tag', imageTagOf('registry.local:5000/doubulea/sandbox-toolkit:14') === '14')
  check('无 tag ⇒ 空串（= latest，不等于显式版本）', imageTagOf('doubulea/sandbox-toolkit') === '')
  check('带端口但无 tag ⇒ 空串', imageTagOf('registry.local:5000/doubulea/sandbox-toolkit') === '')
  check('处理首尾空白', imageTagOf('  doubulea/sandbox-toolkit:14  ') === '14')
}

console.log('\n② 漂移判据')
{
  check('13 → 14 ⇒ 漂移', sandboxImageDriftOf('doubulea/sandbox-toolkit:13', expected))
  check('14 → 14 ⇒ 不漂移', !sandboxImageDriftOf('doubulea/sandbox-toolkit:14', expected))
  check('镜像仓库不同但 tag 相同 ⇒ 不漂移（允许 mirror）', !sandboxImageDriftOf('registry.local:5000/doubulea/sandbox-toolkit:14', expected))
  check('没有 tag（latest）⇒ 漂移', sandboxImageDriftOf('doubulea/sandbox-toolkit', expected))
  check('未配置 SANDBOX_IMAGE ⇒ 不判漂移（由缺失项处理）', !sandboxImageDriftOf(undefined, expected))
  check('读不到 versions.mjs（expected=null）⇒ 不判漂移（退回旧行为）', !sandboxImageDriftOf('doubulea/sandbox-toolkit:13', null))
}

console.log('\n③ 升级提示')
{
  const hint = sandboxImageUpgradeHint('doubulea/sandbox-toolkit:13', expected)
  check('包含当前配置的 ref', hint.includes('doubulea/sandbox-toolkit:13'))
  check('包含期望的 toolkit ref', hint.includes(expected.toolkit))
  check('包含可照抄的 SANDBOX_IMAGE_BASE', hint.includes(`SANDBOX_IMAGE_BASE=${expected.base}`))
  check('包含可照抄的 SANDBOX_IMAGE', hint.includes(`SANDBOX_IMAGE=${expected.toolkit}`))
  check('写明重启后再点一键初始化', hint.includes('重启后端后再点一键初始化'))
}

console.log(`\n${failed === 0 ? '✅' : '❌'} node-bootstrap-regression：${String(passed)} 通过 / ${String(failed)} 失败`)
process.exit(failed === 0 ? 0 : 1)