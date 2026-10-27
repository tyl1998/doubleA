#!/usr/bin/env node
/**
 * verify-sandbox-instances-ui.mjs —— 沙箱实例页前端**无依赖**验收（P1-14 · R5）
 *
 * 跑法：`pnpm verify:sandbox-instances-ui`
 *      （= `node --import tsx frontend/scripts/verify-sandbox-instances-ui.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 验什么 / 为什么不需要后端
 * ─────────────────────────────────────────────────────────────────────
 * 本页的风险全在**状态推导**上，而它们错了**不会报错**，只会安静地误导运维：
 *   · 两个"过期"口径搞混 ⇒ 把"在线但负载旧"显示成"实例死了"（或反过来）；
 *   · 没有负载时把占用率渲染成 `0%` ⇒ 看起来"这台空着"，其实只是没采到；
 *   · 负载年龄用 `Date.now()` 以外的东西算 ⇒ 显示"3s 前"，实际已经 10 分钟。
 * 这些都是 `pages/admin/sandboxInstanceModel.ts` 里的纯函数 ⇒ 直接喂字面量逐条断言。
 *
 * ⚠️ 本档**验不了**：`GET /api/admin/sandbox/instances` 的真实返回（要 Redis + 心跳）、
 * 权限是否真的仅 ADMIN、浏览器里的渲染。前两项属后端/端到端。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  sandboxInstanceStateLabel,
  drainActionView as drainActionViewRaw,
  loadAgeText,
  sandboxInstanceState,
  slotRatioText as slotRatioTextRaw,
} from '../src/pages/admin/sandboxInstanceModel.ts'
import { translate } from '@doubulea/shared'

// P1-23 第十批：这两个纯函数多收 `locale`（译文搬去 `shared/src/i18n`）。本档统一按 zh 断言。
const ZH = 'zh'
const tr = (key, params) => translate(ZH, key, params)
const drainActionView = (item) => drainActionViewRaw(item, ZH)
const slotRatioText = (item) => slotRatioTextRaw(item, ZH)
import {
  activeStepKey,
  jobProgressStatus,
  jobSummary,
  stepDurationText,
  stepIcon,
} from '../src/pages/admin/nodeBootstrapModel.ts'

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  d: useColor ? '\u001b[90m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0
function it(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

const NOW = 1_700_000_000_000
const load = (sampledAt, extra = {}) => ({
  slotsUsed: 2,
  slotsTotal: 10,
  queueDepth: 0,
  chatbotInFlight: 1,
  sampledAt,
  ...extra,
})
const item = (extra = {}) => ({
  instanceId: 'a',
  advertiseAddr: 'a:3000',
  pid: 1,
  host: 'host-a',
  startedAt: NOW - 5_000,
  load: load(NOW - 3_000),
  drained: false,
  ...extra,
})

console.log(`${c.d}P1-14 · R5 沙箱实例页（纯函数）${c.x}`)

it('A1 心跳新鲜 + 负载新鲜 ⇒ 在线', () => {
  const view = sandboxInstanceState(item(), { now: NOW, loadStaleMs: 60_000 })
  eq(view.state, 'online', '状态')
  eq(view.loadAgeMs, 3_000, '负载年龄')
  eq(view.slotRatio, 0.2, '占用率')
})

it('A2 在线但负载超过新鲜度 ⇒ load-stale（不是「死了」）', () => {
  const view = sandboxInstanceState(item({ load: load(NOW - 90_000) }), { now: NOW, loadStaleMs: 60_000 })
  eq(view.state, 'load-stale', '状态')
  eq(sandboxInstanceStateLabel(view.state, ZH), '负载过期', '文案')
})

it('★ A3 心跳超过 TTL ⇒ stale（优先级高于负载过期）', () => {
  const view = sandboxInstanceState(item({ startedAt: NOW - 200_000, load: load(NOW - 200_000) }), {
    now: NOW,
    loadStaleMs: 60_000,
  })
  eq(view.state, 'stale', '状态')
  eq(sandboxInstanceStateLabel(view.state, ZH), '心跳超时', '文案')
})

it('A4 没有负载 ⇒ age / ratio 为 null，不算「0% 空闲」', () => {
  const view = sandboxInstanceState(item({ load: null }), { now: NOW, loadStaleMs: 60_000 })
  eq(view.loadAgeMs, null, '负载年龄')
  eq(view.slotRatio, null, '占用率')
  eq(view.state, 'online', '无负载不影响在线判定')
  eq(slotRatioText(item({ load: null })), '未知', '文案')
})

it('A5 slotsTotal=0 ⇒ 不除零', () => {
  const view = sandboxInstanceState(item({ load: load(NOW - 1_000, { slotsTotal: 0, slotsUsed: 0 }) }), {
    now: NOW,
    loadStaleMs: 60_000,
  })
  eq(view.slotRatio, null, '占用率')
  eq(slotRatioText(item({ load: load(NOW - 1_000, { slotsTotal: 0, slotsUsed: 0 }) })), '0/0', '文案')
})

it('A6 占用率文案带百分比', () => {
  eq(slotRatioText(item()), '2/10 · 20%', '2/10')
  eq(slotRatioText(item({ load: load(NOW - 1_000, { slotsUsed: 3, slotsTotal: 4 }) })), '3/4 · 75%', '3/4')
})

it('A7 负载年龄文案：秒 / 分 / 时 / 无', () => {
  eq(loadAgeText(null), '—', '无负载')
  eq(loadAgeText(3_000), '3s', '秒')
  eq(loadAgeText(120_000), '2m', '分')
  eq(loadAgeText(7_200_000), '2h', '时')
})

it('★ A8 注册 TTL 可显式给（缺省 = 1.5 × loadStaleMs = 3× 心跳）', () => {
  // 缺省 TTL = 1.5 × loadStaleMs = 3× 心跳 = 90s ⇒ 60s 前的心跳仍在线；120s 前已超时
  const recent = item({ startedAt: NOW - 60_000 })
  eq(sandboxInstanceState(recent, { now: NOW, loadStaleMs: 60_000 }).state, 'online', '缺省 TTL 90s ⇒ 60s 前的心跳在线')
  const late = item({ startedAt: NOW - 120_000 })
  eq(sandboxInstanceState(late, { now: NOW, loadStaleMs: 60_000 }).state, 'stale', '缺省 TTL 90s ⇒ 120s 前的心跳超时')
  eq(
    sandboxInstanceState(late, { now: NOW, loadStaleMs: 60_000, registrationTtlMs: 60_000 }).state,
    'stale',
    '显式 TTL 60s ⇒ 超时',
  )
})

console.log('')
console.log(`── 形态（页面接线）──`)
const page = readFileSync(fileURLToPath(new URL('../src/pages/admin/SandboxInstancesPage.tsx', import.meta.url)), 'utf8')
/**
 * P1-23 第十批：页面里的文案已全部搬进 `shared/src/i18n`，源码只剩 key ⇒
 * 「页面写明了某句语义」的判据从"页面源码里有这句中文"改成"页面用了承载这句话的 key，
 * 且该 key 的 zh 译文里有这句话"。断言强度不变（换 key 或改译文都会红）。
 */
const pageUses = (key) => page.includes(`t('${key}'`) || page.includes(`t(\`${key}\``)
const pageSays = (key, phrase) => pageUses(key) && tr(key).includes(phrase)
it('B1 页面消费同一组纯函数（不自己算状态）', () => {
  assert(page.includes('sandboxInstanceState('), '应调用 sandboxInstanceState')
  assert(page.includes('slotRatioText('), '应调用 slotRatioText')
})
it('★ B2 读失败显示错误条，而不是渲染成空表', () => {
  assert(page.includes('data?.error != null'), '应有 error 分支')
  assert(pageUses('sandboxInst.readFailed'), '错误条应使用一条专门的文案 key（不是复用通用失败）')
  assert(pageSays('sandboxInst.readFailed', '不是「零台实例」'), '错误条文案应点明不是零台')
})
it('★ B3 写操作清单收敛：只有「一键初始化」与「摘流」，且都走封装好的 hook', () => {
  // 2026-10-21：摘流是**新**的写操作（用户反馈"页面上没有按钮"）。但它不允许页面自己拼 URL、
  // 手发 PUT/DELETE —— 一律走 `api/sandboxInstances.ts#useSetSandboxDrained`（契约与后端同源）。
  assert(!/\/api\/admin\/sandbox\/instances\/\$\{/.test(page), '页面不应自己拼注册表端点')
  assert(page.includes('useStartBootstrapJob'), '一键初始化应走 node 初始化任务 hook')
  assert(page.includes('useSetSandboxDrained'), '摘流应走 useSetSandboxDrained hook')
  assert(!/method: 'PUT'|method: 'DELETE'/.test(page), '页面不应发 PUT/DELETE')
})
it('★ B6 摘流按钮：有确认框、文案与纯函数同源、不把「摘流」说成「下线」', () => {
  assert(page.includes('Modal.confirm'), '摘流是静默生效的运维动作，必须有确认框')
  assert(page.includes('drainActionView('), '按钮文案与确认框文案应共用 drainActionView')
  assert(page.includes('data-testid={`drain-${item.instanceId}`}'), '按钮应有稳定 testid')
  // P1-23：语义边界的判据落到承载它们的 key（页面用到了 + 译文里确实这么说）
  assert(pageSays('sandboxInst.drainedTag', '已摘流'), '页面应写明「已摘流」的语义边界')
  assert(pageSays('sandboxInst.leadStrong2', '不等于下线'), '页面应写明「不等于下线」的语义边界')
  assert(
    pageSays('sandboxInst.aboutDrainStrong3', '仍会继续服务') ||
      pageSays('sandboxInst.drainedTooltip', '仍会继续服务'),
    '页面应写明「仍会继续服务」的语义边界',
  )
})
it('★ B7 摘流纯函数：未摘流 ⇒ 按钮是「摘流」；已摘流 ⇒ 按钮是「恢复接收」（且文案说清新会话/已有会话的区别）', () => {
  const off = drainActionView(item({ drained: false }))
  eq([off.drained, off.actionLabel], [false, '摘流'], '未摘流')
  assert(off.confirmBody.includes('新会话'), '确认框应说明只挡新会话')
  assert(off.confirmBody.includes('仍会继续服务'), '确认框应说明已有会话不受影响')
  const on = drainActionView(item({ drained: true }))
  eq([on.drained, on.actionLabel], [true, '恢复接收'], '已摘流')
  assert(on.confirmTitle.includes('重新接收新会话'), '恢复确认框标题')
})
it('★ B5 一键初始化：健康时禁用、只修坏项', () => {
  assert(page.includes('disabled={report.data === undefined || report.data.ready || running}'), '健康/执行中时按钮应禁用')
  assert(page.includes('NodeBootstrapProgressPanel'), '进度应来自任务快照面板')
})
it('★ B4 节点就绪可见但不可选：未就绪实例在会话选择里被置灰', () => {
  const select = readFileSync(fileURLToPath(new URL('../src/features/chat/RuntimeSelect.tsx', import.meta.url)), 'utf8')
  assert(select.includes('item.ready === false'), '选择器应按 ready 判定')
  assert(select.includes('disabled={unavailable}'), '未就绪实例的单选应禁用')
})

console.log('')
console.log(`${c.d}节点初始化任务（2026-10-20：步骤动效 + 切页回来仍可见）${c.x}`)

/** 造一个任务快照（步骤表顺序与后端 `PLAN` 一致） */
const step = (key, state, extra = {}) => ({ key, label: key, state, detail: '', events: [], ...extra })
const job = (extra = {}) => ({
  jobId: 'nb-1',
  instanceId: 'a',
  status: 'running',
  percent: 0,
  completed: 0,
  total: 4,
  startedAt: NOW,
  updatedAt: NOW,
  steps: [
    step('docker', 'ok', { startedAt: NOW, finishedAt: NOW + 1200 }),
    step('sandboxNetwork', 'skipped'),
    step('toolkitImage', 'running', { startedAt: NOW - 30_000, detail: 'docker pull …' }),
    step('recheck', 'pending'),
  ],
  ...extra,
})

it('★ C1 进度是真的（后端按步骤算），失败 = exception、成功 = success', () => {
  eq(jobProgressStatus(job()), 'active', '执行中')
  eq(jobProgressStatus(job({ status: 'succeeded', ok: true, percent: 100 })), 'success', '成功')
  eq(jobProgressStatus(job({ status: 'failed', ok: false })), 'exception', '失败')
})

it('★ C2 图标能把「跳过」和「真修了」分开（运维最容易被误导的一处）', () => {
  eq(stepIcon('ok'), '✅', 'ok')
  eq(stepIcon('skipped'), '⏭️', 'skipped 不能画成 ✅')
  eq(stepIcon('failed'), '❌', 'failed')
  eq(stepIcon('running'), '⏳', 'running')
  eq(stepIcon('pending'), '⚪', 'pending')
})

it('★ C3 高亮的是真正在跑的那一步（没有在跑的取第一个未开始）', () => {
  eq(activeStepKey(job()), 'toolkitImage', '执行中')
  eq(activeStepKey(job({ steps: [step('docker', 'ok'), step('recheck', 'pending')] })), 'recheck', '刚建快照')
})

it('C4 步骤耗时：跑着的按 now 算，结束的按 finishedAt 算', () => {
  const steps = job().steps
  eq(stepDurationText(steps[0], NOW + 99_999), '1s', '已结束')
  eq(stepDurationText(steps[2], NOW), '30s', '跑着的')
  eq(stepDurationText(steps[3], NOW), null, '未开始')
  eq(stepDurationText({ ...steps[2], startedAt: NOW - 200_000 }, NOW), '3m20s', '超过一分钟')
})

it('C5 摘要分开数「修好 / 本来就绪 / 失败」', () => {
  eq(jobSummary(job()), { fixed: 1, skipped: 1, failed: 0 }, '混合')
})

it('★ C6 切换页面回来能看到进度：页面不靠本地 Promise，而是问"这台当前任务"', () => {
  assert(page.includes('useNodeBootstrapJob(instanceId, jobId'), '应按实例轮询任务')
  assert(page.includes('useState<string | null>(null)'), 'jobId 初始为 null ⇒ 走 current 端点恢复')
  const api = readFileSync(fileURLToPath(new URL('../src/api/node.ts', import.meta.url)), 'utf8')
  assert(api.includes('/api/admin/node/bootstrap/current'), '应有 current 端点读取')
  assert(/status === 'running' \? 1_500 : false/.test(api), '只在执行中轮询，结束后停')
})

it('★ C7 步骤动效只挂在当前步（并尊重 prefers-reduced-motion）', () => {
  const panel = readFileSync(fileURLToPath(new URL('../src/pages/admin/NodeBootstrapProgress.tsx', import.meta.url)), 'utf8')
  assert(panel.includes('is-running'), '执行中的说明文字应有动效标记')
  const css = readFileSync(fileURLToPath(new URL('../src/styles/app.css', import.meta.url)), 'utf8')
  assert(css.includes('@keyframes node-step-shimmer'), '应有扫光动画')
  assert(css.includes('prefers-reduced-motion: reduce'), '应尊重减少动效偏好')
})

it('★ C8 后端把进度记在实例上（Redis 快照 + 失联改判）', () => {
  const store = readFileSync(
    fileURLToPath(new URL('../../backend/src/sandbox/nodeJobStore.ts', import.meta.url)),
    'utf8',
  )
  assert(store.includes('node:bootstrap:job'), '快照键')
  assert(store.includes('settleStaleJob'), '进程失联要改判 failed')
  const svc = readFileSync(
    fileURLToPath(new URL('../../backend/src/services/nodeBootstrapJob.service.ts', import.meta.url)),
    'utf8',
  )
  const unit = readFileSync(
    fileURLToPath(new URL('../../backend/src/sandbox/nodeBootstrap.ts', import.meta.url)),
    'utf8',
  )
  assert(unit.includes('export interface NodeBootstrapProgress'), '执行单元要有进度回调契约')
  assert(unit.includes('progress?: NodeBootstrapProgress'), 'bootstrapNode 要接受进度回调')
  assert(svc.includes('implements NodeBootstrapProgress'), '服务层要把回调落成快照')
  assert(svc.includes('reused'), '重复点不叠跑')
})

console.log('')
console.log(`verify-sandbox-instances-ui：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
