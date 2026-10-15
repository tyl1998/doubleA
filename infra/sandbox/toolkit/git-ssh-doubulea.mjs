#!/usr/bin/env node
/**
 * SSH 包装器（P1-9 · R11 修订）—— `GIT_SSH_COMMAND` 指向它，按需取私钥后再 exec `ssh`
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────────────
 * 原设计把 SSH 私钥 `putArchive` 落到 tmpfs `$HOME`，但容器 `ReadonlyRootfs: true` ⇒ Docker 归档
 * API **直接 400 拒绝**，私钥从来落不了盘。改为：包装器在 git 真要连 SSH 时才向后端
 * `POST /api/sandbox/git/credential {protocol:'ssh'}` 取回私钥，写到**可写的 `/tmp`**（0600）再看
 * `ssh -i <临时私钥>` —— 既绕开只读 rootfs，又做到"凭据不进容器（除非当场在用）"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * git 怎么调用它
 * ─────────────────────────────────────────────────────────────────────
 * git 以 `sh -c` 执行 `$GIT_SSH_COMMAND <ssh 参数…>`（参数里含目标主机与远端命令）。本包装器：
 *   ① 取回全部 SSH 私钥（SSH 的 host 在这里拿不到，统一交给 ssh 依次尝试）；
 *   ② 写到 `/tmp/.doubulea-ssh-<pid>/id_<n>`（0600），有 `knownHosts` 时写 `known_hosts`；
 *   ③ 在原始参数**前面**插入 `-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i <key>…`；
 *   ④ `spawn('ssh', …)` 并透传 stdio / 退出码；
 *   ⑤ 结束清理临时目录。
 * 没有可用私钥时：**原样 exec `ssh`**（行为与没配凭据时一致，不打断别的认证方式如 ssh-agent）。
 *
 * ⚠️ 跨边界契约：路径 / 头名 / 回包形状与 `backend/src/sandbox/gitProxy.ts` 逐字对应。
 */

import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKEND_URL_ENV = 'SANDBOX_BACKEND_URL'
const TOKEN_ENV = 'SANDBOX_TOKEN'
const TIMEOUT_ENV = 'SANDBOX_PROXY_TIMEOUT_MS'
const HEADER = 'x-sandbox-token'
const PATH = '/api/sandbox/git/credential'

const sshArgs = process.argv.slice(2)

async function fetchKeys() {
  const base = process.env[BACKEND_URL_ENV]
  const token = process.env[TOKEN_ENV]
  if (!base || !token) return null
  const timeoutMs = Number(process.env[TIMEOUT_ENV] ?? '180000')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER]: token },
      body: JSON.stringify({ protocol: 'ssh' }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = await res.json()
    if (body && body.kind === 'ssh' && Array.isArray(body.keys) && body.keys.length > 0) return body.keys
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 把私钥/known_hosts 写到临时目录（0700，文件 0600），返回要插进 ssh 的额外参数与清理函数 */
function materialize(keys) {
  const dir = join('/tmp', `.doubulea-ssh-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const extra = ['-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new']
  keys.forEach((key, index) => {
    const keyPath = join(dir, `id_${index}`)
    // 私钥末尾补换行（部分 ssh 实现会对无换行的末行报错）
    const content = key.privateKey.endsWith('\n') ? key.privateKey : `${key.privateKey}\n`
    writeFileSync(keyPath, content, { mode: 0o600 })
    chmodSync(keyPath, 0o600)
    extra.push('-i', keyPath)
  })
  const knownHosts = keys
    .map((key) => (typeof key.knownHosts === 'string' ? key.knownHosts.trim() : ''))
    .filter((text) => text !== '')
    .join('\n')
  if (knownHosts !== '') {
    const khPath = join(dir, 'known_hosts')
    writeFileSync(khPath, knownHosts.endsWith('\n') ? knownHosts : `${knownHosts}\n`, { mode: 0o644 })
    extra.push('-o', `UserKnownHostsFile=${khPath}`)
  }
  return { extra, dir }
}

async function main() {
  const keys = await fetchKeys()
  if (keys === null) {
    // 没有凭据 ⇒ 原样交给系统 ssh（不干扰 ssh-agent / 默认身份）
    const fallback = spawn('ssh', sshArgs, { stdio: 'inherit' })
    fallback.on('exit', (code, signal) => process.exit(signal === null ? code ?? 0 : 128))
    fallback.on('error', () => process.exit(1))
    return
  }
  const { extra, dir } = materialize(keys)
  const child = spawn('ssh', [...extra, ...sshArgs], { stdio: 'inherit' })
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  child.on('exit', (code, signal) => {
    cleanup()
    process.exit(signal === null ? code ?? 0 : 128)
  })
  child.on('error', () => {
    cleanup()
    process.exit(1)
  })
}

void main()
