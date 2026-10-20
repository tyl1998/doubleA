#!/usr/bin/env node
/**
 * router-compose-check.mjs —— 两套 compose 的**配置自检**（P1-14 · R1 的"自证：compose 配置校验"）
 *
 * 依据：`docs/06` §五·补 P1-14 · R1 的验收判据（"自证：镜像构建 + compose 配置校验"）。
 *
 * ── 它做什么 ─────────────────────────────────────────────────────────
 * 对 `infra/router/docker-compose.host.yml`、`docker-compose.router.yml` 与 `infra/frontend/docker-compose.yml` 各跑一次
 * `docker compose ... config -q`，并喂一份**最小可用的 env**
 * （真实 `.env.*` 不进仓库、也不该在 CI 上存在 ⇒ 全部进程环境注入）。
 *
 * ⚠️ `docker compose config` **不需要 daemon**（只做解析与校验），但需要 compose v2 插件；
 *    没有插件时本脚本**跳过并说明**（不算失败 —— 本机可能只装了 docker CLI）。
 *
 * 用法：`pnpm router:config`（root）；也可 `node infra/scripts/router-compose-check.mjs`
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const INFRA_DIR = join(REPO_ROOT, 'infra')
const ROUTER_DIR = join(INFRA_DIR, 'router')

const C = { red: '\u001b[31m', green: '\u001b[32m', cyan: '\u001b[36m', dim: '\u001b[90m', reset: '\u001b[0m' }
const step = (title) => console.log(`\n${C.cyan}=== ${title} ===${C.reset}`)
const ok = (line) => console.log(`  ${C.green}[OK]${C.reset} ${line}`)
const info = (line) => console.log(`  ${C.dim}[--]${C.reset} ${line}`)
const fail = (line) => {
  console.error(`\n${C.red}[FAIL]${C.reset} ${line}`)
  process.exit(1)
}

function findDocker() {
  const candidates = [process.env.DOCKER_BIN, '/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(homedir(), '.orbstack/bin/docker')]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate
  }
  const which = spawnSync('docker', ['--version'], { encoding: 'utf8' })
  return which.status === 0 ? 'docker' : undefined
}

const docker = findDocker()
if (docker === undefined) fail('找不到 docker（可用 DOCKER_BIN 指定）')

const compose = spawnSync(docker, ['compose', 'version'], { encoding: 'utf8' })
if (compose.status !== 0) {
  console.log(`${C.dim}[--] 本机没有 docker compose v2 插件 ⇒ 跳过 compose 配置校验（不是失败）${C.reset}`)
  process.exit(0)
}
info(`docker compose：${compose.stdout.trim()}`)

// 最小可用 env（真实 .env 不进仓库；全部进程环境注入，compose 里 `${VAR:?}` 的必填项都由此满足）
const sharedEnv = {
  // host.yml
  SANDBOX_INSTANCE_ID: 'a',
  SANDBOX_INSTANCE_ADVERTISE_ADDR: 'a:3000',
  BACKEND_IMAGE: 'doubulea-backend:2',
  SHARED_ENV_FILE: join(ROUTER_DIR, '.env.node.shared'),
  WORKSPACE_ROOT: '/var/lib/doubulea/workspaces',
  EGRESS_IMAGE: 'node:22-bookworm-slim',
  EGRESS_DOCKER_BIN: '/usr/bin/docker',
  DOCKER_SOCKET_GID: '0',
  // router.yml
  ROUTER_PORT: '13100',
  ROUTER_UPSTREAMS: 'a:3000,b:3000,c:3000',
  ROUTER_DISCOVERY_SEC: '10',
  SANDBOX_INSTANCE_HEARTBEAT_SEC: '30',
  SANDBOX_OWNER_KEY_PREFIX: 'sandbox:owner',
  BACKEND_PORT: '3000',
  ROUTER_UPSTREAM_TIMEOUT_MS: '30000',
  REDIS_URL: 'redis://redis:6379',
  GATEWAY_IMAGE: 'doubulea-gateway:2',
  // frontend/docker-compose.yml
  FRONTEND_IMAGE: 'doubulea-frontend:2',
  ROUTER_UPSTREAM: 'http://127.0.0.1:13100',
  FRONTEND_PORT: '8080',
  CLIENT_MAX_BODY_MB: '100',
}
const childEnv = { ...process.env, ...sharedEnv }

const files = [
  { file: 'docker-compose.host.yml', title: '每台：backend + egress', dir: ROUTER_DIR },
  { file: 'docker-compose.router.yml', title: '网关：router', dir: ROUTER_DIR },
  { file: 'docker-compose.yml', title: '前端：nginx 静态站点', dir: join(INFRA_DIR, 'frontend') },
]

for (const { file, title, dir } of files) {
  step(`${title}（${file}）`)
  const path = join(dir, file)
  if (!existsSync(path)) fail(`缺文件：${path}`)
  // `-q` 只校验；`--no-interpolate` 保留 `$$(...)` 等运行时语法
  const result = spawnSync(docker, ['compose', '-f', path, 'config', '-q', '--no-interpolate'], {
    encoding: 'utf8',
    env: childEnv,
    cwd: REPO_ROOT,
  })
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    fail(`${file} 配置校验失败`)
  }
  ok(`${file} 通过`)
}

step('Done')
ok('三套 compose 配置均通过校验（镜像实际的运行期校验留给真跑：子方案 §八 6 的 R1~R6）')
