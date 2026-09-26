#!/usr/bin/env node
/**
 * sandbox-build.mjs —— 沙箱镜像的**唯一构建入口**（P0-3-1）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §五（三层镜像 + toolkit 构建期预烘焙）
 *
 * ── 它解决的是什么问题 ────────────────────────────────────────────────
 * 镜像有两个（base / toolkit）、版本值有三个（Node 基线、pi 版本、两条层版本号），
 * 若让 `docker build` 的 `-t`、`--build-arg`、`infra/.env` 的 `SANDBOX_IMAGE*` 各写各的，
 * 必然出现"改一处漏两处"——而症状是**静默**的：构建成功了，运行时起的还是上一版镜像。
 * ⇒ 所有版本值只从 `infra/sandbox/versions.mjs` 读（唯一事实来源，`06` §六 第 4 条同款纪律），
 *   Dockerfile 里刻意**不给**这些 ARG 有意义的默认值：手敲 `docker build` 会在第一道断言上
 *   大声失败，而不是默默烤出一个"参数为空"的镜像。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   pnpm sandbox:build                 构建 base → toolkit，末尾打印要写进 infra/.env 的两行
 *   pnpm sandbox:build -- --no-cache   不用 layer cache（改了 apt 源/想彻底重来时）
 *   pnpm sandbox:build -- --base-only  只构建 base（改 pi 版本时最快的一圈）
 *   pnpm sandbox:build -- --toolkit-only  只重建 toolkit（加了一个 python 库时）
 *   pnpm sandbox:build -- --registry https://registry.npmmirror.com
 *   pnpm sandbox:build -- --dry-run    只打印将要执行的 docker 命令
 *
 * ── 两个本机实况（都不是猜的）─────────────────────────────────────────
 *  ① **`docker` 可能不在非交互 shell 的 PATH 里**（本机是 OrbStack 托管）⇒ 本脚本自己找
 *     可执行文件，并把它所在目录加进子进程 PATH。可用 `DOCKER_BIN=/path/to/docker` 覆写。
 *  ② **光找到 `docker` 还不够**：拉取私有镜像/查凭据时 CLI 会去 PATH 里找
 *     `docker-credential-osxkeychain`。实测（P0-3-1）：只用 `/usr/local/bin/docker` 而 PATH 里
 *     没有 `~/.orbstack/bin` 时，报的是 `error getting credentials - err: exec:
 *     "docker-credential-osxkeychain": executable file not found in $PATH` —— 一个与"构建失败"
 *     毫不相干的报错。⇒ 这里把常见凭据助手目录一并补进子进程 PATH。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_NPM_REGISTRY,
  NODE_IMAGE,
  PI_PACKAGE,
  PI_VERSION,
  baseImageRef,
  toolkitImageRef,
} from '../sandbox/versions.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const INFRA_DIR = resolve(SCRIPT_DIR, '..')
const REPO_ROOT = resolve(INFRA_DIR, '..')
const SANDBOX_DIR = join(INFRA_DIR, 'sandbox')

// ── 参数解析 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const registryIndex = argv.indexOf('--registry')
// registry 优先级：`--registry` > `SANDBOX_NPM_REGISTRY` 环境变量 > `versions.mjs` 的默认值。
// 为什么给一个环境变量：本机（内网）**容器直连 registry.npmjs.org 不通**（见 versions.mjs 的注释），
// 而"每次都记得加 --registry"是靠不住的 —— 环境变量可以直接写在 shell profile 里。
const npmRegistry =
  registryIndex >= 0 ? argv[registryIndex + 1] : (process.env.SANDBOX_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY)

if (flags.has('--help') || flags.has('-h')) {
  console.log(
    '用法: pnpm sandbox:build [-- --no-cache|--base-only|--toolkit-only|--registry <url>|--dry-run]\n' +
      '环境变量: SANDBOX_NPM_REGISTRY=<url>   （等价于 --registry；本机需要换源，见 README）',
  )
  process.exit(0)
}
if (registryIndex >= 0 && (npmRegistry === undefined || npmRegistry.startsWith('--'))) {
  console.error('--registry 后面要跟一个 URL')
  process.exit(2)
}

const noCache = flags.has('--no-cache')
const dryRun = flags.has('--dry-run')
const baseOnly = flags.has('--base-only')
const toolkitOnly = flags.has('--toolkit-only')
if (baseOnly && toolkitOnly) {
  console.error('--base-only 与 --toolkit-only 不能同时给（那就是"都构建"，去掉参数即可）')
  process.exit(2)
}

// ── docker 可执行文件定位（见文件头「两个本机实况」）─────────────────────
function resolveDockerBin() {
  const override = process.env.DOCKER_BIN
  if (override) {
    if (!existsSync(override)) {
      console.error(`DOCKER_BIN 指向的文件不存在：${override}`)
      process.exit(2)
    }
    return override
  }
  const fromPath = spawnSync('docker', ['--version'], { stdio: 'ignore' })
  if (!fromPath.error && fromPath.status === 0) return 'docker'
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    join(homedir(), '.orbstack/bin/docker'),
    '/Applications/OrbStack.app/Contents/MacOS/xbin/docker',
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error(
      '找不到 docker 可执行文件。请启动 Docker Desktop / OrbStack，或用 DOCKER_BIN=/path/to/docker 指定。',
    )
    process.exit(2)
  }
  return found
}

const dockerBin = resolveDockerBin()

/** 子进程 PATH：补上 docker 所在目录与常见凭据助手目录（含 OrbStack 的） */
const childEnv = {
  ...process.env,
  PATH: [dirname(dockerBin), join(homedir(), '.orbstack/bin'), process.env.PATH ?? ''].join(':'),
}

const C = {
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  dim: '\u001b[90m',
  red: '\u001b[31m',
  x: '\u001b[0m',
}
const step = (text) => console.log(`\n${C.cyan}== ${text} ==${C.x}`)
const ok = (text) => console.log(`  ${C.green}[ok]${C.x} ${text}`)
const info = (text) => console.log(`  ${C.dim}${text}${C.x}`)

function run(args, label) {
  console.log(`  ${C.dim}$ ${dockerBin} ${args.join(' ')}${C.x}`)
  if (dryRun) return 0
  const result = spawnSync(dockerBin, args, { stdio: 'inherit', env: childEnv })
  if (result.error) {
    console.error(`${C.red}[fail]${C.x} ${label}：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`${C.red}[fail]${C.x} ${label}（退出码 ${result.status}）`)
    process.exit(result.status ?? 1)
  }
  return 0
}

// ── 0. 前置检查 ──────────────────────────────────────────────────────────
step('Preflight')
const serverVersion = spawnSync(dockerBin, ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
  env: childEnv,
})
if (serverVersion.status !== 0) {
  console.error(`${C.red}[fail]${C.x} Docker engine 不可达。请先启动 Docker Desktop / OrbStack。`)
  console.error(serverVersion.stderr ?? '')
  process.exit(1)
}
ok(`Docker engine 可达（server ${serverVersion.stdout.trim()}）`)
info(`docker：${dockerBin}`)
info(`Node 基线：${NODE_IMAGE} ｜ pi：${PI_PACKAGE}@${PI_VERSION}`)
info(`npm 源：${npmRegistry}`)
if (npmRegistry !== DEFAULT_NPM_REGISTRY) {
  info('（已换源：本机容器直连 registry.npmjs.org 不通，见 versions.mjs 的注释）')
}
info(`base 标签：${baseImageRef()} ｜ toolkit 标签：${toolkitImageRef()}`)

// ── 1. base 层 ───────────────────────────────────────────────────────────
if (!toolkitOnly) {
  step('构建 base 层（Node + pin 版 pi + 桥扩展 + 非 root 用户 + 只读层里的 pi 配置）')
  const args = [
    'build',
    '-f',
    join(SANDBOX_DIR, 'base', 'Dockerfile'),
    '-t',
    baseImageRef(),
    '--build-arg',
    `NODE_IMAGE=${NODE_IMAGE}`,
    '--build-arg',
    `PI_PACKAGE=${PI_PACKAGE}`,
    '--build-arg',
    `PI_VERSION=${PI_VERSION}`,
    '--build-arg',
    `NPM_REGISTRY=${npmRegistry}`,
  ]
  if (noCache) args.push('--no-cache')
  args.push(join(SANDBOX_DIR, 'base'))
  run(args, 'base 层构建')
  ok(`base 层完成 → ${baseImageRef()}`)
} else {
  step('构建 base 层')
  info('已跳过（--toolkit-only）')
}

// ── 2. toolkit 层 ────────────────────────────────────────────────────────
if (!baseOnly) {
  step('构建 toolkit 层（python3 + pandas/numpy/openpyxl + jq/git/ripgrep；末步跑依赖自检）')
  const args = [
    'build',
    '-f',
    join(SANDBOX_DIR, 'toolkit', 'Dockerfile'),
    '-t',
    toolkitImageRef(),
    '--build-arg',
    `BASE_IMAGE=${baseImageRef()}`,
  ]
  if (noCache) args.push('--no-cache')
  args.push(join(SANDBOX_DIR, 'toolkit'))
  run(args, 'toolkit 层构建')
  ok(`toolkit 层完成 → ${toolkitImageRef()}`)
} else {
  step('构建 toolkit 层')
  info('已跳过（--base-only）')
}

// ── 3. 汇总：把"该写进 infra/.env 的两行"直接给出来 ────────────────────
step('Done')
if (!dryRun) {
  const sizes = spawnSync(
    dockerBin,
    ['images', '--format', '{{.Repository}}:{{.Tag}}  {{.Size}}', baseImageRef(), toolkitImageRef()],
    { encoding: 'utf8', env: childEnv },
  )
  if (sizes.status === 0) {
    for (const line of sizes.stdout.trim().split('\n')) {
      if (line.length > 0) info(line)
    }
  }
}
console.log(`
  把下面两行写进 infra/.env（.env 已被 gitignore，模板见 infra/.env.example）：
${C.yellow}    SANDBOX_IMAGE_BASE=${baseImageRef()}${C.x}
${C.yellow}    SANDBOX_IMAGE=${toolkitImageRef()}${C.x}

  ⚠️ SANDBOX_IMAGE 指向的是**最终镜像 = toolkit 层**（子方案③ §五 1）。
  ⚠️ 改了镜像内容就要同时改 infra/sandbox/versions.mjs 里的层版本号并重建
     —— 否则宿主上会同时留着新旧两个 tag，"上次构建的"与"这次跑的"就此分叉。

  手 run 一个能说话的容器（当前 CMD 默认就是 --mode rpc；P0-3-2 起由 dockerode 接管）：
${C.dim}    ${dockerBin} run --rm -i -v doubulea-sandbox-smoke:/work ${toolkitImageRef()} --help${C.x}
  在活容器里重跑依赖自检：
${C.dim}    ${dockerBin} run --rm --entrypoint /opt/sandbox-selfcheck.sh ${toolkitImageRef()}${C.x}
`)

// 明确提醒"还不是可端测里程碑"，免得有人以为这就能派活了（`06` §五 的里程碑说明）。
info('本步只是**镜像预构建**：容器生命周期、两条网络出口、Key 注入分别属 P0-3-2/3/4；')
info('能端测的点仍是 P0-3-11（在此之前派活没有链路可走）。')
console.log(`\n${C.dim}cwd 提示：本脚本与当前工作目录无关（所有路径都从自身位置推导）；仓库根 = ${REPO_ROOT}${C.x}`)
