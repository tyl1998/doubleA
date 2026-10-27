#!/usr/bin/env node
/**
 * verify-open-api-ui.mjs —— 「开放调用」区块前端**无依赖**验收（P1-22）
 *
 * 跑法：`pnpm verify:open-api-ui`（= `node --import tsx scripts/verify-open-api-ui.mjs`）
 *
 * 依据：`docs/08-开放平台-智能体OpenAPI(APIKey).md` §8（管理面）+ `shared/src/openApi.ts`（契约）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批前端可自证的风险，全在"**接错了但不会报错**"这一类上
 * ─────────────────────────────────────────────────────────────────────
 * ① **入口的语义位置**（2026-10-22 定案）：Key 的主语是「我 × 智能体」，所以管理入口在
 *    「我的凭据」页的新分区 `?section=openapi`，**不在**智能体编辑页。断言：凭据页有该 tab、
 *    编辑页只有指路条（不渲染管理组件）、`AGENT_SECTIONS`（参与保存）不含 `openKeys`。
 * ② **明文留在缓存/列表里**：明文只在 POST 响应里出现一次。断言：创建成功后只 `invalidate`
 *    列表、**不** `setQueryData`（后者会把明文塞进 query cache）。
 * ③ **前端自己判"过期"**：状态是服务端派生的（`shared#openApiKeyStatusOf`）。断言：区块里
 *    出现 `key.status` 的直读，且**没有**自己拿 `expiresAt` 与 `Date.now()` 比较。
 * ④ **吊销后不刷新**：断言吊销 mutation 的 `onSuccess` 里失效列表键。
 * ⑤ **接线**：编辑页两个分支都只给指路条（受众 R3 也是去凭据页签，而不是在别人的智能体页操作）。
 * ⑥ **弹窗能误关**：明文弹窗必须 `closable={false}` + `maskClosable={false}` + `keyboard={false}`。
 *
 * ⚠️ 本档**验不了**：真浏览器的表单交互、复制到剪贴板、后端落库与鉴权链 ⇒ 属浏览器端测 / 用户真跑。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const useColor = process.stdout.isTTY === true
const c = { g: useColor ? '\u001b[32m' : '', r: useColor ? '\u001b[31m' : '', d: useColor ? '\u001b[90m' : '', x: useColor ? '\u001b[0m' : '' }

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
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}：期望 ${e}，实得 ${a}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8')

const model = await import('../src/pages/agents/agentModel.ts')
const shared = await import('@doubulea/shared')

console.log('── O1 区块位置：我的凭据，不进保存链路 ──')
it('O1 `AGENT_SECTIONS`（参与保存）不含 openKeys；`AGENT_PAGE_SECTIONS`（渲染）含', () => {
  eq(
    [...model.AGENT_SECTIONS],
    ['basic', 'model', 'prompt', 'components'],
    '参与保存的四区',
  )
  eq(
    [...model.AGENT_PAGE_SECTIONS],
    ['basic', 'model', 'prompt', 'components', 'openKeys'],
    '页面区块（多一个 openKeys）',
  )
  assert(!model.AGENT_SECTIONS.includes('openKeys'), 'openKeys 不能进保存链路')
})
it('O2 编辑页的指路条：openKeys = 05 / 开放调用（文案只此一处）', () => {
  // P1-23 第九批：区块标题改成 key（`AGENT_SECTION_LABEL_KEY`）⇒ 守门转向"key + 字典译文"。
  eq(model.AGENT_SECTION_LABEL_KEY.openKeys, 'label.agentSection.openKeys', '标题用 key')
  eq(shared.translate('zh', model.AGENT_SECTION_LABEL_KEY.openKeys), '开放调用', '字典那句是"开放调用"')
  eq(model.sectionOrdinal('openKeys'), '05', '序号')
  eq(model.sectionOrdinal('components'), '04', '原有区块序号不受影响')
})
it('O3 脏区块判据不会凭空产出 openKeys（`changedSections` 只遍历 AGENT_SECTIONS）', () => {
  const baseline = { ...model.EMPTY_AGENT_FORM_VALUES }
  const dirty = model.changedSections(baseline, { ...baseline, name: 'x' })
  assert(dirty.includes('basic'), '改名字应标 basic')
  assert(!dirty.includes('openKeys'), '任何表单改动都不该标 openKeys')
})

console.log('── O2 状态派生只在服务端（shared）──')
it('O4 状态是 `shared` 的派生判据：过期优先于吊销', () => {
  const now = new Date('2026-10-22T00:00:00.000Z')
  eq(shared.openApiKeyStatusOf({ revokedAt: null, expiresAt: null }, now), 'ACTIVE', '不过期未吊销')
  eq(shared.openApiKeyStatusOf({ revokedAt: '2026-10-20T00:00:00.000Z', expiresAt: null }, now), 'REVOKED', '吊销')
  eq(
    shared.openApiKeyStatusOf({ revokedAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-10-21T00:00:00.000Z' }, now),
    'EXPIRED',
    '两者都有 ⇒ 过期优先（用户看到的症状是"用不了"）',
  )
})
it('O5 作用域文案与预设来自 `shared`（界面不另抄一份）', () => {
  eq(
    [...shared.OPEN_API_SCOPES],
    ['chat', 'conversation:read', 'conversation:write'],
    'scope 取值域',
  )
  assert(
    shared.OPEN_API_SCOPE_LABELS.chat.length > 0 &&
      shared.OPEN_API_SCOPE_LABELS['conversation:read'].length > 0 &&
      shared.OPEN_API_SCOPE_LABELS['conversation:write'].length > 0,
    '三个 scope 都必须有中文名',
  )
  eq([...shared.OPEN_API_SCOPE_PRESETS.readonly], ['conversation:read'], '只读预设')
})

console.log('── O3 区块组件的硬约束（静态）──')
const section = read('src/pages/agents/OpenApiKeysSection.tsx')
const api = read('src/api/openKeys.ts')
const form = read('src/pages/agents/AgentFormPage.tsx')

it('O6 明文弹窗不能误关（closable / maskClosable / keyboard 全关）', () => {
  const modal = section.slice(section.indexOf('function ApiKeyPlaintextModal'))
  assert(modal.includes('closable={false}'), '明文弹窗不给 ×')
  assert(modal.includes('maskClosable={false}'), '明文弹窗不响应遮罩')
  assert(modal.includes('keyboard={false}'), '明文弹窗不响应 Esc')
  assert(modal.includes('navigator.clipboard'), '必须给复制按钮（手工抄 32 位随机串是最大错源）')
})
it('O7 状态读服务端回带的 `status`，前端不自己比时间', () => {
  assert(section.includes('row.status') || section.includes('key.status'), '读服务端派生的 status')
  assert(
    !/Date\.now\(\)\s*[<>]/.test(section) && !/new Date\([^)]*\)\s*[<>]/.test(section),
    '不该在前端拿时间比较过期（时钟不同步会出现"显示有效却 401"）',
  )
})
it('O8 签发成功后**只失效列表**，不把明文写进缓存', () => {
  assert(api.includes('invalidateQueries'), '创建/吊销都要失效列表')
  // 只看**代码行**（去掉注释）：文件头的注释里会**提到** `setQueryData` 来解释"为什么不用它"
  const apiCode = api
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  assert(!apiCode.includes('setQueryData'), '不能 setQueryData（那会把明文留在 query cache 里）')
  const create = api.slice(api.indexOf('useCreateOpenApiKey'), api.indexOf('useRevokeOpenApiKey'))
  assert(create.includes('plaintext') === false, '创建 mutation 自己不保存明文（由页面本地 state 承载）')
  assert(!create.includes('agentId'), '签发不再接 agentId 参数（它在 body 里，由弹窗选）')
})
it('O9 界面提交前跑 `shared` 的同一份 schema（上限/必填只有一处）', () => {
  assert(section.includes('createOpenApiKeyBodySchema.safeParse'), '新建弹窗要先过 shared schema')
  assert(section.includes('OPEN_API_KEY_NAME_MAX'), '名称上限取 shared 常量')
  assert(section.includes('OPEN_API_MAX_CONCURRENCY_LIMIT'), '并发上限取 shared 常量')
  assert(section.includes('OPEN_API_RATE_LIMIT_PER_MIN_LIMIT'), 'RPM 上限取 shared 常量')
})
it('O10 签发**必须**选关联智能体（不再由页面上下文隐式决定）', () => {
  assert(section.includes('name="agentId"'), '新建弹窗要有「关联智能体」一项')
  assert(section.includes('请选择要关联的智能体'), '缺它要给明确文案')
  assert(section.includes('useAgents'), '下拉数据源 = 我能看见的智能体列表')
})

console.log('── O4 接线：入口真的存在 ──')
it('O11 智能体编辑页**不再**渲染 Key 管理组件，只给指路条（两个分支都是）', () => {
  const occurrences = form.split('<FormSection section="openKeys"').length - 1
  assert(occurrences === 2, `openKeys 指路条应出现两次（表单分支 + 只读分支），实得 ${occurrences}`)
  assert(!form.includes('OpenApiKeysSection'), '编辑页不该再引 Key 管理组件（语义：它是"我的"凭据）')
  assert(form.includes('OpenApiKeysHelp'), '两个分支都要用指路条')
  assert(form.includes("credentialsSectionPath('openapi')"), '指路条要链接到凭据页的开放调用分区')
})
it('O12 「我的凭据」页有开放调用分区（tab + 锚点 + 文案）', () => {
  const page = read('src/pages/mcp/McpCredentialsPage.tsx')
  assert(page.includes("key: 'openapi'"), '要有 openapi tab')
  // P1-23 第八批：tab 文案改成 key（`mcpCred.sectionOpenApi`）—— 守门转向"组件用 key + 字典译文"。
  assert(page.includes('mcpCred.sectionOpenApi'), 'tab 文案用 key')
  assert(page.includes('OpenApiKeysSection'), '分区内容 = 该组件')
  assert(read('src/app/paths.ts').includes("'openapi'"), 'CREDENTIALS_SECTIONS 含 openapi（深链可用）')
})
it('O13 接口路径是**按人**的 /api/open-keys（不是 /api/agents/:id/open-keys）', () => {
  assert(api.includes('/api/open-keys'), '列表 / 创建路径')
  assert(api.includes('/api/open-keys/${encodeURIComponent(keyId)}'), '吊销路径')
  assert(!api.includes('/api/agents/'), '不该再按智能体拼路径')
  assert(api.includes("method: 'POST'"), '创建用 POST')
  assert(api.includes("method: 'DELETE'"), '吊销用 DELETE')
})

console.log('── O5 编辑（2026-10-22 追加）：元数据可编辑、身份不可变 ──')
it('O14 编辑走 `PUT /api/open-keys/:keyId`，成功后失效列表；体里不携带 agentId/明文', () => {
  assert(api.includes('useUpdateOpenApiKey'), '要有编辑 hook')
  assert(api.includes("method: 'PUT'"), '编辑用 PUT')
  const update = api.slice(api.indexOf('useUpdateOpenApiKey'))
  // 既有惯例：mutation 里调 `invalidateOpenKeys(queryClient)`（`invalidateQueries` 在那个helper里）
  assert(
    update.includes('invalidateOpenKeys') || update.includes('invalidateQueries'),
    '编辑成功后也要失效列表（策略改了列表读数要跟着变）',
  )
  const updateCode = update
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  assert(!updateCode.includes('agentId'), '编辑体不携带 agentId（关联智能体不可变，换目标走吊销重签）')
  assert(!updateCode.includes('plaintext'), '编辑的请求体/响应绝无明文')
})
it('O15 编辑弹窗：提交过同一份 shared schema；放宽作用域需确认；已吊销不可编辑', () => {
  const modal = section.slice(section.indexOf('function EditKeyModal'))
  assert(modal.includes('updateOpenApiKeyBodySchema.safeParse'), '编辑弹窗提交前过 shared 的同一份 schema')
  assert(modal.includes('confirmWiden'), '放宽作用域必须勾选确认（保存即扩大 Key 能力）')
  assert(modal.includes('agentName'), '关联智能体在编辑弹窗里只读展示（不可改）')
  const actions = section.slice(section.indexOf("t('openApi.colActions')"), section.indexOf('function CreateKeyModal'))
  assert(
    actions.split("disabled={row.status === 'REVOKED'}").length - 1 >= 2,
    '编辑与吊销按钮对已吊销的 Key 一并禁用（终态不可编辑）',
  )
})

console.log()
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
