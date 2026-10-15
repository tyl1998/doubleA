#!/usr/bin/env node
/**
 * verify-workspace-ui.mjs —— Code 模式工作区面板前端**无依赖**验收（P1-9 · P3）
 *
 * 跑法：`pnpm verify:workspace-ui`（= `node --import tsx scripts/verify-workspace-ui.mjs`）
 *
 * 为什么一条依赖都不需要：本批前端侧可自证的风险集中在 `workspaceModel.ts` 的**纯展示函数**上
 * —— 文件树的父子关系、事件算不算"内容变更"、冲突文案、体积格式化，错了**都不报错**，
 * 只是显示不对。全是纯函数 ⇒ 直接喂字面量逐条断言（`memoryModel.ts` / P1-7 同款手法）。
 *
 * ⚠️ 本档**验不了**：后端读写 / CAS 冲突 / SSE 真流 / 浏览器渲染 ⇒ 分别属后端与浏览器端测。
 */

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
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const {
  buildWorkspaceTree,
  flattenTreeFiles,
  isContentEvent,
  eventTouchesPath,
  formatBytes,
  conflictText,
  fileExtension,
  isEditableRead,
  changeTagColor,
  revertSummaryText,
  workspaceEditorLanguage,
  withOpenedTab,
  nextActiveOnClose,
  renameOpenTab,
  toggleExpandedDir,
  workspaceBaseName,
  filterWorkspaceTree,
  flattenWorkspaceTree,
  fileIconKind,
  isImageMime,
  workspaceLanguageLabel,
  clampWorkspacePanelWidth,
  WORKSPACE_PANEL_MIN_W,
  WORKSPACE_PANEL_MAX_W,
  workspaceParentDir,
  joinWorkspacePath,
  workspaceNewFolderPlaceholderPath,
  workspaceMoveTargetPath,
  WORKSPACE_FOLDER_PLACEHOLDER,
} = await import('../src/features/chat/workspaceModel.ts')

const entry = (path, size = 10, mime = 'text/plain') => ({
  path,
  size,
  mime,
  version: 1,
  updatedBy: 'USER',
  updatedAt: '2026-10-12T00:00:00.000Z',
})

console.log('── W1 buildWorkspaceTree（目录从路径派生）──')
it('W1 扁平路径长出父子目录；目录在前、文件按名排序', () => {
  const tree = buildWorkspaceTree([entry('out/report.csv'), entry('a.txt'), entry('out/data/x.json')])
  eq(tree.length, 2, '根节点数')
  eq(tree[0].kind, 'dir', '目录在前')
  eq(tree[0].name, 'out', '目录名')
  eq(tree[1].kind, 'file', '文件在后')
  const out = tree[0]
  assert(out.kind === 'dir', 'out 是目录')
  eq(out.children.map((n) => n.name).join(','), 'data,report.csv', '子节点顺序（dir 在前）')
})
it('W2 隐藏路径（. 前缀段）标记 hidden', () => {
  const tree = buildWorkspaceTree([entry('.git/config'), entry('src/a.ts')])
  const git = tree.find((n) => n.name === '.git')
  assert(git !== undefined && git.hidden === true, '.git 应 hidden')
})

console.log('── W2 flattenTreeFiles（深度优先）──')
it('W3 深度优先列出所有文件', () => {
  const tree = buildWorkspaceTree([entry('out/data/x.json'), entry('a.txt')])
  eq(flattenTreeFiles(tree).map((n) => n.path).join(','), 'out/data/x.json,a.txt', '文件顺序')
})

console.log('── W3 事件判定 ──')
it('W4 内容事件 vs claim/release', () => {
  eq(isContentEvent({ type: 'updated' }), true, 'updated 是内容事件')
  eq(isContentEvent({ type: 'renamed' }), true, 'renamed 是内容事件')
  eq(isContentEvent({ type: 'claim' }), false, 'claim 不是内容事件')
  eq(isContentEvent({ type: 'release' }), false, 'release 不是内容事件')
})
it('W5 事件命中当前打开的文件', () => {
  eq(eventTouchesPath({ path: 'a.txt' }, 'a.txt'), true, '命中')
  eq(eventTouchesPath({ path: 'a.txt' }, 'b.txt'), false, '不命中')
  eq(eventTouchesPath({ path: 'a.txt' }, null), false, '未打开')
})

console.log('── W4 展示辅助 ──')
it('W6 formatBytes', () => {
  eq(formatBytes(512), '512 B', 'B')
  eq(formatBytes(2048), '2.0 KB', 'KB')
  eq(formatBytes(5 * 1024 * 1024), '5.0 MB', 'MB')
})
it('W7 conflictText（讲清当前版本）', () => {
  assert(conflictText(7).includes('v7'), '带当前版本')
  eq(conflictText(undefined).includes('他人修改'), true, '无版本也给因由')
})
it('W8 fileExtension', () => {
  eq(fileExtension('a/b.TS'), 'ts', '小写')
  eq(fileExtension('noext'), '', '无扩展')
})
it('W9 isEditableRead（文本内联成功才可编辑）', () => {
  eq(isEditableRead({ text: 'x', mime: 'text/plain' }), true, '文本可编辑')
  eq(isEditableRead({ text: null, mime: 'image/png' }), false, '二进制不可编辑')
  eq(isEditableRead({ text: null, mime: 'text/plain' }), false, '超大文本（未内联）不可编辑')
})
it('W10 changeTagColor（变更类型 → 标签色）', () => {
  eq(changeTagColor('created'), 'green', 'created')
  eq(changeTagColor('updated'), 'blue', 'updated')
  eq(changeTagColor('deleted'), 'red', 'deleted')
  eq(changeTagColor('claim'), 'default', 'claim 中性')
})

console.log('── W6 撤销本轮汇总（revertSummaryText，P1-9 · P4 · R2）──')
it('W11 按落点动作计数汇总；冲突/缺历史/不支持如实展示', () => {
  const text = revertSummaryText({
    dryRun: false,
    items: [
      { path: 'a', action: 'restored', currentVersion: 7, fromVersion: 5, toVersion: 8 },
      { path: 'b', action: 'deleted', currentVersion: 1, fromVersion: null, toVersion: null },
      { path: 'c', action: 'conflict', currentVersion: 9, fromVersion: 5, toVersion: null },
      { path: 'd', action: 'unavailable', currentVersion: 3, fromVersion: 2, toVersion: null },
    ],
  })
  assert(text.includes('还原 1') && text.includes('删除 1'), `应含还原/删除计数：${text}`)
  assert(text.includes('冲突 1') && text.includes('缺历史 1'), `应含冲突/缺历史：${text}`)
  eq(text.startsWith('[预演]'), false, '非 dryRun 不加前缀')
})
it('W12 dryRun 加前缀；空结果 = "本轮无工作区改动"', () => {
  eq(revertSummaryText({ dryRun: true, items: [] }), '[预演] 本轮无工作区改动', '空 + 预演')
  eq(revertSummaryText({ dryRun: false, items: [] }), '本轮无工作区改动', '空')
})

console.log('── W7 编辑器语言映射（workspaceEditorLanguage，P1-9 · R7）──')
it('W13 常见扩展名 → 语言包 id（js/ts/json/html/css/py/md）', () => {
  eq(workspaceEditorLanguage('src/a.js'), 'javascript', 'js')
  eq(workspaceEditorLanguage('src/a.tsx'), 'typescript', 'tsx')
  eq(workspaceEditorLanguage('config.json'), 'json', 'json')
  eq(workspaceEditorLanguage('index.html'), 'html', 'html')
  eq(workspaceEditorLanguage('style.scss'), 'css', 'css')
  eq(workspaceEditorLanguage('main.py'), 'python', 'python')
  eq(workspaceEditorLanguage('README.md'), 'markdown', 'markdown')
})
it('W14 不认识 / 无扩展 → text（仍可编辑，只是不高亮）', () => {
  eq(workspaceEditorLanguage('Dockerfile'), 'text', '无扩展')
  eq(workspaceEditorLanguage('data.xyz'), 'text', '未知后缀')
  eq(workspaceEditorLanguage('a/b/Makefile'), 'text', '嵌套无扩展')
})

console.log('── W8 多标签（P1-9 · R12）──')
it('W15 withOpenedTab：已打开不重复、保持顺序', () => {
  eq(withOpenedTab(['a', 'b'], 'b').join(','), 'a,b', '已打开不追加')
  eq(withOpenedTab(['a', 'b'], 'c').join(','), 'a,b,c', '新文件追加到末尾')
  eq(withOpenedTab([], 'a').join(','), 'a', '空列表')
})
it('W16 nextActiveOnClose：优先右边，其次左边，空则 null', () => {
  eq(nextActiveOnClose(['a', 'b', 'c'], 'b'), 'c', '关中间 → 右边')
  eq(nextActiveOnClose(['a', 'b', 'c'], 'c'), 'b', '关末尾 → 左边')
  eq(nextActiveOnClose(['a', 'b', 'c'], 'a'), 'b', '关首个 → 右边')
  eq(nextActiveOnClose(['a'], 'a'), null, '关最后一个 → null')
})
it('W17 workspaceBaseName：取末段', () => {
  eq(workspaceBaseName('a/b/c.ts'), 'c.ts', '嵌套')
  eq(workspaceBaseName('README.md'), 'README.md', '无目录')
})
it('W23 renameOpenTab：迁移路径并去重', () => {
  eq(renameOpenTab(['a', 'b'], 'a', 'c').join(','), 'c,b', '普通改名')
  eq(renameOpenTab(['a', 'b'], 'a', 'b').join(','), 'b', '改成已打开的路径 → 去重')
  eq(renameOpenTab(['a', 'b'], 'x', 'y').join(','), 'a,b', '不在列表里 → 原样')
})
it('W23b toggleExpandedDir：展开追加 / 再点移除（默认空 = 全折叠）', () => {
  eq(toggleExpandedDir([], 'src').join(','), 'src', '空列表展开一个')
  eq(toggleExpandedDir(['src', 'out'], 'out').join(','), 'src', '再点同一个 → 折叠（移除）')
  eq(toggleExpandedDir(['src'], 'out').join(','), 'src,out', '展开新的 → 追加到末尾（顺序稳定）')
  eq(toggleExpandedDir([], 'src').length, 1, '不修改入参以外的语义（纯函数）')
})

console.log('── W9 文件树过滤 / 图标 / 只读图片（P1-9 · R12）──')
it('W18 filterWorkspaceTree：默认丢掉隐藏子树（.git 等）', () => {
  const tree = buildWorkspaceTree([entry('.git/config'), entry('src/a.ts'), entry('out/report.csv')])
  const visible = filterWorkspaceTree(tree, false)
  eq(visible.map((n) => n.name).join(','), 'out,src', '隐藏目录不出现')
  eq(filterWorkspaceTree(tree, true).length, 3, '显示隐藏时全在')
})
it('W18b flattenWorkspaceTree：折叠目录整段跳过、depth 随层级（虚拟滚动按它切片）', () => {
  const tree = buildWorkspaceTree([entry('src/a.ts'), entry('src/deep/b.ts'), entry('out/report.csv')])
  const all = flattenWorkspaceTree(tree, () => false)
  eq(
    all.map((row) => `${row.node.name}@${row.depth}`).join(','),
    'out@0,report.csv@1,src@0,deep@1,b.ts@2,a.ts@1',
    '深度优先 + 层级（目录在前）',
  )
  eq(
    flattenWorkspaceTree(tree, (path) => path === 'src').map((row) => row.node.name).join(','),
    'out,report.csv,src',
    '折叠的目录其整棵子树不进列表',
  )
  eq(
    flattenWorkspaceTree(tree, (path) => path === 'src/deep').map((row) => row.node.name).join(','),
    'out,report.csv,src,deep,a.ts',
    '只跳过被折叠那一层的子树',
  )
})
it('W19 fileIconKind：按扩展名归大类', () => {
  eq(fileIconKind('a.ts'), 'typescript', 'ts')
  eq(fileIconKind('a.PNG'), 'image', '大写扩展也认')
  eq(fileIconKind('script.sh'), 'shell', 'sh')
  eq(fileIconKind('noext'), 'text', '无扩展')
})
it('W20 isImageMime：image/* 才是图片', () => {
  eq(isImageMime('image/png'), true, 'png')
  eq(isImageMime('IMAGE/JPEG'), true, '大小写不敏感')
  eq(isImageMime('application/pdf'), false, 'pdf 不是')
  eq(isImageMime(null), false, '空安全')
})
it('W21 workspaceLanguageLabel：语言 id → 人读文案', () => {
  eq(workspaceLanguageLabel('typescript'), 'TypeScript', 'ts')
  eq(workspaceLanguageLabel('text'), '纯文本', 'text')
})

console.log('── W10 面板宽度夹取（P1-9 · R12）──')
it('W22 clampWorkspacePanelWidth：下限 / 上限 / 视口收窄', () => {
  eq(clampWorkspacePanelWidth(100, 1600), WORKSPACE_PANEL_MIN_W, '低于下限 → 抬到下限')
  eq(clampWorkspacePanelWidth(5000, 1600), WORKSPACE_PANEL_MAX_W, '高过上限 → 压到上限')
  eq(clampWorkspacePanelWidth(600, 1600), 600, '区间内原样')
  eq(clampWorkspacePanelWidth(900, 800), Math.floor(800 * 0.72), '视口窄 → 上限收到 72%')
})

console.log('── W11 路径工具（右键新建 / 拖拽移动用）──')
it('W24 workspaceParentDir / joinWorkspacePath', () => {
  eq(workspaceParentDir('a/b/c.ts'), 'a/b', '嵌套取父目录')
  eq(workspaceParentDir('a.ts'), '', '根层文件取空串')
  eq(joinWorkspacePath('a/b', 'c.ts'), 'a/b/c.ts', '目录 + 名字拼接')
  eq(joinWorkspacePath('', 'c.ts'), 'c.ts', '根目录拼接')
})
it('W25 workspaceNewFolderPlaceholderPath：文件夹落 .gitkeep 占位', () => {
  eq(workspaceNewFolderPlaceholderPath('', 'utils'), 'utils/.gitkeep', '根下新目录')
  eq(workspaceNewFolderPlaceholderPath('src', 'utils'), 'src/utils/.gitkeep', '子目录下新目录')
  eq(WORKSPACE_FOLDER_PLACEHOLDER, '.gitkeep', '占位文件名')
})
it('W26 workspaceMoveTargetPath：拖到目录后目标路径（名字不变）', () => {
  eq(workspaceMoveTargetPath('a/b/c.ts', 'x/y'), 'x/y/c.ts', '移到别的目录')
  eq(workspaceMoveTargetPath('c.ts', ''), 'c.ts', '移到根目录保持原名')
})

console.log('')
console.log(`verify-workspace-ui：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)