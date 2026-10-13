#!/usr/bin/env node
/**
 * verify-admin-ui.mjs —— 管理页前端**无依赖**验收（P0-1-36）
 *
 * 跑法：`pnpm verify:admin-ui`
 *      （= `node --import tsx frontend/scripts/verify-admin-ui.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险集中在几处**错了不会报错、只会悄悄改坏数据或给出一个假读数**的地方：
 *   · **`apiKey` 三态**：`PATCH /api/model-providers/:id` 多带一个 `apiKey` ⇒ **把已配置的
 *     Key 悄默声抹掉**（响应里只有 `hasKey:false`，要等到真正调模型才发现）；少带一个
 *     `apiKey: null` ⇒ "清空"变成"没删成"；
 *   · **`maxContext` 三态**：多带一个 `null` ⇒ 把上下文长度清空；少带 ⇒ 清空的刷新后又回来；
 *   · **`providerId`**：带上一个不同的值 ⇒ 必然 409；界面上干脆不给入口；
 *   · **`type` 锁**：Provider 下已有模型 / 模型已被智能体引用时改类型 ⇒ 必然 409；
 *   · **rowSpan 与排序**：给 Provider 列开了客户端排序 ⇒ 合并块错位成"合并到别人头上"；
 *     前端自己 `sort(` 一次 ⇒ 出现第二份顺序的真相；
 *   · **停用模型后的下拉**：忘了失效 `['models','available','CHAT']` ⇒ 智能体编辑页里
 *     **立刻就能选到刚停用的模型**，而那个下拉看不出任何异常；
 *   · **一次性初始密码**：它是**唯一一次**明文 ⇒ 弹窗误关的补救只有"再重置一次"。
 * 这些全是纯函数或"可注入依赖的判据"，所以本档直接喂字面量、手写夹具，逐条断言最终形状
 * ——本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法（对照 `verify-chat-sse` /
 * `verify-knowledge-ui`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * A~J 十组分别盯什么
 * ─────────────────────────────────────────────────────────────────────
 *   A 用户状态三态与操作矩阵（"不能操作自己"是业务约束，不是权限差异）
 *   B 建号 / 改角色的请求体（空串不带键、"没改就不发"）
 *   C 一次性初始密码（文案、复制内容、两版动词）
 *   D **Key 有进无出**（三态 + 绝不回填掩码）
 *   E 改类型与迁移的守卫（Provider 的 type / 模型的 type / 模型的 providerId）
 *   F `maxContext` 三态与界面校验
 *   G 分组呈现（rowSpan）+ "顺序只来自服务端"
 *   H 删除分级（Provider 走级联，去逐字确认 + 自动解绑；用户没有删除接口）
 *   I 拉取上游模型的读数（截断、未配 Key、0 条）
 *   J 源码级守门（几条"没有别的观测面"的正确性）
 *     ⚠️ J13 原属"没有别的观测面"那一类，直到它在浏览器里真出过一次：
 *     `useModelProviders(MODEL_POOL_PAGE_LIMIT_MAX)` 把 100 传进了 `offset` ⇒ 页面空、请求 200。
 *     **这一条只能靠源码或端测发现**（接口层、类型检查、日志全都是绿的）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · React 渲染与交互（表长什么样、弹窗能不能关、rowSpan 真的合并了吗）⇒ 归浏览器端测
 *     （`README`「浏览器端测 · 管理页」）；
 *   · 真后端（`409` 的文案、`apidKeyPreview` 的掩码、上游探测的真实返回）⇒ 归
 *     `pnpm verify:users` / `verify:model-providers` / `verify:models` / `verify:llm`；
 *   · 打包产物（分包是否真的生效）⇒ 归 `pnpm build:frontend` 的输出（本档跑的是**源码**）。
 *
 * 断言脚手架与 `verify-chat-sse.mjs` / `verify-knowledge-ui.mjs` 同款，**刻意各留一份**：
 * 验收脚本要能被单独拷出来跑（共用 `_harness.mjs` 会让"跑这一档"变成"跑得动整个 scripts 目录"）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

/** 深比较**先规范化键序**再比（键序不是断言对象的一部分） */
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
  assert(
    canonical(actual) === canonical(expected),
    `${label}：期望 ${canonical(expected)}，实际 ${canonical(actual)}`,
  )
}

function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '')
}

// ───────────────────────────── 被测对象 ─────────────────────────────

const { USER_ROLES, USER_STATUSES } = await import('@doubulea/shared')

const {
  USER_ROLE_LABELS,
  USER_STATUS_LABELS,
  describeUserStatus,
  userRowActions,
  EMPTY_USER_FORM_VALUES,
  userEditValuesOf,
  buildCreateUserBody,
  buildUpdateUserBody,
  initialPasswordNotice,
  initialPasswordCopyText,
  EMPTY_PROVIDER_FORM_VALUES,
  providerEditValuesOf,
  describeProviderKey,
  providerKeyIntent,
  buildCreateProviderBody,
  buildProviderUpdateBody,
  providerTypeChangeBlocked,
  protocolOptionsFor,
  protocolAfterTypeChange,
  protocolBaseUrlHint,
  PROTOCOL_LOCKED_BY_TYPE_REASON,
  EMPTY_MODEL_FORM_VALUES,
  modelEditValuesOf,
  validateMaxContext,
  maxContextText,
  buildCreateModelBody,
  buildModelUpdateBody,
  modelTypeChangeBlocked,
  modelDeleteBlockedNotice,
  MAX_CONTEXT_MIN,
  MAX_CONTEXT_MAX,
  providerGroupSpans,
  countProviders,
  summarizeModels,
  remoteModelRows,
  remoteModelNotice,
  modelEditAffectsVectors,
  knowledgeBasesUsingModel,
} = await import('../src/pages/admin/adminModel.ts')

const { serialForPath, visibleNavItems } = await import('../src/app/nav.ts')

// ───────────────────────────── 夹具 ─────────────────────────────

function makeUser(overrides = {}) {
  return {
    id: 'u-1',
    username: 'zhangsan',
    nickname: '张三',
    role: 'MEMBER',
    status: 'ACTIVE',
    mustChangePassword: false,
    createdAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  }
}

function makeProvider(overrides = {}) {
  return {
    id: 'p-1',
    name: 'OpenAI 生产',
    baseUrl: 'https://api.openai.com/v1',
    type: 'CHAT',
    protocol: 'OPENAI_COMPAT',
    enabled: true,
    hasKey: true,
    apiKeyPreview: 'sk-****abcd',
    modelCount: 3,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  }
}

function makeModel(overrides = {}) {
  return {
    id: 'm-1',
    providerId: 'p-1',
    providerName: 'OpenAI 生产',
    providerEnabled: true,
    modelName: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    type: 'CHAT',
    maxContext: 128_000,
    embeddingDim: null,
    embeddingMultimodal: false,
    supportsVision: true,
    supportsReasoning: false,
    enabled: true,
    agentCount: 0,
    knowledgeBaseCount: 0,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  }
}

/** 与 `providerEditValuesOf` 同形状的表单值（编辑态 `apiKey` 恒为空串） */
function makeProviderForm(overrides = {}) {
  return { name: 'OpenAI 生产', baseUrl: 'https://api.openai.com/v1', type: 'CHAT', enabled: true, apiKey: '', ...overrides }
}

function makeModelForm(overrides = {}) {
  return {
    providerId: 'p-1',
    modelName: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    type: 'CHAT',
    maxContext: 128_000,
    embeddingDim: null,
    embeddingMultimodal: false,
    supportsVision: true,
    supportsReasoning: false,
    enabled: true,
    ...overrides,
  }
}

// ───────────────────────────── A 用户状态与操作矩阵 ─────────────────────────────

groupStart('A', '用户状态三态与操作矩阵（"不能操作自己"是业务约束）', '判据：`describeUserStatus` / `userRowActions`')

await it('A1 `ACTIVE` + 不需改密 ⇒ ok / 「启用」/ 无附加说明', () => {
  const view = describeUserStatus(makeUser())
  assertEqual(view.led, 'ok', '状态灯')
  assertEqual(view.label, USER_STATUS_LABELS.ACTIVE, '文案取自词表')
  assertEqual(view.hint, null, '没有额外含义就不写废话')
})

await it('A2 `ACTIVE` + 待首次改密 ⇒ warn 且说明"只能改密/看自己/登出"', () => {
  const view = describeUserStatus(makeUser({ mustChangePassword: true }))
  assertEqual(view.led, 'warn', '这是**第三态**，不是 ACTIVE 也不是 DISABLED')
  assertIncludes(view.label, '待首次改密', '标签要说清是哪一档')
  assertIncludes(view.hint ?? '', '首登闸门', '要说清这一档意味着什么')
})

await it('A3 `DISABLED` ⇒ fail 且说明"下个请求即 401"', () => {
  const view = describeUserStatus(makeUser({ status: 'DISABLED' }))
  assertEqual(view.led, 'fail', '状态灯')
  assertEqual(view.label, USER_STATUS_LABELS.DISABLED, '文案取自词表')
  assertIncludes(view.hint ?? '', '401', '停用的后果要说出来（`01` §3.1 的验收要点）')
})

await it('A4 两张词表与 `shared` 的取值域**逐键同源**（漏一个键在这里就红）', () => {
  assertDeepEqual(Object.keys(USER_ROLE_LABELS).sort(), [...USER_ROLES].sort(), '角色词表')
  assertDeepEqual(Object.keys(USER_STATUS_LABELS).sort(), [...USER_STATUSES].sort(), '状态词表')
})

await it('A5 对**别人**：三件操作都在，停用是红色、启用不是', () => {
  const actions = userRowActions(makeUser(), 'me')
  assertDeepEqual(
    actions.map((action) => action.key),
    ['edit', 'toggle', 'reset'],
    '三个操作的顺序固定（编辑 → 启停 → 重置）',
  )
  assertEqual(actions.every((action) => !action.disabled), true, '对别人没有一个是灰的')
  assertEqual(actions[1]?.danger, true, 'ACTIVE 的「停用」是危险操作')
  const enabling = userRowActions(makeUser({ status: 'DISABLED' }), 'me')
  assertEqual(enabling[1]?.label, '启用', 'DISABLED 时标签变「启用」')
  assertEqual(enabling[1]?.danger, false, '「启用」不是危险操作')
})

await it('A6 对**自己**：停用与重置标灰，且**各自写明原因**（灰按钮不加解释 = 页面坏了）', () => {
  const actions = userRowActions(makeUser({ id: 'me' }), 'me')
  assertEqual(actions[0]?.disabled, false, '编辑恒可点（弹窗里还有只读字段可看）')
  assertEqual(actions[1]?.disabled, true, '不能停用自己')
  assertEqual(actions[2]?.disabled, true, '不能重置自己的密码')
  for (const action of actions.filter((item) => item.disabled)) {
    assert(typeof action.reason === 'string' && action.reason.length > 10, `${action.key} 必须给出原因`)
  }
  assertIncludes(actions[2]?.reason ?? '', '修改密码', '要指路到本人自助改密那一条')
})

await it('A7 `EMPTY_USER_FORM_VALUES` 的默认角色是 MEMBER（与 DB 默认一致）', () => {
  assertEqual(EMPTY_USER_FORM_VALUES.role, 'MEMBER', '建号默认角色')
  assertEqual(EMPTY_USER_FORM_VALUES.username, '', '用户名默认空')
  assertEqual(userEditValuesOf(makeUser()).nickname, '张三', '编辑态取现有昵称')
  assertEqual(userEditValuesOf(makeUser({ nickname: null })).nickname, '', '昵称为 null ⇒ 空串（表单不为 null 设计）')
})

// ───────────────────────────── B 请求体构造 ─────────────────────────────

groupStart('B', '建号 / 改角色的请求体（空串不带键、"没改就不发"）', '判据：`buildCreateUserBody` / `buildUpdateUserBody`')

await it('B1 昵称空串 ⇒ **不带该键**（不是 `nickname: ""`）', () => {
  const body = buildCreateUserBody({ username: 'zhangsan', nickname: '   ', role: 'MEMBER' })
  assertEqual('nickname' in body, false, '空串按"没填"处理')
  assertDeepEqual(body, { username: 'zhangsan', role: 'MEMBER' }, '其余字段照带')
})

await it('B2 昵称有值 ⇒ trim 后带上', () => {
  const body = buildCreateUserBody({ username: '  zhangsan  ', nickname: '  张三  ', role: 'ADMIN' })
  assertDeepEqual(body, { username: 'zhangsan', nickname: '张三', role: 'ADMIN' }, '两端空白去掉')
})

await it('B3 `role` **总是带上**（不依赖服务端默认值 —— 否则请求体看不出实际存了什么）', () => {
  assertEqual('role' in buildCreateUserBody({ ...EMPTY_USER_FORM_VALUES, username: 'a' }), true, 'role 必带')
})

await it('B4 建号请求体不含任何密码字段（初始密码只能由服务端生成）', () => {
  const body = buildCreateUserBody({ username: 'a', nickname: '', role: 'MEMBER' })
  assertEqual('password' in body, false, '没有 password')
  assertEqual('initialPassword' in body, false, '没有 initialPassword')
})

await it('B5 改角色：**同值 ⇒ `null`**（不发请求，也不显示一句"保存成功"）', () => {
  assertEqual(buildUpdateUserBody(makeUser({ role: 'ADMIN' }), 'ADMIN'), null, '没改动')
})

await it('B6 改角色：异值 ⇒ **只带 `role` 这一个键**', () => {
  const body = buildUpdateUserBody(makeUser({ role: 'MEMBER' }), 'ADMIN')
  assertDeepEqual(body, { role: 'ADMIN' }, '不顺手带 status')
})

await it('B7 一个字段都没给会被后端拒 ⇒ 本函数永不返回空对象（要么 `null`、要么有键）', () => {
  const body = buildUpdateUserBody(makeUser({ role: 'MEMBER' }), 'ADMIN')
  assert(body !== null && Object.keys(body).length === 1, '空对象会被 `updateUserBodySchema` 的 `.refine` 拦成 400')
})

// ───────────────────────────── C 一次性初始密码 ─────────────────────────────

groupStart('C', '一次性初始密码（唯一一次明文）', '判据：`initialPasswordNotice` / `initialPasswordCopyText`')

await it('C1 建号与重置两版的**动词不同**（"创建成功" / "重置成功"）', () => {
  assertIncludes(initialPasswordNotice('zhangsan', false), '创建成功', '建号那版')
  assertIncludes(initialPasswordNotice('zhangsan', true), '重置成功', '重置那版')
})

await it('C2 文案里要有用户名、且**不含 Markdown 的 `**`**（JSX 文本子节点不认 Markdown）', () => {
  const text = initialPasswordNotice('zhangsan', false)
  assertIncludes(text, 'zhangsan', '要说清这份密码是谁的')
  assertExcludes(text, '**', '写了 `**` 界面上就是一串星号（P0-1-31 踩过）')
})

await it('C3 文案必须点明"只出现这一次"（否则用户会以为还能再查）', () => {
  assertIncludes(initialPasswordNotice('a', false), '只会出现这一次', '建号')
  assertIncludes(initialPasswordNotice('a', true), '只会出现这一次', '重置')
})

await it('C4 复制内容两行：用户名 + 初始密码（抄进邮件时两段都要给）', () => {
  const text = initialPasswordCopyText('zhangsan', 'Ab3kD9xQ2mP7rT5z')
  assertDeepEqual(text.split('\n'), ['用户名：zhangsan', '初始密码：Ab3kD9xQ2mP7rT5z'], '两行')
})

// ───────────────────────────── D Key 有进无出 ─────────────────────────────

groupStart('D', 'API Key 的三态与"绝不回填掩码"', '判据：`providerKeyIntent` / `buildProviderUpdateBody` / `providerEditValuesOf`')

await it('D1 输入框有值 ⇒ `set`（哪怕用户同时点了清除 —— 输入优先）', () => {
  assertEqual(providerKeyIntent({ apiKey: 'sk-new' }, true), 'set', '有值就是 set')
  assertEqual(providerKeyIntent({ apiKey: '  sk-new  ' }, false), 'set', 'trim 后非空也是 set')
})

await it('D2 输入框空 + 没点清除 ⇒ `keep`（**不动原 Key**）', () => {
  assertEqual(providerKeyIntent({ apiKey: '' }, false), 'keep', '空串不是"清空"，是"没碰它"')
})

await it('D3 输入框空 + 点了清除 ⇒ `clear`', () => {
  assertEqual(providerKeyIntent({ apiKey: '' }, true), 'clear', '清空必须走显式开关')
})

await it('D4 ⚠️ 核心断言：只改名字 ⇒ 请求体里**没有 `apiKey` 这个键**', () => {
  const provider = makeProvider()
  const body = buildProviderUpdateBody(provider, makeProviderForm({ name: 'OpenAI 备用' }), false)
  assertDeepEqual(body, { name: 'OpenAI 备用' }, '只带改了的字段')
  assertEqual(body !== null && 'apiKey' in body, false, '⚠️ 带上 apiKey（哪怕是空串）就是把 Key 抹掉')
})

await it('D5 什么都没改 ⇒ `null`（不发请求）', () => {
  assertEqual(buildProviderUpdateBody(makeProvider(), makeProviderForm(), false), null, '零改动')
})

await it('D6 显式清除 ⇒ `apiKey: null`（不是空串 —— 空串会被 400 拒）', () => {
  const body = buildProviderUpdateBody(makeProvider(), makeProviderForm({ name: 'x' }), true)
  assertEqual(body?.apiKey, null, '清空用 null 表达')
  assertEqual(body?.name, 'x', '其余改动照带')
})

await it('D7 写入新 Key ⇒ 值已 trim', () => {
  const body = buildProviderUpdateBody(makeProvider(), makeProviderForm({ apiKey: '  sk-brand-new  ' }), false)
  assertEqual(body?.apiKey, 'sk-brand-new', 'trim')
  assertEqual('name' in (body ?? {}), false, '没改的字段不带')
})

await it('D8 ⚠️ 编辑态的初值 `apiKey` 恒为**空串**（绝不回填掩码）', () => {
  const values = providerEditValuesOf(makeProvider())
  assertEqual(values.apiKey, '', '回填掩码 ⇒ 用户一点保存就把 `sk-****abcd` 当成真 Key 写进库')
  assertEqual(values.name, 'OpenAI 生产', '其余字段照填')
  assertEqual(values.baseUrl, 'https://api.openai.com/v1', 'baseUrl 照填')
})

await it('D9 `describeProviderKey`：未配置给「未配置」、已配置给掩码、有 Key 但没掩码也不给空串', () => {
  assertEqual(describeProviderKey({ hasKey: false, apiKeyPreview: null }), '未配置', '未配置')
  assertEqual(describeProviderKey({ hasKey: true, apiKeyPreview: 'sk-****abcd' }), 'sk-****abcd', '掩码原样显示')
  assertEqual(describeProviderKey({ hasKey: true, apiKeyPreview: null }), '已配置', '不返回空串（空读数会被当成"没配"）')
})

await it('D10 建 Provider：Key 可留空（先建后配是正常流程），空串时**不带该键**', () => {
  const withKey = buildCreateProviderBody({ ...EMPTY_PROVIDER_FORM_VALUES, name: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-1' })
  const without = buildCreateProviderBody({ ...EMPTY_PROVIDER_FORM_VALUES, name: 'a', baseUrl: 'https://x/v1' })
  assertEqual(withKey.apiKey, 'sk-1', '有 Key 就带上')
  assertEqual('apiKey' in without, false, '没 Key 就不带（`null` 与缺省同义，但"不带"更明确）')
  assertEqual(without.enabled, true, 'enabled 总要带（表单上是个明确的开关）')
})

// ───────────────────────────── E 改类型与迁移的守卫 ─────────────────────────────

groupStart('E', '三处"必然 409"的守卫：Provider.type / 模型 type / 模型 providerId', '判据：`providerTypeChangeBlocked` / `buildProviderUpdateBody` / `buildModelUpdateBody`')

await it('E1 Provider 下**有模型** ⇒ type 锁；没有模型 ⇒ 可改', () => {
  assertEqual(providerTypeChangeBlocked(makeProvider({ modelCount: 3 })), true, '有模型 ⇒ 锁')
  assertEqual(providerTypeChangeBlocked(makeProvider({ modelCount: 0 })), false, '空 Provider 可以改类型')
})

await it('E2 有模型时改 type ⇒ **不进请求体**；但同时改的名字照进（不是整个请求被吞掉）', () => {
  const body = buildProviderUpdateBody(
    makeProvider({ modelCount: 2 }),
    makeProviderForm({ type: 'EMBEDDING', name: '新名字' }),
    false,
  )
  assertDeepEqual(body, { name: '新名字' }, 'type 被丢弃、name 保留 —— 而不是干脆不发请求')
})

await it('E3 空 Provider 改 type ⇒ 正常带上', () => {
  const body = buildProviderUpdateBody(
    makeProvider({ modelCount: 0 }),
    makeProviderForm({ type: 'EMBEDDING' }),
    false,
  )
  assertEqual(body?.type, 'EMBEDDING', '没有模型时允许改类型')
})

await it('E4 模型被智能体引用 ⇒ type 锁（`agentCount > 0`）', () => {
  assertEqual(modelTypeChangeBlocked(makeModel({ agentCount: 1 })), true, '被引用 ⇒ 锁')
  assertEqual(modelTypeChangeBlocked(makeModel({ agentCount: 0 })), false, '没被引用 ⇒ 可改')
})

await it('E5 被引用的模型改 type ⇒ 丢弃该键，但**别的改动照带**', () => {
  const model = makeModel({ agentCount: 2 })
  const body = buildModelUpdateBody(model, makeModelForm({ type: 'EMBEDDING', label: '新别名' }))
  assertDeepEqual(body, { label: '新别名' }, 'type 丢弃、label 保留')
})

await it('E6 `buildModelUpdateBody` **永不构造 `providerId`**（迁移是 409，界面上不给入口）', () => {
  const model = makeModel()
  // 即使把表单里的 providerId 改成别的值，也不会进请求体
  const body = buildModelUpdateBody(model, makeModelForm({ providerId: 'p-other', label: '新别名' }))
  assertEqual(body !== null && 'providerId' in body, false, '不带 providerId')
  assertDeepEqual(body, { label: '新别名' }, '其余照带')
})

// ───────────────────────────── F maxContext 三态 ─────────────────────────────

groupStart('F', '`maxContext` 的三态与界面校验', '判据：`validateMaxContext` / `maxContextText` / `buildModelUpdateBody`')

await it('F1 界面上限与 `maxContextSchema` 同源（1 ~ 1000 万）', () => {
  assertEqual(MAX_CONTEXT_MIN, 1, '下限')
  assertEqual(MAX_CONTEXT_MAX, 10_000_000, '上限（挡"把 token 数填成字节数"这类量级错）')
})

await it('F2 留空合法；0 与负数被拦', () => {
  assertEqual(validateMaxContext(null), null, '留空 = 未知，合法')
  assert(validateMaxContext(0) !== null, '0 不是合法 token 数')
  assert(validateMaxContext(-1) !== null, '负数要拦')
  assertEqual(validateMaxContext(1), null, '1 通过')
})

await it('F3 超上限与非整数被拦', () => {
  assert(validateMaxContext(MAX_CONTEXT_MAX + 1) !== null, '超上限')
  assert(validateMaxContext(1.5) !== null, '必须是整数')
})

await it('F4 `null` 与 `0` 是两个意思：未填显示「未知」而不是 0', () => {
  assertEqual(maxContextText(null), '未知', '未填')
  assertEqual(maxContextText(128000), '128,000', '有值加千分位')
})

await it('F5 ⚠️ 三态：原 `null`+现 `null` ⇒ **不带键**；原数字+现 `null` ⇒ **显式 null**', () => {
  const keepNull = buildModelUpdateBody(makeModel({ maxContext: null }), makeModelForm({ maxContext: null, label: 'x' }))
  assertDeepEqual(keepNull, { label: 'x' }, '原本就没有、这次也没填 ⇒ 不动（不带键）')

  const cleared = buildModelUpdateBody(makeModel({ maxContext: 128_000 }), makeModelForm({ maxContext: null }))
  assertDeepEqual(cleared, { maxContext: null }, '清空必须显式 null，否则刷新后它又回来了')

  const set = buildModelUpdateBody(makeModel({ maxContext: 128_000 }), makeModelForm({ maxContext: 8192 }))
  assertDeepEqual(set, { maxContext: 8192 }, '设置新值')
})

await it('F6 建模型：`maxContext` 留空 ⇒ **不带该键**（不冒充"我选过了"）', () => {
  const body = buildCreateModelBody(makeModelForm({ maxContext: null }))
  assertEqual('maxContext' in body, false, '不带键')
  const withValue = buildCreateModelBody(makeModelForm({ maxContext: 8192 }))
  assertEqual(withValue.maxContext, 8192, '填了就带')
})

await it('F7 只清空 `maxContext` ⇒ 请求体**恰好只有一个键**（没顺手带上别的默认值）', () => {
  const body = buildModelUpdateBody(makeModel(), makeModelForm({ maxContext: null }))
  assertDeepEqual(body, { maxContext: null }, '只有这一个键')
})

await it('F8 模型表单的编辑初值与契约逐字段对齐（含布尔开关）', () => {
  const values = modelEditValuesOf(makeModel({ supportsVision: false, supportsReasoning: true, enabled: false, maxContext: null }))
  assertDeepEqual(
    values,
    {
      providerId: 'p-1',
      modelName: 'gpt-4o-mini',
      label: 'GPT-4o mini',
      type: 'CHAT',
      maxContext: null,
      embeddingDim: null,
      embeddingMultimodal: false,
      supportsVision: false,
      supportsReasoning: true,
      enabled: false,
    },
    '编辑初值',
  )
  assertDeepEqual(Object.keys(EMPTY_MODEL_FORM_VALUES).sort(), Object.keys(values).sort(), '建/编两个表单同形状')
})

// ───────────────────────────── G 分组呈现与顺序 ─────────────────────────────

groupStart('G', '按 Provider 分组的呈现（rowSpan）与"顺序只来自服务端"', '判据：`providerGroupSpans` / `summarizeModels` + 源码级"没有 sort("')

await it('G1 相邻同 Provider 合并：首行给段长、段内其余给 0', () => {
  const models = [
    makeModel({ id: 'm-1', providerId: 'p-1' }),
    makeModel({ id: 'm-2', providerId: 'p-1' }),
    makeModel({ id: 'm-3', providerId: 'p-2', providerName: 'B' }),
  ]
  assertDeepEqual(providerGroupSpans(models), [2, 0, 1], 'rowSpan 与入参逐位对应')
})

await it('G2 ⚠️ 同一 Provider 不相邻 ⇒ 分成**两段**（不全局归集，因为顺序就是服务端顺序）', () => {
  const models = [
    makeModel({ id: 'm-1', providerId: 'p-1' }),
    makeModel({ id: 'm-2', providerId: 'p-2' }),
    makeModel({ id: 'm-3', providerId: 'p-1' }),
  ]
  assertDeepEqual(
    providerGroupSpans(models),
    [1, 1, 1],
    '两批 p-1 各归各的段（显示成两个都写着同一 Provider 的块，这是**如实**的）',
  )
})

await it('G3 空数组 ⇒ 空 spans（不抛错）', () => {
  assertDeepEqual(providerGroupSpans([]), [], '空输入')
  assertDeepEqual(summarizeModels([]), { total: 0, providers: 0, disabled: 0, vision: 0 }, '空读数全 0')
})

await it('G4 `countProviders` 按**去重后的 Provider 数**算（与"段数"是两件事）', () => {
  const models = [
    makeModel({ id: 'm-1', providerId: 'p-1' }),
    makeModel({ id: 'm-2', providerId: 'p-2' }),
    makeModel({ id: 'm-3', providerId: 'p-1' }),
  ]
  assertEqual(countProviders(models), 2, '去重后是 2 个 Provider，尽管有 3 段')
})

await it('G5 `summarizeModels` 的四个读数（停用 / 支持图片分开数）', () => {
  const models = [
    makeModel({ id: 'm-1' }),
    makeModel({ id: 'm-2', enabled: false, supportsVision: false, providerId: 'p-2' }),
    makeModel({ id: 'm-3', supportsVision: false }),
  ]
  assertDeepEqual(summarizeModels(models), { total: 3, providers: 2, disabled: 1, vision: 1 }, '读数')
})

await it('G6 ⚠️ 源码级：`adminModel.ts` 与模型池页面里**没有 `sort(`**（顺序的口径只有服务端那一份）', () => {
  for (const name of ['pages/admin/adminModel.ts', 'pages/admin/ModelsPage.tsx']) {
    const source = stripComments(readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8'))
    assertExcludes(source, 'sort(', `${name} 不许自己排一次（会与 rowSpan 的分段打架）`)
  }
})

await it('G7 源码级：模型表**不给 Provider 列开 `sorter`**（排序会让 rowSpan 错位到别人头上）', () => {
  const page = stripComments(
    readFileSync(fileURLToPath(new URL('../src/pages/admin/ModelsPage.tsx', import.meta.url)), 'utf8'),
  )
  assertIncludes(page, 'rowSpan: spans[', 'Provider 列用 rowSpan 合并')
  assertExcludes(page, 'sorter', '整张表都不开客户端排序')
})

// ───────────────────────────── H 删除分级 ─────────────────────────────

groupStart('H', '删除分级：Provider 走级联档、用户没有删除接口', '判据：`modelDeleteBlockedNotice` + 源码级')

await it('H3 删模型：没被引用 ⇒ 没有阻力（走 Popconfirm 那一档）', () => {
  assertEqual(modelDeleteBlockedNotice(makeModel({ agentCount: 0 })), null, '可以删')
})

await it('H4 删模型：被在线智能体引用 ⇒ 文案带数字 + 409（只算在线，不含软删）', () => {
  const notice = modelDeleteBlockedNotice(makeModel({ agentCount: 3 }))
  assert(notice !== null, '要有提示')
  assertIncludes(notice, '3', '要说清几个')
  assertIncludes(notice, '409', '要说清后端会拒')
  assertIncludes(notice, '在线', '`agentCount` 只算在线智能体（删智能体已自动解绑）')
})

await it('H5 源码级：Provider 删除弹窗是**级联那一档**（危险标签 + 危险按钮 + 明示影响 + 无逐字确认）', () => {
  const modal = stripComments(
    readFileSync(fileURLToPath(new URL('../src/pages/admin/DeleteProviderModal.tsx', import.meta.url)), 'utf8'),
  )
  assertIncludes(modal, 'tag--danger', '`03` §七：级联删除要有危险标记')
  assertIncludes(modal, 'danger: true', '确认按钮是红色的')
  assertIncludes(modal, 'modelCount', '要明示影响范围（连带删掉几个模型）')
  // 需求优化：删除不再逐字输入确认，改为列出被自动解绑的模型清单
  assertIncludes(modal, 'useProviderBoundModels', '删除弹窗应列出会被自动解绑的模型（需求 3）')
  assertExcludes(modal, 'isProviderDeleteConfirmed', '已去掉逐字输入确认')
  assertExcludes(modal, 'aria-label="输入 Provider 名称以确认删除"', '已去掉"输入名称"确认输入框')
})

await it('H6 源码级：**用户没有删除接口 ⇒ 界面也没有删除入口**（不画一个灰掉的删除键）', () => {
  const api = stripComments(
    readFileSync(fileURLToPath(new URL('../src/api/adminUsers.ts', import.meta.url)), 'utf8'),
  )
  assertExcludes(api, "'DELETE'", '`02` §4.2 只有四个端点，没有 DELETE')
  const page = stripComments(
    readFileSync(fileURLToPath(new URL('../src/pages/admin/UsersListPage.tsx', import.meta.url)), 'utf8'),
  )
  assertExcludes(page, '删除用户', '界面上不出现"删除用户"这个动作')
})

// ───────────────────────────── I 拉取上游模型 ─────────────────────────────

groupStart('I', '拉取上游模型的读数（截断 / 0 条 / 未配 Key）', '判据：`remoteModelRows` / `remoteModelNotice`')

function makeRemoteResult(overrides = {}) {
  return {
    providerId: 'p-1',
    providerName: 'OpenAI 生产',
    baseUrl: 'https://api.openai.com/v1',
    total: 2,
    truncated: false,
    items: [
      { id: 'gpt-4o-mini', ownedBy: 'openai', created: 1_700_000_000, contextLength: 128_000 },
      { id: 'bge-m3', ownedBy: null, created: null, contextLength: null },
    ],
    ...overrides,
  }
}

await it('I1 上游给了上下文长度 ⇒ 带出；`ownedBy` 缺失保持 `null`', () => {
  const rows = remoteModelRows(makeRemoteResult())
  assertEqual(rows.length, 2, '两条')
  assertEqual(rows[0]?.contextLength, 128_000, '上游给的上下文长度原样带出（新建模型时默认填充）')
  assertEqual(rows[1]?.ownedBy, null, '上游没给就保持 null')
})

await it('I2 `contextLength` 为 `null` ⇒ 保持 `null`（标准 /models 多半不返回，读不到就留空）', () => {
  assertEqual(remoteModelRows(makeRemoteResult())[1]?.contextLength, null, '读不到不猜')
})

await it('I3 一条都没探到 ⇒ 提示核对 baseUrl + "可能不提供模型列表，请手工录入"', () => {
  const notice = remoteModelNotice(makeRemoteResult({ total: 0, items: [] }), true)
  assert(notice !== null, '要有提示')
  assertIncludes(notice, 'baseUrl', '先指向配置')
  assertIncludes(notice, '手工录入', '给一条可执行的路（`02` §4.3：404 文案要可执行）')
})

await it('I4 被截断 ⇒ 明说"只列了前 N 个，不是全部"（不静默截断）', () => {
  const notice = remoteModelNotice(makeRemoteResult({ total: 900, truncated: true }), true)
  assertIncludes(notice ?? '', '900', '上游真实条数')
  assertIncludes(notice ?? '', '不是全部', '要说清这是截断')
})

await it('I5 未配 Key 也探到 ⇒ 提醒"不代表能正常调用"', () => {
  const notice = remoteModelNotice(makeRemoteResult(), false)
  assertIncludes(notice ?? '', 'API Key', '要提这件事')
  assertIncludes(notice ?? '', '不代表', '探到 ≠ 能用')
})

await it('I6 一切正常 ⇒ `null`（不多话）', () => {
  assertEqual(remoteModelNotice(makeRemoteResult(), true), null, '没有需要提醒的边界')
})

// ───────────────────────────── K 上游协议（P0-1-37）─────────────────────────────
// ⚠️ 排在 J 组之前是**刻意**的：J 组是本档的"源码级守门"，按惯例收尾。

groupStart(
  'K',
  '上游协议：可选值由类型决定、改类型要把协议收回默认值、请求体只在真变了才带',
  '判据：`protocolOptionsFor` / `protocolAfterTypeChange` / `buildCreateProviderBody` / `buildProviderUpdateBody`',
)

await it('K1 可选协议由**类型**过滤：`CHAT` 三种都能选，`EMBEDDING` 只剩默认那一种', () => {
  assertEqual(
    protocolOptionsFor('CHAT')
      .map((option) => option.value)
      .join(','),
    'OPENAI_COMPAT,OPENAI_RESPONSES,ANTHROPIC_MESSAGES',
    '对话 Provider 的三种协议',
  )
  assertEqual(
    protocolOptionsFor('EMBEDDING')
      .map((option) => option.value)
      .join(','),
    'OPENAI_COMPAT',
    '向量 Provider 只允许默认协议 —— 与后端 `protocolAllowedForType` 同一判据（前端不另写一遍）',
  )
  assert(
    PROTOCOL_LOCKED_BY_TYPE_REASON.includes('embedding'),
    '锁住时的说明必须点明"embedding 只有一条路"，否则用户只看到灰掉的下拉',
  )
})

await it('K2 ⚠️ 改类型必须把协议收回默认值 —— 否则"CHAT+Anthropic 改成 EMBEDDING"是一次**必然 400** 的提交', () => {
  assertEqual(
    protocolAfterTypeChange('EMBEDDING', 'ANTHROPIC_MESSAGES'),
    'OPENAI_COMPAT',
    'CHAT+Anthropic → EMBEDDING：协议必须收回默认值（那个下拉在 EMBEDDING 下是灰的，用户没碰过它）',
  )
  assertEqual(
    protocolAfterTypeChange('EMBEDDING', 'OPENAI_RESPONSES'),
    'OPENAI_COMPAT',
    'Responses 同理',
  )
  assertEqual(protocolAfterTypeChange('CHAT', 'ANTHROPIC_MESSAGES'), 'ANTHROPIC_MESSAGES', '合法的组合不该被改动')
  assertEqual(protocolAfterTypeChange('CHAT', 'OPENAI_COMPAT'), 'OPENAI_COMPAT', '默认值不动')
  assertEqual(protocolAfterTypeChange('EMBEDDING', 'OPENAI_COMPAT'), 'OPENAI_COMPAT', '已经合法就保持')
})

await it('K3 ⚠️ 编辑态：`protocol` **要回填**、`apiKey` **绝不回填**（两者刻意相反）', () => {
  const provider = makeProvider({ protocol: 'ANTHROPIC_MESSAGES', apiKeyPreview: 'sk-****abcd' })
  const values = providerEditValuesOf(provider)
  assertEqual(values.protocol, 'ANTHROPIC_MESSAGES', '协议是给管理员看的既有配置，必须回填')
  assertEqual(values.apiKey, '', 'Key 恒为空串 —— 回填掩码会让"点一下保存"把掩码当新 Key 存进去')
  assert(!JSON.stringify(values).includes('sk-****abcd'), '掩码不许出现在表单初值里')
})

await it('K4 建 Provider **总是**带上 `protocol`（用户明确选过，不靠服务端默认值）', () => {
  const body = buildCreateProviderBody({
    name: '  OpenAI 生产  ',
    baseUrl: ' https://api.openai.com/v1/ ',
    type: 'CHAT',
    protocol: 'OPENAI_COMPAT',
    enabled: true,
    apiKey: '',
  })
  assertEqual(body.protocol, 'OPENAI_COMPAT', '哪怕就是默认值也要显式带上（否则"界面显示兼容、实际存了别的"看不出来）')
  assertEqual(body.name, 'OpenAI 生产', '名称两端空白要去掉')
  assert(!('apiKey' in body), 'Key 留空 ⇒ 不带这个键')

  const anth = buildCreateProviderBody({
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    type: 'CHAT',
    protocol: 'ANTHROPIC_MESSAGES',
    enabled: true,
    apiKey: '  sk-new  ',
  })
  assertEqual(anth.protocol, 'ANTHROPIC_MESSAGES', '非默认协议照样带')
  assertEqual(anth.apiKey, 'sk-new', 'Key 要去掉两端空白')
})

await it('K5 改 Provider：协议**逐字比较**，只在真变了才带；什么都没改 ⇒ `null`（不发请求）', () => {
  const provider = makeProvider({ protocol: 'ANTHROPIC_MESSAGES' })
  const baseline = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    type: provider.type,
    protocol: 'ANTHROPIC_MESSAGES',
    enabled: provider.enabled,
    apiKey: '',
  }

  assertEqual(buildProviderUpdateBody(provider, baseline, false), null, '一个字段都没改 ⇒ 不发请求')

  const onlyProtocol = buildProviderUpdateBody(provider, { ...baseline, protocol: 'OPENAI_RESPONSES' }, false)
  assertEqual(Object.keys(onlyProtocol).join(','), 'protocol', '只改协议 ⇒ 请求体里**只有** protocol 这个键')

  // ⚠️ 协议**没有**"有模型就不许改"的守卫（与 type 刻意相反，`02` §4.3）
  const manyModels = makeProvider({ protocol: 'ANTHROPIC_MESSAGES', modelCount: 9 })
  assertEqual(
    buildProviderUpdateBody(manyModels, { ...baseline, protocol: 'OPENAI_COMPAT' }, false).protocol,
    'OPENAI_COMPAT',
    'modelCount > 0 也要能改协议（协议填错了本来就该能改回来）',
  )
  // 而 type 在同一条路上是被拦的 —— 两条"刻意相反"的处置放在一起对照
  assertEqual(
    buildProviderUpdateBody(manyModels, { ...baseline, type: 'EMBEDDING' }, false),
    null,
    '改 type 被拦（不发必然 409 的请求）',
  )
})

await it('K6 三条协议的 `baseUrl` 提示各不相同且都点明后端会拼哪条路径', () => {
  const hints = ['OPENAI_COMPAT', 'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'].map((protocol) =>
    protocolBaseUrlHint(protocol),
  )
  assertEqual(new Set(hints).size, 3, '三条提示必须互不相同（提示一样就等于没提示）')
  assert(hints[0].includes('/chat/completions'), '兼容协议的提示要点明后缀')
  assert(hints[1].includes('/responses'), 'Responses 的提示要点明后缀')
  assert(hints[2].includes('/messages'), 'Anthropic 的提示要点明后缀')
  for (const hint of hints) {
    assert(hint.includes('版本段'), '三条都要提醒"填到版本段为止"（把整条 URL 粘进来是 404，而 404 不会说原因）')
  }
})

await it('K7 ⚠️ `values` 不带 `protocol` ⇒ 当作**没改**，绝不把 `undefined` 塞进请求体', () => {
  // 复现当时真红过的那一次：D4/D5/E2 用的就是不含 protocol 的 values 对象，
  // 于是 `undefined !== 'OPENAI_COMPAT'` 被判成"改过"，请求体里多出一个 `protocol: undefined`
  // ⇒ `Object.keys(body).length === 0` 这句被破坏，本该"不发请求"的零改动变成 `PATCH {}`（400）
  const provider = makeProvider({ protocol: 'OPENAI_COMPAT' })
  const partial = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    type: provider.type,
    enabled: provider.enabled,
    apiKey: '',
  }

  assertEqual(
    buildProviderUpdateBody(provider, partial, false),
    null,
    '一个有效字段都没改 ⇒ 必须 `null`（不发请求），而不是 `{ protocol: undefined }`',
  )

  const renamed = buildProviderUpdateBody(provider, { ...partial, name: 'OpenAI 备用' }, false)
  assertEqual(Object.keys(renamed).join(','), 'name', '只改名字 ⇒ 请求体里只有 name 这个键')
  assert(!('protocol' in renamed), '不带 protocol 的表单值不该凭空造出一个键')
})

// ───────────────────────────── J 源码级守门 ─────────────────────────────

groupStart('J', '源码级守门（几条"没有别的观测面"的正确性）', '判据：读源码文本断言，删掉就红')

/** 读 `frontend/src` 下所有 .ts/.tsx 的源码（去掉注释，避免注释里的示例命中） */
function sourceFiles() {
  const root = new URL('../src/', import.meta.url)
  const base = fileURLToPath(root)
  const names = readdirSync(root, { recursive: true })
    .filter((name) => typeof name === 'string' && /\.(ts|tsx)$/.test(name))
    .map((name) => name.replaceAll('\\', '/'))
  return names.map((name) => ({ name, source: stripComments(readFileSync(`${base}${name}`, 'utf8')) }))
}

await it('J1 「逐字确认」判据已随需求移除：全仓不再有 `isTypedConfirmMatch` 实现', () => {
  const definitions = sourceFiles().filter(({ source }) => /function\s+isTypedConfirmMatch\s*\(/.test(source))
  assertEqual(definitions.length, 0, `已去掉逐字确认，不应再有实现，实际：${definitions.map((f) => f.name).join(', ')}`)
})

await it('J2 四个删除弹窗都**不再**引用逐字确认（去掉重复输入）', () => {
  const expected = [
    'features/chat/DeleteConversationModal.tsx',
    'pages/agents/DeleteAgentModal.tsx',
    'pages/knowledge/DeleteKnowledgeBaseModal.tsx',
    'pages/admin/DeleteProviderModal.tsx',
  ]
  const files = sourceFiles()
  for (const name of expected) {
    const file = files.find((item) => item.name === name)
    assert(file !== undefined, `找不到 ${name}`)
    assertExcludes(file.source, 'isTypedConfirmMatch(', `${name} 不应再有逐字确认`)
    assertExcludes(file.source, 'app/confirm.js', `${name} 不应再 import 已删除的 confirm 模块`)
  }
})

await it('J3 `adminModel.ts` **零依赖**（不 import react / antd）—— 无依赖验收档成立的前提', () => {
  const model = sourceFiles().find(({ name }) => name === 'pages/admin/adminModel.ts')
  assert(model !== undefined, '找不到 adminModel.ts')
  assertExcludes(model.source, "'react'", '不 import react')
  assertExcludes(model.source, "'antd'", '不 import antd')
})

await it('J4 ⚠️ 表单初值**绝不**来自 `apiKeyPreview`（Key 有进无出在界面侧的落点）', () => {
  const model = sourceFiles().find(({ name }) => name === 'pages/admin/adminModel.ts')
  assertExcludes(model.source, 'apiKey: provider.apiKeyPreview', '把掩码当值 → 一保存就把掩码存成 Key')
  assertIncludes(model.source, "apiKey: '',", '编辑初值的 apiKey 恒为空串')
})

await it('J5 ⚠️ 模型池写操作必须失效**「可用模型」下拉**（否则停用后马上还能选到它）', () => {
  const api = sourceFiles().find(({ name }) => name === 'api/modelPool.ts')
  assert(api !== undefined, '找不到 api/modelPool.ts')
  assertIncludes(api.source, 'AVAILABLE_CHAT_MODELS_QUERY_KEY', '要带上这一个键')
  assertIncludes(api.source, 'invalidateModelPoolViews', '失效口径收在一处（三个键一次失效）')
  const calls = (api.source.match(/invalidateModelPoolViews\(queryClient\)/g) ?? []).length
  assertEqual(calls, 6, `六个写操作都要调它，实际 ${calls} 处（Provider 3 + 模型 3）`)
})

await it('J6 重置密码走 `POST .../reset-password`（不是 PATCH —— 写成 PATCH 会 200 但什么都没发生）', () => {
  const api = sourceFiles().find(({ name }) => name === 'api/adminUsers.ts')
  assertIncludes(api.source, 'reset-password', '路径')
  assertIncludes(api.source, "method: 'POST'", '动词')
})

await it('J7 ⚠️ 两条 admin 路由必须是**真页面且挂在 `RequireAdmin` 之内**', () => {
  const app = sourceFiles().find(({ name }) => name === 'app/App.tsx')
  assert(app !== undefined, '找不到 App.tsx')
  const guardAt = app.source.indexOf('<RequireAdmin')
  const usersAt = app.source.indexOf('path="/admin/users"')
  const modelsAt = app.source.indexOf('path="/admin/models"')
  assert(guardAt !== -1 && usersAt !== -1 && modelsAt !== -1, '三处都要在')
  assert(guardAt < usersAt && guardAt < modelsAt, '守卫必须在页面之前（嵌套顺序）')
  assertIncludes(app.source, '<UsersListPage />', '用户管理换真页面')
  assertIncludes(app.source, '<ModelsPage />', '模型池换真页面')
  assertExcludes(app.source, 'batch="P0-1-36"', '占位页必须已经撤掉')
})

await it('J8 一次性密码弹窗**不响应误关**（唯一一份明文，关掉就没有重开路径）', () => {
  const modal = sourceFiles().find(({ name }) => name === 'pages/admin/InitialPasswordModal.tsx')
  assert(modal !== undefined, '找不到弹窗')
  assertIncludes(modal.source, 'closable={false}', '不给右上角 ×')
  assertIncludes(modal.source, 'maskClosable={false}', '点遮罩不关')
  assertIncludes(modal.source, 'keyboard={false}', 'Esc 也关掉（`03` §七 第 9 条的**唯一一处显式例外**）')
})

await it('J9 ⚠️ 仪表轨的屏号能认出模型池（不然会显示兜底的「S-00 · 工作台」）', () => {
  assertEqual(serialForPath('/admin/users'), 'S-07 · 用户管理', '用户管理')
  assertEqual(serialForPath('/admin/models'), 'S-07b · 模型池', '模型池')
})

await it('J10 导航的 ADMIN 过滤仍只有一处判据（MEMBER 看不到两条管理项）', () => {
  const memberPaths = visibleNavItems('MEMBER').map((item) => item.path)
  const adminPaths = visibleNavItems('ADMIN').map((item) => item.path)
  assertEqual(memberPaths.includes('/admin/users'), false, 'MEMBER 看不到用户管理')
  assertEqual(memberPaths.includes('/admin/models'), false, 'MEMBER 看不到模型池')
  assertEqual(adminPaths.includes('/admin/users'), true, 'ADMIN 能看到用户管理')
  assertEqual(adminPaths.includes('/admin/models'), true, 'ADMIN 能看到模型池')
  assertEqual(visibleNavItems(undefined).includes(undefined), false, '未登录时按"只有公开项"处理（不抛错）')
})

await it('J11 ⚠️ `vite.config.ts` 取包名要用**最后一个** `node_modules/`（取第一个会得到 `.pnpm`）', () => {
  const config = stripComments(readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8'))
  assertIncludes(config, "lastIndexOf('node_modules/')", 'pnpm 的路径是 …/.pnpm/<pkg>/node_modules/<pkg>/…')
  assertIncludes(config, "pkg.startsWith('@ant-design/')", '`@ant-design/*` 必须与 `rc-*` 同块（否则循环 chunk 警告）')
  assertIncludes(config, 'manualChunks', '分包必须真的配了')
  assertExcludes(config, 'chunkSizeWarningLimit', '不靠抬告警线了事（本批要让输出**零告警**）')
})

await it('J12 管理页的样式只用已有类（不发明第二套读数类名）', () => {
  const files = ['pages/admin/UsersListPage.tsx', 'pages/admin/ModelsPage.tsx']
  const sources = files.map((name) => sourceFiles().find((item) => item.name === name))
  for (const [index, file] of sources.entries()) {
    assert(file !== undefined, `找不到 ${files[index]}`)
    for (const className of ['kb-cell', 'kb-cell__name', 'kb-cell__sub', 'led led--', 'card']) {
      assertIncludes(file.source, className, `${files[index]} 复用 ${className}`)
    }
    // 快捷页面导航（面包屑）已统一挪到顶栏 ⇒ 页面不再自带 `.crumb`（见 AppShell / crumbContext）
    assertExcludes(file.source, 'className="crumb"', `${files[index]} 不再自带面包屑`)
  }
})

await it('J13 ⚠️ 列表 hook 一律**对象参数**：`offset` 与 `limit` 都是 number，位置参数必然错位', () => {
  const files = sourceFiles()
  const hooks = [
    { file: 'api/modelPool.ts', hook: 'useModelProviders' },
    { file: 'api/modelPool.ts', hook: 'useAdminModels' },
    { file: 'api/adminUsers.ts', hook: 'useAdminUsers' },
    { file: 'api/agents.ts', hook: 'useAgents' },
  ]
  for (const { file, hook } of hooks) {
    const found = files.find((item) => item.name === file)
    assert(found !== undefined, `找不到 ${file}`)
    assert(
      new RegExp(`export function ${hook}\\(params:`).test(found.source),
      `${hook} 的首个形参必须是 \`params\`（对象参数）；写成 \`${hook}(offset = 0, limit = …)\` 时，` +
        `调用方传一个数字（如 PAGE_LIMIT_MAX）会被静默读成 offset ⇒ 列表整片变空且**没有任何报错**`,
    )
    assertIncludes(found.source, 'params.limit ??', `${hook} 必须从 params.limit 取默认值（对象参数真的被用上）`)
  }

  // 消费方：本仓唯一出过事故的那页 —— 实参必须是对象字面量
  const page = files.find((item) => item.name === 'pages/admin/ModelsPage.tsx')
  assert(page !== undefined, '找不到 ModelsPage.tsx')
  for (const hook of ['useModelProviders', 'useAdminModels']) {
    assert(
      new RegExp(`${hook}\\(\\{`).test(page.source),
      `${hook}( 的实参必须是对象字面量（曾写成 ${hook}(MODEL_POOL_PAGE_LIMIT_MAX)，页面把 3 个 Provider/2 个模型全当成"没有"）`,
    )
  }
  assertIncludes(page.source, 'limit: MODEL_POOL_PAGE_LIMIT_MAX', '两个 hook 都要显式带上 limit')
})

await it('J14 ⚠️ 协议下拉标灰 + 改类型走收口函数；列表里有一列「上游协议」', () => {
  const files = sourceFiles()

  const modal = files.find((item) => item.name === 'pages/admin/ProviderFormModal.tsx')
  assert(modal !== undefined, '找不到 ProviderFormModal.tsx')
  // ① 灰色下拉：`EMBEDDING` 下只剩一个选项就必须灰掉（配一个必然 400 的选项等于给用户挖坑）
  assertIncludes(modal.source, 'disabled={protocolLocked}', '协议选择器要按 protocolLocked 标灰')
  assertIncludes(modal.source, 'PROTOCOL_LOCKED_BY_TYPE_REASON', '标灰时要说清为什么（灰按钮不加解释等于页面坏了）')
  // ② 改类型必须经过收口函数 —— 直接 `setProtocol` 会留下"灰着的字段报 400"
  assert(
    /setProtocol\(\(current\) => protocolAfterTypeChange\(next, current\)\)/.test(modal.source),
    '类型选择器的 onChange 里必须调用 `protocolAfterTypeChange`：不收回默认值，' +
      '"CHAT+Anthropic 改成 EMBEDDING"就是一次必然 400 的提交，且报错字段是那个灰着的下拉',
  )
  // ③ baseUrl 的提示随协议变（三条路后缀不同，填错的表现是 404）
  assertIncludes(modal.source, 'protocolBaseUrlHint(protocol)', 'baseUrl 的提示要跟着协议走')

  const page = files.find((item) => item.name === 'pages/admin/ModelsPage.tsx')
  assert(page !== undefined, '找不到 ModelsPage.tsx')
  assertIncludes(page.source, "title: '上游协议'", 'Provider 表要单独一列显示协议（类型与协议是两个维度）')
  assertIncludes(page.source, 'UPSTREAM_PROTOCOL_LABELS[provider.protocol]', '列里读的是契约字段，不是自己拼的字符串')
})

// ───────────────────────────── P1-5：编辑被引用的向量模型要提示"哪些库需重建" ─────────────────────────────

groupStart('K', 'P1-5：编辑被引用的向量模型提示"哪些库需重建"', '判据：`modelEditAffectsVectors` / `knowledgeBasesUsingModel`')

await it('K1 改型号 / 维度 / 多模态 / 停用 才算"影响向量"；只改别名不算', () => {
  const emb = makeModel({ type: 'EMBEDDING', modelName: 'bge-m3', embeddingDim: 1024, embeddingMultimodal: false, enabled: true })
  const form = (over = {}) =>
    makeModelForm({ type: 'EMBEDDING', modelName: 'bge-m3', embeddingDim: 1024, embeddingMultimodal: false, enabled: true, ...over })
  assert(modelEditAffectsVectors(emb, form()) === false, '无改动 ⇒ 不影响')
  assert(modelEditAffectsVectors(emb, form({ modelName: 'other' })) === true, '改型号 ⇒ 影响')
  assert(modelEditAffectsVectors(emb, form({ embeddingDim: 1536 })) === true, '改维度 ⇒ 影响')
  assert(modelEditAffectsVectors(emb, form({ embeddingMultimodal: true })) === true, '改多模态 ⇒ 影响')
  assert(modelEditAffectsVectors(emb, form({ enabled: false })) === true, '停用 ⇒ 影响')
  assert(modelEditAffectsVectors(emb, form({ label: '换个别名' })) === false, '只改别名 ⇒ 不影响')
  assert(
    modelEditAffectsVectors(makeModel({ type: 'CHAT' }), makeModelForm({ modelName: 'gpt-5' })) === false,
    '对话模型恒不影响',
  )
})

await it('K2 `knowledgeBasesUsingModel` 只挑绑定到该模型的库', () => {
  const kbs = [
    { id: 'k1', embeddingModelId: 'm-1' },
    { id: 'k2', embeddingModelId: 'm-2' },
    { id: 'k3', embeddingModelId: null },
  ]
  assertDeepEqual(knowledgeBasesUsingModel('m-1', kbs).map((kb) => kb.id), ['k1'], '只挑绑定的')
  assertDeepEqual(knowledgeBasesUsingModel('m-9', kbs).map((kb) => kb.id), [], '没有绑定的返回空')
})

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── 结论表 ──${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.b}── P0-1-36 验收门槛四条对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 5 类页面全部可用，无阻断性缺陷 ........ ${c.d}归浏览器端测（` + '`README`' + ` 的「管理页」清单，全 UI 路径一次串完）${c.x}`)
console.log(`  ${c.g}②${c.x} /admin/users 可建号 + 启停 + 重置密码 ... B1~B7（请求体）+ C1~C4（一次性密码）+ J6（重置走 POST）`)
console.log(`     ${c.y}⚠️${c.x} "初始密码真的只下发一次"要问后端 ⇒ ` + '`pnpm verify:users`' + `${c.x}`)
console.log(`  ${c.g}③${c.x} /admin/models 维护 provider（Key 不回显）+ 模型 ... D1~D10（Key 三态与不回填）+ J4（源码级守门）`)
console.log(`  ${c.g}④${c.x} §七 交互规范十条落实 ..................... 见下（十条逐条点名）`)
console.log(`  ${c.g}坑${c.x} manualChunks：改一个页面不再重下整包 antd ... J11（配置口径）+ ` + '`pnpm build:frontend`' + ` 输出（零告警）${c.x}`)

console.log(`\n${c.b}── \`03\` §七 十条的落实位置（逐条点名） ──${c.x}`)
console.log(`  1 创建/编辑形态（≤6 字段用弹窗、同实体同形态）… UserFormModal / ProviderFormModal / ModelFormModal`)
console.log(`  2 删除分级（普通 = Popconfirm；级联 = Modal + 危险按钮 + 影响范围）… H3~H5（Provider 级联 / 模型普通 / 用户无删除）`)
console.log(`  3 保存语义（显式保存、失败停页 + 标注、成功 message）… 三个弹窗的 onOk + Alert + \`feedback.ok\``)
console.log(`  4 反馈通道（成功 message、失败 notification 带错误码、收在 api 层）… \`app/feedback.ts\`（本批零新增）`)
console.log(`  5 二级页动线（面包屑 / 左上返回）… 面包屑已统一挪到顶栏（AppShell），页面不再自带`)
console.log(`  6 表格规范（操作列右固定、文字链、危险红、删除最后、>3 收"更多"、每页 20）… 三张表都 \`fixed: 'right'\``)
console.log(`     ${c.d}❗ 三张表的操作数分别是 3 / 3 / 2 ⇒ "更多"菜单**当前无消费方**，不为用而用${c.x}`)
console.log(`  7 列表三态（空态带引导 / 骨架屏 / 错误带重试）… \`ListStates\`（本批零新增）`)
console.log(`  8 文案词表（统一"智能体"；动词按 \`01\`）… 界面用「创建用户」（\`01\` 的"建号"是需求用语，见 \`03\` §七 回写）`)
console.log(`  9 键盘约定（Enter 发送 / Esc 关弹窗与抽屉）… 三个弹窗的 onPressEnter + AntD 默认 Esc`)
console.log(`     ${c.y}⚠️${c.x} 唯一例外：一次性密码弹窗 \`keyboard={false}\`（关掉就没有重开路径），J8 守着`)
console.log(` 10 窄屏边界（桌面优先 ≥1280、<1024 保证可用）… 表格 \`scroll.x\` + \`.admin-section__head\` 的 flex-wrap`)

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · React 渲染与交互（表长什么样、弹窗能不能关、rowSpan 真的合并了吗）⇒ 浏览器端测（` + '`README`' + `）`)
console.log(`  · 真后端：409 的文案、掩码口径、上游探测的真实返回 ⇒ `)
console.log(`    ` + '`pnpm verify:users`' + ` / ` + '`verify:model-providers`' + ` / ` + '`verify:models`' + ` / ` + '`verify:llm`' + `${c.d}`)
console.log(`  · 打包产物：本档跑的是**源码**（` + '`node --import tsx`' + `），不经 vite${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 管理页面前端验收通过（P0-1-36）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 管理页面前端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
