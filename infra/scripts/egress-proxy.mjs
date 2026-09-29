#!/usr/bin/env node
/**
 * 最小 egress 正向代理（**本机开发用**，零依赖）
 *
 * 为什么存在：沙箱容器挂在 `doubulea-sandbox`（`Internal: true`）上没有公网路由
 * ⇒ 出公网**只可能**经出口①（`子方案③` §四 3）。仓库原本不提供代理实现
 * （"代理本身不属 P0 加固范围"），于是本机一跑就撞 `ensureSandbox()` 的显式拒绝。
 * 本文件补的就是这个缺口 —— **它是开发便利件，不是 P0 交付物、不进验收口径**。
 *
 * 形态（`README` 前置 ③ 的两条要求）：
 *   · **两条腿**：由 `egress-up.sh` 负责 —— 一条挂在 `doubulea-sandbox`，
 *     另一条挂在默认 bridge（能上网）。只有一条腿的代理在 internal 网络上等于没有。
 *   · **无鉴权**：注入进容器 env 的就是裸 URL（`HTTP_PROXY` / `HTTPS_PROXY`），
 *     本代理不读 `Proxy-Authorization`。
 *
 * 额外做了一件事：**白名单**（`EGRESS_ALLOW`）。仓库对出口① 的定义是"只放行模型池
 * baseURL"，而现成的 squid/tinyproxy 默认全放行 —— 那等于把"专用 internal bridge"
 * 这层设计意图作废。所以这里默认**只放行点名的主机**，空名单直接拒启（不是"全放行"）。
 *
 * 环境变量：
 *   EGRESS_PORT               监听端口（默认 3128）
 *   EGRESS_LISTEN_HOST        绑定地址（默认 0.0.0.0；容器里必须非回环，否则沙箱够不着）
 *   EGRESS_ALLOW              逗号分隔白名单：`host` / `host:port` / `*.host`；`*` = 全放行
 *                             **启动兜底**用（`egress-up.sh` 每次都带）
 *   EGRESS_ALLOW_FILE         已挂载的白名单文件路径（可省）。设置后：
 *                             ① 启动时**优先**读它（`egress-up.sh` 已把它写好）；
 *                             ② 之后每 `EGRESS_ALLOW_REFRESH_MS` 轮询一次，内容变了
 *                                **热更新**规则 —— 库里加了新 provider 不用重启代理。
 *   EGRESS_ALLOW_REFRESH_MS   白名单文件轮询间隔（默认 5000）
 *   EGRESS_CONNECT_TIMEOUT_MS 建连超时（默认 30000）
 *   EGRESS_LOG_BODIES         非空 = 记一行每请求日志（默认只记放行/拒绝与错误）
 *
 * ⚠️ **不对已建立的隧道设 idle 超时**：模型流式响应可能长时间静默，
 *    设了会把正常的慢响应掐断（症状是"模型答一半没了"，极易误判成引擎问题）。
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs'

const PORT = Number(process.env.EGRESS_PORT ?? 3128)
const LISTEN_HOST = process.env.EGRESS_LISTEN_HOST ?? '0.0.0.0'
const CONNECT_TIMEOUT_MS = Number(process.env.EGRESS_CONNECT_TIMEOUT_MS ?? 30_000)
const LOG_BODIES = (process.env.EGRESS_LOG_BODIES ?? '') !== ''
const ALLOW_ENV = process.env.EGRESS_ALLOW ?? ''
const ALLOW_FILE = process.env.EGRESS_ALLOW_FILE ?? ''
const ALLOW_REFRESH_MS = Number(process.env.EGRESS_ALLOW_REFRESH_MS ?? 5_000)

let RULES = []
let ALLOW_ALL = false

/** 把一串规则（可含空段）装进运行态；返回装好的规则数组 */
function applyRules(entries) {
  RULES = entries.filter((s) => s !== '')
  ALLOW_ALL = RULES.includes('*')
  return RULES
}

function rulesFromEnv() {
  return ALLOW_ENV.split(',').map((s) => s.trim()).filter(Boolean)
}

function rulesFromFile(file) {
  const content = fs.readFileSync(file, 'utf8').trim()
  return content.split(',').map((s) => s.trim()).filter(Boolean)
}

// 初始规则：优先已挂载的白名单文件（`egress-up.sh` 起容器前已写好）；读不到退回 env
let initialSource = 'env'
if (ALLOW_FILE !== '') {
  try {
    const fromFile = rulesFromFile(ALLOW_FILE)
    if (fromFile.length > 0) {
      applyRules(fromFile)
      initialSource = 'file'
    }
  } catch {
    /* 文件还没就绪 → 用 env */
  }
}
if (RULES.length === 0) applyRules(rulesFromEnv())

if (RULES.length === 0) {
  console.error(
    '[egress] 致命：EGRESS_ALLOW 为空。\n' +
      '         空白名单 = 一个目标也放行不了（故意的：别让"忘了配"退化成"全放行"）。\n' +
      '         真要临时全放行请显式写 EGRESS_ALLOW=*',
  )
  process.exit(1)
}

if (ALLOW_ALL) {
  console.warn('[egress] ⚠️  EGRESS_ALLOW=* —— 白名单关闭，任何目标都放行（只建议临时排查用）')
}

// 白名单热更新：轮询已挂载的文件，内容变了就换规则（库里加 provider 不用重启代理）。
// ⚠️ 空内容 = 一次坏写入，**保留旧规则**并告警 —— 别让写一半把出口整个关掉。
if (ALLOW_FILE !== '') {
  let last = ''
  try {
    last = fs.readFileSync(ALLOW_FILE, 'utf8').trim()
  } catch {
    last = ''
  }
  setInterval(() => {
    let content = ''
    try {
      content = fs.readFileSync(ALLOW_FILE, 'utf8').trim()
    } catch {
      return
    }
    if (content === last) return
    last = content
    const next = content.split(',').map((s) => s.trim()).filter(Boolean)
    if (next.length === 0) {
      log(`警告：白名单文件变成空，已忽略（保留上一份规则）`)
      return
    }
    applyRules(next)
    log(`白名单已热更新（${RULES.length} 条）：${RULES.join(', ')}`)
  }, ALLOW_REFRESH_MS)
}

/** 规则 → 是否命中。规则形态：`host`、`host:port`、`*.host`、`*` */
function matchRule(rule, host, port) {
  if (rule === '*') return true
  let ruleHost = rule
  let rulePort = null
  const colon = rule.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(rule.slice(colon + 1))) {
    ruleHost = rule.slice(0, colon)
    rulePort = Number(rule.slice(colon + 1))
  }
  if (rulePort !== null && rulePort !== port) return false
  const h = host.toLowerCase()
  const rh = ruleHost.toLowerCase()
  if (rh.startsWith('*.')) {
    const base = rh.slice(2)
    return h === base || h.endsWith(`.${base}`)
  }
  return h === rh
}

function isAllowed(host, port) {
  if (ALLOW_ALL) return true
  return RULES.some((r) => matchRule(r, host, port))
}

function ts() {
  return new Date().toISOString().slice(11, 23)
}

function log(...args) {
  console.log(`[egress ${ts()}]`, ...args)
}

/** `host:port` / `[v6]:port` / `host` → [host, port] */
function splitTarget(authority, fallbackPort) {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    const host = authority.slice(1, end)
    const rest = authority.slice(end + 1)
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort
    return [host, port]
  }
  const colon = authority.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) {
    return [authority.slice(0, colon), Number(authority.slice(colon + 1))]
  }
  return [authority, fallbackPort]
}

// ── 出口①：HTTPS/任意 TCP（CONNECT 隧道）───────────────────────────────────
const server = http.createServer()

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = splitTarget(req.url, 443)

  if (!isAllowed(host, port)) {
    log(`DENY  CONNECT ${host}:${port}`)
    clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    return
  }

  const upstream = net.connect({ host, port })
  let settled = false

  const fail = (reason) => {
    if (settled) return
    settled = true
    log(`ERR   CONNECT ${host}:${port} — ${reason}`)
    clientSocket.destroy()
    upstream.destroy()
  }

  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => fail(`建连超时 ${CONNECT_TIMEOUT_MS}ms`))
  upstream.on('connect', () => {
    settled = true
    upstream.setTimeout(0) // ★ 隧道建成后撤掉超时：流式响应可以长时间静默
    clientSocket.setTimeout(0)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
    log(`ALLOW CONNECT ${host}:${port}`)
  })
  upstream.on('error', (err) => fail(err.code ?? err.message))
  clientSocket.on('error', () => upstream.destroy())
  clientSocket.on('close', () => upstream.destroy())
})

// ── 出口①：明文 HTTP（absolute-form，浏览器/undici 走代理时的形态）─────────
server.on('request', (req, res) => {
  if (req.url === '/healthz' || req.url === 'http://egress/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rules: RULES, allowAll: ALLOW_ALL }, null, 2))
    return
  }

  let target
  try {
    target = new URL(req.url)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('本代理只接受 absolute-form 请求（http://host/path）或 CONNECT 隧道\n')
    return
  }

  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (!isAllowed(target.hostname, port)) {
    log(`DENY  ${req.method} ${target.hostname}:${port}${target.pathname}`)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('403 Forbidden（目标不在 egress 白名单里）\n')
    return
  }

  if (LOG_BODIES) log(`ALLOW ${req.method} ${target.hostname}:${port}${target.pathname}`)

  // 逐跳头必须剥掉，否则会把客户端的代理语义转给上游
  const headers = { ...req.headers }
  delete headers['proxy-connection']
  delete headers['proxy-authorization']
  headers.host = target.hostname + (target.port ? `:${target.port}` : '')

  const mod = target.protocol === 'https:' ? https : http
  const upstream = mod.request(
    {
      host: target.hostname,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('建连超时')))
  upstream.on('response', () => upstream.setTimeout(0))
  upstream.on('error', (err) => {
    log(`ERR   ${req.method} ${target.hostname}:${port} — ${err.code ?? err.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('502 Bad Gateway（经本代理到上游失败）\n')
  })
  req.pipe(upstream)
})

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(PORT, LISTEN_HOST, () => {
  log(`listening on ${LISTEN_HOST}:${PORT}`)
  log(`白名单（${RULES.length} 条）：${RULES.join(', ')}`)
  if (!ALLOW_ALL) {
    log('不在白名单的目标一律 403 —— 三条腿的验证方式见 infra/scripts/egress-up.sh 输出')
  }
})
