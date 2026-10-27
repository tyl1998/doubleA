#!/usr/bin/env node
/**
 * verify-artifact-panel.mjs —— 产物面板前端**无依赖**验收（P0-3-11）
 *
 * 跑法：`pnpm verify:artifact-panel`
 *      （= `node --import tsx frontend/scripts/verify-artifact-panel.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险集中在两个来源的**合流**上 —— 而它的错法全是"**界面上看不出、也不报任何错**"：
 *   · **顺序**：服务端列表是 `created_at desc`（最新在前）、`artifact` 事件是产出顺序（旧 → 新）。
 *     直接拼接得到"上半段旧→新、下半段新→旧"的清单 —— 不报错、也不重复，
 *     只是**刚生成的那个掉在中间**，而用户找的就是它；
 *   · **去重**：一轮结束后同一个产物会同时出现在两份里。不去重 ⇒ 面板的「产物 · N」
 *     这个计数说谎，而界面上两条长得一模一样、看不出为什么多了一个；
 *   · **时间读数**：`null`（流式、还没落库）与"解析不出时刻"是两件事，混成一句就是假话；
 *   · **溢出读数**：拿 `items.length` 当"共 N 个"会在超过一页时说谎。
 * 这些全是纯函数 ⇒ 直接喂字面量、手写夹具，逐条断言（P0-1-32~35 同款手法）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · **三栏布局**（`chat--with-panel` 到底占多宽、1280px 下第三列有没有真的藏起来）；
 *   · **抽屉真渲染 / 六个渲染器 / 五种格式在浏览器里的样子**；
 *   · **MD 的外链图片有没有真的被拦下**（DevTools Network）；
 *   · **面板与列表的时序**（"这一轮结束、列表重取回来之后那一条从『刚生成』变成时刻读数"）
 *     ⇒ 属**人工浏览器端测**（`README`「浏览器端测 · 任务型对话页」有清单）；
 *   · 打包后的行为（本档跑的是**源码**，不经 vite）。
 *
 * ⚠️ 与其余前端档同款：本档 import `@doubulea/shared`，node 解析到 **`shared/dist`**
 * ⇒ 改过 `shared/src` 之后要先 `pnpm --filter @doubulea/shared build`。
 * 本档只用到**类型**（`AgentType` / `ArtifactItem`），运行期取的是
 * `../src/features/chat/artifactPanelModel.ts`（它自己 import 的 `describeConversationTime`
 * 来自零依赖的 `conversationList.ts` ⇒ 整条链上没有一个 React / 没有一个请求）。
 */

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

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

// ───────────────────────────── 被测对象 ─────────────────────────────

const { translate } = await import('@doubulea/shared')

// P1-23：译文只在字典一处 —— 这里把它绑成"zh 取值器"，断言才不必逐条手写 `translate('zh', ...)`
// （本档不再抄任何中文字面量；字典齐平与 en 无中文由 `verify-i18n` 守着）。
const tz = (key, params) => translate('zh', key, params)

const { describeConversationTime } = await import('../src/features/chat/conversationList.ts')

// P1-23：读数改为"多收 locale 的纯函数"（译文在 `shared/src/i18n`）。本档统一用 `'zh'` 断言，
// 句子的中文形态与旧断言**逐字一致**（字典齐平由 `verify-i18n` 守着，这里不抄第二份真相）。
const ZH = 'zh'

const {
  ARTIFACT_PANEL_TITLE,
  ARTIFACT_PANEL_EMPTY,
  ARTIFACT_PANEL_NOTE,
  ARTIFACT_TIME_JUST,
  ARTIFACT_TIME_UNKNOWN,
  showArtifactPanel,
  mergeArtifactPanelItems,
  artifactTimeText,
  artifactPanelOverflowNote,
} = await import('../src/features/chat/artifactPanelModel.ts')

/** 一条服务端列表项（带 `createdAt`） */
function persisted(artifactId, overrides = {}) {
  return {
    artifactId,
    fileName: `${artifactId}.csv`,
    size: 100,
    mime: 'text/csv',
    createdAt: '2026-09-27T10:00:00.000Z',
    ...overrides,
  }
}

/** 一条流式产物（**没有** `createdAt`） */
function streamed(artifactId, overrides = {}) {
  return { artifactId, fileName: `${artifactId}.csv`, size: 100, mime: 'text/csv', ...overrides }
}

/** 只取判据关心的那几个字段，断言里不必被 `fileName` 之类的噪声干扰 */
function shape(items) {
  return items.map((item) => ({
    id: item.artifactId,
    createdAt: item.createdAt,
    live: item.live,
  }))
}

// ───────────────────────────── A 面板出现判据 ─────────────────────────────

groupStart('A', '`showArtifactPanel(agentType)`：只有 TaskAgent 有这一列（`03` §4.1 的"TaskAgent 差异"）')

await it('A1 `TASK_AGENT` ⇒ 显示', () => {
  assertEqual(showArtifactPanel('TASK_AGENT'), true, 'TASK_AGENT')
})

await it('A2 `CHATBOT` ⇒ 不显示；`undefined`（agent 还没读到）也按"不显示"处理', () => {
  assertEqual(showArtifactPanel('CHATBOT'), false, 'CHATBOT')
  // ⚠️ 首帧 `undefined` 必须落进"不显示"这一支：先渲染再撤掉会让 `grid-template-columns`
  //    变一次 ⇒ 中栏宽度跳一下（三栏布局的可见缺陷）
  assertEqual(showArtifactPanel(undefined), false, 'undefined')
})

// ───────────────────────────── B 两个来源的合流 ─────────────────────────────

groupStart(
  'B',
  '`mergeArtifactPanelItems(persisted, streamed)`：倒序对齐 + 按 `artifactId` 去重',
  '顺序不是排版偏好：服务端 `created_at desc` 与事件产出顺序**正好相反**（见文件头）',
)

await it('B1 两个来源都空 ⇒ 空清单（不是 undefined、不是一条空壳）', () => {
  assertDeepEqual(mergeArtifactPanelItems([], []), [], '都空')
})

await it('B2 只有服务端列表 ⇒ 顺序一列都不动，全部 `live:false`（有 `createdAt`）', () => {
  const result = mergeArtifactPanelItems([persisted('p1'), persisted('p2'), persisted('p3')], [])
  assertDeepEqual(
    shape(result),
    [
      { id: 'p1', createdAt: '2026-09-27T10:00:00.000Z', live: false },
      { id: 'p2', createdAt: '2026-09-27T10:00:00.000Z', live: false },
      { id: 'p3', createdAt: '2026-09-27T10:00:00.000Z', live: false },
    ],
    '服务端列表原序',
  )
})

await it('★ B3 只有流式事件 ⇒ **倒序**（最新在前）+ 全部 `live:true` + `createdAt:null`', () => {
  const result = mergeArtifactPanelItems([], [streamed('s1'), streamed('s2'), streamed('s3')])
  assertDeepEqual(
    shape(result),
    [
      { id: 's3', createdAt: null, live: true },
      { id: 's2', createdAt: null, live: true },
      { id: 's1', createdAt: null, live: true },
    ],
    '事件那一段必须倒序：事件是"旧 → 新"，而清单要和列表一样"最新在前"',
  )
})

await it('★ B4 两个来源重叠 ⇒ 按 `artifactId` 去重，且**保留服务端那一份**（它有 `createdAt`）', () => {
  const result = mergeArtifactPanelItems(
    [persisted('a'), persisted('b')],
    [streamed('b'), streamed('c')],
  )
  // `b` 只出现一次，且是列表那一份（`live:false` + 有 `createdAt`）
  assertDeepEqual(
    shape(result),
    [
      { id: 'c', createdAt: null, live: true },
      { id: 'a', createdAt: '2026-09-27T10:00:00.000Z', live: false },
      { id: 'b', createdAt: '2026-09-27T10:00:00.000Z', live: false },
    ],
    '新鲜的那条（c）在最前，其余按列表原序；b 只出现一次且带时刻',
  )
  assertEqual(result.length, 3, '计数不许说谎')
})

await it('★ B5 两段各自的排序口径一致 ⇒ 拼接后整体仍是"最新在前"', () => {
  // 列表：p1 比 p2 新（服务端已排好）；事件：s1 → s2（旧 → 新）
  const result = mergeArtifactPanelItems([persisted('p1'), persisted('p2')], [streamed('s1'), streamed('s2')])
  assertDeepEqual(
    result.map((item) => item.artifactId),
    ['s2', 's1', 'p1', 'p2'],
    's2（最新）→ s1 → p1 → p2：两段拼接后不许出现"中间开始变旧"的折点',
  )
})

await it('B6 服务端列表自己重复了同一个 id ⇒ 也只出现一次（防御：分页边界上真会发生）', () => {
  const result = mergeArtifactPanelItems([persisted('dup'), persisted('dup'), persisted('x')], [])
  assertDeepEqual(
    result.map((item) => item.artifactId),
    ['dup', 'x'],
    '列表自身的重复同样要去掉',
  )
})

await it('B7 多带的字段不会丢（`ArtifactView` 与 `ArtifactListItem` 都直接透传）', () => {
  const result = mergeArtifactPanelItems([persisted('p1', { mime: 'image/png', size: 2048 })], [
    streamed('s1', { mime: 'text/markdown', size: 10 }),
  ])
  assertDeepEqual(
    result.map((item) => [item.artifactId, item.fileName, item.size, item.mime]),
    [
      ['s1', 's1.csv', 10, 'text/markdown'],
      ['p1', 'p1.csv', 2048, 'image/png'],
    ],
    '四个原字段逐字透传（面板要拿它们画卡片与判"能不能预览"）',
  )
})

// ───────────────────────────── C 时间读数 ─────────────────────────────

groupStart('C', '`artifactTimeText(createdAt, now)`：`null` / 解析不出 / 正常时刻，三档分开', '分档复用 `conversationList#describeConversationTime`（同一口径）')

const NOW = new Date('2026-09-27T12:00:00.000Z')

await it('C1 `null`（这一轮刚产出、还没落库）⇒ 「刚生成」，而不是"没有消息"之类别的话', () => {
  assertEqual(artifactTimeText(null, NOW, ZH), tz(ARTIFACT_TIME_JUST), 'null')
})

await it('★ C2 解析不出时刻 ⇒ 「时间未知」——**与 `null` 必须分得开**', () => {
  assertEqual(artifactTimeText('not-a-date', NOW, ZH), tz(ARTIFACT_TIME_UNKNOWN), '非法 ISO')
  assertEqual(artifactTimeText('', NOW, ZH), tz(ARTIFACT_TIME_UNKNOWN), '空串也算解析不出')
  // ⚠️ 反例：`conversationList` 那边解析不出时说的是"还没有消息" —— 那是**会话**的语义，
  //    套到产物上是一句假话（产物明明已经产出了，只是不知道什么时候）
  assert(tz(ARTIFACT_TIME_UNKNOWN) !== tz('sidebar.timeNoMessage'), '不许拿会话那边的回落文案冒充')
})

await it('C3 正常时刻 ⇒ 与 `describeConversationTime` **逐字同口径**（同一个函数，不写第二份）', () => {
  const at = '2026-09-27T11:55:00.000Z' // 5 分钟前
  assertEqual(artifactTimeText(at, NOW, ZH), describeConversationTime(at, NOW, ZH), '与侧栏同一口径')
  assertEqual(artifactTimeText(at, NOW, ZH), '5 分钟前', '顺带把读数本身钉住')
})

// ───────────────────────────── D 溢出读数 ─────────────────────────────

groupStart('D', '`artifactPanelOverflowNote(shown, total)`：只在**真的**截断了时才出现', '⚠️ 拿 `items.length` 当"共 N 个"会在超过一页时说谎')

await it('D1 `total` 拿不到（`undefined`）⇒ 什么都不说，而不是编一个数', () => {
  assertEqual(artifactPanelOverflowNote(3, undefined, ZH), null, 'undefined')
})

await it('D2 ★ 边界：`total === shown` ⇒ **不出现**这一行（没有截断就别说截断）', () => {
  assertEqual(artifactPanelOverflowNote(100, 100, ZH), null, '恰好等于')
  assertEqual(artifactPanelOverflowNote(1, 1, ZH), null, '一个也是')
})

await it('D3 `total > shown` ⇒ 读数把**两个数**都说出来（"最近 100 个 / 共 120 个"）', () => {
  const note = artifactPanelOverflowNote(100, 120, ZH)
  assert(note !== null, '应当出现')
  assertIncludes(note, '100', '显示数')
  assertIncludes(note, '120', '总数')
})

await it('D4 `total < shown`（服务端说少了 / 防御）⇒ 也不出现，而不是编一句负数', () => {
  assertEqual(artifactPanelOverflowNote(5, 3, ZH), null, '倒挂')
})

// ───────────────────────────── E 文案常量 ─────────────────────────────

groupStart('E', '面板文案的三个常量（各只有一处写法，组件里不许再抄一遍）')

await it('E1 标题取「产物」（`design/chat.html` 的 `产物 · 3` 那一格前缀）', () => {
  assertEqual(tz(ARTIFACT_PANEL_TITLE), '产物', '标题译文')
})

await it('E2 空态那句话**不是错误态**（新会话的常态），且指明"文件会列在这里"', () => {
  assert(tz(ARTIFACT_PANEL_EMPTY).length > 0, '非空')
  assertIncludes(tz(ARTIFACT_PANEL_EMPTY), 'TaskAgent', '要说清是谁产出的')
})

await it('E3 常驻说明要落在"空闲回收后仍可下载"这条保证上', () => {
  assertIncludes(tz(ARTIFACT_PANEL_NOTE), '回收', '要点是"回收之后还能下载"')
})

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── 结论表（A~E 五组）──${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · 三栏布局（\`chat--with-panel\` 的宽度、1280px 断点下第三列藏没藏 + 入口按钮是否改走抽屉）⇒ 浏览器${c.x}`)
console.log(`  · 抽屉真渲染 / 六个渲染器 / 五种格式 / MD 外链图片被拦下 ⇒ 浏览器端测（P0-3-11 本批）${c.x}`)
console.log(`  · "一轮结束后那条从『刚生成』变成时刻读数"的**时序** ⇒ 浏览器端测（需真产物）${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 产物面板前端纯逻辑验收通过（P0-3-11）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 产物面板前端纯逻辑验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
