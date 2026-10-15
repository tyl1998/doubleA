#!/usr/bin/env node
/**
 * verify-chat-home.mjs —— P1-15「聊天主页与信息架构改造」前端**无依赖**验收
 *
 * 跑法：`pnpm verify:chat-home`
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一档守什么（都是"错了不报错、只是入口跑到别处 / 宽度不对"的一类）
 * ─────────────────────────────────────────────────────────────────────
 *   · **路由映射**：`chatPath` 必须产出规范路径（`/new/:agentId` / `/c/:conversationId`），
 *     `AGENTS_PATH` 必须是 `/agents`（不是 `/`）—— 写错只会"跳到能打开但不对的页面"；
 *   · **跨智能体会话视图**：`conversationItemView` 必须带上会话所属智能体快照（徽标读数）；
 *   · **Code 模式常量**：默认 640 / 下限 560（列宽改错只是"编辑器窄了一点"）；
 *   · **体积口径单一**：`formatSize` 在全仓**不存在**、`formatBytes` 只有一处 `function`；
 *   · **导航权限**：用量统计 `UT` 不再 `adminOnly`（否则非 ADMIN 看不到入口）；
 *   · **源码级守门**：`ConvRail` 存在且不含 `.sort(`；`ChatPage` 不再渲染旧侧栏；
 *     旧 `ConversationSidebar.tsx` 已删除；面板宽度写进了 `localStorage`。
 *   · **R3（2026-10-13）**：单一外壳（`AppShell` / 删 `AppLayout`）、会话栏开关是主区浮层
 *     （`app-shell__toggle`，旧会话栏内按钮已删）、新会话可预置「不记入记忆」、
 *     只读保留会话（Agent 软删）可打开、头部会话控件改为**内联**（不再齿轮 popover）。
 *   · **R4（2026-10-13）**：会话控件（模型 / 自动审批 / 记忆 / Code / 专注 / 产物入口）从标题栏
 *     移到**输入框下方**、用**图标按钮**（`composer-control` + 点击弹动 `is-pop`）；
 *     标题栏右侧改为**设置图标**（直接进编辑智能体）。
 *   · **R5（2026-10-13）**：**模型不能只给一个图标** —— 用户要一眼看到当前模型 ⇒ 模型仍是
 *     **文字选择器**（`Select` / 只读 chip）。
 *   · **R6（2026-10-13）**：窄屏（≤1280）**Code 模式的工作区常驻并排**（不再收成盖住对话的
 *     抽屉）；主区左上角会话栏浮层按钮与标题栏智能体 chip **同高、纵向对齐**。
 *   · **R7（2026-10-13）**：窄屏（≤1280）**非 Code 的产物面板也常驻并排**（与 Code 同款，
 *     按比例收窄），输入框下方那枚「打开产物面板」入口（`composer-control--narrow` +
 *     `onOpenPanel`）与产物抽屉一并删除。
 *   · **F8（2026-10-14）**：新会话态（`conversationId` 尚未生成）开 Code 模式 ⇒ 第三列是
 *     **空工作区占位**（`WorkspacePanelPlaceholder`），**不回落**到产物面板。
 *   · **F9（2026-10-14）**：非 Code 的**产物面板可收起 / 展开**（第三列开关，`panelOpen` ∩ `showPanel`）。
 *
 *   · **G（2026-10-13）**：侧边栏分两层 —— 上层「平台功能」（六条直达入口 + `管理 ▸` 就地展开
 *     剩余入口，约 35% 高）、下层「会话」（约 65% 高，分组标题可点击收缩）。
 *
 * ⚠️ 验不到的（归浏览器端测）：进站即聊天主页、平台功能高亮与「管理」展开、会话分组收缩、
 *   会话栏浮层开关、只读保留会话、头部内联控件的实际观感、专注工作区输入框不再冒滚动条。
 */

import { existsSync, readFileSync } from 'node:fs'

// ───────────────────────────── 断言脚手架 ─────────────────────────────

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0

function it(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${title}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${title}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}
function includes(haystack, needle, message) {
  if (!haystack.includes(needle)) throw new Error(`${message}: 未找到 ${JSON.stringify(needle)}`)
}
function notIncludes(haystack, needle, message) {
  if (haystack.includes(needle)) throw new Error(`${message}: 不该出现 ${JSON.stringify(needle)}`)
}

// ───────────────────────────── 被测模块 ─────────────────────────────

const { chatPath, conversationPath, newConversationPath, AGENTS_PATH, HOME_PATH } = await import('../src/app/paths.ts')
const { isChatHomePath, conversationIdFromPath } = await import('../src/app/paths.ts')
const { conversationItemView, groupConversationViews } = await import('../src/features/chat/conversationList.ts')
const {
  WORKSPACE_PANEL_DEFAULT_W,
  WORKSPACE_PANEL_MIN_W,
  clampWorkspacePanelWidth,
} = await import('../src/features/chat/workspaceModel.ts')
const { formatBytes } = await import('../src/app/format.ts')
const { NAV_ITEMS, visibleNavItems } = await import('../src/app/nav.ts')

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const src = (relative) => new URL(relative, import.meta.url)

// ───────────────────────────── A 路由映射 ─────────────────────────────

console.log(`\n${c.b}── A 路由映射（§二 新信息架构）──${c.x}`)

it('A1 `chatPath` 有会话 ⇒ `/c/:id`、无会话 ⇒ `/new/:agentId`', () => {
  eq(chatPath('agent-1'), '/new/agent-1', '无会话 ⇒ 新会话态')
  eq(chatPath('agent-1', 'conv-9'), '/c/conv-9', '有会话 ⇒ 定位会话（不再带 agentId）')
  eq(conversationPath('conv-9'), '/c/conv-9', 'conversationPath 是规范构造点')
  eq(newConversationPath('agent-1'), '/new/agent-1', 'newConversationPath 是规范构造点')
})

it('A2 智能体列表搬到 `/agents`（`/` 让给聊天主页）', () => {
  eq(AGENTS_PATH, '/agents', '智能体列表路径')
  eq(HOME_PATH, '/', '首页 = 聊天主页')
  const ag = NAV_ITEMS.find((item) => item.code === 'AG')
  assert(ag !== undefined, '导航里应当有 AG')
  eq(ag.path, AGENTS_PATH, 'AG 指向 /agents（不是 /）')
})

it('A3 特殊字符被编码（不是拼出一个"看着对、打过去 404"的链接）', () => {
  includes(conversationPath('a/b c'), '%2F', '斜杠被编码')
  includes(newConversationPath('a/b c'), '%2F', '斜杠被编码')
})

it('A4 聊天视图判据 `isChatHomePath`：`/`、`/c/:id`、`/new/:agentId`、老深链 ⇒ 真；管理页 ⇒ 假', () => {
  for (const path of ['/', '/c/conv-1', '/new/agent-1', '/chat/agent-1', '/chat/agent-1/conv-1']) {
    eq(isChatHomePath(path), true, `${path} 属于聊天视图`)
  }
  for (const path of ['/agents', '/knowledge', '/mcp', '/tasks', '/artifacts', '/settings/credentials', '/admin/usage']) {
    eq(isChatHomePath(path), false, `${path} 属于页面视图（同一外壳的另一种形态）`)
  }
})

it('A5 `conversationIdFromPath` 从 `/c/:id` 还原会话 id（与 conversationPath 对称、能解编码）', () => {
  eq(conversationIdFromPath('/c/conv-9'), 'conv-9', '正常 id')
  eq(conversationIdFromPath('/c/a%2Fb%20c'), 'a/b c', '解开 encodeURIComponent')
  eq(conversationIdFromPath('/'), undefined, '首页没有会话 id')
  eq(conversationIdFromPath('/new/agent-1'), undefined, '新会话态没有会话 id')
  eq(conversationIdFromPath('/c/'), undefined, '空 id 视为没有')
})

// ───────────────────────────── B 跨智能体会话视图 ─────────────────────────────

console.log(`\n${c.b}── B 跨智能体会话视图（ConvRail 的读数来源）──${c.x}`)

const NOW = new Date('2026-10-12T15:00:00')
const conv = (patch) => ({
  id: 'conv-1',
  agentId: 'agent-1',
  agentName: '报销助手',
  agentType: 'CHATBOT',
  topic: '报销单金额核对',
  status: 'ACTIVE',
  lastMessageAt: '2026-10-12T14:57:00',
  createdAt: '2026-10-12T14:00:00',
  updatedAt: '2026-10-12T14:57:00',
  ...patch,
})

it('B1 视图带上智能体快照（跨智能体列表靠它一屏分清"这条是谁的"）', () => {
  const view = conversationItemView(conv({ agentName: '周报生成', agentType: 'TASK_AGENT' }), NOW, new Set())
  eq(view.agentId, 'agent-1', 'agentId 快照')
  eq(view.agentName, '周报生成', 'agentName 快照（Agent 软删后仍有）')
  eq(view.agentType, 'TASK_AGENT', 'agentType 快照')
})

it('B2 分组契约不变：拼接各组 = 入参原序（一列都不动）', () => {
  const list = [
    conv({ id: 'fresh', topic: null, lastMessageAt: null, createdAt: '2026-10-12T14:30:00', agentId: 'a2' }),
    conv({ id: 'today', lastMessageAt: '2026-10-12T12:00:00', agentId: 'a3' }),
    conv({ id: 'earlier', lastMessageAt: '2026-10-10T11:02:00', agentId: 'a4' }),
  ]
  const groups = groupConversationViews(list, NOW, new Set(['today']))
  const flat = groups.flatMap((group) => group.items.map((item) => item.id))
  eq(flat.join('|'), list.map((item) => item.id).join('|'), '拼接顺序 = 入参顺序')
  eq(groups[0].label, '今天', '第一组是今天')
  eq(groups[1].label, '更早', '第二组是更早')
  eq(groups[0].items.find((item) => item.id === 'today').led, 'run', '生成中的那条亮 run 灯')
})

// ───────────────────────────── C Code 模式常量与体积口径 ─────────────────────────────

console.log(`\n${c.b}── C Code 模式列宽 / 体积口径（§七）──${c.x}`)

it('C1 面板默认 640 / 下限 560（编辑器有效宽度有下限）', () => {
  eq(WORKSPACE_PANEL_DEFAULT_W, 640, '默认宽度')
  eq(WORKSPACE_PANEL_MIN_W, 560, '下限')
  assert(WORKSPACE_PANEL_DEFAULT_W >= WORKSPACE_PANEL_MIN_W, '默认不得低于下限')
})

it('C2 夹取区间仍自洽（拖到极小 ⇒ 抬到下限）', () => {
  eq(clampWorkspacePanelWidth(10, 1600), WORKSPACE_PANEL_MIN_W, '低于下限 → 抬到下限')
  assert(clampWorkspacePanelWidth(2000, 1600) <= 900, '高过上限 → 压到上限')
})

it('C3 体积口径唯一：`formatBytes` 到 GB；全仓没有第二份 `formatSize`', () => {
  eq(formatBytes(512), '512 B', 'B')
  eq(formatBytes(2048), '2.0 KB', 'KB')
  eq(formatBytes(5 * 1024 * 1024), '5.0 MB', 'MB')
  eq(formatBytes(1536 * 1024 * 1024), '1.5 GB', 'GB（旧 formatSize 在这里会显示 1536.0 MB）')

  const artifactCard = read('../src/features/chat/ArtifactCard.tsx')
  notIncludes(artifactCard, 'function formatSize', 'ArtifactCard 不该再有第二份体积实现')
  includes(artifactCard, "from '../../app/format.js'", 'ArtifactCard 从公共 util 取 formatBytes')

  // 源码级守门：`function formatBytes` 在全仓**恰好一处**（其余是重导出）
  const workspaceModel = read('../src/features/chat/workspaceModel.ts')
  includes(workspaceModel, 'export { formatBytes }', 'workspaceModel 改为重导出')
  notIncludes(workspaceModel, 'function formatBytes', 'workspaceModel 不该再有实现')
})

// ───────────────────────────── D 导航权限（用量放开） ─────────────────────────────

console.log(`\n${c.b}── D 权限（用量统计登录即可）──${c.x}`)

it('D1 `UT` 不再 adminOnly：MEMBER 也能看到用量统计', () => {
  const ut = NAV_ITEMS.find((item) => item.code === 'UT')
  assert(ut !== undefined, '导航里应当有 UT')
  assert(ut.adminOnly !== true, 'UT 不该再是 ADMIN 专属')
  const memberPaths = visibleNavItems('MEMBER').map((item) => item.path)
  assert(memberPaths.includes(ut.path), 'MEMBER 可见 /admin/usage')
  assert(memberPaths.includes('/agents'), 'MEMBER 可见 /agents')
  const adminPaths = visibleNavItems('ADMIN').map((item) => item.path)
  assert(adminPaths.includes('/admin/users') && adminPaths.includes('/admin/models'), 'ADMIN 两条仍在')
  assert(!memberPaths.includes('/admin/users'), 'MEMBER 不该看到用户管理')
})

// ───────────────────────────── E 源码级守门（结构） ─────────────────────────────

console.log(`\n${c.b}── E 结构守门 ──${c.x}`)

it('E1 聊天主页外壳与跨智能体会话栏存在；旧单智能体侧栏已删除', () => {
  assert(existsSync(src('../src/pages/chat/ChatHomePage.tsx')), 'ChatHomePage.tsx 应当存在')
  assert(existsSync(src('../src/features/chat/ConvRail.tsx')), 'ConvRail.tsx 应当存在')
  assert(existsSync(src('../src/features/chat/AgentPicker.tsx')), 'AgentPicker.tsx 应当存在')
  assert(existsSync(src('../src/features/chat/ConversationSettings.tsx')), 'ConversationSettings.tsx 应当存在')
  assert(!existsSync(src('../src/features/chat/ConversationSidebar.tsx')), '旧 ConversationSidebar.tsx 应当已删除')
})

it('E2 单一外壳：`AppShell` 常驻 `ConvRail`；`ChatHomePage` 只渲染主区；会话栏不许自己排序', () => {
  const appShell = read('../src/app/AppShell.tsx')
  includes(appShell, 'ConvRail', '统一外壳要常驻渲染 ConvRail')
  includes(appShell, 'app-shell', '外壳根节点是 .app-shell')
  includes(appShell, 'isChatHomePath', '主区形态由聊天视图判据决定')
  const chatHome = read('../src/pages/chat/ChatHomePage.tsx')
  includes(chatHome, 'chat-home__main', '聊天视图只占主区')
  notIncludes(chatHome, "features/chat/ConvRail.js'", '会话栏已上移到 AppShell，ChatHomePage 不该再 import ConvRail')
  const convRail = read('../src/features/chat/ConvRail.tsx')
  notIncludes(convRail, '.sort(', '会话栏源码里不该出现 .sort(')
})

it('E2b 路由收敛到一个外壳：`App.tsx` 用 AppShell、不再有 AppLayout 双外壳', () => {
  const app = read('../src/app/App.tsx')
  includes(app, 'AppShell', '路由挂在 AppShell 下')
  notIncludes(app, 'AppLayout', '旧的 AppLayout 双外壳已删除')
  assert(!existsSync(src('../src/app/AppLayout.tsx')), 'AppLayout.tsx 应当已删除')
})

it('E3 ChatPage 头部 = 智能体 chip + 设置图标；会话控件走输入框下方（R4）', () => {
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  notIncludes(chatPage, 'ConversationSidebar', 'ChatPage 不该再引用旧侧栏')
  includes(chatPage, 'AgentPicker', '头部要有智能体 chip')
  includes(chatPage, 'ConversationSettings', '会话控件仍挂在 ChatPage 上（作为 ChatInput 的 controls）')
  includes(chatPage, 'chat__settings', '头部右侧是设置图标（进编辑智能体）')
  const settings = read('../src/features/chat/ConversationSettings.tsx')
  notIncludes(settings, '<Popover', 'R3/R4：会话控件不再用 popover')
  includes(settings, 'composer-control', 'R4：会话控件是图标按钮')
})

it('E4 面板宽度按会话写进 localStorage（刷新恢复）', () => {
  const hook = read('../src/features/chat/useWorkspacePanelResize.ts')
  includes(hook, 'localStorage', '宽度要持久化')
  includes(hook, 'doubulea.wsPanelW:', '键前缀')
})

it('E5 老深链 `/chat/:agentId/:conversationId?` 保留为重定向（不做 404）', () => {
  const app = read('../src/app/App.tsx')
  includes(app, '/chat/:agentId/:conversationId?', '旧路径仍注册')
  includes(app, 'LegacyChatRedirect', '旧路径走重定向')
})

// ───────────────────────────── F R3 修订（2026-10-13） ─────────────────────────────

console.log(`\n${c.b}── F R3 修订（会话栏开关 / 新会话记忆 / 只读保留 / 头部重设计）──${c.x}`)

it('F1 会话栏收起按钮移到主区左上角浮层；旧的会话栏内按钮与图标条态已删', () => {
  const appShell = read('../src/app/AppShell.tsx')
  includes(appShell, 'app-shell__toggle', '浮层开关')
  includes(appShell, 'app-shell--rail-hidden', '整体隐藏态')
  const convRail = read('../src/features/chat/ConvRail.tsx')
  notIncludes(convRail, 'convrail__collapse', '旧的会话栏内收起按钮已删')
})

it('F2 新会话可预置「不记入记忆」（与会话级自动审批同款 preset）', () => {
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  includes(chatPage, 'memoryExcludedPresetRef', '要有记忆预置 ref')
  includes(chatPage, 'setConversationMemoryExcluded(created.id, true)', '建会话、开流前落地')
  const controls = read('../src/features/chat/MemoryControls.tsx')
  notIncludes(controls, 'disabled={props.conversationId === undefined}', '新会话不再禁用记忆开关')
})

it('F3 只读保留会话（Agent 软删）可打开；不再误报「智能体取不到」', () => {
  const chatHome = read('../src/pages/chat/ChatHomePage.tsx')
  includes(chatHome, 'isConversationReadOnly', '只读判据来自 shared 的唯一函数')
  includes(chatHome, 'readOnly={readOnly}', '把只读态传给 ChatPage')
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  includes(chatPage, 'agentQuery.isError && !readOnly', '只读保留时不走「打不开」分支')
  includes(chatPage, 'chat__readonly', '输入区换成只读说明')
})

it('F4（R4）会话控件移到输入框下方、用图标按钮；标题栏设置图标进编辑智能体', () => {
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  includes(chatPage, 'controls={', '会话控件经 `ChatInput` 的 `controls` 槽放到输入框下方')
  includes(chatPage, 'chat__settings', '标题栏右侧是设置图标（直接进编辑智能体）')
  const chatInput = read('../src/features/chat/ChatInput.tsx')
  includes(chatInput, 'composer__controls', 'ChatInput 要有输入框下方控件槽')
  const settings = read('../src/features/chat/ConversationSettings.tsx')
  for (const icon of ['SafetyCertificateOutlined', 'BulbOutlined', 'CodeOutlined']) {
    includes(settings, icon, `控件图标 ${icon}`)
  }
  includes(settings, 'is-pop', '点击要有弹动动效')
})

it('F5（R5）模型是**文字选择器**（不再只给图标）；窄屏产物入口已删除', () => {
  const settings = read('../src/features/chat/ConversationSettings.tsx')
  // R5：用户要一眼看到当前模型 ⇒ 模型走文字 `Select` / 只读文字 chip，**不再是** Thunderbolt 图标
  includes(settings, 'composer-model', '模型是文字选择器 / 只读 chip')
  includes(settings, 'Select', '模型池 ≥2 用下拉')
  notIncludes(settings, 'ThunderboltOutlined', '模型不再只给一枚图标')
  // R7：产物面板窄屏也常驻 ⇒ 不再有「打开产物面板」抽屉入口
  notIncludes(settings, 'composer-control--narrow', '不再有窄屏抽屉入口类')
  notIncludes(settings, 'onOpenPanel', '不再有窄屏抽屉入口回调')
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  notIncludes(chatPage, 'artifactDrawerOpen', 'ChatPage 不再持有产物抽屉开关')
  notIncludes(chatPage, 'title="产物"', 'ChatPage 不再渲染产物抽屉')
})

it('F6（R6）窄屏第三列常驻并排；行末的会话栏浮层按钮与 chip 对齐', () => {
  const css = read('../src/styles/app.css')
  // R6/R7：窄屏（≤1280）第三列（Code 工作区 / 非 Code 产物面板）一律并排常驻，不再藏
  includes(css, '.chat--with-panel { grid-template-columns: minmax(0, 1fr) minmax(0, 44%); }', '窄屏第三列并排')
  includes(css, '.chat--with-panel .panel { display: flex; }', '窄屏第三列常驻')
  // 浮层开关 32×32、top 12px（与 32px 高的智能体 chip 垂直居中对齐）
  const toggleBlock = css.slice(css.indexOf('.app-shell__toggle {'))
  includes(toggleBlock.slice(0, 400), 'width: 32px;', '浮层开关宽 32（与 chip 同高）')
  includes(toggleBlock.slice(0, 400), 'top: var(--sp-3);', '浮层开关纵向对齐 chip')
})

it('F7（R7）非 Code 的产物面板窄屏也常驻并排；抽屉入口删除', () => {
  const css = read('../src/styles/app.css')
  // 非 Code（`.chat--with-panel` 无 `.chat--code`）与 Code 共用同一条窄屏并排规则
  const media = css.slice(css.indexOf('@media (max-width: 1280px) {', css.indexOf('.ws__status--conflict')))
  const block = media.slice(0, media.indexOf('/* ── 会话侧栏'))
  includes(block, '.chat--with-panel { grid-template-columns: minmax(0, 1fr) minmax(0, 44%); }', '产物面板窄屏并排')
  includes(block, '.chat--with-panel .panel { display: flex; }', '产物面板窄屏常驻')
  // 专注对话仍显式收起（特异度压过并排规则）
  includes(block, '.chat--with-panel.chat--focus-chat .panel { display: none; }', '专注对话收起第三列')
  // 旧的窄屏抽屉入口样式已删
  notIncludes(css, '.composer-control--narrow', '窄屏抽屉入口样式已删')
})

it('F8 新会话态开 Code 模式：第三列 = 空工作区占位（不回落到产物面板）', () => {
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  // 新会话态（conversationId 尚未生成）第三列必须是工作区占位，而不是 ArtifactPanel
  includes(chatPage, 'WorkspacePanelPlaceholder', 'ChatPage 引用空工作区占位组件')
  includes(chatPage, '<WorkspacePanelPlaceholder', '新会话态渲染空工作区占位')
  // 占位与真面板同壳：`.ws` + 标题「工作区」+ 空态说明
  const panel = read('../src/features/chat/WorkspacePanel.tsx')
  includes(panel, 'export function WorkspacePanelPlaceholder', '导出 WorkspacePanelPlaceholder')
  includes(panel, 'workspace-panel-placeholder', '占位有稳定 testid')
  includes(panel, '发送第一条消息后创建工作区', '空态说明指向"建会话后才创建工作区"')
})

it('F9 非 Code 的产物面板可收起 / 展开（第三列开关）', () => {
  const chatPage = read('../src/pages/chat/ChatPage.tsx')
  // 收起时摘掉 `chat--with-panel`（消息流占满整宽）；第三列渲染由 panelVisible 决定
  includes(chatPage, 'panelOpen', 'ChatPage 持有产物面板展开态')
  includes(
    chatPage,
    'const panelVisible = showPanel && (codeMode || panelOpen)',
    '第三列可见性 = showPanel ∩ (codeMode ∪ panelOpen)',
  )
  includes(chatPage, "panelVisible ? ' chat--with-panel'", '收起时摘掉 chat--with-panel')
  includes(chatPage, 'onTogglePanel={setPanelOpen}', '把开关接到会话控件')
  const settings = read('../src/features/chat/ConversationSettings.tsx')
  includes(settings, 'onTogglePanel', '会话控件暴露收起 / 展开回调')
  includes(settings, 'FolderOpenOutlined', '收起 / 展开用图标按钮')
})

// ───────────────────────────── G 侧边栏两层（2026-10-13） ─────────────────────────────

console.log(`\n${c.b}── G 侧边栏两层（平台功能 35% / 会话 65%）──${c.x}`)

it('G1 ConvRail 分两层：上层平台功能、下层会话；旧的「管理」popover 已删', () => {
  const convRail = read('../src/features/chat/ConvRail.tsx')
  includes(convRail, 'convrail__nav', '上层平台功能')
  includes(convRail, 'convrail__convos', '下层会话')
  notIncludes(convRail, 'Popover', '不再用底部「管理」popover')
  notIncludes(convRail, 'rail-menu', '旧的 rail-menu 已删')
})

it('G2 上层六个直达入口 + 「管理」就地展开剩余；入口顺序 = 产品口径', () => {
  const convRail = read('../src/features/chat/ConvRail.tsx')
  includes(convRail, "['AG', 'KB', 'MC', 'TK', 'CR', 'AH']", '顺序：智能体/知识库/MCP/任务/我的凭据/会话产物')
  includes(convRail, 'manageExpanded', '「管理」就地展开')
  includes(convRail, 'manageItems', '剩余入口（用量统计 / 用户管理 / 模型池）')
})

it('G3 会话分组（今天 / 更早）标题可点击收缩', () => {
  const convRail = read('../src/features/chat/ConvRail.tsx')
  includes(convRail, 'collapsedGroups', '分组收缩态')
  includes(convRail, 'convrail__group-caret', '分组标题有收缩箭头')
  includes(convRail, 'toggleGroup', '点标题切换收缩')
})

it('G4 两层高度比 35 / 65（flex-grow）', () => {
  const css = read('../src/styles/app.css')
  includes(css, 'flex: 35 35 0;', '平台功能约 35%')
  includes(css, 'flex: 65 65 0;', '会话约 65%')
})

// ───────────────────────────── 结论 ─────────────────────────────

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 聊天主页前端验收通过（P1-15）：${passed} 项全通过${c.x}`)
  console.log(`${c.d}   ⚠️ 浏览器可见路径（进站即聊天主页 / 平台功能高亮 + 管理展开 / 会话分组收缩 / 会话栏浮层开关 / 只读保留会话 / 输入框下图标控件 + 点击动效 / 专注工作区不挤）由用户人工端测${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 聊天主页前端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}