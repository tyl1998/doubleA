#!/usr/bin/env node
/**
 * verify-asset-acl.mjs —— 资产共享与用户组标签（P1-18）前端**无依赖**验收
 *
 * 跑法：`pnpm verify:asset-acl`（= `node --import tsx scripts/verify-asset-acl.mjs`）
 *
 * P1-13 立本档（四资产「所属人 + 可见性」），P1-18 重排为「授权跟着使用路径走」：
 *   · **Agent 三档**（`PRIVATE`/`SHARED`/`PUBLIC`，唯一带 per-user 受众）；
 *   · **知识库 三档**（2026-10-16 起与 Agent 一致，受众表 `knowledge_base_audiences`）；
 *   · **MCP 两档**（拒绝 `SHARED`）；
 *   · **Provider 无可见范围、无定向分享**（删除 `provider_shares` / `ShareProviderModal`）；
 *   · **受众组**（并进 `/admin/users` 的「用户组」tab + 受众选择器）与**登录可用用户搜索**；
 *   · **Provider 用户级凭据**（`credentialMode` + 「我的 Key」）。
 *
 * 本档验两类：① 纯函数（body 构造器）；② 接线（静态源码断言）。
 * ⚠️ **验不了**：真浏览器交互、后端行级权限真判 —— 属浏览器端测。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const useColor = process.stdout.isTTY === true
const c = { g: useColor ? '\u001b[32m' : '', r: useColor ? '\u001b[31m' : '', x: useColor ? '\u001b[0m' : '' }
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
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}：期望 ${e}，实得 ${a}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8')

const knowledge = await import('../src/pages/knowledge/knowledgeModel.ts')
const mcp = await import('../src/pages/mcp/mcpModel.ts')
const admin = await import('../src/pages/admin/adminModel.ts')
const agent = await import('../src/pages/agents/agentModel.ts')

// ───────────────────────────── A 纯函数：body 构造器 ─────────────────────────────

console.log('── A 可见范围 / 受众 / 凭据进入请求体（纯函数）──')

it('A1 智能体：创建带上 visibility 与受众；未改则更新体不带它', () => {
  const created = agent.buildCreateBody({ ...agent.EMPTY_AGENT_FORM_VALUES, name: 'x', modelId: 'm1', visibility: 'PUBLIC' })
  eq(created.visibility, 'PUBLIC', '创建要带上用户选的可见范围')
  eq(agent.EMPTY_AGENT_FORM_VALUES.visibility, 'PRIVATE', '新建默认私有（安全默认）')
  eq(agent.EMPTY_AGENT_FORM_VALUES.audience, { userIds: [], groupIds: [] }, '新建默认空受众')

  const baseline = { ...agent.EMPTY_AGENT_FORM_VALUES, name: 'x', modelId: 'm1', modelIds: ['m1'] }
  eq(agent.buildUpdateBody(baseline, baseline), null, '一个字段都没改 ⇒ null')
  const body = agent.buildUpdateBody(baseline, { ...baseline, visibility: 'PUBLIC' })
  eq(body.visibility, 'PUBLIC', '改了可见范围 ⇒ 带上它')
  assert(!('audience' in body), '改成 PUBLIC 不带 audience（后端会自动清空受众）')
})

it('A2 智能体：SHARED 带上 audience（用户 ∪ 组）；改受众 ⇒ 更新体带上', () => {
  const base = { ...agent.EMPTY_AGENT_FORM_VALUES, name: 'x', modelId: 'm1', modelIds: ['m1'] }
  const shared = {
    ...base,
    visibility: 'SHARED',
    audience: { userIds: ['11111111-1111-1111-1111-111111111111'], groupIds: [] },
  }
  const created = agent.buildCreateBody(shared)
  eq(created.visibility, 'SHARED', '创建 SHARED')
  eq(created.audience, { userIds: ['11111111-1111-1111-1111-111111111111'], groupIds: [] }, '创建带上受众')

  // 已是 SHARED，只改受众 ⇒ 更新体带 visibility + audience
  const body = agent.buildUpdateBody(shared, {
    ...shared,
    audience: { userIds: [], groupIds: ['22222222-2222-2222-2222-222222222222'] },
  })
  eq(body.audience, { userIds: [], groupIds: ['22222222-2222-2222-2222-222222222222'] }, '受众变化 ⇒ 带上')
  // 由 PRIVATE 切到 SHARED ⇒ 必须带 audience（否则后端 400「至少一个主体」）
  const toShared = agent.buildUpdateBody(base, shared)
  eq(toShared.visibility, 'SHARED', '切到 SHARED')
  eq(toShared.audience, { userIds: ['11111111-1111-1111-1111-111111111111'], groupIds: [] }, '切到 SHARED 必须带受众')
})

it('A3 知识库：三档可见范围（2026-10-16 起含 SHARED）+ 受众；只改它 ⇒ 只带它', () => {
  const created = knowledge.buildCreateBody({ ...knowledge.EMPTY_KNOWLEDGE_FORM_VALUES, name: 'kb', embeddingModelId: 'm1', visibility: 'PUBLIC' })
  eq(created.visibility, 'PUBLIC', '创建带上')
  eq(knowledge.EMPTY_KNOWLEDGE_FORM_VALUES.visibility, 'PRIVATE', '新建默认私有')
  eq(knowledge.EMPTY_KNOWLEDGE_FORM_VALUES.audience, { userIds: [], groupIds: [] }, '新建默认空受众')

  const kb = {
    name: 'kb',
    description: null,
    embeddingModelId: 'm1',
    captionModelId: null,
    visibility: 'PRIVATE',
    chunkSize: 800,
    chunkOverlap: 64,
    audience: { users: [], groups: [] },
  }
  eq(knowledge.buildKnowledgeUpdateBody(kb, knowledge.editValuesOf(kb)), null, '零改动 ⇒ null')
  const body = knowledge.buildKnowledgeUpdateBody(kb, { ...knowledge.editValuesOf(kb), visibility: 'PUBLIC' })
  eq(body, { visibility: 'PUBLIC' }, '只改可见范围 ⇒ 请求体只有它')

  // 2026-10-16：知识库也支持「指定用户」——切到 SHARED 必须带受众
  const sharedValues = { ...knowledge.editValuesOf(kb), visibility: 'SHARED', audience: { userIds: ['u1'], groupIds: [] } }
  const toShared = knowledge.buildKnowledgeUpdateBody(kb, sharedValues)
  eq(toShared.visibility, 'SHARED', '切到 SHARED')
  eq(toShared.audience, { userIds: ['u1'], groupIds: [] }, '切到 SHARED 必须带受众')
  const createdShared = knowledge.buildCreateBody({
    ...knowledge.EMPTY_KNOWLEDGE_FORM_VALUES,
    name: 'kb',
    embeddingModelId: 'm1',
    visibility: 'SHARED',
    audience: { userIds: ['u1'], groupIds: [] },
  })
  eq(createdShared.audience, { userIds: ['u1'], groupIds: [] }, '创建 SHARED 带受众')
})

it('A4 MCP：可见范围作为第二参传入；不传则不带该键', () => {
  const draft = mcp.emptyServerFormDraft()
  draft.name = 'git'
  draft.endpointUrl = 'https://mcp.internal/git'
  eq('visibility' in mcp.buildCreateServerBody(draft), false, '不传可见范围 ⇒ 不带该键')
  eq(mcp.buildCreateServerBody(draft, 'PUBLIC').visibility, 'PUBLIC', '传了就带上')

  const server = { name: 'git', endpointUrl: 'https://mcp.internal/git', credentialSchema: [], visibility: 'PRIVATE' }
  eq(mcp.buildServerUpdateBody(server, mcp.serverFormDraftFrom(server), 'PRIVATE'), null, '可见范围没变 ⇒ 零改动')
  eq(mcp.buildServerUpdateBody(server, mcp.serverFormDraftFrom(server), 'PUBLIC').visibility, 'PUBLIC', '改了 ⇒ 带上')
})

it('A5 Provider：body 带 credentialMode、不带 visibility；凭据模式变化才带上', () => {
  const created = admin.buildCreateProviderBody({ ...admin.EMPTY_PROVIDER_FORM_VALUES, name: 'p', baseUrl: 'https://x/v1' })
  assert(!('visibility' in created), '创建体绝不带 visibility')
  eq(created.credentialMode, 'SHARED', '创建体带默认凭据模式 SHARED')
  assert(!('visibility' in admin.EMPTY_PROVIDER_FORM_VALUES), 'Provider 表单初值里没有 visibility')

  const provider = { name: 'p', baseUrl: 'https://x/v1', customUrl: false, protocol: 'OPENAI_COMPAT', enabled: true, credentialMode: 'SHARED', modelCount: 0 }
  const values = { name: 'p', baseUrl: 'https://x/v1', customUrl: false, protocol: 'OPENAI_COMPAT', enabled: true, credentialMode: 'SHARED', apiKey: '' }
  eq(admin.buildProviderUpdateBody(provider, values, false), null, '零改动 ⇒ null')
  eq(admin.buildProviderUpdateBody(provider, { ...values, credentialMode: 'PER_USER' }, false), { credentialMode: 'PER_USER' }, '改凭据模式 ⇒ 只带它')
})

// ───────────────────────────── B API 接线 ─────────────────────────────

console.log('── B 转移 / 我的 Key / 用户组 接口接线（静态）──')

it('B1 四个资产的 transfer 接口都在，且打对路径与动词', () => {
  const agents = read('src/api/agents.ts')
  assert(agents.includes('useTransferAgent') && agents.includes('/transfer'), 'agents transfer')
  assert(agents.includes("method: 'POST'"), 'transfer 是 POST')

  const kb = read('src/api/knowledgeBases.ts')
  assert(kb.includes('useTransferKnowledgeBase') && kb.includes('/transfer'), 'kb transfer')

  const mcpApi = read('src/api/mcp.ts')
  assert(mcpApi.includes('useTransferMcpServer') && mcpApi.includes('/transfer'), 'mcp transfer')

  const pool = read('src/api/modelPool.ts')
  assert(pool.includes('useTransferModelProvider') && pool.includes('/transfer'), 'provider transfer')
})

it('B2 Provider 定向分享接口**已删除**；改为「我的 Key」三条（GET/PUT/DELETE my-credential）', () => {
  const pool = read('src/api/modelPool.ts')
  assert(!pool.includes('/shares'), 'provider_shares 相关路径应已删除')
  assert(!pool.includes('useShareModelProvider'), '分享 hook 应已删除')
  assert(pool.includes('useMyProviderCredential'), '我的 Key：读')
  assert(pool.includes('useSetMyProviderCredential'), '我的 Key：写')
  assert(pool.includes('useDeleteMyProviderCredential'), '我的 Key：清空')
  assert(pool.includes('/my-credential'), 'my-credential 路径')
  assert(pool.includes('/my-credentials'), '发现端点 /my-credentials（登录用户找"该配哪个 Provider"）')
})

it('B3 用户组六条接口 + 登录可用用户搜索', () => {
  const groups = read('src/api/userGroups.ts')
  for (const hook of ['useUserGroups', 'useUserGroup', 'useCreateUserGroup', 'useUpdateUserGroup', 'useReplaceUserGroupMembers', 'useRemoveUserGroup']) {
    assert(groups.includes(hook), hook)
  }
  assert(groups.includes('/api/admin/groups'), '组管理端点路径（(A)）')
  assert(groups.includes('/api/user-groups'), '组**读取**端点（登录可用，受众选择器用）')
  assert(groups.includes('/members'), '成员整体替换路径')

  const users = read('src/api/users.ts')
  assert(users.includes('/api/users/search'), '用户搜索端点（登录可用，非 admin）')
})

// ───────────────────────────── C 复用组件 ─────────────────────────────

console.log('── C 复用组件（静态）──')

it('C1 TransferOwnershipModal 支持四类资产，且用四个 transfer hook + 反馈通道', () => {
  const src = read('src/components/TransferOwnershipModal.tsx')
  for (const kind of ['AGENT', 'KNOWLEDGE', 'MCP', 'PROVIDER']) {
    assert(src.includes(kind), `assetKind ${kind}`)
  }
  for (const hook of ['useTransferAgent', 'useTransferKnowledgeBase', 'useTransferMcpServer', 'useTransferModelProvider']) {
    assert(src.includes(hook), hook)
  }
  assert(src.includes('useFeedback'), '成功 / 失败走全局反馈通道')
})

it('C2 模型池不再有行内「我的 Key」入口；配置统一到「我的凭据」的 ProviderKeySection', () => {
  const models = read('src/pages/admin/ModelsPage.tsx')
  assert(!models.includes('MyProviderKeyModal'), '行内「我的 Key」弹窗应已删除')
  assert(!models.includes('setMyKeyFor'), '行内「我的 Key」按钮应已删除')
  assert(models.includes('credentialsSectionPath'), '「各自 Key」未配置时引导去「我的凭据」的 Provider 分区')
  assert(read('src/pages/settings/ProviderKeySection.tsx').includes('useSetMyProviderCredential'), '配置入口仍在「我的凭据」页')
})

it('C3 AssetUserPicker 对非 ADMIN 退回"粘贴 uuid"，不造一个必然 403 的下拉', () => {
  const src = read('src/components/AssetUserPicker.tsx')
  assert(src.includes('useCurrentUser'), '按角色分派')
  assert(src.includes("role === 'ADMIN'") || src.includes("=== 'ADMIN'"), '判 ADMIN')
  assert(src.includes('UUID'), '非管理员提示粘贴 uuid')
})

it('C3b 我的凭据页有「模型 Provider 凭据」区（各自 Key 可配、共享 Key 只读展示）', () => {
  const section = read('src/pages/settings/ProviderKeySection.tsx')
  assert(section.includes('useMyProviderCredentials'), '「我的凭据」页的 Provider 凭据清单（列全部 Provider）')
  assert(section.includes('useSetMyProviderCredential') && section.includes('useDeleteMyProviderCredential'), '「各自 Key」可就地保存 / 清除')
  assert(section.includes('PER_USER') && section.includes('SHARED'), '两种模式都列（PER_USER 可配 + SHARED 只读）')
  assert(section.includes('只读'), '共享 Key 是只读展示（改它去模型池）')
  assert(read('src/pages/mcp/McpCredentialsPage.tsx').includes('ProviderKeySection'), '挂在「我的凭据」页')
})

it('C4 AudiencePicker 按 人 / 组 圈选（用户走登录可用搜索，组走组列表）', () => {
  const src = read('src/components/AudiencePicker.tsx')
  assert(src.includes('useUserSearch'), '用户搜索数据源')
  assert(src.includes('useUserGroups'), '组数据源')
  assert(src.includes('userIds') && src.includes('groupIds'), '两类受众主体')
})

it('C5 VisibilityBadge 用 shared 的标签常量，且处理 SHARED', () => {
  const src = read('src/components/VisibilityBadge.tsx')
  assert(src.includes('ASSET_VISIBILITY_LABELS'), '读 shared 常量')
  assert(src.includes('SHARED'), '三档里要处理 SHARED')
})

// ───────────────────────────── D 列表页 ─────────────────────────────

console.log('── D 列表页：徽标 / 所属人 / canEdit 门禁（静态）──')

it('D1 智能体 / 知识库 / MCP 列表页有可见范围徽标；模型池不再有', () => {
  for (const file of [
    'src/pages/agents/AgentsListPage.tsx',
    'src/pages/knowledge/KnowledgeListPage.tsx',
    'src/pages/mcp/McpServersPage.tsx',
  ]) {
    const src = read(file)
    assert(src.includes('VisibilityBadge'), `${file} 要有 VisibilityBadge`)
  }
  assert(!read('src/pages/admin/ModelsPage.tsx').includes('VisibilityBadge'), '模型池不该再有可见范围徽标')
})

it('D2 模型池：Provider 行无行内「我的 Key」「转移所属人」按钮；凭据两列已合并；所属人列可点转移', () => {
  const src = read('src/pages/admin/ModelsPage.tsx')
  assert(!src.includes('MyProviderKeyModal') && !src.includes('setMyKeyFor'), '行内「我的 Key」应已删除')
  assert(!src.includes('setTransferFor(provider)'), '行内「转移所属人」按钮应已删除（改由所属人列触发）')
  assert(src.includes('setTransferFor({ id: provider.id'), 'Provider「所属人」列可点转移')
  assert(src.includes('setTransferFor({ id: model.providerId'), '模型行「所属人」列可点转移（转的是其 Provider）')
  assert(src.includes('assetKind="PROVIDER"'), '转移的是 Provider')
  assert(!src.includes('ShareProviderModal'), '分享弹窗应已删除')
  // 原来讲 Key 的两列（「共享 Key」+「凭据」）已合并为一列「凭据」
  assert(src.includes("title: '凭据'") && !src.includes("title: '共享 Key'"), '共享 Key 与凭据两列已合并')
  assert(src.includes('PROVIDER_CREDENTIAL_MODE_LABELS'), '凭据模式列')
  assert(src.includes('credentialsSectionPath'), '「各自 Key」未配置时去「我的凭据」的 Provider 分区')
  assert(src.includes('providerBaseUrl'), '模型行显示所属 Provider 的 baseUrl')
})

it('D3 模型池：Provider 与模型都按 canEdit 门禁编辑 / 删除', () => {
  const src = read('src/pages/admin/ModelsPage.tsx')
  assert(src.includes('provider.canEdit'), 'Provider 按 canEdit')
  assert(src.includes('model.canEdit'), '模型按 canEdit')
})

it('D4 智能体列表：三档可见范围 + 受众回显', () => {
  const src = read('src/pages/agents/AgentsListPage.tsx')
  assert(src.includes('VisibilityBadge'), '徽标')
  assert(src.includes('audience'), '受众回显/说明')
})

it('D5 用户组面板（嵌在用户管理页）：列表 / 建 / 改 / 成员替换 / 删', () => {
  const src = read('src/pages/admin/UserGroupsPanel.tsx')
  assert(src.includes('useUserGroups'), '列表')
  assert(src.includes('useCreateUserGroup'), '建组')
  assert(src.includes('useUpdateUserGroup'), '改组')
  assert(src.includes('useReplaceUserGroupMembers'), '整体替换成员')
  assert(src.includes('useRemoveUserGroup'), '删组')
})

it('D6 三类列表：所属人列即转移入口（点击弹出 TransferOwnershipModal），无行内「转移所属人」按钮', () => {
  for (const file of [
    'src/pages/agents/AgentsListPage.tsx',
    'src/pages/knowledge/KnowledgeListPage.tsx',
    'src/pages/mcp/McpServersPage.tsx',
  ]) {
    const src = read(file)
    assert(src.includes('点击转移所属人'), `${file} 所属人列应可点转移`)
    assert(src.includes('TransferOwnershipModal'), `${file} 应挂转移弹窗`)
    assert(!src.includes('ShareProviderModal'), `${file} 不该有分享弹窗`)
  }
})

it('D7 用户列表新增「所在组」列；改组成员 / 组名会失效用户清单', () => {
  const src = read('src/pages/admin/UsersListPage.tsx')
  assert(src.includes("title: '所在组'"), '用户列表要有「所在组」列')
  assert(src.includes('user.groups'), '读服务端下发的 groups（不自己算）')
  assert(
    read('src/api/userGroups.ts').includes('ADMIN_USERS_QUERY_KEY'),
    '组成员增删 / 组改名 / 删组要失效用户清单（否则「所在组」列不刷新）',
  )
})

// ───────────────────────────── E 表单 ─────────────────────────────

console.log('── E 表单：可见范围开关 / 受众 / 凭据模式（静态）──')

it('E1 智能体表单三档 + 受众；知识库 / MCP 表单可见范围（2026-10-16：知识库也三档）；Provider 表单已无可见范围', () => {
  const agentForm = read('src/pages/agents/AgentFormPage.tsx')
  assert(agentForm.includes('name="visibility"') && agentForm.includes('ASSET_VISIBILITIES'), 'Agent 表单三档开关')
  assert(agentForm.includes('name="audience"') && agentForm.includes('AudienceField'), 'Agent 表单受众项')

  const kbForm = read('src/pages/knowledge/KnowledgeBaseFormModal.tsx')
  assert(kbForm.includes('ASSET_VISIBILITIES'), 'KB 表单三档（2026-10-16 起含「指定用户」）')
  assert(kbForm.includes('AudiencePicker'), 'KB 表单受众选择器')
  assert(read('src/pages/mcp/McpServerFormModal.tsx').includes('KB_MCP_VISIBILITIES'), 'MCP 表单两档')

  const providerForm = read('src/pages/admin/ProviderFormModal.tsx')
  assert(!providerForm.includes('ASSET_VISIBILITIES'), 'Provider 表单不该有可见范围开关')
  assert(!providerForm.includes('name="visibility"'), 'Provider 表单不该有 visibility 字段')
  assert(providerForm.includes('PROVIDER_CREDENTIAL_MODES'), 'Provider 表单有凭据模式选择')
})

it('E2 Agent 表单在公开/指定用户时提示"自愿共享"', () => {
  const agentForm = read('src/pages/agents/AgentFormPage.tsx')
  assert(agentForm.includes('自愿共享'), '要说明公开/指定用户属于自愿共享')
})

it('E3 表单失败展示服务端文案', () => {
  assert(read('src/pages/agents/AgentFormPage.tsx').includes('feedback.fail'), 'Agent 展示服务端文案')
  assert(read('src/pages/knowledge/KnowledgeBaseFormModal.tsx').includes('describeError'), 'KB 展示服务端文案')
  assert(read('src/pages/admin/ProviderFormModal.tsx').includes('describeError'), 'Provider 展示服务端文案')
  assert(read('src/pages/mcp/McpServerFormModal.tsx').includes('feedback.fail'), 'MCP 展示服务端文案')
})

it('E4 智能体表单：onValuesChange 取全量 store（防条件字段被抹掉 → 整页白屏）', () => {
  const src = read('src/pages/agents/AgentFormPage.tsx')
  assert(src.includes('getFieldsValue(true)'), 'onValuesChange 要用 `form.getFieldsValue(true)` 镜像全量表单值')
  assert(
    !/onValuesChange=\{\(_,\s*all\)\s*=>\s*setValues\(all\)\}/.test(src),
    '不能用"仅注册字段"的入参 setValues(all)：条件渲染的 audience 会变 undefined ⇒ 白屏',
  )
  assert(
    read('src/pages/agents/agentModel.ts').includes('values.audience ??'),
    'audienceChanged 要对缺失的 audience 兜底',
  )
})

// ───────────────────────────── F 导航 / 路由 ─────────────────────────────

console.log('── F 导航与路由（静态）──')

it('F1 App.tsx：/admin/models 在 RequireAdmin 之外；/admin/users、/admin/egress 在内；/admin/groups 已并入用户页', () => {
  const app = read('src/app/App.tsx')
  const guardAt = app.indexOf('<RequireAdmin')
  const usersAt = app.indexOf('path="/admin/users"')
  const modelsAt = app.indexOf('path="/admin/models"')
  const egressAt = app.indexOf('path="/admin/egress"')
  assert(guardAt !== -1 && usersAt !== -1 && modelsAt !== -1 && egressAt !== -1, '四处都要在')
  assert(modelsAt < guardAt, '模型池必须在 RequireAdmin 之前（= 登录即可）')
  assert(usersAt > guardAt && egressAt > guardAt, '用户管理 / 出网策略在守卫之内')
  assert(!app.includes('path="/admin/groups"'), '用户组不再有独立路由（并入 /admin/users）')
})

it('F2 nav.ts：模型池不再 adminOnly；用户管理 / 出网策略仍是；不再有用户组导航项', () => {
  const nav = read('src/app/nav.ts')
  const mlLine = nav.split('\n').find((line) => line.includes("path: '/admin/models'"))
  assert(mlLine !== undefined && !mlLine.includes('adminOnly'), '模型池不该再是 ADMIN 专属')
  const usLine = nav.split('\n').find((line) => line.includes("path: '/admin/users'"))
  assert(usLine !== undefined && usLine.includes('adminOnly: true'), '用户管理仍 adminOnly')
  assert(!nav.includes("code: 'GP'"), '用户组导航项应已删除（并入用户管理）')
})

console.log(`\nverify-asset-acl：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
