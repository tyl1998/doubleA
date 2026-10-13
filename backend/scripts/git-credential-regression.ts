#!/usr/bin/env node
/**
 * git-credential-regression.ts —— git 凭据注入物（P1-9 · R11）的**无 DB / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend git:regression`
 *      （= `node --import tsx scripts/git-credential-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06` §六 第 8/9 条；被测对象 = `shared/src/gitCredential.ts`（必填字段判据）
 *      + `backend/src/sandbox/gitCredential.ts`（AAD / env / 落盘文件，均纯函数）
 *      + `backend/src/sandbox/tar.ts`（ustar 编码器）。
 *
 * ⚠️ 它验的是**纯判据**：AAD 公式、两种凭据各注什么、多条的命名与顺序、tar 的头/校验和。
 *    它**验不了**端到端（要真容器 + 可达的 git 上游）：`putArchive` 真的落盘、`git clone` 真的成功
 *    —— 那些按 §六 第 30 条留给用户真跑（`子方案/Code模式工作区.md` §五 7 的验收口径）。
 */

import { GIT_CREDENTIAL_KINDS, missingGitCredentialSecretFields } from '@doubulea/shared'

import {
  gitCredentialAad,
  gitCredentialEnv,
  gitCredentialFiles,
  gitCredentialTarEntries,
  type GitCredentialPlain,
} from '../src/sandbox/gitCredential.js'
import { buildTar, readTarHeader } from '../src/sandbox/tar.js'
import { SANDBOX_AGENT_HOME, SANDBOX_AGENT_UID } from '../src/sandbox/spec.js'

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

console.log('git-credential-regression —— P1-9 · R11\n')

// ── 契约（shared）──────────────────────────────────────────────────────
it('凭据类型取值域 = [SSH_KEY, HTTPS_TOKEN]', () => {
  assertEqual([...GIT_CREDENTIAL_KINDS], ['SSH_KEY', 'HTTPS_TOKEN'])
})

it('必填字段判据（shared#missingGitCredentialSecretFields）', () => {
  assertEqual(missingGitCredentialSecretFields('SSH_KEY', { privateKey: 'k' }), [])
  assertEqual(missingGitCredentialSecretFields('SSH_KEY', {}), ['privateKey'])
  assertEqual(missingGitCredentialSecretFields('SSH_KEY', { privateKey: '' }), ['privateKey'])
  assertEqual(missingGitCredentialSecretFields('HTTPS_TOKEN', { token: 't' }), [])
  assertEqual(missingGitCredentialSecretFields('HTTPS_TOKEN', {}), ['token'])
  // 交叉：HTTPS 只给私钥也算缺
  assertEqual(missingGitCredentialSecretFields('HTTPS_TOKEN', { privateKey: 'k' }), ['token'])
})

// ── AAD（sandbox/gitCredential）────────────────────────────────────────
it('AAD = `${userId}:${kind}:${label}`', () => {
  assertEqual(gitCredentialAad('u1', 'SSH_KEY', 'github-work'), 'u1:SSH_KEY:github-work')
})

// ── env ────────────────────────────────────────────────────────────────
it('无凭据 ⇒ 不注入任何 env', () => {
  assertEqual(gitCredentialEnv([]), {})
})

it('SSH 凭据 ⇒ GIT_SSH_COMMAND 指向 $HOME/.ssh/id_ed25519 + accept-new', () => {
  const env = gitCredentialEnv([ssh()])
  assertEqual(env.GIT_TERMINAL_PROMPT, '0', '交互提示应被关掉')
  assertEqual(env.GIT_CONFIG_COUNT, undefined, 'SSH 不应产生 git config')
  assert(env.GIT_SSH_COMMAND !== undefined, '应有 GIT_SSH_COMMAND')
  const cmd = env.GIT_SSH_COMMAND as string
  assert(cmd.includes(`${SANDBOX_AGENT_HOME}/.ssh/id_ed25519`), '应指向私钥绝对路径')
  assert(cmd.includes('IdentitiesOnly=yes'), '应限制只用给的身份')
  assert(cmd.includes('StrictHostKeyChecking=accept-new'), '应为 accept-new（首次可连、之后锁定）')
})

it('多条 SSH ⇒ 追加 -i（第二条起 id_ed25519_2）', () => {
  const env = gitCredentialEnv([ssh(), ssh({ host: 'gitlab.internal' })])
  const cmd = env.GIT_SSH_COMMAND as string
  assert(cmd.includes('.ssh/id_ed25519 '), '应有第一条 -i')
  assert(cmd.includes('.ssh/id_ed25519_2'), '应有第二条 -i（带序号）')
})

it('HTTPS 凭据（带 host）⇒ GIT_CONFIG 指向 http.https://<host>/.extraheader', () => {
  const env = gitCredentialEnv([https()])
  assertEqual(env.GIT_CONFIG_COUNT, '1')
  assertEqual(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  const expected = `Authorization: Basic ${Buffer.from('x-access-token:tok', 'utf8').toString('base64')}`
  assertEqual(env.GIT_CONFIG_VALUE_0, expected)
  assertEqual(env.GIT_TERMINAL_PROMPT, '0')
  assertEqual(env.GIT_SSH_COMMAND, undefined, 'HTTPS 不应产生 GIT_SSH_COMMAND')
})

it('HTTPS 凭据（无 host / 自定义用户名）⇒ http.extraheader + 用户名生效', () => {
  const env = gitCredentialEnv([https({ host: null, secret: { token: 't2', username: 'oauth2' } })])
  assertEqual(env.GIT_CONFIG_KEY_0, 'http.extraheader')
  assertEqual(
    env.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from('oauth2:t2', 'utf8').toString('base64')}`,
  )
})

it('两条 HTTPS ⇒ GIT_CONFIG_COUNT=2 且 key 互不覆盖', () => {
  const env = gitCredentialEnv([https({ host: 'github.com' }), https({ host: 'gitlab.com' })])
  assertEqual(env.GIT_CONFIG_COUNT, '2')
  assertEqual(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assertEqual(env.GIT_CONFIG_KEY_1, 'http.https://gitlab.com/.extraheader')
})

it('空 token 的 HTTPS 条目被忽略（不产生空 config）', () => {
  assertEqual(gitCredentialEnv([https({ secret: { token: '' } })]), {})
})

// ── 落盘文件 ───────────────────────────────────────────────────────────
it('HTTPS 凭据不落盘（零文件）', () => {
  assertEqual(gitCredentialFiles([https()]), [])
})

it('SSH 凭据 ⇒ 先 .ssh 目录（0700）再私钥（0600，末尾换行）', () => {
  const files = gitCredentialFiles([ssh({ secret: { privateKey: 'KEY' } })])
  assertEqual(files.length, 2, '一条 SSH = 目录 + 私钥')
  assertEqual(files[0]?.name, '.ssh/')
  assertEqual(files[0]?.mode, 0o700)
  assertEqual(files[1]?.name, '.ssh/id_ed25519')
  assertEqual(files[1]?.mode, 0o600)
  assertEqual(files[1]?.content.toString('utf8'), 'KEY\n', '末尾应补换行')
})

it('私钥已有换行 ⇒ 不重复补', () => {
  const files = gitCredentialFiles([ssh({ secret: { privateKey: 'KEY\n' } })])
  assertEqual(files[1]?.content.toString('utf8'), 'KEY\n')
})

it('knownHosts 非空 ⇒ 额外落 .ssh/known_hosts（0644）', () => {
  const files = gitCredentialFiles([ssh({ secret: { privateKey: 'K', knownHosts: 'github.com ssh-ed25519 AAAA' } })])
  const known = files.find((file) => file.name === '.ssh/known_hosts')
  assert(known !== undefined, '应有 known_hosts')
  assertEqual(known?.mode, 0o644)
  assertEqual(known?.content.toString('utf8'), 'github.com ssh-ed25519 AAAA\n')
})

it('tar 条目补属主 = SANDBOX_AGENT_UID', () => {
  const entries = gitCredentialTarEntries(gitCredentialFiles([ssh()]))
  assert(entries.every((entry) => entry.uid === SANDBOX_AGENT_UID && entry.gid === SANDBOX_AGENT_UID), '属主应为 agent uid')
})

// ── tar 编码器 ─────────────────────────────────────────────────────────
it('buildTar：块对齐 + 头可读 + 目录/文件 typeflag', () => {
  const tar = buildTar(gitCredentialTarEntries(gitCredentialFiles([ssh({ secret: { privateKey: 'KEY' } })])))
  assertEqual(tar.length % 512, 0, 'tar 长度应 512 对齐')
  const first = readTarHeader(tar)
  assertEqual(first?.name, '.ssh/')
  assertEqual(first?.mode, 0o700)
  // 第二块是私钥头
  const second = readTarHeader(tar.subarray(512))
  assertEqual(second?.name, '.ssh/id_ed25519')
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
