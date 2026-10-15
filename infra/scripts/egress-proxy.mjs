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
 *   EGRESS_POLICY_FILE        策略文件（**平台化主通道**）：JSON `{ allow: [...], deny: [...] }`。
 *                             由 `egress-up.sh` 从 `egress_policy` 表 + 模型池落盘；设置后每
 *                             `EGRESS_POLICY_REFRESH_MS` 轮询热更新（改配置不用重启代理）。
 *   EGRESS_ALLOW              逗号分隔白名单（旧通道 / 兜底）：`host` / `host:port` / `*.host` / `*`
 *   EGRESS_DENY               逗号分隔黑名单（旧通道 / 兜底）
 *   EGRESS_ALLOW_FILE         旧 CSV 白名单文件路径（可省；兼容保留）
 *   EGRESS_DENY_FILE          旧 CSV 黑名单文件路径（可省；兼容保留）
 *   EGRESS_POLICY_REFRESH_MS  策略文件轮询间隔（默认 5000；兼容 EGRESS_ALLOW_REFRESH_MS）
 *   EGRESS_AUDIT_FILE         审计出口：每决策一条 JSONL 追加（省 = 不写，只走 stdout）——
 *                             留给"后面接日志平台做审计"的口子
 *   EGRESS_CONNECT_TIMEOUT_MS 建连超时（默认 30000）
 *   EGRESS_LOG_BODIES         非空 = 明文 HTTP 的 ALLOW 也逐条打日志（默认只记 DENY 与错误）
 *
 * ⚠️ **策略语义**（与 `shared/src/egressPolicy.ts` 逐字一致）：`deny` 优先；两张表都空 = **全放行**；
 *    只配 allow = 只放行 allow；只配 deny = 除 deny 外全放行。模型池主机由写文件的 `egress-up.sh`
 *    **并入 allow**（"模型默认放行"在同步层做，不在本文件）。
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
const DENY_ENV = process.env.EGRESS_DENY ?? ''
/**
 * 策略文件（JSON `{ allow: [...], deny: [...] }`）—— 由 `egress-up.sh` 写、本进程 5s 轮询热更新。
 * 这是**平台化**之后的唯一下发通道（`egress_policy` 表 → 本文件 → 本代理）。
 */
const POLICY_FILE = process.env.EGRESS_POLICY_FILE ?? ''
/** 旧 CSV 通道（保留兼容：只有 allow 文件时 = 纯白名单） */
const ALLOW_FILE = process.env.EGRESS_ALLOW_FILE ?? ''
const DENY_FILE = process.env.EGRESS_DENY_FILE ?? ''
const REFRESH_MS = Number(process.env.EGRESS_POLICY_REFRESH_MS ?? process.env.EGRESS_ALLOW_REFRESH_MS ?? 5_000)
/** 审计出口：每决策一条 JSONL 追加。留作后续接日志平台的口子（默认空 = 不写，只走 stdout） */
const AUDIT_FILE = process.env.EGRESS_AUDIT_FILE ?? ''

/**
 * 运行态策略：两张表 + 推导的"是否全放行"。
 *   · 默认（两者皆空）= **全放行**（Code 模式 git 出网的口径）；
 *   · 只配 allow ⇒ 只放行 allow；
 *   · 只配 deny ⇒ 除 deny 外全放行；
 *   · 都有 ⇒ **deny 优先**，其余看 allow。
 *
 * ⚠️ **出网范围是平台级**（`egress_policy.scope`，P1-16a）：由 `egress-up.sh` 解析成这里的
 *    `allow` / `deny` 两张表（`ALL`⇒`['*']`、`NONE`/`REGISTRY`⇒白名单）⇒ **本代理不认识 scope，
 *    也不做 per-conversation**（会话级出网覆盖已按 2026-10-14 用户定案移除）。
 */
let POLICY = { allow: [], deny: [], allowAll: true, source: 'default' }

/** CSV 串 / 数组 → 去空白、去空段、小写、去重（保持顺序） */
function toRules(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',')
  const out = []
  for (const raw of items) {
    const item = String(raw).trim().toLowerCase()
    if (item !== '' && !out.includes(item)) out.push(item)
  }
  return out
}

/** 由两张表推导"是否全放行"（与 `shared#deriveEgressMode` 同语义） */
function isAllowAll(allow, deny) {
  if (allow.includes('*')) return true
  return allow.length === 0 && deny.length === 0
}

function applyPolicy(allow, deny, source) {
  const normalized = { allow: toRules(allow), deny: toRules(deny) }
  POLICY = { ...normalized, allowAll: isAllowAll(normalized.allow, normalized.deny), source }
  return POLICY
}

/** 策略摘要（日志 / `/healthz` 用） */
function describePolicy() {
  const mode = POLICY.allowAll ? '全放行' : POLICY.allow.length > 0 ? '仅白名单' : '黑名单'
  return `${mode}｜allow ${POLICY.allow.length} 条 / deny ${POLICY.deny.length} 条（来源 ${POLICY.source}）`
}

function rulesFromCsvFile(file) {
  return fs.readFileSync(file, 'utf8').trim().split(',').map((s) => s.trim()).filter(Boolean)
}

/** 读并校验策略文件（JSON `{allow,deny}`）；形状不对就抛（调用方保留上一份） */
function readPolicyFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('策略文件不是对象')
  if (parsed.allow !== undefined && !Array.isArray(parsed.allow)) throw new Error('allow 不是数组')
  if (parsed.deny !== undefined && !Array.isArray(parsed.deny)) throw new Error('deny 不是数组')
  return { allow: toRules(parsed.allow ?? []), deny: toRules(parsed.deny ?? []) }
}

// 初始策略：优先策略文件 → 旧 CSV 文件 → env → 默认全放行
let initialSource = 'default'
if (POLICY_FILE !== '') {
  try {
    const { allow, deny } = readPolicyFile(POLICY_FILE)
    applyPolicy(allow, deny, 'policy-file')
    initialSource = 'policy-file'
  } catch {
    /* 文件还没就绪 → 继续往下 */
  }
}
if (initialSource === 'default' && (ALLOW_FILE !== '' || DENY_FILE !== '')) {
  try {
    const allow = ALLOW_FILE === '' ? [] : toRules(rulesFromCsvFile(ALLOW_FILE))
    const deny = DENY_FILE === '' ? [] : toRules(rulesFromCsvFile(DENY_FILE))
    if (allow.length > 0 || deny.length > 0) {
      applyPolicy(allow, deny, 'csv-file')
      initialSource = 'csv-file'
    }
  } catch {
    /* 文件还没就绪 → 用 env */
  }
}
if (initialSource === 'default') {
  const allow = toRules(ALLOW_ENV)
  const deny = toRules(DENY_ENV)
  const source = allow.length > 0 || deny.length > 0 ? 'env' : 'default'
  applyPolicy(allow, deny, source)
  initialSource = source
}

// 策略热更新：轮询文件（策略文件优先，否则旧 CSV 两件套），内容变才换。
// ⚠️ 解析失败 = 一次坏写入，**保留旧策略**并告警 —— 别让写一半把出口整个关掉 / 全开。
function reloadPolicy() {
  if (POLICY_FILE !== '') {
    const { allow, deny } = readPolicyFile(POLICY_FILE)
    if (JSON.stringify(allow) === JSON.stringify(POLICY.allow) && JSON.stringify(deny) === JSON.stringify(POLICY.deny)) return
    applyPolicy(allow, deny, 'policy-file')
    log(`出网策略已热更新：${describePolicy()}`)
    return
  }
  const allow = ALLOW_FILE === '' ? POLICY.allow : toRules(rulesFromCsvFile(ALLOW_FILE))
  const deny = DENY_FILE === '' ? POLICY.deny : toRules(rulesFromCsvFile(DENY_FILE))
  if (JSON.stringify(allow) === JSON.stringify(POLICY.allow) && JSON.stringify(deny) === JSON.stringify(POLICY.deny)) return
  applyPolicy(allow, deny, 'csv-file')
  log(`出网策略已热更新：${describePolicy()}`)
}

if (POLICY_FILE !== '' || ALLOW_FILE !== '' || DENY_FILE !== '') {
  setInterval(() => {
    try {
      reloadPolicy()
    } catch (error) {
      log(`警告：策略文件解析失败，保留上一份（${error instanceof Error ? error.message : String(error)}）`)
    }
  }, REFRESH_MS)
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

/** 当前模式（推导值；与 `shared#deriveEgressMode` 同语义） */
function currentMode() {
  if (POLICY.allowAll) return 'ALLOW_ALL'
  return POLICY.allow.length > 0 ? 'WHITELIST' : 'BLACKLIST'
}

/**
 * 策略判定（**deny 优先**，与 `shared#decideEgress` 逐字一致）。
 * ⚠️ 出网范围是**平台级**（`egress-up.sh` 已把 scope 解析成这两张表）⇒ 本代理不做 per-conversation。
 * @returns {{ allowed: boolean, reason: string }}
 */
function decide(host, port) {
  const h = host.toLowerCase()
  if (POLICY.deny.some((rule) => matchRule(rule, h, port))) return { allowed: false, reason: 'deny-list' }
  const mode = currentMode()
  if (mode === 'WHITELIST') {
    return POLICY.allow.some((rule) => matchRule(rule, h, port))
      ? { allowed: true, reason: 'in-allow-list' }
      : { allowed: false, reason: 'not-in-allow-list' }
  }
  return { allowed: true, reason: mode === 'ALLOW_ALL' ? 'allow-all' : 'no-deny-match' }
}

/** 审计：每决策一条 JSONL 追加到 `EGRESS_AUDIT_FILE`（尽力而为，失败不影响转发） */
function audit(decision, method, host, port, reason) {
  if (AUDIT_FILE === '') return
  const line = `${JSON.stringify({ ts: new Date().toISOString(), decision, method, host, port, reason })}\n`
  fs.appendFile(AUDIT_FILE, line, () => {})
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

  const verdict = decide(host, port)
  if (!verdict.allowed) {
    log(`DENY  CONNECT ${host}:${port}（${verdict.reason}）`)
    audit('deny', 'CONNECT', host, port, verdict.reason)
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
    audit('allow', 'CONNECT', host, port, verdict.reason)
  })
  upstream.on('error', (err) => fail(err.code ?? err.message))
  clientSocket.on('error', () => upstream.destroy())
  clientSocket.on('close', () => upstream.destroy())
})

// ── 出口①：明文 HTTP（absolute-form，浏览器/undici 走代理时的形态）─────────
server.on('request', (req, res) => {
  if (req.url === '/healthz' || req.url === 'http://egress/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        {
          ok: true,
          mode: currentMode(),
          allow: POLICY.allow,
          deny: POLICY.deny,
          source: POLICY.source,
        },
        null,
        2,
      ),
    )
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
  const verdict = decide(target.hostname, port)
  if (!verdict.allowed) {
    log(`DENY  ${req.method} ${target.hostname}:${port}${target.pathname}（${verdict.reason}）`)
    audit('deny', req.method, target.hostname, port, verdict.reason)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('403 Forbidden（目标不在 egress 放行策略内）\n')
    return
  }

  if (LOG_BODIES) log(`ALLOW ${req.method} ${target.hostname}:${port}${target.pathname}`)
  audit('allow', req.method, target.hostname, port, verdict.reason)

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
  log(`出网策略（初始来源 ${initialSource}）：${describePolicy()}`)
  if (!POLICY.allowAll && POLICY.allow.length > 0) {
    log(`只放行白名单，其余目标一律 403：allow=[${POLICY.allow.join(', ')}]`)
  } else if (!POLICY.allowAll) {
    log(`黑名单模式：deny=[${POLICY.deny.join(', ')}]，其余放行`)
  } else {
    log('全放行模式（两张表皆空 / allow 含 `*`）')
  }
})
