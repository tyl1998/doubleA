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
  workspaceResolvePromptPath,
  WORKSPACE_FOLDER_PLACEHOLDER,
  mergeWorkspaceChanges,
  workspaceAncestorDirs,
  unionExpandedDirs,
  revertActionLabel,
  isWorkspacePathInDir,
  WORKSPACE_CONTAINER_ROOT,
  WORKSPACE_COPY_ITEM_KEYS,
  workspaceCopyItems,
  workspaceCopyValue,
  workspaceGitChipLabel,
  workspaceGitChipTitle,
  isGitInternalPath,
  workspaceFileDiffQueryKey,
  workspaceDiffScope,
  groupWorkspaceChangesByRound,
  WORKSPACE_RECENT_MAX_PER_GROUP,
  workspaceChangeGrouping,
  retentionDaysLeft,
  WORKSPACE_RETENTION_NOTICE_DAYS,
} = await import('../src/features/chat/workspaceModel.ts')

// P1-23：读数改为"多收 locale 的纯函数"（译文在 `shared/src/i18n`）。本档统一用 zh 断言，
// 中文形态与旧断言逐字一致（字典齐平由 `verify-i18n` 守着）。
const ZH = 'zh'

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
  assert(conflictText(7, ZH).includes('v7'), '带当前版本')
  eq(conflictText(undefined, ZH).includes('他人修改'), true, '无版本也给因由')
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
  const text = revertSummaryText(
    {
      dryRun: false,
      items: [
        { path: 'a', action: 'restored', currentVersion: 7, fromVersion: 5, toVersion: 8 },
        { path: 'b', action: 'deleted', currentVersion: 1, fromVersion: null, toVersion: null },
        { path: 'c', action: 'conflict', currentVersion: 9, fromVersion: 5, toVersion: null },
        { path: 'd', action: 'unavailable', currentVersion: 3, fromVersion: 2, toVersion: null },
      ],
    },
    ZH,
  )
  assert(text.includes('还原 1') && text.includes('删除 1'), `应含还原/删除计数：${text}`)
  assert(text.includes('冲突 1') && text.includes('缺历史 1'), `应含冲突/缺历史：${text}`)
  eq(text.startsWith('[预演]'), false, '非 dryRun 不加前缀')
})
it('W12 dryRun 加前缀；空结果 = "本轮无工作区改动"', () => {
  eq(revertSummaryText({ dryRun: true, items: [] }, ZH), '[预演] 本轮无工作区改动', '空 + 预演')
  eq(revertSummaryText({ dryRun: false, items: [] }, ZH), '本轮无工作区改动', '空')
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
  eq(workspaceLanguageLabel('typescript', ZH), 'TypeScript', 'ts')
  eq(workspaceLanguageLabel('text', ZH), '纯文本', 'text')
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
it('W26b workspaceResolvePromptPath：预填 a/ 后再敲 a/x.py 不叠成 a/a/x.py', () => {
  // ★ 2026-10-29 用户实测：右键目录 a 新建，框里预填 `a/`，输入 `a/x.py` ⇒ 实际建出 `a/a/x.py`
  eq(workspaceResolvePromptPath('a', 'a/x.py'), 'x.py', '★ 连前缀一起敲 ⇒ 只留 x.py（最终 a/x.py）')
  eq(workspaceResolvePromptPath('a', 'x.py'), 'x.py', '正常从预填处接着敲')
  eq(workspaceResolvePromptPath('a', 'b/x.py'), 'b/x.py', '改成别的子目录 ⇒ 按用户写的走（a/b/x.py）')
  eq(workspaceResolvePromptPath('a', 'a'), '', '只敲目录本身 ⇒ 空名，调用方不创建')
  eq(workspaceResolvePromptPath('', 'a/x.py'), 'a/x.py', '根目录不预填前缀')
  eq(workspaceResolvePromptPath('a', ' a/x.py '), 'x.py', '两端空白不影响判定')
})

console.log('── W12 最近变更 / 自动展开 / 撤销报告（P1-20 问题 1）──')
it('W27 mergeWorkspaceChanges：服务端基线 ∪ 实时事件，按路径折叠、只认内容事件、时间倒序', () => {
  const server = [
    { path: 'a.ts', type: 'updated', version: 2, actor: 'AGENT', actorId: null, at: '2026-10-15T01:00:00.000Z' },
    { path: 'b.ts', type: 'created', version: 1, actor: 'USER', actorId: 'u1', at: '2026-10-15T00:30:00.000Z' },
  ]
  const live = [
    // 同路径、更晚 ⇒ 覆盖服务端那条
    { id: 'e1', path: 'a.ts', type: 'deleted', version: 3, actor: 'AGENT', actorId: null, at: '2026-10-15T02:00:00.000Z' },
    // 新路径 ⇒ 追加
    { id: 'e2', path: 'c.ts', type: 'created', version: 1, actor: 'AGENT', actorId: null, at: '2026-10-15T02:30:00.000Z' },
    // claim/release ⇒ 不是内容变更，丢弃（不顶掉真正的 updated）
    { id: 'e3', path: 'b.ts', type: 'claim', version: 1, actor: 'AGENT', actorId: null, at: '2026-10-15T03:00:00.000Z' },
  ]
  const merged = mergeWorkspaceChanges(server, live)
  // ★ 2026-10-28（「按次」口径）：实时事件顶掉的那条**降级为更早**保留 ⇒ a.ts 出现两次
  //   （本轮 + 更早）。这正是"编辑第二次也看得见第一次"的要求，不是重复项。
  eq(merged.map((item) => item.path).join(','), 'c.ts,a.ts,a.ts,b.ts', '按时间倒序、去掉 claim、被顶掉的降级为更早')
  eq(merged.filter((item) => item.path === 'a.ts' && item.segment === 'current')[0]?.type, 'deleted', '本轮取更晚的实时事件')
  eq(merged.filter((item) => item.path === 'a.ts' && item.segment === 'earlier')[0]?.version, 2, '更早保留上一次（服务端那条 v2）')
  eq(merged.find((item) => item.path === 'b.ts')?.type, 'created', 'claim 不顶掉内容事件')
})
it('W28 mergeWorkspaceChanges：只有服务端基线（刷新/刚进会话）也能出列表', () => {
  const merged = mergeWorkspaceChanges(
    [{ path: 'x.ts', type: 'updated', version: 1, actor: 'AGENT', actorId: null, at: '2026-10-15T00:00:00.000Z' }],
    [],
  )
  eq(merged.length, 1, '实时事件为空时仍展示服务端那句基线')
  eq(merged[0].path, 'x.ts', '路径')
})
it('W29 workspaceAncestorDirs：列出一条路径的全部祖先目录', () => {
  eq(workspaceAncestorDirs('a/b/c.ts').join(','), 'a,a/b', '两级祖先')
  eq(workspaceAncestorDirs('c.ts').length, 0, '根层文件没有祖先')
})
it('W30 unionExpandedDirs：并入去重、保持既有顺序', () => {
  eq(unionExpandedDirs(['a'], ['a', 'a/b']).join(','), 'a,a/b', '已展开的不重复')
  eq(unionExpandedDirs([], ['a', 'a/b']).join(','), 'a,a/b', '空集合照单并入')
})
it('W31 revertActionLabel：落点动作 → 人读文案', () => {
  eq(revertActionLabel('restored', ZH), '已还原', 'restored')
  eq(revertActionLabel('conflict', ZH), '冲突', 'conflict')
  eq(revertActionLabel('unavailable', ZH), '缺历史', 'unavailable')
})
it('W32 isWorkspacePathInDir：删除文件夹只命中该目录之下（带尾斜杠，不误伤同前缀兄弟）', () => {
  eq(isWorkspacePathInDir('out/a.ts', 'out'), true, '直接子文件')
  eq(isWorkspacePathInDir('out/deep/x.ts', 'out'), true, '深层子文件')
  eq(isWorkspacePathInDir('outsider.ts', 'out'), false, '同前缀文件')
  eq(isWorkspacePathInDir('out2/x.ts', 'out'), false, '同前缀目录')
})
it('W33 workspaceCopyValue：三种口径（相对 / 容器绝对 / 名称），文件与目录同款', () => {
  eq(WORKSPACE_CONTAINER_ROOT, '/work', '容器内挂载点（与 agent 看到的一致）')
  eq(workspaceCopyValue('relative', 'a/b/c.ts'), 'a/b/c.ts', '相对路径')
  eq(workspaceCopyValue('absolute', 'a/b/c.ts'), '/work/a/b/c.ts', '绝对路径 = 容器内 /work/…')
  eq(workspaceCopyValue('name', 'a/b/c.ts'), 'c.ts', '名称 = 末段')
  eq(workspaceCopyValue('relative', 'a/b'), 'a/b', '目录：相对路径就是目录本身')
  eq(workspaceCopyValue('absolute', 'a/b'), '/work/a/b', '目录：绝对路径同样拼 /work')
  eq(workspaceCopyValue('name', 'a/b'), 'b', '目录：名称 = 末段目录名')
})
it('W34 copy 项与 workspaceCopyValue 一一对应（菜单文案不会与复制内容错位）', () => {
  eq(WORKSPACE_COPY_ITEM_KEYS.map((item) => item.key).join(','), 'relative,absolute,name', '三种口径、固定顺序')
  const items = workspaceCopyItems(ZH)
  eq(items[1].label, '绝对路径（/work）', '绝对路径那条把 /work 写进文案（用户一眼知道复制的是什么）')
  for (const item of WORKSPACE_COPY_ITEM_KEYS) {
    assert(workspaceCopyValue(item.key, 'x/y.ts') !== '', `口径 ${item.key} 必须有可复制的内容`)
  }
})
it('W35 workspaceGitChipLabel / Title：分支直显、detached 标出来、读不到说未知（不猜）', () => {
  eq(workspaceGitChipLabel({ branch: 'master', detached: false }, ZH), 'master', '分支名直显')
  eq(workspaceGitChipLabel({ branch: '9f1c0d2', detached: true }, ZH), 'detached@9f1c0d2', 'detached ⇒ 短 SHA 加前缀')
  eq(workspaceGitChipLabel({ branch: null, detached: false }, ZH), '未知分支', '读不到就说不认识')
  eq(workspaceGitChipTitle({ path: '', branch: 'main', detached: false }, ZH), '工作区根 · 当前分支 main', '根仓库的 title')
  eq(
    workspaceGitChipTitle({ path: 'qatt-platform-qa', branch: '9f1c0d2', detached: true }, ZH),
    'qatt-platform-qa · detached@9f1c0d2（detached HEAD，不在任何分支上）',
    '子目录仓库 + detached 的 title',
  )
})

it('W36 isGitInternalPath：只认 `.git` 那一段，「最近变更」不显示 git 自己的中间产物', () => {
  eq(isGitInternalPath('repo/.git/objects/pack/tmp_pack_EDixtn'), true, 'clone 中途的临时 pack')
  eq(isGitInternalPath('repo/.git/index.lock'), true, 'index.lock')
  eq(isGitInternalPath('repo/.git'), true, '`--separate-git-dir` 那种 `.git` 文件本身')
  eq(isGitInternalPath('.git/HEAD'), true, '根就是仓库')
  eq(isGitInternalPath('repo/Demo/test_case/test_demo1.py'), false, '普通文件')
  eq(isGitInternalPath('.doubulea/memory.md'), false, '隐藏目录不等于 .git（记忆文档不算 git 内部）')
  eq(isGitInternalPath('repo/.github/workflows/ci.yml'), false, '`.github` 是正常目录，不是 `.git`')
})

it('W37 workspaceFileDiffQueryKey：`stats` 必须进 key（否则徽标与弹窗共享缓存 ⇒ 有 +N −M 却点开为空）', () => {
  const badge = workspaceFileDiffQueryKey('c1', 'a.txt', 8, true)
  const modal = workspaceFileDiffQueryKey('c1', 'a.txt', 8, false)
  eq(badge.join('/'), 'workspace-diff/c1/a.txt/8/true/0', '计数查询的 key 带 stats=true、无 toVersion')
  eq(modal.join('/'), 'workspace-diff/c1/a.txt/8/false/0', '全文查询的 key 带 stats=false、无 toVersion')
  assert(badge.join('/') !== modal.join('/'), '两者**不能**同 key —— 同 key 会让弹窗读到只有计数的缓存（lines 缺失）')
  // ★ 2026-10-28（用户定案：同一文件「本轮 / 更早」各一条）：`toVersion` 也必须进 key。
  //   两条路径相同、基线也可能相同，只有"比到哪个版本"不同 ⇒ 少这一段就会读到同一份缓存，
  //   于是「更早」那条点开显示的是「本轮」的差异。
  const earlier = workspaceFileDiffQueryKey('c1', 'a.txt', 8, true, 5)
  eq(earlier.join('/'), 'workspace-diff/c1/a.txt/8/true/5', '「更早」那条带 toVersion')
  assert(earlier.join('/') !== badge.join('/'), '不同 toVersion **不能**同 key —— 否则两条变更共享同一份差异')
})

it('W38 groupWorkspaceChangesByRound：按轮分组（本轮 / 更早），边界取 >=', () => {
  const c = (path, at) => ({ path, type: 'updated', version: 2, actor: 'USER', actorId: null, at })
  const changes = [
    c('a', '2026-10-28T10:05:00.000Z'),
    c('b', '2026-10-28T10:00:00.000Z'),
    c('c', '2026-10-28T09:00:00.000Z'),
  ]
  const g = groupWorkspaceChangesByRound(changes, { start: '2026-10-28T10:00:00.000Z', end: '2026-10-28T10:10:00.000Z' })
  eq(g.current.map((x) => x.path).join(','), 'a,b', '起点那一刻（>=）算本轮；顺序保持不变')
  eq(g.earlier.map((x) => x.path).join(','), 'c', '更早的归「更早」')
  const noRound = groupWorkspaceChangesByRound(changes, undefined)
  eq(noRound.current.length, 0, '没有轮次 ⇒ 不编造空的「本轮」')
  eq(noRound.earlier.length, 3, '没有轮次 ⇒ 全部算「更早」')
  const badStart = groupWorkspaceChangesByRound(changes, { start: 'not-a-date' })
  eq(badStart.earlier.length, 3, '起点解析不了 ⇒ 退化为全部「更早」（不把旧的冒充本轮）')
})

it('W40 mergeWorkspaceChanges：实时保存占「本轮」，被顶掉的那跳降级为「更早」', () => {
  const server = [
    { path: 'f.py', type: 'updated', version: 25, actor: 'USER', actorId: null, at: '2026-10-27T18:31:18.000Z', segment: 'current', beforeVersion: 24 },
  ]
  const live = [{ id: 'e1', type: 'updated', path: 'f.py', version: 26, actor: 'USER', actorId: null, at: '2026-10-28T02:45:00.000Z' }]
  const merged = mergeWorkspaceChanges(server, live)
  // ★ 2026-10-28（用户定案「按次：每次保存各算一轮」）：实时事件 = 最近一次保存 ⇒ 本轮；
  //   原来那条并不是被"覆盖消失"，而是**降级为更早** —— 否则"编辑第二次"就丢了第一次。
  eq(merged.length, 2, '本轮一条 + 更早一条（前一次保存不能凭空消失）')
  eq(merged[0].version, 26, '本轮 = 最近一次保存')
  eq(merged[1].version, 25, '更早 = 上一次保存')
  eq(merged[1].segment, 'earlier', '被顶掉的那条降级为更早')
})

it('W41 同一路径两段各一条（segment 区分），实时事件只更新「本轮」那条', () => {
  const server = [
    // 服务端按轮分段后的两条（同一文件：更早改过、本轮又改过）
    { path: 'f.py', type: 'updated', version: 2, actor: 'AGENT', actorId: null, at: '2026-10-27T10:00:00.000Z', segment: 'earlier', beforeVersion: 1 },
    { path: 'f.py', type: 'updated', version: 5, actor: 'USER', actorId: null, at: '2026-10-28T10:00:00.000Z', segment: 'current', beforeVersion: 3 },
  ]
  const merged = mergeWorkspaceChanges(server, [])
  eq(merged.length, 2, '同一路径两段各一条 —— 不能按路径折叠成一条')
  eq(merged.map((x) => x.segment).join(','), 'current,earlier', '按时间倒序（本轮在前）')
  eq(merged[0].version, 5, '本轮那条的末版本')
  eq(merged[1].version, 2, '更早那条的末版本（不是被本轮覆盖成 5）')

  const live = [{ id: 'e1', type: 'updated', path: 'f.py', version: 6, actor: 'USER', actorId: null, at: '2026-10-28T11:00:00.000Z' }]
  const after = mergeWorkspaceChanges(server, live)
  eq(after.length, 2, '实时事件不新增第三条（仍是本轮一条 + 更早一条）')
  eq(after.filter((x) => x.segment === 'current')[0].version, 6, '实时事件成为新的「本轮」')
  // ★ 「按次」口径：被顶掉的那条（v5）降级并入「更早」，而更早压成一条 ⇒ 取较新那一跳（v5）
  eq(after.filter((x) => x.segment === 'earlier')[0].version, 5, '更早 = 轮前那段的末版本（v5）')
  eq(
    after.filter((x) => x.segment === 'earlier')[0].beforeVersion,
    1,
    '更早的基线仍沿用原更早那条（轮前段起点 v1），不被降级那跳的基线顶掉',
  )

  // 分组以 segment 为准（服务端标的段就是真相，不再按时间猜）
  const g = groupWorkspaceChangesByRound(after, { start: '2026-10-28T09:00:00.000Z' })
  eq(g.current.length, 1, '本轮一条')
  eq(g.earlier.length, 1, '更早一条')
  const noRound = groupWorkspaceChangesByRound(after, undefined)
  eq(noRound.earlier.length, 2, '没有轮次信息时两段都退回「更早」（不编造本轮）')
})

it('W42 mergeWorkspaceChanges：一条实时事件只产生一条，且一定归「本轮」', () => {
  // ★ 2026-10-28（用户定案「按次：每次保存各算一轮」）：实时事件**就是**最近一次保存 ⇒ 天然本轮。
  //   原来按 `round.start`（最后一条用户消息）判段，在按次口径下会把刚保存的错判成「更早」。
  const live = [{ id: 'e1', type: 'updated', path: 'a.py', version: 7, actor: 'USER', actorId: null, at: '2026-10-28T08:00:00.000Z' }]
  const merged = mergeWorkspaceChanges([], live)
  eq(merged.length, 1, '一条实时事件只产生一条（不额外造更早条目）')
  eq(merged[0].segment, 'current', '实时保存 ⇒ current')
  const g = groupWorkspaceChangesByRound(merged, { start: '2026-10-28T10:00:00.000Z' })
  eq(g.current.length, 1, '按 segment 分组：仍在「本轮」')
})

it('W43 workspaceDiffScope：两条（本轮 / 更早）各自的范围，徽标与弹窗同一判据', () => {
  // ★ 2026-10-28（用户定案「按次：每次保存各算一轮」）：**两段用同一判据** ——
  //   基线都是这条变更自己的 `beforeVersion`（这一跳之前那一版）。
  //   本轮**不再**请求 `roundBase`（那是"本轮窗口整体"口径，会把多次保存合并成一条）。
  const earlier = workspaceDiffScope({ version: 3, beforeVersion: 1, segment: 'earlier' })
  eq(earlier.roundBase, false, '更早：不请求本轮基线')
  eq(earlier.baseVersion, 1, '更早：基线 = 该段起点')
  eq(earlier.toVersion, 3, '更早：到版本 = 该段末版本（不是当前内容）')

  const current = workspaceDiffScope({ version: 9, beforeVersion: 7, segment: 'current' })
  eq(current.roundBase, false, '★ 本轮：用自己这一跳的基线，不请求"本轮窗口整体"')
  eq(current.baseVersion, 7, '★ 本轮：基线 = 这一跳之前那一版（v7→v9，不是轮初）')
  eq(current.toVersion, undefined, '本轮：比到当前内容')

  // 段缺省（旧响应）⇒ 按「本轮」口径（它就是"此刻"）
  eq(workspaceDiffScope({ version: 4, beforeVersion: 3 }).baseVersion, 3, '段缺省仍用这条自身的基线')

  // 「更早」新建（那一段开始时文件不存在）
  const earlierNew = workspaceDiffScope({ version: 2, beforeVersion: null, segment: 'earlier' })
  eq(earlierNew.baseVersion, 0, '更早新建：明确传 0（基线不存在），不是退回前一版')
  eq(earlierNew.toVersion, 2, '更早新建：到 v2')

  // 拿不到基线信息时才回退到服务端的本轮窗口口径
  eq(workspaceDiffScope({ version: 5, segment: 'earlier' }).baseVersion, 4, '没有 beforeVersion ⇒ 前一版')
  eq(workspaceDiffScope({ version: 5, segment: 'current' }).roundBase, true, '没有 beforeVersion 的本轮 ⇒ 请求服务端本轮基线')
  // 已删除的条目（version=null）不带 toVersion
  eq(
    workspaceDiffScope({ version: null, segment: 'earlier' }).toVersion,
    undefined,
    '末版本未知（已删除）⇒ 不比到某个版本',
  )
})

it('W39 WORKSPACE_RECENT_MAX_PER_GROUP：每段截断可见（不再静默 8 条）', () => {
  eq(typeof WORKSPACE_RECENT_MAX_PER_GROUP, 'number', '上限是显式常量')
  assert(WORKSPACE_RECENT_MAX_PER_GROUP > 8, '比原来的静默 8 条更宽松（分组后各段独立计数）')
})

it('W44 workspaceChangeGrouping：只有 USER 才算「变更历史」', () => {
  // 2026-10-28 实测修正：真跑过的会话事件常是 SYSTEM（对账 / clone / 引擎写），AGENT 一条都没有 ——
  // 按"有 AGENT 才 rounds"会把它们误判成「变更历史」。
  eq(workspaceChangeGrouping([{ actor: 'USER' }]), 'history', '纯手写 ⇒ 平铺历史')
  eq(workspaceChangeGrouping([{ actor: 'USER' }, { actor: 'SYSTEM' }]), 'rounds', '有 SYSTEM ⇒ 分本轮/更早')
  eq(workspaceChangeGrouping([{ actor: 'USER' }, { actor: 'AGENT' }]), 'rounds', '有 agent ⇒ 分本轮/更早')
  eq(workspaceChangeGrouping([]), 'history', '空清单 ⇒ history')
})

it('W45 retentionDaysLeft：向上取整、过期归零，与 expiresAt 同口径', () => {
  const now = Date.parse('2026-10-28T00:00:00.000Z')
  eq(retentionDaysLeft('2026-10-30T00:00:00.000Z', now), 2, '整 2 天')
  eq(retentionDaysLeft('2026-10-30T01:00:00.000Z', now), 3, '不满 3 天 ⇒ 向上取整为 3（提前一天提醒）')
  eq(retentionDaysLeft('2026-10-28T00:00:00.000Z', now), 0, '正好到期 ⇒ 0')
  eq(retentionDaysLeft('2026-10-01T00:00:00.000Z', now), 0, '已过期 ⇒ 0（不给负数）')
  eq(retentionDaysLeft('not-a-date', now), 0, '解析不了 ⇒ 0（不编造）')
  assert(WORKSPACE_RETENTION_NOTICE_DAYS >= 1, '提示阈值至少提前 1 天')
})

console.log('')
console.log(`verify-workspace-ui：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)