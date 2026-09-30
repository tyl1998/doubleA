#!/usr/bin/env node
/**
 * sandbox-relay.mjs — 出口②（容器 → 后端）的「双宿中转」（**本机 / Docker 在 VM 里时用**，零依赖）
 *
 * 为什么存在：沙箱容器挂在 `doubulea-sandbox`（`Internal: true`）上，只能到该 bridge 的网关。
 * 生产（后端与 Docker 同宿主）时，网关地址就是后端 listener ⇒ 直接可达，**不需要本文件**
 * （`manager.ts` 会把 `SANDBOX_BACKEND_URL` 兜底成 `http://<网关>:<callbackPort>`）。
 *
 * 但 macOS（OrbStack）/ Windows（Docker Desktop）上 Docker 跑在一台 Linux VM 里
 * ⇒ bridge 网关是那台 VM，**不是**跑后端的宿主 ⇒ 容器到不了后端（P0-3-3 实测 `ENETUNREACH`）。
 * 本文件补的就是这段：一个**裸 TCP 转发**，把容器发到本容器的流量转给目标（默认
 * `host.docker.internal:<port>` = Docker Desktop 提供的宿主别名）。
 *
 * 形态（与 `egress-proxy.mjs` 同款「两条腿」）：由 `relay-up.sh` / `relay-up.ps1` 负责接网 ——
 *   一条腿挂在默认 bridge（够得着 `host.docker.internal`），另一条挂在 `doubulea-sandbox`
 *   （沙箱容器够得着本中转）。只有一条腿的中转在 internal 网络上等于没有。
 *
 * ⚠️ **不做鉴权**：它只是把 TCP 原样转给后端 listener；身份校验在后端（`x-sandbox-token`）。
 * ⚠️ **不对已建立的连接设 idle 超时**：模型流式响应 / SSE 可能长时间静默，设了会把正常
 *    的慢响应掐断（症状是"答一半没了"，极易误判成引擎问题）。
 *
 * 环境变量：
 *   RELAY_LISTEN_HOST   监听地址（默认 0.0.0.0；容器里必须非回环，否则沙箱够不着）
 *   RELAY_LISTEN_PORT   监听端口（默认 13001，= `SANDBOX_CALLBACK_PORT`）
 *   RELAY_TARGET_HOST   目标主机（默认 host.docker.internal）
 *   RELAY_TARGET_PORT   目标端口（默认 = RELAY_LISTEN_PORT）
 *   RELAY_LOG           非空 = 每个连接记一行日志（默认只记错误）
 */
import net from 'node:net'

const LISTEN_HOST = process.env.RELAY_LISTEN_HOST ?? '0.0.0.0'
const LISTEN_PORT = Number(process.env.RELAY_LISTEN_PORT ?? 13001)
const TARGET_HOST = process.env.RELAY_TARGET_HOST ?? 'host.docker.internal'
const TARGET_PORT = Number(process.env.RELAY_TARGET_PORT ?? LISTEN_PORT)
const LOG = (process.env.RELAY_LOG ?? '') !== ''

function ts() {
  return new Date().toISOString().slice(11, 23)
}

function log(...args) {
  console.log(`[relay ${ts()}]`, ...args)
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT })

  const fail = (reason) => {
    if (LOG) log(`ERR  ${reason}`)
    client.destroy()
    upstream.destroy()
  }

  upstream.on('connect', () => {
    if (LOG) log(`OPEN ${client.remoteAddress} → ${TARGET_HOST}:${TARGET_PORT}`)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  upstream.on('error', (err) => fail(`${TARGET_HOST}:${TARGET_PORT} — ${err.code ?? err.message}`))
  client.on('error', () => upstream.destroy())
  client.on('close', () => upstream.destroy())
})

server.on('error', (err) => {
  log(`致命：监听 ${LISTEN_HOST}:${LISTEN_PORT} 失败 — ${err.code ?? err.message}`)
  process.exit(1)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT}`)
})
