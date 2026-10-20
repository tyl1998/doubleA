#!/usr/bin/env node
/**
 * frontend-image.mjs —— **前端静态站点镜像（nginx）的唯一构建入口**（P1-14 · R1；2026-10-19 新增）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §八 3（拓扑：nginx 托管 SPA + 反代 /api、/health）。
 *
 * ── 它解决的是什么问题（与 `sandbox-build.mjs` 同一条纪律）──────────────
 * 镜像 tag、`--build-arg`、compose 的 `image:`、`.env` 的 `BACKEND_IMAGE` 若各写各的，
 * 必然出现"改一处漏两处"——症状是**静默**的：构建成功、部署上去跑的还是上一版。
 * ⇒ 版本值只从 `infra/sandbox/versions.mjs` 读（`frontendImageRef()` 是唯一来源）。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   pnpm frontend:build-image                    构建 `doubulea-frontend:<PLATFORM_LAYER_VERSION>`
 *   pnpm frontend:build-image -- --no-cache      不用 layer cache
 *   pnpm frontend:build-image -- --tag my/repo:dev 覆盖 tag
 *   pnpm frontend:build-image -- --dry-run       只打印将要执行的 docker 命令
 *   pnpm frontend:build-image -- --save out.tar  构建后 `docker save`（无 registry 的多机分发：scp + docker load）
 *   pnpm frontend:build-image -- --push         构建后 push（需要已 `docker login`；本脚本不做登录）
 *
 * ⚠️ 三件套：`infra/scripts/router-image.mjs`（后端）/ `gateway-image.mjs`（网关）/ 本脚本（前端静态站点）。
 *
 * ── 为什么"多机必须先构建、再分发"──────────────────────────────────────
 * compose 里写的是 `build:`，但**每台机器各 build 一次**会用各自的源码快照造出**不同**的镜像
 * （同一个 tag、不同的内容）—— 多机部署要求的恰恰是"各台跑同一份代码"。
 * ⇒ 推荐流程：**一台机器上构建三个镜像（backend / gateway / frontend）→ 各自 `--save` → 分发 `docker load`**（或推到私有 registry）。
 *    compose 里的 `build:` 只作为**单机自测**的便利入口。
 *
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLATFORM_LAYER_VERSION, frontendImageRef } from '../sandbox/versions.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const INFRA_DIR = resolve(SCRIPT_DIR, '..')
const REPO_ROOT = resolve(INFRA_DIR, '..')
const DOCKERFILE = join(INFRA_DIR, 'frontend', 'Dockerfile')

// ── 参数 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const noCache = args.includes('--no-cache')
const dryRun = args.includes('--dry-run')
const push = args.includes('--push')
let tag = frontendImageRef()
let savePath
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--tag') tag = args[++index] ?? tag
  else if (arg === '--save') savePath = args[++index]
  else if (arg === '-h' || arg === '--help') {
    console.log(
      '用法: pnpm frontend:build-image [-- --no-cache|--tag <ref>|--save <out.tar>|--push|--dry-run]\n' +
        `  默认 tag：${tag}（= ${frontendImageRef()}，来自 infra/sandbox/versions.mjs）`,
    )
    process.exit(0)
  } else if (!['--no-cache', '--dry-run', '--push'].includes(arg)) {
    console.error(`未知参数：${arg}（--help 看用法）`)
    process.exit(2)
  }
}

const C = { red: '\u001b[31m', green: '\u001b[32m', cyan: '\u001b[36m', dim: '\u001b[90m', reset: '\u001b[0m' }
const step = (title) => console.log(`\n${C.cyan}=== ${title} ===${C.reset}`)
const ok = (line) => console.log(`  ${C.green}[OK]${C.reset} ${line}`)
const info = (line) => console.log(`  ${C.dim}[--]${C.reset} ${line}`)
const fail = (line) => {
  console.error(`\n${C.red}[FAIL]${C.reset} ${line}`)
  process.exit(1)
}

// ── docker 可执行文件（与 `sandbox-build.mjs` 同款：非交互 shell 的 PATH 常缺它）──
function findDocker() {
  const candidates = [process.env.DOCKER_BIN, '/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(homedir(), '.orbstack/bin/docker')]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate
  }
  const which = spawnSync('docker', ['--version'], { encoding: 'utf8' })
  if (which.status === 0) return 'docker'
  return undefined
}

const docker = findDocker()
if (docker === undefined) fail('找不到 docker（OrbStack 下它在 /usr/local/bin/docker；可用 DOCKER_BIN 指定）')
const childEnv = { ...process.env, PATH: `${dirname(docker)}:${join(homedir(), '.orbstack/bin')}:${process.env.PATH ?? ''}` }

function run(argv, label) {
  if (dryRun) {
    console.log(`  ${C.dim}$ ${docker} ${argv.join(' ')}${C.reset}`)
    return ''
  }
  const result = spawnSync(docker, argv, { stdio: 'inherit', env: childEnv, cwd: REPO_ROOT })
  if (result.status !== 0) fail(`${label}（退出码 ${result.status ?? '?'}）`)
  return ''
}

function capture(argv) {
  const result = spawnSync(docker, argv, { encoding: 'utf8', env: childEnv, cwd: REPO_ROOT })
  if (result.status !== 0) return []
  return result.stdout.trim().split('\n').filter((line) => line !== '')
}

// ── 0. 预检 ─────────────────────────────────────────────────────────────
step('Preflight')
info(`docker：${docker}`)
if (!dryRun) {
  const version = spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', env: childEnv })
  if (version.status !== 0) fail('docker daemon 不通（OrbStack 起了吗？）')
  ok(`daemon：${version.stdout.trim()}`)
}
if (!existsSync(DOCKERFILE)) fail(`缺 Dockerfile：${DOCKERFILE}`)
ok(`构建上下文：${REPO_ROOT}`)
ok(`Dockerfile：${DOCKERFILE}`)
if (!existsSync(join(REPO_ROOT, '.dockerignore'))) fail('缺仓库根的 .dockerignore（会把 node_modules / infra/.env 打进上下文）')
ok('已配置 .dockerignore（排除 node_modules / dist / 任何 .env）')

// ── 1. 构建 ─────────────────────────────────────────────────────────────
step(`构建 ${tag}（层版本 v${PLATFORM_LAYER_VERSION}）`)
const buildArgs = ['build', '-f', DOCKERFILE, '-t', tag]
if (noCache) buildArgs.push('--no-cache')
buildArgs.push(REPO_ROOT)
run(buildArgs, '镜像构建')

// ── 2. 分发（可选）──────────────────────────────────────────────────────
if (savePath !== undefined) {
  step(`导出镜像 → ${savePath}`)
  run(['save', '-o', savePath, tag], 'docker save')
  ok(`已导出（分发：scp 到各台 → docker load -i）`)
}
if (push) {
  step(`推送 ${tag}`)
  run(['push', tag], 'docker push')
  ok('已推送（各台 compose 里 `pull_policy: always` 拉同一份）')
}

// ── 3. 汇总 ─────────────────────────────────────────────────────────────
step('Done')
if (!dryRun) {
  for (const line of capture(['images', '--format', '{{.Repository}}:{{.Tag}}  {{.Size}}', tag])) info(line)
}
info(`前端：nginx 托管 ${'frontend/dist'}，/api 与 /health 反代到 ROUTER_UPSTREAM（容器启动时注入）`)
info('运行：docker run -e ROUTER_UPSTREAM=http://<网关>:13000 -p 8080:80 <tag>')
info('部署：infra/frontend/docker-compose.yml（前端 + 上游指向网关）')
