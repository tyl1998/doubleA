#!/usr/bin/env node
/**
 * verify-documents.mjs —— P0-1-16 的**文档上传 + 四格式解析 + 前置校验**验收
 *
 * 验的是 `02` §4.6 的上传端点与 `子方案①` §4-1 的四道前置校验、§三 ① 的入库登记，
 * 以及四个解析器（pdf/docx/md/txt）产出的 `text` + `meta`（页码 / 标题路径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 分五组，各自守一件容易做错的事
 * ─────────────────────────────────────────────────────────────────────
 * A 组 **纯函数**：`detectFormat` 的判定矩阵（不需要服务、不占端口）——
 *    "改名绕过"能不能抓住，全看这一组；只做 HTTP 用例会漏掉"某个组合没人试过"。
 * B 组 **HTTP**：同一批校验挂在路由上仍然生效（401/404/400/413/406 各一条）——
 *    纯函数绿而路由没接线，是这类"校验型需求"最常见的假通过。
 * C 组 **模块级解析**：四格式的 `ParseResult` 逐字段断言（页码 / 标题路径 / 编码嗅探）。
 *    ⚠️ 上传端点**刻意不同步解析**（流程见 `document.service.ts` 文件头），
 *    所以"解析对不对"只能在这一组验 —— 想在上传响应里等出 `READY` 是 P0-1-17 起的事。
 * D 组 **落库与存储取证**：`documents` 行（状态/`content_hash`/`file_key` 形状）+ S3 对象
 *    逐字节比对 + 同内容判重（同库命中、跨库不命中）+ 中文文件名 + MEMBER 权限。
 * E 组 **自清理 + 残留复核**：删库走 API，断言 DB 与 S3 两侧都回到基线。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处注入的"小值/特征值"，都是为了让断言有真假之分
 * ─────────────────────────────────────────────────────────────────────
 * · `UPLOAD_BODY_LIMIT=8KB` —— 超限用例（20KB）才有得测；沿用生产默认 100MB 的话
 *   这条只能"假装通过"（或者要造一个 100MB 的文件把脚本拖死）。
 *   取 8KB 而不是 1KB 是因为 **docx 夹具本身 ~2.9KB**，上限必须高于所有正常夹具。
 * · `EMBEDDING_MODE=api` 三项 —— 建库要取 `EmbeddingProvider.name()` 快照
 *   （P0-1-14/15 定案），不注入就建不了库。URL 指向 `127.0.0.1:1`（永不会被访问：
 *   上传不触发 embedding，那是 P0-1-19 的事）。
 * · `LOG_LEVEL=error` —— 本脚本会打一堆"应当失败"的请求，收敛它自己的日志，
 *   否则断言输出会被 warn 刷掉。要看细节：`LOG_LEVEL=debug pnpm verify:documents`。
 *
 * ⚠️ 跑之前必须先起依赖：`pnpm infra:up && pnpm db:deploy`（PG + Redis + S3 都要）
 */

process.env.LOG_LEVEL ??= 'error'
process.env.LOG_PRETTY ??= 'false'
process.env.EMBEDDING_MODE = 'api'
process.env.EMBEDDING_API_URL = 'http://127.0.0.1:1/v1'
process.env.EMBEDDING_API_KEY = 'verify-doc-key'
process.env.EMBEDDING_API_MODEL = 'verify-embed-model'
process.env.UPLOAD_BODY_LIMIT = '8KB'

const { buildApp } = await import('../dist/backend/src/app.js')
const { hashPassword } = await import('../dist/backend/src/infra/crypto.js')
const { UserRole, UserStatus, closePrisma, getPrisma } = await import(
  '../dist/backend/src/infra/prisma.js'
)
const { closeRedis, ensureRedisConnected, getRedis, invalidateUserSnapshot, sessionKey } = await import(
  '../dist/backend/src/infra/redis.js'
)
const { ensureBucket, getS3Client } = await import('../dist/backend/src/infra/s3.js')
const { config } = await import('../dist/backend/src/config.js')
const { detectFormat, parseDocument, countChars } = await import(
  '../dist/backend/src/pipeline/parse/index.js'
)
const { documentItemSchema, uploadDocumentResultSchema } = await import('@doubulea/shared')
const { createHash } = await import('node:crypto')
const fixtures = await import('./fixtures/documents.mjs')

// ───────────────────────────── 断言脚手架（与另几个脚本同一套）─────────────────────────────

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

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

/** 期待抛错：返回 `{ message }`，并断言文案含某个关键词（避免"抛了别的错也算通过"） */
function expectThrow(fn, needle, label) {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (needle !== undefined) assertIncludes(message, needle, label)
    return message
  }
  throw new Error(`${label}：期望抛错，但没有抛`)
}

// ───────────────────────────── 常量与临时数据标识 ─────────────────────────────

const SESSION_COOKIE_NAME = 'doubulea_sid'
const PASSWORD = 'Verify-Doc-Passw0rd'
const suffix = Math.random().toString(36).slice(2, 8)
const adminUsername = `verify-doc-admin-${suffix}`
const memberUsername = `verify-doc-member-${suffix}`

const sessionIds = []
const createdUserIds = []
const createdKbIds = []

const app = buildApp()
const prisma = getPrisma()
const redis = getRedis()
// ⚠️ `s3` / `bucket` 在 `try` 之外声明：`finally` 的清理段也要用它们
//    （写在 try 里的话，失败路径会变成 `s3 is not defined`，把"清理没做"伪装成另一个错误）
const s3 = getS3Client()
const bucket = config.s3.bucket

// ───────────────────────────── 夹具与 multipart 构造 ─────────────────────────────

const PDF = fixtures.makePdf([
  ['Reimbursement Policy', 'Page one body text'],
  ['Travel Standard', 'Page two body text'],
])
const BLANK_PDF = fixtures.makeBlankPdf()
const FAKE_PDF = fixtures.makeFakePdf()
const DOCX = fixtures.makeDocx([
  { level: 1, text: '报销制度' },
  { text: '出差住宿标准为每晚上限 500 元。' },
  { level: 2, text: '交通费' },
  { text: '市内交通凭票报销。' },
  { level: 2, text: '住宿费 & 补贴' },
])
const NON_OOXML_ZIP = fixtures.makeZip([{ name: 'note.txt', content: '不是 Word 文档' }])
const MD = fixtures.makeMarkdown()
const TXT_UTF8 = fixtures.makeTxtUtf8()
const TXT_GBK = fixtures.makeTxtGbk()
const LEGACY_DOC = fixtures.makeLegacyDoc()
/** 超限用例：20KB（注入的上限是 8KB） */
const OVERSIZE_TXT = Buffer.from('超限用例\n'.repeat(4000), 'utf8')

/**
 * 手搓 multipart 请求体。
 * 为什么不用 `form-data` / `undici.FormData`：本脚本走 `app.inject`（不需要真 socket），
 * 而 inject 只认 `payload` 字节 —— 手搓反而是最短路径，也让"文件名怎么编码"这件事显式可见
 * （下面的中文文件名用例正是盯它：`@fastify/busboy` 对非 ASCII 参数按 **UTF-8** 解码）。
 */
function multipart(parts) {
  const boundary = `----doubuleaVerifyBoundary${Math.random().toString(16).slice(2)}`
  const chunks = []
  for (const part of parts) {
    if (part.filename === undefined) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          'utf8',
        ),
      )
      continue
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; ` +
          `filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ),
      part.value,
      Buffer.from('\r\n', 'utf8'),
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

// ───────────────────────────── HTTP 工具 ─────────────────────────────

function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const pair = header.split(';')[0] ?? ''
  const value = pair.slice(pair.indexOf('=') + 1)
  if (value !== '') sessionIds.push(value)
  return value
}

function api(method, url, { cookie, payload, headers } = {}) {
  const options = { method, url }
  const merged = { ...(headers ?? {}) }
  if (cookie !== undefined && cookie !== '') merged.cookie = `${SESSION_COOKIE_NAME}=${cookie}`
  if (Object.keys(merged).length > 0) options.headers = merged
  if (payload !== undefined) options.payload = payload
  return app.inject(options)
}

/** 上传一个夹具，返回响应（`fileName`/`contentType` 可覆盖，用于"改名""MIME 不符"等用例） */
function upload(kbId, { cookie, bytes, fileName, contentType, extraParts = [] }) {
  const { payload, contentType: multipartType } = multipart([
    { name: 'file', filename: fileName, contentType, value: bytes },
    ...extraParts,
  ])
  return api('POST', `/api/knowledge-bases/${kbId}/documents`, {
    cookie,
    payload,
    headers: { 'content-type': multipartType },
  })
}

async function createKb(cookie, name) {
  const response = await api('POST', '/api/knowledge-bases', {
    cookie,
    payload: { name },
  })
  assertEqual(response.statusCode, 200, `建库（${name}）状态码`)
  const kb = response.json().data
  createdKbIds.push(kb.id)
  return kb
}

// ───────────────────────────── 预检 + 数据准备 ─────────────────────────────

console.log(`\n${c.b}══ P0-1-16 文档上传 + 四格式解析 + 前置校验 ══${c.x}`)

try {
  await app.ready()
  try {
    await ensureRedisConnected()
    await redis.ping()
    await prisma.$queryRaw`SELECT 1`
  } catch (error) {
    console.error(
      `\n${c.r}✖ 本验收需要真实的 PG 与 Redis${c.x}\n  先执行：pnpm infra:up && pnpm db:deploy\n  原始错误：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    process.exit(1)
  }
  try {
    await ensureBucket(bucket)
  } catch (error) {
    console.error(
      `\n${c.r}✖ 本验收需要可达的 S3（MinIO）${c.x}\n  先执行：pnpm infra:up\n  原始错误：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    process.exit(1)
  }

  const passwordHash = await hashPassword(PASSWORD)
  const createUser = (username, data) => prisma.user.create({ data: { username, passwordHash, ...data } })
  const admin = await createUser(adminUsername, {
    nickname: '文档验证管理员',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  const member = await createUser(memberUsername, {
    nickname: '文档验证成员',
    role: UserRole.MEMBER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
  })
  createdUserIds.push(admin.id, member.id)

  const login = async (username) => {
    const response = await api('POST', '/api/auth/login', { payload: { username, password: PASSWORD } })
    assertEqual(response.statusCode, 200, `登录（${username}）`)
    return cookieOf(response)
  }
  const adminCookie = await login(adminUsername)
  const memberCookie = await login(memberUsername)

  const kb = await createKb(adminCookie, `验证库-文档-${suffix}`)
  const otherKb = await createKb(adminCookie, `验证库-文档2-${suffix}`)

  console.log(`  ${c.d}临时数据：${adminUsername}（ADMIN）+ ${memberUsername}（MEMBER）+ 2 个知识库${c.x}`)
  console.log(
    `  ${c.d}注入配置：UPLOAD_BODY_LIMIT=${config.limits.uploadBodyLimitRaw}（${config.limits.uploadBodyLimitBytes} 字节）｜夹具 docx=${DOCX.length}B pdf=${PDF.length}B${c.x}`,
  )

  // ═══════════════════════════════════════════════════════════════════
  // A 组 · 格式判定与前置校验（纯函数，不占端口）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── A 组 · detectFormat 判定矩阵（纯函数）──${c.x}`)

  await it('正例：四格式 × 正确 MIME × 正确内容 → 返回对应格式（含大写扩展名与带路径的文件名）', () => {
    const cases = [
      { fileName: 'a.pdf', mime: 'application/pdf', bytes: PDF, expect: 'pdf' },
      { fileName: 'a.txt', mime: 'text/plain', bytes: TXT_UTF8, expect: 'txt' },
      { fileName: 'a.md', mime: 'text/markdown', bytes: MD, expect: 'md' },
      { fileName: 'a.txt', mime: undefined, bytes: TXT_GBK, expect: 'txt' },
      // 大写扩展名（Windows 上很常见）
      { fileName: 'A.PDF', mime: 'application/pdf', bytes: PDF, expect: 'pdf' },
      // 老式浏览器会把客户端全路径塞进 filename
      { fileName: 'C:\\Users\\x\\制度.txt', mime: 'text/plain', bytes: TXT_UTF8, expect: 'txt' },
    ]
    for (const item of cases) {
      const actual = detectFormat({ fileName: item.fileName, declaredMime: item.mime, bytes: item.bytes })
      assertEqual(actual, item.expect, `detectFormat(${item.fileName}, ${item.mime})`)
    }
    // docx 单列一次：夹具是 ZIP，靠包内 `[Content_Types].xml` 才认得出是 OOXML
    assertEqual(
      detectFormat({ fileName: 'a.docx', declaredMime: undefined, bytes: DOCX }),
      'docx',
      'detectFormat(docx)',
    )
  })

  await it('`.doc` → 拒绝且文案含「另存为 .docx」（决策 10 要求的是**可操作**提示，不是"不支持"）', () => {
    // ① 只看扩展名（内容是合法 OLE2，用户就是从 Word 另存出来的旧文件）
    expectThrow(
      () => detectFormat({ fileName: '制度.doc', declaredMime: 'application/msword', bytes: LEGACY_DOC }),
      '请另存为 .docx 后重传',
      '.doc 的提示',
    )
    // ② 真 .doc 内容被改名成 .docx —— 同样要给这句提示（用户以为自己存成 docx 了）
    expectThrow(
      () =>
        detectFormat({
          fileName: '制度.docx',
          declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: LEGACY_DOC,
        }),
      '请另存为 .docx 后重传',
      '.doc 改名成 .docx 的提示',
    )
  })

  await it('扩展名白名单：`.xlsx` 与"没有扩展名"都被拒（且文案能区分该改什么）', () => {
    expectThrow(
      () => detectFormat({ fileName: 'a.xlsx', declaredMime: undefined, bytes: NON_OOXML_ZIP }),
      '不支持的文件类型 .xlsx',
      '.xlsx',
    )
    expectThrow(
      () => detectFormat({ fileName: 'README', declaredMime: undefined, bytes: TXT_UTF8 }),
      '无法从文件名',
      '无扩展名',
    )
  })

  await it('⚠️ MIME 交叉校验：声明 `image/png` 而叫 `.pdf` → 拒（这条正是"文档要求的那一道"）', () => {
    expectThrow(
      () => detectFormat({ fileName: 'a.pdf', declaredMime: 'image/png', bytes: PDF }),
      'Content-Type',
      'MIME 与扩展名不符',
    )
  })

  await it('⚠️ 文件头校验：**改名的假 PDF** 被拦（只做 MIME 交叉的实现在这条上必红）', () => {
    // 现场原样重放：把 .txt 改名成 .pdf 后，客户端声明的 MIME 与扩展名**完全自洽**
    // （browser 按扩展名给 application/pdf）—— 只有看内容才抓得住
    expectThrow(
      () => detectFormat({ fileName: '制度.pdf', declaredMime: 'application/pdf', bytes: FAKE_PDF }),
      '文件内容与扩展名不符',
      '假 PDF',
    )
    // 反向：真 PDF 字节被叫成 .txt
    expectThrow(
      () => detectFormat({ fileName: 'a.txt', declaredMime: 'text/plain', bytes: PDF }),
      '文件内容与扩展名不符',
      'PDF 改名成 .txt',
    )
    // ZIP 但不是 OOXML（"随便一个 zip 改名 .docx"）
    expectThrow(
      () => detectFormat({ fileName: 'a.docx', declaredMime: undefined, bytes: NON_OOXML_ZIP }),
      '不是 Word 文档',
      '非 OOXML 的 zip',
    )
    // 文本扩展名却含 NUL 字节（二进制内容的铁证）
    expectThrow(
      () =>
        detectFormat({
          fileName: 'a.txt',
          declaredMime: 'text/plain',
          bytes: Buffer.from([0x41, 0x00, 0x42, 0x43]),
        }),
      'NUL 字节',
      'txt 含 NUL',
    )
  })

  await it('`application/octet-stream` 放行（curl 不带 type 时就是这个；它**不是**矛盾声明）', () => {
    assertEqual(
      detectFormat({ fileName: 'a.md', declaredMime: 'application/octet-stream', bytes: MD }),
      'md',
      'octet-stream 放行',
    )
  })

  // ═══════════════════════════════════════════════════════════════════
  // B 组 · 同一批校验挂在路由上（HTTP 状态码 + 文案）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── B 组 · 前置校验挂在路由上（HTTP）──${c.x}`)

  await it('未登录 → 401（权限与知识库同口径：登录即可，但**必须**登录）', async () => {
    const response = await upload(kb.id, { cookie: undefined, bytes: TXT_UTF8, fileName: 'a.txt' })
    assertEqual(response.statusCode, 401, '未登录状态码')
  })

  await it('知识库不存在 → 404（先用随机 UUID 打一次）', async () => {
    const response = await upload('0199a1b2-0000-7000-8000-000000000000', {
      cookie: adminCookie,
      bytes: TXT_UTF8,
      fileName: 'a.txt',
    })
    assertEqual(response.statusCode, 404, '知识库不存在')
  })

  await it('知识库 id 不是 UUID → 400（路径参数校验，在服务层之前）', async () => {
    const response = await upload('not-a-uuid', { cookie: adminCookie, bytes: TXT_UTF8, fileName: 'a.txt' })
    assertEqual(response.statusCode, 400, '非法 id')
  })

  await it('multipart 里只有字段、没有文件 → 400；非 multipart 请求 → 406', async () => {
    const noFile = multipart([{ name: 'note', value: '没有文件' }])
    const response = await api('POST', `/api/knowledge-bases/${kb.id}/documents`, {
      cookie: adminCookie,
      payload: noFile.payload,
      headers: { 'content-type': noFile.contentType },
    })
    assertEqual(response.statusCode, 400, '缺文件字段')
    assertIncludes(response.json().msg, '没有收到文件', '缺文件字段文案')

    const json = await api('POST', `/api/knowledge-bases/${kb.id}/documents`, {
      cookie: adminCookie,
      payload: { hello: 1 },
    })
    assertEqual(json.statusCode, 406, '非 multipart 状态码（插件抛 FST_INVALID_MULTIPART_CONTENT_TYPE）')
  })

  await it('空文件（0 字节）→ 400', async () => {
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: Buffer.alloc(0),
      fileName: 'empty.txt',
      contentType: 'text/plain',
    })
    assertEqual(response.statusCode, 400, '空文件状态码')
    assertIncludes(response.json().msg, '空', '空文件文案')
  })

  await it('`.doc` 上传 → 400 且 msg 含「请另存为 .docx 后重传」', async () => {
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: LEGACY_DOC,
      fileName: '制度.doc',
      contentType: 'application/msword',
    })
    assertEqual(response.statusCode, 400, '.doc 状态码')
    assertIncludes(response.json().msg, '请另存为 .docx 后重传', '.doc 文案')
  })

  await it('改名的假 PDF 上传 → 400（路由级也拦得住，不只纯函数）', async () => {
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: FAKE_PDF,
      fileName: '制度.pdf',
      contentType: 'application/pdf',
    })
    assertEqual(response.statusCode, 400, '假 PDF 状态码')
    assertIncludes(response.json().msg, '文件内容与扩展名不符', '假 PDF 文案')
  })

  await it('超过 UPLOAD_BODY_LIMIT（注入 8KB，传 20KB）→ 413，状态码不被压成 400', async () => {
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: OVERSIZE_TXT,
      fileName: 'big.txt',
      contentType: 'text/plain',
    })
    assertEqual(response.statusCode, 413, '超限状态码')
    assertIncludes(response.json().msg, '超过', '超限文案')
  })

  // ═══════════════════════════════════════════════════════════════════
  // C 组 · 四格式解析（模块级：上传端点刻意不同步解析）
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── C 组 · 四格式解析结果（模块级）──${c.x}`)

  await it('PDF：逐页文本 + `meta.pageCount` + 每块的页码（§4-1 要求"页码写入 meta.page"）', async () => {
    const result = await parseDocument('pdf', PDF)
    assertEqual(result.meta.format, 'pdf', 'format')
    assertEqual(result.meta.pageCount, 2, 'pageCount')
    assert(result.meta.charCount > 0, 'charCount 应大于 0')
    const pages = result.blocks.map((block) => block.page)
    assertEqual(JSON.stringify(pages), JSON.stringify([1, 2]), '每块的页码')
    assertIncludes(result.text, 'Reimbursement Policy', '第 1 页文本')
    assertIncludes(result.text, 'Travel Standard', '第 2 页文本')
    assertEqual(JSON.stringify(result.blocks[0].headingPath), '[]', 'PDF 无标题结构')
  })

  await it('PDF：空白页（扫描件替身）解析出 0 块、charCount=0，但页数照记', async () => {
    const result = await parseDocument('pdf', BLANK_PDF)
    assertEqual(result.blocks.length, 0, '空白页的块数')
    assertEqual(result.meta.charCount, 0, '空白页字符数')
    assertEqual(result.meta.pageCount, 1, '空白页仍计页数（§五 的弱提示要用它）')
  })

  await it('DOCX：标题层级 → `headingPath`，正文按段落切，实体还原（`&amp;` → `&`）', async () => {
    const result = await parseDocument('docx', DOCX)
    assertEqual(result.meta.format, 'docx', 'format')
    assertEqual(result.meta.pageCount, null, 'docx 非分页格式')
    assertEqual(result.meta.hasHeadings, true, 'hasHeadings')
    const paths = result.blocks.map((block) => block.headingPath.join('>'))
    assertEqual(
      JSON.stringify(paths),
      JSON.stringify(['报销制度', '报销制度', '报销制度>交通费', '报销制度>交通费', '报销制度>住宿费 & 补贴']),
      '标题路径序列',
    )
    assertIncludes(result.text, '住宿费 & 补贴', '实体还原')
    assertIncludes(result.text, '市内交通凭票报销。', '正文段落')
  })

  await it('MD：`#` 层级 → `headingPath`，**代码围栏里的 `#` 不算标题**，围栏内容仍保留', async () => {
    const result = await parseDocument('md', MD)
    assertEqual(result.meta.format, 'md', 'format')
    assertEqual(result.meta.hasHeadings, true, 'hasHeadings')
    // 逐块断言"标题路径 + 正文前几个字"——只比路径数量的话，"谁在谁下面"是看不出来的
    const outline = result.blocks.map((block) => `${block.headingPath.join('>')}::${block.text.slice(0, 8)}`)
    assertEqual(
      JSON.stringify(outline),
      JSON.stringify([
        '员工手册::员工手册',
        '员工手册::本手册适用于全体',
        '员工手册>报销制度::报销制度',
        '员工手册>报销制度::出差住宿标准为每',
        '员工手册>报销制度>交通费::交通费',
        '员工手册>报销制度>交通费::市内交通凭票报销',
        // 围栏内容成块、且**继承它所在小节**的路径；关键是它没有被当成标题
        '员工手册>报销制度>交通费::echo "# ',
        '员工手册>考勤::考勤',
        '员工手册>考勤::迟到超过 30 ',
      ]),
      '逐块的「标题路径::正文」序列',
    )
    assertIncludes(result.text, '这行在代码块里，不是标题', '围栏内容保留')
  })

  await it('TXT(UTF-8)：编码嗅探出 `utf-8`，每行一块', async () => {
    const result = await parseDocument('txt', TXT_UTF8)
    assertEqual(result.meta.encoding, 'utf-8', 'encoding')
    assertEqual(result.blocks.length, 3, '块数（3 行）')
    assertIncludes(result.text, '主机房温度 22 度', '文本')
  })

  await it('⚠️ TXT(GBK)：编码嗅探出 `gbk` 且中文**不乱码**（本批点名的坑）', async () => {
    const result = await parseDocument('txt', TXT_GBK)
    assertEqual(result.meta.encoding, 'gbk', 'encoding')
    assertIncludes(result.text, '中文编码: 测试报告', 'GBK 文本（乱码的话这里会看到 U+FFFD）')
    assertEqual(result.text.includes('\uFFFD'), false, '不应出现替换字符')
  })

  await it('计数口径：`countChars` 去空白、且 emoji 按"一个字"算（`[...s].length` 而非 `s.length`）', () => {
    assertEqual(countChars(' 中 文\n\t测 试 '), 4, '中文去空白')
    assertEqual(countChars('👍'), 1, 'emoji（s.length 会算成 2）')
  })

  // ═══════════════════════════════════════════════════════════════════
  // D 组 · 上传落库 + 存储取证 + 判重 + 权限
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── D 组 · 入库登记 / S3 取证 / 判重 / 权限 ──${c.x}`)

  await it('上传 md：200 + `status=PARSING` + `chunkCount=0` + `deduplicated=false`；响应符合契约', async () => {
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: MD,
      fileName: '员工手册.md',
      contentType: 'text/markdown',
    })
    assertEqual(response.statusCode, 200, '状态码')
    const parsed = uploadDocumentResultSchema.safeParse(response.json().data)
    assert(parsed.success, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    assertEqual(parsed.data.document.status, 'PARSING', 'status（上传不同步解析，见文件头）')
    assertEqual(parsed.data.document.chunkCount, 0, 'chunkCount')
    assertEqual(parsed.data.deduplicated, false, 'deduplicated')
    assertEqual(parsed.data.document.fileName, '员工手册.md', '中文文件名原样保存')
    assertEqual(parsed.data.document.errorMsg, null, 'errorMsg')
  })

  await it('存储取证：DB 行的 `content_hash`/`file_key` 正确，且 S3 对象**逐字节**等于上传内容', async () => {
    const row = await prisma.document.findFirst({
      where: { kbId: kb.id },
      orderBy: { createdAt: 'desc' },
    })
    assert(row !== null, '应有一行 documents')

    const expectedHash = createHash('sha256').update(MD).digest('hex')
    assertEqual(row.contentHash, expectedHash, 'content_hash = sha256(文件字节)')
    assertEqual(row.contentHash.length, 64, 'content_hash 长度（列是 VARCHAR(64)）')
    // file_key 形状：`kb/{kbId}/{随机段}/source.{ext}`（随机段与 docId 无关，见服务层文件头）
    assert(
      new RegExp(`^kb/${kb.id}/[0-9a-f-]{36}/source\\.md$`).test(row.fileKey),
      `file_key 形状：实际 ${row.fileKey}`,
    )
    assertEqual(row.status, 'PARSING', 'DB 里的状态')
    // 主键是 uuid(7)：第 15 个字符必须是 `7`（`02` §3.1 的口径；Prisma 的 `@default(uuid(7))`）
    assertEqual(row.id[14], '7', 'docId 应为 uuid v7')

    const object = await s3.getObject(bucket, row.fileKey)
    const chunks = []
    for await (const chunk of object) chunks.push(chunk)
    const stored = Buffer.concat(chunks)
    assertEqual(Buffer.compare(stored, MD), 0, 'S3 里的字节与上传内容逐字节相同')
  })

  await it('判重（同库）：同内容再传 → `deduplicated=true` 且**不新建行**（§4-1 第 4 条）', async () => {
    const before = await prisma.document.count({ where: { kbId: kb.id } })
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: MD,
      fileName: '员工手册-副本.md',
      contentType: 'text/markdown',
    })
    assertEqual(response.statusCode, 200, '状态码')
    const data = uploadDocumentResultSchema.parse(response.json().data)
    assertEqual(data.deduplicated, true, 'deduplicated')
    assertEqual(data.document.fileName, '员工手册.md', '返回的是**已有**那条（文件名也应是原来那个）')
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), before, '文档行数不应变化')
    // 状态码仍 200（不是 409）：判重是"你的文件已经在了"这种良性结果，
    // 用 409 会让前端把它当错误弹窗（`子方案①` §4-1 第 4 条）
  })

  await it('判重是**每库**的：同一份内容传到另一个知识库 → 正常新建（`deduplicated=false`）', async () => {
    const response = await upload(otherKb.id, {
      cookie: adminCookie,
      bytes: MD,
      fileName: '员工手册.md',
      contentType: 'text/markdown',
    })
    assertEqual(response.statusCode, 200, '状态码')
    const data = uploadDocumentResultSchema.parse(response.json().data)
    assertEqual(data.deduplicated, false, '跨库不判重')
    assertEqual(data.document.kbId, otherKb.id, '落在第二个库里')
    assertEqual(await prisma.document.count({ where: { kbId: otherKb.id } }), 1, '第二个库应有 1 条')
  })

  await it('四格式各 1 篇都能登记（pdf / docx / txt-GBK 补齐另外三种）', async () => {
    const cases = [
      { bytes: PDF, fileName: '制度.pdf', contentType: 'application/pdf', key: 'source.pdf' },
      { bytes: DOCX, fileName: '制度.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', key: 'source.docx' },
      { bytes: TXT_GBK, fileName: '巡检.txt', contentType: 'text/plain', key: 'source.txt' },
    ]
    for (const item of cases) {
      const response = await upload(kb.id, {
        cookie: adminCookie,
        bytes: item.bytes,
        fileName: item.fileName,
        contentType: item.contentType,
      })
      assertEqual(response.statusCode, 200, `上传 ${item.fileName}`)
      const data = uploadDocumentResultSchema.parse(response.json().data)
      assertEqual(data.document.status, 'PARSING', `${item.fileName} 状态`)
      const row = await prisma.document.findUnique({ where: { id: data.document.id } })
      assert(row !== null && row.fileKey.endsWith(item.key), `${item.fileName} 的 file_key 应以 ${item.key} 结尾`)
      // 顺带证明"格式判定 → 解析器"这条链在实际文件上也是通的（C 组已逐字段验过）
      const parsed = await parseDocument(item.key.split('.').pop(), item.bytes)
      assert(parsed.meta.charCount > 0, `${item.fileName} 应解析出文本`)
    }
    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 4, '库里应有 4 篇文档')
  })

  await it('MEMBER 也能上传（权限=登录即可，与知识库同口径；"顺手加 requireAdmin"会在这条上红）', async () => {
    const response = await upload(kb.id, {
      cookie: memberCookie,
      bytes: TXT_UTF8,
      fileName: '成员上传.txt',
      contentType: 'text/plain',
    })
    assertEqual(response.statusCode, 200, 'MEMBER 上传状态码')
    assertEqual(uploadDocumentResultSchema.parse(response.json().data).document.status, 'PARSING', 'MEMBER 上传的状态')
  })

  await it('响应里的键集合不含存储内部字段（防"以后有人顺手把 file_key / content_hash select 出去"）', async () => {
    const response = await upload(kb.id, {
      cookie: adminCookie,
      bytes: Buffer.from('键集合用例：只关心响应的键，不关心内容\n', 'utf8'),
      fileName: '键集合.txt',
      contentType: 'text/plain',
    })
    assertEqual(response.statusCode, 200, '状态码')
    const keys = Object.keys(documentItemSchema.parse(response.json().data.document))
    for (const forbidden of ['fileKey', 'contentHash', 'file_key', 'content_hash']) {
      assert(!keys.includes(forbidden), `响应不应含 ${forbidden}（实际键：${keys.join(',')}）`)
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // E 组 · 自清理 + 残留复核
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${c.b}── E 组 · 删库后 DB 与 S3 两侧都回到基线 ──${c.x}`)

  await it('删库（走 API）→ 该库的 documents 行与 S3 对象全部消失', async () => {
    const keyPrefix = `kb/${kb.id}/`
    const keysBefore = []
    for await (const object of s3.listObjectsV2(bucket, keyPrefix, true)) {
      if (object.name !== undefined) keysBefore.push(object.name)
    }
    assert(keysBefore.length >= 5, `前置：库内应有 ≥5 个对象，实际 ${keysBefore.length}`)
    assert((await prisma.document.count({ where: { kbId: kb.id } })) >= 5, '前置：应有 ≥5 行文档')

    const response = await api('DELETE', `/api/knowledge-bases/${kb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删库状态码')

    assertEqual(await prisma.document.count({ where: { kbId: kb.id } }), 0, 'documents 应被级联删除')
    const residual = []
    for await (const object of s3.listObjectsV2(bucket, keyPrefix, true)) {
      if (object.name !== undefined) residual.push(object.name)
    }
    assertEqual(residual.length, 0, `S3 侧应无残留，实际 ${JSON.stringify(residual)}`)
  })

  await it('删第二个库（API）→ 同样干净；随后复核临时数据归零', async () => {
    // 第二条独立取证：换一个库再走一遍"删库 → DB 与 S3 两侧清空"，
    // 避免"第一条过了只是碰巧"（复用同一条路径但数据不同）
    const response = await api('DELETE', `/api/knowledge-bases/${otherKb.id}`, { cookie: adminCookie })
    assertEqual(response.statusCode, 200, '删第二个库的状态码')
    assertEqual(await prisma.document.count({ where: { kbId: otherKb.id } }), 0, '第二个库的文档应清空')

    assertEqual(
      await prisma.knowledgeBase.count({ where: { name: { contains: suffix } } }),
      0,
      '残留知识库应为 0',
    )
    assertEqual(
      await prisma.document.count({ where: { kbId: { in: createdKbIds } } }),
      0,
      '残留文档应为 0',
    )
    // ⚠️ S3 侧的复核必须**按前缀 list**（而不是看脚本自己的记账数组）：本批的键形状是
    //    `kb/{kbId}/{随机段}/source.{ext}`，"记账说删了、对象其实还在"正是键拼错时会出的错
    const residual = []
    for (const kbId of createdKbIds) {
      for await (const object of s3.listObjectsV2(bucket, `kb/${kbId}/`, true)) {
        if (object.name !== undefined) residual.push(object.name)
      }
    }
    assertEqual(residual.length, 0, `S3 侧残留应为 0，实际 ${JSON.stringify(residual)}`)
  })
} finally {
  // ── 最终清理（一律 `deleteMany`：清理阶段"目标已经不在了"是正常情况，
  //    `delete` 会为不存在的记录往 stdout 丢一坨 P2025 堆栈，把断言输出冲掉）──
  try {
    await prisma.chunk.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { kbId: { in: createdKbIds } } })
    await prisma.document.deleteMany({ where: { fileName: { contains: suffix } } })
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: createdKbIds } } })
    await prisma.knowledgeBase.deleteMany({ where: { name: { contains: suffix } } })
    for (const userId of createdUserIds) {
      // ⚠️ 快照必须显式删：`requireAuth` 每请求会写 `auth-user:{userId}`（TTL 60s），
      //    不删就要等窗口过去才算干净（`06` P0-1-7 坑 5 的教训）
      await invalidateUserSnapshot(userId).catch(() => undefined)
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    for (const sid of sessionIds) await redis.del(sessionKey(sid)).catch(() => undefined)

    // S3：按**库前缀**逐个清（本批的键是 `kb/{kbId}/...`；`S3_PREFIX` 那个前缀留给正向确认）
    for (const kbId of createdKbIds) {
      const keys = []
      for await (const object of s3.listObjectsV2(bucket, `kb/${kbId}/`, true)) {
        if (object.name !== undefined) keys.push(object.name)
      }
      if (keys.length > 0) await s3.removeObjects(bucket, keys).catch(() => undefined)
    }
  } catch (error) {
    console.log(`  ${c.r}清理过程出错：${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
  await app.close()
  await closePrisma()
  await closeRedis()
}

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-16 文档上传 + 四格式解析验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-16 文档上传 + 四格式解析验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
