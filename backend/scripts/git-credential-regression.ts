#!/usr/bin/env node
/**
 * git-credential-regression.ts —— git 凭据（P1-9 · R11 修订：**按需拉取**）的**无 DB / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend git:regression`
 *      （= `node --import tsx scripts/git-credential-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06` §六 第 8/9 条；被测对象 = `shared/src/gitCredential.ts`（必填字段判据）
 *      + `backend/src/sandbox/gitCredential.ts`（helper env / 按 host 挑凭据，均纯函数）
 *      + `backend/src/sandbox/tar.ts`（ustar 编码器，保留的通用原语）。
 *
 * ⚠️ 它验的是**纯判据**：helper env 不含秘密、`(protocol,host)` 挑哪条凭据、tar 的头/校验和。
 *    它**验不了**端到端（要真容器 + 可达的 git 上游 + 平台端点）：helper 真的回调、`git clone`
 *    真的成功 —— 那些留给用户真跑（`子方案/Code模式工作区.md` §五 7 的验收口径）。
 */

import { GIT_CREDENTIAL_KINDS, missingGitCredentialSecretFields } from '@doubulea/shared'

import {
  GIT_CREDENTIAL_HELPER_PATH,
  GIT_SSH_HELPER_PATH,
  gitCredentialAad,
  gitCredentialHelperEnv,
  selectGitCredential,
  type GitCredentialPlain,
} from '../src/sandbox/gitCredential.js'
import { buildTar, readTarHeader } from '../src/sandbox/tar.js'

let passed = 0
let failed = 0
function it(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n    实际 ${a}\n    期望 ${e}`)
}

function ssh(overrides: Partial<GitCredentialPlain> = {}): GitCredentialPlain {
  return { kind: 'SSH_KEY', host: null, secret: { privateKey: 'KEY' }, ...overrides }
}
function https(overrides: Partial<GitCredentialPlain> = {}): GitCredentialPlain {
  return { kind: 'HTTPS_TOKEN', host: 'github.com', secret: { token: 'tok' }, ...overrides }
}

console.log('git-credential-regression —— P1-9 · R11（按需拉取）\n')

// ── 契约（shared）──────────────────────────────────────────────────────
it('凭据类型取值域 = [SSH_KEY, HTTPS_TOKEN]', () => {
  assertEqual([...GIT_CREDENTIAL_KINDS], ['SSH_KEY', 'HTTPS_TOKEN'])
})

it('必填字段判据（shared#missingGitCredentialSecretFields）', () => {
  assertEqual(missingGitCredentialSecretFields('SSH_KEY', { privateKey: 'k' }), [])
  assertEqual(missingGitCredentialSecretFields('SSH_KEY', {}), ['privateKey'])
  assertEqual(missingGitCredentialSecretFields('HTTPS_TOKEN', { token: 't' }), [])
  assertEqual(missingGitCredentialSecretFields('HTTPS_TOKEN', { privateKey: 'k' }), ['token'])
})

// ── AAD（sandbox/gitCredential）────────────────────────────────────────
it('AAD = `${userId}:${kind}:${label}`', () => {
  assertEqual(gitCredentialAad('u1', 'SSH_KEY', 'github-work'), 'u1:SSH_KEY:github-work')
})

// ── helper env（**不含秘密**）───────────────────────────────────────────
it('helper env：无参数、恒定、且**不含任何秘密**', () => {
  const env = gitCredentialHelperEnv()
  assertEqual(env.GIT_TERMINAL_PROMPT, '0', '应关掉交互式提问')
  assertEqual(env.GIT_SSH_COMMAND, GIT_SSH_HELPER_PATH, 'GIT_SSH_COMMAND 指向 SSH 包装器')
  assertEqual(env.GIT_CONFIG_KEY_0, 'credential.helper', '先清空继承的 helper 列表')
  assertEqual(env.GIT_CONFIG_VALUE_0, '', '置空 = 清空')
  assertEqual(env.GIT_CONFIG_KEY_1, 'credential.helper')
  assertEqual(env.GIT_CONFIG_VALUE_1, GIT_CREDENTIAL_HELPER_PATH)
  // 关键负向：任何值里都不得出现疑似凭据内容（这份 env 与"用户配没配凭据"无关）
  const joined = Object.values(env).join('\n')
  assert(!joined.includes('Authorization'), '不应出现 Authorization（旧 extraheader 做法已废）')
  assert(!joined.includes('x-access-token'), '不应出现用户名')
})

// ── 挑凭据：HTTPS ──────────────────────────────────────────────────────
it('HTTPS：精确 host 优先于"不限主机"的那条', () => {
  const chosen = selectGitCredential(
    [
      https({ host: null, secret: { token: 'any' } }),
      https({ host: 'github.com', secret: { token: 'exact' } }),
    ],
    'https',
    'github.com',
  )
  assertEqual(chosen, { kind: 'https', username: 'x-access-token', password: 'exact' })
})

it('HTTPS：没有精确匹配时回落到"不限主机"的那条', () => {
  const chosen = selectGitCredential([https({ host: null, secret: { token: 'any' } })], 'https', 'gitlab.com')
  assertEqual(chosen, { kind: 'https', username: 'x-access-token', password: 'any' })
})

it('HTTPS：自定义用户名生效；空用户名回落 x-access-token', () => {
  assertEqual(selectGitCredential([https({ secret: { token: 't', username: 'oauth2' } })], 'https', 'github.com'), {
    kind: 'https',
    username: 'oauth2',
    password: 't',
  })
  assertEqual(selectGitCredential([https({ secret: { token: 't', username: '  ' } })], 'https', 'github.com'), {
    kind: 'https',
    username: 'x-access-token',
    password: 't',
  })
})

it('HTTPS：只有 SSH 凭据 / 空 token ⇒ null（不回半截）', () => {
  assertEqual(selectGitCredential([ssh()], 'https', 'github.com'), null, '只有 SSH ⇒ null')
  assertEqual(selectGitCredential([https({ secret: { token: '' } })], 'https', 'github.com'), null, '空 token ⇒ null')
  assertEqual(selectGitCredential([], 'https', 'github.com'), null, '没有凭据 ⇒ null')
})

// ── 挑凭据：SSH ────────────────────────────────────────────────────────
it('SSH：返回全部私钥（含 knownHosts），忽略 HTTPS 条目', () => {
  const chosen = selectGitCredential(
    [https(), ssh({ secret: { privateKey: 'K1' } }), ssh({ secret: { privateKey: 'K2', knownHosts: 'hh' } })],
    'ssh',
    null,
  )
  assertEqual(chosen, {
    kind: 'ssh',
    keys: [
      { privateKey: 'K1', knownHosts: '' },
      { privateKey: 'K2', knownHosts: 'hh' },
    ],
  })
})

it('SSH：没有 SSH 凭据 ⇒ null', () => {
  assertEqual(selectGitCredential([https()], 'ssh', null), null)
  assertEqual(selectGitCredential([ssh({ secret: { privateKey: '' } })], 'ssh', null), null, '空私钥忽略')
})

// ── tar 编码器（保留的通用原语）────────────────────────────────────────
it('buildTar：块对齐 + 头可读 + 目录/文件 typeflag', () => {
  const tar = buildTar([
    { name: 'dir/', mode: 0o700, content: Buffer.alloc(0), uid: 1, gid: 1 },
    { name: 'dir/key', mode: 0o600, content: Buffer.from('KEY\n'), uid: 1, gid: 1 },
  ])
  assertEqual(tar.length % 512, 0, 'tar 长度应 512 对齐')
  const first = readTarHeader(tar)
  assertEqual(first?.name, 'dir/')
  assertEqual(first?.mode, 0o700)
  const second = readTarHeader(tar.subarray(512))
  assertEqual(second?.name, 'dir/key')
  assertEqual(second?.mode, 0o600)
  assertEqual(second?.size, 4, 'KEY\\n = 4 字节')
})

it('buildTar：两个全零块收尾', () => {
  const tar = buildTar([{ name: 'a', content: Buffer.from('x'), uid: 1, gid: 1 }])
  const tail = tar.subarray(tar.length - 1024)
  assert(tail.equals(Buffer.alloc(1024)), '末尾应是两个全零块')
})

it('buildTar：校验和字段可自洽（重算 == 头里的值）', () => {
  const tar = buildTar([{ name: 'a', content: Buffer.from('hello'), uid: 1, gid: 1 }])
  const header = Buffer.from(tar.subarray(0, 512))
  const stored = Number.parseInt(header.toString('ascii', 148, 154), 8)
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  assertEqual(stored, sum, 'chksum 字段应与重算值一致')
})

it('buildTar：超长路径 ⇒ 响亮失败（不产出坏归档）', () => {
  let threw = false
  try {
    buildTar([{ name: 'x'.repeat(101), content: Buffer.from(''), uid: 1, gid: 1 }])
  } catch {
    threw = true
  }
  assert(threw, '>100 字符的路径应抛错')
})

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✅' : '❌'} git-credential-regression：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
