#!/usr/bin/env node
/**
 * openapi-check.mjs —— 入库 spec 的**防漂移**检查（**P1-22 · B4**；`docs/08` §9 的 CI 两条断言）
 *
 * 跑法：`pnpm openapi:check`（= 先 `pnpm openapi:export` **重新生成**，再跑本脚本）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它验什么
 * ─────────────────────────────────────────────────────────────────────
 * ① **入库的 `openapi/open-v1.json` 与代码生成结果逐字节一致** —— 改了 `/open/v1` 的契约却忘了重新导出，
 *    客户的 spec 会停在旧版（"文档说 A、服务做 B"是最难查的一类缺陷）。
 *    实现：`openapi:export` 先重写文件，本脚本读 `git diff`/`git status` 判断它是否被改动。
 * ② **spec 结构与两份真相表对得上**（`shared/src/openApi.ts` 的 scope 闭集、
 *    `backend/src/openapi/openV1Spec.ts` 的 17 条 `OPEN_ROUTE_DOCS`）：
 *    · 每条 operation 都有 `security`（bearerAuth）与 `x-open-scope`；
 *    · scope 取值只可能是 `OPEN_API_SCOPES` 里的值或空串（"只要 Key 有效"）；
 *    · 路径集合恰是 17 条业务端点，**不含** `openapi.json` / `docs` 自身；
 *    · 每条 operation 都有 `operationId`（SDK 生成要用）。
 * ③ **没有残留的 `/api/**` 路径**（§9：只有 `/open/v1` 进 spec）。
 *
 * ⚠️ 它**不**校验字段级语义（"这个字段的类型与 zod 是否一致"）：那需要 zod → JSON Schema 的
 *    派生链路，本仓刻意不引（见 `openV1Spec.ts` 文件头 ②）。字段级漂移靠 review。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const useColor = process.stdout.isTTY === true
const c = { g: useColor ? '\u001b[32m' : '', r: useColor ? '\u001b[31m' : '', d: useColor ? '\u001b[90m' : '', x: useColor ? '\u001b[0m' : '' }

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
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}：期望 ${e}，实得 ${a}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const SPEC_PATH = 'openapi/open-v1.json'
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')

// ───────────────────────────── ① 入库文件与生成结果一致 ─────────────────────────────

console.log('── S1 入库 spec 与代码一致 ──')
it('S1 `openapi/open-v1.json` 没有未提交的改动（改了契约就要重新 `pnpm openapi:export` 并提交）', () => {
  // ⚠️ 两种"过期"分开报：
  //   · `M`（已入库、内容被改写）—— 这是真·漂移，必须红；
  //   · `??`（还没入库）—— 首次导出时必然如此；此时没有"旧版本"可比，不算漂移
  //     （入库后它能被 diff 到，S1 从此对它有约束）。真入库了却忘了导出 ⇒ `M`。
  const status = execFileSync('git', ['status', '--porcelain', '--', SPEC_PATH], { cwd: ROOT, encoding: 'utf8' })
  const lines = status.trim().split('\n').filter((line) => line !== '')
  const modified = lines.filter((line) => !line.startsWith('??'))
  const untracked = lines.filter((line) => line.startsWith('??'))
  if (untracked.length > 0 && modified.length === 0) {
    console.log(`  ${c.d}（提示：${SPEC_PATH} 尚未入库 —— 本次是首版导出，不存在"旧版本漂移"）${c.x}`)
  }
  assert(
    modified.length === 0,
    `入库的 spec 与代码生成结果不一致：\n         ${modified.join('\n         ')}\n` +
      `         处理：确认改动是有意的，然后把 ${SPEC_PATH} 一起提交（这也是 review 时要看的那份 diff）。`,
  )
})

// ───────────────────────────── ② 结构与两份表对得上 ─────────────────────────────

const spec = JSON.parse(read(SPEC_PATH))
const operations = []
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(item)) {
    operations.push({ path, method: method.toUpperCase(), op })
  }
}

/**
 * scope 闭集：**读共享源码**（`shared/src/openApi.ts`）而不是 import 包名 ——
 * 本脚本在仓库根跑，`@doubulea/shared` 只在各包的 `node_modules` 里有链接，
 * 根目录 import 会 `ERR_MODULE_NOT_FOUND`。源码里的 `OPEN_API_SCOPES` 是一行字面量，正则读即可。
 */
const sharedSource = read('shared/src/openApi.ts')
const OPEN_API_SCOPES = parseStringArray(sharedSource, 'OPEN_API_SCOPES')
/**
 * 契约表（`backend/src/openapi/openV1Spec.ts`）**用正则读源码**而不是 import：
 *   · 本脚本在仓库根跑，`backend/src` 下的 TS 依赖 `backend` 的 tsconfig 解析（路径别名/项目引用），
 *     用根目录的 loader 直接 import 会 `ERR_MODULE_NOT_FOUND`；
 *   · 而我们只需要这张表的**结构性事实**（路径 / method / scope / 是否 SSE），这些都是**字面量**，
 *     正则读出来与 import 等价，还省掉"为了一个静态检查去建整个后端运行时"的代价。
 * ⚠️ 代价：改 `OPEN_ROUTE_DOCS` 的**写法**（例如把 `method: 'get'` 拆成变量）会让本脚本读不到；
 *    那时 A1 会红，属于预期（提示"换了写法就要同步这里的解析"）。
 */
const specSource = read('backend/src/openapi/openV1Spec.ts')
const routeDocs = parseRouteDocs(specSource)

console.log('── S2 结构：与 shared / OPEN_ROUTE_DOCS 对齐 ──')
it('S2 spec 的**路径**集合 = 契约表的路径集合；**操作**数 = 17（不含 openapi.json / docs 自身）', () => {
  const expected = [...new Set(routeDocs.map((doc) => doc.openApiPath))].sort()
  const actual = Object.keys(spec.paths ?? {}).sort()
  eq(actual, expected, '路径集合')
  // ⚠️ 路径数 ≠ 端点数：`/conversations` 与 `/conversations/{id}` 各有 GET+POST / GET+DELETE
  eq(operations.length, 17, '操作数')
  eq(routeDocs.length, 17, '契约表条目数')
  assert(!actual.some((path) => path.startsWith('/api/')), 'spec 里不该出现 /api/** 路由')
  assert(!actual.includes('/open/v1/openapi.json'), 'spec 不该包含自身的 spec 端点')
  assert(!actual.includes('/open/v1/docs'), 'spec 不该包含文档站端点')
})

it('S3 每条 operation 都声明 security（bearerAuth）与 x-open-scope', () => {
  for (const { path, method, op } of operations) {
    const security = op.security
    assert(Array.isArray(security) && security.length > 0, `${method} ${path} 缺 security`)
    assert(
      security.some((entry) => entry !== null && typeof entry === 'object' && 'bearerAuth' in entry),
      `${method} ${path} 的 security 不是 bearerAuth`,
    )
    assert('x-open-scope' in op, `${method} ${path} 缺 x-open-scope`)
  }
})

it('S4 x-open-scope 只取 `shared#OPEN_API_SCOPES` 里的值（或空串 = 只要 Key 有效）', () => {
  const allowed = new Set([...OPEN_API_SCOPES, ''])
  for (const { path, method, op } of operations) {
    assert(allowed.has(op['x-open-scope']), `${method} ${path} 的 scope 非法：${String(op['x-open-scope'])}`)
  }
  // 与文档表逐条对：`OPEN_ROUTE_DOCS` 的 scope 必须与 spec 里的一致（一处写成 chat、另一处写成读）
  for (const doc of routeDocs) {
    const found = operations.find(
      (candidate) => candidate.path === doc.openApiPath && candidate.method === doc.method.toUpperCase(),
    )
    assert(found !== undefined, `spec 里找不到 ${doc.method.toUpperCase()} ${doc.openApiPath}`)
    eq(found.op['x-open-scope'], doc.scope ?? '', `${doc.method.toUpperCase()} ${doc.openApiPath} 的 scope`)
  }
})

it('S5 每条 operation 都有 operationId（SDK 生成依赖它）且文件里无重复', () => {
  const ids = operations.map(({ op }) => op.operationId)
  for (const [index, id] of ids.entries()) {
    assert(
      typeof id === 'string' && id !== '',
      `${operations[index]?.path} 的 ${operations[index]?.method} 缺 operationId`,
    )
  }
  eq(new Set(ids).size, ids.length, 'operationId 唯一性')
})

it('S6 业务端点都有 200（SSE 是 text/event-stream）与至少一个错误响应', () => {
  for (const { path, method, op } of operations) {
    const responses = op.responses ?? {}
    const ok = responses['200']
    assert(ok !== undefined, `${method} ${path} 没有 200 响应`)
    // SSE 三条（chat / stream / regenerate）声明 text/event-stream；其余声明 JSON 信封
    const sseDoc = routeDocs.find(
      (doc) => doc.openApiPath === path && doc.method === method.toLowerCase(),
    )
    if (sseDoc?.sse === true) {
      assert(
        ok.content && 'text/event-stream' in ok.content,
        `${method} ${path} 是 SSE 端点，200 的 content 必须是 text/event-stream`,
      )
    } else {
      assert(
        ok.content && 'application/json' in ok.content,
        `${method} ${path} 的 200 必须是 application/json`,
      )
    }
    assert(
      Object.keys(responses).some((code) => code !== '200'),
      `${method} ${path} 至少要声明一个错误响应（401/403/404/429…）`,
    )
  }
})

console.log()
console.log(`${c.d}spec：${resolve(ROOT, SPEC_PATH)}${c.x}`)
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)

// ───────────────────────────── 契约表的源码解析 ─────────────────────────────

/**
 * 从 `openV1Spec.ts` 的 `OPEN_ROUTE_DOCS` 数组里读出每条记录的 `{method,path,openApiPath,scope,sse}`。
 *
 * 只按**对象字面量的分段**解析（`method: 'get'` 开始的块，到下一个 `method:` 或数组结束为止），
 * 于是"每条 doc 有哪几个字面量"与它写在源码的哪一行无关。
 */
function parseRouteDocs(source) {
  const start = source.indexOf('export const OPEN_ROUTE_DOCS')
  if (start < 0) throw new Error('找不到 OPEN_ROUTE_DOCS（契约表可能改名）')
  const end = source.indexOf('\n]', start)
  if (end < 0) throw new Error('OPEN_ROUTE_DOCS 数组没有按预期结束')
  const body = source.slice(start, end)

  const docs = []
  // 每条 doc 从 `method:` 起算；用 split 切块（`method:` 在注释里不出现，这是契约表的写法约定）
  const blocks = body.split(/\n\s*method: /u).slice(1)
  for (const block of blocks) {
    const method = /^'([a-z]+)'/u.exec(block)?.[1]
    const path = /path: '([^']+)'/u.exec(block)?.[1]
    const openApiPath = /openApiPath: '([^']+)'/u.exec(block)?.[1]
    const scopeMatch = /scope: (null|'[^']+')/u.exec(block)
    const scope = scopeMatch === null ? undefined : scopeMatch[1] === 'null' ? null : scopeMatch[1].replaceAll("'", '')
    const sse = /sse: true/u.test(block)
    if (method === undefined || path === undefined || openApiPath === undefined || scope === undefined) {
      throw new Error(`OPEN_ROUTE_DOCS 里有一条记录解析失败：${block.slice(0, 80)}`)
    }
    docs.push({ method, path, openApiPath, scope, sse })
  }
  return docs
}

/** 从源码里读一个 `export const NAME = ['a', 'b'] as const` 形式的字符串数组 */
function parseStringArray(source, name) {
  const start = source.indexOf(`export const ${name} = [`)
  if (start < 0) throw new Error(`找不到 ${name}（改名了？）`)
  const end = source.indexOf(']', start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/gu)].map((match) => match[1])
}
