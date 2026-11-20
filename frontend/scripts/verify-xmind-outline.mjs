#!/usr/bin/env node
/**
 * verify-xmind-outline.mjs —— XMind 大纲预览前端**无依赖**验收（2026-11-20）
 *
 * 跑法：`pnpm verify:xmind-outline`（= `node --import tsx scripts/verify-xmind-outline.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么一条依赖都不需要
 * ─────────────────────────────────────────────────────────────────────
 * 本档守的是 `components/XmindOutline/xmindOutline.ts` 的**纯判据**，错了都**不会报错**、
 * 只会让界面显示成另一种样子：
 *   · **哪个节点算用例** —— 只认 `tc-` 前缀会漏掉 `PC-01: …` 这类同样有步骤的写法（用户 2026-11-20 反馈）；
 *   · **步骤与预期结果的配对** —— 配错了界面照样渲染，只是内容张冠李戴；
 *   · **前置条件拆行** —— 多行 `pc:` 也常被当成一段长文本，读起来像一句话；
 *   · **子树搜索** —— 必须能按 DB 字段名（写在步骤/预期里）找到用例，而不只是匹配节点标题。
 *
 * ⚠️ 本档**验不了**：AntD `Tree` 的实际展开/滚动行为、后端 `/outline` 的响应头与解析结果
 * （后者由后端 `parseXmind` 负责，命令行可取一份真实 xmind 验）。
 *
 * ⚠️ 与其余前端档同款：import `@doubulea/shared` 解析到 `shared/dist` ⇒ 改过 `shared/src`
 * 之后要先 `pnpm --filter @doubulea/shared build`。
 */

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

function groupStart(id, title) {
  currentGroup = { id, title, passed: 0, failed: 0 }
  groups.push(currentGroup)
  console.log(`\n${c.b}── ${id} ${title} ──${c.x}`)
}

function it(name, fn) {
  try {
    fn()
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

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}：期望 ${b}，实得 ${a}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const {
  bodyOf,
  buildCaseView,
  countNodes,
  firstLineOf,
  isCaseHeading,
  looksLikeCase,
  pathTo,
  sectionKindOf,
  splitCaseHeading,
  splitPrefix,
  subtreeMatches,
} = await import('../src/components/XmindOutline/xmindOutline.ts')

/** 造一个节点（只填用得到的字段） */
function node(title, children = [], note) {
  return note === undefined ? { title, children } : { title, children, note }
}

// ───────────────────────────── A 用例识别 ─────────────────────────────

groupStart('A', '用例识别：名字判据 + 结构判据（不认 `tc-` 的写法也要进用例视图）')

it('A1 `tc-…` / `TC-…` 标题命中', () => {
  eq(isCaseHeading('tc-P1: [APP][EC-MOD]S4 券+权益'), true, 'tc-P1')
  eq(isCaseHeading('TC-DY-3 抖音支付'), true, 'TC-DY-3')
  eq(isCaseHeading('   tc-p0: 小写且带前导空格'), true, '前导空格 + 小写')
})

it('A2 普通标题不命中（`pc:` / `操作步骤` 是**子节点**的写法，不是节点本身）', () => {
  eq(isCaseHeading('一、EC 咖啡生活馆(双端 + MOD/MOP)'), false, '分组标题')
  eq(isCaseHeading('pc:\n1. 用户已登录'), false, 'pc 节点自身')
  eq(isCaseHeading(''), false, '空标题')
})

it('A3 标题拆分：`tc-P1: …` ⇒ `{ id: P1, name: … }`；拆不出时 id 为空', () => {
  eq(splitCaseHeading('tc-P1: [APP] 星礼卡补差'), { id: 'P1', name: '[APP] 星礼卡补差' }, '带冒号')
  eq(splitCaseHeading('tc-blocked 锁券超时'), { id: 'BLOCKED', name: '锁券超时' }, '空格分隔')
  eq(splitCaseHeading('普通标题'), { id: '', name: '普通标题' }, '不是用例')
})

it('A4 结构判据：没有 `tc-` 前缀但有步骤 / 预期 / 前置 ⇒ 也算用例', () => {
  const pc = node('PC-01: 用户下单', [
    node('步骤1: 选择门店', [node('预期结果1: 进入购物袋')]),
  ])
  eq(looksLikeCase(pc), true, '步骤 + 预期')
  const withPc = node('退款场景', [node('pc: 已支付订单'), node('操作步骤1: 申请退款')])
  eq(looksLikeCase(withPc), true, 'pc + 操作步骤')
  const plain = node('一、EC 咖啡生活馆', [node('1.1 正向支付')])
  eq(looksLikeCase(plain), false, '纯分组不算用例')
})

it('A5 小节归类：pc / 步骤 / 预期 / 日志 / 其它', () => {
  eq(sectionKindOf('pc:\n1. 已登录'), 'pc', 'pc:')
  eq(sectionKindOf('PC: 已登录'), 'pc', '大写 PC')
  eq(sectionKindOf('前置条件: 已登录'), 'other', '前置条件不是 pc 前缀（按其它处理）')
  eq(sectionKindOf('操作步骤3: 提交订单'), 'step', '操作步骤N')
  eq(sectionKindOf('步骤2：完成支付'), 'step', '步骤N（全角冒号与中文数字）')
  eq(sectionKindOf('预期结果1: 购物袋显示'), 'expect', '预期结果N')
  eq(sectionKindOf('查看日志关注'), 'log', '日志关注')
  eq(sectionKindOf('端上订单及优惠查看'), 'other', '认不出的进其它')
})

// ───────────────────────────── B 分段与配对 ─────────────────────────────

groupStart('B', '用例视图：`pc:` 拆行 / 步骤与预期配对 / 平铺预期不丢')

it('B1 `pc:` 多行拆成列表，行内 `1.` `2.` 编号剥掉', () => {
  const view = buildCaseView(
    node('tc-P1: 完整支付成功', [
      node('pc:\n1. 用户已登录 APP\n2. 持有 S4 券 1 张\n3. 星礼卡余额充足'),
      node('操作步骤1: 加入购物袋', [node('预期结果1: 显示商品')]),
    ]),
  )
  eq(view.precondition, ['用户已登录 APP', '持有 S4 券 1 张', '星礼卡余额充足'], '前置条件')
})

it('B2 步骤的**子节点**是它的预期结果（一对一）', () => {
  const view = buildCaseView(
    node('tc-P1: 一单两步', [
      node('操作步骤1: 选商品', [node('预期结果1: 购物袋有商品')]),
      node('操作步骤2: 支付', [node('预期结果2: 支付成功')]),
    ]),
  )
  eq(view.steps.length, 2, '两步')
  eq(view.steps[0].expected[0].text, '购物袋有商品', '第一步预期')
  eq(view.steps[1].expected[0].text, '支付成功', '第二步预期')
})

it('B3 步骤序号取标题里的 N（不是按数组下标）', () => {
  const view = buildCaseView(node('tc-P2: 乱序步骤', [node('操作步骤7: 第七步'), node('操作步骤2: 第二步')]))
  eq(view.steps.map((step) => step.index), [7, 2], '序号')
})

it('B4 ★ 与步骤**平级**的预期结果挂到上一个步骤（丢掉就少一条断言）', () => {
  const view = buildCaseView(
    node('tc-P1: 平铺写法', [node('操作步骤1: 提交订单'), node('预期结果1: 订单创建成功')]),
  )
  eq(view.steps.length, 1, '一步')
  eq(view.steps[0].expected.map((item) => item.text), ['订单创建成功'], '预期挂在第一步')
})

it('B5 多行正文保留换行（DB 终态断言是多行的，压成一行等于丢信息）', () => {
  const db = '操作步骤3: 完成支付\n最终终态 DB:\n· payment_order: 1 条\n· payment_sub_order: 3 条'
  eq(bodyOf(db), '最终终态 DB:\n· payment_order: 1 条\n· payment_sub_order: 3 条', '正文含换行')
  eq(firstLineOf(db), '操作步骤3: 完成支付', '首行是标题')
  const view = buildCaseView(node('tc-P1: 支付', [node(db, [node('预期结果3: state=2')])]))
  eq(view.steps[0].text.includes('payment_sub_order: 3 条'), true, '步骤正文保留 DB 行')
})

it('B6 没有任何步骤时，孤立的预期结果落到 `others`（不丢、也不误导）', () => {
  const view = buildCaseView(node('tc-P1: 只有预期', [node('预期结果1: 应该有步骤但没有')]))
  eq(view.steps.length, 0, '没有步骤')
  eq(view.others.length, 1, '进了其它')
  eq(view.others[0].includes('应该有步骤但没有'), true, '内容还在')
})

it('B7 `splitPrefix`：前缀与正文分开，正文换行原样保留', () => {
  eq(splitPrefix('操作步骤1: 选商品'), { prefix: '操作步骤1', body: '选商品' }, '单行')
  eq(splitPrefix('pc: 已登录'), { prefix: 'pc', body: '已登录' }, 'pc')
  eq(splitPrefix('没有前缀'), { prefix: '', body: '没有前缀' }, '无冒号')
})

it('B8 日志关注单独成段', () => {
  const view = buildCaseView(
    node('tc-P1: 有日志', [node('操作步骤1: 支付'), node('查看日志关注', [node('关注 OMS 回调')])]),
  )
  eq(view.logs, ['查看日志关注'], '日志段')
})

// ───────────────────────────── C 树工具 ─────────────────────────────

groupStart('C', '树工具：节点计数 / 子树搜索（按 DB 字段名找用例）/ 路径')

const tree = node('UPP', [
  node('第4阶段', [
    node('一、EC 咖啡生活馆', [
      node('1.1 正向支付', [
        node('tc-P1: 星礼卡补差', [
          node('操作步骤3: 完成支付', [node('预期结果3: payment_asset_lock 0 条')]),
        ]),
      ]),
    ]),
  ]),
])

it('C1 countNodes 含自身', () => {
  eq(countNodes(node('叶子')), 1, '单节点')
  eq(countNodes(tree), 7, '整棵树')
})

it('C2 ★ 子树搜索能命中步骤 / 预期里的 DB 字段名', () => {
  eq(subtreeMatches(tree, 'payment_asset_lock'), true, '按 DB 字段找用例')
  eq(subtreeMatches(tree, 'TC-P1'), true, '大小写不敏感')
  eq(subtreeMatches(tree, '不存在的字段'), false, '没命中')
  eq(subtreeMatches(tree, '   '), false, '空白关键字不算命中')
})

it('C3 命中的是**祖先链**（上层分组也会命中 ⇒ 搜索能定位到它下面的用例）', () => {
  const ec = tree.children[0].children[0]
  eq(subtreeMatches(ec, 'payment_asset_lock'), true, 'EC 分组命中')
  eq(subtreeMatches(ec.children[0].children[0], 'payment_asset_lock'), true, '用例自身命中')
})

it('C4 备注也参与搜索', () => {
  const withNote = node('节点', [], '备注里有 delivery_fee')
  eq(subtreeMatches(withNote, 'delivery_fee'), true, '备注命中')
})

it('C5 pathTo 返回从根到目标的路径；找不到返回 null', () => {
  const target = tree.children[0].children[0].children[0].children[0]
  const path = pathTo(tree, target)
  assert(path !== null, '应能找到')
  eq(path.length, 5, '五级')
  eq(path[0] === tree, true, '第一项是根')
  eq(path[4] === target, true, '最后一项是目标')
  eq(pathTo(tree, node('孤岛')), null, '不在树上')
})

// ───────────────────────────── 结论 ─────────────────────────────

console.log(`\n${c.b}── 结论 ──${c.x}`)
for (const group of groups) {
  const ok = group.failed === 0
  const mark = ok ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(`  ${mark} ${group.id} ${group.title}  (${group.passed} 通过 / ${group.failed} 失败)`)
}

const total = `verify-xmind-outline：${passed} 通过 / ${failed} 失败`
console.log(`\n${failed === 0 ? c.g : c.r}${total}${c.x}`)
process.exit(failed === 0 ? 0 : 1)
