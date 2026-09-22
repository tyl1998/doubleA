#!/usr/bin/env node
/**
 * verify-app.mjs —— **接口级验收**（不占端口、不需要真实依赖）
 *
 * 覆盖四批：
 *   · P0-1-4：信封形态 / HTTP 状态码 / Zod 校验失败字段明细 / 领域错误 / 未知异常不泄内部信息 /
 *             404 兜底 / 非法 JSON / CORS 预检 / requestId 透传 / `/health` 三项探活恒 200
 *   · P0-1-6：密文往返与**篡改检出**（GCM tag）/ 版本与 AAD 上下文 / bcrypt 形态与拒绝超长 /
 *             初始密码生成 / **未登录一律 401 且不碰会话存储**
 *   · P0-1-7：`/api/auth/*` 已注册 + 请求体 schema 的字段明细 + 首登闸门不给匿名请求增加依赖调用 /
 *             shared 认证契约的纯函数（`utf8ByteLength` 与 `Buffer.byteLength` 对照、用户名归一化）
 *   · P0-1-8：`/api/users` 已注册 + 用户管理契约（建号/改角色/分页 schema 与字段明细）
 *   · P0-1-10：`/api/model-providers` 已注册 + Provider 契约（`maskApiKey` 边界、
 *              baseUrl 归一化、**PATCH 的 apiKey 三态**、密文**绑定到记录**（AAD 换 id 即解不开）、
 *              输出形态里不存在任何 key/密文字段）
 *   · P0-1-11：`/api/models` 与 `/api/models/available` **两条路径各自独立注册**
 *              （⚠️ 同路径注册两个 GET 会在**启动期**抛 `FST_ERR_DUPLICATED_ROUTE`，
 *              这是"必须拆路径"的硬证据）+ 模型契约（型号名/别名校验、
 *              `available` 的 `type` 必填、`maxContext` 三态、两套投影的键集合互不串味）
 *   · P0-1-12：`/api/model-providers/:id/remote-models` 已注册（**子路径**，匿名 401 / 非法 UUID 400）
 *              + 上游模型列表契约（形态与取值域、键集合里不存在任何凭据名）
 *   · P0-1-15：`/api/knowledge-bases` 五条路由已注册、且**刻意没有** `/available` 子路径
 *              （本资源对全员开放，不像模型池那样需要第二套投影）+ 知识库契约
 *              （`retrieval_config` 的**逐键兜底**与越界退回默认、建库四项可省、
 *              `description` 三态、`embeddingModelChanged` 三态）
 *   · P0-1-16：`POST /api/knowledge-bases/:id/documents` 已注册（且只有这一条 —— 列表/下载/删除
 *              属后续批次，不提前注册）+ **前置校验的纯函数矩阵**（扩展名白名单 / `.doc` 专拦 /
 *              MIME 交叉校验 / **文件头魔数**：改名的假 PDF、不含 OOXML 的 zip、OLE2 改名、
 *              NUL 字节、图片）+ 文档契约（`UPLOAD_EXTENSIONS` 与 `MIME_BY_EXTENSION` 同源、
 *              `documentItemSchema` / `uploadDocumentResultSchema` 的 `deduplicated` 必填、
 *              `countChars` 按**码点**计而非 `.length`）
 *   · P0-1-17：**文档状态机的转换表**（合法转换恰好 5 条；`READY` 不得被打回 `FAILED`、也不能
 *              自转 `READY` —— 这是"过期 job 把已成功的文档写坏"的唯一防线，没有任何 HTTP 路径
 *              能验到它，只能在这一档守）。队列与 worker 的行为要真 Redis/PG/S3，归 `verify-pipeline`。
 *   · P0-1-18：**分块策略的纯函数契约**（`hybrid`/`fixed`）—— 小文档特例（全文 ≤ chunk_size
 *              恰好 1 块）、边界回退到句末（而不是硬切）、**每块都是原文的逐字子串**、
 *              重叠 64 字符、尾块合并、定长滑窗、**按码点切（不劈开代理对）**、
 *              页码 meta 取"块起点所在页"、同名标题不相邻时**顺序保持**、未知策略回落默认。
 *              分块模块不 import `config`/logger ⇒ 这一档（无依赖、可进 CI）能直接断言它；
 *              夹具（手写 PDF/DOCX 字节）也是纯生成器。行为侧（真上传 → 真解析 → 真分块）
 *              归 `verify-pipeline` 的 H 组。
 *
 * 会话与认证的**行为**（Cookie 属性、限速锁定、首登闸门 403、改密）离不开真实 Redis/PG，
 * 分别由 `verify-session.mjs` / `verify-auth.mjs` 覆盖 —— 那两档要 `pnpm infra:up`。
 * Provider 的**落库形态**（`api_key_enc` 是密文、读接口不含明文、三态真地写对列）
 * 由 `verify-model-providers.mjs` 覆盖；模型的落库与守卫（含"provider 停用后模型从
 * 可选列表消失"）由 `verify-models.mjs` 覆盖；知识库的落库、快照、级联与 S3 清理
 * 由 `verify-knowledge-bases.mjs` 覆盖，三档都需要真实 PG（知识库那档不需要 Redis）。
 *
 * 为什么用 `app.inject` 而不是 curl：
 *   ① 本机端口是稀缺资源（3000/5173 都被别的项目占着，见 `06` §七 待决事项 6），
 *      inject 直接走 Fastify 内部请求生命周期，不监听、不留端口；
 *   ② CI 里不需要 docker-compose 就能验证 HTTP 层契约（依赖探活失败也是一种可断言的状态）。
 *
 * 验的是「协议契约」+「纯函数正确性」，不是「依赖可用性」——会话在真实 Redis/PG 上的
 * 完整往返（Cookie 属性、停用即失效、登出、滑动续期）在 `verify-session.mjs` 里跑，
 * 那一个**需要** `pnpm infra:up` + 已迁移的库。
 *
 * 附加探针路由（`/__verify/*`）由**本脚本自己注册**，不进源码树：
 *   产品代码里只有 `/health` 一个路由，测试用的路由不该混进去。
 *
 * 用法：
 *   pnpm verify:app                     # 本机（依赖起着 → 断言 /health 全绿）
 *   EXPECT_DEGRADED=1 pnpm verify:app   # 无依赖环境（CI）→ 断言三项探活全部降级
 */

import { z } from 'zod'

import {
  AppError,
  PASSWORD_MAX_BYTES,
  authUserSchema,
  changePasswordBodySchema,
  createModelBodySchema,
  createModelProviderBodySchema,
  createUserBodySchema,
  createKnowledgeBaseBodySchema,
  DEFAULT_RETRIEVAL_CONFIG,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_TRANSITIONS,
  canTransitionDocumentStatus,
  documentItemSchema,
  documentParamsSchema,
  LEGACY_DOC_EXTENSION,
  LEGACY_DOC_HINT,
  MIME_BY_EXTENSION,
  UPLOAD_EXTENSIONS,
  UPLOAD_FILE_FIELD,
  initialPasswordResultSchema,
  knowledgeBaseItemSchema,
  knowledgeBaseListResultSchema,
  listAvailableModelsQuerySchema,
  listModelProvidersQuerySchema,
  listModelsQuerySchema,
  listUsersQuerySchema,
  loginBodySchema,
  maskApiKey,
  modelItemSchema,
  modelOptionListResultSchema,
  modelOptionSchema,
  modelProviderItemSchema,
  normalizeRetrievalConfig,
  normalizeUsername,
  offsetPageOf,
  ok,
  retrievalConfigInputSchema,
  remoteModelListResultSchema,
  SPLIT_STRATEGIES,
  updateModelBodySchema,
  updateModelProviderBodySchema,
  updateKnowledgeBaseBodySchema,
  updateUserBodySchema,
  uploadDocumentResultSchema,
  userListItemSchema,
  utf8ByteLength,
} from '@doubulea/shared'
import { buildApp } from '../dist/backend/src/app.js'
import {
  BCRYPT_COST,
  DUMMY_PASSWORD_HASH,
  INITIAL_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  SecretDecryptionError,
  SecretFormatError,
  decryptSecret,
  encryptSecret,
  generateInitialPassword,
  hashPassword,
  passwordByteLength,
  verifyPassword,
} from '../dist/backend/src/infra/crypto.js'
import { closePg } from '../dist/backend/src/infra/pg.js'
import { closeRedis } from '../dist/backend/src/infra/redis.js'
import { countChars, detectFormat, parseDocument } from '../dist/backend/src/pipeline/parse/index.js'
// 分块模块刻意**不依赖 config/logger**（见其文件头）⇒ 它可以在这一档（无依赖、可进 CI）里被断言，
// 这也是本档第一条"纯函数契约必须有无依赖断言"的实践：分块的三种典型错误（劈开代理对、
// 硬切在 chunk_size、跨段乱序合并）都不会被 lint/typecheck/build 拦下，也不会让接口 400。
import {
  DEFAULT_CHUNK_MIN_CHARS,
  SENTENCE_BOUNDARY_CHARS,
  chunkStrategyNames,
  resolveChunkStrategy,
  splitIntoChunks,
} from '../dist/backend/src/pipeline/chunk/index.js'
import { providerKeyAad } from '../dist/backend/src/services/model.service.js'
// 夹具是纯 JS 生成器（手写 PDF/DOCX/ZIP 字节），不引依赖、不读外部文件 ⇒ 仍然满足本档"无依赖"
import * as fixtures from './fixtures/documents.mjs'

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

/** 单条断言 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

/** 跑一条用例：失败不中断（一次跑完，把问题看全） */
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

const expectDegraded = process.env.EXPECT_DEGRADED === '1'

console.log(`\n${c.b}══ 接口级验收：信封 / /health / 密码与会话 / 认证 / 用户管理 / 模型池 ══${c.x}`)
console.log(`  ${c.d}模式：${expectDegraded ? '依赖全部不可达（断言 degraded）' : '本机依赖（断言 /health 全绿）'}${c.x}`)

const app = buildApp()

// ── 探针路由：只在本脚本里注册，用来把错误处理的每条分支都真跑一遍 ──
app.post(
  '/__verify/echo',
  {
    schema: {
      body: z.object({ name: z.string().min(2), age: z.coerce.number().int().min(0) }),
      querystring: z.object({ page: z.coerce.number().int().min(1).default(1) }),
    },
  },
  async (request) => ok({ body: request.body, query: request.query }),
)
// 极小的 bodyLimit：用来验证「请求体过大」（413）也被翻译成信封
app.post(
  '/__verify/tiny',
  { bodyLimit: 32, schema: { body: z.object({ note: z.string() }) } },
  async (request) => ok(request.body),
)
app.get('/__verify/conflict', () => {
  throw AppError.conflict('该会话正在生成回答', { position: 2 })
})
app.get('/__verify/boom', () => {
  // 故意夹带「内部细节」：验证它**不会**出现在响应体里（`02` §十）
  throw new Error('内部细节：secret-token-abc / password=hunter2')
})
// 会话探针（P0-1-6）：`requireAuth` 的实现里，「无 Cookie」这一条**不碰 Redis**，
// 因此它在有/无依赖两种环境下都应当稳定返回 401 —— 这正是下面要断言的。
app.get('/__verify/protected', { preHandler: app.requireAuth }, async (request) =>
  ok({ userId: request.auth?.user.id, role: request.auth?.user.role }),
)
app.get('/__verify/admin-only', { preHandler: app.requireAdmin }, async () => ok({ scope: 'admin' }))
// 首登闸门（P0-1-7）的探针：一个 `/api/**` 下的**公共**路由（不挂任何鉴权钩子）。
// 用来验「闸门不会给匿名请求增加依赖调用」—— 没有 Cookie 时闸门必须直接放行，
// 否则依赖不可达的 CI 里这条会变成 500（而它本该是 200）。
app.get('/api/__verify/open', async () => ok({ open: true }))

await app.ready()

// ── 1. /health ──
await it('/health 返回 200 + 信封 + 三项依赖状态', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  assertEqual(response.statusCode, 200, 'HTTP 状态码（依赖不可用也必须是 200，不是 500）')
  const body = response.json()
  assertEqual(body.code, 0, '信封 code')
  assertEqual(body.data.service, 'doubulea-backend', 'service')
  assertEqual(body.data.checks.map((check) => check.target).join(','), 'postgres,redis,s3', '探活顺序')
  for (const check of body.data.checks) {
    assert(typeof check.latencyMs === 'number' && check.latencyMs >= 0, `${check.target}.latencyMs 应为非负数字`)
    assert(typeof check.detail === 'string' && check.detail !== '', `${check.target}.detail 不应为空`)
  }
  const allOk = body.data.checks.every((check) => check.ok)
  assertEqual(body.data.status, allOk ? 'ok' : 'degraded', 'status 与各项探活结论一致')
  assert(typeof body.data.timeoutMs === 'number', 'timeoutMs 应回显，便于对照「超时」类原因')
  console.log(`         ${c.d}${JSON.stringify(body.data.checks.map((x) => `${x.target}=${x.ok ? 'ok' : x.detail}`))}${c.x}`)
})

if (expectDegraded) {
  await it('/health 在依赖不可达时**逐项**报出原因（而非整体报错）', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health' })).json()
    assertEqual(body.data.status, 'degraded', 'status')
    for (const check of body.data.checks) {
      assertEqual(check.ok, false, `${check.target} 应判为不可用`)
      assertEqual(check.detail.includes('超时'), false, `${check.target} 应立即失败（连接被拒），不应走到超时兜底`)
    }
  })
}

// ── 2. Zod 校验失败 → VALIDATION 信封 + 字段明细 ──
await it('Zod 校验失败 → 400 / VALIDATION / body 字段级 path（多条一次报全）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    payload: { name: 'x', age: 'not-a-number' },
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  const paths = body.data.fields.map((field) => field.path)
  assert(paths.includes('body.name'), `应报出 body.name，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.age'), `应报出 body.age，实际 ${JSON.stringify(paths)}`)
})

await it('querystring 校验失败同样带部位前缀（body 合法时才轮到它）', async () => {
  // ⚠️ Fastify 按 params → body → querystring 顺序校验，**任一处失败即短路**，
  //    所以必须给合法 body 才能验到 querystring 这一路
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo?page=0',
    payload: { name: 'ab', age: 3 },
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  const paths = response.json().data.fields.map((field) => field.path)
  assert(paths.includes('querystring.page'), `应报出 querystring.page，实际 ${JSON.stringify(paths)}`)
})

await it('校验通过时 coerce/transform 的产物对 handler 可见', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    payload: { name: 'ab', age: '30' },
  })
  assertEqual(response.statusCode, 200, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.data.body.age, 30, 'body.age 应已被 z.coerce 转成数字')
  assertEqual(body.data.query.page, 1, 'querystring.page 应取到默认值 1')
})

// ── 3. 领域错误原样带出 ──
await it('领域错误（AppError）→ 409 / CONFLICT / msg + data 原样', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/conflict' })
  assertEqual(response.statusCode, 409, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'CONFLICT', '信封 code')
  assertEqual(body.msg, '该会话正在生成回答', 'msg 应是领域错误自带的中文文案')
  assertEqual(body.data.position, 2, 'data 应带出附加信息')
})

// ── 4. 未知异常：500 + 通用文案，不泄内部信息 ──
await it('未知异常 → 500 / INTERNAL，且**不回显**原始 message', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/boom' })
  assertEqual(response.statusCode, 500, 'HTTP 状态码')
  const raw = response.body
  assert(raw.includes('secret-token-abc') === false, '原始错误信息泄露到响应体（`02` §十 不允许）')
  assert(raw.includes('hunter2') === false, '密码片段泄露到响应体')
  const body = JSON.parse(raw)
  assertEqual(body.code, 'INTERNAL', '信封 code')
  assertEqual(body.msg, '服务内部错误', 'msg 应为通用文案')
})

// ── 5. 404 兜底 ──
await it('未注册路由 → 404 / NOT_FOUND（不是 Fastify 默认结构）', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/nope' })
  assertEqual(response.statusCode, 404, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'NOT_FOUND', '信封 code')
  assert(typeof body.msg === 'string' && body.msg !== '', 'msg 不应为空')
})

// ── 6. 请求体形态错误 ──
await it('非法 JSON → 400 / VALIDATION（框架错误被翻译成信封）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json',
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  assertEqual(response.json().code, 'VALIDATION', '信封 code')
})

await it('不支持的 Content-Type → 415 / VALIDATION（状态码保持 415 不被压成 400）', async () => {
  // ⚠️ Fastify 默认自带 application/json 与 text/plain 两个 parser，
  //    要触发 415 得用一个它没注册的类型
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    headers: { 'content-type': 'application/xml' },
    payload: '<name>ab</name>',
  })
  assertEqual(response.statusCode, 415, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  assert(body.msg.includes('Content-Type'), `msg 应说清是 Content-Type 的问题，实际：${body.msg}`)
})

await it('请求体超限 → 413 / VALIDATION（上限信息保留在状态码上）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/tiny',
    payload: { note: 'x'.repeat(200) },
  })
  assertEqual(response.statusCode, 413, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  assert(body.msg.length > 0, 'msg 不应为空')
})

// ── 7. CORS 预检 ──
await it('CORS 预检 → 回显来源且允许携带凭据', async () => {
  const origin = 'http://localhost:5174'
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: { origin, 'access-control-request-method': 'GET' },
  })
  assertEqual(response.statusCode, 204, '预检状态码')
  assertEqual(response.headers['access-control-allow-origin'], origin, 'allow-origin 应回显配置的来源')
  assertEqual(response.headers['access-control-allow-credentials'], 'true', '必须允许携带 Cookie')
})

// ── 8. requestId 贯穿 ──
await it('requestId：上游 x-request-id 透传 + 响应头回带', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { 'x-request-id': 'verify-rid-123' },
  })
  assertEqual(response.headers['x-request-id'], 'verify-rid-123', '响应头应回带同一个 requestId')

  const generated = await app.inject({ method: 'GET', url: '/health' })
  assert(
    typeof generated.headers['x-request-id'] === 'string' && generated.headers['x-request-id'].length > 0,
    '未提供 x-request-id 时应自动生成',
  )
})

// ── 9. 密文加解密（P0-1-6）：往返 / 篡改检出 / 版本 / AAD ──
const SAMPLE = 'sk-live-这是一个带中文与 emoji 🔐 的密钥-0O1lI'

await it('AES-256-GCM 往返一致（含中文/emoji/空串），且密文形态为 v1.<iv>.<tag>.<ct>', async () => {
  const encrypted = encryptSecret(SAMPLE)
  assertEqual(decryptSecret(encrypted), SAMPLE, '解密结果')
  const parts = encrypted.split('.')
  assertEqual(parts.length, 4, '密文段数')
  assertEqual(parts[0], 'v1', '版本前缀')
  assertEqual(decryptSecret(encryptSecret('')), '', '空串也应能往返')
  console.log(`         ${c.d}${encrypted.slice(0, 46)}…（${encrypted.length} 字符）${c.x}`)
})

await it('同一明文两次加密得到**不同**密文（IV 随机），且明文不出现在密文里', async () => {
  const a = encryptSecret(SAMPLE)
  const b = encryptSecret(SAMPLE)
  assert(a !== b, '两次加密结果相同 —— IV 没有随机化')
  assertEqual(decryptSecret(a), SAMPLE, 'a 解密')
  assertEqual(decryptSecret(b), SAMPLE, 'b 解密')
  assert(a.includes('sk-live') === false && b.includes('sk-live') === false, '密文里出现了明文片段')
})

await it('篡改密文 / 认证标签 → SecretDecryptionError（GCM tag 校验生效）', async () => {
  const parts = encryptSecret(SAMPLE).split('.')
  for (const index of [2, 3]) {
    const tampered = [...parts]
    const segment = tampered[index]
    // 改一个字符（首字符换掉）即可让 tag 校验失败
    tampered[index] = (segment[0] === 'A' ? 'B' : 'A') + segment.slice(1)
    let thrown
    try {
      decryptSecret(tampered.join('.'))
    } catch (error) {
      thrown = error
    }
    assert(thrown !== undefined, `篡改第 ${index} 段后仍然解密成功 —— 篡改未被检出`)
    assert(
      thrown instanceof SecretDecryptionError,
      `篡改第 ${index} 段应抛 SecretDecryptionError，实际 ${thrown?.name}：${thrown?.message}`,
    )
  }
})

await it('IV 被替换成另一个合法 IV → 解密失败（不会解出错误明文）', async () => {
  const a = encryptSecret(SAMPLE).split('.')
  const b = encryptSecret(SAMPLE).split('.')
  a[1] = b[1]
  let thrown
  try {
    decryptSecret(a.join('.'))
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof SecretDecryptionError, `应抛 SecretDecryptionError，实际 ${thrown?.name}`)
})

await it('AAD 上下文：同值可解、错值被拒、缺省不匹配', async () => {
  const bound = encryptSecret(SAMPLE, 'provider:abc')
  assertEqual(decryptSecret(bound, 'provider:abc'), SAMPLE, '同一上下文应能解密')
  for (const [label, context] of [
    ['换了上下文', 'provider:def'],
    ['不传上下文', undefined],
  ]) {
    let thrown
    try {
      decryptSecret(bound, context)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof SecretDecryptionError, `${label} 时应解密失败，实际 ${thrown?.name}`)
  }
  // 反向：不带上下文加密的密文，带上下文也解不开
  let thrown
  try {
    decryptSecret(encryptSecret(SAMPLE), 'provider:abc')
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof SecretDecryptionError, `带上下文解无上下文密文应失败，实际 ${thrown?.name}`)
})

await it('密文串结构非法 → SecretFormatError（版本未知 / 段数不对 / 编码非法）', async () => {
  const bytes32 = Buffer.alloc(32).toString('base64url')
  const bytes16 = Buffer.alloc(16).toString('base64url')
  const cases = [
    ['未知版本', `v9.${bytes32}.${bytes16}.`],
    ['段数不足', `v1.${bytes32}.${bytes16}`],
    ['IV 长度不对', `v1.${Buffer.alloc(8).toString('base64url')}.${bytes16}.`],
    ['标签长度不对', `v1.${bytes32}.${bytes16}.`],
  ]
  for (const [label, payload] of cases) {
    let thrown
    try {
      decryptSecret(payload)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof SecretFormatError, `${label} 应抛 SecretFormatError，实际 ${thrown?.name}`)
  }
})

// ── 10. 密码哈希（P0-1-6）：bcrypt 形态 / 校验 / 拒绝超长 ──
await it(`bcrypt 摘要形态正确（$2b$${BCRYPT_COST}$… / 60 字符）且能校验正确与错误密码`, async () => {
  const hash = await hashPassword('Passw0rd-中文-🔐')
  assert(hash.startsWith(`$2b$${BCRYPT_COST}$`), `摘要前缀应为 $2b$${BCRYPT_COST}$，实际 ${hash.slice(0, 7)}`)
  assertEqual(hash.length, 60, '摘要长度')
  assertEqual(await verifyPassword('Passw0rd-中文-🔐', hash), true, '正确密码')
  assertEqual(await verifyPassword('Passw0rd-中文-🔐x', hash), false, '错误密码')
  const again = await hashPassword('Passw0rd-中文-🔐')
  assert(again !== hash, '同一密码两次哈希结果相同 —— salt 没随机化')
})

await it('超长密码（>72 字节）被**显式拒绝**，不做静默截断', async () => {
  const long = `${'a'.repeat(MAX_PASSWORD_BYTES)}中文` // 72 字节 + 6 字节
  assert(passwordByteLength(long) > MAX_PASSWORD_BYTES, '构造的样本应当超长')
  let thrown
  try {
    await hashPassword(long)
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof RangeError, `应抛 RangeError，实际 ${thrown?.name}`)
  assert(thrown.message.includes('72'), `报错应点明 72 字节上限，实际：${thrown.message}`)
  // 恰好 72 字节（多字节字符按字节算）应当放行 —— 边界不能"少一个也算超"
  const exact = '中'.repeat(24) // 24 × 3 = 72 字节
  assertEqual(passwordByteLength(exact), MAX_PASSWORD_BYTES, '样本字节数')
  assert((await hashPassword(exact)).length === 60, '恰好在上限的密码应可哈希')
})

await it('DUMMY_PASSWORD_HASH 是**结构合法**的摘要（等时比较的前提），且恒不匹配', async () => {
  // ⚠️ 实测：bcrypt 对结构非法的摘要 compare 会立刻返回 false（0ms）—— 那样就起不到等时作用
  assert(DUMMY_PASSWORD_HASH.startsWith(`$2b$${BCRYPT_COST}$`), '必须是 cost 12 的合法摘要')
  assertEqual(DUMMY_PASSWORD_HASH.length, 60, '摘要长度')
  assertEqual(await verifyPassword('', DUMMY_PASSWORD_HASH), false, '空密码不应匹配')
  assertEqual(await verifyPassword(DUMMY_PASSWORD_HASH, DUMMY_PASSWORD_HASH), false, '摘要自身不应匹配')
})

await it('摘要本身损坏时 verifyPassword 返回 false（不抛错，避免把脏数据包装成 500）', async () => {
  assertEqual(await verifyPassword('whatever', 'not-a-bcrypt-hash'), false, '非法摘要')
  assertEqual(await verifyPassword('whatever', ''), false, '空摘要')
})

// ── 11. 初始密码生成（P0-1-6；P0-1-8 建号用） ──
await it('初始密码：长度 / 无易混字符 / 三类字符齐备 / 每次不同', async () => {
  const samples = Array.from({ length: 30 }, () => generateInitialPassword())
  for (const password of samples) {
    assertEqual(password.length, INITIAL_PASSWORD_LENGTH, '长度')
    assert(/^[A-Za-z0-9]+$/.test(password), `应只含字母数字，实际 ${password}`)
    assert(/[0O1lI]/.test(password) === false, `不应含易混字符 0/O/1/l/I，实际 ${password}`)
    assert(/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password), `三类字符应齐备：${password}`)
  }
  assertEqual(new Set(samples).size, samples.length, '30 次生成应当互不相同')
  assertEqual(generateInitialPassword(8).length, 8, '显式长度参数应生效')
})

// ── 12. 会话的「未登录」出口（P0-1-6）：不碰依赖也必须稳定拒绝 ──
await it('未登录访问受保护路由 → 401 / UNAUTHORIZED（且**不依赖 Redis 可达**）', async () => {
  for (const url of ['/__verify/protected', '/__verify/admin-only']) {
    const response = await app.inject({ method: 'GET', url })
    assertEqual(response.statusCode, 401, `${url} 状态码`)
    const body = response.json()
    assertEqual(body.code, 'UNAUTHORIZED', `${url} 信封 code`)
    assert(typeof body.msg === 'string' && body.msg !== '', `${url} msg 不应为空`)
    // 无 Cookie 时**不该**去查会话存储：所以依赖不可达的环境（CI）里这条也必须是 401 而不是 500
  }
})

await it('伪造/过期会话 Cookie → 拒绝且**绝不放行**（有依赖时 401，依赖不可达时 500）', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/__verify/protected',
    headers: { cookie: 'doubulea_sid=not-a-real-session-token' },
  })
  assert(response.statusCode !== 200, '伪造的会话令牌竟然通过了鉴权')
  if (expectDegraded) {
    // 会话存储不可用 → 失败关闭（fail-closed）：语义是"服务端此刻给不出结论"，
    // 不是"你的凭据不对"，故 500 而非 401（`plugins/session.ts` 文件头「②」）。
    assertEqual(response.statusCode, 500, '依赖不可达时状态码')
    assertEqual(response.json().code, 'INTERNAL', '依赖不可达时信封 code')
  } else {
    assertEqual(response.statusCode, 401, 'Redis 可达但会话不存在时状态码')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
  }
})

// ── 13. 认证契约（P0-1-7）：路由已注册 + schema 生效 + 纯函数正确性 ──
await it('/api/auth/* 四个端点已注册（不再是 404 兜底），且请求体校验给出字段明细', async () => {
  const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })
  assertEqual(missing.statusCode, 400, '空 body 的状态码')
  const fields = missing.json().data.fields.map((field) => field.path)
  assert(fields.includes('body.username'), `应报出 body.username，实际 ${JSON.stringify(fields)}`)
  assert(fields.includes('body.password'), `应报出 body.password，实际 ${JSON.stringify(fields)}`)

  // 未登录的四个端点行为（都不需要数据库，因此在 CI 里也可断言）
  const me = await app.inject({ method: 'GET', url: '/api/auth/me' })
  assertEqual(me.statusCode, 401, '/api/auth/me 未登录状态码')
  const change = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    payload: { oldPassword: 'x'.repeat(9), newPassword: 'y'.repeat(9) },
  })
  assertEqual(change.statusCode, 401, '/api/auth/password 未登录状态码')
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' })
  assertEqual(logout.statusCode, 200, '/api/auth/logout 幂等状态码')
})

await it('首登闸门不给**匿名**请求增加依赖调用：/api/** 的公共路由在无 Cookie 时仍是 200', async () => {
  // 闸门若在无 Cookie 时也去查 Redis，依赖不可达的环境（CI）里这里会是 500。
  // 两种模式下都断言 200，等于把「匿名请求不碰会话存储」钉死。
  const response = await app.inject({ method: 'GET', url: '/api/__verify/open' })
  assertEqual(response.statusCode, 200, '状态码')
  assertEqual(response.json().data.open, true, '响应体')
})

await it('shared 的 utf8ByteLength 与 Buffer.byteLength 完全一致（前端要靠它算字节数）', async () => {
  const samples = ['', 'abc', '中文测试', '🔐🔐', 'a中🙂z', '中'.repeat(24), 'ünïcödé', '\u0000\u007f\u0080\u0800\uffff']
  for (const sample of samples) {
    const expected = Buffer.byteLength(sample, 'utf8')
    assertEqual(utf8ByteLength(sample), expected, `utf8ByteLength(${JSON.stringify(sample)})`)
  }
  assertEqual(utf8ByteLength('中'.repeat(24)), PASSWORD_MAX_BYTES, '24 个汉字应恰好等于 bcrypt 的 72 字节上限')
})

await it('normalizeUsername：去首尾空白 + 转小写（建号与登录必须共用同一口径）', async () => {
  assertEqual(normalizeUsername('  Alice  '), 'alice', '带空白与大写')
  assertEqual(normalizeUsername('admin'), 'admin', '已归一化的值不变')
  assertEqual(normalizeUsername('ADMIN@EXAMPLE'), 'admin@example', '含符号')
})

await it('登录/改密 schema：拒绝空值、过短、超字节数；接受合法输入', async () => {
  const badLogins = [
    ['空用户名', { username: '', password: 'x' }],
    ['空白用户名', { username: '   ', password: 'x' }],
    ['空密码', { username: 'a', password: '' }],
    ['缺字段', { username: 'a' }],
  ]
  for (const [label, payload] of badLogins) {
    assertEqual(loginBodySchema.safeParse(payload).success, false, `登录应拒绝：${label}`)
  }
  assertEqual(loginBodySchema.safeParse({ username: ' a ', password: 'p' }).success, true, '合法登录应通过')

  assertEqual(
    changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: 'short1' }).success,
    false,
    '改密应拒绝过短的新密码',
  )
  const tooLongBytes = '中'.repeat(25) // 75 字节
  assertEqual(
    changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: tooLongBytes }).success,
    false,
    '改密应拒绝超过 72 字节的新密码',
  )
  const result = changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: 'new-pass-1' })
  assertEqual(result.success, true, '合法改密应通过')

  // authUserSchema 是前后端共用的响应形态：能被解析才算契约一致
  const user = { id: 'x', username: 'a', nickname: null, role: 'ADMIN', mustChangePassword: false }
  assertEqual(authUserSchema.safeParse(user).success, true, 'authUserSchema 应接受典型响应体')
  assertEqual(authUserSchema.safeParse({ ...user, nickname: 1 }).success, false, 'authUserSchema 应拒绝非法 nickname')
})

// ── 14. 用户管理契约（P0-1-8）：路由已注册 + schema 生效 + 纯函数 ──
await it('/api/users 四个路由已注册：未登录一律 401（不碰数据库），非法参数 400 而不是 404', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/users' })
  assertEqual(anonymous.statusCode, 401, '列表未登录状态码')
  const missingId = await app.inject({
    method: 'PATCH',
    url: '/api/users/00000000-0000-7000-8000-000000000000',
    payload: { status: 'ACTIVE' },
  })
  assertEqual(missingId.statusCode, 401, 'PATCH 未登录状态码（说明路由存在、只是没登录）')
  const reset = await app.inject({
    method: 'POST',
    url: '/api/users/00000000-0000-7000-8000-000000000000/reset-password',
  })
  assertEqual(reset.statusCode, 401, '重置密码未登录状态码')
})

await it('用户管理请求体/路径参数校验：字段明细齐备（校验先于鉴权，故匿名下也能断言）', async () => {
  const emptyCreate = await app.inject({ method: 'POST', url: '/api/users', payload: {} })
  assertEqual(emptyCreate.statusCode, 400, '建号空 body 状态码')
  assert(
    emptyCreate.json().data.fields.some((field) => field.path === 'body.username'),
    '建号空 body 应报 body.username',
  )

  const emptyPatch = await app.inject({
    method: 'PATCH',
    url: '/api/users/00000000-0000-7000-8000-000000000000',
    payload: {},
  })
  assertEqual(emptyPatch.statusCode, 400, 'PATCH 空 body 状态码')

  const badUuid = await app.inject({
    method: 'PATCH',
    url: '/api/users/not-a-uuid',
    payload: { status: 'DISABLED' },
  })
  assertEqual(badUuid.statusCode, 400, '非法 uuid 状态码')
  assert(
    badUuid.json().data.fields.some((field) => field.path === 'params.id'),
    '应报 params.id',
  )

  const badEnum = await app.inject({
    method: 'PATCH',
    url: '/api/users/00000000-0000-7000-8000-000000000000',
    payload: { status: 'SUSPENDED' },
  })
  assertEqual(badEnum.statusCode, 400, '非法枚举状态码')
  assert(
    badEnum.json().data.fields.some((field) => field.path === 'body.status'),
    '应报 body.status',
  )
})

await it('shared 用户管理契约：建号/改角色/分页 schema 与列表响应形态', async () => {
  // 建号：用户名不能含空白（会抄错）、nickname 空串按"没填"处理、role 可缺省
  assertEqual(createUserBodySchema.safeParse({ username: 'a b' }).success, false, '含空格的用户名应被拒')
  assertEqual(createUserBodySchema.safeParse({ username: '   ' }).success, false, '纯空白应被拒')
  const created = createUserBodySchema.safeParse({ username: '  Alice  ', nickname: '' })
  assertEqual(created.success, true, '合法建号应通过')
  assertEqual(created.data?.username, 'Alice', 'trim 后保留原样（归一化在服务层做）')
  assertEqual(created.data?.nickname, undefined, '空串 nickname 应被视为未填')

  // 改角色：至少要给一个字段
  assertEqual(updateUserBodySchema.safeParse({}).success, false, '空 body 应被拒')
  assertEqual(updateUserBodySchema.safeParse({ status: 'DISABLED' }).success, true, '只给 status 应通过')
  assertEqual(updateUserBodySchema.safeParse({ role: 'OWNER' }).success, false, '非法 role 应被拒')

  // 分页：coerce + 默认值 + 上限
  const query = listUsersQuerySchema.parse({})
  assertEqual(query.offset, 0, 'offset 默认值')
  assertEqual(query.limit, 20, 'limit 默认值')
  assertEqual(listUsersQuerySchema.safeParse({ limit: '999' }).success, false, 'limit 超上限应被拒')
  assertEqual(listUsersQuerySchema.parse({ limit: '5' }).limit, 5, 'limit 应被 coerce')

  // 响应形态：三个 schema 能解析同构数据
  const item = {
    id: 'x',
    username: 'a',
    nickname: null,
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  }
  assertEqual(userListItemSchema.safeParse(item).success, true, 'userListItemSchema')
  assertEqual(
    initialPasswordResultSchema.safeParse({ user: item, initialPassword: 'Abc123456789012345' }).success,
    true,
    'initialPasswordResultSchema',
  )
  assertEqual(
    offsetPageOf(userListItemSchema).safeParse({ items: [item], total: 1, offset: 0, limit: 20 }).success,
    true,
    '列表分页 schema',
  )
})

// ── 15. 模型池 Provider 契约（P0-1-10）──
await it('maskApiKey：长 key 给「前3+****+后4」、短 key 只露尾巴、极短直接全遮', () => {
  assertEqual(maskApiKey('sk-1234567890abcdef'), 'sk-****cdef', '19 字符 → 前3+****+后4')
  assertEqual(maskApiKey('a'.repeat(16)), 'aaa****aaaa', '恰好 16 字符是临界点（含）')
  assertEqual(maskApiKey('abcdefgh'), '****efgh', '8 字符 → 只露尾巴')
  assertEqual(maskApiKey('abcdefg'), '****', '7 字符 → 全遮')
  assertEqual(maskApiKey(''), '****', '空串 → 全遮（不报错）')

  // 关键性质：中间段**一个字都不能露** —— 掩码的用途是"认出是哪把 key"，不是"拼回去"。
  // ⚠️ 只比对**字母数字**：key 里常带 `-`/`_` 这类分隔符，它们本来就会出现在首/尾里，
  //    拿"字符集不相交"去断言会误报（第一版就这么写成假失败了）。
  const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const masked = maskApiKey(key)
  const alnum = (text) => text.replace(/[^A-Za-z0-9]/g, '')
  const hiddenMiddle = alnum(key.slice(3, key.length - 4))
  assert(masked.length < key.length / 2, `掩码应显著短于原文：${masked.length} vs ${key.length}`)
  assert(
    [...new Set(hiddenMiddle)].every((ch) => !masked.includes(ch)),
    `掩码不得含中间段的任何字母数字，实际 ${masked}（中间段 ${hiddenMiddle}）`,
  )
  assert(!masked.includes(alnum(key).slice(5, 20)), '掩码不得含中间段的连续片段')
})

await it('Provider 路由已注册且仅 ADMIN：未登录 401；非法参数 400（校验先于鉴权，故匿名下可断言）', async () => {
  // 已注册：不再走 404 兜底 —— 若无 Cookie 得到 401 而不是 404，即证明路由存在
  const list = await app.inject({ method: 'GET', url: '/api/model-providers' })
  assertEqual(list.statusCode, 401, '未登录访问列表')
  assertEqual(list.json().code, 'UNAUTHORIZED', '列表错误码')

  // 校验先于 preHandler：所以匿名 + 非法 body 得到的是 400（带字段明细）而不是 401
  const badBody = await app.inject({
    method: 'POST',
    url: '/api/model-providers',
    payload: { name: '', baseUrl: 'not-a-url', type: 'RERANK' },
  })
  assertEqual(badBody.statusCode, 400, '非法 body 状态码')
  const fields = badBody.json().data?.fields ?? []
  const paths = fields.map((field) => field.path)
  assert(paths.includes('body.name'), `应报 body.name，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.baseUrl'), `应报 body.baseUrl，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.type'), `应报 body.type，实际 ${JSON.stringify(paths)}`)

  const badId = await app.inject({ method: 'DELETE', url: '/api/model-providers/not-a-uuid' })
  assertEqual(badId.statusCode, 400, '非法 UUID 状态码')
  assert(
    JSON.stringify(badId.json().data?.fields ?? []).includes('params.id'),
    '应报 params.id',
  )
})

await it('shared Provider 契约：baseUrl 归一化 / 空 apiKey 被拒 / PATCH 三态保住 undefined 与 null', () => {
  // baseUrl：尾斜杠归一化（将来拼 /chat/completions 不能出现 //）、必须 http(s)、必须是真 URL
  const trimmed = createModelProviderBodySchema.safeParse({
    name: 'x',
    baseUrl: 'https://api.openai.com/v1///',
    type: 'CHAT',
  })
  assertEqual(trimmed.success, true, '合法地址应通过')
  assertEqual(trimmed.data?.baseUrl, 'https://api.openai.com/v1', '尾部斜杠应被去掉')
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'ftp://a.com', type: 'CHAT' }).success,
    false,
    '非 http(s) 应被拒',
  )
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'https://', type: 'CHAT' }).success,
    false,
    '只有 scheme 应被拒',
  )
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'https://a.com', type: 'RERANK' }).success,
    false,
    'type 取值域只有 CHAT/EMBEDDING',
  )

  // 建：apiKey 缺省 = 不配置；显式 null 与缺省同义（都保留 null / undefined 原样）
  const noKey = createModelProviderBodySchema.parse({ name: 'x', baseUrl: 'https://a.com', type: 'CHAT' })
  assertEqual(noKey.apiKey, undefined, '缺省 apiKey 应是 undefined')
  assertEqual(
    createModelProviderBodySchema.parse({ name: 'x', baseUrl: 'https://a.com', type: 'CHAT', apiKey: null }).apiKey,
    null,
    'apiKey: null 应保留 null',
  )
  // 空串不是"清空"的写法 —— 契约只留 undefined / null 两条路，避免"到底清没清"的歧义
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'https://a.com', type: 'CHAT', apiKey: '' }).success,
    false,
    '空串 apiKey 应被拒',
  )

  // ⭐ PATCH 三态：这是本批最容易写错的地方（写错 → 改个名字顺手把 Key 抹了）
  assertEqual(updateModelProviderBodySchema.safeParse({}).success, false, '空 body 应被拒')
  const absent = updateModelProviderBodySchema.parse({ name: '新名字' })
  assertEqual(absent.apiKey, undefined, '不带 apiKey = 不动（必须是 undefined，不能被 default 成 null）')
  const cleared = updateModelProviderBodySchema.parse({ apiKey: null })
  assertEqual(cleared.apiKey, null, 'apiKey: null = 清空（且 null 本身要算"给了字段"）')
  const replaced = updateModelProviderBodySchema.parse({ apiKey: 'sk-new' })
  assertEqual(replaced.apiKey, 'sk-new', 'apiKey: 字符串 = 写入')
  assertEqual(updateModelProviderBodySchema.safeParse({ apiKey: '' }).success, false, 'PATCH 空串同样被拒')
  // enabled 的三种取值（真/假/不给）都要能过 —— 它是最常用的开关
  assertEqual(updateModelProviderBodySchema.parse({ enabled: false }).enabled, false, 'enabled: false 应保留')
})

await it('Provider Key 的密文绑定到记录（AAD）：换个 providerId 就解不开，不能跨记录搬运', () => {
  const idA = '01a0c289-6738-715c-a10c-ef95c1286bf9'
  const idB = '01a0c289-6831-76ab-b7d9-65e991557ba1'
  // AAD 公式本身是契约（写/读两侧共用同一个函数，这里把公式也钉住）
  assertEqual(providerKeyAad(idA), `model-providers:${idA}.api_key_enc`, 'AAD 公式')

  const plaintext = 'sk-proj-ThisIsOnlyATestKey-0123456789'
  const cipher = encryptSecret(plaintext, providerKeyAad(idA))
  assertEqual(decryptSecret(cipher, providerKeyAad(idA)), plaintext, '同一记录的密文应能解回')
  assert(!cipher.includes(plaintext), '密文里不得出现明文')

  let wrongContextThrew = false
  try {
    decryptSecret(cipher, providerKeyAad(idB))
  } catch (error) {
    wrongContextThrew = error instanceof SecretDecryptionError
  }
  assert(wrongContextThrew, '换成另一个 Provider 的 AAD 必须抛 SecretDecryptionError')

  // 不带 AAD（旧式/裸用）同样解不开 —— 防"某处忘了传 context"而静默可用
  let noContextThrew = false
  try {
    decryptSecret(cipher)
  } catch (error) {
    noContextThrew = error instanceof SecretDecryptionError
  }
  assert(noContextThrew, '漏传 AAD 必须解不开（否则 AAD 形同虚设）')
})

await it('shared Provider 输出形态：只含掩码与 hasKey，无任何 apiKey 字段；列表分页同构', () => {
  const now = new Date().toISOString()
  const item = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    type: 'CHAT',
    enabled: true,
    hasKey: true,
    apiKeyPreview: 'sk-****cdef',
    modelCount: 3,
    createdAt: now,
    updatedAt: now,
  }
  assertEqual(modelProviderItemSchema.safeParse(item).success, true, 'item schema')
  assertEqual(
    modelProviderItemSchema.safeParse({ ...item, apiKeyPreview: null, hasKey: false }).success,
    true,
    '未配置 Key 时 hasKey=false / apiKeyPreview=null',
  )
  assertEqual(
    modelProviderItemSchema.safeParse({ ...item, type: 'EMBEDDING' }).success,
    true,
    'EMBEDDING 也是合法类型',
  )
  // 形态自检：schema 的键集合里**不允许**出现任何 apiKey* 以外的敏感名
  const keys = Object.keys(modelProviderItemSchema.shape)
  assert(!keys.includes('apiKey'), `输出形态不得含 apiKey，实际键：${keys.join(',')}`)
  assert(!keys.some((key) => key.toLowerCase().includes('enc')), `输出形态不得含密文字段：${keys.join(',')}`)

  assertEqual(
    listModelProvidersQuerySchema.parse({}).limit,
    20,
    '列表 limit 默认值应与其它列表一致',
  )
  assertEqual(
    offsetPageOf(modelProviderItemSchema).safeParse({ items: [item], total: 1, offset: 0, limit: 20 }).success,
    true,
    '列表分页 schema',
  )
})

// ── 16. 模型契约与路由分流（P0-1-11）──
await it('两条路径各自注册、互不遮蔽：/api/models 与 /api/models/available 都是真路由（不是 404 兜底）', async () => {
  // 注册层面就断言"路径确实不同"：同路径两个 GET 会让 Fastify 在**启动期**抛
  // `FST_ERR_DUPLICATED_ROUTE`（已实测），所以这里能挂上就说明分流是干净的
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/models' }), true, '管理列表路由')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/models/available' }), true, '可选列表路由')
  // `GET /api/models/:id` **不该**存在（只有 PATCH/DELETE）：否则"取单条模型"会成为一个
  // 没人设计过的端点。用一条合法 UUID 打过去，期望 404 兜底
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/models/:id' }), false, '不应有单条 GET')

  // 校验先于鉴权（Fastify 生命周期：validation → preHandler），所以匿名请求也能验 schema 是否接线
  const missingType = await app.inject({ method: 'GET', url: '/api/models/available' })
  assertEqual(missingType.statusCode, 400, 'available 缺 type 的状态码')
  const typeFields = missingType.json().data?.fields ?? []
  const fieldPaths = typeFields.map((field) => field.path)
  assert(
    fieldPaths.includes('querystring.type'),
    `应报 querystring.type（说明 type 真的是必填），实际 ${JSON.stringify(fieldPaths)}`,
  )
  // 文案也要说清"必填"：zod v3 里 `required_error` 与自定义 errorMap 互斥
  // （同时给会在**模块加载期**抛错），所以这句文案是 errorMap 分派 `invalid_type` 产出的 ——
  // 断言它在，等于守住了"必填语义没有被降级成通用的类型错误"
  const missingTypeMessage = typeFields.find((field) => field.path === 'querystring.type')?.message ?? ''
  assert(
    missingTypeMessage.includes('必填'),
    `缺 type 的文案应说明"必填"，实际：${missingTypeMessage}`,
  )

  const badType = await app.inject({ method: 'GET', url: '/api/models/available?type=chat' })
  assertEqual(badType.statusCode, 400, 'type 大小写敏感（枚举是大写）')
  const badTypeMessage =
    (badType.json().data?.fields ?? []).find((field) => field.path === 'querystring.type')?.message ?? ''
  assert(
    badTypeMessage.includes('CHAT/EMBEDDING'),
    `大小写写错时应提示合法取值，实际：${badTypeMessage}`,
  )

  // schema 通过后才轮到鉴权：401 说明这条路由**真的走到了自己的 preHandler**
  // （若被 `/api/models/:id` 吞掉，这里会是 400「模型 ID 不是合法 UUID」）
  const anonymousAvailable = await app.inject({ method: 'GET', url: '/api/models/available?type=CHAT' })
  assertEqual(anonymousAvailable.statusCode, 401, 'available 匿名状态码')
  assertEqual(anonymousAvailable.json().code, 'UNAUTHORIZED', 'available 匿名错误码')

  const anonymousManage = await app.inject({ method: 'GET', url: '/api/models' })
  assertEqual(anonymousManage.statusCode, 401, '管理列表匿名状态码（校验通过后落到鉴权）')

  // GET 未注册在 `:id` 上 → 404 兜底（而不是被 PATCH/DELETE 的 schema 误判成 400）
  const noSingleGet = await app.inject({
    method: 'GET',
    url: '/api/models/01a0c289-6738-715c-a10c-ef95c1286bf9',
  })
  assertEqual(noSingleGet.statusCode, 404, 'GET 单条模型状态码')
  assertEqual(noSingleGet.json().code, 'NOT_FOUND', 'GET 单条模型错误码')
})

await it('shared 模型契约：type 必填 / 型号名与别名纪律 / maxContext 三态 / 分页过滤', () => {
  // `available` 的 type 必填：它的唯一用途是填"选模型"的下拉，而对话模型与向量模型不可互换
  const noType = listAvailableModelsQuerySchema.safeParse({})
  assertEqual(noType.success, false, 'available 必须要求 type')
  assertEqual(listAvailableModelsQuerySchema.safeParse({ type: 'CHAT' }).success, true, 'CHAT 合法')
  assertEqual(
    listAvailableModelsQuerySchema.safeParse({ type: 'EMBEDDING' }).success,
    true,
    'EMBEDDING 合法',
  )

  // 管理列表：默认值 + `enabled` 从查询串转布尔（`?enabled=false` 是字符串 "false"）
  const pageDefaults = listModelsQuerySchema.parse({})
  assertEqual(pageDefaults.offset, 0, 'offset 默认值')
  assertEqual(pageDefaults.limit, 20, 'limit 默认值应与其它列表一致')
  assertEqual(listModelsQuerySchema.parse({ enabled: 'true' }).enabled, true, 'enabled=true 应转布尔')
  assertEqual(listModelsQuerySchema.parse({ enabled: 'false' }).enabled, false, 'enabled=false 应转布尔')
  assertEqual(listModelsQuerySchema.safeParse({ enabled: '1' }).success, false, 'enabled 只认 true/false')
  assertEqual(listModelsQuerySchema.safeParse({ providerId: 'not-a-uuid' }).success, false, 'providerId 要 UUID')
  assertEqual(listModelsQuerySchema.safeParse({ limit: 101 }).success, false, 'limit 上限 100')

  // 建模型：型号名 trim + 拒内部空白；别名可中文；maxContext 边界
  const named = createModelBodySchema.safeParse({
    providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    modelName: '  gpt-4o-mini\n',
    label: '  小钢炮  ',
    type: 'CHAT',
  })
  assertEqual(named.success, true, '合法建模型请求应通过')
  assertEqual(named.data?.modelName, 'gpt-4o-mini', '型号名应 trim（粘贴常带空格/换行）')
  assertEqual(named.data?.label, '小钢炮', '别名应 trim（可中文）')
  // 默认值走服务层而不是 schema：`supportsVision`/`enabled` 缺席时必须是 `undefined`，
  // 否则服务层没法区分"调用方没给"与"调用方给了 false"
  assertEqual(named.data?.supportsVision, undefined, 'supportsVision 缺席应保持 undefined')
  assertEqual(named.data?.enabled, undefined, 'enabled 缺席应保持 undefined')
  assertEqual(named.data?.maxContext, undefined, 'maxContext 缺席应保持 undefined')

  const base = { providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9', label: 'x', type: 'CHAT' }
  assertEqual(
    createModelBodySchema.safeParse({ ...base, modelName: 'gpt 4o' }).success,
    false,
    '型号名不得含空格（上游 model id 不含空格，放行只会把错误推迟到调上游时）',
  )
  assertEqual(createModelBodySchema.safeParse({ ...base, modelName: '' }).success, false, '型号名不得为空')
  assertEqual(createModelBodySchema.safeParse({ ...base, modelName: 'a'.repeat(129) }).success, false, '型号名 128 上限')
  assertEqual(createModelBodySchema.safeParse({ ...base, modelName: 'm', maxContext: 0 }).success, false, 'maxContext 至少 1')
  assertEqual(
    createModelBodySchema.safeParse({ ...base, modelName: 'm', maxContext: 10_000_001 }).success,
    false,
    'maxContext 上限',
  )
  assertEqual(
    createModelBodySchema.safeParse({ ...base, modelName: 'm', maxContext: 128_000 }).data?.maxContext,
    128_000,
    'maxContext 正常值应保留',
  )
})

await it('shared 模型契约：PATCH 的 maxContext 三态 + 空改动被拒 + 多余键不会静默通过', () => {
  assertEqual(updateModelBodySchema.safeParse({}).success, false, '空改动应被拒（至少一个字段）')
  // 三态：缺席 = 不动（`undefined`）、`null` = 清空。二者的区分是这一层的核心职责
  const untouched = updateModelBodySchema.safeParse({ label: '改个名' })
  assertEqual(untouched.success, true, '只改别名合法')
  assertEqual(untouched.data?.maxContext, undefined, '不带 maxContext 时应保持 undefined（= 不动）')
  const cleared = updateModelBodySchema.safeParse({ maxContext: null })
  assertEqual(cleared.success, true, 'maxContext=null 是"清空"，算一次合法改动')
  assertEqual(cleared.data?.maxContext, null, 'maxContext=null 必须原样保留')
  assertEqual(
    updateModelBodySchema.safeParse({ maxContext: 4096 }).data?.maxContext,
    4096,
    'maxContext 数字应保留',
  )

  // `providerId` 在契约里（为的是能把"想迁移"这种无效意图变成显式 409，而不是被静默剥掉）
  assertEqual(
    updateModelBodySchema.safeParse({ providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9' }).success,
    true,
    'providerId 应在契约内（值不同时由服务层 409）',
  )

  // 与 `providerId` 相反：**完全不存在**的键会被 zod 剥掉，剥完等于没给字段 → 被 refine 拒掉。
  // 这条断言把"静默 no-op"钉死：`{"foo": 1}` 不会返回 200 让人以为改成功了
  assertEqual(updateModelBodySchema.safeParse({ foo: 1 }).success, false, '未知键不该静默通过')
})

await it('shared 模型两套投影：键集合互不串味（管理面有 agentCount，可选面不该有）', () => {
  const now = new Date().toISOString()
  const item = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    providerId: '01a0c289-6738-715c-a10c-ef95c1286bf8',
    providerName: 'OpenAI',
    providerEnabled: true,
    modelName: 'gpt-4o-mini',
    label: '小钢炮',
    type: 'CHAT',
    maxContext: 128_000,
    supportsVision: true,
    enabled: true,
    agentCount: 2,
    createdAt: now,
    updatedAt: now,
  }
  assertEqual(modelItemSchema.safeParse(item).success, true, '管理投影 schema')
  assertEqual(
    modelItemSchema.safeParse({ ...item, maxContext: null }).success,
    true,
    'maxContext 可为 null（未填写）',
  )
  assertEqual(modelItemSchema.safeParse({ ...item, type: 'EMBEDDING' }).success, true, 'EMBEDDING 合法')

  const option = {
    id: item.id,
    providerId: item.providerId,
    providerName: item.providerName,
    modelName: item.modelName,
    label: item.label,
    type: 'CHAT',
    maxContext: 128_000,
    supportsVision: true,
  }
  assertEqual(modelOptionSchema.safeParse(option).success, true, '可选投影 schema')
  // 可选投影**故意**不含 enabled：按定义只含"能选的"，再下发一个恒为 true 的字段
  // 只会诱使前端写 `if (option.enabled)` 这种永远为真的分支
  const optionKeys = Object.keys(modelOptionSchema.shape)
  for (const forbidden of ['enabled', 'agentCount', 'createdAt', 'updatedAt']) {
    assert(!optionKeys.includes(forbidden), `可选投影不得含 ${forbidden}，实际键：${optionKeys.join(',')}`)
  }
  // 两套投影必须真的不同（否则"拆两条路径"就白拆了）
  const itemKeys = Object.keys(modelItemSchema.shape)
  assert(itemKeys.includes('agentCount'), `管理投影应含 agentCount，实际：${itemKeys.join(',')}`)
  assert(itemKeys.includes('providerEnabled'), `管理投影应含 providerEnabled，实际：${itemKeys.join(',')}`)

  assertEqual(
    modelOptionListResultSchema.safeParse({ items: [option] }).success,
    true,
    '可选列表响应形态',
  )
  assertEqual(
    offsetPageOf(modelItemSchema).safeParse({ items: [item], total: 1, offset: 0, limit: 20 }).success,
    true,
    '管理列表分页形态',
  )
})

// ── 17. LLM client 契约与路由（P0-1-12）──
await it('拉取上游模型列表的路由已注册（子路径，不是查询参数分流）：匿名 401、非法 UUID 400', async () => {
  const route = '/api/model-providers/:id/remote-models'
  assertEqual(app.hasRoute({ method: 'GET', url: route }), true, '路由应已注册')
  // 与 P0-1-11 同一条结论：同路径同方法注册两次会在**启动期**抛错，所以这里挂得上
  // 就说明它是独立子路径，而不是跟 `GET /api/model-providers` 抢同一个 handler
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/model-providers' }), true, '列表路由仍在')

  // 校验先于鉴权（validation → preHandler），所以匿名也能验 schema 是否接线
  const badUuid = await app.inject({ method: 'GET', url: '/api/model-providers/not-a-uuid/remote-models' })
  assertEqual(badUuid.statusCode, 400, '非法 UUID 的状态码')

  // schema 通过后才轮到鉴权：401 说明它真的走到了自己的 preHandler
  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/model-providers/01a0c289-6738-715c-a10c-ef95c1286bf9/remote-models',
  })
  assertEqual(anonymous.statusCode, 401, '匿名状态码（仅 ADMIN 的端点）')
  assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名错误码')
})

await it('shared 上游模型列表契约：形态与取值域 + 键集合不含任何凭据名', () => {
  const sample = {
    providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    providerName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    total: 2,
    truncated: false,
    items: [
      { id: 'bge-m3', ownedBy: null, created: null },
      { id: 'gpt-4o-mini', ownedBy: 'system', created: 1_700_000_000 },
    ],
  }
  assertEqual(remoteModelListResultSchema.safeParse(sample).success, true, '标准形态应通过')
  assertEqual(
    remoteModelListResultSchema.safeParse({ ...sample, items: [{ id: 'x' }] }).success,
    false,
    '缺 ownedBy/created 应被拒（服务层负责补 null，而不是让前端判 undefined）',
  )
  assertEqual(
    remoteModelListResultSchema.safeParse({ ...sample, total: -1 }).success,
    false,
    'total 不能为负',
  )
  assertEqual(
    remoteModelListResultSchema.safeParse({ ...sample, truncated: 'yes' }).success,
    false,
    'truncated 必须是布尔（"被截断了多少"这种事不许用字符串糊过去）',
  )
  // 键级自检：与 Provider 的读接口同一条不变式（`02` §十：Key 有进无出）
  const keys = Object.keys(remoteModelListResultSchema.shape)
  for (const forbidden of ['apiKey', 'apiKeyEnc', 'apiKeyPreview', 'hasKey', 'authorization']) {
    assert(!keys.includes(forbidden), `该响应不得含凭据类键 ${forbidden}，实际：${keys.join(',')}`)
  }
})

// ── 17. 知识库契约与路由（P0-1-15）──
await it('知识库五条路由已注册，且**刻意没有** /available 子路径（本资源对全员开放，不需要第二套投影）', async () => {
  // `02` §4.6 的 CRUD 四端点 + `GET /:id` 详情
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/knowledge-bases' }), true, '列表路由')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id' }), true, '详情路由')
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/knowledge-bases' }), true, '建库路由')
  assertEqual(app.hasRoute({ method: 'PATCH', url: '/api/knowledge-bases/:id' }), true, '改库路由')
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/knowledge-bases/:id' }), true, '删库路由')
  // 与 `/api/models/available` 的对照：模型池的管理列表是 ADMIN 专属，所以必须另开一条全员可读的；
  // 知识库列表**本来就对全员开放**（`03` §25 的权限列是「登录」），再开一条就是多余的第二个真相
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/available' }),
    false,
    '不应存在 /available（本资源无需拆投影）',
  )

  // 匿名：校验先于鉴权，所以先看到 400（非法 UUID）再看到 401（鉴权）
  const badId = await app.inject({ method: 'GET', url: '/api/knowledge-bases/not-a-uuid' })
  assertEqual(badId.statusCode, 400, '非法 UUID 的状态码')
  assertEqual(
    (badId.json().data?.fields ?? []).some((field) => field.path === 'params.id'),
    true,
    '应报 params.id（说明路径参数 schema 真的接线了）',
  )

  const anonymous = await app.inject({ method: 'GET', url: '/api/knowledge-bases' })
  assertEqual(anonymous.statusCode, 401, '匿名列表状态码')
  assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名列表错误码')
})

await it('shared 知识库契约：retrieval_config 补默认值（唯一入口）与建/改 schema 纪律', () => {
  // ① 规范默认值 = `子方案①` §二 的"完整形状"（6 键）—— 与 DB 默认值必须是同一组值
  assertEqual(Object.keys(DEFAULT_RETRIEVAL_CONFIG).length, 6, '默认形状应有 6 个键')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.topK, 5, '默认 topK')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.score, 0.3, '默认 score')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.mode, 'HYBRID', '默认 mode')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.splitStrategy, 'hybrid', '默认 splitStrategy')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.rrfK, 60, '默认 rrfK')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.weights.vector, 1, '默认向量权重')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.weights.fulltext, 1, '默认全文权重')

  // ② **逐键兜底**（这是它的核心契约）：整体缺失、空对象、缺一半、类型错、越界值 —— 都要给出完整形状
  for (const broken of [
    undefined,
    null,
    {},
    { topK: 10 }, // 只给一个键（PATCH 局部写入的典型形态）
    { topK: 'abc', score: null, mode: 'NOPE', splitStrategy: 42, rrfK: {}, weights: 'x' },
    { topK: 0, score: 5, mode: 'VECTOR', splitStrategy: 'fixed', rrfK: 99999, weights: { vector: -1 } },
    'not-an-object',
    [1, 2, 3],
  ]) {
    const normalized = normalizeRetrievalConfig(broken)
    const parsed = retrievalConfigInputSchema.safeParse(normalized)
    assertEqual(
      parsed.success,
      true,
      `坏数据 ${JSON.stringify(broken)} 归一后必须仍符合契约，实际 ${JSON.stringify(normalized)}`,
    )
    // 越界值**退回默认**而不是 clamp：5 → 1 会被误读成"用户就是要 1"
    if (typeof broken === 'object' && broken !== null && !Array.isArray(broken) && broken.score === 5) {
      assertEqual(normalized.score, DEFAULT_RETRIEVAL_CONFIG.score, '越界 score 应退回默认值')
    }
    if (typeof broken === 'object' && broken !== null && !Array.isArray(broken) && broken.mode === 'VECTOR') {
      assertEqual(normalized.mode, 'VECTOR', '合法 mode 应被保留')
    }
  }
  // `patch` 的优先级必须**高于** `base`（建库时把请求体叠到环境默认值上、改库时叠到当前值上）——
  // 反了的话症状很隐蔽：接口 200、响应看着正常，但**用户改的值被静默丢弃**（这条断言就是盯它）
  assertEqual(normalizeRetrievalConfig({ topK: 99 }, { topK: 7 }).topK, 7, 'patch 应压过 base')
  assertEqual(
    normalizeRetrievalConfig({ topK: 6, score: 0.5 }, { score: 0.9 }).topK,
    6,
    'patch 没给的键应保留 base 的值（改一半不能把另一半打回默认）',
  )
  assertEqual(
    normalizeRetrievalConfig({ weights: { vector: 2, fulltext: 3 } }, { weights: { vector: 9, fulltext: 3 } })
      .weights.vector,
    9,
    'weights 也应按键合并',
  )

  // ③ 建库：四项全可省（`子方案①` §十一：建库时快照环境默认值）
  assertEqual(createKnowledgeBaseBodySchema.safeParse({ name: '只给名字' }).success, true, '只给 name 应通过')
  assertEqual(createKnowledgeBaseBodySchema.safeParse({}).success, false, '缺 name 应被拒')
  assertEqual(createKnowledgeBaseBodySchema.safeParse({ name: '   ' }).success, false, '空白 name 应被拒')
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'x'.repeat(129) }).success,
    false,
    'name 超 128 应被拒（列是 VARCHAR(128)）',
  )
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'n', retrievalConfig: { mode: 'vector' } }).success,
    false,
    'mode 枚举是大写，小写应被拒',
  )
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'n', chunkSize: 8193 }).success,
    false,
    'chunkSize 超 8192 应被拒（单位是字符，超上限只可能来自单位误解）',
  )
  // weights 要么都给、要么都不给
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'n', retrievalConfig: { weights: { vector: 1 } } }).success,
    false,
    'weights 给一半应被拒（另一半会静默取默认值，像"设了没生效"）',
  )

  // ④ 改库：`description` 三态 —— 不带 / null（清空）/ 字符串，三者必须可区分
  const patch = updateKnowledgeBaseBodySchema
  assertEqual(patch.safeParse({}).success, false, '空改动应被拒')
  const untouched = patch.safeParse({ name: 'x' })
  assertEqual(untouched.success, true, '只改 name 应通过')
  assertEqual(
    Object.prototype.hasOwnProperty.call(untouched.data, 'description'),
    false,
    '不带 description 时该键**不应存在**（存在且为 undefined 都是"不动"的另一种写法，会误导服务层）',
  )
  const cleared = patch.safeParse({ description: null })
  assertEqual(cleared.success, true, 'null 描述应通过（= 清空）')
  assertEqual(cleared.data.description, null, 'null 必须原样保留（不能被 default 吃掉）')

  // ⑤ 输出投影：`embeddingModelChanged` 是三态（null = provider 未就绪、无法判定）
  const sample = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    name: '示例库',
    description: null,
    embeddingModel: 'api:bge-m3',
    embeddingModelChanged: null,
    chunkSize: 512,
    chunkOverlap: 64,
    retrievalConfig: DEFAULT_RETRIEVAL_CONFIG,
    documentCount: 0,
    agentCount: 0,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
  assertEqual(knowledgeBaseItemSchema.safeParse(sample).success, true, '列表项 schema')
  assertEqual(
    knowledgeBaseItemSchema.safeParse({ ...sample, embeddingModelChanged: 'no' }).success,
    false,
    'embeddingModelChanged 必须是布尔或 null（不许用字符串糊过去）',
  )
  assertEqual(
    knowledgeBaseListResultSchema.safeParse({ items: [sample], total: 1, offset: 0, limit: 20 }).success,
    true,
    '分页响应同构',
  )
})

// ── 18. 文档上传：路由 + 前置校验四道 + 解析契约（P0-1-16）──
await it('文档上传路由已注册且**只有这一条**：非法 UUID 400、匿名 401（校验先于鉴权，都不碰依赖）', async () => {
  // `02` §4.6：上传挂在知识库下的子路径
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents' }), true, '上传路由')
  // 列表（P0-1-21）、下载（P0-1-21）、reupload/retry/delete（P0-1-19）都还不该存在：
  // 提前注册一条"返回空列表"的 GET 会让"上传成功但列表里没有"被当成已交付
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id/documents' }),
    false,
    '列表端点属 P0-1-21，本批不应存在',
  )

  const badId = await app.inject({ method: 'POST', url: '/api/knowledge-bases/not-a-uuid/documents' })
  assertEqual(badId.statusCode, 400, '非法 UUID 的状态码')
  assertEqual(
    (badId.json().data?.fields ?? []).some((field) => field.path === 'params.id'),
    true,
    '应报 params.id（路径参数 schema 真的接线了）',
  )

  // 无 Cookie ⇒ `requireAuth` 直接拒绝，**不去查会话存储** ⇒ CI（无 Redis）里也必须是 401 而不是 500。
  // body 用 JSON 而非 multipart：鉴权在 `preHandler`，早于 handler 里的 `request.file()`，
  // 所以这条断言验的是"闸门在不在"，与 multipart 解析无关（那条路在 verify-documents 里验）。
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/knowledge-bases/01a0c289-6738-715c-a10c-ef95c1286bf9/documents',
    payload: {},
  })
  assertEqual(anonymous.statusCode, 401, '匿名上传状态码')
  assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名上传错误码')
})

await it('前置校验的纯函数矩阵：白名单 / .doc 专拦 / MIME 交叉 / **文件头魔数**（改名的假 PDF 必须被拦）', () => {
  // ── 夹具：只用几十字节的手工字节串，不依赖 scripts/fixtures 的生成器 ──
  const TEXT = Buffer.from('这是一个纯文本文件\n第二行', 'utf8')
  const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'latin1')
  const ZIP_OOXML = Buffer.concat([
    Buffer.from('PK\x03\x04', 'latin1'),
    Buffer.alloc(20),
    Buffer.from('[Content_Types].xml', 'latin1'),
  ])
  const ZIP_PLAIN = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64, 0x41)])
  const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(32)])
  const OLE2 = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(32),
  ])

  /** 断言"这一组输入必须以 VALIDATION 被拒，且文案里含某个关键字" */
  const rejected = (input, includes, label) => {
    let error = null
    try {
      detectFormat(input)
    } catch (caught) {
      error = caught
    }
    assert(error !== null, `${label}：本应被拒，却通过了`)
    assertEqual(error.code, 'VALIDATION', `${label}：错误码`)
    assert(
      String(error.message).includes(includes),
      `${label}：文案应含「${includes}」，实际「${error.message}」`,
    )
  }

  // ── 通过的四条（含大小写扩展名与 octet-stream 放行）──
  assertEqual(detectFormat({ fileName: 'a.txt', declaredMime: 'text/plain', bytes: TEXT }), 'txt', 'txt')
  assertEqual(detectFormat({ fileName: '读我.MD', bytes: TEXT }), 'md', '大写扩展名应归一化')
  assertEqual(
    detectFormat({ fileName: 'a.pdf', declaredMime: 'application/pdf', bytes: PDF }),
    'pdf',
    'pdf',
  )
  // `application/octet-stream` = 客户端"我不知道"，不是矛盾声明 ⇒ 放行（否则 curl -F 传不了）
  assertEqual(
    detectFormat({ fileName: 'a.pdf', declaredMime: 'application/octet-stream', bytes: PDF }),
    'pdf',
    'octet-stream 应放行',
  )
  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  assertEqual(detectFormat({ fileName: 'a.docx', declaredMime: docxMime, bytes: ZIP_OOXML }), 'docx', 'docx')

  // ── ① 扩展名白名单 + `.doc` 专拦（验收原文：400 + 「请另存为 .docx 后重传」）──
  assertEqual(LEGACY_DOC_HINT, '请另存为 .docx 后重传', '`.doc` 的提示文案（前后端共用同一句）')
  rejected({ fileName: '老合同.doc', declaredMime: 'application/msword', bytes: OLE2 }, LEGACY_DOC_HINT, '.doc')
  rejected({ fileName: 'a.exe', bytes: TEXT }, '不支持的文件类型', '非白名单扩展名')
  rejected({ fileName: '没有扩展名', bytes: TEXT }, '缺少扩展名', '无扩展名')
  rejected({ fileName: 'a.', bytes: TEXT }, '缺少扩展名', '点结尾（等于没有扩展名）')

  // ── ② MIME 交叉校验 ──
  rejected(
    { fileName: 'a.pdf', declaredMime: 'text/plain', bytes: PDF },
    '不符',
    'MIME 与扩展名矛盾',
  )

  // ── ③ 文件头魔数：**唯一能抓住"改名"的一道** ──
  //    改名成 .pdf 的文本：扩展名与 MIME 完全自洽（浏览器就是这么报的），只有内容对不上
  rejected(
    { fileName: 'fake.pdf', declaredMime: 'application/pdf', bytes: TEXT },
    '看起来是纯文本',
    '改名成 .pdf 的文本',
  )
  rejected({ fileName: 'a.pdf', declaredMime: 'application/pdf', bytes: PNG }, '图片', 'PNG 改名成 .pdf')
  rejected({ fileName: 'a.docx', declaredMime: docxMime, bytes: OLE2 }, LEGACY_DOC_HINT, 'OLE2 改名成 .docx')
  // 任意 zip 改名成 .docx：签名过了（PNG 那种会被抓），必须靠包内 `[Content_Types].xml` 再确认
  rejected({ fileName: 'a.docx', declaredMime: docxMime, bytes: ZIP_PLAIN }, 'OOXML', '普通 zip 改名成 .docx')
  // 反向：真 PDF 改名成 .txt（内容是二进制、扩展名说是文本）
  rejected({ fileName: 'a.txt', declaredMime: 'text/plain', bytes: PDF }, '不符', 'PDF 改名成 .txt')
  // 文本扩展名里混进 NUL = 二进制内容的铁证
  rejected(
    { fileName: 'a.txt', declaredMime: 'text/plain', bytes: Buffer.concat([TEXT, Buffer.from([0]), TEXT]) },
    'NUL',
    '含 NUL 的 .txt',
  )
})

await it('shared 文档契约 + `countChars` 的口径（按**码点**计，不是 `.length`）', () => {
  // 白名单与 `.doc` 是**互斥**的两件事：`.doc` 不在白名单里，但有专门的拦截分支
  assertEqual([...UPLOAD_EXTENSIONS].join(','), 'pdf,docx,md,txt', '扩展名白名单')
  assertEqual(UPLOAD_EXTENSIONS.includes(LEGACY_DOC_EXTENSION), false, '.doc 不应在白名单里')
  assertEqual(UPLOAD_FILE_FIELD, 'file', 'multipart 文件字段名（`02` §4.6 未定，本批定案）')

  // MIME 表必须**恰好**覆盖白名单（多一个键 = 有条目永远不会被查到；少一个 = 该格式的 MIME 校验失效）
  assertEqual(
    Object.keys(MIME_BY_EXTENSION).sort().join(','),
    [...UPLOAD_EXTENSIONS].sort().join(','),
    'MIME 表的键集合应与白名单逐字一致',
  )
  for (const [extension, mimes] of Object.entries(MIME_BY_EXTENSION)) {
    assert(mimes.length > 0, `${extension} 的 MIME 列表不应为空`)
    assert(
      mimes.every((mime) => mime === mime.toLowerCase()),
      `${extension} 的 MIME 必须是小写（比对前会归一化，表里大写看不出问题但会误导人）`,
    )
  }

  // 输出投影
  const sample = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    kbId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    fileName: '员工手册.pdf',
    status: 'PARSING',
    chunkCount: 0,
    errorMsg: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
  assertEqual(documentItemSchema.safeParse(sample).success, true, '文档项 schema')
  assertEqual(
    documentItemSchema.safeParse({ ...sample, status: 'PENDING' }).success,
    false,
    'status 只允许 PARSING/READY/FAILED（与 schema.prisma 的枚举逐字一致）',
  )
  assertEqual(
    documentItemSchema.safeParse({ ...sample, chunkCount: -1 }).success,
    false,
    'chunkCount 不应允许负数',
  )
  // `deduplicated` 必填：调用方必须知道"这次到底有没有产生新文档"，否则前端会去列表里找一个不存在的新文档
  assertEqual(
    uploadDocumentResultSchema.safeParse({ document: sample }).success,
    false,
    'deduplicated 是必填，不能被省略',
  )
  assertEqual(
    uploadDocumentResultSchema.safeParse({ document: sample, deduplicated: true }).success,
    true,
    '上传响应 schema',
  )
  assertEqual(
    documentParamsSchema.safeParse({ id: sample.id, docId: 'not-a-uuid' }).success,
    false,
    'docId 必须是 UUID',
  )

  // `countChars`：`.length` 会把 emoji 数成 2（UTF-16 代理对），`[...str]` 按码点迭代才是"字符数"。
  // P0-1-18 的 `chunk_size=512` 单位是**字符**，这条口径现在就钉死，免得下游各写一遍。
  assertEqual(countChars('😀'), 1, '单个 emoji 应算 1 个字符')
  assertEqual('😀'.length, 2, '（对照）`.length` 会数成 2')
  assertEqual(countChars('中 a 文'), 3, '空白字符不计入')
  assertEqual(countChars(''), 0, '空串')
})

// ── 19. 文档状态机（P0-1-17）──
console.log(`\n${c.b}── 文档状态机契约 ──${c.x}`)

await it('状态机转换表：合法转换恰好 5 条，且 **READY 不得被打回 FAILED**', () => {
  // 这条不变式没有任何 HTTP 路径能验到它：worker 是唯一的写者，而"过期 job 把 READY 文档
  // 打回失败"只会表现为"内容明明能用却报失败、重投也救不回来"。就靠这条纯函数断言守着。
  assertEqual(DOCUMENT_STATUSES.join(','), 'PARSING,READY,FAILED', '状态集合（与 schema.prisma 枚举逐字一致）')

  const legal = []
  for (const from of DOCUMENT_STATUSES) {
    for (const to of DOCUMENT_STATUSES) {
      if (canTransitionDocumentStatus(from, to)) legal.push(`${from}->${to}`)
    }
  }
  // 集合语义：两边都排序再比（按枚举书写顺序写死期望值，换个顺序就会假失败）
  assertEqual(
    [...legal].sort().join(','),
    ['PARSING->PARSING', 'PARSING->READY', 'PARSING->FAILED', 'READY->PARSING', 'FAILED->PARSING']
      .sort()
      .join(','),
    '合法转换集合',
  )

  assertEqual(canTransitionDocumentStatus('READY', 'FAILED'), false, 'READY 不得直接转 FAILED')
  assertEqual(canTransitionDocumentStatus('READY', 'READY'), false, 'READY 是终态：重复投递必须被跳过，而不是重写')
  assertEqual(canTransitionDocumentStatus('FAILED', 'READY'), false, 'FAILED 必须先回 PARSING（重试要可见）')
  assertEqual(canTransitionDocumentStatus('PARSING', 'READY'), true, '成功路径')
  assertEqual(canTransitionDocumentStatus('PARSING', 'FAILED'), true, '失败路径')

  // 与声明式表逐条一致（防"函数与表各写一套"）
  for (const from of DOCUMENT_STATUSES) {
    const declared = [...DOCUMENT_STATUS_TRANSITIONS[from]].sort().join(',')
    const computed = DOCUMENT_STATUSES.filter((to) => canTransitionDocumentStatus(from, to)).sort().join(',')
    assertEqual(computed, declared, `${from} 的后继集合应与 DOCUMENT_STATUS_TRANSITIONS 一致`)
  }
})

// ── 20. 分块策略契约（P0-1-18；纯函数 + 真夹具，不需要任何依赖）──
console.log(`\n${c.b}── 分块策略契约（hybrid / fixed：逐条盯"做错会静默"的地方）──${c.x}`)

/** 分块参数取 §二 的默认值（KB 建库时快照的就是这几个数） */
const CHUNK_OPT = { chunkSize: 512, chunkOverlap: 64, chunkMin: DEFAULT_CHUNK_MIN_CHARS }
/** 码点数（`chunk_size` 的单位是字符，见 §二 B8 —— 断言也必须用它，否则量错了对象） */
const cps = (text) => [...text]
/** 造一份"一段文本 + 无标题"的解析结果（纯函数入参，不经过解析器） */
const flatDoc = (text, headingPath = [], page = null) => ({
  blocks: [{ text, headingPath, page }],
  text,
  meta: {
    format: 'txt',
    pageCount: page === null ? null : 1,
    charCount: countChars(text),
    hasHeadings: headingPath.length > 0,
    encoding: 'utf-8',
  },
})
/** 解析一个夹具（真跑解析器：分块的上游就是它，桩掉等于把"能接到真数据"这件事漏掉） */
const parseFixture = (fileName, bytes) => parseDocument(detectFormat({ fileName, bytes }), bytes)

/** 结构清晰 docx：1 个标题 + 6 段各 105 字（同一 Section 内共 ~646 字 ⇒ 必须切两刀以上） */
const LONG_DOCX_BLOCKS = [{ level: 1, text: '员工手册' }]
for (let i = 1; i <= 6; i += 1) LONG_DOCX_BLOCKS.push({ text: `第${i}条规定：${'甲'.repeat(98)}。` })

await it('小文档特例：全文 ≤ chunk_size → **恰好 1 块**，且与原文逐字相同（不被切开）', async () => {
  // `docs/06` 该批验收原句："传 200 字短通知 → 恰好 1 个 chunk（不被切开）"
  const notice = '通'.repeat(200)
  const noticeChunks = splitIntoChunks(flatDoc(notice), CHUNK_OPT)
  assertEqual(noticeChunks.length, 1, '200 字短通知应恰好 1 块')
  assertEqual(noticeChunks[0].content, notice, '单块的内容应与原文逐字相同')
  assertEqual(noticeChunks[0].seq, 0, '首块 seq 从 0 起（`chunks.seq` 的口径）')

  // 带 3 个标题但全文只有 80 字（去空白后）的 md：小文档特例判在"全文"而不是"每个 Section"
  // ⇒ 仍然是 1 块（按 Section 判会切出 4 块，与验收原句矛盾）
  const markdown = fixtures.makeMarkdown()
  const mdParsed = await parseFixture('staff.md', markdown)
  assertEqual(mdParsed.meta.hasHeadings, true, 'md 夹具应当解析出标题结构（否则下一条断言失去意义）')
  const mdChunks = splitIntoChunks(mdParsed, CHUNK_OPT)
  assertEqual(mdChunks.length, 1, '全文 ≤ chunk_size 时即使有多个标题也只出 1 块')
  assertEqual(mdChunks[0].content, mdParsed.text, '整块内容应与 parsed.text 逐字相同')
})

await it('hybrid：边界**回退到句末**（首块长度小于 chunk_size，末字符是句末边界）', async () => {
  // 这条是 hybrid 与 fixed 的分水岭：不做回退的实现会在 chunk_size 处硬切（首块恰好 512 字、
  // 且末字符是"甲"），而 `docs/06` 的验收要求"chunk 边界落在句末"。
  const docx = fixtures.makeDocx(LONG_DOCX_BLOCKS)
  const parsed = await parseFixture('staff.docx', docx)
  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assert(chunks.length >= 2, `长文档应切成多块，实际 ${chunks.length} 块`)

  const first = chunks[0]
  const firstChars = cps(first.content)
  assert(
    firstChars.length < CHUNK_OPT.chunkSize,
    `首块长度应小于 chunk_size（回退过），实际 ${firstChars.length}`,
  )
  const lastChar = firstChars[firstChars.length - 1]
  assert(
    SENTENCE_BOUNDARY_CHARS.includes(lastChar),
    `首块末字符应是句末边界，实际 ${JSON.stringify(lastChar)}（硬切会落在"甲"上）`,
  )
  // 回退到段末 ⇒ 末字符就是段间分隔符（`\n`）—— 顺带证明"段间分隔符也算边界"这个扩充分支生效
  assertEqual(lastChar, '\n', '本夹具的最近边界是段间换行')
  // 每段的句号都完整保留（没有把某一段的句号切到下一块去）
  assert(cps(first.content).filter((ch) => ch === '。').length === 4, '首块应完整包含前 4 段的句号')
})

await it('不变式：每一块都是 `parsed.text` 的**逐字子串**（P0-1-20 的引用片段靠它）', async () => {
  // 整条链只做"取连续区间"（重叠也是取前一块尾部）⇒ 不存在"重新拼接出原文里没有的句子"。
  // P0-1-20 要输出"snippet 与原文逐字一致"，这条不变式就是它的前提；破了则引用无法核对。
  for (const [fileName, bytes] of [
    ['staff.docx', fixtures.makeDocx(LONG_DOCX_BLOCKS)],
    ['staff.md', fixtures.makeMarkdown()],
    ['staff.txt', fixtures.makeTxtUtf8()],
  ]) {
    const parsed = await parseFixture(fileName, bytes)
    const chunks = splitIntoChunks(parsed, CHUNK_OPT)
    assert(chunks.length > 0, `${fileName} 应至少产出 1 块`)
    for (const chunk of chunks) {
      assert(
        parsed.text.includes(chunk.content),
        `${fileName} 的第 ${chunk.seq} 块不是原文的逐字子串：${JSON.stringify(chunk.content.slice(0, 40))}…`,
      )
    }
  }
})

await it('重叠：第 2 块以第 1 块末尾 chunk_overlap 个字符开头，且块长 ≤ chunk_size + overlap', async () => {
  const parsed = await parseFixture('staff.docx', fixtures.makeDocx(LONG_DOCX_BLOCKS))
  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assert(chunks.length >= 2, '本夹具应至少 2 块')
  const first = cps(chunks[0].content)
  const second = cps(chunks[1].content)
  const expectedPrefix = first.slice(first.length - CHUNK_OPT.chunkOverlap).join('')
  assertEqual(
    second.slice(0, CHUNK_OPT.chunkOverlap).join(''),
    expectedPrefix,
    '第 2 块开头应是第 1 块的末 chunk_overlap 个字符（重叠是"取前块尾"，不是新造的句子）',
  )
  // 上界：重叠前缀 + 段体 ≤ chunk_size + overlap（尾块合并那一条会再放宽 chunk_min，见下一例）
  for (const chunk of chunks) {
    assert(
      cps(chunk.content).length <= CHUNK_OPT.chunkSize + CHUNK_OPT.chunkOverlap,
      `块长 ${cps(chunk.content).length} 越界（应 ≤ ${CHUNK_OPT.chunkSize + CHUNK_OPT.chunkOverlap}）`,
    )
  }
})

await it('尾块合并：尾块 < chunk_min 并入前块（与 fixed 的对照证明是 hybrid 的行为）', async () => {
  // 561 字：chunkSize(512) + 49（< chunk_min 50）且**通篇没有句读**
  // ⇒ hybrid 应并成 1 块 561 字；fixed 不做合并，会切成 512 + 113（重叠后）
  const flat = flatDoc('丙'.repeat(561))
  const hybridChunks = splitIntoChunks(flat, CHUNK_OPT)
  assertEqual(hybridChunks.length, 1, 'hybrid：49 字的尾块应并入前块 ⇒ 只剩 1 块')
  assertEqual(cps(hybridChunks[0].content).length, 561, '合并后的块应包含全部 561 字')

  const fixedChunks = splitIntoChunks(flat, CHUNK_OPT, 'fixed')
  assertEqual(fixedChunks.length, 2, 'fixed 不做尾块合并 ⇒ 2 块（这正是两者的差别）')
})

await it('fixed：定长滑窗，块长恒 ≤ chunk_size（+重叠），且首块就是 chunk_size', async () => {
  const chunks = splitIntoChunks(flatDoc('丁'.repeat(1000)), CHUNK_OPT, 'fixed')
  // 1000 = 512 + 488，步长 = 512 − 64 = 448 ⇒ 起点 0 / 448 / 896 → 3 块
  assertEqual(chunks.map((chunk) => cps(chunk.content).length).join(','), '512,512,104', '定长滑窗的块长序列')
  assertEqual(chunks.map((chunk) => chunk.seq).join(','), '0,1,2', 'seq 连续且从 0 起')
})

await it('单位是**码点**：长 emoji 文本按 fixed 切不会劈开代理对', () => {
  // `.length` 会把 emoji 数成 2，用 `text.slice()` 就可能只取到半个代理对 ——
  // 产出的是**非法字符串**（下游 embedding 直接报错），而**本层没有任何报错**。
  const emoji = '😀'.repeat(600)
  const chunks = splitIntoChunks(flatDoc(emoji), CHUNK_OPT, 'fixed')
  assertEqual(chunks.map((chunk) => cps(chunk.content).length).join(','), '512,152', '按码点计的长度')
  for (const chunk of chunks) {
    assert(
      cps(chunk.content).every((char) => char === '😀'),
      `第 ${chunk.seq} 块里出现了半个代理对（说明是按 UTF-16 下标切的）`,
    )
  }
})

await it('页码 meta 取"块起点所在页"：跨页的块不会被说成第 1 页', async () => {
  // PDF 夹具每页 20 行（必须**折行**：单条超长 `Tj` 会超出 MediaBox，pdf.js 只提取页面框内的文本，
  // 于是被静默截断 —— 见 `issue_fix/问题记录-P0-1-18-*.md`）
  const lines = (tag) => Array.from({ length: 20 }, (_, i) => `${tag} line ${i + 1} ${'x'.repeat(20)}`)
  const parsed = await parseFixture('two-pages.pdf', fixtures.makePdf([lines('alpha'), lines('bravo')]))
  assertEqual(parsed.meta.pageCount, 2, 'PDF 夹具应有 2 页')
  assertEqual(parsed.blocks.map((block) => block.page).join(','), '1,2', '每个段应带上自己的页码')

  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assertEqual(chunks.length, 3, '1222 字按默认参数应切 3 块')
  assertEqual(chunks[0].meta.page, 1, '首块的起点落在第 1 页')
  assertEqual(chunks[chunks.length - 1].meta.page, 2, '末块的起点落在第 2 页（按 Section 取页码的实现会说成 1）')
})

await it('同名标题**不相邻**时不合并（顺序保持 = 与原文一致）', () => {
  // 按 `headingPath` 分组（Map）的实现会把两段"考勤"并到一起，于是第二段被排到"报销"前面。
  // 这种错位在检索层几乎无法发现：命中的片段读起来通顺，只是位置不对。
  const body = '甲'.repeat(300)
  const blocks = [
    { text: body, headingPath: ['考勤'], page: null },
    { text: '乙'.repeat(300), headingPath: ['报销'], page: null },
    { text: body, headingPath: ['考勤'], page: null },
  ]
  const parsed = {
    blocks,
    text: blocks.map((block) => block.text).join('\n\n'),
    meta: { format: 'docx', pageCount: null, charCount: 900, hasHeadings: true, encoding: 'utf-8' },
  }
  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assertEqual(chunks.length, 3, '三个同名/异名交替的段各占一块')
  assertEqual(
    chunks.map((chunk) => chunk.meta.headingPath.join('/')).join(','),
    '考勤,报销,考勤',
    '标题路径应随原文顺序（合并实现的输出是"考勤,考勤,报销"或少一块）',
  )
})

await it('策略注册表：默认与回落都是 hybrid，且策略名集合与 shared 的 `SPLIT_STRATEGIES` 同源', () => {
  assertEqual([...chunkStrategyNames()].sort().join(','), [...SPLIT_STRATEGIES].sort().join(','), '策略名集合')
  assertEqual(resolveChunkStrategy('hybrid').name, 'hybrid', '按名取 hybrid')
  assertEqual(resolveChunkStrategy('fixed').name, 'fixed', '按名取 fixed')
  // 未知值退默认而不是抛错：补默认值的口径由 `normalizeRetrievalConfig` 定死（"永不抛错"），
  // 这里再抛一次等于同一件事两个相反口径；且报错代价是"文档被标成 FAILED、用户去重传"。
  assertEqual(resolveChunkStrategy('nope').name, 'hybrid', '未知策略回落 hybrid')
  assertEqual(splitIntoChunks(flatDoc('戊'.repeat(100)), CHUNK_OPT).length, 1, '省略策略参数时走默认 hybrid')
  assertEqual(DEFAULT_CHUNK_MIN_CHARS, 50, 'chunk_min 是 §二 的 50（它不是环境变量，见 strategy.ts 注释）')
})

await app.close()
await closePg()
await closeRedis()

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 接口级验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 接口级验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
