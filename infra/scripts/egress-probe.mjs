#!/usr/bin/env node
/**
 * egress-probe.mjs — 从**沙箱网络里**验证 egress 代理（零依赖）
 *
 * ⚠️ **为什么不能直接用 `fetch` + `HTTPS_PROXY`**：Node 的全局 `fetch` **不读代理
 *    环境变量** —— undici 的 fetch 默认 dispatcher 是裸 `Agent`。沙箱里能走通是因为
 *    pi 显式装了 `undici.EnvHttpProxyAgent`（`子方案③` §四 3 的源码级实测）。
 *    所以"容器里 fetch 一下"这种验证**会误判成"代理不工作"**，必须自己建隧道。
 *
 * 做法：手写 CONNECT 隧道 → 在隧道上做 TLS → 在 TLS 上发一个最小 HTTP/1.1 请求。
 * 走通即为"放行"；代理回 4xx 即为"被白名单拦下"。
 *
 * 用法：
 *   HTTPS_PROXY=http://doubulea-egress:3128 node egress-probe.mjs https://api.example.com/v1/models
 *   node egress-probe.mjs https://api.example.com/v1/models          # 不设代理 = 直连
 *
 * 退出码：0 = 请求走通（HTTP 码在输出里）  3 = 被代理拦下（4xx）  1 = 连不上  2 = 用法错
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const target = process.argv[2]
if (!target || target === '-h' || target === '--help') {
  console.error('用法: node egress-probe.mjs <url>   （代理从 HTTPS_PROXY / HTTP_PROXY 读）')
  process.exit(2)
}

let url
try {
  url = new URL(target)
} catch {
  console.error(`不是合法 URL: ${target}`)
  process.exit(2)
}

const isTls = url.protocol === 'https:'
const proxyUrl = (isTls ? process.env.HTTPS_PROXY : process.env.HTTP_PROXY) || ''
const host = url.hostname
const port = Number(url.port || (isTls ? 443 : 80))
const path = `${url.pathname}${url.search}`

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20_000)

function connectTunnel(proxy, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxy)
    const req = http.request({
      host: p.hostname,
      port: Number(p.port || 80),
      method: 'CONNECT',
      path: `${destHost}:${destPort}`,
      headers: { host: `${destHost}:${destPort}` },
    })
    let settled = false
    req.on('connect', (res, socket) => {
      settled = true
      resolve({ status: res.statusCode ?? 0, socket })
    })
    req.on('response', (res) => {
      // 代理拒绝 CONNECT（例如 403）时会走这里，而不是 'connect'
      settled = true
      res.resume()
      resolve({ status: res.statusCode ?? 0, socket: null })
    })
    req.on('error', (err) => {
      if (!settled) reject(err)
    })
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`经代理建连超时 ${TIMEOUT_MS}ms`)))
    req.end()
  })
}

/** 在一条已建立（且已 TLS）的会话上发一个最小 HTTP/1.1 请求，取状态行 */
function readStatus(socket, hostHeader, reqPath) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`读响应超时 ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\r\n')
      if (nl > 0) {
        clearTimeout(timer)
        socket.destroy()
        resolve(buf.slice(0, nl).trim())
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    socket.write(
      `GET ${reqPath} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        'Accept: application/json\r\n' +
        'User-Agent: doubulea-egress-probe\r\n' +
        'Connection: close\r\n\r\n',
    )
  })
}

function directRequest() {
  return new Promise((resolve, reject) => {
    const mod = isTls ? https : http
    const req = mod.request({ host, port, path, method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`直连超时 ${TIMEOUT_MS}ms`)))
    req.end()
  })
}

async function main() {
  if (!proxyUrl) {
    console.log(`[probe] 无代理（HTTPS_PROXY/HTTP_PROXY 都空）⇒ 直连 ${url.origin}`)
    try {
      const status = await directRequest()
      console.log(`[probe] OK   ${status}  ${url.href}`)
      process.exit(0)
    } catch (err) {
      console.log(`[probe] FAIL ${err.code ?? err.message}  ${url.href}`)
      process.exit(1)
    }
  }

  console.log(`[probe] 经代理 ${proxyUrl} → ${url.origin}`)
  let tunnel
  try {
    tunnel = await connectTunnel(proxyUrl, host, port)
  } catch (err) {
    console.log(`[probe] FAIL 隧道没建起来：${err.code ?? err.message}`)
    process.exit(1)
  }

  if (tunnel.status !== 200 || !tunnel.socket) {
    console.log(`[probe] BLOCKED 代理回 ${tunnel.status}（不在白名单 ⇒ 403）`)
    process.exit(3)
  }

  let socket = tunnel.socket
  if (isTls) {
    try {
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host })
        s.once('secureConnect', () => resolve(s))
        s.once('error', reject)
        setTimeout(() => reject(new Error('TLS 握手超时')), TIMEOUT_MS)
      })
    } catch (err) {
      console.log(`[probe] FAIL 隧道通了但 TLS 握手失败：${err.code ?? err.message}`)
      process.exit(1)
    }
  }

  try {
    const statusLine = await readStatus(socket, url.host, path)
    console.log(`[probe] OK  ${statusLine}  ${url.href}`)
    process.exit(0)
  } catch (err) {
    console.log(`[probe] FAIL 隧道通了但读响应失败：${err.code ?? err.message}`)
    process.exit(1)
  }
}

await main()
