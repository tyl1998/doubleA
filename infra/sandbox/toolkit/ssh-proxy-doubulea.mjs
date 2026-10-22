#!/usr/bin/env node
/**
 * SSH ProxyCommand 助手（P1-21）—— 让容器内的 `ssh` / `git` 经 **egress 代理**出网
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────────────
 * 沙箱挂在自己的 `internal` bridge 上：**没有到公网的 DNS/路由**，出网只能经 egress 代理。
 * 模型池走 `HTTPS_PROXY` 没问题，但 **SSH(22) 不经 HTTP 代理**（ssh 不读 `HTTPS_PROXY`）⇒
 * `git clone git@scm.example.com:...` 直接报
 * `ssh: Could not resolve hostname ...` —— 而平台里配的 SSH 私钥其实完全可用。
 *
 * 本脚本就是 `ProxyCommand`：先向 egress 代理发 `CONNECT <host>:<port>`，拿到 200 后把这条
 * 隧道接到自己的 stdio 上，ssh 随后照常在这条 socket 上跑协议。零依赖（只用 node 内置模块），
 * 镜像里 Node 已有，不需要额外装 `nc` / `socat` / `connect-proxy`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 怎么被用上（P1-21 起是**默认行为**，不是模型自己拼）
 * ─────────────────────────────────────────────────────────────────────
 * `git-ssh-doubulea.mjs`（`GIT_SSH_COMMAND` 指向它）会：
 *   ① 取回私钥并写进 `/tmp`（原 R11 逻辑不变）；
 *   ② **并且**追加 `-o ProxyCommand=/opt/sandbox-git/ssh-proxy-doubulea.mjs %h %p`
 *      —— 只有当它确实拿得到 egress 代理地址、且调用方没有自己指定 ProxyCommand 时才追加。
 * 于是 `git clone git@内网域名:...` 开箱可用，不再依赖模型临场写脚本。
 *
 * ⚠️ 与 **HTTPS** 路径无关：https 走的是 `HTTPS_PROXY`（git 自己会读），不经过本脚本。
 * ⚠️ 不做鉴权：它只是把一条 TCP 隧道接到 stdio；凭据与身份校验在平台侧。
 *
 * 用法（由 ssh 通过 ProxyCommand 调用）：
 *   ssh-proxy-doubulea.mjs <host> <port>
 *
 * 环境变量（按顺序取第一个非空的）：
 *   SANDBOX_SSH_PROXY_URL → HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy
 * 超时：SANDBOX_PROXY_TIMEOUT_MS（默认 180000，与容器侧其它代理调用同口径）
 */

import net from 'node:net'

const TIMEOUT_ENV = 'SANDBOX_PROXY_TIMEOUT_MS'
/** 显式覆盖项：平台注入它即可改走别的代理（不注入时按下面的顺序回落） */
const PROXY_URL_ENV = 'SANDBOX_SSH_PROXY_URL'
const PROXY_URL_FALLBACK_ENVS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

const [targetHost, targetPortRaw] = process.argv.slice(2)

function die(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!targetHost || !targetPortRaw) die('usage: ssh-proxy-doubulea.mjs <host> <port>')
const targetPort = Number(targetPortRaw)
if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
  die(`invalid port: ${targetPortRaw}`)
}

function proxyUrl() {
  const explicit = process.env[PROXY_URL_ENV]
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  for (const name of PROXY_URL_FALLBACK_ENVS) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

const raw = proxyUrl()
if (raw === '') die(`no proxy configured（${PROXY_URL_ENV} / HTTPS_PROXY / HTTP_PROXY 都为空）`)

let proxy
try {
  proxy = new URL(raw)
} catch {
  die(`invalid proxy url: ${raw}`)
}
if (proxy.protocol !== 'http:') die(`unsupported proxy scheme: ${proxy.protocol}（只支持 http://）`)
const proxyPort = Number(proxy.port === '' ? 80 : proxy.port)
const proxyHost = proxy.hostname

const timeoutMs = Number(process.env[TIMEOUT_ENV] ?? '180000')

let established = false
const socket = net.connect(proxyPort, proxyHost, () => {
  const authority = `${targetHost}:${targetPort}`
  let head = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`
  // 代理带 Basic 凭据时补上（egress 代理当前不需要，但别让它成为将来的坑）
  if (proxy.username !== '' || proxy.password !== '') {
    const token = Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
    ).toString('base64')
    head += `Proxy-Authorization: Basic ${token}\r\n`
  }
  // 隧道请求不带 body ⇒ 不加 Content-Length（代理对 CONNECT 的 body 语义并不统一）
  socket.write(`${head}\r\n`)
})

// 握手阶段才设超时；隧道建立后必须清掉（git 传输可能长时间静默，见 sandbox-relay.mjs 的同款教训）
socket.setTimeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000, () => {
  if (!established) die('proxy CONNECT handshake timeout')
})
socket.setNoDelay(true)

let pending = Buffer.alloc(0)
socket.on('data', (chunk) => {
  if (established) return
  pending = Buffer.concat([pending, chunk])
  const headerEnd = pending.indexOf('\r\n\r\n')
  if (headerEnd === -1) return
  const statusLine = pending.subarray(0, pending.indexOf('\r\n')).toString()
  const status = Number((statusLine.split(' ')[1] ?? '').trim())
  if (status !== 200) die(`proxy CONNECT failed: ${statusLine}`)
  established = true
  socket.setTimeout(0)
  const rest = pending.subarray(headerEnd + 4)
  pending = Buffer.alloc(0)
  if (rest.length > 0) process.stdout.write(rest)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})

socket.on('error', (error) => die(`proxy socket error: ${error.message}`))
// ssh 关掉这端（或对端 EOF）时干净退出：ProxyCommand 的退出码会被 ssh 当成"隧道断了"
process.stdin.on('error', () => process.exit(0))
socket.on('close', () => process.exit(0))
