#!/usr/bin/env node
/**
 * verify-git-credentials-ui.mjs —— Git 凭据页前端**无依赖**验收（P1-9 · R11）
 *
 * 跑法：`pnpm verify:git-credentials-ui`（= `node --import tsx scripts/verify-git-credentials-ui.mjs`）
 *
 * 本批前端可自证的风险集中在 `gitCredentialModel.ts` 的**纯函数**上 —— "表单 → 请求体"这条
 * 合并语义错了**都不报错**，只是把用户没填的值清掉（或该改的没改）。全是纯函数 ⇒ 直接喂字面量断言。
 * 另外对"接线"做几条**静态**检查（路由/导航/接口路径都在），防"页面写了却没人能点到"。
 *
 * ⚠️ 本档**验不了**：真浏览器的表单交互、后端落库与容器注入 ⇒ 属浏览器端测 / 用户真跑。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}：期望 ${e}，实得 ${a}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8')

const {
  GIT_CREDENTIAL_KIND_LABEL,
  gitCredentialHost,
  gitCredentialCreateBody,
  gitCredentialUpdateBody,
} = await import('../src/pages/settings/gitCredentialModel.ts')

const item = (over) => ({
  id: 'c1',
  label: 'github-work',
  kind: 'SSH_KEY',
  host: 'github.com',
  hasValue: true,
  updatedAt: '2026-10-12T00:00:00.000Z',
  ...over,
})

console.log('── G1 host 归一化 ──')
it('G1 空白 host ⇒ null（不限），否则去空白', () => {
  eq(gitCredentialHost(undefined), null, 'undefined')
  eq(gitCredentialHost('   '), null, '空白')
  eq(gitCredentialHost(' github.com '), 'github.com', '去空白')
})

console.log('── G2 新建 body ──')
it('G2 SSH：带 label/kind/host + privateKey/knownHosts，不带 token/username', () => {
  const body = gitCredentialCreateBody({
    label: '  github-work ',
    kind: 'SSH_KEY',
    host: 'github.com',
    privateKey: 'KEY',
    knownHosts: 'gh',
    token: 'should-be-ignored',
  })
  eq(body.label, 'github-work', 'label 去空白')
  eq(body.kind, 'SSH_KEY')
  eq(body.host, 'github.com')
  eq(body.privateKey, 'KEY')
  eq(body.knownHosts, 'gh')
  assert(body.token === undefined, 'SSH 不该带 token')
})

it('G2b HTTPS：带 token/username，不带 privateKey', () => {
  const body = gitCredentialCreateBody({
    label: 'gl',
    kind: 'HTTPS_TOKEN',
    host: '',
    token: 'tok',
    username: ' oauth2 ',
    privateKey: 'ignored',
  })
  eq(body.host, null, '空 host ⇒ null')
  eq(body.token, 'tok')
  eq(body.username, 'oauth2')
  assert(body.privateKey === undefined, 'HTTPS 不该带 privateKey')
})

console.log('── G3 更新 body（合并语义）──')
it('G3 秘密字段留空 ⇒ 请求体**不带**它们（不能把没填的清掉）', () => {
  const body = gitCredentialUpdateBody(item(), { label: 'github-work', kind: 'SSH_KEY', host: 'github.com' })
  eq(body, {}, '什么都没改 ⇒ 空对象')
})

it('G3b label/host 改了才带；host 清空 ⇒ null', () => {
  const body = gitCredentialUpdateBody(item(), { label: 'renamed', kind: 'SSH_KEY', host: '' })
  eq(body.label, 'renamed')
  eq(body.host, null)
})

it('G3c 只填了替换私钥 ⇒ 只带 privateKey', () => {
  const body = gitCredentialUpdateBody(item(), { label: 'github-work', kind: 'SSH_KEY', host: 'github.com', privateKey: 'NEW' })
  eq(body, { privateKey: 'NEW' })
})

console.log('── G4 类型读数 ──')
it('G4 两种类型都有中文读数', () => {
  eq(GIT_CREDENTIAL_KIND_LABEL.SSH_KEY, 'SSH 私钥')
  eq(GIT_CREDENTIAL_KIND_LABEL.HTTPS_TOKEN, 'HTTPS 令牌')
})

console.log('── G5 接线（静态）──')
it('G5 「我的凭据」页内嵌 Git 凭据区块；不再有独立路由', () => {
  const app = read('src/app/App.tsx')
  assert(app.includes('/settings/credentials'), 'App.tsx 应注册「我的凭据」页')
  assert(!app.includes('/settings/git-credentials'), 'App.tsx 不应再有独立的 git 凭据路由')

  const page = read('src/pages/mcp/McpCredentialsPage.tsx')
  assert(page.includes('<GitCredentialsSection />'), '「我的凭据」页应渲染 GitCredentialsSection')

  const section = read('src/pages/settings/GitCredentialsSection.tsx')
  assert(section.includes('export function GitCredentialsSection'), 'GitCredentialsSection 应导出自该文件')
})
it('G5b 导航不再单列 Git 凭据项', () => {
  const nav = read('src/app/nav.ts')
  assert(nav.includes("path: '/settings/credentials'"), 'nav.ts 应有「我的凭据」项')
  assert(!nav.includes('/settings/git-credentials'), 'nav.ts 不应再有独立的 Git 凭据项')
})
it('G5c api 打的是 /api/git-credentials 四条', () => {
  const src = read('src/api/gitCredentials.ts')
  assert(src.includes("'/api/git-credentials'"), '应有列表/新建路径')
  assert(src.includes('`/api/git-credentials/'), '应有 /:id 路径')
})

console.log(`\nverify-git-credentials-ui：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
