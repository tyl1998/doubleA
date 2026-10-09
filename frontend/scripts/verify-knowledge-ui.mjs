#!/usr/bin/env node
/**
 * verify-knowledge-ui.mjs —— 知识库页面前端**无依赖**验收（P0-1-35）
 *
 * 跑法：`pnpm verify:knowledge-ui`
 *      （= `node --import tsx frontend/scripts/verify-knowledge-ui.mjs`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一档一条依赖都不需要（不起 PG / Redis / 后端 / 浏览器）
 * ─────────────────────────────────────────────────────────────────────
 * 本批的风险集中在几处**错了不会报错、只会看到一句假话或一个点不动的按钮**的地方：
 *   · **上传前的拦截**：`.doc` / 多选 / 空文件如果没被拦下，症状是"服务端返回 400 或 413"，
 *     而用户看到的只是一句不好照做的报错；拦错了（比如把 `.md` 也拦了）则表现为"我明明选对格式了"；
 *   · **文档状态三态与行内操作**：`READY` 的文档给「重试」必然 409、`PARSING` 的文档不给「重试」
 *     就把"worker 卡住"这个唯一的恢复入口藏了起来 —— 两种都不会报错，只会让人以为"页面坏了"；
 *   · **轮询的终止条件**：缺了它页面会**永远每 2s 打一次后端**（开着过夜也一样），
 *     而界面上完全看不出异常；
 *   · **请求体的三态**：`PATCH` 多带一个 `description: null` 会把用户的描述**悄悄清空**；
 *   · **两个数字的口径**：`vectorScore` 的 `null` 与 `0`、`rrfScore` 与相似度的小数位 ——
 *     显示错了只是"看起来都对"，却让人读出相反的结论。
 * 这些全是纯函数或"可注入依赖的判据"，所以本档直接喂字面量、手写夹具，逐条断言最终形状
 * ——本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法（对照 `verify-chat-sse`）。
 *
 * ⚠️ 本档**验不了**的东西（别把它当全批验收）：
 *   · React 渲染与交互（表格长什么样、弹窗能不能关、抽屉里的条数对不对）⇒ 归浏览器端测
 *     （`README`「浏览器端测 · 知识库」）；
 *   · 真后端（上传的 400/413 文案、`reupload` 的 `unchanged` 语义、检索的分数与名次）
 *     ⇒ 归 `pnpm verify:documents` / `verify:knowledge-bases` / `verify:retrieval`；
 *   · 打包后的行为（本档跑的是**源码**，不经 vite）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一处必要的手段：让 `api/client.ts` 能在 node 里被导入（只为验文件名解析）
 * ─────────────────────────────────────────────────────────────────────
 * `api/client.ts` 有一行 `import.meta.env.VITE_API_BASE_URL` —— Vite 在构建期注入，
 * node 里它是 `undefined`。处置与 `verify-chat-sse` **完全一致**：注册一个只作用于那一个
 * 文件的加载器钩子，把 `import.meta.env` 文本替换成 `({})`。不改生产代码。
 *
 * 断言脚手架与 `verify-chat-sse.mjs` 同款，**刻意各留一份**：验收脚本要能被单独拷出来跑
 * （共用 `_harness.mjs` 会让"跑这一档"变成"跑得动整个 scripts 目录"）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

const VITE_ENV_SHIM = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (url.endsWith('/api/client.ts') && result.source != null) {
    const source =
      typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: source.split('import.meta.env').join('({})'), shortCircuit: true }
  }
  return result
}
`
register(`data:text/javascript,${encodeURIComponent(VITE_ENV_SHIM)}`, import.meta.url)

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

/** 深比较**先规范化键序**再比（经 jsonb 往返的值键序会被 PG 重排，直比会出**假红**） */
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

const {
  UPLOAD_EXTENSIONS,
  LEGACY_DOC_EXTENSION,
  LEGACY_DOC_HINT,
  DOCUMENT_PARSING_HINT,
  REUPLOAD_UNCHANGED_HINT,
  isDocumentSearchable,
  DEFAULT_RETRIEVAL_CONFIG,
} = await import('@doubulea/shared')

const {
  UPLOAD_ACCEPT_ATTRIBUTE,
  extensionOf,
  screenPickedFiles,
  screenLegacyDocContent,
  sniffLegacyDocHead,
  documentExtensionLabel,
  DOCUMENT_STATUS_META,
  chunkCountText,
  CHUNK_COUNT_PLACEHOLDER,
  documentActions,
  DOCUMENT_POLL_INTERVAL_MS,
  shouldPollDocuments,
  documentRefetchInterval,
  RETRIEVAL_MODE_LABEL,
  SPLIT_STRATEGY_LABEL,
  describeRetrieval,
  describeChunking,
  embeddingChangedNotice,
  similarityText,
  rrfScoreText,
  rankText,
  hitSourceText,
  chunkLocationText,
  chunkLengthText,
  searchNotice,
  buildCreateBody,
  buildKnowledgeUpdateBody,
  buildRetrievalPatch,
  retrievalValuesOf,
  editValuesOf,
  validateChunking,
  summarizeDocuments,
  EMPTY_KNOWLEDGE_FORM_VALUES,
} = await import('../src/pages/knowledge/knowledgeModel.ts')

const { fileNameFromContentDisposition } = await import('../src/api/client.ts')

// ───────────────────────────── 夹具 ─────────────────────────────

/** 一个知识库（字段不全时用 `DEFAULT_RETRIEVAL_CONFIG` 补齐，形状与 `shared` 的投影一致） */
function makeKb(overrides = {}) {
  return {
    id: 'kb-1',
    name: '运维手册',
    description: '值班同学用的手册',
    embeddingModel: 'api:bge-m3',
    embeddingModelId: 'model-1',
    embeddingDim: 1024,
    embeddingModelChanged: false,
    captionModelId: null,
    captionModelName: null,
    chunkSize: 512,
    chunkOverlap: 64,
    retrievalConfig: { ...DEFAULT_RETRIEVAL_CONFIG },
    documentCount: 4,
    agentCount: 2,
    createdAt: '2026-09-20T06:12:00.000Z',
    updatedAt: '2026-09-22T09:38:00.000Z',
    ...overrides,
  }
}

function makeDoc(status, overrides = {}) {
  return {
    id: 'doc-1',
    kbId: 'kb-1',
    fileName: '运维手册-v3.md',
    status,
    chunkCount: status === 'READY' ? 128 : 0,
    errorMsg: status === 'FAILED' ? '未抽取到文本（疑似扫描件）' : null,
    createdAt: '2026-09-20T06:12:00.000Z',
    updatedAt: '2026-09-20T06:14:00.000Z',
    ...overrides,
  }
}

/** 一个文件（`File` 的 `name`/`size` 子集） */
function file(name, size = 1024) {
  return { name, size }
}

// ───────────────────────────── A 上传白名单与发送前拦截 ─────────────────────────────

groupStart('A', '上传白名单与发送前拦截（`.doc` 按内容判 / 多选 / 空文件都在发请求前拦下）')

await it('A1 `accept` 里**同时**含四个白名单扩展名与 `.doc`（`.doc` 是故意的）', () => {
  for (const extension of UPLOAD_EXTENSIONS) {
    assertIncludes(UPLOAD_ACCEPT_ATTRIBUTE, `.${extension}`, `accept 应含 .${extension}`)
  }
  // 这一条是"看着像 bug"的那条：把 .doc 从 accept 里删掉，验收原文要求的
  // "选 .doc 立即提示且不发请求"就永远无法触发（系统选择器会把它过滤掉）
  assertIncludes(UPLOAD_ACCEPT_ATTRIBUTE, `.${LEGACY_DOC_EXTENSION}`, 'accept 必须含 .doc（否则提示永远不出现）')
  assertEqual(
    UPLOAD_ACCEPT_ATTRIBUTE,
    [...UPLOAD_EXTENSIONS, LEGACY_DOC_EXTENSION].map((extension) => `.${extension}`).join(','),
    'accept 的顺序与取值都必须由 `UPLOAD_EXTENSIONS` 派生（不在两处各写一遍）',
  )
})

await it('A2 `.pdf` / `.DOC`（大写）/ `运维手册-v3.md` 都能被接受', () => {
  assertEqual(screenPickedFiles([file('a.pdf')]).kind, 'accept', 'pdf')
  assertEqual(screenPickedFiles([file('A.DOCX')]).kind, 'accept', '大写扩展名（extensionOf 一律小写）')
  assertEqual(screenPickedFiles([file('运维手册-v3.md')]).kind, 'accept', '中文名 + md')
  assertEqual(screenPickedFiles([file('归档.tar.gz')]).kind, 'reject', '最后一个点决定扩展名（gz 不在白名单）')
})

await it('A3 `.doc` 不再只看扩展名：读文件头判内容（P1-12）', () => {
  // 看扩展名这一层：`.doc` 放行（内容判定在下一层 —— 见 A3b）
  assertEqual(screenPickedFiles([file('复盘-0908.doc')]).kind, 'accept', '`.doc` 在扩展名层放行')

  // 内容层：HTML / MHTML → 放行；OLE2 / RTF / 其它 → 拦下并带上可操作的下一步
  const html = new TextEncoder().encode('<!doctype html><html><body><p>x</p></body></html>')
  assertEqual(sniffLegacyDocHead(html), 'html', '裸 HTML → html')
  assertEqual(screenLegacyDocContent('a.doc', html).kind, 'accept', 'HTML 导出件放行')

  const mhtml = new TextEncoder().encode(
    'Subject: Exported From Confluence\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\n',
  )
  assertEqual(sniffLegacyDocHead(mhtml), 'mhtml', 'MIME 头 → mhtml')
  assertEqual(screenLegacyDocContent('a.doc', mhtml).kind, 'accept', 'MHTML 导出件放行')

  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
  assertEqual(sniffLegacyDocHead(ole2), 'ole2', 'OLE2 魔数 → ole2')
  const ole2Result = screenLegacyDocContent('复盘-0908.doc', ole2)
  assertEqual(ole2Result.kind, 'reject', '真 OLE2 必须拦下')
  assertEqual(ole2Result.code, 'LEGACY_DOC', 'code 必须是独立的一类（不能并进 UNSUPPORTED）')
  assertIncludes(ole2Result.hint ?? '', LEGACY_DOC_HINT, 'hint 必须是 shared 那句"请另存为 .docx 后重传"')
  assertIncludes(ole2Result.message, '复盘-0908.doc', '文案要指出是哪个文件')

  const rtf = new TextEncoder().encode('{\\rtf1\\ansi 旧版}')
  assertEqual(sniffLegacyDocHead(rtf), 'rtf', 'RTF → rtf')
  assertEqual(screenLegacyDocContent('a.doc', rtf).kind, 'reject', 'RTF 必须拦下')
  assertEqual(sniffLegacyDocHead(new Uint8Array([1, 2, 3, 4, 5])), 'other', '随机字节 → other')
})

await it('A4 缺扩展名 / 不在白名单：两条不同的文案（不要合成一句）', () => {
  const noExtension = screenPickedFiles([file('备份')])
  assertEqual(noExtension.code, 'UNSUPPORTED', '缺扩展名归 UNSUPPORTED')
  assertIncludes(noExtension.message, '缺少扩展名', '缺扩展名要有专门的措辞')

  const unsupported = screenPickedFiles([file('a.exe')])
  assertEqual(unsupported.code, 'UNSUPPORTED', '不支持的类型')
  assertIncludes(unsupported.message, '.exe', '要点出到底是哪个扩展名')
  // `.gitignore` 这类"点在开头"的名字不算有扩展名（与后端 `extensionOf` 同规则）
  assertEqual(extensionOf('.gitignore'), null, '点在开头 = 没有扩展名')
  assertEqual(extensionOf('a.'), null, '点在结尾 = 没有扩展名')
})

await it('A5 多选被拒（不是"悄悄取第一个"）', () => {
  const result = screenPickedFiles([file('a.md'), file('b.pdf')])
  assertEqual(result.kind, 'reject', 'kind')
  assertEqual(result.code, 'MULTIPLE', 'code')
  assertIncludes(result.message, '2', '文案要说清选中了几个')
  // ⚠️ 反向的一条：**单文件**必须能过（否则上面那条断了会让整个上传功能失效）
  assertEqual(screenPickedFiles([file('a.md')]).kind, 'accept', '单文件必须放行')
})

await it('A6 没选文件 / 0 字节文件', () => {
  assertEqual(screenPickedFiles([]).code, 'NO_FILE', '空列表')
  assertEqual(screenPickedFiles([file('a.md', 0)]).code, 'EMPTY', '0 字节（后端也会 400，前端先拦省一次往返）')
  assertEqual(screenPickedFiles([file('a.md', 1)]).kind, 'accept', '1 字节是合法的')
})

await it('A7 表格副标题用的扩展名：识别不出时给 `—`，不编一个格式', () => {
  assertEqual(documentExtensionLabel('运维手册-v3.MD'), 'md', '大写要归一')
  assertEqual(documentExtensionLabel('网络拓扑.txt'), 'txt', '常规')
  assertEqual(documentExtensionLabel('没有扩展名'), '—', '认不出就不猜')
})

// ───────────────────────────── B 文档状态展示 ─────────────────────────────

groupStart('B', '文档状态三态（`PARSING` / `READY` / `FAILED` 各有各的读数）')

await it('B1 三态各有颜色，且 `READY` 的绿与 `isDocumentSearchable` **同源**', () => {
  assertEqual(DOCUMENT_STATUS_META.PARSING.led, 'run', 'PARSING = accent 灯')
  assertEqual(DOCUMENT_STATUS_META.READY.led, 'ok', 'READY = 绿')
  assertEqual(DOCUMENT_STATUS_META.FAILED.led, 'fail', 'FAILED = 红')
  for (const status of ['PARSING', 'READY', 'FAILED']) {
    assertEqual(
      DOCUMENT_STATUS_META[status].led === 'ok',
      isDocumentSearchable(status),
      `${status}："灯是绿的"必须与"可检索"逐字等价（判据在 shared，不在界面里重写）`,
    )
  }
})

await it('B2 `PARSING` 的说明文案来自 `shared`（"暂不参与检索"那句）', () => {
  assertEqual(DOCUMENT_STATUS_META.PARSING.hint, DOCUMENT_PARSING_HINT, '必须是同一个常量（前后端共用一句）')
  assertIncludes(DOCUMENT_PARSING_HINT, '暂不参与检索', '这句话是"传完搜不到"的唯一解释')
  assertEqual(DOCUMENT_STATUS_META.READY.hint, null, 'READY 不需要额外说明')
  assertEqual(DOCUMENT_STATUS_META.FAILED.hint, null, 'FAILED 的原因来自 errorMsg（每篇都不同）')
})

await it('B3 片段数：非 `READY` 显示 `—` 而不是 0', () => {
  assertEqual(chunkCountText(makeDoc('READY')), '128', 'READY 显示真数')
  assertEqual(chunkCountText(makeDoc('PARSING')), '—', 'PARSING 的 chunkCount 恒为 0，显示 0 会被读成"没有片段"')
  assertEqual(chunkCountText(makeDoc('FAILED')), '—', 'FAILED 同理')
  assertEqual(chunkCountText(makeDoc('READY', { chunkCount: 0 })), '0', 'READY 且真的是 0 时照实显示 0')
  assert(CHUNK_COUNT_PLACEHOLDER !== '0', '占位符不能与"真的 0"撞在一起')
})

// ───────────────────────────── C 行内操作可见性 ─────────────────────────────

groupStart('C', '行内操作可见性矩阵（点得动 / 点了必然失败 / 唯一的恢复入口）')

await it('C1 `PARSING`：下载 ✅ / 覆盖重传 ❌ / 重试 ✅ / 查看片段 ❌ / 删除 ✅', () => {
  const actions = documentActions('PARSING')
  assertEqual(actions.canDownload, true, '文件在上传成功时就已经在对象存储里了')
  assertEqual(actions.canReupload, false, '解析中不给"换内容"（避免两条流水线抢同一行）')
  assertEqual(actions.canRetry, true, '⚠️ 这是"worker 卡住"时**唯一**的恢复入口，后端刻意放行')
  assertEqual(actions.canPreviewChunks, false, '还没入库 ⇒ 没有块可看（chunkCount 恒为 0）')
  assertEqual(actions.canDelete, true, '后端不按状态拦删除，界面也不额外拦')
})

await it('C2 `READY`：**不给**重试（后端会 409）；**给**查看片段', () => {
  const actions = documentActions('READY')
  assertEqual(actions.canRetry, false, '没有东西可重试 —— 摆一个必然失败的按钮比不摆更糟')
  assertEqual(actions.canReupload, true, '已完成的文档正是"覆盖重传"的主要用户')
  assertEqual(actions.canPreviewChunks, true, 'READY ⟺ 库里有带向量的块 ⇒ 有内容可预览')
  assertEqual(actions.canDownload, true, '下载')
  assertEqual(actions.canDelete, true, '删除')
})

await it('C3 `FAILED`：除「查看片段」外其余操作都在', () => {
  const actions = documentActions('FAILED')
  assertEqual(actions.canDownload, true, '下载')
  assertEqual(actions.canReupload, true, '覆盖重传')
  assertEqual(actions.canRetry, true, '重试（这是它最常见的用法）')
  assertEqual(actions.canPreviewChunks, false, '失败 ⇒ 没有可用块，打开只会是空抽屉')
  assertEqual(actions.canDelete, true, '删除')
})

await it('C3b 「查看片段」的可见性与 `isDocumentSearchable` **同源**（不写字面量比较）', () => {
  for (const status of ['PARSING', 'READY', 'FAILED']) {
    assertEqual(
      documentActions(status).canPreviewChunks,
      isDocumentSearchable(status),
      `${status}：能否查看片段必须与"是否可检索"逐字等价（判据在 shared）`,
    )
  }
})

await it('C4 两种状态下的「重试」说明**不是同一句**', () => {
  const parsing = documentActions('PARSING').retryHint
  const failed = documentActions('FAILED').retryHint
  assert(parsing !== failed, '同句会让"解析中"那个按钮看起来像"重试一个失败的东西"')
  assertIncludes(parsing, '解析中', '解析中那条要说明"卡住时可以重来"')
})

// ───────────────────────────── D 状态轮询 ─────────────────────────────

groupStart('D', '状态轮询的**触发**与**终止**条件')

await it('D1 本页有 `PARSING` ⇒ 轮询；全部终态 ⇒ 停止', () => {
  assertEqual(documentRefetchInterval([makeDoc('READY'), makeDoc('FAILED')]), false, '全终态必须停（否则永远每 2s 打后端）')
  assertEqual(documentRefetchInterval([makeDoc('READY'), makeDoc('PARSING')]), DOCUMENT_POLL_INTERVAL_MS, '有解析中就轮询')
  assertEqual(documentRefetchInterval([]), false, '空列表不轮询')
  assertEqual(documentRefetchInterval(undefined), false, '首屏还没取到数据时不轮询（首次加载由 useQuery 自己发）')
})

await it('D2 间隔常量就是 2s，且返回值与它同源', () => {
  assertEqual(DOCUMENT_POLL_INTERVAL_MS, 2000, '`06` §七 待决事项 5 定案：2s 间隔（600px 的表尾提示也读它）')
  assertEqual(
    documentRefetchInterval([makeDoc('PARSING')]),
    DOCUMENT_POLL_INTERVAL_MS,
    '返回的间隔必须就是那个常量（两处各写一个数字迟早对不上）',
  )
  assertEqual(shouldPollDocuments([makeDoc('PARSING')]), true, '判据本身')
  assertEqual(shouldPollDocuments(undefined), false, 'judgement on undefined')
})

// ───────────────────────────── E 建库 / 改库的请求体 ─────────────────────────────

groupStart('E', '建库 / 改库的请求体（三态 + 局部合并 + "没改就不发"）')

await it('E1 建库：分块参数**留空 = 不带这两个键**（服务端用环境默认值快照）', () => {
  const body = buildCreateBody({ ...EMPTY_KNOWLEDGE_FORM_VALUES, name: ' 运维手册 ' })
  assertDeepEqual(body, { name: '运维手册', embeddingModelId: '' }, '留空时请求体里不能出现 chunkSize / chunkOverlap')
  assertExcludes(canonical(body), 'chunkSize', '不带 chunkSize')
  // ⚠️ 反向：填了就必须带上（否则用户以为设了，实际是默认值）
  const filled = buildCreateBody({ name: 'x', embeddingModelId: 'model-1', description: '', chunkSize: 256, chunkOverlap: 32 })
  assertDeepEqual(filled, { name: 'x', embeddingModelId: 'model-1', chunkSize: 256, chunkOverlap: 32 }, '填了才带')
})

await it('E2 建库：描述留空 ⇒ 不带该键（而不是 `description: null`）', () => {
  assertExcludes(canonical(buildCreateBody({ name: 'x', embeddingModelId: 'model-1', description: '   ', chunkSize: null, chunkOverlap: null })), 'description')
  assertIncludes(canonical(buildCreateBody({ name: 'x', embeddingModelId: 'model-1', description: '值班手册', chunkSize: null, chunkOverlap: null })), '值班手册')
})

await it('E3 改库：没有任何改动 ⇒ `null`（调用方据此不发请求）', () => {
  const kb = makeKb()
  assertEqual(buildKnowledgeUpdateBody(kb, editValuesOf(kb)), null, '一个字段都没动时不该发 PATCH')
  // 反向：只把描述末尾多打一个空格（schema 会 trim）也不该算改动
  assertEqual(
    buildKnowledgeUpdateBody(kb, { ...editValuesOf(kb), description: `  ${kb.description}  ` }),
    null,
    'trim 后相同不算改动',
  )
})

await it('E4 改库：只改名字 ⇒ 请求体里**只有** name（三态：不带 ≠ 清空）', () => {
  const kb = makeKb()
  const body = buildKnowledgeUpdateBody(kb, { ...editValuesOf(kb), name: '运维手册 v2' })
  assertDeepEqual(body, { name: '运维手册 v2' }, '只能有 name')
  assertExcludes(canonical(body), 'description', '⚠️ 顺手带上 description 会把用户的描述清掉（最坏的一种）')
})

await it('E5 改库：把描述清空 ⇒ 提交 `description: null`（这是三态里唯一能表达"清空"的写法）', () => {
  const kb = makeKb()
  const body = buildKnowledgeUpdateBody(kb, { ...editValuesOf(kb), description: '   ' })
  assertDeepEqual(body, { description: null }, '空串要归一成 null，并且是唯一的键')
})

await it('E6 改库：只有分块参数变了才带上它们', () => {
  const kb = makeKb()
  assertDeepEqual(
    buildKnowledgeUpdateBody(kb, { ...editValuesOf(kb), chunkSize: 800, chunkOverlap: 64 }),
    { chunkSize: 800 },
    '只带变了的那个',
  )
})

await it('E6b 图片描述模型（P1-11）三态：不带 = 不动 / 空串 = 清空 / 选新值 = 设值', () => {
  // 原本没有 → 用户也没选 ⇒ 不动（不发 captionModelId）
  assertEqual(buildKnowledgeUpdateBody(makeKb(), editValuesOf(makeKb())), null, '都没动 ⇒ null')
  // 原本有 → 用户清空 ⇒ 提交 `captionModelId: null`
  const withCaption = makeKb({ captionModelId: 'cap-1', captionModelName: '读图模型' })
  assertDeepEqual(
    buildKnowledgeUpdateBody(withCaption, { ...editValuesOf(withCaption), captionModelId: '' }),
    { captionModelId: null },
    '清空要提交 null',
  )
  // 原本有 → 换一个 ⇒ 提交新值
  assertDeepEqual(
    buildKnowledgeUpdateBody(withCaption, { ...editValuesOf(withCaption), captionModelId: 'cap-2' }),
    { captionModelId: 'cap-2' },
    '换模型只带 captionModelId',
  )
  // 建库：留空 ⇒ 不带该键
  assertExcludes(canonical(buildCreateBody({ ...EMPTY_KNOWLEDGE_FORM_VALUES, name: 'x', embeddingModelId: 'm' })), 'captionModelId')
  assertIncludes(canonical(buildCreateBody({ ...EMPTY_KNOWLEDGE_FORM_VALUES, name: 'x', embeddingModelId: 'm', captionModelId: 'cap-1' })), 'captionModelId')
})

await it('E7 检索配置：逐键比较，没改就不发', () => {
  const kb = makeKb()
  assertEqual(buildRetrievalPatch(kb, retrievalValuesOf(kb)), null, '全都没改 ⇒ null')
  assertDeepEqual(buildRetrievalPatch(kb, { ...retrievalValuesOf(kb), topK: 20 }), { retrievalConfig: { topK: 20 } }, '只带变了的键')
})

await it('E8 检索配置：只改一个权重时，`weights` **两个键都要带**（schema 要求成对）', () => {
  const kb = makeKb()
  const patch = buildRetrievalPatch(kb, { ...retrievalValuesOf(kb), fulltextWeight: 2 })
  assertDeepEqual(
    patch,
    { retrievalConfig: { weights: { vector: 1, fulltext: 2 } } },
    'weights 必须成对出现，且另一个键取当前值',
  )
})

await it('E9 `chunkOverlap >= chunkSize` 在前端就拦下（文案里带两个数字）', () => {
  assertEqual(validateChunking(512, 64), null, '合法')
  assertEqual(validateChunking(512, 511), null, '刚好小于 = 合法')
  const message = validateChunking(512, 512)
  assert(message !== null && message.includes('512'), '相等要拦（分块无法前进）')
  assertIncludes(validateChunking(512, 600) ?? '', '600', '文案要点出实际值')
})

// ───────────────────────────── F 检索结果的显示口径 ─────────────────────────────

groupStart('F', '检索测试结果：`null` 与 `0`、两个量级的小数位、来源列')

await it('F1 未命中一路显示 `—`，而"分数恰好是 0"要显示 `0`', () => {
  assertEqual(similarityText(null), '—', 'null = 这一路没命中（不是"算了但很低"）')
  assertEqual(similarityText(0), '0.00', '0 是**真的算过**且相似度为 0（正交向量就是这种情况）')
  assert(similarityText(null) !== similarityText(0), '两者必须显示得不一样')
  assertEqual(similarityText(0.876), '0.88', '两位小数')
})

await it('F2 RRF 融合分用四位小数（两位会把一屏结果全显示成 0.03）', () => {
  assertEqual(rrfScoreText(0.032), '0.0320', '`子方案①` §6-2 的示例数值量级')
  assert(similarityText(0.032) === '0.03', '同一数值用相似度格式会丢掉区分度 —— 所以两套格式不能合并')
  assert(rrfScoreText(0.032) !== similarityText(0.032), '两种口径必须不同')
})

await it('F3 名次：`#1` / 未命中时 `—`', () => {
  assertEqual(rankText(1), '#1', '从 1 开始')
  assertEqual(rankText(12), '#12', '两位数')
  assertEqual(rankText(null), '—', '这一路没命中')
})

await it('F4 来源列：有页码给页码，否则给块号（**不拿"命中库"充数**）', () => {
  assertIncludes(hitSourceText({ docName: '变更记录.pdf', page: 12, seq: 3 }), '第 12 页', 'PDF 有页码')
  assertIncludes(hitSourceText({ docName: '网络拓扑.txt', page: null, seq: 7 }), '块 #7', '非 PDF 没有页码 ⇒ 退到块号')
  for (const hit of [
    { docName: 'a.md', page: 1, seq: 0 },
    { docName: 'a.md', page: null, seq: 0 },
  ]) {
    assertIncludes(hitSourceText(hit), 'a.md', '文档名必须出现（这一列唯一稳定的信息来源）')
  }
})

await it('F5 横幅：向量路被跳过时**引用服务端那句话**（不重写）', () => {
  const reason = '该知识库使用的 embedding 模型已变更，向量路已跳过（该库需重建后才能参与向量检索）'
  const notice = searchNotice({ items: [{}, {}], vectorPathSkipped: true, warnings: [reason] })
  assert(notice !== null && notice.tone === 'warn', '必须是警告档')
  assertIncludes(notice.text, reason, '原因文案要逐字用服务端给的（前端重拼会变成第三种说法）')

  // 没有 warning 时也要说一句（不能静默）
  const bare = searchNotice({ items: [], vectorPathSkipped: true, warnings: [] })
  assert(bare !== null && bare.text.includes('向量路'), '拿不到原因时至少说清"这次没走向量路"')
})

await it('F6 横幅：一条都没命中时说清是"库里没有"，不是"页面坏了"', () => {
  const notice = searchNotice({ items: [], vectorPathSkipped: false, warnings: [] })
  assert(notice !== null && notice.tone === 'info', '这是"正常但空"的信息，不是警告')
  assertIncludes(notice.text, '没有命中', '文案')
  // 反向：有结果时不显示任何横幅（别让一句无信息量的提示长期占着版面）
  assertEqual(searchNotice({ items: [{}, {}], vectorPathSkipped: false, warnings: [] }), null, '有命中就不显示横幅')
})

// ───────────────────────────── G 展示口径 ─────────────────────────────

groupStart('G', '展示口径（检索摘要 / embedding 三态 / 删除确认 / 本页统计）')

await it('G1 检索摘要必须带 `rrfK`（只报融合分等于不可解释）', () => {
  const text = describeRetrieval(DEFAULT_RETRIEVAL_CONFIG)
  assertIncludes(text, RETRIEVAL_MODE_LABEL[DEFAULT_RETRIEVAL_CONFIG.mode], '模式用中文标签')
  assertIncludes(text, `topK ${DEFAULT_RETRIEVAL_CONFIG.topK}`, 'topK')
  assertIncludes(text, `k=${DEFAULT_RETRIEVAL_CONFIG.rrfK}`, 'RRF 常数（`06` P0-1-20 的坑预判之一）')
  assertIncludes(text, String(DEFAULT_RETRIEVAL_CONFIG.score), '相似度下限')
})

await it('G2 分块摘要是"字符"口径，并带上分块策略', () => {
  const kb = makeKb({ chunkSize: 256, chunkOverlap: 32 })
  const text = describeChunking(kb)
  assertIncludes(text, '256', 'chunkSize')
  assertIncludes(text, '32', 'chunkOverlap')
  assertIncludes(text, SPLIT_STRATEGY_LABEL[kb.retrievalConfig.splitStrategy], '策略标签')
  assertIncludes(text, '字', '单位是字符/码点（不是 token）')
})

await it('G3 embedding 三态：`true`（需重建）与 `null`（判断不了）**分开报**', () => {
  const changed = embeddingChangedNotice(true)
  assert(changed !== null && changed.tone === 'warn', '需重建 = 警告')
  assertIncludes(changed.text, '重建', '文案要指向"重建这个库"这个动作')

  const unknown = embeddingChangedNotice(null)
  assert(unknown !== null && unknown.tone === 'info', '判断不了 = 信息（不是警告：用户此刻做不了任何事）')
  assertIncludes(unknown.text, '未就绪', '要指向"服务端 embedding 未就绪"这个真正的原因')

  assertEqual(embeddingChangedNotice(false), null, '一切正常时不显示任何提示')
})

await it('G4 本页统计：三态各计各的，总数等于条目数', () => {
  const summary = summarizeDocuments([makeDoc('READY'), makeDoc('READY'), makeDoc('PARSING'), makeDoc('FAILED')])
  assertDeepEqual(summary, { total: 4, readable: 2, parsing: 1, failed: 1 }, '分布')
  assertDeepEqual(summarizeDocuments([]), { total: 0, readable: 0, parsing: 0, failed: 0 }, '空列表')
  assertEqual(
    summary.readable + summary.parsing + summary.failed,
    summary.total,
    '三个分类之和必须等于 total（漏一类会让"本页 N 篇"对不上）',
  )
})

await it('G5 删除弹窗不再逐字确认、也不因"被智能体绑定"而禁用删除（改为提示 + 自动解绑）', () => {
  const modal = stripComments(
    readFileSync(fileURLToPath(new URL('../src/pages/knowledge/DeleteKnowledgeBaseModal.tsx', import.meta.url)), 'utf8'),
  )
  assertExcludes(modal, 'isKnowledgeDeleteConfirmed', '不再逐字确认')
  assertExcludes(modal, 'app/confirm.js', '不再 import 已删除的 confirm 模块')
  // 2026-10-08：被引用不再 409 —— 后端删库时自动解绑，前端只提示、不禁用按钮
  assertExcludes(modal, 'disabled: bound', '不再因被绑定而禁用删除按钮')
  assertExcludes(modal, '409', '不再宣称"后端会拒绝（409）"')
  assertIncludes(modal, 'unboundAgents', '成功提示带上"解绑了几个智能体"')
  assertIncludes(modal, '会自动解除这些智能体的绑定', '被引用时给出"自动解绑"的说明')
})

await it('G6 覆盖重建"内容未变化"的提示只有一处写法（shared 常量）', () => {
  assertIncludes(REUPLOAD_UNCHANGED_HINT, '已跳过', '那句话来自 shared（前后端共用）')
})

// ───────────────────────────── H 源码级守门 ─────────────────────────────

groupStart('H', '源码级守门（几条"没有别的观测面"的正确性）')

/** 读 `frontend/src` 下所有 .ts/.tsx 的源码（去掉注释，避免注释里的示例命中） */
function sourceFiles() {
  const root = new URL('../src/', import.meta.url)
  const base = fileURLToPath(root)
  const names = readdirSync(root, { recursive: true })
    .filter((name) => typeof name === 'string' && /\.(ts|tsx)$/.test(name))
    .map((name) => name.replaceAll('\\', '/'))
  return names.map((name) => ({ name, source: stripComments(readFileSync(`${base}${name}`, 'utf8')) }))
}

await it('H1 `formatUpdatedAt` 的定义全仓**恰好一处**（时间读数不许有两份写法）', () => {
  const definitions = sourceFiles().filter(({ source }) => /function\s+formatUpdatedAt\s*\(/.test(source))
  assertEqual(definitions.length, 1, `定义应恰好一处，实际：${definitions.map((f) => f.name).join(', ')}`)
  assertEqual(definitions[0]?.name, 'app/format.ts', '唯一实现住在 app/format.ts（P0-1-35 从 agentModel 抽出）')
})

await it('H2 上传的字段名引用 `shared` 的常量（不写字面量 `file`）', () => {
  const api = sourceFiles().find(({ name }) => name === 'api/knowledgeBases.ts')
  assert(api !== undefined, '找不到 api/knowledgeBases.ts')
  assertIncludes(api.source, 'formData.append(UPLOAD_FILE_FIELD', '上传/重传都要用同一个共享常量')
  assertExcludes(api.source, "append('file'", '不该出现硬编码的字段名')
  assertEqual((api.source.match(/formData\.append\(UPLOAD_FILE_FIELD/g) ?? []).length, 2, '上传与覆盖重传各一处')
})

await it('H3 轮询判据只有一处来源（api 层调用纯函数，不自己判 `PARSING`）', () => {
  const api = sourceFiles().find(({ name }) => name === 'api/knowledgeBases.ts')
  assertIncludes(api.source, 'refetchInterval: (query) => documentRefetchInterval(', 'useDocuments 必须用纯判据')
  assertIncludes(api.source, 'query.state.data?.items', '判据的输入是当前页条目')
})

await it('H4 上传弹窗：`beforeUpload` 必须 `return false`（否则 AntD 会自己发一次上传）', () => {
  const modal = sourceFiles().find(({ name }) => name === 'pages/knowledge/UploadDocumentModal.tsx')
  assert(modal !== undefined, '找不到上传弹窗')
  assertIncludes(modal.source, 'beforeUpload', '要用 beforeUpload 做发送前拦截')
  assertIncludes(modal.source, 'return false', '必须阻止 AntD 自己的上传动作')
  assertIncludes(modal.source, 'screenPickedFiles(', '拦截判据来自纯函数')
  assertIncludes(modal.source, 'accept={UPLOAD_ACCEPT_ATTRIBUTE}', 'accept 必须用那个（含 .doc 的）常量')
  assertIncludes(modal.source, 'multiple', '必须允许多选才能把"多选"这条错误说出来')
})

await it('H5 详情页把"解析中每 N 秒自动刷新"写在明处（读数来自常量）', () => {
  const page = sourceFiles().find(({ name }) => name === 'pages/knowledge/KnowledgeDetailPage.tsx')
  assert(page !== undefined, '找不到详情页')
  assertIncludes(page.source, 'DOCUMENT_POLL_INTERVAL_MS / 1000', '表尾那句提示的数字要来自常量')
})

// ───────────────────────────── I 下载文件名的解析 ─────────────────────────────

groupStart('I', '下载响应头的文件名（中文名靠 `filename*`，取错了会拿到乱码名）')

await it('I1 `filename*` 优先于 `filename`', () => {
  const header = `attachment; filename="yunwei.md"; filename*=UTF-8''${encodeURIComponent('运维手册.md')}`
  assertEqual(fileNameFromContentDisposition(header), '运维手册.md', '中文名只在 filename* 里')
})

await it('I2 只有 `filename` 时用它（ASCII 回落、也支持不带引号的 token）', () => {
  assertEqual(fileNameFromContentDisposition('attachment; filename="ops.md"'), 'ops.md', '带引号')
  assertEqual(fileNameFromContentDisposition('attachment; filename=ops.md'), 'ops.md', '不带引号')
})

await it('I3 缺头 / 空头 / 畸形头都返回 `null`（不抛错，调用方退回文档自己的 fileName）', () => {
  assertEqual(fileNameFromContentDisposition(null), null, '没有这个头')
  assertEqual(fileNameFromContentDisposition(''), null, '空串')
  assertEqual(fileNameFromContentDisposition('attachment'), null, '只有 disposition 类型')
  // `filename*` 畸形（缺那两个单引号）⇒ 退回 `filename=`
  assertEqual(
    fileNameFromContentDisposition('attachment; filename="a.md"; filename*=UTF-8a%20b'),
    'a.md',
    '畸形时退回回落名，而不是编一个',
  )
})

await it("I4 带语言标签的 `filename*`（UTF-8'zh-CN'…）也能解析", () => {
  const header = `attachment; filename*=UTF-8'zh-CN'${encodeURIComponent('变更记录.pdf')}`
  assertEqual(fileNameFromContentDisposition(header), '变更记录.pdf', 'RFC 5987 三段式')
})

// ───────────────────────────── J 片段预览 ─────────────────────────────

groupStart('J', '片段预览：位置说明按数据有无拼、字数按码点、原文不截断')

await it('J1 位置说明：块号必有；页码/标题层级按有无出现（不出现 `第 — 页`）', () => {
  assertIncludes(chunkLocationText({ seq: 3, page: 12, headingPath: ['第三章', '权限'] }), '块 #3', '块号')
  assertIncludes(chunkLocationText({ seq: 3, page: 12, headingPath: [] }), '第 12 页', 'PDF 有页码')
  assertIncludes(
    chunkLocationText({ seq: 3, page: 12, headingPath: ['第三章', '权限'] }),
    '第三章 / 权限',
    '标题层级用 / 连接',
  )
  const noPage = chunkLocationText({ seq: 0, page: null, headingPath: [] })
  assertExcludes(noPage, '页', '非 PDF 没有页码时不该出现任何"页"字样（不给占位符）')
})

await it('J2 字数用**码点**数（含 emoji 的块不能数出偏移的字数）', () => {
  assertEqual(chunkLengthText('abcd'), '4 字', '常规')
  assertEqual([...'👍👍'].length, 2, '两个 emoji 是两个码点')
  assertEqual(chunkLengthText('👍👍'), '2 字', '不能按 UTF-16 长度算成 4')
  assertIncludes(chunkLengthText('运维手册'), '字', '带单位，避免与"块数"混读')
})

await it('J3 预览抽屉用 `useDocumentChunks`（关着时不发请求）、原文不截断', () => {
  const drawer = sourceFiles().find(({ name }) => name === 'pages/knowledge/ChunkPreviewDrawer.tsx')
  assert(drawer !== undefined, '找不到 ChunkPreviewDrawer.tsx')
  assertIncludes(drawer.source, 'useDocumentChunks(', '数据来自那个 hook')
  assertIncludes(drawer.source, 'key={doc.id}', '换文档要重挂载（分页回到第 1 页），否则第 3 页会套到新文档')
  // ⚠️ 反向：不能复用检索抽屉那个"截三行"的类（预览的价值就是看到完整一块）
  assertExcludes(drawer.source, 'kb-snippet', '预览不能用命中片段的截断样式')
  assertIncludes(drawer.source, 'chunk-content', '整块原文用不截断的样式')
})

await it('J4 表格里「查看片段」按钮受 `actions.canPreviewChunks` 门控（不是无条件渲染）', () => {
  const table = sourceFiles().find(({ name }) => name === 'pages/knowledge/DocumentTable.tsx')
  assert(table !== undefined, '找不到 DocumentTable.tsx')
  assertIncludes(table.source, 'actions.canPreviewChunks', '按钮可见性必须来自 documentActions')
  assertIncludes(table.source, '查看片段', '按钮文案')
})

// ───────────────────────────── 结论表 ─────────────────────────────

console.log(`\n${c.b}── 结论表（` + '`docs/06` P0-1-35 的验收原文逐条）──' + `${c.x}`)
for (const group of groups) {
  const mark = group.failed === 0 ? `${c.g}✅${c.x}` : `${c.r}❌${c.x}`
  console.log(
    `  ${mark} ${group.id} ${group.title}  ${c.d}(${group.passed} 项${group.failed > 0 ? ` / ${group.failed} 项失败` : '全通过'})${c.x}`,
  )
}

console.log(`\n${c.b}── P0-1-35 验收原文四条对应的证据 ──${c.x}`)
console.log(`  ${c.g}①${c.x} 传四格式各 1 → 状态实时流转 ............ A2（四类白名单都放行）+ D1/D2（解析中才轮询、全部终态即停）`)
console.log(`     ${c.y}⚠️${c.x} "真的传上去了、状态真的变了"是后端与浏览器的事 ⇒ 归 ` + '`verify:documents`' + ` 与 ${c.x}`)
console.log(`        ${c.d}浏览器端测（` + '`README`' + ` 的知识库清单）${c.x}`)
console.log(`  ${c.g}②${c.x} 扫描件显示 FAILED + 原因 ............... B1/B3（红 + errorMsg）+ C3（失败行的四个操作）`)
console.log(`  ${c.g}③${c.x} 检索测试能看到双路得分 + 融合排名 ...... F1~F4（` + '`null` 与 `0` 分开、两套小数位、来源列' + `）`)
console.log(`     ${c.y}⚠️${c.x} 分数本身对不对要问后端 ⇒ ` + '`pnpm verify:retrieval`' + `${c.x}`)
console.log(`  ${c.g}④${c.x} 选真 .doc 立即提示且不发请求 ........... A1（accept 故意含 .doc）+ A3（读文件头判内容：HTML/MHTML 放行、OLE2/RTF 拦下 + 可操作提示）`)
console.log(`     ${c.g}+${c.x} "不发请求"由 H4 守着（` + '`beforeUpload` 里 `return false`' + `，判据是纯函数）`)
console.log(`  ${c.g}坑${c.x} 状态轮询（refetchInterval + 终止条件）... D1/D2 + H3（判据只有一处来源）`)

console.log(`\n${c.d}── 本档验不到的（别当全批验收）──`)
console.log(`  · React 渲染与交互（表格 / 弹窗 / 抽屉长什么样，"点得动"）⇒ 浏览器端测（` + '`README`' + `）`)
  console.log(`  · 真后端：上传的 400/413 文案、reupload 的 unchanged、检索的分数与名次、删除的自动解绑` + `⇒ `)
console.log(`    ` + '`pnpm verify:documents`' + ` / ` + '`verify:knowledge-bases`' + ` / ` + '`verify:retrieval`' + `${c.d}`)
console.log(`  · 打包产物：本档跑的是**源码**（` + '`node --import tsx`' + `），不经 vite${c.x}`)

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 知识库页面前端验收通过（P0-1-35）：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 知识库页面前端验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
