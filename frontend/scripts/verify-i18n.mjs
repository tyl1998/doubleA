#!/usr/bin/env node
/**
 * verify-i18n.mjs —— 界面语言切换（zh / en）**无依赖**验收（P1-23）
 *
 * 跑法：`pnpm verify:i18n`
 *      （= `node --import tsx frontend/scripts/verify-i18n.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本档盯的是"错了不会报错"的那几类（本仓一贯的取档口径）
 * ─────────────────────────────────────────────────────────────────────
 *   · **漏译 / 多译**：`en` 少一条 ⇒ 编译期会拦（`tsc`），但**运行期也要能自查** ——
 *     本档逐 key 比对两份字典（不依赖 `tsc`，手工删了 `.ts` 里的约束也能抓）；
 *   · **空译文**：`''` 能过类型检查、界面上一片空白，只在真跑时才看出来；
 *   · **未译**：`en` 里留着中文（复制 zh 忘了改）—— 类型系统完全不管；
 *   · **占位符不齐**：`zh` 有 `{title}`、`en` 写成 `{name}` ⇒ 类型不报错、插值后
 *     显示成"Rename conversation 「{name}」"（**替换失败但看着像正常文案**）；
 *   · **插值静默吞**：缺参数时返回空串 ⇒ 界面上少一段字，比原样留 `{title}` 难查得多；
 *   · **作业面漏抽**：本批该覆盖的外壳层文件里还留着裸中文（**这是本批唯一的交付判据**）。
 *
 * ⚠️ 本档**验不了**的（别当全批验收）：
 *   · React 渲染与交互（切了语言界面真的变了吗、AntD 组件/日期变没变）⇒ 归浏览器端测（留给用户）；
 *   · `en` 译文**质量**（语感、术语一致性）⇒ 归人工评审 —— 本档只保证"不是中文、占位符对齐"。
 *
 * 断言脚手架与 `verify-admin-ui.mjs` / `verify-chat-home.mjs` 同款，**刻意各留一份**
 * （验收脚本要能被单独拷出来跑）。
 */

import { readdirSync, readFileSync } from 'node:fs'

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

/** 去掉 `/* *\/` 与 `//` 注释（源码级守门用；本仓注释里中文极多，不去掉会满屏假阳性） */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '')
}

/** 该串里有没有 CJK 汉字（判断"en 译文里还留着中文"） */
const CJK = /[\u4e00-\u9fff]/

// ───────────────────────────── 被测对象 ─────────────────────────────

const { zh, en, translate, LOCALES, DEFAULT_LOCALE, resolveLocale, isLocale } = await import('@doubulea/shared')

const ZH_KEYS = Object.keys(zh)
const EN_KEYS = Object.keys(en)

// ───────────────────────────── A 两份字典的形状 ─────────────────────────────

groupStart('A', '两份字典的形状（漏译 / 多译 / 空串）', 'en 再多一个 zh 没有的 key 也是错的（拼错的 key 会永远用不上）')

await it('A1 语言集合只有 zh / en，默认是 zh', () => {
  assertEqual(LOCALES.join(','), 'zh,en', 'LOCALES')
  assertEqual(DEFAULT_LOCALE, 'zh', '默认语言')
})

await it('A2 en 与 zh 的 key 完全一致（既不漏也不多）', () => {
  const missing = ZH_KEYS.filter((key) => !EN_KEYS.includes(key))
  const extra = EN_KEYS.filter((key) => !ZH_KEYS.includes(key))
  assert(missing.length === 0, `en 漏译 ${missing.length} 条：${missing.slice(0, 5).join(', ')}`)
  assert(extra.length === 0, `en 多出 ${extra.length} 条（key 拼错？）：${extra.slice(0, 5).join(', ')}`)
})

await it('A3 两份字典都没有空译文', () => {
  for (const key of ZH_KEYS) {
    assert(typeof zh[key] === 'string' && zh[key].trim() !== '', `zh["${key}"] 是空串`)
  }
  for (const key of EN_KEYS) {
    assert(typeof en[key] === 'string' && en[key].trim() !== '', `en["${key}"] 是空串`)
  }
})

await it('A4 en 译文里不留中文（专有名词除外：MCP / Provider / Key 本就是英文词）', () => {
  // 本档的判据是"没忘记翻译"，不是"译文质量" ⇒ 只看有没有汉字。
  // 若确有必须留中文的条目（如品牌词），在这里加白名单，**不要**放宽成"允许中文"。
  const ALLOW_CJK = new Set([])
  const offenders = EN_KEYS.filter((key) => CJK.test(en[key]) && !ALLOW_CJK.has(key))
  assert(offenders.length === 0, `en 里还有中文的条目：${offenders.slice(0, 5).join(', ')}`)
})

// ───────────────────────────── B translate 纯函数 ─────────────────────────────

groupStart('B', 'translate() 的纯函数行为', '插值 / 缺参数原样保留 / 未知 key 回退 —— 这三条错了都不会抛异常')

await it('B1 取得到两份字典的各自译文（zh 与 en 不同）', () => {
  assertEqual(translate('zh', 'nav.agents'), zh['nav.agents'], 'zh 走 zh 字典')
  assertEqual(translate('en', 'nav.agents'), en['nav.agents'], 'en 走 en 字典')
  assert(zh['nav.agents'] !== en['nav.agents'], '这一条 zh/en 应当不同（否则本档失去意义）')
})

await it('B2 插值：`{name}` 被替换成实参', () => {
  assertEqual(translate('zh', 'rail.renameAria', { title: 'X' }), '重命名会话「X」', 'zh 插值')
  assertEqual(translate('en', 'rail.renameAria', { title: 'X' }), 'Rename conversation “X”', 'en 插值')
})

await it('B3 缺参数：**原样保留**占位符（不抛错、不静默吞成空）', () => {
  const out = translate('zh', 'rail.renameAria')
  assertIncludes(out, '{title}', '缺 title 时占位符要留着（看得见"这里少喂了一个参数"）')
})

await it('B4 未提供的键不影响已提供的键（一次多参各替换各的）', () => {
  const out = translate('zh', 'rail.renameAria', { other: 'x' })
  assertIncludes(out, '{title}', '不该被 other 顺手清掉')
})

await it('B5 未知 key 回退成 key 本身（比空串更容易被发现）', () => {
  const out = translate('zh', 'no.such.key')
  assertEqual(out, 'no.such.key', '未知 key 原样返回')
})

await it('B6 插值值会被 String() 化（数字参数可用）', () => {
  // `rail.renameOk` 带 `{topic}`；用一个数字当参数，验证不会因为"不是字符串"而炸
  const out = translate('en', 'rail.renameOk', { topic: 42 })
  assertIncludes(out, '42', '数字参数应被字符串化')
})

// ───────────────────────────── C 占位符对齐 ─────────────────────────────

groupStart('C', '占位符两语言对齐', 'zh 用 {title}、en 写成 {name} 时类型不报错，但插值会静默失败')

function placeholdersOf(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

await it('C1 每条 key 的占位符集合 zh / en 一致', () => {
  const bad = []
  for (const key of ZH_KEYS) {
    const zhPh = placeholdersOf(zh[key]).join(',')
    const enPh = placeholdersOf(en[key]).join(',')
    if (zhPh !== enPh) bad.push(`${key}（zh:[${zhPh}] en:[${enPh}]）`)
  }
  assert(bad.length === 0, `占位符不齐：${bad.slice(0, 5).join('; ')}`)
})

// ───────────────────────────── D 错误码目录 ─────────────────────────────

groupStart('D', '错误码兜底目录', 'en 界面下后端 AppError 细节文案不回显 ⇒ 靠这里的 error.<CODE> 兜底')

await it('D1 `error.<CODE>` 对 `shared#ERROR_CODES` 一个不漏', async () => {
  const { ERROR_CODES } = await import('@doubulea/shared')
  const missing = ERROR_CODES.filter((code) => !ZH_KEYS.includes(`error.${code}`))
  assert(missing.length === 0, `缺错误码兜底：${missing.join(', ')}`)
})

await it('D2 每个 `error.<CODE>` 的 en 译文非空且不含中文', async () => {
  const { ERROR_CODES } = await import('@doubulea/shared')
  for (const code of ERROR_CODES) {
    const key = `error.${code}`
    assert(en[key].trim() !== '', `en["${key}"] 空`)
    assert(!CJK.test(en[key]), `en["${key}"] 还有中文`)
  }
})

// ───────────────────────────── E locale 状态（前端 store）─────────────────────────────

groupStart('E', 'locale store 与 AntD/dayjs 映射', 'locale 是纯客户端偏好：不进服务端、不进任何接口')

// locale store 的 `setLocale` 会写 `<html lang>`（那是它的职责，见 `03` §九）——
// Node 里没有 `document` ⇒ 本档在**测试侧**补一个最小 stub，而不是给生产代码加 `typeof` 分支
// （生产只在浏览器跑；为"能被 Node 导入"改写产品逻辑是本末倒置）。
globalThis.document = { documentElement: { lang: '' }, ...(globalThis.document ?? {}) }

const { useLocaleStore, currentLocale } = await import('../src/stores/locale.ts')
const { ANTD_LOCALE_PACKAGE, DAYJS_LOCALE_NAME, HTML_LANG, LOCALE_STORAGE_KEY, otherLocale, localeToggleLabel } =
  await import('../src/app/locale.ts')

await it('E1 默认语言是 zh；toggle 在 zh/en 之间来回', () => {
  // 测试环境没有 localStorage ⇒ store 落在默认值
  assertEqual(currentLocale(), 'zh', '默认语言')
  useLocaleStore.getState().toggleLocale()
  assertEqual(currentLocale(), 'en', 'toggle 到 en')
  useLocaleStore.getState().toggleLocale()
  assertEqual(currentLocale(), 'zh', 'toggle 回 zh')
})

await it('E2 setLocale 落进 store（组件与非组件两条读法一致）', () => {
  useLocaleStore.getState().setLocale('en')
  assertEqual(useLocaleStore.getState().locale, 'en', 'store 值')
  assertEqual(currentLocale(), 'en', '非组件读法（feedback 用）')
  useLocaleStore.getState().setLocale('zh')
})

await it('E3 存储键与 `doubulea.` 前缀一致（与配色同一套命名）', () => {
  assertEqual(LOCALE_STORAGE_KEY, 'doubulea.locale', '存储键')
})

await it('E4 AntD locale / dayjs locale / html lang 三张映射两种语言齐全', () => {
  assertEqual(ANTD_LOCALE_PACKAGE.zh, 'zh_CN', 'AntD zh')
  assertEqual(ANTD_LOCALE_PACKAGE.en, 'en_US', 'AntD en')
  assertEqual(DAYJS_LOCALE_NAME.zh, 'zh-cn', 'dayjs zh（dayjs 的命名是 zh-cn）')
  assertEqual(DAYJS_LOCALE_NAME.en, 'en', 'dayjs en')
  assertEqual(HTML_LANG.zh, 'zh-CN', 'html lang zh（带地区）')
  assertEqual(HTML_LANG.en, 'en', 'html lang en')
})

await it('E5 另一种语言与切换器文案互为反向（中文时显示 EN、英文时显示 中）', () => {
  assertEqual(otherLocale('zh'), 'en', 'otherLocale')
  assertEqual(localeToggleLabel('zh'), 'EN', '中文时按钮写 EN')
  assertEqual(localeToggleLabel('en'), '中', '英文时按钮写 中')
})

await it('E6 `resolveLocale` 对非法值回落默认（不抛错 —— 界面语言不该让页面挂掉）', () => {
  assertEqual(resolveLocale('fr'), 'zh', '不认识的语言')
  assertEqual(resolveLocale(null), 'zh', 'null')
  assertEqual(resolveLocale(undefined), 'zh', 'undefined')
  assertEqual(resolveLocale('en'), 'en', '合法值原样')
  assert(isLocale('en') && !isLocale('EN'), '识别大小写敏感')
})

// ───────────────────────────── F 源码级守门（作业面）─────────────────────────────

groupStart(
  'F',
  '本批作业面：外壳层不再有裸中文',
  '这是本批唯一的交付判据 —— 该覆盖的文件里，注释之外的文案必须全部走 useT()',
)

/**
 * P1-23 已声明覆盖的文件（**后续分批要把新覆盖的模块加进来**；这是本能力的交付账本）。
 *
 * 第一批（公共外壳层）+ 第二批（个人设置族 `pages/settings/*`）。
 */
const COVERED = [
  // ── 第一批：公共外壳层 ──
  'src/app/AppShell.tsx',
  'src/app/nav.ts',
  'src/app/UserMenu.tsx',
  'src/app/feedback.ts',
  'src/app/feedbackModel.ts',
  'src/features/chat/ConvRail.tsx',
  'src/pages/NoticePage.tsx',
  // ── 第二批：个人设置族 ──
  'src/pages/settings/PasswordPage.tsx',
  'src/pages/settings/GitIdentitySection.tsx',
  'src/pages/settings/GitCredentialsSection.tsx',
  'src/pages/settings/ProviderKeySection.tsx',
  'src/pages/settings/gitCredentialModel.ts',
  // ── 第三批：登录 / 首登改密（含共用的 ChangePasswordForm）──
  'src/pages/login/LoginPage.tsx',
  'src/pages/login/LoginForm.tsx',
  'src/pages/login/ChangePasswordForm.tsx',
  // 随第三批抽文案的相邻承载件（服务灯 + health 依赖名映射）
  'src/app/ServiceLed.tsx',
  'src/api/health.ts',
  // ── 第四批：会话产物页 ──
  'src/pages/artifacts/ArtifactCollectionPage.tsx',
  // ── 第五批：任务中心（定时任务 + 活动 + 记忆）──
  'src/pages/tasks/TasksPage.tsx',
  'src/pages/tasks/TaskFormModal.tsx',
  'src/pages/tasks/ActivityPanel.tsx',
  'src/pages/tasks/MemoryPanel.tsx',
  'src/pages/tasks/taskModel.ts',
  'src/pages/tasks/memoryModel.ts',
  // 消费 memoryModel 的相邻件（对话页记忆提示栈）
  'src/features/chat/MemoryControls.tsx',
  // ── 第六批 6a：产物 / 会话列表读数簇 ──
  'src/features/chat/conversationList.ts',
  'src/features/chat/artifactPanelModel.ts',
  'src/features/chat/ArtifactPanel.tsx',
  'src/features/chat/ArtifactCard.tsx',
  // ── 第六批 6b：Code 工作区簇 ──
  'src/features/chat/workspaceModel.ts',
  'src/features/chat/WorkspacePanel.tsx',
  'src/features/chat/RuntimeSelect.tsx',
  // ── 第六批 6c：对话页 / 消息流（pages/chat + features/chat 余下）──
  'src/pages/chat/ChatPage.tsx',
  'src/pages/chat/ChatHomePage.tsx',
  'src/features/chat/ChatInput.tsx',
  'src/features/chat/ConversationSettings.tsx',
  'src/features/chat/AssistantMessage.tsx',
  'src/features/chat/ToolCard.tsx',
  'src/features/chat/MessageList.tsx',
  'src/features/chat/ConfirmCard.tsx',
  'src/features/chat/CitationCard.tsx',
  'src/features/chat/ThinkingBlock.tsx',
  'src/features/chat/ErrorCard.tsx',
  'src/features/chat/AgentPicker.tsx',
  'src/features/chat/DisconnectBanner.tsx',
  'src/features/chat/DeleteConversationModal.tsx',
  'src/features/chat/RecallConversationModal.tsx',
  'src/features/chat/MissingModelKeyModal.tsx',
  'src/features/chat/composerState.ts',
  'src/features/chat/streamErrors.ts',
  'src/features/chat/confirmModel.ts',
  'src/features/chat/alignHistory.ts',
  'src/features/chat/useChatStream.ts',
  'src/features/chat/useConversationWatch.ts',
  'src/features/chat/roundReducer.ts',
  // ⚠️ `chatStream.ts` / `sseParser.ts` **刻意不入账**：它们的汉字只出现在**诊断面**
  // （`SseStreamIssue.detail` → `console.warn`，`§3.5` 的"日志不译"），不是界面文案；
  // 编进 `MessageKey` 会把"给人看的界面文案"与"给排查看的线索"混成一层。
  'src/stores/chatStream.ts',
  // ── 第七批：知识库（pages/knowledge/*）+ 其消费的 VisibilityBadge ──
  'src/pages/knowledge/KnowledgeListPage.tsx',
  'src/pages/knowledge/KnowledgeDetailPage.tsx',
  'src/pages/knowledge/KnowledgeBaseFormModal.tsx',
  'src/pages/knowledge/KnowledgeConfigModal.tsx',
  'src/pages/knowledge/UploadDocumentModal.tsx',
  'src/pages/knowledge/DeleteKnowledgeBaseModal.tsx',
  'src/pages/knowledge/DocumentTable.tsx',
  'src/pages/knowledge/SearchTestDrawer.tsx',
  'src/pages/knowledge/ChunkPreviewDrawer.tsx',
  'src/pages/knowledge/knowledgeModel.ts',
  // ⚠️ `VisibilityBadge.tsx` 随本批迁（它是 `ASSET_VISIBILITY_KEY` 的消费方，与知识库表单同批）
  'src/components/VisibilityBadge.tsx',
  // ── 第八批：MCP（pages/mcp/*）──
  'src/pages/mcp/McpServersPage.tsx',
  'src/pages/mcp/McpCredentialsPage.tsx',
  'src/pages/mcp/McpServerFormModal.tsx',
  'src/pages/mcp/McpServerToolsModal.tsx',
  'src/pages/mcp/mcpModel.ts',
  // ── 第九批：智能体（pages/agents/*）──
  'src/pages/agents/AgentsListPage.tsx',
  'src/pages/agents/AgentFormPage.tsx',
  'src/pages/agents/DeleteAgentModal.tsx',
  'src/pages/agents/OpenApiKeysSection.tsx',
  'src/pages/agents/agentModel.ts',
  // ── 第十批：管理（pages/admin/*）──
  'src/pages/admin/UsersListPage.tsx',
  'src/pages/admin/UserFormModal.tsx',
  'src/pages/admin/UserGroupsPanel.tsx',
  'src/pages/admin/InitialPasswordModal.tsx',
  'src/pages/admin/ModelsPage.tsx',
  'src/pages/admin/ModelFormModal.tsx',
  'src/pages/admin/ProviderFormModal.tsx',
  'src/pages/admin/DeleteProviderModal.tsx',
  'src/pages/admin/RemoteModelsDrawer.tsx',
  'src/pages/admin/SystemModelSection.tsx',
  'src/pages/admin/EgressPolicyPage.tsx',
  'src/pages/admin/SandboxInstancesPage.tsx',
  'src/pages/admin/NodeBootstrapProgress.tsx',
  'src/pages/admin/UsagePage.tsx',
  'src/pages/admin/adminModel.ts',
  'src/pages/admin/nodeBootstrapModel.ts',
  'src/pages/admin/sandboxInstanceModel.ts',
  'src/pages/admin/usageModel.ts',
  // ── 末批：`shared` 收口的消费方（`components/*` 余下 + 共享标签表消费者）──
  'src/components/TransferOwnershipModal.tsx',
  'src/components/AssetUserPicker.tsx',
  'src/components/AudiencePicker.tsx',
  'src/components/ListStates.tsx',
  // ── 收尾 ③a：产物预览器（`components/ArtifactPreview/*` 的 6 个有界面文案的文件）──
  'src/components/ArtifactPreview/artifactPreview.ts',
  'src/components/ArtifactPreview/ArtifactPreviewDrawer.tsx',
  'src/components/ArtifactPreview/CsvPreview.tsx',
  'src/components/ArtifactPreview/ImagePreview.tsx',
  'src/components/ArtifactPreview/MarkdownPreview.tsx',
  'src/components/ArtifactPreview/useArtifactDownload.ts',
  // ── 收尾 ③b：外壳兜底屏（首帧等待 / 读登录态失败）──
  'src/app/BootScreen.tsx',
  'src/app/SessionErrorScreen.tsx',
  // ── 收尾 ④：网络层自造句 + 事件流诊断 + 语言切换器读数（2026-10-27）──
  'src/api/client.ts',
  'src/api/workspace.ts',
  'src/features/chat/chatStream.ts',
  'src/features/chat/sseParser.ts',
  'src/app/locale.ts',
]

for (const file of COVERED) {
  await it(`F · ${file} 注释外无裸中文`, () => {
    const source = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    const lines = source.split('\n').filter((line) => CJK.test(line) && !isAllowedChineseLine(file, line))
    assert(lines.length === 0, `还有 ${lines.length} 行裸中文：\n${lines.slice(0, 3).map((l) => `           ${l.trim()}`).join('\n')}`)
  })
}

/**
 * 本批**显式**允许留中文的行（每一条都要有理由；不设"整文件放行"这种口子）。
 *
 * 允许的只有一类：**屏号 / 仪器读数**（`S-08 · 改密` 这种）—— 它**刻意不翻译**
 * （`03` §九 的例外条），因为它是"这台机器现在跑到第几屏"的读数，不是给用户读的产品文案。
 * 两个形态：`nav.ts` 的 `serial: 'S-…'` 字段、页面里的 `<p className="kicker">S-…</p>`。
 *
 * 判据 = "把 `S-…` 读数整体摘掉后，这行还有没有中文" —— 于是**读数以外的中文一律红**，
 * 且读数本身撑不出一个"整文件放行"的口子（写别的中文仍会被抓）。
 */
function isAllowedChineseLine(file, line) {
  // 第二类（**只有这一行**）：语言切换器按钮上的「中」——
  // 它的语义是"用**目标**语言的自称"（`子方案` §3.5 的例外条），按当前语言取译文反而错。
  // 判据是**整行字面量匹配**，不是"这个文件放行"：`locale.ts` 里写别的中文仍会被抓。
  if (file === 'src/app/locale.ts' && line.trim() === "return locale === 'zh' ? 'EN' : '中'") return true
  return !CJK.test(line.replaceAll(/'S-[^']*'/g, "'S-'").replaceAll(/>\s*S-[^<]*</g, '><'))
}

await it('F7 外壳层文件都确实接上了 i18n（不是靠"文件里本来就没中文"蒙混）', () => {
  for (const file of COVERED) {
    const source = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    const wired = source.includes('useT(') || source.includes('translate(') || source.includes("from '@doubulea/shared'")
    assert(wired, `${file} 里没看到 useT/translate 的接线`)
  }
})

await it('F8 导航项文案存的是 key（`labelKey`），不是中文', async () => {
  const { NAV_ITEMS } = await import('../src/app/nav.ts')
  for (const item of NAV_ITEMS) {
    assert(typeof item.labelKey === 'string' && item.labelKey !== '', `${item.code} 缺 labelKey`)
    assert(!CJK.test(item.labelKey), `${item.code} 的 labelKey 里不该有中文（存 key 不存文案）`)
    assert(
      Object.prototype.hasOwnProperty.call(zh, item.labelKey),
      `${item.code} 的 labelKey "${item.labelKey}" 在字典里不存在`,
    )
  }
})

await it('F9 面包屑静态前缀也走 key（`crumbBaseForPath` 返回值里没有 label 字符串）', async () => {
  const { crumbBaseForPath } = await import('../src/app/nav.ts')
  const trail = crumbBaseForPath('/admin/users')
  assert(trail.length >= 1, '面包屑至少有「工作台」一段')
  for (const segment of trail) {
    assertEqual(typeof segment.labelKey, 'string', '每段带 labelKey')
    assert(!CJK.test(segment.labelKey), `段的 labelKey 不该是中文：${segment.labelKey}`)
    assert(segment.label === undefined, '不该再返回中文 label 字段')
  }
})

await it('F9b nav.ts 里的中文**只出现在 `S-…` 仪器读数里**（摘掉读数后一处不剩）', () => {
  const navSource = stripComments(readFileSync(new URL('../src/app/nav.ts', import.meta.url), 'utf8'))
  const leftover = navSource
    .split('\n')
    .filter((line) => CJK.test(line.replaceAll(/'S-[^']*'/g, "'S-'")))
  assert(leftover.length === 0, `读数之外还有中文：\n${leftover.slice(0, 3).map((l) => `           ${l.trim()}`).join('\n')}`)
  // 反向：读数本身确实还在（别把读数也一起"修"没了）
  assertIncludes(navSource, "'S-02 · 智能体'", 'serial 读数应保持原样（刻意不翻译）')
})

await it('F10 界面语言切换入口收在头像菜单（两处都切换的能力由菜单一项承担）', () => {
  // 2026-10-26：会话栏底部那两枚偏好按钮（配色 + 语言）已收进头像菜单 ⇒ 语言与配色的
  // 切换入口**只有菜单一处**；仍要有"能切语言"与"能切配色"两项（同一份 store）。
  const menu = stripComments(readFileSync(new URL('../src/app/UserMenu.tsx', import.meta.url), 'utf8'))
  assertIncludes(menu, 'toggleLocale', '头像菜单里要有语言切换')
  assertIncludes(menu, 'toggleThemeMode', '头像菜单里要有配色切换')
  assertIncludes(menu, "'language'", '菜单项 key 是 language')
  assertIncludes(menu, "'theme'", '菜单项 key 是 theme')
})

await it('F11 不允许任何地方再写死 AntD locale（映射只许一处）', async () => {
  const { readdirSync } = await import('node:fs')
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) {
        const source = stripComments(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
        // 只有 `app/antdLocale.ts` 允许 import antd 的语言包
        if (source.includes("antd/locale/") && path !== 'src/app/antdLocale.ts') offenders.push(path)
      }
    }
  }
  walk('src')
  assert(offenders.length === 0, `AntD 语言包只许在 app/antdLocale.ts 里引：${offenders.join(', ')}`)
})

await it('F12 构建进度按 `phase` + `detail` 由前端拼文案（`RuntimeSelect` 里不再读废弃的 `phaseLabel`）', () => {
  // 收尾 ①：`phaseLabel` 在 shared 里降级为 `@deprecated` 且后端不再更新；
  // 前端若还读它，en 界面会退回中文（且没人报错）—— 故在账本文件上做源码级断言。
  const select = stripComments(readFileSync(new URL('../src/features/chat/RuntimeSelect.tsx', import.meta.url), 'utf8'))
  assert(!select.includes('phaseLabel'), 'RuntimeSelect.tsx 里不该再出现 phaseLabel')
  assertIncludes(select, 'SANDBOX_BUILD_PHASE_KEY[job.phase]', '阶段名走 `*_KEY` 表')
  assertIncludes(select, 'runtime.buildPhaseWithDetail', '有 detail 时走「阶段（细节）」模板')
})

// ───────────────────────────── G 共享标签表与字典不漂移 ─────────────────────────────

groupStart(
  'G',
  'shared 标签表与字典不漂移',
  '口径（子方案 §3.5）：中文表保留给后端，前端按 <表名>_KEY 取译文 ⇒ 两边必须逐字一致',
)

/**
 * 每张已迁的标签表：`*_LABELS`（中文真相，后端/日志仍在消费）↔ `*_KEY`（前端取译文的 key 表）。
 *
 * 守的是"只改了一边"这类**静默漂移**：改了 `*_LABELS` 的中文却没改字典 ⇒ zh 界面换了个说法、
 * 后端日志还是旧的；反过来改了字典忘了表 ⇒ 同上。两边一致才算收口。
 * 写法参照 `verify-knowledge-ui` 的 B2（"字典译文 === shared 常量"），只是这里整表批量比。
 */
await it('G1 已迁标签表：每个值的 zh 译文都等于 `*_LABELS` 里的中文', async () => {
  const shared = await import('@doubulea/shared')
  /** [中文表, key 表] —— 新增一张表时在这里登记一行，否则它会漂移而没人知道 */
  const PAIRS = [
    ['MODEL_TYPE_LABELS', 'MODEL_TYPE_KEY'],
    ['UPSTREAM_PROTOCOL_LABELS', 'UPSTREAM_PROTOCOL_KEY'],
    ['UPSTREAM_PROTOCOL_BASE_URL_HINTS', 'UPSTREAM_PROTOCOL_BASE_URL_HINT_KEY'],
    ['PROVIDER_CREDENTIAL_MODE_LABELS', 'PROVIDER_CREDENTIAL_MODE_KEY'],
    ['EGRESS_SCOPE_LABELS', 'EGRESS_SCOPE_KEY'],
    ['USAGE_GROUP_LABELS', 'USAGE_GROUP_KEY'],
    ['USAGE_GROUP_KEY_LABELS', 'USAGE_GROUP_HEADER_KEY'],
    ['ASSET_VISIBILITY_LABELS', 'ASSET_VISIBILITY_KEY'],
    ['IMAGE_RECOGNITION_LABELS', 'IMAGE_RECOGNITION_KEY'],
    ['WORKSPACE_ACTOR_LABELS', 'WORKSPACE_ACTOR_KEY'],
    ['OPEN_API_SCOPE_LABELS', 'OPEN_API_SCOPE_KEY'],
    ['SANDBOX_BUILD_PHASE_LABELS', 'SANDBOX_BUILD_PHASE_KEY'],
  ]
  const bad = []
  for (const [labelsName, keyName] of PAIRS) {
    const labels = shared[labelsName]
    const keys = shared[keyName]
    assert(labels !== undefined, `${labelsName} 不存在（表被删了？那就把这一行从 PAIRS 里摘掉）`)
    assert(keys !== undefined, `${keyName} 不存在（迁移没落地？）`)
    for (const [value, text] of Object.entries(labels)) {
      const key = keys[value]
      assert(typeof key === 'string', `${keyName} 缺 ${value}`)
      assert(
        Object.prototype.hasOwnProperty.call(zh, key),
        `${keyName}.${value} = "${key}" 在 zh 字典里不存在`,
      )
      if (translate('zh', key) !== text) bad.push(`${keyName}.${value}：字典「${translate('zh', key)}」≠ 表「${text}」`)
    }
  }
  assert(bad.length === 0, `标签表与字典已漂移：\n${bad.slice(0, 5).map((l) => `           ${l}`).join('\n')}`)
})

await it('G2 单值标签（`IMAGE_VECTORIZE_LABEL`）同样与字典逐字一致', async () => {
  const { IMAGE_VECTORIZE_LABEL, IMAGE_VECTORIZE_KEY } = await import('@doubulea/shared')
  assertEqual(translate('zh', IMAGE_VECTORIZE_KEY), IMAGE_VECTORIZE_LABEL, '图片向量化的中文口径')
})

await it('G2b 记忆两张表（`*_KEY` 在前端 `memoryModel`，第五批的落法）同样不漂移', async () => {
  // 第五批把 `MEMORY_KIND_KEY` / `MEMORY_SCOPE_KEY` 落在 `pages/tasks/memoryModel.ts`（而不是 `shared`）：
  // 那里是"零依赖纯逻辑"档，key 表跟着它走，避免 shared 只为两张三行表多一个导出。
  // 但中文真相仍在 `shared/src/memory.ts` ⇒ 这里跨文件对一遍，防"改了一边"。
  const shared = await import('@doubulea/shared')
  const { MEMORY_KIND_KEY, MEMORY_SCOPE_KEY } = await import('../src/pages/tasks/memoryModel.ts')
  const bad = []
  for (const [labels, keys, name] of [
    [shared.MEMORY_KIND_LABELS, MEMORY_KIND_KEY, 'MEMORY_KIND'],
    [shared.MEMORY_SCOPE_LABELS, MEMORY_SCOPE_KEY, 'MEMORY_SCOPE'],
  ]) {
    for (const [value, text] of Object.entries(labels)) {
      const key = keys[value]
      assert(typeof key === 'string', `${name}_KEY 缺 ${value}`)
      if (translate('zh', key) !== text) bad.push(`${name}.${value}：字典「${translate('zh', key)}」≠ 表「${text}」`)
    }
  }
  assert(bad.length === 0, `记忆标签表与字典已漂移：${bad.join('; ')}`)
})

await it('G4 zh 的 `error.<CODE>` 与 `DEFAULT_MESSAGE_BY_ERROR_CODE` 逐条一致（不漂移）', async () => {
  const { DEFAULT_MESSAGE_BY_ERROR_CODE, ERROR_CODES } = await import('@doubulea/shared')
  const bad = ERROR_CODES.filter(
    (code) => translate('zh', `error.${code}`) !== DEFAULT_MESSAGE_BY_ERROR_CODE[code],
  )
  assert(bad.length === 0, `zh 兜底文案与 shared 常量已漂移：${bad.join(', ')}`)
})

await it('G3 `describeCron` 在 zh/en 下分别取字典（en 不含汉字）', async () => {
  const { describeCron, translate: tr } = await import('@doubulea/shared')
  // zh：与 `cron.desc.*` 的 zh 译文一致（句子的真相只有字典一份）
  assertEqual(
    describeCron('0 9 * * *', 'zh'),
    tr('zh', 'cron.desc.dailyAt', { time: '09:00' }),
    'zh 每天 09:00',
  )
  assertEqual(describeCron('* * * * *', 'zh'), '每分钟', 'zh 每分钟（与旧版逐字一致）')
  assertEqual(describeCron('0 9 * * 1', 'zh'), '每周一 09:00', 'zh 周一（星期名走 label.weekday.*）')
  // en：不许再落回中文
  for (const expr of ['* * * * *', '*/15 * * * *', '0 9 * * *', '0 9 * * 1-5', '0 9 * * 1', '0 0 1 * *']) {
    const text = describeCron(expr, 'en')
    assert(typeof text === 'string' && !CJK.test(text), `describeCron("${expr}", 'en') 里还有中文：${text}`)
  }
})

// ───────────────────────────── H zod 消息的 key 口径 ─────────────────────────────

groupStart(
  'H',
  'zod 校验消息的 key 口径',
  '末批只架机制 + 迁一个样本模块（auth.ts）；其余仍是中文正文，台账在子方案 §3.5b',
)

const { validationMessage, parseValidationMessage, validationText } = await import('@doubulea/shared')

await it('H1 造 key ⇒ 拆得出 key 与参数（往返无损）', () => {
  assertEqual(validationMessage('validation.usernameRequired'), '@validation.usernameRequired', '无参数')
  const withParams = validationMessage('validation.usernameTooLong', { max: 64 })
  assertEqual(withParams, '@validation.usernameTooLong|{"max":64}', '带参数')
  const parsed = parseValidationMessage(withParams)
  assertEqual(parsed?.key, 'validation.usernameTooLong', 'key')
  assertEqual(parsed?.params?.max, 64, '参数')
})

await it('H2 非 key 形态的消息**原样返回**（未迁的中文正文零影响）', () => {
  assertEqual(validationText('en', '用户名不能包含空格'), '用户名不能包含空格', '中文正文透传')
  assertEqual(parseValidationMessage('用户名不能包含空格'), null, '不是 key')
  assertEqual(validationText('en', ''), '', '空串原样（既不炸也不补字）')
})

await it('H3 已迁的 key 在 en 下出英文、zh 下与旧中文逐字一致', () => {
  const raw = validationMessage('validation.newPasswordTooShort', { min: 8 })
  assertEqual(validationText('zh', raw), '密码至少 8 个字符', 'zh（与旧版 auth.ts 逐字一致）')
  assertEqual(validationText('en', raw), 'Password must be at least 8 characters', 'en')
  assert(!CJK.test(validationText('en', raw)), 'en 下不许有汉字')
})

await it('H4 坏 JSON / 未知 key 不抛错，也不会把界面变成空串', () => {
  assertEqual(validationText('en', '@validation.usernameRequired|{oops'), '@validation.usernameRequired|{oops', '坏 JSON 原样')
  assertEqual(validationText('en', '@no.such.key'), '@no.such.key', '未知 key 原样（还认得出是 key）')
})

/**
 * H5 的**表驱动台账**：每迁一个模块就在 `MODULES` 里加一行（②-1 起）。
 *
 * `fixtures` 必须**覆盖到该文件的每条规则**：`z.object` 的空体只报 `required`，
 * 报不到 `.min` / `.regex` / `.max` ⇒ 只给空体等于"改完了"看起来绿、实则没验。
 */
const MODULES = [
  {
    file: 'shared/src/auth.ts',
    module: 'auth',
    fixtures: [
      ['loginBodySchema', { username: '', password: '' }],
      ['loginBodySchema', { username: 'a'.repeat(200), password: 'x'.repeat(300) }],
      ['changePasswordBodySchema', { oldPassword: '', newPassword: 'short' }],
      ['changePasswordBodySchema', { oldPassword: 'x'.repeat(300), newPassword: 'x'.repeat(300) }],
    ],
  },
  {
    file: 'shared/src/user.ts',
    module: 'user',
    fixtures: [
      ['listUsersQuerySchema', { offset: '-1', limit: '0' }],
      ['listUsersQuerySchema', { limit: '101' }],
      ['createUserBodySchema', { username: 'has space' }],
      ['createUserBodySchema', { username: 'a'.repeat(100) }],
      ['createUserBodySchema', { username: 'ok', nickname: 'n'.repeat(100) }],
      ['createUserBodySchema', { username: 'ok', role: 'SUPERUSER' }],
      ['updateUserBodySchema', {}],
      ['updateUserBodySchema', { status: 'GONE', role: 'GOD' }],
      ['userIdParamsSchema', { id: 'not-a-uuid' }],
      ['userSearchQuerySchema', { q: '' }],
      ['userSearchQuerySchema', { q: 'k'.repeat(100) }],
    ],
  },
  {
    file: 'shared/src/modelProvider.ts',
    module: 'modelProvider',
    fixtures: [
      ['listModelProvidersQuerySchema', { offset: '-1', limit: '0' }],
      ['listModelProvidersQuerySchema', { limit: '101' }],
      ['providerBaseUrlSchema', ''],
      ['providerBaseUrlSchema', 'x'.repeat(2100)],
      ['providerBaseUrlSchema', 'ftp://example.com'],
      ['providerBaseUrlSchema', 'http://a b'],
      ['providerApiKeySchema', ''],
      ['providerApiKeySchema', 'k'.repeat(600)],
      ['createModelProviderBodySchema', { name: '', baseUrl: 'https://x.test' }],
      ['createModelProviderBodySchema', { name: 'n'.repeat(200), baseUrl: 'https://x.test' }],
      ['createModelProviderBodySchema', { name: 'ok', baseUrl: 'https://x.test', protocol: 'FOO' }],
      ['createModelProviderBodySchema', { name: 'ok', baseUrl: 'https://x.test', credentialMode: 'BAR' }],
      ['updateModelProviderBodySchema', {}],
      ['updateModelProviderBodySchema', { name: '' }],
      ['updateModelProviderBodySchema', { apiKey: '' }],
      ['modelProviderIdParamsSchema', { id: 'not-a-uuid' }],
    ],
  },
  {
    file: 'shared/src/model.ts',
    module: 'model',
    fixtures: [
      ['listModelsQuerySchema', { offset: '-1', limit: '0' }],
      ['listModelsQuerySchema', { limit: '101' }],
      ['listModelsQuerySchema', { type: 'FOO' }],
      ['listModelsQuerySchema', { providerId: 'not-a-uuid' }],
      ['listModelsQuerySchema', { enabled: 'yes' }],
      ['listAvailableModelsQuerySchema', {}],
      ['listAvailableModelsQuerySchema', { type: 'FOO' }],
      ['createModelBodySchema', { providerId: 'not-a-uuid', modelName: 'm', label: 'l', type: 'CHAT' }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: '',
        label: 'l',
        type: 'CHAT',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'a b',
        label: 'l',
        type: 'CHAT',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm'.repeat(200),
        label: 'l',
        type: 'CHAT',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: '',
        type: 'CHAT',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l'.repeat(200),
        type: 'CHAT',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        maxContext: 'lots',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        maxContext: 1.5,
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        maxContext: 0,
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        maxContext: 20_000_000,
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        embeddingDim: 'big',
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        embeddingDim: 1.5,
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        embeddingDim: 0,
      }],
      ['createModelBodySchema', {
        providerId: '018f0000-0000-7000-8000-000000000000',
        modelName: 'm',
        label: 'l',
        type: 'CHAT',
        embeddingDim: 2_000_000,
      }],
      ['updateModelBodySchema', {}],
      ['modelIdParamsSchema', { id: 'not-a-uuid' }],
      ['probeEmbeddingBodySchema', { providerId: 'not-a-uuid', modelName: '' }],
      ['probeChatBodySchema', { providerId: 'not-a-uuid', modelName: '' }],
    ],
  },
  {
    file: 'shared/src/agent.ts',
    module: 'agent',
    fixtures: [
      ['listAgentsQuerySchema', { offset: '-1', limit: '0' }],
      ['listAgentsQuerySchema', { limit: '101' }],
      ['guideQuestionsSchema', 42],
      ['guideQuestionsSchema', [42]],
      ['guideQuestionsSchema', ['  ']],
      ['guideQuestionsSchema', ['g'.repeat(300)]],
      ['guideQuestionsSchema', Array.from({ length: 20 }, (_, i) => `q${i}`)],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        modelIds: [],
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        modelIds: Array.from({ length: 100 }, () => '018f0000-0000-7000-8000-000000000000'),
      }],
      ['agentComponentInputSchema', { componentType: 'FOO', refId: 'x' }],
      ['agentComponentInputSchema', {}],
      ['agentComponentInputSchema', { componentType: 'MCP', refId: 'x' }],
      ['agentComponentInputSchema', { componentType: 'MCP', refId: '018f0000-0000-7000-8000-000000000000', pinnedToolNames: 'x' }],
      ['agentComponentInputSchema', {
        componentType: 'MCP',
        refId: '018f0000-0000-7000-8000-000000000000',
        pinnedToolNames: Array.from({ length: 300 }, (_, i) => `t${i}`),
      }],
      ['replaceAgentComponentsBodySchema', {}],
      ['replaceAgentComponentsBodySchema', { components: 'x' }],
      ['replaceAgentComponentsBodySchema', {
        components: [
          { componentType: 'MCP', refId: '018f0000-0000-7000-8000-000000000000' },
          { componentType: 'MCP', refId: '018f0000-0000-7000-8000-000000000000' },
        ],
      }],
      ['createAgentBodySchema', {
        name: '',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
      }],
      ['createAgentBodySchema', {
        name: 'n'.repeat(200),
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        description: 'd'.repeat(3000),
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        icon: 'i'.repeat(300),
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        systemPrompt: 's'.repeat(20_000),
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        openingRemarks: 'o'.repeat(3000),
      }],
      ['createAgentBodySchema', { name: 'ok', type: 'FOO', modelId: '018f0000-0000-7000-8000-000000000000' }],
      ['createAgentBodySchema', { name: 'ok', type: 'CHATBOT', modelId: 'x' }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        modelIds: ['018f0000-0000-7000-8000-000000000001'],
      }],
      ['createAgentBodySchema', { name: 'ok', type: 'CHATBOT' }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        visibility: 'FOO',
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        visibility: 'SHARED',
      }],
      ['createAgentBodySchema', {
        name: 'ok',
        type: 'CHATBOT',
        modelId: '018f0000-0000-7000-8000-000000000000',
        visibility: 'PRIVATE',
        audience: { userIds: ['018f0000-0000-7000-8000-000000000002'] },
      }],
      ['updateAgentBodySchema', {}],
      ['updateAgentBodySchema', {
        modelId: '018f0000-0000-7000-8000-000000000000',
        modelIds: ['018f0000-0000-7000-8000-000000000001'],
      }],
      ['updateAgentBodySchema', {
        visibility: 'PRIVATE',
        audience: { userIds: ['018f0000-0000-7000-8000-000000000002'] },
      }],
      ['updateAgentBodySchema', { visibility: 'SHARED', audience: {} }],
      ['updateAgentBodySchema', { type: 'FOO' }],
      ['agentIdParamsSchema', { id: 'not-a-uuid' }],
    ],
  },
  {
    file: 'shared/src/knowledgeBase.ts',
    module: 'knowledgeBase',
    fixtures: [
      ['listKnowledgeBasesQuerySchema', { offset: '-1', limit: '0' }],
      ['listKnowledgeBasesQuerySchema', { limit: '101' }],
      ['retrievalConfigInputSchema', { topK: 'x' }],
      ['retrievalConfigInputSchema', { topK: 1.5 }],
      ['retrievalConfigInputSchema', { topK: 0 }],
      ['retrievalConfigInputSchema', { topK: 500 }],
      ['retrievalConfigInputSchema', { score: 'x' }],
      ['retrievalConfigInputSchema', { score: -1 }],
      ['retrievalConfigInputSchema', { score: 2 }],
      ['retrievalConfigInputSchema', { mode: 'FOO' }],
      ['retrievalConfigInputSchema', { splitStrategy: 'FOO' }],
      ['retrievalConfigInputSchema', { rrfK: 'x' }],
      ['retrievalConfigInputSchema', { rrfK: 1.5 }],
      ['retrievalConfigInputSchema', { rrfK: 0 }],
      ['retrievalConfigInputSchema', { rrfK: 5000 }],
      ['retrievalConfigInputSchema', { weights: { vector: 'x', fulltext: 1 } }],
      ['retrievalConfigInputSchema', { weights: { vector: -1, fulltext: 1 } }],
      ['retrievalConfigInputSchema', { weights: { vector: 500, fulltext: 1 } }],
      ['retrievalConfigInputSchema', { weights: { vector: 1, fulltext: 'x' } }],
      ['retrievalConfigInputSchema', { weights: { vector: 1, fulltext: -1 } }],
      ['retrievalConfigInputSchema', { weights: { vector: 1, fulltext: 500 } }],
      ['createKnowledgeBaseBodySchema', {}],
      ['createKnowledgeBaseBodySchema', { name: '', embeddingModelId: '018f0000-0000-7000-8000-000000000000' }],
      ['createKnowledgeBaseBodySchema', {
        name: 'n'.repeat(200),
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
      }],
      ['createKnowledgeBaseBodySchema', { name: 'ok' }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: 'not-a-uuid',
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        description: 'd'.repeat(3000),
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        captionModelId: 'not-a-uuid',
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkSize: 'x',
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkSize: 1.5,
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkSize: 0,
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkSize: 9000,
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkOverlap: 'x',
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkOverlap: 1.5,
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkOverlap: -1,
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        chunkOverlap: 9000,
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        visibility: 'FOO',
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        visibility: 'SHARED',
      }],
      ['createKnowledgeBaseBodySchema', {
        name: 'ok',
        embeddingModelId: '018f0000-0000-7000-8000-000000000000',
        visibility: 'PRIVATE',
        audience: { userIds: ['018f0000-0000-7000-8000-000000000002'] },
      }],
      ['updateKnowledgeBaseBodySchema', {}],
      ['updateKnowledgeBaseBodySchema', { embeddingModelId: 'not-a-uuid' }],
      ['updateKnowledgeBaseBodySchema', { captionModelId: 'not-a-uuid' }],
      ['updateKnowledgeBaseBodySchema', { visibility: 'FOO' }],
      ['updateKnowledgeBaseBodySchema', {
        visibility: 'PRIVATE',
        audience: { userIds: ['018f0000-0000-7000-8000-000000000002'] },
      }],
      ['updateKnowledgeBaseBodySchema', { visibility: 'SHARED', audience: {} }],
      ['knowledgeBaseIdParamsSchema', { id: 'not-a-uuid' }],
      ['searchKnowledgeBaseBodySchema', {}],
      ['searchKnowledgeBaseBodySchema', { query: 'q'.repeat(2000) }],
      ['searchKnowledgeBaseBodySchema', { query: 'ok', topK: 'x' }],
      ['searchKnowledgeBaseBodySchema', { query: 'ok', topK: 1.5 }],
      ['searchKnowledgeBaseBodySchema', { query: 'ok', topK: 0 }],
      ['searchKnowledgeBaseBodySchema', { query: 'ok', topK: 500 }],
      ['searchKnowledgeBaseBodySchema', { query: 'ok', mode: 'FOO' }],
    ],
  },
  {
    file: 'shared/src/task.ts',
    module: 'task',
    fixtures: [
      ['listScheduledTasksQuerySchema', { offset: '-1', limit: '0' }],
      ['listScheduledTasksQuerySchema', { limit: '101' }],
      ['createScheduledTaskBodySchema', {}],
      ['createScheduledTaskBodySchema', {
        agentId: 'not-a-uuid',
        name: 'n',
        prompt: 'p',
        cronExpr: '0 9 * * *',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: '',
        prompt: 'p',
        cronExpr: '0 9 * * *',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n'.repeat(200),
        prompt: 'p',
        cronExpr: '0 9 * * *',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: '',
        cronExpr: '0 9 * * *',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p'.repeat(30_000),
        cronExpr: '0 9 * * *',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p',
        cronExpr: '',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p',
        cronExpr: 'x'.repeat(200),
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p',
        cronExpr: 'nonsense',
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p',
        cronExpr: '0 9 * * *',
        notifyUrl: 'u'.repeat(3000),
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p',
        cronExpr: '0 9 * * *',
        notifySecret: 's'.repeat(1000),
      }],
      ['createScheduledTaskBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'n',
        prompt: 'p',
        cronExpr: '0 9 * * *',
        notifyTemplate: 't'.repeat(20_000),
      }],
      ['updateScheduledTaskBodySchema', {}],
      ['updateScheduledTaskBodySchema', { name: '' }],
      ['updateScheduledTaskBodySchema', { prompt: '' }],
      ['scheduledTaskIdParamsSchema', { id: 'not-a-uuid' }],
    ],
  },
  {
    file: 'shared/src/conversation.ts',
    module: 'conversation',
    fixtures: [
      ['listConversationsQuerySchema', { offset: '-1', limit: '0' }],
      ['listConversationsQuerySchema', { limit: '101' }],
      ['createConversationBodySchema', {}],
      ['createConversationBodySchema', { agentId: 'not-a-uuid' }],
      ['conversationIdParamsSchema', { id: 'not-a-uuid' }],
      ['renameConversationBodySchema', {}],
      ['renameConversationBodySchema', { topic: null }],
      ['renameConversationBodySchema', { topic: '   ' }],
      ['renameConversationBodySchema', { topic: 't'.repeat(300) }],
      ['setConversationAutoApproveBodySchema', {}],
      ['setConversationAutoApproveBodySchema', { enabled: 'yes' }],
      ['setConversationCodeModeBodySchema', {}],
      ['setConversationCodeModeBodySchema', { enabled: 'yes' }],
      ['setConversationRuntimeBodySchema', {}],
      ['setConversationRuntimeBodySchema', { runtime: 'r'.repeat(200) }],
      ['setConversationInstanceBodySchema', {}],
      ['setConversationInstanceBodySchema', { instanceId: '   ' }],
      ['setConversationInstanceBodySchema', { instanceId: 'i'.repeat(200) }],
      ['listArtifactsQuerySchema', { offset: '-1', limit: '0' }],
      ['listArtifactsQuerySchema', { limit: '101' }],
      ['artifactIdParamsSchema', { id: 'not-a-uuid' }],
      ['batchDeleteArtifactsBodySchema', { ids: [] }],
      ['batchDeleteArtifactsBodySchema', { ids: ['not-a-uuid'] }],
      ['batchDeleteArtifactsBodySchema', { ids: Array.from({ length: 200 }, () => '018f0000-0000-7000-8000-000000000000') }],
      ['fileIdParamsSchema', { id: 'not-a-uuid' }],
      ['listMessagesQuerySchema', { beforeId: 'not-a-uuid' }],
      ['listMessagesQuerySchema', { limit: '0' }],
      ['listMessagesQuerySchema', { limit: '101' }],
      ['messageItemSchema', {
        id: 'm1',
        role: 'USER',
        createdAt: '2026-10-27T00:00:00.000Z',
        tokensIn: null,
        tokensOut: null,
      }],
    ],
  },
  {
    file: 'shared/src/memory.ts',
    module: 'memory',
    fixtures: [
      ['listMemoriesQuerySchema', { offset: '-1', limit: '0' }],
      ['listMemoriesQuerySchema', { limit: '101' }],
      ['listMemoriesQuerySchema', { q: 'k'.repeat(300) }],
      ['createMemoryBodySchema', {}],
      ['createMemoryBodySchema', { text: '   ' }],
      ['createMemoryBodySchema', { text: 't'.repeat(3000) }],
      ['createMemoryBodySchema', { text: 'ok', agentId: 'not-a-uuid' }],
      ['updateMemoryBodySchema', {}],
      ['updateMemoryBodySchema', { text: '   ' }],
      ['updateMemoryBodySchema', { agentId: 'not-a-uuid' }],
      ['memoryIdParamsSchema', { id: 'not-a-uuid' }],
      ['updateMemorySettingsBodySchema', {}],
      ['updateMemorySettingsBodySchema', { memoryProfileMax: 0 }],
      ['updateMemorySettingsBodySchema', { memoryProfileMax: 100 }],
      ['memoryNoticeActionBodySchema', { action: 'ACCEPT', text: '   ' }],
      ['setConversationMemoryExcludedBodySchema', {}],
      ['setConversationMemoryExcludedBodySchema', { excluded: 'yes' }],
      ['listActivityQuerySchema', { offset: '-1', limit: '0' }],
      ['listActivityQuerySchema', { limit: '101' }],
      ['listActivityQuerySchema', { q: 'k'.repeat(300) }],
      ['searchActivityQuerySchema', {}],
      ['searchActivityQuerySchema', { q: '   ' }],
      ['searchActivityQuerySchema', { q: 'k'.repeat(300) }],
    ],
  },
  {
    file: 'shared/src/openApi.ts',
    module: 'openApi',
    fixtures: [
      ['createOpenApiKeyBodySchema', {}],
      ['createOpenApiKeyBodySchema', { agentId: 'not-a-uuid', name: 'k' }],
      ['createOpenApiKeyBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: '   ',
      }],
      ['createOpenApiKeyBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'k'.repeat(300),
      }],
      ['createOpenApiKeyBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'ok',
        scopes: [],
      }],
      ['createOpenApiKeyBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'ok',
        expiresAt: 'not-a-date',
      }],
      ['createOpenApiKeyBodySchema', {
        agentId: '018f0000-0000-7000-8000-000000000000',
        name: 'ok',
        userId: 'not-a-uuid',
      }],
      ['listOpenApiKeysQuerySchema', { agentId: 'not-a-uuid' }],
      ['openApiKeyIdParamsSchema', { keyId: 'not-a-uuid' }],
      ['openCreateConversationBodySchema', { title: '   ' }],
      ['openCreateConversationBodySchema', { title: 't'.repeat(300) }],
      ['openConversationIdParamsSchema', { id: 'not-a-uuid' }],
      ['openChatBodySchema', {}],
      ['openChatBodySchema', { content: 42 }],
      ['openChatBodySchema', { content: '   ' }],
      ['openChatBodySchema', { content: 'c'.repeat(200_000) }],
      ['openChatBodySchema', { content: 'ok', modelId: 'not-a-uuid' }],
      ['openChatBodySchema', { content: 'ok', attachmentFileIds: ['not-a-uuid'] }],
      ['openChatBodySchema', {
        content: 'ok',
        attachmentFileIds: Array.from({ length: 50 }, () => '018f0000-0000-7000-8000-000000000000'),
      }],
      ['openRegenerateBodySchema', { modelId: 'not-a-uuid' }],
      ['openSteerBodySchema', {}],
      ['openSteerBodySchema', { message: '   ' }],
      ['openSteerBodySchema', { message: 'm'.repeat(200_000) }],
      ['openConfirmBodySchema', {}],
      ['openConfirmBodySchema', { confirmId: '', accepted: true }],
      ['openSetAutoApproveBodySchema', {}],
    ],
  },
  {
    file: 'shared/src/userGroup.ts',
    module: 'userGroup',
    fixtures: [
      ['listUserGroupsQuerySchema', { offset: '-1', limit: '0' }],
      ['listUserGroupsQuerySchema', { limit: '101' }],
      ['createUserGroupBodySchema', {}],
      ['createUserGroupBodySchema', { name: '   ' }],
      ['createUserGroupBodySchema', { name: 'n'.repeat(100) }],
      ['createUserGroupBodySchema', { name: 'ok', description: 'd'.repeat(600) }],
      ['updateUserGroupBodySchema', {}],
      ['replaceUserGroupMembersBodySchema', {}],
      ['replaceUserGroupMembersBodySchema', { userIds: 'x' }],
      ['replaceUserGroupMembersBodySchema', { userIds: ['not-a-uuid'] }],
      ['userGroupIdParamsSchema', { id: 'not-a-uuid' }],
    ],
  },
  {
    file: 'shared/src/document.ts',
    module: 'document',
    fixtures: [
      ['documentParamsSchema', { id: 'not-a-uuid', docId: 'not-a-uuid' }],
      ['renameDocumentBodySchema', {}],
      ['renameDocumentBodySchema', { fileName: '   ' }],
      ['renameDocumentBodySchema', { fileName: 'f'.repeat(300) }],
      ['listDocumentsQuerySchema', { offset: '-1', limit: '0' }],
      ['listDocumentsQuerySchema', { limit: '101' }],
      ['listDocumentChunksQuerySchema', { offset: '-1', limit: '0' }],
      ['listDocumentChunksQuerySchema', { limit: '101' }],
    ],
  },
  {
    file: 'shared/src/workspace.ts',
    module: 'workspace',
    fixtures: [
      ['workspacePathSchema', {}],
      ['workspacePathSchema', 42],
      ['workspacePathSchema', '/absolute'],
      ['workspacePathSchema', '../escape'],
      ['workspaceWriteFileBodySchema', {}],
      ['workspaceWriteFileBodySchema', { content: 'x', baseVersion: -1 }],
      ['workspaceMoveBodySchema', {}],
    ],
  },
  {
    file: 'shared/src/runtime.ts',
    module: 'runtime',
    fixtures: [
      ['buildSandboxRuntimeBodySchema', {}],
      ['buildSandboxRuntimeBodySchema', { components: [{ language: 'node', version: '  ' }] }],
      ['buildSandboxRuntimeBodySchema', { components: [{ language: 'node', version: 'v'.repeat(40) }] }],
      ['buildSandboxRuntimeBodySchema', { components: [] }],
      ['buildSandboxRuntimeBodySchema', {
        components: Array.from({ length: 9 }, () => ({ language: 'node', version: '20' })),
      }],
    ],
  },
  {
    file: 'shared/src/gitIdentity.ts',
    module: 'gitIdentity',
    fixtures: [
      ['updateGitIdentityBodySchema', {}],
      ['updateGitIdentityBodySchema', { email: 'e'.repeat(300) }],
      ['updateGitIdentityBodySchema', { email: 'not-an-email' }],
      ['updateGitIdentityBodySchema', { name: 'n'.repeat(200) }],
    ],
  },
  {
    file: 'shared/src/titleModel.ts',
    module: 'titleModel',
    fixtures: [
      ['updateTitleModelBodySchema', {}],
      ['updateTitleModelBodySchema', { enabled: 'x' }],
      ['updateTitleModelBodySchema', { enabled: true, modelId: 42 }],
      ['updateTitleModelBodySchema', { enabled: true, modelId: 'not-a-uuid' }],
    ],
  },
  {
    file: 'shared/src/assetAcl.ts',
    module: 'assetAcl',
    fixtures: [
      ['transferAssetBodySchema', {}],
      ['transferAssetBodySchema', { toUserId: 'not-a-uuid' }],
      ['agentAudienceInputSchema', { userIds: ['not-a-uuid'] }],
      ['agentAudienceInputSchema', { groupIds: ['not-a-uuid'] }],
    ],
  },
  {
    file: 'shared/src/egressPolicy.ts',
    module: 'egressPolicy',
    fixtures: [
      ['updateEgressPolicyBodySchema', { allowHosts: 'x', denyHosts: [] }],
      ['updateEgressPolicyBodySchema', {
        allowHosts: Array.from({ length: 600 }, () => 'x.test'),
        denyHosts: [],
      }],
    ],
  },
  {
    file: 'shared/src/sse.ts',
    module: 'chat',
    fixtures: [
      ['chatRequestBodySchema', {}],
      ['chatRequestBodySchema', { content: 42 }],
      ['chatRequestBodySchema', { content: '   ' }],
      ['chatRequestBodySchema', { content: 'c'.repeat(200_000) }],
      ['chatRequestBodySchema', { content: 'ok', modelId: 'not-a-uuid' }],
      ['chatRequestBodySchema', { content: 'ok', attachmentFileIds: ['not-a-uuid'] }],
      ['chatRequestBodySchema', {
        content: 'ok',
        attachmentFileIds: Array.from({ length: 50 }, () => '018f0000-0000-7000-8000-000000000000'),
      }],
      ['regenerateConversationBodySchema', { modelId: 'not-a-uuid' }],
      ['steerConversationBodySchema', {}],
      ['steerConversationBodySchema', { message: 42 }],
      ['steerConversationBodySchema', { message: '   ' }],
      ['steerConversationBodySchema', { message: 'm'.repeat(200_000) }],
      ['steerCancelBodySchema', {}],
      ['steerCancelBodySchema', { id: '' }],
      ['confirmRequestBodySchema', {}],
      ['confirmRequestBodySchema', { confirmId: 42, accepted: true }],
      ['confirmRequestBodySchema', { confirmId: '', accepted: true }],
      ['confirmRequestBodySchema', { confirmId: 'c1', accepted: 'yes' }],
    ],
  },
  {
    file: 'shared/src/mcp.ts',
    module: 'mcp',
    fixtures: [
      ['listMcpServersQuerySchema', { offset: '-1', limit: '0' }],
      ['listMcpServersQuerySchema', { limit: '101' }],
      ['credentialSchemaEntrySchema', {}],
      ['credentialSchemaEntrySchema', { key: '', label: '', type: 'string', inject: 'HEADER' }],
      ['credentialSchemaEntrySchema', {
        key: 'k'.repeat(100),
        label: 'l'.repeat(100),
        type: 'string',
        inject: 'HEADER',
        placeholder: 'p'.repeat(200),
      }],
      ['credentialSchemaEntrySchema', { key: 'k', label: 'l', type: 'number', inject: 'HEADER' }],
      ['credentialSchemaEntrySchema', { key: 'k', label: 'l', type: 'string', inject: 'COOKIE' }],
      ['validateCredentialSchema', 'not-an-array'],
      ['validateCredentialSchema', Array.from({ length: 70 }, (_, i) => ({
        key: `k${i}`,
        label: 'L',
        type: 'string',
        inject: 'HEADER',
      }))],
      ['validateCredentialSchema', [{ key: 'Accept', label: 'L', type: 'string', inject: 'HEADER' }]],
      ['validateCredentialSchema', [{ key: 'X User', label: 'L', type: 'string', inject: 'HEADER' }]],
      ['validateCredentialSchema', [{ key: 'a=b', label: 'L', type: 'string', inject: 'QUERY' }]],
      ['validateCredentialSchema', [{ key: 'method', label: 'L', type: 'string', inject: 'BODY' }]],
      ['validateCredentialSchema', [
        { key: 'token', label: 'L', type: 'string', inject: 'HEADER' },
        { key: 'token', label: 'L', type: 'string', inject: 'HEADER' },
      ]],
      ['putMyCredentialBodySchema', { values: {} }],
      ['putMyCredentialBodySchema', { values: { token: 42 } }],
      ['putMyCredentialBodySchema', { values: { token: 'v'.repeat(5000) } }],
      ['mcpServerToolsQuerySchema', { refresh: 'yes' }],
      ['createMcpServerBodySchema', {}],
      ['createMcpServerBodySchema', { name: '   ', endpointUrl: 'http://x.test' }],
      ['createMcpServerBodySchema', { name: 'n'.repeat(200), endpointUrl: 'http://x.test' }],
      ['createMcpServerBodySchema', { name: 'ok', endpointUrl: '' }],
      ['createMcpServerBodySchema', { name: 'ok', endpointUrl: 'http://' + 'x'.repeat(5000) }],
      ['createMcpServerBodySchema', { name: 'ok', endpointUrl: 'not a url' }],
      ['createMcpServerBodySchema', { name: 'ok', endpointUrl: 'ftp://x.test' }],
      ['createMcpServerBodySchema', { name: 'ok', endpointUrl: 'http://x.test', authType: 'FOO' }],
      ['createMcpServerBodySchema', { name: 'ok', endpointUrl: 'http://x.test', visibility: 'SHARED' }],
      ['updateMcpServerBodySchema', {}],
      ['mcpServerIdParamsSchema', { id: 'not-a-uuid' }],
      ['mcpCredentialServerIdParamsSchema', { serverId: 'not-a-uuid' }],
    ],
  },
]

await it('H5 已迁模块的校验消息都已是 `@validation.*` key，且 en 下不含汉字', async () => {
  const shared = await import('@doubulea/shared')
  for (const { file, module: moduleName, fixtures } of MODULES) {
    // 源码侧：该文件里不该再有**裸中文的 zod 消息**（注释外的字面量一律进了字典）。
    // ⚠️ 判据与子方案 §3.5b 同口径：含中文 **且** 带 zod 消息特征的行才算 ——
    // `shared` 里这些文件的 `*_LABELS` 与句子常量是**刻意保留**的（不是界面文案）。
    const source = stripComments(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'))
    const ZOD_FEATURE = /required_error|invalid_type_error|errorMap|\.min\(|\.max\(|\.int\(|\.regex\(|\.length\(|\.uuid\(|\.datetime\(|\.refine\(|message:|addIssue\(/
    const leftovers = source.split('\n').filter((line) => CJK.test(line) && ZOD_FEATURE.test(line))
    assert(
      leftovers.length === 0,
      `${file} 里仍有裸中文的 zod 消息：\n${leftovers.slice(0, 3).map((l) => `           ${l.trim()}`).join('\n')}`,
    )
    assertIncludes(source, 'validationMessage(', `${file} 用 key 造消息`)
    for (const [schemaName, fixture] of fixtures) {
      const schema = shared[schemaName]
      assert(schema !== undefined, `${schemaName} 不存在`)
      // 两种被校验对象：zod schema（`.safeParse`）与 `*Validation` 型纯函数（如
      // `validateCredentialSchema` —— 它返回 `{ok, issues}`，不吃 zod 的 issues 形状）
      let issues
      if (typeof schema.safeParse === 'function') {
        const parsed = schema.safeParse(fixture)
        assert(!parsed.success, `${schemaName} 的 fixture ${JSON.stringify(fixture)} 应当校验失败`)
        issues = parsed.error.issues
      } else {
        assert(typeof schema === 'function', `${schemaName} 既不是 zod schema 也不是校验函数`)
        const result = schema(fixture)
        assert(result.ok === false, `${schemaName} 的 fixture ${JSON.stringify(fixture)} 应当校验失败`)
        issues = result.issues
      }
      for (const issue of issues) {
        // ① 走 key 的消息：key 必须在字典里（拼错的 key 会永远用不上，界面上只显形为原样 key）
        if (issue.message.startsWith('@validation.')) {
          const key = issue.message.slice(1).split('|')[0]
          assert(
            Object.prototype.hasOwnProperty.call(zh, key),
            `${schemaName} 的消息 key "${key}" 在字典里不存在（模块 ${moduleName}）`,
          )
        }
        // ② 真正的交付判据：**en 下不出现汉字**。
        //    zod 自带的 `Required` / `Invalid enum value…` 是英文，不算漏译
        //    （它们由 zod 直接产出、本仓也没有覆盖的打算）；源码级"零中文 zod 消息"由上面那条守。
        assert(!CJK.test(validationText('en', issue.message)), `en 下仍出中文：${issue.message}`)
      }
    }
  }
})

/**
 * H6 网络层自造句（`api/client.ts` / `api/workspace.ts` / `features/chat/*`）——
 * **不是** zod 消息，走的是 `translate(currentLocale(), 'api.*')`，所以 H5 那套 fixture 管不到。
 *
 * 判据三条：① 字典里 `api.*` 每一条 zh/en 都齐（A 组已守，这里只确认命名空间非空）；
 * ② en 下逐条不含汉字；③ 前端源码里不再出现那几句中文（F 组已守，这里再点一次**具体句子**，
 * 免得有人把新句子写成裸中文却挑了个 F 账本外的文件）。
 */
await it('H6 网络层自造句（`api.*`）在 en 下不含汉字，且源码里已无那几句裸中文', async () => {
  const apiKeys = Object.keys(zh).filter((key) => key.startsWith('api.'))
  assert(apiKeys.length >= 13, `api.* 的 key 太少（${apiKeys.length}），命名空间可能被误删`)
  for (const key of apiKeys) {
    assert(!CJK.test(en[key]), `en["${key}"] 还有中文：${en[key]}`)
  }
  const NETWORK_SENTENCES = [
    '请求已取消',
    '无法连接后端',
    '响应不是合法的 JSON',
    '响应不符合统一信封约定',
    '期望事件流，但响应',
    '期望文件字节流，但响应',
    '下载失败：响应不是 JSON 信封也不是文件',
    '工作区事件帧解析失败',
    '不认识的事件名（已忽略）',
    'data 不是合法 JSON',
  ]
  const offenders = []
  for (const file of ['src/api/client.ts', 'src/api/workspace.ts', 'src/features/chat/chatStream.ts', 'src/features/chat/sseParser.ts']) {
    const source = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    for (const sentence of NETWORK_SENTENCES) {
      if (source.includes(sentence)) offenders.push(`${file}: ${sentence}`)
    }
  }
  assert(offenders.length === 0, `这几句应已进字典：${offenders.join(' / ')}`)
})

/**
 * H7 失败通知的主文案判定（`app/feedbackModel.ts#failureMessage`）。
 *
 * 这条断言是**补一个真缺陷**：2026-10-27 收尾 ④ 把前端自造的文案迁进字典后，
 * `feedback.ts` 仍在 en 下**无条件**把 `ApiError.message` 换成 `error.<CODE>` ——
 * 于是已经翻好的英文被丢掉，`NETWORK` 更是退化成 "Operation failed"（它不在 `ERROR_CODES` 里）。
 * 那个文件 import 了 antd，零依赖档导入不了 ⇒ 判据抽成纯函数后由这里断言。
 */
await it('H7 失败通知：en 下**只替换含中文的消息**，已翻好的英文原样保留', async () => {
  const { failureMessage } = await import('../src/app/feedbackModel.js')

  // ① zh：永远原样（服务端那句中文信息量更大）
  assertEqual(failureMessage('zh', 'NOT_FOUND', '智能体不存在'), '智能体不存在', 'zh 原样')
  // ② en + 中文消息 ⇒ 换成 error.<CODE>
  assertEqual(failureMessage('en', 'NOT_FOUND', '智能体不存在'), en['error.NOT_FOUND'], 'en 换掉中文')
  // ③ en + 已是英文（前端自造）⇒ **原样保留**（收尾 ④ 之后它们构造期就是当前语言）
  const english = 'Cannot reach the backend. Check your network or whether the backend is running'
  assertEqual(failureMessage('en', 'NETWORK', english), english, 'en 保留已翻好的文案')
  // ④ en + 伪码 NETWORK + 中文 ⇒ 落到通用兜底（NETWORK 不在 ERROR_CODES 里）
  assertEqual(
    failureMessage('en', 'NETWORK', '无法连接后端'),
    en['common.operationFailed'],
    '伪码走通用兜底',
  )
  // ⑤ 每一档结果都不该含汉字（这是这段兜底存在的唯一目的）
  for (const [locale, code, fallback] of [
    ['en', 'NOT_FOUND', '智能体不存在'],
    ['en', 'NETWORK', '无法连接后端'],
    ['en', 'INTERNAL', '响应不是合法的 JSON'],
  ]) {
    const out = failureMessage(locale, code, fallback)
    assert(!CJK.test(out), `${code} 的 en 结果仍有中文：${out}`)
  }
})

await it('H8 错误码的括号形态跟着语言走（zh 全角 / en 半角）', () => {
  const zhParen = translate('zh', 'common.withCode', { text: 'x', code: 'INTERNAL' })
  const enParen = translate('en', 'common.withCode', { text: 'x', code: 'INTERNAL' })
  assertIncludes(zhParen, '（INTERNAL）', 'zh 用全角括号')
  assertIncludes(enParen, '(INTERNAL)', 'en 用半角括号')
  assert(!CJK.test(enParen), 'en 下不该出现全角括号')
})

/**
 * K 组：后端 `AppError` 细节消息的 key 收口（P1-23 收尾 ⑤）。
 *
 * 三条判据（缺一不可）：
 *   ① **后端零裸中文**：`backend/src` 里 `AppError.*(<中文字面量>)` 一处都不许再有 ——
 *      否则那条消息在 en 下只能退化成 `error.<CODE>`（正是本批要消灭的东西）。
 *   ② **登记表 ↔ 字典一致**：`shared/src/appMessages.ts` 的每个 key 都在 zh/en 里存在，
 *      且 zh 译文与"登记表的键"（即中文模板）**逐字相同** —— 这条最要紧：
 *      `appMsg()` 用 zh 译文渲染 `AppError.message`，两者一旦漂移，
 *      日志 / `documents.error_msg` 里的中文就会与界面上的中文对不上。
 *   ③ **en 无汉字**：243+ 条英文译文里不许有中文。
 */
await it('K1 后端不再有裸中文的 `AppError` 消息（全部走 `appMsg`）', () => {
  const files = readdirSync(new URL('../../backend/src/', import.meta.url), { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
  const offenders = []
  for (const rel of files) {
    const source = stripComments(readFileSync(new URL(`../../backend/src/${rel}`, import.meta.url), 'utf8'))
    source.split('\n').forEach((line, i) => {
      if (!CJK.test(line)) return
      if (!/AppError\.\w+\(|new AppError\(/.test(line)) return
      if (/appMsg\(/.test(line)) return
      offenders.push(`backend/src/${rel}:${i + 1}  ${line.trim().slice(0, 90)}`)
    })
  }
  assert(offenders.length === 0, `还有裸中文的 AppError 消息：\n         ${offenders.slice(0, 5).join('\n         ')}`)
})

await it('K2 登记表 ↔ 字典一致（zh 译文 === 中文模板，en 无汉字）', async () => {
  const { APP_MESSAGES } = await import('@doubulea/shared')
  assert(Object.keys(APP_MESSAGES).length >= 280, `运行期登记表条目太少（${Object.keys(APP_MESSAGES).length}）`)
  const registry = readFileSync(new URL('../../shared/src/appMessages.ts', import.meta.url), 'utf8')
  const entries = []
  const re = /^\s*("(?:[^"\\]|\\.)*"):\s*\{\s*key:\s*"([^"]+)",\s*names:\s*\[([^\]]*)\]\s*\},?$/gm
  let m
  while ((m = re.exec(registry))) {
    entries.push({ tpl: JSON.parse(m[1]), key: m[2], names: m[3] })
  }
  assert(entries.length >= 280, `登记表条目太少（${entries.length}），可能被截断`)
  for (const e of entries) {
    assert(Object.prototype.hasOwnProperty.call(zh, e.key), `字典里缺 ${e.key}`)
    assertEqual(zh[e.key], e.tpl, `${e.key} 的 zh 译文必须与登记表的中文模板逐字相同`)
    assert(!CJK.test(en[e.key]), `${e.key} 的 en 译文还有中文：${en[e.key]}`)
  }
  // 位置参数个数：模板里的 `{n}` 必须与 `names` 等长（否则插值会少一个/多一个）
  for (const e of entries) {
    const count = (e.tpl.match(/\{\d+\}/g) ?? []).length
    const names = e.names.split(',').map((x) => x.trim()).filter((x) => x !== '').length
    assertEqual(names, count, `${e.key} 的参数名个数（${names}）与模板占位符（${count}）不符`)
  }
})

await it('K3 `appMsg` 渲染的 zh 正文与直接写中文字符串**逐字一致**（日志/error_msg 零漂移）', async () => {
  const { appMsg, AppError } = await import('@doubulea/shared')
  // 取一条带参数的，验证参数真的被插进去
  const withParam = new AppError('NOT_FOUND', appMsg('app.m116', { p0: 'gpt-4o' }))
  assertEqual(withParam.message, '模型不存在：gpt-4o', 'zh 正文')
  assertEqual(JSON.stringify(withParam.msgKey), JSON.stringify({ key: 'app.m116', params: { '0': 'gpt-4o' } }), '结构化 key')
  // 无参数的
  const plain = new AppError('NOT_FOUND', appMsg('app.m000'))
  assertEqual(plain.message, '智能体不存在', 'zh 正文')
  assertEqual(JSON.stringify(plain.msgKey), JSON.stringify({ key: 'app.m000' }), '结构化 key（无 params 时不带该字段）')
  // 老写法（直接给字符串）⇒ 没有 msgKey，行为与改写前一致
  const legacy = new AppError('NOT_FOUND', '智能体不存在')
  assertEqual(legacy.message, '智能体不存在', '老写法正文不变')
  assertEqual(legacy.msgKey, null, '老写法没有结构化 key')
  // en 下按 key 渲染出英文（这条是整批的交付判据：信息量不再退化成 error.<CODE>）
  const { appMessageText } = await import('@doubulea/shared')
  const english = appMessageText('en', withParam.message, withParam.msgKey)
  assertEqual(english, 'Model not found: gpt-4o', 'en 渲染')
  assert(!CJK.test(english), `en 渲染不该有汉字：${english}`)
})

console.log()
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(`  ${mark} ${group.id} ${group.title}（${group.passed}/${group.passed + group.failed}）`)
}
console.log(
  `\n${failed === 0 ? c.g : c.r}verify-i18n：${passed} 通过 / ${failed} 失败${c.x}`,
)
console.log(
  `   ${c.d}⚠️ 浏览器可见路径（切 EN 后外壳/AntD 组件/dayjs 日期真的变、刷新后保持）由用户人工端测${c.x}`,
)
process.exit(failed === 0 ? 0 : 1)