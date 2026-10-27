#!/usr/bin/env node
/**
 * runtime-build-regression.ts —— 沙箱运行时**按需构建**（P1-17a）的**无 DB / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend runtime-build:regression`
 *      （= `node --import tsx scripts/runtime-build-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build`）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2；被测对象 = `shared/src/runtime.ts`（组件目录 /
 *   组合规范化）与 `backend/src/sandbox/runtimeBuild.ts#interpretBuildLine`（docker build 输出的
 *   行 → 阶段/百分比）与 `runtimeImages.ts`（镜像 ref → 运行时 id）。
 *
 * ⚠️ 验的是**纯函数语义**：构建进度解析、阶段只前进的判据、镜像 ref 解析、变体规范化。
 *    不碰 Docker、不碰 DB（job 的进程编排由人工冒烟覆盖）。
 */

import {
  SANDBOX_BUILD_PHASE_KEY,
  SANDBOX_BUILD_PHASE_LABELS,
  SANDBOX_RUNTIME_LANGUAGE_SPECS,
  parseSandboxComponentId,
  sandboxComponentId,
  sandboxComponentsArg,
  sandboxSelectionFromVariantId,
  sandboxVariantIdFromSelection,
  sandboxVariantLabel,
  translate,
} from '@doubulea/shared'

import { interpretBuildLine, SANDBOX_BUILD_PHASE_ORDER } from '../src/sandbox/runtimeBuild.js'
import {
  listSandboxRuntimes,
  resolveSandboxRuntimeImage,
  runtimeIdFromImageRef,
  runtimeLayerVersionFromImageRef,
} from '../src/sandbox/runtimeImages.js'

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

console.log('runtime-build-regression —— 运行时按需构建（P1-17a）\n')

// ───────────────────────── ① 阶段定义 ─────────────────────────
console.log('── ① 构建阶段（顺序 / 文案）──')
it('阶段顺序 = queued → preparing → apt → language → verifying → done', () => {
  assertEqual(SANDBOX_BUILD_PHASE_ORDER, ['queued', 'preparing', 'apt', 'language', 'verifying', 'done'], '顺序')
})
it('每个阶段都有中文文案', () => {
  for (const phase of SANDBOX_BUILD_PHASE_ORDER) {
    assert(typeof SANDBOX_BUILD_PHASE_LABELS[phase] === 'string' && SANDBOX_BUILD_PHASE_LABELS[phase] !== '', `缺 ${phase} 文案`)
  }
})
it('每个阶段的界面 key 都有，且 zh 译文与中文表逐字一致（同 `verify-i18n` G1 模式）', () => {
  for (const phase of SANDBOX_BUILD_PHASE_ORDER) {
    const key = SANDBOX_BUILD_PHASE_KEY[phase]
    assert(typeof key === 'string' && key !== '', `缺 ${phase} 的 key`)
    assertEqual(translate('zh', key), SANDBOX_BUILD_PHASE_LABELS[phase], `${phase} 的字典译文`)
    assert(!/[\u4e00-\u9fff]/u.test(translate('en', key)), `${phase} 的 en 译文不该有汉字`)
  }
})

// ───────────────────────── ② 行 → 进度/阶段 ─────────────────────────
console.log('\n── ② interpretBuildLine（docker build 输出解析）──')
it('BuildKit 步进度：#5 [2/5] ⇒ 0.1 + 0.75×(2/5) = 0.4', () => {
  const r = interpretBuildLine('#5 [2/5] RUN set -eux; apt-get update')
  assertEqual(r.progress, 0.4, '百分比')
})
it('经典构建器步进度：Step 3/6 ⇒ 0.1 + 0.75×0.5 = 0.475', () => {
  const r = interpretBuildLine('Step 3/6 : RUN echo hi')
  assertEqual(r.progress, 0.1 + 0.75 * (3 / 6), '百分比')
})
it('百分比上限封顶 0.85（首尾留给准备与自检）', () => {
  const r = interpretBuildLine('#9 [9/9] RUN x')
  assertEqual(r.progress, 0.85, '封顶')
})
it('apt 关键字命中 apt 阶段', () => {
  assertEqual(interpretBuildLine('+ apt-get update').phase, 'apt', 'apt')
  assertEqual(interpretBuildLine("sed -i 's|deb.debian.org|x|g'").phase, 'apt', 'debian 源')
})
it('语言安装关键字命中 language 阶段并带细节', () => {
  const r = interpretBuildLine('#4 [2/5] RUN /tmp/install-python-version.sh 3.10')
  assertEqual(r.phase, 'language', '阶段')
  assert(r.detail !== undefined, '应有细节')
})
it('自检关键字命中 verifying 阶段', () => {
  assertEqual(interpretBuildLine('/opt/sandbox-runtime-selfcheck.sh python=3.10').phase, 'verifying', '自检')
})
it('构建上下文准备关键字命中 preparing', () => {
  assertEqual(interpretBuildLine('#1 [internal] load build definition from Dockerfile').phase, 'preparing', '准备')
})
it('认不出的行 ⇒ 空对象（不猜）', () => {
  assertEqual(interpretBuildLine('some random build chatter'), {}, '空')
})
it('组件标记行给出人话细节', () => {
  const r = interpretBuildLine('=== 组件：python=3.10 ===')
  assertEqual(r.detail, 'python=3.10', '组件细节')
})

// ───────────────────────── ③ 变体规范化 ─────────────────────────
console.log('\n── ③ 变体 id 规范化（选择项集合）──')
it('按语言顺序排序、- 连接', () => {
  assertEqual(
    sandboxVariantIdFromSelection([
      { language: 'python', version: '3.10' },
      { language: 'node', version: '22' },
    ]),
    'node22-python3.10',
    'node 在前（版本保留 `.`）',
  )
})
it('空集合 = none；未知语言 / 非法版本丢弃', () => {
  assertEqual(sandboxVariantIdFromSelection([]), 'none', '空')
  assertEqual(sandboxVariantIdFromSelection([{ language: 'bogus', version: '1' }]), 'none', '全未知')
  assertEqual(
    sandboxVariantIdFromSelection([
      { language: 'node', version: '22' },
      { language: 'python', version: '3-10' },
    ]),
    'node22',
    '含 `-` 的版本非法 ⇒ 丢弃',
  )
})
it('变体 → 选择项：含未知片段 ⇒ undefined', () => {
  assertEqual(sandboxSelectionFromVariantId('node22-python3.10'), [
    { language: 'node', version: '22' },
    { language: 'python', version: '3.10' },
  ], '已知')
  assertEqual(sandboxSelectionFromVariantId('none'), [], 'none')
  assertEqual(sandboxSelectionFromVariantId('bogus'), undefined, '未知')
})
it('Dockerfile COMPONENTS 串：按语言顺序 lang=ver', () => {
  assertEqual(
    sandboxComponentsArg([
      { language: 'python', version: '3.10' },
      { language: 'node', version: '22' },
    ]),
    'node=22,python=3.10',
    '参数串',
  )
})
it('变体显示名 = 语言名 + 版本相加', () => {
  assertEqual(sandboxVariantLabel('node22-python3.10'), 'Node.js 22 + Python 3.10', '显示名')
  assertEqual(sandboxVariantLabel('none'), '无（仅基础工具）', '空')
})
it('组件 id 与选择项往返（默认版本与候选版本都覆盖）', () => {
  // 2026-10-15 起"组件目录"已删除（版本不再枚举）⇒ 用语言规格表推出 id 集合
  for (const spec of SANDBOX_RUNTIME_LANGUAGE_SPECS) {
    for (const version of [spec.defaultVersion, ...spec.suggestions]) {
      const id = sandboxComponentId(spec.language, version)
      assertEqual(parseSandboxComponentId(id), { language: spec.language, version }, id)
      assertEqual(sandboxSelectionFromVariantId(id), [{ language: spec.language, version }], id)
    }
  }
})

// ───────────────────────── ④ 镜像 ref 解析 ─────────────────────────
console.log('\n── ④ 镜像 ref → 运行时 id / 层版本 ──')
const REPO = 'doubulea/sandbox-runtime'
it('解析出 id 与层版本', () => {
  assertEqual(runtimeIdFromImageRef(`${REPO}:node22-v3`, REPO), 'node22', 'id')
  assertEqual(runtimeLayerVersionFromImageRef(`${REPO}:node22-v3`, REPO), 3, '层版本')
})
it('组合 id（含 -）也能解析（按最后一个 -v<数字> 切）', () => {
  assertEqual(runtimeIdFromImageRef(`${REPO}:node22-python310-v7`, REPO), 'node22-python310', '组合 id')
})
it('非本仓库 / 非约定形态 ⇒ undefined', () => {
  assertEqual(runtimeIdFromImageRef('other/repo:node22-v1', REPO), undefined, '别的仓库')
  assertEqual(runtimeIdFromImageRef(`${REPO}:node22`, REPO), undefined, '缺层版本')
})
it('同一 id 取层版本最大的一份', () => {
  const items = listSandboxRuntimes([`${REPO}:node22-v1`, `${REPO}:node22-v3`, `${REPO}:python310-v2`], REPO)
  assertEqual(items.map((i) => i.id), ['node22', 'python310'], 'id 列表按字典序')
  assertEqual(items.find((i) => i.id === 'node22')?.image, `${REPO}:node22-v3`, '取最大层版本')
})
it('会话 runtime 找不到 ⇒ 回退 fallback；命中则用命中的镜像', () => {
  const items = listSandboxRuntimes([`${REPO}:node22-v3`], REPO)
  assertEqual(resolveSandboxRuntimeImage('node22', items, 'doubulea/sandbox-toolkit:6'), `${REPO}:node22-v3`, '命中')
  assertEqual(resolveSandboxRuntimeImage('ghost', items, 'doubulea/sandbox-toolkit:6'), 'doubulea/sandbox-toolkit:6', '回退')
  assertEqual(resolveSandboxRuntimeImage('ghost', items, undefined), undefined, '无回退 ⇒ undefined')
})

console.log(`\nruntime-build-regression：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
