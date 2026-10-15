#!/usr/bin/env node
/**
 * 冒烟：egress 代理的「模型端点隧道空闲上限」
 *
 * 验证两件事（缺一不可 —— 只有"会掐"的话，正常长连接会被误杀）：
 *   ① 命中策略文件 `modelHosts` 的隧道：上游"建连后一直不发数据" ⇒ 应在 idle 后被**掐断**
 *      （掐断后容器里的引擎收到流错误、走自己的 `auto_retry`）；
 *   ② 不在 `modelHosts` 的隧道：同样的静默 ⇒ **不应被掐断**（对照组；npm/pytest 依赖这条）。
 *
 * 为什么需要它：初版实现把 idle 回调接到 `fail()` 上，而 `fail` 的 `settled` 守卫在
 * `connect` 那一刻就已置位 ⇒ 回调被静默吞掉、隧道永不掐断。**纯读代码看不出来**，
 * 这个冒烟当场抓到了（命中那组 closedMs ≈ idle 而非 ∞）。
 *
 * 用法：node infra/scripts/egress-idle-smoke.mjs   （或 `pnpm egress:idle-smoke`）
 * 完全离线：只用 loopback + 一个"哑上游"（accept 后不写），不碰真模型、不依赖容器。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'egress-proxy.mjs')
const IDLE_MS = 1500
const PROXY_PORT = 13999
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-idle-smoke-'))
const policyFile = path.join(tmpDir, 'policy.json')

function writePolicy(modelHosts) {
  fs.writeFileSync(policyFile, JSON.stringify({ allow: ['*'], deny: [], modelHosts }))
}

/** 上游：accept 之后什么都不发（模拟"回了响应头、正文长时间没有数据"） */
function startSilentUpstream() {
  return new Promise((resolve) => {
    const server = net.createServer(() => {})
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function startProxy() {
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      EGRESS_PORT: String(PROXY_PORT),
      EGRESS_LISTEN_HOST: '127.0.0.1',
      EGRESS_POLICY_FILE: policyFile,
      EGRESS_MODEL_IDLE_TIMEOUT_MS: String(IDLE_MS),
      EGRESS_POLICY_REFRESH_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += String(d)
      if (buf.includes('listening on')) resolve(child)
    })
    child.stderr.on('data', () => {})
  })
}

/** 经代理 CONNECT 到 host:port；返回建连后是否被关闭、以及被关闭的耗时 */
function probe(host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PROXY_PORT, method: 'CONNECT', path: `${host}:${port}` })
    let connectedAt = 0
    req.on('connect', (_res, socket) => {
      connectedAt = Date.now()
      socket.on('close', () => resolve({ connected: true, closedMs: Date.now() - connectedAt }))
      socket.on('error', () => {})
    })
    req.on('error', () => resolve({ connected: false }))
    req.end()
    setTimeout(() => resolve({ connected: true, closedMs: Date.now() - connectedAt, stillOpen: true }), IDLE_MS * 4)
  })
}

const { server: upstream, port: upstreamPort } = await startSilentUpstream()
const proxy = await startProxy()

writePolicy(['127.0.0.1'])
await sleep(600)
const hit = await probe('127.0.0.1', upstreamPort)

writePolicy(['model.example.com'])
await sleep(600)
const miss = await probe('127.0.0.1', upstreamPort)

const okHit = hit.connected === true && hit.stillOpen !== true && hit.closedMs >= IDLE_MS && hit.closedMs < IDLE_MS + 2500
const okMiss = miss.connected === true && miss.stillOpen === true

console.log('egress 模型端点空闲上限 —— 冒烟\n')
console.log(`  [${okHit ? 'PASS' : 'FAIL'}] 命中 modelHosts ⇒ 静默 ${IDLE_MS}ms 后被掐断（实测 ${hit.closedMs}ms）`)
console.log(`  [${okMiss ? 'PASS' : 'FAIL'}] 不在 modelHosts ⇒ 静默 ${IDLE_MS * 4}ms 仍保持（stillOpen=${miss.stillOpen === true}）`)
console.log(`\n冒烟结果：${okHit && okMiss ? '通过' : '失败'}`)

proxy.kill('SIGKILL')
upstream.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
process.exit(okHit && okMiss ? 0 : 1)
